// AUDIO · the sound catalogue. Two registries:
//
//   BUFFERS — named render recipes. Each one is rendered into a small pool of variants the first
//   time it is needed (and then warmed in the background), so "no two impacts are identical" is
//   paid for once instead of per hit. Per-play variation on top of the pool comes from which
//   variant is picked, a jittered playbackRate, a jittered filter and the hit intensity.
//
//   SOUNDS — the things you can actually play(). A generator receives the engine handle A and the
//   play options, wires nodes into A.dest, schedules them at A.t, and returns its tail length in
//   seconds so the voice allocator knows when to free the slot.
//
// The design rule everywhere: an impact is a *transient* plus a *body* plus *debris*. Cheap
// engines ship only the body, which is why their crockery sounds like a woodblock. The ceramic
// shatter here is a 9-mode crack, a wideband noise burst, ~140 granular shards with a bounce
// probability, and three larger tumbling fragments spread over the following half second.

import {
  makeBuffer,
  whiteInto,
  pinkInto,
  brownInto,
  lp1,
  hp1,
  bp2,
  peakEq,
  dcBlock,
  peakNormalize,
  attackInto,
  releaseInto,
  decayInto,
  saturate,
  modalInto,
  grainsInto,
  crinkleInto,
  creakInto,
  karplusInto,
  gainNode,
  filterNode,
  bufferSource,
  pluck,
  clamp,
} from './dsp.js';

import {
  babySqueal,
  babyGiggle,
  babyGrunt,
  babyBabble,
  babyHiccup,
  babyRaspberry,
  babyChew,
  babySlurp,
  babyBreath,
  babyGasp,
  parentBark,
  parentSigh,
  distantDog,
} from './voice.js';

// ---------------------------------------------------------------------------------------------
// render helpers
// ---------------------------------------------------------------------------------------------

function finish(data, sr, peak = 0.9) {
  dcBlock(data);
  attackInto(data, sr, 0.0008);
  releaseInto(data, sr, 0.008);
  peakNormalize(data, peak);
}

/** A filtered, enveloped noise burst added into `data`. The workhorse transient. */
function burstInto(data, sr, r, o) {
  const start = Math.round((o.start || 0) * sr);
  const len = Math.min(data.length - start, Math.round((o.len || 0.12) * sr));
  if (len <= 4) return;
  const tmp = new Float32Array(len);
  whiteInto(tmp, r, 1);
  if (o.bpf) bp2(tmp, sr, o.bpf, o.q || 1.2);
  if (o.lp) lp1(tmp, sr, o.lp, o.lpPasses || 1);
  if (o.hp) hp1(tmp, sr, o.hp, 1);
  const k = Math.exp(-1 / ((o.tau || 0.03) * sr));
  let e = 1;
  const g = o.gain === undefined ? 0.5 : o.gain;
  const atk = Math.max(1, Math.round((o.attack || 0.0006) * sr));
  for (let i = 0; i < len; i++) {
    const a = i < atk ? i / atk : 1;
    data[start + i] += tmp[i] * e * g * a;
    e *= k;
  }
}

const V = (r, spread) => 1 + (r() * 2 - 1) * spread;

/** Seconds folded out of the end of a looping bed so its loop point is inaudible. */
export const LOOP_TRIM = { streetBed: 0.4, roomTone: 0.3 };

// ---------------------------------------------------------------------------------------------
// BUFFERS
// ---------------------------------------------------------------------------------------------

export const BUFFERS = {
  // --- generic ------------------------------------------------------------------------------
  thud: {
    seconds: 0.3,
    pri: 0,
    build(d, sr, r) {
      const v = V(r, 0.14);
      modalInto(
        d,
        sr,
        [
          { f: 74 * v, a: 1, tau: 0.075 },
          { f: 127 * v, a: 0.42, tau: 0.05 },
          { f: 211 * v, a: 0.14, tau: 0.028 },
        ],
        r,
        1.4,
        0.55,
      );
      burstInto(d, sr, r, { lp: 340, tau: 0.032, gain: 0.55, len: 0.18 });
      finish(d, sr, 0.88);
    },
  },

  // --- books / paper ------------------------------------------------------------------------
  bookRug: {
    seconds: 0.42,
    pri: 1,
    build(d, sr, r) {
      const v = V(r, 0.15);
      modalInto(
        d,
        sr,
        [
          { f: 61 * v, a: 1, tau: 0.07 },
          { f: 103 * v, a: 0.4, tau: 0.045 },
        ],
        r,
        2.2,
        0.7,
      );
      burstInto(d, sr, r, { lp: 300, tau: 0.04, gain: 0.5, len: 0.2 });
      burstInto(d, sr, r, { bpf: 2600 * V(r, 0.2), q: 0.9, tau: 0.085, gain: 0.11, len: 0.3, start: 0.01 });
      finish(d, sr, 0.85);
    },
  },
  bookWood: {
    seconds: 0.42,
    pri: 1,
    build(d, sr, r) {
      const v = V(r, 0.13);
      modalInto(
        d,
        sr,
        [
          { f: 147 * v, a: 1, tau: 0.055 },
          { f: 263 * v, a: 0.5, tau: 0.038 },
          { f: 431 * v, a: 0.24, tau: 0.026 },
          { f: 690 * v, a: 0.1, tau: 0.016 },
        ],
        r,
        0.9,
        0.4,
      );
      burstInto(d, sr, r, { hp: 3500, tau: 0.005, gain: 0.4, len: 0.04 });
      burstInto(d, sr, r, { bpf: 3100 * V(r, 0.2), q: 0.8, tau: 0.07, gain: 0.14, len: 0.28, start: 0.012 });
      finish(d, sr, 0.9);
    },
  },
  paperRustle: {
    seconds: 0.55,
    pri: 6,
    build(d, sr, r) {
      const n = d.length;
      whiteInto(d, r, 1);
      bp2(d, sr, 2900 * V(r, 0.2), 0.85);
      let hold = 0;
      let lvl = 0.4;
      for (let i = 0; i < n; i++) {
        if (hold-- <= 0) {
          hold = Math.round((0.004 + r() * 0.02) * sr);
          lvl = 0.15 + r() * r() * 1.1;
        }
        d[i] *= lvl * Math.pow(1 - i / n, 1.2);
      }
      grainsInto(d, sr, r, {
        count: 26,
        tStart: 0,
        tEnd: 0.4,
        decay: 0.2,
        fMin: 2400,
        fMax: 7000,
        lenMin: 0.0008,
        lenMax: 0.003,
        gain: 0.35,
        noisiness: 0.7,
      });
      finish(d, sr, 0.7);
    },
  },

  // --- ceramic / glass ----------------------------------------------------------------------
  ceramicClink: {
    seconds: 0.55,
    pri: 1,
    build(d, sr, r) {
      const v = V(r, 0.09);
      modalInto(
        d,
        sr,
        [
          { f: 1874 * v, a: 1, tau: 0.115 },
          { f: 3121 * v * 1.004, a: 0.62, tau: 0.078 },
          { f: 4562 * v, a: 0.31, tau: 0.05 },
          { f: 986 * v, a: 0.42, tau: 0.062 },
          { f: 6890 * v, a: 0.14, tau: 0.03 },
        ],
        r,
        0.35,
        0.22,
      );
      burstInto(d, sr, r, { hp: 5200, tau: 0.0035, gain: 0.26, len: 0.03 });
      finish(d, sr, 0.9);
    },
  },
  shatterCrack: {
    seconds: 0.55,
    pri: 3,
    variants: 4,
    build(d, sr, r) {
      const v = V(r, 0.12);
      const modes = [];
      for (let k = 0; k < 9; k++) {
        const f = (820 + k * 640) * v * (1 + (r() - 0.5) * 0.16);
        modes.push({ f, a: 1 / (1 + k * 0.55), tau: 0.13 / (1 + k * 0.42) });
      }
      modalInto(d, sr, modes, r, 0.5, 0.6);
      burstInto(d, sr, r, { hp: 1300, tau: 0.018, gain: 0.85, len: 0.09 });
      burstInto(d, sr, r, { bpf: 380, q: 1.1, tau: 0.05, gain: 0.4, len: 0.16 });
      saturate(d, 1.6);
      finish(d, sr, 0.95);
    },
  },
  shatterDebris: {
    seconds: 1.3,
    pri: 3,
    variants: 4,
    build(d, sr, r) {
      grainsInto(d, sr, r, {
        count: 150,
        tStart: 0.012,
        tEnd: 1.05,
        decay: 0.34,
        fMin: 1700,
        fMax: 8200,
        lenMin: 0.0012,
        lenMax: 0.0065,
        gain: 0.62,
        noisiness: 0.4,
        skew: 2.1,
        bounce: 0.45,
      });
      // three larger fragments still tumbling after the storm
      for (let k = 0; k < 3; k++) {
        const t = 0.16 + r() * 0.5;
        const tmp = new Float32Array(Math.round(0.2 * sr));
        modalInto(
          tmp,
          sr,
          [
            { f: 1150 + r() * 1500, a: 1, tau: 0.045 },
            { f: 2400 + r() * 2000, a: 0.5, tau: 0.03 },
          ],
          r,
          0.3,
          0.3,
        );
        const at = Math.round(t * sr);
        const g = 0.3 - k * 0.07;
        for (let i = 0; i < tmp.length && at + i < d.length; i++) d[at + i] += tmp[i] * g;
      }
      finish(d, sr, 0.92);
    },
  },
  glassRing: {
    seconds: 1.35,
    pri: 4,
    variants: 2,
    build(d, sr, r) {
      const v = V(r, 0.06);
      const part = [
        [1186, 0.95, 1],
        [2762, 0.72, 0.62],
        [4318, 0.5, 0.34],
        [6140, 0.34, 0.18],
      ];
      const modes = [];
      for (let k = 0; k < part.length; k++) {
        const [f, tau, a] = part[k];
        // Two detuned partials per mode → slow beating, the sound of real glass.
        modes.push({ f: f * v, a, tau });
        modes.push({ f: f * v * (1 + (0.0006 + r() * 0.0018)), a: a * 0.8, tau: tau * 0.9 });
      }
      modalInto(d, sr, modes, r, 0.3, 0.18);
      burstInto(d, sr, r, { hp: 6000, tau: 0.003, gain: 0.18, len: 0.025 });
      finish(d, sr, 0.85);
    },
  },

  // --- wood / stone / plastic / metal --------------------------------------------------------
  woodKnock: {
    seconds: 0.34,
    pri: 0,
    build(d, sr, r) {
      const v = V(r, 0.16);
      modalInto(
        d,
        sr,
        [
          { f: 412 * v, a: 1, tau: 0.055 },
          { f: 761 * v, a: 0.55, tau: 0.038 },
          { f: 1324 * v, a: 0.28, tau: 0.024 },
          { f: 168 * v, a: 0.6, tau: 0.06 },
        ],
        r,
        1.1,
        0.5,
      );
      burstInto(d, sr, r, { lp: 2400, hp: 400, tau: 0.012, gain: 0.4, len: 0.07 });
      finish(d, sr, 0.9);
    },
  },
  stoneHit: {
    seconds: 0.26,
    pri: 5,
    build(d, sr, r) {
      const v = V(r, 0.14);
      modalInto(
        d,
        sr,
        [
          { f: 243 * v, a: 1, tau: 0.028 },
          { f: 528 * v, a: 0.5, tau: 0.019 },
          { f: 1180 * v, a: 0.2, tau: 0.012 },
        ],
        r,
        0.4,
        0.45,
      );
      burstInto(d, sr, r, { hp: 1800, tau: 0.008, gain: 0.55, len: 0.05 });
      finish(d, sr, 0.9);
    },
  },
  plasticClatter: {
    seconds: 0.5,
    pri: 2,
    build(d, sr, r) {
      const hits = 3 + Math.floor(r() * 3);
      for (let k = 0; k < hits; k++) {
        const t = k === 0 ? 0 : 0.02 + r() * 0.24;
        const at = Math.round(t * sr);
        const len = Math.round(0.11 * sr);
        if (at + len >= d.length) continue;
        const tmp = new Float32Array(len);
        const f = 780 + r() * 1900;
        modalInto(
          tmp,
          sr,
          [
            { f, a: 1, tau: 0.019 },
            { f: f * 1.87, a: 0.45, tau: 0.013 },
            { f: f * 0.42, a: 0.3, tau: 0.026 },
          ],
          r,
          0.35,
          0.5,
        );
        burstInto(tmp, sr, r, { hp: 2600, tau: 0.005, gain: 0.35, len: 0.03 });
        const g = Math.pow(0.72, k) * (0.7 + r() * 0.3);
        for (let i = 0; i < len; i++) d[at + i] += tmp[i] * g;
      }
      finish(d, sr, 0.88);
    },
  },
  metalTing: {
    seconds: 1.5,
    pri: 4,
    variants: 2,
    build(d, sr, r) {
      const v = V(r, 0.08);
      const part = [
        [2214, 1.25, 1],
        [3178, 0.95, 0.7],
        [5391, 0.62, 0.42],
        [6883, 0.44, 0.26],
        [9140, 0.28, 0.14],
      ];
      const modes = [];
      for (let k = 0; k < part.length; k++) {
        const [f, tau, a] = part[k];
        modes.push({ f: f * v, a, tau });
        modes.push({ f: f * v * (1 + 0.0011 + r() * 0.0022), a: a * 0.7, tau: tau * 0.85 });
      }
      modalInto(d, sr, modes, r, 0.25, 0.2);
      burstInto(d, sr, r, { hp: 7000, tau: 0.002, gain: 0.2, len: 0.02 });
      finish(d, sr, 0.85);
    },
  },
  vinylSlap: {
    seconds: 0.4,
    pri: 6,
    build(d, sr, r) {
      const v = V(r, 0.15);
      modalInto(
        d,
        sr,
        [
          { f: 331 * v, a: 1, tau: 0.05 },
          { f: 692 * v, a: 0.4, tau: 0.032 },
          { f: 96 * v, a: 0.7, tau: 0.06 },
        ],
        r,
        1.6,
        0.6,
      );
      burstInto(d, sr, r, { lp: 1600, tau: 0.026, gain: 0.4, len: 0.12 });
      finish(d, sr, 0.88);
    },
  },
  wickerCreak: {
    seconds: 0.6,
    pri: 7,
    build(d, sr, r) {
      creakInto(d, sr, r, { rate: 190, wander: 0.6, res: 1250, res2: 2900, gain: 0.5 });
      decayInto(d, sr, 0.16);
      grainsInto(d, sr, r, {
        count: 16,
        tStart: 0,
        tEnd: 0.3,
        decay: 0.14,
        fMin: 900,
        fMax: 3600,
        lenMin: 0.001,
        lenMax: 0.004,
        gain: 0.4,
        noisiness: 0.5,
      });
      finish(d, sr, 0.8);
    },
  },
  rubberBounce: {
    seconds: 0.36,
    pri: 7,
    build(d, sr, r) {
      const v = V(r, 0.18);
      modalInto(d, sr, [{ f: 188 * v, a: 1, tau: 0.038 }, { f: 402 * v, a: 0.3, tau: 0.02 }], r, 1.6, 0.5);
      burstInto(d, sr, r, { bpf: 1100 * v, q: 2.4, tau: 0.02, gain: 0.3, len: 0.09 });
      finish(d, sr, 0.85);
    },
  },

  // --- soft goods ---------------------------------------------------------------------------
  plushFlump: {
    seconds: 0.36,
    pri: 2,
    build(d, sr, r) {
      modalInto(d, sr, [{ f: 47 * V(r, 0.2), a: 1, tau: 0.07 }], r, 3, 0.8);
      burstInto(d, sr, r, { lp: 190, tau: 0.05, gain: 0.8, len: 0.2 });
      burstInto(d, sr, r, { bpf: 1700 * V(r, 0.25), q: 0.7, tau: 0.1, gain: 0.06, len: 0.3 });
      finish(d, sr, 0.7);
    },
  },
  clothThud: {
    seconds: 0.45,
    pri: 5,
    build(d, sr, r) {
      const n = d.length;
      whiteInto(d, r, 1);
      bp2(d, sr, 950 * V(r, 0.25), 0.7);
      for (let i = 0; i < n; i++) {
        const u = i / n;
        d[i] *= Math.pow(1 - u, 2.2) * (0.6 + 0.4 * Math.sin(u * 41 + r() * 0.2));
      }
      modalInto(d, sr, [{ f: 68 * V(r, 0.2), a: 0.5, tau: 0.05 }], r, 2, 0.6);
      finish(d, sr, 0.7);
    },
  },
  foilCrinkle: {
    seconds: 0.7,
    pri: 2,
    variants: 4,
    build(d, sr, r) {
      crinkleInto(d, sr, r, { gain: 1, density: 1100, shape: 0.8 });
      hp1(d, sr, 1400, 1);
      peakEq(d, sr, 4200 * V(r, 0.15), 1.6, 6);
      peakEq(d, sr, 7600, 2, 3);
      finish(d, sr, 0.82);
    },
  },

  // --- nature -------------------------------------------------------------------------------
  leafRustle: {
    seconds: 0.7,
    pri: 6,
    build(d, sr, r) {
      const n = d.length;
      whiteInto(d, r, 1);
      bp2(d, sr, 3400 * V(r, 0.2), 0.7);
      for (let i = 0; i < n; i++) {
        const u = i / n;
        d[i] *= Math.pow(1 - u, 1.4) * (0.4 + 0.6 * r());
      }
      grainsInto(d, sr, r, {
        count: 44,
        tStart: 0,
        tEnd: 0.5,
        decay: 0.22,
        fMin: 1800,
        fMax: 6500,
        lenMin: 0.0008,
        lenMax: 0.0035,
        gain: 0.4,
        noisiness: 0.75,
      });
      finish(d, sr, 0.72);
    },
  },
  soilScatter: {
    seconds: 0.85,
    pri: 5,
    build(d, sr, r) {
      grainsInto(d, sr, r, {
        count: 190,
        tStart: 0.005,
        tEnd: 0.62,
        decay: 0.2,
        fMin: 220,
        fMax: 1500,
        lenMin: 0.0015,
        lenMax: 0.007,
        gain: 0.5,
        noisiness: 0.85,
        skew: 1.5,
        bounce: 0.2,
      });
      lp1(d, sr, 2200, 1);
      burstInto(d, sr, r, { lp: 260, tau: 0.05, gain: 0.35, len: 0.2 });
      finish(d, sr, 0.8);
    },
  },

  // --- flesh --------------------------------------------------------------------------------
  fleshPat: {
    seconds: 0.3,
    pri: 4,
    build(d, sr, r) {
      modalInto(d, sr, [{ f: 96 * V(r, 0.2), a: 1, tau: 0.04 }, { f: 205 * V(r, 0.2), a: 0.3, tau: 0.022 }], r, 1.8, 0.7);
      burstInto(d, sr, r, { bpf: 780 * V(r, 0.3), q: 1.0, tau: 0.016, gain: 0.35, len: 0.06 });
      finish(d, sr, 0.8);
    },
  },

  // --- the baby's hands and knees -------------------------------------------------------------
  patRug: {
    seconds: 0.26,
    pri: 0,
    variants: 4,
    build(d, sr, r) {
      modalInto(d, sr, [{ f: 68 * V(r, 0.22), a: 1, tau: 0.045 }], r, 2.2, 0.8);
      burstInto(d, sr, r, { lp: 430 * V(r, 0.2), tau: 0.03, gain: 0.75, len: 0.14 });
      burstInto(d, sr, r, { bpf: 2100, q: 0.7, tau: 0.05, gain: 0.05, len: 0.16 });
      finish(d, sr, 0.72);
    },
  },
  patWood: {
    seconds: 0.3,
    pri: 0,
    variants: 4,
    build(d, sr, r) {
      const v = V(r, 0.18);
      modalInto(
        d,
        sr,
        [
          { f: 193 * v, a: 1, tau: 0.03 },
          { f: 386 * v, a: 0.4, tau: 0.02 },
          { f: 812 * v, a: 0.15, tau: 0.012 },
        ],
        r,
        0.7,
        0.5,
      );
      burstInto(d, sr, r, { bpf: 1500 * v, q: 0.9, tau: 0.011, gain: 0.5, len: 0.05 });
      finish(d, sr, 0.8);
    },
  },
  patMat: {
    seconds: 0.28,
    pri: 1,
    variants: 3,
    build(d, sr, r) {
      const v = V(r, 0.2);
      modalInto(d, sr, [{ f: 112 * v, a: 1, tau: 0.038 }, { f: 268 * v, a: 0.35, tau: 0.022 }], r, 1.6, 0.6);
      burstInto(d, sr, r, { lp: 780 * v, tau: 0.022, gain: 0.6, len: 0.1 });
      finish(d, sr, 0.74);
    },
  },

  // --- baby voice ---------------------------------------------------------------------------
  babySqueal: { seconds: 0.85, pri: 2, variants: 4, build: (d, sr, r) => babySqueal(d, sr, r) },
  babyGiggle: { seconds: 1.15, pri: 3, variants: 3, build: (d, sr, r) => babyGiggle(d, sr, r) },
  babyGrunt: { seconds: 0.5, pri: 2, variants: 4, build: (d, sr, r) => babyGrunt(d, sr, r) },
  babyBabble: { seconds: 0.95, pri: 4, variants: 4, build: (d, sr, r) => babyBabble(d, sr, r) },
  babyHiccup: { seconds: 0.34, pri: 6, variants: 3, build: (d, sr, r) => babyHiccup(d, sr, r) },
  babyRaspberry: { seconds: 0.65, pri: 5, variants: 3, build: (d, sr, r) => babyRaspberry(d, sr, r) },
  babyChew: { seconds: 0.72, pri: 3, variants: 4, build: (d, sr, r) => babyChew(d, sr, r) },
  babySlurp: { seconds: 0.5, pri: 4, variants: 3, build: (d, sr, r) => babySlurp(d, sr, r) },
  babyBreath: { seconds: 1.4, pri: 5, variants: 2, build: (d, sr, r) => babyBreath(d, sr, r) },
  babyGasp: { seconds: 0.36, pri: 4, variants: 3, build: (d, sr, r) => babyGasp(d, sr, r) },

  // --- the parent ---------------------------------------------------------------------------
  stepWood: {
    seconds: 0.36,
    pri: 1,
    variants: 4,
    build(d, sr, r) {
      const v = V(r, 0.13);
      modalInto(
        d,
        sr,
        [
          { f: 91 * v, a: 1, tau: 0.06 },
          { f: 176 * v, a: 0.5, tau: 0.04 },
          { f: 340 * v, a: 0.2, tau: 0.022 },
        ],
        r,
        1.6,
        0.6,
      );
      burstInto(d, sr, r, { bpf: 2200 * v, q: 1.1, tau: 0.009, gain: 0.4, len: 0.05 });
      burstInto(d, sr, r, { lp: 500, tau: 0.04, gain: 0.5, len: 0.18 });
      finish(d, sr, 0.9);
    },
  },
  stepRug: {
    seconds: 0.36,
    pri: 1,
    variants: 4,
    build(d, sr, r) {
      modalInto(d, sr, [{ f: 58 * V(r, 0.16), a: 1, tau: 0.06 }], r, 2.6, 0.8);
      burstInto(d, sr, r, { lp: 320 * V(r, 0.2), tau: 0.038, gain: 0.7, len: 0.18 });
      burstInto(d, sr, r, { bpf: 1900, q: 0.6, tau: 0.06, gain: 0.05, len: 0.2 });
      finish(d, sr, 0.78);
    },
  },
  parentBark: { seconds: 1.1, pri: 2, variants: 4, build: (d, sr, r) => parentBark(d, sr, r, 0.4 + r() * 0.5) },
  parentSigh: { seconds: 1.5, pri: 5, variants: 2, build: (d, sr, r) => parentSigh(d, sr, r) },
  sofaCreak: {
    seconds: 1.0,
    pri: 6,
    variants: 3,
    build(d, sr, r) {
      creakInto(d, sr, r, { rate: 62, wander: 0.45, res: 420, res2: 1150, gain: 0.6, roughness: 0.6 });
      const n = d.length;
      for (let i = 0; i < n; i++) {
        const u = i / n;
        d[i] *= Math.sin(Math.PI * Math.pow(u, 0.6)) * (1 - u * 0.3);
      }
      burstInto(d, sr, r, { bpf: 1500, q: 0.6, tau: 0.25, gain: 0.12, len: 0.7 });
      finish(d, sr, 0.75);
    },
  },
  clothRustle: {
    seconds: 0.65,
    pri: 5,
    variants: 3,
    build(d, sr, r) {
      const n = d.length;
      whiteInto(d, r, 1);
      bp2(d, sr, 1900 * V(r, 0.2), 0.6);
      let hold = 0;
      let lvl = 0.3;
      for (let i = 0; i < n; i++) {
        if (hold-- <= 0) {
          hold = Math.round((0.006 + r() * 0.03) * sr);
          lvl = 0.1 + r() * r() * 1.0;
        }
        d[i] *= lvl * Math.sin(Math.PI * Math.pow(i / n, 0.7));
      }
      finish(d, sr, 0.62);
    },
  },
  liftWhoosh: {
    seconds: 1.2,
    pri: 8,
    variants: 2,
    build(d, sr, r) {
      const n = d.length;
      const src = new Float32Array(n);
      brownInto(src, r, 1);
      whiteInto(src, r, 0.25);
      // a rising bandpass sweep = something big moving up past your ears
      const out = new Float32Array(n);
      let x1 = 0;
      let x2 = 0;
      let y1 = 0;
      let y2 = 0;
      for (let i0 = 0; i0 < n; i0 += 64) {
        const u = i0 / n;
        const f = 190 + 1500 * u * u;
        const w0 = (2 * Math.PI * f) / sr;
        const alpha = Math.sin(w0) / (2 * 1.4);
        const a0 = 1 + alpha;
        const b0 = alpha / a0;
        const b2 = -alpha / a0;
        const a1 = (-2 * Math.cos(w0)) / a0;
        const a2 = (1 - alpha) / a0;
        const end = Math.min(n, i0 + 64);
        for (let i = i0; i < end; i++) {
          const x = src[i];
          const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
          x2 = x1;
          x1 = x;
          y2 = y1;
          y1 = y;
          out[i] = y;
        }
      }
      for (let i = 0; i < n; i++) {
        const u = i / n;
        d[i] = out[i] * Math.sin(Math.PI * Math.pow(u, 0.8)) * 2.2;
      }
      finish(d, sr, 0.8);
    },
  },

  // --- the world ----------------------------------------------------------------------------
  cordCreak: {
    seconds: 0.85,
    pri: 6,
    variants: 3,
    build(d, sr, r) {
      creakInto(d, sr, r, { rate: 145, wander: 0.7, res: 780, res2: 1950, gain: 0.55, roughness: 0.7 });
      const n = d.length;
      for (let i = 0; i < n; i++) {
        const u = i / n;
        d[i] *= Math.sin(Math.PI * Math.pow(u, 0.5)) * (0.5 + 0.5 * Math.sin(u * 11));
      }
      finish(d, sr, 0.62);
    },
  },
  curtainRustle: {
    seconds: 1.1,
    pri: 7,
    variants: 2,
    build(d, sr, r) {
      const n = d.length;
      whiteInto(d, r, 1);
      bp2(d, sr, 2700 * V(r, 0.2), 0.55);
      for (let i = 0; i < n; i++) {
        const u = i / n;
        d[i] *= Math.sin(Math.PI * u) * (0.35 + 0.65 * Math.abs(Math.sin(u * 7.4 + r() * 0.01)));
      }
      finish(d, sr, 0.5);
    },
  },
  radiatorTick: {
    seconds: 0.26,
    pri: 7,
    variants: 3,
    build(d, sr, r) {
      const v = V(r, 0.25);
      modalInto(
        d,
        sr,
        [
          { f: 2650 * v, a: 1, tau: 0.035 },
          { f: 4180 * v, a: 0.5, tau: 0.022 },
          { f: 780 * v, a: 0.35, tau: 0.03 },
        ],
        r,
        0.3,
        0.3,
      );
      burstInto(d, sr, r, { hp: 3000, tau: 0.002, gain: 0.3, len: 0.02 });
      finish(d, sr, 0.6);
    },
  },
  clockTick: {
    seconds: 0.14,
    pri: 8,
    variants: 3,
    build(d, sr, r) {
      const v = V(r, 0.1);
      modalInto(d, sr, [{ f: 2400 * v, a: 1, tau: 0.008 }, { f: 5200 * v, a: 0.4, tau: 0.005 }], r, 0.25, 0.4);
      burstInto(d, sr, r, { hp: 2200, tau: 0.0025, gain: 0.5, len: 0.02 });
      finish(d, sr, 0.5);
    },
  },
  espressoPump: {
    seconds: 2.2,
    pri: 9,
    variants: 1,
    build(d, sr, r) {
      const n = d.length;
      // vibratory pump: a 50 Hz buzz with a lot of mechanical grit
      let next = 0;
      const period = sr / 50;
      for (let i = 0; i < n; i++) {
        if (i >= next) {
          d[i] += 1;
          next = i + period * (0.94 + r() * 0.12);
        }
      }
      bp2(d, sr, 320, 2.2);
      const grind = new Float32Array(n);
      whiteInto(grind, r, 1);
      bp2(grind, sr, 1700, 1.1);
      for (let i = 0; i < n; i++) {
        const u = i / n;
        const env = Math.min(1, u * 12) * (u > 0.85 ? (1 - u) / 0.15 : 1);
        d[i] = (d[i] * 1.4 + grind[i] * 0.28) * env;
      }
      finish(d, sr, 0.65);
    },
  },
  steamHiss: {
    seconds: 1.4,
    pri: 9,
    variants: 1,
    build(d, sr, r) {
      const n = d.length;
      whiteInto(d, r, 1);
      bp2(d, sr, 5200, 0.6);
      peakEq(d, sr, 2600, 1.2, 5);
      for (let i = 0; i < n; i++) {
        const u = i / n;
        d[i] *= Math.min(1, u * 22) * Math.pow(1 - u, 0.7) * (0.75 + 0.25 * r());
      }
      finish(d, sr, 0.55);
    },
  },
  dogBark: { seconds: 1.1, pri: 8, variants: 2, build: (d, sr, r) => distantDog(d, sr, r) },
  carPass: {
    seconds: 2.4,
    pri: 9,
    variants: 2,
    build(d, sr, r) {
      const n = d.length;
      brownInto(d, r, 1);
      whiteInto(d, r, 0.15);
      const out = new Float32Array(n);
      let x1 = 0;
      let x2 = 0;
      let y1 = 0;
      let y2 = 0;
      for (let i0 = 0; i0 < n; i0 += 64) {
        const u = i0 / n;
        const f = 240 + 620 * Math.sin(Math.PI * u); // doppler-ish arch
        const w0 = (2 * Math.PI * f) / sr;
        const alpha = Math.sin(w0) / (2 * 0.9);
        const a0 = 1 + alpha;
        const b0 = alpha / a0;
        const b2 = -alpha / a0;
        const a1 = (-2 * Math.cos(w0)) / a0;
        const a2 = (1 - alpha) / a0;
        const end = Math.min(n, i0 + 64);
        for (let i = i0; i < end; i++) {
          const x = d[i];
          const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
          x2 = x1;
          x1 = x;
          y2 = y1;
          y1 = y;
          out[i] = y;
        }
      }
      for (let i = 0; i < n; i++) {
        const u = i / n;
        d[i] = out[i] * Math.pow(Math.sin(Math.PI * u), 1.6) * 2.4;
      }
      lp1(d, sr, 1100, 1);
      finish(d, sr, 0.6);
    },
  },
  horn: {
    seconds: 0.85,
    pri: 9,
    variants: 2,
    build(d, sr, r) {
      const n = d.length;
      const f = 380 + r() * 120;
      for (let h = 1; h <= 7; h++) {
        const w = (2 * Math.PI * f * h * (1 + (r() - 0.5) * 0.004)) / sr;
        const a = 1 / (h * h * 0.6 + 1);
        for (let i = 0; i < n; i++) d[i] += Math.sin(w * i) * a;
      }
      for (let i = 0; i < n; i++) {
        const u = i / n;
        d[i] *= Math.min(1, u * 40) * (u > 0.75 ? (1 - u) / 0.25 : 1);
      }
      lp1(d, sr, 1400, 2);
      finish(d, sr, 0.45);
    },
  },
  streetBed: {
    seconds: 5.0,
    pri: 1,
    variants: 1,
    build(d, sr, r) {
      const n = d.length;
      brownInto(d, r, 1);
      const mid = new Float32Array(n);
      pinkInto(mid, r, 1);
      bp2(mid, sr, 620, 0.5);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        // slow traffic swells, two incommensurate rates so the loop never sounds like a loop
        const swell = 0.65 + 0.35 * Math.sin(t * 0.41) * Math.sin(t * 0.137 + 1.1);
        d[i] = (d[i] * 1.0 + mid[i] * 0.28) * swell;
      }
      lp1(d, sr, 420, 2);
      // Seam-free loop. Fold the last LOOP_TRIM seconds into the head with a rising crossfade and
      // then loop over [0, n − trim): sample n−trim−1 flows straight into the new sample 0.
      const x = Math.round(LOOP_TRIM.streetBed * sr);
      for (let i = 0; i < x; i++) {
        const k = i / x;
        d[i] = d[i] * k + d[n - x + i] * (1 - k);
      }
      dcBlock(d);
      peakNormalize(d, 0.8);
    },
  },
  roomTone: {
    seconds: 3.0,
    pri: 2,
    variants: 1,
    build(d, sr, r) {
      pinkInto(d, r, 1);
      lp1(d, sr, 160, 2);
      const n = d.length;
      const x = Math.round(LOOP_TRIM.roomTone * sr);
      for (let i = 0; i < x; i++) {
        const k = i / x;
        d[i] = d[i] * k + d[n - x + i] * (1 - k);
      }
      dcBlock(d);
      peakNormalize(d, 0.7);
    },
  },

  // --- interface ----------------------------------------------------------------------------
  uiTick: {
    seconds: 0.13,
    pri: 3,
    variants: 2,
    build(d, sr, r) {
      modalInto(d, sr, [{ f: 1850, a: 1, tau: 0.014 }, { f: 3900, a: 0.35, tau: 0.008 }], r, 0.2, 0.15);
      finish(d, sr, 0.6);
    },
  },
  uiBack: {
    seconds: 0.35,
    pri: 6,
    variants: 1,
    build(d, sr, r) {
      modalInto(d, sr, [{ f: 620, a: 1, tau: 0.06 }, { f: 415, a: 0.6, tau: 0.09 }], r, 0.4, 0.2);
      finish(d, sr, 0.6);
    },
  },
};

// ---------------------------------------------------------------------------------------------
// small node-graph builders shared by SOUNDS and the score
// ---------------------------------------------------------------------------------------------

/**
 * A two-operator FM bell. Carrier sine, modulator at a deliberately inharmonic ratio, modulation
 * index decaying fast — that decaying index is the whole trick: a bright metallic strike that
 * settles into a pure tone within 150 ms, which is what a celesta or a music box does.
 */
export function fmBell(ac, t, dest, o) {
  const freq = o.freq;
  const carrier = ac.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.value = freq;
  const mod = ac.createOscillator();
  mod.type = 'sine';
  mod.frequency.value = freq * (o.ratio === undefined ? 3.51 : o.ratio);
  const modGain = gainNode(ac, freq * (o.index === undefined ? 5 : o.index));
  mod.connect(modGain);
  modGain.connect(carrier.frequency);

  const decay = o.decay === undefined ? 0.8 : o.decay;
  modGain.gain.setValueAtTime(modGain.gain.value, t);
  modGain.gain.setTargetAtTime(freq * 0.15, t, decay * 0.09);

  const amp = gainNode(ac, 0.0001);
  carrier.connect(amp);
  amp.connect(dest);
  const end = pluck(amp.gain, t, o.gain === undefined ? 0.3 : o.gain, o.attack === undefined ? 0.004 : o.attack, decay);
  carrier.start(t);
  mod.start(t);
  carrier.stop(end + 0.05);
  mod.stop(end + 0.05);
  return end - t;
}

/** Sub-bass kick with a pitch drop. Used for the heartbeat and for big impacts. */
export function subDrop(ac, t, dest, o = {}) {
  const osc = ac.createOscillator();
  osc.type = 'sine';
  const f0 = o.from === undefined ? 150 : o.from;
  const f1 = o.to === undefined ? 42 : o.to;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(12, f1), t + (o.drop === undefined ? 0.07 : o.drop));
  const amp = gainNode(ac, 0.0001);
  osc.connect(amp);
  amp.connect(dest);
  const end = pluck(amp.gain, t, o.gain === undefined ? 0.5 : o.gain, 0.003, o.decay === undefined ? 0.16 : o.decay);
  osc.start(t);
  osc.stop(end + 0.05);
  return end - t;
}

// ---------------------------------------------------------------------------------------------
// SOUNDS
// ---------------------------------------------------------------------------------------------

/** Play a pooled buffer with per-shot rate/filter jitter. */
function shot(key, cfg = {}) {
  const rateLo = cfg.rate ? cfg.rate[0] : 0.94;
  const rateHi = cfg.rate ? cfg.rate[1] : 1.07;
  const level = cfg.level === undefined ? 1 : cfg.level;
  return (A, o) => {
    const buf = A.buf(key);
    if (!buf) return 0;
    const r = A.r;
    const inten = clamp(o.intensity === undefined ? 0.65 : o.intensity, 0.04, 1);
    const rate = (rateLo + (rateHi - rateLo) * r()) * (o.rate || 1) * (cfg.rateByIntensity ? 0.92 + inten * 0.16 : 1);
    const src = bufferSource(A.ac, buf, rate);
    let node = src;
    if (cfg.hp) {
      const f = filterNode(A.ac, 'highpass', cfg.hp, 0.7);
      node.connect(f);
      node = f;
    }
    // Soft landings (rug, bouclé, plush) eat the top end. `damped` comes straight from PHYS.
    const lpTarget = o.damped ? Math.min(cfg.lp || 20000, 1400) : cfg.lp;
    if (lpTarget && lpTarget < 19000) {
      const f = filterNode(A.ac, 'lowpass', lpTarget * (0.85 + 0.3 * inten), 0.8);
      node.connect(f);
      node = f;
    }
    const amp = level * (cfg.byIntensity === false ? 1 : 0.28 + 0.72 * inten) * (o.damped ? 0.72 : 1);
    const g = gainNode(A.ac, amp);
    node.connect(g);
    g.connect(A.dest);
    src.start(A.t);
    const dur = buf.duration / rate;
    src.stop(A.t + dur + 0.03);
    return dur;
  };
}

/** Layer several generators into one sound. */
function layer(...gens) {
  return (A, o) => {
    let d = 0;
    for (let i = 0; i < gens.length; i++) {
      const g = gens[i](A, o);
      if (g > d) d = g;
    }
    return d;
  };
}

/** Delay a generator by a fixed (optionally jittered) offset. */
function delayed(gen, min, max) {
  return (A, o) => {
    const off = min + (max - min) * A.r();
    const A2 = Object.create(A);
    A2.t = A.t + off;
    return off + gen(A2, o);
  };
}

export const SOUNDS = {
  // ---- impacts -----------------------------------------------------------------------------
  'impact.thud': shot('thud', { lp: 6000, rateByIntensity: true }),
  'impact.book.rug': shot('bookRug', { rateByIntensity: true }),
  'impact.book.wood': shot('bookWood', { rateByIntensity: true }),
  'impact.ceramic.clink': shot('ceramicClink', { rate: [0.9, 1.12], rateByIntensity: true }),
  'impact.glass.ring': shot('glassRing', { rate: [0.92, 1.1], level: 0.85 }),
  'impact.wood.knock': shot('woodKnock', { rate: [0.88, 1.14], rateByIntensity: true }),
  'impact.stone': shot('stoneHit', { rate: [0.9, 1.12] }),
  'impact.plastic.clatter': shot('plasticClatter', { rate: [0.9, 1.15] }),
  'impact.metal.ting': shot('metalTing', { rate: [0.9, 1.12], level: 0.8 }),
  'impact.vinyl': shot('vinylSlap', { rate: [0.92, 1.1] }),
  'impact.wicker': shot('wickerCreak', { rate: [0.9, 1.12], level: 0.8 }),
  'impact.rubber': shot('rubberBounce', { rate: [0.88, 1.16] }),
  'impact.plush.flump': shot('plushFlump', { rate: [0.9, 1.14], level: 0.85 }),
  'impact.cloth': shot('clothThud', { rate: [0.92, 1.1], level: 0.8 }),
  'impact.foil.crinkle': shot('foilCrinkle', { rate: [0.88, 1.14], level: 0.85 }),
  'impact.paper.rustle': shot('paperRustle', { rate: [0.9, 1.12], level: 0.8 }),
  'impact.leaf': shot('leafRustle', { rate: [0.9, 1.12], level: 0.8 }),
  'impact.soil': shot('soilScatter', { rate: [0.92, 1.08], level: 0.85 }),
  'impact.flesh': shot('fleshPat', { rate: [0.9, 1.12] }),

  /**
   * The one that has to be genuinely satisfying: crack + noise + 150 grains of debris that keep
   * skittering for a second afterwards, plus a low body thump so it has weight in the chest.
   */
  'impact.ceramic.shatter': layer(
    shot('shatterCrack', { rate: [0.9, 1.12], byIntensity: false, level: 1 }),
    shot('shatterDebris', { rate: [0.94, 1.08], byIntensity: false, level: 0.85 }),
    (A, o) => subDrop(A.ac, A.t, A.dest, { from: 190, to: 55, drop: 0.05, decay: 0.11, gain: 0.22 * (0.5 + (o.intensity || 0.7)) }),
    delayed(shot('thud', { byIntensity: false, level: 0.35, lp: 900 }), 0.005, 0.02),
  ),
  'impact.glass.shatter': layer(
    shot('shatterCrack', { rate: [1.15, 1.35], byIntensity: false }),
    shot('shatterDebris', { rate: [1.1, 1.25], byIntensity: false, level: 0.9, hp: 900 }),
    shot('glassRing', { rate: [1.0, 1.2], byIntensity: false, level: 0.35 }),
  ),

  // ---- the baby ----------------------------------------------------------------------------
  'baby.pat.rug': shot('patRug', { rate: [0.86, 1.18], rateByIntensity: true }),
  'baby.pat.wood': shot('patWood', { rate: [0.86, 1.18], rateByIntensity: true }),
  'baby.pat.mat': shot('patMat', { rate: [0.86, 1.18], rateByIntensity: true }),
  'baby.squeal': shot('babySqueal', { rate: [0.93, 1.09], byIntensity: false }),
  'baby.giggle': shot('babyGiggle', { rate: [0.94, 1.08], byIntensity: false }),
  'baby.grunt': shot('babyGrunt', { rate: [0.9, 1.12], byIntensity: false }),
  'baby.babble': shot('babyBabble', { rate: [0.93, 1.1], byIntensity: false, level: 0.9 }),
  'baby.hiccup': shot('babyHiccup', { rate: [0.94, 1.08], byIntensity: false }),
  'baby.raspberry': shot('babyRaspberry', { rate: [0.9, 1.12], byIntensity: false }),
  'baby.chew': shot('babyChew', { rate: [0.9, 1.12], byIntensity: false, level: 0.9 }),
  'baby.slurp': shot('babySlurp', { rate: [0.92, 1.1], byIntensity: false }),
  'baby.breath': shot('babyBreath', { rate: [0.9, 1.12], byIntensity: false, level: 0.7 }),
  'baby.gasp': shot('babyGasp', { rate: [0.93, 1.09], byIntensity: false }),
  'baby.bonk': layer(
    shot('fleshPat', { rate: [0.85, 1.0], level: 1 }),
    delayed(shot('babyGrunt', { rate: [0.95, 1.1], byIntensity: false, level: 0.7 }), 0.12, 0.26),
  ),
  'baby.yum': layer(
    shot('babyChew', { byIntensity: false }),
    delayed(shot('babySqueal', { rate: [1.0, 1.12], byIntensity: false, level: 0.75 }), 0.35, 0.5),
  ),
  'baby.gross': layer(
    shot('babyRaspberry', { byIntensity: false }),
    delayed(shot('babyGrunt', { rate: [1.05, 1.2], byIntensity: false, level: 0.8 }), 0.4, 0.55),
  ),
  'baby.spicy': layer(
    shot('babyGasp', { byIntensity: false }),
    delayed(shot('babySqueal', { rate: [1.15, 1.3], byIntensity: false }), 0.15, 0.25),
  ),
  'baby.dangerous': layer(
    shot('babyGasp', { byIntensity: false, level: 0.9 }),
    delayed(shot('babyGrunt', { rate: [0.85, 0.95], byIntensity: false }), 0.2, 0.32),
  ),

  // ---- the world ---------------------------------------------------------------------------
  'world.cordCreak': shot('cordCreak', { rate: [0.85, 1.2], byIntensity: false, level: 0.8 }),
  'world.curtain': shot('curtainRustle', { rate: [0.9, 1.12], byIntensity: false }),
  'world.radiatorTick': shot('radiatorTick', { rate: [0.8, 1.25], byIntensity: false, level: 0.55 }),
  'world.clockTick': shot('clockTick', { rate: [0.96, 1.05], byIntensity: false, level: 0.5 }),
  'world.dogBark': shot('dogBark', { rate: [0.85, 1.15], byIntensity: false, level: 0.7 }),
  'world.carPass': shot('carPass', { rate: [0.85, 1.15], byIntensity: false, level: 0.7 }),
  'world.horn': shot('horn', { rate: [0.85, 1.2], byIntensity: false, level: 0.5 }),
  'world.espresso': layer(
    shot('espressoPump', { rate: [0.97, 1.04], byIntensity: false }),
    delayed(shot('steamHiss', { rate: [0.95, 1.06], byIntensity: false, level: 0.7 }), 1.6, 1.9),
  ),
  /** The monstera going over: pot cracks, soil everywhere, leaves thrash, dull thump on the rug. */
  'world.plantCrash': layer(
    shot('shatterCrack', { rate: [0.72, 0.85], byIntensity: false, level: 0.85, lp: 5000 }),
    shot('leafRustle', { rate: [0.8, 0.95], byIntensity: false, level: 0.9 }),
    delayed(shot('soilScatter', { rate: [0.9, 1.05], byIntensity: false }), 0.03, 0.09),
    delayed(shot('shatterDebris', { rate: [0.7, 0.85], byIntensity: false, level: 0.6, lp: 4200 }), 0.02, 0.06),
    (A) => subDrop(A.ac, A.t, A.dest, { from: 130, to: 38, drop: 0.09, decay: 0.22, gain: 0.35 }),
    delayed(shot('leafRustle', { rate: [1.0, 1.2], byIntensity: false, level: 0.5 }), 0.3, 0.5),
  ),

  // ---- the parent --------------------------------------------------------------------------
  'parent.step.wood': shot('stepWood', { rate: [0.88, 1.12], rateByIntensity: true }),
  'parent.step.rug': shot('stepRug', { rate: [0.88, 1.12], rateByIntensity: true }),
  'parent.bark': shot('parentBark', { rate: [0.95, 1.07], byIntensity: false }),
  'parent.sigh': shot('parentSigh', { rate: [0.94, 1.08], byIntensity: false, level: 0.8 }),
  'parent.sofaCreak': shot('sofaCreak', { rate: [0.9, 1.12], byIntensity: false }),
  'parent.cloth': shot('clothRustle', { rate: [0.9, 1.12], byIntensity: false }),
  'parent.lift': layer(
    shot('liftWhoosh', { rate: [0.92, 1.08], byIntensity: false }),
    shot('clothRustle', { rate: [0.85, 1.0], byIntensity: false, level: 0.8 }),
  ),

  // ---- interface ---------------------------------------------------------------------------
  'ui.tick': shot('uiTick', { rate: [0.96, 1.06], byIntensity: false, level: 0.55 }),
  'ui.back': shot('uiBack', { byIntensity: false, level: 0.55 }),
  'ui.toast': (A) => fmBell(A.ac, A.t, A.dest, { freq: 880, ratio: 2.01, index: 2.2, decay: 0.45, gain: 0.16 }),
  'ui.confirm': (A) =>
    Math.max(
      fmBell(A.ac, A.t, A.dest, { freq: 660, ratio: 2.0, index: 2.4, decay: 0.5, gain: 0.17 }),
      fmBell(A.ac, A.t + 0.075, A.dest, { freq: 990, ratio: 2.0, index: 2.0, decay: 0.6, gain: 0.15 }) + 0.075,
    ),
  /** Score ping — pitch climbs with the combo so a run of destruction becomes an arpeggio. */
  'ui.score': (A, o) => {
    const step = Math.min(11, Math.max(0, (o.combo || 0) - 1));
    const scale = [0, 2, 3, 5, 7, 9, 10, 12, 14, 15, 17, 19];
    const freq = 784 * Math.pow(2, scale[step] / 12);
    return fmBell(A.ac, A.t, A.dest, {
      freq,
      ratio: 3.03,
      index: 3.2,
      decay: 0.62,
      gain: 0.15,
    });
  },
  'ui.combo': (A, o) => {
    const n = Math.min(4, 2 + Math.floor((o.combo || 2) / 3));
    const scale = [0, 4, 7, 12, 16];
    let d = 0;
    for (let i = 0; i < n; i++) {
      const t = A.t + i * 0.065;
      d = Math.max(
        d,
        i * 0.065 + fmBell(A.ac, t, A.dest, { freq: 587.33 * Math.pow(2, scale[i] / 12), ratio: 3.5, index: 4, decay: 0.55, gain: 0.13 }),
      );
    }
    return d;
  },
};

/** Physics contact category → the sound that should come out. */
export const MATERIAL_SOUND = {
  glass: 'impact.glass.ring',
  ceramic: 'impact.ceramic.clink',
  stone: 'impact.stone',
  marble: 'impact.stone',
  concrete: 'impact.stone',
  plaster: 'impact.thud',
  metal: 'impact.metal.ting',
  vinyl: 'impact.vinyl',
  wicker: 'impact.wicker',
  wood: 'impact.wood.knock',
  plastic: 'impact.plastic.clatter',
  canvas: 'impact.paper.rustle',
  paper: 'impact.book.wood',
  card: 'impact.book.rug',
  foil: 'impact.foil.crinkle',
  rubber: 'impact.rubber',
  leaf: 'impact.leaf',
  soil: 'impact.soil',
  rug: 'impact.thud',
  fabric: 'impact.cloth',
  plush: 'impact.plush.flump',
  flesh: 'impact.flesh',
  none: 'impact.thud',
  generic: 'impact.thud',
};

/** Karplus–Strong pluck buffers for the score, cached by pitch. */
export function makePluckBuffer(ac, freq, r, seconds = 0.9) {
  const buf = makeBuffer(ac, seconds);
  const d = buf.getChannelData(0);
  karplusInto(d, ac.sampleRate, freq, r, 0.9955, 0.55, 1);
  hp1(d, ac.sampleRate, 90, 1);
  finish(d, ac.sampleRate, 0.8);
  return buf;
}
