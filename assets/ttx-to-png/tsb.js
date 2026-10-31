/**
 * Aerofly FS .tsb sound decode (browser).
 * Same typed-chunk + optional tmcompress wrapper as TTX.
 * Confirmed: mono 16-bit PCM LE @ sample rate stored as f32 (typically 22050).
 */

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
    if (size > 200) {
      pcm = data.subarray(off + 32, off + size);
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
