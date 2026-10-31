/**
 * tmcompress / LZHAM inflate via Emscripten module.
 */
import createTmCompressModule from "./tmcompress.js";

let modPromise = null;

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
