/**
 * MP4「能不能拖进度条」体检，以及把时间轴空洞修掉。
 *
 * ## 为什么单独有这么一个模块
 *
 * 用户报的问题是「拖到两分钟就跳回两秒」。这个现象在真实文件上由**两种**
 * 完全不同的结构缺陷造成，光看"有没有索引 box"分辨不出来：
 *
 *  1. **分片式 MP4**：`mvhd.duration = 0xFFFFFFFF`（"时长未知"）+ 只有 moof。
 *     播放器不知道进度条该铺多长。（下载路线踩过，已改走 mergeFmp4。）
 *  2. **时间轴空洞**：样本表完整、时长也对，但两条样本之间隔着几百秒。
 *     拖动落在空洞里，播放器按样本表只能回到**空洞之前那一帧** ——
 *     看起来就是"拖了立刻跳回去"。（录制路线踩过：标签页被切走/屏幕锁定，
 *     采集源不再出帧，而录制器老老实实把这几百秒写进了 stts。）
 *
 * 第 2 种特别隐蔽：ffprobe 读得出来、时长正确、能播、关键帧也有，
 * 只有把样本表展开算一遍才看得见。
 *
 * ## 空洞为什么能"就地"修掉
 *
 * stts 是 `(样本数, 时长)` 对的数组 —— 空洞表现为**某一个样本的时长特别大**。
 * 把这个时长改回正常帧间隔，**box 的字节长度完全不变**（只是改一个 u32），
 * 而样本数据、stco/stsz/stss 全都不用动。所以修复是一次纯元数据改写，
 * 不需要重编码、不需要搬数据、产物大小和原文件一模一样。
 *
 * 这个文件不碰 DOM、不碰 chrome.*，是纯函数，所以能直接在 Node 里
 * 拿真实文件写测试（见 test/seek-check.test.mjs）。
 */

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const i32 = (b, o) => (u32(b, o) | 0);
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const type4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function writeU32(target, offset, value) {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function writeU64(target, offset, value) {
  writeU32(target, offset, Math.floor(value / 4294967296));
  writeU32(target, offset + 4, value >>> 0);
}

/** 在 [start, end) 里顺序切 box。遇到不合法的长度就停下，不抛错 —— 体检工具宁可少报也不要炸。 */
export function walkBoxes(b, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p);
    const type = type4(b, p + 4);
    let head = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = u64(b, p + 8);
      head = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < head || p + size > end) break;
    out.push({ type, start: p, size, payloadStart: p + head, payloadEnd: p + size });
    p += size;
  }
  return out;
}

/** 顺着 box 路径往下走，只跟第一个匹配的分支。 */
function dig(b, start, end, path) {
  let s = start;
  let e = end;
  let hit = null;
  for (const type of path) {
    hit = walkBoxes(b, s, e).find((x) => x.type === type) || null;
    if (!hit) return null;
    s = hit.payloadStart;
    e = hit.payloadEnd;
  }
  return hit;
}

function parseStts(b, box) {
  const n = u32(b, box.payloadStart + 4);
  const entries = [];
  let at = box.payloadStart + 8;
  for (let i = 0; i < n; i += 1, at += 8) {
    if (at + 8 > box.payloadEnd) break;
    entries.push({ count: u32(b, at), delta: u32(b, at + 4) });
  }
  return entries;
}

function parseElst(b, box) {
  const version = b[box.payloadStart];
  const n = u32(b, box.payloadStart + 4);
  const out = [];
  let at = box.payloadStart + 8;
  for (let i = 0; i < n; i += 1) {
    if (version === 1) {
      out.push({ segmentDuration: u64(b, at), mediaTime: i32(b, at + 8), at });
      at += 28;
    } else {
      out.push({ segmentDuration: u32(b, at), mediaTime: i32(b, at + 4), at });
      at += 12;
    }
  }
  return out;
}

/** 出现次数最多的 delta —— 比"最小值"可靠：最小值可能来自时间戳抖出来的 0。 */
function nominalDelta(entries) {
  const tally = new Map();
  for (const e of entries) {
    if (e.delta <= 0) continue;
    tally.set(e.delta, (tally.get(e.delta) || 0) + e.count);
  }
  let best = 0;
  let bestCount = -1;
  for (const [delta, count] of tally) {
    if (count > bestCount) { best = delta; bestCount = count; }
  }
  return best;
}

function readMvhd(b, box) {
  const version = b[box.payloadStart];
  const timescale = version === 1 ? u32(b, box.payloadStart + 20) : u32(b, box.payloadStart + 12);
  const duration = version === 1 ? u64(b, box.payloadStart + 24) : u32(b, box.payloadStart + 16);
  return {
    version,
    timescale,
    duration,
    seconds: timescale ? duration / timescale : 0,
    unknown: duration === 0 || duration === 0xffffffff,
    durationAt: version === 1 ? box.payloadStart + 24 : box.payloadStart + 16,
  };
}

function readMdhd(b, box) {
  const version = b[box.payloadStart];
  const timescale = version === 1 ? u32(b, box.payloadStart + 20) : u32(b, box.payloadStart + 12);
  const duration = version === 1 ? u64(b, box.payloadStart + 24) : u32(b, box.payloadStart + 16);
  return {
    version,
    timescale,
    duration,
    durationAt: version === 1 ? box.payloadStart + 24 : box.payloadStart + 16,
  };
}

/**
 * 读一个 MP4 的真实时长（秒）。读不到就返回 null。
 *
 * 「真实时长」和「我们折腾了多久」是两件事，这里要的必须是前者：
 * 抓流录了 3 分半、切了两次标签页、中间还暂停了一次，产物可能只有 2 分 10 秒 ——
 * 界面上报"3 分 30 秒"就是在骗用户，他拿播放器一开就发现对不上。
 *
 * 所以时长一律从产物自己的 `mvhd` 里读。两道保险：
 *   1. 严格路径：按 box 结构走 ftyp/moov/mvhd。
 *   2. 容错扫描：只拿到文件的一小段（界面上不可能为了列个时长就把 1 GB 读进内存）
 *      时，退化成在整个缓冲里找 `mvhd` 签名，再用版本号/时间刻度/时长范围三道
 *      校验把 mdat 里的偶然撞车排掉。
 */
export function readMovieDurationSeconds(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 32) return null;

  // ---- 1. 严格路径 ----
  const top = walkBoxes(bytes, 0, bytes.length);
  const moov = top.find((x) => x.type === 'moov');
  if (moov) {
    const mvhdBox = walkBoxes(bytes, moov.payloadStart, moov.payloadEnd).find((x) => x.type === 'mvhd');
    if (mvhdBox) {
      const mvhd = readMvhd(bytes, mvhdBox);
      if (mvhd.timescale && !mvhd.unknown && mvhd.seconds > 0) return mvhd.seconds;
    }
  }

  // ---- 2. 容错扫描 ----
  for (let i = 4; i + 32 <= bytes.length; i += 1) {
    if (bytes[i] !== 0x6d || bytes[i + 1] !== 0x76 || bytes[i + 2] !== 0x68 || bytes[i + 3] !== 0x64) continue; // 'mvhd'
    const p = i + 4;
    const version = bytes[p];
    if (version !== 0 && version !== 1) continue;
    const timescale = version === 1 ? u32(bytes, p + 20) : u32(bytes, p + 12);
    const duration = version === 1 ? u64(bytes, p + 24) : u32(bytes, p + 16);
    if (!timescale || duration === 0 || duration === 0xffffffff) continue;
    const seconds = duration / timescale;
    // 超过一周的"视频"一定是误判（mdat 里撞上这 4 个字节）
    if (seconds <= 0 || seconds > 7 * 24 * 3600) continue;
    return seconds;
  }
  return null;
}

/**
 * 给一个 MP4 做体检。
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {object} 结构化报告；`problems` 是给人看的中文句子，`verdict.level` 是 ok/warn/bad
 */
export function inspectSeekability(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const top = walkBoxes(bytes, 0, bytes.length);
  const topTypes = top.map((x) => x.type);
  const moov = top.find((x) => x.type === 'moov') || null;
  const mdat = top.find((x) => x.type === 'mdat') || null;

  const report = {
    bytes: bytes.length,
    topLevel: topTypes,
    moofCount: topTypes.filter((t) => t === 'moof').length,
    moovBeforeMdat: moov && mdat ? moov.start < mdat.start : !!moov,
    mvhd: null,
    tracks: [],
    problems: [],
    verdict: { level: 'ok', text: '✅ 索引完整，进度条应该能正常拖' },
  };

  if (!moov) {
    report.problems.push('文件里没有 moov（不是 MP4，或者下载被中断截断了）');
    report.verdict = { level: 'bad', text: '❌ 这不是一个完整的 MP4' };
    return report;
  }

  const mvhdBox = walkBoxes(bytes, moov.payloadStart, moov.payloadEnd).find((x) => x.type === 'mvhd');
  report.mvhd = mvhdBox ? readMvhd(bytes, mvhdBox) : null;
  if (report.mvhd?.unknown) {
    report.problems.push('总时长是「未知」——播放器不知道进度条该铺多长，只会顺序播放');
  }

  if (report.moofCount > 0) {
    report.problems.push(`文件里有 ${report.moofCount} 个 moof，是分片式 MP4：没有全局样本表，播放器只能顺序读`);
  }

  const moovKids = walkBoxes(bytes, moov.payloadStart, moov.payloadEnd);
  for (const trak of moovKids.filter((x) => x.type === 'trak')) {
    const hdlr = dig(bytes, trak.payloadStart, trak.payloadEnd, ['mdia', 'hdlr']);
    const handler = hdlr ? type4(bytes, hdlr.payloadStart + 8) : '????';
    const mdhdBox = dig(bytes, trak.payloadStart, trak.payloadEnd, ['mdia', 'mdhd']);
    const mdhd = mdhdBox ? readMdhd(bytes, mdhdBox) : null;
    const stbl = dig(bytes, trak.payloadStart, trak.payloadEnd, ['mdia', 'minf', 'stbl']);
    const elstBox = dig(bytes, trak.payloadStart, trak.payloadEnd, ['edts', 'elst']);

    const track = {
      handler,
      timescale: mdhd?.timescale || 0,
      declaredSeconds: mdhd && mdhd.timescale ? mdhd.duration / mdhd.timescale : 0,
      samples: 0,
      seconds: 0,
      nominalDelta: 0,
      keyframes: null,
      keyframeTimes: [],
      keyframeIntervalMax: 0,
      seekSlackSeconds: 0,
      gaps: [],
      leadingStretch: null,
      elst: elstBox ? parseElst(bytes, elstBox) : null,
      problems: [],
      _mdhd: mdhd,
      _sttsBox: null,
      _stts: null,
    };

    if (stbl) {
      const kids = walkBoxes(bytes, stbl.payloadStart, stbl.payloadEnd);
      const sttsBox = kids.find((x) => x.type === 'stts') || null;
      const stssBox = kids.find((x) => x.type === 'stss') || null;
      const stcoBox = kids.find((x) => x.type === 'stco') || kids.find((x) => x.type === 'co64') || null;
      const stszBox = kids.find((x) => x.type === 'stsz') || null;

      if (sttsBox) {
        const stts = parseStts(bytes, sttsBox);
        track._sttsBox = sttsBox;
        track._stts = stts;
        track.samples = stts.reduce((s, e) => s + e.count, 0);
        const sum = stts.reduce((s, e) => s + e.count * e.delta, 0);
        track.seconds = track.timescale ? sum / track.timescale : 0;
        track.nominalDelta = nominalDelta(stts);

        // 超长条目分两类，这两类的**处理方式完全相反**，必须先分清楚：
        //
        //  · 第一条件目超长 = 这条轨开头被拉长了（编码器预热、起播延迟）。
        //    它不是空洞，压掉会让整条轨往前挪，音画立刻错位。
        //  · 中间某条目超长 = 时间轴上真的一段没有样本，就是"拖了跳回去"的成因。
        const floor = track.timescale
          ? Math.max(track.nominalDelta * 4, Math.round(track.timescale * 0.8))
          : track.nominalDelta * 4;
        let cursor = 0;
        stts.forEach((e, index) => {
          if (e.delta > floor) {
            const entry = {
              entryIndex: index,
              atSeconds: cursor / (track.timescale || 1),
              lengthSeconds: e.delta / (track.timescale || 1),
              sampleCount: e.count,
              delta: e.delta,
            };
            if (index === 0) track.leadingStretch = entry;
            else track.gaps.push(entry);
          }
          cursor += e.count * e.delta;
        });

        const nominal = track.nominalDelta || 1;
        const expand = (index) => {
          let seen = 0;
          let t = 0;
          for (const e of stts) {
            if (index < seen + e.count) return t + (index - seen) * e.delta;
            t += e.count * e.delta;
            seen += e.count;
          }
          return t;
        };
        if (stssBox) {
          const n = u32(bytes, stssBox.payloadStart + 4);
          track.keyframes = n;
          for (let i = 0; i < Math.min(n, 200); i += 1) {
            const num = u32(bytes, stssBox.payloadStart + 8 + i * 4);
            track.keyframeTimes.push(expand(num - 1) / (track.timescale || 1));
          }
        } else if (track.samples) {
          track.keyframes = track.samples;
        }
        for (let i = 1; i < track.keyframeTimes.length; i += 1) {
          track.keyframeIntervalMax = Math.max(
            track.keyframeIntervalMax,
            track.keyframeTimes[i] - track.keyframeTimes[i - 1],
          );
        }
        // 空洞也要让"关键帧看上去间隔很大"，但那不是关键帧真的少 —— 单独算
        const stszCount = stszBox ? (u32(bytes, stszBox.payloadStart + 8) || u32(bytes, stszBox.payloadStart + 4)) : null;
        if (stszCount != null && stszCount !== track.samples) {
          track.problems.push(`stsz 说 ${stszCount} 个样本，stts 说 ${track.samples} 个 —— 样本表对不上`);
        }
      }
      if (!stcoBox) track.problems.push('没有 stco/co64：播放器找不到样本数据在文件里的位置');
    } else {
      track.problems.push('这条轨没有 stbl 样本表');
    }

    if (track.declaredSeconds && track.seconds && Math.abs(track.declaredSeconds - track.seconds) > 1) {
      track.problems.push(
        `轨头声明 ${track.declaredSeconds.toFixed(2)} 秒，样本表加起来 ${track.seconds.toFixed(2)} 秒`,
      );
    }
    // 只有 1 个关键帧才是"拖了立刻跳回开头"的头号原因；有空洞时关键帧显得很稀，
    // 那种情况已经由空洞那条报出来了，不重复报。
    if (handler === 'vide' && track.keyframes === 1 && track.seconds > 10 && !track.gaps.length) {
      track.problems.push(`整条视频轨只有 1 个关键帧（共 ${track.samples} 帧）：拖到任何位置都只能回到开头`);
    }
    if (track.leadingStretch && track.leadingStretch.lengthSeconds > 2) {
      track.problems.push(
        `这条轨开头被拉长了 ${track.leadingStretch.lengthSeconds.toFixed(1)} 秒`
        + '（编码器预热或起播延迟，第一帧被顶在那里）：不影响拖动，但开头这几秒会和另一条轨错开',
      );
    }
    // 用户能直接对照的指标：拖到任意位置，最坏情况会被放回多少秒之前。
    // 一个正常的分片流这个值是 2~10 秒；有空洞时会变成几百秒，也就解释了他看到的"拖了跳回去"。
    if (handler === 'vide' && track.keyframeTimes.length > 1) {
      track.seekSlackSeconds = track.keyframeIntervalMax;
    }

    report.tracks.push(track);
  }

  /* ---- 跨轨判断：这个空洞是"死气"还是"只有这条轨缺内容" ----
   *
   * 这个区分决定了能不能修：
   *  · 所有轨在**同一段时间**都断了 = 整条采集停摆过，那段是死气 → 压掉，音画关系不变。
   *  · 只有一条轨断 = 那一刻这条轨确实没抓到画面（比如后台标签页视频不出帧、音频还在走），
   *    压掉会让这条轨的所有后续内容往前挪，**音画立刻错位** → 只能如实报告，不能动。
   */
  const withSamples = report.tracks.filter((t) => t.samples > 0);
  const SPAN_TOLERANCE = 1.0;
  const spanMatches = (a, b) => Math.abs(a.atSeconds - b.atSeconds) <= SPAN_TOLERANCE
    && Math.abs(a.lengthSeconds - b.lengthSeconds) <= SPAN_TOLERANCE;
  for (const t of withSamples) {
    for (const g of t.gaps) {
      g.deadAir = withSamples.every((other) => other.gaps.some((x) => spanMatches(x, g)));
    }
  }

  for (const track of report.tracks) {
    const label = track.handler === 'vide' ? '视频' : track.handler === 'soun' ? '音频' : track.handler;
    for (const g of track.gaps) {
      const message = g.deadAir
        ? `${g.lengthSeconds.toFixed(1)} 秒空洞（从 ${g.atSeconds.toFixed(1)} 秒开始）：`
          + '拖进这一段没有画面，播放器会退回到空洞之前那一帧。可以一键修掉'
        : `${g.lengthSeconds.toFixed(1)} 秒缺口（从 ${g.atSeconds.toFixed(1)} 秒开始）：`
          + '只有这条轨断了，另一条轨是连着的 —— 说明那一刻这条轨没抓到画面，'
          + '不是整段停摆。拖进这里同样会退回，但**不能压掉**：压了这条轨的内容会整体前移，音画就对不上了';
      track.problems.push(message);
      report.problems.push(`[${label}] ${message}`);
    }
  }

  const deadAir = withSamples.some((t) => t.gaps.some((g) => g.deadAir));
  const singleTrackOnly = withSamples.some((t) => t.gaps.some((g) => !g.deadAir)) && !deadAir;
  report.repairable = deadAir;
  report.singleTrackGaps = singleTrackOnly;

  const hasFatal = report.problems.some((p) => /未知|moof|没有 stco|只有 1 个关键帧|没有 moov|对不上|空洞/.test(p));
  if (report.problems.length) {
    if (report.repairable) {
      report.verdict = { level: 'bad', text: '❌ 这个文件拖不动 —— 有时间轴空洞，可以一键修掉（原因见下）' };
    } else if (hasFatal) {
      report.verdict = { level: 'bad', text: '❌ 这个文件拖不动（原因见下）' };
    } else {
      report.verdict = { level: 'warn', text: '⚠️ 能播，但拖动体验有问题（原因见下）' };
    }
  }
  return report;
}

/**
 * 把时间轴空洞就地压掉。
 *
 * 做法：把那些"一个样本占了几百秒"的 stts 条目改回常规帧间隔，
 * 然后同步改 mdhd / mvhd / elst 的时长。**字节总长不变**，
 * 所以可以就在原缓冲区上改，也可以拷一份出来改。
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @param {object} [options]
 * @param {number} [options.minGapSeconds] 小于这个长度的间隔不动（默认 1 秒）
 * @returns {{ok:boolean, reason?:string, bytes:Uint8Array, repaired:Array, droppedSeconds:number}}
 */
/**
 * 把时间轴空洞就地压掉。
 *
 * 做法：把那些"一个样本占了几百秒"的 stts 条目改回常规帧间隔，
 * 然后同步改 mdhd / mvhd / elst 的时长。**字节总长不变**，
 * 所以可以就在原缓冲区上改，也可以拷一份出来改。
 *
 * **只压"死气"，不压"单轨缺口"**，理由见下面的注释 —— 这是这个函数里
 * 唯一一个搞错了会毁掉用户视频的决定。
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @param {object} [options]
 * @param {number} [options.minGapSeconds] 小于这个长度的间隔不动（默认 1 秒）
 * @returns {{ok:boolean, reason?:string, bytes:Uint8Array, repaired:Array,
 *            skipped:Array, droppedSeconds:number}}
 */
export function repairTimelineGaps(input, options = {}) {
  const src = input instanceof Uint8Array ? input : new Uint8Array(input);
  const bytes = src.slice();
  const minGapSeconds = options.minGapSeconds ?? 1;

  const top = walkBoxes(bytes, 0, bytes.length);
  const moov = top.find((x) => x.type === 'moov');
  if (!moov) return { ok: false, reason: '文件里没有 moov', bytes, repaired: [], skipped: [], droppedSeconds: 0 };

  const moovKids = walkBoxes(bytes, moov.payloadStart, moov.payloadEnd);
  const mvhdBox = moovKids.find((x) => x.type === 'mvhd');
  const mvhd = mvhdBox ? readMvhd(bytes, mvhdBox) : null;

  /* ---- 第一遍：只侦查，不动手 ---- */
  const tracks = [];
  for (const trak of moovKids.filter((x) => x.type === 'trak')) {
    const hdlr = dig(bytes, trak.payloadStart, trak.payloadEnd, ['mdia', 'hdlr']);
    const mdhdBox = dig(bytes, trak.payloadStart, trak.payloadEnd, ['mdia', 'mdhd']);
    const sttsBox = dig(bytes, trak.payloadStart, trak.payloadEnd, ['mdia', 'minf', 'stbl', 'stts']);
    const elstBox = dig(bytes, trak.payloadStart, trak.payloadEnd, ['edts', 'elst']);
    if (!mdhdBox || !sttsBox) continue;

    const mdhd = readMdhd(bytes, mdhdBox);
    const stts = parseStts(bytes, sttsBox);
    const nominal = nominalDelta(stts);
    if (!nominal) continue;
    const floor = Math.max(nominal * 4, Math.round(mdhd.timescale * minGapSeconds));

    const candidates = [];
    let cursor = 0;
    stts.forEach((e, entryIndex) => {
      const startSeconds = cursor / (mdhd.timescale || 1);
      if (e.delta > floor) {
        candidates.push({
          entryIndex,
          delta: e.delta,
          count: e.count,
          at: sttsBox.payloadStart + 8 + entryIndex * 8,
          startSeconds,
          endSeconds: (cursor + e.delta * e.count) / (mdhd.timescale || 1),
          lengthSeconds: (e.delta * e.count) / (mdhd.timescale || 1),
          // 第一条件目超长是"这条轨开头被拉长"（预热/起播延迟），不是空洞
          leading: entryIndex === 0,
        });
      }
      cursor += e.count * e.delta;
    });

    tracks.push({
      handler: hdlr ? type4(bytes, hdlr.payloadStart + 8) : '????',
      mdhd, mdhdBox, stts, sttsBox, elstBox, nominal, candidates, droppedTicks: 0,
    });
  }

  /* ---- 第二遍：判断哪些缺口是"所有轨一起断"的死气 ---- */
  const TOL = 1.0;
  const withSamples = tracks.filter((t) => t.stts.some((e) => e.count > 0));
  const spanMatches = (a, b) => Math.abs(a.startSeconds - b.startSeconds) <= TOL
    && Math.abs(a.lengthSeconds - b.lengthSeconds) <= TOL;

  const skipped = [];
  for (const t of withSamples) {
    for (const c of t.candidates) {
      if (c.leading) {
        skipped.push({
          handler: t.handler,
          lengthSeconds: c.lengthSeconds,
          reason: '这条轨开头被拉长了，压掉会让它的内容整体前移、和另一条轨错开',
        });
        c.skip = true;
        continue;
      }
      // 只有**每一条有内容的轨**在同一段时间都断了，才说明整条采集停摆过、
      // 这段时间里谁都没有内容 —— 压掉它，各轨的相对关系不变。
      // 只有一条轨断（后台标签页里视频不出帧、音频还在走），压掉就会音画错位。
      const deadAir = withSamples.every((other) => other.candidates.some((x) => !x.leading && spanMatches(x, c)));
      c.skip = !deadAir;
      if (!deadAir) {
        skipped.push({
          handler: t.handler,
          lengthSeconds: c.lengthSeconds,
          atSeconds: c.startSeconds,
          reason: '只有这条轨断了，另一条轨是连着的：压掉会让这条轨的内容整体前移，音画就对不上了',
        });
      }
    }
  }

  /* ---- 第三遍：动手，并且把时长按"扣掉"的方式改回去 ---- */
  const repaired = [];
  let droppedTotal = 0;

  const writeDuration = (version, at, value) => {
    if (version === 1) writeU64(bytes, at, Math.max(0, value));
    else writeU32(bytes, at, Math.max(0, value));
  };

  for (const t of withSamples) {
    for (const c of t.candidates) {
      if (c.skip) continue;
      t.droppedTicks += (c.delta - t.nominal) * c.count;
      writeU32(bytes, c.at + 4, t.nominal);
    }
    if (!t.droppedTicks) continue;

    const droppedSeconds = t.droppedTicks / t.mdhd.timescale;
    droppedTotal = Math.max(droppedTotal, droppedSeconds);

    // ---- 时长一律「扣掉」而不是「重算」 ----
    //
    // 重算会丢掉封装器原本的取整和 elst 空编辑偏移（实测原文件 mvhd=12091ms，
    // 而 stts 之和只有 12000ms，差的 91ms 正是 elst 里那条 mediaTime=-1 的空编辑）。
    // 减法则天然保留这些关系，改完的总时长和原文件严丝合缝。
    if (t.mdhd.duration && t.mdhd.duration !== 0xffffffff) {
      writeDuration(t.mdhd.version, t.mdhd.durationAt, t.mdhd.duration - t.droppedTicks);
    }

    if (t.elstBox && mvhd?.timescale) {
      // segmentDuration 的单位是 mvhd 的 timescale，不是本轨的
      const movieTicks = Math.round(droppedSeconds * mvhd.timescale);
      const version = bytes[t.elstBox.payloadStart];
      for (const entry of parseElst(bytes, t.elstBox)) {
        // mediaTime = -1 是「空编辑」，它表达的是轨起点偏移，跟空洞无关
        if (entry.mediaTime < 0) continue;
        writeDuration(version, entry.at, entry.segmentDuration - movieTicks);
      }
    }

    repaired.push({ handler: t.handler, timescale: t.mdhd.timescale, droppedSeconds });
  }

  if (!repaired.length) {
    const why = skipped.length
      ? `找到了 ${skipped.length} 处缺口，但都不是"整条采集停摆"造成的死气，压掉会让音画错位，所以没动`
      : '没有找到需要修的空洞';
    return { ok: false, reason: why, bytes, repaired: [], skipped, droppedSeconds: 0 };
  }

  if (mvhd && mvhd.timescale && mvhd.duration && mvhd.duration !== 0xffffffff) {
    writeDuration(mvhd.version, mvhd.durationAt, mvhd.duration - Math.round(droppedTotal * mvhd.timescale));
  }

  return { ok: true, bytes, repaired, skipped, droppedSeconds: droppedTotal };
}
