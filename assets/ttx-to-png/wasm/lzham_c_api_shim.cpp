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
