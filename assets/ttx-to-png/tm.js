/**
 * tmcompress / LZHAM inflate via Emscripten module.
 */
import createTmCompressModule from "./tmcompress.js";

let modPromise = null;
let packPromise = null;

export function initTmCompress() {
  if (!modPromise) {
    const base = new URL("./", import.meta.url).href;
    modPromise = createTmCompressModule({
      locateFile: (path) => base + path,
    });
  }
  return modPromise;
}

/**
 * Inflate a compress_file=true Aerofly container (TTX or TSB), or return plain blobs.
 * Plain texture magic a697… and plain sound magic 5f34… are returned unchanged.
 */
export async function inflateTtx(data) {
  if (data.length >= 8) {
    // plain texture
    if (data[0] === 0xa6 && data[1] === 0x97) return data;
    // plain sound (.tsb inner / uncompressed)
    if (data[0] === 0x5f && data[1] === 0x34) return data;
  }
  const Module = await initTmCompress();
  const inPtr = Module._malloc(data.length);
  Module.HEAPU8.set(data, inPtr);
  try {
    const unc = Module._tm_unc_size(inPtr, data.length);
    if (unc <= 0) throw new Error(`tm_unc_size failed (${unc})`);
    const outPtr = Module._malloc(unc);
    try {
      const n = Module._tm_inflate(inPtr, data.length, outPtr, unc);
      if (n <= 0) throw new Error(`tm_inflate failed (${n})`);
      return Module.HEAPU8.slice(outPtr, outPtr + n);
    } finally {
      Module._free(outPtr);
    }
  } finally {
    Module._free(inPtr);
  }
}

function initLzhamPack() {
  if (!packPromise) {
    const base = new URL("./", import.meta.url).href;
    packPromise = import("./lzham_pack.js").then((mod) =>
      mod.default({
        locateFile: (path) => base + path,
      })
    );
  }
  return packPromise;
}

/**
 * Raw LZHAM compress (no 6E CD zlib header).
 * dict_size_log2=21, table_update_rate=20, level=DEFAULT, matching IPACS.
 * A return of -7 means the output buffer was too small.
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
export async function lzhamCompressRaw(data) {
  const Module = await initLzhamPack();
  const inPtr = Module._malloc(data.length);
  if (!inPtr) throw new Error("LZHAM compress: out of memory");
  let cap = data.length + 65536;
  let outPtr = Module._malloc(cap);
  try {
    Module.HEAPU8.set(data, inPtr);
    let n = -7;
    for (let attempt = 0; attempt < 3 && n === -7; attempt++) {
      if (!outPtr) throw new Error("LZHAM compress: out of memory");
      n = Module._tm_lzham_compress(inPtr, data.length, outPtr, cap);
      if (n === -7) {
        Module._free(outPtr);
        outPtr = 0;
        cap *= 2;
        outPtr = Module._malloc(cap);
      }
    }
    if (n <= 0) throw new Error(`LZHAM compress failed (${n})`);
    return Module.HEAPU8.slice(outPtr, outPtr + n);
  } finally {
    Module._free(inPtr);
    if (outPtr) Module._free(outPtr);
  }
}
