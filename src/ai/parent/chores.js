// AI · presence. Seven reasons to walk into the room that have nothing to do with you, and six
// places to look when they suspect you are in it.
//
// This file is the difference between a guard and a parent. A guard patrols; a parent comes in
// carrying a mug, puts it down on the coffee table, folds a muslin, waters the monstera and goes
// out again — and the entire time you are under the sofa with a fistful of vinyl, not knowing
// whether they are here for you. Every chore fixes their gaze at the height of the thing they are
// doing, which (see senses.js: the vertical cone is only ±26°) is exactly what makes a baby on the
// floor survivable. The one chore that is genuinely dangerous is `snack`, because picking a crisp
// packet off the rug puts their eyeline at 0.35 m — right where you live.
//
// Every anchor here is authored in metres and then snapped by nav.nearestOpen(), so a chore never
// asks the parent to stand inside a pouf even if FURN moves one.
//
// The `barkKey` on each entry is an i18n key from the set UI ships (`parent.bark.*`). Chores lean
// on `hello` and searches on `quiet`, and parent.js fires them sparingly — a parent who narrates
// every single thing they do is a tutorial, not a threat.

import * as THREE from 'three';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const sstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
/** A 0→1→0 hump with a flat top: reach in, do the thing, come back up. */
const hump = (t, a, b) => sstep(t / a) * (1 - sstep((t - b) / (1 - b || 1)));

/**
 * @returns { chores: [...], searches: [...] } — pure data + an `apply(t, p)` per entry that writes
 *          the animator's pose overrides. `t` is 0..1 across the dwell.
 */
export function createChoreBook(ctx) {
  const L = ctx.layout;

  // Reusable IK targets — one per entry, mutated in place, never allocated per frame.
  const mk = (spec) => {
    spec.reachA = V(0, 0, 0);
    spec.reachB = V(0, 0, 0);
    spec.look = V(0, 0, 0);
    return spec;
  };

  const chores = [
    mk({
      id: 'mug',
      barkKey: 'parent.bark.hello',
      stand: [0.30, -1.86],
      faceAt: [L.coffeeTable.x, 0.40, L.coffeeTable.z],
      dwell: 2.9,
      weight: 1.25,
      apply(t, p) {
        const k = hump(t, 0.30, 0.62);
        p.crouch = 0.46 * k;
        p.lean = 0.30 * k;
        p.armMode = 'reach';
        p.handClose = 0.62 - 0.58 * sstep((t - 0.44) / 0.16);
        this.reachA.set(0.74, 0.86 - 0.44 * k, -2.24);
        p.reachR = this.reachA;
        this.look.set(L.coffeeTable.x - 0.16, 0.42 + 0.22 * (1 - k), L.coffeeTable.z + 0.04);
        p.lookAt = this.look;
        p.lookWeight = 0.9;
      },
    }),
    mk({
      id: 'muslin',
      barkKey: 'parent.bark.hello',
      stand: [0.16, 0.34],
      faceAt: [0.05, 0.34, 1.10],
      dwell: 3.4,
      weight: 1.1,
      apply(t, p) {
        const k = hump(t, 0.24, 0.70);
        // Folding is two hands and a slow shuttle, not a single grab.
        const shuttle = Math.sin(t * Math.PI * 3.1) * 0.10 * k;
        p.crouch = 0.66 * k;
        p.lean = 0.42 * k;
        p.armMode = 'reach';
        p.handClose = 0.10 + 0.65 * sstep((t - 0.30) / 0.22);
        this.reachA.set(-0.16 + shuttle, 0.94 - 0.62 * k, 0.86 + 0.10 * k);
        this.reachB.set(0.28 - shuttle, 0.94 - 0.62 * k, 0.86 + 0.10 * k);
        p.reachL = this.reachA;
        p.reachR = this.reachB;
        this.look.set(0.05, 0.30 + 0.30 * (1 - k), 1.00);
        p.lookAt = this.look;
        p.lookWeight = 1;
      },
    }),
    mk({
      id: 'plant',
      barkKey: 'parent.bark.hello',
      stand: [1.34, -3.58],
      faceAt: [L.monstera.x, 0.95, L.monstera.z],
      dwell: 3.8,
      weight: 1.0,
      apply(t, p) {
        const k = hump(t, 0.22, 0.74);
        p.crouch = 0.12 * k;
        p.lean = 0.20 * k;
        p.armMode = 'reach';
        p.handClose = 0.66;
        // The tilt of a watering can: the hand rolls forward and drifts across three leaves.
        const sweep = Math.sin(t * Math.PI * 1.7) * 0.14 * k;
        this.reachA.set(L.monstera.x - 0.14 + sweep, 0.98 - 0.16 * k, L.monstera.z + 0.30);
        p.reachR = this.reachA;
        this.look.set(L.monstera.x, 0.62 + 0.5 * (1 - k), L.monstera.z + 0.10);
        p.lookAt = this.look;
        p.lookWeight = 0.85;
      },
    }),
    mk({
      id: 'cushion',
      barkKey: 'parent.bark.hello',
      stand: [1.52, -1.52],
      faceAt: [2.80, 0.62, -1.55],
      dwell: 2.6,
      weight: 1.0,
      apply(t, p) {
        const k = hump(t, 0.26, 0.64);
        // Two plumps. The pause between them is what makes it read as a person, not a loop.
        const plump = Math.max(0, Math.sin(t * Math.PI * 4.2)) * 0.09 * k;
        p.crouch = 0.10 * k;
        p.lean = 0.34 * k;
        p.armMode = 'reach';
        p.handClose = 0.20 + 0.62 * k;
        this.reachA.set(2.24 + 0.10 * k, 0.74 + plump, -1.58);
        p.reachR = this.reachA;
        this.look.set(2.70, 0.60, -1.55);
        p.lookAt = this.look;
        p.lookWeight = 0.9;
      },
    }),
    mk({
      id: 'snack',
      barkKey: 'parent.bark.hello',
      stand: [1.08, -0.14],
      faceAt: [L.snackBag.x, 0.16, L.snackBag.z],
      dwell: 2.4,
      weight: 0.85,
      // The dangerous one: their eyeline ends up at knee height, in the middle of the rug.
      danger: true,
      apply(t, p) {
        const k = hump(t, 0.34, 0.58);
        p.crouch = 0.92 * k;
        p.lean = 0.30 * k;
        p.armMode = 'reach';
        p.handClose = 0.04 + 0.72 * sstep((t - 0.46) / 0.14);
        this.reachA.set(L.snackBag.x, 0.90 - 0.78 * k, L.snackBag.z);
        p.reachR = this.reachA;
        this.look.set(L.snackBag.x, 0.12 + 0.86 * (1 - k), L.snackBag.z);
        p.lookAt = this.look;
        p.lookWeight = 1;
      },
    }),
    mk({
      id: 'window',
      barkKey: 'parent.bark.hello',
      stand: [0.62, -3.52],
      faceAt: [1.10, 1.45, -5.40],
      dwell: 4.6,
      weight: 0.9,
      apply(t, p) {
        p.crouch = 0;
        p.lean = -0.04;
        p.armMode = 'hips';
        // They look out, then along the balcony, then out again. Nobody stares at one point.
        const drift = Math.sin(t * Math.PI * 1.35) * 1.25;
        this.look.set(1.10 + drift, 1.42 - 0.10 * Math.cos(t * Math.PI * 2.1), -5.40);
        p.lookAt = this.look;
        p.lookWeight = 1;
      },
    }),
    mk({
      id: 'shelf',
      barkKey: 'parent.bark.hello',
      stand: [-2.52, -0.58],
      faceAt: [-3.18, 0.78, -0.70],
      dwell: 3.0,
      weight: 0.95,
      apply(t, p) {
        const k = hump(t, 0.26, 0.68);
        const slide = Math.sin(t * Math.PI * 2.3) * 0.22 * k;
        p.crouch = 0.30 * k;
        p.lean = 0.18 * k;
        p.armMode = 'reach';
        p.handClose = 0.28 + 0.4 * k;
        this.reachA.set(-2.98, 0.88 - 0.10 * k, -0.62 + slide);
        p.reachL = this.reachA;
        this.look.set(-3.15, 0.72, -0.66 + slide);
        p.lookAt = this.look;
        p.lookWeight = 0.95;
      },
    }),
  ];

  // ── search points ───────────────────────────────────────────────────────────────────────
  // Where a real person looks for a baby who has gone quiet, in the order the panic escalates.
  const searches = [
    mk({
      id: 'playpen',
      barkKey: 'parent.bark.quiet',
      stand: [0.16, 0.34],
      at: [L.playpen.x, 0.30, L.playpen.z],
      faceAt: [L.playpen.x, 0.28, L.playpen.z - 0.4],
      dwell: 2.2,
      apply(t, p) {
        const k = sstep(Math.min(1, t * 2.6)) * (1 - sstep((t - 0.72) / 0.28));
        p.crouch = 0.34 * k;
        p.lean = 0.44 * k;
        p.armMode = 'relax';
        this.look.set(L.playpen.x + Math.sin(t * 5.4) * 0.55, 0.26, L.playpen.z + 0.1);
        p.lookAt = this.look;
        p.lookWeight = 1;
      },
    }),
    mk({
      id: 'table',
      barkKey: 'parent.bark.quiet',
      stand: [0.42, -1.80],
      at: [L.coffeeTable.x, 0.14, L.coffeeTable.z],
      faceAt: [L.coffeeTable.x, 0.12, L.coffeeTable.z],
      dwell: 2.3,
      apply(t, p) {
        // All the way down onto one knee to look under the glass. The most human thing they do.
        const k = sstep(Math.min(1, t * 2.2)) * (1 - sstep((t - 0.74) / 0.26));
        p.crouch = 0.95 * k;
        p.lean = 0.30 * k;
        p.armMode = 'relax';
        this.look.set(L.coffeeTable.x + Math.sin(t * 4.1) * 0.42, 0.10, L.coffeeTable.z - 0.15);
        p.lookAt = this.look;
        p.lookWeight = 1;
      },
    }),
    mk({
      id: 'sofa',
      barkKey: 'parent.bark.quiet',
      stand: [1.58, 0.62],
      at: [2.40, 0.30, 0.60],
      faceAt: [2.60, 0.24, 0.30],
      dwell: 1.6,
      apply(t, p) {
        const k = sstep(Math.min(1, t * 2.4)) * (1 - sstep((t - 0.72) / 0.28));
        p.crouch = 0.24 * k;
        p.lean = 0.52 * k;   // leaning over the back of the chaise
        p.armMode = 'reach';
        p.handClose = 0.45;
        this.reachA.set(2.05, 0.66, 0.55);
        p.reachR = this.reachA;
        this.look.set(2.45 + Math.sin(t * 3.4) * 0.5, 0.22, 0.45);
        p.lookAt = this.look;
        p.lookWeight = 1;
      },
    }),
    mk({
      id: 'ottoman',
      barkKey: 'parent.bark.quiet',
      stand: [-1.38, -1.25],
      at: [L.ottoman.x, 0.20, L.ottoman.z],
      faceAt: [L.ottoman.x, 0.18, L.ottoman.z - 0.3],
      dwell: 1.5,
      apply(t, p) {
        const k = sstep(Math.min(1, t * 2.5)) * (1 - sstep((t - 0.72) / 0.28));
        p.crouch = 0.58 * k;
        p.lean = 0.34 * k;
        p.armMode = 'relax';
        this.look.set(L.ottoman.x - 0.3 + Math.sin(t * 4.6) * 0.6, 0.16, L.ottoman.z - 0.2);
        p.lookAt = this.look;
        p.lookWeight = 1;
      },
    }),
    mk({
      id: 'curtain',
      barkKey: 'parent.bark.quiet',
      stand: [1.06, -3.86],
      at: [0.90, 0.60, -4.42],
      faceAt: [0.90, 0.90, -4.46],
      dwell: 1.4,
      apply(t, p) {
        const k = sstep(Math.min(1, t * 2.8)) * (1 - sstep((t - 0.70) / 0.30));
        p.crouch = 0.10 * k;
        p.lean = 0.12 * k;
        p.armMode = 'reach';
        p.handClose = 0.55;
        // Sweeping the sheer aside with the back of one hand.
        this.reachA.set(0.72 - 0.28 * k, 1.16, -4.32);
        p.reachL = this.reachA;
        this.look.set(0.86, 0.50 - 0.34 * k, -4.44);
        p.lookAt = this.look;
        p.lookWeight = 1;
      },
    }),
    mk({
      id: 'shelfSearch',
      barkKey: 'parent.bark.quiet',
      stand: [-2.46, 0.34],
      at: [-3.10, 0.35, -0.60],
      faceAt: [-3.15, 0.40, -1.20],
      dwell: 1.5,
      apply(t, p) {
        const k = sstep(Math.min(1, t * 2.5)) * (1 - sstep((t - 0.72) / 0.28));
        p.crouch = 0.40 * k;
        p.lean = 0.22 * k;
        p.armMode = 'relax';
        this.look.set(-3.16, 0.34, -0.4 - Math.sin(t * 3.0) * 1.5);
        p.lookAt = this.look;
        p.lookWeight = 1;
      },
    }),
  ];

  /** The n nearest search points to a world position, nearest first. */
  function searchesNear(x, z, n) {
    const scored = searches.map((s) => ({
      s,
      d: Math.hypot(s.at[0] - x, s.at[2] - z),
    }));
    scored.sort((a, b) => a.d - b.d);
    return scored.slice(0, Math.max(1, n)).map((e) => e.s);
  }

  return { chores, searches, searchesNear };
}
