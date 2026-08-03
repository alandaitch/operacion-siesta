// AI · what the parent can hear and what they can actually see.
//
// HEARING is a scalar field, not a raycast. Every `noise` event is attenuated by an inverse-power
// law and then multiplied by a transmission term: sound between the room and the hallway either
// goes through the 1.00 m doorway (barely attenuated) or through 150 mm of plaster (badly). That
// single split is what makes the doorway matter — a book falling while they are in the corridor is
// nothing, the same book falling while they stand in the opening brings them straight over. Each
// event feeds a decaying `alertness`, and anything above LOUD also latches a startle that the
// state machine consumes.
//
// VISION is deliberately asymmetric. The horizontal cone is a normal ~100°, but the vertical one is
// only ±26° — and the parent's head pitch is driven by whatever they are *doing*, which means that
// while they carry a mug at chest height a baby on the floor is genuinely outside their cone at
// anything closer than about two metres. That is not a fudge; it is why crawling works.
//
// Detection then fills over time rather than triggering, and the fill rate is a product of seven
// terms — apparent size, how centred you are horizontally, how far below their eyeline you are,
// whether you are moving, whether the window is lighting you, how high off the floor your head is,
// and how much cover you are behind. Under the coffee table with your head down and the sun behind
// you, the meter barely moves. Standing up in a sun rectangle two metres away while they are
// looking for you, it fills in under a second. The meter drains slowly and only after a grace
// period, so ducking behind the ottoman for a frame does not reset their suspicion.
//
// TWO THINGS THAT WERE WRONG AND ARE THE REASON THE ROUND USED TO LAST NINE SECONDS:
//  · Proximity fell off linearly (1.95 − d/4.4), so a baby 4.5 m away across the whole flat read at
//    two thirds the strength of one at arm's length and the meter filled from the corridor before
//    the player had moved. Apparent size goes as 1/r²; it now does.
//  · Only the horizontal offset counted toward "how central are you in my vision". A crawling baby
//    lives permanently at the bottom lip of an adult's cone, which is exactly where human vision is
//    a motion detector and nothing else — so `lowness` and a much harsher `motion` term now carry
//    the stealth. Freezing when they turn around genuinely works; it is the core verb.
//
// AWARENESS is the round's opening: for the first ~40 s (GRACE_BASE) the parent is in another room
// with a tap running, gated straight off ctx.elapsed in parent.js — no chore starts, no state
// transition opens, the meters below still tick but parent.js clamps what it reads off them. A loud
// noise can pull that window in, but never below GRACE_MIN (~15 s): it never makes them literally
// blind, a crash two metres from the doorway still latches `startle` at full strength. It never
// makes the round arbitrary either — same 40 s, every run, unless you make noise.

import * as THREE from 'three';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const H_HALF = 50 * (Math.PI / 180);   // ~100° horizontal
const V_HALF = 26 * (Math.PI / 180);   // much shorter vertically — the whole stealth mechanic
const VIEW_FAR = 9.0;
const LOUD = 0.22;                     // effective loudness that brings them in immediately
const EAR_Y = 1.55;
/** Distance at which a sound has lost half its punch, and how fast it falls off after that.
 *  1/r² is far too brutal for a reverberant 7 m flat — it makes the whole place feel deaf. */
const HEAR_REF = 3.2;
const HEAR_EXP = 1.30;

const DIFF = [
  { hear: 0.80, see: 0.80, fade: 0.62, alertDecay: 0.130 },  // 0 · gentle
  { hear: 1.00, see: 1.00, fade: 0.46, alertDecay: 0.090 },  // 1 · standard
  { hear: 1.26, see: 1.30, fade: 0.32, alertDecay: 0.062 },  // 2 · feral
];

/** Point-in-rotated-rectangle, for the "are they under the coffee table" test. */
function inRect(px, pz, cx, cz, hw, hd, rot) {
  const dx = px - cx;
  const dz = pz - cz;
  const c = Math.cos(-rot);
  const s = Math.sin(-rot);
  const rx = dx * c - dz * s;
  const rz = dx * s + dz * c;
  return Math.abs(rx) <= hw && Math.abs(rz) <= hd;
}

export function createSenses(ctx) {
  const L = ctx.layout;
  const tier = (ctx.quality && ctx.quality.tier) || 'high';
  const RAYS = tier === 'low' || tier === 'medium' ? 1 : 3;

  const doorX0 = L.doorway.x0;
  const doorX1 = L.doorway.x1;
  const doorH = L.doorway.height;
  const wallZ = L.doorway.z;

  const table = L.coffeeTable;

  // Late-afternoon key, per the art bible: low, beyond the glazing, off to -Z/-X. This is only the
  // fallback — LIGHT owns the real number and it drifts toward dusk as the room gets wrecked, so we
  // re-read it every couple of seconds. `sunDir` points *at* the sun; lighting.sunDirection() gives
  // the direction the photons travel, hence the negation.
  const sunDir = new THREE.Vector3(-0.35, 0.27, -0.90).normalize();
  let sunPolled = -99;
  let sunChecked = -1;
  let sunLit = 0.5;

  function pollSun() {
    if (clock - sunPolled < 2.0) return;
    sunPolled = clock;
    const l = ctx.lighting;
    if (!l || typeof l.sunDirection !== 'function') return;
    try {
      l.sunDirection(sunDir);
      sunDir.negate();
      if (sunDir.lengthSq() > 1e-6) sunDir.normalize();
      else sunDir.set(-0.35, 0.27, -0.90).normalize();
    } catch {
      /* LIGHT is authored in parallel; the fallback vector is perfectly usable */
    }
  }

  const state = {
    alertness: 0,
    detection: 0,
    visible: false,
    distance: 99,
    /** Set by a noise loud enough to walk in about. The brain consumes and clears it. */
    startle: 0,
    startleAt: -99,
    lastHeard: { x: 0, y: 0, z: 0, t: -99, strength: 0, source: null },
    lastSeen: { x: 0, y: 0, z: 0, t: -99, valid: false },
    lastSeenSpeed: 0,
    cover: 1,
    light: 0.5,
    exposure: 0,
    rate: 0,
  };

  let stealth = 1;      // status effects (rules pushes this: sticky hands, giggles, …)
  /** How hard they are actually looking. 1 while pottering, ~2.4 while peering under the table.
   *  Somebody who is searching for you finds you far faster than somebody carrying a mug, and
   *  making that explicit is what gives the alert states real teeth. */
  let focus = 1;
  let diff = DIFF[1];
  let clock = 0;
  let unseenFor = 99;

  // scratch
  const _baby = new THREE.Vector3();
  const _prevBaby = new THREE.Vector3();
  const _local = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _sunFrom = new THREE.Vector3();
  const _inv = new THREE.Quaternion();
  const _right = new THREE.Vector3();
  let hasPrev = false;
  let babySpeed = 0;

  // ── hearing ─────────────────────────────────────────────────────────────────────────────
  const ear = new THREE.Vector3(L.hallway.spawn.x, EAR_Y, L.hallway.spawn.z);

  /** 1 = as if in the same room, 0.24 = through the wall. */
  function transmission(sx, sy, sz) {
    const a = (sz - wallZ);
    const b = (ear.z - wallZ);
    if ((a <= 0 && b <= 0) || (a >= 0 && b >= 0)) return 1;
    const t = (wallZ - sz) / ((ear.z - sz) || 1e-6);
    const x = sx + (ear.x - sx) * t;
    const y = sy + (ear.y - sy) * t;
    if (x > doorX0 - 0.06 && x < doorX1 + 0.06 && y > -0.1 && y < doorH) return 0.88;
    return 0.24;
  }

  function onNoise(e) {
    if (!e || !e.position) return;
    const p = e.position;
    const loud = clamp01(e.loudness === undefined ? 0.4 : e.loudness);
    if (loud <= 0.001) return;
    const dx = (p.x || 0) - ear.x;
    const dy = (p.y || 0) - ear.y;
    const dz = (p.z || 0) - ear.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const atten = 1 / (1 + Math.pow(d / HEAR_REF, HEAR_EXP));
    const eff = loud * atten * transmission(p.x || 0, p.y || 0, p.z || 0) * diff.hear;
    if (eff < 0.018) return;

    state.alertness = clamp01(state.alertness + eff * 1.45);
    // Keep the loudest recent thing, not the latest: a single crash should not be overwritten by
    // the three quiet thumps of the same book settling.
    if (eff >= state.lastHeard.strength * 0.75 || clock - state.lastHeard.t > 1.6) {
      state.lastHeard.x = p.x || 0;
      state.lastHeard.y = p.y || 0;
      state.lastHeard.z = p.z || 0;
      state.lastHeard.t = clock;
      state.lastHeard.strength = eff;
      state.lastHeard.source = e.source || null;
    }
    if (eff >= LOUD) {
      state.startle = Math.max(state.startle, eff);
      state.startleAt = clock;
    }
  }

  const offNoise = ctx.events.on('noise', onNoise);

  // ── the target ──────────────────────────────────────────────────────────────────────────
  function babyHead(out) {
    const b = ctx.baby;
    if (!b) {
      out.set(0, 0.42, 1.55);
      return out;
    }
    const src = b.head || b.group;
    if (src && src.getWorldPosition) src.getWorldPosition(out);
    else if (b.position) out.set(b.position.x, b.position.y + (b.eyeHeight || 0.42), b.position.z);
    else out.set(0, 0.42, 1.55);
    return out;
  }

  /** How exposed the window makes them. One shadow ray at 8 Hz, plus an analytic fallback. */
  function lightAt(p) {
    // The glazing runs x ∈ [-1.60, 3.40] at z = -4.60; the raking band lands in the first ~3.5 m.
    const band = clamp01(1 - (p.z - L.glazing.z) / 4.0);
    const across = p.x > L.glazing.x0 - 0.8 ? 1 : clamp01(1 - (L.glazing.x0 - 0.8 - p.x) / 1.6);
    let v = 0.22 + 0.62 * band * across;
    if (ctx.physics && ctx.physics.raycast) {
      if (clock - sunChecked > 0.125) {
        sunChecked = clock;
        // Start clear of the baby's own capsule, or a solid-mode ray reports a hit at t=0 and the
        // poor thing is permanently in shadow.
        _sunFrom.set(p.x, p.y + 0.14, p.z);
        const ex = ctx.baby && ctx.baby.character && ctx.baby.character.collider;
        const hit = ctx.physics.raycast(_sunFrom, sunDir, 7.0, ex ? { exclude: ex } : undefined);
        sunLit = hit ? 0 : 1;
      }
      v = v * 0.55 + sunLit * 0.55;
    }
    // The floor lamp and the pendant are weak but they are still a silhouette-maker.
    const lamp = L.floorLamp;
    const dl = Math.hypot(p.x - lamp.x, p.z - lamp.z);
    v += 0.14 * clamp01(1 - dl / 1.9);
    return clamp01(v);
  }

  /** 1 = out in the open. Under the glass coffee table you are nearly invisible from standing. */
  function coverAt(p) {
    let c = 1;
    if (p.y < 0.36 && inRect(p.x, p.z, table.x, table.z, table.w * 0.5 + 0.06, table.d * 0.5 + 0.06, table.rot)) {
      c *= 0.17;
    }
    if (p.y < 0.30) c *= 0.72;        // head down is head down
    return c;
  }

  // ── vision ──────────────────────────────────────────────────────────────────────────────
  /** @param self { eye:Vector3, headQuat:Quaternion, blind:boolean } */
  function look(dt, self) {
    babyHead(_baby);
    state.distance = self.eye.distanceTo(_baby);

    if (hasPrev) {
      const inst = _prevBaby.distanceTo(_baby) / Math.max(dt, 1e-4);
      babySpeed += (Math.min(inst, 4) - babySpeed) * Math.min(1, dt * 6);
    }
    _prevBaby.copy(_baby);
    hasPrev = true;

    state.light = lightAt(_baby);
    state.cover = coverAt(_baby);
    state.exposure = clamp01((_baby.y - 0.14) / 0.52);

    let visible = false;
    let rate = 0;

    if (!self.blind && state.distance < VIEW_FAR) {
      _inv.copy(self.headQuat).invert();
      _local.copy(_baby).sub(self.eye).applyQuaternion(_inv);
      const flat = Math.hypot(_local.x, _local.z);
      if (_local.z > 0.02) {
        const hAng = Math.atan2(_local.x, _local.z);
        const vAng = Math.atan2(_local.y, flat);
        // The vertical cone opens a little when they are close: you do look down at your own feet.
        const vHalf = V_HALF * (1 + 0.85 * clamp01(1 - state.distance / 2.6));
        if (Math.abs(hAng) < H_HALF && Math.abs(vAng) < vHalf) {
          const seen = trace(self.eye, _baby, self);
          if (seen > 0) {
            visible = true;
            const prox = clamp(1.95 - state.distance / 4.4, 0.22, 1.95);
            const centre = 0.32 + 0.68 * Math.pow(1 - Math.abs(hAng) / H_HALF, 1.3);
            const motion = 0.62 + 0.9 * clamp01(babySpeed / 1.1);
            const lit = 0.68 + 0.62 * state.light;
            const high = 0.32 + 0.95 * state.exposure;
            rate = 0.56 * prox * centre * motion * lit * high * state.cover * seen * focus * diff.see
              / Math.max(0.25, stealth);
          }
        }
      }
    }

    state.visible = visible;
    state.rate = rate;
    if (visible) {
      unseenFor = 0;
      state.detection = clamp01(state.detection + rate * dt);
      state.lastSeen.x = _baby.x;
      state.lastSeen.y = _baby.y;
      state.lastSeen.z = _baby.z;
      state.lastSeen.t = clock;
      state.lastSeen.valid = true;
      state.lastSeenSpeed = babySpeed;
      state.alertness = Math.max(state.alertness, Math.min(0.92, state.detection));
    } else {
      unseenFor += dt;
      // A grace period: half a second of cover is not an alibi.
      if (unseenFor > 0.45) state.detection = Math.max(0, state.detection - diff.fade * dt);
    }
    return visible;
  }

  const _rayFrom = new THREE.Vector3();
  const _rayTo = new THREE.Vector3();
  /** @returns 0 = fully occluded, 1 = clean line, in between = partial. */
  function trace(eye, target, self) {
    const phys = ctx.physics;
    if (!phys || !phys.raycast) return 1;
    let hits = 0;
    // The three samples are the crown, the shoulders, and a lateral offset — a baby half behind
    // the ottoman should read as "something moved", not as a clean sighting.
    _right.set(target.z - eye.z, 0, eye.x - target.x);
    if (_right.lengthSq() > 1e-6) _right.normalize();
    for (let i = 0; i < RAYS; i++) {
      _rayTo.copy(target);
      if (i === 1) _rayTo.y -= 0.13;
      if (i === 2) _rayTo.addScaledVector(_right, 0.11).y -= 0.05;
      _rayFrom.copy(eye);
      _dir.copy(_rayTo).sub(_rayFrom);
      const dist = _dir.length();
      if (dist < 1e-4) {
        hits++;
        continue;
      }
      _dir.multiplyScalar(1 / dist);
      const hit = phys.raycast(_rayFrom, _dir, dist + 0.02, { exclude: self.exclude || null });
      if (!hit) {
        hits++;
        continue;
      }
      // Hitting the baby counts as seeing them. Their character collider carries no object3d, so
      // match on the collider handle first and fall back to the scene graph and then to distance.
      let isBaby = false;
      const bc = ctx.baby && ctx.baby.character && ctx.baby.character.collider;
      if (bc && hit.record && hit.record.collider && hit.record.collider.handle === bc.handle) isBaby = true;
      if (!isBaby) {
        const babyGroup = ctx.baby && ctx.baby.group;
        let n = hit.object3d;
        while (n && !isBaby) {
          if (n === babyGroup) isBaby = true;
          n = n.parent;
        }
      }
      if (isBaby || hit.distance > dist - 0.18) hits++;
    }
    if (!hits) return 0;
    if (hits === RAYS) return 1;
    return 0.42 + 0.3 * (hits / RAYS);
  }

  // ── public ──────────────────────────────────────────────────────────────────────────────
  return {
    state,
    get alertness() { return state.alertness; },
    get detection() { return state.detection; },
    get visible() { return state.visible; },
    get babySpeed() { return babySpeed; },

    update(dt, self) {
      clock += dt;
      ear.copy(self.eye);
      pollSun();
      look(dt, self);
      // Alertness bleeds away faster once they have decided nothing is wrong.
      const decay = diff.alertDecay * (self.calm ? 2.1 : 1);
      state.alertness = Math.max(0, state.alertness - decay * dt);
      if (clock - state.startleAt > 0.8) state.startle = 0;
      return state;
    },

    /** The brain consumes a startle exactly once. */
    takeStartle() {
      const s = state.startle;
      state.startle = 0;
      return s;
    },

    heardAgeSeconds() { return clock - state.lastHeard.t; },
    seenAgeSeconds() { return clock - state.lastSeen.t; },
    get now() { return clock; },

    setStealth(k) { stealth = Number.isFinite(k) && k > 0 ? k : 1; },
    setFocus(k) { focus = Number.isFinite(k) ? clamp(k, 0.4, 3) : 1; },
    setDifficulty(i) { diff = DIFF[clamp(Math.round(i), 0, 2)]; },
    /** LIGHT publishes the real key direction; adopt it so "lit by the window" stays true at dusk. */
    setSunDirection(v) {
      if (v && Number.isFinite(v.x)) {
        sunDir.set(v.x, v.y, v.z);
        if (sunDir.lengthSq() > 1e-6) sunDir.normalize();
      }
    },

    reset() {
      state.alertness = 0;
      state.detection = 0;
      state.visible = false;
      state.startle = 0;
      state.startleAt = -99;
      state.lastSeen.valid = false;
      state.lastSeen.t = -99;
      state.lastHeard.t = -99;
      state.lastHeard.strength = 0;
      unseenFor = 99;
      babySpeed = 0;
      hasPrev = false;
      clock = 0;
      sunChecked = -1;
      sunPolled = -99;
      focus = 1;
    },

    dispose() {
      offNoise();
    },
  };
}
