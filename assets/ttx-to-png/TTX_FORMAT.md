# Aerofly FS asset formats (TTX textures, TSB sounds & TOC scenery)

Technical notes from reverse-engineering IPACS Aerofly FS container files for **decode**.  
All multi-byte integers are **little-endian** unless noted.

Status: confirmed against synthetic fixtures and shipping assets (2026). Not an official IPACS specification.

## Decode disclaimer (important for modders)

TTX → PNG recovers **what is stored in the texture file for the GPU**, not necessarily the artist’s original source asset.

| Concern | Detail |
|---------|--------|
| Original file type | Source may have been PNG, BMP, TGA, etc. — not recoverable as “the same file.” |
| Converter transforms | `flip_vertical`, `max_size`, `mipmaps`, `make_square`, … alter data before encode. |
| Lossy GPU formats | DXT1/3/5, ETC2, ASTC — preview ≈ source, never bit-exact. |
| Channel packing | `type_r` = one channel (mask/density); PNG is grayscale visualization. `type_rg_rgtc2` = BC5 RG (normals); PNG reconstructs Z. |
| Round-trip risk | Editing the decoded PNG and re-encoding to `.ttx` without the official pipeline can look wrong in-sim or crash. |

**Intended use:** inspection, reference, and careful editing aids.  
**Not intended as:** a guaranteed lossless extract of the pre-`.ttx` source, or a safe drop-in replacement texture.

---

## 1. Overview

A `.ttx` file is a nested **typed chunk** container around GPU texture data.

```
┌─────────────────────────────────────────────────────────┐
│ Outer container (32-byte header)                        │
│   magic distinguishes plain vs file-compressed          │
├─────────────────────────────────────────────────────────┤
│ Optional second container / property chunks             │
├─────────────────────────────────────────────────────────┤
│ Either:                                                 │
│   A) Plain texture props + pixel/mip blob               │
│   B) Size/CRC props + tmcompress(LZHAM) blob            │
│        → inflate → same as A starting at plain[0x20:]   │
└─────────────────────────────────────────────────────────┘
```

Official PNG→TTX conversion is done by IPACS `aerofly_fs_content_converter` via `.tmc` settings (`compressed`, `compress_file`, `texture_base_type`, `flip_vertical`, `max_size`, …). This project documents the **on-disk** result and how to decode it.

---

## 2. Chunk layout

Every chunk shares the same header:

| Offset | Size | Field |
|--------|------|--------|
| `+0x00` | 16 | Type ID (opaque bytes; first 8 often used as “magic”) |
| `+0x10` | 8 | `size` (`u64`) — total chunk length including this header |
| `+0x18` | 8 | `hs` (`u64`) — related header/size hint |
| `+0x20` | … | Payload |

**Walking rules used by the decoder:**

1. **Self-describing containers** — if `hs == 32` and `size` equals the remaining file length (or whole file length), treat as a wrapper and skip 32 bytes.
2. **Small property chunks** — advance by `size`, except when `size == 36` and `hs == 40` → step **40** (u32 value + 4 bytes pad).
3. **Large data chunk** — if `size > 200`, payload is the pixel blob or tmcompress blob; stop property walking.

String properties encode as: `u64 length` + ASCII bytes (no NUL required).

---

## 3. Outer magics

| Kind | First 8 bytes (hex) | Typical meaning |
|------|---------------------|-----------------|
| Plain texture | `a697e9acf9fcc17c` | `compress_file=false` |
| File-compressed | `b5fe24c7b73cebb7` | `compress_file=true` (shipping) |

Observed full 16-byte outer IDs (examples):

| Role | 16-byte type ID (hex) |
|------|------------------------|
| Plain outer | `a697e9acf9fcc17c` + `c3e386cb206d5fec` |
| Plain nested / inflated inner | `a697e9acf9fcc17c` + `ce25086b845bd426` |
| Compressed outer | `b5fe24c7b73cebb7` + `c3e386cb206d5fec` |
| Compressed nested | `b5fe24c7b73cebb7` + `ce25086b845bd426` |

Meaning of the second 8 bytes beyond “outer vs nested” is unknown.

---

## 4. File compression (`compress_file=true`)

Shipping textures use outer magic `b5fe…`. After two 32-byte containers, property chunks carry sizes and checksums, then a large data chunk holding **tmcompress**.

### 4.1 Wrapper properties (fixed offsets on typical files)

| File offset | Field | Type | Notes |
|-------------|-------|------|--------|
| `0x60` | SizeUncompressed | `u64` | Length of inflated inner blob |
| `0x88` | SizeCompressed | `u64` | Length of tmcompress blob (includes 64-byte hdr) |
| `0xb0` | CRC32 uncompressed | `u32` | zlib CRC-32 of inflated inner |
| `0xd8` | CRC32 compressed | `u32` | zlib CRC-32 of tmcompress blob |
| `0xe0` | Data chunk start | — | `size = SizeCompressed + 32` |

Example (`checkered_256x256_compressed_true_file_true.ttx`, 744 bytes):

- SizeUncompressed = `44048`
- SizeCompressed = `483`
- Data chunk @ `0xe0`, payload = 483 bytes starting with tmcompress header

### 4.2 What gets compressed

```
inflate(file_true.ttx)  ==  plain_compressed_false.ttx[0x20:]
```

- Compressed payload is the **inner** plain texture container (drops the outermost 32-byte wrapper).
- Inflated result still begins with plain magic `a697…`.
- SizeUncompressed matches that length (e.g. `44080 − 0x20 = 44048` for 256² DXT1).

### 4.3 tmcompress header (64 bytes)

Magic on disk: `f4 be 10 a8` → `u32` **`0xA810BEF4`**.

| Off | Type | Field | Observed |
|-----|------|--------|----------|
| `+0x00` | `u32` | `hdr_size` | `64` |
| `+0x04` | `u32` | magic | `0xA810BEF4` |
| `+0x08` | `u64` | uncompressed size | = SizeUncompressed |
| `+0x10` | `u64` | compressed size | = SizeCompressed (includes this header) |
| `+0x18` | `u64` | | `0` |
| `+0x20` | `u64` | | `0` |
| `+0x28` | `u64` | constant | `0x17F34DF32797945C` |
| `+0x30` | `u32` | `dict_size_log2` | `21` |
| `+0x34` | `u32` | `table_update_rate` | `20` |
| `+0x38` | `u64` | | `0` |
| `+0x40` | … | LZHAM bitstream | |

**Decompress flags (confirmed):**

```text
LZHAM_DECOMP_FLAG_OUTPUT_UNBUFFERED | LZHAM_DECOMP_FLAG_READ_ZLIB_STREAM
```

i.e. LZHAM with **zlib-style framing**, not raw LZHAM alone.

---

## 5. Inner texture (uncompressed / inflated)

After skipping containers, properties appear in this order:

1. `type_*` string — GPU format  
2. `target_2d` string — texture target  
3. `width` (`u32`)  
4. `height` (`u32`)  
5. `layers` (`u32`) — usually `1`  
6. `mips` (`u32`) — mipmap count  
7. Large chunk — raw pixel / block data (full mip chain, largest first)

Decoders must **walk chunks**, not assume fixed pixel offsets (offsets shift with string lengths and nesting).

### 5.1 Example offsets (256×256 ablations, `compress_file=false`)

| Layout | `type_*` | `target_2d` | w / h | layers / mips | pixels |
|--------|----------|-------------|-------|---------------|--------|
| `type_rgba` | `0x40` | `0x78` | `0xb0` / `0xd8` | `0x100` / `0x128` | `0x170` |
| `type_rgb_s3tc_dxt1` | `0x40` | `0x80` | `0xb8` / `0xe0` | `0x108` / `0x130` | `0x178` |

Inflated inners omit one outer container → same fields typically sit **`−0x20`** relative to a full plain file.

---

## 6. Pixel formats

| `type_*` string | Block | Bytes/block | Notes |
|-----------------|-------|-------------|--------|
| `type_rgba` | 1×1 | 4 | Raw RGBA8; optional full mip chain |
| `type_r` | 1×1 | 1 | Raw R8; clouds/masks; preview as grayscale RGB |
| `type_rg_rgtc2` | 4×4 | 16 | BC5 / RGTC2; normal-map XY; Z reconstructed in PNG preview |
| `type_rgb_s3tc_dxt1` | 4×4 | 8 | BC1 / DXT1; RGB sources from converter |
| `type_rgba_s3tc_dxt5` | 4×4 | 16 | BC3 / DXT5; interpolated alpha (scenery) |
| `type_rgba_s3tc_dxt3` | 4×4 | 16 | BC2 / DXT3; explicit 4-bit alpha |
| `type_rgb_astc_*x*` | N×M | 16 | ASTC (e.g. `type_rgb_astc_6x6`); mobile HDR-ish path |
| `type_rgb_etc2` | 4×4 | 8 | Opaque ETC2 (OpenGL / mobile) |
| `type_rgba_etc2` | 4×4 | 16 | ETC2 + EAC alpha; seen in game assets |
| `type_rgb_etc1` | 4×4 | 8 | Treated like opaque ETC in tools |

### Mip chain size

For DXT1 / opaque ETC2 (8 bytes/block):

\[
\sum_{i=0}^{mips-1} \lceil w_i/4\rceil\,\lceil h_i/4\rceil\cdot 8
\quad\text{with } w_{i+1}=\max(1,\lfloor w_i/2\rfloor)
\]

Same for DXT5 / DXT3 / ETC2+EAC with **16** instead of 8.

**Verified examples:**

| Asset | Format | Size | Mips | Payload bytes |
|-------|--------|------|------|----------------|
| Checker 256 | DXT1 | 256² | 9 | 43704 (file 44080) |
| Checker 256 | RGBA | 256² | 9 | 349524 (+4 pad; file 349896) |
| A320 color | DXT1 | 4096² | 13 | 11184824 |
| Brighton viaduct | DXT5 | 512² | 10 | 349552 |
| Japan 350 wing | ASTC 6×6 | 2048² | 12 | 2497712 |
| Cloud cirrus | R8 (`type_r`) | 512² | 10 | 349525 |
| ETC2 test | ETC2 RGB | 2048² | 1 | 2097152 |

PNG export uses the **top mip only**.

---

## 7. Converter settings vs file contents

Relevant `.tmc` texture settings:

| Setting | Effect on `.ttx` |
|---------|------------------|
| `texture_base_type` = `ttx_dxt` | Vulkan/PC path → usually `type_rgb_s3tc_dxt1` |
| `texture_base_type` = `ttx_etc2` | OpenGL path → `type_rgb_etc2` / `type_rgba_etc2` |
| `compressed` | GPU block compression vs raw RGBA |
| `compress_file` | Outer `b5fe…` + LZHAM vs plain `a697…` |
| `mipmaps` | `mips` count and payload length |
| `max_size` | Downscale before encode; dims / SizeUncompressed are **post-scale** |
| `flip_vertical` | Applied at convert time only — **no flag stored in the file** |
| `write_text_format` | Did not produce useful TTX text sidecars in tests (`tm.log` is useful) |

### `flip_vertical`

Confirmed: true/false pair → **identical headers**, pixel rows exact vertical mirrors.  
Decode tools optionally flip again for source-art orientation (web UI defaults flip **on** for liveries).

---

## 8. Decode pipeline

```
.ttx bytes
    │
    ├─ magic a697… ──────────────────────────────┐
    │                                            │
    └─ magic b5fe… → find tmcompress → LZHAM     │
                       inflate → inner a697… ────┤
                                                 ▼
                                      skip containers
                                      walk props → type/w/h/mips/pixels
                                                 │
                      ┌──────────────────────────┼──────────────────────┐
                      ▼                          ▼                      ▼
                   RGBA8                      DXT1                   ETC2 / ETC2+EAC
                      │                          │                      │
                      └──────────────────────────┴──────────────────────┘
                                                 │
                                        optional flip_vertical
                                                 │
                                                PNG
```

---

## 9. TSB sound format (`.tsb`)

Scenery / object sounds use the **same typed-chunk container and optional `compress_file` (tmcompress/LZHAM) wrapper** as textures. Only the inner magic and properties differ.

### Design note (in-game)

Aerofly places sounds in 3D (e.g. cone + decay). The engine already pans left/right when the listener rotates. Shipping **mono** avoids fighting that spatialization with a second stereo image. Community practice for GE sounds: **22050 Hz, 16-bit PCM, mono**.

### Magics

| Kind | First 8 bytes (hex) |
|------|---------------------|
| File-compressed (observed on converter output even when `compress_file=false` was set in one test) | `b5fe24c7b73cebb7` (same as TTX) |
| Plain / inflated sound | `5f34996ef311969d` |

### Inflated layout (example: `azzurro.tsb` from mono 22050 Hz 16-bit WAV)

| Offset (typical) | Field |
|------------------|--------|
| `0x00` | 32-byte self-describing container (`hs=32`) |
| `0x20` | String prop **`mono16`** (`u64` len + ASCII) |
| `0x50` | Sample rate as **`f32`** (e.g. `22050.0`) — not an integer prop |
| `0x78` | Large data chunk → raw **PCM s16le** |

Verified: PCM payload is **bit-exact** equal to the source WAV `data` chunk (`payload == wav_pcm`).

### Decode recipe

1. If outer magic `b5fe…` → inflate with tmcompress/LZHAM (same as TTX).  
2. Skip container(s).  
3. Read format string (e.g. `mono16`) and rate `f32`.  
4. Remaining blob → wrap as RIFF/WAVE (`channels=1`, `sampwidth=2`, `rate=round(f32)`).

Other labels such as `stereo16` are plausible from the naming pattern but **not yet observed** in fixtures.

---

## 10. TOC scenery tables (`.toc`)

Scenery / cultivation tables use the **same typed-chunk container and optional `compress_file` wrapper** as TTX/TSB. They are **not** Unicode text files — editors that show “a few lines” are misreading binary newlines.

### Magics

| Kind | First 8 bytes (hex) |
|------|---------------------|
| File-compressed (shipping) | `b5fe24c7b73cebb7` (same as TTX) |
| Plain / inflated TOC | `cd7d1c0b54de0fe1` |

### Airport / object TOC (example: `lgpa.toc`)

After inflate, props include:

| Field | Notes |
|-------|--------|
| `coordinate_system` | String, typically **`lonlat`** |
| Root id | First placement name (e.g. `dh8d_anz`) + origin lon/lat |
| Objects | Model name + **lon** (`f64`) + **lat** (`f64`) + **heading** (`f32`, degrees) + **scale** (`f32`) |

Lon/lat pairs use a dedicated 56-byte property chunk (two little-endian `f64`s).

Cultivation tiles (`tile_*.toc`) share the container but store dense building data; the decoder reports a summary when named object placements are absent.

### Decode recipe

1. If outer magic `b5fe…` → inflate with tmcompress/LZHAM.  
2. Confirm inner magic `cd7d…`.  
3. Walk typed props / object list → JSON (and optional CSV).

**Not a round-trip encoder.** JSON/CSV is for inspection and scenery authoring workflow; shipping still goes through the official converter.

---

## 11. Open questions / limitations

| Topic | Status |
|-------|--------|
| Full meaning of 16-byte type IDs | Unknown beyond plain vs compressed / nesting hints |
| `layers > 1`, non-`target_2d` | Not explored |
| DXT3/DXT5 decode | Supported (`type_rgba_s3tc_dxt3` / `dxt5`) |
| Bit-exact original PNG from DXT/ETC | Impossible (lossy). Solid B/W DXT1 synthetics can round-trip exactly |
| PNG → TTX | Browser writes plain (`compress_file=false`) ETC2 or DXT1/DXT5. LZHAM file compression still needs the official converter |
| WAV → TSB / JSON → TOC encode | Out of scope; use official converter |
| TSB stereo / other rates | Not in corpus yet; `mono16` @ 22050 confirmed |
| `compress_file=false` for audio | One test still produced `b5fe` wrapper — treat inflate as required when magic matches |
| Cultivation TOC full geometry dump | Partial (summary / strings); object-list TOCs fully decoded |

---

## 12. Tools in this project

| Tool | Role |
|------|------|
| `tools/ttx_to_png.py` / `~/src/ttx_re/ttx_to_png.py` | CLI parse + texture decode |
| `tools/toc_to_json.py` | CLI `.toc` → JSON / CSV |
| `tools/tmcompress_inflate.c` → `bin/tmcompress_inflate` | Native LZHAM inflate |
| `web/ttx-to-png/` | Browser TTX↔PNG (plain ETC2/DXT encode), TSB→WAV, TOC→JSON/CSV |
| `aerofly_fs_poi_convert_project_macos_linux/` | Official converter + `.tmc` configs |
| `lzham_codec/` | LZHAM sources used for inflate |

### Quick CLI

```bash
# Prefer a Python that has Pillow + texture2ddecoder:
python3 ttx_to_png.py parse path/to/file.ttx
python3 ttx_to_png.py decode path/to/file.ttx -o out.png --flip

# Scenery tables (needs tmcompress_inflate for compress_file):
python3 toc_to_json.py path/to/file.toc -o out.json --csv out.csv
```

---

## 13. Revision

| Date | Notes |
|------|--------|
| 2026-07 | Initial write-up: container, tmcompress/LZHAM, RGBA/DXT1/ETC2/ETC2+EAC decode |
| 2026-07 | DXT5/3, ASTC, `type_r`, `type_rg_rgtc2`; decode disclaimer |
| 2026-07 | TSB sound: `mono16` + f32 rate + PCM s16le; web TSB→WAV |
| 2026-08 | TOC scenery: `lonlat` placements → JSON/CSV (CLI + web) |
| 2026-11 | Browser PNG → plain TTX: ETC2 (mobile) and DXT1/DXT5 (PC) |
