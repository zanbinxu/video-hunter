/**
 * AES-128 密钥规范化。
 *
 * 这一条是**实测撞出来的**：某个站点报「密钥长度不对：期望 16 字节，实际 33 字节」。
 * 33 = 32 个十六进制字符 + 一个换行 —— 打包器把 key 当十六进制字符串发了，
 * 而 HLS 规范说这里应该是原始二进制。规范之外的东西只能靠容错吃掉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { normalizeKeyBytes, keyCandidates, looksLikeMpegTs, decryptWithKeyCandidates } from '../src/parser/hls-key.js';
import { parsePlaylist, ivForSegment } from '../src/parser/hls.js';
import { readFixture, urlFor, pathFromUrl, fixturePath } from './helpers.mjs';

const bytes = (s) => new TextEncoder().encode(s);

test('正好 16 字节：原样返回，不做任何猜测', () => {
  const raw = new Uint8Array(16).fill(0xab);
  const out = normalizeKeyBytes(raw);
  assert.equal(out, raw, '应该返回同一个对象，不要白白拷一份');
});

test('32 个十六进制字符：解成 16 字节', () => {
  const out = normalizeKeyBytes(bytes('0123456789abcdef0123456789abcdef'));
  assert.equal(out.length, 16);
  // 该串解出来是 01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef
  assert.deepEqual([...out.slice(0, 4)], [0x01, 0x23, 0x45, 0x67]);
  assert.deepEqual([...out.slice(12)], [0x89, 0xab, 0xcd, 0xef]);
});

test('大写十六进制也认', () => {
  const out = normalizeKeyBytes(bytes('0123456789ABCDEF0123456789ABCDEF'));
  assert.deepEqual([...out.slice(0, 4)], [0x01, 0x23, 0x45, 0x67]);
});

test('33 字节（32 个 hex + 换行）—— 就是线上撞到的那个形态', () => {
  const out = normalizeKeyBytes(bytes('5648746573744b657930313233343536\n'));
  assert.equal(out.length, 16);
  assert.equal(Buffer.from(out).toString('ascii'), 'VHtestKey0123456');
});

test('尾部带 \\r\\n 或空格也认', () => {
  assert.equal(normalizeKeyBytes(bytes('5648746573744b657930313233343536\r\n')).length, 16);
  assert.equal(normalizeKeyBytes(bytes('  5648746573744b657930313233343536  ')).length, 16);
});

test('认不出来时，错误信息必须带上内容证据', () => {
  // 服务端返回一个 JSON 错误页 —— 这种情况最需要看到原文
  const json = '{"code":403,"msg":"forbidden!!"}';
  assert.throws(
    () => normalizeKeyBytes(bytes(json)),
    (err) => {
      assert.match(err.message, /期望 16 字节/);
      assert.match(err.message, new RegExp(String(json.length)), '应该报出实际字节数');
      assert.match(err.message, /forbidden/, '应该把内容原文带出来');
      return true;
    },
  );
});

test('长度对但内容不是十六进制的，不能瞎猜', () => {
  // 33 字节但不是十六进制串 —— 必须报错而不是硬解
  assert.throws(() => normalizeKeyBytes(bytes('this is not a key at all!!!!!\n')), /密钥长度不对/);
});

/* ------------------------------------------------------------------ *
 * 密钥恢复：不猜格式，靠解密结果验证
 *
 * 线上撞到过一个 33 字节的高熵二进制响应 —— 既不是十六进制也不是 base64，
 * 「猜格式」这条路走不通。改用验证：AES 解出来是合法 MPEG-TS 的那个才是密钥。
 * ------------------------------------------------------------------ */

test('TS 判据要够严：随机数据不能蒙混过关', () => {
  // 真实 TS 开头
  const real = new Uint8Array(188 * 6);
  for (let p = 0; p < real.length; p += 188) real[p] = 0x47;
  assert.equal(looksLikeMpegTs(real), true, '连续同步字节应当判为 TS');

  // 只有头一个字节是 0x47：随机数据有 1/256 的概率长这样，必须排除
  const barelyLooks = new Uint8Array(188 * 6);
  barelyLooks[0] = 0x47;
  assert.equal(looksLikeMpegTs(barelyLooks), false, '只对一个同步字节不算 TS');

  // 纯随机
  const noise = new Uint8Array(1024);
  for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 137 + 91) & 0xff;
  assert.equal(looksLikeMpegTs(noise), false);

  assert.equal(looksLikeMpegTs(new Uint8Array(0)), false);
});

test('候选密钥：正好 16 字节时只有一个候选，不做多余的事', () => {
  const raw = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) raw[i] = i + 1;
  const list = keyCandidates(raw);
  assert.equal(list.length, 1);
  assert.equal(list[0].label, '原始 16 字节');
  assert.deepEqual([...list[0].key], [...raw]);
});

test('候选密钥：33 字节时穷举所有 16 字节窗口', () => {
  const raw = new Uint8Array(33);
  for (let i = 0; i < 33; i += 1) raw[i] = i;
  const list = keyCandidates(raw);
  // 33 - 16 + 1 = 18 个窗口
  assert.equal(list.length, 18, `应当有 18 个窗口，实际 ${list.length}`);
  // 每个候选都必须是 16 字节
  for (const c of list) assert.equal(c.key.length, 16);
});

test('候选密钥：base64 文本也认', () => {
  // 16 字节 → base64 是 24 个字符
  const key = Uint8Array.from({ length: 16 }, (_, i) => i * 7 & 0xff);
  const b64 = Buffer.from(key).toString('base64');
  assert.equal(b64.length, 24);
  const list = keyCandidates(bytes(b64));
  assert.ok(list.some((c) => c.label === 'base64 文本' && c.key.every((b, i) => b === key[i])));
});

/* ------------------------------------------------------------------ *
 * 端到端：用真实加密样本验证"能找回密钥"
 *
 * 这一条针对的就是线上那个 33 字节高熵响应。构造方式是：
 * 拿真实样本的 16 字节密钥，前面垫 17 字节随机数据凑成 33 字节 ——
 * 形状和线上完全一致，而**正确答案是已知的**，所以能严格断言。
 * ------------------------------------------------------------------ */

/** 用真实的加密样本造一个"响应里多带了些字节"的密钥 */
function wrapRealKey({ prefix = 0, suffix = 0 }) {
  const realKey = new Uint8Array(readFileSync(fixturePath('hls-enc', 'enc.key')));
  assert.equal(realKey.length, 16, '样本的 key 应该是 16 字节');
  const wrapped = new Uint8Array(prefix + 16 + suffix);
  // 垫的字节必须和真密钥不同，否则测不出"是不是真的定位到了"
  for (let i = 0; i < prefix; i += 1) wrapped[i] = (i * 31 + 7) & 0xff;
  wrapped.set(realKey, prefix);
  for (let i = 0; i < suffix; i += 1) wrapped[prefix + 16 + i] = (i * 17 + 3) & 0xff;
  return { wrapped, realKey };
}

function firstCipherAndIv() {
  const pl = parsePlaylist(readFixture('hls-enc', 'index.m3u8'), urlFor('hls-enc/index.m3u8'));
  const seg = pl.segments[0];
  return {
    cipher: new Uint8Array(readFileSync(pathFromUrl(seg.uri))),
    iv: ivForSegment(seg, pl.mediaSequence),
  };
}

test('33 字节响应（17 字节头部 + 真密钥）：靠"解出来是不是 TS"把它找回来', async () => {
  const { wrapped, realKey } = wrapRealKey({ prefix: 17 });
  assert.equal(wrapped.length, 33, '形状要和线上那个 33 字节的响应一致');

  const { cipher, iv } = firstCipherAndIv();
  const found = await decryptWithKeyCandidates(wrapped, iv, cipher);

  assert.ok(found.plain, `应当能找回密钥，但全部候选都失败了：${(found.failures || []).slice(0, 3).join('；')}`);
  assert.equal(found.candidate.label, '第 17 字节起的 16 字节');
  assert.deepEqual([...found.candidate.key], [...realKey], '找回的密钥必须和真的一模一样');
  assert.equal(found.plain[0], 0x47, '解出来的第一个字节应当是 TS 同步字节');
  assert.equal(looksLikeMpegTs(found.plain), true);
});

test('密钥在前面、后面拖了垃圾字节：同样找得回来', async () => {
  const { wrapped, realKey } = wrapRealKey({ suffix: 17 });
  assert.equal(wrapped.length, 33);

  const { cipher, iv } = firstCipherAndIv();
  const found = await decryptWithKeyCandidates(wrapped, iv, cipher);

  assert.ok(found.plain, '应当能找回密钥');
  assert.equal(found.candidate.label, '第 0 字节起的 16 字节');
  assert.deepEqual([...found.candidate.key], [...realKey]);
});

test('响应里根本没有密钥时，要干净地失败并列出试过哪些', async () => {
  // 33 字节纯噪声 —— 线上如果真遇上加密过的响应，就是这个结果
  const noise = new Uint8Array(33);
  for (let i = 0; i < 33; i += 1) noise[i] = (i * 97 + 41) & 0xff;

  const { cipher, iv } = firstCipherAndIv();
  const found = await decryptWithKeyCandidates(noise, iv, cipher);

  assert.equal(found.plain, null, '找不到就是找不到，不能返回一段垃圾当成功');
  assert.equal(found.tried, 18, '33 字节应当试过 18 个窗口');
  assert.ok(found.failures.length > 0, '必须留下失败原因，否则没法排查');
});
