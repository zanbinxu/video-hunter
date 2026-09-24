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

  /* ---- 2. 钩 appendBuffer（**绝不能堵住页面**）----
   *
   * 用户报的："每次刷新页面后的第一次抓流，页面完全不动（转圈/黑屏），停止保存之后才恢复。"
   *
   * 原因：原来在 appendBuffer 里**同步**做 base64（`String.fromCharCode` 拼字符串 + `btoa`，
   * 两遍全量遍历）再 `postMessage` 一个大字符串。刷新后的第一次抓流恰好是播放器
   * **重新下载、重新缓冲**的时刻 —— 一瞬间 append 进来好几 MB，主线程被编码堵死，
   * 视频管线自然卡住。第二次抓流数据是匀速来的，就看不出问题。
   *
   * 现在：appendBuffer 里**只拷一份字节**（一次 memcpy，很快）丢进队列、立刻放行页面；
   * 编码与 postMessage 交给队列，并且**每编码 48 KB 就让出主线程一次**（setTimeout 0），
   * 让播放器有机会跑。顺序仍然严格 FIFO，消息格式与之前完全一致。
   *
   * 为什么每块是 48 KB：**3 的倍数**，所以"每块单独 btoa 再拼接"与"整体 btoa"等价 ——
   * 这样既能分块让出主线程，又不用把整段拼成一个大二进制串（省一次内存峰值）。
   */
  const pending = [];
  let inFlight = false;
  let encoderWorker = null;
  let workerBroken = false;
  const ENCODE_CHUNK = 49152; // 3 的倍数：分块 btoa 再拼接 == 整体 btoa
  const STR_CHUNK = 0x8000;

  /**
   * 把字节编码成 base64 的 Worker。
   *
   * 为什么还要 Worker：只做"分块 + 让出主线程"还不够 —— 刷新后的第一次抓流，
   * 播放器**重新缓冲**会一瞬间 append 进来几十 MB，只要编码还跑在页面主线程上，
   * 哪怕分成小块，播放器的画面管线也会被饿着（用户实测：一直在转圈）。
   * 搬到 Worker 之后，主线程只做一次拷贝 + 收一个字符串，编码那一大坨 CPU 不再占它。
   *
   * 页面 CSP 可能不允许 blob: worker → 那时自动退回主线程分块编码（功能不变，只是慢）。
   */
  const WORKER_SRC = 'self.onmessage=function(e){var b=new Uint8Array(e.data),s="",i;'
    + 'try{for(i=0;i<b.length;i+=0x8000){s+=String.fromCharCode.apply(null,b.subarray(i,Math.min(b.length,i+0x8000)));}'
    + 's=btoa(s);}catch(x){s="";}self.postMessage(s);};';

  function ensureWorker() {
    if (encoderWorker || workerBroken) return encoderWorker;
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
      const w = new Worker(url);
      // 出错就永久退回主线程那条路（不要每条都重试、也不给页面抛异常）
      w.onerror = () => { workerBroken = true; encoderWorker = null; };
      URL.revokeObjectURL(url);
      encoderWorker = w;
    } catch {
      workerBroken = true;
    }
    return encoderWorker;
  }

  /** 发出去（消息格式与之前完全一致）并接着处理下一条 —— 顺序严格 FIFO */
  function deliver(item, base64) {
    try {
      if (base64) {
        post({
          kind: 'buffer',
          mime: item.mime,
          sbId: item.sbId,
          mode: item.mode,
          size: item.size,
          base64,
        });
      }
    } catch { /* 发不出去就算了 */ }
    if (pending.length) setTimeout(pump, 0);
  }

  /** 退路：主线程分块编码（每 48 KB 让出一次，别把页面堵住） */
  function encodeOnMainThread(item) {
    const bytes = item.view;
    let out = '';
    let at = 0;
    const step = () => {
      try {
        const end = Math.min(bytes.length, at + ENCODE_CHUNK);
        let s = '';
        for (let i = at; i < end; i += STR_CHUNK) {
          s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + STR_CHUNK)));
        }
        out += btoa(s);
        at = end;
      } catch {
        deliver(item, ''); // 编码失败就当这一段没抓到 —— 绝不能给页面抛异常
        return;
      }
      if (at < bytes.length) { setTimeout(step, 0); return; }
      deliver(item, out);
    };
    step();
  }

  function pump() {
    if (inFlight) return;
    const item = pending.shift();
    if (!item) return;
    const w = ensureWorker();
    if (!w) { encodeOnMainThread(item); return; }
    inFlight = true;
    w.onmessage = (e) => {
      inFlight = false;
      deliver(item, typeof e.data === 'string' ? e.data : '');
    };
    try {
      // 传**副本**（structured clone）：转移 buffer 会把它 detach，
      // 万一 Worker 那边出岔子，这一段就再也救不回来了 —— 一次拷贝换确定性，值。
      w.postMessage(item.view);
    } catch {
      inFlight = false;
      workerBroken = true;
      encodeOnMainThread(item);
    }
  }

  try {
    const origAppend = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function patchedAppendBuffer(data, ...rest) {
      // 只拷字节（appendBuffer 之后页面可能转移或复用这块内存，所以必须**先**拷），
      // 编码放到队列里去做 —— 见上面那段注释：同步编码会把页面堵死。
      try {
        const view = describe(data);
        if (view && view.byteLength) {
          pending.push({
            view: new Uint8Array(view), // 真拷贝（构造函数传 typed array 是复制）
            mime: this.__vhMime || '',
            // 没有 mime 时，这条编号就是"这是哪条流"的唯一线索
            sbId: idFor(this),
            mode: this.mode || '',
            size: view.byteLength,
          });
          pump();
        }
      } catch { /* 拷贝失败就放过，页面照常播放 */ }
      return origAppend.call(this, data, ...rest);
    };
  } catch { /* 钩不上也不该让页面出错 */ }

  /* ---- 3. 网页水印通常叠在视频上，顺手报一下有没有全屏覆盖层（仅供诊断） ---- */
  post({ kind: 'ready' });
})();
