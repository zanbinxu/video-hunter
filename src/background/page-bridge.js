/**
 * 页面桥接：按需注入内容脚本，然后借页面上下文做事。
 *
 * 为什么不常驻注入：
 *   内容脚本常驻在 <all_urls> 上意味着每个标签页每一帧都在跑我们的代码，
 *   光是 MutationObserver 就是持续的 CPU 开销 —— 用户没在用的时候不该付这个钱。
 *   所以只在真正需要时（用户打开面板 / 开始解析）才注入一次。
 */
import { MSG } from '../core/constants.js';

const injected = new Set();

/** 只有普通网页才注入得了。chrome://、扩展页、应用商店、PDF 阅读器都不行。 */
function injectableUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/** 内容脚本在不在？不在就注入。 */
export async function ensureContentScript(tabId, { force = false } = {}) {
  if (!Number.isInteger(tabId) || tabId < 0) return false;
  if (!force && injected.has(tabId)) {
    // 缓存说在，但页面可能已经导航走了 —— 用 ping 确认一次
    const alive = await ping(tabId);
    if (alive) return true;
    injected.delete(tabId);
  }

  // 先看这个标签页是不是普通网页。
  // 不看就注入的话，chrome:// 和扩展自己的页面会抛
  // "Extension manifest must request permission to access this host" ——
  // 虽然被 catch 了不影响功能，但它会往扩展的错误记录里塞垃圾，
  // 用户看到扩展卡片上冒出一个红点却点不出所以然。
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!injectableUrl(tab?.url)) return false;
  } catch {
    return false; // 标签页已经关了
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['src/content/content.js'],
    });
    injected.add(tabId);
    return true;
  } catch (err) {
    console.debug('[vh/bridge] 注入失败：', err?.message || err);
    return false;
  }
}

export async function ping(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: MSG.PAGE_PING });
    return !!res?.ok;
  } catch {
    return false;
  }
}

/**
 * 在页面上下文里抓一个资源 —— Referer / Cookie / Origin 全部天然正确。
 * 适合抓播放列表（小、文本）。分片别走这条路：base64 过消息通道太贵。
 */
export async function pageFetchText(tabId, url) {
  const ok = await ensureContentScript(tabId);
  if (!ok) return { ok: false, error: '内容脚本不可用（页面受限或已关闭）' };
  try {
    return await chrome.tabs.sendMessage(tabId, { type: MSG.PAGE_FETCH, url, as: 'text' });
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/** 扫描页面里的 <video>，拿到 blob: / MSE 这些嗅探层看不到的信息 */
export async function scanPageVideos(tabId) {
  const ok = await ensureContentScript(tabId);
  if (!ok) return { ok: false, error: '内容脚本不可用', videos: [] };
  try {
    return await chrome.tabs.sendMessage(tabId, { type: MSG.PAGE_SCAN });
  } catch (err) {
    return { ok: false, error: String(err?.message || err), videos: [] };
  }
}

/** 开关页面内下载按钮 */
export async function setPageButtons(tabId, enabled) {
  const ok = await ensureContentScript(tabId);
  if (!ok) return { ok: false, error: '内容脚本不可用' };
  try {
    await chrome.tabs.sendMessage(tabId, { type: MSG.INJECT_PAGE_BUTTONS, enabled });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/** 让页面进入录制待命：回到第一帧、开播、盯着播放结束 */
export async function armRecording(tabId) {
  const ok = await ensureContentScript(tabId);
  if (!ok) return { ok: false, error: '内容脚本不可用（页面受限或已关闭）' };
  try {
    return await chrome.tabs.sendMessage(tabId, { type: MSG.ARM_RECORDING });
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/* ------------------------------------------------------------------ *
 * 录制助手：让内容脚本在**页面重载之后**依然在
 *
 * 内容脚本平时是按需注入的 —— 刷新一下页面就没了。而录制兜底的流程
 * 恰恰要求刷新（视频要从头播）。所以录制期间临时注册一份针对该站点
 * 的持久内容脚本，录制结束后立刻注销。
 *
 * 只注册目标站点这一个匹配模式，不是全站；而且 persistAcrossSessions
 * 是 false，浏览器重启不会留着。
 * ------------------------------------------------------------------ */

const RECORDER_SCRIPT_ID = 'vh-recorder-helper';

function matchPatternFor(pageUrl) {
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return '';
  }
}

export async function registerRecordingHelper(pageUrl) {
  const pattern = matchPatternFor(pageUrl);
  if (!pattern) return { ok: false, error: '页面地址不可用于注册内容脚本' };
  try {
    // 先清一次：上一次录制如果异常退出，可能留下同名脚本
    await chrome.scripting.unregisterContentScripts({ ids: [RECORDER_SCRIPT_ID] }).catch(() => {});
    await chrome.scripting.registerContentScripts([{
      id: RECORDER_SCRIPT_ID,
      matches: [pattern],
      js: ['src/content/content.js'],
      runAt: 'document_idle',
      allFrames: false,
      persistAcrossSessions: false,
    }]);
    // 注册成功之后 injected 缓存就失效了（页面重载会由浏览器自动注入）
    return { ok: true, pattern };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

export async function unregisterRecordingHelper() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [RECORDER_SCRIPT_ID] });
    return { ok: true };
  } catch {
    // 本来就没注册时 unregister 会抛，这不算错误
    return { ok: true };
  }
}

/* ------------------------------------------------------------------ *
 * MSE 钩子：注册成**主世界**的持久脚本
 *
 * 一次性的 executeScript 注入在页面刷新后就没了 —— 而抓流恰恰可能
 * 需要用户刷新（把视频从头播一遍）。所以注册成持久脚本，抓流结束再注销。
 *
 * world: 'MAIN' 是关键：SourceBuffer 是页面 JS 持有的对象，
 * 隔离世界钩不到它的调用。
 * ------------------------------------------------------------------ */

const MSE_HOOK_ID = 'vh-mse-hook';
const MSE_BRIDGE_ID = 'vh-mse-bridge';

export async function registerMseHook(pageUrl) {
  const pattern = matchPatternFor(pageUrl);
  if (!pattern) return { ok: false, error: '页面地址不可用于注册脚本' };
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [MSE_HOOK_ID, MSE_BRIDGE_ID] }).catch(() => {});
    await chrome.scripting.registerContentScripts([
      {
        // 主世界的钩子：SourceBuffer 是页面 JS 持有的对象，隔离世界钩不到
        id: MSE_HOOK_ID,
        matches: [pattern],
        js: ['src/content/mse-hook.js'],
        runAt: 'document_start', // 越早越好：晚了可能错过 MediaSource 的创建
        allFrames: false,
        world: 'MAIN',
        persistAcrossSessions: false,
      },
      {
        // 隔离世界的桥：把钩子递过来的字节编码后转交扩展。
        // 它也必须持久 —— 页面刷新后钩子会重新注入，但没人转交就白搭。
        id: MSE_BRIDGE_ID,
        matches: [pattern],
        js: ['src/content/content.js'],
        runAt: 'document_start',
        allFrames: false,
        persistAcrossSessions: false,
      },
    ]);
    return { ok: true, pattern };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

export async function unregisterMseHook() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [MSE_HOOK_ID, MSE_BRIDGE_ID] });
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

/** 标签页导航走了，忘掉注入状态 */
export function forgetTab(tabId) {
  injected.delete(tabId);
}
