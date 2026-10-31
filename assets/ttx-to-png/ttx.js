/**
 * Aerofly FS TTX parse + pixel decode (browser/Node ESM).
 * DXT1 is pure JS; ETC2 uses texture2ddecoder WASM.
 */

import { decodeEtc2Rgb, decodeEtc2Rgba, decodeBc3, decodeAstc, decodeBc5 } from "./gpu_decode.js";

const MAGIC_COMPRESSED = [0xb5, 0xfe, 0x24, 0xc7, 0xb7, 0x3c, 0xeb, 0xb7];
const MAGIC_PLAIN = [0xa6, 0x97, 0xe9, 0xac, 0xf9, 0xfc, 0xc1, 0x7c];

function u32(dv, off) {
  return dv.getUint32(off, true);
}
function u64(dv, off) {
  const lo = dv.getUint32(off, true);
  const hi = dv.getUint32(off + 4, true);
  if (hi !== 0) return hi * 0x100000000 + lo;
  return lo;
}

function magicEq(bytes, magic) {
  for (let i = 0; i < 8; i++) if (bytes[i] !== magic[i]) return false;
  return true;
}

export function isFileCompressed(data) {
  return magicEq(data, MAGIC_COMPRESSED);
}

export function isPlainTexture(data) {
  return magicEq(data, MAGIC_PLAIN);
}

function parseStringProp(payload) {
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (payload.length < 8) return null;
  const n = Number(u64(dv, 0));
  if (n <= 0 || n > 64 || 8 + n > payload.length) return null;
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(payload[8 + i]);
  return s;
}

function* walkProps(data, start = 0x40) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = start;
  while (off + 32 <= data.length) {
    const size = u64(dv, off + 16);
    const hs = u64(dv, off + 24);
    if (size > 200) {
      yield { payload: data.subarray(off + 32, off + size) };
      return;
    }
    const step = size === 36 && hs === 40 ? 40 : size;
    if (step < 32) throw new Error(`bad chunk step at 0x${off.toString(16)}`);
    yield { payload: data.subarray(off + 32, off + step) };
    off += step;
  }
}

function skipContainers(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = 0;
  while (off + 32 <= data.length) {
    const size = u64(dv, off + 16);
    const hs = u64(dv, off + 24);
    if (hs === 32 && (size === data.length - off || size === data.length)) {
      off += 32;
      continue;
    }
    break;
  }
  return off;
}

/** Parse uncompressed / already-inflated texture blob. */
export function parseTexture(data) {
  const off = skipContainers(data);
  let fmt = null;
  let target = null;
  let width = null;
  let height = null;
  let layers = null;
  let mips = null;
  let pixels = null;

  for (const { payload } of walkProps(data, off)) {
    if (payload.length >= 16) {
      const s = parseStringProp(payload);
      if (s) {
        if (s.startsWith("type_")) {
          fmt = s;
          continue;
        }
        if (s.startsWith("target_")) {
          target = s;
          continue;
        }
      }
    }
    if (payload.length >= 4 && payload.length <= 8) {
      const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const val = u32(dv, 0);
      if (width === null) width = val;
      else if (height === null) height = val;
      else if (layers === null) layers = val;
      else if (mips === null) mips = val;
      continue;
    }
    pixels = payload;
    break;
  }

  if (!fmt || width == null || height == null || !pixels) {
    throw new Error(
      `incomplete texture: fmt=${fmt} ${width}x${height} pix=${pixels ? pixels.length : null}`
    );
  }
  return {
    format: fmt,
    target,
    width,
    height,
    layers: layers || 1,
    mips: mips || 1,
    pixels,
  };
}

function decodeRgb565(c) {
  return [
    ((((c >> 11) & 0x1f) * 255) / 31) | 0,
    ((((c >> 5) & 0x3f) * 255) / 63) | 0,
    (((c & 0x1f) * 255) / 31) | 0,
  ];
}

/** BC2 / DXT3: explicit 4-bit alpha + 4-color RGB block. */
export function decodeDxt3(data, w, h) {
  const out = new Uint8Array(w * h * 4);
  let off = 0;
  const bw = (w + 3) >> 2;
  const bh = (h + 3) >> 2;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const block = data.subarray(off, off + 16);
      off += 16;
      if (block.length < 16) break;
      const alphas = new Uint8Array(16);
      for (let i = 0; i < 16; i++) {
        const byte = block[i >> 1];
        const a = (i & 1) === 0 ? byte & 0xf : byte >> 4;
        alphas[i] = a * 17;
      }
      const c0 = block[8] | (block[9] << 8);
      const c1 = block[10] | (block[11] << 8);
      const bits = block[12] | (block[13] << 8) | (block[14] << 16) | (block[15] << 24);
      const colors = [decodeRgb565(c0), decodeRgb565(c1)];
      colors.push([
        ((2 * colors[0][0] + colors[1][0]) / 3) | 0,
        ((2 * colors[0][1] + colors[1][1]) / 3) | 0,
        ((2 * colors[0][2] + colors[1][2]) / 3) | 0,
      ]);
      colors.push([
        ((colors[0][0] + 2 * colors[1][0]) / 3) | 0,
        ((colors[0][1] + 2 * colors[1][1]) / 3) | 0,
        ((colors[0][2] + 2 * colors[1][2]) / 3) | 0,
      ]);
      for (let i = 0; i < 16; i++) {
        const x = bx * 4 + (i & 3);
        const y = by * 4 + (i >> 2);
        if (x >= w || y >= h) continue;
        const idx = (bits >> (2 * i)) & 3;
        const [r, g, b] = colors[idx];
        const dst = (y * w + x) * 4;
        out[dst] = r;
        out[dst + 1] = g;
        out[dst + 2] = b;
        out[dst + 3] = alphas[i];
      }
    }
  }
  return out;
}

function decodeDxt1Block(block, blockPix) {
  const c0 = block[0] | (block[1] << 8);
  const c1 = block[2] | (block[3] << 8);
  const bits = block[4] | (block[5] << 8) | (block[6] << 16) | (block[7] << 24);
  const colors = [decodeRgb565(c0), decodeRgb565(c1)];
  if (c0 > c1) {
    colors.push([
      ((2 * colors[0][0] + colors[1][0]) / 3) | 0,
      ((2 * colors[0][1] + colors[1][1]) / 3) | 0,
      ((2 * colors[0][2] + colors[1][2]) / 3) | 0,
    ]);
    colors.push([
      ((colors[0][0] + 2 * colors[1][0]) / 3) | 0,
      ((colors[0][1] + 2 * colors[1][1]) / 3) | 0,
      ((colors[0][2] + 2 * colors[1][2]) / 3) | 0,
    ]);
  } else {
    colors.push([
      ((colors[0][0] + colors[1][0]) / 2) | 0,
      ((colors[0][1] + colors[1][1]) / 2) | 0,
      ((colors[0][2] + colors[1][2]) / 2) | 0,
    ]);
    colors.push([0, 0, 0]);
  }
  for (let i = 0; i < 16; i++) {
    const idx = (bits >> (2 * i)) & 3;
    const [r, g, b] = colors[idx];
    const o = i * 4;
    blockPix[o] = r;
    blockPix[o + 1] = g;
    blockPix[o + 2] = b;
    blockPix[o + 3] = 255;
  }
}

export function decodeDxt1(data, w, h) {
  const out = new Uint8Array(w * h * 4);
  const blockPix = new Uint8Array(64);
  let off = 0;
  const bw = (w + 3) >> 2;
  const bh = (h + 3) >> 2;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const block = data.subarray(off, off + 8);
      off += 8;
      if (block.length < 8) break;
      decodeDxt1Block(block, blockPix);
      for (let i = 0; i < 16; i++) {
        const x = bx * 4 + (i & 3);
        const y = by * 4 + (i >> 2);
        if (x >= w || y >= h) continue;
        const dst = (y * w + x) * 4;
        const src = i * 4;
        out[dst] = blockPix[src];
        out[dst + 1] = blockPix[src + 1];
        out[dst + 2] = blockPix[src + 2];
        out[dst + 3] = 255;
      }
    }
  }
  return out;
}

export function decodeRgba(data, w, h) {
  return data.subarray(0, w * h * 4);
}

export function flipVertical(rgba, w, h) {
  const out = new Uint8Array(rgba.length);
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    out.set(rgba.subarray(y * row, y * row + row), (h - 1 - y) * row);
  }
  return out;
}

export function decodeR8(data, w, h) {
  const need = w * h;
  const out = new Uint8Array(need * 4);
  for (let i = 0; i < need; i++) {
    const v = data[i];
    const o = i * 4;
    out[o] = out[o + 1] = out[o + 2] = v;
    out[o + 3] = 255;
  }
  return out;
}

function parseAstcBlockSize(fmt) {
  const m = /^type_rgba?_astc_(\d+)x(\d+)$/.exec(fmt);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/** Decode parsed texture to RGBA8 Uint8Array. */
export async function texToRgba(info) {
  const { format, width: w, height: h, pixels } = info;
  if (format === "type_rgba") return decodeRgba(pixels, w, h);
  if (format === "type_r") return decodeR8(pixels, w, h);
  if (format === "type_rg_rgtc2") return decodeBc5(pixels, w, h);
  if (format === "type_rgb_s3tc_dxt1" || format === "type_rgba_s3tc_dxt1")
    return decodeDxt1(pixels, w, h);
  if (format === "type_rgba_s3tc_dxt5") return decodeBc3(pixels, w, h);
  if (format === "type_rgba_s3tc_dxt3") return decodeDxt3(pixels, w, h);
  if (format === "type_rgb_etc2" || format === "type_rgb_etc1")
    return decodeEtc2Rgb(pixels, w, h);
  if (format === "type_rgba_etc2") return decodeEtc2Rgba(pixels, w, h);
  const astc = parseAstcBlockSize(format);
  if (astc) return decodeAstc(pixels, w, h, astc[0], astc[1]);
  throw new Error(`unsupported format: ${format}`);
}
