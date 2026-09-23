/**
 * 存储错误的翻译。
 *
 * 这一组用例替代的是"把配额写满再试"——那在真机上要占 5.6 GB，没法进自动化。
 * 所以把判断做成纯函数，用假的 DOMException 覆盖各家浏览器的表达方式。
 *
 * 背景（用户报过之后才加的）：抓流收尾时写盘失败，原来会把整个缓冲丢掉、
 * 并且只甩一句原始 `QuotaExceededError`。用户既不知道数据没了，
 * 也没有任何补救办法。现在失败后**保留数据**并给出可照做的提示。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { explainStorageError, describeStorageUse } from '../src/core/storage-error.js';

/** 造一个像 DOMException 的东西（Node 里也有 DOMException，但字段名要能对上） */
function domError(name, message, code) {
  const err = new Error(message);
  err.name = name;
  if (code !== undefined) err.code = code;
  return err;
}

test('配额满：要说清"数据没丢"和下一步怎么做', () => {
  const r = explainStorageError(domError('QuotaExceededError', 'The quota has been exceeded.', 22), { bytes: 750 * 1048576 });
  assert.equal(r.storageFull, true);
  assert.equal(r.retryable, true);
  assert.match(r.text, /存储空间不够/);
  assert.match(r.text, /还在内存里/, '必须告诉用户数据没丢，否则他会以为白抓了');
  assert.match(r.text, /重试保存/, '必须给出下一步动作');
  assert.match(r.text, /750 MB/, '要把这次的体积说具体（formatBytes 对 ≥100 的值不带小数）');
});

test('各家浏览器的"空间不够"都要认出来', () => {
  const cases = [
    domError('QuotaExceededError', ''),
    domError('NS_ERROR_DOM_QUOTA_REACHED', ''),
    domError('Error', '', 22),
    domError('Error', 'disk full'),
    domError('Error', 'no space left on device'),
  ];
  for (const err of cases) {
    assert.equal(explainStorageError(err).storageFull, true, `${err.name}/${err.code}/${err.message} 应该判成空间不够`);
  }
});

test('其它错误：如实带上原始信息，不吞', () => {
  const r = explainStorageError(domError('NotFoundError', '文件句柄不存在'));
  assert.equal(r.storageFull, false);
  assert.equal(r.retryable, true);
  assert.match(r.text, /文件句柄不存在/, '原始信息必须留着，否则没法排查');
  assert.doesNotMatch(r.text, /存储空间不够/);
});

test('什么都不是的东西也不能把提示搞崩', () => {
  for (const weird of [undefined, null, '', 0, {}, []]) {
    const r = explainStorageError(weird);
    assert.equal(typeof r.text, 'string');
    assert.ok(r.text.length > 0);
    assert.equal(r.storageFull, false);
  }
});

test('用量那一行：正常显示、快满了要警告、拿不到就给空串', () => {
  assert.match(describeStorageUse({ usage: 208 * 1048576, quota: 6 * 1073741824 }), /已用 208 MB \/ 配额 6\.0 GB/);
  assert.doesNotMatch(describeStorageUse({ usage: 100, quota: 1000 }), /快满/);
  assert.match(describeStorageUse({ usage: 900, quota: 1000 }), /快满了/);
  assert.equal(describeStorageUse(null), '');
  assert.equal(describeStorageUse({}), '');
});
