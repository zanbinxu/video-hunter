#!/usr/bin/env node
/**
 * 看一眼扩展的产物存储（OPFS）：有哪些文件、多大、什么时候写的。
 *
 * 为什么值得有这么一个工具：用户会问「抓流的东西存在哪 / 是不是临时的 /
 * 隔一会儿再保存还来得及吗」，而这些问题只靠读代码回答不了 ——
 * 要看**这台机器上真实的那份存储**。排查"产物不见了""保存失败"时也用得上。
 *
 * 用法：
 *   node tools/opfs-check.mjs --port 9333            # 列出 OPFS 里的文件和用量
 *   node tools/opfs-check.mjs --port 9333 --write     # 先写一个标记文件再列（验持久性）
 *
 * 持久性怎么验（两次运行之间把浏览器**整个关掉再重开**，profile 不变）：
 *   node tools/opfs-check.mjs --port 9333 --write
 *   （关掉 Chrome，用同一个 --user-data-dir 重新启动）
 *   node tools/opfs-check.mjs --port 9333            # 标记文件还在 → OPFS 是持久的
 *
 * 落盘位置（Windows，Chrome 153 实测）：
 *   <user-data-dir>\Default\File System\000\t\00\<编号>     ← 文件内容（文件名是编号）
 *   <user-data-dir>\Default\File System\Origins\            ← 哪个源对应哪个目录
 * 也就是说 OPFS 里的产物**就是磁盘上的真文件**，不在内存里 —— 这正是
 * "抓完隔几分钟再点保存到磁盘"依然能成功的原因（那一步只是分块拷贝）。
 *
 * 需要在带 `--enable-unsafe-extension-debugging` 启动的 Chrome 上跑
 * （Chrome 137 之后命令行 `--load-extension` 被禁用，只能走 CDP 的 Extensions.loadUnpacked）。
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const portArg = process.argv.indexOf('--port');
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 9333;
const WRITE = process.argv.includes('--write');
const MARK = 'vh-opfs-check.bin';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  let version;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    version = await res.json();
  } catch (err) {
    throw new Error(`连不上 Chrome 调试端口 ${PORT}：${err.message}`);
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { send, close: () => ws.close(), version };
}

async function evalIn(cdp, sessionId, expression) {
  const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (res.result?.exceptionDetails) {
    throw new Error(res.result.exceptionDetails.exception?.description || '页面里执行出错');
  }
  return res.result?.result?.value;
}

const cdp = await connect();
console.log(`· 浏览器：${cdp.version.Browser}`);

const loaded = await cdp.send('Extensions.loadUnpacked', { path: ROOT });
if (loaded.error) {
  console.error(`✗ 加载扩展失败：${loaded.error.message}`);
  console.error('  （浏览器需要用 --enable-unsafe-extension-debugging 启动）');
  cdp.close();
  process.exit(1);
}
const extId = loaded.result.id;
console.log(`· 扩展 ID：${extId}`);

const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
const attached = await cdp.send('Target.attachToTarget', { targetId: created.result.targetId, flatten: true });
const session = attached.result.sessionId;
await cdp.send('Runtime.enable', {}, session);
await cdp.send('Page.enable', {}, session);
await cdp.send('Page.navigate', { url: `chrome-extension://${extId}/src/recorder/recorder.html` }, session);
await sleep(1500);

if (WRITE) {
  const written = await evalIn(cdp, session, `(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(${JSON.stringify(MARK)}, { create: true });
    const writable = await handle.createWritable();
    await writable.write(new TextEncoder().encode('写于 ' + new Date().toISOString()));
    await writable.close();
    return JSON.stringify({ ok: true, size: (await handle.getFile()).size });
  })()`);
  console.log(`· 已写入标记文件 ${MARK}：${written}`);
}

const listing = JSON.parse(await evalIn(cdp, session, `(async () => {
  const root = await navigator.storage.getDirectory();
  const names = [];
  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== 'file') continue;
    const file = await handle.getFile();
    names.push({ name, size: file.size, modified: new Date(file.lastModified).toISOString() });
  }
  const estimate = await navigator.storage.estimate();
  return JSON.stringify({ names, usage: estimate.usage, quota: estimate.quota });
})()`));

// 产物按前缀分组，和管理页的口径一致
const groups = { 抓流: 'vh-mse-', 录制: 'vh-rec-' };
console.log(`\n· OPFS 里共 ${listing.names.length} 个文件`);
for (const [label, prefix] of Object.entries(groups)) {
  const mine = listing.names.filter((f) => f.name.startsWith(prefix));
  const bytes = mine.reduce((n, f) => n + f.size, 0);
  console.log(`  ${label} ${mine.length} 个｜${(bytes / 1048576).toFixed(1)} MB`);
}
for (const f of listing.names) {
  console.log(`    ${f.name}｜${f.size} 字节｜${f.modified}`);
}
console.log(`\n· 用量 ${(listing.usage / 1048576).toFixed(1)} MB`
  + `｜配额 ${(listing.quota / 1073741824).toFixed(1)} GB`
  + `（扩展带 unlimitedStorage 权限，不受普通站点那套配额驱逐）`);
if (WRITE) {
  console.log(`· 标记文件在不在：${listing.names.some((f) => f.name === MARK) ? '在 ✓' : '不在 ✗'}`);
  console.log('  接着把浏览器整个关掉、用同一个 --user-data-dir 重启，再跑一次（不带 --write）：还在就说明 OPFS 是持久的。');
}
cdp.close();
