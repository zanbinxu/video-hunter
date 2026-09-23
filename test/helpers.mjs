/**
 * 测试公用工具。
 *
 * 两个约束值得写下来：
 *  1. 当前沙箱禁止管道式 stdio，所以任何子进程都必须用
 *     stdio: ['ignore','inherit','inherit']，不能捕获 stdout。
 *     于是 ffprobe 的输出走 `-o <文件>`，由我们自己读回来。
 *  2. 要验的是「真正会发布的那个 mux.min.js」，不是 node_modules 里的另一份构建。
 *     所以这里用 vm 加载 vendor 里的文件，并给它一个 require 垫片
 *     （bundle 里对 `global/window` 有一个外部依赖）。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import vm from 'node:vm';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = join(ROOT, 'test', 'fixtures');
export const TMP = join(ROOT, '.tmp');

/** 测试里用的假站点源，用来验证相对路径解析 */
export const ORIGIN = 'http://vh.test/';

export function fixturePath(...parts) {
  return join(FIXTURES, ...parts);
}

export function readFixture(...parts) {
  return readFileSync(fixturePath(...parts), 'utf8');
}

export function readFixtureBytes(...parts) {
  return new Uint8Array(readFileSync(fixturePath(...parts)));
}

/** 相对路径 → 假站点 URL */
export function urlFor(rel) {
  return ORIGIN + String(rel).replace(/\\/g, '/');
}

/** 假站点 URL → 磁盘路径 */
export function pathFromUrl(u) {
  const { pathname } = new URL(u);
  return join(FIXTURES, decodeURIComponent(pathname.replace(/^\//, '')));
}

export function ensureTmp() {
  mkdirSync(TMP, { recursive: true });
  return TMP;
}

/* ------------------------------------------------------------------ *
 * mux.js
 * ------------------------------------------------------------------ */

let cachedMuxjs = null;

/** 加载 vendor/mux.min.js —— 就是扩展在浏览器里 <script> 加载的那一份 */
export function loadVendorMuxjs() {
  if (cachedMuxjs) return cachedMuxjs;
  const vendorPath = join(ROOT, 'vendor', 'mux.min.js');
  if (!existsSync(vendorPath)) {
    throw new Error('vendor/mux.min.js 不存在，先跑 `npm run vendor`');
  }
  const req = createRequire(join(ROOT, 'package.json'));
  const source = readFileSync(vendorPath, 'utf8');
  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: req,
    window: {},
    self: {},
    console,
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(source, vm.createContext(sandbox), { filename: vendorPath });
  cachedMuxjs = mod.exports;
  return cachedMuxjs;
}

/* ------------------------------------------------------------------ *
 * ffprobe
 * ------------------------------------------------------------------ */

let ffprobeChecked = null;

export function hasFfprobe() {
  if (ffprobeChecked != null) return ffprobeChecked;
  try {
    execFileSync('ffprobe', ['-version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    ffprobeChecked = true;
  } catch {
    ffprobeChecked = false;
  }
  return ffprobeChecked;
}

/** 用 ffprobe 读一个媒体文件的结构。这是「产物能不能播」的独立判据。 */
export function probe(file) {
  ensureTmp();
  const out = join(TMP, `probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
  try {
    execFileSync('ffprobe', [
      '-v', 'error',
      '-show_format', '-show_streams',
      '-of', 'json',
      '-o', out,
      file,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally {
    rmSync(out, { force: true });
  }
}

export function videoStream(info) {
  return (info.streams || []).find((s) => s.codec_type === 'video');
}

export function audioStream(info) {
  return (info.streams || []).find((s) => s.codec_type === 'audio');
}

/** 写一个临时产物文件，返回路径 */
export function writeTmp(name, chunks) {
  ensureTmp();
  const file = join(TMP, name);
  writeFileSync(file, Buffer.concat(chunks.map((c) => Buffer.from(c))));
  return file;
}

/**
 * 把整个文件真解一遍，返回**解出来的视频帧数**。
 *
 * 为什么不能只靠 ffprobe：ffprobe 只读容器和样本表，一个解码器配置记录写错的
 * 文件它照样能报出「av1 / 320x180 / 6 秒」。要证明"能播"，必须真的送进解码器
 * —— 一帧解不出来就是解不出来。
 *
 * 子进程不能捕获 stdout（沙箱禁止管道式 stdio），所以让 ffmpeg 把结果写进文件：
 * `-f null -` 会把统计打到 stderr，这里改用 `-f framemd5` 输出到文件，
 * 按行数就是帧数。
 */
export function countDecodedVideoFrames(file) {
  ensureTmp();
  const out = join(TMP, `decode-${process.pid}-${Math.random().toString(36).slice(2, 8)}.txt`);
  try {
    execFileSync('ffmpeg', [
      '-v', 'error',
      '-i', file,
      '-map', '0:v:0',
      '-f', 'framemd5',
      '-y', out,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    const lines = readFileSync(out, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
    return lines.length;
  } finally {
    rmSync(out, { force: true });
  }
}

/**
 * 把音轨解成 PCM，量出**它到底有没有声音**（RMS / 峰值 / 估频）。
 *
 * 为什么需要：ffprobe 说"有一条 aac/opus 轨"只证明**容器里有轨**，
 * 不证明里面有内容 —— 一条全静音的轨它照样这么报。
 * 抓流转码（Opus → AAC）这条链路出错时最典型的症状就是"有轨但没声音"，
 * 所以这里真解一遍，并按过零率估出主频：素材是 440 Hz 正弦时，
 * 估出来就该是 440 Hz。估频错了说明时间轴/样本被写坏了。
 *
 * 子进程不能捕获 stdout（沙箱禁止管道式 stdio），所以让 ffmpeg 写进文件。
 */
export function audioStats(file, { rate = 48000, seconds = 5, channel = 0 } = {}) {
  ensureTmp();
  const out = join(TMP, `audio-${process.pid}-${Math.random().toString(36).slice(2, 8)}.raw`);
  try {
    execFileSync('ffmpeg', [
      '-v', 'error',
      '-i', file,
      '-map', `0:a:${channel}`,
      '-t', String(seconds),
      '-f', 's16le', '-acodec', 'pcm_s16le',
      '-ar', String(rate), '-ac', '1',
      '-y', out,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });

    const buf = readFileSync(out);
    const count = Math.floor(buf.length / 2);
    if (!count) return { seconds: 0, rms: 0, peak: 0, hz: 0 };
    let sum = 0;
    let peak = 0;
    let crossings = 0;
    let previous = 0;
    for (let i = 0; i < count; i += 1) {
      const value = buf.readInt16LE(i * 2) / 32768;
      sum += value * value;
      peak = Math.max(peak, Math.abs(value));
      if (i > 0 && (value >= 0) !== (previous >= 0)) crossings += 1;
      previous = value;
    }
    const duration = count / rate;
    return {
      seconds: duration,
      rms: Number(Math.sqrt(sum / count).toFixed(4)),
      peak: Number(peak.toFixed(3)),
      hz: Math.round(crossings / 2 / duration),
    };
  } finally {
    rmSync(out, { force: true });
  }
}
