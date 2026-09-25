/**
 * URL / MIME 分类器 —— 「这个请求到底是什么东西」。
 *
 * 设计原则：
 *  1. 先看 MIME（服务器说了算），再看扩展名（猜）。
 *  2. 光靠扩展名猜出来的一律降到 LOW 置信度，避免把网站里的
 *     TypeScript `foo.ts` 当成 MPEG-TS 分片。
 *  3. 纯函数，不碰 chrome.*，方便在 Node 里直接跑单测。
 */
import { KIND, CONFIDENCE } from './constants.js';

const VIDEO_EXT = new Set([
  'mp4', 'm4v', 'webm', 'mkv', 'flv', 'mov', 'avi', 'wmv', 'ogv', '3gp', 'mpg', 'mpeg', 'vob',
]);
const AUDIO_EXT = new Set([
  'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'wma', 'weba', 'mka',
]);
const SEGMENT_TS_EXT = new Set(['ts', 'm2ts', 'mts', 'm2t']);
const SEGMENT_FMP4_EXT = new Set(['m4s', 'cmfv', 'cmfa', 'cmft', 'mp4v', 'mp4a']);
const PLAYLIST_HLS_EXT = new Set(['m3u8', 'm3u']);
const PLAYLIST_DASH_EXT = new Set(['mpd']);

/** 从 URL 里取出小写扩展名；没有则返回 '' */
export function extOf(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').pop() || '';
    const dot = last.lastIndexOf('.');
    if (dot < 0) return '';
    const ext = last.slice(dot + 1).toLowerCase();
    // 只接受像扩展名的东西，避免 /v1.2/stream 这种被误判
    return /^[a-z0-9]{1,5}$/.test(ext) ? ext : '';
  } catch {
    return '';
  }
}

function mimeBase(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

/**
 * 主分类函数。
 *
 * @param {object} input
 * @param {string} input.url
 * @param {string} [input.mime]        Content-Type，例如 'video/mp2t'
 * @param {string} [input.disposition] Content-Disposition
 * @param {string} [input.requestType] webRequest 的 type
 * @returns {{kind:string, ext:string, container:string|null, mime:string,
 *            confidence:string, isPlaylist:boolean, isSegment:boolean,
 *            isAudioOnly:boolean, downloadable:boolean, reason:string}}
 */
export function classify(input) {
  const url = String(input?.url || '');
  const mime = mimeBase(input?.mime);
  const disposition = String(input?.disposition || '');
  const ext = extOf(url);

  const base = {
    kind: KIND.UNKNOWN,
    ext,
    container: null,
    mime,
    confidence: CONFIDENCE.LOW,
    isPlaylist: false,
    isSegment: false,
    isAudioOnly: false,
    downloadable: false,
    reason: '',
  };

  if (!url || url.startsWith('blob:') || url.startsWith('data:')) {
    return { ...base, reason: 'blob/data URL 无法直接下载，需走抓流或录制' };
  }

  // ---------- 1. MIME 优先 ----------
  if (mime === 'application/vnd.apple.mpegurl' || mime === 'application/x-mpegurl' || mime === 'audio/mpegurl') {
    return { ...base, kind: KIND.HLS, container: 'hls', confidence: CONFIDENCE.HIGH,
      isPlaylist: true, downloadable: true, reason: 'MIME 声明为 HLS 播放列表' };
  }
  if (mime === 'application/dash+xml') {
    return { ...base, kind: KIND.DASH, container: 'dash', confidence: CONFIDENCE.HIGH,
      isPlaylist: true, downloadable: true, reason: 'MIME 声明为 DASH 清单' };
  }
  if (mime === 'video/mp2t') {
    return { ...base, kind: KIND.SEGMENT, container: 'mpegts', confidence: CONFIDENCE.HIGH,
      isSegment: true, reason: 'MIME 声明为 MPEG-TS' };
  }
  if (mime === 'video/mp4' || mime === 'video/quicktime') {
    if (SEGMENT_FMP4_EXT.has(ext)) {
      return { ...base, kind: KIND.SEGMENT, container: 'fmp4', confidence: CONFIDENCE.HIGH,
        isSegment: true, reason: 'MIME 为 MP4 且扩展名是分片' };
    }
    return { ...base, kind: KIND.FILE, container: 'mp4', confidence: CONFIDENCE.HIGH,
      downloadable: true, reason: 'MIME 声明为 ' + mime };
  }
  if (mime.startsWith('video/')) {
    return { ...base, kind: KIND.FILE, container: mime.slice(6), confidence: CONFIDENCE.HIGH,
      downloadable: true, reason: 'MIME 声明为视频' };
  }
  if (mime.startsWith('audio/')) {
    return { ...base, kind: KIND.AUDIO, container: mime.slice(6), confidence: CONFIDENCE.HIGH,
      isAudioOnly: true, downloadable: true, reason: 'MIME 声明为音频' };
  }

  // ---------- 2. Content-Disposition 里的文件名 ----------
  //
  // `Content-Type: application/octet-stream` + `Content-Disposition: attachment;
  // filename="课程.mp4"` + URL 是 `/download?id=123` —— 这是很常见的一种下载响应。
  // 光看 MIME 和 URL 会判成 UNKNOWN，然后被 isInteresting 丢掉，
  // 于是一个真正能下的视频根本不进列表。文件名里其实写得很清楚。
  const dispositionExt = (() => {
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    if (!m || !m[1]) return '';
    let name = m[1];
    try { name = decodeURIComponent(name); } catch { /* 保持原样 */ }
    const dot = name.lastIndexOf('.');
    if (dot < 0) return '';
    const e = name.slice(dot + 1).toLowerCase();
    return /^[a-z0-9]{1,5}$/.test(e) ? e : '';
  })();

  if (dispositionExt) {
    const de = dispositionExt;
    const fromDisposition = (kind, container) => ({
      ...base,
      kind,
      ext: de,
      container,
      confidence: CONFIDENCE.MEDIUM,
      downloadable: true,
      isAudioOnly: kind === KIND.AUDIO,
      reason: 'Content-Disposition 声明的文件名 .' + de,
    });
    if (PLAYLIST_HLS_EXT.has(de)) return { ...fromDisposition(KIND.HLS, 'hls'), isPlaylist: true };
    if (PLAYLIST_DASH_EXT.has(de)) return { ...fromDisposition(KIND.DASH, 'dash'), isPlaylist: true };
    if (VIDEO_EXT.has(de)) return fromDisposition(KIND.FILE, de);
    if (AUDIO_EXT.has(de)) return fromDisposition(KIND.AUDIO, de);
    if (SEGMENT_TS_EXT.has(de) || SEGMENT_FMP4_EXT.has(de)) {
      return { ...fromDisposition(KIND.SEGMENT, de), downloadable: false, isSegment: true };
    }
  }

  // ---------- 3. 扩展名兜底 ----------
  if (PLAYLIST_HLS_EXT.has(ext)) {
    return { ...base, kind: KIND.HLS, container: 'hls', confidence: CONFIDENCE.MEDIUM,
      isPlaylist: true, downloadable: true, reason: '扩展名 .' + ext };
  }
  if (PLAYLIST_DASH_EXT.has(ext)) {
    return { ...base, kind: KIND.DASH, container: 'dash', confidence: CONFIDENCE.MEDIUM,
      isPlaylist: true, downloadable: true, reason: '扩展名 .' + ext };
  }
  if (SEGMENT_TS_EXT.has(ext)) {
    // 低置信度：可能是 TypeScript 文件，也可能是服务器没给对 MIME 的 TS 分片。
    // 用「请求类型」帮一把：脚本类请求已经在上游被丢掉，所以这里多半是 XHR/媒体。
    return { ...base, kind: KIND.SEGMENT, container: 'mpegts', confidence: CONFIDENCE.LOW,
      isSegment: true, reason: '扩展名 .' + ext + '（未获 MIME 佐证）' };
  }
  if (SEGMENT_FMP4_EXT.has(ext)) {
    return { ...base, kind: KIND.SEGMENT, container: 'fmp4', confidence: CONFIDENCE.LOW,
      isSegment: true, reason: '扩展名 .' + ext + '（未获 MIME 佐证）' };
  }
  if (VIDEO_EXT.has(ext)) {
    return { ...base, kind: KIND.FILE, container: ext, confidence: CONFIDENCE.MEDIUM,
      downloadable: true, reason: '扩展名 .' + ext };
  }
  if (AUDIO_EXT.has(ext)) {
    return { ...base, kind: KIND.AUDIO, container: ext, confidence: CONFIDENCE.MEDIUM,
      isAudioOnly: true, downloadable: true, reason: '扩展名 .' + ext };
  }

  // ---------- 4. 完全不认识 ----------
  return { ...base, reason: '既不是已知 MIME 也不是已知扩展名' };
}

/** 这个请求值不值得记进嗅探列表 */
export function isInteresting(entry) {
  if (!entry) return false;
  if (entry.kind === KIND.UNKNOWN) return false;
  // 低置信度的分片单独出现没意义，但先收着——它往往是一整个 HLS 会话的一部分
  return true;
}

/**
 * 从 URL 里猜一个像样的文件名（不含目录）。
 * Content-Disposition 优先级更高，由调用方处理。
 */
export function guessFileName(url, kind = KIND.UNKNOWN, fallbackExt = '') {
  let name = '';
  try {
    const u = new URL(url);
    name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
  } catch { /* ignore */ }
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  if (!name || name === '_' || name.length > 120) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    name = `video-${stamp}${fallbackExt ? '.' + fallbackExt : ''}`;
  }
  return name;
}

/** 把 URL 变成稳定的短 id（用于条目去重） */
export function hashUrl(url) {
  // FNV-1a 32 位，够用且同步、无依赖
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i += 1) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** 人类可读体积 */
export function formatBytes(n) {
  if (n == null || Number.isNaN(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** 人类可读时长（统一包含两位小时 hh:mm:ss） */
export function formatDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(ss)}`;
}
