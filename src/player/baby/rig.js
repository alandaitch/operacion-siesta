// OPERATION NAPTIME — BABY — the solver that turns a pose description into bone transforms.
//
// The bind pose has identity rotations everywhere (anatomy.js authors translations only), which
// makes the whole solver trivial: a bone's rest orientation *is* the identity in model space, so
// "aim this bone along d" is one setFromUnitVectors(restDir, d) and the local rotation is just the
// parent's world rotation inverted onto it. No rest-pose matrices, no per-bone basis tables.
//
// The chain is walked once, parents first, accumulating a model-space rotation W[i] and position
// P[i] per bone. That matters because the IK needs the *current* shoulder position — after the
// spine has counter-rotated and the torso has rolled onto the planted hand — not the bind one.
//
// Two-bone IK is the closed-form cosine-rule solve. The only subtlety is the pole: the elbow and
// the knee each get a reference direction derived from the bind pose (the component of the bind
// bend that is perpendicular to the root→end axis), so at rest the solver reproduces the authored
// pose exactly, and away from rest the joint bends the way a baby's joint bends — elbows bowed
// outward and forward, knees down and forward onto the floor.
//
// Hands and feet are given an absolute model-space orientation rather than a relative one: a palm
// planted on the rug must stay flat however the forearm rolls, and deriving that from the parent
// would need a twist decomposition we do not otherwise want to pay for.

import * as THREE from 'three';
import { BONES, BONE_INDEX, A } from './anatomy.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const _u = new THREE.Vector3();
const _p = new THREE.Vector3();
const _t = new THREE.Vector3();
const _e = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

/** Bind-pose bend plane for a joint chain: the part of root→mid that is not along root→end. */
function bindPole(rootName, midName, endName, fallback) {
  const r = new THREE.Vector3().fromArray(BONES[BONE_INDEX[rootName]].pos);
  const m = new THREE.Vector3().fromArray(BONES[BONE_INDEX[midName]].pos);
  const e = new THREE.Vector3().fromArray(BONES[BONE_INDEX[endName]].pos);
  const u = e.clone().sub(r).normalize();
  const bend = m.clone().sub(r);
  bend.addScaledVector(u, -bend.dot(u));
  if (bend.lengthSq() < 4e-5) return fallback.clone().normalize();
  return bend.normalize();
}

export function createRig(mesh) {
  const bones = mesh.bones;
  const count = BONES.length;
  const parent = BONES.map((b) => (b.parent ? BONE_INDEX[b.parent] : -1));
  const rest = BONES.map((b) => new THREE.Vector3().fromArray(b.pos));
  const dir = BONES.map((b) => new THREE.Vector3().fromArray(b.dir).normalize());
  const offset = BONES.map((b, i) => (parent[i] < 0
    ? new THREE.Vector3()
    : rest[i].clone().sub(rest[parent[i]])));

  const W = [];
  const P = [];
  for (let i = 0; i < count; i++) {
    W.push(new THREE.Quaternion());
    P.push(new THREE.Vector3());
  }

  const I = BONE_INDEX;
  const len = (a, b) => rest[I[b]].distanceTo(rest[I[a]]);
  const LIMBS = {
    armR: { up: I.armR, mid: I.foreR, end: I.handR, l1: len('armR', 'foreR'), l2: len('foreR', 'handR'), pole: bindPole('armR', 'foreR', 'handR', new THREE.Vector3(0.78, 0.16, -0.60)) },
    armL: { up: I.armL, mid: I.foreL, end: I.handL, l1: len('armL', 'foreL'), l2: len('foreL', 'handL'), pole: bindPole('armL', 'foreL', 'handL', new THREE.Vector3(-0.78, 0.16, -0.60)) },
    legR: { up: I.thighR, mid: I.shinR, end: I.footR, l1: len('thighR', 'shinR'), l2: len('shinR', 'footR'), pole: bindPole('thighR', 'shinR', 'footR', new THREE.Vector3(0.06, -0.54, -0.84)) },
    legL: { up: I.thighL, mid: I.shinL, end: I.footL, l1: len('thighL', 'shinL'), l2: len('shinL', 'footL'), pole: bindPole('thighL', 'shinL', 'footL', new THREE.Vector3(-0.06, -0.54, -0.84)) },
  };
  // The bind pole of a nearly straight arm is a millimetre long and therefore noisy; widen it
  // toward the direction a crawling baby's elbow actually bows.
  LIMBS.armR.pole.lerp(new THREE.Vector3(0.80, 0.14, -0.58).normalize(), 0.55).normalize();
  LIMBS.armL.pole.lerp(new THREE.Vector3(-0.80, 0.14, -0.58).normalize(), 0.55).normalize();

  /** Where a joint sits before its own rotation is known. */
  function jointPosition(i, out) {
    const p = parent[i];
    if (p < 0) return out.copy(P[i]);
    return out.copy(P[p]).add(_d.copy(offset[i]).applyQuaternion(W[p]));
  }

  /** Set bone `i`'s local rotation and push its frame down the chain. */
  function setLocal(i, q) {
    const p = parent[i];
    bones[i].quaternion.copy(q);
    if (p < 0) {
      W[i].copy(q);
      return;
    }
    P[i].copy(P[p]).add(_d.copy(offset[i]).applyQuaternion(W[p]));
    W[i].copy(W[p]).multiply(q);
  }

  /** Set bone `i`'s *model-space* rotation; the local one is derived from its parent. */
  function setWorld(i, q) {
    const p = parent[i];
    if (p < 0) {
      setLocal(i, q);
      return;
    }
    P[i].copy(P[p]).add(_d.copy(offset[i]).applyQuaternion(W[p]));
    W[i].copy(q);
    bones[i].quaternion.copy(_q2.copy(W[p]).invert().multiply(q));
  }

  /** Aim bone `i` along a model-space direction (minimal rotation from its rest direction). */
  function aim(i, dx, dy, dz) {
    _u.set(dx, dy, dz);
    if (_u.lengthSq() < 1e-9) _u.copy(dir[i]);
    else _u.normalize();
    _q.setFromUnitVectors(dir[i], _u);
    setWorld(i, _q);
  }

  const IDENTITY = new THREE.Quaternion();

  /**
   * Cosine-rule two-bone IK.
   * @param limb  one of LIMBS
   * @param target model-space position for the end joint
   * @param poleBias optional Vector3 added to the reference pole (steers the elbow/knee)
   * @param endQuat  model-space orientation for the end bone (palm / foot)
   */
  function solveLimb(limb, target, poleBias, endQuat, stretch) {
    const upIdx = limb.up;
    jointPosition(upIdx, _p); // shoulder / hip, in model space
    _u.copy(target).sub(_p);
    let d = _u.length();
    const l1 = limb.l1;
    let l2 = limb.l2 * (stretch || 1);
    // A limb at its limit that simply stops looks broken — the hand detaches from the floor it is
    // supposed to be pressing on. Six percent of forearm stretch buys the last few centimetres of
    // a stride, and on an arm this chubby it is invisible.
    const reach = d - l1;
    if (reach > l2 && reach < l2 * 1.06) l2 = reach + 0.0015;
    const lo = Math.abs(l1 - l2) + 0.004;
    const hi = (l1 + l2) * 0.998;
    if (d < 1e-5) {
      _u.copy(dir[upIdx]);
      d = lo;
    } else {
      _u.multiplyScalar(1 / d);
      d = clamp(d, lo, hi);
    }
    const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));

    _t.copy(limb.pole);
    if (poleBias) _t.add(poleBias);
    _t.addScaledVector(_u, -_t.dot(_u));
    if (_t.lengthSq() < 1e-8) {
      _t.set(-_u.y, _u.x, 0);
      if (_t.lengthSq() < 1e-8) _t.set(0, 0, 1);
    }
    _t.normalize();

    _e.copy(_p).addScaledVector(_u, l1 * cosA).addScaledVector(_t, l1 * sinA);
    P[upIdx].copy(_p);

    // upper bone
    _d.copy(_e).sub(_p).normalize();
    _q.setFromUnitVectors(dir[upIdx], _d);
    setWorld(upIdx, _q);

    // lower bone — aim at the (clamped) target, not the raw one, so it never hyperextends
    _p.addScaledVector(_u, d);
    _d.copy(_p).sub(_e).normalize();
    _q.setFromUnitVectors(dir[limb.mid], _d);
    setWorld(limb.mid, _q);

    setWorld(limb.end, endQuat || IDENTITY);
  }

  const rootRest = new THREE.Vector3().fromArray(A.pelvis);

  /**
   * Evaluate a whole pose. `pose` is produced by gait.js; see the field list there.
   */
  function solve(pose) {
    // --- root -------------------------------------------------------------------------------
    P[0].copy(rootRest).add(pose.rootPos);
    bones[0].position.copy(P[0]);
    setLocal(0, pose.rootQuat);

    // --- spine, neck, head ------------------------------------------------------------------
    setLocal(I.spine1, pose.q.spine1);
    setLocal(I.spine2, pose.q.spine2);
    setLocal(I.neck, pose.q.neck);
    setLocal(I.head, pose.q.head);
    setLocal(I.jaw, pose.q.jaw);
    setLocal(I.cheekR, pose.q.cheekR);
    setLocal(I.cheekL, pose.q.cheekL);
    setLocal(I.belly, pose.q.belly);
    setLocal(I.nappy, pose.q.nappy);
    bones[I.cheekR].scale.copy(pose.scale.cheekR);
    bones[I.cheekL].scale.copy(pose.scale.cheekL);
    bones[I.nappy].scale.copy(pose.scale.nappy);
    bones[I.belly].scale.copy(pose.scale.belly);

    // --- shoulders & arms ---------------------------------------------------------------------
    setLocal(I.clavR, pose.q.clavR);
    setLocal(I.clavL, pose.q.clavL);
    solveLimb(LIMBS.armR, pose.wrist[0], pose.armPole[0], pose.handQ[0], pose.armStretch[0]);
    solveLimb(LIMBS.armL, pose.wrist[1], pose.armPole[1], pose.handQ[1], pose.armStretch[1]);

    // --- legs -----------------------------------------------------------------------------------
    solveLimb(LIMBS.legR, pose.ankle[0], pose.legPole[0], pose.footQ[0], 1);
    solveLimb(LIMBS.legL, pose.ankle[1], pose.legPole[1], pose.footQ[1], 1);
  }

  return {
    bones,
    solve,
    aim,
    limbs: LIMBS,
    /** Model-space position of a bone's joint after the last solve. */
    jointOf(name, out) {
      return out.copy(P[I[name]]);
    },
    /** Model-space rotation of a bone after the last solve. */
    rotationOf(name, out) {
      return out.copy(W[I[name]]);
    },
  };
}
