/**
 * MPD / DASH 解析 —— 纯函数，不碰 DOM、不碰 chrome.*、不碰网络。
 *
 * 为什么自己写 XML 扫描器：Node 里没有 DOMParser，而 MPD 是播放器/打包器
 * **机器生成**的，结构规整得可以只用「元素 + 属性 + 自闭合」三个概念处理。
 * 为了这点需求去引一个 XML 依赖不值得（扩展体积、供应链、还有命名空间前缀
 * 这些我们用不上的东西）。扫描器只做四件事：跳过注释/CDATA/声明、
 * 拆标签名、拆属性、配对开闭标签。
 *
 * 和 HLS 那边一样，「DRM 必须被识别出来」是硬红线：本工具不做 DRM 绕过，
 * 但必须能在解析阶段就停下并说清楚是哪种 DRM，而不是让用户下完一堆
 * 加密分片再发现拼出来打不开。
 *
 * 另一个刻意的取舍：**SegmentTimeline 的时间轴只用来算 URL 和报时长，
 * 绝不当作合并时的时间基准**。ffmpeg 生成的 MPD 里 S@d 之和常常和分片内
 * 样本时长之和对不上（本仓库样本就差 1024 个 tick），真正的时间基准
 * 只能从 moof 里的 tfdt 读。
 */

import { resolveUrl, formatBitrate } from './hls.js';

/* ------------------------------------------------------------------ *
 * XML 扫描器
 * ------------------------------------------------------------------ */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : all;
  });
}

/** 去掉命名空间前缀：`cenc:default_KID` → `default_KID`。MPD 里前缀五花八门，语义只看后半截。 */
function localName(name) {
  const s = String(name);
  const colon = s.indexOf(':');
  return colon < 0 ? s : s.slice(colon + 1);
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function parseAttrs(source) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(source)) !== null) {
    const key = localName(m[1]);
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    // 同名前缀属性后来的不覆盖先来的：MPD 里重复属性本身就是畸形数据，
    // 保留第一个更接近「打包器想要的那个」。
    if (!(key in attrs)) attrs[key] = decodeEntities(value);
  }
  return attrs;
}

/**
 * 把 XML 文本扫成 `{ name, attrs, children, text }` 树。
 * 失败返回 `{ error }`（中文），成功返回 `{ root }`。
 */
export function parseXmlLite(xmlText) {
  const src = String(xmlText ?? '');
  if (!src.trim()) return { error: 'MPD 内容为空' };

  const n = src.length;
  const stack = [];
  let root = null;
  let i = 0;
  let textStart = 0;

  const flushText = (upto) => {
    if (!stack.length || upto <= textStart) return;
    const chunk = src.slice(textStart, upto);
    if (chunk) stack[stack.length - 1].text += decodeEntities(chunk);
  };

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    flushText(lt);
    i = lt;

    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      textStart = i;
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      const body = end < 0 ? src.slice(i + 9) : src.slice(i + 9, end);
      if (stack.length) stack[stack.length - 1].text += body;
      i = end < 0 ? n : end + 3;
      textStart = i;
      continue;
    }
    if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2);
      i = end < 0 ? n : end + 2;
      textStart = i;
      continue;
    }
    if (src.startsWith('<!', i)) {
      const end = src.indexOf('>', i + 2);
      i = end < 0 ? n : end + 1;
      textStart = i;
      continue;
    }

    // 找这个标签的收尾 '>'，属性值里的 '>' 不算（SPS/PPS 之类的 base64 里很常见）
    let j = i + 1;
    let quote = '';
    while (j < n) {
      const c = src[j];
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j += 1;
    }
    if (j >= n) return { error: 'XML 标签缺少收尾的 ">"，文件可能被截断' };

    const raw = src.slice(i + 1, j);
    i = j + 1;
    textStart = i;

    if (raw.startsWith('/')) {
      const name = localName(raw.slice(1).trim());
      const node = stack.pop();
      if (!node || node.name !== name) {
        return { error: `XML 标签不匹配：遇到 </${name}>，但当前打开的是 <${node ? node.name : '无'}>` };
      }
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const eq = body.search(/[\s/>]/);
    const tagName = localName(eq < 0 ? body : body.slice(0, eq));
    if (!tagName) return { error: 'XML 标签名为空' };

    const node = {
      name: tagName,
      attrs: parseAttrs(eq < 0 ? '' : body.slice(eq)),
      children: [],
      text: '',
    };

    if (!stack.length) {
      if (root) return { error: 'XML 有多个根元素，不是合法 MPD' };
      root = node;
    } else {
      stack[stack.length - 1].children.push(node);
    }
    if (!selfClosing) stack.push(node);
  }

  if (stack.length) return { error: `XML 标签没有闭合：<${stack[stack.length - 1].name}>` };
  if (!root) return { error: '这段内容里没有任何 XML 元素（拿到的可能不是 MPD）' };
  return { root };
}

function childrenOf(node, name) {
  const list = node?.children || [];
  return name ? list.filter((c) => c.name === name) : list;
}

function childOf(node, name) {
  return (node?.children || []).find((c) => c.name === name) || null;
}

function childText(node, name) {
  return childOf(node, name)?.text.trim() || '';
}

/* ------------------------------------------------------------------ *
 * 时长 / 模板
 * ------------------------------------------------------------------ */

/**
 * ISO 8601 时长 → 秒。`PT12.0S` / `PT1M30S` / `P1DT2H3M4.5S` / `PT0S`。
 * 年月按 30/365 天近似 —— DASH 的 live 窗口用不到它们，给个数量级就够。
 */
export function parseIsoDuration(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const m = /^([+-])?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(s);
  if (!m) return null;
  const num = (v) => (v === undefined ? 0 : Number.parseFloat(v));
  const seconds = num(m[2]) * 365 * 86400
    + num(m[3]) * 30 * 86400
    + num(m[4]) * 7 * 86400
    + num(m[5]) * 86400
    + num(m[6]) * 3600
    + num(m[7]) * 60
    + num(m[8]);
  return m[1] === '-' ? -seconds : seconds;
}

/**
 * 展开 SegmentTemplate：`$RepresentationID$` `$Number$` `$Bandwidth$` `$Time$`，
 * 支持 `$Number%05d$` 这种零填充写法。
 */
export function expandTemplate(template, vars) {
  return String(template ?? '').replace(/\$(\w+)(?:%0(\d+)d)?\$/g, (all, name, width) => {
    if (!(name in vars)) return all;
    const text = String(vars[name]);
    return width ? text.padStart(Number(width), '0') : text;
  });
}

/* ------------------------------------------------------------------ *
 * DRM
 * ------------------------------------------------------------------ */

/**
 * schemeIdUri → DRM 系统名。名单只覆盖现实里会遇到的，认不出来的
 * 也照样算 DRM（`未知`），因为「看不懂的 ContentProtection」正是最该停下的情况。
 */
export const DRM_SCHEMES = [
  { match: 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', system: 'Widevine' },
  { match: 'widevine', system: 'Widevine' },
  { match: 'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95', system: 'PlayReady' },
  { match: 'com.microsoft.playready', system: 'PlayReady' },
  { match: 'urn:uuid:5e629af5-38da-4063-8977-97ffbd9902d4', system: 'Marlin' },
  { match: 'urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2', system: 'FairPlay' },
  { match: 'com.apple.streamingkeydelivery', system: 'FairPlay' },
  { match: 'com.apple.fps', system: 'FairPlay' },
  { match: 'urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b', system: 'ClearKey' },
  { match: 'urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e', system: 'ClearKey' },
  { match: 'urn:uuid:6dd8b3c3-45f4-4a68-bf3a-64168d01c719', system: 'Irdeto' },
  { match: 'urn:uuid:279fe473-512c-48fe-ade8-d176fee6b40f', system: 'Adobe Primetime' },
  { match: 'urn:mpeg:dash:mp4protection', system: 'cenc（通用加密，未指明 DRM 系统）' },
];

/** 判断一个 schemeIdUri 属于哪种 DRM；不是 DRM 返回 null。 */
export function classifyContentProtection(schemeIdUri) {
  const uri = String(schemeIdUri ?? '').trim();
  if (!uri) return null;
  const lower = uri.toLowerCase();
  for (const entry of DRM_SCHEMES) {
    if (lower.includes(entry.match)) return entry.system;
  }
  return null;
}

/** 收集一棵子树里所有 ContentProtection（含嵌套层），合成 drm 对象；没有就返回 null。 */
function collectDrm(nodes) {
  const protections = [];
  const systems = new Set();
  let defaultKid = '';
  let hasPssh = false;

  const visit = (node) => {
    if (node.name === 'ContentProtection') {
      const schemeIdUri = node.attrs.schemeIdUri || '';
      const system = classifyContentProtection(schemeIdUri);
      const kid = node.attrs.default_KID || '';
      const pssh = childText(node, 'pssh');
      if (kid && !defaultKid) defaultKid = kid;
      if (pssh) hasPssh = true;
      // cenc:default_KID 存在本身就说明这条轨是加密的，哪怕 schemeIdUri 认不出来
      const encrypted = Boolean(schemeIdUri) || Boolean(kid);
      if (encrypted) {
        if (system) systems.add(system);
        protections.push({ schemeIdUri, system, defaultKID: kid, value: node.attrs.value || '', pssh: pssh || '' });
      }
    }
    for (const child of node.children || []) visit(child);
  };
  for (const node of nodes) visit(node);

  if (!protections.length) return null;
  // 有 ContentProtection 但认不出是哪家（或只有 KID、没有 schemeIdUri）时也要说清楚，
  // 不能让「未知」看起来像「没加密」
  if (!systems.size) systems.add('未知 ContentProtection（schemeIdUri 无法识别）');
  return {
    detected: true,
    systems: [...systems],
    defaultKID: defaultKid,
    hasPssh,
    protection: protections,
  };
}

/** 给 UI 的一句话。 */
export function describeDrm(drm) {
  if (!drm) return '';
  return `DRM：${drm.systems.join(' / ')}${drm.defaultKID ? `（KID ${drm.defaultKID}）` : ''}`;
}

/* ------------------------------------------------------------------ *
 * 分段信息
 * ------------------------------------------------------------------ */

function parseSegmentTimeline(node) {
  const out = [];
  for (const s of childrenOf(node, 'S')) {
    const d = Number.parseInt(s.attrs.d, 10);
    if (!Number.isFinite(d) || d <= 0) continue;
    const repeat = s.attrs.r === undefined ? 0 : Number.parseInt(s.attrs.r, 10);
    const t = s.attrs.t === undefined ? null : Number.parseInt(s.attrs.t, 10);
    // r="-1" 表示「重复到 Period 结束」，静态 MPD 里几乎不出现，先按 0 处理并留给上层出警告
    const count = Number.isFinite(repeat) && repeat > 0 ? repeat + 1 : 1;
    out.push({ t: Number.isFinite(t) ? t : null, d, count, openEnded: repeat === -1 });
  }
  return out;
}

function expandTimeline(entries) {
  const segs = [];
  let time = 0;
  let openEnded = false;
  for (const entry of entries) {
    if (entry.t !== null) time = entry.t;
    for (let k = 0; k < entry.count; k += 1) {
      segs.push({ time, duration: entry.d });
      time += entry.d;
    }
    if (entry.openEnded) openEnded = true;
  }
  return { segs, openEnded };
}

/**
 * 把 SegmentTemplate / SegmentList / SegmentBase 展开成「初始化段 URL + 分片 URL 数组」。
 * 拿不到分片列表时**不抛异常**，而是写进 warnings —— 因为一个 AdaptationSet
 * 解不出来不代表整个 MPD 没用（比如只关心视频轨的场景）。
 */
function buildSegments(node, base, ctx) {
  const warnings = [];
  const result = {
    source: '',
    timescale: 1,
    initUrl: '',
    segmentUrls: [],
    segmentDurations: [],
    segmentBase: false,
    totalDuration: null,
    warnings,
  };

  const template = childOf(node, 'SegmentTemplate');
  const list = childOf(node, 'SegmentList');
  const baseSeg = childOf(node, 'SegmentBase');

  if (template) {
    result.source = 'SegmentTemplate';
    const timescale = Number.parseInt(template.attrs.timescale, 10);
    result.timescale = Number.isFinite(timescale) && timescale > 0 ? timescale : 1;

    const startNumber = Number.parseInt(template.attrs.startNumber, 10);
    const first = Number.isFinite(startNumber) && startNumber > 0 ? startNumber : 1;
    const endNumber = Number.parseInt(template.attrs.endNumber, 10);

    const vars = { RepresentationID: ctx.id, Bandwidth: ctx.bandwidth };
    if (template.attrs.initialization) {
      result.initUrl = resolveUrl(expandTemplate(template.attrs.initialization, vars), base);
    }

    const timeline = childOf(template, 'SegmentTimeline');
    if (timeline) {
      const { segs, openEnded } = expandTimeline(parseSegmentTimeline(timeline));
      if (openEnded) warnings.push('SegmentTimeline 里有 r="-1"（开放结尾），只展开了已知部分');
      segs.forEach((seg, index) => {
        const number = first + index;
        result.segmentUrls.push(resolveUrl(expandTemplate(template.attrs.media || '', { ...vars, Number: number, Time: seg.time }), base));
        result.segmentDurations.push(seg.duration / result.timescale);
      });
    } else {
      const segTicks = Number.parseInt(template.attrs.duration, 10);
      const limit = Number.isFinite(endNumber) && endNumber >= first ? endNumber - first + 1 : Infinity;
      if (Number.isFinite(segTicks) && segTicks > 0 && ctx.periodDuration) {
        const count = Math.min(limit, Math.ceil((ctx.periodDuration * result.timescale) / segTicks - 1e-6));
        for (let index = 0; index < count; index += 1) {
          const number = first + index;
          result.segmentUrls.push(resolveUrl(expandTemplate(template.attrs.media || '', { ...vars, Number: number, Time: index * segTicks }), base));
          result.segmentDurations.push(segTicks / result.timescale);
        }
      } else {
        warnings.push(Number.isFinite(segTicks) && segTicks > 0
          ? 'SegmentTemplate 用 duration 枚举分片，但 Period 没有时长，数不出分片个数'
          : 'SegmentTemplate 既没有 SegmentTimeline 也没有 duration，拿不到分片列表');
      }
    }
    if (result.segmentUrls.length) {
      result.totalDuration = result.segmentDurations.reduce((a, b) => a + b, 0);
    }
  } else if (list) {
    result.source = 'SegmentList';
    const timescale = Number.parseInt(list.attrs.timescale, 10);
    result.timescale = Number.isFinite(timescale) && timescale > 0 ? timescale : 1;
    const init = childOf(list, 'Initialization');
    if (init?.attrs.sourceURL) result.initUrl = resolveUrl(init.attrs.sourceURL, base);
    for (const url of childrenOf(list, 'SegmentURL')) {
      if (url.attrs.media) {
        result.segmentUrls.push(resolveUrl(url.attrs.media, base));
      } else if (url.attrs.mediaRange) {
        warnings.push('SegmentList 里出现只有 mediaRange 的 SegmentURL（需要 HTTP Range 请求），已跳过该分片');
      }
    }
    const segmentTicks = Number.parseInt(list.attrs.duration, 10);
    if (Number.isFinite(segmentTicks) && segmentTicks > 0 && result.segmentUrls.length) {
      result.totalDuration = (segmentTicks / result.timescale) * result.segmentUrls.length;
      result.segmentDurations = result.segmentUrls.map(() => segmentTicks / result.timescale);
    }
  } else if (baseSeg || node.attrs.indexRange) {
    result.source = 'SegmentBase';
    result.segmentBase = true;
    const init = childOf(baseSeg || node, 'Initialization');
    result.initUrl = init?.attrs.sourceURL ? resolveUrl(init.attrs.sourceURL, base) : base;
    warnings.push('这是 SegmentBase（单文件 + Range 请求）的形态，需要按字节范围取数据，当前只给出了文件 URL');
  } else {
    result.source = '';
    warnings.push('Representation 上没有 SegmentTemplate / SegmentList / SegmentBase，拿不到分片 URL');
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * 主解析
 * ------------------------------------------------------------------ */

function resolveBaseUrl(base, node) {
  // BaseURL 可以是相对路径，也可能出现多个（按优先级）。这里只取第一个 ——
  // 多 BaseURL 是「同内容多镜像」，取哪个都行。
  const own = childText(node, 'BaseURL');
  return own ? resolveUrl(own, base) : base;
}

function guessContentType(rep, adaptation, mimeType) {
  const explicit = adaptation?.attrs?.contentType || rep.attrs.contentType || '';
  if (explicit === 'video' || explicit === 'audio' || explicit === 'text' || explicit === 'image') return explicit;
  const mime = String(mimeType || '');
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('text/')) return 'text';
  if (mime.startsWith('image/')) return 'image';
  // codecs 兜底：avc/hevc/av01/vp9 是视频，mp4a/ac-3/ec-3/opus 是音频
  const codecs = String(rep.attrs.codecs || adaptation?.attrs?.codecs || '').toLowerCase();
  if (/^(avc|hev|hvc|av01|vp0?9|dvh)/.test(codecs)) return 'video';
  if (/^(mp4a|ac-3|ec-3|opus|vorbis|flac|dts)/.test(codecs)) return 'audio';
  return 'unknown';
}

/**
 * 解析一段 MPD 文本。
 *
 * 成功：`{ ok: true, static, duration, adaptations, representations, drm, ... }`
 * 失败：`{ ok: false, error: '中文原因' }` —— 和 hls.js 的 parsePlaylist 保持同一套约定。
 *
 * @param {string} xmlText MPD 文本
 * @param {string} baseUrl MPD 自己的 URL，用来把相对路径变绝对
 */
export function parseMpd(xmlText, baseUrl = '') {
  const scanned = parseXmlLite(xmlText);
  if (scanned.error) return { ok: false, error: `MPD 解析失败：${scanned.error}` };

  const root = scanned.root;
  if (root.name !== 'MPD') {
    return { ok: false, error: `根元素是 <${root.name}> 而不是 <MPD>，拿到的可能是一个 HTML 错误页而不是 MPD` };
  }

  const type = String(root.attrs.type || 'static').toLowerCase();
  const isStatic = type === 'static';
  const mpdBase = resolveBaseUrl(String(baseUrl || ''), root);
  const mediaPresentationDuration = parseIsoDuration(root.attrs.mediaPresentationDuration);
  const periods = childrenOf(root, 'Period');

  if (!periods.length) return { ok: false, error: 'MPD 里没有 <Period>，没有可下载的内容' };

  const drmNodes = [...childrenOf(root, 'ContentProtection')];

  const adaptations = [];
  const representations = [];

  periods.forEach((period, periodIndex) => {
    const periodBase = resolveBaseUrl(mpdBase, period);
    const periodDuration = parseIsoDuration(period.attrs.duration) ?? mediaPresentationDuration;
    const periodCtx = {
      base: periodBase,
      segmentTemplate: childOf(period, 'SegmentTemplate') || null,
      drmNodes: [...drmNodes, ...childrenOf(period, 'ContentProtection')],
    };

    for (const adaptation of childrenOf(period, 'AdaptationSet')) {
      const adaptBase = resolveBaseUrl(periodCtx.base, adaptation);
      const adaptDrmNodes = [...periodCtx.drmNodes, ...childrenOf(adaptation, 'ContentProtection')];
      const adaptTemplate = childOf(adaptation, 'SegmentTemplate') || periodCtx.segmentTemplate;

      const adaptEntry = {
        id: adaptation.attrs.id || String(adaptations.length),
        periodIndex,
        contentType: adaptation.attrs.contentType || '',
        mimeType: adaptation.attrs.mimeType || '',
        lang: adaptation.attrs.lang || '',
        maxWidth: Number.parseInt(adaptation.attrs.maxWidth, 10) || 0,
        maxHeight: Number.parseInt(adaptation.attrs.maxHeight, 10) || 0,
        representations: [],
      };

      for (const rep of childrenOf(adaptation, 'Representation')) {
        const repBase = resolveBaseUrl(adaptBase, rep);
        const repDrmNodes = [...adaptDrmNodes, ...childrenOf(rep, 'ContentProtection')];
        const mimeType = rep.attrs.mimeType || adaptation.attrs.mimeType || '';
        const contentType = guessContentType(rep, adaptation, mimeType);

        // SegmentTemplate 的三级继承：Representation → AdaptationSet → Period。
        // 继承来的那份要重新展开（$RepresentationID$ 等变量是每个 Representation 自己的），
        // 所以这里把「从上层继承来的节点」塞进一个临时对象，交给 buildSegments 统一处理。
        const repWithTemplate = childOf(rep, 'SegmentTemplate')
          ? rep
          : { ...rep, children: [...(rep.children || []), ...(adaptTemplate ? [adaptTemplate] : [])] };

        const segments = buildSegments(repWithTemplate, repBase, {
          id: rep.attrs.id || adaptEntry.id,
          bandwidth: Number.parseInt(rep.attrs.bandwidth, 10) || 0,
          periodDuration,
        });

        const width = Number.parseInt(rep.attrs.width, 10) || adaptEntry.maxWidth || 0;
        const height = Number.parseInt(rep.attrs.height, 10) || adaptEntry.maxHeight || 0;
        const channelConfig = childOf(rep, 'AudioChannelConfiguration') || childOf(adaptation, 'AudioChannelConfiguration');

        const entry = {
          id: rep.attrs.id || '',
          periodIndex,
          adaptationId: adaptEntry.id,
          contentType,
          mimeType,
          codecs: rep.attrs.codecs || adaptation.attrs.codecs || '',
          bandwidth: Number.parseInt(rep.attrs.bandwidth, 10) || 0,
          width,
          height,
          frameRate: rep.attrs.frameRate || adaptation.attrs.frameRate || '',
          sar: rep.attrs.sar || '',
          audioSamplingRate: Number.parseInt(rep.attrs.audioSamplingRate || adaptation.attrs.audioSamplingRate, 10) || 0,
          audioChannels: Number.parseInt(channelConfig?.attrs.value, 10) || 0,
          lang: adaptation.attrs.lang || '',
          baseUrl: repBase,
          timescale: segments.timescale,
          initUrl: segments.initUrl,
          segmentUrls: segments.segmentUrls,
          segmentDurations: segments.segmentDurations,
          segmentSource: segments.source,
          segmentBase: segments.segmentBase,
          duration: segments.totalDuration,
          drm: collectDrm(repDrmNodes),
          warnings: segments.warnings,
        };

        if (!entry.id) entry.warnings = [...entry.warnings, 'Representation 没有 id，$RepresentationID$ 无法展开'];
        if (!entry.initUrl && !entry.segmentBase) {
          entry.warnings = [...entry.warnings, '没有初始化段 URL（SegmentTemplate@initialization 缺失？）'];
        }
        if (contentType === 'unknown') {
          entry.warnings = [...entry.warnings, '分不清这条轨是视频还是音频（缺少 contentType / mimeType / codecs）'];
        }

        adaptEntry.representations.push(entry);
        representations.push(entry);
      }

      if (adaptEntry.representations.length) {
        if (!adaptEntry.contentType) adaptEntry.contentType = adaptEntry.representations[0].contentType;
        if (!adaptEntry.mimeType) adaptEntry.mimeType = adaptEntry.representations[0].mimeType;
      }
      adaptations.push(adaptEntry);
    }
  });

  if (!representations.length) return { ok: false, error: 'MPD 里没有解析出任何 <Representation>，没有可下载的轨道' };

  // 顶层的 drm 汇总：任何一条轨被加密，整个 MPD 就当作 DRM 处理。
  // 这是刻意的「宁可误报」——漏报的代价是用户白下一堆加密分片。
  const drm = representations.find((r) => r.drm)?.drm || collectDrm(drmNodes) || null;

  return {
    ok: true,
    // DASH 的 static ≈ HLS 的 ENDLIST：分片列表是完整的，可以一次下完
    static: isStatic,
    type: type || 'static',
    profiles: root.attrs.profiles || '',
    duration: mediaPresentationDuration,
    minBufferTime: parseIsoDuration(root.attrs.minBufferTime),
    availabilityStartTime: root.attrs.availabilityStartTime || '',
    minimumUpdatePeriod: parseIsoDuration(root.attrs.minimumUpdatePeriod),
    periods: periods.map((p, i) => ({
      id: p.attrs.id || String(i),
      duration: parseIsoDuration(p.attrs.duration),
      start: parseIsoDuration(p.attrs.start),
    })),
    adaptations,
    representations,
    drm,
  };
}

/* ------------------------------------------------------------------ *
 * 选轨
 * ------------------------------------------------------------------ */

function pickVideo(list, preferred) {
  const sorted = [...list].sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  if (!sorted.length) return null;
  if (preferred === 'auto' || preferred == null || preferred === '') return sorted[0];
  const cap = Number(preferred);
  if (!Number.isFinite(cap) || cap <= 0) return sorted[0];
  // 和 hls.js 的 selectVariant 同一个语义：取不超过上限的最高档；
  // 所有档都超过上限时退到最低档，而不是返回 null。
  const under = sorted.filter((r) => r.height > 0 && r.height <= cap);
  return under[0] || sorted[sorted.length - 1];
}

function pickAudio(list) {
  if (!list.length) return null;
  return [...list].sort((a, b) => (b.bandwidth - a.bandwidth)
    || (b.audioSamplingRate - a.audioSamplingRate)
    || (b.audioChannels - a.audioChannels))[0];
}

/**
 * 选一条视频 + 一条音频。
 * @param {object} parsed parseMpd 的返回值
 * @param {{preferredQuality?: string|number}} [options] 'auto' | 1080 | 720 | 480 …
 * @returns {{video: object|null, audio: object|null}}
 */
export function selectRepresentations(parsedMpd, options = {}) {
  const preferred = options.preferredQuality ?? options.preferred ?? 'auto';
  const all = (parsedMpd?.representations || []).filter((r) => r.segmentUrls.length || r.segmentBase);
  return {
    video: pickVideo(all.filter((r) => r.contentType === 'video'), preferred),
    audio: pickAudio(all.filter((r) => r.contentType === 'audio')),
  };
}

/** 给 UI 的一行描述，和 hls.js 的 describeVariant 说同一种语言。 */
export function describeRepresentation(rep) {
  if (!rep) return '未知轨道';
  const parts = [];
  if (rep.contentType === 'video') {
    parts.push(rep.height ? (rep.width && rep.width !== Math.round((rep.height * 16) / 9) ? `${rep.width}×${rep.height}` : `${rep.height}p`) : (rep.width ? `${rep.width}px` : '视频'));
  } else if (rep.contentType === 'audio') {
    parts.push(rep.audioChannels ? `${rep.audioChannels} 声道` : '音频');
    if (rep.audioSamplingRate) parts.push(`${rep.audioSamplingRate / 1000} kHz`);
  } else {
    parts.push(rep.contentType || '未知');
  }
  const br = formatBitrate(rep.bandwidth);
  if (br) parts.push(br);
  if (rep.codecs) parts.push(rep.codecs);
  return parts.join(' · ');
}

/** 和 hls.js 的 summarize 对应，给 UI 显示「这个 MPD 是什么」。 */
export function summarizeMpd(parsedMpd) {
  if (!parsedMpd || !parsedMpd.ok) return { text: '未知', tags: [] };
  const tags = [];
  tags.push(parsedMpd.static ? '点播（static）' : '直播（dynamic）');
  if (parsedMpd.drm) tags.push(`DRM: ${parsedMpd.drm.systems.join('/')}`);
  else tags.push('未加密');

  const video = parsedMpd.representations.filter((r) => r.contentType === 'video');
  const audio = parsedMpd.representations.filter((r) => r.contentType === 'audio');
  if (video.length && audio.length) tags.push('音视频分离（需要合并）');
  else if (video.length) tags.push('纯视频');
  else if (audio.length) tags.push('纯音频');

  const shape = [];
  if (video.length) shape.push(`${video.length} 档视频`);
  if (audio.length) shape.push(`${audio.length} 档音频`);

  const duration = parsedMpd.duration != null ? ` · 约 ${Math.round(parsedMpd.duration)} 秒` : '';
  return { text: `${shape.join(' / ') || '没有可下载轨道'}${duration}`, tags };
}
