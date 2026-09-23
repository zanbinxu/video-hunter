/**
 * 直播增量拉取的测试。
 *
 * 直播的 bug 有个特点：短时间跑完全看不出来，跑半小时才开始丢片。
 * 所以这里用**合成的时间线**（手工构造滑动窗口的快照序列）来压它，
 * 而不是等真的跑那么久。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePlaylist } from '../src/parser/hls.js';
import { createLiveTracker, runLivePolling, sleep } from '../src/parser/live.js';

const URL = 'http://vh.test/live/index.m3u8';

/** 造一份直播播放列表快照：从 startSeq 开始连续 count 片 */
function snapshot({ startSeq, count, duration = 4, endList = false }) {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${duration}`,
    `#EXT-X-MEDIA-SEQUENCE:${startSeq}`,
  ];
  for (let i = 0; i < count; i += 1) {
    lines.push(`#EXTINF:${duration}.000,`, `seg_${String(startSeq + i).padStart(4, '0')}.ts`);
  }
  if (endList) lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

const parse = (text) => parsePlaylist(text, URL);

/* ------------------------------------------------------------------ *
 * tracker：纯逻辑
 * ------------------------------------------------------------------ */

test('首轮：窗口里的分片全部算新增，没有缺口', () => {
  const tracker = createLiveTracker(URL);
  const fresh = tracker.ingest(parse(snapshot({ startSeq: 0, count: 5 })));
  assert.equal(fresh.length, 5);
  assert.deepEqual(fresh.map((s) => s.seq), [0, 1, 2, 3, 4]);
  assert.equal(tracker.gaps.length, 0);
  assert.equal(tracker.lastSeq, 4);
});

test('窗口滑动：只返回新进来的那几片，老的不会重复下', () => {
  const tracker = createLiveTracker(URL);
  tracker.ingest(parse(snapshot({ startSeq: 0, count: 5 })));
  // 窗口前移两片：0、1 沉出去，5、6 浮进来
  const fresh = tracker.ingest(parse(snapshot({ startSeq: 2, count: 5 })));
  assert.deepEqual(fresh.map((s) => s.seq), [5, 6]);
  assert.equal(tracker.ingestedCount, 7);
  assert.equal(tracker.gaps.length, 0);
});

test('重复喂同一份快照：什么都不返回', () => {
  const tracker = createLiveTracker(URL);
  tracker.ingest(parse(snapshot({ startSeq: 10, count: 4 })));
  const fresh = tracker.ingest(parse(snapshot({ startSeq: 10, count: 4 })));
  assert.deepEqual(fresh, []);
  assert.equal(tracker.ingestedCount, 4);
});

test('滑窗跑过头：必须记下漏了哪几片，而不是假装连续', () => {
  const tracker = createLiveTracker(URL);
  tracker.ingest(parse(snapshot({ startSeq: 0, count: 3 })));   // 收到 0,1,2
  // 下一次拉取时窗口已经跑到 6 —— 中间 3、4、5 永久错过了
  const fresh = tracker.ingest(parse(snapshot({ startSeq: 6, count: 3 })));
  assert.deepEqual(fresh.map((s) => s.seq), [6, 7, 8]);
  assert.equal(tracker.gaps.length, 1);
  assert.equal(tracker.gaps[0].from, 3);
  assert.equal(tracker.gaps[0].to, 5);
  assert.equal(tracker.missedCount, 3);
});

test('连续丢两段缺口会分别记下来，不会被合并成一段', () => {
  const tracker = createLiveTracker(URL);
  tracker.ingest(parse(snapshot({ startSeq: 0, count: 2 })));   // 0,1
  tracker.ingest(parse(snapshot({ startSeq: 5, count: 2 })));   // 缺 2,3,4
  tracker.ingest(parse(snapshot({ startSeq: 9, count: 2 })));   // 缺 7,8
  assert.equal(tracker.gaps.length, 2);
  assert.equal(tracker.missedCount, 5);
});

test('直播结束后再喂带 ENDLIST 的快照，剩下的分片仍然会被收进来', () => {
  const tracker = createLiveTracker(URL);
  tracker.ingest(parse(snapshot({ startSeq: 0, count: 3 })));
  const pl = parse(snapshot({ startSeq: 1, count: 4, endList: true }));
  const fresh = tracker.ingest(pl);
  assert.equal(pl.endList, true);
  // 快照是 1,2,3,4；1、2 之前收过，所以新增 3、4
  assert.deepEqual(fresh.map((s) => s.seq), [3, 4]);
});

/* ------------------------------------------------------------------ *
 * polling：节拍与生命周期
 * ------------------------------------------------------------------ */

test('轮询：跨多份快照累计，遇到 ENDLIST 自己停下并回调', async () => {
  const snapshots = [
    snapshot({ startSeq: 0, count: 3 }),
    snapshot({ startSeq: 1, count: 3 }),
    snapshot({ startSeq: 3, count: 3 }),
    snapshot({ startSeq: 4, count: 4, endList: true }),
  ];
  let i = 0;
  const batches = [];
  let ended = false;

  const tracker = await runLivePolling({
    playlistUrl: URL,
    fetchPlaylist: async () => snapshots[Math.min(i++, snapshots.length - 1)],
    intervalFor: () => 5,
    onPlaylist: (_pl, fresh) => { if (fresh.length) batches.push(fresh.map((s) => s.seq)); },
    onEnd: () => { ended = true; },
  });

  assert.equal(ended, true);
  // 快照依次是 [0,1,2] → [1,2,3] → [3,4,5] → [4..7]+ENDLIST
  // 所以每轮真正新增的是 0,1,2 / 3 / 4,5 / 6,7
  assert.deepEqual(batches, [[0, 1, 2], [3], [4, 5], [6, 7]]);
  assert.equal(tracker.ingestedCount, 8);
  // 第 4 份是 ENDLIST，不该再拉第 5 次
  assert.ok(i <= 4, `不该继续拉取，实际拉了 ${i} 次`);
});

test('轮询：单次拉取失败不会终止整个直播，错误照实上报', async () => {
  let calls = 0;
  const errors = [];
  const batches = [];

  const tracker = await runLivePolling({
    playlistUrl: URL,
    fetchPlaylist: async () => {
      calls += 1;
      if (calls === 2) throw new Error('网络抖了一下');
      if (calls >= 4) return snapshot({ startSeq: 2, count: 2, endList: true });
      return snapshot({ startSeq: 0, count: 2 });
    },
    intervalFor: () => 5,
    onPlaylist: (_pl, fresh) => { if (fresh.length) batches.push(fresh.length); },
    onError: (err) => errors.push(err.message),
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /网络抖了一下/);
  assert.ok(tracker.ingestedCount >= 2, '出错之后应当继续跑');
});

test('轮询：abort 之后立刻退出，不会卡在一个轮询周期上', async () => {
  const controller = new AbortController();
  let calls = 0;

  const started = Date.now();
  const tracker = await runLivePolling({
    playlistUrl: URL,
    fetchPlaylist: async () => { calls += 1; return snapshot({ startSeq: 0, count: 2 }); },
    // 故意给一个很长的间隔：如果没有被 abort 打断，这个测试会挂住
    intervalFor: () => 60000,
    signal: controller.signal,
    onPlaylist: () => { controller.abort(); },
  });

  assert.ok(Date.now() - started < 3000, 'abort 应当立刻生效');
  assert.equal(calls, 1);
  assert.equal(tracker.ingestedCount, 2);
});

test('sleep：已经 abort 的 signal 不再等待', async () => {
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  await sleep(50000, controller.signal);
  assert.ok(Date.now() - started < 200, '已 abort 时应当立即返回');
});

test('轮询拿到主列表：报错一次后可以 abort 退出', async () => {
  const errors = [];
  const controller = new AbortController();
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    'v0/index.m3u8',
  ].join('\n');

  await runLivePolling({
    playlistUrl: URL,
    fetchPlaylist: async () => master,
    intervalFor: () => 5,
    signal: controller.signal,
    onPlaylist: () => { throw new Error('主列表不该走到 onPlaylist'); },
    onError: (err) => { errors.push(err.message); controller.abort(); },
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /主播放列表/);
});
