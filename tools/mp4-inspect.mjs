/**
 * 读一个 MP4 的关键索引信息，用来判断"能不能拖进度条"。
 *
 * 拖不动进度条几乎总是这三个原因之一：
 *   · mvhd 里的总时长是 0（播放器不知道该拖到哪儿）
 *   · 没有样本索引（stbl 里的 stco/stsz/stts/stss）—— 那是分片式 MP4
 *   · 有索引但片段表（sidx / mfra）缺失
 *
 * 用法：node tools/mp4-inspect.mjs <file> [file...]
 */
import { readFileSync } from 'node:fs';

function readUInt(b, o, n) {
  let x = 0;
  for (let i = 0; i < n; i += 1) x = x * 256 + b[o + i];
  return x;
}

function topBoxes(b, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    const size = readUInt(b, p, 4);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (size < 8 || p + size > end) break;
    out.push({ type, start: p, size, payloadStart: p + 8, payloadEnd: p + size });
    p += size;
  }
  return out;
}

function findBox(b, list, type) {
  return list.find((x) => x.type === type) || null;
}

export function inspect(file) {
  const b = new Uint8Array(readFileSync(file));
  const top = topBoxes(b, 0, b.length);
  const topTypes = top.map((x) => x.type);

  const moov = findBox(b, top, 'moov');
  const result = {
    file,
    bytes: b.byteLength,
    topLevel: topTypes,
    fragmented: topTypes.filter((t) => t === 'moof').length,
    mvhd: null,
    traks: 0,
    sampleTable: [],
    hasMvex: false,
    hasSidx: topTypes.includes('sidx'),
    hasMfra: topTypes.includes('mfra'),
  };
  if (!moov) return result;

  const moovKids = topBoxes(b, moov.payloadStart, moov.payloadEnd);
  result.hasMvex = !!findBox(b, moovKids, 'mvex');

  const mvhd = findBox(b, moovKids, 'mvhd');
  if (mvhd) {
    const q = mvhd.payloadStart;
    const version = b[q];
    const timescale = version === 1 ? readUInt(b, q + 20, 4) : readUInt(b, q + 12, 4);
    const duration = version === 1 ? readUInt(b, q + 24, 8) : readUInt(b, q + 16, 4);
    result.mvhd = { version, timescale, duration, seconds: timescale ? duration / timescale : 0 };
  }

  for (const trak of moovKids.filter((x) => x.type === 'trak')) {
    result.traks += 1;
    const mdia = findBox(b, topBoxes(b, trak.payloadStart, trak.payloadEnd), 'mdia');
    if (!mdia) continue;
    const minf = findBox(b, topBoxes(b, mdia.payloadStart, mdia.payloadEnd), 'minf');
    if (!minf) continue;
    const stbl = findBox(b, topBoxes(b, minf.payloadStart, minf.payloadEnd), 'stbl');
    if (!stbl) continue;
    const kinds = topBoxes(b, stbl.payloadStart, stbl.payloadEnd).map((x) => x.type);
    result.sampleTable.push(kinds.join(','));
  }

  return result;
}

if (process.argv[1] && process.argv[1].endsWith('mp4-inspect.mjs')) {
  for (const file of process.argv.slice(2)) {
    const r = inspect(file);
    console.log(`\n=== ${r.file} (${(r.bytes / 1024).toFixed(0)} KB) ===`);
    console.log(`顶层 box：${r.topLevel.slice(0, 8).join(' ')}${r.topLevel.length > 8 ? ` … （共 ${r.topLevel.length} 个，其中 moof ${r.fragmented} 个）` : ''}`);
    console.log(`mvhd：${r.mvhd ? `timescale=${r.mvhd.timescale} duration=${r.mvhd.duration} → ${r.mvhd.seconds.toFixed(2)} 秒` : '缺失'}`);
    console.log(`轨道数：${r.traks}｜mvex(分片式)：${r.hasMvex}｜sidx：${r.hasSidx}｜mfra：${r.hasMfra}`);
    r.sampleTable.forEach((t, i) => console.log(`第 ${i + 1} 条轨的样本表：${t || '（空）'}`));
  }
}
