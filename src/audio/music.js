// AUDIO · the adaptive score.
//
// The joke of this game is that a nursery lullaby slowly turns into a stealth soundtrack without
// ever changing key, so everything below lives in D minor and shares one pentatonic pool. Four
// layers crossfade over ~1.2 s (setTargetAtTime with τ = 0.4 reaches 95 % in 1.2 s):
//
//   1. celesta   — FM bells on a modal motif. Always there. This is the lullaby.
//   2. ostinato  — Karplus–Strong plucks on the 8ths, faded in by CHAOS (how wrecked the room is).
//   3. drone     — two detuned saws on D2 plus a sub, faded in by THREAT (where the parent is).
//   4. heartbeat — a lub-dub kick, only once the parent is actively searching.
//
// Tempo rides threat from 64 to 110 bpm. Notes are scheduled with a 0.4 s look-ahead against
// AudioContext time rather than from requestAnimationFrame, because rAF jitter of ±8 ms is
// audible as sloppy rhythm while AudioParam scheduling is sample-accurate.
//
// The stab on being spotted is the only dissonance in the whole score: a D–E♭–A cluster, 1.1 s,
// and then straight back to the lullaby. Restraint is the gag.

import { gainNode, filterNode, bufferSource, clamp, smoothstep } from './dsp.js';
import { fmBell, subDrop, makePluckBuffer } from './sfx.js';

const D4 = 293.6648;
const PENTA = [0, 3, 5, 7, 10]; // D F G A C
const MOTIFS = [
  [4, 5, 6, 5, 4, 2],
  [6, 5, 3, 4, 2],
  [2, 4, 5, 7, 5, 4],
  [5, 7, 6, 4, 5],
];
const OSTINATO = [0, 3, 2, 3, 0, 4, 2, 3];

const semiOf = (i) => PENTA[((i % 5) + 5) % 5] + 12 * Math.floor(i / 5);
const freqOf = (semi) => D4 * Math.pow(2, semi / 12);

export function createScore(A) {
  const ac = A.ac;
  const r = A.r;

  const out = A.out; // the music bus input

  const celesta = gainNode(ac, 0.0001);
  const ostinato = gainNode(ac, 0.0001);
  const droneGain = gainNode(ac, 0.0001);
  const pulse = gainNode(ac, 0.0001);
  const accent = gainNode(ac, 1);
  celesta.connect(out);
  ostinato.connect(out);
  droneGain.connect(out);
  pulse.connect(out);
  accent.connect(out);

  const pluckCache = new Map();
  function pluckBuffer(freq) {
    const key = Math.round(freq);
    let b = pluckCache.get(key);
    if (!b) {
      b = makePluckBuffer(ac, freq, r, 0.85);
      pluckCache.set(key, b);
    }
    return b;
  }

  // --- the drone, built lazily and torn down when it has been silent for a while --------------
  let drone = null;
  let droneIdle = 0;
  function buildDrone() {
    if (drone) return;
    const lp = filterNode(ac, 'lowpass', 240, 3.5);
    const a = ac.createOscillator();
    a.type = 'sawtooth';
    a.frequency.value = freqOf(-24);
    a.detune.value = -6;
    const b = ac.createOscillator();
    b.type = 'sawtooth';
    b.frequency.value = freqOf(-24);
    b.detune.value = 7;
    const sub = ac.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = freqOf(-36);
    const mix = gainNode(ac, 0.28);
    const subG = gainNode(ac, 0.5);
    a.connect(mix);
    b.connect(mix);
    sub.connect(subG);
    subG.connect(lp);
    mix.connect(lp);
    lp.connect(droneGain);
    // A slow filter sweep so the pad breathes instead of sitting there like a held organ chord.
    const lfo = ac.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.07;
    const lfoG = gainNode(ac, 150);
    lfo.connect(lfoG);
    lfoG.connect(lp.frequency);
    const t = ac.currentTime;
    a.start(t);
    b.start(t);
    sub.start(t);
    lfo.start(t);
    drone = { a, b, sub, lfo, lp, mix, subG, lfoG };
  }
  function killDrone() {
    if (!drone) return;
    const t = ac.currentTime;
    for (const k of ['a', 'b', 'sub', 'lfo']) {
      try {
        drone[k].stop(t);
      } catch {
        /* already stopped */
      }
      try {
        drone[k].disconnect();
      } catch {
        /* gone */
      }
    }
    try {
      drone.lp.disconnect();
    } catch {
      /* gone */
    }
    drone = null;
  }

  // --- state ---------------------------------------------------------------------------------
  let running = false;
  let stepIndex = 0;
  let nextStepTime = 0;
  let threat = 0;
  let chaos = 0;
  let motif = MOTIFS[0];
  let motifPos = 0;
  let centre = 5;
  let phrase = 0;

  const bpm = () => 64 + 46 * threat;
  const stepDur = () => 60 / bpm() / 2; // 8th notes

  function celestaNote(t, semi, gain, decay) {
    fmBell(ac, t, celesta, {
      freq: freqOf(semi),
      ratio: 3.51 + (r() - 0.5) * 0.06,
      index: 4.5 + r() * 2.5,
      decay,
      gain,
      attack: 0.003,
    });
  }

  function pluckNote(t, semi, gain, rate = 1) {
    const src = bufferSource(ac, pluckBuffer(freqOf(semi)), rate);
    const g = gainNode(ac, gain);
    src.connect(g);
    g.connect(ostinato);
    src.start(t);
    src.stop(t + 0.9 / rate);
  }

  function kick(t, gain) {
    subDrop(ac, t, pulse, { from: 128, to: 44, drop: 0.06, decay: 0.19, gain });
  }

  function scheduleStep(i, t) {
    const beat = i % 2 === 0;
    const bar = i % 8;

    // --- celesta lullaby --------------------------------------------------------------------
    if (beat) {
      if (bar === 0) {
        phrase++;
        if (r() < 0.45) motif = MOTIFS[Math.floor(r() * MOTIFS.length)];
        centre = clamp(centre + (r() < 0.5 ? -1 : 1) * (r() < 0.3 ? 2 : 1), 3, 8);
        motifPos = 0;
      }
      const density = 0.82 - threat * 0.35;
      if (r() < density) {
        const deg = motif[motifPos % motif.length] + (centre - 5);
        motifPos++;
        const oct = r() < 0.12 ? 5 : 0;
        celestaNote(t, semiOf(deg) + oct, 0.2 + r() * 0.09, 0.9 + r() * 0.5);
        // gentle two-note harmony every so often — a sixth below, never a third (too sweet)
        if (r() < 0.18) celestaNote(t + 0.012, semiOf(deg - 3), 0.1, 1.1);
      } else if (r() < 0.25) {
        // a grace ornament on the off-beat keeps it from feeling metronomic
        celestaNote(t + stepDur() * 0.5, semiOf(centre + 2), 0.09, 0.5);
      }
    }

    // --- plucked ostinato -------------------------------------------------------------------
    if (chaos > 0.02) {
      const deg = OSTINATO[i % OSTINATO.length];
      const skip = bar === 6 && r() < 0.4;
      if (!skip) pluckNote(t, semiOf(deg) - 12, 0.17 + r() * 0.05, 0.995 + r() * 0.01);
      if (bar === 4 && chaos > 0.55) pluckNote(t + stepDur() * 0.5, semiOf(deg + 2) - 12, 0.1);
    }

    // --- heartbeat --------------------------------------------------------------------------
    if (threat > 0.5) {
      if (bar === 0 || bar === 4) {
        kick(t, 0.32);
        kick(t + stepDur() * 0.56, 0.19);
      }
    }
  }

  function resync() {
    nextStepTime = ac.currentTime + 0.06;
  }

  return {
    get running() {
      return running;
    },

    start() {
      if (running) return;
      running = true;
      stepIndex = 0;
      phrase = 0;
      motif = MOTIFS[Math.floor(r() * MOTIFS.length)];
      resync();
    },

    stop(fade = 0.8) {
      if (!running) return;
      running = false;
      const t = ac.currentTime;
      for (const g of [celesta, ostinato, droneGain, pulse]) {
        g.gain.cancelScheduledValues(t);
        g.gain.setTargetAtTime(0.0001, t, fade / 3);
      }
      setTimeout(killDrone, (fade + 0.4) * 1000);
    },

    /** threat 0..1 (parent proximity/state), chaos 0..1 (how ruined the room is). */
    setIntensity(nextThreat, nextChaos) {
      threat = clamp(nextThreat, 0, 1);
      chaos = clamp(nextChaos, 0, 1);
    },

    update(dt) {
      const t = ac.currentTime;

      // layer targets — the whole adaptive system is these four numbers
      const gCel = running ? 0.85 - 0.45 * smoothstep(0.35, 1, threat) : 0;
      const gOst = running ? clamp(chaos * 1.25, 0, 1) * (0.85 - 0.25 * threat) : 0;
      const gDro = running ? smoothstep(0.28, 0.85, threat) * 0.85 : 0;
      const gPul = running ? smoothstep(0.5, 0.95, threat) : 0;

      celesta.gain.setTargetAtTime(Math.max(0.0001, gCel), t, 0.4);
      ostinato.gain.setTargetAtTime(Math.max(0.0001, gOst), t, 0.4);
      droneGain.gain.setTargetAtTime(Math.max(0.0001, gDro), t, 0.4);
      pulse.gain.setTargetAtTime(Math.max(0.0001, gPul), t, 0.35);

      if (gDro > 0.02) {
        buildDrone();
        droneIdle = 0;
      } else if (drone) {
        droneIdle += dt;
        if (droneIdle > 3) killDrone();
      }

      if (!running) return;

      // Look-ahead scheduling. If the tab was suspended we may be far behind; resync instead of
      // machine-gunning a hundred catch-up notes.
      if (nextStepTime < t - 0.4) resync();
      let guard = 0;
      while (nextStepTime < t + 0.4 && guard++ < 24) {
        scheduleStep(stepIndex, nextStepTime);
        nextStepTime += stepDur();
        stepIndex++;
      }
    },

    /** Spotted. One cluster, 1.1 s, then back to the nursery. */
    stab() {
      const t = ac.currentTime + 0.005;
      fmBell(ac, t, accent, { freq: freqOf(0), ratio: 1.41, index: 9, decay: 0.9, gain: 0.26 });
      fmBell(ac, t + 0.004, accent, { freq: freqOf(1), ratio: 1.41, index: 8, decay: 0.75, gain: 0.2 });
      fmBell(ac, t + 0.008, accent, { freq: freqOf(7), ratio: 2.02, index: 7, decay: 1.0, gain: 0.18 });
      subDrop(ac, t, accent, { from: 210, to: 33, drop: 0.4, decay: 0.5, gain: 0.4 });
      return 1.3;
    },

    /** The end. 'caught' falls, 'timeup' rises — same key, opposite feeling. */
    cadence(kind) {
      const t = ac.currentTime + 0.02;
      const seq =
        kind === 'caught'
          ? [
              [7, 0],
              [3, 0.34],
              [0, 0.68],
              [-5, 1.05],
            ]
          : [
              [0, 0],
              [3, 0.3],
              [7, 0.6],
              [12, 0.92],
            ];
      for (let i = 0; i < seq.length; i++) {
        fmBell(ac, t + seq[i][1], accent, {
          freq: freqOf(seq[i][0] + 12),
          ratio: 3.51,
          index: 4,
          decay: 1.5 + i * 0.4,
          gain: 0.22,
        });
      }
      if (kind === 'caught') subDrop(ac, t + 1.05, accent, { from: 90, to: 30, drop: 0.5, decay: 0.9, gain: 0.3 });
      return 3;
    },

    dispose() {
      killDrone();
      for (const g of [celesta, ostinato, droneGain, pulse, accent]) {
        try {
          g.disconnect();
        } catch {
          /* gone */
        }
      }
      pluckCache.clear();
    },
  };
}
