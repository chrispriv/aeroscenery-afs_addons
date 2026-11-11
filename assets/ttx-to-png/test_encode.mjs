/**
 * Node smoke test for PNG pixels → plain TTX.
 *   node test_encode.mjs
 */
import { encodeRgbaToTtx } from "./encode_ttx.js";
import { parseTexture, decodeDxt1 } from "./ttx.js";
import { decodeEtc2Rgb, decodeEtc2Rgba, decodeBc3 } from "./gpu_decode.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function fill(w, h, fn) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * w + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = a;
    }
  }
  return rgba;
}

function px(rgba, w, x, y) {
  const i = (y * w + x) * 4;
  return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
}

async function decodeTop(bytes) {
  const info = parseTexture(bytes);
  let rgba;
  if (info.format === "type_rgb_etc2") rgba = await decodeEtc2Rgb(info.pixels, info.width, info.height);
  else if (info.format === "type_rgba_etc2") rgba = await decodeEtc2Rgba(info.pixels, info.width, info.height);
  else if (info.format === "type_rgb_s3tc_dxt1") rgba = decodeDxt1(info.pixels, info.width, info.height);
  else if (info.format === "type_rgba_s3tc_dxt5") rgba = await decodeBc3(info.pixels, info.width, info.height);
  else throw new Error(`unexpected format ${info.format}`);
  return { info, rgba };
}

async function testSolid(family, expectFmt, mips) {
  const w = 32;
  const h = 32;
  const src = fill(w, h, () => [220, 30, 40, 255]);
  const enc = await encodeRgbaToTtx(src, w, h, { family });
  assert(enc.format === expectFmt, `${family} format ${enc.format}`);
  assert(enc.bytes[0] === 0xa6, "plain magic");
  assert(enc.compressed === false, "plain container");
  assert(enc.mips === mips, `${family} mips ${enc.mips}`);
  const { info, rgba } = await decodeTop(enc.bytes);
  assert(info.width === w && info.height === h, "dims");
  assert(info.mips === mips, `stored mips ${info.mips}`);
  const p = px(rgba, w, 4, 4);
  assert(Math.abs(p[0] - 220) < 16 && p[1] < 50 && p[2] < 60, `${family} solid ${p}`);
  console.log("OK", family, "solid", expectFmt, `${enc.bytes.length} bytes`);
}

async function testSplit() {
  const w = 32;
  const h = 16;
  const src = fill(w, h, (x) => (x < w / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  for (const family of ["etc2", "dxt"]) {
    const enc = await encodeRgbaToTtx(src, w, h, { family });
    const { rgba } = await decodeTop(enc.bytes);
    const left = px(rgba, w, 2, 2);
    const right = px(rgba, w, w - 3, 2);
    assert(left[0] > 200 && left[2] < 40, `${family} left ${left}`);
    assert(right[2] > 200 && right[0] < 40, `${family} right ${right}`);
    console.log("OK", family, "split", left, right);
  }
}

async function testAlpha() {
  const w = 16;
  const h = 16;
  const src = fill(w, h, () => [10, 20, 30, 128]);
  const etc = await encodeRgbaToTtx(src, w, h, { family: "etc2" });
  assert(etc.format === "type_rgba_etc2", etc.format);
  const dxt = await encodeRgbaToTtx(src, w, h, { family: "dxt" });
  assert(dxt.format === "type_rgba_s3tc_dxt5", dxt.format);
  for (const enc of [etc, dxt]) {
    const { rgba } = await decodeTop(enc.bytes);
    const p = px(rgba, w, 3, 3);
    assert(Math.abs(p[3] - 128) < 20, `${enc.format} alpha ${p}`);
    assert(p[0] < 40 && p[1] < 50 && p[2] < 60, `${enc.format} rgb ${p}`);
    console.log("OK alpha", enc.format, p);
  }
}

async function testGradient() {
  const w = 64;
  const h = 32;
  const src = fill(w, h, (x, y) => [
    Math.round((x * 255) / (w - 1)),
    Math.round((y * 255) / (h - 1)),
    0,
    255,
  ]);
  for (const family of ["etc2", "dxt"]) {
    const enc = await encodeRgbaToTtx(src, w, h, { family });
    const { rgba } = await decodeTop(enc.bytes);
    let err = 0;
    const n = w * h;
    for (let i = 0; i < n; i++) {
      err += Math.abs(rgba[i * 4] - src[i * 4]);
      err += Math.abs(rgba[i * 4 + 1] - src[i * 4 + 1]);
    }
    const mean = err / (n * 2);
    assert(mean < 22, `${family} gradient mean ${mean.toFixed(2)}`);
    const a = px(rgba, w, 1, 8)[0];
    const b = px(rgba, w, w - 2, 8)[0];
    assert(b > a + 100, `${family} ramp ${a} → ${b}`);
    console.log("OK", family, "gradient mean", mean.toFixed(2));
  }
}

async function testFlip() {
  const w = 16;
  const h = 16;
  const src = fill(w, h, (_x, y) => (y < h / 2 ? [255, 0, 0, 255] : [0, 255, 0, 255]));
  const enc = await encodeRgbaToTtx(src, w, h, { family: "dxt", flip: true });
  const { rgba } = await decodeTop(enc.bytes);
  const top = px(rgba, w, 4, 1);
  const bot = px(rgba, w, 4, h - 2);
  assert(top[1] > 200 && top[0] < 40, `flipped top ${top}`);
  assert(bot[0] > 200 && bot[1] < 40, `flipped bottom ${bot}`);
  console.log("OK flip", top, bot);
}

async function main() {
  await testSolid("etc2", "type_rgb_etc2", 4);
  await testSolid("dxt", "type_rgb_s3tc_dxt1", 6);
  await testSplit();
  await testAlpha();
  await testGradient();
  await testFlip();
  console.log("all encode tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
