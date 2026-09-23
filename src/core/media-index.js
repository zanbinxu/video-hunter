/**
 * 已保存产物（抓流 / 录制）的**元信息索引**。
 *
 * ## 为什么需要它
 *
 * 产物本身在 OPFS 里，文件名只是个时间戳（`vh-mse-20260920-013203.mp4`）。
 * 打开管理页时想知道"这个文件多长"只有一个办法：读它。但录制的 moov 在文件
 * **末尾**（顺序写做不到快启动），一个两小时的录制光 moov 就可能上兆 ——
 * 每列一次目录就把几十兆读一遍，是不能接受的。
 *
 * 所以产物一写完，就把真实时长和体积记在这里；管理页读索引，读不到才回退去读文件。
 *
 * ## 为什么单独一份而不是塞进 settings
 *
 * settings 是给用户看的、会被重置成默认值的；这份索引是要跟着文件一起活的
 * 缓存。丢了不会出错（回退到读文件），但也别因为用户点了「恢复默认设置」
 * 就把几十个文件的时长信息一起清掉。
 *
 * 存储适配器是**注入**的，所以这份逻辑可以在 Node 里用假存储测。
 */

/** 索引在 storage.local 里的键 */
export const MEDIA_INDEX_KEY = 'vh:media-index';

/** 默认适配器：扩展里的 chrome.storage.local */
function defaultArea() {
  const area = globalThis.chrome?.storage?.local;
  if (!area) throw new Error('这个环境里没有 chrome.storage.local');
  return area;
}

function normalizeKind(kind) {
  return kind === 'capture' ? 'capture' : 'record';
}

function normalizeSeconds(seconds) {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 造一个索引读写器。
 * @param {{get:Function, set:Function}} [area] 默认用 chrome.storage.local；测试里注入假的
 */
export function createMediaIndex(area = null) {
  const store = () => area || defaultArea();

  async function load() {
    try {
      const key = MEDIA_INDEX_KEY;
      const got = await store().get(key);
      const raw = got?.[key];
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
    } catch {
      // 读不到就当空索引：管理页会退化成"读文件头拿时长"，功能不受影响
      return {};
    }
  }

  async function save(index) {
    try {
      await store().set({ [MEDIA_INDEX_KEY]: index });
      return true;
    } catch {
      return false;
    }
  }

  return {
    load,

    /** 记下（或更新）一个产物的元信息 */
    async remember(entry = {}) {
      const name = entry.name;
      if (!name) return null;
      const index = await load();
      const previous = index[name] || {};
      index[name] = {
        kind: normalizeKind(entry.kind),
        seconds: normalizeSeconds(entry.seconds),
        size: Number.isFinite(entry.size) ? entry.size : null,
        at: Number.isFinite(entry.at) ? entry.at : Date.now(),
        // 「已经导出过」不能让一次重新写盘抹掉 —— 那是用户手上有没有这份文件的凭据，
        // 后面「清理已导出的」就靠它。
        ...(previous.exportedAt ? { exportedAt: previous.exportedAt } : {}),
      };
      await save(index);
      return index[name];
    },

    /** 主动补一个字段（比如管理页为了老文件去读了文件头，读完回填） */
    async patch(name, patch = {}) {
      if (!name) return null;
      const index = await load();
      const cur = index[name] || { kind: 'record', seconds: null, size: null, at: Date.now() };
      index[name] = {
        ...cur,
        ...(patch.seconds !== undefined ? { seconds: normalizeSeconds(patch.seconds) } : {}),
        ...(patch.kind !== undefined ? { kind: normalizeKind(patch.kind) } : {}),
        ...(patch.size !== undefined ? { size: patch.size } : {}),
        // 导出成功的时间点：只有「真的写到你选的位置」才会带上它
        ...(patch.exportedAt !== undefined ? { exportedAt: Number(patch.exportedAt) || null } : {}),
      };
      await save(index);
      return index[name];
    },

    async forget(name) {
      const index = await load();
      if (!(name in index)) return false;
      delete index[name];
      await save(index);
      return true;
    },

    /**
     * 和 OPFS 里真实存在的文件名对齐：文件已经删了的条目要清掉，
     * 否则管理页会一直显示一个不存在的文件。
     * @param {string[]} names 当前实际存在的文件名
     */
    async reconcile(names = []) {
      const index = await load();
      const alive = new Set(names);
      let changed = false;
      for (const name of Object.keys(index)) {
        if (!alive.has(name)) { delete index[name]; changed = true; }
      }
      if (changed) await save(index);
      return index;
    },
  };
}
