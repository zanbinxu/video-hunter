/**
 * 按标签页归档的媒体条目存储。
 *
 * 为什么不用一个普通 Map 就完事？
 * 因为 MV3 的 service worker 随时会被杀。任何只活在内存里的嗅探结果，
 * 在用户切个标签页回来之后就没了。所以：
 *
 *   内存 Map（快） → chrome.storage.session（扛 SW 重启）
 *
 * 写入做了 250ms 防抖：一个 HLS 会话能刷出几千个 .ts 请求，
 * 每个都全量写一遍 session storage 会把自己写死。
 * 需要立刻拿到最新数据的调用方（popup）走 flush() 而不是干等防抖。
 */
import { TAB_KEY_PREFIX, KIND } from './constants.js';

const FLUSH_DELAY_MS = 250;

/**
 * 单个标签页最多保留多少条记录。
 *
 * chrome.storage.session 的配额是 10MB。一个跑了几小时的 HLS 直播会话能刷出
 * 上万条分片记录（每条还带着 URL、Referer、Content-Type），很容易超。
 * 超了之后**所有**写入都会失败 —— 包括那条真正有价值的播放列表记录。
 * 所以宁可丢掉最老的分片，也要保住列表本身。
 */
const MAX_ENTRIES_PER_TAB = 4000;
const TRIM_DOWN_TO = 3000;

/** @type {Map<number, {entries: Map<string, object>, loaded: boolean, dirty: boolean, timer: any, chain: Promise<void>}>} */
const tabs = new Map();

function bucket(tabId) {
  let b = tabs.get(tabId);
  if (!b) {
    b = { entries: new Map(), loaded: false, dirty: false, timer: null, chain: Promise.resolve() };
    tabs.set(tabId, b);
  }
  return b;
}

function storageKey(tabId) {
  return `${TAB_KEY_PREFIX}${tabId}`;
}

/** 确保该标签页的数据已经从 storage.session 载入内存 */
async function ensureLoaded(tabId) {
  const b = bucket(tabId);
  if (b.loaded) return b;
  try {
    const key = storageKey(tabId);
    const got = await chrome.storage.session.get(key);
    const arr = got?.[key];
    if (Array.isArray(arr)) {
      for (const e of arr) {
        if (e && e.id) b.entries.set(e.id, e);
      }
    }
  } catch (err) {
    console.warn('[vh/store] 载入 session storage 失败：', err);
  }
  b.loaded = true;
  return b;
}

/** 把内存状态写回 storage.session；同一标签页的写入串行化，避免互相覆盖 */
function persist(tabId) {
  const b = bucket(tabId);
  b.dirty = false;
  const payload = [...b.entries.values()];
  b.chain = b.chain.then(async () => {
    try {
      await chrome.storage.session.set({ [storageKey(tabId)]: payload });
    } catch (err) {
      console.warn('[vh/store] 写入 session storage 失败：', err);
    }
  });
  return b.chain;
}

function schedulePersist(tabId) {
  const b = bucket(tabId);
  b.dirty = true;
  if (b.timer) return;
  b.timer = setTimeout(() => {
    b.timer = null;
    if (b.dirty) persist(tabId);
  }, FLUSH_DELAY_MS);
}

/**
 * 丢掉最老的分片记录，把总量压回阈值以下。
 * 只丢 SEGMENT —— 播放列表、完整文件、音频这些是用户真正的目标，
 * 丢一个分片记录只是少一条噪声，丢一条播放列表就是功能没了。
 */
function trimSegments(b) {
  const segments = [...b.entries.values()]
    .filter((e) => e.kind === KIND.SEGMENT)
    .sort((a, z) => (a.seenAt || 0) - (z.seenAt || 0));
  const removeCount = b.entries.size - TRIM_DOWN_TO;
  for (let i = 0; i < removeCount && i < segments.length; i += 1) {
    b.entries.delete(segments[i].id);
  }
}

/**
 * 插入或更新一条媒体记录。
 * @returns {Promise<{entry: object, isNew: boolean}>}
 */
export async function upsert(tabId, entry) {
  if (!Number.isInteger(tabId) || tabId < 0) return { entry, isNew: false };
  const b = await ensureLoaded(tabId);
  const prev = b.entries.get(entry.id);
  const merged = prev ? { ...prev, ...entry, firstSeenAt: prev.firstSeenAt, hits: (prev.hits || 1) + 1 } : { ...entry, firstSeenAt: entry.seenAt, hits: 1 };
  b.entries.set(merged.id, merged);
  if (b.entries.size > MAX_ENTRIES_PER_TAB) trimSegments(b);
  schedulePersist(tabId);
  return { entry: merged, isNew: !prev };
}

/** 取某个标签页的全部条目，按时间倒序 */
export async function list(tabId) {
  const b = await ensureLoaded(tabId);
  return [...b.entries.values()].sort((a, z) => (z.seenAt || 0) - (a.seenAt || 0));
}

/** 取某条 */
export async function get(tabId, id) {
  const b = await ensureLoaded(tabId);
  return b.entries.get(id) || null;
}

/** 清空某标签页 */
export async function clear(tabId) {
  const b = bucket(tabId);
  b.entries.clear();
  b.loaded = true;
  b.dirty = false;
  if (b.timer) { clearTimeout(b.timer); b.timer = null; }

  // 删除也必须排进同一条串行链。
  //
  // 之前这里是直接 `chrome.storage.session.remove()`，结果：如果清空前刚好
  // 有一次防抖中的 `set()` 在途（导航清空、或者 popup 点「清空」时最容易碰上），
  // 两次 IPC 的完成顺序没有保证 —— set 落在 remove 之后，数据又回来了。
  // 本进程因为 loaded=true 看不出来，但 service worker 被杀重启后
  // ensureLoaded() 会把上一个页面的条目读回来。
  b.chain = b.chain.then(async () => {
    try {
      await chrome.storage.session.remove(storageKey(tabId));
    } catch (err) {
      console.warn('[vh/store] 清理 session storage 失败：', err);
    }
  });
  await b.chain;
}

/** 标签页关闭时彻底回收 */
export async function dropTab(tabId) {
  const b = tabs.get(tabId);
  if (b?.timer) clearTimeout(b.timer);
  tabs.delete(tabId);
  try { await chrome.storage.session.remove(storageKey(tabId)); } catch { /* ignore */ }
}

/** 立即落盘（popup 查询前调用，保证不丢刚嗅到的条目） */
export async function flush(tabId) {
  const b = bucket(tabId);
  if (b.timer) { clearTimeout(b.timer); b.timer = null; }
  if (b.dirty) await persist(tabId);
  await b.chain;
}

/** 标签页导航走了 —— 仅清内存，保留 storage 里的旧数据由调用方决定 */
export function resetMemory(tabId) {
  const b = tabs.get(tabId);
  if (b?.timer) clearTimeout(b.timer);
  tabs.delete(tabId);
}
