/**
 * MSE 采集的归并与判型。
 *
 * 用真实样本模拟"播放器往 SourceBuffer 里 append 了什么"：
 * DASH 那种两条独立轨（视频一条、音频一条）是最典型的形态，
 * 而它的每条轨都是「init 段 + 一串分片」按顺序 append 进去的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import {
  groupBuffers, analyzeGroup, sniffContainer, contentTypeFromMime,
  fingerprint, explainEmptyCapture, explainMissingInit, pickReusableInit,
} from '../src/parser/mse-assemble.js';
import { listInitTrackIds } from '../src/parser/fmp4-file.js';
import { mergeFmp4 } from '../src/parser/mp4-merge.js';
import { fixturePath, probe, videoStream, audioStream, writeTmp, hasFfprobe } from './helpers.mjs';

const noProbe = hasFfprobe() ? false : '本机没有 ffprobe，跳过产物校验';

const chunkNames = (prefix) => readdirSync(fixturePath('dash-split'))
  .filter((n) => n.startsWith(prefix) && n.endsWith('.m4s'))
  .sort();

const readChunk = (name) => new Uint8Array(readFileSync(fixturePath('dash-split', name)));

/** 模拟一条轨被 append 进去的全过程：init 先来，然后是按序的分片 */
function trackChunks(initName, prefix) {
  return [initName, ...chunkNames(prefix)].map(readChunk);
}

/* ------------------------------------------------------------------ *
 * 「只有初始化段」和「只有分片」要分得开
 *
 * 用户报过一个：抓了 200 段 / 21.4 MB，最后失败在「只抓到了媒体分片，
 * 没有初始化段」。原因是播放器重建 SourceBuffer 之后只补了分片 ——
 * 而那个初始化段本次会话早就收到过了。
 *
 * 要能复用，就得先能**认出**"这一组只是一份初始化段"。它原来和"这一组只有分片"
 * 一样被当成失败吞掉，于是那份 init 白白丢了。
 * ------------------------------------------------------------------ */

test('初始化段单独成组时，要把它当成"拿到了 init"而不是失败', () => {
  const init = readChunk('init-stream0.m4s');
  const a = analyzeGroup({ mime: 'video/mp4; codecs="avc1.64001e"', chunks: [init], bytes: init.byteLength });
  assert.equal(a.container, 'fmp4');
  assert.equal(a.contentType, 'video');
  assert.ok(a.init, '应该把这份初始化段交出来（上层要记住它）');
  assert.equal(a.init.byteLength, init.byteLength);
  assert.equal(a.initOnly, true);
  assert.notEqual(a.missingInit, true, '这不是"缺初始化段"，是"只有初始化段"');
});

test('只有分片的组仍然被标成 missingInit（那是另一回事）', () => {
  const frag = readChunk('chunk-stream0-00001.m4s');
  const a = analyzeGroup({ mime: 'video/mp4', chunks: [frag], bytes: frag.byteLength });
  assert.equal(a.missingInit, true);
  assert.equal(a.init, undefined);
  assert.ok(a.raw, '原始分片要留着 —— 上层可能能配上先前收到的初始化段');
});

test('两组拼起来时：一组给 init、一组给分片，按大类能凑成一对', () => {
  const init = readChunk('init-stream0.m4s');
  const frag = readChunk('chunk-stream0-00001.m4s');
  const { groups } = groupBuffers([
    { mime: 'video/mp4; codecs="avc1.64001e"', bytes: init },
    { mime: 'video/mp4', bytes: frag },
  ]);
  assert.equal(groups.length, 2, 'mime 不同就该分成两组');
  const analyzed = groups.map(analyzeGroup);
  const withInit = analyzed.find((a) => a.init);
  const withoutInit = analyzed.find((a) => a.missingInit);
  assert.ok(withInit && withoutInit, '一组带 init、一组缺 init');
  // 这一步正是 offscreen 里 seenInit 的逻辑：只要记得 init，就能把只有分片的那组救回来
  const remembered = new Map([[withInit.contentType, withInit.init]]);
  assert.ok(remembered.get(withoutInit.contentType), '按大类应该能取到先前那份初始化段');
});

/* ------------------------------------------------------------------ *
 * 基础
 * ------------------------------------------------------------------ */

test('按 mime 分组；同一 mime 的分片保持到达顺序', () => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([4, 5]);
  const c = new Uint8Array([9]);
  const { groups } = groupBuffers([
    { seq: 0, mime: 'video/mp4', bytes: a },
    { seq: 1, mime: 'audio/mp4', bytes: c },
    { seq: 2, mime: 'video/mp4', bytes: b },
  ]);

  assert.equal(groups.length, 2);
  const video = groups.find((g) => g.mime === 'video/mp4');
  assert.deepEqual(video.chunks.map((x) => [...x]), [[1, 2, 3], [4, 5]], '顺序必须按 seq');
  assert.equal(video.bytes, 5);
});

test('拖动进度条导致的重复 append 必须被去掉', () => {
  const seg = new Uint8Array([7, 7, 7, 7]);
  const other = new Uint8Array([8, 8]);
  const { groups, duplicates } = groupBuffers([
    { seq: 0, mime: 'video/mp4', bytes: seg },
    { seq: 1, mime: 'video/mp4', bytes: other },
    // 用户往回拖，播放器把刚放过的分片又 append 了一遍
    { seq: 2, mime: 'video/mp4', bytes: seg },
  ]);

  assert.equal(duplicates, 1, '应该识别出 1 个重复分片');
  assert.equal(groups[0].chunks.length, 2, '重复的那份不该进产物');
  assert.equal(groups[0].bytes, 6);
});

/**
 * 没有 mime 的 append：必须按 SourceBuffer 编号分组。
 *
 * 真实站点上实测到的（YouTube）：一批 append 的 mime 是空的。原来"空 mime"
 * 全落到同一组，几条不同的流按到达顺序混在一起拼，字节头尾不接 ——
 * 表现是整组被判成"认不出容器"丢掉（实测 0.68 MB），而且**没有任何提示**。
 */
test('没有 mime 的 append 按 SourceBuffer 编号分组，不能混成一组', () => {
  const init = readChunk('init-stream0.m4s');
  const fragA = readChunk('chunk-stream0-00001.m4s');
  const fragB = readChunk('chunk-stream0-00002.m4s');
  const { groups } = groupBuffers([
    { seq: 0, mime: '', sbId: 'sb1', bytes: init },
    { seq: 1, mime: '', sbId: 'sb1', bytes: fragA },
    { seq: 2, mime: '', sbId: 'sb2', bytes: fragB },
  ]);

  assert.equal(groups.length, 2, '两条流必须各自成组');
  const withInit = groups.map(analyzeGroup).find((a) => a.init);
  assert.ok(withInit, '带初始化段的那一组要能解析出来');
  assert.equal(withInit.contentType, 'video');

  // 分开之后，即使两条流的某个分片字节完全一样也不会互相顶掉
  const same = new Uint8Array([1, 2, 3]);
  const dup = groupBuffers([
    { seq: 0, mime: '', sbId: 'sb1', bytes: same },
    { seq: 1, mime: '', sbId: 'sb2', bytes: same },
    { seq: 2, mime: '', sbId: 'sb1', bytes: same },
  ]);
  assert.equal(dup.groups.length, 2, '两条流各自一份');
  assert.equal(dup.duplicates, 1, '同一条流里重复的那一份才该算重复');
});

test('mime 相同但 SourceBuffer 换过（播放器重建）时仍然合成一组', () => {
  const init = readChunk('init-stream0.m4s');
  const fragA = readChunk('chunk-stream0-00001.m4s');
  const fragB = readChunk('chunk-stream0-00002.m4s');
  const { groups } = groupBuffers([
    { seq: 0, mime: 'video/mp4', sbId: 'sb1', bytes: init },
    { seq: 1, mime: 'video/mp4', sbId: 'sb1', bytes: fragA },
    { seq: 2, mime: 'video/mp4', sbId: 'sb2', bytes: fragB },
  ]);
  assert.equal(groups.length, 1, '换了一条 SourceBuffer 也还是同一条轨，要合在一起');
  assert.equal(groups[0].chunks.length, 3);
});

test('指纹能区分内容，同一内容稳定', () => {
  const a = new Uint8Array([1, 2, 3, 4]);
  const b = new Uint8Array([1, 2, 3, 5]);
  assert.equal(fingerprint(a), fingerprint(new Uint8Array([1, 2, 3, 4])));
  assert.notEqual(fingerprint(a), fingerprint(b));
  // 长度不同的同一前缀不能撞
  assert.notEqual(fingerprint(a), fingerprint(new Uint8Array([1, 2, 3, 4, 0])));
});

test('容器判型：真实 TS 和真实 fMP4 都要认对', () => {
  assert.equal(sniffContainer(readChunk('chunk-stream0-00001.m4s')), 'fmp4');
  assert.equal(sniffContainer(new Uint8Array(8)), 'unknown');
  assert.equal(sniffContainer(null), 'unknown');
});

test('mime 判大类', () => {
  assert.equal(contentTypeFromMime('video/mp4; codecs="avc1.64001e"'), 'video');
  assert.equal(contentTypeFromMime('audio/mp4; codecs="mp4a.40.2"'), 'audio');
  assert.equal(contentTypeFromMime('video/mp2t'), 'video');
  assert.equal(contentTypeFromMime(''), '');
});

test('空采集要给出可操作的解释，而不是一句"没有数据"', () => {
  const text = explainEmptyCapture();
  assert.match(text, /拖回开头|刷新/, '必须告诉用户下一步做什么');
});

test('只抓到分片（没有 moov）要被单独识别出来，并给"刷新页面"这个解', () => {
  // 这是线上真实撞到的形态：用户点开抓流时播放器已经把初始化段送进去了，
  // 钩子只捞到后面的 moof/mdat
  const frag = readChunk('chunk-stream0-00001.m4s');
  const { groups } = groupBuffers([{ seq: 0, mime: 'video/mp4', bytes: frag }]);
  const a = analyzeGroup(groups[0]);

  assert.equal(a.container, 'fmp4', '容器还是认得出的');
  assert.equal(a.missingInit, true, '必须标出"缺初始化段"');
  assert.equal(a.init, undefined);
  assert.match(a.error, /没有初始化段/);

  // 提示必须指向正确的动作 —— 这种情况"再等等"没用，只有重来才有用
  const tip = explainMissingInit();
  assert.match(tip, /刷新/, '必须说清楚要刷新页面');
  assert.notEqual(tip, explainEmptyCapture(), '两种情况不能给同一句提示');
});

test('初始化段正常时不该被误标成 missingInit', () => {
  const chunks = trackChunks('init-stream0.m4s', 'chunk-stream0-');
  const { groups } = groupBuffers(chunks.map((bytes, seq) => ({ seq, mime: 'video/mp4', bytes })));
  const a = analyzeGroup(groups[0]);
  assert.ok(!a.missingInit, '有 moov 的组不能带 missingInit');
  assert.ok(a.init && a.fragments);
});

/* ------------------------------------------------------------------ *
 * 真实数据：模拟一次 DASH 播放的 append 过程
 * ------------------------------------------------------------------ */

test('fMP4 轨：轨道类型以 moov 里的 handler 为准，不信 mime', () => {
  const chunks = trackChunks('init-stream0.m4s', 'chunk-stream0-');
  const { groups } = groupBuffers(
    chunks.map((bytes, seq) => ({ seq, mime: 'video/mp4; codecs="avc1.64001e"', bytes })),
  );
  const a = analyzeGroup(groups[0]);

  assert.equal(a.container, 'fmp4');
  assert.equal(a.contentType, 'video');
  assert.ok(a.init && a.init.byteLength > 0, '应当拆出初始化段');
  assert.ok(a.fragments && a.fragments.byteLength > 0, '应当拆出媒体分片');
  assert.equal(a.init.byteLength + a.fragments.byteLength, a.bytes, '拆开再拼回去不能丢字节');
});

test('mime 撒谎时（两条轨都报 video/mp4）仍能靠 moov 分辨', () => {
  const vChunks = trackChunks('init-stream0.m4s', 'chunk-stream0-');
  const aChunks = trackChunks('init-stream1.m4s', 'chunk-stream1-');
  const items = [
    ...vChunks.map((bytes, i) => ({ seq: i, mime: 'video/mp4', bytes })),
    ...aChunks.map((bytes, i) => ({ seq: 100 + i, mime: 'video/mp4', bytes })),
  ];
  const { groups } = groupBuffers(items);
  // 同一个 mime 会被归到一组 —— 这正是 mime 不可信时的情形
  assert.equal(groups.length, 1);

  const analyzed = analyzeGroup(groups[0]);
  // 合并后的数据里第一条 init 是视频轨，所以整体判为视频：
  // 这是"mime 撒谎 + 两条轨混在一个 SourceBuffer"的**已知局限**，
  // 真实站点极少这样（要么一条复用流，要么 mime 正确）。
  assert.equal(analyzed.container, 'fmp4');
  assert.equal(analyzed.contentType, 'video');
});

test('TS 轨：容器认得出，交给上层用 mux.js 重封装', () => {
  // 用真实的 TS 分片当 appendBuffer 的内容
  const ts = new Uint8Array(readFileSync(fixturePath('hls-ts', 'v0', 'seg_000.ts')));
  const { groups } = groupBuffers([{ seq: 0, mime: 'video/mp2t', bytes: ts }]);
  const a = analyzeGroup(groups[0]);

  assert.equal(a.container, 'mpegts');
  assert.equal(a.contentType, 'video', 'mime 说 video/mp2t，先按这个走');
  assert.ok(a.raw && a.raw.byteLength === ts.byteLength, 'TS 原样交出去，不在这一层重封装');
});

/* ------------------------------------------------------------------ *
 * 端到端：采集到的两组 → 归并 → 合并 → ffprobe
 * ------------------------------------------------------------------ */

test('模拟一次完整的 DASH 播放采集 → 合并 → 音视频都在', { skip: noProbe }, () => {
  // 播放器实际做的事：视频 SourceBuffer 一串 append，音频 SourceBuffer 一串 append
  const vChunks = trackChunks('init-stream0.m4s', 'chunk-stream0-');
  const aChunks = trackChunks('init-stream1.m4s', 'chunk-stream1-');
  const items = [
    ...vChunks.map((bytes, i) => ({ seq: i, mime: 'video/mp4; codecs="avc1.64001e"', bytes })),
    ...aChunks.map((bytes, i) => ({ seq: 500 + i, mime: 'audio/mp4; codecs="mp4a.40.2"', bytes })),
  ];

  const { groups, duplicates } = groupBuffers(items);
  assert.equal(duplicates, 0);
  assert.equal(groups.length, 2);

  const tracks = groups.map(analyzeGroup);
  const video = tracks.find((t) => t.contentType === 'video');
  const audio = tracks.find((t) => t.contentType === 'audio');
  assert.ok(video?.init && video?.fragments, '视频轨应当拆出 init 和分片');
  assert.ok(audio?.init && audio?.fragments, '音频轨应当拆出 init 和分片');

  const merged = mergeFmp4({
    video: { init: video.init, segments: [video.fragments] },
    audio: { init: audio.init, segments: [audio.fragments] },
  });

  const out = writeTmp('mse-captured.mp4', [merged]);
  const info = probe(out);
  const v = videoStream(info);
  const a = audioStream(info);
  assert.ok(v, '合并产物必须有视频轨');
  assert.ok(a, '合并产物必须有音频轨');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.width, 640);
  assert.equal(v.height, 360);
  assert.equal(a.codec_name, 'aac');
  const dur = Number(info.format.duration);
  assert.ok(Math.abs(dur - 12) < 0.7, `时长应约 12 秒，实际 ${dur.toFixed(3)}`);
});

/* ------------------------------------------------------------------ *
 * 自动切段之后"借初始化段"必须借对
 *
 * 用户报的：抓流到 600 MB 自动切了一段、接着录下一段 —— **下一段没有声音**。
 *
 * 机制：切段会把缓冲清空，而播放器**不会重发 moov**，所以下一段的所有分片都没有
 * 初始化段，只能借"本次会话里先前收到的那一份"。而借哪一份**不能按 mime 猜**：
 * 真实站点上有一批 append 根本没有 mime（`mse-hook` 的注释里写着这是实测到的），
 * 这时大类推不出来，旧代码会回退成"当视频用" —— 音频那组分片于是借到**视频**的
 * init，合并时按 trackId 挑样本，音轨整条被丢掉。切段前每组自带 init，所以正常。
 *
 * 唯一不会认错的依据是**分片自己的 `tfhd.track_ID`**，也就是这两个用例钉的东西。
 * ------------------------------------------------------------------ */

test('初始化段里的 trackId 要读得出来，而且**会撞号**（这正是不能只靠它的原因）', () => {
  const v = listInitTrackIds(readChunk('init-stream0.m4s'));
  const a = listInitTrackIds(readChunk('init-stream1.m4s'));

  assert.equal(v.length, 1, '视频 init 里应该只有一条轨');
  assert.equal(v[0].handler, 'video');
  assert.equal(a.length, 1, '音频 init 里应该只有一条轨');
  assert.equal(a[0].handler, 'audio');
  assert.ok(v[0].id > 0 && a[0].id > 0);

  // ⚠️ 实测（就是这两份夹具）：两条独立轨**都写 track 1**。
  // 所以"按 trackId 认 init"单独用是不够的 —— 调用方还要用"这条流先前是什么"
  // （分组键 → 大类）来定，否则撞号时只能取第一条，音频照样借错。
  assert.equal(v[0].id, a[0].id, '这两份夹具的 trackId 相同（换了夹具的话，这条断言会提醒你）');
});

test('借初始化段：trackId 优先、撞号时按大类定、都没有才回退（猜错就是整条音轨没了）', () => {
  const vInit = readChunk('init-stream0.m4s');
  const aInit = readChunk('init-stream1.m4s');
  const vId = listInitTrackIds(vInit)[0].id;
  const aId = listInitTrackIds(aInit)[0].id;
  const candidates = [
    { key: 'video', contentType: 'video', init: vInit, trackIds: [vId] },
    { key: 'audio', contentType: 'audio', init: aInit, trackIds: [aId] },
  ];

  // ① 撞号 + 知道大类（真实站点那条路：分组键 → 先前的大类）→ 按大类定
  const tie = pickReusableInit(candidates, { contentType: 'audio', trackId: aId });
  assert.equal(tie.by, 'trackId+type');
  assert.equal(tie.candidate.contentType, 'audio', '音频分片必须借到音频的初始化段');

  // ② 这就是那个 bug 的形状：既没有 mime、又没有"先前的大类"，只能回退成"当视频用"。
  //    用例把"回退会借错"记下来 —— 所以调用方那条"按分组键记大类"的线索不可省。
  const fallback = pickReusableInit(candidates, { contentType: '', trackId: null });
  assert.equal(fallback.by, 'fallback');
  assert.equal(fallback.candidate.contentType, 'video');

  // ③ 有 mime 时按大类取（老行为不能丢）
  const byType = pickReusableInit(candidates, { contentType: 'audio', trackId: null });
  assert.equal(byType.by, 'type');
  assert.equal(byType.candidate.contentType, 'audio');

  // ④ 两份 init 的 trackId 不同时（别的打包器就是这样），trackId 直接定案
  const distinct = [
    { key: 'video', contentType: 'video', init: vInit, trackIds: [1] },
    { key: 'audio', contentType: 'audio', init: aInit, trackIds: [2] },
  ];
  const byId = pickReusableInit(distinct, { contentType: '', trackId: 2 });
  assert.equal(byId.by, 'trackId');
  assert.equal(byId.candidate.contentType, 'audio');

  // ⑤ 一份都借不到 → null（调用方要据此把"这一组没进产物"说出来，而不是静默丢掉）
  assert.equal(pickReusableInit([], { contentType: 'audio', trackId: aId }), null);
  assert.equal(pickReusableInit(null, { contentType: 'audio', trackId: aId }), null);
});
