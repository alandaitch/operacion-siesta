// AI · procedural locomotion. No keyframes, no clips, no blend trees — every pose in the game is
// solved from scalars, which is the only way a walk can be correct at 0.9, 1.5 and 2.2 m/s and at
// every speed in between without an animator.
//
// The load-bearing ideas:
//
//  · FOOT PLANT FIRST. The gait is authored as the trajectory of the two ankles in the character's
//    own frame, and the legs are then solved with two-bone IK. Stride length L is a function of
//    speed and the cycle frequency is f = v / L, so during stance the ankle travels backward at
//    exactly v and the feet never skate. Knees, hips and pelvis height fall out of the IK for free.
//  · THE IK NEEDS NO PER-LIMB CORRECTIONS. Every bone was authored from a rest basis whose +Y aims
//    at its child and whose +X is the hinge, so the solver can hand back `basisQuat(limbDir, hinge)`
//    directly. dir1 = aim·cosα + perp·sinα, where perp is the component of the pole vector
//    orthogonal to the aim — that is a rotation of the aim *toward the knee* by the triangle's
//    root angle, and it is the whole solver.
//  · WEIGHT, NOT SYMMETRY. Pelvis bob at twice the step frequency (highest at mid-stance, lowest
//    at double support), lateral sway toward the stance foot, a pelvic list that drops the
//    swing-side hip, a chest that counter-rotates against the pelvis. Remove those four and you
//    have a mannequin sliding along a rail.
//  · The head leads the turn. People look where they are going about a quarter of a second before
//    their shoulders get there, and that anticipation is most of what makes an NPC read as having
//    intent rather than a destination.

import * as THREE from 'three';
import { basisQuat } from './body.js';

// solver scratch — never touched by pose()
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _f = new THREE.Vector3();

const IDENT = new THREE.Quaternion();
const AX_X = new THREE.Vector3(1, 0, 0);
const AX_Y = new THREE.Vector3(0, 1, 0);
const AX_Z = new THREE.Vector3(0, 0, 1);
const DOWN = new THREE.Vector3(0, -1, 0);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (t) => t * t * (3 - 2 * t);
const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = THREE.MathUtils.lerp;
const damp = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));

/** Two-bone IK, all vectors in the character's own (group) frame. */
export function solveTwoBone(A, T, L1, L2, pole, outQ1, outQ2, outKnee) {
  _a.copy(T).sub(A);
  let len = _a.length();
  if (len < 1e-6) {
    _a.copy(DOWN);
    len = 1e-6;
  }
  const n = _a.multiplyScalar(1 / len);
  len = clamp(len, Math.abs(L1 - L2) + 1e-3, (L1 + L2) * 0.9975);

  const alpha = Math.acos(clamp((L1 * L1 + len * len - L2 * L2) / (2 * L1 * len), -1, 1));

  _b.copy(pole).addScaledVector(n, -pole.dot(n));
  if (_b.lengthSq() < 1e-9) {
    _b.set(0, 0, 1).addScaledVector(n, -n.z);
    if (_b.lengthSq() < 1e-9) _b.set(1, 0, 0).addScaledVector(n, -n.x);
  }
  _b.normalize();

  _c.copy(n).multiplyScalar(Math.cos(alpha)).addScaledVector(_b, Math.sin(alpha)).normalize();
  _d.crossVectors(_b, n).normalize(); // the hinge axis
  basisQuat(_c, _d, outQ1);

  _e.copy(A).addScaledVector(_c, L1);
  if (outKnee) outKnee.copy(_e);
  _f.copy(A).addScaledVector(n, len).sub(_e);
  if (_f.lengthSq() < 1e-10) _f.copy(_c);
  basisQuat(_f.normalize(), _d, outQ2);
  return alpha;
}

export function createAnimator(body, ctx) {
  const { bones, byName, dims, rest } = body;
  const bone = (n) => bones[byName.get(n)];

  const hips = bone('hips');
  const spine = bone('spine');
  const chest = bone('chest');
  const neck = bone('neck');
  const head = bone('head');
  const lid = { L: bone('lidL'), R: bone('lidR') };
  const hipsRest = new THREE.Vector3(0, dims.hipY, 0);

  const leg = {};
  const arm = {};
  for (const s of ['L', 'R']) {
    const rl = rest.legs[s];
    leg[s] = {
      thigh: bone(`thigh${s}`),
      shin: bone(`shin${s}`),
      foot: bone(`foot${s}`),
      toe: bone(`toe${s}`),
      side: s === 'L' ? 1 : -1,
      hipLocal: rl.hip.clone().sub(hipsRest),
      restAim: rl.ball.clone().sub(rl.ankle).normalize(),
      L1: rl.hip.distanceTo(rl.knee),
      L2: rl.knee.distanceTo(rl.ankle),
      ankleY: rl.ankle.y,
    };
    const ra = rest.arms[s];
    arm[s] = {
      clav: bone(`clav${s}`),
      upper: bone(`arm${s}`),
      fore: bone(`fore${s}`),
      hand: bone(`hand${s}`),
      side: s === 'L' ? 1 : -1,
      L1: ra.shoulder.distanceTo(ra.elbow),
      L2: ra.elbow.distanceTo(ra.wrist),
      digits: ['index', 'middle', 'ring', 'little', 'thumb'].map((k, i) => ({
        key: k,
        order: i,
        bones: [bone(`${k}0${s}`), bone(`${k}1${s}`), bone(`${k}2${s}`)],
      })),
    };
  }

  // Rest local quaternions. The animator only ever composes offsets on top of these, so the
  // hand-authored relaxed curl of the fingers and the splay of the clavicles survive every pose.
  for (const b of bones) if (!b.userData.restLocal) b.userData.restLocal = b.quaternion.clone();

  const state = {
    phase: 0.02,
    prevPhase: 0.02,
    strideLen: 0.95,
    speedSmooth: 0,
    turnSmooth: 0,
    lookYaw: 0,
    lookPitch: 0,
    idleT: 0,
    breath: 0,
    blink: 0,
    blinkTimer: 1.5,
    crouch: 0,
    lean: 0,
    handClose: [0.12, 0.12],
    footfall: null,
  };

  const rnd = ctx.makeRng ? ctx.makeRng(0x1eaf17) : () => 0.5;
  const noise = [];
  for (let i = 0; i < 6; i++) noise.push({ f: 0.11 + rnd() * 0.5, p: rnd() * 6.283, a: 0.4 + rnd() * 0.6 });
  const wob = (t, i) => Math.sin(t * noise[i].f * 6.283 + noise[i].p) * noise[i].a;

  // pose scratch — disjoint from the solver's
  const hipW = new THREE.Vector3();
  const ankleT = new THREE.Vector3();
  const parkT = new THREE.Vector3();
  const pole = new THREE.Vector3();
  const vDir = new THREE.Vector3();
  const vFore = new THREE.Vector3();
  const vHinge = new THREE.Vector3();
  const vAxis = new THREE.Vector3();
  const spinePos = new THREE.Vector3();
  const chestPos = new THREE.Vector3();
  const clavPos = new THREE.Vector3();
  const shoulderPos = new THREE.Vector3();
  const localTarget = new THREE.Vector3();
  const headPivot = new THREE.Vector3();
  const qA = new THREE.Quaternion();
  const qB = new THREE.Quaternion();
  const hipsQ = new THREE.Quaternion();
  const spineQ = new THREE.Quaternion();
  const chestQ = new THREE.Quaternion();
  const clavQ = new THREE.Quaternion();
  const armQ = new THREE.Quaternion();
  const foreQ = new THREE.Quaternion();
  const invGroupQ = new THREE.Quaternion();
  const tq1 = new THREE.Quaternion();
  const tq2 = new THREE.Quaternion();
  const tq3 = new THREE.Quaternion();
  const gaze = new THREE.Quaternion();

  const strideFor = (v) => clamp(0.62 + 0.42 * v, 0.55, 1.62);
  const DUTY = (v) => clamp(0.64 - 0.045 * v, 0.52, 0.66);

  /**
   * Advance the gait clock. Driven from fixedUpdate so the cadence is frame-rate independent and
   * every footfall event lands on the same simulated frame in every run.
   * @returns 'L' | 'R' | null — a heel strike this step, for AUDIO
   */
  function advance(dt, speed) {
    state.speedSmooth = damp(state.speedSmooth, speed, 7, dt);
    const v = state.speedSmooth;
    state.strideLen = strideFor(Math.max(v, 0.25));
    state.prevPhase = state.phase;
    if (v > 0.06) {
      state.phase = (state.phase + (v / state.strideLen) * dt) % 1;
    } else {
      // ease the cycle to a halt with the feet under the body rather than freezing mid-swing
      const target = state.phase < 0.25 || state.phase > 0.75 ? 1 : 0.5;
      state.phase += (target - state.phase) * Math.min(1, dt * 4.5);
      if (state.phase >= 1) state.phase -= 1;
    }
    let fall = null;
    const a = state.prevPhase;
    const b = state.phase;
    const wrapped = b < a;
    if (v > 0.3) {
      if (wrapped) fall = 'L';
      else if (a < 0.5 && b >= 0.5) fall = 'R';
    }
    state.footfall = fall;
    return fall;
  }

  /** Ankle position (character frame) + ankle pitch for one leg at gait phase p. */
  function footTrack(side, key, p, v, out) {
    const D = DUTY(v);
    const half = state.strideLen * D * 0.5;
    const lift = 0.048 + 0.052 * clamp(v / 2.2, 0, 1.2);
    const lat = side * (dims.hipHalf - 0.016);
    let y = leg[key].ankleY;
    let z;
    let pitch;
    if (p < D) {
      const u = p / D;
      z = half - u * half * 2;
      pitch = u < 0.16
        ? lerp(0.24, -0.02, smooth(u / 0.16))
        : lerp(-0.02, -0.46, smooth(clamp((u - 0.16) / 0.84, 0, 1)) ** 1.25);
      if (u > 0.7) {
        const k = smooth((u - 0.7) / 0.3);
        y += 0.082 * k * k;   // the heel comes up over the ball
        z -= 0.020 * k;
      }
      if (u < 0.08) y += 0.010 * (1 - u / 0.08); // heel strike lands slightly proud
    } else {
      const u = (p - D) / (1 - D);
      const su = smoother(u);
      z = -half + half * 2 * (su * 1.04 - 0.04 * su * su);
      y += lift * Math.sin(Math.PI * clamp(u, 0, 1) ** 0.82) ** 1.15;
      pitch = u < 0.3
        ? lerp(-0.46, 0.06, smooth(u / 0.3))
        : lerp(0.06, 0.26, smooth((u - 0.3) / 0.7));
      // the swing foot passes closer to the midline than the stance foot
      out.x = lat - side * Math.sin(Math.PI * u) * 0.018;
      out.y = y;
      out.z = z;
      return pitch;
    }
    out.set(lat, y, z);
    return pitch;
  }

  /**
   * Pose the whole skeleton for one visual frame.
   * @param s { speed, turnRate, crouch, lean, armMode, reachL, reachR, handClose, lookAt,
   *           lookWeight, frozen, blink, hipsBias }
   */
  function pose(dt, s) {
    const v = state.speedSmooth;
    const gait = clamp((v - 0.05) / 0.45, 0, 1);
    const p = state.phase;
    const TAU = Math.PI * 2;
    const frozen = !!s.frozen;
    const step = frozen ? 0 : dt;

    state.idleT += step;
    state.breath += step * (0.32 + 0.55 * clamp(v / 2.2, 0, 1));
    state.crouch = damp(state.crouch, s.crouch || 0, 9, dt);
    state.lean = damp(state.lean, s.lean || 0, 6, dt);
    state.turnSmooth = damp(state.turnSmooth, s.turnRate || 0, 8, dt);
    const crouch = state.crouch;
    const t = state.idleT;
    const speedK = clamp(v / 2.2, 0, 1);

    invGroupQ.copy(body.group.quaternion).invert();
    const toLocal = (w, out) => out.copy(w).sub(body.group.position).applyQuaternion(invGroupQ);

    // ── pelvis ───────────────────────────────────────────────────────────────────────
    const bob = -0.019 * Math.cos(TAU * 2 * p) * gait;
    const sway = 0.028 * Math.sin(TAU * p) * gait;
    const list = 0.058 * Math.sin(TAU * p) * gait;
    const pelvisYaw = 0.105 * Math.sin(TAU * p) * gait;
    const idleShift = frozen ? 0 : (wob(t, 0) * 0.010 + wob(t * 0.37, 1) * 0.006) * (1 - gait);
    const idleBob = frozen ? 0 : Math.sin(state.breath * 2) * 0.0035 * (1 - gait * 0.7);

    hips.position.set(
      sway + idleShift + (s.hipsBias ? s.hipsBias.x : 0),
      dims.hipY + bob + idleBob - crouch * 0.315 - 0.012 * gait + (s.hipsBias ? s.hipsBias.y : 0),
      -0.085 * crouch + 0.018 * state.lean + (s.hipsBias ? s.hipsBias.z : 0),
    );
    tq1.setFromAxisAngle(AX_Y, pelvisYaw);
    tq2.setFromAxisAngle(AX_Z, list);
    tq3.setFromAxisAngle(AX_X, 0.10 * crouch + 0.035 * gait * speedK);
    hips.quaternion.copy(tq1).multiply(tq2).multiply(tq3);
    hipsQ.copy(hips.quaternion);

    // ── spine + chest ────────────────────────────────────────────────────────────────
    const chestYaw = -0.55 * pelvisYaw + 0.05 * state.turnSmooth;
    const leanPitch = state.lean + crouch * 0.62 + 0.055 * speedK ** 1.5
      + (frozen ? 0 : Math.sin(state.breath * 2) * 0.006);
    tq1.setFromAxisAngle(AX_X, leanPitch * 0.42);
    tq2.setFromAxisAngle(AX_Y, chestYaw * 0.35);
    tq3.setFromAxisAngle(AX_Z, -list * 0.28);
    spine.quaternion.copy(tq1).multiply(tq2).multiply(tq3);
    spineQ.copy(hipsQ).multiply(spine.quaternion);
    spinePos.copy(spine.position).applyQuaternion(hipsQ).add(hips.position);

    tq1.setFromAxisAngle(AX_X, leanPitch * 0.58 - 0.02);
    tq2.setFromAxisAngle(AX_Y, chestYaw * 0.65);
    tq3.setFromAxisAngle(AX_Z, -list * 0.34 + (frozen ? 0 : wob(t, 2) * 0.006));
    chest.quaternion.copy(tq1).multiply(tq2).multiply(tq3);
    chestQ.copy(spineQ).multiply(chest.quaternion);
    chestPos.copy(chest.position).applyQuaternion(spineQ).add(spinePos);
    const breathK = 1 + (frozen ? 0 : Math.sin(state.breath * 2) * 0.006);
    chest.scale.set(breathK, 1, breathK);

    // ── legs ─────────────────────────────────────────────────────────────────────────
    for (const key of ['L', 'R']) {
      const lg = leg[key];
      const side = lg.side;
      const ph = key === 'L' ? p : (p + 0.5) % 1;
      const pitch = footTrack(side, key, ph, v, ankleT);

      if (gait < 1) {
        // standing: park the feet with a natural stagger, not at parade rest
        parkT.set(side * (dims.hipHalf - 0.010), lg.ankleY, side > 0 ? 0.030 : -0.028);
        ankleT.lerp(parkT, 1 - gait);
      }
      if (crouch > 0.001) {
        ankleT.x += side * 0.055 * crouch;
        ankleT.z += 0.030 * crouch;
      }

      hipW.copy(lg.hipLocal).applyQuaternion(hipsQ).add(hips.position);
      // the knee leads forward and slightly outward; the outward term is what stops the legs
      // solving into a knock-kneed X whenever the pelvis lists
      pole.set(side * (0.20 + 0.35 * crouch), 0.12, 1).normalize();
      solveTwoBone(hipW, ankleT, lg.L1, lg.L2, pole, qA, qB);
      lg.thigh.quaternion.copy(hipsQ).invert().multiply(qA);
      lg.shin.quaternion.copy(qA).invert().multiply(qB);

      // the ankle is driven in character space so the sole stays parallel to the floor
      const splay = side * (0.105 + 0.05 * crouch);
      vDir.copy(lg.restAim).applyAxisAngle(AX_Y, splay);
      vHinge.copy(AX_X).applyAxisAngle(AX_Y, splay);
      vDir.applyAxisAngle(vHinge, pitch * gait + (1 - gait) * 0.02 - crouch * 0.20);
      basisQuat(vDir, vHinge, tq1);
      lg.foot.quaternion.copy(qB).invert().multiply(tq1);

      const D = DUTY(v);
      const toeBend = ph < D && ph > 0.68 * D
        ? -0.55 * smooth((ph - 0.68 * D) / (D * 0.32)) * gait
        : 0.03 * gait;
      tq1.setFromAxisAngle(AX_X, toeBend - crouch * 0.25);
      lg.toe.quaternion.copy(lg.toe.userData.restLocal).multiply(tq1);
    }

    // ── arms ─────────────────────────────────────────────────────────────────────────
    const mode = s.armMode || 'swing';
    for (const key of ['L', 'R']) {
      const am = arm[key];
      const side = am.side;
      const target = key === 'L' ? s.reachL : s.reachR;

      const shrug = ((mode === 'reach' || mode === 'carry') ? 0.11 : 0) + 0.03 * speedK * gait;
      tq1.setFromAxisAngle(AX_Z, -side * shrug);
      am.clav.quaternion.copy(am.clav.userData.restLocal).multiply(tq1);
      clavQ.copy(chestQ).multiply(am.clav.quaternion);
      clavPos.copy(am.clav.position).applyQuaternion(chestQ).add(chestPos);
      shoulderPos.copy(am.upper.position).applyQuaternion(clavQ).add(clavPos);

      let solved = false;
      if ((mode === 'reach' || mode === 'carry') && target) {
        toLocal(target, localTarget);
        // the elbow hangs down, back and out — the only pose in which a two-bone arm reading
        // down at a baby does not look like a shop-window dummy
        pole.set(side * 0.75, -0.5, -1).normalize().applyQuaternion(chestQ);
        solveTwoBone(shoulderPos, localTarget, am.L1, am.L2, pole, armQ, foreQ);
        solved = true;
      }

      if (!solved) {
        const amp = (0.15 + 0.34 * speedK) * gait;
        const swing = (key === 'L' ? -1 : 1) * amp * Math.cos(TAU * p)
          + (frozen ? 0 : wob(t * 0.6, key === 'L' ? 3 : 4) * 0.02 * (1 - gait));
        let abduct = 0.075 + 0.05 * speedK * gait + crouch * 0.10;
        let elbow = 0.30 + 0.42 * speedK * gait + 0.42 * Math.max(0, swing) + crouch * 0.25;
        let inward = 0;
        if (mode === 'hips') {
          abduct = 0.60;
          elbow = 1.68;
          inward = -side * 0.95;
        } else if (mode === 'relax') {
          abduct = 0.055;
          elbow = 0.16;
        }

        vAxis.copy(AX_Z).applyQuaternion(chestQ);
        vDir.copy(DOWN).applyAxisAngle(vAxis, side * abduct);
        vHinge.set(-side, 0, 0).applyQuaternion(chestQ).applyAxisAngle(vAxis, side * abduct);
        vDir.applyAxisAngle(vHinge, swing + (mode === 'hips' ? -0.34 : 0));
        basisQuat(vDir, vHinge, armQ);
        vFore.copy(vDir).applyAxisAngle(vHinge, elbow);
        if (inward) vFore.applyAxisAngle(vAxis, inward);
        basisQuat(vFore, vHinge, foreQ);
      }

      am.upper.quaternion.copy(clavQ).invert().multiply(armQ);
      am.fore.quaternion.copy(armQ).invert().multiply(foreQ);

      // wrist: cocked back when the hands are open to scoop, planted when they are on the hips
      const wrist = mode === 'reach' ? -0.44 : mode === 'hips' ? 0.34
        : -0.06 - 0.10 * Math.sin(TAU * p) * gait * side;
      tq1.setFromAxisAngle(AX_X, wrist);
      tq2.setFromAxisAngle(AX_Y, mode === 'reach' ? side * 0.16 : 0);
      am.hand.quaternion.copy(am.hand.userData.restLocal).multiply(tq1).multiply(tq2);

      // ── fingers ────────────────────────────────────────────────────────────────────
      const idx = key === 'L' ? 0 : 1;
      const wantClose = s.handClose !== undefined
        ? s.handClose
        : (mode === 'reach' ? 0.02 : mode === 'hips' ? 0.55 : 0.16);
      state.handClose[idx] = damp(state.handClose[idx], wantClose, 11, dt);
      const close = state.handClose[idx];
      const spread = mode === 'reach' ? 0.30 * (1 - close) : 0;
      const open = mode === 'reach' ? -0.34 * (1 - close) : 0;
      for (let i = 0; i < am.digits.length; i++) {
        const dg = am.digits[i];
        const k = dg.key === 'thumb' ? 0.68 : 1;
        const flex = [0.92 * k, 1.34 * k, 0.78 * k];
        for (let j = 0; j < 3; j++) {
          const b = dg.bones[j];
          const jitterK = frozen ? 0 : wob(t * 0.5 + i * 0.7, 5) * 0.012;
          tq1.setFromAxisAngle(AX_X, open + close * flex[j] + jitterK);
          if (j === 0 && spread > 0.001) {
            tq2.setFromAxisAngle(AX_Y, (dg.order - 1.5) * spread * 0.14);
            b.quaternion.copy(b.userData.restLocal).multiply(tq1).multiply(tq2);
          } else {
            b.quaternion.copy(b.userData.restLocal).multiply(tq1);
          }
        }
      }
    }

    // ── head: look-at with anticipation ──────────────────────────────────────────────
    let tgtYaw = 0;
    let tgtPitch = 0;
    if (s.lookAt) {
      toLocal(s.lookAt, localTarget);
      headPivot.set(0, 1.552, 0.004);
      localTarget.sub(headPivot);
      tq1.copy(chestQ).invert();
      localTarget.applyQuaternion(tq1);
      const len = localTarget.length() || 1;
      tgtYaw = Math.atan2(localTarget.x, Math.max(0.04, localTarget.z));
      tgtPitch = -Math.asin(clamp(localTarget.y / len, -1, 1));
      const w = s.lookWeight !== undefined ? s.lookWeight : 1;
      tgtYaw *= w;
      tgtPitch *= w;
    }
    tgtYaw += clamp(state.turnSmooth * 0.34, -0.55, 0.55);
    if (!frozen) {
      tgtYaw += wob(t * 0.8, 1) * 0.045 * (1 - gait * 0.6);
      tgtPitch += wob(t * 0.6, 2) * 0.030 * (1 - gait * 0.6);
    }
    state.lookYaw = damp(state.lookYaw, clamp(tgtYaw, -1.28, 1.28), 7.5, dt);
    state.lookPitch = damp(state.lookPitch, clamp(tgtPitch, -0.62, 0.88), 7.5, dt);

    tq1.setFromAxisAngle(AX_Y, state.lookYaw);
    tq2.setFromAxisAngle(AX_X, state.lookPitch);
    gaze.copy(tq1).multiply(tq2);
    neck.quaternion.slerpQuaternions(IDENT, gaze, 0.38);
    head.quaternion.copy(neck.quaternion).invert().multiply(gaze);
    // a head that stays dead level is a head on a stick
    tq3.setFromAxisAngle(AX_Z, -state.lookYaw * 0.12 + (frozen ? 0 : wob(t * 0.45, 0) * 0.02));
    head.quaternion.multiply(tq3);

    // ── blink ────────────────────────────────────────────────────────────────────────
    if (!frozen) {
      state.blinkTimer -= dt;
      if (state.blinkTimer <= 0) {
        state.blink = 1;
        state.blinkTimer = 2.2 + rnd() * 3.4;
      }
      state.blink = Math.max(0, state.blink - dt * 8.5);
    }
    const blinkK = s.blink !== undefined ? s.blink : Math.sin(clamp(state.blink, 0, 1) * Math.PI);
    const lidAngle = 0.16 + 1.40 * blinkK + clamp(state.lookPitch, 0, 0.88) * 0.34;
    tq1.setFromAxisAngle(AX_X, lidAngle);
    lid.L.quaternion.copy(lid.L.userData.restLocal).multiply(tq1);
    lid.R.quaternion.copy(lid.R.userData.restLocal).multiply(tq1);
  }

  const _mw = new THREE.Matrix4();
  /** World transform of a bone — the catch camera and the baby anchor both need this. */
  function boneWorld(name, outPos, outQuat) {
    const i = byName.get(name);
    if (i === undefined) return false;
    const b = bones[i];
    _mw.copy(b.matrixWorld);
    if (outPos) outPos.setFromMatrixPosition(_mw);
    if (outQuat) outQuat.setFromRotationMatrix(_mw);
    return true;
  }

  return {
    state,
    advance,
    pose,
    boneWorld,
    get phase() {
      return state.phase;
    },
    setPhase(v) {
      state.phase = ((v % 1) + 1) % 1;
      state.prevPhase = state.phase;
    },
    setSpeed(v) {
      state.speedSmooth = v;
      state.strideLen = strideFor(Math.max(v, 0.25));
    },
    reset() {
      state.phase = 0.02;
      state.prevPhase = 0.02;
      state.speedSmooth = 0;
      state.lookYaw = 0;
      state.lookPitch = 0;
      state.crouch = 0;
      state.lean = 0;
      state.blink = 0;
      state.blinkTimer = 1.4;
      state.idleT = 0;
      state.handClose[0] = 0.12;
      state.handClose[1] = 0.12;
    },
  };
}
