// OPERATION NAPTIME — module DRESS — everything INSIDE the playpen.
//
// FURN builds the pen (padded frame, mesh panels, zip door); this file fills it, and it is the
// densest square metre of the game: the baby starts here, so it is the first thing the camera ever
// sees and the only place in the room with saturated colour in it.
//
// Four things carry the shot.
//  · The mat is a real slab with a 22 mm rounded edge and a broad ruck through it, not a decal.
//  · The blanket is a heap with genuine self-shadowing folds, solved once by `relaxedCloth` at
//    build time (see cloth.js) — a sculpted "cloth-shaped blob" reads as a beanbag every time.
//  · The play gym's toys hang on real spherical-joint pendulums, so they swing when the baby
//    barges through and settle on their own. The cords are drawn per frame from the anchor to
//    wherever the physics has put the toy, which is why the cords are the only thing in this
//    module that updates.
//  · Nothing is axis-aligned and nothing is clean: the cushion is dented, two of the three cups
//    are lying on their rims, the box's lid has slid off onto the rim, the ukulele is dumped
//    across the mat at 139°.

import * as THREE from 'three';
import {
  pillow, roundedRectOutline, roundedBox, lathe, spline, mergeGeos, place, ellipsoid,
  noise2, clamp, mix, smoothstep,
} from './util.js';
import { relaxedCloth } from './cloth.js';

const DOWN = new THREE.Vector3(0, -1, 0);

/** Mat top. Everything in the pen rests on this. */
export const MAT_TOP = 0.022;

// ─────────────────────────────────────────────────────────────── the mat ─────

function buildMat(D, parent) {
  const L = D.ctx.layout?.playpen || { x: 0, z: 2.0, w: 2.8, d: 2.6, rot: 0.026 };
  const W = L.w - 0.20;
  const DP = L.d - 0.20;
  const half = MAT_TOP * 0.5;
  const geo = pillow({
    outline: roundedRectOutline(W, DP, 0.13),
    segments: D.lod(40, 56, 80, 96),
    half,
    rim: half * 0.86,
    capRings: D.lod(3, 5, 8, 10),
    rimRings: 2,
    displace: (p, u, v, s) => {
      // The whole slab undulates: a mat that has been crawled on all week is never flat, and the
      // long soft shadow that runs along a ruck is what gives a 2.6 m surface any scale at all.
      const ruck = (noise2(u * 2.6, v * 2.4, 1, 771, 3) - 0.5) * 0.010
        + (noise2(u * 6.5, v * 6.0, 1, 772, 2) - 0.5) * 0.0035;
      // One corner has been peeled up by somebody crawling off it.
      const lift = smoothstep(0.42, 0.0, Math.hypot(u - 0.02, v - 0.06)) ** 1.4 * 0.030;
      // The ruck belongs to the TOP face only — the underside is pressed flat against a concrete
      // floor and must stay there, or the mat's edge floats. The peeled corner lifts both faces,
      // because that one really does come off the floor.
      p.z += ruck * s + lift * (0.35 + 0.65 * s);
      // Quilt puff: the faces bow apart between the stitch lines, so the edge reads as padded.
      const q = Math.sin(u * Math.PI * 9) * Math.sin(v * Math.PI * 8);
      p.z += (s * 2 - 1) * 0.0016 * q;
    },
  });
  geo.rotateX(-Math.PI / 2);
  const mesh = D.mesh(geo, D.tiled('fabric.playmat', W, DP), { name: 'playpen.mat' });
  // +1.2 mm: the quilt puff pushes the underside down by that much, and a mat whose stitch lines
  // poke through the floor slab z-fights with it under a raking sun.
  mesh.position.set(L.x, half + 0.0012, L.z);
  mesh.rotation.y = L.rot ?? 0.026;
  parent.add(mesh);

  D.prop({
    id: 'play-mat',
    object3d: mesh,
    kind: 'scenery',
    labelKey: 'prop.playMat',
    points: 0,
    noise: 0.05,
    mass: 4,
    anchor: true,
    phys: { shape: 'box', size: { x: W, y: MAT_TOP, z: DP }, offset: new THREE.Vector3(0, 0, 0), friction: 0.9, restitution: 0.02 },
  });
  return mesh;
}

// ──────────────────────────────────────────────────────────── the blanket ────

function buildBlanket(D, parent) {
  const rng = D.stream('blanket');
  const g = new THREE.Group();
  g.name = 'muslin-blanket';
  g.position.set(-0.86, 0, 2.66);
  g.rotation.y = 0.5;
  parent.add(g);

  // Solved in the group's own frame, so `floor` is simply the top of the mat.
  const geo = relaxedCloth({
    // 0.70 m of cloth, crushed to a 0.27 m footprint before it is released: the solver relaxes it
    // back out to roughly a metre across, which is what a muslin square actually occupies once it
    // has been dumped in a corner. Anything larger climbs out of the pen.
    size: 0.70,
    divisions: D.lod(9, 13, 17, 19),
    gather: 0.62,
    floor: MAT_TOP,
    thickness: 0.011,
    steps: D.lod(110, 170, 240, 280),
    rng,
    seed: 17,
    // Two humps under the cloth: a heap that drapes over something is legible as cloth; a heap
    // that drapes over nothing is legible as a pastry.
    obstacles: [
      { x: 0.10, y: MAT_TOP + 0.015, z: -0.04, r: 0.105 },
      { x: -0.13, y: MAT_TOP + 0.010, z: 0.10, r: 0.072 },
    ],
  });
  // The solver lets the heap drift a few centimetres off the origin; recentre it in XZ so the
  // authored position is where the blanket actually ends up.
  geo.computeBoundingBox();
  const c = geo.boundingBox.getCenter(new THREE.Vector3());
  geo.translate(-c.x, 0, -c.z);
  geo.computeBoundingSphere();
  const mesh = D.mesh(geo, D.mat('fabric.muslin'), { name: 'muslin-blanket.cloth' });
  g.add(mesh);

  D.prop({
    id: 'blanket',
    object3d: g,
    kind: 'pullable',
    labelKey: 'prop.blanket',
    points: 110,
    noise: 0.12,
    mass: 0.24,
    phys: { shape: 'box', friction: 0.85, restitution: 0.01, linearDamping: 0.5, angularDamping: 0.8 },
  });
  return g;
}

// ──────────────────────────────────────────────────────────── the cushion ────

function buildCushion(D, parent) {
  const S = 0.42;
  const half = 0.072;
  const geo = pillow({
    outline: roundedRectOutline(S, S, 0.115),
    segments: D.lod(28, 40, 56, 72),
    half,
    rim: half * 0.92,
    capRings: D.lod(3, 4, 6, 7),
    rimRings: 3,
    displace: (p, u, v, s) => {
      const dent = Math.exp(-(((u - 0.44) ** 2 + (v - 0.52) ** 2) / (2 * 0.052)));
      const sign = s * 2 - 1;
      // A dent presses BOTH faces the same way; the corners keep their loft, which is what makes
      // a used cushion read as used rather than as a rounded box.
      p.z -= sign * dent * 0.030;
      p.z += sign * (noise2(u * 5, v * 5, 1, 881, 2) - 0.5) * 0.006;
      const corner = smoothstep(0.30, 0.0, Math.min(
        Math.hypot(u, v), Math.min(Math.hypot(1 - u, v), Math.min(Math.hypot(u, 1 - v), Math.hypot(1 - u, 1 - v))),
      ));
      p.z -= sign * corner * 0.012;
    },
  });
  geo.rotateX(-Math.PI / 2);
  const mesh = D.mesh(geo, D.mat('fabric.navyFlat'), { name: 'playpen.cushion' });
  // Sunk 2 mm into the mat, because a cushion resting exactly on a surface is a cushion made of
  // wood. The tilts stay small so the contact edge stays honest.
  mesh.position.set(-0.98, MAT_TOP + 0.084, 1.52);
  mesh.rotation.set(0.05, -0.42, 0.07);
  parent.add(mesh);

  D.prop({
    id: 'cushion-pen',
    object3d: mesh,
    kind: 'knockable',
    labelKey: 'prop.cushion',
    points: 90,
    noise: 0.14,
    mass: 0.42,
    phys: { shape: 'box', friction: 0.8, restitution: 0.02, angularDamping: 0.75 },
  });
  return mesh;
}

// ──────────────────────────────────────────────────────────── the play gym ───

/** Elliptical arc used by both hoops: u 0→1 sweeps the span, `apex` is the crown height. */
function arcPoint(u, { cx, cz, span, apex, axis, y0 }) {
  const a = Math.PI * u;
  const d = Math.cos(a) * span * 0.5;
  return new THREE.Vector3(
    cx + (axis === 'x' ? d : 0),
    y0 + Math.sin(a) * apex,
    cz + (axis === 'z' ? d : 0),
  );
}

function tubeThrough(points, radius, tubular, radial) {
  const curve = new THREE.CatmullRomCurve3(points);
  return new THREE.TubeGeometry(curve, tubular, radius, radial, false);
}

/** The grey elephant, centred on its own origin so a pendulum body can drive it. */
function elephantMesh(D, group) {
  const grey = D.tint('fabric.plush', 0x9aa0a2, { roughRange: [0.90, 0.99] });
  const pale = D.tint('fabric.plush', 0xcfc4c0);
  const dark = D.tint('plastic.matte', 0x1d1a18, { roughRange: [0.28, 0.5] });
  const body = mergeGeos([
    place(ellipsoid(0.052, 0.044, 0.040, 14, 10), 0, -0.010, 0),
    place(ellipsoid(0.036, 0.034, 0.031, 12, 9), 0, 0.036, 0.014),
    // trunk: three shrinking beads curling forward and down
    place(ellipsoid(0.013, 0.016, 0.013, 8, 6), 0, 0.020, 0.042),
    place(ellipsoid(0.010, 0.013, 0.011, 8, 6), 0, 0.001, 0.050),
    place(ellipsoid(0.008, 0.010, 0.009, 8, 6), 0.002, -0.014, 0.046),
    // stubby legs
    place(ellipsoid(0.015, 0.018, 0.015, 8, 6), -0.028, -0.046, 0.014),
    place(ellipsoid(0.015, 0.018, 0.015, 8, 6), 0.028, -0.046, 0.014),
    place(ellipsoid(0.015, 0.018, 0.015, 8, 6), -0.026, -0.046, -0.020),
    place(ellipsoid(0.015, 0.018, 0.015, 8, 6), 0.026, -0.046, -0.020),
  ]);
  group.add(D.mesh(body, grey, { name: 'gym.elephant.body' }));
  const ears = mergeGeos([
    place(ellipsoid(0.010, 0.028, 0.026, 8, 7), -0.034, 0.038, 0.004, 0, 0, -0.30),
    place(ellipsoid(0.010, 0.028, 0.026, 8, 7), 0.034, 0.038, 0.004, 0, 0, 0.30),
  ]);
  group.add(D.mesh(ears, pale, { name: 'gym.elephant.ears' }));
  const eyes = mergeGeos([
    place(ellipsoid(0.0045, 0.0045, 0.003, 7, 5), -0.016, 0.042, 0.030),
    place(ellipsoid(0.0045, 0.0045, 0.003, 7, 5), 0.016, 0.042, 0.030),
  ]);
  group.add(D.mesh(eyes, dark, { name: 'gym.elephant.eyes' }));
}

/** A little stuffed bird: teardrop body, two swept wings, a beak. */
function birdMesh(D, group) {
  const body = D.tint('fabric.plush', 0xe0a63c);
  const wing = D.tint('fabric.plush', 0xc98424);
  const dark = D.tint('plastic.matte', 0x1d1a18, { roughRange: [0.28, 0.5] });
  group.add(D.mesh(mergeGeos([
    place(ellipsoid(0.036, 0.042, 0.034, 12, 10), 0, 0, 0),
    place(ellipsoid(0.021, 0.020, 0.020, 10, 8), 0, 0.036, 0.012),
    place(ellipsoid(0.012, 0.014, 0.026, 8, 6), 0, -0.030, -0.030, 0.5, 0, 0),
  ]), body, { name: 'gym.bird.body' }));
  group.add(D.mesh(mergeGeos([
    place(ellipsoid(0.008, 0.024, 0.030, 8, 7), -0.031, 0.002, -0.004, 0, 0, -0.4),
    place(ellipsoid(0.008, 0.024, 0.030, 8, 7), 0.031, 0.002, -0.004, 0, 0, 0.4),
  ]), wing, { name: 'gym.bird.wings' }));
  group.add(D.mesh(mergeGeos([
    place(new THREE.ConeGeometry(0.007, 0.016, 7), 0, 0.034, 0.030, Math.PI / 2, 0, 0),
    place(ellipsoid(0.0040, 0.0040, 0.003, 7, 5), -0.010, 0.042, 0.017),
    place(ellipsoid(0.0040, 0.0040, 0.003, 7, 5), 0.010, 0.042, 0.017),
  ]), dark, { name: 'gym.bird.face' }));
}

function buildPlayGym(D, parent, hangers) {
  const L = D.ctx.layout?.playGym || { x: 0.15, z: 1.70, span: 0.75, height: 0.52, rot: -0.314 };
  const g = new THREE.Group();
  g.name = 'play-gym';
  g.position.set(L.x, 0, L.z);
  g.rotation.y = L.rot ?? -0.314;
  parent.add(g);

  // The padded round base the arch stands on.
  const R = 0.40;
  const baseHalf = 0.015;
  const baseGeo = pillow({
    outline: (t) => ({ x: Math.cos(t * Math.PI * 2) * R, y: Math.sin(t * Math.PI * 2) * R }),
    segments: D.lod(24, 34, 48, 60),
    half: baseHalf,
    rim: baseHalf * 0.9,
    capRings: D.lod(2, 3, 5, 6),
    rimRings: 2,
    displace: (p, u, v, s) => {
      p.z += (noise2(u * 4, v * 4, 1, 991, 2) - 0.5) * 0.006;
      p.z += (s * 2 - 1) * 0.0018 * Math.sin(Math.hypot(u - 0.5, v - 0.5) * 34);
    },
  });
  baseGeo.rotateX(-Math.PI / 2);
  const base = D.mesh(baseGeo, D.tint('fabric.playmat', 0xdde4d8, { roughRange: [0.5, 0.75] }), { name: 'gym.base' });
  base.position.y = MAT_TOP + baseHalf;
  g.add(base);

  const y0 = MAT_TOP + 0.012;
  const arcs = [
    { cx: 0, cz: 0, span: L.span ?? 0.75, apex: L.height ?? 0.52, axis: 'x', y0 },
    { cx: 0, cz: 0, span: (L.span ?? 0.75) * 0.94, apex: (L.height ?? 0.52) * 0.94, axis: 'z', y0 },
  ];
  const tubes = [];
  for (const arc of arcs) {
    const pts = [];
    const n = D.lod(7, 9, 13, 17);
    for (let i = 0; i <= n; i++) pts.push(arcPoint(i / n, arc));
    tubes.push(tubeThrough(pts, 0.0165, D.lod(12, 16, 22, 28), D.lod(5, 6, 8, 8)));
  }
  // Four padded feet, so the arch does not appear to grow out of the mat.
  for (const arc of arcs) {
    for (const u of [0.02, 0.98]) {
      const p = arcPoint(u, arc);
      tubes.push(place(ellipsoid(0.032, 0.012, 0.032, 10, 6), p.x, MAT_TOP + 0.010, p.z));
    }
  }
  g.add(D.mesh(mergeGeos(tubes), D.tint('fabric.playpenTrim', 0xd7dcd0, { roughRange: [0.44, 0.70] }), { name: 'gym.arch' }));

  // ── the hanging toys ──────────────────────────────────────────────────────────────────────
  // Anchors are sampled off the real arcs, then everything below hangs in WORLD space so the
  // physics pendulums write straight into an identity parent frame.
  const specs = [
    { id: 'gym-elephant', arc: 0, u: 0.30, cord: 0.135, mass: 0.085, radius: 0.050, build: elephantMesh, points: 180, label: 'prop.elephant', swing: 0.0 },
    { id: 'gym-bird', arc: 0, u: 0.70, cord: 0.115, mass: 0.060, radius: 0.042, build: birdMesh, points: 170, label: 'prop.bird', swing: 0.0 },
    { id: 'gym-ring-1', arc: 1, u: 0.36, cord: 0.150, mass: 0.045, radius: 0.038, ring: 0xe2603f, points: 120, label: 'prop.teethingRing' },
    { id: 'gym-ring-2', arc: 1, u: 0.64, cord: 0.185, mass: 0.040, radius: 0.034, ring: 0xefb336, points: 120, label: 'prop.teethingRing' },
  ];

  const cordMat = D.tint('fabric.playpenTrim', 0xbfc6ba, { roughRange: [0.55, 0.8] });
  const cordGeo = new THREE.CylinderGeometry(0.0022, 0.0022, 1, 6, 1, true);
  cordGeo.translate(0, -0.5, 0); // hangs from its own origin
  D.geo(cordGeo);

  // `g` is a direct child of the dressing root, so its local matrix IS its world matrix — which is
  // what lets the pendulums below live in world space with an identity parent frame.
  g.updateMatrix();
  for (const s of specs) {
    const anchor = arcPoint(s.u, arcs[s.arc]).applyMatrix4(g.matrix);

    const toy = new THREE.Group();
    toy.name = s.id;
    toy.position.set(anchor.x, anchor.y - s.cord, anchor.z);
    if (s.build) {
      s.build(D, toy);
    } else {
      const ringGeo = new THREE.TorusGeometry(0.030, 0.0092, D.lod(6, 8, 10, 12), D.lod(14, 20, 26, 32));
      toy.add(D.mesh(ringGeo, D.tint('plastic.toy', s.ring, { roughRange: [0.24, 0.44] }), { name: `${s.id}.ring` }));
      toy.rotation.x = Math.PI / 2;
    }
    parent.add(toy);

    const cord = D.mesh(cordGeo, cordMat, { name: `${s.id}.cord`, receive: false });
    cord.position.copy(anchor);
    cord.scale.y = s.cord;
    parent.add(cord);
    hangers.push({ anchor, cord, toy });

    const pendulum = D.ctx.physics?.addPendulum(toy, {
      anchor: { x: anchor.x, y: anchor.y, z: anchor.z },
      length: s.cord,
      segments: 2,
      radius: s.radius,
      mass: s.mass,
      shape: 'ball',
      linearDamping: 0.35,
      angularDamping: 0.7,
      material: s.build ? 'plush' : 'plastic',
      swing: s.swing || 0,
    });

    const prop = D.ctx.props.register({
      id: s.id,
      object3d: toy,
      kind: 'pullable',
      labelKey: s.label,
      points: s.points,
      noise: 0.32,
      mass: s.mass,
    });
    prop.body = pendulum ? pendulum.body : null;
    prop.record = pendulum ? pendulum.record : null;
    D.props.push(prop);
  }

  // The collider is the padded BASE, not the arch. Two reasons: you knock a play gym over by
  // barging its base, which is where the contact should be; and a box around the whole arch would
  // be an invisible wall across an obviously open shape. The hanging toys carry their own
  // colliders, so crawling into the middle of the gym still hits something — the fun something.
  D.prop({
    id: 'play-gym',
    object3d: g,
    kind: 'knockable',
    labelKey: 'prop.playGym',
    points: 260,
    noise: 0.5,
    mass: 1.6,
    phys: {
      shape: 'cylinder',
      radius: R + 0.02,
      halfHeight: 0.055,
      offset: new THREE.Vector3(0, MAT_TOP + 0.055, 0),
      friction: 0.75,
      restitution: 0.05,
      angularDamping: 0.8,
    },
  });
  return g;
}

// ─────────────────────────────────────────────────────────── small things ────

/** An open vessel: wall up, roll over the rim, wall back down inside. Cups and pots both. */
function vesselGeometry(D, { h, rBot, rTop, wall = 0.0035, seed = 5 }) {
  const outer = spline([[0, rBot], [0.12, rBot * 1.06], [0.65, mix(rBot, rTop, 0.72)], [1, rTop]]);
  const path = (t) => {
    if (t <= 0.78) {
      const u = t / 0.78;
      return { r: Math.max(0.003, outer(u)), y: u * h };
    }
    if (t <= 0.86) {
      const k = (t - 0.78) / 0.08;
      return { r: rTop + Math.sin(k * Math.PI) * wall * 0.5 - k * wall * 0.5, y: h + Math.sin(k * Math.PI * 0.5) * wall * 0.8 };
    }
    const k = (t - 0.86) / 0.14;
    return { r: Math.max(0.003, (rTop - wall) * (1 - k * 0.16)), y: h + wall * 0.8 - k * (h - 0.004) };
  };
  return lathe({
    path,
    rings: D.lod(14, 20, 28, 34),
    segments: D.lod(14, 20, 28, 36),
    closeBottom: true,
    perturb: (t, th) => (t > 0.85 ? 0 : 0.0004 * (noise2(Math.cos(th) + 2, Math.sin(th) + t * 3, 1, seed, 2) - 0.5)),
  });
}

function buildStackingCups(D, parent) {
  const specs = [
    { id: 'cup-1', h: 0.062, rBot: 0.030, rTop: 0.038, hex: 0xdd5040, x: -0.42, z: 2.76, tip: 0.0, yaw: 0.3 },
    { id: 'cup-2', h: 0.055, rBot: 0.026, rTop: 0.033, hex: 0xefb02c, x: -0.32, z: 2.66, tip: 1.48, yaw: -1.1 },
    { id: 'cup-3', h: 0.049, rBot: 0.023, rTop: 0.029, hex: 0x4c9ec6, x: -0.56, z: 2.63, tip: 1.62, yaw: 2.2 },
  ];
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const g = new THREE.Group();
    g.name = s.id;
    g.add(D.mesh(
      vesselGeometry(D, { h: s.h, rBot: s.rBot, rTop: s.rTop, seed: 11 + i }),
      D.tint('plastic.toy', s.hex, { roughRange: [0.26, 0.46] }),
      { name: `${s.id}.shell` },
    ));
    // A knocked-over cup rests on its rim, not on its axis: tip it and drop it by its radius.
    const lying = s.tip > 0.6;
    g.position.set(s.x, MAT_TOP + (lying ? s.rTop * 0.94 : 0.001), s.z);
    g.rotation.set(s.tip, s.yaw, lying ? 0.08 : 0);
    parent.add(g);
    D.prop({
      id: s.id,
      object3d: g,
      kind: 'knockable',
      labelKey: 'prop.stackingCup',
      points: 60,
      noise: 0.34,
      mass: 0.035,
      phys: { shape: 'box', friction: 0.55, restitution: 0.28, angularDamping: 0.35 },
    });
  }
}

function buildBoardBook(D, parent) {
  const g = new THREE.Group();
  g.name = 'board-book';
  const W = 0.145;
  const H = 0.150;
  const leaves = 6;
  const cover = D.tint('paper.magazine', 0xf07a4a, { roughRange: [0.22, 0.42] });
  const coverB = D.tint('paper.magazine', 0x62a8c4, { roughRange: [0.22, 0.42] });
  const page = D.mat('paper.page');
  for (let i = 0; i < leaves; i++) {
    const t = i / (leaves - 1);
    const thick = i === 0 || i === leaves - 1 ? 0.0055 : 0.0032;
    const geo = pillow({
      outline: roundedRectOutline(W, H, 0.010),
      segments: 22,
      half: thick,
      rim: thick * 0.8,
      capRings: 2,
      rimRings: 1,
      displace: (p, u, v) => { p.z += (noise2(u * 3 + i, v * 3, 1, 51 + i, 2) - 0.5) * 0.0016; },
    });
    // Hinge every leaf about the spine at x = -W/2, fanned from 22° to 158°.
    geo.translate(W * 0.5, 0, 0);
    geo.rotateX(-Math.PI / 2);
    const leaf = D.mesh(geo, i === 0 ? cover : i === leaves - 1 ? coverB : page, { name: `board-book.leaf${i}` });
    leaf.rotation.z = mix(0.38, Math.PI - 0.38, t) + (i % 2 ? 0.05 : -0.04);
    leaf.rotation.y = (i - leaves * 0.5) * 0.012;
    g.add(leaf);
  }
  g.position.set(0.34, MAT_TOP + 0.001, 3.02);
  g.rotation.set(0, 1.05, 0);
  parent.add(g);
  D.prop({
    id: 'board-book',
    object3d: g,
    kind: 'edible',
    labelKey: 'prop.boardBook',
    points: 130,
    noise: 0.3,
    mass: 0.16,
    edibleTime: 1.8,
    reaction: 'gross',
    phys: { shape: 'box', friction: 0.6, restitution: 0.05, angularDamping: 0.6 },
  });
}

function buildToyBox(D, parent) {
  const g = new THREE.Group();
  g.name = 'toy-box';
  const W = 0.205;
  const H = 0.125;
  const DP = 0.150;
  const shell = D.tint('plastic.toy', 0xd23f52, { roughRange: [0.26, 0.48] });
  const lidMat = D.tint('plastic.toy', 0xe9647a, { roughRange: [0.22, 0.42] });
  // Walls only — the lid is ajar and you can see down into it.
  const walls = mergeGeos([
    place(roundedBox(W, 0.007, DP, 0.003, 1), 0, 0.0035, 0),
    place(roundedBox(W, H, 0.008, 0.003, 1), 0, H * 0.5, -(DP * 0.5 - 0.004)),
    place(roundedBox(W, H, 0.008, 0.003, 1), 0, H * 0.5, DP * 0.5 - 0.004),
    place(roundedBox(0.008, H, DP - 0.016, 0.003, 1), -(W * 0.5 - 0.004), H * 0.5, 0),
    place(roundedBox(0.008, H, DP - 0.016, 0.003, 1), W * 0.5 - 0.004, H * 0.5, 0),
    // a moulded rib each side, because a flat plastic panel reads as a primitive
    place(roundedBox(W * 0.86, 0.010, 0.004, 0.002, 1), 0, H * 0.62, -(DP * 0.5 + 0.001)),
    place(roundedBox(W * 0.86, 0.010, 0.004, 0.002, 1), 0, H * 0.62, DP * 0.5 + 0.001),
  ]);
  g.add(D.mesh(walls, shell, { name: 'toy-box.shell' }));
  const lid = D.mesh(roundedBox(W + 0.012, 0.012, DP + 0.012, 0.004, 1), lidMat, { name: 'toy-box.lid' });
  lid.position.set(0.052, H + 0.036, 0.010);
  lid.rotation.set(0.06, 0.14, -0.42); // slid off and propped on the rim
  g.add(lid);

  g.position.set(1.02, MAT_TOP + 0.001, 2.86);
  g.rotation.y = -0.36;
  parent.add(g);
  D.prop({
    id: 'toy-box',
    object3d: g,
    kind: 'knockable',
    labelKey: 'prop.toyBox',
    points: 150,
    noise: 0.55,
    mass: 0.38,
    phys: { shape: 'box', friction: 0.6, restitution: 0.12, angularDamping: 0.55 },
  });
}

// ───────────────────────────────────────────────────────────── the ukulele ───

/** Figure-of-eight body outline: two bouts and a waist, sampled up the right side and down the left. */
function ukuleleOutline(scale) {
  const lower = { c: -0.052 * scale, r: 0.076 * scale };
  const upper = { c: 0.064 * scale, r: 0.059 * scale };
  const waistY = 0.008 * scale;
  const waistS = 0.031 * scale;
  const y0 = lower.c - lower.r;
  const y1 = upper.c + upper.r;
  const hw = (y) => {
    let w = 0;
    for (const b of [lower, upper]) {
      const d = y - b.c;
      if (Math.abs(d) < b.r) w = Math.max(w, Math.sqrt(b.r * b.r - d * d));
    }
    const waist = Math.exp(-((y - waistY) ** 2) / (2 * waistS * waistS));
    return Math.max(0.0022 * scale, w * (1 - 0.30 * waist));
  };
  return (t) => {
    const u = ((t % 1) + 1) % 1;
    if (u < 0.5) {
      const y = y0 + (u / 0.5) * (y1 - y0);
      return { x: hw(y), y };
    }
    const y = y1 - ((u - 0.5) / 0.5) * (y1 - y0);
    return { x: -hw(y), y };
  };
}

function buildUkulele(D, parent) {
  const g = new THREE.Group();
  g.name = 'ukulele';
  const S = 0.88;
  const bodyHalf = 0.026;
  const outline = ukuleleOutline(S);
  const bodyGeo = pillow({
    outline,
    segments: D.lod(40, 56, 76, 92),
    half: bodyHalf,
    rim: bodyHalf * 0.62,
    capRings: D.lod(2, 3, 4, 5),
    rimRings: D.lod(2, 2, 3, 4),
    displace: (p, u, v, s) => {
      // The soundboard and the back are very slightly domed — a flat top makes it a plank.
      const dome = Math.sin(Math.PI * clamp(u, 0, 1)) * Math.sin(Math.PI * clamp(v, 0, 1));
      p.z += (s * 2 - 1) * dome * 0.0022;
    },
  });
  // +π/2, not −: the outline's +y (the upper bout, where the neck joins) has to end up at +z.
  bodyGeo.rotateX(Math.PI / 2);
  const pale = D.tint('wood.birchToy', 0xead2a6, { roughRange: [0.28, 0.50] });
  const dark = D.tint('wood.walnut', 0x53372a, { roughRange: [0.26, 0.48] });
  g.add(D.mesh(bodyGeo, pale, { name: 'ukulele.body' }));

  const topY = (0.064 + 0.059) * S;   // the top of the upper bout, in the outline's own units
  const neckLen = 0.150 * S;
  const parts = [];
  // Neck + heel, running out along +Z once the body is flat.
  parts.push(place(roundedBox(0.030 * S, 0.016, neckLen, 0.005, 1), 0, 0.006, topY + neckLen * 0.5 - 0.006));
  parts.push(place(roundedBox(0.040 * S, 0.020, 0.030 * S, 0.006, 1), 0, 0.004, topY - 0.004));
  // Headstock, angled back.
  parts.push(place(roundedBox(0.040 * S, 0.011, 0.052 * S, 0.004, 1), 0, 0.002, topY + neckLen + 0.020 * S, -0.22, 0, 0));
  g.add(D.mesh(mergeGeos(parts), pale, { name: 'ukulele.neck' }));

  // Fretboard + bridge + 8 frets, all in the dark wood.
  const darkParts = [
    place(roundedBox(0.029 * S, 0.005, neckLen + 0.020 * S, 0.001, 1), 0, 0.0165, topY + neckLen * 0.5 - 0.020 * S),
    place(roundedBox(0.048 * S, 0.007, 0.014 * S, 0.002, 1), 0, bodyHalf + 0.0025, -0.052 * S),
  ];
  for (let i = 1; i <= D.lod(4, 6, 8, 9); i++) {
    const z = topY - 0.030 * S + (neckLen * 0.92) * (1 - 2 ** (-i / 2.6));
    darkParts.push(place(roundedBox(0.028 * S, 0.0012, 0.0016, 0.0004, 1), 0, 0.0192, z));
  }
  g.add(D.mesh(mergeGeos(darkParts), dark, { name: 'ukulele.fretboard' }));

  // Soundhole: a recessed dark disc under a rosette ring, so it reads as a hole, not a sticker.
  const holeR = 0.028 * S;
  const hole = D.mesh(new THREE.CircleGeometry(holeR, D.lod(12, 16, 22, 28)), D.tint('plastic.matte', 0x14100c, { roughRange: [0.6, 0.9] }), { name: 'ukulele.soundhole', cast: false });
  hole.rotation.x = -Math.PI / 2;
  hole.position.set(0, bodyHalf - 0.010, 0.010 * S);
  g.add(hole);
  const rosette = D.mesh(new THREE.RingGeometry(holeR, holeR + 0.005, D.lod(14, 18, 24, 30)), dark, { name: 'ukulele.rosette', cast: false });
  rosette.rotation.x = -Math.PI / 2;
  rosette.position.set(0, bodyHalf + 0.0042, 0.010 * S); // clear of the soundboard's 2.2 mm dome
  g.add(rosette);

  // Four strings from the bridge to the nut, with a whisper of sag.
  const nutZ = topY + neckLen + 0.004 * S;
  const bridgeZ = -0.052 * S;
  const strings = [];
  for (let i = 0; i < 4; i++) {
    const x = (i - 1.5) * 0.0072 * S;
    const pts = [];
    for (let k = 0; k <= 4; k++) {
      const t = k / 4;
      const z = mix(bridgeZ, nutZ, t);
      const y = mix(bodyHalf + 0.005, 0.0212, t) - Math.sin(t * Math.PI) * 0.0006;
      pts.push(new THREE.Vector3(x * (1 - t * 0.12), y, z));
    }
    strings.push(tubeThrough(pts, 0.00065 + i * 0.00012, D.lod(4, 5, 7, 8), 4));
    // tuning peg
    strings.push(place(new THREE.CylinderGeometry(0.0035, 0.0028, 0.014, 6), (i < 2 ? -1 : 1) * 0.026 * S, 0.004, nutZ + (i % 2 ? 0.016 : 0.030) * S, 0, 0, Math.PI / 2));
  }
  g.add(D.mesh(mergeGeos(strings), D.tint('metal.chrome', 0xd7d2c6, { roughRange: [0.18, 0.42] }), { name: 'ukulele.strings' }));

  // Dumped on the mat at 139°, rolled a few degrees onto the edge of its lower bout.
  g.position.set(-0.72, MAT_TOP + 0.029, 2.16);
  g.rotation.set(0.0, 2.42, -0.07);
  parent.add(g);

  D.prop({
    id: 'ukulele',
    object3d: g,
    kind: 'knockable',
    labelKey: 'prop.ukulele',
    points: 210,
    noise: 0.62,
    mass: 0.34,
    phys: { shape: 'box', friction: 0.6, restitution: 0.16, angularDamping: 0.5 },
  });
  return g;
}

function buildTeether(D, parent) {
  const g = new THREE.Group();
  g.name = 'teether';
  const ring = D.mesh(
    new THREE.TorusGeometry(0.036, 0.0105, D.lod(6, 8, 10, 12), D.lod(16, 22, 28, 34)),
    D.mat('silicone'),
    { name: 'teether.ring' },
  );
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  // The nubbly bit babies actually chew.
  const nub = D.mesh(ellipsoid(0.013, 0.010, 0.013, 10, 7), D.tint('silicone', 0xc9dfd6), { name: 'teether.nub' });
  nub.position.set(0.036, 0.001, 0.0);
  g.add(nub);
  g.position.set(-0.18, MAT_TOP + 0.0105, 1.22);
  g.rotation.set(0.10, 0.7, 0.06);
  parent.add(g);
  D.prop({
    id: 'teether-ring',
    object3d: g,
    kind: 'edible',
    labelKey: 'prop.teether',
    points: 140,
    noise: 0.18,
    mass: 0.035,
    edibleTime: 1.3,
    reaction: 'yum',
    phys: { shape: 'box', friction: 0.7, restitution: 0.3 },
  });
}

// ──────────────────────────────────────────────────────────────────── api ────

export function buildPlaypen(D) {
  const group = new THREE.Group();
  group.name = 'playpen-contents';
  D.add(group);

  buildMat(D, group);
  buildBlanket(D, group);
  buildCushion(D, group);
  const hangers = [];
  buildPlayGym(D, group, hangers);
  buildStackingCups(D, group);
  buildBoardBook(D, group);
  buildToyBox(D, group);
  buildUkulele(D, group);
  buildTeether(D, group);

  const dir = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();

  return {
    group,
    /**
     * Redraw the four cords. The toy is driven by a spherical joint, so the cord has to follow it
     * rather than the other way round: one direction, one length, one quaternion per cord.
     */
    update() {
      for (let i = 0; i < hangers.length; i++) {
        const h = hangers[i];
        h.toy.getWorldPosition(pos);
        dir.subVectors(pos, h.anchor);
        const len = dir.length();
        if (len < 1e-4) continue;
        dir.multiplyScalar(1 / len);
        q.setFromUnitVectors(DOWN, dir);
        h.cord.quaternion.copy(q);
        h.cord.scale.y = len;
      }
    },
  };
}
