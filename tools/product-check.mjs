#!/usr/bin/env node
/**
 * 产物自检：把"这个文件到底有没有毛病"变成一行硬结论。
 *
 * 为什么需要它：抓流出的问题有一大半是**静默**的 —— 文件能播、进度条能拖、
 * 播放器也不报错，只是"第 56 秒之后没声音了""第 23 秒之后没画面了"。
 * 靠肉眼看和听，一轮要十几分钟；靠问"你觉得哪里不对"，问不出确切秒数。
 *
 * 这个工具只做一件事：把每条轨**真正覆盖到第几秒**摆出来，然后给一句判断。
 * 它不依赖扩展、不改任何东西、也不上传任何数据 —— 就是读文件 + 调本机 ffprobe/ffmpeg。
 *
 * 用法：
 *   node tools/product-check.mjs <文件> [更多文件...]
 *   node tools/product-check.mjs --decode <文件>     # 额外真解一遍（音频量 RMS、视频前 3 帧）
 *   npm run check-product -- "C:\Users\你\Downloads\VideoHunter\某个.mp4"
 *
 * 退出码：0 = 都看着正常；1 = 至少有一个文件有问题（方便脚本里用）。
 *
 * 判据（为什么是这几条）：
 *   · **两条轨的覆盖时长差得离谱** —— 抓流最常见的失败形状（画面/声音某一截没进去）。
 *     阈值取"差 > 5 秒且超过短的那条的一半"，避免把正常的音画起点差误判成问题。
 *   · **轨内有空洞**（相邻包间隔 > 0.5 秒）—— 播放器拖进去会退回上一帧，看着像坏了。
 *   · **缺轨**（只有画面或只有声音）。
 *   · **解不开**（ffprobe 都不认，或强解报错）。
 *
 * ⚠️ 它**不能**告诉你"为什么"：那要看抓流当时的状态与产物提示（`抓流完成` 那张卡）。
 *    它只负责把"哪里不对、到第几秒"钉死，省掉来回猜。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const TMP = join(ROOT, '.tmp');
mkdirSync(TMP, { recursive: true });

let seq = 0;
const tmpFile = (ext) => join(TMP, `pc-${process.pid}-${(seq += 1)}.${ext}`);

/** 跑 ffprobe，让它把结果写进文件再读回来（本项目一贯做法，避免管道 stdio） */
function ffprobeJson(file, args = ['-show_format', '-show_streams']) {
  const out = tmpFile('json');
  try {
    execFileSync('ffprobe', ['-v', 'error', ...args, '-of', 'json', '-o', out, file], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally {
    rmSync(out, { force: true });
  }
}

/** 某一轨的包时间线 */
function packets(file, selector) {
  const out = tmpFile('csv');
  try {
    execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', selector,
      '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', '-o', out, file,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    return readFileSync(out, 'utf8').split('\n').filter(Boolean).map((line) => {
      const parts = line.split(',');
      return { pts: Number(parts[0]), key: (parts[1] || '').includes('K') };
    }).filter((p) => Number.isFinite(p.pts));
  } catch {
    return [];
  } finally {
    rmSync(out, { force: true });
  }
}

/** 解一遍音频 → RMS / 峰值（"有轨"不等于"有声音"）
 *
 * ⚠️ 必须**从这条轨真正开始的地方**取样：抓流产物里音频起点常常不是 0
 * （现场就有画面从 0 开始、音频从 14.97 秒开始的），从 0 解会得到一段静音，
 * 然后判成"音频是静音"——那是工具在撒谎，不是文件有问题。
 */
function audioLevels(file, startSeconds = 0) {
  const out = tmpFile('raw');
  const seek = Math.max(0, startSeconds + 0.5);
  try {
    const res = execFileSync('ffmpeg', [
      '-v', 'error', '-ss', String(seek), '-i', file, '-map', '0:a:0', '-t', '10',
      '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '48000', '-ac', '1', '-y', out,
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    const buf = readFileSync(out);
    const n = Math.floor(buf.length / 2);
    if (!n) return { seconds: 0, rms: 0, peak: 0 };
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < n; i += 1) {
      const v = buf.readInt16LE(i * 2) / 32768;
      sum += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    return { seconds: n / 48000, rms: Math.round(Math.sqrt(sum / n) * 1e4) / 1e4, peak: Math.round(peak * 1e3) / 1e3 };
  } catch {
    return null;
  } finally {
    rmSync(out, { force: true });
  }
}

/** 能不能真解码（"ffprobe 认得"不等于"能播"） */
function countDecodedFrames(file, limit = 3) {
  const out = tmpFile('txt');
  try {
    execFileSync('ffmpeg', [
      '-v', 'error', '-i', file, '-map', '0:v:0', '-frames:v', String(limit), '-f', 'framemd5', '-y', out,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    return readFileSync(out, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).length;
  } catch (err) {
    return { error: String(err.message || err).split('\n')[0] };
  } finally {
    rmSync(out, { force: true });
  }
}

function spans(file) {
  const info = ffprobeJson(file);
  const format = info.format || {};
  const streams = info.streams || [];
  const pick = (type) => streams.find((s) => s.codec_type === type) || null;
  const v = pick('video');
  const a = pick('audio');

  const detail = (s) => {
    if (!s) return null;
    const pk = packets(file, `${s.codec_type === 'video' ? 'v' : 'a'}:0`);
    const first = pk.length ? pk[0].pts : null;
    const last = pk.length ? pk[pk.length - 1].pts : null;
    let holes = 0;
    let maxGap = 0;
    for (let i = 1; i < pk.length; i += 1) {
      const gap = pk[i].pts - pk[i - 1].pts;
      if (gap > 0.5) { holes += 1; if (gap > maxGap) maxGap = gap; }
    }
    return {
      codec: s.codec_name,
      shape: s.codec_type === 'video' ? `${s.width}x${s.height}` : `${s.sample_rate}Hz ${s.channels}ch`,
      packets: pk.length,
      first,
      last,
      keyframes: s.codec_type === 'video' ? pk.filter((p) => p.key).length : null,
      holes,
      maxGap: Math.round(maxGap * 100) / 100,
      declared: s.duration && s.duration !== 'N/A' ? Number(s.duration) : null,
      // 同一时间戳上挤了好几帧 = "两段内容交错焊在一起"的形状（换集/重发 init 的典型痕迹）
      duplicated: pk.length - new Set(pk.map((p) => p.pts.toFixed(3))).size,
    };
  };

  return {
    format: { name: format.format_name, duration: Number(format.duration) || null, size: Number(format.size) || null, bitRate: Number(format.bit_rate) || null },
    video: detail(v),
    audio: detail(a),
    streamCount: streams.length,
  };
}

function check(file, { decode }) {
  const name = basename(file);
  const size = existsSync(file) ? statSync(file).size : 0;
  console.log(`── ${name}`);
  console.log(`   ${(size / 1048576).toFixed(2)} MB`);

  let s;
  try {
    s = spans(file);
  } catch (err) {
    console.log(`   ✗ 连容器都认不出来：${String(err.message || err).split('\n')[0]}`);
    console.log('   判断：✗ 这个文件打开就有问题（不是"少了某一段"，是容器/头部本身坏了）');
    return ['无法识别容器'];
  }

  const problems = [];
  console.log(`   容器：${s.format.name || '?'}｜声明时长 ${s.format.duration != null ? s.format.duration.toFixed(2) + ' 秒' : '未知'}`);
  for (const [label, t] of [['视频', s.video], ['音频', s.audio]]) {
    if (!t) { console.log(`   ${label}：**没有这条轨**`); problems.push(`缺${label}轨`); continue; }
    const span = t.first != null && t.last != null ? t.last - t.first : null;
    console.log(`   ${label} ${t.codec} ${t.shape}：${t.packets} 包｜`
      + `${t.first != null ? t.first.toFixed(2) : '?'} → ${t.last != null ? t.last.toFixed(2) : '?'} 秒`
      + `（覆盖 ${span != null ? span.toFixed(2) : '?'} 秒）`
      + `${t.keyframes != null ? `｜${t.keyframes} 个关键帧` : ''}`
      + `${t.duplicated ? `｜**${t.duplicated} 帧挤在同一时间戳上**` : ''}`
      + `${t.holes ? `｜**${t.holes} 处空洞，最大 ${t.maxGap} 秒**` : ''}`);
    if (t.holes) problems.push(`${label}轨有 ${t.holes} 处空洞`);
    if (t.duplicated) problems.push(`${label}轨有 ${t.duplicated} 帧时间戳重复`);
  }

  if (s.video && s.audio) {
    const vEnd = s.video.last;
    const aEnd = s.audio.last;
    const vStart = s.video.first;
    const aStart = s.audio.first;
    const shorter = Math.min(vEnd ?? 0, aEnd ?? 0);
    if (vEnd != null && aEnd != null && Math.abs(vEnd - aEnd) > 5 && Math.abs(vEnd - aEnd) > shorter * 0.5) {
      if (aEnd < vEnd) {
        problems.push(`声音只覆盖到 ${aEnd.toFixed(2)} 秒，画面到 ${vEnd.toFixed(2)} 秒`);
        console.log(`   判断：✗ **第 ${aEnd.toFixed(2)} 秒之后没有声音**（画面一直到 ${vEnd.toFixed(2)} 秒）`
          + ` —— 差 ${(vEnd - aEnd).toFixed(1)} 秒`);
      } else {
        problems.push(`画面只覆盖到 ${vEnd.toFixed(2)} 秒，声音到 ${aEnd.toFixed(2)} 秒`);
        console.log(`   判断：✗ **第 ${vEnd.toFixed(2)} 秒之后没有画面**（声音一直到 ${aEnd.toFixed(2)} 秒）`
          + ` —— 差 ${(aEnd - vEnd).toFixed(1)} 秒。播放器拖到后面只有边框/空白，就是这个`);
      }
    } else if (!problems.length) {
      console.log(`   判断：✓ 两条轨都覆盖到 ${Math.max(vEnd ?? 0, aEnd ?? 0).toFixed(2)} 秒，看不出缺内容`);
    }

    // ---- 起点差 / 终点差：不到"缺一大截"的程度，但值得你自己看一眼 ----
    // 抓流从中间开始时，两条轨的起点本来就可以不同（按设计保留相对起点），
    // 所以这里**只提示、不判错**；但它也是"某条轨从一开始就没进来"的信号。
    if (vStart != null && aStart != null && Math.abs(vStart - aStart) > 2) {
      console.log(`   ⚠️ 两条轨的起点差 ${Math.abs(vStart - aStart).toFixed(2)} 秒`
        + `（画面 ${vStart.toFixed(2)} / 声音 ${aStart.toFixed(2)}）——`
        + '从中间开始抓流时这是正常的；如果不是，说明有一条轨的头部没进来');
    }
    if (vEnd != null && aEnd != null
      && Math.abs(vEnd - aEnd) > 2 && !(Math.abs(vEnd - aEnd) > 5 && Math.abs(vEnd - aEnd) > shorter * 0.5)) {
      console.log(`   ⚠️ 两条轨的结尾差 ${Math.abs(vEnd - aEnd).toFixed(2)} 秒`
        + `（画面 ${vEnd.toFixed(2)} / 声音 ${aEnd.toFixed(2)}）—— 差得不多，但那段时间只有一条轨有内容`);
    }
  } else if (!problems.length && (s.video || s.audio)) {
    console.log('   判断：⚠️ 只有一条轨（单轨产物本身可能是正常的，看你的来源）');
  }

  if (decode) {
    const lv = s.audio ? audioLevels(file, s.audio.first ?? 0) : null;
    if (lv) {
      const silent = lv.rms < 0.005;
      console.log(`   真解音频（前 10 秒）：RMS ${lv.rms}｜峰值 ${lv.peak}${silent ? ' ← **基本是静音**' : ''}`);
      if (silent) problems.push('音频解出来是静音');
    }
    if (s.video) {
      const frames = countDecodedFrames(file);
      if (typeof frames === 'number') {
        console.log(`   真解画面（前 3 帧）：解出 ${frames} 帧${frames ? '' : ' ← **一帧都解不出来**'}`);
        if (!frames) problems.push('画面一帧都解不出来');
      } else {
        console.log(`   真解画面：失败 —— ${frames.error}`);
        problems.push('画面解码失败');
      }
    }
  }

  return problems;
}

/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const decode = argv.includes('--decode');
const files = argv.filter((a) => a !== '--decode');
if (!files.length) {
  console.error('用法：node tools/product-check.mjs [--decode] <文件> [更多文件...]');
  process.exit(2);
}

let bad = 0;
for (const f of files) {
  if (!existsSync(f)) {
    console.log(`── ${f}`);
    console.log('   ✗ 文件不存在');
    bad += 1;
    continue;
  }
  const problems = check(f, { decode });
  if (problems.length) bad += 1;
  console.log('');
}

if (bad) {
  console.log(`总结：${files.length} 个文件里有 ${bad} 个有问题（上面带 ✗ 的那些）`);
  console.log('想知道**为什么**少了那一段：看抓流停止时那张「抓流完成」提示卡上的文字，');
  console.log('里面会写是"某一组没进产物"还是"有数据段没能送进离屏文档"。');
} else {
  console.log(`总结：${files.length} 个文件都看着正常 ✓`);
}
process.exit(bad ? 1 : 0);
