/**
 * M3U8 / HLS 播放列表解析 —— 纯函数，不碰 DOM、不碰 chrome.*、不碰网络。
 *
 * 这样做的唯一理由是**可测**：HLS 解析是这套工具里最容易出隐蔽错误的地方
 * （IV 算错、BYTERANGE 接错、把 DRM 当成普通加密），只有能拿真实播放列表
 * 在 Node 里跑断言，才敢说它是对的。浏览器侧只负责把文本喂进来。
 *
 * 覆盖的标签：
 *   #EXTM3U #EXT-X-VERSION #EXT-X-STREAM-INF #EXT-X-MEDIA #EXT-X-I-FRAME-STREAM-INF
 *   #EXTINF #EXT-X-BYTERANGE #EXT-X-KEY #EXT-X-MAP #EXT-X-MEDIA-SEQUENCE
 *   #EXT-X-DISCONTINUITY #EXT-X-DISCONTINUITY-SEQUENCE #EXT-X-TARGETDURATION
 *   #EXT-X-ENDLIST #EXT-X-PLAYLIST-TYPE #EXT-X-INDEPENDENT-SEGMENTS
 */

/* ------------------------------------------------------------------ *
 * 属性解析
 * ------------------------------------------------------------------ */

/**
 * 解析 `KEY=VALUE,KEY="quoted,value"` 形式的属性串。
 * 逗号既可能是属性分隔符也可能在引号里，所以不能简单 split(',')。
 */
export function parseAttributes(input) {
  const out = {};
  const s = String(input ?? '');
  const n = s.length;
  let i = 0;

  while (i < n) {
    while (i < n && (s[i] === ',' || s[i] === ' ' || s[i] === '\t')) i += 1;
    if (i >= n) break;

    let keyEnd = i;
    while (keyEnd < n && s[keyEnd] !== '=' && s[keyEnd] !== ',') keyEnd += 1;
    // 没有等号的残片（畸形标签）直接跳过
    if (keyEnd >= n || s[keyEnd] === ',') { i = keyEnd + 1; continue; }

    const key = s.slice(i, keyEnd).trim().toUpperCase();
    i = keyEnd + 1;

    let value = '';
    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      if (end < 0) { value = s.slice(i + 1); i = n; }
      else { value = s.slice(i + 1, end); i = end + 1; }
    } else {
      let end = i;
      while (end < n && s[end] !== ',') end += 1;
      value = s.slice(i, end).trim();
      i = end;
    }
    if (key) out[key] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * URL / 分辨率小工具
 * ------------------------------------------------------------------ */

export function resolveUrl(uri, baseUrl) {
  const raw = String(uri ?? '').trim();
  if (!raw) return '';
  try {
    return new URL(raw, baseUrl).href;
  } catch {
    return raw;
  }
}

/** 'RESOLUTION=1920x1080' → 1080；拿不到返回 0 */
export function variantHeight(variant) {
  const res = variant?.resolution || variant?.RESOLUTION || '';
  const m = /^\s*(\d+)\s*[xX]\s*(\d+)\s*$/.exec(String(res));
  return m ? Number(m[2]) : 0;
}

export function variantWidth(variant) {
  const res = variant?.resolution || variant?.RESOLUTION || '';
  const m = /^\s*(\d+)\s*[xX]\s*(\d+)\s*$/.exec(String(res));
  return m ? Number(m[1]) : 0;
}

export function formatBitrate(bps) {
  const n = Number(bps);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} Mbps`;
  return `${Math.round(n / 1000)} kbps`;
}

/** 给 UI 用的一行描述：`1080p · 5.0 Mbps · avc1.640028` */
export function describeVariant(variant) {
  const parts = [];
  const h = variantHeight(variant);
  const w = variantWidth(variant);
  if (h) parts.push(`${w && w !== Math.round(h * 16 / 9) ? `${w}×${h}` : `${h}p`}`);
  else if (w) parts.push(`${w}px`);
  const br = formatBitrate(variant.bandwidth);
  if (br) parts.push(br);
  if (variant.codecs) parts.push(variant.codecs);
  if (variant.audioGroup) parts.push(`音频组 ${variant.audioGroup}`);
  return parts.join(' · ') || '未知码率';
}

/* ------------------------------------------------------------------ *
 * DRM 识别
 * ------------------------------------------------------------------ */

/**
 * 判断一个 #EXT-X-KEY 是不是 DRM。
 *
 * 这是本工具最重要的一条红线：
 *   METHOD=AES-128 且 KEYFORMAT 缺省/identity → 普通加密，key 就在 URI 里，能解。
 *   其它 KEYFORMAT（FairPlay / Widevine / PlayReady）→ key 在 CDM 黑盒里，
 *   浏览器自己都不交给 JS，**没有任何办法**，我们直接停下并说清楚。
 */
export function describeKeyMethod(attrs) {
  const method = String(attrs?.METHOD || '').toUpperCase();
  const keyFormat = String(attrs?.KEYFORMAT || 'identity').toLowerCase();

  if (!method || method === 'NONE') return { kind: 'none', method, keyFormat };
  if (method === 'AES-128' && (keyFormat === 'identity' || keyFormat === '')) {
    return { kind: 'aes-128', method, keyFormat };
  }
  if (keyFormat.includes('fairplay') || keyFormat.includes('streamingkeydelivery')) {
    return { kind: 'drm', drm: 'FairPlay', method, keyFormat };
  }
  if (keyFormat.includes('edef8ba9') || keyFormat.includes('widevine')) {
    return { kind: 'drm', drm: 'Widevine', method, keyFormat };
  }
  if (keyFormat.includes('9a04f079') || keyFormat.includes('playready')) {
    return { kind: 'drm', drm: 'PlayReady', method, keyFormat };
  }
  // SAMPLE-AES 无论配什么 KEYFORMAT 都不是我们能碰的
  if (method.startsWith('SAMPLE-AES')) {
    return { kind: 'drm', drm: keyFormat === 'identity' ? 'SAMPLE-AES' : keyFormat, method, keyFormat };
  }
  return { kind: 'unknown', method, keyFormat };
}

/* ------------------------------------------------------------------ *
 * 主解析
 * ------------------------------------------------------------------ */

function emptyPlaylist() {
  return {
    ok: false,
    error: '',
    isMaster: false,
    isMedia: false,
    version: null,
    playlistType: '',
    variants: [],
    renditions: [],
    segments: [],
    targetDuration: null,
    mediaSequence: 0,
    discontinuitySequence: 0,
    endList: false,
    independentSegments: false,
    map: null,
    encryption: null,
    drm: null,
    totalDuration: 0,
  };
}

function parseByteRange(value, previousEnd) {
  const m = /^(\d+)(?:@(\d+))?$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const length = Number(m[1]);
  const offset = m[2] !== undefined ? Number(m[2]) : previousEnd;
  return { length, offset, end: offset + length - 1 };
}

/**
 * 解析一份 m3u8。
 * @param {string} text   播放列表原文
 * @param {string} baseUrl 播放列表自身的 URL（用来把相对路径变成绝对路径）
 */
export function parsePlaylist(text, baseUrl = '') {
  const result = emptyPlaylist();
  const raw = String(text ?? '');

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (!lines.length) {
    result.error = '播放列表是空的';
    return result;
  }
  if (!lines[0].startsWith('#EXTM3U')) {
    result.error = '不是合法的 M3U8：缺少 #EXTM3U 头';
    return result;
  }
  result.ok = true;

  const header = parseAttributes(lines[0].slice('#EXTM3U'.length).replace(/^:/, ''));
  if (header.VERSION) result.version = Number(header.VERSION);

  let pendingInf = null;
  let pendingByteRange = null;
  let pendingKey = null;
  let pendingMap = null;
  let pendingStreamInf = null;
  let pendingDiscontinuity = false;
  let lastByteRangeEnd = 0;

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith('#')) {
      const colon = line.indexOf(':');
      const tag = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1);

      switch (tag) {
        case '#EXT-X-STREAM-INF': {
          pendingStreamInf = parseAttributes(value);
          result.isMaster = true;
          break;
        }
        case '#EXT-X-MEDIA': {
          const a = parseAttributes(value);
          result.isMaster = true;
          result.renditions.push({
            type: (a.TYPE || '').toUpperCase(),
            groupId: a['GROUP-ID'] || '',
            name: a.NAME || '',
            language: a.LANGUAGE || '',
            isDefault: a.DEFAULT === 'YES',
            autoselect: a.AUTOSELECT === 'YES',
            uri: a.URI ? resolveUrl(a.URI, baseUrl) : '',
            channels: a.CHANNELS || '',
          });
          break;
        }
        case '#EXT-X-I-FRAME-STREAM-INF': {
          const a = parseAttributes(value);
          result.isMaster = true;
          if (a.URI) {
            result.variants.push({
              iframe: true,
              uri: resolveUrl(a.URI, baseUrl),
              bandwidth: Number(a.BANDWIDTH) || Number(a['AVERAGE-BANDWIDTH']) || 0,
              resolution: a.RESOLUTION || '',
              codecs: a.CODECS || '',
              audioGroup: a.AUDIO || '',
              frameRate: a['FRAME-RATE'] || '',
            });
          }
          break;
        }
        case '#EXTINF': {
          const comma = value.indexOf(',');
          const durText = comma < 0 ? value : value.slice(0, comma);
          pendingInf = {
            duration: Number.parseFloat(durText) || 0,
            title: comma < 0 ? '' : value.slice(comma + 1),
          };
          break;
        }
        case '#EXT-X-BYTERANGE':
          pendingByteRange = parseByteRange(value, lastByteRangeEnd);
          break;
        case '#EXT-X-DISCONTINUITY':
          pendingDiscontinuity = true;
          break;
        case '#EXT-X-KEY': {
          const a = parseAttributes(value);
          const desc = describeKeyMethod(a);
          if (desc.kind === 'none') {
            pendingKey = null;
          } else if (desc.kind === 'aes-128') {
            pendingKey = {
              method: 'AES-128',
              keyFormat: desc.keyFormat,
              uri: resolveUrl(a.URI, baseUrl),
              iv: a.IV || '',
            };
          } else {
            // DRM：记下来，并让上层有明确的东西可以展示给用户
            pendingKey = { method: desc.method, keyFormat: desc.keyFormat, drm: desc.drm || desc.keyFormat, uri: '', iv: '' };
            result.drm = { drm: desc.drm || desc.keyFormat, method: desc.method, keyFormat: desc.keyFormat };
          }
          result.encryption = pendingKey;
          break;
        }
        case '#EXT-X-MAP': {
          const a = parseAttributes(value);
          pendingMap = a.URI
            ? { uri: resolveUrl(a.URI, baseUrl), byteRange: parseByteRange(a.BYTERANGE, 0) }
            : null;
          result.map = pendingMap;
          break;
        }
        case '#EXT-X-TARGETDURATION':
          result.targetDuration = Number.parseFloat(value) || null;
          break;
        case '#EXT-X-MEDIA-SEQUENCE':
          result.mediaSequence = Number.parseInt(value, 10) || 0;
          break;
        case '#EXT-X-DISCONTINUITY-SEQUENCE':
          result.discontinuitySequence = Number.parseInt(value, 10) || 0;
          break;
        case '#EXT-X-PLAYLIST-TYPE':
          result.playlistType = value.trim().toUpperCase();
          break;
        case '#EXT-X-ENDLIST':
          result.endList = true;
          break;
        case '#EXT-X-INDEPENDENT-SEGMENTS':
          result.independentSegments = true;
          break;
        default:
          break;
      }
      continue;
    }

    // ---- 这一行是 URI ----

    if (pendingStreamInf) {
      const a = pendingStreamInf;
      pendingStreamInf = null;
      result.variants.push({
        iframe: false,
        uri: resolveUrl(line, baseUrl),
        bandwidth: Number(a.BANDWIDTH) || Number(a['AVERAGE-BANDWIDTH']) || 0,
        averageBandwidth: Number(a['AVERAGE-BANDWIDTH']) || 0,
        resolution: a.RESOLUTION || '',
        codecs: a.CODECS || '',
        audioGroup: a.AUDIO || '',
        videoGroup: a.VIDEO || '',
        frameRate: a['FRAME-RATE'] || '',
      });
      continue;
    }

    if (pendingInf) {
      const seq = result.mediaSequence + result.segments.length;
      const seg = {
        index: result.segments.length,
        seq,
        uri: resolveUrl(line, baseUrl),
        duration: pendingInf.duration,
        title: pendingInf.title,
        byteRange: pendingByteRange,
        discontinuity: pendingDiscontinuity,
        key: pendingKey,
        map: pendingMap,
      };
      result.segments.push(seg);
      result.totalDuration += pendingInf.duration;
      if (pendingByteRange) lastByteRangeEnd = pendingByteRange.end + 1;

      pendingInf = null;
      pendingByteRange = null;
      pendingDiscontinuity = false;
      continue;
    }

    // 既没有 STREAM-INF 也没有 EXTINF 的裸 URI —— 畸形列表，忽略
  }

  result.isMedia = !result.isMaster;
  if (!result.isMaster && !result.segments.length) {
    result.ok = false;
    result.error = result.endList
      ? '播放列表里没有任何分片'
      : '播放列表里没有分片（可能是还没开始的直播，或者需要重新拉取）';
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * 选码率
 * ------------------------------------------------------------------ */

/**
 * 从主列表里挑一个变体。
 * @param {Array} variants
 * @param {string|number} preferred 'auto' | '1080' | '720' | '480'
 */
export function selectVariant(variants, preferred = 'auto') {
  const list = (variants || []).filter((v) => !v.iframe && v.uri);
  if (!list.length) return null;

  const sorted = [...list].sort((a, b) => {
    const bw = (b.bandwidth || 0) - (a.bandwidth || 0);
    if (bw !== 0) return bw;
    return variantHeight(b) - variantHeight(a);
  });

  if (preferred === 'auto' || preferred == null || preferred === '') return sorted[0];

  const cap = Number(preferred);
  if (!Number.isFinite(cap) || cap <= 0) return sorted[0];

  // 挑「不超过上限的最高一档」；全都在上限之上时退而求其次挑最低的一档
  const under = sorted.filter((v) => {
    const h = variantHeight(v);
    return h > 0 && h <= cap;
  });
  return under[0] || sorted[sorted.length - 1];
}

/* ------------------------------------------------------------------ *
 * AES-128 的 IV
 * ------------------------------------------------------------------ */

/** 把 '0x…' 十六进制串转成字节；不合法返回 null */
export function hexToBytes(hex) {
  const s = String(hex ?? '').trim().replace(/^0x/i, '');
  if (!s || s.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(s)) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * 取某个分片该用的 IV。
 *
 * HLS 规范：显式 IV 优先；没写 IV 时，用**分片序号**的大端 16 字节表示。
 * 这里最常见的错误是拿「分片在数组里的下标」当序号 —— 直播流里
 * EXT-X-MEDIA-SEQUENCE 不为 0 时，这两个值不一样，差一点点就整片花屏。
 */
export function ivForSegment(segment, mediaSequence = 0) {
  const explicit = hexToBytes(segment?.key?.iv);
  if (explicit && explicit.length === 16) return explicit;

  const seq = Number.isFinite(segment?.seq)
    ? segment.seq
    : mediaSequence + (segment?.index ?? 0);

  const iv = new Uint8Array(16);
  // 序号可能超过 2^32，用 BigInt 保证高 8 字节也对
  let v = BigInt(Math.max(0, Math.trunc(seq)));
  for (let i = 15; i >= 0 && v > 0n; i -= 1) {
    iv[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return iv;
}

/* ------------------------------------------------------------------ *
 * 汇总信息（给 UI 显示「这个流是什么」）
 * ------------------------------------------------------------------ */

export function summarize(playlist) {
  if (!playlist) return { text: '未知', tags: [] };
  const tags = [];
  if (playlist.isMaster) tags.push('主播放列表');
  else tags.push('媒体播放列表');

  if (playlist.drm) tags.push(`DRM: ${playlist.drm.drm}`);
  else if (playlist.encryption?.method === 'AES-128') tags.push('AES-128 加密');
  else tags.push('未加密');

  if (playlist.map) tags.push('fMP4 分段');
  else if (playlist.segments.some((s) => /\.ts(\?|$)/i.test(s.uri))) tags.push('MPEG-TS 分片');

  if (!playlist.endList && !playlist.isMaster) tags.push('直播中');

  const text = playlist.isMaster
    ? `${playlist.variants.filter((v) => !v.iframe).length} 个码率可选`
    : `${playlist.segments.length} 个分片 · 约 ${Math.round(playlist.totalDuration)} 秒`;

  return { text, tags };
}
