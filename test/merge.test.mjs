/**
 * DASH 音视频分离流的合并测试 —— 这条链路的验收标准只有一个：
 * **产物能被 ffprobe 读成两条正常的轨**。
 *
 * 「函数没抛异常」「字节数不为 0」都不算数。所以这里的每一步都以
 * ffprobe 的输出为准：编码、分辨率、时长，读到的值直接打印出来，
 * 断言只是把打印出来的东西钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

import { parseMpd, selectRepresentations } from '../src/parser/dash.js';
import {
  mergeFmp4, parseInitSegment, extractSegmentSamples, describeMergeInput,
  parseAudioSpecificConfig, normalizeTrackSamples,
} from '../src/parser/mp4-merge.js';
import { createTsRemuxer } from '../src/parser/remuxer.js';
import { splitSelfContainedFmp4 } from '../src/parser/fmp4-file.js';
import { readFragmentMediaTime } from '../src/parser/mse-assemble.js';
import {
  fixturePath, urlFor, pathFromUrl, readFixture, readFixtureBytes, probe,
  videoStream, audioStream, writeTmp, hasFfprobe, loadVendorMuxjs,
  countDecodedVideoFrames,
} from './helpers.mjs';

const noProbe = hasFfprobe() ? false : '本机没有 ffprobe，跳过产物校验';

const bytesAt = (file) => new Uint8Array(readFileSync(file));

/**
 * 输入不是手写的文件名，而是「解析 MPD → 拿到 URL → 映射回磁盘」，
 * 这样测试同时也验了 dash.js 的 URL 展开和这里的封装能不能接上。
 */
const parsed = parseMpd(readFixture('dash-split', 'out.mpd'), urlFor('dash-split/out.mpd'));
const picked = selectRepresentations(parsed, { preferredQuality: 'auto' });

function loadTrack(rep) {
  const initFile = pathFromUrl(rep.initUrl);
  const segmentFiles = rep.segmentUrls.map(pathFromUrl);
  assert.ok(initFile.startsWith(fixturePath('dash-split')), `初始化段应落在 fixture 里：${initFile}`);
  return {
    init: bytesAt(initFile),
    segments: segmentFiles.map(bytesAt),
    files: { initFile, segmentFiles },
  };
}

const videoInput = () => loadTrack(picked.video);
const audioInput = () => loadTrack(picked.audio);

/** 输入总字节数，用来验「这是重封装不是转码」 */
function inputBytes(track) {
  return track.segments.reduce((sum, s) => sum + s.byteLength, track.init.byteLength);
}

/**
 * 把几块字节拼成一块。
 *
 * 抓流那条路就是这么拼的：采集到的是若干个 `appendBuffer` 的原始字节，
 * 合并前按**到达顺序**接起来 —— 于是"到达顺序"这件事本身就是被测试的对象
 * （见下面「分片乱序/重复到达」那条用例）。
 */
function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

/* ------------------------------------------------------------------ *
 * 前置：解析 init 段和分片
 * ------------------------------------------------------------------ */

test('init 段解析：timescale、解码器配置记录、宽高/声道采样率都对', () => {
  const v = parseInitSegment(videoInput().init);
  assert.equal(v.contentType, 'video');
  assert.equal(v.codecType, 'avc1');
  assert.equal(v.timescale, 12800);
  assert.equal(v.width, 640);
  assert.equal(v.height, 360);
  assert.equal(v.decodeDescriptionName, 'avcC');
  assert.equal(v.description instanceof Uint8Array, true);
  assert.ok(v.description.byteLength > 10, 'avcC 至少要能放下 SPS/PPS');
  // avcC 的第 1 个字节是 configurationVersion，规范里必须是 1
  assert.equal(v.description[0], 1);
  // 源 init 段的 elst 把呈现起点定在 1024 tick 上，它是音画同步的依据
  assert.equal(v.editMediaTime, 1024);

  const a = parseInitSegment(audioInput().init);
  assert.equal(a.contentType, 'audio');
  assert.equal(a.codecType, 'mp4a');
  assert.equal(a.timescale, 48000);
  assert.equal(a.sampleRate, 48000);
  assert.equal(a.channels, 1);
  assert.equal(a.objectTypeIndication, 0x40, 'AAC');
  assert.equal(a.decodeDescriptionName, 'AudioSpecificConfig');
  assert.equal(a.editMediaTime, 1024);

  const asc = parseAudioSpecificConfig(a.description);
  assert.equal(asc.audioObjectType, 2, 'AAC-LC');
  assert.equal(asc.sampleRate, 48000);
  assert.equal(asc.channels, 1);
});

test('切样本：moof/traf/trun 读对了，关键帧也标对了', () => {
  const vInit = parseInitSegment(videoInput().init);
  const vFirst = extractSegmentSamples(videoInput().segments[0], vInit);
  assert.equal(vFirst.samples.length, 50, '视频每段 50 帧（2 秒 @25fps）');
  assert.equal(vFirst.samples[0].dts, 0);
  assert.equal(vFirst.samples[0].isSync, true, '每段第一个样本必须是关键帧');
  assert.equal(vFirst.samples.slice(1).every((s) => !s.isSync), true, '其余不是关键帧');
  assert.equal(vFirst.samples.every((s) => s.duration === 512), true);
  assert.equal(vFirst.nextDts, 50 * 512, '下一段的 DTS 要接得上');
  // 样本数据是 mdat 的切片，加起来必须正好是 mdat 的净荷
  const vBytesIn = inputBytes(videoInput());
  const totalSamples = vFirst.samples.reduce((sum, s) => sum + s.data.byteLength, 0);
  assert.ok(totalSamples < vFirst.samples.length * 20000 && totalSamples > 0);
  assert.ok(vBytesIn > totalSamples, '分片里除了样本还有 moof/sidx 这些盒子');

  const aInit = parseInitSegment(audioInput().init);
  const aFirst = extractSegmentSamples(audioInput().segments[0], aInit);
  assert.equal(aFirst.samples.length, 91);
  assert.equal(aFirst.samples.every((s) => s.duration === 1024), true);
  assert.equal(aFirst.samples.every((s) => s.isSync), true, 'AAC 每帧都是同步样本');
  assert.equal(aFirst.samples.every((s) => s.ctsOffset === 0), true, '音频没有 B 帧重排');
  assert.equal(aFirst.nextDts, 91 * 1024);

  // 视频有 B 帧，composition offset 不能是 0，而且第一帧有领先量
  assert.equal(vFirst.samples[0].ctsOffset, 1024);
  assert.ok(vFirst.samples.some((s) => s.ctsOffset === 0));

  // 分段接着喂，时间轴必须连续
  const vAll = videoInput().segments.reduce((acc, seg) => {
    const r = extractSegmentSamples(seg, vInit, acc.nextDts);
    return { samples: [...acc.samples, ...r.samples], nextDts: r.nextDts };
  }, { samples: [], nextDts: 0 });
  assert.equal(vAll.samples.length, 300, '6 段 × 50 帧');
  assert.equal(vAll.samples[299].dts + 512, 300 * 512, '视频时间轴正好 12 秒');
});

/* ------------------------------------------------------------------ *
 * 大产物：样本数一多，`push(...arr)` 就会把栈用光
 *
 * 用户报的：抓流到 166 MB 时，「先保存已录到的部分」「停止并保存」同时失败，
 * 报 `Maximum call stack size exceeded`；而几十 MB 的产物一直好好的。
 *
 * 原因不在 mp4-muxer（单独喂 12 万个样本它没事），在我自己的 `collectTrack`：
 * 抓流把所有分片拼成**一段**再交进来，于是 `samples.push(...result.samples)`
 * 一次就要展开整条视频的样本 —— 展开运算符是按**函数实参**走的，V8 上限大约
 * 12 万。这条用例就是造一个样本数超限的分片，逼它重现。
 * ------------------------------------------------------------------ */

/**
 * 造一个含 `count` 个样本的 fMP4 媒体分片。
 *
 * 结构照 ISO/IEC 14496-12 写：moof（mfhd + traf（tfhd + tfdt + trun））+ mdat。
 * 每个样本 1 字节、时长 1000，全部标成关键帧。
 * 尺寸按规范逐项算：trun 的每个样本条目是 4+4+4+4 = 16 字节
 * （duration / size / flags / composition offset 都写了）。
 */
function buildFragmentWithSamples(count, trackId) {
  const mfhdSize = 16;                       // 8 + verflags + sequence_number
  const tfhdSize = 20;                       // 8 + verflags + track_id + default_sample_flags
  const tfdtSize = 20;                       // 8 + verflags + 64 位 baseMediaDecodeTime
  const trunSize = 8 + 4 + 4 + 4 + count * 16; // 头 + verflags + 样本数 + data_offset + 样本表
  const trafSize = 8 + tfhdSize + tfdtSize + trunSize;
  const moofSize = 8 + mfhdSize + trafSize;
  const mdatSize = 8 + count;
  const sampleDataOffset = moofSize + 8;     // 样本数据 = mdat 的 payload 起点

  const out = new Uint8Array(moofSize + mdatSize);
  const view = new DataView(out.buffer);
  let at = 0;
  const box = (type, size) => {
    view.setUint32(at, size);
    for (let i = 0; i < 4; i += 1) out[at + 4 + i] = type.charCodeAt(i);
    at += 8;
  };
  const u32 = (v) => { view.setUint32(at, v); at += 4; };

  box('moof', moofSize);
  box('mfhd', mfhdSize);
  u32(0); u32(1);                            // version/flags，sequence number
  box('traf', trafSize);
  box('tfhd', tfhdSize);
  u32(0x020000);                             // version/flags：default-base-is-moof
  u32(trackId);
  u32(0x02000000);                           // default_sample_flags：关键帧
  box('tfdt', tfdtSize);
  u32(0x01000000);                           // version 1
  u32(0); u32(0);                            // baseMediaDecodeTime = 0
  box('trun', trunSize);
  // trun 的 flags：data-offset(0x1) + duration(0x100) + size(0x200) + flags(0x400) + cto(0x800)。
  // 少了这些位，解析端就不会去读对应的字段（第一次就写成了只有 data-offset）。
  u32(0x000F01);
  u32(count);
  u32(sampleDataOffset);
  for (let i = 0; i < count; i += 1) {
    u32(1000);                               // sample_duration
    u32(1);                                  // sample_size
    u32(0x02000000);                         // sample_flags：关键帧
    u32(0);                                  // sample_composition_time_offset
  }
  assert.equal(at, moofSize, '写 moof 的字节数应该正好等于算出来的长度');
  box('mdat', mdatSize);
  return out;
}

test('大产物：单个分片里 15 万个样本也不能把栈用光', () => {
  // 用真实的 init 段（trackId 从它里面读，保证和造出来的分片对得上）
  const init = readFixtureBytes('dash-split', 'init-stream0.m4s');
  const info = parseInitSegment(init);
  const big = buildFragmentWithSamples(150000, info.trackId);

  const extracted = extractSegmentSamples(big, info);
  assert.equal(extracted.samples.length, 150000, '应该一个不少地切出 15 万个样本');
});

test('大产物：15 万个样本能真的封出来（不是只到取样本那一步）', () => {
  const init = readFixtureBytes('dash-split', 'init-stream0.m4s');
  const info = parseInitSegment(init);
  const big = buildFragmentWithSamples(150000, info.trackId);

  const merged = mergeFmp4({ video: { init, segments: [big] } });
  assert.ok(merged.byteLength > 150000, `产物应该有一百多 KB 以上，实际 ${merged.byteLength}`);
  // 头几个字节必须是 ftyp —— 说明真的走完了封装
  assert.equal(String.fromCharCode(merged[4], merged[5], merged[6], merged[7]), 'ftyp');
});


/* ------------------------------------------------------------------ *
 * AV1：B 站现在发的就是这种，样本描述项从 avc1 变成了 av01
 *
 * 这条用例是用户报的 bug 逼出来的：他抓 B 站的两条自包含轨道，
 * 视频那条是 AV1（`stsd → av01 → av1C`），而合并器只认识 `avcC`/`hvcC`，
 * 于是报「拿不到 H.264/H.265 解码器配置记录」，退化成"只存最大的一条轨道"
 * —— 用户拿到一个没有声音的视频。
 *
 * 同一个结构、只是名字不同，所以这里既验"能认出来"，也验"产物真的能播"。
 * ------------------------------------------------------------------ */

const av1Track = (name) => {
  const bytes = readFixtureBytes('av1-tracks', name);
  const split = splitSelfContainedFmp4(bytes);
  return { init: split.init, segments: [split.fragments] };
};

test('AV1：初始化段能认出来，解码器配置记录来自 av1C', () => {
  const info = parseInitSegment(av1Track('video.m4s').init);
  assert.equal(info.contentType, 'video');
  assert.equal(info.codecType, 'av01', '样本描述项应该是 av01');
  assert.equal(info.decodeDescriptionName, 'av1C', '配置记录应该从 av1C 里拿');
  assert.ok(info.description && info.description.byteLength >= 4, 'av1C 的内容要拿到');
  assert.equal(info.width, 320);
});

test('AV1：和音频合并成标准 MP4，ffprobe 读到 av1 + aac', { skip: noProbe }, () => {
  const merged = mergeFmp4({ video: av1Track('video.m4s'), audio: av1Track('audio.m4s') });
  assert.ok(merged.byteLength > 10000);

  const out = writeTmp('av1-merged.mp4', [merged]);
  const info = probe(out);
  const v = videoStream(info);
  const a = audioStream(info);
  assert.ok(v, '应该读到视频轨');
  assert.equal(v.codec_name, 'av1', `视频编码应该是 av1，实际 ${v.codec_name}`);
  assert.ok(a, '应该读到音频轨');
  assert.equal(a.codec_name, 'aac');
  const duration = Number(info.format.duration);
  assert.ok(duration > 5 && duration < 7, `时长应该约 6 秒，实际 ${duration}`);
});

test('AV1：产物不只是"能被 ffprobe 读出来"，是真的能解码出画面', { skip: noProbe }, () => {
  // ffprobe 只读头部，一个 av1C 写错的文件它照样能读出"av1 / 320x180"。
  // 所以这里真的解一遍：把每个视频包都送进解码器，数出来的帧数必须对得上。
  const merged = mergeFmp4({ video: av1Track('video.m4s'), audio: av1Track('audio.m4s') });
  const out = writeTmp('av1-merged-decode.mp4', [merged]);
  const decoded = countDecodedVideoFrames(out);
  assert.ok(decoded > 100, `应该解出 100 帧以上（约 150 帧），实际 ${decoded}`);
});



test('合并产物：ffprobe 同时读到 h264 视频轨和 aac 音频轨，640x360，约 12 秒', { skip: noProbe }, () => {
  const video = videoInput();
  const audio = audioInput();
  const merged = mergeFmp4({ video, audio });
  assert.equal(merged instanceof Uint8Array, true);
  assert.ok(merged.byteLength > 1000);

  const out = writeTmp('dash-merged.mp4', [merged]);
  const info = probe(out);
  const v = videoStream(info);
  const a = audioStream(info);

  // 把 ffprobe 实际读到的内容打出来 —— 断言写的只是这些数字
  console.log(`    ffprobe：${info.format.format_name} · 时长 ${info.format.duration} 秒 · ${info.streams.length} 条轨`);
  for (const s of info.streams) {
    console.log(`      ${s.codec_type}: ${s.codec_name}${s.profile ? ` (${s.profile})` : ''}`
      + `${s.width ? ` ${s.width}x${s.height}` : ''}`
      + `${s.sample_rate ? ` ${s.sample_rate} Hz ${s.channels}ch` : ''}`
      + ` · 起点 ${s.start_time} · 时长 ${s.duration} · 帧 ${s.nb_frames ?? '?'}`);
  }

  assert.equal(info.streams.length, 2, '产物必须正好两条轨');
  assert.ok(v, '必须有视频轨');
  assert.ok(a, '必须有音频轨');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.width, 640);
  assert.equal(v.height, 360);
  assert.equal(a.codec_name, 'aac');
  assert.equal(Number(a.sample_rate), 48000);
  assert.equal(Number(a.channels), 1);

  const duration = Number(info.format.duration);
  assert.ok(Math.abs(duration - 12) < 0.7, `时长应约 12 秒，实际 ${duration.toFixed(3)}`);

  // 两条轨的起点由**源流的 elst**决定，而不是被强行对齐成 0：
  //   视频：源 elst media_time = 1024/12800 = 0.08 s，正好等于它第一个样本的
  //         composition 领先量 → 源流的意思是"第一帧就呈现在影片 0 秒"。
  //         产物不改写源流的意图，而是把"谁先开始"整体挪到第一个样本上，所以
  //         ffprobe 读到视频起点 0.08（那 80 ms 是 B 帧呈现领先量，不是黑场）。
  //   音频：源 elst media_time = 1024/48000 ≈ 0.0213 s → 它比影片 0 秒晚 21.3 ms。
  // 两条轨的**相对**偏移必须和源流一致（0.08 − 0.0213 ≈ 0.0587）。
  //
  // 这里曾经断言"两条轨都从 0 开始"——那是把 elst 当"裁掉开头"用；而抓流可以
  // 从中间开始，那时同样的写法会写出"开头空几千秒"的产物（见 mergeFmp4 的注释）。
  assert.ok(Math.abs(Number(v.start_time) - 0.08) < 0.02, `视频起点应保留 80ms 的呈现领先量，实际 ${v.start_time}`);
  assert.ok(Math.abs(Number(a.start_time) - 0.0587) < 0.01, `音频起点应约 58.7ms，实际 ${a.start_time}`);
  // 两条轨之间的差（0.08 − 0.0587 = 0.0213）就是源流 elst 里那 21.3 ms，不能被抹平
  assert.ok(Math.abs((Number(v.start_time) - Number(a.start_time)) - 0.0213) < 0.015,
    `两条轨的相对偏移应保持源流的 21.3ms，实际 ${(Number(v.start_time) - Number(a.start_time)).toFixed(4)}`);
  assert.equal(v.nb_frames, '300', '视频 12 秒 25fps');
});

test('从中间开始的一段（源 6 秒之后）：时间轴按抓到的第一个样本归零，不带空白', { skip: noProbe }, () => {
  // 用户可以在片子播到第 40 分钟时才点抓流。这时源流的绝对时间轴还在，但样本
  // 是从第几千秒开始的 —— 如果照抄源 elst 的绝对原点，产物会变成
  // «mvhd.duration = 内容长度 + 起点» 且开头一大段**一个样本都没有**，
  // 播放器里拖动进度条会直接弹回第一个样本（用户报的"点中间却播前一段"）。
  const video = videoInput();
  const audio = audioInput();
  // 视频第 4~6 段（源 6.000~12.000 秒），音频第 4~7 段（源 5.952~12.002 秒）
  const merged = mergeFmp4({
    video: { init: video.init, segments: video.segments.slice(3) },
    audio: { init: audio.init, segments: audio.segments.slice(3) },
  });

  const out = writeTmp('dash-midstream.mp4', [merged]);
  const info = probe(out);
  const v = videoStream(info);
  const a = audioStream(info);

  const duration = Number(info.format.duration);
  console.log(`    中途开始的一段：时长 ${duration.toFixed(3)} 秒（源片段 6.08 秒）`
    + ` · 视频起点 ${v.start_time} · 音频起点 ${a.start_time} · 帧 ${v.nb_frames}/${a.nb_frames}`);
  assert.ok(Math.abs(duration - 6.08) < 0.3, `时长应是抓到的这 6.08 秒，实际 ${duration.toFixed(3)}`);
  assert.ok(duration < 7, '不能把源流的绝对起点算进时长（那会变成 12 秒甚至几千秒）');
  // 两条轨都得贴近 0：晚开始的那条用空编辑表达，差值只有几十毫秒
  assert.ok(Math.abs(Number(v.start_time)) < 0.11, `视频起点应贴近 0，实际 ${v.start_time}`);
  assert.ok(Math.abs(Number(a.start_time)) < 0.11, `音频起点应贴近 0，实际 ${a.start_time}`);
  // 一个样本都不能丢：音频 #4~#7 = 94+93+94+4，视频 3×50
  assert.equal(v.nb_frames, '150', '视频 6 秒 25fps');
  assert.equal(a.nb_frames, '285', '音频样本一个不能少（空编辑只推迟，不裁剪）');
});

test('产物是重封装不是转码：字节量相当，样本数据没有丢', { skip: noProbe }, () => {
  const video = videoInput();
  const audio = audioInput();
  const merged = mergeFmp4({ video, audio });

  const input = inputBytes(video) + inputBytes(audio);
  const ratio = merged.byteLength / input;
  console.log(`    输入 ${input} B → 产物 ${merged.byteLength} B（${(ratio * 100).toFixed(1)}%）`);
  // 产物比输入少了 moof/styp/sidx 这些分片壳子，多了一个 moov；
  // 差得太多说明样本被丢了或者被重新编码了
  assert.ok(ratio > 0.9 && ratio < 1.05, `产物字节量应在输入的 90%~105%，实际 ${(ratio * 100).toFixed(1)}%`);

  const out = writeTmp('dash-merged-size.mp4', [merged]);
  const info = probe(out);
  const audioFrames = Number(audioStream(info).nb_frames);
  assert.ok(audioFrames >= 560, `音频帧数应约为 564，实际 ${audioFrames}`);

  // 产物真的写到了盘上，不是内存里一个空壳
  assert.ok(statSync(out).size === merged.byteLength);
});

test('从分片里读媒体时间轴起点（tfdt）：只走盒子，不解样本', () => {
  // 这个 reader 是"自动保存按**视频内容** 10 分钟算"的地基：读错了，
  // 存的节奏就是错的（而且错得很隐蔽 —— 文件照样出得来）。
  // 拿真实夹具对：视频 timescale 12800、每片 2 秒；音频 48000、每片约 1.94 秒。
  const v = videoInput();
  const a = audioInput();
  const vInfo = parseInitSegment(v.init);
  const aInfo = parseInitSegment(a.init);
  assert.equal(vInfo.timescale, 12800);
  assert.equal(aInfo.timescale, 48000);

  for (const [index, seconds] of [[0, 0], [1, 2], [5, 10]]) {
    const got = readFragmentMediaTime(v.segments[index]);
    assert.ok(got, '应该能读出 tfdt');
    assert.equal(got.trackId, 1);
    assert.ok(Math.abs(got.baseMediaDecodeTime / vInfo.timescale - seconds) < 0.001,
      `第 ${index + 1} 片的起点应该是 ${seconds} 秒，实际 ${got.baseMediaDecodeTime / vInfo.timescale}`);
  }
  const audio = readFragmentMediaTime(a.segments[1]);
  assert.ok(audio, '音频轨也要读得到（两条轨一起算，取最长的那条）');
  assert.ok(Math.abs(audio.baseMediaDecodeTime / aInfo.timescale - 1.94) < 0.01);

  // 初始化段（没有 moof）、垃圾、空输入：一律 null，不能抛
  assert.equal(readFragmentMediaTime(v.init), null, 'init 段没有 tfdt');
  assert.equal(readFragmentMediaTime(new Uint8Array(20)), null);
  assert.equal(readFragmentMediaTime(null), null);
});

test('抓流的分片乱序/重复到达：合并自己排好、去掉重复，而不是当场报错', { skip: noProbe }, () => {
  // 用户报的现象：**暂停视频后再点「停止并保存」**，收到
  //   addVideoChunkRaw's third argument (timestamp) must be a non-negative real number.
  // 然后 334 段 / 34.7 MB 一起没了。
  //
  // 根因：抓流采到的分片**不一定按时间顺序到**。播放器重新缓冲、往回拖一点、
  // 暂停再继续，都可能把已经送过的分片再 append 一次（字节不完全一样，所以按
  // 内容指纹去重拦不住）。拼起来就是「第 2 片、第 1 片」，而归零用的是第一个
  // 样本 —— 后面那些更早的样本就成了负时间戳，mp4-muxer 直接抛错。
  //
  // 这里用 dash-split 的第 1、2 片（源 0~2 秒 / 2~4 秒）拼出三种到达顺序，
  // 断言产物**和正序完全一样**：时长 4 秒、100 帧、起点一致。
  const v = videoInput();
  const a = audioInput();
  const frag = (track, i) => track.segments[i];

  const cases = {
    '正序（正常情况）': { v: [frag(v, 0), frag(v, 1)], a: [frag(a, 0), frag(a, 1)] },
    '倒序（第 2 片先到，之后才补第 1 片）': { v: [frag(v, 1), frag(v, 0)], a: [frag(a, 1), frag(a, 0)] },
    '重复（同一片 append 了两次）': {
      v: [frag(v, 0), frag(v, 1), frag(v, 1)],
      a: [frag(a, 0), frag(a, 1), frag(a, 1)],
    },
  };

  const results = {};
  for (const [name, parts] of Object.entries(cases)) {
    const warnings = [];
    let merged;
    try {
      merged = mergeFmp4({
        video: { init: v.init, segments: [concatBytes(parts.v)] },
        audio: { init: a.init, segments: [concatBytes(parts.a)] },
      }, { onWarning: (w) => warnings.push(String(w)) });
    } catch (err) {
      assert.fail(`${name}：不该抛错，实际抛了「${err.message}」`);
    }
    const out = writeTmp(`dash-messy-${Object.keys(cases).indexOf(name)}.mp4`, [merged]);
    const info = probe(out);
    results[name] = {
      bytes: merged.byteLength,
      duration: Number(info.format.duration),
      frames: Number(videoStream(info).nb_frames),
      audioFrames: Number(audioStream(info).nb_frames),
      warnings,
    };
    console.log(`    ${name}：${(merged.byteLength / 1024).toFixed(0)} KB｜时长 ${results[name].duration.toFixed(2)} 秒`
      + `｜视频 ${results[name].frames} 帧｜音频 ${results[name].audioFrames} 帧`
      + `｜提示 ${warnings.length} 条`);
  }

  const base = results['正序（正常情况）'];
  assert.ok(Math.abs(base.duration - 4) < 0.3, `正序产物应约 4 秒，实际 ${base.duration.toFixed(2)}`);
  for (const [name, r] of Object.entries(results)) {
    assert.ok(Math.abs(r.duration - base.duration) < 0.1, `${name}：时长该和正序一样，实际 ${r.duration.toFixed(3)} vs ${base.duration.toFixed(3)}`);
    assert.equal(r.frames, base.frames, `${name}：视频帧数该和正序一样`);
    assert.equal(r.audioFrames, base.audioFrames, `${name}：音频帧数该和正序一样`);
    assert.equal(r.bytes, base.bytes, `${name}：产物字节数该和正序一样（同样的样本，只是到达顺序不同）`);
  }
  // 乱序和重复必须**说出来**，不能悄悄改用户的样本
  assert.ok(results['倒序（第 2 片先到，之后才补第 1 片）'].warnings.some((w) => /顺序是乱的/.test(w)),
    `乱序没说：${JSON.stringify(results['倒序（第 2 片先到，之后才补第 1 片）'].warnings)}`);
  assert.ok(results['重复（同一片 append 了两次）'].warnings.some((w) => /重复样本/.test(w)),
    `去重没说：${JSON.stringify(results['重复（同一片 append 了两次）'].warnings)}`);
});

test('只有视频没有音频时，优雅地产出单轨 MP4', { skip: noProbe }, () => {
  const merged = mergeFmp4({ video: videoInput() });
  const out = writeTmp('dash-video-only.mp4', [merged]);
  const info = probe(out);
  const v = videoStream(info);

  console.log(`    纯视频产物：${info.format.duration} 秒，${info.streams.length} 条轨，${v.codec_name} ${v.width}x${v.height}，帧 ${v.nb_frames}`);

  assert.equal(info.streams.length, 1, '不该凭空多出一条轨');
  assert.equal(audioStream(info), undefined);
  assert.ok(v, '必须有视频轨');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.width, 640);
  assert.equal(v.height, 360);
  assert.equal(v.nb_frames, '300');
  assert.ok(Math.abs(Number(info.format.duration) - 12) < 0.7, `时长应约 12 秒，实际 ${info.format.duration}`);
});

test('只有音频也能产出单轨 MP4（顺带验一下奇数路上的 trackId 分配）', { skip: noProbe }, () => {
  const merged = mergeFmp4({ audio: audioInput() });
  const out = writeTmp('dash-audio-only.mp4', [merged]);
  const info = probe(out);
  const a = audioStream(info);
  console.log(`    纯音频产物：${info.format.duration} 秒，${a.codec_name} ${a.sample_rate} Hz ${a.channels}ch`);
  assert.equal(info.streams.length, 1);
  assert.equal(videoStream(info), undefined);
  assert.equal(a.codec_name, 'aac');
  assert.equal(Number(a.sample_rate), 48000);
  assert.ok(Math.abs(Number(info.format.duration) - 12) < 0.7);
});

/* ------------------------------------------------------------------ *
 * 错误输入
 * ------------------------------------------------------------------ */

test('错误输入要有明确的中文错误，不能悄悄产出坏文件', () => {
  assert.throws(() => mergeFmp4(), /至少一路输入/);
  assert.throws(() => mergeFmp4({}), /至少一路输入/);

  // 视频位置塞了音频：必须在封装之前就发现
  assert.throws(() => mergeFmp4({ video: audioInput() }), /对不上|传反/);

  // 拿 TS 分片当 init
  const tsSegment = bytesAt(fixturePath('hls-ts', 'v0', 'seg_000.ts'));
  assert.throws(() => mergeFmp4({ video: { init: tsSegment, segments: [tsSegment] } }), /moov/);

  // init 对但一个分片都没有
  const v = videoInput();
  assert.throws(() => mergeFmp4({ video: { init: v.init, segments: [] } }), /一个媒体分片都没有/);

  // 分片位置塞了 init 段（没有 moof）
  assert.throws(() => mergeFmp4({ video: { init: v.init, segments: [v.init] } }), /moof/);

  // 传了 undefined
  assert.throws(() => mergeFmp4({ video: { init: undefined, segments: [v.segments[0]] } }), /缺少 init 段/);
  assert.throws(() => mergeFmp4({ video: { init: v.init, segments: ['不是字节'] } }), /Uint8Array|ArrayBuffer/);
});

/* ------------------------------------------------------------------ *
 * HLS 那条路：合并函数不能假设输入来自 DASH
 *
 * Apple 的 HLS 测试流里，主列表给每个变体标了 AUDIO="audN"，独立音轨在
 * 另一条 #EXT-X-MEDIA 指向的播放列表里 —— 和 DASH 一样是音视频分离，
 * 而且更常见。所以这里必须验三种输入形态：
 *   1. 一路一条轨（DASH 分离流）      → 上面那些用例
 *   2. mux.js 把 TS 重封装出来的 fMP4（一个 init 里两条 trak，一个分片里两个 moof）
 *   3. 音视频复用的 fMP4，同一份字节既当视频又当音频喂进去
 * 后两种就是「上层先用 mux.js 把 TS 转成 fMP4 再喂过来」这条路。
 * ------------------------------------------------------------------ */

/** 用 mux.js 把仓库里的 TS 素材重封装成 fMP4（浏览器里下载 HLS(TS) 走的就是这一步） */
function remuxTsToFmp4(files) {
  const chunks = { init: null, segments: [] };
  const remuxer = createTsRemuxer(loadVendorMuxjs(), {
    onInit: (b) => { if (!chunks.init) chunks.init = b; },
    onFragment: (b) => chunks.segments.push(b),
  });
  for (const name of files) remuxer.append(readFixtureBytes('hls-ts', 'v0', name));
  remuxer.end();
  assert.ok(chunks.init, 'mux.js 必须产出初始化段');
  assert.equal(chunks.segments.length, files.length, '每个 TS 分片产出一个 fMP4 分片');
  return chunks;
}

test('mux.js 产出的 fMP4：一个 init 两条 trak、一个分片两个 moof，也要能合并', { skip: noProbe }, () => {
  const input = remuxTsToFmp4(['seg_000.ts', 'seg_001.ts']);

  const v = parseInitSegment(input.init, { contentType: 'video' });
  const a = parseInitSegment(input.init, { contentType: 'audio' });
  assert.equal(v.contentType, 'video');
  assert.equal(a.contentType, 'audio');
  assert.notEqual(v.trackId, a.trackId, '两条轨的 trackId 必须不同，否则抽样本抽不开');
  assert.equal(v.width, 640);
  assert.equal(v.height, 360);
  assert.equal(a.sampleRate, 48000);

  // mux.js 把一个分片写成「audio 的 moof+mdat，再 video 的 moof+mdat」，
  // 只认第一个 moof 的话视频轨会一个样本都切不出来
  const vSamples = extractSegmentSamples(input.segments[0], v);
  assert.equal(vSamples.samples.length, 50, '视频样本在第二个 moof 里');
  const aSamples = extractSegmentSamples(input.segments[0], a);
  assert.equal(aSamples.samples.length, 91, '音频样本在第一个 moof 里');

  const merged = mergeFmp4({ video: input, audio: input });
  const info = probe(writeTmp('hls-ts-merged.mp4', [merged]));
  console.log(`    TS→mux.js→合并：${info.format.duration} 秒 · `
    + info.streams.map((s) => `${s.codec_type}/${s.codec_name} ${s.width ? `${s.width}x${s.height}` : `${s.sample_rate}Hz`} start=${s.start_time}`).join(' · '));

  const vo = videoStream(info);
  const ao = audioStream(info);
  assert.equal(info.streams.length, 2);
  assert.equal(vo.codec_name, 'h264');
  assert.equal(vo.width, 640);
  assert.equal(vo.height, 360);
  assert.equal(ao.codec_name, 'aac');
  assert.ok(Math.abs(Number(info.format.duration) - 4) < 0.7, `2 个分片约 4 秒，实际 ${info.format.duration}`);

  // 起点不一样也要对齐：视频 tfdt=0，音频 tfdt=2816/48000≈58.7 ms，
  // 这个差量必须靠 elst 的空编辑保住，不能被「都归零」吃掉
  assert.ok(Math.abs(Number(vo.start_time) - 0.08) < 0.02, `视频起点应约 0.08，实际 ${vo.start_time}`);
  assert.ok(Math.abs(Number(ao.start_time) - 0.0587) < 0.01, `音频起点应保留 58.7 ms 的偏移，实际 ${ao.start_time}`);
  assert.ok(Math.abs(Number(ao.start_time) - Number(vo.start_time)) > 0.001, '这两条轨的起点本来就不一样，不该被强行对齐成同一个数');
});

test('音视频复用的单个 fMP4：同一份字节当两路输入也能拆成两条轨', { skip: noProbe }, () => {
  // 仓库里 hls-fmp4 就是一个 init 里带 video+audio 的复用流
  const muxed = {
    init: readFixtureBytes('hls-fmp4', 'init.mp4'),
    segments: [0, 1, 2, 3, 4, 5].map((i) => readFixtureBytes('hls-fmp4', `seg_00${i}.m4s`)),
  };
  const v = parseInitSegment(muxed.init, { contentType: 'video' });
  const a = parseInitSegment(muxed.init, { contentType: 'audio' });
  assert.equal(v.contentType, 'video');
  assert.equal(v.trackId, 1);
  assert.equal(a.contentType, 'audio');
  assert.equal(a.trackId, 2);

  const merged = mergeFmp4({ video: muxed, audio: muxed });
  const info = probe(writeTmp('hls-muxed-merged.mp4', [merged]));
  console.log(`    复用 fMP4 拆轨：${info.format.duration} 秒 · `
    + info.streams.map((s) => `${s.codec_type}/${s.codec_name} ${s.nb_frames} 帧`).join(' · '));

  assert.equal(info.streams.length, 2);
  assert.equal(videoStream(info).codec_name, 'h264');
  assert.equal(videoStream(info).nb_frames, '300');
  assert.equal(audioStream(info).codec_name, 'aac');
  assert.ok(Math.abs(Number(info.format.duration) - 12) < 0.7);
});

test('describeMergeInput 能把「读到了什么」说清楚，诊断回调也能把跳过的分片报出来', () => {
  const text = describeMergeInput({ video: videoInput(), audio: audioInput() });
  assert.match(text, /视频 640×360 avc1/);
  assert.match(text, /音频 1 声道 48000 Hz mp4a/);
  assert.match(text, /6 个分片/);
  assert.match(text, /7 个分片/);

  // 坏输入不该把「体检」本身搞崩
  const broken = describeMergeInput({ video: { init: new Uint8Array(4) } });
  assert.match(broken, /视频 解析失败/);
  assert.equal(describeMergeInput({}), '');

  // 复用流里「另一条轨的 traf」属于正常情况，不该刷警告；
  // 但整片都不属于目标轨道时必须报出来，否则就是悄悄丢数据
  const v = videoInput();
  const seen = [];
  const merged = mergeFmp4(
    { video: { init: v.init, segments: [retargetFragment(v.segments[0], 9999), ...v.segments.slice(1)] }, audio: audioInput() },
    { onWarning: (w) => seen.push(w) },
  );
  assert.ok(merged.byteLength > 0, '混进一个不属于本轨的分片不该让合并失败');
  assert.ok(seen.some((w) => w.startsWith('视频轨') && /没有属于目标轨道/.test(w)), `实际：${seen.join(' | ') || '（没有任何警告）'}`);
});

/**
 * 把分片里 tfhd 的 trackId 改掉，模拟「这一片只有另一条轨的数据」。
 * type 在 at..at+3，payload 从 at+4 起，version/flags 之后才是 trackId。
 */
function retargetFragment(bytes, trackId) {
  const copy = bytes.slice();
  let at = -1;
  for (let i = 0; i + 4 <= copy.length && at < 0; i += 1) {
    if (copy[i] === 0x74 && copy[i + 1] === 0x66 && copy[i + 2] === 0x68 && copy[i + 3] === 0x64) at = i;
  }
  assert.ok(at >= 0, '分片里应该能找到 tfhd');
  const p = at + 8;
  copy[p] = (trackId >>> 24) & 0xff;
  copy[p + 1] = (trackId >>> 16) & 0xff;
  copy[p + 2] = (trackId >>> 8) & 0xff;
  copy[p + 3] = trackId & 0xff;
  return copy;
}

/* ------------------------------------------------------------------ *
 * 同页换集：把**当前的真实行为**钉住
 * ------------------------------------------------------------------ */

/**
 * 这条用例钉的不是"理想行为"，而是**现在确实会发生什么**，因为它是用户
 * 实测报上来的那个现象的机制（见 README 的「已知限制」和 docs/verification.md
 * 第十三轮之后的讨论）：
 *
 *   · 站点在**同一个页面、地址栏都不变**的情况下平滑换集时，我们盯的四个
 *     边界信号（`ended` / `emptied` / `loadstart` / 新的 `SourceBuffer`）
 *     一个都不会来 → **不会自动切片**；
 *   · 而下一集的解码时间戳从 0 重新开始，和上一集完全重叠 → 按 DTS 整理时
 *     "整段都落在已收内容里"的样本会被判成重复丢掉；
 *   · 于是产物**恰好是一集**（这就是用户看到的"第二集的开头没录上去，挺好"）；
 *   · 但下一集**比上一集长**时，超出上一集末尾的那部分**会被静默接在文件尾部**
 *     —— 中间没有空洞，所以事后连"体检"都查不出来。
 *
 * 为什么值得钉住：将来谁去改边界识别，都必须先看到这条用例、明确知道自己在
 * 改变什么。去掉它之前，请先想清楚用户要的是"一集一个文件"还是别的。
 */
test('同页换集：第二集与第一集重叠的样本被丢掉，超出末尾的会被接上（当前真实行为）', () => {
  const ep = (n) => Array.from({ length: n }, (_, i) => ({ dts: i * 100, duration: 100, data: null }));

  // 第一集 4 个样本（0/100/200/300），第二集 6 个样本（0/100/200/300/400/500）
  const { samples, dropped } = normalizeTrackSamples([...ep(4), ...ep(6)]);

  // 前 4 个来自第二集、但和第一集完全重叠 → 丢掉；第二集多出来的 400/500 被接上
  assert.equal(dropped, 4);
  assert.deepEqual(samples.map((s) => s.dts), [0, 100, 200, 300, 400, 500]);

  // 换一个更短的"第二集"：全部重叠 → 产物理所当然只有第一集（用户看到的"干净的一集"）
  const shorter = normalizeTrackSamples([...ep(4), ...ep(2)]);
  assert.deepEqual(shorter.samples.map((s) => s.dts), [0, 100, 200, 300]);
  assert.equal(shorter.dropped, 2);
});
