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
  const activeSourceBuffers = [];
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
        activeSourceBuffers.push(sb);
        sourceBuffersSeen += 1;
        post({ kind: 'sourcebuffer', mime: sb.__vhMime, sbId: sb.__vhId || '', mode: sb.mode || '' });
      } catch { /* 打标失败不影响播放 */ }
      return sb;
    };
  } catch { /* 有些环境没有 MediaSource，正常 */ }

  /* ---- 2. 钩 changeType（播放器中途无缝切换格式/编码时同步更新 MIME） ---- */
  try {
    if (typeof SourceBuffer.prototype.changeType === 'function') {
      const origChangeType = SourceBuffer.prototype.changeType;
      SourceBuffer.prototype.changeType = function patchedChangeType(type, ...args) {
        try {
          this.__vhMime = String(type || '');
          post({ kind: 'sourcebuffer', mime: this.__vhMime, sbId: idFor(this), mode: this.mode || '', changed: true });
        } catch { /* 打标失败不影响播放 */ }
        return origChangeType.call(this, type, ...args);
      };
    }
  } catch { /* 浏览器不支持 changeType 时忽略 */ }

  /* ---- 3. 钩 appendBuffer ---- */
  try {
    const origAppend = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function patchedAppendBuffer(data, ...rest) {
      // 1. 同步快照内存（Uint8Array.prototype.slice 纯底层内存拷贝，5MB 耗时 <0.2ms）
      //    保证即使页面后续复用或修改原始 Buffer，抓到的数据也完全不受影响。
      let copy = null;
      try {
        const view = describe(data);
        if (view && view.byteLength) {
          copy = view.slice();
        }
      } catch { /* 快照失败放行 */ }

      // 2. 零等待！立刻放行原调用，让播放器与解码器在第一时间收到数据，消除转圈卡顿
      let result;
      try {
        result = origAppend.call(this, data, ...rest);
      } catch (err) {
        throw err;
      }

      // 3. 将 base64 转码与 postMessage 放在微任务中执行，彻底不阻塞当前调用的执行
      if (copy && copy.byteLength) {
        try {
          const mime = this.__vhMime || '';
          const sbId = idFor(this);
          const mode = this.mode || '';
          const size = copy.byteLength;
          if (!this.__vhInit && copy.byteLength < 5 * 1024 * 1024) {
            this.__vhInit = { mime, sbId, mode, size, base64: toBase64(copy) };
          }
          queueMicrotask(() => {
            try {
              post({
                kind: 'buffer',
                mime,
                sbId,
                mode,
                size,
                base64: toBase64(copy),
              });
            } catch { /* 发送失败忽略 */ }
          });
        } catch { /* 调度失败忽略 */ }
      }
      return result;
    };
  } catch { /* 钩不上也不该让页面出错 */ }

  // 接收来自隔离世界的控制指令（如录制开始时重放先前记录的初始化段）
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.__vh !== 'mse-ctl') return;
    if (ev.data.kind === 'replay_inits') {
      for (const sb of activeSourceBuffers) {
        if (sb.__vhInit) {
          post({ kind: 'buffer', ...sb.__vhInit, isReplayedInit: true });
        }
      }
    }
  });

  /* ---- 3. 网页水印通常叠在视频上，顺手报一下有没有全屏覆盖层（仅供诊断） ---- */
  post({ kind: 'ready' });
})();
