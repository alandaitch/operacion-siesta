// Procedural film grade — a 32³ 3D LUT generated in JavaScript, no .cube file anywhere.
// OWNER: RENDER.
//
// The LUT is sampled by LUT3DEffect *after* ACES tonemapping, and LUT3DEffect declares
// `inputColorSpace = SRGBColorSpace`, so every value that reaches this table is a display-referred
// sRGB code value in [0,1]. That is exactly the domain a real print LUT works in, which is why the
// maths below is written in perceptual space rather than scene-linear.
//
// The grade, in order:
//   1. a gentle S-curve (blend toward smoothstep) — contrast without crushing the concrete slab;
//   2. a warm-shadow / cool-highlight split tone — the room's colour thesis in one operation:
//      cool daylight through the glazing, warm bounce off the cream rug;
//   3. desaturation in the deep shadows (real film loses chroma before it loses luminance);
//   4. a small warm lift on the black point so nothing is ever pure 0,0,0;
//   5. a soft highlight shoulder so the curtain and the window frame roll off instead of clipping.
//
// Everything is deterministic: same numbers every run, so screenshots stay diffable.

import { LookupTexture } from 'postprocessing';

const LUT_SIZE = 32;

// Rec.709 luma. Used for the split tone and the shadow desaturation.
const LR = 0.2126;
const LG = 0.7152;
const LB = 0.0722;

const CONTRAST = 0.22; // how far the S-curve leans toward smoothstep
const SHADOW_TINT = [1.052, 1.008, 0.948]; // warm bounce
const HIGHLIGHT_TINT = [0.974, 0.9925, 1.038]; // cool daylight
const SHADOW_DESAT = 0.79; // chroma multiplier in the deepest shadows
const MID_SAT = 1.055; // the toys are the only saturated things in frame — let them sing
const LIFT = [0.0138, 0.0101, 0.0064]; // warm matte lift
const SHOULDER = 0.86; // where the highlight rolloff begins

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function sCurve(x) {
  const s = x * x * (3 - 2 * x);
  return x * (1 - CONTRAST) + s * CONTRAST;
}

function shoulder(x) {
  if (x <= SHOULDER) return x;
  const over = x - SHOULDER;
  return SHOULDER + over / (1 + over * 2.35);
}

/**
 * Evaluates the grade for one display-space RGB triplet. Exported so the look can be unit-checked
 * or previewed as a strip without building a whole texture.
 * @param {number} r 0..1
 * @param {number} g 0..1
 * @param {number} b 0..1
 * @param {number[]} out length-3 scratch array
 */
export function gradePixel(r, g, b, out) {
  let cr = sCurve(r);
  let cg = sCurve(g);
  let cb = sCurve(b);

  const luma = cr * LR + cg * LG + cb * LB;

  // 2. split tone
  const ws = (1 - smoothstep(0.0, 0.46, luma)) * 0.88;
  const wh = smoothstep(0.5, 1.0, luma) * 0.82;
  cr *= 1 + (SHADOW_TINT[0] - 1) * ws + (HIGHLIGHT_TINT[0] - 1) * wh;
  cg *= 1 + (SHADOW_TINT[1] - 1) * ws + (HIGHLIGHT_TINT[1] - 1) * wh;
  cb *= 1 + (SHADOW_TINT[2] - 1) * ws + (HIGHLIGHT_TINT[2] - 1) * wh;

  // 3. chroma response: dead in the blacks, a touch hot through the midtones
  const l2 = cr * LR + cg * LG + cb * LB;
  let sat = SHADOW_DESAT + (1 - SHADOW_DESAT) * smoothstep(0.0, 0.3, l2);
  sat *= 1 + (MID_SAT - 1) * smoothstep(0.12, 0.5, l2) * (1 - smoothstep(0.62, 0.98, l2));
  cr = l2 + (cr - l2) * sat;
  cg = l2 + (cg - l2) * sat;
  cb = l2 + (cb - l2) * sat;

  // 4. warm lift, strongest in the blacks
  const liftW = 1 - smoothstep(0.0, 0.36, l2);
  cr += LIFT[0] * liftW;
  cg += LIFT[1] * liftW;
  cb += LIFT[2] * liftW;

  // 5. highlight shoulder
  cr = shoulder(cr);
  cg = shoulder(cg);
  cb = shoulder(cb);

  out[0] = Math.min(1, Math.max(0, cr));
  out[1] = Math.min(1, Math.max(0, cg));
  out[2] = Math.min(1, Math.max(0, cb));
  return out;
}

/**
 * Builds the graded 3D lookup texture.
 * @param {{ float32Filterable?: boolean }} [caps] renderer capability probe from createEngine
 * @returns {LookupTexture}
 */
export function createFilmLUT(caps = {}) {
  const size = LUT_SIZE;
  const sizeSq = size * size;
  const step = 1 / (size - 1);
  const data = new Float32Array(size * size * size * 4);
  const out = [0, 0, 0];

  for (let b = 0; b < size; b++) {
    const bv = b * step;
    for (let g = 0; g < size; g++) {
      const gv = g * step;
      for (let r = 0; r < size; r++) {
        gradePixel(r * step, gv, bv, out);
        const i4 = (r + g * size + b * sizeSq) * 4;
        data[i4 + 0] = out[0];
        data[i4 + 1] = out[1];
        data[i4 + 2] = out[2];
        data[i4 + 3] = 1;
      }
    }
  }

  const lut = new LookupTexture(data, size);
  lut.name = 'grade.lateAfternoonBA';

  // Float32 3D textures need OES_texture_float_linear to filter. If the driver cannot, drop to
  // 8-bit — at 32³ the banding is invisible after grain and it beats a hard-edged LUT.
  if (caps.float32Filterable === false) lut.convertToUint8();

  lut.needsUpdate = true;
  return lut;
}
