/**
 * 采集引擎（运行在离屏文档里）。
 *
 * 这个文件只做**编排**：拿标签页的音视频流、把流交给录制管线、
 * 上报状态、处理意外结束。真正的编码与封装在 pipeline.js 里 ——
 * 那样抽出来是为了让那条最容易出错的链路能脱离 tabCapture 单独验证。
 *
 * 为什么用 WebCodecs 而不是 MediaRecorder：
 *   Chrome 的 MediaRecorder 只输出 WebM。要变成 MP4 就得再拉一个
 *   25 MB 的 ffmpeg.wasm 转码 —— 而 WebCodecs 的 H.264 编码器是浏览器
 *   自带的，配上 mp4-muxer（67 KB）就能**直接产出 MP4**，链路短一半，
 *   而且不占额外体积、不做二次转码（没有画质损失）。
 *
 * 为什么落到 OPFS 而不是直接弹保存对话框：
 *   离屏文档里没有用户手势，showSaveFilePicker 调不起来。
 *   所以录制期间先写 OPFS（内存占用恒定），录制结束后由 recorder 页
 *   在用户点击时把文件流式拷到用户选的位置。
 */
import { MSG, RECORD_STAGE, REC_PREFIX, CAPTURE_PREFIX, MEDIA_KIND } from '../core/constants.js';
import { explainStorageError } from '../core/storage-error.js';
import { formatBytes } from '../core/classify.js';
import { readMovieDurationSeconds } from '../parser/seek-check.js';
import {
  createRecorder, writeOpfsFile,
} from './pipeline.js';
// 命名规则、自动保存/切段的判据与限额都在 core 里（纯函数，别的页面也要用）
import {
  fileStamp, captureFileName, partialCaptureFileName, autoSnapshotFileName,
  autoSnapshotPlan, autoSnapshotIntervalMs,
  captureCutPlan, captureCutThresholdBytes, captureSizeNotice,
} from '../core/capture-limits.js';
import { createTsRemuxer } from '../parser/remuxer.js';
import { mergeFmp4, parseInitSegment } from '../parser/mp4-merge.js';
import { listInitTracks, listInitTrackIds } from '../parser/fmp4-file.js';
import { demuxWebm } from '../parser/webm-demux.js';
import { mergeWebm, webmDurationSeconds } from '../parser/webm-merge.js';
import { transcodeOpusToAac } from './audio-transcode.js';
import {
  groupBuffers, analyzeGroup, concatChunks, explainEmptyCapture, explainMissingInit,
  finalizeCaptureBytes, readFragmentMediaTime, sniffContainer, contentTypeFromMime,
  pickReusableInit,
} from '../parser/mse-assemble.js';

/** 当前会话。同一时间只允许一个。 */
let session = null;

/** MSE 抓流的独立会话（它不需要采集流，是另一条路） */
let mse = null;

/** 产物元信息索引：管理页靠它显示真实时长，不用把大文件读一遍 */
/* ------------------------------------------------------------------ *
 * 产物索引：**不能**在这里直接写
 *
 * 实测（Chrome 153）：`chrome.offscreen.createDocument` 建出来的离屏文档里，
 * 扩展 API 只有 `chrome.runtime`（外加 loadTimes / csi）—— `chrome.storage`
 * 是 undefined。原来这里直接调 `mediaIndex.remember()`，**调用不报错、
 * 索引却一条都没写进去**：于是"管理页显示文件真实时长"这件事一直靠回退去读
 * 文件头，而读不出头的格式（比如 WebM）就永远显示"时长未记录"。
 *
 * 现在转发给 service worker（它有 storage）。这两个函数刻意不 await、
 * 也绝不抛错：索引只是缓存，写不进去不影响产物本身。
 * ------------------------------------------------------------------ */

function indexRemember(entry) {
  if (!entry?.name) return;
  chrome.runtime.sendMessage({ type: MSG.INDEX_REMEMBER, ...entry }).catch(() => {});
}

function indexForget(name) {
  if (!name) return;
  chrome.runtime.sendMessage({ type: MSG.INDEX_FORGET, name }).catch(() => {});
}

/* ------------------------------------------------------------------ *
 * 与 service worker 通信
 * ------------------------------------------------------------------ */

function post(patch) {
  // 广播式上报：没有接收方也不算错
  chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_STATE, ...patch }).catch(() => {});
}

/* ------------------------------------------------------------------ *
 * 采集源
 * ------------------------------------------------------------------ */

/**
 * 拿到标签页的流。
 * 有些标签页没有音频轨（比如纯画面直播），带 audio 约束会整条失败，
 * 所以失败后退成纯视频重试一次，而不是直接报错。
 */
async function acquireStream(streamId, frameRate) {
  const base = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { ...base } },
      video: { mandatory: { ...base, maxFrameRate: frameRate } },
    });
  } catch (err) {
    console.info('[vh/rec] 带音频的采集失败，退成纯视频：', err?.message || err);
    return navigator.mediaDevices.getUserMedia({
      video: { mandatory: { ...base, maxFrameRate: frameRate } },
    });
  }
}

/* ------------------------------------------------------------------ *
 * 开始 / 停止
 * ------------------------------------------------------------------ */

async function start(msg) {
  if (session) return { ok: false, error: '已经在录制中' };

  const {
    streamId,
    tabId = null,
    videoBitrate = 4000000,
    frameRate = 30,
    audioBitrate = 128000,
    monitorAudio = true,
  } = msg || {};

  if (!streamId) return { ok: false, error: '缺少 streamId' };

  const stream = await acquireStream(streamId, frameRate);

  let recorder;
  try {
    recorder = await createRecorder({
      stream,
      fileName: `${REC_PREFIX}${fileStamp()}.mp4`,
      videoBitrate,
      frameRate,
      audioBitrate,
      monitorAudio,
      onError: (err) => {
        // 编码出错时的收尾必须在**停止心跳之后**做，否则每秒一次的心跳
        // 会把刚上报的 ERROR 覆盖回「正在录制」。
        if (!session || session.stopped) return;
        session.stopped = true;
        clearInterval(session.statsTimer);
        session.statsTimer = null;
        post({
          stage: RECORD_STAGE.ERROR,
          tabId: session.tabId,
          startedAt: session.startedAt,
          fileName: session.recorder.fileName,
          error: String(err?.message || err),
        });
        // 主动收尾：不这么做采集流和 AudioContext 会一直挂着，
        // 标签页持续被采集，用户却看不到任何提示。
        stop().catch(() => {});
      },
    });
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    return { ok: false, error: String(err?.message || err) };
  }

  session = {
    recorder,
    tabId,
    startedAt: Date.now(),
    stopped: false,
    statsTimer: null,
  };

  // 轨道意外结束（用户关了标签页）时自动收尾，别把半个文件留在那儿
  recorder.videoTrack.addEventListener('ended', () => {
    if (!session || session.stopped) return;
    const endTabId = session.tabId;
    post({ stage: RECORD_STAGE.FINALIZING, tabId: endTabId, note: '视频轨结束，正在收尾' });
    stop()
      // 收尾本身也可能失败（muxer.finalize 抛错、OPFS 写不进去）。
      // 那种情况必须报 ERROR —— 把失败说成「录制完成」比失败本身更糟，
      // 用户会拿着一个坏文件当成品。
      .then((r) => post({ stage: r.ok ? RECORD_STAGE.READY : RECORD_STAGE.ERROR, tabId: endTabId, ...r }))
      .catch((err) => post({
        stage: RECORD_STAGE.ERROR,
        tabId: endTabId,
        error: String(err?.message || err),
      }));
  });

  session.statsTimer = setInterval(() => {
    if (session && !session.stopped) {
      post({ stage: RECORD_STAGE.RECORDING, tabId: session.tabId, stats: session.recorder.stats() });
    }
  }, 1000);

  post({ stage: RECORD_STAGE.RECORDING, tabId, startedAt: session.startedAt, fileName: recorder.fileName });

  return {
    ok: true,
    fileName: recorder.fileName,
    targetKind: recorder.targetKind,
    videoCodec: recorder.videoCodec,
    videoVendor: recorder.videoVendor,
    // H.264 用不了、退了 VP9 时要说出来 —— 产物仍是 MP4，但兼容性差一些，
    // 用户有权知道自己拿到的是什么
    videoFallback: recorder.videoFallback,
    audioCodec: recorder.audioCodec,
    width: recorder.width,
    height: recorder.height,
  };
}

async function stop() {
  const s = session;
  if (!s) return { ok: false, error: '没有正在进行的录制' };
  session = null;
  s.stopped = true;
  clearInterval(s.statsTimer);
  const result = await s.recorder.stop();
  // 录制的产物索引也由 service worker 记（离屏文档写不了 chrome.storage）
  return result;
}

/* ------------------------------------------------------------------ *
 * MSE 抓流
 *
 * 页面那边的钩子把 `appendBuffer` 的原始字节送过来 —— 那是播放器
 * **已经解密好的**码流（下载 → JS 解密 → appendBuffer → 解码）。
 * 所以这条路：不需要密钥、没有网页水印、不用重新编码、原始画质。
 *
 * 这里只负责：收下来 → 按轨归并 → 重封装/合并 → 写进 OPFS。
 * ------------------------------------------------------------------ */

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function mseStart(msg = {}) {
  if (mse) {
    // ⚠️ 上一次收尾写盘失败时，缓冲**故意**还留着（见 mseStop）。
    // 这时候如果只说"已经在抓流中"，用户会一头雾水 —— 他明明已经点了停止。
    if (mse.pending) {
      return {
        ok: false,
        awaitingRetry: true,
        error: '上一次抓流还等着保存：数据还在内存里，只是空间不够写不出去。'
          + '请到管理页点「重试保存」（或先导出/删掉一些旧产物），也可以点「放弃这一份」丢掉它再重新抓。',
      };
    }
    // ⚠️ 用户会在这个场景下点第二次：**播放列表里一集播完、自动存好（并自动导出）
    // 之后，他以为要"重新开始抓流"。** 其实抓流一直没停、缓冲已经清空、正在抓下一集 ——
    // 所以不能只回一句"已经在抓流中"（用户实测的说法是"我到了第二段就重新开始抓流"）。
    // 要说清：现在第几段了、前一段在哪、**不用再点**。
    const saved = mse.parts || 0;
    const where = mse.autoExport?.enabled
      ? '（并且已经自动导出到下载目录）'
      : '（都在管理页的「抓流文件」里，可以随时「保存到磁盘」）';
    const now = mse.items.length
      ? `正在抓下一段（已收 ${mse.items.length} 段数据 / ${formatBytes(mse.bytes)}）`
      : '正在等下一段的数据进来';
    return {
      ok: false,
      alreadyCapturing: true,
      error: saved > 0
        ? `抓流还在进行中，不用再点一次：已经存好 ${saved} 段${where}，${now}。`
          + '它会一直抓到你说停 —— 想现在收尾就点「停止并保存」。'
        : `抓流已经开着了（这次还没抓到能收尾的一段，已收 ${mse.items.length} 段 / `
          + `${formatBytes(mse.bytes)}）—— 不用再点一次。`,
    };
  }
  mse = {
    items: [],
    bytes: 0,
    startedAt: Date.now(),
    dropped: 0,
    // 这次会话已经收尾了几段（播放列表里换一个视频就加一段）
    parts: 0,
    // 页面标题：产物文件名会带上它，用户过两天也认得出哪个是哪个
    title: String(msg.title || ''),
    // 自动保存的配置由 service worker 传进来（离屏文档读不了 chrome.storage）
    autoSnapshot: {
      enabled: msg.autoSnapshot?.enabled !== false,
      intervalMs: Number(msg.autoSnapshot?.intervalMs) > 0
        ? Number(msg.autoSnapshot.intervalMs)
        : autoSnapshotIntervalMs(10),
      // 'wall'（录了多久）还是 'media'（抓到的内容有多长）——见 autoSnapshotPlan
      basis: msg.autoSnapshot?.basis === 'media' ? 'media' : 'wall',
      basisWarned: false,
    },
    // 抓到的内容在**媒体时间轴**上跨了多久：按 mime 各记一份（视频/音频各一条）
    media: new Map(),
    // 「抓完自动导出到下载目录」（用户的请求：产物写进"抓流文件"之后自动落盘，
    // 同时**保留**私有存储里那份和「保存到磁盘」按钮 —— 本地误删了还能再导一次）。
    // 自动导出的是**完整产物**（收尾 / 换集切分 / 手动快照）；
    // 滚动自动保存那种 10 分钟一份的临时快照**不导**（否则每 10 分钟往下载目录扔一个）。
    autoExport: {
      enabled: msg.autoExport?.enabled === true,
      subdir: String(msg.autoExport?.subdir || ''),
    },
    // 「攒得太大就自动切一段」（默认开）：抓流全在内存里，收尾时 muxer 要一整块，
    // 超过 ~1 GB 基本就合不出来了（见 pipeline.js 里 captureCutThresholdBytes 的注释）。
    autoCut: {
      enabled: msg.autoCut?.enabled !== false,
      thresholdBytes: Number(msg.autoCut?.thresholdBytes) > 0
        ? Number(msg.autoCut.thresholdBytes)
        : captureCutThresholdBytes(600),
      cutting: false,
      cuts: 0,
      warned: false,
    },
    // 收尾写盘失败时暂存「合并好的字节 + 目标文件名」，等用户腾出空间重试
    pending: null,
    // 上一次「先保存已录到的部分」写的是什么内容（用来拒绝重复写同一份）
    lastSnapshot: null,
    snapshotTimer: null,
    // 这次会话里见过的初始化段，按大类（video/audio）存一份。
    // 用途见 assembleMseCapture 里的注释：播放器中途重建 SourceBuffer 时
    // 可能只补分片、不再补 init，而我们其实早就见过它了。
    seenInit: new Map(),
    // 每条流（分组键 → video/audio）先前分析出来的大类：给"只有分片"的那一组
    // 认领初始化段时用（见 assembleMseCapture 里的注释）
    seenStreamType: new Map(),
    statsTimer: null,
  };
  // 每秒报一次进度。抓流是"边播边收"，用户需要看到它确实在动 ——
  // 面板上只有一个转圈的计时器时，没法区分"在收"和"卡住了"。
  mse.statsTimer = setInterval(() => {
    if (!mse) return;
    // 直接复用 mseStats()：心跳和"查状态"必须是**同一份口径**，
    // 各算一份的话界面上会出现两个不一样的总数。
    const stats = mseStats();
    post({
      stage: RECORD_STAGE.RECORDING,
      mode: 'mse',
      stats,
      // 快到阈值时先说一句（切段是"把一个视频变成两个文件"，得先讲）
      captureNotice: takeSizeNotice(mse),
    });
    // 到阈值就切一段。放进心跳里做，是因为别的定时器只关心"时间"，
    // 而这件事的判据是**体积**。
    maybeAutoCut();
  }, 1000);
  armAutoSnapshot();
  return { ok: true, startedAt: mse.startedAt };
}

/**
 * 快到阈值时返回一句提示（只返回一次，之后返回 null，免得每秒刷屏）。
 */
function takeSizeNotice(s) {
  if (!s?.autoCut || s.autoCut.warned) return null;
  const notice = captureSizeNotice({
    enabled: s.autoCut.enabled,
    bytes: s.bytes,
    threshold: s.autoCut.thresholdBytes,
  });
  if (!notice) return null;
  s.autoCut.warned = true;
  return notice;
}

/**
 * 攒得太大就自动切一段，然后继续抓。
 *
 * 这是"长抓流收尾必然失败"的正解（见 pipeline.js 的 captureCutThresholdBytes）：
 * 与其在最后关头因为合并吃不下内存而全丢，不如到阈值就先写出一段完整文件、
 * 清空缓冲接着抓。**切开是自动的、默认开着的，但一定要说出来** ——
 * 用户的一个视频变成了两个文件，他有权在发生的那一刻就知道。
 */
async function maybeAutoCut() {
  const s = mse;
  if (!s) return;
  const plan = captureCutPlan({
    enabled: s.autoCut.enabled,
    awaitingRetry: !!s.pending || !!s.assembleError,
    cutting: s.autoCut.cutting,
    chunks: s.items.length,
    bytes: s.bytes,
    threshold: s.autoCut.thresholdBytes,
  });
  if (plan !== 'cut') return;

  s.autoCut.cutting = true;
  const before = s.bytes;
  try {
    const r = await mseCut('size');
    if (r?.ok) {
      s.autoCut.cuts += 1;
      post({
        stage: RECORD_STAGE.RECORDING,
        mode: 'mse',
        stats: mseStats(),
        // 切出来的是**完整文件**，照样自动导出（这条路由离屏文档自己发起，
        // 没有响应可回，所以句柄跟着状态一起推过去，由 SW 交给下载器）
        autoExport: r.autoExport || null,
        captureNotice: `已经攒到 ${formatBytes(before)}，先存下一段完整文件（${r.fileName}），`
          + `接着往下抓。这一段和第 ${s.parts} 段按文件名顺序拼起来就是完整内容 —— `
          + `分成多段是因为一次合并吃不下更大的（要一整块内存）。`,
      });
    } else if (!r?.skipped) {
      // 没切成（写盘失败等）：不改抓流状态，如实记一句。
      // 数据还在缓冲里，用户仍然可以手动「先保存已录到的部分」或直接停止。
      console.info('[vh/mse] 自动切段没成功：', r?.error || r);
      post({
        stage: RECORD_STAGE.RECORDING,
        mode: 'mse',
        stats: mseStats(),
        warning: `自动切段没能写出来：${r?.error || '未知原因'}。抓流没有中断，`
          + '但缓冲已经很大了 —— 建议点「先保存已录到的部分」或直接停止收尾。',
      });
    }
  } catch (err) {
    console.info('[vh/mse] 自动切段抛错了：', err);
  } finally {
    s.autoCut.cutting = false;
  }
}

/**
 * 挂上"自动保存已录到的部分"的定时器。
 *
 * 配置由 service worker 传进来（**离屏文档里没有 chrome.storage**，
 * 见上面 indexRemember 的注释）。间隔改动不用重开抓流：SW 收到设置变更会把
 * 新配置转过来，`setAutoSnapshot()` 按新值重排。
 *
 * ⚠️ 这里是**每秒看一次**，而不是"定一个 N 分钟的闹钟"：
 * 「每 N 分钟」有两种口径，其中"视频内容 N 分钟"必须**持续观察**才能发现
 * （挂钟到点了，内容可能才走了一点点 —— 倍速播放时正好相反）。
 * 真正"该不该存"的判据在 `autoSnapshotPlan` 里，这里只负责按时问它。
 * 一次慢活儿（组装 + 写盘几百 MB）不能和下一次叠在一起，所以用 running 挡住重入。
 */
function armAutoSnapshot() {
  const s = mse;
  if (!s) return;
  if (s.snapshotTimer) { clearInterval(s.snapshotTimer); s.snapshotTimer = null; }
  if (!s.autoSnapshot.enabled) return; // 没开就不排
  s.snapshotTimer = setInterval(() => {
    if (mse !== s) return;
    if (s.snapshotRunning) return;
    s.snapshotRunning = true;
    runAutoSnapshot().finally(() => { s.snapshotRunning = false; });
  }, 1000);
}

/** 设置变了：更新配置并重排（没有会话时如实回一句） */
function setAutoSnapshot(config = {}) {
  if (!mse) return { ok: false, error: '当前没有在抓流' };
  mse.autoSnapshot = {
    enabled: config.enabled !== false,
    intervalMs: Number(config.intervalMs) > 0
      ? Number(config.intervalMs)
      : mse.autoSnapshot.intervalMs,
    basis: config.basis === 'media' ? 'media' : (config.basis === 'wall' ? 'wall' : mse.autoSnapshot.basis),
    last: mse.autoSnapshot.last || null,
    basisWarned: mse.autoSnapshot.basisWarned,
  };
  // 自动导出也跟着一起更新：用户可能正在抓流时才想起来开它
  if (config.autoExport) {
    mse.autoExport = {
      enabled: config.autoExport.enabled === true,
      subdir: String(config.autoExport.subdir || ''),
    };
  }
  armAutoSnapshot();
  return { ok: true, autoSnapshot: { ...mse.autoSnapshot, last: undefined } };
}

/**
 * 自动保存一次（滚动覆盖，**只留最新一份**）。
 *
 * 为什么是滚动而不是每次都留一份：这份写的是"当前整个缓冲"，
 * 每次都留就等于把同一批数据反复抄一遍 —— 2 小时的视频按 10 分钟一存
 * 差不多是总体积的 6 倍，很快就撞上配额（而配额满正是我们要防的那件事）。
 * 想留早期检查点，用户自己点「先保存已录到的部分」，那份不会被覆盖。
 */
async function runAutoSnapshot() {
  const s = mse;
  if (!s) return;
  const mediaSeconds = mediaSpanSeconds(s);
  // 「按视频内容时长」这一档要靠分片自己的 tfdt 算。WebM 那类流没有 tfdt ——
  // 那就**回落成挂钟**（自动保存是安全网，绝不能因为量不出来就永不触发），
  // 但要说明一次，否则用户会以为"明明设了 10 分钟却按别的节奏在存"。
  const wantMedia = s.autoSnapshot.basis === 'media';
  if (wantMedia && !Number.isFinite(mediaSeconds) && !s.autoSnapshot.basisWarned && s.items.length > 0) {
    s.autoSnapshot.basisWarned = true;
    post({
      stage: RECORD_STAGE.RECORDING,
      mode: 'mse',
      captureNotice: '这条流没有可读的媒体时间戳（不是 fMP4），'
        + '「按视频内容时长」这一档自动回落成**按录制时间**算 —— 自动保存照常工作。',
    });
  }
  const plan = autoSnapshotPlan({
    enabled: s.autoSnapshot.enabled,
    // 等重试的时候（写盘没成功 / 合并失败）别再自动写 —— 数据就在内存里，
    // 再抄一份只会多占内存，而且写出来的还是同一段
    awaitingRetry: !!s.pending || !!s.assembleError,
    chunks: s.items.length,
    bytes: s.bytes,
    last: s.autoSnapshot.last,
    basis: s.autoSnapshot.basis,
    elapsedMs: Date.now() - s.startedAt,
    mediaSeconds,
    intervalMs: s.autoSnapshot.intervalMs,
  });
  if (plan !== 'write') {
    // 'off' / 'unchanged' / 'not-yet' 是正常情况，不必刷屏；另外两种值得留痕
    if (plan !== 'off' && plan !== 'unchanged' && plan !== 'not-yet') {
      console.info('[vh/mse] 跳过自动保存：', plan);
    }
    return;
  }

  const built = await safeAssemble(s);
  if (!built.ok) {
    // 组装失败（比如抓到的格式还不认识）不该打断抓流，也不该反复重试刷屏
    console.info('[vh/mse] 自动保存跳过：这次组装没成功', built.error);
    return;
  }

  const ext = built.kind === 'webm' ? 'webm' : 'mp4';
  const fileName = `${autoSnapshotFileName(fileStamp(), s.title, ext)}`;
  const written = await writeCaptureFile(built.merged, fileName, {
    ext,
    seconds: built.kind === 'webm' ? built.seconds : undefined,
  });
  if (!written.ok) {
    // 写不进去（多半是空间不够）：**不打断抓流**，但要让用户知道 ——
    // 这正是"配额要满了"的早期信号，比收尾时才失败好得多。
    post({
      stage: RECORD_STAGE.RECORDING,
      mode: 'mse',
      warning: `自动保存没能写出来：${written.error}`,
    });
    return;
  }

  const previous = s.autoSnapshot?.fileName;
  s.autoSnapshot = {
    ...s.autoSnapshot,
    fileName: written.fileName,
    last: { bytes: s.bytes, chunks: s.items.length },
  };
  // 这一份是离屏文档自己发起的，没有"请求-响应"那条路可以借，只能转发给 SW 记
  indexRemember({
    name: written.fileName,
    kind: MEDIA_KIND.CAPTURE,
    seconds: written.mediaSeconds,
    size: written.size,
  });
  // 先写新的、再删旧的：中间任何一步失败都只是多占一份空间，
  // 反过来（先删后写）一旦写失败就什么都不剩了。
  if (previous && previous !== written.fileName) await removeOpfsFile(previous);

  post({
    stage: RECORD_STAGE.RECORDING,
    mode: 'mse',
    autoSnapshot: {
      fileName: written.fileName,
      replaced: previous || null,
      mediaSeconds: written.mediaSeconds,
      at: Date.now(),
    },
  });
  console.info('[vh/mse] 自动保存了一份已录到的部分：', written.fileName);
}

/**
 * 有了一份**完整**的产物之后，自动保存那份就没用了（内容是它的子集）。
 * 删掉它，别让列表里堆着一个永远比正式产物短的重复文件。
 */
async function dropAutoSnapshot() {
  const s = mse;
  const fileName = s?.autoSnapshot?.fileName;
  // 只清掉"写过哪一份"和内容指纹 —— **不要**把 enabled / intervalMs 一起抹掉，
  // 否则收尾之后再改设置就没法重排定时器了。
  if (s) s.autoSnapshot = { ...s.autoSnapshot, fileName: null, last: null };
  if (fileName) await removeOpfsFile(fileName);
}

async function removeOpfsFile(fileName) {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(fileName);
    indexForget(fileName);
    console.info('[vh/mse] 已删掉滚动保存的临时产物：', fileName);
  } catch (err) {
    // 删不掉不影响功能（只是一份多余的快照），但要留痕
    console.info('[vh/mse] 删除滚动保存的产物失败：', fileName, err?.message || err);
  }
}

/**
 * 抓流进度快照（给 OFFSCREEN_STATUS 用）。
 *
 * 除了总数，还要**按 mime 分开报**：用户报过"抓 YouTube 有画面没声音"，
 * 而只报一个总字节数的话，界面上完全看不出音频那条轨是"没收到"还是
 * "收到了但没合进去"。分开报之后，缺哪条轨一眼就能看见。
 */
function mseStats() {
  if (!mse) return null;
  const byMime = new Map();
  for (const item of mse.items) {
    const mime = item.mime || '（播放器没给 mime）';
    let g = byMime.get(mime);
    if (!g) { g = { mime, chunks: 0, bytes: 0 }; byMime.set(mime, g); }
    g.chunks += 1;
    g.bytes += item.bytes.byteLength;
  }
  return {
    elapsedMs: Date.now() - mse.startedAt,
    chunks: mse.items.length,
    bytes: mse.bytes,
    dropped: mse.dropped,
    parts: mse.parts,
    // 收尾失败、等着用户腾空间重试的状态：界面要能据此显示「重试保存 / 放弃」
    // 合并失败（数据还在原始分块里）也算同一种"等重试"，否则那几十 MB 没有出口
    awaitingRetry: !!mse.pending || !!mse.assembleError,
    pendingBytes: mse.pending?.merged?.byteLength ?? (mse.assembleError ? mse.bytes : null),
    pendingFileName: mse.pending?.fileName ?? null,
    // 合并失败的原因（有值时界面上的提示来自它）
    assembleError: mse.assembleError || null,
    // 滚动保存那一份（每 N 分钟自动写、只留最新）：界面要能告诉用户它在哪
    autoSnapshot: mse.autoSnapshot?.fileName ?? null,
    // 自动保存的配置也报出去，排查"为什么没自动存"时一眼能看到
    autoSnapshotEnabled: mse.autoSnapshot?.enabled ?? false,
    // 「每 N 分钟」的两种口径都要能看到：录了多久（挂钟）和抓到内容有多长（媒体时间轴）。
    // 倍速播放时这两个数会差好几倍 —— 用户要的就是"视频里的 10 分钟"。
    elapsedSeconds: Math.round((Date.now() - mse.startedAt) / 1000),
    mediaSpanSeconds: (() => {
      const v = mediaSpanSeconds(mse);
      return v == null ? null : Math.round(v);
    })(),
    autoSnapshotBasis: mse.autoSnapshot?.basis ?? 'wall',
    // 「攒得太大自动切段」：配置 + 已经切了几次（界面上要能解释"怎么多了一个文件"）
    autoCutEnabled: mse.autoCut?.enabled ?? false,
    cutThresholdBytes: mse.autoCut?.thresholdBytes ?? null,
    sizeCuts: mse.autoCut?.cuts ?? 0,
    tracks: [...byMime.values()],
  };
}

/**
 * 边界收尾：这个视频播完了 / 页面换下一个了。
 *
 * 把当前这段写成一个**完整文件**（不是 `-部分`），然后**清空缓冲继续抓** ——
 * 这样播放列表或自动连播不会把好几个视频连成一个文件，用户拿到的是一集一个文件。
 *
 * 为什么清空而不是接着攒：分片自带的解码时间戳在换视频时通常从 0 重新开始，
 * 攒在一起会让时间轴倒着走，合并出来是一团乱。
 */
async function mseCut(reason) {
  const s = mse;
  if (!s) return { ok: false, error: '当前没有在抓流' };
  // 至少要有"初始化段 + 一段媒体"才算一次有效收尾，否则就是误报（不切）
  if (s.items.length < 2) {
    return { ok: false, error: '这一段还没抓到足够的数据', chunks: s.items.length, skipped: true };
  }

  // 组装失败/抛异常都**不切、不清空**：缓冲区原样留着，用户下次收尾或手动
  // 停止时还会把它一起写出去（同下面"写不进去时绝不清空缓冲"的道理）。
  const built = await safeAssemble(s);
  if (!built.ok) return { ...built, skipped: true };

  const part = s.parts + 1;
  const written = await saveBuilt(s, built, { part });
  if (!written.ok) {
    // ⚠️ 写不进去时**绝不清空缓冲**：抓流还在继续，用户清出空间之后
    // 这一段的字节还在，下次收尾（或手动停止）会把它一起写出去。
    return { ...written, part: s.parts, skipped: true };
  }
  s.parts = part;
  // 这一段已经有完整的产物了，滚动保存那份就是它的子集，删掉
  await dropAutoSnapshot();
  // 清空，下一个视频从零开始
  s.items = [];
  s.bytes = 0;

  return {
    ok: true,
    fileName: written.fileName,
    size: written.size,
    mediaSeconds: written.mediaSeconds,
    part: s.parts,
    reason: reason || '',
    // 这一段的文件名 / 序号回给调用方：自动切段的提示要说清"存到哪了"
    sizeCuts: s.autoCut?.cuts ?? 0,
    // 换集/切段出来的**完整文件**也要自动导出（如果有开）——
    // 用户在播放列表里最想要的正是"每集自动落到下载目录"
    autoExport: await autoExportHandle(s, written.fileName),
    compressedSeconds: written.finalized.compressedSeconds,
    warnings: [...built.warnings, ...written.finalized.warnings],
    detail: built.detail,
  };
}

function mseBuffer(msg) {
  if (!mse) return { ok: false, error: '当前没有在抓流' };
  let bytes;
  try {
    bytes = base64ToBytes(msg.base64);
  } catch (err) {
    mse.dropped += 1;
    return { ok: false, error: `base64 解码失败：${err?.message || err}` };
  }
  mse.items.push({ seq: Number(msg.seq) || 0, mime: msg.mime || '', sbId: msg.sbId || '', bytes });
  mse.bytes += bytes.byteLength;
  trackMediaTime(mse, msg.mime, msg.sbId, bytes);
  return { ok: true, chunks: mse.items.length, bytes: mse.bytes };
}

/** 这个缓冲区里有没有某个顶层盒子（不分配、不解析，只走盒子头） */
function hasTopLevelBox(bytes, want) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (at + 8 <= bytes.byteLength) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (type === want) return true;
    if (size < 8) return false;
    at += size;
  }
  return false;
}

/**
 * 记录这条流在**媒体时间轴**上跨了多久。
 *
 * 为什么要它：「每 10 分钟自动存一份」里的 10 分钟有两种解法 ——
 * **挂钟**（你录了 10 分钟）和**视频内容**（抓到的内容有 10 分钟长）。
 * 正常播放时两者差不多，但用倍速插件播的时候能差好几倍
 * （用户实测就是这么用的）。后者只能从分片自己的 tfdt 算。
 *
 * ⚠️ 分组的键**不能是整条 mime 字符串**：播放器重建 SourceBuffer 时，
 * 初始化段和分片经常带着**不一样的 mime** 进来（`video/mp4; codecs="…"` vs `video/mp4`），
 * 那样 init 的 timescale 和分片的 tfdt 就各进一组，永远算不出时长 ——
 * 这正是第一版的结果（`mediaSpanSeconds: null`，用真实抓流验出来的）。
 * 所以按**大类**（video/audio）分组：init 和它的分片天然同组，音视频互不串。
 *
 * 代价刻意压到最小：只读 `moof→traf→tfdt/tfhd` 那几个字节（几秒才来一个分片），
 * 初始化段才解析一次拿 timescale。WebM 那种没有 tfdt 的流就记不下来 ——
 * 上层会**回落成挂钟**（而不是永不保存），并说明原因。
 */
function trackMediaTime(s, mime, sbId, bytes) {
  // 没有 mime 的流按 SourceBuffer 编号分（同 groupBuffers 的理由）
  const key = contentTypeFromMime(mime) || `sb:${sbId || '未知'}`;
  let entry = s.media.get(key);
  if (!entry) {
    entry = { firstTicks: null, lastTicks: null, timescale: 0 };
    s.media.set(key, entry);
  }
  if (hasTopLevelBox(bytes, 'moov')) {
    try {
      const info = parseInitSegment(bytes);
      const timescale = Number(info?.timescale) || 0;
      // 换了 timescale 说明这条轨换了（换清晰度/换集）：重新开始量，
      // 不然两段不同刻度的 tick 混在一起，算出来的"内容时长"是假的
      if (timescale && timescale !== entry.timescale) {
        entry.timescale = timescale;
        entry.firstTicks = null;
        entry.lastTicks = null;
      }
    } catch { /* moov 不完整或不是 fMP4，等下一块 */ }
  }
  if (sniffContainer(bytes) !== 'fmp4') return;
  const t = readFragmentMediaTime(bytes);
  if (!t) return;
  const ticks = t.baseMediaDecodeTime;
  if (entry.firstTicks == null || ticks < entry.firstTicks) entry.firstTicks = ticks;
  if (entry.lastTicks == null || ticks > entry.lastTicks) entry.lastTicks = ticks;
}

/** 抓到的内容在媒体时间轴上跨了多少秒（取最长的那条轨；算不出来返回 null） */
function mediaSpanSeconds(s) {
  let best = null;
  for (const entry of s.media.values()) {
    if (entry.firstTicks == null || entry.lastTicks == null || !entry.timescale) continue;
    const seconds = (entry.lastTicks - entry.firstTicks) / entry.timescale;
    if (best === null || seconds > best) best = seconds;
  }
  return best;
}

/**
 * 把当前收到的缓冲拼成一个 MP4。
 *
 * 抽出来是因为它有两个调用方：正常收尾（mseStop），和"先保存已录到的部分"
 * （mseSnapshot）。后者的存在有具体理由 —— 抓流**没法暂停**：
 * 数据是播放器边解边喂过来的，挂起钩子就等于把那段时间的码流丢掉，
 * 产物里会留下一个真空洞，比不暂停糟得多。所以想中途留一份，
 * 正确做法是"把手上这段先写出去，然后继续抓"，而不是"停一会儿"。
 */
/**
 * 一条流的"身份键" —— 必须和 `groupBuffers` 里的分组键**一字不差**
 * （有 mime 用 mime，没有就用 `sb:<编号>`）。做成一模一样是有意的：分组键在整个
 * 会话里稳定，所以"这条流先前是视频还是音频"可以按它记下来、以后按它查回来 ——
 * 这是给"只有分片、没有初始化段"的那一组认领 init 时最准的线索。
 */
function streamKeyOf(a) {
  return a.mime || `sb:${a.sbId || '未知'}`;
}

function assembleMseCapture(s) {
  const { groups, duplicates } = groupBuffers(s.items);
  // 把 mime 一起带进分析结果：分组是按 mime 分的，后面报错、报诊断都要用它，
  // 而 analyzeGroup 只看字节，不该反过来知道分组的 key。
  const analyzed = groups.map((g) => ({ ...analyzeGroup(g), mime: g.mime, sbId: g.sbId || '' }));

  // 记住这次会话里见过的初始化段（按大类），后面要用。
  for (const a of analyzed) {
    if (a.init) s.seenInit.set(a.contentType || 'video', a.init);
    // 这条流（按分组键：mime 或 sb:编号）**先前**被分析成什么大类 —— 这是给
    // "只有分片、没有初始化段"的那一组认领 init 时**最准**的线索：分组键在整个
    // 会话里是稳定的（同一个 SourceBuffer 的编号不会变），而真实站点上一批 append
    // 根本没有 mime，光看分片字节推不出大类。trackId 也靠不住：实测 ffmpeg 产的
    // 两条独立轨**都写 track 1**，撞号。
    if (a.init && a.contentType) s.seenStreamType.set(streamKeyOf(a), a.contentType);
  }
  // 借初始化段的候选项 —— **每条轨的 trackId 都要带上**：自动切段会把缓冲清空，
  // 而播放器不会重发 moov，后面那些"只有分片"的组只能借先前收到的那一份 init。
  // 借哪一份**不能按 mime 猜**（真实站点上有一批 append 根本没有 mime），
  // 只能按分片自己的 tfhd.track_ID 认（见 pickReusableInit 的注释）。
  const initCandidates = [...s.seenInit.entries()].map(([key, init]) => ({
    key,
    contentType: key,
    init,
    trackIds: listInitTrackIds(init).map((t) => t.id),
  }));

  const tracks = [];
  const webmGroups = [];
  const reusedInit = [];
  // 借初始化段时出的岔子（借错了 / 没得借）—— 这些以前是**静默**的，
  // 用户只看到"这一段没声音"。攒起来一起写进产物提示里。
  const reuseNotes = [];
  for (const a of analyzed) {
    if (a.container === 'mpegts') {
      // HLS 的 TS 分片：要用 mux.js 重封装成 fMP4 才能跟另一条轨合并
      if (!window.muxjs?.mp4?.Transmuxer) {
        return { ok: false, error: 'mux.js 没有在离屏文档里加载，无法重封装 TS 流' };
      }
      const frags = [];
      const remuxer = createTsRemuxer(window.muxjs, { onFragment: (b) => frags.push(b) });
      remuxer.append(a.raw);
      remuxer.end();
      if (!remuxer.initSegment) {
        return { ok: false, error: 'TS 重封装没有产出初始化段，这份抓流可能是不完整的' };
      }
      tracks.push({
        init: remuxer.initSegment,
        fragments: concatChunks(frags),
        handlers: listInitTracks(remuxer.initSegment),
        container: 'mpegts',
      });
    } else if (a.container === 'webm' && a.init && a.fragments && a.fragments.byteLength) {
      // WebM 单独处理：它要拆包 + （音频）转码，是异步的，不能在这儿做。
      webmGroups.push(a);
    } else if (a.init && a.fragments && a.fragments.byteLength) {
      tracks.push({
        init: a.init,
        fragments: a.fragments,
        handlers: listInitTracks(a.init),
        container: 'fmp4',
      });
    } else if (a.missingInit && a.raw) {
      // 「只有分片、没有初始化段」——**但这次会话里早就见过一个**。
      //
      // 真实场景：播放器中途重建了 SourceBuffer（seek、清缓冲、换清晰度）、
      // 或者**自动切段把缓冲清空了**（切段之后播放器不会重发 moov）。这时如果把
      // 整段抓流判死，用户丢掉的是已经收了几十 MB 的东西（实测 200 段 / 21.4 MB，
      // 而失败原因只是"开头不是 moov"）。
      //
      // ⚠️ 借哪一份 init **不能按 mime 猜**：真实站点上有一批 append 根本没有 mime，
      // 这时大类推不出来，回退成「当视频用」就会让**音频那组分片借到视频的 init** ——
      // 合并时按 trackId 挑样本，借来的 init 里没有那个 id，**整条音轨被丢掉**。
      // 用户报的「600 MB 自动切段之后那一段没有声音」就是这么来的：切段前每组自带
      // init 所以一切正常，切段后全靠借，于是音频借错了。判据只能是分片自己的
      // `tfhd.track_ID`（见 pickReusableInit）。
      const want = readFragmentMediaTime(a.raw)?.trackId ?? null;
      // ① 先问"这条流自己先前是什么"（分组键稳定，最准）；
      // ② 没有记录时才用 trackId / 大类去猜（见 pickReusableInit）。
      const own = s.seenStreamType.get(streamKeyOf(a)) || '';
      const picked = pickReusableInit(initCandidates, {
        contentType: own || a.contentType,
        trackId: want,
      });
      if (picked) {
        const pickedType = picked.candidate.contentType || 'video';
        reusedInit.push(pickedType);
        tracks.push({
          init: picked.candidate.init,
          fragments: a.raw,
          handlers: listInitTracks(picked.candidate.init),
          container: 'fmp4',
          reusedInit: true,
        });
        // 借来的 init 里如果没有这个 trackId，合并时这一组会被整条丢掉 ——
        // 以前这件事**完全静默**（用户只看到"这一段没声音"）。现在写进产物提示里。
        if (want != null && !(picked.candidate.trackIds || []).includes(want)) {
          reuseNotes.push(`有一组分片（trackId=${want}）在本次会话收到的初始化段里找不到对应的轨，`
            + `那一条轨没有进产物（这一组 ${a.raw.byteLength} 字节）`);
        }
      } else {
        reuseNotes.push(`有一组只有分片、没有初始化段，而本次会话里也没有可以借的 —— `
          + `这一组 ${a.raw.byteLength} 字节没有进产物（解决办法：点抓流之后刷新页面从头来）`);
      }
    }
    // 认不出容器的组直接跳过；一条都认不出时下面会给出明确错误
  }

  // ---- 挑视频轨和音频轨 ----
  // 复用流（一条 TS 里同时有音视频）会被当成两条轨用 —— 合并器支持
  // 同一份数据既当视频又当音频喂进去，各自只抽自己那条 trak 的样本。
  let video = tracks.find((t) => t.handlers.includes('video')) || null;
  let audio = tracks.find((t) => t.handlers.includes('audio') && t !== video) || null;
  if (!audio && video?.handlers.includes('audio')) audio = video;
  if (!video && audio?.handlers.includes('video')) video = audio;

  if (!tracks.length && !webmGroups.length) {
    // 「只抓到分片、没有初始化段」要单独说，因为它的解决办法完全不同：
    // 不是"再等等"，而是"刷新页面从头来"。
    if (analyzed.some((a) => a.missingInit)) {
      return { ok: false, error: explainMissingInit(), needReload: true };
    }
    const detail = analyzed.map((a) => `${a.bytes} 字节（${a.container}${a.error ? '：' + a.error : ''}）`).join('；');
    return {
      ok: false,
      error: `收到了 ${s.items.length} 段数据，但一段都认不出容器：${detail}`,
    };
  }

  return finishAssembly(s, { analyzed, tracks, webmGroups, video, audio, reusedInit, reuseNotes, duplicates });
}

/**
 * 收尾：把 WebM 组拆开、需要的话把 Opus 转成 AAC，然后合并落盘。
 *
 * 单独一段的原因：这一步是**异步**的（转码），而上面挑轨是纯同步的判断。
 */
async function finishAssembly(s, ctx) {
  const { analyzed, tracks, webmGroups, reusedInit, reuseNotes, duplicates } = ctx;
  let { video, audio } = ctx;
  const warnings = [];
  let transcoded = null;
  // 拆出来的 WebM 轨道（画面 + 音频），走"存成 .webm"那条路
  const webmVideoTracks = [];
  const webmAudioTracks = [];

  for (const group of webmGroups) {
    let demuxed;
    try {
      demuxed = demuxWebm(concatChunks([group.init, group.fragments]));
    } catch (err) {
      warnings.push(`一条 WebM 轨拆包失败：${err.message}`);
      continue;
    }
    for (const w of demuxed.warnings || []) warnings.push(w);
    if (demuxed.skippedBlocks) {
      warnings.push(`WebM 里有 ${demuxed.skippedBlocks} 个 Block 没能拆出来，那部分内容缺失`);
    }
    webmVideoTracks.push(...demuxed.tracks.filter((t) => t.type === 'video'));
    webmAudioTracks.push(...demuxed.tracks.filter((t) => t.type === 'audio'));
  }

  // ---- 画面是 WebM 的流：出 .webm，**零转码** ----
  //
  // 这条路的优先级高于"把音频转成 AAC 封进 MP4"：既然画面已经注定是 WebM，
  // 那么 Opus 音轨可以原样搬进去 —— 连唯一那处有损都省了。
  if (!video && webmVideoTracks.length) {
    return finishWebmCapture(s, {
      analyzed,
      webmVideoTracks,
      webmAudioTracks,
      reusedInit,
      reuseNotes,
      duplicates,
      warnings,
    });
  }

  // 到这里画面就是 fMP4/TS 了，音频如果是 WebM/Opus 就只能转成 AAC 封进 MP4
  if (!audio && webmAudioTracks.length) {
    const track = webmAudioTracks.find((t) => t.codec === 'opus') || webmAudioTracks[0];
    if (track.codec !== 'opus') {
      warnings.push(`WebM 音频编码是 ${track.codecId}，目前只做 Opus → AAC，这一路没合进产物`);
    } else {
      try {
        const result = await transcodeOpusToAac({
          frames: track.frames,
          sampleRate: track.sampleRate || 48000,
          channels: track.channels || 2,
          description: track.codecPrivate,
          // 长音频的转码要几十秒，界面上得看得见在动 —— 否则"正在收尾"
          // 那几十秒看起来就像卡死了（用户会去点第二次停止）。
          onProgress: (fraction) => {
            post({
              stage: RECORD_STAGE.FINALIZING,
              mode: 'mse',
              progress: { label: '音频转码（WebM/Opus → AAC）', fraction },
            });
          },
        });
        transcoded = result;
        if (result.backSteps) {
          warnings.push(`音频转码时有 ${result.backSteps} 帧时间戳回退，已经就地纠正（不纠正 muxer 会直接报错中断）`);
        }
        if (webmAudioTracks.length > 1) {
          warnings.push(`WebM 里有 ${webmAudioTracks.length} 条音频轨，只取了第一条`);
        }
        // 这是整条抓流链路上**唯一**一处有损，用户有权知道（视频一个字节没动）。
        warnings.push('音频轨是 WebM/Opus，封进 MP4 时转成了 AAC —— 这是唯一一处有损，视频是原封不动的');
      } catch (err) {
        // 转不了就说清楚，绝不给一个"没声音但看起来成功"的文件
        warnings.push(`音频轨（WebM/Opus）转成 AAC 失败：${err.message}。产物只有画面。`);
      }
    }
  }

  if (!video && !transcoded) {
    const found = tracks.map((t) => t.handlers.join('+') || '未知').join('、') || '（没有可用的轨）';
    return {
      ok: false,
      error: `抓到的 ${tracks.length} 条轨里没有可用视频轨（识别结果：${found}）`,
    };
  }

  // 一组抓流里可能同时存在好几条同类轨（站点预加载下一个视频、换清晰度重建缓冲
  // 都会这样）。我们只挑一条用 —— **必须说出来**，否则用户以为整段都在里面。
  const videoCount = tracks.filter((t) => t.handlers.includes('video')).length;
  const audioCount = tracks.filter((t) => t.handlers.includes('audio')).length;
  if (videoCount > 1) warnings.push(`抓到了 ${videoCount} 条视频轨，只用了最先出现的那一条`);
  if (audioCount > 1 && !transcoded) warnings.push(`抓到了 ${audioCount} 条音频轨，只用了最先出现的那一条`);

  // ---- 合并 ----
  // 合并提示要收起来往上带：其中「时间轴空洞」是用户可见的问题
  // （拖进度条会跳回去），只写进 console.debug 等于没说。
  const merged = mergeFmp4({
    video: video ? { init: video.init, segments: [video.fragments] } : undefined,
    audio: audio ? { init: audio.init, segments: [audio.fragments] }
      : (transcoded ? { aac: transcoded } : undefined),
  }, {
    onWarning: (w) => {
      warnings.push(String(w));
      console.debug('[vh/mse] 合并提示：', w);
    },
  });

  return {
    ok: true,
    kind: 'mp4',
    merged,
    warnings: [
      ...(reusedInit.length
        ? [`这份抓流中途播放器重建过缓冲区、或者自动切过段（那些组只补了分片），`
          + `初始化段用的是本次抓流里先前收到的那一份（${reusedInit.join('、')}）`]
        : []),
      // 借初始化段时出的岔子（借错了 / 没得借）—— 这类问题以前是完全静默的
      ...reuseNotes,
      ...warnings,
    ],
    duplicates,
    detail: {
      chunks: s.items.length,
      duplicates,
      // 每一组都列出来（包括**没被采纳**的组）：用户报"抓 YouTube 有画面
      // 没声音"时，光看"收到了 127 段"完全看不出音频那条轨去哪了。
      // 采纳与否、什么容器、为什么不采纳，都要能看见。
      groups: groupDetail(analyzed),
      // WebM 音频是"抓到之后又转了一道码"的，用户有权知道这件事
      audioTranscode: transcoded
        ? {
          from: 'WebM/Opus',
          to: 'AAC',
          frames: transcoded.frames.length,
          sampleRate: transcoded.sampleRate,
          channels: transcoded.channels,
          backSteps: transcoded.backSteps,
        }
        : null,
      webmCodecs: null,
      tracks: tracks.map((t) => ({
        container: t.container,
        handlers: t.handlers,
        init: t.init.byteLength,
        fragments: t.fragments.byteLength,
      })),
    },
  };
}

/**
 * 组装结果落盘的**统一入口**。
 *
 * MP4 和 WebM 两种产物都从这里走：文件名（前缀/标题/序号/扩展名）和
 * "写不进去时保住数据"的处理只有这一份，免得两条路各写一遍、各漏一处。
 */
async function saveBuilt(s, built, { part, partial = false } = {}) {
  const ext = built.kind === 'webm' ? 'webm' : 'mp4';
  const fileName = partial
    ? partialCaptureFileName(fileStamp(), s.title, ext)
    : captureFileName(fileStamp(), part, s.title, ext);
  const written = await writeCaptureFile(built.merged, fileName, {
    ext,
    seconds: built.kind === 'webm' ? built.seconds : undefined,
  });
  return { ...written, ext };
}

/**
 * 落盘 + 记索引，返回时长与压缩信息。
 *
 * ⚠️ **落盘失败不抛异常，而是返回 `{ok:false, ...}`**。
 * 原因是抓流这条路的数据只有内存里这一份（攒了多久就是多久），
 * 调用方必须能分辨"算错了"和"写不进去"，后者要保住缓冲让用户重试。
 */
async function writeCaptureFile(merged, fileName, options = {}) {
  const isWebm = options.ext === 'webm';
  // 落盘前先做一次时间轴体检：把"谁都没抓到数据"的死气压掉。
  // 不做的话，播放器的位置往前跳过之后，产物里会横着一段几百秒的空洞，
  // 表现就是"前 12 分钟怎么拖都拖不动"（实测用户 23 分钟的产物里有 708 秒空洞）。
  //
  // ⚠️ 只对 MP4 做：那套修复是改 MP4 样本表的（stts/mvhd），WebM 是另一套容器。
  // WebM 那条路的时间轴空洞暂时**不压**（如实说，不假装修好了）。
  const finalized = isWebm
    ? { bytes: merged, compressedSeconds: 0, warnings: [], skipped: [] }
    : finalizeCaptureBytes(merged);
  let size;
  try {
    size = await writeOpfsFile(fileName, [finalized.bytes]);
  } catch (err) {
    // 空间不够是最可能的失败（配额、磁盘满）。这一份字节先攥在手里，
    // 由调用方决定"留着让用户重试"还是"放弃"。
    //
    // ⚠️ 提示文本要落进 `error` 字段：调用方（和界面）读的都是 `res.error`。
    // 只把 explainStorageError 的返回值摊开是不够的 —— 它的字段叫 `text`，
    // 结果就是**错误信息整个丢掉**，界面上只剩一句兜底的"抓流收尾失败"。
    // （这个坑是用例抓出来的：`retryable=true` 但 `error=undefined`。）
    const info = explainStorageError(err, { bytes: finalized.bytes.byteLength });
    return { ok: false, fileName, bytes: finalized.bytes.byteLength, ...info, error: info.text };
  }
  // 界面要显示的是**产物自己的时长**，不是"抓了多久"。
  // 用户抓流时可能暂停、拖动、切标签页，挂钟时间和视频时长经常差很多；
  // 拿挂钟当时长报出去，他一开播放器就发现对不上。
  // 时长也要重新读：压缩之后时间轴已经变短了。
  // WebM 没有 mvhd 可读，时长由上层按拆出来的帧算好传进来。
  const mediaSeconds = Number.isFinite(options.seconds)
    ? options.seconds
    : (isWebm ? null : readMovieDurationSeconds(finalized.bytes));
  // 索引不在这里写：离屏文档没有 chrome.storage。请求-响应这条路（收尾 / 切段 /
  // 手动快照 / 录制停止）由 service worker 拿到返回值时统一记，见 rememberProduct。
  // 只有"滚动自动保存"是离屏文档自己发起的，那种由调用方转发（见 runAutoSnapshot）。
  return { ok: true, size, mediaSeconds, finalized, fileName };
}

/**
 * 为"自动导出到下载目录"准备一个可下载的句柄。
 *
 * ## 为什么必须在离屏文档里做
 *
 * OPFS 文件按扩展源存放，`chrome.downloads.download` 又需要一个 URL ——
 * 中间的桥只能是 **blob URL**，而 blob URL 只能由**创建它的那个上下文**维持。
 * 离屏文档是抓流的落盘方（也是唯一长期活着的 DOM 上下文），所以句柄在这里建。
 *
 * ⚠️ 因此调用方（service worker）**必须等下载结束再关离屏文档** ——
 * 关早了 blob 失效，下载立刻断在半路（见 service-worker.js 的 runAutoExport）。
 *
 * 关掉自动导出时返回 null：那这条路一点开销都不加（不建 blob、不读文件）。
 */
async function autoExportHandle(s, fileName) {
  if (!s?.autoExport?.enabled || !fileName) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(fileName);
    const file = await handle.getFile();
    return {
      url: URL.createObjectURL(file),
      name: fileName,
      size: file.size,
      subdir: s.autoExport.subdir || '',
    };
  } catch (err) {
    // 建不出句柄不该影响产物本身（文件已经在 OPFS 里，用户手动导出照样能拿）
    console.info('[vh/mse] 自动导出：拿不到文件句柄', err?.message || err);
    return null;
  }
}

/**
 * 组装一次，**任何异常都转成返回值，绝不往外抛**。
 *
 * 这条链路上有四个调用点：收尾（用户点「停止并保存」）、先保存已录到的部分、
 * 滚动自动保存（定时器）、换集切分（边界事件）。后两个跑在后台 ——
 * 一个没接住的异常会把离屏文档这边的流程打断，会话停在"出错"，
 * 而用户手上那几十 MB 就再没有出口了（用户报过：暂停后点停止，34.7 MB 全没了）。
 *
 * 收尾那条路要**保住数据**（`crashed` 由调用方处理成"可重试"），
 * 后台那两条路**跳过这一次、绝不打断抓流**。
 */
async function safeAssemble(s) {
  try {
    return await assembleMseCapture(s);
  } catch (err) {
    console.error('[vh/mse] 组装失败：', err);
    return { ok: false, crashed: true, error: String(err?.message || err) };
  }
}

/**
 * 「先保存已录到的部分」：把**此刻**已经收到的缓冲写成一个文件，然后继续抓。
 *
 * 每次点都生成一个新文件（名字带 `-部分`），不清空缓冲 ——
 * 这样用户随时能拿走一份能播的，而抓流本身不受影响。
 */
async function mseSnapshot() {
  const s = mse;
  if (!s) return { ok: false, error: '当前没有在抓流' };
  if (!s.items.length) return { ok: false, error: '还没抓到任何数据，稍等几秒再试' };

  const built = await safeAssemble(s);
  if (!built.ok) return built;

  // 「先保存已录到的部分」每次写的是**当前整个缓冲**（不清空，抓流继续）。
  // 所以连着点两次、中间又没进来新数据时，第二份和前一份是**同一段内容** ——
  // 用户实测就这么白占了三份 56 MB。内容没变就不再重复写，直接说清楚。
  const writtenBytes = built.merged.byteLength;
  if (s.lastSnapshot && s.lastSnapshot.bytes === writtenBytes && s.lastSnapshot.chunks === s.items.length) {
    return {
      ok: false,
      identical: true,
      error: `和刚存的那份（${s.lastSnapshot.fileName}）内容完全一样，没有重复写。`
        + '想留一份新的，等再抓一会儿（有新的数据进来）再点。',
    };
  }

  // 「先保存已录到的部分」和「这个视频播完了」是两件不同的事，文件名也要分开：
  //   -部分    = 视频还没播完，用户要一份现在的快照（抓流继续攒同一个视频）
  //   -N       = 第 N 个视频播完了，这是一份**完整**的产物
  // 混用同一个序号会让"哪几个是完整视频"变得看不出来。
  const written = await saveBuilt(s, built, { partial: true });
  if (!written.ok) return written;
  s.lastSnapshot = { fileName: written.fileName, bytes: writtenBytes, chunks: s.items.length };

  return {
    ok: true,
    fileName: written.fileName,
    size: written.size,
    mediaSeconds: written.mediaSeconds,
    partial: true,
    // 用户明确点了「先保存已录到的部分」→ 这就是他此刻想要的那一份，一起自动导出
    autoExport: await autoExportHandle(s, written.fileName),
    compressedSeconds: written.finalized.compressedSeconds,
    // 组装阶段的提示也要带上（比如"复用了先前收到的初始化段"）——
    // 只带落盘阶段的话，这条路上用户看不到任何解释。
    warnings: [...built.warnings, ...written.finalized.warnings],
    detail: built.detail,
  };
}

/**
 * 收尾：把这一段的缓冲写成一个完整文件。
 *
 * ## 写不进去时**绝不清空缓冲**（用户报过的坑）
 *
 * 原来的写法一进来就 `mse = null`，之后才写盘。于是配额一满，用户等了
 * 四十分钟的抓流**连同缓冲一起没了**，界面上只有一句原始的 `QuotaExceededError`，
 * 连"重试"都没得点。现在改成：先合并、先写，**写成功了才收摊**；
 * 写失败就把字节留在 `s.pending` 里等用户清理空间后重试（见 `retryPending`）。
 *
 * 顺带一个好处：失败时可以把原始分块丢掉，只留合并好的那一份 ——
 * 用户清理空间的时候，内存占用反而降下来了。
 */
async function mseStop() {
  const s = mse;
  if (!s) return { ok: false, error: '没有正在进行的抓流' };

  // 上一次收尾失败（空间不够）之后的重试：字节还在，直接再写一次，
  // 不用重新合并（也就不会再多占一份内存）。
  if (s.pending) {
    const retry = await writeCaptureFile(s.pending.merged, s.pending.fileName, {
      ext: s.pending.ext,
      seconds: s.pending.seconds,
    });
    if (!retry.ok) return { ...retry, durationMs: Date.now() - s.startedAt, retry: true };
    return await finish(s, retry, {
      durationMs: Date.now() - s.startedAt,
      part: s.parts + 1,
      warnings: s.pending.warnings,
      detail: s.pending.detail,
    });
  }

  const durationMs = Date.now() - s.startedAt;
  if (!s.items.length) {
    releaseMse();
    return { ok: false, error: explainEmptyCapture(), durationMs };
  }

  // ## 合并阶段的异常**绝不能连数据一起丢掉**（用户报过：暂停后点停止，
  // 34.7 MB / 334 段全没了，只剩一句 muxer 的英文报错）
  //
  // 写盘失败那条路早就改成"保住数据、可重试、可放弃"，合并这条路原来没有：
  // `assembleMseCapture` 一抛异常就一路飘出去，会话停在出错状态，那些分块
  // 再也没有出口 —— 既写不出来，也重试不了。现在和写盘失败一个待遇：
  // **原始分块留在内存里**，返回 retryable，界面给「重试保存」和「放弃这一份」。
  const built = await safeAssemble(s);
  if (built.crashed) {
    s.assembleError = built.error;
    if (s.statsTimer) { clearInterval(s.statsTimer); s.statsTimer = null; }
    return {
      ok: false,
      retryable: true,
      awaitingRetry: true,
      // service worker 会把这两个数带进状态里，界面据此显示"这一份有多少、还没丢"
      bytes: s.bytes,
      chunks: s.items.length,
      error: `合并这一步失败了：${built.error}。这次抓到的 ${s.items.length} 段`
        + `（${formatBytes(s.bytes)}）**还在内存里，没有丢** —— 可以点「重试保存」再试一次，`
        + '或者点「放弃这一份」。在保住数据的期间请先别关这个浏览器。',
      durationMs,
    };
  }
  if (!built.ok) {
    // 走到这里是"内容本身没得合"（比如没抓到视频轨），不是崩溃 —— 重试也没用，
    // 所以如实说明之后释放会话。
    releaseMse();
    return { ...built, durationMs };
  }
  // 上一次合并失败、这一次成功了：把"等重试"的状态清掉，否则界面会一直挂着
  // 「重试保存 / 放弃这一份」这两个按钮。
  s.assembleError = null;

  const part = s.parts + 1;
  const written = await saveBuilt(s, built, { part });
  if (!written.ok) {
    // 保住数据：只留合并好的字节（分块可以丢了），并停掉心跳 ——
    // 否则心跳会继续上报"录制中"，把界面上的错误状态刷回去。
    s.pending = {
      merged: built.merged,
      fileName: written.fileName,
      ext: built.kind === 'webm' ? 'webm' : 'mp4',
      seconds: built.kind === 'webm' ? built.seconds : undefined,
      warnings: built.warnings,
      detail: built.detail,
    };
    s.items = [];
    s.bytes = 0;
    if (s.statsTimer) { clearInterval(s.statsTimer); s.statsTimer = null; }
    return { ...written, durationMs, part: s.parts, awaitingRetry: true };
  }
  s.parts = part;
  return await finish(s, written, { durationMs, part: s.parts, warnings: built.warnings, detail: built.detail });
}

/** 收尾成功：把会话收摊，返回给上层的回执 */
async function finish(s, written, extra = {}) {
  const warnings = [...(extra.warnings || [])];
  // 自动导出的句柄要**在 releaseMse 之前**建（它要用会话里的配置）
  const autoExport = await autoExportHandle(s, written.fileName);
  // 完整产物已经写出来了，滚动保存那份就是它的子集 —— 删掉，
  // 免得列表里留一个"比正式产物短"的重复文件让用户犯嘀咕。
  await dropAutoSnapshot();
  releaseMse();
  return {
    ok: true,
    fileName: written.fileName,
    size: written.size,
    // 挂钟：只用来解释"你花了多久"，不再冒充视频时长
    durationMs: extra.durationMs ?? null,
    mediaSeconds: written.mediaSeconds,
    part: extra.part ?? s.parts,
    // 这次会话里因为"攒得太大"自动切了几段 —— 收尾文案要据此如实说明
    // （不然用户会以为那几个文件是"换集切出来的"）
    sizeCuts: s.autoCut?.cuts ?? 0,
    compressedSeconds: written.finalized.compressedSeconds,
    targetKind: 'opfs',
    frames: 0,
    dropped: s.dropped,
    source: 'mse',
    // 有值时由 service worker 交给浏览器下载器（见 runAutoExport），
    // 并**等下载结束再关离屏文档**（blob 跟着这个文档活）
    autoExport,
    warnings: [...warnings, ...written.finalized.warnings],
    detail: extra.detail,
  };
}

/** 会话彻底结束 */
function releaseMse() {
  if (mse?.statsTimer) clearInterval(mse.statsTimer);
  if (mse?.snapshotTimer) clearInterval(mse.snapshotTimer);
  mse = null;
}

/**
 * 放弃这一份（用户不想再腾空间了）。
 *
 * 没有这个出口的话，一次写盘失败会**卡死后面所有抓流**：
 * `mseStart` 看到会话还在就会回"已经在抓流中"。
 */
function mseDiscard() {
  const s = mse;
  if (!s) return { ok: false, error: '没有正在进行的抓流' };
  const bytes = s.pending?.merged?.byteLength ?? s.bytes;
  const awaitingRetry = !!s.pending;
  releaseMse();
  return { ok: true, discardedBytes: bytes, awaitingRetry };
}

/**
 * 画面是 WebM 的流：封成一个 `.webm`（**零转码**，画面和 Opus 音频都是原字节）。
 *
 * 只负责"组装"，不落盘 —— 落盘统一由调用方走 `saveBuilt`（MP4/WebM 同一套）。
 */
function finishWebmCapture(s, ctx) {
  const { analyzed, webmVideoTracks, webmAudioTracks, reusedInit, reuseNotes, duplicates, warnings } = ctx;
  const video = webmVideoTracks[0];
  if (webmVideoTracks.length > 1) {
    warnings.push(`抓到了 ${webmVideoTracks.length} 条 WebM 画面轨，只用了最先出现的那一条`);
  }
  const audio = webmAudioTracks.find((t) => t.codec === 'opus' || t.codec === 'vorbis') || null;
  if (!audio && webmAudioTracks.length) {
    warnings.push(`音频是 ${webmAudioTracks[0].codecId}，WebM 装不了，这一路没合进去`);
  }
  if (webmAudioTracks.length > 1 && audio) {
    warnings.push(`WebM 里有 ${webmAudioTracks.length} 条音频轨，只取了第一条`);
  }

  let merged;
  try {
    merged = mergeWebm({
      video: {
        codecId: video.codecId,
        width: video.width,
        height: video.height,
        frames: video.frames,
      },
      audio: audio ? {
        codecId: audio.codecId,
        sampleRate: audio.sampleRate || 48000,
        channels: audio.channels || 2,
        frames: audio.frames,
      } : undefined,
      onWarning: (w) => warnings.push(w),
    });
  } catch (err) {
    return { ok: false, error: `WebM 封装失败：${err.message}` };
  }

  warnings.push('抓到的流本身就是 WebM（画面 VP8/VP9/AV1 + Opus 音频），所以产物是 .webm，'
    + '而且**一个字节都没有重新编码**');

  return {
    ok: true,
    kind: 'webm',
    merged,
    seconds: webmDurationSeconds(audio ? [video, audio] : [video]),
    warnings: [
      ...(reusedInit.length
        ? [`这份抓流中途播放器重建过缓冲区、或者自动切过段（那些组只补了分片），`
          + `初始化段用的是本次抓流里先前收到的那一份（${reusedInit.join('、')}）`]
        : []),
      ...reuseNotes,
      ...warnings,
    ],
    duplicates,
    detail: {
      chunks: s.items.length,
      duplicates,
      groups: groupDetail(analyzed),
      audioTranscode: null,
      // 这一路没有转码，直接告诉用户产物里是什么
      webmCodecs: [video.codecId, audio?.codecId].filter(Boolean),
    },
  };
}

/** 每一组都列出来（包括没被采纳的）：用户报"有画面没声音"时答案就在这里 */
function groupDetail(analyzed) {
  return analyzed.map((a) => ({
    mime: a.mime || '',
    sbId: a.sbId || '',
    container: a.container,
    contentType: a.contentType || '',
    codecType: a.codecType || '',
    trackSummary: a.trackSummary || '',
    init: a.init ? a.init.byteLength : 0,
    fragments: a.fragments ? a.fragments.byteLength : 0,
    bytes: a.bytes,
    error: a.error || '',
  }));
}

/* ------------------------------------------------------------------ *
 * 消息入口
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case MSG.OFFSCREEN_START:
      start(msg).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    case MSG.OFFSCREEN_STOP:
      stop().then(sendResponse, (err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    case MSG.OFFSCREEN_STATUS:
      sendResponse({
        ok: true,
        active: !!session || !!mse,
        mode: mse ? 'mse' : (session ? 'record' : null),
        stage: (session || mse) ? RECORD_STAGE.RECORDING : RECORD_STAGE.IDLE,
        stats: session ? session.recorder.stats() : mseStats(),
      });
      return false;
    case MSG.OFFSCREEN_MSE_START:
      sendResponse(mseStart(msg));
      return false;
    case MSG.MSE_BUFFER:
      sendResponse(mseBuffer(msg));
      return false;
    case MSG.OFFSCREEN_MSE_DISCARD:
      sendResponse(mseDiscard());
      return false;
    case MSG.OFFSCREEN_MSE_AUTOSNAP:
      sendResponse(setAutoSnapshot(msg));
      return false;
    case MSG.OFFSCREEN_MSE_SNAPSHOT:
      mseSnapshot().then(sendResponse, (err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    case MSG.OFFSCREEN_MSE_CUT:
      mseCut(msg?.reason).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    case MSG.OFFSCREEN_MSE_STOP:
      mseStop().then(sendResponse, (err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    default:
      return false;
  }
});

// 离屏文档没有界面，"页面没报错"并不能说明脚本真的跑起来了。
// 这个标志给自动化检查一个可观察的就绪信号，顺带也方便人工排查。
window.__vhOffscreenReady = true;
