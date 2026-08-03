// OPERATION NAPTIME — BABY — the procedural crawl. No keyframes anywhere in this file.
//
// THE CYCLE. A cross-pattern crawl: right hand and left knee advance together, then left hand and
// right knee. One cycle = one plant per limb = one stride of forward travel, so the gait frequency
// is simply speed/stride and the phase never needs resynchronising when the baby accelerates.
// Each limb is planted for DUTY of the cycle and swings for the rest.
//
// CONTACTS ARE WORLD-LOCKED. The single thing that separates a crawl from a sliding puppet is that
// a planted hand does not move. At the instant a limb lands we record its position in WORLD space
// and raycast for the floor under it, so a hand that lands on the rucked edge of the rug or on the
// play mat sits at that height; the IK then chases that fixed point while the body travels over it.
// During swing the target lerps toward a *predicted* landing — body position extrapolated to the
// moment of touchdown — so turning mid-stride re-aims the foot instead of stepping into a hole.
// The stance sweep is derived, not authored: a limb that plants 0.5·stride ahead and is carried
// 0.62·stride backward by the body ends 0.12·stride behind the hip, which is exactly right.
//
// SECONDARY MOTION IS SPRINGS, NOT NOISE. Every plant kicks a set of second-order springs: the
// body drops onto the loaded arm, the head arrives a beat late, the nappy squashes, the cheeks
// wobble. Sine waves would tick like a metronome; springs overshoot, settle, and respond to
// impacts, which is what makes the weight read.
//
// LAYERS. The gait produces a base pose; a small set of one-shot actions (sit-up, reach, headbutt
// lunge, face-plant recovery, delighted arm-flap) blend over the top with their own weights.

import * as THREE from 'three';
import { A, CONTACT } from './anatomy.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (t) => { const x = clamp01(t); return x * x * (3 - 2 * x); };
const frac = (v) => v - Math.floor(v);
const lerp = (a, b, t) => a + (b - a) * t;

// Duty and plant offset are per limb, and both are dictated by reach, not by taste. The bind arm
// is fully extended (shoulder 0.26 m above the palm, arm 0.26 m long), so the hand can only sweep a
// disc of about ±11 cm around the point below the shoulder — and the stance sweep is exactly the
// distance the body travels while the hand is down, i.e. duty × stride. Hands therefore hold the
// floor for half the cycle and knees for 58% of it, and each window is centred on the limb's rest
// point rather than thrown forward, which is what keeps the IK off its limit at speed.
const HAND_DUTY = 0.50;
const HAND_AHEAD = 0.25;
const KNEE_DUTY = 0.58;
const KNEE_AHEAD = 0.36;
const MIN_STRIDE = 0.240;
const MAX_STRIDE = 0.440;
const MAX_FREQ = 5.2;

/** Second-order spring. k = ω², d = 2ζω; sub-stepped so a 50 ms frame cannot blow it up. */
function spring(freq, zeta) {
  const w = freq * Math.PI * 2;
  return { x: 0, v: 0, target: 0, k: w * w, d: 2 * zeta * w };
}
function springStep(s, dt) {
  let left = dt;
  while (left > 1e-6) {
    const h = left > 1 / 140 ? 1 / 140 : left;
    s.v += (s.k * (s.target - s.x) - s.d * s.v) * h;
    s.x += s.v * h;
    left -= h;
  }
}

// Contact → IK target offsets, taken straight from the bind pose so the rest pose round-trips.
const WRIST_OFF = new THREE.Vector3(0, A.wristR[1] - CONTACT.handR[1], A.wristR[2] - CONTACT.handR[2]);
const ANKLE_OFF = new THREE.Vector3(0.002, A.ankleR[1] - CONTACT.kneeR[1], A.ankleR[2] - CONTACT.kneeR[2]);

// `back` pulls the hands' rest contact 3 cm in toward the shoulder. The sculpt plants them at full
// arm extension; a crawl needs a little elbow bend in hand to have anywhere to reach from.
const LIMB_DEFS = [
  { name: 'handR', kind: 'hand', side: 1, offset: 0.00, rest: CONTACT.handR, back: 0.030, duty: HAND_DUTY, ahead: HAND_AHEAD },
  { name: 'handL', kind: 'hand', side: -1, offset: 0.50, rest: CONTACT.handL, back: 0.030, duty: HAND_DUTY, ahead: HAND_AHEAD },
  { name: 'kneeR', kind: 'knee', side: 1, offset: 0.50, rest: CONTACT.kneeR, back: 0, duty: KNEE_DUTY, ahead: KNEE_AHEAD },
  { name: 'kneeL', kind: 'knee', side: -1, offset: 0.00, rest: CONTACT.kneeL, back: 0, duty: KNEE_DUTY, ahead: KNEE_AHEAD },
];

export function createGait(ctx, opts = {}) {
  const probe = opts.probe || (() => 0);
  const emit = opts.emit || (() => {});
  const rand = opts.rand || (() => 0.5);

  // --- the pose the rig consumes ------------------------------------------------------------
  const pose = {
    rootPos: new THREE.Vector3(),
    rootQuat: new THREE.Quaternion(),
    q: {
      spine1: new THREE.Quaternion(), spine2: new THREE.Quaternion(), neck: new THREE.Quaternion(),
      head: new THREE.Quaternion(), jaw: new THREE.Quaternion(),
      cheekR: new THREE.Quaternion(), cheekL: new THREE.Quaternion(),
      clavR: new THREE.Quaternion(), clavL: new THREE.Quaternion(),
      belly: new THREE.Quaternion(), nappy: new THREE.Quaternion(),
    },
    scale: {
      cheekR: new THREE.Vector3(1, 1, 1), cheekL: new THREE.Vector3(1, 1, 1),
      nappy: new THREE.Vector3(1, 1, 1), belly: new THREE.Vector3(1, 1, 1),
    },
    wrist: [new THREE.Vector3(), new THREE.Vector3()],
    handQ: [new THREE.Quaternion(), new THREE.Quaternion()],
    ankle: [new THREE.Vector3(), new THREE.Vector3()],
    footQ: [new THREE.Quaternion(), new THREE.Quaternion()],
    armPole: [new THREE.Vector3(), new THREE.Vector3()],
    legPole: [new THREE.Vector3(), new THREE.Vector3()],
    armStretch: [1, 1],
  };

  // --- limb contact state --------------------------------------------------------------------
  const limbs = LIMB_DEFS.map((def) => ({
    def,
    restModel: new THREE.Vector3(def.rest[0], def.rest[1], def.rest[2] + def.back),
    plant: new THREE.Vector3(),   // world, where it currently touches
    from: new THREE.Vector3(),    // world, where the swing started
    to: new THREE.Vector3(),      // world, predicted landing
    live: new THREE.Vector3(),    // world, this frame's contact
    s: 0,
    prevS: 0,
    swingT: 0,
    swinging: false,
    lift: 0,
  }));

  // --- springs --------------------------------------------------------------------------------
  const sp = {
    drop: spring(3.1, 0.42),      // body settles onto the loaded arm
    headY: spring(2.5, 0.40),     // head arrives a beat behind the body
    headPitch: spring(2.2, 0.52),
    headYaw: spring(2.6, 0.58),
    lean: spring(2.8, 0.55),      // lateral weight shift
    nappy: spring(4.2, 0.30),     // the nappy is heavy and it wobbles
    cheek: spring(6.5, 0.22),
    belly: spring(3.6, 0.34),
    turn: spring(2.4, 0.7),
  };

  // --- state ------------------------------------------------------------------------------------
  const st = {
    phase: 0,
    freq: 0,
    stride: MIN_STRIDE,
    speed: 0,
    speedN: 0,
    idle: 0,
    sit: 0,           // sit-up-on-knees weight
    duck: 0,
    reach: 0,
    reachWeight: 1,
    reachTarget: new THREE.Vector3(),
    reachActive: false,
    lungeT: 0, lungeDur: 0.42,
    plantT: 0,        // face-plant recovery
    flapT: 0,
    blinkT: 0,
    breathe: 0,
    bumpKick: 0,
    heading: 0,
    photoHeadYaw: 0,
    lastPlantLimb: 0,
  };

  // --- scratch ------------------------------------------------------------------------------------
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _v3 = new THREE.Vector3();
  const _e = new THREE.Euler(0, 0, 0, 'YXZ');
  const _q = new THREE.Quaternion();
  const _fwd = new THREE.Vector3();

  /** model → world for a contact point (the group is a Y rotation plus a translation). */
  function toWorld(model, pos, heading, out) {
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    return out.set(
      pos.x + model.x * c + model.z * s,
      pos.y + model.y,
      pos.z - model.x * s + model.z * c,
    );
  }
  function toModel(world, pos, heading, out) {
    const dx = world.x - pos.x;
    const dz = world.z - pos.z;
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    return out.set(dx * c - dz * s, world.y - pos.y, dx * s + dz * c);
  }

  /** Where limb `l` should land, given the body's predicted position at touchdown. */
  function landing(l, pos, heading, ahead, out) {
    _v.copy(l.restModel);
    _v.z -= ahead;
    toWorld(_v, pos, heading, out);
    out.y = probe(out.x, out.z, pos.y);
    return out;
  }

  /** Place every contact analytically for a steady crawl at `phase` — used by reset and photo mode. */
  function seedPlants(pos, heading, phase, stride) {
    st.phase = phase;
    st.stride = stride;
    for (let i = 0; i < limbs.length; i++) {
      const l = limbs[i];
      const duty = l.def.duty;
      const ahead = l.def.ahead;
      const s = frac(phase - l.def.offset);
      l.s = s;
      l.prevS = s;
      if (s < duty) {
        l.swinging = false;
        l.swingT = 0;
        _v.copy(l.restModel);
        _v.z += stride * s - stride * ahead;
        toWorld(_v, pos, heading, l.plant);
        l.plant.y = probe(l.plant.x, l.plant.z, pos.y);
        l.live.copy(l.plant);
        l.lift = 0;
      } else {
        l.swinging = true;
        _v.copy(l.restModel);
        _v.z += stride * duty - stride * ahead;
        toWorld(_v, pos, heading, l.from);
        l.from.y = probe(l.from.x, l.from.z, pos.y);
        landing(l, pos, heading, stride * ahead, l.to);
        const t = (s - duty) / (1 - duty);
        l.swingT = t;
        l.live.lerpVectors(l.from, l.to, smoothstep(t));
        l.lift = Math.sin(Math.PI * Math.pow(t, 0.85));
        l.live.y += l.lift * 0.05;
        l.plant.copy(l.from);
      }
    }
  }

  // --- events ------------------------------------------------------------------------------------

  function onPlant(l) {
    const heavy = l.def.kind === 'hand' ? 1 : 0.72;
    sp.drop.v -= 0.10 * heavy * (0.45 + st.speedN * 0.9);
    sp.nappy.v -= 0.9 * heavy;
    sp.headY.v -= 0.55 * heavy * (0.4 + st.speedN);
    sp.belly.v -= 0.9 * heavy;
    st.lastPlantLimb = LIMB_DEFS.indexOf(l.def);
    emit('plant', l);
  }

  function bump(force) {
    const f = clamp01(force / 9);
    sp.cheek.v -= 5.5 * f;
    sp.nappy.v -= 2.5 * f;
    sp.headPitch.v += 3.0 * f;
    sp.drop.v -= 0.16 * f;
    st.bumpKick = Math.max(st.bumpKick, f);
  }

  function lunge(duration) {
    st.lungeT = duration || 0.42;
    st.lungeDur = st.lungeT;
    st.sit = 0;
    sp.headPitch.v -= 5.0;
  }

  function faceplant() {
    if (st.plantT > 0) return;
    st.plantT = 1.15;
    sp.cheek.v -= 7;
    sp.nappy.v -= 3;
  }

  function flap() {
    if (st.flapT > 0.25) return;
    st.flapT = 1.25;
  }

  function reachAt(worldPoint, weight) {
    if (!worldPoint) {
      st.reachActive = false;
      return;
    }
    st.reachActive = true;
    st.reachTarget.set(worldPoint.x, worldPoint.y, worldPoint.z);
    st.reachWeight = clamp01(weight === undefined ? 1 : weight);
  }

  // --- the update --------------------------------------------------------------------------------

  function update(dt, s, snap) {
    const pos = s.pos;
    const heading = s.heading;
    st.heading = heading;
    _fwd.set(-Math.sin(heading), 0, -Math.cos(heading));

    const speed = s.speed;
    st.speed = speed;
    st.speedN = clamp01(speed / 2.0);
    st.duck += (clamp01(s.duck) - st.duck) * clamp01(dt * 8);

    // Stride and cadence. Turning in place still steps: a pivoting baby shuffles its hands round.
    const turnRate = Math.abs(s.angVel);
    const effective = Math.max(speed, turnRate * 0.24);
    st.stride = clamp(MIN_STRIDE + 0.155 * st.speedN + (s.sprint || 0) * 0.035, MIN_STRIDE, MAX_STRIDE);
    st.freq = clamp(effective / st.stride, 0, MAX_FREQ);
    if (effective < 0.045) {
      st.freq = 0;
      st.idle += dt;
    } else {
      st.idle = 0;
    }

    if (st.freq > 0) st.phase = frac(st.phase + st.freq * dt);
    st.breathe += dt * (0.85 + st.speedN * 1.8);

    // --- contacts ---------------------------------------------------------------------------
    for (let i = 0; i < limbs.length; i++) {
      const l = limbs[i];
      const duty = l.def.duty;
      const ahead = l.def.ahead;
      const swingTime = st.freq > 0.01 ? (1 - duty) / st.freq : 0.4;
      l.prevS = l.s;
      l.s = frac(st.phase - l.def.offset);
      const wrapped = l.s < l.prevS;

      if (st.freq <= 0) {
        // Standing still: contacts hold. But a baby pivoting on the spot shuffles its hands round,
        // so once a contact has drifted too far from where the body now wants it, step it across.
        if (!l.swinging) {
          toModel(l.plant, pos, heading, _v);
          _v.y = 0;
          if (_v.distanceTo(l.restModel) > 0.105) {
            l.swinging = true;
            l.swingT = 0;
            l.from.copy(l.plant);
          }
        }
        if (l.swinging) {
          l.swingT = Math.min(1, l.swingT + dt * 2.6);
          landing(l, pos, heading, 0.02, l.to);
          const t = l.swingT;
          l.live.lerpVectors(l.from, l.to, smoothstep(t));
          l.lift = Math.sin(Math.PI * Math.pow(t, 0.85));
          l.live.y += l.lift * 0.034;
          if (t >= 1) {
            l.swinging = false;
            l.plant.copy(l.to);
            l.live.copy(l.plant);
            l.lift = 0;
            onPlant(l);
          }
        } else {
          l.live.copy(l.plant);
          l.lift = 0;
        }
        continue;
      }

      if (wrapped && l.swinging) {
        l.swinging = false;
        l.plant.copy(l.to);
        l.live.copy(l.plant);
        l.lift = 0;
        onPlant(l);
      }

      if (l.s < duty) {
        l.swinging = false;
        l.live.copy(l.plant);
        l.lift = 0;
      } else {
        if (!l.swinging) {
          l.swinging = true;
          l.from.copy(l.plant);
        }
        const t = (l.s - duty) / (1 - duty);
        l.swingT = t;
        // Predict where the body will be when this limb lands and aim there.
        _v3.copy(pos).addScaledVector(_fwd, speed * swingTime * (1 - t) * 0.92);
        landing(l, _v3, heading + s.angVel * swingTime * (1 - t) * 0.5, st.stride * ahead, l.to);
        // Ease out with a little overshoot: a baby's hand slaps down, it does not glide down.
        const e = t < 0.82 ? smoothstep(t / 0.82) * 1.045 : 1.045 - 0.045 * smoothstep((t - 0.82) / 0.18);
        l.live.lerpVectors(l.from, l.to, e);
        l.lift = Math.sin(Math.PI * Math.pow(t, 0.86));
        const h = (l.def.kind === 'hand' ? 0.052 : 0.036) * (0.55 + st.speedN * 0.9) * (1 - st.duck * 0.55);
        l.live.y += l.lift * h;
      }
    }

    // --- springs ------------------------------------------------------------------------------
    const cyc = st.phase * Math.PI * 2;
    const ampN = (0.25 + 0.75 * st.speedN) * (st.freq > 0.01 ? 1 : 0);
    sp.drop.target = -0.004 - st.speedN * 0.010 - st.duck * 0.075;
    sp.nappy.target = 0;
    sp.cheek.target = 0;
    sp.belly.target = 0;
    // A lagged copy of the weight shift: the mass arrives over the planted hand after the hand does.
    sp.lean.target = Math.cos(cyc) * 0.042 * ampN;
    sp.turn.target = clamp(s.angVel * 0.16, -0.30, 0.30);
    sp.headYaw.target = clamp(s.lookYaw, -0.95, 0.95) * 0.62;
    sp.headPitch.target = clamp(s.lookPitch, -0.75, 0.75) * 0.55 + st.duck * 0.25;
    sp.headY.target = 0;
    // Photo mode snaps rather than integrates: identical pixels on every run of the harness.
    if (snap) {
      for (const k in sp) { sp[k].x = sp[k].target; sp[k].v = 0; }
    } else {
      for (const k in sp) springStep(sp[k], dt);
    }
    st.bumpKick *= Math.exp(-dt * 3.2);

    // --- one-shot layers -----------------------------------------------------------------------
    if (st.lungeT > 0) st.lungeT = Math.max(0, st.lungeT - dt);
    if (st.plantT > 0) st.plantT = Math.max(0, st.plantT - dt);
    if (st.flapT > 0) st.flapT = Math.max(0, st.flapT - dt);
    // Sit up on the knees when nothing has happened for a while; drop instantly when it does.
    // …but never sit up under the coffee table, which is the one place it would look like a bug.
    const wantSit = st.idle > 3.4 && st.plantT <= 0 && st.lungeT <= 0 && st.duck < 0.2 ? 1 : 0;
    st.sit += (wantSit - st.sit) * clamp01(dt * (wantSit ? 1.6 : 9));
    if (st.flapT > 0) st.sit = Math.max(st.sit, clamp01(st.flapT * 2.2));
    const wantReach = st.reachActive ? (st.reachWeight === undefined ? 1 : st.reachWeight) : 0;
    st.reach += (wantReach - st.reach) * clamp01(dt * (wantReach ? 5.5 : 4));

    buildPose(dt, s, pos, heading);
  }

  // --- pose assembly ---------------------------------------------------------------------------

  function buildPose(dt, s, pos, heading) {
    const ph = st.phase * Math.PI * 2;
    const moving = st.freq > 0.01 ? 1 : 0;
    const amp = (0.25 + 0.75 * st.speedN) * moving;
    const sit = st.sit;
    const lungeK = st.lungeT > 0 ? Math.sin(Math.PI * clamp01(1 - st.lungeT / st.lungeDur)) : 0;
    const plantK = st.plantT > 0 ? clamp01(st.plantT / 1.15) : 0;
    const flapK = st.flapT > 0 ? clamp01(st.flapT / 1.25) : 0;
    const breath = Math.sin(st.breathe * 1.9) * 0.0022 + Math.sin(st.breathe * 0.63) * 0.0016;

    // --- root ---------------------------------------------------------------------------------
    // Idle is not stillness: a baby propped on all fours rocks, gently and constantly.
    const idleRock = (1 - moving) * (1 - sit * 0.45);
    const sway = Math.sin(ph) * (0.011 + 0.010 * st.speedN) * amp
      + Math.sin(st.breathe * 0.9) * 0.007 * idleRock;
    const roll = -Math.cos(ph) * (0.055 + 0.075 * st.speedN) * amp - sp.lean.x
      + Math.sin(st.breathe * 0.72 + 1.2) * 0.035 * idleRock;
    const hipYaw = Math.sin(ph - 0.62) * (0.075 + 0.075 * st.speedN) * amp;
    // Forward lean grows with speed, but only so far: the contract's 0.42 m eye height is the
    // whole scale illusion, and every radian of torso pitch costs it 2.8 cm.
    const bodyPitch = -(0.030 + 0.090 * st.speedN) * amp - st.duck * 0.16
      + sit * 0.30 + lungeK * 0.28 - plantK * 0.36;

    pose.rootPos.set(
      sway + sp.turn.x * 0.02,
      sp.drop.x + breath + sit * 0.055 - plantK * 0.075 + lungeK * 0.012,
      -lungeK * 0.045 + plantK * 0.03 + st.duck * 0.02,
    );
    _e.set(bodyPitch, hipYaw, roll + sp.turn.x * 0.55);
    pose.rootQuat.setFromEuler(_e);

    // --- spine: counter-rotation, so the shoulders lead and the hips follow ---------------------
    _e.set(-0.020 - st.duck * 0.06 + sit * 0.10 - plantK * 0.10, -hipYaw * 0.7, -roll * 0.35);
    pose.q.spine1.setFromEuler(_e);
    _e.set(0.030 + st.speedN * 0.03 + lungeK * 0.10 - sit * 0.16 - plantK * 0.12, -hipYaw * 0.8 + sp.turn.x * 0.2, -roll * 0.30);
    pose.q.spine2.setFromEuler(_e);

    // --- head: lags the body, then looks where the player looks ---------------------------------
    const headBob = -sp.headY.x;
    const neckPitch = 0.20 + sp.headPitch.x * 0.42 + headBob * 0.5 + lungeK * 0.22 - plantK * 0.40 + sit * 0.06;
    _e.set(neckPitch * 0.42, sp.headYaw.x * 0.42, -roll * 0.25 - sp.turn.x * 0.3);
    pose.q.neck.setFromEuler(_e);
    const headPitch = 0.22 + sp.headPitch.x * 0.58 + headBob + Math.sin(ph * 2 + 1.1) * 0.020 * amp
      + lungeK * 0.16 - plantK * 0.30 + sit * 0.10;
    _e.set(headPitch * 0.58, sp.headYaw.x * 0.58 + st.photoHeadYaw, -roll * 0.20 + Math.sin(ph + 0.9) * 0.03 * amp);
    pose.q.head.setFromEuler(_e);

    // Mouth open when crawling fast, when eating, and while flapping in delight.
    const jaw = 0.05 + 0.16 * st.speedN * moving + flapK * 0.25 + (s.mouth || 0) * 0.45
      + st.bumpKick * 0.28;
    _e.set(-jaw, 0, 0);
    pose.q.jaw.setFromEuler(_e);

    // --- soft tissue --------------------------------------------------------------------------
    // Gains are set so a spring at its impulse amplitude moves the actual surface a few
    // millimetres: the cheek bone only owns ~54% of a cheek vertex, so a 5% squash is 1 mm of
    // real motion. Under-driving these is the difference between jiggle and nothing at all.
    const cheek = sp.cheek.x;
    pose.scale.cheekR.set(1 + cheek * 0.45, 1 - cheek * 0.30, 1 + cheek * 0.28);
    pose.scale.cheekL.set(1 - cheek * 0.40, 1 + cheek * 0.28, 1 - cheek * 0.26);
    _e.set(cheek * 0.55, 0, cheek * 0.30);
    pose.q.cheekR.setFromEuler(_e);
    _e.set(-cheek * 0.48, 0, -cheek * 0.26);
    pose.q.cheekL.setFromEuler(_e);

    const nap = sp.nappy.x;
    pose.scale.nappy.set(1 - nap * 0.45, 1 + nap * 0.65, 1 - nap * 0.38);
    _e.set(nap * 0.55, hipYaw * 0.35, roll * 0.25);
    pose.q.nappy.setFromEuler(_e);

    const bel = sp.belly.x;
    pose.scale.belly.set(1 - bel * 0.42, 1 + bel * 0.55, 1 - bel * 0.45);
    _e.set(bel * 0.30 + breath * 6, 0, 0);
    pose.q.belly.setFromEuler(_e);

    // --- shoulders ---------------------------------------------------------------------------------
    for (let i = 0; i < 2; i++) {
      const l = limbs[i];
      const lift = l.lift;
      const sgn = i === 0 ? 1 : -1;
      _e.set(-lift * 0.12 - sit * 0.10, sgn * (hipYaw * -0.35 + lift * 0.10), sgn * (-0.05 - lift * 0.16 - sit * 0.12));
      pose.q[i === 0 ? 'clavR' : 'clavL'].setFromEuler(_e);
    }

    // --- limb targets ---------------------------------------------------------------------------------
    for (let i = 0; i < 4; i++) {
      const l = limbs[i];
      const isHand = i < 2;
      const idx = isHand ? i : i - 2;
      const sgn = l.def.side;
      toModel(l.live, pos, heading, _v);

      if (isHand) {
        // Hand orientation: palm flat when planted, fingers hanging as it swings through. The
        // planted values stay near identity on purpose — that is the bind pose, and any offset
        // there would drag the whole arm off the authored crawl.
        const t = l.lift;
        _e.set(
          -0.02 + t * 0.62 + lungeK * 0.30 - plantK * 0.45 + sit * 0.55,
          sgn * (-0.06 - t * 0.22) + sp.turn.x * 0.2,
          sgn * (0.08 + t * 0.30 + sit * 0.35),
        );
        pose.handQ[idx].setFromEuler(_e);
        _v2.copy(WRIST_OFF).applyQuaternion(pose.handQ[idx]);
        pose.wrist[idx].copy(_v).add(_v2);
        pose.armPole[idx].set(sgn * (0.10 + t * 0.10), 0.05 * t, -0.04);
        pose.armStretch[idx] = 1;
      } else {
        const t = l.lift;
        _e.set(-0.02 - t * 0.30, sgn * (0.04 + t * 0.16), sgn * 0.06);
        pose.footQ[idx].setFromEuler(_e);
        _v2.set(ANKLE_OFF.x * sgn, ANKLE_OFF.y, ANKLE_OFF.z).applyQuaternion(pose.footQ[idx]);
        pose.ankle[idx].copy(_v).add(_v2);
        pose.legPole[idx].set(sgn * (0.06 + t * 0.12), -0.05 * t, 0);
      }
    }

    // --- layer: sit up on the knees ---------------------------------------------------------------
    if (sit > 0.001) {
      for (let i = 0; i < 2; i++) {
        const sgn = i === 0 ? 1 : -1;
        // Hands come off the floor to chest height, palms curled inward.
        _v.set(sgn * 0.115, 0.235 + Math.sin(st.breathe * 2.3 + i) * 0.008, -0.150);
        if (flapK > 0.001) {
          const f = Math.sin(st.flapT * 34 + i * Math.PI) * flapK;
          _v.y += 0.055 * f + 0.05 * flapK;
          _v.x += sgn * 0.035 * flapK;
          _v.z -= 0.03 * f;
        }
        pose.wrist[i].lerp(_v, sit);
        _e.set(-0.55 * sit + flapK * 0.4, sgn * -0.35 * sit, sgn * (0.55 * sit));
        _q.setFromEuler(_e);
        pose.handQ[i].slerp(_q, sit);
        pose.armPole[i].x += sgn * 0.25 * sit;
      }
    }

    // --- layer: reach for whatever is about to be ruined --------------------------------------------
    if (st.reach > 0.002) {
      toModel(st.reachTarget, pos, heading, _v);
      // Only the near hand reaches, and only forward of the shoulder.
      const hand = _v.x >= 0 ? 0 : 1;
      const sgn = hand === 0 ? 1 : -1;
      _v.x = clamp(_v.x, -0.22, 0.22);
      _v.y = clamp(_v.y, 0.02, 0.34);
      _v.z = clamp(_v.z, -0.36, -0.05);
      // Wobble: a ten-month-old cannot hold a hand still.
      const w = st.reach * 0.010;
      _v.x += Math.sin(st.breathe * 7.3) * w;
      _v.y += Math.sin(st.breathe * 5.1 + 1.7) * w * 1.4;
      // Keep the target inside the arm: an unreachable one only makes the IK clamp, and a clamped
      // arm reads as a stiff arm. A baby who cannot reach stretches toward it instead.
      _v2.set(sgn * 0.076, 0.300 + pose.rootPos.y, -0.086);
      _v.sub(_v2);
      const reachLen = _v.length();
      if (reachLen > 0.245) _v.multiplyScalar(0.245 / reachLen);
      _v.add(_v2);
      const k = st.reach * l4Weight(limbs[hand]);
      pose.wrist[hand].lerp(_v, k);
      _e.set(-0.35, sgn * -0.25, sgn * 0.30);
      _q.setFromEuler(_e);
      pose.handQ[hand].slerp(_q, k * 0.8);
      pose.armStretch[hand] = 1 + 0.045 * k;
    }

    // --- layer: headbutt lunge -----------------------------------------------------------------------
    if (lungeK > 0.001) {
      for (let i = 0; i < 2; i++) {
        _v.copy(pose.wrist[i]);
        _v.z += 0.055 * lungeK;
        _v.y += 0.02 * lungeK;
        pose.wrist[i].lerp(_v, 0.9);
      }
    }

    // --- layer: face-plant, and the indignant push back up --------------------------------------------
    if (plantK > 0.001) {
      const rec = 1 - plantK; // 0 at impact, 1 back upright
      for (let i = 0; i < 2; i++) {
        const sgn = i === 0 ? 1 : -1;
        _v.set(sgn * (0.145 - rec * 0.03), 0.005 + rec * 0.02, -0.245 + rec * 0.06);
        pose.wrist[i].lerp(_v, plantK * 0.9);
        _e.set(-0.30 + rec * 0.2, sgn * -0.30, sgn * 0.42);
        _q.setFromEuler(_e);
        pose.handQ[i].slerp(_q, plantK * 0.9);
      }
    }
  }

  /** A swinging hand should not be yanked out of its arc by a reach; a planted one may leave. */
  function l4Weight(l) {
    return l.swinging ? 0.35 : 1;
  }

  // --- public ------------------------------------------------------------------------------------

  function reset(pos, heading) {
    st.phase = 0.18;
    st.speed = 0;
    st.speedN = 0;
    st.idle = 0;
    st.sit = 0;
    st.reach = 0;
    st.reachActive = false;
    st.lungeT = 0;
    st.plantT = 0;
    st.flapT = 0;
    st.breathe = 0;
    st.duck = 0;
    for (const k in sp) { sp[k].x = 0; sp[k].v = 0; sp[k].target = 0; }
    seedPlants(pos, heading, 0.18, MIN_STRIDE + 0.02);
  }

  return {
    pose,
    limbs,
    state: st,
    springs: sp,
    update,
    reset,
    seedPlants,
    bump,
    lunge,
    faceplant,
    flap,
    reachAt,
    buildPose,
    get phase() { return st.phase; },
    get stride() { return st.stride; },
    get frequency() { return st.freq; },
    /** 0 → right hand planting, 0.5 → left. camera.js syncs its bob to this. */
    limbLift(i) { return limbs[i].lift; },
    setPhotoHeadYaw(v) { st.photoHeadYaw = v; },
  };
}
