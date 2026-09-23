/**
 * 「拖不动进度条」这两条路的测试。
 *
 * 这里刻意用了**往返验证**：先拿一个真实 MP4（fixtures/source.mp4），
 * 人为往它的 stts 里塞一个 300 秒的空洞，确认体检能认出来；
 * 再跑修复，断言产物**和原文件逐字节相同**。
 *
 * 为什么要这么严：修复是就地改元数据，一旦哪个字段没同步（mvhd / mdhd / elst），
 * 出来的就是"看着对、播放器读着别扭"的文件 —— 那正是这个 bug 最初的形态。
 * 逐字节比对是唯一能证明"除了那个空洞，什么都没动"的判据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  inspectSeekability, repairTimelineGaps, walkBoxes, readMovieDurationSeconds,
} from '../src/parser/seek-check.js';
import { createTimelineCompressor } from '../src/offscreen/pipeline.js';
import { mergeFmp4 } from '../src/parser/mp4-merge.js';
import { finalizeCaptureBytes } from '../src/parser/mse-assemble.js';
import { captureFileName } from '../src/core/capture-limits.js';
import {
  fixturePath, readFixtureBytes, TMP, ensureTmp, hasFfprobe, probe, videoStream,
} from './helpers.mjs';

const source = () => new Uint8Array(readFileSync(fixturePath('source.mp4')));
/** 帧间隔本来就不均匀的小素材：stts 是 `101×512 | 1×1536 | 96×512` */
const holed = () => new Uint8Array(readFileSync(fixturePath('seek-holed', 'source.mp4')));

/* ------------------------------------------------------------------ *
 * 小工具（只在测试里用）
 * ------------------------------------------------------------------ */

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
function setU32(b, o, v) {
  b[o] = (v >>> 24) & 0xff; b[o + 1] = (v >>> 16) & 0xff; b[o + 2] = (v >>> 8) & 0xff; b[o + 3] = v & 0xff;
}

function concat(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function box(type, payload) {
  const out = new Uint8Array(8 + payload.length);
  setU32(out, 0, out.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

/** 从任意 box 出发按路径往下找（测试自己用，不进产品代码） */
function digFrom(b, box_, path) {
  let hit = box_;
  let kids = walkBoxes(b, box_.payloadStart, box_.payloadEnd);
  for (const type of path) {
    hit = kids.find((x) => x.type === type) || null;
    if (!hit) return null;
    kids = walkBoxes(b, hit.payloadStart, hit.payloadEnd);
  }
  return hit;
}

/**
 * 把视频轨 stts 里那条"只有 1 个样本"的条目撑大 —— 就是录制被切后台时
 * 留下的形状（一个样本占了几百秒）。
 *
 * 之所以能用这种"原地改一个 u32"的方式注入：seek-holed 素材的 stts 本来就有
 * 一条 count=1 的条目，所以 box 长度不变、stco 偏移不用重算、mdat 一个字节不动。
 * 这样测试才能顺带断言「除了时长字段，文件其余部分逐字节没变」。
 */
function injectHole(bytes, seconds = 300) {
  const b = bytes.slice();
  const moov = walkBoxes(b, 0, b.length).find((x) => x.type === 'moov');
  const traks = walkBoxes(b, moov.payloadStart, moov.payloadEnd).filter((x) => x.type === 'trak');

  let trak = null;
  let stts = null;
  let timescale = 0;
  for (const t of traks) {
    const s = digFrom(b, t, ['mdia', 'minf', 'stbl', 'stts']);
    if (!s) continue;
    const hdlr = digFrom(b, t, ['mdia', 'hdlr']);
    if (!hdlr || String.fromCharCode(b[hdlr.payloadStart + 8], b[hdlr.payloadStart + 9], b[hdlr.payloadStart + 10], b[hdlr.payloadStart + 11]) !== 'vide') continue;
    trak = t;
    stts = s;
    timescale = u32(b, digFrom(b, t, ['mdia', 'mdhd']).payloadStart + 12);
    break;
  }
  assert.ok(stts, '素材里没有找到视频轨的 stts');

  const n = u32(b, stts.payloadStart + 4);
  let entryAt = -1;
  for (let i = 0; i < n; i += 1) {
    const at = stts.payloadStart + 8 + i * 8;
    if (u32(b, at) === 1) { entryAt = at; break; }
  }
  assert.ok(entryAt >= 0, '素材的 stts 里没有 count=1 的条目，注入会改变 box 长度');

  const addedTicks = Math.round(seconds * timescale);
  setU32(b, entryAt + 4, u32(b, entryAt + 4) + addedTicks);

  const moovKids = walkBoxes(b, moov.payloadStart, moov.payloadEnd);
  const mvhd = moovKids.find((x) => x.type === 'mvhd');
  const mvhdTimescale = u32(b, mvhd.payloadStart + 12);
  const addedMovie = Math.round(seconds * mvhdTimescale);
  const mdhd = digFrom(b, trak, ['mdia', 'mdhd']);
  setU32(b, mdhd.payloadStart + 16, u32(b, mdhd.payloadStart + 16) + addedTicks);
  setU32(b, mvhd.payloadStart + 16, u32(b, mvhd.payloadStart + 16) + addedMovie);
  const elst = digFrom(b, trak, ['edts', 'elst']);
  if (elst) {
    // 注意：不能写死 entry 的下标或字节偏移。这个素材的 elst 只有 1 条
    // （`dur=8000 mediaTime=1024`），写 `payloadStart + 20` 会**写到 box 外面**，
    // 把紧跟其后的 mdia 的 size 字段打坏 —— 然后整个 stbl 都找不到了。
    // 第一次就是这么错的，症状是"注入完却没有空洞"。
    const version = b[elst.payloadStart];
    assert.equal(version, 0, '这条素材的 elst 应该是 v0，注入逻辑只处理 v0');
    const count = u32(b, elst.payloadStart + 4);
    for (let i = 0; i < count; i += 1) {
      const at = elst.payloadStart + 8 + i * 12;
      // mediaTime = -1 是空编辑，跟时长无关，不该动
      if ((u32(b, at + 4) | 0) < 0) continue;
      setU32(b, at, u32(b, at) + addedMovie);
      break;
    }
  }
  return b;
}

/* ------------------------------------------------------------------ *
 * 体检
 * ------------------------------------------------------------------ */

test('体检：正常 MP4 判定为可以拖', () => {
  const r = inspectSeekability(source());
  assert.equal(r.verdict.level, 'ok', r.problems.join('；'));
  assert.equal(r.moofCount, 0);
  assert.equal(r.mvhd.unknown, false);
  const video = r.tracks.find((t) => t.handler === 'vide');
  assert.ok(video, '应该认出视频轨');
  assert.ok(video.keyframes > 1, `关键帧应该不止一个，实际 ${video.keyframes}`);
  assert.equal(video.gaps.length, 0);
});

test('体检：注入空洞后能认出来，并说清是第几秒断的', () => {
  const broken = injectHole(holed(), 300);
  const r = inspectSeekability(broken);
  assert.notEqual(r.verdict.level, 'ok');
  const video = r.tracks.find((t) => t.handler === 'vide');
  assert.equal(video.gaps.length, 1, `应该报出一个空洞，实际 ${video.gaps.length}`);
  assert.ok(video.gaps[0].lengthSeconds > 299 && video.gaps[0].lengthSeconds < 301,
    `空洞长度应该约 300 秒，实际 ${video.gaps[0].lengthSeconds}`);
  assert.ok(
    r.problems.some((p) => /空洞/.test(p)),
    `problems 里应该有空洞说明，实际：${r.problems.join('；')}`,
  );
});

test('体检：帧间隔不均匀（但没有空洞）的文件不该误报', () => {
  const r = inspectSeekability(holed());
  const video = r.tracks.find((t) => t.handler === 'vide');
  assert.equal(video.gaps.length, 0, `不该把 3 倍帧间隔当成空洞：${JSON.stringify(video.gaps)}`);
  assert.equal(r.verdict.level, 'ok', r.problems.join('；'));
});

test('体检：分片式 MP4（只有 moof、时长未知）判定为拖不动', () => {
  const ftyp = box('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]));
  const mvhdPayload = new Uint8Array(100);
  setU32(mvhdPayload, 12, 1000);
  setU32(mvhdPayload, 16, 0xffffffff);
  const moov = box('moov', concat([box('mvhd', mvhdPayload), box('mvex', new Uint8Array(8))]));
  const r = inspectSeekability(concat([ftyp, moov, box('moof', new Uint8Array(8))]));
  assert.equal(r.mvhd.unknown, true);
  assert.equal(r.moofCount, 1);
  assert.equal(r.verdict.level, 'bad');
  assert.ok(r.problems.some((p) => /分片式/.test(p)), r.problems.join('；'));
});

/* ------------------------------------------------------------------ *
 * 修复
 * ------------------------------------------------------------------ */

test('修复：空洞被去掉，时长回到原值，且媒体数据一个字节没动', () => {
  const original = holed();
  const broken = injectHole(original, 300);
  assert.equal(broken.length, original.length, '注入空洞不该改变文件长度（这就是用这份素材的原因）');

  const fixed = repairTimelineGaps(broken);
  assert.equal(fixed.ok, true, fixed.reason);
  assert.ok(fixed.droppedSeconds > 299 && fixed.droppedSeconds < 301,
    `压缩掉的时长应该是 300 秒左右，实际 ${fixed.droppedSeconds}`);
  assert.equal(fixed.bytes.length, original.length, '修复同样不该改变文件长度');

  // ---- 逐段比对：media 数据、样本大小、关键帧索引、chunk 偏移都必须原封不动 ----
  // 注意 walkBoxes 给的是 {start, size, payloadStart, payloadEnd}，**没有 end 字段**。
  // 写 `b.slice(mdat.start, mdat.end)` 会静默退化成"切到文件末尾"，
  // 于是连 moov 一起比进来 —— 第一次就是这么误报 mdat 不同的。
  const boxesOf = (b) => {
    const top = walkBoxes(b, 0, b.length);
    const moov = top.find((x) => x.type === 'moov');
    const mdat = top.find((x) => x.type === 'mdat');
    const out = { mdat: b.slice(mdat.start, mdat.start + mdat.size) };
    for (const t of walkBoxes(b, moov.payloadStart, moov.payloadEnd).filter((x) => x.type === 'trak')) {
      const stbl = digFrom(b, t, ['mdia', 'minf', 'stbl']);
      const hdlr = digFrom(b, t, ['mdia', 'hdlr']);
      const kind = String.fromCharCode(b[hdlr.payloadStart + 8], b[hdlr.payloadStart + 9], b[hdlr.payloadStart + 10], b[hdlr.payloadStart + 11]);
      const kids = walkBoxes(b, stbl.payloadStart, stbl.payloadEnd);
      for (const type of ['stsz', 'stss', 'stco', 'stsc', 'stsd']) {
        const box_ = kids.find((x) => x.type === type);
        if (box_) out[`${kind}.${type}`] = b.slice(box_.start, box_.payloadEnd);
      }
    }
    return out;
  };
  const before = boxesOf(original);
  const after = boxesOf(fixed.bytes);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  for (const key of Object.keys(before)) {
    assert.deepEqual(
      Array.from(after[key]), Array.from(before[key]),
      `${key} 应该和原文件逐字节相同（修复只该动时长字段）`,
    );
  }

  // ---- 时长字段：轨头与样本表回到原值附近，总时长也回到原值附近 ----
  //
  // 为什么是"附近"而不是"严格相等"：注入用的那条 stts 条目原本是 1536 tick
  // （3 倍帧间隔，8.00 秒那条素材本来就不均匀），修复会把它归一到众数 512 ——
  // 也就是会顺带吃掉 1024 tick（80 毫秒）。这是修复该有的行为（它按"常规帧间隔"
  // 重建时间轴），只是这份素材把"不规则间隔"和"空洞"叠在同一个条目上了。
  const a = inspectSeekability(original);
  const c = inspectSeekability(fixed.bytes);
  const av = a.tracks.find((t) => t.handler === 'vide');
  const cv = c.tracks.find((t) => t.handler === 'vide');
  assert.ok(Math.abs(cv.seconds - av.seconds) < 0.2,
    `样本表之和应该回到原值附近：${cv.seconds} vs ${av.seconds}`);
  assert.ok(Math.abs(cv.declaredSeconds - av.declaredSeconds) < 0.2,
    `轨头声明时长应该回到原值附近：${cv.declaredSeconds} vs ${av.declaredSeconds}`);
  assert.ok(Math.abs(c.mvhd.seconds - a.mvhd.seconds) < 0.2,
    `总时长应该回到原值附近：${c.mvhd.seconds} vs ${a.mvhd.seconds}`);
  assert.equal(c.verdict.level, 'ok', c.problems.join('；'));
});

test('修复：本来就没空洞的文件会如实说"没什么可修的"，而不是产出坏文件', () => {
  const r = repairTimelineGaps(holed());
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有找到/);
});

test('修复：修完的文件 ffprobe 仍然认得，时长回到原值', { skip: !hasFfprobe() }, () => {
  ensureTmp();
  const broken = injectHole(holed(), 300);
  const brokenFile = join(TMP, 'seek-check-broken.mp4');
  writeFileSync(brokenFile, broken);

  // 修之前 ffprobe 看到的是"多出 5 分钟"的时长 —— 这就是用户看到的现象
  const brokenDuration = Number(probe(brokenFile).format.duration);
  assert.ok(brokenDuration > 290, `注入后时长应该被撑到 300 秒以上，实际 ${brokenDuration}`);

  const fixed = repairTimelineGaps(broken);
  assert.equal(fixed.ok, true);
  const file = join(TMP, 'seek-check-repaired.mp4');
  writeFileSync(file, fixed.bytes);

  const info = probe(file);
  assert.ok(videoStream(info), '修复后应该还有视频轨');
  const duration = Number(info.format.duration);
  const original = probe(fixturePath('seek-holed', 'source.mp4'));
  assert.ok(Math.abs(duration - Number(original.format.duration)) < 0.5,
    `修复后时长应该和原文件一致：${duration} vs ${original.format.duration}`);
});

/* ------------------------------------------------------------------ *
 * 录制防空洞：时间轴压缩器
 *
 * 判据是**墙钟空档**（所有轨都没有输出超过阈值），不是另一条轨的媒体时间戳 ——
 * 后者受编码器队列积压影响，曾经把"音频停摆"误判成"整条采集停了"，
 * 结果是 mp4-muxer 硬报错（Timestamps must be monotonically increasing）。
 * 所以这里的测试要带一个**假时钟**：同步代码里没有真实时间流逝。
 * ------------------------------------------------------------------ */

function makeClock(startMs = 0) {
  let t = startMs;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('压洞器：没有停摆时原样通过', () => {
  const clock = makeClock();
  const c = createTimelineCompressor({ now: clock.now });
  assert.equal(c.adjust('video', 1_000_000, 33_333), 1_000_000); clock.advance(33);
  assert.equal(c.adjust('video', 1_033_333, 33_333), 1_033_333); clock.advance(33);
  assert.equal(c.adjust('video', 1_066_666, 33_333), 1_066_666);
  assert.equal(c.stalledUs, 0);
  assert.equal(c.count, 0);
  assert.equal(c.clamps, 0);
  assert.equal(c.backSteps, 0);
});

test('压洞器：10 秒的采集停摆被压掉，之后的帧接着上一帧走', () => {
  const clock = makeClock();
  const c = createTimelineCompressor({ gapUs: 1_500_000, now: clock.now });
  c.adjust('video', 0, 33_333); clock.advance(33);
  c.adjust('video', 33_333, 33_333); clock.advance(33);
  clock.advance(10_000); // 这 10 秒里一条轨都没有输出 = 整条采集停了
  const after = c.adjust('video', 10_033_333, 33_333);
  assert.equal(after, 66_666, '恢复后的第一帧应该紧接在上一帧之后');
  assert.ok(Math.abs(c.stalledUs - (10_000_000 - 33_333)) < 1000,
    `压缩掉的时长应该约 10 秒，实际 ${c.stalledUs / 1e6}`);
  assert.equal(c.count, 1);
  clock.advance(33);
  assert.equal(c.adjust('video', 10_066_666, 33_333), 99_999, '后面的帧跟着平移，不再跳');
  assert.equal(c.clamps, 0);
});

test('压洞器：只有视频停、音频还在走时不动它（否则音画会错位）', () => {
  const clock = makeClock();
  const c = createTimelineCompressor({ gapUs: 1_500_000, now: clock.now });
  // 音频一路走到 8 秒：这段时间里采集并没有停，只是视频轨没出帧。
  for (let t = 0; t < 8_000_000; t += 21_333) { c.adjust('audio', t, 21_333); clock.advance(21); }
  const videoResume = c.adjust('video', 8_000_000, 33_333);
  assert.equal(c.stalledUs, 0, '音频在走的时候不该压缩视频');
  assert.equal(videoResume, 8_000_000, '视频时间戳原样保留（那一段本来就该缺）');
});

test('压洞器：音频停摆、视频只是输出落后 —— 绝不能把视频的时间戳拉回去', () => {
  // ⚠️ 这条钉的是用户真实撞到的那句硬报错：
  //     Error: Timestamps must be monotonically increasing
  //     (DTS went from 4928000 to 3499590)
  //
  // 成因：音频停摆时，旧判据回头看**视频最新的媒体时间戳**够不够"覆盖"这段窗口。
  // 而视频编码器有队列积压（实测音频能积 800 毫秒、视频 200 毫秒，慢的时候差得更远），
  // 它的输出本来就落后 —— 于是被判成"整条采集停了"，按音频的时间轴压了一刀；
  // 视频随后送进来的帧减去这个位移，就成了更早的时间戳，**整场录制作废**。
  //
  // 现在判据是墙钟：视频一直在出帧就说明采集没停，一个字都不压。
  const clock = makeClock();
  const c = createTimelineCompressor({ gapUs: 1_500_000, now: clock.now });
  const videoAdjusted = [];

  // 音频：每 20 毫秒一个包
  let audioMedia = 0;
  const feedAudio = () => { audioMedia += 20_000; c.adjust('audio', audioMedia, 20_000); };
  // 视频：编码器慢 —— 出帧频率只有音频的 1/8，时间戳还落后 2.5 秒
  let videoMedia = 2_500_000;
  const feedVideo = () => { videoAdjusted.push(c.adjust('video', videoMedia, 33_333)); videoMedia += 33_333; };

  // 前 5 秒：音频一直在出，视频慢但也在出
  for (let i = 0; i < 250; i += 1) {
    clock.advance(20);
    feedAudio();
    if (i % 8 === 0) feedVideo();
  }
  // 音频停摆 2.5 秒：这期间**只有视频在出帧**（所以整条采集没有停）
  for (let ms = 0; ms < 2500; ms += 20) {
    clock.advance(20);
    if (ms % 500 === 0) feedVideo();
  }
  // 音频恢复：它的媒体时间往前跳了 2.5 秒
  clock.advance(20);
  audioMedia += 2_500_000;
  c.adjust('audio', audioMedia, 20_000);
  const afterResume = c.adjust('video', videoMedia, 33_333);
  videoAdjusted.push(afterResume); videoMedia += 33_333;

  assert.equal(c.stalledUs, 0,
    `视频一直在出帧，就该一个字都不压（实际压了 ${c.stalledUs / 1000} 毫秒）`);
  assert.equal(c.backSteps, 0, '不该出现"时间戳被拉回去"的情况');
  for (let i = 1; i < videoAdjusted.length; i += 1) {
    assert.ok(videoAdjusted[i] >= videoAdjusted[i - 1],
      `视频时间戳必须单调不减：第 ${i} 个从 ${videoAdjusted[i - 1]} 变成了 ${videoAdjusted[i]}`);
  }
});

test('压洞器：两条轨各自输出进度不同（音频队列更长）不该被误判成停摆', () => {
  // 真实浏览器里炸过一次的形状：音频已经写到 3 秒，视频才写到 1 秒。
  // 共用 frontier 的早期版本会把视频的正常补帧当成"跳了 2 秒"而压一刀，
  // 结果视频队列里时间戳更早的帧算出负时间戳，封装器直接抛错、整段录制全废。
  const clock = makeClock();
  const c = createTimelineCompressor({ gapUs: 1_500_000, now: clock.now });
  for (let t = 0; t < 3_000_000; t += 21_333) { c.adjust('audio', t, 21_333); clock.advance(21); }
  for (let t = 0; t < 1_000_000; t += 33_333) { c.adjust('video', t, 33_333); clock.advance(33); }
  // 视频继续正常补到 3 秒 —— 每一跳都只有 33 毫秒
  const out = [];
  for (let t = 1_000_000; t <= 3_000_000; t += 33_333) { out.push(c.adjust('video', t, 33_333)); clock.advance(33); }
  assert.equal(c.stalledUs, 0, `不该压任何东西，实际压了 ${c.stalledUs / 1000} 毫秒`);
  assert.equal(c.clamps, 0, '不该出现负时间戳');
  assert.equal(c.backSteps, 0, '不该出现时间戳回退');
  for (const v of out) assert.ok(v >= 0, `时间戳不能是负数：${v}`);
});

test('压洞器：1.5 秒以内的抖动不当作停摆', () => {
  const clock = makeClock();
  const c = createTimelineCompressor({ now: clock.now });
  c.adjust('video', 0, 33_333);
  clock.advance(1000);
  assert.equal(c.adjust('video', 1_000_000, 33_333), 1_000_000);
  assert.equal(c.stalledUs, 0);
});

test('压洞器：两次停摆各自被压掉，时间轴始终单调', () => {
  const clock = makeClock();
  const c = createTimelineCompressor({ gapUs: 1_500_000, now: clock.now });
  const out = [];
  for (const t of [0, 33_333]) { out.push(c.adjust('video', t, 33_333)); clock.advance(33); }
  clock.advance(5_000); out.push(c.adjust('video', 5_000_000, 33_333)); clock.advance(33);
  out.push(c.adjust('video', 5_033_333, 33_333)); clock.advance(33);
  clock.advance(4_000); out.push(c.adjust('video', 9_000_000, 33_333)); clock.advance(33);
  out.push(c.adjust('video', 9_033_333, 33_333));
  assert.equal(c.count, 2);
  for (let i = 1; i < out.length; i += 1) {
    assert.ok(out[i] > out[i - 1], `时间戳必须单调递增：${out.join(',')}`);
  }
  assert.equal(out[0], 0);
});

test('压洞器：两条轨一起停摆时位移量一致，音画仍然对齐', () => {
  const clock = makeClock();
  const c = createTimelineCompressor({ gapUs: 1_500_000, now: clock.now });
  // 两条轨都走到 4 秒
  for (let t = 0; t <= 4_000_000; t += 40_000) { c.adjust('video', t, 40_000); clock.advance(20); }
  for (let t = 0; t <= 4_000_000; t += 21_333) { c.adjust('audio', t, 21_333); clock.advance(20); }
  // 然后一起停 20 秒（没有任何输出），再一起恢复
  clock.advance(20_000);
  const v = c.adjust('video', 24_000_000, 40_000);
  clock.advance(20);
  const a = c.adjust('audio', 24_021_333, 21_333);
  assert.equal(c.count, 1, '两条轨是同一段停摆，只该压一次');
  assert.ok(Math.abs(v - 4_000_000) < 50_000, `视频恢复点应该≈4 秒，实际 ${v / 1e6}`);
  assert.ok(Math.abs(a - v) < 200_000, `两条轨恢复后仍然要对齐：视频 ${v / 1e6} / 音频 ${a / 1e6}`);
});

/* ------------------------------------------------------------------ *
 * 真实时长：界面显示时长必须用它，不能拿"操作了多久"顶替
 * ------------------------------------------------------------------ */

test('真实时长：普通 MP4 读出来和 ffprobe 一致', { skip: !hasFfprobe() }, () => {
  const seconds = readMovieDurationSeconds(source());
  const expected = Number(probe(fixturePath('source.mp4')).format.duration);
  assert.ok(Math.abs(seconds - expected) < 0.05, `${seconds} vs ${expected}`);
});

test('真实时长：抓流产物（mergeFmp4 的合并结果）能读出时长', () => {
  const merged = mergeFmp4(
    { video: dashTrack(0, [1, 2, 3, 4, 5, 6]), audio: dashTrack(1, [1, 2, 3, 4, 5, 6]) },
    {},
  );
  const seconds = readMovieDurationSeconds(merged);
  assert.ok(seconds > 11 && seconds < 13, `合并产物应该约 12 秒，实际 ${seconds}`);
});

test('真实时长：只拿到文件的一小段（没有可解析的 box 链）也能靠扫描读出来', () => {
  // 模拟"录制的 moov 在文件末尾"：把 moov 抠出来、前后垫上垃圾字节，
  // 这样按 box 结构走是走不通的，只能靠扫描 mvhd 签名。
  const b = holed();
  const moov = walkBoxes(b, 0, b.length).find((x) => x.type === 'moov');
  const junk = new Uint8Array(7); // 长度不是合法 box，walkBoxes 第一个就停
  const chunk = concat([junk, b.slice(moov.start, moov.start + moov.size), junk]);
  const seconds = readMovieDurationSeconds(chunk);
  assert.ok(seconds > 7.9 && seconds < 8.1, `应该读出 8 秒左右，实际 ${seconds}`);
});

test('真实时长：读不出来时返回 null，不瞎猜', () => {
  assert.equal(readMovieDurationSeconds(new Uint8Array(64)), null);
  // 全是 'mvhd' 字样的垃圾：没有合法的时间刻度，必须被否掉
  const fake = new Uint8Array(200).fill(0x6d);
  assert.equal(readMovieDurationSeconds(fake), null);
});

test('真实时长：分片式初始化段的 mvhd 时长是"未知"，应当返回 null', () => {
  const init = readFixtureBytes('dash-split', 'init-stream0.m4s');
  assert.equal(readMovieDurationSeconds(init), null);
});

/* ------------------------------------------------------------------ *
 * 录制端给出的真实时长
 * ------------------------------------------------------------------ */

test('真实时长：录制时间轴算出的时长 = 内容长度，与停摆无关', () => {
  const clock = makeClock();
  const c = createTimelineCompressor({ gapUs: 1_500_000, now: clock.now });
  // 3 秒内容 → 整条采集停 3 秒 → 再 3 秒内容
  for (let t = 0; t < 3_000_000; t += 33_333) { c.adjust('video', t, 33_333); clock.advance(33); }
  clock.advance(3_000);
  const resume = 6_000_000;
  for (let t = resume; t < resume + 3_000_000; t += 33_333) { c.adjust('video', t, 33_333); clock.advance(33); }
  const seconds = c.mediaSeconds;
  assert.ok(Math.abs(seconds - 6.0) < 0.1, `产物时长应该约 6 秒，实际 ${seconds}`);
  // 挂钟是 9 秒 —— 这两个数必须分开，界面显示的是前者
  assert.ok(seconds < 7, '绝不能把停摆的 3 秒算进产物时长');
});

test('真实时长：没有停摆时等于内容长度', () => {
  const clock = makeClock();
  const c = createTimelineCompressor({ now: clock.now });
  for (let t = 0; t < 2_000_000; t += 40_000) { c.adjust('video', t, 40_000); clock.advance(40); }
  const seconds = c.mediaSeconds;
  assert.ok(Math.abs(seconds - 2.0) < 0.05, `应该约 2 秒，实际 ${seconds}`);
});

test('真实时长：两条轨取较晚的那条作为结束', () => {
  const clock = makeClock();
  const c = createTimelineCompressor({ now: clock.now });
  for (let t = 0; t < 2_000_000; t += 40_000) { c.adjust('video', t, 40_000); clock.advance(20); }
  for (let t = 0; t < 2_500_000; t += 21_333) { c.adjust('audio', t, 21_333); clock.advance(20); }
  const seconds = c.mediaSeconds;
  assert.ok(seconds > 2.4 && seconds < 2.6, `应该按音频的 2.5 秒算，实际 ${seconds}`);
});


/* ------------------------------------------------------------------ *
 * 换集自动分文件：文件名必须唯一，否则后一集会把前一集覆盖掉
 *
 * 时间戳只精确到秒，而"一集播完"和"用户手动再切一次"完全可能落在同一秒里；
 * 不带序号的话 `writeOpfsFile` 会把前一个文件覆盖掉，用户莫名少一个文件。
 * ------------------------------------------------------------------ */

test('抓流分段命名：第 1 段不带序号，之后依次 -2、-3，同秒内也不会重名', () => {
  const stamp = '20260920-110400';
  const names = [1, 2, 3].map((part) => captureFileName(stamp, part));
  assert.deepEqual(names, [
    'vh-mse-20260920-110400.mp4',
    'vh-mse-20260920-110400-2.mp4',
    'vh-mse-20260920-110400-3.mp4',
  ]);
  assert.equal(new Set(names).size, names.length, '同一秒里切出来必须是不同的文件');
});

test('抓流分段命名：默认第 1 段，且都带抓流前缀（管理页靠前缀分组）', () => {
  assert.equal(captureFileName('20260920-110400'), 'vh-mse-20260920-110400.mp4');
  assert.ok(captureFileName('x', 5).startsWith('vh-mse-'));
});

/* ------------------------------------------------------------------ *
 * 抓流产物：用户报的"前 12 分钟拖不动"就是这里出来的
 * 复现的形状来自用户真实的产物（23 分钟、33 MB）：
 *
 *     stts: 749×…  1×(708 秒)  …      ← 12.5 秒之后直接跳到 720.8 秒
 *     音频轨同样                       ← 两条轨一起断 = 那段时间真的没抓到东西
 *
 * 成因：抓流是实时的，播放器的位置往前跳（站点恢复上次观看位置 / 拖了进度条）之后
 * 中间那段就谁都没抓到，而分片自带的 tfdt 是连续的，于是合并出来横着一段空洞。
 * ------------------------------------------------------------------ */

test('抓流产物：两条轨一起断时，落盘前把死气压掉（就是"前 12 分钟拖不动"那个 bug）', () => {
  // 视频和音频都少喂中间几段 —— 等价于"抓流时播放器往前跳了一段"
  const merged = mergeFmp4({
    video: dashTrack(0, [1, 6]),
    audio: dashTrack(1, [1, 6]),
  });
  const before = inspectSeekability(merged);
  assert.ok(
    before.tracks.some((t) => t.gaps.length > 0),
    '前提：合并出来的文件里确实有空洞',
  );

  const out = finalizeCaptureBytes(merged);
  assert.ok(out.compressedSeconds > 5, `应该压掉 8 秒左右，实际 ${out.compressedSeconds}`);
  assert.ok(out.warnings.some((w) => /没有抓到任何数据/.test(w)), '要把原因说出来');

  const after = inspectSeekability(out.bytes);
  for (const t of after.tracks) {
    assert.equal(t.gaps.length, 0, `${t.handler} 轨压完不该还有空洞`);
  }
  // 关键帧必须从 0 附近就开始，否则播放器一拖就只能跳到最后一段。
  // 这份 DASH 素材每片 2 秒、每片一个关键帧，所以正常间隔就是 2 秒 ——
  // 要断言的不是"间隔小于 1 秒"，而是"没有那段 8 秒的空档"。
  const video = after.tracks.find((t) => t.handler === 'vide');
  assert.ok(video.keyframeTimes.length > 1);
  assert.ok(video.keyframeTimes[1] < 3, `第二个关键帧应该紧跟开头，实际 ${video.keyframeTimes[1]}`);
  assert.ok(video.keyframeIntervalMax < 5, `关键帧最大间隔应该回到几秒内，实际 ${video.keyframeIntervalMax}`);
});

test('抓流产物：只有一条轨断了时不动它（压了会让音画错位）', () => {
  const merged = mergeFmp4({
    video: dashTrack(0, [1, 6]),           // 视频中间缺一段
    audio: dashTrack(1, [1, 2, 3, 4, 5, 6]), // 音频是连着的
  });
  const out = finalizeCaptureBytes(merged);
  assert.equal(out.compressedSeconds, 0, '这种情况不该压');
  assert.equal(out.bytes, merged, '应当原样输出（同一个对象，说明确实没动）');
  assert.ok(
    out.warnings.some((w) => /没有抓到/.test(w)),
    `要说清哪条轨缺了、为什么没动：${out.warnings.join('；')}`,
  );
});

test('抓流产物：本来就没有空洞时原样输出，且不多说一句', () => {
  const merged = mergeFmp4(
    { video: dashTrack(0, [1, 2, 3, 4, 5, 6]), audio: dashTrack(1, [1, 2, 3, 4, 5, 6]) },
    {},
  );
  const out = finalizeCaptureBytes(merged);
  assert.equal(out.compressedSeconds, 0);
  assert.equal(out.bytes, merged);
  assert.deepEqual(out.warnings, []);
});


/* ------------------------------------------------------------------ *
 * 单轨缺口 vs 死气：这是「能不能动手」的分界线
 *
 * 两个用例都用真实 DASH 分片合出来的双轨 MP4，只改变"少喂了哪几段"：
 *   · 只缺视频那几段 → 视频有缺口、音频连着 → **不许压**（压了音画错位）
 *   · 两条轨缺同样几段 → 整段采集停摆过 → 可以压，压完两条轨都完整
 * ------------------------------------------------------------------ */

const dashTrack = (stream, segmentNumbers) => ({
  init: readFixtureBytes('dash-split', `init-stream${stream}.m4s`),
  segments: segmentNumbers.map((n) => readFixtureBytes('dash-split', `chunk-stream${stream}-0000${n}.m4s`)),
});

test('修复：只有视频轨断了时拒绝动手，并说清为什么', () => {
  const merged = mergeFmp4({
    video: dashTrack(0, [1, 6]),          // 中间缺 2~5 段 ≈ 8 秒
    audio: dashTrack(1, [1, 2, 3, 4, 5, 6]), // 音频完整
  });
  const r = inspectSeekability(merged);
  const v = r.tracks.find((t) => t.handler === 'vide');
  assert.ok(v.gaps.length >= 1, `视频轨应该被认出缺口：${JSON.stringify(v.gaps)}`);
  assert.equal(v.gaps[0].deadAir, false, '只有视频断，不该判定成死气');
  assert.equal(r.repairable, false);

  const fixed = repairTimelineGaps(merged);
  assert.equal(fixed.ok, false, '这种情况必须拒绝修复');
  assert.match(fixed.reason, /音画错位/);
  assert.ok(fixed.skipped.length >= 1, '应该说明跳过了哪一处');
  assert.match(fixed.skipped[0].reason, /另一条轨是连着的/);
});

test('修复：两条轨在同一段时间都断了（整段停摆）才动手', () => {
  const merged = mergeFmp4({
    video: dashTrack(0, [1, 6]),
    audio: dashTrack(1, [1, 6]), // 音频缺同样那几段 → 说明整条采集停过
  });
  const r = inspectSeekability(merged);
  const v = r.tracks.find((t) => t.handler === 'vide');
  assert.equal(v.gaps[0].deadAir, true, `两条轨都断就该判定成死气：${JSON.stringify(v.gaps)}`);
  assert.equal(r.repairable, true);

  const fixed = repairTimelineGaps(merged);
  assert.equal(fixed.ok, true, fixed.reason);
  assert.ok(fixed.droppedSeconds > 5, `应该压掉 8 秒左右，实际 ${fixed.droppedSeconds}`);

  const after = inspectSeekability(fixed.bytes);
  for (const t of after.tracks) {
    assert.equal(t.gaps.length, 0, `${t.handler} 轨修完不该还有缺口`);
  }
});

/* ------------------------------------------------------------------ *
 * 合并路线的空洞提示：真的少喂几段 DASH 分片，时间轴就断了
 * ------------------------------------------------------------------ */

test('mergeFmp4：分片缺了几段时，通过 onWarning 报出空洞', () => {
  const init = readFixtureBytes('dash-split', 'init-stream0.m4s');
  // 只喂第 1 段和第 6 段 —— 中间 4 段（约 8 秒）缺席，tfdt 会直接跳过去
  const segments = [
    readFixtureBytes('dash-split', 'chunk-stream0-00001.m4s'),
    readFixtureBytes('dash-split', 'chunk-stream0-00006.m4s'),
  ];
  const warnings = [];
  const merged = mergeFmp4({ video: { init, segments } }, { onWarning: (w) => warnings.push(String(w)) });
  assert.ok(merged.byteLength > 1000);
  assert.ok(
    warnings.some((w) => /空/.test(w)),
    `应该报出空洞，实际提示：${warnings.join('；') || '（一条都没有）'}`,
  );
});

test('mergeFmp4：分片齐全时不误报空洞', () => {
  const init = readFixtureBytes('dash-split', 'init-stream0.m4s');
  const segments = [1, 2, 3, 4, 5, 6].map((i) => readFixtureBytes('dash-split', `chunk-stream0-0000${i}.m4s`));
  const warnings = [];
  mergeFmp4({ video: { init, segments } }, { onWarning: (w) => warnings.push(String(w)) });
  assert.ok(!warnings.some((w) => /空/.test(w)), `不该误报空洞：${warnings.join('；')}`);
});
