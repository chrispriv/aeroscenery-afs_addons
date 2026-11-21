/**
 * WAV → plain inner TSB. Run from this directory:
 *   node test_wav_tsb.mjs
 */
import { buildPlainTsb, parseSound, wavToTsb } from "./tsb.js";
import { inflateTtx } from "./tm.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function wavBytes(rate, channels, bits, frames, fill) {
  const bytesPer = (bits / 8) * channels;
  const dataSize = frames * bytesPer;
  const buf = new ArrayBuffer(44 + dataSize);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const write = (off, s) => {
    for (let i = 0; i < s.length; i++) u8[off + i] = s.charCodeAt(i);
  };
  write(0, "RIFF");
  dv.setUint32(4, 36 + dataSize, true);
  write(8, "WAVE");
  write(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * bytesPer, true);
  dv.setUint16(32, bytesPer, true);
  dv.setUint16(34, bits, true);
  write(36, "data");
  dv.setUint32(40, dataSize, true);
  for (let i = 0; i < dataSize; i++) u8[44 + i] = fill(i);
  return u8;
}

function rejects(data, needle) {
  try {
    buildPlainTsb(data);
  } catch (e) {
    assert(String(e.message).includes(needle), e.message);
    return;
  }
  throw new Error(`expected rejection containing ${needle}`);
}

const good = wavBytes(22050, 1, 16, 8, (i) => (i * 17) & 255);
const enc = buildPlainTsb(good);
assert(enc.format === "mono16", enc.format);
assert(enc.frames === 8, String(enc.frames));
assert(enc.bytes[0] === 0x5f && enc.bytes[1] === 0x34, "sound magic");
const parsed = parseSound(enc.bytes);
assert(parsed.format === "mono16", parsed.format);
assert(parsed.sampleRate === 22050, String(parsed.sampleRate));
assert(parsed.pcm.length === 16, String(parsed.pcm.length));
for (let i = 0; i < 16; i++) assert(parsed.pcm[i] === good[44 + i], `pcm ${i}`);
console.log("OK 22050 mono 16-bit", enc.bytes.length, "bytes");

const packed = await wavToTsb(good);
if (packed.bytes[0] !== 0xb5 || packed.bytes[1] !== 0xfe) {
  throw new Error("expected compress_file magic");
}
const inner = await inflateTtx(packed.bytes);
if (inner.length !== enc.bytes.length || inner.some((v, i) => v !== enc.bytes[i])) {
  throw new Error("inflate does not match the plain sound");
}
const again = parseSound(inner);
if (again.format !== "mono16" || again.pcm.length !== 16) {
  throw new Error("compressed round-trip lost the format");
}
console.log("OK compress_file", packed.bytes.length, "bytes");

rejects(wavBytes(44100, 1, 16, 4, () => 0), "44100 Hz");
rejects(wavBytes(22050, 2, 16, 4, () => 0), "stereo");
rejects(wavBytes(22050, 1, 24, 4, () => 0), "24-bit");
console.log("OK rejected other WAV layouts");
