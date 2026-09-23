/**
 * WebM → WebM：把拆出来的画面轨和音频轨封成一个能播的 `.webm`。
 *
 * ## 为什么要有这条路
 *
 * 抓流原来只出 MP4。碰到**画面也是 WebM** 的站点（VP8/VP9/AV1 in WebM），
 * 只能报一句"暂不支持"——用户什么都拿不到。
 *
 * 把 VP9 塞进 MP4 其实划不来：样本描述项要写 `vp09`，还得从 WebM 的
 * `Colour` 元素里凑出颜色信息，**装出来的文件还未必有人认**。
 * 而这条路是**零转码**的：VP9 帧原样搬进 WebM，Opus 帧也原样搬进去
 * （录音频那一步连 Opus → AAC 的转码都省了，比 MP4 那条路还无损）。
 *
 *     WebM 视频组 ─┐
 *                  ├─→ WebM 复用器 ─→ 一个 .webm（画面 + 声音）
 *     WebM 音频组 ─┘
 *
 * ## 时间轴怎么对齐（和 MP4 那条路不一样）
 *
 * MP4 的 `stts` 只记样本之间的间隔，一条轨"比影片晚 1 秒开始"只能靠
 * edts/elst 表达。**Matroska 不是这样**：每个 Block 的时间戳都是绝对时间
 * （相对 Cluster），所以两条轨各自保留真实起点就行，用
 * `firstTimestampBehavior: 'permissive'` 让后开始的那条轨保留自己的起点。
 * 这里仍然整体减掉两轨里最早的那一点，纯粹是为了文件名里那个时长好看。
 */

import { Muxer, ArrayBufferTarget } from '../../vendor/webm-muxer.mjs';

/** webm-muxer 认的 WebM 画面编码 */
const WEBM_VIDEO_CODECS = new Set(['V_VP8', 'V_VP9', 'V_AV1']);
/** 能原样搬进 WebM 的音频编码（AAC 不走这条路，那是 MP4 的事） */
const WEBM_AUDIO_CODECS = new Set(['A_OPUS', 'A_VORBIS']);

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error('需要 Uint8Array / ArrayBuffer，实际拿到 ' + Object.prototype.toString.call(input));
}

/** 一条轨的起点（毫秒级就行：WebM 的时间戳精度本来就到毫秒） */
function firstTimeUs(track) {
  return track?.frames?.length ? track.frames[0].timeUs : 0;
}

/**
 * 把两条轨封成一个 WebM。
 *
 * @param {{video?: {codecId:string, width:number, height:number,
 *                   frames:Array<{timeUs:number, keyframe:boolean, data:Uint8Array}>},
 *          audio?: {codecId:string, sampleRate:number, channels:number, frames:Array},
 *          onWarning?: (msg:string)=>void}} input
 * @returns {Uint8Array}
 */
export function mergeWebm(input = {}) {
  const { video, audio } = input;
  const warn = typeof input.onWarning === 'function' ? input.onWarning : () => {};
  if (!video && !audio) throw new Error('mergeWebm 需要至少一条轨（video 或 audio）');

  if (video) {
    if (!video.frames?.length) throw new Error('画面轨一帧都没有');
    if (!WEBM_VIDEO_CODECS.has(video.codecId)) {
      throw new Error(`暂不支持的 WebM 画面编码：${video.codecId}`
        + `（当前支持 ${[...WEBM_VIDEO_CODECS].join(' / ')}）`);
    }
    if (!(video.width > 0) || !(video.height > 0)) {
      throw new Error(`画面尺寸不合法：${video.width}×${video.height}，封出来播放器认不出`);
    }
  }
  if (audio) {
    if (!audio.frames?.length) throw new Error('音频轨一帧都没有');
    if (!WEBM_AUDIO_CODECS.has(audio.codecId)) {
      throw new Error(`WebM 里放不了这种音频编码：${audio.codecId}`
        + `（当前支持 ${[...WEBM_AUDIO_CODECS].join(' / ')}）`);
    }
    if (!(audio.sampleRate > 0) || !(audio.channels > 0)) {
      throw new Error(`音频参数不合法：${audio.sampleRate} Hz / ${audio.channels} 声道`);
    }
  }

  // 整体减掉最早的起点：让文件从 0 开始（后开始的那条轨保留自己的偏移）
  const originUs = Math.min(video ? firstTimeUs(video) : Infinity, audio ? firstTimeUs(audio) : Infinity);
  const shift = Number.isFinite(originUs) ? originUs : 0;

  const options = {
    target: new ArrayBufferTarget(),
    // 一条轨比另一条晚开始是**正常现象**（音频的起点常比视频晚几十毫秒），
    // Matroska 用绝对时间戳表达它，所以这里允许第一条时间戳不是 0。
    firstTimestampBehavior: 'permissive',
  };
  if (video) options.video = { codec: video.codecId, width: video.width, height: video.height };
  if (audio) options.audio = { codec: audio.codecId, sampleRate: audio.sampleRate, numberOfChannels: audio.channels };

  const events = [];
  if (video) for (const f of video.frames) events.push({ kind: 'video', ...f });
  if (audio) for (const f of audio.frames) events.push({ kind: 'audio', ...f });
  // 按时间戳交错喂进去：WebM 的 Cluster 是按时间组织的，
  // 两条轨分开喂会让同一个 Cluster 里只有一种数据，文件白胖一圈。
  events.sort((a, b) => (a.timeUs - b.timeUs) || (a.kind === 'video' ? -1 : 1));

  const muxer = new Muxer(options);
  let lastVideoUs = -1;
  let lastAudioUs = -1;
  let backSteps = 0;
  for (const event of events) {
    let timestamp = Math.max(0, Math.round(event.timeUs - shift));
    // 单调保护（同一课：muxer 遇到回退会当场抛错，而用户看到的是"收尾中断"）
    const last = event.kind === 'video' ? lastVideoUs : lastAudioUs;
    if (timestamp <= last) {
      timestamp = last + 1;
      backSteps += 1;
    }
    if (event.kind === 'video') {
      lastVideoUs = timestamp;
      muxer.addVideoChunkRaw(toBytes(event.data), event.keyframe ? 'key' : 'delta', timestamp);
    } else {
      lastAudioUs = timestamp;
      muxer.addAudioChunkRaw(toBytes(event.data), 'key', timestamp);
    }
  }
  if (backSteps) warn(`WebM 封装时有 ${backSteps} 帧时间戳回退，已就地纠正`);

  muxer.finalize();
  const buffer = muxer.target.buffer;
  if (!buffer || !buffer.byteLength) throw new Error('WebM 封装没有产出任何数据');
  return new Uint8Array(buffer);
}

/**
 * 这份 WebM 产物自己的时长（秒）。
 *
 * 为什么不复用 `readMovieDurationSeconds`：那是读 MP4 的 mvhd 的。
 * 这里两条轨的最后一帧我们都摸过，直接算最准。
 */
export function webmDurationSeconds(tracks = []) {
  let endUs = 0;
  for (const track of tracks) {
    const frames = track?.frames || [];
    const last = frames[frames.length - 1];
    if (!last) continue;
    endUs = Math.max(endUs, last.timeUs + (last.durationUs || 0));
  }
  return endUs > 0 ? endUs / 1e6 : null;
}
