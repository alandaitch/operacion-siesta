// AI · the parent's body: skeleton + procedural skinned meshes.
//
// The player is 0.42 m tall and looks UP at this character, so the polygon budget is spent where
// the camera actually is: the lower legs and the trouser cuffs, the underside of the jaw, the
// nostrils, and above all the hands — the catch ends with two of them filling the frame.
//
// Rig conventions, which the animator depends on absolutely:
//   · Every bone is authored from a REST BASIS, not from Euler angles. A limb bone's local +Y
//     points at its child, its local +X is the hinge the joint rotates about, +Z = X × Y. That
//     single convention lets the two-bone IK solver hand back a world quaternion built straight
//     from (hinge, limbDir) with no per-limb correction factors anywhere.
//   · Local transforms are derived from world rest positions by q_local = q_parent⁻¹ · q_world,
//     so the rest pose can be edited in metres above the floor and never in bone space.
//   · +Z is the character's FORWARD, +X is their LEFT (right-handed, Y up), matching the room.
//
// Nothing is symmetric: the shoulders differ by 4 mm, the hair parts off-centre, one slipper is
// more trodden than the other, and every fabric tube carries a seeded fold field. A perfectly
// mirrored humanoid is the single fastest way to read as a game asset instead of a person.

import * as THREE from 'three';
import { SkinBuilder, limbPath, makeFolds, smoothstep } from './mesh.js';

const LOD = {
  low: { limb: 8, hand: 6, headSeg: 18, headRing: 14, sub: 2, detail: false },
  medium: { limb: 10, hand: 8, headSeg: 24, headRing: 18, sub: 3, detail: true },
  high: { limb: 14, hand: 10, headSeg: 32, headRing: 24, sub: 3, detail: true },
  ultra: { limb: 16, hand: 12, headSeg: 40, headRing: 30, sub: 4, detail: true },
};

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m = new THREE.Matrix4();

/** Orthonormal basis → quaternion. `y` is the bone's aim, `x` the hinge hint (re-orthogonalised).
 *  Exported because the IK solver in ./anim.js is the same construction run backwards. */
export function basisQuat(y, xHint, out = new THREE.Quaternion()) {
  const Y = _v.copy(y).normalize();
  const X = _v2.copy(xHint);
  X.addScaledVector(Y, -X.dot(Y));
  if (X.lengthSq() < 1e-9) {
    X.set(1, 0, 0).addScaledVector(Y, -Y.x);
    if (X.lengthSq() < 1e-9) X.set(0, 0, 1).addScaledVector(Y, -Y.z);
  }
  X.normalize();
  const Z = new THREE.Vector3().crossVectors(X, Y);
  _m.makeBasis(X, Y, Z);
  return out.setFromRotationMatrix(_m);
}

/**
 * Build the skeleton from a flat rest table. Each entry:
 *   { name, parent, p:Vector3 (world rest), aim?:Vector3, hinge?:Vector3 }
 * Bones with no `aim` keep the identity orientation (spine, head, pelvis).
 */
function buildSkeleton(defs) {
  const bones = [];
  const byName = new Map();
  const worldPos = [];
  const worldQuat = [];

  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    const bone = new THREE.Bone();
    bone.name = d.name;
    const wq = d.aim ? basisQuat(d.aim, d.hinge || V(1, 0, 0)) : new THREE.Quaternion();
    worldPos.push(d.p.clone());
    worldQuat.push(wq);

    if (d.parent) {
      const pi = byName.get(d.parent);
      if (pi === undefined) throw new Error(`[ai] unknown parent bone ${d.parent}`);
      const pw = worldPos[pi];
      const pq = worldQuat[pi];
      const inv = pq.clone().invert();
      bone.position.copy(d.p).sub(pw).applyQuaternion(inv);
      bone.quaternion.copy(inv).multiply(wq);
      bones[pi].add(bone);
    } else {
      bone.position.copy(d.p);
      bone.quaternion.copy(wq);
    }
    bone.userData.restPos = worldPos[i].clone();
    bone.userData.restQuat = wq.clone();
    bone.userData.index = i;
    byName.set(d.name, i);
    bones.push(bone);
  }
  return { bones, byName, worldPos, worldQuat };
}

/** Walk a chain of directions/lengths from a start point → array of world joint positions. */
function chainPoints(start, dir, lengths) {
  const pts = [start.clone()];
  const d = dir.clone().normalize();
  let p = start.clone();
  for (let i = 0; i < lengths.length; i++) {
    p = p.clone().addScaledVector(d, lengths[i]);
    pts.push(p);
  }
  return pts;
}

/**
 * @param ctx the game context
 * @returns { group, bones, byName, skeleton, meshes, dims, hands }
 */
export function buildParentBody(ctx) {
  const tier = ctx.quality?.tier || 'high';
  const lod = LOD[tier] || LOD.high;
  const rnd = ctx.makeRng ? ctx.makeRng(0x9a17ed) : Math.random;
  const mats = ctx.materials;

  // Materials tiled in real metres — the builder emits UVs in metres, so one square metre of
  // twill covers one square metre of trouser regardless of how fat the limb is.
  const metreMat = (name, hex, opts = {}) => {
    const base = mats.get(name);
    const tm = base.userData && base.userData.tileMetres;
    if (hex === null || hex === undefined) return tm ? mats.tiled(name, 1, 1) : base;
    const o = { ...opts };
    if (tm && tm[0] && tm[1]) o.uvRepeat = [1 / tm[0], 1 / tm[1]];
    return mats.tinted(name, hex, o);
  };

  // ── rest pose ─────────────────────────────────────────────────────────────────────────
  // A 1.74 m adult. Asymmetry is baked in: the left shoulder rides 4 mm higher, the right hip
  // 3 mm forward — the stance of somebody who has been carrying a baby on one side for a year.
  const D = {
    height: 1.74,
    hipY: 0.980,
    eyeY: 1.638,
    shoulderY: 1.410,
    hipHalf: 0.098,
    reach: 0.72,
  };

  const DOWN = V(0, -1, 0);
  const legHinge = V(1, 0, 0); // knee flexes backward
  const armHinge = V(-1, 0, 0); // elbow flexes forward

  const defs = [
    { name: 'hips', parent: null, p: V(0, 0.980, 0) },
    { name: 'spine', parent: 'hips', p: V(0, 1.104, 0.006) },
    { name: 'chest', parent: 'spine', p: V(0, 1.298, -0.002) },
    { name: 'neck', parent: 'chest', p: V(0.002, 1.462, -0.012) },
    { name: 'head', parent: 'neck', p: V(0, 1.551, 0.004) },
    { name: 'lidL', parent: 'head', p: V(0.031, 1.646, 0.070) },
    { name: 'lidR', parent: 'head', p: V(-0.031, 1.646, 0.070) },
  ];

  // legs -------------------------------------------------------------------------------
  const legs = {};
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    const hip = V(side * D.hipHalf, 0.925, side > 0 ? 0.004 : 0.007);
    const knee = V(side * (D.hipHalf + 0.002), 0.482, 0.026);
    const ankle = V(side * (D.hipHalf - 0.004), 0.092, -0.020);
    const ball = V(side * (D.hipHalf - 0.006), 0.030, 0.098);
    const tip = V(side * (D.hipHalf - 0.008), 0.020, 0.168);
    legs[s] = { hip, knee, ankle, ball, tip };
    defs.push(
      { name: `thigh${s}`, parent: 'hips', p: hip, aim: _v.copy(knee).sub(hip).clone(), hinge: legHinge },
      { name: `shin${s}`, parent: `thigh${s}`, p: knee, aim: _v.copy(ankle).sub(knee).clone(), hinge: legHinge },
      { name: `foot${s}`, parent: `shin${s}`, p: ankle, aim: _v.copy(ball).sub(ankle).clone(), hinge: legHinge },
      { name: `toe${s}`, parent: `foot${s}`, p: ball, aim: _v.copy(tip).sub(ball).clone(), hinge: legHinge },
    );
  }

  // arms + hands -----------------------------------------------------------------------
  const FINGERS = [
    { key: 'index', a: -0.030, d: 0.081, p: 0.004, len: [0.043, 0.026, 0.021], r: [0.0100, 0.0092, 0.0082, 0.0068], curl: [0.20, 0.30, 0.18] },
    { key: 'middle', a: -0.008, d: 0.087, p: 0.001, len: [0.047, 0.030, 0.022], r: [0.0103, 0.0095, 0.0084, 0.0069], curl: [0.22, 0.34, 0.20] },
    { key: 'ring', a: 0.014, d: 0.083, p: -0.003, len: [0.043, 0.028, 0.021], r: [0.0097, 0.0090, 0.0080, 0.0066], curl: [0.24, 0.36, 0.22] },
    { key: 'little', a: 0.034, d: 0.072, p: -0.009, len: [0.034, 0.021, 0.018], r: [0.0085, 0.0078, 0.0069, 0.0058], curl: [0.28, 0.38, 0.24] },
  ];
  const THUMB = { key: 'thumb', a: -0.028, d: 0.024, p: 0.019, len: [0.041, 0.031, 0.025], r: [0.0135, 0.0118, 0.0104, 0.0088], curl: [0.14, 0.22, 0.16] };

  const arms = {};
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    const lift = side > 0 ? 0.004 : 0; // the left shoulder rides higher
    const clav = V(side * 0.042, 1.396 + lift, 0.014);
    const shoulder = V(side * 0.186, 1.406 + lift, 0.004);
    const elbow = V(side * 0.199, 1.136 + lift, -0.024);
    const wrist = V(side * 0.206, 0.898 + lift, 0.012);

    // hand frame: +Y down the fingers, +Z the palm normal (medial), +X the spread axis
    const Yh = V(side * 0.03, -0.995, 0.06).normalize();
    const Zh = V(-side, 0, 0.05).normalize();
    Zh.addScaledVector(Yh, -Zh.dot(Yh)).normalize();
    const Xh = new THREE.Vector3().crossVectors(Yh, Zh).normalize();

    defs.push(
      { name: `clav${s}`, parent: 'chest', p: clav, aim: _v.copy(shoulder).sub(clav).clone(), hinge: V(0, 0, -1) },
      { name: `arm${s}`, parent: `clav${s}`, p: shoulder, aim: _v.copy(elbow).sub(shoulder).clone(), hinge: armHinge },
      { name: `fore${s}`, parent: `arm${s}`, p: elbow, aim: _v.copy(wrist).sub(elbow).clone(), hinge: armHinge },
      { name: `hand${s}`, parent: `fore${s}`, p: wrist, aim: Yh.clone(), hinge: Xh.clone() },
    );

    const digits = {};
    for (const f of [...FINGERS, THUMB]) {
      const isThumb = f.key === 'thumb';
      const base = wrist.clone()
        .addScaledVector(Xh, f.a)
        .addScaledVector(Yh, -f.d)
        .addScaledVector(Zh, f.p);
      // The thumb's column is rotated out of the palm plane so it opposes the fingers.
      let dir = Yh.clone();
      let hinge = Xh.clone();
      if (isThumb) {
        const q = new THREE.Quaternion().setFromAxisAngle(Zh, -side * 0.72);
        dir.applyQuaternion(q);
        const q2 = new THREE.Quaternion().setFromAxisAngle(dir, side * 0.55);
        hinge.applyQuaternion(q).applyQuaternion(q2);
      }
      // Bake a relaxed curl into the rest pose. A flat starfish hand is the classic tell.
      const pts = [base];
      let d = dir.clone();
      for (let j = 0; j < f.len.length; j++) {
        const q = new THREE.Quaternion().setFromAxisAngle(hinge, f.curl[j]);
        d = d.clone().applyQuaternion(q).normalize();
        pts.push(pts[j].clone().addScaledVector(d, f.len[j]));
      }
      const boneNames = [];
      for (let j = 0; j < f.len.length; j++) {
        const name = `${f.key}${j}${s}`;
        boneNames.push(name);
        defs.push({
          name,
          parent: j === 0 ? `hand${s}` : `${f.key}${j - 1}${s}`,
          p: pts[j],
          aim: _v.copy(pts[j + 1]).sub(pts[j]).clone(),
          hinge,
        });
      }
      digits[f.key] = { pts, bones: boneNames, spec: f, hinge: hinge.clone() };
    }
    arms[s] = { clav, shoulder, elbow, wrist, Xh, Yh, Zh, digits, side };
  }

  const { bones, byName } = buildSkeleton(defs);
  const B = (n) => {
    const i = byName.get(n);
    if (i === undefined) throw new Error(`[ai] missing bone ${n}`);
    return i;
  };

  // ── geometry ──────────────────────────────────────────────────────────────────────────
  const skin = new SkinBuilder('parent.skin');
  const jumper = new SkinBuilder('parent.jumper');
  const trouser = new SkinBuilder('parent.trouser');
  const slipper = new SkinBuilder('parent.slipper');
  const sole = new SkinBuilder('parent.sole');
  const hair = new SkinBuilder('parent.hair');
  const sclera = new SkinBuilder('parent.sclera');
  const iris = new SkinBuilder('parent.iris');
  const lips = new SkinBuilder('parent.lips');
  const nails = new SkinBuilder('parent.nails');

  const foldsTrouser = makeFolds(rnd, 4);
  const foldsJumper = makeFolds(rnd, 5);
  const foldsSleeve = makeFolds(rnd, 3);

  // --- torso: the jumper ---------------------------------------------------------------
  {
    const iH = B('hips');
    const iS = B('spine');
    const iC = B('chest');
    const path = [];
    // hem → waist → ribs → chest → shoulders. rx/rz shape the ellipse: people are not cylinders.
    const prof = [
      { y: 0.905, rx: 0.171, rz: 0.126, w: [[iH, 1]] },
      { y: 0.938, rx: 0.163, rz: 0.119, w: [[iH, 1]] },
      { y: 0.985, rx: 0.158, rz: 0.114, w: [[iH, 0.85], [iS, 0.15]] },
      { y: 1.048, rx: 0.156, rz: 0.112, w: [[iH, 0.4], [iS, 0.6]] },
      { y: 1.112, rx: 0.163, rz: 0.116, w: [[iS, 0.9], [iH, 0.1]] },
      { y: 1.178, rx: 0.174, rz: 0.124, w: [[iS, 0.75], [iC, 0.25]] },
      { y: 1.246, rx: 0.184, rz: 0.130, w: [[iS, 0.3], [iC, 0.7]] },
      { y: 1.312, rx: 0.188, rz: 0.131, w: [[iC, 1]] },
      { y: 1.372, rx: 0.184, rz: 0.126, w: [[iC, 1]] },
      { y: 1.418, rx: 0.166, rz: 0.113, w: [[iC, 1]] },
      { y: 1.446, rx: 0.128, rz: 0.092, w: [[iC, 1]] },
    ];
    for (let i = 0; i < prof.length; i++) {
      const p = prof[i];
      // the hem rib grips, so the bottom two rings pull in a touch and the fold field is stronger
      path.push({
        p: V(0.004 * Math.sin(i * 0.9), p.y, -0.004 + 0.006 * Math.cos(i * 0.7)),
        rx: p.rx,
        rz: p.rz,
        w: p.w,
        shape: (th, t) => foldsJumper(th, t + i * 0.11) * (i <= 1 ? 0.985 : 1),
      });
    }
    jumper.tube(path, { seg: lod.limb + 4, capStart: true, capEnd: false, capScale: 0.35 });

    // rolled collar
    const cn = B('neck');
    jumper.tube([
      { p: V(0.002, 1.432, -0.010), rx: 0.089, rz: 0.083, w: [[iC, 0.5], [cn, 0.5]] },
      { p: V(0.002, 1.462, -0.010), rx: 0.083, rz: 0.078, w: [[cn, 1]] },
      { p: V(0.002, 1.488, -0.008), rx: 0.086, rz: 0.081, w: [[cn, 1]] },
      { p: V(0.002, 1.502, -0.006), rx: 0.081, rz: 0.076, w: [[cn, 1]] },
    ], { seg: lod.limb + 2, capStart: false, capEnd: false });

    // shoulder caps: a jumper breaks over the deltoid, it does not stop at a hard edge
    for (const side of [1, -1]) {
      const s = side > 0 ? 'L' : 'R';
      const a = arms[s];
      jumper.blob({
        center: a.shoulder.clone().add(V(-side * 0.012, 0.012, -0.004)),
        radius: V(0.072, 0.070, 0.083),
        seg: lod.limb + 2,
        rings: Math.round(lod.limb * 0.7),
        w: [[B('chest'), 0.55], [B(`arm${s}`), 0.45]],
        uvScale: 0.24,
        warp: (dir, u, v, out) => {
          out.multiplyScalar(1 + 0.05 * Math.sin(u * 12.0 + v * 5.0));
        },
      });
    }
  }

  // --- sleeves + arm skin ---------------------------------------------------------------
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    const a = arms[s];
    const ia = B(`arm${s}`);
    const ifo = B(`fore${s}`);
    const ih = B(`hand${s}`);

    // the arm underneath, so nothing shows through at the cuff or the shoulder
    skin.tube(limbPath([
      { p: a.shoulder.clone(), bone: ia, r: 0.049 },
      { p: a.elbow.clone(), bone: ifo, r: 0.041 },
      { p: a.wrist.clone(), bone: ih, r: 0.031 },
    ], { sub: lod.sub, blend: 0.05 }), { seg: lod.limb, capStart: false, capEnd: false });

    // the sleeve: wide at the shoulder, bunched at the cuff
    const sleeve = limbPath([
      { p: a.shoulder.clone().addScaledVector(V(0, 1, 0), 0.030), bone: ia, r: 0.078 },
      { p: a.elbow.clone(), bone: ifo, r: 0.062 },
      { p: a.wrist.clone().addScaledVector(V(0, 1, 0), 0.030), bone: ih, r: 0.050 },
    ], {
      sub: lod.sub + 1,
      blend: 0.06,
      shape: (th, t) => foldsSleeve(th, t * 2.3 + (side > 0 ? 0 : 1.7)),
    });
    // cuff: the last ring rolls back in
    sleeve[sleeve.length - 1].r = 0.045;
    sleeve.push({
      p: a.wrist.clone().addScaledVector(V(0, 1, 0), 0.012),
      r: 0.042,
      w: [[ih, 1]],
      shape: sleeve[sleeve.length - 1].shape,
    });
    jumper.tube(sleeve, { seg: lod.limb, capStart: false, capEnd: false });
  }

  // --- trousers -------------------------------------------------------------------------
  {
    const iH = B('hips');
    // the seat: a soft block over the pelvis that the two legs grow out of
    trouser.tube([
      { p: V(0, 1.062, 0.004), rx: 0.168, rz: 0.126, w: [[iH, 1]] },
      { p: V(0, 1.010, 0.002), rx: 0.176, rz: 0.132, w: [[iH, 1]] },
      { p: V(0, 0.952, -0.002), rx: 0.180, rz: 0.136, w: [[iH, 1]] },
      { p: V(0, 0.900, -0.004), rx: 0.174, rz: 0.132, w: [[iH, 1]] },
      { p: V(0, 0.862, 0.000), rx: 0.158, rz: 0.126, w: [[iH, 1]] },
    ], {
      seg: lod.limb + 4,
      capStart: true,
      capEnd: false,
      capScale: 0.4,
      shape: (th, t) => foldsTrouser(th, t * 0.6),
    });

    for (const side of [1, -1]) {
      const s = side > 0 ? 'L' : 'R';
      const L = legs[s];
      const it = B(`thigh${s}`);
      const ish = B(`shin${s}`);
      const ifo = B(`foot${s}`);
      const path = limbPath([
        { p: L.hip.clone().add(V(0, 0.02, 0)), bone: it, r: 0.122 },
        { p: L.knee.clone(), bone: ish, r: 0.104 },
        { p: L.ankle.clone().add(V(0, 0.055, 0)), bone: ifo, r: 0.092 },
      ], {
        sub: lod.sub + 2,
        blend: 0.07,
        // calf swell + a cuff that bunches on the instep, which is what stops soft trousers
        // reading as two pipes
        radiusFn: (t) => {
          const thigh = 0.122 - 0.020 * t;
          const calf = 0.014 * Math.exp(-((t - 0.62) ** 2) / 0.012);
          const cuff = t > 0.9 ? 0.012 * Math.sin((t - 0.9) * 15.7) : 0;
          return thigh + calf + cuff;
        },
        shape: (th, t) => foldsTrouser(th, t * 3.1 + (side > 0 ? 0 : 2.4)),
      });
      // the hem stops above the ankle and flares slightly
      path.push({
        p: L.ankle.clone().add(V(0, 0.026, 0.004)),
        r: 0.094,
        w: [[ifo, 0.6], [ish, 0.4]],
        shape: (th, t) => foldsTrouser(th, t * 3.1 + 1.1),
      });
      trouser.tube(path, { seg: lod.limb + 2, capStart: false, capEnd: false });

      // the leg under the hem, so the ankle is skin and not a hole
      skin.tube(limbPath([
        { p: L.knee.clone(), bone: ish, r: 0.058 },
        { p: L.ankle.clone().add(V(0, 0.02, 0)), bone: ifo, r: 0.040 },
      ], { sub: 2, blend: 0.04 }), { seg: lod.limb, capStart: false, capEnd: false });
    }
  }

  // --- slippers -------------------------------------------------------------------------
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    const L = legs[s];
    const ifo = B(`foot${s}`);
    const ito = B(`toe${s}`);
    const trodden = side > 0 ? 1 : 0.93; // one of them has had a harder life
    const heel = L.ankle.clone().add(V(0, -0.048, -0.052));
    const arch = L.ankle.clone().add(V(0, -0.058, 0.010));
    const ball = L.ball.clone().add(V(0, -0.010, 0.004));
    const toe = L.tip.clone().add(V(0, 0.004, 0.006));
    slipper.tube([
      { p: heel, rx: 0.043, rz: 0.038 * trodden, w: [[ifo, 1]] },
      { p: arch, rx: 0.047, rz: 0.049, w: [[ifo, 1]] },
      { p: ball, rx: 0.050, rz: 0.043, w: [[ifo, 0.45], [ito, 0.55]] },
      { p: toe, rx: 0.043, rz: 0.033, w: [[ito, 1]] },
    ], { seg: lod.limb + 2, capStart: true, capEnd: true, capScale: 0.75 });

    // a thin sole that reads as a separate material from the felt upper
    sole.tube([
      { p: heel.clone().add(V(0, -0.030, -0.004)), rx: 0.041, rz: 0.010, w: [[ifo, 1]] },
      { p: arch.clone().add(V(0, -0.042, 0)), rx: 0.045, rz: 0.010, w: [[ifo, 1]] },
      { p: ball.clone().add(V(0, -0.028, 0)), rx: 0.048, rz: 0.010, w: [[ifo, 0.45], [ito, 0.55]] },
      { p: toe.clone().add(V(0, -0.014, 0)), rx: 0.040, rz: 0.009, w: [[ito, 1]] },
    ], { seg: lod.limb, capStart: true, capEnd: true, capScale: 0.6 });
  }

  // --- neck + head ----------------------------------------------------------------------
  const iHead = B('head');
  const iNeck = B('neck');
  {
    skin.tube([
      { p: V(0.002, 1.398, -0.014), rx: 0.062, rz: 0.058, w: [[B('chest'), 0.6], [iNeck, 0.4]] },
      { p: V(0.002, 1.446, -0.012), rx: 0.055, rz: 0.052, w: [[iNeck, 1]] },
      { p: V(0.002, 1.492, -0.008), rx: 0.051, rz: 0.049, w: [[iNeck, 0.55], [iHead, 0.45]] },
      { p: V(0.002, 1.532, -0.002), rx: 0.053, rz: 0.052, w: [[iHead, 1]] },
    ], {
      seg: lod.limb + 2,
      capStart: false,
      capEnd: false,
      // the sterno-mastoid pair: two soft ridges either side of the throat
      shape: (th) => 1 + 0.055 * Math.exp(-((Math.cos(th - 0.9) - 1) ** 2) * 9)
        + 0.055 * Math.exp(-((Math.cos(th + 0.9) - 1) ** 2) * 9),
    });

    const HC = V(0.001, 1.634, 0.004); // skull centre
    const HR = V(0.0925, 0.1105, 0.1015);
    const g = (x, y, z, dx, dy, dz, s) => {
      // anisotropic gaussian on the unit sphere direction, the sculpting brush
      const a = (x - dx) * s, b2 = (y - dy) * s, c = (z - dz) * s;
      return Math.exp(-(a * a * 1.0 + b2 * b2 * 1.0 + c * c * 1.0));
    };
    skin.blob({
      center: HC,
      radius: HR,
      seg: lod.headSeg,
      rings: lod.headRing,
      w: [[iHead, 1]],
      uvScale: 0.34,
      warp: (d, u, v, out) => {
        const x = d.x;
        const y = d.y;
        const z = d.z;
        let r = 0;
        // cranium: occiput fuller, crown flattened, temples squeezed
        r += 0.006 * Math.max(0, -z) * Math.max(0, y + 0.3);
        r -= 0.005 * Math.max(0, y - 0.72);
        r -= 0.006 * (g(x, y, z, 0.95, 0.30, -0.05, 1.5) + g(x, y, z, -0.95, 0.30, -0.05, 1.5));
        // brow ridge and the shadow it throws — the single most important form from below
        r += 0.0075 * g(x, y, z, 0.36, 0.20, 0.90, 2.1) + 0.0075 * g(x, y, z, -0.36, 0.20, 0.90, 2.1);
        r += 0.004 * g(x, y, z, 0, 0.26, 0.96, 2.6);
        // eye sockets
        r -= 0.010 * (g(x, y, z, 0.33, 0.05, 0.93, 2.6) + g(x, y, z, -0.33, 0.05, 0.93, 2.6));
        // nose: a wedge, plus a bulb and two nostril pits you can see from the floor
        const nose = g(x, y, z, 0, -0.06, 1.02, 1.9);
        r += 0.026 * nose * Math.max(0, 1 - Math.abs(x) * 3.4);
        r += 0.010 * g(x, y, z, 0, -0.22, 0.95, 3.4);
        r -= 0.007 * (g(x, y, z, 0.11, -0.30, 0.90, 6.5) + g(x, y, z, -0.11, -0.30, 0.90, 6.5));
        // cheekbones and the hollow under them
        r += 0.007 * (g(x, y, z, 0.62, -0.02, 0.72, 1.8) + g(x, y, z, -0.62, -0.02, 0.72, 1.8));
        r -= 0.005 * (g(x, y, z, 0.55, -0.36, 0.68, 2.2) + g(x, y, z, -0.55, -0.36, 0.68, 2.2));
        // philtrum, mouth crease, chin
        r -= 0.004 * g(x, y, z, 0, -0.46, 0.88, 5.0);
        r += 0.009 * g(x, y, z, 0, -0.70, 0.66, 2.2);
        // jaw: narrows toward the chin and has a real underside
        const low = Math.max(0, -y - 0.28);
        out.x *= 1 - 0.30 * low;
        out.z *= 1 - 0.10 * Math.max(0, -y - 0.55);
        if (y < -0.72) out.y *= 1 - 0.22 * (-y - 0.72) / 0.28;
        out.addScaledVector(d, r);
        // and it is not symmetric: a 1.5 mm skew, which is what faces do
        out.x += 0.0015 * Math.max(0, y);
      },
    });

    // ears
    for (const side of [1, -1]) {
      skin.blob({
        center: V(side * 0.089, 1.641, -0.013),
        radius: V(0.010, 0.030, 0.020),
        seg: Math.max(8, Math.round(lod.headSeg * 0.4)),
        rings: Math.max(6, Math.round(lod.headRing * 0.4)),
        w: [[iHead, 1]],
        uvScale: 0.09,
        warp: (d, u, v, out) => {
          // fold the outer helix forward and hollow the bowl
          out.z += 0.012 * Math.max(0, d.y) - 0.004;
          out.x *= 1 + 0.6 * Math.max(0, -d.x * side);
          const bowl = Math.exp(-((d.z - 0.4) ** 2 + (d.y + 0.1) ** 2) * 4);
          out.x -= side * 0.006 * bowl;
        },
      });
    }

    // lips: a soft band, slightly parted, redder than the face
    lips.tube([
      { p: V(-0.026, 1.5565, 0.077), rx: 0.0055, rz: 0.0045, w: [[iHead, 1]] },
      { p: V(-0.012, 1.5585, 0.0855), rx: 0.0072, rz: 0.0056, w: [[iHead, 1]] },
      { p: V(0.001, 1.5590, 0.0875), rx: 0.0075, rz: 0.0058, w: [[iHead, 1]] },
      { p: V(0.014, 1.5585, 0.0850), rx: 0.0070, rz: 0.0055, w: [[iHead, 1]] },
      { p: V(0.027, 1.5560, 0.0765), rx: 0.0052, rz: 0.0043, w: [[iHead, 1]] },
    ], { seg: Math.max(7, lod.limb - 2), capStart: true, capEnd: true, capScale: 0.6 });

    // eyes: sclera, iris, and a lid that actually closes
    for (const side of [1, -1]) {
      const s = side > 0 ? 'L' : 'R';
      const c = V(side * 0.0315, 1.6455, 0.0705);
      sclera.blob({
        center: c,
        radius: V(0.0126, 0.0126, 0.0126),
        seg: Math.max(10, Math.round(lod.headSeg * 0.45)),
        rings: Math.max(8, Math.round(lod.headRing * 0.45)),
        w: [[iHead, 1]],
        uvScale: 0.02,
      });
      const gaze = V(side * 0.10, -0.04, 0.994).normalize();
      iris.disc(c.clone().addScaledVector(gaze, 0.0118), gaze, 0.0058, [[iHead, 1]], {
        seg: 12, bulge: 0.35,
      });
      // upper lid: a spherical shell on its own bone so the parent can blink
      const lidBone = B(`lid${s}`);
      skin.blob({
        center: c,
        radius: V(0.0142, 0.0142, 0.0142),
        seg: Math.max(10, Math.round(lod.headSeg * 0.45)),
        rings: Math.max(6, Math.round(lod.headRing * 0.3)),
        w: [[lidBone, 1]],
        uvScale: 0.03,
        warp: (d, u, v, out) => {
          // Only the cap above the lash line stays proud of the sclera (r 0.0126); everything
          // below collapses inside the eyeball and is never rasterised. The lid bone then sweeps
          // this cap forward about the eye centre to blink.
          const k = 0.52 + 0.48 * smoothstep(0.02, 0.22, d.y);
          out.multiplyScalar(k * (1 + 0.08 * Math.max(0, d.y)));
        },
      });
      // lower lid ridge, part of the face
      skin.tube([
        { p: c.clone().add(V(-side * 0.014, -0.0075, 0.001)), r: 0.0032, w: [[iHead, 1]] },
        { p: c.clone().add(V(0, -0.0105, 0.006)), r: 0.0038, w: [[iHead, 1]] },
        { p: c.clone().add(V(side * 0.013, -0.0080, 0.002)), r: 0.0030, w: [[iHead, 1]] },
      ], { seg: 7, capStart: true, capEnd: true, capScale: 0.5 });
    }
  }

  // --- hair -----------------------------------------------------------------------------
  {
    const HC = V(0.001, 1.634, 0.004);
    const part = 0.28; // off-centre parting
    hair.blob({
      center: HC.clone().add(V(0, 0.006, -0.006)),
      radius: V(0.0975, 0.1165, 0.1065),
      seg: lod.headSeg,
      rings: lod.headRing,
      w: [[iHead, 1]],
      uvScale: 0.30,
      warp: (d, u, v, out) => {
        const x = d.x;
        const y = d.y;
        const z = d.z;
        // The hairline as a scalar field. Above it the shell stands 8 mm proud of the skull;
        // below it the shell collapses 7 mm INSIDE the skull and is never rasterised — which is
        // how one closed ellipsoid becomes a haircut with no cut edges and no alpha sorting.
        const thr = 0.30
          + 0.18 * Math.max(0, z) ** 1.5
          - 0.34 * Math.abs(x)
          - 0.55 * Math.max(0, -z)
          - 0.05 * Math.sin(x * 8 + 1.1);
        let mask = smoothstep(thr - 0.05, thr + 0.08, y);
        // tuck behind the ear rather than swallowing it
        mask *= 1 - 0.92 * Math.exp(-((Math.abs(x) - 0.95) ** 2 * 34 + (y - 0.06) ** 2 * 15 + (z + 0.09) ** 2 * 11));
        const thick = -0.012 + 0.020 * mask;
        out.addScaledVector(d, thick);
        // volume, an off-centre parting groove, a bit of bed-head
        out.addScaledVector(d, 0.0055 * Math.sin(u * 21.0 + v * 8.0) * mask);
        out.addScaledVector(d, -0.009 * Math.exp(-((x - part) ** 2) * 60) * Math.max(0, y) * mask);
        // the nape: hair drops below the skull line at the back
        if (z < -0.25 && y < 0) out.y -= 0.028 * mask * Math.min(1, -y * 1.6) * Math.min(1, -z * 1.4);
      },
    });
    // eyebrows
    for (const side of [1, -1]) {
      const c = V(side * 0.0315, 1.6455, 0.0705);
      hair.tube([
        { p: c.clone().add(V(-side * 0.020, 0.0135, -0.001)), rx: 0.0030, rz: 0.0020, w: [[iHead, 1]] },
        { p: c.clone().add(V(-side * 0.004, 0.0168, 0.0055)), rx: 0.0038, rz: 0.0024, w: [[iHead, 1]] },
        { p: c.clone().add(V(side * 0.013, 0.0160, 0.0030)), rx: 0.0034, rz: 0.0021, w: [[iHead, 1]] },
        { p: c.clone().add(V(side * 0.026, 0.0128, -0.006)), rx: 0.0022, rz: 0.0015, w: [[iHead, 1]] },
      ], { seg: 6, capStart: true, capEnd: true, capScale: 0.5 });
    }
    if (lod.detail) {
      // flyaways: nobody's hair is a solid shell, and the rim light through them is free detail
      for (let i = 0; i < 7; i++) {
        const th = rnd() * Math.PI * 2;
        const ph = 0.35 + rnd() * 0.7;
        const dir = V(Math.sin(ph) * Math.sin(th), Math.cos(ph), Math.sin(ph) * Math.cos(th));
        const base = HC.clone().addScaledVector(dir, 0.108);
        const tip = base.clone().addScaledVector(dir, 0.020 + rnd() * 0.026)
          .add(V((rnd() - 0.5) * 0.02, -0.004, (rnd() - 0.5) * 0.02));
        const mid = base.clone().lerp(tip, 0.5).add(V(0, 0.004, 0));
        hair.tube([
          { p: base, r: 0.0026, w: [[iHead, 1]] },
          { p: mid, r: 0.0019, w: [[iHead, 1]] },
          { p: tip, r: 0.0006, w: [[iHead, 1]] },
        ], { seg: 4, capStart: false, capEnd: true, capScale: 0.5 });
      }
    }
  }

  // --- hands: the punchline -------------------------------------------------------------
  const handInfo = {};
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    const a = arms[s];
    const ih = B(`hand${s}`);
    const seg = lod.hand;

    // the palm: a flattened tube from the wrist to the knuckle row, with a thenar eminence
    const knuckleRow = a.wrist.clone().addScaledVector(a.Yh, -0.078).addScaledVector(a.Zh, 0.002);
    const palmW = [[ih, 1]];
    const idxKnuckleBone = B(`index0${s}`);
    const litKnuckleBone = B(`little0${s}`);
    skin.tube([
      { p: a.wrist.clone().addScaledVector(a.Yh, 0.012), rx: 0.033, rz: 0.020, w: palmW },
      { p: a.wrist.clone().addScaledVector(a.Yh, -0.014), rx: 0.037, rz: 0.021, w: palmW },
      { p: a.wrist.clone().addScaledVector(a.Yh, -0.042), rx: 0.043, rz: 0.023, w: palmW },
      {
        p: knuckleRow.clone().addScaledVector(a.Yh, 0.014),
        rx: 0.046,
        rz: 0.022,
        w: [[ih, 0.8], [idxKnuckleBone, 0.1], [litKnuckleBone, 0.1]],
      },
      {
        p: knuckleRow,
        rx: 0.044,
        rz: 0.019,
        w: [[ih, 0.6], [idxKnuckleBone, 0.2], [litKnuckleBone, 0.2]],
      },
    ], {
      seg: seg + 4,
      capStart: true,
      capEnd: true,
      capScale: 0.55,
      // the palm is not an ellipse: the heel and the thenar pad bulge on the palm side only
      shape: (th, t) => {
        const palmSide = Math.max(0, Math.sin(th));
        const thenar = Math.exp(-((th - 1.9) ** 2) * 3.0) * Math.exp(-((t - 0.35) ** 2) * 8);
        const heel = Math.exp(-((th - 1.5) ** 2) * 2.0) * Math.exp(-((t - 0.15) ** 2) * 14);
        return 1 + 0.16 * thenar + 0.13 * heel + 0.03 * palmSide * t;
      },
    });

    // fingers
    for (const key of ['index', 'middle', 'ring', 'little', 'thumb']) {
      const dg = a.digits[key];
      const spec = dg.spec;
      const joints = [];
      for (let j = 0; j < dg.pts.length; j++) {
        joints.push({
          p: dg.pts[j].clone(),
          bone: B(dg.bones[Math.min(j, dg.bones.length - 1)]),
          r: spec.r[j],
        });
      }
      const path = limbPath(joints, {
        sub: 2,
        blend: 0.011,
        // knuckle swell: each joint is thicker than the shaft either side of it
        radiusFn: (t, i, f) => {
          const base = THREE.MathUtils.lerp(spec.r[i], spec.r[i + 1], f);
          const knuck = 0.0013 * Math.exp(-((f - 0.02) ** 2) * 60) + 0.0011 * Math.exp(-((f - 0.98) ** 2) * 60);
          return base + knuck;
        },
      });
      skin.tube(path, { seg, capStart: key === 'thumb', capEnd: true, capScale: 0.9 });

      // fingernail: a flattened glossy plate on the back of the distal phalanx
      if (lod.detail) {
        const last = dg.pts.length - 1;
        const tipDir = _v.copy(dg.pts[last]).sub(dg.pts[last - 1]).normalize();
        const back = _v2.copy(a.Zh).multiplyScalar(-1);
        back.addScaledVector(tipDir, -back.dot(tipDir)).normalize();
        const centre = dg.pts[last - 1].clone()
          .addScaledVector(tipDir, spec.len[last - 1] * 0.55)
          .addScaledVector(back, spec.r[last] * 0.80);
        nails.disc(centre, back, spec.r[last] * 0.78, [[B(dg.bones[dg.bones.length - 1]), 1]], {
          seg: 9, bulge: 0.18, squash: 1.35,
        });
      }
    }
    handInfo[s] = a;
  }

  // ── meshes ────────────────────────────────────────────────────────────────────────────
  const group = new THREE.Group();
  group.name = 'parent';
  group.add(bones[0]);

  const parts = [
    { b: skin, m: metreMat('skin.parent', null) },
    { b: jumper, m: metreMat('cloth.parent', null) },
    { b: trouser, m: metreMat('cloth.parent', 0x8a8175, { roughness: 0.88 }) },
    { b: slipper, m: metreMat('fabric.plush', 0x6d6560, { roughness: 0.92 }) },
    { b: sole, m: metreMat('plastic.matte', 0x2e2b28, { roughness: 0.72 }) },
    { b: hair, m: metreMat('hair.parent', null) },
    { b: sclera, m: mats.get('eye') },
    { b: iris, m: mats.tinted('eye', 0x533f2a, { roughness: 0.13 }) },
    { b: lips, m: mats.tinted('skin.parent', 0xc98070, { roughness: 0.36 }) },
    { b: nails, m: mats.tinted('skin.parent', 0xefcbb6, { roughness: 0.22 }) },
  ];

  const meshes = [];
  for (const part of parts) {
    if (!part.b.idx.length) continue;
    const geo = part.b.toGeometry();
    ctx.track?.(geo);
    const mesh = new THREE.SkinnedMesh(geo, part.m);
    mesh.name = part.b.name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // A skinned character reaching overhead escapes its bind-pose bounds; six extra draw calls
    // are cheaper than the pop.
    mesh.frustumCulled = false;
    group.add(mesh);
    meshes.push(mesh);
  }

  group.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  for (const mesh of meshes) mesh.bind(skeleton);
  ctx.track?.(skeleton);

  // rest lengths the IK needs, measured rather than assumed
  const dims = {
    ...D,
    thigh: legs.L.hip.distanceTo(legs.L.knee),
    shin: legs.L.knee.distanceTo(legs.L.ankle),
    foot: legs.L.ankle.distanceTo(legs.L.ball),
    upperArm: arms.L.shoulder.distanceTo(arms.L.elbow),
    forearm: arms.L.elbow.distanceTo(arms.L.wrist),
    ankleY: legs.L.ankle.y,
    soleDrop: legs.L.ankle.y,
  };

  return { group, bones, byName, skeleton, meshes, dims, legs, arms: handInfo, rest: { legs, arms } };
}
