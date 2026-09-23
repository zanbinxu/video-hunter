/**
 * 「为什么拖不动进度条」命令行体检 + 修复。
 *
 * 真正的逻辑在 `src/parser/seek-check.js` 里 —— 那份实现同时被扩展页面用，
 * 只有一份，不会两边跑偏。这里只做「读文件 / 打印 / 写回」。
 *
 * 用法：
 *   node tools/seek-diag.mjs <file> [file...]          体检
 *   node tools/seek-diag.mjs --fix <file> [out]        把时间轴空洞修掉，另存
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inspectSeekability, repairTimelineGaps } from '../src/parser/seek-check.js';

function printReport(file, r) {
  console.log(`\n=== ${file} (${(r.bytes / 1024).toFixed(0)} KB) ===`);
  console.log(`顶层 box：${r.topLevel.slice(0, 10).join(' ')}`);
  console.log(`moov 在 mdat 之前：${r.moovBeforeMdat ? '是' : '否'}｜moof：${r.moofCount}`);
  console.log(`总时长：${r.mvhd ? `${r.mvhd.seconds.toFixed(2)} 秒${r.mvhd.unknown ? '（未知值！）' : ''}` : '缺失'}`);
  for (const t of r.tracks) {
    const kf = t.keyframes === null ? '无索引' : `${t.keyframes} 个`;
    console.log(`  轨 ${t.handler}：${t.samples} 个样本｜${t.seconds.toFixed(2)} 秒｜关键帧 ${kf}`);
    if (t.keyframeTimes.length > 1) {
      const head = t.keyframeTimes.slice(0, 8).map((x) => x.toFixed(2)).join(', ');
      console.log(`    关键帧时间点（前 8 个）：${head}`);
      console.log(`    关键帧最大间隔：${t.keyframeIntervalMax.toFixed(2)} 秒`);
    }
    for (const g of t.gaps) {
      console.log(`    ⚠️ ${g.deadAir ? '空洞（所有轨一起断，可压）' : '缺口（只有这条轨断，不可压）'}：`
        + `${g.atSeconds.toFixed(2)} 秒处断了 ${g.lengthSeconds.toFixed(2)} 秒`);
    }
    if (t.leadingStretch) {
      console.log(`    · 开头被拉长 ${t.leadingStretch.lengthSeconds.toFixed(2)} 秒（起播延迟，不是空洞）`);
    }
  }
  console.log(`结论：${r.verdict.text}`);
  for (const p of r.problems) console.log(`  · ${p}`);
}

const argv = process.argv.slice(2);
if (argv[0] === '--fix') {
  const file = argv[1];
  const out = argv[2] || file.replace(/\.mp4$/i, '') + '-fixed.mp4';
  const bytes = new Uint8Array(readFileSync(file));
  const before = inspectSeekability(bytes);
  const result = repairTimelineGaps(bytes);
  if (!result.ok) {
    console.log(`没修：${result.reason}`);
    for (const s of result.skipped || []) {
      console.log(`  跳过 ${s.handler} 的 ${Number(s.lengthSeconds).toFixed(2)} 秒缺口：${s.reason}`);
    }
    process.exitCode = 1;
  } else {
    writeFileSync(out, result.bytes);
    const after = inspectSeekability(result.bytes);
    console.log(`已修复：${file} → ${out}`);
    console.log(`  压缩掉 ${result.droppedSeconds.toFixed(2)} 秒空洞`
      + `（${result.repaired.map((x) => `${x.handler} ${x.droppedSeconds.toFixed(2)} 秒`).join('、')}）`);
    for (const s of result.skipped || []) {
      console.log(`  跳过 ${s.handler} 的 ${Number(s.lengthSeconds).toFixed(2)} 秒缺口：${s.reason}`);
    }
    console.log(`  修复前：${before.mvhd?.seconds.toFixed(2)} 秒 → 修复后：${after.mvhd?.seconds.toFixed(2)} 秒`);
    console.log(`  修复后结论：${after.verdict.text}`);
    for (const p of after.problems) console.log(`    · ${p}`);
  }
} else {
  for (const file of argv) {
    try {
      printReport(file, inspectSeekability(new Uint8Array(readFileSync(file))));
    } catch (err) {
      console.log(`\n=== ${file} ===\n  读不了：${err?.message || err}`);
    }
  }
}
