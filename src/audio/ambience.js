// AUDIO · the room's continuous bed.
//
// Three sustained sources and a set of Poisson-ish one-shot timers. The sustained layer is what
// stops the mix sounding like a silent vacuum with events dropped into it: a brown-noise traffic
// bed sitting behind the glazing (low-passed at 420 Hz, because 12 mm of glass is a brutal
// low-pass filter), a near-inaudible room tone under everything, and a low hum from beyond the
// doorway routed entirely through the hallway convolver so the flat next door is *somewhere else*.
//
// The one-shots are what make a room feel inhabited over a three-minute round: the radiator
// ticking as it cools, a car going past, a dog two courtyards away, the pendant cord creaking
// when the bulb is swinging, the clock. Each has its own random interval, all of them drawn from
// the seeded RNG so a recorded run is reproducible.

import { gainNode, filterNode, bufferSource, clamp } from './dsp.js';
import { LOOP_TRIM } from './sfx.js';

const WINDOW_POS = [0.9, 1.25, -4.5];
const RADIATOR_POS = [-0.7, 0.34, -4.45];
const CLOCK_POS = [-3.15, 1.15, -0.4];
const HALL_POS = [1.9, 1.2, 3.5];
const CURTAIN_POS = [2.6, 1.3, -4.4];
const PENDANT_POS = [0.3, 1.62, -1.2];
const ESPRESSO_POS = [-3.15, 0.74, 2.25];

export function createAmbience(A) {
  const ac = A.ac;
  const r = A.r;
  const tier = A.quality.tier;
  const rich = tier !== 'low';

  const nodes = [];
  const keep = (n) => {
    nodes.push(n);
    return n;
  };

  // --- the street through the glazing ---------------------------------------------------------
  const streetBuf = A.buf('streetBed');
  const street = keep(bufferSource(ac, streetBuf, 1, true));
  street.loopStart = 0;
  street.loopEnd = Math.max(0.5, streetBuf.duration - LOOP_TRIM.streetBed);
  const streetLp = keep(filterNode(ac, 'lowpass', 420, 0.5));
  const streetGain = keep(gainNode(ac, 0.0001));
  const streetPan = keep(A.makePanner(WINDOW_POS, { ref: 3.5, rolloff: 0.5, max: 40 }));
  street.connect(streetLp);
  streetLp.connect(streetGain);
  streetGain.connect(streetPan);
  streetPan.connect(A.out);
  if (A.roomSend) {
    const s = keep(gainNode(ac, 0.35));
    streetGain.connect(s);
    s.connect(A.roomSend);
  }
  street.start(ac.currentTime + 0.02);
  streetGain.gain.setTargetAtTime(0.085, ac.currentTime, 1.2);

  // --- room tone ------------------------------------------------------------------------------
  let tone = null;
  if (rich) {
    const toneBuf = A.buf('roomTone');
    tone = keep(bufferSource(ac, toneBuf, 1, true));
    tone.loopStart = 0;
    tone.loopEnd = Math.max(0.5, toneBuf.duration - LOOP_TRIM.roomTone);
    const g = keep(gainNode(ac, 0.0001));
    tone.connect(g);
    g.connect(A.out);
    tone.start(ac.currentTime + 0.03);
    g.gain.setTargetAtTime(0.05, ac.currentTime, 2);
  }

  // --- something humming in the flat next door -------------------------------------------------
  let hum = null;
  if (rich && A.hallSend) {
    const g = keep(gainNode(ac, 0.0001));
    const o1 = keep(ac.createOscillator());
    o1.type = 'sine';
    o1.frequency.value = 99.6;
    const o2 = keep(ac.createOscillator());
    o2.type = 'sine';
    o2.frequency.value = 199.7;
    const g2 = keep(gainNode(ac, 0.35));
    o2.connect(g2);
    g2.connect(g);
    o1.connect(g);
    const lp = keep(filterNode(ac, 'lowpass', 300, 0.7));
    g.connect(lp);
    lp.connect(A.hallSend);
    o1.start(ac.currentTime);
    o2.start(ac.currentTime);
    g.gain.setTargetAtTime(0.03, ac.currentTime, 3);
    hum = { o1, o2, g };
  }

  // --- one-shot timers -------------------------------------------------------------------------
  const timers = [
    { t: 1 + r() * 3, min: 4, max: 14, fire: () => A.play('world.radiatorTick', { position: RADIATOR_POS, gain: 0.5 + r() * 0.4, priority: 0.3 }) },
    { t: 4 + r() * 8, min: 9, max: 26, fire: () => A.play('world.carPass', { position: WINDOW_POS, gain: 0.5 + r() * 0.4, priority: 0.3, bus: 'ambience' }) },
    { t: 18 + r() * 30, min: 34, max: 95, fire: () => A.play('world.dogBark', { position: WINDOW_POS, gain: 0.45 + r() * 0.3, priority: 0.3, bus: 'ambience' }) },
    { t: 40 + r() * 60, min: 60, max: 160, fire: () => A.play('world.horn', { position: WINDOW_POS, gain: 0.4 + r() * 0.3, priority: 0.25, bus: 'ambience' }) },
    { t: 12 + r() * 20, min: 26, max: 62, fire: () => A.play('world.curtain', { position: CURTAIN_POS, gain: 0.35 + r() * 0.3, priority: 0.3, bus: 'ambience' }) },
    { t: 9 + r() * 14, min: 20, max: 48, fire: () => A.play('world.cordCreak', { position: PENDANT_POS, gain: 0.3 + r() * 0.25, priority: 0.3, bus: 'ambience' }) },
    { t: 55 + r() * 70, min: 90, max: 220, fire: () => A.play('world.espresso', { position: ESPRESSO_POS, gain: 0.5, priority: 0.3, bus: 'ambience' }) },
  ];

  // The clock is on its own strict one-second grid — that regularity is the point of a clock.
  let clockAcc = 0;
  let clockFlip = 0;

  let active = true;
  let swellPhase = r() * 6.283;

  return {
    setActive(v) {
      const on = !!v;
      if (on === active) return;
      active = on;
      streetGain.gain.setTargetAtTime(on ? 0.085 : 0.02, ac.currentTime, 0.6);
    },

    /** Pendant swing speed 0..1 → an occasional creak while it is actually moving. */
    cordEnergy: 0,

    update(dt) {
      if (!active) return;
      swellPhase += dt * 0.19;
      streetGain.gain.setTargetAtTime(0.085 * (0.72 + 0.28 * Math.sin(swellPhase)), ac.currentTime, 0.9);

      for (let i = 0; i < timers.length; i++) {
        const tm = timers[i];
        tm.t -= dt;
        if (tm.t <= 0) {
          tm.t = tm.min + (tm.max - tm.min) * r();
          tm.fire();
        }
      }

      if (rich) {
        clockAcc += dt;
        if (clockAcc >= 1) {
          clockAcc -= 1;
          clockFlip ^= 1;
          A.play('world.clockTick', {
            position: CLOCK_POS,
            gain: 0.32,
            rate: clockFlip ? 1.0 : 0.97,
            priority: 0.2,
            bus: 'ambience',
          });
        }
      }

      // The bare bulb on its 1.1 m cord: creak in proportion to how hard it is swinging.
      const e = clamp(this.cordEnergy, 0, 1);
      if (e > 0.12 && r() < e * dt * 1.6) {
        A.play('world.cordCreak', { position: PENDANT_POS, gain: 0.25 + e * 0.5, bus: 'ambience', priority: 0.4 });
      }
    },

    dispose() {
      const t = ac.currentTime;
      try {
        street.stop(t);
      } catch {
        /* already stopped */
      }
      if (tone) {
        try {
          tone.stop(t);
        } catch {
          /* already stopped */
        }
      }
      if (hum) {
        try {
          hum.o1.stop(t);
          hum.o2.stop(t);
        } catch {
          /* already stopped */
        }
      }
      for (let i = 0; i < nodes.length; i++) {
        try {
          nodes[i].disconnect();
        } catch {
          /* gone */
        }
      }
      nodes.length = 0;
    },
  };
}
