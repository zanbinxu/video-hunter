/**
 * 抓流 / 录制管理。
 *
 * 它**不是**采集的持有者 —— 采集跑在离屏文档里（见 src/offscreen/offscreen.js）。
 * 这个页面做四件事：
 *   1. 显示当前状态（从 service worker 读）
 *   2. 发起 / 停止录制
 *   3. 列出 OPFS 里的产物，按来源分组（抓流 / 录制），导出到用户选的位置
 *   4. 给任何一个视频文件做「拖不动进度条」的体检与修复
 *
 * 第 3 步必须在这个页面上做：showSaveFilePicker 需要用户手势，
 * 而离屏文档里没有。
 *
 * ## 列表里的时长必须是**文件的真实时长**
 *
 * 以前这里显示的是"这次操作持续了多久"。抓流时用户会暂停、拖动、切标签页，
 * 挂钟时间和视频长度能差出好几倍 —— 报挂钟时间等于骗人。
 * 现在时长来自产物自己的 mvhd（见 readMovieDurationSeconds）：
 * 新产物在写盘时就顺手记进索引，老产物第一次列表时读一次文件头再回填。
 */
import { MSG, RECORD_STAGE, REC_PREFIX, CAPTURE_PREFIX, MEDIA_PREFIXES, MEDIA_KIND } from '../core/constants.js';
import { formatBytes } from '../core/classify.js';
import { sanitizeSegment } from '../core/filename.js';
import { getSettings, setSettings } from '../core/settings.js';
import { createMediaIndex } from '../core/media-index.js';
import { describeStorageUse } from '../core/storage-error.js';
import { isAutoSnapshotName } from '../core/capture-limits.js';
import { inspectSeekability, repairTimelineGaps, readMovieDurationSeconds } from '../parser/seek-check.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const mediaIndex = createMediaIndex();

const state = {
  targetTabId: Number(params.get('tabId')) || null,
  record: null,
  media: [],
  timer: null,
  exporting: false,
  diag: null,
  /** 已经提示过的那次抓流，避免每次刷新都重复弹一遍 */
  announced: null,
  /** 已经播报过的那次自动切分（用时间戳判重） */
  lastCutSeen: null,
  /** 已经播报过的自动保存 / 自动保存失败（用时间戳或文案判重，避免反复弹） */
  autoSnapshotSeen: null,
  warningSeen: null,
  /** 已经播报过的"抓流进行中"提示（快到切段阈值 / 刚切了一段） */
  captureNoticeSeen: null,
};

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload }).catch(() => null);
}

function log(text, cls = '') {
  const box = $('log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function showNotice(kind, title, body) {
  const box = $('notice');
  box.className = `notice ${kind}`;
  box.textContent = '';
  const head = document.createElement('b');
  head.textContent = title;
  box.appendChild(head);
  if (body) {
    // 按行拆开：这些提示经常是多条事实（来源、时长、下一步），
    // 挤成一段 textContent 会把换行吃掉、读起来像一坨。
    for (const line of String(body).split('\n')) {
      if (!line.trim()) continue;
      const p = document.createElement('div');
      p.textContent = line;
      box.appendChild(p);
    }
  }
  box.hidden = false;
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/* ------------------------------------------------------------------ *
 * OPFS —— 产物的存放地
 * ------------------------------------------------------------------ */

async function opfsRoot() {
  return navigator.storage.getDirectory();
}

/**
 * 判断一个文件是抓流产物还是录制产物。
 *
 * 前缀是首选判据，但**不能只靠前缀**：早期版本的抓流产物也用 `vh-rec-`，
 * 光看名字会把它们全归到"录制"里。结构上两者是能分开的 ——
 * 抓流产物由合并器写出、带 fastStart，所以是 `ftyp` 紧跟 `moov`；
 * 录制产物顺序写盘做不到快启动，`ftyp` 后面直接是 `mdat`（moov 在文件末尾）。
 * 读 32 个字节就能定论。
 */
async function detectKind(name, file) {
  if (name.startsWith(CAPTURE_PREFIX)) return MEDIA_KIND.CAPTURE;
  if (!name.startsWith(REC_PREFIX)) return MEDIA_KIND.RECORD;
  try {
    const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    // MP4：第二个 box 是 moov（抓流产物把 moov 写在最前面）
    if (head.length >= 16 && String.fromCharCode(head[4], head[5], head[6], head[7]) === 'ftyp') {
      const second = String.fromCharCode(head[12], head[13], head[14], head[15]);
      if (second === 'moov') return MEDIA_KIND.CAPTURE;
    }
    // WebM：EBML 魔数（画面也是 WebM 的抓流产物存成 .webm）
    if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
      return MEDIA_KIND.CAPTURE;
    }
  } catch { /* 读不了就按前缀算 */ }
  return MEDIA_KIND.RECORD;
}

/**
 * 从一个文件里读真实时长。
 *
 * 刻意**分段读**，不把整个文件读进内存：一个两小时的录制可能有好几个 GB，
 * 为了在列表里显示个时长把它读一遍是不能接受的。
 *   · 抓流产物：moov 在开头 → 读前 512 KB 就够
 *   · 录制产物：moov 在末尾 → 退化成读最后 4 MB
 * 两段都找不到就返回 null，界面显示「时长未知」，不瞎猜。
 */
async function probeFileDuration(file) {
  try {
    const headSize = Math.min(file.size, 512 * 1024);
    const head = new Uint8Array(await file.slice(0, headSize).arrayBuffer());
    const fromHead = readMovieDurationSeconds(head);
    if (fromHead) return fromHead;
  } catch { /* 落到尾巴那一段再试 */ }
  try {
    const tailSize = Math.min(file.size, 4 * 1024 * 1024);
    const tail = new Uint8Array(await file.slice(file.size - tailSize, file.size).arrayBuffer());
    return readMovieDurationSeconds(tail);
  } catch {
    return null;
  }
}

/**
 * 列出 OPFS 里的全部产物。
 *
 * 时长优先取索引；索引里没有（老文件、换过 profile）才去读文件，
 * 读完回填索引 —— 所以每个文件最多只会被读这一次。
 */
async function listMediaFiles() {
  try {
    const root = await opfsRoot();
    const found = [];
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'file') continue;
      if (!MEDIA_PREFIXES.some((p) => name.startsWith(p))) continue;
      const file = await handle.getFile();
      found.push({ name, handle, size: file.size, lastModified: file.lastModified, file });
    }
    found.sort((a, b) => b.lastModified - a.lastModified);

    const index = await mediaIndex.reconcile(found.map((f) => f.name));
    const out = [];
    for (const item of found) {
      const meta = index[item.name];
      let kind = meta?.kind || null;
      let seconds = meta?.seconds ?? null;
      if (!kind || seconds == null) {
        if (!kind) kind = await detectKind(item.name, item.file);
        if (seconds == null) seconds = await probeFileDuration(item.file);
        await mediaIndex.patch(item.name, { kind, seconds });
      }
      // 「已经导出过」是**用户自己确认过的安全信号**：只有它才能作为
      // 「清理已导出的」的依据（按体积/时长猜哪几个重复太危险了）。
      out.push({ ...item, kind, seconds, exportedAt: meta?.exportedAt ?? null });
    }
    return out;
  } catch (err) {
    log(`读取产物目录失败：${err?.message || err}`, 'err');
    return [];
  }
}

/**
 * 存储用量那一行 + 「清理已导出的」。
 *
 * 为什么要露出来：产物是攒在浏览器私有存储里的（配额有限，实测 5.6 GB），
 * 用户看不到任何数字的时候，只会在**写不进去的那一刻**才发现 ——
 * 而那时候他手上正好有一份还没保存的抓流。
 */
async function renderStorageUse() {
  const line = $('storage-use');
  const cleanBtn = $('clean-exported');
  if (!line) return;
  try {
    const estimate = await navigator.storage.estimate();
    const text = describeStorageUse(estimate);
    const exported = state.media.filter((m) => m.exportedAt);
    const exportedBytes = exported.reduce((n, m) => n + (m.size || 0), 0);
    line.textContent = [text, exported.length ? `已导出 ${exported.length} 个（${formatBytes(exportedBytes)}）可以清理` : '']
      .filter(Boolean).join('　·　');
    cleanBtn.hidden = exported.length === 0;
    cleanBtn.textContent = `清理已导出的 ${exported.length} 个`;
  } catch (err) {
    line.textContent = '读不到存储用量';
  }
}

/** 删掉**已经导出过**的产物：这些文件用户手上已经有了，删掉不丢东西 */
async function cleanExported() {
  const targets = state.media.filter((m) => m.exportedAt);
  if (!targets.length) return;
  const bytes = targets.reduce((n, m) => n + (m.size || 0), 0);
  if (!window.confirm(`删掉 ${targets.length} 个已经导出过的产物（共 ${formatBytes(bytes)}）？\n`
    + '它们已经保存在你选过的位置了，删的只是浏览器里的这一份。')) return;
  let done = 0;
  let freed = 0;
  for (const item of targets) {
    try {
      await (await opfsRoot()).removeEntry(item.name);
      await mediaIndex.forget(item.name);
      done += 1;
      freed += item.size || 0;
    } catch (err) {
      log(`删除 ${item.name} 失败：${err?.message || err}`, 'err');
    }
  }
  log(`已清理 ${done} 个已导出的产物，释放 ${formatBytes(freed)}`, 'ok');
  await refreshMedia();
}

/** 流式导出：分块拷贝，内存占用恒定，几个 GB 也不怕 */
async function exportRecording(name) {
  if (state.exporting) return;
  const root = await opfsRoot();
  const handle = await root.getFileHandle(name);
  const file = await handle.getFile();

  let dest = null;
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      dest = await window.showSaveFilePicker({
        suggestedName: sanitizeSegment(name, 120),
        types: [{ description: '视频', accept: { 'video/mp4': ['.mp4'], 'video/webm': ['.webm'] } }],
      });
    } catch (err) {
      if (err?.name === 'AbortError') { log('用户取消了保存对话框'); return; }
      log(`保存对话框失败，改用下载器：${err?.message || err}`, 'err');
    }
  }

  state.exporting = true;
  $('export-bar').hidden = false;
  try {
    if (dest) {
      const writable = await dest.createWritable();
      const reader = file.stream().getReader();
      let written = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        written += value.byteLength;
        $('export-fill').style.width = `${((written / file.size) * 100).toFixed(1)}%`;
      }
      await writable.close();
      log(`已导出：${name}（${formatBytes(file.size)}）`, 'ok');
      showNotice('ok', '导出完成', '文件已经写到你在对话框里选的位置。');
      // 走到这里才算**真的落到用户选的位置**（对话框那条路会等 writable.close）。
      // 只有这条路才敢标「已导出」—— 交给浏览器下载器那条没法确认成功。
      await markExported(name);
    } else {
      // 没有 File System Access：只能整块交给浏览器下载器
      const url = URL.createObjectURL(file);
      try {
        await chrome.downloads.download({ url, filename: name, conflictAction: 'uniquify', saveAs: true });
      } catch {
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      log(`已交给浏览器下载器：${name}`, 'ok');
    }
  } catch (err) {
    log(`导出失败：${err?.message || err}`, 'err');
    showNotice('err', '导出失败', String(err?.message || err));
  } finally {
    state.exporting = false;
    setTimeout(() => { $('export-bar').hidden = true; $('export-fill').style.width = '0%'; }, 800);
  }
}

async function deleteRecording(name) {
  try {
    const root = await opfsRoot();
    await root.removeEntry(name);
    // 索引也要跟着删，否则管理页会一直显示一个已经不存在的文件
    await mediaIndex.forget(name);
    log(`已删除：${name}`);
    await refreshMedia();
  } catch (err) {
    log(`删除失败：${err?.message || err}`, 'err');
  }
}

/** 把这份产物标记成「已经导出过」（用户手上有了，清理时是安全的） */
async function markExported(name) {
  try {
    await mediaIndex.patch(name, { exportedAt: Date.now() });
    const item = state.media.find((m) => m.name === name);
    if (item) item.exportedAt = Date.now();
    renderMedia();
    await renderStorageUse();
  } catch (err) {
    console.info('[vh/rec] 记录「已导出」失败（不影响导出本身）：', err);
  }
}

/** 秒 → mm:ss / h:mm:ss。用于列表里的**真实时长**。 */
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function mediaRow(item) {
  const row = document.createElement('div');
  row.className = 'variant';
  row.style.cursor = 'default';

  const left = document.createElement('div');
  left.style.minWidth = '0';
  left.style.flex = '1';

  const name = document.createElement('div');
  name.className = 'res';
  name.style.fontSize = '13px';
  name.style.overflow = 'hidden';
  name.style.textOverflow = 'ellipsis';
  name.style.whiteSpace = 'nowrap';
  name.textContent = item.name;

  const meta = document.createElement('div');
  meta.className = 'meta';
  // 时长放在最前面 —— 用户最想知道的就是"这个文件多长"，
  // 而且必须是**文件自己的时长**，不是"这次操作持续了多久"
  const durationText = formatDuration(item.seconds);
  const parts = [
    durationText ? `时长 ${durationText}` : '时长未记录',
    formatBytes(item.size),
    new Date(item.lastModified).toLocaleString(),
    // 「已导出」是清理时的凭据：用户不会想删掉自己还没拿出来过的东西
    item.exportedAt ? '已导出到磁盘' : '',
    // 自动保存的那一份会被下一份覆盖 —— 说清楚，免得用户发现它"不见了"以为出问题
    isAutoSnapshotName(item.name) ? '自动保存（每 N 分钟更新，只留最新一份）' : '',
  ].filter(Boolean);
  meta.textContent = parts.join(' · ');
  if (!durationText) meta.style.opacity = '.7';
  if (item.exportedAt) meta.style.color = 'var(--ok, #4ade80)';

  left.append(name, meta);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn primary';
  saveBtn.textContent = '保存到磁盘';
  saveBtn.addEventListener('click', () => exportRecording(item.name));

  const diagBtn = document.createElement('button');
  diagBtn.className = 'btn';
  diagBtn.textContent = '体检';
  diagBtn.title = '检查这个文件在播放器里能不能拖进度条';
  diagBtn.addEventListener('click', async () => {
    try {
      const file = await (await opfsRoot()).getFileHandle(item.name).then((h) => h.getFile());
      await runDiag(file);
      $('diag-report').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (err) {
      showNotice('err', '读不了这个文件', String(err?.message || err));
    }
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'btn';
  delBtn.textContent = '删除';
  delBtn.addEventListener('click', () => deleteRecording(item.name));

  row.append(left, saveBtn, diagBtn, delBtn);
  return row;
}

function renderGroup(boxId, items, emptyText) {
  const box = $(boxId);
  box.textContent = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = emptyText;
    box.append(empty);
    return;
  }
  for (const item of items) box.append(mediaRow(item));
}

function renderMedia() {
  const captures = state.media.filter((m) => m.kind === MEDIA_KIND.CAPTURE);
  const records = state.media.filter((m) => m.kind !== MEDIA_KIND.CAPTURE);
  renderGroup('captures', captures, '还没有抓流文件。在视频页面上点扩展图标 → 「抓流」。');
  renderGroup('recordings', records, '还没有录制文件。抓流拿不到时才用「录制」兜底。');
}

async function refreshMedia() {
  state.media = await listMediaFiles();
  renderMedia();
  // 用量和"能不能清理"都要跟着刷新 —— 导出一个文件之后那行数字就该变
  await renderStorageUse();
}

/* ------------------------------------------------------------------ *
 * 视频文件体检 / 修复
 *
 * 为什么把它做进界面而不是留一个命令行工具：用户遇到的是「我这个文件拖不动」，
 * 而我看不到他那个文件。把体检做成一个按钮，他能在原地拿到一份
 * 「是哪种毛病、哪一秒断的、修完会变成什么样」的报告 —— 一次说清，
 * 不用来回猜。逻辑本身在 src/parser/seek-check.js 里，是纯函数，有测试。
 * ------------------------------------------------------------------ */

function diagLine(text, cls = '') {
  const box = $('diag-report');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  box.appendChild(line);
  return line;
}

function renderDiag(report, fileName) {
  const box = $('diag-report');
  box.textContent = '';
  box.hidden = false;

  diagLine(`${fileName}（${formatBytes(report.bytes)}）`);
  diagLine(report.verdict.text);
  if (report.mvhd) diagLine(`总时长：${report.mvhd.seconds.toFixed(2)} 秒`);
  for (const t of report.tracks) {
    const label = t.handler === 'vide' ? '视频' : t.handler === 'soun' ? '音频' : t.handler;
    const kf = t.keyframes === null ? '没有关键帧索引' : `${t.keyframes} 个关键帧`;
    let line = `${label}轨：${t.samples} 个样本｜${t.seconds.toFixed(2)} 秒｜${kf}`;
    if (t.seekSlackSeconds > 0) {
      line += `｜拖动最坏会退回 ${t.seekSlackSeconds.toFixed(1)} 秒`;
    }
    diagLine(line);
  }
  for (const p of report.problems) diagLine(`· ${p}`, 'warn');

  // 只有"所有轨一起断"的死气才允许动手；单轨缺口压掉会让音画错位，
  // 界面上不能给一个会毁掉视频的按钮。
  $('diag-fix').hidden = !report.repairable;
  if (report.repairable) {
    // 各轨的空洞是同一段墙钟时间，取最大的一条轨来报时长（相加会翻倍）
    const longest = Math.max(
      0,
      ...report.tracks.map((t) => t.gaps
        .filter((g) => g.deadAir)
        .reduce((s, g) => s + g.lengthSeconds, 0)),
    );
    diagLine(`可以修：把 ${longest.toFixed(1)} 秒空洞从时间轴里去掉。只改样本表，不重编码，文件大小不变。`, 'ok');
  }
}

async function runDiag(file) {
  $('diag-fix').hidden = true;
  $('diag-report').hidden = false;
  $('diag-report').textContent = '正在读取…';
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const report = inspectSeekability(bytes);
    state.diag = { name: file.name, bytes, report };
    renderDiag(report, file.name);
    // 体检本来就把整个文件读进来了，顺手把真实时长回填进索引 ——
    // 老产物（索引里没有）下次列目录就不用再读一遍文件了。
    if (report.mvhd?.seconds > 0) {
      await mediaIndex.patch(file.name, { seconds: report.mvhd.seconds });
      await refreshMedia();
    }
  } catch (err) {
    $('diag-report').textContent = '';
    diagLine(`读不了这个文件：${err?.message || err}`, 'err');
    state.diag = null;
  }
}

async function fixDiag() {
  const d = state.diag;
  if (!d) return;
  const suggested = d.name.replace(/\.(mp4|m4v|mov)$/i, '') + '-可拖动.mp4';
  let dest = null;
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      dest = await window.showSaveFilePicker({
        suggestedName: sanitizeSegment(suggested, 120),
        types: [{ description: '视频', accept: { 'video/mp4': ['.mp4'], 'video/webm': ['.webm'] } }],
      });
    } catch (err) {
      if (err?.name === 'AbortError') { log('用户取消了保存对话框'); return; }
      log(`保存对话框失败，改用下载器：${err?.message || err}`, 'err');
    }
  }

  $('diag-bar').hidden = false;
  $('diag-fill').style.width = '30%';
  try {
    const result = repairTimelineGaps(d.bytes);
    if (!result.ok) {
      $('diag-report').textContent = '';
      diagLine('没有修，原因如下：', 'err');
      diagLine(result.reason);
      for (const s of result.skipped || []) {
        diagLine(`· ${s.handler === 'vide' ? '视频' : s.handler === 'soun' ? '音频' : s.handler}轨：`
          + `${Number(s.lengthSeconds).toFixed(1)} 秒缺口 —— ${s.reason}`);
      }
      return;
    }
    $('diag-fill').style.width = '70%';
    // 修完必须自己再体检一遍：这是唯一能证明"改对了"的证据
    const after = inspectSeekability(result.bytes);
    $('diag-fill').style.width = '100%';

    if (dest) {
      const writable = await dest.createWritable();
      await writable.write(result.bytes);
      await writable.close();
      log(`已写出修复版：${suggested}（${formatBytes(result.bytes.length)}）`, 'ok');
    } else {
      const blob = new Blob([result.bytes], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      try {
        await chrome.downloads.download({ url, filename: suggested, conflictAction: 'uniquify', saveAs: true });
      } catch {
        const a = document.createElement('a');
        a.href = url;
        a.download = suggested;
        a.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      log(`已交给浏览器下载器：${suggested}`, 'ok');
    }

    $('diag-report').textContent = '';
    diagLine('修复完成，修复后的体检结果：');
    for (const s of result.skipped || []) {
      diagLine(`（跳过了 ${s.handler === 'vide' ? '视频' : '音频'}轨的 ${Number(s.lengthSeconds).toFixed(1)} 秒缺口：${s.reason}）`, 'warn');
    }
    renderDiag(after, suggested);
    showNotice(
      'ok',
      '修好了',
      `压缩掉 ${result.droppedSeconds.toFixed(1)} 秒空洞，时长 ${d.report.mvhd?.seconds.toFixed(1)} 秒 → `
      + `${after.mvhd?.seconds.toFixed(1)} 秒。画面一帧没少，只是把那几段没有画面的空白去掉了。`,
    );
  } catch (err) {
    log(`修复失败：${err?.message || err}`, 'err');
    showNotice('err', '修复失败', String(err?.message || err));
  } finally {
    setTimeout(() => { $('diag-bar').hidden = true; $('diag-fill').style.width = '0%'; }, 800);
  }
}

/* ------------------------------------------------------------------ *
 * 状态渲染
 * ------------------------------------------------------------------ */

function render() {
  const r = state.record;
  const stage = r?.stage || RECORD_STAGE.IDLE;

  const hint = $('stage-hint');
  const dot = $('live-dot');
  const isLive = stage === RECORD_STAGE.RECORDING || stage === RECORD_STAGE.FINALIZING;
  dot.classList.toggle('live', isLive);

  const labels = {
    [RECORD_STAGE.IDLE]: '空闲',
    [RECORD_STAGE.RECORDING]: '正在抓取',
    [RECORD_STAGE.FINALIZING]: '正在收尾（写入索引）…',
    [RECORD_STAGE.READY]: '完成，等待导出',
    [RECORD_STAGE.ERROR]: '出错了',
  };
  hint.textContent = r?.stage === RECORD_STAGE.ERROR && r?.retryable
    ? '没能写进文件（数据还留着）'
    : (labels[stage] || stage);

  // 收尾期间的进度：长音频转码要几十秒，没有这条进度条，
  // 「正在收尾」看起来就像卡死了，用户会去点第二次停止。
  const finalizeBar = $('finalize-bar');
  const progress = r?.progress;
  if (stage === RECORD_STAGE.FINALIZING && progress && Number.isFinite(progress.fraction)) {
    finalizeBar.hidden = false;
    $('finalize-fill').style.width = `${Math.round(Math.max(0, Math.min(1, progress.fraction)) * 100)}%`;
    hint.textContent = `${progress.label || '正在收尾'} ${Math.round(progress.fraction * 100)}%`;
  } else {
    finalizeBar.hidden = true;
    $('finalize-fill').style.width = '0%';
  }

  const stats = r?.stats || {};
  // 正在跑的时候显示"已经抓了多久"（这是个实时计时器）；
  // 一旦收尾，就换成**文件的真实时长** —— 这才是用户要的那个数。
  const isMse = r?.mode === 'mse';
  if (isLive) {
    $('timer').textContent = formatClock(stats.elapsedMs || (Date.now() - (r.startedAt || Date.now())));
  } else if (Number.isFinite(r?.mediaSeconds) && r.mediaSeconds > 0) {
    $('timer').textContent = formatDuration(r.mediaSeconds);
  } else {
    $('timer').textContent = '00:00:00';
  }
  $('st-frames').textContent = isMse
    ? (stats.chunks ? `${stats.chunks} 段数据` : '抓流（不重编码）')
    : `${r?.frames ?? stats.frames ?? 0} 帧`;
  $('st-dropped').textContent = isMse
    // 抓流时这一格显示"已经自动存了几段"—— 换集就会多一段，
    // 用户一眼能看出播放列表被拆成了几个文件
    ? `已存 ${r?.parts ?? stats.parts ?? 0} 个`
    : `丢帧 ${r?.dropped ?? stats.dropped ?? 0}`;
  $('st-size').textContent = formatBytes(r?.size ?? stats.bytes ?? 0);
  $('st-codec').textContent = r?.info
    ? `${r.info.videoCodec || '?'}${r.info.videoFallback ? '（回退）' : ''} / ${r.info.audioCodec || '无音轨'} · ${r.info.width || '?'}×${r.info.height || '?'}`
    : (isMse ? '无损（不重编码）' : '—');

  $('start').disabled = isLive;
  $('stop').disabled = stage !== RECORD_STAGE.RECORDING;
  // 写盘失败但数据还在：给「重试保存」和「放弃这一份」两个出口。
  // 没有它们的话，用户攒了四十分钟的东西只能卡在那儿，而且抓流也开不了新的。
  const canRetry = stage === RECORD_STAGE.ERROR && r?.retryable === true;
  $('retry').hidden = !canRetry;
  $('discard').hidden = !canRetry;
  // 「先保存已录到的部分」只对抓流有意义：录制的 moov 在文件末尾，
  // 不收尾就写不出能播的文件，给个按钮反而是骗人。
  const canSnapshot = stage === RECORD_STAGE.RECORDING && isMse;
  $('snapshot').hidden = !canSnapshot;
  $('snapshot').disabled = !canSnapshot || !(stats.chunks > 0);
  $('snapshot-hint').hidden = !canSnapshot;
  // 「自动保存」只在抓流时才有意义，而且就摆在抓流的状态卡里 ——
  // 用户是在看着这一段抓流的时候才想起来要开/关它
  $('autosave-row').hidden = !isMse;
  $('autosave-hint').hidden = $('autosave').checked;
  // 「自动保存已录到的部分」同理：抓流中的意外（崩溃、配额满）只有它兜得住
  $('autosnap-row').hidden = !isMse;
  $('autosnap-hint').hidden = !isMse || !$('autosnap').checked;
  $('autosnap-minutes').disabled = !$('autosnap').checked;
  $('autosnap-basis').disabled = !$('autosnap').checked;
  $('autoexport-row').hidden = !isMse;
  $('autoexport-hint').hidden = !isMse || !$('autoexport').checked;
  // 「攒太大自动切一段」同理：只有抓流才有这个问题（录制是边录边落盘）
  $('autocut-row').hidden = !isMse;
  $('autocut-hint').hidden = !isMse || !$('autocut').checked;
  $('autocut-mb').disabled = !$('autocut').checked;

  const target = $('target-info');
  if (r?.stage === RECORD_STAGE.ERROR && r?.error) {
    // 失败时必须把**错误本身**摆在状态卡里。原来这里只在有 fileName 时才显示
    // error，于是"收尾失败"的情况下用户只看到一句"目标标签页 ID：12"。
    target.textContent = `${r.error}`
      + (r.pendingBytes ? `　（这一份有 ${formatBytes(r.pendingBytes)}，还没丢）` : '')
      + (r.retryable ? '　点下面的「重试保存」，或者「放弃这一份」。' : '');
  } else if (r?.fileName) {
    const stalled = r?.stalledMs || r?.stats?.stalledMs || 0;
    const wall = r?.durationMs ? formatClock(r.durationMs) : null;
    const real = formatDuration(r.mediaSeconds);
    target.textContent = `输出文件：${r.fileName}`
      // 时长一律说"文件自己的时长"，挂钟时间只在和它不一致时作为解释出现
      + (real ? `　文件时长：${real}` : '')
      + (wall && real && Math.abs(r.durationMs / 1000 - r.mediaSeconds) > 2
        ? `（这次抓取过程持续了 ${wall}，中间暂停/拖动/切标签页的时间不算在文件里）`
        : '')
      + (r.error ? `　错误：${r.error}` : '')
      + (r.info?.targetKind === 'memory' ? '　（注意：这次走了内存缓冲）' : '')
      + (stalled > 1200
        ? `　（采集期间采集源停了 ${(stalled / 1000).toFixed(0)} 秒 —— 标签页被切走、被遮挡或屏幕锁定，`
          + '那几段本来就没有画面，已经从产物里去掉，所以文件比挂钟时间短）'
        : '')
      + (r.info?.videoFallback
        ? '　（这台机器没有可用的 H.264 编码器，已回退到 VP9；产物仍是 MP4，'
          + 'Chrome / VLC / PotPlayer 能播，但个别老播放器可能不认）'
        : '');
  } else if (state.targetTabId != null) {
    target.textContent = `目标标签页 ID：${state.targetTabId}`;
  } else {
    target.textContent = '还没有指定目标标签页 —— 请在要录的页面上点工具栏图标发起。';
  }
}

async function refreshState() {
  const res = await send(MSG.RECORD_STATE);
  state.record = res?.state || null;
  if (state.targetTabId == null && state.record?.tabId != null) {
    state.targetTabId = state.record.tabId;
  }
  render();
}

/* ------------------------------------------------------------------ *
 * 动作
 * ------------------------------------------------------------------ */

async function startRecording() {
  if (state.targetTabId == null) {
    showNotice('warn', '没有目标标签页', '请到要录制的视频页面上，点击浏览器工具栏里的扩展图标，从面板发起录制。');
    return;
  }
  $('start').disabled = true;
  try {
    // tabCapture 要求目标标签页处于活动状态。我们自己是活动标签页，
    // 所以先把目标页切到前台，再发起采集。
    await chrome.tabs.update(state.targetTabId, { active: true });
    await new Promise((r) => setTimeout(r, 350));

    const res = await send(MSG.RECORD_START, { tabId: state.targetTabId });
    if (!res?.ok) {
      showNotice('err', '启动录制失败', res?.error || '未知原因');
      log(`启动失败：${res?.error}`, 'err');
      $('start').disabled = false;
      return;
    }
    log(`录制已开始：${res.fileName}（${res.videoCodec}${res.audioCodec ? ' / ' + res.audioCodec : '，无音轨'}，${res.width}×${res.height}）`, 'ok');
    showNotice('info', '录制已开始', '现在切回那个页面并刷新，让视频从头播一遍。播完后回来点「停止并保存」。');
    await refreshState();
  } catch (err) {
    showNotice('err', '启动录制失败', String(err?.message || err));
    $('start').disabled = false;
  }
}

/**
 * 「放弃这一份」：收尾写盘失败、数据还在内存里，用户不想腾空间了。
 *
 * 这个出口是必须的：不放掉那份缓冲，后面每一次点「抓流」都会被告知
 * "已经在抓流中"，等于一次失败把整个功能锁死。
 */
async function discardCapture() {
  if (!window.confirm('放弃这一份抓流？\n它还没有保存成文件，放弃之后就找不回来了。')) return;
  $('discard').disabled = true;
  try {
    const res = await send(MSG.MSE_DISCARD);
    if (!res?.ok) {
      showNotice('err', '放弃失败', res?.error || '未知原因');
      return;
    }
    log(`已放弃这一份（${formatBytes(res.discardedBytes || 0)} 没有保存）`, 'warn');
    showNotice('info', '已经放弃', '那一份数据丢掉了。要重新抓就去页面上再点一次「抓流」。');
    await refreshState();
    await refreshMedia();
  } finally {
    $('discard').disabled = false;
  }
}

async function stopRecording() {
  $('stop').disabled = true;
  try {
    const res = await send(MSG.RECORD_STOP);
    if (!res?.ok) {
      // 写盘失败但数据还在内存里：这不是"停止失败"，是"没能保存，可以重试"。
      // 说清三件事：数据没丢、为什么没写进去、下一步点哪儿。
      if (res?.retryable) {
        log(`收尾没能写出文件：${res.error}`, 'warn');
        showNotice('warn', '没能写进文件（数据还留着）', `${res.error}\n`
          + `本次要写 ${formatBytes(res.bytes || 0)}。清出空间后点上面的「重试保存」；`
          + '不想要了就点「放弃这一份」。');
        await refreshState();
        return;
      }
      showNotice('err', '停止失败', res?.error || '未知原因');
      return;
    }
    const isMse = res.state?.mode === 'mse';
    const real = formatDuration(res.mediaSeconds);
    const wall = formatClock(res.durationMs || 0);
    // 日志和提示里一律用**文件自己的时长**。挂钟时间放后面，
    // 而且只在两者差得多的时候才提 —— 否则用户会以为时长算错了。
    log(`${isMse ? '抓流' : '录制'}已结束：${res.fileName}`
      + `（${real ? `时长 ${real}` : '时长待读'}，${formatBytes(res.size || 0)}`
      + `，过程用时 ${wall}，丢帧 ${res.dropped || 0}）`, 'ok');
    if (res.stalledMs > 1200) {
      log(`采集源停了 ${(res.stalledMs / 1000).toFixed(1)} 秒（${res.stallCount} 次），已从时间轴里去掉，否则拖进度条会跳回去`, 'warn');
      showNotice(
        'warn',
        `${isMse ? '抓流' : '录制'}完成（压缩了空白）`,
        `过程里有 ${(res.stalledMs / 1000).toFixed(0)} 秒采集源没有出帧 —— 通常是标签页被切到后台、`
        + '被别的窗口盖住，或者屏幕锁定了。那几段没有画面，硬留在文件里会让进度条拖不动，'
        + '所以已经去掉。文件时长和过程用时对不上就是这个原因。',
      );
    } else {
      showNotice(
        'ok',
        isMse ? '抓流完成' : '录制完成',
        `${real ? `视频时长 ${real}。` : ''}在下面点「保存到磁盘」把文件导出到你的下载目录。`,
      );
    }
    await refreshState();
    await refreshMedia();
  } catch (err) {
    showNotice('err', '停止失败', String(err?.message || err));
  }
}

/**
 * 抓流刚结束时给一个明确的交代。
 *
 * 抓流是从页面面板发起的，面板点完就关了、页面还会被刷新 —— 用户回来时
 * 只有一个他没见过的管理页。所以这里把"刚做完的那件事"说清楚：
 * 文件叫什么、**视频真实时长**是多少、下一步点哪儿。
 */
function announceRecentCapture() {
  const r = state.record;
  if (r?.stage !== RECORD_STAGE.READY) return;
  // 只对"刚刚结束"的说，翻旧账会让人以为又抓了一次
  if (!r.finishedAt || Date.now() - r.finishedAt > 10 * 60 * 1000) return;
  const key = r.fileName || `cut:${r.finishedAt}`;
  if (state.announced === key) return;
  state.announced = key;

  const isMse = r.mode === 'mse';
  // 换集自动收尾之后缓冲是空的，最后这一段没有产物 —— 这时 r.fileName 是空的。
  // 但**前面几段好好地躺在列表里**，必须照样交代清楚，否则用户会以为抓流失败了。
  if (!r.fileName) {
    if (!(r.parts > 0)) return;
    showNotice('ok', '抓流结束', [
      r.title ? `来源：${r.title}` : '',
      `这次一共自动存了 ${r.parts} 个文件（每换一个视频就另存一个，不会连成一整段）`,
      r.note || '',
      '它们都在下面的「抓流文件」里，点「保存到磁盘」导出。',
    ].filter(Boolean).join('\n'));
    return;
  }

  const real = formatDuration(r.mediaSeconds);
  const lines = [
    r.title ? `来源：${r.title}` : '',
    `${isMse ? '抓流' : '录制'}产物：${r.fileName}`,
    real ? `视频时长：${real}` : '',
    r.mediaSeconds && r.durationMs && Math.abs(r.durationMs / 1000 - r.mediaSeconds) > 2
      ? `（抓取过程用了 ${formatClock(r.durationMs)}，中间的暂停和拖动不算在文件时长里）`
      : '',
    r.parts > 1
      // 「为什么会有好几个文件」必须说对：换集切的和"攒太大自动切"是两件事，
      // 混成一句"每换一个视频就另存一个"会让用户以为抓到了好几个视频。
      ? (r.sizeCuts > 0
        ? `这次一共存了 ${r.parts} 个文件：其中 ${r.sizeCuts} 次是因为攒得太大自动切开的`
          + '（一次合并吃不下更大的），按文件名顺序就是完整内容'
        : `这次一共存了 ${r.parts} 个文件（每换一个视频就自动另存一个）`)
        + '，都在下面的「抓流文件」里'
      : '',
    r.note || '',
    ...(r.warnings || []).slice(0, 3),
    '下面点「保存到磁盘」就能导出到你的下载目录。',
  ].filter(Boolean);
  showNotice('ok', `${isMse ? '抓流' : '录制'}完成`, lines.join('\n'));
}

/**
 * 「先保存已录到的部分」：把此刻的缓冲写出去，抓流继续。
 * 每点一次生成一个 `-部分.mp4`，所以可以边抓边留好几个节点。
 */
async function snapshotCapture() {
  $('snapshot').disabled = true;
  try {
    const res = await send(MSG.MSE_SNAPSHOT);
    if (!res?.ok) {
      // 「和上一份内容一样」不是错误，是**省钱**：连点两次、中间又没进来新数据时
      // 不再重复写一份一样的文件（用户实测这么白占了三份 56 MB）。
      if (res?.identical) {
        log(res.error, 'warn');
        showNotice('info', '内容没有变化，没有重复写', res.error);
        return;
      }
      if (res?.retryable) {
        showNotice('warn', '这次没能写出来（数据还在）', `${res.error}\n抓流没有中断，` + '也可以先导出/删掉一些旧产物再点一次。');
        return;
      }
      showNotice('warn', '这次没能保存', res?.error || '未知原因');
      return;
    }
    const real = formatDuration(res.mediaSeconds);
    log(`已保存一份部分产物：${res.fileName}（${real ? `时长 ${real}，` : ''}${formatBytes(res.size || 0)}）`
      + ` —— 抓流没有中断`, 'ok');
    await refreshMedia();
    $('capture-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showNotice('err', '保存部分产物失败', String(err?.message || err));
  } finally {
    // render() 会根据当前状态重新决定这个按钮可不可用
    render();
  }
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

async function init() {
  if (params.get('title')) $('subtitle').textContent = params.get('title');
  // 抓流结束会自动跳到这个页面，并带上 focus=capture
  const focus = params.get('focus');
  if (focus === 'capture') $('capture-card').classList.add('is-focus');

  $('refresh').addEventListener('click', async () => {
    await refreshState();
    await refreshMedia();
  });
  $('start').addEventListener('click', startRecording);
  $('stop').addEventListener('click', stopRecording);
  $('snapshot').addEventListener('click', snapshotCapture);
  // 「重试保存」= 再走一次停止流程：离屏文档那边会拿留着的那份字节重写一遍
  $('retry').addEventListener('click', stopRecording);
  $('discard').addEventListener('click', discardCapture);

  // 自动保存开关：和面板里的设置是**同一个值**，在哪边改都算数
  const settings = await getSettings();
  $('autosave').checked = settings.autoSaveCapture !== false;
  $('autosave').addEventListener('change', async (e) => {
    await setSettings({ autoSaveCapture: e.target.checked });
    $('autosave-hint').hidden = e.target.checked;
    log(e.target.checked
      ? '已开启自动保存：一个视频播完就自动存一段'
      : '已关闭自动保存：换视频不会自动存，记得在换之前点「先保存已录到的部分」', e.target.checked ? 'ok' : 'warn');
  });

  // 「自动保存已录到的部分」：滚动覆盖、只留最新一份。
  // 间隔和**口径**（录制时间 / 视频内容时长）改动都立刻生效，不用重开抓流。
  $('autosnap').checked = settings.autoSnapshotCapture !== false;
  $('autosnap-minutes').value = String([5, 10, 30].includes(Number(settings.autoSnapshotMinutes))
    ? Number(settings.autoSnapshotMinutes) : 10);
  $('autosnap-basis').value = settings.autoSnapshotBasis === 'media' ? 'media' : 'wall';
  $('autosnap').addEventListener('change', async (e) => {
    await setSettings({ autoSnapshotCapture: e.target.checked });
    $('autosnap-hint').hidden = !e.target.checked;
    $('autosnap-minutes').disabled = !e.target.checked;
    render();
    log(e.target.checked
      ? `已开启：抓流期间每 ${$('autosnap-minutes').value} 分钟自动存一份已录到的部分（只留最新一份，`
        + `按${$('autosnap-basis').value === 'media' ? '视频内容时长' : '录制时间'}算）`
      : '已关闭自动保存已录到的部分：中途出意外就只能靠手动点「先保存已录到的部分」',
    e.target.checked ? 'ok' : 'warn');
  });
  $('autosnap-minutes').addEventListener('change', async (e) => {
    await setSettings({ autoSnapshotMinutes: Number(e.target.value) });
    log(`自动保存间隔已改为每 ${e.target.value} 分钟（正在进行的抓流也会用新值）`, 'ok');
  });
  $('autosnap-basis').addEventListener('change', async (e) => {
    await setSettings({ autoSnapshotBasis: e.target.value });
    log(e.target.value === 'media'
      ? '自动保存改成按**视频内容时长**算：抓到的内容够 N 分钟就存一份（倍速播放时更合你的节奏）'
      : '自动保存改成按**录制时间**算：录够 N 分钟就存一份（防意外的口径）', 'ok');
  });

  // 「产物自动导出到下载目录」：完整产物落进「抓流文件」之后自动下载一份，
  // 私有存储那份和「保存到磁盘」按钮都保留。
  $('autoexport').checked = settings.autoExportCapture !== false;
  $('autoexport').addEventListener('change', async (e) => {
    await setSettings({ autoExportCapture: e.target.checked });
    $('autoexport-hint').hidden = !e.target.checked;
    render();
    log(e.target.checked
      ? `已开启：以后每存出一份完整产物就自动导出到下载目录（${settings.downloadSubdir || '浏览器默认目录'}），`
        + '私有存储里那份会保留'
      : '已关闭自动导出：产物只留在私有存储里，需要自己点「保存到磁盘」',
    e.target.checked ? 'ok' : 'warn');
  });

  // 「攒太大自动切一段」：抓流数据全在内存里，收尾合并还要一整块 —— 到阈值就
  // 先写出一段完整文件、清空缓冲接着抓（代价是"一个视频分成几个文件"，
  // 所以文案里必须说清，见 autocut-hint）。
  const CUT_CHOICES = [300, 600, 1200];
  $('autocut').checked = settings.autoCutCapture !== false;
  $('autocut-mb').value = String(CUT_CHOICES.includes(Number(settings.autoCutMb))
    ? Number(settings.autoCutMb) : 600);
  $('autocut').addEventListener('change', async (e) => {
    await setSettings({ autoCutCapture: e.target.checked });
    $('autocut-hint').hidden = !e.target.checked;
    $('autocut-mb').disabled = !e.target.checked;
    render();
    log(e.target.checked
      ? `已开启：抓流攒到 ${$('autocut-mb').value} MB 就自动切成一段完整文件，接着往下抓`
      : '已关闭自动切段：攒太多时收尾可能失败（合并要一整块内存），接近阈值会提前提醒你',
    e.target.checked ? 'ok' : 'warn');
  });
  $('autocut-mb').addEventListener('change', async (e) => {
    await setSettings({ autoCutMb: Number(e.target.value) });
    log(`自动切段的阈值已改为 ${e.target.value} MB（正在进行的抓流也会用新值）`, 'ok');
  });
  $('diag-pick').addEventListener('click', () => $('diag-file').click());
  $('diag-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) runDiag(file);
    e.target.value = '';
  });
  $('diag-fix').addEventListener('click', fixDiag);
  $('clean-exported').addEventListener('click', cleanExported);

  // 录制中每秒重画一次计时：本地跑，不等 service worker 推送
  state.timer = setInterval(() => {
    if (state.record?.stage === RECORD_STAGE.RECORDING) render();
  }, 1000);

  chrome.runtime.onMessage.addListener((msg) => {
    // 只认推送类型：RECORD_STATE 是「查询」，别人查询时消息里没有 state，
    // 当成推送会把界面刷成「空闲」。
    if (msg?.type === MSG.RECORD_STATE_PUSH) {
      state.record = msg.state;
      render();
      // 播完一集自动切出来的那段：当场说出来 + 刷新列表，
      // 这样它立刻出现在「抓流文件」里，用户能马上保存
      const cut = msg.state?.lastCut;
      if (cut && cut.at !== state.lastCutSeen) {
        state.lastCutSeen = cut.at;
        const real = formatDuration(cut.mediaSeconds);
        log(`第 ${cut.part} 个视频已自动保存：${cut.fileName}（${real ? `时长 ${real}，` : ''}`
          + '下一个视频会存成另一个文件）', 'ok');
        showNotice(
          'ok',
          '这一集已经自动存好了',
          `抓流检测到视频切换，把刚播完的那段收尾成了一个完整文件：\n`
          + `${cut.fileName}${real ? `（时长 ${real}）` : ''}\n`
          + '它已经出现在下面的「抓流文件」里，可以点「保存到磁盘」。\n'
          + '抓流没有停 —— 下一个视频会另存一个文件，不会和这一集连在一起。',
        );
        refreshMedia();
      }
      if (msg.state?.stage === RECORD_STAGE.READY) {
        refreshMedia();
        announceRecentCapture();
      }
      // 自动保存已经录到的部分：抓流期间每 N 分钟一次，滚动覆盖。
      // 这件事必须说出来 —— 用户看不到的话，就不知道"现在其实有救了"。
      const auto = msg.state?.autoSnapshot;
      if (auto?.at && auto.at !== state.autoSnapshotSeen) {
        state.autoSnapshotSeen = auto.at;
        const real = formatDuration(auto.mediaSeconds);
        log(`自动保存了一份已录到的部分：${auto.fileName}${real ? `（时长 ${real}）` : ''}`
          + `${auto.replaced ? `，已覆盖上一份 ${auto.replaced}` : ''}`, 'ok');
        refreshMedia();
      }
      // 抓流进行中的一句话（快到切段阈值、或者刚切了一段）——必须让用户看到：
      // "一个视频变成两个文件"这种事不能等他事后在列表里发现。
      if (msg.state?.captureNotice && msg.state.captureNotice !== state.captureNoticeSeen) {
        state.captureNoticeSeen = msg.state.captureNotice;
        log(msg.state.captureNotice, 'ok');
        showNotice('ok', '抓流进行中', msg.state.captureNotice);
        refreshMedia();
      }
      // 自动保存失败（多半是空间不够）—— 这是"配额要满了"的早期信号，
      // 现在知道总比收尾时才知道好。
      if (msg.state?.warning && msg.state.warning !== state.warningSeen) {
        state.warningSeen = msg.state.warning;
        log(msg.state.warning, 'warn');
        showNotice('warn', '自动保存没能写出来', `${msg.state.warning}\n`
          + '抓流没有中断。建议先去管理页导出/删掉一些旧产物腾空间 —— '
          + '否则收尾时也会写不进去。');
      }
    }
    return false;
  });

  await refreshState();
  await refreshMedia();
  announceRecentCapture();

  if (!navigator.storage?.getDirectory) {
    showNotice('warn', '这个浏览器不支持源私有文件系统（OPFS）', '录制会退化成内存缓冲，长录制可能吃光内存。');
  }
}

init().catch((err) => {
  console.error('[vh/recorder] 初始化失败：', err);
  showNotice('err', '初始化失败', String(err?.message || err));
});
