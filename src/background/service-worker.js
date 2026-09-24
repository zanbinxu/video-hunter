/**
 * Video Hunter —— background service worker。
 *
 * 职责边界很清楚：它负责「知道有什么」和「派活」，
 * 不负责重活。解封装、合并、录制这些需要 DOM 或大内存的事情
 * 一律丢给 offscreen document 或独立的扩展页面做。
 *
 * MV3 的一条硬规矩：所有事件监听器必须在模块顶层同步注册。
 * service worker 随时会被杀，恢复靠的是「重新跑一遍这个模块」，
 * 要是注册写在异步回调里，唤醒之后就再也没有监听器了。
 */
import { MSG, KIND, RECORD_STAGE, RECORD_KEY, SETTINGS_KEY, MEDIA_KIND } from '../core/constants.js';
import { getSettings, setSettings } from '../core/settings.js';
import { autoSnapshotIntervalMs, captureCutThresholdBytes } from '../core/capture-limits.js';
import { createMediaIndex } from '../core/media-index.js';
import { guessFileName } from '../core/classify.js';
import * as store from '../core/store.js';
import { initSniffer, getPageInfo } from './sniffer.js';
import { downloadUrl, watchDownloadStart, waitDownloadDone } from './downloader.js';
import { clearRefererForTab, setRefererForTab, resetAllRefererRules } from './netrules.js';
import {
  ensureContentScript, pageFetchText, scanPageVideos, setPageButtons, forgetTab,
  armRecording, registerRecordingHelper, unregisterRecordingHelper,
  registerMseHook, unregisterMseHook,
} from './page-bridge.js';

initSniffer();

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function notify(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {});
}

function openTab(url, { active = true } = {}) {
  return chrome.tabs.create({ url, active });
}

/**
 * 打开「抓流 / 录制管理」页。**已经开着就复用那个标签页。**
 *
 * 复用不是优化，是必须的：抓流结束后会自动跳到管理页，
 * 每抓一次就多开一个标签页，一晚上下来标签栏就没法看了。
 * 复用的时候顺便把 URL 参数更新掉，这样页面标题和分组跟着本次来源走。
 */
async function openRecorderPage({ tabId = '', title = '', focus = '' } = {}) {
  const base = chrome.runtime.getURL('src/recorder/recorder.html');
  const url = `${base}?${new URLSearchParams({
    tabId: String(tabId ?? ''),
    title: title || '',
    focus: focus || '',
  }).toString()}`;
  try {
    const tabs = await chrome.tabs.query({ url: `${base}*` });
    const existing = (tabs || []).find((t) => Number.isInteger(t.id));
    if (existing) {
      await chrome.tabs.update(existing.id, { url, active: true });
      return { ok: true, reused: true, tabId: existing.id };
    }
  } catch (err) {
    // 查不到就当没开着 —— 大不了多开一个标签页，不该因此让整件事失败
    console.info('[vh/sw] 查找已打开的管理页失败，直接开新的：', err?.message || err);
  }
  const tab = await openTab(url);
  return { ok: true, reused: false, tabId: tab?.id ?? null };
}

/** 顺手取一下标签页标题，管理页用它当副标题 */
async function tabTitleOf(tabId) {
  if (!Number.isInteger(tabId)) return '';
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.title || '';
  } catch {
    return '';
  }
}

/** 从 Content-Disposition 或 URL 推出一个像样的文件名 */
function fileNameFor(entry) {
  const cd = entry.contentDisposition || '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  if (m && m[1]) {
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  const fallbackExt = entry.kind === KIND.AUDIO ? (entry.ext || 'm4a') : (entry.ext || 'mp4');
  return guessFileName(entry.url, entry.kind, fallbackExt);
}

/** 播放列表类的条目要送进解析器页，而不是直接下载 */
function needsParser(entry) {
  return entry.kind === KIND.HLS || entry.kind === KIND.DASH;
}

function parserUrlFor(entry) {
  const params = new URLSearchParams({
    url: entry.url,
    referer: entry.referer || entry.pageUrl || '',
    pageUrl: entry.pageUrl || '',
    title: entry.pageTitle || '',
    kind: entry.kind,
    // 带上来源标签页：解析器页直连抓不到时，可以借这个页面的上下文重试
    // （第一级抓取策略）。不带的话那条兜底路线就是死代码。
    sourceTabId: entry.tabId != null ? String(entry.tabId) : '',
  });
  return chrome.runtime.getURL(`src/parser/parser.html?${params.toString()}`);
}

/* ------------------------------------------------------------------ *
 * 业务动作
 * ------------------------------------------------------------------ */

async function startDownload({ tabId, id }) {
  const entry = await store.get(tabId, id);
  if (!entry) return { ok: false, error: '条目已失效，刷新面板重试' };

  if (needsParser(entry)) {
    await openTab(parserUrlFor(entry));
    return { ok: true, action: 'opened-parser' };
  }

  const settings = await getSettings();
  const filename = fileNameFor(entry);
  const res = await downloadUrl({
    url: entry.url,
    filename,
    subdir: settings.downloadSubdir,
  });
  if (!res.ok) return res;

  // 宽限期内如果被打断，多半是缺 Referer / 需要登录态 —— 如实报给用户，
  // 而不是假装下载成功了。
  watchDownloadStart(res.downloadId).then((r) => {
    if (!r.ok) {
      notify({
        type: 'vh:download-failed',
        tabId,
        id,
        error: r.error,
        hint: entry.referer
          ? '这个资源可能校验 Referer，试试用「解析/抓取」方式下载'
          : '下载被中断，可能需要在页面登录后再试',
      });
    }
  });

  return { ok: true, action: 'downloading', path: res.path, downloadId: res.downloadId };
}

/** 把页面里扫到的 <video> 合成成「页面视频」条目返回给面板 */
async function collectPageVideos(tabId) {
  const scan = await scanPageVideos(tabId);
  if (!scan?.ok) return [];
  const page = getPageInfo(tabId);
  return (scan.videos || [])
    .filter((v) => v.visible || v.sources.length)
    .map((v) => ({
      id: `page:${tabId}:${v.index}`,
      synthetic: true,
      url: v.sources[0] || '',
      tabId,
      kind: v.hasBlob ? KIND.SEGMENT : KIND.FILE,
      ext: '',
      container: null,
      mime: '',
      confidence: 'medium',
      isPlaylist: false,
      isSegment: !!v.hasBlob,
      isAudioOnly: false,
      downloadable: !v.hasBlob,
      reason: v.hasBlob ? '页面用 MSE(blob:) 播放，真实地址拿不到' : '页面 <video> 直接引用的地址',
      size: null,
      statusCode: null,
      contentDisposition: '',
      acceptRanges: '',
      referer: page.url || '',
      origin: '',
      initiator: '',
      requestType: 'media',
      pageUrl: page.url || '',
      pageTitle: page.title || v.pageTitle || '',
      seenAt: Date.now(),
      video: {
        sources: v.sources,
        isMse: v.isMse,
        hasBlob: v.hasBlob,
        poster: v.poster,
        duration: v.duration,
        width: v.width,
        height: v.height,
        // 播放位置：「从当前进度开始抓流」要用它（见 popup 的 currentPlaybackSeconds）
        currentTime: v.currentTime,
      },
    }));
}

/* ------------------------------------------------------------------ *
 * 录制编排
 *
 * 分工：service worker 只负责「拿采集源 + 管离屏文档 + 记状态」，
 * 真正吃 CPU 的编码在离屏文档里做。
 *
 * 一个关键顺序：**必须先 getMediaStreamId，再开任何新标签页**。
 * tabCapture 要求被采集的标签页处于活动状态，而我们自己的页面一打开
 * 就会把它顶掉。所以录制只能从扩展面板（popup）发起 —— 那时目标标签页
 * 还是活动的。
 * ------------------------------------------------------------------ */

function updateBadge(state) {
  const stage = state?.stage;
  const text = stage === RECORD_STAGE.RECORDING ? 'REC' : (stage === RECORD_STAGE.READY ? '✓' : '');
  const color = stage === RECORD_STAGE.RECORDING ? '#f87171' : '#34d399';
  try {
    // 这几个 API 返回 promise，画不出来不是什么大事，但不该变成未捕获拒绝
    Promise.resolve(chrome.action.setBadgeText({ text })).catch(() => {});
    if (text) Promise.resolve(chrome.action.setBadgeBackgroundColor({ color })).catch(() => {});
  } catch { /* 某些上下文里没有 action，忽略 */ }
}

/**
 * 录制/抓流的状态。
 *
 * **不在这里做内存缓存。** 踩过的坑：原来有一份模块级 `recordingCache`，
 * 只有在 `setRecording` 里才更新。于是一个绕过它写进 storage 的状态就永远读不到
 * —— 而 service worker 随时可能被系统杀掉重启、缓存跟着清空，
 * "谁是最新的"这件事就变得不可推理了。
 *
 * `chrome.storage.session` 本来就是内存存储（不落盘），每秒读一次的开销可以忽略，
 * 换来的是**单一数据源**：读到的和写进去的永远是同一份。
 */
async function setRecording(state) {
  updateBadge(state);
  try { await chrome.storage.session.set({ [RECORD_KEY]: state }); } catch { /* ignore */ }
}

async function getRecording() {
  try {
    const got = await chrome.storage.session.get(RECORD_KEY);
    return got?.[RECORD_KEY] || null;
  } catch {
    return null;
  }
}

/**
 * 只改几个字段，其余以**最新**状态为准，然后把新状态推给界面。
 *
 * 为什么需要它（不是洁癖，是踩过的坑）：收尾那条路上会连着写好几次状态，
 * 而每次用来拼下一个状态的 `cur` 都是函数开头读的**快照**。一旦中途别的地方
 * 往里写了新字段（典型的就是"自动导出的结果"—— 它要等下载器写完，耗时以秒计），
 * 后面那次用旧快照的写入就会把它悄悄抹掉，用户永远看不到。
 *
 * @param {object} patch 要覆盖的字段
 * @returns {Promise<object>} 写进去的完整状态
 */
async function patchRecording(patch) {
  const cur = (await getRecording()) || {};
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  await setRecording(next);
  notify({ type: MSG.RECORD_STATE_PUSH, state: next });
  return next;
}

async function closeOffscreen() {
  try {
    const has = await chrome.offscreen.hasDocument();
    if (has) await chrome.offscreen.closeDocument();
  } catch (err) {
    console.warn('[vh/sw] 关闭离屏文档失败：', err);
  }
}

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('src/offscreen/offscreen.html'),
    reasons: ['USER_MEDIA', 'BLOBS'],
    justification: '在离屏文档中接收标签页音视频流并编码封装为 MP4。离屏文档不占标签页焦点，因此不会破坏 tabCapture 对「目标标签页必须处于活动状态」的要求。',
  });
}

async function startRecording({ tabId, options }) {
  const cur = await getRecording();
  if (cur?.stage === RECORD_STAGE.RECORDING) {
    return { ok: false, error: '已经在录制中，先停止当前录制' };
  }
  if (!Number.isInteger(tabId)) return { ok: false, error: '缺少 tabId' };

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    return {
      ok: false,
      error: `拿不到标签页采集源：${err?.message || err}。`
        + 'tabCapture 要求目标标签页当前是活动标签页，并且录制要从扩展面板发起（点工具栏图标），不能在别的页面上点。',
    };
  }
  if (!streamId) return { ok: false, error: '拿到的采集源 ID 是空的' };

  try {
    await ensureOffscreen();
  } catch (err) {
    return { ok: false, error: `创建离屏文档失败：${err?.message || err}` };
  }

  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: MSG.OFFSCREEN_START,
      streamId,
      tabId,
      videoBitrate: options?.videoBitrate ?? 4000000,
      frameRate: options?.frameRate ?? 30,
      audioBitrate: options?.audioBitrate ?? 128000,
      monitorAudio: options?.monitorAudio !== false,
    });
  } catch (err) {
    // 「离屏文档存在」不等于「有人在听」—— 它自己的模块加载也可能失败
    // （例如 vendor 里某个文件缺失）。这时必须主动清理，否则会留下一个
    // 没人关的离屏文档，而且录制状态卡在原地不动。
    await closeOffscreen();
    const message = `离屏文档没有响应：${err?.message || err}`;
    await setRecording({ stage: RECORD_STAGE.ERROR, tabId, error: message, updatedAt: Date.now() });
    return { ok: false, error: message };
  }

  if (!res?.ok) {
    await closeOffscreen();
    await setRecording({ stage: RECORD_STAGE.ERROR, tabId, error: res?.error || '采集启动失败', updatedAt: Date.now() });
    return { ok: false, error: res?.error || '采集启动失败' };
  }

  await setRecording({
    stage: RECORD_STAGE.RECORDING,
    tabId,
    startedAt: Date.now(),
    fileName: res.fileName,
    info: {
      videoCodec: res.videoCodec,
      videoFallback: res.videoFallback,
      audioCodec: res.audioCodec,
      width: res.width,
      height: res.height,
      targetKind: res.targetKind,
    },
    stats: null,
    error: null,
    updatedAt: Date.now(),
  });

  // 让页面进入「录制待命」：回到第一帧、开播、播完自动停。
  //
  // 顺序很关键：**先注册针对该站点的持久内容脚本，再让用户刷新页面**。
  // 平时内容脚本是按需注入的，一刷新就没了 —— 而录制兜底恰恰要求刷新
  // （视频得从头播）。不先注册的话，刷新之后没人去把播放位置归零，
  // 也没人盯着播放结束，用户就会遇到"刷新了但还是从一半开始播"。
  try {
    const tab = await chrome.tabs.get(tabId);
    const reg = await registerRecordingHelper(tab?.url || '');
    if (!reg.ok) console.info('[vh/sw] 注册录制助手失败：', reg.error);
    // 顺带把当前这一份也唤醒，万一用户不刷新也能从头录
    await armRecording(tabId);
  } catch (err) {
    console.info('[vh/sw] 录制待命设置失败（不影响录制本身）：', err);
  }

  return res;
}

/**
 * 正在进行的收尾。
 *
 * 为什么需要它：收尾不是瞬间的（要 flush 编码器、封 muxer、写 OPFS，大文件要好几秒）。
 * 这段时间里状态是 FINALIZING，而用户看到面板上还写着「录制中」，很自然会再点一次
 * 「停止并保存」—— 第二次进来时 `stage !== RECORDING`，原来的代码就回一句
 * 「当前没有在录制」。
 *
 * 对一个刚点了"保存"的用户来说这句话是纯灾难：他以为白录了，而其实第一次点击
 * 正在把文件写完。所以第二次点击必须**复用第一次的收尾**，拿到同一个结果。
 */
let stopInFlight = null;

async function stopRecording() {
  if (stopInFlight) return stopInFlight;

  const cur = await getRecording();
  if (cur?.stage !== RECORD_STAGE.RECORDING) {
    // 已经收完尾了 —— 这不是错误。文件就在管理页里，直接把他送过去。
    if (cur?.stage === RECORD_STAGE.READY && cur.fileName) {
      await openRecorderPage({ tabId: cur.tabId, title: cur.title || '', focus: 'record' }).catch(() => {});
      return { ok: true, action: 'already-finalized', state: cur };
    }
    // 卡在收尾中（比如收尾途中 service worker 被系统杀了，in-flight 的 promise 跟着没了）。
    // 也不该报"没有在录制"：把实情说出来，并让用户去管理页看已经存下的东西。
    if (cur?.stage === RECORD_STAGE.FINALIZING) {
      await openRecorderPage({ tabId: cur.tabId, title: cur.title || '', focus: 'record' }).catch(() => {});
      return { ok: true, action: 'finalizing', state: cur };
    }
    return { ok: false, error: '当前没有在录制' };
  }

  stopInFlight = runStopRecording(cur);
  try {
    return await stopInFlight;
  } finally {
    stopInFlight = null;
  }
}

async function runStopRecording(cur) {
  await setRecording({ ...cur, stage: RECORD_STAGE.FINALIZING, updatedAt: Date.now() });

  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_STOP });
  } catch (err) {
    // 不能裸 await：异常会越过下面的清理分支，把状态永久留在 FINALIZING。
    // 录制台页看到 FINALIZING 就会一直禁用「开始录制」，用户只能重启浏览器。
    res = { ok: false, error: `离屏文档没有响应：${err?.message || err}` };
  }
  await closeOffscreen();
  await unregisterRecordingHelper();

  if (!res?.ok) {
    // 「没有正在进行的录制」通常意味着离屏文档已经自己收尾了：视频轨 ended
    // （用户关了标签页 / 播放到头）会触发自动收尾。那种情况下文件其实完整
    // 躺在 OPFS 里，把它标成 ERROR 会让用户以为录制失败了。
    const alreadyDone = /没有正在进行的录制/.test(res?.error || '');
    const next = alreadyDone
      ? { ...cur, stage: RECORD_STAGE.READY, error: null, finishedAt: Date.now(), updatedAt: Date.now() }
      : { ...cur, stage: RECORD_STAGE.ERROR, error: res?.error || '离屏文档没有响应', updatedAt: Date.now() };
    await setRecording(next);
    notify({ type: MSG.RECORD_STATE_PUSH, state: next });
    return alreadyDone ? { ok: true, action: 'already-finalized', state: next } : res;
  }

  const done = {
    stage: RECORD_STAGE.READY,
    tabId: cur.tabId,
    startedAt: cur.startedAt,
    finishedAt: Date.now(),
    fileName: res.fileName,
    size: res.size,
    durationMs: res.durationMs,
    frames: res.frames,
    dropped: res.dropped,
    // 采集停摆被压掉的毫秒数：界面要拿它解释"为什么产物比录制时长短"
    stalledMs: res.stalledMs || 0,
    stallCount: res.stallCount || 0,
    // **真实视频时长**。挂钟的 durationMs 只用来解释"你花了多久"。
    mediaSeconds: res.mediaSeconds ?? null,
    info: cur.info,
    error: null,
    updatedAt: Date.now(),
  };
  // 录制产物的索引也在这儿写（离屏文档没有 chrome.storage）
  await rememberProduct({
    name: done.fileName,
    kind: MEDIA_KIND.RECORD,
    seconds: done.mediaSeconds,
    size: done.size,
  });
  await setRecording(done);
  notify({ type: MSG.RECORD_STATE_PUSH, state: done });
  return { ...res, state: done };
}

async function onOffscreenState(msg) {
  const cur = (await getRecording()) || {};

  // ⚠️ 已经收摊（READY / ERROR）之后，离屏文档那**一秒一次的心跳**可能还在路上。
  // 它会带着 `stage: RECORDING` 和 `error: null` 晚一步到达，把界面从
  // 「收尾失败」刷回「正在录制」，错误信息也被清掉 —— 用户看到的就是
  // "明明报错了，一秒后又变成在录制，而且再也停不下来"。
  // 所以终态之后只接受同样也是终态的消息。
  const terminal = cur.stage === RECORD_STAGE.READY || cur.stage === RECORD_STAGE.ERROR;
  if (terminal && msg.stage !== RECORD_STAGE.READY && msg.stage !== RECORD_STAGE.ERROR) return;

  const next = {
    ...cur,
    stage: msg.stage || cur.stage,
    tabId: msg.tabId ?? cur.tabId ?? null,
    startedAt: msg.startedAt ?? cur.startedAt ?? null,
    fileName: msg.fileName ?? cur.fileName ?? null,
    stats: msg.stats ?? cur.stats ?? null,
    // 收尾期间的进度（比如"音频转码 40%"）：长音频要几十秒，
    // 没有它那段"正在收尾"就像卡死了，用户会去点第二次停止。
    progress: msg.progress ?? cur.progress ?? null,
    // 滚动保存的自动快照（每 N 分钟一份，只留最新）与"自动保存失败"的提示。
    // 这两件事都发生在抓流**进行中**，界面得能看见，用户才知道"现在有救了"。
    autoSnapshot: msg.autoSnapshot ?? cur.autoSnapshot ?? null,
    // 抓流进行中的一句话（快到自动切段阈值 / 刚切了一段）—— 必须存下来：
    // 用户的一个视频变成了两个文件，他有权在发生的那一刻就知道。
    captureNotice: msg.captureNotice ?? cur.captureNotice ?? null,
    warning: msg.warning ?? null,
    // 离屏文档自动收尾时会把结果直接摊在消息里，这些字段要一起收下，
    // 否则录制完成后面板上会缺体积和时长。
    size: msg.size ?? cur.size ?? null,
    durationMs: msg.durationMs ?? cur.durationMs ?? null,
    frames: msg.frames ?? cur.frames ?? null,
    dropped: msg.dropped ?? cur.dropped ?? null,
    stalledMs: msg.stalledMs ?? cur.stalledMs ?? null,
    stallCount: msg.stallCount ?? cur.stallCount ?? null,
    mediaSeconds: msg.mediaSeconds ?? cur.mediaSeconds ?? null,
    error: msg.error ?? null,
    updatedAt: Date.now(),
  };
  await setRecording(next);
  notify({ type: MSG.RECORD_STATE_PUSH, state: next });

  // ⚠️ 「攒太大自动切一段」那条路也会把导出句柄推过来：那一步是**离屏文档自己
  // 发起的**（体积到阈值是它每秒在算），没有"请求-响应"这条路可借，所以句柄
  // 跟着状态一起送过来 —— **这里必须接**。不接的后果不是报错，而是"什么都没发生"：
  // 切出来的那一段永远不会落到下载目录，界面上也看不出任何区别（这条漏过很久）。
  // 顺序也要紧：放在关离屏文档之前 await，blob 就活在那个文档里。
  if (msg.autoExport) await autoExportProduct(msg.autoExport);

  // 采集结束后离屏文档就没用了，关掉省资源。
  // ⚠️ 用 idle 版：自动导出的 blob 就活在这个文档里，**下载没写完不能关**
  // （关早 = blob 失效 = 导出的文件断在半路）。
  if (msg.stage === RECORD_STAGE.READY || msg.stage === RECORD_STAGE.ERROR) {
    setTimeout(() => { closeOffscreenWhenIdle(); }, 1200);
    // 录制助手也只在该录的时候存在，结束就注销，别留在用户页面上
    unregisterRecordingHelper();
  }
}

/* ------------------------------------------------------------------ *
 * MSE 抓流
 *
 * 和 tabCapture 录制是两件完全不同的事：
 *   录制   = 抓标签页渲染出来的画面（屏幕像素）→ 重新编码
 *   抓流   = 钩住播放器的 appendBuffer，拿它**已经解密好的**原始码流 → 直接重封装
 *
 * 抓流的收益：不重新编码（无损）、没有网页水印和浏览器 UI、原始画质，
 * 而且顺带绕过"自己去猜密钥"——播放器已经解好了。
 * ------------------------------------------------------------------ */

async function startMseCapture({ tabId, startAt = 0 }) {
  if (!Number.isInteger(tabId)) return { ok: false, error: '缺少 tabId' };

  // 0. 这个标签页到底能不能注入？**分开说清原因**。
  //
  // 原来只有一句"页面受限（chrome:// 和扩展商店页面不行）"，而实际最常见的
  // 其实是**页面根本没加载成功**（站点挂了、断网、Chrome 停在错误页上）。
  // 那句话会把人往错的方向带：用户以为扩展坏了，其实是页面是空的。
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = String(tab?.url || '');
    if (!/^https?:\/\//i.test(url)) {
      const why = url && /^chrome-error:/i.test(url)
        ? '这个页面没有加载成功（Chrome 停在错误页上）'
        : url ? `这个页面的地址是 ${url}` : '这个标签页现在是空的';
      return {
        ok: false,
        error: `${why}，抓流做不了。抓流要在**真的能播放的普通网页**上发起：`
          + '先把页面刷新到能正常播放，再点「抓流」。'
          + '（chrome:// 页面、扩展商店、PDF 阅读器也都不行。）',
      };
    }
  } catch {
    return { ok: false, error: '找不到这个标签页了（可能已经关掉）' };
  }

  // 1. 隔离世界的内容脚本（负责编码成 base64 转交）
  const ok = await ensureContentScript(tabId);
  if (!ok) return { ok: false, error: '页面受限，注入不了内容脚本（chrome:// 和扩展商店页面不行）' };

  // 2. 主世界的钩子 —— 必须注入到主世界，否则钩不到页面自己的 SourceBuffer。
  //    同时注册成持久脚本：用户可能会刷新页面从头播，一次性注入刷完就没了。
  try {
    const tab = await chrome.tabs.get(tabId);
    const reg = await registerMseHook(tab?.url || '');
    if (!reg.ok) console.info('[vh/sw] 注册 MSE 钩子（持久）失败，退回一次性注入：', reg.error);
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      files: ['src/content/mse-hook.js'],
    });
  } catch (err) {
    return { ok: false, error: `注入 MSE 钩子失败：${err?.message || err}` };
  }

  // 3. 打开转交开关
  //
  // `startAt` = 用户点「抓流」时视频播到的那一秒（0 = 从头）。
  // 内容脚本的起播看护要用它：刷新之后站点可能从头播，也可能续播到别处，
  // 看护负责把位置看住在这一秒上。
  startAt = Math.max(0, Number(startAt) || 0);
  try {
    await chrome.tabs.sendMessage(tabId, { type: MSG.MSE_ARM, enabled: true, startAt });
  } catch (err) {
    return { ok: false, error: `内容脚本没有响应：${err?.message || err}` };
  }

  // 4. 离屏文档负责收数据、组装、落盘
  try {
    await ensureOffscreen();
  } catch (err) {
    return { ok: false, error: `创建离屏文档失败：${err?.message || err}` };
  }
  // 标题现在就取：抓流结束后管理页要显示「这个文件是从哪个页面抓的」，
  // 而那时候用户可能已经切走甚至关掉那个标签页了，到时再查就查不到。
  // 顺带交给离屏文档一份 —— 产物文件名会带上它（见 pipeline 的 titlePart）。
  const title = await tabTitleOf(tabId);
  // 自动保存的配置也一起传：**离屏文档里没有 chrome.storage**（实测只有
  // chrome.runtime），它自己读不了设置。见 offscreen.js 里 indexRemember 的注释。
  const res = await chrome.runtime.sendMessage({
    type: MSG.OFFSCREEN_MSE_START,
    title,
    autoSnapshot: await autoSnapshotConfig(),
    autoCut: await autoCutConfig(),
    autoExport: await autoExportConfig(),
  });
  if (!res?.ok) {
    // ⚠️ 「已经在抓流」**绝不能关离屏文档** —— 那等于把正在进行的这次抓流连同
    // 缓冲一起销毁。而用户最常踩的就是这个：播放列表一集播完、自动存好之后，
    // 他以为要"重新开始抓流"，于是又点一次「抓流」—— 结果是**正在抓的第二集没了**，
    // 只看到一句"已经在抓流中"。（用户描述的工作流就是"到第二段重新开始抓流"。）
    if (res?.alreadyCapturing) {
      return {
        ok: false,
        alreadyCapturing: true,
        error: res.error || '抓流还在进行中，不用再点一次',
      };
    }
    // 上次收尾失败（空间不够）时数据还在离屏文档里，**这时候也不能关掉它** ——
    // 关掉就等于把用户攒了半天的东西扔掉。
    if (!res?.awaitingRetry) await closeOffscreen();
    return { ok: false, error: res?.error || '离屏文档没有进入抓流状态' };
  }

  await setRecording({
    stage: RECORD_STAGE.RECORDING,
    mode: 'mse',
    tabId,
    title,
    // 从第几秒开始抓的。页面刷新之后内容脚本会回来问"现在在抓吗"，
    // 那时候要把这一秒一起带回去（见 PAGE_READY），否则看护会把位置扳回 0。
    startAt,
    startedAt: Date.now(),
    fileName: null,
    stats: null,
    error: null,
    retryable: false,
    updatedAt: Date.now(),
  });

  return { ok: true, mode: 'mse', startAt };
}

/**
 * 抓流期间的"换集"处理：把当前这段收尾成一个完整文件，然后接着抓下一个。
 *
 * 为什么需要它：播放列表和自动连播会把好几个视频连着放。不切开的话，抓到的
 * 是一条连续时间轴，合并出来是**一个**装着好几集的文件，用户没法一集一存。
 *
 * 三个信号（`ended` / `emptied` / 新的 `addSourceBuffer`）经常在几秒内一起出现，
 * 所以这里必须去重：**一次换集只切一次**。
 */
let lastCutAt = 0;
const CUT_DEBOUNCE_MS = 4000;

/* ------------------------------------------------------------------ *
 * 产物索引的写入（从离屏文档转发过来）
 *
 * 离屏文档里**没有 chrome.storage**（Chrome 153 实测：只有 chrome.runtime），
 * 所以它写不了索引。原来它直接调 mediaIndex，调用不报错、索引却一条都没写进去 ——
 * 表现是管理页的时长一直靠回退去读文件头，读不出头的格式（WebM）就永远是
 * "时长未记录"。索引写在这里（service worker 有 storage）。
 *
 * 索引只是缓存：写失败不影响产物，所以这里不往上抛任何错。
 * ------------------------------------------------------------------ */

const mediaIndex = createMediaIndex();

async function rememberProduct(entry) {
  if (!entry?.name) return null;
  try {
    return await mediaIndex.remember(entry);
  } catch (err) {
    console.info('[vh/sw] 记索引失败（不影响产物）：', err?.message || err);
    return null;
  }
}

async function forgetProduct(name) {
  if (!name) return false;
  try {
    return await mediaIndex.forget(name);
  } catch (err) {
    console.info('[vh/sw] 删索引失败（不影响产物）：', err?.message || err);
    return false;
  }
}

/**
 * 补一个字段（比如"已导出"）。
 *
 * 为什么不能塞给 rememberProduct：它走的是 `mediaIndex.remember()`，而那个只认
 * name/kind/seconds/size —— 多传的字段会被**静默丢掉**。自动导出第一版就是这么干的：
 * 文件确实落到了下载目录，索引里却没有"已导出"，于是「清理已导出的」不敢清它。
 */
async function patchProduct(name, patch) {
  if (!name) return null;
  try {
    return await mediaIndex.patch(name, patch);
  } catch (err) {
    console.info('[vh/sw] 补索引失败（不影响产物）：', err?.message || err);
    return null;
  }
}

/** 自动保存的配置（离屏文档读不了设置，由这里读好传过去） */
async function autoSnapshotConfig() {
  try {
    const settings = await getSettings();
    return {
      enabled: settings.autoSnapshotCapture !== false,
      intervalMs: autoSnapshotIntervalMs(settings.autoSnapshotMinutes),
      // 「每 N 分钟」按**挂钟**还是按**视频内容时长**算（用户提的：倍速播放时两者差好几倍）
      basis: settings.autoSnapshotBasis === 'media' ? 'media' : 'wall',
    };
  } catch {
    return { enabled: true, intervalMs: autoSnapshotIntervalMs(10), basis: 'wall' };
  }
}

/**
 * 「抓流产物自动导出到下载目录」的配置。
 *
 * 用户的请求：产物进了「抓流文件」之后自动落一份到本地，**同时保留**
 * 私有存储里那份和「保存到磁盘」按钮（本地误删了还能再导一次）。
 */
async function autoExportConfig() {
  try {
    const settings = await getSettings();
    return {
      enabled: settings.autoExportCapture === true,
      subdir: settings.downloadSubdir || '',
    };
  } catch {
    return { enabled: false, subdir: '' };
  }
}

/**
 * 「攒得太大自动切段」的配置。
 *
 * 为什么要做这件事：抓流先把码流全收在内存里、收尾才合成一整块，实测抓到
 * ~1 GB 之后合并基本必定失败（而那时数据只能丢掉）。默认开：到阈值就写出一段
 * 完整文件、清空缓冲继续抓 —— 一个视频变两个文件，总比两小时全丢好。
 */
async function autoCutConfig() {
  const fallbackMb = 600;
  try {
    const settings = await getSettings();
    return {
      enabled: settings.autoCutCapture !== false,
      thresholdBytes: captureCutThresholdBytes(settings.autoCutMb ?? fallbackMb),
    };
  } catch {
    return { enabled: true, thresholdBytes: captureCutThresholdBytes(fallbackMb) };
  }
}

/**
 * 用户在管理页/面板改了自动保存的间隔或开关 —— 抓流还开着的话立刻生效。
 *
 * 监听 `chrome.storage.onChanged` 而不是让界面多发一条消息：
 * 两个入口（面板、管理页）改的是同一个值，将来再加第三个入口也不用改代码。
 */
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  const cur = await getRecording().catch(() => null);
  if (cur?.stage !== RECORD_STAGE.RECORDING || cur.mode !== 'mse') return;
  try {
    // 一次把两类配置都推过去：自动保存（开关/间隔/口径）和自动导出（开/关/目录）。
    // 用户在抓流进行中改设置，希望**立刻**生效，而不是等下一段。
    await chrome.runtime.sendMessage({
      type: MSG.OFFSCREEN_MSE_AUTOSNAP,
      ...(await autoSnapshotConfig()),
      autoExport: await autoExportConfig(),
    });
  } catch { /* 离屏文档可能正好没了，不影响 */ }
});

async function cutMseCapture(reason) {
  const cur = await getRecording();
  if (cur?.stage !== RECORD_STAGE.RECORDING || cur.mode !== 'mse') {
    return { ok: false, error: '当前没有在抓流' };
  }

  // 「自动保存」关掉的人：边界照样识别，但不落盘。
  // 代价要说清楚 —— 换集时不收尾，下一段的样本会攒进同一个缓冲；收尾合并时按
  // 「时间轴重新从头开始」把新的一段**整段切掉**（产物仍是干净的第一集，两集不会焊在一起），
  // 但**那一段时间他一个文件都没拿到**，第二集得重新抓。所以照样得提醒他手动点一次。
  const settings = await getSettings();
  if (settings.autoSaveCapture === false) {
    notify({
      type: MSG.RECORD_STATE_PUSH,
      state: { ...cur, lastBoundary: { at: Date.now(), reason: reason || '' } },
    });
    return { ok: true, action: 'auto-save-off' };
  }

  const now = Date.now();
  if (now - lastCutAt < CUT_DEBOUNCE_MS) {
    return { ok: false, error: '刚切过，忽略这次的重复信号', debounced: true };
  }

  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_MSE_CUT, reason });
  } catch (err) {
    return { ok: false, error: `离屏文档没有响应：${err?.message || err}` };
  }
  // 数据还不够多时离屏文档会拒绝（`skipped`）—— 那是正常的，
  // 比如第二个 SourceBuffer 建起来时还没抓到任何东西。
  if (!res?.ok) return res;

  // 换集切出来的是一份**完整视频** —— 开了自动导出就落一份到下载目录
  // （blob 句柄由离屏文档保持，所以这里 await，别让文档提前关）
  // 走统一入口：导出 + 把成功/失败写进状态，界面才看得见（见 autoExportProduct）
  await autoExportProduct(res.autoExport);

  // ⚠️ 只有**真的切成功了**才启动静默窗口。
  // 反过来的写法踩过：先把 lastCutAt 记下来再切，结果一次失败（曾经是
  // `Maximum call stack size exceeded`）就把窗口吃掉，后面几秒的重复信号
  // 全被忽略 —— 用户看到的是"明明换了视频却什么都没存"。
  lastCutAt = now;

  await patchRecording({
    parts: res.part,
    lastCut: { fileName: res.fileName, mediaSeconds: res.mediaSeconds, part: res.part, at: now },
  });
  // 索引统一在这里写（离屏文档没有 chrome.storage）
  await rememberProduct({
    name: res.fileName,
    kind: MEDIA_KIND.CAPTURE,
    seconds: res.mediaSeconds,
    size: res.size,
  });
  // 刚切完缓冲是空的，此时的心跳还停在上一次的段数上 —— 记下来，
  // 空闲判断要用（见 maybeFinishIdleCapture）
  idleBaseline = { chunks: 0, since: now };
  return res;
}
/**
 * 换集之后如果一直没再抓到新数据，就自动收尾。
 *
 * 场景：一集播完、下一集要等广告，或者用户看完直接把页面关了。这时候抓流还"开着"，
 * 界面上会一直显示"抓流中"，用户不知道要不要再点一次停止。
 * 已经切出来的文件是安全的（那一步先完成），所以这里只是把会话干净地结束掉。
 */
let idleTimer = null;
let idleBaseline = null;
const IDLE_FINISH_MS = 60000;

function scheduleIdleFinish() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const cur = await getRecording();
    if (cur?.stage !== RECORD_STAGE.RECORDING || cur.mode !== 'mse') return;
    if (!cur.parts) return; // 一段都没切过就别自作主张
    let chunks = null;
    try {
      const st = await chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_STATUS });
      chunks = st?.stats?.chunks ?? null;
    } catch { /* 离屏文档一时没响应 */ }

    // ⚠️ 拿不到段数时**不能**当成"没有新数据"。这一条踩过：
    // 上一轮会话留下的定时器在新一轮抓流期间醒来，恰逢离屏文档一时没响应，
    // 于是把用户正在进行的抓流给结束了。只有在**确认段数没涨**时才收尾。
    if (chunks === null) {
      scheduleIdleFinish();
      return;
    }
    if (idleBaseline && chunks <= idleBaseline.chunks && Date.now() - idleBaseline.since > IDLE_FINISH_MS) {
      console.info('[vh/sw] 换集之后一直没有新数据，自动收尾抓流');
      await stopMseCapture({ auto: true });
      return;
    }
    scheduleIdleFinish();
  }, IDLE_FINISH_MS);
}

/**
 * 抓流产物**自动导出到下载目录**（用户提的：产物进了「抓流文件」之后，
 * 自动落一份到本地，同时**保留**私有存储里那份和「保存到磁盘」按钮 ——
 * 本地误删了还能再导一次）。
 *
 * ## 两件必须做对的事
 *
 * 1. **blob URL 属于创建它的上下文**。这里拿到的 URL 是离屏文档建的，
 *    所以下载没结束之前**绝不能关离屏文档**（关掉 = blob 失效 = 下载断在半路）。
 *    收尾那条路原来 1200ms 后就关，现在要等这里。
 * 2. 导出成功要**记进索引**（已导出），这样「清理已导出的」才敢清 ——
 *    而文件本身**不删**（用户的明确要求）。
 */
let autoExportInFlight = 0;

async function runAutoExport(handle) {
  if (!handle?.url || !handle?.name) return { ok: false, error: '没有可导出的句柄' };
  autoExportInFlight += 1;
  try {
    const res = await downloadUrl({
      url: handle.url,
      filename: handle.name,
      subdir: handle.subdir || '',
      saveAs: false,
    });
    if (!res.ok) {
      console.info('[vh/sw] 自动导出没能交给下载器：', res.error);
      return { ok: false, error: res.error, name: handle.name };
    }
    // 等它真的写完再算数：blob 的寿命由离屏文档撑着
    const done = await waitDownloadDone(res.downloadId);
    if (done.ok) {
      // ⚠️ 「已导出」要用 patch 补：remember() 只认 name/kind/seconds/size，
      // 把 exportedAt 传进去会被丢掉（第一版就是这么写的，用例当场抓住：
      // 文件落到下载目录了，索引里却没有"已导出"，于是「清理已导出的」不敢清它）。
      await rememberProduct({
        name: handle.name,
        kind: MEDIA_KIND.CAPTURE,
        size: handle.size || done.bytes || null,
        at: Date.now(),
      });
      await patchProduct(handle.name, { exportedAt: Date.now() });
      console.info('[vh/sw] 抓流产物已自动导出：', handle.name);
      return { ok: true, name: handle.name, path: res.path };
    }
    console.info('[vh/sw] 自动导出没写完：', done.error || done.state);
    return { ok: false, error: done.error || 'interrupted', name: handle.name };
  } finally {
    autoExportInFlight -= 1;
  }
}

/**
 * 抓流产物落盘之后，**唯一**的自动导出入口。
 *
 * ## 为什么必须只有一处
 *
 * 发起方有四个：换集切段、停止收尾、手动快照、攒太大自动切段。
 * "各调用各的"这种写法已经漏过一次 —— 自动切段那条路上，离屏文档明明把句柄
 * 推过来了（状态里的 `autoExport`），SW 的 `onOffscreenState` 却没人接：
 * 产物只在扩展私有存储里，用户以为它已经在下载目录里了，界面上也一个字都没说。
 *
 * 所以导出和**"把结果说出来"**都收在这一处。以前只有 `console.info` ——
 * 对用户来说"产物自动导出"这件事等于不存在：他只能自己去下载目录里翻，
 * 翻不到也分不清是失败了还是压根没做。
 *
 * @param {{url:string,name:string,size?:number,subdir?:string}|null} handle
 *   离屏文档给的 blob 句柄（blob 活在离屏文档里，所以调用方**不能**提前关它）
 * @returns {Promise<{ok:boolean,notice:string|null,name?:string,error?:string}>}
 */
async function autoExportProduct(handle) {
  if (!handle?.url || !handle?.name) {
    return { ok: false, notice: null, error: '没有可导出的句柄' };
  }
  const res = await runAutoExport(handle);
  const notice = res?.ok
    ? `已导出到下载目录：${res.name}`
    : `自动导出没能完成：${res?.error || '未知原因'}`
      + ' —— 产物本身没丢，它还在管理页的「抓流文件」里，点「保存到磁盘」可以再导一次。';
  // 只在**当前确实有录制状态**时写提示：没有状态时凭空写一条会让界面读到
  // 一个没有 stage 的"状态"。写入用 patch（导出期间每秒心跳还在写状态，
  // 整份覆盖会把别的新字段抹掉 —— 见 patchRecording 的注释）。
  // ⚠️ 写状态失败**不能**把整条收尾/切段带崩（这里只记一句、照常返回结果）：
  // 导出已经完成了，提示写不进去是小事，报错弹红反而是大事。
  try {
    if (await getRecording()) {
      await patchRecording({ exportNotice: notice, exportOk: res?.ok === true });
    }
  } catch (err) {
    console.info('[vh/sw] 自动导出的结果没能写进状态（不影响导出本身）：', err?.message || err);
  }
  return { ...res, notice };
}

/**
 * 关离屏文档，但**有自动导出在跑就先等着**。
 *
 * 这是"blob 属于离屏文档"这条约束的落点：宁可晚关几秒，
 * 也不能把一个正在写盘的导出掐断。
 */
async function closeOffscreenWhenIdle({ timeoutMs = 120000 } = {}) {
  const started = Date.now();
  while (autoExportInFlight > 0 && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 300));
  }
  await closeOffscreen();
}

async function stopMseCapture(options = {}) {
  // 和录制那条路同一套待遇：收尾不是瞬间的，用户在这期间再点一次「停止并保存」
  // 不该得到一句"没有在抓流"。
  if (stopMseInFlight) return stopMseInFlight;
  const cur = await getRecording();
  const retryable = cur?.mode === 'mse' && cur?.stage === RECORD_STAGE.ERROR && cur?.retryable;
  if (cur?.stage !== RECORD_STAGE.RECORDING || cur.mode !== 'mse') {
    if (cur?.mode === 'mse' && (cur?.stage === RECORD_STAGE.READY || cur?.stage === RECORD_STAGE.FINALIZING)) {
      await openRecorderPage({ tabId: cur.tabId, title: cur.title || '', focus: 'capture' }).catch(() => {});
      return { ok: true, action: cur.stage === RECORD_STAGE.READY ? 'already-finalized' : 'finalizing', state: cur };
    }
    // ⚠️ 「上次收尾写盘失败」也是可以再点一次的：数据还在离屏文档里，
    // 用户腾出空间之后必须有个「重试保存」的入口 —— 否则他只能眼睁睁
    // 看着攒了四十分钟的东西卡在那儿，抓流也开不了新的。
    if (!retryable) return { ok: false, error: '当前没有在抓流' };
  }
  stopMseInFlight = runStopMseCapture(cur, { ...options, retry: retryable });
  try {
    return await stopMseInFlight;
  } finally {
    stopMseInFlight = null;
  }
}

let stopMseInFlight = null;

/**
 * 内容脚本那边有没有"重试之后仍然没送进离屏文档"的数据段。
 *
 * 为什么要在收尾时问一句：那种段是真的缺了（画面/声音少一截），而面板上的
 * "已转发 N 段"看不出来 —— 用户只会觉得"这个工具做出来的文件有问题"。
 * 数据是从页面经过内容脚本转交的，只有它知道有没有送失败。
 *
 * 拿不到就返回空数组：页面可能已经被关掉或刷新了，那本来也问不出来。
 */
async function lostChunkWarnings(tabId) {
  if (!Number.isInteger(tabId)) return [];
  try {
    const stats = await chrome.tabs.sendMessage(tabId, { type: 'vh:mse-stats' });
    const lost = Number(stats?.sendFailed) || 0;
    if (lost <= 0) return [];
    return [`有 ${lost} 段数据没能从页面送进扩展（那几段的内容缺失）—— `
      + '通常是抓流刚开始时离屏文档还没准备好，或者扩展中途被浏览器回收过。'
      + '重抓一次通常就好；产物本身是完整的 MP4，只是少了一截。'];
  } catch {
    return [];
  }
}

async function runStopMseCapture(cur, options = {}) {
  clearTimeout(idleTimer);
  idleBaseline = null;
  await setRecording({ ...cur, stage: RECORD_STAGE.FINALIZING, updatedAt: Date.now() });

  // 先把页面那边的开关关掉，别再往里灌数据
  if (Number.isInteger(cur.tabId)) {
    chrome.tabs.sendMessage(cur.tabId, { type: MSG.MSE_ARM, enabled: false }).catch(() => {});
  }

  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_MSE_STOP });
  } catch (err) {
    res = { ok: false, error: `离屏文档没有响应：${err?.message || err}` };
  }
  // ⚠️ 「写盘失败但数据还在」时**绝不能关离屏文档**：那份字节只存在于
  // 它的内存里，关掉等于把用户攒了半天的东西扔掉，重试也就无从谈起了。
  const awaitingRetry = !!res?.awaitingRetry;
  // 收尾产出的是一份**完整产物** —— 开了自动导出就落一份到下载目录。
  // ⚠️ 必须**在关离屏文档之前**做：那个 blob URL 活在这个文档里，
  // 关早了下载会断在半路（这条漏过一次：切段/快照都接了，唯独收尾这条没接，
  // 而收尾恰恰是最常走的那条路）。结果里的 `notice` 要跟着最终状态写出去，
  // 否则用户永远看不到"到底导出去没有"。
  const exportRes = res?.ok ? await autoExportProduct(res.autoExport) : null;
  // 自动导出的 blob 也活在离屏文档里 —— 等它写完再关（见 closeOffscreenWhenIdle）
  if (!awaitingRetry) await closeOffscreenWhenIdle();
  // 钩子只在该抓的时候挂在页面上，结束就注销 —— 别留在用户页面里
  await unregisterMseHook();

  if (!res?.ok) {
    // 换集切过之后缓冲里可能什么都不剩 —— 那是**正常收尾**，不是失败。
    // 报成 ERROR 会让用户以为抓流出错了，而其实前面几段好好地躺在管理页里。
    const nothingLeft = /没有捕获到任何数据|没有正在进行的抓流/.test(res?.error || '');
    if (nothingLeft && cur.parts > 0) {
      const settled = {
        ...cur,
        stage: RECORD_STAGE.READY,
        finishedAt: Date.now(),
        error: null,
        note: options.auto ? '下一个视频一直没有出现新数据，已自动收尾' : '最后一段没有新数据',
        updatedAt: Date.now(),
      };
      await setRecording(settled);
      notify({ type: MSG.RECORD_STATE_PUSH, state: settled });
      return { ok: true, alreadyCut: true, parts: cur.parts, state: settled };
    }
    const next = {
      ...cur,
      stage: RECORD_STAGE.ERROR,
      error: res?.error || '抓流收尾失败',
      // 能重试的失败（空间不够、合并那一步抛异常）：**数据还在离屏文档里**，
      // 界面要给「重试保存」和「放弃这一份」两个出口。
      // 不能重试的是"内容本身没得合"（比如一条视频轨都没抓到）—— 那种重试也没用，
      // 别给假希望。（用户报过一次：合并抛异常时数据被一起丢掉，34.7 MB 没了。
      // 现在合并异常也走这条 retryable 的路，原始分块留在内存里等用户决定。）
      retryable: res?.retryable === true,
      storageFull: res?.storageFull === true,
      pendingBytes: res?.bytes ?? null,
      updatedAt: Date.now(),
    };
    await setRecording(next);
    notify({ type: MSG.RECORD_STATE_PUSH, state: next });
    // 能重试的失败要把用户**送到底**：重试按钮在管理页上。
    // 不打开的话，用户只看到一句"没能写出来"，而不知道该去哪儿点 ——
    // 他刚才点的是「停止并保存」，很可能是在面板里点的。
    if (next.retryable) {
      try {
        const opened = await openRecorderPage({
          tabId: cur.tabId,
          title: cur.title || '',
          focus: 'capture',
        });
        return { ...res, state: next, management: opened };
      } catch { /* 打不开页面也不影响状态本身 */ }
    }
    return res;
  }

  const done = {
    stage: RECORD_STAGE.READY,
    mode: 'mse',
    tabId: cur.tabId,
    title: cur.title || (await tabTitleOf(cur.tabId)),
    startedAt: cur.startedAt,
    finishedAt: Date.now(),
    fileName: res.fileName,
    size: res.size,
    // 挂钟：抓这一次花了多久（可能包含暂停、拖动、切标签页）
    durationMs: res.durationMs,
    // 真实视频时长：从产物自己的 mvhd 读出来的，界面显示时长只用它
    mediaSeconds: res.mediaSeconds ?? null,
    // 这次会话一共收尾了几段（换集 / 攒太大自动切段都会多一段）
    parts: res.part || cur.parts || 1,
    // 其中因为"攒得太大"切了几段：收尾文案要能说清"为什么多了几个文件"
    sizeCuts: res.sizeCuts || 0,
    frames: 0,
    dropped: res.dropped || 0,
    warnings: [...(res.warnings || []), ...(await lostChunkWarnings(cur.tabId))],
    detail: res.detail,
    error: null,
    // 自动导出的结果（成功/失败都有一句）—— 收尾是用户最常走的那条路，
    // "文件到底有没有落到下载目录"必须当场说清楚，不能只写进控制台
    exportNotice: exportRes?.notice ?? null,
    exportOk: exportRes ? exportRes.ok === true : null,
    updatedAt: Date.now(),
  };
  // 索引在这里写：**离屏文档没有 chrome.storage**，它写的索引从来没生效过。
  // 这一步在页面刷新列表之前完成，所以列表里的"时长"不再依赖回退去读文件头
  // —— WebM 那种读不出头的产物也能正确显示时长。
  await rememberProduct({
    name: done.fileName,
    kind: MEDIA_KIND.CAPTURE,
    seconds: done.mediaSeconds,
    size: done.size,
  });
  await setRecording(done);
  notify({ type: MSG.RECORD_STATE_PUSH, state: done });

  // 抓流结束后**自动打开管理页**：产物落在浏览器私有存储里，
  // 不主动送过去的话用户根本不知道文件在哪、也不知道怎么保存出来。
  // 已经在开着就复用那个标签页（见 openRecorderPage）。
  try {
    const opened = await openRecorderPage({
      tabId: cur.tabId,
      title: done.title,
      focus: 'capture',
    });
    return { ...res, state: done, management: opened };
  } catch (err) {
    // 开页面失败不该把"抓流成功"这件事说成失败
    console.info('[vh/sw] 抓流完成后打开管理页失败：', err?.message || err);
    return { ...res, state: done };
  }
}

/* ------------------------------------------------------------------ *
 * 消息路由
 * ------------------------------------------------------------------ */

async function handleMessage(msg, sender) {
  switch (msg?.type) {
    case MSG.GET_SETTINGS:
      return { ok: true, settings: await getSettings() };

    case MSG.SET_SETTINGS: {
      const settings = await setSettings(msg.patch || {});
      return { ok: true, settings };
    }

    case MSG.GET_TAB_MEDIA: {
      const tabId = msg.tabId ?? sender?.tab?.id;
      if (!Number.isInteger(tabId)) return { ok: false, error: '缺少 tabId' };
      await store.flush(tabId);
      const entries = await store.list(tabId);
      const pageVideos = msg.includePageVideos === false ? [] : await collectPageVideos(tabId);
      return { ok: true, tabId, entries, pageVideos, page: getPageInfo(tabId) };
    }

    case MSG.CLEAR_TAB_MEDIA: {
      const tabId = msg.tabId;
      await store.clear(tabId);
      notify({ type: MSG.MEDIA_UPDATED, tabId, reset: true });
      return { ok: true };
    }

    case MSG.START_DOWNLOAD:
      return startDownload(msg);

    case MSG.OPEN_PARSER: {
      const params = new URLSearchParams({
        url: msg.url || '',
        referer: msg.referer || '',
        pageUrl: msg.pageUrl || '',
        title: msg.title || '',
        kind: msg.kind || '',
        sourceTabId: String(msg.tabId ?? sender?.tab?.id ?? ''),
      });
      await openTab(chrome.runtime.getURL(`src/parser/parser.html?${params.toString()}`));
      return { ok: true };
    }

    case MSG.OPEN_MERGE: {
      // 任务内容已经由面板写进 session storage，这里只负责开页面 ——
      // 轨道地址又长又带签名，塞进 URL 很容易超长。
      await openTab(chrome.runtime.getURL('src/parser/parser.html?mode=fmp4'));
      return { ok: true };
    }

    case MSG.SET_REFERER: {
      // 扩展页面自己发出的请求默认没有 Referer，而几乎所有 CDN 的
      // m3u8 / .ts 都校验它。这里给发起方标签页挂一条会话规则补上。
      if (!Number.isInteger(msg.tabId) || !msg.referer) {
        return { ok: false, error: '缺少 tabId 或 referer' };
      }
      return setRefererForTab(msg.tabId, msg.referer);
    }

    case MSG.CLEAR_REFERER: {
      if (!Number.isInteger(msg.tabId)) return { ok: false, error: '缺少 tabId' };
      return clearRefererForTab(msg.tabId);
    }

    case MSG.OPEN_RECORDER: {
      return openRecorderPage({
        tabId: msg.tabId ?? sender?.tab?.id ?? '',
        title: msg.title || '',
        focus: msg.focus || '',
      });
    }

    case MSG.RECORD_START: {
      const tabId = msg.tabId ?? sender?.tab?.id;
      return startRecording({ tabId, options: msg.options });
    }

    case MSG.RECORD_STOP: {
      // 录制和抓流走同一条状态机，靠 mode 分流
      const cur = await getRecording();
      return cur?.mode === 'mse' ? stopMseCapture() : stopRecording();
    }

    case MSG.MSE_START: {
      const tabId = msg.tabId ?? sender?.tab?.id;
      return startMseCapture({ tabId, startAt: msg.startAt });
    }

    case MSG.MSE_STOP:
      return stopMseCapture();

    case MSG.MSE_SNAPSHOT: {
      // 「先保存已录到的部分」：不动抓流本身，只让离屏文档把当前缓冲写出去
      const cur = await getRecording();
      if (cur?.stage !== RECORD_STAGE.RECORDING || cur.mode !== 'mse') {
        return { ok: false, error: '当前没有在抓流' };
      }
      try {
        const res = await chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_MSE_SNAPSHOT });
        if (res?.ok) {
          await rememberProduct({
            name: res.fileName,
            kind: MEDIA_KIND.CAPTURE,
            seconds: res.mediaSeconds,
            size: res.size,
          });
          // 用户明确点了「先保存已录到的部分」→ 开了自动导出就一起落到下载目录
          // （统一入口：导出 + 把结果写进状态；下面的 patch 不会把它抹掉）
          await autoExportProduct(res.autoExport);
          await patchRecording({
            lastSnapshot: { fileName: res.fileName, mediaSeconds: res.mediaSeconds, at: Date.now() },
          });
        }
        return res;
      } catch (err) {
        return { ok: false, error: `离屏文档没有响应：${err?.message || err}` };
      }
    }

    case MSG.INDEX_REMEMBER:
      // 离屏文档没有 chrome.storage，索引写入从这儿走（见上面 rememberProduct）
      return { ok: true, entry: await rememberProduct(msg) };

    case MSG.INDEX_FORGET:
      return { ok: true, removed: await forgetProduct(msg.name) };

    case MSG.MSE_DISCARD: {
      // 「放弃这一份」：收尾写盘失败、数据还在离屏文档的内存里，用户不想腾空间了。
      // 必须把这个出口留出来 —— 否则那份缓冲会一直占着会话，
      // 后面每一次点「抓流」都会被告知"已经在抓流中"。
      let res;
      try {
        res = await chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_MSE_DISCARD });
      } catch (err) {
        res = { ok: false, error: `离屏文档没有响应：${err?.message || err}` };
      }
      // 同样是 idle 版：用户点了「放弃这一份」时，前一次自动导出可能还在写盘
      await closeOffscreenWhenIdle();
      const cur = await getRecording();
      const settled = {
        ...(cur || {}),
        stage: RECORD_STAGE.READY,
        mode: 'mse',
        error: null,
        retryable: false,
        storageFull: false,
        pendingBytes: null,
        note: res?.ok ? '已经放弃这一份（没有保存）' : (res?.error || '没什么可放弃的'),
        finishedAt: Date.now(),
        updatedAt: Date.now(),
      };
      await setRecording(settled);
      notify({ type: MSG.RECORD_STATE_PUSH, state: settled });
      return { ...res, state: settled };
    }

    case MSG.MSE_BOUNDARY: {
      // 内容脚本发现"这个视频播完了 / 页面换下一个了"。
      // 收尾成独立文件，然后接着抓下一个 —— 播放列表不会被连成一个文件。
      const res = await cutMseCapture(msg.reason);
      if (res?.ok) {
        // 刚切完就去安排"再也没数据就自动收尾"（换集之后可能就没有下一集了）
        scheduleIdleFinish();
      }
      return res;
    }

    case MSG.RECORD_STATE:
      return { ok: true, state: await getRecording() };

    case MSG.PAGE_READY: {
      // 内容脚本每次注入都会问这一句。页面重载后内容脚本会重新注入，
      // 靠这个回答才知道要不要重新进入录制待命 / 抓流转交状态。
      const tabId = sender?.tab?.id;
      const cur = await getRecording();
      const mine = cur?.tabId === tabId;
      return {
        ok: true,
        arm: cur?.stage === RECORD_STAGE.RECORDING && cur.mode !== 'mse' && mine,
        mse: cur?.stage === RECORD_STAGE.RECORDING && cur.mode === 'mse' && mine,
        // "从当前进度开始抓"靠它活过这一次刷新：内容脚本重新注入时要把
        // 目标那一秒拿回去，否则看护会把位置扳回 0。
        startAt: mine ? (Number(cur?.startAt) || 0) : 0,
      };
    }

    case MSG.MEDIA_ENDED: {
      // 页面上的视频播完了 —— 自动收尾。用户要的是"录完就存好"，
      // 不是盯着计时器手动点停止。
      //
      // ⚠️ 但**不能见到 ended 就停**：页面上往往不止一个 `<video>`
      // （广告、预览、背景动画、花絮小窗）。任何一个结束都去停录制，
      // 用户真正的录制会在几秒内被打断 —— 而面板上还写着「录制中」，
      // 这时他再点「停止并保存」就会撞上收尾中的状态。
      // 所以只有**内容脚本认定的那个录制目标**播完才算数（见 armRecording）。
      const tabId = sender?.tab?.id;
      const cur = await getRecording();
      if (cur?.stage !== RECORD_STAGE.RECORDING || cur.mode === 'mse' || cur.tabId !== tabId) {
        return { ok: true, action: 'ignored' };
      }
      if (msg.fromTarget === false) {
        console.info('[vh/sw] 页面里有一个非目标的视频播完了，不打断录制');
        return { ok: true, action: 'ignored-not-target' };
      }
      notify({ type: MSG.RECORD_STATE_PUSH, state: { ...cur, stage: RECORD_STAGE.FINALIZING, note: '播放结束，正在自动收尾' } });
      stopRecording().catch((err) => console.warn('[vh/sw] 自动收尾失败：', err));
      return { ok: true, action: 'auto-stopping' };
    }

    case MSG.OFFSCREEN_STATE:
      await onOffscreenState(msg);
      return { ok: true };

    case MSG.GET_TAB_INFO: {
      const tabId = msg.tabId ?? sender?.tab?.id;
      const scan = await scanPageVideos(tabId);
      return { ok: true, page: getPageInfo(tabId), videos: scan?.videos || [] };
    }

    case MSG.INJECT_PAGE_BUTTONS: {
      const tabId = msg.tabId ?? sender?.tab?.id;
      return setPageButtons(tabId, msg.enabled !== false);
    }

    case MSG.FETCH_RESOURCE: {
      // 页面上下文抓取（三级策略里的第一级，最保真）
      const tabId = msg.tabId;
      const res = await pageFetchText(tabId, msg.url);
      return { ...res, tier: 'page' };
    }

    case MSG.PAGE_DOWNLOAD_CLICK: {
      const tabId = sender?.tab?.id;
      if (!Number.isInteger(tabId)) return { ok: false, error: '缺少来源标签页' };
      const videos = await collectPageVideos(tabId);
      const target = videos.find((v) => v.video && v.video.sources.includes(msg.sources?.[0]))
        || videos[msg.index]
        || videos[0];

      // 页面上的「录制」按钮：只在 MSE 场景出现
      if (msg.action === 'open-recorder') {
        await openTab(chrome.runtime.getURL(
          `src/recorder/recorder.html?${new URLSearchParams({ tabId: String(tabId), title: target?.pageTitle || '' })}`,
        ));
        return { ok: true, action: 'opened-recorder' };
      }

      if (!target) return { ok: false, error: '没找到对应的视频' };
      if (target.video?.hasBlob || !target.url) {
        // MSE：地址在 JS 里，DOM 上没有 —— 只能走录制
        await openTab(chrome.runtime.getURL(
          `src/recorder/recorder.html?${new URLSearchParams({ tabId: String(tabId), title: target.pageTitle || '' })}`,
        ));
        return { ok: true, action: 'opened-recorder' };
      }
      const settings = await getSettings();
      return downloadUrl({
        url: target.url,
        filename: guessFileName(target.url, KIND.FILE, 'mp4'),
        subdir: settings.downloadSubdir,
      });
    }

    case 'vh:download-failed':
      return { ok: true }; // 只是广播，不该走到这儿

    default:
      return { ok: false, error: `未知消息：${msg?.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 广播类消息没有响应预期，别让它们落到 default 分支去回一句"未知消息"。
  //
  // MSE_BUFFER 尤其要紧：它是内容脚本发的，离屏文档才是该回话的那个；
  // service worker 要是也抢着回一句 {ok:false}，发送方拿到的可能就是这句，
  // 于是抓流数据被当成"失败"丢掉。
  //
  // 下面这组 `vh:offscreen-*` 同理，而且更隐蔽：它们是**发给离屏文档**的请求，
  // `chrome.runtime.sendMessage` 会把它们广播给所有扩展页面，service worker
  // 也会收到。如果这里不早退，SW 就会抢先回一句 `{ok:false, 未知消息}` ——
  // 谁先回是不确定的，于是"问离屏文档状态"变成一个看运气的操作
  // （实测在端到端里就是时好时坏）。
  if (msg?.type === MSG.MEDIA_UPDATED
    || msg?.type === MSG.RECORD_STATE_PUSH
    || msg?.type === MSG.MSE_BUFFER
    || msg?.type === MSG.OFFSCREEN_START
    || msg?.type === MSG.OFFSCREEN_STOP
    || msg?.type === MSG.OFFSCREEN_STATUS
    || msg?.type === MSG.OFFSCREEN_MSE_START
    || msg?.type === MSG.OFFSCREEN_MSE_STOP
    || msg?.type === MSG.OFFSCREEN_MSE_SNAPSHOT
    || msg?.type === MSG.OFFSCREEN_MSE_CUT) return false;
  handleMessage(msg, sender).then(
    (res) => sendResponse(res),
    (err) => {
      console.error('[vh/sw] 处理消息出错：', msg?.type, err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    },
  );
  return true; // 异步响应
});

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
  clearRefererForTab(tabId);
});

chrome.runtime.onInstalled.addListener(async (details) => {
  // 会话规则在浏览器重启后本来就没了，但扩展升级不会重启浏览器。
  // 这里清一次，免得旧版本的规则（或 ID 分配表）残留下来对不上号。
  await resetAllRefererRules();
  if (details.reason === 'install') {
    console.log('[vh] Video Hunter 已安装。');
  }
});

// 让 popup 打开时能立刻拿到一份已落盘的列表
chrome.runtime.onStartup.addListener(() => {
  console.log('[vh] service worker 随浏览器启动。');
});
