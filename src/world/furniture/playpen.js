// FURN · the playpen. 2.80 × 2.60 m, 0.62 m tall, and the object the whole opening shot is
// composed around — the baby starts inside it and the tutorial beat is unzipping the door.
//
// Three things decide whether this reads as a real baby product or as a box with a net on it.
//
//  1. THE PLAN IS ONE PATH. Rails, mesh, posts and door edges are all sampled from a single
//     rounded-rectangle station list carrying an outward normal and an arclength. The mesh is
//     therefore a continuous *sleeve* around that path — no seams at the corners, no four flat
//     quads meeting at a hard 90° — and it is trivially interrupted for the door by dropping the
//     stations whose arclength falls within ±0.55 m of the start (which is the middle of the −Z
//     face, by construction).
//  2. NOTHING IS TAUT AND NOTHING IS STRAIGHT. Every mesh span bows inward 16 mm at mid-panel and
//     droops 4 mm, on a sin(πu)·sin(πv) envelope that goes to zero at the corner posts where the
//     fabric is actually held; the top rail sags 5 mm between posts. A flat stretched quad is the
//     single fastest way to make fabric look like a decal.
//  3. IT IS OFF THE FLOOR. The pen stands on four plastic feet with the bottom rail 22 mm clear,
//     so there is a real shadow gap all the way round instead of a silhouette welded to the floor.
//
// The mesh is genuinely see-through: `fabric.mesh` carries the generator's alphaMap with a small
// alphaTest, so you read the rug and the toys through it. It deliberately does not cast a shadow —
// a 5 mm weave sampled into a 2048 shadow map is a solid grey rectangle, which is worse than none.
//
// The door is a zip-around leaf hinged on its left stile: a padded binding frame with a real mesh
// window, a rolled-and-toggled fabric flap above it, a two-tape zip whose teeth interleave (the
// leaf carries one tape, the pen carries the other) and a chrome slider with a webbing pull. Its
// upper collider is removed the moment the baby unzips it, leaving a 98 mm sill the character
// controller can autostep over. That is the escape.

import * as THREE from 'three';
import {
  chamferBox, softBox, lathe, tubeThrough, bowPanel, projectUV, scaleUV, xform,
  mergeParts, makeNoise3, shadows, clamp, DEG,
} from './geo.js';

const W = 2.80;
const D = 2.60;
const H = 0.62;

const TR = 0.047;                 // padded top-rail tube radius
const BR = 0.040;                 // bottom rail
const CR = 0.200;                 // plan corner radius
const POST_R = 0.053;

const HW = W * 0.5 - TR;          // rail centreline half-extents
const HD = D * 0.5 - TR;
const CX = HW - CR;               // corner arc centres
const CZ = HD - CR;

const RAIL_TOP = H - TR;          // 0.573
const RAIL_BOT = 0.062;
const FOOT_H = 0.024;

const MESH_Y0 = 0.098;
const MESH_Y1 = 0.545;
const MESH_IN = 0.010;            // the sleeve hangs this far inside the rail centreline
const BOW = 0.016;

const DOOR_HALF = 0.55;
const DOOR_W = DOOR_HALF * 2;

// ───────────────────────────────────────────────────────────── the plan path ──

/**
 * Walk the rounded rectangle once, starting at the middle of the −Z face and heading +x.
 * Returns { list, length }; each station is { x, z, nx, nz, s, env } where `env` is 1 at the
 * middle of a straight run and 0 at the corner posts.
 */
function stations(step) {
  const pieces = [
    { line: [[0, -HD], [CX, -HD]], n: [0, -1] },
    { arc: [CX, -CZ], a: [-90, 0] },
    { line: [[HW, -CZ], [HW, CZ]], n: [1, 0] },
    { arc: [CX, CZ], a: [0, 90] },
    { line: [[CX, HD], [-CX, HD]], n: [0, 1] },
    { arc: [-CX, CZ], a: [90, 180] },
    { line: [[-HW, CZ], [-HW, -CZ]], n: [-1, 0] },
    { arc: [-CX, -CZ], a: [180, 270] },
    { line: [[-CX, -HD], [0, -HD]], n: [0, -1] },
  ];
  const envOf = (x, z, isArc) => {
    if (isArc) return 0;
    const u = Math.abs(z) > Math.abs(x) ? (x + CX) / (2 * CX) : (z + CZ) / (2 * CZ);
    return Math.sin(Math.PI * clamp(u, 0, 1));
  };
  const list = [];
  let s = 0;
  for (const p of pieces) {
    if (p.line) {
      const [a, b] = p.line;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.round(len / step));
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const x = a[0] + (b[0] - a[0]) * t;
        const z = a[1] + (b[1] - a[1]) * t;
        list.push({ x, z, nx: p.n[0], nz: p.n[1], s: s + len * t, env: envOf(x, z, false) });
      }
      s += len;
    } else {
      const len = CR * Math.PI * 0.5;
      const n = Math.max(2, Math.round(len / step));
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const ang = (p.a[0] + (p.a[1] - p.a[0]) * t) * DEG;
        const nx = Math.cos(ang);
        const nz = Math.sin(ang);
        list.push({ x: p.arc[0] + nx * CR, z: p.arc[1] + nz * CR, nx, nz, s: s + len * t, env: 0 });
      }
      s += len;
    }
  }
  return { list, length: s };
}

// ─────────────────────────────────────────────────────────────────── pieces ──

/** A padded rail: the plan path lifted to `y`, sagging between the corner posts. */
function railGeo(y, radius, sag, tm, segs) {
  const { list } = stations(0.09);
  const pts = list.map((st) => new THREE.Vector3(st.x, y - sag * st.env, st.z));
  const geo = tubeThrough(pts, radius, {
    radialSegments: segs, closed: true, tubularSegments: 260, tension: 0.5,
  });
  const len = 2 * (2 * CX + 2 * CZ) + 2 * Math.PI * CR;
  return scaleUV(geo, len / tm[0], (2 * Math.PI * radius) / tm[1]);
}

/**
 * The mesh sleeve. One indexed grid following the path from the door's right edge all the way
 * round to its left edge, bowed inward and drooping on a sin·sin envelope.
 */
function sleeveGeo(tm) {
  const { list, length } = stations(0.05);
  // The sleeve runs 14 mm PAST the door opening on each side so its raw edge is tucked behind the
  // door's binding. Two panels that merely abut leave a slot you can see through at a grazing
  // angle, which is the single most common way procedural fabric gives itself away.
  const CUT = DOOR_HALF - 0.014;
  const cols = [{ x: CUT, z: -HD, nx: 0, nz: -1, s: CUT, env: Math.sin(Math.PI * (CUT + CX) / (2 * CX)) }];
  for (const st of list) {
    if (st.s > CUT + 1e-3 && st.s < length - CUT - 1e-3) cols.push(st);
  }
  const endEnv = Math.sin(Math.PI * (-CUT + CX) / (2 * CX));
  cols.push({ x: -CUT, z: -HD, nx: 0, nz: -1, s: length - CUT, env: endEnv });

  const ROWS = 6;
  const n = cols.length;
  const noise = makeNoise3(7717);
  const pos = new Float32Array(n * (ROWS + 1) * 3);
  const uv = new Float32Array(n * (ROWS + 1) * 2);
  let p = 0;
  let q = 0;
  for (let i = 0; i < n; i++) {
    const st = cols[i];
    for (let j = 0; j <= ROWS; j++) {
      const v = j / ROWS;
      const vert = Math.sin(Math.PI * v);
      const slack = st.env * vert;
      const inward = MESH_IN + BOW * slack + noise(st.x * 6, v * 3, st.z * 6) * 0.0009;
      const y = MESH_Y0 + (MESH_Y1 - MESH_Y0) * v - 0.004 * slack;
      pos[p++] = st.x - st.nx * inward;
      pos[p++] = y;
      pos[p++] = st.z - st.nz * inward;
      uv[q++] = st.s / tm[0];
      uv[q++] = y / tm[1];
    }
  }
  const idx = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < ROWS; j++) {
      const a = i * (ROWS + 1) + j;
      const b = a + ROWS + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** The ladderlock every strap is threaded through: five bars, merged. */
function adjusterGeo() {
  const w = 0.026;
  const h = 0.019;
  const t = 0.0035;
  const bar = 0.0035;
  return mergeParts([
    xform(chamferBox(w, bar, t, 0.0008), { pos: [0, h * 0.5 - bar * 0.5, 0] }),
    xform(chamferBox(w, bar, t, 0.0008), { pos: [0, -h * 0.5 + bar * 0.5, 0] }),
    xform(chamferBox(bar, h, t, 0.0008), { pos: [-w * 0.5 + bar * 0.5, 0, 0] }),
    xform(chamferBox(bar, h, t, 0.0008), { pos: [w * 0.5 - bar * 0.5, 0, 0] }),
    xform(chamferBox(bar * 0.8, h - bar * 2, t * 0.8, 0.0006), { pos: [0.0015, 0, 0] }),
  ]);
}

// ───────────────────────────────────────────────────────────────── the build ──

export function buildPlaypen(kit, origin, yaw) {
  const group = new THREE.Group();
  group.name = 'playpen';
  group.position.set(origin[0], origin[1], origin[2]);
  group.rotation.y = yaw;

  const tmTrim = kit.tm('fabric.playpenTrim');
  const tmMesh = kit.tm('fabric.mesh');
  const trim = kit.unit('fabric.playpenTrim');
  const binding = kit.tint('fabric.playpenTrim', 0xb2916a, { uvRepeat: [1, 1] });
  const meshMat = kit.unit('fabric.mesh');
  const webbing = kit.tint('fabric.playpenTrim', 0x54803c, { uvRepeat: [1, 1], roughRange: [0.50, 0.80] });
  const dark = kit.mat('plastic.matte');
  const chrome = kit.unit('metal.chrome');
  const uvTrim = { def: [tmTrim[0], tmTrim[1], false] };

  const detailed = kit.atLeast('high');

  // --- rails ---------------------------------------------------------------------------
  const topRail = kit.mesh(railGeo(RAIL_TOP, TR, 0.005, tmTrim, detailed ? 10 : 7), trim, 'playpen.rail.top');
  const botRail = kit.mesh(railGeo(RAIL_BOT, BR, 0.002, tmTrim, detailed ? 8 : 6), trim, 'playpen.rail.bottom');
  group.add(topRail, botRail);

  // --- corner posts, feet ---------------------------------------------------------------
  const postProfile = [
    [0.000, FOOT_H],
    [POST_R * 0.86, FOOT_H + 0.004],
    [POST_R * 0.97, FOOT_H + 0.03],
    [POST_R, 0.30],
    [POST_R * 0.98, RAIL_TOP - 0.06],
    [POST_R * 0.88, RAIL_TOP + 0.012],
    [POST_R * 0.52, RAIL_TOP + 0.040],
    [0.000, RAIL_TOP + 0.046],
  ];
  const footProfile = [
    [0.000, 0.000],
    [0.050, 0.000],
    [0.054, 0.006],
    [0.050, 0.019],
    [0.040, FOOT_H],
    [0.000, FOOT_H],
  ];
  const posts = [];
  const feet = [];
  const k = Math.SQRT1_2 * CR;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = sx * (CX + k);
      const pz = sz * (CZ + k);
      posts.push(xform(lathe(postProfile, detailed ? 20 : 12, tmTrim[0], tmTrim[1]), {
        pos: [px, 0, pz], rot: [0, kit.rand(0, 6.28), 0],
      }));
      feet.push(xform(lathe(footProfile, 14, 0.2, 0.2), { pos: [px, 0, pz] }));
    }
  }
  group.add(kit.mesh(mergeParts(posts), trim, 'playpen.posts'));
  group.add(kit.mesh(mergeParts(feet), dark, 'playpen.feet'));

  // --- mid struts on the three closed faces ---------------------------------------------
  const strutProfile = [
    [0.000, RAIL_BOT - 0.01],
    [0.028, RAIL_BOT - 0.006],
    [0.031, RAIL_BOT + 0.06],
    [0.030, RAIL_TOP - 0.06],
    [0.027, RAIL_TOP + 0.006],
    [0.000, RAIL_TOP + 0.012],
  ];
  const struts = [
    [0, HD - MESH_IN * 0.5],
    [HW - MESH_IN * 0.5, 0],
    [-(HW - MESH_IN * 0.5), 0],
  ].map(([x, z]) => xform(lathe(strutProfile, detailed ? 14 : 10, tmTrim[0], tmTrim[1]), {
    pos: [x, 0, z], rot: [0, kit.rand(0, 6.28), 0],
  }));
  group.add(kit.mesh(mergeParts(struts), trim, 'playpen.struts'));

  // --- the mesh sleeve ------------------------------------------------------------------
  const sleeve = kit.mesh(sleeveGeo(tmMesh), meshMat, 'playpen.mesh', { cast: false, receive: true });
  sleeve.renderOrder = 1;
  group.add(sleeve);

  // --- webbing tabs + plastic adjusters on the rails -------------------------------------
  const adjGeo = adjusterGeo();
  const tabs = [];
  const adjusters = [];
  const TAB_AT = [
    { x: HW, z: -0.42, nx: 1, nz: 0 },
    { x: -HW, z: 0.55, nx: -1, nz: 0 },
    { x: 0.62, z: HD, nx: 0, nz: 1 },
  ];
  for (let i = 0; i < TAB_AT.length; i++) {
    const t = TAB_AT[i];
    const ang = Math.atan2(t.nx, t.nz);
    // A doubled strap over the rail: a short arc across the crown, then a tail hanging outside.
    const arc = [];
    for (let a = 0; a <= 8; a++) {
      const th = Math.PI * (0.12 + (a / 8) * 0.76);
      arc.push(new THREE.Vector3(
        t.x + t.nx * Math.cos(th) * (TR + 0.004),
        RAIL_TOP + Math.sin(th) * (TR + 0.004),
        t.z + t.nz * Math.cos(th) * (TR + 0.004),
      ));
    }
    tabs.push(scaleUV(tubeThrough(arc, 0.0035, { radialSegments: 4 }), 0.6, 0.1));

    const tail = softBox(0.021, 0.082, 0.0038, { radius: 0.0012, segments: 2, lean: 0.006, seed: 90 + i });
    projectUV(tail, uvTrim);
    tabs.push(xform(tail, {
      pos: [t.x + t.nx * (TR + 0.004), RAIL_TOP - 0.048, t.z + t.nz * (TR + 0.004)],
      rot: [0, ang, kit.jit(5) * DEG],
    }));
    adjusters.push(xform(adjGeo.clone(), {
      pos: [t.x + t.nx * (TR + 0.008), RAIL_TOP - 0.072, t.z + t.nz * (TR + 0.008)],
      rot: [0, ang, kit.jit(4) * DEG],
    }));
  }
  adjGeo.dispose();
  group.add(kit.mesh(mergeParts(tabs), webbing, 'playpen.webbing'));
  group.add(kit.mesh(mergeParts(adjusters), dark, 'playpen.adjusters'));

  // ─────────────────────────────────────────────────────────────────── the door ──
  // Leaf-local: x runs 0 → 1.10 from the hinge stile, y is world-height, −z is out of the pen.
  const leaf = new THREE.Group();
  leaf.name = 'playpen.door';
  leaf.position.set(-DOOR_HALF, 0, -HD);
  group.add(leaf);

  const Y0 = MESH_Y0;
  const Y1 = MESH_Y1;
  const bandBottom = 0.225;
  const bandTop = 0.455;
  const stile = 0.19;

  const panels = [];
  const pad = (w, h, t, cx, cy, seed) => {
    const g = softBox(w, h, t, {
      radius: Math.min(0.008, t * 0.45), segments: 3, bulge: 0.004, bulgeAt: 0.5,
      wrinkle: 0.0011, wrinkleScale: 12, seed,
    });
    projectUV(g, uvTrim);
    return xform(g, { pos: [cx, cy, -t * 0.5 + 0.002] });
  };
  panels.push(pad(DOOR_W, bandBottom - Y0, 0.017, DOOR_HALF, (Y0 + bandBottom) * 0.5, 611));
  panels.push(pad(DOOR_W, Y1 - bandTop, 0.016, DOOR_HALF, (bandTop + Y1) * 0.5, 613));
  panels.push(pad(stile, bandTop - bandBottom, 0.015, stile * 0.5, (bandBottom + bandTop) * 0.5, 617));
  panels.push(pad(stile, bandTop - bandBottom, 0.015, DOOR_W - stile * 0.5, (bandBottom + bandTop) * 0.5, 619));
  leaf.add(kit.mesh(mergeParts(panels), binding, 'playpen.door.binding'));

  // 20 mm oversize on both axes: the mesh tucks behind the binding instead of meeting it edge to
  // edge, which would leave a visible slot at any grazing angle.
  const winW = DOOR_W - stile * 2 + 0.020;
  const winH = bandTop - bandBottom + 0.020;
  const win = bowPanel(winW, winH, { segX: 14, segY: 6, bow: 0.009, sag: 0.0035, ripple: 0.0012, seed: 77 });
  scaleUV(win, winW / tmMesh[0], winH / tmMesh[1]);
  const winMesh = kit.mesh(win, meshMat, 'playpen.door.window', { cast: false, receive: true });
  // bowPanel displaces toward −z, which on this face is out of the pen: the window bulges the way
  // a door panel under a toddler's weight actually does.
  winMesh.position.set(DOOR_HALF, (bandBottom + bandTop) * 0.5, 0.005);
  winMesh.renderOrder = 1;
  leaf.add(winMesh);

  // The rolled-up flap, toggled to the head of the door with two green straps.
  const rollR = 0.034;
  const rollY = bandTop + 0.012;
  const rollZ = -0.052;
  const rollGeo = lathe([
    [0.000, -0.450],
    [rollR * 0.72, -0.452],
    [rollR, -0.436],
    [rollR, 0.436],
    [rollR * 0.72, 0.452],
    [0.000, 0.450],
  ], detailed ? 18 : 12, tmTrim[0], tmTrim[1]);
  rollGeo.rotateZ(Math.PI * 0.5);
  const rollParts = [xform(rollGeo, { pos: [DOOR_HALF, rollY, rollZ] })];
  // The spiral you read on the ends of the roll — one and a half turns of the rolled cloth, and
  // the only cue that tells you the cylinder is fabric rather than a pipe.
  for (const ex of [-0.451, 0.451]) {
    const spiral = [];
    for (let i = 0; i <= 26; i++) {
      const a = (i / 26) * Math.PI * 3.1;
      const r = rollR * 0.30 + (rollR * 0.68) * (i / 26);
      spiral.push(new THREE.Vector3(DOOR_HALF + ex, rollY + Math.sin(a) * r, rollZ + Math.cos(a) * r));
    }
    rollParts.push(scaleUV(tubeThrough(spiral, 0.0022, { radialSegments: 4 }), 0.4, 0.1));
  }
  leaf.add(kit.mesh(mergeParts(rollParts), binding, 'playpen.door.flapRoll'));

  const straps = [];
  for (const sx of [DOOR_HALF - 0.30, DOOR_HALF + 0.30]) {
    const loop = [];
    for (let a = 0; a <= 14; a++) {
      const th = -Math.PI * 0.35 + (a / 14) * Math.PI * 1.7;
      loop.push(new THREE.Vector3(sx, rollY + Math.sin(th) * (rollR + 0.004), rollZ + Math.cos(th) * (rollR + 0.004)));
    }
    straps.push(scaleUV(tubeThrough(loop, 0.0034, { radialSegments: 4 }), 0.5, 0.1));
  }
  leaf.add(kit.mesh(mergeParts(straps), webbing, 'playpen.door.toggles'));

  // --- the zip -------------------------------------------------------------------------
  // An L: up the free stile, round the head corner, across the top. The leaf carries one tape,
  // the pen carries the other, and at rest their teeth interleave along the same line.
  const ZIP_Z = -0.014;
  const zipPath = [];
  {
    const x1 = DOOR_W - 0.016;
    const yTop = Y1 - 0.016;
    const rr = 0.05;
    for (let i = 0; i <= 8; i++) zipPath.push(new THREE.Vector2(x1, Y0 + 0.018 + (yTop - rr - Y0 - 0.018) * (i / 8)));
    for (let i = 1; i <= 6; i++) {
      const a = (i / 6) * Math.PI * 0.5;
      zipPath.push(new THREE.Vector2(x1 - rr + Math.cos(a) * rr, yTop - rr + Math.sin(a) * rr));
    }
    for (let i = 1; i <= 12; i++) zipPath.push(new THREE.Vector2(x1 - rr - ((x1 - rr - 0.022) * i) / 12, yTop));
  }
  const zipLen = [];
  {
    let acc = 0;
    zipLen.push(0);
    for (let i = 1; i < zipPath.length; i++) {
      acc += zipPath[i].distanceTo(zipPath[i - 1]);
      zipLen.push(acc);
    }
  }
  const zipTotal = zipLen[zipLen.length - 1];

  /** Offset the zip polyline sideways (+1 = away from the door's interior). */
  function zipSide(off) {
    return zipPath.map((p, i) => {
      const a = zipPath[Math.max(0, i - 1)];
      const b = zipPath[Math.min(zipPath.length - 1, i + 1)];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      return new THREE.Vector3(p.x + (dy / l) * off, p.y - (dx / l) * off, ZIP_Z);
    });
  }

  const tapeLeaf = scaleUV(tubeThrough(zipSide(-0.0055), 0.0028, { radialSegments: 4 }), 0.4, 0.1);
  const tapePen = scaleUV(tubeThrough(zipSide(0.0055), 0.0028, { radialSegments: 4 }), 0.4, 0.1);

  const teeth = { leaf: [], pen: [] };
  if (detailed) {
    const toothGeo = new THREE.BoxGeometry(0.0030, 0.0016, 0.0024);
    const pitch = 0.0068;
    const count = Math.floor(zipTotal / pitch);
    for (let i = 0; i < count; i++) {
      const s = 0.004 + i * pitch;
      let k2 = 1;
      while (k2 < zipLen.length && zipLen[k2] < s) k2++;
      const t = (s - zipLen[k2 - 1]) / Math.max(1e-6, zipLen[k2] - zipLen[k2 - 1]);
      const a = zipPath[k2 - 1];
      const b = zipPath[Math.min(k2, zipPath.length - 1)];
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const side = i % 2 === 0 ? teeth.leaf : teeth.pen;
      const off = i % 2 === 0 ? -0.0022 : 0.0022;
      side.push(xform(toothGeo.clone(), {
        pos: [px + Math.sin(ang) * off, py - Math.cos(ang) * off, ZIP_Z],
        rot: [0, 0, ang],
      }));
    }
    toothGeo.dispose();
  }

  leaf.add(kit.mesh(mergeParts([tapeLeaf, ...teeth.leaf]), dark, 'playpen.door.zipLeaf'));
  const zipPen = kit.mesh(mergeParts([tapePen, ...teeth.pen]), dark, 'playpen.door.zipPen');
  zipPen.position.set(-DOOR_HALF, 0, -HD);
  group.add(zipPen);

  // The slider, with a webbing pull. Parked at the foot of the stile until somebody yanks it.
  const slider = new THREE.Group();
  slider.name = 'playpen.door.slider';
  const body = chamferBox(0.011, 0.026, 0.009, 0.0022, 2);
  scaleUV(body, 3, 3);
  slider.add(kit.mesh(body, chrome, 'playpen.door.slider.body'));
  const pullPts = [];
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * Math.PI;
    pullPts.push(new THREE.Vector3(Math.sin(a) * 0.007, -0.016 - i * 0.0022, -Math.cos(a) * 0.0025));
  }
  slider.add(kit.mesh(
    scaleUV(tubeThrough(pullPts, 0.0022, { radialSegments: 4 }), 0.4, 0.1), webbing, 'playpen.door.slider.pull',
  ));
  const tag = softBox(0.014, 0.026, 0.0035, { radius: 0.0016, segments: 2, seed: 401 });
  projectUV(tag, uvTrim);
  const tagMesh = kit.mesh(tag, binding, 'playpen.door.slider.tag');
  tagMesh.position.set(0, -0.052, -0.002);
  tagMesh.rotation.z = 7 * DEG;
  slider.add(tagMesh);
  slider.position.set(zipPath[0].x, zipPath[0].y, ZIP_Z - 0.004);
  leaf.add(slider);

  // --- the teether ring on the −x rail ---------------------------------------------------
  const ring = new THREE.Group();
  ring.name = 'playpen.teether';
  const ringGeo = new THREE.TorusGeometry(0.045, 0.0085, detailed ? 10 : 6, detailed ? 28 : 16);
  scaleUV(ringGeo, 3.5, 0.6);
  const ringMesh = kit.mesh(ringGeo, kit.mat('silicone'), 'playpen.teether.ring');
  ringMesh.rotation.y = 18 * DEG;
  ring.add(ringMesh);
  const hookStrap = softBox(0.018, 0.090, 0.004, { radius: 0.0015, segments: 2, wrinkle: 0.0008, seed: 431 });
  projectUV(hookStrap, uvTrim);
  const hookMesh = kit.mesh(hookStrap, webbing, 'playpen.teether.strap');
  hookMesh.position.set(0, 0.045 + 0.045, 0);
  hookMesh.rotation.y = 18 * DEG;
  ring.add(hookMesh);
  const hook = new THREE.Object3D();
  hook.name = 'playpen.teether.anchor';
  hook.position.set(0, 0.135, 0);
  ring.add(hook);

  // Where that ring hangs from, in playpen-local coordinates.
  const teetherAnchor = new THREE.Vector3(-HW, RAIL_TOP, 0.28);

  shadows(group, true, true);
  sleeve.castShadow = false;
  winMesh.castShadow = false;

  // --- colliders -------------------------------------------------------------------------
  const HB = W * 0.5 - 0.05;
  const DB = D * 0.5 - 0.05;
  kit.box(group, 'playpen.wall.px', [HB, H * 0.5, 0], [0.10, H, D - 0.10], { material: 'fabric', friction: 0.7 });
  kit.box(group, 'playpen.wall.nx', [-HB, H * 0.5, 0], [0.10, H, D - 0.10], { material: 'fabric', friction: 0.7 });
  kit.box(group, 'playpen.wall.pz', [0, H * 0.5, DB], [W - 0.10, H, 0.10], { material: 'fabric', friction: 0.7 });
  for (const sx of [-1, 1]) {
    kit.box(group, `playpen.wall.nz${sx > 0 ? 'R' : 'L'}`,
      [sx * (W * 0.5 + DOOR_HALF) * 0.5, H * 0.5, -DB],
      [W * 0.5 - DOOR_HALF, H, 0.10], { material: 'fabric', friction: 0.7 });
  }
  // The sill stays for ever — 98 mm, which the character controller autosteps.
  kit.box(group, 'playpen.sill', [0, MESH_Y0 * 0.5, -DB], [DOOR_W, MESH_Y0, 0.10], { material: 'fabric' });

  // GAME resolves an interaction target by walking UP from whatever collider it hit, and it scores
  // by the prop's own world position — so the door's prop anchor is an empty at the centre of the
  // panel with the collider parented under it, not the leaf group (whose origin is the hinge, half
  // a metre away and outside the 0.72 m proximity query).
  const panel = new THREE.Object3D();
  panel.name = 'playpen.doorPanel';
  panel.position.set(DOOR_HALF, (MESH_Y0 + Y1) * 0.5, -0.012);
  leaf.add(panel);
  // Deleted the instant the door is unzipped; the sill below it is what stays.
  const doorCollider = kit.box(panel, 'playpen.door.collider',
    [0, (MESH_Y0 + H) * 0.5 - panel.position.y, -DB + HD - panel.position.z],
    [DOOR_W, H - MESH_Y0, 0.10], { material: 'fabric', friction: 0.7 });

  return {
    group,
    leaf,
    panel,
    slider,
    ring,
    hook,
    teetherAnchor,
    doorCollider,
    zipPath,
    zipLen,
    zipTotal,
    /** Where the door's free stile ends up: used to size the swing. */
    hinge: new THREE.Vector3(-DOOR_HALF, 0, -HD),
  };
}
