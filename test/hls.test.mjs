/**
 * HLS 解析器单元测试 —— 跑真实播放列表 + 构造的边界样本。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAttributes, parsePlaylist, selectVariant, variantHeight, variantWidth,
  describeVariant, ivForSegment, hexToBytes, describeKeyMethod, resolveUrl, summarize,
} from '../src/parser/hls.js';
import { readFixture, urlFor, ORIGIN } from './helpers.mjs';

/* ------------------------------------------------------------------ *
 * 属性解析
 * ------------------------------------------------------------------ */

test('parseAttributes：引号里的逗号不能当分隔符', () => {
  const a = parseAttributes('BANDWIDTH=839232,CODECS="avc1.64001e,mp4a.40.2",RESOLUTION=640x360');
  assert.equal(a.BANDWIDTH, '839232');
  assert.equal(a.CODECS, 'avc1.64001e,mp4a.40.2');
  assert.equal(a.RESOLUTION, '640x360');
});

test('parseAttributes：畸形片段不会吃掉后面的属性', () => {
  const a = parseAttributes('GARBAGE,BANDWIDTH=100,A=1');
  assert.equal(a.BANDWIDTH, '100');
  assert.equal(a.A, '1');
});

/* ------------------------------------------------------------------ *
 * 真实主播放列表
 * ------------------------------------------------------------------ */

test('真实主列表：两个码率都能解出来，并按带宽排序', () => {
  const pl = parsePlaylist(readFixture('hls-ts', 'index.m3u8'), urlFor('hls-ts/index.m3u8'));
  assert.equal(pl.ok, true);
  assert.equal(pl.isMaster, true);
  assert.equal(pl.isMedia, false);
  assert.equal(pl.variants.length, 2);

  const [hi, lo] = pl.variants;
  assert.equal(hi.bandwidth, 839232);
  assert.equal(variantHeight(hi), 360);
  assert.equal(variantWidth(hi), 640);
  assert.equal(lo.bandwidth, 299296);
  assert.equal(variantHeight(lo), 180);

  // 相对路径必须解成绝对路径
  assert.equal(hi.uri, `${ORIGIN}hls-ts/v0/index.m3u8`);
  assert.equal(lo.uri, `${ORIGIN}hls-ts/v1/index.m3u8`);
});

test('选码率：auto 取最高，480 取不超上限的最高，1080 在有更高档时不会被降级', () => {
  const pl = parsePlaylist(readFixture('hls-ts', 'index.m3u8'), urlFor('hls-ts/index.m3u8'));
  assert.equal(variantHeight(selectVariant(pl.variants, 'auto')), 360);
  assert.equal(variantHeight(selectVariant(pl.variants, '480')), 360);
  assert.equal(variantHeight(selectVariant(pl.variants, '1080')), 360);
  // 上限比所有档都低时退到最低档，而不是返回 null
  assert.equal(variantHeight(selectVariant(pl.variants, '144')), 180);
  assert.equal(selectVariant([], 'auto'), null);
});

test('describeVariant 输出人能看懂的一行', () => {
  const pl = parsePlaylist(readFixture('hls-ts', 'index.m3u8'), urlFor('hls-ts/index.m3u8'));
  const text = describeVariant(pl.variants[0]);
  // 16:9 用「360p」这种习惯叫法 —— 它和设置里的画质档位（1080/720/480）是同一套语言
  assert.match(text, /360p/);
  assert.match(text, /kbps|Mbps/);
  assert.match(text, /avc1/);

  // 非 16:9 就直接给宽高，免得「480p」这种叫法让人以为拿到了 854×480
  assert.match(describeVariant({ resolution: '640x480', bandwidth: 500000 }), /640×480/);
  assert.equal(describeVariant({}), '未知码率');
});

/* ------------------------------------------------------------------ *
 * 真实媒体播放列表
 * ------------------------------------------------------------------ */

test('真实媒体列表：分片数、时长、连续序号都对得上', () => {
  const pl = parsePlaylist(readFixture('hls-ts', 'v0', 'index.m3u8'), urlFor('hls-ts/v0/index.m3u8'));
  assert.equal(pl.ok, true);
  assert.equal(pl.isMaster, false);
  assert.equal(pl.isMedia, true);
  assert.equal(pl.endList, true);
  assert.equal(pl.segments.length, 6);
  assert.equal(pl.mediaSequence, 0);
  assert.equal(pl.targetDuration, 2);

  // 12 秒素材切成 6 段，每段 2 秒
  assert.ok(Math.abs(pl.totalDuration - 12) < 0.01, `总时长应约 12 秒，实际 ${pl.totalDuration}`);

  assert.equal(pl.segments[0].seq, 0);
  assert.equal(pl.segments[5].seq, 5);
  assert.equal(pl.segments[0].uri, `${ORIGIN}hls-ts/v0/seg_000.ts`);
  assert.equal(pl.segments[5].uri, `${ORIGIN}hls-ts/v0/seg_005.ts`);
});

test('真实 fMP4 列表：#EXT-X-MAP 被识别成初始化段', () => {
  const pl = parsePlaylist(readFixture('hls-fmp4', 'index.m3u8'), urlFor('hls-fmp4/index.m3u8'));
  assert.equal(pl.ok, true);
  assert.ok(pl.map, '应该解析出 #EXT-X-MAP');
  assert.equal(pl.map.uri, `${ORIGIN}hls-fmp4/init.mp4`);
  assert.equal(pl.segments.length, 6);
  assert.ok(pl.segments.every((s) => s.map && s.map.uri === pl.map.uri));
});

/* ------------------------------------------------------------------ *
 * 加密
 * ------------------------------------------------------------------ */

test('真实加密列表：AES-128 + 显式 IV', () => {
  const pl = parsePlaylist(readFixture('hls-enc', 'index.m3u8'), urlFor('hls-enc/index.m3u8'));
  assert.equal(pl.ok, true);
  assert.equal(pl.drm, null, 'AES-128 不是 DRM');
  assert.equal(pl.encryption.method, 'AES-128');
  assert.equal(pl.encryption.uri, `${ORIGIN}hls-enc/enc.key`);
  assert.ok(pl.encryption.iv.startsWith('0x'));

  const bytes = hexToBytes(pl.encryption.iv);
  assert.equal(bytes.length, 16, 'IV 必须是 16 字节');

  // 每个分片都继承了这把 key
  assert.ok(pl.segments.every((s) => s.key && s.key.uri === pl.encryption.uri));
});

test('IV 推导：没写 IV 时用分片序号的大端 16 字节表示', () => {
  const zero = ivForSegment({ seq: 0, key: {} }, 0);
  assert.deepEqual([...zero], new Array(16).fill(0));

  const one = ivForSegment({ seq: 1, key: {} }, 0);
  assert.deepEqual([...one], [...new Array(15).fill(0), 1]);

  // 258 = 0x0102
  const seq258 = ivForSegment({ seq: 258, key: {} }, 0);
  assert.equal(seq258[14], 1);
  assert.equal(seq258[15], 2);

  // 超过 32 位也不能错 —— 直播流跑久了序号会很大
  const big = ivForSegment({ seq: 2 ** 32 + 5, key: {} }, 0);
  assert.equal(big[11], 1);
  assert.equal(big[15], 5);

  // 显式 IV 优先于推导
  const explicit = ivForSegment({ seq: 7, key: { iv: '0x' + 'ab'.repeat(16) } }, 0);
  assert.ok(explicit.every((b) => b === 0xab));
});

test('EXT-X-MEDIA-SEQUENCE 不为 0 时，序号从它开始算起', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MEDIA-SEQUENCE:100',
    '#EXTINF:4,',
    'a.ts',
    '#EXTINF:4,',
    'b.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');
  const pl = parsePlaylist(text, 'http://vh.test/live/index.m3u8');
  assert.equal(pl.mediaSequence, 100);
  assert.equal(pl.segments[0].seq, 100);
  assert.equal(pl.segments[1].seq, 101);
});

/* ------------------------------------------------------------------ *
 * DRM 红线
 * ------------------------------------------------------------------ */

test('DRM 必须被识别出来，而不是被当成普通加密', () => {
  const widevine = describeKeyMethod({
    METHOD: 'SAMPLE-AES',
    KEYFORMAT: 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed',
  });
  assert.equal(widevine.kind, 'drm');
  assert.equal(widevine.drm, 'Widevine');

  const fairplay = describeKeyMethod({
    METHOD: 'SAMPLE-AES',
    URI: 'skd://key',
    KEYFORMAT: 'com.apple.streamingkeydelivery',
  });
  assert.equal(fairplay.kind, 'drm');
  assert.equal(fairplay.drm, 'FairPlay');

  const playready = describeKeyMethod({
    METHOD: 'SAMPLE-AES',
    KEYFORMAT: 'com.microsoft.playready',
  });
  assert.equal(playready.kind, 'drm');
  assert.equal(playready.drm, 'PlayReady');

  // 普通的 AES-128 不该被误判成 DRM
  assert.equal(describeKeyMethod({ METHOD: 'AES-128', URI: 'k' }).kind, 'aes-128');
  assert.equal(describeKeyMethod({ METHOD: 'AES-128', KEYFORMAT: 'identity', URI: 'k' }).kind, 'aes-128');
  assert.equal(describeKeyMethod({ METHOD: 'NONE' }).kind, 'none');
});

test('带 DRM 的播放列表：解析能过，但 drm 字段必须被标出来', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"',
    '#EXTINF:4,',
    'a.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');
  const pl = parsePlaylist(text, 'http://vh.test/x/index.m3u8');
  assert.equal(pl.ok, true);
  assert.ok(pl.drm);
  assert.equal(pl.drm.drm, 'FairPlay');
  // DRM 的 key 不该被当成可下载的 key URI
  assert.equal(pl.encryption.uri, '');
});

/* ------------------------------------------------------------------ *
 * 字节范围 / 杂项
 * ------------------------------------------------------------------ */

test('EXT-X-BYTERANGE：省略偏移时接上一段的末尾', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-VERSION:4',
    '#EXTINF:4,',
    '#EXT-X-BYTERANGE:1000@0',
    'a.ts',
    '#EXTINF:4,',
    '#EXT-X-BYTERANGE:500',
    'a.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');
  const pl = parsePlaylist(text, 'http://vh.test/x/index.m3u8');
  assert.deepEqual(pl.segments[0].byteRange, { length: 1000, offset: 0, end: 999 });
  assert.deepEqual(pl.segments[1].byteRange, { length: 500, offset: 1000, end: 1499 });
});

test('非法输入要有明确错误，而不是静默返回空列表', () => {
  assert.equal(parsePlaylist('<html>404</html>', 'http://x/').ok, false);
  assert.match(parsePlaylist('<html>404</html>', 'http://x/').error, /EXTM3U/);
  assert.equal(parsePlaylist('', 'http://x/').ok, false);
  // 直播还没开始：合法但不是可下载状态
  const live = parsePlaylist(['#EXTM3U', '#EXT-X-TARGETDURATION:4'].join('\n'), 'http://x/l.m3u8');
  assert.equal(live.ok, false);
  assert.match(live.error, /直播|没有分片/);
});

test('resolveUrl 处理相对路径、绝对路径和协议相对路径', () => {
  assert.equal(resolveUrl('a.ts', 'http://h/p/index.m3u8'), 'http://h/p/a.ts');
  assert.equal(resolveUrl('/a.ts', 'http://h/p/index.m3u8'), 'http://h/a.ts');
  assert.equal(resolveUrl('http://o/a.ts', 'http://h/p/i.m3u8'), 'http://o/a.ts');
  assert.equal(resolveUrl('//o/a.ts', 'https://h/p/i.m3u8'), 'https://o/a.ts');
  assert.equal(resolveUrl('../a.ts', 'http://h/p/q/i.m3u8'), 'http://h/p/a.ts');
});

test('summarize 给 UI 的一句话能反映流的形态', () => {
  const master = parsePlaylist(readFixture('hls-ts', 'index.m3u8'), urlFor('hls-ts/index.m3u8'));
  assert.match(summarize(master).text, /2 个码率/);

  const enc = parsePlaylist(readFixture('hls-enc', 'index.m3u8'), urlFor('hls-enc/index.m3u8'));
  assert.ok(summarize(enc).tags.includes('AES-128 加密'));

  const fmp4 = parsePlaylist(readFixture('hls-fmp4', 'index.m3u8'), urlFor('hls-fmp4/index.m3u8'));
  assert.ok(summarize(fmp4).tags.includes('fMP4 分段'));
});
