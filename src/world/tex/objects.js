// OPERATION NAPTIME — module TEX — props, print, metal, foliage, skin, overlays.
//
// Notes on the tricky ones:
//
// · printedSpine is an ATLAS: `cols` spines side by side in one texture, with uvFor(i) returning
//   the offset/repeat for a single book. Title "text" is abstract — stacked marks with the rhythm
//   of glyphs seen edge-on. We never render real words.
// · vinylGrooves cannot resolve a real 0.35 mm groove pitch at any sane texture size, so the
//   grooves are authored at the highest frequency the map can carry (≈3 px) in the normal AND in
//   the roughness. That concentric structure is what produces the anisotropic sheen; the exact
//   pitch is invisible anyway.
// · foilCrinkle is a Voronoi FACET field: each cell gets a random plane tilt and the cell borders
//   become sharp creases. Piecewise-planar with hard creases is the thing that makes foil read as
//   foil — smooth bumpy noise reads as plastic.
// · leafMonstera builds its own mask analytically: heart-shaped outline with a basal cleft, edge
//   splits cut along the gaps between secondary veins, and elliptical fenestrations. Not tileable.

import {
  beginSurface, fieldToBytes, finishSurface, hexToRgb, lowFreqField, stampDisc, stampDiscRgb,
  stampLine, stampRectRgb, toTexture,
} from './raster.js';
import {
  clamp01, fbmValue2, fbmValue2xy, hash1, latticeFor, localRng, mix, ridged2, smoothstep,
  valueNoise2, valueNoise2xy, worley2, W,
} from './noise.js';

// ═════════════════════════════════════════════════════════════ paper ═════

/** Uncoated book/paper stock: fibre speckle, slight yellowing, matte. */
export function paperCover({ size = 256, seed = 41041, tileMetres = 0.15, colour = 0xe8e1d2 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const [px, sx] = latticeFor(n, 2);
  const [px3, sx3] = latticeFor(n, 3);
  const [px7, sx7] = latticeFor(n, 7);
  const drift = lowFreqField(n, 6, (u, v) => fbmValue2(u * 5, v * 5, 5, seed + 3, 3));
  for (let y = 0; y < n; y++) {
    const row = y * n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const fibre = valueNoise2(x * sx, y * sx, px, seed + 7);
      const fibre2 = valueNoise2xy(x * sx3, y * sx7, px3, px7, seed + 9);
      const sh = (fibre - 0.5) * 0.035 + (fibre2 - 0.5) * 0.03 + (drift[i] - 0.5) * 0.05;
      S.r[i] = clamp01(base[0] + sh);
      S.g[i] = clamp01(base[1] + sh * 0.97);
      S.b[i] = clamp01(base[2] + sh * 0.9 - (drift[i] - 0.5) * 0.02);
      S.h[i] = 0.5 + (fibre - 0.5) * 0.5 + (fibre2 - 0.5) * 0.25;
      S.rough[i] = clamp01(0.84 + (fibre - 0.5) * 0.08);
    }
  }
  return finishSurface(S, { name: 'paperCover', normalStrength: 0.45, heightScale: 0.0003, tileMetres: [tileMetres, tileMetres] });
}

/** Bookbinding cloth: fine linen weave over board, tintable. */
export function bookCloth({ size = 256, seed = 42042, tileMetres = 0.10, colour = 0x7a4b3a } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const threads = 46;
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
      const weave = over ? su : sv * 0.85;
      const fuzz = valueNoise2(x / 2, y / 2, px, seed + 5);
      const sh = weave * 0.045 + (fuzz - 0.5) * 0.04;
      S.r[i] = clamp01(base[0] + sh);
      S.g[i] = clamp01(base[1] + sh * 0.95);
      S.b[i] = clamp01(base[2] + sh * 0.9);
      S.h[i] = clamp01(0.5 + weave * 0.35 + (fuzz - 0.5) * 0.18);
      S.rough[i] = clamp01(0.82 - weave * 0.04 + (fuzz - 0.5) * 0.05);
    }
  }
  return finishSurface(S, { name: 'bookCloth', normalStrength: 0.9, heightScale: 0.0004, tileMetres: [tileMetres, tileMetres] });
}

/**
 * An atlas of `cols` printed book spines. Each spine gets its own stock colour, a title band with
 * abstract glyph-rhythm marks, a publisher device near the foot, hairline rules and honest wear at
 * the head and tail. Use `atlas.uvFor(i)` to map one book to one column.
 */
export function printedSpine({ size = 512, seed = 43043, cols = 8, tileMetres = [0.32, 0.22] } = {}) {
  const S = beginSurface(size);
  const n = size;
  const rnd = localRng(seed);
  const stock = [0x8f3f34, 0x2f4a5c, 0xd9cbb0, 0x3b5340, 0x6b4a7a, 0xc98b3c, 0x2b2b30, 0xa8452f];
  const colW = n / cols;
  const px = Math.max(2, Math.round(n / 2));

  for (let c = 0; c < cols; c++) {
    const base = hexToRgb(stock[c % stock.length]);
    const light = base[0] * 0.299 + base[1] * 0.587 + base[2] * 0.114;
    const ink = light > 0.5 ? [0.13, 0.12, 0.13] : [0.9, 0.87, 0.8];
    const gold = [0.83, 0.68, 0.36];
    const foil = rnd() > 0.55;
    const x0 = Math.round(c * colW);
    const w = Math.round(colW);
    // Spine body: cloth-ish weave and a slight barrel shading (the spine is round).
    for (let y = 0; y < n; y++) {
      const row = y * n;
      const v = (y + 0.5) / n;
      for (let dx = 0; dx < w; dx++) {
        const x = x0 + dx;
        const i = row + x;
        const lu = (dx + 0.5) / w;
        const barrel = Math.sin(Math.PI * clamp01(lu)) ** 0.35;
        const weave = Math.sin(lu * 6.283 * 26) * 0.5 + Math.sin(v * 6.283 * 90) * 0.5;
        const fuzz = valueNoise2(x / 2, y / 2, px, seed + c * 31);
        const edge = smoothstep(0, 0.06, lu) * smoothstep(1, 0.94, lu);
        const wear = smoothstep(0.97, 1.0, v) * 0.35 + smoothstep(0.03, 0.0, v) * 0.3;
        const sh = (barrel - 0.75) * 0.25 + weave * 0.02 + (fuzz - 0.5) * 0.05;
        S.r[i] = clamp01(base[0] + sh + wear * 0.2);
        S.g[i] = clamp01(base[1] + sh + wear * 0.19);
        S.b[i] = clamp01(base[2] + sh + wear * 0.17);
        S.h[i] = clamp01(0.35 + barrel * 0.5 - (1 - edge) * 0.3 + (fuzz - 0.5) * 0.12);
        S.rough[i] = clamp01(0.8 + (fuzz - 0.5) * 0.06 + wear * 0.08);
      }
    }
    // Two hairline rules and the title band.
    const ruleA = 0.86;
    const ruleB = 0.30;
    for (const ry of [ruleA, ruleB]) {
      stampRectRgb(S, x0 + w * 0.18, ry * n, Math.round(w * 0.64), Math.max(1, Math.round(n * 0.004)), foil ? gold : ink, 0.9);
    }
    // Title marks: stacked blocks with the rhythm of glyphs read down the spine.
    let v = ruleA - 0.045;
    const bandX = x0 + w * (0.26 + rnd() * 0.1);
    const bandW = Math.max(2, Math.round(w * (0.34 + rnd() * 0.16)));
    let words = 2 + Math.floor(rnd() * 3);
    while (words-- > 0 && v > ruleB + 0.08) {
      const glyphs = 3 + Math.floor(rnd() * 7);
      for (let g = 0; g < glyphs && v > ruleB + 0.06; g++) {
        const gh = Math.max(1, Math.round(n * (0.010 + rnd() * 0.012)));
        const gw = Math.max(1, Math.round(bandW * (0.55 + rnd() * 0.45)));
        stampRectRgb(S, bandX, v * n, gw, gh, foil ? gold : ink, 0.85 + rnd() * 0.15);
        v -= (gh + Math.max(1, Math.round(n * 0.004))) / n;
      }
      v -= 0.018; // word space
    }
    // Publisher device at the foot: a small solid block plus a bar.
    const py = 0.10 + rnd() * 0.08;
    stampRectRgb(S, x0 + w * 0.36, py * n, Math.round(w * 0.28), Math.round(n * 0.03), foil ? gold : ink, 0.9);
    stampRectRgb(S, x0 + w * 0.30, (py - 0.045) * n, Math.round(w * 0.4), Math.max(1, Math.round(n * 0.006)), foil ? gold : ink, 0.75);
  }

  const res = finishSurface(S, {
    name: 'printedSpine',
    normalStrength: 0.8,
    heightScale: 0.0012,
    tileMetres,
  });
  res.atlas = {
    cols,
    rows: 1,
    /** UV offset/repeat that isolates spine `i` of the atlas. */
    uvFor(i) {
      const c = ((i % cols) + cols) % cols;
      return { offset: [c / cols, 0], repeat: [1 / cols, 1] };
    },
  };
  return res;
}

/** A glossy magazine cover: masthead bar, defocused cover image, cover lines, barcode. */
export function magazineCover({ size = 512, seed = 44044 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const rnd = localRng(seed);
  const paper = hexToRgb(0xf1eee7);
  const accents = [0xd85a3a, 0x2f6f8f, 0xe0b93f, 0x3f7a55];
  const accent = hexToRgb(accents[Math.floor(rnd() * accents.length)]);
  const ink = [0.12, 0.11, 0.12];

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      // Defocused "photograph": big soft colour blobs, no detail — it is seen from 3 m away.
      const blob = fbmValue2(u * 3, v * 3, 3, seed + 5, 3);
      const blob2 = fbmValue2(u * 6, v * 6, 6, seed + 9, 2);
      const inPhoto = v < 0.86;
      let r = paper[0], g = paper[1], b = paper[2];
      if (inPhoto) {
        const t = clamp01(blob * 0.8 + (blob2 - 0.5) * 0.4);
        r = mix(paper[0] * 0.9, accent[0], t);
        g = mix(paper[1] * 0.9, accent[1], t);
        b = mix(paper[2] * 0.9, accent[2], t);
        const vign = smoothstep(0.0, 0.35, v);
        r *= 0.75 + vign * 0.25; g *= 0.75 + vign * 0.25; b *= 0.78 + vign * 0.22;
      }
      S.r[i] = clamp01(r);
      S.g[i] = clamp01(g);
      S.b[i] = clamp01(b);
      S.h[i] = 0.5;
      S.rough[i] = 0.24 + (blob2 - 0.5) * 0.03;
    }
  }
  // Masthead: a fat bar of "letters" across the top.
  let mx = n * 0.06;
  while (mx < n * 0.94) {
    const w = n * (0.05 + rnd() * 0.06);
    stampRectRgb(S, mx, n * 0.88, Math.round(w), Math.round(n * 0.085), ink, 0.95);
    mx += w + n * 0.012;
  }
  // Cover lines down the left, and a subhead.
  for (let k = 0; k < 5; k++) {
    const y = n * (0.62 - k * 0.085);
    const w = n * (0.2 + rnd() * 0.3);
    stampRectRgb(S, n * 0.06, y, Math.round(w), Math.max(1, Math.round(n * 0.016)), k === 1 ? accent : ink, 0.9);
    stampRectRgb(S, n * 0.06, y - n * 0.026, Math.round(w * 0.6), Math.max(1, Math.round(n * 0.01)), ink, 0.55);
  }
  // Barcode, bottom right.
  let bx = n * 0.7;
  while (bx < n * 0.94) {
    const w = Math.max(1, Math.round(n * (0.003 + rnd() * 0.006)));
    stampRectRgb(S, bx, n * 0.04, w, Math.round(n * 0.07), ink, 0.95);
    bx += w + Math.max(1, Math.round(n * 0.004));
  }
  return finishSurface(S, {
    name: 'magazineCover',
    normalStrength: 0.2,
    heightScale: 0.0002,
    tileMetres: [0.21, 0.28],
    wrap: 'clamp',
  });
}

/** A record sleeve: uncoated board, abstract cover art, ring wear where the disc sits. */
export function vinylSleeve({ size = 512, seed = 45045 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const rnd = localRng(seed);
  const board = hexToRgb(0xdcd4c4);
  const artA = hexToRgb([0x1f3550, 0x5c2b2b, 0x2c4a34, 0x3a3550][Math.floor(rnd() * 4)]);
  const artB = hexToRgb([0xd9a441, 0xd85f3a, 0xe6e0d2, 0x8fb4c9][Math.floor(rnd() * 4)]);
  const px = Math.max(2, Math.round(n / 2));

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      const fibre = valueNoise2(x / 2, y / 2, px, seed + 3);
      const grade = clamp01(0.35 + (v - 0.5) * 0.5 + (fbmValue2(u * 4, v * 4, 4, seed + 7, 2) - 0.5) * 0.6);
      let r = mix(artA[0], artB[0], grade);
      let g = mix(artA[1], artB[1], grade);
      let b = mix(artA[2], artB[2], grade);
      // Uncoated board shows through the ink a little.
      r = mix(r, board[0], 0.06); g = mix(g, board[1], 0.06); b = mix(b, board[2], 0.06);
      S.r[i] = clamp01(r + (fibre - 0.5) * 0.05);
      S.g[i] = clamp01(g + (fibre - 0.5) * 0.05);
      S.b[i] = clamp01(b + (fibre - 0.5) * 0.05);
      S.h[i] = 0.5 + (fibre - 0.5) * 0.3;
      S.rough[i] = clamp01(0.62 + (fibre - 0.5) * 0.08);
    }
  }
  // Cover art: a big off-centre disc and two bars — abstract, sleeve-like.
  stampDiscRgb(S, n * (0.42 + rnd() * 0.16), n * (0.52 + rnd() * 0.14), n * (0.18 + rnd() * 0.1), artB, 0.05, 0.85);
  stampRectRgb(S, n * 0.08, n * 0.12, Math.round(n * 0.42), Math.round(n * 0.035), artB, 0.8);
  stampRectRgb(S, n * 0.08, n * 0.06, Math.round(n * 0.26), Math.round(n * 0.02), artB, 0.6);
  // Ring wear: the record has pressed a circle into the board over the years.
  const cx = n * 0.5;
  const cy = n * 0.5;
  const rr = n * 0.44;
  const steps = 420;
  for (let s = 0; s < steps; s++) {
    const a = (s / steps) * 6.283;
    const jitterR = rr + (hash1(s, seed) - 0.5) * n * 0.006;
    stampDiscRgb(S, cx + Math.cos(a) * jitterR, cy + Math.sin(a) * jitterR, n * 0.006, [0.72, 0.69, 0.63], 0.9, 0.35);
    stampDisc(S.h, n, cx + Math.cos(a) * jitterR, cy + Math.sin(a) * jitterR, n * 0.006, -0.08, 0.9, 'add');
  }
  return finishSurface(S, {
    name: 'vinylSleeve',
    normalStrength: 0.5,
    heightScale: 0.0006,
    tileMetres: [0.315, 0.315],
    wrap: 'clamp',
  });
}

/**
 * A vinyl record face: concentric micro-grooves, a run-out and lead-in, four track gaps and a
 * printed label with a spindle hole. Maps to a disc (UV 0..1 across the diameter), not tileable.
 */
export function vinylGrooves({ size = 512, seed = 46046, labelColour = 0xc4703a } = {}) {
  const S = beginSurface(size);
  const n = size;
  const black = hexToRgb(0x0d0d0f);
  const label = hexToRgb(labelColour);
  const grooveFreq = n / 3.2; // the finest pitch the map can actually carry
  const [pd3, sd3] = latticeFor(n, 3);

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const dy = (y + 0.5) / n - 0.5;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const dx = (x + 0.5) / n - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2; // 0 at centre, 1 at the rim
      const ang = Math.atan2(dy, dx);
      if (r > 1.0) {
        S.r[i] = 0; S.g[i] = 0; S.b[i] = 0; S.h[i] = 0.5; S.rough[i] = 0.5;
        continue;
      }
      if (r < 0.32) {
        // Label: paper, with a couple of printed rings and the spindle hole.
        const ring = 1 - smoothstep(0.0, 0.01, Math.abs(r - 0.26)) * 0.8;
        const ring2 = 1 - smoothstep(0.0, 0.008, Math.abs(r - 0.12)) * 0.6;
        const fibre = valueNoise2(x / 2, y / 2, Math.max(2, Math.round(n / 2)), seed + 3);
        const hole = smoothstep(0.028, 0.034, r);
        S.r[i] = clamp01(label[0] * ring * ring2 * hole + (fibre - 0.5) * 0.04);
        S.g[i] = clamp01(label[1] * ring * ring2 * hole + (fibre - 0.5) * 0.04);
        S.b[i] = clamp01(label[2] * ring * ring2 * hole + (fibre - 0.5) * 0.04);
        S.h[i] = 0.52 - (1 - hole) * 0.5;
        S.rough[i] = clamp01(0.72 + (fibre - 0.5) * 0.06);
      } else {
        const groove = Math.sin(r * grooveFreq * 6.283) * 0.5 + 0.5;
        // Track gaps: four slightly wider, brighter bands.
        let gap = 0;
        for (let t = 0; t < 4; t++) {
          const gr = 0.40 + t * 0.14;
          gap = Math.max(gap, 1 - smoothstep(0.0, 0.006, Math.abs(r - gr)));
        }
        const leadIn = 1 - smoothstep(0.93, 0.97, r);
        const dust = valueNoise2(x * sd3, y * sd3, pd3, seed + 11);
        const g = groove * (1 - gap * 0.7) * leadIn;
        const sheen = 0.06 + g * 0.05 + gap * 0.03;
        S.r[i] = clamp01(black[0] + sheen + (dust - 0.5) * 0.012);
        S.g[i] = clamp01(black[1] + sheen + (dust - 0.5) * 0.012);
        S.b[i] = clamp01(black[2] + sheen * 1.05 + (dust - 0.5) * 0.012);
        S.h[i] = 0.5 + (g - 0.5) * 0.4;
        // Anisotropic: grooves are smooth along the track, rough across it.
        S.rough[i] = clamp01(0.16 + (1 - g) * 0.12 - gap * 0.05 + (dust - 0.5) * 0.05 + Math.abs(Math.sin(ang * 3)) * 0.005);
      }
    }
  }
  return finishSurface(S, {
    name: 'vinylGrooves',
    normalStrength: 0.9,
    heightScale: 0.00015,
    tileMetres: [0.30, 0.30],
    wrap: 'clamp',
  });
}

// ═════════════════════════════════════════════════════════════ metal ═════

/** Brushed stainless/aluminium: fine directional micro-scratches along +u. */
export function brushedMetal({ size = 256, seed = 47047, tileMetres = 0.10, colour = 0xb9bdc1, baseRough = 0.32 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  S.useMetal(1);
  const [px, sx] = latticeFor(n, 1.5);
  const [py, sy] = latticeFor(n, 60);
  const [px4, sx4] = latticeFor(n, 4);
  const [py20, sy20] = latticeFor(n, 20);
  for (let y = 0; y < n; y++) {
    const row = y * n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const scratch = valueNoise2xy(x * sx, y * sy, px, py, seed + 3);
      const scratch2 = fbmValue2xy(x * sx4, y * sy20, px4, py20, seed + 7, 2);
      const v = scratch * 0.6 + scratch2 * 0.4;
      S.r[i] = clamp01(base[0] + (v - 0.5) * 0.07);
      S.g[i] = clamp01(base[1] + (v - 0.5) * 0.07);
      S.b[i] = clamp01(base[2] + (v - 0.5) * 0.07);
      S.h[i] = 0.5 + (v - 0.5) * 0.5;
      S.rough[i] = clamp01(baseRough + (v - 0.5) * 0.24);
      S.metal[i] = 1;
    }
  }
  return finishSurface(S, { name: 'brushedMetal', normalStrength: 0.5, heightScale: 0.00008, tileMetres: [tileMetres, tileMetres] });
}

/** Near-mirror chrome with faint fingerprints and dust — nothing in this room is perfectly clean. */
export function chromeSmudge({ size = 256, seed = 48048, tileMetres = 0.10, colour = 0xeceff1 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  S.useMetal(1);
  const rnd = localRng(seed);
  const smudge = lowFreqField(n, 4, (u, v) => fbmValue2(u * 7, v * 7, 7, seed + 5, 3));
  for (let y = 0; y < n; y++) {
    const row = y * n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const fine = valueNoise2(x / 2, y / 2, Math.max(2, Math.round(n / 2)), seed + 9);
      const sm = smoothstep(0.55, 0.85, smudge[i]);
      S.r[i] = clamp01(base[0] - sm * 0.04);
      S.g[i] = clamp01(base[1] - sm * 0.04);
      S.b[i] = clamp01(base[2] - sm * 0.038);
      S.h[i] = 0.5 + (fine - 0.5) * 0.08 + (smudge[i] - 0.5) * 0.1;
      S.rough[i] = clamp01(0.045 + sm * 0.16 + (fine - 0.5) * 0.02);
      S.metal[i] = 1 - sm * 0.05;
    }
  }
  // A few fingerprint arcs.
  for (let k = 0; k < 3; k++) {
    const cx = rnd() * n;
    const cy = rnd() * n;
    for (let a = 0; a < 5; a++) {
      const rr = n * (0.02 + a * 0.012);
      const steps = 40;
      for (let s = 0; s < steps; s++) {
        const ang = -0.9 + (s / steps) * 2.4;
        stampDisc(S.rough, n, cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr * 1.25, n * 0.006, 0.2, 0.9, 'add');
      }
    }
  }
  return finishSurface(S, { name: 'chromeSmudge', normalStrength: 0.25, heightScale: 0.00005, tileMetres: [tileMetres, tileMetres] });
}

/** Matte black anodised aluminium: the window frames, the espresso machine, the speaker cabinets. */
export function anodisedBlack({ size = 256, seed = 49049, tileMetres = 0.08, colour = 0x1c1d1f } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  S.useMetal(0.85);
  const [px, sx] = latticeFor(n, 1.5);
  const [py, sy] = latticeFor(n, 40);
  const [pg, sg] = latticeFor(n, 2);
  const drift = lowFreqField(n, 6, (u, v) => fbmValue2(u * 6, v * 6, 6, seed + 3, 2));
  for (let y = 0; y < n; y++) {
    const row = y * n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const micro = valueNoise2xy(x * sx, y * sy, px, py, seed + 5);
      const grain = valueNoise2(x * sg, y * sg, pg, seed + 11);
      S.r[i] = clamp01(base[0] + (grain - 0.5) * 0.02 + (drift[i] - 0.5) * 0.015);
      S.g[i] = clamp01(base[1] + (grain - 0.5) * 0.02 + (drift[i] - 0.5) * 0.015);
      S.b[i] = clamp01(base[2] + (grain - 0.5) * 0.022 + (drift[i] - 0.5) * 0.016);
      S.h[i] = 0.5 + (micro - 0.5) * 0.3 + (grain - 0.5) * 0.2;
      S.rough[i] = clamp01(0.44 + (micro - 0.5) * 0.14 + (grain - 0.5) * 0.06 + (drift[i] - 0.5) * 0.06);
      S.metal[i] = 0.85;
    }
  }
  return finishSurface(S, { name: 'anodisedBlack', normalStrength: 0.4, heightScale: 0.00008, tileMetres: [tileMetres, tileMetres] });
}

/** Black knitted speaker grille cloth: fine open square weave over a dark cavity. */
export function speakerCloth({ size = 256, seed = 50050, tileMetres = 0.03, cells = 22 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(0x191a1c);
  const px = Math.max(2, Math.round(n / 2));
  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    const fv = Math.abs(((v * cells) % 1) - 0.5) * 2;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      const fu = Math.abs(((u * cells) % 1) - 0.5) * 2;
      const thread = clamp01((1 - smoothstep(0.42, 0.68, fu)) + (1 - smoothstep(0.42, 0.68, fv)));
      const fuzz = valueNoise2(x / 2, y / 2, px, seed + 3);
      const lit = thread * 0.8 + (fuzz - 0.5) * 0.2;
      S.r[i] = clamp01(base[0] + lit * 0.06);
      S.g[i] = clamp01(base[1] + lit * 0.06);
      S.b[i] = clamp01(base[2] + lit * 0.065);
      S.h[i] = clamp01(0.25 + thread * 0.6 + (fuzz - 0.5) * 0.1);
      S.rough[i] = clamp01(0.88 - thread * 0.06 + (fuzz - 0.5) * 0.05);
    }
  }
  return finishSurface(S, {
    name: 'speakerCloth',
    normalStrength: 1.0,
    heightScale: 0.0006,
    tileMetres: [tileMetres, tileMetres],
    ao: { radius: 0.05, scale: 5, strength: 0.8, size: 128 },
  });
}

// ═══════════════════════════════════════════════════════════ foliage ═════

/**
 * A monstera leaf: albedo with midrib and secondary veins, alphaMap carrying the outline WITH
 * fenestrations and edge splits, and vein relief in the normal. UV convention: petiole at
 * (0.5, 0), tip at (0.5, 1), midrib along u = 0.5. Not tileable.
 */
export function leafMonstera({ size = 512, seed = 51051, splitCount = 7 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const rnd = localRng(seed);
  const deep = hexToRgb(0x27512e);
  const mid = hexToRgb(0x3c7a3c);
  const bright = hexToRgb(0x5d9a4a);
  const veinCol = hexToRgb(0x87ad63);
  const A = S.useAlpha(0);

  // Leaf half-width profile: heart-shaped base, widest at ~0.42, tapering to a point.
  const halfWidth = (v) => 0.455 * Math.sin(Math.PI * clamp01(v * 0.94 + 0.03)) ** 0.62;

  // Splits and fenestrations, mirrored per side with per-side jitter.
  const splits = [];
  for (let s = 0; s < splitCount; s++) {
    const v = 0.14 + (s / splitCount) * 0.74 + (rnd() - 0.5) * 0.03;
    splits.push({ v, depthL: 0.5 + rnd() * 0.34, depthR: 0.5 + rnd() * 0.34, tilt: 0.1 + rnd() * 0.09 });
  }
  const holes = [];
  for (let k = 0; k < 5; k++) {
    const v = 0.24 + k * 0.13 + (rnd() - 0.5) * 0.03;
    const side = k % 2 === 0 ? 1 : -1;
    holes.push({ v, side, off: 0.30 + rnd() * 0.22, rw: 0.030 + rnd() * 0.026, rh: 0.016 + rnd() * 0.012 });
    if (rnd() > 0.45) holes.push({ v: v + 0.03, side: -side, off: 0.34 + rnd() * 0.2, rw: 0.026 + rnd() * 0.02, rh: 0.014 + rnd() * 0.01 });
  }

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    const hw = halfWidth(v);
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      const du = u - 0.5;
      const adu = Math.abs(du);
      const side = du >= 0 ? 1 : -1;

      // Outline, with a wobbly edge.
      const wob = (fbmValue2(u * 9, v * 9, 9, seed + 3, 2) - 0.5) * 0.012;
      let inside = adu < hw + wob;
      // Basal cleft: the heart notch where the petiole meets the blade.
      if (v < 0.17) {
        const notch = 0.13 * (1 - v / 0.17) ** 1.4;
        if (adu < notch) inside = false;
      }
      if (v < 0.03 || v > 0.995) inside = false;

      // Edge splits: a tapering slit from the margin toward the midrib.
      let splitCut = 0;
      for (let s = 0; s < splits.length; s++) {
        const sp = splits[s];
        const depth = side > 0 ? sp.depthR : sp.depthL;
        const inner = hw * (1 - depth);
        if (adu < inner - 0.01) continue;
        // The slit rises slightly toward the tip as it goes outward.
        const tOut = clamp01((adu - inner) / Math.max(1e-4, hw - inner));
        const lineV = sp.v + tOut * sp.tilt * 0.35;
        const halfW = mix(0.004, 0.017, tOut);
        const d = Math.abs(v - lineV);
        if (d < halfW) splitCut = Math.max(splitCut, 1 - smoothstep(halfW * 0.6, halfW, d));
      }
      // Fenestrations.
      let holeCut = 0;
      for (let k = 0; k < holes.length; k++) {
        const ho = holes[k];
        if (ho.side !== side) continue;
        const dx = (adu - ho.off) / ho.rw;
        const dy = (v - ho.v) / ho.rh;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 1.2) holeCut = Math.max(holeCut, 1 - smoothstep(0.85, 1.05, d));
      }
      const cut = Math.max(splitCut, holeCut);
      const edgeSoft = smoothstep(hw + wob, hw + wob - 0.006, adu);
      const a = inside ? clamp01(edgeSoft * (1 - cut)) : 0;
      A[i] = a;
      if (a <= 0.001) {
        S.r[i] = deep[0] * 0.5; S.g[i] = deep[1] * 0.5; S.b[i] = deep[2] * 0.5;
        S.h[i] = 0.5; S.rough[i] = 0.5;
        continue;
      }

      // Veins. Midrib tapers along v; secondaries fan out toward the margin.
      const midribW = mix(0.020, 0.004, v);
      const midrib = 1 - smoothstep(midribW * 0.55, midribW, adu);
      let sec = 0;
      for (let s = 0; s < splits.length; s++) {
        const sp = splits[s];
        // A secondary vein sits between each pair of splits.
        const baseV = sp.v - 0.055;
        const lineV = baseV + (adu / Math.max(1e-4, hw)) * (sp.tilt * 0.42);
        const d = Math.abs(v - lineV);
        const w = mix(0.010, 0.003, adu / Math.max(1e-4, hw));
        if (d < w) sec = Math.max(sec, 1 - smoothstep(w * 0.4, w, d));
      }
      // Blade colour: darker near the midrib, brighter toward the margin, mottled.
      const mottle = fbmValue2(u * 7, v * 7, 7, seed + 11, 3);
      const radial = clamp01(adu / Math.max(1e-4, hw));
      let t = clamp01(radial * 0.7 + (mottle - 0.5) * 0.55 + 0.1);
      let r = mix(deep[0], mid[0], t);
      let g = mix(deep[1], mid[1], t);
      let b = mix(deep[2], mid[2], t);
      const hi = smoothstep(0.62, 1.0, mottle) * 0.35;
      r = mix(r, bright[0], hi); g = mix(g, bright[1], hi); b = mix(b, bright[2], hi);
      const vein = clamp01(midrib + sec * 0.8);
      r = mix(r, veinCol[0], vein * 0.8);
      g = mix(g, veinCol[1], vein * 0.8);
      b = mix(b, veinCol[2], vein * 0.8);
      // The margin darkens and dries slightly.
      const marginDark = smoothstep(0.86, 1.0, radial) * 0.18;
      S.r[i] = clamp01(r - marginDark);
      S.g[i] = clamp01(g - marginDark * 0.9);
      S.b[i] = clamp01(b - marginDark * 0.7);
      // Relief: veins stand proud, the blade puckers between them.
      const pucker = (mottle - 0.5) * 0.18;
      S.h[i] = clamp01(0.45 + vein * 0.45 + pucker - cut * 0.3);
      // Leaves are semi-gloss; veins and the margin are duller.
      S.rough[i] = clamp01(0.40 + vein * 0.14 + marginDark * 0.5 + (mottle - 0.5) * 0.1);
    }
  }
  return finishSurface(S, {
    name: 'leafMonstera',
    normalStrength: 1.1,
    heightScale: 0.0015,
    tileMetres: [0.32, 0.42],
    wrap: 'clamp',
  });
}

/** A generic small oval leaf (the second plant, the balcony planter) with an alpha outline. */
export function leafSmall({ size = 256, seed = 52052, colour = 0x35682f } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const light = hexToRgb(0x5c9146);
  const A = S.useAlpha(0);
  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    const hw = 0.30 * Math.sin(Math.PI * clamp01(v * 0.96 + 0.02)) ** 0.7;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      const adu = Math.abs(u - 0.5);
      const wob = (fbmValue2(u * 8, v * 8, 8, seed + 3, 2) - 0.5) * 0.01;
      const a = clamp01(smoothstep(hw + wob, hw + wob - 0.008, adu)) * (v > 0.02 && v < 0.99 ? 1 : 0);
      A[i] = a;
      const midrib = 1 - smoothstep(0.004, 0.012, adu);
      const radial = clamp01(adu / Math.max(1e-4, hw));
      // Secondary veins at 55 degrees off the midrib, both sides.
      const veinPhase = (v * 14 - radial * 3.4);
      const sec = (1 - smoothstep(0.0, 0.12, Math.abs(veinPhase - Math.round(veinPhase)))) * (1 - radial * 0.2);
      const mottle = fbmValue2(u * 9, v * 9, 9, seed + 7, 2);
      const t = clamp01(radial * 0.5 + (mottle - 0.5) * 0.5 + 0.2);
      const vein = clamp01(midrib + sec * 0.55);
      S.r[i] = clamp01(mix(base[0], light[0], t) + vein * 0.1);
      S.g[i] = clamp01(mix(base[1], light[1], t) + vein * 0.12);
      S.b[i] = clamp01(mix(base[2], light[2], t) + vein * 0.06);
      S.h[i] = clamp01(0.45 + vein * 0.4 + (mottle - 0.5) * 0.2);
      S.rough[i] = clamp01(0.44 + vein * 0.12 + (mottle - 0.5) * 0.1);
    }
  }
  return finishSurface(S, {
    name: 'leafSmall',
    normalStrength: 1.0,
    heightScale: 0.0008,
    tileMetres: [0.10, 0.16],
    wrap: 'clamp',
  });
}

// ══════════════════════════════════════════════════════════════ skin ═════

/**
 * Baby skin — soft, subsurface-friendly. Fine pore cells, faint blush zones, the tiny creases a
 * ten-month-old has at the wrists and knuckles. Returns an extra `thicknessMap` for
 * MeshPhysicalMaterial transmission/SSS use (bright = thin = more light bleeds through).
 */
export function babySkin({ size = 512, seed = 53053, tileMetres = 0.06, colour = 0xf2c8ac } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const blushCol = hexToRgb(0xe89a86);
  const paleCol = hexToRgb(0xf7d9c4);
  const cells = Math.max(6, Math.round(n / 6));
  const blush = lowFreqField(n, 8, (u, v) => fbmValue2(u * 3, v * 3, 3, seed + 3, 3));
  // The creases are a mid-frequency ridged field — a quarter-resolution evaluation is
  // indistinguishable and four times cheaper.
  const creases = lowFreqField(n, 2, (u, v) => ridged2(u * 12, v * 12, 12, seed + 13, 3, 2, 0.5));
  const thickness = new Float32Array(n * n);
  const pfine = Math.max(2, Math.round(n / 2));

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      // Pores: a fine cellular field, very shallow.
      worley2(u * cells, v * cells, cells, seed + 5, 1);
      const pore = clamp01(W.f1 * 1.6);
      // Vellus fuzz and micro-creases.
      const fine = valueNoise2(x / 2, y / 2, pfine, seed + 9);
      const cr = smoothstep(0.66, 0.95, creases[i]);
      const bl = smoothstep(0.45, 0.85, blush[i]);
      let r = mix(base[0], blushCol[0], bl * 0.3);
      let g = mix(base[1], blushCol[1], bl * 0.3);
      let b = mix(base[2], blushCol[2], bl * 0.3);
      const pale = smoothstep(0.55, 0.15, blush[i]) * 0.24;
      r = mix(r, paleCol[0], pale); g = mix(g, paleCol[1], pale); b = mix(b, paleCol[2], pale);
      const shade = (pore - 0.5) * 0.035 + (fine - 0.5) * 0.02 - cr * 0.05;
      S.r[i] = clamp01(r + shade);
      S.g[i] = clamp01(g + shade * 0.95);
      S.b[i] = clamp01(b + shade * 0.9);
      S.h[i] = clamp01(0.55 + (pore - 0.5) * 0.35 - cr * 0.4 + (fine - 0.5) * 0.12);
      // Skin is never glossy overall, but the high points catch a little.
      S.rough[i] = clamp01(0.62 - (1 - pore) * 0.06 + cr * 0.08 + (fine - 0.5) * 0.05);
      thickness[i] = clamp01(0.45 + bl * 0.4 - cr * 0.2 + (fine - 0.5) * 0.1);
    }
  }
  const res = finishSurface(S, {
    name: 'babySkin',
    normalStrength: 0.6,
    heightScale: 0.0004,
    tileMetres: [tileMetres, tileMetres],
  });
  /** Bright = thin = more subsurface transmission. Feed to MeshPhysicalMaterial.thicknessMap. */
  res.thicknessMap = toTexture(fieldToBytes(thickness, n), { size: n, name: 'babySkin.thickness' });
  const baseDispose = res.dispose;
  res.dispose = () => { baseDispose(); res.thicknessMap.dispose(); };
  return res;
}

// ══════════════════════════════════════════════════════════════ foil ═════

/**
 * The orange foil crisp bag — the thing the baby most wants to eat. Built as a Voronoi FACET
 * field: every cell gets a random plane tilt so the surface is piecewise planar, and the cell
 * borders become hard creases. Two octaves of that plus print scuffing where the ink has rubbed
 * off the crease ridges and left bare metal.
 */
export function foilCrinkle({ size = 512, seed = 54054, tileMetres = 0.18, colour = 0xd8811f } = {}) {
  const S = beginSurface(size);
  const n = size;
  const ink = hexToRgb(colour);
  const inkDark = hexToRgb(0x9c4d12);
  const silver = hexToRgb(0xc9ccce);
  S.useMetal(0.85);
  const cellsA = 9;
  const cellsB = 22;

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      // Coarse facets.
      worley2(u * cellsA, v * cellsA, cellsA, seed, 1);
      const f1a = W.f1;
      const f2a = W.f2;
      const ida = W.id;
      const ax = W.cx;
      const ay = W.cy;
      const ta = ((ida & 0xff) / 255 - 0.5) * 2;
      const tb = (((ida >>> 8) & 0xff) / 255 - 0.5) * 2;
      const planeA = (u * cellsA - ax) * ta + (v * cellsA - ay) * tb;
      // Fine facets.
      worley2(u * cellsB + 3.7, v * cellsB + 1.3, cellsB, seed + 91, 1);
      const f1b = W.f1;
      const f2b = W.f2;
      const idb = W.id;
      const bx = W.cx;
      const by = W.cy;
      const tc = ((idb & 0xff) / 255 - 0.5) * 2;
      const td = (((idb >>> 8) & 0xff) / 255 - 0.5) * 2;
      const planeB = (u * cellsB + 3.7 - bx) * tc + (v * cellsB + 1.3 - by) * td;

      const creaseA = 1 - smoothstep(0.0, 0.10, f2a - f1a);
      const creaseB = 1 - smoothstep(0.0, 0.13, f2b - f1b);
      const h = 0.5 + planeA * 0.30 + planeB * 0.12 - creaseA * 0.14 - creaseB * 0.07;
      S.h[i] = clamp01(h);

      // Ink rubbed off the ridges leaves bare metal; the creases hold darker ink.
      const ridge = clamp01((planeA * 0.5 + 0.5) * 0.7 + (planeB * 0.5 + 0.5) * 0.3);
      const scuff = smoothstep(0.72, 0.96, ridge) * 0.7;
      const crease = clamp01(creaseA * 0.7 + creaseB * 0.4);
      let r = mix(ink[0], inkDark[0], crease * 0.8);
      let g = mix(ink[1], inkDark[1], crease * 0.8);
      let b = mix(ink[2], inkDark[2], crease * 0.8);
      r = mix(r, silver[0], scuff); g = mix(g, silver[1], scuff); b = mix(b, silver[2], scuff);
      S.r[i] = clamp01(r);
      S.g[i] = clamp01(g);
      S.b[i] = clamp01(b);
      S.rough[i] = clamp01(0.30 - scuff * 0.16 + crease * 0.16 + (ridge - 0.5) * 0.08);
      S.metal[i] = clamp01(0.72 + scuff * 0.28);
    }
  }
  return finishSurface(S, {
    name: 'foilCrinkle',
    normalStrength: 2.4,
    heightScale: 0.004,
    tileMetres: [tileMetres, tileMetres],
    ao: { radius: 0.05, scale: 6, strength: 0.7, size: 256 },
  });
}

// ══════════════════════════════════════════════════════════ overlays ═════

/**
 * Generic grime overlay: RGB is the dirt colour, A is coverage. Multiply it over any surface (or
 * use as a second map on a decal plane). Blotchy low-frequency accumulation plus fine speckle.
 */
export function dirtOverlay({ size = 256, seed = 55055, tileMetres = 1.0, colour = 0x5a5148, amount = 1 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const A = S.useAlpha(0);
  const blot = lowFreqField(n, 4, (u, v) => fbmValue2(u * 4, v * 4, 4, seed + 3, 4, 2, 0.55));
  const px = Math.max(2, Math.round(n / 2));
  for (let y = 0; y < n; y++) {
    const row = y * n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const fine = valueNoise2(x / 2, y / 2, px, seed + 7);
      const a = clamp01((smoothstep(0.45, 0.9, blot[i]) * 0.85 + (fine - 0.5) * 0.25) * amount);
      A[i] = a;
      S.r[i] = clamp01(base[0] + (fine - 0.5) * 0.08);
      S.g[i] = clamp01(base[1] + (fine - 0.5) * 0.08);
      S.b[i] = clamp01(base[2] + (fine - 0.5) * 0.07);
      S.h[i] = 0.5 + (blot[i] - 0.5) * 0.2 + (fine - 0.5) * 0.15;
      S.rough[i] = clamp01(0.9 + (fine - 0.5) * 0.08);
    }
  }
  return finishSurface(S, { name: 'dirtOverlay', normalStrength: 0.3, heightScale: 0.0002, tileMetres: [tileMetres, tileMetres] });
}

/**
 * Dust/grime that accumulates along an edge: alpha ramps from 1 at v=0 to 0 by v≈0.4, broken up
 * by noise. Wrap is CLAMP on purpose — set wrapS back to repeat if you want it to run along a
 * skirting. Use it under furniture, in corners and along the skirting.
 */
export function dustEdge({ size = 256, seed = 56056, tileMetres = 0.6, colour = 0x9b9384, reach = 0.4 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const A = S.useAlpha(0);
  const px = Math.max(2, Math.round(n / 2));
  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    const ramp = 1 - smoothstep(0, reach, v);
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      const break1 = fbmValue2(u * 6, v * 3, 6, seed + 3, 3);
      const fine = valueNoise2(x / 2, y / 2, px, seed + 5);
      const a = clamp01(ramp * (0.55 + break1 * 0.75) + (fine - 0.5) * 0.12 - 0.06);
      A[i] = a;
      S.r[i] = clamp01(base[0] + (fine - 0.5) * 0.06);
      S.g[i] = clamp01(base[1] + (fine - 0.5) * 0.06);
      S.b[i] = clamp01(base[2] + (fine - 0.5) * 0.055);
      S.h[i] = 0.5 + a * 0.2 + (fine - 0.5) * 0.1;
      S.rough[i] = clamp01(0.95 + (fine - 0.5) * 0.05);
    }
  }
  return finishSurface(S, {
    name: 'dustEdge',
    normalStrength: 0.25,
    heightScale: 0.0002,
    tileMetres: [tileMetres, tileMetres],
    wrap: 'clamp',
  });
}

/** Fine scratch lines with a real alpha, for multiplying over glass, metal and lacquer. */
export function scratchesOverlay({ size = 256, seed = 57057, tileMetres = 0.3, count = 90 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const rnd = localRng(seed);
  const A = S.useAlpha(0);
  S.fillRgb([0.86, 0.86, 0.87]);
  S.h.fill(0.5);
  S.rough.fill(0.5);
  for (let k = 0; k < count; k++) {
    const x = rnd() * n;
    const y = rnd() * n;
    const ang = rnd() * 6.283;
    const len = (0.02 + rnd() * 0.22) * n;
    const w = 0.5 + rnd() * 0.9;
    const a = 0.25 + rnd() * 0.6;
    stampLine(A, n, x, y, x + Math.cos(ang) * len, y + Math.sin(ang) * len, w, a, 'max');
    stampLine(S.h, n, x, y, x + Math.cos(ang) * len, y + Math.sin(ang) * len, w, -0.25 * a, 'add');
    stampLine(S.rough, n, x, y, x + Math.cos(ang) * len, y + Math.sin(ang) * len, w, 0.3 * a, 'add');
  }
  // A little haze of very fine scratches so the map has a base texture too.
  const [pfin, sfin] = latticeFor(n, 1.5);
  for (let i = 0; i < n * n; i++) {
    const x = i % n;
    const y = (i / n) | 0;
    const fine = valueNoise2(x * sfin, y * sfin, pfin, seed + 11);
    A[i] = clamp01(A[i] + (fine - 0.5) * 0.06);
  }
  return finishSurface(S, { name: 'scratchesOverlay', normalStrength: 0.5, heightScale: 0.0001, tileMetres: [tileMetres, tileMetres] });
}

/** Micro-scuff / smudge field for glass and screens: a haze plus a few wipe arcs. */
export function smudgeOverlay({ size = 256, seed = 58058, tileMetres = 0.4 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const rnd = localRng(seed);
  const A = S.useAlpha(0);
  S.fillRgb([0.9, 0.9, 0.9]);
  S.h.fill(0.5);
  S.rough.fill(0.5);
  const haze = lowFreqField(n, 4, (u, v) => fbmValue2(u * 6, v * 6, 6, seed + 3, 3));
  for (let i = 0; i < n * n; i++) A[i] = clamp01(smoothstep(0.5, 0.95, haze[i]) * 0.5);
  for (let k = 0; k < 4; k++) {
    const cx = rnd() * n;
    const cy = rnd() * n;
    const rr = n * (0.1 + rnd() * 0.2);
    const steps = 90;
    for (let s = 0; s < steps; s++) {
      const ang = (s / steps) * 2.2 - 1.1 + rnd() * 0.02;
      const x = cx + Math.cos(ang) * rr;
      const y = cy + Math.sin(ang) * rr * 0.8;
      stampDisc(A, n, x, y, n * 0.02, 0.25, 1, 'max');
      stampDisc(S.rough, n, x, y, n * 0.02, 0.12, 1, 'add');
    }
  }
  return finishSurface(S, { name: 'smudgeOverlay', normalStrength: 0.2, heightScale: 0.0001, tileMetres: [tileMetres, tileMetres] });
}

/** Fine-grained matte plastic for toys, adjusters and buckles. Tintable. */
export function plasticMatte({ size = 256, seed = 59059, tileMetres = 0.08, colour = 0xd94f4f } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const px = Math.max(2, Math.round(n / 2));
  const drift = lowFreqField(n, 6, (u, v) => fbmValue2(u * 8, v * 8, 8, seed + 3, 2));
  for (let y = 0; y < n; y++) {
    const row = y * n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      // Injection-moulded texture: a fine even stipple, plus faint flow lines.
      const stipple = valueNoise2(x / 2, y / 2, px, seed + 7);
      const flow = fbmValue2xy((x / n) * 5, (y / n) * 30, 5, 30, seed + 11, 2);
      const sh = (stipple - 0.5) * 0.03 + (drift[i] - 0.5) * 0.02;
      S.r[i] = clamp01(base[0] + sh);
      S.g[i] = clamp01(base[1] + sh);
      S.b[i] = clamp01(base[2] + sh);
      S.h[i] = 0.5 + (stipple - 0.5) * 0.5 + (flow - 0.5) * 0.1;
      S.rough[i] = clamp01(0.52 + (stipple - 0.5) * 0.12 + (drift[i] - 0.5) * 0.08);
    }
  }
  return finishSurface(S, { name: 'plasticMatte', normalStrength: 0.55, heightScale: 0.0002, tileMetres: [tileMetres, tileMetres] });
}
