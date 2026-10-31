/**
 * Node smoke test — run from this directory:
 *   node --experimental-wasm-modules test_decode.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { inflateTtx } from "./tm.js";
import { parseTexture, texToRgba, decodeDxt1 } from "./ttx.js";
import { decodeEtc2Rgb } from "./gpu_decode.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, "../../fixtures");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function testCompressedDxt1() {
  const p = path.join(FIX, "checkered_256x256_compressed_true_file_true.ttx");
  const data = new Uint8Array(fs.readFileSync(p));
  const inner = await inflateTtx(data);
  const plain = fs.readFileSync(path.join(FIX, "checkered_256x256_compressed_true.ttx"));
  assert(inner.length === plain.length - 0x20, `inner len ${inner.length}`);
  assert(Buffer.from(inner).equals(plain.subarray(0x20)), "inflate != plain[0x20:]");
  const info = parseTexture(inner);
  assert(info.format === "type_rgb_s3tc_dxt1", info.format);
  assert(info.width === 256 && info.height === 256, `${info.width}x${info.height}`);
  const rgba = decodeDxt1(info.pixels, 256, 256);
  // checker: corner should be near black or white
  const r0 = rgba[0],
    g0 = rgba[1],
    b0 = rgba[2];
  assert(r0 < 5 || r0 > 250, `unexpected corner ${r0},${g0},${b0}`);
  console.log("OK compressed DXT1 checker", info.format, `${info.width}x${info.height}`);
}

async function testLuftwaffe() {
  const p = path.join(FIX, "luftwaffe1.ttx");
  const data = new Uint8Array(fs.readFileSync(p));
  const t0 = Date.now();
  const inner = await inflateTtx(data);
  const info = parseTexture(inner);
  const rgba = await texToRgba(info);
  console.log(
    "OK luftwaffe1",
    info.format,
    `${info.width}x${info.height}`,
    `rgba=${rgba.length}`,
    `${Date.now() - t0}ms`
  );
}

async function testEtc2() {
  const p = path.join(FIX, "etc2_test_ttx_convert.ttx");
  const data = new Uint8Array(fs.readFileSync(p));
  const t0 = Date.now();
  const inner = await inflateTtx(data);
  const info = parseTexture(inner);
  assert(info.format === "type_rgb_etc2", info.format);
  const rgba = await decodeEtc2Rgb(info.pixels, info.width, info.height);
  assert(rgba.length === info.width * info.height * 4, `rgba len ${rgba.length}`);
  console.log(
    "OK etc2",
    info.format,
    `${info.width}x${info.height}`,
    `pix0=${[...rgba.slice(0, 4)]}`,
    `${Date.now() - t0}ms`
  );
}

async function main() {
  await testCompressedDxt1();
  await testEtc2();
  await testLuftwaffe();
  console.log("all passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
