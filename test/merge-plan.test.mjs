/**
 * 「到底有没有可合并的轨道」—— 面板那条提示条的唯一判据。
 *
 * 这组用例是被一个**真 bug** 逼出来的：B 站那种形态（视频轨 `video/mp4`、
 * 音频轨 `audio/mp4`，两条 `.m4s`）下，面板认为只有一条轨道，于是点击合并
 * 只得到一句「至少要有两条轨道才能合并」—— 而提示条上写着"检测到多个独立轨道"。
 * 所以每条断言都在钉"判据算出来的东西和用户看到的话必须一致"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planMerge, trackKindOf } from '../src/core/merge-plan.js';
import { KIND } from '../src/core/constants.js';

const seg = (name, mime, size) => ({
  kind: KIND.SEGMENT,
  url: `https://cdn.example.com/${name}`,
  mime,
  size,
});

const file = (name, mime, size) => ({
  kind: mime.startsWith('audio/') ? KIND.AUDIO : KIND.FILE,
  url: `https://cdn.example.com/${name}`,
  mime,
  size,
});

/* ------------------------------------------------------------------ *
 * 单条轨道的判定
 * ------------------------------------------------------------------ */

test('轨道判定：视频/音频/看不出三类，别把"完整文件"和 TS 混进来', () => {
  // B 站的两条轨
  assert.equal(trackKindOf(seg('video.m4s', 'video/mp4; codecs="avc1.64001e"', 1)), 'video');
  assert.equal(trackKindOf(seg('audio.m4s', 'audio/mp4; codecs="mp4a.40.2"', 1)), 'audio');
  // 音频轨是 AUDIO 而不是 SEGMENT —— 分类器先看 MIME，这正是原来的判据漏掉它的原因
  assert.equal(trackKindOf(file('audio.m4s', 'audio/mp4', 1)), 'audio');
  // 没有 MIME、只有 .m4s 后缀：交给解析器按内容认
  assert.equal(trackKindOf(seg('chunk.m4s', '', 1)), 'unknown');
  // 完整 MP4 文件：直接下载就行，不该出现在"合并"里
  assert.equal(trackKindOf(file('movie.mp4', 'video/mp4', 1)), null);
  // MPEG-TS 的独立轨道走不了合并这条路（那条路要 moov）
  assert.equal(trackKindOf(seg('seg.ts', 'video/mp2t', 1)), null);
  // 页面音效 / 普通音频文件
  assert.equal(trackKindOf(file('click.mp3', 'audio/mpeg', 1)), null);
  // 播放列表不是轨道
  assert.equal(trackKindOf({ kind: KIND.HLS, url: 'https://x/a.m3u8', mime: 'application/x-mpegURL' }), null);
  // 页面 <video> 扫出来的条目没有真地址
  assert.equal(trackKindOf({ kind: KIND.SEGMENT, url: 'blob:https://x/1', video: { hasBlob: true } }), null);
});

/* ------------------------------------------------------------------ *
 * 组合判据
 * ------------------------------------------------------------------ */

test('B 站那种形态：一条视频轨 + 一条音频轨 → 能合并，文案把两条都说出来', () => {
  const plan = planMerge({
    standalone: [seg('video.m4s', 'video/mp4', 24 * 1024 * 1024)],
    files: [file('audio.m4s', 'audio/mp4', 3 * 1024 * 1024)],
  });
  assert.equal(plan.show, true);
  assert.equal(plan.canMerge, true, '这就是用户点了却失败的场景：判据必须成立');
  assert.equal(plan.videoCount, 1);
  assert.equal(plan.audioCount, 1);
  assert.match(plan.text, /1 条视频轨 \+ 1 条音频轨/);
  assert.match(plan.text, /27\.0 MB/);
  assert.match(plan.text, /可合并成一个 MP4/);
  // 送进合并任务的必须是两条（原来只送 standalone 里的那一条）
  assert.equal(plan.tracks.length, 2);
  assert.deepEqual(plan.tracks.map((t) => t.url.split('/').pop()).sort(), ['audio.m4s', 'video.m4s']);
});

test('只有视频轨：能给按钮，但文案必须说清"出来是无声的"', () => {
  const one = planMerge({ standalone: [seg('video.m4s', 'video/mp4', 1000)] });
  assert.equal(one.show, true);
  assert.equal(one.canMerge, true);
  assert.match(one.text, /只看到 1 条视频轨，没有音频轨/);
  assert.match(one.text, /没有声音/);

  const two = planMerge({
    standalone: [seg('v-1080.m4s', 'video/mp4', 9000), seg('v-480.m4s', 'video/mp4', 3000)],
  });
  assert.equal(two.canMerge, true);
  assert.match(two.text, /2 条视频轨，没有音频轨/);
  assert.match(two.text, /只用体积最大的那条/, '合并器只取一条视频，得说出来');
});

test('只有音频轨：判据不成立 —— 不给按钮，并说清缺什么', () => {
  const plan = planMerge({ files: [file('audio.m4s', 'audio/mp4', 2048)] });
  assert.equal(plan.show, true, '原因要说出来，不能默默藏掉');
  assert.equal(plan.canMerge, false, '合并器要一条视频轨，点了必定失败');
  assert.match(plan.text, /只看到 1 条音频轨，没有视频轨/);
  assert.match(plan.text, /至少需要一条视频轨/);
});

test('类型看不出时按老办法办：交给解析器按内容认，但措辞不能瞎猜', () => {
  const plan = planMerge({
    standalone: [seg('a.m4s', '', 1000), seg('b.m4s', '', 2000)],
  });
  assert.equal(plan.canMerge, true);
  assert.match(plan.text, /检测到 2 条独立轨道/);
  assert.match(plan.text, /自动识别音视频/);
  assert.doesNotMatch(plan.text, /视频轨 \+/, '看不出类型就别写"视频轨 + 音频轨"');

  const single = planMerge({ standalone: [seg('a.m4s', '', 1000)] });
  assert.equal(single.canMerge, true, '一条看不出类型的轨道也可能是无声视频，这条路不该堵死');
  assert.match(single.text, /看不出是视频还是音频/);
});

test('有播放列表时合并这条路不出现（分片属于播放列表，走播放列表下载）', () => {
  const plan = planMerge({
    hasPlaylist: true,
    standalone: [],
    files: [file('audio.m4s', 'audio/mp4', 100)],
  });
  assert.equal(plan.show, false);
  assert.equal(plan.canMerge, false);
  assert.equal(plan.text, '');
  assert.equal(plan.tracks.length, 0);
});

test('什么都没有 → 提示条不显示（用户截图里"新标签页也挂着合并条"就是这个）', () => {
  for (const input of [{}, { standalone: [] }, { files: [file('click.mp3', 'audio/mpeg', 10)] }]) {
    const plan = planMerge(input);
    assert.equal(plan.show, false, `不该显示：${JSON.stringify(input)}`);
    assert.equal(plan.canMerge, false);
  }
});

test('同一条地址被请求多次只算一条轨道（B 站会预取/Range/重试）', () => {
  const dup = [
    seg('video.m4s', 'video/mp4', 1000),
    seg('video.m4s', 'video/mp4', 2000),
    file('audio.m4s', 'audio/mp4', 500),
    file('audio.m4s', 'audio/mp4', 800),
  ];
  const plan = planMerge({ standalone: [dup[0], dup[1]], files: [dup[2], dup[3]] });
  assert.equal(plan.videoCount, 1, '不能把同一条地址报成两条视频轨');
  assert.equal(plan.audioCount, 1);
  assert.equal(plan.tracks.length, 2, '也不能把同一条地址下两遍');
  assert.match(plan.text, /1 条视频轨 \+ 1 条音频轨/);
});

test('文案与可点性必须一致：说"可合并"的都能点，不能点的都给了解释', () => {
  const cases = [
    { standalone: [seg('v.m4s', 'video/mp4', 10)], files: [file('a.m4s', 'audio/mp4', 5)] },
    { standalone: [seg('v.m4s', 'video/mp4', 10)] },
    { files: [file('a.m4s', 'audio/mp4', 5)] },
    { standalone: [seg('v.m4s', '', 10), seg('a.m4s', '', 5)] },
  ];
  for (const input of cases) {
    const plan = planMerge(input);
    assert.equal(plan.show, true);
    if (plan.canMerge) {
      assert.ok(plan.tracks.length > 0, `可合并就必须有轨道可送：${JSON.stringify(input)}`);
      assert.ok(plan.text.length > 0, '可合并也要有一句话说明看到了什么');
      assert.doesNotMatch(plan.text, /没有视频轨/, `可合并就不该说缺视频轨：${plan.text}`);
    } else {
      assert.match(plan.text, /没有视频轨|没有可合并/, `不可点就必须说清原因：${plan.text}`);
    }
  }
});
