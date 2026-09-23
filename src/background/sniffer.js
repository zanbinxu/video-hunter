/**
 * 媒体嗅探层。
 *
 * 三级 webRequest 事件拼出一条完整记录：
 *
 *   onBeforeRequest      → 拿到 url / type / initiator（此时还不知道是不是媒体）
 *   onBeforeSendHeaders  → 拿到 Referer / Origin / Range（重新抓取时靠它还原现场）
 *   onHeadersReceived    → 拿到 Content-Type / Content-Length / Content-Range
 *                          ← 只有到这一步才能确定「这是不是媒体」
 *
 * 之所以要攒一个 pending map，是因为 Chrome 不会把这几步的信息合在一个事件里给你。
 * 而 Referer 这一步特别关键：一个 m3u8 的分片往往要求 Referer 是页面地址，
 * 少了它就 403。嗅探时顺手记下来，后面分片下载才能成功。
 */
import { classify, isInteresting, hashUrl } from '../core/classify.js';
import { IGNORED_REQUEST_TYPES, MSG } from '../core/constants.js';
import * as store from '../core/store.js';

/** requestId -> 半成品记录。有上限，防止长会话内存无限涨。 */
const pending = new Map();
const MAX_PENDING = 5000;

/** tabId -> { url, title }，给嗅探结果补上「是哪一页在播」 */
const tabInfo = new Map();

function broadcast(payload) {
  // popup 可能没开着 —— 这种情况下 Chrome 会 reject，属于正常情况，吞掉
  chrome.runtime.sendMessage(payload).catch(() => {});
}

/** 解析 Content-Range: bytes 0-1023/1234567 → 1234567 */
function totalFromContentRange(value) {
  const m = /\/(\d+)\s*$/.exec(String(value || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function onBeforeRequest(d) {
  if (d.tabId == null || d.tabId < 0) return;
  if (IGNORED_REQUEST_TYPES.has(d.type)) return;
  if (pending.size >= MAX_PENDING) pending.clear();
  pending.set(d.requestId, {
    url: d.url,
    tabId: d.tabId,
    type: d.type,
    initiator: d.initiator || '',
    frameId: d.frameId,
    startedAt: Date.now(),
  });
}

function onBeforeSendHeaders(d) {
  const p = pending.get(d.requestId);
  if (!p) return;
  for (const h of d.requestHeaders || []) {
    const name = String(h.name || '').toLowerCase();
    if (name === 'referer') p.referer = h.value || '';
    else if (name === 'origin') p.origin = h.value || '';
    else if (name === 'range') p.range = h.value || '';
  }
}

function onBeforeRedirect(d) {
  const p = pending.get(d.requestId);
  if (p && d.redirectUrl) p.url = d.redirectUrl;
}

async function onHeadersReceived(d) {
  const p = pending.get(d.requestId);
  if (!p) return;

  let mime = '';
  let size = null;
  let totalSize = null;
  let disposition = '';
  let acceptRanges = '';
  for (const h of d.responseHeaders || []) {
    const name = String(h.name || '').toLowerCase();
    if (name === 'content-type') mime = h.value || '';
    else if (name === 'content-length') {
      const v = Number.parseInt(h.value, 10);
      if (Number.isFinite(v)) size = v;
    } else if (name === 'content-range') {
      totalSize = totalFromContentRange(h.value);
    } else if (name === 'content-disposition') {
      disposition = h.value || '';
    } else if (name === 'accept-ranges') {
      acceptRanges = h.value || '';
    }
  }

  const info = classify({ url: d.url, mime, disposition, requestType: p.type });
  if (!isInteresting(info)) return;

  const tab = tabInfo.get(p.tabId) || {};
  const entry = {
    id: hashUrl(d.url),
    url: d.url,
    tabId: p.tabId,
    frameId: p.frameId,
    kind: info.kind,
    ext: info.ext,
    container: info.container,
    mime: info.mime,
    confidence: info.confidence,
    isPlaylist: info.isPlaylist,
    isSegment: info.isSegment,
    isAudioOnly: info.isAudioOnly,
    downloadable: info.downloadable,
    reason: info.reason,
    statusCode: d.statusCode ?? null,
    // 分片响应（206）的 Content-Length 只是这一段的长度，不能当整体大小用
    size: d.statusCode === 206 ? (totalSize ?? null) : (totalSize ?? size),
    contentDisposition: disposition,
    acceptRanges,
    referer: p.referer || '',
    origin: p.origin || '',
    initiator: p.initiator || '',
    requestType: p.type,
    pageUrl: tab.url || '',
    pageTitle: tab.title || '',
    seenAt: Date.now(),
  };

  try {
    const { isNew } = await store.upsert(p.tabId, entry);
    if (isNew) {
      broadcast({ type: MSG.MEDIA_UPDATED, tabId: p.tabId, entry });
    }
  } catch (err) {
    console.warn('[vh/sniffer] 写入失败：', err);
  }
}

function cleanup(d) {
  pending.delete(d.requestId);
}

/** 注册所有嗅探监听。必须在 service worker 顶层同步调用。 */
export function initSniffer() {
  const filter = { urls: ['<all_urls>'] };

  chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, filter);
  chrome.webRequest.onBeforeRedirect.addListener(onBeforeRedirect, filter);

  // extraHeaders 能拿到 Referer/Origin；万一这个平台不认，退一步只拿普通头。
  try {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      onBeforeSendHeaders, filter, ['requestHeaders', 'extraHeaders'],
    );
  } catch (err) {
    console.info('[vh/sniffer] extraHeaders 不可用，退化注册：', err);
    chrome.webRequest.onBeforeSendHeaders.addListener(
      onBeforeSendHeaders, filter, ['requestHeaders'],
    );
  }

  chrome.webRequest.onHeadersReceived.addListener(
    onHeadersReceived, filter, ['responseHeaders'],
  );

  chrome.webRequest.onCompleted.addListener(cleanup, filter);
  chrome.webRequest.onErrorOccurred.addListener(cleanup, filter);

  // ---- 标签页元信息 ----
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const cur = tabInfo.get(tabId) || {};
    tabInfo.set(tabId, {
      url: changeInfo.url || tab?.url || cur.url || '',
      title: tab?.title || cur.title || '',
    });
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    tabInfo.delete(tabId);
    store.dropTab(tabId);
  });

  chrome.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId !== 0) return;
    const prev = tabInfo.get(d.tabId) || {};
    tabInfo.set(d.tabId, { url: d.url, title: prev.title || '' });
    // 真正换了文档才清空。SPA 的 pushState 走 onHistoryStateUpdated，不会触发这里，
    // 所以单页应用里嗅到的媒体列表不会被误清。
    store.clear(d.tabId);
    broadcast({ type: MSG.MEDIA_UPDATED, tabId: d.tabId, reset: true });
  });

  chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
    if (d.frameId !== 0) return;
    const prev = tabInfo.get(d.tabId) || {};
    tabInfo.set(d.tabId, { url: d.url, title: prev.title || '' });
  });
}

/** 给别的模块（下载、解析）取页面现场信息 */
export function getPageInfo(tabId) {
  return tabInfo.get(tabId) || { url: '', title: '' };
}
