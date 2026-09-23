/**
 * 文件名与下载路径的净化。
 *
 * 放在 core 而不是 background：service worker（chrome.downloads）和
 * 解析器页（File System Access API）都要用同一套规则。两处各写一份，
 * 迟早会出现「同样的标题，一个存得下一个存不下」这种鬼问题。
 */

/** Windows / macOS / Linux 上都不能出现在文件名里的字符 */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

/** Windows 保留设备名 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** 把任意字符串压成一个安全的路径片段 */
export function sanitizeSegment(input, maxLength = 80) {
  let s = String(input ?? '')
    .replace(ILLEGAL, '_')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!s) s = 'unnamed';
  if (RESERVED.test(s)) s = `_${s}`;
  if (s.length > maxLength) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 6 ? s.slice(dot) : '';
    s = s.slice(0, maxLength - ext.length) + ext;
  }
  return s;
}

/** 拼出 chrome.downloads 需要的相对路径（必须用 / 分隔，不能有 ..） */
export function buildDownloadPath(subdir, filename) {
  const parts = [];
  if (subdir) {
    for (const piece of String(subdir).split(/[/\\]+/)) {
      const clean = sanitizeSegment(piece, 40);
      if (clean && clean !== 'unnamed') parts.push(clean);
    }
  }
  parts.push(sanitizeSegment(filename, 150));
  return parts.join('/');
}
