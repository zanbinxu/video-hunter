#!/usr/bin/env node
/**
 * 把 test/fixtures/ 当静态站点铺出来，供浏览器侧端到端测试使用。
 *
 * 除了静态文件，它还有这些**测试专用路由**：
 *   GET /__page/video      一个含 <video> 的测试页（验内容脚本注入、嗅探）
 *   GET /__page/mse        一个真走 MSE 的测试页（验抓流）
 *   GET /__page/mse-webm   同上，但音频轨是 WebM/Opus（YouTube 的形态）
 *   GET /__page/mse-webm-video  画面和声音**都是 WebM**（VP9 + Opus → 产物应是 .webm）
 *   GET /__page/resume     一个会"续播上次位置"的测试页（验抓流会不会被那一跳弄断）
 *   GET /__last-headers    最近一次请求的请求头 JSON（验 Referer 注入是否真的生效）
 *   GET /__reset-headers   清空记录
 *
 * 第 2 个路由是重点。Referer 注入这条链路在代码里成立、静态检查也过得去，
 * 但「Chrome 到底会不会给扩展页面自己发起的 fetch 改 Referer」只能真发一次请求看。
 *
 * 用法：node tools/fixture-server.mjs [--port 8791]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

const portArg = process.argv.indexOf('--port');
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 8791;

const TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'audio/webm',
  '.mpd': 'application/dash+xml',
  '.key': 'application/octet-stream',
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
};

/** 最近一次非测试路由请求的完整信息 */
let lastRequest = null;

const TEST_PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Video Hunter 测试页</title></head>
<body style="margin:0;background:#111;color:#eee;font:14px sans-serif">
  <h1 style="font-size:16px;padding:12px">Video Hunter 测试页</h1>
  <video id="v" src="/source.mp4" width="640" height="360" controls loop></video>
  <p id="status" style="padding:12px">等待播放…</p>
  <script>
    const v = document.getElementById('v');
    v.addEventListener('playing', () => { document.getElementById('status').textContent = '正在播放'; });
    v.play().catch((e) => { document.getElementById('status').textContent = '播放被拒: ' + e.message; });
  </script>
</body></html>`;

/**
 * 一个**真的走 MSE** 的测试页。
 * 为什么需要它：MSE 抓流钩的是 `SourceBuffer.appendBuffer`，没有真正的
 * MSE 播放就验不了。这个页面按 DASH 的方式开两个 SourceBuffer
 * （视频一条、音频一条），把 fixture 里的 init 和分片依次 append 进去 ——
 * 和真实播放器做的事一模一样。
 */
/**
 * 一个**会"续播上次位置"**的测试页 —— 很多真实站点都这么干。
 *
 * 为什么要专门造它：抓流会刷新页面让钩子从头收数据，而站点往往在加载完之后
 * 把播放位置设回你上次看到的地方。那一跳会让抓到的流中间断掉几百秒，
 * 合并出来的文件里横着一段空洞，**用户看到的就是"前 12 分钟怎么拖都拖不动"**。
 * 这个页面在 1.5 秒后把 currentTime 设到 8 秒，用来验证扩展会把它扳回开头。
 */
const RESUME_PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Video Hunter 续播测试页</title></head>
<body style="margin:0;background:#111;color:#eee;font:14px sans-serif">
  <h1 style="font-size:16px;padding:12px">模拟"站点恢复上次观看位置"</h1>
  <video id="v" src="/source.mp4" width="640" height="360" controls muted></video>
  <p id="status" style="padding:12px">等待…</p>
  <script>
    const v = document.getElementById('v');
    const setStatus = (t) => { document.getElementById('status').textContent = t; };
    v.play().catch((e) => setStatus('播放被拒: ' + e.message));
    // 站点式的"恢复上次位置"：等一会儿再设，模拟真实站点拿到接口数据之后才恢复
    setTimeout(() => {
      v.currentTime = 8;
      setStatus('已把位置设到 8 秒（模拟续播）');
    }, 1500);
    window.__vhResumePage = true;
  </script>
</body></html>`;


/**
 * 一个**真的走 MSE** 的测试页（用函数造，好让两条轨的形态都可换）。
 *
 * 为什么需要它：MSE 抓流钩的是 `SourceBuffer.appendBuffer`，没有真正的
 * MSE 播放就验不了。这个页面按播放器的方式开两个 SourceBuffer
 * （视频一条、音频一条），把 fixture 里的 init 和分片依次 append 进去 ——
 * 和真实播放器做的事一模一样。
 *
 * @param {{video:object, audio:object}} tracks
 *        每条轨的 `{mime, init, segments}`。默认是 DASH 那套 fMP4；
 *        换成 WebM 就是"站点画面/声音都是 WebM"那种形态。
 */
function msePage(tracks) {
  const t = (x) => JSON.stringify(x);
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Video Hunter MSE 测试页</title></head>
<body style="margin:0;background:#111;color:#eee;font:14px sans-serif">
  <h1 style="font-size:16px;padding:12px">MSE 播放测试页</h1>
  <video id="v" width="640" height="360" controls></video>
  <p id="status" style="padding:12px">准备中…</p>
  <script>
    const setStatus = (t) => { document.getElementById('status').textContent = t; };
    const v = document.getElementById('v');
    const ms = new MediaSource();
    v.src = URL.createObjectURL(ms);

    const TRACKS = ${t(tracks)};
    // ?slow=1：一段一段慢慢喂（模拟"数据一直在进来"的真实直播/长视频），
    // 自动保存那条用例要靠它才能验到"到点又存一份、并覆盖上一份"。
    const SLOW = new URLSearchParams(location.search).get('slow') === '1';
    const SLOW_MS = Number(new URLSearchParams(location.search).get('slowMs')) || 1200;

    const load = async (name) => new Uint8Array(await (await fetch('/' + name)).arrayBuffer());
    const append = (sb, data) => new Promise((resolve, reject) => {
      sb.addEventListener('updateend', resolve, { once: true });
      sb.addEventListener('error', reject, { once: true });
      sb.appendBuffer(data);
    });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    ms.addEventListener('sourceopen', async () => {
      try {
        // 注意：Chrome 的 addSourceBuffer **要求 mime 里带 codecs**，
        // 光写 'video/mp4' 会被拒绝。所以这里给完整 mime。
        // （"mime 骗人时靠 moov 分辨轨道"那种情况由单元测试覆盖。）
        const vsb = ms.addSourceBuffer(TRACKS.video.mime);
        const asb = ms.addSourceBuffer(TRACKS.audio.mime);
        let n = 0;
        const feed = async (sb, label, spec) => {
          setStatus('append ' + label + ' 初始化段…');
          await append(sb, await load(spec.init));
          n += 1;
          for (let i = 0; i < spec.segments.length; i += 1) {
            setStatus('append ' + label + ' ' + (i + 1) + '/' + spec.segments.length);
            await append(sb, await load(spec.segments[i]));
            n += 1;
            if (SLOW) await wait(SLOW_MS);
          }
        };
        await feed(vsb, '视频', TRACKS.video);
        await feed(asb, '音频', TRACKS.audio);
        ms.endOfStream();
        setStatus('append 完成，共 ' + n + ' 次');
        v.play().catch(() => {});
      } catch (e) {
        setStatus('失败: ' + e.message);
      }
    });
  </script>
</body></html>`;
}

/** DASH 那套 fMP4 的分片清单 */
const dashChunks = (prefix) => [
  'chunk-stream0-00001.m4s', 'chunk-stream0-00002.m4s', 'chunk-stream0-00003.m4s',
  'chunk-stream0-00004.m4s', 'chunk-stream0-00005.m4s', 'chunk-stream0-00006.m4s',
];

const MSE_PAGE = msePage({
  video: {
    mime: 'video/mp4; codecs="avc1.64001e"',
    init: 'dash-split/init-stream0.m4s',
    segments: dashChunks('stream0').map((n) => `dash-split/${n}`),
  },
  audio: {
    mime: 'audio/mp4; codecs="mp4a.40.2"',
    init: 'dash-split/init-stream1.m4s',
    segments: ['chunk-stream1-00001.m4s', 'chunk-stream1-00002.m4s', 'chunk-stream1-00003.m4s',
      'chunk-stream1-00004.m4s', 'chunk-stream1-00005.m4s', 'chunk-stream1-00006.m4s', 'chunk-stream1-00007.m4s']
      .map((n) => `dash-split/${n}`),
  },
});

/**
 * 同上，但**音频轨是 WebM/Opus** —— 也就是 YouTube 的形态。
 *
 * 为什么必须专门造它：用户报的「抓 YouTube 的视频能抓到画面，但是抓不到声音」，
 * 根因就是音频轨是 `audio/webm; codecs="opus"`，而合并器当时只认 fMP4，
 * 于是那 0.8 MB 音频被静默跳过。这个页面把那个形态固定下来：
 * 视频走 fMP4，音频走 WebM/Opus。
 */
const MSE_WEBM_PAGE = msePage({
  video: {
    mime: 'video/mp4; codecs="avc1.64001e"',
    init: 'dash-split/init-stream0.m4s',
    segments: dashChunks('stream0').map((n) => `dash-split/${n}`),
  },
  audio: {
    mime: 'audio/webm; codecs="opus"',
    init: 'webm-opus/init.webm',
    segments: ['webm-opus/clusters.webm'],
  },
});

/**
 * 画面和声音**都是 WebM**：VP9 画面一条 SourceBuffer、Opus 音频一条。
 *
 * 这是"抓流原来只会报不支持"的那种站点。现在这条路出 `.webm`，
 * 而且**零转码** —— 两个方向的字节都是原样搬进新容器的。
 */
const MSE_WEBM_VIDEO_PAGE = msePage({
  video: {
    mime: 'video/webm; codecs="vp9"',
    init: 'webm-vp9/video-init.webm',
    segments: ['webm-vp9/video-clusters.webm'],
  },
  audio: {
    mime: 'audio/webm; codecs="opus"',
    init: 'webm-vp9/audio-init.webm',
    segments: ['webm-vp9/audio-clusters.webm'],
  },
});

/**
 * 一个**没有清单、只有两条独立轨道**的测试页 —— B 站那种形态。
 *
 * 为什么必须专门造它：这里的重点不是"能不能合并"（那是解析器页的事），而是
 * **面板上那条合并提示条判断得对不对**。真实站点的两条轨 MIME 是不一样的：
 * 视频轨 `video/mp4`、音频轨 `audio/mp4` —— 扩展的分类器先看 MIME，于是音频
 * 落进 AUDIO 而不是 SEGMENT。原来的判据只看 SEGMENT 的条数，就会认为
 * "只有一条轨道"，而提示条又是显示的，点下去只得到一句"至少要有两条轨道才能合并"。
 *
 * `?only=video` 时只拉视频轨，用来验"只看到视频轨"时面板怎么写。
 */
const TRACKS_PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Video Hunter 独立轨道测试页</title></head>
<body style="margin:0;background:#111;color:#eee;font:14px sans-serif">
  <h1 style="font-size:16px;padding:12px">无清单 DASH：两条独立轨道</h1>
  <p id="status" style="padding:12px">拉取中…</p>
  <script>
    const only = new URLSearchParams(location.search).get('only');
    const files = ['/dash-split/chunk-stream0-00001.m4s']
      .concat(only === 'video' ? [] : ['/dash-split/chunk-stream1-00001.m4s']);
    (async () => {
      for (const f of files) {
        try { await fetch(f); } catch (e) { /* 测试页，失败也把状态写出来 */ }
      }
      document.getElementById('status').textContent = '拉取完成：' + files.length + ' 条';
    })();
  </script>
</body></html>`;

/**
 * 一个**YouTube 形态**的测试页：页面真的走 MSE（`blob:` 源），但媒体响应是站点
 * 自己的容器类型（`application/vnd.yt-ump`）、URL 也没有媒体扩展名。
 *
 * 为什么要有它：这正是「嗅探天生看不到任何能下载的东西，只能抓流」的那一类站点，
 * 面板那句「这个视频用 MSE 播放，真实地址不是普通请求拿得到的」就是为它写的。
 * 断网环境下没法拿真 YouTube 验，就用这个形状把**提示条该不该出现**钉住 ——
 * 合并提示条的判据改过一版，最容易误伤的正是这个页面（嗅探列表是空的）。
 */
const YT_UMP_PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Video Hunter 站点自有容器测试页</title></head>
<body style="margin:0;background:#111;color:#eee;font:14px sans-serif">
  <h1 style="font-size:16px;padding:12px">模拟 YouTube 那种"嗅探拿不到地址"的站点</h1>
  <video id="v" width="640" height="360" controls muted></video>
  <p id="status" style="padding:12px">准备中…</p>
  <script>
    const v = document.getElementById('v');
    const ms = new MediaSource();
    v.src = URL.createObjectURL(ms);   // 面板就是靠这个 blob: 源判断"页面在用 MSE"
    (async () => {
      const files = ['/videoplayback?i=1', '/videoplayback?i=2'];
      let bytes = 0;
      for (const f of files) {
        try { bytes += (await (await fetch(f)).arrayBuffer()).byteLength; } catch (e) { /* 测试页 */ }
      }
      // 顺手真塞一次 SourceBuffer（播放器做的事）；塞不进去也不影响这个页面要验的东西
      try {
        await v.play().catch(() => {});
        if (ms.readyState === 'open') {
          const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.64001e"');
          document.getElementById('status').textContent = '已建 SourceBuffer，收到 ' + bytes + ' 字节';
        } else {
          document.getElementById('status').textContent = '收到 ' + bytes + ' 字节（MediaSource ' + ms.readyState + '）';
        }
      } catch (e) {
        document.getElementById('status').textContent = '收到 ' + bytes + ' 字节（append 失败：' + e.message + '）';
      }
    })();
  </script>
</body></html>`;

function json(res, code, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(text);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // ---- 测试专用路由 ----
  if (url.pathname === '/__last-headers') {
    return json(res, 200, lastRequest || { none: true });
  }
  if (url.pathname === '/__reset-headers') {
    lastRequest = null;
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/__page/video') {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] });
    return res.end(TEST_PAGE);
  }
  if (url.pathname === '/__page/mse') {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] });
    return res.end(MSE_PAGE);
  }
  if (url.pathname === '/__page/mse-webm') {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] });
    return res.end(MSE_WEBM_PAGE);
  }
  if (url.pathname === '/__page/mse-webm-video') {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] });
    return res.end(MSE_WEBM_VIDEO_PAGE);
  }
  if (url.pathname === '/__page/resume') {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] });
    return res.end(RESUME_PAGE);
  }
  if (url.pathname === '/__page/tracks') {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] });
    return res.end(TRACKS_PAGE);
  }
  if (url.pathname === '/__page/yt-ump') {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] });
    return res.end(YT_UMP_PAGE);
  }
  // 站点自有容器：URL 没有媒体扩展名、MIME 也不是 video/audio ——
  // 嗅探层的两份判据都落空，正是"只能抓流"的那种形态
  if (url.pathname === '/videoplayback') {
    const body = await readFile(join(ROOT, 'dash-split', 'chunk-stream0-00001.m4s'));
    res.writeHead(200, {
      'Content-Type': 'application/vnd.yt-ump',
      'Content-Length': body.length,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    return res.end(body);
  }

  try {
    // 归一化并挡掉越界路径
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const st = await stat(file);
    if (!st.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    const body = await readFile(file);
    const ext = extname(file).toLowerCase();

    // 音频轨要按音频发。真实站点就是这样（B 站的音频轨响应是 `audio/mp4`），
    // 而扩展的嗅探分类正是靠 MIME 把"音频轨"和"视频轨"分开的 ——
    // 全都发 video/mp4 的话，B 站那个形态在测试里根本复现不出来。
    const audioTrack = ext === '.m4s' && /stream1/.test(url.pathname);
    const contentType = audioTrack ? 'audio/mp4' : (TYPES[ext] || 'application/octet-stream');

    // 记下请求头 —— Referer 注入验证就靠它
    lastRequest = {
      method: req.method,
      path: url.pathname,
      referer: req.headers.referer || null,
      origin: req.headers.origin || null,
      range: req.headers.range || null,
      userAgent: req.headers['user-agent'] || null,
      at: Date.now(),
    };

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': body.length,
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    res.end(body);
    // 请求日志走 stderr：沙箱禁止管道，stdout 抓不到，不如直接让它可见
    process.stderr.write(`  ${res.statusCode} ${url.pathname}\n`);
  } catch (err) {
    process.stderr.write(`  404 ${req.url} (${err.code || err.message})\n`);
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`fixture server → http://127.0.0.1:${PORT}/\n`);
  process.stderr.write(`  测试页：http://127.0.0.1:${PORT}/__page/video\n`);
  process.stderr.write(`  独立轨道页：http://127.0.0.1:${PORT}/__page/tracks\n`);
  process.stderr.write(`  请求头回显：http://127.0.0.1:${PORT}/__last-headers\n`);
});
