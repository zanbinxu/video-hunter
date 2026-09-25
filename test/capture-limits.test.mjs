/**
 * 抓流产物的**分类判据**（`src/core/capture-limits.js`）。
 *
 * 这一份的起因很具体：用户在状态卡上看到「已存 0 个」，以为"什么都没存"，
 * 而那时一份滚动自动保存的快照（`-自动部分`）其实已经躺在管理页里了 ——
 * 三类产物的名字只差几个字（`-部分` / `-自动部分` / 什么都不带），含义却完全不同。
 * 所以这套判据要有名字、要有用例钉住：状态卡和列表都得靠它说实话。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  captureFileName,
  partialCaptureFileName,
  autoSnapshotFileName,
  isAutoSnapshotName,
  captureFileKind,
} from '../src/core/capture-limits.js';

const STAMP = '20260923-1200';

test('三类产物的名字形状：差别只在结尾那一段', () => {
  const complete = captureFileName(STAMP, 1, 'Demo');
  const second = captureFileName(STAMP, 2, 'Demo');
  const frontPart = captureFileName(STAMP, '前段', 'Demo', 'webm');
  const partial = partialCaptureFileName(STAMP, 'Demo');
  const auto = autoSnapshotFileName(STAMP, 'Demo');

  assert.match(complete, /^vh-mse-.+20260923-1200\.mp4$/);
  assert.match(second, /-2\.mp4$/);
  assert.match(frontPart, /-前段\.webm$/);
  assert.equal(captureFileKind(frontPart), 'complete');
  // 这两条是关键：判据锚在**结尾**，所以 `-部分` 必须真的在结尾
  assert.ok(partial.endsWith('-部分.mp4'), partial);
  assert.ok(auto.endsWith('-自动部分.mp4'), auto);
  for (const n of [complete, second, frontPart, partial, auto]) assert.ok(n.includes(STAMP), n);
});

test('三类都能被认出来，而且两套判据不打架', () => {
  const complete = captureFileName(STAMP, 1, 'Demo');
  const second = captureFileName(STAMP, 2, 'Demo');
  const partial = partialCaptureFileName(STAMP, 'Demo');
  const auto = autoSnapshotFileName(STAMP, 'Demo');

  assert.equal(captureFileKind(complete), 'complete');
  assert.equal(captureFileKind(second), 'complete', '第 2 段不是"部分"');
  assert.equal(captureFileKind(partial), 'partial');
  assert.equal(captureFileKind(auto), 'autoSnapshot');

  // 滚动的会被下一次覆盖、手动的谁都不许动 —— 两者绝不能混为一谈
  assert.equal(isAutoSnapshotName(auto), true);
  assert.equal(isAutoSnapshotName(partial), false);
  assert.equal(isAutoSnapshotName(complete), false);
});

test('WebM 产物（整条流都是 WebM 时）同样认得出来', () => {
  assert.equal(captureFileKind(autoSnapshotFileName(STAMP, 'Demo', 'webm')), 'autoSnapshot');
  assert.equal(captureFileKind(partialCaptureFileName(STAMP, 'Demo', 'webm')), 'partial');
  assert.equal(captureFileKind(captureFileName(STAMP, 1, 'Demo', 'webm')), 'complete');
});

test('标题里出现"部分"两个字也不会被误判', () => {
  // 标题是页面标题，什么字都可能有 —— 判据必须锚在结尾，不能被标题里的字骗到
  const a = captureFileName(STAMP, 1, '第 4 讲 部分内容回顾');
  assert.equal(captureFileKind(a), 'complete');
  assert.equal(isAutoSnapshotName(a), false);

  const b = captureFileName(STAMP, 1, '自动部分');
  assert.equal(captureFileKind(b), 'complete');
  assert.equal(isAutoSnapshotName(b), false);

  // 反过来：真的滚动快照，标题里就算带"-部分"也必须认成 autoSnapshot
  const c = autoSnapshotFileName(STAMP, 'x-部分');
  assert.equal(captureFileKind(c), 'autoSnapshot');
});

test('录制产物不是抓流那三类（列表里不该给它贴"完整的一段"）', () => {
  // 录制那条路没有 -部分 / -自动部分 这些花样，判据落在 complete 上，
  // 界面上由调用方按 REC_PREFIX / kind 排除掉（见 recorder.js 的 captureKindText）
  assert.equal(captureFileKind('vh-rec-页面标题-20260923-1200.mp4'), 'complete');
  assert.equal(isAutoSnapshotName('vh-rec-页面标题-20260923-1200.mp4'), false);
});

test('名字是空 / 不是字符串时也不炸', () => {
  assert.equal(captureFileKind(''), 'complete');
  assert.equal(captureFileKind(null), 'complete');
  assert.equal(captureFileKind(undefined), 'complete');
  assert.equal(isAutoSnapshotName(undefined), false);
});
