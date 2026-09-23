/**
 * 设置读写。放在 core 里，因为 popup 和 service worker 都要用。
 * 只有「受信任上下文」（扩展页面 / service worker）能调，content script 不碰。
 */
import { DEFAULT_SETTINGS, SETTINGS_KEY } from './constants.js';

/** 把存储里的值合并到默认值上，保证永远拿到完整对象 */
export function withDefaults(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (k in DEFAULT_SETTINGS && v !== undefined && v !== null) out[k] = v;
    }
  }
  return out;
}

export async function getSettings() {
  try {
    const got = await chrome.storage.local.get(SETTINGS_KEY);
    return withDefaults(got?.[SETTINGS_KEY]);
  } catch (err) {
    console.warn('[vh/settings] 读取失败，回落到默认值：', err);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = withDefaults({ ...current, ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}
