/**
 * Aerofly FS .toc cultivation / xref decode + encode (browser).
 * Same typed-chunk + optional tmcompress wrapper as TTX/TSB.
 * Text syntax matches official write_text_format (see docs/TOC_FORMAT.md).
 */

const MAGIC_COMPRESSED = [0xb5, 0xfe, 0x24, 0xc7, 0xb7, 0x3c, 0xeb, 0xb7];
const MAGIC_TOC = [0xcd, 0x7d, 0x1c, 0x0b, 0x54, 0xde, 0x0f, 0xe1];

const TYPE_STRING = [0x9d, 0xdb, 0x2d, 0x4b, 0x68, 0xac, 0xd1, 0xbd];
const TYPE_V3 = [0x25, 0x34, 0xc2, 0xa4, 0xd3, 0xa2, 0x43, 0xa3];
const TYPE_LIST = [0x78, 0xae, 0xac, 0xe3, 0xb8, 0x01, 0xb4, 0x27];

/** Full 16-byte type IDs for encode (from lgpa.toc). */
const T = {
  FILE: hex("cd7d1c0b54de0fe1ce25086b845bd426"),
  STR_COORD: hex("9ddb2d4b68acd1bd2f24ca5bbfe26a50"),
  STR_NAME: hex("9ddb2d4b68acd1bdb2c467f2ffb9b6af"),
  STR_EMPTY: hex("626e73bd8c7628a4bdfd34448f4a8462"),
  LIST_PLANT: hex("b6f5cc06b0a9b8e76db07fa315465af5"),
  PLANT_COLL: hex("c47c12caecd4649380e1ec50fa43a0df"),
  NUM_PLANTS: hex("9e8caf8498703ec2da4f266dd7735a03"),
  PLANTS_RAW: hex("9e76560202020202b5164ad60afe5393"),
  LIST_PLANT_COLL: hex("d55cd8b90bca2a41c47c12caecd46493"),
  BLDG_SHAPED: hex("37960a340145c815c63f3e35762838b8"),
  BLDG_COMPLEX: hex("0a6bb5661b495113f1afc47b82c20cf9"),
  LIGHT: hex("7dfad1648a1e893ac8e35654480e42e8"),
  LIGHTC: hex("084114b127e472a1333b656444efa2d6"),
  AIRPORT_LIGHT: hex("e53d275fd51da7c490e6b963d60696f0"),
  GENERIC: hex("f4da3a2789d772461f49922060fe8109"),
  POWER: hex("6338b8e60f24018332b0f10b05f03b54"),
  LIST: hex("78aeace3b801b427e357aad55fe38af2"),
  V3: hex("2534c2a4d3a243a3bed200473f1ac70a"),
  DIR: hex("087f64a075aceab8de03d8826e7a61bb"),
  SCALE: hex("087f64a075aceab807f971be3c3b6ac7"),
};

function hex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function magicEq(bytes, magic) {
  for (let i = 0; i < 8; i++) if (bytes[i] !== magic[i]) return false;
  return true;
}

function prefixEq(bytes, off, prefix) {
  for (let i = 0; i < 8; i++) if (bytes[off + i] !== prefix[i]) return false;
  return true;
}

export function isFileCompressed(data) {
  return magicEq(data, MAGIC_COMPRESSED);
}

export function isPlainToc(data) {
  return magicEq(data, MAGIC_TOC);
}

function u64(dv, off) {
  const lo = dv.getUint32(off, true);
  const hi = dv.getUint32(off + 4, true);
  if (hi !== 0) return hi * 0x100000000 + lo;
  return lo;
}

function writeU64(dv, off, n) {
  dv.setUint32(off, n >>> 0, true);
  dv.setUint32(off + 4, Math.floor(n / 0x100000000), true);
}

function f32(dv, off) {
  return dv.getFloat32(off, true);
}

function f64(dv, off) {
  return dv.getFloat64(off, true);
}

function align8(n) {
  return (n + 7) & ~7;
}

export function fmtTmNumber(x, isF32 = false) {
  if (isF32) {
    const buf = new ArrayBuffer(4);
    const dv = new DataView(buf);
    dv.setFloat32(0, x, true);
    x = dv.getFloat32(0, true);
  }
  if (Number.isFinite(x) && Math.floor(x) === x && Math.abs(x) < 1e15) {
    return String(Math.trunc(x));
  }
  let s = x.toFixed(12);
  s = s.replace(/\.?0+$/, "");
  return s;
}

function readStringAt(data, off) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (off + 32 > data.length || !prefixEq(data, off, TYPE_STRING)) return null;
  const size = u64(dv, off + 16);
  const hs = u64(dv, off + 24);
  if (size < 40 || size !== hs || off + size > data.length) return null;
  const n = u64(dv, off + 32);
  if (n < 0 || n > 512 || 40 + n > size) return null;
  let text = "";
  for (let i = 0; i < n; i++) text += String.fromCharCode(data[off + 40 + i]);
  return { text, next: off + size };
}

function readV3At(data, off) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (off + 56 > data.length || !prefixEq(data, off, TYPE_V3)) return null;
  const size = u64(dv, off + 16);
  const hs = u64(dv, off + 24);
  if (size !== 56 || hs !== 56) return null;
  return {
    lon: f64(dv, off + 32),
    lat: f64(dv, off + 40),
    alt: f64(dv, off + 48),
    next: off + 56,
  };
}

function readF32Prop(data, off) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (off + 40 > data.length) return null;
  const size = u64(dv, off + 16);
  const hs = u64(dv, off + 24);
  if (size !== 36 || hs !== 40) return null;
  return { value: f32(dv, off + 32), next: off + 40 };
}

function parsePlacementBlock(data, start, end) {
  let off = start;
  let name = null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  while (off + 32 <= end) {
    const got = readStringAt(data, off);
    if (got) {
      name = got.text;
      off = got.next;
      break;
    }
    const size = u64(dv, off + 16);
    const hs = u64(dv, off + 24);
    const step = size === 36 && hs === 40 ? 40 : size;
    if (step < 32 || off + step > end) break;
    off += step;
  }
  if (!name) return null;
  const v3 = readV3At(data, off);
  if (!v3) return { name };
  off = v3.next;
  let direction = null;
  let scale_factor = null;
  const v1 = readF32Prop(data, off);
  if (v1) {
    direction = v1.value;
    off = v1.next;
    const v2 = readF32Prop(data, off);
    if (v2) scale_factor = v2.value;
  }
  const out = {
    name,
    longitude: v3.lon,
    latitude: v3.lat,
    altitude: v3.alt,
  };
  if (direction != null) out.direction = direction;
  if (scale_factor != null) out.scale_factor = scale_factor;
  return out;
}

function walkListPlacements(data, listOff) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const size = u64(dv, listOff + 16);
  const end = listOff + size;
  let off = listOff + 32;
  const placements = [];
  while (off + 32 <= end) {
    const csize = u64(dv, off + 16);
    const hs = u64(dv, off + 24);
    if (csize < 32 || off + csize > end) break;
    if (prefixEq(data, off, TYPE_LIST) && hs === 32) {
      const block = parsePlacementBlock(data, off + 32, off + csize);
      if (block) placements.push(block);
      off += csize;
      continue;
    }
    const block = parsePlacementBlock(data, off, off + csize);
    if (block && "longitude" in block) {
      placements.push(block);
      off += csize;
      continue;
    }
    off += csize === 36 && hs === 40 ? 40 : csize;
  }
  return placements;
}

function findCoordinateSystem(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = 0;
  while (off + 32 <= data.length) {
    const size = u64(dv, off + 16);
    const hs = u64(dv, off + 24);
    if (hs === 32 && (size === data.length - off || size === data.length)) {
      off += 32;
      continue;
    }
    break;
  }
  const end = Math.min(data.length, off + 0x200);
  while (off + 48 <= end) {
    const got = readStringAt(data, off);
    if (got) return got.text;
    const size = u64(dv, off + 16);
    const hs = u64(dv, off + 24);
    const step = size === 36 && hs === 40 ? 40 : size;
    if (step < 32) break;
    off += step;
  }
  return null;
}

/**
 * Parse inflated / plain TOC bytes.
 * @returns {{ kind: 'toc', variant: string, compressed: boolean, coordinate_system: string, xref_list?: object[], placement_count: number, inflated_bytes: number }}
 */
export function parseToc(data, compressed = false) {
  if (!isPlainToc(data)) {
    throw new Error(`not a TOC container (magic ${[...data.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("")})`);
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const coordinate_system = findCoordinateSystem(data) || "lonlat";
  let placements = [];

  for (let i = 0; i + 32 <= data.length; i++) {
    if (prefixEq(data, i, TYPE_LIST) && u64(dv, i + 24) === 32) {
      const size = u64(dv, i + 16);
      if (size > 200) {
        placements = walkListPlacements(data, i);
        if (placements.length) break;
      }
    }
  }

  if (!placements.length) {
    let i = 0;
    while (i + 48 <= data.length) {
      const got = readStringAt(data, i);
      if (!got) {
        i++;
        continue;
      }
      if (got.text === "lonlat") {
        i = got.next;
        continue;
      }
      const v3 = readV3At(data, got.next);
      if (!v3) {
        i = got.next;
        continue;
      }
      let off = v3.next;
      let direction = null;
      let scale_factor = null;
      const v1 = readF32Prop(data, off);
      if (v1) {
        direction = v1.value;
        off = v1.next;
        const v2 = readF32Prop(data, off);
        if (v2) {
          scale_factor = v2.value;
          off = v2.next;
        }
      }
      const entry = {
        name: got.text,
        longitude: v3.lon,
        latitude: v3.lat,
        altitude: v3.alt,
      };
      if (direction != null) entry.direction = direction;
      if (scale_factor != null) entry.scale_factor = scale_factor;
      placements.push(entry);
      i = off;
    }
  }

  const result = {
    kind: "toc",
    variant: placements.length ? "cultivation_xref" : "summary_only",
    compressed,
    inflated_bytes: data.length,
    coordinate_system,
    buildings_texture_folder: "",
    placement_count: placements.length,
  };
  if (placements.length) result.xref_list = placements;
  return result;
}

export function emitTocText(doc) {
  if (doc.variant === "summary_only" || !doc.xref_list) {
    throw new Error(
      "this TOC has no xref_list (likely a cultivation tile). Try JSON download for a summary."
    );
  }
  const coord = doc.coordinate_system || "lonlat";
  const folder = doc.buildings_texture_folder || "";
  const lines = [
    "<[file][][]",
    "    <[cultivation][][]",
    `        <[string8u][coordinate_system][${coord}]>`,
    `        <[string8][buildings_texture_folder][${folder}]>`,
    "        <[list_plant][plant_list][]",
    "        >",
    "        <[plant_collections][plant_collection_list][]",
    "            <[uint32][num_plants][0]>",
    "            <[list_uint8][plants_raw_data][]>",
    "            <[list_plant_collection][plant_collections][]",
    "            >",
    "        >",
    "        <[list_building_shaped][building_shaped_list][]",
    "        >",
    "        <[list_building_complex][building_complex_list][]",
    "        >",
    "        <[list_light][light_list][]",
    "        >",
    "        <[list_lightc_group][lightc_group_list][]",
    "        >",
    "        <[list_airport_light][airport_light_list][]",
    "        >",
    "        <[list_generic_object][generic_object_list][]",
    "        >",
    "        <[list_power_line][power_lines][]",
    "        >",
    "        <[list_xref][xref_list][]",
  ];
  doc.xref_list.forEach((obj, i) => {
    const lon = fmtTmNumber(obj.longitude);
    const lat = fmtTmNumber(obj.latitude);
    const alt = fmtTmNumber(obj.altitude ?? 0);
    const direction = fmtTmNumber(obj.direction ?? 0, true);
    const scale = fmtTmNumber(obj.scale_factor ?? obj.scale ?? 1, true);
    lines.push(
      `            <[xref][element][${i}]`,
      `                <[string8u][name][${obj.name}]>`,
      `                <[vector3_float64][position][${lon} ${lat} ${alt}]>`,
      `                <[float32][direction][${direction}]>`,
      `                <[float32][scale_factor][${scale}]>`,
      "            >"
    );
  });
  lines.push("        >", "    >", ">", "");
  return lines.join("\n");
}

// --- encode ------------------------------------------------------------------

function concatBytes(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function chunk(type16, payload, size = null, hs = null) {
  const sz = size == null ? 32 + payload.length : size;
  const headerSize = hs == null ? sz : hs;
  const out = new Uint8Array(32 + payload.length);
  out.set(type16, 0);
  const dv = new DataView(out.buffer);
  writeU64(dv, 16, sz);
  writeU64(dv, 24, headerSize);
  out.set(payload, 32);
  return out;
}

function stringChunk(type16, s) {
  const enc = new TextEncoder().encode(s);
  const bodyLen = align8(8 + enc.length);
  const body = new Uint8Array(bodyLen);
  const dv = new DataView(body.buffer);
  writeU64(dv, 0, enc.length);
  body.set(enc, 8);
  return chunk(type16, body);
}

function emptyString(type16) {
  const body = new Uint8Array(8);
  return chunk(type16, body, 40, 40);
}

function emptyList(type16) {
  return chunk(type16, new Uint8Array(0), 32, 32);
}

function f32Prop(type16, v) {
  const out = new Uint8Array(40);
  out.set(type16, 0);
  const dv = new DataView(out.buffer);
  writeU64(dv, 16, 36);
  writeU64(dv, 24, 40);
  dv.setFloat32(32, v, true);
  return out;
}

function v3f64(type16, x, y, z) {
  const body = new Uint8Array(24);
  const dv = new DataView(body.buffer);
  dv.setFloat64(0, x, true);
  dv.setFloat64(8, y, true);
  dv.setFloat64(16, z, true);
  return chunk(type16, body, 56, 56);
}

function u32Prop(type16, v) {
  const out = new Uint8Array(40);
  out.set(type16, 0);
  const dv = new DataView(out.buffer);
  writeU64(dv, 16, 36);
  writeU64(dv, 24, 40);
  dv.setUint32(32, v, true);
  return out;
}

export function buildTocBinary(doc) {
  const xrefs = doc.xref_list;
  if (!xrefs || !xrefs.length) {
    throw new Error("encode requires xref_list");
  }
  const coord = doc.coordinate_system || "lonlat";
  const children = [];
  for (const obj of xrefs) {
    const body = concatBytes([
      stringChunk(T.STR_NAME, obj.name),
      v3f64(T.V3, obj.longitude, obj.latitude, obj.altitude ?? 0),
      f32Prop(T.DIR, obj.direction ?? obj.heading ?? 0),
      f32Prop(T.SCALE, obj.scale_factor ?? obj.scale ?? 1),
    ]);
    children.push(chunk(T.LIST, body, 32 + body.length, 32));
  }
  const xrefChildren = concatBytes(children);
  const xrefList = chunk(T.LIST, xrefChildren, 32 + xrefChildren.length, 32);
  const plantBody = concatBytes([
    u32Prop(T.NUM_PLANTS, 0),
    emptyList(T.PLANTS_RAW),
    emptyList(T.LIST_PLANT_COLL),
  ]);
  const plantColl = chunk(T.PLANT_COLL, plantBody, 32 + plantBody.length, 32);
  const cultBody = concatBytes([
    stringChunk(T.STR_COORD, coord),
    emptyString(T.STR_EMPTY),
    emptyList(T.LIST_PLANT),
    plantColl,
    emptyList(T.BLDG_SHAPED),
    emptyList(T.BLDG_COMPLEX),
    emptyList(T.LIGHT),
    emptyList(T.LIGHTC),
    emptyList(T.AIRPORT_LIGHT),
    emptyList(T.GENERIC),
    emptyList(T.POWER),
    xrefList,
  ]);
  return chunk(T.FILE, cultBody, 32 + cultBody.length, 32);
}

const XREF_RE =
  /<\[xref\]\[element\]\[(\d+)\]\s*<\[string8u\]\[name\]\[([^\]]*)\]>\s*<\[vector3_float64\]\[position\]\[([^\]]+)\]>\s*<\[float32\]\[direction\]\[([^\]]+)\]>\s*<\[float32\]\[scale_factor\]\[([^\]]+)\]>\s*>/g;

export function parseTocText(text) {
  const coordM = text.match(/<\[string8u\]\[coordinate_system\]\[([^\]]*)\]>/);
  const folderM = text.match(/<\[string8\]\[buildings_texture_folder\]\[([^\]]*)\]>/);
  const xrefs = [];
  let m;
  XREF_RE.lastIndex = 0;
  while ((m = XREF_RE.exec(text))) {
    const parts = m[3].trim().split(/\s+/);
    if (parts.length !== 3) throw new Error(`bad position for ${m[2]}: ${m[3]}`);
    xrefs.push({
      name: m[2],
      longitude: parseFloat(parts[0]),
      latitude: parseFloat(parts[1]),
      altitude: parseFloat(parts[2]),
      direction: parseFloat(m[4]),
      scale_factor: parseFloat(m[5]),
    });
  }
  if (!xrefs.length) throw new Error("no <[xref][element]…> blocks found");
  return {
    kind: "toc",
    variant: "cultivation_xref",
    coordinate_system: coordM ? coordM[1] : "lonlat",
    buildings_texture_folder: folderM ? folderM[1] : "",
    xref_list: xrefs,
    placement_count: xrefs.length,
  };
}

export function docFromJson(raw) {
  if (raw.xref_list) return raw;
  if (raw.placements) {
    return {
      kind: "toc",
      variant: "cultivation_xref",
      coordinate_system: raw.coordinate_system || "lonlat",
      buildings_texture_folder: raw.buildings_texture_folder || "",
      xref_list: raw.placements.map((p) => ({
        name: p.name,
        longitude: p.longitude,
        latitude: p.latitude,
        altitude: p.altitude ?? 0,
        direction: p.direction ?? p.heading ?? 0,
        scale_factor: p.scale_factor ?? p.scale ?? 1,
      })),
      placement_count: raw.placements.length,
    };
  }
  throw new Error("JSON missing xref_list or placements");
}

export function isTocText(name, bytes) {
  if (/\.toc\.txt$/i.test(name) || /\.txt$/i.test(name)) return true;
  // sniff: starts with <[file]
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 32));
  return head.includes("<[file]");
}

export function isTocJson(name, bytes) {
  if (/\.json$/i.test(name)) return true;
  const c = bytes[0];
  return c === 0x7b || c === 0x5b; // { or [
}
