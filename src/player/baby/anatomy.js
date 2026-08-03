// OPERATION NAPTIME — BABY — the anatomy: bind-pose skeleton and every signed-distance field.
//
// All coordinates are MODEL SPACE, in metres: y = 0 is the floor the baby is crawling on, -Z is
// forward (the direction the baby faces), +X is the baby's own right. The origin sits between the
// shoulders and the hips at floor level, because that is where the physics capsule is centred.
//
// The bind pose is a neutral crawl — hands and knees planted, head up and forward — rather than a
// T-pose. Auto-weighted skin only stays clean while the animated pose is near the bind pose, and a
// crawl that starts from a crawl never rotates a limb more than about 40°, so the elbows and hips
// never collapse into the candy-wrapper twist that kills procedural characters.
//
// Proportions are a ten-month-old scaled up roughly 1.35× so the eye lands at the 0.42 m the
// contract specifies: head 1/4 of the total length, arms and legs the same length as each other,
// a belly that hangs below the ribs, and every limb thicker in the middle than at either joint.
// The creases are not decoration — the deep groove at the wrist and the roll above the knee are
// the two silhouette cues that separate "baby" from "small adult", so they are cut into the field
// as subtracted tori rather than painted into a normal map.

import {
  smin, smax, ssub,
  sdSphere, sdEllipsoid, sdCapsule, sdRoundCone, sdRoundBox, sdTorusAxis,
} from './sdf.js';

const norm3 = (x, y, z) => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};

// ───────────────────────────────────────────────────────────── key landmarks ──

export const A = {
  pelvis: [0, 0.300, 0.115],
  spine1: [0, 0.306, 0.030],
  chest: [0, 0.318, -0.058],
  neck: [0, 0.340, -0.120],
  headJoint: [0, 0.374, -0.164],
  skull: [0, 0.4425, -0.2005],
  eyeR: [0.0385, 0.4215, -0.2845],
  eyeL: [-0.0385, 0.4225, -0.2840], // 1 mm higher: nobody's eyes are level
  earR: [0.0955, 0.4255, -0.1615],
  earL: [-0.0955, 0.4275, -0.1605],
  mouth: [0, 0.4000, -0.2905],
  shoulderR: [0.076, 0.312, -0.086],
  elbowR: [0.086, 0.176, -0.108],
  wristR: [0.088, 0.054, -0.122],
  hipR: [0.062, 0.282, 0.118],
  kneeR: [0.086, 0.062, 0.162],
  ankleR: [0.088, 0.040, 0.278],
  eyeHeight: 0.42,
};

/** Segment lengths the IK needs. */
export const LIMB = {
  upperArm: Math.hypot(A.elbowR[0] - A.shoulderR[0], A.elbowR[1] - A.shoulderR[1], A.elbowR[2] - A.shoulderR[2]),
  foreArm: Math.hypot(A.wristR[0] - A.elbowR[0], A.wristR[1] - A.elbowR[1], A.wristR[2] - A.elbowR[2]),
  thigh: Math.hypot(A.kneeR[0] - A.hipR[0], A.kneeR[1] - A.hipR[1], A.kneeR[2] - A.hipR[2]),
  shin: Math.hypot(A.ankleR[0] - A.kneeR[0], A.ankleR[1] - A.kneeR[1], A.ankleR[2] - A.kneeR[2]),
};

/**
 * Where each of the four contact points sits, in body space, when the baby is standing still on
 * all fours. The gait swings around these.
 */
export const CONTACT = {
  handR: [0.088, 0.0, -0.150],
  handL: [-0.088, 0.0, -0.150],
  kneeR: [0.086, 0.0, 0.162],
  kneeL: [-0.086, 0.0, 0.162],
};

/** The plane that separates "head" geometry from "body" geometry (first person hides the head). */
export const HEAD_SPLIT = { point: [0, 0.3520, -0.1380], normal: norm3(0, 0.60, -0.80) };

// ─────────────────────────────────────────────────────────────────── skeleton ──

/**
 * Bind rotations are all identity and only translations are authored, which makes every later
 * calculation trivial: a bone's local frame is its parent's frame, so "aim this bone" is one
 * setFromUnitVectors against its rest direction.
 *
 *   pos   bind position in model space
 *   dir   the bone's own axis (toward its child), in model space == its local frame at bind
 *   seg   [ax,ay,az, bx,by,bz, radius] the capsule used to auto-weight vertices to this bone
 *   w     weight multiplier — how greedy this bone is when it competes for a vertex
 */
export const BONES = [
  { name: 'root', parent: null, pos: A.pelvis, dir: norm3(0, 0.006, -0.085), seg: [0, 0.300, 0.128, 0, 0.306, 0.045, 0.112], w: 1.0 },
  { name: 'spine1', parent: 'root', pos: A.spine1, dir: norm3(0, 0.012, -0.088), seg: [0, 0.304, 0.045, 0, 0.312, -0.022, 0.108], w: 1.0 },
  { name: 'spine2', parent: 'spine1', pos: A.chest, dir: norm3(0, 0.022, -0.062), seg: [0, 0.316, -0.030, 0, 0.330, -0.098, 0.104], w: 1.0 },
  { name: 'neck', parent: 'spine2', pos: A.neck, dir: norm3(0, 0.034, -0.044), seg: [0, 0.338, -0.116, 0, 0.362, -0.148, 0.062], w: 0.95 },
  { name: 'head', parent: 'neck', pos: A.headJoint, dir: norm3(0, 0.0685, -0.0365), seg: [0, 0.380, -0.176, 0, 0.452, -0.240, 0.132], w: 1.15 },
  { name: 'jaw', parent: 'head', pos: [0, 0.4040, -0.2220], dir: norm3(0, -0.40, -0.92), seg: [0, 0.400, -0.230, 0, 0.386, -0.272, 0.042], w: 0.55 },
  { name: 'cheekR', parent: 'head', pos: [0.0505, 0.4035, -0.2545], dir: [0, 0, -1], seg: [0.0505, 0.4035, -0.2545, 0.0505, 0.4035, -0.2545, 0.040], w: 0.5 },
  { name: 'cheekL', parent: 'head', pos: [-0.0505, 0.4045, -0.2535], dir: [0, 0, -1], seg: [-0.0505, 0.4045, -0.2535, -0.0505, 0.4045, -0.2535, 0.040], w: 0.5 },

  { name: 'clavR', parent: 'spine2', pos: [0.030, 0.3235, -0.0805], dir: norm3(0.046, -0.0115, -0.0055), seg: [0.018, 0.324, -0.080, 0.062, 0.316, -0.084, 0.050], w: 0.8 },
  { name: 'armR', parent: 'clavR', pos: A.shoulderR, dir: norm3(0.010, -0.136, -0.022), seg: [0.076, 0.310, -0.086, 0.086, 0.178, -0.108, 0.053], w: 1.0 },
  { name: 'foreR', parent: 'armR', pos: A.elbowR, dir: norm3(0.002, -0.122, -0.014), seg: [0.086, 0.172, -0.108, 0.088, 0.058, -0.122, 0.046], w: 1.0 },
  { name: 'handR', parent: 'foreR', pos: A.wristR, dir: norm3(0, -0.28, -0.96), seg: [0.088, 0.040, -0.130, 0.088, 0.018, -0.180, 0.045], w: 1.0 },

  { name: 'clavL', parent: 'spine2', pos: [-0.030, 0.3235, -0.0805], dir: norm3(-0.046, -0.0115, -0.0055), seg: [-0.018, 0.324, -0.080, -0.062, 0.316, -0.084, 0.050], w: 0.8 },
  { name: 'armL', parent: 'clavL', pos: [-0.076, 0.312, -0.086], dir: norm3(-0.010, -0.136, -0.022), seg: [-0.076, 0.310, -0.086, -0.086, 0.178, -0.108, 0.053], w: 1.0 },
  { name: 'foreL', parent: 'armL', pos: [-0.086, 0.176, -0.108], dir: norm3(-0.002, -0.122, -0.014), seg: [-0.086, 0.172, -0.108, -0.088, 0.058, -0.122, 0.046], w: 1.0 },
  { name: 'handL', parent: 'foreL', pos: [-0.088, 0.054, -0.122], dir: norm3(0, -0.28, -0.96), seg: [-0.088, 0.040, -0.130, -0.088, 0.018, -0.180, 0.045], w: 1.0 },

  { name: 'thighR', parent: 'root', pos: A.hipR, dir: norm3(0.024, -0.220, 0.044), seg: [0.062, 0.278, 0.118, 0.086, 0.066, 0.160, 0.078], w: 1.0 },
  { name: 'shinR', parent: 'thighR', pos: A.kneeR, dir: norm3(0.002, -0.022, 0.116), seg: [0.086, 0.060, 0.164, 0.088, 0.042, 0.272, 0.055], w: 1.0 },
  { name: 'footR', parent: 'shinR', pos: A.ankleR, dir: norm3(0, -0.19, 0.98), seg: [0.088, 0.040, 0.284, 0.088, 0.018, 0.336, 0.050], w: 1.0 },

  { name: 'thighL', parent: 'root', pos: [-0.062, 0.282, 0.118], dir: norm3(-0.024, -0.220, 0.044), seg: [-0.062, 0.278, 0.118, -0.086, 0.066, 0.160, 0.078], w: 1.0 },
  { name: 'shinL', parent: 'thighL', pos: [-0.086, 0.062, 0.162], dir: norm3(-0.002, -0.022, 0.116), seg: [-0.086, 0.060, 0.164, -0.088, 0.042, 0.272, 0.055], w: 1.0 },
  { name: 'footL', parent: 'shinL', pos: [-0.088, 0.040, 0.278], dir: norm3(0, -0.19, 0.98), seg: [-0.088, 0.040, 0.284, -0.088, 0.018, 0.336, 0.050], w: 1.0 },

  { name: 'belly', parent: 'spine1', pos: [0, 0.264, 0.028], dir: [0, -1, 0], seg: [0, 0.250, 0.010, 0, 0.240, 0.052, 0.070], w: 0.62 },
  { name: 'nappy', parent: 'root', pos: [0, 0.270, 0.108], dir: [0, -1, 0], seg: [0, 0.268, 0.090, 0, 0.250, 0.140, 0.086], w: 0.55 },
];

export const BONE_INDEX = (() => {
  const m = Object.create(null);
  BONES.forEach((b, i) => { m[b.name] = i; });
  return m;
})();

// ────────────────────────────────────────────────────────────── skin: the head ──

// The head is queried through a small yaw so the whole skull is turned 2.4° to the baby's left.
// Rotating the query point is the cheapest possible asymmetry and it moves the ears, the eyes and
// the mouth together, which is what makes it read as a real head rather than a mirrored one.
const HEAD_YAW = 0.042;
const HY_C = Math.cos(HEAD_YAW);
const HY_S = Math.sin(HEAD_YAW);

function headField(px, py, pz) {
  // inverse-rotate about the head joint
  const ox = px - A.headJoint[0];
  const oz = pz - A.headJoint[2];
  const x = A.headJoint[0] + ox * HY_C - oz * HY_S;
  const z = A.headJoint[2] + ox * HY_S + oz * HY_C;
  const y = py;

  // cranium — a touch wider than deep, flat at the back where a baby has lain on it
  let d = sdEllipsoid(x, y, z, 0, 0.4425, -0.1975, 0.0995, 0.1010, 0.0985);
  // the face/jaw mass
  d = smin(d, sdEllipsoid(x, y, z, 0, 0.4030, -0.2380, 0.0790, 0.0705, 0.0755), 0.048);
  // cheeks — the left one is fuller, as everyone's is
  d = smin(d, sdSphere(x, y, z, 0.0545, 0.4030, -0.2565, 0.0378), 0.030);
  d = smin(d, sdSphere(x, y, z, -0.0530, 0.4055, -0.2545, 0.0392), 0.030);
  // chin and the double chin that a ten-month-old wears instead of a neck
  d = smin(d, sdSphere(x, y, z, 0, 0.3808, -0.2645, 0.0330), 0.030);
  d = smin(d, sdSphere(x, y, z, 0, 0.3735, -0.2270, 0.0455), 0.036);
  d = smin(d, sdSphere(x, y, z, 0, 0.3660, -0.1880, 0.0470), 0.038);
  // brow pads
  d = smin(d, sdEllipsoid(x, y, z, 0.0355, 0.4400, -0.2760, 0.0270, 0.0125, 0.0175), 0.022);
  d = smin(d, sdEllipsoid(x, y, z, -0.0355, 0.4408, -0.2755, 0.0272, 0.0126, 0.0176), 0.022);
  // button nose + the bridge, then two nostril dimples
  d = smin(d, sdSphere(x, y, z, 0, 0.4130, -0.2930, 0.0152), 0.016);
  d = smin(d, sdRoundCone(x, y, z, 0, 0.4330, -0.2790, 0, 0.4160, -0.2900, 0.0120, 0.0140), 0.018);
  d = ssub(d, sdSphere(x, y, z, 0.0072, 0.4062, -0.2928, 0.0052), 0.004);
  d = ssub(d, sdSphere(x, y, z, -0.0072, 0.4062, -0.2928, 0.0052), 0.004);
  // lips
  d = smin(d, sdEllipsoid(x, y, z, 0, 0.4058, -0.2895, 0.0200, 0.0062, 0.0092), 0.009);
  d = smin(d, sdEllipsoid(x, y, z, 0, 0.3942, -0.2882, 0.0186, 0.0070, 0.0090), 0.009);
  // the mouth itself, slightly open — babies crawl with their mouth open
  d = ssub(d, sdEllipsoid(x, y, z, 0, 0.4000, -0.2935, 0.0178, 0.0064, 0.0150), 0.005);
  // eye sockets, then lids over the top of them
  d = ssub(d, sdEllipsoid(x, y, z, A.eyeR[0], A.eyeR[1], A.eyeR[2], 0.0182, 0.0112, 0.0172), 0.0035);
  d = ssub(d, sdEllipsoid(x, y, z, A.eyeL[0], A.eyeL[1], A.eyeL[2], 0.0182, 0.0112, 0.0172), 0.0035);
  d = smin(d, sdEllipsoid(x, y, z, 0.0385, 0.4318, -0.2820, 0.0210, 0.0090, 0.0130), 0.010);
  d = smin(d, sdEllipsoid(x, y, z, -0.0385, 0.4328, -0.2815, 0.0210, 0.0090, 0.0130), 0.010);
  d = smin(d, sdEllipsoid(x, y, z, 0.0385, 0.4118, -0.2830, 0.0195, 0.0068, 0.0120), 0.010);
  d = smin(d, sdEllipsoid(x, y, z, -0.0385, 0.4126, -0.2826, 0.0195, 0.0068, 0.0120), 0.010);
  // …and then open them. The two lid lobes close over each other, so without this cut the baby is
  // sculpted asleep. The aperture is an almond because it is a shallow ellipsoid intersecting a
  // curved surface: 20 mm wide by 10.6 mm tall at the skin, tapering to nothing at the canthi, and
  // narrower than the eyeball behind it so no line of sight reaches the empty socket. The soft
  // subtraction (k = 2 mm) leaves a rounded lid margin rather than a knife edge.
  d = ssub(d, sdEllipsoid(x, y, z, 0.0385, 0.4212, -0.2870, 0.0135, 0.0072, 0.0125), 0.0022);
  d = ssub(d, sdEllipsoid(x, y, z, -0.0385, 0.4222, -0.2866, 0.0134, 0.0070, 0.0125), 0.0022);
  // A crease above each lid — every baby has one, and it catches the window light.
  d = ssub(d, sdTorusAxis(x, y, z, 0.0385, 0.4386, -0.2760, 0.10, 0.28, 0.955, 0.0205, 0.0036), 0.006);
  d = ssub(d, sdTorusAxis(x, y, z, -0.0385, 0.4396, -0.2756, -0.10, 0.28, 0.955, 0.0205, 0.0036), 0.006);
  // the fontanelle dip, still soft at ten months
  d = smax(d, -sdSphere(x, y, z, 0.004, 0.5760, -0.2060, 0.0400), 0.026);
  // neck
  d = smin(d, sdRoundCone(x, y, z, 0, 0.3300, -0.0980, 0, 0.3800, -0.1720, 0.0620, 0.0530), 0.040);
  return d;
}

// ────────────────────────────────────────────────────────── skin: torso, limbs ──

function torsoField(x, y, z) {
  // ribcage → hips
  let d = sdRoundCone(x, y, z, 0, 0.3230, -0.0740, 0, 0.2980, 0.1080, 0.0985, 0.1010);
  // the belly, hanging below and forward of the ribs
  d = smin(d, sdSphere(x, y, z, 0.002, 0.2620, 0.0250, 0.0985), 0.055);
  // shoulders
  d = smin(d, sdSphere(x, y, z, 0.0730, 0.3140, -0.0850, 0.0555), 0.038);
  d = smin(d, sdSphere(x, y, z, -0.0725, 0.3150, -0.0845, 0.0560), 0.038);
  // buttocks
  d = smin(d, sdEllipsoid(x, y, z, 0.0400, 0.2960, 0.1420, 0.0560, 0.0620, 0.0560), 0.045);
  d = smin(d, sdEllipsoid(x, y, z, -0.0400, 0.2975, 0.1415, 0.0565, 0.0625, 0.0560), 0.045);
  // navel — off centre, as they always are
  d = ssub(d, sdSphere(x, y, z, 0.0058, 0.1690, 0.0300, 0.0092), 0.006);
  // a soft roll where the belly meets the chest
  d = ssub(d, sdTorusAxis(x, y, z, 0, 0.2820, -0.0180, 0, -0.12, 0.99, 0.0930, 0.0090), 0.028);
  return d;
}

function armField(x, y, z, s, seed) {
  const shoulder = [0.076 * s, 0.312, -0.086];
  const elbow = [0.086 * s, 0.176, -0.108];
  const wrist = [0.088 * s, 0.054, -0.122];
  const fat = seed;
  let d = sdRoundCone(x, y, z, shoulder[0], shoulder[1], shoulder[2], elbow[0], elbow[1], elbow[2], 0.0495, 0.0410);
  d = smin(d, sdSphere(x, y, z, 0.0810 * s, 0.2500, -0.0955, 0.0468 + fat), 0.034);
  d = smin(d, sdSphere(x, y, z, elbow[0], elbow[1], elbow[2], 0.0425), 0.028);
  d = smin(d, sdRoundCone(x, y, z, elbow[0], elbow[1], elbow[2], wrist[0], wrist[1] + 0.006, wrist[2], 0.0430, 0.0322), 0.024);
  d = smin(d, sdSphere(x, y, z, 0.0872 * s, 0.1290, -0.1140, 0.0428 + fat), 0.030);
  // the bracelet crease above the wrist — the single most "baby" line on the whole arm
  const fdir = [0.002 * s, -0.122, -0.014];
  const fl = Math.hypot(fdir[0], fdir[1], fdir[2]);
  d = ssub(d, sdTorusAxis(x, y, z, 0.0880 * s, 0.0700, -0.1215, fdir[0] / fl, fdir[1] / fl, fdir[2] / fl, 0.0300, 0.0092), 0.011);
  // and the softer one under the elbow
  d = ssub(d, sdTorusAxis(x, y, z, 0.0842 * s, 0.2140, -0.1012, fdir[0] / fl, fdir[1] / fl, fdir[2] / fl, 0.0400, 0.0080), 0.014);
  return d;
}

function legField(x, y, z, s, seed) {
  const hip = [0.062 * s, 0.284, 0.116];
  const knee = [0.086 * s, 0.062, 0.162];
  const ankle = [0.088 * s, 0.042, 0.272];
  const fat = seed;
  let d = sdRoundCone(x, y, z, hip[0], hip[1], hip[2], knee[0], knee[1], knee[2], 0.0720, 0.0480);
  d = smin(d, sdSphere(x, y, z, 0.0722 * s, 0.1900, 0.1360, 0.0660 + fat), 0.040);
  d = smin(d, sdSphere(x, y, z, knee[0], knee[1], knee[2], 0.0482), 0.028);
  d = smin(d, sdRoundCone(x, y, z, knee[0], knee[1], knee[2], ankle[0], ankle[1], ankle[2], 0.0462, 0.0338), 0.026);
  d = smin(d, sdSphere(x, y, z, 0.0872 * s, 0.0505, 0.2120, 0.0420 + fat), 0.030);
  const tdir = [0.024 * s, -0.220, 0.044];
  const tl = Math.hypot(tdir[0], tdir[1], tdir[2]);
  // the thigh roll: deep on the right, deeper still on the left
  d = ssub(d, sdTorusAxis(x, y, z, 0.0762 * s, 0.1560, 0.1450, tdir[0] / tl, tdir[1] / tl, tdir[2] / tl, 0.0620, 0.0110 + fat * 0.6), 0.015);
  const sdir = [0.002 * s, -0.022, 0.116];
  const sl = Math.hypot(sdir[0], sdir[1], sdir[2]);
  d = ssub(d, sdTorusAxis(x, y, z, 0.0880 * s, 0.0432, 0.2620, sdir[0] / sl, sdir[1] / sl, sdir[2] / sl, 0.0300, 0.0072), 0.009);
  return d;
}

// Bounding spheres so a grid corner three voxels from the surface costs six flops instead of two
// hundred. Radii are generous: a group is only skipped when it cannot possibly win the smooth min.
const GROUPS = [
  { c: [0, 0.428, -0.222], r: 0.232, k: 0.055, f: headField },
  { c: [0, 0.288, 0.020], r: 0.215, k: 0.055, f: torsoField },
  { c: [0.084, 0.186, -0.104], r: 0.196, k: 0.050, f: (x, y, z) => armField(x, y, z, 1, 0.0000) },
  { c: [-0.084, 0.186, -0.104], r: 0.196, k: 0.050, f: (x, y, z) => armField(x, y, z, -1, 0.0015) },
  { c: [0.080, 0.168, 0.190], r: 0.218, k: 0.052, f: (x, y, z) => legField(x, y, z, 1, 0.0000) },
  { c: [-0.080, 0.168, 0.190], r: 0.218, k: 0.052, f: (x, y, z) => legField(x, y, z, -1, 0.0018) },
];

/** The bare skin: head, torso and all four limbs, minus the hands and feet. */
export function skinField(x, y, z) {
  let d = 1e9;
  for (let i = 0; i < GROUPS.length; i++) {
    const g = GROUPS[i];
    const dx = x - g.c[0];
    const dy = y - g.c[1];
    const dz = z - g.c[2];
    const lower = Math.sqrt(dx * dx + dy * dy + dz * dz) - g.r;
    if (lower > d + g.k) continue;
    d = smin(d, g.f(x, y, z), g.k);
  }
  return d;
}

export const SKIN_BOUNDS = { min: [-0.152, -0.006, -0.322], max: [0.152, 0.556, 0.320] };

// ─────────────────────────────────────────────────────────────── hands & feet ──

/** Right hand, planted palm-down. Built in model space so no local frame gymnastics are needed. */
export function handField(x, y, z) {
  // wrist stub — deliberately long so it overlaps the forearm and the seam cannot open
  let d = sdRoundCone(x, y, z, 0.0880, 0.0760, -0.1180, 0.0880, 0.0300, -0.1320, 0.0300, 0.0258);
  d = smin(d, sdRoundBox(x, y, z, 0.0880, 0.0202, -0.1500, 0.0285, 0.0142, 0.0262, 0.0102), 0.020);
  d = smin(d, sdSphere(x, y, z, 0.0880, 0.0226, -0.1320, 0.0242), 0.020);

  // four fingers, splayed and slightly curled, middle pair longest
  const baseX = [-0.0212, -0.0072, 0.0072, 0.0208];
  const midX = [-0.0262, -0.0086, 0.0088, 0.0250];
  const tipX = [-0.0316, -0.0102, 0.0104, 0.0292];
  const midZ = [-0.1830, -0.1868, -0.1858, -0.1806];
  const tipZ = [-0.1948, -0.2016, -0.2000, -0.1918];
  for (let i = 0; i < 4; i++) {
    const bx = 0.0880 + baseX[i];
    const mx = 0.0880 + midX[i];
    const tx = 0.0880 + tipX[i];
    d = smin(d, sdRoundCone(x, y, z, bx, 0.0208, -0.1660, mx, 0.0176, midZ[i], 0.0108, 0.0092), 0.010);
    d = smin(d, sdRoundCone(x, y, z, mx, 0.0176, midZ[i], tx, 0.0118, tipZ[i], 0.0092, 0.0074), 0.008);
    // knuckle dimple on the back of the hand
    d = ssub(d, sdSphere(x, y, z, bx, 0.0348, -0.1636, 0.0072), 0.008);
  }
  // thumb, tucked in and down
  d = smin(d, sdRoundCone(x, y, z, 0.0648, 0.0212, -0.1430, 0.0508, 0.0158, -0.1596, 0.0128, 0.0096), 0.012);
  return d;
}

export const HAND_BOUNDS = { min: [0.0440, -0.0040, -0.2120], max: [0.1330, 0.0800, -0.0960] };

/** Right foot, trailing behind with the top of the foot toward the floor. */
export function footField(x, y, z) {
  let d = sdSphere(x, y, z, 0.0880, 0.0446, 0.2740, 0.0322);
  d = smin(d, sdRoundCone(x, y, z, 0.0880, 0.0368, 0.2840, 0.0880, 0.0206, 0.3268, 0.0300, 0.0238), 0.022);
  d = smin(d, sdSphere(x, y, z, 0.0880, 0.0306, 0.2680, 0.0284), 0.022);
  const tx = [-0.0212, -0.0090, 0.0032, 0.0142, 0.0242];
  const tr = [0.0096, 0.0086, 0.0079, 0.0071, 0.0063];
  for (let i = 0; i < 5; i++) {
    const x0 = 0.0880 + tx[i] * 0.86;
    const x1 = 0.0880 + tx[i];
    d = smin(d, sdRoundCone(x, y, z, x0, 0.0186, 0.3300, x1, 0.0142, 0.3446 - i * 0.0018, tr[i], tr[i] * 0.82), 0.009);
  }
  d = ssub(d, sdTorusAxis(x, y, z, 0.0880, 0.0522, 0.2716, 0, -0.19, 0.98, 0.0288, 0.0072), 0.010);
  return d;
}

export const FOOT_BOUNDS = { min: [0.0480, -0.0040, 0.2340], max: [0.1300, 0.0840, 0.3580] };

/** Right ear. Thin enough to need its own fine grid, and thin enough to glow at the rim. */
export function earField(x, y, z) {
  let d = sdEllipsoid(x, y, z, 0.0962, 0.4262, -0.1615, 0.0092, 0.0300, 0.0212);
  d = smin(d, sdTorusAxis(x, y, z, 0.0958, 0.4282, -0.1590, 1, 0, 0, 0.0208, 0.0052), 0.006);
  d = smin(d, sdSphere(x, y, z, 0.0946, 0.4002, -0.1560, 0.0102), 0.008);
  d = smin(d, sdRoundCone(x, y, z, 0.0840, 0.4240, -0.1650, 0.0952, 0.4262, -0.1620, 0.0150, 0.0120), 0.010);
  // the concha, scooped out of the front
  d = ssub(d, sdEllipsoid(x, y, z, 0.0996, 0.4238, -0.1668, 0.0090, 0.0186, 0.0128), 0.004);
  d = ssub(d, sdEllipsoid(x, y, z, 0.1010, 0.4380, -0.1520, 0.0070, 0.0120, 0.0092), 0.004);
  return d;
}

export const EAR_BOUNDS = { min: [0.0790, 0.3860, -0.1900], max: [0.1120, 0.4640, -0.1300] };

// ──────────────────────────────────────────────────────────────────── clothes ──

/**
 * The vest. A solid volume 11 mm outside the torso, cut off by a wavy plane at the waist so the
 * nappy can peek out over the hem — which is exactly how a real baby wears one.
 */
export function onesieField(x, y, z) {
  let d = sdRoundCone(x, y, z, 0, 0.3250, -0.0760, 0, 0.3000, 0.1000, 0.1090, 0.1120);
  d = smin(d, sdSphere(x, y, z, 0.002, 0.2650, 0.0230, 0.1085), 0.055);
  d = smin(d, sdSphere(x, y, z, 0.0740, 0.3160, -0.0850, 0.0650), 0.040);
  d = smin(d, sdSphere(x, y, z, -0.0735, 0.3170, -0.0845, 0.0655), 0.040);
  // short sleeves with a rolled cuff
  d = smin(d, sdRoundCone(x, y, z, 0.0760, 0.3140, -0.0860, 0.0824, 0.2420, -0.0982, 0.0620, 0.0520), 0.028);
  d = smin(d, sdRoundCone(x, y, z, -0.0760, 0.3150, -0.0858, -0.0824, 0.2440, -0.0980, 0.0620, 0.0522), 0.028);
  d = smin(d, sdTorusAxis(x, y, z, 0.0822, 0.2452, -0.0976, 0.0435, -0.9860, -0.0830, 0.0480, 0.0072), 0.010);
  d = smin(d, sdTorusAxis(x, y, z, -0.0822, 0.2472, -0.0974, -0.0435, -0.9860, -0.0830, 0.0480, 0.0072), 0.010);
  // neck hole + a ribbed collar around it
  d = ssub(d, sdEllipsoid(x, y, z, 0, 0.3660, -0.1330, 0.0640, 0.0620, 0.0620), 0.012);
  d = smin(d, sdTorusAxis(x, y, z, 0, 0.3452, -0.1108, 0, 0.44, -0.90, 0.0600, 0.0082), 0.012);
  // the hem: a plane perpendicular to the spine, with a fabric wave in it
  const hemWave = 0.0130 * Math.sin(x * 21.0) + 0.0085 * Math.sin(x * 47.0 + 1.7) + 0.0060 * Math.sin(y * 33.0);
  const hem = (x - 0) * 0.0 + (y - 0.2900) * -0.1200 + (z - (0.0560 + hemWave)) * 0.9928;
  d = smax(d, hem, 0.010);
  // two soft folds where the fabric gathers over the hips
  d = ssub(d, sdCapsule(x, y, z, 0.0560, 0.2440, 0.0180, 0.0900, 0.2900, -0.0260, 0.0062), 0.014);
  d = ssub(d, sdCapsule(x, y, z, -0.0520, 0.2400, 0.0220, -0.0880, 0.2880, -0.0200, 0.0058), 0.014);
  d = ssub(d, sdCapsule(x, y, z, -0.0180, 0.2200, 0.0100, 0.0260, 0.2180, 0.0140, 0.0050), 0.016);
  return d;
}

export const ONESIE_BOUNDS = { min: [-0.156, 0.176, -0.190], max: [0.156, 0.400, 0.110] };

/** The nappy: bulky, high at the back, with elastic at the waist and both legs. */
export function nappyField(x, y, z) {
  let d = sdRoundBox(x, y, z, 0, 0.2660, 0.1140, 0.1005, 0.0800, 0.0900, 0.0560);
  d = smin(d, sdSphere(x, y, z, 0, 0.2060, 0.0760, 0.0625), 0.045);
  d = smin(d, sdEllipsoid(x, y, z, 0, 0.3020, 0.1540, 0.0900, 0.0680, 0.0700), 0.045);
  // waistband
  d = smin(d, sdTorusAxis(x, y, z, 0, 0.2880, 0.0460, 0, -0.1200, 0.9928, 0.0975, 0.0098), 0.014);
  // leg elastics, following the thigh axis
  d = smin(d, sdTorusAxis(x, y, z, 0.0700, 0.2440, 0.1400, 0.1070, -0.9800, 0.1960, 0.0640, 0.0088), 0.012);
  d = smin(d, sdTorusAxis(x, y, z, -0.0700, 0.2455, 0.1395, -0.1070, -0.9800, 0.1960, 0.0640, 0.0088), 0.012);
  // hip tabs
  d = smin(d, sdRoundBox(x, y, z, 0.0805, 0.2400, 0.0420, 0.0250, 0.0195, 0.0110, 0.0070), 0.010);
  d = smin(d, sdRoundBox(x, y, z, -0.0805, 0.2415, 0.0425, 0.0250, 0.0195, 0.0110, 0.0070), 0.010);
  // a crinkle crease across the back
  d = ssub(d, sdCapsule(x, y, z, -0.0700, 0.3260, 0.1520, 0.0700, 0.3280, 0.1560, 0.0050), 0.016);
  return d;
}

export const NAPPY_BOUNDS = { min: [-0.118, 0.132, -0.010], max: [0.118, 0.392, 0.238] };
