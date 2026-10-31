# TTX / TSB / TOC (browser)

Client-side Aerofly FS converter. Nothing is uploaded.

| Input | Output |
|-------|--------|
| `.ttx` | PNG preview |
| `.tsb` | WAV |
| `.toc` | `.toc.txt` (official syntax) + JSON (+ uncompressed `.toc`) |
| `.toc.txt` / `.json` | uncompressed `.toc` |

Format refs: [`../../docs/TTX_FORMAT.md`](../../docs/TTX_FORMAT.md), [`../../docs/TOC_FORMAT.md`](../../docs/TOC_FORMAT.md).

## Disclaimer — read before reusing PNGs

The downloaded PNG is a **preview of GPU texture data inside the `.ttx`**, not a proven twin of the artist’s original source file.

- The original may have been PNG, TGA, or another type; it may have been flipped, scaled (`max_size`), mipmapped, or lossily compressed when the `.ttx` was built.
- Block formats (DXT / ETC / ASTC) are **lossy** — pixels will not match the pre-convert source.
- **`type_r`** is a single channel (often a mask); the PNG is a grayscale visualization.
- **`type_rg_rgtc2`** stores only normal XY; the PNG **reconstructs Z** for viewing.
- Feeding a modified PNG back through an unofficial encode path (or treating it as a drop-in replacement) can produce **wrong visuals or crashes**. Prefer the official IPACS converter for anything you ship.

## Deploy

Upload this folder as static files (any HTTPS host). Required files:

```
index.html
styles.css
app.js
decode.js
tm.js
ttx.js
tsb.js
toc.js
gpu_decode.js
tmcompress.js
tmcompress.wasm
vendor/texture2ddecoder/texture2ddecoder.js
vendor/texture2ddecoder/texture2ddecoder.wasm
```

Serve over **HTTP(S)** (not `file://`) so WASM modules can load.

## Rebuild LZHAM WASM (local Mac only)

```bash
# needs: brew install emscripten, ~/src/lzham_codec
zsh wasm/build.sh
```

## Local test

```bash
cd web/ttx-to-png
python3 -m http.server 8765
# open http://localhost:8765
node test_decode.mjs   # node smoke tests
```

## Formats

| Format | Notes |
|--------|--------|
| `type_rgba` | Raw RGBA8 |
| `type_rgb_s3tc_dxt1` | Pure JS DXT1 |
| `type_r` | Raw R8 → grayscale RGB preview (clouds/masks) |
| `type_rgb_astc_NxM` | ASTC (block size from name, e.g. 6×6) |
| `type_rgba_s3tc_dxt5` | BC3 / DXT5 (alpha) via decode_bc3 |
| `type_rgba_s3tc_dxt3` | BC2 / DXT3 (explicit alpha) pure JS |
| `type_rgb_etc2` / `type_rgb_etc1` | texture2ddecoder WASM |
| `type_rgba_etc2` | ETC2+EAC (alpha) via decode_etc2a8 |
| `compress_file=true` | LZHAM/tmcompress inflate (WASM) |
| `.tsb` / `mono16` | Sound → WAV (PCM s16le mono, rate from f32) |

Flip vertically is **on by default** (aircraft liveries). Uncheck for source-art orientation.
