// AUDIO · procedurally generated impulse responses.
//
// There are no .wav files in this project, so the reverb is built from first principles for this
// specific 6.8 × 8.0 × 2.78 m box. Two stages:
//
//   EARLY REFLECTIONS — exact first-order image sources. Mirror the source through each of the
//   six surfaces, measure |image − listener|, and place a tap at d/343 s with amplitude
//   (1 − α)/d. The absorption coefficients are the real materials: raw concrete slab reflects
//   almost everything (α 0.05), the wool rug and the sofa eat the floor (α 0.42), plaster walls
//   sit in between, and the glazing is hard but partly transmits. Second and third order taps are
//   generated stochastically from the same wall set because their exact geometry is inaudible.
//
//   LATE TAIL — filtered noise under an exponential envelope, rendered in three bands with
//   different RT60s. A concrete ceiling over soft furnishings decays slowly at 125 Hz and fast at
//   8 kHz, and that frequency-dependent decay is the single strongest cue that a room is made of
//   concrete rather than of drywall. RT60 targets: 0.74 s low / 0.55 s mid / 0.28 s high.
//
// The hallway IR is the same machinery with a longer pre-delay, a longer and darker tail, and a
// deliberate flutter echo — parallel walls 1.1 m apart give a 6.4 ms comb that reads instantly as
// "that noise is coming from a corridor, not from in here".

import { lp1, hp1, bp2, peakNormalize, releaseInto } from './dsp.js';

const C = 343; // m/s

const ROOM = { x0: -3.4, x1: 3.4, y0: 0, y1: 2.78, z0: -4.6, z1: 3.4 };

// α per surface at mid frequency.
const ABSORB = {
  floor: 0.42, // wool rug + wood + a sectional sofa
  ceiling: 0.05, // raw board-formed concrete
  wallL: 0.16, // plaster + a plywood shelf run full of books
  wallR: 0.14,
  wallBack: 0.13,
  window: 0.08, // glazing
};

function firstOrderTaps(src, lis) {
  const taps = [];
  const push = (ix, iy, iz, alpha) => {
    const dx = ix - lis.x;
    const dy = iy - lis.y;
    const dz = iz - lis.z;
    const d = Math.max(0.6, Math.sqrt(dx * dx + dy * dy + dz * dz));
    taps.push({ t: d / C, a: ((1 - alpha) / d) * 0.9, pan: Math.max(-1, Math.min(1, dx / 3.4)) });
  };
  push(src.x, 2 * ROOM.y0 - src.y, src.z, ABSORB.floor);
  push(src.x, 2 * ROOM.y1 - src.y, src.z, ABSORB.ceiling);
  push(2 * ROOM.x0 - src.x, src.y, src.z, ABSORB.wallL);
  push(2 * ROOM.x1 - src.x, src.y, src.z, ABSORB.wallR);
  push(src.x, src.y, 2 * ROOM.z1 - src.z, ABSORB.wallBack);
  push(src.x, src.y, 2 * ROOM.z0 - src.z, ABSORB.window);
  return taps;
}

/**
 * Three-band exponential tail. Each band gets its own decorrelated noise so the stereo image is
 * wide without the two channels ever cancelling in mono.
 */
function tailInto(chan, sr, r, { rtLow, rtMid, rtHigh, start, tilt = 1 }) {
  const n = chan.length;
  const from = Math.round(start * sr);
  const low = new Float32Array(n);
  const mid = new Float32Array(n);
  const high = new Float32Array(n);
  for (let i = from; i < n; i++) {
    low[i] = r() * 2 - 1;
    mid[i] = r() * 2 - 1;
    high[i] = r() * 2 - 1;
  }
  lp1(low, sr, 320, 2);
  bp2(mid, sr, 1100, 0.7);
  hp1(high, sr, 3600, 2);

  const kL = Math.exp((-6.9078 / rtLow) / sr);
  const kM = Math.exp((-6.9078 / rtMid) / sr);
  const kH = Math.exp((-6.9078 / rtHigh) / sr);
  let eL = 1;
  let eM = 1;
  let eH = 1;
  // Build-up: energy takes ~15 ms to become fully diffuse rather than starting at full level.
  const build = Math.max(1, Math.round(0.018 * sr));
  for (let i = from; i < n; i++) {
    const b = i - from < build ? (i - from) / build : 1;
    chan[i] += (low[i] * eL * 1.15 + mid[i] * eM + high[i] * eH * 0.5 * tilt) * b;
    eL *= kL;
    eM *= kM;
    eH *= kH;
  }
}

function stampTaps(chanL, chanR, sr, taps, r, spread = 1) {
  for (let k = 0; k < taps.length; k++) {
    const tap = taps[k];
    const i = Math.round(tap.t * sr);
    if (i < 1 || i >= chanL.length - 4) continue;
    const pan = tap.pan * spread;
    const gl = Math.sqrt(Math.max(0, 0.5 * (1 - pan)));
    const gr = Math.sqrt(Math.max(0, 0.5 * (1 + pan)));
    // A reflection is never a single sample: smear it over ~0.4 ms so it does not sound like a
    // digital delay tap.
    const smear = Math.max(2, Math.round(0.0004 * sr));
    for (let s = 0; s < smear; s++) {
      const w = (1 - s / smear) * (0.6 + 0.4 * r());
      chanL[i + s] += tap.a * gl * w * 1.4;
      chanR[i + s] += tap.a * gr * w * 1.4;
    }
  }
}

/** Stochastic higher-order reflections: dense, decaying, panned all over. */
function scatterTaps(count, tMin, tMax, decay, r) {
  const taps = [];
  for (let k = 0; k < count; k++) {
    const u = Math.pow(r(), 0.75);
    const t = tMin + (tMax - tMin) * u;
    taps.push({
      t,
      a: (Math.exp(-t / decay) / (1 + t * C * 0.14)) * (0.45 + 0.55 * r()) * (r() < 0.5 ? -1 : 1),
      pan: r() * 2 - 1,
    });
  }
  return taps;
}

/**
 * The living room itself. Source is roughly where the action is (the middle of the rug), listener
 * is the crawling baby at 0.42 m — which is why the floor reflection arrives so early and so hot.
 */
export function makeRoomIR(ac, r) {
  const sr = ac.sampleRate;
  const seconds = 1.05;
  const buf = ac.createBuffer(2, Math.round(seconds * sr), sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);

  const preDelay = Math.round(0.004 * sr);
  L[preDelay] += 0.7;
  R[preDelay] += 0.7;

  const taps = firstOrderTaps({ x: 0.6, y: 0.55, z: -1.4 }, { x: 0.0, y: 0.42, z: 0.5 });
  stampTaps(L, R, sr, taps, r, 0.85);
  stampTaps(L, R, sr, scatterTaps(46, 0.014, 0.075, 0.05, r), r, 1);

  const tail = new Float32Array(L.length);
  tailInto(tail, sr, r, { rtLow: 0.74, rtMid: 0.55, rtHigh: 0.28, start: 0.022 });
  const tail2 = new Float32Array(L.length);
  tailInto(tail2, sr, r, { rtLow: 0.74, rtMid: 0.55, rtHigh: 0.28, start: 0.024 });
  for (let i = 0; i < L.length; i++) {
    L[i] += tail[i] * 0.5;
    R[i] += tail2[i] * 0.5;
  }

  releaseInto(L, sr, 0.08);
  releaseInto(R, sr, 0.08);
  peakNormalize(L, 0.75);
  peakNormalize(R, 0.75);
  return buf;
}

/**
 * The hallway beyond the doorway at z = +3.4. Longer, darker, with a corridor flutter. Anything
 * routed here is a sound the baby is hearing *through a doorway* — the parent moving in another
 * room is the core mechanic, so this bus has to be legible without being loud.
 */
export function makeHallIR(ac, r) {
  const sr = ac.sampleRate;
  const seconds = 1.9;
  const buf = ac.createBuffer(2, Math.round(seconds * sr), sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);

  const preDelay = Math.round(0.019 * sr);
  L[preDelay] += 0.5;
  R[preDelay] += 0.46;

  // Corridor flutter: 1.1 m parallel walls → 6.4 ms round trip, decaying over ~180 ms.
  const flutter = 0.0064;
  for (let k = 1; k < 28; k++) {
    const t = 0.019 + flutter * k * (1 + (r() - 0.5) * 0.06);
    const i = Math.round(t * sr);
    if (i >= L.length - 4) break;
    const a = Math.exp(-t / 0.075) * 0.42 * (0.7 + 0.3 * r());
    const pan = (k % 2 ? 1 : -1) * 0.5;
    L[i] += a * Math.sqrt(0.5 * (1 - pan));
    R[i] += a * Math.sqrt(0.5 * (1 + pan));
  }
  stampTaps(L, R, sr, scatterTaps(70, 0.03, 0.16, 0.09, r), r, 1);

  const tail = new Float32Array(L.length);
  tailInto(tail, sr, r, { rtLow: 1.2, rtMid: 0.95, rtHigh: 0.4, start: 0.035, tilt: 0.5 });
  const tail2 = new Float32Array(L.length);
  tailInto(tail2, sr, r, { rtLow: 1.2, rtMid: 0.95, rtHigh: 0.4, start: 0.038, tilt: 0.5 });
  for (let i = 0; i < L.length; i++) {
    L[i] += tail[i] * 0.62;
    R[i] += tail2[i] * 0.62;
  }
  // A corridor is a bass trap in reverse: it holds low mids and loses air.
  lp1(L, sr, 2600, 1);
  lp1(R, sr, 2600, 1);

  releaseInto(L, sr, 0.12);
  releaseInto(R, sr, 0.12);
  peakNormalize(L, 0.6);
  peakNormalize(R, 0.6);
  return buf;
}
