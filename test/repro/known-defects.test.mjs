/**
 * 已知缺陷的**复现用例** —— 现在是红的，红的才对。
 *
 * ## 为什么单独放一层，不并进 `test/*.test.mjs`
 *
 * 这里的每一条断言的都**修好之后**才成立的行为，在当前代码上必然失败。
 * 如果直接塞进主套件，`npm test` 就永远是红的，而"218/218 全绿"这个信号
 * 本身是有价值的（它说明**已验证过的那些东西**没有回归）。
 *
 * 所以：主套件保持绿，这一层专门用来盯住已知缺陷。
 * 跑法：`npm run repro`
 *
 * ## 怎么用
 *
 * · 修好某一条 → 这一条应当变绿。**绿了就把它的用例搬进主套件**（改成正向断言）。
 * · 没修 → 它一直红着，提醒你这几条还开着，而不是靠记忆。
 * · 每条的断言消息里都会打出**实际观测到的错值**，所以 `npm run repro` 的输出
 *   本身就是证据，不需要另外解释。
 *
 * ## 来源
 *
 * 这一层来自 2026-09-24 的一次独立审查（两个只读审计 + 我逐条复核代码）。
 * 编号沿用审查报告：P0 = 换集兜底漏了 WebM 那条路，A# = 解析/合并层的缺陷。
 * 只有 P0-a / A1 / A2 / A3 / A7 是**行为**用例；P0-b / A5 因为涉及的目标函数
 * 没有导出（`finishWebmCapture` / `mseCut` 都在 offscreen.js 里），只能做
 * 结构性检查 —— 那两条我标了「结构性」，别把它们当成行为验证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { groupBuffers, analyzeGroup } from '../../src/parser/mse-assemble.js';
import { mergeFmp4 } from '../../src/parser/mp4-merge.js';
import { demuxWebm, splitWebmInit } from '../../src/parser/webm-demux.js';
import { mergeWebm, webmDurationSeconds } from '../../src/parser/webm-merge.js';
import { fixturePath, ROOT, probe, writeTmp, hasFfprobe } from '../helpers.mjs';

const bytesOf = (...p) => new Uint8Array(readFileSync(fixturePath(...p)));
const readSrc = (rel) => readFileSync(join(ROOT, rel), 'utf8');

function concatBytes(...parts) {
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

/* ------------------------------------------------------------------ *
 * 小工具：读合并产物里的 mvhd / 各条轨的时长
 *
 * 不依赖 ffprobe —— 这条断言要在任何机器上都跑得起来。ffprobe 只做交叉验证。
 * ------------------------------------------------------------------ */

const u32 = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u64 = (b, at) => u32(b, at) * 4294967296 + u32(b, at + 4);

function boxes(bytes, from, to) {
  const out = [];
  let at = from;
  while (at + 8 <= to) {
    let size = u32(bytes, at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    let head = 8;
    if (size === 1) { size = Number(u64(bytes, at + 8)); head = 16; }
    if (size < head || at + size > to) break;
    out.push({ type, payloadStart: at + head, end: at + size });
    at += size;
  }
  return out;
}

function headerSeconds(bytes, box) {
  const version = bytes[box.payloadStart];
  const timescale = version === 1 ? u32(bytes, box.payloadStart + 20) : u32(bytes, box.payloadStart + 12);
  const duration = version === 1 ? u64(bytes, box.payloadStart + 24) : u32(bytes, box.payloadStart + 16);
  return timescale > 0 ? duration / timescale : 0;
}

/** 返回 { movie, tracks }：mvhd 声明的电影时长 + 每条 trak 的 mdhd 时长（秒） */
function readDurations(bytes) {
  const moov = boxes(bytes, 0, bytes.byteLength).find((b) => b.type === 'moov');
  if (!moov) return { movie: null, tracks: [] };
  const kids = boxes(bytes, moov.payloadStart, moov.end);
  const mvhd = kids.find((b) => b.type === 'mvhd');
  const tracks = [];
  for (const trak of kids.filter((b) => b.type === 'trak')) {
    const mdia = boxes(bytes, trak.payloadStart, trak.end).find((b) => b.type === 'mdia');
    if (!mdia) continue;
    const mdhd = boxes(bytes, mdia.payloadStart, mdia.end).find((b) => b.type === 'mdhd');
    if (mdhd) tracks.push(headerSeconds(bytes, mdhd));
  }
  return { movie: mvhd ? headerSeconds(bytes, mvhd) : null, tracks };
}

/** 取一个顶层函数的源码（这些文件里函数都以第 0 列的 `}` 结束） */
function fnBody(src, signature) {
  const at = src.indexOf(signature);
  assert.ok(at > 0, `源码里找不到 ${signature}`);
  const end = src.indexOf('\n}', at);
  return src.slice(at, end < 0 ? src.length : end);
}

/* ------------------------------------------------------------------ *
 * P0：换集兜底漏了 WebM 那条路
 *
 * 用户在 YouTube 上遇到的就是这一型（画面 VP9、音频 Opus → 产物是 .webm）。
 * `cutOnRestart` 只有 fMP4 那条路在用，WebM 这条路把两集的帧按 timeUs
 * 一起排序，同刻帧用 +1 µs 顶开 —— 于是两集**交替插在同一条时间轴上**，
 * 文件还是"成功"产出的。
 * ------------------------------------------------------------------ */

test('P0-a（行为）同页换集：WebM 产物必须只保留第一集', () => {
  const whole = bytesOf('webm-vp9', 'video.webm');
  const track = demuxWebm(whole).tracks[0];
  const first = track.frames;
  assert.ok(first.length > 50, `前提：样本里应当有几十帧，实际 ${first.length}`);

  // 第二集：同一批帧从头再来一遍（换集时时间戳从接近 0 重新开始的真实形态）
  const merged = mergeWebm({
    video: {
      codecId: track.codecId,
      width: track.width,
      height: track.height,
      frames: [...first, ...first],
    },
  });

  // 产物里到底有几帧、有没有两帧挤在同一个时间戳上 —— 这是用户能看到的差别
  const out = demuxWebm(merged).tracks[0];
  const times = out.frames.map((f) => f.timeUs);
  const sameStamp = times.length - new Set(times).size;

  assert.equal(
    out.frames.length, first.length,
    `WebM 这条路没做换集截断：第一集 ${first.length} 帧，产物却有 ${out.frames.length} 帧`
    + `（其中有 ${sameStamp} 帧和别人挤在同一个时间戳上）—— 两集被交错焊在一起了`,
  );
  assert.equal(sameStamp, 0, `产物里有 ${sameStamp} 帧时间戳重复，说明两集是交错写进去的`);
});

test('P0-b（结构性）WebM 捕获那条路必须接上换集兜底', () => {
  const offscreen = readSrc('src/offscreen/offscreen.js');
  const webmMerge = readSrc('src/parser/webm-merge.js');
  const guard = /cutOnRestart|truncateAtTimelineRestart/;

  // 修法两处都行：在 finishWebmCapture 里先截断，或者让 mergeWebm 自己认这个选项
  const inCapturePath = guard.test(fnBody(offscreen, 'function finishWebmCapture('));
  const inMuxer = guard.test(webmMerge);

  assert.ok(
    inCapturePath || inMuxer,
    'WebM 产物那条路（finishWebmCapture / mergeWebm）里找不到任何换集兜底 —— '
    + '而 fMP4 那条路有（mergeFmp4 的 cutOnRestart）。这就是"第一段尾巴和第二段开头混在一起"'
    + '在 .webm 产物上原样复现的原因。',
  );
});

/* ------------------------------------------------------------------ *
 * A1：某一组解析失败时，整条轨（连 init）被静默丢掉
 *
 * analyzeGroup 只在**能一路解析到最后一个字节**时才给出 init/fragments。
 * 有一个洞或者尾巴被截断，它就带着 error 返回，而 missingInit=false、
 * init/fragments 都没有 —— offscreen 的分支链（mpegts / init+fragments /
 * missingInit / …）一个都不匹配，这一组就悄无声息地没了，
 * 连 reuseNotes 和 warnings 里都不会出现。
 * ------------------------------------------------------------------ */

test('A1（行为）解析不出来的组必须"说出来"，不能连 init 一起静默丢掉', () => {
  const mime = 'video/mp4; codecs="av01.0.00M.08"';
  const group = (bytes) => analyzeGroup(groupBuffers([{ seq: 0, mime, bytes }]).groups[0]);

  const healthy = bytesOf('av1-tracks', 'video.m4s');
  const good = group(healthy);
  assert.ok(good.init && good.fragments, '前提：完好的样本应当能拆出 init + 分片');

  // 少 5 个字节（模拟一次 append 丢失/解码失败留下的洞，或尾巴被截断）
  const torn = group(healthy.slice(0, healthy.byteLength - 5));

  // "能不能用"这件事必须有标志能让调用方判断
  const usable = torn.init != null || torn.fragments != null;
  const flagged = torn.missingInit === true;

  assert.ok(
    usable || flagged,
    '这一组解析失败了（error 有值），却既没有 init/fragments，也没有 missingInit 标志 —— '
    + `调用方四个分支一个都不匹配，于是整条轨（连初始化段）被静默丢掉。`
    + `实际：error=${JSON.stringify(torn.error)}｜missingInit=${torn.missingInit}｜`
    + `init=${torn.init}｜fragments=${torn.fragments}`,
  );
});

/* ------------------------------------------------------------------ *
 * A2：WebM 拆包遇到读不出头的元素就**静默截断**后面的全部内容
 *
 * `walk()` 在 `readHeader` 失败时直接 return（生成器结束），调用方分不清
 * "这一层读完了"和"读到一半读不动了"，也不比对已消费位置与声明范围。
 * 于是一个坏掉的分片会让后面的帧全部消失，而 skippedBlocks 仍然是 0、没有警告。
 * ------------------------------------------------------------------ */

test('A2（行为）WebM 拆包读不动时必须报出来，不能静默截断', () => {
  const whole = bytesOf('webm-opus', 'audio.webm');
  const intact = demuxWebm(whole);
  const frames = intact.tracks[0]?.frames?.length ?? 0;
  assert.ok(frames > 100, `前提：样本里应当有上百帧，实际 ${frames}`);

  // 把**第二个** Cluster 的 ID（1F 43 B6 75）抹掉：从这里往后解析不动
  const damaged = Uint8Array.from(whole);
  const id = [0x1f, 0x43, 0xb6, 0x75];
  let seen = 0;
  let target = -1;
  for (let i = 0; i + 4 <= damaged.length; i += 1) {
    if (id.every((b, k) => damaged[i + k] === b)) {
      seen += 1;
      if (seen === 2) { target = i; break; }
    }
  }
  assert.ok(target > 0, '前提：样本里应当能找到至少两个 Cluster');
  damaged[target] = 0x00;

  const broken = demuxWebm(damaged);
  const left = broken.tracks[0]?.frames?.length ?? 0;
  const reported = broken.skippedBlocks > 0
    || (broken.warnings || []).length > 0
    || broken.truncated === true;

  const lostAll = left < frames;
  assert.ok(
    !lostAll || reported,
    `拆包在坏元素处停了：完好时 ${frames} 帧，坏一个 Cluster ID 之后只剩 ${left} 帧`
    + `（丢了 ${frames - left} 帧，${(100 * (frames - left) / frames).toFixed(1)}%），`
    + `而 skippedBlocks=${broken.skippedBlocks}、warnings=${JSON.stringify(broken.warnings || [])}`
    + ' —— 产物短了一截却没有任何提示。',
  );
});

/* ------------------------------------------------------------------ *
 * A3：mvhd 的电影时长被"需要编辑列表的那些轨"里的最大值覆盖
 *
 * applyEditLists 只给 mediaTime !== 0 的轨做 plan，所以 maxTrackDuration
 * 天然漏掉了"起点就在影片原点"的那条轨。然后用它去改 mvhd → 只要另一条轨
 * 比它短（音频晚开始、音频先结束、转码只转了一半），整部片子的时长就被改小。
 * 管理页显示的时长读的就是 mvhd。
 * ------------------------------------------------------------------ */

test('A3（行为）合并产物的 mvhd 时长不能被截短（要覆盖最长的轨）', () => {
  const dash = (n) => bytesOf('dash-split', n);
  const chunksOf = (prefix) => readdirSync(fixturePath('dash-split'))
    .filter((f) => f.startsWith(prefix) && f.endsWith('.m4s'))
    .sort();

  const videoNames = chunksOf('chunk-stream0-');
  const audioNames = chunksOf('chunk-stream1-').slice(0, 1); // 音频只喂第一片（比画面短得多）
  const group = (initName, names, mime) => analyzeGroup(groupBuffers([
    { seq: 0, mime, bytes: dash(initName) },
    ...names.map((n, i) => ({ seq: i + 1, mime, bytes: dash(n) })),
  ]).groups[0]);

  const video = group('init-stream0.m4s', videoNames, 'video/mp4; codecs="avc1.64001e"');
  const audio = group('init-stream1.m4s', audioNames, 'audio/mp4; codecs="mp4a.40.2"');
  assert.ok(video.init && video.fragments, '前提：视频轨能拆出来');
  assert.ok(audio.init && audio.fragments, '前提：音频轨能拆出来');

  const merged = mergeFmp4({
    video: { init: video.init, segments: [video.fragments] },
    audio: { init: audio.init, segments: [audio.fragments] },
  });

  const { movie, tracks } = readDurations(merged);
  const longest = Math.max(...tracks);
  assert.ok(movie != null && tracks.length === 2, `前提：产物应当有一个 mvhd 和两条轨，实际 ${JSON.stringify({ movie, tracks })}`);
  assert.ok(
    movie >= longest - 0.05,
    `mvhd 声明的电影时长比最长的轨还短：mvhd=${movie.toFixed(3)} 秒，`
    + `而轨长分别是 ${tracks.map((t) => t.toFixed(3)).join(' / ')} 秒。`
    + '管理页显示的就是 mvhd，等于把这部片子的时长报小了。',
  );

  if (hasFfprobe()) {
    const info = probe(writeTmp('repro-mvhd.mp4', [merged]));
    const dur = Number(info.format.duration);
    assert.ok(
      dur >= longest - 0.1,
      `ffprobe 的 format.duration 也读的是 mvhd：报 ${dur.toFixed(3)} 秒，实际最长轨 ${longest.toFixed(3)} 秒`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * A5：切段/收尾进行中到达的分片，会被"清空缓冲"一起清掉
 *
 * mseCut 里 `await safeAssemble` 和写盘可能要几十秒（音频是 Opus 时要整条转码），
 * 而 mseBuffer 照旧往 s.items 里塞；随后 `s.items = []` 把这段时间到达的**一起清掉**，
 * 不警告。mseStop 那条路同样。
 *
 * 为什么是结构性检查：`mseCut` / `mseBuffer` 都在 offscreen.js 里、没有导出，
 * Node 里跑不起来（它顶层就调 chrome.* API）。真正的行为用例需要先把会话逻辑
 * 抽出来，或者给 chrome 打桩 —— 那是修复时一起做的事。
 * ------------------------------------------------------------------ */

test('A5（结构性）切段期间到达的分片不能被无提示清掉', () => {
  const src = readSrc('src/offscreen/offscreen.js');
  const bufferFn = fnBody(src, 'function mseBuffer(');
  const cutFn = fnBody(src, 'async function mseCut(');

  // 修法两种都行：① 切段期间 mseBuffer 拒绝收（或转存到下一段）；
  //                ② 清空时只删"已经进了这一份产物"的那些（按 seq 过滤 / splice 掉已装配的）
  // 注意别写成宽泛的 /snapshot/ —— mseCut 里有个 `dropAutoSnapshot()`，那样会假绿。
  const refusesWhileCutting = /autoCut\?\.cutting|s\.cutting|assembling|inFlight/.test(bufferFn);
  const clearsOnlyAssembled = /s\.items\s*=\s*s\.items\.filter\(|items\.splice\(|lastAssembled/.test(cutFn);

  assert.ok(
    refusesWhileCutting || clearsOnlyAssembled,
    'mseCut 在 await 组装/写盘之后直接 `s.items = []` 清空，而 mseBuffer 无条件 push —— '
    + '这段时间到达的分片既不在这一份产物里，也不会留给下一份，而且没有任何提示。'
    + `实际：mseBuffer 里没有"正在切段"的判断（${refusesWhileCutting}），`
    + `mseCut 里也没有按 seq 保留（${clearsOnlyAssembled}）。`,
  );
});

/* ------------------------------------------------------------------ *
 * A7：中途开始抓的 .webm，时长会虚高成"源流时间轴的长度"
 *
 * mergeWebm 把整体减掉最早起点（shift），但 webmDurationSeconds 用的是
 * **没减过的** timeUs。抓流从 3600 秒处开始抓时，产物只有 6 秒，
 * 管理页却显示 3606 秒。
 * ------------------------------------------------------------------ */

test('A7（行为）WebM 产物时长必须扣掉起点偏移', () => {
  const track = demuxWebm(bytesOf('webm-vp9', 'video.webm')).tracks[0];
  const shiftUs = 3600 * 1e6; // 抓流是从第 3600 秒开始的
  const frames = track.frames.map((f) => ({ ...f, timeUs: f.timeUs + shiftUs }));

  const merged = mergeWebm({
    video: { codecId: track.codecId, width: track.width, height: track.height, frames },
  });
  const reported = webmDurationSeconds([{ frames }]);

  // 产物真实长度 = 最后一帧结束 - 最早一帧开始（mergeWebm 自己就是这么对齐的）
  const first = Math.min(...frames.map((f) => f.timeUs));
  const end = Math.max(...frames.map((f) => f.timeUs + (f.durationUs || 0)));
  const truth = (end - first) / 1e6;

  assert.ok(merged.byteLength > 0, '前提：产物非空');
  assert.ok(
    Math.abs(reported - truth) < 0.1,
    `产物实际只有 ${truth.toFixed(3)} 秒，webmDurationSeconds 却报 ${reported.toFixed(3)} 秒`
    + `（差了 ${(reported - truth).toFixed(1)} 秒 = 起点偏移没扣掉）—— `
    + '这个数会写进产物索引，管理页就照着它显示时长。',
  );
});

/* ------------------------------------------------------------------ *
 * P1：播放器在**同一条 SourceBuffer 里重发 init** 时，后面的内容凭空消失
 *
 * 现场怎么发生的（用户 2026-09-24 的真实产物）：锁定 4K、没换过清晰度，但 MSE
 * 本来就允许 `changeType()` + 再 append 一份 init 来重新初始化**同一条** SourceBuffer ——
 * 拖进度、重新预取、码率自适应都会这么干。于是这条流变成「init + clusters + init + clusters」。
 *
 * `walk()` 读到第二份 init 的元素就读不动了，直接 return；调用方分不清"读完了"和
 * "读不动了"，于是第二份之后的内容整段丢弃 —— 而 skippedBlocks=0、warnings=[]、
 * analyzeGroup 的 error=null，**上层完全看不出异常**。
 *
 * 用户那两个真实产物就是这个形状：视频停在 23.2 秒（= 第二份 init 的位置），
 * 音频完整（音频那条 SourceBuffer 没被重新初始化），缓冲 302 MB 只写出 32 MB。
 * ------------------------------------------------------------------ */

test('P1（行为）中途重发 init 时，后面的内容不能凭空消失', () => {
  const whole = bytesOf('webm-vp9', 'video.webm');
  const { init, media } = splitWebmInit(whole);
  assert.ok(init.byteLength > 0 && media.byteLength > 0, '前提：样本能拆出 init 和媒体段');

  const single = demuxWebm(whole).tracks[0].frames.length;
  assert.ok(single > 50, `前提：单份样本应当有几十帧，实际 ${single}`);

  // 播放器在同一个 SourceBuffer 里又发了一次 init（重新初始化）
  const stream = concatBytes(init, media, init, media);
  const d = demuxWebm(stream);
  const frames = d.tracks[0]?.frames?.length ?? 0;
  const reported = (d.warnings || []).length > 0 || d.skippedBlocks > 0;

  assert.ok(
    frames >= single * 2 || reported,
    `同一份数据进来两遍（第二遍带自己的 init），拆包只给出 ${frames} 帧（单份是 ${single} 帧）`
    + ' —— 第二份之后的内容整段没了，'
    + `而 skippedBlocks=${d.skippedBlocks}、warnings=${JSON.stringify(d.warnings || [])}、`
    + 'analyzeGroup 那边 error 也是 null，**上层没有任何线索**。'
    + '真实后果：定档 4K 抓 12 分钟，产物里画面只有开头 23 秒，其余全是音频。',
  );
});

/* ------------------------------------------------------------------ *
 * P1-b：和现场一模一样的形态 —— 前半段 + **变过的** init + 后半段
 *
 * 为什么必须"变过"：抓流那一侧的指纹去重会把**逐字节相同**的重复 append 挡掉
 * （这是对的行为），那样根本走不到拆包器，用例就白验了。真实站点上换码率/换编码时，
 * 新的初始化段本来就变了（分辨率、编码配置都变），它躲过去重、才被那个过期的
 * `Segment` 长度吞掉。这里用 EBML 的 Void 元素做填充：规范允许、解析器忽略、字节变了。
 *
 * 期望：**6 个 Cluster 的内容全在**（150 帧）；修复前只有前半段（75 帧）。
 * ------------------------------------------------------------------ */

test('P1-b（行为）真实形态：前半段 + 变过的 init + 后半段，内容一个不少', () => {  const init = bytesOf('webm-vp9', 'video-init.webm');
  const clusters = bytesOf('webm-vp9', 'video-clusters.webm');

  // 按 EBML 长度字段在**某个 Cluster 边界**上切（不猜字节）
  const readVint = (b, at) => {
    const first = b[at];
    if (!first) return null;
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len += 1;
    if (len > 8 || at + len > b.length) return null;
    let value = first & (0xff >> len);
    for (let i = 1; i < len; i += 1) value = value * 256 + b[at + i];
    return { len, value };
  };
  const starts = [];
  let at = 0;
  while (at + 2 <= clusters.length) {
    const id = readVint(clusters, at);
    if (!id) break;
    const size = readVint(clusters, at + id.len);
    if (!size) break;
    const end = at + id.len + size.len + size.value;
    if (end > clusters.length) break;
    starts.push(at);
    at = end;
  }
  assert.ok(starts.length >= 2, `前提：样本里应当有多个 Cluster，实际 ${starts.length}`);
  const cut = starts[Math.floor(starts.length / 2)];
  const half1 = clusters.slice(0, cut);
  const half2 = clusters.slice(cut);

  // 变了的那份 init（Void 填充：合法的 EBML，解析器会忽略）
  const reinit = new Uint8Array(init.length + 3);
  reinit.set(init, 0);
  reinit.set([0xec, 0x81, 0x00], init.length);

  const whole = demuxWebm(concatBytes(init, clusters)).tracks[0].frames.length;
  const half = demuxWebm(concatBytes(init, half1)).tracks[0].frames.length;
  const d = demuxWebm(concatBytes(init, half1, reinit, half2));
  const frames = d.tracks[0]?.frames?.length ?? 0;

  assert.ok(
    frames >= whole - 2,
    `现场的形态（前半段 + 变过的 init + 后半段）只解出 ${frames} 帧：`
    + `整段是 ${whole} 帧、只算前半段是 ${half} 帧 —— 说明重新 init 之后的内容被静默丢掉了。`
    + `（warnings=${JSON.stringify(d.warnings || [])}）`,
  );
  assert.ok(
    (d.warnings || []).some((w) => /初始化段/.test(w)),
    '中途真的重新初始化过时，产物提示里应当写一句（不能静默）',
  );
});

/* ------------------------------------------------------------------ *
 * P2：字节流错位之后，**剩下的 Cluster 要救回来**
 *
 * 用户 2026-09-24 第二次报的（"拖完只有声音没有画面"）。产物提示原文：
 *
 *   读到第 3 个 Cluster 之后读不动了（还剩 175780230 字节没读）：
 *   这一段后面的内容没有进产物，这一份可能少了一截
 *
 * 也就是说：视频那组字节流从错位点开始解析失败，**后面 175 MB 全被丢掉**，
 * 而音频那条流是好的 —— 于是"声音全、画面只有前 17 秒"。
 *
 * 但那些字节大部分是好的：Cluster 自包含，找到下一个 Cluster 起点就能接着读。
 * 这里在**某个 Cluster 内部**删掉 40 字节来造错位（等价于某一段 append 丢了或重叠了）。
 * 实测：完好 150 帧；修复前只剩 25 帧且**零警告**（连"读不动"都没报，因为错位点读到的
 * 是个"看起来合法、长度超大"的元素，把后面一口吞了）；修复后救回 100 帧，并明确报出
 * 「有 1 处字节流对不齐（共跳过 N 字节）」。
 * ------------------------------------------------------------------ */

test('P2（行为）字节流错位之后，剩下的 Cluster 要救回来', () => {
  const init = bytesOf('webm-vp9', 'video-init.webm');
  const clusters = bytesOf('webm-vp9', 'video-clusters.webm');
  const whole = demuxWebm(concatBytes(init, clusters)).tracks[0].frames.length;
  assert.ok(whole > 50, `前提：完好样本应当有几十帧，实际 ${whole}`);

  // 按 EBML 长度字段找 Cluster 边界，在**第 2 个 Cluster 内部**删掉 40 字节
  const readVint = (b, at) => {
    const first = b[at];
    if (!first) return null;
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len += 1;
    if (len > 8 || at + len > b.length) return null;
    let value = first & (0xff >> len);
    for (let i = 1; i < len; i += 1) value = value * 256 + b[at + i];
    return { len, value };
  };
  const starts = [];
  let at = 0;
  while (at + 2 <= clusters.length) {
    const id = readVint(clusters, at);
    if (!id) break;
    const size = readVint(clusters, at + id.len);
    if (!size) break;
    const end = at + id.len + size.len + size.value;
    if (end > clusters.length) break;
    starts.push(at);
    at = end;
  }
  assert.ok(starts.length >= 4, `前提：样本里应当有多个 Cluster，实际 ${starts.length}`);

  const cut = starts[1] + 10;
  const damaged = concatBytes(clusters.slice(0, cut), clusters.slice(cut + 40));
  const d = demuxWebm(concatBytes(init, damaged));
  const frames = d.tracks[0]?.frames?.length ?? 0;

  assert.ok(
    frames >= whole * 0.4,
    `字节流在第 2 个 Cluster 里错位之后，只解出 ${frames} 帧（完好时 ${whole} 帧）——`
    + '说明错位点后面那些**本来是好的** Cluster 被整段丢掉了。'
    + `（用户现场丢的是 175 MB 画面，产物只剩前 17 秒）warnings=${JSON.stringify(d.warnings || [])}`,
  );
  assert.ok(
    (d.warnings || []).some((w) => /对不齐|跳过/.test(w)),
    '发生过重新对齐时，产物提示里必须写一句（不能静默）',
  );
});
