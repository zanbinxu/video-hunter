/**
 * 文件落盘（background 侧）。
 *
 * 走 chrome.downloads 而不是自己做 Blob：浏览器下载器是流式写盘的，
 * 几个 GB 的文件也不会把内存吃爆，而且天然支持断点、进度、下载栏 UI。
 *
 * 但 chrome.downloads 有个硬伤：**不能设置 Referer**。
 * 所以凡是需要 Referer 的资源（很多 CDN 的分片），都得先经过
 * 「注入 Referer 规则」或「页面上下文抓取」这两条路，见 netrules.js。
 */
import { buildDownloadPath } from '../core/filename.js';

export { sanitizeSegment, buildDownloadPath } from '../core/filename.js';

/**
 * 把一个 URL 交给浏览器下载器。
 * @returns {Promise<{ok:boolean, downloadId?:number, path?:string, error?:string}>}
 */
export async function downloadUrl({ url, filename, subdir = '', saveAs = false }) {
  if (!url) return { ok: false, error: '缺少 url' };
  const path = buildDownloadPath(subdir, filename || 'download.bin');
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: path,
      conflictAction: 'uniquify',
      saveAs,
    });
    return { ok: true, downloadId, path };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), path };
  }
}

/**
 * 等一个下载**真的结束**（complete / interrupted）。
 *
 * 和上面那个 `watchDownloadStart` 的区别：那个只盯开头几秒（用来判断"这条路通不通"），
 * 这个要等到最后 —— 抓流产物**自动导出**时必须等完：那个 blob URL 是在**离屏文档**里
 * 创建的，而离屏文档一关，blob 就失效、下载立刻断掉。所以收尾流程要等它下载完再关。
 *
 * @returns {Promise<{ok:boolean, state?:string, error?:string, bytes?:number}>}
 */
export function waitDownloadDone(downloadId, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      resolve(result);
    };
    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      const state = delta.state?.current;
      if (state === 'interrupted') finish({ ok: false, state, error: delta.error?.current || 'interrupted' });
      else if (state === 'complete') {
        chrome.downloads.search({ id: downloadId }).then(([item]) => {
          finish({ ok: true, state, bytes: item?.fileSize || 0 });
        }).catch(() => finish({ ok: true, state }));
      }
    };
    const timer = setTimeout(() => finish({ ok: false, error: '等待下载结束超时' }), timeoutMs);
    chrome.downloads.onChanged.addListener(onChanged);
    // 也可能在我们挂监听之前就已经完成了（小文件很快），先查一次
    chrome.downloads.search({ id: downloadId }).then(([item]) => {
      if (!item) return;
      if (item.state === 'complete') finish({ ok: true, state: 'complete', bytes: item.fileSize || 0 });
      else if (item.state === 'interrupted') finish({ ok: false, state: 'interrupted', error: item.error || 'interrupted' });
    }).catch(() => {});
  });
}
/**
 * 只盯「开头这几秒」有没有被打断。
 *
 * 为什么不是盯到 complete：一个大文件下 10 分钟很正常，
 * 盯到 complete 会把正常的慢下载误报成失败。
 * 而真正的失败（403 / 需要 Referer / 连接被拒）几乎都是秒级的，
 * 所以在宽限期内没被 interrupt，就认为这条路走得通。
 */
export function watchDownloadStart(downloadId, { graceMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      resolve(result);
    };

    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'interrupted') {
        finish({ ok: false, error: delta.error?.current || 'interrupted' });
      }
      // 注意：这里故意不因为 complete 提前返回 —— complete 也走 timeout 那条路，
      // 语义统一成「宽限期内没出事」。
    };

    const timer = setTimeout(() => finish({ ok: true }), graceMs);
    chrome.downloads.onChanged.addListener(onChanged);
  });
}
