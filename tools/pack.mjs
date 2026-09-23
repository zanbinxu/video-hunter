/**
 * 打包成可以直接装进浏览器的扩展。
 *
 * ## 为什么要有它，而不是随手 zip 一下
 *
 * 这个项目是**零构建**的（`chrome://extensions` → 加载已解压的扩展程序 = 直接指到仓库根目录），
 * 所以"能跑"这件事一直是靠"目录里什么都有"保证的。可一旦打成包发给别人，
 * **漏一个文件就是运行时才炸**：
 *
 *   · 漏了 `vendor/mux.min.js` → 解析器页点下载才报"mux.js 没有加载"；
 *   · 漏了 `src/content/mse-hook.js` → 抓流一个字节都收不到；
 *   · 漏了 `offline/offscreen.html` → 录制和抓流全废，而且报错在离屏文档里，界面上只看到一句兜底。
 *
 * 而加载已解压的目录时，多带几个开发文件（tools/、test/、node_modules/）**没有症状** ——
 * 于是"包对不对"平时根本没人会注意。所以这个脚本做三件事：
 *
 *   1. 按**白名单**收集文件（只收运行时真的需要的：manifest / src / vendor / icons）；
 *   2. **反查所有引用**（manifest、HTML 的 script/link/img、JS 的相对 import、CSS 的 url()）
 *      是不是都落在包里 —— 这是"漏文件"唯一能在打包时抓住的地方；
 *   3. 写出一个确定性的 zip（固定时间戳、按路径排序），顺便打印体积构成。
 *
 * 包对不对的**最终验证**不是这个脚本，而是拿解压出来的那份真加载一次：
 *   node tools/browser-check.mjs --port 9333 --extension <解压目录> --extras http://127.0.0.1:8791
 *
 * 用法：node tools/pack.mjs [--out dist] [--name video-hunter]
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 进包的东西，就这些（白名单，不做"排除法"——排除法永远会漏一个） */
const INCLUDE = ['manifest.json', 'src', 'vendor', 'icons'];

/** 明确不许进包的（万一哪天有人把白名单改宽了，这里会当场拦住） */
const FORBIDDEN = ['test', 'tools', 'node_modules', 'docs', '.git', '.npm-cache', 'package.json', 'package-lock.json'];

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT_DIR = join(ROOT, argOf('--out', 'dist'));

/* ------------------------------------------------------------------ *
 * 1. 收集
 * ------------------------------------------------------------------ */

function walk(abs, out = []) {
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const p = join(abs, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** @returns {Array<{path:string, abs:string, size:number}>} path 用正斜杠、相对仓库根 */
function collect() {
  const files = [];
  for (const item of INCLUDE) {
    const abs = join(ROOT, item);
    const list = statSync(abs).isDirectory() ? walk(abs) : [abs];
    for (const f of list) {
      files.push({
        path: relative(ROOT, f).replace(/\\/g, '/'),
        abs: f,
        size: statSync(f).size,
      });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/* ------------------------------------------------------------------ *
 * 2. 反查引用：包里的每个引用都必须也在包里
 * ------------------------------------------------------------------ */

const problems = [];

function resolveRel(fromPath, spec) {
  // 只处理相对路径（'./x.js' / '../y/z.css'）；绝对 URL、chrome-extension:// 一律跳过
  if (!spec || /^[a-z]+:/i.test(spec) || spec.startsWith('//') || spec.startsWith('#')) return null;
  const base = dirname(fromPath);
  const parts = join(base, spec.split(/[?#]/)[0]).split(/[\\/]/);
  const stack = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') stack.pop();
    else stack.push(p);
  }
  return stack.join('/');
}

function checkManifest(byPath) {
  const raw = byPath.get('manifest.json');
  if (!raw) { problems.push('manifest.json 不在包里'); return; }
  const manifest = JSON.parse(readFileSync(raw.abs, 'utf8'));
  const refs = [
    ['action.default_popup', manifest.action?.default_popup],
    ['background.service_worker', manifest.background?.service_worker],
  ];
  for (const [size, p] of Object.entries(manifest.icons || {})) refs.push([`icons.${size}`, p]);
  for (const [size, p] of Object.entries(manifest.action?.default_icon || {})) refs.push([`action.default_icon.${size}`, p]);
  for (const [where, p] of refs) {
    if (!p) { problems.push(`manifest 里 ${where} 是空的`); continue; }
    if (!byPath.has(p)) problems.push(`manifest 的 ${where} 指向 ${p}，但它不在包里`);
  }
  // 白名单之外的东西混进来了会当场拦下（多带开发文件不是"无所谓"，是包不干净）
  for (const f of byPath.keys()) {
    const top = f.split('/')[0];
    if (FORBIDDEN.includes(top)) problems.push(`包里不该有 ${f}`);
  }
  return manifest;
}

function checkHtmlRefs(byPath) {
  for (const [path, file] of byPath) {
    if (extname(path) !== '.html') continue;
    const src = readFileSync(file.abs, 'utf8');
    // src="…" / href="…"（含 type="module" 的 script，以及 <link rel=stylesheet>）
    for (const m of src.matchAll(/\b(?:src|href)\s*=\s*"([^"]+)"/g)) {
      const target = resolveRel(path, m[1]);
      if (target && !byPath.has(target)) problems.push(`${path} 引用了 ${m[1]}，但它不在包里（解析为 ${target}）`);
    }
  }
}

function checkCssRefs(byPath) {
  for (const [path, file] of byPath) {
    if (extname(path) !== '.css') continue;
    const src = readFileSync(file.abs, 'utf8');
    for (const m of src.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      const target = resolveRel(path, m[1]);
      if (target && !byPath.has(target)) problems.push(`${path} 引用了 ${m[1]}，但它不在包里（解析为 ${target}）`);
    }
  }
}

function checkJsImports(byPath) {
  for (const [path, file] of byPath) {
    if (!['.js', '.mjs'].includes(extname(path))) continue;
    const src = readFileSync(file.abs, 'utf8');
    // import … from './x.js' / import './x.js' / export … from './x.js' / import('./x.js')
    const re = /(?:^|[\s;{(=])(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const m of src.matchAll(re)) {
      const spec = m[1] || m[2];
      const target = resolveRel(path, spec);
      if (target && !byPath.has(target)) problems.push(`${path} import 了 ${spec}，但它不在包里（解析为 ${target}）`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 3. 写 zip（自己写，不依赖外部命令；固定时间戳 → 可复现）
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS 时间：固定成 1980-01-01 00:00:00，让同一份内容每次打出同一个 zip */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // 1980-01-01

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.path, 'utf8');
    const data = e.data;
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    // 压不小就存原文（store），小文件经常如此
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // flags: UTF-8 名字
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra len
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);          // extra
    central.writeUInt16LE(0, 32);          // comment
    central.writeUInt16LE(0, 34);          // disk
    central.writeUInt16LE(0, 36);          // internal attrs
    // 外部属性：高 16 位是 Unix 权限（普通文件 644）。
    // ⚠️ `<<` 出来是**有符号**的（0o100644 << 16 是负数），必须 `>>> 0` ——
    // 否则 writeUInt32LE 直接抛 ERR_OUT_OF_RANGE。
    central.writeUInt32LE(((0o100644 << 16) >>> 0), 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const files = collect();
const byPath = new Map(files.map((f) => [f.path, f]));
const manifest = checkManifest(byPath) || {};
checkHtmlRefs(byPath);
checkJsImports(byPath);
checkCssRefs(byPath);

// package.json 与 manifest 的版本号是**两个真相**：不一致时起码要说出来
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (pkg.version !== manifest.version) {
  console.log(`  ! package.json 版本 ${pkg.version} 与 manifest.json 的 ${manifest.version} 不一致`
    + '（包名用的是 manifest 的）');
}

if (problems.length) {
  console.error('✗ 打包前检查没过：');
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}

const entries = files.map((f) => ({ path: f.path, data: readFileSync(f.abs) }));
const zip = makeZip(entries);

mkdirSync(OUT_DIR, { recursive: true });
const base = `${argOf('--name', 'video-hunter')}-${manifest.version || '0.0.0'}`;
const outFile = join(OUT_DIR, `${base}.zip`);
writeFileSync(outFile, zip);

// dist/ 里**同时留着好几个版本**（用户要求：升级时别删旧的，靠文件夹名区分），
// 所以这里只清掉"同名的那一份"，别的版本一律不动。
const unpackedDir = join(OUT_DIR, base);
// 版本说明里的「和上一版差在哪」抄自仓库根的 CHANGELOG.md（它本身不进包）
const delta = changelogSection(manifest.version);
if (!args.includes('--no-unpacked')) {
  rmSync(unpackedDir, { recursive: true, force: true });
  for (const f of files) {
    const dest = join(unpackedDir, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(f.abs));
  }
  // 每个版本的文件夹里放一份简短说明 —— 用户要"一眼看出哪个版本有哪些功能"
  writeFileSync(join(unpackedDir, '版本说明.md'), versionNote(manifest, files.length, delta));
}

// dist/ 里再放一份**总表**（`CHANGELOG.md` 的副本，每次打包刷新）：
// 用户要"对照几个版本"，那就不该让他回仓库翻 —— dist/ 里既有每个版本的目录，
// 也有这张所有版本都在上面的表。一处维护（仓库根的 CHANGELOG.md），这里是副本。
try {
  writeFileSync(join(OUT_DIR, '版本历史.md'), readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'));
} catch { /* 没有 CHANGELOG.md 就不放这一份，不影响打包 */ }

/**
 * 取 `CHANGELOG.md` 里**本版本**那一节。
 *
 * 为什么要有它：`dist/` 同时留着好几个版本、而功能清单是同一份模板 ——
 * 光看两个文件夹里的说明，分不出"这一版比上一版多了什么"，对照就无从谈起。
 * 变更条目按版本序号写在仓库根的 `CHANGELOG.md` 里（人工维护、一处维护），
 * 打包时抄进这一版的说明；没有对应小节时**不编造**，如实打印一句提醒。
 *
 * 小节边界：`## <version>` 开头，到下一个 `## ` 为止。
 */
function changelogSection(version) {
  let src;
  try {
    src = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  } catch { return null; }
  const lines = src.split(/\r?\n/);
  const esc = String(version || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `\b` 而不是 `(\s|$)`：小节标题后面常跟着全角括号或日期
  // （`## 0.2.1（2026-09-23）`），那既不是空白也不是行尾 —— 第一版就是这么判错的，
  // 打包时当场打印出"没有 0.2.1 这一节"。`\b` 还能挡住"找 0.2.1 却匹配上 0.2.10"。
  const head = lines.findIndex((l) => new RegExp(`^##\\s+${esc}\\b`).test(l));
  if (head < 0) return null;
  const rest = lines.slice(head + 1);
  const end = rest.findIndex((l) => /^##\s+/.test(l));
  const body = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
  return body || null;
}

/**
 * 生成"这个版本有哪些功能"的说明。放在包里而不是只写在仓库 README 里，
 * 因为它要回答的问题是"我手上这个文件夹是哪个版本、有什么"。
 */
function versionNote(manifest, count = 0, delta = null) {
  return `# Video Hunter ${manifest.version}（${new Date().toISOString().slice(0, 10)} 打包）

安装：\`chrome://extensions\` → 打开右上角**开发者模式** → **加载已解压的扩展程序** → 选这个文件夹。

---
${delta ? `
## 这一版和上一版差在哪

> 抄自仓库根的 \`CHANGELOG.md\`（那份不在包里）。要对照另一个版本，
> 就打开它目录下的同名文件看对应小节。

${delta}

---
` : ''}
## 这一版有什么

### 下载

- **嗅探**页面上的媒体请求（直链 / \`.m3u8\` / \`.mpd\`），列表按类型分组，点一下就能下
- **HLS / M3U8**：主列表选码率 → 分片收齐后统一组装成**带索引的标准 MP4**（进度条拖得动）
- **DASH / 音视频分离的 HLS**：两路分别下完再合并成一条 MP4
- **无清单 DASH（B 站那类）**：面板按真实嗅到的轨道给出「合并下载」——
  有视频+音频才给按钮，只有音频就不给（判据有单测）
- **AES-128 加密的 HLS** 自动解密；识别到 DRM 会明确拒绝（不做任何绕过）
- 直播 HLS（无 \`#EXT-X-ENDLIST\`）按分片窗口增量录，漏片如实显示

### 抓流（钩播放器 \`appendBuffer\`，拿已解密的原始码流）

- 无损、不重编码、不带页面水印；**支持 4K**（实测 YouTube 4K 可用）
- 可以**从当前播放进度**开始抓（会刷新一次页面，但不用重看）
- **一集一个文件**：播放列表 / 自动连播换集时自动切开，每集都是完整文件
  （⚠️ 只在播放器**真的换了资源**时生效 —— 同一页面、地址栏不变的"平滑换集"
  识别不到，那种站点请换集后手动收尾，详见仓库 \`docs/verification.md\`）
- **先保存已录到的部分**：抓流不中断，随时拿走一份能播的
- **每 N 分钟自动保存**（滚动覆盖，只留最新一份），
  口径可选 **录制时间** 或 **视频内容时长**（倍速播放时后者才是你要的）
- **攒太大自动切一段**（默认 600 MB）：抓流数据全在内存里、收尾合并要一整块，
  超过 ~1 GB 就合不出来 —— 到阈值先写出完整一段、清空缓冲接着抓
- **收尾失败不丢数据**：合并/写盘出错时原始数据留在内存里，给「重试保存 / 放弃这一份」
- **分片乱序/重复到达也能收尾**：合并前按时间戳排好、去掉重复（并如实告诉你）
- **产物自动导出到下载目录**（可选，默认开）：完整产物落进「抓流文件」之后自动下载一份，
  私有存储那份和「保存到磁盘」按钮都保留

### 录制兜底（抓不到地址时）

- tabCapture + WebCodecs → MP4，边录边落盘，内存占用恒定
- 采集源停摆（切标签页/锁屏）的时段从时间轴里压掉，不留空洞

### 管理页

- 按来源分组列出抓流 / 录制产物：**真实时长**（读产物自己的 mvhd）、体积、时间
- 保存到磁盘 / 体检（能不能拖进度条、有无空洞）/ 一键原地修复空洞 / 删除
- 显示 OPFS 用量与配额，已导出的可一键清理

### 其它

- 产物文件名带视频标题；面板底栏「?」里是抓流与录制的取舍说明
- 全流程本地完成，没有任何外部请求；不碰 DRM

---

打包信息：${count} 个运行时文件（外加这份说明），版本取自 \`manifest.json\` 的 \`version\`（\`${manifest.version}\`）。
`;
}

const raw = files.reduce((n, f) => n + f.size, 0);
const byDir = new Map();
for (const f of files) {
  const top = f.path.includes('/') ? f.path.split('/')[0] : '(根)';
  byDir.set(top, (byDir.get(top) || 0) + 1);
}
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

console.log(`✓ 打包完成：${relative(ROOT, outFile).replace(/\\/g, '/')}`);
if (!args.includes('--no-unpacked')) {
  console.log(`  另有一份摊开的（可以直接"加载已解压的扩展程序"）：`
    + `${relative(ROOT, unpackedDir).replace(/\\/g, '/')}`);
}
console.log(`  ${files.length} 个文件｜解压后 ${kb(raw)}｜zip ${kb(zip.length)}`
  + `（压缩率 ${(100 - (zip.length / raw) * 100).toFixed(0)}%）`);
console.log(`  按目录：${[...byDir.entries()].map(([d, n]) => `${d}×${n}`).join('、')}`);
console.log(`  版本：${manifest.version}｜manifest_version：${manifest.manifest_version}`);
console.log(delta
  ? `  变更条目：CHANGELOG.md 里 ${manifest.version} 那一节已抄进版本说明`
  : `  ! CHANGELOG.md 里没有 ${manifest.version} 这一节 —— 版本说明里只有功能清单，`
    + '对照时看不出与上一版的差别（补一节再打一次即可）');
console.log('  装法一（推荐，开发/自用）：chrome://extensions → 打开"开发者模式" → ');
console.log(`    "加载已解压的扩展程序" → 选 ${relative(ROOT, unpackedDir).replace(/\\/g, '/')}`);
console.log('  装法二（发给别人 / 传商店）：上传那个 zip。');
console.log('  ⚠️ 包到底能不能用，要看**从包里加载**的那一次（不是从仓库根目录）：');
console.log(`    node tools/browser-check.mjs --port 9333 --extension ${relative(ROOT, unpackedDir).replace(/\\/g, '/')} --extras http://127.0.0.1:8791`);
