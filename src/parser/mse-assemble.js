/**
 * 把 MSE 采集到的缓冲区归并成「轨道」。
 *
 * 页面可能开一个 SourceBuffer（HLS 那样音视频复用在一条 TS 里），
 * 也可能开两个（DASH 那样视频一条、音频一条）。采集到的就是一堆
 * `appendBuffer` 的原始字节加上它们各自的 mime。
 *
 * 这个模块只做纯逻辑（分组、去重、判容器、判轨道类型），
 * 不碰网络也不碰文件，所以能拿真实数据在 Node 里测。
 */
import { splitSelfContainedFmp4 } from './fmp4-file.js';
import { parseInitSegment } from './mp4-merge.js';
import { repairTimelineGaps } from './seek-check.js';
import {
  isWebm, isWebmClusterStart, splitWebmInit, parseWebmInit, describeWebmTracks, resyncToNextCluster,
} from './webm-demux.js';

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;

/** FNV-1a 32 位。用来给分片做去重指纹 —— 只是判重，不需要密码学强度。 */
export function fingerprint(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ':' + bytes.length;
}

/** 粗判容器：只看头几个字节，够用了 */
export function sniffContainer(bytes) {
  if (!bytes || bytes.byteLength < 8) return 'unknown';
  if (bytes[0] === TS_SYNC_BYTE && (bytes.byteLength < TS_PACKET_SIZE + 1 || bytes[TS_PACKET_SIZE] === TS_SYNC_BYTE)) {
    return 'mpegts';
  }
  // WebM/Matroska：用户报的「抓 YouTube 有画面没声音」就是这条音频轨
  // （`audio/webm; codecs="opus"`）。只认 EBML 头，或者一个裸的 Cluster ——
  // 后者说明抓流是中途开的，头部没抓到，上层要给出"刷新页面"的提示。
  if (isWebm(bytes)) return 'webm';
  if (isWebmClusterStart(bytes)) return 'webm-no-init';
  const type = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  if (type === 'ftyp' || type === 'styp' || type === 'moof' || type === 'moov' || type === 'sidx') {
    return 'fmp4';
  }
  return 'unknown';
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

/**
 * 从一个 fMP4 分片里读出**媒体时间轴**上的起点（tfdt 的 baseMediaDecodeTime）。
 *
 * ## 为什么只要盒子、不解样本
 *
 * 抓流过程中要能回答"这段内容有多长了" —— 用户设置的"每 10 分钟存一份"应该是
 * **视频里的 10 分钟**，而不是"你等了 10 分钟"。这俩在正常播放时差不多，
 * 但用户用倍速插件播的时候能差出好几倍（他自己就是这么用的：4 倍速下
 * 物理 10 分钟 = 视频里 40 分钟）。
 *
 * 只要走一遍盒子（`moof` → `traf` → `tfhd`/`tfdt`）就够了，**不解样本、不拷贝数据** ——
 * 一个分片几百字节的扫描，几秒才来一次，开销可以忽略。
 *
 * @param {Uint8Array} bytes 一个分片（可以是 moof 开头的裸分片）
 * @returns {{trackId:number, baseMediaDecodeTime:number}|null} 认不出来就返回 null
 */
export function readFragmentMediaTime(bytes) {
  if (!bytes || bytes.byteLength < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const sidxTimescales = new Map();
  // 顶层盒子：跳过 ftyp/styp/sidx/mdat，找到 moof
  let at = 0;
  while (at + 8 <= bytes.byteLength) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (size < 8) return null;
    if (type === 'sidx' && at + 20 <= bytes.byteLength) {
      const refId = view.getUint32(at + 12);
      const ts = view.getUint32(at + 16);
      if (ts > 0 && ts <= 10000000) sidxTimescales.set(refId, ts);
    }
    if (type === 'moof') {
      const found = readMoof(view, bytes, at + 8, Math.min(at + size, bytes.byteLength));
      if (found) {
        const ts = (found.trackId != null ? sidxTimescales.get(found.trackId) : null)
          || (sidxTimescales.size === 1 ? [...sidxTimescales.values()][0] : null);
        return {
          ...found,
          timescale: ts || found.timescale || null,
        };
      }
    }
    at += size;
  }
  // 也可能是"只有 moof 的裸分片"，上面那圈已经覆盖；再兜一次 moof 开头的情况
  return null;
}

function readMoof(view, bytes, start, end) {
  let at = start;
  while (at + 8 <= end) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (size < 8) break;
    if (type === 'traf') {
      const found = readTraf(view, bytes, at + 8, Math.min(at + size, end));
      if (found?.baseMediaDecodeTime != null) return found;
    }
    at += size;
  }
  return null;
}

function readTraf(view, bytes, start, end) {
  let trackId = null;
  let baseMediaDecodeTime = null;
  let durationTicks = 0;
  let defaultSampleDuration = 0;
  let at = start;
  while (at + 8 <= end) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (size < 8) break;
    const payload = at + 8;
    if (type === 'tfhd' && payload + 8 <= end) {
      // tfhd：version/flags(4) + track_ID(4)
      const flags = (view.getUint8(payload + 1) << 16) | (view.getUint8(payload + 2) << 8) | view.getUint8(payload + 3);
      trackId = view.getUint32(payload + 4);
      let opt = payload + 8;
      if (flags & 0x01) opt += 8; // base-data-offset
      if (flags & 0x02) opt += 4; // sample-description-index
      if ((flags & 0x08) && opt + 4 <= end) { // default-sample-duration
        defaultSampleDuration = view.getUint32(opt);
      }
    } else if (type === 'tfdt' && payload + 8 <= end) {
      const version = view.getUint8(payload);
      const p = payload + 4;
      baseMediaDecodeTime = version === 1
        ? view.getUint32(p) * 2 ** 32 + view.getUint32(p + 4)   // 64 位：高位在前
        : view.getUint32(p);
    } else if (type === 'trun' && payload + 8 <= end) {
      const trunFlags = (view.getUint8(payload + 1) << 16) | (view.getUint8(payload + 2) << 8) | view.getUint8(payload + 3);
      const sampleCount = view.getUint32(payload + 4);
      let opt = payload + 8;
      if (trunFlags & 0x01) opt += 4; // data-offset
      if (trunFlags & 0x04) opt += 4; // first-sample-flags
      const hasSampleDuration = (trunFlags & 0x100) !== 0;
      const sampleEntrySize = (hasSampleDuration ? 4 : 0)
        + ((trunFlags & 0x200) ? 4 : 0) // sample_size
        + ((trunFlags & 0x400) ? 4 : 0) // sample_flags
        + ((trunFlags & 0x800) ? 4 : 0); // sample_composition_time_offset
      if (hasSampleDuration && sampleEntrySize > 0) {
        let cur = opt;
        for (let i = 0; i < sampleCount && cur + 4 <= end; i += 1) {
          durationTicks += view.getUint32(cur);
          cur += sampleEntrySize;
        }
      } else if (defaultSampleDuration > 0) {
        durationTicks = sampleCount * defaultSampleDuration;
      }
    }
    at += size;
  }
  return { trackId, baseMediaDecodeTime, durationTicks: durationTicks > 0 ? durationTicks : null };
}

/** 把若干块拼成一块（TS 重封装之后要拼回一个媒体分片） */
export function concatChunks(chunks) {
  return concat(chunks);
}

/** mime → 大类。播放器的 addSourceBuffer 参数里就写着是视频还是音频。 */
export function contentTypeFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return '';
}

/**
 * 按 mime 分组，并按到达顺序保留分片。
 *
 * 为什么要去重：用户拖动进度条时播放器会**重新 append 已经放过的分片**，
 * 直接拼接会把那段内容重复写入，产物从头到尾都是错的。
 * 用内容指纹判重，比按"第几次调用"猜可靠得多。
 *
 * ⚠️ 没有 mime 的 append 要**按 SourceBuffer 编号分组**，不能全塞进同一个
 * 空 mime 组里：真实站点（YouTube 上实测）会有几条流同时报空 mime，
 * 混在一起按到达顺序拼，字节头尾不接 —— 表现是整组被当成"认不出容器"
 * 丢掉（实测 0.68 MB）。分开之后每组都能靠自己的 moov/EBML 判型。
 *
 * @param {Array<{seq:number, mime:string, sbId?:string, bytes:Uint8Array}>} items
 * @returns {{groups: Array, duplicates: number}}
 */
export function groupBuffers(items) {
  const sorted = [...items].sort((a, b) => a.seq - b.seq);

  // 第一遍：先按"流"（mime / 编号）归并，并记下这条流里出现过几种**识别得出来**的容器。
  const byKey = new Map();
  for (const item of sorted) {
    if (!item?.bytes?.byteLength) continue;
    const mime = item.mime || '';
    // 有 mime 就按 mime 分（播放器重建 SourceBuffer 时还是同一条轨，要合在一起）；
    // 没 mime 只能按编号分（那是几条不同的流）。
    const key = mime || `sb:${item.sbId || '未知'}`;
    if (!byKey.has(key)) byKey.set(key, { mime, sbId: item.sbId || '', items: [], kinds: new Set() });
    const g = byKey.get(key);
    g.items.push(item);
    if (item.kind && item.kind !== 'unknown') g.kinds.add(item.kind);
  }

  // 第二遍：**只有**这条流确实出现过两种以上识别出来的容器（= 播放器真的换了容器）
  // 才按容器拆开；否则原样一组。
  //
  // ⚠️ 这里踩过一次大坑（用户："怎么越改越不行"）：第一版是"每个 item 各自按 kind 分"，
  // 于是**认不出容器的那几段**（抓流从中间开始、或分片从中间续上，sniff 成 unknown）
  // 会被放进一个没后缀的组，而后面认得出的段进另一个组 —— 同一条流的头和身子被切成
  // 两组**残数据**，两组都拼不出完整文件（用户实测：收到 141MB 画面、四组全残、
  // 导出只剩音频）。现在 unknown 永远跟着它前面那一段走，且"只有一种容器就不拆"。
  const map = new Map();
  const seen = new Set();
  let duplicates = 0;
  for (const [key, g] of byKey) {
    const split = g.kinds.size > 1;
    let currentKind = '';
    for (const item of g.items) {
      if (item.kind && item.kind !== 'unknown') currentKind = item.kind;
      const kind = split ? (currentKind || 'unknown') : '';
      const groupKey = kind ? `${key}|${kind}` : key;

      // 判重也按分组来：同一条流的重复分片要去掉，
      // 但两条不同的流里"碰巧一样"的分片不能互相顶掉。
      const fingerprintKey = `${groupKey}#${fingerprint(item.bytes)}`;
      if (seen.has(fingerprintKey)) { duplicates += 1; continue; }
      seen.add(fingerprintKey);

      if (!map.has(groupKey)) {
        map.set(groupKey, { mime: g.mime, sbId: g.sbId, kind, chunks: [], bytes: 0 });
      }
      const grp = map.get(groupKey);
      grp.chunks.push(item.bytes);
      grp.bytes += item.bytes.byteLength;
    }
  }

  return { groups: [...map.values()], duplicates };
}

/**
 * 从某个偏移开始，盒子的长度链能不能**一路走到末尾**。
 *
 * 为什么需要它：扫描救援（`findTopBox`）在字节错位时可能"找到一个像样的 moof"，
 * 但那个位置之后的数据未必是连续的 —— 用户实测就是这种：救回来的视频轨
 * **每一帧都解不开**（"obu_forbidden_bit out of range"），产物看起来成功、画面却是死的。
 * 这比"整组丢掉"更糟，所以救援必须带一道"链是否完整"的验证：
 * 链断了就**退回丢掉 + 说明**，绝不产出坏画面。
 */
function boxChainOk(bytes, from) {
  let at = from;
  let guard = 0;
  while (at + 8 <= bytes.byteLength) {
    guard += 1;
    if (guard > 200000) return false;
    const size = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
    if (size === 1) return false;
    if (size < 8 || at + size > bytes.byteLength) return false;
    at += size;
  }
  return at >= bytes.byteLength - 7;
}

/**
 * 兜底用：找顶层某个盒子的**起止偏移**（只看盒子头，不解析内容）。
 *
 * 为什么需要它：严格拆分（`splitSelfContainedFmp4`）会把"能一路解析到最后一个字节"
 * 当成前提；真实抓流里只要有一段字节缺失/重叠，它就整个抛错 —— 于是一整组
 * （用户实测 **87 MB 画面**）被当成"认不出容器"丢掉。但其实 init（moov）和媒体分片
 * 都还在，只是边界对不齐，完全可以救。
 */
function findTopBox(bytes, want) {
  // ⚠️ 不能"从 0 开始按长度往下跳"：用户实测的组**从头就是错位的** ——
  // 第 3 个盒子声称 47 亿字节，一跳就出了边界，于是整组被当成"认不出容器"丢掉（62 MB 画面）。
  // 改成**扫标签 + 校验长度**：只要某处的类型标签对得上、长度又合法，就认它。
  // 代价是一次线性扫描，只在"严格拆分已经失败"这条错误路径上跑。
  const t0 = want.charCodeAt(0);
  const t1 = want.charCodeAt(1);
  const t2 = want.charCodeAt(2);
  const t3 = want.charCodeAt(3);
  for (let at = 0; at + 8 <= bytes.byteLength; at += 1) {
    if (bytes[at + 4] !== t0 || bytes[at + 5] !== t1 || bytes[at + 6] !== t2 || bytes[at + 7] !== t3) continue;
    const size = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
    if (size === 1) continue; // 64 位长度（抓流字节里不会出现）——不猜
    if (size < 8 || at + size > bytes.byteLength) continue;
    return { start: at, end: at + size };
  }
  return null;
}

/**
 * 寻找下一个合法的 moof 头部偏移（验证子盒必须是 mfhd）。
 */
function findNextMoof(bytes, fromPos, len) {
  for (let p = fromPos; p + 16 <= len; p += 1) {
    if (bytes[p + 4] === 0x6d && bytes[p + 5] === 0x6f && bytes[p + 6] === 0x6f && bytes[p + 7] === 0x66) {
      const moofSize = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
      if (moofSize >= 16 && p + moofSize <= len) {
        // 进一步验证：moof 内第一个子 box 必须是 'mfhd' (0x6d 0x66 0x68 0x64)
        if (bytes[p + 12] === 0x6d && bytes[p + 13] === 0x66 && bytes[p + 14] === 0x68 && bytes[p + 15] === 0x64) {
          return p;
        }
      }
    }
  }
  return -1;
}

/**
 * 寻找下一个合法的媒体分片起始偏移（验证后续必有合法的 moof+mfhd）。
 * 考虑到 DASH / fMP4 分片结构经常是 [styp] [sidx] [moof] [mdat]，
 * 若 moof 之前紧接着合法的 styp/sidx 链，保留完整的前置 box。
 */
function findNextFragmentStart(bytes, fromPos, len) {
  const nextMoof = findNextMoof(bytes, fromPos, len);
  if (nextMoof === -1) return -1;

  // 往前回溯：在 nextMoof 之前，是否紧邻着 styp 或 sidx 等前置盒子？
  const PRE_BOXES = new Set(['styp', 'sidx', 'prft', 'emsg']);
  const searchFrom = Math.max(fromPos, nextMoof - 4096);
  for (let cand = searchFrom; cand < nextMoof; cand += 1) {
    let p = cand;
    let ok = true;
    while (p < nextMoof) {
      if (p + 8 > nextMoof) { ok = false; break; }
      const size = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
      const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
      if (!PRE_BOXES.has(type) || size < 8 || p + size > nextMoof) {
        ok = false;
        break;
      }
      p += size;
    }
    if (ok && p === nextMoof) {
      return cand;
    }
  }

  return nextMoof;
}

/**
 * 容错救援：当严格拆分（splitSelfContainedFmp4）因字节错位/坏段/中途截断/切段未带 moov 而失败时，
 * 尽量救回初始化段（若有 moov）以及所有合法的媒体分片（moof+mdat），绝不轻易丢弃几十上百兆的画面数据。
 *
 * 核心机制：
 * 类似 WebM 遇到错位时 resyncToNextCluster 救回后续 Cluster，
 * fMP4 在遇到断点错位时向后搜寻下一个合法的 moof 头部（子盒必须是 mfhd），
 * 跳过损坏错位区间，把后续所有完整的媒体分片全部救回。
 * 即使整组没有任何 moov（如自动切段后续分片、或抓流从播放中途开始），只要包含完整的 moof+mdat，
 * 同样全部救回并标记 missingInit: true，以便上层借用本次会话先前保存的初始化段（seenInit）。
 */
function salvageFmp4Group(merged, fromMime) {
  if (!merged || merged.byteLength < 16) return null;
  const len = merged.byteLength;
  const moov = findTopBox(merged, 'moov');

  let init = null;
  let info = null;
  if (moov) {
    try {
      init = merged.slice(0, moov.end);
      info = parseInitSegment(init);
    } catch {
      try {
        init = merged.slice(moov.start, moov.end);
        info = parseInitSegment(init);
      } catch {
        init = null;
      }
    }
  }

  const pieces = [];
  let at = moov ? moov.end : 0;
  let skippedTotal = 0;
  const FRAG_BOXES = new Set(['moof', 'mdat', 'sidx', 'styp', 'prft', 'emsg']);

  // 如果没有 moov，开头可能包含 orphan 字节（如自动切段截断的 mdat 残片、或乱码）。
  // 若开头不是合法 box 或者是孤立的 mdat，必须定位到第一个合法媒体分片。
  if (!moov) {
    const firstType = at + 8 <= len
      ? String.fromCharCode(merged[at + 4], merged[at + 5], merged[at + 6], merged[at + 7])
      : '';
    const firstSize = at + 8 <= len
      ? (((merged[at] << 24) | (merged[at + 1] << 16) | (merged[at + 2] << 8) | merged[at + 3]) >>> 0)
      : 0;

    if (!FRAG_BOXES.has(firstType) || firstType === 'mdat' || firstSize < 8 || at + firstSize > len) {
      const firstFrag = findNextFragmentStart(merged, 0, len);
      if (firstFrag === -1) return null;
      skippedTotal += firstFrag;
      at = firstFrag;
    }
  }

  let lastCompletePieceIndex = 0;
  let lastCompleteFragEnd = moov ? moov.end : 0;
  let tailSkipped = 0;

  while (at + 8 <= len) {
    const size = ((merged[at] << 24) | (merged[at + 1] << 16) | (merged[at + 2] << 8) | merged[at + 3]) >>> 0;
    const type = String.fromCharCode(merged[at + 4], merged[at + 5], merged[at + 6], merged[at + 7]);

    if (FRAG_BOXES.has(type) && size >= 8 && at + size <= len) {
      pieces.push(merged.subarray(at, at + size));
      at += size;
      if (type === 'mdat') {
        lastCompletePieceIndex = pieces.length;
        lastCompleteFragEnd = at;
      }
      continue;
    }

    // 遇到非法的 box 长度或乱码类型（错位/坏段/丢片点）：向后扫描寻找下一个合法的媒体分片
    const nextFrag = findNextFragmentStart(merged, at + 1, len);
    if (nextFrag !== -1) {
      skippedTotal += (nextFrag - at);
      at = nextFrag;
    } else {
      tailSkipped = (len - at);
      break;
    }
  }

  // 必须至少救出一个 moof
  const hasMoof = pieces.some((p) => {
    return p.length >= 8 && p[4] === 0x6d && p[5] === 0x6f && p[6] === 0x6f && p[7] === 0x66;
  });
  if (!hasMoof) return null;

  let remainder = null;
  if (lastCompletePieceIndex > 0 && lastCompletePieceIndex < pieces.length) {
    pieces.length = lastCompletePieceIndex;
  }
  if (lastCompleteFragEnd > 0 && lastCompleteFragEnd < len) {
    remainder = merged.slice(lastCompleteFragEnd);
  } else {
    skippedTotal += tailSkipped;
  }

  const fragments = concat(pieces);

  if (init) {
    return {
      container: 'fmp4',
      contentType: info?.contentType || fromMime || 'video',
      codecType: info?.codecType,
      init,
      fragments,
      bytes: merged.byteLength,
      salvaged: true,
      skippedBytes: skippedTotal,
      remainder,
    };
  }

  return {
    container: 'fmp4',
    contentType: fromMime || 'video',
    codecType: undefined,
    raw: fragments,
    bytes: merged.byteLength,
    missingInit: true,
    salvaged: true,
    skippedBytes: skippedTotal,
    remainder,
  };
}

/**
 * 给"只有分片、没有初始化段"的那一组挑一个能用的初始化段。
 *
 * 判据的优先级：
 *
 *   1. **分片自己的 `tfhd.track_ID` 能在哪份 init 里找到**；
 *      ⚠️ 但 trackId 会撞号 —— 实测 ffmpeg 产的两条独立轨（视频一条、音频一条）
 *      **都写 track 1**。撞号时如果调用方知道大类（`contentType`），就按大类定；
 *   2. 按大类（video/audio）取；
 *   3. 最后才退回"当视频用"的老行为 —— 保证修完不会比原来更差。
 *
 * ⚠️ 调用方还有一条**比 trackId 更准**的线索，必须先用它：这条流（按分组键：
 * mime 或 `sb:<编号>`）**先前**被分析成什么大类。分组键在整个会话里是稳定的，
 * 而"只有分片"的这一组光看字节推不出大类（真实站点上一批 append 根本没有 mime）。
 *
 * 为什么值得单拎成一个纯函数：这里借错一次，就是**整条音轨消失**（合并时按 trackId
 * 挑样本，借来的 init 里没有这个 id，那一组直接被丢掉），而且从界面上完全看不出来
 * ——用户只会说"切段之后那一段没声音"。有名字、有用例，才好钉住。
 *
 * @param {Array<{key:string, contentType:string, trackIds:number[], init:Uint8Array}>} candidates
 * @param {{contentType?:string, trackId?:number|null}} [want]
 * @returns {{candidate:object, by:'trackId'|'trackId+type'|'type'|'fallback'}|null}
 */
export function pickReusableInit(candidates = [], { contentType = '', trackId = null } = {}) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (trackId != null) {
    const hits = list.filter((c) => (c.trackIds || []).includes(trackId));
    if (hits.length === 1) return { candidate: hits[0], by: 'trackId' };
    // 撞号（两条轨都写 track 1）：有大类就按大类定，没有只能取第一条
    if (hits.length > 1 && contentType) {
      const typed = hits.find((c) => c.contentType === contentType);
      if (typed) return { candidate: typed, by: 'trackId+type' };
    }
    if (hits.length) return { candidate: hits[0], by: 'trackId' };
  }
  if (contentType) {
    const hit = list.find((c) => c.contentType === contentType);
    if (hit) return { candidate: hit, by: 'type' };
  }
  const fallback = list.find((c) => c.contentType === 'video') || list[0];
  return fallback ? { candidate: fallback, by: 'fallback' } : null;
}

/**
 * 分析一组分片：是什么容器、哪条轨、初始化段和媒体分片分别是什么。
 *
 * @returns {{container:string, contentType:string, init?:Uint8Array, fragments?:Uint8Array,
 *            bytes:number, error?:string}}
 */
export function analyzeGroup(group) {
  const merged = concat(group.chunks);
  const container = sniffContainer(merged);
  const fromMime = contentTypeFromMime(group.mime);

  if (container === 'mpegts') {
    // TS 要重封装才能拆成 init/分片，那一步需要 mux.js（浏览器里才有），
    // 所以这里只把合并后的字节交出去，类型先按 mime 猜。
    return { container, contentType: fromMime, bytes: merged.byteLength, raw: merged };
  }

  if (container === 'webm' || container === 'webm-no-init') {
    // ⚠️ 这里的 contentType 要按**轨道表**判，不能信 mime：
    // YouTube 给的 `audio/webm; codecs="opus"` 是对的，但同一个播放器
    // 也可能给两条 SourceBuffer 都报 `video/mp4`（见下面 fMP4 分支的注释）。
    if (container === 'webm') {
      try {
        const { init, media } = splitWebmInit(merged);
        const info = parseWebmInit(init);
        const types = new Set(info.tracks.map((t) => t.type));
        return {
          container: 'webm',
          contentType: types.size === 1 ? [...types][0] : '',
          codecType: types.size === 1 ? (info.tracks[0].codec || info.tracks[0].codecId) : '',
          tracks: info.tracks,
          webmTracks: info.tracks.map((t) => ({
            number: t.number, type: t.type, codec: t.codec, codecId: t.codecId,
            sampleRate: t.sampleRate, channels: t.channels, width: t.width, height: t.height,
          })),
          trackSummary: describeWebmTracks(info.tracks),
          init,
          fragments: media,
          bytes: merged.byteLength,
        };
      } catch (err) {
        return {
          container: 'webm',
          contentType: fromMime,
          bytes: merged.byteLength,
          raw: merged,
          // ⚠️ 标记成"没有初始化段"：这一组的头部要么没抓到、要么本身是坏的（字节错位）。
          // 标出来之后上层才会走"借一份先前收到的头部"那条路 —— 用户实测：
          // 不标的话分支链一个都不匹配，整组（这次 5MB）连一句提示都没有就没了。
          missingInit: true,
          error: err.message,
        };
      }
    }
    // 只有 Cluster、没有头部：认不出这是音频还是视频，只能让用户刷新页面
    return {
      container: 'webm',
      contentType: '',
      bytes: merged.byteLength,
      raw: merged,
      missingInit: true,
      error: 'WebM 的头部（Tracks）没抓到，只有裸的 Cluster',
    };
  }

  if (container === 'fmp4') {
    try {
      const { init, fragments, boxes } = splitSelfContainedFmp4(merged);
      // 轨道类型以 moov 里的 handler 为准 —— mime 有时是骗人的
      // （有些播放器给两条轨都用 video/mp4）
      const info = parseInitSegment(init);
      let lastMdat = null;
      for (let i = boxes.length - 1; i >= 0; i--) {
        if (boxes[i].type === 'mdat') {
          lastMdat = boxes[i];
          break;
        }
      }
      let safeFragments = fragments;
      let remainder = null;
      if (lastMdat && lastMdat.end < merged.byteLength) {
        remainder = merged.slice(lastMdat.end);
        safeFragments = merged.subarray(init.byteLength, lastMdat.end);
      }
      return {
        container,
        contentType: info.contentType || fromMime,
        codecType: info.codecType,
        init,
        fragments: safeFragments,
        bytes: merged.byteLength,
        remainder,
      };
    } catch (err) {
      // 「没有初始化段」是一条**特别常见、也特别好解释**的失败：
      // 点开抓流的时候播放器已经把 moov 送进去了，钩子只看得见之后的调用。
      // 单独标出来，好让上层给出一句能直接照做的提示。
      const missingInit = /没有初始化段/.test(err.message);
      // 反过来，「只有初始化段、没有媒体数据」也要单独认出来 ——
      // 那不是失败，是**一份有用的东西**：抓流期间播放器重建 SourceBuffer 时，
      // 初始化段可能单独落在自己那一组里，上层要能记住它（见 offscreen 的
      // seenInit），否则后面只补分片的那一组就成了"没有初始化段"。
      const initOnly = /只有初始化段/.test(err.message);
      // ---- 尽量救：严格拆不出来，多半只是"边界对不齐"，moov 和 moof 其实都还在 ----
      const moov = findTopBox(merged, 'moov');
      const moof = findTopBox(merged, 'moof');
      if (moov && moof && moof.start >= moov.end && boxChainOk(merged, moof.start)) {
        let lastMdatEnd = -1;
        let p = moof.start;
        while (p + 8 <= merged.byteLength) {
          const sz = ((merged[p] << 24) | (merged[p + 1] << 16) | (merged[p + 2] << 8) | merged[p + 3]) >>> 0;
          const ty = String.fromCharCode(merged[p + 4], merged[p + 5], merged[p + 6], merged[p + 7]);
          if (sz < 8 || p + sz > merged.byteLength) break;
          if (ty === 'mdat') lastMdatEnd = p + sz;
          p += sz;
        }
        let remainder = null;
        let fragEnd = merged.byteLength;
        if (lastMdatEnd > moof.start && lastMdatEnd < merged.byteLength) {
          fragEnd = lastMdatEnd;
          remainder = merged.slice(lastMdatEnd);
        }
        return {
          container,
          contentType: fromMime,
          init: merged.slice(0, moov.end),
          fragments: merged.slice(moof.start, fragEnd),
          bytes: merged.byteLength,
          salvaged: true,
          error: err.message,
          remainder,
        };
      }
      // 容错深度救援：即使中途某个 box 损坏断裂（如用户拖动或刷新切段），
      // 向后搜寻并救回后续所有合法的 moof+mdat 分片，绝不把几十上百兆画面直接丢弃
      const salvaged = salvageFmp4Group(merged, fromMime);
      if (salvaged) {
        return {
          ...salvaged,
          error: salvaged.skippedBytes
            ? `部分分片错位截断（已跳过 ${salvaged.skippedBytes} 字节并救回合法分片）：${err.message}`
            : err.message,
        };
      }
      return {
        container,
        contentType: fromMime,
        bytes: merged.byteLength,
        raw: merged,
        ...(initOnly ? { init: merged, fragments: new Uint8Array(0), initOnly: true } : {}),
        missingInit,
        error: err.message,
      };
    }
  }

  // 也许只是"开头错位"：容器认不出来，但里面确实有 moov + moof。
  // 用户实测的 62MB 画面组就是这种形状（第 3 个盒子长度是垃圾值）——
  // 能救就按 fMP4 交出去，救不了再如实说"认不出容器"。
  const rescueMoov = findTopBox(merged, 'moov');
  const rescueMoof = findTopBox(merged, 'moof');
  if (rescueMoov && rescueMoof && rescueMoof.start >= rescueMoov.end && boxChainOk(merged, rescueMoof.start)) {
    let lastMdatEnd = -1;
    let p = rescueMoof.start;
    while (p + 8 <= merged.byteLength) {
      const sz = ((merged[p] << 24) | (merged[p + 1] << 16) | (merged[p + 2] << 8) | merged[p + 3]) >>> 0;
      const ty = String.fromCharCode(merged[p + 4], merged[p + 5], merged[p + 6], merged[p + 7]);
      if (sz < 8 || p + sz > merged.byteLength) break;
      if (ty === 'mdat') lastMdatEnd = p + sz;
      p += sz;
    }
    let remainder = null;
    let fragEnd = merged.byteLength;
    if (lastMdatEnd > rescueMoof.start && lastMdatEnd < merged.byteLength) {
      fragEnd = lastMdatEnd;
      remainder = merged.slice(lastMdatEnd);
    }
    return {
      container: 'fmp4',
      contentType: fromMime,
      init: merged.slice(0, rescueMoov.end),
      fragments: merged.slice(rescueMoof.start, fragEnd),
      bytes: merged.byteLength,
      salvaged: true,
      error: '开头认不出容器，但里面有 moov + moof，已按 fMP4 救回来',
      remainder,
    };
  }
  const rescueDeep = salvageFmp4Group(merged, fromMime);
  if (rescueDeep) {
    const errorMsg = rescueDeep.missingInit
      ? (rescueDeep.skippedBytes
        ? `开头包含 ${rescueDeep.skippedBytes} 字节切段残片且没有初始化段，已按 fMP4 分片救回`
        : '没有初始化段，已按 fMP4 分片救回')
      : '开头认不出容器，但里面有 moov + moof，已按 fMP4 深度救回';
    return {
      ...rescueDeep,
      error: errorMsg,
    };
  }

  // WebM 容错救援：若开头因切段残留错位字节，向后重同步到下一个合法的 Cluster
  const webmClusterAt = resyncToNextCluster(merged, 0, merged.byteLength);
  if (webmClusterAt != null && (fromMime === 'audio' || group.mime?.includes('webm') || isWebm(merged) || isWebmClusterStart(merged))) {
    return {
      container: 'webm',
      contentType: fromMime,
      bytes: merged.byteLength,
      raw: merged.subarray(webmClusterAt),
      missingInit: true,
      salvaged: true,
      skippedBytes: webmClusterAt,
      error: webmClusterAt > 0
        ? `WebM 开头有 ${webmClusterAt} 字节错位，已重新对齐到 Cluster`
        : 'WebM 的头部（Tracks）没抓到，只有裸的 Cluster',
    };
  }

  return {
    container: 'unknown',
    contentType: fromMime,
    bytes: merged.byteLength,
    raw: merged,
    error: `认不出容器（开头字节：${[...merged.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}）`,
  };
}

/**
 * 一组分片都抓不着时，给一句人话。
 *
 * 两种失败原因差别很大，必须分开说 —— 用户看到的提示要能直接照做：
 *   · 什么都没抓到  → 播放器还没 append 新数据，往回拖让它重新取
 *   · 只抓到分片    → 初始化段在你点开之前就过去了，**刷新页面**从头再来
 */
export function explainEmptyCapture() {
  return '没有捕获到任何数据。'
    + '抓流只能拿到你点开**之后**播放器才送进去的数据，所以：'
    + '请在点开抓流之后，把进度条拖回开头重播一遍（或者直接刷新页面）。';
}

export function explainMissingInit() {
  return '只抓到了媒体分片，没有初始化段（moov）—— 开头是 moof/mdat。'
    + '这几乎总是因为：你点开抓流的时候，播放器已经把初始化段送进去了，'
    + '而钩子只看得见装上之后的调用。'
    + '解决办法：**点抓流之后刷新页面**，让播放器从头再来一遍（钩子是持久注册的，刷新后会自己就位）。';
}

/**
 * 产物落盘前的最后一道处理：**把"谁都没抓到数据"的死气压掉**。
 *
 * ## 为什么必须在抓流这条路上做
 *
 * 抓流是**实时**的：钩子只看得见播放器此刻往 SourceBuffer 里送什么。
 * 播放器的播放位置一旦往前跳（站点恢复了上次的观看位置、用户拖了进度条、
 * 播放器自己 seek），中间那一段就谁都没抓到 —— 而分片里带的解码时间戳
 * （tfdt）是**连续**的，于是合并出来的文件里就横着一段几百秒的空洞。
 *
 * 实测用户的一个 23 分钟产物：
 *
 *     stts: 749×…  1×(708 秒)  …     ← 视频轨 12.5 秒之后直接跳到 720.8 秒
 *     音频轨同样                      ← 两条轨一起断 = 那段时间真的什么都没有
 *
 * 表现就是**前 12 分钟怎么拖都拖不动**：进度条一拖，播放器按样本表找
 * "最近的一个关键帧"，而 12 分钟之前根本没有可用样本，只能跳到空洞之后那一帧。
 *
 * ## 为什么可以放心压：判据和录制端一样
 *
 * 只有**每一条有内容的轨都在同一段时间断**，才说明那段时间确实什么都没抓到
 * （死气），压掉之后各轨的相对关系不变。
 * 只有一条轨断的情况（视频没数据、音频在走）**不压** —— 那会让这条轨的内容整体
 * 前移、音画错位，比拖不动严重得多。判据和修复工具共用同一份实现
 * （`repairTimelineGaps`），所以"抓流产出的文件"和"修复工具修过的文件"
 * 标准完全一致，不会出现两套规则。
 *
 * @param {Uint8Array} merged mergeFmp4 的产物
 * @returns {{bytes:Uint8Array, compressedSeconds:number, warnings:string[], skipped:Array}}
 */
export function finalizeCaptureBytes(merged) {
  const fixed = repairTimelineGaps(merged);
  if (!fixed.ok) {
    // 没空洞（正常情况），或者只有单轨缺口 —— 两种都原样输出，
    // 但后者要说出来，否则用户会拿着一个拖不动的文件不知道为什么
    return {
      bytes: merged,
      compressedSeconds: 0,
      skipped: fixed.skipped || [],
      warnings: (fixed.skipped || []).map((s) => (
        `${s.handler === 'vide' ? '视频' : s.handler === 'soun' ? '音频' : s.handler}轨有 `
        + `${Number(s.lengthSeconds).toFixed(1)} 秒没有抓到（${s.reason}）`
      )),
    };
  }
  return {
    bytes: fixed.bytes,
    compressedSeconds: fixed.droppedSeconds,
    skipped: fixed.skipped || [],
    warnings: [
      `抓流过程中有 ${fixed.droppedSeconds.toFixed(1)} 秒没有抓到任何数据`
      + '（那段时间播放器的位置往前跳了 —— 站点恢复了上次的观看位置，或者拖过进度条），'
      + '已经从时间轴里去掉，所以文件比进度条显示的短。',
      ...(fixed.skipped || []).map((s) => (
        `${s.handler === 'vide' ? '视频' : '音频'}轨另有 ${Number(s.lengthSeconds).toFixed(1)} 秒缺口`
        + `（${s.reason}），保留原样`
      )),
    ],
  };
}
