#!/usr/bin/env node
/**
 * Video Hunter 图标生成器 —— 纯 Node，零第三方依赖。
 *
 * 手写 PNG 编码（IHDR/IDAT/IEND + CRC32），4 倍超采样做抗锯齿，
 * 画一个圆角方块 + 白色播放三角。
 *
 * 用法：node tools/make-icons.mjs
 * 输出：icons/icon-16.png / icon-32.png / icon-48.png / icon-128.png
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'icons');

/* ------------------------------------------------------------------ *
 * PNG 编码
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** @param {Buffer} rgba 长度必须是 width*height*4（非预乘） */
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * 光栅化
 * ------------------------------------------------------------------ */

const SS = 4; // 超采样倍数

const GRAD_FROM = [0x4f, 0x6b, 0xff]; // #4F6BFF
const GRAD_TO = [0x8b, 0x2f, 0xe8];   // #8B2FE8

function lerp(a, b, t) { return a + (b - a) * t; }

/** 点是否落在圆角方块内 */
function inRoundRect(x, y, size, r) {
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  if (x >= r && x <= size - r) return y >= 0 && y <= size;
  if (y >= r && y <= size - r) return x >= 0 && x <= size;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 重心坐标法判断点是否在三角形内 */
function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function renderIcon(size) {
  const W = size * SS;
  const rgb = new Float32Array(W * W * 3);
  const cov = new Float32Array(W * W);

  const radius = W * 0.235;
  const cx = W * 0.5;
  const cy = W * 0.5;

  // 播放三角：以视觉重心为中心，稍微右移补偿三角形的视觉偏左
  const triH = W * 0.46;
  const triW = W * 0.40;
  const ax = cx - triW * 0.42;
  const ay = cy - triH / 2;
  const bx = cx - triW * 0.42;
  const by = cy + triH / 2;
  const tx = cx + triW * 0.66;
  const ty = cy;

  for (let y = 0; y < W; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (!inRoundRect(x + 0.5, y + 0.5, W, radius)) continue;
      const i = y * W + x;
      const t = (x + y) / (2 * (W - 1));
      let r = lerp(GRAD_FROM[0], GRAD_TO[0], t);
      let g = lerp(GRAD_FROM[1], GRAD_TO[1], t);
      let b = lerp(GRAD_FROM[2], GRAD_TO[2], t);
      if (inTriangle(x + 0.5, y + 0.5, ax, ay, bx, by, tx, ty)) {
        r = 255; g = 255; b = 255;
      }
      rgb[i * 3] = r;
      rgb[i * 3 + 1] = g;
      rgb[i * 3 + 2] = b;
      cov[i] = 1;
    }
  }

  // 降采样
  const out = Buffer.alloc(size * size * 4);
  for (let oy = 0; oy < size; oy += 1) {
    for (let ox = 0; ox < size; ox += 1) {
      let aSum = 0, rSum = 0, gSum = 0, bSum = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = (oy * SS + sy) * W + (ox * SS + sx);
          const a = cov[i];
          aSum += a;
          rSum += rgb[i * 3] * a;
          gSum += rgb[i * 3 + 1] * a;
          bSum += rgb[i * 3 + 2] * a;
        }
      }
      const n = SS * SS;
      const alpha = aSum / n;
      const o = (oy * size + ox) * 4;
      if (alpha <= 0) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      } else {
        out[o] = Math.round(rSum / aSum);
        out[o + 1] = Math.round(gSum / aSum);
        out[o + 2] = Math.round(bSum / aSum);
        out[o + 3] = Math.round(alpha * 255);
      }
    }
  }
  return encodePNG(size, size, out);
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const SIZES = [16, 32, 48, 128];

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = renderIcon(size);
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file}  (${png.length} bytes, ${size}x${size})`);
}
