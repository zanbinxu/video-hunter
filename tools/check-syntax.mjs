#!/usr/bin/env node
/**
 * 扩展静态体检。
 *
 * 三件事：
 *   1. 用 Node 的解析器逐个检查 .js 的**语法**（只验语法，不解析 import）
 *   2. 校验 manifest.json 能被解析
 *   3. 校验 manifest 里引用到的每个文件都真实存在
 *
 * 第 3 条是重点：manifest 里写错一个路径，Chrome 只会在加载扩展时
 * 抛一句语焉不详的错，然后在扩展页面上留一个红点。与其在浏览器里猜，
 * 不如在这里直接指出来。
 *
 * 实现上的一个坑：Node 靠「最近的 package.json 里的 type」决定用 ESM 还是 CJS
 * 语法解析。我们源码全是 ESM 但扩展名是 .js，直接 `node --check` 会把它当 CJS
 * 然后对 import 误报。所以这里把文件镜像到一个带 {"type":"module"} 的临时目录里再查。
 *
 * 另一个坑：当前沙箱禁止管道式 stdio（EPERM），所以子进程必须用
 * stdio: ['ignore','inherit','inherit']，让 node 的报错直接打到 stderr。
 *
 * 用法：node tools/check-syntax.mjs
 */
import {
  readdirSync, statSync, readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync,
} from 'node:fs';
import { join, relative, extname, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const fail = (msg) => { failures += 1; console.error(`  ✗ ${msg}`); };
const pass = (msg) => console.log(`  ✓ ${msg}`);

/* ------------------------------------------------------------------ *
 * 1. 语法检查
 * ------------------------------------------------------------------ */

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (extname(name) === '.js') out.push(full);
  }
  return out;
}

console.log('· 语法检查');
const tmp = mkdtempSync(join(tmpdir(), 'vh-check-'));
// 让 Node 把镜像目录里的 .js 当 ESM 解析
writeFileSync(join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));

const targets = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'vendor'))];
if (!targets.length) console.log('  (src/ 下还没有 .js 文件)');

for (const file of targets) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const mirror = join(tmp, rel);
  mkdirSync(dirname(mirror), { recursive: true });
  writeFileSync(mirror, readFileSync(file, 'utf8'));
  try {
    execFileSync(process.execPath, ['--check', mirror], { stdio: ['ignore', 'inherit', 'inherit'] });
    pass(rel);
  } catch {
    // node 自己已经把「路径:行号 + 错误片段」打到 stderr 了，这里只需要标记失败
    fail(rel);
  }
}
rmSync(tmp, { recursive: true, force: true });

/* ------------------------------------------------------------------ *
 * 2. manifest.json
 * ------------------------------------------------------------------ */

console.log('\n· manifest.json');
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  pass('JSON 可解析');
} catch (err) {
  fail(`无法解析：${err.message}`);
}

/* ------------------------------------------------------------------ *
 * 3. 引用完整性
 * ------------------------------------------------------------------ */

if (manifest) {
  console.log('\n· manifest 引用的文件');
  const referenced = new Set();
  const add = (p) => { if (typeof p === 'string' && p) referenced.add(p); };

  add(manifest.background?.service_worker);
  add(manifest.action?.default_popup);
  for (const v of Object.values(manifest.icons || {})) add(v);
  for (const v of Object.values(manifest.action?.default_icon || {})) add(v);
  for (const cs of manifest.content_scripts || []) {
    for (const f of cs.js || []) add(f);
    for (const f of cs.css || []) add(f);
  }
  for (const war of manifest.web_accessible_resources || []) {
    for (const r of war.resources || []) {
      // 通配路径没法逐个验，跳过
      if (typeof r === 'string' && !r.includes('*')) add(r);
    }
  }

  for (const p of [...referenced].sort()) {
    if (existsSync(join(ROOT, p))) pass(p);
    else fail(`manifest 引用了不存在的文件：${p}`);
  }
  if (!referenced.size) console.log('  (没有引用)');
}

/* ------------------------------------------------------------------ *
 * 4. 跨文件引用
 *
 * manifest 只声明了一部分入口。offscreen.html / parser.html / recorder.html
 * 都是从 JS 里用 chrome.runtime.getURL() 打开的 —— 这些路径写错了，
 * manifest 检查完全看不出来，只有真跑到那一步才会 404。
 * ------------------------------------------------------------------ */

console.log('\n· 跨文件引用');

function walkExt(dir, ext, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkExt(full, ext, out);
    else if (extname(name) === ext) out.push(full);
  }
  return out;
}

let refCount = 0;

// 4a. JS 里的 getURL('...') / getURL(`...?${...}`)
//     模板串里查询参数是插值的，所以只取到 `?` 或 `${` 之前的静态片段。
for (const file of walkExt(join(ROOT, 'src'), '.js')) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const source = readFileSync(file, 'utf8');
  for (const m of source.matchAll(/getURL\(\s*[`'"]([^`'"$?]*)/g)) {
    const target = m[1];
    if (!target || target.includes('*')) continue;
    refCount += 1;
    if (existsSync(join(ROOT, target))) pass(`${rel} → ${target}`);
    else fail(`${rel} 里 getURL 指向的文件不存在：${target}`);
  }
}

// 4b. HTML 里的 src / href
for (const file of walkExt(join(ROOT, 'src'), '.html')) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const source = readFileSync(file, 'utf8');
  for (const m of source.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
    const ref = m[1];
    if (/^(https?:|data:|#|chrome-extension:)/.test(ref)) continue;
    refCount += 1;
    const target = join(dirname(file), ref);
    if (existsSync(target)) pass(`${rel} → ${ref}`);
    else fail(`${rel} 引用了不存在的 ${ref}`);
  }
}

if (!refCount) console.log('  (没有跨文件引用)');

/* ------------------------------------------------------------------ *
 * 5. 模块导入导出一致性
 *
 * 这一节是踩坑之后补的，值得写清楚为什么。
 *
 * `node --check` 只验语法，看不见「A 从 B import 了一个 B 根本没导出的名字」。
 * 这种错误在浏览器里是**运行时模块解析错误**：service worker 整个启动失败，
 * 但扩展照样加载、各个页面照样渲染正常 —— 表现是「什么都没坏，但什么都不工作」。
 * 这个坑真实发生过一次（IGNORED_REQUEST_TYPES 定义在 classify.js，
 * 而 sniffer.js 从 constants.js 里 import 它）。
 * ------------------------------------------------------------------ */

console.log('\n· 模块导入导出一致性');

/** 收集一个模块导出的名字 */
function exportsOf(file) {
  const src = readFileSync(file, 'utf8');
  const names = new Set();
  let hasStar = false;

  // 生成器函数（function*）也要认，否则 export async function* foo 会被漏掉
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  // export { a, b as c }  —— 也覆盖多行写法
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const piece of m[1].split(',')) {
      const t = piece.trim();
      if (!t) continue;
      const parts = t.split(/\s+as\s+/);
      names.add((parts[1] || parts[0]).trim());
    }
  }
  if (/^\s*export\s+default\b/m.test(src)) names.add('default');
  if (/^\s*export\s*\*\s*from\b/m.test(src)) hasStar = true;

  return { names, hasStar };
}

/** 收集一个模块的静态 import / re-export 依赖 */
function depsOf(file) {
  const src = readFileSync(file, 'utf8');
  const out = [];

  for (const m of src.matchAll(/import\s+([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    const clause = m[1].trim();
    const spec = m[2];
    const named = [];
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) {
      for (const piece of braces[1].split(',')) {
        const t = piece.trim();
        if (!t) continue;
        named.push(t.split(/\s+as\s+/)[0].trim());
      }
    }
    const hasDefault = /^[A-Za-z_$][\w$]*\s*(,|$)/.test(clause);
    out.push({ kind: 'import', spec, named, hasDefault });
  }

  for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const named = [];
    for (const piece of m[1].split(',')) {
      const t = piece.trim();
      if (!t) continue;
      // 只看被 re-export 的**来源**名字
      named.push(t.split(/\s+as\s+/)[0].trim());
    }
    out.push({ kind: 're-export', spec: m[2], named, hasDefault: false });
  }

  return out;
}

let depChecked = 0;
const exportCache = new Map();

for (const file of [...walkExt(join(ROOT, 'src'), '.js'), ...walkExt(join(ROOT, 'test'), '.mjs')]) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  for (const dep of depsOf(file)) {
    if (!dep.spec.startsWith('.')) continue; // 裸模块交给 Node 自己解析
    const target = resolve(dirname(file), dep.spec);
    depChecked += 1;

    if (!existsSync(target)) {
      fail(`${rel} 引用了不存在的模块：${dep.spec}`);
      continue;
    }

    if (!dep.named.length) continue;
    if (!exportCache.has(target)) exportCache.set(target, exportsOf(target));
    const { names, hasStar } = exportCache.get(target);
    if (hasStar) continue; // export * 看不透，放过

    const missing = dep.named.filter((n) => n && !names.has(n));
    if (missing.length) {
      const what = dep.kind === 're-export' ? 're-export 了' : 'import 了';
      fail(`${rel} 从 ${dep.spec} ${what}不存在的导出：${missing.join(', ')}`);
    }
  }
}

if (!depChecked) console.log('  (没有相对模块依赖)');
else console.log(`  ✓ 校验了 ${depChecked} 条相对模块依赖，导入名与导出名全部对得上`);

/* ------------------------------------------------------------------ *
 * 6. 常量表的属性访问
 *
 * 第 5 节的兄弟问题，而且更隐蔽：`import { MSG } from './constants.js'` 本身
 * 完全合法（MSG 确实被导出了），但 `MSG.PAGE_SCAN` 却可能是 undefined ——
 * 因为那个常量压根没写进去。JS 不会报错，只会让 `{ type: undefined }`
 * 一路飘到消息处理器里，然后静默落在 default 分支上。
 *
 * 这个坑真实发生过一次：`page-bridge.js` 用 MSG.PAGE_SCAN 扫页面视频，
 * 而 constants.js 里没有这个键。结果是「页面视频列表」「页面内视频按钮」
 * 三条链路全部静默失效 —— 没有报错，只是点了没反应。
 *
 * 只检查**全大写属性名**的表（MSG / KIND / RECORD_STAGE …），
 * 避免把 `SETTINGS.concurrency` 这类小写配置项误判成缺失。
 * ------------------------------------------------------------------ */

console.log('\n· 常量表属性访问');

function parseConstTables(file) {
  const src = readFileSync(file, 'utf8');
  const tables = new Map();
  const re = /export const ([A-Z][A-Z0-9_]*)\s*=\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    const start = src.indexOf('{', m.index);
    let depth = 0;
    let i = start;
    for (; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') { depth -= 1; if (depth === 0) break; }
    }
    const body = src.slice(start + 1, i);
    const keys = new Set();
    for (const k of body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)) keys.add(k[1]);
    if (keys.size) tables.set(name, keys);
  }
  return tables;
}

const TABLES = parseConstTables(join(ROOT, 'src', 'core', 'constants.js'));
let constChecked = 0;

for (const file of walkExt(join(ROOT, 'src'), '.js')) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const src = readFileSync(file, 'utf8');

  for (const [table, keys] of TABLES) {
    // 文件自己定义了一份同名表（内容脚本就是这么干的，它不能用 import），
    // 那就以文件自己那份为准，跳过。
    if (new RegExp(`(?:const|let|var)\\s+${table}\\s*=`).test(src)) continue;

    const re = new RegExp(`\\b${table}\\.([A-Z][A-Z0-9_]*)\\b`, 'g');
    const bad = new Set();
    for (const m of src.matchAll(re)) {
      constChecked += 1;
      if (!keys.has(m[1])) bad.add(m[1]);
    }
    if (bad.size) {
      fail(`${rel} 用了 ${table} 里不存在的键：${[...bad].join(', ')}`);
    }
  }
}

if (!constChecked) console.log('  (没有常量表属性访问)');
else console.log(`  ✓ 校验了 ${constChecked} 处常量表属性访问，全部存在`);

/* ------------------------------------------------------------------ *
 * 7. 用了项目自己导出的东西，却忘了 import
 *
 * 第 5 节的镜像问题，而且**真发生过**：给 `titlePart()` 加了 `sanitizeSegment(...)`
 * 之后忘了在 pipeline.js 里 import。语法检查过、导入导出检查也过（那一节只查
 * "import 的名字存不存在"，不查"用到的名字有没有 import"），于是这个错一路
 * 溜到运行时 —— 表现是抓流收尾**全部失败**（"sanitizeSegment is not defined"），
 * 而报错出现在离屏文档里，界面上只看到一句"保存部分产物失败"。
 *
 * 判据刻意收得很窄，避免误报：
 *   只查「某个名字是**本项目某个模块导出的**、在文件里被当函数调用（`name(`）、
 *   而这个文件既没 import 它、也没自己声明它」。
 * 这样 console/Math/JSON 这类全局、以及第三方 API 都不会被误判 ——
 * 一个动不动就报错的检查，最后只会被绕过。
 * ------------------------------------------------------------------ */

console.log('\n· 跨模块调用的名字');

/** 收集全项目所有导出名 → 导出它的文件们（同名可能被多个模块导出） */
const exportIndex = new Map();
for (const file of walkExt(join(ROOT, 'src'), '.js')) {
  const { names, hasStar } = exportsOf(file);
  if (hasStar) continue;
  for (const name of names) {
    if (!exportIndex.has(name)) exportIndex.set(name, []);
    exportIndex.get(name).push(relative(ROOT, file).replace(/\\/g, '/'));
  }
}

/**
 * `get(key) {` 这种是对象字面量里的**方法简写定义**，不是调用。
 * 不排除它的话，`get` / `set` 这种名字会立刻造成误报 ——
 * 而一个动不动就报错的检查，最后只会被绕过。
 */
function isMethodDefinition(src, at, name) {
  const lineStart = src.lastIndexOf('\n', at) + 1;
  const before = src.slice(lineStart, at);
  if (!/^\s*(?:async\s+)?(?:static\s+)?$/.test(before)) return false;
  return /^\s*\([^()]*\)\s*\{/.test(src.slice(at + name.length));
}

let crossChecked = 0;
// test/ 也一起查：用例里少 import 一个辅助函数是同一类错误，
// 而它同样会被"看着通过"的用例掩盖过去（实际是 ReferenceError）。
for (const file of [...walkExt(join(ROOT, 'src'), '.js'), ...walkExt(join(ROOT, 'test'), '.mjs')]) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const raw = readFileSync(file, 'utf8');
  // 查"是不是被调用"要在**去掉注释和字符串**的版本上查（偏移不变，见 stripLiterals）。
  // 这个项目的注释写得又多又长，里面经常出现 `foo()` 这种写法（比如
  // "由 `classify()` 返回的字段"）—— 在原文里查会把它当成真调用，报一句
  // "你调用了 classify() 却没有 import"。一个动不动就误报的检查最后只会被绕过，
  // 所以这里必须和"重复键"那一节一样先剥掉注释/字符串。
  const src = stripLiterals(raw);

  // 自己声明的名字（函数/类/变量）和 import 进来的名字，都算"有来源"
  const local = new Set();
  for (const m of raw.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
  for (const m of raw.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
  for (const dep of depsOf(file)) {
    for (const n of dep.named) local.add(n.split(/\s+as\s+/).pop().trim());
    if (dep.defaultName) local.add(dep.defaultName);
  }

  for (const [name, definedIn] of exportIndex) {
    if (definedIn.includes(rel)) continue;
    if (local.has(name)) continue;
    // 只有当它被"当函数调用"或"当构造器调用"时才算 ——
    // 光出现一个同名的字符串 / 属性名 / 方法简写定义都不算。
    const callRe = new RegExp(`(^|[^.\\w$])(${name})\\s*\\(`, 'g');
    let called = false;
    for (const m of src.matchAll(callRe)) {
      const at = m.index + m[1].length; // 名字的起点（前缀可能是空串或一个字符）
      if (isMethodDefinition(src, at, name)) continue;
      called = true;
      break;
    }
    if (!called) continue;
    crossChecked += 1;
    const where = definedIn.length > 2
      ? `${definedIn.slice(0, 2).join('、')} 等 ${definedIn.length} 个模块`
      : definedIn.join('、');
    fail(`${rel} 调用了 ${name}()，但这个文件里既没有 import 它、也没有定义它（它导出自 ${where}）`);
  }
}

console.log(crossChecked
  ? `  （发现 ${crossChecked} 处可疑调用，见上面的错误）`
  : `  ✓ 校验了 ${exportIndex.size} 个项目内导出名，没有"用了却没 import"的情况`);

/* ------------------------------------------------------------------ *
 * 8. 对象字面量里重复的键
 *
 * 第 7 节的同类问题，也**真发生过**：给抓流会话加"自动保存配置"时，
 * 同一个对象字面量里先写了 `autoSnapshot: {...}`、后面又留着旧的
 * `autoSnapshot: null` —— 后者静默覆盖前者，于是 `s.autoSnapshot.enabled`
 * 读的是 null，**每一条抓流启动都直接抛异常**（13 条浏览器用例一起红）。
 *
 * 语法检查发现不了这个（合法 JS），运行时报的又是一句
 * "Cannot read properties of null"，离"重复键"很远。所以专门查一遍：
 * 同一个 `{}` 里出现两次同名键。
 *
 * 为了不误报，先把字符串和注释清掉，再按花括号深度找**同一层**的 `名字:`。
 * ------------------------------------------------------------------ */

console.log('\n· 对象字面量里的重复键');

/** 把字符串/模板串/注释换成等长的空格，保留结构（偏移不变，报行号方便） */
function stripLiterals(src) {
  const out = src.split('');
  let i = 0;
  const blank = (from, to) => { for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let k = i + 1;
      while (k < src.length) {
        if (src[k] === '\\') { k += 2; continue; }
        if (src[k] === c) { k += 1; break; }
        // ⚠️ 单/双引号字符串**不能跨行**：碰到换行就必须收手。
        // 不加这一条时，正文注释里的一个撇号（比如中文注释里的 'x'）
        // 会被当成字符串起点，一路吞到下一个引号 —— 于是后面真正的代码
        // 反而被当成"字符串内容"放过，产生一堆假报警。
        // （实测：dash.js 的 DRM 名单被报了 15 处假重复键。）
        if (src[k] === '\n' && c !== '`') break;
        k += 1;
      }
      blank(i + 1, k - 1);
      i = k;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** JS 关键字 / 字面量：`case 'x':` 这种也会"名字后面跟冒号"，但不是对象键 */
const NOT_A_KEY = new Set([
  'case', 'default', 'return', 'typeof', 'instanceof', 'new', 'void', 'delete', 'in', 'of',
  'do', 'else', 'try', 'finally', 'catch', 'switch', 'while', 'for', 'if', 'function', 'class',
  'const', 'let', 'var', 'import', 'export', 'await', 'yield', 'throw', 'break', 'continue',
  'this', 'super', 'null', 'true', 'false', 'undefined', 'NaN', 'Infinity',
]);

/** 找出同一层花括号里重复出现的 `名字:` */
function duplicateKeys(src) {
  const clean = stripLiterals(src);
  const stack = [new Map()];
  const dups = [];
  for (let i = 0; i < clean.length; i += 1) {
    const c = clean[i];
    if (c === '{') { stack.push(new Map()); continue; }
    if (c === '}') { if (stack.length > 1) stack.pop(); continue; }
    if (!/[A-Za-z_$]/.test(c)) continue;
    // 读一个名字
    let j = i;
    while (j < clean.length && /[\w$]/.test(clean[j])) j += 1;
    const name = clean.slice(i, j);
    // 必须紧跟着冒号（允许空格）
    let k = j;
    while (k < clean.length && (clean[k] === ' ' || clean[k] === '\t')) k += 1;
    if (clean[k] === ':' && !NOT_A_KEY.has(name)) {
      // 而且必须"处在键的位置"：前面是 { 、, 或者行首（前面只有空白）。
      // 不加这条的话，三元表达式 `a ? b : c` 里的 `b :` 会被当成键
      // —— 实测 dash.js 的 `t: Number.isFinite(t) ? t : null` 就是这么被误报的。
      let p = i - 1;
      while (p >= 0 && (clean[p] === ' ' || clean[p] === '\t')) p -= 1;
      const atKeyPosition = p < 0 || clean[p] === '{' || clean[p] === ',' || clean[p] === '\n';
      if (atKeyPosition && clean[i - 1] !== '.') {
        const line = clean.slice(0, i).split('\n').length;
        const top = stack[stack.length - 1];
        if (top.has(name)) dups.push({ name, line, first: top.get(name) });
        else top.set(name, line);
      }
    }
    i = j - 1;
  }
  return dups;
}

let dupChecked = 0;
let dupFound = 0;
for (const file of [...walkExt(join(ROOT, 'src'), '.js'), ...walkExt(join(ROOT, 'test'), '.mjs')]) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const dups = duplicateKeys(readFileSync(file, 'utf8'));
  dupChecked += 1;
  for (const d of dups) {
    dupFound += 1;
    fail(`${rel}:${d.line} 同一个对象字面量里重复写了键 ${d.name}（第 ${d.first} 行已经有一个）—— 后面那个会静默覆盖前面那个`);
  }
}
console.log(dupFound
  ? `  （扫了 ${dupChecked} 个文件，发现 ${dupFound} 处重复键，见上面的错误）`
  : `  ✓ 扫了 ${dupChecked} 个文件，没有发现重复键`);

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

console.log('');
if (failures) {
  console.error(`✗ 体检未通过：${failures} 个问题`);
  process.exit(1);
}
console.log(`✓ 体检通过（${targets.length} 个 JS 文件）`);
