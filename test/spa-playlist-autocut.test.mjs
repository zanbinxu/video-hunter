import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isWebmInit, peekWebmClusterTimecode } from '../src/parser/webm-demux.js';
import { readFragmentMediaTime } from '../src/parser/mse-assemble.js';
import { truncateAtTimelineRestart } from '../src/parser/mp4-merge.js';
import { captureFileName, titlePart } from '../src/core/capture-limits.js';

test('单页列表集数命名与标题提取：能够拼接具体集数并净化', () => {
  const pageTitle = '在线智能服务平台';
  const episodeTitle = '2026-09-09-01 智能服务实战与准备流程';
  const combined = `${pageTitle}-${episodeTitle}`;
  const part = titlePart(combined);
  assert.ok(part.includes('2026-09-09-01'), `应当包含具体课节集数编号，实际：${part}`);
  assert.ok(part.endsWith('-'));

  const fileName = captureFileName('20260925-120000', 1, combined, 'mp4');
  assert.ok(fileName.startsWith('vh-mse-'));
  assert.ok(fileName.includes('智能服务实战与准备流程'));
});

test('媒体时间轴重启判定：录制达到一定长度后时间戳归零能够被截断或切集', () => {
  const timescale = 1000;
  // 模拟第一集样本：0 到 200 秒
  const ep1Samples = [];
  for (let s = 0; s <= 200; s += 2) {
    ep1Samples.push({ dts: s * timescale, ctsOffset: 0, size: 5000, keyframe: s % 10 === 0 });
  }

  // 模拟第二集样本：时间轴归零（0 到 10 秒）
  const ep2Samples = [];
  for (let s = 0; s <= 10; s += 2) {
    ep2Samples.push({ dts: s * timescale, ctsOffset: 0, size: 5000, keyframe: s === 0 });
  }

  const mixed = [...ep1Samples, ...ep2Samples];
  const truncated = truncateAtTimelineRestart(mixed, timescale);

  // 第一集样本完整保留，第二集样本切开
  assert.equal(truncated.samples.length, ep1Samples.length);
  assert.equal(truncated.cutCount, ep2Samples.length);
  assert.equal(truncated.cutAtSeconds, 0);
  assert.equal(truncated.afterSeconds, 200);
});

import { formatDuration } from '../src/core/classify.js';

test('时长格式化统一包含小时（00:mm:ss / hh:mm:ss）', () => {
  assert.equal(formatDuration(50), '00:00:50');
  assert.equal(formatDuration(117), '00:01:57');
  assert.equal(formatDuration(176), '00:02:56');
  assert.equal(formatDuration(871), '00:14:31');
  assert.equal(formatDuration(2700), '00:45:00');
  assert.equal(formatDuration(4500), '01:15:00');
  assert.equal(formatDuration(10800), '03:00:00');
});

