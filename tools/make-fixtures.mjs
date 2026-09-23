#!/usr/bin/env node
/**
 * 用本机 ffmpeg 造测试样本。
 *
 * 为什么值得单独写一个脚本：HLS 解析 + TS 重封装这条链路，靠肉眼看代码
 * 是验不出来的 —— 一个 IV 算错、一个 baseMediaDecodeTime 没接上，
 * 产物就是一个「能生成但播不了」的 mp4。所以这里造出**真的流**，
 * 让 test/ 下的用例跑真实数据，最后用 ffprobe 反过来验证产物。
 *
 * 产出（test/fixtures/）：
 *   source.mp4                     原始素材（12 秒，640x360，带音轨）
 *   hls-ts/                        多码率 TS 版 HLS（主列表 + 2 个变体）
 *   hls-enc/                       AES-128 加密的 TS 版 HLS
 *   hls-fmp4/                      fMP4 版 HLS（带 #EXT-X-MAP）
 *   dash-split/                    音视频分离的 DASH（后面合并功能要用）
 *   fmp4-tracks/                   两条自包含 fMP4 轨（无清单 DASH 那种形态）
 *   seek-holed/                    帧间隔不均匀的小素材，用来测时间轴空洞的体检与修复
 *
 * 用法：node tools/make-fixtures.mjs [--force]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'test', 'fixtures');
const FORCE = process.argv.includes('--force');

/** 沙箱禁止管道式 stdio，所以只能用 inherit；ffmpeg 的输出直接打到 stderr 上 */
function run(bin, args, cwd = ROOT) {
  process.stdout.write(`  $ ${bin} ${args.slice(0, 6).join(' ')}${args.length > 6 ? ' …' : ''}\n`);
  execFileSync(bin, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
}

function freshDir(name) {
  const dir = join(FIX, name);
  if (existsSync(dir)) {
    if (!FORCE) return dir;
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

function has(dir) {
  try { return readdirSync(dir).length > 0; } catch { return false; }
}

mkdirSync(FIX, { recursive: true });

/* ------------------------------------------------------------------ *
 * 1. 原始素材
 * ------------------------------------------------------------------ */

const source = join(FIX, 'source.mp4');
if (!existsSync(source) || FORCE) {
  console.log('· 生成原始素材 source.mp4');
  run('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '50',
    '-c:a', 'aac', '-b:a', '96k',
    '-shortest',
    source,
  ]);
} else {
  console.log('· source.mp4 已存在，跳过');
}

const V = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '50', '-c:a', 'aac', '-b:a', '96k'];

/* ------------------------------------------------------------------ *
 * 2. 多码率 TS 版 HLS
 * ------------------------------------------------------------------ */

{
  const dir = join(FIX, 'hls-ts');
  if (has(dir) && !FORCE) {
    console.log('· hls-ts/ 已存在，跳过');
  } else {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'v0'), { recursive: true });
    mkdirSync(join(dir, 'v1'), { recursive: true });
    console.log('· 生成 hls-ts/（主列表 + 2 个码率变体）');
    run('ffmpeg', [
      '-y', '-i', source,
      '-filter_complex', '[0:v]split=2[a][b];[a]scale=640:360[v0];[b]scale=320:180[v1]',
      '-map', '[v0]', '-map', '0:a', '-map', '[v1]', '-map', '0:a',
      ...V,
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_playlist_type', 'vod',
      '-hls_list_size', '0',
      '-var_stream_map', 'v:0,a:0 v:1,a:1',
      '-master_pl_name', 'index.m3u8',
      '-hls_segment_filename', 'v%v/seg_%03d.ts',
      'v%v/index.m3u8',
    ], dir);
  }
}

/* ------------------------------------------------------------------ *
 * 3. AES-128 加密的 TS 版 HLS
 * ------------------------------------------------------------------ */

{
  const dir = join(FIX, 'hls-enc');
  if (has(dir) && !FORCE) {
    console.log('· hls-enc/ 已存在，跳过');
  } else {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    // 踩过的坑：ffmpeg 的 -hls_enc_key / -hls_enc_iv **不接受十六进制**。
    // 它直接取字符串的前 16 个字符当原始字节用。所以这里给 16 个 ASCII 字符，
    // 而不是 32 位十六进制串 —— 否则 key 文件里的字节和实际加密用的字节对不上，
    // 后面解密必然失败，而且失败得很隐蔽（看起来「成功」写出一个坏 mp4）。
    const KEY_STR = 'VHtestKey0123456'; // 16 字节
    const IV_STR = 'VHtestIV0123456';   // 16 字节

    console.log('· 生成 hls-enc/（AES-128，key/IV 由 ffmpeg 实际写出，保证自洽）');
    run('ffmpeg', [
      '-y', '-i', source,
      ...V,
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_playlist_type', 'vod',
      '-hls_list_size', '0',
      '-hls_enc', '1',
      '-hls_enc_key', KEY_STR,
      '-hls_enc_iv', IV_STR,
      '-hls_segment_filename', 'seg_%03d.ts',
      'index.m3u8',
    ], dir);

    // ffmpeg 把 key 写在 <播放列表名>.key 里。把它改名成 enc.key 并在
    // 播放列表里改引用，这样测试能完整走一遍「读 URI → 取 key → 解密」。
    const { readFileSync, renameSync } = await import('node:fs');
    const ffKey = join(dir, 'index.m3u8.key');
    if (!existsSync(ffKey)) throw new Error('ffmpeg 没有写出 key 文件，HLS 加密样本不完整');
    renameSync(ffKey, join(dir, 'enc.key'));

    const pl = readFileSync(join(dir, 'index.m3u8'), 'utf8')
      .replace(/URI="[^"]*\.key"/g, 'URI="enc.key"');
    writeFileSync(join(dir, 'index.m3u8'), pl);

    const keyBytes = readFileSync(join(dir, 'enc.key'));
    if (keyBytes.length !== 16) throw new Error(`key 应为 16 字节，实际 ${keyBytes.length}`);
    console.log(`  key 文件：${keyBytes.toString('hex')}`);
  }
}

/* ------------------------------------------------------------------ *
 * 3b. key 用十六进制字符串发的 HLS（规范之外，但线上真有）
 *
 * 直接从 hls-enc 派生：分片和播放列表完全一样，只把 key 文件换成
 * **32 个十六进制字符 + 换行**（33 字节）。这就是线上撞到的那个形态，
 * 不造出来的话，那个修复就只能靠"看起来对"。
 * ------------------------------------------------------------------ */

{
  const src = join(FIX, 'hls-enc');
  const dir = join(FIX, 'hls-enc-hex');
  if (!existsSync(src)) {
    console.log('· 跳过 hls-enc-hex/（hls-enc 不存在）');
  } else if (has(dir) && !FORCE && existsSync(join(dir, 'index.m3u8'))) {
    console.log('· hls-enc-hex/ 已存在，跳过');
  } else {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const { copyFileSync, readFileSync: rf } = await import('node:fs');

    // 分片原样拷过来 —— 加密方式完全一致，变的只有 key 的**编码形式**
    for (const name of readdirSync(src)) {
      if (name.endsWith('.ts') || name === 'index.m3u8') {
        copyFileSync(join(src, name), join(dir, name));
      }
    }
    const keyHex = rf(join(src, 'enc.key')).toString('hex');
    writeFileSync(join(dir, 'enc.key'), `${keyHex}\n`);
    console.log(`· 生成 hls-enc-hex/（key 是 32 位十六进制字符串 + 换行 = ${keyHex.length + 1} 字节）`);
  }
}

/* ------------------------------------------------------------------ *
 * 4. fMP4 版 HLS（带 #EXT-X-MAP）
 * ------------------------------------------------------------------ */

{
  const dir = join(FIX, 'hls-fmp4');
  if (has(dir) && !FORCE) {
    console.log('· hls-fmp4/ 已存在，跳过');
  } else {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    console.log('· 生成 hls-fmp4/（分段 MP4 + 初始化段）');
    run('ffmpeg', [
      '-y', '-i', source,
      ...V,
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_playlist_type', 'vod',
      '-hls_list_size', '0',
      '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', 'seg_%03d.m4s',
      'index.m3u8',
    ], dir);
  }
}

/* ------------------------------------------------------------------ *
 * 5. 直播形态的 HLS（没有 ENDLIST + 滑动窗口）
 * ------------------------------------------------------------------ */

{
  const dir = join(FIX, 'hls-live');
  if (has(dir) && !FORCE) {
    console.log('· hls-live/ 已存在，跳过');
  } else {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    console.log('· 生成 hls-live/（无 #EXT-X-ENDLIST + 滑动窗口）');
    // 真直播要一直喂流才做得出，但直播播放列表的**形态**是两件事：
    // 没有 #EXT-X-ENDLIST、而且只列最近几片。这两个特征静态就能造出来，
    // 足够验证「反复拉取 + 只下新片」这条路径。
    run('ffmpeg', [
      '-y', '-i', source,
      ...V,
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '3',
      '-hls_flags', 'omit_endlist',
      '-hls_segment_filename', 'live_%03d.ts',
      'index.m3u8',
    ], dir);
  }
}

/* ------------------------------------------------------------------ *
 * 6. 音视频分离的 DASH
 * ------------------------------------------------------------------ */

{
  const dir = join(FIX, 'dash-split');
  if (has(dir) && !FORCE) {
    console.log('· dash-split/ 已存在，跳过');
  } else {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    console.log('· 生成 dash-split/（video / audio 各自独立的自适应集）');
    run('ffmpeg', [
      '-y', '-i', source,
      '-map', '0:v', '-map', '0:a',
      ...V,
      '-f', 'dash',
      '-seg_duration', '2',
      '-use_template', '1',
      '-use_timeline', '1',
      '-adaptation_sets', 'id=0,streams=v id=1,streams=a',
      'out.mpd',
    ], dir);
  }
}

/* ------------------------------------------------------------------ *
 * 7. 「没有清单的 DASH」：两份各自自包含的 fMP4 轨道
 *
 * B 站这类站点不提供 m3u8/mpd，它通过 API 直接返回两条**完整 fMP4 文件**的地址。
 * 从 dash-split 派生：把视频轨的 init 和全部分片接成一份文件，音频轨同理。
 * ------------------------------------------------------------------ */

{
  const src = join(FIX, 'dash-split');
  const dir = join(FIX, 'fmp4-tracks');
  if (!existsSync(src)) {
    console.log('· 跳过 fmp4-tracks/（dash-split 不存在）');
  } else if (existsSync(join(dir, 'video.m4s')) && !FORCE) {
    console.log('· fmp4-tracks/ 已存在，跳过');
  } else {
    const { readFileSync: rf, writeFileSync: wf } = await import('node:fs');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const build = (prefix, initName, outName) => {
      const parts = [rf(join(src, initName))];
      for (const n of readdirSync(src).filter((x) => x.startsWith(prefix) && x.endsWith('.m4s')).sort()) {
        parts.push(rf(join(src, n)));
      }
      wf(join(dir, outName), Buffer.concat(parts));
      return parts.reduce((n, p) => n + p.length, 0);
    };

    const vSize = build('chunk-stream0-', 'init-stream0.m4s', 'video.m4s');
    const aSize = build('chunk-stream1-', 'init-stream1.m4s', 'audio.m4s');
    console.log(`· 生成 fmp4-tracks/（video.m4s ${(vSize / 1024).toFixed(0)} KB / audio.m4s ${(aSize / 1024).toFixed(0)} KB）`);
  }
}

/* ------------------------------------------------------------------ *
 * 8. 「时间轴有空洞」的 MP4
 *
 * 这不是为了造一个坏文件，而是为了造一个**能在原地改出空洞**的文件。
 *
 * 空洞在 stts 里表现为"某一个样本的时长特别大"。想在一个只有单条 stts 条目的
 * 文件（所有帧时长相同）里造出空洞，就必须**插入新条目** —— box 会变长，
 * 里面所有绝对偏移（stco）都得跟着重算，测试脚手架会比被测代码还长。
 *
 * 所以这里先让 ffmpeg 生成一个帧间隔本来就不均匀的素材：
 * 丢掉第 100、101 帧，stts 就变成 `101×512 | 1×1536 | 96×512` ——
 * 中间那条正好只有 1 个样本，把它撑大就是空洞，**一个字节都不用挪**。
 * ------------------------------------------------------------------ */

{
  const dir = join(FIX, 'seek-holed');
  if (has(dir) && !FORCE) {
    console.log('· seek-holed/ 已存在，跳过');
  } else {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    console.log('· 生成 seek-holed/（帧间隔不均匀，方便原地注入时间轴空洞）');
    run('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=8',
      // 丢两帧 → 出现一个"3 倍帧间隔"的样本，且它只能单独成为一条 stts 条目
      '-vf', "select='not(between(n,100,101))'",
      '-fps_mode', 'vfr',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '25',
      '-an',
      'source.mp4',
    ], dir);
  }
}

/* ------------------------------------------------------------------ *
 * 9. AV1 版「没有清单的 DASH」：B 站现在发的就是这种
 *
 * 为什么要专门造它：B 站（以及越来越多站点）的视频轨已经从 H.264 换成 **AV1**
 * （样本描述项是 `av01`、解码器配置记录是 `av1C`）。这和 H.264 的 `avc1`/`avcC`
 * 是**同一套结构、不同名字**，但代码里但凡写死了 `avcC`/`hvcC` 就会在这里翻车：
 * 报一句"拿不到 H.264/H.265 解码器配置记录"，然后退化成"只存最大的一条轨道"
 * —— 用户拿到一个没有声音的视频。
 *
 * 形状和 fmp4-tracks 一样（每个视频/音频各一份自包含 fMP4），只有编码不同。
 * ------------------------------------------------------------------ */

{
  const src = join(FIX, 'av1-dash');
  const dir = join(FIX, 'av1-tracks');
  if (has(src) && existsSync(join(dir, 'video.m4s')) && !FORCE) {
    console.log('· av1-tracks/ 已存在，跳过');
  } else {
    rmSync(src, { recursive: true, force: true });
    mkdirSync(src, { recursive: true });
    console.log('· 生成 av1-dash/ → av1-tracks/（AV1 视频轨 + AAC 音频轨）');
    run('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
      // 用 SVT-AV1：软编、有 CPU 就能跑，不依赖显卡
      '-c:v', 'libsvtav1', '-preset', '10', '-crf', '40', '-g', '25', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '64k',
      '-f', 'dash',
      '-seg_duration', '2',
      '-use_template', '1',
      '-use_timeline', '1',
      '-adaptation_sets', 'id=0,streams=v id=1,streams=a',
      'out.mpd',
    ], src);

    const { readFileSync: rf, writeFileSync: wf } = await import('node:fs');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const build = (prefix, initName, outName) => {
      const parts = [rf(join(src, initName))];
      for (const n of readdirSync(src).filter((x) => x.startsWith(prefix) && x.endsWith('.m4s')).sort()) {
        parts.push(rf(join(src, n)));
      }
      wf(join(dir, outName), Buffer.concat(parts));
      return parts.reduce((n, p) => n + p.length, 0);
    };
    const vSize = build('chunk-stream0-', 'init-stream0.m4s', 'video.m4s');
    const aSize = build('chunk-stream1-', 'init-stream1.m4s', 'audio.m4s');
    console.log(`  AV1 video.m4s ${(vSize / 1024).toFixed(0)} KB / audio.m4s ${(aSize / 1024).toFixed(0)} KB`);
  }
}

/* ------------------------------------------------------------------ *
 * 11. WebM 画面 + WebM 音频（两个独立的 MSE 流）
 *
 * 抓流原来只出 MP4，碰到"画面也是 WebM"的站点只能报"暂不支持"。
 * 现在这条路出 .webm —— **零转码**：VP9 帧和 Opus 帧都是原字节。
 *
 * 为什么切成两份（视频一份、音频一份）：MSE 的 SourceBuffer 一条只放一条轨，
 * 真实站点就是这么开的（和 DASH 的 fMP4 一样）。所以夹具也必须这个形状，
 * 否则测的就不是真实场景。
 * ------------------------------------------------------------------ */

{
  const dir = join(FIX, 'webm-vp9');
  if (existsSync(join(dir, 'video-clusters.webm')) && !FORCE) {
    console.log('· webm-vp9/ 已存在，跳过');
  } else {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    console.log('· 生成 webm-vp9/（VP9 画面一份、Opus 音频一份，各自切成 init + clusters）');
    // 画面：VP9。`-live 1` 让 Segment 长度未知 —— MSE 里的 WebM 就是这个形态
    run('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=6',
      '-c:v', 'libvpx-vp9', '-b:v', '300k', '-g', '25', '-pix_fmt', 'yuv420p',
      '-an',
      '-live', '1',
      '-cluster_time_limit', '1000',
      'video.webm',
    ], dir);
    run('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
      '-ac', '2',
      '-c:a', 'libopus', '-b:a', '96k',
      '-vn',
      '-live', '1',
      '-cluster_time_limit', '1000',
      'audio.webm',
    ], dir);

    const { readFileSync: rf, writeFileSync: wf } = await import('node:fs');
    const { splitWebmInit, demuxWebm } = await import('../src/parser/webm-demux.js');
    const split = (name, prefix) => {
      const all = new Uint8Array(rf(join(dir, name)));
      const { init, media } = splitWebmInit(all);
      wf(join(dir, `${prefix}-init.webm`), init);
      wf(join(dir, `${prefix}-clusters.webm`), media);
      const demuxed = demuxWebm(all);
      const track = demuxed.tracks[0];
      console.log(`  ${prefix}: ${track.codecId} ${track.type === 'video' ? `${track.width}×${track.height}` : `${track.sampleRate} Hz ${track.channels}ch`}`
        + `｜init ${init.byteLength} B / clusters ${media.byteLength} B｜${track.frames.length} 帧`);
    };
    split('video.webm', 'video');
    split('audio.webm', 'audio');
  }
}

/* ------------------------------------------------------------------ *
 * 12. WebM/Opus 音频轨 —— 用户报的「抓 YouTube 有画面没声音」
 *
 * YouTube 那条音轨是 `audio/webm; codecs="opus"`：**MP4 装不了 Opus**，
 * 所以抓流必须把它解码再编码成 AAC 才能塞进 MP4。这条链路要有真样本才能验，
 * 而且必须按 MSE 的样子切成两段：
 *
 *     init.webm       EBML 头 + Segment + Info + Tracks（只 append 一次）
 *     clusters.webm   后面所有的 Cluster（每次 append 一段）
 *
 * 特意用 `-live 1`：MSE 播放的 WebM 都是"长度未知的 Segment"
 * （size 字段全 1），不认这个形态的解析器在第一个元素上就会停住。
 * ------------------------------------------------------------------ */

{
  const dir = join(FIX, 'webm-opus');
  if (existsSync(join(dir, 'clusters.webm')) && !FORCE) {
    console.log('· webm-opus/ 已存在，跳过');
  } else {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    console.log('· 生成 webm-opus/（48 kHz 立体声 Opus，切成 init + clusters）');
    run('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12',
      '-ac', '2',
      '-c:a', 'libopus', '-b:a', '96k',
      '-live', '1',            // Segment 长度未知（和 MSE 里的一样）
      '-cluster_time_limit', '1000',
      'audio.webm',
    ], dir);

    // 切成 init / clusters —— 用的就是产品里那个切分函数，
    // 免得"测试切的和产品切的不一样"，那样测了等于没测。
    const { readFileSync: rf, writeFileSync: wf } = await import('node:fs');
    const { splitWebmInit, demuxWebm } = await import('../src/parser/webm-demux.js');
    const all = new Uint8Array(rf(join(dir, 'audio.webm')));
    const { init, media } = splitWebmInit(all);
    wf(join(dir, 'init.webm'), init);
    wf(join(dir, 'clusters.webm'), media);

    const demuxed = demuxWebm(all);
    const track = demuxed.tracks[0];
    console.log(`  init.webm ${init.byteLength} B / clusters.webm ${media.byteLength} B`
      + `｜${track.codecId} ${track.sampleRate} Hz ${track.channels}ch ${track.frames.length} 帧`);
  }
}


console.log('\n✓ 样本就绪：test/fixtures/');