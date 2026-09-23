/**
 * WebM 复用：把拆出来的画面轨 + 音频轨封成一个能播的 `.webm`。
 *
 * 这是"抓流碰到 WebM 站点"那条路的核心：VP9 画面和 Opus 音频**都不重新编码**，
 * 原字节搬进新容器。所以验证的标准也是"真能播"：
 *   · ffprobe 认得出两条轨；
 *   · 画面**真解一遍**，帧数一帧不少（`countDecodedVideoFrames`）；
 *   · 音频解成 PCM 之后估频，要正好是素材那个 440 Hz（不是静音、也不是噪声）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { demuxWebm } from '../src/parser/webm-demux.js';
import { mergeWebm, webmDurationSeconds } from '../src/parser/webm-merge.js';
import {
  fixturePath, probe, writeTmp, hasFfprobe, countDecodedVideoFrames, audioStats,
} from './helpers.mjs';

const noProbe = hasFfprobe() ? false : '本机没有 ffprobe，跳过产物校验';

/** 读一份 WebM 素材并拆成帧（模拟抓流抓到的那一组字节） */
function trackFrom(name) {
  const all = new Uint8Array(readFileSync(fixturePath('webm-vp9', name)));
  const track = demuxWebm(all).tracks[0];
  return track;
}

const videoTrack = () => trackFrom('video.webm');
const audioTrack = () => trackFrom('audio.webm');

test('VP9 画面 + Opus 音频 → 一个 .webm，两条轨都在', { skip: noProbe }, () => {
  const video = videoTrack();
  const audio = audioTrack();
  const merged = mergeWebm({ video, audio });
  assert.ok(merged.byteLength > 0);

  const info = probe(writeTmp('webm-merged.webm', [Buffer.from(merged)]));
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  const a = (info.streams || []).find((s) => s.codec_type === 'audio');
  assert.ok(v, '产物必须有画面轨');
  assert.ok(a, '产物必须有音频轨');
  assert.equal(v.codec_name, 'vp9', '画面是原字节搬过来的，编码不能变');
  assert.equal(a.codec_name, 'opus', '音频也是原字节，不该被转码');
  assert.equal(v.width, 320);
  assert.equal(v.height, 180);
  assert.equal(a.sample_rate, '48000');
  assert.ok(Math.abs(Number(info.format.duration) - 6) < 0.3, `时长应该约 6 秒，实际 ${info.format.duration}`);
});

test('产物里的画面要**真解得出来**，而且一帧不少', { skip: noProbe }, () => {
  const video = videoTrack();
  const merged = mergeWebm({ video, audio: audioTrack() });
  const file = writeTmp('webm-frames.webm', [Buffer.from(merged)]);
  const decoded = countDecodedVideoFrames(file);
  assert.equal(decoded, video.frames.length, `解出来的帧数要和源一致（源 ${video.frames.length} 帧）`);
});

test('产物里的音频要**真有声音**：解出 PCM 之后估频，就是素材那个 440 Hz', { skip: noProbe }, () => {
  const merged = mergeWebm({ video: videoTrack(), audio: audioTrack() });
  const file = writeTmp('webm-audio.webm', [Buffer.from(merged)]);
  const stats = audioStats(file, { rate: 48000, seconds: 5 });
  assert.ok(stats.rms > 0.01, `不能是静音（RMS ${stats.rms}）`);
  assert.ok(Math.abs(stats.hz - 440) <= 12, `估频应该是 440 Hz，实际 ${stats.hz} Hz`);
});

test('时间戳按绝对时间对齐：音频晚 1 秒开始，产物里也要晚 1 秒', { skip: noProbe }, () => {
  // Matroska 用绝对时间戳表达"这条轨从第几秒开始"，所以不需要 MP4 那套 elst。
  // 这一条就是在钉这个差别：各轨归零会把这一秒吃掉，变成音画不同步。
  const audio = audioTrack();
  for (const frame of audio.frames) frame.timeUs += 1_000_000;
  const merged = mergeWebm({ video: videoTrack(), audio });
  const info = probe(writeTmp('webm-late-audio.webm', [Buffer.from(merged)]));
  const a = (info.streams || []).find((s) => s.codec_type === 'audio');
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  assert.ok(a && v);
  assert.ok(Math.abs(Number(a.start_time) - 1) < 0.1, `音频起点应约 1 秒，实际 ${a.start_time}`);
  assert.ok(Math.abs(Number(v.start_time)) < 0.1, `画面起点应约 0，实际 ${v.start_time}`);
});

test('只有画面也能出片（不强行要求有音轨）', { skip: noProbe }, () => {
  const merged = mergeWebm({ video: videoTrack() });
  const info = probe(writeTmp('webm-video-only.webm', [Buffer.from(merged)]));
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  assert.ok(v);
  assert.equal(v.codec_name, 'vp9');
  assert.equal((info.streams || []).length, 1, '不该凭空多出一条轨');
});

test('时长按最后一帧算（WebM 没有 mvhd 可读）', () => {
  const video = videoTrack();
  const seconds = webmDurationSeconds([video]);
  assert.ok(Math.abs(seconds - 6) < 0.2, `实际 ${seconds}`);
  assert.equal(webmDurationSeconds([]), null);
});

test('WebM 装不了的编码要明确拒绝，而不是产出坏文件', () => {
  const video = videoTrack();
  const audio = audioTrack();
  assert.throws(
    () => mergeWebm({ video: { ...video, codecId: 'V_MPEG4/ISO/AVC' }, audio }),
    /暂不支持的 WebM 画面编码/,
  );
  assert.throws(
    () => mergeWebm({ video, audio: { ...audio, codecId: 'A_AAC' } }),
    /WebM 里放不了这种音频编码/,
  );
  assert.throws(() => mergeWebm({ video: { ...video, width: 0 } }), /画面尺寸不合法/);
  assert.throws(() => mergeWebm({ video: { ...video, frames: [] } }), /一帧都没有/);
  assert.throws(() => mergeWebm({}), /至少一条轨/);
});
