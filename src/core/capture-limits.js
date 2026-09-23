/**
 * 抓流/录制的**命名规则与限额判据** —— 全是纯函数，零依赖（连 chrome.* 都不碰）。
 *
 * ## 为什么从 pipeline.js 里搬出来
 *
 * 这些函数原来住在 `src/offscreen/pipeline.js`（录制管线，顶部 `import` 了
 * mp4-muxer）。可是用它们的**不止离屏文档**：
 *
 *   · `service-worker.js` 只要一个"分钟 → 毫秒"的换算；
 *   · `recorder.js`（管理页）只要一个"这文件名是不是自动保存的那份"；
 *   · 解析器页/面板也会读限额。
 *
 * 于是这三个页面/worker 为了一个纯函数，**各自把 70 KB 的 mp4-muxer 也加载了**
 * —— service worker 本来就被内存和冷启动时间卡着，管理页更是完全用不到那东西。
 * 判据、命名、限额是一次性的规则，放在 core 里，谁都能拿，谁都不必背上封装器。
 */
import { CAPTURE_PREFIX } from './constants.js';
import { sanitizeSegment } from './filename.js';

/* ------------------------------------------------------------------ *
 * 命名
 * ------------------------------------------------------------------ */

export function align2(n) {
  const v = Math.max(2, Math.round(n || 0));
  return v % 2 === 0 ? v : v + 1;
}

export function fileStamp(date = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/**
 * 标题末尾那种「 - 站点名」，产物文件名里没必要带。
 *
 * 只认**白名单**，不做"最后一段是 `- xx` 就去掉"这种通用规则：
 * 后者会把《星球大战 - 新希望》削成《星球大战》。站点名可以穷举，电影名不行。
 */
const TITLE_SITE_SUFFIX = [
  'youtube', 'youtube music', 'bilibili', '哔哩哔哩', 'b站', '腾讯视频', '爱奇艺', '优酷',
  '芒果tv', '抖音', '西瓜视频', '微博', 'vimeo', 'dailymotion', 'netflix', 'twitch',
];

/**
 * 文件名里那一段标题。
 *
 * 为什么值得带：`vh-mse-20260921-003641.mp4` 这种名字，用户过两天打开
 * 下载目录根本认不出哪个是哪一集。带上视频标题就能直接认。
 *
 * 三条约束：
 *   1. **必须保留 `vh-mse-` 前缀**（放最前面）—— 管理页靠前缀把产物分成
 *      「抓流文件 / 录制文件」两组，前缀跑掉了文件就会归错组；
 *   2. 标题里什么字符都可能有，所以走 `sanitizeSegment`；
 *   3. 长度要压住（这里 48 字），否则一个长标题就能把路径顶爆。
 *
 * @param {string} title 页面标题（可能为空、可能是站点名）
 * @returns {string} 形如 `标题-`；没有可用标题时返回空串
 */
export function titlePart(title) {
  let raw = String(title ?? '').trim();
  if (!raw) return '';
  // 剥掉末尾的「 - YouTube」这类站点后缀（只认白名单，见上）
  const m = raw.match(/^(.*?)\s+[-–—|]\s+([^-–—|]{1,20})$/);
  if (m && TITLE_SITE_SUFFIX.includes(m[2].trim().toLowerCase())) raw = m[1].trim();
  // 标题就是站点名时（"YouTube"）没信息量，不如不加
  if (TITLE_SITE_SUFFIX.includes(raw.toLowerCase())) return '';
  const cleaned = sanitizeSegment(raw, 48);
  if (!cleaned || cleaned === 'unnamed' || cleaned.length < 2) return '';
  return `${cleaned}-`;
}

/**
 * 抓流产物的文件名。
 *
 * 一次抓流会话可能产出**多个**文件：换集、自动连播，或者**攒得太大自动切段**
 * （见下面 captureCutThresholdBytes）。所以必须带序号 —— 不带的话，两次收尾
 * 落在同一秒里（时间戳只精确到秒）后一个会把前一个**覆盖掉**，用户莫名少一个文件。
 *
 * 名字的形状固定是 `vh-mse-<标题>-<时间戳>[-序号].<扩展名>`：
 * 前缀在最前（管理页靠它分组）、标题紧跟在前缀后、时间戳和序号垫后。
 *
 * @param {string} stamp fileStamp() 的结果
 * @param {number} part 第几段，从 1 开始
 * @param {string} [title] 页面标题；带上它，用户过两天也认得出哪个是哪个
 * @param {string} [ext] 扩展名（默认 mp4；全是 WebM 的流会存成 webm）
 */
export function captureFileName(stamp, part = 1, title = '', ext = 'mp4') {
  return `${CAPTURE_PREFIX}${titlePart(title)}${stamp}${part > 1 ? `-${part}` : ''}.${ext}`;
}

/**
 * 「先保存已录到的部分」的文件名。
 *
 * 和上面那个分开：`-部分` 表示**视频还没播完**（用户随时拿走一份），
 * 不带 `-部分` 的才是"这个视频完整收尾了"。混用会让"哪几个是完整视频"
 * 变得看不出来。
 */
export function partialCaptureFileName(stamp, title = '', ext = 'mp4') {
  return `${CAPTURE_PREFIX}${titlePart(title)}${stamp}-部分.${ext}`;
}

/**
 * 自动保存（滚动覆盖）的文件名。
 *
 * 刻意和手动那份**区分开**：手动点的那份谁都不许动，自动的这份会被下一次覆盖。
 * 名字里带 `-自动部分`，用户在列表里一眼能看出哪一份是可以被覆盖的。
 */
export function autoSnapshotFileName(stamp, title = '', ext = 'mp4') {
  return `${CAPTURE_PREFIX}${titlePart(title)}${stamp}-自动部分.${ext}`;
}

/** 从文件名判断它是不是"自动保存的那一份"（清理时用文件名判断，不依赖内存记录） */
export function isAutoSnapshotName(name) {
  return /-自动部分\.(mp4|webm)$/.test(String(name || ''));
}

/* ------------------------------------------------------------------ *
 * 限额与判据
 * ------------------------------------------------------------------ */

/**
 * 自动保存这一次该不该动手。
 *
 * 抽成纯函数是因为**这些"不该动手"的理由都会真实发生**，而每一条都要有名字：
 *   · `off`            用户没开这个功能
 *   · `retry-pending`  上一次收尾写盘失败了，数据还攥在手里等用户腾空间 ——
 *                      这时候再写盘只会再失败一次，还容易把待保存的那份搅乱
 *   · `empty`          还没抓到任何数据（刚开抓流的前几秒）
 *   · `not-yet`        还没到间隔
 *   · `unchanged`      和上一份自动保存的内容**一模一样**（播放暂停着没动）——
 *                      重复写一份一样的文件纯属白占空间
 *
 * ## 「每 N 分钟」有两种口径（用户报的）
 *
 *   · `basis: 'wall'`  **挂钟**：你录了 N 分钟。这是"防意外"的口径 ——
 *     崩了最多丢 N 分钟的**投入**。
 *   · `basis: 'media'` **视频内容**：抓到的内容有 N 分钟长。用倍速插件播的时候
 *     两者能差好几倍（4 倍速下挂钟 10 分钟 = 内容 40 分钟），用户要的是后者。
 *
 * `media` 口径拿不到媒体时间戳时（WebM 那种没有 tfdt 的流）**回落成挂钟** ——
 * 绝不能因为"量不出来"就永远不保存，那等于把安全网拆掉。
 *
 * @returns {'write'|'off'|'retry-pending'|'empty'|'not-yet'|'unchanged'}
 */
export function autoSnapshotPlan({
  enabled, awaitingRetry, chunks, bytes, last,
  basis = 'wall', elapsedMs = 0, mediaSeconds = null, intervalMs = 0,
} = {}) {
  if (!enabled) return 'off';
  if (awaitingRetry) return 'retry-pending';
  if (!(chunks > 0)) return 'empty';
  if (basis === 'media' && Number.isFinite(mediaSeconds)) {
    if (!(mediaSeconds >= intervalMs / 1000)) return 'not-yet';
  } else if (!(elapsedMs >= intervalMs)) {
    return 'not-yet';
  }
  if (last && last.chunks === chunks && last.bytes === bytes) return 'unchanged';
  return 'write';
}

/**
 * 间隔（分钟）→ 毫秒，顺带夹一下范围。
 *
 * 界面上只给 5 / 10 / 30 三档，但这里**不写死那几个值**：自动化测试要把间隔调到
 * 几秒钟，才能验"到点真的会存、而且只留最新一份"。一个验不了的功能等于没有 ——
 * 所以范围放宽到 0.05 分钟（3 秒）~ 120 分钟。
 */
export function autoSnapshotIntervalMs(minutes) {
  const value = Number(minutes);
  const safe = Number.isFinite(value) ? Math.min(120, Math.max(0.05, value)) : 10;
  return Math.round(safe * 60_000);
}

/**
 * 抓流「攒得太大就先切一段」的阈值（字节）。
 *
 * ## 为什么必须有个数（实测出来的）
 *
 * 抓流是把码流先**全收在内存里**、收尾时再交给 mp4-muxer 合成一整块。
 * 实测（渲染进程里）：单次 `ArrayBuffer` 分配 1536 MB 还能成，2048 MB 直接
 * `RangeError`；而 muxer 写输出时内部会**翻倍扩容**（`ensureSize`），再加上
 * 采集分块 → 拼接片段 → 样本切片这几份同时在内存里，抓到的数据超过 ~1 GB
 * 基本就收不了尾了。
 *
 * 更糟的是"滚动自动保存"写的是**当前整个缓冲**：超过这个量之后它也开始失败，
 * 而失败只写 console —— 等于安全网在最需要它的时候悄悄失效。
 *
 * 所以默认到 600 MB 就自动切一段（这个数抄的是直播那条路已有的
 * `LIVE_MEMORY_LIMIT`：同一个"内存吃不下"的判断，不另立一套标准）。
 *
 * 下限放到 0.05 MB：界面上只给几档，但自动化测试要把阈值调到极小才能验
 * "真的会切"——一个验不了的功能等于没有（同 autoSnapshotIntervalMs）。
 */
export function captureCutThresholdBytes(mb) {
  const value = Number(mb);
  const safe = Number.isFinite(value) ? Math.min(4096, Math.max(0.05, value)) : 600;
  return Math.round(safe * 1024 * 1024);
}

/**
 * 这一次心跳该不该自动切段。
 *
 * 每一条"不该切"的理由都要有名字（理由同 `autoSnapshotPlan`）：
 *   · `off`           用户关掉了这个功能
 *   · `retry-pending` 上一次收尾写盘失败了，数据还攥在手里等用户腾空间 ——
 *                     这时候切段只会再失败一次，还可能把待保存的那份搅乱
 *   · `cutting`       上一段还在写（写盘是异步的，心跳一秒一次）
 *   · `empty`         还没抓到数据
 *   · `below`         还没到阈值（绝大多数心跳都是这个）
 *
 * @returns {'cut'|'off'|'retry-pending'|'cutting'|'empty'|'below'}
 */
export function captureCutPlan({ enabled, awaitingRetry, cutting, chunks, bytes, threshold } = {}) {
  if (!enabled) return 'off';
  if (awaitingRetry) return 'retry-pending';
  if (cutting) return 'cutting';
  if (!(chunks > 1)) return 'empty';
  if (!(Number(bytes) >= Number(threshold))) return 'below';
  return 'cut';
}

/**
 * 接近阈值时给用户的一句话（到阈值之前先提醒），`null` = 不用提醒。
 *
 * 为什么要提前说：切段是"把用户的一个视频变成两个文件"，他该在发生前就知道，
 * 而不是事后在列表里发现多了个文件。
 */
export function captureSizeNotice({ enabled, bytes, threshold } = {}) {
  const limit = Number(threshold) || 0;
  const got = Number(bytes) || 0;
  if (!limit || got < limit * 0.75) return null;
  const mb = (n) => Math.round(n / 1048576);
  if (enabled) {
    return `这次已经攒到 ${mb(got)} MB（到 ${mb(limit)} MB 会自动切成一段，`
      + '不然收尾时内存吃不下）—— 切出来的每段都是完整文件，按文件名顺序就是完整内容';
  }
  return `这次已经攒到 ${mb(got)} MB，而"攒太大自动切段"是关着的：`
    + '再大下去收尾时很可能失败（合并要一整块内存）。建议现在点「先保存已录到的部分」，'
    + '然后重新开一段接着抓。';
}
