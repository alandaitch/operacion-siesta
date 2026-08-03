// OPERATION NAPTIME — module DRESS — the plush pile.
//
// Fourteen soft toys, and they carry a disproportionate share of the frame: per the art direction
// bible they are the ONLY saturated colour in the room, which makes this pile the focal point of
// the whole composition and the reason the rest of the palette can stay in warm neutrals.
//
// Five archetypes — bunny, teddy, mouse, giraffe, rattle ball — each merged down to three
// geometries (body, accent, eyes) so a toy costs three draws, and each geometry built exactly once
// and shared by every copy of that archetype. The eight toys the baby can actually reach are
// individual meshes with their own props and their own tint; the six that form the floor of the
// pile are InstancedMeshes with per-instance colour, which is what makes a fourteen-toy pile cost
// nine draws instead of forty-two.
//
// The pile itself is hand-placed, never generated: every toy is at a different tumble, several are
// on their backs or their sides, and neighbours interpenetrate by a centimetre or two, because a
// pile of soft toys that all sit level and clear of each other reads as a shop display.

import * as THREE from 'three';
import { ellipsoid, mergeGeos, place, restY, tubeAlong } from './util.js';

/** Two beady eyes and (optionally) a nose, in one geometry, for every archetype with a face. */
function face(ey, ez, spread, noseZ, noseY) {
  const parts = [
    place(ellipsoid(0.0042, 0.0046, 0.0034, 7, 5), -spread, ey, ez),
    place(ellipsoid(0.0042, 0.0046, 0.0034, 7, 5), spread, ey, ez),
  ];
  if (noseZ !== undefined) parts.push(place(ellipsoid(0.0055, 0.0042, 0.0044, 7, 5), 0, noseY, noseZ));
  return mergeGeos(parts);
}

// ─────────────────────────────────────────────────────────────── archetypes ──

function bunny() {
  const body = mergeGeos([
    place(ellipsoid(0.044, 0.050, 0.040, 12, 9), 0, -0.006, 0),
    place(ellipsoid(0.034, 0.032, 0.031, 12, 9), 0, 0.052, 0.006),
    // haunches and forepaws
    place(ellipsoid(0.017, 0.016, 0.022, 8, 6), -0.036, -0.036, 0.004),
    place(ellipsoid(0.017, 0.016, 0.022, 8, 6), 0.036, -0.036, 0.004),
    place(ellipsoid(0.011, 0.012, 0.014, 8, 6), -0.023, -0.030, 0.033),
    place(ellipsoid(0.011, 0.012, 0.014, 8, 6), 0.023, -0.030, 0.033),
    place(ellipsoid(0.014, 0.014, 0.013, 8, 6), 0, -0.020, -0.040), // the tail
    // the ears: long, tapered, and NOT parallel — one flops
    place(ellipsoid(0.010, 0.038, 0.007, 8, 8), -0.016, 0.104, -0.004, 0.16, 0, -0.22),
    place(ellipsoid(0.010, 0.038, 0.007, 8, 8), 0.018, 0.098, -0.002, 0.10, 0, 0.46),
  ]);
  const accent = mergeGeos([
    place(ellipsoid(0.0055, 0.026, 0.0035, 6, 7), -0.017, 0.106, 0.002, 0.16, 0, -0.22),
    place(ellipsoid(0.0055, 0.026, 0.0035, 6, 7), 0.019, 0.100, 0.004, 0.10, 0, 0.46),
    place(ellipsoid(0.017, 0.014, 0.013, 9, 7), 0, 0.044, 0.026),
  ]);
  return { body, accent, eye: face(0.056, 0.028, 0.013, 0.036, 0.048), radius: 0.075 };
}

function teddy() {
  const body = mergeGeos([
    place(ellipsoid(0.048, 0.048, 0.042, 12, 10), 0, 0, 0),
    place(ellipsoid(0.036, 0.034, 0.033, 12, 10), 0, 0.058, 0.004),
    place(ellipsoid(0.016, 0.016, 0.010, 9, 7), -0.030, 0.080, -0.004),
    place(ellipsoid(0.016, 0.016, 0.010, 9, 7), 0.030, 0.082, -0.002),
    // arms out, legs forward: a teddy is a starfish with fur
    place(ellipsoid(0.014, 0.026, 0.014, 8, 7), -0.048, 0.012, 0.008, 0, 0, 0.85),
    place(ellipsoid(0.014, 0.026, 0.014, 8, 7), 0.048, 0.010, 0.008, 0, 0, -0.75),
    place(ellipsoid(0.016, 0.028, 0.016, 8, 7), -0.026, -0.044, 0.014, 0.75, 0, 0.12),
    place(ellipsoid(0.016, 0.028, 0.016, 8, 7), 0.026, -0.046, 0.012, 0.80, 0, -0.10),
  ]);
  const accent = mergeGeos([
    place(ellipsoid(0.017, 0.013, 0.012, 10, 7), 0, 0.048, 0.026),
    place(ellipsoid(0.009, 0.009, 0.004, 7, 5), -0.030, -0.058, 0.026),
    place(ellipsoid(0.009, 0.009, 0.004, 7, 5), 0.030, -0.060, 0.024),
    place(ellipsoid(0.009, 0.009, 0.004, 7, 5), -0.052, 0.030, 0.010),
  ]);
  return { body, accent, eye: face(0.062, 0.028, 0.014, 0.034, 0.050), radius: 0.075 };
}

function mouse() {
  const body = mergeGeos([
    // one teardrop: a mouse has no neck
    place(ellipsoid(0.036, 0.034, 0.052, 12, 10), 0, 0, -0.006),
    place(ellipsoid(0.024, 0.023, 0.026, 10, 8), 0, 0.010, 0.042),
    place(ellipsoid(0.010, 0.008, 0.011, 7, 5), -0.020, -0.030, 0.030),
    place(ellipsoid(0.010, 0.008, 0.011, 7, 5), 0.020, -0.030, 0.030),
    place(ellipsoid(0.028, 0.028, 0.007, 10, 9), -0.030, 0.036, 0.014, 0, -0.35, -0.30),
    place(ellipsoid(0.028, 0.028, 0.007, 10, 9), 0.030, 0.038, 0.014, 0, 0.35, 0.30),
  ]);
  const tail = tubeAlong([
    new THREE.Vector3(0, -0.004, -0.052),
    new THREE.Vector3(0.020, 0.004, -0.086),
    new THREE.Vector3(0.056, -0.006, -0.100),
    new THREE.Vector3(0.086, 0.008, -0.078),
  ], (t) => 0.0042 * (1 - t * 0.55), 10, 5);
  const accent = mergeGeos([
    place(ellipsoid(0.019, 0.019, 0.004, 9, 8), -0.031, 0.036, 0.019, 0, -0.35, -0.30),
    place(ellipsoid(0.019, 0.019, 0.004, 9, 8), 0.031, 0.038, 0.019, 0, 0.35, 0.30),
    tail,
  ]);
  return { body, accent, eye: face(0.016, 0.060, 0.013, 0.066, 0.008), radius: 0.070 };
}

function giraffe() {
  const legs = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      legs.push(place(
        ellipsoid(0.011, 0.030, 0.011, 7, 6),
        sx * 0.024, -0.052, sz * 0.026, sz * 0.10, 0, sx * 0.10,
      ));
    }
  }
  const neck = tubeAlong([
    new THREE.Vector3(0, 0.014, 0.028),
    new THREE.Vector3(0, 0.052, 0.042),
    new THREE.Vector3(0, 0.086, 0.050),
  ], (t) => 0.017 * (1 - t * 0.30), 8, 7);
  const body = mergeGeos([
    place(ellipsoid(0.032, 0.032, 0.052, 12, 9), 0, 0, 0),
    neck,
    place(ellipsoid(0.019, 0.017, 0.026, 10, 8), 0, 0.096, 0.062),
    place(ellipsoid(0.005, 0.010, 0.005, 6, 5), -0.008, 0.110, 0.050),
    place(ellipsoid(0.005, 0.010, 0.005, 6, 5), 0.008, 0.110, 0.050),
    ...legs,
  ]);
  // Spots, and a stitched mane down the back of the neck.
  const spots = [];
  const SP = [
    [-0.026, 0.010, 0.014], [0.024, 0.004, -0.010], [-0.018, -0.014, -0.032],
    [0.020, 0.018, 0.030], [-0.028, 0.014, -0.016], [0.026, -0.012, 0.018],
    [0.000, 0.030, -0.034], [-0.010, 0.062, 0.048],
  ];
  for (let i = 0; i < SP.length; i++) {
    spots.push(place(ellipsoid(0.011, 0.010, 0.010, 7, 5), SP[i][0] * 1.03, SP[i][1], SP[i][2] * 1.03));
  }
  spots.push(place(ellipsoid(0.004, 0.014, 0.026, 6, 6), 0, 0.070, 0.028, -0.5, 0, 0));
  spots.push(place(ellipsoid(0.012, 0.010, 0.008, 8, 6), 0, 0.090, 0.082));
  return { body, accent: mergeGeos(spots), eye: face(0.102, 0.074, 0.014), radius: 0.080 };
}

function rattleBall() {
  const body = ellipsoid(0.042, 0.040, 0.042, 14, 11);
  const accent = mergeGeos([
    place(new THREE.TorusGeometry(0.041, 0.0035, 6, 22), 0, 0, 0, Math.PI / 2, 0, 0.3),
    place(new THREE.TorusGeometry(0.038, 0.0030, 6, 20), 0, 0.012, 0, 0, 0, 0.1),
    place(ellipsoid(0.011, 0.011, 0.011, 8, 6), 0, 0.044, 0.006),
  ]);
  return { body, accent, eye: null, radius: 0.048 };
}

const ARCHETYPES = { bunny, teddy, mouse, giraffe, rattleBall };

// ───────────────────────────────────────────────────────────── the pile ──────

// Hand-placed, every one of them. `t` is the tumble (x,y,z euler) and `sink` how far the toy
// presses into the mat and into its neighbours — several are on their backs, and every one of them
// takes its resting height from `restY`, so no ear, tail or leg can end up under the floor.
const HERO = [
  { id: 'plush-bunny-1', kind: 'bunny', x: 0.44, z: 2.34, sink: 0.011, t: [0.28, 0.90, -0.36], hex: 0xf0a7ad, acc: 0xffd9d6 },
  { id: 'plush-teddy-1', kind: 'teddy', x: 0.72, z: 2.22, sink: 0.013, t: [1.36, -0.40, 0.22], hex: 0xd9a259, acc: 0xf3ddb4 },
  { id: 'plush-mouse-1', kind: 'mouse', x: 0.93, z: 2.48, sink: 0.009, t: [0.12, 2.20, 0.46], hex: 0xb5b7b2, acc: 0xf2b9bd },
  { id: 'plush-giraffe', kind: 'giraffe', x: 0.58, z: 2.66, sink: 0.012, t: [1.18, 0.62, 0.14], hex: 0xf0c14e, acc: 0x9a6a34 },
  { id: 'plush-bunny-2', kind: 'bunny', x: 0.29, z: 2.56, sink: 0.008, t: [1.50, -1.22, 0.05], hex: 0xa9c6a4, acc: 0xe4efd9 },
  { id: 'plush-rattle', kind: 'rattleBall', x: 1.01, z: 2.20, sink: 0.005, t: [0.42, 0.20, 0.72], hex: 0xe0765a, acc: 0xffe2c8 },
  { id: 'plush-teddy-2', kind: 'teddy', x: 0.86, z: 2.73, sink: 0.014, t: [0.92, 2.62, -0.26], hex: 0xb9a9d4, acc: 0xeee6f7 },
  { id: 'plush-mouse-2', kind: 'mouse', x: 0.47, z: 2.15, sink: 0.015, t: [1.22, -2.05, 0.32], hex: 0x8fb2cf, acc: 0xdce9f2 },
];

/** The floor of the pile: half-buried, instanced, per-instance colour. */
const BASE = [
  { kind: 'bunny', x: 0.62, z: 2.45, sink: 0.019, t: [1.62, 0.42, 0.20], hex: 0xe6d3b4 },
  { kind: 'bunny', x: 0.95, z: 2.63, sink: 0.017, t: [1.44, -2.30, -0.35], hex: 0xf0b7a0 },
  { kind: 'teddy', x: 0.78, z: 2.57, sink: 0.020, t: [1.52, 1.30, 0.10], hex: 0xcfc0a2 },
  { kind: 'teddy', x: 0.67, z: 2.12, sink: 0.018, t: [1.66, -0.86, -0.18], hex: 0xe8b6c0 },
  { kind: 'mouse', x: 0.50, z: 2.47, sink: 0.016, t: [1.38, 2.70, 0.42], hex: 0xc2c4bd },
  { kind: 'mouse', x: 0.36, z: 2.42, sink: 0.017, t: [1.55, -0.55, -0.24], hex: 0xd8c8de },
];

export function buildToys(D, matTop) {
  const group = new THREE.Group();
  group.name = 'plush-pile';
  D.add(group);

  // One geometry set per archetype, built lazily and shared by every copy.
  const cache = new Map();
  const geoFor = (kind) => {
    let g = cache.get(kind);
    if (!g) {
      g = ARCHETYPES[kind]();
      // The union of body and accent, so a mouse's tail and a bunny's ears count toward where the
      // toy has to sit. `restY` reads this.
      g.body.computeBoundingBox();
      g.box = g.body.boundingBox.clone();
      if (g.accent) {
        g.accent.computeBoundingBox();
        g.box.union(g.accent.boundingBox);
      }
      cache.set(kind, g);
    }
    return g;
  };

  const eyeMat = D.tint('plastic.matte', 0x17130f, { roughRange: [0.22, 0.44] });

  // ── the eight reachable ones ──────────────────────────────────────────────────────────────
  for (const s of HERO) {
    const set = geoFor(s.kind);
    const g = new THREE.Group();
    g.name = s.id;
    g.add(D.mesh(set.body, D.tint('fabric.plush', s.hex), { name: `${s.id}.body` }));
    if (set.accent) g.add(D.mesh(set.accent, D.tint('fabric.plush', s.acc), { name: `${s.id}.accent` }));
    if (set.eye) g.add(D.mesh(set.eye, eyeMat, { name: `${s.id}.eyes` }));
    g.position.set(s.x, restY(set.box, s.t, matTop, s.sink), s.z);
    g.rotation.set(s.t[0], s.t[1], s.t[2]);
    group.add(g);

    D.prop({
      id: s.id,
      object3d: g,
      kind: 'knockable',
      labelKey: `prop.${s.kind === 'rattleBall' ? 'rattle' : s.kind}`,
      points: s.kind === 'giraffe' ? 110 : 80,
      // A soft toy hitting a padded mat is the quietest destruction in the game. That is the
      // point: the playpen is where a nervous player farms score without waking anybody.
      noise: 0.09,
      mass: s.kind === 'rattleBall' ? 0.06 : 0.11,
      phys: {
        shape: 'ball',
        // Sized so the sphere's underside lands ON the mat rather than inside it: a static prop
        // that is promoted mid-round must not pop when its body appears.
        radius: Math.min(set.radius * 0.70, Math.max(0.018, g.position.y - matTop + 0.012)),
        friction: 0.85,
        restitution: 0.06,
        linearDamping: 0.45,
        angularDamping: 0.85,
      },
    });
  }

  // ── the six that make up the floor of the pile ────────────────────────────────────────────
  const byKind = new Map();
  for (const s of BASE) {
    let list = byKind.get(s.kind);
    if (!list) { list = []; byKind.set(s.kind, list); }
    list.push(s);
  }
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const col = new THREE.Color();
  for (const [kind, list] of byKind) {
    const set = geoFor(kind);
    const slots = [
      { geo: set.body, mat: D.tint('fabric.plush', 0xffffff), tag: 'body' },
      { geo: set.accent, mat: D.tint('fabric.plush', 0xf6ece0), tag: 'accent' },
      { geo: set.eye, mat: eyeMat, tag: 'eyes' },
    ];
    for (const slot of slots) {
      if (!slot.geo) continue;
      const inst = D.instanced(slot.geo, slot.mat, list.length, { name: `plush.${kind}.${slot.tag}` });
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        e.set(s.t[0], s.t[1], s.t[2]);
        q.setFromEuler(e);
        p.set(s.x, restY(set.box, s.t, matTop, s.sink), s.z);
        inst.setMatrixAt(i, m.compose(p, q, one));
        // Per-instance colour: one white material, six differently coloured toys. `setHex` already
        // lands in the renderer's working space, so it must NOT be converted a second time.
        if (slot.tag === 'body') inst.setColorAt(i, col.setHex(s.hex));
      }
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      inst.computeBoundingSphere();
      group.add(inst);
      // One static collider per archetype group is plenty: this is the part of the pile that is
      // meant to stay put and be crawled over.
      if (slot.tag === 'body') D.ctx.physics?.addStatic(inst, { shape: 'box', friction: 0.9, material: 'plush' });
    }
  }

  return { group, count: HERO.length + BASE.length };
}
