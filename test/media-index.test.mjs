/**
 * 产物元信息索引的测试。
 *
 * 这个模块碰 chrome.storage，所以存储适配器是**注入**的 —— 测试里给一个假存储，
 * 就能把「记住 / 回填 / 删除 / 和真实文件对齐」这套逻辑完整跑一遍，
 * 不用起浏览器。
 *
 * 重点在最后两条：索引是缓存，**坏掉可以，但不能反过来害人**。
 * 索引丢了要能退化成"不知道时长"，而不是报错或者返回一个错的数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMediaIndex, MEDIA_INDEX_KEY } from '../src/core/media-index.js';

function fakeArea(initial = {}) {
  const store = JSON.parse(JSON.stringify(initial));
  const calls = { get: 0, set: 0 };
  return {
    store,
    calls,
    async get(key) {
      calls.get += 1;
      return key in store ? { [key]: JSON.parse(JSON.stringify(store[key])) } : {};
    },
    async set(patch) {
      calls.set += 1;
      Object.assign(store, JSON.parse(JSON.stringify(patch)));
    },
  };
}

test('索引：记下之后能读回来', async () => {
  const area = fakeArea();
  const index = createMediaIndex(area);
  await index.remember({ name: 'vh-mse-1.mp4', kind: 'capture', seconds: 123.4, size: 999 });
  const got = await index.load();
  assert.equal(got['vh-mse-1.mp4'].kind, 'capture');
  assert.equal(got['vh-mse-1.mp4'].seconds, 123.4);
  assert.equal(got['vh-mse-1.mp4'].size, 999);
  assert.ok(got['vh-mse-1.mp4'].at > 0);
});

/**
 * 「已经导出过」是「清理已导出的」唯一的依据。
 *
 * 它必须满足两件事：导出之后记得住；以及**一次重新写盘/回填时长不能把它抹掉** ——
 * 抹掉就意味着用户清理时不敢点（或者更糟：把还没拿出来的文件删了）。
 */
test('索引：已导出的标记记得住，而且不会被重新写盘或回填时长抹掉', async () => {
  const area = fakeArea();
  const index = createMediaIndex(area);
  await index.remember({ name: 'vh-mse-1.mp4', kind: 'capture', seconds: 10, size: 100 });
  await index.patch('vh-mse-1.mp4', { exportedAt: 1726800000000 });
  assert.equal((await index.load())['vh-mse-1.mp4'].exportedAt, 1726800000000);

  // 管理页回填时长（走 patch）
  await index.patch('vh-mse-1.mp4', { kind: 'capture', seconds: 12.5 });
  // 同名文件被重新写一遍（走 remember）
  await index.remember({ name: 'vh-mse-1.mp4', kind: 'capture', seconds: 12.5, size: 120 });
  const got = (await index.load())['vh-mse-1.mp4'];
  assert.equal(got.exportedAt, 1726800000000, '「已导出」不能被这两条路抹掉');
  assert.equal(got.seconds, 12.5);
  assert.equal(got.size, 120);
});

test('索引：时长缺失/非法时存成 null，不会存进 NaN', async () => {
  const area = fakeArea();
  const index = createMediaIndex(area);
  await index.remember({ name: 'a.mp4', kind: 'record', seconds: Number.NaN });
  await index.remember({ name: 'b.mp4', kind: 'record', seconds: 0 });
  await index.remember({ name: 'c.mp4', kind: 'record', seconds: '12.5' });
  const got = await index.load();
  assert.equal(got['a.mp4'].seconds, null);
  assert.equal(got['b.mp4'].seconds, null);
  // 字符串数字是合法的（storage 往返之后可能变成字符串）
  assert.equal(got['c.mp4'].seconds, 12.5);
});

test('索引：kind 只认 capture / record，别的值一律当 record', async () => {
  const area = fakeArea();
  const index = createMediaIndex(area);
  await index.remember({ name: 'x.mp4', kind: '乱七八糟', seconds: 5 });
  assert.equal((await index.load())['x.mp4'].kind, 'record');
});

test('索引：patch 只改给到的字段，其余保留', async () => {
  const area = fakeArea();
  const index = createMediaIndex(area);
  await index.remember({ name: 'a.mp4', kind: 'capture', seconds: null, size: 10 });
  await index.patch('a.mp4', { seconds: 42 });
  const got = (await index.load())['a.mp4'];
  assert.equal(got.seconds, 42);
  assert.equal(got.kind, 'capture');
  assert.equal(got.size, 10, 'patch 不该把没提的字段清掉');
});

test('索引：patch 一个从没记过的文件也能建条目', async () => {
  const area = fakeArea();
  const index = createMediaIndex(area);
  await index.patch('legacy.mp4', { kind: 'capture', seconds: 7 });
  const got = (await index.load())['legacy.mp4'];
  assert.equal(got.kind, 'capture');
  assert.equal(got.seconds, 7);
});

test('索引：删除是幂等的', async () => {
  const area = fakeArea();
  const index = createMediaIndex(area);
  await index.remember({ name: 'a.mp4', kind: 'record', seconds: 1 });
  assert.equal(await index.forget('a.mp4'), true);
  assert.equal(await index.forget('a.mp4'), false);
  assert.deepEqual(await index.load(), {});
});

test('索引：和磁盘对齐会清掉已经不存在的文件', async () => {
  const area = fakeArea();
  const index = createMediaIndex(area);
  await index.remember({ name: 'gone.mp4', kind: 'record', seconds: 1 });
  await index.remember({ name: 'alive.mp4', kind: 'capture', seconds: 2 });
  const after = await index.reconcile(['alive.mp4']);
  assert.deepEqual(Object.keys(after), ['alive.mp4']);
  assert.deepEqual(Object.keys(await index.load()), ['alive.mp4']);
});

test('索引：文件都在时不做多余的写', async () => {
  const area = fakeArea();
  const index = createMediaIndex(area);
  await index.remember({ name: 'a.mp4', kind: 'record', seconds: 1 });
  const before = area.calls.set;
  await index.reconcile(['a.mp4']);
  assert.equal(area.calls.set, before, '没有变化就不该写存储');
});

test('索引：存储坏掉时退化成空索引，而不是让管理页崩掉', async () => {
  const broken = {
    async get() { throw new Error('storage 炸了'); },
    async set() { throw new Error('storage 炸了'); },
  };
  const index = createMediaIndex(broken);
  assert.deepEqual(await index.load(), {});
  // 写入失败也要静默 —— 时长是缓存，不是数据本身
  await index.remember({ name: 'a.mp4', kind: 'capture', seconds: 3 });
  assert.deepEqual(await index.load(), {});
});

test('索引：存进去的东西长得像什么样（钉住存储格式）', async () => {
  const area = fakeArea();
  const index = createMediaIndex(area);
  await index.remember({ name: 'vh-mse-9.mp4', kind: 'capture', seconds: 61.5, size: 2048, at: 1700 });
  assert.deepEqual(area.store[MEDIA_INDEX_KEY], {
    'vh-mse-9.mp4': { kind: 'capture', seconds: 61.5, size: 2048, at: 1700 },
  });
});
