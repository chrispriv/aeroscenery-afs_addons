/**
 * PNG/JPG pixels → plain Aerofly .ttx (compress_file=false).
 *
 * GPU formats: ETC2 (mobile) and DXT1/DXT5 (PC), full mip chain.
 * Container IDs match the Python Generic Decoder encoder.
 * ETC2 uses individual + differential modes (Khronos bit layout).
 * There is no LZHAM compress in the browser build — the page only
 * ships the inflater. Aerofly reads plain TTX (compress_file off).
 */

const TYPE_STRING = hex("626e73bd8c7628a4");
const TYPE_INT32 = hex("a223d13e723446c3");
const TYPE_LIST = hex("9e76560202020202");
const NAME_OUTER = hex("c3e386cb206d5fec");
const NAME_NESTED = hex("ce25086b845bd426");
const NAME_TYPE = hex("7760d7aaef9e7abb");
const NAME_TARGET = hex("3843ed38abf750ef");
const NAME_WIDTH = hex("8d2fb0411a10b566");
const NAME_HEIGHT = hex("c6ef1dc0d6753c0b");
const NAME_LAYERS = hex("9e6f762f839d2bf2");
const NAME_MIPS = hex("51af1172e6fd50f9");
const NAME_PIXELS = hex("7fc676a557237c3d");
const MAGIC_PLAIN = hex("a697e9acf9fcc17c");

/** Modifier by the 2-bit pixel code (MSB,LSB): 00 +a, 01 +b, 10 −a, 11 −b. */
const ETC_MOD = [
  [2, 8, -2, -8],
  [5, 17, -5, -17],
  [9, 29, -9, -29],
  [13, 42, -13, -42],
  [18, 60, -18, -60],
  [24, 80, -24, -80],
  [33, 106, -33, -106],
  [47, 183, -47, -183],
];

/** EAC unsigned modifier tables, index 0..7 left to right (Khronos). */
const EAC_MOD = [
  [-3, -6, -9, -15, 2, 5, 8, 14],
  [-3, -7, -10, -13, 2, 6, 9, 12],
  [-2, -5, -8, -13, 1, 4, 7, 12],
  [-2, -4, -6, -13, 1, 3, 5, 12],
  [-3, -6, -8, -12, 2, 5, 7, 11],
  [-3, -7, -9, -11, 2, 6, 8, 10],
  [-4, -7, -8, -11, 3, 6, 7, 10],
  [-3, -5, -8, -11, 2, 4, 7, 10],
  [-2, -6, -8, -10, 1, 5, 7, 9],
  [-2, -5, -8, -10, 1, 4, 7, 9],
  [-2, -4, -8, -10, 1, 3, 7, 9],
  [-2, -5, -7, -10, 1, 4, 6, 9],
  [-3, -4, -7, -10, 2, 3, 6, 9],
  [-1, -2, -3, -10, 0, 1, 2, 9],
  [-4, -6, -8, -9, 3, 5, 7, 8],
  [-3, -5, -7, -9, 2, 4, 6, 8],
];

/** [flip 0|1][subblock 0|1] → Uint8Array of (x, y, letter) triples. Letter = x*4+y. */
const SUB_PAIRS = buildSubPairs();

const OPAQUE_ETC = "type_rgb_etc2";
const ALPHA_ETC = "type_rgba_etc2";
const OPAQUE_DXT = "type_rgb_s3tc_dxt1";
const ALPHA_DXT = "type_rgba_s3tc_dxt5";

function hex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

function buildSubPairs() {
  const out = [
    [null, null],
    [null, null],
  ];
  for (let sub = 0; sub < 2; sub++) {
    const side = [];
    for (let x = sub * 2; x < sub * 2 + 2; x++) {
      for (let y = 0; y < 4; y++) side.push(x, y, x * 4 + y);
    }
    out[0][sub] = Uint8Array.from(side);
    const stack = [];
    for (let y = sub * 2; y < sub * 2 + 2; y++) {
      for (let x = 0; x < 4; x++) stack.push(x, y, x * 4 + y);
    }
    out[1][sub] = Uint8Array.from(stack);
  }
  return out;
}

function isPo2(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

export function hasUsefulAlpha(rgba) {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 255) return true;
  }
  return false;
}

function selectFormat(opts, rgba) {
  const alpha = hasUsefulAlpha(rgba);
  let fmt = opts.format || "";
  if (!fmt) {
    const family = opts.family || "etc2";
    if (family === "dxt" || family === "dxt1") fmt = alpha ? ALPHA_DXT : OPAQUE_DXT;
    else if (family === "etc2") fmt = alpha ? ALPHA_ETC : OPAQUE_ETC;
    else throw new Error(`unsupported encode format: ${family}`);
  } else if (fmt === OPAQUE_ETC && alpha) {
    fmt = ALPHA_ETC;
  }
  if (fmt !== OPAQUE_ETC && fmt !== ALPHA_ETC && fmt !== OPAQUE_DXT && fmt !== ALPHA_DXT) {
    throw new Error(`unsupported output format: ${fmt}`);
  }
  return fmt;
}

function flipCopy(rgba, w, h) {
  const out = new Uint8Array(rgba.length);
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    out.set(rgba.subarray(y * row, y * row + row), (h - 1 - y) * row);
  }
  return out;
}

function downsampleBox(rgba, w, h) {
  const nw = Math.max(1, w >> 1);
  const nh = Math.max(1, h >> 1);
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.min(h - 1, y * 2);
    const y1 = Math.min(h - 1, y0 + 1);
    for (let x = 0; x < nw; x++) {
      const x0 = Math.min(w - 1, x * 2);
      const x1 = Math.min(w - 1, x0 + 1);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const offs = [y0 * w + x0, y0 * w + x1, y1 * w + x0, y1 * w + x1];
      for (let k = 0; k < 4; k++) {
        const i = offs[k] * 4;
        r += rgba[i];
        g += rgba[i + 1];
        b += rgba[i + 2];
        a += rgba[i + 3];
      }
      const o = (y * nw + x) * 4;
      out[o] = (r + 2) >> 2;
      out[o + 1] = (g + 2) >> 2;
      out[o + 2] = (b + 2) >> 2;
      out[o + 3] = (a + 2) >> 2;
    }
  }
  return out;
}

function mipPlan(w, h, lastMax) {
  const levels = [];
  let cw = w;
  let ch = h;
  for (;;) {
    levels.push([cw, ch]);
    if (Math.max(cw, ch) <= lastMax) break;
    cw = Math.max(1, cw >> 1);
    ch = Math.max(1, ch >> 1);
  }
  return levels;
}

function blockBytes(fmt, w, h) {
  const bw = (w + 3) >> 2;
  const bh = (h + 3) >> 2;
  const bpp = fmt === OPAQUE_ETC || fmt === OPAQUE_DXT ? 8 : 16;
  return bw * bh * bpp;
}

function q4(c) {
  let q = Math.round(c / 17);
  if (q < 0) q = 0;
  else if (q > 15) q = 15;
  return q;
}

function q5(c) {
  let q = Math.round((c * 31) / 255);
  if (q < 0) q = 0;
  else if (q > 31) q = 31;
  return q;
}

function e4(q) {
  return (q << 4) | q;
}

function e5(q) {
  return (q << 3) | (q >> 2);
}

function writeBE64(out, offset, word) {
  for (let i = 0; i < 8; i++) {
    out[offset + i] = Number((word >> BigInt(56 - 8 * i)) & 0xffn);
  }
}

function sample3(rgba, w, h, x, y) {
  if (x >= w) x = w - 1;
  if (y >= h) y = h - 1;
  const i = (y * w + x) * 4;
  return [rgba[i], rgba[i + 1], rgba[i + 2], i];
}

function subMean(rgba, w, h, bx, by, pairs) {
  let r = 0;
  let g = 0;
  let b = 0;
  const ox = bx * 4;
  const oy = by * 4;
  for (let p = 0; p < 8; p++) {
    const s = sample3(rgba, w, h, ox + pairs[p * 3], oy + pairs[p * 3 + 1]);
    r += s[0];
    g += s[1];
    b += s[2];
  }
  return [r / 8, g / 8, b / 8];
}

function paintError(rgba, w, h, bx, by, pairs, base, table, codes) {
  const mods = ETC_MOD[table];
  const br = base[0];
  const bg = base[1];
  const bb = base[2];
  const ox = bx * 4;
  const oy = by * 4;
  let err = 0;
  for (let p = 0; p < 8; p++) {
    const letter = pairs[p * 3 + 2];
    const s = sample3(rgba, w, h, ox + pairs[p * 3], oy + pairs[p * 3 + 1]);
    let bestC = 0;
    let bestD = 0x7fffffff;
    for (let c = 0; c < 4; c++) {
      const m = mods[c];
      let r = br + m;
      let g = bg + m;
      let b = bb + m;
      if (r < 0) r = 0;
      else if (r > 255) r = 255;
      if (g < 0) g = 0;
      else if (g > 255) g = 255;
      if (b < 0) b = 0;
      else if (b > 255) b = 255;
      const dr = r - s[0];
      const dg = g - s[1];
      const db = b - s[2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        bestC = c;
      }
    }
    if (codes) codes[letter] = bestC;
    err += bestD;
  }
  return err;
}

function bestIndividual(rgba, w, h, bx, by, pairs, codes) {
  const mean = subMean(rgba, w, h, bx, by, pairs);
  const q = [q4(mean[0]), q4(mean[1]), q4(mean[2])];
  let bestErr = 0x7fffffff;
  let bestTable = 0;
  let bestBase = [0, 0, 0];
  const trial = new Uint8Array(16);
  for (let t = 0; t < 8; t++) {
    for (let step = 0; step < 3; step++) {
      const d = step === 0 ? 0 : step === 1 ? -1 : 1;
      const base = [
        e4(Math.max(0, Math.min(15, q[0] + d))),
        e4(Math.max(0, Math.min(15, q[1] + d))),
        e4(Math.max(0, Math.min(15, q[2] + d))),
      ];
      const err = paintError(rgba, w, h, bx, by, pairs, base, t, trial);
      if (err < bestErr) {
        bestErr = err;
        bestTable = t;
        bestBase = base;
        codes.set(trial);
      }
    }
  }
  return { err: bestErr, table: bestTable, base: bestBase };
}

function scoreFixed(rgba, w, h, bx, by, pairs, base, codes) {
  let bestErr = 0x7fffffff;
  let bestTable = 0;
  const trial = new Uint8Array(16);
  for (let t = 0; t < 8; t++) {
    const err = paintError(rgba, w, h, bx, by, pairs, base, t, trial);
    if (err < bestErr) {
      bestErr = err;
      bestTable = t;
      codes.set(trial);
    }
  }
  return { err: bestErr, table: bestTable };
}

function mergeLetters(dest, pairs, src) {
  for (let p = 0; p < 8; p++) {
    const letter = pairs[p * 3 + 2];
    dest[letter] = src[letter];
  }
}

function encodeEtc2Block(rgba, w, h, bx, by) {
  let bestErr = 0x7fffffff;
  let best = null;
  const codes = new Uint8Array(16);
  const scratch = new Uint8Array(16);

  for (let flip = 0; flip < 2; flip++) {
    const p0 = SUB_PAIRS[flip][0];
    const p1 = SUB_PAIRS[flip][1];
    const c0 = new Uint8Array(16);
    const c1 = new Uint8Array(16);
    const ind0 = bestIndividual(rgba, w, h, bx, by, p0, c0);
    const ind1 = bestIndividual(rgba, w, h, bx, by, p1, c1);
    const indErr = ind0.err + ind1.err;
    if (indErr < bestErr) {
      bestErr = indErr;
      codes.set(c0);
      mergeLetters(codes, p1, c1);
      best = {
        diff: 0,
        flip,
        c0q: [q4(ind0.base[0]), q4(ind0.base[1]), q4(ind0.base[2])],
        c1q: [q4(ind1.base[0]), q4(ind1.base[1]), q4(ind1.base[2])],
        t0: ind0.table,
        t1: ind1.table,
        codes: codes.slice(),
      };
    }

    const m0 = subMean(rgba, w, h, bx, by, p0);
    const m1 = subMean(rgba, w, h, bx, by, p1);
    const a = [q5(m0[0]), q5(m0[1]), q5(m0[2])];
    const b = [q5(m1[0]), q5(m1[1]), q5(m1[2])];
    const dlt = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    if (dlt[0] >= -4 && dlt[0] <= 3 && dlt[1] >= -4 && dlt[1] <= 3 && dlt[2] >= -4 && dlt[2] <= 3) {
      const base0 = [e5(a[0]), e5(a[1]), e5(a[2])];
      const base1 = [e5(a[0] + dlt[0]), e5(a[1] + dlt[1]), e5(a[2] + dlt[2])];
      const s0 = scoreFixed(rgba, w, h, bx, by, p0, base0, scratch);
      c0.set(scratch);
      const s1 = scoreFixed(rgba, w, h, bx, by, p1, base1, scratch);
      c1.set(scratch);
      const err = s0.err + s1.err;
      if (err < bestErr) {
        bestErr = err;
        codes.set(c0);
        mergeLetters(codes, p1, c1);
        best = {
          diff: 1,
          flip,
          base5: a,
          delta: dlt,
          t0: s0.table,
          t1: s1.table,
          codes: codes.slice(),
        };
      }
    }
  }

  let word = 0n;
  if (!best.diff) {
    const c0 = best.c0q;
    const c1 = best.c1q;
    word |= BigInt(c0[0] & 15) << 60n;
    word |= BigInt(c1[0] & 15) << 56n;
    word |= BigInt(c0[1] & 15) << 52n;
    word |= BigInt(c1[1] & 15) << 48n;
    word |= BigInt(c0[2] & 15) << 44n;
    word |= BigInt(c1[2] & 15) << 40n;
  } else {
    const pack = (base, delta) => ((base & 31) << 3) | (delta & 7);
    word |= BigInt(pack(best.base5[0], best.delta[0])) << 56n;
    word |= BigInt(pack(best.base5[1], best.delta[1])) << 48n;
    word |= BigInt(pack(best.base5[2], best.delta[2])) << 40n;
    word |= 1n << 33n;
  }
  word |= BigInt(best.t0 & 7) << 37n;
  word |= BigInt(best.t1 & 7) << 34n;
  word |= BigInt(best.flip & 1) << 32n;
  const sel = best.codes;
  for (let i = 0; i < 16; i++) {
    const code = BigInt(sel[i] & 3);
    word |= ((code >> 1n) & 1n) << BigInt(16 + i);
    word |= (code & 1n) << BigInt(i);
  }
  const out = new Uint8Array(8);
  writeBE64(out, 0, word);
  return out;
}

function encodeEacBlock(rgba, w, h, bx, by) {
  const alphas = new Uint8Array(16);
  let mn = 255;
  let mx = 0;
  let sum = 0;
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 4; y++) {
      const s = sample3(rgba, w, h, bx * 4 + x, by * 4 + y);
      const a = rgba[s[3] + 3];
      alphas[x * 4 + y] = a;
      if (a < mn) mn = a;
      if (a > mx) mx = a;
      sum += a;
    }
  }
  let base = 0;
  let mult = 1;
  let table = 13;
  const idx = new Uint8Array(16);
  if (mn === mx) {
    base = mn;
    idx.fill(4);
  } else {
    const avg = Math.round(sum / 16);
    const bases = avg === mn || avg === mx ? [avg, mn, mx] : [avg, mn, mx];
    let bestErr = 0x7fffffff;
    const spanHint = Math.max(1, mx - mn);
    for (let bi = 0; bi < bases.length; bi++) {
      const b0 = bases[bi];
      for (let t = 0; t < 16; t++) {
        const mods = EAC_MOD[t];
        let peak = 1;
        for (let k = 0; k < 8; k++) {
          const mag = mods[k] < 0 ? -mods[k] : mods[k];
          if (mag > peak) peak = mag;
        }
        let guess = Math.round(spanHint / (2 * peak));
        if (guess < 1) guess = 1;
        else if (guess > 15) guess = 15;
        for (let mi = -1; mi <= 1; mi++) {
          let m = guess + mi;
          if (m < 1) m = 1;
          else if (m > 15) m = 15;
          let err = 0;
          const trial = new Uint8Array(16);
          let worse = false;
          for (let i = 0; i < 16; i++) {
            let bd = 0x7fffffff;
            let bk = 0;
            const av = alphas[i];
            for (let k = 0; k < 8; k++) {
              let v = b0 + mods[k] * m;
              if (v < 0) v = 0;
              else if (v > 255) v = 255;
              const d = av - v;
              const e = d < 0 ? -d : d;
              if (e < bd) {
                bd = e;
                bk = k;
              }
            }
            trial[i] = bk;
            err += bd;
            if (err >= bestErr) {
              worse = true;
              break;
            }
          }
          if (!worse && err < bestErr) {
            bestErr = err;
            base = b0;
            mult = m;
            table = t;
            idx.set(trial);
          }
        }
      }
    }
  }
  let word = (BigInt(base & 255) << 56n) | (BigInt(mult & 15) << 52n) | (BigInt(table & 15) << 48n);
  for (let i = 0; i < 16; i++) {
    word |= BigInt(idx[i] & 7) << BigInt(45 - 3 * i);
  }
  const out = new Uint8Array(8);
  writeBE64(out, 0, word);
  return out;
}

async function encodeEtc2Level(rgba, w, h, withAlpha, dest, offset, onStatus, label) {
  const bw = (w + 3) >> 2;
  const bh = (h + 3) >> 2;
  const stride = withAlpha ? 16 : 8;
  for (let by = 0; by < bh; by++) {
    if (onStatus && by > 0 && (by & 31) === 0) {
      onStatus(`${label} ${Math.round((by / bh) * 100)}%`);
      await new Promise((r) => setTimeout(r, 0));
    }
    for (let bx = 0; bx < bw; bx++) {
      const rgb = encodeEtc2Block(rgba, w, h, bx, by);
      const at = offset + (by * bw + bx) * stride;
      if (withAlpha) {
        dest.set(encodeEacBlock(rgba, w, h, bx, by), at);
        dest.set(rgb, at + 8);
      } else {
        dest.set(rgb, at);
      }
    }
  }
  return bw * bh * stride;
}

function rgb565(r, g, b) {
  return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
}

function from565(v) {
  return [
    ((((v >> 11) & 31) * 255) / 31) | 0,
    ((((v >> 5) & 63) * 255) / 63) | 0,
    (((v & 31) * 255) / 31) | 0,
  ];
}

function dist3(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function encodeBc1Block(pix, transparent) {
  let i0 = 0;
  let i1 = 1;
  let bestD = -1;
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 16; j++) {
      if (i === j) continue;
      const d = dist3(pix[i], pix[j]);
      if (d > bestD) {
        bestD = d;
        i0 = i;
        i1 = j;
      }
    }
  }
  let c0 = pix[i0];
  let c1 = pix[i1];
  let e0 = rgb565(c0[0], c0[1], c0[2]);
  let e1 = rgb565(c1[0], c1[1], c1[2]);
  if (transparent) {
    if (e0 > e1) {
      const ts = e0;
      e0 = e1;
      e1 = ts;
      const tp = c0;
      c0 = c1;
      c1 = tp;
    }
  } else if (e0 < e1) {
    const ts = e0;
    e0 = e1;
    e1 = ts;
  } else if (e0 === e1) {
    if (e0 < 0xffff) e0 += 1;
    else e1 -= 1;
  }
  const ca = from565(e0);
  const cb = from565(e1);
  let c2;
  let c3;
  if (transparent && e0 <= e1) {
    c2 = [(ca[0] + cb[0]) >> 1, (ca[1] + cb[1]) >> 1, (ca[2] + cb[2]) >> 1];
    c3 = [0, 0, 0];
  } else {
    c2 = [
      ((2 * ca[0] + cb[0]) / 3) | 0,
      ((2 * ca[1] + cb[1]) / 3) | 0,
      ((2 * ca[2] + cb[2]) / 3) | 0,
    ];
    c3 = [
      ((ca[0] + 2 * cb[0]) / 3) | 0,
      ((ca[1] + 2 * cb[1]) / 3) | 0,
      ((ca[2] + 2 * cb[2]) / 3) | 0,
    ];
  }
  const pal = [ca, cb, c2, c3];
  const ib = new Uint8Array(4);
  for (let i = 0; i < 16; i++) {
    let best = 0;
    let bd = 0x7fffffff;
    const p = pix[i];
    if (transparent && e0 <= e1 && p[3] < 128) {
      best = 3;
    } else {
      for (let k = 0; k < 4; k++) {
        const d = dist3(p, pal[k]);
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
    }
    const bit = 2 * i;
    ib[bit >> 3] |= best << (bit & 7);
  }
  const out = new Uint8Array(8);
  out[0] = e0 & 255;
  out[1] = (e0 >> 8) & 255;
  out[2] = e1 & 255;
  out[3] = (e1 >> 8) & 255;
  out[4] = ib[0];
  out[5] = ib[1];
  out[6] = ib[2];
  out[7] = ib[3];
  return out;
}

const ALPHA7 = [6, 5, 4, 3, 2, 1, 0];
const ALPHA5 = [4, 3, 2, 1, 0];

function encodeBc3Block(pix) {
  let a0 = 0;
  let a1 = 255;
  for (let i = 0; i < 16; i++) {
    const a = pix[i][3];
    if (a > a0) a0 = a;
    if (a < a1) a1 = a;
  }
  const out = new Uint8Array(16);
  out.set(encodeBc1Block(pix, false), 8);
  if (a0 === a1) {
    out[0] = a0;
    out[1] = a0;
    return out;
  }
  const pal = [a0, a1];
  if (a0 > a1) {
    for (let m = 0; m < ALPHA7.length; m++) {
      pal.push(((ALPHA7[m] * a0 + (6 - ALPHA7[m]) * a1) / 7) | 0);
    }
  } else {
    for (let m = 0; m < ALPHA5.length; m++) {
      pal.push(((ALPHA5[m] * a0 + (4 - ALPHA5[m]) * a1) / 5) | 0);
    }
    pal.push(0, 255);
  }
  let acc = 0;
  let bits = 0;
  let p = 2;
  for (let i = 0; i < 16; i++) {
    const a = pix[i][3];
    let best = 0;
    let bd = 0x7fffffff;
    for (let k = 0; k < pal.length; k++) {
      const d = a - pal[k];
      const e = d * d;
      if (e < bd) {
        bd = e;
        best = k;
      }
    }
    acc |= (best & 7) << bits;
    bits += 3;
    while (bits >= 8) {
      out[p++] = acc & 255;
      acc >>= 8;
      bits -= 8;
    }
  }
  out[0] = a0;
  out[1] = a1;
  return out;
}

function gatherDxt(rgba, w, h, bx, by) {
  const pix = new Array(16);
  let transparent = false;
  for (let yy = 0; yy < 4; yy++) {
    let y = by * 4 + yy;
    if (y >= h) y = h - 1;
    for (let xx = 0; xx < 4; xx++) {
      let x = bx * 4 + xx;
      if (x >= w) x = w - 1;
      const i = (y * w + x) * 4;
      const px = [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
      pix[yy * 4 + xx] = px;
      if (px[3] < 128) transparent = true;
    }
  }
  return { pix, transparent };
}

async function encodeDxtLevel(rgba, w, h, dxt5, dest, offset, onStatus, label) {
  const bw = (w + 3) >> 2;
  const bh = (h + 3) >> 2;
  const stride = dxt5 ? 16 : 8;
  for (let by = 0; by < bh; by++) {
    if (onStatus && by > 0 && (by & 31) === 0) {
      onStatus(`${label} ${Math.round((by / bh) * 100)}%`);
      await new Promise((r) => setTimeout(r, 0));
    }
    for (let bx = 0; bx < bw; bx++) {
      const g = gatherDxt(rgba, w, h, bx, by);
      const block = dxt5 ? encodeBc3Block(g.pix) : encodeBc1Block(g.pix, g.transparent);
      dest.set(block, offset + (by * bw + bx) * stride);
    }
  }
  return bw * bh * stride;
}

async function encodeChain(rgba, w, h, fmt, onStatus) {
  const etc = fmt === OPAQUE_ETC || fmt === ALPHA_ETC;
  const lastMax = etc ? 4 : 1;
  const levels = mipPlan(w, h, lastMax);
  let total = 0;
  for (let i = 0; i < levels.length; i++) total += blockBytes(fmt, levels[i][0], levels[i][1]);
  const dest = new Uint8Array(total);
  let offset = 0;
  let cur = rgba;
  let cw = w;
  let ch = h;
  for (let li = 0; li < levels.length; li++) {
    if (li > 0) {
      cur = downsampleBox(cur, cw, ch);
      cw = levels[li][0];
      ch = levels[li][1];
    }
    const label = `Encoding ${fmt} mip ${li + 1}/${levels.length} (${cw}×${ch})`;
    if (onStatus) onStatus(`${label}…`);
    if (etc) {
      offset += await encodeEtc2Level(cur, cw, ch, fmt === ALPHA_ETC, dest, offset, onStatus, label);
    } else {
      offset += await encodeDxtLevel(cur, cw, ch, fmt === ALPHA_DXT, dest, offset, onStatus, label);
    }
  }
  return { payload: dest, mips: levels.length };
}

function writeU64(dv, off, v) {
  dv.setUint32(off, v >>> 0, true);
  dv.setUint32(off + 4, Math.floor(v / 4294967296), true);
}

function concat(parts) {
  let n = 0;
  for (let i = 0; i < parts.length; i++) n += parts[i].length;
  const out = new Uint8Array(n);
  let o = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], o);
    o += parts[i].length;
  }
  return out;
}

function typedChunk(type16, payload, size, hs) {
  const sz = size == null ? 32 + payload.length : size;
  const header = hs == null ? sz : hs;
  const out = new Uint8Array(Math.max(sz, header));
  out.set(type16, 0);
  const dv = new DataView(out.buffer);
  writeU64(dv, 16, sz);
  writeU64(dv, 24, header);
  out.set(payload, 32);
  return out;
}

function id16(type8, name8) {
  const out = new Uint8Array(16);
  out.set(type8, 0);
  out.set(name8, 8);
  return out;
}

function strChunk(name, nameId) {
  const raw = new Uint8Array(name.length);
  for (let i = 0; i < name.length; i++) raw[i] = name.charCodeAt(i);
  const inner = (8 + raw.length + 7) & ~7;
  const body = new Uint8Array(inner);
  const dv = new DataView(body.buffer);
  writeU64(dv, 0, raw.length);
  body.set(raw, 8);
  return typedChunk(id16(TYPE_STRING, nameId), body, 32 + inner, 32 + inner);
}

function u32Chunk(value, nameId) {
  const body = new Uint8Array(4);
  new DataView(body.buffer).setUint32(0, value >>> 0, true);
  return typedChunk(id16(TYPE_INT32, nameId), body, 36, 40);
}

function dataChunk(payload, nameId) {
  const size = 32 + payload.length;
  const hs = (size + 7) & ~7;
  return typedChunk(id16(TYPE_LIST, nameId), payload, size, hs);
}

function wrapContainer(magic, nameId, inner) {
  const total = 32 + inner.length;
  const out = new Uint8Array(total);
  out.set(magic, 0);
  out.set(nameId, 8);
  const dv = new DataView(out.buffer);
  writeU64(dv, 16, total);
  writeU64(dv, 24, 32);
  out.set(inner, 32);
  return out;
}

function buildPlain(fmt, w, h, payload, mips) {
  const props = concat([
    strChunk(fmt, NAME_TYPE),
    strChunk("target_2d", NAME_TARGET),
    u32Chunk(w, NAME_WIDTH),
    u32Chunk(h, NAME_HEIGHT),
    u32Chunk(1, NAME_LAYERS),
    u32Chunk(mips, NAME_MIPS),
    dataChunk(payload, NAME_PIXELS),
  ]);
  return wrapContainer(MAGIC_PLAIN, NAME_OUTER, wrapContainer(MAGIC_PLAIN, NAME_NESTED, props));
}

/**
 * @param {Uint8Array} rgba straight RGBA8
 * @param {number} width
 * @param {number} height
 * @param {{ family?: "etc2"|"dxt", format?: string, flip?: boolean, onStatus?: (msg: string) => void }} [opts]
 */
export async function encodeRgbaToTtx(rgba, width, height, opts = {}) {
  if (!width || !height) throw new Error("image has no pixels");
  if (rgba.length < width * height * 4) throw new Error("RGBA buffer is shorter than the image");
  if (width > 16384 || height > 16384) {
    throw new Error("image is larger than 16384 on a side");
  }
  const fmt = selectFormat(opts, rgba);
  const onStatus = opts.onStatus;
  const src = opts.flip ? flipCopy(rgba, width, height) : rgba;
  const { payload, mips } = await encodeChain(src, width, height, fmt, onStatus);
  if (onStatus) onStatus("Building plain TTX…");
  const bytes = buildPlain(fmt, width, height, payload, mips);
  const po2 = isPo2(width) && isPo2(height);
  return {
    bytes,
    width,
    height,
    format: fmt,
    mips,
    compressed: false,
    po2,
    warning: po2
      ? ""
      : `${width}×${height} is not a power of two. Aerofly textures are usually power-of-two (for example 1024×1024 or 1024×512).`,
  };
}

/** Browser: decode a dropped image file to straight RGBA. */
export async function imageFileToRgba(file) {
  if (typeof createImageBitmap !== "function") {
    throw new Error("this browser cannot decode images");
  }
  const bmp = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, bmp.width, bmp.height);
    const rgba = new Uint8Array(data.data.length);
    rgba.set(data.data);
    return { rgba, width: bmp.width, height: bmp.height };
  } finally {
    if (bmp.close) bmp.close();
  }
}
