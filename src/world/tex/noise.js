// OPERATION NAPTIME — module TEX — procedural noise library.
//
// Every texture in this game is maths, so this file is the bottom of the stack. Three rules
// govern it:
//
//  1. SEEDED. No Math.random(). Every value comes from an integer hash of the lattice
//     coordinate, so the same (x, y, seed) always returns the same number, in any order, on any
//     machine. That is what makes the art-review screenshots diffable.
//  2. TILEABLE. Almost every texture we generate is applied with RepeatWrapping, so a visible
//     seam is an instant fail. Tiling is done the cheap and exact way: the integer lattice
//     coordinates are wrapped modulo an integer `period` before hashing, so noise(x) === noise(x+period)
//     by construction. fbm keeps tiling because each octave's period scales with its frequency
//     (which is why lacunarity is rounded to an integer). `torus2` is also provided — the classic
//     "evaluate 3D noise on a torus embedded in 3D" trick — for the rare case where you need a
//     seamless field at a non-integer frequency; it costs ~2x and is very slightly anisotropic.
//  3. ALLOCATION-FREE. These run tens of millions of times per boot. No objects are created in
//     any hot function; the multi-value returns (worley, warp) write into module-level scratch
//     records that the caller must read immediately.
//
// Ranges: valueNoise* → [0,1]. gradNoise*/simplex* → about [-1,1]. fbm* keeps its sampler's
// range. ridged*/turbulence* → [0,1].

import { makeRng } from '../../core/rng.js';

const INV_U32 = 2.3283064365386963e-10; // 1 / 2^32

// ───────────────────────────────────────────────────────────────── hashing ──

/** 32-bit integer hash of a 2D lattice cell. Returns a uint32. */
export function hashU(x, y, seed) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** 32-bit integer hash of a 3D lattice cell. Returns a uint32. */
export function hashU3(x, y, z, seed) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x1b873593) ^ Math.imul(seed | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Deterministic float in [0,1) from a 2D lattice cell. */
export const hash2 = (x, y, seed = 0) => hashU(x, y, seed) * INV_U32;
/** Deterministic float in [0,1) from a 3D lattice cell. */
export const hash3 = (x, y, z, seed = 0) => hashU3(x, y, z, seed) * INV_U32;
/** Deterministic float in [0,1) from a single integer. */
export const hash1 = (i, seed = 0) => hashU(i, 0x51ed, seed) * INV_U32;

// ───────────────────────────────────────────────────────────────── helpers ──

/** Positive modulo for lattice wrapping. */
export function wrapi(i, p) {
  i %= p;
  return i < 0 ? i + p : i;
}
/** Clamp to [0,1]. */
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Clamp to [a,b]. */
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/** Linear interpolation. */
export const mix = (a, b, t) => a + (b - a) * t;
/** Hermite smoothstep between two edges. */
export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
  return t * t * (3 - 2 * t);
}
/** Quintic fade curve (C2 continuous) — the Perlin interpolant. */
export const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
/** Fractional part. */
export const fract = (x) => x - Math.floor(x);
/** Signed triangle wave in [-1,1] with period 1. */
export const tri = (x) => Math.abs(fract(x) * 2 - 1) * 2 - 1;

/**
 * Pick a tiling lattice from a desired feature size in pixels.
 *
 * This is the single most common source of seams: writing `valueNoise2(x/3, y/3, size/3)` looks
 * right but `size/3` is not an integer, so the lattice period and the coordinate scale disagree
 * and the right edge does not meet the left. latticeFor rounds the period to an integer FIRST and
 * derives the coordinate scale from it, so coord(size) === period exactly.
 *
 * @param {number} size texture size in pixels
 * @param {number} divisor desired cell size in pixels
 * @returns {[number, number]} [period in cells, coordinate scale to multiply pixel coords by]
 */
export function latticeFor(size, divisor) {
  const p = Math.max(2, Math.round(size / divisor));
  return [p, p / size];
}

// 16 unit gradients, enough directional variety without a permutation table.
const GRAD2 = new Float32Array(32);
for (let i = 0; i < 16; i++) {
  const a = (i / 16) * Math.PI * 2;
  GRAD2[i * 2] = Math.cos(a);
  GRAD2[i * 2 + 1] = Math.sin(a);
}
// The classic 12 edge-midpoint gradients of a cube.
const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

// ─────────────────────────────────────────────────────────── value noise ──

/** Tileable 2D value noise on an integer lattice of `period` cells. → [0,1] */
export function valueNoise2(x, y, period = 256, seed = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const u = fade(x - ix);
  const v = fade(y - iy);
  const x0 = wrapi(ix, period);
  const y0 = wrapi(iy, period);
  const x1 = wrapi(ix + 1, period);
  const y1 = wrapi(iy + 1, period);
  const a = hashU(x0, y0, seed) * INV_U32;
  const b = hashU(x1, y0, seed) * INV_U32;
  const c = hashU(x0, y1, seed) * INV_U32;
  const d = hashU(x1, y1, seed) * INV_U32;
  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

/**
 * Tileable 2D value noise with independent periods per axis. Essential for anisotropic materials
 * (velvet pile, brushed metal, wood grain) where the field must be stretched along one axis and
 * still wrap on both. → [0,1]
 */
export function valueNoise2xy(x, y, px = 256, py = 256, seed = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const u = fade(x - ix);
  const v = fade(y - iy);
  const x0 = wrapi(ix, px);
  const y0 = wrapi(iy, py);
  const x1 = wrapi(ix + 1, px);
  const y1 = wrapi(iy + 1, py);
  const a = hashU(x0, y0, seed) * INV_U32;
  const b = hashU(x1, y0, seed) * INV_U32;
  const c = hashU(x0, y1, seed) * INV_U32;
  const d = hashU(x1, y1, seed) * INV_U32;
  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

/** Anisotropic tileable fbm (see valueNoise2xy). → [0,1] */
export function fbmValue2xy(x, y, px, py, seed = 0, octaves = 3, lacunarity = 2, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2xy(x * f, y * f, px * f, py * f, seed + o * 1013);
    norm += amp;
    amp *= gain;
    f = Math.max(1, Math.round(f * lacunarity));
  }
  return sum / norm;
}

/** Tileable 3D value noise on an integer lattice of `period` cells. → [0,1] */
export function valueNoise3(x, y, z, period = 256, seed = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const u = fade(x - ix);
  const v = fade(y - iy);
  const w = fade(z - iz);
  const x0 = wrapi(ix, period);
  const y0 = wrapi(iy, period);
  const z0 = wrapi(iz, period);
  const x1 = wrapi(ix + 1, period);
  const y1 = wrapi(iy + 1, period);
  const z1 = wrapi(iz + 1, period);
  const c000 = hashU3(x0, y0, z0, seed) * INV_U32;
  const c100 = hashU3(x1, y0, z0, seed) * INV_U32;
  const c010 = hashU3(x0, y1, z0, seed) * INV_U32;
  const c110 = hashU3(x1, y1, z0, seed) * INV_U32;
  const c001 = hashU3(x0, y0, z1, seed) * INV_U32;
  const c101 = hashU3(x1, y0, z1, seed) * INV_U32;
  const c011 = hashU3(x0, y1, z1, seed) * INV_U32;
  const c111 = hashU3(x1, y1, z1, seed) * INV_U32;
  const a0 = c000 + (c100 - c000) * u;
  const a1 = c010 + (c110 - c010) * u;
  const b0 = c001 + (c101 - c001) * u;
  const b1 = c011 + (c111 - c011) * u;
  const a = a0 + (a1 - a0) * v;
  const b = b0 + (b1 - b0) * v;
  return a + (b - a) * w;
}

// ──────────────────────────────────────────────────────── gradient noise ──

/** Tileable 2D gradient (Perlin) noise. Higher contrast than value noise. → about [-1,1] */
export function gradNoise2(x, y, period = 256, seed = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fade(fx);
  const v = fade(fy);
  const x0 = wrapi(ix, period);
  const y0 = wrapi(iy, period);
  const x1 = wrapi(ix + 1, period);
  const y1 = wrapi(iy + 1, period);
  const g00 = (hashU(x0, y0, seed) & 15) << 1;
  const g10 = (hashU(x1, y0, seed) & 15) << 1;
  const g01 = (hashU(x0, y1, seed) & 15) << 1;
  const g11 = (hashU(x1, y1, seed) & 15) << 1;
  const n00 = GRAD2[g00] * fx + GRAD2[g00 + 1] * fy;
  const n10 = GRAD2[g10] * (fx - 1) + GRAD2[g10 + 1] * fy;
  const n01 = GRAD2[g01] * fx + GRAD2[g01 + 1] * (fy - 1);
  const n11 = GRAD2[g11] * (fx - 1) + GRAD2[g11 + 1] * (fy - 1);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 1.4142;
}

/** Tileable 3D gradient (Perlin) noise. → about [-1,1] */
export function gradNoise3(x, y, z, period = 256, seed = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const u = fade(fx);
  const v = fade(fy);
  const w = fade(fz);
  const x0 = wrapi(ix, period);
  const y0 = wrapi(iy, period);
  const z0 = wrapi(iz, period);
  const x1 = wrapi(ix + 1, period);
  const y1 = wrapi(iy + 1, period);
  const z1 = wrapi(iz + 1, period);
  const dot = (hx, hy, hz, dx, dy, dz) => {
    const g = (hashU3(hx, hy, hz, seed) % 12) * 3;
    return GRAD3[g] * dx + GRAD3[g + 1] * dy + GRAD3[g + 2] * dz;
  };
  const n000 = dot(x0, y0, z0, fx, fy, fz);
  const n100 = dot(x1, y0, z0, fx - 1, fy, fz);
  const n010 = dot(x0, y1, z0, fx, fy - 1, fz);
  const n110 = dot(x1, y1, z0, fx - 1, fy - 1, fz);
  const n001 = dot(x0, y0, z1, fx, fy, fz - 1);
  const n101 = dot(x1, y0, z1, fx - 1, fy, fz - 1);
  const n011 = dot(x0, y1, z1, fx, fy - 1, fz - 1);
  const n111 = dot(x1, y1, z1, fx - 1, fy - 1, fz - 1);
  const a0 = n000 + (n100 - n000) * u;
  const a1 = n010 + (n110 - n010) * u;
  const b0 = n001 + (n101 - n001) * u;
  const b1 = n011 + (n111 - n011) * u;
  const a = a0 + (a1 - a0) * v;
  const b = b0 + (b1 - b0) * v;
  return (a + (b - a) * w) * 1.2;
}

// ───────────────────────────────────────────────────────────────── simplex ──

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

/** 2D simplex noise. NOT tileable — use for one-shot fields (leaves, overlays). → about [-1,1] */
export function simplex2(xin, yin, seed = 0) {
  const s = (xin + yin) * F2;
  const i = Math.floor(xin + s);
  const j = Math.floor(yin + s);
  const t = (i + j) * G2;
  const x0 = xin - (i - t);
  const y0 = yin - (j - t);
  const i1 = x0 > y0 ? 1 : 0;
  const j1 = x0 > y0 ? 0 : 1;
  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;
  let n = 0;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 > 0) {
    const g = (hashU(i, j, seed) & 15) << 1;
    t0 *= t0;
    n += t0 * t0 * (GRAD2[g] * x0 + GRAD2[g + 1] * y0);
  }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 > 0) {
    const g = (hashU(i + i1, j + j1, seed) & 15) << 1;
    t1 *= t1;
    n += t1 * t1 * (GRAD2[g] * x1 + GRAD2[g + 1] * y1);
  }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 > 0) {
    const g = (hashU(i + 1, j + 1, seed) & 15) << 1;
    t2 *= t2;
    n += t2 * t2 * (GRAD2[g] * x2 + GRAD2[g + 1] * y2);
  }
  return 62.0 * n;
}

const F3 = 1 / 3;
const G3 = 1 / 6;

/** 3D simplex noise. NOT tileable. → about [-1,1] */
export function simplex3(xin, yin, zin, seed = 0) {
  const s = (xin + yin + zin) * F3;
  const i = Math.floor(xin + s);
  const j = Math.floor(yin + s);
  const k = Math.floor(zin + s);
  const t = (i + j + k) * G3;
  const x0 = xin - (i - t);
  const y0 = yin - (j - t);
  const z0 = zin - (k - t);
  let i1, j1, k1, i2, j2, k2;
  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
    else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
  } else {
    if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
  }
  const corner = (ii, jj, kk, dx, dy, dz) => {
    let tt = 0.6 - dx * dx - dy * dy - dz * dz;
    if (tt <= 0) return 0;
    const g = (hashU3(ii, jj, kk, seed) % 12) * 3;
    tt *= tt;
    return tt * tt * (GRAD3[g] * dx + GRAD3[g + 1] * dy + GRAD3[g + 2] * dz);
  };
  const n =
    corner(i, j, k, x0, y0, z0) +
    corner(i + i1, j + j1, k + k1, x0 - i1 + G3, y0 - j1 + G3, z0 - k1 + G3) +
    corner(i + i2, j + j2, k + k2, x0 - i2 + 2 * G3, y0 - j2 + 2 * G3, z0 - k2 + 2 * G3) +
    corner(i + 1, j + 1, k + 1, x0 - 1 + 3 * G3, y0 - 1 + 3 * G3, z0 - 1 + 3 * G3);
  return 32 * n;
}

// ───────────────────────────────────────────────────────── worley/cellular ──

/**
 * Scratch record written by worley2(). Read it immediately — the next call overwrites it.
 * f1/f2 are distances in cell units, id is the uint32 hash of the nearest cell (use it for
 * per-cell random tone/size), cx/cy are the nearest feature point in cell units.
 */
export const W = { f1: 0, f2: 0, id: 0, cx: 0, cy: 0 };

/** Tileable 2D Worley/cellular noise over `period` cells. Fills and returns the W scratch record. */
export function worley2(x, y, period = 32, seed = 0, jitterAmt = 1) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let f1 = 1e9;
  let f2 = 1e9;
  let id = 0;
  let bx = 0;
  let by = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const gx = ix + ox;
      const gy = iy + oy;
      const h = hashU(wrapi(gx, period), wrapi(gy, period), seed);
      const jx = (h & 0xffff) / 65535;
      const jy = ((h >>> 16) & 0xffff) / 65535;
      const px = gx + 0.5 + (jx - 0.5) * jitterAmt;
      const py = gy + 0.5 + (jy - 0.5) * jitterAmt;
      const dx = px - x;
      const dy = py - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = h;
        bx = px;
        by = py;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  W.f1 = f1;
  W.f2 = f2;
  W.id = id;
  W.cx = bx;
  W.cy = by;
  return W;
}

/** Tileable cellular edge field (F2−F1): ~0 on cell borders, ~1 in cell interiors. */
export function worleyEdge2(x, y, period = 32, seed = 0, jitterAmt = 1) {
  worley2(x, y, period, seed, jitterAmt);
  return W.f2 - W.f1;
}

// ───────────────────────────────────────────────────────────────────── fbm ──

/**
 * Tileable fractal Brownian motion over value noise. Lacunarity is rounded to an integer
 * frequency multiplier per octave so every octave stays commensurate with the tile. → [0,1]
 */
export function fbmValue2(x, y, period = 8, seed = 0, octaves = 4, lacunarity = 2, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2(x * f, y * f, period * f, seed + o * 1013);
    norm += amp;
    amp *= gain;
    f = Math.max(1, Math.round(f * lacunarity));
  }
  return sum / norm;
}

/** Tileable fbm over gradient noise — crisper, better for structure. → about [-1,1] */
export function fbmGrad2(x, y, period = 8, seed = 0, octaves = 4, lacunarity = 2, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * gradNoise2(x * f, y * f, period * f, seed + o * 1013);
    norm += amp;
    amp *= gain;
    f = Math.max(1, Math.round(f * lacunarity));
  }
  return sum / norm;
}

/** Tileable 3D fbm over value noise. → [0,1] */
export function fbmValue3(x, y, z, period = 8, seed = 0, octaves = 4, lacunarity = 2, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise3(x * f, y * f, z * f, period * f, seed + o * 1013);
    norm += amp;
    amp *= gain;
    f = Math.max(1, Math.round(f * lacunarity));
  }
  return sum / norm;
}

/** Tileable 2D gradient noise with independent periods per axis. → about [-1,1] */
export function gradNoise2xy(x, y, px = 256, py = 256, seed = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fade(fx);
  const v = fade(fy);
  const x0 = wrapi(ix, px);
  const y0 = wrapi(iy, py);
  const x1 = wrapi(ix + 1, px);
  const y1 = wrapi(iy + 1, py);
  const g00 = (hashU(x0, y0, seed) & 15) << 1;
  const g10 = (hashU(x1, y0, seed) & 15) << 1;
  const g01 = (hashU(x0, y1, seed) & 15) << 1;
  const g11 = (hashU(x1, y1, seed) & 15) << 1;
  const n00 = GRAD2[g00] * fx + GRAD2[g00 + 1] * fy;
  const n10 = GRAD2[g10] * (fx - 1) + GRAD2[g10 + 1] * fy;
  const n01 = GRAD2[g01] * fx + GRAD2[g01 + 1] * (fy - 1);
  const n11 = GRAD2[g11] * (fx - 1) + GRAD2[g11 + 1] * (fy - 1);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 1.4142;
}

/** Anisotropic tileable ridged multifractal — stretched creases (bark, fabric folds). → [0,1] */
export function ridged2xy(x, y, px, py, seed = 0, octaves = 4, lacunarity = 2, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  let prev = 1;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(gradNoise2xy(x * f, y * f, px * f, py * f, seed + o * 7919));
    n *= n;
    sum += amp * n * prev;
    prev = n;
    norm += amp;
    amp *= gain;
    f = Math.max(1, Math.round(f * lacunarity));
  }
  return sum / norm;
}

/** Tileable ridged multifractal — sharp creases, for cracks, veins and crumples. → [0,1] */
export function ridged2(x, y, period = 8, seed = 0, octaves = 4, lacunarity = 2, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  let prev = 1;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(gradNoise2(x * f, y * f, period * f, seed + o * 7919));
    n *= n;
    sum += amp * n * prev;
    prev = n;
    norm += amp;
    amp *= gain;
    f = Math.max(1, Math.round(f * lacunarity));
  }
  return sum / norm;
}

/** Tileable turbulence — sum of absolute octaves, the classic marble/vein driver. → [0,1] */
export function turbulence2(x, y, period = 8, seed = 0, octaves = 4, lacunarity = 2, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * Math.abs(gradNoise2(x * f, y * f, period * f, seed + o * 3571));
    norm += amp;
    amp *= gain;
    f = Math.max(1, Math.round(f * lacunarity));
  }
  return sum / norm;
}

// ────────────────────────────────────────────────────────── domain warping ──

/** Scratch record written by warp2(). Read immediately. */
export const WARP = { x: 0, y: 0 };

/**
 * Tileable domain warp: offsets (x,y) by a low-frequency vector field. `amount` is in cell units.
 * Because the offset field itself tiles with the same period, the warped field still tiles.
 */
export function warp2(x, y, period = 4, seed = 0, amount = 1, octaves = 2) {
  const dx = fbmGrad2(x, y, period, seed, octaves);
  const dy = fbmGrad2(x, y, period, seed + 5501, octaves);
  WARP.x = x + dx * amount;
  WARP.y = y + dy * amount;
  return WARP;
}

/**
 * Seamless 2D field via a torus embedded in 3D: (u,v) in [0,1)² is mapped onto the surface of a
 * torus and sampled with 3D noise, so both axes wrap exactly at any (even fractional) frequency.
 * Slightly anisotropic and ~2x the cost of periodic lattice noise — use only when you cannot
 * express the frequency as an integer cell count.
 */
export function torus2(u, v, freq = 4, seed = 0, octaves = 3) {
  const R = freq;
  const r = freq * 0.5;
  const a = u * Math.PI * 2;
  const b = v * Math.PI * 2;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const x = (R + r * Math.cos(b)) * ca;
  const y = (R + r * Math.cos(b)) * sa;
  const z = r * Math.sin(b);
  return fbmValue3(x, y, z, 4096, seed, octaves);
}

// ──────────────────────────────────────────────── stratified / blue noise ──

/**
 * Fast pseudo-blue-noise point set: a jittered (stratified) grid, which has a blue-noise-ish
 * power spectrum without the cost of Poisson dart throwing. Returns a Float32Array of
 * [u0,v0,u1,v1,…] in [0,1)². Points wrap, so speckles placed with them tile.
 */
export function stratifiedPoints(count, seed = 0, jitterAmt = 0.9) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const out = new Float32Array(count * 2);
  const cell = 1 / cols;
  for (let i = 0; i < count; i++) {
    const cx = i % cols;
    const cy = (i / cols) | 0;
    const h = hashU(cx, cy, seed + 77);
    const jx = (h & 0xffff) / 65535;
    const jy = ((h >>> 16) & 0xffff) / 65535;
    out[i * 2] = (cx + 0.5 + (jx - 0.5) * jitterAmt) * cell;
    out[i * 2 + 1] = (cy + 0.5 + (jy - 0.5) * jitterAmt) * cell;
  }
  return out;
}

/**
 * Slightly better distributed point set: jittered grid plus a few relaxation passes against the
 * nearest neighbours. Costlier than stratifiedPoints; use for the few hundred features where
 * clumping would be visible (tie holes, pinholes, big speckles).
 */
export function blueNoisePoints(count, seed = 0, relaxPasses = 2) {
  const pts = stratifiedPoints(count, seed, 1.0);
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const minD = 0.7 / cols;
  for (let pass = 0; pass < relaxPasses; pass++) {
    for (let i = 0; i < count; i++) {
      let px = pts[i * 2];
      let py = pts[i * 2 + 1];
      for (let j = 0; j < count; j++) {
        if (j === i) continue;
        let dx = px - pts[j * 2];
        let dy = py - pts[j * 2 + 1];
        if (dx > 0.5) dx -= 1; else if (dx < -0.5) dx += 1;
        if (dy > 0.5) dy -= 1; else if (dy < -0.5) dy += 1;
        const d2 = dx * dx + dy * dy;
        if (d2 > 1e-12 && d2 < minD * minD) {
          const d = Math.sqrt(d2);
          const push = (minD - d) * 0.5;
          px += (dx / d) * push;
          py += (dy / d) * push;
        }
      }
      pts[i * 2] = px - Math.floor(px);
      pts[i * 2 + 1] = py - Math.floor(py);
    }
  }
  return pts;
}

/** A local seeded RNG for generator parameters (per-plank tone, per-book colour, …). */
export const localRng = (seed) => makeRng(seed >>> 0);
