// OPERATION NAPTIME — module TEX — soft goods.
//
// The brief is blunt about this: "a smooth cream box is a fail". Bouclé has to read as a field of
// individual wool loops from 20 cm away, so it is not built from fabric-ish noise — it is built
// from actual loop geometry. For every texel we visit the 3x3 neighbourhood of a jittered cell
// grid and accumulate the maximum of each loop's ring profile, which lets loops genuinely overlap
// (a Worley F1 lookup cannot: it would slice every overlap along a Voronoi edge). The same
// neighbourhood-accumulation trick drives the rug pile and the plush fuzz.
//
// The open-weave fabrics (voile, playpen mesh, cane webbing) all return a real alphaMap and put
// the same alpha in the albedo's A channel, so a consumer can drive either `alphaMap` or
// `transparent + map`.

import {
  beginSurface, finishSurface, hexToRgb, lowFreqField, stampDiscRgb,
} from './raster.js';
import {
  clamp01, fbmValue2, fbmValue2xy, hash1, hashU, latticeFor, localRng, mix, ridged2, smoothstep,
  valueNoise2, valueNoise2xy,
} from './noise.js';

/**
 * Accumulate overlapping round "loop" profiles from the 3x3 neighbourhood of a jittered cell
 * grid. Returns the max profile height; writes the winning cell hash into LOOP.id and the second
 * highest into LOOP.second (used for the crevice darkening between two loops).
 */
const LOOP = { id: 0, second: 0, dist: 0 };
function loopField(cx, cy, cells, seed, ringR, ringW, sizeVar) {
  const ix = Math.floor(cx);
  const iy = Math.floor(cy);
  let best = 0;
  let second = 0;
  let id = 0;
  let bd = 9;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const gx = ix + ox;
      const gy = iy + oy;
      const wx = gx - Math.floor(gx / cells) * cells;
      const wy = gy - Math.floor(gy / cells) * cells;
      const h = hashU(wx, wy, seed);
      const jx = (h & 0x3ff) / 1023;
      const jy = ((h >>> 10) & 0x3ff) / 1023;
      const sz = ((h >>> 20) & 0x3ff) / 1023;
      const px = gx + 0.15 + jx * 0.7;
      const py = gy + 0.15 + jy * 0.7;
      const dx = px - cx;
      const dy = py - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const rr = ringR * (1 - sizeVar * 0.5 + sz * sizeVar);
      const t = (d - rr) / ringW;
      if (t > -1 && t < 1) {
        let val = 1 - t * t;
        val *= val;
        val *= 0.75 + sz * 0.25;
        if (val > best) {
          second = best;
          best = val;
          id = h;
          bd = d;
        } else if (val > second) second = val;
      }
    }
  }
  LOOP.id = id;
  LOOP.second = second;
  LOOP.dist = bd;
  return best;
}

// ═══════════════════════════════════════════════════════════ bouclé ══════

/**
 * Dense cream bouclé — the armchair, the ottoman and the pouf. Two interleaved loop layers at
 * slightly different radii so the field reads as a knot of overlapping wool loops rather than a
 * grid of bumps, plus fine fibre fuzz and baked crevice AO (which is what actually sells it
 * under raking window light).
 */
export function boucle({ size = 1024, seed = 21021, tileMetres = 0.085, loopsPerTile = 26, colour = 0xece2d2 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const shadow = hexToRgb(0xa29b90);
  const cells = loopsPerTile;
  const drift = lowFreqField(n, 8, (u, v) => fbmValue2(u * 3, v * 3, 3, seed + 5, 3));
  // Density/loft variation: real bouclé is not a perfectly even knit — some patches sit denser and
  // taller than others. Drives both the local loop scale and the crevice depth.
  const loft = lowFreqField(n, 5, (u, v) => fbmValue2(u * 3.3, v * 3.3, 3, seed + 71, 3));
  const [pf, sf] = latticeFor(n, 2);
  const [pf5, sf5] = latticeFor(n, 5);
  const [pf4, sf4] = latticeFor(n, 4);

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const cy = ((y + 0.5) / n) * cells;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const cx = ((x + 0.5) / n) * cells;
      const loftMod = 0.75 + loft[i] * 0.5; // ±25% local loop scale
      // Ring radius 0.40 of a cell with a 0.17 wall: a real donut with an open middle, which is
      // what makes the field read as LOOPS. Fatten the wall and it collapses into bumpy noise.
      const a = loopField(cx, cy, cells, seed, 0.40 * loftMod, 0.17, 0.4);
      const idA = LOOP.id;
      const secA = LOOP.second;
      const b = loopField(cx + 0.5, cy + 0.5, cells, seed + 977, 0.31 * loftMod, 0.15, 0.45);
      const loop = Math.max(a, b * 0.92);
      const crevice = clamp01(1 - Math.max(secA, Math.min(a, b) * 1.3) * 1.4);

      // Fine wool fuzz: short fibres standing off the loops.
      const fuzz = valueNoise2(x * sf, y * sf, pf, seed + 31) * 0.6 + valueNoise2xy(x * sf5, y * sf4, pf5, pf4, seed + 33) * 0.4;
      const tone = ((idA & 0xff) / 255 - 0.5) * 0.05 + (drift[i] - 0.5) * 0.06;

      const lit = clamp01(loop * 1.15);
      // Where two loops meet there is a deep crevice; a touch of it goes into the albedo so the
      // fabric still reads as loops at mip levels where the normal map has washed out.
      const occl = clamp01(crevice * 0.55 + (1 - lit) * 0.45);
      const t = clamp01(lit * 1.0 + 0.12 - occl * 0.3);
      S.r[i] = clamp01(mix(shadow[0], base[0], t) + tone + (fuzz - 0.5) * 0.05);
      S.g[i] = clamp01(mix(shadow[1], base[1], t) + tone + (fuzz - 0.5) * 0.05);
      S.b[i] = clamp01(mix(shadow[2], base[2], t) + tone * 0.9 + (fuzz - 0.5) * 0.05);

      S.h[i] = clamp01(loop * 0.86 * loftMod + (fuzz - 0.5) * 0.12 + 0.06);
      // Loop crests catch a soft wool sheen; the gaps between loops are dead matte.
      S.rough[i] = clamp01(0.955 - lit * 0.11 + (fuzz - 0.5) * 0.04 + occl * 0.02);
    }
  }

  return finishSurface(S, {
    name: 'boucle',
    normalStrength: 1.4,
    heightScale: 0.0032,
    tileMetres: [tileMetres, tileMetres],
    ao: { radius: 0.045, scale: 9, strength: 1.15, size: 256 },
  });
}

// ══════════════════════════════════════════════════════════ velvet ═══════

/**
 * Cream chenille/velvet for the sectional: a fine directional pile with anisotropic roughness
 * streaks, so the fabric goes light or dark as the view angle changes. The sheen term itself is
 * the material library's job (MeshPhysicalMaterial sheen); this supplies the structure.
 */
export function velvetChenille({ size = 512, seed = 22022, tileMetres = 0.12, colour = 0xe7ddcb } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  // The pile has to read at millimetre scale, not centimetre: real chenille tufts are sub-mm.
  // latticeFor(size, divisor) treats `divisor` as the feature size IN PIXELS (verified against
  // ./noise.js — period = round(size/divisor), so the cell width is size/period ≈ divisor), so at
  // this generator's default 512px/0.12m tile (≈0.234 mm/px) the fibre layer now lands at
  // ≈0.47 x 1.18 mm and the strand layer at ≈0.70 x 3.08 mm — a real 2-3x reduction from the
  // original 0.47x2.35mm / 1.4x9.2mm, which is what was reading as 4-6mm pebbles.
  const [px, sx] = latticeFor(n, 2);
  const [py, sy] = latticeFor(n, 5);
  const [px2, sx2] = latticeFor(n, 3);
  const [py2, sy2] = latticeFor(n, 13);
  const blotch = lowFreqField(n, 8, (u, v) => fbmValue2(u * 5, v * 5, 5, seed + 3, 3));
  // Nap sweep: a deliberate broad roughness brushing along +v, distinct from the per-fibre noise.
  const sweep = lowFreqField(n, 6, (u, v) => fbmValue2(u * 4, v * 4, 4, seed + 61, 3));

  for (let y = 0; y < n; y++) {
    const row = y * n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      // Pile runs along +v: fine across, smeared along.
      const fibre = valueNoise2xy(x * sx, y * sy, px, py, seed + 11);
      const strand = fbmValue2xy(x * sx2, y * sy2, px2, py2, seed + 13, 2);
      const v = clamp01(fibre * 0.55 + strand * 0.45);
      const shade = (v - 0.5) * 0.07 + (blotch[i] - 0.5) * 0.05;
      S.r[i] = clamp01(base[0] + shade);
      S.g[i] = clamp01(base[1] + shade * 0.98);
      S.b[i] = clamp01(base[2] + shade * 0.92);
      S.h[i] = 0.5 + (fibre - 0.5) * 0.55 + (strand - 0.5) * 0.3;
      // Streaky roughness is what makes velvet read as velvet under a moving camera; the sweep term
      // is the broad directional light/dark brushing along the nap, on top of the per-fibre grain.
      S.rough[i] = clamp01(0.72 + (strand - 0.5) * 0.16 + (fibre - 0.5) * 0.06 + (sweep[i] - 0.5) * 0.36);
    }
  }
  return finishSurface(S, {
    name: 'velvetChenille',
    normalStrength: 0.4,
    heightScale: 0.00025,
    tileMetres: [tileMetres, tileMetres],
  });
}

/** Navy ribbed corduroy for the lumbar cushion: rounded vertical ribs with fine weft threads. */
export function ribbedCorduroy({ size = 512, seed = 23023, tileMetres = 0.12, ribs = 20, colour = 0x2b3550 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const dark = hexToRgb(0x161d2e);
  const [pxA, sxA] = latticeFor(n, 3);
  const [pyA, syA] = latticeFor(n, 8);

  // The rib profile is a function of x alone — precompute it rather than paying a sin and a pow
  // per texel.
  const tCrest = new Float32Array(n);
  const tValley = new Float32Array(n);
  for (let x = 0; x < n; x++) {
    const u = (x + 0.5) / n;
    const rp = u * ribs;
    const rf = rp - Math.floor(rp);
    tCrest[x] = Math.sin(Math.PI * clamp01((rf - 0.06) / 0.88)) ** 0.6;
    tValley[x] = 1 - smoothstep(0.0, 0.16, Math.min(rf, 1 - rf));
  }

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    // Weft: the little horizontal threads that cross the ribs.
    const weft = Math.sin(v * 6.283 * ribs * 4) * 0.5 + 0.5;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const crest = tCrest[x];
      const valley = tValley[x];
      const fuzz = valueNoise2xy(x * sxA, y * syA, pxA, pyA, seed + 7);
      const t = clamp01(1 - crest * 0.85 + valley * 0.5);
      S.r[i] = clamp01(mix(base[0], dark[0], t) + (fuzz - 0.5) * 0.035 + weft * 0.012);
      S.g[i] = clamp01(mix(base[1], dark[1], t) + (fuzz - 0.5) * 0.035 + weft * 0.012);
      S.b[i] = clamp01(mix(base[2], dark[2], t) + (fuzz - 0.5) * 0.04 + weft * 0.014);
      S.h[i] = clamp01(crest * 0.9 - valley * 0.35 + (fuzz - 0.5) * 0.08 + weft * 0.03);
      S.rough[i] = clamp01(0.82 - crest * 0.12 + (fuzz - 0.5) * 0.06);
    }
  }
  return finishSurface(S, {
    name: 'ribbedCorduroy',
    normalStrength: 1.7,
    heightScale: 0.0035,
    tileMetres: [tileMetres, tileMetres],
    ao: { radius: 0.03, scale: 7, strength: 0.9, size: 256 },
  });
}

// ════════════════════════════════════════════════════════════ rug ════════

/**
 * Cream short-pile wool rug. Three layers: the woven backing grid (warp/weft), the tuft field
 * (jittered domes with a visible lay direction) and a broad tone drift so the rug is never one
 * flat colour. Roughness carries a directional sheen streak, which is what makes wool shift tone
 * with view angle.
 */
export function woolRugPile({ size = 1024, seed = 24024, tileMetres = 0.30, colour = 0xebe1cf } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const deep = hexToRgb(0xb7ab94);
  // Tufts are stretched 2.5:1 along V and leaned in +V, which is what gives wool its view-dependent
  // tonal banding — an isotropic square lattice (the old `tufts=32` on both axes) can never shift
  // tone with view angle, it can only ever look like caviar.
  const tuftsU = 32;
  const tuftsV = 13;
  const drift = lowFreqField(n, 8, (u, v) => fbmValue2(u * 4, v * 4, 4, seed + 3, 3));
  const [pxA, sxA] = latticeFor(n, 2);
  const [pyA, syA] = latticeFor(n, 6);

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    const cy = v * tuftsV;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      const cx = u * tuftsU;
      // Per-tuft lean: bias the sample point in +V by up to a quarter tuft-width, keyed to the
      // tuft's own column, so crests catch light directionally instead of being radially symmetric.
      const lean = (hash1(Math.floor(cx), seed + 81) - 0.5) * 0.25;
      // Cut pile, so the tufts are domes rather than the open rings of the bouclé.
      const tuft = loopField(cx, cy + lean, tuftsV, seed + 41, 0.12, 0.40, 0.55);
      const idT = LOOP.id;
      const fibre = valueNoise2xy(x * sxA, y * syA, pxA, pyA, seed + 17);

      const lit = clamp01(tuft * 1.25 + fibre * 0.22);
      const tone = ((idT & 0xff) / 255 - 0.5) * 0.045 + (drift[i] - 0.5) * 0.055;
      S.r[i] = clamp01(mix(deep[0], base[0], clamp01(lit + 0.25)) + tone);
      S.g[i] = clamp01(mix(deep[1], base[1], clamp01(lit + 0.25)) + tone);
      S.b[i] = clamp01(mix(deep[2], base[2], clamp01(lit + 0.25)) + tone * 0.92);
      S.h[i] = clamp01(tuft * 0.62 + (fibre - 0.5) * 0.26 + 0.08);
      // Roughness variation is wide and correlated with the lean — this, not the sheen lobe alone,
      // is what makes wool shift tone as the camera crawls across it.
      S.rough[i] = clamp01(0.93 - lit * 0.1 + (fibre - 0.5) * 0.07 + lean * 0.56);
    }
  }
  return finishSurface(S, {
    name: 'woolRugPile',
    normalStrength: 0.95,
    heightScale: 0.004,
    tileMetres: [tileMetres, tileMetres],
    ao: { radius: 0.04, scale: 7, strength: 0.9, size: 256 },
  });
}

/**
 * The rug's fringe, as a separate alpha strip: v=0 is the bound edge, v=1 the loose ends.
 * Threads wander, have different lengths and taper to a frayed tip.
 */
export function rugFringe({ size = 256, seed = 25025, tileMetres = [0.10, 0.09], threads = 34, colour = 0xe9dfcb } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const A = S.useAlpha(0);
  const pitch = n / threads;

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      S.r[i] = base[0];
      S.g[i] = base[1];
      S.b[i] = base[2];
      S.h[i] = 0.3;
      S.rough[i] = 0.92;
      // Find the nearest thread centre, including its wander.
      const t0 = Math.floor(x / pitch);
      let best = 9e9;
      let bestId = 0;
      for (let k = -1; k <= 1; k++) {
        const ti = ((t0 + k) % threads + threads) % threads;
        const h = hash1(ti, seed);
        const wander = Math.sin(v * 3.1 + h * 6.283) * pitch * 0.55 * v;
        const cxp = (t0 + k + 0.5) * pitch + wander;
        const d = Math.abs(x + 0.5 - cxp);
        if (d < best) { best = d; bestId = ti; }
      }
      const h = hash1(bestId, seed);
      const len = 0.55 + h * 0.45;
      const w = pitch * (0.22 + h * 0.1) * (1 - 0.35 * v);
      const inThread = 1 - smoothstep(w * 0.6, w, best);
      const alive = v < len ? 1 : 1 - smoothstep(len, len + 0.06, v);
      const a = inThread * alive;
      if (a <= 0) continue;
      const round = Math.cos((best / (w + 1e-6)) * 1.4);
      A[i] = a;
      const sh = (round - 0.5) * 0.12 + (hash1(bestId * 31 + (y | 0), seed) - 0.5) * 0.05;
      S.r[i] = clamp01(base[0] + sh);
      S.g[i] = clamp01(base[1] + sh);
      S.b[i] = clamp01(base[2] + sh * 0.9);
      S.h[i] = 0.35 + round * 0.5;
      S.rough[i] = 0.9 - round * 0.06;
    }
  }
  return finishSurface(S, {
    name: 'rugFringe',
    normalStrength: 1.1,
    heightScale: 0.002,
    tileMetres,
    wrap: 'repeat',
  });
}

// ══════════════════════════════════════════════════════ open weaves ══════

/**
 * Sheer voile for the curtains. Very fine open plain weave: mostly transparent between threads,
 * so backlight comes through textured rather than as flat white. Returns alpha in both the
 * albedo's A and a dedicated alphaMap.
 */
export function sheerVoile({ size = 512, seed = 26026, tileMetres = 0.04, threads = 46, colour = 0xf7f5f0, opacity = 0.45 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const A = S.useAlpha(0);
  const [px, sx] = latticeFor(n, 4);
  // Slub: low-frequency thread-density variation (3-6 cm bands) so the weave has something readable
  // at a 2+ m viewing distance instead of resolving to sub-pixel mush.
  const slub = lowFreqField(n, 6, (u, v) => fbmValue2(u * 3, v * 3, 3, seed + 51, 3));

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    const tv = v * threads;
    const fv = tv - Math.floor(tv);
    const thickV = 0.30 + hash1(Math.floor(tv) % threads, seed + 5) * 0.16;
    const weft = 1 - smoothstep(thickV * 0.55, thickV, Math.abs(fv - 0.5));
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      const tu = u * threads;
      const fu = tu - Math.floor(tu);
      const thickU = 0.30 + hash1(Math.floor(tu) % threads, seed + 9) * 0.16;
      const warp = 1 - smoothstep(thickU * 0.55, thickU, Math.abs(fu - 0.5));
      const cover = clamp01(warp + weft - warp * weft);
      const fuzz = valueNoise2(x * sx, y * sx, px, seed + 11);
      const sl = 0.85 + slub[i] * 0.3;
      const a = clamp01(cover * opacity * sl + 0.05 + (fuzz - 0.5) * 0.05);
      A[i] = a;
      const lift = (warp > weft ? warp : weft * 0.8) * 0.5;
      S.r[i] = clamp01(base[0] - (1 - cover) * 0.03);
      S.g[i] = clamp01(base[1] - (1 - cover) * 0.03);
      S.b[i] = clamp01(base[2] - (1 - cover) * 0.025);
      S.h[i] = 0.4 + lift + (fuzz - 0.5) * 0.1;
      S.rough[i] = 0.86 + (fuzz - 0.5) * 0.06;
    }
  }
  return finishSurface(S, {
    name: 'sheerVoile',
    normalStrength: 0.55,
    heightScale: 0.0005,
    tileMetres: [tileMetres, tileMetres],
  });
}

/**
 * The playpen's white mesh: a regular square open weave with rounded knitted threads and a real
 * alphaMap, so you can read the rug straight through it and it catches light as a grey-white veil.
 */
export function meshNet({ size = 512, seed = 27027, tileMetres = 0.05, cells = 10, threadRatio = 0.09, colour = 0xf2f2ef } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const A = S.useAlpha(0);
  const [px, sx] = latticeFor(n, 3);

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    const cv = v * cells;
    const fv = Math.abs((cv - Math.floor(cv)) - 0.5) * 2; // 0 at thread centre, 1 at hole centre
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      const cu = u * cells;
      const fu = Math.abs((cu - Math.floor(cu)) - 0.5) * 2;
      const inU = 1 - smoothstep(threadRatio * 0.7, threadRatio, fu);
      const inV = 1 - smoothstep(threadRatio * 0.7, threadRatio, fv);
      const cover = clamp01(inU + inV - inU * inV);
      const fuzz = valueNoise2(x * sx, y * sx, px, seed + 3);
      // Over/under: the warp thread rides over at alternating crossings.
      const over = (Math.floor(cu) + Math.floor(cv)) % 2 === 0 ? inU : inV;
      const round = Math.sqrt(clamp01(1 - (Math.min(fu, fv) / threadRatio) ** 2));
      // A real hole is not alpha 0: it is open weave with air behind it, and — critically — this
      // value has to survive mip averaging at distance without collapsing to either "invisible" or
      // "opaque card". A floor of 0.18 at hole centres and a ceiling of 0.85 on the thread means the
      // coarsest mip settles near the true ~72% open fraction instead of rounding to a flat value.
      A[i] = clamp01((0.18 + cover * 0.67) * (0.94 + (fuzz - 0.5) * 0.1));
      const sh = (round - 0.5) * 0.09 + (fuzz - 0.5) * 0.05;
      S.r[i] = clamp01(base[0] + sh);
      S.g[i] = clamp01(base[1] + sh);
      S.b[i] = clamp01(base[2] + sh * 0.95);
      S.h[i] = 0.35 + round * 0.5 + over * 0.12;
      S.rough[i] = 0.78 + (fuzz - 0.5) * 0.08;
    }
  }
  return finishSurface(S, {
    name: 'meshNet',
    normalStrength: 1.2,
    heightScale: 0.0012,
    tileMetres: [tileMetres, tileMetres],
  });
}

/**
 * Cane webbing for the rattan chair. Four strand families — warp, weft and both diagonals — woven
 * over and under, which is the "radio weave" pattern of a real caned seat and leaves the
 * characteristic octagonal open holes. Real alphaMap.
 *
 * The families must be integer combinations of (u, v): a true 60 degree family would project as
 * 0.866·v, which is irrational and can never close on itself, so the texture would seam. Integer
 * coefficients guarantee the pattern repeats exactly at the tile edge.
 */
export function rattanCane({ size = 512, seed = 28028, tileMetres = 0.06, strands = 6, colour = 0xc8a469 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const dark = hexToRgb(0x8a6a3a);
  const A = S.useAlpha(0);
  // [du, dv, pitch multiplier, half-width]: the diagonals are narrower, as they are on a real seat.
  const dirs = [
    [1, 0, 1, 0.19],
    [0, 1, 1, 0.19],
    [1, 1, 1, 0.13],
    [1, -1, 1, 0.13],
  ];
  const [px, sx] = latticeFor(n, 4);

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      let cover = 0;
      let top = -1;
      let topProf = 0;
      let topId = 0;
      for (let d = 0; d < 4; d++) {
        const dir = dirs[d];
        const w = dir[3];
        // Project onto the family's normal; the fractional part gives the distance to a strand.
        const p = (u * dir[0] + v * dir[1]) * strands * dir[2];
        const f = p - Math.floor(p);
        const dist = Math.abs(f - 0.5);
        if (dist > w) continue;
        const prof = Math.sqrt(clamp01(1 - (dist / w) ** 2));
        cover = clamp01(cover + prof * 0.9);
        // Weave order rotates per cell so no family is permanently on top.
        const cell = (Math.floor(p) + d * 2) % 3;
        const priority = prof + cell * 0.12;
        if (priority > topProf) { topProf = priority; top = d; topId = Math.floor(p); }
      }
      if (cover <= 0.02) {
        A[i] = 0;
        S.r[i] = base[0]; S.g[i] = base[1]; S.b[i] = base[2];
        S.h[i] = 0; S.rough[i] = 0.7;
        continue;
      }
      const fibre = valueNoise2(x * sx, y * sx, px, seed + top * 71);
      const tone = (hash1(topId + top * 17, seed) - 0.5) * 0.09;
      const prof = clamp01(topProf);
      A[i] = clamp01(cover * 1.4);
      S.r[i] = clamp01(mix(dark[0], base[0], prof) + tone + (fibre - 0.5) * 0.05);
      S.g[i] = clamp01(mix(dark[1], base[1], prof) + tone + (fibre - 0.5) * 0.05);
      S.b[i] = clamp01(mix(dark[2], base[2], prof) + tone * 0.9 + (fibre - 0.5) * 0.04);
      S.h[i] = 0.25 + prof * 0.65 + (fibre - 0.5) * 0.08;
      S.rough[i] = clamp01(0.58 - prof * 0.1 + (fibre - 0.5) * 0.08);
    }
  }
  return finishSurface(S, {
    name: 'rattanCane',
    normalStrength: 1.4,
    heightScale: 0.002,
    tileMetres: [tileMetres, tileMetres],
    ao: { radius: 0.04, scale: 6, strength: 0.8, size: 128 },
  });
}

// ═══════════════════════════════════════════════════════ toys & mats ═════

/**
 * Plush toy fuzz: short dense fibres, tintable, dead matte. The map's own colour is near-white —
 * DRESS tints each toy with `materials.tinted('fabric.plush', hex)`, which MULTIPLIES this map, so
 * anything but near-white here drags every toy tint toward mud. The toys are the one place in the
 * room allowed real saturation (CONTRACTS §8) — this map must not be the thing quietly stealing it.
 */
export function plushFuzz({ size = 256, seed = 29029, tileMetres = 0.04, colour = 0xf4f1ec } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const cells = 34;
  const [px, sx] = latticeFor(n, 2);
  const [px3, sx3] = latticeFor(n, 3);
  const [px5, sx5] = latticeFor(n, 5);
  const drift = lowFreqField(n, 6, (u, v) => fbmValue2(u * 5, v * 5, 5, seed + 3, 2));

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const cy = ((y + 0.5) / n) * cells;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const cx = ((x + 0.5) / n) * cells;
      const clump = loopField(cx, cy, cells, seed + 9, 0.1, 0.42, 0.7);
      const fine = valueNoise2(x * sx, y * sx, px, seed + 11);
      const fine2 = valueNoise2xy(x * sx3, y * sx5, px3, px5, seed + 13);
      const lit = clamp01(clump * 0.7 + fine * 0.3);
      const sh = (lit - 0.5) * 0.14 + (drift[i] - 0.5) * 0.06 + (fine2 - 0.5) * 0.05;
      S.r[i] = clamp01(base[0] + sh);
      S.g[i] = clamp01(base[1] + sh);
      S.b[i] = clamp01(base[2] + sh * 0.95);
      // Two relief scales — loop and fibre — so the normal carries both the clump structure and a
      // finer standalone fibre grain instead of one uniform pebbled amplitude.
      S.h[i] = clamp01(clump * 0.6 + (fine - 0.5) * 0.35 + (fine2 - 0.5) * 0.2 + 0.2);
      S.rough[i] = clamp01(0.96 - lit * 0.05 + (fine - 0.5) * 0.04);
    }
  }
  return finishSurface(S, {
    name: 'plushFuzz',
    normalStrength: 1.5,
    heightScale: 0.0025,
    tileMetres: [tileMetres, tileMetres],
    ao: { radius: 0.05, scale: 6, strength: 0.8, size: 128 },
  });
}

/**
 * The padded play mat inside the playpen: white/pale grey quilted ground with soft pale-blue and
 * sage printed shapes (circles, arcs, rounded bars) — the only gentle colour in the frame.
 */
export function playMatPrint({ size = 512, seed = 30030, tileMetres = 0.6 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const rnd = localRng(seed);
  const ground = hexToRgb(0xf2f2f0);
  const blue = hexToRgb(0xb9cfdd);
  const sage = hexToRgb(0xbfcbb4);
  const cream = hexToRgb(0xe8e2d6);
  const px = Math.max(2, Math.round(n / 2));

  // Quilted ground: diamond stitch grid puffing the panels between the seams. The grid is warped
  // before evaluation so the seams wander (no two cells identical), the seam itself is a soft
  // pucker rather than a hard grout trench, and a low-frequency layer adds a worn patch and a faint
  // stain so the mat is not a perfect, infinite, machine-printed tile — a padded mat gets sat on.
  const quilt = 3;
  const wear = lowFreqField(n, 6, (u, v) => fbmValue2(u * 3, v * 3, 3, seed + 61, 3));
  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v0 = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u0 = (x + 0.5) / n;
      const warpJ = (valueNoise2(x / 48, y / 48, Math.max(2, Math.round(n / 48)), seed + 71) - 0.5) * 0.035;
      const u = u0 + warpJ;
      const v = v0 + warpJ * 0.8;
      const a = (u + v) * quilt;
      const b = (u - v) * quilt;
      const da = Math.abs(a - Math.round(a));
      const db = Math.abs(b - Math.round(b));
      const seam = 1 - smoothstep(0.0, 0.14, Math.min(da, db));
      const puff = Math.min(1, Math.min(da, db) * 4);
      const grain = valueNoise2(x / 2, y / 2, px, seed + 5);
      const wearMask = smoothstep(0.55, 0.9, wear[i]);
      S.r[i] = clamp01(ground[0] - seam * 0.025 + (grain - 0.5) * 0.02 - wearMask * 0.04);
      S.g[i] = clamp01(ground[1] - seam * 0.025 + (grain - 0.5) * 0.02 - wearMask * 0.035);
      S.b[i] = clamp01(ground[2] - seam * 0.025 + (grain - 0.5) * 0.02 - wearMask * 0.02);
      S.h[i] = 0.35 + puff * 0.55 - seam * 0.3 + (grain - 0.5) * 0.06;
      S.rough[i] = 0.78 + (grain - 0.5) * 0.06 + seam * 0.05 + wearMask * 0.06;
    }
  }

  // Printed shapes. Everything is stamped with wrapping, so the print tiles.
  const cols = [blue, sage, cream];
  for (let k = 0; k < 9; k++) {
    const x = rnd() * n;
    const y = rnd() * n;
    const c = cols[k % 3];
    const r = (0.045 + rnd() * 0.07) * n;
    const kind = k % 3;
    if (kind === 0) {
      stampDiscRgb(S, x, y, r, c, 0.06, 0.9);
    } else if (kind === 1) {
      // Ring / arc.
      const steps = 64;
      for (let s = 0; s < steps; s++) {
        const a = (s / steps) * 6.283;
        stampDiscRgb(S, x + Math.cos(a) * r, y + Math.sin(a) * r, r * 0.16, c, 0.5, 0.85);
      }
    } else {
      // Rounded bar.
      const len = (0.06 + rnd() * 0.12) * n;
      const ang = rnd() * 3.1416;
      const w = r * 0.35;
      const steps = Math.ceil(len);
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        stampDiscRgb(S, x + Math.cos(ang) * len * t, y + Math.sin(ang) * len * t, w, c, 0.35, 0.9);
      }
    }
  }

  return finishSurface(S, {
    name: 'playMatPrint',
    normalStrength: 0.8,
    heightScale: 0.004,
    tileMetres: [tileMetres, tileMetres],
    ao: { radius: 0.04, scale: 5, strength: 0.35, size: 128 },
  });
}

/** Crinkled white muslin: fine plain weave plus soft irregular creases from being bunched up. */
export function muslinCrinkle({ size = 512, seed = 31031, tileMetres = 0.10, colour = 0xf4f1ea } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const threads = 40;
  const crease = lowFreqField(n, 4, (u, v) => ridged2(u * 5, v * 5, 5, seed + 3, 4, 2, 0.55));
  const px = Math.max(2, Math.round(n / 2));

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    const sv = Math.sin(v * 6.283 * threads);
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      const su = Math.sin(u * 6.283 * threads);
      const over = Math.sin((u + v) * 6.283 * threads) > 0;
      const weave = over ? su : sv;
      const fuzz = valueNoise2(x / 2, y / 2, px, seed + 7);
      const cr = crease[i];
      const sh = (weave) * 0.02 + (fuzz - 0.5) * 0.03 + (cr - 0.5) * 0.06;
      S.r[i] = clamp01(base[0] + sh);
      S.g[i] = clamp01(base[1] + sh);
      S.b[i] = clamp01(base[2] + sh * 0.95);
      S.h[i] = clamp01(0.45 + weave * 0.22 + (cr - 0.5) * 0.75 + (fuzz - 0.5) * 0.1);
      S.rough[i] = clamp01(0.88 + (fuzz - 0.5) * 0.06 - cr * 0.04);
    }
  }
  return finishSurface(S, {
    name: 'muslinCrinkle',
    normalStrength: 1.25,
    heightScale: 0.003,
    tileMetres: [tileMetres, tileMetres],
    ao: { radius: 0.05, scale: 5, strength: 0.7, size: 128 },
  });
}

/**
 * The playpen's padded tubular frame: warm beige/gold quilted nylon with a diamond stitch grid,
 * puffed panels and a fine ripstop weave. Slight sheen — it is a technical fabric, not wool.
 */
export function quiltedNylon({ size = 512, seed = 32032, tileMetres = 0.20, colour = 0xdfd0b5 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  // A quilt is quilted by NORMAL and AO, not by a 35%-luminance albedo swing — that swing is what
  // made the pen frame read as woven basket / chocolate lattice instead of warm beige padding.
  const dark = hexToRgb(0xc7b491);
  const quilt = 3;
  const rip = 34;
  const px = Math.max(2, Math.round(n / 2));
  const driftField = lowFreqField(n, 4, (u, v) => fbmValue2(u * 2, v * 2, 2, seed + 91, 3));

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      const a = (u + v) * quilt;
      const b = (u - v) * quilt;
      const da = Math.abs(a - Math.round(a));
      const db = Math.abs(b - Math.round(b));
      const dSeam = Math.min(da, db);
      const seam = 1 - smoothstep(0.0, 0.035, dSeam);
      const stitch = seam * (0.55 + 0.45 * Math.sin((u - v) * 6.283 * quilt * 22));
      const puff = Math.sin(Math.min(1, dSeam * 3.2) * 1.5708);
      // Ripstop: a faint reinforcing grid every few millimetres.
      const gridU = 1 - smoothstep(0.0, 0.06, Math.abs((u * rip) - Math.round(u * rip)));
      const gridV = 1 - smoothstep(0.0, 0.06, Math.abs((v * rip) - Math.round(v * rip)));
      const grid = clamp01(gridU + gridV);
      const fuzz = valueNoise2(x / 2, y / 2, px, seed + 5);
      const drift = (driftField[i] - 0.5) * 0.06;
      const t = clamp01(0.10 + (1 - puff) * 0.30 + seam * 0.22);
      S.r[i] = clamp01(mix(base[0], dark[0], t) + grid * 0.02 + (fuzz - 0.5) * 0.03 + drift);
      S.g[i] = clamp01(mix(base[1], dark[1], t) + grid * 0.02 + (fuzz - 0.5) * 0.03 + drift * 0.95);
      S.b[i] = clamp01(mix(base[2], dark[2], t) + grid * 0.018 + (fuzz - 0.5) * 0.03 + drift * 0.85);
      S.h[i] = clamp01(0.25 + puff * 0.65 - stitch * 0.45 + grid * 0.06 + (fuzz - 0.5) * 0.05);
      S.rough[i] = clamp01(0.62 - puff * 0.08 + stitch * 0.15 + (fuzz - 0.5) * 0.05);
    }
  }
  return finishSurface(S, {
    name: 'quiltedNylon',
    normalStrength: 0.85,
    heightScale: 0.0035,
    tileMetres: [tileMetres, tileMetres],
    ao: { radius: 0.05, scale: 6, strength: 0.45, size: 128 },
  });
}

/** Flat woven cotton (denim-ish twill) for the parent's clothes and flat cushions. */
export function twillCotton({ size = 256, seed = 33033, tileMetres = 0.08, colour = 0x39445c } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const threads = 44;
  const px = Math.max(2, Math.round(n / 2));
  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      // 2/1 twill: the float direction runs on the diagonal.
      const d = (u * threads + v * threads * 0.5);
      const tw = Math.sin(d * 6.283) * 0.5 + 0.5;
      const warp = Math.sin(u * 6.283 * threads) * 0.5 + 0.5;
      const weft = Math.sin(v * 6.283 * threads) * 0.5 + 0.5;
      const fuzz = valueNoise2(x / 2, y / 2, px, seed + 3);
      const lit = tw * 0.5 + warp * 0.25 + weft * 0.25;
      const sh = (lit - 0.5) * 0.12 + (fuzz - 0.5) * 0.05;
      S.r[i] = clamp01(base[0] + sh);
      S.g[i] = clamp01(base[1] + sh);
      S.b[i] = clamp01(base[2] + sh * 1.05);
      S.h[i] = clamp01(0.4 + (lit - 0.5) * 0.7 + (fuzz - 0.5) * 0.15);
      S.rough[i] = clamp01(0.84 - lit * 0.06 + (fuzz - 0.5) * 0.05);
    }
  }
  return finishSurface(S, {
    name: 'twillCotton',
    normalStrength: 1.1,
    heightScale: 0.0008,
    tileMetres: [tileMetres, tileMetres],
  });
}
