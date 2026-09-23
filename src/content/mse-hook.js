/**
 * MSE 采集钩子 —— 运行在**主世界**（页面自己的 JS 环境里）。
 *
 * 为什么是主世界：`MediaSource` / `SourceBuffer` 是页面 JS 持有的对象。
 * 隔离世界看到的是另一套绑定，钩不到页面的调用。
 *
 * 钩的是什么：`SourceBuffer.prototype.appendBuffer`。
 *
 * 播放器的数据流是这样走的：
 *
 *     下载加密分片 → JS 里解密 → appendBuffer(明文) → 浏览器解码 → 画面
 *                                   ↑
 *                             这里已经是干净的了
 *
 * 所以钩住这个函数的收益是：拿到**播放器已经解密好的原始码流** ——
 * 没有网页水印（那是叠在视频上的 DOM），没有浏览器 UI，不需要重新编码，
 * 而且是原始画质。顺带还绕过了"自己去猜密钥"这件事：
 * 播放器已经解好了，我们直接拿结果。
 *
 * 三条纪律：
 *   1. **绝不能影响页面**。所有操作包在 try/catch 里，出任何问题都放行原调用。
 *   2. **必须在页面之前拿到数据**。appendBuffer 之后数据可能被页面转移或回收，
 *      所以先拷一份再往下传。
 *   3. 这个文件是经典脚本（主世界注入不走模块），所以自包含、不用 import。
 */
(() => {
  const FLAG = '__videoHunterMseHooked__';
  if (window[FLAG]) {
    // 重复注入：告诉隔离世界"钩子已经在了"，别重复挂
    window.postMessage({ __vh: 'mse', kind: 'already' }, '*');
    return;
  }
  window[FLAG] = true;

  const CHANNEL = 'mse';
  const post = (payload) => {
    try {
      window.postMessage({ __vh: CHANNEL, ...payload }, '*');
    } catch {
      // 发不出去就算了，绝不给页面抛异常
    }
  };

  /**
   * 在主世界就把字节编码成 base64。
   *
   * 一开始是把 ArrayBuffer 用 transfer 递到隔离世界再编码 —— 实测那一步
   * 送过来的字节是空的（跨世界传二进制不可靠）。改成在这边编码成字符串，
   * 跨世界传字符串是最稳的。代价是页面上多花一两毫秒，可以接受。
   */
  function toBase64(bytes) {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }

  const describe = (data) => {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
  };

  /* ---- 1. 记住每个 SourceBuffer 的 mime（它决定了这条轨是视频还是音频） ---- */
  let sourceBuffersSeen = 0;
  // 每个 SourceBuffer 再给一个**稳定编号**。
  //
  // 为什么编号和 mime 都要：真实站点上实测到有一批 append **没有 mime**
  // （那条 SourceBuffer 的 addSourceBuffer 没经过我们的补丁）。没有 mime 时
  // "按 mime 分组"会把几条不同的流混成一组，拼出来的字节头尾不接，
  // 于是整组被当成"认不出容器"丢掉 —— YouTube 上实测丢掉 0.68 MB。
  // 有了编号，这些流至少能各自成组，再靠字节自己（moov/EBML）判型。
  let nextSourceBufferId = 0;
  const idFor = (sb) => {
    if (!sb.__vhId) {
      nextSourceBufferId += 1;
      try { sb.__vhId = 'sb' + nextSourceBufferId; } catch { /* 打不上标也不能崩 */ }
    }
    return sb.__vhId || '';
  };
  try {
    const origAdd = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function patchedAddSourceBuffer(...args) {
      const sb = origAdd.apply(this, args);
      try {
        sb.__vhMime = String(args[0] || '');
        idFor(sb);
        sourceBuffersSeen += 1;
        post({ kind: 'sourcebuffer', mime: sb.__vhMime, sbId: sb.__vhId || '', mode: sb.mode || '' });
      } catch { /* 打标失败不影响播放 */ }
      return sb;
    };
  } catch { /* 有些环境没有 MediaSource，正常 */ }

  /* ---- 2. 钩 appendBuffer ---- */
  try {
    const origAppend = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function patchedAppendBuffer(data, ...rest) {
      // 先把字节拷成 base64 再往下走：appendBuffer 之后页面可能转移或复用这块内存
      try {
        const view = describe(data);
        if (view && view.byteLength) {
          post({
            kind: 'buffer',
            mime: this.__vhMime || '',
            // 没有 mime 时，这条编号就是"这是哪条流"的唯一线索
            sbId: idFor(this),
            mode: this.mode || '',
            size: view.byteLength,
            base64: toBase64(view),
          });
        }
      } catch { /* 拷贝或编码失败就放过，页面照常播放 */ }
      return origAppend.call(this, data, ...rest);
    };
  } catch { /* 钩不上也不该让页面出错 */ }

  /* ---- 3. 网页水印通常叠在视频上，顺手报一下有没有全屏覆盖层（仅供诊断） ---- */
  post({ kind: 'ready' });
})();
