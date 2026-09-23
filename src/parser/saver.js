/**
 * 把产物写到磁盘上。
 *
 * 两条路：
 *
 *  A. **边下边存**（首选）：File System Access API 的 showSaveFilePicker
 *     + createWritable。分片一边下载一边往文件里写，内存占用是常数，
 *     10 GB 的课也不怕。代价是必须由用户手势触发，而且用户会看到
 *     一个「保存到哪儿」的对话框 —— 但那是好事，用户本来就想知道存哪儿。
 *
 *  B. **攒内存再落盘**（兜底）：全程留在内存里，最后拼成 Blob 交给
 *     浏览器下载器。简单、到处都能用，但内存占用随文件线性增长。
 *     所以只在小文件或 A 不可用时才走这条。
 */
import { sanitizeSegment } from '../core/filename.js';

export function canStreamToDisk() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}

function guessExtension(container) {
  if (container === 'mp4' || container === 'fmp4') return 'mp4';
  if (container === 'mpegts') return 'ts';
  if (container === 'adts' || container === 'aac') return 'aac';
  if (container === 'webm') return 'webm';
  return 'mp4';
}

export function suggestFileName(title, container = 'mp4') {
  const base = sanitizeSegment(title || 'video', 100).replace(/\.[a-z0-9]{1,5}$/i, '');
  return `${base || 'video'}.${guessExtension(container)}`;
}

/**
 * 创建落盘通道。
 *
 * @param {object} opts
 * @param {string} opts.fileName    建议文件名
 * @param {'auto'|'stream'|'memory'} [opts.mode]
 * @returns {Promise<{mode:string, write:(b:Uint8Array)=>Promise<void>,
 *                    close:()=>Promise<{ok:boolean, via?:string, error?:string}>,
 *                    bytesWritten:number}>}
 */
export async function createSink({ fileName, mode = 'auto' } = {}) {
  const wantStream = mode === 'stream' || (mode === 'auto' && canStreamToDisk());

  if (wantStream) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [{
          description: '视频文件',
          accept: { 'video/mp4': ['.mp4'], 'video/mp2t': ['.ts'], 'audio/mp4': ['.m4a'] },
        }],
      });
      const writable = await handle.createWritable();
      let bytes = 0;
      let closed = false;
      return {
        mode: 'stream',
        get bytesWritten() { return bytes; },
        async write(chunk) {
          if (closed) return;
          await writable.write(chunk);
          bytes += chunk.byteLength;
        },
        async close() {
          if (closed) return { ok: true, via: 'file-system-access' };
          closed = true;
          await writable.close();
          return { ok: true, via: 'file-system-access' };
        },
      };
    } catch (err) {
      // 用户取消了保存对话框 —— 这是正常操作，不该报错，也不该偷偷换条路继续
      if (err?.name === 'AbortError') {
        return { cancelled: true, mode: 'stream', write: async () => {}, close: async () => ({ ok: false, error: 'cancelled' }), bytesWritten: 0 };
      }
      console.info('[vh/saver] 无法边下边存，回落到内存模式：', err);
    }
  }

  const chunks = [];
  let bytes = 0;
  let closed = false;
  return {
    mode: 'memory',
    get bytesWritten() { return bytes; },
    async write(chunk) {
      if (closed) return;
      chunks.push(chunk);
      bytes += chunk.byteLength;
    },
    async close() {
      if (closed) return { ok: false, error: 'already closed' };
      closed = true;
      try {
        const blob = new Blob(chunks, { type: 'video/mp4' });
        chunks.length = 0;
        const url = URL.createObjectURL(blob);
        const via = await triggerDownload(url, fileName);
        // 交给下载器之后不能立刻 revoke：浏览器可能还没开始读这个 blob
        setTimeout(() => URL.revokeObjectURL(url), 120000);
        return { ok: true, via };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    },
  };

  /** 优先走 chrome.downloads（能进下载栏、有进度），不行再退回 <a download> */
  async function triggerDownload(url, name) {
    try {
      const id = await chrome.downloads.download({
        url,
        filename: name,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      if (typeof id === 'number') return 'chrome.downloads';
    } catch (err) {
      console.info('[vh/saver] chrome.downloads 失败，退回 <a download>：', err);
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return 'anchor-download';
  }
}
