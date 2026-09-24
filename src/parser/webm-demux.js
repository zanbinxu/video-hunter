/**
 * WebM（Matroska）拆包 —— 只做抓流真正需要的那部分。
 *
 * ## 为什么需要它
 *
 * 用户报的：「抓 YouTube 的视频能抓到画面，但是抓不到声音。」
 *
 * 真机探到的分组是这样的（`--site` 打出来的现场）：
 *
 *     video/mp4; codecs="av01.0.01M.08"  51 段 1.31 MB   → 合进产物了
 *     audio/webm; codecs="opus"          19 段 0.80 MB   → 认不出容器，被跳过
 *
 * YouTube（以及一大票走 MSE 的站点）**音频轨用的是 WebM/Opus**，
 * 而我们的合并器只认 fMP4。于是产物里只有画面，一声不响。
 *
 * ## 为什么只拆到"帧"为止
 *
 * 这个模块只负责把字节拆成「一条轨 + 一串带时间戳的帧」。Opus 不能直接
 * 放进 MP4 给普通播放器播，所以上层还要把它解码成 PCM、再编码成 AAC
 * （见 offscreen/audio-transcode.js）。拆包和转码分开写的好处是：
 * **拆包能脱离浏览器在 Node 里用真样本测**（这个仓库的规矩：
 * 最容易出错的位运算必须能用固定样本钉住）。
 *
 * ## EBML 的几个坑（都踩过）
 *
 *   · 元素 ID 要**连长度标记位一起**读（`1A 45 DF A3` 就是四个字节的 ID），
 *     而 size 要把标记位去掉 —— 两者规则不同，用同一个函数读必然出错。
 *   · size 的数据位**全是 1** 表示"长度未知"：直播/流式 WebM 的 Segment
 *     就是这个形态。不认它的话，第一个元素就解析不下去。
 *   · Block 里的相对时间戳是 **int16 有符号**，超过 32767 毫秒会变成负数，
 *     直接当无符号读会让时间轴倒着走。
 *   · Block 的 flags 里藏着 lacing（0/1/2/3 四种）：一个 Block 可能塞了
 *     好几个帧。不拆 lacing 的话，Opus 解码器会因为"一个包里有多帧"
 *     直接报错。
 */

/* ------------------------------------------------------------------ *
 * EBML 基础
 * ------------------------------------------------------------------ */

/** 我们用得到的元素 ID（都是"连标记位"的原始值） */
export const EBML_ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecName: 0x258688,
  DefaultDuration: 0x23e383,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  OutputSamplingFrequency: 0x78b5,
  Channels: 0x9f,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
  Colour: 0x55b0,
};

const TRACK_TYPE = { 1: 'video', 2: 'audio', 3: 'complex', 16: 'logo', 17: 'subtitle' };

/** WebM 的 CodecID 字符串 → 我们内部认的编码名 */
export const WEBM_CODECS = {
  A_OPUS: { media: 'audio', codec: 'opus' },
  A_VORBIS: { media: 'audio', codec: 'vorbis' },
  A_AAC: { media: 'audio', codec: 'aac' },
  V_VP8: { media: 'video', codec: 'vp8' },
  V_VP9: { media: 'video', codec: 'vp9' },
  V_AV1: { media: 'video', codec: 'av1' },
  'V_MPEG4/ISO/AVC': { media: 'video', codec: 'avc' },
};

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

/** 只看头几个字节：是不是 WebM/Matroska */
export function isWebm(bytes) {
  if (!bytes || bytes.byteLength < 4) return false;
  return EBML_MAGIC.every((b, i) => bytes[i] === b);
}

/** 是不是"没有初始化段"的裸 Cluster（抓流从中间开始时就是这样） */
export function isWebmClusterStart(bytes) {
  if (!bytes || bytes.byteLength < 4) return false;
  return bytes[0] === 0x1f && bytes[1] === 0x43 && bytes[2] === 0xb6 && bytes[3] === 0x75;
}

/**
 * 读一个 EBML 变长整数。
 *
 * @param {Uint8Array} bytes
 * @param {number} pos
 * @param {boolean} keepMarker ID 要保留长度标记位（ID 的标记位是值的一部分），
 *                            size 要去掉（标记位只表示长度）
 * @returns {{value:number, length:number}|null}
 */
function readVint(bytes, pos, keepMarker) {
  if (pos >= bytes.byteLength) return null;
  const first = bytes[pos];
  if (first === 0) return null; // 首字节 0 = 需要 9 字节以上，规范里不允许
  let length = 1;
  for (let mask = 0x80; mask > 0; mask >>= 1) {
    if (first & mask) break;
    length += 1;
  }
  if (length > 8 || pos + length > bytes.byteLength) return null;
  let value = keepMarker ? first : (first & (0xff >> length));
  for (let i = 1; i < length; i += 1) value = value * 256 + bytes[pos + i];
  return { value, length };
}

/** 元素头。size 的数据位全是 1 时 unknownSize=true（直播流的 Segment 就这样） */
function readHeader(bytes, pos) {
  const id = readVint(bytes, pos, true);
  if (!id) return null;
  const size = readVint(bytes, pos + id.length, false);
  if (!size) return null;
  const payloadStart = pos + id.length + size.length;
  const dataBits = 7 * size.length;
  const allOnes = 2 ** dataBits - 1;
  const unknownSize = size.value === allOnes;
  return { id: id.value, start: pos, payloadStart, size: unknownSize ? null : size.value, unknownSize };
}

/**
 * 逐个走一层里的元素。
 *
 * ⚠️ 长度未知的元素只能读到**本层末尾**：它没有终点信息，规范要求它必须是
 * 最后一个（或者靠"下一个同层 ID"来断）。真实抓流里这只出现在 Segment 上，
 * 这里就按"读到 end 为止"处理，并且不再继续找它的兄弟 —— 那不可能存在。
 */
function* walk(bytes, start, end) {
  let pos = start;
  while (pos + 2 <= end) {
    const head = readHeader(bytes, pos);
    if (!head) return;
    const payloadEnd = head.unknownSize ? end : Math.min(end, head.payloadStart + head.size);
    if (payloadEnd < head.payloadStart) return;
    yield { ...head, payloadEnd };
    if (head.unknownSize) return;
    pos = payloadEnd;
  }
}

/**
 * 遇到"播放器又发了一份 init"时，跳到**下一个 Cluster**。
 *
 * ## 为什么必须专门处理（用户 2026-09-24 报的那个）
 *
 * 抓流钩的是 `appendBuffer`，而 MSE 允许播放器在**同一条** SourceBuffer 里
 * 重新初始化：`changeType()`、拖进度条重新预取、码率自适应都会再 append 一份
 * init 进去。于是抓到的字节流会变成 `init + clusters + init + clusters`。
 *
 * 第二份 init 里那个 `Segment` 元素声明的是**它原来那个文件的长度**（几百 KB 到几 MB），
 * 照着这个长度往下跳，后面真实抓到的 Cluster 就被**整段吞掉**了 —— 这正是
 * "产物里画面只有开头 23 秒、后面十二分钟只剩音频"的成因（缓冲里明明有 302 MB，
 * 写出来的文件只有 32 MB）。
 *
 * 判据是规范级的，不靠猜：**Segment 不允许嵌 Segment**，EBML Header 也不允许出现在
 * Segment 里。所以在这一层看到它们，只有一个解释：这里又来了一份 init。
 *
 * 处理：**不认那份 init 声明的长度**，改看它自己的子元素（Tracks / SeekHead / Info…），
 * 逐个跳过，直到遇到真正的 Cluster —— 那才是要继续读的数据。
 *
 * @returns {number|null} 下一个 Cluster 的偏移；认不出来返回 null（调用方必须如实上报）
 */
function skipReinitialization(bytes, head, end) {
  // EBML Header：自己是完整元素（长度是真的），跳过它即可 —— 紧随其后的那半份
  // Segment 由下一轮循环识别
  if (head.id === EBML_ID.EBML) {
    if (head.unknownSize) return null;
    const after = head.payloadStart + head.size;
    return after > head.payloadStart && after <= end ? after : null;
  }
  // Segment：**不看它声明的长度**，只看它的子元素，直到遇到 Cluster
  let pos = head.payloadStart;
  for (let guard = 0; guard < 512 && pos + 2 <= end; guard += 1) {
    const child = readHeader(bytes, pos);
    if (!child) return null;
    if (child.id === EBML_ID.Cluster) return pos;
    if (child.unknownSize) return null;
    const childEnd = child.payloadStart + child.size;
    if (childEnd <= child.payloadStart || childEnd > end) return null;
    pos = childEnd;
  }
  return null;
}

/**
 * 走 Segment 的内容，并处理两种"按声明长度走会丢数据"的情形：
 *
 *  1. **中途又发了一份 init**（见 `skipReinitialization`）：认出它、跳过它自己的
 *     子元素，在下一个 Cluster 处继续读；
 *  2. **Segment 声明的长度比实际字节短**（借来的头部、或者重发 init 之后继续 append）：
 *     声明范围走完之后，只要后面确实还是 Cluster / init，就接着读，并**报出来**。
 *
 * 而且读不动时不再静默收场 —— 通过 `onNote` 把"还剩多少字节没读"交给上层去说。
 * 这个函数只做"多认出来一些数据"，不会跳过任何 Cluster：新结果一定是旧结果的超集。
 *
 * @param {function} onNote 记录每一处跳过/放弃：{at, bytes, reinit?, short?, broken?}
 */
function* walkSegmentContent(bytes, start, declaredEnd, end, onNote) {
  let pos = start;
  let limit = Math.min(declaredEnd, end);
  const extended = limit >= end;
  for (let guard = 0; guard < 1e6 && pos + 2 <= limit; guard += 1) {
    const head = readHeader(bytes, pos);
    if (!head) {
      onNote({ at: pos, bytes: limit - pos, broken: true });
      return;
    }
    if (head.id === EBML_ID.EBML || head.id === EBML_ID.Segment) {
      const next = skipReinitialization(bytes, head, limit);
      // EBML Header 那一半不单独报（它和紧随其后的 Segment 是同一次重新初始化）
      if (head.id === EBML_ID.Segment) {
        onNote({ at: pos, bytes: (next ?? limit) - pos, reinit: true, broken: next == null });
      }
      if (next == null) return;
      pos = next;
      continue;
    }
    const payloadEnd = head.unknownSize ? limit : Math.min(limit, head.payloadStart + head.size);
    if (payloadEnd < head.payloadStart) return;
    yield { ...head, payloadEnd };
    if (head.unknownSize) return;
    pos = payloadEnd;
  }
  // 声明范围走完了，缓冲里却还有数据：只有确实还是 Cluster / init 才继续，
  // 否则就当"到这里为止"（保持原来的行为，不乱读）
  if (pos + 2 <= end && !extended) {
    const peek = readHeader(bytes, pos);
    const looksLikeData = peek
      && (peek.id === EBML_ID.Cluster || peek.id === EBML_ID.EBML || peek.id === EBML_ID.Segment);
    if (looksLikeData) {
      onNote({ at: pos, bytes: end - pos, short: true });
      yield* walkSegmentContent(bytes, pos, end, end, onNote);
    }
  }
}

/** 无符号整数元素（EBML 里整数是**大端、定长**，不是变长） */
function readUint(bytes, el) {
  let value = 0;
  for (let i = el.payloadStart; i < el.payloadEnd; i += 1) value = value * 256 + bytes[i];
  return value;
}

function readFloat(bytes, el) {
  const length = el.payloadEnd - el.payloadStart;
  if (length !== 4 && length !== 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + el.payloadStart, length);
  return length === 4 ? view.getFloat32(0) : view.getFloat64(0);
}

function readString(bytes, el) {
  let out = '';
  for (let i = el.payloadStart; i < el.payloadEnd; i += 1) {
    const c = bytes[i];
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out;
}

function slice(bytes, el) {
  return bytes.slice(el.payloadStart, el.payloadEnd);
}

function findChild(bytes, start, end, id) {
  for (const el of walk(bytes, start, end)) {
    if (el.id === id) return el;
    // 长度未知的兄弟之后没法继续定位，只能放弃
    if (el.unknownSize) return null;
  }
  return null;
}

/** 收集一层的所有直接子元素（一次遍历，避免反复 walk） */
function children(bytes, element) {
  return [...walk(bytes, element.payloadStart, element.payloadEnd)];
}

/* ------------------------------------------------------------------ *
 * 初始化段
 * ------------------------------------------------------------------ */

function parseTrackEntry(bytes, entry) {
  const kids = children(bytes, entry);
  const pick = (id) => kids.find((k) => k.id === id) || null;

  const numberEl = pick(EBML_ID.TrackNumber);
  const typeEl = pick(EBML_ID.TrackType);
  const codecEl = pick(EBML_ID.CodecID);
  if (!numberEl || !typeEl || !codecEl) return null;

  const codecId = readString(bytes, codecEl);
  const known = WEBM_CODECS[codecId] || null;
  const track = {
    number: readUint(bytes, numberEl),
    type: TRACK_TYPE[readUint(bytes, typeEl)] || 'other',
    codecId,
    codec: known ? known.codec : '',
    trackUID: pick(EBML_ID.TrackUID) ? readUint(bytes, pick(EBML_ID.TrackUID)) : 0,
    codecName: pick(EBML_ID.CodecName) ? readString(bytes, pick(EBML_ID.CodecName)) : '',
    // Opus 的 CodecPrivate 就是 OpusHead，解码器配置要它
    codecPrivate: pick(EBML_ID.CodecPrivate) ? slice(bytes, pick(EBML_ID.CodecPrivate)) : null,
    defaultDurationNs: pick(EBML_ID.DefaultDuration) ? readUint(bytes, pick(EBML_ID.DefaultDuration)) : 0,
    sampleRate: 0,
    channels: 0,
    width: 0,
    height: 0,
    frames: [],
  };

  const audio = pick(EBML_ID.Audio);
  if (audio) {
    const audioKids = children(bytes, audio);
    const rate = audioKids.find((k) => k.id === EBML_ID.SamplingFrequency) || null;
    const outRate = audioKids.find((k) => k.id === EBML_ID.OutputSamplingFrequency) || null;
    const channels = audioKids.find((k) => k.id === EBML_ID.Channels) || null;
    track.sampleRate = Math.round(readFloat(bytes, outRate || rate) || 0);
    track.channels = channels ? readUint(bytes, channels) : 0;
  }

  const video = pick(EBML_ID.Video);
  if (video) {
    const videoKids = children(bytes, video);
    const w = videoKids.find((k) => k.id === EBML_ID.PixelWidth) || null;
    const h = videoKids.find((k) => k.id === EBML_ID.PixelHeight) || null;
    track.width = w ? readUint(bytes, w) : 0;
    track.height = h ? readUint(bytes, h) : 0;
  }

  return track;
}

/**
 * 解析 WebM 头部：TimecodeScale + 轨道表。
 *
 * @param {Uint8Array} bytes 从 EBML 头开始的字节（可以是整个流，多余部分会被忽略）
 * @returns {{timestampScaleNs:number, tracks:Array, hasHeader:boolean}}
 */
export function parseWebmInit(bytes) {
  if (!isWebm(bytes)) throw new Error('不是 WebM：开头不是 EBML 头（1A 45 DF A3）');

  const out = { timestampScaleNs: 1_000_000, tracks: [], hasHeader: true };
  const segment = findChild(bytes, 0, bytes.byteLength, EBML_ID.Segment);
  if (!segment) throw new Error('WebM 里找不到 Segment 元素');

  for (const el of walk(bytes, segment.payloadStart, segment.payloadEnd)) {
    if (el.id === EBML_ID.Info) {
      const scale = findChild(bytes, el.payloadStart, el.payloadEnd, EBML_ID.TimestampScale);
      if (scale) {
        const value = readUint(bytes, scale);
        if (value > 0) out.timestampScaleNs = value;
      }
    } else if (el.id === EBML_ID.Tracks) {
      for (const entry of children(bytes, el)) {
        if (entry.id !== EBML_ID.TrackEntry) continue;
        const track = parseTrackEntry(bytes, entry);
        if (track) out.tracks.push(track);
      }
    }
  }

  if (!out.tracks.length) throw new Error('WebM 的 Tracks 里一条轨都没有');
  return out;
}

/**
 * 把采集到的 WebM 字节切成「初始化段」和「媒体段」。
 *
 * MSE 的写法就是先 append 一次头部（EBML + Segment + Info + Tracks），
 * 之后每次 append 一个 Cluster。抓流把它们按到达顺序拼起来，于是就得到
 * 一个完整的 WebM；这里按 Tracks 元素的结尾切开。
 */
export function splitWebmInit(bytes) {
  if (!isWebm(bytes)) {
    // 抓流是中途开的：第一段就是 Cluster，头部根本没有
    if (isWebmClusterStart(bytes)) {
      const err = new Error('只有媒体分片，没有初始化段（WebM 的头部没抓到）');
      err.missingInit = true;
      throw err;
    }
    throw new Error('不是 WebM：开头不是 EBML 头（1A 45 DF A3）');
  }
  const segment = findChild(bytes, 0, bytes.byteLength, EBML_ID.Segment);
  if (!segment) throw new Error('WebM 里找不到 Segment 元素');

  // 初始化段的终点 = **第一个 Cluster 之前最后一个元素的终点**。
  //
  // 不能只认 Tracks 的终点：WebM 头部里 Cluster 之前还可能有 Tags/SeekHead/Cues
  // 之类的元素（ffmpeg 就爱在 Tracks 后面塞一个 Tags）。那些字节要是被划进
  // "媒体段"，后面拼回去的文件就多了一段认不出来的东西。
  let end = 0;
  for (const el of walk(bytes, segment.payloadStart, segment.payloadEnd)) {
    if (el.id === EBML_ID.Cluster) break;
    end = Math.max(end, el.payloadEnd);
  }
  if (!end) {
    // 头部里什么都没有：说明采到的第一段就是 Cluster（抓流是中途开的）
    if (isWebmClusterStart(bytes.subarray(segment.payloadStart, segment.payloadStart + 4))) {
      const err = new Error('只有媒体分片，没有初始化段（WebM 的头部没抓到）');
      err.missingInit = true;
      throw err;
    }
    throw new Error('WebM 头部里没有 Tracks，认不出轨道');
  }
  return { init: bytes.slice(0, end), media: bytes.slice(end) };
}

/* ------------------------------------------------------------------ *
 * Cluster / Block
 * ------------------------------------------------------------------ */

/**
 * 拆一个 Block 的 lacing，返回每一帧的字节。
 *
 * 四种形态（flags 的 bit1-2）：
 *   0 无 lacing：整块就是一帧
 *   1 Xiph：先一个"帧数-1"，然后每帧长度用 255 累加（值 255 表示还要继续加）
 *   2 固定：所有帧等长，除最后一帧
 *   3 EBML：第一个长度是 vint，后面每个是"和上一个长度的有符号差值"（vint 编码）
 */
function splitLacing(bytes, start, end, lacing, frameCount) {
  if (lacing === 0) return [{ start, end }];

  const sizes = [];
  if (lacing === 1) {
    // Xiph：长度只写了前 frameCount 帧，**最后一帧的长度是剩下的全部**
    let pos = start;
    for (let i = 0; i < frameCount; i += 1) {
      let size = 0;
      for (;;) {
        if (pos >= end) return null;
        const byte = bytes[pos];
        pos += 1;
        size += byte;
        if (byte !== 255) break;
      }
      sizes.push(size);
    }
    const frames = [];
    let cursor = pos;
    for (const size of sizes) {
      frames.push({ start: cursor, end: cursor + size });
      cursor += size;
    }
    frames.push({ start: cursor, end });
    return frames;
  }

  if (lacing === 2) {
    // 固定长度：把剩下的字节按帧数均分
    const total = end - start;
    if (total % (frameCount + 1) !== 0) return null;
    const size = total / (frameCount + 1);
    const frames = [];
    for (let i = 0; i <= frameCount; i += 1) {
      frames.push({ start: start + i * size, end: start + (i + 1) * size });
    }
    return frames;
  }

  // EBML：第一个是长度（vint），后面是差值
  const first = readVint(bytes, start, false);
  if (!first) return null;
  let cursor = start + first.length;
  const sizes2 = [first.value];
  let previous = first.value;
  for (let i = 1; i <= frameCount; i += 1) {
    const delta = readVint(bytes, cursor, false);
    if (!delta) return null;
    cursor += delta.length;
    // 差值是"带符号的 vint"：减去该长度的中值
    const bias = 2 ** (7 * delta.length - 1) - 1;
    previous += delta.value - bias;
    sizes2.push(previous);
  }
  const frames = [];
  for (const size of sizes2) {
    frames.push({ start: cursor, end: cursor + size });
    cursor += size;
  }
  return frames;
}

function parseBlock(bytes, el, clusterTime) {
  const trackVint = readVint(bytes, el.payloadStart, false);
  if (!trackVint) return null;
  let pos = el.payloadStart + trackVint.length;
  if (pos + 3 > el.payloadEnd) return null;

  // ⚠️ 相对时间戳是 int16 **有符号**：超过 32767 毫秒就成了负数
  const raw = (bytes[pos] << 8) | bytes[pos + 1];
  const relative = raw > 0x7fff ? raw - 0x10000 : raw;
  pos += 2;
  const flags = bytes[pos];
  pos += 1;

  const keyframe = (flags & 0x80) !== 0;
  const lacing = (flags >> 1) & 0x03;
  let frameCount = 0;
  if (lacing !== 0) {
    if (pos >= el.payloadEnd) throw new Error('Block 声明了 lacing，但没有帧数字节');
    frameCount = bytes[pos];
    pos += 1;
  }

  const ranges = splitLacing(bytes, pos, el.payloadEnd, lacing, frameCount);
  if (!ranges) throw new Error(`Block 的 lacing 解析失败（形态 ${lacing}，帧数 ${frameCount + 1}）`);

  return {
    trackNumber: trackVint.value,
    time: clusterTime + relative,
    keyframe,
    frames: ranges.map((r) => bytes.slice(r.start, r.end)),
  };
}

/**
 * 拆出所有帧。
 *
 * @param {Uint8Array} bytes 完整 WebM 字节（头部 + 分片）
 * @returns {{timestampScaleNs:number, tracks:Array}} 每条轨上挂了 `frames`，
 *          每帧是 `{timeUs, durationUs, keyframe, data}`
 */
export function demuxWebm(bytes) {
  const info = parseWebmInit(bytes);
  const byNumber = new Map(info.tracks.map((t) => [t.number, t]));
  const segment = findChild(bytes, 0, bytes.byteLength, EBML_ID.Segment);
  const scaleUs = info.timestampScaleNs / 1000;
  const warnings = [];
  let skippedBlocks = 0;
  let clusters = 0;

  // 走 Segment 的内容：中途重发的 init / 声明长度不足，都在这里面处理并记下来
  const demuxNotes = [];
  for (const cluster of walkSegmentContent(
    bytes, segment.payloadStart, segment.payloadEnd, bytes.byteLength, (n) => demuxNotes.push(n),
  )) {
    if (cluster.id !== EBML_ID.Cluster) continue;
    clusters += 1;
    const timeEl = findChild(bytes, cluster.payloadStart, cluster.payloadEnd, EBML_ID.Timestamp);
    const clusterTime = timeEl ? readUint(bytes, timeEl) : 0;

    for (const el of walk(bytes, cluster.payloadStart, cluster.payloadEnd)) {
      let block = null;
      try {
        if (el.id === EBML_ID.SimpleBlock) {
          block = parseBlock(bytes, el, clusterTime);
        } else if (el.id === EBML_ID.BlockGroup) {
          const kids = children(bytes, el);
          const blockEl = kids.find((k) => k.id === EBML_ID.Block);
          if (blockEl) {
            block = parseBlock(bytes, blockEl, clusterTime);
            // BlockGroup 里没有 ReferenceBlock 才是关键帧
            if (block) block.keyframe = !kids.some((k) => k.id === EBML_ID.ReferenceBlock);
          }
        } else {
          continue;
        }
      } catch (err) {
        // 一个 Block 坏掉不该让整段抓流作废，但**绝不能一声不响地丢**：
        // 丢帧意味着产物中间少一截，用户只会觉得"这个工具做出来的文件有问题"。
        skippedBlocks += 1;
        if (warnings.length < 5) warnings.push(`第 ${clusters} 个 Cluster 里有个 Block 拆不动：${err.message}`);
        continue;
      }
      if (!block) { skippedBlocks += 1; continue; }
      const track = byNumber.get(block.trackNumber);
      if (!track) continue;
      for (const data of block.frames) {
        track.frames.push({
          timeUs: Math.round(block.time * scaleUs),
          durationUs: 0,
          keyframe: block.keyframe,
          data,
        });
      }
    }
  }

  // ---- 把"跳过 / 少读"如实说出来 ----
  //
  // 这三件事以前全是静默的，而静默正是这个 bug 难查的原因：
  // 产物短了一大截，界面上却写着"成功"，用户只能自己发现"后半段没画面"。
  const reinits = demuxNotes.filter((n) => n.reinit && !n.broken);
  const shorts = demuxNotes.filter((n) => n.short);
  const broken = demuxNotes.find((n) => n.broken);
  if (reinits.length && warnings.length < 5) {
    warnings.push(`播放器中途又发了一份初始化段（${reinits.length} 处）：`
      + '已经跳过它、接着读后面的内容（这是换码率/拖进度时播放器的正常动作）');
  }
  if (shorts.length && !reinits.length && warnings.length < 5) {
    warnings.push(`Segment 声明的长度比实际数据短（${shorts.length} 处）：已按实际字节继续读，`
      + '末尾那一段可能不完整');
  }
  if (broken && warnings.length < 5) {
    warnings.push(`读到第 ${clusters} 个 Cluster 之后读不动了（还剩 ${broken.bytes} 字节没读）：`
      + '这一段后面的内容没有进产物，这一份可能少了一截');
  }

  // 时长用**下一帧的时间戳**推：WebM 大多不写 DefaultDuration，
  // 而帧与帧的时间差是现成的、也是播放器实际用的那个值。
  for (const track of info.tracks) {
    const fallbackUs = track.defaultDurationNs ? Math.round(track.defaultDurationNs / 1000) : 0;
    for (let i = 0; i < track.frames.length; i += 1) {
      const frame = track.frames[i];
      const next = track.frames[i + 1];
      frame.durationUs = next ? Math.max(0, next.timeUs - frame.timeUs)
        : (fallbackUs || (i > 0 ? track.frames[i - 1].durationUs : 0));
    }
  }

  return {
    timestampScaleNs: info.timestampScaleNs,
    tracks: info.tracks,
    clusters,
    skippedBlocks,
    warnings,
    // 中途重发 init 的处数、以及"读不动了"剩下的字节数 —— 给上层做诊断/提示用
    reinitCount: reinits.length,
    unparsedBytes: broken ? broken.bytes : 0,
  };
}

/** 给 UI / 日志用的一句话描述 */
export function describeWebmTracks(tracks) {
  return tracks.map((t) => {
    const shape = t.type === 'audio' ? `${t.channels} 声道 ${t.sampleRate} Hz`
      : t.type === 'video' ? `${t.width}×${t.height}` : '';
    // 帧数是可选的：只解析初始化段（还没开始拆包）时一个帧都没有，
    // 那时候写"0 帧"是假话，不如不写。
    const frames = t.frames?.length ? `（${t.frames.length} 帧）` : '';
    return `${t.type}#${t.number} ${t.codecId}${shape ? ' ' + shape : ''}${frames}`;
  }).join('、');
}
