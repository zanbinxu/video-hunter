/**
 * 用 declarativeNetRequest 的「会话规则」给某个标签页的所有请求注入 Referer。
 *
 * 为什么需要这个：
 *   chrome.downloads 和扩展页面的 fetch 都发不出正确的 Referer，
 *   而 CDN 上的 m3u8 / .ts 几乎都校验 Referer，少一个头就是 403。
 *
 * 为什么不用 chrome.debugger：
 *   debugger 更万能（能改任意请求头），但会在页面顶部挂一条
 *   「Video Hunter 正在调试此浏览器」的横幅，还得单独申请可选权限。
 *   能用会话规则解决的问题，就不该动用 debugger。
 *
 * 规则 ID 的分配方式踩过一次坑，记在这里：
 *   最初用 `9000 + tabId % 2000` 直接算，看着很聪明 —— service worker
 *   被杀掉再唤醒后不用查表就能算出同一条规则去清理。
 *   但它会**碰撞**：同时开着的 1000 号标签页和 5000 号标签页会落到同一个 ID，
 *   后一个把前一个的规则顶掉，表现为「其中一个页面突然开始 403」，
 *   而且完全看不出原因。
 *   现在改成从固定池子里分配 + 把映射持久化到 session storage，
 *   service worker 重启后照样能恢复。
 */

const ID_BASE = 9000;
const POOL_SIZE = 64;
const RULE_MAP_KEY = 'vh:referer-rules';

async function readMap() {
  try {
    const got = await chrome.storage.session.get(RULE_MAP_KEY);
    const map = got?.[RULE_MAP_KEY];
    return (map && typeof map === 'object') ? map : {};
  } catch {
    return {};
  }
}

async function writeMap(map) {
  try {
    await chrome.storage.session.set({ [RULE_MAP_KEY]: map });
  } catch (err) {
    console.warn('[vh/netrules] 规则映射写入失败：', err);
  }
}

/**
 * 给指定标签页挂一条 Referer 改写规则。
 * @param {number} tabId   发起请求的标签页（通常是解析器页自己）
 * @param {string} referer 要伪装成的 Referer
 */
export async function setRefererForTab(tabId, referer) {
  if (!Number.isInteger(tabId) || !referer) {
    return { ok: false, error: '缺少 tabId 或 referer' };
  }

  const map = await readMap();
  let ruleId = map[tabId];

  if (!ruleId) {
    const used = new Set(Object.values(map));
    for (let i = ID_BASE + 1; i <= ID_BASE + POOL_SIZE; i += 1) {
      if (!used.has(i)) { ruleId = i; break; }
    }
    if (!ruleId) {
      // 池子满意味着同时有 64 个页面在下载 —— 现实中几乎不可能，
      // 真发生了就明确报错，而不是随便复用别人的 ID 把人家搞坏。
      return { ok: false, error: `Referer 规则池已满（${POOL_SIZE} 条），先关掉一些下载页面` };
    }
    map[tabId] = ruleId;
    await writeMap(map);
  }

  const rule = {
    id: ruleId,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'referer', operation: 'set', value: referer },
      ],
    },
    condition: {
      tabIds: [tabId],
      resourceTypes: ['xmlhttprequest', 'media', 'other', 'object'],
    },
  };

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [rule],
    });
    return { ok: true, ruleId };
  } catch (err) {
    // 规则没挂上，把 ID 还回池子
    delete map[tabId];
    await writeMap(map);
    return { ok: false, error: String(err?.message || err) };
  }
}

/** 撤掉某标签页的 Referer 规则 */
export async function clearRefererForTab(tabId) {
  const map = await readMap();
  const ruleId = map[tabId];
  if (!ruleId) return { ok: true, released: false };

  delete map[tabId];
  await writeMap(map);

  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
    return { ok: true, released: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/** 清空整个池子（升级 / 启动时清理可能残留的规则） */
export async function resetAllRefererRules() {
  const ids = [];
  for (let i = ID_BASE + 1; i <= ID_BASE + POOL_SIZE; i += 1) ids.push(i);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  } catch (err) {
    console.warn('[vh/netrules] 清理会话规则失败：', err);
  }
  await writeMap({});
}

/** 列出当前生效的会话规则（排查用） */
export async function listSessionRules() {
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    return rules.filter((r) => r.id > ID_BASE && r.id <= ID_BASE + POOL_SIZE);
  } catch {
    return [];
  }
}

export const REFERER_RULE_RANGE = { min: ID_BASE + 1, max: ID_BASE + POOL_SIZE };
