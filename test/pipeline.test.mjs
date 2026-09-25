/**
 * 端到端管线测试：真实 HLS 流 → 解密 → 重封装 → 用 ffprobe 反过来验产物。
 *
 * 这个文件的存在意义：HLS 下载链路上「看起来成功」和「真的能播」之间
 * 差着十万八千里 —— 一个 IV 取错、一个 baseMediaDecodeTime 没接上，
 * 产物照样能写出来，只是打不开。所以每一路都以「ffprobe 认不认」为准。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parsePlaylist, selectVariant, ivForSegment } from '../src/parser/hls.js';
import { createTsRemuxer, sniffContainer, assertMuxjs } from '../src/parser/remuxer.js';
import { decryptAes128Cbc, keyFingerprint } from '../src/parser/decrypt.js';
import { normalizeKeyBytes } from '../src/parser/hls-key.js';
import { concatChunks } from '../src/parser/mse-assemble.js';
import { mergeFmp4 } from '../src/parser/mp4-merge.js';
import {
  captureFileName, partialCaptureFileName, autoSnapshotFileName, isAutoSnapshotName,
  autoSnapshotPlan, autoSnapshotIntervalMs, titlePart,
  captureCutPlan, captureCutThresholdBytes, captureSizeNotice,
} from '../src/core/capture-limits.js';
import { inspect } from '../tools/mp4-inspect.mjs';
import {
  loadVendorMuxjs, readFixture, urlFor, pathFromUrl, probe, fixturePath,
  videoStream, audioStream, writeTmp, hasFfprobe,
} from './helpers.mjs';

const muxjs = loadVendorMuxjs();
const noProbe = hasFfprobe() ? false : '本机没有 ffprobe，跳过产物校验';

const bytesAt = (url) => new Uint8Array(readFileSync(pathFromUrl(url)));

/* ------------------------------------------------------------------ *
 * 前置：mux.js 本身
 * ------------------------------------------------------------------ */

test('vendor/mux.min.js 能加载，并且含有 mp4.Transmuxer', () => {
  assertMuxjs(muxjs);
  assert.equal(typeof muxjs.mp4.Transmuxer, 'function');
});

test('assertMuxjs 对坏输入要报错，而不是留到后面莫名其妙地崩', () => {
  assert.throws(() => assertMuxjs(null), /mux\.js 未加载/);
  assert.throws(() => assertMuxjs({}), /Transmuxer/);
});

/* ------------------------------------------------------------------ *
 * 容器嗅探
 * ------------------------------------------------------------------ */

test('sniffContainer：分得清 TS 和 fMP4', () => {
  assert.equal(sniffContainer(bytesAt(urlFor('hls-ts/v0/seg_000.ts'))), 'mpegts');
  assert.equal(sniffContainer(bytesAt(urlFor('hls-fmp4/init.mp4'))), 'fmp4');
  assert.equal(sniffContainer(bytesAt(urlFor('hls-fmp4/seg_000.m4s'))), 'fmp4');
  assert.equal(sniffContainer(new Uint8Array([1, 2, 3])), 'unknown');
});

test('把 TS 分片直接首尾相接得到的仍然是 TS —— 这就是为什么必须重封装', () => {
  const a = bytesAt(urlFor('hls-ts/v0/seg_000.ts'));
  const b = bytesAt(urlFor('hls-ts/v0/seg_001.ts'));
  const joined = new Uint8Array(a.byteLength + b.byteLength);
  joined.set(a, 0);
  joined.set(b, a.byteLength);
  assert.equal(sniffContainer(joined), 'mpegts');
  // 一个 .mp4 后缀的 TS 拼接文件，播放器是打不开的
  assert.notEqual(sniffContainer(joined), 'fmp4');
});

/* ------------------------------------------------------------------ *
 * 主线 1：TS 版 HLS（多码率 → 选最高 → 合并）
 * ------------------------------------------------------------------ */

test('真实 HLS(TS)：选最高码率 → 重封装 → ffprobe 认得、音视频都在、时长对', { skip: noProbe }, () => {
  const master = parsePlaylist(readFixture('hls-ts', 'index.m3u8'), urlFor('hls-ts/index.m3u8'));
  const variant = selectVariant(master.variants, 'auto');
  assert.ok(variant, '应该能选出一个码率');
  assert.equal(variant.bandwidth, 839232);

  const mediaUrl = variant.uri;
  const media = parsePlaylist(readFileSync(pathFromUrl(mediaUrl), 'utf8'), mediaUrl);
  assert.equal(media.ok, true);
  assert.equal(media.segments.length, 6);

  const chunks = [];
  const remuxer = createTsRemuxer(muxjs, {
    onInit: (b) => chunks.push(b),
    onFragment: (b) => chunks.push(b),
  });

  for (const seg of media.segments) {
    const bytes = bytesAt(seg.uri);
    assert.equal(sniffContainer(bytes), 'mpegts', `${seg.uri} 应该是 TS`);
    remuxer.append(bytes);
  }
  remuxer.end();

  assert.ok(remuxer.initSegment, '必须产出初始化段（moov）');
  assert.equal(remuxer.initSegment.length > 0, true);
  assert.ok(remuxer.fragmentCount >= 6, `分片数应 ≥ 6，实际 ${remuxer.fragmentCount}`);
  assert.deepEqual(remuxer.errors, [], 'mux.js 不应报错');

  const out = writeTmp('hls-ts-output.mp4', chunks);
  const info = probe(out);

  const v = videoStream(info);
  const a = audioStream(info);
  assert.ok(v, '产物必须有视频轨');
  assert.ok(a, '产物必须有音频轨');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.width, 640);
  assert.equal(v.height, 360);
  assert.equal(a.codec_name, 'aac');

  const duration = Number(info.format.duration);
  assert.ok(Math.abs(duration - 12) < 0.7, `时长应约 12 秒，实际 ${duration.toFixed(3)}`);
});

/* ------------------------------------------------------------------ *
 * 主线 2：AES-128 加密的 HLS
 * ------------------------------------------------------------------ */

test('真实 AES-128 加密 HLS：解密后是 TS，重封装后能播', { skip: noProbe }, async () => {
  const pl = parsePlaylist(readFixture('hls-enc', 'index.m3u8'), urlFor('hls-enc/index.m3u8'));
  assert.equal(pl.encryption.method, 'AES-128');
  const key = new Uint8Array(readFileSync(pathFromUrl(pl.encryption.uri)));
  assert.equal(key.length, 16, 'key 必须是 16 字节');
  const fingerprint = await keyFingerprint(key);
  assert.match(fingerprint, /^[0-9a-f]{16}$/);

  const chunks = [];
  const remuxer = createTsRemuxer(muxjs, {
    onInit: (b) => chunks.push(b),
    onFragment: (b) => chunks.push(b),
  });

  for (const seg of pl.segments) {
    const cipher = bytesAt(seg.uri);
    const iv = ivForSegment(seg, pl.mediaSequence);
    assert.equal(iv.length, 16);
    const plain = await decryptAes128Cbc(key, iv, cipher);

    // 这是「解密真的成功了」最硬的证据：TS 包的同步字节必须是 0x47
    assert.equal(plain[0], 0x47, `解密后的第一个字节应是 TS 同步字节，实际 0x${plain[0].toString(16)}`);
    assert.equal(sniffContainer(plain), 'mpegts');
    assert.ok(plain.byteLength < cipher.byteLength, '去掉 PKCS#7 填充后应该变短');

    remuxer.append(plain);
  }
  remuxer.end();

  const out = writeTmp('hls-enc-output.mp4', chunks);
  const info = probe(out);
  assert.ok(videoStream(info), '加密流解密后也必须有视频轨');
  assert.ok(audioStream(info), '加密流解密后也必须有音频轨');
  const duration = Number(info.format.duration);
  assert.ok(Math.abs(duration - 12) < 0.7, `时长应约 12 秒，实际 ${duration.toFixed(3)}`);
});

test('用错 key 解密必须失败，而不是悄悄产出坏数据', async () => {
  const pl = parsePlaylist(readFixture('hls-enc', 'index.m3u8'), urlFor('hls-enc/index.m3u8'));
  const wrongKey = new Uint8Array(16).fill(0x5a);
  const seg = pl.segments[0];
  const iv = ivForSegment(seg, pl.mediaSequence);
  await assert.rejects(
    () => decryptAes128Cbc(wrongKey, iv, bytesAt(seg.uri)),
    /解密失败/,
  );
});

test('十六进制字符串形式的 key（线上真实形态）：解出正确的 key，产物能播', { skip: noProbe }, async () => {
  const pl = parsePlaylist(readFixture('hls-enc-hex', 'index.m3u8'), urlFor('hls-enc-hex/index.m3u8'));
  assert.equal(pl.encryption.method, 'AES-128');

  const rawKey = new Uint8Array(readFileSync(pathFromUrl(pl.encryption.uri)));
  // 先确认这个样本确实是"规范之外"的形态 —— 不然这个测试等于没测
  assert.equal(rawKey.length, 33, '样本里的 key 应该是 33 字节（32 位十六进制 + 换行）');

  const key = normalizeKeyBytes(rawKey);
  assert.equal(key.length, 16, '规范化之后必须是 16 字节');

  // 最强判据：解出来的 key 必须和**二进制版本逐字节一致**。
  // 只断言长度是 16 是不够的 —— 随便凑 16 个字节也能过。
  const canonical = new Uint8Array(readFileSync(fixturePath('hls-enc', 'enc.key')));
  assert.deepEqual([...key], [...canonical], '十六进制解出来的 key 必须和二进制版本完全相同');

  const chunks = [];
  const remuxer = createTsRemuxer(muxjs, {
    onInit: (b) => chunks.push(b),
    onFragment: (b) => chunks.push(b),
  });
  for (const seg of pl.segments) {
    const iv = ivForSegment(seg, pl.mediaSequence);
    const plain = await decryptAes128Cbc(key, iv, bytesAt(seg.uri));
    assert.equal(plain[0], 0x47, '解密后应当是 TS 同步字节');
    remuxer.append(plain);
  }
  remuxer.end();

  const out = writeTmp('hls-enc-hex-output.mp4', chunks);
  const info = probe(out);
  assert.ok(videoStream(info), '视频轨必须在');
  assert.ok(audioStream(info), '音频轨必须在');
  const duration = Number(info.format.duration);
  assert.ok(Math.abs(duration - 12) < 0.7, `时长应约 12 秒，实际 ${duration.toFixed(3)}`);
});

/* ------------------------------------------------------------------ *
 * 产物必须是"能拖进度条"的 MP4
 *
 * 这两条是被真实投诉逼出来的：
 *   用户下载完在 PotPlayer 里播放，播了 2 秒想拖到 2 分钟，一拖就跳回去。
 *   原因是 mux.js 直接拼出来的**分片式 MP4** 里，mvhd 时长写着 0xFFFFFFFF
 *   （"时长未知"的哨兵值）——播放器以为文件有 13 小时那么长，
 *   进度条按 13 小时铺开，怎么拖都对不上。
 *
 * 所以断言的不是"能播"（ffprobe 认就行），而是**结构上必须可拖**。
 * 这两件事差得很远：坏掉的那个文件 ffprobe 读起来一切正常。
 * ------------------------------------------------------------------ */

test('对照：mux.js 分片直接拼出来的文件，时长是"未知"——所以下载路径不再那么做', () => {
  const media = parsePlaylist(readFixture('hls-ts', 'v0', 'index.m3u8'), urlFor('hls-ts/v0/index.m3u8'));
  const chunks = [];
  const remuxer = createTsRemuxer(muxjs, {
    onInit: (b) => chunks.push(b),
    onFragment: (b) => chunks.push(b),
  });
  for (const seg of media.segments) remuxer.append(bytesAt(seg.uri));
  remuxer.end();

  const file = writeTmp('fragmented-output.mp4', chunks);
  const info = inspect(file);

  assert.equal(info.hasMvex, true, '分片式输出应当带 mvex');
  assert.equal(info.mvhd.duration, 0xFFFFFFFF,
    '这正是问题所在：mvhd 时长是"未知"哨兵值，播放器会以为文件有十几小时');
  assert.ok(info.topLevel.includes('moof'), '分片式输出由 moof/mdat 组成');
});

test('下载路径的产物：时长正确 + 带完整样本表（才是"能拖进度条"的判据）', { skip: noProbe }, () => {
  const media = parsePlaylist(readFixture('hls-ts', 'v0', 'index.m3u8'), urlFor('hls-ts/v0/index.m3u8'));
  const fragments = [];
  const remuxer = createTsRemuxer(muxjs, { onFragment: (b) => fragments.push(b) });
  for (const seg of media.segments) remuxer.append(bytesAt(seg.uri));
  remuxer.end();

  // 和 parser.js 现在做的事一致：收齐之后交给 mergeFmp4 组装
  const merged = mergeFmp4({
    video: { init: remuxer.initSegment, segments: [concatChunks(fragments)] },
    audio: { init: remuxer.initSegment, segments: [concatChunks(fragments)] },
  });

  const file = writeTmp('seekable-output.mp4', [merged]);
  const info = inspect(file);

  assert.notEqual(info.mvhd.duration, 0xFFFFFFFF, '时长不能是"未知"');
  assert.ok(Math.abs(info.mvhd.seconds - 12) < 0.7,
    `mvhd 时长应当约 12 秒，实际 ${info.mvhd.seconds.toFixed(2)}`);
  assert.equal(info.hasMvex, false, '普通 MP4 不该带 mvex');
  assert.equal(info.traks, 2, '音视频两条轨都要在');
  for (const table of info.sampleTable) {
    for (const box of ['stts', 'stsz', 'stco']) {
      assert.ok(table.includes(box), `样本表里必须有 ${box}（否则没法定位样本、也就拖不动）`);
    }
  }

  // 再用 ffprobe 独立确认一遍产物本身是好的
  const probed = probe(file);
  assert.ok(videoStream(probed), '视频轨必须在');
  assert.ok(audioStream(probed), '音频轨必须在');
});

/* ------------------------------------------------------------------ *
 * 主线 3：fMP4 版 HLS（不需要重封装，直接拼接）
 * ------------------------------------------------------------------ */

test('真实 fMP4 版 HLS：初始化段 + 分片直接拼接即可播放', { skip: noProbe }, () => {
  const base = urlFor('hls-fmp4/index.m3u8');
  const pl = parsePlaylist(readFixture('hls-fmp4', 'index.m3u8'), base);
  assert.ok(pl.map, '应该有 #EXT-X-MAP');

  const chunks = [bytesAt(pl.map.uri)];
  assert.equal(sniffContainer(chunks[0]), 'fmp4', '初始化段应该是 fMP4');

  for (const seg of pl.segments) {
    const bytes = bytesAt(seg.uri);
    assert.equal(sniffContainer(bytes), 'fmp4', `${seg.uri} 应该是 fMP4 分片`);
    chunks.push(bytes);
  }

  const out = writeTmp('hls-fmp4-output.mp4', chunks);
  const info = probe(out);

  const v = videoStream(info);
  const a = audioStream(info);
  assert.ok(v, '产物必须有视频轨');
  assert.ok(a, '产物必须有音频轨');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.width, 640);
  assert.equal(v.height, 360);

  const duration = Number(info.format.duration);
  assert.ok(Math.abs(duration - 12) < 0.7, `时长应约 12 秒，实际 ${duration.toFixed(3)}`);
});

/* ------------------------------------------------------------------ *
 * 让「重封装是不是必要的」这件事有个明确对照
 * ------------------------------------------------------------------ */

test('对照：同样的分片，不重封装直接拼出来的东西 ffprobe 读不出音视频轨', { skip: noProbe }, () => {
  const media = parsePlaylist(readFixture('hls-ts', 'v0', 'index.m3u8'), urlFor('hls-ts/v0/index.m3u8'));
  const naive = media.segments.map((s) => bytesAt(s.uri));
  const out = writeTmp('hls-naive-join.mp4', naive);
  const info = probe(out);
  // 裸 TS 拼接：ffprobe 会把每个 TS 当成独立节目，格式名就不是 mp4
  assert.notEqual(info.format.format_name, 'mov,mp4,m4a,3gp,3g2,mj2');
});

/* ------------------------------------------------------------------ *
 * 抓流产物的文件名
 *
 * 用户过两天打开下载目录，`vh-mse-20260921-003641.mp4` 这种名字是认不出
 * 哪一集是哪一集的。带上标题就能认 —— 但有三条不能破的约束。
 * ------------------------------------------------------------------ */

test('文件名带标题，但必须保留 vh-mse- 前缀（管理页靠它分组）', () => {
  const name = captureFileName('20260921-003641', 1, '【第 3 集】大结局');
  assert.ok(name.startsWith('vh-mse-'), '前缀跑掉了，产物在管理页里会归错组');
  assert.ok(name.includes('第 3 集'), '标题要带进去');
  assert.ok(name.endsWith('.mp4'));
});

test('标题里的非法字符要被净化，长度要压住', () => {
  const part = titlePart('a/b\\c:d*e?f"g<h>i|j');
  assert.doesNotMatch(part, /[<>:"/\\|?*]/, `文件名里不能有这些字符：${part}`);

  const long = titlePart('很长很长的标题'.repeat(20));
  assert.ok(long.length <= 60, `标题片段要压住长度，实际 ${long.length}`);
  assert.ok(long.endsWith('-'));
});

test('没有标题、标题没有信息量、标题是 Windows 保留设备名时都安全', () => {
  // 空标题：退化成原来的纯时间戳名字
  assert.equal(titlePart(''), '');
  assert.equal(titlePart(null), '');
  assert.equal(captureFileName('20260921-003641', 1, ''), 'vh-mse-20260921-003641.mp4');
  // 单字符标题没有信息量
  assert.equal(titlePart('x'), '');
  // Windows 保留设备名：sanitizeSegment 会加下划线前缀，拼出来的文件名是合法的
  assert.equal(titlePart('con'), '_con-');
  assert.ok(!/^con/i.test(captureFileName('20260921-003641', 1, 'con')));
});

test('序号仍然跟着标题走：第 2 段带 -2，不会互相覆盖', () => {
  const a = captureFileName('20260921-003641', 1, '标题');
  const b = captureFileName('20260921-003641', 2, '标题');
  assert.notEqual(a, b);
  assert.ok(b.includes('-2.mp4'));
});

test('标题末尾的「 - 站点名」要剥掉，但不是通用规则（电影名不能被削）', () => {
  assert.equal(titlePart('Big Buck Bunny - YouTube'), 'Big Buck Bunny-');
  assert.equal(titlePart('【第 3 集】大结局 - 哔哩哔哩'), '【第 3 集】大结局-');
  assert.equal(titlePart('YouTube'), '', '整条标题就是站点名时不该加');
  // 关键的一条：不能把正当的标题削掉
  assert.equal(titlePart('Star Wars - A New Hope'), 'Star Wars - A New Hope-');
});

test('部分产物的名字：前缀在最前、标注「-部分」，和完整产物分得开', () => {
  const part = partialCaptureFileName('20260921-012620', 'Big Buck Bunny - YouTube');
  assert.equal(part, 'vh-mse-Big Buck Bunny-20260921-012620-部分.mp4');
  assert.ok(part.startsWith('vh-mse-'), '前缀必须在最前面，管理页靠它分组');
  assert.ok(part.includes('Big Buck Bunny'), '标题要在前缀后面');
  assert.ok(/-部分\.mp4$/.test(part), '要能认出"这只是部分"');
  // 和完整产物不能撞名
  const whole = captureFileName('20260921-012620', 1, 'Big Buck Bunny');
  assert.notEqual(part, whole);
});

/* ------------------------------------------------------------------ *
 * 自动保存已录到的部分（滚动覆盖）
 *
 * 用户提的："这里也可以加一个，自动保存已录制的部分勾选按钮"。
 * 关键决定是**滚动覆盖只留最新一份** —— 每次留一份的话（手动那份写的是
 * 当前整个缓冲）体积会成倍涨，2 小时视频按 10 分钟一存差不多 6 倍，
 * 而这功能本来就是为了防"配额满/崩溃把数据全丢了"，反倒先把空间吃光就荒唐了。
 * ------------------------------------------------------------------ */

test('自动保存的文件名：带 -自动部分，和手动那份分得开', () => {
  const auto = autoSnapshotFileName('20260921-010203', 'Big Buck Bunny - YouTube');
  const manual = partialCaptureFileName('20260921-010203', 'Big Buck Bunny - YouTube');
  assert.equal(auto, 'vh-mse-Big Buck Bunny-20260921-010203-自动部分.mp4');
  assert.notEqual(auto, manual, '自动的那份会被覆盖，手动的那份不会 —— 名字必须分得开');
  assert.ok(auto.startsWith('vh-mse-'), '前缀还在最前面，管理页靠它分组');
  // WebM 产物也是同一套规则
  assert.equal(autoSnapshotFileName('20260921-010203', '', 'webm'), 'vh-mse-20260921-010203-自动部分.webm');
});

test('靠文件名就能认出"这是自动保存的那一份"（清理时不依赖内存记录）', () => {
  assert.equal(isAutoSnapshotName('vh-mse-20260921-010203-自动部分.mp4'), true);
  assert.equal(isAutoSnapshotName('vh-mse-x-自动部分.webm'), true);
  assert.equal(isAutoSnapshotName('vh-mse-20260921-010203-部分.mp4'), false, '手动那份不许当成自动的删掉');
  assert.equal(isAutoSnapshotName('vh-mse-20260921-010203.mp4'), false);
  assert.equal(isAutoSnapshotName(null), false);
});

test('自动保存该不该动手：每一条"不动手"的理由都要有名字', () => {
  assert.equal(autoSnapshotPlan({ enabled: false, chunks: 5, bytes: 100 }), 'off');
  assert.equal(autoSnapshotPlan({ enabled: true, awaitingRetry: true, chunks: 5, bytes: 100 }), 'retry-pending');
  assert.equal(autoSnapshotPlan({ enabled: true, chunks: 0, bytes: 0 }), 'empty');
  assert.equal(autoSnapshotPlan({ enabled: true, chunks: 5, bytes: 100 }), 'write');
  // 和上一份一模一样（播放暂停着没动）→ 不再重复写
  assert.equal(
    autoSnapshotPlan({ enabled: true, chunks: 5, bytes: 100, last: { chunks: 5, bytes: 100 } }),
    'unchanged',
  );
  // 又收到新数据了 → 该写
  assert.equal(
    autoSnapshotPlan({ enabled: true, chunks: 6, bytes: 120, last: { chunks: 5, bytes: 100 } }),
    'write',
  );
});

test('间隔换算：默认 10 分钟，但允许几秒钟（否则这个功能没法自动化验）', () => {
  assert.equal(autoSnapshotIntervalMs(10), 600000);
  assert.equal(autoSnapshotIntervalMs(5), 300000);
  assert.equal(autoSnapshotIntervalMs(0.05), 3000);
  assert.equal(autoSnapshotIntervalMs(999), 120 * 60000, '上限 120 分钟');
  assert.equal(autoSnapshotIntervalMs(undefined), 600000, '读不到就用默认值，不是关掉功能');
  assert.equal(autoSnapshotIntervalMs('abc'), 600000);
});

test('自动保存的两种口径：录制时间 vs 视频内容时长（倍速播放时差好几倍）', () => {
  const base = { enabled: true, chunks: 10, bytes: 1000, intervalMs: 600000 };  // 10 分钟
  // 挂钟口径（默认）：录够了就存，内容多长不管
  assert.equal(autoSnapshotPlan({ ...base, basis: 'wall', elapsedMs: 599000, mediaSeconds: 99999 }), 'not-yet');
  assert.equal(autoSnapshotPlan({ ...base, basis: 'wall', elapsedMs: 600000, mediaSeconds: 1 }), 'write');
  // 内容口径：内容够长就存 —— 这正是倍速播放时用户要的（4 倍速下挂钟 10 分钟 = 内容 40 分钟）
  assert.equal(autoSnapshotPlan({ ...base, basis: 'media', elapsedMs: 599000, mediaSeconds: 599 }), 'not-yet');
  assert.equal(autoSnapshotPlan({ ...base, basis: 'media', elapsedMs: 8000, mediaSeconds: 600 }), 'write',
    '内容够 10 分钟就该存，哪怕只录了 8 秒（倍速播放）');
  // ⚠️ 拿不到媒体时间戳（WebM 那种没有 tfdt 的流）必须**回落成挂钟**，
  // 绝不能因为"量不出来"就永不保存 —— 那等于把安全网拆掉
  assert.equal(autoSnapshotPlan({ ...base, basis: 'media', elapsedMs: 600000, mediaSeconds: null }), 'write',
    '量不出内容时长时按挂钟算，而不是永远不存');
  assert.equal(autoSnapshotPlan({ ...base, basis: 'media', elapsedMs: 1000, mediaSeconds: null }), 'not-yet');
  assert.equal(autoSnapshotPlan({ ...base, basis: 'media', elapsedMs: 1000, mediaSeconds: 1 }), 'not-yet');
});

test('自动保存首份快照（10秒）与后续设定间隔滚动覆盖：前10秒出产物，之后按5分钟保存', () => {
  const cfg = { enabled: true, chunks: 10, bytes: 50000, intervalMs: 300000, initialMediaSeconds: 10, basis: 'media' };
  // 1. 媒体内容还没到 10 秒（例如 5 秒）→ not-yet
  assert.equal(autoSnapshotPlan({ ...cfg, mediaSeconds: 5, elapsedMs: 5000 }), 'not-yet');

  // 2. 媒体内容满 10 秒 → write（第一份快照触发）
  assert.equal(autoSnapshotPlan({ ...cfg, mediaSeconds: 10, elapsedMs: 10000 }), 'write');

  // 3. 第一份存完了，记录 last
  const last1 = { chunks: 10, bytes: 50000, mediaSeconds: 10, elapsedMs: 10000 };

  // 4. 满 15 秒（距离第一份才 5 秒，没到 5 分钟间隔）→ not-yet
  assert.equal(autoSnapshotPlan({ ...cfg, chunks: 15, bytes: 80000, mediaSeconds: 15, elapsedMs: 15000, last: last1 }), 'not-yet');

  // 5. 满 309 秒（距离第一份 299 秒，还没到 300 秒间隔）→ not-yet
  assert.equal(autoSnapshotPlan({ ...cfg, chunks: 100, bytes: 500000, mediaSeconds: 309, elapsedMs: 309000, last: last1 }), 'not-yet');

  // 6. 满 310 秒（距离第一份已满 300 秒 = 5 分钟间隔）→ write（第二份快照触发）
  assert.equal(autoSnapshotPlan({ ...cfg, chunks: 102, bytes: 510000, mediaSeconds: 310, elapsedMs: 310000, last: last1 }), 'write');

  // 7. 若数据没有变（播放器暂停未抓到新字节）→ unchanged
  assert.equal(autoSnapshotPlan({ ...cfg, chunks: 102, bytes: 510000, mediaSeconds: 310, elapsedMs: 310000, last: { chunks: 102, bytes: 510000, mediaSeconds: 10 } }), 'unchanged');
});

/* ------------------------------------------------------------------ *
 * 攒太大自动切段：长抓流不丢数据的正解
 *
 * 为什么要有这一组：抓流把码流全收在内存里、收尾才合成一整块，实测抓到的数据
 * 超过 ~1 GB 基本必定失败 —— 而那时数据只能丢。到阈值先写出一段完整文件、
 * 清空缓冲接着抓，是这个问题的正解；阈值和判据必须能单测，否则没法验。
 * ------------------------------------------------------------------ */

test('切段阈值：默认 600 MB，能夹范围，也能调到极小给用例用', () => {
  assert.equal(captureCutThresholdBytes(600), 600 * 1024 * 1024);
  assert.equal(captureCutThresholdBytes(300), 300 * 1024 * 1024);
  // 下限：用例要把阈值调到几十 KB 才能验"真的会切"（同 autoSnapshotIntervalMs 的道理）
  assert.equal(captureCutThresholdBytes(0.05), Math.round(0.05 * 1024 * 1024));
  assert.equal(captureCutThresholdBytes(0.001), Math.round(0.05 * 1024 * 1024), '低于下限按下限走');
  assert.equal(captureCutThresholdBytes(99999), 4096 * 1024 * 1024, '上限 4 GB');
  assert.equal(captureCutThresholdBytes(undefined), 600 * 1024 * 1024, '读不到就用默认值');
  assert.equal(captureCutThresholdBytes('abc'), 600 * 1024 * 1024);
});

test('该不该切段：每一条"不该切"的理由都要有名字', () => {
  const base = { enabled: true, chunks: 10, bytes: 700 * 1048576, threshold: 600 * 1048576 };
  assert.equal(captureCutPlan(base), 'cut');
  assert.equal(captureCutPlan({ ...base, enabled: false }), 'off');
  assert.equal(captureCutPlan({ ...base, awaitingRetry: true }), 'retry-pending',
    '上一次收尾写盘失败、数据还攥在手里时不能再切（只会再失败一次）');
  assert.equal(captureCutPlan({ ...base, cutting: true }), 'cutting',
    '上一段还在写（写盘是异步的，心跳一秒一次）');
  assert.equal(captureCutPlan({ ...base, chunks: 1 }), 'empty', '只有 init、还没媒体数据');
  assert.equal(captureCutPlan({ ...base, chunks: 0, bytes: 0 }), 'empty');
  assert.equal(captureCutPlan({ ...base, bytes: 599 * 1048576 }), 'below');
  // 边界：正好等于阈值就该切（不是">"才切）
  assert.equal(captureCutPlan({ ...base, bytes: 600 * 1048576 }), 'cut');
  assert.equal(captureCutPlan({}), 'off', '什么都没传 = 没开');
});

test('接近阈值的提醒：到 75% 才说，而且开/关两种说辞都对', () => {
  const threshold = 600 * 1048576;
  assert.equal(captureSizeNotice({ enabled: true, bytes: 100 * 1048576, threshold }), null);
  assert.equal(captureSizeNotice({ enabled: true, bytes: threshold * 0.7, threshold }), null,
    '没到 75% 不要打扰用户');
  const on = captureSizeNotice({ enabled: true, bytes: threshold * 0.8, threshold });
  assert.match(on, /会自动切成一段/);
  assert.match(on, /480 MB/, '要说清现在攒到多少');
  assert.match(on, /600 MB/, '也要说清阈值');
  assert.match(on, /按文件名顺序/, '得告诉用户切出来的几段怎么用');
  // 关掉这个功能时，提醒必须换成"再大下去会失败，建议手动存一份"
  const off = captureSizeNotice({ enabled: false, bytes: threshold * 0.8, threshold });
  assert.match(off, /关着的/);
  assert.match(off, /先保存已录到的部分/);
  assert.doesNotMatch(off, /会自动切/, '关掉时不能还说"会自动切"');
  assert.equal(captureSizeNotice({ enabled: true, bytes: 1e9, threshold: 0 }), null, '没有阈值就不提');
});
