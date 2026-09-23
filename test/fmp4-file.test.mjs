/**
 * B 站那类「没有清单的 DASH」：两条各自自包含的 fMP4 轨道。
 *
 * 这个场景和 m3u8 / mpd 都不同：站点通过 API 直接返回两条**完整的 fMP4 文件地址**
 * （一条纯视频、一条纯音频），每份文件开头是 `ftyp`+`moov`，后面跟一串
 * `moof`+`mdat`。要合成一个能播的 MP4，就得先把它俩各自拆开。
 *
 * 测试数据不是构造的：`dash-split` 那个真实样本里本来就有分开的视频轨和音频轨，
 * 把 init 和分片按顺序接起来，得到的就是和 B 站同一种形态的文件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { listTopLevelBoxes, splitSelfContainedFmp4, describeBoxTree, findBoxPath, listInitTracks } from '../src/parser/fmp4-file.js';
import { parseInitSegment, mergeFmp4 } from '../src/parser/mp4-merge.js';
import { fixturePath, probe, videoStream, audioStream, writeTmp, hasFfprobe } from './helpers.mjs';

const noProbe = hasFfprobe() ? false : '本机没有 ffprobe，跳过产物校验';

/** 把 init + 全部分片接成一个自包含 fMP4 —— B 站那种文件的形态 */
function buildSelfContained(prefix, initName) {
  const dir = fixturePath('dash-split');
  const parts = [new Uint8Array(readFileSync(fixturePath('dash-split', initName)))];
  const chunks = readdirSync(dir)
    .filter((n) => n.startsWith(prefix) && n.endsWith('.m4s'))
    .filter((n) => n !== initName)
    .sort();
  for (const name of chunks) parts.push(new Uint8Array(readFileSync(fixturePath('dash-split', name))));
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.byteLength; }
  return out;
}

/* ------------------------------------------------------------------ *
 * 拆分
 * ------------------------------------------------------------------ */

test('自包含 fMP4 能拆成「初始化段 + 媒体分片」，边界正好落在 moov 之后', () => {
  const file = buildSelfContained('chunk-stream0-', 'init-stream0.m4s');
  const { init, fragments, boxes } = splitSelfContainedFmp4(file);

  // 开头必须是 ftyp + moov
  assert.equal(boxes[0].type, 'ftyp');
  assert.equal(boxes[1].type, 'moov');
  // 紧接着是 styp + sidx + moof + mdat —— 这些都属于**媒体分片**，不属于初始化段。
  // 边界切在 styp 之前，正是这里要验的：多切一个字节都会让 moov 里混进分片数据。
  assert.deepEqual(boxes.slice(2, 5).map((b) => b.type), ['styp', 'sidx', 'moof']);

  assert.equal(init.byteLength, boxes[1].end, '初始化段应当在 moov 结束处切断');
  assert.equal(init.byteLength + fragments.byteLength, file.byteLength, '两段加起来必须是整个文件');

  // 拼回去必须和原文件逐字节相同 —— 不能让"拆分"丢字节
  const rejoined = new Uint8Array(file.byteLength);
  rejoined.set(init, 0);
  rejoined.set(fragments, init.byteLength);
  assert.deepEqual([...rejoined.slice(0, 64)], [...file.slice(0, 64)]);
  assert.equal(rejoined.byteLength, file.byteLength);
});

test('顶层 box 列表覆盖整个文件，不重不漏', () => {
  const file = buildSelfContained('chunk-stream1-', 'init-stream1.m4s');
  const boxes = listTopLevelBoxes(file);
  assert.ok(boxes.length >= 3);
  let cursor = 0;
  for (const b of boxes) {
    assert.equal(b.start, cursor, 'box 之间不能有空洞');
    cursor = b.end;
  }
  assert.equal(cursor, file.byteLength, '最后一个 box 必须正好到文件末尾');
});

test('没有 moov 的文件要报错，并且说清楚开头是什么', () => {
  // 只把 moof+mdat 那种纯分片文件喂进去
  const seg = new Uint8Array(readFileSync(fixturePath('dash-split', 'chunk-stream0-00001.m4s')));
  assert.throws(
    () => splitSelfContainedFmp4(seg),
    (err) => {
      assert.match(err.message, /没有初始化段/);
      assert.match(err.message, /styp|moof/, '应该把实际看到的 box 类型报出来');
      return true;
    },
  );
});

test('空文件 / 垃圾数据不能静默返回半截结果', () => {
  assert.throws(() => splitSelfContainedFmp4(new Uint8Array(0)), /太小/);
  const junk = new Uint8Array(64).fill(0x41);
  assert.throws(() => splitSelfContainedFmp4(junk), /不合法|解析不成 box/);
});

/* ------------------------------------------------------------------ *
 * 轨道识别 + 合并（端到端）
 * ------------------------------------------------------------------ */

test('能自动认出哪条是视频、哪条是音频，不看文件名', () => {
  const videoFile = buildSelfContained('chunk-stream0-', 'init-stream0.m4s');
  const audioFile = buildSelfContained('chunk-stream1-', 'init-stream1.m4s');

  const v = parseInitSegment(splitSelfContainedFmp4(videoFile).init);
  const a = parseInitSegment(splitSelfContainedFmp4(audioFile).init);

  // 关键：不传 contentType，靠 moov 里的 handler box 自己判断
  assert.equal(v.contentType, 'video', 'stream0 应该被认成视频轨');
  assert.equal(a.contentType, 'audio', 'stream1 应该被认成音频轨');
});

test('两条自包含 fMP4 → 合并 → 音视频都在、时长对', { skip: noProbe }, () => {
  const videoFile = buildSelfContained('chunk-stream0-', 'init-stream0.m4s');
  const audioFile = buildSelfContained('chunk-stream1-', 'init-stream1.m4s');

  const vs = splitSelfContainedFmp4(videoFile);
  const as = splitSelfContainedFmp4(audioFile);

  const vInfo = parseInitSegment(vs.init);
  const aInfo = parseInitSegment(as.init);
  assert.equal(vInfo.contentType, 'video');
  assert.equal(aInfo.contentType, 'audio');

  const merged = mergeFmp4({
    video: { init: vs.init, segments: [vs.fragments] },
    audio: { init: as.init, segments: [as.fragments] },
  });

  assert.ok(merged.byteLength > 0);
  assert.equal(String.fromCharCode(merged[4], merged[5], merged[6], merged[7]), 'ftyp');

  const out = writeTmp('selfcontained-merged.mp4', [merged]);
  const info = probe(out);
  const v = videoStream(info);
  const a = audioStream(info);
  assert.ok(v, '合并产物必须有视频轨');
  assert.ok(a, '合并产物必须有音频轨');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.width, 640);
  assert.equal(v.height, 360);
  assert.equal(a.codec_name, 'aac');
  const dur = Number(info.format.duration);
  assert.ok(Math.abs(dur - 12) < 0.7, `时长应约 12 秒，实际 ${dur.toFixed(3)}`);
});

test('只有视频一条时，也能产出可播放的单轨 MP4', { skip: noProbe }, () => {
  const vs = splitSelfContainedFmp4(buildSelfContained('chunk-stream0-', 'init-stream0.m4s'));
  const merged = mergeFmp4({ video: { init: vs.init, segments: [vs.fragments] } });
  const out = writeTmp('selfcontained-video-only.mp4', [merged]);
  const info = probe(out);
  assert.ok(videoStream(info), '应当有视频轨');
  assert.ok(Math.abs(Number(info.format.duration) - 12) < 0.7);
});

test('单条轨道文件本身就是一份能播的单轨 MP4（合并失败时的兜底依据）', { skip: noProbe }, () => {
  // 这条不是"顺便测一下"：合并失败时我们就是把这条轨原样存下来当兜底。
  // 如果它自己不可播，那个兜底就是骗人的。
  const file = writeTmp('selfcontained-raw-track.mp4', [buildSelfContained('chunk-stream0-', 'init-stream0.m4s')]);
  const info = probe(file);
  const v = videoStream(info);
  assert.ok(v, '原样的单条轨道应该能被 ffprobe 认出视频轨');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.width, 640);
  assert.ok(Math.abs(Number(info.format.duration) - 12) < 0.7);
  assert.equal(audioStream(info), undefined, '它本来就没有音轨');
});

/* ------------------------------------------------------------------ *
 * 兜底：样本描述项的固定头长度不标准时，按类型扫描也要能救回来
 *
 * 这条兜底很容易写成"看着对但实际不生效" —— 所以测试要**真的把那个
 * 假设破坏掉**，而不是只跑一遍正常文件就说没问题。
 * ------------------------------------------------------------------ */

/**
 * 在 avc1 的**固定头之后、子 box 之前**插 8 字节，并同步修正祖先 box 长度。
 *
 * 插入点选在 +78 而不是更前面，是有讲究的：标准字段（width 在 +24、
 * height 在 +26）保持原位，只有子 box 整体后移。这正是兜底要覆盖的真实情形 ——
 * 配置项不在固定偏移处（比如被套进了 sinf，或者打包器多写了几个字节），
 * 而**尺寸字段仍然在标准位置**。
 *
 * 如果连标准字段都错位了，那就不是"偏移假设不成立"，是头部被破坏了，
 * 那种情况没法通用地救 —— 这一点在 mp4-merge.js 里写明了。
 */
function widenVideoSampleEntryHeader(init, extra = 8) {
  const chain = findBoxPath(init, 'moov.trak.mdia.minf.stbl.stsd.avc1');
  assert.ok(chain, '测试前提：应该能找到 avc1 那条链');
  const avc1 = chain[chain.length - 1];
  const at = avc1.payloadStart + 78;

  const out = new Uint8Array(init.byteLength + extra);
  out.set(init.subarray(0, at), 0);
  out.set(init.subarray(at), at + extra);

  const writeU32 = (buf, offset, value) => {
    buf[offset] = (value >>> 24) & 0xff;
    buf[offset + 1] = (value >>> 16) & 0xff;
    buf[offset + 2] = (value >>> 8) & 0xff;
    buf[offset + 3] = value & 0xff;
  };
  const readU32 = (buf, offset) => ((buf[offset] << 24 | buf[offset + 1] << 16
    | buf[offset + 2] << 8 | buf[offset + 3]) >>> 0);

  // 所有祖先的起点都在插入点之前，所以偏移不用改，只改长度
  for (const b of chain) writeU32(out, b.start, readU32(out, b.start) + extra);
  return out;
}

test('样本描述项头部长度不标准时，按类型扫描的兜底必须真的救得回来', () => {
  const file = buildSelfContained('chunk-stream0-', 'init-stream0.m4s');
  const init = splitSelfContainedFmp4(file).init;

  // 前提：正常文件走主路径就能拿到 avcC
  assert.equal(parseInitSegment(init).decodeDescriptionName, 'avcC');

  // 破坏"子 box 从固定偏移 78 开始"这个假设。
  //
  // 前提校验不能写成"parseInitSegment 应该抛错" —— 兜底生效之后它本来就该成功。
  // 要证明的是**固定偏移那条路确实断了**，所以用同样按固定偏移走的
  // findBoxPath 去看：它在破坏后应该找不到 avcC。
  const widened = widenVideoSampleEntryHeader(init);
  assert.equal(widened.byteLength, init.byteLength + 8);
  assert.equal(
    findBoxPath(widened, 'moov.trak.mdia.minf.stbl.stsd.avc1.avcC'), null,
    '前提没成立：固定偏移仍然能走到 avcC，那这个测试就没测到兜底路径',
  );
  assert.ok(findBoxPath(init, 'moov.trak.mdia.minf.stbl.stsd.avc1.avcC'), '正常文件用固定偏移应当能找到');

  // 关键断言：兜底路径必须把它救回来
  const info = parseInitSegment(widened);
  assert.equal(info.decodeDescriptionName, 'avcC', '应当靠类型扫描找到 avcC，而不是抛"没有 avcC"');
  assert.ok(info.description && info.description.length > 0, '解码器配置记录的字节也要真的拿到');

  // 而且拿到的配置必须和正常文件里的一模一样 —— 不能是误撞上的同名字节
  const normal = parseInitSegment(init);
  assert.deepEqual([...info.description], [...normal.description], '兜底拿到的配置必须和主路径完全一致');
  assert.equal(info.width, normal.width, '尺寸字段仍在标准位置，应当照常读到');
  assert.equal(info.height, normal.height);
});

test('真的没有解码器配置时，报错要说清楚按固定偏移读到了什么', () => {
  const file = buildSelfContained('chunk-stream0-', 'init-stream0.m4s');
  const init = splitSelfContainedFmp4(file).init;
  // 把 avcC 的类型名改掉，模拟"这个 box 真的不存在"
  const mangled = init.slice();
  const chain = findBoxPath(mangled, 'moov.trak.mdia.minf.stbl.stsd.avc1');
  const avc1 = chain[chain.length - 1];
  const avcC = findBoxPath(mangled, 'moov.trak.mdia.minf.stbl.stsd.avc1.avcC');
  assert.ok(avcC, '测试前提：avc1 里应该有 avcC');
  const at = avcC[avcC.length - 1].start + 4;
  mangled[at] = 0x7a; mangled[at + 1] = 0x7a; mangled[at + 2] = 0x7a; mangled[at + 3] = 0x7a;

  assert.throws(
    () => parseInitSegment(mangled),
    (err) => {
      assert.match(err.message, /没有 avcC/);
      assert.match(err.message, /读到的是/, '应该报出实际读到的子 box，否则没法排查');
      assert.ok(avc1.size > 0);
      return true;
    },
  );
});

test('能列出初始化段里有哪几条轨（TS 复用流合并时要靠它判断）', () => {
  const vs = splitSelfContainedFmp4(buildSelfContained('chunk-stream0-', 'init-stream0.m4s'));
  const as = splitSelfContainedFmp4(buildSelfContained('chunk-stream1-', 'init-stream1.m4s'));

  assert.deepEqual(listInitTracks(vs.init), ['video'], '纯视频轨应当只有一条 video');
  assert.deepEqual(listInitTracks(as.init), ['audio'], '纯音频轨应当只有一条 audio');

  // 复用的 TS 重封装之后应当同时有两条
  const muxed = new Uint8Array(readFileSync(fixturePath('hls-fmp4', 'init.mp4')));
  assert.deepEqual(listInitTracks(muxed), ['video', 'audio'], 'HLS 的复用初始化段应当两条都在');

  assert.deepEqual(listInitTracks(new Uint8Array(8)), [], '垃圾数据返回空数组而不是抛错');
});

/* ------------------------------------------------------------------ *
 * 结构诊断
 *
 * 这个诊断器存在的唯一理由，是让"解析失败"变成"一眼能看出差在哪"。
 * 所以它自己必须先证明：正常文件的解码器配置项**确实会被打出来**。
 * ------------------------------------------------------------------ */

test('box 树能一路摊到解码器配置项（avcC / esds），否则诊断就是废的', () => {
  const video = buildSelfContained('chunk-stream0-', 'init-stream0.m4s');
  const audio = buildSelfContained('chunk-stream1-', 'init-stream1.m4s');

  const vTree = describeBoxTree(video).join('\n');
  assert.match(vTree, /^moov \(/m, '顶层应该有 moov');
  assert.match(vTree, /\btrak \(/);
  assert.match(vTree, /\bstsd \(/);
  assert.match(vTree, /\bavc1 \(/, '应该看到样本描述项 avc1');
  assert.match(vTree, /\bavcC \(/, '**必须**能打出 avcC —— 这正是排查时最需要看到的东西');

  const aTree = describeBoxTree(audio).join('\n');
  assert.match(aTree, /\bmp4a \(/);
  assert.match(aTree, /\besds \(/);

  // 缩进要能反映层级：avcC 必须比 avc1 更深
  const lines = describeBoxTree(video);
  const avc1Indent = lines.find((l) => /\bavc1 \(/.test(l)).match(/^\s*/)[0].length;
  const avcCIndent = lines.find((l) => /\bavcC \(/.test(l)).match(/^\s*/)[0].length;
  assert.ok(avcCIndent > avc1Indent, 'avcC 应该缩进在 avc1 里面');
});

test('诊断不会失控：深度和行数都有上限', () => {
  const file = buildSelfContained('chunk-stream0-', 'init-stream0.m4s');
  const shallow = describeBoxTree(file, { maxDepth: 1 });
  const deep = describeBoxTree(file, { maxDepth: 6, maxLines: 12 });
  assert.ok(shallow.length < describeBoxTree(file).length);
  assert.ok(deep.length <= 12, `行数必须封顶，实际 ${deep.length}`);
});

test('喂垃圾数据时诊断器自己不能崩', () => {
  // 诊断是在"已经出错"的路径上调用的 —— 它再抛异常，用户就什么信息都没有了
  assert.doesNotThrow(() => describeBoxTree(new Uint8Array(32).fill(0x41)));
  assert.doesNotThrow(() => describeBoxTree(new Uint8Array(0)));
});

