// OPERATION NAPTIME — module TEX — architectural surface generators.
//
// Concrete, plaster, floorboards, plywood (face + the laminated edge that sells self-built
// furniture), brick, marble, glazed ceramic, terracotta, soil, bark, artist's canvas.
//
// Shared strategy: broad low-frequency layers (damp staining, tone drift, glaze pooling) are
// evaluated on a coarse grid and bilinearly lifted — they are low frequency by definition, so
// paying full resolution for them is pure waste. Only genuinely high-frequency detail (aggregate,
// grain, speckle, weave) runs per texel. Everything wraps: seams, courses and plank rows are all
// integer divisions of the tile.

import {
  beginSurface, finishSurface, hexToRgb, lowFreqField, stampDisc, stampDiscRgb, stampLine,
} from './raster.js';
import {
  clamp01, fbmValue2, fbmValue2xy, hash1, hash2, latticeFor, mix, ridged2, ridged2xy, smoothstep,
  turbulence2, valueNoise2, blueNoisePoints, localRng, worley2, W, warp2,
} from './noise.js';

// ═════════════════════════════════════════════════════════ concrete ══════

/**
 * THE hero texture: board-formed raw concrete for the ceiling slab.
 * (a) cloudy damp staining — domain-warped fbm, high contrast, grey-green in the dark blotches;
 * (b) horizontal formwork board seams every 0.30 m, each board with its own tone, a leaked
 *     slurry fin on the seam and a shallow recess beside it, plus timber grain printed through;
 * (c) aggregate speckle and pinholes; (d) tie-rod holes and two hairline cracks.
 */
export function concreteBoardFormed({ size = 1024, seed = 1101, tileMetres = 3.4, boards = 12, stain = 1, tone = 1 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const rnd = localRng(seed);

  // — (a) staining: two warped fbm layers, computed coarse and lifted.
  const stainBroad = lowFreqField(n, 8, (u, v) => {
    const w = warp2(u * 3, v * 3, 3, seed, 0.85, 2);
    return fbmValue2(w.x, w.y, 3, seed + 17, 4, 2, 0.55);
  });
  const stainMid = lowFreqField(n, 4, (u, v) => {
    const w = warp2(u * 7, v * 7, 7, seed + 31, 0.6, 2);
    return fbmValue2(w.x, w.y, 7, seed + 41, 3, 2, 0.5);
  });
  // Very large scale bias so some tiles read damper than others (the near half of the slab).
  const bias = lowFreqField(n, 16, (u, v) => fbmValue2(u * 2, v * 2, 2, seed + 61, 2));

  // — (b) per-row board data.
  const bTone = new Float32Array(n);
  const bSeam = new Float32Array(n); // height contribution of the seam
  const bDark = new Float32Array(n); // albedo darkening near the seam
  const bIdx = new Int32Array(n);
  const bLocal = new Float32Array(n);
  const bPlane = new Float32Array(n); // out-of-plane offset — boards are never coplanar
  const pxPerBoard = n / boards;
  for (let y = 0; y < n; y++) {
    const v = (y + 0.5) / n;
    const p = v * boards;
    const bi = Math.floor(p) % boards;
    const bf = p - Math.floor(p);
    bIdx[y] = bi;
    bLocal[y] = bf;
    // Per-board tone: some boards were wetter, some were reused and left a darker print.
    bTone[y] = (hash1(bi, seed + 5) - 0.5) * 0.065 - (hash1(bi, seed + 9) > 0.78 ? 0.035 : 0);
    bPlane[y] = (hash1(bi, seed + 13) - 0.5) * 0.9;
    // Distance in px to the nearest seam (seams sit at board boundaries).
    const dPx = Math.min(bf, 1 - bf) * pxPerBoard;
    // Leaked slurry fin right on the joint, shallow suck-back recess either side of it.
    const fin = Math.exp(-(dPx * dPx) / 2.2) * 0.55;
    const recess = -Math.exp(-((dPx - 3.2) * (dPx - 3.2)) / 14) * 0.3;
    bSeam[y] = fin + recess;
    bDark[y] = Math.exp(-(dPx * dPx) / 26) * 0.16 + Math.exp(-(dPx * dPx) / 400) * 0.05;
  }

  // Chalky whitewash first, damp efflorescence blotches the exception — and the blotches are COOL
  // (b >= r) against a near-neutral base, never warm, or the slab reads as sepia timber instead of
  // concrete. r-b: pale +7, mid -2 (near neutral), dark -4 (cool).
  const pale = hexToRgb(0xe9e7e2);
  const mid = hexToRgb(0xa9aaa7);
  const dark = hexToRgb(0x686e6c); // cool grey damp
  const [p3, s3] = latticeFor(n, 3);
  const [p9, s9] = latticeFor(n, 9);

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const bi = bIdx[y];
    const bf = bLocal[y];
    const tn = bTone[y] * tone;
    const seamH = bSeam[y];
    const seamD = bDark[y];
    // Timber grain printed off the formwork board: long streaks along the board, unique per board.
    const grainY = bf * 5 + bi * 11.37;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;

      // Staining. The slab is chalky white FIRST — the damp blotches are the exception, not the
      // rule, so the thresholds are set high: roughly a fifth of the surface goes dark, a third
      // takes the mid grey, and the rest stays pale. Get this balance wrong and the ceiling reads
      // as camouflage instead of concrete.
      let st = stainBroad[i] * 0.62 + stainMid[i] * 0.38;
      st = clamp01((st - 0.5) * (1.25 + bias[i] * 0.8) + 0.5);
      const blotch = smoothstep(0.60, 0.86, st) * 0.76 * stain;
      const midMask = smoothstep(0.40, 0.66, st) * 0.66 * (1 - blotch * 0.7);

      // aggregate + a whisper of timber grain (this used to be the dominant term and is why the
      // slab read as barn wood — it is now a minor isotropic-leaning contribution, not the signal).
      const agg = valueNoise2(x * s3, y * s3, p3, seed + 3);
      const agg2 = valueNoise2(x * s9, y * s9, p9, seed + 4);
      const grain = fbmValue2(u * 26, grainY, 26, seed + 71, 2, 2, 0.5);

      let r = pale[0], g = pale[1], b = pale[2];
      r += (mid[0] - r) * midMask; g += (mid[1] - g) * midMask; b += (mid[2] - b) * midMask;
      r += (dark[0] - r) * blotch; g += (dark[1] - g) * blotch; b += (dark[2] - b) * blotch;
      const shade = tn + (agg - 0.5) * 0.075 + (agg2 - 0.5) * 0.05 + (grain - 0.5) * 0.028 - seamD;
      r = clamp01(r + shade); g = clamp01(g + shade * 0.98); b = clamp01(b + shade * 0.94);
      // Damp patches are very slightly greener and cooler.
      g += blotch * 0.012;
      S.r[i] = r; S.g[i] = g; S.b[i] = b;

      S.h[i] = 0.5 + seamH * 0.5 + (agg - 0.5) * 0.09 + (agg2 - 0.5) * 0.06 + (grain - 0.5) * 0.02 + (st - 0.5) * 0.03 + bPlane[y] * 0.06;
      // Chalky everywhere; damp blotches read markedly glossier (a wet sheen the whitewash never
      // has) so raking window light finds the stains instead of a uniformly matte field.
      S.rough[i] = clamp01(0.955 - blotch * 0.28 - midMask * 0.06 + (agg - 0.5) * 0.05 + seamD * 0.04);
    }
  }

  // — (c) pinholes and blowholes. They migrate to the top of the pour and to the board joints, not
  // an even blue-noise field — a uniform spread is what makes them read as printed wallpaper.
  const holeCandidates = Math.round(190 * (n / 1024) ** 2) + 30;
  const hp = blueNoisePoints(holeCandidates, seed + 202, 1);
  for (let i = 0; i < holeCandidates; i++) {
    const x = hp[i * 2] * n;
    const y = hp[i * 2 + 1] * n;
    const idx = (Math.min(n - 1, y | 0)) * n + Math.min(n - 1, x | 0);
    const bf = bLocal[Math.min(n - 1, y | 0)];
    const dPxSeam = Math.min(bf, 1 - bf) * pxPerBoard;
    if (!(stainBroad[idx] > 0.45 || dPxSeam < 6)) continue; // reject: keep only the top-of-pour bias
    const rr = (0.6 + hash1(i, seed + 5) ** 1.6 * 3.4) * (n / 1024);
    stampDisc(S.h, n, x, y, rr, -0.28, 0.75, 'add');
    stampDiscRgb(S, x, y, rr * 1.15, [0.30, 0.32, 0.32], 0.8, 0.35);
    stampDisc(S.rough, n, x, y, rr * 1.2, 0.99, 0.8, 'set');
  }

  // — (d) tie-rod holes on a jittered 3x2 grid, and hairline cracks.
  const tieR = 0.011 * n;
  for (let ty = 0; ty < 2; ty++) {
    for (let tx = 0; tx < 3; tx++) {
      const cx = ((tx + 0.5) / 3 + (rnd() - 0.5) * 0.08) * n;
      const cy = ((ty + 0.5) / 2 + (rnd() - 0.5) * 0.06) * n;
      stampDisc(S.h, n, cx, cy, tieR * 1.6, 0.06, 1, 'add'); // proud mortar plug ring
      stampDisc(S.h, n, cx, cy, tieR, -0.34, 0.6, 'add');
      stampDiscRgb(S, cx, cy, tieR * 1.7, [0.62, 0.61, 0.57], 0.9, 0.55);
      stampDiscRgb(S, cx, cy, tieR * 0.85, [0.3, 0.3, 0.29], 0.7, 0.75);
      stampDisc(S.rough, n, cx, cy, tieR * 1.6, 0.97, 0.9, 'set');
    }
  }

  // Hairline cracks: a periodic meander (sum of integer-harmonic sines) so both ends match.
  for (let c = 0; c < 2; c++) {
    const y0 = (0.22 + c * 0.46 + rnd() * 0.1) * n;
    const a1 = (0.012 + rnd() * 0.02) * n;
    const a2 = (0.006 + rnd() * 0.012) * n;
    const ph1 = rnd() * 6.283;
    const ph2 = rnd() * 6.283;
    const segs = 96;
    let px = 0;
    let py = y0 + Math.sin(ph1) * a1 + Math.sin(ph2) * a2;
    for (let s = 1; s <= segs; s++) {
      const t = s / segs;
      const x = t * n;
      const yy = y0 + Math.sin(t * 6.283 * 2 + ph1) * a1 + Math.sin(t * 6.283 * 5 + ph2) * a2 + (hash1(s, seed + c) - 0.5) * 2;
      const w = 0.8 * (n / 1024) * (0.6 + 0.8 * Math.abs(Math.sin(t * 6.283 * 3 + c)));
      stampLine(S.h, n, px, py, x, yy, w, -0.3, 'add');
      stampLine(S.r, n, px, py, x, yy, w, -0.16, 'add');
      stampLine(S.g, n, px, py, x, yy, w, -0.16, 'add');
      stampLine(S.b, n, px, py, x, yy, w, -0.15, 'add');
      px = x;
      py = yy;
    }
  }

  return finishSurface(S, {
    name: 'concreteBoardFormed',
    normalStrength: 1.35,
    heightScale: 0.006,
    tileMetres: [tileMetres, tileMetres],
    ao: { radius: 0.035, scale: 5, strength: 0.85 },
  });
}

// ══════════════════════════════════════════════════════════ plaster ══════

/** Near-white warm painted plaster: orange-peel roll texture, faint roller streaks, a few scuffs. */
export function plasterWall({ size = 512, seed = 2202, tileMetres = 2.0, colour = 0xece5da } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const rnd = localRng(seed);

  // Long vertical roller passes: high frequency across the wall, very low along it.
  const streak = lowFreqField(n, 4, (u, v) => fbmValue2(u * 34, v * 2, 34, seed + 3, 2, 2, 0.5));
  const drift = lowFreqField(n, 8, (u, v) => fbmValue2(u * 3, v * 3, 3, seed + 9, 3));
  // A coarse blotch mask so the roughness band actually has something to spread across — without
  // it the raw roughness field sits in a 6%-wide sliver and the recipe's roughness band collapses
  // to a flat wash no matter how wide it is authored.
  const blotch = lowFreqField(n, 3, (u, v) => fbmValue2(u * 2, v * 2, 2, seed + 51, 3));
  // Roller-lap seams: where one roller pass overlapped the last, every ~0.22 m.
  const lapFreq = Math.max(2, Math.round(tileMetres / 0.22));
  const [p2, s2] = latticeFor(n, 2);
  const [p5, s5] = latticeFor(n, 5);

  for (let y = 0; y < n; y++) {
    const row = y * n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      // Orange peel: two octaves of very fine value noise, tiny amplitude.
      const peel = valueNoise2(x * s2, y * s2, p2, seed + 21) * 0.6 + valueNoise2(x * s5, y * s5, p5, seed + 22) * 0.4;
      const lap = Math.abs(Math.sin(u * Math.PI * lapFreq));
      const lapBand = 1 - smoothstep(0.0, 0.1, lap);
      const s = (streak[i] - 0.5) * 0.02 + (drift[i] - 0.5) * 0.025 - lapBand * 0.02;
      S.r[i] = clamp01(base[0] + s + (peel - 0.5) * 0.012);
      S.g[i] = clamp01(base[1] + s + (peel - 0.5) * 0.012);
      S.b[i] = clamp01(base[2] + s * 0.9 + (peel - 0.5) * 0.012);
      S.h[i] = 0.5 + (peel - 0.5) * 0.5 + (streak[i] - 0.5) * 0.12 - lapBand * 0.05;
      // Roughness now genuinely spans the raw 0..1 range (a coarse blotch field, not a ±0.03
      // wobble around a fixed constant) so the material's authored band can produce a real raking
      // sheen instead of a 1%-wide flat wash.
      S.rough[i] = clamp01(0.5 + (blotch[i] - 0.5) * 0.62 + (peel - 0.5) * 0.16 - (streak[i] - 0.5) * 0.12 + lapBand * 0.12);
    }
  }

  // Scuffs: shallow grey smears, slightly burnished (lower roughness) — shoes and pram wheels.
  for (let s = 0; s < 5; s++) {
    const x = rnd() * n;
    const y = rnd() * n;
    const ang = (rnd() - 0.5) * 0.6;
    const len = (0.05 + rnd() * 0.09) * n;
    const w = (0.006 + rnd() * 0.008) * n;
    const grey = [0.66, 0.645, 0.62];
    const steps = Math.ceil(len);
    for (let t = 0; t <= steps; t++) {
      const f = t / steps;
      const px = x + Math.cos(ang) * len * f;
      const py = y + Math.sin(ang) * len * f;
      const fade = Math.sin(f * Math.PI);
      stampDiscRgb(S, px, py, w, grey, 1, 0.22 * fade);
      stampDisc(S.rough, n, px, py, w, 0.9, 1, 'set');
    }
  }

  return finishSurface(S, {
    name: 'plasterWall',
    normalStrength: 0.5,
    heightScale: 0.0008,
    tileMetres: [tileMetres, tileMetres],
  });
}

// ════════════════════════════════════════════════════════ wood floor ═════

/**
 * Wide dark-honey floorboards: cathedral figure from a wandering growth centre, straight grain
 * lines, per-plank tone, chamfered seams, staggered end joints and micro-scuffs. The roughness
 * map does most of the work — the floor is matte except where the window light rakes it.
 */
export function woodFloorPlank({ size = 1024, seed = 3303, plankRows = 4, tileMetres = [2.4, 0.76], colour = 0x8a6a4a } = {}) {
  const S = beginSurface(size);
  const n = size;
  const rnd = localRng(seed);
  const rowH = n / plankRows;

  const light = hexToRgb(colour);
  const dark = hexToRgb(0x54371f);
  const sap = hexToRgb(0xa9855e);

  // Per-row plank layout: two planks per row with a staggered joint.
  const rowJoint = new Float32Array(plankRows);
  const rowTone = new Float32Array(plankRows);
  for (let r = 0; r < plankRows; r++) {
    rowJoint[r] = 0.22 + r * 0.19 + rnd() * 0.08;
    rowTone[r] = (rnd() - 0.5) * 0.12;
  }
  const drift = lowFreqField(n, 8, (u, v) => fbmValue2(u * 4, v * 4, 4, seed + 5, 3));

  // Per (row, column) tables: the growth-centre wander, the end-joint seam, the plank id and the
  // position along the board only depend on x and the row index, so the sines, the exp and the
  // divisions come out of the 1M-iteration inner loop and into a 4 x size table.
  const tCentre = new Float32Array(plankRows * n);
  const tEndSeam = new Float32Array(plankRows * n);
  const tAlong = new Float32Array(plankRows * n);
  const tPlank = new Int32Array(plankRows * n);
  for (let r = 0; r < plankRows; r++) {
    const cd = r * 3.7;
    const j = rowJoint[r];
    const off = r * n;
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n;
      tCentre[off + x] = 0.5 + 0.3 * Math.sin(u * 6.283 * 2 + cd) + 0.12 * Math.sin(u * 6.283 * 5 + cd * 2);
      const endDist = Math.min(Math.abs(u - j), Math.abs(u - j + 1), Math.abs(u - j - 1), u, 1 - u) * n;
      tEndSeam[off + x] = Math.exp(-(endDist * endDist) / 3.0);
      tAlong[off + x] = u < j ? u / j : (u - j) / (1 - j);
      tPlank[off + x] = r * 7 + (u < j ? 0 : 1);
    }
  }

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const rp = y / rowH;
    const ri = Math.floor(rp) % plankRows;
    const rf = rp - Math.floor(rp);
    const dSeamPx = Math.min(rf, 1 - rf) * rowH;
    const seam = Math.exp(-(dSeamPx * dSeamPx) / 3.5);
    const chamfer = Math.exp(-(dSeamPx * dSeamPx) / 30);
    const tOff = ri * n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      const along = tAlong[tOff + x];
      const plankId = tPlank[tOff + x];
      const endSeam = tEndSeam[tOff + x];

      // Cathedral figure: rings around a growth centre that wanders along the plank.
      const centre = tCentre[tOff + x];
      const warp = fbmValue2(u * 9, rf * 7 + plankId * 3.1, 9, seed + 11, 2, 2, 0.5) - 0.5;
      const d = Math.abs(rf - centre) + warp * 0.09;
      const rings = Math.abs(Math.sin(d * 26 + warp * 2.2));
      const figure = 1 - smoothstep(0.0, 0.42, rings); // dark cathedral bands
      // Straight fine grain lines running the length of the board.
      const fine = fbmValue2(u * 12, rf * 46 + plankId * 5.7, 12, seed + 13, 2, 2, 0.55);
      const pore = valueNoise2(u * n * 0.5, rf * 140 + plankId * 9, Math.max(2, Math.round(n * 0.5)), seed + 15);

      let t = clamp01(0.36 + figure * 0.55 + (fine - 0.5) * 0.5 + (drift[i] - 0.5) * 0.25);
      let r = mix(light[0], dark[0], t);
      let g = mix(light[1], dark[1], t);
      let b = mix(light[2], dark[2], t);
      // A little sapwood lightening toward the plank edges.
      const edgeLight = smoothstep(0.28, 0.02, Math.min(rf, 1 - rf)) * 0.35;
      r = mix(r, sap[0], edgeLight); g = mix(g, sap[1], edgeLight); b = mix(b, sap[2], edgeLight);
      const tone = rowTone[ri] + (hash1(plankId, seed + 21) - 0.5) * 0.1 + (along - 0.5) * 0.02;
      const seamDark = (seam * 0.55 + endSeam * 0.5 + chamfer * 0.12);
      S.r[i] = clamp01(r + tone - seamDark * 0.36);
      S.g[i] = clamp01(g + tone * 0.95 - seamDark * 0.3);
      S.b[i] = clamp01(b + tone * 0.85 - seamDark * 0.24);

      S.h[i] = 0.62 - seam * 0.5 - endSeam * 0.45 - chamfer * 0.12 + (pore - 0.5) * 0.1 - figure * 0.05 + (fine - 0.5) * 0.06;
      // Satin sheen: open pores and the cathedral bands sit slightly rougher, seams rougher still.
      S.rough[i] = clamp01(0.5 + figure * 0.06 + (pore - 0.5) * 0.09 + (drift[i] - 0.5) * 0.16 + seam * 0.22 + endSeam * 0.2);
    }
  }

  // Micro-scuffs: short bright scratches, mostly along the boards.
  const scuffs = 46;
  for (let s = 0; s < scuffs; s++) {
    const x = rnd() * n;
    const y = rnd() * n;
    const ang = (rnd() - 0.5) * 0.5 + (rnd() < 0.15 ? 1.57 : 0);
    const len = (0.02 + rnd() * 0.07) * n;
    const w = 0.6 * (n / 1024) + rnd() * 0.6;
    const x2 = x + Math.cos(ang) * len;
    const y2 = y + Math.sin(ang) * len;
    stampLine(S.rough, n, x, y, x2, y2, w, 0.16, 'add');
    stampLine(S.r, n, x, y, x2, y2, w, 0.05, 'add');
    stampLine(S.g, n, x, y, x2, y2, w, 0.045, 'add');
    stampLine(S.b, n, x, y, x2, y2, w, 0.04, 'add');
    stampLine(S.h, n, x, y, x2, y2, w, -0.04, 'add');
  }

  return finishSurface(S, {
    name: 'woodFloorPlank',
    normalStrength: 0.8,
    heightScale: 0.0025,
    tileMetres,
    ao: { radius: 0.02, scale: 4, strength: 0.6 },
  });
}

// ══════════════════════════════════════════════════════════ plywood ══════

/** Birch plywood face veneer: long straight grain, faint lathe streaks, occasional small knot. */
export function plywoodBirch({ size = 512, seed = 4404, tileMetres = [0.6, 0.6], colour = 0xdfc49b } = {}) {
  const S = beginSurface(size);
  const n = size;
  const rnd = localRng(seed);
  const base = hexToRgb(colour);
  const dark = hexToRgb(0xa8845a);
  const drift = lowFreqField(n, 8, (u, v) => fbmValue2(u * 3, v * 3, 3, seed + 7, 3));

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      // Grain runs along +u: low frequency along (stretched so the figure reads as continuous
      // rotary-cut veneer rather than a row of short dashes), high frequency across.
      const g1 = fbmValue2(u * 2, v * 80, 2, seed + 11, 2, 2, 0.5);
      const g2 = valueNoise2(u * 10, v * 220, 10, seed + 13);
      const grain = g1 * 0.62 + g2 * 0.38;
      const line = smoothstep(0.42, 0.92, grain);
      const t = clamp01(line * 0.75 + (drift[i] - 0.5) * 0.4);
      S.r[i] = clamp01(mix(base[0], dark[0], t));
      S.g[i] = clamp01(mix(base[1], dark[1], t));
      S.b[i] = clamp01(mix(base[2], dark[2], t));
      S.h[i] = 0.5 + (grain - 0.5) * 0.35;
      S.rough[i] = clamp01(0.64 + (grain - 0.5) * 0.1 + (drift[i] - 0.5) * 0.12);
    }
  }

  // A couple of small knots / mineral streaks — birch ply is clean but never perfect.
  for (let k = 0; k < 3; k++) {
    const x = rnd() * n;
    const y = rnd() * n;
    const rr = (0.01 + rnd() * 0.018) * n;
    for (let ring = 0; ring < 4; ring++) {
      stampDiscRgb(S, x, y, rr * (1 - ring * 0.18), [0.55 - ring * 0.03, 0.42 - ring * 0.02, 0.27], 0.7, 0.35);
    }
    stampDisc(S.h, n, x, y, rr, -0.12, 0.8, 'add');
    stampDisc(S.rough, n, x, y, rr, 0.74, 0.8, 'set');
  }

  return finishSurface(S, {
    name: 'plywoodBirch',
    normalStrength: 0.6,
    heightScale: 0.0006,
    tileMetres,
  });
}

/**
 * The exposed laminated edge of 18 mm birch ply — the detail that makes self-built furniture read
 * as self-built. 15 alternating plies: face-parallel plies show smooth long grain, the cross plies
 * show choppy end grain; every ply boundary carries a thin glossy amber glue line, and the core
 * plies have the occasional void.
 */
export function plywoodEdge({ size = 512, seed = 5505, plies = 15, tileMetres = [0.06, 0.018] } = {}) {
  const S = beginSurface(size);
  const n = size;
  const rnd = localRng(seed);
  const light = hexToRgb(0xe3cda6);
  const cross = hexToRgb(0xc8ac82);
  const glue = hexToRgb(0x9a7443);
  const pxPerPly = n / plies;

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const p = ((y + 0.5) / n) * plies;
    const pi = Math.floor(p) % plies;
    const pf = p - Math.floor(p);
    const isCross = pi % 2 === 1;
    const dGlue = Math.min(pf, 1 - pf) * pxPerPly;
    const glueLine = Math.exp(-(dGlue * dGlue) / (0.55 * (n / 512) ** 2 + 0.9));
    // Wider per-ply contrast — the lamination read is the whole point of this texture, and a 6%
    // jitter disappears at any real viewing distance.
    const plyTone = (hash1(pi, seed + 3) - 0.5) * 0.11;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      let r, g, b, rough, h;
      if (isCross) {
        // End grain: short choppy flecks, darker and more open.
        const fleck = fbmValue2(u * 26, pf * 6 + pi * 4.3, 26, seed + 11, 2, 2, 0.5);
        const fine = valueNoise2(u * 90, pf * 26 + pi * 7.1, 90, seed + 12);
        const t = clamp01(smoothstep(0.5, 0.85, fleck) * 0.8 + (fine - 0.5) * 0.5);
        r = mix(cross[0], 0.42, t * 0.55);
        g = mix(cross[1], 0.33, t * 0.55);
        b = mix(cross[2], 0.23, t * 0.55);
        rough = 0.78 + (fine - 0.5) * 0.1;
        h = 0.46 + (fleck - 0.5) * 0.22 + (fine - 0.5) * 0.12;
      } else {
        // Long grain seen from the side: fine parallel lines.
        const gr = fbmValue2(u * 60, pf * 3 + pi * 2.7, 60, seed + 21, 2, 2, 0.5);
        const t = clamp01(smoothstep(0.55, 0.9, gr) * 0.7);
        r = mix(light[0], 0.55, t * 0.5);
        g = mix(light[1], 0.42, t * 0.5);
        b = mix(light[2], 0.28, t * 0.5);
        rough = 0.68 + (gr - 0.5) * 0.08;
        h = 0.56 + (gr - 0.5) * 0.14;
      }
      const gl = glueLine;
      S.r[i] = clamp01(mix(r, glue[0], gl * 0.7) + plyTone);
      S.g[i] = clamp01(mix(g, glue[1], gl * 0.7) + plyTone);
      S.b[i] = clamp01(mix(b, glue[2], gl * 0.7) + plyTone * 0.9);
      S.h[i] = h - gl * 0.28;
      S.rough[i] = clamp01(mix(rough, 0.42, gl * 0.8)); // cured glue is glossy
    }
  }

  // Voids: the little dark gaps in the core plies that no amount of sanding removes.
  const voids = 10;
  for (let k = 0; k < voids; k++) {
    const pi = 1 + 2 * Math.floor(rnd() * ((plies - 1) / 2));
    const y = (pi + 0.5) * pxPerPly + (rnd() - 0.5) * pxPerPly * 0.4;
    const x = rnd() * n;
    const w = (0.006 + rnd() * 0.02) * n;
    const hgt = pxPerPly * (0.2 + rnd() * 0.35);
    for (let t = 0; t <= w; t += 1) {
      const f = t / w;
      const rr = hgt * 0.5 * Math.sin(f * Math.PI);
      if (rr < 0.5) continue;
      stampDisc(S.h, n, x + t, y, rr, -0.4, 0.5, 'add');
      stampDiscRgb(S, x + t, y, rr, [0.16, 0.13, 0.1], 0.5, 0.85);
    }
  }

  return finishSurface(S, {
    name: 'plywoodEdge',
    normalStrength: 1.4,
    heightScale: 0.0012,
    tileMetres,
    ao: { radius: 0.03, scale: 5, strength: 0.7, size: 128 },
  });
}

// ════════════════════════════════════════════════════════════ brick ══════

/**
 * Red-brick facade for the building across the street — seen through the glazing and out of
 * focus, so it is generated small. Running bond, 215x65 mm bricks with 10 mm recessed mortar.
 */
export function brickExterior({ size = 512, seed = 6606, tileMetres = [0.90, 0.60], courses = 8, perCourse = 4 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const mortar = hexToRgb(0xb5aea1);
  const palette = [0x8d4a35, 0xa35c40, 0x7c3f2e, 0x9c5335, 0xb0704e, 0x6b3527].map(hexToRgb);
  const courseH = n / courses;
  const brickW = n / perCourse;
  const jointPx = (0.010 / (tileMetres[1] / courses)) * courseH * 0.5;
  const [pp2, sp2] = latticeFor(n, 2);

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const cp = ((y + 0.5) / n) * courses;
    const ci = Math.floor(cp) % courses;
    const cf = cp - Math.floor(cp);
    const dH = Math.min(cf, 1 - cf) * courseH;
    const offset = ci % 2 === 0 ? 0 : 0.5;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      const bp = u * perCourse - offset;
      const bi = Math.floor(bp + perCourse) % perCourse;
      const bf = bp - Math.floor(bp);
      const dV = Math.min(bf, 1 - bf) * brickW;
      const inMortar = Math.min(dH, dV) < jointPx;
      const col = palette[(bi + ci * 3 + ((bi * 7 + ci * 13) % 5)) % palette.length];
      const jitterTone = (hash2(bi, ci, seed) - 0.5) * 0.09;
      const speck = valueNoise2(x * sp2, y * sp2, pp2, seed + 5);
      const face = fbmValue2(u * 30, ((y + 0.5) / n) * 30, 30, seed + 9, 3);
      if (inMortar) {
        const m = 1 - smoothstep(jointPx * 0.4, jointPx, Math.min(dH, dV));
        const sand = speck * 0.12 - 0.06;
        S.r[i] = clamp01(mix(col[0] + jitterTone, mortar[0] + sand, m));
        S.g[i] = clamp01(mix(col[1] + jitterTone, mortar[1] + sand, m));
        S.b[i] = clamp01(mix(col[2] + jitterTone, mortar[2] + sand, m));
        S.h[i] = 0.62 - m * 0.42 + (speck - 0.5) * 0.08;
        S.rough[i] = 0.94 + (speck - 0.5) * 0.04;
      } else {
        const burnt = hash2(bi, ci, seed + 3) > 0.86 ? 0.1 : 0;
        S.r[i] = clamp01(col[0] + jitterTone + (face - 0.5) * 0.1 + (speck - 0.5) * 0.05 - burnt);
        S.g[i] = clamp01(col[1] + jitterTone + (face - 0.5) * 0.09 + (speck - 0.5) * 0.05 - burnt);
        S.b[i] = clamp01(col[2] + jitterTone + (face - 0.5) * 0.08 + (speck - 0.5) * 0.05 - burnt * 0.6);
        S.h[i] = 0.66 + (face - 0.5) * 0.12 + (speck - 0.5) * 0.06;
        S.rough[i] = 0.87 + (face - 0.5) * 0.09;
      }
    }
  }

  return finishSurface(S, {
    name: 'brickExterior',
    normalStrength: 1.2,
    heightScale: 0.012,
    tileMetres,
    ao: { radius: 0.05, scale: 6, strength: 0.9, size: 128 },
  });
}

// ═════════════════════════════════════════════════════ stone & ceramic ═══

/** Polished white marble for the round side table: soft clouding plus two families of veins. */
export function marbleWhite({ size = 512, seed = 7707, tileMetres = [0.6, 0.6] } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(0xf3f1ec);
  const vein = hexToRgb(0x84837f);
  const warm = hexToRgb(0xe4ddd0);

  const cloud = lowFreqField(n, 6, (u, v) => fbmValue2(u * 4, v * 4, 4, seed + 3, 3));
  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      const t1 = turbulence2(u * 5, v * 5, 5, seed + 11, 4, 2, 0.55);
      const t2 = turbulence2(u * 9, v * 9, 9, seed + 17, 3, 2, 0.5);
      // Veins are thin bands where a sine of a turbulence-warped coordinate crosses zero.
      const s1 = Math.abs(Math.sin(Math.PI * (u * 2 + v * 1 + t1 * 3.4)));
      const s2 = Math.abs(Math.sin(Math.PI * (u * 3 - v * 4 + t2 * 2.2)));
      const v1 = (1 - smoothstep(0.0, 0.17, s1)) * 0.95;
      const v2 = (1 - smoothstep(0.0, 0.26, s2)) * 0.45;
      const halo = (1 - smoothstep(0.0, 0.45, s1)) * 0.3;
      const vm = clamp01(v1 + v2 * 0.7 + halo * 0.5);
      const wm = (cloud[i] - 0.5) * 0.5 + 0.2;
      let r = mix(base[0], warm[0], clamp01(wm));
      let g = mix(base[1], warm[1], clamp01(wm));
      let b = mix(base[2], warm[2], clamp01(wm));
      S.r[i] = clamp01(mix(r, vein[0], vm));
      S.g[i] = clamp01(mix(g, vein[1], vm));
      S.b[i] = clamp01(mix(b, vein[2], vm));
      S.h[i] = 0.5 - vm * 0.12 + (cloud[i] - 0.5) * 0.06;
      S.rough[i] = clamp01(0.14 + vm * 0.1 + (cloud[i] - 0.5) * 0.05);
    }
  }
  return finishSurface(S, {
    name: 'marbleWhite',
    normalStrength: 0.25,
    heightScale: 0.0004,
    tileMetres,
  });
}

/** Glossy white ceramic glaze with pooling in the hollows, faint crazing and a few pinholes. */
export function ceramicGlaze({ size = 512, seed = 8808, tileMetres = [0.25, 0.25], colour = 0xf5f2ec, poolColour = 0xdfe2dc } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const pooled = hexToRgb(poolColour);
  const rnd = localRng(seed);

  const flow = lowFreqField(n, 6, (u, v) => fbmValue2(u * 4, v * 4, 4, seed + 5, 3, 2, 0.55));
  const craze = lowFreqField(n, 2, (u, v) => ridged2(u * 14, v * 14, 14, seed + 9, 3, 2, 0.5));
  for (let y = 0; y < n; y++) {
    const row = y * n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const p = smoothstep(0.35, 0.75, flow[i]);
      const cz = smoothstep(0.72, 0.95, craze[i]) * 0.25;
      S.r[i] = clamp01(mix(base[0], pooled[0], p * 0.8) - cz * 0.05);
      S.g[i] = clamp01(mix(base[1], pooled[1], p * 0.8) - cz * 0.05);
      S.b[i] = clamp01(mix(base[2], pooled[2], p * 0.8) - cz * 0.04);
      S.h[i] = 0.5 + (flow[i] - 0.5) * 0.35 - cz * 0.3;
      S.rough[i] = clamp01(0.1 - p * 0.045 + (flow[i] - 0.5) * 0.05 + cz * 0.25);
    }
  }
  const holes = Math.round(50 * (n / 512) ** 2);
  for (let k = 0; k < holes; k++) {
    const x = rnd() * n;
    const y = rnd() * n;
    const rr = (0.6 + rnd() * 1.8) * (n / 512);
    stampDisc(S.h, n, x, y, rr, -0.3, 0.7, 'add');
    stampDisc(S.rough, n, x, y, rr * 1.3, 0.55, 0.8, 'set');
  }
  return finishSurface(S, {
    name: 'ceramicGlaze',
    normalStrength: 0.45,
    heightScale: 0.0006,
    tileMetres,
  });
}

/** Unglazed terracotta: grog speckle, faint throwing rings, chalky matte finish. */
export function terracotta({ size = 512, seed = 9909, tileMetres = [0.3, 0.3], colour = 0xb0653f } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const pale = hexToRgb(0xcb8a63);
  const drift = lowFreqField(n, 6, (u, v) => fbmValue2(u * 4, v * 4, 4, seed + 3, 3));
  const [p2, s2] = latticeFor(n, 2);
  const [p6, s6] = latticeFor(n, 6);

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    // Throwing rings: subtle horizontal ridges left by the wheel.
    const ring = Math.sin(v * 6.283 * 34) * 0.5 + Math.sin(v * 6.283 * 17 + 1.2) * 0.5;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const grog = valueNoise2(x * s2, y * s2, p2, seed + 11);
      const coarse = valueNoise2(x * s6, y * s6, p6, seed + 13);
      const lightSpeck = smoothstep(0.86, 1.0, grog) * 0.5;
      const darkSpeck = smoothstep(0.86, 1.0, 1 - grog) * 0.35;
      const t = (drift[i] - 0.5) * 0.45 + (coarse - 0.5) * 0.2 + ring * 0.03;
      S.r[i] = clamp01(mix(base[0], pale[0], clamp01(t + 0.4)) + lightSpeck * 0.25 - darkSpeck * 0.2);
      S.g[i] = clamp01(mix(base[1], pale[1], clamp01(t + 0.4)) + lightSpeck * 0.25 - darkSpeck * 0.17);
      S.b[i] = clamp01(mix(base[2], pale[2], clamp01(t + 0.4)) + lightSpeck * 0.24 - darkSpeck * 0.14);
      S.h[i] = 0.5 + ring * 0.12 + (grog - 0.5) * 0.3 + (coarse - 0.5) * 0.15;
      S.rough[i] = clamp01(0.86 + (grog - 0.5) * 0.08 - ring * 0.02);
    }
  }
  return finishSurface(S, {
    name: 'terracotta',
    normalStrength: 0.9,
    heightScale: 0.0012,
    tileMetres,
    ao: { radius: 0.02, scale: 4, strength: 0.5, size: 128 },
  });
}

// ═══════════════════════════════════════════════════════════ nature ══════

/** Potting soil: dark clumps, small stones and pale perlite specks. */
export function soil({ size = 256, seed = 12012, tileMetres = [0.25, 0.25] } = {}) {
  const S = beginSurface(size);
  const n = size;
  const rnd = localRng(seed);
  const dark = hexToRgb(0x2f231a);
  const mid = hexToRgb(0x4a382a);
  const cells = Math.max(4, Math.round(n / 22));
  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      worley2(u * cells, v * cells, cells, seed, 1);
      const clump = clamp01(1 - W.f1 * 1.4);
      const fine = fbmValue2(u * 24, v * 24, 24, seed + 7, 3);
      const t = clamp01(clump * 0.7 + (fine - 0.5) * 0.6);
      S.r[i] = clamp01(mix(dark[0], mid[0], t));
      S.g[i] = clamp01(mix(dark[1], mid[1], t));
      S.b[i] = clamp01(mix(dark[2], mid[2], t));
      S.h[i] = clamp01(0.35 + clump * 0.5 + (fine - 0.5) * 0.4);
      S.rough[i] = 0.93 + (fine - 0.5) * 0.06;
    }
  }
  for (let k = 0; k < 60; k++) {
    const x = rnd() * n;
    const y = rnd() * n;
    const rr = (0.004 + rnd() * 0.01) * n;
    const pale = rnd() > 0.5;
    stampDiscRgb(S, x, y, rr, pale ? [0.78, 0.76, 0.72] : [0.13, 0.1, 0.08], 0.5, 0.9);
    stampDisc(S.h, n, x, y, rr, pale ? 0.12 : -0.1, 0.6, 'add');
  }
  return finishSurface(S, {
    name: 'soil',
    normalStrength: 1.5,
    heightScale: 0.006,
    tileMetres,
    ao: { radius: 0.06, scale: 6, strength: 1, size: 128 },
  });
}

/** Bark for the bare winter trees outside and the plant stems: deep vertical ridges. */
export function bark({ size = 256, seed = 13013, tileMetres = [0.35, 0.7] } = {}) {
  const S = beginSurface(size);
  const n = size;
  const dark = hexToRgb(0x3b3229);
  const light = hexToRgb(0x6d6252);
  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      // Ridges are stretched along v — the trunk direction.
      const r1 = ridged2xy(u * 14, v * 3, 14, 3, seed + 3, 4, 2, 0.5);
      const r2 = fbmValue2xy(u * 40, v * 9, 40, 9, seed + 5, 2);
      const t = clamp01(r1 * 0.9 + (r2 - 0.5) * 0.5);
      S.r[i] = clamp01(mix(dark[0], light[0], t));
      S.g[i] = clamp01(mix(dark[1], light[1], t));
      S.b[i] = clamp01(mix(dark[2], light[2], t));
      S.h[i] = clamp01(t);
      S.rough[i] = 0.92 + (r2 - 0.5) * 0.06;
    }
  }
  return finishSurface(S, {
    name: 'bark',
    normalStrength: 1.6,
    heightScale: 0.008,
    tileMetres,
    ao: { radius: 0.05, scale: 6, strength: 1, size: 128 },
  });
}

// ═══════════════════════════════════════════════════════════ artwork ═════

/** Primed linen canvas weave — the substrate for the framed artwork. */
export function canvasWeave({ size = 256, seed = 14014, tileMetres = [0.06, 0.06], colour = 0xefe9dd } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const threads = 26;
  const [pc2, sc2] = latticeFor(n, 2);
  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      const su = Math.sin(u * 6.283 * threads);
      const sv = Math.sin(v * 6.283 * threads);
      // Plain weave: warp on top where sin(u+v) is positive, weft elsewhere.
      const over = Math.sin(u * 6.283 * threads + v * 6.283 * threads) > 0;
      const h = over ? 0.5 + su * 0.4 : 0.5 + sv * 0.4;
      const fuzz = valueNoise2(x * sc2, y * sc2, pc2, seed + 3);
      S.r[i] = clamp01(base[0] + (h - 0.5) * 0.08 + (fuzz - 0.5) * 0.03);
      S.g[i] = clamp01(base[1] + (h - 0.5) * 0.08 + (fuzz - 0.5) * 0.03);
      S.b[i] = clamp01(base[2] + (h - 0.5) * 0.075 + (fuzz - 0.5) * 0.03);
      S.h[i] = h * 0.8 + (fuzz - 0.5) * 0.15;
      S.rough[i] = 0.88 + (fuzz - 0.5) * 0.06;
    }
  }
  return finishSurface(S, {
    name: 'canvasWeave',
    normalStrength: 0.8,
    heightScale: 0.0006,
    tileMetres,
  });
}

/**
 * The specific abstract canvas leaning on the shelving in the reference photo: a soft yellow
 * triangular wedge and a magenta/violet rounded blob with darker speckles, on off-white, painted
 * over visible canvas weave with slightly irregular edges. NOT tileable — one texture, one canvas.
 */
export function abstractArtwork({ size = 1024, seed = 15015 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const rnd = localRng(seed);
  const ground = hexToRgb(0xece7db);
  const yellow = hexToRgb(0xe8c25a);
  const magenta = hexToRgb(0xa8407a);
  const violet = hexToRgb(0x6d3f86);
  const threads = Math.max(8, Math.round(n / 8));
  const slubEvery = 17;

  // Ground: canvas weave + brush drag. The weave is INTERLEAVED (warp rides over where
  // sin(u+v) > 0, weft elsewhere), not a separable sum of the two axes — a separable sum produces a
  // perfect checkerboard of dots (a window-screen gingham, sitting right at Nyquist and moiréing),
  // where a real weave has one thread family on top at a time. Amplitude is deliberately tiny; the
  // brush-drag fbm below carries most of the visible surface character.
  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    const tv = v * threads;
    const tvi = Math.floor(tv);
    const jv = 0.7 + hash1(tvi, seed + 91) * 0.6; // ±30% per-thread amplitude jitter
    const slubV = tvi % slubEvery === 0 ? 1 : 0;
    const sv = Math.sin(tv * 6.283) * jv * (slubV ? 2.5 : 1);
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      const tu = u * threads;
      const tui = Math.floor(tu);
      const ju = 0.7 + hash1(tui, seed + 71) * 0.6;
      const slubU = tui % slubEvery === 0 ? 1 : 0;
      const su = Math.sin(tu * 6.283) * ju * (slubU ? 2.5 : 1);
      const over = Math.sin(tu * 6.283 + tv * 6.283) > 0;
      const weave = over ? 0.5 + su * 0.4 : 0.5 + sv * 0.4;
      const slubDark = (slubU || slubV) ? 0.6 : 1.0; // slubs read a touch darker, not just fatter
      const brush = fbmValue2(u * 6, v * 30, 6, seed + 3, 2);
      S.r[i] = clamp01(ground[0] * slubDark + (weave - 0.5) * 0.005 + (brush - 0.5) * 0.05);
      S.g[i] = clamp01(ground[1] * slubDark + (weave - 0.5) * 0.005 + (brush - 0.5) * 0.05);
      S.b[i] = clamp01(ground[2] * slubDark + (weave - 0.5) * 0.005 + (brush - 0.5) * 0.045);
      S.h[i] = 0.5 + (weave - 0.5) * 0.06;
      S.rough[i] = 0.86 + (brush - 0.5) * 0.06;
    }
  }

  // Yellow wedge: a soft triangle in the upper-left third, edges wobbled by noise.
  const ax = 0.12 * n, ay = 0.92 * n;
  const bx = 0.62 * n, by = 0.80 * n;
  const cx = 0.20 * n, cy = 0.30 * n;
  const edge = (px, py, x0, y0, x1, y1) => (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0);
  const wy0 = Math.max(0, Math.floor(Math.min(ay, by, cy) - n * 0.03));
  const wy1 = Math.min(n, Math.ceil(Math.max(ay, by, cy) + n * 0.03));
  const wx0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) - n * 0.03));
  const wx1 = Math.min(n, Math.ceil(Math.max(ax, bx, cx) + n * 0.03));
  for (let y = wy0; y < wy1; y++) {
    const row = y * n;
    for (let x = wx0; x < wx1; x++) {
      const i = row + x;
      const wob = (fbmValue2(x / n * 12, y / n * 12, 12, seed + 21, 2) - 0.5) * n * 0.02;
      const e0 = edge(x + wob, y, ax, ay, bx, by);
      const e1 = edge(x, y + wob, bx, by, cx, cy);
      const e2 = edge(x + wob * 0.5, y, cx, cy, ax, ay);
      const inside = e0 <= 0 && e1 <= 0 && e2 <= 0;
      if (!inside) continue;
      const d = Math.min(-e0, -e1, -e2) / n;
      const a = smoothstep(0, 0.012, d) * 0.94;
      const paint = fbmValue2(x / n * 9, y / n * 9, 9, seed + 25, 2);
      S.r[i] += (yellow[0] + (paint - 0.5) * 0.09 - S.r[i]) * a;
      S.g[i] += (yellow[1] + (paint - 0.5) * 0.08 - S.g[i]) * a;
      S.b[i] += (yellow[2] + (paint - 0.5) * 0.06 - S.b[i]) * a;
      S.h[i] += a * 0.12;
      S.rough[i] = mix(S.rough[i], 0.72, a);
    }
  }

  // Magenta/violet blob, right of centre, with darker speckles inside it.
  const bcx = 0.66 * n;
  const bcy = 0.46 * n;
  const brx = 0.26 * n * 1.2;
  const bry = 0.31 * n * 1.2;
  for (let y = Math.max(0, (bcy - bry) | 0); y < Math.min(n, Math.ceil(bcy + bry)); y++) {
    const row = y * n;
    for (let x = Math.max(0, (bcx - brx) | 0); x < Math.min(n, Math.ceil(bcx + brx)); x++) {
      const i = row + x;
      const dx = (x - bcx) / (0.26 * n);
      const dy = (y - bcy) / (0.31 * n);
      const ang = Math.atan2(dy, dx);
      const wob = 1 + 0.13 * Math.sin(ang * 3 + 0.7) + 0.07 * Math.sin(ang * 5 - 1.4);
      const d = Math.sqrt(dx * dx + dy * dy) / wob;
      if (d > 1.05) continue;
      const a = (1 - smoothstep(0.93, 1.02, d)) * 0.96;
      const t = clamp01(0.25 + fbmValue2(x / n * 7, y / n * 7, 7, seed + 31, 3) * 0.9);
      S.r[i] += (mix(magenta[0], violet[0], t) - S.r[i]) * a;
      S.g[i] += (mix(magenta[1], violet[1], t) - S.g[i]) * a;
      S.b[i] += (mix(magenta[2], violet[2], t) - S.b[i]) * a;
      S.h[i] += a * 0.14;
      S.rough[i] = mix(S.rough[i], 0.68, a);
    }
  }
  // The darker speckles the reference calls out.
  for (let k = 0; k < 90; k++) {
    const ang = rnd() * 6.283;
    const rad = Math.sqrt(rnd()) * 0.9;
    const x = bcx + Math.cos(ang) * rad * 0.26 * n;
    const y = bcy + Math.sin(ang) * rad * 0.31 * n;
    const rr = (0.004 + rnd() * 0.012) * n;
    stampDiscRgb(S, x, y, rr, [0.22, 0.1, 0.24], 0.6, 0.55 + rnd() * 0.3);
    stampDisc(S.h, n, x, y, rr, 0.05, 0.7, 'add');
  }

  return finishSurface(S, {
    name: 'abstractArtwork',
    normalStrength: 0.7,
    heightScale: 0.0008,
    tileMetres: [0.9, 1.15],
    wrap: 'clamp',
  });
}
