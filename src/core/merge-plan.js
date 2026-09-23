/**
 * 「这个页面上到底有没有可以合并的轨道」—— 面板上那条提示条的唯一判据。
 *
 * ## 为什么单独抽一个纯函数
 *
 * 面板原来写的是 `standalone.length >= 2`（独立分片条数 ≥ 2）就显示
 * 「检测到 N 条独立轨道 · 可自动合并」。两个方向的错都有：
 *
 *   · **B 站那种形态被漏掉**：它的视频轨是 `video/mp4` 的 `.m4s`
 *     （分类成 SEGMENT），音频轨是 `audio/mp4` 的 `.m4s` —— 分类器先看 MIME，
 *     于是音频落进了 `AUDIO` 而不是 `SEGMENT`，**不算在 standalone 里**。
 *     结果面板认为只有 1 条轨道，可提示条又是显示的（详见 popup.css 里
 *     `[hidden]` 那条注释），点下去只会得到一句「至少要有两条轨道才能合并」。
 *   · **两条视频轨被当成"可合并"**：合并器只取体积最大的那条视频 + 最大的那条音频，
 *     两条视频喂进去只会丢掉一条，却什么都不说。
 *
 * 真实判据（也就是解析器页真正会做的事，见 `startMergeDownload`）：
 * 至少要有一条**视频轨**，音频轨可有可无（没有就出无声 MP4）。所以这里
 * 按"看出来是什么轨"分三类（视频 / 音频 / 看不出），并把结果说成人话。
 *
 * 纯函数，不碰 chrome.* / DOM，可以直接在 Node 里单测。
 */
import { KIND } from './constants.js';
import { formatBytes, extOf } from './classify.js';

/** fMP4 分片常见的扩展名（与 classify.js 里那张表保持一致） */
const FMP4_EXT = new Set(['m4s', 'cmfv', 'cmfa', 'cmft', 'mp4v', 'mp4a']);

function mimeOf(item) {
  return String(item?.mime || '').split(';')[0].trim().toLowerCase();
}

/**
 * 这条嗅探记录像不像"一条能参与合并的轨道"（而不是一个完整的可下载文件）。
 *
 * 返回 `'video' | 'audio' | 'unknown' | null`。`null` = 不参与合并，
 * 包括：完整 MP4 文件（直接下载即可）、页面 `<video>` 条目（没有真地址）、
 * MPEG-TS、以及各种页面音效。
 *
 * 为什么这么保守：合并这条路（`splitSelfContainedFmp4` + `mergeFmp4`）
 * **只吃 fMP4**（要 moov + moof）。把 `.ts` 或者完整的 `.mp4` 混进去，
 * 解析器只会报"这条解析不了"——那又是一次"说能合、点下去不行"。
 */
export function trackKindOf(item) {
  if (!item || !item.url || item.video) return null;
  // 播放列表自己的分片不算：那是播放列表那条路的事（调用方用 hasPlaylist 挡住）
  if (item.kind === KIND.HLS || item.kind === KIND.DASH) return null;

  const mime = mimeOf(item);
  const ext = extOf(item.url);
  const fmp4 = FMP4_EXT.has(ext);

  // MPEG-TS 先挡掉：合并这条路要 moov + moof，TS 一条分片都过不了
  if (mime === 'video/mp2t') return null;

  if (mime.startsWith('audio/')) {
    // `audio/mp4` 是真实站点给音频轨的 MIME（B 站就是），扩展名却可能是 `.mp4`
    return fmp4 || mime === 'audio/mp4' ? 'audio' : null;
  }
  if (mime.startsWith('video/')) {
    if (mime !== 'video/mp4' && mime !== 'video/quicktime') return fmp4 ? 'video' : null;
    // `video/mp4` 有两种：完整文件（直接下载就行）和分片（分类成 SEGMENT，要合并）
    return (fmp4 || item.kind === KIND.SEGMENT) ? 'video' : null;
  }
  // 没有 MIME 佐证时只认扩展名 —— 而且只认 `.m4s` 这类 fMP4 分片
  if (item.kind === KIND.SEGMENT && fmp4) return 'unknown';
  return null;
}

/**
 * 算出「要不要显示合并提示条、写什么字、点了合并哪些轨道」。
 *
 * @param {object} input
 * @param {boolean} input.hasPlaylist 页面上有 m3u8/mpd 时合并这条路不该出现
 *                                    （那种流的分片属于播放列表，走播放列表下载）
 * @param {object[]} input.standalone 没有配套播放列表的独立分片
 * @param {object[]} input.files      独立文件/音频条目（B 站的音频轨落在这里）
 * @returns {{show:boolean, canMerge:boolean, text:string, tracks:object[],
 *            videoCount:number, audioCount:number, unknownCount:number, bytes:number}}
 */
export function planMerge({ hasPlaylist = false, standalone = [], files = [] } = {}) {
  const none = {
    show: false, canMerge: false, text: '', tracks: [],
    videoCount: 0, audioCount: 0, unknownCount: 0, bytes: 0,
  };
  if (hasPlaylist) return none;

  // 同一条地址可能被请求多次（预取、Range、重试），合并任务里只该出现一次
  const seen = new Set();
  const picks = [];
  for (const item of [...standalone, ...files]) {
    const type = trackKindOf(item);
    if (!type || seen.has(item.url)) continue;
    seen.add(item.url);
    picks.push({ item, type });
  }
  if (!picks.length) return none;

  const count = (t) => picks.filter((p) => p.type === t).length;
  const videoCount = count('video');
  const audioCount = count('audio');
  const unknownCount = count('unknown');
  const bytes = picks.reduce((n, p) => n + (p.item.size || 0), 0);
  const sizeText = bytes ? `（约 ${formatBytes(bytes)}）` : '';
  const tracks = picks.map((p) => p.item);

  // ① 视频 + 音频都有：最标准的"无清单 DASH"，说清楚各有几条
  if (videoCount && audioCount) {
    const unknownText = unknownCount ? ` + ${unknownCount} 条看不出类型` : '';
    return {
      show: true, canMerge: true, tracks,
      videoCount, audioCount, unknownCount, bytes,
      text: `检测到 ${videoCount} 条视频轨 + ${audioCount} 条音频轨${unknownText}${sizeText}`
        + ' · 可合并成一个 MP4',
    };
  }

  // ② 只有视频：合并器能出片，但**产物没有声音** —— 这必须写在提示里，
  //    否则用户会以为"合并 = 完整"。B 站偶尔会先只请求视频轨，这时也解释了为什么。
  if (videoCount && !audioCount) {
    return {
      show: true, canMerge: true, tracks,
      videoCount, audioCount, unknownCount, bytes,
      text: videoCount === 1
        ? `只看到 1 条视频轨，没有音频轨${sizeText} · 合并出来会是没有声音的 MP4`
        : `检测到 ${videoCount} 条视频轨，没有音频轨${sizeText} · 合并只用体积最大的那条`,
    };
  }

  // ③ 只有音频：合并**一定会失败**（解析器要一条视频轨），所以不给按钮，只说原因
  if (audioCount && !videoCount) {
    return {
      show: true, canMerge: false, tracks,
      videoCount, audioCount, unknownCount, bytes,
      text: `只看到 ${audioCount} 条音频轨，没有视频轨${sizeText} · 合并至少需要一条视频轨`,
    };
  }

  // ④ 类型看不出（站点不给 MIME，只有 `.m4s` 后缀）：老行为，交给解析器按内容认
  return {
    show: true, canMerge: true, tracks,
    videoCount, audioCount, unknownCount, bytes,
    text: unknownCount === 1
      ? `检测到 1 条独立轨道${sizeText} · 看不出是视频还是音频，合并时按内容识别`
      : `检测到 ${unknownCount} 条独立轨道${sizeText} · 合并后自动识别音视频`,
  };
}
