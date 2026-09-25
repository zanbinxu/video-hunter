/**
 * Video Hunter —— 页面内容脚本（自包含，不用 import）。
 *
 * 为什么这里不 import core/classify.js：
 *   内容脚本是用 chrome.scripting.executeScript({files}) 注入的经典脚本，
 *   静态 import 不可用。为了一个几十行的分类函数去搭构建步骤不值得，
 *   所以这里只做「页面侧才做得到」的三件事：
 *     1. 在页面上下文里 fetch（Referer / Cookie 天然正确）
 *     2. 扫描真实的 <video> 元素，拿到 blob: / MSE 这种嗅探抓不到的信息
 *     3. 给 <video> 挂一个下载按钮
 *
 * 消息名必须和 src/core/constants.js 里的 MSG 保持一致。
 */
(() => {
  const FLAG = '__videoHunterReady__';
  if (window[FLAG]) return;
  window[FLAG] = true;

  const MSG = {
    PAGE_PING: 'vh:page-ping',
    PAGE_FETCH: 'vh:page-fetch',
    PAGE_SCAN: 'vh:page-scan',
    PAGE_READY: 'vh:page-ready',
    ARM_RECORDING: 'vh:arm-recording',
    MEDIA_ENDED: 'vh:media-ended',
    MSE_ARM: 'vh:mse-arm',
    MSE_BUFFER: 'vh:mse-buffer',
    MSE_BOUNDARY: 'vh:mse-boundary',
    RECORD_TITLE_UPDATE: 'vh:record-title-update',
    RECORD_PLAYER_PROGRESS: 'vh:record-player-progress',
    INJECT_PAGE_BUTTONS: 'vh:inject-page-buttons',
    PAGE_DOWNLOAD_CLICK: 'vh:page-download-click',
  };

  /* ---------------------------------------------------------------- *
   * MSE 抓流桥
   *
   * 主世界的钩子（mse-hook.js）通过 window.postMessage 把 appendBuffer 的
   * 原始字节递过来；隔离世界在这边收下、编码成 base64、转交给扩展。
   *
   * 为什么是 base64：chrome.runtime.sendMessage 走的是 JSON 序列化，
   * 二进制过不去。代价是体积多三分之一，换来的是"不用重新编码"——
   * 拿到的就是播放器已经解密好的原始码流。
   * ---------------------------------------------------------------- */

  let mseArmed = false;
  let mseSeq = 0;
  /** **送到了**的段数（没送到的不算，见下面 sendOnce 的注释） */
  let mseForwarded = 0;
  /** 页面没给出内容（空 base64）的次数 */
  let mseEmpty = 0;
  /** 重试之后仍然没送进离屏文档的段数 —— 这些段的画面/声音是真的缺了 */
  let mseSendFailed = 0;

  /* ---------------------------------------------------------------- *
   * 0b. 边界探测与单页列表切集：这个视频播完了、页面要换下一个了
   *
   * 播放列表 / 自动连播会把好几个视频连着放。如果不管，抓到的就是一条
   * 连续的时间轴 —— 合并出来是**一个**文件，里面装着好几集，用户没法分开保存。
   *
   * 所以这里盯住五个信号，任何一个出现就报一次边界，让后台把当前这段收尾成
   * 一个完整文件、清空缓冲接着抓下一个：
   *
   *   · `ended`      —— 最准的"这一集播完了"
   *   · `emptied` / `loadstart` —— 媒体元素换了资源（用户点了下一个、站点切集）
   *   · 新的 `addSourceBuffer`  —— 播放器重建了 MediaSource（换集常见做法）
   *   · 单页播放列表高亮项变动  —— 侧边栏集数切换（如从 01 集切到 02 集）
   *   · 播放进度到头 / 归零重播 —— 进度条到达 99.5% 或从末尾跳回开头
   * ---------------------------------------------------------------- */

  let boundaryWatched = new WeakSet();
  let boundaryTimer = null;
  let boundaryScanTimer = null;
  let lastKnownEpisodeTitle = '';
  const videoProgressTracker = new WeakMap();

  function isAccentColor(str) {
    if (!str || typeof str !== 'string') return false;
    const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return false;
    const r = parseInt(m[1], 10);
    const g = parseInt(m[2], 10);
    const b = parseInt(m[3], 10);
    // 高亮红/橙色系（如用户界面的红字 #ef4444 或 rgb(239,68,68)）
    if (r > 160 && r > g * 1.35 && r > b * 1.35) return true;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max > 120 && (max - min) > 70) return true;
    return false;
  }

  function extractCleanText(el) {
    if (!el) return '';
    try {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('script, style, svg, button, .duration, .time, [class*="time"]').forEach((c) => c.remove());
      let text = clone.innerText || clone.textContent || '';
      text = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
      text = text.replace(/\(?\b\d{1,2}:\d{2}(?::\d{2})?\b\)?$/g, '').trim();
      text = text.replace(/^(正在播放|播放中|已学完|试看|连播)[:：\s]*/g, '').trim();
      return text;
    } catch {
      return '';
    }
  }

  function isValidEpisodeTitle(text) {
    if (!text || typeof text !== 'string') return false;
    const clean = text.trim();
    if (clean.length < 3 || clean.length > 120) return false;
    if (/^[\d\s:.-]+$/.test(clean)) return false;
    if (/^(首页|目录|课程介绍|下载|播放|暂停|全屏|倍速|弹幕|选集|上一集|下一集)$/.test(clean)) return false;
    return true;
  }

  function detectPlaylistEpisodeTitle() {
    // 1. 扫描具有播放中/活跃态类名的元素
    const candidateSelectors = [
      '.video-item.active', '.catalog-item.active', '.lesson-item.active', '.chapter-item.active',
      '.episode-item.active', '.section-item.active', '.list-item.active',
      '.cur-play', '.video-title-active', '.play-item-active', '.playing-item',
      '[aria-selected="true"]', '[aria-current="true"]', '[data-active="true"]',
      '.active', '.current', '.selected', '.playing', '.is-active', '.is-current',
      '[class*="active"][class*="item"]', '[class*="current"][class*="item"]',
      '[class*="playing"][class*="item"]',
    ];

    for (const sel of candidateSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const text = extractCleanText(el);
        if (isValidEpisodeTitle(text)) return text;
      }
    }

    // 2. 扫描包含音频波形/播放图标的列表项
    const playingIcons = document.querySelectorAll('svg, i, span, img');
    for (const icon of playingIcons) {
      const cls = (icon.className && typeof icon.className === 'string') ? icon.className.toLowerCase() : '';
      const name = (icon.getAttribute('name') || icon.getAttribute('data-icon') || '').toLowerCase();
      const isPlaying = cls.includes('play') || cls.includes('equalizer') || cls.includes('wave')
        || cls.includes('volume') || cls.includes('music') || name.includes('play') || name.includes('sound');
      if (isPlaying) {
        const parent = icon.closest('li, [role="listitem"], .list-group-item, div[class*="item"], div[class*="lesson"]');
        if (parent) {
          const text = extractCleanText(parent);
          if (isValidEpisodeTitle(text)) return text;
        }
      }
    }

    // 3. 扫描列表中具有突出红色/强调色样式的项目（如单页连播站点高亮集数）
    const listItems = document.querySelectorAll('li, [role="listitem"], div[class*="item"], div[class*="lesson"], div[class*="chapter"]');
    for (const item of listItems) {
      if (item.children.length > 10) continue;
      const style = window.getComputedStyle(item);
      if (isAccentColor(style.color)) {
        const text = extractCleanText(item);
        if (isValidEpisodeTitle(text)) return text;
      }
      for (const span of item.querySelectorAll('span, a, p, div')) {
        const sStyle = window.getComputedStyle(span);
        if (isAccentColor(sStyle.color)) {
          const text = extractCleanText(span);
          if (isValidEpisodeTitle(text)) return text;
        }
      }
    }

    // 4. 扫描视频播放器区域下方或上方的专属标题栏
    const titleContainers = document.querySelectorAll(
      '.video-title, .course-title, .lesson-title, .player-title, [class*="video-title"], [class*="player-title"]'
    );
    for (const el of titleContainers) {
      const text = extractCleanText(el);
      if (isValidEpisodeTitle(text)) return text;
    }

    return '';
  }

  /**
   * 自动切集重置起点看护器：
   * 在单页播放列表自动连播切入下一集时，很多平台（如常见单页连播站点、B站等）会自动读取
   * 播放记忆（例如跳到上次看过的 11:35 或中间位置），导致第二集录制从中间开始、
   * 缺失前半段。看护器在切集发生后的起播窗口（10秒内）自动将视频进度条拉回 0:00，
   * 确保完整录制整集。
   */
  const episodeRewindGuard = {
    armed: false,
    armedAt: 0,
    rewound: false,

    arm(reason = '') {
      this.armed = true;
      this.armedAt = Date.now();
      this.rewound = false;
      console.info(`[vh/content] 切集看护已激活 (${reason})，将在新一集起播时守卫拉回 0:00 起点`);
    },

    disarm() {
      this.armed = false;
    },

    check(v) {
      if (!this.armed || !v || this.rewound) return;
      const elapsed = Date.now() - this.armedAt;
      if (elapsed > 10000) {
        this.disarm();
        return;
      }

      const cur = Number.isFinite(v.currentTime) ? v.currentTime : 0;
      // 判定是否是播放记忆的突发跳跃：
      // 在起播前 5 秒内，如果当前时间突变到大于 2.0 秒且显著大于自然播放耗时，说明被播放记忆拉向了中间，立即拉回到 0:00 起点
      const naturalMax = (elapsed / 1000) + 1.5;
      if (cur > 2.0 && cur > naturalMax) {
        this.rewound = true;
        console.info(`[vh/content] 发现新一集由于播放记忆跳转到中间 (${cur.toFixed(1)}s)，自动拉回进度条起点 0:00 以完整录制新集`);
        try {
          v.currentTime = 0;
        } catch (e) {
          console.warn('[vh/content] 自动拉回起点失败：', e);
        }
        setTimeout(() => this.disarm(), 1500);
      }
    },
  };

  let lastProgressReportTime = 0;

  function reportBoundary(reason, extra = {}) {
    if (!mseArmed) return;
    const now = Date.now();
    if (boundaryTimer && now - boundaryTimer < 6000) return;
    boundaryTimer = now;
    chrome.runtime.sendMessage({ type: MSG.MSE_BOUNDARY, reason, pageTitle: document.title || '', ...extra })
      .then((res) => {
        if (res && res.ok === false) boundaryTimer = null;
      })
      .catch(() => { boundaryTimer = null; });
  }

  function checkEpisodeAndProgress() {
    if (!mseArmed) return;

    // 1. 扫描当前播放的具体集数标题并实时向后台同步
    const curTitle = detectPlaylistEpisodeTitle();
    if (curTitle) {
      if (!lastKnownEpisodeTitle) {
        lastKnownEpisodeTitle = curTitle;
        chrome.runtime.sendMessage({
          type: MSG.RECORD_TITLE_UPDATE,
          title: curTitle,
          pageTitle: document.title || '',
        }).catch(() => {});
      } else if (curTitle !== lastKnownEpisodeTitle) {
        // 单页应用在未刷新情况下切换了播放列表集数
        const prevTitle = lastKnownEpisodeTitle;
        lastKnownEpisodeTitle = curTitle;
        episodeRewindGuard.arm(`集数切换: ${curTitle}`);
        reportBoundary('episode-title-change', { prevTitle, nextTitle: curTitle });
        return;
      }
    }

    // 2. 监测 <video> 的播放进度与尾部跳转
    const vids = document.querySelectorAll('video');
    let activeVideo = null;

    for (const v of vids) {
      episodeRewindGuard.check(v);

      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      const cur = Number.isFinite(v.currentTime) ? v.currentTime : 0;

      if (!activeVideo && (!v.paused || cur > 0)) {
        activeVideo = v;
      }

      if (dur > 15) {
        let tracker = videoProgressTracker.get(v);
        if (!tracker) {
          tracker = { maxTime: cur, lastTime: cur, reportedEnd: false };
          videoProgressTracker.set(v, tracker);
        }
        if (cur > tracker.maxTime) tracker.maxTime = cur;

        // 条件 A：播放进度到达最后 0.8 秒（即将自动切集或已播完）
        if (!tracker.reportedEnd && cur >= dur - 0.8) {
          tracker.reportedEnd = true;
          episodeRewindGuard.arm('播至末尾');
          reportBoundary('video-near-end', { nextTitle: curTitle });
        }

        // 条件 B：先前播放过较长时间（> 20 秒），播放位置突然回跳到前 2.5 秒以内
        if (tracker.maxTime >= Math.min(dur - 2, 20) && cur <= 2.5 && (tracker.lastTime - cur) > 10) {
          tracker.maxTime = cur;
          tracker.reportedEnd = false;
          episodeRewindGuard.arm('播放位置复位');
          reportBoundary('video-time-reset', { nextTitle: curTitle });
        }

        tracker.lastTime = cur;
      }
    }

    // 3. 上报当前活跃播放器的实时进度与总时长
    if (!activeVideo && vids.length > 0) {
      activeVideo = [...vids].sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
    }
    const now = Date.now();
    if (activeVideo && (now - lastProgressReportTime >= 800)) {
      lastProgressReportTime = now;
      const cur = Number.isFinite(activeVideo.currentTime) ? activeVideo.currentTime : 0;
      const dur = Number.isFinite(activeVideo.duration) && activeVideo.duration > 0 ? activeVideo.duration : 0;
      chrome.runtime.sendMessage({
        type: MSG.RECORD_PLAYER_PROGRESS,
        currentTime: cur,
        duration: dur,
        paused: !!activeVideo.paused,
      }).catch(() => {});
    }
  }

  function watchBoundaries() {
    const attach = (m) => {
      if (boundaryWatched.has(m)) return;
      boundaryWatched.add(m);
      m.addEventListener('ended', () => {
        episodeRewindGuard.arm('ended事件');
        reportBoundary('ended');
      });
      m.addEventListener('emptied', () => reportBoundary('emptied'));
      m.addEventListener('loadstart', () => {
        episodeRewindGuard.check(m);
        reportBoundary('loadstart');
      });
      m.addEventListener('loadedmetadata', () => episodeRewindGuard.check(m));
      m.addEventListener('canplay', () => episodeRewindGuard.check(m));
      m.addEventListener('play', () => episodeRewindGuard.check(m));
      m.addEventListener('playing', () => episodeRewindGuard.check(m));
      m.addEventListener('seeked', () => episodeRewindGuard.check(m));
      m.addEventListener('timeupdate', () => episodeRewindGuard.check(m));
    };
    for (const m of document.querySelectorAll('video,audio')) attach(m);
    checkEpisodeAndProgress();
  }

  function boundaryScanStart() {
    watchBoundaries();
    // 单页应用里换集可能换出一个全新的 <video>，且列表可能异步渲染，持续轮询看护
    if (!boundaryScanTimer) boundaryScanTimer = setInterval(watchBoundaries, 1000);
  }

  function boundaryScanStop() {
    if (boundaryScanTimer) { clearInterval(boundaryScanTimer); boundaryScanTimer = null; }
  }

  window.addEventListener('message', (event) => {
    // 只看本窗口发来的 —— 页面自己也用 postMessage，不能把别人的消息当数据收
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__vh !== 'mse') return;
    // 新的 SourceBuffer = 播放器重建了 MediaSource，通常是换了一个视频。
    // 开头那两个（视频一条、音频一条）不算边界 —— 那时还没抓到任何数据。
    if (msg.kind === 'sourcebuffer') {
      if (mseArmed && mseSeq > 0) reportBoundary('sourcebuffer');
      return;
    }
    if (msg.kind !== 'buffer') return;
    if (!mseArmed) return;

    // 钩子在主世界已经编码好了（跨世界传二进制不可靠，传字符串才稳）。
    // 这里只做校验和转交。
    const base64 = typeof msg.base64 === 'string' ? msg.base64 : '';
    if (!base64) {
      mseEmpty += 1;
      return;
    }
    // 转交要**送到才算数**。
    //
    // 原来这里是 `sendMessage(...).catch(() => {})`，而且 `mseForwarded` 在发之前
    // 就加过了 —— 万一离屏文档还没建好（`ensureOffscreen` 只负责 createDocument，
    // 不等它的脚本注册好监听）、或者中途被回收，这一段就静默丢了，而面板上的
    // "已转发 N 段"照样包含它。抓流最怕的就是这种"看起来在跑、其实缺了一段"。
    //
    // 现在：没送到就**重试一次**（最常见的原因就是文档刚创建），仍然失败才计入
    // `mseSendFailed` 并如实上报（收尾时会写进产物提示里）。
    // 重试晚几百毫秒到达没关系：合并前会按时间戳重排（normalizeTrackSamples）。
    const sendOnce = (attempt) => chrome.runtime.sendMessage({
      type: MSG.MSE_BUFFER,
      seq: mseSeq,
      mime: msg.mime || '',
      // 没有 mime 时靠它区分"这是哪条 SourceBuffer 的流"（见 mse-hook 里的注释）
      sbId: msg.sbId || '',
      base64,
    }).then((res) => {
      if (res?.ok) { mseForwarded += 1; return; }
      throw new Error('离屏文档没有接住这一段');
    }).catch((err) => {
      if (attempt === 0) {
        setTimeout(() => sendOnce(1), 250);
        return;
      }
      mseSendFailed += 1;
      // 只在第一段丢的时候写一句日志：真丢起来是成片的，刷屏没有意义
      if (mseSendFailed === 1) {
        console.info('[vh/mse] 有数据段没能送进离屏文档（那一段内容会缺）：', err?.message || err);
      }
    });
    sendOnce(0);
    mseSeq += 1;
  });

  /* ---------------------------------------------------------------- *
   * 0. 录制待命
   *
   * 录制兜底要求"从头播一遍"，而**光刷新页面是不够的**：
   * 不少站点会记住播放位置，刷新之后接着上次的地方播；还有的是
   * 单页应用，刷新后视频元素过一会儿才挂上来。
   * 所以这里要做三件事：回到第一帧、开始播放、盯着播放结束。
   * ---------------------------------------------------------------- */

  let recordingArmed = false;
  const armedMedia = new WeakSet();
  /** 用户真正想录的那个 <video>（页面上最大的可见视频），见 pickRecordingTarget */
  let recordingTarget = null;

  /**
   * 起播看护：把"续播上次位置"扳回开头。
   *
   * 踩过的坑，值得写清楚：抓流会刷新一次页面，让钩子从头收数据。但**很多站点
   * 会记住你上次看到哪儿**，页面加载完之后自己把 `currentTime` 设回去。
   * 于是采集到的时间轴就断了：
   *
   *     抓到 0~12.5 秒  →（站点把位置设到 12:00）→  抓到 720.8 秒以后
   *
   * 分片里带的解码时间戳是连续的，所以合并出来的文件里横着一段 708 秒的空洞，
   * **用户看到的就是"前 12 分钟怎么拖都拖不动"**。
   *
   * 一次性的 `currentTime = 0`（armOne 里那个）挡不住它 —— 站点的恢复动作发生在
   * 拿到 metadata 之后、甚至等某个接口回来之后。所以在开头这段时间里持续看护。
   *
   * ## 判据必须是"跳变"，不是"位置大于 2 秒"
   *
   * 第一版写成"currentTime > 2 就扳回 0"，那是个严重错误：正常播放两秒之后
   * 位置当然大于 2 —— 结果会把视频每 400 毫秒按回开头，连续按 15 秒。
   * 所以改成看**两次观察之间的跳变**：轮询间隔 400 毫秒，正常播放在这期间最多
   * 前进 0.4 秒左右，超过 2 秒就一定是被谁设了位置（站点恢复、或用户拖动）。
   */
  const GUARD_MS = 15000;
  const GUARD_POLL_MS = 400;
  // 两次观察之间"比正常播放多跑了多少"才算跳变。正常播放的预期前进量会按
  // **播放倍速**算出来（见下面），所以这个余量只需要覆盖调度抖动。
  const GUARD_TOLERANCE = 2.5;
  let guardTimer = null;
  /** 这次要"看住"的位置：0 = 从头（老行为），> 0 = 用户点抓流时所在的那一秒 */
  let guardTarget = 0;

  /**
   * 把播放位置扳到目标。
   *
   * 两种方向都要管：
   *   · 目标是 0（从头抓）→ 只在位置**往前跳**时扳回（站点续播），老行为不变；
   *   · 目标 > 0（从当前进度抓）→ 站点若从头播就把位置**往前拨**到目标，
   *     站点若自己播到别处（或中途把位置重置回 0）也拉回目标。
   *
   * 为什么容差是 2.5 秒：目标是 3600 秒时，站点自己恢复到 3599 秒是好事，
   * 不该为了一秒去和播放器抢位置。
   */
  function guardStart(targetTime) {
    // 目标可以先更新（重新武装时换一个位置），窗口已经在跑就不重开一轮 ——
    // 刷新之后内容脚本是全新的，本来就没有旧窗口；这里主要是别让重复的
    // arm 消息把"还要看多久"一直往后推。
    guardTarget = Math.max(0, Number(targetTime) || 0);
    if (guardTimer) return;
    const until = Date.now() + GUARD_MS;
    const lastSeen = new Map(); // 元素 -> { time, wallMs }
    const complained = new WeakSet();
    // 跟踪每个元素的定位状态：防止在正在 seek 或刚触发 seek 的缓冲期间重复拨动导致播放器死循环
    const seekState = new WeakMap(); // 元素 -> { target, requestedAt, reached }

    const seekTo = (m, target) => {
      try {
        if (m.seeking) return false;
        if (m.readyState < 1) {
          m.addEventListener('loadedmetadata', () => {
            try { if (!m.seeking) m.currentTime = target; } catch { /* ignore */ }
          }, { once: true });
          return false;
        }
        m.currentTime = target;
        // seek 结束后尝试自动恢复播放，避免一直停留在黑屏/首帧
        const onSeeked = () => {
          m.removeEventListener('seeked', onSeeked);
          if (m.paused && typeof m.play === 'function') {
            m.play().catch(() => { /* autoplay 限制静默忽略 */ });
          }
        };
        m.addEventListener('seeked', onSeeked, { once: true });
        return true;
      } catch {
        return false; // metadata 还没到，下一轮再试
      }
    };

    const pullBack = () => {
      const now = Date.now();
      for (const m of document.querySelectorAll('video,audio')) {
        let t;
        try { t = m.currentTime; } catch { continue; }
        if (!Number.isFinite(t)) continue;

        // 如果媒体当前正在 seek 中，绝不能再去碰 currentTime 打断它
        if (m.seeking) {
          lastSeen.set(m, { time: t, wallMs: now });
          continue;
        }

        let state = seekState.get(m);
        if (!state || state.target !== guardTarget) {
          state = { target: guardTarget, requestedAt: 0, reached: false };
          seekState.set(m, state);
        }

        const prev = lastSeen.get(m);
        // 播放倍速要算进去 —— 12 倍速下，400 毫秒的轮询间隔里播放位置会前进
        // 4.8 秒，那是**正常播放**，不是跳变。
        // 这里踩过一次：第一版只比较"两次观察之间前进了多少"，于是用户一开
        // 12 倍速就被当成"页面把位置设走了"，看护立刻把视频扳回开头 ——
        // 用户看到的就是"我换个倍速，它就把进度条拉回头顶、还打断了抓流"。
        const rate = Math.max(1, Math.abs(Number(m.playbackRate) || 1));
        const expected = prev ? ((now - prev.wallMs) / 1000) * rate : 0;

        let action = '';
        if (guardTarget > 0) {
          // 目标 > 0（从当前进度抓）
          if (t >= guardTarget - GUARD_TOLERANCE) {
            // 已经到达目标区域
            state.reached = true;
            if (prev && (t - prev.time) > expected + GUARD_TOLERANCE
              && t > guardTarget + GUARD_TOLERANCE) {
              action = 'ahead';
            }
          } else {
            // 当前位置在目标之前（如页面加载初期的 0 秒，或中途被重置回 0）
            if (state.reached) {
              // 曾经到达过目标，后来被重置回开头了 → 必须拉回目标
              action = 'behind';
            } else if (!state.requestedAt || (now - state.requestedAt > 3500)) {
              // 刚进入或者距离上次请求 seek 已经超过 3.5 秒仍未到达 → 触发一次定位，并给足缓冲时间
              action = 'behind';
            }
          }
        } else if (prev) {
          // 目标是 0（老行为）：只有"往前跳"才扳回
          if ((t - prev.time) > expected + GUARD_TOLERANCE) action = 'jump';
        } else if (t > 3 + expected) {
          // 第一次看到它：刚加载完的页面不该已经在 3 秒之后（外加倍速允许的量）
          action = 'jump';
        }

        if (action) {
          const from = t;
          if (seekTo(m, guardTarget)) {
            state.requestedAt = now;
            t = guardTarget;
            if (!complained.has(m)) {
              complained.add(m);
              console.log(`[Video Hunter] 播放位置在 ${from.toFixed(1)} 秒（${action}），`
                + `已拨到 ${guardTarget.toFixed(1)} 秒`
                + (guardTarget > 0
                  ? '（你要的是"从当前进度开始抓"）'
                  : '（抓流/录制需要完整的一份；如果你是自己拖的进度条，抱歉）'));
            }
          }
        }
        lastSeen.set(m, { time: t, wallMs: now });
      }
    };

    pullBack();
    guardTimer = setInterval(() => {
      if (Date.now() > until) { clearInterval(guardTimer); guardTimer = null; return; }
      pullBack();
    }, GUARD_POLL_MS);
  }

  function armOne(m) {
    if (armedMedia.has(m)) return;
    armedMedia.add(m);

    try {
      // currentTime 在还没拿到 metadata 时会抛，所以要 try
      if (m.currentTime > 0) m.currentTime = 0;
    } catch { /* metadata 还没到，下面 loadedmetadata 里再试一次 */ }
    m.addEventListener('loadedmetadata', () => {
      try { if (m.currentTime > 0) m.currentTime = 0; } catch { /* ignore */ }
    }, { once: true });

    if (typeof m.play === 'function') m.play().catch(() => { /* 需要手势时会被拒，忽略 */ });

    // 播完就告诉后台 —— 用户要的是"自动停、自动存"，不是让他盯着计时器。
    //
    // ⚠️ 但**只有那个"录制目标"播完才算数**。页面上往往不止一个 `<video>`
    // （广告、预览、背景动画、花絮小窗），随便哪个结束都去停录制的话，
    // 用户真正的录制会在几秒内被打断，而面板上还写着「录制中」。
    m.addEventListener('ended', () => {
      // 真的播到头了吗？`ended` 在源被换掉之类的边缘情况下也可能冒出来，
      // 这种"没播到头就结束"的不该算。
      const reachedEnd = !Number.isFinite(m.duration) || m.duration <= 0 || m.currentTime >= m.duration - 1.5;
      chrome.runtime.sendMessage({
        type: MSG.MEDIA_ENDED,
        fromTarget: m === recordingTarget && reachedEnd,
      }).catch(() => {});
    }, { once: true });
  }

  /** 页面上最大的那个可见视频 —— 它就是用户想录的东西 */
  function pickRecordingTarget() {
    const vids = [...document.querySelectorAll('video')];
    if (!vids.length) return null;
    const visible = vids.filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width >= 200 && r.height >= 120 && r.bottom > 0 && r.top < innerHeight;
    });
    const pool = visible.length ? visible : vids;
    pool.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
    return pool[0] || null;
  }

  function armRecording() {
    if (recordingArmed) return;
    recordingArmed = true;

    const scan = () => {
      // 每次扫描都重挑一次目标：站点换集/换播放器会换出一个新的 <video>，
      // 也可能把原来那个撤掉
      recordingTarget = pickRecordingTarget();
      for (const m of document.querySelectorAll('video,audio')) armOne(m);
    };
    scan();

    // 单页应用里视频元素可能是几秒后才挂上来的。
    // 盯 20 秒足够覆盖绝大多数首屏加载，之后不再打扰页面。
    const timer = setInterval(scan, 1000);
    setTimeout(() => clearInterval(timer), 20000);
    guardStart();
    console.log('[Video Hunter] 已进入录制待命：视频回到第一帧并开始播放，播完会自动停止');
  }

  // 每次注入都问一句：这个标签页现在在录吗 / 在抓流吗？
  // 页面重载后内容脚本会重新注入，靠这一句才能重新进入待命状态。
  chrome.runtime.sendMessage({ type: MSG.PAGE_READY })
    .then((res) => {
      if (res && res.arm === true) armRecording();
      // 抓流：刷新之后钩子会重新注入，但转交开关是这份脚本里的变量，
      // 得问一句才能恢复，否则数据到了门口没人开门。
      if (res && res.mse === true) {
        mseArmed = true;
        mseSeq = 0;
        mseForwarded = 0;
        mseSendFailed = 0;
        window.postMessage({ __vh: 'mse-ctl', kind: 'replay_inits' }, '*');
        // ⚠️ 这里就是"刷新之后"的那条路：页面重载 → 内容脚本重新注入 → 问后台
        // 现在在不在抓流。**要抓的那一秒也要一起带回来**，否则看护会把位置
        // 扳回 0，用户点的"从当前进度开始"就白点了。
        guardStart(res.startAt);
        boundaryScanStart();
      }
    })
    .catch(() => { /* 后台没醒或者没在录，都正常 */ });

  /* ---------------------------------------------------------------- *
   * 1. 页面上下文抓取
   * ---------------------------------------------------------------- */

  async function doFetch({ url, as = 'text', headers = {} }) {
    const res = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      headers,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    if (as === 'text') return { ok: true, status: res.status, text: await res.text() };
    if (as === 'json') return { ok: true, status: res.status, json: await res.json() };
    if (as === 'base64') {
      const buf = new Uint8Array(await res.arrayBuffer());
      return { ok: true, status: res.status, base64: bytesToBase64(buf) };
    }
    return { ok: false, error: `不支持的 as=${as}` };
  }

  function bytesToBase64(bytes) {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }

  /* ---------------------------------------------------------------- *
   * 2. <video> 扫描
   * ---------------------------------------------------------------- */

  function videoSources(v) {
    const out = [];
    if (v.currentSrc) out.push(v.currentSrc);
    if (v.src && v.src !== v.currentSrc) out.push(v.src);
    for (const s of v.querySelectorAll('source')) {
      if (s.src) out.push(s.src);
    }
    return [...new Set(out)];
  }

  function scanVideos() {
    const list = [];
    document.querySelectorAll('video').forEach((v, index) => {
      const rect = v.getBoundingClientRect();
      const srcs = videoSources(v);
      list.push({
        index,
        sources: srcs,
        // blob: 说明是 MSE —— 真正的流地址在 JS 里，DOM 上看不到，
        // 只能靠 webRequest 嗅探或者录制兜底。
        isMse: srcs.length > 0 && srcs.every((s) => s.startsWith('blob:')),
        hasBlob: srcs.some((s) => s.startsWith('blob:')),
        poster: v.poster || '',
        duration: Number.isFinite(v.duration) ? v.duration : null,
        width: v.videoWidth || null,
        height: v.videoHeight || null,
        readyState: v.readyState,
        paused: v.paused,
        // 播放位置："从当前进度开始抓流"要用它（见 popup 的 startMseCapture）
        currentTime: Number.isFinite(v.currentTime) ? v.currentTime : 0,
        visible: rect.width > 40 && rect.height > 40,
        pageTitle: document.title || '',
      });
    });
    return list;
  }

  /* ---------------------------------------------------------------- *
   * 3. 页面内下载按钮
   * ---------------------------------------------------------------- */

  const STYLE = `
    :host { all: initial; }
    .wrap {
      position: fixed; z-index: 2147483646; display: flex; gap: 6px;
      font: 12px/1.4 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      pointer-events: auto;
    }
    button {
      all: unset; cursor: pointer; padding: 5px 10px; border-radius: 999px;
      color: #fff; background: linear-gradient(135deg, #4f6bff, #8b2fe8);
      box-shadow: 0 2px 10px rgba(0,0,0,.35); font-weight: 600; white-space: nowrap;
      display: inline-flex; align-items: center; gap: 4px; transition: transform .12s ease, opacity .12s ease;
    }
    button:hover { transform: translateY(-1px); }
    button:active { transform: translateY(0); opacity: .85; }
    button.ghost { background: rgba(20,20,26,.82); font-weight: 500; }
  `;

  class VideoBadge {
    constructor(video, index) {
      this.video = video;
      this.index = index;
      this.host = document.createElement('div');
      this.host.style.cssText = 'all:initial';
      // 可观测标记：内容脚本跑在隔离世界里，页面自己的 JS 看不见它，
      // 但注入的 DOM 是真实存在于页面里的。给宿主元素打个标记，
      // 自动化检查就能从页面侧确认「按钮真的注入进去了」。
      this.host.setAttribute('data-vh-badge', '1');
      this.root = this.host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = STYLE;
      this.wrap = document.createElement('div');
      this.wrap.className = 'wrap';

      this.dlBtn = document.createElement('button');
      this.dlBtn.textContent = '⬇ 下载此视频';
      this.dlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.onDownload();
      });
      this.wrap.append(this.dlBtn);

      // 第二个按钮只在「拿不到地址」的时候才有意义。
      // 给一个普通 mp4 挂「录制」按钮是误导 —— 直接下就行了。
      const srcs = videoSources(this.video);
      if (srcs.length && srcs.every((s) => s.startsWith('blob:'))) {
        this.recBtn = document.createElement('button');
        this.recBtn.className = 'ghost';
        this.recBtn.textContent = '录制';
        this.recBtn.title = '这个视频用 MSE 播放，真实地址不在 DOM 上，只能录';
        this.recBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          chrome.runtime.sendMessage({
            type: MSG.PAGE_DOWNLOAD_CLICK,
            action: 'open-recorder',
            index: this.index,
            sources: srcs,
          }).catch(() => {});
        });
        this.wrap.append(this.recBtn);
      }

      this.root.append(style, this.wrap);
      document.documentElement.appendChild(this.host);
      this.sync();
    }

    onDownload() {
      const sources = videoSources(this.video);
      chrome.runtime.sendMessage({
        type: MSG.PAGE_DOWNLOAD_CLICK,
        action: 'download',
        index: this.index,
        sources,
        isMse: sources.length > 0 && sources.every((s) => s.startsWith('blob:')),
      }).catch(() => {});
    }

    sync() {
      const v = this.video;
      if (!v.isConnected || !document.documentElement.contains(v)) {
        this.destroy();
        return false;
      }
      const r = v.getBoundingClientRect();
      const visible = r.width > 60 && r.height > 40 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      this.host.style.display = visible ? 'block' : 'none';
      if (visible) {
        const top = Math.max(4, r.top + 8);
        const left = Math.max(4, r.right - 150);
        this.wrap.style.top = `${top}px`;
        this.wrap.style.left = `${left}px`;
      }
      return true;
    }

    destroy() {
      this.host.remove();
    }
  }

  const badges = new Map(); // video element -> VideoBadge
  let buttonsEnabled = true;
  let rafPending = false;

  function syncBadges() {
    rafPending = false;
    if (!buttonsEnabled) return;
    const videos = [...document.querySelectorAll('video')];
    for (const v of videos) {
      if (!badges.has(v)) badges.set(v, new VideoBadge(v, videos.indexOf(v)));
    }
    for (const [v, badge] of badges) {
      if (!v.isConnected) {
        badge.destroy();
        badges.delete(v);
      } else {
        badge.sync();
      }
    }
  }

  function requestSync() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(syncBadges);
  }

  function setButtonsEnabled(enabled) {
    buttonsEnabled = !!enabled;
    if (!buttonsEnabled) {
      for (const [, b] of badges) b.destroy();
      badges.clear();
    } else {
      syncBadges();
    }
  }

  const observer = new MutationObserver(requestSync);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  addEventListener('scroll', requestSync, { passive: true, capture: true });
  addEventListener('resize', requestSync, { passive: true });
  setInterval(requestSync, 1200);

  // 内容脚本是**每次导航重新注入**的。如果开关状态只靠 popup 拨动时发消息同步，
  // 用户关掉「页面内按钮」之后一换页面按钮就又回来了 —— 设置看起来没生效。
  // 所以首帧自己从存储里读一次。
  // （这里的键名必须和 core/constants.js 的 SETTINGS_KEY 保持一致，内容脚本不能用 import。）
  try {
    chrome.storage.local.get('vh:settings', (got) => {
      const s = got && got['vh:settings'];
      if (s && s.injectPageButtons === false) setButtonsEnabled(false);
    });
  } catch { /* 没有 storage 权限时静默跳过，按钮保持默认开启 */ }

  /* ---------------------------------------------------------------- *
   * 4. 消息入口
   * ---------------------------------------------------------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg && msg.type) {
      case MSG.PAGE_PING:
        sendResponse({ ok: true, url: location.href, title: document.title });
        return false;
      case MSG.PAGE_FETCH:
        doFetch(msg).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
        return true;
      case MSG.PAGE_SCAN:
        sendResponse({ ok: true, videos: scanVideos(), url: location.href, title: document.title });
        return false;
      case MSG.INJECT_PAGE_BUTTONS:
        setButtonsEnabled(msg.enabled);
        sendResponse({ ok: true });
        return false;
      case MSG.ARM_RECORDING:
        armRecording();
        sendResponse({ ok: true, armed: true });
        return false;
      case MSG.MSE_ARM:
        mseArmed = msg.enabled !== false;
        if (mseArmed) {
          mseSeq = 0;
          mseForwarded = 0;
          mseEmpty = 0;
          mseSendFailed = 0;
          window.postMessage({ __vh: 'mse-ctl', kind: 'replay_inits' }, '*');
          // 抓流要防"站点续播上次位置"—— 那会让抓到的流中间断掉几百秒
          // （见 guardStart 的注释）。但**用户自己要求的那一秒**除外：
          // "从当前进度开始抓"就是要把位置看住在那一秒上。
          guardStart(msg.startAt);
          // 盯着"这一集播完了"，好把每个视频收尾成独立文件
          boundaryScanStart();
        } else {
          boundaryScanStop();
        }
        sendResponse({
          ok: true, armed: mseArmed, forwarded: mseForwarded, empty: mseEmpty,
          sendFailed: mseSendFailed, startAt: guardTarget,
        });
        return false;
      case 'vh:mse-stats':
        sendResponse({
          ok: true, armed: mseArmed, forwarded: mseForwarded, empty: mseEmpty,
          sendFailed: mseSendFailed,
        });
        return false;
      default:
        return false;
    }
  });

  // 页面里到底有没有 MSE —— 这个信息嗅探层拿不到，但对判断
  // 「该走解析还是该走录制」很关键。
  window.__videoHunterHasMSE = typeof window.MediaSource !== 'undefined';

  requestSync();
})();
