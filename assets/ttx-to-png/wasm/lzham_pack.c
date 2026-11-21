/* Raw LZHAM compress for Aerofly compress_file containers.
 *
 * IPACS settings (byte-identical to shipping .tsb when the plain blob matches):
 *   dict_size_log2 = 21, table_update_rate = 20, level = DEFAULT, no helper threads.
 * The 2-byte zlib header 6E CD is added by the JS wrapper, not here.
 *
 * Returns the raw byte count, or a negative lzham status.
 */
#include <stdint.h>
#include <string.h>
#include "lzham.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define KEEP EMSCRIPTEN_KEEPALIVE
#else
#define KEEP
#endif

KEEP int tm_lzham_compress(const uint8_t *in, int in_len, uint8_t *out, int out_cap) {
  if (!in || !out || in_len <= 0 || out_cap <= 0)
    return -1;
  lzham_compress_params params;
  memset(&params, 0, sizeof(params));
  params.m_struct_size = sizeof(params);
  params.m_dict_size_log2 = 21;
  params.m_level = LZHAM_COMP_LEVEL_DEFAULT;
  params.m_table_update_rate = 20;
  params.m_max_helper_threads = 0;
  size_t dst_len = (size_t)out_cap;
  lzham_compress_status_t st =
      lzham_compress_memory(&params, out, &dst_len, in, (size_t)in_len, 0);
  if (st != LZHAM_COMP_STATUS_SUCCESS)
    return -((int)st);
  if (dst_len > 0x7fffffff)
    return -2;
  return (int)dst_len;
}
