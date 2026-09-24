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
  isWebm, isWebmClusterStart, splitWebmInit, parseWebmInit, describeWebmTracks,
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

  // 顶层盒子：跳过 ftyp/styp/sidx/mdat，找到 moof
  let at = 0;
  while (at + 8 <= bytes.byteLength) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (size < 8) return null;
    if (type === 'moof') return readMoof(view, bytes, at + 8, Math.min(at + size, bytes.byteLength));
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
  let at = start;
  while (at + 8 <= end) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (size < 8) break;
    const payload = at + 8;
    if (type === 'tfhd' && payload + 8 <= end) {
      // tfhd：version/flags(4) + track_ID(4)
      trackId = view.getUint32(payload + 4);
    } else if (type === 'tfdt' && payload + 8 <= end) {
      const version = view.getUint8(payload);
      const p = payload + 4;
      baseMediaDecodeTime = version === 1
        ? view.getUint32(p) * 2 ** 32 + view.getUint32(p + 4)   // 64 位：高位在前
        : view.getUint32(p);
    }
    at += size;
  }
  return { trackId, baseMediaDecodeTime };
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
  const map = new Map();
  const seen = new Set();
  let duplicates = 0;

  const sorted = [...items].sort((a, b) => a.seq - b.seq);
  for (const item of sorted) {
    if (!item?.bytes?.byteLength) continue;
    const mime = item.mime || '';
    // 有 mime 就按 mime 分（播放器重建 SourceBuffer 时还是同一条轨，要合在一起）；
    // 没 mime 只能按编号分（那是几条不同的流）。
    const key = mime || `sb:${item.sbId || '未知'}`;
    // 再按**容器**分一层：播放器可以在同一条 SourceBuffer 上 `changeType()` 换容器，
    // 于是同一个 mime 下混着两种格式（用户实测：视频流里 webm 6MB + fmp4 63MB）。
    // 不分层的话，解析器只认第一种，换容器之后的整段都解析不出来、被整段丢掉。
    // kind 缺省（老的调用方、单元测试）时行为与以前完全一致。
    const kind = item.kind && item.kind !== 'unknown' ? item.kind : '';
    const groupKey = kind ? `${key}|${kind}` : key;

    // 判重也按分组来：同一条流的重复分片要去掉，
    // 但两条不同的流里"碰巧一样"的分片不能互相顶掉。
    const fingerprintKey = `${groupKey}#${fingerprint(item.bytes)}`;
    if (seen.has(fingerprintKey)) { duplicates += 1; continue; }
    seen.add(fingerprintKey);

    if (!map.has(groupKey)) {
      map.set(groupKey, { mime, sbId: item.sbId || '', kind, chunks: [], bytes: 0 });
    }
    const g = map.get(groupKey);
    g.chunks.push(item.bytes);
    g.bytes += item.bytes.byteLength;
  }

  return { groups: [...map.values()], duplicates };
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
      const { init, fragments } = splitSelfContainedFmp4(merged);
      // 轨道类型以 moov 里的 handler 为准 —— mime 有时是骗人的
      // （有些播放器给两条轨都用 video/mp4）
      const info = parseInitSegment(init);
      return {
        container,
        contentType: info.contentType || fromMime,
        codecType: info.codecType,
        init,
        fragments,
        bytes: merged.byteLength,
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
      // 用户实测：一整组 **87 MB 画面**因为这条抛错被当成"认不出容器"丢掉，
      // 产物里只剩另一条 5 MB 的画面。这里退一步：moov 之前当 init、第一个 moof
      // 起当分片 —— 交给下游照常解析（解析不了的部分它自己会按缺样本处理）。
      const moov = findTopBox(merged, 'moov');
      const moof = findTopBox(merged, 'moof');
      if (moov && moof && moof.start >= moov.end) {
        return {
          container,
          contentType: fromMime,
          init: merged.slice(0, moov.end),
          fragments: merged.slice(moof.start),
          bytes: merged.byteLength,
          salvaged: true,
          error: err.message,
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
  if (rescueMoov && rescueMoof && rescueMoof.start >= rescueMoov.end) {
    return {
      container: 'fmp4',
      contentType: fromMime,
      init: merged.slice(0, rescueMoov.end),
      fragments: merged.slice(rescueMoof.start),
      bytes: merged.byteLength,
      salvaged: true,
      error: '开头认不出容器，但里面有 moov + moof，已按 fMP4 救回来',
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
