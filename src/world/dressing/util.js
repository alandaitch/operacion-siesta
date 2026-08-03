// OPERATION NAPTIME — module DRESS — the set dresser's toolkit.
//
// Everything in this folder is built from five primitives, because five well-made primitives
// dress a whole room and forty bespoke ones do not:
//
//  1. `pillow()` — a closed 2D outline swept into a rounded slab with a per-vertex displacement
//     hook. It is the play mat, the cushion, the crisp packet, the ukulele body and the board
//     book, and it is the reason none of those objects has a hard 90° edge.
//  2. `sweep()` — a cross-section swept along +Y with per-row scale/offset and *per-face UV
//     groups*, so a book can carry the printed-spine atlas on its spine and paper on its page
//     block from one geometry with two material groups.
//  3. `lathe()` — a radial profile with angular + vertical noise perturbation, which is how the
//     white vase gets its knobbly ridges (a smooth cylinder of revolution is an instant fail).
//  4. `deform()` — walk a geometry's vertices with a callback, then re-shade. Rucks the rug,
//     dents the cushion, cups and droops the monstera leaves.
//  5. `createDresser()` — the bookkeeping: tracked geometry, prop registration, and the
//     static→dynamic promotion ladder described in dressing.js.
//
// All randomness comes from named seeded streams (`D.stream('books')`) so that adding one plush
// toy does not reshuffle the bookshelf and invalidate every screenshot diff.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng } from '../../core/rng.js';
import { fbmValue2, valueNoise2 } from '../textures.js';

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const mix = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

/** Tileable fbm in [0,1]; `s` scales the domain, `seed` picks the field. */
export const noise2 = (x, y, s = 1, seed = 0, octaves = 3) => fbmValue2(x * s, y * s, 64, seed, octaves);
/** Single-octave value noise in [0,1] — cheaper, for high-frequency jitter. */
export const vnoise = (x, y, seed = 0) => valueNoise2(x, y, 64, seed);
/** Signed fbm in [-1,1]. */
export const snoise2 = (x, y, s = 1, seed = 0, octaves = 3) => noise2(x, y, s, seed, octaves) * 2 - 1;

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

// ───────────────────────────────────────────────────────────────── geometry ──

/**
 * Walk every vertex of a geometry. `fn(pos, uv, index, geometry)` mutates `pos` in place.
 * Normals are recomputed afterwards unless `skipNormals` is set.
 */
export function deform(geo, fn, skipNormals = false) {
  const pos = geo.attributes.position;
  const uvA = geo.attributes.uv;
  const uv = new THREE.Vector2();
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i);
    if (uvA) uv.fromBufferAttribute(uvA, i);
    fn(_v, uv, i, geo);
    pos.setXYZ(i, _v.x, _v.y, _v.z);
  }
  pos.needsUpdate = true;
  if (!skipNormals) geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** A rounded box with real bevels. Never ship a raw BoxGeometry silhouette. */
export function roundedBox(w, h, d, r = 0.006, seg = 2) {
  const rad = Math.min(r, Math.min(w, Math.min(h, d)) * 0.49);
  return new RoundedBoxGeometry(w, h, d, seg, rad);
}

/** A squashed sphere. Cheaper and rounder than anything built from boxes. */
export function ellipsoid(rx, ry, rz, wSeg = 16, hSeg = 12) {
  const g = new THREE.SphereGeometry(1, wSeg, hSeg);
  g.scale(rx, ry, rz);
  return g;
}

/**
 * Merge a list of geometries. Returns null if the list is empty.
 *
 * `mergeGeometries` refuses to mix indexed with non-indexed input, or geometries with different
 * attribute sets — and three's own primitives disagree on both counts (`RoundedBoxGeometry` is
 * non-indexed, `CylinderGeometry` and `TorusGeometry` are indexed). Since almost every object in
 * this folder is a box merged with a couple of cylinders, we normalise first: everything is
 * flattened to non-indexed and stripped down to position/normal/uv. A failed merge returns the
 * first part rather than null, because a mesh built on `null` geometry throws on the next frame
 * and a missing speaker foot does not.
 */
const MERGE_ATTRS = ['position', 'normal', 'uv'];
export function mergeGeos(list) {
  const good = list.filter(Boolean);
  if (!good.length) return null;
  if (good.length === 1) return good[0];
  const parts = [];
  for (const g of good) {
    const p = g.index ? g.toNonIndexed() : g;
    if (p !== g) g.dispose();
    for (const name of Object.keys(p.attributes)) {
      if (MERGE_ATTRS.indexOf(name) < 0) p.deleteAttribute(name);
    }
    if (!p.attributes.normal) p.computeVertexNormals();
    if (!p.attributes.uv) {
      p.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(p.attributes.position.count * 2), 2));
    }
    parts.push(p);
  }
  const merged = BufferGeometryUtils.mergeGeometries(parts, false);
  if (!merged) return parts[0];
  for (const g of parts) g.dispose();
  return merged;
}

const _restBox = new THREE.Box3();
const _restRot = new THREE.Matrix4();
const _restEuler = new THREE.Euler();

/**
 * The y that puts an object's lowest point exactly on `surfaceY` once `rotation` is applied,
 * minus `sink` (how far a soft object presses into a soft surface).
 *
 * Every tumbled object in this folder uses it, because "resting height" for anything rotated is
 * not its half-height — a plush mouse tipped 80° onto its side hangs its tail 5 cm lower than its
 * body does, and eyeballing that number is exactly how objects end up hovering or half-buried.
 *
 * @param {THREE.Box3|THREE.BufferGeometry} what geometry (its bounding box is used) or a box
 * @param {number[]} rotation [x, y, z] euler applied to the object
 */
export function restY(what, rotation, surfaceY = 0, sink = 0) {
  let box = what;
  if (what && what.isBufferGeometry) {
    if (!what.boundingBox) what.computeBoundingBox();
    box = what.boundingBox;
  }
  if (!box) return surfaceY;
  _restEuler.set(rotation[0] || 0, rotation[1] || 0, rotation[2] || 0);
  _restRot.makeRotationFromEuler(_restEuler);
  _restBox.copy(box).applyMatrix4(_restRot);
  return surfaceY - _restBox.min.y - sink;
}

/** Apply a position/rotation/scale to a geometry in place (for merging). */
export function place(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _m.compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
  geo.applyMatrix4(_m);
  return geo;
}

// ─────────────────────────────────────────────────────────────────── pillow ──

/**
 * A closed outline (in the XY plane) swept into a rounded slab of half-thickness `half` along Z,
 * with a quarter-round rim of radius `rim`. Planar UVs from the outline's bounding box.
 *
 * @param {object} o
 * @param {(t:number)=>{x:number,y:number}} o.outline t∈[0,1) around the perimeter
 * @param {number} o.segments perimeter samples
 * @param {number} o.half half-thickness
 * @param {number} o.rim rim radius (clamped to `half`)
 * @param {number} o.capRings rows across each flat face
 * @param {number} o.rimRings rows across each rim quarter
 * @param {(p:THREE.Vector3,u:number,v:number,s:number)=>void} [o.displace] s: 0 bottom → 1 top
 */
export function pillow({
  outline, segments = 64, half = 0.03, rim = 0.02, capRings = 3, rimRings = 3, displace = null,
}) {
  const N = Math.max(8, Math.round(segments));
  const R = Math.min(rim, half * 0.999);
  const straight = Math.max(0, half - R);

  // Sample the outline and derive an inward normal per sample (average of the two edge normals).
  const px = new Float64Array(N);
  const py = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const p = outline(i / N);
    px[i] = p.x;
    py[i] = p.y;
  }
  const nx = new Float64Array(N);
  const ny = new Float64Array(N);
  let cx = 0;
  let cy = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < N; i++) {
    const a = (i - 1 + N) % N;
    const b = (i + 1) % N;
    // Outward normal of a CCW polygon edge (dy, -dx), averaged over the two adjacent edges.
    let ex = py[i] - py[a];
    let ey = -(px[i] - px[a]);
    let fx = py[b] - py[i];
    let fy = -(px[b] - px[i]);
    const el = Math.hypot(ex, ey) || 1;
    const fl = Math.hypot(fx, fy) || 1;
    ex /= el; ey /= el; fx /= fl; fy /= fl;
    let vx = ex + fx;
    let vy = ey + fy;
    const vl = Math.hypot(vx, vy) || 1;
    nx[i] = vx / vl;
    ny[i] = vy / vl;
    cx += px[i];
    cy += py[i];
    if (px[i] < minX) minX = px[i];
    if (px[i] > maxX) maxX = px[i];
    if (py[i] < minY) minY = py[i];
    if (py[i] > maxY) maxY = py[i];
  }
  cx /= N;
  cy /= N;
  const w = Math.max(1e-4, maxX - minX);
  const h = Math.max(1e-4, maxY - minY);

  // Row descriptors: inset from the outline, z, and how far the flat cap has closed toward centre.
  const rows = [];
  const capRow = (k, sign) => ({ inset: R, z: sign * half, cap: k, s: sign < 0 ? 0 : 1 });
  for (let i = 1; i <= capRings; i++) rows.push(capRow(i / capRings, -1)); // bottom face, out from centre
  for (let i = 1; i <= rimRings; i++) {
    const phi = (Math.PI / 2) * (i / rimRings); // -90° → 0°
    rows.push({ inset: R * (1 - Math.sin(phi)), z: -straight - R * Math.cos(phi), cap: 1, s: 0 });
  }
  rows.push({ inset: 0, z: -straight, cap: 1, s: 0 });
  rows.push({ inset: 0, z: straight, cap: 1, s: 1 });
  for (let i = rimRings - 1; i >= 0; i--) {
    const phi = (Math.PI / 2) * (i / rimRings);
    rows.push({ inset: R * (1 - Math.sin(phi)), z: straight + R * Math.cos(phi), cap: 1, s: 1 });
  }
  for (let i = capRings - 1; i >= 1; i--) rows.push(capRow(i / capRings, 1));

  const rowCount = rows.length;
  const verts = [];
  const uvs = [];
  const indices = [];

  const pushVert = (x, y, z, s) => {
    const p = _v.set(x, y, z);
    const u = (x - minX) / w;
    const vv = (y - minY) / h;
    if (displace) displace(p, u, vv, s);
    verts.push(p.x, p.y, p.z);
    uvs.push((p.x - minX) / w, (p.y - minY) / h);
  };

  // Bottom pole.
  pushVert(cx, cy, -half, 0);
  for (let r = 0; r < rowCount; r++) {
    const row = rows[r];
    const s = (r + 1) / (rowCount + 1);
    for (let i = 0; i < N; i++) {
      const ox = px[i] - nx[i] * row.inset;
      const oy = py[i] - ny[i] * row.inset;
      const x = cx + (ox - cx) * row.cap;
      const y = cy + (oy - cy) * row.cap;
      pushVert(x, y, row.z, s);
    }
  }
  // Top pole.
  pushVert(cx, cy, half, 1);
  const topPole = 1 + rowCount * N;

  // Fan at the bottom pole.
  for (let i = 0; i < N; i++) {
    indices.push(0, 1 + ((i + 1) % N), 1 + i);
  }
  for (let r = 0; r < rowCount - 1; r++) {
    const a = 1 + r * N;
    const b = 1 + (r + 1) * N;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      indices.push(a + i, a + j, b + i);
      indices.push(a + j, b + j, b + i);
    }
  }
  // Fan at the top pole.
  const last = 1 + (rowCount - 1) * N;
  for (let i = 0; i < N; i++) {
    indices.push(topPole, last + i, last + ((i + 1) % N));
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** A rounded-rectangle outline function for `pillow()`. */
export function roundedRectOutline(w, h, r) {
  const rr = Math.min(r, Math.min(w, h) * 0.5);
  const sw = w - 2 * rr;
  const sh = h - 2 * rr;
  const arc = (Math.PI / 2) * rr;
  const total = 2 * sw + 2 * sh + 4 * arc;
  return (t) => {
    let d = ((t % 1) + 1) % 1;
    d *= total;
    // Start at the +x mid-edge, run counter-clockwise.
    if (d < sh / 2) return { x: w / 2, y: d };
    d -= sh / 2;
    if (d < arc) { const a = (d / arc) * (Math.PI / 2); return { x: w / 2 - rr + rr * Math.cos(a), y: sh / 2 + rr * Math.sin(a) }; }
    d -= arc;
    if (d < sw) return { x: sw / 2 - d, y: h / 2 };
    d -= sw;
    if (d < arc) { const a = (d / arc) * (Math.PI / 2); return { x: -sw / 2 - rr * Math.sin(a), y: sh / 2 + rr * Math.cos(a) }; }
    d -= arc;
    if (d < sh) return { x: -w / 2, y: sh / 2 - d };
    d -= sh;
    if (d < arc) { const a = (d / arc) * (Math.PI / 2); return { x: -sw / 2 - rr * Math.cos(a), y: -sh / 2 - rr * Math.sin(a) }; }
    d -= arc;
    if (d < sw) return { x: -sw / 2 + d, y: -h / 2 };
    d -= sw;
    if (d < arc) { const a = (d / arc) * (Math.PI / 2); return { x: sw / 2 + rr * Math.sin(a), y: -sh / 2 - rr * Math.cos(a) }; }
    d -= arc;
    return { x: w / 2, y: -sh / 2 + d };
  };
}

// ──────────────────────────────────────────────────────────────────── sweep ──

/**
 * Sweep a closed 2D cross-section (XZ) along +Y.
 *
 * `section` is a list of `{ x, z, u, group }` — `u` is the texture coordinate around the
 * perimeter and `group` selects which material group the *outgoing* face belongs to. Caps are
 * emitted into `capGroup`.
 *
 * @param {object} o
 * @param {Array} o.section
 * @param {number} o.height
 * @param {number} [o.rows] vertical subdivisions
 * @param {(t:number)=>{sx:number,sz:number,dx:number,dz:number}} [o.profile] per-row taper/offset
 * @param {number} [o.groups] number of material groups
 * @param {number} [o.capGroup]
 * @param {number} [o.vScale] v = y / vScale for cap-group faces
 */
export function sweep({
  section, height, rows = 1, profile = null, groups = 2, capGroup = 1, vScale = 0.2, topEdge = null,
}) {
  const N = section.length;
  const verts = [];
  const uvs = [];
  const rowCount = rows + 1;

  for (let r = 0; r < rowCount; r++) {
    const t = r / rows;
    const pr = profile ? profile(t) : null;
    const sx = pr ? pr.sx : 1;
    const sz = pr ? pr.sz : 1;
    const dx = pr ? pr.dx || 0 : 0;
    const dz = pr ? pr.dz || 0 : 0;
    for (let i = 0; i < N; i++) {
      const s = section[i];
      const yTop = topEdge ? topEdge(s.u, i) : 1;
      verts.push(s.x * sx + dx, height * t * yTop, s.z * sz + dz);
      uvs.push(s.u, t);
    }
  }
  const gi = [];
  for (let g = 0; g < groups; g++) gi.push([]);
  for (let r = 0; r < rows; r++) {
    const a = r * N;
    const b = (r + 1) * N;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const g = gi[Math.min(groups - 1, section[i].group || 0)];
      g.push(a + i, a + j, b + i, a + j, b + j, b + i);
    }
  }

  // Caps: a fan from the section centroid, in the cap group, with planar UVs in metres.
  let cx = 0;
  let cz = 0;
  for (const s of section) { cx += s.x; cz += s.z; }
  cx /= N; cz /= N;
  const capG = gi[Math.min(groups - 1, capGroup)];
  const base = verts.length / 3;
  const pr1 = profile ? profile(1) : null;
  verts.push(cx, 0, cz);
  uvs.push(0.5, 0.5);
  verts.push(cx * (pr1 ? pr1.sx : 1) + (pr1 ? pr1.dx || 0 : 0), height, cz * (pr1 ? pr1.sz : 1) + (pr1 ? pr1.dz || 0 : 0));
  uvs.push(0.5, 0.5);
  const ringBase = verts.length / 3;
  for (let i = 0; i < N; i++) {
    const s = section[i];
    verts.push(s.x, 0, s.z);
    uvs.push(0.5 + s.x / vScale, 0.5 + s.z / vScale);
  }
  const ringTop = verts.length / 3;
  for (let i = 0; i < N; i++) {
    const s = section[i];
    const sx = pr1 ? pr1.sx : 1;
    const sz = pr1 ? pr1.sz : 1;
    verts.push(s.x * sx + (pr1 ? pr1.dx || 0 : 0), height, s.z * sz + (pr1 ? pr1.dz || 0 : 0));
    uvs.push(0.5 + s.x / vScale, 0.5 + s.z / vScale);
  }
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    capG.push(base, ringBase + j, ringBase + i);
    capG.push(base + 1, ringTop + i, ringTop + j);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  const all = [];
  let offset = 0;
  for (let g = 0; g < groups; g++) {
    all.push(...gi[g]);
    geo.addGroup(offset, gi[g].length, g);
    offset += gi[g].length;
  }
  geo.setIndex(all);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

// ──────────────────────────────────────────────────────────────────── lathe ──

/**
 * A surface of revolution with noise. `radius(t)` is the profile (t: 0 bottom → 1 top) and
 * `perturb(t, theta)` adds to it — which is how the vase gets vertical knobbly ribs that wander
 * instead of a machined cylinder.
 */
export function lathe({
  radius, height = 1, path = null, rings = 40, segments = 40, perturb = null, yOffset = 0,
  closeBottom = true, closeTop = false,
}) {
  const verts = [];
  const uvs = [];
  const idx = [];
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    // `path` lets the profile fold back on itself — over a lip and down the inside of a vase —
    // which is the only way a thrown vessel reads as hollow rather than as a solid plug.
    const p = path ? path(t) : null;
    const y = p ? yOffset + p.y : yOffset + height * t;
    const base = p ? p.r : radius(t);
    for (let s = 0; s <= segments; s++) {
      const th = (s / segments) * Math.PI * 2;
      const rad = base + (perturb ? perturb(t, th, base) : 0);
      verts.push(Math.cos(th) * rad, y, Math.sin(th) * rad);
      uvs.push(s / segments, t);
    }
  }
  const stride = segments + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * stride + s;
      const b = a + stride;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  if (closeBottom) {
    const c = verts.length / 3;
    verts.push(0, yOffset + (path ? path(0).y : 0), 0);
    uvs.push(0.5, 0);
    for (let s = 0; s < segments; s++) idx.push(c, s + 1, s);
  }
  if (closeTop) {
    const c = verts.length / 3;
    verts.push(0, yOffset + (path ? path(1).y : height), 0);
    uvs.push(0.5, 1);
    const top = rings * stride;
    for (let s = 0; s < segments; s++) idx.push(c, top + s, top + s + 1);
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
 * A smooth 1D profile through control points `[[t, value], …]`, Catmull-Rom between them.
 * Used for every lathed silhouette in the room, because a vase built from straight segments
 * shows its facets the moment the window rakes across it.
 */
export function spline(pts) {
  const n = pts.length;
  return (t) => {
    const x = clamp(t, pts[0][0], pts[n - 1][0]);
    let i = 0;
    while (i < n - 2 && x > pts[i + 1][0]) i++;
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(n - 1, i + 2)];
    const span = p2[0] - p1[0] || 1e-6;
    const u = (x - p1[0]) / span;
    const m1 = (p2[1] - p0[1]) / Math.max(1e-6, p2[0] - p0[0]) * span;
    const m2 = (p3[1] - p1[1]) / Math.max(1e-6, p3[0] - p1[0]) * span;
    const u2 = u * u;
    const u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * p1[1] + (u3 - 2 * u2 + u) * m1
      + (-2 * u3 + 3 * u2) * p2[1] + (u3 - u2) * m2;
  };
}

/** A tube along a Catmull-Rom curve through `points`. Radius may taper along t. */
export function tubeAlong(points, radiusFn, tubular = 20, radial = 7) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => (p.isVector3 ? p : new THREE.Vector3(p[0], p[1], p[2]))));
  const r0 = typeof radiusFn === 'function' ? radiusFn(0) : radiusFn;
  const geo = new THREE.TubeGeometry(curve, tubular, Math.max(r0, 1e-4), radial, false);
  if (typeof radiusFn === 'function') {
    // TubeGeometry has no taper, so scale each ring toward its own centre after the fact.
    const pos = geo.attributes.position;
    for (let i = 0; i <= tubular; i++) {
      const t = i / tubular;
      const k = Math.max(1e-3, radiusFn(t) / r0);
      const centre = curve.getPointAt(Math.min(1, t));
      for (let j = 0; j <= radial; j++) {
        const n = i * (radial + 1) + j;
        _v.fromBufferAttribute(pos, n).sub(centre).multiplyScalar(k).add(centre);
        pos.setXYZ(n, _v.x, _v.y, _v.z);
      }
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }
  return geo;
}

// ───────────────────────────────────────────────────────────────── the dresser ──

/**
 * Bookkeeping shared by every dressing sub-module: seeded streams, tracked geometry, prop
 * registration, and the static→dynamic promotion ladder.
 */
export function createDresser(ctx) {
  const group = new THREE.Group();
  group.name = 'dressing';
  group.matrixAutoUpdate = false;

  const streams = new Map();
  const props = [];
  const promotable = [];
  const tier = ctx.quality?.tier || 'high';
  const rank = { low: 0, medium: 1, high: 2, ultra: 3 }[tier] ?? 2;

  const api = {
    ctx,
    group,
    tier,
    rank,
    /** True when the tier is at least `name`. */
    atLeast: (name) => rank >= ({ low: 0, medium: 1, high: 2, ultra: 3 }[name] ?? 2),
    /** Pick a value by tier: lod(6, 10, 16, 20). */
    lod: (low, medium, high, ultra = high) => [low, medium, high, ultra][rank],

    /** A named deterministic random stream. Adding a book never reshuffles the toys. */
    stream(name) {
      let r = streams.get(name);
      if (!r) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < name.length; i++) {
          hash ^= name.charCodeAt(i);
          hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        r = makeRng(hash);
        streams.set(name, r);
      }
      return r;
    },

    mat: (name) => ctx.materials.get(name),
    tint: (name, hex, opts) => ctx.materials.tinted(name, hex, opts),
    tiled: (name, w, h) => ctx.materials.tiled(name, w, h),

    /** Track a geometry for teardown and return it. */
    geo: (g) => ctx.track(g),

    /** A tracked mesh with shadows on by default. */
    mesh(geometry, material, opts = {}) {
      ctx.track(geometry);
      const m = new THREE.Mesh(geometry, material);
      m.castShadow = opts.cast !== false;
      m.receiveShadow = opts.receive !== false;
      if (opts.name) m.name = opts.name;
      if (opts.parent) opts.parent.add(m);
      return m;
    },

    /** A tracked InstancedMesh. */
    instanced(geometry, material, count, opts = {}) {
      ctx.track(geometry);
      const m = new THREE.InstancedMesh(geometry, material, count);
      m.castShadow = opts.cast !== false;
      m.receiveShadow = opts.receive !== false;
      m.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      if (opts.name) m.name = opts.name;
      return m;
    },

    add(obj, parent = group) {
      parent.add(obj);
      return obj;
    },

    /**
     * Register a prop.
     *
     * By default it gets a real dynamic rigid body that is immediately FROZEN — Rapier switches it
     * to a fixed body, so it costs exactly what a static collider costs, never drifts, and never
     * settles the authored composition out from under itself at load (the collapsing book stack
     * has to stay mid-collapse, the plush pile has to stay interpenetrating). The proximity sweep
     * in dressing.js thaws the handful near the baby.
     *
     * Freezing rather than swapping the body is deliberate: GAME caches one physics record per
     * prop when the round starts, so a prop whose record is destroyed and rebuilt on approach
     * silently drops out of the topple watcher and can never score again. Same body, same handle,
     * same record — only its type changes.
     *
     * `dynamic: true` skips the freeze (the monstera, which must feel loose from frame one),
     * `anchor: true` gives a genuine static body that is never thawed (the rug, the play mat),
     * and `collide: false` registers a pure visual with no body at all.
     */
    prop(spec) {
      const {
        phys = {}, dynamic = false, collide = true, anchor = false, ...rest
      } = spec;
      const obj = rest.object3d;
      const prop = ctx.props.register(rest);
      if (!obj || !collide || !ctx.physics) {
        prop.body = null;
        props.push(prop);
        return prop;
      }
      const opts = {
        shape: 'box',
        friction: 0.72,
        restitution: 0.12,
        linearDamping: 0.16,
        angularDamping: 0.5,
        ...phys,
        mass: rest.mass ?? 1,
        prop,
      };
      obj.updateWorldMatrix(true, true);
      const entry = {
        prop,
        object3d: obj,
        opts,
        dynamic: false,
        record: null,
        home: {
          position: obj.position.clone(),
          quaternion: obj.quaternion.clone(),
          world: obj.getWorldPosition(new THREE.Vector3()),
          worldQuat: obj.getWorldQuaternion(new THREE.Quaternion()),
        },
      };
      if (anchor) {
        // The rug and the play mat: a floor is a floor.
        entry.record = ctx.physics.addStatic(obj, opts);
        entry.dynamic = false;
      } else {
        entry.record = ctx.physics.addDynamic(obj, { startAsleep: !dynamic, ...opts });
        entry.dynamic = true;
        if (!dynamic && entry.record) {
          ctx.physics.freeze(entry.record, true);
          ctx.physics.sleep(entry.record);
          entry.dynamic = false;
          promotable.push(entry);
        }
      }
      entry.anchor = anchor;
      prop.body = entry.record?.body || null;
      prop.record = entry.record;
      prop.entry = entry;
      prop.promote = () => api.promote(prop);
      props.push(prop);
      return prop;
    },

    /**
     * Thaw a frozen prop: the fixed body becomes dynamic again and wakes up. Idempotent, cheap,
     * and — critically — it keeps the same rigid body, collider and PHYS record, so anything that
     * cached a record earlier (GAME's topple watcher, AUDIO's contact router) stays wired up.
     */
    promote(propOrId) {
      const prop = typeof propOrId === 'string' ? ctx.props.get(propOrId) : propOrId;
      const entry = prop?.entry;
      if (!entry || entry.dynamic || entry.anchor || !ctx.physics || !entry.record) return null;
      entry.dynamic = true;
      const i = promotable.indexOf(entry);
      if (i >= 0) promotable.splice(i, 1);
      ctx.physics.freeze(entry.record, false);
      ctx.physics.wake(entry.record);
      prop.record = entry.record;
      prop.body = entry.record.body;
      return entry.record;
    },

    /** Put a prop back where it was authored and re-freeze it. Used by reset(). */
    demote(prop) {
      const entry = prop?.entry;
      if (!entry || entry.anchor || !ctx.physics || !entry.record) return;
      ctx.physics.teleport(entry.record, entry.home.world, entry.home.worldQuat);
      ctx.physics.freeze(entry.record, true);
      ctx.physics.sleep(entry.record);
      entry.dynamic = false;
      if (promotable.indexOf(entry) < 0) promotable.push(entry);
    },

    props,
    promotable,
  };

  return api;
}
