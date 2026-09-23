/**
 * MPEG-TS → 分片 MP4（fMP4）重封装。
 *
 * 这里刻意**不用 ffmpeg.wasm**。原因有三：
 *   1. 体积：ffmpeg.wasm 核心 25~32 MB，装进扩展就是几十兆的包袱；
 *   2. 配置：多线程版要 SharedArrayBuffer，得给扩展页开跨域隔离，
 *      MV3 下这条路坑很多；
 *   3. 没必要：TS→MP4 在浏览器里本来就是**重封装**不是转码，
 *      mux.js 干这件事只有 110 KB。
 *
 * mux.js 的 Transmuxer 是流式的：喂进一段 TS，它吐出
 * 「一个初始化段 + 若干 moof/mdat 分片」。把这些按顺序拼起来，
 * 就是一个分片式 MP4 —— 现代播放器（Chrome / VLC / PotPlayer / ffmpeg）
 * 都直接认。注意产物是 **fragmented MP4**，不是那种带 moov 索引的
 * 普通 MP4；要变成后者得再跑一次真正的 remux，那是另一个话题。
 *
 * 这个模块不 import mux.js，而是接收它 —— 因为浏览器里它是 <script> 挂上来的
 * 全局 `muxjs`，而 Node 测试里是从 vendor 文件加载的对象。同一份实现，两种来源。
 */

/** mux.js 可能返回大 buffer 上的视图，必须按视图范围拷一份 */
function copyFragment(view) {
  if (!view || !view.byteLength) return null;
  return view instanceof Uint8Array
    ? view.slice()
    : new Uint8Array(view).slice();
}

export function assertMuxjs(muxjs) {
  if (!muxjs || typeof muxjs.mp4?.Transmuxer !== 'function') {
    throw new Error('mux.js 未加载或版本不兼容：缺少 muxjs.mp4.Transmuxer');
  }
}

/**
 * 创建一个 TS 重封装器。
 *
 * @param {object} muxjs  mux.js 命名空间
 * @param {object} [opts]
 * @param {(init: Uint8Array) => void} [opts.onInit]     初始化段（只会来一次）
 * @param {(data: Uint8Array) => void} [opts.onFragment] 每个媒体分片
 */
export function createTsRemuxer(muxjs, opts = {}) {
  assertMuxjs(muxjs);

  const transmuxer = new muxjs.mp4.Transmuxer({
    remux: true,
    keepOriginalTimestamps: false,
  });

  let initSegment = null;
  let fragments = 0;
  let byteLength = 0;
  const pendingErrors = [];

  transmuxer.on('data', (segment) => {
    const init = copyFragment(segment.initSegment);
    // 初始化段只在第一个分片时出现一次；不连续点之后 mux.js 也可能再给一次，
    // 那种情况下前面那个已经代表了整条流，重复写入反而会破坏文件。
    if (init && !initSegment) {
      initSegment = init;
      byteLength += init.byteLength;
      opts.onInit?.(init);
    }
    const data = copyFragment(segment.data);
    if (data) {
      fragments += 1;
      byteLength += data.byteLength;
      opts.onFragment?.(data);
    }
  });

  transmuxer.on('log', (info) => {
    if (info?.level === 'error') pendingErrors.push(info.message || String(info));
  });

  return {
    /** 喂进一段 TS。内部 push + flush，保证输出顺序和输入顺序一致 */
    append(bytes) {
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      transmuxer.push(data);
      transmuxer.flush();
    },
    /** 全部喂完后调一次，让 mux.js 吐出尾巴上的数据 */
    end() {
      transmuxer.flush();
    },
    get initSegment() { return initSegment; },
    get fragmentCount() { return fragments; },
    get byteLength() { return byteLength; },
    get errors() { return [...pendingErrors]; },
  };
}

/**
 * 判断一段数据是不是分片 MP4（而不是 MPEG-TS）。
 * 用于自动决定「直接拼接」还是「走重封装」。
 */
export function sniffContainer(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.byteLength < 8) return 'unknown';
  // MPEG-TS：包长 188，同步字节 0x47
  if (b[0] === 0x47 && (b.byteLength < 189 || b[188] === 0x47)) return 'mpegts';
  // ISO BMFF：前 4 字节是 box 大小，接着是 box 类型
  const type = String.fromCharCode(b[4], b[5], b[6], b[7]);
  if (type === 'ftyp' || type === 'styp' || type === 'moof' || type === 'moov' || type === 'sidx') {
    return 'fmp4';
  }
  // ADTS 音频
  if (b[0] === 0xff && (b[1] & 0xf0) === 0xf0) return 'adts';
  return 'unknown';
}
