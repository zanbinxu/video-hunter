/**
 * 拆开"自包含"的 fMP4 文件。
 *
 * 背景：不是所有站点都给你一份清单（m3u8 / mpd）。B 站这类站点是通过 API
 * 直接返回**两条独立的 fMP4 轨道地址**（一条视频、一条音频），浏览器各拉一份。
 * 这两份文件本身是完整的：开头是 `ftyp` + `moov`（初始化段），后面跟着
 * 一串 `moof` + `mdat`（媒体分片）。想把它俩合成一个 MP4，就必须先把
 * 「初始化段」和「媒体分片」分开 —— 合并器要的正是这个形状。
 *
 * 这个文件只做这一件事，因为它是纯字节操作，最适合拿真实文件写测试。
 */

/** 只做文件头、不属于媒体的顶层 box */
const INIT_BOX_TYPES = new Set(['ftyp', 'moov', 'free', 'skip', 'wide']);

function readBoxSize(bytes, offset) {
  const b = bytes;
  const size32 = ((b[offset] << 24) | (b[offset + 1] << 16) | (b[offset + 2] << 8) | b[offset + 3]) >>> 0;
  if (size32 === 1) {
    // 64 位大小：用高 32 位判断是否超出安全范围
    const hi = ((b[offset + 8] << 24) | (b[offset + 9] << 16) | (b[offset + 10] << 8) | b[offset + 11]) >>> 0;
    const lo = ((b[offset + 12] << 24) | (b[offset + 13] << 16) | (b[offset + 14] << 8) | b[offset + 15]) >>> 0;
    if (hi !== 0) return -1; // 4GB 以上的单 box，浏览器里不可能，直接算异常
    return lo;
  }
  return size32;
}

/**
 * 列出顶层 box。
 * @returns {Array<{type:string, start:number, end:number}>}
 * @throws 结构不合法时抛错，而不是返回一个半截结果
 */
export function listTopLevelBoxes(bytes) {
  const out = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size = readBoxSize(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    // size 字段本身占 8 字节，所以最小合法值是 8
    let boxSize = size === 0 ? bytes.length - offset : size;
    if (boxSize < 8 || offset + boxSize > bytes.length) {
      throw new Error(
        `第 ${out.length + 1} 个 box（${type}）声明的长度不合法：`
        + `在偏移 ${offset} 处声称 ${boxSize} 字节，但文件只剩 ${bytes.length - offset} 字节`,
      );
    }
    out.push({ type, start: offset, end: offset + boxSize });
    offset += boxSize;
  }
  if (offset !== bytes.length) {
    throw new Error(`文件尾部有 ${bytes.length - offset} 字节解析不成 box，可能被截断了`);
  }
  return out;
}

/**
 * 把一份自包含的 fMP4 拆成 { init, fragments }。
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {{init: Uint8Array, fragments: Uint8Array, boxes: Array}}
 */
export function splitSelfContainedFmp4(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 16) throw new Error(`文件太小（${bytes.length} 字节），不像 fMP4`);

  const boxes = listTopLevelBoxes(bytes);

  // 初始化段必须是开头连续的那几个"文件头"box。
  // 遇到第一个 moof / styp / mdat 就停 —— 再往后都是媒体数据了。
  let initEnd = 0;
  let sawMoov = false;
  for (const box of boxes) {
    if (!INIT_BOX_TYPES.has(box.type)) break;
    if (box.type === 'moov') sawMoov = true;
    initEnd = box.end;
  }

  if (!sawMoov || initEnd === 0) {
    // 分片式 fMP4 常见两种形态：一种自带 moov，一种只有一个 moof，
    // 初始化段要另外取。这里必须说清楚是哪种，否则用户无从下手。
    const types = boxes.slice(0, 6).map((b) => b.type).join(', ');
    throw new Error(
      `这份文件里没有初始化段（moov），开头是：${types}。`
      + '它可能只是播放列表的一个分片，需要配套的初始化段才能合并。',
    );
  }
  if (initEnd >= bytes.length) {
    throw new Error('这份文件只有初始化段，没有任何媒体数据');
  }

  return {
    init: bytes.subarray(0, initEnd),
    fragments: bytes.subarray(initEnd),
    boxes,
  };
}

/**
 * 按路径找 box，返回从最外层到目标的整条链。
 *
 * 返回整条链而不只是目标 box，是因为调用方往往需要"所有祖先" ——
 * 比如在某个 box 内部插字节之后，得把所有包含插入点的祖先长度一起改掉。
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @param {string|string[]} path 例如 'moov.trak.mdia.minf.stbl.stsd.avc1'
 * @returns {Array<{type:string,start:number,size:number,headerSize:number,payloadStart:number,payloadEnd:number}>|null}
 */
export function findBoxPath(input, path) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const want = Array.isArray(path) ? path : String(path).split('.');
  const chain = [];
  let start = 0;
  let end = bytes.byteLength;

  for (const type of want) {
    const list = [];
    let p = start;
    while (p + 8 <= end) {
      let size = readBoxSize(bytes, p);
      let headerSize = 8;
      if (size === 1) headerSize = 16;
      else if (size === 0) size = end - p;
      if (size < headerSize || p + size > end) break;
      list.push({
        type: String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]),
        start: p,
        size,
        headerSize,
        payloadStart: p + headerSize,
        payloadEnd: p + size,
      });
      p += size;
    }
    const found = list.find((b) => b.type === type);
    if (!found) return null;
    chain.push(found);
    start = found.payloadStart + (CONTAINER_HEADERS[type] ?? 0);
    end = found.payloadEnd;
  }
  return chain;
}

/** 列出一个 box 的直接子 box */
function childBoxes(bytes, parent) {
  const out = [];
  let p = parent.payloadStart + (CONTAINER_HEADERS[parent.type] ?? 0);
  const end = parent.payloadEnd;
  while (p + 8 <= end) {
    let size = readBoxSize(bytes, p);
    let headerSize = 8;
    if (size === 1) headerSize = 16;
    else if (size === 0) size = end - p;
    if (size < headerSize || p + size > end) break;
    out.push({
      type: String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]),
      start: p,
      size,
      headerSize,
      payloadStart: p + headerSize,
      payloadEnd: p + size,
    });
    p += size;
  }
  return out;
}

/**
 * 列出一个初始化段（moov）里都有哪些轨。
 *
 * 为什么需要：TS 复用流重封装出来的 fMP4 里**音视频在同一条流里**，
 * 合并时要把同一份数据既当视频又当音频喂进去（各自只抽自己那条 trak 的样本）。
 * 那就得先知道这条流里到底有没有音频轨 —— 没有的话当音频喂会直接报错。
 *
 * @returns {string[]} 例如 ['video'] 或 ['video','audio']
 */
export function listInitTracks(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const moov = findBoxPath(bytes, ['moov']);
  if (!moov) return [];

  const types = [];
  for (const trak of childBoxes(bytes, moov[0]).filter((b) => b.type === 'trak')) {
    const mdia = childBoxes(bytes, trak).find((b) => b.type === 'mdia');
    if (!mdia) continue;
    const hdlr = childBoxes(bytes, mdia).find((b) => b.type === 'hdlr');
    if (!hdlr) continue;
    const handler = String.fromCharCode(
      bytes[hdlr.payloadStart + 8], bytes[hdlr.payloadStart + 9],
      bytes[hdlr.payloadStart + 10], bytes[hdlr.payloadStart + 11],
    );
    types.push(handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : handler);
  }
  return types;
}

/* ------------------------------------------------------------------ *
 * 结构诊断
 *
 * 「解析失败」这四个字对排查毫无帮助。上一版就是因为只报了一句
 * 「avc1 里没有 avcC」，隔着屏幕完全无从下手 —— 而用户手上正好有那份
 * 文件，只要把结构打出来就能一眼看出问题。
 *
 * 所以这里把 box 树整个摊开。真遇到不认识的封装时，日志本身就是诊断报告。
 * ------------------------------------------------------------------ */

/** 容器 box → 它的子 box 从 payload 起偏移多少才开始 */
const CONTAINER_HEADERS = {
  moov: 0, trak: 0, mdia: 0, minf: 0, stbl: 0, mvex: 0, edts: 0, dinf: 0,
  moof: 0, traf: 0, mfra: 0, udta: 0, tref: 0, strk: 0, stri: 0,
  meta: 4,  // version/flags
  stsd: 8,  // version/flags(4) + entry_count(4)
  // 样本描述项有固定头，子 box 要跳过它
  avc1: 78, avc3: 78, hvc1: 78, hev1: 78, av01: 78, encv: 78, vp09: 78, vvc1: 78,
  mp4a: 28, enca: 28, opus: 28, 'ac-3': 28, 'ec-3': 28, 'fLaC': 28,
};

/**
 * 把 box 树摊成可读的多行文本。
 *
 * 深度上限给得很宽（10 层）是有原因的：解码器配置项埋得很深 ——
 * moov→trak→mdia→minf→stbl→stsd→avc1→**avcC** 已经是第 8 层。
 * 第一版把上限设成 6，结果树刚好在 avcC 前面停住 ——
 * 诊断器在最需要它的那一刻失效了。行数上限才是真正管住输出的那个。
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @param {{maxDepth?: number, maxLines?: number}} [options]
 * @returns {string[]} 每行一条，带缩进
 */
export function describeBoxTree(input, options = {}) {
  const maxDepth = options.maxDepth ?? 10;
  const maxLines = options.maxLines ?? 80;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const lines = [];

  const walk = (start, end, depth) => {
    if (lines.length >= maxLines || depth > maxDepth) return;
    let p = start;
    while (p + 8 <= end && lines.length < maxLines) {
      let size = readBoxSize(bytes, p);
      let headerSize = 8;
      if (size === 1) { headerSize = 16; }
      else if (size === 0) { size = end - p; }
      if (size < headerSize || p + size > end) {
        lines.push(`${'  '.repeat(depth)}<无法解析：偏移 ${p} 处声称 ${size} 字节>`);
        return;
      }
      const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
      lines.push(`${'  '.repeat(depth)}${type} (${size})`);
      if (type in CONTAINER_HEADERS) {
        const skip = CONTAINER_HEADERS[type];
        walk(p + headerSize + skip, p + size, depth + 1);
      }
      p += size;
    }
  };

  walk(0, bytes.byteLength, 0);
  return lines;
}
