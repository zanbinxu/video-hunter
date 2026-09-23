/**
 * 解析器页 —— 把「一个 m3u8 地址」变成「一个能播的 mp4」。
 *
 * 页面的状态机很直白：
 *   读取播放列表 → 是主列表就先选码率 → 得到媒体列表 → 下载 → 重封装 → 落盘
 *
 * 三个刻意的设计决定：
 *  1. **重活都放在这个页面上做**，不放进 service worker。SW 随时被杀，
 *     而这里是个真实的标签页，有 DOM、有大内存、还能用 File System Access API。
 *  2. **先要保存位置，再开始下载**。showSaveFilePicker 需要用户手势，
 *     所以它必须是点击处理函数里的第一个 await，不能被别的 await 挤掉。
 *  3. **写盘串行化**。mux.js 的回调是同步的，而写盘是异步的 ——
 *     必须用一条 promise 链把所有写入排好队，最后等它清空再 close()，
 *     否则会出现「文件写完了但最后几帧丢了」这种极难查的问题。
 */
import { MSG } from '../core/constants.js';
import { getSettings } from '../core/settings.js';
import { formatBytes } from '../core/classify.js';
import { parsePlaylist, selectVariant, describeVariant, variantHeight, summarize } from './hls.js';
import { createTsRemuxer, sniffContainer } from './remuxer.js';
import {
  createSegmentFetcher, downloadSegmentsInOrder, formatSpeed, formatEta,
} from './downloader.js';
import { createSink, suggestFileName, canStreamToDisk } from './saver.js';
import { runLivePolling } from './live.js';
import { mergeFmp4, parseInitSegment } from './mp4-merge.js';
import { splitSelfContainedFmp4, describeBoxTree, listInitTracks } from './fmp4-file.js';
import { concatChunks } from './mse-assemble.js';
import {
  parseMpd, selectRepresentations, describeRepresentation, summarizeMpd,
} from './dash.js';

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);

const state = {
  url: params.get('url') || '',
  referer: params.get('referer') || '',
  pageUrl: params.get('pageUrl') || '',
  title: params.get('title') || '',
  kind: params.get('kind') || '',
  mode: params.get('mode') || '',
  mergeJob: null,
  sourceTabId: Number(params.get('sourceTabId')) || null,
  selfTabId: null,
  settings: null,
  master: null,
  audioRendition: null,
  dash: null,
  dashVideo: null,
  dashAudio: null,
  playlist: null,
  variants: [],
  selectedVariant: null,
  running: false,
  controller: null,
  refererInstalled: false,
};

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload }).catch(() => null);
}

function log(text, cls = '') {
  const box = $('log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  box.appendChild(line);
  // 直播能跑几个小时，日志必须有上限 —— 否则这个 div 会一直在长，
  // 而且是纯文本节点，涨到几万行之后页面会明显变卡。
  while (box.childElementCount > 400) box.removeChild(box.firstElementChild);
  box.scrollTop = box.scrollHeight;
}

function showNotice(kind, title, bodyHtml) {
  const box = $('notice');
  box.className = `notice ${kind}`;
  box.textContent = '';
  const head = document.createElement('b');
  head.textContent = title;
  box.appendChild(head);
  if (bodyHtml) {
    const p = document.createElement('div');
    // 只用于我们自己写的固定文案，不掺外部数据
    p.innerHTML = bodyHtml;
    box.appendChild(p);
  }
  box.hidden = false;
}

/**
 * 由 renderPlan 管理的提示条。
 *
 * 需要区分「谁写的这条提示」：切换码率时要把上一次关于音轨的警告撤掉，
 * 但不能顺手把「读取播放列表失败」那种真正的错误也擦掉。
 * 所以用 data-from 打个来源标记。
 */
function setPlanNotice(kind, title, bodyHtml) {
  const box = $('notice');
  if (!kind) {
    if (box.dataset.from === 'plan') {
      box.hidden = true;
      delete box.dataset.from;
    }
    return;
  }
  showNotice(kind, title, bodyHtml);
  box.dataset.from = 'plan';
}

function setStateBody(text) {
  $('state-body').textContent = text;
}

/** 标签页自己的 tabId —— 用来挂 Referer 会话规则 */
async function getSelfTabId() {
  try {
    const tab = await chrome.tabs.getCurrent();
    return tab?.id ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 抓文本：先自己抓，不行就借源页面的上下文
 * ------------------------------------------------------------------ */

async function fetchText(url) {
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (!state.sourceTabId) throw err;
    log(`本页直接抓取失败（${err.message}），改用源页面上下文重试…`);
    const r = await send(MSG.FETCH_RESOURCE, { tabId: state.sourceTabId, url });
    if (r?.ok && typeof r.text === 'string') {
      log('源页面上下文抓取成功', 'ok');
      return r.text;
    }
    throw new Error(`两种方式都失败了 —— 本页：${err.message}；源页面：${r?.error || '不可用'}`);
  }
}

/* ------------------------------------------------------------------ *
 * 读取与渲染
 * ------------------------------------------------------------------ */

async function loadPlaylist(url, { quiet = false } = {}) {
  if (!quiet) setStateBody('正在读取播放列表…');
  $('source-url').textContent = url;
  $('source-url').title = url;

  const text = await fetchText(url);

  // DASH 和 HLS 是两套完全不同的清单格式，先分流再解析 ——
  // 把一份 MPD 喂给 m3u8 解析器只会得到「缺少 #EXTM3U」这种误导性的报错。
  if (looksLikeDash(url)) {
    loadDashText(text, url);
    return;
  }

  const pl = parsePlaylist(text, url);

  if (!pl.ok) throw new Error(pl.error);

  if (pl.drm) {
    renderDrm(pl);
    return;
  }

  const info = summarize(pl);
  if (pl.isMaster) {
    state.master = pl;
    state.variants = pl.variants.filter((v) => !v.iframe && v.uri);
    setStateBody(`主播放列表 · ${info.text} · ${info.tags.join(' · ')}`);
    renderVariants(pl);
  } else {
    state.playlist = pl;
    state.playlistUrl = url;
    setStateBody(`媒体播放列表 · ${info.text} · ${info.tags.join(' · ')}`);
    // 注意：这里**不隐藏**码率列表。当用户是从主列表选了一个码率进来的，
    // 把列表藏掉就等于「选完就改不了了」—— 而选错码率想换一档是很常见的操作。
    renderPlan(pl, url);
  }
}

function renderDrm(pl) {
  const name = pl.drm?.drm || pl.drm?.keyFormat || '未知';
  setStateBody(`检测到 DRM 保护（${name}）`);
  $('card-plan').hidden = true;
  $('card-variants').hidden = true;
  showNotice('err', `这个流受 DRM 保护（${name}），无法下载`, [
    '这不是「加密」，是**数字版权管理**：解密密钥在浏览器的 CDM 黑盒里，',
    '连播放页面自己的 JavaScript 都拿不到，扩展程序更拿不到。',
    '所以这一条不是「本工具还没实现」，而是**在浏览器里做不到**。',
    '<br /><br />',
    '如果这个视频你有权保存，可行的办法是用屏幕录制；',
    '但对受保护内容，系统级的硬件保护路径通常会让录到的画面变黑。',
  ].join(''));
}

function renderVariants(pl) {
  const box = $('variants');
  box.textContent = '';
  $('card-variants').hidden = false;

  const preferred = state.settings?.preferredQuality || 'auto';
  const list = [...state.variants].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  const auto = selectVariant(list, preferred);

  for (const v of list) {
    const btn = document.createElement('button');
    btn.className = 'variant';
    btn.type = 'button';

    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.textContent = v === auto ? '✓' : '';

    const res = document.createElement('span');
    res.className = 'res';
    const h = variantHeight(v);
    res.textContent = h ? `${h}p` : '—';

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = describeVariant(v);

    btn.append(tick, res, meta);

    if (v === auto) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = preferred === 'auto' ? '默认（最高）' : '默认';
      btn.append(tag);
    }

    btn.addEventListener('click', () => chooseVariant(v, btn));
    box.append(btn);
  }

  if (auto) chooseVariant(auto, box.children[list.indexOf(auto)]);
}

async function chooseVariant(variant, btnEl) {
  state.selectedVariant = variant;
  state.audioRendition = findAudioRendition(state.master, variant);
  for (const el of $('variants').children) el.classList.toggle('is-selected', el === btnEl);
  try {
    await loadPlaylist(variant.uri, { quiet: true });
  } catch (err) {
    showNotice('err', '读取该码率的播放列表失败', String(err?.message || err));
  }
}

/**
 * 找出这个码率对应的独立音轨。
 *
 * HLS 允许把音频单独拆成一条流（`#EXT-X-MEDIA:TYPE=AUDIO`），
 * 码率条目上用 `AUDIO="组名"` 指过去。这种情况下视频播放列表里**只有视频**，
 * 不下音轨的话产物就是默片 —— Apple 的公开测试流就是这样。
 */
function findAudioRendition(master, variant) {
  if (!master?.renditions?.length || !variant?.audioGroup) return null;
  const candidates = master.renditions.filter(
    (r) => r.type === 'AUDIO' && r.groupId === variant.audioGroup && r.uri,
  );
  if (!candidates.length) return null;
  return candidates.find((r) => r.isDefault) || candidates[0];
}

function renderPlan(pl, url) {
  $('card-plan').hidden = false;

  const settings = state.settings || {};
  const live = isLivePlaylist(pl);
  const isFmp4 = !!pl.map;

  $('opt-concurrency').value = settings.concurrency ?? 6;
  $('opt-retries').value = settings.retries ?? 3;

  const streamSupported = canStreamToDisk();
  const streamBox = $('opt-stream');
  streamBox.checked = streamSupported && settings.streamingSave !== false;
  streamBox.disabled = !streamSupported;
  // ⚠️ 这条提示原来一律写「推荐：分片边下边写，内存占用恒定」——**只有 fMP4 直播**
  // 真的是边收边写。点播（HLS / DASH / 独立轨道合并）都必须先收齐、最后统一
  // 交给 mergeFmp4 组装成带索引的普通 MP4（否则 mvhd 时长是 0xFFFFFFFF，进度条废掉，
  // 见下面 startDownload 里那段注释）。开关本身在点播里仍然有用：它决定最终产物是
  // 流式写盘还是先在内存里攒（峰值内存差别很大），所以留着重写文案，不删开关。
  const streamsLive = live && isFmp4;
  $('stream-hint').textContent = !streamSupported
    ? '（当前浏览器不支持 File System Access，只能攒内存）'
    : (streamsLive
      ? '（推荐：分片边下边写，内存占用恒定）'
      : '（这条路要先收齐再组装成带索引的 MP4，不能边下边写；开关只决定最终产物怎么写出）');

  // 直播的表单含义和点播不一样，标题和按钮都得跟着变
  $('card-plan').querySelector('.card-title').textContent = live ? '直播录制设置' : '下载设置';
  $('start').textContent = live ? '开始录制直播' : '开始下载';

  const box = $('plan-summary');
  box.textContent = '';
  const lines = live
    ? [
      ['窗口内分片', `${pl.segments.length} 个（直播，列表会持续变化）`],
      ['已播时长', `窗口约 ${Math.round(pl.totalDuration)} 秒`],
      ['容器', isFmp4 ? 'fMP4' : 'MPEG-TS（将重封装为 MP4）'],
      ['加密', pl.encryption?.method === 'AES-128' ? 'AES-128（会自动解密）' : '未加密'],
    ]
    : [
      ['分片数量', `${pl.segments.length} 个`],
      ['总时长', `约 ${Math.round(pl.totalDuration)} 秒（${(pl.totalDuration / 60).toFixed(1)} 分钟）`],
      ['容器', isFmp4 ? 'fMP4（直接拼接，无需重封装）' : 'MPEG-TS（将重封装为 MP4）'],
      ['加密', pl.encryption?.method === 'AES-128' ? 'AES-128（会自动解密）' : '未加密'],
    ];
  for (const [k, v] of lines) {
    const row = document.createElement('div');
    const strong = document.createElement('b');
    strong.textContent = v;
    row.append(document.createTextNode(`${k}：`), strong);
    box.append(row);
  }

  // 音视频分离：视频列表里没有音轨，音频在另一条流里
  const rend = state.audioRendition;
  if (rend) {
    const row = document.createElement('div');
    const strong = document.createElement('b');
    strong.textContent = `独立的音频流（组 ${rend.groupId}${rend.name ? ' · ' + rend.name : ''}）`;
    row.append(document.createTextNode('音轨：'), strong);
    box.append(row);

    setPlanNotice('info', '这个流把音频单独拆成了一条流', [
      '视频播放列表里只有视频轨，音频在独立的音轨里（<code>AUDIO="' + rend.groupId + '"</code>）。',
      '<br /><br />',
      '下载时会<b>两路都取下来再合并</b>成一个 MP4。',
      '代价是这条路<b>不能边下边存</b> —— 合并要求同时拿到两边的样本，所以两路会先收在内存里，',
      '特别长的视频请留意内存占用。',
    ].join(''));
  } else {
    setPlanNotice(null);
  }

  const note = document.createElement('div');
  note.style.marginTop = '8px';
  note.style.color = 'var(--faint)';
  note.textContent = live
    ? '这是直播流（播放列表没有 #EXT-X-ENDLIST）：会反复拉取播放列表，只下载没见过的新分片，'
      + '一直录到你点「停止」。如果拉取速度跟不上分片的过期速度，中间会漏片 —— 漏了多少会如实显示，不会假装连续。'
    : '产物是**标准 MP4**（带完整样本表），Chrome / VLC / PotPlayer / ffmpeg 都能直接播，也拖得动进度条。';
  box.append(note);
}

/** 直播的判据：媒体播放列表、没有 #EXT-X-ENDLIST、而且有分片 */
function isLivePlaylist(pl) {
  return !!pl && !pl.isMaster && !pl.endList && pl.segments.length > 0;
}

/* ------------------------------------------------------------------ *
 * 进度
 * ------------------------------------------------------------------ */

function paintProgress({ completed, total, bytes }, startedAt) {
  const percent = total ? (completed / total) * 100 : 0;
  $('bar-fill').style.width = `${percent.toFixed(1)}%`;
  $('stat-percent').textContent = `${percent.toFixed(1)}%`;
  $('stat-count').textContent = `${completed} / ${total} 分片`;
  $('stat-bytes').textContent = formatBytes(bytes);

  const elapsed = (Date.now() - startedAt) / 1000;
  if (elapsed > 0.5 && bytes > 0) {
    const speed = bytes / elapsed;
    $('stat-speed').textContent = formatSpeed(speed);
    if (completed > 0 && total > 0) {
      const remaining = total - completed;
      const perSegment = bytes / completed;
      $('stat-eta').textContent = `剩余 ${formatEta((remaining * perSegment) / speed)}`;
    }
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function startDownload() {
  if (state.running) return;
  if (state.mergeJob) return startMergeDownload();
  if (state.dash) return startDashDownload();
  const pl = state.playlist;
  if (!pl) {
    showNotice('warn', '还没有可下载的媒体列表', '先在上面选一个码率。');
    return;
  }
  if (isLivePlaylist(pl)) return startLive();

  const settings = state.settings || {};

  // showSaveFilePicker 要在用户手势还有效时调用，所以这里是第一个 await
  let sink;
  try {
    sink = await createSink({
      fileName: suggestFileName(state.title || '', 'mp4'),
      mode: settings.streamingSave === false ? 'memory' : 'auto',
    });
  } catch (err) {
    showNotice('err', '无法创建保存目标', String(err?.message || err));
    return;
  }
  if (sink?.cancelled) {
    log('用户取消了保存对话框，未开始下载');
    return;
  }

  state.running = true;
  state.controller = new AbortController();
  const signal = state.controller.signal;
  $('start').disabled = true;
  $('cancel').hidden = false;
  resetProgressUi({ live: false });
  // 码率列表留着不动 —— 下载中不该还能换档，但停掉之后用户能接着换

  log('保存方式：先收齐再组装（产物是带索引的普通 MP4，播放器才能拖进度条）');

  const isFmp4 = !!pl.map;
  const startedAt = Date.now();

  try {
    // 音视频分离的流走另一条路：不能边下边写，必须两路都收齐再合并
    if (state.audioRendition) {
      await startMergedDownload(sink, settings, signal, startedAt);
      const closed = await sink.close();
      if (!closed?.ok) throw new Error(closed?.error || '写入收尾失败');
      $('bar-fill').style.width = '100%';
      $('stat-percent').textContent = '100%';
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      log(`完成：${formatBytes(sink.bytesWritten)}，用时 ${elapsed} 秒`, 'ok');
      log(`落盘方式：${closed.via}`, 'ok');
      showNotice('ok', '下载完成（音视频已合并）', '视频轨和音轨已经合成一个文件。');
      return;
    }

    const fetchSegment = createSegmentFetcher({
      mediaSequence: pl.mediaSequence,
      signal,
      onKeyRecovered: keyRecoveryReporter(),
    });

    // ---- 先把数据收齐，最后统一组装成**普通 MP4** ----
    //
    // 这里**不能边下边写**，原因值得记住：
    // mux.js 输出的是**分片式 MP4**，它的 mvhd 时长写着 0xFFFFFFFF ——
    // 那是"时长未知"的哨兵值，而且没有 sidx / mfra 索引。
    // 播放器会以为文件有十几小时那么长：实测一个 12 秒的文件被认成 47721 秒，
    // 进度条按 13 小时铺开，用户怎么拖都对不上，只能跳回去。
    //
    // 所以统一交给 mergeFmp4 —— 它产出带完整样本表（stts/stsz/stco/stss）的
    // 普通 MP4，时长也是对的。抓流和 DASH 合并走的一直是这条路。
    const fragments = [];
    let initSegment = null;
    let remuxer = null;

    if (isFmp4) {
      log('fMP4 流：取初始化段，然后按序收分片');
      initSegment = await fetchSegment({ uri: pl.map.uri, byteRange: pl.map.byteRange }, -1);
      log(`初始化段 ${formatBytes(initSegment.byteLength)}`);
    } else {
      if (!window.muxjs?.mp4?.Transmuxer) {
        throw new Error('mux.js 没有加载（vendor/mux.min.js 缺失或被 CSP 拦了）');
      }
      remuxer = createTsRemuxer(window.muxjs, {
        onFragment: (b) => fragments.push(b),
      });
    }

    let sawFirst = false;
    for await (const { index, data } of downloadSegmentsInOrder(pl.segments, {
      concurrency: Math.max(1, Math.min(16, Number(settings.concurrency) || 6)),
      retries: Math.max(0, Math.min(8, Number(settings.retries) || 3)),
      signal,
      fetchSegment,
      onProgress: (p) => paintProgress(p, startedAt),
    })) {
      if (!sawFirst) {
        sawFirst = true;
        const kind = sniffContainer(data);
        const expected = remuxer ? 'mpegts' : 'fmp4';
        if (kind !== expected) {
          throw new Error(`第 1 个分片的容器是 ${kind}，与播放列表声明的 ${expected} 不符`);
        }
        log(`首个分片容器判定：${kind}（${formatBytes(data.byteLength)}）`);
      }

      if (remuxer) remuxer.append(data);
      else fragments.push(data);
    }

    if (remuxer) {
      remuxer.end();
      if (!remuxer.initSegment) throw new Error('重封装没有产出初始化段 —— 分片可能不是有效的 MPEG-TS');
      initSegment = remuxer.initSegment;
      log(`重封装完成：${remuxer.fragmentCount} 个分片，${formatBytes(remuxer.byteLength)}`, 'ok');
      const errs = remuxer.errors;
      if (errs.length) log(`mux.js 报告了 ${errs.length} 条错误：${errs.slice(0, 3).join('; ')}`, 'err');
    }

    const handlers = listInitTracks(initSegment);
    log(`这条流里有：${handlers.join(' + ') || '（识别不出轨道）'}`);
    const collect = { init: initSegment, segments: [concatChunks(fragments)] };
    const mergeInput = {};
    // 复用的 TS 流里音视频在同一条轨上 —— 同一份数据两边都喂进去，
    // 合并器各自只抽自己那条 trak 的样本（mp4-merge 支持这种用法）
    if (handlers.includes('video')) mergeInput.video = collect;
    if (handlers.includes('audio')) mergeInput.audio = collect;
    if (!mergeInput.video && !mergeInput.audio) {
      throw new Error(`这条流里没有可用的轨道（识别结果：${handlers.join('、') || '空'}）`);
    }

    log('正在组装成带索引的 MP4（这样播放器才能拖进度条）…');
    const merged = mergeFmp4(mergeInput, {
      onWarning: (w) => log(`合并提示：${typeof w === 'string' ? w : (w?.message || JSON.stringify(w))}`),
    });
    await sink.write(merged);

    const closed = await sink.close();
    if (!closed?.ok) throw new Error(closed?.error || '写入收尾失败');

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const avg = elapsed > 0 ? sink.bytesWritten / Number(elapsed) : 0;
    $('bar-fill').style.width = '100%';
    $('stat-percent').textContent = '100%';
    log(`完成：${formatBytes(sink.bytesWritten)}，用时 ${elapsed} 秒，平均 ${formatSpeed(avg)}`, 'ok');
    log(`落盘方式：${closed.via}`, 'ok');
    showNotice('ok', '下载完成', '文件已保存，可以正常拖动进度条。');
  } catch (err) {
    const message = String(err?.message || err);
    if (signal.aborted) {
      log('已取消', 'err');
      showNotice('warn', '已取消', '已写入的部分可能是不完整的文件。');
    } else {
      log(`失败：${message}`, 'err');
      showNotice('err', '下载失败', message);
    }
    try { await sink.close(); } catch { /* 收尾失败无所谓，主错误已经报出去了 */ }
  } finally {
    state.running = false;
    state.controller = null;
    $('start').disabled = false;
    $('cancel').hidden = true;
  }
}

/**
 * 密钥不是标准 16 字节、但被自动识别出来时的上报。
 *
 * 这件事必须让用户看见：他本来会拿到一个"密钥长度不对"的失败，
 * 而实际上工具已经替他解决了 —— 不吭声的话，下次遇到真解决不了的，
 * 他就分不清是哪种情况了。
 */
function keyRecoveryReporter() {
  let reported = false;
  return (info) => {
    if (reported) return;
    reported = true;
    log(`密钥响应不是标准的 16 字节（实际 ${info.bytes} 字节`
      + `${info.contentType ? '，' + info.contentType : ''}），`
      + `已自动识别为「${info.label}」（试了 ${info.tried} 种解读）`, 'ok');
    log(`  密钥地址：${info.uri}`);
  };
}

/* ------------------------------------------------------------------ *
 * 音视频分离的流：两路都下完再合并
 *
 * 这条路径和普通下载有个本质区别：**没法边下边写**。
 * 合并要求同时拿到两边的样本，才能按时间戳交错排布。
 * 所以这里必须把两路都收在内存里 —— 代价写在日志里，不藏着。
 * ------------------------------------------------------------------ */

/**
 * 把一路媒体列表收成一个 fMP4（init + 分片数组）。
 * 是 TS 就重封装，已经是 fMP4（带 #EXT-X-MAP）就直接收集。
 */
async function collectTrack(playlist, { fetchSegment, settings, signal, label, onProgress }) {
  let bytes = 0;
  if (playlist.map) {
    const init = await fetchSegment({ uri: playlist.map.uri, byteRange: playlist.map.byteRange }, -1);
    bytes += init.byteLength;
    const segments = [];
    let done = 0;
    for await (const { data } of downloadSegmentsInOrder(playlist.segments, {
      concurrency: Math.max(1, Math.min(16, Number(settings.concurrency) || 6)),
      retries: Math.max(0, Math.min(8, Number(settings.retries) || 3)),
      signal,
      fetchSegment,
    })) {
      segments.push(data);
      bytes += data.byteLength;
      done += 1;
      onProgress?.({ done, total: playlist.segments.length, label, bytes });
    }
    return { init, segments, bytes };
  }

  if (!window.muxjs?.mp4?.Transmuxer) {
    throw new Error('mux.js 没有加载（vendor/mux.min.js 缺失或被 CSP 拦了）');
  }
  const fragments = [];
  const remuxer = createTsRemuxer(window.muxjs, {
    onFragment: (b) => fragments.push(b),
  });
  let done = 0;
  for await (const { data } of downloadSegmentsInOrder(playlist.segments, {
    concurrency: Math.max(1, Math.min(16, Number(settings.concurrency) || 6)),
    retries: Math.max(0, Math.min(8, Number(settings.retries) || 3)),
    signal,
    fetchSegment,
  })) {
    remuxer.append(data);
    bytes += data.byteLength;
    done += 1;
    onProgress?.({ done, total: playlist.segments.length, label, bytes });
  }
  remuxer.end();

  if (!remuxer.initSegment) {
    throw new Error(`${label}没有产出初始化段 —— 分片可能不是有效的 MPEG-TS`);
  }
  return { init: remuxer.initSegment, segments: fragments, bytes };
}

async function startMergedDownload(sink, settings, signal, startedAt) {
  const videoPlaylist = state.playlist;
  const audioUrl = state.audioRendition.uri;

  log(`音轨地址：${audioUrl}`);
  const audioText = await fetchText(audioUrl);
  const audioPlaylist = parsePlaylist(audioText, audioUrl);
  if (!audioPlaylist.ok) throw new Error(`音轨播放列表解析失败：${audioPlaylist.error}`);
  if (audioPlaylist.drm) throw new Error(`音轨受 DRM 保护（${audioPlaylist.drm.drm}），无法处理`);

  const total = videoPlaylist.segments.length + audioPlaylist.segments.length;
  let finished = 0;
  let baseBytes = 0;
  const onProgress = ({ done, total: t, label, bytes }) => {
    const overall = finished + done;
    const pct = (overall / total) * 100;
    $('bar-fill').style.width = `${pct.toFixed(1)}%`;
    $('stat-percent').textContent = `${pct.toFixed(1)}%`;
    $('stat-count').textContent = `${label} ${done}/${t} 片`;
    $('stat-bytes').textContent = formatBytes(baseBytes + bytes);
    const elapsed = (Date.now() - startedAt) / 1000;
    if (elapsed > 0.5 && baseBytes + bytes > 0) {
      $('stat-speed').textContent = formatSpeed((baseBytes + bytes) / elapsed);
    }
    $('stat-eta').textContent = '合并模式（两路都下完才写盘）';
  };

  log(`音轨 ${audioPlaylist.segments.length} 片 / 约 ${Math.round(audioPlaylist.totalDuration)} 秒`
    + `｜视频 ${videoPlaylist.segments.length} 片 / 约 ${Math.round(videoPlaylist.totalDuration)} 秒`);

  // 先下音轨：它通常比视频小一个数量级，先落在内存里不心疼
  const audio = await collectTrack(audioPlaylist, {
    fetchSegment: createSegmentFetcher({ mediaSequence: audioPlaylist.mediaSequence, signal, onKeyRecovered: keyRecoveryReporter() }),
    settings, signal, label: '音轨', onProgress,
  });
  finished += audioPlaylist.segments.length;
  baseBytes = audio.bytes;

  const video = await collectTrack(videoPlaylist, {
    fetchSegment: createSegmentFetcher({ mediaSequence: videoPlaylist.mediaSequence, signal, onKeyRecovered: keyRecoveryReporter() }),
    settings, signal, label: '视频', onProgress,
  });

  const heldBytes = video.bytes + audio.bytes;
  log(`两路共 ${formatBytes(heldBytes)} 已收在内存里，开始合并…`);

  const merged = mergeFmp4({ video, audio });
  log(`合并完成：${formatBytes(merged.byteLength)}，写入文件…`, 'ok');
  await sink.write(merged);
}

/* ------------------------------------------------------------------ *
 * DASH
 *
 * 和 HLS 的区别不只是清单格式：DASH 常态就是**视频轨和音频轨各自独立**
 * （两条 AdaptationSet），所以下载路径天生就要走「两路收齐再合并」，
 * 复用 HLS 分离音轨那条路。
 * ------------------------------------------------------------------ */

function looksLikeDash(url) {
  return /\.mpd(\?|#|$)/i.test(String(url)) || state.kind === 'dash';
}

function loadDashText(text, url) {
  const parsed = parseMpd(text, url);
  if (!parsed.ok) throw new Error(parsed.error || 'MPD 解析失败');

  state.dash = parsed;
  state.playlist = null;

  const info = summarizeMpd(parsed);
  setStateBody(`DASH 清单 · ${info.text} · ${info.tags.join(' · ')}`);

  if (parsed.drm) {
    renderDashDrm(parsed);
    return;
  }

  state.dashVideo = selectRepresentations(parsed, {
    preferredQuality: state.settings?.preferredQuality || 'auto',
  }).video;
  state.dashAudio = selectRepresentations(parsed, {}).audio;

  renderDashVariants(parsed);
  renderDashPlan(parsed);
}

function renderDashDrm(parsed) {
  const name = parsed.drm?.drm || parsed.drm?.keyFormat || '未知';
  $('card-plan').hidden = true;
  $('card-variants').hidden = true;
  showNotice('err', `这个 DASH 流受 DRM 保护（${name}），无法下载`, [
    'DASH 的 DRM 走的是同一套 CDM 黑盒，密钥不会交给页面 JavaScript。',
    '这不是「本工具还没实现」，而是在浏览器里做不到。',
  ].join(''));
}

function renderDashVariants(parsed) {
  const box = $('variants');
  box.textContent = '';
  const videos = (parsed.representations || [])
    .filter((r) => r.contentType === 'video')
    .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  if (!videos.length) {
    $('card-variants').hidden = true;
    return;
  }
  $('card-variants').hidden = false;

  for (const rep of videos) {
    const btn = document.createElement('button');
    btn.className = 'variant';
    btn.type = 'button';

    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.textContent = rep === state.dashVideo ? '✓' : '';

    const res = document.createElement('span');
    res.className = 'res';
    res.textContent = rep.height ? `${rep.height}p` : (rep.width ? `${rep.width}px` : '—');

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = describeRepresentation(rep);

    btn.append(tick, res, meta);
    btn.addEventListener('click', () => {
      state.dashVideo = rep;
      for (const el of box.children) el.classList.toggle('is-selected', el === btn);
      renderDashPlan(parsed);
    });
    box.append(btn);
    if (rep === state.dashVideo) btn.classList.add('is-selected');
  }
}

function renderDashPlan(parsed) {
  $('card-plan').hidden = false;
  $('card-plan').querySelector('.card-title').textContent = '下载设置';
  $('start').textContent = '开始下载';

  const settings = state.settings || {};
  $('opt-concurrency').value = settings.concurrency ?? 6;
  $('opt-retries').value = settings.retries ?? 3;
  const streamSupported = canStreamToDisk();
  $('opt-stream').checked = streamSupported && settings.streamingSave !== false;
  $('opt-stream').disabled = !streamSupported;
  $('stream-hint').textContent = streamSupported ? '（推荐）' : '（当前浏览器不支持）';

  const v = state.dashVideo;
  const a = state.dashAudio;
  const box = $('plan-summary');
  box.textContent = '';

  const rows = [
    ['视频轨', v ? `${describeRepresentation(v)}（${v.segmentUrls.length} 片）` : '没有找到'],
    ['音频轨', a ? `${describeRepresentation(a)}（${a.segmentUrls.length} 片）` : '没有独立音频轨'],
    ['时长', parsed.duration ? `约 ${Math.round(parsed.duration)} 秒` : '未声明'],
    ['容器', 'fMP4（fragment MP4）'],
  ];
  for (const [k, val] of rows) {
    const row = document.createElement('div');
    const strong = document.createElement('b');
    strong.textContent = val;
    row.append(document.createTextNode(`${k}：`), strong);
    box.append(row);
  }

  const note = document.createElement('div');
  note.style.marginTop = '8px';
  note.style.color = 'var(--faint)';
  note.textContent = v && v.segmentBase
    ? '警告：这条轨用的是 SegmentBase（单文件 + Range），当前版本不会发 Range 请求，可能下不下来。'
    : 'DASH 的音视频天然是分开的两路：两路都下完之后合并成一个标准 MP4。'
      + '因此这条路不能边下边存，两路会先收在内存里。';
  box.append(note);

  setPlanNotice(null);
}

/**
 * 收一路 DASH Representation（初始化段 + 分片）。
 * 数据结构转成下载器认的 { uri } 形状，复用同一套并发/重试逻辑。
 */
async function collectDashTrack(rep, { fetchSegment, settings, signal, label, onProgress }) {
  if (!rep) return null;
  if (rep.segmentBase) {
    throw new Error(`${label}用的是 SegmentBase（单文件 + Range），当前版本不支持`);
  }
  if (!rep.initUrl) {
    throw new Error(`${label}没有初始化段地址，无法重封装`);
  }

  let bytes = 0;
  const init = await fetchSegment({ uri: rep.initUrl }, -1);
  bytes += init.byteLength;

  const items = rep.segmentUrls.map((u) => ({ uri: u }));
  const segments = [];
  let done = 0;
  for await (const { data } of downloadSegmentsInOrder(items, {
    concurrency: Math.max(1, Math.min(16, Number(settings.concurrency) || 6)),
    retries: Math.max(0, Math.min(8, Number(settings.retries) || 3)),
    signal,
    fetchSegment,
  })) {
    segments.push(data);
    bytes += data.byteLength;
    done += 1;
    onProgress?.({ done, total: items.length, label, bytes });
  }
  return { init, segments, bytes };
}

async function startDashDownload() {
  if (state.running) return;
  const parsed = state.dash;
  const videoRep = state.dashVideo;
  const audioRep = state.dashAudio;
  if (!videoRep) {
    showNotice('warn', '没有可下载的视频轨', '这条 DASH 清单里没找到视频 Representation。');
    return;
  }

  const settings = state.settings || {};
  let sink;
  try {
    sink = await createSink({
      fileName: suggestFileName(state.title || '', 'mp4'),
      mode: settings.streamingSave === false ? 'memory' : 'auto',
    });
  } catch (err) {
    showNotice('err', '无法创建保存目标', String(err?.message || err));
    return;
  }
  if (sink?.cancelled) { log('用户取消了保存对话框，未开始下载'); return; }

  state.running = true;
  state.controller = new AbortController();
  const signal = state.controller.signal;
  $('start').disabled = true;
  $('cancel').hidden = false;
  resetProgressUi({ live: false });

  const startedAt = Date.now();
  try {
    const fetchSegment = createSegmentFetcher({ signal, onKeyRecovered: keyRecoveryReporter() });
    const vTotal = videoRep.segmentUrls.length;
    const aTotal = audioRep ? audioRep.segmentUrls.length : 0;
    let finished = 0;
    let baseBytes = 0;

    const onProgress = ({ done, total, label, bytes }) => {
      const overall = finished + done;
      const grand = vTotal + aTotal || 1;
      const pct = (overall / grand) * 100;
      $('bar-fill').style.width = `${pct.toFixed(1)}%`;
      $('stat-percent').textContent = `${pct.toFixed(1)}%`;
      $('stat-count').textContent = `${label} ${done}/${total} 片`;
      $('stat-bytes').textContent = formatBytes(baseBytes + bytes);
      const elapsed = (Date.now() - startedAt) / 1000;
      if (elapsed > 0.5 && baseBytes + bytes > 0) {
        $('stat-speed').textContent = formatSpeed((baseBytes + bytes) / elapsed);
      }
      $('stat-eta').textContent = '合并模式（两路都下完才写盘）';
    };

    log(`视频轨 ${describeRepresentation(videoRep)}（${vTotal} 片）`);
    if (audioRep) log(`音频轨 ${describeRepresentation(audioRep)}（${aTotal} 片）`);

    // 音频通常小得多，先下它
    const audio = audioRep
      ? await collectDashTrack(audioRep, { fetchSegment, settings, signal, label: '音频', onProgress })
      : null;
    if (audioRep) { finished += aTotal; baseBytes = audio?.bytes || 0; }

    const video = await collectDashTrack(videoRep, {
      fetchSegment, settings, signal, label: '视频', onProgress,
    });

    const held = (video?.bytes || 0) + (audio?.bytes || 0);
    log(`两路共 ${formatBytes(held)} 已收在内存里，开始合并…`);

    const merged = mergeFmp4({
      video: video ? { init: video.init, segments: video.segments } : undefined,
      audio: audio ? { init: audio.init, segments: audio.segments } : undefined,
    }, {
      // 合并器发现的异常（分片被跳过、时间戳重叠）如实打到日志里，不吞
      onWarning: (w) => log(`合并提示：${typeof w === 'string' ? w : (w?.message || JSON.stringify(w))}`),
    });

    log(`合并完成：${formatBytes(merged.byteLength)}，写入文件…`, 'ok');
    await sink.write(merged);

    const closed = await sink.close();
    if (!closed?.ok) throw new Error(closed?.error || '写入收尾失败');
    $('bar-fill').style.width = '100%';
    $('stat-percent').textContent = '100%';
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(`完成：${formatBytes(sink.bytesWritten)}，用时 ${elapsed} 秒`, 'ok');
    log(`落盘方式：${closed.via}`, 'ok');
    showNotice('ok', '下载完成（音视频已合并）', 'DASH 的视频轨和音频轨已经合成一个标准 MP4。');
  } catch (err) {
    const message = String(err?.message || err);
    if (signal.aborted) {
      log('已取消', 'err');
      showNotice('warn', '已取消', '已写入的部分可能是不完整的文件。');
    } else {
      log(`失败：${message}`, 'err');
      showNotice('err', '下载失败', message);
    }
    try { await sink.close(); } catch { /* 主错误已经报出去了 */ }
  } finally {
    state.running = false;
    state.controller = null;
    $('start').disabled = false;
    $('cancel').hidden = true;
  }
}

/* ------------------------------------------------------------------ *
 * 直播录制
 *
 * 和点播的差别只在「播放列表会不会变」：这里不下载一个固定的分片列表，
 * 而是反复拉取播放列表、每次只下没见过的新分片，一直录到用户点停止
 * 或收到 #EXT-X-ENDLIST。重封装和写盘的部分和点播完全共用。
 * ------------------------------------------------------------------ */

function resetProgressUi({ live }) {
  $('card-progress').hidden = false;
  $('bar-fill').style.width = live ? '100%' : '0%';
  $('bar-fill').classList.toggle('pulse', live);
  // 直播没有「总进度」这个概念，百分比和剩余时间都是假的，直接藏掉
  $('stat-percent').hidden = live;
  $('stat-missed').hidden = !live;
  $('stat-eta').hidden = false;
  if (live) $('stat-eta').textContent = '已录 —';
  else $('stat-eta').textContent = '剩余 —';
}

function paintLive({ downloaded, duration, bytes, missed, startedAt }) {
  $('bar-fill').style.width = '100%';
  $('stat-count').textContent = `已收 ${downloaded} 片`;
  $('stat-bytes').textContent = formatBytes(bytes);
  $('stat-missed').textContent = missed > 0 ? `漏片 ${missed}` : '漏片 0';
  $('stat-missed').style.color = missed > 0 ? 'var(--warn)' : '';

  const elapsed = (Date.now() - startedAt) / 1000;
  if (elapsed > 0.5 && bytes > 0) {
    $('stat-speed').textContent = formatSpeed(bytes / elapsed);
  }
  $('stat-eta').textContent = `已录 ${formatEta(duration)} 内容`;
}

async function startLive() {
  const first = state.playlist;
  const settings = state.settings || {};

  let sink;
  try {
    sink = await createSink({
      fileName: suggestFileName(state.title || '', 'mp4'),
      mode: settings.streamingSave === false ? 'memory' : 'auto',
    });
  } catch (err) {
    showNotice('err', '无法创建保存目标', String(err?.message || err));
    return;
  }
  if (sink?.cancelled) {
    log('用户取消了保存对话框，未开始录制');
    return;
  }

  state.running = true;
  state.controller = new AbortController();
  const signal = state.controller.signal;
  $('start').disabled = true;
  $('cancel').hidden = false;
  resetProgressUi({ live: true });

  // fMP4 直播这条路**不做收尾组装**（分片直接写盘，见下面 if (first.map) 分支），
  // 所以产出的是分片式 MP4：时长栏可能是"未知"、进度条不一定拖得动。
  // 这条限制必须**一开始就说** —— 原来这里写的是"收尾时组装成带索引的 MP4"，
  // 而那句话只在 TS（mux.js）那条路上成立，fMP4 直播从头到尾都没组装过。
  if (first.map) {
    log('直播录制开始（fMP4）：分片直接写盘 —— 这种产物是分片式 MP4，'
      + '时长可能显示为未知、进度条不一定拖得动（停止前请留意这一点）', 'err');
  } else {
    log('直播录制开始 · 收到内存里，收尾时组装成带索引的 MP4');
  }
  log('轮询间隔按播放列表的 #EXT-X-TARGETDURATION 自动决定');

  // 直播收在内存里（收尾才写盘），所以必须自己盯着量
  const liveFragments = [];

  const startedAt = Date.now();
  const fetchSegment = createSegmentFetcher({ signal, onKeyRecovered: keyRecoveryReporter() });
  let remuxer = null;

  try {
    if (first.map) {
      log('fMP4 直播：先写初始化段');
      const init = await fetchSegment({ uri: first.map.uri, byteRange: first.map.byteRange }, -1);
      await sink.write(init);
      log(`初始化段 ${formatBytes(init.byteLength)}`);
    } else {
      if (!window.muxjs?.mp4?.Transmuxer) {
        throw new Error('mux.js 没有加载（vendor/mux.min.js 缺失或被 CSP 拦了）');
      }
      // 直播先收在内存里，收尾时统一组装成带索引的普通 MP4 ——
      // 直接写 mux.js 的分片会让 mvhd 时长变成 0xFFFFFFFF（"时长未知"），
      // 播放器以为文件有十几小时，进度条就废了。
      // 代价是内存：所以下面设了上限，超了就退回分片式输出（保住内存，牺牲拖动）。
      remuxer = createTsRemuxer(window.muxjs, { onFragment: (b) => liveFragments.push(b) });
    }

    let downloaded = 0;
    let cumulative = 0;

    await runLivePolling({
      playlistUrl: state.playlistUrl,
      signal,
      fetchPlaylist: () => fetchText(state.playlistUrl),
      onError: (err) => log(`拉取播放列表出错（会继续重试）：${err.message}`, 'err'),
      onEnd: () => log('收到 #EXT-X-ENDLIST，直播已结束', 'ok'),
      onPlaylist: async (_playlist, fresh, tracker) => {
        if (!fresh.length) return;

        // 直播里「某个分片已经过期被删了」是常态，不是异常。
        // 如果让它把整场录制打断，用户会得到一个录到一半就停了的文件 ——
        // 所以这里吞掉单批失败，记一笔，继续录下一批。
        // ⚠️ 「下载」（可以跳过）和「写入」（致命）**必须分成两段**。
        //
        // live.js 里专门为这件事写过注释：把上层的写盘失败和"这一次网络不太好"
        // 合在一个 try 里，表现就是**录制看起来一直在跑、实际一个字节都写不进去、
        // 而且永远不会停**（磁盘满 / 句柄被撤销时就是这样）。
        // 而这里原来又把它们合回去了 —— 上面那 13 条审查里报过、文档里也写着"已修"，
        // 但代码一直是合着的。现在照 live.js 的约定分开。
        const batch = [];
        try {
          for await (const seg of downloadSegmentsInOrder(fresh, {
            concurrency: Math.max(1, Math.min(16, Number(settings.concurrency) || 6)),
            retries: Math.max(0, Math.min(8, Number(settings.retries) || 3)),
            signal,
            fetchSegment,
          })) {
            if (signal.aborted) throw new Error('已取消');
            batch.push(seg);
          }
        } catch (err) {
          // 取消是真的出事了，必须往外抛；单批分片失败是直播常态，记一笔继续
          if (signal.aborted) throw err;
          log(`这一批有分片没下下来，跳过继续录：${err.message}`, 'err');
        }
        // 到了这里再出错就是写盘/重封装的问题 —— **不吞**，往外抛让这次录制判失败
        for (const { index, data } of batch) {
          if (remuxer) remuxer.append(data);
          else await sink.write(data);
          downloaded += 1;
          cumulative += fresh[index]?.duration || 0;
        }

        paintLive({
          downloaded,
          duration: cumulative,
          bytes: sink.bytesWritten,
          missed: tracker.missedCount,
          startedAt,
        });
      },
    });

    if (remuxer) {
      remuxer.end();
    }

    // 直播同样是分片式输出，直接写盘的话 mvhd 时长是 0xFFFFFFFF（"时长未知"），
    // 播放器会以为文件有十几小时，进度条拖不动。所以收完之后组装一次。
    //
    // 但直播可能录很久 —— 全收在内存里会出事。所以超过上限就退回分片式输出：
    // 牺牲"能拖进度条"，保住"不会吃光内存"。这个取舍明说，不藏着。
    const LIVE_MEMORY_LIMIT = 600 * 1024 * 1024;
    if (remuxer?.initSegment) {
      const held = liveFragments.reduce((n, c) => n + c.byteLength, 0);
      if (held > LIVE_MEMORY_LIMIT) {
        log(`已录内容 ${formatBytes(held)}，超过 ${formatBytes(LIVE_MEMORY_LIMIT)} 上限，`
          + '改成分片式输出（避免吃光内存）。注意：这种文件在部分播放器里拖进度条可能不灵。', 'err');
        await sink.write(remuxer.initSegment);
        for (const f of liveFragments) await sink.write(f);
      } else {
        const handlers = listInitTracks(remuxer.initSegment);
        const collect = { init: remuxer.initSegment, segments: [concatChunks(liveFragments)] };
        const mergeInput = {};
        if (handlers.includes('video')) mergeInput.video = collect;
        if (handlers.includes('audio')) mergeInput.audio = collect;
        if (mergeInput.video || mergeInput.audio) {
          log('正在组装成带索引的 MP4（这样播放器才能拖进度条）…');
          const merged = mergeFmp4(mergeInput, {
            onWarning: (w) => log(`合并提示：${typeof w === 'string' ? w : (w?.message || JSON.stringify(w))}`),
          });
          await sink.write(merged);
        }
      }
    }

    const closed = await sink.close();
    if (!closed?.ok) throw new Error(closed?.error || '写入收尾失败');

    $('bar-fill').classList.remove('pulse');
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(`直播录制结束：${formatBytes(sink.bytesWritten)}，用时 ${elapsed} 秒`, 'ok');
    log(`落盘方式：${closed.via}`, 'ok');
    if (first.map) {
      // 分片式产物：不许说成"完美"。用户拿到的文件时长是"未知"，有的播放器拖不动
      showNotice('warn', '直播录制完成（分片式）',
        '文件已保存。这条路是边收边写，产物是分片式 MP4：时长可能显示为未知，'
        + '部分播放器拖进度条不灵。开头不会回溯 —— 直播是「录到哪算哪」。');
    } else {
      showNotice('ok', '直播录制完成', '文件已保存。直播是「录到哪算哪」，开头不会回溯。');
    }
  } catch (err) {
    const message = String(err?.message || err);
    if (signal.aborted) {
      log('已取消', 'err');
      showNotice('warn', '已停止录制', '已写入的部分可能是不完整的文件。');
    } else {
      log(`失败：${message}`, 'err');
      showNotice('err', '直播录制失败', message);
    }
    try { await sink.close(); } catch { /* 主错误已经报出去了 */ }
  } finally {
    state.running = false;
    state.controller = null;
    $('start').disabled = false;
    $('cancel').hidden = true;
    $('bar-fill').classList.remove('pulse');
  }
}

/* ------------------------------------------------------------------ *
 * 独立 fMP4 轨道的合并（B 站那类「没有清单的 DASH」）
 *
 * 这类站点不提供 m3u8 / mpd：它通过 API 直接返回两条**完整的 fMP4 文件地址**
 * （一条纯视频、一条纯音频）。每份文件开头是 ftyp+moov，后面跟一串 moof+mdat。
 *
 * 所以流程是：整份下下来 → 拆出初始化段 → **靠 moov 里的 handler box
 * 判断这是视频还是音频**（不看文件名，B 站的命名规则不是通用知识）→ 合并。
 * ------------------------------------------------------------------ */

/** 把整份文件下下来，带进度。这里不能复用分片下载器：那个是按分片语义设计的。 */
async function fetchWholeFile(url, { signal, onProgress, label }) {
  const res = await fetch(url, { credentials: 'include', cache: 'no-store', signal });
  if (!res.ok) throw new Error(`${label}：HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;

  if (!res.body) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    onProgress?.({ got, total });
  }
  const out = new Uint8Array(got);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

async function loadMergeJob() {
  const got = await chrome.storage.session.get('vh:mergejob');
  const job = got?.['vh:mergejob'];
  if (!job?.urls?.length) {
    throw new Error('没有待合并的轨道。任务可能已失效 —— 回扩展面板重新点一次「合并下载」。');
  }
  // 同一个地址可能被播放器请求多次（预取、Range 分段、重试），面板那边已经去过重，
  // 这里再兜一道：旧版本写下的任务、或者面板之后又改了逻辑，都不该让同一条轨道
  // 被下载两遍（88 MB 的东西白下 88 MB）。
  const byUrl = new Map();
  for (const u of job.urls) {
    const prev = byUrl.get(u.url);
    if (!prev || (u.size || 0) > (prev.size || 0)) byUrl.set(u.url, u);
  }
  const urls = [...byUrl.values()];
  if (urls.length !== job.urls.length) {
    console.info(`[vh/parser] 合并任务里有 ${job.urls.length - urls.length} 条重复地址，已忽略`);
  }
  state.mergeJob = { ...job, urls };
  state.playlist = null;
  state.dash = null;

  $('page-title').textContent = job.title || '合并音视频轨道';
  $('source-url').textContent = `${urls.length} 条独立轨道`;
  $('source-url').title = urls.map((u) => u.url).join('\n');

  setStateBody(`独立 fMP4 轨道 · ${urls.length} 条 · 下载后自动识别音视频并合并`);
  renderMergePlan(state.mergeJob);
}

function renderMergePlan(job) {
  $('card-plan').hidden = false;
  $('card-plan').querySelector('.card-title').textContent = '合并设置';
  $('start').textContent = '下载并合并';
  $('card-variants').hidden = true;

  const settings = state.settings || {};
  $('opt-concurrency').value = settings.concurrency ?? 6;
  $('opt-retries').value = settings.retries ?? 3;
  const streamSupported = canStreamToDisk();
  $('opt-stream').checked = streamSupported && settings.streamingSave !== false;
  $('opt-stream').disabled = !streamSupported;
  $('stream-hint').textContent = streamSupported ? '（推荐）' : '（当前浏览器不支持）';

  const box = $('plan-summary');
  box.textContent = '';
  const totalBytes = job.urls.reduce((n, u) => n + (u.size || 0), 0);
  const rows = [
    ['轨道数量', `${job.urls.length} 条`],
    ['合计大小', totalBytes ? `约 ${formatBytes(totalBytes)}` : '未知'],
    ['处理方式', '整份下载 → 按 handler 识别音视频 → 合并成一个 MP4'],
  ];
  for (const [k, v] of rows) {
    const row = document.createElement('div');
    const strong = document.createElement('b');
    strong.textContent = v;
    row.append(document.createTextNode(`${k}：`), strong);
    box.append(row);
  }
  for (const u of job.urls) {
    const row = document.createElement('div');
    row.style.color = 'var(--faint)';
    row.style.fontSize = '11.5px';
    row.style.fontFamily = 'ui-monospace, Consolas, monospace';
    row.style.overflow = 'hidden';
    row.style.textOverflow = 'ellipsis';
    row.style.whiteSpace = 'nowrap';
    row.textContent = `${u.size ? formatBytes(u.size) + ' · ' : ''}${u.url.split('/').pop().split('?')[0]}`;
    box.append(row);
  }

  const note = document.createElement('div');
  note.style.marginTop = '8px';
  note.style.color = 'var(--faint)';
  note.textContent = '产物是标准 MP4。这条路要先把整份文件收进内存（没法边下边写），'
    + '所以很大的视频请留意内存占用。';
  box.append(note);

  setPlanNotice(null);
}

async function startMergeDownload() {
  const job = state.mergeJob;
  if (!job) return;
  const settings = state.settings || {};

  let sink;
  try {
    sink = await createSink({
      fileName: suggestFileName(job.title || '', 'mp4'),
      mode: settings.streamingSave === false ? 'memory' : 'auto',
    });
  } catch (err) {
    showNotice('err', '无法创建保存目标', String(err?.message || err));
    return;
  }
  if (sink?.cancelled) { log('用户取消了保存对话框，未开始下载'); return; }

  state.running = true;
  state.controller = new AbortController();
  const signal = state.controller.signal;
  $('start').disabled = true;
  $('cancel').hidden = false;
  resetProgressUi({ live: false });

  const startedAt = Date.now();
  let doneBytes = 0;
  const grandTotal = job.urls.reduce((n, u) => n + (u.size || 0), 0);

  // 提到 try 外面：失败时要用它做诊断，以及兜底保住已经下下来的内容
  const tracks = [];

  try {
    for (let i = 0; i < job.urls.length; i += 1) {
      const item = job.urls[i];
      const label = `第 ${i + 1}/${job.urls.length} 条`;
      log(`${label}：${item.url.split('?')[0].split('/').pop()}`);

      const raw = await fetchWholeFile(item.url, {
        signal,
        label,
        onProgress: ({ got, total }) => {
          const overall = doneBytes + got;
          // 分母来自嗅探到的体积，而它是可能拿不到的（响应没有 Content-Length /
          // Content-Range 时 size 是 null）。所以百分比要**夹住上限**：
          // 只有一条轨道的体积未知时，分母偏小，不夹的话进度条会超过 100%。
          const pct = grandTotal ? Math.min(100, (overall / grandTotal) * 100) : 0;
          $('bar-fill').style.width = `${pct.toFixed(1)}%`;
          $('stat-percent').textContent = grandTotal ? `${pct.toFixed(1)}%` : '—';
          $('stat-count').textContent = label;
          $('stat-bytes').textContent = `${formatBytes(overall)}${total ? ' / ' + formatBytes(grandTotal) : ''}`;
          const elapsed = (Date.now() - startedAt) / 1000;
          if (elapsed > 0.5 && overall > 0) $('stat-speed').textContent = formatSpeed(overall / elapsed);
          $('stat-eta').textContent = '先全部下载，再合并';
        },
      });
      doneBytes += raw.byteLength;

      const rec = { url: item.url, raw, size: raw.byteLength };
      tracks.push(rec);

      // 单条轨道解析失败不该让整批下载白费 —— 先记下原因，继续处理下一条，
      // 最后再统一决定怎么办。
      try {
        const { init, fragments } = splitSelfContainedFmp4(raw);
        // 判断这是哪条轨 —— 靠 moov 里的 handler box，不靠文件名
        const info = parseInitSegment(init);
        rec.init = init;
        rec.fragments = fragments;
        rec.info = info;
        log(`  → 识别为 ${info.contentType} 轨，${formatBytes(raw.byteLength)}`
          + `${info.codecType ? `（${info.codecType}）` : ''}`, 'ok');
      } catch (err) {
        rec.error = err;
        log(`  → 这条解析不了：${err.message}`, 'err');
      }
    }

    const parsed = tracks.filter((t) => t.info && !t.error);
    const pick = (type) => parsed
      .filter((t) => t.info.contentType === type)
      .sort((a, b) => b.size - a.size)[0] || null;

    const video = pick('video');
    const audio = pick('audio');

    if (!video) {
      const reasons = tracks.map((t) => t.error?.message || t.info?.contentType || '未知').join('；');
      throw new Error(`这些轨道里没有可用的视频轨。各条的情况：${reasons}`);
    }
    if (!audio) log('没有找到音频轨，产物会是无声的', 'err');
    const extra = parsed.length - 1 - (audio ? 1 : 0);
    if (extra > 0) log(`另有 ${extra} 条轨道未被采用（同类型只取体积最大的那条）`);

    log(`开始合并：视频 ${formatBytes(video.size)}${audio ? ` + 音频 ${formatBytes(audio.size)}` : ''}…`);
    const merged = mergeFmp4({
      video: { init: video.init, segments: [video.fragments] },
      audio: audio ? { init: audio.init, segments: [audio.fragments] } : undefined,
    }, {
      onWarning: (w) => log(`合并提示：${typeof w === 'string' ? w : (w?.message || JSON.stringify(w))}`),
    });

    await sink.write(merged);
    const closed = await sink.close();
    if (!closed?.ok) throw new Error(closed?.error || '写入收尾失败');

    $('bar-fill').style.width = '100%';
    $('stat-percent').textContent = '100%';
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(`完成：${formatBytes(sink.bytesWritten)}，用时 ${elapsed} 秒`, 'ok');
    log(`落盘方式：${closed.via}`, 'ok');
    showNotice('ok', '合并完成', '两条轨道已经合成一个标准 MP4。');
    // 任务用完就删：那些地址是**带签名的**，过一阵就失效。
    // 留在 session storage 里的话，下次误开这个页面（或点「重新加载」）会看到一份
    // 早就过期的任务，再点一次只是白下一遍、白合一遍。
    await chrome.storage.session.remove('vh:mergejob').catch(() => {});
    $('source-url').textContent = `${job.urls.length} 条独立轨道（已完成）`;
  } catch (err) {
    const message = String(err?.message || err);

    if (signal.aborted) {
      log('已取消', 'err');
      showNotice('warn', '已取消', '已写入的部分可能是不完整的文件。');
      try { await sink.close(); } catch { /* 忽略 */ }
      return;
    }

    log(`失败：${message}`, 'err');

    // ---- 诊断：把每个轨道的 box 结构摊开 ----
    //
    // 「解析失败」四个字对排查毫无帮助。上一版只报了一句「avc1 里没有 avcC」，
    // 隔着屏幕完全无从下手。而结构一旦打出来，问题往往一眼可见。
    if (tracks.length) {
      log('—— 诊断：各轨道的 box 结构（请把这一段发给我） ——', 'err');
      for (const t of tracks) {
        const name = t.url.split('?')[0].split('/').pop();
        log(`${name}｜${formatBytes(t.size)}｜${t.error ? '解析失败：' + t.error.message : '识别为 ' + t.info.contentType}`, 'err');
        try {
          // 深度要给够：avcC 埋在第 8 层，切浅了就恰好在关键处停住
          for (const line of describeBoxTree(t.raw, { maxDepth: 10, maxLines: 60 })) {
            log(`  ${line}`, 'err');
          }
        } catch (dumpErr) {
          log(`  （结构也打不出来：${dumpErr.message}）`, 'err');
        }
      }
    }

    // ---- 兜底：视频轨本身就是一份能播的单轨 MP4 ----
    //
    // 用户刚等了几十兆的下载，不该什么都没拿到。视频轨单独存下来是能播的
    // （只是没有声音），比留一个空文件强。这一点在界面上要说清楚。
    const fallback = tracks
      .filter((t) => t.size > 0)
      .sort((a, b) => b.size - a.size)[0];

    let saved = null;
    if (fallback) {
      try {
        await sink.write(fallback.raw);
        const closed = await sink.close();
        if (closed?.ok) saved = fallback;
      } catch (writeErr) {
        log(`兜底保存也失败了：${writeErr.message}`, 'err');
      }
    }
    if (!saved) {
      try { await sink.close(); } catch { /* 忽略 */ }
    }

    showNotice('warn', saved ? '合并失败，已改存最大的一条轨道（可能没有声音）' : '合并失败', [
      message,
      '<br /><br />',
      saved
        ? `已经把体积最大的那条轨道（${formatBytes(saved.size)}）原样存下来了 —— `
          + '单条 fMP4 轨道本身就是一份能播的单轨 MP4，所以它应该能打开，只是<b>不会有声音</b>。'
        : '没有可保存的内容。',
      '<br /><br />',
      '日志里有完整的 <b>box 结构</b>。请把「诊断」那一段发给我 —— '
        + '有了它就能看出这个封装和我预期的差在哪。',
    ].join(''));
  } finally {
    state.running = false;
    state.controller = null;
    $('start').disabled = false;
    $('cancel').hidden = true;
  }
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

async function init() {
  state.settings = await getSettings();
  state.selfTabId = await getSelfTabId();

  // 合并模式：任务内容在 session storage 里（轨道地址太长，塞不进 URL）。
  // 先把 Referer 取出来 —— 这一条必须在下面挂 Referer 规则之前完成。
  if (state.mode === 'fmp4' && !state.referer) {
    try {
      const got = await chrome.storage.session.get('vh:mergejob');
      const job = got?.['vh:mergejob'];
      if (job?.urls?.length) {
        state.referer = job.urls.find((u) => u.referer)?.referer || '';
        state.title = state.title || job.title || '';
      }
    } catch { /* 下面 loadMergeJob 会给出明确的错误 */ }
  }

  $('page-title').textContent = state.title || (state.mode === 'fmp4' ? '合并音视频轨道' : '流解析');
  $('source-url').textContent = state.url;
  $('source-url').title = state.url;

  if (!state.url && state.mode !== 'fmp4') {
    showNotice('err', '缺少播放列表地址', '这个页面需要通过插件面板打开，直接访问是空的。');
    setStateBody('无输入');
    return;
  }

  // 给本页挂上源页面的 Referer —— 大部分 CDN 的 m3u8 / .ts 都要校验它
  if (state.referer && state.selfTabId != null) {
    const r = await send(MSG.SET_REFERER, { tabId: state.selfTabId, referer: state.referer });
    state.refererInstalled = !!r?.ok;
    log(state.refererInstalled
      ? `已为本站注入 Referer：${state.referer}`
      : `Referer 注入失败：${r?.error || '未知原因'}（若下载 403 就是这个原因）`,
    state.refererInstalled ? 'ok' : 'err');
  }

  $('reload').addEventListener('click', async () => {
    $('card-variants').hidden = true;
    $('card-plan').hidden = true;
    $('notice').hidden = true;
    try {
      // ⚠️ 合并模式下**不能**去 loadPlaylist(state.url)：这条路没有 url
      // （`state.url` 是空串），`fetch('')` 拉回来的是这个页面自己的 HTML，
      // 结果是一句「不是合法的 M3U8：缺少 #EXTM3U 头」，而且上面刚把
      // `card-plan` 藏了 —— 「下载并合并」按钮就此消失，只能手动刷新整页。
      // 合并模式的"重新加载"应该是重新读那份任务。
      if (state.mode === 'fmp4') await loadMergeJob();
      else await loadPlaylist(state.url);
    } catch (err) {
      showNotice('err', '重新加载失败', String(err?.message || err));
    }
  });

  $('start').addEventListener('click', startDownload);
  $('cancel').addEventListener('click', () => {
    state.controller?.abort(new Error('用户取消'));
  });

  $('opt-concurrency').addEventListener('change', (e) => {
    state.settings.concurrency = Math.max(1, Math.min(16, Number(e.target.value) || 6));
  });
  $('opt-retries').addEventListener('change', (e) => {
    state.settings.retries = Math.max(0, Math.min(8, Number(e.target.value) || 3));
  });
  $('opt-stream').addEventListener('change', (e) => {
    state.settings.streamingSave = e.target.checked;
  });

  window.addEventListener('beforeunload', () => {
    if (state.selfTabId != null) {
      // 会话规则没必要留着 —— 用完即撤，不要污染其他页面
      chrome.runtime.sendMessage({ type: MSG.CLEAR_REFERER, tabId: state.selfTabId }).catch(() => {});
    }
  });

  if (state.mode === 'fmp4') {
    try {
      await loadMergeJob();
    } catch (err) {
      setStateBody('任务失效');
      showNotice('err', '无法开始合并', String(err?.message || err));
    }
    return;
  }

  try {
    await loadPlaylist(state.url);
  } catch (err) {
    setStateBody('读取失败');
    showNotice('err', '读取播放列表失败', String(err?.message || err));
    log(String(err?.stack || err), 'err');
  }
}

init().catch((err) => {
  console.error('[vh/parser] 初始化失败：', err);
  showNotice('err', '初始化失败', String(err?.message || err));
});
