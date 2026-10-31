#!/bin/zsh
# Build tmcompress.wasm on local Mac (NOT NAS).
# Requires: brew install emscripten, patched lzham_codec at ~/src/lzham_codec
set -euo pipefail

ROOT="${TTX_RE:-$HOME/src/ttx_re}"
LZHAM="${LZHAM_SRC:-$HOME/src/lzham_codec}"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WASM_SRC="$(cd "$(dirname "$0")" && pwd)"

# Prefer workspace wasm source if present
if [[ -f "$WASM_SRC/tmcompress_wasm.c" ]]; then
  WRAPPER="$WASM_SRC/tmcompress_wasm.c"
elif [[ -f "$ROOT/web/wasm/tmcompress_wasm.c" ]]; then
  WRAPPER="$ROOT/web/wasm/tmcompress_wasm.c"
else
  echo "tmcompress_wasm.c not found" >&2
  exit 1
fi

DECOMP="$LZHAM/lzhamdecomp"
INC="$LZHAM/include"

SRCS=(
  "$WRAPPER"
  "$DECOMP/lzham_assert.cpp"
  "$DECOMP/lzham_checksum.cpp"
  "$DECOMP/lzham_huffman_codes.cpp"
  "$DECOMP/lzham_lzdecomp.cpp"
  "$DECOMP/lzham_lzdecompbase.cpp"
  "$DECOMP/lzham_mem.cpp"
  "$DECOMP/lzham_platform.cpp"
  "$DECOMP/lzham_prefix_coding.cpp"
  "$DECOMP/lzham_symbol_codec.cpp"
  "$DECOMP/lzham_timer.cpp"
  "$DECOMP/lzham_vector.cpp"
)

# Provide C API entrypoints used by tmcompress_wasm.c (normally in lzhamdll/lzhamlib)
# We compile a tiny shim that forwards to lzham_lib_* in the decomp unit.
SHIM="$WASM_SRC/lzham_c_api_shim.cpp"
cat > "$SHIM" << 'EOF'
#include "lzham.h"
#include "lzham_decomp.h"
extern "C" {
lzham_uint32 LZHAM_CDECL lzham_get_version(void) { return LZHAM_DLL_VERSION; }
lzham_decompress_state_ptr LZHAM_CDECL lzham_decompress_init(const lzham_decompress_params *p) {
  return lzham::lzham_lib_decompress_init(p);
}
lzham_uint32 LZHAM_CDECL lzham_decompress_deinit(lzham_decompress_state_ptr p) {
  return lzham::lzham_lib_decompress_deinit(p);
}
lzham_decompress_status_t LZHAM_CDECL lzham_decompress(
    lzham_decompress_state_ptr p, const lzham_uint8 *in, size_t *in_size,
    lzham_uint8 *out, size_t *out_size, lzham_bool no_more) {
  return lzham::lzham_lib_decompress(p, in, in_size, out, out_size, no_more);
}
lzham_decompress_status_t LZHAM_CDECL lzham_decompress_memory(
    const lzham_decompress_params *p, lzham_uint8 *dst, size_t *dst_len,
    const lzham_uint8 *src, size_t src_len, lzham_uint32 *adler) {
  return lzham::lzham_lib_decompress_memory(p, dst, dst_len, src, src_len, adler);
}
}
EOF

mkdir -p "$OUT_DIR"
emcc "${SRCS[@]}" "$SHIM" \
  -O3 \
  -fno-strict-aliasing \
  -DNDEBUG \
  -I"$INC" -I"$DECOMP" \
  -s EXPORTED_FUNCTIONS='["_tm_inflate","_tm_unc_size","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","getValue","UTF8ToString"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=67108864 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME='createTmCompressModule' \
  -s ENVIRONMENT='web,worker,node' \
  -s FILESYSTEM=0 \
  -o "$OUT_DIR/tmcompress.js"

echo "Built: $OUT_DIR/tmcompress.js + tmcompress.wasm"
ls -la "$OUT_DIR/tmcompress.js" "$OUT_DIR/tmcompress.wasm"
