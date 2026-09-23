/**
 * AES-128-CBC 解密（HLS 分片）。
 *
 * 用 WebCrypto 而不是自己实现 AES，有个额外好处：Node 24 原生就有
 * `globalThis.crypto.subtle`，所以**这段代码在 Node 测试里跑的是同一份实现**，
 * 不存在「测试通过但浏览器里另一套逻辑」的裂缝。
 *
 * 关于 PKCS#7：HLS 规范要求每个分片单独做 PKCS#7 填充，WebCrypto 的
 * AES-CBC decrypt 会自动去掉它，正好对上。少数不规范的服务端不做填充，
 * 那种情况这里会抛错 —— 与其悄悄解出一段坏数据，不如明确失败。
 */

/** Uint8Array → 恰好覆盖其视图范围的 ArrayBuffer（不能直接把 .buffer 交出去） */
export function toArrayBuffer(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

/**
 * @param {Uint8Array} keyBytes 16 字节
 * @param {Uint8Array} ivBytes  16 字节
 * @param {Uint8Array} data     密文
 * @returns {Promise<Uint8Array>} 明文
 */
export async function decryptAes128Cbc(keyBytes, ivBytes, data) {
  const key = await crypto.subtle.importKey(
    'raw', toArrayBuffer(keyBytes), { name: 'AES-CBC' }, false, ['decrypt'],
  );
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: toArrayBuffer(ivBytes) }, key, toArrayBuffer(data),
    );
    return new Uint8Array(plain);
  } catch (err) {
    // 最常见的原因是分片没有按规范做 PKCS#7 填充。
    // 把原因说清楚，否则用户只会看到一句 "OperationError"。
    throw new Error(
      `AES-128 解密失败（${err?.name || 'Error'}）：分片长度 ${data.byteLength} 字节。`
      + '通常是该分片没有按 HLS 规范做 PKCS#7 填充，或 key/IV 取错了。',
    );
  }
}

/** 拿一个密钥的指纹，用于在 UI 上确认「两个流用的是不是同一把 key」 */
export async function keyFingerprint(keyBytes) {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(keyBytes));
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
