// OPERATION NAPTIME — module TEX — canvas/typed-array raster toolkit.
//
// Generators author into plain Float32Array fields (r,g,b, height, roughness, metalness, alpha)
// and then call finishSurface(), which does all of the expensive shared work exactly once:
// Sobel normal, horizon-based AO, ORM channel packing, byte conversion and THREE.Texture setup.
//
// Two conventions everybody downstream must know:
//
//  · ROW 0 IS v = 0. Every texture we hand out has flipY = false (that is DataTexture's native
//    behaviour, and we force it on CanvasTexture too) so albedo, normal, ORM and alpha are all
//    oriented identically. Authoring code should think of y increasing upwards.
//  · PACKED ORM. AO, roughness and metalness live in R, G and B of ONE texture, which is exactly
//    what three.js samples for aoMap (.r), roughnessMap (.g) and metalnessMap (.b) — the glTF
//    convention. So `result.aoMap === result.roughnessMap === result.orm` on purpose: one upload
//    instead of three. aoMap.channel is set to 0 so it reads the same UV set as the albedo
//    (three r152+ dropped the hard uv2 requirement; set `.channel = 1` yourself if a mesh really
//    does carry a second UV set). Materials using these maps must keep material.roughness = 1 and
//    material.metalness = 1, since three multiplies the scalar by the sampled channel.
//
// Colour is authored display-referred (sRGB 0..1, i.e. the numbers you would read off a hex
// swatch) because that is how a painted texture behaves; albedo textures are tagged
// SRGBColorSpace and data textures NoColorSpace.

import * as THREE from 'three';
import { clamp01, hashU, smoothstep, wrapi } from './noise.js';

/** Shared raster environment — set once by the texture library from ctx.quality. */
const ENV = {
  anisotropy: 8,
  maxAnisotropy: 16,
  aoSamples: 8,
  aoSteps: 5,
  tier: 'high',
};

/** Configure anisotropy/AO budget from ctx.quality. Called once by createTextureLibrary. */
export function configureRaster(opts = {}) {
  Object.assign(ENV, opts);
  ENV.anisotropy = Math.min(ENV.anisotropy, ENV.maxAnisotropy);
  return ENV;
}

/** Read-only view of the current raster environment. */
export const rasterEnv = () => ENV;

// ─────────────────────────────────────────────────────────────── colour ──

/** 0xRRGGBB → [r,g,b] in display-referred sRGB 0..1. */
export function hexToRgb(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

/** 0xRRGGBB → [r,g,b] in linear-light 0..1 (for lights/emissive, not for albedo authoring). */
export function hexToLinear(hex) {
  const c = hexToRgb(hex);
  return c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
}

/** sRGB 0..1 → linear 0..1. */
export const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
/** linear 0..1 → sRGB 0..1. */
export const linearToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

// 4096-entry LUT so forEachPixel's linear→sRGB conversion is a table lookup, not a pow().
const SRGB_LUT = new Uint8Array(4096);
for (let i = 0; i < 4096; i++) SRGB_LUT[i] = Math.round(clamp01(linearToSrgb(i / 4095)) * 255);
/** Linear 0..1 → sRGB byte, via LUT. */
export const linearToByte = (v) => SRGB_LUT[(clamp01(v) * 4095) | 0];
/** Display-referred 0..1 → byte. */
export const u8 = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0);

/** Mix two [r,g,b] triples. Allocates — never call in a per-pixel loop. */
export const mixRgb = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ─────────────────────────────────────────────────────────────── canvas ──

/**
 * An OffscreenCanvas when the browser has one (no DOM cost, works in workers), otherwise a
 * detached <canvas>. Returns null in a non-DOM environment so headless self-tests can skip.
 */
export function makeCanvas(w, h = w) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return null;
}

/**
 * Convenience per-pixel writer: cb(x, y, u, v) returns [r,g,b] in LINEAR 0..1 (and optionally a
 * 4th alpha in 0..1). Handy for one-off maps; the hot generators write their Float32 fields
 * directly instead, because a closure call per pixel is ~3x slower than an inlined loop.
 */
export function forEachPixel(size, cb) {
  const data = new Uint8Array(size * size * 4);
  const inv = 1 / size;
  let i = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++, i += 4) {
      const c = cb(x, y, (x + 0.5) * inv, (y + 0.5) * inv);
      data[i] = linearToByte(c[0]);
      data[i + 1] = linearToByte(c[1]);
      data[i + 2] = linearToByte(c[2]);
      data[i + 3] = c.length > 3 ? u8(c[3]) : 255;
    }
  }
  return data;
}

// ──────────────────────────────────────────────────────── field helpers ──

/** Allocate a Float32 field of size². */
export const field = (size, fill = 0) => {
  const f = new Float32Array(size * size);
  if (fill) f.fill(fill);
  return f;
};

/** Wrapped bilinear sample of a Float32 field, in pixel coordinates. */
export function sampleField(f, size, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const xa = wrapi(x0, size);
  const ya = wrapi(y0, size);
  const xb = wrapi(x0 + 1, size);
  const yb = wrapi(y0 + 1, size);
  const a = f[ya * size + xa];
  const b = f[ya * size + xb];
  const c = f[yb * size + xa];
  const d = f[yb * size + xb];
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}

/** Box-average downsample of a field (both sizes must divide evenly enough; nearest fallback). */
export function downsampleField(src, srcSize, dstSize) {
  if (dstSize >= srcSize) return src;
  const out = new Float32Array(dstSize * dstSize);
  const k = srcSize / dstSize;
  const ki = Math.max(1, Math.round(k));
  const inv = 1 / (ki * ki);
  for (let y = 0; y < dstSize; y++) {
    const sy = Math.round(y * k);
    for (let x = 0; x < dstSize; x++) {
      const sx = Math.round(x * k);
      let sum = 0;
      for (let j = 0; j < ki; j++) {
        const yy = wrapi(sy + j, srcSize) * srcSize;
        for (let i = 0; i < ki; i++) sum += src[yy + wrapi(sx + i, srcSize)];
      }
      out[y * dstSize + x] = sum * inv;
    }
  }
  return out;
}

/** Wrap-aware bilinear upsample of a field to dstSize². Used to lift low-frequency layers. */
export function upsampleField(src, srcSize, dstSize) {
  if (srcSize === dstSize) return src;
  const out = new Float32Array(dstSize * dstSize);
  const k = srcSize / dstSize;
  for (let y = 0; y < dstSize; y++) {
    const sy = (y + 0.5) * k - 0.5;
    for (let x = 0; x < dstSize; x++) {
      out[y * dstSize + x] = sampleField(src, srcSize, (x + 0.5) * k - 0.5, sy);
    }
  }
  return out;
}

/**
 * Build a low-frequency field cheaply: evaluate `fn(u, v)` on a coarse grid and bilinearly
 * upsample. Broad stains, tone drift and blush zones cost 1/16 or 1/64 of full resolution this
 * way, which is where most of the generation budget is saved.
 */
export function lowFreqField(size, divisor, fn) {
  const s = Math.max(4, Math.round(size / divisor));
  const small = new Float32Array(s * s);
  const inv = 1 / s;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) small[y * s + x] = fn((x + 0.5) * inv, (y + 0.5) * inv);
  }
  return upsampleField(small, s, size);
}

/** Separable wrapped box blur, `passes` iterations approximate a Gaussian. In place-safe. */
export function blurField(src, size, radius, passes = 2) {
  if (radius < 0.5) return src;
  const r = Math.max(1, Math.round(radius));
  const w = r * 2 + 1;
  let a = Float32Array.from(src);
  let b = new Float32Array(size * size);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < size; y++) {
      const row = y * size;
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += a[row + wrapi(i, size)];
      for (let x = 0; x < size; x++) {
        b[row + x] = sum / w;
        sum += a[row + wrapi(x + r + 1, size)] - a[row + wrapi(x - r, size)];
      }
    }
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += b[wrapi(i, size) * size + x];
      for (let y = 0; y < size; y++) {
        a[y * size + x] = sum / w;
        sum += b[wrapi(y + r + 1, size) * size + x] - b[wrapi(y - r, size) * size + x];
      }
    }
  }
  return a;
}

/** Normalise a field to [0,1] in place and return it. */
export function normaliseField(f) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < f.length; i++) {
    if (f[i] < lo) lo = f[i];
    if (f[i] > hi) hi = f[i];
  }
  const s = hi - lo > 1e-6 ? 1 / (hi - lo) : 1;
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) * s;
  return f;
}

// ──────────────────────────────────────────────────────── stamping tools ──

/**
 * Stamp a soft disc into a field with wrapping (so features near the border tile correctly).
 * mode: 'add' | 'sub' | 'max' | 'min' | 'set' | 'mix'. `soft` 0..1 is the feathered fraction.
 */
export function stampDisc(f, size, cx, cy, radius, amount, soft = 0.5, mode = 'add') {
  const r = Math.ceil(radius) + 1;
  const inner = radius * (1 - soft);
  const x0 = Math.round(cx);
  const y0 = Math.round(cy);
  for (let dy = -r; dy <= r; dy++) {
    const yy = wrapi(y0 + dy, size) * size;
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > radius) continue;
      const w = 1 - smoothstep(inner, radius, d);
      if (w <= 0) continue;
      const i = yy + wrapi(x0 + dx, size);
      const v = amount * w;
      if (mode === 'add') f[i] += v;
      else if (mode === 'sub') f[i] -= v;
      else if (mode === 'max') f[i] = Math.max(f[i], v);
      else if (mode === 'min') f[i] = Math.min(f[i], amount + (f[i] - amount) * (1 - w));
      else if (mode === 'set') f[i] = f[i] * (1 - w) + amount * w;
      else f[i] = f[i] * (1 - w) + amount * w;
    }
  }
}

/** Stamp a soft disc of colour into the r/g/b fields of a surface. */
export function stampDiscRgb(S, cx, cy, radius, rgb, soft = 0.5, alpha = 1) {
  const size = S.size;
  const r = Math.ceil(radius) + 1;
  const inner = radius * (1 - soft);
  const x0 = Math.round(cx);
  const y0 = Math.round(cy);
  for (let dy = -r; dy <= r; dy++) {
    const yy = wrapi(y0 + dy, size) * size;
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > radius) continue;
      const w = (1 - smoothstep(inner, radius, d)) * alpha;
      if (w <= 0) continue;
      const i = yy + wrapi(x0 + dx, size);
      S.r[i] += (rgb[0] - S.r[i]) * w;
      S.g[i] += (rgb[1] - S.g[i]) * w;
      S.b[i] += (rgb[2] - S.b[i]) * w;
    }
  }
}

/** Axis-aligned rectangle of colour (pixel coordinates, wrapping). */
export function stampRectRgb(S, x, y, w, h, rgb, alpha = 1) {
  const size = S.size;
  const xi = Math.round(x);
  const yi = Math.round(y);
  for (let dy = 0; dy < h; dy++) {
    const yy = wrapi(yi + dy, size) * size;
    for (let dx = 0; dx < w; dx++) {
      const i = yy + wrapi(xi + dx, size);
      S.r[i] += (rgb[0] - S.r[i]) * alpha;
      S.g[i] += (rgb[1] - S.g[i]) * alpha;
      S.b[i] += (rgb[2] - S.b[i]) * alpha;
    }
  }
}

/** Axis-aligned rectangle into a scalar field. */
export function stampRect(f, size, x, y, w, h, value, alpha = 1) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  for (let dy = 0; dy < h; dy++) {
    const yy = wrapi(yi + dy, size) * size;
    for (let dx = 0; dx < w; dx++) {
      const i = yy + wrapi(xi + dx, size);
      f[i] += (value - f[i]) * alpha;
    }
  }
}

/**
 * Anti-aliased soft line segment into a scalar field, wrapping at the borders. Used for cracks,
 * scratches, veins and fringe threads.
 */
export function stampLine(f, size, x0, y0, x1, y1, width, amount, mode = 'add') {
  const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    stampDisc(f, size, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, width, amount, 0.9, mode);
  }
}

// ─────────────────────────────────────────────────── derived-map builders ──

/**
 * Proper 3x3 Sobel height → tangent-space normal map (RGBA bytes, OpenGL/three convention:
 * +X right, +Y up, +Z out). Wraps at the borders so the normal map tiles with the height.
 * `strength` scales the gradient; the height field is expected in 0..1.
 */
export function heightToNormal(h, size, strength = 1, out) {
  const data = out || new Uint8Array(size * size * 4);
  const s = strength * size * 0.0045; // keep visual strength resolution-independent
  for (let y = 0; y < size; y++) {
    const ym = wrapi(y - 1, size) * size;
    const y0 = y * size;
    const yp = wrapi(y + 1, size) * size;
    for (let x = 0; x < size; x++) {
      const xm = wrapi(x - 1, size);
      const xp = wrapi(x + 1, size);
      const tl = h[yp + xm];
      const tc = h[yp + x];
      const tr = h[yp + xp];
      const ml = h[y0 + xm];
      const mr = h[y0 + xp];
      const bl = h[ym + xm];
      const bc = h[ym + x];
      const br = h[ym + xp];
      const dx = (tr + 2 * mr + br - (tl + 2 * ml + bl)) * 0.25;
      const dy = (tl + 2 * tc + tr - (bl + 2 * bc + br)) * 0.25;
      let nx = -dx * s;
      let ny = -dy * s;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv;
      ny *= inv;
      const i = (y0 + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255 + 0.5;
      data[i + 1] = (ny * 0.5 + 0.5) * 255 + 0.5;
      data[i + 2] = inv * 255 + 0.5;
      data[i + 3] = 255;
    }
  }
  return data;
}

/**
 * Cheap horizon-based ambient occlusion from a height field. For each texel we march a few rays
 * in screen-space-ish directions and keep the maximum slope (the horizon angle); AO is the
 * cosine-weighted fraction of the hemisphere left visible. Runs on a downsampled height field —
 * AO is inherently low frequency, so 256² is plenty even for a 2048² texture.
 * Returns a Float32Array in [0,1] where 1 = fully open.
 */
export function heightToAO(h, size, { radius = 0.05, samples = ENV.aoSamples, steps = ENV.aoSteps, scale = 6, strength = 1 } = {}) {
  const ao = new Float32Array(size * size);
  const R = Math.max(2, radius * size);
  const dirs = samples;
  const cos = new Float32Array(dirs);
  const sin = new Float32Array(dirs);
  for (let d = 0; d < dirs; d++) {
    const a = (d / dirs) * Math.PI * 2;
    cos[d] = Math.cos(a);
    sin[d] = Math.sin(a);
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const h0 = h[i];
      // Per-texel rotation of the direction fan kills the banding a fixed fan would produce.
      const rot = (hashU(x, y, 913) & 255) / 255 * Math.PI * 2;
      const cr = Math.cos(rot);
      const sr = Math.sin(rot);
      let occ = 0;
      for (let d = 0; d < dirs; d++) {
        const dx = cos[d] * cr - sin[d] * sr;
        const dy = cos[d] * sr + sin[d] * cr;
        let maxSlope = 0;
        for (let s = 1; s <= steps; s++) {
          const t = (s / steps) * R;
          const hs = h[wrapi(y + Math.round(dy * t), size) * size + wrapi(x + Math.round(dx * t), size)];
          const slope = ((hs - h0) * scale) / (t / size);
          if (slope > maxSlope) maxSlope = slope;
        }
        occ += maxSlope / Math.sqrt(1 + maxSlope * maxSlope);
      }
      ao[i] = clamp01(1 - (occ / dirs) * strength);
    }
  }
  return ao;
}

/**
 * Curvature (normalised Laplacian) of a height field: >0.5 on ridges, <0.5 in creases.
 * Drives edge wear, dust settling in crevices and the dirt masks.
 */
export function curvature(h, size, gain = 8) {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const ym = wrapi(y - 1, size) * size;
    const y0 = y * size;
    const yp = wrapi(y + 1, size) * size;
    for (let x = 0; x < size; x++) {
      const xm = wrapi(x - 1, size);
      const xp = wrapi(x + 1, size);
      const lap = h[y0 + xm] + h[y0 + xp] + h[ym + x] + h[yp + x] - 4 * h[y0 + x];
      out[y0 + x] = clamp01(0.5 + lap * gain * size * 0.01);
    }
  }
  return out;
}

/**
 * Derive a roughness field from a base value plus modulation fields.
 * roughnessFrom(size, base, [{ field, amount }, …]) → Float32Array clamped to [0.02, 0.995].
 */
export function roughnessFrom(size, base, mods = []) {
  const out = new Float32Array(size * size);
  out.fill(base);
  for (const m of mods) {
    const f = m.field;
    const a = m.amount;
    const bias = m.bias ?? 0.5;
    for (let i = 0; i < out.length; i++) out[i] += (f[i] - bias) * a;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i] < 0.02 ? 0.02 : out[i] > 0.995 ? 0.995 : out[i];
  return out;
}

/**
 * Pack AO / roughness / metalness into the R / G / B channels of one RGBA byte buffer.
 * Any of the three may be a Float32Array or a constant. This is the glTF ORM layout, which is
 * exactly what three.js reads for aoMap/roughnessMap/metalnessMap.
 */
export function packORM(ao, rough, metal, size) {
  const n = size * size;
  const data = new Uint8Array(n * 4);
  const aoArr = ArrayBuffer.isView(ao) ? ao : null;
  const rArr = ArrayBuffer.isView(rough) ? rough : null;
  const mArr = ArrayBuffer.isView(metal) ? metal : null;
  const aoC = aoArr ? 0 : ao ?? 1;
  const rC = rArr ? 0 : rough ?? 0.8;
  const mC = mArr ? 0 : metal ?? 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    data[j] = u8(aoArr ? aoArr[i] : aoC);
    data[j + 1] = u8(rArr ? rArr[i] : rC);
    data[j + 2] = u8(mArr ? mArr[i] : mC);
    data[j + 3] = 255;
  }
  return data;
}

/** Expand a single Float32 field into an RGBA byte buffer (grey in RGB, 255 alpha). */
export function fieldToBytes(f, size, srgb = false) {
  const n = size * size;
  const data = new Uint8Array(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const v = srgb ? linearToByte(f[i]) : u8(f[i]);
    data[j] = v;
    data[j + 1] = v;
    data[j + 2] = v;
    data[j + 3] = 255;
  }
  return data;
}

// ────────────────────────────────────────────────────────────── textures ──

/**
 * Wrap a byte buffer or a canvas into a fully configured THREE.Texture.
 * @param {Uint8Array|HTMLCanvasElement|OffscreenCanvas} src
 * @param {{size?:number,srgb?:boolean,repeat?:number[],wrap?:'repeat'|'clamp'|'mirror',
 *          anisotropy?:number,generateMipmaps?:boolean,name?:string}} opts
 */
export function toTexture(src, opts = {}) {
  const {
    size,
    srgb = false,
    repeat = [1, 1],
    wrap = 'repeat',
    anisotropy = ENV.anisotropy,
    generateMipmaps = true,
    name = '',
  } = opts;
  let tex;
  if (ArrayBuffer.isView(src)) {
    const n = size || Math.sqrt(src.length / 4);
    tex = new THREE.DataTexture(src, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  } else {
    tex = new THREE.CanvasTexture(src);
    tex.flipY = false;
  }
  const w = wrap === 'clamp' ? THREE.ClampToEdgeWrapping : wrap === 'mirror' ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
  tex.wrapS = w;
  tex.wrapT = w;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = Math.min(anisotropy, ENV.maxAnisotropy);
  tex.generateMipmaps = generateMipmaps;
  tex.minFilter = generateMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.unpackAlignment = 1;
  tex.name = name;
  tex.needsUpdate = true;
  return tex;
}

// ─────────────────────────────────────────────────────── surface pipeline ──

/**
 * Allocate the working fields for a surface generator.
 * r/g/b: display-referred sRGB 0..1 · h: height 0..1 · rough: 0..1 · metal/alpha: lazily created.
 */
export function beginSurface(size) {
  const n = size * size;
  return {
    size,
    n,
    r: new Float32Array(n),
    g: new Float32Array(n),
    b: new Float32Array(n),
    h: new Float32Array(n),
    rough: new Float32Array(n),
    metal: null,
    alpha: null,
    /** Lazily allocate the metalness field. */
    useMetal(fill = 0) {
      if (!this.metal) {
        this.metal = new Float32Array(this.n);
        if (fill) this.metal.fill(fill);
      }
      return this.metal;
    },
    /** Lazily allocate the alpha field. */
    useAlpha(fill = 1) {
      if (!this.alpha) {
        this.alpha = new Float32Array(this.n);
        this.alpha.fill(fill);
      }
      return this.alpha;
    },
    /** Fill the albedo with a flat colour. */
    fillRgb(rgb) {
      this.r.fill(rgb[0]);
      this.g.fill(rgb[1]);
      this.b.fill(rgb[2]);
    },
  };
}

/**
 * Turn working fields into the final texture set. Handles normal generation, optional baked AO,
 * ORM packing and THREE.Texture configuration.
 *
 * @returns {{map:THREE.Texture, normalMap:THREE.Texture, roughnessMap:THREE.Texture,
 *            metalnessMap:THREE.Texture, aoMap:THREE.Texture, orm:THREE.Texture,
 *            alphaMap:THREE.Texture|null, displacementish:object, tileMetres:number[],
 *            normalScale:number, repeatFor:Function, dispose:Function}}
 */
export function finishSurface(S, opts = {}) {
  const {
    name = 'tex',
    normalStrength = 1,
    ao = null, // { radius, scale, strength } or null
    heightScale = 0.003, // metres of real relief the height field represents
    tileMetres = [1, 1],
    wrap = 'repeat',
    anisotropy = ENV.anisotropy,
    srgb = true,
    generateMipmaps = true,
    alphaInAlbedo = true,
  } = opts;
  const size = S.size;
  const n = S.n;

  // Albedo (+ alpha in A so a single map can drive cutout materials).
  const alb = new Uint8Array(n * 4);
  const A = S.alpha;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    alb[j] = u8(S.r[i]);
    alb[j + 1] = u8(S.g[i]);
    alb[j + 2] = u8(S.b[i]);
    alb[j + 3] = A && alphaInAlbedo ? u8(A[i]) : 255;
  }

  const nrm = heightToNormal(S.h, size, normalStrength);

  let aoField = null;
  if (ao) {
    const aoSize = Math.min(size, ao.size || 256);
    const small = downsampleField(S.h, size, aoSize);
    const raw = heightToAO(small, aoSize, {
      radius: ao.radius ?? 0.05,
      scale: ao.scale ?? 6,
      strength: ao.strength ?? 1,
      samples: ao.samples ?? ENV.aoSamples,
      steps: ao.steps ?? ENV.aoSteps,
    });
    aoField = upsampleField(raw, aoSize, size);
  }

  const orm = packORM(aoField ?? 1, S.rough, S.metal ?? 0, size);

  const mkOpts = { size, repeat: [1, 1], wrap, anisotropy, generateMipmaps };
  const map = toTexture(alb, { ...mkOpts, srgb, name: `${name}.map` });
  const normalMap = toTexture(nrm, { ...mkOpts, name: `${name}.normal` });
  const ormTex = toTexture(orm, { ...mkOpts, name: `${name}.orm` });
  ormTex.channel = 0;

  let alphaMap = null;
  if (S.alpha) alphaMap = toTexture(fieldToBytes(S.alpha, size), { ...mkOpts, name: `${name}.alpha` });

  const heightData = S.h;
  let heightTex = null;
  const result = {
    name,
    size,
    map,
    normalMap,
    roughnessMap: ormTex,
    metalnessMap: S.metal ? ormTex : null,
    aoMap: aoField ? ormTex : null,
    orm: ormTex,
    alphaMap,
    normalScale: normalStrength,
    tileMetres,
    /** Height field + suggested displacementScale, for parallax/bump/displacement users. */
    displacementish: {
      data: heightData,
      size,
      scale: heightScale,
      get texture() {
        if (!heightTex) heightTex = toTexture(fieldToBytes(heightData, size), { ...mkOpts, name: `${name}.height` });
        return heightTex;
      },
    },
    /** Repeat counts for a surface of the given world size in metres. */
    repeatFor(worldW, worldH = worldW) {
      return [worldW / tileMetres[0], worldH / tileMetres[1]];
    },
    /** Apply repeat to every map in this set at once. */
    setRepeat(u, v = u) {
      for (const t of [map, normalMap, ormTex, alphaMap, heightTex]) if (t) t.repeat.set(u, v);
      return result;
    },
    dispose() {
      for (const t of [map, normalMap, ormTex, alphaMap, heightTex]) if (t) t.dispose();
    },
  };
  return result;
}
