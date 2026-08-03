// AUDIO · the synthesis toolkit. Pure maths on Float32Array — no Web Audio nodes here except
// the trivial buffer factory, so every generator is testable, deterministic and cheap.
//
// The whole sound design of this game is source–filter: an *exciter* (a click, a noise burst, a
// glottal pulse train) driving a *resonator* (a bank of decaying modes, a formant filter, a
// delay line). Two tricks make it fast enough to render at runtime:
//   1. A decaying sinusoid is never computed with Math.sin. It is the impulse response of the
//      2-pole recurrence y[n] = 2·r·cos(w)·y[n-1] − r²·y[n-2], where r = exp(-1/(τ·sr)). Two
//      multiplies per sample per mode, so a 9-mode ceramic bank costs ~18 flops/sample.
//   2. Every buffer is rendered once into a small pool of variants and then re-triggered with a
//      jittered playbackRate / filter / gain, so "no two impacts are identical" costs nothing
//      after the first few frames.
// Biquads are RBJ cookbook, direct form I. The formant filter updates its coefficients every
// 64 samples so vowels can glide (that is what turns a buzz into "ba-ba-da").

/** An AudioBuffer of `seconds` length, silent, at the context rate. */
export function makeBuffer(ac, seconds, channels = 1) {
  const n = Math.max(1, Math.round(seconds * ac.sampleRate));
  return ac.createBuffer(channels, n, ac.sampleRate);
}

// ---------------------------------------------------------------------------------------------
// noise
// ---------------------------------------------------------------------------------------------

export function whiteInto(data, r, gain = 1, from = 0, to = data.length) {
  for (let i = from; i < to; i++) data[i] += (r() * 2 - 1) * gain;
}

/** Voss-ish pink: three staggered one-pole poles summed. Cheap and close enough to -3 dB/oct. */
export function pinkInto(data, r, gain = 1) {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < data.length; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.0990460;
    b1 = 0.96300 * b1 + w * 0.2965164;
    b2 = 0.57000 * b2 + w * 1.0526913;
    data[i] += (b0 + b1 + b2 + w * 0.1848) * 0.22 * gain;
  }
}

/** Brown / red noise — integrated white with a leak so it cannot wander off to DC. */
export function brownInto(data, r, gain = 1) {
  let y = 0;
  for (let i = 0; i < data.length; i++) {
    y = (y + (r() * 2 - 1) * 0.035) * 0.996;
    data[i] += y * 12 * gain;
  }
}

// ---------------------------------------------------------------------------------------------
// filters (in place, single sample-accurate pass)
// ---------------------------------------------------------------------------------------------

export function lp1(data, sr, freq, passes = 1) {
  const a = Math.exp((-2 * Math.PI * freq) / sr);
  const b = 1 - a;
  for (let p = 0; p < passes; p++) {
    let y = 0;
    for (let i = 0; i < data.length; i++) {
      y = data[i] * b + y * a;
      data[i] = y;
    }
  }
}

export function hp1(data, sr, freq, passes = 1) {
  const a = Math.exp((-2 * Math.PI * freq) / sr);
  for (let p = 0; p < passes; p++) {
    let y = 0;
    let prev = 0;
    for (let i = 0; i < data.length; i++) {
      const x = data[i];
      y = a * (y + x - prev);
      prev = x;
      data[i] = y;
    }
  }
}

/** RBJ bandpass (constant 0 dB peak), in place. */
export function bp2(data, sr, freq, Q = 2, wet = 1) {
  const f = Math.min(Math.max(freq, 20), sr * 0.45);
  const w0 = (2 * Math.PI * f) / sr;
  const alpha = Math.sin(w0) / (2 * Math.max(0.3, Q));
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b2 = -alpha / a0;
  const a1 = (-2 * Math.cos(w0)) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  const dry = 1 - wet;
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    data[i] = y * wet + x * dry;
  }
}

/** RBJ peaking EQ, in place — used to give noise a "body" resonance without killing the rest. */
export function peakEq(data, sr, freq, Q, gainDb) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * Math.min(freq, sr * 0.45)) / sr;
  const alpha = Math.sin(w0) / (2 * Math.max(0.3, Q));
  const a0 = 1 + alpha / A;
  const b0 = (1 + alpha * A) / a0;
  const b1 = (-2 * Math.cos(w0)) / a0;
  const b2 = (1 - alpha * A) / a0;
  const a1 = b1;
  const a2 = (1 - alpha / A) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    data[i] = y;
  }
}

// ---------------------------------------------------------------------------------------------
// shaping
// ---------------------------------------------------------------------------------------------

export function dcBlock(data) {
  let mean = 0;
  for (let i = 0; i < data.length; i++) mean += data[i];
  mean /= data.length || 1;
  for (let i = 0; i < data.length; i++) data[i] -= mean;
}

export function peakNormalize(data, target = 0.92) {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const a = data[i] < 0 ? -data[i] : data[i];
    if (a > peak) peak = a;
  }
  if (peak < 1e-6) return;
  const g = target / peak;
  for (let i = 0; i < data.length; i++) data[i] *= g;
}

/** Exponential decay from 1 → 0 with time constant tau, multiplied in. */
export function decayInto(data, sr, tau, from = 0) {
  const k = Math.exp(-1 / (tau * sr));
  let e = 1;
  for (let i = from; i < data.length; i++) {
    data[i] *= e;
    e *= k;
  }
}

/** Short raised-cosine attack so a buffer never starts on a click. */
export function attackInto(data, sr, seconds) {
  const n = Math.min(data.length, Math.max(1, Math.round(seconds * sr)));
  for (let i = 0; i < n; i++) data[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
}

/** Raised-cosine release on the tail so looping/stopping never clicks. */
export function releaseInto(data, sr, seconds) {
  const n = Math.min(data.length, Math.max(1, Math.round(seconds * sr)));
  const s = data.length - n;
  for (let i = 0; i < n; i++) data[s + i] *= 0.5 + 0.5 * Math.cos((Math.PI * i) / n);
}

/** Soft saturation — keeps transients dense without letting them clip the limiter. */
export function saturate(data, drive = 1.4) {
  for (let i = 0; i < data.length; i++) data[i] = Math.tanh(data[i] * drive) / Math.tanh(drive);
}

// ---------------------------------------------------------------------------------------------
// resonators
// ---------------------------------------------------------------------------------------------

/**
 * Modal bank. `modes` is [{ f, a, tau }]. The exciter is a short impulse+noise burst of
 * `exciteMs` — a hard click gives a bright ceramic "tink", a longer noisy one gives wood.
 */
export function modalInto(data, sr, modes, r, exciteMs = 0.6, exciteNoise = 0.35) {
  const n = data.length;
  const excN = Math.max(1, Math.round((exciteMs / 1000) * sr));
  const exc = new Float32Array(excN);
  exc[0] = 1;
  for (let i = 0; i < excN; i++) {
    const w = 1 - i / excN;
    exc[i] += (r() * 2 - 1) * exciteNoise * w;
  }
  for (let m = 0; m < modes.length; m++) {
    const mode = modes[m];
    const f = Math.min(Math.max(mode.f, 12), sr * 0.47);
    const tau = Math.max(0.002, mode.tau);
    const rr = Math.exp(-1 / (tau * sr));
    const w = (2 * Math.PI * f) / sr;
    const c1 = 2 * rr * Math.cos(w);
    const c2 = -rr * rr;
    const drive = (mode.a === undefined ? 1 : mode.a) * Math.sin(w);
    let y1 = 0;
    let y2 = 0;
    const lim = Math.min(n, excN);
    for (let i = 0; i < lim; i++) {
      const y = c1 * y1 + c2 * y2 + exc[i] * drive;
      y2 = y1;
      y1 = y;
      data[i] += y;
    }
    for (let i = excN; i < n; i++) {
      const y = c1 * y1 + c2 * y2;
      y2 = y1;
      y1 = y;
      data[i] += y;
    }
  }
}

/**
 * Karplus–Strong plucked string. The delay line is seeded with lowpassed noise (the "pick"),
 * then averaged with its neighbour each pass, which is a one-zero lowpass — high partials die
 * first, exactly like a real string. `damping` < 1 shortens the whole decay.
 */
export function karplusInto(data, sr, freq, r, damping = 0.996, brightness = 0.5, level = 1) {
  const N = Math.max(2, Math.round(sr / Math.max(20, freq)));
  const line = new Float32Array(N);
  let y = 0;
  const b = Math.min(0.99, Math.max(0.02, brightness));
  for (let i = 0; i < N; i++) {
    y = (r() * 2 - 1) * b + y * (1 - b);
    line[i] = y;
  }
  let mean = 0;
  for (let i = 0; i < N; i++) mean += line[i];
  mean /= N;
  for (let i = 0; i < N; i++) line[i] -= mean;
  // Pick position comb: cancels the partial whose node sits under the pick.
  const pick = Math.max(1, Math.round(N * 0.22));
  for (let i = N - 1; i >= pick; i--) line[i] -= line[i - pick] * 0.55;

  let idx = 0;
  const d = Math.min(0.9999, damping);
  for (let i = 0; i < data.length; i++) {
    const cur = line[idx];
    const nxt = line[(idx + 1) % N];
    line[idx] = d * 0.5 * (cur + nxt);
    data[i] += cur * level;
    idx = idx + 1 === N ? 0 : idx + 1;
  }
}

// ---------------------------------------------------------------------------------------------
// granular
// ---------------------------------------------------------------------------------------------

/**
 * A cloud of tiny grains — the debris scatter after a plate breaks, soil hitting the floor,
 * rattan creaking. Arrival times are front-loaded with a power curve (pow(u, skew)) because
 * real debris is dense immediately after the break and then thins out.
 */
export function grainsInto(data, sr, r, opts) {
  const {
    count = 80,
    tStart = 0.02,
    tEnd = 0.9,
    decay = 0.3,
    fMin = 1800,
    fMax = 7000,
    lenMin = 0.0015,
    lenMax = 0.006,
    gain = 0.5,
    noisiness = 0.45,
    skew = 1.8,
    bounce = 0,
  } = opts;
  const n = data.length;
  for (let g = 0; g < count; g++) {
    const u = Math.pow(r(), skew);
    const t = tStart + (tEnd - tStart) * u;
    const start = Math.round(t * sr);
    if (start >= n) continue;
    const len = Math.max(4, Math.round((lenMin + (lenMax - lenMin) * r()) * sr));
    const f = fMin + (fMax - fMin) * r() * r();
    const w = (2 * Math.PI * f) / sr;
    const amp = gain * Math.exp(-(t - tStart) / decay) * (0.35 + 0.65 * r());
    let ph = r() * 6.283;
    const end = Math.min(n, start + len);
    for (let i = start; i < end; i++) {
      const k = (i - start) / len;
      const env = Math.sin(Math.PI * k);
      const tone = Math.sin(ph);
      ph += w;
      data[i] += amp * env * env * (tone * (1 - noisiness) + (r() * 2 - 1) * noisiness);
    }
    // Some grains bounce once: a quieter echo of themselves a few ms later.
    if (bounce > 0 && r() < bounce) {
      const s2 = start + Math.round((0.012 + r() * 0.05) * sr);
      const e2 = Math.min(n, s2 + len);
      let ph2 = 0;
      for (let i = s2; i < e2; i++) {
        const k = (i - s2) / len;
        const env = Math.sin(Math.PI * k);
        data[i] += amp * 0.45 * env * env * (Math.sin(ph2) * 0.6 + (r() * 2 - 1) * 0.4);
        ph2 += w * 1.02;
      }
    }
  }
}

/**
 * Foil crinkle. A dense field of micro-crackles plus a noise floor gated by a jagged random
 * walk. The walk holds for 1–4 ms at a time — that stepped, non-smooth envelope is the entire
 * reason foil sounds like foil and not like a hiss.
 */
export function crinkleInto(data, sr, r, opts = {}) {
  const { gain = 1, density = 900, shape = 1 } = opts;
  const n = data.length;
  let hold = 0;
  let level = 0.2;
  for (let i = 0; i < n; i++) {
    if (hold-- <= 0) {
      hold = Math.round((0.001 + r() * 0.004) * sr);
      const u = r();
      level = u * u * u * 1.6 + 0.02;
    }
    const env = Math.pow(1 - i / n, shape);
    data[i] += (r() * 2 - 1) * level * env * gain * 0.55;
  }
  grainsInto(data, sr, r, {
    count: Math.round((density * n) / sr),
    tStart: 0,
    tEnd: n / sr,
    decay: (n / sr) * 0.75,
    fMin: 2200,
    fMax: 9500,
    lenMin: 0.0004,
    lenMax: 0.0022,
    gain: 0.5 * gain,
    noisiness: 0.65,
    skew: 1,
  });
}

/**
 * Stick–slip creak (a cord under load, a sofa frame, a wicker chair). A pulse train whose period
 * wanders violently is the physical model of a surface repeatedly catching and releasing; ring
 * it through a couple of resonances and it is instantly recognisable as "old wood complaining".
 */
export function creakInto(data, sr, r, opts = {}) {
  const { rate = 120, wander = 0.55, res = 900, res2 = 2200, gain = 1, roughness = 0.5 } = opts;
  const n = data.length;
  const pulses = new Float32Array(n);
  let i = 0;
  let phase = 0;
  while (i < n) {
    const u = i / n;
    const f = rate * (1 + Math.sin(u * 9.4 + phase) * 0.25) * (1 + (r() * 2 - 1) * wander);
    const period = Math.max(6, Math.round(sr / Math.max(18, f)));
    pulses[i] = 1 - r() * roughness;
    i += period;
    phase += 0.07;
  }
  const tmp = new Float32Array(n);
  tmp.set(pulses);
  bp2(tmp, sr, res, 9);
  bp2(pulses, sr, res2, 6);
  for (let k = 0; k < n; k++) data[k] += (tmp[k] * 0.8 + pulses[k] * 0.35) * gain;
}

// ---------------------------------------------------------------------------------------------
// voice: glottal source + moving formants
// ---------------------------------------------------------------------------------------------

/**
 * Rosenberg glottal flow, differentiated. `f0(u)` is the pitch contour over normalised time,
 * `jitter` the cycle-to-cycle period wobble (a baby's is huge — 3–6 %, an adult's ~1 %) and
 * `shimmer` the amplitude wobble. The differentiation is what supplies the bright buzzy edge:
 * the closing phase of the glottis is a near-discontinuity, and its derivative is the spike that
 * excites the formants.
 */
export function glottalInto(data, sr, r, opts) {
  const {
    f0,
    jitter = 0.03,
    shimmer = 0.09,
    open = 0.44,
    close = 0.16,
    breath = 0.05,
    amp = (/* u */) => 1,
  } = opts;
  const n = data.length;
  let i = 0;
  let prev = 0;
  while (i < n) {
    const u = i / n;
    const f = Math.max(45, Math.min(1600, f0(u)));
    const T = Math.max(6, Math.round((sr / f) * (1 + (r() * 2 - 1) * jitter)));
    const a = (1 + (r() * 2 - 1) * shimmer) * amp(u);
    const Tp = Math.max(2, Math.round(T * open));
    const Tn = Math.max(1, Math.round(T * close));
    for (let k = 0; k < T && i < n; k++, i++) {
      let g;
      if (k < Tp) {
        const p = k / Tp;
        g = 3 * p * p - 2 * p * p * p;
      } else if (k < Tp + Tn) {
        const p = (k - Tp) / Tn;
        g = 1 - p * p;
      } else {
        g = 0;
      }
      g *= a;
      data[i] += (g - prev) * 10 + (r() * 2 - 1) * breath * a;
      prev = g;
    }
  }
}

/**
 * Parallel formant bank with per-block coefficient updates, so F1/F2/F3 can glide across the
 * utterance and produce real diphthongs. `tracks` is [{ f(u), bw(u)|number, a(u)|number }].
 */
export function formantInto(dst, src, sr, tracks, block = 64) {
  const n = src.length;
  for (let t = 0; t < tracks.length; t++) {
    const tr = tracks[t];
    const fFn = typeof tr.f === 'function' ? tr.f : () => tr.f;
    const bwFn = typeof tr.bw === 'function' ? tr.bw : () => tr.bw || 90;
    const aFn = typeof tr.a === 'function' ? tr.a : () => (tr.a === undefined ? 1 : tr.a);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i0 = 0; i0 < n; i0 += block) {
      const u = i0 / n;
      const f = Math.min(Math.max(fFn(u), 90), sr * 0.45);
      const bw = Math.max(25, bwFn(u));
      const Q = Math.max(0.6, f / bw);
      const w0 = (2 * Math.PI * f) / sr;
      const alpha = Math.sin(w0) / (2 * Q);
      const a0 = 1 + alpha;
      const b0 = alpha / a0;
      const b2 = -alpha / a0;
      const a1 = (-2 * Math.cos(w0)) / a0;
      const a2 = (1 - alpha) / a0;
      const g = aFn(u);
      const end = Math.min(n, i0 + block);
      for (let i = i0; i < end; i++) {
        const x = src[i];
        const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        dst[i] += y * g;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// node-graph helpers
// ---------------------------------------------------------------------------------------------

export function gainNode(ac, v = 1) {
  const g = ac.createGain();
  g.gain.value = v;
  return g;
}

export function filterNode(ac, type, freq, Q = 1, gainDb = 0) {
  const f = ac.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = Q;
  if (gainDb) f.gain.value = gainDb;
  return f;
}

export function bufferSource(ac, buffer, rate = 1, loop = false) {
  const s = ac.createBufferSource();
  s.buffer = buffer;
  s.playbackRate.value = rate;
  s.loop = loop;
  return s;
}

/** Attack then exponential-ish decay to silence. Returns the time the voice can be freed. */
export function pluck(param, t0, peak, attack, tau) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(0.0001, t0);
  param.linearRampToValueAtTime(peak, t0 + Math.max(0.0005, attack));
  param.setTargetAtTime(0.0001, t0 + attack, Math.max(0.005, tau));
  return t0 + attack + tau * 5;
}

/** Linear ADSR-ish gate for sustained sounds. */
export function gate(param, t0, peak, attack, hold, release) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(0.0001, t0);
  param.linearRampToValueAtTime(peak, t0 + attack);
  param.setValueAtTime(peak, t0 + attack + hold);
  param.linearRampToValueAtTime(0.0001, t0 + attack + hold + release);
  return t0 + attack + hold + release;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};
