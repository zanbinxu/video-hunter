#!/usr/bin/env node
/**
 * 用 Chrome DevTools Protocol 真加载一次扩展，并检查页面有没有报错。
 *
 * 为什么要绕这么一圈：
 *   Chrome 137 之后，命令行 `--load-extension` 被禁掉了
 *   （防止恶意软件静默侧载扩展），日志里只留下一句
 *   "load-extension is not allowed in Google Chrome, ignoring"。
 *   于是只能走 CDP 的 Extensions.loadUnpacked —— 它要求浏览器带
 *   `--enable-unsafe-extension-debugging` 启动。
 *
 * 这个脚本做三件事：
 *   1. 通过 CDP 加载未打包扩展，拿到真实的扩展 ID
 *   2. 逐个打开扩展页面（popup / 解析器 / 录制台 / 离屏文档），
 *      收集控制台报错和页面异常
 *   3. 顺手确认 service worker 能起来
 *
 * 用法：
 *   node tools/browser-check.mjs               # 默认连 127.0.0.1:9222
 *   node tools/browser-check.mjs --port 9333
 */
import {
  readFileSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync, existsSync, readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe, countDecodedVideoFrames, audioStats } from '../test/helpers.mjs';
import { formatBytes } from '../src/core/classify.js';
import { inspect } from './mp4-inspect.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const portArg = process.argv.indexOf('--port');
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 9222;

// 要加载哪一份扩展：默认就是这个仓库（零构建，加载已解压的目录）。
// `--extension <目录>` 用来验**打包出来的那份** —— 打成 zip 之后漏一个文件，
// 只有拿解压出来的目录真加载一次才发现得了（见 tools/pack.mjs 的注释）。
const extArg = process.argv.indexOf('--extension');
const EXT_PATH = extArg >= 0 && process.argv[extArg + 1]
  ? resolve(process.cwd(), process.argv[extArg + 1])
  : ROOT;

/* ------------------------------------------------------------------ *
 * 极简 CDP 客户端
 * ------------------------------------------------------------------ */

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
  const events = [];
  const listeners = [];

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
      return;
    }
    if (msg.method) {
      events.push(msg);
      for (const fn of listeners) fn(msg);
    }
  });

  const send = (method, params = {}, sessionId) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, { resolve });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  return { send, events, onEvent: (fn) => listeners.push(fn), close: () => ws.close(), version };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cdp = await connect();
  console.log(`· 浏览器：${cdp.version.Browser}`);

  // ---- 1. 加载扩展 ----
  const loaded = await cdp.send('Extensions.loadUnpacked', { path: EXT_PATH });
  if (loaded.error) {
    console.error('✗ 加载扩展失败：', loaded.error.message);
    console.error('  （浏览器需要用 --enable-unsafe-extension-debugging 启动）');
    cdp.close();
    process.exit(1);
  }
  const extId = loaded.result?.id;
  console.log(`✓ 扩展已加载，ID = ${extId}`);

  // ---- 2. 打开各个扩展页面，收集报错 ----
  // 每个页面除了「不报错」，还要检查「确实渲染出了预期内容」。
  // 这两件事不是一回事：一个 import 失败的模块会安静地什么都不做。
  const pages = [
    {
      name: 'popup',
      path: 'src/popup/popup.html',
      expect: `(() => {
        const host = document.getElementById('page-host');
        const list = document.getElementById('list');
        return {
          ok: !!host && host.textContent.trim().length > 0 && !host.textContent.includes('正在读取') && !!list && list.children.length > 0,
          detail: '页面=' + JSON.stringify(host && host.textContent.trim()) + ' 列表项=' + (list ? list.children.length : 0),
        };
      })()`,
    },
    {
      name: '解析器',
      path: 'src/parser/parser.html',
      // 不带参数打开时，应当显示「缺少播放列表地址」而不是白屏或一直转圈
      expect: `(() => {
        const notice = document.getElementById('notice');
        const body = document.getElementById('state-body');
        return {
          ok: !!notice && !notice.hidden && notice.textContent.includes('缺少播放列表地址'),
          detail: '状态=' + JSON.stringify(body && body.textContent) + ' 提示=' + (notice && !notice.hidden),
        };
      })()`,
    },
    {
      name: '抓流 / 录制管理',
      path: 'src/recorder/recorder.html',
      expect: `(async () => {
        const captures = document.getElementById('captures');
        const records = document.getElementById('recordings');
        const title = document.querySelector('.top-title');
        const timer = document.getElementById('timer');
        // 单独探一次「页面 → service worker」的消息往返：
        // 如果它挂住，管理页的 init() 就会永远停在第一个 await 上，
        // 表现为「不报错、也不渲染」——正是最难查的那种形态。
        const msgTest = await Promise.race([
          chrome.runtime.sendMessage({ type: 'vh:record-state' })
            .then((r) => 'resolved:' + JSON.stringify(r))
            .catch((e) => 'rejected:' + (e && e.message)),
          new Promise((r) => setTimeout(() => r('TIMEOUT(3s)'), 3000)),
        ]);
        let opfs = 'n/a';
        try { await navigator.storage.getDirectory(); opfs = 'ok'; }
        catch (e) { opfs = 'err:' + (e && e.message); }
        return {
          // 空列表也会渲染一行「还没有…」的占位，所以不能靠子节点数判断，
          // 要看两个分组和页面定位是不是都在（抓流 + 录制是两条独立的路）
          ok: !!captures && !!records && /抓流/.test(title ? title.textContent : ''),
          detail: '标题=' + JSON.stringify(title && title.textContent)
            + ' 分组=抓流' + (!!captures) + '/录制' + (!!records)
            + ' 计时=' + (timer && timer.textContent)
            + ' OPFS=' + opfs
            + ' 消息=' + msgTest,
        };
      })()`,
    },
    {
      name: '离屏文档',
      path: 'src/offscreen/offscreen.html',
      // 这个页面本来就不该有内容，只能看脚本有没有真的执行到底
      expect: `({ ok: window.__vhOffscreenReady === true, detail: '消息监听已注册=' + (window.__vhOffscreenReady === true) })`,
    },
  ];

  let problems = 0;

  for (const page of pages) {
    const url = `chrome-extension://${extId}/${page.path}`;

    // 关键顺序：先开一个空白页 → 挂上调试 → 再导航到目标页。
    // 如果反过来（先导航再 Runtime.enable），页面初始化阶段抛的异常和打的日志
    // 全都发生在监听器就位之前，会被**静默漏掉** —— 表现就是「页面没报错但也没干活」。
    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    if (created.error) {
      console.error(`✗ ${page.name}：无法创建页面 —— ${created.error.message}`);
      problems += 1;
      continue;
    }
    const targetId = created.result.targetId;

    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached.result?.sessionId;
    if (!sessionId) {
      console.error(`✗ ${page.name}：无法附加调试会话`);
      problems += 1;
      continue;
    }

    const logs = [];
    const off = (msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
        logs.push(`[console.${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        logs.push(`[exception] ${d.exception?.description || d.text}`);
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        logs.push(`[log.${msg.params.entry.source}] ${msg.params.entry.text}`);
      }
    };
    cdp.onEvent(off);

    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Log.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);

    const nav = await cdp.send('Page.navigate', { url }, sessionId);
    if (nav.error) {
      console.error(`✗ ${page.name}：导航失败 —— ${nav.error.message}`);
      problems += 1;
      await cdp.send('Target.closeTarget', { targetId });
      continue;
    }
    await sleep(1600);

    // 确认页面不只是「没报错」，而是真的渲染出了预期内容
    const evalRes = await cdp.send('Runtime.evaluate', {
      expression: page.expect,
      returnByValue: true,
      awaitPromise: true,
      timeout: 15000,
    }, sessionId);
    const check = evalRes.result?.result?.value;

    if (logs.length) {
      problems += logs.length;
      console.error(`✗ ${page.name}（${page.path}）有 ${logs.length} 条报错：`);
      for (const line of logs.slice(0, 8)) console.error(`    ${line}`);
    } else if (!check?.ok) {
      problems += 1;
      console.error(`✗ ${page.name}（${page.path}）渲染不符合预期：${check?.detail ?? '检查脚本没有返回值'}`);
    } else {
      console.log(`✓ ${page.name} 渲染正常 · ${check.detail}`);
    }

    await cdp.send('Target.closeTarget', { targetId });
  }

  // ---- 3. service worker ----
  //
  // 这里必须**主动发一条消息并等回应**，不能只看 Target.getTargets 里有没有
  // service_worker 这个 target。
  //
  // 原因是踩过坑：service worker 曾经因为一个模块解析错误
  // （import 了一个不存在的导出）而启动失败。那时扩展照样加载成功、
  // 四个页面照样渲染正常、控制台一条错都没有 —— 但后台完全是死的。
  // 只有「发一条消息看有没有人回」能戳穿这种状态。
  problems += await checkServiceWorker(cdp, extId);

  // ---- 4. 浏览器侧端到端（可选） ----
  const e2eArg = process.argv.indexOf('--e2e');
  if (e2eArg >= 0) {
    const origin = process.argv[e2eArg + 1];
    if (!origin) throw new Error('--e2e 后面要跟 fixture 服务地址，例如 http://127.0.0.1:8791');
    problems += await runE2E(cdp, extId, origin);
    problems += await runRealDownloadFlow(cdp, extId, origin);
  }

  // ---- 5. 扩展内部链路（嗅探 / 内容脚本 / Referer / 下载 / 录制） ----
  const extrasArg = process.argv.indexOf('--extras');
  if (extrasArg >= 0) {
    const origin = process.argv[extrasArg + 1];
    if (!origin) throw new Error('--extras 后面要跟 fixture 服务地址，例如 http://127.0.0.1:8791');
    problems += await runExtensionExtras(cdp, extId, origin);
  }

  // ---- 6. 真实 CDN 上的公开流（可选） ----
  //
  // 自己用 ffmpeg 造的样本永远只会出现「我预料到的情况」。
  // 真实站点的主列表里有音频组、IFrame 变体、以及各种我没想过的写法，
  // 所以拿一条公开的参考流再压一次，是性价比很高的一步。
  const realArg = process.argv.indexOf('--real');
  if (realArg >= 0) {
    const url = process.argv[realArg + 1];
    if (!url) throw new Error('--real 后面要跟一个真实 m3u8 地址');
    problems += await runReal(cdp, extId, url);
  }

  // ---- 7. 拿一个真实站点探一探（可选） ----
  //
  // 用户问「某个站支持吗」的时候，靠读代码回答是不负责任的：真实站点的播放方式
  // （MSE、Range 请求、自定义容器）决定了我这套嗅探 + 抓流到底能不能用。
  // 这个模式把答案跑出来：打开页面、等它播、然后报告扩展**实际**看到了什么。
  const siteArg = process.argv.indexOf('--site');
  if (siteArg >= 0) {
    const url = process.argv[siteArg + 1];
    if (!url) throw new Error('--site 后面要跟一个真实页面地址');
    problems += await runSiteProbe(cdp, extId, url);
  }

  cdp.close();

  console.log('');
  if (problems) {
    console.error(`✗ 浏览器验证未通过：${problems} 个问题`);
    process.exit(1);
  }
  console.log('✓ 浏览器验证通过：扩展能加载，所有页面无控制台报错');
}

/* ------------------------------------------------------------------ *
 * 拿一个真实站点探一探
 * ------------------------------------------------------------------ */

/**
 * 打开一个真实页面，等它播起来，然后如实报告扩展看到了什么。
 *
 * 报告四件事，缺一不可：
 *   1. 页面上的 `<video>` 到底在不在播（没播就什么都说明不了）
 *   2. 嗅探层看到了什么（哪些类型、有没有视频轨）
 *   3. 页面用不用 MSE —— **用 MSE 就说明「抓流」这条路走得通**
 *   4. 真的武装一次抓流，看钩子有没有收到数据
 *
 * 这个工具不判"通过/不通过"：真实站点的行为千变万化，它只给事实。
 * 但"页面在播、却什么都没嗅到"是个明确的信号，会标出来。
 */
async function runSiteProbe(cdp, extId, url) {
  let problems = 0;
  console.log('\n· 真实站点探测');
  console.log(`  ${url}`);

  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const targetId = created.result?.targetId;
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.result?.sessionId;
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);

  // 同时用 CDP 自己记一份「这个页面到底发了哪些媒体请求」。
  //
  // 这一步是必需的：只看扩展嗅到了什么，分不清两种完全不同的情况 ——
  //   · 站点压根没用普通请求取媒体（那扩展没戏，只能抓流）
  //   · 站点发了请求、但扩展没记下来（那是我的嗅探层的 bug）
  // 两个数字摆在一起，结论就没法含糊。
  const netSeen = [];
  const onNet = (msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method !== 'Network.responseReceived') return;
    const r = msg.params.response || {};
    const mime = String(r.mimeType || '').toLowerCase();
    const u = String(r.url || '');
    if (/^(video|audio)\//.test(mime)
      || /googlevideo|videoplayback|\.m4s(\?|$)|\.mpd(\?|$)|\.m3u8(\?|$)/.test(u)) {
      netSeen.push({ type: msg.params.type, status: r.status, mime: r.mimeType, url: u });
    }
  };
  cdp.onEvent(onNet);

  await cdp.send('Page.navigate', { url }, sessionId);

  // 真实站点首屏 + 广告 + 起播，给它足够时间
  await sleep(12000);

  let control;
  try {
    control = await openControlPage(cdp, extId);
    const tabId = await evalIn(cdp, control.sessionId, `(async () => {
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(url.split('?')[0] + '*')} });
      return tabs.length ? tabs[0].id : null;
    })()`);

    const playing = await evalIn(cdp, sessionId, `(() => {
      const v = document.querySelector('video');
      return JSON.stringify({
        hasVideo: !!v,
        src: v ? (v.currentSrc || v.src || '').slice(0, 60) : '',
        currentTime: v ? Number(v.currentTime.toFixed(2)) : -1,
        duration: v && Number.isFinite(v.duration) ? Math.round(v.duration) : null,
        hasMSE: typeof window.MediaSource !== 'undefined',
        videoCount: document.querySelectorAll('video').length,
      });
    })()`);
    const page = JSON.parse(playing);
    console.log(`  · 页面：<video> ${page.videoCount} 个｜currentTime ${page.currentTime} 秒`
      + `｜时长 ${page.duration ?? '未知'} 秒｜src=${page.src || '（无）'}`);

    if (tabId == null) {
      console.error('  ✗ 找不到这个页面的标签页 ID，后面查不了');
      await cdp.send('Target.closeTarget', { targetId });
      return 1;
    }

    const media = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
      const r = await chrome.runtime.sendMessage({ type: 'vh:get-tab-media', tabId: ${tabId} });
      return JSON.stringify(r || {});
    })()`, { timeout: 30000 }));

    const entries = media.entries || [];
    const byKind = {};
    for (const e of entries) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    console.log(`  · 嗅探到 ${entries.length} 条：`
      + (Object.entries(byKind).map(([k, n]) => `${k}×${n}`).join('、') || '（什么都没有）'));
    for (const e of entries.slice(0, 8)) {
      const size = e.size ? `${(e.size / 1048576).toFixed(1)} MB` : '体积未知';
      console.log(`    - [${e.kind}] ${size} ${e.mime || '无 MIME'} ${String(e.url).slice(0, 80)}`);
    }
    if (media.pageVideos?.length) {
      console.log(`    · 页面 <video> 条目 ${media.pageVideos.length} 条`);
      for (const v of media.pageVideos.slice(0, 4)) {
        console.log(`      hasBlob=${v.video?.hasBlob} isMse=${v.video?.isMse}`
          + ` kind=${v.kind} src=${String(v.video?.sources?.[0] || '').slice(0, 40)}`);
      }
    }

    // 对照：Chrome 实际发了哪些媒体请求。两个数字的落差就是结论本身。
    const mediaLike = netSeen.filter((r) => /^(video|audio)\//.test(String(r.mime).toLowerCase()));
    // 站点把媒体包进自己的容器时（YouTube 的 `application/vnd.yt-ump`），
    // 嗅探层拿不到可下载的东西 —— 这正是"该提示用户去抓流"的判据
    const mseLike = page.src.startsWith('blob:') && mediaLike.length <= 4;
    const types = {};
    for (const r of mediaLike) types[r.type] = (types[r.type] || 0) + 1;
    console.log(`  · Chrome 实际发出的媒体请求：${netSeen.length} 个`
      + `（其中 MIME 是 video/audio 的 ${mediaLike.length} 个`
      + `${Object.keys(types).length ? `，类型 ${Object.entries(types).map(([t, n]) => `${t}×${n}`).join('、')}` : ''}）`);
    for (const r of netSeen.slice(0, 6)) {
      console.log(`    - [${r.type}] ${r.status} ${r.mime} ${r.url.slice(0, 86)}`);
    }
    if (mediaLike.length && entries.length === 0) {
      console.error('  ✗ Chrome 明明发了媒体请求，扩展一条都没记下来 —— 这是嗅探层的问题');
      await cdp.send('Target.closeTarget', { targetId });
      return 1;
    }

    // 页面在播、却一条都没嗅到 —— 这是唯一值得报警的形态：
    // 说明媒体不是通过 webRequest 看得见的方式取回来的（或者用了 blob:）。
    if (page.currentTime > 0.5 && entries.length === 0) {
      console.error('  ✗ 页面明明在播，却一条媒体都没嗅到');
      await cdp.send('Target.closeTarget', { targetId });
      return 1;
    }

    // 抓流能不能收到数据 —— 这条路不依赖 URL，只依赖播放器走 MSE
    // 顺带验一下面板会不会把这件事说清楚：站点用 MSE 时，用户看到的列表里
    // 可能只有几条页面音效，不说清楚他就会以为"这个站不支持"。
    const popup = await openPopupFor(cdp, extId, tabId);
    if (popup) {
      console.log(`  · 面板提示条：「${popup.hint || '（没显示）'}」`);
      console.log(`  · 面板计数：全部 ${popup.counts.all}｜视频 ${popup.counts.video}`
        + `｜音频 ${popup.counts.audio}｜播放列表 ${popup.counts.playlist}`);
      console.log(`  · 底栏顺序：${(popup.footIds || []).join(' → ')}`);
      console.log(`  · 问号提示卡：显示=${popup.help?.cardDisplayWhenIdle}｜定位=${popup.help?.cardPosition}`
        + `｜是问号=${popup.help?.hasQuestionMark}`);
      if (mseLike && !popup.hint) {
        console.error('  ✗ 页面是 MSE 播放、又没有可直接下载的媒体，面板却什么都没提示');
        problems += 1;
      }
      // 「管理」要跟「抓流」挨着（用户要求：方便点）
      const order = popup.footIds || [];
      const ci = order.indexOf('capture');
      const mi = order.indexOf('manage');
      if (ci < 0 || mi < 0 || mi !== ci + 1) {
        console.error(`  ✗ 「管理」应该紧跟在「抓流」右边，实际顺序：${order.join(' → ')}`);
        problems += 1;
      } else {
        console.log('  ✓ 「管理」就在「抓流」右边');
      }
      // 说明卡默认不占位（display:none）且是浮层
      if (popup.help?.cardDisplayWhenIdle !== 'none' || !['absolute', 'fixed'].includes(popup.help?.cardPosition)) {
        console.error(`  ✗ 两种模式的说明应该是"浮层且默认不显示"，实际 display=${popup.help?.cardDisplayWhenIdle}`
          + ` position=${popup.help?.cardPosition}（平铺在界面上会挡住列表）`);
        problems += 1;
      } else {
        console.log('  ✓ 说明卡默认不显示、是浮层（不再把列表往下挤）');
      }
      if (!popup.help?.hasQuestionMark) {
        console.error('  ✗ 底栏应该是一个「?」按钮，而不是一整块说明');
        problems += 1;
      }
      if (!popup.settings?.fromcurrent) {
        console.error('  ✗ 设置里缺少「抓流：从当前播放位置开始」');
        problems += 1;
      }
    }

    const started = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
      const r = await chrome.runtime.sendMessage({ type: 'vh:mse-start', tabId: ${tabId} });
      return JSON.stringify(r || {});
    })()`, { timeout: 45000 }));

    if (!started.ok) {
      console.log(`  · 抓流没能启动：${String(started.error).split('\n')[0]}`);
    } else {
      // 抓流要刷新一次页面让钩子从头收数据
      await evalIn(cdp, control.sessionId, `chrome.tabs.reload(${tabId}).then(() => 'ok')`);
      await sleep(14000);
      const stats = JSON.parse(await evalIn(cdp, control.sessionId,
        `chrome.runtime.sendMessage({ type: 'vh:offscreen-status' }).then((r) => JSON.stringify(r || {}))`,
        { timeout: 20000 }));
      const chunks = stats.stats?.chunks ?? 0;
      const bytes = stats.stats?.bytes ?? 0;
      console.log(`  · 抓流：收到 ${chunks} 段｜${(bytes / 1048576).toFixed(2)} MB`
        + `｜${chunks > 0 ? '钩子抓到了数据 ✓' : '一段都没抓到 ✗'}`);
      // 按 mime 分开报 —— 「有画面没声音」这种问题，只看总数是发现不了的：
      // 得知道音频那条轨到底是**没收到**，还是收到了但没合进产物。
      for (const t of stats.stats?.tracks || []) {
        console.log(`    - ${t.mime}｜${t.chunks} 段｜${(t.bytes / 1048576).toFixed(2)} MB`);
      }

      // ---- 真正收尾一次，把产物拿到手看一眼 ----
      //
      // 这一步是这个工具存在的意义：用户问"这个站抓流有声音吗"，
      // 光看"收到 12 段数据"是答不了的 —— 必须看**产物里有没有音频轨**。
      const stopped = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
        const r = await chrome.runtime.sendMessage({ type: 'vh:mse-stop' });
        return JSON.stringify(r || {});
      })()`, { timeout: 180000 }));

      if (!stopped.ok) {
        console.log(`  · 收尾没能产出文件：${String(stopped.error).split('\n')[0]}`);
      } else {
        console.log(`  · 收尾产物：${stopped.fileName}｜${(stopped.size / 1048576).toFixed(2)} MB`
          + `｜时长 ${Number(stopped.mediaSeconds).toFixed(2)} 秒`);
        for (const t of stopped.detail?.tracks || []) {
          console.log(`    · ${t.container} 轨 [${t.handlers.join('+')}]｜初始化段 ${t.init} B｜媒体分片 ${t.fragments} B`);
        }
        // 每一组都打出来（包括没被采纳的）—— 音频轨"消失"的答案就在这里
        for (const g of stopped.detail?.groups || []) {
          console.log(`    · 抓到的一组：mime=${g.mime || `（无，${g.sbId || '未知编号'}）`}｜容器=${g.container}`
            + `｜类型=${g.contentType || '?'}${g.codecType ? '/' + g.codecType : ''}`
            + `${g.trackSummary ? '｜' + g.trackSummary : ''}`
            + `｜${(g.bytes / 1048576).toFixed(2)} MB`
            + `${g.error ? '｜没收进产物：' + g.error : ''}`);
        }
        for (const w of stopped.warnings || []) console.log(`    ! ${String(w).split('\n')[0]}`);
        const dump = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
          const root = await navigator.storage.getDirectory();
          const fh = await root.getFileHandle(${JSON.stringify(stopped.fileName)});
          const file = await fh.getFile();
          const buf = new Uint8Array(await file.arrayBuffer());
          let bin = '';
          const CH = 0x8000;
          for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
          return JSON.stringify({ bytes: buf.length, base64: btoa(bin) });
        })()`, { timeout: 180000 }));
        mkdirSync(join(ROOT, '.tmp'), { recursive: true });
        const out = join(ROOT, '.tmp', 'site-capture.mp4');
        writeFileSync(out, Buffer.from(dump.base64, 'base64'));
        const info = probe(out);
        const v = (info.streams || []).find((s) => s.codec_type === 'video');
        const a = (info.streams || []).find((s) => s.codec_type === 'audio');
        console.log(`  · 产物 ffprobe：${v ? `${v.codec_name} ${v.width}x${v.height}` : '无视频轨'}`
          + `｜${a ? a.codec_name : '无音频轨 ✗'}｜${Number(info.format.duration).toFixed(2)} 秒`);
        // 起点也要看：音频是转码出来的，"两条轨对齐"这件事必须在真实产物上确认
        if (v && a) {
          console.log(`    · 两条轨的起点：视频 ${v.start_time}｜音频 ${a.start_time}`
            + `（差 ${(Number(a.start_time) - Number(v.start_time)).toFixed(3)} 秒）`);
        }
        if (v && !a) {
          console.error('  ✗ 产物有画面没声音 —— 抓流的音频轨没进产物（这正是要查的问题）');
        }
      }
    }

    await cdp.send('Target.closeTarget', { targetId });
    return 0;
  } catch (err) {
    console.error(`  ✗ 站点探测失败：${err.message}`);
    await cdp.send('Target.closeTarget', { targetId });
    return 1;
  } finally {
    if (control?.targetId) await cdp.send('Target.closeTarget', { targetId: control.targetId });
  }
}

/**
 * 打开某个标签页对应的扩展面板，读回它显示给用户的东西。
 *
 * 为什么要专门开一次面板：面板是"用户唯一看得见的地方"。嗅探对了、抓流能用了，
 * 但面板上如果只有一堆页面音效，用户还是会以为这个站不支持 —— 这一层得有断言。
 *
 * 面板用 `?tabId=` 指定要看哪个标签页。真实的面板是浏览器动作弹窗，
 * 自动化里开不出那种弹窗，只能以整页方式打开 —— 而整页打开时
 * `tabs.query({active:true,currentWindow:true})` 会返回**它自己**，
 * 所以必须显式指定。这个参数在手动排查时同样好用。
 */
async function openPopupFor(cdp, extId, tabId) {
  // 目标页先切到前台：面板的"对着哪个标签页"虽然由参数决定，
  // 但抓流/录制这类动作真的要求目标页处于活动状态
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const targetId = created.result?.targetId;
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.result?.sessionId;
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  await cdp.send('Page.navigate', {
    url: `chrome-extension://${extId}/src/popup/popup.html?tabId=${tabId ?? ''}`,
  }, sessionId);
  await sleep(2500);

  const view = JSON.parse(await evalIn(cdp, sessionId, `(() => {
    const hint = document.getElementById('mse-hint');
    // 底栏布局 + 那个问号提示卡：用户提的三件事里有两条是纯界面要求，
    // 所以这里真的去量 DOM，而不是"看着像对的"。
    const footIds = [...document.querySelectorAll('.foot-right > *')]
      .map((n) => n.id || (n.querySelector?.('button')?.id ?? ''));
    const card = document.getElementById('mode-panel');
    const cardStyle = card ? getComputedStyle(card) : null;
    const wrap = document.querySelector('.help-wrap');
    // 三条提示条量的是**计算后的 display**，不是 hidden 属性 ——
    // 用户报的 bug 正是"hidden 属性写了 true，样式却把它显示出来了"。
    const barOf = (id) => {
      const box = document.getElementById(id);
      if (!box) return { found: false };
      const isHiddenAttr = box.hasAttribute('hidden');
      const display = getComputedStyle(box).display;
      return { found: true, isHiddenAttr, display, visible: display !== 'none' };
    };
    const mergeText = document.getElementById('merge-text');
    const mergeGo = document.getElementById('merge-go');
    return JSON.stringify({
      hint: hint && !hint.hidden ? document.getElementById('mse-hint-text').textContent : '',
      counts: {
        all: document.getElementById('c-all')?.textContent,
        video: document.getElementById('c-video')?.textContent,
        audio: document.getElementById('c-audio')?.textContent,
        playlist: document.getElementById('c-playlist')?.textContent,
      },
      rows: document.querySelectorAll('#list .item').length,
      footIds,
      bars: {
        merge: barOf('mergebar'),
        mse: barOf('mse-hint'),
        rec: barOf('recbar'),
        mergeText: mergeText ? mergeText.textContent : null,
        mergeButton: mergeGo
          ? { isHiddenAttr: mergeGo.hasAttribute('hidden'), display: getComputedStyle(mergeGo).display }
          : null,
      },
      help: {
        hasQuestionMark: document.getElementById('mode-help-q')?.textContent?.trim() === '?',
        cardDisplayWhenIdle: cardStyle ? cardStyle.display : null,
        cardPosition: cardStyle ? cardStyle.position : null,
        wrapExists: !!wrap,
      },
      settings: {
        fromcurrent: !!document.getElementById('s-fromcurrent'),
        autosnap: !!document.getElementById('s-autosnap'),
      },
    });
  })()`));

  await cdp.send('Target.closeTarget', { targetId });
  return view;
}

/* ------------------------------------------------------------------ *
 * service worker 存活探测
 * ------------------------------------------------------------------ */

async function checkServiceWorker(cdp, extId) {
  console.log('\n· service worker');
  const pageUrl = `chrome-extension://${extId}/src/parser/parser.html`;
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const targetId = created.result?.targetId;
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.result?.sessionId;
  if (!sessionId) {
    console.error('✗ 无法建立探测会话');
    return 1;
  }

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url: pageUrl }, sessionId);
  await sleep(1200);

  // 随便挑一条一定会被 service worker 处理的消息，看有没有人回
  const res = await cdp.send('Runtime.evaluate', {
    expression: `Promise.race([
      chrome.runtime.sendMessage({ type: 'vh:get-settings' })
        .then((r) => 'ok:' + JSON.stringify(r).slice(0, 100))
        .catch((e) => 'err:' + (e && e.message)),
      new Promise((r) => setTimeout(() => r('TIMEOUT(5s) —— 有监听器接了消息却没回应'), 5000)),
    ])`,
    awaitPromise: true,
    returnByValue: true,
    timeout: 10000,
  }, sessionId);

  const answer = res.result?.result?.value || '(无返回)';
  await cdp.send('Target.closeTarget', { targetId });

  if (String(answer).startsWith('ok:')) {
    console.log(`✓ service worker 在线并正常响应：${answer}`);
    return 0;
  }
  console.error(`✗ service worker 没有正常响应：${answer}`);
  console.error('  → 大概率是后台脚本有模块解析错误。去 chrome://extensions 看该扩展的「错误」按钮。');
  return 1;
}

/* ------------------------------------------------------------------ *
 * 真实 CDN 上的公开流
 *
 * 只取前几片就停，目的是验证「解析真实播放列表 + 在真实网络上取分片
 * + 重封装」这条链路，而不是把整条流下完。
 * ------------------------------------------------------------------ */

/**
 * 音视频分离的 HLS：把视频流和独立音轨都下下来再合并。
 *
 * 这是 `--real` 模式存在的**主要理由**：自己用 ffmpeg 生成的 HLS 默认
 * 把音视频复用在一条 TS 里，测不出分离音轨这条路。
 */
function mergedExpression(m3u8Url, limit) {
  return `(async () => {
    const hls = await import('./hls.js');
    const rm  = await import('./remuxer.js');
    const dl  = await import('./downloader.js');
    const mg  = await import('./mp4-merge.js');

    const masterUrl = ${JSON.stringify(m3u8Url)};
    const masterText = await (await fetch(masterUrl)).text();
    const master = hls.parsePlaylist(masterText, masterUrl);
    if (!master.isMaster) throw new Error('需要一份主播放列表');

    const variants = master.variants.filter((v) => !v.iframe && v.uri)
      .sort((a, z) => (a.bandwidth || 0) - (z.bandwidth || 0));
    const picked = variants.find((v) => v.audioGroup) || variants[0];
    const rends = master.renditions.filter(
      (r) => r.type === 'AUDIO' && r.groupId === picked.audioGroup && r.uri,
    );
    const rend = rends.find((r) => r.isDefault) || rends[0];
    if (!rend) throw new Error('这个码率没有可用的独立音轨');

    const vText = await (await fetch(picked.uri)).text();
    const vPl = hls.parsePlaylist(vText, picked.uri);
    const aText = await (await fetch(rend.uri)).text();
    const aPl = hls.parsePlaylist(aText, rend.uri);

    async function collect(pl, fetchSegment) {
      const use = pl.segments.slice(0, ${limit});
      const frags = [];
      const remuxer = rm.createTsRemuxer(window.muxjs, { onFragment: (b) => frags.push(b) });
      for await (const { data } of dl.downloadSegmentsInOrder(use, {
        concurrency: 4, retries: 2, fetchSegment,
      })) {
        remuxer.append(data);
      }
      remuxer.end();
      if (!remuxer.initSegment) throw new Error('这一路没有初始化段');
      return { init: remuxer.initSegment, segments: frags };
    }

    const video = await collect(vPl, dl.createSegmentFetcher({ mediaSequence: vPl.mediaSequence }));
    const audio = await collect(aPl, dl.createSegmentFetcher({ mediaSequence: aPl.mediaSequence }));
    const merged = mg.mergeFmp4({ video, audio });

    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < merged.length; i += CH) {
      bin += String.fromCharCode.apply(null, merged.subarray(i, i + CH));
    }

    return JSON.stringify({
      audioGroup: picked.audioGroup,
      videoSegments: vPl.segments.length,
      audioSegments: aPl.segments.length,
      videoInit: video.init.byteLength,
      audioInit: audio.init.byteLength,
      videoFragments: video.segments.length,
      audioFragments: audio.segments.length,
      bytes: merged.length,
      magic: String.fromCharCode(merged[4], merged[5], merged[6], merged[7]),
      base64: btoa(bin),
    });
  })()`;
}

async function runReal(cdp, extId, url) {
  console.log('\n· 真实 CDN 上的公开流');
  const LIMIT = 4;

  const pageUrl = `chrome-extension://${extId}/src/parser/parser.html?url=${encodeURIComponent(url)}&title=real`;
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const targetId = created.result?.targetId;
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.result?.sessionId;
  if (!sessionId) {
    console.error('✗ 无法建立调试会话');
    return 1;
  }
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url: pageUrl }, sessionId);
  await sleep(2500);

  const uiRes = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      state: document.getElementById('state-body').textContent,
      variants: document.querySelectorAll('#variants .variant').length,
      firstVariant: (document.querySelector('#variants .variant .meta') || {}).textContent || '',
    })`,
    returnByValue: true,
  }, sessionId);
  const ui = JSON.parse(uiRes.result?.result?.value || '{}');
  console.log(`  · ${url.split('/').slice(-2).join('/')}`);
  console.log(`    主列表：${ui.state}`);
  console.log(`    码率档位 ${ui.variants} 个，最优档：${ui.firstVariant}`);

  let problems = 0;

  const res = await cdp.send('Runtime.evaluate', {
    expression: pipelineExpression(url, { limit: LIMIT, preferLowest: true }),
    awaitPromise: true,
    returnByValue: true,
    timeout: 180000,
  }, sessionId);

  if (res.result?.exceptionDetails) {
    console.error(`    ✗ 管线抛错：${res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text}`);
    await cdp.send('Target.closeTarget', { targetId });
    return 1;
  }

  const out = JSON.parse(res.result?.result?.value || '{}');
  console.log(`    · 选用档位：${out.picked?.resolution || '?'} @ ${out.picked?.bandwidth || '?'} bps`
    + `${out.picked?.audioGroup ? '（音频组 ' + out.picked.audioGroup + '）' : ''}`);
  console.log(`    · 主列表 ${out.variants} 档 / #EXT-X-MEDIA ${out.renditions} 条`
    + `｜媒体列表共 ${out.totalSegments} 片，取前 ${out.usedSegments} 片`);
  console.log(`    · 重封装 ${out.fragments} 段｜初始化段 ${out.initBytes} B｜产物 ${out.bytes} B｜容器 ${out.magic}`);

  if (out.magic !== 'ftyp') {
    console.error(`    ✗ 产物开头不是 ftyp（拿到 ${out.magic}）`);
    problems += 1;
  }
  if (!out.fragments) {
    console.error('    ✗ 没有产出任何媒体分片');
    problems += 1;
  }

  if (out.base64) {
    mkdirSync(join(ROOT, '.tmp'), { recursive: true });
    const file = join(ROOT, '.tmp', 'browser-real.mp4');
    writeFileSync(file, Buffer.from(out.base64, 'base64'));
    try {
      const info = probe(file);
      const v = (info.streams || []).find((s) => s.codec_type === 'video');
      const a = (info.streams || []).find((s) => s.codec_type === 'audio');
      const dur = Number(info.format.duration);
      console.log(`    · ffprobe：${v ? v.codec_name + ' ' + v.width + 'x' + v.height : '无视频轨'}`
        + `｜${a ? a.codec_name : '无音频轨'}｜${dur.toFixed(2)} 秒`);
      if (!v) { console.error('    ✗ ffprobe 读不到视频轨'); problems += 1; }
      // 这一条是**已知缺口**的如实反映，不是回归：
      // 上面这条路只取了视频轨，分离音轨要靠下面的合并路径。
      if (!a) {
        console.log('    · 单路下载没有音轨 —— 符合预期（这条流的音频是独立的一路），继续验合并路径');
      }
    } catch (err) {
      console.error(`    ✗ ffprobe 验证失败：${err.message}`);
      problems += 1;
    }
  }

  // ---- 音视频分离：两路都下 + 合并 ----
  if (out.picked?.audioGroup) {
    console.log(`\n  · 合并路径（音频组 ${out.picked.audioGroup}）`);
    const merged = await cdp.send('Runtime.evaluate', {
      expression: mergedExpression(url, LIMIT),
      awaitPromise: true,
      returnByValue: true,
      timeout: 180000,
    }, sessionId);

    if (merged.result?.exceptionDetails) {
      console.error(`    ✗ 合并路径抛错：${merged.result.exceptionDetails.exception?.description || merged.result.exceptionDetails.text}`);
      problems += 1;
    } else {
      const m = JSON.parse(merged.result?.result?.value || '{}');
      console.log(`    · 视频列表 ${m.videoSegments} 片（取 ${m.videoFragments}）`
        + `｜音轨列表 ${m.audioSegments} 片（取 ${m.audioFragments}）`);
      console.log(`    · 初始化段：视频 ${m.videoInit} B / 音频 ${m.audioInit} B`
        + `｜合并产物 ${m.bytes} B｜容器 ${m.magic}`);
      if (m.magic !== 'ftyp') {
        console.error(`    ✗ 合并产物开头不是 ftyp（拿到 ${m.magic}）`);
        problems += 1;
      }
      if (m.base64) {
        const file = join(ROOT, '.tmp', 'browser-real-merged.mp4');
        writeFileSync(file, Buffer.from(m.base64, 'base64'));
        try {
          const info = probe(file);
          const v = (info.streams || []).find((s) => s.codec_type === 'video');
          const a = (info.streams || []).find((s) => s.codec_type === 'audio');
          const dur = Number(info.format.duration);
          console.log(`    · ffprobe：${v ? v.codec_name + ' ' + v.width + 'x' + v.height : '无视频轨'}`
            + `｜${a ? a.codec_name : '无音频轨'}｜${dur.toFixed(2)} 秒`);
          if (!v) { console.error('    ✗ 合并产物没有视频轨'); problems += 1; }
          if (!a) { console.error('    ✗ 合并产物没有音频轨 —— 分离音轨合并失败'); problems += 1; }
        } catch (err) {
          console.error(`    ✗ ffprobe 验证失败：${err.message}`);
          problems += 1;
        }
      }
    }
  }

  await cdp.send('Target.closeTarget', { targetId });
  return problems;
}

/* ------------------------------------------------------------------ *
 * 真实路径：驱动解析器页真的点一次「开始下载」
 *
 * 上面那些用例是把模块拼起来跑，验的是模块本身。
 * 但"下载"这条路的编排在 parser.js 的 startDownload 里 —— 那正是出过
 * "产物拖不动进度条"的地方。所以这里必须真的点按钮走一遍，
 * 否则改坏了编排层也没人发现。
 * ------------------------------------------------------------------ */

async function runRealDownloadFlow(cdp, extId, origin) {
  console.log('\n· 真实下载流程（点按钮走一遍解析器页）');
  let problems = 0;

  const pageUrl = `chrome-extension://${extId}/src/parser/parser.html`
    + `?url=${encodeURIComponent(`${origin}/hls-ts/index.m3u8`)}&title=真实下载自测`;

  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const targetId = created.result?.targetId;
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.result?.sessionId;
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url: pageUrl }, sessionId);
  await sleep(3500);

  // 等主列表解析完、按钮就位
  const ready = await evalIn(cdp, sessionId,
    `document.getElementById('start').textContent`);
  if (ready !== '开始下载') {
    console.error(`  ✗ 页面没准备好，按钮文案是「${ready}」`);
    await cdp.send('Target.closeTarget', { targetId });
    return 1;
  }

  const before = await evalIn(cdp, sessionId,
    `chrome.downloads.search({ limit: 1, orderBy: ['-startTime'] }).then((r) => (r[0] ? r[0].startTime : ''))`);

  await evalIn(cdp, sessionId, `document.getElementById('start').click(), 'clicked'`);

  // 等收尾（产物要组装完才落盘，比流式写慢一点）
  let done = false;
  for (let i = 0; i < 60; i += 1) {
    await sleep(1000);
    const state = await evalIn(cdp, sessionId,
      `JSON.stringify({ pct: document.getElementById('stat-percent').textContent, notice: document.getElementById('notice').textContent.slice(0, 60) })`);
    const s = JSON.parse(state);
    if (s.notice.includes('下载完成') || s.notice.includes('失败')) { done = true; break; }
  }
  if (!done) {
    console.error('  ✗ 等了 60 秒还没结束');
    problems += 1;
  }

  const logText = await evalIn(cdp, sessionId, `document.getElementById('log').textContent`);
  const failed = /失败/.test(logText);
  if (failed) {
    const line = logText.split('\n').find((l) => l.includes('失败')) || '';
    console.error(`  ✗ 页面上报了失败：${line.slice(0, 160)}`);
    problems += 1;
  }

  // 从下载记录里找刚落的那个文件
  const found = JSON.parse(await evalIn(cdp, sessionId, `(async () => {
    const items = await chrome.downloads.search({ limit: 3, orderBy: ['-startTime'] });
    const item = items.find((x) => x.filename && x.filename.endsWith('.mp4'));
    if (!item) return JSON.stringify({ ok: false });
    return JSON.stringify({ ok: true, path: item.filename, bytes: item.fileSize || item.totalBytes, state: item.state });
  })()`, { timeout: 20000 }));

  if (!found.ok) {
    console.error('  ✗ 没找到下载产物');
    problems += 1;
  } else {
    console.log(`  · 产物：${found.path.split(/[\\/]/).pop()}（${(found.bytes / 1024).toFixed(0)} KB）`);
    // 关键检查：产物必须是**能拖进度条**的普通 MP4
    try {
      const info = inspect(found.path);
      const okDuration = info.mvhd && info.mvhd.duration !== 0xFFFFFFFF && info.mvhd.seconds > 1;
      const okTable = info.sampleTable.length > 0
        && info.sampleTable.every((t) => t.includes('stts') && t.includes('stsz') && t.includes('stco'));
      console.log(`    · mvhd 时长 ${info.mvhd ? info.mvhd.seconds.toFixed(2) + ' 秒' : '缺失'}`
        + `｜轨道 ${info.traks} 条｜mvex ${info.hasMvex}｜样本表 ${info.sampleTable.join(' / ') || '（空）'}`);
      if (!okDuration) {
        console.error('    ✗ 产物时长不对（0xFFFFFFFF 意味着"未知"，播放器会拖不动进度条）');
        problems += 1;
      }
      if (!okTable) {
        console.error('    ✗ 产物没有完整的样本表 —— 播放器没法定位样本，也就拖不动进度条');
        problems += 1;
      }
      if (info.hasMvex) {
        console.error('    ✗ 产物是分片式 MP4（带 mvex），不应该是');
        problems += 1;
      }
    } catch (err) {
      console.error(`    ✗ 结构检查失败：${err.message}`);
      problems += 1;
    }
  }

  await cdp.send('Target.closeTarget', { targetId });
  return problems;
}

/* ------------------------------------------------------------------ *
 * 扩展内部链路验证（嗅探 / 内容脚本 / Referer / 下载 / 录制）
 *
 * 这几条是 HLS/DASH 之外、也同样写在交付目标里的能力：
 * 「网页媒体嗅探」「普通直链视频一键下载」「录制兜底」。
 * 它们的共同难点是**必须在真实浏览器里、以扩展的身份跑**，
 * Node 侧完全够不着，所以只能靠这一层。
 * ------------------------------------------------------------------ */

/** 打开一个扩展页面当"控制台"，所有扩展侧的操作都从这里发起 */
async function openControlPage(cdp, extId) {
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const targetId = created.result?.targetId;
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.result?.sessionId;
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.navigate', {
    url: `chrome-extension://${extId}/src/parser/parser.html`,
  }, sessionId);
  await sleep(1300);
  return { targetId, sessionId };
}

async function evalIn(cdp, sessionId, expression, { timeout = 90000 } = {}) {
  const res = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout,
  }, sessionId);
  if (res.result?.exceptionDetails) {
    throw new Error(res.result.exceptionDetails.exception?.description
      || res.result.exceptionDetails.text || '未知错误');
  }
  return res.result?.result?.value;
}

async function runExtensionExtras(cdp, extId, origin) {
  console.log('\n· 扩展内部链路（嗅探 / 内容脚本 / Referer / 下载 / 录制）');
  let problems = 0;
  const control = await openControlPage(cdp, extId);

  // ⚠️ 先清掉上一次运行留下的测试页。
  //
  // 这不是洁癖：每一节都是「新开一个测试页 → 让扩展按 URL 去 `chrome.tabs.query`
  // 找那个标签页」，而残留的旧标签 URL 一模一样 —— 于是扩展被武装到**别人**身上。
  // 实测过一次：上一次运行时 fixture 服务没起，那个标签页停在 Chrome 的错误页上，
  // 于是这次 `vh:mse-start` 直接回"页面受限，注入不了内容脚本"，
  // 一整套用例全红，看起来像功能坏了，其实是测试环境脏了。
  const stale = await evalIn(cdp, control.sessionId, `(async () => {
    const tabs = await chrome.tabs.query({ url: ${JSON.stringify(`${origin}/*`)} });
    let n = 0;
    for (const t of tabs) { await chrome.tabs.remove(t.id).catch(() => {}); n += 1; }
    return n;
  })()`);
  if (stale > 0) console.log(`  · 先清掉 ${stale} 个上次运行留下的测试页标签（否则扩展会被武装到旧标签上）`);

  // ⚠️ 测试环境里**默认关掉「产物自动导出到下载目录」**（它的默认值是开）。
  //
  // 这件事必须显式做，理由有两个，都会让测试结果撒谎：
  //   ① 每个抓流用例都会往**用户的下载目录**扔文件（谁都不该干这种事）；
  //   ② 「已导出」会记进索引，于是 9d 那条「有已导出产物时应该出现『清理已导出的 1 个』」
  //      会数到 5 —— 看着像功能坏了，其实是别的用例顺手导出的。
  // 专门验它的那条用例（自动保存口径 / 自动导出）自己打开，并在收尾时清干净。
  await evalIn(cdp, control.sessionId, `(async () => {
    const got = await chrome.storage.local.get('vh:settings');
    await chrome.storage.local.set({
      'vh:settings': { ...(got['vh:settings'] || {}), autoExportCapture: false },
    });
    return 'ok';
  })()`);

  /* ---- 1. 嗅探 + 内容脚本：打开一个真的在播视频的页面 ---- */
  let tabId = null;
  let pageSession = null;
  let pageTargetId = null;
  try {
    const pageUrl = `${origin}/__page/video`;
    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    pageTargetId = created.result?.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId: pageTargetId, flatten: true });
    pageSession = attached.result?.sessionId;
    await cdp.send('Runtime.enable', {}, pageSession);
    await cdp.send('Page.enable', {}, pageSession);
    await cdp.send('Page.navigate', { url: pageUrl }, pageSession);
    // 等视频真的发起请求（媒体加载 + 播放）
    await sleep(3500);

    tabId = await evalIn(cdp, control.sessionId, `(async () => {
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl)} });
      return tabs.length ? tabs[0].id : null;
    })()`);

    if (tabId == null) {
      console.error('  ✗ 嗅探：找不到测试页对应的标签页');
      problems += 1;
    } else {
      const got = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
        const r = await chrome.runtime.sendMessage({ type: 'vh:get-tab-media', tabId: ${tabId} });
        return JSON.stringify({
          ok: !!r?.ok,
          entries: (r?.entries || []).map((e) => ({
            kind: e.kind, url: e.url, referer: e.referer, size: e.size, mime: e.mime,
          })),
          pageVideos: (r?.pageVideos || []).length,
          pageTitle: r?.page?.title || '',
        });
      })()`));

      const media = got.entries.find((e) => e.url.endsWith('/source.mp4'));
      console.log(`  · 嗅探到 ${got.entries.length} 条媒体，页面视频 ${got.pageVideos} 个`);

      if (!media) {
        console.error('  ✗ 嗅探：没有捕获到页面里的 source.mp4');
        console.error(`    实际拿到：${JSON.stringify(got.entries.slice(0, 4))}`);
        problems += 1;
      } else {
        console.log(`  ✓ 嗅探：${media.kind}｜mime=${media.mime}｜size=${media.size}｜Referer=${media.referer || '(空)'}`);
        // Referer 是重新抓取分片时的关键信息，必须被记下来
        if (!media.referer) {
          console.error('  ✗ 嗅探：没有捕获到 Referer（分片重抓会 403）');
          problems += 1;
        }
      }

      // 内容脚本扫描 —— 这条同时验证了 MSG.PAGE_SCAN 那条链路
      if (got.pageVideos < 1) {
        console.error('  ✗ 内容脚本：没有扫描到页面上的 <video>（PAGE_SCAN 链路可能断了）');
        problems += 1;
      } else {
        console.log(`  ✓ 内容脚本：扫描到 ${got.pageVideos} 个 <video>`);
      }

      // 页面内按钮注入
      const inj = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
        const r = await chrome.runtime.sendMessage({ type: 'vh:inject-page-buttons', tabId: ${tabId}, enabled: true });
        return JSON.stringify(r || {});
      })()`));
      await sleep(700);
      const badgeHosts = await evalIn(cdp, pageSession, `document.querySelectorAll('[data-vh-badge]').length`);
      const badgeText = await evalIn(cdp, pageSession,
        `(document.querySelector('[data-vh-badge]')?.shadowRoot?.querySelector('button')?.textContent) || ''`);
      if (inj.ok && badgeHosts > 0) {
        console.log(`  ✓ 页面内按钮：注入了 ${badgeHosts} 个宿主元素，按钮文案「${badgeText}」`);
      } else {
        console.error(`  ✗ 页面内按钮：注入结果 ${JSON.stringify(inj)}，页面里找到 ${badgeHosts} 个标记元素`);
        problems += 1;
      }
    }
  } catch (err) {
    console.error(`  ✗ 测试页链路失败：${err.message}`);
    problems += 1;
  }

  /* ---- 1b. 面板的底栏与说明卡（用户提的界面要求，离线也要能验） ----
   *
   * 用户提了两条纯界面的事：
   *   · 两种模式的介绍别平铺在界面（挡视觉），鼠标放到「?」上再看；
   *   · 「管理」挪到「抓流」右边，方便点。
   * 这两条只有真的去量 DOM 才算验过 —— 而且要在**不依赖外网**的 extras 里验，
   * 否则每次都得先能访问真实站点。
   */
  try {
    const pageUrl = `${origin}/__page/video`;
    const created = await cdp.send('Target.createTarget', { url: pageUrl });
    const uiTarget = created.result?.targetId;
    await sleep(1500);
    const uiTabId = await evalIn(cdp, control.sessionId, `(async () => {
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl)} });
      return tabs.length ? tabs[0].id : null;
    })()`);
    const popupTarget = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extId}/src/popup/popup.html?tabId=${uiTabId ?? ''}`,
    });
    const pAtt = await cdp.send('Target.attachToTarget', { targetId: popupTarget.result.targetId, flatten: true });
    const pSession = pAtt.result?.sessionId;
    await cdp.send('Runtime.enable', {}, pSession);
    // 面板在真实使用中是一个 **420px 宽**的弹窗；而这里开的是一个标签页，
    // 视口是整窗宽。不把视口压成弹窗尺寸的话，"卡片有没有超出弹窗"这条断言
    // 会永远通过 —— 而用户报的就是"卡片比弹窗宽、左边被裁掉"。
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 420, height: 600, deviceScaleFactor: 1, mobile: false,
    }, pSession);
    await sleep(2500);

    const ui = JSON.parse(await evalIn(cdp, pSession, `(() => {
      const order = [...document.querySelectorAll('.foot-right > *')]
        .map((n) => n.id || n.querySelector?.('button')?.id || '');
      const card = document.getElementById('mode-panel');
      const cs = card ? getComputedStyle(card) : null;
      const q = document.getElementById('mode-help-q');
      // 设置展开后，量一下"控件扎堆"的那一行：标签有没有被挤成竖排。
      // 用户报过的原话是"这里红框的这里…标签被挤成一列"。
      document.getElementById('settings-toggle').click();
      const rows = {};
      for (const id of ['s-autosnap', 's-autocut']) {
        const box = document.getElementById(id);
        const row = box?.closest('.field');
        const label = row?.querySelector('label');
        if (!row || !label) continue;
        rows[id] = {
          rowH: Math.round(row.getBoundingClientRect().height),
          labelW: Math.round(label.getBoundingClientRect().width),
          labelH: Math.round(label.getBoundingClientRect().height),
          selects: [...row.querySelectorAll('select')].map((s) => Math.round(s.getBoundingClientRect().width)),
          stacked: row.classList.contains('stack'),
        };
      }
      const settingsH = Math.round(document.getElementById('settings').getBoundingClientRect().height);
      document.getElementById('settings-toggle').click();
      return JSON.stringify({
        order,
        qText: q ? q.textContent.trim() : null,
        cardDisplay: cs ? cs.display : null,
        cardPosition: cs ? cs.position : null,
        cardHasCompare: card ? /抓流/.test(card.textContent) && /录制/.test(card.textContent) : false,
        fromcurrent: !!document.getElementById('s-fromcurrent'),
        rows,
        settingsH,
      });
    })()`));

    console.log(`  · 面板底栏：${ui.order.join(' → ')}`);
    console.log(`  · 说明卡：问号=${JSON.stringify(ui.qText)}｜默认 display=${ui.cardDisplay}`
      + `｜position=${ui.cardPosition}｜含对比内容=${ui.cardHasCompare}`);
    // 控件扎堆的那两行：标签必须是一行读完，而不是被挤成竖排（用户报的界面问题）
    for (const [id, r] of Object.entries(ui.rows || {})) {
      console.log(`  · 设置行 ${id}：${r.stacked ? '两行式' : '单行式'}｜标签 ${r.labelW}×${r.labelH}`
        + `｜行高 ${r.rowH}｜下拉 ${r.selects.join('/')}`);
      if (r.labelH > 22) {
        console.error(`  ✗ ${id} 的标签被挤成 ${r.labelH}px 高（${r.labelW}px 宽）——`
          + '就是用户报的"标签竖成一列"，该用 .stack 让标签独占一行');
        problems += 1;
      } else if (r.stacked && r.selects.some((w) => w < 110)) {
        console.error(`  ✗ ${id} 的下拉被压得太窄（${r.selects.join('/')}px），长选项会被截断`);
        problems += 1;
      }
    }
    console.log(`  · 设置面板总高（展开时）：${ui.settingsH}px（弹窗上限 600）`);
    const ci = ui.order.indexOf('capture');
    const mi = ui.order.indexOf('manage');
    if (ci < 0 || mi !== ci + 1) {
      console.error(`  ✗ 「管理」应该紧挨在「抓流」右边，实际：${ui.order.join(' → ')}`);
      problems += 1;
    } else {
      console.log('  ✓ 「管理」就在「抓流」右边');
    }
    if (ui.qText !== '?' || ui.cardDisplay !== 'none' || !['absolute', 'fixed'].includes(ui.cardPosition)) {
      console.error('  ✗ 两种模式的说明应该是「问号 + 悬停浮层（默认不显示）」，'
        + `实际 问号=${JSON.stringify(ui.qText)} display=${ui.cardDisplay} position=${ui.cardPosition}`);
      problems += 1;
    } else {
      console.log('  ✓ 说明收在问号里：默认不显示、是浮层，不会把列表挤下去');
    }
    if (!ui.cardHasCompare) {
      console.error('  ✗ 说明卡里应该还留着两种模式的对比内容（悬停能看到）');
      problems += 1;
    }

    // ---- 悬停真的能展开吗？----
    //
    // 上面量的只是"默认不显示"。用户要的是"**鼠标放上去**才显示"，
    // 所以这里用 CDP 真发一次鼠标移动（实测它会走 CSS :hover 的命中测试），
    // 再看卡片的 display 有没有变。移开也要能收回去。
    const qBox = JSON.parse(await evalIn(cdp, pSession, `(() => {
      const r = document.getElementById('mode-help-q').getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: qBox.x, y: qBox.y, button: 'none' }, pSession);
    await sleep(400);
    const hovered = await evalIn(cdp, pSession, `getComputedStyle(document.getElementById('mode-panel')).display`);
    // 展开之后必须**完整落在弹窗范围内** —— 用户报的就是"显示不完全、
    // 左边那列被裁掉"（卡片比弹窗还宽，又从靠右的问号向左展开）。
    const fit = JSON.parse(await evalIn(cdp, pSession, `(() => {
      const r = document.getElementById('mode-panel').getBoundingClientRect();
      return JSON.stringify({
        left: Math.round(r.left), right: Math.round(r.right),
        top: Math.round(r.top), bottom: Math.round(r.bottom),
        vw: innerWidth, vh: innerHeight,
        scrollable: document.getElementById('mode-panel').scrollHeight
          > document.getElementById('mode-panel').clientHeight + 1,
      });
    })()`));
    console.log(`  · 展开后卡片范围：left ${fit.left} → right ${fit.right}（弹窗宽 ${fit.vw}）`
      + `｜top ${fit.top} → bottom ${fit.bottom}（高 ${fit.vh}）｜需要滚动=${fit.scrollable}`);
    if (fit.left < 0 || fit.right > fit.vw || fit.top < 0 || fit.bottom > fit.vh) {
      console.error('  ✗ 说明卡超出了弹窗范围，会被裁掉（用户报的就是这个）');
      problems += 1;
    } else {
      console.log('  ✓ 说明卡完整落在弹窗里，不会被裁');
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, button: 'none' }, pSession);
    await sleep(400);
    const away = await evalIn(cdp, pSession, `getComputedStyle(document.getElementById('mode-panel')).display`);
    console.log(`  · 鼠标移到问号上：display=${hovered}｜移开：display=${away}`);
    if (hovered !== 'block' || away !== 'none') {
      console.error(`  ✗ 说明卡应该"悬停展开、移开收起"，实际 悬停=${hovered} 移开=${away}`);
      problems += 1;
    } else {
      console.log('  ✓ 鼠标放到问号上会展开说明，移开就收起');
    }

    if (!ui.fromcurrent) {
      console.error('  ✗ 设置里缺少「抓流：从当前播放位置开始」');
      problems += 1;
    }

    // ---- 整条链路：页面播放位置 → 面板 → service worker ----
    //
    // 上面只验了 DOM 长什么样；真正要用的是"点抓流时把当前那一秒带上"。
    // 所以这里把页面拖到 5 秒，点面板上的「抓流」，再问后台收到的 startAt 是多少。
    const uiPageSession = await (async () => {
      const att = await cdp.send('Target.attachToTarget', { targetId: uiTarget, flatten: true });
      await cdp.send('Runtime.enable', {}, att.result.sessionId);
      return att.result.sessionId;
    })();
    await evalIn(cdp, uiPageSession, `(async () => {
      const v = document.getElementById('v');
      await v.play().catch(() => {});
      v.currentTime = 5;
      return 'ok';
    })()`);
    await sleep(1200);

    // 面板要重新扫一次才知道位置变了（它读的是 state.pageVideos）。
    // ⚠️ 位置要在**紧挨着点击之前**读，否则日志里的"页面在 X 秒"和后台收到的
    // startAt 会差出播放的这几秒，看起来像对不上。
    await evalIn(cdp, pSession, `document.getElementById('refresh').click()`);
    await sleep(1200);
    const pagePos = await evalIn(cdp, uiPageSession, `Number(document.getElementById('v').currentTime.toFixed(2))`);
    await evalIn(cdp, pSession, `document.getElementById('capture').click()`);
    await sleep(1500);
    const state = JSON.parse(await evalIn(cdp, control.sessionId,
      `chrome.runtime.sendMessage({ type: 'vh:record-state' }).then((r) => JSON.stringify(r && r.state || {}))`,
      { timeout: 15000 }));
    console.log(`  · 页面在 ${pagePos} 秒时点「抓流」→ 后台记下的 startAt=${state.startAt}`
      + `（差值 ${(Number(state.startAt) - pagePos).toFixed(2)} 秒：面板要真扫一次页面才拿位置，`
      + '这期间视频还在往前走）');
    // 判据：位置必须是**点下去那一刻的**（不能是 0，也不能比页面还旧），
    // 同时在合理范围内。面板会刻意往前退 3 秒（接缝宁多勿缺），
    // 而"扫一次页面"又要点时间，所以区间是 [页面位置-6, 页面位置+10]。
    const startAtNum = Number(state.startAt);
    if (!(startAtNum > 0.5) || startAtNum < pagePos - 6 || startAtNum > pagePos + 10) {
      console.error(`  ✗ 面板没有把"当前进度"带过去（startAt=${state.startAt}，页面在 ${pagePos} 秒）`);
      problems += 1;
    } else {
      console.log('  ✓ 「从当前进度开始」整条链路通了：页面位置 → 面板 → 后台');
    }

    // 收尾：把这次抓流放弃掉，别影响后面的用例；页面会被面板刷新一次，等它安定
    await evalIn(cdp, control.sessionId,
      `chrome.runtime.sendMessage({ type: 'vh:mse-discard' }).catch(() => {})`, { timeout: 20000 });
    await sleep(2000);

    await cdp.send('Target.closeTarget', { targetId: popupTarget.result.targetId });
    await cdp.send('Target.closeTarget', { targetId: uiTarget });
  } catch (err) {
    console.error(`  ✗ 面板界面用例失败：${err.message}`);
    problems += 1;
  }

  /* ---- 1c. 合并提示条：显示不显示、写什么字，必须是真判断出来的 ----
   *
   * 用户原话：「检测到多个独立轨道…点合并下载，它又提示要需要有两条轨道才能合并，
   * 这明明就是你没有做一个判断的逻辑。而且这个页面上的字是写死的，它不是动态的。」
   *
   * 两个原因都在这一节里钉住：
   *   ① 那条提示条**从来没被隐藏过** —— `.mergebar` 写了 `display:flex`，
   *      作者样式压过浏览器默认的 `[hidden]{display:none}`，所以 `hidden = true`
   *      是静默失效的。所以这里量 `getComputedStyle().display`，不看 `hidden` 属性。
   *   ② 文案是按"实际嗅到了哪些轨道"算的（`core/merge-plan.js`）。
   * 形态用 fixture 的 `/__page/tracks` 复刻 B 站：视频轨 `video/mp4`、
   * 音频轨 `audio/mp4`（服务端对 stream1 就是这么发的）。
   */
  try {
    // ① 只有一个完整 MP4 的页面：没有任何可合并的轨道 → 提示条必须真的不显示
    const plainUrl = `${origin}/__page/video`;
    const plainTarget = await cdp.send('Target.createTarget', { url: plainUrl });
    await sleep(1800);
    const plainTabId = await evalIn(cdp, control.sessionId, `(async () => {
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(plainUrl)} });
      return tabs.length ? tabs[0].id : null;
    })()`);

    // 用**常驻的**面板页（不是 openPopupFor 那种用完就关的），因为下面还要
    // 点一下「设置」——顺手验 `[hidden]{display:none!important}` 没有把设置面板
    // 锁死（它原来一直是展开的，因为 `.settings` 写了 display:flex）。
    const popTarget = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extId}/src/popup/popup.html?tabId=${plainTabId ?? ''}`,
    });
    const popAtt = await cdp.send('Target.attachToTarget', { targetId: popTarget.result.targetId, flatten: true });
    const popSession = popAtt.result?.sessionId;
    await cdp.send('Runtime.enable', {}, popSession);
    await sleep(2500);

    const readBars = `(() => {
      const barOf = (id) => {
        const box = document.getElementById(id);
        if (!box) return { found: false };
        return {
          isHiddenAttr: box.hasAttribute('hidden'),
          display: getComputedStyle(box).display,
          visible: getComputedStyle(box).display !== 'none',
        };
      };
      return JSON.stringify({
        merge: barOf('mergebar'), mse: barOf('mse-hint'),
        rec: barOf('recbar'), settings: barOf('settings'),
      });
    })()`;
    const plainView = { bars: JSON.parse(await evalIn(cdp, popSession, readBars)) };
    console.log(`  · 只有一条完整 MP4 的页面 → 合并条 display=${plainView.bars.merge.display}`
      + `（hidden 属性=${plainView.bars.merge.isHiddenAttr}）`
      + `｜抓流条 display=${plainView.bars.mse.display}`
      + `｜录制条 display=${plainView.bars.rec.display}`
      + `｜设置面板 display=${plainView.bars.settings.display}`);
    if (plainView.bars.merge.visible) {
      console.error('  ✗ 没有可合并的轨道，面板却挂着合并提示条 —— '
        + '用户就是因为这个点了按钮，然后被告知"至少要有两条轨道才能合并"');
      problems += 1;
    } else {
      console.log('  ✓ 没有可合并的轨道时，合并提示条真的不显示（hidden 属性真的生效了）');
    }
    // 这三条都不是"必须藏起来"的功能，但"该藏的时候藏不住"就是同一个 bug，
    // 而且用户截图里的新标签页上它们全都在（录制条、抓流条、合并条一起挂着）。
    for (const [name, bar] of [['抓流提示条', plainView.bars.mse], ['录制条', plainView.bars.rec]]) {
      if (bar.visible) {
        console.error(`  ✗ ${name}不该在这时候显示（hidden 属性被 CSS 的 display 压掉了）`);
        problems += 1;
      }
    }
    if (plainView.bars.settings.visible) {
      console.error('  ✗ 设置面板默认应该是收起的');
      problems += 1;
    } else {
      console.log('  ✓ 录制条 / 抓流提示条 / 设置面板默认都真的收起了（同一个 hidden 失效的 bug）');
    }

    // 收起之后还得能打开 —— 别修出一个"永远打不开的设置"
    const toggled = JSON.parse(await evalIn(cdp, popSession, `(() => {
      const btn = document.getElementById('settings-toggle');
      btn.click();
      const opened = getComputedStyle(document.getElementById('settings')).display;
      btn.click();
      const closed = getComputedStyle(document.getElementById('settings')).display;
      return JSON.stringify({ opened, closed });
    })()`));
    console.log(`  · 「设置」点开 display=${toggled.opened}｜再点收起 display=${toggled.closed}`);
    if (toggled.opened === 'none' || toggled.closed !== 'none') {
      console.error(`  ✗ 「设置」应该能开能收，实际 开=${toggled.opened} 收=${toggled.closed}`);
      problems += 1;
    } else {
      console.log('  ✓ 「设置」还能正常开合（没有被 hidden 规则锁死）');
    }
    await cdp.send('Target.closeTarget', { targetId: popTarget.result.targetId });
    await cdp.send('Target.closeTarget', { targetId: plainTarget.result.targetId });

    // ② B 站那种形态：一条视频轨 + 一条音频轨 → 提示条出现，文字是算出来的
    const tracksUrl = `${origin}/__page/tracks`;
    const tracksTarget = await cdp.send('Target.createTarget', { url: tracksUrl });
    await sleep(2200);
    const tracksTabId = await evalIn(cdp, control.sessionId, `(async () => {
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(tracksUrl)} });
      return tabs.length ? tabs[0].id : null;
    })()`);
    const tracksView = await openPopupFor(cdp, extId, tracksTabId);
    const bar = tracksView?.bars || {};
    console.log(`  · 一条视频轨 + 一条音频轨 → 合并条 display=${bar.merge?.display}`);
    console.log(`    「${bar.mergeText}」｜按钮 display=${bar.mergeButton?.display}`);
    if (!bar.merge?.visible) {
      console.error('  ✗ B 站那种"两条独立轨道"的形态下，合并提示条没出现 —— 合并这条路就没有入口了');
      problems += 1;
    } else if (!/1 条视频轨 \+ 1 条音频轨/.test(String(bar.mergeText))) {
      console.error(`  ✗ 合并条文案没有如实说出看到了什么：${JSON.stringify(bar.mergeText)}`);
      problems += 1;
    } else if (bar.mergeButton?.display === 'none') {
      console.error('  ✗ 判据成立却没有可点的按钮');
      problems += 1;
    } else {
      console.log('  ✓ 合并条按真实轨道数说话，按钮真的可点（就是用户点了就失败的那个场景）');
    }

    // ④ 真的点一次「合并下载」—— 用户报的就是"点了之后收到一句做不到"
    //
    // 面板点下去会把两条轨道的地址写进 session storage，再让后台打开解析器页。
    // 所以这里断言的是**解析器页到底拿到几条轨道**：必须是 2 条。
    // 修之前音频轨压根没被写进任务（它被分类成 AUDIO，不在 standalone 里），
    // 于是解析器页只会拿到 1 条 —— 合并必然失败。
    const goTarget = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extId}/src/popup/popup.html?tabId=${tracksTabId ?? ''}`,
    });
    const goAtt = await cdp.send('Target.attachToTarget', { targetId: goTarget.result.targetId, flatten: true });
    const goSession = goAtt.result?.sessionId;
    await cdp.send('Runtime.enable', {}, goSession);
    await sleep(2500);
    // 先记下"点击之前已经开着的解析器页"：--e2e 阶段会留下下载用的解析器页
    // （`parser.html?url=…`，界面是「开始下载」）。不排除它们的话，下面可能读到
    // 那一张旧页面，然后误报"合并任务里没有轨道"—— 我踩过一次，别踩第二次。
    const beforeTargets = new Set(((await cdp.send('Target.getTargets')).result?.targetInfos || [])
      .filter((t) => String(t.url).includes('/src/parser/parser.html'))
      .map((t) => t.targetId));
    const clicked = await evalIn(cdp, goSession, `(() => {
      const go = document.getElementById('merge-go');
      if (!go) return 'no-button';
      if (go.hidden || getComputedStyle(go).display === 'none') return 'button-hidden';
      go.click();
      return 'clicked';
    })()`);
    await sleep(3000);

    const parserTargets = (await cdp.send('Target.getTargets')).result?.targetInfos || [];
    // 只要"点完之后新出现的"那一张，而且必须是合并模式
    const parserTarget = parserTargets.find((t) => String(t.url).includes('/src/parser/parser.html')
      && /mode=fmp4/.test(String(t.url))
      && !beforeTargets.has(t.targetId))
      || parserTargets.find((t) => /mode=fmp4/.test(String(t.url)));
    if (clicked !== 'clicked') {
      console.error(`  ✗ 「合并下载」按钮没点下去：${clicked}`);
      problems += 1;
    } else if (!parserTarget) {
      console.error('  ✗ 点了「合并下载」却没有打开解析器页');
      problems += 1;
    } else {
      const pAtt = await cdp.send('Target.attachToTarget', { targetId: parserTarget.targetId, flatten: true });
      const pSid = pAtt.result?.sessionId;
      await cdp.send('Runtime.enable', {}, pSid);
      await sleep(1500);
      const job = JSON.parse(await evalIn(cdp, pSid, `JSON.stringify({
        tracks: document.getElementById('source-url').textContent,
        summary: document.getElementById('plan-summary').textContent,
        start: document.getElementById('start').textContent,
      })`, { timeout: 20000 }));
      console.log(`  · 点「合并下载」之后，解析器页拿到：${job.tracks}｜按钮「${job.start}」`);
      console.log(`    合并计划：${String(job.summary).replace(/\\s+/g, ' ').slice(0, 80)}`);
      if (!/2 条独立轨道/.test(String(job.tracks))) {
        console.error(`  ✗ 合并任务里应该有 2 条轨道（视频 + 音频），实际「${job.tracks}」`
          + ' —— 音频轨被漏掉了，点下去必然失败（用户报的正是这个）');
        problems += 1;
      } else {
        console.log('  ✓ 合并任务里视频轨和音频轨都在（点下去不会再说"至少要有两条轨道"）');
      }
      await cdp.send('Target.closeTarget', { targetId: parserTarget.targetId });
    }
    await cdp.send('Target.closeTarget', { targetId: goTarget.result.targetId });
    await cdp.send('Target.closeTarget', { targetId: tracksTarget.result.targetId });

    // ⑤ YouTube 形态（页面走 MSE，嗅探什么都拿不到）：要出现的**是抓流提示条**，
    //    不是合并条。这一条防的是"新判据误伤了本来该走抓流的站点"。
    //    真 YouTube 现在连不上（这台机器超时），所以用 fixture 复刻同一个形状：
    //    blob: 源 + 站点自有容器 MIME + URL 没有媒体扩展名。
    const umpUrl = `${origin}/__page/yt-ump`;
    const umpTarget = await cdp.send('Target.createTarget', { url: umpUrl });
    await sleep(2500);
    const umpTabId = await evalIn(cdp, control.sessionId, `(async () => {
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(umpUrl)} });
      return tabs.length ? tabs[0].id : null;
    })()`);
    const umpView = await openPopupFor(cdp, extId, umpTabId);
    console.log(`  · 站点自有容器（YouTube 形态）→ 抓流条 display=${umpView?.bars?.mse?.display}`
      + `｜「${umpView?.hint}」｜合并条 display=${umpView?.bars?.merge?.display}`);
    if (!umpView?.bars?.mse?.visible || !/MSE/.test(String(umpView?.hint))) {
      console.error('  ✗ 嗅探拿不到地址的 MSE 站点必须提示去抓流，实际提示条没出来');
      problems += 1;
    } else if (umpView?.bars?.merge?.visible) {
      console.error('  ✗ 这种站点没有可合并的轨道，合并条不该出现');
      problems += 1;
    } else {
      console.log('  ✓ MSE 站点仍然提示「抓流」（新判据没有误伤这一类站点）');
    }
    await cdp.send('Target.closeTarget', { targetId: umpTarget.result.targetId });

    // ③ 只看到视频轨（音频轨还没被请求）：可以合，但必须说清"出来是无声的"
    const onlyVideoUrl = `${origin}/__page/tracks?only=video`;
    const onlyTarget = await cdp.send('Target.createTarget', { url: onlyVideoUrl });
    await sleep(2200);
    const onlyTabId = await evalIn(cdp, control.sessionId, `(async () => {
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(onlyVideoUrl)} });
      return tabs.length ? tabs[0].id : null;
    })()`);
    const onlyView = await openPopupFor(cdp, extId, onlyTabId);
    console.log(`  · 只有视频轨 → 「${onlyView?.bars?.mergeText}」`
      + `｜display=${onlyView?.bars?.merge?.display}`);
    if (!/没有音频轨/.test(String(onlyView?.bars?.mergeText))
      || !/没有声音/.test(String(onlyView?.bars?.mergeText))) {
      console.error('  ✗ 只有视频轨时必须说清"合并出来没有声音"，'
        + `实际：${JSON.stringify(onlyView?.bars?.mergeText)}`);
      problems += 1;
    } else {
      console.log('  ✓ 只有视频轨时如实说明产物无声（不假装是完整的一对轨道）');
    }
    await cdp.send('Target.closeTarget', { targetId: onlyTarget.result.targetId });
  } catch (err) {
    console.error(`  ✗ 合并提示条用例失败：${err.message}`);
    problems += 1;
  }

  /* ---- 2. Referer 会话规则：真发一次请求看服务端收到什么 ---- */
  try {
    await fetch(`${origin}/__reset-headers`);
    const fakeReferer = `${origin}/__page/video`;
    const selfTabId = await evalIn(cdp, control.sessionId,
      `(async () => { const t = await chrome.tabs.getCurrent(); return t ? t.id : null; })()`);

    const setRes = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
      const r = await chrome.runtime.sendMessage({
        type: 'vh:set-referer', tabId: ${selfTabId}, referer: ${JSON.stringify(fakeReferer)},
      });
      return JSON.stringify(r || {});
    })()`));

    await evalIn(cdp, control.sessionId,
      `fetch(${JSON.stringify(`${origin}/source.mp4`)}, { method: 'HEAD' }).then((r) => r.status).catch((e) => 'err')`);
    await sleep(400);

    const seen = await (await fetch(`${origin}/__last-headers`)).json();
    if (seen?.referer === fakeReferer) {
      console.log(`  ✓ Referer 注入：服务端真的收到了 ${seen.referer}`);
    } else {
      console.error('  ✗ Referer 注入没有生效 —— 扩展页面自己发起的 fetch 没带上改写的 Referer');
      console.error(`    规则下发：${JSON.stringify(setRes)}；服务端收到：${JSON.stringify(seen)}`);
      problems += 1;
    }

    // 用完即撤
    await evalIn(cdp, control.sessionId, `(async () => {
      const r = await chrome.runtime.sendMessage({ type: 'vh:clear-referer', tabId: ${selfTabId} });
      return JSON.stringify(r || {});
    })()`);
  } catch (err) {
    console.error(`  ✗ Referer 验证失败：${err.message}`);
    problems += 1;
  }

  /* ---- 3. 直链下载：真的落一次盘 ---- */
  try {
    const dl = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
      const id = await chrome.downloads.download({
        url: ${JSON.stringify(`${origin}/source.mp4`)},
        filename: 'VideoHunter/verify-download.mp4',
        conflictAction: 'uniquify',
        saveAs: false,
      });
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const [item] = await chrome.downloads.search({ id });
        if (item && item.state === 'complete') {
          return JSON.stringify({ ok: true, state: item.state, bytes: item.fileSize || item.totalBytes, path: item.filename });
        }
        if (item && item.state === 'interrupted') {
          return JSON.stringify({ ok: false, state: item.state, error: item.error });
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      return JSON.stringify({ ok: false, error: '等了 20 秒还没结束' });
    })()`, { timeout: 40000 }));

    if (dl.ok) {
      console.log(`  ✓ 直链下载：落盘 ${dl.bytes} 字节 → ${dl.path}`);
    } else {
      console.error(`  ✗ 直链下载未能完成：${JSON.stringify(dl)}`);
      problems += 1;
    }
  } catch (err) {
    console.error(`  ✗ 直链下载验证失败：${err.message}`);
    problems += 1;
  }

  /* ---- 4. 录制管线：合成一条流喂进去，产物交给 ffprobe ---- */
  try {
    const rec = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
      const pipe = await import('../offscreen/pipeline.js');

      // 合成一条带音视频的流：canvas 画动画 + 振荡器出声。
      // 这样验的是编码与封装，不依赖 tabCapture 能不能拿到标签页。
      //
      // 帧用 **captureStream(0) + requestFrame()** 显式驱动，而不是靠
      // captureStream(30) 自动捕帧：headless 里没有合成器时钟，
      // 自动模式一次只吐出个位数帧（实测 3 秒 3 帧），那样就验不出
      // 「帧有没有被正确喂进编码器」。显式请求之后帧数是我说了算的，
      // 可以直接断言。
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d');
      const canvasStream = canvas.captureStream(0);
      const vTrack = canvasStream.getVideoTracks()[0];

      let produced = 0;
      const drawOnce = () => {
        produced += 1;
        ctx.fillStyle = 'hsl(' + (produced * 7 % 360) + ',70%,45%)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 80px sans-serif';
        ctx.fillText(String(produced), 40, 200);
        if (vTrack.requestFrame) vTrack.requestFrame();
      };
      const drawTimer = setInterval(drawOnce, 33);

      const actx = new AudioContext();
      const osc = actx.createOscillator();
      osc.frequency.value = 440;
      const dest = actx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      const aTrack = dest.stream.getAudioTracks()[0];

      const stream = new MediaStream([vTrack, aTrack]);
      const fileName = 'vh-rec-selftest.mp4';
      const recorder = await pipe.createRecorder({
        stream, fileName, videoBitrate: 1200000, frameRate: 30, audioBitrate: 96000, monitorAudio: false,
      });

      await new Promise((r) => setTimeout(r, 3000));
      const result = await recorder.stop();
      clearInterval(drawTimer);
      try { osc.stop(); } catch {}
      try { await actx.close(); } catch {}

      if (!result.ok) return JSON.stringify({ ok: false, error: result.error });

      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(fileName);
      const file = await fh.getFile();
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < buf.length; i += CH) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
      }

      return JSON.stringify({
        ok: true,
        produced,
        videoCodec: result.videoCodec,
        audioCodec: result.audioCodec,
        width: recorder.width,
        height: recorder.height,
        hasAudio: recorder.hasAudio,
        frames: result.frames,
        dropped: result.dropped,
        targetKind: result.targetKind,
        size: result.size,
        magic: String.fromCharCode(buf[4], buf[5], buf[6], buf[7]),
        base64: btoa(bin),
      });
    })()`, { timeout: 120000 }));

    if (!rec.ok) {
      console.error(`  ✗ 录制管线失败：${rec.error}`);
      problems += 1;
    } else {
      console.log(`  ✓ 录制管线：${rec.videoCodec} / ${rec.audioCodec || '无音轨'} · ${rec.width}×${rec.height}`
        + `｜产出 ${rec.produced} 帧 / 编码 ${rec.frames} 帧（丢 ${rec.dropped}）`
        + `｜${rec.targetKind}｜产物 ${rec.size} 字节｜容器 ${rec.magic}`);

      if (rec.magic !== 'ftyp') {
        console.error(`  ✗ 录制产物开头不是 ftyp（拿到 ${rec.magic}）`);
        problems += 1;
      }
      // 帧数必须对得上：产出多少就该编码多少（允许因为编码队列极限丢少量）
      if (rec.frames < rec.produced * 0.9) {
        console.error(`  ✗ 编码的帧数远少于产出的帧数：产出 ${rec.produced}，只编码了 ${rec.frames}（丢 ${rec.dropped}）`);
        problems += 1;
      }
      if (rec.base64) {
        mkdirSync(join(ROOT, '.tmp'), { recursive: true });
        const file = join(ROOT, '.tmp', 'browser-recording.mp4');
        writeFileSync(file, Buffer.from(rec.base64, 'base64'));
        try {
          const info = probe(file);
          const v = (info.streams || []).find((s) => s.codec_type === 'video');
          const a = (info.streams || []).find((s) => s.codec_type === 'audio');
          const dur = Number(info.format.duration);
          console.log(`  ✓ 录制产物 ffprobe：${v ? v.codec_name + ' ' + v.width + 'x' + v.height : '无视频轨'}`
            + `｜${a ? a.codec_name : '无音频轨'}｜${dur.toFixed(2)} 秒`);
          if (!v) { console.error('  ✗ 录制产物 ffprobe 读不到视频轨'); problems += 1; }
          if (!a) { console.error('  ✗ 录制产物 ffprobe 读不到音频轨'); problems += 1; }
          if (!(dur > 1.5 && dur < 6)) {
            console.error(`  ✗ 录制时长不合常理：${dur.toFixed(2)} 秒（录了约 3 秒）`);
            problems += 1;
          }
        } catch (err) {
          console.error(`  ✗ 录制产物 ffprobe 验证失败：${err.message}`);
          problems += 1;
        }
      }
    }
  } catch (err) {
    console.error(`  ✗ 录制管线验证失败：${err.message}`);
    problems += 1;
  }

  /* ---- 4b. 录制防空洞：中途让采集源停 3 秒，产物里不能留下这 3 秒 ---- */
  //
  // 这是用户报的那个 bug 的验收用例：标签页被切到后台 / 屏幕锁定时
  // Chrome 一帧都不给，时间戳却在走，产物里就出现几百秒的空洞，
  // 播放器拖进度条会弹回空洞之前那一帧。
  //
  // canvas 用 captureStream(0) 手动驱动，所以"停止 requestFrame"就等价于
  // "采集源停止出帧" —— 形状和真实故障完全一样，而且是可控、可重复的。
  //
  // 这里刻意**只录视频轨**：音频源是振荡器，它会一直出声，
  // 在压洞器看来就成了"只有视频断、音频还在走"（那是真实内容缺失，压了会音画错位）。
  // 只有一条轨时才等价于"整条采集停摆"，也就是用户文件里的形状。
  // "音频还在走就别压"这条规则由 test/seek-check.test.mjs 里的用例覆盖。
  try {
    const rec = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
      const pipe = await import('../offscreen/pipeline.js');

      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      const ctx = canvas.getContext('2d');
      const canvasStream = canvas.captureStream(0);
      const vTrack = canvasStream.getVideoTracks()[0];

      let produced = 0;
      const drawOnce = () => {
        produced += 1;
        ctx.fillStyle = 'hsl(' + (produced * 11 % 360) + ',70%,45%)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (vTrack.requestFrame) vTrack.requestFrame();
      };
      let drawTimer = setInterval(drawOnce, 33);

      const fileName = 'vh-rec-stall-selftest.mp4';
      const recorder = await pipe.createRecorder({
        stream: new MediaStream([vTrack]),
        fileName, videoBitrate: 800000, frameRate: 30, monitorAudio: false,
      });

      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await wait(1500);
      // ★ 停摆：不再画、也不再 requestFrame —— 采集源这 3 秒一帧都不出
      clearInterval(drawTimer);
      drawTimer = null;
      await wait(3000);
      drawTimer = setInterval(drawOnce, 33);
      await wait(1500);
      clearInterval(drawTimer);

      const result = await recorder.stop();
      if (!result.ok) return JSON.stringify({ ok: false, error: result.error });

      const root = await navigator.storage.getDirectory();
      const file = await (await root.getFileHandle(fileName)).getFile();
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < buf.length; i += CH) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
      }
      return JSON.stringify({
        ok: true,
        frames: result.frames,
        stalledMs: result.stalledMs,
        stallCount: result.stallCount,
        wallMs: result.durationMs,
        base64: btoa(bin),
      });
    })()`, { timeout: 120000 }));

    if (!rec.ok) {
      console.error(`  ✗ 录制防空洞验证失败：${rec.error}`);
      problems += 1;
    } else {
      console.log(`  · 录制防空洞：产出 ${rec.frames} 帧｜挂钟 ${(rec.wallMs / 1000).toFixed(1)} 秒`
        + `｜采集停摆 ${(rec.stalledMs / 1000).toFixed(2)} 秒 ×${rec.stallCount}`);
      // 停摆必须被认出来（3 秒左右），否则后面的断言没有意义
      if (!(rec.stalledMs > 2500 && rec.stalledMs < 4000)) {
        console.error(`  ✗ 应该识别出约 3 秒的采集停摆，实际 ${rec.stalledMs} 毫秒`);
        problems += 1;
      }
      if (rec.stallCount !== 1) {
        console.error(`  ✗ 停摆次数应该是 1，实际 ${rec.stallCount}`);
        problems += 1;
      }
      mkdirSync(join(ROOT, '.tmp'), { recursive: true });
      const file = join(ROOT, '.tmp', 'browser-recording-stall.mp4');
      writeFileSync(file, Buffer.from(rec.base64, 'base64'));
      try {
        const info = probe(file);
        const dur = Number(info.format.duration);
        console.log(`  ✓ 防空洞产物 ffprobe：${dur.toFixed(2)} 秒（挂钟 ${(rec.wallMs / 1000).toFixed(1)} 秒）`);
        // 录了 3 秒 + 停摆 3 秒；产物必须只剩 3 秒左右，不能是 6 秒
        if (!(dur > 2 && dur < 4.5)) {
          console.error(`  ✗ 产物时长不对：${dur.toFixed(2)} 秒 —— 停摆的 3 秒应该已经被压掉`);
          problems += 1;
        }
      } catch (err) {
        console.error(`  ✗ 防空洞产物 ffprobe 失败：${err.message}`);
        problems += 1;
      }
    }
  } catch (err) {
    console.error(`  ✗ 录制防空洞验证失败：${err.message}`);
    problems += 1;
  }

  /* ---- 5b. 站点"续播上次位置"时，抓流会不会被那一跳弄断 ---- */
  //
  // 这是用户报的"抓流产物前 12 分钟怎么拖都拖不动"的成因：抓流要刷新页面，
  // 而站点会把播放位置设回上次看到的地方。那一跳让中间几百秒没人抓，
  // 合并出来的文件里横着一段空洞。
  //
  // 两道防线各验一次：
  //   1. 看护 —— 位置被设走之后会被扳回开头（本用例）
  //   2. 兜底 —— 万一还是断了，落盘前把死气压掉（单元测试覆盖）
  try {
    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const resumeTarget = created.result.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId: resumeTarget, flatten: true });
    const resumeSession = attached.result.sessionId;
    await cdp.send('Page.enable', {}, resumeSession);
    await cdp.send('Runtime.enable', {}, resumeSession);
    await cdp.send('Page.navigate', { url: `${origin}/__page/resume` }, resumeSession);
    await sleep(1200);

    const resumeTabId = await evalIn(cdp, control.sessionId, `(async () => {
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(origin + '/__page/resume')} });
      return tabs.length ? tabs[0].id : null;
    })()`);

    if (resumeTabId == null) {
      console.error('  ✗ 续播测试页：找不到对应的标签页');
      problems += 1;
    } else {
      // 页面会在 1.5 秒后把位置设到 8 秒；先等它设完，确认它真的设了
      await sleep(1600);
      const jumped = await evalIn(cdp, resumeSession, `document.getElementById('v').currentTime`);
      console.log(`  · 页面自称已恢复到 ${Number(jumped).toFixed(2)} 秒（模拟站点续播）`);

      // 现在像用户点「抓流」那样武装：这一步会启动起播看护
      const armed = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
        const r = await chrome.runtime.sendMessage({ type: 'vh:mse-start', tabId: ${resumeTabId} });
        return JSON.stringify(r || {});
      })()`, { timeout: 30000 }));

      if (!armed.ok) {
        console.error(`  ✗ 续播用例里启动抓流失败：${armed.error}`);
        problems += 1;
      } else {
        // 页面每 1.2 秒会再设一次位置吗？不会 —— 所以看护要在它设过之后
        // 仍然把位置拉回开头（看护是持续观察跳变的）
        await evalIn(cdp, resumeSession, `(() => {
          // 再模拟一次"站点恢复位置"：这次是在扩展已经武装之后
          document.getElementById('v').currentTime = 8;
          return 'ok';
        })()`);
        await sleep(1500);
        const after = await evalIn(cdp, resumeSession, `document.getElementById('v').currentTime`);
        console.log(`  · 扩展武装之后再设一次位置，1.5 秒后实际停在 ${Number(after).toFixed(2)} 秒`);
        if (Number(after) > 2) {
          console.error(`  ✗ 起播看护没有把位置扳回开头（停在 ${Number(after).toFixed(2)} 秒）——`
            + '这就是"前 12 分钟拖不动"的成因');
          problems += 1;
        } else {
          console.log('  ✓ 起播看护把"续播"扳回了开头，抓流不会因此断成两截');
        }

        // ---- 新增：用户要求「从当前进度开始抓」时，看护要**看住那一秒** ----
        //
        // 用户提的："可以加一个功能，抓流可以根据当前播放的进度开始抓流，
        // 但是依旧要刷新一下浏览器界面"。刷新是必须的（钩子要在初始化段之前就位），
        // 所以做法是刷新之后把位置拨回用户点抓流时的那一秒。
        //
        // 这里验两件事：
        //   1. 站点从头播（位置 0）时，看护要把位置**往前拨**到目标；
        //   2. 站点自己续播到目标附近时，看护**不要**多事把它扳回 0。
        const fromZero = JSON.parse(await evalIn(cdp, resumeSession, `(async () => {
          const v = document.getElementById('v');
          v.currentTime = 0;
          return JSON.stringify({ before: Number(v.currentTime.toFixed(2)) });
        })()`));
        // 模拟"刷新之后带着 startAt 重新武装"：直接给内容脚本发 arm 消息
        const armedAt6 = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
          const r = await chrome.tabs.sendMessage(${resumeTabId}, { type: 'vh:mse-arm', enabled: true, startAt: 6 });
          return JSON.stringify(r || {});
        })()`, { timeout: 30000 }));
        await sleep(1500);
        const at6 = await evalIn(cdp, resumeSession, `document.getElementById('v').currentTime`);
        console.log(`  · 带 startAt=6 武装：从 ${fromZero.before} 秒 → ${Number(at6).toFixed(2)} 秒`
          + `（内容脚本回报 startAt=${armedAt6.startAt}）`);
        if (!(Number(at6) > 4)) {
          console.error(`  ✗ 「从当前进度开始」没生效：位置停在 ${Number(at6).toFixed(2)} 秒，`
            + '应该被拨到 6 秒附近');
          problems += 1;
        } else {
          console.log('  ✓ 从当前进度开始抓：位置被拨到了目标那一秒');
        }

        // 站点把位置设到目标附近（6.5 秒）→ 看护不该把它扳回 0
        await evalIn(cdp, resumeSession, `(() => {
          document.getElementById('v').currentTime = 6.5;
          return 'ok';
        })()`);
        await sleep(1200);
        const nearTarget = await evalIn(cdp, resumeSession, `document.getElementById('v').currentTime`);
        console.log(`  · 站点把位置设到 6.5 秒之后：${Number(nearTarget).toFixed(2)} 秒`);
        if (Number(nearTarget) < 3) {
          console.error(`  ✗ 目标附近的位置被看护扳回了 ${Number(nearTarget).toFixed(2)} 秒 ——`
            + '"从当前进度开始"会白点');
          problems += 1;
        } else {
          console.log('  ✓ 站点续播到目标附近时，看护不会多事把它扳回开头');
        }

        // ---- 关键：设了目标之后，**正常播放不能被拉回去** ----
        //
        // 用户报的：「根据当前进度抓流，它一直往后退…播放 3 秒一直往后退，
        // 播放 3 秒就相当于它不会往后走了」。
        // 原因是第一版把"离目标超过 2.5 秒"一律当成漂移 —— 而**正常播放**
        // 每过 2.5 秒就会离目标 2.5 秒，于是被无限拉回目标，永远播不过 3 秒。
        // 所以这里真的让它播 4 秒，位置必须一路向前。
        const forward = JSON.parse(await evalIn(cdp, resumeSession, `(async () => {
          const v = document.getElementById('v');
          v.currentTime = 6;
          v.playbackRate = 1;
          await v.play().catch(() => {});
          const samples = [];
          for (let i = 0; i < 40; i += 1) {
            await new Promise((r) => setTimeout(r, 100));
            samples.push(Number(v.currentTime.toFixed(2)));
          }
          return JSON.stringify({ samples });
        })()`, { timeout: 40000 }));

        let worstBackFwd = 0;
        for (let i = 1; i < forward.samples.length; i += 1) {
          const back = forward.samples[i - 1] - forward.samples[i];
          if (back > worstBackFwd) worstBackFwd = back;
        }
        const posFirst = forward.samples[0];
        const posLast = forward.samples[forward.samples.length - 1];
        console.log(`  · 设了 startAt=6 之后正常播放 4 秒：${posFirst} → ${posLast}`
          + `（最大回退 ${worstBackFwd.toFixed(2)} 秒）`);
        if (posLast - posFirst < 3) {
          console.error(`  ✗ 正常播放被看护拉住了：4 秒只前进了 ${(posLast - posFirst).toFixed(2)} 秒`
            + '（用户报的"一直往后退、播不过 3 秒"就是这个）');
          problems += 1;
        } else if (worstBackFwd > 1.5) {
          console.error(`  ✗ 播放过程中位置被拉回过 ${worstBackFwd.toFixed(2)} 秒`);
          problems += 1;
        } else {
          console.log('  ✓ 设了目标之后正常播放不会被拉回去');
        }

        // ⚠️ 把看护的目标**恢复成"从头"**再跑下面的倍速用例：
        // 上面刚把目标设成 6 秒，而倍速用例是从 0 开始往前播 —— 看护会一直
        // 把它拉回 6 秒（那是它的职责），于是"位置回退"的断言会误报。
        // 这两条用例在同一个页面上互斥，必须先复位。
        await evalIn(cdp, control.sessionId, `(async () => {
          await chrome.tabs.sendMessage(${resumeTabId}, { type: 'vh:mse-arm', enabled: true, startAt: 0 });
          return 'ok';
        })()`, { timeout: 30000 });
        await sleep(300);

        // ---- 但看护绝不能把「快进播放」当成"页面设位置" ----
        //
        // 用户报的：抓流期间用倍速插件开到 12 倍速，看护把它当成位置跳变，
        // 于是把视频扳回开头 —— 用户看到的是"我换个倍速，它就把进度条拉回头顶"，
        // 而且抓流被那一下 seek 打断（最后报"只抓到分片、没有初始化段"）。
        //
        // 判据要按**播放倍速**算：400 毫秒的轮询间隔里，12 倍速本来就会前进 4.8 秒，
        // 那是正常播放。这里用 6 倍速采样 1.5 秒，位置必须一路向前、绝不回退。
        const rateWatch = JSON.parse(await evalIn(cdp, resumeSession, `(async () => {
          const v = document.getElementById('v');
          v.currentTime = 0;
          v.playbackRate = 6;
          await v.play().catch(() => {});
          const samples = [];
          for (let i = 0; i < 15; i += 1) {
            await new Promise((r) => setTimeout(r, 100));
            samples.push(Number(v.currentTime.toFixed(2)));
          }
          const rate = v.playbackRate;
          v.playbackRate = 1;
          return JSON.stringify({ samples, rate });
        })()`, { timeout: 30000 }));

        let worstBack = 0;
        for (let i = 1; i < rateWatch.samples.length; i += 1) {
          const back = rateWatch.samples[i - 1] - rateWatch.samples[i];
          if (back > worstBack) worstBack = back;
        }
        console.log(`  · 6 倍速播放 1.5 秒：位置 ${rateWatch.samples[0]} → `
          + `${rateWatch.samples[rateWatch.samples.length - 1]} 秒｜最大回退 ${worstBack.toFixed(2)} 秒`);
        if (worstBack > 1) {
          console.error(`  ✗ 快进播放被看护当成了"页面设位置"，把视频扳回去 ${worstBack.toFixed(2)} 秒 ——`
            + '用户就是被这一下打断的（换倍速不该影响正在进行的抓流）');
          problems += 1;
        } else if (rateWatch.samples[rateWatch.samples.length - 1] < 3) {
          console.error('  ✗ 6 倍速下 1.5 秒只前进了这么点，播放显然被干扰了');
          problems += 1;
        } else {
          console.log('  ✓ 换倍速不会打断播放（看护按倍速算预期前进量）');
        }

        await evalIn(cdp, control.sessionId, `chrome.runtime.sendMessage({ type: 'vh:mse-stop' }).catch(() => {})`);
      }
    }
    await cdp.send('Target.closeTarget', { targetId: resumeTarget });
  } catch (err) {
    console.error(`  ✗ 续播用例验证失败：${err.message}`);
    problems += 1;
  }

  /* ---- 6. 「没有清单的 DASH」：两条自包含 fMP4 轨道 → 识别 → 合并 ---- */
  //
  // B 站那类站点不提供 m3u8/mpd，通过 API 直接给两条完整 fMP4 文件的地址。
  // 这条路的独特之处是**轨道类型不能靠文件名判断**，只能靠 moov 里的
  // handler box，所以必须真拿文件跑一遍。
  try {
    const out = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
      const { splitSelfContainedFmp4, describeBoxTree } = await import('./fmp4-file.js');
      const { parseInitSegment, mergeFmp4 } = await import('./mp4-merge.js');

      const load = async (name) => {
        const res = await fetch(${JSON.stringify(origin)} + '/fmp4-tracks/' + name);
        if (!res.ok) throw new Error(name + '：HTTP ' + res.status);
        return new Uint8Array(await res.arrayBuffer());
      };

      const vBytes = await load('video.m4s');
      const aBytes = await load('audio.m4s');
      const vs = splitSelfContainedFmp4(vBytes);
      const as = splitSelfContainedFmp4(aBytes);

      // 不传 contentType，全靠 moov 自己说明自己是什么轨
      const vInfo = parseInitSegment(vs.init);
      const aInfo = parseInitSegment(as.init);

      const merged = mergeFmp4({
        video: { init: vs.init, segments: [vs.fragments] },
        audio: { init: as.init, segments: [as.fragments] },
      });

      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < merged.length; i += CH) {
        bin += String.fromCharCode.apply(null, merged.subarray(i, i + CH));
      }
      return JSON.stringify({
        videoBytes: vBytes.length,
        audioBytes: aBytes.length,
        videoInit: vs.init.length,
        audioInit: as.init.length,
        vType: vInfo.contentType,
        aType: aInfo.contentType,
        mergedBytes: merged.length,
        magic: String.fromCharCode(merged[4], merged[5], merged[6], merged[7]),
        tree: describeBoxTree(vBytes, { maxDepth: 10, maxLines: 60 }).join('\\n'),
        base64: btoa(bin),
      });
    })()`, { timeout: 90000 }));

    console.log(`  · 无清单 DASH：视频轨 ${(out.videoBytes / 1024).toFixed(0)} KB 被认成 ${out.vType}`
      + `｜音频轨 ${(out.audioBytes / 1024).toFixed(0)} KB 被认成 ${out.aType}`);
    console.log(`  · 拆分出的初始化段：${out.videoInit} B / ${out.audioInit} B`
      + `｜合并产物 ${out.mergedBytes} B｜容器 ${out.magic}`);

    if (out.vType !== 'video' || out.aType !== 'audio') {
      console.error('  ✗ 轨道类型识别错了（应该靠 moov 的 handler box 判断）');
      problems += 1;
    }
    // 诊断器必须真的能打出解码器配置项 —— 合并失败时全靠它定位问题。
    // 上一版把深度设成 6，恰好在 avcC（第 8 层）前面停住，等于在最需要它的时候失效。
    if (!out.tree || !out.tree.includes('avcC')) {
      console.error('  ✗ 结构诊断打不到 avcC —— 合并失败时就没有可用的排查信息了');
      problems += 1;
    } else {
      const depth = out.tree.split('\n').find((l) => l.includes('avcC')).match(/^\s*/)[0].length / 2;
      console.log(`  ✓ 结构诊断能打到解码器配置项（avcC 在第 ${depth} 层）`);
    }
    if (out.magic !== 'ftyp') {
      console.error(`  ✗ 合并产物开头不是 ftyp（拿到 ${out.magic}）`);
      problems += 1;
    }
    if (out.base64) {
      mkdirSync(join(ROOT, '.tmp'), { recursive: true });
      const file = join(ROOT, '.tmp', 'browser-nomanifest.mp4');
      writeFileSync(file, Buffer.from(out.base64, 'base64'));
      try {
        const info = probe(file);
        const v = (info.streams || []).find((s) => s.codec_type === 'video');
        const a = (info.streams || []).find((s) => s.codec_type === 'audio');
        const dur = Number(info.format.duration);
        console.log(`  ✓ 无清单 DASH ffprobe：${v ? v.codec_name + ' ' + v.width + 'x' + v.height : '无视频轨'}`
          + `｜${a ? a.codec_name : '无音频轨'}｜${dur.toFixed(2)} 秒`);
        if (!v || !a) { console.error('  ✗ 合并产物缺少轨道'); problems += 1; }
        if (Math.abs(dur - 12) > 0.7) { console.error(`  ✗ 时长不对：${dur.toFixed(2)}`); problems += 1; }
      } catch (err) {
        console.error(`  ✗ ffprobe 验证失败：${err.message}`);
        problems += 1;
      }
    }

    /* ---- AV1：B 站现在发的就是这种（用户报的"没有声音"就是这里翻的车） ----
     *
     * 用户的原始报错：`视频样本描述项 av01（232 字节）里没有 avcC/hvcC`。
     * 样本描述项从 `avc1` 变成 `av01`、配置记录从 `avcC` 变成 `av1C`，
     * 结构一模一样、只是名字不同 —— 写死名字的代码就在这里退化成
     * "只存最大的一条轨道"，用户拿到一个没有声音的视频。
     */
    const av1 = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
      const { splitSelfContainedFmp4 } = await import('./fmp4-file.js');
      const { parseInitSegment, mergeFmp4 } = await import('./mp4-merge.js');
      const load = async (name) => {
        const res = await fetch(${JSON.stringify(origin)} + '/av1-tracks/' + name);
        if (!res.ok) throw new Error(name + '：HTTP ' + res.status);
        return new Uint8Array(await res.arrayBuffer());
      };
      const vs = splitSelfContainedFmp4(await load('video.m4s'));
      const as = splitSelfContainedFmp4(await load('audio.m4s'));
      const vInfo = parseInitSegment(vs.init);
      const merged = mergeFmp4({
        video: { init: vs.init, segments: [vs.fragments] },
        audio: { init: as.init, segments: [as.fragments] },
      });
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < merged.length; i += CH) {
        bin += String.fromCharCode.apply(null, merged.subarray(i, i + CH));
      }
      return JSON.stringify({
        codecType: vInfo.codecType,
        configName: vInfo.decodeDescriptionName,
        width: vInfo.width,
        height: vInfo.height,
        mergedBytes: merged.length,
        base64: btoa(bin),
      });
    })()`, { timeout: 90000 }));

    console.log(`  · AV1 轨道：样本描述项 ${av1.codecType}｜配置记录 ${av1.configName}`
      + `｜${av1.width}×${av1.height}｜合并产物 ${av1.mergedBytes} B`);
    if (av1.codecType !== 'av01' || av1.configName !== 'av1C') {
      console.error(`  ✗ AV1 轨道解析错了：${av1.codecType} / ${av1.configName}`);
      problems += 1;
    }
    if (av1.base64) {
      mkdirSync(join(ROOT, '.tmp'), { recursive: true });
      const file = join(ROOT, '.tmp', 'browser-av1.mp4');
      writeFileSync(file, Buffer.from(av1.base64, 'base64'));
      try {
        const info = probe(file);
        const v = (info.streams || []).find((s) => s.codec_type === 'video');
        const a = (info.streams || []).find((s) => s.codec_type === 'audio');
        const dur = Number(info.format.duration);
        console.log(`  ✓ AV1 合并产物 ffprobe：${v ? v.codec_name : '无视频轨'}`
          + `｜${a ? a.codec_name : '无音频轨'}｜${dur.toFixed(2)} 秒`);
        if (!v || v.codec_name !== 'av1') {
          console.error(`  ✗ AV1 合并产物的视频编码不对：${v && v.codec_name}`);
          problems += 1;
        }
        // 光有视频轨还不够 —— 用户报的正是"视频存下来了但是没有声音"
        if (!a) { console.error('  ✗ AV1 合并产物没有音频轨（就是用户报的那个 bug）'); problems += 1; }
        if (Math.abs(dur - 6) > 0.7) { console.error(`  ✗ AV1 产物时长不对：${dur.toFixed(2)}`); problems += 1; }
      } catch (err) {
        console.error(`  ✗ AV1 产物 ffprobe 失败：${err.message}`);
        problems += 1;
      }
    }
  } catch (err) {
    console.error(`  ✗ 无清单 DASH 验证失败：${err.message}`);
    problems += 1;
  }

  /* ---- 7. 合并模式的界面分支：任务能不能从存储里被正确读出来 ---- */
  try {
    // 先在控制页里写一份任务（模拟面板点「合并下载」时做的事）
    await evalIn(cdp, control.sessionId, `(async () => {
      await chrome.storage.session.set({
        'vh:mergejob': {
          urls: [
            { url: ${JSON.stringify(`${origin}/fmp4-tracks/video.m4s`)}, referer: ${JSON.stringify(origin)}, size: 981164 },
            { url: ${JSON.stringify(`${origin}/fmp4-tracks/audio.m4s`)}, referer: ${JSON.stringify(origin)}, size: 148950 },
          ],
          title: '无清单 DASH 合并自测',
          createdAt: Date.now(),
        },
      });
      return 'ok';
    })()`);

    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const mergeTarget = created.result?.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId: mergeTarget, flatten: true });
    const sid = attached.result?.sessionId;
    await cdp.send('Runtime.enable', {}, sid);
    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Page.navigate', {
      url: `chrome-extension://${extId}/src/parser/parser.html?mode=fmp4`,
    }, sid);
    await sleep(2000);

    const ui = JSON.parse(await evalIn(cdp, sid, `JSON.stringify({
      state: document.getElementById('state-body').textContent,
      button: document.getElementById('start').textContent,
      cardTitle: document.querySelector('#card-plan .card-title').textContent,
      summary: document.getElementById('plan-summary').textContent.slice(0, 90),
      noticeHidden: document.getElementById('notice').hidden,
    })`, { timeout: 20000 }));

    console.log(`  · 合并模式界面：${ui.state}｜按钮「${ui.button}」｜${ui.cardTitle}`);

    if (ui.button !== '下载并合并') {
      console.error(`  ✗ 按钮文案不对：期望「下载并合并」，实际「${ui.button}」`);
      problems += 1;
    }
    if (!ui.state.includes('独立 fMP4 轨道')) {
      console.error(`  ✗ 页面没有认出这是合并任务：${ui.state}`);
      problems += 1;
    }
    if (!ui.summary.includes('轨道数量')) {
      console.error(`  ✗ 计划区没有列出轨道：${ui.summary}`);
      problems += 1;
    }

    await cdp.send('Target.closeTarget', { targetId: mergeTarget });
  } catch (err) {
    console.error(`  ✗ 合并模式界面验证失败：${err.message}`);
    problems += 1;
  }

  // 换集切出来的那一段。9c 那一节（管理页验证）要用它判断
  // "这一轮到底是手动停止还是换集自动收尾"，所以作用域要在两个 try 之外。
  let cut = null;

  /* ---- 8. MSE 抓流：钩住播放器的 appendBuffer，拿已解密的原始码流 ---- */
  //
  // 这条路的独特价值：数据是播放器**已经解密好的**（下载 → JS 解密 →
  // appendBuffer），所以不需要密钥、没有网页水印、不用重新编码。
  //
  // 测试页是真的走 MSE 的：开两个 SourceBuffer，把 init 和分片依次 append。
  // 而且故意用**不带 codecs 的通用 mime**，逼着实现靠 moov 判断轨道类型。
  try {
    const pageUrl = `${origin}/__page/mse`;
    const created = await cdp.send('Target.createTarget', { url: pageUrl });
    const mseTarget = created.result?.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId: mseTarget, flatten: true });
    const mseSession = attached.result?.sessionId;
    await cdp.send('Runtime.enable', {}, mseSession);
    await cdp.send('Page.enable', {}, mseSession);
    await sleep(2500); // 先让它完整跑一遍，确认测试页本身是好的

    const before = await evalIn(cdp, mseSession, `document.getElementById('status').textContent`);
    console.log(`  · MSE 测试页自检：${before}`);
    if (!before.includes('append 完成')) {
      console.error(`  ✗ MSE 测试页自己没跑通：${before}`);
      problems += 1;
    }

    const mseTabId = await evalIn(cdp, control.sessionId, `(async () => {
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl)} });
      return tabs.length ? tabs[0].id : null;
    })()`);


        // ---- 播放器中途重建缓冲区时，别把整段抓流判死 ----
        //
        // 用户遇到过这个：抓了 200 段 / 21.4 MB，最后失败在一句
        // 「只抓到了媒体分片，没有初始化段」—— 因为播放器重建 SourceBuffer 之后
        // 只补了分片。可那个初始化段**本次会话早就收到过了**，没理由丢掉这 21 MB。
        //
        // 这里把形状直接喂进去：先用一个 mime 送 init，再用**另一个 mime** 送分片
        // （于是分成两组，第二组没有 init），然后要求快照仍然能成功落盘。
        const reuse = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
          const toB64 = (u8) => {
            let s = '';
            const CH = 0x8000;
            for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
            return btoa(s);
          };
          const load = async (p) => new Uint8Array(await (await fetch(${JSON.stringify(origin)} + p)).arrayBuffer());
          const init = await load('/dash-split/init-stream0.m4s');
          const frag = await load('/dash-split/chunk-stream0-00001.m4s');

          const started = await chrome.runtime.sendMessage({ type: 'vh:mse-start', tabId: ${mseTabId} });
          if (!started.ok) return JSON.stringify({ ok: false, error: started.error });

          // ① 先让会话见过初始化段（mime 带 codecs）
          await chrome.runtime.sendMessage({
            type: 'vh:mse-buffer', seq: 0,
            mime: 'video/mp4; codecs="avc1.64001e"', base64: toB64(init),
          });
          // ② 再用**另一个 mime** 送分片 —— 落到另一个组，那一组没有 init
          await chrome.runtime.sendMessage({
            type: 'vh:mse-buffer', seq: 1, mime: 'video/mp4', base64: toB64(frag),
          });

          const snap = await chrome.runtime.sendMessage({ type: 'vh:mse-snapshot' });
          await chrome.runtime.sendMessage({ type: 'vh:mse-stop' }).catch(() => {});
          return JSON.stringify(snap || {});
        })()`, { timeout: 60000 }));

        console.log(`  · 只有分片、没有 init 的那一组：ok=${reuse.ok}`
          + ` ${reuse.ok ? `产物 ${reuse.fileName}｜时长 ${Number(reuse.mediaSeconds).toFixed(2)} 秒` : `（${reuse.error}）`}`);
        if (reuse.warnings?.length) console.log(`    提示：${reuse.warnings[0]}`);
        if (!reuse.ok) {
          console.error('  ✗ 本次会话早就见过初始化段，不该把这段抓流判死（用户就是这么丢掉 21 MB 的）');
          problems += 1;
        } else if (!reuse.warnings?.some((w) => /先前收到/.test(w))) {
          console.error('  ✗ 复用了先前的初始化段就该说出来，否则用户不知道产物是怎么来的');
          problems += 1;
        } else {
          console.log('  ✓ 复用了本次会话里先前的初始化段，200 段那种情况不会再被判死');
        }

        // ---- 用户报的那一次：先暂停视频，再点「停止并保存」 ----
        //
        // 收到的报错：addVideoChunkRaw's third argument (timestamp) must be a
        // non-negative real number.，然后 334 段 / 34.7 MB 一起没了。
        //
        // 根因不在暂停本身，而在**采集到的分片不一定按时间顺序到**：暂停/重新缓冲
        // 会让播放器把已经送过的分片再送一次（字节不完全一样，所以按内容指纹判重
        // 拦不住）。这里就把顺序反过来喂：第 2 片先到、第 1 片后到。
        // 修之前这一喂就是用户那句报错；修完必须正常收尾，而且产物和正序一致。
        const messy = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
          const toB64 = (u8) => {
            let s = '';
            const CH = 0x8000;
            for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
            return btoa(s);
          };
          const load = async (p) => new Uint8Array(await (await fetch(${JSON.stringify(origin)} + p)).arrayBuffer());
          const init = await load('/dash-split/init-stream0.m4s');
          const c1 = await load('/dash-split/chunk-stream0-00001.m4s');
          const c2 = await load('/dash-split/chunk-stream0-00002.m4s');

          const started = await chrome.runtime.sendMessage({ type: 'vh:mse-start', tabId: ${mseTabId} });
          if (!started.ok) return JSON.stringify({ ok: false, error: started.error });
          await chrome.runtime.sendMessage({
            type: 'vh:mse-buffer', seq: 0, mime: 'video/mp4; codecs="avc1.64001e"', base64: toB64(init),
          });
          // 顺序故意反过来：第 2 片（源 2~4 秒）先到，第 1 片（源 0~2 秒）后到
          await chrome.runtime.sendMessage({ type: 'vh:mse-buffer', seq: 1, mime: 'video/mp4', base64: toB64(c2) });
          await chrome.runtime.sendMessage({ type: 'vh:mse-buffer', seq: 2, mime: 'video/mp4', base64: toB64(c1) });

          const stopped = await chrome.runtime.sendMessage({ type: 'vh:mse-stop' });
          if (!stopped?.ok) return JSON.stringify(stopped || { ok: false, error: '没有回执' });
          // 把产物捞出来给 ffprobe（光看"合并成功"不够，得看时长和帧数对不对）
          const root = await navigator.storage.getDirectory();
          const fh = await root.getFileHandle(stopped.fileName);
          const bytes = new Uint8Array(await (await fh.getFile()).arrayBuffer());
          return JSON.stringify({ ...stopped, base64: toB64(bytes) });
        })()`, { timeout: 120000 }));

        console.log(`  · 分片倒着到（暂停之后再停止的形状）：ok=${messy.ok}`
          + `${messy.ok ? `｜产物 ${Number(messy.mediaSeconds).toFixed(2)} 秒` : `｜${messy.error}`}`);
        if (messy.warnings?.length) console.log(`    提示：${messy.warnings.join('；')}`);
        if (!messy.ok) {
          console.error('  ✗ 分片倒着到就收尾失败 —— 这正是用户那句 muxer 报错，'
            + `34 MB 的抓流就是这么没的：${messy.error}`);
          problems += 1;
        } else if (!messy.warnings?.some((w) => /顺序是乱的/.test(w))) {
          console.error(`  ✗ 重新排过序就该说出来，实际提示：${JSON.stringify(messy.warnings)}`);
          problems += 1;
        } else if (messy.base64) {
          mkdirSync(join(ROOT, '.tmp'), { recursive: true });
          const file = join(ROOT, '.tmp', 'browser-messy.mp4');
          writeFileSync(file, Buffer.from(messy.base64, 'base64'));
          try {
            const info = probe(file);
            const v = (info.streams || []).find((s) => s.codec_type === 'video');
            const dur = Number(info.format.duration);
            console.log(`    产物 ffprobe：${v ? v.codec_name : '无视频轨'}｜${dur.toFixed(2)} 秒｜${v?.nb_frames} 帧`);
            // 两片 = 4 秒 100 帧；乱序绝不该把内容搞丢或搞重
            if (Math.abs(dur - 4) > 0.3 || Number(v?.nb_frames) !== 100) {
              console.error(`  ✗ 乱序产物的时长/帧数不对：${dur.toFixed(2)} 秒 / ${v?.nb_frames} 帧（应为 4 秒 / 100 帧）`);
              problems += 1;
            } else {
              console.log('  ✓ 分片倒着到也能正常收尾，内容一片不多一片不少');
            }
          } catch (err) {
            console.error(`  ✗ 乱序产物 ffprobe 失败：${err.message}`);
            problems += 1;
          }
        }

        // ---- 合并真的失败时，那几十 MB 绝不能跟着一起没 ----
        //
        // 用户报的另一半是"我发现录制的东西都没有了"。写盘失败那条路早就改成
        // "保住数据 / 可重试 / 可放弃"，合并这条路原来没有：一抛异常数据就没有出口。
        // 这里造一个一定会让合并抛错的输入（把 avc1 里的宽高改成 0，
        // mergeFmp4 会明确拒绝），然后要求：
        //   ① 回执是 retryable（不是"没救了"）
        //   ② 状态里报出"还有多少字节 / 多少段"
        //   ③ 「放弃这一份」能把会话收干净（用户总得有个出口）
        const badInit = readFileSync(join(ROOT, 'test', 'fixtures', 'dash-split', 'init-stream0.m4s'));
        const avc1At = badInit.indexOf(Buffer.from('avc1'));
        const patched = Buffer.from(badInit);
        patched.writeUInt16BE(0, avc1At + 28);  // width  = 0
        patched.writeUInt16BE(0, avc1At + 30);  // height = 0
        const crash = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
          const toB64 = (u8) => {
            let s = '';
            const CH = 0x8000;
            for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
            return btoa(s);
          };
          const load = async (p) => new Uint8Array(await (await fetch(${JSON.stringify(origin)} + p)).arrayBuffer());
          const bad = Uint8Array.from(atob(${JSON.stringify(patched.toString('base64'))}), (c) => c.charCodeAt(0));
          const frag = await load('/dash-split/chunk-stream0-00001.m4s');

          const started = await chrome.runtime.sendMessage({ type: 'vh:mse-start', tabId: ${mseTabId} });
          if (!started.ok) return JSON.stringify({ ok: false, error: started.error });
          await chrome.runtime.sendMessage({
            type: 'vh:mse-buffer', seq: 0, mime: 'video/mp4; codecs="avc1.64001e"', base64: toB64(bad),
          });
          await chrome.runtime.sendMessage({ type: 'vh:mse-buffer', seq: 1, mime: 'video/mp4', base64: toB64(frag) });

          const stopped = await chrome.runtime.sendMessage({ type: 'vh:mse-stop' });
          const status = await chrome.runtime.sendMessage({ type: 'vh:offscreen-status' });
          const state = await chrome.runtime.sendMessage({ type: 'vh:record-state' });
          return JSON.stringify({ stopped: stopped || {}, status: status || {}, state: state?.state || {} });
        })()`, { timeout: 120000 }));

        const st = crash.stopped || {};
        // 离屏文档的状态响应把细节放在 `stats` 里（见 offscreen.js 的 OFFSCREEN_STATUS）
        const stStats = crash.status?.stats || {};
        console.log(`  · 让合并当场失败：ok=${st.ok}｜retryable=${st.retryable}｜`
          + `离屏文档 awaitingRetry=${stStats.awaitingRetry}｜还剩 ${stStats.chunks} 段 / `
          + `${formatBytes(stStats.pendingBytes || 0)}`);
        console.log(`    报错：${String(st.error || '').split('。')[0]}`);
        if (st.ok) {
          console.error('  ✗ 这个输入本来就该让合并失败，结果它成功了 —— 用例本身失效了');
          problems += 1;
        } else if (st.retryable !== true || stStats.awaitingRetry !== true) {
          console.error('  ✗ 合并失败时数据必须留着并允许重试（用户就是在这里丢掉 34.7 MB 的）');
          problems += 1;
        } else if (!(stStats.pendingBytes > 0) || !(stStats.chunks > 0)) {
          console.error('  ✗ 状态里应该说清"还有多少数据没丢"');
          problems += 1;
        } else if (crash.state?.retryable !== true) {
          console.error('  ✗ 界面拿到的状态不是 retryable —— 「重试保存/放弃」就不会出现');
          problems += 1;
        } else {
          console.log('  ✓ 合并失败时数据留在内存里、状态可重试（不再是一句英文报错 + 全丢）');
        }

        const gaveUp = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
          const r = await chrome.runtime.sendMessage({ type: 'vh:mse-discard' });
          const s = await chrome.runtime.sendMessage({ type: 'vh:offscreen-status' });
          return JSON.stringify({ discard: r || {}, status: s || {} });
        })()`, { timeout: 30000 }));
        console.log(`  · 「放弃这一份」之后：丢弃 ${formatBytes(gaveUp.discard?.discardedBytes || 0)}`
          + `｜还在抓流=${gaveUp.status?.active === true}`
          + `｜还等重试=${gaveUp.status?.stats?.awaitingRetry === true}`);
        if (!gaveUp.discard?.ok || gaveUp.status?.active === true) {
          console.error('  ✗ 「放弃这一份」没能把会话收干净，后面所有抓流都会被它挡住');
          problems += 1;
        } else {
          console.log('  ✓ 「放弃这一份」是个真的出口（会话收干净了）');
        }
    if (mseTabId == null) {
      console.error('  ✗ 抓流：找不到 MSE 测试页对应的标签页');
      problems += 1;
    } else {
      const started = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
        const r = await chrome.runtime.sendMessage({ type: 'vh:mse-start', tabId: ${mseTabId} });
        return JSON.stringify(r || {});
      })()`, { timeout: 30000 }));
      if (!started.ok) {
        console.error(`  ✗ 抓流启动失败：${started.error}`);
        problems += 1;
      } else {
        // 刷新一次：钩子注册成了 document_start 的持久脚本，
        // 刷新后会自动重新就位 —— 顺便验证了"用户刷新从头播"这条真实路径
        await evalIn(cdp, control.sessionId, `chrome.tabs.reload(${mseTabId}).then(() => 'ok')`);
        await sleep(7000);

        const after = await evalIn(cdp, mseSession, `document.getElementById('status').textContent`);
        console.log(`  · 刷新后重新 append：${after}`);

        // 抓流是"内容脚本 → 离屏文档"的长连接，中间任何一环断了都会静默丢数据。
        // 收尾之前先问两边各收到多少，出问题时能一眼看出是哪一段断的。
        const contentStats = await evalIn(cdp, control.sessionId,
          `chrome.tabs.sendMessage(${mseTabId}, { type: 'vh:mse-stats' }).then((r) => JSON.stringify(r)).catch((e) => 'err:' + e.message)`,
          { timeout: 15000 });
        const offscreenStats = await evalIn(cdp, control.sessionId,
          `chrome.runtime.sendMessage({ type: 'vh:offscreen-status' }).then((r) => JSON.stringify(r)).catch((e) => 'err:' + e.message)`,
          { timeout: 15000 });
        console.log(`    · 内容脚本：${contentStats}`);
        console.log(`    · 离屏文档：${offscreenStats}`);

        // ---- 「先保存已录到的部分」：抓流不中断，另外落一个能播的文件 ----
        //
        // 对应 CocoCut 那个「直接保存已缓存好部分」。这里刻意不做"暂停/继续"：
        // 数据是播放器边解边喂的，挂起钩子等于丢帧，产物会留下真空洞。
        const snap = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
          const r = await chrome.runtime.sendMessage({ type: 'vh:mse-snapshot' });
          return JSON.stringify(r || {});
        })()`, { timeout: 60000 }));
        if (!snap.ok) {
          console.error(`  ✗ 保存部分产物失败：${snap.error}`);
          problems += 1;
        } else {
          console.log(`  ✓ 先保存已录到的部分：${snap.fileName}`
            + `｜${snap.size} 字节｜时长 ${Number(snap.mediaSeconds).toFixed(2)} 秒｜抓流未中断`);
          if (!/-部分\.mp4$/.test(snap.fileName)) {
            console.error(`  ✗ 部分产物的文件名应该能认出来：${snap.fileName}`);
            problems += 1;
          }
          if (!(snap.mediaSeconds > 0)) {
            console.error('  ✗ 部分产物读不出时长');
            problems += 1;
          }
          // 关键：抓流必须还在
          const still = JSON.parse(await evalIn(cdp, control.sessionId,
            `chrome.runtime.sendMessage({ type: 'vh:offscreen-status' }).then((r) => JSON.stringify(r || {}))`,
            { timeout: 15000 }));
          console.log(`    · 抓流仍在进行：${still.active ? '是' : '否'}｜模式 ${still.mode}`
            + `｜已收 ${still.stats?.chunks ?? '?'} 段`);
          if (!still.active || still.mode !== 'mse') {
            console.error('  ✗ 保存部分产物之后抓流不应该停止');
            problems += 1;
          }

          // ---- 马上再点一次：内容和上一份一样，**不该重复写** ----
          //
          // 用户实测连点三次攒出三份 56 MB 的同一段内容（文件名只有时间戳，
          // 根本看不出重叠）。第二份写的是同一个缓冲，所以这里就该直接说清楚。
          const again = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
            const r = await chrome.runtime.sendMessage({ type: 'vh:mse-snapshot' });
            return JSON.stringify(r || {});
          })()`, { timeout: 60000 }));
          console.log(`    · 紧接着再点一次：ok=${again.ok}｜identical=${again.identical}`
            + `｜${String(again.error || '').slice(0, 40)}`);
          if (again.ok) {
            console.error('  ✗ 内容没变时不该再写一份一样的文件（用户就这么白占了三份 56 MB）');
            problems += 1;
          } else if (again.identical !== true) {
            console.error(`  ✗ 应该明确告诉用户"和上一份内容一样"：${again.error}`);
            problems += 1;
          }
        }

        // ---- 换集：这个视频播完了，页面要换下一个 ----
        //
        // 播放列表 / 自动连播会把好几个视频连着放。不切开的话合并出来是**一个**
        // 装着好几集的文件，用户没法一集一存。站点换集时会连发几个事件
        // （`ended` / `emptied` / 新建 SourceBuffer），这里就报一次边界，断言：
        //   1. 当前这段被收尾成一个独立文件
        //   2. 缓冲被清空（下一个视频从零开始，不会和这一集连在一起）
        //   3. 抓流本身没有被停掉
        //   4. 同一轮换集的重复信号被去重（否则会切出一堆空文件）
        const boundary = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
          const r = await chrome.runtime.sendMessage({ type: 'vh:mse-boundary', reason: 'e2e-ended' });
          return JSON.stringify(r || {});
        })()`, { timeout: 60000 }));
        if (!boundary.ok) {
          console.error(`  ✗ 换集收尾失败：${boundary.error}`);
          problems += 1;
        } else {
          cut = boundary;
          console.log(`  ✓ 检测到视频切换：第 ${boundary.part} 段已自动保存 ${boundary.fileName}`
            + `｜${boundary.size} 字节｜时长 ${Number(boundary.mediaSeconds).toFixed(2)} 秒`);
          // 第 1 段不带序号（带序号的是同一个会话里的第 2、3 段；
          // 那个序列由 test/seek-check.test.mjs 里的命名用例覆盖）。
          // 这里要钉的是：它不能是"部分产物"，那两者语义完全不同。
          if (/-部分\.mp4$/.test(boundary.fileName)) {
            console.error(`  ✗ 换集收尾的是一段**完整**视频，不该叫"部分产物"：${boundary.fileName}`);
            problems += 1;
          }
          if (!/^vh-mse-.*\.mp4$/.test(boundary.fileName)) {
            console.error(`  ✗ 换集产物的名字不对：${boundary.fileName}`);
            problems += 1;
          }
          const after = JSON.parse(await evalIn(cdp, control.sessionId,
            `chrome.runtime.sendMessage({ type: 'vh:offscreen-status' }).then((r) => JSON.stringify(r || {}))`,
            { timeout: 15000 }));
          const chunks = after.stats?.chunks ?? -1;
          console.log(`    · 收尾之后：抓流仍在进行 ${after.active ? '是' : '否'}`
            + `｜缓冲已清空 ${chunks === 0 ? '是' : `否（还有 ${chunks} 段）`}`);
          if (!after.active) { console.error('  ✗ 换集不该把抓流停掉'); problems += 1; }
          if (chunks !== 0) {
            console.error('  ✗ 换集之后缓冲应该清空，否则下一集会和这一集连在一起');
            problems += 1;
          }
          // 重复信号必须被去重：站点换一集往往连发好几个事件
          const again = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
            const r = await chrome.runtime.sendMessage({ type: 'vh:mse-boundary', reason: 'e2e-duplicate' });
            return JSON.stringify(r || {});
          })()`, { timeout: 30000 }));
          console.log(`    · 紧接着再发一次同样的信号：${again.debounced ? '已忽略（去重生效）' : '又被切了一次'}`);
          if (!again.debounced) {
            console.error('  ✗ 同一轮换集的重复信号没有被去重，会切出空文件');
            problems += 1;
          }

          // 「自动保存」关掉之后：边界照样识别，但不该写出文件
          const off = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
            const { setSettings } = await import('../core/settings.js');
            await setSettings({ autoSaveCapture: false });
            // 先塞一点数据，否则离屏文档会因为"数据不够"而拒绝，验不出开关的作用
            const r = await chrome.runtime.sendMessage({ type: 'vh:mse-boundary', reason: 'e2e-autosave-off' });
            await setSettings({ autoSaveCapture: true });
            return JSON.stringify(r || {});
          })()`, { timeout: 30000 }));
          console.log(`    · 关掉自动保存后再来一次切换信号：action=${off.action}`
            + ` ${off.action === 'auto-save-off' ? '（没有落盘，符合预期）' : ''}`);
          if (off.action !== 'auto-save-off') {
            console.error('  ✗ 关掉自动保存之后不该再自动写文件');
            problems += 1;
          }
        }

        const stopped = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
          const r = await chrome.runtime.sendMessage({ type: 'vh:mse-stop' });
          return JSON.stringify(r || {});
        })()`, { timeout: 60000 }));
        // 换集之后缓冲是空的，所以"收尾"应该是一次**干净的结束**，而不是报错。
        // 报成 ERROR 会让用户以为抓流出错了，而其实前面那几段好好地躺在管理页里。
        if (cut && !stopped.ok) {
          console.error(`  ✗ 换集之后收尾不该失败：${stopped.error}`);
          problems += 1;
        } else if (cut && !stopped.alreadyCut) {
          console.error('  ✗ 缓冲已被换集清空，收尾应该走"已切过"这条干净的路');
          problems += 1;
        } else if (cut) {
          console.log(`  ✓ 换集之后收尾是干净的（不报错）：${stopped.state?.note || ''}`
            + `｜共 ${stopped.parts} 段`);
        }
        // 这一轮验证的产物就是换集切出来的那一段（缓冲被清空后没有"最后一段"了）
        const product = cut ? { fileName: cut.fileName, size: cut.size, mediaSeconds: cut.mediaSeconds, detail: cut.detail, durationMs: 0 } : stopped;
        if (!product.ok === false && !product.fileName) {
          console.error('  ✗ 没有拿到可验证的产物');
          problems += 1;
        } else {
          {
            const d = product.detail || {};
            console.log(`  ✓ 抓流产物：${d.chunks ?? '?'} 段数据｜${product.size} 字节`
              + `｜时长 ${Number(product.mediaSeconds).toFixed(2)} 秒`);
            for (const t of d.tracks || []) {
              console.log(`    · ${t.container} 轨 [${t.handlers.join('+')}]｜初始化段 ${t.init} B｜媒体分片 ${t.fragments} B`);
            }

          // 产物在扩展的 OPFS 里，从控制页读回来交给 ffprobe
          const dump = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
            const root = await navigator.storage.getDirectory();
            const fh = await root.getFileHandle(${JSON.stringify(product.fileName)});
            const file = await fh.getFile();
            const buf = new Uint8Array(await file.arrayBuffer());
            let bin = '';
            const CH = 0x8000;
            for (let i = 0; i < buf.length; i += CH) {
              bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
            }
            return JSON.stringify({ bytes: buf.length, base64: btoa(bin) });
          })()`, { timeout: 60000 }));

          mkdirSync(join(ROOT, '.tmp'), { recursive: true });
          const file = join(ROOT, '.tmp', 'browser-mse-capture.mp4');
          writeFileSync(file, Buffer.from(dump.base64, 'base64'));
          try {
            const info = probe(file);
            const v = (info.streams || []).find((s) => s.codec_type === 'video');
            const a = (info.streams || []).find((s) => s.codec_type === 'audio');
            const dur = Number(info.format.duration);
            console.log(`  ✓ 抓流产物 ffprobe：${v ? v.codec_name + ' ' + v.width + 'x' + v.height : '无视频轨'}`
              + `｜${a ? a.codec_name : '无音频轨'}｜${dur.toFixed(2)} 秒`);
            if (!v) { console.error('  ✗ 抓流产物没有视频轨'); problems += 1; }
            if (!a) { console.error('  ✗ 抓流产物没有音频轨'); problems += 1; }
            if (Math.abs(dur - 12) > 0.7) {
              console.error(`  ✗ 抓流产物时长不对：${dur.toFixed(2)}，期望约 12 秒`);
              problems += 1;
            }

            // ---- 界面上的时长必须是**文件的真实时长**，不是"这次操作了多久" ----
            //
            // 这条断言在这里特别有区分度：抓流过程只持续了约 7 秒，
            // 而产物是 12 秒。如果代码里还在拿挂钟当时长报，这里会立刻露馅。
            const state = JSON.parse(await evalIn(cdp, control.sessionId,
              `chrome.runtime.sendMessage({ type: 'vh:record-state' }).then((r) => JSON.stringify(r && r.state || {}))`,
              { timeout: 15000 }));
            console.log(`  · 状态里的时长：mediaSeconds=${state.mediaSeconds}`
              + `（挂钟 durationMs=${state.durationMs}）｜本次共 ${state.parts} 段`);
            if (cut) {
              // 换集之后"最后一段"是空的，所以状态里没有最终文件 —— 这是对的。
              // 要验的是：状态记住了已经切出来的那一段，而且它的时长是**文件自己的**时长。
              if (!(state.parts >= 1)) {
                console.error('  ✗ 换集之后状态里应该记着"已经存了几段"');
                problems += 1;
              }
              const lastCut = state.lastCut || {};
              if (!(lastCut.mediaSeconds > 11 && lastCut.mediaSeconds < 13)) {
                console.error(`  ✗ 换集那一段记下的时长应该是产物自己的 ~12 秒，实际 ${lastCut.mediaSeconds}`);
                problems += 1;
              }
              if (!lastCut.fileName) {
                console.error('  ✗ 状态里应该记下换集产物的文件名，管理页和提示都靠它');
                problems += 1;
              }
            } else {
              if (!(state.mediaSeconds > 11 && state.mediaSeconds < 13)) {
                console.error(`  ✗ 状态里的 mediaSeconds 应该是产物的 ~12 秒，实际 ${state.mediaSeconds}`
                  + '（这正是"显示的是我开抓流的时长"那个 bug）');
                problems += 1;
              }
              if (Math.abs((state.durationMs || 0) / 1000 - state.mediaSeconds) < 2) {
                console.error('  ✗ 挂钟时长和媒体时长不该这么接近 —— 这条用例失去区分度了，检查一下是不是没真的按产物算');
                problems += 1;
              }
            }

            // ---- 管理页要能列出这个产物、并显示真实时长 ----
            const management = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
              const root = await navigator.storage.getDirectory();
              const names = [];
              for await (const [name, handle] of root.entries()) {
                if (handle.kind === 'file') names.push(name);
              }
              return JSON.stringify({ names });
            })()`));
            const captured = management.names.find((n) => n === product.fileName);
            console.log(`  · OPFS 里的产物：${captured ? '已落盘' : '没找到'}`
              + `｜前缀 ${product.fileName.startsWith('vh-mse-') ? 'vh-mse-（抓流）' : '非抓流前缀！'}`);
            if (!captured) { console.error('  ✗ 抓流产物不在 OPFS 里'); problems += 1; }
            if (!product.fileName.startsWith('vh-mse-')) {
              console.error('  ✗ 抓流产物应该用 vh-mse- 前缀，管理页才能把它归到「抓流文件」');
              problems += 1;
            }
            // 自动打开管理页只在"用户手动停止"这条路上下发；换集之后是自动收尾，
            // 那时用户可能已经走开了，不该突然弹一个标签页出来。
            const manageOpen = stopped.management;
            if (!cut && !manageOpen?.ok) {
              console.error('  ✗ 抓流结束后没有打开管理页');
              problems += 1;
            } else if (manageOpen?.ok) {
              console.log(`  ✓ 抓流结束后自动打开管理页（复用已开标签页：${manageOpen.reused ? '是' : '否'}）`);
            } else {
              console.log('  · 这一轮是换集自动收尾，没有弹管理页（符合预期）');
            }
          } catch (err) {
            console.error(`  ✗ 抓流产物 ffprobe 验证失败：${err.message}`);
            problems += 1;
          }
          }
        }
      }
    }

    await cdp.send('Target.closeTarget', { targetId: mseTarget });
  } catch (err) {
    console.error(`  ✗ MSE 抓流验证失败：${err.message}`);
    problems += 1;
  }
  /* ---- 9c. 管理页真的把抓流产物列出来、并显示真实时长 ---- */
  //
  // 上面验的是"状态里的数字对不对"，这里验的是**用户眼睛里看到的那一行**。
  // 列表里的时长要走一遍「索引 → 没有就回退读文件头」的完整路径，
  // 任何一环断了都会在这里显示成"时长未记录"。
  try {
    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const mgmtTarget = created.result.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId: mgmtTarget, flatten: true });
    const mgmtSession = attached.result.sessionId;
    await cdp.send('Page.enable', {}, mgmtSession);
    await cdp.send('Runtime.enable', {}, mgmtSession);
    await cdp.send('Page.navigate', {
      url: `chrome-extension://${extId}/src/recorder/recorder.html?focus=capture`,
    }, mgmtSession);
    await sleep(2500);

    const view = JSON.parse(await evalIn(cdp, mgmtSession, `(() => {
      const captures = document.getElementById('captures');
      const recordings = document.getElementById('recordings');
      const rows = captures ? [...captures.children] : [];
      const first = rows[0];
      const notice = document.getElementById('notice');
      return JSON.stringify({
        title: document.querySelector('.top-title')?.textContent || '',
        captureRows: rows.length,
        captureText: first ? first.textContent : '',
        allCaptureText: rows.map((r) => r.textContent),
        recordBox: !!recordings,
        focusHighlight: !!document.getElementById('capture-card')?.classList.contains('is-focus'),
        hasDiagButton: !!(first && [...first.querySelectorAll('button')].some((b) => b.textContent === '体检')),
        noticeText: notice && !notice.hidden ? notice.textContent : '',
        // 存储用量那一行：用户看不到数字，就只会在"写不进去"的那一刻才发现
        storageText: document.getElementById('storage-use')?.textContent || '',
        cleanHidden: document.getElementById('clean-exported')?.hidden,
      });
    })()`, { timeout: 20000 }));

    console.log(`  · 管理页标题：${view.title}｜抓流行数 ${view.captureRows}｜高亮 ${view.focusHighlight}`);
    console.log(`    第一行：${view.captureText.trim().slice(0, 90)}`);
    console.log(`    存储：${view.storageText.trim().slice(0, 100)}`);
    console.log(`    完成提示：${view.noticeText.trim().replace(/\\s+/g, ' ').slice(0, 110)}`);

    if (!/抓流/.test(view.title)) {
      console.error(`  ✗ 管理页标题应该体现抓流，实际「${view.title}」`);
      problems += 1;
    }
    if (!/已用\s/.test(view.storageText) || !/配额/.test(view.storageText)) {
      console.error(`  ✗ 管理页没有显示"已用 / 配额"：${view.storageText.slice(0, 80)}`);
      problems += 1;
    }
    if (view.captureRows < 1) {
      console.error('  ✗ 管理页的「抓流文件」里没有列出刚抓到的产物');
      problems += 1;
    }
    if (!/时长\s*\d+:\d\d/.test(view.captureText)) {
      console.error(`  ✗ 抓流那一行没有显示真实时长：${view.captureText.trim().slice(0, 90)}`);
      problems += 1;
    }
    // 跳过来的时候必须把"刚做完什么"说清楚。
    // 两条路说法不同：手动停止是"抓流完成 + 这一份的时长"，
    // 换集自动收尾之后最后一段是空的，但那几段**已经存好了**，也要交代清楚 ——
    // 否则用户看到"抓流结束"却不知道文件在哪。
    if (cut) {
      if (!/一共自动存了 1 个文件/.test(view.noticeText)) {
        console.error(`  ✗ 换集收尾后的提示应该说清存了几个文件：${view.noticeText.slice(0, 90)}`);
        problems += 1;
      }
    } else {
      if (!/抓流完成/.test(view.noticeText)) {
        console.error(`  ✗ 管理页没有交代刚完成的抓流：${view.noticeText.slice(0, 80)}`);
        problems += 1;
      }
      if (!/视频时长[:：]\s*00:1[12]/.test(view.noticeText)) {
        console.error(`  ✗ 完成提示里的视频时长不对（应该是产物的 ~12 秒）：${view.noticeText.slice(0, 120)}`);
        problems += 1;
      }
    }
    if (!view.recordBox) { console.error('  ✗ 管理页缺少「录制文件」分组'); problems += 1; }
    if (!view.focusHighlight) { console.error('  ✗ focus=capture 时没有高亮抓流分组'); problems += 1; }
    if (!view.hasDiagButton) { console.error('  ✗ 产物行上缺少「体检」按钮'); problems += 1; }

    // 部分产物也要出现在「抓流文件」里，并且有真实时长
    const partialRow = view.allCaptureText.find((t) => /-部分\.mp4/.test(t));
    console.log(`    部分产物行：${partialRow ? partialRow.trim().slice(0, 80) : '（没找到）'}`);
    if (!partialRow) {
      console.error('  ✗ 「先保存已录到的部分」写出的文件没有出现在抓流列表里');
      problems += 1;
    } else if (!/时长\s*\d+:\d\d/.test(partialRow)) {
      console.error(`  ✗ 部分产物那一行没有时长：${partialRow.trim().slice(0, 80)}`);
      problems += 1;
    }

    await cdp.send('Target.closeTarget', { targetId: mgmtTarget });
  } catch (err) {
    console.error(`  ✗ 管理页验证失败：${err.message}`);
    problems += 1;
  }



  /* ---- 9d. 「已导出」标记 + 清理已导出的 ----
   *
   * 为什么需要这个出口：产物攒在浏览器私有存储里，配额是有限的（实测 5.6 GB），
   * 而用户手上到底有没有那份文件，只有**导出成功那一刻**知道。
   * 所以清理只能以"已导出"为凭据 —— 绝不按体积/时长猜哪几个重复。
   *
   * 这里没法走完整导出（`showSaveFilePicker` 要用户手势），
   * 所以只验**标记 → 界面 → 清理**这一段；导出本身在别处验过。
   */
  try {
    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const cleanTarget = created.result?.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId: cleanTarget, flatten: true });
    const cleanSession = attached.result?.sessionId;
    await cdp.send('Page.enable', {}, cleanSession);
    await cdp.send('Runtime.enable', {}, cleanSession);
    await cdp.send('Page.navigate', { url: `chrome-extension://${extId}/src/recorder/recorder.html` }, cleanSession);
    await sleep(2500);

    const picked = JSON.parse(await evalIn(cdp, cleanSession, `(async () => {
      const root = await navigator.storage.getDirectory();
      let newest = null;
      for await (const [name, handle] of root.entries()) {
        if (handle.kind !== 'file') continue;
        if (!name.startsWith('vh-mse-')) continue;
        const file = await handle.getFile();
        if (!newest || file.lastModified > newest.at) newest = { name, at: file.lastModified, size: file.size };
      }
      if (!newest) return JSON.stringify({ ok: false });
      // 走的就是导出成功之后那一行代码（import 的是同一个模块）
      const { createMediaIndex } = await import('/src/core/media-index.js');
      await createMediaIndex().patch(newest.name, { exportedAt: Date.now() });
      return JSON.stringify({ ok: true, ...newest });
    })()`, { timeout: 30000 }));

    if (!picked.ok) {
      console.error('  ✗ 「已导出」用例：OPFS 里没有抓流产物可标记');
      problems += 1;
    } else {
      await evalIn(cdp, cleanSession, `location.reload()`);
      await sleep(2200);
      const view = JSON.parse(await evalIn(cdp, cleanSession, `(() => {
        const rows = [...document.getElementById('captures').children];
        const row = rows.find((r) => r.textContent.includes(${JSON.stringify(picked.name)}));
        const btn = document.getElementById('clean-exported');
        return JSON.stringify({
          rowText: row ? row.textContent : '',
          storage: document.getElementById('storage-use').textContent,
          cleanHidden: btn.hidden,
          cleanText: btn.textContent,
        });
      })()`));
      console.log(`  · 已导出的那一行：${view.rowText.trim().slice(0, 80)}`);
      console.log(`  · 存储行：${view.storage.trim().slice(0, 90)}｜清理按钮：${view.cleanHidden ? '（没显示）' : view.cleanText}`);
      if (!/已导出/.test(view.rowText)) {
        console.error('  ✗ 导出过的产物应该在列表里标出来（用户才知道哪些能安全删）');
        problems += 1;
      }
      // 判据是"按钮出现、而且数字与已导出的产物对得上"，**不写死 1**：
      // 「产物自动导出到下载目录」这个功能本身就会让别的用例也留下"已导出"的产物
      // （测试环境默认关掉了它，但换一个复用的 profile 跑就会看到历史遗留）。
      // 写死 1 的结果是：功能没坏，用例却红 —— 一个会撒谎的断言比没有断言更糟。
      if (view.cleanHidden || !/清理已导出的 \d+ 个/.test(view.cleanText)) {
        console.error(`  ✗ 有已导出的产物时应该出现「清理已导出的」：${view.cleanText}`);
        problems += 1;
      } else if (!/已导出 \d+ 个/.test(view.storage)) {
        console.error(`  ✗ 存储行也该说清有几个已导出：${view.storage}`);
        problems += 1;
      }

      // 点它（confirm 换成直接同意），断言文件真的被删掉
      const cleaned = await evalIn(cdp, cleanSession, `(async () => {
        window.confirm = () => true;
        document.getElementById('clean-exported').click();
        await new Promise((r) => setTimeout(r, 1500));
        const root = await navigator.storage.getDirectory();
        const names = [];
        for await (const [name] of root.entries()) names.push(name);
        return JSON.stringify({
          stillThere: names.includes(${JSON.stringify(picked.name)}),
          rows: [...document.getElementById('captures').children].length,
          storage: document.getElementById('storage-use').textContent,
        });
      })()`, { timeout: 30000 });
      const result = JSON.parse(cleaned);
      console.log(`  · 清理之后：文件还在=${result.stillThere}｜列表 ${result.rows} 行｜${result.storage.trim().slice(0, 70)}`);
      if (result.stillThere) {
        console.error('  ✗ 「清理已导出的」没有真的删掉那个文件');
        problems += 1;
      }
      if (/已导出/.test(result.storage)) {
        console.error(`  ✗ 清理之后不该还写着"已导出 N 个"：${result.storage}`);
        problems += 1;
      }
    }

    await cdp.send('Target.closeTarget', { targetId: cleanTarget });
  } catch (err) {
    console.error(`  ✗ 「已导出 / 清理」用例失败：${err.message}`);
    problems += 1;
  }

  /* ---- 8f. 画面也是 WebM 的站点：产物应该是 .webm，而且零转码 ----
   *
   * 原来这条路只会回一句"暂不支持 WebM 画面"，用户什么都拿不到。
   * 现在出 `.webm`：VP9 帧和 Opus 帧原样搬进新容器 —— 连 YouTube 那条路
   * 唯一的有损（Opus → AAC）都省了。
   *
   * 这里要求三件事：产物是 .webm、ffprobe 认得出 vp9 + opus、
   * 而且**真解得出来**（帧数 + 音频估频），以及没有发生转码。
   */
  try {
    const pageUrl = `${origin}/__page/mse-webm-video`;
    const created = await cdp.send('Target.createTarget', { url: pageUrl });
    const wvTarget = created.result?.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId: wvTarget, flatten: true });
    const wvSession = attached.result?.sessionId;
    await cdp.send('Runtime.enable', {}, wvSession);
    await cdp.send('Page.enable', {}, wvSession);
    await sleep(2500);

    const selfCheck = await evalIn(cdp, wvSession, `document.getElementById('status').textContent`);
    console.log(`  · WebM 画面测试页自检：${selfCheck}`);
    if (!selfCheck.includes('append 完成')) {
      console.error(`  ✗ WebM 画面测试页自己没跑通：${selfCheck}`);
      problems += 1;
    }

    const tabId = await evalIn(cdp, control.sessionId, `(async () => {
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl)} });
      return tabs.length ? tabs[0].id : null;
    })()`);

    const started = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
      const r = await chrome.runtime.sendMessage({ type: 'vh:mse-start', tabId: ${tabId} });
      return JSON.stringify(r || {});
    })()`, { timeout: 30000 }));

    if (!started.ok) {
      console.error(`  ✗ WebM 画面用例里抓流启动失败：${started.error}`);
      problems += 1;
    } else {
      await evalIn(cdp, control.sessionId, `chrome.tabs.reload(${tabId}).then(() => 'ok')`);
      await sleep(8000);
      const stopped = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
        const r = await chrome.runtime.sendMessage({ type: 'vh:mse-stop' });
        return JSON.stringify(r || {});
      })()`, { timeout: 120000 }));

      if (!stopped.ok) {
        console.error(`  ✗ WebM 画面用例没能产出文件：${String(stopped.error).split('\\n')[0]}`);
        problems += 1;
      } else {
        console.log(`  · 产物：${stopped.fileName}｜${stopped.size} 字节`
          + `｜时长 ${Number(stopped.mediaSeconds).toFixed(2)} 秒`);
        for (const w of stopped.warnings || []) console.log(`    ! ${String(w).split('\\n')[0]}`);
        if (!/\.webm$/.test(stopped.fileName)) {
          console.error(`  ✗ 画面是 WebM 的流应该出 .webm：${stopped.fileName}`);
          problems += 1;
        }
        if (stopped.detail?.audioTranscode) {
          console.error('  ✗ 这条路是零转码的，不该发生音频转码');
          problems += 1;
        }
        const codes = stopped.detail?.webmCodecs || [];
        console.log(`    · 产物里的编码：${codes.join(' + ') || '（没记录）'}`);
        if (!codes.includes('V_VP9') || !codes.includes('A_OPUS')) {
          console.error(`  ✗ 应该记录成 VP9 + Opus：${codes.join(',')}`);
          problems += 1;
        }

        const dump = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
          const root = await navigator.storage.getDirectory();
          const fh = await root.getFileHandle(${JSON.stringify(stopped.fileName)});
          const file = await fh.getFile();
          const buf = new Uint8Array(await file.arrayBuffer());
          let bin = '';
          const CH = 0x8000;
          for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
          return JSON.stringify({ bytes: buf.length, base64: btoa(bin) });
        })()`, { timeout: 120000 }));

        mkdirSync(join(ROOT, '.tmp'), { recursive: true });
        const file = join(ROOT, '.tmp', 'browser-mse-webm-video.webm');
        writeFileSync(file, Buffer.from(dump.base64, 'base64'));
        const info = probe(file);
        const v = (info.streams || []).find((s) => s.codec_type === 'video');
        const a = (info.streams || []).find((s) => s.codec_type === 'audio');
        console.log(`  ✓ WebM 画面产物 ffprobe：${v ? `${v.codec_name} ${v.width}x${v.height}` : '无画面轨'}`
          + `｜${a ? `${a.codec_name} ${a.sample_rate}Hz` : '无音频轨'}`
          + `｜${Number(info.format.duration).toFixed(2)} 秒`);
        if (!v || v.codec_name !== 'vp9') { console.error('  ✗ 产物里的画面轨应该是 vp9'); problems += 1; }
        if (!a || a.codec_name !== 'opus') { console.error('  ✗ 产物里的音频轨应该是 opus（没转码）'); problems += 1; }
        try {
          const frames = countDecodedVideoFrames(file);
          const stats = audioStats(file, { rate: 48000, seconds: 5 });
          console.log(`    · 真解一遍：${frames} 帧画面｜音频 RMS ${stats.rms}｜峰值 ${stats.peak}｜估频 ${stats.hz} Hz`);
          if (frames < 140) { console.error(`  ✗ 解出来的帧太少：${frames}`); problems += 1; }
          if (!(stats.rms > 0.01)) { console.error('  ✗ 音频是静音'); problems += 1; }
          if (Math.abs(stats.hz - 440) > 12) { console.error(`  ✗ 音频估频不对（应约 440 Hz，实际 ${stats.hz}）`); problems += 1; }
        } catch (err) {
          console.error(`  ✗ 解码验证失败：${err.message}`);
          problems += 1;
        }

        // ---- 这一条专门盯"产物索引真的写进去了" ----
        //
        // 索引以前由**离屏文档**写，而离屏文档里没有 chrome.storage（实测只有
        // chrome.runtime）—— 调用不报错、索引却一条都没写进去。MP4 看不出来
        // （管理页会回退去读文件头），WebM 读不出头，于是永远显示"时长未记录"。
        // 所以这里查两件事：索引条目（含体积）在不在、管理页那一行有没有时长。
        const idx = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
          const got = await chrome.storage.local.get('vh:media-index');
          const entry = (got['vh:media-index'] || {})[${JSON.stringify(stopped.fileName)}] || null;
          return JSON.stringify(entry);
        })()`));
        console.log(`    · 索引里这一份：${idx ? `时长 ${idx.seconds}｜体积 ${idx.size}` : '（没有条目 ✗）'}`);
        if (!idx || !(Number(idx.seconds) > 0) || !(Number(idx.size) > 0)) {
          console.error('  ✗ 产物索引应该由 SW 写进去（含时长和体积）—— WebM 没有回退可读，靠的就是它');
          problems += 1;
        }

        // 用户看到的那一行：WebM 产物的时长必须显示出来（没有回退路径）
        const rowTarget = await cdp.send('Target.createTarget', {
          url: `chrome-extension://${extId}/src/recorder/recorder.html`,
        });
        const rowAtt = await cdp.send('Target.attachToTarget', { targetId: rowTarget.result.targetId, flatten: true });
        const rowSession = rowAtt.result?.sessionId;
        await cdp.send('Runtime.enable', {}, rowSession);
        await sleep(2500);
        const rowText = await evalIn(cdp, rowSession, `(() => {
          const rows = [...document.getElementById('captures').children];
          const row = rows.find((r) => r.textContent.includes(${JSON.stringify(stopped.fileName)}));
          return row ? row.textContent : '（列表里没找到这一行）';
        })()`);
        console.log(`    · 管理页那一行：${rowText.trim().slice(0, 96)}`);
        if (!/时长\s*\d+:?\d*/.test(rowText)) {
          console.error('  ✗ WebM 产物的时长应该在列表里显示出来（它没有 mvhd，只能靠索引）');
          problems += 1;
        }
        await cdp.send('Target.closeTarget', { targetId: rowTarget.result.targetId });
      }
    }

    await cdp.send('Target.closeTarget', { targetId: wvTarget });
  } catch (err) {
    console.error(`  ✗ WebM 画面用例失败：${err.message}`);
    problems += 1;
  }

  /* ---- 8g. 自动保存已录到的部分：到点会存，而且**只留最新一份** ----
   *
   * 用户提的需求（"这里也可以加一个自动保存已录制的部分勾选按钮"）。
   * 两个关键点都必须验到：
   *   1. 到点真的会自动写一份（不用用户点）；
   *   2. 它**滚动覆盖** —— 第二次写完之后，第一份被删掉，
   *      列表里始终只有一个 `-自动部分` 文件（否则体积会成倍涨）。
   *
   * 间隔在界面上只给 5/10/30 分钟，但设置值本身放宽到 0.05 分钟（3 秒），
   * 就是为了让这条用例能在几秒内验完 —— 一个验不了的功能等于没有。
   */
  try {
    // `?slow=1`：测试页一段一段慢慢喂，模拟"数据一直在进来"。
    // 不这样的话整段数据一次性 append 完，第二 tick 会因为"内容没变"被跳过 ——
    // 那本身是对的，但滚动覆盖那条路就验不到了。
    const pageUrl = `${origin}/__page/mse?slow=1&slowMs=900`;

    // 先把间隔调到 3 秒（模拟"用户把间隔改小"），再开抓流：
    // 离屏文档在挂定时器时读一次设置，所以这个值必须**先**写好。
    await evalIn(cdp, control.sessionId, `(async () => {
      const got = await chrome.storage.local.get('vh:settings');
      const next = { ...(got['vh:settings'] || {}), autoSnapshotCapture: true, autoSnapshotMinutes: 0.05 };
      await chrome.storage.local.set({ 'vh:settings': next });
      return 'ok';
    })()`);

    const created = await cdp.send('Target.createTarget', { url: pageUrl });
    const autoTarget = created.result?.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId: autoTarget, flatten: true });
    const autoSession = attached.result?.sessionId;
    await cdp.send('Runtime.enable', {}, autoSession);
    await cdp.send('Page.enable', {}, autoSession);
    await sleep(2500);

    const tabId = await evalIn(cdp, control.sessionId, `(async () => {
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl)} });
      return tabs.length ? tabs[0].id : null;
    })()`);

    const started = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
      const r = await chrome.runtime.sendMessage({ type: 'vh:mse-start', tabId: ${tabId} });
      return JSON.stringify(r || {});
    })()`, { timeout: 30000 }));

    if (!started.ok) {
      console.error(`  ✗ 自动保存用例里抓流启动失败：${started.error}`);
      problems += 1;
    } else {
      await evalIn(cdp, control.sessionId, `chrome.tabs.reload(${tabId}).then(() => 'ok')`);

      // 等到第一份自动保存出现（3 秒一次，留足余量），并盯着名字变没变
      const seen = [];
      let maxAtOnce = 0;
      for (let i = 0; i < 14 && seen.length < 2; i += 1) {
        await sleep(1500);
        const list = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
          const root = await navigator.storage.getDirectory();
          const names = [];
          for await (const [name, handle] of root.entries()) {
            if (handle.kind === 'file' && /-自动部分\\.(mp4|webm)$/.test(name)) names.push(name);
          }
          return JSON.stringify(names);
        })()`, { timeout: 30000 }));
        maxAtOnce = Math.max(maxAtOnce, list.length);
        // 记下"最新那一份"的名字：滚动覆盖时名字会变
        const newest = list.sort().pop();
        if (newest && !seen.includes(newest)) seen.push(newest);
      }

      if (!seen.length) {
        console.error('  ✗ 到了间隔时间也没有自动保存');
        problems += 1;
      } else {
        console.log(`  ✓ 自动保存已触发：${seen[0]}`);
      }
      if (seen.length >= 2) {
        console.log(`  ✓ 到点又存了一份、并把上一份覆盖掉：${seen[0]} → ${seen[1]}`);
      } else {
        console.error('  ✗ 一直在收新数据，却只存了一份（滚动覆盖没生效？）');
        problems += 1;
      }
      // ⚠️ 不能拿"某一瞬间有两份"当失败：先写新的、再删旧的**是故意的**
      // （反过来一旦写失败就什么都不剩），中间有几十毫秒的重叠。
      // 要判的是**静下来之后**只剩一份。
      if (maxAtOnce > 1) {
        console.log(`    · 过程中最多同时见到 ${maxAtOnce} 份（先写后删的短暂重叠，正常）`);
      }

      // 收尾：完整产物写出来之后，滚动保存那份应该被删掉（内容是它的子集）
      const stopped = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
        const r = await chrome.runtime.sendMessage({ type: 'vh:mse-stop' });
        return JSON.stringify(r || {});
      })()`, { timeout: 120000 }));      if (!stopped.ok) {
        console.error(`  ✗ 自动保存用例收尾失败：${stopped.error}`);
        problems += 1;
      } else {
        const after = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
          const root = await navigator.storage.getDirectory();
          const names = [];
          for await (const [name] of root.entries()) names.push(name);
          return JSON.stringify({
            auto: names.filter((n) => /-自动部分\\.(mp4|webm)$/.test(n)),
            final: names.filter((n) => n === ${JSON.stringify(stopped.fileName)}),
          });
        })()`, { timeout: 30000 }));
        console.log(`  · 收尾之后：完整产物 ${after.final.length} 份｜剩下的自动保存 ${after.auto.length} 份`);
        if (!after.final.length) {
          console.error('  ✗ 收尾的完整产物没落盘');
          problems += 1;
        }
        if (after.auto.length) {
          console.error(`  ✗ 有完整产物之后，滚动保存那份该删掉：${after.auto.join('、')}`);
          problems += 1;
        }
      }
    }

    // 把间隔改回默认，别影响后面的用例
    await evalIn(cdp, control.sessionId, `(async () => {
      const got = await chrome.storage.local.get('vh:settings');
      const next = { ...(got['vh:settings'] || {}), autoSnapshotMinutes: 10 };
      await chrome.storage.local.set({ 'vh:settings': next });
      return 'ok';
    })()`);
    await cdp.send('Target.closeTarget', { targetId: autoTarget });
  } catch (err) {
    console.error(`  ✗ 自动保存用例失败：${err.message}`);
    problems += 1;
  }

  /* ---- 抓流攒太大自动切段：长抓流不再"录了两小时最后全丢" ----
   *
   * 为什么必须验：抓流的数据全在内存里、收尾合并还要一整块（实测抓到的超过 ~1 GB
   * 就合不出来，那时只能丢）。到阈值先写出一段**完整文件**、清空缓冲接着抓，
   * 是这个问题的正解 —— 但它"自动"做了一件用户看得见的事（一个视频变两个文件），
   * 所以既要验它真的切了、切出来的文件是好的，也要验它**说清楚了**。
   *
   * 阈值在这里调到 0.05 MB：走的是真实设置通道（service worker 读设置 → 传给离屏文档）。
   */
  let cutTarget = null;
  // 这两个"用完要关"的 target 都在 try 里创建、在 finally 里关：
  // 声明必须放外面，否则 finally 里是 ReferenceError（第一版就踩了）
  let recTarget = null;
  try {
    await evalIn(cdp, control.sessionId, `(async () => {
      const got = await chrome.storage.local.get('vh:settings');
      const next = { ...(got['vh:settings'] || {}), autoCutCapture: true, autoCutMb: 0.05 };
      await chrome.storage.local.set({ 'vh:settings': next });
      return 'ok';
    })()`);

    // ⚠️ 这个用例**自己开一个测试页**：它不在第 8 节那个 try 里，
    // 既拿不到 `mseTabId` 那个变量（第一版照抄了变量名 → ReferenceError），
    // 也不能假设第 8 节的标签页还开着（跑到这里时它已经关了 → "找不到标签页"）。
    const pageUrl = `${origin}/__page/mse`;
    const created = await cdp.send('Target.createTarget', { url: pageUrl });
    cutTarget = created.result?.targetId;
    await sleep(1800);
    const tabId = await evalIn(cdp, control.sessionId, `(async () => {
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl)} });
      return tabs.length ? tabs[0].id : null;
    })()`);
    if (!Number.isInteger(tabId)) throw new Error('找不到 MSE 测试页的标签页');

    // 管理页要**在场**才能看到"抓流进行中"的告知（那条提示是推过去的、只显示一次）。
    // 第一版是等抓完才开管理页 —— 那时提示早被"抓流完成"覆盖了，用例自然红。
    const recOpen = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extId}/src/recorder/recorder.html`,
    });
    recTarget = recOpen.result?.targetId;
    const recAtt = await cdp.send('Target.attachToTarget', { targetId: recTarget, flatten: true });
    const recSession = recAtt.result?.sessionId;
    await cdp.send('Runtime.enable', {}, recSession);
    await sleep(2000);

    // ① 开抓流 + 喂两片（超过 0.05 MB 的阈值），然后等心跳把它切掉
    const started = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
      const toB64 = (u8) => {
        let s = '';
        const CH = 0x8000;
        for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
        return btoa(s);
      };
      const load = async (p) => new Uint8Array(await (await fetch(${JSON.stringify(origin)} + p)).arrayBuffer());
      const init = await load('/dash-split/init-stream0.m4s');
      const c1 = await load('/dash-split/chunk-stream0-00001.m4s');
      const r = await chrome.runtime.sendMessage({ type: 'vh:mse-start', tabId: ${tabId} });
      if (!r.ok) return JSON.stringify({ ok: false, error: r.error });
      await chrome.runtime.sendMessage({
        type: 'vh:mse-buffer', seq: 0, mime: 'video/mp4; codecs="avc1.64001e"', base64: toB64(init),
      });
      await chrome.runtime.sendMessage({ type: 'vh:mse-buffer', seq: 1, mime: 'video/mp4', base64: toB64(c1) });
      return JSON.stringify({ ok: true });
    })()`, { timeout: 60000 }));
    if (!started.ok) throw new Error(`抓流启动失败：${started.error}`);
    // 心跳一秒一次，切段是在心跳里判的：等两拍
    await sleep(2800);

    // ② 管理页上应该已经写出"切了一段"（提示条 + 日志）
    const recSeen = JSON.parse(await evalIn(cdp, recSession, `JSON.stringify({
      notice: document.getElementById('notice').textContent,
      log: document.getElementById('log').textContent.slice(-500),
    })`, { timeout: 20000 }));
    console.log(`  · 管理页上的那一句：「${String(recSeen.notice).replace(/\\s+/g, ' ').slice(0, 76)}」`);

    // ③ 状态 + OPFS：切了几次、切出来的那份在不在、抓流是否还在跑
    const cut = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
      const toB64 = (u8) => {
        let s = '';
        const CH = 0x8000;
        for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
        return btoa(s);
      };
      const load = async (p) => new Uint8Array(await (await fetch(${JSON.stringify(origin)} + p)).arrayBuffer());
      const c2 = await load('/dash-split/chunk-stream0-00002.m4s');

      const mid = await chrome.runtime.sendMessage({ type: 'vh:offscreen-status' });
      const state = await chrome.runtime.sendMessage({ type: 'vh:record-state' });

      // 换集之后再点一次「抓流」：**必须在抓流还活着的时候点**（第一次我放在 stop 之后，
      // 那时会话已经结束，点下去当然会正常开一个新的 —— 用例自己制造了假象）。
      const again = await chrome.runtime.sendMessage({ type: 'vh:mse-start', tabId: ${tabId} });
      const afterAgain = await chrome.runtime.sendMessage({ type: 'vh:offscreen-status' });

      // 切出来的那一份应该已经躺在 OPFS 里了
      const root = await navigator.storage.getDirectory();
      const names = [];
      for await (const [name] of root.entries()) names.push(name);

      // 接着往下抓，再停一次：最终产物也必须是好的
      await chrome.runtime.sendMessage({ type: 'vh:mse-buffer', seq: 2, mime: 'video/mp4', base64: toB64(c2) });
      const stopped = await chrome.runtime.sendMessage({ type: 'vh:mse-stop' });
      let finalB64 = '';
      if (stopped?.ok) {
        const fh = await root.getFileHandle(stopped.fileName);
        finalB64 = toB64(new Uint8Array(await (await fh.getFile()).arrayBuffer()));
      }
      return JSON.stringify({
        mid: mid?.stats || {}, state: state?.state || {}, names,
        stopped: stopped || {}, finalB64,
        again: again || {}, afterAgain: afterAgain?.stats ? afterAgain : {},
      });
    })()`, { timeout: 120000 }));

    const notice = String(cut.state?.captureNotice || '');
    console.log(`  · 阈值 0.05 MB：切了 ${cut.mid.sizeCuts} 次｜之后缓冲 ${cut.mid.chunks} 段 / `
      + `${cut.mid.bytes} B｜抓流还在跑=${cut.mid.awaitingRetry === false}`);
    console.log(`    提示：「${notice.slice(0, 80)}」`);

    // ---- 换集之后再点一次「抓流」：不能把正在抓的那一段弄没 ----
    //
    // 用户描述的工作流就是「到第二段的时候，我重新开始抓流」。
    // 点下去的正确结果是：一句"还在进行中、不用再点"（并且说清已经存好第几段），
    // **而正在进行的这次抓流必须活着**（第一版这里会把离屏文档关掉 ——
    // 那等于把用户正在抓的第二集连同缓冲一起销毁）。
    console.log(`  · 换集之后再点一次「抓流」：ok=${cut.again.ok}｜`
      + `alreadyCapturing=${cut.again.alreadyCapturing}｜「${String(cut.again.error).slice(0, 56)}」`);
    if (cut.again.ok) {
      console.error('  ✗ 已经在抓流时再点一次，不该又开一个新会话（会把两段数据混在一起）');
      problems += 1;
    } else if (!cut.again.alreadyCapturing || !/已经存好 1 段/.test(String(cut.again.error))) {
      console.error(`  ✗ 这句得说清"不用再点"和"已经存好第几段"，实际：${JSON.stringify(cut.again.error)}`);
      problems += 1;
    } else if (!(cut.afterAgain?.stats?.parts >= 1)) {
      // 判据是"这次会话还记得切过 1 段"：刚切完缓冲本来就是 0 字节，
      // 拿 bytes > 0 当判据是错的（第一次就是这么写的）。
      // 而一个**新开的**会话 parts 会是 0 —— 那才说明原来那段被抓没了。
      console.error(`  ✗ 再点一次「抓流」把正在进行的抓流弄没了（新会话的 parts=${cut.afterAgain?.stats?.parts}，`
        + '原来的那段记录没了）—— 用户会以为没事，其实丢了');
      problems += 1;
    } else {
      console.log('  ✓ 再点一次「抓流」：只说"不用再点"，正在进行的这一段没被弄没');
    }
    // 管理页上那句话：与状态里的必须是同一句（用户看的是页面，不是字段）
    if (!/先存下一段完整文件/.test(recSeen.notice) || !/先存下一段完整文件/.test(recSeen.log)) {
      console.error('  ✗ 自动切段只写进了状态、没在管理页上显示出来'
        + `（用户就不知道文件为什么多了一个）：notice=${JSON.stringify(recSeen.notice.slice(0, 60))}`);
      problems += 1;
    }
    if (!(cut.mid.sizeCuts >= 1)) {
      console.error('  ✗ 攒到阈值了却没自动切段 —— 长抓流最后还是会因为合并吃不下内存而全丢');
      problems += 1;
    } else if (!/先存下一段完整文件/.test(notice) || !/按文件名顺序/.test(notice)) {
      console.error(`  ✗ 自动切段必须当场说清"切了、切成哪了、怎么用"，实际提示：${JSON.stringify(notice)}`);
      problems += 1;
    } else {
      // 切出来的那一份必须是**能播的完整 MP4**（不是半截字节）
      const cutFile = (cut.names || []).find((n) => /vh-mse-.*\.mp4$/.test(n) && n.includes('-'))
        || (cut.names || []).find((n) => /vh-mse-.*\.mp4$/.test(n));
      const named = String(notice).match(/（(vh-mse-[^）]+)）/);
      const target = named ? named[1] : cutFile;
      if (!target) {
        console.error(`  ✗ 切段的文件没在 OPFS 里找到：${JSON.stringify(cut.names)}`);
        problems += 1;
      } else {
        mkdirSync(join(ROOT, '.tmp'), { recursive: true });
        const got = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
          const root = await navigator.storage.getDirectory();
          const fh = await root.getFileHandle(${JSON.stringify(target)});
          const bytes = new Uint8Array(await (await fh.getFile()).arrayBuffer());
          let bin = '';
          const CH = 0x8000;
          for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
          return JSON.stringify({ base64: btoa(bin) });
        })()`, { timeout: 30000 }));
        const file = join(ROOT, '.tmp', 'browser-autocut.mp4');
        writeFileSync(file, Buffer.from(got.base64, 'base64'));
        try {
          const info = probe(file);
          const v = (info.streams || []).find((s) => s.codec_type === 'video');
          const dur = Number(info.format.duration);
          console.log(`    切出来的那一份：${target}｜ffprobe：${v?.codec_name}｜${dur.toFixed(2)} 秒｜${v?.nb_frames} 帧`);
          if (!v || !(dur > 1)) {
            console.error(`  ✗ 自动切出来的那一份不是能播的完整 MP4：${dur} 秒`);
            problems += 1;
          }
        } catch (err) {
          console.error(`  ✗ 自动切出来的那一份 ffprobe 失败：${err.message}`);
          problems += 1;
        }
      }
      // 最终（停止时的）产物也必须是好的，而且状态里要如实报出"切过几段"
      if (!cut.stopped?.ok) {
        console.error(`  ✗ 自动切段之后收尾失败：${cut.stopped?.error}`);
        problems += 1;
      } else if (cut.state?.sizeCuts !== undefined && !(Number(cut.stopped.sizeCuts ?? cut.mid.sizeCuts) >= 1)) {
        console.error('  ✗ 收尾回执里没说切过段（用户就不知道多出来的文件是哪来的）');
        problems += 1;
      } else {
        console.log(`  ✓ 自动切段：切出来的那一份是完整 MP4，切完继续抓、最后还能正常收尾`);
      }
      if (cut.finalB64) {
        const file = join(ROOT, '.tmp', 'browser-autocut-final.mp4');
        writeFileSync(file, Buffer.from(cut.finalB64, 'base64'));
        try {
          const info = probe(file);
          const dur = Number(info.format.duration);
          console.log(`    最终产物：${dur.toFixed(2)} 秒（切段之后的这一段）`);
          if (!(dur > 1)) {
            console.error(`  ✗ 切段之后的最终产物时长不对：${dur}`);
            problems += 1;
          }
        } catch (err) {
          console.error(`  ✗ 最终产物 ffprobe 失败：${err.message}`);
          problems += 1;
        }
      }
    }

    // 阈值改回默认：后面的用例还要用小数据量喂抓流，别被这个 0.05 MB 提前切了
  } catch (err) {
    console.error(`  ✗ 自动切段用例失败：${err.message}`);
    problems += 1;
  } finally {
    // ⚠️ 恢复写在 finally 里：第一版放在 try 末尾，结果中间一抛错，
    // "阈值 0.05 MB"就留在设置里了 —— 后面每个抓流用例的数据都被提前切走，
    // 连着报了好几个看着毫不相关的错（"没有捕获到任何数据"）。
    // 一个用例改全局设置，就必须无论如何都还回去。
    await evalIn(cdp, control.sessionId, `(async () => {
      const got = await chrome.storage.local.get('vh:settings');
      const next = { ...(got['vh:settings'] || {}), autoCutMb: 600 };
      await chrome.storage.local.set({ 'vh:settings': next });
      return 'ok';
    })()`).catch(() => {});
    await cdp.send('Target.closeTarget', { targetId: cutTarget }).catch(() => {});
    if (recTarget) await cdp.send('Target.closeTarget', { targetId: recTarget }).catch(() => {});
  }

  /* ---- 自动保存按「视频内容时长」算 + 产物自动导出到下载目录 ----
   *
   * 两件都是用户提的：
   *   ① 「每 10 分钟」到底按什么算？他用倍速插件播，物理 10 分钟 ≠ 内容 10 分钟。
   *      这一档必须能按**内容时长**算 —— 而内容时长只能从分片自己的 tfdt 推出来。
   *   ② 「抓完自动落到下载目录」：完整产物进了「抓流文件」之后自动下载一份，
   *      **同时保留**私有存储里那份和「保存到磁盘」按钮（本地误删还能再导）。
   *
   * 怎么验 ①：间隔设成 3 秒、口径设成"内容"，然后**飞快喂 4 秒的内容** ——
   * 挂钟才过了几百毫秒，如果按挂钟就绝不会触发；按内容就该存一份。
   * 怎么验 ②：收尾之后去浏览器下载记录里找那个文件，并真的 ffprobe 它，
   * 同时确认 OPFS 里那份**还在**（用户的明确要求）。
   */
  let mediaTarget = null;
  // 收摊要用它（删掉本用例下载到本地的那个文件）—— 声明必须在 try 外面
  let run = null;
  try {
    await evalIn(cdp, control.sessionId, `(async () => {
      const got = await chrome.storage.local.get('vh:settings');
      const next = {
        ...(got['vh:settings'] || {}),
        autoSnapshotCapture: true,
        autoSnapshotMinutes: 0.15,      // 9 秒 —— 故意比"喂数据花的挂钟时间"长得多
        autoSnapshotBasis: 'media',     // 按**视频内容**算
        autoExportCapture: true,
        downloadSubdir: 'VideoHunterAutoTest',
        autoCutMb: 600,
      };
      await chrome.storage.local.set({ 'vh:settings': next });
      return 'ok';
    })()`);

    const pageUrl = `${origin}/__page/mse`;
    const created = await cdp.send('Target.createTarget', { url: pageUrl });
    mediaTarget = created.result?.targetId;
    await sleep(1800);
    const tabId = await evalIn(cdp, control.sessionId, `(async () => {
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl)} });
      return tabs.length ? tabs[0].id : null;
    })()`);
    if (!Number.isInteger(tabId)) throw new Error('找不到 MSE 测试页的标签页');

    run = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
      const toB64 = (u8) => {
        let s = '';
        const CH = 0x8000;
        for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
        return btoa(s);
      };
      const load = async (p) => new Uint8Array(await (await fetch(${JSON.stringify(origin)} + p)).arrayBuffer());
      const init = await load('/dash-split/init-stream0.m4s');
      const frags = [];
      for (const n of ['00001', '00002', '00003', '00004', '00005', '00006']) {
        frags.push(await load('/dash-split/chunk-stream0-' + n + '.m4s'));
      }

      const started = await chrome.runtime.sendMessage({ type: 'vh:mse-start', tabId: ${tabId} });
      if (!started.ok) return JSON.stringify({ ok: false, error: started.error });
      // 飞快喂到"内容 12 秒"（挂钟才几百毫秒）——间隔设的是 9 秒，
      // 按挂钟绝不可能触发，按内容就该触发
      await chrome.runtime.sendMessage({ type: 'vh:mse-buffer', seq: 0, mime: 'video/mp4; codecs="avc1.64001e"', base64: toB64(init) });
      for (const [i, c] of frags.entries()) {
        await chrome.runtime.sendMessage({ type: 'vh:mse-buffer', seq: i + 1, mime: 'video/mp4', base64: toB64(c) });
      }
      // 等两拍心跳（自动保存是每秒判一次）
      await new Promise((r) => setTimeout(r, 2600));
      const mid = await chrome.runtime.sendMessage({ type: 'vh:offscreen-status' });

      // 收尾 → 完整产物 → 开了自动导出就该落到下载目录
      const stopped = await chrome.runtime.sendMessage({ type: 'vh:mse-stop' });
      // 等自动导出写完（下载是异步的，收尾回执不等它）
      let download = null;
      for (let i = 0; i < 20 && !download; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        const found = await chrome.downloads.search({ query: [stopped?.fileName || ''] });
        const done = found.find((d) => d.state === 'complete');
        if (done) download = { filename: done.filename, bytes: done.fileSize || done.totalBytes };
      }
      // OPFS 里那份必须还在（用户要求：自动导出后仍然保留，误删了能再导一次）
      const root = await navigator.storage.getDirectory();
      const names = [];
      for await (const [name] of root.entries()) names.push(name);
      // 索引是**按文件名作键的对象**（不是数组 —— 第一版按数组找，怎么都找不到）
      const index = (await chrome.storage.local.get('vh:media-index'))['vh:media-index'] || {};
      const entry = index[stopped?.fileName] || null;
      return JSON.stringify({
        mid: mid?.stats || {},
        stopped: stopped || {},
        download,
        opfsHas: names.includes(stopped?.fileName),
        indexExported: !!entry?.exportedAt,
      });
    })()`, { timeout: 180000 }));

    console.log(`  · 口径=视频内容（间隔 9 秒）：挂钟只过了 ${run.mid.elapsedSeconds} 秒，`
      + `内容已有 ${run.mid.mediaSpanSeconds} 秒 → 自动保存的那份 ${run.mid.autoSnapshot || '（没出现）'}`);
    if (!run.mid.autoSnapshot) {
      console.error('  ✗ 按"视频内容时长"设置的自动保存没触发 —— 倍速播放时用户要的就是这一档'
        + `（挂钟 ${run.mid.elapsedSeconds}s / 内容 ${run.mid.mediaSpanSeconds}s，阈值 9s）`);
      problems += 1;
    } else if (!(run.mid.mediaSpanSeconds >= 9)) {
      console.error(`  ✗ 内容时长没量对：${run.mid.mediaSpanSeconds} 秒（应该 ≥ 9）`);
      problems += 1;
    } else if (!(run.mid.elapsedSeconds < 9)) {
      console.error(`  ✗ 这个用例本该证明"内容到了但挂钟没到"，实际挂钟 ${run.mid.elapsedSeconds} 秒`);
      problems += 1;
    } else {
      console.log('  ✓ 「按视频内容时长自动保存」真的按内容算（挂钟远没到点也存了）');
    }

    if (!run.stopped?.ok) {
      console.error(`  ✗ 这一轮抓流收尾失败：${run.stopped?.error}`);
      problems += 1;
    } else if (!run.download) {
      console.error('  ✗ 开了"产物自动导出到下载目录"，下载记录里却没找到 —— 用户点的就是这件事');
      problems += 1;
    } else {
      console.log(`  · 自动导出：${run.download.filename}（${formatBytes(run.download.bytes)}）`);
      try {
        const info = probe(run.download.filename);
        const v = (info.streams || []).find((s) => s.codec_type === 'video');
        console.log(`    下载到本地的这份 ffprobe：${v?.codec_name}｜${Number(info.format.duration).toFixed(2)} 秒`);
        if (!v) { console.error('  ✗ 自动导出的文件不是能播的视频'); problems += 1; }
      } catch (err) {
        console.error(`  ✗ 自动导出的文件 ffprobe 失败：${err.message}`);
        problems += 1;
      }
      if (!run.opfsHas) {
        console.error('  ✗ 自动导出之后私有存储里那份**不该删**（用户误删本地文件后还要能再导一次）');
        problems += 1;
      } else if (!run.indexExported) {
        console.error('  ✗ 自动导出没记进索引 ——「清理已导出的」就不敢清这一份');
        problems += 1;
      } else {
        console.log('  ✓ 自动导出：本地产物能播、私有存储那份还在、索引记了"已导出"');
      }
    }
  } catch (err) {
    console.error(`  ✗ 自动保存口径 / 自动导出用例失败：${err.message}`);
    problems += 1;
  } finally {
    // ⚠️ 收摊：这个用例自己造了产物 + 下载 + 索引条目，**必须全清掉**：
    //   · 不清索引/文件 → 后面 9d 那条「清理已导出的 1 个」会数到 4（我踩过）；
    //   · 不清下载 → 用户的下载目录里攒一堆测试文件（更不该）。
    await evalIn(cdp, control.sessionId, `(async () => {
      const root = await navigator.storage.getDirectory();
      const names = [];
      for await (const [name] of root.entries()) names.push(name);
      const mine = names.filter((n) => /-自动部分\\.(mp4|webm)$/.test(n) || /视频|MSE/.test(n));
      for (const n of mine) { try { await root.removeEntry(n); } catch { /* 已经不在了 */ } }
      const key = 'vh:media-index';
      const index = (await chrome.storage.local.get(key))[key] || {};
      for (const n of mine) delete index[n];
      await chrome.storage.local.set({ [key]: index });
      // 下载记录和历史也清掉（文件本身由 Node 那边删）
      const found = await chrome.downloads.search({});
      for (const d of found) {
        if (String(d.filename).includes('VideoHunterAutoTest')) await chrome.downloads.erase({ id: d.id });
      }
      return 'ok';
    })()`).catch(() => {});
    for (const f of [run?.download?.filename].filter(Boolean)) {
      try { unlinkSync(f); } catch { /* 已经不在了 */ }
    }
    try {
      const dir = join(homedir(), 'Downloads', 'VideoHunterAutoTest');
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    } catch { /* 目录可能还有别的东西，留着 */ }
    // 设置改回默认（尤其是下载目录 —— 不能把后面用例的东西丢到测试目录里）
    await evalIn(cdp, control.sessionId, `(async () => {
      const got = await chrome.storage.local.get('vh:settings');
      const next = {
        ...(got['vh:settings'] || {}),
        autoSnapshotMinutes: 5,
        autoSnapshotBasis: 'wall',
        autoExportCapture: true,
        downloadSubdir: 'VideoHunter',
      };
      await chrome.storage.local.set({ 'vh:settings': next });
      return 'ok';
    })()`).catch(() => {});
    if (mediaTarget) await cdp.send('Target.closeTarget', { targetId: mediaTarget }).catch(() => {});
  }

  /* ---- 8b-4. 「攒太大自动切一段」那条路也必须自动导出 ----
   *
   * 这一条有明确的来历：自动切段是**离屏文档自己发起**的（体积到阈值是它每秒
   * 在算），没有"请求-响应"这条路可借，于是它把导出句柄塞进状态推给 service
   * worker —— 而 service worker 一开始**根本没人接**。后果不是报错，而是
   * "什么都没发生"：切出来的那一段永远不落到下载目录，界面上也看不出任何区别，
   * 用户以为文件在下载目录里，其实只在扩展私有存储里。
   *
   * 怎么验：开自动导出 + 阈值压到 0.05 MB → 喂到阈值 → 切段 → 去浏览器下载记录里
   * 找那一份（名字从切段提示里取），**并且**要求状态里出现"已导出"的提示 ——
   * 文件导出去了却没有提示，用户仍然不知道发生了什么。
   */
  let cutExport = null;
  let cutExportTarget = null;
  try {
    await evalIn(cdp, control.sessionId, `(async () => {
      const got = await chrome.storage.local.get('vh:settings');
      await chrome.storage.local.set({ 'vh:settings': { ...(got['vh:settings'] || {}),
        autoCutCapture: true, autoCutMb: 0.3,
        autoExportCapture: true, downloadSubdir: 'VideoHunterAutoTest',
        autoSnapshotCapture: false } });
      return 'ok';
    })()`);

    const pageUrl = `${origin}/__page/mse`;
    const created = await cdp.send('Target.createTarget', { url: pageUrl });
    cutExportTarget = created.result?.targetId;
    await sleep(1800);
    const tabId = await evalIn(cdp, control.sessionId, `(async () => {
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl)} });
      return tabs.length ? tabs[0].id : null;
    })()`);
    if (!Number.isInteger(tabId)) throw new Error('找不到 MSE 测试页的标签页');

    cutExport = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
      const toB64 = (u8) => {
        let s = '';
        const CH = 0x8000;
        for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
        return btoa(s);
      };
      const load = async (p) => new Uint8Array(await (await fetch(${JSON.stringify(origin)} + p)).arrayBuffer());
      // ⚠️ 这一轮**故意按真实站点的形态来喂**：mime 是空的，只有 sbId。
      // （mse-hook 的注释里写着这是实测存在的 —— 那条 SourceBuffer 的
      //  addSourceBuffer 没经过我们的补丁，于是每次 append 都报空 mime。）
      // 空 mime 会走 groupBuffers 的「按 sbId 分组」那条路，也正是用户那个 bug 的
      // 触发条件：分片那一组推不出大类，回退成 'video' 就会借错初始化段。
      const SB_V = 'v';
      const SB_A = 'a';
      const vInit = await load('/dash-split/init-stream0.m4s');
      const aInit = await load('/dash-split/init-stream1.m4s');
      const vFrags = [];
      const aFrags = [];
      for (const n of ['00001', '00002', '00003', '00004']) {
        vFrags.push(await load('/dash-split/chunk-stream0-' + n + '.m4s'));
        aFrags.push(await load('/dash-split/chunk-stream1-' + n + '.m4s'));
      }
      const send = (seq, sbId, bytes) => chrome.runtime.sendMessage({
        type: 'vh:mse-buffer', seq, mime: '', sbId, base64: toB64(bytes),
      });
      const state = async () => (await chrome.runtime.sendMessage({ type: 'vh:record-state' }))?.state || {};

      const started = await chrome.runtime.sendMessage({ type: 'vh:mse-start', tabId: ${tabId} });
      if (!started.ok) return JSON.stringify({ ok: false, error: started.error });

      // ① 第一段：两条轨的 init 都先送（真实播放器就是这样），再各送两片 ——
      //    阈值 0.3 MB，两片视频 + 两片音频约 370 KB 就超了，心跳一到自动切段。
      //    ⚠️ 阈值不能压得太低（0.05 MB 试过）：那样**第二段也会立刻被切走**，
      //    收尾时缓冲是空的，报到的是"没有捕获到任何数据"，反而验不到要看的东西。
      let seq = 0;
      await send(seq++, SB_V, vInit);
      await send(seq++, SB_A, aInit);
      await send(seq++, SB_V, vFrags[0]);
      await send(seq++, SB_A, aFrags[0]);
      await send(seq++, SB_V, vFrags[1]);
      await send(seq++, SB_A, aFrags[1]);

      // 状态里的 captureNotice 有**两条**：快到阈值时的预告（没有文件名）和真正
      // 切段那条（带文件名）—— 所以按"是不是切段那条"挑，别锁在预告上。
      let notice = null;
      let name = null;
      for (let i = 0; i < 20 && !name; i += 1) {
        await new Promise((r) => setTimeout(r, 400));
        const st = await state();
        if (st.captureNotice && /先存下一段完整文件/.test(st.captureNotice)) {
          notice = st.captureNotice;
          const m = String(notice).match(/（(vh-mse-[^）]+)）/);
          if (m) name = m[1];
        }
      }

      // ② 第二段 —— 用户报的"切完继续录的那一段"：**只送分片、不再送 init**，
      //    而且**故意只送一片视频 + 一片音频**（约 180 KB，低于 0.3 MB 的阈值），
      //    这样它不会被第二次切走，收尾时能原样拿来验"有没有声音"。
      //    真实播放器这时也不会重发 moov，所以这一段的初始化段只能靠"本次会话里
      //    先前收到的那一份"。**这一段有没有声音，就是这个用例要抓的东西。**
      await send(seq++, SB_V, vFrags[2]);
      await send(seq++, SB_A, aFrags[2]);
      await new Promise((r) => setTimeout(r, 800));

      // ③ 切段那条路的导出：句柄是离屏文档推过来的，SW 必须接住并说出来
      let exportNotice = null;
      let exportName = null;
      let download = null;
      for (let i = 0; i < 20; i += 1) {
        await new Promise((r) => setTimeout(r, 400));
        const st = await state();
        if (st.exportNotice) {
          exportNotice = st.exportNotice;
          const m = String(exportNotice).match(/已导出到下载目录：(.+?)\s*$/);
          if (m) exportName = m[1];
        }
        const target = name || exportName;
        if (target && !download) {
          const found = await chrome.downloads.search({ query: [target] });
          const done = found.find((d) => d.state === 'complete');
          if (done) download = { filename: done.filename, bytes: done.fileSize || done.totalBytes };
        }
        if (download && exportNotice) break;
      }

      // ④ 收尾 → 手上前这一段的产物就是"切段之后那一段"，读出来交给 Node 那边 ffprobe
      const stopped = await chrome.runtime.sendMessage({ type: 'vh:mse-stop' });
      let finalB64 = null;
      if (stopped?.fileName) {
        try {
          const root = await navigator.storage.getDirectory();
          const fh = await root.getFileHandle(stopped.fileName);
          const bytes = new Uint8Array(await (await fh.getFile()).arrayBuffer());
          let bin = '';
          const CH = 0x8000;
          for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
          finalB64 = btoa(bin);
        } catch { /* 读不出来就别读，断言那边会报出来 */ }
      }
      return JSON.stringify({
        notice, exportNotice, name, exportName, download,
        stoppedOk: stopped?.ok === true,
        stoppedError: stopped?.error || null,
        stoppedName: stopped?.fileName || null,
        stoppedWarnings: stopped?.warnings || [],
        stoppedDetail: stopped?.detail ?? null,
        finalB64,
      });
    })()`, { timeout: 180000 }));
  } catch (err) {
    console.error(`  ✗ 自动切段的自动导出用例失败：${err.message}`);
    problems += 1;
  } finally {
    // 收摊：产物、索引、下载记录、设置全清掉（和上一个用例同一套理由）
    await evalIn(cdp, control.sessionId, `(async () => {
      const root = await navigator.storage.getDirectory();
      const names = [];
      for await (const [name] of root.entries()) names.push(name);
      const mine = names.filter((n) => /视频|MSE/.test(n));
      for (const n of mine) { try { await root.removeEntry(n); } catch { /* 已经不在了 */ } }
      const key = 'vh:media-index';
      const index = (await chrome.storage.local.get(key))[key] || {};
      for (const n of mine) delete index[n];
      await chrome.storage.local.set({ [key]: index });
      const found = await chrome.downloads.search({});
      for (const d of found) {
        if (String(d.filename).includes('VideoHunterAutoTest')) await chrome.downloads.erase({ id: d.id });
      }
      const got = await chrome.storage.local.get('vh:settings');
      await chrome.storage.local.set({ 'vh:settings': { ...(got['vh:settings'] || {}),
        autoCutMb: 600, autoSnapshotCapture: true, downloadSubdir: 'VideoHunter' } });
      return 'ok';
    })()`).catch(() => {});
    for (const f of [cutExport?.download?.filename].filter(Boolean)) {
      try { unlinkSync(f); } catch { /* 已经不在了 */ }
    }
    // 下载对象没拿到时（判据失败那次），也按提示里的文件名去测试目录里清一遍 ——
    // 用例自己造的文件必须在用例里清干净，不能留给用户的下载目录
    for (const bare of [cutExport?.name, cutExport?.exportName].filter(Boolean)) {
      try { unlinkSync(join(homedir(), 'Downloads', 'VideoHunterAutoTest', String(bare))); } catch { /* 已经不在了 */ }
    }
    try {
      const dir = join(homedir(), 'Downloads', 'VideoHunterAutoTest');
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    } catch { /* 目录可能还有别的东西，留着 */ }
    if (cutExportTarget) await cdp.send('Target.closeTarget', { targetId: cutExportTarget }).catch(() => {});
  }

  if (cutExport && cutExport.ok !== false) {
    const cutName = cutExport.name || cutExport.exportName || '（没解析到名字）';
    console.log(`  · 自动切段那条路的导出：切出「${cutName}」｜`
      + `状态里的提示=「${String(cutExport.exportNotice || '（没有提示）').slice(0, 56)}」`);
    if (!cutExport.download) {
      console.error('  ✗ 自动切段切出来的那一份没落到下载目录 —— service worker 又漏接了那个句柄'
        + '（用户以为文件在下载目录里，实际只在扩展私有存储里）');
      problems += 1;
    } else if (!/已导出到下载目录/.test(String(cutExport.exportNotice))) {
      console.error('  ✗ 文件确实导出去了，但界面上没有任何提示（用户看不到"已导出"）：'
        + `${JSON.stringify(cutExport.exportNotice)}`);
      problems += 1;
    } else {
      console.log('  ✓ 自动切段那条路：产物落到了下载目录，而且界面上说了"已导出"');
    }

    // ---- 切段之后的那一段必须有声音（用户报的） ----
    //
    // 用户的原话：「到达 600 兆之后它会切片、自动保存、然后开始下一段录制 ——
    // 这个下一段录制它是没有声音的。」
    //
    // 机制很清楚：切段会把缓冲清空，而播放器**不会重发 moov**，所以下一段的所有
    // 分片都没有初始化段，只能靠"本次会话里先前收到的那一份"（`seenInit`）复用。
    // 复用不上 → 那一组直接被丢掉 → 产物只剩画面。以前这条用例只喂**视频轨**，
    // 所以怎么跑都发现不了。
    if (cutExport.stoppedOk && cutExport.finalB64) {
      mkdirSync(join(ROOT, '.tmp'), { recursive: true });
      const file = join(ROOT, '.tmp', 'browser-autocut-next.mp4');
      writeFileSync(file, Buffer.from(cutExport.finalB64, 'base64'));
      try {
        const info = probe(file);
        const v = (info.streams || []).find((s) => s.codec_type === 'video');
        const a = (info.streams || []).find((s) => s.codec_type === 'audio');
        console.log(`  · 切段之后那一段（${cutExport.stoppedName}）：`
          + `${v ? `${v.codec_name} ${v.width}x${v.height}` : '**没有视频轨**'}｜`
          + `${a ? `${a.codec_name} ${a.sample_rate}Hz` : '**没有音频轨**'}｜`
          + `${Number(info.format.duration).toFixed(2)} 秒`);
        if (!v) {
          console.error('  ✗ 切段之后那一段连视频轨都没有');
          problems += 1;
        } else if (!a) {
          console.error('  ✗ 切段之后的那一段**没有声音** —— 下一段只有分片、没有初始化段，'
            + '复用没生效，那一组被丢掉了');
          if (cutExport.stoppedWarnings?.length) {
            console.error(`    收尾回执里的提示：${cutExport.stoppedWarnings.join('；').slice(0, 240)}`);
          }
          if (cutExport.stoppedDetail) {
            console.error(`    收尾回执里的 detail：${JSON.stringify(cutExport.stoppedDetail).slice(0, 240)}`);
          }
          problems += 1;
        } else {
          console.log('  ✓ 切段之后那一段有画面也有声音（初始化段复用成功）');
        }
      } catch (err) {
        console.error(`  ✗ 切段之后那一段 ffprobe 失败：${err.message}`);
        problems += 1;
      }
    } else if (cutExport.ok !== false && !cutExport.stoppedOk) {
      console.error(`  ✗ 切段之后收尾失败 —— 没法验"切段之后那一段有没有声音"：`
        + `${cutExport.stoppedError || '（没有错误信息）'}`);
      if (cutExport.stoppedWarnings?.length) {
        console.error(`    回执里的提示：${cutExport.stoppedWarnings.join('；').slice(0, 240)}`);
      }
      problems += 1;
    }
  }

  /* ---- 8b-5. 切段之后那一段必须有声音（WebM/Opus 音频那一型） ----
   *
   * 用户第二次报的：「第二段视频依旧没有声音」—— 他那个站（YouTube 4K）的音频是
   * **WebM/Opus**，走的是"拆包 + Opus→AAC 转码"那条路，和 fMP4 完全是两条：
   * 切段清空缓冲后，**WebM 的头部（Tracks）也一起没了**，只剩裸 Cluster；
   * 而那条路原来**根本没有"借头部"的地方**（fMP4 那条有 seenInit，WebM 这条没有），
   * 于是整个音频组被静默丢掉 —— 第一段自带头部所以有声音，只有第二段出事。
   *
   * 怎么验：视频用 fMP4 分片、音频用真正的 WebM/Opus（从夹具拆出头部 + 裸 Cluster）。
   * ① 头部 + Cluster 都送 → 超过阈值 → 自动切段；
   * ② 第二段**只送裸 Cluster、不送头部** → 能不能借到头部、音轨还在不在，就看这一步。
   */
  let webmCut = null;
  let webmCutTarget = null;
  try {
    // 夹具里就有现成的"头部 + 裸 Cluster"（`make-fixtures` 按 MSE 的形态切好的）
    const webmHeaderB64 = readFileSync(
      join(ROOT, 'test', 'fixtures', 'webm-vp9', 'audio-init.webm'),
    ).toString('base64');
    const webmMediaB64 = readFileSync(
      join(ROOT, 'test', 'fixtures', 'webm-vp9', 'audio-clusters.webm'),
    ).toString('base64');

    await evalIn(cdp, control.sessionId, `(async () => {
      const got = await chrome.storage.local.get('vh:settings');
      await chrome.storage.local.set({ 'vh:settings': { ...(got['vh:settings'] || {}),
        autoCutCapture: true, autoCutMb: 0.5,
        autoExportCapture: false, autoSnapshotCapture: false } });
      return 'ok';
    })()`);

    const pageUrl = `${origin}/__page/mse`;
    const created = await cdp.send('Target.createTarget', { url: pageUrl });
    webmCutTarget = created.result?.targetId;
    await sleep(1800);
    const tabId = await evalIn(cdp, control.sessionId, `(async () => {
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl)} });
      return tabs.length ? tabs[0].id : null;
    })()`);
    if (!Number.isInteger(tabId)) throw new Error('找不到 MSE 测试页的标签页');

    webmCut = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
      const toB64 = (u8) => {
        let s = '';
        const CH = 0x8000;
        for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
        return btoa(s);
      };
      const load = async (p) => new Uint8Array(await (await fetch(${JSON.stringify(origin)} + p)).arrayBuffer());
      const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const vInit = await load('/dash-split/init-stream0.m4s');
      const vFrag1 = await load('/dash-split/chunk-stream0-00001.m4s');
      const vFrag2 = await load('/dash-split/chunk-stream0-00002.m4s');
      const vFrag3 = await load('/dash-split/chunk-stream0-00003.m4s');
      const webmHeader = b64ToBytes(${JSON.stringify(webmHeaderB64)});
      const webmMedia = b64ToBytes(${JSON.stringify(webmMediaB64)});
      const V = 'video/mp4; codecs="avc1.64001e"';
      const A = 'audio/webm; codecs="opus"';
      const send = (seq, mime, bytes) => chrome.runtime.sendMessage({
        type: 'vh:mse-buffer', seq, mime, base64: toB64(bytes),
      });
      const state = async () => (await chrome.runtime.sendMessage({ type: 'vh:record-state' }))?.state || {};

      const started = await chrome.runtime.sendMessage({ type: 'vh:mse-start', tabId: ${tabId} });
      if (!started.ok) return JSON.stringify({ ok: false, error: started.error });

      // ① 第一段：视频 init + 三片、音频**头部 + 裸 Cluster** —— 约 580 KB，超过 0.5 MB 阈值
      let seq = 0;
      await send(seq++, V, vInit);
      await send(seq++, A, webmHeader);
      await send(seq++, V, vFrag1);
      await send(seq++, A, webmMedia);
      await send(seq++, V, vFrag2);
      await send(seq++, V, vFrag3);

      let notice = null;
      let name = null;
      for (let i = 0; i < 20 && !name; i += 1) {
        await new Promise((r) => setTimeout(r, 400));
        const st = await state();
        if (st.captureNotice && /先存下一段完整文件/.test(st.captureNotice)) {
          notice = st.captureNotice;
          const m = String(notice).match(/（(vh-mse-[^）]+)）/);
          if (m) name = m[1];
        }
      }

      // ② 第二段：**只送裸 Cluster（没有 WebM 头部）**+ 一片视频 —— 约 244 KB，不超阈值，
      //    所以它会留在缓冲里，直到收尾
      await send(seq++, V, vFrag1);
      await send(seq++, A, webmMedia);
      await new Promise((r) => setTimeout(r, 800));

      const stopped = await chrome.runtime.sendMessage({ type: 'vh:mse-stop' });
      let finalB64 = null;
      if (stopped?.fileName) {
        try {
          const root = await navigator.storage.getDirectory();
          const fh = await root.getFileHandle(stopped.fileName);
          const bytes = new Uint8Array(await (await fh.getFile()).arrayBuffer());
          finalB64 = toB64(bytes);
        } catch { /* 读不出来就算了，断言那边会报 */ }
      }
      return JSON.stringify({
        notice, name,
        stoppedOk: stopped?.ok === true,
        stoppedError: stopped?.error || null,
        stoppedName: stopped?.fileName || null,
        stoppedWarnings: stopped?.warnings || [],
        finalB64,
      });
    })()`, { timeout: 180000 }));
  } catch (err) {
    console.error(`  ✗ WebM/Opus 音频的切段用例失败：${err.message}`);
    problems += 1;
  } finally {
    await evalIn(cdp, control.sessionId, `(async () => {
      const root = await navigator.storage.getDirectory();
      const names = [];
      for await (const [name] of root.entries()) names.push(name);
      const mine = names.filter((n) => /视频|MSE/.test(n));
      for (const n of mine) { try { await root.removeEntry(n); } catch { /* 已经不在了 */ } }
      const key = 'vh:media-index';
      const index = (await chrome.storage.local.get(key))[key] || {};
      for (const n of mine) delete index[n];
      await chrome.storage.local.set({ [key]: index });
      const got = await chrome.storage.local.get('vh:settings');
      await chrome.storage.local.set({ 'vh:settings': { ...(got['vh:settings'] || {}),
        autoCutMb: 600, autoSnapshotCapture: true, autoExportCapture: true } });
      return 'ok';
    })()`).catch(() => {});
    if (webmCutTarget) await cdp.send('Target.closeTarget', { targetId: webmCutTarget }).catch(() => {});
  }

  if (webmCut && webmCut.ok !== false) {
    console.log(`  · WebM/Opus 那一型：切段提示=「${String(webmCut.notice || '（没等到切段）').slice(0, 40)}」｜`
      + `第二段收尾=${webmCut.stoppedOk ? '成功' : `失败（${webmCut.stoppedError}）`}`);
    if (!webmCut.stoppedOk) {
      problems += 1;
    } else if (webmCut.finalB64) {
      mkdirSync(join(ROOT, '.tmp'), { recursive: true });
      const file = join(ROOT, '.tmp', 'browser-autocut-webm.mp4');
      writeFileSync(file, Buffer.from(webmCut.finalB64, 'base64'));
      try {
        const info = probe(file);
        const v = (info.streams || []).find((s) => s.codec_type === 'video');
        const a = (info.streams || []).find((s) => s.codec_type === 'audio');
        console.log(`  · 切段之后那一段（WebM/Opus 音频）：`
          + `${v ? `${v.codec_name} ${v.width}x${v.height}` : '**没有视频轨**'}｜`
          + `${a ? `${a.codec_name} ${a.sample_rate}Hz` : '**没有音频轨**'}｜`
          + `${Number(info.format.duration).toFixed(2)} 秒`);
        if (!a) {
          console.error('  ✗ WebM/Opus 音频那一型：切段之后那一段**没有声音** —— '
            + '头部丢了、又没有借回来的地方，整个音频组被丢掉');
          if (webmCut.stoppedWarnings?.length) {
            console.error(`    收尾回执里的提示：${webmCut.stoppedWarnings.join('；').slice(0, 240)}`);
          }
          problems += 1;
        } else {
          console.log('  ✓ WebM/Opus 音频那一型：切段之后那一段照样有声音');
        }
      } catch (err) {
        console.error(`  ✗ WebM/Opus 那一型的产物 ffprobe 失败：${err.message}`);
        problems += 1;
      }
    }
  }

  /* ---- 8c. 抓流 + WebM/Opus 音频：产物里必须有声音 ----
   *
   * 用户报的：「抓 YouTube 的视频可以抓到画面，但是抓不到声音。」
   *
   * 现场（`--site` 打出来的）：视频是 `video/mp4; codecs="av01…"`，
   * 音频是 `audio/webm; codecs="opus"` —— 合并器只认 fMP4，于是那 0.8 MB
   * 音频被静默跳过，产物只有画面。
   *
   * 这个用例把那个形态钉死：测试页开两条 SourceBuffer，音频那条是
   * `audio/webm; codecs="opus"`。抓完之后**必须**能从产物里读出一条音频轨，
   * 而且编码是 AAC（Opus 装不进普通播放器认的 MP4，所以是转到 AAC 再封的）。
   */
  try {
    const pageUrl = `${origin}/__page/mse-webm`;
    const created = await cdp.send('Target.createTarget', { url: pageUrl });
    const webmTarget = created.result?.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId: webmTarget, flatten: true });
    const webmSession = attached.result?.sessionId;
    await cdp.send('Runtime.enable', {}, webmSession);
    await cdp.send('Page.enable', {}, webmSession);
    await sleep(2500);

    const selfCheck = await evalIn(cdp, webmSession, `document.getElementById('status').textContent`);
    console.log(`  · WebM 音频测试页自检：${selfCheck}`);
    if (!selfCheck.includes('append 完成')) {
      console.error(`  ✗ WebM 音频测试页自己没跑通：${selfCheck}`);
      problems += 1;
    }

    const tabId = await evalIn(cdp, control.sessionId, `(async () => {
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl)} });
      return tabs.length ? tabs[0].id : null;
    })()`);

    if (tabId == null) {
      console.error('  ✗ 找不到 WebM 测试页的标签页');
      problems += 1;
    } else {
      const started = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
        const r = await chrome.runtime.sendMessage({ type: 'vh:mse-start', tabId: ${tabId} });
        return JSON.stringify(r || {});
      })()`, { timeout: 30000 }));
      if (!started.ok) {
        console.error(`  ✗ WebM 用例里抓流启动失败：${started.error}`);
        problems += 1;
      } else {
        // 刷新一次让钩子从头收数据（和用户点「抓流」之后的提示一致）
        await evalIn(cdp, control.sessionId, `chrome.tabs.reload(${tabId}).then(() => 'ok')`);
        await sleep(8000);

        const stats = JSON.parse(await evalIn(cdp, control.sessionId,
          `chrome.runtime.sendMessage({ type: 'vh:offscreen-status' }).then((r) => JSON.stringify(r || {}))`,
          { timeout: 20000 }));
        for (const t of stats.stats?.tracks || []) {
          console.log(`    - ${t.mime}｜${t.chunks} 段｜${(t.bytes / 1048576).toFixed(2)} MB`);
        }

        const stopped = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
          const r = await chrome.runtime.sendMessage({ type: 'vh:mse-stop' });
          return JSON.stringify(r || {});
        })()`, { timeout: 120000 }));

        if (!stopped.ok) {
          console.error(`  ✗ WebM 音频用例没能产出文件：${String(stopped.error).split('\n')[0]}`);
          problems += 1;
        } else {
          for (const g of stopped.detail?.groups || []) {
            console.log(`    · 抓到的一组：mime=${g.mime || `（无，${g.sbId || '未知编号'}）`}｜容器=${g.container}`
              + `｜${g.trackSummary || g.contentType || '?'}｜${(g.bytes / 1048576).toFixed(2)} MB`);
          }
          const tr = stopped.detail?.audioTranscode;
          console.log(`    · WebM 音频转码：${tr ? `Opus → AAC｜${tr.frames} 帧｜${tr.sampleRate} Hz ${tr.channels}ch` : '没有发生'}`);
          if (!tr) {
            console.error('  ✗ 音频没有走转码 —— 这一轮的样本里明明有一条 WebM/Opus 音频轨');
            problems += 1;
          }
          for (const w of stopped.warnings || []) console.log(`    ! ${String(w).split('\n')[0]}`);

          const dump = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
            const root = await navigator.storage.getDirectory();
            const fh = await root.getFileHandle(${JSON.stringify(stopped.fileName)});
            const file = await fh.getFile();
            const buf = new Uint8Array(await file.arrayBuffer());
            let bin = '';
            const CH = 0x8000;
            for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
            return JSON.stringify({ bytes: buf.length, base64: btoa(bin) });
          })()`, { timeout: 120000 }));

          mkdirSync(join(ROOT, '.tmp'), { recursive: true });
          const file = join(ROOT, '.tmp', 'browser-mse-webm-audio.mp4');
          writeFileSync(file, Buffer.from(dump.base64, 'base64'));
          const info = probe(file);
          const v = (info.streams || []).find((s) => s.codec_type === 'video');
          const a = (info.streams || []).find((s) => s.codec_type === 'audio');
          console.log(`  ✓ WebM 音频抓流产物 ffprobe：${v ? `${v.codec_name} ${v.width}x${v.height}` : '无视频轨'}`
            + `｜${a ? `${a.codec_name} ${a.sample_rate}Hz ${a.channels}ch` : '无音频轨'}`
            + `｜${Number(info.format.duration).toFixed(2)} 秒`);
          if (!v) { console.error('  ✗ 产物没有视频轨'); problems += 1; }
          if (!a) {
            console.error('  ✗ 产物没有音频轨 —— 这正是用户报的"有画面没声音"');
            problems += 1;
          } else if (a.codec_name !== 'aac') {
            console.error(`  ✗ 音频轨应该是 AAC（Opus 装进 MP4 普通播放器不认），实际 ${a.codec_name}`);
            problems += 1;
          }
          // 抓流只抓到 8 秒左右，产物时长要接近视频素材那 6 个分片的总长
          if (!(Number(info.format.duration) > 3)) {
            console.error(`  ✗ 产物时长不合理：${info.format.duration}`);
            problems += 1;
          }
        }
      }
    }

    await cdp.send('Target.closeTarget', { targetId: webmTarget });
  } catch (err) {
    console.error(`  ✗ WebM 音频抓流验证失败：${err.message}`);
    problems += 1;
  }


  /* ---- 8d. 写盘失败时，抓到的数据**绝不能丢** ----
   *
   * 这是用户最怕的那种失败：抓了四十分钟，收尾时空间不够，然后**什么都没了**。
   * 原来的写法一进 `mseStop` 就把会话清掉再写盘，于是配额一满就只剩一句
   * 原始的 `QuotaExceededError`，连重试都没得点。
   *
   * 复现方式：把**离屏文档**里的 `navigator.storage.getDirectory` 换成
   * 一个抛 `QuotaExceededError` 的版本（配额在真机上要占 5.6 GB 才复现得了，
   * 而这里是一个确定性的用例）。然后要求：
   *   1. 停止返回 `retryable` + 人话提示，而不是抛异常；
   *   2. 离屏文档**没有被关掉**，数据还在（`pendingBytes > 0`）；
   *   3. 状态停在 ERROR，一秒一次的心跳不会把它刷回"正在录制"；
   *   4. 把补丁去掉之后**重试就成功**，文件真的落进 OPFS。
   */
  try {
    const pageUrl = `${origin}/__page/mse`;
    const created = await cdp.send('Target.createTarget', { url: pageUrl });
    const failTarget = created.result?.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId: failTarget, flatten: true });
    const failSession = attached.result?.sessionId;
    await cdp.send('Runtime.enable', {}, failSession);
    await cdp.send('Page.enable', {}, failSession);
    await sleep(2500);

    const tabId = await evalIn(cdp, control.sessionId, `(async () => {
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl)} });
      return tabs.length ? tabs[0].id : null;
    })()`);

    const started = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
      const r = await chrome.runtime.sendMessage({ type: 'vh:mse-start', tabId: ${tabId} });
      return JSON.stringify(r || {});
    })()`, { timeout: 30000 }));

    if (!started.ok) {
      console.error(`  ✗ 写盘失败用例里抓流启动失败：${started.error}`);
      problems += 1;
    } else {
      await evalIn(cdp, control.sessionId, `chrome.tabs.reload(${tabId}).then(() => 'ok')`);
      await sleep(5000);

      // ---- 找到离屏文档，把它的存储接口换成"永远配额满" ----
      const offscreenId = await evalIn(cdp, control.sessionId, `(async () => {
        const found = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        return found.length ? 'yes' : 'no';
      })()`);
      const targets = await cdp.send('Target.getTargets');
      const offTarget = (targets.result?.targetInfos || [])
        .find((t) => String(t.url).includes('src/offscreen/offscreen.html'));
      if (!offTarget || offscreenId !== 'yes') {
        console.error('  ✗ 找不到离屏文档，写盘失败用例没法继续');
        problems += 1;
      } else {
        const offAttached = await cdp.send('Target.attachToTarget', { targetId: offTarget.targetId, flatten: true });
        const offSession = offAttached.result?.sessionId;
        await cdp.send('Runtime.enable', {}, offSession);
        const patched = await evalIn(cdp, offSession, `(() => {
          const real = navigator.storage.getDirectory.bind(navigator.storage);
          window.__vhRealGetDirectory = real;
          Object.defineProperty(navigator.storage, 'getDirectory', {
            configurable: true,
            value: () => {
              const err = new Error('The quota has been exceeded.');
              err.name = 'QuotaExceededError';
              err.code = 22;
              return Promise.reject(err);
            },
          });
          return 'patched';
        })()`);
        console.log(`  · 已把离屏文档的存储接口换成"配额满"：${patched}`);

        const failed = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
          const r = await chrome.runtime.sendMessage({ type: 'vh:mse-stop' });
          return JSON.stringify(r || {});
        })()`, { timeout: 120000 }));

        console.log(`  · 收尾结果：ok=${failed.ok}｜retryable=${failed.retryable}`
          + `｜storageFull=${failed.storageFull}｜待保存 ${failed.bytes ?? '?'} 字节`);
        console.log(`    提示：${String(failed.error || '').split('\\n')[0].slice(0, 120)}`);
        if (failed.ok) {
          console.error('  ✗ 存储被换成了"永远配额满"，收尾不该成功');
          problems += 1;
        } else {
          if (failed.retryable !== true) {
            console.error('  ✗ 这种失败必须标成可重试，否则用户只能眼睁睁看着数据卡住');
            problems += 1;
          }
          if (failed.storageFull !== true) {
            console.error('  ✗ 应该认出这是"空间不够"');
            problems += 1;
          }
          if (!/空间不够/.test(String(failed.error)) || !/还在内存里/.test(String(failed.error))) {
            console.error(`  ✗ 提示必须说清"数据没丢"和怎么办：${failed.error}`);
            problems += 1;
          }
        }

        // ---- 数据还在吗？（离屏会话没被清掉） ----
        const status = JSON.parse(await evalIn(cdp, control.sessionId,
          `chrome.runtime.sendMessage({ type: 'vh:offscreen-status' }).then((r) => JSON.stringify(r || {}))`,
          { timeout: 20000 }));
        console.log(`  · 离屏文档：active=${status.active}｜待保存 ${status.stats?.pendingBytes ?? 0} 字节`
          + `｜目标文件名 ${status.stats?.pendingFileName || '（无）'}`);
        if (!status.active || !(status.stats?.pendingBytes > 0)) {
          console.error('  ✗ 写盘失败之后数据应该留在离屏文档里，实际没了');
          problems += 1;
        }

        // ---- 心跳不能把 ERROR 刷回"正在录制" ----
        const stateAfter = JSON.parse(await evalIn(cdp, control.sessionId,
          `chrome.runtime.sendMessage({ type: 'vh:record-state' }).then((r) => JSON.stringify(r && r.state || {}))`,
          { timeout: 15000 }));
        await sleep(2500);
        const stateLater = JSON.parse(await evalIn(cdp, control.sessionId,
          `chrome.runtime.sendMessage({ type: 'vh:record-state' }).then((r) => JSON.stringify(r && r.state || {}))`,
          { timeout: 15000 }));
        console.log(`  · 等待 2.5 秒后状态：${stateLater.stage}｜retryable=${stateLater.retryable}`);
        if (stateAfter.stage !== 'error' || stateLater.stage !== 'error') {
          console.error(`  ✗ 状态必须停在 error（等 2.5 秒还是它），实际 ${stateAfter.stage} → ${stateLater.stage}`
            + '（心跳把错误刷回去了？）');
          problems += 1;
        }

        // ---- 用户能不能真的点到「重试保存」？ ----
        //
        // 状态对了不够：按钮得在**用户能看见的地方**。失败之后要自动把他送到
        // 管理页（他刚才多半是在面板里点的停止），而且两个出口都要显示出来。
        const ui = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
          const tabs = await chrome.tabs.query({ url: 'chrome-extension://' + chrome.runtime.id + '/src/recorder/recorder.html*' });
          if (!tabs.length) return JSON.stringify({ open: false });
          const t = tabs[0];
          return JSON.stringify({ open: true, tabId: t.id, active: t.active });
        })()`));
        if (!ui.open) {
          console.error('  ✗ 写盘失败之后应该自动打开管理页（重试按钮在那儿）');
          problems += 1;
        } else {
          // 用 CDP 打开同一个页面来读 DOM（管理页可能不在活动标签上）
          const uiTarget = await cdp.send('Target.createTarget', {
            url: `chrome-extension://${extId}/src/recorder/recorder.html`,
          });
          const uiAttached = await cdp.send('Target.attachToTarget', { targetId: uiTarget.result.targetId, flatten: true });
          const uiSession = uiAttached.result?.sessionId;
          await cdp.send('Runtime.enable', {}, uiSession);
          await sleep(2000);
          const buttons = JSON.parse(await evalIn(cdp, uiSession, `(() => {
            const r = document.getElementById('retry');
            const d = document.getElementById('discard');
            return JSON.stringify({
              retryHidden: r.hidden,
              retryText: r.textContent,
              discardHidden: d.hidden,
              info: document.getElementById('target-info').textContent,
              hint: document.getElementById('stage-hint').textContent,
            });
          })()`));
          console.log(`  · 管理页上的出口：「${buttons.retryText}」隐藏=${buttons.retryHidden}`
            + `｜「放弃这一份」隐藏=${buttons.discardHidden}｜状态=「${buttons.hint}」`);
          console.log(`    说明：${buttons.info.trim().slice(0, 90)}`);
          if (buttons.retryHidden || buttons.discardHidden) {
            console.error('  ✗ 写盘失败时「重试保存」和「放弃这一份」都必须显示出来');
            problems += 1;
          }
          if (!/还没丢/.test(buttons.info) || !/重试保存/.test(buttons.info)) {
            console.error(`  ✗ 状态卡里要说清"数据还在"和下一步：${buttons.info.slice(0, 100)}`);
            problems += 1;
          }
          await cdp.send('Target.closeTarget', { targetId: uiTarget.result.targetId });
        }

        // ---- 恢复存储接口，重试必须成功 ----
        await evalIn(cdp, offSession, `(() => {
          Object.defineProperty(navigator.storage, 'getDirectory', {
            configurable: true,
            value: window.__vhRealGetDirectory,
          });
          return 'restored';
        })()`);
        const retried = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
          const r = await chrome.runtime.sendMessage({ type: 'vh:mse-stop' });
          return JSON.stringify(r || {});
        })()`, { timeout: 120000 }));
        console.log(`  · 清出空间后重试：ok=${retried.ok}｜${retried.fileName || retried.error}`
          + `｜${retried.size ?? '?'} 字节｜时长 ${retried.mediaSeconds ?? '?'} 秒`);
        if (!retried.ok) {
          console.error(`  ✗ 恢复之后重试应该成功：${retried.error}`);
          problems += 1;
        } else {
          const exists = await evalIn(cdp, control.sessionId, `(async () => {
            const root = await navigator.storage.getDirectory();
            const names = [];
            for await (const [name] of root.entries()) names.push(name);
            return names.includes(${JSON.stringify(retried.fileName)}) ? 'yes' : 'no';
          })()`);
          if (exists !== 'yes') {
            console.error('  ✗ 重试之后产物没有落进 OPFS');
            problems += 1;
          } else {
            console.log('  ✓ 写盘失败 → 数据留在内存 → 清出空间 → 重试成功，全链路走通');
          }
          const settled = JSON.parse(await evalIn(cdp, control.sessionId,
            `chrome.runtime.sendMessage({ type: 'vh:record-state' }).then((r) => JSON.stringify(r && r.state || {}))`,
            { timeout: 15000 }));
          if (settled.stage !== 'ready' || settled.error) {
            console.error(`  ✗ 重试成功后状态应该是 ready 且没有错误，实际 ${settled.stage}/${settled.error}`);
            problems += 1;
          }
        }
      }
    }

    await cdp.send('Target.closeTarget', { targetId: failTarget });
  } catch (err) {
    console.error(`  ✗ 写盘失败用例失败：${err.message}`);
    problems += 1;
  }

  /* ---- 10. 「停止」永远要给一个交代 ---- */
  //
  // 用户报的：在页面上点了「录制」，面板显示录制中，再点「停止并保存」却回一句
  // 「当前没有在录制」。查下去是两个问题叠在一起：
  //   1. 页面上任何一个 <video> 播完都会触发自动收尾（广告、预览、花絮小窗），
  //      而收尾不是瞬间的 —— 用户在这期间点停止，就撞上"正在收尾"的状态；
  //   2. 那次点击被当成错误直接打回去，用户以为白录了，其实文件正在写完。
  //
  // tabCapture 在这个环境里点不起来，所以录制本身没法整链路验；
  // 但**状态机这一半可以验**：非目标视频播完必须被忽略，收尾中/已收尾的停止
  // 必须返回"能看懂的结果"而不是一句"没有在录制"。
  try {
    // 非目标视频播完 → 不能打断录制
    const notTarget = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
      const r = await chrome.runtime.sendMessage({ type: 'vh:media-ended', fromTarget: false });
      return JSON.stringify(r || {});
    })()`));
    console.log(`  · 非目标视频播完：${notTarget.action}`);
    if (notTarget.action === 'auto-stopping') {
      console.error('  ✗ 页面上随便一个视频播完就把录制停了 —— 这正是用户遇到的那个 bug');
      problems += 1;
    }

    // 收尾中再点一次「停止并保存」：不能回「当前没有在录制」
    //
    // 注意键名从模块里取（`vh:recording`），不要写死 —— 我第一次就猜成了
    // `vh:record`，结果测试读自己写的键、SW 读另一个键，断言假通过。
    const finalizing = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
      const { RECORD_KEY } = await import('../core/constants.js');
      await chrome.storage.session.set({ [RECORD_KEY]: {
        stage: 'finalizing', tabId: 1, startedAt: Date.now() - 5000,
      } });
      const before = (await chrome.storage.session.get(RECORD_KEY))?.[RECORD_KEY];
      const r = await chrome.runtime.sendMessage({ type: 'vh:record-stop' });
      const after = (await chrome.storage.session.get(RECORD_KEY))?.[RECORD_KEY];
      await chrome.storage.session.remove(RECORD_KEY);
      return JSON.stringify({ ...(r || {}), before, after });
    })()`, { timeout: 30000 }));
    console.log(`  · 收尾中再点停止：ok=${finalizing.ok} action=${finalizing.action}`
      + ` error=${finalizing.error || '（无）'}`
      + `｜写入的 stage=${finalizing.before?.stage}，之后 stage=${finalizing.after?.stage}`);
    if (!finalizing.ok || finalizing.action !== 'finalizing') {
      console.error('  ✗ 收尾中再点「停止并保存」应该给出"正在收尾"，而不是当成错误');
      problems += 1;
    }

    // 已经收完了再点：应当把他送到管理页，并且算成功
    const already = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
      const { RECORD_KEY } = await import('../core/constants.js');
      await chrome.storage.session.set({ [RECORD_KEY]: {
        stage: 'ready', tabId: 1, fileName: 'vh-rec-20260101-000000.mp4', startedAt: Date.now() - 5000,
      } });
      const r = await chrome.runtime.sendMessage({ type: 'vh:record-stop' });
      await chrome.storage.session.remove(RECORD_KEY);
      return JSON.stringify(r || {});
    })()`, { timeout: 30000 }));
    console.log(`  · 已收尾后再点停止：ok=${already.ok} action=${already.action}`
      + ` error=${already.error || '（无）'}`);
    if (!already.ok || already.action !== 'already-finalized') {
      console.error('  ✗ 已经收完尾再点停止，应该算成功并打开管理页（文件在那里）');
      problems += 1;
    }
  } catch (err) {
    console.error(`  ✗ 停止语义验证失败：${err.message}`);
    problems += 1;
  }

  /* ---- 9. 真 tabCapture：能不能真的拿到标签页的流 ---- */
  //
  // 这一步和上面的合成流是两件独立的事：上面验的是"编码封装对不对"，
  // 这里验的是"能不能拿到采集源"。后者受 Chrome 的策略约束
  // （tabCapture 要求目标页处于活动状态、且扩展被用户调用过），
  // 在自动化环境里不一定能成立 —— 所以失败要如实报，不能当成代码有问题。
  if (tabId != null) {
    try {
      await evalIn(cdp, control.sessionId,
        `chrome.tabs.update(${tabId}, { active: true }).then(() => 'ok')`);
      await sleep(1500);

      const started = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
        const r = await chrome.runtime.sendMessage({
          type: 'vh:record-start',
          tabId: ${tabId},
          options: { videoBitrate: 1000000, frameRate: 30, monitorAudio: false },
        });
        return JSON.stringify(r || {});
      })()`, { timeout: 45000 }));

      if (!started.ok) {
        console.log('  · 真 tabCapture 未启动（自动化环境下的预期结果）');
        console.log(`    原因：${String(started.error || '').split('\n')[0]}`);
      } else {
        console.log(`  ✓ tabCapture 已启动：${started.videoCodec} / ${started.audioCodec || '无音轨'}`
          + ` · ${started.width}×${started.height}｜${started.fileName}`);
        await sleep(4000);

        const stopped = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
          const r = await chrome.runtime.sendMessage({ type: 'vh:record-stop' });
          return JSON.stringify(r || {});
        })()`, { timeout: 60000 }));

        if (!stopped.ok) {
          console.error(`  ✗ tabCapture 停止失败：${stopped.error}`);
          problems += 1;
        } else {
          console.log(`  ✓ tabCapture 录制完成：${stopped.frames} 帧（丢 ${stopped.dropped || 0}）`
            + `｜${stopped.size} 字节｜${((stopped.durationMs || 0) / 1000).toFixed(1)} 秒`);

          const dump = JSON.parse(await evalIn(cdp, control.sessionId, `(async () => {
            const root = await navigator.storage.getDirectory();
            const fh = await root.getFileHandle(${JSON.stringify(stopped.fileName)});
            const file = await fh.getFile();
            const buf = new Uint8Array(await file.arrayBuffer());
            let bin = '';
            const CH = 0x8000;
            for (let i = 0; i < buf.length; i += CH) {
              bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
            }
            return JSON.stringify({ bytes: buf.length, base64: btoa(bin) });
          })()`, { timeout: 60000 }));

          mkdirSync(join(ROOT, '.tmp'), { recursive: true });
          const file = join(ROOT, '.tmp', 'browser-tabcapture.mp4');
          writeFileSync(file, Buffer.from(dump.base64, 'base64'));
          try {
            const info = probe(file);
            const v = (info.streams || []).find((s) => s.codec_type === 'video');
            const a = (info.streams || []).find((s) => s.codec_type === 'audio');
            const dur = Number(info.format.duration);
            console.log(`  ✓ tabCapture 产物 ffprobe：${v ? v.codec_name + ' ' + v.width + 'x' + v.height : '无视频轨'}`
              + `｜${a ? a.codec_name : '无音频轨'}｜${dur.toFixed(2)} 秒`);
            if (!v) { console.error('  ✗ tabCapture 产物读不到视频轨'); problems += 1; }
            if (dur < 2) { console.error(`  ✗ tabCapture 产物太短：${dur.toFixed(2)} 秒`); problems += 1; }
          } catch (err) {
            console.error(`  ✗ tabCapture 产物 ffprobe 失败：${err.message}`);
            problems += 1;
          }
        }
      }
    } catch (err) {
      console.log(`  · 真 tabCapture 这条路没走通：${err.message}`);
      console.log('    （这是自动化环境的限制，真实使用时用户点扩展图标会授予调用权限）');
    }
  }

  if (pageTargetId) await cdp.send('Target.closeTarget', { targetId: pageTargetId });
  await cdp.send('Target.closeTarget', { targetId: control.targetId });
  return problems;
}

/* ------------------------------------------------------------------ *
 * 浏览器侧端到端
 *
 * 这段是 Node 测试够不着的地方：真的用页面的 fetch 去 HTTP 取流、
 * 真的在浏览器里跑 mux.js 和 WebCrypto 解密。产物拿回 Node 落盘，
 * 再用 ffprobe 反过来验 —— 形成闭环。
 * ------------------------------------------------------------------ */

/** 在解析器页里跑一遍完整管线，返回产物的 base64 */
function pipelineExpression(m3u8Url, { limit = 0, preferLowest = false } = {}) {
  return `(async () => {
    const hls = await import('./hls.js');
    const rm  = await import('./remuxer.js');
    const dl  = await import('./downloader.js');

    const masterText = await (await fetch(${JSON.stringify(m3u8Url)})).text();
    const master = hls.parsePlaylist(masterText, ${JSON.stringify(m3u8Url)});
    let media = master;
    let picked = null;
    if (master.isMaster) {
      const list = master.variants.filter((v) => !v.iframe && v.uri);
      ${preferLowest
        ? 'picked = list.slice().sort((a, z) => (a.bandwidth || 0) - (z.bandwidth || 0))[0];'
        : 'picked = hls.selectVariant(master.variants, "auto");'}
      if (!picked) throw new Error('主列表里没有可用的码率');
      const text = await (await fetch(picked.uri)).text();
      media = hls.parsePlaylist(text, picked.uri);
    }
    if (!media.ok) throw new Error('播放列表解析失败：' + media.error);

    const all = media.segments;
    const use = ${limit} > 0 ? all.slice(0, ${limit}) : all;

    const chunks = [];
    const remuxer = rm.createTsRemuxer(window.muxjs, {
      onInit: (b) => chunks.push(b),
      onFragment: (b) => chunks.push(b),
    });
    const fetchSegment = dl.createSegmentFetcher({ mediaSequence: media.mediaSequence });
    for await (const { data } of dl.downloadSegmentsInOrder(use, {
      concurrency: 4, retries: 2, fetchSegment,
    })) {
      remuxer.append(data);
    }
    remuxer.end();

    let total = 0;
    const joined = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    for (const c of chunks) { joined.set(c, total); total += c.byteLength; }

    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < joined.length; i += CH) {
      bin += String.fromCharCode.apply(null, joined.subarray(i, i + CH));
    }

    const h = null;
    return JSON.stringify({
      variants: master.isMaster ? master.variants.filter((v) => !v.iframe).length : 0,
      renditions: master.renditions ? master.renditions.length : 0,
      picked: picked ? { bandwidth: picked.bandwidth, resolution: picked.resolution, audioGroup: picked.audioGroup } : null,
      totalSegments: all.length,
      usedSegments: use.length,
      fragments: remuxer.fragmentCount,
      initBytes: remuxer.initSegment ? remuxer.initSegment.byteLength : 0,
      bytes: total,
      magic: String.fromCharCode(joined[4], joined[5], joined[6], joined[7]),
      base64: btoa(bin),
    });
  })()`;
}

/**
 * 直播路径：反复拉同一份快照，跑一小会儿就 abort。
 *
 * 用静态样本模拟直播是够的 —— 要验的是「反复拉取 → 只下没见过的新片 →
 * 持续往同一个重封装器里喂 → abort 能干净退出」这条控制流，
 * 而它不依赖于播放列表真的在变。
 */
function liveExpression(liveUrl) {
  return `(async () => {
    const hls  = await import('./hls.js');
    const live = await import('./live.js');
    const rm   = await import('./remuxer.js');
    const dl   = await import('./downloader.js');

    const url = ${JSON.stringify(liveUrl)};
    const text = await (await fetch(url)).text();
    const pl = hls.parsePlaylist(text, url);
    if (pl.isMaster) throw new Error('直播样本不该是主列表');
    if (pl.endList) throw new Error('直播样本不该带 #EXT-X-ENDLIST');

    const chunks = [];
    const remuxer = rm.createTsRemuxer(window.muxjs, {
      onInit: (b) => chunks.push(b),
      onFragment: (b) => chunks.push(b),
    });
    const controller = new AbortController();
    const fetchSegment = dl.createSegmentFetcher({ signal: controller.signal });

    let batches = 0;
    let downloaded = 0;

    const polling = live.runLivePolling({
      playlistUrl: url,
      signal: controller.signal,
      fetchPlaylist: async () => text,
      intervalFor: () => 200,
      onPlaylist: async (_pl, fresh) => {
        if (!fresh.length) return;
        batches += 1;
        for await (const { data } of dl.downloadSegmentsInOrder(fresh, {
          concurrency: 3, retries: 1, fetchSegment,
        })) {
          remuxer.append(data);
          downloaded += 1;
        }
      },
    });

    await new Promise((r) => setTimeout(r, 1200));
    controller.abort();
    const tracker = await polling;
    remuxer.end();

    const joined = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let off = 0;
    for (const c of chunks) { joined.set(c, off); off += c.byteLength; }

    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < joined.length; i += CH) {
      bin += String.fromCharCode.apply(null, joined.subarray(i, i + CH));
    }

    return JSON.stringify({
      windowSegments: pl.segments.length,
      mediaSequence: pl.mediaSequence,
      batches,
      downloaded,
      ingested: tracker.ingestedCount,
      missed: tracker.missedCount,
      fragments: remuxer.fragmentCount,
      bytes: joined.length,
      magic: String.fromCharCode(joined[4], joined[5], joined[6], joined[7]),
      base64: btoa(bin),
    });
  })()`;
}

/** DASH：视频轨和音频轨各自独立，两路下完再合并 */
function dashExpression(mpdUrl, limit) {
  return `(async () => {
    const dash = await import('./dash.js');
    const dl   = await import('./downloader.js');
    const mg   = await import('./mp4-merge.js');

    const text = await (await fetch(${JSON.stringify(mpdUrl)})).text();
    const parsed = dash.parseMpd(text, ${JSON.stringify(mpdUrl)});
    if (!parsed.ok) throw new Error(parsed.error || 'MPD 解析失败');

    const picked = dash.selectRepresentations(parsed, { preferredQuality: 'auto' });
    if (!picked.video) throw new Error('这条 MPD 里没有视频轨');

    const fetchSegment = dl.createSegmentFetcher({});
    async function collect(rep) {
      if (!rep) return null;
      const init = await fetchSegment({ uri: rep.initUrl }, -1);
      const items = rep.segmentUrls.slice(0, ${limit}).map((u) => ({ uri: u }));
      const segs = [];
      for await (const { data } of dl.downloadSegmentsInOrder(items, {
        concurrency: 4, retries: 2, fetchSegment,
      })) {
        segs.push(data);
      }
      return { init, segments: segs };
    }

    const video = await collect(picked.video);
    const audio = await collect(picked.audio);
    const merged = mg.mergeFmp4({ video, audio });

    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < merged.length; i += CH) {
      bin += String.fromCharCode.apply(null, merged.subarray(i, i + CH));
    }

    return JSON.stringify({
      totalReps: (parsed.representations || []).length,
      videoSegments: picked.video.segmentUrls.length,
      audioSegments: picked.audio ? picked.audio.segmentUrls.length : 0,
      videoFragments: video.segments.length,
      audioFragments: audio ? audio.segments.length : 0,
      bytes: merged.length,
      magic: String.fromCharCode(merged[4], merged[5], merged[6], merged[7]),
      base64: btoa(bin),
    });
  })()`;
}

async function runE2E(cdp, extId, origin) {
  console.log('\n· 浏览器侧端到端');
  let problems = 0;

  const cases = [
    {
      name: 'TS 版 HLS（主列表 → 选码率 → 重封装）',
      url: `${origin}/hls-ts/index.m3u8`,
      fileKey: 'ts',
      expectAudio: true,
      expectSeconds: 12,
    },
    {
      name: 'AES-128 加密的 HLS（浏览器内解密）',
      url: `${origin}/hls-enc/index.m3u8`,
      fileKey: 'enc',
      expectAudio: true,
      expectSeconds: 12,
    },
    {
      name: '直播形态 HLS（反复拉取 + 滑动窗口 + abort）',
      url: `${origin}/hls-live/index.m3u8`,
      fileKey: 'live',
      expression: liveExpression(`${origin}/hls-live/index.m3u8`),
      expectAudio: true,
      // 窗口只列了 3 片、每片 2 秒
      expectSeconds: 6,
      // 直播在 UI 上必须被认出来，否则用户会以为点下去就是普通下载
      uiMustInclude: '直播',
      uiButton: '开始录制直播',
    },
    {
      name: 'DASH（音视频分离 → 合并成一个 MP4）',
      url: `${origin}/dash-split/out.mpd`,
      fileKey: 'dash',
      expression: dashExpression(`${origin}/dash-split/out.mpd`, 3),
      expectAudio: true,
      // 3 片 × 2 秒
      expectSeconds: 6,
      uiMustInclude: 'DASH',
      uiButton: '开始下载',
    },
  ];

  for (const c of cases) {
    const pageUrl = `chrome-extension://${extId}/src/parser/parser.html?url=${encodeURIComponent(c.url)}&title=e2e`;
    const created = await cdp.send('Target.createTarget', { url: pageUrl });
    const targetId = created.result?.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached.result?.sessionId;
    if (!sessionId) { console.error(`✗ ${c.name}：无法附加调试会话`); problems += 1; continue; }

    await cdp.send('Runtime.enable', {}, sessionId);
    await sleep(900);

    // 4a. 先看 UI 有没有真的解析出来（验 fetch + 解析 + 渲染这条链）
    const uiRes = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        state: document.getElementById('state-body').textContent,
        variants: document.querySelectorAll('#variants .variant').length,
        plan: document.getElementById('plan-summary').textContent.slice(0, 120),
        button: document.getElementById('start').textContent,
      })`,
      returnByValue: true,
    }, sessionId);
    const ui = JSON.parse(uiRes.result?.result?.value || '{}');
    console.log(`  · ${c.name}`);
    console.log(`    UI：${ui.state}｜码率按钮 ${ui.variants} 个｜按钮「${ui.button}」`);
    if (!ui.state || ui.state.includes('读取失败')) {
      console.error('    ✗ 页面没能读取播放列表');
      problems += 1;
    }
    if (c.uiMustInclude && !String(ui.state).includes(c.uiMustInclude)) {
      console.error(`    ✗ 页面没有把这条流认成「${c.uiMustInclude}」：${ui.state}`);
      problems += 1;
    }
    if (c.uiButton && ui.button !== c.uiButton) {
      console.error(`    ✗ 按钮文案不对：期望「${c.uiButton}」，实际「${ui.button}」`);
      problems += 1;
    }

    // 4b. 跑管线，把产物拿回来
    const res = await cdp.send('Runtime.evaluate', {
      expression: c.expression || pipelineExpression(c.url),
      awaitPromise: true,
      returnByValue: true,
      timeout: 120000,
    }, sessionId);

    if (res.result?.exceptionDetails) {
      console.error(`    ✗ 管线抛错：${res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text}`);
      problems += 1;
      await cdp.send('Target.closeTarget', { targetId });
      continue;
    }

    let out;
    try {
      out = JSON.parse(res.result?.result?.value || '{}');
    } catch {
      console.error('    ✗ 管线没有返回可解析的结果');
      problems += 1;
      await cdp.send('Target.closeTarget', { targetId });
      continue;
    }

    // 各条路径返回的字段不完全一样，这里按有的字段拼
    const bits = [];
    if (out.windowSegments != null) {
      bits.push(`窗口 ${out.windowSegments} 片（MEDIA-SEQUENCE ${out.mediaSequence}）`,
        `轮次 ${out.batches}`, `实收 ${out.downloaded} 片`, `漏片 ${out.missed}`,
        `重封装片段 ${out.fragments}`);
    } else if (out.videoSegments != null) {
      bits.push(`Representation ${out.totalReps} 条`,
        `视频轨 ${out.videoSegments} 片（取 ${out.videoFragments}）`,
        `音频轨 ${out.audioSegments} 片（取 ${out.audioFragments}）`);
    } else {
      bits.push(`分片 ${out.usedSegments ?? out.segments}`,
        `重封装片段 ${out.fragments}`, `初始化段 ${out.initBytes} B`);
    }
    bits.push(`产物 ${out.bytes} B`, `容器 ${out.magic}`);
    console.log(`    · ${bits.join('｜')}`);

    if (out.magic !== 'ftyp') {
      console.error(`    ✗ 产物开头不是 ftyp（拿到 ${out.magic}），说明不是有效的 MP4`);
      problems += 1;
    }
    if (typeof out.initBytes === 'number' && out.initBytes === 0) {
      console.error('    ✗ 没有初始化段');
      problems += 1;
    }
    // 直播特有的检查：同一份快照反复喂，不该重复下载，也不该误报漏片
    if (out.windowSegments != null) {
      if (out.ingested !== out.windowSegments) {
        console.error(`    ✗ 直播去重不对：窗口 ${out.windowSegments} 片，却收了 ${out.ingested} 片`);
        problems += 1;
      }
      if (out.missed !== 0) {
        console.error(`    ✗ 静态快照不该报漏片，实际漏了 ${out.missed} 片`);
        problems += 1;
      }
      if (out.batches !== 1) {
        console.error(`    ✗ 同一份快照只该产生 1 个批次，实际 ${out.batches} 个（去重失效）`);
        problems += 1;
      }
    }

    // 4c. 落盘并交给 ffprobe 独立验证
    if (out.base64) {
      const buf = Buffer.from(out.base64, 'base64');
      mkdirSync(join(ROOT, '.tmp'), { recursive: true });
      const file = join(ROOT, '.tmp', `browser-${c.fileKey}.mp4`);
      writeFileSync(file, buf);
      const seconds = c.expectSeconds ?? 12;
      try {
        const info = probe(file);
        const v = (info.streams || []).find((s) => s.codec_type === 'video');
        const a = (info.streams || []).find((s) => s.codec_type === 'audio');
        const dur = Number(info.format.duration);
        console.log(`    · ffprobe：${v ? v.codec_name + ' ' + v.width + 'x' + v.height : '无视频轨'}｜${a ? a.codec_name : '无音频轨'}｜${dur.toFixed(2)} 秒`);
        if (!v) { console.error('    ✗ ffprobe 读不到视频轨'); problems += 1; }
        if (c.expectAudio && !a) { console.error('    ✗ ffprobe 读不到音频轨'); problems += 1; }
        if (Math.abs(dur - seconds) > 0.7) {
          console.error(`    ✗ 时长不对：${dur.toFixed(3)}，期望约 ${seconds} 秒`);
          problems += 1;
        }
      } catch (err) {
        console.error(`    ✗ ffprobe 验证失败：${err.message}`);
        problems += 1;
      }
    }

    await cdp.send('Target.closeTarget', { targetId });
  }

  return problems;
}

main().catch((err) => {
  console.error('检查失败：', err.message);
  process.exit(1);
});

