/**
 * Aerofly FS .tsb sound decode and encode (browser).
 * Same typed-chunk + tmcompress wrapper as TTX.
 * Shipping sounds are compress_file (LZHAM). The inflated blob is
 * mono 16-bit PCM LE at an f32 sample rate (22050).
 */
import { lzhamCompressRaw } from "./tm.js";

const MAGIC_COMPRESSED = [0xb5, 0xfe, 0x24, 0xc7, 0xb7, 0x3c, 0xeb, 0xb7];
const MAGIC_SOUND = [0x5f, 0x34, 0x99, 0x6e, 0xf3, 0x11, 0x96, 0x9d];

function magicEq(bytes, magic) {
  for (let i = 0; i < 8; i++) if (bytes[i] !== magic[i]) return false;
  return true;
}

export function isFileCompressed(data) {
  return magicEq(data, MAGIC_COMPRESSED);
}

export function isPlainSound(data) {
  return magicEq(data, MAGIC_SOUND);
}

function u32(dv, off) {
  return dv.getUint32(off, true);
}
function u64(dv, off) {
  const lo = dv.getUint32(off, true);
  const hi = dv.getUint32(off + 4, true);
  if (hi !== 0) return hi * 0x100000000 + lo;
  return lo;
}
function f32(dv, off) {
  return dv.getFloat32(off, true);
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

/**
 * Parse inflated / plain sound blob.
 * @returns {{ format: string, sampleRate: number, channels: number, bits: number, pcm: Uint8Array }}
 */
export function parseSound(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = skipContainers(data);
  let format = null;
  let sampleRate = null;
  let pcm = null;

  while (off + 32 <= data.length) {
    const size = u64(dv, off + 16);
    const hs = u64(dv, off + 24);
    // Shipping sounds are large. A short plain TSB still stores PCM in the
    // chunk after the format string and the sample-rate float.
    if (size > 200 || (format && sampleRate != null && size > 32)) {
      const end = Math.min(data.length, off + size);
      pcm = data.subarray(off + 32, end);
      break;
    }
    const step = size === 36 && hs === 40 ? 40 : size;
    if (step < 32) throw new Error(`bad sound chunk step at 0x${off.toString(16)}`);
    const payload = data.subarray(off + 32, off + step);
    if (payload.length >= 16) {
      const s = parseStringProp(payload);
      if (s) {
        format = s;
        off += step;
        continue;
      }
    }
    if (payload.length >= 4 && payload.length <= 8 && sampleRate == null) {
      sampleRate = f32(new DataView(payload.buffer, payload.byteOffset, payload.byteLength), 0);
      off += step;
      continue;
    }
    off += step;
  }

  if (!format || sampleRate == null || !pcm) {
    throw new Error(
      `incomplete sound parse: format=${format} rate=${sampleRate} pcm=${pcm ? pcm.length : null}`
    );
  }

  let channels = 1;
  let bits = 16;
  const m = /^(mono|stereo)(\d+)$/.exec(format);
  if (m) {
    channels = m[1] === "stereo" ? 2 : 1;
    bits = Number(m[2]);
  } else if (format !== "mono16") {
    // Still allow unknown labels if payload looks like PCM; default mono16 semantics
  }

  return { format, sampleRate, channels, bits, pcm };
}

/** Build a RIFF/WAVE blob from PCM. */
export function pcmToWavBlob(pcm, sampleRate, channels = 1, bits = 16) {
  const bytesPerSample = bits / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = Math.round(sampleRate) * blockAlign;
  const dataSize = pcm.length;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  function writeStr(offset, s) {
    for (let i = 0; i < s.length; i++) u8[offset + i] = s.charCodeAt(i);
  }

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, Math.round(sampleRate), true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  u8.set(pcm, 44);

  return new Blob([buffer], { type: "audio/wav" });
}

/** Aerofly scenery sounds are mono 16-bit PCM at this rate. */
export const AEROFY_SAMPLE_RATE = 22050;

const SOUND_ROOT = hex("5f34996ef311969dce25086b845bd426");
const CHUNK_FORMAT = hex("9ddb2d4b68acd1bdb615eacee1842160");
const CHUNK_RATE = hex("087f64a075aceab853236d148be04aad");
const CHUNK_PCM = hex("9e765602020202027fc676a557237c3d");

function hex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

function fourCC(data, off) {
  return String.fromCharCode(data[off], data[off + 1], data[off + 2], data[off + 3]);
}

function writeU64(dv, off, v) {
  dv.setUint32(off, v >>> 0, true);
  dv.setUint32(off + 4, Math.floor(v / 4294967296), true);
}

/**
 * Read a PCM WAV. Extra chunks (LIST, fact, JUNK) are skipped.
 * WAVE_FORMAT_EXTENSIBLE is accepted when the subtype is PCM.
 * @returns {{ format: number, channels: number, sampleRate: number, bits: number, pcm: Uint8Array }}
 */
export function parseWav(data) {
  if (data.length < 12 || fourCC(data, 0) !== "RIFF" || fourCC(data, 8) !== "WAVE") {
    throw new Error("Not a WAV file (expected RIFF/WAVE).");
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = 12;
  let fmt = null;
  let pcm = null;
  while (off + 8 <= data.length) {
    const id = fourCC(data, off);
    const size = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (size < 0 || start + size > data.length) throw new Error("WAV chunk is truncated.");
    if (id === "fmt ") {
      if (size < 16) throw new Error("WAV fmt chunk is too small.");
      let format = dv.getUint16(start, true);
      const channels = dv.getUint16(start + 2, true);
      const sampleRate = dv.getUint32(start + 4, true);
      const bits = dv.getUint16(start + 14, true);
      if (format === 0xfffe) {
        if (size < 40) throw new Error("WAV extensible fmt chunk is too small.");
        format = dv.getUint16(start + 24, true) === 1 ? 1 : dv.getUint16(start + 24, true);
      }
      fmt = { format, channels, sampleRate, bits };
    } else if (id === "data") {
      pcm = data.subarray(start, start + size);
    }
    off = start + size + (size & 1);
  }
  if (!fmt || !pcm) throw new Error("WAV is missing a fmt or data chunk.");
  if (pcm.length === 0) throw new Error("WAV has no audio samples.");
  return { ...fmt, pcm };
}

function describeWav(wav) {
  const rate = `${wav.sampleRate} Hz`;
  const ch =
    wav.channels === 1 ? "mono" : wav.channels === 2 ? "stereo" : `${wav.channels} channels`;
  const kind = wav.format === 1 ? "PCM" : wav.format === 3 ? "float" : `format ${wav.format}`;
  return `${rate}, ${ch}, ${wav.bits}-bit ${kind}`;
}

const MAGIC_COMPRESSED_U8 = hex("b5fe24c7b73cebb7");
const NAME_OUTER = hex("c3e386cb206d5fec");
const NAME_NESTED = hex("ce25086b845bd426");
const TYPE_U64 = hex("bc628ed22a7082f3");
const TYPE_U32 = hex("9e8caf8498703ec2");
const TYPE_LIST = hex("9e76560202020202");
const NAME_SIZE_UNCOMP = hex("ce52fa6eeab214e0");
const NAME_SIZE_COMP = hex("830052acb2538fa0");
const NAME_CRC_UNCOMP = hex("e85a613f0a820d7c");
const NAME_CRC_COMP = hex("195fe06aabefe29c");
const NAME_COMP_BLOB = hex("9cb7d88489f1f234");

function align8(n) {
  return (n + 7) & ~7;
}

function crc32(bytes) {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function u32Bytes(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

function u64Bytes(n) {
  const b = new Uint8Array(8);
  writeU64(new DataView(b.buffer), 0, n);
  return b;
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function wrapContainer(name8, inner) {
  const out = new Uint8Array(32 + inner.length);
  out.set(MAGIC_COMPRESSED_U8, 0);
  out.set(name8, 8);
  const dv = new DataView(out.buffer);
  writeU64(dv, 16, out.length);
  writeU64(dv, 24, 32);
  out.set(inner, 32);
  return out;
}

function tmcompressHeader(uncomp, csize) {
  const hdr = new Uint8Array(64);
  const dv = new DataView(hdr.buffer);
  dv.setUint32(0, 64, true);
  dv.setUint32(4, 0xa810bef4, true);
  dv.setBigUint64(8, BigInt(uncomp), true);
  dv.setBigUint64(16, BigInt(csize), true);
  dv.setBigUint64(40, 0x17f34df32797945cn, true);
  dv.setUint32(48, 21, true);
  dv.setUint32(52, 20, true);
  return hdr;
}

/**
 * compress_file container around an already-built sound blob.
 * `raw` is the LZHAM payload without the 2-byte zlib header.
 * @param {Uint8Array} plain
 * @param {Uint8Array} raw
 */
export function wrapSoundContainer(plain, raw) {
  const stream = concat([new Uint8Array([0x6e, 0xcd]), raw]);
  const packed = concat([tmcompressHeader(plain.length, 64 + stream.length), stream]);
  const props = concat([
    typedChunk(concat([TYPE_U64, NAME_SIZE_UNCOMP]), u64Bytes(plain.length), 40, 40),
    typedChunk(concat([TYPE_U64, NAME_SIZE_COMP]), u64Bytes(packed.length), 40, 40),
    typedChunk(concat([TYPE_U32, NAME_CRC_UNCOMP]), u32Bytes(crc32(plain)), 36, 40),
    typedChunk(concat([TYPE_U32, NAME_CRC_COMP]), u32Bytes(crc32(packed)), 36, 40),
    typedChunk(concat([TYPE_LIST, NAME_COMP_BLOB]), packed, 32 + packed.length, align8(32 + packed.length)),
  ]);
  return wrapContainer(NAME_OUTER, wrapContainer(NAME_NESTED, props));
}

/**
 * Plain inner sound blob for a 22050 Hz, mono, 16-bit PCM WAV.
 * Other WAV layouts are refused: Aerofly does not play them.
 * The PCM chunk header size is rounded up to 8 bytes, matching shipping files.
 * @param {Uint8Array} data
 */
export function buildPlainTsb(data) {
  const wav = parseWav(data);
  if (wav.sampleRate !== AEROFY_SAMPLE_RATE || wav.channels !== 1 || wav.bits !== 16 || wav.format !== 1) {
    throw new Error(
      `Aerofly needs a 22050 Hz, mono, 16-bit PCM WAV. This file is ${describeWav(wav)}.`
    );
  }
  const bytesPerFrame = 2;
  if (wav.pcm.length % bytesPerFrame !== 0) {
    throw new Error("WAV data length is not a whole number of 16-bit samples.");
  }

  const fmtBody = new Uint8Array(16);
  const fmtDv = new DataView(fmtBody.buffer);
  writeU64(fmtDv, 0, 6);
  fmtBody.set([0x6d, 0x6f, 0x6e, 0x6f, 0x31, 0x36], 8);
  const fmtChunk = typedChunk(CHUNK_FORMAT, fmtBody, 48, 48);

  const rateBody = new Uint8Array(4);
  new DataView(rateBody.buffer).setFloat32(0, AEROFY_SAMPLE_RATE, true);
  const rateChunk = typedChunk(CHUNK_RATE, rateBody, 36, 40);

  const dataSize = 32 + wav.pcm.length;
  const dataChunk = typedChunk(CHUNK_PCM, wav.pcm, dataSize, align8(dataSize));

  const total = 32 + fmtChunk.length + rateChunk.length + dataChunk.length;
  const out = new Uint8Array(total);
  out.set(SOUND_ROOT, 0);
  const dv = new DataView(out.buffer);
  writeU64(dv, 16, total);
  writeU64(dv, 24, 32);
  let o = 32;
  out.set(fmtChunk, o);
  o += fmtChunk.length;
  out.set(rateChunk, o);
  o += rateChunk.length;
  out.set(dataChunk, o);

  return {
    bytes: out,
    pcm: wav.pcm,
    format: "mono16",
    sampleRate: AEROFY_SAMPLE_RATE,
    channels: 1,
    bits: 16,
    frames: wav.pcm.length / bytesPerFrame,
    compressed: false,
  };
}

/**
 * Shipping Aerofly .tsb (compress_file) for a 22050 Hz, mono, 16-bit PCM WAV.
 * @param {Uint8Array} data
 */
export async function wavToTsb(data) {
  const plain = buildPlainTsb(data);
  const raw = await lzhamCompressRaw(plain.bytes);
  return {
    ...plain,
    bytes: wrapSoundContainer(plain.bytes, raw),
    compressed: true,
  };
}

function typedChunk(type16, payload, size, hs) {
  const out = new Uint8Array(Math.max(size, hs));
  out.set(type16, 0);
  const dv = new DataView(out.buffer);
  writeU64(dv, 16, size);
  writeU64(dv, 24, hs);
  out.set(payload, 32);
  return out;
}
