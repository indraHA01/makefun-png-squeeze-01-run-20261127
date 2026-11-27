// png-squeeze — Squeeze screenshots into the smallest PNG.
//
// Angle: adapt everything to the image in front of us, then squeeze the bytes with our own
// optimal-parsing deflate (a zopfli-style shortest-path parse over hash-chain matches, run in
// pure TypeScript, no dependencies, no network, fully deterministic).
//
// Pipeline per screenshot (1280x720 RGBA, 8 bits a channel):
//   1. Decode the stored PNG to RGBA.
//   2. Analyse: is it grey? opaque? at most 256 colours? one transparent colour value?
//      Pick the cheapest exact form: palette (colour type 3, transparent entries first so
//      tRNS stays short), grey (0), grey+alpha (4), RGB (2) with a tRNS key, or RGBA (6).
//   3. Filter search per row: fixed filters, the minimum-sum and fewest-pairs heuristics, and
//      brute force (each filter trial weighed by a real deflate of the row after its 32 KiB
//      of context). Every candidate form+filter is weighed by a real zlib level-6 stream, so
//      the winner is chosen on bytes, not on a guess.
//   4. Re-encode the winner's filtered bytes with our own optimal-parse deflate; keep whichever
//      of ours or zlib level 9 is smaller (both deterministic, so the two graded runs agree).
//
// Budget: the whole set of 8 runs in one process, 60 s wall on 1 CPU. Effort is chosen from
// the data's size, never from the clock, so both executions write identical bytes.
//
// Node 22 runs this as `node /bot/main.ts` (erasable TypeScript only, built-ins only).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- CRC-32 / Adler-32

const CRC_TABLE: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------------------------------------------------------------- PNG decode (to RGBA)

const PNG_SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

interface Decoded {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function decodePng(bytes: Uint8Array): Decoded {
  if (bytes.length < 8 || PNG_SIG.some((b, i) => bytes[i] !== b)) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header: { width: number; height: number; colourType: number } | null = null;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(type + ' CRC');
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), colourType: data[9] };
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported IHDR');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
    else throw new Error('unexpected chunk ' + type);
  }
  if (!header || !ended || idat.length === 0) throw new Error('truncated PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  if (raw.length !== height * (stride + 1)) throw new Error('bad IDAT length');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else throw new Error('bad filter ' + ft);
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    if (palette === null) throw new Error('palette PNG without PLTE');
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- Analysis + forms

interface Colour {
  r: number;
  g: number;
  b: number;
  a: number;
  key: number;
  count: number;
}

interface Analysis {
  opaque: boolean;
  grey: boolean;
  colours: Colour[] | null; // null when more than 256 colours
}

function analyse(rgba: Uint8Array): Analysis {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const key = (rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3];
      const k = counts.get(key);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(key, 1);
      } else counts.set(key, k + 1);
    }
  }
  let colours: Colour[] | null = null;
  if (!many) {
    colours = [...counts.entries()].map(([key, count]) => ({
      r: (key >>> 24) & 0xff,
      g: (key >>> 16) & 0xff,
      b: (key >>> 8) & 0xff,
      a: key & 0xff,
      key,
      count,
    }));
  }
  return { opaque, grey, colours };
}

// The one fully transparent value (grey or RGB) the image may key by tRNS instead of an
// alpha channel: every pixel opaque or that exact value at alpha 0, and no opaque pixel of
// the same value. Null when there is none.
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

interface PaletteForm {
  plte: Uint8Array;
  trns: Uint8Array | null;
  indices: Uint8Array;
}

// Palette entries: transparent ones first (by alpha, so tRNS stays short), then by `order`:
// 'count' (most used first — repeated indices compress best unfiltered) or 'luminance'
// (neighbouring indices are near in brightness, so Sub/Paeth filters win).
function paletteForm(rgba: Uint8Array, colours: Colour[], order: 'count' | 'luminance'): PaletteForm {
  const lum = (c: Colour): number => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0;
    const tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.key - y.key;
    return y.count - x.count || x.key - y.key;
  });
  const index = new Map<number, number>(entries.map((c, i) => [c.key, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const key = (rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3];
    indices[i] = index.get(key) as number;
  }
  return { plte, trns, indices };
}

type FilterChoice = number | 'minsum' | 'pairs' | 'brute';

interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  filters: FilterChoice[];
}

function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance'] as const) {
      const p = paletteForm(rgba, colours, order);
      forms.push({
        colourType: 3,
        bpp: 1,
        samples: p.indices,
        plte: p.plte,
        trns: p.trns,
        filters: order === 'count' ? [0, 'minsum'] : [0, 'minsum', 'brute'],
      });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct] as number;
  forms.push({
    colourType: ct,
    bpp,
    samples: samplesOf(rgba, ct),
    plte: null,
    trns,
    filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'],
  });
  return forms;
}

// ---------------------------------------------------------------- Filters + screening

function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

function pairsOf(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// Filter every row of `samples` by `choice` into `raw` (height rows of a filter byte + stride).
function filtered(samples: Uint8Array, width: number, height: number, bpp: number, choice: FilterChoice, raw: Uint8Array): Uint8Array {
  const stride = width * bpp;
  const trial = Array.from({ length: 5 }, (_, t) => {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    return row;
  });
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost: number;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else {
        cost = deflateSync(trial[t], before.length === 0 ? { level: BRUTE_LEVEL, memLevel: 9 } : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

const SCREEN = Object.freeze({ level: 6, memLevel: 8 });

interface Screened {
  form: Form;
  choice: FilterChoice;
  data: Uint8Array;
  bytes: number; // zlib stream bytes + PLTE/tRNS chunk overhead
}

const chunkBytes = (form: Form): number =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// Weigh every form + filter choice with a real zlib level-6 stream; keep the smallest.
function screen(rgba: Uint8Array, width: number, height: number): Screened {
  let best: Screened | null = null;
  let spare: Uint8Array | null = null;
  for (const form of formsOf(rgba)) {
    const size = height * (width * form.bpp + 1);
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice, spare !== null && spare.length === size ? spare : new Uint8Array(size));
      spare = null;
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunks;
      if (best === null || bytes < best.bytes) {
        if (best !== null) spare = best.data;
        best = { form, choice, data, bytes };
      } else spare = data;
    }
  }
  return best as Screened;
}

// ---------------------------------------------------------------- Deflate: optimal parse (zopfli-lite)
//
// One stream, split into blocks of at most BLOCK bytes. Per block:
//   a. hash-chain match finding over the whole input (longest match + distance per position);
//   b. a lazy greedy parse gives first symbol frequencies -> first Huffman lengths;
//   c. a shortest-path (dynamic programming) parse over the block with those bit costs,
//      trying, for each match, the longest length of every length code plus the match
//      itself — the length that costs the same bits but covers more input always wins
//      inside one code, so no other length can be optimal;
//   d. rebuild the Huffman tables from the optimal parse's frequencies and write the
//      block with dynamic Huffman codes.
// The result is compared with zlib level 9 and the smaller stream wins, so we never do
// worse than the stock compressor. All choices come from the data; no clock, no randomness.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const MAX_MATCH = 258;
const WINDOW = 32768;
const BLOCK = 500000;
// How far a hash chain is walked looking for a longer match (see deflateOptimal's effort
// choice: deeper chains find longer matches on repetitive screenshots, at CPU cost).
const CHAIN_DEEP = 512;
const CHAIN_FAST = 128;

function lenCodeOf(len: number): number {
  let lo = 0;
  let hi = 28;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (LEN_BASE[mid] <= len) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function distCodeOf(dist: number): number {
  let lo = 0;
  let hi = 29;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= dist) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Candidate match lengths for a longest match of L: the longest length of every length
// code up to L, plus L itself and 3. Precomputed once for every L.
const CANDS: number[][] = (() => {
  const table: number[][] = [];
  for (let l = 3; l <= MAX_MATCH; l++) {
    const set = new Set<number>([3, l]);
    for (let c = 0; c < 29; c++) {
      if (LEN_BASE[c] > l) break;
      const top = Math.min(l, LEN_BASE[c] + (1 << LEN_EXTRA[c]) - 1);
      set.add(top);
    }
    table[l] = [...set].sort((a, b) => a - b);
  }
  return table;
})();

interface Matches {
  len: Int32Array;
  dist: Int32Array;
}

function findMatches(data: Uint8Array, maxChain: number): Matches {
  const n = data.length;
  const len = new Int32Array(n);
  const dist = new Int32Array(n);
  const HASH_BITS = 15;
  const HSIZE = 1 << HASH_BITS;
  const HMASK = HSIZE - 1;
  const head = new Int32Array(HSIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  for (let pos = 0; pos < n; pos++) {
    if (pos + 2 >= n) break;
    const h = (Math.imul((data[pos] << 10) ^ (data[pos + 1] << 5) ^ data[pos + 2], 2654435761) >>> 17) & HMASK;
    let cur = head[h];
    let steps = 0;
    let best = 0;
    let bestD = 0;
    const maxL = Math.min(MAX_MATCH, n - pos);
    while (cur >= 0 && steps < maxChain) {
      steps++;
      const d = pos - cur;
      if (d > WINDOW) break; // chain is in insertion order, so older entries are further still
      if (best > 0) {
        if (pos + best >= n) break;
        // A longer match than `best` must agree at byte `best` (and at `best - 1`); if
        // it does not, this candidate cannot beat `best` — skip the full compare.
        if (data[cur + best] !== data[pos + best] || data[cur + best - 1] !== data[pos + best - 1]) {
          cur = prev[cur];
          continue;
        }
      }
      let l = 0;
      while (l < maxL && data[cur + l] === data[pos + l]) l++;
      if (l > best && l >= 3) {
        best = l;
        bestD = d;
        if (l >= MAX_MATCH) break;
      }
      // A long match already found: a few more candidates are enough.
      if (best >= 32 && steps >= 16) break;
      cur = prev[cur];
    }
    if (best >= 3) {
      len[pos] = best;
      dist[pos] = bestD;
    }
    prev[pos] = head[h];
    head[h] = pos;
  }
  return { len, dist };
}

// ---------------------------------------------------------------- Huffman (length-limited)

// Length-limited Huffman code lengths for `freq` (max `maxBits`): build an unlimited tree,
// clamp the overflow, then repair the Kraft sum back to exactly 1 (see the loop below), so
// the lengths always form a complete prefix code the decoder accepts.
function buildLengths(freq: Uint32Array, maxBits: number): Uint8Array {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const syms: number[] = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) {
    lengths[syms[0]] = 1;
    return lengths;
  }
  // Binary heap of tree nodes, ordered by frequency (ties by node id, deterministic).
  const nodeFreq: number[] = [];
  const nodeSym: number[] = [];
  const nodeLeft: number[] = [];
  const nodeRight: number[] = [];
  const heap: number[] = [];
  const heapPush = (id: number): void => {
    heap.push(id);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (nodeFreq[heap[p]] < nodeFreq[heap[i]] || (nodeFreq[heap[p]] === nodeFreq[heap[i]] && heap[p] < heap[i])) break;
      const t = heap[p];
      heap[p] = heap[i];
      heap[i] = t;
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0];
    const last = heap.pop() as number;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && (nodeFreq[heap[l]] < nodeFreq[heap[m]] || (nodeFreq[heap[l]] === nodeFreq[heap[m]] && heap[l] < heap[m]))) m = l;
        if (r < heap.length && (nodeFreq[heap[r]] < nodeFreq[heap[m]] || (nodeFreq[heap[r]] === nodeFreq[heap[m]] && heap[r] < heap[m]))) m = r;
        if (m === i) break;
        const t = heap[m];
        heap[m] = heap[i];
        heap[i] = t;
        i = m;
      }
    }
    return top;
  };
  for (const s of syms) {
    nodeFreq.push(freq[s]);
    nodeSym.push(s);
    nodeLeft.push(-1);
    nodeRight.push(-1);
    heapPush(nodeFreq.length - 1);
  }
  while (heap.length > 1) {
    const a = heapPop();
    const b = heapPop();
    nodeFreq.push(nodeFreq[a] + nodeFreq[b]);
    nodeSym.push(-1);
    nodeLeft.push(a);
    nodeRight.push(b);
    heapPush(nodeFreq.length - 1);
  }
  const root = heap[0];
  const depth = new Int32Array(nodeFreq.length);
  const stack: number[] = [root];
  while (stack.length > 0) {
    const id = stack.pop() as number;
    if (nodeSym[id] >= 0) {
      lengths[nodeSym[id]] = depth[id];
    } else {
      depth[nodeLeft[id]] = depth[id] + 1;
      depth[nodeRight[id]] = depth[id] + 1;
      stack.push(nodeLeft[id], nodeRight[id]);
    }
  }
  // Clamp lengths over maxBits, then redistribute until the Kraft sum is exactly 1: each
  // step moves one leaf down a level (splitting it into two, Kraft-neutral) and drops one
  // max-length code, lowering the Kraft sum by exactly one unit of 2^-maxBits — never
  // overshooting, so the result is always a complete prefix code the decoder accepts.
  const blCount = new Int32Array(maxBits + 1);
  for (const s of syms) {
    if (lengths[s] > maxBits) lengths[s] = maxBits;
    blCount[lengths[s]]++;
  }
  let kraft = 0;
  for (let b = 1; b <= maxBits; b++) kraft += blCount[b] << (maxBits - b);
  const target = 1 << maxBits;
  while (kraft > target) {
    let bits = maxBits - 1;
    while (bits > 0 && blCount[bits] === 0) bits--;
    if (bits === 0) break; // unreachable while the code is oversubscribed
    blCount[bits]--;
    blCount[bits + 1] += 2;
    blCount[maxBits]--;
    kraft -= 1;
  }
  // Reassign: shortest lengths to the most frequent symbols.
  const ordered = [...syms].sort((a, b) => freq[b] - freq[a] || a - b);
  let k = 0;
  for (let b = 1; b <= maxBits; b++) {
    for (let j = 0; j < blCount[b]; j++) lengths[ordered[k++]] = b;
  }
  return lengths;
}

// Canonical Huffman codes from code lengths (codes are emitted most-significant-bit first).
function canonicalCodes(lengths: Uint8Array): Uint32Array {
  let maxLen = 0;
  for (const l of lengths) if (l > maxLen) maxLen = l;
  const blCount = new Uint32Array(maxLen + 1);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Uint32Array(maxLen + 1);
  let code = 0;
  for (let b = 1; b <= maxLen; b++) {
    code = (code + blCount[b - 1]) << 1;
    nextCode[b] = code;
  }
  const codes = new Uint32Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) if (lengths[i] > 0) codes[i] = nextCode[lengths[i]]++;
  return codes;
}

// ---------------------------------------------------------------- Bit writer

class BitWriter {
  out: number[] = [];
  bitBuf = 0;
  bitCnt = 0;
  writeBits(value: number, count: number): void {
    this.bitBuf |= (value & ((1 << count) - 1)) << this.bitCnt;
    this.bitCnt += count;
    while (this.bitCnt >= 8) {
      this.out.push(this.bitBuf & 0xff);
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }
  writeCode(code: number, len: number): void {
    // Huffman codes go out most-significant-bit first: reverse the bits, then LSB-first.
    let rev = 0;
    for (let i = 0; i < len; i++) {
      rev = (rev << 1) | ((code >> i) & 1);
    }
    this.writeBits(rev, len);
  }
  finish(): Uint8Array {
    if (this.bitCnt > 0) {
      this.out.push(this.bitBuf & 0xff);
      this.bitBuf = 0;
      this.bitCnt = 0;
    }
    return Uint8Array.from(this.out);
  }
}

// ---------------------------------------------------------------- Dynamic block

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Token {
  lit: number; // literal byte, or -1 for a match
  len: number; // match length (0 for a literal)
  dist: number; // match distance (0 for a literal)
}

// RLE-encode the literal/length + distance code lengths into code-length-code symbols.
function rleLengths(lengths: Uint8Array): { sym: number; eb: number; ev: number }[] {
  const out: { sym: number; eb: number; ev: number }[] = [];
  let i = 0;
  while (i < lengths.length) {
    const v = lengths[i];
    if (v === 0) {
      let run = 0;
      while (i + run < lengths.length && lengths[i + run] === 0) run++;
      while (run >= 11) {
        const take = Math.min(run, 138);
        out.push({ sym: 18, eb: 7, ev: take - 11 });
        run -= take;
        i += take;
      }
      if (run >= 3) {
        out.push({ sym: 17, eb: 3, ev: run - 3 });
        i += run;
        run = 0;
      }
      while (run > 0) {
        out.push({ sym: 0, eb: 0, ev: 0 });
        i++;
        run--;
      }
    } else {
      let run = 1;
      while (i + run < lengths.length && lengths[i + run] === v) run++;
      out.push({ sym: v, eb: 0, ev: 0 });
      i++;
      run--;
      while (run >= 3) {
        const take = Math.min(run, 6);
        out.push({ sym: 16, eb: 2, ev: take - 3 });
        run -= take;
        i += take;
      }
      while (run > 0) {
        out.push({ sym: v, eb: 0, ev: 0 });
        i++;
        run--;
      }
    }
  }
  return out;
}

function writeDynamicBlock(bw: BitWriter, tokens: Token[], litLen: Uint8Array, distLen: Uint8Array, isLast: boolean): void {
  bw.writeBits(isLast ? 1 : 0, 1);
  bw.writeBits(2, 2); // dynamic Huffman
  let hlit = 286;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const all = new Uint8Array(hlit + hdist);
  all.set(litLen.subarray(0, hlit), 0);
  all.set(distLen.subarray(0, hdist), hlit);
  const rle = rleLengths(all);
  const clFreq = new Uint32Array(19);
  for (const r of rle) clFreq[r.sym]++;
  const clLen = buildLengths(clFreq, 7);
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  bw.writeBits(hlit - 257, 5);
  bw.writeBits(hdist - 1, 5);
  bw.writeBits(hclen - 4, 4);
  for (let i = 0; i < hclen; i++) bw.writeBits(clLen[CL_ORDER[i]], 3);
  const clCode = canonicalCodes(clLen);
  for (const r of rle) {
    bw.writeCode(clCode[r.sym], clLen[r.sym]);
    if (r.eb > 0) bw.writeBits(r.ev, r.eb);
  }
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  for (const t of tokens) {
    if (t.lit >= 0) {
      bw.writeCode(litCode[t.lit], litLen[t.lit]);
    } else {
      const lc = lenCodeOf(t.len);
      bw.writeCode(litCode[257 + lc], litLen[257 + lc]);
      if (LEN_EXTRA[lc] > 0) bw.writeBits(t.len - LEN_BASE[lc], LEN_EXTRA[lc]);
      const dc = distCodeOf(t.dist);
      bw.writeCode(distCode[dc], distLen[dc]);
      if (DIST_EXTRA[dc] > 0) bw.writeBits(t.dist - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
  bw.writeCode(litCode[256], litLen[256]); // end of block
}

// ---------------------------------------------------------------- Optimal parse of one block

function parseBlock(
  data: Uint8Array,
  base: number,
  blockLen: number,
  matches: Matches,
  litLen: Uint8Array,
  distLen: Uint8Array,
): Token[] {
  // Candidate (length, bit-cost) pairs for every longest-match length, from this block's
  // literal/length code lengths: hoisting the length-code lookup out of the hot loop.
  const candLen: number[][] = [];
  const candCost: number[][] = [];
  for (let l = 3; l <= MAX_MATCH; l++) {
    const ls: number[] = [];
    const cs: number[] = [];
    for (const len of CANDS[l]) {
      const lc = lenCodeOf(len);
      ls.push(len);
      cs.push(litLen[257 + lc] + LEN_EXTRA[lc]);
    }
    candLen[l] = ls;
    candCost[l] = cs;
  }
  const cost = new Float64Array(blockLen + 1).fill(Infinity);
  const chLen = new Int32Array(blockLen + 1); // 0 = literal, else match length
  const chDist = new Int32Array(blockLen + 1);
  cost[0] = 0;
  const distCost: number[] = new Array(32769);
  for (let p = 0; p < blockLen; p++) {
    const c = cost[p];
    if (c === Infinity) continue;
    const b = data[base + p];
    const nl = c + litLen[b];
    if (nl < cost[p + 1]) {
      cost[p + 1] = nl;
      chLen[p + 1] = 0;
    }
    const L = Math.min(matches.len[base + p], blockLen - p);
    if (L >= 3) {
      const D = matches.dist[base + p];
      let dc = distCost[D];
      if (dc === undefined) {
        const code = distCodeOf(D);
        dc = distLen[code] + DIST_EXTRA[code];
        distCost[D] = dc;
      }
      const ls = candLen[L];
      const cs = candCost[L];
      for (let k = 0; k < ls.length; k++) {
        const nc = c + cs[k] + dc;
        const q = p + ls[k];
        if (nc < cost[q]) {
          cost[q] = nc;
          chLen[q] = ls[k];
          chDist[q] = D;
        }
      }
    }
  }
  const tokens: Token[] = [];
  let p = blockLen;
  while (p > 0) {
    const l = chLen[p];
    if (l === 0) {
      tokens.push({ lit: data[base + p - 1], len: 0, dist: 0 });
      p -= 1;
    } else {
      tokens.push({ lit: -1, len: l, dist: chDist[p] });
      p -= l;
    }
  }
  tokens.reverse();
  return tokens;
}

// Lazy greedy parse (for first-pass frequencies): at each position take the match unless
// the next position's match is longer, in which case emit one literal first.
function lazyParse(data: Uint8Array, base: number, blockLen: number, matches: Matches): Token[] {
  const tokens: Token[] = [];
  let p = 0;
  while (p < blockLen) {
    const L = Math.min(matches.len[base + p], blockLen - p);
    if (L < 3) {
      tokens.push({ lit: data[base + p], len: 0, dist: 0 });
      p++;
      continue;
    }
    const next = p + 1 < blockLen ? Math.min(matches.len[base + p + 1], blockLen - p - 1) : 0;
    if (next > L) {
      tokens.push({ lit: data[base + p], len: 0, dist: 0 });
      p++;
      continue;
    }
    tokens.push({ lit: -1, len: L, dist: matches.dist[base + p] });
    p += L;
  }
  return tokens;
}

function tokenFreqs(tokens: Token[], smooth: boolean): { lit: Uint32Array; dist: Uint32Array } {
  const lit = new Uint32Array(288);
  const dist = new Uint32Array(30);
  for (const t of tokens) {
    if (t.lit >= 0) lit[t.lit]++;
    else {
      lit[257 + lenCodeOf(t.len)]++;
      dist[distCodeOf(t.dist)]++;
    }
  }
  lit[256]++; // end of block
  if (smooth) {
    // Every symbol gets a code: the optimal parse may emit a literal or a match length
    // the previous parse never used, and a code of length 0 there would make the cost
    // model wrong (and the stream unreadable). Only the cost tables are smoothed; the
    // table the stream is written with counts the parse's own tokens, so it stays tight.
    for (let i = 0; i < 286; i++) lit[i]++;
    for (let d = 0; d < 30; d++) dist[d]++;
  }
  return { lit, dist };
}

// Our own deflate stream of `data` (raw filtered bytes): one zlib stream, dynamic blocks.
// `iters` optimal-parse passes per block (each re-derives the bit costs from the previous
// parse, zopfli-style); `maxChain` bounds the match search.
function deflateOptimal(data: Uint8Array, maxChain: number, iters: number): Uint8Array {
  const matches = findMatches(data, maxChain);
  const bw = new BitWriter();
  for (let base = 0; base < data.length; base += BLOCK) {
    const blockLen = Math.min(BLOCK, data.length - base);
    const isLast = base + blockLen >= data.length;
    const first = lazyParse(data, base, blockLen, matches);
    const f1 = tokenFreqs(first, true);
    const litLen1 = buildLengths(f1.lit, 15);
    const distLen1 = buildLengths(f1.dist, 15);
    if (distLen1.every((v) => v === 0)) distLen1[0] = 1;
    let tokens = parseBlock(data, base, blockLen, matches, litLen1, distLen1);
    for (let it = 1; it < iters; it++) {
      const fi = tokenFreqs(tokens, true);
      const li = buildLengths(fi.lit, 15);
      const di = buildLengths(fi.dist, 15);
      if (di.every((v) => v === 0)) di[0] = 1;
      tokens = parseBlock(data, base, blockLen, matches, li, di);
    }
    const f2 = tokenFreqs(tokens, false);
    const litLen = buildLengths(f2.lit, 15);
    const distLen = buildLengths(f2.dist, 15);
    if (distLen.every((v) => v === 0)) distLen[0] = 1;
    writeDynamicBlock(bw, tokens, litLen, distLen, isLast);
  }
  const deflated = bw.finish();
  const out = new Uint8Array(deflated.length + 6);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(deflated, 2);
  new DataView(out.buffer).setUint32(out.length - 4, adler32(data));
  return out;
}

// ---------------------------------------------------------------- PNG writer

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function pngOfForm(width: number, height: number, form: Form, idat: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = form.colourType;
  const parts: Uint8Array[] = [PNG_SIG, chunk('IHDR', ihdr)];
  if (form.plte !== null) parts.push(chunk('PLTE', form.plte));
  if (form.trns !== null) parts.push(chunk('tRNS', form.trns));
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- Main

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Screen every instance first: the effort the deflate may spend is chosen from the total
// filtered bytes of the set (a function of the data, never of the clock), so a set much
// larger than this one's still finishes inside the wall, and both graded runs agree.
const ids = readdirSync(I).sort();
const winners: { id: string; img: Decoded; best: Screened }[] = [];
let total = 0;
for (const id of ids) {
  const img = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  const best = screen(img.rgba, img.width, img.height);
  total += best.data.length;
  winners.push({ id, img, best });
}
const deep = total <= 20000000;
const maxChain = deep ? CHAIN_DEEP : CHAIN_FAST;
const iters = deep ? 2 : 1;
for (const { id, img, best } of winners) {
  const mine = deflateOptimal(best.data, maxChain, iters);
  const z9 = deflateSync(best.data, { level: 9, memLevel: 9 });
  const stream = mine.length <= z9.length ? mine : new Uint8Array(z9.buffer, z9.byteOffset, z9.length);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), pngOfForm(img.width, img.height, best.form, stream));
}
