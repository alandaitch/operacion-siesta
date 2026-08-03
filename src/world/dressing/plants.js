// OPERATION NAPTIME — module DRESS — the monstera, the second plant, and the balcony greenery.
//
// The monstera is the single highest-value object in the game (800 points, noise 1.0, spills soil)
// and the hardest thing in the room to make look alive, because a houseplant fails in exactly one
// way: flat leaves. A monstera leaf is never flat. It is a shallow channel folded up around the
// midrib, arced over along its length under its own weight, twisted a few degrees about the
// petiole, and rippled along the margin — four separate curvatures, all of which have to be
// GEOMETRY, because the whole read of the plant is how the raking window light breaks across those
// curves into a bright top surface, a dark channel and a translucent backlit edge. The
// fenestrations and the marginal splits come from the alphaMap in `leaf.monstera` (alphaTest, so
// they are real holes), which means the blade itself is a subdivided rectangle and every bit of
// its shape comes from `leafGeometry` below.
//
// The petioles are Catmull-Rom tubes, tapered, all emerging from one crown in the compost and
// leaning toward the glazing at -Z, which is what a plant on a windowsill actually does. Nine
// leaves at nine different reaches and heights; the ninth has almost no rise, the deepest droop
// and a yellow tint, because every real monstera has one leaf that is on its way out.
//
// The pot is the only thing with a rigid body: a cylinder, dynamic from frame one. Knock it and
// `onTopple` reveals a pre-built compost spill under wherever the pot has ended up.

import * as THREE from 'three';
import {
  lathe, spline, deform, noise2, tubeAlong, mergeGeos, place, clamp, ellipsoid,
} from './util.js';

const UP = new THREE.Vector3(0, 1, 0);

// ────────────────────────────────────────────────────────────────── helpers ──

/**
 * A radial disc whose height comes from a callback — compost in a pot, a spill on the floor.
 * `height(rn, theta)` takes a normalised radius and an angle and returns y.
 */
function moundDisc({ radius, rings = 8, segments = 26, height }) {
  const verts = [];
  const uvs = [];
  const idx = [];
  verts.push(0, height(0, 0), 0);
  uvs.push(0.5, 0.5);
  for (let r = 1; r <= rings; r++) {
    const rn = r / rings;
    for (let s = 0; s < segments; s++) {
      const th = (s / segments) * Math.PI * 2;
      const rad = radius * rn;
      verts.push(Math.cos(th) * rad, height(rn, th), Math.sin(th) * rad);
      uvs.push(0.5 + Math.cos(th) * rn * 0.5, 0.5 + Math.sin(th) * rn * 0.5);
    }
  }
  for (let s = 0; s < segments; s++) idx.push(0, 1 + ((s + 1) % segments), 1 + s);
  for (let r = 1; r < rings; r++) {
    const a = 1 + (r - 1) * segments;
    const b = 1 + r * segments;
    for (let s = 0; s < segments; s++) {
      const s2 = (s + 1) % segments;
      idx.push(a + s, a + s2, b + s, a + s2, b + s2, b + s);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * One leaf blade. Authored flat in XY — base at the origin, tip at +Y, face normal +Z — then bent
 * on four axes at once. The caller orients the whole thing onto the end of its petiole.
 */
function leafGeometry({
  length, width, cup = 0.17, droop = 0.30, twist = 0.18, ripple = 0.010, seed = 11,
  wSeg = 10, hSeg = 16,
}) {
  const geo = new THREE.PlaneGeometry(width, length, wSeg, hSeg);
  geo.translate(0, length * 0.5, 0);
  deform(geo, (p, uv) => {
    const v = uv.y;                    // 0 at the petiole, 1 at the tip
    const au = Math.abs(uv.x * 2 - 1); // 0 on the midrib, 1 at the margin
    // 1 — the channel. The halves lift away from the midrib, hardest at mid-blade, so the leaf
    //     reads as a shallow gutter and the specular runs as a line down the centre.
    const chan = cup * au ** 1.65 * (0.30 + 0.70 * Math.sin(Math.PI * Math.min(1, v * 1.06)));
    // 2 — the arc. The blade falls away from the base under its own weight.
    const arc = droop * v * v;
    p.z += (chan - arc) * length;
    // Shorten the projection so the arc does not stretch the blade: this keeps the arc LENGTH
    // equal to `length`, which is why the leaf still reads at the right size once it is bent.
    p.y -= arc * arc * length * 0.42;
    // 3 — the twist about the petiole axis.
    const th = twist * v * v;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const x = p.x;
    const z = p.z;
    p.x = x * c - z * s;
    p.z = x * s + z * c;
    // 4 — the margin ripple, strongest at the edge and absent on the midrib.
    p.z += (noise2(uv.x * 5.5, uv.y * 3.5, 1, seed, 2) - 0.5) * ripple * (0.25 + au * 1.4);
  });
  return geo;
}

/** Orient a leaf onto the end of a curve: +Y along the tangent, +Z as close to world up as it can. */
function orientToTangent(obj, tangent, roll) {
  const y = tangent.clone().normalize();
  const z = UP.clone().addScaledVector(y, -UP.dot(y));
  if (z.lengthSq() < 1e-6) z.set(0, 0, 1);
  z.normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  obj.quaternion.setFromRotationMatrix(m);
  if (roll) obj.rotateY(roll);
}

// ──────────────────────────────────────────────────────────────── the pot ────

/**
 * A thrown pot: tapered body, a rolled lip, and the profile folds back down the inside so the
 * mouth is genuinely hollow rather than a solid plug with a soil sticker on top.
 */
function potGeometry(D, { height, rBase, rTop, ribs = 0.0009, seed = 700, wall = 0.007, inner = 0.55 }) {
  const outer = spline([
    [0.00, rBase], [0.05, rBase * 1.08], [0.14, rBase * 1.16],
    [0.48, rBase + (rTop - rBase) * 0.72], [0.82, rTop * 0.985], [1.00, rTop],
  ]);
  const path = (t) => {
    if (t <= 0.80) {
      const u = t / 0.80;
      return { r: Math.max(0.004, outer(u)), y: u * height };
    }
    if (t <= 0.87) {
      const k = (t - 0.80) / 0.07;
      return { r: rTop - k * wall * 0.35, y: height + Math.sin(k * Math.PI * 0.5) * 0.005 };
    }
    const k = (t - 0.87) / 0.13;
    return {
      r: Math.max(0.004, (rTop - wall) * (1 - k * 0.10)),
      y: height + 0.005 - k * (height * inner),
    };
  };
  return lathe({
    path,
    rings: D.lod(20, 30, 44, 56),
    segments: D.lod(18, 26, 40, 52),
    closeBottom: true,
    closeTop: false,
    // Faint throwing rings and a hand-made wobble: a machined cylinder of revolution is the tell.
    perturb: (t, th) => (t > 0.85 ? 0 : ribs * Math.sin(t * 46)
      + 0.0016 * (noise2(Math.cos(th) * 1.6 + 3, Math.sin(th) * 1.6 + t * 4, 1, seed, 3) - 0.5)),
  });
}

/** Compost: dished, lumpy, sitting below the rim. */
function soilMesh(D, { radius, y, dip = 0.012, seed = 91 }) {
  const geo = moundDisc({
    radius,
    rings: D.lod(4, 6, 8, 10),
    segments: D.lod(14, 20, 26, 34),
    height: (rn, th) => y - dip * (1 - rn * rn) * 0.35
      + (noise2(Math.cos(th) * rn * 2.2 + 4, Math.sin(th) * rn * 2.2 + 4, 1, seed, 3) - 0.5) * 0.011
      - rn ** 6 * 0.004,
  });
  return D.mesh(geo, D.mat('soil'), { name: 'plant.soil', cast: false });
}

/** Bark-grey pebbles dressing the compost, and a few that have been kicked onto the floor. */
function pebbles(D, parent, { count, radius, y, spread, seed }) {
  const rng = D.stream(seed);
  const geo = ellipsoid(0.011, 0.007, 0.013, 7, 5);
  const mat = D.tint('soil', 0xb7b0a2, { roughRange: [0.62, 0.88], normalScale: 0.6 });
  const inst = D.instanced(geo, mat, count, { name: 'plant.pebbles', receive: true });
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const th = rng() * Math.PI * 2;
    const r = radius * (0.18 + 0.82 * Math.sqrt(rng())) * spread;
    e.set(rng() * 3.14, rng() * 6.28, rng() * 3.14);
    q.setFromEuler(e);
    p.set(Math.cos(th) * r, y + rng() * 0.004, Math.sin(th) * r);
    const k = 0.55 + rng() * 0.85;
    s.set(k, k * (0.7 + rng() * 0.5), k);
    inst.setMatrixAt(i, m.compose(p, q, s));
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.computeBoundingSphere();
  inst.castShadow = D.atLeast('medium');
  parent.add(inst);
  return inst;
}

// ─────────────────────────────────────────────────────────────── monstera ────

/**
 * The glazing is at z −4.615 with its frame face at −4.570, and the pot centre is only 0.45 m
 * clear of it. A monstera reaches a metre in every direction, so without this the plant grows
 * straight through the window — which is exactly the kind of mistake that is invisible while you
 * author it and unmissable in the first screenshot. Anything heading at the glass gets its petiole
 * shortened until the blade stops short of the frame.
 */
const Z_LIMIT = -4.40;
/** Nothing green may cross this: 40 mm clear of the sheer curtain plane, 130 mm of the frame. */
const Z_SAFE = -4.44;

const _clearBox = new THREE.Box3();
/**
 * A closure that answers "what is the lowest world z this leaf reaches?", given that the leaf is a
 * child of `foliage`, which is a child of an unrotated pot group at `potZ`.
 */
function makeClearance(foliage, potZ) {
  return (leaf, geo) => {
    leaf.updateMatrix();
    if (!geo.boundingBox) geo.computeBoundingBox();
    _clearBox.copy(geo.boundingBox).applyMatrix4(leaf.matrix).applyMatrix4(foliage.matrix);
    return _clearBox.min.z + potZ;
  };
}

/** A signed step of at most `step` radians from `a` toward `target`, the short way round. */
function stepToward(a, target, step) {
  let d = (target - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d) < step ? d : Math.sign(d) * step;
}

function limitReach(potZ, dz, reach, len) {
  if (dz > -0.02) return reach;
  const room = (Z_LIMIT - potZ) / dz;            // how far this direction may travel at all
  // 0.95 · len, not 0.62: the blade's bounding box runs almost its full length past the petiole
  // once the droop and the half-width are in, and the foliage's lean adds a few centimetres more.
  return Math.max(0.030, Math.min(reach, room - len * 0.95));
}

// `az` is a WORLD bearing in the XZ plane: dx = cos(az), dz = sin(az), so +π/2 is straight into
// the room and −π/2 is straight at the glass. The list is hand-authored rather than generated
// because the silhouette of this plant is the second-strongest shape in the frame after the sofa,
// and the fan has to open toward the room while the mass still leans at the light.
const MONSTERA = [
  { az: 1.20, reach: 0.30, rise: 0.66, len: 0.37, droop: 0.32, roll: -0.22, twist: 0.20 },
  { az: 1.95, reach: 0.27, rise: 0.73, len: 0.34, droop: 0.26, roll: 0.18, twist: -0.16 },
  { az: 0.55, reach: 0.25, rise: 0.55, len: 0.31, droop: 0.33, roll: 0.30, twist: 0.24 },
  { az: 2.55, reach: 0.29, rise: 0.59, len: 0.33, droop: 0.30, roll: -0.27, twist: -0.20 },
  { az: 1.60, reach: 0.13, rise: 0.87, len: 0.30, droop: 0.21, roll: 0.06, twist: 0.12 },
  { az: -0.35, reach: 0.22, rise: 0.45, len: 0.29, droop: 0.37, roll: 0.34, twist: -0.26 },
  { az: 3.35, reach: 0.24, rise: 0.37, len: 0.26, droop: 0.41, roll: -0.40, twist: 0.30 },
  // the two pressed up against the glass: short petioles, small blades
  { az: -1.75, reach: 0.12, rise: 0.50, len: 0.22, droop: 0.30, roll: 0.44, twist: -0.18 },
  { az: 2.95, reach: 0.34, rise: 0.20, len: 0.32, droop: 0.74, roll: -0.10, twist: 0.34, yellow: true },
];

function buildMonstera(D, parent) {
  const L = D.ctx.layout?.monstera || { x: 1.60, z: -4.15, potRadius: 0.17 };
  const rng = D.stream('monstera');
  const group = new THREE.Group();
  group.name = 'monstera';
  // No yaw on the group: the leaf bearings in MONSTERA are world bearings, so that the fan can be
  // aimed at the room and away from the glass with the numbers in the table meaning what they say.
  group.position.set(L.x, 0, L.z);
  parent.add(group);

  const POT_H = 0.30;
  const rTop = 0.168;
  group.add(D.mesh(
    potGeometry(D, { height: POT_H, rBase: 0.112, rTop, seed: 700 }),
    D.tint('ceramic.white', 0xe9e2d3, { roughRange: [0.28, 0.66] }),
    { name: 'monstera.pot' },
  ));

  const soilY = POT_H - 0.052;
  group.add(soilMesh(D, { radius: rTop - 0.012, y: soilY, seed: 91 }));
  pebbles(D, group, { count: D.lod(14, 22, 32, 40), radius: rTop - 0.028, y: soilY + 0.004, spread: 1, seed: 'pebbles' });

  // Everything green leans at the window; the pot stays plumb, because pots do.
  const foliage = new THREE.Group();
  foliage.name = 'monstera.foliage';
  foliage.rotation.set(-0.10, 0, 0.035);
  group.add(foliage);

  const stemMat = D.tint('bark', 0x6d8a4a, { roughRange: [0.44, 0.72], normalScale: 0.45 });
  const leafMats = [
    D.mat('leaf.monstera'),
    D.tint('leaf.monstera', 0xdce8cc, { roughRange: [0.30, 0.52] }),
    D.tint('leaf.monstera', 0xd6c46a, { roughRange: [0.38, 0.62] }), // the one on its way out
  ];

  const petioles = [];
  const crownY = soilY - 0.012;
  foliage.updateMatrix();
  const clearance = makeClearance(foliage, L.z);
  MONSTERA.forEach((spec, i) => {
    const wob = (rng() - 0.5) * 0.05;
    const geo = leafGeometry({
      length: spec.len * 1.045,          // the alphaMap's blade stops just short of the plane
      width: spec.len * 0.95,
      cup: 0.15 + rng() * 0.07,
      droop: spec.droop,
      twist: spec.twist,
      seed: 20 + i * 7,
      wSeg: D.lod(5, 7, 10, 13),
      hSeg: D.lod(8, 11, 16, 21),
    });
    const leaf = new THREE.Group();
    leaf.name = `monstera.leaf${i}`;
    const mat = spec.yellow ? leafMats[2] : leafMats[i % 2 === 0 ? 0 : 1];
    leaf.add(D.mesh(geo, mat, { name: `monstera.blade${i}` }));

    // The blade does not point where its petiole points — the droop direction comes out of the
    // tangent frame and the roll — so the only honest way to keep a leaf off the glass is to place
    // it, measure it, and swing the whole assembly round the pot until it clears.
    let pts = null;
    let bearing = spec.az;
    for (let k = 0; k < 14; k++) {
      const dx = Math.cos(bearing);
      const dz = Math.sin(bearing);
      const reach = limitReach(L.z, dz, spec.reach, spec.len);
      pts = [
        new THREE.Vector3(dx * 0.018, crownY, dz * 0.018),
        new THREE.Vector3(dx * reach * 0.10, crownY + spec.rise * 0.40, dz * reach * 0.10),
        new THREE.Vector3(dx * reach * 0.50 + wob * 0.2, crownY + spec.rise * 0.85, dz * reach * 0.50),
        new THREE.Vector3(dx * reach, crownY + spec.rise, dz * reach),
      ];
      leaf.position.copy(pts[3]);
      orientToTangent(leaf, pts[3].clone().sub(pts[2]), spec.roll + wob);
      if (clearance(leaf, geo) > Z_SAFE) break;
      bearing += stepToward(bearing, Math.PI / 2, 0.15);
    }
    petioles.push(tubeAlong(pts, (t) => 0.0088 * (1 - t * 0.34), D.lod(7, 10, 14, 18), D.lod(5, 5, 7, 8)));
    foliage.add(leaf);
  });
  foliage.add(D.mesh(mergeGeos(petioles), stemMat, { name: 'monstera.petioles' }));

  // The spill, built now and hidden: when the pot goes over, compost goes everywhere and there is
  // no time to generate geometry mid-tumble.
  const spill = new THREE.Group();
  spill.name = 'monstera.spill';
  spill.visible = false;
  spill.position.set(L.x, 0, L.z);
  parent.add(spill);
  const spillGeo = moundDisc({
    radius: 0.34,
    rings: D.lod(4, 5, 7, 8),
    segments: D.lod(16, 22, 30, 36),
    height: (rn, th) => {
      const lobe = 0.55 + 0.45 * noise2(Math.cos(th) * 1.4 + 9, Math.sin(th) * 1.4 + 9, 1, 313, 3);
      const edge = clamp((lobe - rn) * 5, 0, 1);
      return 0.0035 + edge * (0.016 * (1 - rn * 0.7))
        + (noise2(Math.cos(th) * rn * 3 + 1, Math.sin(th) * rn * 3 + 1, 1, 317, 3) - 0.5) * 0.006 * edge;
    },
  });
  spill.add(D.mesh(spillGeo, D.mat('soil'), { name: 'monstera.spill.patch', cast: false }));
  pebbles(D, spill, { count: D.lod(10, 16, 24, 30), radius: 0.30, y: 0.008, spread: 1, seed: 'spill' });

  const potWorld = new THREE.Vector3();
  D.prop({
    id: 'monstera',
    object3d: group,
    kind: 'knockable',
    labelKey: 'prop.monstera',
    points: 800,
    noise: 1.0,
    mass: 5.4,
    dynamic: true,
    phys: {
      shape: 'cylinder',
      radius: 0.158,
      halfHeight: POT_H * 0.5,
      offset: new THREE.Vector3(0, POT_H * 0.5, 0),
      friction: 0.72,
      restitution: 0.04,
      angularDamping: 0.45,
      linearDamping: 0.2,
      ccd: true,
    },
    onTopple() {
      group.getWorldPosition(potWorld);
      spill.position.set(potWorld.x, 0, potWorld.z);
      spill.rotation.y = 0.7;
      spill.visible = true;
      D.ctx.events.emit('fx:impact', { position: potWorld.clone(), force: 1, material: 'soil' });
    },
  });

  return group;
}

// ─────────────────────────────────────────────────── the second plant ────────

function buildSecondPlant(D, parent) {
  const L = D.ctx.layout?.plant2 || { x: 2.35, z: -4.25, height: 0.85, potRadius: 0.12 };
  const rng = D.stream('plant2');
  const group = new THREE.Group();
  group.name = 'plant2';
  // No yaw, same reason as the monstera: the stem bearings below are world bearings so the glass
  // clearance test can steer them.
  group.position.set(L.x, 0, L.z);
  parent.add(group);

  const POT_H = 0.205;
  const rTop = 0.118;
  group.add(D.mesh(
    potGeometry(D, { height: POT_H, rBase: 0.082, rTop, seed: 733, ribs: 0.0014 }),
    D.tint('ceramic.terracotta', 0xc08f6e, { roughRange: [0.55, 0.85] }),
    { name: 'plant2.pot' },
  ));
  const soilY = POT_H - 0.038;
  group.add(soilMesh(D, { radius: rTop - 0.010, y: soilY, dip: 0.008, seed: 97 }));

  const foliage = new THREE.Group();
  foliage.rotation.set(-0.07, 0, -0.04);
  group.add(foliage);

  const stemMat = D.tint('bark', 0x5f7d45, { roughRange: [0.5, 0.78], normalScale: 0.35 });
  const leafMat = D.mat('leaf.small');
  const leafMatPale = D.tint('leaf.small', 0xd8e6c6);
  const stems = [];
  const COUNT = D.lod(11, 15, 21, 25);
  foliage.updateMatrix();
  const clearance = makeClearance(foliage, L.z);
  for (let i = 0; i < COUNT; i++) {
    const t = i / (COUNT - 1);
    const rise = 0.16 + (1 - t) * 0.40 + rng() * 0.10;
    const len = 0.115 + rng() * 0.075;
    const roll = (rng() - 0.5) * 1.4;
    const want = 0.07 + t * 0.20 + rng() * 0.05;
    const geo = leafGeometry({
      // leafSmall's blade only fills 60% of its texture width, so the plane is wide for its length.
      length: len,
      width: len * 0.92,
      cup: 0.10 + rng() * 0.06,
      droop: 0.22 + rng() * 0.26,
      twist: (rng() - 0.5) * 0.5,
      ripple: 0.006,
      seed: 300 + i,
      wSeg: D.lod(3, 4, 6, 7),
      hSeg: D.lod(4, 6, 8, 10),
    });
    const leaf = new THREE.Group();
    leaf.add(D.mesh(geo, i % 3 === 0 ? leafMatPale : leafMat, { name: `plant2.leaf${i}` }));

    // A soft rosette: a golden-angle spiral so no two stems shadow each other exactly, then the
    // same swing-until-it-clears pass the monstera uses.
    let az = i * 2.399 + rng() * 0.3;
    let pts = null;
    for (let k = 0; k < 14; k++) {
      const dx = Math.cos(az);
      const dz = Math.sin(az);
      const reach = limitReach(L.z, dz, want, len);
      pts = [
        new THREE.Vector3(dx * 0.012, soilY - 0.008, dz * 0.012),
        new THREE.Vector3(dx * reach * 0.22, soilY + rise * 0.45, dz * reach * 0.22),
        new THREE.Vector3(dx * reach * 0.68, soilY + rise * 0.86, dz * reach * 0.68),
        new THREE.Vector3(dx * reach, soilY + rise, dz * reach),
      ];
      leaf.position.copy(pts[3]);
      orientToTangent(leaf, pts[3].clone().sub(pts[2]), roll);
      if (clearance(leaf, geo) > Z_SAFE) break;
      az += stepToward(az, Math.PI / 2, 0.15);
    }
    stems.push(tubeAlong(pts, (u) => 0.0035 * (1 - u * 0.4), D.lod(5, 7, 9, 11), 5));
    foliage.add(leaf);
  }
  foliage.add(D.mesh(mergeGeos(stems), stemMat, { name: 'plant2.stems' }));

  D.prop({
    id: 'plant-small',
    object3d: group,
    kind: 'knockable',
    labelKey: 'prop.plantSmall',
    points: 320,
    noise: 0.78,
    mass: 2.2,
    phys: {
      shape: 'cylinder',
      radius: 0.112,
      halfHeight: POT_H * 0.5,
      offset: new THREE.Vector3(0, POT_H * 0.5, 0),
      friction: 0.7,
      restitution: 0.05,
      angularDamping: 0.5,
    },
  });
  return group;
}

// ───────────────────────────────────────────────── fallen leaves & balcony ───

/** Two shed leaves on the floor by the pot. Curled, dry at the edges, and entirely edible. */
function buildFallenLeaves(D, parent) {
  const specs = [
    { id: 'leaf-fallen-1', x: 1.19, z: -3.86, yaw: 0.9, len: 0.30, curl: 0.20, tint: 0xcfd8ae },
    { id: 'leaf-fallen-2', x: 1.99, z: -4.36, yaw: -2.1, len: 0.26, curl: 0.34, tint: 0xc8bd76 },
  ];
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const g = new THREE.Group();
    g.name = s.id;
    const geo = leafGeometry({
      length: s.len * 1.045,
      width: s.len * 0.95,
      cup: s.curl,
      droop: 0.05,
      twist: 0.12 * (i ? -1 : 1),
      ripple: 0.014,
      seed: 611 + i * 13,
      wSeg: D.lod(5, 7, 9, 11),
      hSeg: D.lod(7, 9, 13, 16),
    });
    // Authored standing up in XY: lay it on its face so the channel opens upward.
    geo.rotateX(-Math.PI / 2);
    g.add(D.mesh(geo, D.tint('leaf.monstera', s.tint, { roughRange: [0.42, 0.68] }), { name: `${s.id}.blade` }));
    g.position.set(s.x, 0.004, s.z);
    g.rotation.set(0.03 * (i ? 1 : -1), s.yaw, 0.02);
    parent.add(g);
    D.prop({
      id: s.id,
      object3d: g,
      kind: 'edible',
      labelKey: 'prop.fallenLeaf',
      points: 120,
      noise: 0.16,
      mass: 0.02,
      edibleTime: 1.1,
      reaction: 'gross',
      phys: { shape: 'box', friction: 0.6, restitution: 0.02, linearDamping: 0.6, angularDamping: 0.8 },
    });
  }
}

/**
 * The scrappy planter of greenery on the balcony. Seen only through the glazing, out of focus and
 * against the light, so it is one merged mesh of alpha-cut leaf quads rather than anything clever
 * — but it has to exist, because a bright window with NOTHING in front of it is the fastest way to
 * make an interior read as a render.
 */
function buildBalconyFoliage(D, parent) {
  const rng = D.stream('balcony');
  const E = D.ctx.layout?.exterior?.planter || { x0: -1.90, x1: -0.30, cz: -5.62, d: 0.42, topY: 0.31 };
  const baseY = (D.ctx.layout?.exterior?.balcony?.topY ?? -0.03);
  const count = D.lod(34, 56, 92, 120);
  const parts = [];
  const quad = new THREE.PlaneGeometry(1, 1, 1, 1);
  quad.translate(0, 0.5, 0);
  for (let i = 0; i < count; i++) {
    const x = E.x0 + rng() * (E.x1 - E.x0);
    const z = E.cz + (rng() - 0.5) * (E.d + 0.12);
    // The mass humps in the middle of the trough and thins at both ends.
    const t = (x - E.x0) / Math.max(1e-3, E.x1 - E.x0);
    const hump = Math.sin(Math.PI * t) ** 0.7;
    const y = baseY + 0.06 + rng() * (0.14 + hump * 0.34);
    const size = 0.070 + rng() * 0.075;
    const g = quad.clone();
    place(
      g, x, y, z,
      (rng() - 0.35) * 1.5, rng() * 6.28, (rng() - 0.5) * 1.1,
      size * (0.7 + rng() * 0.5), size * (1.4 + rng() * 0.9), size,
    );
    parts.push(g);
  }
  quad.dispose();
  const mesh = D.mesh(mergeGeos(parts), D.mat('foliage.tree'), { name: 'balcony.foliage', receive: false });
  mesh.frustumCulled = true;
  parent.add(mesh);
  return mesh;
}

// ──────────────────────────────────────────────────────────────────── api ────

export function buildPlants(D) {
  const group = new THREE.Group();
  group.name = 'plants';
  D.add(group);

  buildMonstera(D, group);
  buildSecondPlant(D, group);
  buildFallenLeaves(D, group);
  buildBalconyFoliage(D, group);

  return { group };
}
