/**
 * 两路 fMP4（一条纯视频 + 一条纯音频）→ 一个标准 MP4。
 *
 * 为什么需要它：DASH 站点普遍把视频轨和音频轨拆成两个独立的 fMP4 流，
 * 各自有 init 段 + 一串 moof/mdat 分片。把两串字节首尾相接得到的文件
 * ffprobe 一条轨都读不出来（一个 MP4 只允许一个 moov）；直接分别存成两个
 * 文件用户又得自己对轨。所以必须**解析出样本、重新封装**。
 *
 * 路线选择：
 *   1. mux.js 的 Transmuxer 只做 TS→fMP4，没有「fMP4→MP4」这条路；
 *      它的 mp4.tools 是给检查用的，且有两个坑（见下面注释），
 *      所以盒子遍历和样本表解析这里自己写，只借 mp4-muxer 做最后的封装。
 *   2. mp4-muxer 本来面向 WebCodecs：`addVideoChunk` 要求参数是
 *      `EncodedVideoChunk` 实例，而 Node 24 里 **没有** 这个全局类。
 *      它的 `addVideoChunkRaw` / `addAudioChunkRaw` 没有这个限制，
 *      所以这里走 Raw 接口 —— 不需要伪造 EncodedVideoChunk。
 *   3. 时间戳的单位是**微秒**（mp4-muxer 内部 `/1e6` 变秒），
 *      不是 track timescale 的 tick。
 *
 * 已知的、明确不糊弄的限制：
 *   - 只有一路输入时不写 edit list，视频第一帧的 composition 领先
 *     （B 帧重排）会体现为产物 start_time ≈ 一帧的时长。mp4-muxer 不接受
 *     负的时间戳，写不出「DTS 为负、CTS 从 0 开始」这种正确的 edit list，
 *     这是库的能力边界，不是这里偷懒。
 *   - 支持 H.264 / H.265 + AAC。其它编码会明确报错，不会产出坏文件。
 */

import { Muxer, ArrayBufferTarget } from '../../vendor/mp4-muxer.mjs';

/* ------------------------------------------------------------------ *
 * 字节小工具
 * ------------------------------------------------------------------ */

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error('需要 Uint8Array / ArrayBuffer，实际拿到 ' + Object.prototype.toString.call(input));
}

const u8 = (b, p) => b[p];
const u16 = (b, p) => (b[p] << 8) | b[p + 1];
const u24 = (b, p) => (b[p] << 16) | (b[p + 1] << 8) | b[p + 2];
/** 位运算一律 >>> 0：JS 的 << 会掉进有符号 32 位，大 size 会变负数 */
const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const i32 = (b, p) => (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
const u64 = (b, p) => u32(b, p) * 2 ** 32 + u32(b, p + 4);
const boxType = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

const isPrintableType = (s) => /^[\x20-\x7e]{4}$/.test(s);

/* ------------------------------------------------------------------ *
 * box 遍历
 * ------------------------------------------------------------------ */

/**
 * 把一个范围内的 box 逐个切出来。
 *
 * 不用 muxjs.mp4.tools.findBox 的原因（实际踩到的）：
 *   findBox 把每个 box 的 payload 当成「一串平铺的 box」继续扫。这对
 *   moov/trak/mdia 成立，但对 stsd（payload 前面还有 version/flags +
 *   entry_count 8 字节）和 avc1（payload 前面是 78 字节
 *   VisualSampleEntry）就不成立 —— 于是 `findBox(bytes, ['moov',...,'stsd','avc1'])`
 *   永远返回空数组。盒子头长度因容器而异，只能自己知道。
 */
function readBoxes(bytes, start = 0, end = bytes.byteLength) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32(bytes, p);
    const type = boxType(bytes, p + 4);
    let headerSize = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = u64(bytes, p + 8);
      headerSize = 16;
    } else if (size === 0) {
      // size 0 = 一直到文件末尾
      size = end - p;
    }
    if (!isPrintableType(type) || size < headerSize || p + size > end) break;
    out.push({ type, start: p, size, headerSize, payloadStart: p + headerSize, payloadEnd: p + size });
    p += size;
  }
  return out;
}

function requireBox(list, type, what) {
  const box = list.find((b) => b.type === type);
  if (!box) throw new Error(`${what}：找不到 ${type} box（可能不是 fMP4，或数据被截断了）`);
  return box;
}

/**
 * 在一个字节区间里按**类型名**找一个 box，不依赖"从哪个偏移开始"这个假设。
 *
 * 为什么需要它：解析样本描述项时，子 box 的起始位置是标准里写死的
 * （VisualSampleEntry 头 78 字节、AudioSampleEntry 头 28 字节）。绝大多数
 * 文件都守规矩，但这不是能赌的事 —— 一旦某个打包器的头部长度不一样，
 * 按固定偏移去读就会**正好错过** avcC，然后报一句"avc1 里没有 avcC"，
 * 而那个 box 其实好端端地躺在文件里。
 *
 * 所以这里退一步：在整个区间里搜类型名，再用长度字段做校验。
 * 只有主路径失败时才会走到，不会影响正常解析。
 *
 * @param {Uint8Array} bytes
 * @param {number} start 搜索区间（含）
 * @param {number} end   搜索区间（不含）
 * @param {string[]} types 要找的 box 类型
 */
function scanForBox(bytes, start, end, types) {
  const from = Math.max(0, start);
  const to = Math.min(bytes.length, end);
  for (const type of types) {
    const code = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
    for (let p = from; p + 8 <= to; p += 1) {
      if (bytes[p + 4] !== code[0] || bytes[p + 5] !== code[1]
        || bytes[p + 6] !== code[2] || bytes[p + 7] !== code[3]) continue;
      // 长度字段必须让这个 box 完整落在区间里，否则就是撞上了同名的巧合字节
      const size = u32(bytes, p);
      if (size >= 8 && p + size <= to) {
        return { type, start: p, size, headerSize: 8, payloadStart: p + 8, payloadEnd: p + size };
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * init 段
 * ------------------------------------------------------------------ */

/** 解 AudioSpecificConfig 的头几个字段；拿不到返回 null。 */
export function parseAudioSpecificConfig(asc) {
  if (!asc || asc.length < 2) return null;
  let bitPos = 0;
  const readBits = (count) => {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const byte = asc[bitPos >> 3];
      if (byte === undefined) throw new RangeError('ASC 位读取越界');
      value = (value << 1) | ((byte >> (7 - (bitPos & 7))) & 1);
      bitPos += 1;
    }
    return value;
  };
  try {
    let audioObjectType = readBits(5);
    // 31 是转义：再读 6 位才是真正的 object type（HE-AAC 之类）
    if (audioObjectType === 31) audioObjectType = 32 + readBits(6);
    const frequencyIndex = readBits(4);
    let sampleRate = 0;
    if (frequencyIndex === 15) sampleRate = readBits(24);
    else {
      const table = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
      sampleRate = table[frequencyIndex] || 0;
    }
    const channels = readBits(4);
    return { audioObjectType, sampleRate, channels };
  } catch {
    return null;
  }
}

/**
 * 解 esds 里的 DecoderSpecificInfo（就是 AAC 的 AudioSpecificConfig）。
 *
 * 为什么自己解：mux.js inspect 出来的 esds 是错的（它从 payload 起点算
 * 偏移，实际要跳过 FullBox 的 version/flags），本仓库样本上读出来
 * `esId: 32896`、`audioObjectType: 0` 这种垃圾值。自己按 tag 走一遍只有
 * 三十行，而且描述符长度是 base-128 变长编码，本来也没法拍脑袋取。
 *
 * 失败返回 null —— 上层会退化成「按采样率/声道数猜一个 AAC-LC 的 ASC」，
 * mp4-muxer 本身也有同样的兜底，所以不值得为此中断合并。
 */
function parseEsds(bytes, payloadStart, payloadEnd) {
  const readDescriptor = (p) => {
    if (p + 2 > payloadEnd) return null;
    const tag = u8(bytes, p);
    let q = p + 1;
    let length = 0;
    let guard = 0;
    let byte;
    do {
      if (q >= payloadEnd || guard >= 4) return null;
      byte = u8(bytes, q);
      q += 1;
      length = (length << 7) | (byte & 0x7f);
      guard += 1;
    } while (byte & 0x80);
    return { tag, length, payloadStart: q, payloadEnd: Math.min(q + length, payloadEnd) };
  };

  const es = readDescriptor(payloadStart + 4); // 跳过 FullBox 的 version/flags
  if (!es || es.tag !== 0x03) return null;
  let p = es.payloadStart + 2; // ES_ID
  const flags = u8(bytes, p);
  p += 1;
  if (flags & 0x80) p += 2;
  if (flags & 0x40) p += 1 + u8(bytes, p); // URL 长度在长度字节自己身上
  if (flags & 0x20) p += 2;

  const decoderConfig = readDescriptor(p);
  if (!decoderConfig || decoderConfig.tag !== 0x04) return null;
  const objectTypeIndication = u8(bytes, decoderConfig.payloadStart);
  // 跳过 objectTypeIndication(1) + streamType/bufferSize(4) + maxBitrate(4) + avgBitrate(4)
  const specific = readDescriptor(decoderConfig.payloadStart + 13);
  if (!specific || specific.tag !== 0x05) return { objectTypeIndication, audioSpecificConfig: null };
  return {
    objectTypeIndication,
    audioSpecificConfig: bytes.slice(specific.payloadStart, specific.payloadEnd),
  };
}

/** 按 ffmpeg 的写法推出 `avc1.PPCCLL`，只用来显示和记录，不参与封装。 */
function avcCodecString(avcC) {
  if (!avcC || avcC.length < 4) return 'avc1';
  const hex = (v) => v.toString(16).padStart(2, '0');
  return `avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`;
}

/**
 * 按 AV1 规范推出 `av01.<profile>.<level><tier>.<bitDepth>`。
 *
 * av1C 的 4 个头字节（AV1-ISOBMFF §2.3.3）：
 *   byte0: marker(1) | version(7)
 *   byte1: seq_profile(3) | seq_level_idx_0(5)
 *   byte2: seq_tier_0(1) | high_bitdepth(1) | twelve_bit(1) | monochrome(1) |
 *          chroma_subsampling_x(1) | chroma_subsampling_y(1) | chroma_sample_position(2)
 *   byte3: reserved(3) | initial_presentation_delay_present(1) | …(4)
 */
function av1CodecString(av1C) {
  if (!av1C || av1C.length < 4) return 'av01';
  const profile = (av1C[1] >> 5) & 0x07;
  const level = av1C[1] & 0x1f;
  const tier = (av1C[2] >> 7) & 0x01 ? 'H' : 'M';
  const highBitdepth = (av1C[2] >> 6) & 0x01;
  const twelveBit = (av1C[2] >> 5) & 0x01;
  const bitDepth = highBitdepth === 0 ? 8 : (twelveBit === 1 ? 12 : 10);
  return `av01.${profile}.${String(level).padStart(2, '0')}${tier}.${String(bitDepth).padStart(2, '0')}`;
}

/**
 * 视频**样本描述项** → 解码器配置记录的名字 + 交给封装器的编码名。
 *
 * 这张表是用户报的一个 bug 逼出来的：B 站现在发的视频轨是 **AV1**，
 * 样本描述项叫 `av01`、配置记录叫 `av1C`。结构和 H.264 的 `avc1`/`avcC`
 * 完全一样，只是名字不同 —— 而代码里写死了 `avcC`/`hvcC` 就会在这里翻车：
 * 报一句"拿不到 H.264/H.265 解码器配置记录"，然后退化成"只存最大的一条轨道"，
 * 用户拿到一个**没有声音**的视频。
 *
 * 所以改成查表，而不是把名字写进分支里。以后再加编码只要往表里加一行。
 */
const VIDEO_SAMPLE_ENTRIES = {
  avc1: { config: 'avcC', vendor: 'avc' },
  avc3: { config: 'avcC', vendor: 'avc' },
  hvc1: { config: 'hvcC', vendor: 'hevc' },
  hev1: { config: 'hvcC', vendor: 'hevc' },
  av01: { config: 'av1C', vendor: 'av1' },
};

const VIDEO_SAMPLE_ENTRY_HEADER = 78; // VisualSampleEntry 固定头
const AUDIO_SAMPLE_ENTRY_HEADER = 28; // AudioSampleEntry 固定头

/** hdlr 里的 handler_type → video/audio */
const HANDLER_CONTENT_TYPE = { vide: 'video', soun: 'audio' };

function readTrakHandler(bytes, trak) {
  const mdia = readBoxes(bytes, trak.payloadStart, trak.payloadEnd).find((b) => b.type === 'mdia');
  if (!mdia) return '';
  const hdlr = readBoxes(bytes, mdia.payloadStart, mdia.payloadEnd).find((b) => b.type === 'hdlr');
  if (!hdlr) return '';
  return HANDLER_CONTENT_TYPE[boxType(bytes, hdlr.payloadStart + 8)] || '';
}

/**
 * 解析 fMP4 初始化段（moov），拿出重新封装需要的一切。
 *
 * 一个 init 段里可能有**多条轨**：mux.js 把一条同时含音视频的 TS 重封装成 fMP4 时，
 * moov 里就是两条 trak；HLS 的 `.m4s` 也可能是音视频复用的。所以这里按
 * `options.contentType` 挑对应的那条 trak，而不是无脑取第一条 ——
 * 这样 `mergeFmp4` 既能吃「一路一条轨」的 DASH，也能吃「一条轨里混着两条」
 * 的 mux.js 产物（同一条流既当视频又当音频喂进来，各自只会抽自己那条 trak 的样本）。
 *
 * @param {Uint8Array|ArrayBuffer} input init 段字节
 * @param {{contentType?: 'video'|'audio'}} [options]
 * @returns {object} 轨道信息 + 解码器描述
 */
export function parseInitSegment(input, options = {}) {
  const bytes = toBytes(input);
  const top = readBoxes(bytes);
  const moov = requireBox(top, 'moov', '不是 fMP4 初始化段');

  const traks = readBoxes(bytes, moov.payloadStart, moov.payloadEnd).filter((b) => b.type === 'trak');
  if (!traks.length) throw new Error('初始化段里没有 trak（轨道），解析不了解码器信息');

  const wanted = options.contentType || '';
  let trak = traks.find((candidate) => readTrakHandler(bytes, candidate) === wanted) || traks[0];
  if (wanted && readTrakHandler(bytes, trak) !== wanted) {
    // 找不到要的那条轨就仍然解析第一条，让上层给出「输入传反了」这种能看懂的错误
    trak = traks[0];
  }

  const trakBoxes = readBoxes(bytes, trak.payloadStart, trak.payloadEnd);
  const tkhd = requireBox(trakBoxes, 'tkhd', '轨道里没有 tkhd');
  const mdia = requireBox(trakBoxes, 'mdia', '轨道里没有 mdia');

  const trackId = u8(bytes, tkhd.payloadStart) === 1
    ? u32(bytes, tkhd.payloadStart + 20)
    : u32(bytes, tkhd.payloadStart + 12);

  const mdiaBoxes = readBoxes(bytes, mdia.payloadStart, mdia.payloadEnd);
  const mdhd = requireBox(mdiaBoxes, 'mdhd', '轨道里没有 mdhd');
  const hdlr = requireBox(mdiaBoxes, 'hdlr', '轨道里没有 hdlr');

  const mdhdVersion = u8(bytes, mdhd.payloadStart);
  const timescale = u32(bytes, mdhd.payloadStart + (mdhdVersion === 1 ? 20 : 12));

  const handler = boxType(bytes, hdlr.payloadStart + 8);
  const contentType = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : handler;

  const minf = requireBox(mdiaBoxes, 'minf', '轨道里没有 minf');
  const stbl = requireBox(readBoxes(bytes, minf.payloadStart, minf.payloadEnd), 'stbl', '轨道里没有 stbl');
  const stsd = requireBox(readBoxes(bytes, stbl.payloadStart, stbl.payloadEnd), 'stsd', '轨道里没有 stsd');

  // stsd 的 payload = version/flags(4) + entry_count(4) + 样本描述项
  const entries = readBoxes(bytes, stsd.payloadStart + 8, stsd.payloadEnd);
  if (!entries.length) throw new Error('stsd 里没有样本描述项，解析不了解码器信息');
  const entry = entries[0];

  const info = {
    trackId,
    timescale,
    contentType,
    codecType: entry.type,
    width: 0,
    height: 0,
    channels: 0,
    sampleRate: 0,
    description: null,
    decodeDescriptionName: '',
    // 交给封装器的编码名（avc / hevc / av1）。由样本描述项查表得出，
    // 不再靠"配置记录叫什么名字"去反推。
    vendorCodec: '',
    objectTypeIndication: 0,
    audioObjectType: 0,
    editMediaTime: 0,
    bytes: bytes.byteLength,
  };

  if (contentType === 'video') {
    const spec = VIDEO_SAMPLE_ENTRIES[entry.type];
    if (!spec) {
      throw new Error(
        `暂不支持的视频样本描述项：${entry.type}`
        + `（当前支持 ${Object.keys(VIDEO_SAMPLE_ENTRIES).join(' / ')}）。`
        + '这条路走不通时可以用「抓流」—— 它拿的是播放器已经解好的码流，什么编码都能存。',
      );
    }
    const kids = readBoxes(bytes, entry.payloadStart + VIDEO_SAMPLE_ENTRY_HEADER, entry.payloadEnd);
    let config = kids.find((b) => b.type === spec.config);
    if (!config) {
      // 固定头长度对不上时的兜底：在整个样本描述项里按类型名找。
      // 找到了说明这个文件的头部长度和标准不一样 —— 那是打包器的问题，
      // 但没理由因此让用户拿不到文件。
      config = scanForBox(bytes, entry.payloadStart + 8, entry.payloadEnd, [spec.config]);
    }
    if (!config) {
      const seen = kids.length ? kids.map((b) => b.type).join(', ') : '（一个子 box 都没读出来）';
      throw new Error(
        `视频样本描述项 ${entry.type}（${entry.payloadEnd - entry.payloadStart} 字节）里没有 ${spec.config}，`
        + `拿不到解码器配置记录。按固定偏移读到的是：${seen}`,
      );
    }
    info.width = u16(bytes, entry.payloadStart + 24);
    info.height = u16(bytes, entry.payloadStart + 26);
    info.description = bytes.slice(config.payloadStart, config.payloadEnd);
    info.decodeDescriptionName = config.type;
    info.vendorCodec = spec.vendor;
  } else if (contentType === 'audio') {
    const kids = readBoxes(bytes, entry.payloadStart + AUDIO_SAMPLE_ENTRY_HEADER, entry.payloadEnd);
    const esds = kids.find((b) => b.type === 'esds')
      || scanForBox(bytes, entry.payloadStart + 8, entry.payloadEnd, ['esds']);
    info.channels = u16(bytes, entry.payloadStart + 16);
    info.sampleRate = u32(bytes, entry.payloadStart + 24) >>> 16;
    if (esds) {
      const parsed = parseEsds(bytes, esds.payloadStart, esds.payloadEnd);
      if (parsed) {
        info.objectTypeIndication = parsed.objectTypeIndication;
        if (parsed.audioSpecificConfig) {
          info.description = parsed.audioSpecificConfig;
          info.decodeDescriptionName = 'AudioSpecificConfig';
          const asc = parseAudioSpecificConfig(parsed.audioSpecificConfig);
          if (asc) {
            info.audioObjectType = asc.audioObjectType;
            // ASC 里的值比样本描述项更可信（HE-AAC 的采样率会翻倍）
            if (asc.sampleRate) info.sampleRate = asc.sampleRate;
            if (asc.channels) info.channels = asc.channels;
          }
        }
      }
    }
  } else {
    throw new Error(`暂不支持 handler=${handler} 的轨道（只做视频和音频）`);
  }

  if (!Number.isFinite(timescale) || timescale <= 0) throw new Error('mdhd 里的 timescale 不合法，时间轴无从还原');

  info.editMediaTime = readEditMediaTime(bytes, trakBoxes, timescale);
  return info;
}

/**
 * 读 edts/elst 的 media_time（单位：媒体 timescale 的 tick）。
 *
 * 为什么要它：fMP4 的 init 段用 edit list 表示「媒体时间轴从哪儿开始」，
 * 视频侧通常正好等于第一帧的 composition 领先量。忽略它会让音视频
 * 相对偏移到几十毫秒（本仓库样本 59 ms）。只认最规矩的那种：
 * 单条、media_time >= 0、不超过 5 秒；其余一律当没有。
 */
function readEditMediaTime(bytes, trakBoxes, timescale) {
  const edts = trakBoxes.find((b) => b.type === 'edts');
  if (!edts) return 0;
  const elst = readBoxes(bytes, edts.payloadStart, edts.payloadEnd).find((b) => b.type === 'elst');
  if (!elst) return 0;

  const version = u8(bytes, elst.payloadStart);
  const entryCount = u32(bytes, elst.payloadStart + 4);
  if (entryCount !== 1) return 0;
  const entryStart = elst.payloadStart + 8;
  if (entryStart + (version === 1 ? 20 : 12) > elst.payloadEnd) return 0;

  // v1 的 media_time 是 64 位，但这里要的只是「小于 5 秒」的那点值，取低 32 位够用
  const mediaTime = i32(bytes, entryStart + (version === 1 ? 12 : 4));
  if (!(mediaTime > 0) || mediaTime > timescale * 5) return 0;
  return mediaTime;
}

/* ------------------------------------------------------------------ *
 * 媒体分片
 * ------------------------------------------------------------------ */

function parseTfhd(bytes, box) {
  const flags = u24(bytes, box.payloadStart + 1);
  const p = box.payloadStart;
  const out = {
    trackId: u32(bytes, p + 4),
    baseDataOffset: null,
    defaultSampleDuration: 0,
    defaultSampleSize: 0,
    defaultSampleFlags: undefined,
    defaultBaseIsMoof: (flags & 0x020000) !== 0,
  };
  let q = p + 8;
  if (flags & 0x000001) { out.baseDataOffset = u64(bytes, q); q += 8; }
  if (flags & 0x000002) q += 4; // sample_description_index
  if (flags & 0x000008) { out.defaultSampleDuration = u32(bytes, q); q += 4; }
  if (flags & 0x000010) { out.defaultSampleSize = u32(bytes, q); q += 4; }
  if (flags & 0x000020) out.defaultSampleFlags = u32(bytes, q);
  return out;
}

function parseTfdt(bytes, box) {
  const version = u8(bytes, box.payloadStart);
  return version === 1 ? u64(bytes, box.payloadStart + 4) : u32(bytes, box.payloadStart + 4);
}

function parseTrun(bytes, box, version) {
  const flags = u24(bytes, box.payloadStart + 1);
  let q = box.payloadStart + 4;
  const sampleCount = u32(bytes, q);
  q += 4;
  const out = { dataOffset: undefined, firstSampleFlags: undefined, samples: [] };
  if (flags & 0x000001) { out.dataOffset = i32(bytes, q); q += 4; }
  if ((flags & 0x000004) && sampleCount) { out.firstSampleFlags = u32(bytes, q); q += 4; }

  for (let k = 0; k < sampleCount; k += 1) {
    const sample = { duration: undefined, size: undefined, flags: k === 0 ? out.firstSampleFlags : undefined, ctsOffset: 0 };
    if (flags & 0x000100) { sample.duration = u32(bytes, q); q += 4; }
    if (flags & 0x000200) { sample.size = u32(bytes, q); q += 4; }
    if (flags & 0x000400) { sample.flags = u32(bytes, q); q += 4; }
    if (flags & 0x000800) { sample.ctsOffset = version === 1 ? i32(bytes, q) : u32(bytes, q); q += 4; }
    out.samples.push(sample);
  }
  return out;
}

/** sample_flags 的 bit 16 是 sample_is_non_sync_sample：0 才是关键帧。 */
const flagsSaySync = (flags) => ((flags >>> 16) & 0x1) === 0;

/**
 * 从一个媒体分片里切出样本。
 *
 * 数据偏移的规则（ISO/IEC 14496-12 §8.8.8）：trun 的 data_offset 相对
 * 「base-data-offset」；没写 base-data-offset 时基准是 moof 的第一个字节
 * （default-base-is-moof，ffmpeg/Shaka 都这么写）。后续 trun 没写
 * data_offset 就紧接上一个 trun 的数据尾部。
 *
 * ⚠️ 一个「分片」里可以有**多个 moof/mdat 对**：mux.js 把音视频复用的 TS
 * 重封装成 fMP4 时就是「先 audio 的 moof+mdat，再 video 的 moof+mdat」，
 * 而目标轨可能是第二个。只认第一个 moof 的话视频轨会一个样本都切不出来。
 *
 * ⚠️ mux.js 的 parse-tfhd 还有个 bug：`flags[0] & 0x020000` 恒为 0
 * （flags[0] 是最高字节，0x020000 掩码在上面永远取不到），所以
 * defaultBaseIsMoof 永远解不出来 —— flags 只能自己读。
 *
 * @param {number} fallbackDts 分片里没有 tfdt 时接着上一个分片往下排
 * @returns {{samples: Array, nextDts: number, warnings: string[]}}
 */
export function extractSegmentSamples(input, track, fallbackDts = 0) {
  const bytes = toBytes(input);
  const top = readBoxes(bytes);
  const moofs = top.filter((b) => b.type === 'moof');
  if (!moofs.length) throw new Error('不是 fMP4 媒体分片：没有 moof（是不是把 init 段又喂了一遍？）');

  const samples = [];
  const warnings = [];
  let nextDts = fallbackDts;
  let trafCount = 0;

  for (const moof of moofs) {
    const trafs = readBoxes(bytes, moof.payloadStart, moof.payloadEnd).filter((b) => b.type === 'traf');
    trafCount += trafs.length;

    for (const traf of trafs) {
      const kids = readBoxes(bytes, traf.payloadStart, traf.payloadEnd);
      const tfhdBox = kids.find((b) => b.type === 'tfhd');
      if (!tfhdBox) throw new Error('traf 里没有 tfhd，样本表无从解析');
      const tfhd = parseTfhd(bytes, tfhdBox);

      if (track.trackId && tfhd.trackId !== track.trackId) {
        // 多轨复用的分片：不是我们要的那条，跳过
        continue;
      }

      const tfdtBox = kids.find((b) => b.type === 'tfdt');
      let dts = tfdtBox ? parseTfdt(bytes, tfdtBox) : nextDts;
      if (tfdtBox && dts < nextDts - 1) {
        warnings.push(`tfdt=${dts} 比上一个分片的结束时间 ${nextDts} 还早，时间轴可能有重叠`);
      }

      const truns = kids.filter((b) => b.type === 'trun');
      if (!truns.length) throw new Error('traf 里没有 trun，取不到样本表');

      const base = tfhd.baseDataOffset != null ? tfhd.baseDataOffset : moof.start;
      let cursor = base;
      let indexInTraf = 0;

      for (const trunBox of truns) {
        const trun = parseTrun(bytes, trunBox, u8(bytes, trunBox.payloadStart));
        if (trun.dataOffset !== undefined) cursor = base + trun.dataOffset;

        for (const raw of trun.samples) {
          const duration = raw.duration ?? tfhd.defaultSampleDuration;
          const size = raw.size ?? tfhd.defaultSampleSize;
          if (!(duration > 0)) {
            throw new Error('样本没有时长（trun 的 sample_duration 和 tfhd 的 default_sample_duration 都没给），时间轴无法还原');
          }
          if (!(size >= 0)) throw new Error('样本没有大小（trun 和 tfhd 都没给），切不出数据');

          const end = cursor + size;
          if (end > bytes.byteLength) {
            throw new Error(`样本数据越界（需要读到 ${end}，分片只有 ${bytes.byteLength} 字节），分片可能被截断`);
          }

          const flags = raw.flags ?? tfhd.defaultSampleFlags;
          samples.push({
            data: bytes.slice(cursor, end),
            dts,
            duration,
            ctsOffset: raw.ctsOffset,
            // 完全拿不到 flags 时按「每个分片第一个样本是关键帧」兜底：这是 fMP4 的
            // 常规写法，比把整条轨都标成关键帧安全得多。
            isSync: flags === undefined ? indexInTraf === 0 : flagsSaySync(flags),
          });

          cursor = end;
          dts += duration;
          indexInTraf += 1;
        }
      }
      nextDts = dts;
    }
  }

  if (!trafCount) throw new Error('moof 里没有 traf，取不到样本表');
  if (!samples.length) {
    // 分片里可能只有另一条轨的 traf（音视频复用流里很常见），
    // 但整条轨一个样本都没有就说明输入配错了，交给上层报错
    warnings.push('这个分片里没有属于目标轨道的样本');
  }
  return { samples, nextDts, warnings };
}

/* ------------------------------------------------------------------ *
 * 写回 edit list
 * ------------------------------------------------------------------ */

function writeU32(target, offset, value) {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function concatBytes(parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function makeBox(type, payload) {
  const out = new Uint8Array(8 + payload.length);
  writeU32(out, 0, out.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

/**
 * elst：每条编辑 { segmentDuration（mvhd 的 timescale）, mediaTime（本轨的 timescale） }
 *
 * media_time = -1 是规范里的「空编辑」：这一段时间放空白，用来把整条轨往后推。
 * 两条轨的起始时间不一样时（音频的 tfdt 比视频晚），只能靠它表达 ——
 * MP4 没有别的字段能记「这条轨从影片的第 N 秒才开始」。
 */
function makeElst(entries) {
  const payload = new Uint8Array(4 + 4 + entries.length * 12);
  writeU32(payload, 4, entries.length);
  entries.forEach((entry, index) => {
    const at = 8 + index * 12;
    writeU32(payload, at, entry.segmentDuration);
    writeU32(payload, at + 4, entry.mediaTime === -1 ? 0xffffffff : entry.mediaTime);
    writeU32(payload, at + 8, 0x00010000); // rate = 1.0
  });
  return makeBox('elst', payload);
}

/** moov 变长之后，mdat 里的数据整体后移，stco/co64 里的绝对偏移必须跟着加 */
function patchChunkOffsets(trakBytes, delta) {
  if (!delta) return;
  const trak = readBoxes(trakBytes)[0];
  if (!trak) return;
  const mdia = readBoxes(trakBytes, trak.payloadStart, trak.payloadEnd).find((b) => b.type === 'mdia');
  if (!mdia) return;
  const minf = readBoxes(trakBytes, mdia.payloadStart, mdia.payloadEnd).find((b) => b.type === 'minf');
  if (!minf) return;
  const stbl = readBoxes(trakBytes, minf.payloadStart, minf.payloadEnd).find((b) => b.type === 'stbl');
  if (!stbl) return;

  for (const box of readBoxes(trakBytes, stbl.payloadStart, stbl.payloadEnd)) {
    if (box.type === 'stco') {
      const count = u32(trakBytes, box.payloadStart + 4);
      for (let i = 0; i < count; i += 1) {
        const p = box.payloadStart + 8 + i * 4;
        writeU32(trakBytes, p, (u32(trakBytes, p) + delta) >>> 0);
      }
    } else if (box.type === 'co64') {
      const count = u32(trakBytes, box.payloadStart + 4);
      for (let i = 0; i < count; i += 1) {
        const p = box.payloadStart + 8 + i * 8;
        const value = u64(trakBytes, p) + delta;
        writeU32(trakBytes, p, Math.floor(value / 2 ** 32));
        writeU32(trakBytes, p + 4, value >>> 0);
      }
    }
  }
}

function trackIdOfTkhd(bytes, tkhd) {
  return u8(bytes, tkhd.payloadStart) === 1
    ? u32(bytes, tkhd.payloadStart + 20)
    : u32(bytes, tkhd.payloadStart + 12);
}

/** 只认 version 0（64 位时长要 2^32/1000 秒才用得上，我们够不到） */
const DURATION_FIELD = { mvhd: 16, tkhd: 20, mdhd: 16 };

function readDurationV0(bytes, box) {
  const at = DURATION_FIELD[box.type];
  if (at === undefined || u8(bytes, box.payloadStart) !== 0) return null;
  return u32(bytes, box.payloadStart + at);
}

function writeDurationV0(bytes, box, value) {
  const at = DURATION_FIELD[box.type];
  if (at === undefined || u8(bytes, box.payloadStart) !== 0) return false;
  writeU32(bytes, box.payloadStart + at, value);
  return true;
}

/**
 * 给产物补写 edts/elst。
 *
 * 为什么非做不可：**MP4 里每条轨的 stts 只记样本之间的间隔，绝对起点表达不出来**，
 * 轨道之间的相对起点只能靠 edit list。而 mp4-muxer 完全不写 elst，于是
 *   1. 视频第一帧的 composition 领先量（B 帧重排，本仓库样本 1024/12800 = 80 ms）
 *      变成「前 80 ms 没有画面」，音画就差 80 ms；
 *   2. 音视频各自的 tfdt 起点不同时（音频比别人晚 58 ms 很常见），
 *      这个差量会被彻底丢掉。
 * 源 init 段里的 elst 和分片里的 tfdt 本来就把这两件事都写清楚了，
 * 这里只是把它们照搬到产物上：
 *   media_time > 0  → 单条编辑，跳过媒体开头那一截（把这条轨往前挪）
 *   media_time < 0  → 先来一条空编辑把这条轨往后推，再从媒体 0 开始播
 *
 * 这个函数是**尽力而为**：结构一有意外就原样返回，绝不为了补一条 elst
 * 冒把文件写坏的风险。
 *
 * @param {Uint8Array} bytes mp4-muxer 的产物
 * @param {Map<number, {seconds: number, timescale: number}>} edits
 *        输出 trackId → 「影片时间 0 落在媒体时间轴的哪一点」（秒，可正可负），
 *        以及该轨在产物里的 timescale（对不上就放弃，说明 mp4-muxer 换了约定）
 */
/**
 * 两条轨的起点差超过这么多秒，就认定"不是真实的音画偏移，而是两条轨的时间基不同"。
 *
 * 依据：真实的音画起点差只有几十毫秒到几百毫秒（音频解码器延迟、编辑决定）；
 * 超过 1.5 秒绝不是正常音画差（时间基不同或格式切换），绝不能写空编辑把视频推迟几十秒
 * （那会导致开头几十秒画面停滞卡死只有声音），必须按 0 对齐。
 */
const MAX_PLAUSIBLE_ORIGIN_GAP_SECONDS = 1.5;

function applyEditLists(bytes, edits, onWarning) {
  if (!edits.size) return bytes;
  const top = readBoxes(bytes);
  const moov = top.find((b) => b.type === 'moov');
  const mdat = top.find((b) => b.type === 'mdat');
  if (!moov || !mdat) return bytes;

  const moovKids = readBoxes(bytes, moov.payloadStart, moov.payloadEnd);
  const mvhd = moovKids.find((b) => b.type === 'mvhd');
  if (!mvhd) return bytes;
  const movieTimescale = u32(bytes, mvhd.payloadStart + 12);
  if (!(movieTimescale > 0)) return bytes;

  const plans = [];
  for (const trak of moovKids) {
    if (trak.type !== 'trak') continue;
    const kids = readBoxes(bytes, trak.payloadStart, trak.payloadEnd);
    const tkhd = kids.find((b) => b.type === 'tkhd');
    if (!tkhd) continue;
    const edit = edits.get(trackIdOfTkhd(bytes, tkhd));
    if (!edit) continue;

    const mdia = kids.find((b) => b.type === 'mdia');
    const mdhd = mdia && readBoxes(bytes, mdia.payloadStart, mdia.payloadEnd).find((b) => b.type === 'mdhd');
    if (!mdhd) continue;
    const mediaTimescale = u32(bytes, mdhd.payloadStart + (u8(bytes, mdhd.payloadStart) === 1 ? 20 : 12));
    // timescale 对不上说明 mp4-muxer 换了内部约定，宁可不动
    if (mediaTimescale !== edit.timescale) continue;

    const mediaTime = Math.round(edit.seconds * mediaTimescale);
    if (mediaTime === 0) continue;

    // mediaDuration 是这条轨在产物里的媒体总时长（媒体 timescale）
    const mediaDuration = readDurationV0(bytes, mdhd) || 0;
    const wholeTrack = Math.round((mediaDuration / mediaTimescale) * movieTimescale);

    let entries;
    let trackDuration;
    if (mediaTime > 0) {
      // 跳过媒体开头 media_time 那一截：播放长度是「媒体总长 - media_time」，
      // 不是整个媒体长度 —— 写大了播放器会去读根本不存在的数据
      const played = mediaDuration > mediaTime
        ? Math.round(((mediaDuration - mediaTime) / mediaTimescale) * movieTimescale)
        : 0;
      entries = [{ segmentDuration: played, mediaTime }];
      trackDuration = played;
    } else {
      // 这条轨比影片起点晚 |mediaTime|，正常情况（音频比画面晚几十毫秒）用一条空编辑把它推后。
      //
      // ⚠️ 但**两个来源的时间基不一样**时，这个"起点差"可以是几千秒：fMP4 分片带的 tfdt 是
      // **源流的绝对时间**，而 WebM 的 Cluster 时间码**按段从 0 计**。用户实测：画面那条流
      // 是从第 2202 秒（他拖到 36:42）开始抓的，声音那条流的标签却是 0 —— 照 2201 秒写空编辑，
      // 整条画面就被推迟到 2201 秒之后，播放时 0~100 秒**完全没有画面**（画面不动、声音在走）。
      //
      // 真实音画偏移不会超过几秒，所以设一个上限：超过就**按 0 对齐**（这两条轨的内容其实是
      // 同一段，只是标签不同），并如实写进产物提示。
      const delay = Math.round(-edit.seconds * movieTimescale);
      if (-edit.seconds > MAX_PLAUSIBLE_ORIGIN_GAP_SECONDS) {
        if (typeof onWarning === 'function') {
          onWarning(`有一条轨的起点比影片原点晚了 ${Math.round(-edit.seconds)} 秒 —— `
            + '这个量级多为两条轨时间基不同（fMP4 采用源流绝对时间，WebM Cluster 时间码相对从 0 计），'
            + '已按 0 对齐并消除偏差，确保音画严格同步');
        }
        continue;
      }
      entries = [
        { segmentDuration: delay, mediaTime: -1 },
        { segmentDuration: wholeTrack, mediaTime: 0 },
      ];
      trackDuration = delay + wholeTrack;
    }
    if (trackDuration <= 0) continue;

    plans.push({
      trak,
      insertAt: tkhd.payloadEnd,
      tkhd,
      edts: makeBox('edts', makeElst(entries)),
      trackDuration,
    });
  }
  if (!plans.length) return bytes;

  let maxTrackDuration = 0;
  for (const trak of moovKids) {
    if (trak.type !== 'trak') continue;
    const plan = plans.find((p) => p.trak === trak);
    if (plan) {
      if (plan.trackDuration > maxTrackDuration) maxTrackDuration = plan.trackDuration;
    } else {
      const kids = readBoxes(bytes, trak.payloadStart, trak.payloadEnd);
      const tkhd = kids.find((b) => b.type === 'tkhd');
      if (tkhd) {
        const dur = readDurationV0(bytes, tkhd) || 0;
        if (dur > maxTrackDuration) maxTrackDuration = dur;
      }
    }
  }
  const inserted = plans.reduce((sum, p) => sum + p.edts.length, 0);
  // moov 在 mdat 前面时（fastStart: 'in-memory' 就是），撑大 moov 会把 mdat 往后顶，
  // 所有 chunk 的绝对偏移都得跟着加
  const delta = moov.payloadEnd <= mdat.start ? inserted : 0;

  const newMoovParts = [];
  for (const kid of moovKids) {
    let kidBytes = bytes.slice(kid.start, kid.payloadEnd);
    const plan = plans.find((p) => p.trak === kid);
    if (plan) {
      const at = plan.insertAt - kid.start;
      kidBytes = concatBytes([kidBytes.subarray(0, at), plan.edts, kidBytes.subarray(at)]);
      writeU32(kidBytes, 0, kidBytes.length);
      const tkhdCopy = { type: 'tkhd', payloadStart: plan.tkhd.payloadStart - kid.start };
      writeDurationV0(kidBytes, tkhdCopy, plan.trackDuration);
    }
    // 电影时长是所有轨编辑窗口的最大值；不跟着改，播放器会在尾巴上多等一段
    if (kid === mvhd && maxTrackDuration > 0) {
      writeDurationV0(kidBytes, { type: 'mvhd', payloadStart: mvhd.payloadStart - mvhd.start }, maxTrackDuration);
    }
    if (kid.type === 'trak') patchChunkOffsets(kidBytes, delta);
    newMoovParts.push(kidBytes);
  }

  const newMoov = makeBox('moov', concatBytes(newMoovParts));
  return concatBytes([bytes.subarray(0, moov.start), newMoov, bytes.subarray(moov.payloadEnd)]);
}

/* ------------------------------------------------------------------ *
 * 合并
 * ------------------------------------------------------------------ */

function collectTrack(input, kind) {
  if (!input) return null;
  if (!input.init) throw new Error(`${kind} 轨缺少 init 段`);
  const segments = Array.isArray(input.segments) ? input.segments : (input.segments ? [input.segments] : []);
  if (!segments.length) throw new Error(`${kind} 轨一个媒体分片都没有`);

  // 按 handler 挑 trak：init 段里可能同时有视频和音频轨（复用流、mux.js 产物）
  const info = parseInitSegment(input.init, { contentType: kind });
  if (info.contentType !== kind) {
    throw new Error(`${kind} 轨的 init 段其实是 ${info.contentType} 轨（handler 对不上），输入传反了？`);
  }

  const samples = [];
  const warnings = [];
  let fallbackDts = 0;
  segments.forEach((segment, index) => {
    const result = extractSegmentSamples(segment, info, fallbackDts);
    for (const w of result.warnings) warnings.push(`第 ${index + 1} 个分片：${w}`);
    // ⚠️ 这里**不能**写 `samples.push(...result.samples)`。
    //
    // 展开运算符传参是**按函数实参**走的，实参数量和栈空间挂钩；V8 的上限大约
    // 12 万。而抓流这条路把**所有分片拼成一段**再交进来（见 offscreen 的
    // assembleMseCapture），所以 `result.samples` 一次就是整条视频的样本数：
    // 实测 166 MB 的产物到这里抛 `Maximum call stack size exceeded` ——
    // 抓流、手动保存、停止三条路会**同时**失败，用户看到的就是"点了没反应/保存失败"。
    // 小文件（几十 MB 以下）恰好卡在上限之内，所以这个问题一直没露头。
    for (const s of result.samples) samples.push(s);
    fallbackDts = result.nextDts;
  });

  if (!samples.length) throw new Error(`${kind} 轨一个样本都没取到（分片的 trackId 和 init 段对不上？）`);
  return { kind, info, samples, warnings };
}

/**
 * 把「已经转码好的 AAC 帧」当成一条音频轨。
 *
 * ## 它和 fMP4 音频输入的本质区别
 *
 * fMP4 的样本时间戳是**轨内 tick**，绝对起点藏在 tfdt 和 elst 里，所以那条路
 * 要"每条轨各自归零 + 用 edts/elst 表达轨道之间的相对起点"。
 * 转码出来的 AAC 帧带的是**绝对呈现时间（微秒）**，没有 elst 可写 ——
 * 于是这条路改成"两边都保留绝对值，一起减掉影片原点"，见 mergeFmp4。
 *
 * 用户报的「抓 YouTube 有画面没声音」走的就是这条路：视频是 fMP4（AV1），
 * 音频是 WebM/Opus，转成 AAC 之后从这儿进来。
 */
function collectAacAudio(aac) {
  if (!aac?.frames?.length) throw new Error('转码后的音频一帧都没有');
  const sampleRate = Number(aac.sampleRate) || 0;
  const channels = Number(aac.channels) || 0;
  if (!(sampleRate > 0) || !(channels > 0)) {
    throw new Error(`转码音频的采样率/声道不合法：${sampleRate} Hz / ${channels} 声道`);
  }
  const samples = [];
  for (const frame of aac.frames) {
    samples.push({
      data: toBytes(frame.data),
      // timescale 取 1e6：dts 直接就是微秒，后面的换算逻辑和视频轨完全共用
      dts: Math.round(frame.timestampUs),
      duration: Math.max(1, Math.round(frame.durationUs || 0)),
      ctsOffset: 0,
      isSync: true,
    });
  }
  return {
    kind: 'audio',
    info: {
      contentType: 'audio',
      timescale: 1e6,
      channels,
      sampleRate,
      description: aac.description || null,
      codecType: 'mp4a',
      objectTypeIndication: 0x40,
      vendorCodec: 'aac',
      // 由 mergeFmp4 按视频轨的 elst 填：影片时间 0 落在呈现时间轴的哪一点
      editMediaTime: 0,
    },
    samples,
    warnings: [],
    transcoded: true,
  };
}

/**
 * 把一条轨的样本整理成「按 DTS 单调、不重复」的一条。
 *
 * ## 为什么抓流这条路必须有它（用户报过一次，35 MB 全丢）
 *
 * 用户的操作是：**暂停视频 → 点「停止并保存」**，然后收到
 *
 *     addVideoChunkRaw's third argument (timestamp) must be a non-negative real number.
 *
 * 根因不在暂停本身，而在**采集到的分片不一定按时间顺序到**：播放器重新缓冲、
 * 往回拖一点点、暂停再继续，都可能把**已经送过的分片再 append 一次**（有时字节
 * 不完全一样，所以 `groupBuffers` 按内容指纹判重拦不住）。拼起来就是
 * 「第 2 片、第 1 片」这种顺序，而归零用的是**第一个样本**——
 * 后面那些更早的样本就算成了负数时间戳，muxer 当场拒绝（DTS 回退则会报
 * `Timestamps must be monotonically increasing`）。
 *
 * 这里做三件事，都是**无损**的：
 *   1. 按 DTS 排序（已经有序时一次都不动）；
 *   2. 丢掉**完全被已收内容覆盖**的重复样本，以及起点与前一个样本相同的样本；
 *   3. 起点用排序后的第一个样本 —— 保证没有任何时间戳是负的。
 *
 * @param {Array} samples 采集到的样本（可能乱序/重复）
 * @returns {{samples:Array, dropped:number, sorted:boolean}}
 */
export function normalizeTrackSamples(samples) {
  const list = Array.isArray(samples) ? samples : [];
  let sorted = false;
  for (let i = 1; i < list.length; i += 1) {
    if (list[i].dts < list[i - 1].dts) { sorted = true; break; }
  }

  // 排序要**稳定**：dts 相同时保持原顺序（同一个 dts 只可能来自重复 append）
  const ordered = sorted
    ? list.map((s, i) => ({ s, i }))
      .sort((a, b) => (a.s.dts - b.s.dts) || (a.i - b.i))
      .map((x) => x.s)
    : list;

  const kept = [];
  let coveredTo = -Infinity;
  let dropped = 0;
  for (const s of ordered) {
    const end = s.dts + s.duration;
    const last = kept[kept.length - 1];
    // 同一个起点（重复送的那一片的首样本），或者整段都落在已收内容里 → 丢掉
    if (last && (s.dts === last.dts || end <= coveredTo)) { dropped += 1; continue; }
    kept.push(s);
    if (end > coveredTo) coveredTo = end;
  }
  return { samples: kept, dropped, sorted };
}

/** 已经录了这么久，才谈得上"换集"（时间轴太短时，从头开始的多半是拖回开头重播） */
const RESTART_MIN_RUN_SECONDS = 60;
/** 新样本的时间戳落在这个秒数以内，才算"从接近 0 重新开始" */
const RESTART_NEAR_ZERO_SECONDS = 3;

/**
 * 把「时间轴重新从头开始」之后的内容切掉 —— **抓流那条路专用**（`cutOnRestart`）。
 *
 * 为什么要有它（用户反复报的那个）：**同一个页面、地址栏不变的站点**在换集时不发
 * `ended` / `emptied` / `loadstart` / 新的 SourceBuffer 这四个信号，第二集的样本会接着
 * 进缓冲。它和第一集重叠的部分会被判重丢掉（所以开头没了），**但比第一集长的那部分会落在
 * 第一集末尾之后** —— 产物就成了"第一集 + 第二集的尾巴"。用户的原话：
 *
 *   「第一段尾巴和第二段开头混在一块儿了，只要我不停，它就一直是一个视频，
 *     这不扯淡吗？最起码让我有一个完整的第一段吧。」
 *
 * 判据只看**样本自己的时间戳**：到这一步三种容器（fMP4 / WebM / TS）都已经统一成样本了，
 * 不需要认容器、也不需要读包。按**到达顺序**走（"重启"= 后来的片从接近 0 重新开始）：
 * 之前已经录到 60 秒以上，而这一片的第一个时间戳落回 3 秒以内 → 判为换集，
 * **从这里往后的样本全部不要**（第一集保持完整；第二集请重新开一次抓流 —— 这正是用户要的）。
 *
 * 代价说清楚：如果你在录制中途把进度条拖回**最开头**重看，后面的新内容也会被切掉
 * （保住的是拖回之前那一段）。这是有意的取舍：**宁可少收一段，也不要把两集焊在一起**，
 * 而且会明确写进产物提示，不静默。
 *
 * @param {Array} samples 到达顺序的样本（时间是 ticks）
 * @param {number} timescale 这条轨的时钟刻度
 */
export function truncateAtTimelineRestart(samples, timescale) {
  const list = Array.isArray(samples) ? samples : [];
  const scale = Number(timescale) > 0 ? Number(timescale) : 0;
  if (!scale || list.length < 2) {
    return { samples: list, cutCount: 0, cutAtSeconds: null, afterSeconds: null };
  }
  let maxTicks = list[0].dts;
  for (let i = 1; i < list.length; i += 1) {
    const dts = list[i].dts;
    const known = maxTicks / scale;
    const here = dts / scale;
    if (known >= RESTART_MIN_RUN_SECONDS && here <= RESTART_NEAR_ZERO_SECONDS) {
      return {
        samples: list.slice(0, i),
        cutCount: list.length - i,
        cutAtSeconds: here,
        afterSeconds: known,
      };
    }
    if (dts > maxTicks) maxTicks = dts;
  }
  return { samples: list, cutCount: 0, cutAtSeconds: null, afterSeconds: null };
}

/**
 * tick → 微秒，并把每条轨自己的 DTS 起点归零。
 *
 * 为什么要归零、而且**只按本轨归零**（不是两轨一起平移）：
 * MP4 的 stts 只记「样本之间的间隔」，一条轨的绝对起点表达不出来。
 * 如果第一条 DTS 不是 0，mp4-muxer 会把第一个样本拉长到第二个样本的位置 ——
 * 实测音轨被拉长 80 ms，产物时长平白多出 59 ms。轨道之间的相对起点
 * 只能靠 edts/elst 表达，所以这里各归各的，差量交给 applyEditLists。
 *
 * ⚠️ 混装 WebM 转码音频时**同样走这条路**（而不是"两边都留绝对值"）：
 * 转码音频虽然带的是绝对微秒，但 mp4-muxer 只按"相邻样本的间隔"写 stts，
 * 一条轨自己"比影片晚 1 秒开始"这件事它记不下来 —— 那 1 秒会被悄悄吃掉，
 * 变成音画不同步。起点必须交给 elst，两条路一样。
 *
 * @returns {{micro:Array, origin:number, gaps:Array, sorted:boolean, dropped:number, clamped:number}}
 */
function toMicroSeconds(track, options = {}) {
  const { timescale } = track.info;
  // 先整理时间轴：抓流的分片可能是乱序到的（见 normalizeTrackSamples）
  // 抓流那条路还要多一步：**时间轴重新从头开始**（换集）之后的内容整段不要 ——
  // 否则第二集比第一集长的部分会落在第一集末尾之后，两集就焊在一起了（见
  // truncateAtTimelineRestart 的注释）。只在抓流这条路上开（`cutOnRestart`），
  // 下载/合并那条路的"重启"可能是别的东西，不动它。
  const restart = options.cutOnRestart
    ? truncateAtTimelineRestart(track.samples, timescale)
    : { samples: track.samples, cutCount: 0, cutAtSeconds: null, afterSeconds: null };
  const normalized = normalizeTrackSamples(restart.samples);
  const samples = normalized.samples;
  const origin = samples.length ? samples[0].dts : 0;
  let clamped = 0;
  const micro = samples.map((s, index) => {
    const dtsUs = Math.round(((s.dts - origin) * 1e6) / timescale);
    let ctsUs = Math.round(((s.dts + s.ctsOffset - origin) * 1e6) / timescale);
    // 呈现时间戳为负只可能来自「负的 composition offset 比它离起点的距离还大」
    // （B 帧重排的边角情况）。muxer 对此是硬报错，所以就近纠正到 0 ——
    // 和音频转码那条路对"时间戳回退"的处理一致：纠正 + 如实上报，不静默。
    if (ctsUs < 0) { ctsUs = 0; clamped += 1; }
    const endUs = Math.round(((s.dts + s.duration - origin) * 1e6) / timescale);
    return {
      kind: track.kind,
      index,
      data: s.data,
      dtsUs,
      ctsUs,
      cttsUs: ctsUs - dtsUs,
      durationUs: Math.max(1, endUs - dtsUs),
      isSync: s.isSync,
    };
  });

  // mp4-muxer 的 stts 是按「相邻样本的间隔」写的，根本没有地方放最后一个样本的
  // 时长 —— 它会拿前一个间隔顶上。于是当最后一个样本比前面的短（AAC 尾巴很常见，
  // 本仓库样本是 512 vs 1024 个 tick），mdhd.duration 会和 stts 之和对不上，
  // ffmpeg 就会把尾帧按少掉的那截截掉。这里干脆把最后一个样本的时长对齐成
  // 前一个，让产物自己前后一致。
  const last = micro[micro.length - 1];
  const previous = micro[micro.length - 2];
  if (last && previous && last.durationUs !== previous.durationUs) {
    last.durationUs = previous.durationUs;
  }

  // 时间轴空洞：相邻两个样本之间空出好几秒。
  //
  // 这件事必须报出来，因为它就是「拖到两分钟立刻跳回两秒」的成因之一 ——
  // 播放器按样本表往空洞里定位，只能落回空洞之前那一帧。产物照样能播、
  // ffprobe 也查不出，所以不主动说，用户只会觉得"这个工具做出来的文件有问题"。
  const gaps = [];
  for (let i = 1; i < micro.length; i += 1) {
    const gapUs = micro[i].dtsUs - (micro[i - 1].dtsUs + micro[i - 1].durationUs);
    if (gapUs > 1_500_000) {
      gaps.push({ atSeconds: micro[i - 1].dtsUs / 1e6, lengthSeconds: gapUs / 1e6 });
    }
  }
  // `origin`（本轨第一个样本的 DTS，源流的 tick）留着：影片时间 0 落在哪儿
  // 要拿它和源 elst 的 media_time 一起算，见 mergeFmp4 里的 offsets / shift。
  // `sorted` / `dropped` / `clamped` 交给调用方如实上报（见 reportTimelineFixes）。
  return {
    micro, origin, gaps, sorted: normalized.sorted, dropped: normalized.dropped, clamped,
    // 「时间轴重启（换集）之后被切掉的那一段」的详情，交给调用方写进产物提示
    restart,
  };
}

/**
 * 把「这条轨的时间轴被就地整理过」这件事说出来。
 *
 * 为什么要报：这些都是**我们动了用户的样本**。用户的原始数据被排序、去重、
 * 纠正时间戳，他有权知道 —— 尤其是去重（真的有内容被去掉，去掉的是重复的）。
 */
function reportTimelineFixes(label, track, onWarning) {
  if (!track || typeof onWarning !== 'function') return;
  if (track.sorted) {
    onWarning(`${label}收到的分片顺序是乱的（播放器把已经送过的部分又送了一遍），已按时间戳重新排好`);
  }
  if (track.dropped) {
    onWarning(`${label}里有 ${track.dropped} 个重复样本（同一段时间被 append 了两次），已去掉重复的那些`);
  }
  if (track.clamped) {
    onWarning(`${label}里有 ${track.clamped} 个样本的呈现时间戳是负的，已就近纠正为 0`);
  }
}

function resolveVendorCodec(track) {
  if (track.kind === 'video') {
    // 编码名在解析初始化段时就查表定了（见 VIDEO_SAMPLE_ENTRIES）。
    // 这里不再看"配置记录叫什么"，免得每次加编码都要在两个地方各改一遍。
    if (track.info.vendorCodec) return track.info.vendorCodec;
    throw new Error(
      `暂不支持的视频编码：${track.info.codecType}`
      + `（当前支持 ${Object.keys(VIDEO_SAMPLE_ENTRIES).join(' / ')}）`,
    );
  }
  const oti = track.info.objectTypeIndication;
  // 0x40 = MPEG-4 AAC，0x66/0x67/0x68 = MPEG-2 AAC
  if (!oti || oti === 0x40 || oti === 0x66 || oti === 0x67 || oti === 0x68) return 'aac';
  throw new Error(`暂不支持的音频编码：objectTypeIndication=0x${oti.toString(16)}（当前只做 AAC）`);
}

/**
 * 合并两路 fMP4。
 *
 * @param {{video?: {init: Uint8Array, segments: Uint8Array[]}, audio?: object}} input
 *        两路各自独立的 fMP4 流。**不要求它们来自 DASH** —— mux.js 把 TS 重封装
 *        出来的 fMP4 一样能喂进来；一个 init 里带多条 trak 的复用流也可以
 *        （同一份字节既当 video 又当 audio，各自只抽自己那条 trak 的样本）。
 * @param {{onWarning?: (message: string) => void}} [options]
 *        分片里出现「不属于目标轨道的 traf」「tfdt 时间轴重叠」这类情况时会回调，
 *        不传就只是丢掉这些诊断信息，不影响产物。
 * @returns {Uint8Array} 一个普通（非分片式）MP4
 */
export function mergeFmp4(input = {}, options = {}) {
  const video = collectTrack(input.video, 'video');
  // 音频有两种来源：fMP4 分片，或者"已经转码好的 AAC 帧"（WebM/Opus → AAC）
  const mixedAudio = !!(input.audio && input.audio.aac);
  const audio = mixedAudio ? collectAacAudio(input.audio.aac) : collectTrack(input.audio, 'audio');
  if (!video && !audio) {
    throw new Error('mergeFmp4 需要至少一路输入：{ video: { init, segments }, audio: { init, segments } } 或 { audio: { aac } }');
  }
  if (typeof options.onWarning === 'function') {
    for (const w of video?.warnings || []) options.onWarning(`视频轨 ${w}`);
    for (const w of audio?.warnings || []) options.onWarning(`音频轨 ${w}`);
  }

  const videoCodec = video ? resolveVendorCodec(video) : null;
  const audioCodec = audio ? resolveVendorCodec(audio) : null;

  if (mixedAudio && video) {
    // 「影片时间 0 落在音频时间轴的哪一点」。
    //
    // 视频轨的答案写在它自己的 elst 里（media_time，通常就是 B 帧的
    // composition 领先量）；音频这条 WebM 流没有 elst，但它和视频在**同一条
    // 呈现时间轴**上（MSE 就是这么要求的，否则浏览器自己就先音画不同步了），
    // 所以它的"影片时间 0"= 视频 elst 说的那个呈现时刻，换成微秒。
    audio.info.editMediaTime = Math.round((video.info.editMediaTime / video.info.timescale) * 1e6);
  }

  const videoTrack = video ? toMicroSeconds(video, options) : null;
  const audioTrack = audio ? toMicroSeconds(audio, options) : null;
  const videoMicro = videoTrack ? videoTrack.micro : [];
  let audioMicro = audioTrack ? audioTrack.micro : [];

  // 结尾画面卡顿停滞保护：如果音频比视频长很多，播放器在视频放完最后一帧后会画面静止停顿直到音频结束。
  // 修剪超过视频结束时刻（+0.5秒容差）的多余音频，让音画同步结束。
  if (videoMicro.length > 0 && audioMicro.length > 0) {
    const lastVideoSample = videoMicro[videoMicro.length - 1];
    const videoEndUs = lastVideoSample.dtsUs + lastVideoSample.durationUs;
    const maxAudioEndUs = videoEndUs + 500_000;
    const initialAudioCount = audioMicro.length;
    audioMicro = audioMicro.filter((s) => s.dtsUs <= maxAudioEndUs);
    const trimmedAudio = initialAudioCount - audioMicro.length;
    if (trimmedAudio > 0 && typeof options.onWarning === 'function') {
      const trimmedSec = ((audioTrack.micro[initialAudioCount - 1].dtsUs - maxAudioEndUs) / 1e6).toFixed(1);
      options.onWarning(`音频轨比视频轨长出 ${trimmedSec} 秒，已修剪多余尾部音频，消除结尾画面停滞`);
    }
  }
  if (!videoMicro.length && !audioMicro.length) throw new Error('两路输入都没有样本，没什么可合并的');

  // 时间轴被就地整理过（乱序 / 重复 / 负时间戳）要说出来：用户报过一次
  // "暂停后再点停止并保存，35 MB 全没了"，根因就在这里没做整理。
  reportTimelineFixes('视频轨', videoTrack, options.onWarning);
  reportTimelineFixes('音频轨', audioTrack, options.onWarning);

  // 「时间轴重新从头开始」= 换集：那些内容被整段切掉了，必须**当场说出来**，
  // 否则用户看到的是"录了 40 分钟，产物只有 20 分钟"，而不知道为什么。
  if (typeof options.onWarning === 'function') {
    for (const [label, t] of [['视频轨', videoTrack], ['音频轨', audioTrack]]) {
      if (!t?.restart?.cutCount) continue;
      options.onWarning(
        `${label}的时间轴又从头开始了（录到 ${Number(t.restart.afterSeconds).toFixed(0)} 秒之后，`
        + `又回到第 ${Number(t.restart.cutAtSeconds).toFixed(1)} 秒）—— `
        + `那是**新的一段**，它的 ${t.restart.cutCount} 个样本没有进这一份产物：`
        + '这一段（上一集）保持完整。要抓新的一段，请重新点一次「抓流」。',
      );
    }
  }

  // 空洞提示：只有**每条有内容的轨都在同一个位置断了**才是死气；
  // 只有一条轨缺，那多半是源流本身在那一刻没有这段内容，报出来让用户自己判断。
  if (typeof options.onWarning === 'function') {
    for (const [label, t] of [['视频', videoTrack], ['音频', audioTrack]]) {
      for (const g of t?.gaps || []) {
        options.onWarning(
          `${label}轨在 ${g.atSeconds.toFixed(1)} 秒处空了 ${g.lengthSeconds.toFixed(1)} 秒`
          + '（拖进这一段没有画面，播放器会退回空洞之前那一帧）',
        );
      }
    }
  }

  const muxerOptions = {
    target: new ArrayBufferTarget(),
    fastStart: 'in-memory',
    // 每条轨的 DTS 已经各自归零，所以这里要求「第一块的时间戳必须正好是 0」——
    // 一旦哪一步算错，宁可它当场报错，也不要悄悄产出一个音画错位的文件。
    // （混装 WebM 转码音频时也是各归各的零，轨道之间的差量交给 elst，
    // 所以这条路一样用 strict。）
    firstTimestampBehavior: 'strict',
  };
  if (video) muxerOptions.video = { codec: videoCodec, width: video.info.width, height: video.info.height };
  if (audio) muxerOptions.audio = { codec: audioCodec, numberOfChannels: audio.info.channels, sampleRate: audio.info.sampleRate };

  if (video && (!(video.info.width > 0) || !(video.info.height > 0))) {
    throw new Error('视频样本描述项里的宽高不合法，封出来的文件播放器认不出来');
  }
  if (audio && (!(audio.info.channels > 0) || !(audio.info.sampleRate > 0))) {
    throw new Error('音频的声道数/采样率不合法，封出来的文件播放器认不出来');
  }

  const events = [...videoMicro, ...audioMicro].sort((a, b) => (a.dtsUs - b.dtsUs) || (a.kind === 'video' ? -1 : 1));

  const muxer = new Muxer(muxerOptions);
  let videoMetaSent = false;
  let audioMetaSent = false;

  for (const sample of events) {
    if (sample.kind === 'video') {
      // 解码器配置记录和编码串都按**实际编码**给：AV1 的配置记录是 av1C、
      // 编码串是 av01.P.LLT.DD，拿 avc1 那套去套会被播放器当成坏文件。
      const meta = videoMetaSent ? undefined : {
        decoderConfig: {
          codec: videoCodec === 'av1'
            ? av1CodecString(video.info.description)
            : avcCodecString(video.info.description),
          description: video.info.description,
        },
      };
      videoMetaSent = true;
      muxer.addVideoChunkRaw(
        sample.data,
        sample.isSync ? 'key' : 'delta',
        // 第三个参数是**呈现**时间戳（CTS），第四个才是 decode 偏移；
        // mp4-muxer 内部按 `DTS = timestamp - compositionTimeOffset` 反推
        sample.ctsUs,
        sample.durationUs,
        meta,
        sample.cttsUs,
      );
    } else {
      const meta = audioMetaSent ? undefined : (audio.info.description
        ? { decoderConfig: { description: audio.info.description } }
        : undefined);
      audioMetaSent = true;
      muxer.addAudioChunkRaw(sample.data, 'key', sample.dtsUs, sample.durationUs, meta);
    }
  }

  muxer.finalize();
  const buffer = muxer.target.buffer;
  if (!buffer || !buffer.byteLength) throw new Error('封装没有产出任何数据');

  // ## 影片时间 0 该落在哪儿
  //
  // 先算每条轨**第一个样本在源影片时间轴上的位置**：
  //
  //     firstInMovie_i = (第一个样本的 DTS - 源 elst 的 media_time) / 本轨 timescale
  //
  // 源 elst 的 media_time 就是「源影片的 0 秒 = 本轨媒体时间轴的哪一点」。它是
  // 负的没关系（表示这条轨的第一个样本比源影片起点还早，规范允许）。
  //
  // 然后取两者中**最早**的那个作为产物的影片 0，其余轨用 elst 表达差量：
  //
  //     edit_i = earliest - firstInMovie_i     （负数 = 空编辑 = 这条轨晚开始）
  //
  // 这样**轨与轨之间的相对位置和源流一模一样**（音画对齐靠的就是它），整体只是
  // 被平移到"抓到的第一个样本就是 0 秒"。
  //
  // ## 为什么不能照抄源 elst 的绝对原点
  //
  // 抓流可以**从中间的某一秒开始**（用户从第 40 分钟点抓流）。这时源影片原点在
  // 几千秒之前，而我们的样本从第 3000 秒才开始 —— 照抄绝对原点就会给每条轨写一个
  // "开头空几千秒"的空编辑：
  //
  //     实测（从 5.92 秒处开始抓的 6 秒素材）：
  //       mvhd.duration = 12000ms      ← 内容 6 秒却声称 12 秒
  //       elst = [{segmentDuration=5920, mediaTime=-1（空编辑）}, {…6080…}]
  //     用户表现：在 PotPlayer 里点进度条中间 → 那里**一个样本都没有** → 只能退回
  //     第一个样本，看起来就是"实际播放位置比鼠标位置靠前"。
  //
  // 平移是**无损的**：晚开始的那条轨写成空编辑，不会裁掉任何样本（如果反过来按
  // "最早的那条轨不动、其余轨用正数 media_time 裁掉开头"，会真的丢内容）。
  const firstInMovie = new Map();
  if (video) {
    firstInMovie.set('video', (videoTrack.origin - video.info.editMediaTime) / video.info.timescale);
  }
  if (audio) {
    firstInMovie.set('audio', (audioTrack.origin - audio.info.editMediaTime) / audio.info.timescale);
  }
  const earliest = firstInMovie.size ? Math.min(...firstInMovie.values()) : 0;
  // 这里**故意不报 warning**：`earliest > 1`（中途开始抓）是"从当前进度开始"这个功能的
  // 正常形态，默认就开着，每次抓流都弹一句提示是纯噪音。真正的异常是"两条轨的起点差得
  // 离谱"（源流自己的时间轴不自洽），那种情况下面用 firstInMovie 的差量本来就会写出
  // 一截空白，但我在任何真实素材上都没见过 —— 没见过的形状先不写代码，只留这段说明。

  // 产物侧的轨号是 mp4-muxer 定死的：视频 1；音频在没有视频时是 1，否则是 2。
  const edits = new Map();
  if (video) {
    edits.set(1, {
      seconds: earliest - firstInMovie.get('video'),
      timescale: muxerOptions.video.frameRate ?? 57600,
    });
  }
  if (audio) {
    edits.set(video ? 2 : 1, {
      seconds: earliest - firstInMovie.get('audio'),
      timescale: audio.info.sampleRate,
    });
  }

  return applyEditLists(new Uint8Array(buffer), edits, options.onWarning);
}

/** 合并前的体检信息，给 UI / 日志用（也算一种「我到底读了什么」的凭据）。 */
export function describeMergeInput({ video, audio } = {}) {
  const parts = [];
  for (const [kind, type, input] of [['视频', 'video', video], ['音频', 'audio', audio]]) {
    if (!input) continue;
    try {
      const info = parseInitSegment(input.init, { contentType: type });
      const count = Array.isArray(input.segments) ? input.segments.length : 0;
      const shape = info.contentType === 'video'
        ? `${info.width}×${info.height} ${info.codecType}`
        : `${info.channels} 声道 ${info.sampleRate} Hz ${info.codecType}`;
      parts.push(`${kind} ${shape} · timescale ${info.timescale} · ${count} 个分片`);
    } catch (err) {
      parts.push(`${kind} 解析失败：${err.message}`);
    }
  }
  return parts.join('；');
}
