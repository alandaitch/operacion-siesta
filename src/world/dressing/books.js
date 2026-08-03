// OPERATION NAPTIME — module DRESS — forty-five books.
//
// A book is a swept cross-section: fore-edge, front cover, a half-round spine, back cover. Two
// material groups come out of one geometry — the cover shell carries a column of the printed-spine
// ATLAS (`materials.atlas('card.print').uvFor(i)`), the page block carries `paper.page` — so a
// shelf of books with eight different stock colours costs eight materials, not forty-five.
//
// The population is deliberately split:
//  · 31 books on the upper decks are InstancedMeshes grouped by atlas column (one draw per column
//    per material group). They are scenery: the baby cannot reach 0.40 m up anyway.
//  · 14 books on the bottom decks — the ones a crawling baby's face is level with — are individual
//    meshes registered as props, each with its own lean, warp and wear.
//  · One flat stack on top of the mid-run unit is caught mid-collapse: three of its five volumes
//    have slid off the pile and are hanging over the edge.
//
// Nothing here is axis-aligned. Every standing book gets a lean of up to 9°, a yaw of up to 3°,
// and a warp that moves its head 2–4 mm off plumb, because a shelf of perfectly parallel spines is
// the single most obvious tell of a procedural room.

import * as THREE from 'three';
import { sweep, clamp, noise2 } from './util.js';
import { SHELF } from './shelf.js';

const SPINE_COLUMNS = 8;

/**
 * The cross-section of a book, looking down: spine (rounded) at -z, fore-edge at +z, covers on
 * ±x. `group` selects the material of the face leaving each point — 0 is the printed cover, 1 the
 * paper block.
 */
function bookSection(t, d, arcSegs = 6) {
  const r = t * 0.5;
  const pts = [];
  pts.push({ x: t * 0.5, z: d * 0.5, u: 0.995, group: 0 });
  pts.push({ x: t * 0.5, z: -d * 0.5 + r, u: 0.94, group: 0 });
  for (let i = 1; i < arcSegs; i++) {
    const a = (i / arcSegs) * Math.PI;
    pts.push({
      x: Math.cos(a) * r,
      z: -d * 0.5 + r - Math.sin(a) * r,
      u: 0.94 - (i / arcSegs) * 0.88,
      group: 0,
    });
  }
  pts.push({ x: -t * 0.5, z: -d * 0.5 + r, u: 0.06, group: 0 });
  pts.push({ x: -t * 0.5, z: d * 0.5, u: 0.005, group: 1 });
  return pts;
}

/** One book. Origin at the centre of its foot, spine toward -z, height up +y. */
export function bookGeometry({ t = 0.032, h = 0.22, d = 0.15, warp = 0.002, arcSegs = 6 }) {
  return sweep({
    section: bookSection(t, d, arcSegs),
    height: h,
    rows: 3,
    groups: 2,
    capGroup: 1,
    vScale: 0.2,
    profile: (y) => ({
      // Boards bow outward at the head and the block pinches at the fore-edge: a real book is
      // never a prism.
      sx: 1 + Math.sin(y * Math.PI) * 0.03,
      sz: 1 - y * 0.012,
      dx: warp * y * y,
      dz: 0,
    }),
  });
}

/** A dust jacket: an open strip wrapped round the covers, 0.6 mm proud, torn along the head. */
function jacketGeometry({ t, h, d, tear, rng }) {
  const path = bookSection(t + 0.0012, d + 0.001, 6);
  // Drop the fore-edge face; a jacket is open at the fore-edge (its flaps tuck inside).
  const strip = path.slice(0, path.length);
  const rows = 5;
  const cols = strip.length;
  const verts = [];
  const uvs = [];
  const idx = [];
  const top = (i) => {
    const u = i / (cols - 1);
    const n = noise2(u * 6, 0.5, 1, 909, 3);
    const torn = tear ? clamp(1 - Math.max(0, (u - 0.62)) * 2.4 * (0.5 + n), 0.55, 1) : 1;
    return (0.965 + n * 0.02) * torn;
  };
  for (let r = 0; r <= rows; r++) {
    const ty = r / rows;
    for (let i = 0; i < cols; i++) {
      const s = strip[i];
      const jitter = (noise2(i * 0.8, r * 0.9, 1, 313, 2) - 0.5) * 0.0006;
      verts.push(s.x * (1 + jitter * 8), h * ty * top(i) + h * 0.012, s.z * (1 + jitter * 8));
      uvs.push(s.u, ty * 0.96 + 0.02);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = r * cols + i;
      const b = (r + 1) * cols + i;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  // A triangular flap peeled away from the head of the front cover.
  if (tear) {
    const base = verts.length / 3;
    const fx = t * 0.5 + 0.0012;
    const fz = d * 0.28;
    const lift = 0.012 + rng() * 0.01;
    verts.push(fx, h * 0.93, fz, fx, h * 0.93, fz - 0.035, fx + lift * 0.8, h * 0.99 + lift, fz - 0.012);
    uvs.push(0.97, 0.93, 0.97, 0.99, 0.9, 0.99);
    idx.push(base, base + 1, base + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Cover material for atlas column `c`, optionally re-tinted. */
function spineMat(D, c, hex = 0xffffff, extra = null) {
  const atlas = D.ctx.materials.atlas('card.print');
  const uv = atlas ? atlas.uvFor(c) : { offset: [0, 0], repeat: [1, 1] };
  return D.tint('card.print', hex, { uvOffset: uv.offset, uvRepeat: uv.repeat, ...(extra || {}) });
}

/**
 * Fill a run of shelf with standing books, leaning against each other. Returns the list of
 * placements; the caller decides whether they become instances or individual props.
 */
function layOutStanding({ rng, deckY, z0, z1, count, maxH, minH = 0.145 }) {
  const span = z1 - z0;
  const out = [];
  // Thicknesses first, so the row fills its bay without overflowing it.
  const ts = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const t = 0.016 + rng() ** 1.7 * 0.045;
    ts.push(t);
    total += t;
  }
  const gapTotal = Math.max(0.004, span - total - 0.02);
  const lead = z0 + 0.012;
  let z = lead;
  // Leaning happens in clusters: a group of three or four books leans into the gap left by the
  // one that was taken out, and the next group stands up again.
  let leanDir = rng() > 0.5 ? 1 : -1;
  let leanRun = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < count; i++) {
    const t = ts[i];
    const h = clamp(minH + rng() ** 1.4 * (maxH - minH), minH, maxH);
    const d = 0.108 + rng() * 0.055;
    if (leanRun-- <= 0) {
      leanRun = 2 + Math.floor(rng() * 4);
      leanDir = rng() > 0.62 ? -leanDir : leanDir;
    }
    const upright = rng() > 0.55;
    const lean = upright ? (rng() - 0.5) * 0.03 : leanDir * (0.035 + rng() * 0.115);
    out.push({
      z: z + t * 0.5,
      t,
      h,
      d,
      lean,
      yaw: (rng() - 0.5) * 0.055,
      warp: (rng() - 0.5) * 0.005,
      // Spines sit a couple of centimetres behind the ply edge, each at its own depth.
      x: SHELF.front - 0.018 - d * 0.5 - rng() * 0.032,
      y: deckY,
      col: Math.floor(rng() * SPINE_COLUMNS),
    });
    z += t + gapTotal / count * (0.4 + rng() * 1.2);
    if (z > z1 - 0.03) z = z1 - 0.03;
  }
  return out;
}

/**
 * Books lying flat in a pile, each offset and rotated from the one below. Coordinates are LOCAL:
 * x is measured back from the shelf's front edge and z is centred on the pile, so the caller only
 * has to place the pile's origin at (SHELF.front, deck, bayCentre).
 */
function layOutStack({ rng, baseY = 0, count, slip = 0 }) {
  const out = [];
  let y = baseY;
  for (let i = 0; i < count; i++) {
    const t = 0.021 + rng() * 0.026;
    const h = 0.19 + rng() * 0.055; // the long side; runs along z once laid down
    const d = 0.125 + rng() * 0.045;
    // `slip` is the mid-collapse: each volume up the pile has slid further off the one below.
    const slide = slip > 0 ? (i / Math.max(1, count - 1)) ** 2.2 * slip : 0;
    out.push({
      x: -0.02 - d * 0.5 + (rng() - 0.5) * 0.012 + slide * 0.35,
      y: y + t * 0.5,
      z: -h * 0.5 + (rng() - 0.5) * 0.018 + slide,
      t,
      h,
      d,
      yaw: (rng() - 0.5) * 0.22 + slide * 1.4,
      roll: slide > 0.02 ? slide * 0.55 : 0,
      col: Math.floor(rng() * SPINE_COLUMNS),
    });
    y += t;
  }
  return out;
}

/**
 * Build every book on the shelving.
 * @returns {{ group: THREE.Group }}
 */
export function buildBooks(D) {
  const rng = D.stream('books');
  const group = new THREE.Group();
  group.name = 'books';
  D.add(group);

  const pageMat = D.mat('paper.page');
  const arcSegs = D.lod(3, 4, 6, 7);

  // ── instanced scenery books ───────────────────────────────────────────────────────────────
  // One shared unit geometry, per-instance non-uniform scale, grouped by atlas column so each
  // column is a single pair of draws.
  const UNIT = { t: 0.032, h: 0.22, d: 0.15 };
  const unitGeo = bookGeometry({ ...UNIT, warp: 0, arcSegs });
  const buckets = [];
  for (let c = 0; c < SPINE_COLUMNS; c++) buckets.push([]);

  // Which cube gets which row is not arbitrary: the two 0.78 m units at the window end carry the
  // dense rows (they are furthest from the camera and read as mass), the 0.60 m units carry the
  // tall art books, and the low 0.42 m cubes at the near end are left for the hero books below,
  // because those are the ones a crawling face is level with.
  const B = SHELF.bays;
  const scenery = [
    ...layOutStanding({ rng, deckY: B[0].mid, z0: B[0].iz0, z1: B[0].iz1, count: 6, maxH: 0.30 }),
    ...layOutStanding({ rng, deckY: B[1].deck, z0: B[1].iz0, z1: B[1].iz1, count: 7, maxH: 0.31 }),
    ...layOutStanding({ rng, deckY: B[1].mid, z0: B[1].iz0, z1: B[1].iz1 - 0.16, count: 5, maxH: 0.26 }),
    ...layOutStanding({ rng, deckY: B[2].deck, z0: B[2].iz0, z1: B[2].iz1, count: 6, maxH: 0.34 }),
    ...layOutStanding({ rng, deckY: B[0].deck, z0: B[0].iz0 + 0.20, z1: B[0].iz1, count: 5, maxH: 0.30 }),
  ];
  const flat = [
    ...layOutStack({ rng, baseY: B[1].mid, count: 3 }).map((b) => ({ ...b, z: b.z + B[1].iz1 - 0.16 })),
    ...layOutStack({ rng, baseY: B[7].mid, count: 2 }).map((b) => ({ ...b, z: b.z + B[7].zc + 0.10 })),
  ].map((b) => ({ ...b, x: b.x + SHELF.front }));

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();

  for (const b of scenery) {
    e.set(b.lean, -Math.PI / 2 + b.yaw, 0);
    q.setFromEuler(e);
    pos.set(b.x, b.y, b.z);
    scl.set(b.t / UNIT.t, b.h / UNIT.h, b.d / UNIT.d);
    buckets[b.col].push(m.clone().compose(pos, q, scl));
  }
  for (const b of flat) {
    // Laid flat: the spine points -x (into the shelf) and the covers face up.
    e.set(Math.PI / 2, b.yaw - Math.PI / 2, b.roll || 0);
    q.setFromEuler(e);
    pos.set(b.x, b.y, b.z);
    scl.set(b.t / UNIT.t, b.h / UNIT.h, b.d / UNIT.d);
    buckets[b.col].push(m.clone().compose(pos, q, scl));
  }

  let instancedCount = 0;
  let usedUnit = false;
  for (let c = 0; c < SPINE_COLUMNS; c++) {
    const list = buckets[c];
    if (!list.length) continue;
    usedUnit = true;
    // Every column shares one geometry — an InstancedMesh never mutates it.
    const inst = D.instanced(unitGeo, [spineMat(D, c), pageMat], list.length, { name: `books.col${c}` });
    for (let i = 0; i < list.length; i++) inst.setMatrixAt(i, list[i]);
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    group.add(inst);
    instancedCount += list.length;
    // One static box per row so the shelf reads as solid when the baby headbutts it.
    D.ctx.physics?.addStatic(inst, { shape: 'box', friction: 0.85 });
  }
  if (!usedUnit) unitGeo.dispose();

  // ── hero books: individual, reachable, registered ─────────────────────────────────────────
  const hero = [
    ...layOutStanding({ rng, deckY: B[3].deck, z0: B[3].iz0, z1: B[3].iz1, count: 5, maxH: 0.29 }),
    ...layOutStanding({ rng, deckY: B[6].deck, z0: B[6].iz0, z1: B[6].iz1, count: 4, maxH: 0.26 }),
    ...layOutStanding({ rng, deckY: B[4].deck, z0: B[4].iz0, z1: B[4].iz0 + 0.30, count: 3, maxH: 0.26 }),
  ];
  const jacketed = new Set([1, 6]);
  hero.forEach((b, i) => {
    const g = new THREE.Group();
    g.position.set(b.x, b.y, b.z);
    g.rotation.set(b.lean, -Math.PI / 2 + b.yaw, 0);
    const tint = 0xf0e8dc - Math.floor(rng() * 0x101010);
    const geo = bookGeometry({ t: b.t, h: b.h, d: b.d, warp: b.warp, arcSegs });
    const mesh = D.mesh(geo, [spineMat(D, b.col, tint), pageMat], { name: `book.${i}` });
    g.add(mesh);
    if (jacketed.has(i)) {
      const jgeo = jacketGeometry({ t: b.t, h: b.h, d: b.d, tear: true, rng });
      const jmesh = D.mesh(jgeo, spineMat(D, (b.col + 3) % SPINE_COLUMNS, 0xffffff, {
        side: THREE.DoubleSide,
      }), { name: `book.${i}.jacket` });
      g.add(jmesh);
    }
    group.add(g);
    D.prop({
      id: `book-${i + 1}`,
      object3d: g,
      kind: 'knockable',
      labelKey: 'prop.book',
      points: 40,
      noise: 0.22 + b.h * 0.4,
      mass: 0.28 + b.t * 8 + b.h * 0.5,
      phys: { shape: 'box', friction: 0.6, restitution: 0.06, angularDamping: 0.7 },
    });
  });

  // ── the collapsing stack, on top of the mid-run unit ──────────────────────────────────────
  const stackGroup = new THREE.Group();
  stackGroup.name = 'book-stack';
  const stack = layOutStack({ rng, baseY: 0, count: 5, slip: 0.085 });
  stack.forEach((b, i) => {
    const geo = bookGeometry({ t: b.t, h: b.h, d: b.d, warp: 0.001, arcSegs });
    const mesh = D.mesh(geo, [spineMat(D, b.col, 0xf2ece0), pageMat], { name: `stackbook.${i}` });
    mesh.position.set(b.x, b.y, b.z);
    mesh.rotation.set(Math.PI / 2, b.yaw - Math.PI / 2, b.roll);
    stackGroup.add(mesh);
  });
  // Deliberately near the end of the unit: with `slip` at 85 mm the top two volumes hang out over
  // the 18 mm gap between carcasses, which is what "mid-collapse" has to look like from below.
  stackGroup.position.set(SHELF.front, B[2].top, B[2].z0 + 0.56);
  stackGroup.rotation.y = 0.14;
  group.add(stackGroup);
  D.prop({
    id: 'book-stack',
    object3d: stackGroup,
    kind: 'knockable',
    labelKey: 'prop.bookStack',
    points: 110,
    noise: 0.5,
    mass: 2.1,
    phys: { shape: 'box', friction: 0.5, restitution: 0.05, angularDamping: 0.6 },
  });

  // ── magazines: a leaning stack that has slid sideways in its cube ─────────────────────────
  const magGroup = new THREE.Group();
  magGroup.name = 'magazines';
  const magMat = D.mat('paper.magazine');
  for (let i = 0; i < 7; i++) {
    const w = 0.205 + rng() * 0.012;
    const hgt = 0.268 + rng() * 0.012;
    const geo = new THREE.BoxGeometry(w, 0.0035 + rng() * 0.002, hgt, 1, 1, 1);
    const mesh = D.mesh(geo, magMat, { name: `magazine.${i}` });
    const t = i / 6;
    mesh.position.set((rng() - 0.5) * 0.012, 0.0028 + i * 0.0055, t * 0.055 + (rng() - 0.5) * 0.01);
    mesh.rotation.set(-t * 0.13, (rng() - 0.5) * 0.14, 0);
    magGroup.add(mesh);
  }
  // In the bottom cube of the detached near-end unit, directly under the espresso machine.
  magGroup.position.set(SHELF.front - 0.125, B[7].deck, B[7].z0 + 0.30);
  magGroup.rotation.y = -0.08;
  group.add(magGroup);
  D.prop({
    id: 'magazines',
    object3d: magGroup,
    kind: 'knockable',
    labelKey: 'prop.magazines',
    points: 60,
    noise: 0.3,
    mass: 1.15,
    phys: { shape: 'box', friction: 0.55, restitution: 0.04 },
  });

  return { group, instancedCount, heroCount: hero.length };
}
