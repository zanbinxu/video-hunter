#!/usr/bin/env node
/**
 * 把 node_modules 里需要的库文件拷进 vendor/，并生成一份来源清单。
 *
 * 为什么要有这一步：扩展是「加载已解压的扩展程序」直接加载的，没有打包器。
 * 如果直接引用 node_modules，那扩展目录里会多出几十 MB 跟运行无关的东西，
 * 而且以后想打包发布时还得再筛一遍。所以固定成「装依赖 → vendor → 只带 vendor」。
 *
 * 用法：node tools/vendor.mjs
 */
import { copyFileSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 需要 vendor 的文件。from 相对项目根，to 相对 vendor/。 */
const ITEMS = [
  {
    from: 'node_modules/mux.js/dist/mux.min.js',
    to: 'mux.min.js',
    why: 'TS → fMP4 重封装（不需要 ffmpeg.wasm 的那条路）',
  },
  {
    from: 'node_modules/mp4-muxer/build/mp4-muxer.mjs',
    to: 'mp4-muxer.mjs',
    why: 'WebCodecs 编码结果直接封装成 MP4（录制兜底用）',
  },
  {
    from: 'node_modules/webm-muxer/build/webm-muxer.mjs',
    to: 'webm-muxer.mjs',
    why: '把 WebM 画面轨（VP8/VP9/AV1）和 Opus 音轨封成一个 .webm（抓流里的 WebM 站点用）',
  },
];

mkdirSync(join(ROOT, 'vendor'), { recursive: true });

const lines = [
  '# vendor/ 来源清单',
  '',
  '这些文件是 `node tools/vendor.mjs` 从 node_modules 拷过来的，**不要手改**。',
  '改版本请改 package.json 后重跑 `npm install && npm run vendor`。',
  '',
  '| 文件 | 来源 | 版本 | 体积 | 许可证 | 用途 |',
  '| --- | --- | --- | --- | --- | --- |',
];

let copied = 0;
for (const item of ITEMS) {
  const src = join(ROOT, item.from);
  const dst = join(ROOT, 'vendor', item.to);
  if (!existsSync(src)) {
    console.error(`✗ 找不到 ${item.from} —— 先跑 npm install`);
    process.exitCode = 1;
    continue;
  }
  copyFileSync(src, dst);
  copied += 1;

  const pkgName = item.from.split('/')[1];
  const pkgPath = join(ROOT, 'node_modules', pkgName, 'package.json');
  let version = '?';
  let license = '?';
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    version = pkg.version || '?';
    license = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type || '?');
  }
  const size = statSync(dst).size;
  lines.push(`| \`${item.to}\` | ${pkgName} | ${version} | ${(size / 1024).toFixed(1)} KB | ${license} | ${item.why} |`);
  console.log(`✓ vendor/${basename(dst)}  ←  ${item.from}  (${(size / 1024).toFixed(1)} KB)`);
}

lines.push('', `生成时间：${new Date().toISOString()}`, '');
writeFileSync(join(ROOT, 'vendor', 'SOURCES.md'), lines.join('\n'));
console.log(`\n共 vendor ${copied} 个文件，来源清单写入 vendor/SOURCES.md`);
