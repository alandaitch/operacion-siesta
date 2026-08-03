// FX · the procedural sprite atlas.
//
// Every particle in the game samples one 4x4 atlas: sixteen 8-bit cells authored here in a typed
// array and uploaded once as a DataTexture. RGB carries a greyscale *detail* term (the internal
// shading of a puff, the fold in a paper scrap, the mottling of a stain) and A carries coverage;
// the shader multiplies the instance's own linear colour by RGB and blends by A, so one texture
// dresses smoke, powder, glints, chips, crumbs and every decal.
//
// Two rules make the atlas safe under mipmapping without any padding pass: every cell's alpha is
// forced to zero within ~8% of its border, so a bilinear tap that strays across a cell boundary
// picks up nothing, and every cell is authored on the same soft-edged radial budget so the coarse
// mips stay plausible rather than turning into grey squares.
//
// Noise is a two-dimensional integer-hash value noise with cubic interpolation — three octaves is
// plenty at this size and it costs a fraction of a gradient noise. Everything is driven from
// makeRng so the atlas is byte-identical every run.

import * as THREE from 'three';
import { makeRng } from '../core/rng.js';

export const ATLAS_COLS = 4;

/** Cell indices. Keep in sync with the authoring switch below. */
export const CELL = {
  PUFF: 0,     // billowy smoke/dust puff, the workhorse
  POWDER: 1,   // very fine soft cloud — ceramic dust, flour
  WISP: 2,     // stretched wisp for trails
  GRIT: 3,     // chunky cloud with visible grains — soil, plaster
  GLINT: 4,    // four-point star for foil and highlights
  MOTE: 5,     // tight dot — airborne motes, crumbs at distance
  SHARD: 6,    // angular chip silhouette
  FLAKE: 7,    // small irregular flake
  SCRAP: 8,    // torn paper rectangle with a fold
  SPLAT: 9,    // radial splat with tendrils and satellites
  RING: 10,    // soft annulus — a coffee ring
  STAIN: 11,   // organic patch — soil, damp
  SPECKS: 12,  // scattered speckles — crumbs
  DRIP: 13,    // teardrop with satellites — drool
  SMEAR: 14,   // directional smudge
  HALO: 15,    // clean radial glow
};

// ── noise ────────────────────────────────────────────────────────────────────────────────────

function hash2(ix, iy, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}

function fbm(x, y, seed, octaves = 3) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(fx, fy, seed + o * 7919) * amp;
    norm += amp;
    amp *= 0.5;
    fx *= 2.03;
    fy *= 2.03;
  }
  return sum / norm;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

// ── per-cell authoring ───────────────────────────────────────────────────────────────────────
// Each function returns [luminance 0..1, alpha 0..1] for a point in cell space, where
// (u, v) ∈ [0,1]² and (dx, dy) are offsets from the cell centre in [-0.5, 0.5].

/**
 * A convex polygon as a set of half-planes: `k` edges spread around the circle with jittered
 * normals and offsets. Testing a point against all of them gives straight, hard silhouette edges —
 * which is what tells a ceramic chip apart from a pebble, and no radial lobe function will do it.
 */
function convex(r, k, dMin, dMax) {
  const edges = [];
  for (let i = 0; i < k; i++) {
    const ang = ((i + 0.5) / k) * Math.PI * 2 + (r() - 0.5) * (Math.PI / k) * 1.1;
    edges.push([Math.cos(ang), Math.sin(ang), dMin + r() * (dMax - dMin)]);
  }
  return edges;
}

/** Signed clearance inside a convex polygon: > 0 inside, and the distance to the nearest edge. */
function insideConvex(dx, dy, edges) {
  let m = 1e9;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const s = e[2] - (dx * e[0] + dy * e[1]);
    if (s < m) m = s;
  }
  return m;
}

/** Pre-baked randomness each cell draws from, so the authoring loop never calls the RNG. */
function makeCellData() {
  const r = makeRng(0xfa17e5);
  // Five overlapping lobes make a billow; one radial falloff makes a blur. Puffs get lobes.
  const puff = [];
  for (let i = 0; i < 5; i++) {
    const ang = r() * Math.PI * 2;
    const rad = r() * 0.13;
    puff.push([Math.cos(ang) * rad, Math.sin(ang) * rad * 0.85, 0.25 + r() * 0.14]);
  }
  const grit = [];
  for (let i = 0; i < 4; i++) {
    const ang = r() * Math.PI * 2;
    const rad = r() * 0.15;
    grit.push([Math.cos(ang) * rad, Math.sin(ang) * rad * 0.8, 0.24 + r() * 0.14]);
  }
  const shard = convex(r, 5, 0.20, 0.33);
  const flake = convex(r, 7, 0.15, 0.26);
  const splat = [];
  for (let i = 0; i < 9; i++) splat.push(0.24 + r() * 0.20);
  const satellites = [];
  for (let i = 0; i < 6; i++) {
    const ang = r() * Math.PI * 2;
    const rad = 0.30 + r() * 0.14;
    satellites.push([Math.cos(ang) * rad, Math.sin(ang) * rad, 0.020 + r() * 0.030]);
  }
  const specks = [];
  for (let i = 0; i < 46; i++) {
    const ang = r() * Math.PI * 2;
    const rad = Math.sqrt(r()) * 0.40;
    specks.push([Math.cos(ang) * rad, Math.sin(ang) * rad, 0.010 + r() * 0.026, 0.35 + r() * 0.55]);
  }
  const drops = [];
  for (let i = 0; i < 4; i++) {
    const ang = r() * Math.PI * 2;
    const rad = 0.24 + r() * 0.16;
    drops.push([Math.cos(ang) * rad, Math.sin(ang) * rad * 0.7, 0.018 + r() * 0.026]);
  }
  return { puff, grit, shard, flake, splat, satellites, specks, drops };
}

/** Distance to a star-shaped polygon whose radii are given per sector, as a 0..1 inside mask. */
function lobed(dx, dy, radii, sharp) {
  const ang = Math.atan2(dy, dx);
  const n = radii.length;
  const t = ((ang + Math.PI) / (Math.PI * 2)) * n;
  const i0 = Math.floor(t) % n;
  const i1 = (i0 + 1) % n;
  let f = t - Math.floor(t);
  f = f * f * (3 - 2 * f);
  const rad = radii[i0] + (radii[i1] - radii[i0]) * f;
  const d = Math.hypot(dx, dy);
  return smooth(rad, rad - sharp, d);
}

function authorCell(cell, u, v, D) {
  const dx = u - 0.5;
  const dy = v - 0.5;
  const r = Math.hypot(dx, dy) * 2; // 0 at centre, 1 at the inscribed circle
  let a = 0;
  let lum = 1;

  switch (cell) {
    case CELL.PUFF: {
      // Erode the silhouette before testing it, so the outline of every lobe is ragged.
      const erode = 1 + (fbm(u * 3.4, v * 3.4, 11, 3) - 0.5) * 0.62;
      let body = 0;
      for (let i = 0; i < D.puff.length; i++) {
        const L = D.puff[i];
        const d = Math.hypot(dx - L[0], dy - L[1]) * erode;
        const m = smooth(L[2], L[2] * 0.22, d);
        if (m > body) body = m;
      }
      const detail = fbm(u * 5.8 + 1.3, v * 5.8 - 2.1, 17, 3);
      a = body * (0.46 + 0.78 * detail) * smooth(1.06, 0.55, r);
      // A puff is a lit volume, not a decal: key from above, self-shadow underneath, and the
      // fine structure of the fbm carried into the shading so the billows have form.
      lum = 0.30 + 0.55 * fbm(u * 2.4 + 3.1, v * 2.4 - 1.7, 23, 3) + 0.42 * detail
        + 0.34 * (0.5 + dy) - 0.20 * r;
      break;
    }
    case CELL.POWDER: {
      const n = fbm(u * 6.2, v * 6.2, 37, 3);
      a = Math.exp(-r * r * 3.1) * (0.58 + 0.62 * n);
      lum = 0.72 + 0.42 * n + 0.22 * (0.5 + dy);
      break;
    }
    case CELL.WISP: {
      const rr = Math.hypot(dx * 1.05, dy * 2.9) * 2;
      const streak = fbm(u * 2.0, v * 7.5, 53, 3);
      a = Math.exp(-rr * rr * 2.2) * (0.30 + 0.95 * streak);
      lum = 0.60 + 0.50 * streak;
      break;
    }
    case CELL.GRIT: {
      const erode = 1 + (fbm(u * 4.2, v * 4.2, 71, 3) - 0.5) * 0.60;
      let body = 0;
      for (let i = 0; i < D.grit.length; i++) {
        const L = D.grit[i];
        const d = Math.hypot(dx - L[0], dy - L[1]) * erode;
        const m = smooth(L[2], L[2] * 0.30, d);
        if (m > body) body = m;
      }
      // Soil and plaster dust are not smoke: the cloud carries visible grain. Modulate, do not
      // threshold — a threshold turns the cell into a field of hard dots.
      const grains = fbm(u * 13.0, v * 13.0, 97, 2);
      const n = fbm(u * 4.4, v * 4.4, 71, 3);
      a = body * (0.46 + 0.70 * n) * (0.50 + 0.95 * grains) * smooth(1.06, 0.62, r);
      lum = 0.28 + 0.66 * grains + 0.36 * n + 0.26 * (0.5 + dy);
      break;
    }
    case CELL.GLINT: {
      const core = Math.exp(-r * r * 34);
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      const h = Math.exp(-ax * 9.0) * Math.exp(-ay * 96);
      const vv = Math.exp(-ay * 9.0) * Math.exp(-ax * 96);
      const diag = Math.exp(-Math.abs(dx - dy) * 130) * Math.exp(-r * 5.0) * 0.35
        + Math.exp(-Math.abs(dx + dy) * 130) * Math.exp(-r * 5.0) * 0.35;
      a = clamp01(core + 0.80 * (h + vv) + diag) * smooth(1.0, 0.72, r);
      lum = 1.0;
      break;
    }
    case CELL.MOTE: {
      a = Math.exp(-r * r * 8.4) * smooth(1.0, 0.80, r);
      lum = 0.90 + 0.20 * (0.5 + dy);
      break;
    }
    case CELL.SHARD: {
      // Straight edges, one texel of anti-aliasing, and a conchoidal fracture ridge across it.
      const m = insideConvex(dx, dy, D.shard);
      a = smooth(0.0, 0.009, m);
      const facet = clamp01(0.5 + (dx * 1.6 - dy * 1.2));
      const rim = 1 - smooth(0.0, 0.045, m);
      const ridge = Math.exp(-Math.abs(dy - dx * 0.55 - 0.02) * 22);
      lum = 0.26 + 0.78 * facet + 0.55 * rim + 0.34 * ridge;
      break;
    }
    case CELL.FLAKE: {
      const m = insideConvex(dx, dy, D.flake);
      a = smooth(0.0, 0.010, m);
      const rim = 1 - smooth(0.0, 0.030, m);
      lum = 0.36 + 0.62 * fbm(u * 6.0, v * 6.0, 131, 3) + 0.34 * (0.5 + dy) + 0.30 * rim;
      break;
    }
    case CELL.SCRAP: {
      // A torn rectangle. The tear lives on the boundary as low-frequency noise.
      const tearX = (fbm(v * 6.0, 3.7, 149, 2) - 0.5) * 0.10;
      const tearY = (fbm(u * 6.0, 8.3, 163, 2) - 0.5) * 0.10;
      const mx = smooth(0.34 + tearX, 0.30 + tearX, Math.abs(dx));
      const my = smooth(0.25 + tearY, 0.21 + tearY, Math.abs(dy));
      a = mx * my;
      // One crease across the sheet, plus the paper's own tooth.
      const crease = Math.exp(-Math.abs(dy - dx * 0.42 + 0.05) * 26);
      lum = 0.72 + 0.34 * crease + 0.26 * dy + 0.16 * fbm(u * 22, v * 22, 179, 2);
      break;
    }
    case CELL.SPLAT: {
      let mask = lobed(dx, dy, D.splat, 0.06);
      for (let i = 0; i < D.satellites.length; i++) {
        const s = D.satellites[i];
        mask = Math.max(mask, smooth(s[2], s[2] * 0.55, Math.hypot(dx - s[0], dy - s[1])));
      }
      a = mask * smooth(1.02, 0.88, r);
      lum = 0.52 + 0.46 * fbm(u * 6.0, v * 6.0, 197, 3);
      break;
    }
    case CELL.RING: {
      const wobble = (fbm(Math.atan2(dy, dx) * 1.4 + 4.0, r * 2.0, 211, 2) - 0.5) * 0.06;
      const rr = r + wobble;
      const band = Math.exp(-((rr - 0.74) ** 2) * 150);
      const pool = Math.exp(-((rr - 0.30) ** 2) * 12) * 0.22;
      a = clamp01(band * (0.55 + 0.65 * fbm(u * 8, v * 8, 223, 2)) + pool) * smooth(1.02, 0.90, r);
      lum = 0.55 + 0.40 * band;
      break;
    }
    case CELL.STAIN: {
      const ang = Math.atan2(dy, dx);
      const wob = fbm(Math.cos(ang) * 1.7 + 5.0, Math.sin(ang) * 1.7 + 2.0, 239, 3);
      const rad = 0.66 + (wob - 0.5) * 0.42;
      const body = smooth(rad, rad - 0.16, r);
      const mott = fbm(u * 4.6, v * 4.6, 251, 3);
      a = body * (0.55 + 0.70 * mott);
      lum = 0.40 + 0.75 * mott;
      break;
    }
    case CELL.SPECKS: {
      let mask = 0;
      let l = 0;
      for (let i = 0; i < D.specks.length; i++) {
        const s = D.specks[i];
        const d = Math.hypot(dx - s[0], dy - s[1]);
        const m = smooth(s[2], s[2] * 0.35, d);
        if (m > mask) { mask = m; l = s[3]; }
      }
      a = mask * smooth(1.02, 0.92, r);
      lum = 0.34 + 0.85 * l;
      break;
    }
    case CELL.DRIP: {
      const stretch = Math.hypot(dx * 2.3, (dy + 0.06) * 1.25) * 2;
      let mask = smooth(0.86, 0.62, stretch);
      // the fat end
      mask = Math.max(mask, smooth(0.19, 0.12, Math.hypot(dx, dy - 0.16)));
      for (let i = 0; i < D.drops.length; i++) {
        const s = D.drops[i];
        mask = Math.max(mask, smooth(s[2], s[2] * 0.5, Math.hypot(dx - s[0], dy - s[1])));
      }
      a = mask * smooth(1.02, 0.92, r);
      // A wet edge: a bright meniscus where the surface tension pulls the film up, and a darker,
      // deeper middle. Kept soft — a hard outline reads as a sticker.
      const meniscus = Math.exp(-((stretch - 0.72) ** 2) * 26);
      lum = 0.34 + 0.30 * mask + 0.62 * meniscus;
      break;
    }
    case CELL.SMEAR: {
      const streak = fbm(u * 3.2, v * 13.0, 269, 3);
      a = Math.exp(-dy * dy * 34) * smooth(0.52, 0.16, Math.abs(dx)) * (0.35 + 0.95 * streak);
      lum = 0.50 + 0.60 * streak;
      break;
    }
    default: { // CELL.HALO
      const t = smooth(1.0, 0.0, r);
      a = t * t * (0.85 + 0.15 * t);
      lum = 1.0;
      break;
    }
  }

  // Nothing may reach the cell border, or the mip chain bleeds neighbours into each other.
  a *= smooth(0.500, 0.455, Math.max(Math.abs(dx), Math.abs(dy)));
  return [clamp01(lum), clamp01(a)];
}

/**
 * Build the atlas.
 * @param {number} size total texture size in pixels (a power of two, ≥ 128)
 * @returns {THREE.DataTexture}
 */
export function createSpriteAtlas(size = 512) {
  const s = Math.max(64, 2 ** Math.round(Math.log2(size)));
  const cell = s / ATLAS_COLS;
  const data = new Uint8Array(s * s * 4);
  const D = makeCellData();
  const inv = 1 / cell;

  for (let y = 0; y < s; y++) {
    const cy = (y / cell) | 0;
    const vy = (y - cy * cell + 0.5) * inv;
    for (let x = 0; x < s; x++) {
      const cx = (x / cell) | 0;
      const vx = (x - cx * cell + 0.5) * inv;
      const index = cy * ATLAS_COLS + cx;
      const [lum, alpha] = authorCell(index, vx, vy, D);
      const o = (y * s + x) * 4;
      const l = (lum * 255 + 0.5) | 0;
      data[o] = l;
      data[o + 1] = l;
      data[o + 2] = l;
      data[o + 3] = (alpha * 255 + 0.5) | 0;
    }
  }

  const tex = new THREE.DataTexture(data, s, s, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'fx.atlas';
  tex.colorSpace = THREE.NoColorSpace; // a mask + a detail term, not an albedo
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

/** GLSL that turns a cell index into atlas UVs. Shared by the sprite and decal shaders. */
export const ATLAS_GLSL = /* glsl */ `
const float FX_ATLAS_COLS = ${ATLAS_COLS.toFixed(1)};
vec2 fxAtlasUV( vec2 quadUV, float cellIndex ) {
  float i = floor( cellIndex + 0.5 );
  float cx = mod( i, FX_ATLAS_COLS );
  float cy = floor( i / FX_ATLAS_COLS );
  // Half-texel inset is unnecessary: every cell fades to zero alpha well inside its border.
  return ( vec2( cx, cy ) + clamp( quadUV, 0.0, 1.0 ) ) / FX_ATLAS_COLS;
}
`;
