/* tmcompress_wasm.c — browser API for IPACS tmcompress (LZHAM zlib-framed).
 *
 * Exports (EMSCRIPTEN_KEEPALIVE):
 *   int tm_inflate(const uint8_t *in, int in_len, uint8_t *out, int out_cap);
 *     returns bytes written, or negative error code
 *   int tm_unc_size(const uint8_t *in, int in_len);
 *     returns expected uncompressed size from tmcompress header, or -1
 */
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include "lzham.h"

#define TMCOMPRESS_MAGIC 0xA810BEF4u
#define TMCOMPRESS_HDR_SIZE 64

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define KEEP EMSCRIPTEN_KEEPALIVE
#else
#define KEEP
#endif

static uint64_t ru64(const uint8_t *p) {
  uint64_t v;
  memcpy(&v, p, 8);
  return v;
}
static uint32_t ru32(const uint8_t *p) {
  uint32_t v;
  memcpy(&v, p, 4);
  return v;
}

static const uint8_t *find_payload(const uint8_t *data, int len, int *payload_len) {
  if (len < 0x100)
    return NULL;
  int off = 0x40;
  while (off + 32 <= len) {
    uint64_t size = ru64(data + off + 16);
    uint64_t hs = ru64(data + off + 24);
    if (size > 200) {
      if (off + (int)size > len || size < 32)
        return NULL;
      *payload_len = (int)size - 32;
      return data + off + 32;
    }
    int step = (size == 36 && hs == 40) ? 40 : (int)size;
    if (step < 32)
      return NULL;
    off += step;
  }
  return NULL;
}

KEEP int tm_unc_size(const uint8_t *in, int in_len) {
  /* Accept either full TTX or raw tmcompress blob */
  const uint8_t *payload = in;
  int plen = in_len;
  if (in_len >= 8 && in[0] == 0xb5 && in[1] == 0xfe) {
    payload = find_payload(in, in_len, &plen);
    if (!payload)
      return -1;
  }
  if (plen < TMCOMPRESS_HDR_SIZE)
    return -2;
  if (ru32(payload) != TMCOMPRESS_HDR_SIZE || ru32(payload + 4) != TMCOMPRESS_MAGIC)
    return -3;
  uint64_t unc = ru64(payload + 8);
  if (unc == 0 || unc > (1ull << 31))
    return -4;
  return (int)unc;
}

KEEP int tm_inflate(const uint8_t *in, int in_len, uint8_t *out, int out_cap) {
  const uint8_t *payload = in;
  int plen = in_len;
  if (in_len >= 8 && in[0] == 0xb5 && in[1] == 0xfe) {
    payload = find_payload(in, in_len, &plen);
    if (!payload)
      return -1;
  }
  if (plen < TMCOMPRESS_HDR_SIZE)
    return -2;
  uint32_t hdr_size = ru32(payload);
  uint32_t magic = ru32(payload + 4);
  uint64_t unc_size = ru64(payload + 8);
  uint32_t dict_log2 = ru32(payload + 0x30);
  uint32_t table_rate = ru32(payload + 0x34);
  if (hdr_size != TMCOMPRESS_HDR_SIZE || magic != TMCOMPRESS_MAGIC)
    return -3;
  if ((int)unc_size > out_cap || unc_size == 0)
    return -4;

  const uint8_t *stream = payload + TMCOMPRESS_HDR_SIZE;
  size_t stream_len = (size_t)(plen - TMCOMPRESS_HDR_SIZE);
  size_t dst_len = (size_t)unc_size;

  lzham_decompress_params params;
  memset(&params, 0, sizeof(params));
  params.m_struct_size = sizeof(params);
  params.m_dict_size_log2 = dict_log2 ? dict_log2 : 21;
  params.m_table_update_rate = table_rate;
  params.m_decompress_flags =
      LZHAM_DECOMP_FLAG_OUTPUT_UNBUFFERED | LZHAM_DECOMP_FLAG_READ_ZLIB_STREAM;

  lzham_uint32 adler = 0;
  lzham_decompress_status_t st =
      lzham_decompress_memory(&params, out, &dst_len, stream, stream_len, &adler);

  if (st != LZHAM_DECOMP_STATUS_SUCCESS) {
    /* fallbacks */
    static const uint32_t dicts[] = {21, 20, 18, 15, 26};
    static const uint32_t rates[] = {20, 0, 8};
    int ok = 0;
    for (unsigned di = 0; di < sizeof(dicts) / sizeof(dicts[0]) && !ok; di++) {
      for (unsigned ri = 0; ri < sizeof(rates) / sizeof(rates[0]) && !ok; ri++) {
        memset(&params, 0, sizeof(params));
        params.m_struct_size = sizeof(params);
        params.m_dict_size_log2 = dicts[di];
        params.m_table_update_rate = rates[ri];
        params.m_decompress_flags =
            LZHAM_DECOMP_FLAG_OUTPUT_UNBUFFERED | LZHAM_DECOMP_FLAG_READ_ZLIB_STREAM;
        dst_len = (size_t)unc_size;
        st = lzham_decompress_memory(&params, out, &dst_len, stream, stream_len, &adler);
        if (st == LZHAM_DECOMP_STATUS_SUCCESS)
          ok = 1;
      }
    }
    if (!ok)
      return -10 - (int)st;
  }
  return (int)dst_len;
}
