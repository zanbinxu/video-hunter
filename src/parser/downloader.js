/**
 * HLS 分片下载器（浏览器侧）。
 *
 * 两个必须做对的地方：
 *
 * 1) **保序**。分片是并发下的，但重封装必须按顺序喂。所以这里是
 *    「并发下载 + 按序吐出」：worker 池随便抢，消费者永远只拿下一个序号，
 *    没轮到的先躺在 ring 里。
 *
 * 2) **解密在下载这一层做**。拿到密文立刻解密再交给上层，
 *    上层（重封装）只看见明文 TS —— 加密与否对重封装完全透明。
 */
import { decryptAes128Cbc } from './decrypt.js';
import { ivForSegment } from './hls.js';
import { decryptWithKeyCandidates, previewBytes } from './hls-key.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 密钥按 URI 缓存：一个流里所有分片用同一把 key，没必要拉几千次 */
function createKeyCache() {
  const cache = new Map();
  return async function getRawKey(uri, { signal } = {}) {
    if (!cache.has(uri)) {
      cache.set(uri, (async () => {
        const res = await fetch(uri, { credentials: 'include', cache: 'no-store', signal });
        if (!res.ok) throw new Error(`取密钥失败：HTTP ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        // 缓存**原始响应字节**，而不是"解读好的密钥"：
        // 有些服务端返回的不是标准 16 字节，怎么解读得靠一段真实密文去验证，
        // 那个工作留到解密时做（见 decryptWithKeyCandidates）。
        return {
          bytes: buf,
          status: res.status,
          contentType: res.headers.get('content-type') || '',
          uri,
        };
      })());
      // 失败的话把缓存清掉，让下一个分片可以重试
      cache.get(uri).catch(() => cache.delete(uri));
    }
    return cache.get(uri);
  };
}

/**
 * 造一个「下载单个分片」的函数。
 * @param {object} opts
 * @param {number} opts.mediaSequence
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutMs] 单分片超时
 * @param {(info:object)=>void} [opts.onKeyRecovered]
 *        密钥不是标准 16 字节、但被成功解读出来时回调一次（用来告诉用户发生了什么）
 */
export function createSegmentFetcher({
  mediaSequence = 0,
  signal,
  timeoutMs = 45000,
  onKeyRecovered,
} = {}) {
  const getRawKey = createKeyCache();
  let reported = false;

  return async function fetchSegment(segment, index) {
    const headers = {};
    if (segment.byteRange) {
      headers.Range = `bytes=${segment.byteRange.offset}-${segment.byteRange.end}`;
    }

    // 分片级超时：不能只靠外部 signal，否则一个卡住的分片会让整条流水线停在那里
    const local = new AbortController();
    const timer = setTimeout(() => local.abort(new Error('超时')), timeoutMs);
    const onOuterAbort = () => local.abort(signal?.reason);
    signal?.addEventListener('abort', onOuterAbort, { once: true });

    try {
      const res = await fetch(segment.uri, {
        signal: local.signal,
        credentials: 'include',
        cache: 'no-store',
        headers,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let data = new Uint8Array(await res.arrayBuffer());

      if (segment.key?.method === 'AES-128' && segment.key.uri) {
        const raw = await getRawKey(segment.key.uri, { signal: local.signal });
        const iv = ivForSegment(segment, mediaSequence);

        if (raw.bytes.byteLength === 16) {
          // 标准情况：直接用，不做多余的事
          data = await decryptAes128Cbc(raw.bytes, iv, data);
        } else {
          // 长度不对。不猜格式，而是拿这段真实密文去验证每一个可能的窗口 ——
          // 解出来是合法 MPEG-TS 的那个就是密钥。
          const found = await decryptWithKeyCandidates(raw.bytes, iv, data);
          if (!found.plain) {
            throw new Error(
              `密钥响应是 ${raw.bytes.byteLength} 字节（HTTP ${raw.status}`
              + `${raw.contentType ? '，' + raw.contentType : ''}），`
              + `试了 ${found.tried} 种解读都不对。`
              + `密钥地址：${raw.uri}`
              + `｜内容开头：${previewBytes(raw.bytes)}`
              + `｜各路结果：${found.failures.slice(0, 4).join('；')}`,
            );
          }
          data = found.plain;
          if (!reported) {
            reported = true;
            onKeyRecovered?.({
              bytes: raw.bytes.byteLength,
              label: found.candidate.label,
              tried: found.tried,
              uri: raw.uri,
              contentType: raw.contentType,
            });
          }
        }
      }
      return data;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  };
}

/**
 * 并发下载 + 按序吐出。
 *
 * @param {Array} segments
 * @param {object} opts
 * @param {number} [opts.concurrency]
 * @param {number} [opts.retries]
 * @param {AbortSignal} [opts.signal]
 * @param {(seg:object, index:number) => Promise<Uint8Array>} opts.fetchSegment
 * @param {(p:{completed:number,total:number,bytes:number,index:number}) => void} [opts.onProgress]
 * @yields {{index:number, data:Uint8Array}}
 */
export async function* downloadSegmentsInOrder(segments, opts) {
  const {
    concurrency = 6,
    retries = 3,
    signal,
    fetchSegment,
    onProgress,
  } = opts;

  const total = segments.length;
  if (!total) return;

  const ring = new Map();       // index -> 已下载但还没被消费的数据
  const wakeups = [];
  const wake = () => { while (wakeups.length) wakeups.shift()(); };
  const waitForWake = () => new Promise((r) => wakeups.push(r));

  let nextToStart = 0;
  let nextToYield = 0;
  let bytes = 0;
  let failure = null;

  async function worker() {
    while (!failure && !signal?.aborted) {
      const index = nextToStart;
      if (index >= total) return;
      nextToStart += 1;

      let lastError = null;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (failure || signal?.aborted) return;
        try {
          const data = await fetchSegment(segments[index], index);
          ring.set(index, data);
          bytes += data.byteLength;
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          if (signal?.aborted) return;
          // 指数退避，但别退太久 —— 一个分片卡 30 秒用户会以为程序死了
          if (attempt < retries) await sleep(Math.min(2000, 250 * (2 ** attempt)));
        }
      }

      if (lastError) {
        failure = { index, error: lastError };
      }
      onProgress?.({ completed: nextToYield, total, bytes, index });
      wake();
      if (failure) return;
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, total));
  const workers = Array.from({ length: workerCount }, () => worker());

  try {
    while (nextToYield < total) {
      if (ring.has(nextToYield)) {
        const data = ring.get(nextToYield);
        ring.delete(nextToYield);
        const index = nextToYield;
        nextToYield += 1;
        onProgress?.({ completed: nextToYield, total, bytes, index });
        yield { index, data };
        continue;
      }
      if (failure) {
        throw new Error(
          `第 ${failure.index + 1}/${total} 个分片下载失败：${failure.error?.message || failure.error}`,
        );
      }
      if (signal?.aborted) throw new Error('已取消');
      await waitForWake();
    }
  } finally {
    // 消费者提前退出（取消 / 报错）时，不能把 worker 丢在那儿继续跑
    failure = failure || { index: nextToYield, error: new Error('已取消') };
    wake();
    await Promise.allSettled(workers);
  }
}

/** 把 BYTES 流成人类读得懂的速度 */
export function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let v = bytesPerSecond;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m} 分 ${s} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
