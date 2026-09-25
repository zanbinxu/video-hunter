/**
 * Video Hunter —— 全局常量与协议定义。
 *
 * 这个文件被 service worker、popup、parser 页、recorder 页共同 import，
 * 所以它必须保持「零副作用、零 chrome.* 依赖」。
 *
 * 这里只放**真的被引用的**常量。原来还有 APP_NAME / APP_VERSION 两个没人用的
 * 常量（名字好听，但版本号只有 manifest.json 一份是真的 —— 在这里再写一份，
 * 早晚会和升级后的 manifest 对不上，变成一个会撒谎的常量）。
 * 需要版本号请用 `chrome.runtime.getManifest().version`。
 */

/**
 * 已保存产物在 OPFS 里的文件名前缀。
 *
 * 抓流和录制分开前缀是有原因的：两者的产物都落在同一个 OPFS 目录里，
 * 而「抓流管理」要按来源分组显示。光看文件名分不出来就只能靠边上的索引，
 * 索引一旦丢了（换 profile、清了扩展数据）就全乱套了 —— 前缀是自解释的。
 *
 * 注意：`vh-rec-` 这个前缀也被早期版本的**抓流**产物用过，所以管理页
 * 不能只靠前缀判定来源，还要看文件头（合并产物是 ftyp 紧跟 moov）。
 */
export const REC_PREFIX = 'vh-rec-';
export const CAPTURE_PREFIX = 'vh-mse-';
export const MEDIA_PREFIXES = [CAPTURE_PREFIX, REC_PREFIX];

/** 产物来源：抓流还是录制。界面上的分组、措辞都由它决定。 */
export const MEDIA_KIND = {
  CAPTURE: 'capture',
  RECORD: 'record',
};

/**
 * 媒体条目类型。
 *
 * 注意 HLS / DASH 是「播放列表」，不是可直接下载的媒体文件；
 * SEGMENT 是分片；FILE / AUDIO 才是能直接落盘的东西。
 */
export const KIND = {
  HLS: 'hls',           // m3u8 播放列表（主列表或子列表）
  DASH: 'dash',         // mpd 清单
  SEGMENT: 'segment',   // ts / m4s 等分片，单独下载没意义
  FILE: 'file',         // 完整视频文件（mp4/webm/mkv/flv…）
  AUDIO: 'audio',       // 独立音频文件或音频轨
  UNKNOWN: 'unknown',
};

export const KIND_LABEL = {
  [KIND.HLS]: 'HLS 播放列表',
  [KIND.DASH]: 'DASH 清单',
  [KIND.SEGMENT]: '媒体分片',
  [KIND.FILE]: '视频文件',
  [KIND.AUDIO]: '音频',
  [KIND.UNKNOWN]: '未知',
};

/* 「这条能不能直接下载」由 `classify()` 返回的 `downloadable` 字段一个人说了算。
 * 原来这里还有一张 `DOWNLOADABLE_KINDS = Set([FILE, AUDIO, HLS, DASH])`，
 * 没有任何代码用它 —— 而它一旦和 classify 的分支不一致，就会变成第二个真相。
 * 要判断请读条目的 `downloadable`。 */

/** 分类置信度。low 表示只靠扩展名猜的，UI 应该弱化显示。 */
export const CONFIDENCE = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
};

/**
 * 这些 webRequest 的请求类型完全不可能承载媒体，嗅探时直接丢掉。
 *
 * 注意它必须放在 constants.js 而不是 classify.js：嗅探层要用它，
 * 而嗅探层不该为了一个静态表去依赖分类器。**这条注释是踩坑留下的** ——
 * 它一度被定义在 classify.js 而 sniffer.js 从 constants.js import，
 * 于是 service worker 启动时抛模块解析错误，整个后台静默死掉：
 * 扩展照样加载、页面照样渲染，但嗅探/下载/录制全都不工作。
 * 现在 check-syntax 会静态校验每个 import 的名字是否真的被导出。
 */
export const IGNORED_REQUEST_TYPES = new Set([
  'image', 'stylesheet', 'script', 'font', 'ping', 'csp_report', 'websocket',
]);

/** 内部消息类型（popup / parser / content <-> service worker） */
export const MSG = {
  // 查询
  GET_TAB_MEDIA: 'vh:get-tab-media',
  GET_SETTINGS: 'vh:get-settings',
  SET_SETTINGS: 'vh:set-settings',
  // 嗅探控制
  CLEAR_TAB_MEDIA: 'vh:clear-tab-media',
  // 下载
  START_DOWNLOAD: 'vh:start-download',
  // 抓取（三级策略）
  FETCH_RESOURCE: 'vh:fetch-resource',
  // 页面
  GET_TAB_INFO: 'vh:get-tab-info',
  OPEN_PARSER: 'vh:open-parser',
  OPEN_RECORDER: 'vh:open-recorder',
  /** 打开解析器页的「独立 fMP4 轨道合并」模式（B 站那类没有清单的 DASH） */
  OPEN_MERGE: 'vh:open-merge',
  // 让扩展页面的请求带上正确的 Referer（会话规则，用完即撤）
  SET_REFERER: 'vh:set-referer',
  CLEAR_REFERER: 'vh:clear-referer',
  // 内容脚本
  INJECT_PAGE_BUTTONS: 'vh:inject-page-buttons',
  PAGE_MEDIA_REPORT: 'vh:page-media-report',
  PAGE_PING: 'vh:page-ping',
  PAGE_SCAN: 'vh:page-scan',
  PAGE_FETCH: 'vh:page-fetch',
  /** 内容脚本刚注入时问一句：这个标签页现在在录吗？ */
  PAGE_READY: 'vh:page-ready',
  /** 让内容脚本进入"录制待命"：回到第一帧、开播、盯着播放结束 */
  ARM_RECORDING: 'vh:arm-recording',
  /** 页面上的媒体播完了 —— 录制该自动收尾了 */
  MEDIA_ENDED: 'vh:media-ended',
  PAGE_DOWNLOAD_CLICK: 'vh:page-download-click',
  // 录制
  RECORD_START: 'vh:record-start',
  RECORD_STOP: 'vh:record-stop',
  RECORD_STATE: 'vh:record-state',
  /**
   * 状态推送，和上面的「查询」严格分开。
   *
   * 一开始两者共用一个类型，结果是：popup 每秒查询一次状态时，
   * 录制台页会把手里的请求当成推送（`msg.state` 是 undefined）→ 显示「空闲」、
   * 开始按钮恢复可点；反向也一样，录制台刷新状态会把 popup 的录制条清掉
   * 并停掉它的轮询，之后 popup 再也不刷新录制状态。
   * 一个消息类型不该同时承担「拉」和「推」两种语义。
   */
  RECORD_STATE_PUSH: 'vh:record-state-push',
  // service worker <-> 离屏文档
  OFFSCREEN_START: 'vh:offscreen-start',
  OFFSCREEN_STOP: 'vh:offscreen-stop',
  OFFSCREEN_STATUS: 'vh:offscreen-status',
  OFFSCREEN_STATE: 'vh:offscreen-state',
  // MSE 抓流：直接拿播放器 appendBuffer 进去的、**已经解密好的**原始码流
  //
  // 注意这里分成两组，绝不能共用一个名字：
  //   vh:mse-*           界面 → service worker（"我要开始/停止抓流"）
  //   vh:offscreen-mse-* service worker → 离屏文档（"你去开始/停止"）
  //
  // 踩过的坑：一开始两组共用了 vh:mse-stop。而 chrome.runtime.sendMessage
  // 是**广播**——离屏文档会直接收到界面发的那条并先停完，service worker 再发
  // 一次时就只剩"没有正在进行的抓流"这个错误，看起来像功能坏了。
  // 一个消息类型不能同时承担两个方向的语义。
  MSE_START: 'vh:mse-start',
  MSE_STOP: 'vh:mse-stop',
  MSE_ARM: 'vh:mse-arm',
  MSE_BUFFER: 'vh:mse-buffer',
  // 「先保存已录到的部分」：把此刻的缓冲写成一个文件，**抓流继续**。
  // 为什么不是"暂停/继续"：数据是播放器边解边喂的，挂起钩子就等于把
  // 那段时间的码流丢掉，产物里会留下真空洞。所以这里只提供"随时拿走一份"。
  MSE_SNAPSHOT: 'vh:mse-snapshot',
  // 「这个视频播完了，页面要换下一个了」—— 内容脚本发现边界时报给后台。
  // 后台据此把当前这段**收尾成一个完整文件**，然后清空缓冲接着抓下一个。
  // 不做的话，播放列表 / 自动连播会把好几个视频连成一个文件。
  MSE_BOUNDARY: 'vh:mse-boundary',
  // 「放弃这一份」：收尾时空间不够、数据还攥在内存里，用户不想腾空间了。
  // 没有这个出口的话，一次失败会卡死后面所有抓流（`mseStart` 会说"已经在抓流中"）。
  MSE_DISCARD: 'vh:mse-discard',
  OFFSCREEN_MSE_START: 'vh:offscreen-mse-start',
  OFFSCREEN_MSE_STOP: 'vh:offscreen-mse-stop',
  OFFSCREEN_MSE_SNAPSHOT: 'vh:offscreen-mse-snapshot',
  OFFSCREEN_MSE_DISCARD: 'vh:offscreen-mse-discard',
  // 自动保存间隔改了：让离屏文档按新值重排定时器（不用重开抓流）
  OFFSCREEN_MSE_AUTOSNAP: 'vh:offscreen-mse-autosnap',
  /**
   * 产物索引的写入转发。
   *
   * 为什么要转发：**离屏文档里没有 chrome.storage**（Chrome 153 实测，只有
   * `chrome.runtime`）。原来离屏文档直接调 `mediaIndex.remember()`，调用没报错、
   * 索引却一条都没写进去 —— 表现是"管理页里的时长记录"永远靠回退去读文件头，
   * 而读不了头的格式（比如 WebM）就永远显示"时长未记录"。
   * 现在离屏文档把这件事交给有 storage 的 service worker。
   */
  INDEX_REMEMBER: 'vh:index-remember',
  INDEX_FORGET: 'vh:index-forget',
  // 收尾当前这段并另起一段（不停止抓流）
  OFFSCREEN_MSE_CUT: 'vh:offscreen-mse-cut',
  // 页面单集标题动态同步与更新
  RECORD_TITLE_UPDATE: 'vh:record-title-update',
  OFFSCREEN_UPDATE_TITLE: 'vh:offscreen-update-title',
  // 页面播放器实时播放进度同步（当前播放时间与视频总时长）
  RECORD_PLAYER_PROGRESS: 'vh:record-player-progress',
  // 广播
  MEDIA_UPDATED: 'vh:media-updated',
};

/**
 * 录制的落盘策略。
 *
 * 离屏文档里**没有用户手势**，所以用不了 File System Access 的保存对话框。
 * 于是分两步走：
 *   录制中 → 写进 OPFS（源私有文件系统），内存占用恒定；
 *   录制完 → 由 recorder 页在用户点击时把 OPFS 文件流式拷到用户选的位置。
 */
export const RECORD_STAGE = {
  IDLE: 'idle',
  RECORDING: 'recording',
  FINALIZING: 'finalizing',
  READY: 'ready',
  ERROR: 'error',
};

/**
 * 日志级别约定 —— 这条不是风格问题，是功能问题。
 *
 * **Chrome 会把扩展页面里的 `console.warn` / `console.error` 收进扩展的错误列表，
 * 并在工具栏卡片上显示一个红点。** 所以：
 *
 *   console.debug  纯排查信息，正常路径上的细枝末节
 *   console.info   「我走了另一条路」——**已经处理好的回退**必须用这个
 *   console.warn   真的出事了，但还能继续
 *   console.error  真的出事了，功能受损
 *
 * 踩过的坑：H.264 编码器不可用时回退到 VP9，那是**预期内的正常回退**，
 * 我却用了 console.warn —— 结果用户为一次完全正常的录制看到一个永久红点，
 * 点开只有一句"退到 VP9"，完全无从判断该不该管。
 * 凡是"代码已经处理好了"的情况，都不该冒红点。
 *
 * （这一条原来挂在一个 `export const LOG_LEVEL_NOTE = 'see RECORD_STAGE doc'` 上，
 * 常量本身没人用、内容还是个占位符，所以删了常量、留下这段说明。）
 */

/* 抓取策略本来是 page → background → debugger 三级，但**只实现了第一级**
 * （页面上下文 fetch，Referer/Cookie/Origin 天然正确）。另外两级的表原来写在这里，
 * 没有任何代码用它，纯属架子 —— 真要做的时候再建表，见 service-worker.js 的
 * FETCH_RESOURCE 分支。 */

/** 默认设置 */
export const DEFAULT_SETTINGS = {
  /** 默认下载画质：auto = 最高的那条 */
  preferredQuality: 'auto',
  /** 并发分片数 */
  concurrency: 6,
  /** 单分片失败重试次数 */
  retries: 3,
  /** 下载目录前缀（空字符串 = 浏览器默认下载目录） */
  downloadSubdir: 'VideoHunter',
  /** 是否在页面上给 <video> 注入下载按钮 */
  injectPageButtons: true,
  /**
   * 最终产物是流式写盘还是先在内存里攒出整份再写。
   * ⚠️ 它**不表示**"分片边下边写"：HLS / DASH / 独立轨道合并都必须先收齐再交给
   * mergeFmp4 组装成带索引的普通 MP4（否则 mvhd 时长是 0xFFFFFFFF，进度条废掉）。
   * 只有 fMP4 直播是真的边收边写。见 parser.js 的 renderPlan / startDownload。
   */
  streamingSave: true,
  /** 录制兜底的视频编码 */
  recordVideoCodec: 'avc1.640028',
  /** 录制兜底的音频编码 */
  recordAudioCodec: 'mp4a.40.2',
  /**
   * 抓流时「每个视频播完就自动存一段」，默认**开**。
   *
   * 为什么默认开：抓流是实时的，一集接一集自动连播，用户往往来不及点保存
   * （实测用户就是这么反馈的）。关掉之后边界仍然会被识别，但**不会**自动落盘 ——
   * 换集时不收尾，下一段的样本攒进同一个缓冲；收尾合并时按「时间轴重新从头开始」
   * 把新的一段整段切掉（产物仍是干净的第一集，不会焊成两集），但那段时间一个文件都没拿到。
   * 所以关掉的人要自己记得在换集前点一次「先保存已录到的部分」。
   */
  autoSaveCapture: true,
  /**
   * 抓流时「每 N 分钟自动存一份已录到的部分」，默认**开**，滚动覆盖只留最新一份。
   *
   * 为什么要有它：抓流是实时的、缓冲只在内存里，中途崩一次/配额满一次，
   * 已经抓到的就全没了。手动那份靠"想起来才点"，靠不住（用户实测就是手动点了三次）。
   *
   * 为什么是**滚动覆盖**而不是每次都留一份：手动那份写的是"当前整个缓冲"，
   * 每次留一份的话体积会成倍涨（2 小时的视频按 10 分钟一存≈ 6 倍）。
   * 滚动保存始终只有一个"到目前为至"的文件，空间占用≈ 1 份，
   * 想留早期检查点就自己点「先保存已录到的部分」——那份不会被自动保存覆盖。
   */
  autoSnapshotCapture: true,
  /**
   * 上面那个的间隔，单位分钟。界面上给 5 / 10 / 30 三档。
   *
   * **默认 5 分钟（用户定的）**：抓流的数据全在内存里，间隔越短，意外时丢的越少；
   * 代价只是"每次写盘的字节更多"（滚动覆盖只留最新一份，所以空间占用还是一份）。
   * 10 分钟是省事的折中，但真出事时丢的是 10 分钟的量。
   */
  autoSnapshotMinutes: 5,
  /**
   * 「每 N 分钟」按什么算：
   *   `wall`  挂钟 —— 你录了 N 分钟（防意外的口径：崩了最多丢 N 分钟的**投入**）
   *   `media` 视频内容 —— 抓到的内容有 N 分钟长（**倍速播放时这才是用户要的**）
   * 用户实测就是这么用的（他有倍速插件），所以这一档必须有，而且界面上要说清差别。
   */
  autoSnapshotBasis: 'wall',
  /**
   * 抓流产物**自动导出到下载目录**（用户的请求）。
   *
   * 行为：一份**完整产物**（收尾 / 换集切分 / 「先保存已录到的部分」）写进
   * 「抓流文件」之后，自动交给浏览器下载器落到下载目录（`downloadSubdir` 下面）。
   *
   * 三条边界，都是用户明确要的：
   *   1. 私有存储（OPFS）里那份**保留**，「保存到磁盘」按钮也**保留** ——
   *      本地误删了还能再导一次；
   *   2. 只导**完整**产物；滚动自动保存那种 10 分钟一份的临时快照**不导**
   *      （否则每 10 分钟往下载目录扔一个文件）；
   *   3. 导出成功会记进索引（已导出），这样「清理已导出的」才敢清。
   */
  autoExportCapture: true,
  /**
   * 抓流「攒得太大就自动切一段」，默认**开**。
   *
   * 为什么默认开：抓流把码流全收在内存里、收尾才交给 mp4-muxer 合成一整块，
   * 实测抓到的数据超过 ~1 GB 基本必定收尾失败 —— 而那时数据只能白白丢掉。
   * 到阈值就先写出一段完整文件、清空缓冲接着抓：一个视频变成两个文件，
   * 总比录了两小时全丢好（用户选的就是这个）。
   *
   * ⚠️ 但要知道两件事：
   *   1. **普通视频根本触发不了它**（一集到不了 600 MB），所以"开着"对它们没有代价；
   *      真正需要它的是 4K / 高码率 —— 那种 10 分钟就 600 MB；
   *   2. 触发之后"第二段"曾经有过问题（借初始化段借错 → **没有声音**，`0.2.2` 修的），
   *      所以 0.2.1 及更早的版本上跑大文件要留意这一点。
   *
   * 关掉的话，接近阈值时会**提前提醒**（建议手动「先保存已录到的部分」），
   * 而不是到收尾时才发现合不出来。
   */
  autoCutCapture: true,
  /** 上面那个的阈值，单位 MB。界面上给 300 / 600 / 1200 三档（默认 600） */
  autoCutMb: 600,
  /**
   * 抓流时**从当前播放位置开始**（默认开）。
   *
   * 为什么还是要刷新：钩子必须在播放器 append 初始化段（moov）之前就位，
   * 否则只捞得到一堆没有 moov 的分片（见 popup 里 startMseCapture 的注释）。
   * 所以流程是"刷新 → 立刻把播放位置拨回你点抓流时的那一秒"，
   * 起播看护要知道**目标是那一秒**，而不是无条件扳回 0。
   *
   * 好处不只是省时间：3 小时的视频从第 2 小时开始抓，产物就只有 1 小时，
   * 内存和磁盘都省下来了（抓流是实时的，从头重播既费时间又费空间）。
   */
  captureFromCurrent: true,
};

/** chrome.storage.session 的 key 前缀 */
export const TAB_KEY_PREFIX = 'vh:tab:';
export const SETTINGS_KEY = 'vh:settings';
export const RECORD_KEY = 'vh:recording';
