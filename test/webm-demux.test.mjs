/**
 * WebM 拆包 + Opus → AAC 混装。
 *
 * 这一组用例是用户报的「抓 YouTube 有画面没声音」的回归测试。
 * 现场（`--site` 打出来的）是这样的：
 *
 *     video/mp4; codecs="av01.0.01M.08"   51 段 1.31 MB  → 合进产物了
 *     audio/webm; codecs="opus"           19 段 0.80 MB  → 认不出容器，被跳过
 *
 * 所以这里要钉住两件事：
 *   1. WebM 拆包（EBML、Cluster、Block、lacing）对真样本算出来的帧、
 *      时间戳、时长都对；
 *   2. 「fMP4 视频 + 转码好的 AAC 音频」合成出来的 MP4，ffprobe 要认得出
 *      两条轨，而且时长对得上。
 *
 * 转码本身（WebCodecs）只在浏览器里能跑，由浏览器端到端用例覆盖；
 * 这里到 AAC 那一层为止。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  isWebm, isWebmClusterStart, isWebmInit, peekWebmClusterTimecode, parseWebmInit, splitWebmInit, demuxWebm, describeWebmTracks,
  WEBM_CODECS,
} from '../src/parser/webm-demux.js';
import { sniffContainer, analyzeGroup } from '../src/parser/mse-assemble.js';
import { mergeFmp4 } from '../src/parser/mp4-merge.js';
import { fixturePath, probe, hasFfprobe, writeTmp } from './helpers.mjs';

const noProbe = hasFfprobe() ? false : '本机没有 ffprobe，跳过产物校验';

const webmBytes = () => new Uint8Array(readFileSync(fixturePath('webm-opus', 'audio.webm')));
const readFile = (name) => new Uint8Array(readFileSync(fixturePath('webm-opus', name)));

/* ------------------------------------------------------------------ *
 * 合成样本：lacing
 *
 * 真样本（ffmpeg 出的）每个 Block 只放一帧，覆盖不到 lacing —— 而 lacing
 * 是"一个 Block 里塞好几帧"，三种形态各有各的读法。这种纯位运算的东西必须
 * 用固定字节钉住，不能指望真站点正好发过来。
 * ------------------------------------------------------------------ */

/** EBML 元素 ID 的字节（ID 自带长度标记位，直接原样写出来） */
function idBytes(id) {
  const out = [];
  let n = id;
  while (n > 0) { out.unshift(n & 0xff); n = Math.floor(n / 256); }
  return out;
}

/** EBML size 的最小长度编码（数据位全 1 是"长度未知"，所以必须严格小于） */
function sizeBytes(size) {
  for (let length = 1; length <= 8; length += 1) {
    const max = 2 ** (7 * length) - 1;
    if (size < max) {
      const out = [];
      let value = size;
      for (let i = 0; i < length; i += 1) { out.unshift(value & 0xff); value = Math.floor(value / 256); }
      out[0] |= 1 << (8 - length);
      return out;
    }
  }
  throw new Error('size 太大');
}

const el = (id, payload) => [...idBytes(id), ...sizeBytes(payload.length), ...payload];
const uintEl = (id, value) => {
  const bytes = [];
  let n = value;
  do { bytes.unshift(n & 0xff); n = Math.floor(n / 256); } while (n > 0);
  return el(id, bytes);
};
const strEl = (id, text) => el(id, [...text].map((c) => c.charCodeAt(0)));
const f64El = (id, value) => {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setFloat64(0, value);
  return el(id, [...buf]);
};

/**
 * 造一个最小的 WebM：一条 Opus 音频轨 + 一个 Cluster 里一个 Block。
 *
 * @param {number[]} frameBytes 每个"帧"的字节数（用来验证 lacing 拆得对不对）
 * @param {number} lacing 0 无 / 1 Xiph / 2 固定 / 3 EBML
 */
function synthWebm(frameBytes, lacing) {
  const trackEntry = [
    ...uintEl(0xd7, 1),          // TrackNumber
    ...uintEl(0x83, 2),          // TrackType = audio
    ...strEl(0x86, 'A_OPUS'),    // CodecID
    ...el(0xe1, [                 // Audio
      ...f64El(0xb5, 48000),     // SamplingFrequency
      ...uintEl(0x9f, 2),        // Channels
    ]),
  ];
  const tracks = el(0x1654ae6b, el(0xae, trackEntry));
  const info = el(0x1549a966, uintEl(0x2ad7b1, 1_000_000));

  // Block：轨道号(vint 0x81) + int16 相对时间 + flags + [帧数] + 帧
  const frameData = [];
  const sizes = frameBytes.map((n, i) => Array.from({ length: n }, (_, k) => 0x40 + i * 16 + k));
  for (const bytes of sizes) frameData.push(...bytes);

  let lacingHeader = [];
  let lacingPayload = [];
  if (lacing === 1) {
    // Xiph：帧数-1，然后前 n 帧的长度（本用例每帧都小于 255）
    lacingHeader = [sizeOfLacing(frameBytes.length - 1)];
    lacingPayload = frameBytes.slice(0, -1);
  } else if (lacing === 2) {
    lacingHeader = [sizeOfLacing(frameBytes.length - 1)];
  } else if (lacing === 3) {
    // EBML：帧数-1，第一个长度是 vint，之后是差值（**带符号的 vint**）
    const deltas = [];
    let previous = frameBytes[0];
    for (let i = 1; i < frameBytes.length; i += 1) {
      const diff = frameBytes[i] - previous;
      previous = frameBytes[i];
      // 1 字节的带符号 vint：标记位 0x80 + (差值 + bias 63)
      deltas.push(0x80 | (diff + 63));
    }
    lacingHeader = [sizeOfLacing(frameBytes.length - 1), ...sizeBytes(frameBytes[0]), ...deltas];
  }

  const flags = 0x80 | (lacing << 1); // 关键帧 + lacing 形态
  const block = [0x81, 0x00, 0x00, flags, ...lacingHeader, ...lacingPayload, ...frameData];
  const cluster = el(0x1f43b675, [...uintEl(0xe7, 0), ...el(0xa3, block)]);

  // Segment 故意用"长度未知"（size 数据位全 1，共 8 字节）—— MSE 里的 WebM 就是这个形态
  const segment = [...idBytes(0x18538067), 0x01, ...Array(7).fill(0xff)];
  return new Uint8Array([...el(0x1a45dfa3, []), ...segment, ...info, ...tracks, ...cluster]);
}
const sizeOfLacing = (n) => n;

test('lacing：无 lacing 时整块就是一帧', () => {
  const bytes = synthWebm([10], 0);
  const demuxed = demuxWebm(bytes);
  assert.equal(demuxed.tracks.length, 1);
  assert.equal(demuxed.tracks[0].frames.length, 1);
  assert.equal(demuxed.tracks[0].frames[0].data.byteLength, 10);
  assert.equal(demuxed.tracks[0].frames[0].keyframe, true);
});

test('lacing：Xiph 形态能拆出一个 Block 里的多帧（最后一帧靠剩余字节推）', () => {
  const demuxed = demuxWebm(synthWebm([5, 7, 9], 1));
  const frames = demuxed.tracks[0].frames;
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map((f) => f.data.byteLength), [5, 7, 9]);
  assert.deepEqual(frames.map((f) => f.timeUs), [0, 0, 0], '同一个 Block 里的帧时间戳相同，靠 duration 区分');
});

test('lacing：固定长度和 EBML 差值两种形态也要能拆', () => {
  const fixed = demuxWebm(synthWebm([6, 6, 6, 6], 2)).tracks[0].frames;
  assert.deepEqual(fixed.map((f) => f.data.byteLength), [6, 6, 6, 6]);

  const ebml = demuxWebm(synthWebm([4, 8, 3], 3)).tracks[0].frames;
  assert.deepEqual(ebml.map((f) => f.data.byteLength), [4, 8, 3]);
});

test('合成样本里的"长度未知的 Segment"要能解析', () => {
  const bytes = synthWebm([10], 0);
  const info = parseWebmInit(bytes);
  assert.equal(info.timestampScaleNs, 1_000_000);
  assert.equal(info.tracks.length, 1);
  assert.equal(info.tracks[0].codec, 'opus');
  assert.equal(info.tracks[0].sampleRate, 48000);
  assert.equal(info.tracks[0].channels, 2);
});

/* ------------------------------------------------------------------ *
 * 真样本
 * ------------------------------------------------------------------ */

test('真 WebM/Opus 样本：认得出 Opus 轨和它的 OpusHead', () => {
  const all = webmBytes();
  assert.equal(isWebm(all), true);
  assert.equal(sniffContainer(all), 'webm');

  const info = parseWebmInit(all);
  assert.equal(info.tracks.length, 1);
  const track = info.tracks[0];
  assert.equal(track.type, 'audio');
  assert.equal(track.codecId, 'A_OPUS');
  assert.equal(track.codec, 'opus');
  assert.equal(track.sampleRate, 48000);
  assert.equal(track.channels, 2);
  // OpusHead 是解码器配置，转码第一个参数就是它
  assert.equal(String.fromCharCode(...track.codecPrivate.subarray(0, 8)), 'OpusHead');
});

test('真 WebM/Opus 样本：帧数、时间戳、时长都对得上', () => {
  const demuxed = demuxWebm(webmBytes());
  assert.equal(demuxed.skippedBlocks, 0, '一帧都不该丢');
  const frames = demuxed.tracks[0].frames;
  // 12 秒、20 毫秒一帧 → 601 帧（第一帧含 Opus 的 pre-skip，时长 21 毫秒）
  assert.equal(frames.length, 601);

  let previous = -1;
  for (const frame of frames) {
    assert.ok(frame.timeUs > previous, `时间戳必须严格递增，实际 ${frame.timeUs} <= ${previous}`);
    previous = frame.timeUs;
    assert.ok(frame.data.byteLength > 0);
  }
  const last = frames[frames.length - 1];
  const totalSeconds = (last.timeUs + last.durationUs) / 1e6;
  assert.ok(Math.abs(totalSeconds - 12) < 0.2, `总时长应该约 12 秒，实际 ${totalSeconds}`);
  assert.equal(frames[0].durationUs, 21000, '第一帧的时长包含 Opus pre-skip');
  assert.equal(frames[1].durationUs, 20000);
});

test('初始化段与媒体段的切分：切开再拼回去，字节和帧数都不变', () => {
  const all = webmBytes();
  const { init, media } = splitWebmInit(all);
  assert.equal(init.byteLength + media.byteLength, all.byteLength);
  assert.equal(isWebm(init), true);
  // 媒体段一定从 Cluster 开始 —— MSE 每次 append 的就是这个
  assert.equal(isWebmClusterStart(media), true);
  assert.equal(sniffContainer(media), 'webm-no-init');

  const joined = new Uint8Array(all.byteLength);
  joined.set(init);
  joined.set(media, init.byteLength);
  assert.deepEqual([...joined], [...all]);
  assert.equal(demuxWebm(joined).tracks[0].frames.length, 601);
});

test('只有 Cluster、没有头部时，要明确报"缺初始化段"而不是解析出垃圾', () => {
  const { media } = splitWebmInit(webmBytes());
  assert.throws(() => splitWebmInit(media), (err) => {
    assert.equal(err.missingInit, true);
    return true;
  });
  // 上层靠这个容器名给出"刷新页面从头来"的提示
  const analyzed = analyzeGroup({ mime: 'audio/webm; codecs="opus"', chunks: [media], bytes: media.byteLength });
  assert.equal(analyzed.container, 'webm');
  assert.equal(analyzed.missingInit, true);
});

test('analyzeGroup 认得出 WebM 组的轨道（mime 骗人也按轨道表判）', () => {
  const all = webmBytes();
  const analyzed = analyzeGroup({ mime: 'video/mp4', chunks: [all], bytes: all.byteLength });
  assert.equal(analyzed.container, 'webm');
  assert.equal(analyzed.contentType, 'audio', 'mime 写着 video 也不能信，要按 WebM 的 TrackType 判');
  assert.equal(analyzed.codecType, 'opus');
  assert.equal(analyzed.webmTracks.length, 1);
  assert.match(analyzed.trackSummary, /A_OPUS/);
  // 初始化段和媒体段要分开交给上层：转码要用轨道表（在 init 里），
  // 帧在媒体段里，两边都得有
  assert.ok(analyzed.init.byteLength > 0);
  assert.ok(analyzed.fragments.byteLength > 0);
  assert.equal(describeWebmTracks(parseWebmInit(all).tracks).includes('audio#1'), true);
});

test('拆包表里认得的编码要能覆盖站点常见的几种', () => {
  assert.equal(WEBM_CODECS.A_OPUS.codec, 'opus');
  assert.equal(WEBM_CODECS.V_VP9.media, 'video');
  assert.equal(WEBM_CODECS.V_AV1.codec, 'av1');
});

/* ------------------------------------------------------------------ *
 * 「fMP4 视频 + 转码好的 AAC 音频」→ 一个 MP4
 * ------------------------------------------------------------------ */

/** 造一段假的 AAC：muxer 不看内容，但结构必须是真的（音轨、时长都对） */
function fakeAacFrames({ count, sampleRate, durationUs }) {
  const frames = [];
  for (let i = 0; i < count; i += 1) {
    frames.push({
      // 每帧给点不同的字节，免得 muxer 的 chunk 合并把它当成同一帧
      data: new Uint8Array(120 + (i % 7)).fill(i & 0xff),
      timestampUs: i * durationUs,
      durationUs,
    });
  }
  return { frames, sampleRate, channels: 2, description: new Uint8Array([0x11, 0x90]) };
}
// 上面那两个字节是 AAC-LC / 48000 Hz / 立体声的 AudioSpecificConfig ——
// 浏览器的编码器会真的给出它；这里手写一份，好让 ffprobe 读到的采样率和
// 我们声称的一致（不然它会以 ASC 为准，报出 44100 这种对不上的值）。

const videoInput = () => {
  const dir = 'dash-split';
  const names = ['init-stream0.m4s', 'chunk-stream0-00001.m4s', 'chunk-stream0-00002.m4s'];
  const parts = names.map((n) => new Uint8Array(readFileSync(fixturePath(dir, n))));
  return { init: parts[0], segments: [parts[1], parts[2]] };
};

test('混装：fMP4 视频 + 转码 AAC，产物里两条轨都在', { skip: noProbe }, () => {
  const audio = fakeAacFrames({ count: 200, sampleRate: 48000, durationUs: 21333 });
  const merged = mergeFmp4({ video: videoInput(), audio: { aac: audio } });
  const file = writeTmp('mixed-aac.mp4', [Buffer.from(merged)]);
  const info = probe(file);
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  const a = (info.streams || []).find((s) => s.codec_type === 'audio');
  assert.ok(v, '产物必须有视频轨');
  assert.ok(a, '产物必须有音频轨 —— 用户报的就是这条没了');
  assert.equal(a.codec_name, 'aac');
  assert.equal(a.sample_rate, '48000');
  assert.equal(a.channels, 2);
});

test('混装：音频起点比视频晚时，两条轨的相对位置要保住（不能各归各的零）', { skip: noProbe }, () => {
  // 视频从 0 开始（fMP4 的 tfdt 起点），音频从 1 秒才开始：
  // 各轨归零会把这一秒吃掉，两条轨就会同时起播 —— 那是音画不同步。
  const audio = fakeAacFrames({ count: 100, sampleRate: 48000, durationUs: 20000 });
  for (const frame of audio.frames) frame.timestampUs += 1_000_000;
  const merged = mergeFmp4({ video: videoInput(), audio: { aac: audio } });
  const file = writeTmp('mixed-late-audio.mp4', [Buffer.from(merged)]);
  const info = probe(file);
  const a = (info.streams || []).find((s) => s.codec_type === 'audio');
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  assert.ok(a && v);
  // 音频轨自己的 edit list 会把它推到 1 秒（或者 start_time 体现出来）
  const start = Number(a.start_time ?? 0);
  assert.ok(Math.abs(start - 1) < 0.15, `音频应该从约 1 秒处开始，实际 ${start}`);
});

test('混装：音轨只有一样输入时也能出片（没有视频轨的情况）', { skip: noProbe }, () => {
  const audio = fakeAacFrames({ count: 50, sampleRate: 48000, durationUs: 20000 });
  const merged = mergeFmp4({ audio: { aac: audio } });
  const info = probe(writeTmp('mixed-audio-only.m4a', [Buffer.from(merged)]));
  const a = (info.streams || []).find((s) => s.codec_type === 'audio');
  assert.ok(a, '只有音频输入时也要产出能播的轨');
  assert.ok(Math.abs(Number(info.format.duration) - 1) < 0.1);
});

test('混装：时间戳为负会先被整体平移，绝不让 muxer 当场报错', () => {
  // 直接给一段"起点是负的"帧：源时间轴可能比影片原点早（edit list 的情形）
  const audio = fakeAacFrames({ count: 30, sampleRate: 48000, durationUs: 20000 });
  for (const frame of audio.frames) frame.timestampUs -= 500_000;
  const merged = mergeFmp4({ video: videoInput(), audio: { aac: audio } });
  assert.ok(merged.byteLength > 0);
});

test('混装：转码音频缺采样率/声道时要明确报错，不能产出坏文件', () => {
  const audio = fakeAacFrames({ count: 10, sampleRate: 48000, durationUs: 20000 });
  assert.throws(
    () => mergeFmp4({ audio: { aac: { ...audio, sampleRate: 0 } } }),
    /采样率\/声道不合法/,
  );
  assert.throws(
    () => mergeFmp4({ audio: { aac: { ...audio, frames: [] } } }),
    /一帧都没有/,
  );
});

test('isWebmInit 与 peekWebmClusterTimecode 正确识别 WebM 头部与 Cluster 时间戳', () => {
  const bytes = webmBytes();
  assert.equal(isWebmInit(bytes), true);
  assert.equal(isWebmInit(new Uint8Array([0, 1, 2, 3])), false);

  const { init, media } = splitWebmInit(bytes);
  assert.equal(isWebmInit(init), true);
  assert.equal(isWebmClusterStart(media), true);
  const tc = peekWebmClusterTimecode(media);
  assert.ok(tc !== null && Number.isFinite(tc), `应当能够读出 Cluster 时间戳，实际 ${tc}`);
});
