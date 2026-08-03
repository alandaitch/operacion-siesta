// FURN · the geometry toolkit.
//
// Every object in this room is a box that has been argued with. The interesting engineering is
// therefore *deformation*, not modelling: `softBox` takes a subdivided rounded box and pushes it
// around with three closed-form falloffs — a smooth radial sag (a seat cushion collapses most in
// the middle and least at its piped edge), a mid-height bulge (foam under tension pushes the
// side walls out), and a local Gaussian dent (somebody sat here) — then re-welds the normals by
// position so the result shades as one continuous soft surface instead of a faceted box.
//
// Two more things earn their keep:
//  · `shellSweep` sweeps a closed cross-section along an open plan path with a per-station height
//    scale. That is how the bouclé armchair's tub is built: one profile, a horseshoe path, and a
//    height curve that drops from 0.74 m at the back to 0.55 m at the arm tips. A lathe cannot do
//    that, and a cylinder is the classic tell of a procedural chair.
//  · `projectUV` assigns UVs from the vertex's dominant normal axis in *metres divided by the
//    material's real tile size*, so plywood grain is the same physical scale on a 0.36 m shelf and
//    a 0.78 m upright. `swap` rotates the mapping 90° for the vertical ply edges, where the
//    laminations have to stack across the 18 mm and not along the height.
//
// Nothing here calls Math.random: `makeNoise3` is a hashed value noise, so the same seed gives the
// same wrinkles on every run and the review screenshots stay diffable.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export const DEG = Math.PI / 180;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const smoothstep = (t) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

// ───────────────────────────────────────────────────────────────── noise ──

const FADE = (t) => t * t * t * (t * (t * 6 - 15) + 10);

function hash3(ix, iy, iz, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(iz | 0, 2147483647);
  h = Math.imul(h ^ seed, 1274126177);
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Deterministic trilinear value noise in [-1, 1]. */
export function makeNoise3(seed = 1) {
  const s = (seed | 0) || 1;
  return function noise(x, y, z) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const u = FADE(x - xi);
    const v = FADE(y - yi);
    const w = FADE(z - zi);
    const c000 = hash3(xi, yi, zi, s);
    const c100 = hash3(xi + 1, yi, zi, s);
    const c010 = hash3(xi, yi + 1, zi, s);
    const c110 = hash3(xi + 1, yi + 1, zi, s);
    const c001 = hash3(xi, yi, zi + 1, s);
    const c101 = hash3(xi + 1, yi, zi + 1, s);
    const c011 = hash3(xi, yi + 1, zi + 1, s);
    const c111 = hash3(xi + 1, yi + 1, zi + 1, s);
    const x00 = c000 + (c100 - c000) * u;
    const x10 = c010 + (c110 - c010) * u;
    const x01 = c001 + (c101 - c001) * u;
    const x11 = c011 + (c111 - c011) * u;
    const y0 = x00 + (x10 - x00) * v;
    const y1 = x01 + (x11 - x01) * v;
    return (y0 + (y1 - y0) * w) * 2 - 1;
  };
}

// ───────────────────────────────────────────────────────────────── normals ──

/**
 * Recompute normals and then average them across coincident positions. RoundedBoxGeometry is
 * non-indexed, so a plain computeVertexNormals() facets everything; welding by position is what
 * turns a deformed box back into a smooth soft-goods surface.
 */
export function smoothNormals(geo, eps = 2e-4) {
  geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const inv = 1 / eps;
  const acc = new Map();
  const keys = new Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * inv)},${Math.round(pos.getY(i) * inv)},${Math.round(pos.getZ(i) * inv)}`;
    keys[i] = k;
    let e = acc.get(k);
    if (!e) { e = [0, 0, 0]; acc.set(k, e); }
    e[0] += nrm.getX(i);
    e[1] += nrm.getY(i);
    e[2] += nrm.getZ(i);
  }
  for (let i = 0; i < pos.count; i++) {
    const e = acc.get(keys[i]);
    _n.set(e[0], e[1], e[2]);
    if (_n.lengthSq() < 1e-12) continue;
    _n.normalize();
    nrm.setXYZ(i, _n.x, _n.y, _n.z);
  }
  nrm.needsUpdate = true;
  return geo;
}

// ─────────────────────────────────────────────────────────────────── UVs ──

/**
 * Metre-accurate UVs from the dominant normal axis.
 * `cfg` = { x:[tileU, tileV, swap], y:[...], z:[...], def:[...] } with tile sizes in metres.
 * Pair the result with a material whose texture repeat is 1 (see `kit.unit`).
 */
export function projectUV(geo, cfg) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  if (!nrm) geo.computeVertexNormals();
  let uv = geo.attributes.uv;
  if (!uv || uv.count !== pos.count) {
    uv = new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2);
    geo.setAttribute('uv', uv);
  }
  const nn = geo.attributes.normal;
  const def = cfg.def || [1, 1, false];
  const ox = cfg.origin ? cfg.origin[0] : 0;
  const oy = cfg.origin ? cfg.origin[1] : 0;
  const oz = cfg.origin ? cfg.origin[2] : 0;
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nn.getX(i));
    const ay = Math.abs(nn.getY(i));
    const az = Math.abs(nn.getZ(i));
    let p; let q; let c;
    if (ax >= ay && ax >= az) { p = pos.getZ(i) - oz; q = pos.getY(i) - oy; c = cfg.x || def; }
    else if (ay >= az) { p = pos.getX(i) - ox; q = pos.getZ(i) - oz; c = cfg.y || def; }
    else { p = pos.getX(i) - ox; q = pos.getY(i) - oy; c = cfg.z || def; }
    const tu = c[0] || 1;
    const tv = c[1] || tu;
    if (c[2]) uv.setXY(i, q / tu, p / tv);
    else uv.setXY(i, p / tu, q / tv);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Scale existing (0..1) UVs — for lathes and tubes, whose native parameterisation is already right. */
export function scaleUV(geo, su, sv, ou = 0, ov = 0) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su + ou, uv.getY(i) * sv + ov);
  uv.needsUpdate = true;
  return geo;
}

// ──────────────────────────────────────────────────────────────── shapes ──

/** A box with a real arris. Never ship a 90° edge: the highlight along a 2 mm chamfer is free. */
export function chamferBox(w, h, d, c = 0.004, segments = 1) {
  const r = Math.min(c, w * 0.49, h * 0.49, d * 0.49);
  return new RoundedBoxGeometry(w, h, d, segments, r);
}

/**
 * The soft-goods primitive. See the file header for what each term does.
 * All amounts are metres.
 */
export function softBox(w, h, d, opts = {}) {
  const {
    radius = Math.min(w, h, d) * 0.3,
    segments = 4,
    sag = 0,
    sagAt = [0, 0],
    sagSpread = 1.05,
    bulge = 0,
    bulgeAt = 0.42,
    taper = 0,
    corner = 0,
    dents = null,
    wrinkle = 0,
    wrinkleScale = 7,
    lean = 0,
    seed = 17,
  } = opts;

  const geo = chamferBox(w, h, d, radius, segments);
  const pos = geo.attributes.position;
  const noise = wrinkle > 0 ? makeNoise3(seed) : null;
  const nrm = geo.attributes.normal;
  const hw = w * 0.5;
  const hd = d * 0.5;
  const spread2 = sagSpread * sagSpread;

  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);
    const t = clamp((y + h * 0.5) / h, 0, 1);
    const u = clamp(x / hw, -1, 1);
    const v = clamp(z / hd, -1, 1);

    // Scatter-cushion ears: the four plan corners are pulled out and squashed flat.
    if (corner !== 0) {
      const cf = Math.pow(Math.abs(u) * Math.abs(v), 1.1);
      x += Math.sign(u) * corner * cf;
      z += Math.sign(v) * corner * cf;
      y *= 1 - 0.42 * cf;
    }

    // Foam under tension: the side walls bow out around bulgeAt of the height.
    if (bulge !== 0) {
      const bp = Math.max(0, 1 - Math.pow((t - bulgeAt) / 0.5, 2));
      const bs = bp * bp * (3 - 2 * bp);
      x += Math.sign(u) * Math.abs(u) * bulge * bs;
      z += Math.sign(v) * Math.abs(v) * bulge * bs;
    }

    if (taper !== 0) {
      const k = 1 - taper * t;
      x *= k;
      z *= k;
    }

    // The sag. Weighted toward the top face so the underside only follows a quarter of the way.
    if (sag !== 0) {
      const du = u - sagAt[0];
      const dv = v - sagAt[1];
      const f = Math.max(0, 1 - (du * du + dv * dv) / spread2);
      y -= sag * (f * f * (3 - 2 * f)) * (0.24 + 0.76 * t);
    }

    if (dents) {
      for (let k = 0; k < dents.length; k++) {
        const dnt = dents[k];
        const du = u - dnt.u;
        const dv = v - dnt.v;
        const rr = dnt.r || 0.45;
        const g = Math.exp(-(du * du + dv * dv) / (rr * rr));
        y -= dnt.depth * g * (dnt.top === false ? 1 : t);
      }
    }

    // Leaning back: a shear, not a rotation, so the base stays flat on the deck.
    if (lean !== 0) x += lean * t;

    if (noise) {
      const amp = wrinkle * (0.55 + 0.45 * Math.abs(noise(x * 3.1, y * 3.1, z * 3.1)));
      const nx = nrm.getX(i);
      const ny = nrm.getY(i);
      const nz = nrm.getZ(i);
      const nv = noise(x * wrinkleScale, y * wrinkleScale * 1.4, z * wrinkleScale);
      x += nx * nv * amp;
      y += ny * nv * amp;
      z += nz * nv * amp;
    }

    pos.setXYZ(i, x, y, z);
  }
  pos.needsUpdate = true;
  smoothNormals(geo);
  geo.computeBoundingBox();
  return geo;
}

/**
 * Push every vertex through `fn(v, i, uv)` and re-weld the normals. This is how a lathed pouf gets
 * an off-centre sitting dent: a surface of revolution that stays a surface of revolution is the
 * giveaway that nobody has ever sat on it.
 */
export function deformGeometry(geo, fn) {
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    fn(v, i);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  smoothNormals(geo);
  geo.computeBoundingBox();
  return geo;
}

/** Closed rounded-rectangle path in the XZ plane, as Vector2(x, z). */
export function roundedRectPts(w, d, r, perCorner = 5) {
  const hw = Math.max(1e-4, w * 0.5 - r);
  const hd = Math.max(1e-4, d * 0.5 - r);
  const out = [];
  const corners = [
    [hw, hd, 0],
    [-hw, hd, Math.PI * 0.5],
    [-hw, -hd, Math.PI],
    [hw, -hd, Math.PI * 1.5],
  ];
  for (let c = 0; c < 4; c++) {
    const [cx, cz, a0] = corners[c];
    for (let i = 0; i <= perCorner; i++) {
      const a = a0 + (i / perCorner) * Math.PI * 0.5;
      out.push(new THREE.Vector2(cx + Math.cos(a) * r, cz + Math.sin(a) * r));
    }
  }
  return out;
}

/** A tube through a list of Vector3s. Used for piping, rails, cords, cane strands. */
export function tubeThrough(points, radius, { radialSegments = 8, closed = false, tubularSegments = null, tension = 0.5, curveType = 'catmullrom' } = {}) {
  const curve = new THREE.CatmullRomCurve3(points, closed, curveType, tension);
  const segs = tubularSegments || Math.max(8, Math.round(curve.getLength() / 0.028));
  return new THREE.TubeGeometry(curve, segs, radius, radialSegments, closed);
}

/** Piping: a cord following a rounded rectangle at height `y`, as real geometry. */
export function pipingLoop(w, d, y, radius = 0.0075, cornerR = 0.06, { wobble = 0, seed = 5, radialSegments = 6 } = {}) {
  const pts2 = roundedRectPts(w, d, cornerR, 5);
  const noise = wobble > 0 ? makeNoise3(seed) : null;
  const pts = pts2.map((p, i) => {
    const wob = noise ? noise(p.x * 5, i * 0.31, p.y * 5) * wobble : 0;
    return new THREE.Vector3(p.x, y + wob, p.y);
  });
  return tubeThrough(pts, radius, { radialSegments, closed: true, tension: 0.35 });
}

/**
 * Sweep a closed cross-section along an open plan path.
 *
 * `path`    : [{ x, z, nx, nz }] station positions and outward plan normals (normals unit length)
 * `profile` : [{ r, y }] closed loop; r is the offset along the outward normal
 * `heightAt`: optional (t) => top y, which scales the profile about its own base
 * `thickAt` : optional (t) => scale factor on r
 */
export function shellSweep(path, profile, { heightAt = null, thickAt = null, capStart = true, capEnd = true, tileU = 0.8, tileV = 0.8 } = {}) {
  const n = path.length;
  const m = profile.length;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let j = 0; j < m; j++) {
    if (profile[j].y < y0) y0 = profile[j].y;
    if (profile[j].y > y1) y1 = profile[j].y;
  }
  const span = Math.max(1e-5, y1 - y0);

  // Arclengths for UVs.
  const su = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const dx = path[i].x - path[i - 1].x;
    const dz = path[i].z - path[i - 1].z;
    su[i] = su[i - 1] + Math.hypot(dx, dz);
  }
  const sv = new Float32Array(m + 1);
  for (let j = 1; j <= m; j++) {
    const a = profile[j % m];
    const b = profile[j - 1];
    sv[j] = sv[j - 1] + Math.hypot(a.r - b.r, a.y - b.y);
  }

  const cols = m + 1; // duplicated seam column so the UV can run past 1
  const verts = new Float32Array(n * cols * 3);
  const uvs = new Float32Array(n * cols * 2);
  let p = 0;
  let q = 0;
  for (let i = 0; i < n; i++) {
    const st = path[i];
    const t = n > 1 ? i / (n - 1) : 0;
    const hs = heightAt ? (heightAt(t) - y0) / span : 1;
    const ts = thickAt ? thickAt(t) : 1;
    for (let j = 0; j < cols; j++) {
      const pr = profile[j % m];
      const r = pr.r * ts;
      verts[p++] = st.x + st.nx * r;
      verts[p++] = y0 + (pr.y - y0) * hs;
      verts[p++] = st.z + st.nz * r;
      uvs[q++] = su[i] / tileU;
      uvs[q++] = sv[j] / tileV;
    }
  }

  const idx = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j;
      const b = a + cols;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  // The seam column is a duplicate, so weld normals across it by position.
  const parts = [smoothNormals(geo.toNonIndexed())];
  geo.dispose();

  const cap = (i, flip) => {
    const st = path[i];
    const t = n > 1 ? i / (n - 1) : 0;
    const hs = heightAt ? (heightAt(t) - y0) / span : 1;
    const ts = thickAt ? thickAt(t) : 1;
    const pts = [];
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let j = 0; j < m; j++) {
      const pr = profile[j];
      const r = pr.r * ts;
      const v = new THREE.Vector3(st.x + st.nx * r, y0 + (pr.y - y0) * hs, st.z + st.nz * r);
      pts.push(v);
      cx += v.x; cy += v.y; cz += v.z;
    }
    cx /= m; cy /= m; cz /= m;
    const vs = [];
    const us = [];
    for (let j = 0; j < m; j++) {
      const a = pts[j];
      const b = pts[(j + 1) % m];
      if (flip) vs.push(cx, cy, cz, b.x, b.y, b.z, a.x, a.y, a.z);
      else vs.push(cx, cy, cz, a.x, a.y, a.z, b.x, b.y, b.z);
      us.push(0.5, 0.5, 0, 0, 1, 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vs), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(us), 2));
    g.computeVertexNormals();
    return g;
  };
  if (capStart) parts.push(cap(0, true));
  if (capEnd) parts.push(cap(n - 1, false));

  return mergeParts(parts);
}

/**
 * A stretched fabric panel. Taut flat quads are the fastest way to make mesh look like a decal, so
 * every panel bows inward and slacks downward by a few millimetres.
 * Built in the XY plane facing +Z; displacement is -Z.
 */
export function bowPanel(w, h, { segX = 12, segY = 8, bow = 0.014, sag = 0.006, ripple = 0.0016, seed = 41 } = {}) {
  const geo = new THREE.PlaneGeometry(w, h, segX, segY);
  const pos = geo.attributes.position;
  const noise = makeNoise3(seed);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const u = (x / w) + 0.5;
    const v = (y / h) + 0.5;
    const env = Math.sin(Math.PI * clamp(u, 0, 1)) * Math.sin(Math.PI * clamp(v, 0, 1));
    const z = -bow * env - ripple * noise(x * 9, y * 9, 3.7) * Math.sin(Math.PI * clamp(u, 0, 1));
    pos.setXYZ(i, x, y - sag * env, z);
  }
  pos.needsUpdate = true;
  smoothNormals(geo);
  return geo;
}

/** LatheGeometry from [x, y] pairs, with the UV scaled to real metres. */
export function lathe(profile, segments = 32, tileU = 0.3, tileV = 0.3) {
  const pts = profile.map((p) => new THREE.Vector2(Math.max(1e-5, p[0]), p[1]));
  const geo = new THREE.LatheGeometry(pts, segments);
  let rmax = 0;
  let len = 0;
  for (let i = 0; i < profile.length; i++) {
    rmax = Math.max(rmax, profile[i][0]);
    if (i) len += Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]);
  }
  return scaleUV(geo, (2 * Math.PI * rmax) / tileU, len / tileV);
}

// ──────────────────────────────────────────────────────────────── merging ──

function normalise(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  }
  for (const k of Object.keys(g.attributes)) {
    if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  }
  g.clearGroups();
  return g;
}

/** Merge same-material parts into one draw call. Disposes anything it had to convert. */
export function mergeParts(geos) {
  const src = geos.filter(Boolean);
  if (!src.length) return null;
  const list = [];
  const temps = [];
  for (const g of src) {
    const n = normalise(g);
    if (n !== g) temps.push(n);
    list.push(n);
  }
  const out = list.length === 1 ? list[0].clone() : mergeGeometries(list, false);
  for (const t of temps) t.dispose();
  for (const g of src) g.dispose();
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/** Bake a transform into a geometry (before merging). */
export function xform(geo, { pos = null, rot = null, scale = null } = {}) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  if (rot) q.setFromEuler(new THREE.Euler(rot[0] || 0, rot[1] || 0, rot[2] || 0, 'XYZ'));
  m.compose(
    new THREE.Vector3(pos ? pos[0] : 0, pos ? pos[1] : 0, pos ? pos[2] : 0),
    q,
    new THREE.Vector3(scale ? scale[0] : 1, scale ? scale[1] : 1, scale ? scale[2] : 1),
  );
  geo.applyMatrix4(m);
  return geo;
}

// ───────────────────────────────────────────────────────────────── meshes ──

/** Give a subtree sane shadow flags. Fabric mesh panels opt out on the cheap tiers. */
export function shadows(root, cast = true, receive = true) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = cast;
    o.receiveShadow = receive;
  });
  return root;
}

/** Two points → a cylinder spanning them. Used for lamp stems and the pendant cord. */
export function spanCylinder(a, b, radius, radialSegments = 8, tileV = 0.2) {
  _a.copy(a);
  _b.copy(b);
  const len = _a.distanceTo(_b);
  const geo = new THREE.CylinderGeometry(radius, radius, Math.max(len, 1e-4), radialSegments, 1, true);
  scaleUV(geo, (2 * Math.PI * radius) / tileV, len / tileV);
  const mid = _a.clone().add(_b).multiplyScalar(0.5);
  const dir = _b.clone().sub(_a).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const m = new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1));
  geo.applyMatrix4(m);
  return geo;
}
