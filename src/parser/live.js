/**
 * 直播 HLS 的增量拉取。
 *
 * 直播和点播的区别不在「加密」，而在**播放列表会变**：
 * 没有 `#EXT-X-ENDLIST`，列表像一个滑动窗口 —— 每隔几秒老分片沉出去、
 * 新分片浮进来。所以下载直播不是「拉一次列表然后下完」，
 * 而是「反复拉列表，每次只下没见过的那几个」。
 *
 * 这个拆分是有意的：`createLiveTracker` 是纯逻辑（不碰网络、不碰定时器），
 * 所以能在 Node 里用合成的时间线测出「滑窗丢片」这类只在长时间运行后
 * 才暴露的问题；`runLivePolling` 才负责网络和节拍。
 */
import { parsePlaylist } from './hls.js';

/** 可被 abort 打断的 sleep —— 否则取消后还要干等一个轮询周期 */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * 跟踪一个直播播放列表的滑动窗口。
 *
 * @param {string} playlistUrl
 */
export function createLiveTracker(playlistUrl) {
  const seenKeys = new Set();
  const gaps = [];
  let lastSeq = null;
  let ingested = 0;

  /**
   * 分片的去重键。
   *
   * **不能只用 URI**：`#EXT-X-BYTERANGE` 型的播放列表里，多个分片共用同一个
   * URI，只差一个 byteRange。按 URI 去重的话，一轮里第一个分片之后的全部
   * 会被自己挡掉（只收到 1 片），后续轮次更是一片都收不到，
   * 而且因为 lastSeq 不推进，漏片计数也是 0 —— 静默产出残缺文件。
   */
  const keyOf = (seg) => (seg.byteRange
    ? `${seg.uri}@${seg.byteRange.offset}-${seg.byteRange.length}`
    : seg.uri);

  return {
    playlistUrl,

    /**
     * 喂一份刚拉到的播放列表。
     * @returns {Array} 这一轮**新增**的分片（已按序号升序）
     */
    ingest(playlist) {
      const fresh = [];
      for (const seg of playlist.segments) {
        const key = keyOf(seg);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        // 序号不连续 = 我们漏掉了中间的片段。
        // 滑动窗口跑得比我们拉取得快时就会这样 —— 必须如实记下来，
        // 因为产物会有一处跳帧，而不是"下载失败"。
        if (lastSeq != null && seg.seq > lastSeq + 1) {
          gaps.push({
            from: lastSeq + 1,
            to: seg.seq - 1,
            count: seg.seq - lastSeq - 1,
            at: Date.now(),
          });
        }
        lastSeq = seg.seq;
        fresh.push(seg);
        ingested += 1;
      }
      return fresh;
    },

    /** 漏掉的分片区间 */
    get gaps() { return [...gaps]; },
    /** 一共漏了多少片 */
    get missedCount() { return gaps.reduce((n, g) => n + g.count, 0); },
    /** 一共收了多片 */
    get ingestedCount() { return ingested; },
    /** 当前已知的最大序号 */
    get lastSeq() { return lastSeq; },
  };
}

/**
 * 按节拍反复拉取直播播放列表。
 *
 * @param {object} opts
 * @param {string} opts.playlistUrl
 * @param {() => Promise<string>} opts.fetchPlaylist
 * @param {AbortSignal} [opts.signal]
 * @param {(playlist:object, fresh:Array, tracker:object) => any} opts.onPlaylist
 * @param {(err:Error) => void} [opts.onError]
 * @param {() => void} [opts.onEnd]        拉到 #EXT-X-ENDLIST 时调用
 * @param {(playlist:object) => number} [opts.intervalFor]  自定义轮询间隔
 * @returns {Promise<object>} tracker
 */
export async function runLivePolling(opts) {
  const {
    playlistUrl,
    fetchPlaylist,
    signal,
    onPlaylist,
    onError,
    onEnd,
    intervalFor,
  } = opts;

  const tracker = createLiveTracker(playlistUrl);

  // 节拍要跨轮次保留：某一次拉取失败不该把轮询间隔打回默认值，
  // 否则一次网络抖动之后节拍就乱了（在测试里表现为一次抖动让整个用例慢了一个数量级）。
  let interval = 2000;

  while (!signal?.aborted) {
    // 这里刻意把「拉取/解析」和「交给上层处理」分成两段。
    //
    // 合在一个 try 里是踩过的坑：上层的失败（写盘出错、磁盘满、取消）
    // 会被当成「这一次网络不太好」，记一条日志就继续下一轮 ——
    // 表现为录制看起来一直在跑，实际一个字节都写不进去，而且永远不会停。
    //
    // 拉取失败可以重试；上层处理失败是致命的，必须往外抛。
    let playlist = null;
    let fetchError = null;

    try {
      const text = await fetchPlaylist();
      playlist = parsePlaylist(text, playlistUrl);
    } catch (err) {
      fetchError = err;
    }

    if (fetchError) {
      if (signal?.aborted) break;
      onError?.(fetchError);
    } else if (!playlist.ok) {
      onError?.(new Error(playlist.error || '播放列表解析失败'));
    } else if (playlist.isMaster) {
      // 主列表在直播里不会变，出现它说明上层选错了 URL
      onError?.(new Error('拿到的是主播放列表，直播应该盯媒体播放列表'));
    } else {
      // 轮询节拍取目标时长的三分之一：太慢会丢片，太快是白刷。
      // 下限 1 秒，避免 targetDuration 缺失或异常时把自己刷爆。
      interval = intervalFor
        ? intervalFor(playlist)
        : Math.max(1000, Math.round((playlist.targetDuration || 4) * 1000 / 3));

      const fresh = tracker.ingest(playlist);
      await onPlaylist(playlist, fresh, tracker);

      if (playlist.endList) {
        // 直播结束了 —— 最后这一轮已经把剩余分片收干净
        onEnd?.();
        return tracker;
      }
    }

    await sleep(interval, signal);
  }

  return tracker;
}
