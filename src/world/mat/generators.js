// OPERATION NAPTIME — module MAT — the three maps the TEX library does not carry.
//
// TEX owns every *surface*; these three are owned by MAT because they only exist to feed one
// material each and nobody else will ever ask for them:
//
//  · hairStrands  — a fine strand field with a real alpha. Dense at the root, wispy at the tip,
//    which is exactly what a ten-month-old's hair does: it reads as thin hair on a dome and as
//    strands on a card, and the scalp showing through at the edges is correct, not a bug.
//  · laptopUI     — the glow on a half-open laptop lid. A dark editor: title bar, sidebar, ragged
//    lines of "text". No glyphs are rendered — at 0.30 m across and three metres away the eye
//    reads rhythm and colour, never letterforms.
//  · skyGradient  — the winter Buenos Aires sky seen through the glazing: cool blue-grey up top,
//    a warm haze band at the horizon where the low sun sits, soft cloud striation. Authored above
//    1.0 in the RGB so it blooms through the composer instead of clipping to a flat white card.
//
// They use the same raster/noise toolkit as TEX (re-exported from textures.js) so there is exactly
// one noise implementation in the project.

import * as THREE from 'three';
import {
  beginSurface, finishSurface, hexToRgb, stampRectRgb, u8,
  clamp01, fbmValue2, hash1, localRng, mix, smoothstep, valueNoise2,
} from '../textures.js';
import { latticeFor } from '../tex/noise.js';

/**
 * Fine hair with a real alphaMap. UV: v = 0 at the root (fully covered), v = 1 at the tips
 * (individual strands). `density` is the fraction of the root end that stays opaque.
 */
export function hairStrands({ size = 256, seed = 61061, tileMetres = [0.06, 0.09], strands = 46, colour = 0x6b4a33, density = 0.9 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const base = hexToRgb(colour);
  const light = hexToRgb(0xa98460);
  const A = S.useAlpha(0);
  const pitch = n / strands;
  const [pf, sf] = latticeFor(n, 2);

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    // Coverage: solid near the root, breaking into strands past `density`.
    const openness = smoothstep(density * 0.55, 1.0, v);
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const t0 = Math.floor(x / pitch);
      let best = 9e9;
      let bestId = 0;
      let bestSide = 0;
      for (let k = -1; k <= 1; k++) {
        const ti = (((t0 + k) % strands) + strands) % strands;
        const h = hash1(ti, seed);
        // Strands sweep sideways as they get further from the root, and each has its own curl.
        const sweep = (h - 0.5) * pitch * 2.6 * v * v + Math.sin(v * 4.1 + h * 6.283) * pitch * 0.5 * v;
        const cxp = (t0 + k + 0.5) * pitch + sweep;
        const d = x + 0.5 - cxp;
        if (Math.abs(d) < Math.abs(best)) { best = d; bestId = ti; bestSide = Math.sign(d); }
      }
      const h = hash1(bestId, seed);
      const len = 0.62 + h * 0.38;
      const w = pitch * (0.34 + h * 0.16) * (1 - 0.55 * v); // strands taper toward the tip
      const ad = Math.abs(best);
      const inStrand = 1 - smoothstep(w * 0.45, w, ad);
      const alive = v < len ? 1 : 1 - smoothstep(len, len + 0.08, v);
      const fuzz = valueNoise2(x * sf, y * sf, pf, seed + 7);
      const a = clamp01(mix(1, inStrand * alive, openness) * (0.92 + (fuzz - 0.5) * 0.16));
      A[i] = a;
      // Cylindrical shading across the strand plus a per-strand tone: this is what gives hair its
      // long specular streak once the sheen term is on.
      const round = Math.cos(clamp01(ad / (w + 1e-6)) * 1.45);
      const tone = (h - 0.5) * 0.16 + (fuzz - 0.5) * 0.06;
      const t = clamp01(0.35 + round * 0.5 + tone);
      S.r[i] = clamp01(mix(base[0], light[0], t));
      S.g[i] = clamp01(mix(base[1], light[1], t));
      S.b[i] = clamp01(mix(base[2], light[2], t));
      S.h[i] = clamp01(0.3 + round * 0.6 - bestSide * 0.02);
      S.rough[i] = clamp01(0.62 - round * 0.16 + (fuzz - 0.5) * 0.06);
    }
  }
  return finishSurface(S, {
    name: 'hairStrands',
    normalStrength: 1.25,
    heightScale: 0.001,
    tileMetres,
  });
}

/**
 * The laptop screen. Dark editor chrome plus ragged lines of colour-coded "code"; the map doubles
 * as the emissiveMap, so the bright glyph rows are the only part that glows.
 */
export function laptopUI({ size = 256, seed = 62062 } = {}) {
  const S = beginSurface(size);
  const n = size;
  const rnd = localRng(seed);
  const bg = hexToRgb(0x14171d);
  const panel = hexToRgb(0x1b1f27);
  const bar = hexToRgb(0x252a34);
  const inkCols = [0x7fb2e5, 0xc9d6e4, 0xd9a65c, 0x8fbf7a, 0xb98ad1].map(hexToRgb);

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const v = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const u = (x + 0.5) / n;
      const c = u < 0.22 ? panel : bg;
      // A very faint vertical scan structure — LCD subpixel rows, not scanlines.
      const scan = 0.985 + 0.015 * Math.sin(v * n * 3.1416);
      const glow = 0.04 * smoothstep(0.0, 0.5, 1 - Math.abs(v - 0.55) * 2);
      S.r[i] = clamp01(c[0] * scan + glow);
      S.g[i] = clamp01(c[1] * scan + glow);
      S.b[i] = clamp01(c[2] * scan + glow * 1.15);
      S.h[i] = 0.5;
      S.rough[i] = 0.14;
    }
  }
  // Title bar with three traffic-light dots, and a tab strip under it.
  stampRectRgb(S, 0, n * 0.955, n, Math.round(n * 0.045), bar, 1);
  const dots = [0xd05b52, 0xd8ac4a, 0x6fb05a].map(hexToRgb);
  for (let d = 0; d < 3; d++) {
    stampRectRgb(S, Math.round(n * (0.02 + d * 0.028)), Math.round(n * 0.968), Math.max(2, Math.round(n * 0.014)), Math.max(2, Math.round(n * 0.016)), dots[d], 1);
  }
  stampRectRgb(S, 0, Math.round(n * 0.915), n, Math.round(n * 0.04), hexToRgb(0x1e222b), 1);
  stampRectRgb(S, Math.round(n * 0.24), Math.round(n * 0.918), Math.round(n * 0.17), Math.round(n * 0.034), bg, 1);

  // Sidebar file rows.
  for (let k = 0; k < 14; k++) {
    const y = n * (0.86 - k * 0.055);
    if (y < n * 0.06) break;
    const w = n * (0.06 + rnd() * 0.1);
    stampRectRgb(S, n * (0.04 + (k % 3) * 0.02), y, Math.round(w), Math.max(1, Math.round(n * 0.012)), inkCols[1], 0.55);
  }
  // Code lines: indent runs, ragged lengths, a couple of highlighted tokens per line.
  let y = n * 0.86;
  let indent = 0;
  while (y > n * 0.05) {
    const lh = Math.max(2, Math.round(n * 0.028));
    if (rnd() > 0.72) indent = Math.max(0, indent + (rnd() > 0.5 ? 1 : -1));
    let x = n * (0.25 + indent * 0.03);
    const tokens = 1 + Math.floor(rnd() * 4);
    for (let t = 0; t < tokens && x < n * 0.95; t++) {
      const w = n * (0.03 + rnd() * 0.14);
      const col = inkCols[Math.floor(rnd() * inkCols.length)];
      stampRectRgb(S, x, y, Math.round(w), Math.max(1, Math.round(n * 0.013)), col, 0.85);
      x += w + n * 0.018;
    }
    y -= lh;
  }
  // The caret: one bright block.
  stampRectRgb(S, n * 0.46, n * 0.4, Math.max(1, Math.round(n * 0.008)), Math.max(2, Math.round(n * 0.02)), hexToRgb(0xe8eef6), 0.95);

  return finishSurface(S, {
    name: 'laptopUI',
    normalStrength: 0.1,
    heightScale: 0.0001,
    tileMetres: [0.30, 0.19],
    wrap: 'clamp',
  });
}

/**
 * The sky behind the glazing. A single 64x256 strip: cool blue-grey zenith, warm low haze, soft
 * horizontal cloud striation. Values run above 1.0 near the sun band so the composer's bloom has
 * something to catch — a sky clamped at 1.0 always reads as a painted card.
 */
export function skyGradient({ size = 256, seed = 63063, sunHeight = 0.34, warmth = 1 } = {}) {
  const h = size;
  const w = Math.max(16, size >> 2);
  const data = new Uint8Array(w * h * 4);
  const zenith = hexToRgb(0x8ba6c4);
  const mid = hexToRgb(0xc3d0da);
  const haze = hexToRgb(0xe8dcc6);
  const sun = hexToRgb(0xffe6bd);

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h; // 0 at the ground line, 1 at the zenith
    const t = clamp01(v * 1.15);
    let r = mix(mix(haze[0], mid[0], smoothstep(0.0, 0.45, t)), zenith[0], smoothstep(0.35, 1.0, t));
    let gg = mix(mix(haze[1], mid[1], smoothstep(0.0, 0.45, t)), zenith[1], smoothstep(0.35, 1.0, t));
    let b = mix(mix(haze[2], mid[2], smoothstep(0.0, 0.45, t)), zenith[2], smoothstep(0.35, 1.0, t));
    // The low sun sits just above the rooftops: a broad warm lift, brightest at `sunHeight`.
    const solar = Math.exp(-((v - sunHeight) * (v - sunHeight)) / 0.012) * warmth;
    r = r * (1 + solar * 0.55) + sun[0] * solar * 0.75;
    gg = gg * (1 + solar * 0.45) + sun[1] * solar * 0.6;
    b = b * (1 + solar * 0.3) + sun[2] * solar * 0.4;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      // Winter overcast: long flat cloud bands, stretched horizontally.
      const cloud = fbmValue2(u * 3, v * 9, 3, seed + 5, 4, 2, 0.55);
      const band = smoothstep(0.42, 0.78, cloud) * (0.55 + 0.45 * smoothstep(0.0, 0.6, v));
      const cr = mix(r, 1.02, band * 0.5);
      const cg = mix(gg, 1.0, band * 0.5);
      const cb = mix(b, 1.0, band * 0.46);
      const i = (y * w + x) * 4;
      // Deliberately not linearToByte: the sky is authored display-referred and tagged sRGB, and
      // the >1 headroom is delivered by the material's colour multiplier instead.
      data[i] = u8(cr);
      data[i + 1] = u8(cg);
      data[i + 2] = u8(cb);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 1;
  tex.name = 'skyGradient';
  tex.needsUpdate = true;
  return { map: tex, size: h, dispose() { tex.dispose(); } };
}
