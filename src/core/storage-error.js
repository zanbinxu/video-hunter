/**
 * 把「写文件失败」翻译成用户能照做的人话。
 *
 * ## 为什么值得单独一个模块
 *
 * 抓流的产物是**边播边攒**出来的：用户可能已经等了四十分钟。
 * 收尾时写盘失败如果只甩一句 `QuotaExceededError: ...`，用户既不知道
 * 发生了什么，也不知道**数据还在不在**（在的 —— 只要别关页面），
 * 更不知道下一步该干什么。
 *
 * 所以这里把错误分成两类，各自给一句能直接照做的提示：
 *
 *   1. **空间不够**（配额/磁盘满）：这是用户**能自己解决**的，
 *      提示他先导出/删掉旧产物，再点「重试保存」，并明确"数据没丢"。
 *   2. 其它错误：如实带上原始信息（不吞），但前面加一句"这次没能写出来"。
 *
 * 判断全在纯函数里，所以能在 Node 里用假的 DOMException 测 ——
 * 真机上没法把 5.6 GB 的配额写满来复现。
 */
import { formatBytes } from './classify.js';

/** 各家浏览器表达"空间不够"的方式不一样，只能都认 */
function looksLikeQuota(name, code, message) {
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  // DOMException.QUOTA_EXCEEDED_ERR
  if (code === 22) return true;
  return /quota|exceeded|storage is full|no space left|disk full|空间不足|配额/i.test(String(message || ''));
}

/**
 * @param {unknown} err 写文件时抛出的东西（通常是 DOMException）
 * @param {{bytes?:number}} [info] 这次要写的体积，用来把话说具体
 * @returns {{storageFull:boolean, retryable:boolean, text:string}}
 *          `retryable` 为真表示**数据还在内存里**，清出空间后可以重试
 */
export function explainStorageError(err, info = {}) {
  const name = String(err?.name || '');
  const code = Number(err?.code);
  const message = String(err?.message || err || '').trim() || '（没有更多信息）';
  const size = Number.isFinite(info.bytes) ? `（这次要写 ${formatBytes(info.bytes)}）` : '';

  if (looksLikeQuota(name, code, message)) {
    return {
      storageFull: true,
      retryable: true,
      text: `浏览器的存储空间不够了${size}，文件没能写出来。`
        + '这次抓到的数据**还在内存里，没有丢** —— 别关这个标签页，也别关浏览器。'
        + '请先到管理页把已经导出的旧产物删掉（或者先「保存到磁盘」导出一份再删），'
        + '然后点「重试保存」。',
    };
  }

  return {
    storageFull: false,
    retryable: true,
    text: `这次没能把文件写出来：${message}${size}。`
      + '抓到的数据还在内存里，可以点「重试保存」再试一次。',
  };
}

/** 管理页顶部那行「已用 X / 配额 Y」 */
export function describeStorageUse(estimate) {
  const usage = Number(estimate?.usage);
  const quota = Number(estimate?.quota);
  if (!Number.isFinite(usage) && !Number.isFinite(quota)) return '';
  const used = Number.isFinite(usage) ? formatBytes(usage) : '未知';
  const total = Number.isFinite(quota) ? formatBytes(quota) : '未知';
  const ratio = Number.isFinite(usage) && quota > 0 ? usage / quota : 0;
  // 快满了要提前说 —— 用户不希望"攒了四十分钟才发现写不进去"
  const warn = ratio >= 0.8 ? '　⚠️ 快满了，建议先导出/删掉一些旧产物' : '';
  return `产物存储已用 ${used} / 配额 ${total}${warn}`;
}
