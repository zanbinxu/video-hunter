/**
 * DASH / MPD 解析器单元测试。
 *
 * 和 HLS 那边同一个思路：真实 MPD 走一遍，边界和红线（DRM、畸形输入）
 * 单独构造。MPD 是机器生成的，所以「解析器读出来的东西和文件里写的一样」
 * 这件事只能靠真样本 + 逐字段断言，不能靠感觉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import {
  parseMpd, selectRepresentations, summarizeMpd, describeRepresentation,
  parseIsoDuration, expandTemplate, classifyContentProtection, describeDrm,
  parseXmlLite, DRM_SCHEMES,
} from '../src/parser/dash.js';
import { readFixture, urlFor, pathFromUrl, ORIGIN } from './helpers.mjs';

const MPD_URL = urlFor('dash-split/out.mpd');
const real = () => parseMpd(readFixture('dash-split', 'out.mpd'), MPD_URL);

/* ------------------------------------------------------------------ *
 * 真实 MPD
 * ------------------------------------------------------------------ */

test('真实 MPD：解析出 1 条视频 + 1 条音频，参数和文件里写的一致', () => {
  const p = real();
  assert.equal(p.ok, true, p.error);
  assert.equal(p.static, true, 'type="static" 应被识别为点播');
  assert.equal(p.type, 'static');
  assert.ok(Math.abs(p.duration - 12) < 0.001, `总时长应约 12 秒，实际 ${p.duration}`);
  assert.equal(p.drm, null, '这个样本不该有 DRM');
  assert.equal(p.adaptations.length, 2, '一个视频 AdaptationSet + 一个音频 AdaptationSet');
  assert.equal(p.representations.length, 2);

  const video = p.representations.find((r) => r.contentType === 'video');
  const audio = p.representations.find((r) => r.contentType === 'audio');
  assert.ok(video, '必须有视频轨');
  assert.ok(audio, '必须有音频轨');

  assert.equal(video.id, '0');
  assert.equal(video.width, 640);
  assert.equal(video.height, 360);
  assert.equal(video.codecs, 'avc1.64001e');
  assert.equal(video.mimeType, 'video/mp4');
  assert.equal(video.bandwidth, 654109);
  assert.equal(video.timescale, 12800);

  assert.equal(audio.id, '1');
  assert.equal(audio.codecs, 'mp4a.40.2');
  assert.equal(audio.mimeType, 'audio/mp4');
  assert.equal(audio.audioSamplingRate, 48000, '音频采样率');
  assert.equal(audio.audioChannels, 1, '音频声道数');
  assert.equal(audio.timescale, 48000);
});

test('分片 URL 是完整绝对地址，而且指向真实存在的文件', () => {
  const p = real();

  for (const rep of p.representations) {
    assert.ok(rep.initUrl.startsWith(ORIGIN), `${rep.contentType} 的 initUrl 应该是绝对地址：${rep.initUrl}`);
    assert.ok(rep.segmentUrls.every((u) => u.startsWith(ORIGIN)), '所有分片都该是绝对地址');
  }

  const video = p.representations.find((r) => r.contentType === 'video');
  assert.equal(video.initUrl, `${ORIGIN}dash-split/init-stream0.m4s`);
  assert.equal(video.segmentUrls.length, 6, '视频 12 秒切 6 段');
  assert.equal(video.segmentUrls[0], `${ORIGIN}dash-split/chunk-stream0-00001.m4s`);
  assert.equal(video.segmentUrls[5], `${ORIGIN}dash-split/chunk-stream0-00006.m4s`);
  assert.ok(Math.abs(video.duration - 12) < 0.001);

  const audio = p.representations.find((r) => r.contentType === 'audio');
  assert.equal(audio.initUrl, `${ORIGIN}dash-split/init-stream1.m4s`);
  assert.equal(audio.segmentUrls.length, 7, '$Number%05d$ 要按 SegmentTimeline 的段数展开');
  assert.equal(audio.segmentUrls[0], `${ORIGIN}dash-split/chunk-stream1-00001.m4s`);
  assert.equal(audio.segmentUrls[6], `${ORIGIN}dash-split/chunk-stream1-00007.m4s`);
  assert.ok(Math.abs(audio.duration - 12) < 0.001);

  // 「URL 造对了」和「文件真的在」是两件事，都得验
  for (const rep of p.representations) {
    assert.equal(existsSync(pathFromUrl(rep.initUrl)), true, `初始化段不存在：${rep.initUrl}`);
    for (const url of rep.segmentUrls) {
      assert.equal(existsSync(pathFromUrl(url)), true, `分片不存在：${url}`);
    }
  }
});

test('SegmentTimeline 的 d 之和就是分片总时长（用来报进度，不当作合并基准）', () => {
  const p = real();
  for (const rep of p.representations) {
    const sum = rep.segmentDurations.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 12) < 0.001, `${rep.contentType} 的 S@d 之和应约 12 秒，实际 ${sum}`);
  }
  assert.equal(p.representations.find((r) => r.contentType === 'video').segmentSource, 'SegmentTemplate');
});

/* ------------------------------------------------------------------ *
 * 选轨
 * ------------------------------------------------------------------ */

test('选轨：视频取不超过画质上限的最高档，音频取最高码率', () => {
  const mpd = multiQualityMpd();
  const parsed = parseMpd(mpd, 'http://cdn.test/m.mpd');
  assert.equal(parsed.ok, true, parsed.error);

  const auto = selectRepresentations(parsed, { preferredQuality: 'auto' });
  assert.equal(auto.video.id, 'v1080', 'auto 取最高档');
  assert.equal(auto.audio.id, 'a128', '音频取最高码率');

  assert.equal(selectRepresentations(parsed, { preferredQuality: 720 }).video.id, 'v720');
  assert.equal(selectRepresentations(parsed, { preferredQuality: '480' }).video.id, 'v480');
  // 上限比所有档都低：退到最低档，而不是返回 null —— 和 hls.js 的 selectVariant 同一套语义
  assert.equal(selectRepresentations(parsed, { preferredQuality: 144 }).video.id, 'v480');
  assert.equal(selectRepresentations(parsed, { preferredQuality: 2160 }).video.id, 'v1080');

  // 只有音频的 MPD 也要能选出音频，视频位置是 null
  const audioOnly = parseMpd(audioOnlyMpd(), 'http://cdn.test/a.mpd');
  const picked = selectRepresentations(audioOnly, {});
  assert.equal(picked.video, null);
  assert.equal(picked.audio.id, 'a0');
});

/* ------------------------------------------------------------------ *
 * DRM 红线
 * ------------------------------------------------------------------ */

test('DRM：Widevine 的 ContentProtection 必须被标出来', () => {
  const parsed = parseMpd(widevineMpd(), 'http://cdn.test/drm.mpd');
  assert.equal(parsed.ok, true, parsed.error);
  assert.ok(parsed.drm, 'drm 字段必须有值');
  assert.equal(parsed.drm.detected, true);
  assert.ok(parsed.drm.systems.includes('Widevine'), `systems 里应有 Widevine，实际 ${parsed.drm.systems}`);
  assert.equal(parsed.drm.defaultKID, '12345678-1234-1234-1234-123456789abc');
  assert.equal(parsed.drm.hasPssh, true);

  // 轨级别也要带 DRM —— 只标在顶层的话，选轨之后就没法拦了
  const video = parsed.representations.find((r) => r.contentType === 'video');
  assert.ok(video.drm, 'Representation 上也必须有 drm');
  assert.ok(video.drm.systems.includes('Widevine'));

  assert.match(describeDrm(parsed.drm), /Widevine/);
  assert.match(describeDrm(parsed.drm), /KID/);

  // 干净的 MPD 不该被误报
  assert.equal(real().drm, null);
});

test('DRM：只有 cenc:default_KID、schemeIdUri 认不出来时也要停下', () => {
  const mpd = `<?xml version="1.0"?>
<MPD xmlns:cenc="urn:mpeg:cenc:2013" type="static" mediaPresentationDuration="PT4S">
  <Period id="0">
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <ContentProtection schemeIdUri="urn:example:weird-drm:2024" cenc:default_KID="abcdef01-2345-6789-abcd-ef0123456789"/>
      <Representation id="a" bandwidth="64000" audioSamplingRate="44100" codecs="mp4a.40.2">
        <SegmentTemplate timescale="44100" initialization="i.mp4" media="s-$Number$.m4s" duration="44100"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
  const parsed = parseMpd(mpd, 'http://cdn.test/x.mpd');
  assert.equal(parsed.ok, true, parsed.error);
  assert.ok(parsed.drm, '看不懂的 ContentProtection 恰恰是最该停下的情况');
  assert.equal(parsed.drm.defaultKID, 'abcdef01-2345-6789-abcd-ef0123456789');
  assert.ok(parsed.drm.systems.length >= 1);
});

test('DRM：各家的 schemeIdUri 认得出来，普通内容不会误判', () => {
  assert.equal(classifyContentProtection('urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed'), 'Widevine');
  assert.equal(classifyContentProtection('urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95'), 'PlayReady');
  assert.equal(classifyContentProtection('com.microsoft.playready'), 'PlayReady');
  assert.equal(classifyContentProtection('com.apple.streamingkeydelivery'), 'FairPlay');
  assert.equal(classifyContentProtection('urn:mpeg:dash:mp4protection:2011'), 'cenc（通用加密，未指明 DRM 系统）');
  // 空白名和空串都不算 DRM
  assert.equal(classifyContentProtection(''), null);
  assert.equal(classifyContentProtection(undefined), null);
  assert.equal(classifyContentProtection('urn:mpeg:dash:23003:3:audio_channel_configuration:2011'), null);
  assert.ok(DRM_SCHEMES.length >= 8);
});

/* ------------------------------------------------------------------ *
 * 非法输入
 * ------------------------------------------------------------------ */

test('非法输入要有明确的中文错误，而不是静默返回空', () => {
  const html = parseMpd('<html><body>404 Not Found</body></html>', 'http://x/');
  assert.equal(html.ok, false);
  assert.match(html.error, /MPD/);
  assert.match(html.error, /html/i);

  const empty = parseMpd('', 'http://x/');
  assert.equal(empty.ok, false);
  assert.match(empty.error, /空/);

  const garbage = parseMpd('这不是 XML，是某段文字', 'http://x/');
  assert.equal(garbage.ok, false);
  assert.match(garbage.error, /没有任何 XML 元素/);

  const truncated = parseMpd('<?xml version="1.0"?><MPD><Period>', 'http://x/');
  assert.equal(truncated.ok, false);
  assert.match(truncated.error, /没有闭合/);

  const mismatched = parseMpd('<MPD><Period></AdaptationSet></MPD>', 'http://x/');
  assert.equal(mismatched.ok, false);
  assert.match(mismatched.error, /不匹配/);

  // 是合法 XML 但没有内容可下
  const noPeriod = parseMpd('<MPD type="static"></MPD>', 'http://x/');
  assert.equal(noPeriod.ok, false);
  assert.match(noPeriod.error, /Period/);

  const noRep = parseMpd('<MPD type="static"><Period id="0"></Period></MPD>', 'http://x/');
  assert.equal(noRep.ok, false);
  assert.match(noRep.error, /Representation/);
});

/* ------------------------------------------------------------------ *
 * 扫描器 / 小工具
 * ------------------------------------------------------------------ */

test('XML 扫描器：忽略命名空间前缀，属性里的 > 不吃掉标签', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<!-- 注释里的 <MPD> 不该被当成元素 -->
<MPD xmlns:cenc="urn:mpeg:cenc:2013" xsi:schemaLocation="urn:a urn:b" type="static" mediaPresentationDuration="PT10S">
  <Period id="0">
    <AdaptationSet contentType="video">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" cenc:default_KID="K1"/>
      <Representation id="v" bandwidth="1" codecs="avc1.42c01e" note="a > b">
        <BaseURL>video/</BaseURL>
        <SegmentTemplate timescale="90000" initialization="i.mp4" media="s-$Number%05d$.m4s" startNumber="1" duration="180000"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

  const scanned = parseXmlLite(xml);
  assert.equal(scanned.error, undefined, scanned.error);
  assert.equal(scanned.root.name, 'MPD');
  assert.equal(scanned.root.attrs.type, 'static');
  assert.equal(scanned.root.attrs.schemaLocation, 'urn:a urn:b', 'xsi: 前缀要去掉');

  const p = parseMpd(xml, 'http://h/dash/x.mpd');
  assert.equal(p.ok, true, p.error);
  const rep = p.representations[0];
  assert.equal(rep.baseUrl, 'http://h/dash/video/', 'BaseURL 要参与相对路径解析');
  assert.equal(rep.initUrl, 'http://h/dash/video/i.mp4');
  assert.equal(rep.segmentUrls.length, 5, '10 秒 / 每段 2 秒');
  assert.equal(rep.segmentUrls[0], 'http://h/dash/video/s-00001.m4s', '$Number%05d$ 要零填充');
  assert.equal(rep.segmentUrls[4], 'http://h/dash/video/s-00005.m4s');
  assert.ok(rep.drm, 'cenc:default_KID 在 Representation 的子元素里，也要被收集到');
});

test('ISO 8601 时长解析', () => {
  assert.equal(parseIsoDuration('PT12.0S'), 12);
  assert.equal(parseIsoDuration('PT0S'), 0);
  assert.equal(parseIsoDuration('PT1M30S'), 90);
  assert.equal(parseIsoDuration('PT1H'), 3600);
  assert.equal(parseIsoDuration('P1DT2H3M4.5S'), 86400 + 7200 + 180 + 4.5);
  assert.equal(parseIsoDuration(''), null);
  assert.equal(parseIsoDuration('12s'), null);
  assert.equal(parseIsoDuration(undefined), null);
});

test('SegmentTemplate 变量展开', () => {
  assert.equal(expandTemplate('chunk-$RepresentationID$-$Number$.m4s', { RepresentationID: '7', Number: 3 }), 'chunk-7-3.m4s');
  assert.equal(expandTemplate('x-$Number%05d$.m4s', { Number: 3 }), 'x-00003.m4s');
  assert.equal(expandTemplate('b-$Bandwidth$-$Time$', { Bandwidth: 800, Time: 25600 }), 'b-800-25600');
  // 不认识的变量原样保留，好过展开成 "undefined"
  assert.equal(expandTemplate('a-$Unknown$', {}), 'a-$Unknown$');
});

test('summarizeMpd / describeRepresentation 说人话', () => {
  const p = real();
  const s = summarizeMpd(p);
  assert.match(s.text, /1 档视频/);
  assert.match(s.text, /1 档音频/);
  assert.match(s.text, /12 秒/);
  assert.ok(s.tags.includes('点播（static）'));
  assert.ok(s.tags.includes('音视频分离（需要合并）'));
  assert.ok(s.tags.includes('未加密'));

  const video = p.representations.find((r) => r.contentType === 'video');
  const text = describeRepresentation(video);
  assert.match(text, /360p/);
  assert.match(text, /kbps|Mbps/);
  assert.match(text, /avc1/);

  const audio = p.representations.find((r) => r.contentType === 'audio');
  assert.match(describeRepresentation(audio), /1 声道/);
  assert.match(describeRepresentation(audio), /48 kHz/);
  assert.equal(describeRepresentation(null), '未知轨道');

  assert.equal(summarizeMpd({ ok: false }).text, '未知');
});

/* ------------------------------------------------------------------ *
 * 构造样本
 * ------------------------------------------------------------------ */

function multiQualityMpd() {
  const rep = (id, height, bandwidth) => `
      <Representation id="${id}" mimeType="video/mp4" codecs="avc1.640028" bandwidth="${bandwidth}" width="${Math.round((height * 16) / 9)}" height="${height}">
        <SegmentTemplate timescale="90000" initialization="i-$RepresentationID$.mp4" media="s-$RepresentationID$-$Number$.m4s" startNumber="1" duration="180000"/>
      </Representation>`;
  const audio = (id, bandwidth) => `
      <Representation id="${id}" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="${bandwidth}" audioSamplingRate="48000">
        <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>
        <SegmentTemplate timescale="48000" initialization="i-$RepresentationID$.mp4" media="s-$RepresentationID$-$Number$.m4s" startNumber="1" duration="192000"/>
      </Representation>`;
  return `<MPD type="static" mediaPresentationDuration="PT6S">
  <Period id="0">
    <AdaptationSet contentType="video" mimeType="video/mp4">${rep('v480', 480, 900000)}${rep('v720', 720, 2000000)}${rep('v1080', 1080, 4000000)}
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">${audio('a64', 64000)}${audio('a128', 128000)}
    </AdaptationSet>
  </Period>
</MPD>`;
}

function audioOnlyMpd() {
  return `<MPD type="static" mediaPresentationDuration="PT4S">
  <Period id="0">
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <Representation id="a0" bandwidth="96000" audioSamplingRate="44100" codecs="mp4a.40.2">
        <SegmentTemplate timescale="44100" initialization="i.mp4" media="s-$Number$.m4s" startNumber="1" duration="88200"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
}

function widevineMpd() {
  return `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" type="static" mediaPresentationDuration="PT10S">
  <Period id="0">
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="12345678-1234-1234-1234-123456789abc"/>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed">
        <cenc:pssh>AAAANHBzc2gBAAAAEHfv7MCyTQKs4w8E2OM8+Q==</cenc:pssh>
      </ContentProtection>
      <Representation id="v0" mimeType="video/mp4" codecs="avc1.64001f" bandwidth="1500000" width="1280" height="720">
        <SegmentTemplate timescale="90000" initialization="init-$RepresentationID$.mp4" media="seg-$RepresentationID$-$Number%05d$.m4s" startNumber="1" duration="180000"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
}
