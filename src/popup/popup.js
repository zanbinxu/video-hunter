/**
 * 一体化面板。
 *
 * 面板不自己嗅探，它只做三件事：问 service worker 要数据、把它画出来、把用户
 * 的意图翻译成一条消息发回去。所有判断（该下载还是该解析）都留在后台，
 * 免得同一套规则在两个地方各写一遍然后慢慢跑偏。
 */
import { MSG, KIND, KIND_LABEL, CONFIDENCE, TAB_KEY_PREFIX, RECORD_STAGE } from '../core/constants.js';
import { formatBytes, formatDuration } from '../core/classify.js';
import { planMerge } from '../core/merge-plan.js';
import { getSettings, setSettings } from '../core/settings.js';

const state = {
  tabId: null,
  entries: [],
  pageVideos: [],
  page: {},
  filter: 'all',
  settings: null,
  record: null,
  recordTimer: null,
  /** 已经弹过的"抓流进行中"提示（快到切段阈值 / 刚切了一段），用于判重 */
  noticeSeen: null,
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ *
 * 数据
 * ------------------------------------------------------------------ */

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

async function loadMedia(tabId) {
  try {
    const res = await chrome.runtime.sendMessage({
      type: MSG.GET_TAB_MEDIA,
      tabId,
      includePageVideos: true,
    });
    if (res?.ok) return res;
  } catch (err) {
    console.debug('[vh/popup] 问 service worker 失败，直接读缓存：', err);
  }
  // service worker 没醒或者消息通道断了 —— 直接读会话存储兜底。
  // 数据本来就在那儿，不该因为一条消息发不出去就显示空列表。
  try {
    const key = `${TAB_KEY_PREFIX}${tabId}`;
    const got = await chrome.storage.session.get(key);
    return { ok: true, entries: got?.[key] || [], pageVideos: [], page: {} };
  } catch {
    return { ok: true, entries: [], pageVideos: [], page: {} };
  }
}

/* ------------------------------------------------------------------ *
 * 分组
 * ------------------------------------------------------------------ */

/**
 * 「这个页面用 MSE 播放」的提示条。
 *
 * 为什么必须有：YouTube 这类站点，媒体响应回来的是它**自己的容器**
 * （`application/vnd.yt-ump`，不是 `video/mp4`），播放源也在 `blob:` 里 ——
 * 嗅探层天生看不到能下载的东西。实测打开一个 YouTube 视频页，扩展只嗅到
 * 4 条**页面 UI 音效**（`audio/mpeg`、0 字节），视频一条都没有。
 *
 * 用户看到的就是"什么都没有，只有一个音频列表"，于是以为这个站不支持。
 * 其实抓流完全能用（同一次实测：钩子 14 秒收到 90 段 / 2.59 MB）。
 * 所以这里把话说清楚，并把按钮直接摆在面前。
 */
function renderMseHint(primary, plan) {
  const box = $('mse-hint');
  if (!box) return;

  // 页面在播 MSE（blob: 源）
  const mseVideos = state.pageVideos.filter((v) => v.video?.hasBlob);
  if (!mseVideos.length) { box.hidden = true; return; }

  // 「有没有拿到真东西」——只看**视频文件和播放列表**。
  //
  // 音频条目一律不参与判断，理由具体：YouTube 会加载几个按钮音效
  // （`/s/search/audio/*.mp3`，几 KB 的 audio/mpeg）。它们确实"可下载"，
  // 于是任何"有没有可下载的东西"的判据都会被它们满足，这个提示条就永远不出现
  // —— 而那恰恰是用户最需要看到的一句话（"我列表里只有音频，视频呢？"）。
  // 反过来，纯音频页面用的是 `<audio>`，不会被当成"页面视频"，所以不会误报。
  const foundReal = primary.some((i) => !i.video
    && (i.kind === KIND.HLS || i.kind === KIND.DASH || i.kind === KIND.FILE))
    // 「有没有一条真能合出完整文件的轨道」也算 —— B 站那种形态嗅到的就是两条
    // `.m4s`（分类成 SEGMENT），列表看着"什么都没有"，但合并这条路走得通，
    // 这时候再劝用户去抓流就是误导。
    || plan?.canMerge;
  if (foundReal) { box.hidden = true; return; }

  box.hidden = false;
  $('mse-hint-text').textContent = mseVideos.length > 1
    ? `页面上的 ${mseVideos.length} 个视频都用 MSE 播放，真实地址不是普通请求拿得到的`
    : '这个视频用 MSE 播放，真实地址不是普通请求拿得到的';
}

/**
 * 合并提示条：显示不显示、写什么字，全部由 `planMerge` 的真判据决定。
 *
 * 这里踩过一个很隐蔽的坑，记在这儿：**`hidden` 属性原来是不生效的**。
 * `.mergebar` 在 CSS 里写了 `display:flex`，而作者样式永远压过浏览器默认的
 * `[hidden]{display:none}` —— 于是这条提示条从页面加载起就挂在面板上，
 * 显示的是 HTML 里写死的那句话，跟实际嗅到了什么毫无关系。用户看到的就是
 * 「检测到多个独立轨道 + 合并下载」，点下去却被告知"至少要有两条轨道才能合并"。
 * 所以：① popup.css 补了 `[hidden]{display:none!important}`；
 * ② 文案改成**按真实轨道算出来的**；③ 判据本身抽成 `planMerge` 并单测。
 */
function renderMergeBar(plan) {
  const bar = $('mergebar');
  const go = $('merge-go');
  if (!bar) return;
  if (!plan.show) { bar.hidden = true; return; }
  $('merge-text').textContent = plan.text;
  // 判据不成立时**只留解释、不给按钮** —— 点了必定失败的动作不该摆在面前
  if (go) go.hidden = !plan.canMerge;
  bar.hidden = false;
}

/**
 * 同一条地址被请求多次时只留一条。
 *
 * 这不是理论问题：B 站的播放器会对同一个 `.m4s` 发多次请求（预取、Range 分段、
 * 重试），嗅探层就会记下多条**完全相同的 URL**。不去重的话：
 *   · 「检测到 N 条独立轨道」会多报（实测把 2 条报成 3 条）
 *   · 合并时同一条 URL 白下载两遍，88 MB 的文件就是白下 88 MB
 * 同一个地址出现多次时，留信息最全的那条（体积最大、带 Referer 的）。
 */
function dedupeByUrl(list) {
  const byUrl = new Map();
  for (const e of list) {
    const prev = byUrl.get(e.url);
    if (!prev) { byUrl.set(e.url, e); continue; }
    if ((e.size || 0) > (prev.size || 0)) byUrl.set(e.url, e);
  }
  return [...byUrl.values()];
}

/**
 * 分成三类：播放列表、独立文件、分片。
 *
 * 关键在于**分片要不要折叠**。有播放列表时，分片是那个列表的一部分，
 * 逐条列出来只会淹没真正的目标，所以折叠成一行汇总。
 *
 * 但没有播放列表时，分片本身就是下载目标 —— B 站这类站点不提供 m3u8/mpd，
 * 它通过 API 直接给出两条独立的 fMP4 轨道地址，嗅探到的就是两个 `.m4s`。
 * 这时候再折叠，用户就什么也做不了（第一版就是这么错的）。
 */
function collectItems() {
  const playlists = dedupeByUrl(state.entries.filter((e) => e.kind === KIND.HLS || e.kind === KIND.DASH));
  const files = dedupeByUrl(state.entries.filter(
    (e) => e.kind !== KIND.SEGMENT && e.kind !== KIND.HLS && e.kind !== KIND.DASH,
  ));
  const segments = dedupeByUrl(state.entries.filter((e) => e.kind === KIND.SEGMENT));

  const hasPlaylist = playlists.length > 0;
  const standalone = hasPlaylist ? [] : segments;
  const attached = hasPlaylist ? segments : [];

  const primary = [...playlists, ...files, ...standalone];

  // 页面 <video> 扫出来的条目也当主项（它们代表"MSE 播放、地址拿不到"那种情况）
  for (const v of state.pageVideos) primary.push(v);

  // 播放列表最该被看见，排在前面；同类型里大的排前面。
  const weight = { [KIND.HLS]: 0, [KIND.DASH]: 1, [KIND.FILE]: 2, [KIND.AUDIO]: 3, [KIND.SEGMENT]: 4 };
  primary.sort((a, b) => {
    const wa = weight[a.kind] ?? 9;
    const wb = weight[b.kind] ?? 9;
    if (wa !== wb) return wa - wb;
    return (b.size || 0) - (a.size || 0);
  });
  return { primary, attached, standalone, files, playlists, hasPlaylist };
}

/**
 * 分类筛选用「这条在列表里代表什么」来判，而不是只看 kind。
 *
 * 踩过的坑：`video` 只认 `KIND.FILE`。可是 MSE 页面上那条"代表播放中视频"的条目
 * 是 `SEGMENT`（service worker 按 `hasBlob` 判的），没有清单的独立轨道（`.m4s`）
 * 也是 `SEGMENT` —— 于是面板上明明有 5 条、点「视频」却显示「暂未捕获到媒体」，
 * 而那一行正是「抓流」按钮所在的那一条。
 */
function matchesFilter(item, filter) {
  if (filter === 'all') return true;
  // 视频页签 = 完整视频文件 + 媒体分片（含 MSE 页面那一条、无清单 DASH 的独立轨道）
  if (filter === 'video') return item.kind === KIND.FILE || item.kind === KIND.SEGMENT;
  if (filter === 'audio') return item.kind === KIND.AUDIO;
  if (filter === 'playlist') return item.kind === KIND.HLS || item.kind === KIND.DASH;
  return true;
}

function counts(primary) {
  return {
    all: primary.length,
    video: primary.filter((i) => matchesFilter(i, 'video')).length,
    audio: primary.filter((i) => matchesFilter(i, 'audio')).length,
    playlist: primary.filter((i) => matchesFilter(i, 'playlist')).length,
  };
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function badgeClass(kind) {
  if (kind === KIND.HLS) return 'badge hls';
  if (kind === KIND.DASH) return 'badge dash';
  if (kind === KIND.AUDIO) return 'badge audio';
  if (kind === KIND.SEGMENT) return 'badge segment';
  return 'badge file';
}

function displayName(item) {
  if (item.video) {
    const res = item.video.width && item.video.height ? `${item.video.width}×${item.video.height}` : '';
    return `页面视频 #${item.id.split(':').pop()}${res ? ' · ' + res : ''}`;
  }
  try {
    const u = new URL(item.url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (last) return last;
    return u.host + u.pathname;
  } catch {
    return item.url || '(无地址)';
  }
}

function metaParts(item) {
  const parts = [];
  const host = hostOf(item.url) || hostOf(item.pageUrl);
  if (host) parts.push(host);
  if (item.size) parts.push(formatBytes(item.size));
  if (item.video?.duration) parts.push(formatDuration(item.video.duration));
  if (item.mime) parts.push(item.mime);
  if (item.confidence === CONFIDENCE.LOW) parts.push({ warn: '仅凭扩展名识别' });
  return parts;
}

function renderItem(item) {
  const row = el('div', 'item');
  const main = el('div', 'item-main');

  // 能走到这里的 SEGMENT 一定是"没有配套播放列表的独立轨道"
  // （属于播放列表的那些已经被折叠成汇总行了），所以换个叫法，
  // 否则用户看到"媒体分片"会以为它只是别人的一部分、下了也没用。
  const isStandaloneTrack = item.kind === KIND.SEGMENT;
  const head = el('div', 'item-title');
  head.append(el('span', badgeClass(item.kind), isStandaloneTrack ? '独立轨道' : (KIND_LABEL[item.kind] || item.kind)));
  head.append(document.createTextNode(displayName(item)));
  main.append(head);

  const meta = el('div', 'item-meta');
  const parts = metaParts(item);
  if (isStandaloneTrack) parts.push('没有清单，属于独立的一条音视频轨');
  parts.forEach((p, i) => {
    if (i > 0) meta.append(el('span', 'sep', '·'));
    if (p && typeof p === 'object' && p.warn) meta.append(el('span', 'warn', p.warn));
    else meta.append(document.createTextNode(String(p)));
  });
  if (item.reason && item.confidence !== CONFIDENCE.HIGH) {
    if (parts.length) meta.append(el('span', 'sep', '·'));
    meta.append(document.createTextNode(item.reason));
  }
  main.append(meta);
  row.append(main);

  const actions = el('div', 'item-actions');
  const isMse = !!(item.video && item.video.hasBlob);

  if (isMse) {
    // MSE 播放的页面（YouTube、多数站的播放器）**首选是抓流**，不是录制。
    //
    // 这里原来只给了一个「录制」按钮 —— 那等于把用户往最差的那条路上推：
    // 录制是采标签页画面重新编码（有损、还带播放器 UI），而抓流拿的是播放器
    // 已经解好的原始码流（无损、更快、不用等视频播完）。实测 YouTube 上
    // 抓流 14 秒收到 90 段，录制则要实时等完整个视频。
    const cap = el('button', 'btn primary', '抓流');
    cap.title = '钩住播放器，把它已解密的原始码流直接存下来（无损、不重编码）';
    cap.addEventListener('click', () => startMseCapture());
    actions.append(cap);

    const rec = el('button', 'btn', '录制');
    rec.title = '抓流也不行时才用：采集标签页画面重新编码';
    rec.addEventListener('click', () => startRecording());
    actions.append(rec);
  } else if (item.kind === KIND.HLS || item.kind === KIND.DASH) {
    const go = el('button', 'btn primary', '解析');
    go.addEventListener('click', () => openParser(item));
    actions.append(go);
  } else if (item.url) {
    const dl = el('button', 'btn primary', '下载');
    dl.addEventListener('click', () => startDownload(item));
    actions.append(dl);
  }

  if (item.url) {
    const copy = el('button', 'btn', '复制链接');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(item.url);
        toast('链接已复制');
      } catch {
        toast('复制失败', true);
      }
    });
    actions.append(copy);
  }

  row.append(actions);
  return row;
}

function render() {
  const { primary, attached, standalone, files, hasPlaylist } = collectItems();
  const c = counts(primary);
  $('c-all').textContent = c.all;
  $('c-video').textContent = c.video;
  $('c-audio').textContent = c.audio;
  $('c-playlist').textContent = c.playlist;

  const plan = planMerge({ hasPlaylist, standalone, files });
  renderMseHint(primary, plan);
  renderMergeBar(plan);

  const list = $('list');
  list.textContent = '';

  const visible = primary.filter((i) => matchesFilter(i, state.filter));
  if (!visible.length && !attached.length) {
    const empty = el('div', 'empty');
    empty.append(el('div', 'empty-icon', '🔍'));
    const p = el('p');
    // ⚠️ 「没有捕获到媒体」和「这个页签下没有」是两件事，不能共用一句话。
    // 抓到的东西在别的分类里时，原来这里也说"暂未捕获到媒体"——
    // 用户明明看到底栏写着「全部 5」，点「视频」却被告知什么都没抓到。
    p.innerHTML = primary.length
      ? '这一类里没有内容。<br />点「全部」看看 —— 抓到的东西在别的分类里。'
      : '暂未捕获到媒体。<br />播放一下页面上的视频，再点右上角刷新。';
    empty.append(p);
    list.append(empty);
    return;
  }

  for (const item of visible) list.append(renderItem(item));

  // 属于某个播放列表的分片才折叠 —— 它们逐条列出来只是噪声
  if (attached.length && state.filter === 'all') {
    const hosts = new Set(attached.map((s) => hostOf(s.url)).filter(Boolean));
    const box = el('div', 'summary');
    box.append(el('b', null, `已捕获 ${attached.length} 个媒体分片`));
    box.append(document.createTextNode(hosts.size === 1 ? `来自 ${[...hosts][0]}` : `来自 ${hosts.size} 个域名`));
    box.append(document.createTextNode('· 请在上方用对应的播放列表下载'));
    list.append(box);
  }
}

/* ------------------------------------------------------------------ *
 * 动作
 * ------------------------------------------------------------------ */

async function refresh({ spin = false } = {}) {
  if (state.tabId == null) return;
  if (spin) {
    const btn = $('refresh');
    btn.classList.add('spin');
    setTimeout(() => btn.classList.remove('spin'), 320);
  }
  const res = await loadMedia(state.tabId);
  state.entries = res.entries || [];
  state.pageVideos = res.pageVideos || [];
  state.page = res.page || {};
  render();
}

async function startDownload(item) {
  try {
    const res = await chrome.runtime.sendMessage({
      type: MSG.START_DOWNLOAD,
      tabId: state.tabId,
      id: item.id,
    });
    if (res?.ok) {
      if (res.action === 'opened-parser') toast('已打开解析页');
      else toast('已开始下载');
    } else {
      toast(res?.error || '下载失败', true);
    }
  } catch (err) {
    toast(String(err?.message || err), true);
  }
}

function openParser(item) {
  chrome.runtime.sendMessage({
    type: MSG.OPEN_PARSER,
    // tabId 必须带上：service worker 会把它当作 sourceTabId 传给解析器页，
    // 有了它解析器页才能在「扩展页面直连抓不到」时借源页面的上下文重试。
    // popup 自己不是标签页，sender.tab 是空的，不传就永远是空字符串。
    tabId: state.tabId,
    url: item.url,
    referer: item.referer || item.pageUrl || '',
    pageUrl: item.pageUrl || '',
    title: item.pageTitle || '',
    kind: item.kind,
  }).catch(() => {});
  window.close();
}

function openRecorder(item, focus = '') {
  chrome.runtime.sendMessage({
    type: MSG.OPEN_RECORDER,
    tabId: state.tabId,
    title: item?.pageTitle || state.page?.title || '',
    focus,
  }).catch(() => {});
  window.close();
}

/* ------------------------------------------------------------------ *
 * 录制
 * ------------------------------------------------------------------ */

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function renderRecording() {
  const bar = $('recbar');
  const r = state.record;
  const stage = r?.stage;

  // 抓流进行中的一句话（快到自动切段阈值 / 刚切了一段）：面板是用户盯着看的地方，
  // "一个视频变成两个文件"这种事必须当场说出来，不能等他事后去列表里发现。
  if (stage === RECORD_STAGE.RECORDING && r?.captureNotice && r.captureNotice !== state.noticeSeen) {
    state.noticeSeen = r.captureNotice;
    toast(r.captureNotice);
  }

  if (stage !== RECORD_STAGE.RECORDING && stage !== RECORD_STAGE.FINALIZING) {
    bar.hidden = true;
    if (state.recordTimer) { clearInterval(state.recordTimer); state.recordTimer = null; }
    if (stage === RECORD_STAGE.READY && r?.fileName) {
      // 时长说**文件自己的**时长，不是"抓了多久" —— 两者经常差很多
      const real = Number.isFinite(r.mediaSeconds) && r.mediaSeconds > 0
        ? formatClock(r.mediaSeconds * 1000)
        : null;
      toast(finishedToastText(r, real));
    }
    return;
  }

  bar.hidden = false;
  const stats = r?.stats || {};
  const isMse = r?.mode === 'mse';
  // 计时器显示的是"已经抓了多久"——正在进行时这是唯一有意义的数；
  // 结束之后会换成文件的真实时长（见上面）
  const elapsed = stats.elapsedMs || (Date.now() - (r.startedAt || Date.now()));
  const label = stage === RECORD_STAGE.FINALIZING
    ? '正在收尾…'
    : (isMse ? '抓流中' : '录制中');
  // 抓流是"边播边收"，必须让用户看到它确实在动 —— 只有一个转圈的计时器
  // 时，没法区分"在收"和"卡死了"。段数就是这个心跳。
  // 换集会自动另存一个文件，所以还要显示"已经存了几个"。
  const parts = r?.parts || stats.parts || 0;
  const progress = isMse
    ? (stats.chunks ? ` · ${stats.chunks} 段${parts ? ` · 已存 ${parts} 个` : ''} · ${formatBytes(stats.bytes || 0)}` : '')
    : ` · ${stats.frames ?? 0} 帧`;
  $('rec-text').textContent = `${label} ${formatClock(elapsed)}${progress}`;
}

function finishedToastText(r, real) {
  const what = r?.mode === 'mse' ? '抓流' : '录制';
  return real ? `${what}完成，视频时长 ${real} —— 去「管理」里保存` : `${what}完成 —— 去「管理」里保存`;
}

async function refreshRecording() {
  const res = await chrome.runtime.sendMessage({ type: MSG.RECORD_STATE }).catch(() => null);
  state.record = res?.state || null;
  renderRecording();
}

/**
 * 抓流：钩住播放器的 appendBuffer，拿它**已经解密好的**原始码流。
 *
 * 流程和录制一样必须刷新，原因很具体：
 *   MSE 播放器是先 append 一个**初始化段**（moov），再 append 媒体分片。
 *   钩子只看得见装上之后的调用 —— 如果不刷新，初始化段在你点按钮之前
 *   就已经进去了，最后只捞到一堆没有 moov 的分片，拼不出能播的文件。
 *
 *   钩子注册成了 document_start 的持久脚本，所以刷新之后会自动就位，
 *   从头把初始化段和分片一起捞下来。
 */
/**
 * 页面上"正在播的那个视频"播到第几秒。
 *
 * 用途：点「抓流」时把这一秒带上，刷新之后让起播看护把位置拨回这里
 * （见 content.js 的 guardStart）—— 用户就不用为了抓后半段而重看一遍。
 *
 * 挑法：优先"最大的可见且是 MSE 的那个"（就是页面的主播放器），
 * 找不到就退化成最大的可见视频。广告、预览小窗都不该算进来。
 */
function currentPlaybackSeconds() {
  const videos = Array.isArray(state.pageVideos) ? state.pageVideos : [];
  // 只算"正在播的"：位置大于 0 的可见视频（广告/预览小窗一般不在这个位置）
  const candidates = videos
    .map((entry) => entry?.video || null)
    .filter((v) => v && v.visible !== false && Number(v.currentTime) > 0);
  if (!candidates.length) return 0;
  const score = (v) => (Number(v.width) || 0) * (Number(v.height) || 0) + (v.isMse ? 1e6 : 0);
  let best = candidates[0];
  for (const v of candidates) if (score(v) > score(best)) best = v;
  return Math.max(0, Number(best.currentTime) || 0);
}

/**
 * 秒 → mm:ss / h:mm:ss（列表里的播放位置用）。
 * 注意和上面那个 `formatClock(ms)` 不是一回事：那个收毫秒，给录制计时用。
 */
function formatPosition(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

async function startMseCapture() {
  // 从当前进度开始（默认开，设置里可关）：3 小时的视频从第 2 小时抓，
  // 产物就只有 1 小时 —— 时间和内存都省下来。
  const fromCurrent = state.settings?.captureFromCurrent !== false;
  // 位置要**现取**：面板可能是几秒前打开/刷新的，那期间视频还在往前走
  // （实测差 2 秒），直接用旧值就会漏掉开头那两秒。
  if (fromCurrent) {
    try { await refresh(); } catch { /* 扫不到就用手上这份，不因此中断 */ }
  }
  // 再往前退 3 秒：面板扫页面、注册钩子、刷新页面都要花时间，从"当前位置"
  // 开始抓的话开头会缺掉这几秒。退回一点，接缝处宁可多一点也不要缺。
  const startAt = fromCurrent ? Math.max(0, currentPlaybackSeconds() - 3) : 0;

  const res = await chrome.runtime.sendMessage({
    type: MSG.MSE_START,
    tabId: state.tabId,
    startAt,
  }).catch((err) => ({ ok: false, error: String(err?.message || err) }));

  if (!res?.ok) {
    // 「已经在抓流了」不是错误，是**信息** —— 用户最常见的误判就是以为换集之后
    // 要重新点一次「抓流」（其实抓流没停，缓冲已清空、正在抓下一集）。
    // 所以这条不标红，而且要说清现在第几段。真正的失败才标红。
    toast(res?.error || '启动抓流失败', !res?.alreadyCapturing);
    return;
  }
  state.record = {
    stage: RECORD_STAGE.RECORDING,
    mode: 'mse',
    tabId: state.tabId,
    startedAt: Date.now(),
  };
  renderRecording();
  if (!state.recordTimer) {
    state.recordTimer = setInterval(() => refreshRecording(), 1000);
  }
  toast(startAt > 0
    ? `抓流已开始：从 ${formatPosition(startAt)} 接着抓（会刷新一次页面，不用重看）`
    : '抓流已开始，正在刷新页面让播放器从头播');
  // 等钩子注册生效再刷新，别刷在注册前面
  setTimeout(() => {
    chrome.tabs.reload(state.tabId).catch(() => {});
    window.close();
  }, 900);
}

async function startRecording() {
  // tabCapture 要求目标标签页当前是活动标签页 —— 现在正好是，
  // 因为我们就是从它的扩展面板里点出来的。
  const res = await chrome.runtime.sendMessage({
    type: MSG.RECORD_START,
    tabId: state.tabId,
  }).catch((err) => ({ ok: false, error: String(err?.message || err) }));

  if (!res?.ok) {
    toast(res?.error || '启动录制失败', true);
    return;
  }
  state.record = {
    stage: RECORD_STAGE.RECORDING,
    tabId: state.tabId,
    startedAt: Date.now(),
    fileName: res.fileName,
    stats: null,
  };
  renderRecording();
  if (!state.recordTimer) {
    state.recordTimer = setInterval(() => refreshRecording(), 1000);
  }
  // 刷新目标页让视频从头播 —— 采集挂在标签页上，刷新不会中断它
  setTimeout(() => {
    chrome.tabs.reload(state.tabId).catch(() => {});
    window.close();
  }, 900);
}

/* ------------------------------------------------------------------ *
 * 独立轨道的合并
 *
 * B 站这类站点没有清单文件，它直接给你两条完整的 fMP4 地址
 * （一条视频、一条音频）。面板这边只负责把任务交给解析器页 ——
 * 下载、识别轨道、合并都在那边做，因为那是完整标签页，有大内存和日志。
 * ------------------------------------------------------------------ */

async function startMerge() {
  // 用**和提示条同一个判据**重新算一遍：面板显示的那一刻到点击之间，
  // 页面可能又请求了几条轨道（B 站常常先视频后音频），所以不能信渲染时的结果。
  const { standalone, files, hasPlaylist } = collectItems();
  const plan = planMerge({ hasPlaylist, standalone, files });
  if (!plan.canMerge || !plan.tracks.length) {
    // 判据不成立时按钮本来是藏起来的；真走到这儿说明状态变了，就把原因说出来
    toast(plan.text || '现在还没有可合并的轨道', true);
    return;
  }
  const urls = plan.tracks.map((e) => ({
    url: e.url,
    referer: e.referer || e.pageUrl || '',
    size: e.size || 0,
    pageUrl: e.pageUrl || '',
  }));
  const title = state.page?.title || plan.tracks[0]?.pageTitle || '';

  try {
    // 轨道地址又长又带签名（B 站那种一条几百字符），塞进 URL 很容易超长，
    // 所以走 session storage 传递，页面上只带一个 mode 标记。
    await chrome.storage.session.set({
      'vh:mergejob': { urls, title, tabId: state.tabId, createdAt: Date.now() },
    });
  } catch (err) {
    toast(`任务写入失败：${err?.message || err}`, true);
    return;
  }

  await chrome.runtime.sendMessage({ type: MSG.OPEN_MERGE }).catch(() => {});
  window.close();
}

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

let toastTimer = null;
function toast(text, isError = false) {
  const box = $('toast');
  box.textContent = text;
  box.className = isError ? 'toast err' : 'toast';
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 2400);
}

function fillSettings(settings) {
  $('s-quality').value = settings.preferredQuality;
  $('s-concurrency').value = settings.concurrency;
  $('s-subdir').value = settings.downloadSubdir;
  $('s-streaming').checked = !!settings.streamingSave;
  $('s-autosave').checked = settings.autoSaveCapture !== false;
  // 「自动保存已录到的部分」（滚动覆盖）：和管理页那张卡是**同一个值**，
  // 在哪边改都算数。间隔只给 5 / 10 / 30 三档，读到的值不在档上就回落到 10。
  $('s-autosnap').checked = settings.autoSnapshotCapture !== false;
  $('s-autosnap-minutes').value = String([5, 10, 30].includes(Number(settings.autoSnapshotMinutes))
    ? Number(settings.autoSnapshotMinutes) : 10);
  $('s-autosnap-minutes').disabled = !$('s-autosnap').checked;
  // 这 N 分钟按**录制时间**还是**视频内容时长**算（倍速播放时两者差好几倍）
  $('s-autosnap-basis').value = settings.autoSnapshotBasis === 'media' ? 'media' : 'wall';
  $('s-autosnap-basis').disabled = !$('s-autosnap').checked;
  // 「产物自动导出到下载目录」：默认开（用户要的就是"抓完自动落到本地"），
  // 私有存储那份和「保存到磁盘」按钮都保留
  $('s-autoexport').checked = settings.autoExportCapture !== false;
  // 「从当前播放位置开始」：默认开。关掉就恢复老行为（每次从头抓完整的）
  $('s-fromcurrent').checked = settings.captureFromCurrent !== false;
  // 「攒太大自动切一段」：默认开（抓流数据全在内存里，收尾合并还要一整块）
  $('s-autocut').checked = settings.autoCutCapture !== false;
  $('s-autocut-mb').value = String([300, 600, 1200].includes(Number(settings.autoCutMb))
    ? Number(settings.autoCutMb) : 600);
  $('s-autocut-mb').disabled = !$('s-autocut').checked;
  $('page-buttons').checked = !!settings.injectPageButtons;
}

async function pushSetting(patch) {
  state.settings = await setSettings(patch);
  fillSettings(state.settings);
  return state.settings;
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

async function init() {
  // 正常用法是浏览器动作弹窗：看"当前活动标签页"。
  // 但以整页方式打开时（`popup.html?tabId=123`），`active:true, currentWindow:true`
  // 返回的是**这个页面自己** —— 那样就永远看到一个空列表。
  // 所以支持显式指定标签页：自动化验证要靠它，手动排查某个标签页时也方便。
  const forcedTabId = Number(new URLSearchParams(location.search).get('tabId'));
  let tab = null;
  if (Number.isInteger(forcedTabId) && forcedTabId > 0) {
    tab = await chrome.tabs.get(forcedTabId).catch(() => null);
  }
  if (!tab) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = active || null;
  }
  state.tabId = Number.isInteger(tab?.id) ? tab.id : null;

  const host = hostOf(tab?.url) || '';
  $('page-host').textContent = host || (tab?.url || '当前标签页不可用');
  $('page-host').title = tab?.url || '';

  state.settings = await getSettings();
  fillSettings(state.settings);

  await refresh();
  await refreshRecording();
  // 录制中时每秒刷新计时；弹窗本身会被关掉，所以不用做持久轮询
  state.recordTimer = setInterval(() => {
    if (state.record?.stage === RECORD_STAGE.RECORDING
      || state.record?.stage === RECORD_STAGE.FINALIZING) {
      refreshRecording();
    }
  }, 1000);

  $('refresh').addEventListener('click', () => refresh({ spin: true }));

  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    for (const t of $('tabs').querySelectorAll('.tab')) t.classList.toggle('is-active', t === btn);
    render();
  });

  $('clear').addEventListener('click', async () => {
    if (state.tabId == null) return;
    await chrome.runtime.sendMessage({ type: MSG.CLEAR_TAB_MEDIA, tabId: state.tabId }).catch(() => {});
    await refresh();
    toast('已清空当前标签页记录');
  });

  $('settings-toggle').addEventListener('click', () => {
    const box = $('settings');
    box.hidden = !box.hidden;
  });

  // 两种模式的对比现在收在问号里：**靠 CSS 的 :hover / :focus-within 展开**，
  // 不需要 JS 切换（也就没有"点开之后把列表挤下去"这件事了）。
  // 这里只补一层键盘可达性：Esc 收起 focus，免得卡片一直开着挡住列表。
  $('mode-help-q').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') e.target.blur();
  });

  $('page-buttons').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    await pushSetting({ injectPageButtons: enabled });
    // 立刻在当前页面生效，不等下次导航
    if (state.tabId != null) {
      await chrome.runtime.sendMessage({
        type: MSG.INJECT_PAGE_BUTTONS,
        tabId: state.tabId,
        enabled,
      }).catch(() => {});
    }
    toast(enabled ? '已开启页面内按钮' : '已关闭页面内按钮');
  });

  $('s-quality').addEventListener('change', (e) => pushSetting({ preferredQuality: e.target.value }));
  $('s-concurrency').addEventListener('change', (e) => {
    const n = Math.min(16, Math.max(1, Number(e.target.value) || 6));
    pushSetting({ concurrency: n });
  });
  $('s-subdir').addEventListener('change', (e) => pushSetting({ downloadSubdir: e.target.value.trim() }));
  $('s-streaming').addEventListener('change', (e) => pushSetting({ streamingSave: e.target.checked }));
  $('s-autosave').addEventListener('change', (e) => {
    pushSetting({ autoSaveCapture: e.target.checked });
    toast(e.target.checked
      ? '已开启：一个视频播完就自动存一段'
      : '已关闭：换视频不会自动存 —— 记得在换之前点「先保存已录到的部分」');
  });
  $('s-autosnap').addEventListener('change', (e) => {
    pushSetting({ autoSnapshotCapture: e.target.checked });
    $('s-autosnap-minutes').disabled = !e.target.checked;
    $('s-autosnap-basis').disabled = !e.target.checked;
    toast(e.target.checked
      ? `已开启：抓流期间每 ${$('s-autosnap-minutes').value} 分钟自动存一份已录到的部分（只留最新一份）`
      : '已关闭：中途出意外就只能靠手动点「先保存已录到的部分」');
  });
  $('s-autosnap-basis').addEventListener('change', (e) => {
    pushSetting({ autoSnapshotBasis: e.target.value });
    toast(e.target.value === 'media'
      ? '改成按「视频内容时长」算：抓到的内容够 N 分钟就存一份（倍速播放时更合你的节奏）'
      : '改成按「录制时间」算：录够 N 分钟就存一份（防意外的口径）');
  });
  $('s-autoexport').addEventListener('change', (e) => {
    pushSetting({ autoExportCapture: e.target.checked });
    toast(e.target.checked
      ? '已开启：以后每存出一份完整产物就自动导出到下载目录（私有存储里那份会保留）'
      : '已关闭自动导出：产物只留在私有存储里，需要自己去管理页点「保存到磁盘」');
  });
  $('s-autosnap-minutes').addEventListener('change', (e) => {
    pushSetting({ autoSnapshotMinutes: Number(e.target.value) });
    toast(`自动保存间隔改成每 ${e.target.value} 分钟（下一次触发就用新值）`);
  });
  $('s-autocut').addEventListener('change', (e) => {
    pushSetting({ autoCutCapture: e.target.checked });
    $('s-autocut-mb').disabled = !e.target.checked;
    toast(e.target.checked
      ? `已开启：抓流攒到 ${$('s-autocut-mb').value} MB 就自动切成一段完整文件，接着往下抓`
      : '已关闭：抓流攒太多时收尾可能失败（合并要一整块内存），接近阈值会提前提醒你');
  });
  $('s-autocut-mb').addEventListener('change', (e) => {
    pushSetting({ autoCutMb: Number(e.target.value) });
    toast(`自动切段的阈值改成 ${e.target.value} MB（正在进行的抓流也会用新值）`);
  });
  $('s-fromcurrent').addEventListener('change', (e) => {
    pushSetting({ captureFromCurrent: e.target.checked });
    toast(e.target.checked
      ? '已开启：抓流从当前进度接着抓（会刷新一次页面，但不用重看）'
      : '已关闭：抓流每次都从头抓一份完整的（3 小时的视频要重看 3 小时）');
  });

  $('record').addEventListener('click', startRecording);
  $('capture').addEventListener('click', startMseCapture);
  // 管理页任何时候都能打开：产物不在下载目录里，没有入口的话用户根本找不到
  $('manage').addEventListener('click', () => openRecorder(null, 'capture'));

  $('merge-go').addEventListener('click', startMerge);
  $('mse-go').addEventListener('click', startMseCapture);

  $('rec-reload').addEventListener('click', () => {
    // 抓流和录制都需要刷新，原因不同但结论一样：
    //   抓流 —— 初始化段（moov）是刷新后重新 append 的，不刷新就捞不到
    //   录制 —— 要把播放位置归零，从头播一遍
    if (state.tabId != null) chrome.tabs.reload(state.tabId).catch(() => {});
    window.close();
  });

  $('rec-stop').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: MSG.RECORD_STOP }).catch(() => null);
    // 收尾中（已经点过一次、或者视频播完在自动收尾）：既不是错误，也还没完成。
    // 说清楚就行 —— 收尾完成后 service worker 会把状态推过来，界面自己会更新。
    if (res?.action === 'finalizing') {
      toast('正在收尾，稍等一下…');
      return;
    }
    if (!res?.ok) {
      toast(res?.error || '停止失败', true);
      return;
    }
    state.record = res.state || null;
    renderRecording();
    const isMse = res.state?.mode === 'mse';
    const real = Number.isFinite(res.mediaSeconds) && res.mediaSeconds > 0
      ? formatClock(res.mediaSeconds * 1000)
      : null;
    // 「其实早就收完了」也是成功：文件在管理页里，别让用户以为白录了
    if (res.action === 'already-finalized') toast('这次录制已经结束了，正打开管理页');
    else toast(finishedToastText(res.state || {}, real));
    // 抓流结束后 service worker 会自己把管理页打开（那才是产物该出现的地方）。
    // 录制这条路没有那个自动动作，所以面板负责把页面送过去。
    if (!isMse) openRecorder(null);
    else window.close();
  });

  // 后台嗅到新东西时实时更新，不用用户手点刷新
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === MSG.MEDIA_UPDATED && msg.tabId === state.tabId) {
      refresh();
    }
    // 只认「推送」。查询自己和别人发出去的 RECORD_STATE 请求里没有 state，
    // 当成推送处理的话会把自己手里的状态清成 undefined。
    if (msg?.type === MSG.RECORD_STATE_PUSH) {
      state.record = msg.state;
      renderRecording();
    }
    if (msg?.type === 'vh:download-failed') {
      toast(`${msg.error} —— ${msg.hint || ''}`, true);
    }
    return false;
  });
}

init().catch((err) => {
  console.error('[vh/popup] 初始化失败：', err);
  $('page-host').textContent = '初始化失败：' + String(err?.message || err);
});
