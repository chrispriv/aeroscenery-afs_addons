/**
 * Thin wrapper around texture2ddecoder-wasm for ETC2 (and optional BC1).
 * Output is converted from BGRA → RGBA for canvas/PNG.
 */
import createModule from "./vendor/texture2ddecoder/texture2ddecoder.js";

let modPromise = null;

function load() {
  if (!modPromise) {
    const base = new URL("./vendor/texture2ddecoder/", import.meta.url).href;
    modPromise = createModule({
      locateFile: (path) => base + path,
    });
  }
  return modPromise;
}

function bgraToRgba(bgra) {
  const out = new Uint8Array(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    out[i] = bgra[i + 2];
    out[i + 1] = bgra[i + 1];
    out[i + 2] = bgra[i];
    out[i + 3] = bgra[i + 3];
  }
  return out;
}

function toU8(result) {
  if (!result) return null;
  if (result instanceof Uint8Array) return result;
  const n = result.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = result[i];
  return out;
}

export async function decodeEtc2Rgb(data, width, height) {
  const m = await load();
  const bgra = toU8(m.decode_etc2(data, width, height));
  if (!bgra) throw new Error("ETC2 decode failed");
  return bgraToRgba(bgra);
}

/** ETC2 RGB + EAC alpha (type_rgba_etc2): 16 bytes / 4×4. */
export async function decodeEtc2Rgba(data, width, height) {
  const m = await load();
  const bgra = toU8(m.decode_etc2a8(data, width, height));
  if (!bgra) throw new Error("ETC2+EAC decode failed");
  return bgraToRgba(bgra);
}

export async function decodeBc1(data, width, height) {
  const m = await load();
  const bgra = toU8(m.decode_bc1(data, width, height));
  if (!bgra) throw new Error("BC1/DXT1 decode failed");
  return bgraToRgba(bgra);
}

/** BC3 / DXT5 (type_rgba_s3tc_dxt5): interpolated alpha, 16 bytes / 4×4. */
export async function decodeBc3(data, width, height) {
  const m = await load();
  const bgra = toU8(m.decode_bc3(data, width, height));
  if (!bgra) throw new Error("BC3/DXT5 decode failed");
  return bgraToRgba(bgra);
}

/** ASTC block-compressed RGB/RGBA (e.g. type_rgb_astc_6x6). */
export async function decodeAstc(data, width, height, blockW, blockH) {
  const m = await load();
  const bgra = toU8(m.decode_astc(data, width, height, blockW, blockH));
  if (!bgra) throw new Error(`ASTC ${blockW}x${blockH} decode failed`);
  return bgraToRgba(bgra);
}

/** BC5 / RGTC2 (type_rg_rgtc2): RG channels; reconstruct Z for normal preview. */
export async function decodeBc5(data, width, height) {
  const m = await load();
  const bgra = toU8(m.decode_bc5(data, width, height));
  if (!bgra) throw new Error("BC5/RGTC2 decode failed");
  const rgba = bgraToRgba(bgra);
  for (let i = 0; i < rgba.length; i += 4) {
    const x = (rgba[i] / 255) * 2 - 1;
    const y = (rgba[i + 1] / 255) * 2 - 1;
    const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    rgba[i + 2] = Math.max(0, Math.min(255, Math.round(((z + 1) * 0.5) * 255)));
    rgba[i + 3] = 255;
  }
  return rgba;
}

export async function warmGpuDecoder() {
  await load();
}
