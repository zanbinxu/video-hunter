/**
 * HLS 密钥的解读与**验证**。
 *
 * 规范说 `#EXT-X-KEY` 的 URI 返回 16 字节原始密钥。现实中不是：
 *   · 32 位十六进制字符串（常带一个换行，于是 33 字节）—— 已支持
 *   · 33 字节高熵二进制，既不是十六进制也不是 base64 —— 实测撞到过
 *
 * 后者没法靠"猜格式"解决。所以这里换了个思路：**不猜，验证。**
 *
 * AES-128 解出来的明文如果是 MPEG-TS，就有个极强的特征：包同步字节 0x47
 * 必须每 188 字节出现一次。错一个字节的密钥解出来是均匀噪声，
 * 连续四个 188 间隔都命中 0x47 的概率约为 2^-32 —— 实际上不可能误判。
 *
 * 于是：把响应里**每一个 16 字节窗口**都当成候选密钥试一遍，
 * 谁能解出合法的 TS 流就是谁。33 字节只有 18 个窗口，代价可以忽略。
 */
import { decryptAes128Cbc } from './decrypt.js';

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;

/** 给错误信息用的内容预览：让报错自己带上证据 */
export function previewBytes(bytes, n = 64) {
  const head = bytes.subarray(0, Math.min(n, bytes.byteLength));
  const hex = [...head].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const text = new TextDecoder('utf-8', { fatal: false }).decode(head).replace(/[^\x20-\x7e]/g, '.');
  return `hex[${hex}${bytes.byteLength > n ? ' …' : ''}] text["${text}"]`;
}

/**
 * 判断一段明文像不像 MPEG-TS。
 *
 * 这是整套密钥恢复的判据，所以必须严：要看到连续多个 188 间隔的同步字节，
 * 而不是只看第一个字节 —— 只看 0x47 的话，随机数据也有 1/256 的概率蒙混过关。
 */
export function looksLikeMpegTs(bytes, { minPackets = 4 } = {}) {
  if (!bytes || bytes.byteLength === 0) return false;
  if (bytes.byteLength < TS_PACKET_SIZE * 2) return bytes[0] === TS_SYNC_BYTE;

  // 段不一定从包边界开始（虽然 HLS 里通常都是），所以允许在头 188 字节内找一个对齐点
  for (let start = 0; start < TS_PACKET_SIZE; start += 1) {
    if (bytes[start] !== TS_SYNC_BYTE) continue;
    if (start + TS_PACKET_SIZE * minPackets > bytes.byteLength) break;
    let packets = 0;
    let ok = true;
    for (let p = start; p + TS_PACKET_SIZE <= bytes.byteLength; p += TS_PACKET_SIZE) {
      if (bytes[p] !== TS_SYNC_BYTE) { ok = false; break; }
      packets += 1;
    }
    if (ok && packets >= minPackets) return true;
  }
  return false;
}

/**
 * 严格版：只接受"能明确解读"的密钥，解读不了就报错并带上证据。
 *
 * 和下面的候选穷举是两种态度：这个用在能确定长度的场合，
 * 报错信息本身就当作诊断用。
 */
export function normalizeKeyBytes(raw) {
  if (raw.byteLength === 16) return raw;

  const text = new TextDecoder('utf-8', { fatal: false }).decode(raw).trim();
  if (/^[0-9a-fA-F]{32}$/.test(text)) {
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  throw new Error(
    `密钥长度不对：期望 16 字节，实际 ${raw.byteLength} 字节，也不是 32 位十六进制串。`
    + `内容开头：${previewBytes(raw)}`,
  );
}

function base64ToBytes(text) {
  if (typeof atob === 'function') {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(text, 'base64'));
}

/**
 * 把取回来的东西解读成"候选密钥"列表，按可能性从高到低排。
 *
 * 只返回 16 字节的候选 —— 长度不对的一律不是 AES-128 的密钥。
 *
 * @param {Uint8Array} raw
 * @returns {Array<{label: string, key: Uint8Array}>}
 */
export function keyCandidates(raw) {
  const out = [];
  const seen = new Set();
  const add = (label, bytes) => {
    if (!bytes || bytes.byteLength !== 16) return;
    const id = [...bytes].join(',');
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ label, key: Uint8Array.from(bytes) });
  };

  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);

  // ---- 1. 文本形式 ----
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim();
  if (/^[0-9a-fA-F]{32}$/.test(text)) {
    const b = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) b[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
    add('32 位十六进制文本', b);
  }
  if (/^[A-Za-z0-9+/]{24}$/.test(text) || /^[A-Za-z0-9+/]{22}==$/.test(text)) {
    try { add('base64 文本', base64ToBytes(text)); } catch { /* 不是合法 base64 */ }
  }

  // ---- 2. 正好 16 字节：就是它 ----
  if (bytes.byteLength === 16) {
    add('原始 16 字节', bytes);
    return out;
  }

  // ---- 3. 穷举所有 16 字节窗口 ----
  // 响应里可能是"头部 + 密钥"、"密钥 + IV"、"1 字节长度前缀 + 密钥"等等，
  // 与其逐个猜这些排布，不如全部试一遍 —— 33 字节也就 18 个窗口。
  if (bytes.byteLength > 16) {
    for (let offset = 0; offset + 16 <= bytes.byteLength; offset += 1) {
      add(`第 ${offset} 字节起的 16 字节`, bytes.subarray(offset, offset + 16));
    }
  }

  return out;
}

/**
 * 用一堆候选密钥去解同一段密文，谁能解出合法 TS 就是谁。
 *
 * @param {Uint8Array} raw     密钥 URI 返回的原始字节
 * @param {Uint8Array} iv
 * @param {Uint8Array} cipher  任意一个分片的密文（用来做判据）
 * @returns {Promise<{plain:Uint8Array, candidate:object, tried:number}|{plain:null, tried:number, failures:string[]}>}
 */
export async function decryptWithKeyCandidates(raw, iv, cipher) {
  const candidates = keyCandidates(raw);
  const failures = [];

  for (const candidate of candidates) {
    try {
      const plain = await decryptAes128Cbc(candidate.key, iv, cipher);
      if (looksLikeMpegTs(plain)) {
        return { plain, candidate, tried: failures.length + 1 };
      }
      // 长度对了、能解开、但不是 TS —— 说明这个窗口不对。
      // 记下来是有用的：它排除了一个可能性。
      failures.push(`${candidate.label} → 解得开但不是 MPEG-TS`);
    } catch (err) {
      failures.push(`${candidate.label} → ${String(err?.message || err).slice(0, 48)}`);
    }
  }

  return { plain: null, tried: candidates.length, failures };
}
