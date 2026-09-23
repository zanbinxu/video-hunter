/**
 * 录制管线：一条 MediaStream → 一个 MP4 文件。
 *
 * 从 offscreen.js 里抽出来是**为了可测**。
 *
 * 录制这条链路里最容易出错、也最难靠读代码确认的部分是：编码器档次协商、
 * 编码器输出与封装器期望的对接、时间戳起点平移、收尾时的 flush 顺序。
 * 而拿不到 MediaStream 就没法验它 —— `chrome.tabCapture` 要求目标标签页处于
 * 活动状态、还要求扩展被用户"调用"过，自动化环境里很难满足。
 *
 * 抽出来之后，同一条管线可以喂给它 `canvas.captureStream()` + 振荡器合成的流，
 * 在真实浏览器里跑完整流程，产物再交给 ffprobe 验。拿不拿得到 tab 流，
 * 和"这套编码封装对不对"是两件独立的事。
 *
 * 这个模块不碰 chrome.*，也不自己管会话状态。
 *
 * ⚠️ 命名规则、自动保存/切段的判据与限额**已经搬到 `src/core/capture-limits.js`**：
 * 那些是纯规则，而 service worker 与管理页也要用 —— 它们不该为了一个纯函数
 * 把这里顶上的 mp4-muxer 一起加载进来。
 */
import { Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget } from '../../vendor/mp4-muxer.mjs';
// 命名（createRecorder 要用它生成文件名）+ 偶数对齐（编码器要求宽高是偶数）
import { captureFileName, align2 } from '../core/capture-limits.js';

/**
 * 录制防空洞：把「采集源停止出帧」的那段时间从产物时间轴里剔掉。
 *
 * ## 为什么会需要它
 *
 * tabCapture 的时间戳来自**源**，不是我们的时钟。标签页被切到后台、
 * 被遮挡、屏幕锁定、机器休眠 —— 这几种情况下 Chrome 会**一帧都不给**，
 * 时间戳却在继续走。录制器老实照抄，产物里就出现一个几百秒的空洞：
 *
 *     stts: 749×960  1×35040960  12000×960     ← 中间那一"帧"占了 608 秒
 *
 * 这种文件**时长正确、能播、关键帧也在**，ffprobe 查不出问题，
 * 但播放器拖进度条时会按样本表落到"空洞之前那一帧" ——
 * 用户看到的就是「拖到两分钟，立刻跳回几秒」。实测用户录了 13 分钟的文件里
 * 有 10 分钟是这种空洞。
 *
 * ## 为什么是「压缩」而不是「切一刀」
 *
 * 空洞里本来就没有内容。把它压掉，产物变成一段连续的视频（时长变短，
 * 内容一帧不少）；切一刀只会得到两个都要自己拼的残片。
 *
 * ## 判断"整条采集停了"的依据：**墙钟空档**，不是另一条轨的媒体时间戳
 *
 * 只有**音频也在同一个时间点停住**，才说明整条采集停了、这段时间是死气，
 * 压掉它各轨的相对关系不变。如果只是视频停、音频还在走（后台标签页里音频
 * 通常不会被节流），那视频轨本来就该缺这一段，压掉会让它整体前移、音画错位。
 *
 * 第一版用"另一条轨最新的**媒体时间戳**"来判断它有没有走过这段窗口。
 * 那是个错的判据，而且错得很隐蔽：**编码器的输出进度和采集进度不是一回事**
 * （音频队列可以积 800 毫秒、视频积 200 毫秒）。于是音频那边一停摆，回头看视频，
 * 视频的"最新时间戳"还落在停摆窗口之前 —— 被判成"整条停了"，压了一刀。
 * 而那一刀是**按音频的时间轴**算出来的位移，视频随后送进来的帧减去它就成了更早的
 * 时间戳，直接撞上 mp4-muxer 的硬检查：
 *
 *     Error: Timestamps must be monotonically increasing (DTS went from 4928000 to 3499590).
 *
 * 现在改成看**墙钟**：记下"最后一次收到任何一条轨的输出"的时刻，只有**所有轨**
 * 都超过阈值没有输出，才算整条采集停过。这才是物理上正确的"采集停了"，
 * 而且和编码器队列积压无关。
 *
 * ## 每个轨的时间戳只允许前进
 *
 * 上面那个错误是**硬失败**（整场录制作废），所以除了修正判据，还留一道兜底：
 * 某条轨调整后的时间戳如果比它自己上一次的还早，就夹住不动（最多让两个样本
 * 时间戳相同，产物里表现为一帧零时长，无害）。宁可丢一点精度，也不能让
 * 整个文件因为一句异常全废掉。
 */
export function createTimelineCompressor(options = {}) {
  // 1.5 秒以下不动：正常帧间隔是 16~66 毫秒，偶尔的抖动不该被当成停摆
  const gapUs = options.gapUs ?? 1_500_000;
  const gapMs = gapUs / 1000;
  // 时钟可注入：单测里没有真实时间流逝，得喂一个假时钟才能验"停摆"这件事
  const now = typeof options.now === 'function' ? options.now : Date.now;
  // 两条轨共用一个位移量 —— 这正是"压掉死气之后音画仍然对齐"的原因
  let shiftUs = 0;
  let stalledUs = 0;
  let clamps = 0;
  let backSteps = 0;
  // 产物的真实时长 = 最晚的样本结束时间 − 最早的样本时间戳。
  // 这和"录制了多久"不是一回事：停摆被压掉之后，产物就是会短一截。
  let minUs = null;
  let maxEndUs = 0;
  /** 最后一次收到**任何一条轨**输出的墙钟时间 */
  let lastOutputMs = null;
  const stalls = [];
  const tracks = new Map();

  const trackState = (key) => {
    let state = tracks.get(key);
    if (!state) {
      state = { lastRawUs: null, lastEndUs: 0, lastAdjustedUs: null };
      tracks.set(key, state);
    }
    return state;
  };

  return {
    /** 累计被压缩掉的时长（微秒） */
    get stalledUs() { return stalledUs; },
    /** 每次停摆的时长（微秒），给上层做提示用 */
    get stalls() { return stalls; },
    get count() { return stalls.length; },
    /**
     * 万一算出负时间戳被夹到 0 的次数。正常情况下应该恒为 0，留着当哨兵。
     */
    get clamps() { return clamps; },
    /**
     * 时间戳被迫"原地踏步"的次数（本来会倒退）。
     * 正常应该恒为 0；不为 0 说明上游时间戳有回退，值得查。
     */
    get backSteps() { return backSteps; },
    /**
     * 产物的真实时长（秒）。**不是**"录了多久" ——
     * 界面上一律用这个数，别拿挂钟时间去糊弄用户。
     */
    get mediaSeconds() {
      if (minUs === null || maxEndUs <= minUs) return 0;
      return (maxEndUs - minUs) / 1e6;
    },

    /**
     * 把源时间戳映射到产物时间轴。
     * @param {string} track 轨标识（'video' / 'audio'）—— 状态按轨分开记
     * @param {number} timestampUs 源时间戳（微秒）
     * @param {number} [durationUs] 这一帧/包自身的时长
     * @returns {number} 可以交给封装器的时间戳
     */
    adjust(track, timestampUs, durationUs = 0) {
      const state = trackState(track);
      const duration = Number.isFinite(durationUs) ? durationUs : 0;
      const wallMs = now();
      // 距上一次**任何一条轨**输出过了多久
      const idleMs = lastOutputMs === null ? 0 : wallMs - lastOutputMs;
      let adjusted = timestampUs - shiftUs;

      const jumped = state.lastRawUs !== null && (timestampUs - state.lastRawUs) > gapUs;
      // 两个条件都要：媒体时间戳跳了（说明确实少了一段），而且**所有轨**都安静了
      // 那么久（说明是整条采集停了，不是某一条轨的输出落后）。
      if (jumped && idleMs > gapMs) {
        const before = adjusted;
        // 直接令"恢复后的第一帧正好接在这条轨上一帧之后"
        shiftUs = timestampUs - state.lastEndUs;
        adjusted = timestampUs - shiftUs;
        stalledUs += before - adjusted;
        stalls.push(before - adjusted);
      }

      if (adjusted < 0) {
        // 理论上到不了这里。真到了也不能把负数交给封装器 —— 那会直接抛错、整段录制全废。
        adjusted = 0;
        clamps += 1;
      }
      if (state.lastAdjustedUs !== null && adjusted < state.lastAdjustedUs) {
        // 兜底：封装器对"同一条轨的时间戳倒退"是**硬报错**
        // （`Timestamps must be monotonically increasing`），一场录制作废。
        // 宁可让两个样本时间戳相同（产物里一帧零时长），也不能炸。
        adjusted = state.lastAdjustedUs;
        backSteps += 1;
      }

      state.lastRawUs = timestampUs;
      state.lastAdjustedUs = adjusted;
      lastOutputMs = wallMs;
      if (minUs === null || adjusted < minUs) minUs = adjusted;
      const end = adjusted + duration;
      if (end > state.lastEndUs) state.lastEndUs = end;
      if (end > maxEndUs) maxEndUs = end;
      return adjusted;
    },
  };
}

/**
 * 挑一个能用的视频编码器。
 *
 * 这里踩过两个坑，都值得写下来：
 *
 * **坑一：硬件编码器不可用时，Chrome 不一定会自动回退到软件编码器。**
 * 驱动被拉黑、远程桌面、虚拟机这些情况下，默认配置的
 * `isConfigSupported` 会全部返回 false —— 但显式写
 * `hardwareAcceleration: 'prefer-software'` 就能用。
 * 所以每一档都要把三种加速偏好都问一遍。
 *
 * **坑二：原来把所有失败原因都吞掉，只抛一句「没有可用的 H.264 编码器」。**
 * 用户看到的是一句无从下手的话，我也拿不到任何定位信息。
 * 现在把每个候选的失败原因都收起来，附在错误里。
 *
 * H.264 全部不可用时退 VP9（mp4-muxer 也支持），产物仍然是 MP4 ——
 * 兼容性差一些，但总比"录不了"强。
 */
export async function pickVideoCodec(track, { frameRate, bitrate }) {
  const s = track.getSettings ? track.getSettings() : {};
  const width = align2(s.width || 1280);
  const height = align2(s.height || 720);

  // 从高到低试。基线档次（42xxxx）兼容性最好，高档次在同码率下画质更好，
  // 但能不能用取决于这台机器上的编码器，所以必须逐个问浏览器。
  const h264 = ['avc1.640028', 'avc1.4d0028', 'avc1.64001f', 'avc1.42E01E', 'avc1.42001f', 'avc1.42000d'];
  const vp9 = ['vp09.00.10.08', 'vp09.00.31.08'];
  const accels = [undefined, 'prefer-software', 'prefer-hardware'];

  const attempts = [];
  const tryList = async (list, vendorCodec) => {
    for (const accel of accels) {
      for (const codec of list) {
        const config = { codec, width, height, bitrate, framerate: frameRate };
        if (accel) config.hardwareAcceleration = accel;
        const label = `${codec}${accel ? '@' + accel : ''}`;
        try {
          const support = await VideoEncoder.isConfigSupported(config);
          if (support.supported) {
            return { config, codec, vendorCodec, width, height, hardwareAcceleration: accel || 'no-preference' };
          }
          attempts.push(`${label}:不支持`);
        } catch (err) {
          attempts.push(`${label}:${err?.name || err?.message || err}`);
        }
      }
    }
    return null;
  };

  const h264Pick = await tryList(h264, 'avc');
  if (h264Pick) return h264Pick;

  const vp9Pick = await tryList(vp9, 'vp9');
  if (vp9Pick) {
    console.info('[vh/rec] 没有可用的 H.264 编码器，退到 VP9（产物仍是 MP4，但兼容性差一些）');
    return { ...vp9Pick, fallback: true };
  }

  throw new Error(
    `这台机器上没有可用的视频编码器（H.264 与 VP9 共试了 ${attempts.length} 种配置）。`
    + `采集到的是 ${width}×${height}@${frameRate}。失败明细：${attempts.slice(0, 8).join('；')}`,
  );
}

/** 音频优先 AAC（兼容性最好），退而求其次 Opus */
export async function pickAudioCodec(track, { bitrate }) {
  const s = track.getSettings ? track.getSettings() : {};
  const sampleRate = s.sampleRate || 48000;
  const numberOfChannels = Math.min(2, s.channelCount || 2);

  const candidates = [
    { codec: 'mp4a.40.2', kind: 'aac' },
    { codec: 'opus', kind: 'opus' },
  ];
  for (const c of candidates) {
    const config = { codec: c.codec, sampleRate, numberOfChannels, bitrate };
    try {
      const support = await AudioEncoder.isConfigSupported(config);
      if (support.supported) return { config, ...c, sampleRate, numberOfChannels };
    } catch { /* 试下一个 */ }
  }
  return null;
}

/**
 * 录制目标：优先 OPFS（内存占用恒定），不可用则退内存缓冲。
 *
 * 为什么不能直接弹保存对话框：离屏文档里没有用户手势，
 * `showSaveFilePicker` 调不起来。所以先落私有存储，录制完再由有手势的页面导出。
 */
export async function createRecordTarget(fileName) {
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    return {
      kind: 'opfs',
      fileName,
      writable,
      target: new FileSystemWritableFileStreamTarget(writable, { chunkSize: 1 << 20 }),
    };
  } catch (err) {
    console.info('[vh/rec] OPFS 不可用，退回内存缓冲（长录制会吃内存）：', err);
    return { kind: 'memory', fileName, target: new ArrayBufferTarget() };
  }
}

export async function opfsFileSize(fileName) {
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(fileName);
    const file = await handle.getFile();
    return file.size;
  } catch {
    return null;
  }
}

/** 往 OPFS 写一个文件（MSE 抓流的产物走这条；不需要编码，直接落字节） */
export async function writeOpfsFile(fileName, chunks) {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  for (const c of chunks) await writable.write(c);
  await writable.close();
  return opfsFileSize(fileName);
}

/**
 * 建起一条录制管线并立刻开始编码。
 *
 * @param {object} opts
 * @param {MediaStream} opts.stream
 * @param {string} opts.fileName
 * @param {number} [opts.videoBitrate]
 * @param {number} [opts.frameRate]
 * @param {number} [opts.audioBitrate]
 * @param {boolean} [opts.monitorAudio] 把采集到的音频接回扬声器（否则采集期间用户听不见）
 * @param {(err:Error)=>void} [opts.onError]
 * @returns {Promise<object>} 录制句柄，含 stop() / stats()
 */
export async function createRecorder(opts) {
  const {
    stream,
    fileName,
    videoBitrate = 4000000,
    frameRate = 30,
    audioBitrate = 128000,
    monitorAudio = true,
    // 超过这个长度的采集停摆会被当成死气压缩掉；测试里会调小它
    stallGapUs = 1_500_000,
    onError,
  } = opts;

  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) throw new Error('采集流里没有视频轨');
  const audioTrack = stream.getAudioTracks()[0] || null;

  const video = await pickVideoCodec(videoTrack, { frameRate, bitrate: videoBitrate });
  const audio = audioTrack ? await pickAudioCodec(audioTrack, { bitrate: audioBitrate }) : null;

  const recTarget = await createRecordTarget(fileName);

  const muxer = new Muxer({
    target: recTarget.target,
    video: { codec: video.vendorCodec, width: video.width, height: video.height, frameRate },
    audio: audio
      ? { codec: audio.kind, numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate }
      : undefined,
    // 内存模式可以最后把 moov 挪到前面（快启动）；OPFS 是顺序写，做不到
    fastStart: recTarget.kind === 'memory' ? 'in-memory' : false,
    // MediaStreamTrackProcessor 的时间戳起点不是 0，必须让封装器自己平移
    firstTimestampBehavior: 'offset',
  });

  // 两条轨共用一个压洞器：只有"大家一起停"才算死气（理由见 createTimelineCompressor）
  const clock = createTimelineCompressor({ gapUs: stallGapUs });

  const session = {
    stream,
    videoTrack,
    audioTrack,
    videoEncoder: null,
    audioEncoder: null,
    muxer,
    clock,
    recTarget,
    fileName,
    startedAt: Date.now(),
    frames: 0,
    dropped: 0,
    bytes: 0,
    stopped: false,
    failure: null,
    audioCtx: null,
    readers: [],
  };

  const fail = (err) => {
    if (session.stopped) return;
    session.failure = session.failure || err;
    console.error('[vh/rec] 编码出错：', err);
    try { onError?.(err); } catch { /* 上报失败不该再引发一次失败 */ }
  };

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        // 第三个参数显式给时间戳：采集停摆过的那段不写进产物（见 createTimelineCompressor）
        muxer.addVideoChunk(chunk, meta, clock.adjust('video', chunk.timestamp, chunk.duration || 0));
        session.bytes += chunk.byteLength;
      } catch (err) { fail(err); }
    },
    error: fail,
  });
  videoEncoder.configure(video.config);
  session.videoEncoder = videoEncoder;

  let audioEncoder = null;
  if (audio && audioTrack) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        try {
          muxer.addAudioChunk(chunk, meta, clock.adjust('audio', chunk.timestamp, chunk.duration || 0));
          session.bytes += chunk.byteLength;
        } catch (err) { fail(err); }
      },
      error: fail,
    });
    audioEncoder.configure(audio.config);
  }
  session.audioEncoder = audioEncoder;

  // 采集会接管标签页的音频输出 —— 不接回扬声器的话用户就听不见了
  if (monitorAudio && audioTrack) {
    try {
      const ctx = new AudioContext();
      ctx.createMediaStreamSource(stream).connect(ctx.destination);
      session.audioCtx = ctx;
    } catch (err) {
      console.info('[vh/rec] 监听回放建立失败（不影响录制）：', err);
    }
  }

  // ---- 视频泵 ----
  const videoProcessor = new MediaStreamTrackProcessor({ track: videoTrack });
  const videoReader = videoProcessor.readable.getReader();
  session.readers.push(videoReader);
  const keyFrameEvery = Math.max(1, Math.round(frameRate * 2));

  const videoPump = (async () => {
    let i = 0;
    try {
      for (;;) {
        const { done, value: frame } = await videoReader.read();
        if (done) break;
        if (session.stopped || session.failure) { frame.close(); break; }
        // 编码跟不上时主动丢帧，而不是让队列无限涨 —— 录制要的是「跟得上」，
        // 不是「一帧不落」；队列爆掉会让整个进程卡死。
        if (videoEncoder.encodeQueueSize > 6) {
          session.dropped += 1;
          frame.close();
          continue;
        }
        videoEncoder.encode(frame, { keyFrame: i % keyFrameEvery === 0 });
        frame.close();
        session.frames += 1;
        i += 1;
      }
    } catch (err) {
      if (!session.stopped) fail(err);
    }
  })();

  // ---- 音频泵 ----
  let audioPump = null;
  if (audioEncoder && audioTrack) {
    const audioProcessor = new MediaStreamTrackProcessor({ track: audioTrack });
    const audioReader = audioProcessor.readable.getReader();
    session.readers.push(audioReader);
    audioPump = (async () => {
      try {
        for (;;) {
          const { done, value: data } = await audioReader.read();
          if (done) break;
          if (session.stopped || session.failure) { data.close(); break; }
          if (audioEncoder.encodeQueueSize > 40) { data.close(); continue; }
          audioEncoder.encode(data);
          data.close();
        }
      } catch (err) {
        if (!session.stopped) fail(err);
      }
    })();
  }

  return {
    fileName,
    targetKind: recTarget.kind,
    videoCodec: video.codec,
    videoVendor: video.vendorCodec,
    // H.264 用不了、退到 VP9 时告诉上层，界面上要说明白
    videoFallback: !!video.fallback,
    audioCodec: audio?.codec || null,
    width: video.width,
    height: video.height,
    hasAudio: !!audioEncoder,
    // 调用方要挂 'ended' 监听来判断"用户把标签页关了"，所以轨道得暴露出去
    videoTrack,
    audioTrack,
    get stopped() { return session.stopped; },
    get failure() { return session.failure; },
    /** 采集停摆累计被压掉了多少毫秒 —— 界面要把这件事说出来 */
    get stalledMs() { return Math.round(clock.stalledUs / 1000); },
    get stallCount() { return clock.count; },
    /** 产物真实时长（秒）—— 界面显示时长只用它 */
    get mediaSeconds() { return clock.mediaSeconds; },

    stats() {
      return {
        elapsedMs: Date.now() - session.startedAt,
        frames: session.frames,
        dropped: session.dropped,
        bytes: session.bytes,
        encodedQueue: videoEncoder.encodeQueueSize,
        stalledMs: Math.round(clock.stalledUs / 1000),
        stallCount: clock.count,
        mediaSeconds: clock.mediaSeconds,
      };
    },

    /**
     * 收尾。顺序很重要：
     *   停泵 → 停轨道 → 关 AudioContext → flush 编码器 → finalize 封装 →
     *   关/补写目标文件
     * 反过来会丢最后几帧，或者写进一个还没 finalize 的文件。
     */
    async stop() {
      if (session.stopped) {
        return { ok: false, error: '没有正在进行的录制', fileName, alreadyStopped: true };
      }
      session.stopped = true;

      try { await Promise.all(session.readers.map((r) => r.cancel().catch(() => {}))); } catch { /* ignore */ }
      stream.getTracks().forEach((t) => t.stop());
      if (session.audioCtx) { try { await session.audioCtx.close(); } catch { /* ignore */ } }
      // 泵可能还在 await reader.read()，cancel 之后会 resolve，等它们退出
      await Promise.allSettled([videoPump, audioPump].filter(Boolean));

      try { await videoEncoder.flush(); } catch (err) { session.failure = session.failure || err; }
      if (audioEncoder) { try { await audioEncoder.flush(); } catch (err) { session.failure = session.failure || err; } }

      try {
        muxer.finalize();
      } catch (err) {
        session.failure = session.failure || err;
      }

      let size = null;
      try {
        if (recTarget.kind === 'opfs') {
          await recTarget.writable.close();
          size = await opfsFileSize(fileName);
        } else {
          // 内存模式：把缓冲区补写进 OPFS，让两条路最终都落在同一个地方，
          // 导出逻辑只需要处理一种情况。
          const buffer = recTarget.target.buffer;
          const root = await navigator.storage.getDirectory();
          const handle = await root.getFileHandle(fileName, { create: true });
          const writable = await handle.createWritable();
          await writable.write(buffer);
          await writable.close();
          size = buffer.byteLength;
        }
      } catch (err) {
        session.failure = session.failure || err;
      }

      const durationMs = Date.now() - session.startedAt;
      if (session.failure) {
        return {
          ok: false,
          error: String(session.failure?.message || session.failure),
          fileName,
          durationMs,
        };
      }

      return {
        ok: true,
        fileName,
        size,
        durationMs,
        frames: session.frames,
        dropped: session.dropped,
        // 产物时长和实际录制时长的差就是这个值 —— 界面必须解释它，
        // 否则用户会以为"录了 13 分钟怎么只有 3 分半"
        stalledMs: Math.round(clock.stalledUs / 1000),
        stallCount: clock.count,
        // 真实时长：从时间轴算出来的，和挂钟无关
        mediaSeconds: clock.mediaSeconds,
        targetKind: recTarget.kind,
        videoCodec: video.codec,
        videoVendor: video.vendorCodec,
        videoFallback: !!video.fallback,
        audioCodec: audio?.codec || null,
      };
    },
  };
}
