# SESSION_HANDOVER.md

## 1. 当前目标
- **核心目标**：针对 MSE 抓流在 4K 超高清流、单页 SPA 列表连播、2x~12x 极速倍速推流等极端复杂场景下的全链路稳定性强化与 v0.2.6 版本交付。
- **正在解决/已解决的核心 Bug**：
  1. 解决高倍速抓流（2x~12x）时悬浮卡片「抓取内容」仅显示物理挂钟耗时（如 34s，实际视频为 03:12）的问题；
  2. 解决单页应用（SPA）列表连续播放时无法自动换集切段、标题不更新、第二集开头被续播跳过、以及换集瞬间产生几 KB 幽灵残片的问题；
  3. 解决大文件达到 600MB 切段阈值时残余分片被清空导致下一段开头出现断流画面跳跃、以及自动保存首份快照滞后的问题；
  4. 解决 WebM 换容器/重发 init 丢帧、首抓卡死主线程等全部已知缺陷。

---

## 2. 已完成变更
- **当前代码状态**：**完全可用、所有测试全绿、已构建打包**。
  - `check-syntax`：37 个 JS 源码文件体检全部通过；
  - `npm test`：228/228 全部通过；
  - `npm run repro`：14/14 缺陷复现全绿通过；
  - 分支状态：`main` 已更新为最新代码并准备打上 `v0.2.6` 标签；旧主分支已备份至 `main-old`（并已将 39 个过程提交存档至本地 `backup/v0.2.3-dev-history` 分支）。

- **核心修改/新增文件与改动逻辑**：
  1. [`src/parser/mse-assemble.js`](src/parser/mse-assemble.js)：
     - 新增 `sidx` box 解析，精确提取该轨真实 `timescale`；
     - 在 `readTraf` 中提取 `trun` / `tfhd` 中的 `durationTicks` 计算实际 sample duration；
     - 彻底废弃 1000 错误兜底，默认按视频 90,000 / 音频 48,000 计算，间隙阈值拓宽到 30 秒。
  2. [`src/content/mse-hook.js`](src/content/mse-hook.js)：
     - 维护 `activeSourceBuffers` 列表，在首次 `appendBuffer` 时自动缓存初始化段 `__vhInit`；
     - 增加 `replay_inits` 监听，在中途随时开启抓流时向 offscreen 管道自动重放 init，保障解码参数与时间基 100% 正确；
     - `appendBuffer` 快照采用原生 `Uint8Array.slice()`，分块 48KB 异步微任务让出主线程编码，彻底消除起播卡死。
  3. [`src/offscreen/offscreen.js`](src/offscreen/offscreen.js)：
     - `trackMediaTime` 接入 `t.timescale` 和 `t.durationTicks`，实现真实媒体时长动态累加；
     - 大文件切段时执行 `remainder` 无损交接，提取未被消费的分片递交下一段；
     - 自动保存策略新增「前 10 秒首份安全快照」机制；
     - 换集时丢弃瞬态残片，并解耦主产物与附属 WebM 产物的音轨。
  4. [`src/content/content.js`](src/content/content.js)：
     - 监听 SPA 连播集数切换与媒体时间戳归零，主动上报换集切分；
     - 抓取当前激活单集的真实标题，第二集自动回跳开头；
     - 起播看护器引入 3.5s 冷却与状态机，彻底消除原生播放器死循环打断。
  5. [`src/recorder/recorder.js`](src/recorder/recorder.js)：
     - 「抓取内容」彻底解耦播放器当前进度，严格展示内存真实媒体时长 `candidateCap`；
     - 引入 1 秒高频心跳，动态刷新录制用时、抓流时长、内存占用及磁盘快照；
     - 统一支持 2 位数小时格式 `00:00:00`，长标题完整换行展示。
  6. [`README.md`](README.md) & [`CHANGELOG.md`](CHANGELOG.md) & [`docs/RELEASE-v0.2.6.md`](docs/RELEASE-v0.2.6.md)：
     - 同步版本至 0.2.6，补充完整的发布日志与安装说明；
     - 计算并记录了 `dist/video-hunter-0.2.6.zip` 的 SHA-256、SHA-1、MD5 校验和。

---

## 3. 关键上下文与坑点
1. **fMP4 Timescale 敏感性**：
   - fMP4 视频流 timescale 绝大多数为 `90000`（1 秒 = 90,000 ticks），音频通常为 `48000`。
   - 严禁将缺省 timescale 设为 `1000`！一旦设为 1000，2 秒分片（180,000 ticks）将瞬间击穿 6,000 ticks 的断流阈值，导致系统退化为物理挂钟累加（每片计 2 秒）。
2. **中途起播必须重放 `moov`**：
   - 用户在播放过程中途打开抓流时，播放器早已发送过初始化段。若不重放缓存的 `__vhInit`，后续到达的分片将丢失 trackId 与 timescale，导致媒体组被废弃或参数错乱。
3. **主世界与扩展消息隔离与阻塞陷阱**：
   - `mse-hook.js` 运行在页面主世界，严禁在 `appendBuffer` 原生调用前执行同步的大数组遍历或 base64 转换，必须用 `Uint8Array.slice()` 极速快照后异步分块上报。
4. **大文件切段残余分片（remainder）**：
   - 切段保存落盘时，必须将未被当前切段消费的分片传递给下一个分段，不能直接清空缓存数组，否则交界处必然出现画面黑屏或空洞。
5. **Git 分支与推送约定**：
   - 当前工作已全部在 `main` 分支上，本地标签 `v0.2.6`；
   - 旧分支已归档为 `main-old`；
   - 用户要求自己手动执行 `git push`。

---

## 4. 下一步行动清单（TODO）
1. **第一步（用户推送与 Release 发布）**：
   - 用户执行推送命令将本地分支与标签推送到远端：
     ```bash
     git push -u origin main-old
     git push origin main
     git push origin v0.2.6
     ```
   - 用户将 `docs/RELEASE-v0.2.6.md` 内容复制到 GitHub Release v0.2.6，并上传 `dist/video-hunter-0.2.6.zip`。

2. **第二步（下一轮真实站点针对性验证与扩展）**：
   - **验证线路 1**：在 Chrome 中加载已解压扩展 `dist/video-hunter-0.2.6`，实测复杂站点（YouTube 4K、B站 4K AV1、12x 倍速、单页多集连播站点）；
   - **验证线路 2**：若遇到极少数特定站点分片既无 `sidx` 也无 `trun.duration`，检查 `src/parser/mse-assemble.js` 第 450-510 行的 `readFragmentMediaTime`，可进一步增加基于前后分片 `baseMediaDecodeTime` 差值的动态 duration 推导作为双重兜底。
