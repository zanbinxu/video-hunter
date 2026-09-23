/**
 * Opus → AAC 转码（浏览器里跑，用 WebCodecs）。
 *
 * ## 为什么非转不可
 *
 * 抓流抓到的是播放器**已经解密好的原始码流**。MP4 装不了 Opus（能装，
 * 但只有 ffmpeg/VLC 这类播放器认，Windows 自带播放器、手机、剪辑软件都不认），
 * 而用户要的是"下载下来能正常播放"。所以这一条路只能把音频重新编码成 AAC ——
 * 这是**唯一一处有损**：视频一个字节都没动，音频从 Opus 变成 AAC。
 * 192 kbps 的 AAC 听感上比 YouTube 的 Opus（约 130 kbps）还宽一点。
 *
 * ## 为什么不用 ffmpeg.wasm
 *
 * 25 MB 的体积，只为了转一条音轨。而 WebCodecs 的解码器和编码器是浏览器
 * 自带的：Opus 解码、AAC 编码在 Chrome 上都有（AAC 编码在 Windows 上走
 * 系统编码器）。代价是这条链路只能在浏览器里跑，所以这个文件**不进单元测试**，
 * 由浏览器端到端用例覆盖（fixture 页真的 append 一条 audio/webm; codecs="opus"）。
 *
 * ## 三个必须守住的地方
 *
 *   1. **时间戳必须单调递增**。muxer 会当场报错，而用户看到的是"录制中断"。
 *      上一版就是在编码器队列上栽过一次（见 docs/verification.md 第十二个 bug），
 *      所以这里输出前再过一道单调保护，并且**把回退次数报出来**。
 *   2. **背压**。不解码完再编码（两小时的音轨会吃掉几个 GB 内存），
 *      而是边解边编，队列超了就等 `dequeue`。
 *   3. **失败要说清楚**。AAC 编码器在这台机器上不可用时，不能默默产出
 *      一个没声音的文件；要抛出能读懂的错，让上层去警告用户。
 */

/** AAC-LC 的 codec 串（WebCodecs 的写法） */
export const AAC_CODEC = 'mp4a.40.2';
const AAC_BITRATE = 192_000;
/** AAC 一帧固定 1024 个采样 */
const AAC_FRAME_SAMPLES = 1024;

/** 这台浏览器有没有转码需要的两件东西 */
export function transcodeAvailable() {
  return typeof AudioDecoder === 'function'
    && typeof AudioEncoder === 'function'
    && typeof EncodedAudioChunk === 'function';
}

/** AAC 编码在这台机器上到底行不行（光有 AudioEncoder 不等于有 AAC 编码器） */
export async function canEncodeAac(sampleRate, channels) {
  if (!transcodeAvailable()) return false;
  try {
    const support = await AudioEncoder.isConfigSupported({
      codec: AAC_CODEC,
      sampleRate,
      numberOfChannels: channels,
      bitrate: AAC_BITRATE,
    });
    return !!support.supported;
  } catch {
    return false;
  }
}

/**
 * 等队列降下来。
 *
 * 既听 `dequeue` 事件，也兜一个 20 毫秒的定时器：事件万一不来
 * （不同实现的差异），不能把整段抓流卡死在这里 —— 卡死比慢得多更糟。
 */
function waitQueue(target, prop, limit) {
  if (target[prop] <= limit) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      target.removeEventListener('dequeue', onDequeue);
      resolve();
    };
    const onDequeue = () => { if (target[prop] <= limit) finish(); };
    const timer = setTimeout(finish, 20);
    target.addEventListener('dequeue', onDequeue);
  });
}

/**
 * 把一串 Opus 帧解码再编码成 AAC。
 *
 * @param {{frames: Array<{timeUs:number, durationUs:number, data:Uint8Array}>,
 *          sampleRate:number, channels:number, description?:Uint8Array|null,
 *          bitrate?:number, onProgress?:(fraction:number)=>void}} options
 *        `frames` 来自 webm-demux（时间戳是**绝对**呈现时间，微秒）；
 *        `description` 是 WebM 的 CodecPrivate（OpusHead）
 * @returns {Promise<{frames:Array<{data:Uint8Array,timestampUs:number,durationUs:number}>,
 *          description:Uint8Array|null, sampleRate:number, channels:number,
 *          backSteps:number, decodedFrames:number}>}
 */
export async function transcodeOpusToAac(options) {
  const { frames, sampleRate, channels, description, onProgress } = options;
  if (!transcodeAvailable()) {
    throw new Error('这台浏览器没有 WebCodecs 的音频编解码器（AudioDecoder / AudioEncoder），没法把 Opus 转成 AAC');
  }
  if (!frames?.length) throw new Error('这条音频轨一帧都没有，没什么可转的');
  if (!(sampleRate > 0) || !(channels > 0)) {
    throw new Error(`音频参数不合法：${sampleRate} Hz / ${channels} 声道`);
  }
  if (!(await canEncodeAac(sampleRate, channels))) {
    throw new Error(`这台浏览器的 AAC 编码器不支持 ${sampleRate} Hz / ${channels} 声道，没法把 Opus 转成 AAC`);
  }

  const samples = [];
  let aacDescription = null;
  let decodeError = null;
  let encodeError = null;

  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      try {
        if (!aacDescription && meta?.decoderConfig?.description) {
          aacDescription = new Uint8Array(meta.decoderConfig.description);
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        samples.push({ data, timestampUs: chunk.timestamp, durationUs: chunk.duration || 0 });
      } catch (err) {
        if (!encodeError) encodeError = err;
      }
    },
    error: (err) => { if (!encodeError) encodeError = err; },
  });
  encoder.configure({
    codec: AAC_CODEC,
    sampleRate,
    numberOfChannels: channels,
    bitrate: options.bitrate || AAC_BITRATE,
  });

  const decoder = new AudioDecoder({
    output: (audioData) => {
      try {
        encoder.encode(audioData);
      } catch (err) {
        if (!encodeError) encodeError = err;
      } finally {
        // AudioData 持有解码后的 PCM（48 kHz 立体声每秒约 384 KB），
        // 不主动关掉的话，一段几分钟的音轨就能把内存吃掉。
        try { audioData.close(); } catch { /* 已经关了就算了 */ }
      }
    },
    error: (err) => { if (!decodeError) decodeError = err; },
  });

  const config = { codec: 'opus', sampleRate, numberOfChannels: channels };
  if (description && description.byteLength) config.description = description;
  try {
    decoder.configure(config);
  } catch (err) {
    if (!config.description) throw err;
    // 有的实现对 OpusHead 挑剔：去掉 description（用默认 pre-skip）再试一次，
    // 而不是因为一个可选字段直接放弃整条音轨。
    delete config.description;
    decoder.configure(config);
  }

  for (let i = 0; i < frames.length; i += 1) {
    if (decodeError || encodeError) break;
    const frame = frames[i];
    decoder.decode(new EncodedAudioChunk({
      type: 'key',
      timestamp: Math.max(0, Math.round(frame.timeUs)),
      ...(frame.durationUs > 0 ? { duration: Math.round(frame.durationUs) } : {}),
      data: frame.data,
    }));
    // 背压：解码侧和编码侧的队列都压住，内存才不会随音轨长度线性增长
    await waitQueue(decoder, 'decodeQueueSize', 24);
    await waitQueue(encoder, 'encodeQueueSize', 24);
    if (typeof onProgress === 'function' && i % 100 === 0) onProgress(i / frames.length);
  }

  if (decodeError) throw new Error(`Opus 解码失败：${decodeError.message || decodeError}`);
  if (encodeError) throw new Error(`AAC 编码失败：${encodeError.message || encodeError}`);

  await decoder.flush();
  await encoder.flush();
  try { decoder.close(); } catch { /* 已经关了 */ }
  try { encoder.close(); } catch { /* 已经关了 */ }

  if (!samples.length) throw new Error('转码一帧 AAC 都没产出');
  if (encodeError) throw new Error(`AAC 编码失败：${encodeError.message || encodeError}`);

  // 单调保护：muxer 遇到回退会当场抛错，而那是用户看不见的一次"录制中断"
  let backSteps = 0;
  let last = -1;
  for (const sample of samples) {
    let ts = Math.max(0, Math.round(sample.timestampUs));
    if (ts <= last) {
      ts = last + 1;
      backSteps += 1;
    }
    sample.timestampUs = ts;
    last = ts;
  }

  // 时长：编码器自己给的优先，没有就用下一帧的时间差推
  const nominalUs = Math.round((AAC_FRAME_SAMPLES / sampleRate) * 1e6);
  for (let i = 0; i < samples.length; i += 1) {
    const next = samples[i + 1];
    const fromDelta = next ? next.timestampUs - samples[i].timestampUs : 0;
    const duration = samples[i].durationUs > 0 ? samples[i].durationUs : (fromDelta || nominalUs);
    samples[i].durationUs = duration > 0 ? duration : nominalUs;
  }

  return {
    frames: samples,
    description: aacDescription,
    sampleRate,
    channels,
    backSteps,
    decodedFrames: frames.length,
  };
}
