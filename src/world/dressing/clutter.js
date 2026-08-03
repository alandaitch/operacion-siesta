// OPERATION NAPTIME — module DRESS — the laptop, the snack bag, and everything a real family
// leaves lying about at ankle height.
//
// This file is the level design. Almost every scoring opportunity outside the shelving is here,
// and each object exists for a gameplay reason as much as a compositional one: the laptop is the
// 650-point prize on the sofa, the foil packet is the loudest edible in the game, the crayon is
// worth 250 and turns the screen magenta, the coin is the one thing in the room that is actually
// dangerous. They are scattered across three heights — glass table at 0.36, rug at 0.012, bare
// floor at 0 — so that crawling from one to the next is a route rather than a shopping list.
//
// Everything that sits on the rug is placed with `rugTop()`, which samples the rug's real
// displaced height field: a crayon that has rolled into the drag fold sits 13 mm higher than one
// in the dish under the ottoman. That is a detail nobody will consciously notice and everybody
// would notice the absence of, because objects floating a millimetre off a soft surface is the
// single most common tell in a real-time interior.

import * as THREE from 'three';
import {
  pillow, roundedRectOutline, roundedBox, lathe, spline, mergeGeos, place, ellipsoid,
  tubeAlong, noise2, restY, smoothstep, clamp, mix,
} from './util.js';
import { rugTop } from './rug.js';

// ──────────────────────────────────────────────────────────────── the laptop ──

function buildLaptop(D, parent) {
  const L = D.ctx.layout?.sofa?.laptop || { x: 2.30, z: 0.60, rot: -0.244 };
  const g = new THREE.Group();
  g.name = 'laptop';

  const W = 0.315;
  const DP = 0.222;
  const T = 0.014;
  const shell = D.tint('metal.blackAnodised', 0x33353a, { roughRange: [0.30, 0.58] });
  const dark = D.tint('plastic.matte', 0x191a1d, { roughRange: [0.44, 0.70] });

  // ── the base ──
  const baseParts = [place(roundedBox(W, T, DP, 0.0035, 2), 0, T * 0.5, 0)];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      baseParts.push(place(new THREE.CylinderGeometry(0.005, 0.0055, 0.0022, 8), sx * (W * 0.5 - 0.022), 0.001, sz * (DP * 0.5 - 0.020)));
    }
  }
  g.add(D.mesh(mergeGeos(baseParts), shell, { name: 'laptop.base' }));

  // ── the keyboard: a recessed well, sixty instanced keys, a glass trackpad ──
  const well = D.mesh(roundedBox(0.268, 0.003, 0.108, 0.001, 1), dark, { name: 'laptop.well' });
  well.position.set(0, T - 0.0012, -0.040);
  g.add(well);

  const COLS = 14;
  const ROWS = 5;
  const keyGeo = roundedBox(0.0158, 0.0026, 0.0148, 0.0007, 1);
  const keys = D.instanced(keyGeo, D.tint('plastic.matte', 0x232529, { roughRange: [0.34, 0.58] }), COLS * ROWS, { name: 'laptop.keys' });
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  let k = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      p.set((c - (COLS - 1) * 0.5) * 0.0186, T + 0.0008, -0.076 + r * 0.0177);
      // The bottom row is one wide bar and two modifiers — faked by stretching three keys.
      const wide = r === ROWS - 1 && c >= 5 && c <= 8;
      one.set(wide ? 1.9 : 1, 1, 1);
      keys.setMatrixAt(k++, m.compose(p, q, one));
    }
  }
  keys.instanceMatrix.needsUpdate = true;
  keys.computeBoundingSphere();
  g.add(keys);

  const pad = D.mesh(roundedBox(0.098, 0.0022, 0.066, 0.0008, 1), D.tint('screen.off', 0x24262b, { roughRange: [0.08, 0.22] }), { name: 'laptop.trackpad' });
  pad.position.set(0, T + 0.0002, 0.062);
  g.add(pad);

  // ── the lid, ajar at 74° ──
  const lid = new THREE.Group();
  lid.name = 'laptop.lid';
  lid.position.set(0, T - 0.002, -(DP * 0.5 - 0.004));
  lid.rotation.x = -1.292;
  const lidH = 0.010;
  const lidGeo = roundedBox(W, lidH, 0.212, 0.003, 2);
  lidGeo.translate(0, 0, 0.212 * 0.5); // hinge at the group origin
  lid.add(D.mesh(lidGeo, shell, { name: 'laptop.lid.shell' }));

  // Dark glass, off. `screen.off` is a smudged near-black dielectric: from crawling height it
  // catches the window as one long soft highlight, which is the only thing that says "screen".
  const screen = D.mesh(new THREE.PlaneGeometry(W - 0.024, 0.212 - 0.020), D.mat('screen.off'), {
    name: 'laptop.screen', cast: false,
  });
  screen.rotation.x = Math.PI / 2;
  screen.position.set(0, -(lidH * 0.5 + 0.0006), 0.212 * 0.5);
  lid.add(screen);
  g.add(lid);

  // Nothing on a soft cushion sits level: 3° of roll and a couple of millimetres of sink.
  g.position.set(L.x, 0.452, 0.40);
  g.rotation.set(0.016, L.rot ?? -0.244, 0.052);
  parent.add(g);

  D.prop({
    id: 'laptop',
    object3d: g,
    kind: 'pullable',
    labelKey: 'prop.laptop',
    points: 650,
    noise: 0.88,
    mass: 1.35,
    phys: {
      shape: 'box',
      size: { x: W, y: 0.13, z: DP },
      offset: new THREE.Vector3(0, 0.055, -0.02),
      friction: 0.55,
      restitution: 0.05,
      angularDamping: 0.6,
    },
  });
  return g;
}

// ───────────────────────────────────────────────────────────── the snack bag ──

/** A crisp packet outline: a rounded rectangle whose two ends pinch into the crimped seals. */
function snackOutline(w, h, r) {
  const base = roundedRectOutline(w, h, r);
  return (t) => {
    const p = base(t);
    const v = Math.abs(p.y) / (h * 0.5);
    return { x: p.x * (1 - 0.58 * smoothstep(0.52, 1.0, v)), y: p.y };
  };
}

function buildSnackBag(D, parent) {
  const L = D.ctx.layout?.snackBag || { x: 1.35, z: -0.55, rot: 0.646 };
  const W = 0.155;
  const H = 0.225;
  const half = 0.032;
  const geo = pillow({
    outline: snackOutline(W, H, 0.045),
    segments: D.lod(36, 50, 68, 84),
    half,
    rim: half * 0.92,
    capRings: D.lod(3, 4, 6, 7),
    rimRings: D.lod(2, 3, 4, 5),
    displace: (p, u, v) => {
      // The middle is full of air and the two crimped ends are pressed flat — that silhouette is
      // the whole reason a foil packet is recognisable at a glance.
      const ev = Math.abs(v - 0.5) * 2;
      const puff = 1 - smoothstep(0.50, 1.0, ev);
      p.z *= 0.14 + 0.86 * puff;
      // Hard, almost faceted creases. `foil.snack` supplies the micro-facets; this is the macro.
      p.z += (noise2(u * 8, v * 10, 1, 401, 2) - 0.5) * 0.011 * (0.30 + puff);
      p.x += (noise2(u * 6, v * 7, 1, 402, 2) - 0.5) * 0.007 * puff;
      p.y += (noise2(u * 5, v * 9, 1, 403, 2) - 0.5) * 0.007 * puff;
    },
  });
  geo.rotateX(-Math.PI / 2);
  const mesh = D.mesh(geo, D.mat('foil.snack'), { name: 'snack-bag' });
  const rot = [0.04, L.rot ?? 0.646, -0.09];
  // The crinkle displacement makes the silhouette unpredictable by a few millimetres, so the
  // resting height is measured off the finished geometry rather than guessed from `half`.
  mesh.position.set(L.x, restY(geo, rot, rugTop(L.x, L.z), 0.002), L.z);
  mesh.rotation.set(rot[0], rot[1], rot[2]);
  parent.add(mesh);

  D.prop({
    id: 'snack-bag',
    object3d: mesh,
    kind: 'edible',
    labelKey: 'prop.snackBag',
    points: 260,
    noise: 0.82, // foil is the loudest thing a baby can pick up
    mass: 0.06,
    edibleTime: 2.0,
    reaction: 'yum',
    phys: { shape: 'box', friction: 0.5, restitution: 0.15, linearDamping: 0.5, angularDamping: 0.6 },
  });
  return mesh;
}

// ────────────────────────────────────────────────────────── the small stuff ──

function buildRemote(D, parent) {
  const g = new THREE.Group();
  g.name = 'remote';
  const W = 0.047;
  const H = 0.019;
  const DP = 0.172;
  const body = D.mesh(roundedBox(W, H, DP, 0.0085, 2), D.tint('plastic.matte', 0x212327, { roughRange: [0.42, 0.68] }), { name: 'remote.body' });
  g.add(body);
  // The IR window: the one glossy face on an otherwise dead-matte object.
  const ir = D.mesh(roundedBox(0.024, 0.0016, 0.012, 0.0006, 1), D.tint('screen.off', 0x191b20, { roughRange: [0.05, 0.18] }), { name: 'remote.ir' });
  ir.position.set(0, H * 0.5 - 0.0004, -DP * 0.5 + 0.012);
  g.add(ir);

  const btnGeo = roundedBox(0.0088, 0.0022, 0.0062, 0.0009, 1);
  const btns = D.instanced(btnGeo, D.tint('plastic.matte', 0x4a4d52, { roughRange: [0.38, 0.62] }), 21, { name: 'remote.buttons' });
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3(1, 1, 1);
  let i = 0;
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 3; c++) {
      p.set((c - 1) * 0.0125, H * 0.5 - 0.0002, -0.052 + r * 0.0185);
      s.set(r === 1 ? 1.25 : 1, 1, r === 1 ? 1.6 : 1);
      btns.setMatrixAt(i++, m.compose(p, q, s));
    }
  }
  btns.instanceMatrix.needsUpdate = true;
  btns.computeBoundingSphere();
  g.add(btns);
  const power = D.mesh(new THREE.CylinderGeometry(0.0044, 0.0044, 0.0024, 10), D.tint('plastic.toy', 0xc23a2c, { roughRange: [0.24, 0.42] }), { name: 'remote.power' });
  power.position.set(0, H * 0.5 - 0.0002, -0.072);
  g.add(power);

  const y = rugTop(1.78, -1.18);
  g.position.set(1.78, y + H * 0.42, -1.18);
  g.rotation.set(0.0, -0.72, 0.06);
  parent.add(g);
  D.prop({
    id: 'remote',
    object3d: g,
    kind: 'edible',
    labelKey: 'prop.remote',
    points: 190,
    noise: 0.4,
    mass: 0.14,
    edibleTime: 2.2,
    reaction: 'gross',
    phys: { shape: 'box', friction: 0.6, restitution: 0.14, angularDamping: 0.5 },
  });
}

// ───────────────────────────────────────────── on the glass coffee table ─────
// The table top is at y 0.36 (FURN builds a 12 mm low-iron slab at that height), which is 6 cm
// below the baby's eyeline: everything up here is silhouetted against the window and seen from
// underneath through the glass, so the undersides matter as much as the tops.

const TABLE = { x: 0.95, z: -2.35, y: 0.3605, rot: 0.0524 };

/** Table-local (right, forward) to world, honouring the table's 3° yaw. */
function onTable(dx, dz) {
  const c = Math.cos(TABLE.rot);
  const s = Math.sin(TABLE.rot);
  return { x: TABLE.x + dx * c + dz * s, z: TABLE.z - dx * s + dz * c };
}

function buildKeys(D, parent) {
  const g = new THREE.Group();
  g.name = 'keys';
  const brass = D.tint('metal.brass', 0xc2a267, { roughRange: [0.22, 0.48] });
  const steel = D.tint('metal.chrome', 0xc8ccd0, { roughRange: [0.14, 0.38] });

  const ring = D.mesh(new THREE.TorusGeometry(0.0195, 0.0017, 6, D.lod(14, 18, 24, 30)), steel, { name: 'keys.ring' });
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.0017;
  g.add(ring);

  // Three keys fanned round the ring, each a bow with a real hole plus a toothed blade.
  const KEYS = [
    { a: 0.35, len: 0.040, mat: 'brass' },
    { a: 1.15, len: 0.046, mat: 'steel' },
    { a: 2.20, len: 0.036, mat: 'brass' },
  ];
  const brassParts = [];
  const steelParts = [];
  for (const kspec of KEYS) {
    const dx = Math.cos(kspec.a);
    const dz = Math.sin(kspec.a);
    const bowR = 0.0195 + 0.010;
    const parts = kspec.mat === 'brass' ? brassParts : steelParts;
    // bow: a flattened torus is a ring with a genuine hole in it
    const bow = new THREE.TorusGeometry(0.0082, 0.0038, 5, D.lod(10, 12, 16, 20));
    bow.scale(1, 1, 0.30);
    parts.push(place(bow, dx * bowR, 0.0013, dz * bowR, Math.PI / 2, 0, 0));
    // blade, with three teeth cut out of its top edge
    const bladeC = bowR + kspec.len * 0.5 + 0.006;
    parts.push(place(roundedBox(kspec.len, 0.0016, 0.0072, 0.0004, 1), dx * bladeC, 0.0013, dz * bladeC, 0, -kspec.a, 0));
    for (let t = 0; t < 3; t++) {
      const off = bowR + 0.014 + t * 0.010;
      parts.push(place(roundedBox(0.0042, 0.0018, 0.0026, 0.0004, 1), dx * off, 0.0016, dz * off + 0.0026, 0, -kspec.a, 0));
    }
  }
  g.add(D.mesh(mergeGeos(brassParts), brass, { name: 'keys.brass' }));
  g.add(D.mesh(mergeGeos(steelParts), steel, { name: 'keys.steel' }));

  // A leather fob, because a bare keyring reads as a prop and not as somebody's keys.
  const fob = D.mesh(roundedBox(0.020, 0.0032, 0.030, 0.0014, 1), D.tint('wood.walnut', 0x6a4a35, { roughRange: [0.5, 0.78] }), { name: 'keys.fob' });
  fob.position.set(-0.028, 0.0016, -0.012);
  fob.rotation.y = 0.5;
  g.add(fob);

  const at = onTable(0.22, -0.09);
  g.position.set(at.x, TABLE.y, at.z);
  g.rotation.y = -0.9;
  parent.add(g);

  D.prop({
    id: 'keys',
    object3d: g,
    kind: 'edible',
    labelKey: 'prop.keys',
    points: 220,
    noise: 0.66, // keys on a glass table are the single most alerting sound in the room
    mass: 0.09,
    edibleTime: 1.6,
    reaction: 'gross',
    phys: { shape: 'box', friction: 0.4, restitution: 0.2, angularDamping: 0.4 },
  });
}

/** A stoneware mug, half full, and the ring it left when somebody moved it. */
function buildCoffeeCup(D, parent) {
  const g = new THREE.Group();
  g.name = 'coffee-cup';
  const H = 0.098;
  const R = 0.043;
  const path = (t) => {
    if (t <= 0.60) {
      const u = t / 0.60;
      const r = R * (0.80 + 0.20 * Math.sin(u * Math.PI * 0.9)) - (1 - u) * 0.0018;
      return { r: Math.max(0.004, r), y: u * H };
    }
    if (t < 0.68) {
      const u = (t - 0.60) / 0.08;
      return { r: R * (1 - u * 0.06), y: H + Math.sin(u * Math.PI * 0.5) * 0.0024 };
    }
    const u = (t - 0.68) / 0.32;
    return { r: Math.max(0.0035, R * 0.94 * (1 - u * 0.09) - u * 0.004), y: H + 0.0024 - u * (H - 0.008) };
  };
  const glaze = D.tint('ceramic.glazed', 0xe6ddc9, { roughRange: [0.14, 0.46] });
  g.add(D.mesh(
    lathe({ path, rings: D.lod(16, 24, 32, 40), segments: D.lod(16, 24, 32, 40), closeBottom: true }),
    glaze,
    { name: 'coffee-cup.body' },
  ));
  const handle = D.mesh(new THREE.TorusGeometry(0.0265, 0.0058, 7, D.lod(12, 16, 20, 26), Math.PI * 1.3), glaze, { name: 'coffee-cup.handle' });
  handle.rotation.set(0, Math.PI / 2, -0.28);
  handle.position.set(0, H * 0.54, 0.042);
  g.add(handle);
  // What is left of the coffee: a dark, near-mirror disc 22 mm down the inside.
  const coffee = D.mesh(new THREE.CircleGeometry(R * 0.88, D.lod(14, 20, 26, 32)), D.tint('ceramic.glazed', 0x2a1a0f, { roughRange: [0.04, 0.14] }), { name: 'coffee-cup.coffee', cast: false });
  coffee.rotation.x = -Math.PI / 2;
  coffee.position.y = H - 0.030;
  g.add(coffee);

  const at = onTable(-0.20, 0.06);
  g.position.set(at.x, TABLE.y, at.z);
  g.rotation.y = 1.9;
  parent.add(g);

  // The ring stain, where the mug stood before somebody slid it across.
  const stain = D.mesh(
    new THREE.RingGeometry(R * 0.86, R * 1.06, D.lod(18, 24, 32, 40)),
    D.tint('paper.page', 0x6b4a2a, {
      transparent: true, opacity: 0.42, roughness: 0.24, side: THREE.DoubleSide, depthWrite: false,
    }),
    { name: 'coffee-ring', cast: false },
  );
  stain.rotation.x = -Math.PI / 2;
  const sat = onTable(-0.05, -0.10);
  stain.position.set(sat.x, TABLE.y + 0.0008, sat.z);
  stain.renderOrder = 3;
  parent.add(stain);

  D.prop({
    id: 'coffee-cup',
    object3d: g,
    kind: 'knockable',
    labelKey: 'prop.coffeeCup',
    points: 230,
    noise: 0.78,
    mass: 0.34,
    fragile: true,
    phys: {
      shape: 'cylinder',
      radius: R + 0.004,
      halfHeight: H * 0.5,
      offset: new THREE.Vector3(0, H * 0.5, 0),
      friction: 0.55,
      restitution: 0.08,
    },
  });
}

function buildCoaster(D, parent) {
  const geo = lathe({
    // A cork disc with a chamfer top and bottom: 4 mm of edge is enough to catch the window.
    path: (t) => {
      const u = clamp(t, 0, 1);
      const r = 0.047 - Math.max(0, Math.abs(u - 0.5) * 2 - 0.72) * 0.020;
      return { r, y: u * 0.0062 };
    },
    rings: 8,
    segments: D.lod(14, 20, 26, 32),
    closeBottom: true,
    closeTop: true,
    perturb: (t, th) => 0.0004 * (noise2(Math.cos(th) + 1, Math.sin(th) + 1, 1, 55, 2) - 0.5),
  });
  const mesh = D.mesh(geo, D.tint('wood.oak', 0xcaa877, { roughRange: [0.62, 0.88] }), { name: 'coaster' });
  const at = onTable(0.06, 0.13);
  mesh.position.set(at.x, TABLE.y, at.z);
  mesh.rotation.set(0, 0.6, 0);
  parent.add(mesh);
  D.prop({
    id: 'coaster',
    object3d: mesh,
    kind: 'knockable',
    labelKey: 'prop.coaster',
    points: 50,
    noise: 0.3,
    mass: 0.03,
    phys: { shape: 'cylinder', radius: 0.047, halfHeight: 0.0031, offset: new THREE.Vector3(0, 0.0031, 0), friction: 0.5, restitution: 0.3 },
  });
}

// ──────────────────────────────────────────────────── soft things on the floor ─

/** A sock: a tapered tube through cuff → ankle → heel → toe, squashed flat. */
function sockGeometry(D, balled) {
  if (balled) {
    return mergeGeos([
      ellipsoid(0.045, 0.036, 0.040, 12, 9),
      place(ellipsoid(0.030, 0.024, 0.028, 10, 7), 0.018, 0.020, -0.012, 0.4, 0.3, 0),
      place(new THREE.TorusGeometry(0.026, 0.008, 6, 16), -0.020, 0.024, 0.014, 0.9, 0.4, 0),
    ]);
  }
  const geo = tubeAlong([
    new THREE.Vector3(0, 0.016, -0.075),
    new THREE.Vector3(0.004, 0.014, -0.030),
    new THREE.Vector3(0.008, 0.012, 0.014),
    new THREE.Vector3(0.028, 0.011, 0.048),
    new THREE.Vector3(0.062, 0.010, 0.060),
  ], (t) => mix(0.031, 0.020, t ** 1.4), D.lod(8, 11, 15, 18), D.lod(6, 7, 9, 10));
  // Flattened: a sock on the floor has no volume left in it.
  geo.scale(1, 0.44, 1);
  return geo;
}

function buildSocks(D, parent) {
  const specs = [
    { id: 'sock-1', balled: true, x: 0.34, z: -1.52, onRug: true, yaw: 0.4, hex: 0x6e7480 },
    { id: 'sock-2', balled: false, x: -1.94, z: 0.58, onRug: false, yaw: -1.25, hex: 0x8e8674 },
  ];
  for (const s of specs) {
    const g = new THREE.Group();
    g.name = s.id;
    g.add(D.mesh(sockGeometry(D, s.balled), D.tint('cloth.onesie', s.hex, { roughRange: [0.74, 0.94] }), { name: `${s.id}.knit` }));
    const rot = [0, s.yaw, s.balled ? 0.2 : 0.02];
    const surface = s.onRug ? rugTop(s.x, s.z) : 0;
    const box = new THREE.Box3().setFromObject(g);
    g.position.set(s.x, restY(box, rot, surface, 0.004), s.z);
    g.rotation.set(rot[0], rot[1], rot[2]);
    parent.add(g);
    D.prop({
      id: s.id,
      object3d: g,
      kind: 'edible',
      labelKey: 'prop.sock',
      points: 150,
      noise: 0.08,
      mass: 0.035,
      edibleTime: 1.9,
      reaction: 'gross',
      phys: { shape: 'box', friction: 0.75, restitution: 0.02, linearDamping: 0.6, angularDamping: 0.85 },
    });
  }
}

/** A muslin square folded in four and dumped on the ottoman. Three offset leaves, not one slab. */
function buildFoldedMuslin(D, parent) {
  const g = new THREE.Group();
  g.name = 'folded-muslin';
  const mat = D.mat('fabric.muslin');
  for (let i = 0; i < 3; i++) {
    const w = 0.235 - i * 0.014;
    const d = 0.185 - i * 0.011;
    const half = 0.0055;
    const geo = pillow({
      outline: roundedRectOutline(w, d, 0.014),
      segments: D.lod(18, 24, 32, 40),
      half,
      rim: half * 0.9,
      capRings: 2,
      rimRings: 1,
      displace: (p, u, v, s) => {
        p.z += (noise2(u * 4 + i * 3, v * 4, 1, 601 + i, 2) - 0.5) * 0.0035;
        p.z += (s * 2 - 1) * (noise2(u * 9, v * 9, 1, 611 + i, 2) - 0.5) * 0.0022;
      },
    });
    geo.rotateX(-Math.PI / 2);
    const leaf = D.mesh(geo, mat, { name: `folded-muslin.${i}` });
    leaf.position.set(i * 0.006, 0.0055 + i * 0.0102, i * -0.004);
    leaf.rotation.y = i * 0.055;
    g.add(leaf);
  }
  g.position.set(-1.62, 0.4215, -1.92);
  g.rotation.set(0.02, -0.28, 0.0);
  parent.add(g);
  D.prop({
    id: 'folded-muslin',
    object3d: g,
    kind: 'pullable',
    labelKey: 'prop.foldedMuslin',
    points: 80,
    noise: 0.1,
    mass: 0.09,
    phys: { shape: 'box', friction: 0.7, restitution: 0.02, angularDamping: 0.8 },
  });
}

// ──────────────────────────────────────────────────────── the small edibles ──

function buildBabyBottle(D, parent) {
  const g = new THREE.Group();
  g.name = 'baby-bottle';
  const H = 0.118;
  const prof = spline([[0, 0.030], [0.08, 0.0325], [0.62, 0.0328], [0.74, 0.0290], [0.86, 0.0225], [1, 0.0218]]);
  g.add(D.mesh(
    lathe({ radius: (t) => prof(t), height: H, rings: D.lod(14, 20, 28, 34), segments: D.lod(14, 20, 26, 32), closeBottom: true }),
    D.tint('glass.clear', 0xeef1ee, { roughRange: [0.06, 0.24] }),
    { name: 'baby-bottle.body' },
  ));
  // The milk inside, stopping two thirds up — a clear bottle with nothing in it reads as empty
  // glass, and a baby bottle without milk in it is not what anybody pictures.
  g.add(D.mesh(
    lathe({ radius: (t) => prof(t * 0.60) - 0.0022, height: H * 0.60, rings: 8, segments: D.lod(12, 16, 22, 28), closeBottom: true, closeTop: true }),
    D.tint('ceramic.glazed', 0xf7f2e6, { roughRange: [0.08, 0.24] }),
    { name: 'baby-bottle.milk' },
  ));
  const collar = D.mesh(new THREE.CylinderGeometry(0.0246, 0.0238, 0.017, D.lod(12, 16, 22, 26)), D.tint('plastic.toy', 0x8fc6d8, { roughRange: [0.22, 0.44] }), { name: 'baby-bottle.collar' });
  collar.position.y = H + 0.0055;
  g.add(collar);
  const teat = D.mesh(
    lathe({
      radius: (t) => mix(0.0175, 0.0052, t ** 0.7) * (1 + 0.22 * Math.sin(t * 3.1)),
      height: 0.036,
      rings: D.lod(8, 10, 14, 18),
      segments: D.lod(10, 14, 18, 24),
      closeBottom: false,
      closeTop: true,
    }),
    D.mat('silicone'),
    { name: 'baby-bottle.teat' },
  );
  teat.position.y = H + 0.013;
  g.add(teat);

  // On its side on the bare floor by the pen, teat pointing into the room.
  g.position.set(-0.80, 0.0325, 0.52);
  g.rotation.set(0, 0.4, Math.PI * 0.5 + 0.06);
  parent.add(g);
  D.prop({
    id: 'baby-bottle',
    object3d: g,
    kind: 'edible',
    labelKey: 'prop.babyBottle',
    points: 170,
    noise: 0.36,
    mass: 0.19,
    edibleTime: 1.7,
    reaction: 'yum',
    phys: { shape: 'capsule', radius: 0.033, halfHeight: 0.038, friction: 0.5, restitution: 0.14, angularDamping: 0.3 },
  });
}

function buildPacifier(D, parent) {
  const g = new THREE.Group();
  g.name = 'pacifier';
  const shieldMat = D.tint('plastic.toy', 0xf0c6cf, { roughRange: [0.2, 0.4] });
  const shield = mergeGeos([
    place(ellipsoid(0.027, 0.0042, 0.020, 14, 7), 0, 0, 0),
    place(new THREE.TorusGeometry(0.0105, 0.0028, 6, D.lod(12, 16, 20, 24)), 0, 0.0135, -0.006, 0.35, 0, 0),
  ]);
  g.add(D.mesh(shield, shieldMat, { name: 'pacifier.shield' }));
  const teat = D.mesh(
    lathe({
      radius: (t) => 0.0062 + Math.sin(t * Math.PI) * 0.0048,
      height: 0.026,
      rings: D.lod(7, 9, 12, 15),
      segments: D.lod(9, 12, 16, 20),
      closeBottom: false,
      closeTop: true,
    }),
    D.mat('silicone'),
    { name: 'pacifier.teat' },
  );
  teat.rotation.x = Math.PI / 2;
  teat.position.set(0, -0.001, 0.006);
  g.add(teat);

  const rot = [-0.28, 1.1, 0.12];
  g.position.set(0.42, restY(new THREE.Box3().setFromObject(g), rot, rugTop(0.42, -0.96), 0.001), -0.96);
  g.rotation.set(rot[0], rot[1], rot[2]);
  parent.add(g);
  D.prop({
    id: 'pacifier',
    object3d: g,
    kind: 'edible',
    labelKey: 'prop.pacifier',
    points: 150,
    noise: 0.06,
    mass: 0.012,
    edibleTime: 1.1,
    reaction: 'yum',
    phys: { shape: 'box', friction: 0.6, restitution: 0.24 },
  });
}

function buildCrayons(D, parent) {
  const specs = [
    { id: 'crayon-1', hex: 0xc9382c, wrap: 0xd8483a, x: -0.58, z: -0.34, yaw: 0.9, roll: 0.0 },
    { id: 'crayon-2', hex: 0x2f6bb5, wrap: 0x3d7cc4, x: -0.41, z: -0.47, yaw: -0.35, roll: 0.6 },
  ];
  for (const s of specs) {
    const g = new THREE.Group();
    g.name = s.id;
    const R = 0.0053;
    const wax = mergeGeos([
      place(new THREE.CylinderGeometry(R, R, 0.074, D.lod(8, 10, 14, 16)), 0, 0, 0, Math.PI / 2, 0, 0),
      place(new THREE.ConeGeometry(R, 0.013, D.lod(8, 10, 14, 16)), 0, 0, 0.0435, -Math.PI / 2, 0, 0),
    ]);
    g.add(D.mesh(wax, D.tint('plastic.toy', s.hex, { roughRange: [0.42, 0.68] }), { name: `${s.id}.wax` }));
    // The paper wrapper: a hair proud of the wax, with its printed band.
    const wrap = D.mesh(
      new THREE.CylinderGeometry(R + 0.0004, R + 0.0004, 0.050, D.lod(8, 10, 14, 16), 1, true),
      D.tint('card.print', s.wrap, { roughRange: [0.66, 0.9], side: THREE.DoubleSide }),
      { name: `${s.id}.wrapper` },
    );
    wrap.rotation.x = Math.PI / 2;
    wrap.position.z = -0.006;
    g.add(wrap);

    const rot = [0, s.yaw, s.roll];
    g.position.set(s.x, restY(new THREE.Box3().setFromObject(g), rot, rugTop(s.x, s.z), 0.0008), s.z);
    g.rotation.set(rot[0], rot[1], rot[2]);
    parent.add(g);
    D.prop({
      id: s.id,
      object3d: g,
      kind: 'edible',
      labelKey: 'prop.crayon',
      points: 250,
      noise: 0.12,
      mass: 0.009,
      edibleTime: 1.3,
      reaction: 'spicy',
      phys: { shape: 'capsule', radius: R, halfHeight: 0.030, friction: 0.55, restitution: 0.1 },
    });
  }
}

function buildCoin(D, parent) {
  const geo = lathe({
    // A milled edge and a very slightly domed face — flat cylinders read as washers.
    path: (t) => {
      const u = clamp(t, 0, 1);
      return { r: 0.0116 - Math.max(0, Math.abs(u - 0.5) * 2 - 0.55) * 0.0016, y: u * 0.0019 };
    },
    rings: 6,
    segments: D.lod(16, 22, 30, 38),
    closeBottom: true,
    closeTop: true,
    perturb: (t, th) => 0.00012 * Math.cos(th * 44),
  });
  const mesh = D.mesh(geo, D.tint('metal.brass', 0xb69157, { roughRange: [0.24, 0.52] }), { name: 'coin' });
  mesh.position.set(-2.58, 0.0006, 0.34);
  mesh.rotation.set(0.02, 0.7, 0.015);
  parent.add(mesh);
  D.prop({
    id: 'coin',
    object3d: mesh,
    kind: 'edible',
    labelKey: 'prop.coin',
    points: 300,
    noise: 0.44,
    mass: 0.008,
    edibleTime: 1.0,
    reaction: 'dangerous',
    phys: { shape: 'cylinder', radius: 0.0116, halfHeight: 0.001, offset: new THREE.Vector3(0, 0.001, 0), friction: 0.4, restitution: 0.35 },
  });
}

// ───────────────────────────────────────────────────────────────────── api ───

export function buildClutter(D) {
  const group = new THREE.Group();
  group.name = 'clutter';
  D.add(group);

  buildLaptop(D, group);
  buildSnackBag(D, group);
  buildRemote(D, group);
  buildKeys(D, group);
  buildCoffeeCup(D, group);
  buildCoaster(D, group);
  buildSocks(D, group);
  buildFoldedMuslin(D, group);
  buildBabyBottle(D, group);
  buildPacifier(D, group);
  buildCrayons(D, group);
  buildCoin(D, group);

  return { group };
}
