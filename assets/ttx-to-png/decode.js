/**
 * Decode Aerofly TTX → PNG, TSB → WAV, TOC → text/JSON.
 */
import { inflateTtx, initTmCompress } from "./tm.js";
import { parseTexture, texToRgba, flipVertical, isFileCompressed } from "./ttx.js";
import { parseSound, pcmToWavBlob, isPlainSound } from "./tsb.js";
import {
  isPlainToc,
  parseToc,
  emitTocText,
  buildTocBinary,
  parseTocText,
  docFromJson,
  isTocText,
  isTocJson,
} from "./toc.js";
import { warmGpuDecoder } from "./gpu_decode.js";

export async function warmDecoders() {
  await Promise.all([initTmCompress(), warmGpuDecoder()]);
}

export {
  emitTocText,
  buildTocBinary,
  parseTocText,
  docFromJson,
  isTocText,
  isTocJson,
  isPlainToc,
};

/**
 * @param {Uint8Array} data
 * @param {{ flip?: boolean }} [opts]
 */
export async function decodeTtx(data, opts = {}) {
  const compressed = isFileCompressed(data);
  const inner = compressed ? await inflateTtx(data) : data;
  const info = parseTexture(inner);
  let rgba = await texToRgba(info);
  if (opts.flip) rgba = flipVertical(rgba, info.width, info.height);
  return {
    kind: "texture",
    width: info.width,
    height: info.height,
    format: info.format,
    rgba,
    compressed,
    mips: info.mips,
  };
}

function soundResult(inner, compressed) {
  const info = parseSound(inner);
  const wavBlob = pcmToWavBlob(info.pcm, info.sampleRate, info.channels, info.bits);
  const durationSec =
    info.pcm.length / (info.channels * (info.bits / 8) * info.sampleRate);
  return {
    kind: "sound",
    format: info.format,
    sampleRate: info.sampleRate,
    channels: info.channels,
    bits: info.bits,
    pcmBytes: info.pcm.length,
    durationSec,
    compressed,
    wavBlob,
  };
}

/**
 * @param {Uint8Array} data
 */
export async function decodeTsb(data) {
  const compressed = isFileCompressed(data);
  const inner = compressed ? await inflateTtx(data) : data;
  if (!(inner[0] === 0x5f && inner[1] === 0x34)) {
    throw new Error("not a TSB sound container after inflate");
  }
  return soundResult(inner, compressed);
}

function tocResult(inner, compressed) {
  const doc = parseToc(inner, compressed);
  let text = null;
  let textError = null;
  try {
    text = emitTocText(doc);
  } catch (e) {
    textError = e.message || String(e);
  }
  return {
    kind: "toc",
    doc,
    text,
    textError,
    compressed,
    placement_count: doc.placement_count,
  };
}

/**
 * Auto-detect texture / sound / toc from magic (after optional inflate).
 * @param {Uint8Array} data
 * @param {{ flip?: boolean }} [opts]
 */
export async function decodeAeroflyAsset(data, opts = {}) {
  if (isFileCompressed(data)) {
    const inner = await inflateTtx(data);
    if (inner[0] === 0x5f && inner[1] === 0x34) return soundResult(inner, true);
    if (isPlainToc(inner)) return tocResult(inner, true);
    const tex = parseTexture(inner);
    let rgba = await texToRgba(tex);
    if (opts.flip) rgba = flipVertical(rgba, tex.width, tex.height);
    return {
      kind: "texture",
      width: tex.width,
      height: tex.height,
      format: tex.format,
      rgba,
      compressed: true,
      mips: tex.mips,
    };
  }
  if (isPlainSound(data)) return soundResult(data, false);
  if (isPlainToc(data)) return tocResult(data, false);
  return decodeTtx(data, opts);
}

/**
 * Encode .toc.txt or JSON bytes → uncompressed .toc binary.
 * @param {Uint8Array} data
 * @param {string} fileName
 */
export function encodeTocAsset(data, fileName) {
  let doc;
  if (isTocJson(fileName, data)) {
    const raw = JSON.parse(new TextDecoder().decode(data));
    doc = docFromJson(raw);
  } else {
    doc = parseTocText(new TextDecoder().decode(data));
  }
  const binary = buildTocBinary(doc);
  return { kind: "toc_encode", doc, binary };
}

/** @returns {Promise<Blob>} */
export async function rgbaToPngBlob(rgba, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const img = new ImageData(new Uint8ClampedArray(rgba), width, height);
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))), "image/png");
  });
}
