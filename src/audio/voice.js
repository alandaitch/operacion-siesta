// AUDIO · the voices. A 10-month-old and an adult, both built from the same source–filter model.
//
// A baby is not a small adult: its vocal tract is about 8 cm long against an adult's 17, so every
// formant sits roughly twice as high, the bandwidths are wider (a floppy, wet tract damps more),
// and the pitch is 350–550 Hz with 4–7 % cycle-to-cycle jitter — that instability is precisely
// what makes an infant read as an infant and not as a synth lead. Squeals push f0 above 900 Hz
// and go slightly chaotic; grunts drop to 220 Hz with enough jitter to sound creaky.
//
// Every utterance is a set of breakpoint tracks: pitch (interpolated in log space, because pitch
// is perceived logarithmically), three formants (interpolated with smoothstep, because articulators
// accelerate and decelerate), and amplitude. Consonant onsets are short filtered noise bursts
// stamped over the top — a plosive release is literally a pressure burst, so that is what we make.
//
// The parent's barks use the same engine with adult formants, deliberately vowel-only nonsense:
// intelligible words would need to be localised, and an abstract exasperated "¿¡EH!?" is funnier
// in every language.

import {
  glottalInto,
  formantInto,
  bp2,
  hp1,
  lp1,
  dcBlock,
  peakNormalize,
  attackInto,
  releaseInto,
  whiteInto,
} from './dsp.js';

/** Piecewise track with smoothstep easing between breakpoints. */
function track(points, log = false) {
  const pts = points.slice().sort((a, b) => a.t - b.t);
  return (u) => {
    if (u <= pts[0].t) return pts[0].v;
    const last = pts[pts.length - 1];
    if (u >= last.t) return last.v;
    for (let i = 1; i < pts.length; i++) {
      if (u <= pts[i].t) {
        const a = pts[i - 1];
        const b = pts[i];
        const k = (u - a.t) / (b.t - a.t || 1e-6);
        const s = k * k * (3 - 2 * k);
        if (log) return a.v * Math.pow(b.v / a.v, s);
        return a.v + (b.v - a.v) * s;
      }
    }
    return last.v;
  };
}

/** Baby vowel targets (F1, F2, F3) — a 10-month-old's tract, measured up an octave from adult. */
export const BABY_VOWELS = {
  a: [1120, 1950, 3900],
  ah: [1010, 1600, 3750],
  e: [880, 2600, 4050],
  i: [520, 3350, 4450],
  o: [700, 1200, 3600],
  u: [560, 1250, 3550],
  schwa: [900, 2050, 3820],
};

export const ADULT_VOWELS = {
  a: [730, 1090, 2440],
  e: [530, 1840, 2480],
  i: [300, 2250, 2980],
  o: [570, 850, 2410],
  u: [320, 880, 2260],
  schwa: [520, 1250, 2500],
};

/**
 * Render an utterance into `data`.
 * spec = { f0:[{t,v}], vowels:[{t,v:'a'|[f1,f2,f3]}], amp:[{t,v}], bursts:[{t,f,q,g,len}],
 *          jitter, shimmer, breath, bw, tilt, nasal, adult }
 */
export function utteranceInto(data, sr, r, spec) {
  const n = data.length;
  const vowelSet = spec.adult ? ADULT_VOWELS : BABY_VOWELS;
  const resolve = (v) => (Array.isArray(v) ? v : vowelSet[v] || vowelSet.schwa);
  const vs = spec.vowels.map((p) => ({ t: p.t, v: resolve(p.v) }));
  const f1 = track(vs.map((p) => ({ t: p.t, v: p.v[0] })));
  const f2 = track(vs.map((p) => ({ t: p.t, v: p.v[1] })));
  const f3 = track(vs.map((p) => ({ t: p.t, v: p.v[2] })));
  const pitch = track(spec.f0, true);
  const amp = track(spec.amp || [{ t: 0, v: 1 }]);
  const bw = spec.bw || (spec.adult ? [75, 110, 180] : [135, 210, 290]);

  const src = new Float32Array(n);
  glottalInto(src, sr, r, {
    f0: pitch,
    jitter: spec.jitter === undefined ? (spec.adult ? 0.012 : 0.045) : spec.jitter,
    shimmer: spec.shimmer === undefined ? (spec.adult ? 0.05 : 0.12) : spec.shimmer,
    breath: spec.breath === undefined ? (spec.adult ? 0.03 : 0.07) : spec.breath,
    open: spec.open || 0.44,
    close: spec.close || 0.16,
    amp,
  });

  const tracks = [
    { f: f1, bw: bw[0], a: 1 },
    { f: f2, bw: bw[1], a: spec.adult ? 0.42 : 0.55 },
    { f: f3, bw: bw[2], a: spec.adult ? 0.2 : 0.3 },
  ];
  if (spec.nasal) tracks.push({ f: () => (spec.adult ? 260 : 420), bw: 120, a: 0.35 });
  formantInto(data, src, sr, tracks, 64);

  // A touch of the raw source keeps the low end from disappearing behind the bandpasses.
  for (let i = 0; i < n; i++) data[i] += src[i] * 0.1;

  // Consonant releases: short filtered noise bursts stamped over the voiced stream.
  if (spec.bursts) {
    for (let k = 0; k < spec.bursts.length; k++) {
      const b = spec.bursts[k];
      const len = Math.max(8, Math.round((b.len || 0.008) * sr));
      const at = Math.round(b.t * n);
      if (at + len >= n) continue;
      const tmp = new Float32Array(len);
      whiteInto(tmp, r, 1);
      bp2(tmp, sr, b.f || 1800, b.q || 2.2);
      for (let i = 0; i < len; i++) {
        const e = Math.pow(1 - i / len, 1.6);
        data[at + i] += tmp[i] * e * (b.g === undefined ? 0.35 : b.g);
      }
    }
  }

  if (spec.tilt) lp1(data, sr, spec.tilt, 1);
  hp1(data, sr, spec.adult ? 90 : 180, 1);
  dcBlock(data);
  attackInto(data, sr, 0.004);
  releaseInto(data, sr, 0.02);
  peakNormalize(data, 0.9);
}

// ---------------------------------------------------------------------------------------------
// the baby
// ---------------------------------------------------------------------------------------------

/** Delighted squeal — a rising glide into a wobbling top note. Pure joy, slightly unhinged. */
export function babySqueal(data, sr, r) {
  const base = 430 + r() * 130;
  const top = base * (2.0 + r() * 0.6);
  const wob = 5 + r() * 4;
  utteranceInto(data, sr, r, {
    f0: [
      { t: 0, v: base },
      { t: 0.22, v: top * 0.92 },
      { t: 0.55, v: top },
      { t: 0.8, v: top * 0.95 },
      { t: 1, v: top * 0.7 },
    ],
    vowels: [
      { t: 0, v: 'a' },
      { t: 0.35, v: 'i' },
      { t: 1, v: 'e' },
    ],
    amp: [
      { t: 0, v: 0.2 },
      { t: 0.12, v: 1 },
      { t: 0.75, v: 0.95 },
      { t: 1, v: 0 },
    ],
    jitter: 0.05,
    shimmer: 0.16,
    breath: 0.09,
  });
  // A fast vibrato on top, applied as amplitude tremolo — cheaper than re-rendering the pitch.
  const n = data.length;
  for (let i = 0; i < n; i++) data[i] *= 1 - 0.18 * (0.5 - 0.5 * Math.cos((i / sr) * wob * 6.283));
  peakNormalize(data, 0.9);
}

/** Giggle — a train of 4–7 voiced puffs at ~7 Hz on a descending contour. */
export function babyGiggle(data, sr, r) {
  const n = data.length;
  const count = 4 + Math.floor(r() * 4);
  const base = 400 + r() * 120;
  const rate = 6.2 + r() * 2.4;
  const puff = Math.round(sr / rate);
  const tmp = new Float32Array(puff);
  for (let k = 0; k < count; k++) {
    const at = Math.round(k * puff * (0.94 + r() * 0.12));
    if (at + puff >= n) break;
    tmp.fill(0);
    const f = base * Math.pow(0.93, k) * (1 + (r() - 0.5) * 0.08);
    utteranceInto(tmp, sr, r, {
      f0: [
        { t: 0, v: f * 1.15 },
        { t: 0.4, v: f },
        { t: 1, v: f * 0.86 },
      ],
      vowels: [
        { t: 0, v: 'a' },
        { t: 1, v: 'schwa' },
      ],
      amp: [
        { t: 0, v: 0.1 },
        { t: 0.18, v: 1 },
        { t: 0.55, v: 0.45 },
        { t: 1, v: 0 },
      ],
      bursts: [{ t: 0.02, f: 1400, q: 1.4, g: 0.4, len: 0.006 }],
      jitter: 0.055,
      shimmer: 0.18,
      breath: 0.13,
    });
    const g = 0.55 + 0.45 * Math.pow(0.87, k);
    for (let i = 0; i < puff && at + i < n; i++) data[at + i] += tmp[i] * g;
  }
  peakNormalize(data, 0.88);
}

/** Frustrated grunt — low, creaky, short, with the glottis half closed. */
export function babyGrunt(data, sr, r) {
  const f = 215 + r() * 70;
  utteranceInto(data, sr, r, {
    f0: [
      { t: 0, v: f * 1.25 },
      { t: 0.3, v: f },
      { t: 1, v: f * 0.72 },
    ],
    vowels: [
      { t: 0, v: 'o' },
      { t: 0.5, v: 'ah' },
      { t: 1, v: 'schwa' },
    ],
    amp: [
      { t: 0, v: 0.4 },
      { t: 0.15, v: 1 },
      { t: 0.7, v: 0.7 },
      { t: 1, v: 0 },
    ],
    jitter: 0.11,
    shimmer: 0.22,
    breath: 0.05,
    open: 0.3,
    nasal: true,
    tilt: 3200,
  });
}

/** Babble — two or three plosive-onset syllables. The idle noise of a very small saboteur. */
export function babyBabble(data, sr, r) {
  const syll = 2 + Math.floor(r() * 2);
  const base = 380 + r() * 140;
  const vs = ['a', 'ah', 'e', 'u', 'o'];
  const f0 = [{ t: 0, v: base }];
  const vowels = [];
  const bursts = [];
  const amp = [{ t: 0, v: 0 }];
  for (let k = 0; k < syll; k++) {
    const t0 = k / syll;
    const t1 = (k + 0.55) / syll;
    const t2 = (k + 0.92) / syll;
    f0.push({ t: t1, v: base * (1 + (r() - 0.4) * 0.35) });
    vowels.push({ t: t0 + 0.02 / syll, v: 'schwa' });
    vowels.push({ t: t1, v: vs[Math.floor(r() * vs.length)] });
    bursts.push({
      t: t0 + 0.01,
      f: 900 + r() * 1800,
      q: 1.6 + r() * 1.5,
      g: 0.4,
      len: 0.007 + r() * 0.006,
    });
    amp.push({ t: t0 + 0.02 / syll, v: 0.15 });
    amp.push({ t: t1, v: 1 });
    amp.push({ t: t2, v: 0.25 });
  }
  f0.push({ t: 1, v: base * 0.78 });
  vowels.push({ t: 1, v: 'schwa' });
  amp.push({ t: 1, v: 0 });
  utteranceInto(data, sr, r, { f0, vowels, amp, bursts, jitter: 0.05, shimmer: 0.14 });
}

/** Hiccup — a sharp glottal squeak on an inhale, then the vocal folds slam shut. */
export function babyHiccup(data, sr, r) {
  const n = data.length;
  const f = 470 + r() * 160;
  // 1. the inhale: rising bandpassed noise
  const inh = Math.round(0.055 * sr);
  const tmp = new Float32Array(inh);
  whiteInto(tmp, r, 1);
  for (let i = 0; i < inh; i++) tmp[i] *= Math.sin((Math.PI * i) / inh);
  bp2(tmp, sr, 1400, 1.6);
  for (let i = 0; i < inh && i < n; i++) data[i] += tmp[i] * 0.5;
  // 2. the squeak
  const at = Math.round(0.05 * sr);
  const len = Math.min(n - at, Math.round(0.13 * sr));
  if (len > 32) {
    const voi = new Float32Array(len);
    utteranceInto(voi, sr, r, {
      f0: [
        { t: 0, v: f * 1.6 },
        { t: 0.25, v: f },
        { t: 1, v: f * 0.6 },
      ],
      vowels: [
        { t: 0, v: 'i' },
        { t: 0.4, v: 'a' },
        { t: 1, v: 'o' },
      ],
      amp: [
        { t: 0, v: 1 },
        { t: 0.5, v: 0.6 },
        { t: 1, v: 0 },
      ],
      jitter: 0.07,
      shimmer: 0.2,
    });
    for (let i = 0; i < len; i++) data[at + i] += voi[i] * 0.95;
  }
  peakNormalize(data, 0.85);
}

/** Raspberry — lips buzzing at 45–75 Hz, very wet, almost no upper formants. */
export function babyRaspberry(data, sr, r) {
  const n = data.length;
  const rate = 46 + r() * 30;
  const period = sr / rate;
  let next = 0;
  const pulses = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (i >= next) {
      pulses[i] = 1 - r() * 0.5;
      next = i + period * (0.72 + r() * 0.56);
    }
    pulses[i] += (r() * 2 - 1) * 0.32;
  }
  const a = new Float32Array(n);
  a.set(pulses);
  bp2(a, sr, 380 + r() * 120, 3.5);
  bp2(pulses, sr, 1150 + r() * 400, 2.2);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / (0.02 * sr)) * Math.pow(1 - i / n, 0.9);
    data[i] += (a[i] * 1.0 + pulses[i] * 0.45) * env;
  }
  lp1(data, sr, 2400, 1);
  dcBlock(data);
  peakNormalize(data, 0.85);
}

/** Chewing — wet tongue clicks with a soft jaw thump under each one. */
export function babyChew(data, sr, r) {
  const n = data.length;
  const bites = 3 + Math.floor(r() * 3);
  for (let k = 0; k < bites; k++) {
    const t = (k + r() * 0.4) / bites;
    const at = Math.round(t * n * 0.85);
    const len = Math.round((0.03 + r() * 0.03) * sr);
    if (at + len >= n) continue;
    const tmp = new Float32Array(len);
    whiteInto(tmp, r, 1);
    bp2(tmp, sr, 900 + r() * 2200, 1.5 + r() * 2);
    for (let i = 0; i < len; i++) {
      const e = Math.pow(1 - i / len, 2.4);
      data[at + i] += tmp[i] * e * 0.7;
    }
    // jaw thump
    const w = (2 * Math.PI * (110 + r() * 60)) / sr;
    const tau = 0.035;
    const kd = Math.exp(-1 / (tau * sr));
    let e2 = 1;
    for (let i = 0; i < len * 3 && at + i < n; i++) {
      data[at + i] += Math.sin(w * i) * e2 * 0.25;
      e2 *= kd;
    }
  }
  peakNormalize(data, 0.8);
}

/** Slurp — a rising resonance as the mouth closes around it, then a wet pop. */
export function babySlurp(data, sr, r) {
  const n = data.length;
  const noise = new Float32Array(n);
  whiteInto(noise, r, 1);
  const out = new Float32Array(n);
  formantInto(out, noise, sr, [
    { f: (u) => 380 + 1500 * u * u, bw: 140, a: 1 },
    { f: (u) => 1500 + 2200 * u, bw: 260, a: 0.5 },
  ]);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const env = Math.min(1, u * 7) * (u < 0.8 ? 1 : Math.pow(1 - (u - 0.8) / 0.2, 1.5));
    data[i] += out[i] * env * 0.6;
  }
  const at = Math.round(n * 0.78);
  const len = Math.round(0.02 * sr);
  for (let i = 0; i < len && at + i < n; i++) {
    const e = Math.pow(1 - i / len, 2);
    data[at + i] += (r() * 2 - 1) * e * 0.9;
  }
  bp2(data, sr, 1600, 0.9, 0.7);
  peakNormalize(data, 0.85);
}

/** Breathing — one full in/out cycle of a small sleeping-ish animal. */
export function babyBreath(data, sr, r) {
  const n = data.length;
  const noise = new Float32Array(n);
  whiteInto(noise, r, 1);
  const out = new Float32Array(n);
  formantInto(out, noise, sr, [
    { f: (u) => (u < 0.5 ? 700 + 500 * (u * 2) : 900 - 350 * ((u - 0.5) * 2)), bw: 400, a: 1 },
    { f: (u) => 2400 + 600 * Math.sin(u * 3.14), bw: 900, a: 0.35 },
  ]);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const inhale = Math.sin(Math.PI * Math.min(1, u * 2.2));
    const exhale = u > 0.5 ? Math.sin(Math.PI * ((u - 0.5) / 0.5)) * 0.75 : 0;
    data[i] += out[i] * (inhale * 0.55 + exhale) * 0.5;
  }
  peakNormalize(data, 0.6);
}

/** Startled gasp — sharp inhale, a fraction of a squeak on the end. */
export function babyGasp(data, sr, r) {
  const n = data.length;
  const noise = new Float32Array(n);
  whiteInto(noise, r, 1);
  const out = new Float32Array(n);
  formantInto(out, noise, sr, [
    { f: (u) => 800 + 2600 * u, bw: 320, a: 1 },
    { f: () => 3600, bw: 900, a: 0.4 },
  ]);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    data[i] += out[i] * Math.pow(u, 0.6) * Math.pow(1 - u, 0.5) * 1.4;
  }
  peakNormalize(data, 0.8);
}

// ---------------------------------------------------------------------------------------------
// the parent
// ---------------------------------------------------------------------------------------------

/**
 * An exasperated call from another room. Two or three syllables on a falling-then-rising contour
 * — the universal prosody of "what are you doing in there". No words: abstract on purpose.
 */
export function parentBark(data, sr, r, urgency = 0.5) {
  const male = r() < 0.5;
  const base = (male ? 108 : 186) * (1 + urgency * 0.22);
  const syll = 2 + (r() < 0.45 ? 1 : 0);
  const vs = ['a', 'e', 'o', 'schwa'];
  const f0 = [{ t: 0, v: base * 1.1 }];
  const vowels = [];
  const amp = [{ t: 0, v: 0 }];
  const bursts = [];
  for (let k = 0; k < syll; k++) {
    const t0 = k / syll;
    const tm = (k + 0.45) / syll;
    const te = (k + 0.9) / syll;
    const rise = k === syll - 1 ? 1.35 + urgency * 0.5 : 1;
    f0.push({ t: tm, v: base * (0.92 + r() * 0.3) * rise });
    f0.push({ t: te, v: base * (0.72 + r() * 0.2) * rise });
    vowels.push({ t: t0 + 0.01, v: 'schwa' });
    vowels.push({ t: tm, v: vs[Math.floor(r() * vs.length)] });
    bursts.push({ t: t0 + 0.005, f: 700 + r() * 1200, q: 1.4, g: 0.28, len: 0.01 });
    amp.push({ t: t0 + 0.01, v: 0.25 });
    amp.push({ t: tm, v: 1 });
    amp.push({ t: te, v: 0.35 });
  }
  f0.push({ t: 1, v: base * 1.1 });
  vowels.push({ t: 1, v: 'schwa' });
  amp.push({ t: 1, v: 0 });
  utteranceInto(data, sr, r, {
    adult: true,
    f0,
    vowels,
    amp,
    bursts,
    jitter: 0.014 + urgency * 0.012,
    shimmer: 0.06,
    breath: 0.035,
  });
}

/** The sigh of a person who has seen the state of the living room. */
export function parentSigh(data, sr, r) {
  const n = data.length;
  const male = r() < 0.5;
  const base = male ? 96 : 168;
  const voiced = new Float32Array(n);
  utteranceInto(voiced, sr, r, {
    adult: true,
    f0: [
      { t: 0, v: base * 1.12 },
      { t: 0.35, v: base },
      { t: 1, v: base * 0.7 },
    ],
    vowels: [
      { t: 0, v: 'a' },
      { t: 0.6, v: 'schwa' },
      { t: 1, v: 'o' },
    ],
    amp: [
      { t: 0, v: 0.25 },
      { t: 0.2, v: 0.8 },
      { t: 0.75, v: 0.4 },
      { t: 1, v: 0 },
    ],
    jitter: 0.02,
    breath: 0.22,
    open: 0.55,
  });
  const air = new Float32Array(n);
  whiteInto(air, r, 1);
  bp2(air, sr, 1050, 0.8);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    data[i] += voiced[i] * 0.55 + air[i] * Math.sin(Math.PI * Math.pow(u, 0.75)) * 0.4;
  }
  lp1(data, sr, 4200, 1);
  peakNormalize(data, 0.7);
}

/** A dog three courtyards away. Same engine, canine formants, then buried in low-pass. */
export function distantDog(data, sr, r) {
  const n = data.length;
  const barks = 2 + Math.floor(r() * 2);
  const base = 240 + r() * 160;
  for (let k = 0; k < barks; k++) {
    const at = Math.round((0.05 + k * (0.24 + r() * 0.14)) * sr);
    const len = Math.round((0.1 + r() * 0.06) * sr);
    if (at + len >= n) break;
    const tmp = new Float32Array(len);
    utteranceInto(tmp, sr, r, {
      adult: true,
      f0: [
        { t: 0, v: base * 1.5 },
        { t: 0.2, v: base },
        { t: 1, v: base * 0.62 },
      ],
      vowels: [
        { t: 0, v: [900, 1500, 2600] },
        { t: 0.3, v: [620, 1150, 2400] },
        { t: 1, v: [450, 900, 2200] },
      ],
      amp: [
        { t: 0, v: 1 },
        { t: 0.35, v: 0.7 },
        { t: 1, v: 0 },
      ],
      jitter: 0.03,
      shimmer: 0.15,
      bursts: [{ t: 0, f: 1200, q: 1.1, g: 0.5, len: 0.012 }],
    });
    for (let i = 0; i < len; i++) data[at + i] += tmp[i] * (0.9 - k * 0.15);
  }
  lp1(data, sr, 900, 2);
  peakNormalize(data, 0.55);
}
