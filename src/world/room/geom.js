// OPERATION NAPTIME — module ROOM — the geometry toolkit the shell is built from.
// OWNER: ROOM.
//
// Five primitives and one batcher. Everything architectural in this room comes out of here, which
// is how the whole shell ends up obeying the same three rules without repeating them:
//
//  1. NO SHARP ARRISES. `chamferBox` is the only box in this module. A 3 mm chamfer on every one
//     of the twelve edges costs 32 extra triangles and buys the single most valuable thing in an
//     interior render — a highlight line along every corner. A perfect 90° edge catches no light
//     at all and is the fastest way to look like a CAD viewport.
//  2. UVs ARE IN METRES. Every generator here writes texture coordinates as real-world metres,
//     offset by the surface's world position. Combined with `surfaceMaterial()` — which asks the
//     material library for a clone whose repeat is 1/tileMetres — that means a wall, a reveal and
//     a lintel share one continuous plaster grain with no per-mesh repeat tuning, and two adjacent
//     meshes never show a seam because their UVs are literally the same coordinate system.
//  3. EVERYTHING CARRIES VERTEX COLOUR. Cheap baked occlusion (wall/ceiling junctions, the inside
//     of the hallway, the dirt line where the floor meets the plaster) is per-vertex, which costs
//     nothing at runtime and survives the `low` tier where screen-space AO is switched off. Since
//     every geometry has a `color` attribute they are all mergeable into one buffer per material.
//
// `createBatch` is what keeps the draw calls sane: geometries are accumulated per material, baked
// through their world matrix, and merged into a single mesh at flush time. The whole window wall —
// frames, mullions, sliding stiles, track, handle — ships as one draw call.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _n = new THREE.Vector3();

// ── deterministic noise (no Math.random, ever) ────────────────────────────────────────────────

function ihash(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise on a unit lattice. Deterministic for a given (x, y, seed). */
export function noise2(x, y, seed = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = ihash(xi, yi, seed);
  const b = ihash(xi + 1, yi, seed);
  const c = ihash(xi, yi + 1, seed);
  const d = ihash(xi + 1, yi + 1, seed);
  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return top + (bot - top) * v;
}

/** Fractal value noise, mean ~0.5. */
export function fbm2(x, y, seed = 0, octaves = 3, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(fx, fy, seed + i * 101) * amp;
    norm += amp;
    amp *= gain;
    fx *= 2.03;
    fy *= 1.97;
  }
  return sum / norm;
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

// ── the mesher ────────────────────────────────────────────────────────────────────────────────

/** A tiny non-allocating-ish accumulator for hand-built geometry. Flat-shaded by construction:
 *  every face pushes its own vertices, which is exactly what a chamfered arris needs. */
export class Mesher {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.col = [];
    this.idx = [];
  }

  /** @returns {number} the index of the vertex just pushed */
  vertex(px, py, pz, nx, ny, nz, u, v, r = 1, g = 1, b = 1) {
    this.pos.push(px, py, pz);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(r, g, b);
    return this.pos.length / 3 - 1;
  }

  tri(a, b, c) {
    this.idx.push(a, b, c);
  }

  /** Quad a→b→c→d; the winding is flipped automatically if it does not face `ref`. */
  quad(a, b, c, d, refX, refY, refZ) {
    const p = this.pos;
    _v0.set(p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]);
    _v1.set(p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]);
    _v2.crossVectors(_v0, _v1);
    if (_v2.x * refX + _v2.y * refY + _v2.z * refZ >= 0) {
      this.idx.push(a, b, c, a, c, d);
    } else {
      this.idx.push(a, d, c, a, c, b);
    }
  }

  /** Triangle a→b→c with the same automatic winding correction. */
  triFacing(a, b, c, refX, refY, refZ) {
    const p = this.pos;
    _v0.set(p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]);
    _v1.set(p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]);
    _v2.crossVectors(_v0, _v1);
    if (_v2.x * refX + _v2.y * refY + _v2.z * refZ >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }

  geometry(name = 'room.geom') {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.name = name;
    return g;
  }
}

// ── primitive 1: the chamfered box ────────────────────────────────────────────────────────────

// Which world axes become (u, v) for a face whose normal runs along axis a.
const UV_AXES = [
  [2, 1], // +/-X face: u along Z, v along Y
  [0, 2], // +/-Y face: u along X, v along Z
  [0, 1], // +/-Z face: u along X, v along Y
];

/**
 * A box with all twelve edges chamfered and all six faces optionally subdivided.
 *
 * @param {number} w,h,d full sizes in metres
 * @param {number} bevel chamfer width (clamped to 45% of the smallest half-extent)
 * @param {object} [opts]
 *   seg      [nx, ny, nz] subdivisions along each axis; a face uses the two that apply
 *   at       [x, y, z] world centre — used ONLY to anchor the metre UVs, not to move the geometry
 *   colour   (x, y, z, nx, ny, nz) => [r, g, b] per-vertex tint, in the box's local frame
 *   skip     array of face names to omit: '+x' '-x' '+y' '-y' '+z' '-z'
 * @returns {THREE.BufferGeometry} centred on the origin, with position/normal/uv/color
 */
export function chamferBox(w, h, d, bevel = 0.003, opts = {}) {
  const M = new Mesher();
  const seg = opts.seg || [1, 1, 1];
  const at = opts.at || [0, 0, 0];
  const colourFn = opts.colour || null;
  const skip = opts.skip ? new Set(opts.skip) : null;
  const half = [w * 0.5, h * 0.5, d * 0.5];
  const b = Math.max(0, Math.min(bevel, half[0] * 0.45, half[1] * 0.45, half[2] * 0.45));
  const inner = [half[0] - b, half[1] - b, half[2] - b];
  const FACE_NAME = [['-x', '+x'], ['-y', '+y'], ['-z', '+z']];

  const P = [0, 0, 0];
  const N = [0, 0, 0];
  const push = () => {
    let r = 1;
    let g = 1;
    let bl = 1;
    if (colourFn) {
      const c = colourFn(P[0], P[1], P[2], N[0], N[1], N[2]);
      r = c[0]; g = c[1]; bl = c[2];
    }
    // Metre UVs, anchored in world space through `at`.
    const dom = Math.abs(N[0]) >= Math.abs(N[1]) && Math.abs(N[0]) >= Math.abs(N[2]) ? 0
      : Math.abs(N[1]) >= Math.abs(N[2]) ? 1 : 2;
    const [ua, va] = UV_AXES[dom];
    return M.vertex(P[0], P[1], P[2], N[0], N[1], N[2], P[ua] + at[ua], P[va] + at[va], r, g, bl);
  };

  // — the six faces —
  for (let a = 0; a < 3; a++) {
    const [ua, va] = UV_AXES[a];
    const nu = Math.max(1, seg[ua] | 0);
    const nv = Math.max(1, seg[va] | 0);
    for (let s = 0; s < 2; s++) {
      if (skip && skip.has(FACE_NAME[a][s])) continue;
      const sgn = s ? 1 : -1;
      N[0] = 0; N[1] = 0; N[2] = 0; N[a] = sgn;
      const grid = new Array((nu + 1) * (nv + 1));
      for (let j = 0; j <= nv; j++) {
        for (let i = 0; i <= nu; i++) {
          P[a] = sgn * half[a];
          P[ua] = -inner[ua] + 2 * inner[ua] * (i / nu);
          P[va] = -inner[va] + 2 * inner[va] * (j / nv);
          grid[j * (nu + 1) + i] = push();
        }
      }
      for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu; i++) {
          const i0 = grid[j * (nu + 1) + i];
          const i1 = grid[j * (nu + 1) + i + 1];
          const i2 = grid[(j + 1) * (nu + 1) + i + 1];
          const i3 = grid[(j + 1) * (nu + 1) + i];
          M.quad(i0, i1, i2, i3, N[0], N[1], N[2]);
        }
      }
    }
  }

  if (b <= 1e-6) return M.geometry(opts.name || 'chamferBox');

  // — the twelve edge chamfers —
  const INV = Math.SQRT1_2;
  for (let a1 = 0; a1 < 3; a1++) {
    for (let a2 = a1 + 1; a2 < 3; a2++) {
      const c = 3 - a1 - a2; // the free axis
      const nc = Math.max(1, seg[c] | 0);
      for (let s1 = -1; s1 <= 1; s1 += 2) {
        for (let s2 = -1; s2 <= 1; s2 += 2) {
          N[0] = 0; N[1] = 0; N[2] = 0;
          N[a1] = s1 * INV;
          N[a2] = s2 * INV;
          const rowA = [];
          const rowB = [];
          for (let t = 0; t <= nc; t++) {
            const cc = -inner[c] + 2 * inner[c] * (t / nc);
            P[c] = cc; P[a1] = s1 * half[a1]; P[a2] = s2 * inner[a2];
            rowA.push(push());
            P[c] = cc; P[a1] = s1 * inner[a1]; P[a2] = s2 * half[a2];
            rowB.push(push());
          }
          for (let t = 0; t < nc; t++) {
            M.quad(rowA[t], rowA[t + 1], rowB[t + 1], rowB[t], N[0], N[1], N[2]);
          }
        }
      }
    }
  }

  // — the eight corner facets —
  const K = 1 / Math.sqrt(3);
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        N[0] = sx * K; N[1] = sy * K; N[2] = sz * K;
        P[0] = sx * half[0]; P[1] = sy * inner[1]; P[2] = sz * inner[2];
        const ax = push();
        P[0] = sx * inner[0]; P[1] = sy * half[1]; P[2] = sz * inner[2];
        const ay = push();
        P[0] = sx * inner[0]; P[1] = sy * inner[1]; P[2] = sz * half[2];
        const az = push();
        M.triFacing(ax, ay, az, N[0], N[1], N[2]);
      }
    }
  }

  return M.geometry(opts.name || 'chamferBox');
}

// ── primitive 2: the parametric surface ───────────────────────────────────────────────────────

/**
 * A subdivided parametric patch with smooth normals — floors, ceilings, curtains, ground planes.
 *
 * `fn(u, v, out)` receives u, v in [0,1] and fills `out` with:
 *   out.x/y/z   world position
 *   out.u/v     texture coordinate in metres (defaults to the previous vertex's, so set it)
 *   out.r/g/b   vertex colour (defaults to 1)
 *
 * @param {number} segU,segV quad counts
 * @param {(u:number,v:number,out:object)=>void} fn
 * @param {object} [opts] { name, flip } — `flip` reverses the winding (a ceiling faces down)
 */
export function paramSurface(segU, segV, fn, opts = {}) {
  const nu = Math.max(1, segU | 0);
  const nv = Math.max(1, segV | 0);
  const count = (nu + 1) * (nv + 1);
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const col = new Float32Array(count * 3);
  const idx = new Uint32Array(nu * nv * 6);
  const out = { x: 0, y: 0, z: 0, u: 0, v: 0, r: 1, g: 1, b: 1 };

  let k = 0;
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      out.r = 1; out.g = 1; out.b = 1;
      fn(i / nu, j / nv, out);
      pos[k * 3] = out.x; pos[k * 3 + 1] = out.y; pos[k * 3 + 2] = out.z;
      uv[k * 2] = out.u; uv[k * 2 + 1] = out.v;
      col[k * 3] = out.r; col[k * 3 + 1] = out.g; col[k * 3 + 2] = out.b;
      k++;
    }
  }

  let t = 0;
  const flip = !!opts.flip;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i;
      const b = a + 1;
      const c = a + nu + 2;
      const d = a + nu + 1;
      if (flip) {
        idx[t++] = a; idx[t++] = c; idx[t++] = b;
        idx[t++] = a; idx[t++] = d; idx[t++] = c;
      } else {
        idx[t++] = a; idx[t++] = b; idx[t++] = c;
        idx[t++] = a; idx[t++] = c; idx[t++] = d;
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.name = opts.name || 'paramSurface';
  return g;
}

// ── primitive 3: the extruded profile ─────────────────────────────────────────────────────────

/** Signed area of a 2D polygon; positive means counter-clockwise. */
function signedArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a * 0.5;
}

/**
 * Cut every corner of a closed polygon by `r`, so an extruded frame profile has no razor arrises
 * either. Concave corners are cut too — on a mullion that is exactly the little fillet a real
 * extrusion has where the web meets the flange.
 */
export function chamferProfile(pts, r) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const dxa = prev.x - p.x;
    const dya = prev.y - p.y;
    const la = Math.hypot(dxa, dya) || 1;
    const dxb = next.x - p.x;
    const dyb = next.y - p.y;
    const lb = Math.hypot(dxb, dyb) || 1;
    const ra = Math.min(r, la * 0.4);
    const rb = Math.min(r, lb * 0.4);
    out.push({ x: p.x + (dxa / la) * ra, y: p.y + (dya / la) * ra });
    out.push({ x: p.x + (dxb / lb) * rb, y: p.y + (dyb / lb) * rb });
  }
  return out;
}

/** Reverse a geometry's triangle winding and its normals. Used after a mirroring transform. */
export function flipWinding(geo) {
  const idx = geo.index.array;
  for (let i = 0; i < idx.length; i += 3) {
    const t = idx[i + 1];
    idx[i + 1] = idx[i + 2];
    idx[i + 2] = t;
  }
  const n = geo.attributes.normal.array;
  for (let i = 0; i < n.length; i++) n[i] = -n[i];
  geo.index.needsUpdate = true;
  geo.attributes.normal.needsUpdate = true;
  return geo;
}

// Axis remaps for `prism`. Both non-default cases send the profile's local +y to world +Z, so a
// window jamb and a window head are authored in the same "width across, depth toward the room"
// convention and neither ends up inside out. 'y' is a mirror (det = -1) and gets its winding fixed.
const PRISM_AXIS = {
  x: { m: [0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1], flip: false },
  y: { m: [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1], flip: true },
};

/**
 * Extrude a closed 2D polygon (XY) along Z, centred on the origin.
 * Side normals come from the edge directions, so a chamfered profile gets its highlight lines.
 *
 * @param {{x:number,y:number}[]} profile closed polygon, any winding
 * @param {number} length extrusion length along Z
 * @param {object} [opts] { caps = true, colour, name, axis:'x'|'y'|'z' }
 *   axis 'x' — the member runs along world X (a window head): local x is world Y, local y world Z
 *   axis 'y' — the member runs along world Y (a jamb):        local x is world X, local y world Z
 */
export function prism(profile, length, opts = {}) {
  const pts = signedArea(profile) < 0 ? profile.slice().reverse() : profile.slice();
  const n = pts.length;
  const hz = length * 0.5;
  const caps = opts.caps !== false;
  const colourFn = opts.colour || null;
  const M = new Mesher();

  // Arc length along the profile gives a continuous u across the whole section.
  const arc = new Float32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    arc[i + 1] = arc[i] + Math.hypot(q.x - p.x, q.y - p.y);
  }

  const colOf = (x, y, z, nx, ny, nz) => (colourFn ? colourFn(x, y, z, nx, ny, nz) : null);

  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const l = Math.hypot(dx, dy);
    if (l < 1e-9) continue;
    const nx = dy / l;
    const ny = -dx / l;
    const c0 = colOf(p.x, p.y, -hz, nx, ny, 0) || [1, 1, 1];
    const c1 = colOf(q.x, q.y, hz, nx, ny, 0) || [1, 1, 1];
    const a = M.vertex(p.x, p.y, -hz, nx, ny, 0, arc[i], -hz, c0[0], c0[1], c0[2]);
    const b = M.vertex(q.x, q.y, -hz, nx, ny, 0, arc[i + 1], -hz, c1[0], c1[1], c1[2]);
    const c = M.vertex(q.x, q.y, hz, nx, ny, 0, arc[i + 1], hz, c1[0], c1[1], c1[2]);
    const dd = M.vertex(p.x, p.y, hz, nx, ny, 0, arc[i], hz, c0[0], c0[1], c0[2]);
    M.quad(a, b, c, dd, nx, ny, 0);
  }

  if (caps) {
    const contour = pts.map((p) => new THREE.Vector2(p.x, p.y));
    let faces = [];
    try {
      faces = THREE.ShapeUtils.triangulateShape(contour, []);
    } catch {
      faces = [];
    }
    for (let s = 0; s < 2; s++) {
      const z = s ? hz : -hz;
      const nz = s ? 1 : -1;
      const base = [];
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        const c = colOf(p.x, p.y, z, 0, 0, nz) || [1, 1, 1];
        base.push(M.vertex(p.x, p.y, z, 0, 0, nz, p.x, p.y, c[0], c[1], c[2]));
      }
      for (const f of faces) M.triFacing(base[f[0]], base[f[1]], base[f[2]], 0, 0, nz);
    }
  }

  const geo = M.geometry(opts.name || 'prism');
  const remap = opts.axis && PRISM_AXIS[opts.axis];
  if (remap) {
    geo.applyMatrix4(new THREE.Matrix4().fromArray(remap.m).transpose());
    if (remap.flip) flipWinding(geo);
  }
  return geo;
}

// ── profile builders ──────────────────────────────────────────────────────────────────────────

/** A rectangle, centred, with the corners cut. The workhorse frame section. */
export function rectProfile(w, h, chamfer = 0.002) {
  const hw = w * 0.5;
  const hh = h * 0.5;
  return chamferProfile([
    { x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh },
  ], chamfer);
}

/**
 * An L-section: a `web` deep and `flange` wide leg, thickness `t`, corner at the origin.
 * Used for the glazing jambs, where the leg you see from the room is the flange and the leg
 * that disappears into the reveal is the web.
 */
export function lProfile(flange, web, t, chamfer = 0.0015) {
  return chamferProfile([
    { x: 0, y: 0 },
    { x: flange, y: 0 },
    { x: flange, y: t },
    { x: t, y: t },
    { x: t, y: web },
    { x: 0, y: web },
  ], chamfer);
}

/**
 * A T-section mullion: a face flange `flange` wide and `ft` thick, with a web `web` deep and
 * `wt` thick running back into the glazing line. Centred on the origin in x.
 */
export function tProfile(flange, ft, web, wt, chamfer = 0.0015) {
  const hf = flange * 0.5;
  const hw = wt * 0.5;
  return chamferProfile([
    { x: -hf, y: 0 }, { x: hf, y: 0 }, { x: hf, y: ft },
    { x: hw, y: ft }, { x: hw, y: web }, { x: -hw, y: web }, { x: -hf, y: ft },
  ], chamfer);
}

/**
 * The section of a steel column radiator: `count` circular tubes of radius `r` on a `gap` pitch,
 * overlapping into a scalloped sausage. Adjacent circles meet at ±acos(gap / 2r) from the axis,
 * so each interior tube only shows the arc between those two angles and the union boundary comes
 * out exact — which is what gives a column radiator its unmistakable rippled silhouette.
 */
export function tubeChainProfile(count, r, gap, arcSteps = 5) {
  const a = Math.acos(Math.min(0.999, gap / (2 * r)));
  const z0 = -((count - 1) * gap) * 0.5;
  const pts = [];
  const emit = (from, to, i) => {
    const steps = Math.max(2, Math.round((Math.abs(from - to) / Math.PI) * arcSteps * 2));
    for (let s = 0; s <= steps; s++) {
      const phi = from + (to - from) * (s / steps);
      pts.push({ x: r * Math.sin(phi), y: z0 + i * gap + r * Math.cos(phi) });
    }
  };
  for (let i = 0; i < count; i++) {
    emit(i === 0 ? Math.PI : Math.PI - a, i === count - 1 ? 0 : a, i);
  }
  for (let i = count - 1; i >= 0; i--) {
    emit(i === count - 1 ? 0 : -a, i === 0 ? -Math.PI : -(Math.PI - a), i);
  }
  // The walk closes on itself; drop the duplicate seam vertices.
  return pts.filter((p, i) => {
    if (i === 0) return true;
    const q = pts[i - 1];
    return Math.hypot(p.x - q.x, p.y - q.y) > 1e-6;
  });
}

// ── primitive 4: tapered tubes (branches, cords, balusters) ───────────────────────────────────

/**
 * A tapered tube through a polyline. Used for the bare winter trees and the radiator pipework.
 * Normals are the radial direction, which is exact for a cylinder and close enough for a taper.
 *
 * @param {THREE.Vector3[]} pts spine
 * @param {number[]} radii per-point radius
 * @param {number} sides radial segments
 */
export function tube(pts, radii, sides = 6, opts = {}) {
  const M = new Mesher();
  const n = pts.length;
  if (n < 2) return M.geometry('tube.empty');
  const colourFn = opts.colour || null;
  const up = new THREE.Vector3(0, 1, 0);
  const alt = new THREE.Vector3(1, 0, 0);
  const tangent = new THREE.Vector3();
  const nrmA = new THREE.Vector3();
  const nrmB = new THREE.Vector3();
  const rings = [];
  let run = 0;

  for (let i = 0; i < n; i++) {
    if (i === 0) tangent.copy(pts[1]).sub(pts[0]);
    else if (i === n - 1) tangent.copy(pts[n - 1]).sub(pts[n - 2]);
    else tangent.copy(pts[i + 1]).sub(pts[i - 1]);
    if (i > 0) run += pts[i].distanceTo(pts[i - 1]);
    tangent.normalize();
    nrmA.copy(Math.abs(tangent.y) > 0.92 ? alt : up).cross(tangent).normalize();
    nrmB.crossVectors(tangent, nrmA).normalize();
    const ring = [];
    for (let s = 0; s < sides; s++) {
      const th = (s / sides) * Math.PI * 2;
      const cx = Math.cos(th);
      const sy = Math.sin(th);
      const dx = nrmA.x * cx + nrmB.x * sy;
      const dy = nrmA.y * cx + nrmB.y * sy;
      const dz = nrmA.z * cx + nrmB.z * sy;
      const px = pts[i].x + dx * radii[i];
      const py = pts[i].y + dy * radii[i];
      const pz = pts[i].z + dz * radii[i];
      const c = colourFn ? colourFn(px, py, pz, dx, dy, dz) : [1, 1, 1];
      ring.push(M.vertex(px, py, pz, dx, dy, dz, (s / sides) * (radii[i] * 6.283), run, c[0], c[1], c[2]));
    }
    rings.push(ring);
  }

  for (let i = 0; i < n - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides;
      const a = rings[i][s];
      const b = rings[i][s2];
      const c = rings[i + 1][s2];
      const d = rings[i + 1][s];
      const p = M.pos;
      M.quad(a, b, c, d,
        p[a * 3] - pts[i].x, p[a * 3 + 1] - pts[i].y, p[a * 3 + 2] - pts[i].z);
    }
  }
  return M.geometry(opts.name || 'tube');
}

// ── the batcher ───────────────────────────────────────────────────────────────────────────────

/** Make sure a geometry from a THREE primitive can be merged with ours. */
export function normaliseGeometry(geo, rgb = [1, 1, 1]) {
  if (!geo.getAttribute('uv')) {
    const n = geo.getAttribute('position').count;
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  }
  if (!geo.getAttribute('color')) {
    const n = geo.getAttribute('position').count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = rgb[0]; arr[i * 3 + 1] = rgb[1]; arr[i * 3 + 2] = rgb[2];
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  }
  if (!geo.index) {
    const n = geo.getAttribute('position').count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  // Merging is picky: strip anything the other geometries do not carry.
  for (const key of Object.keys(geo.attributes)) {
    if (key !== 'position' && key !== 'normal' && key !== 'uv' && key !== 'color') {
      geo.deleteAttribute(key);
    }
  }
  return geo;
}

const _mat4 = new THREE.Matrix4();
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _pos = new THREE.Vector3();

/**
 * Accumulate geometry per material and emit one merged mesh per material at flush time.
 * The whole glazing assembly — frame, four mullions, two sliding leaves, the track and the
 * handle — comes out of this as a single draw call.
 */
export function createBatch(ctx, group) {
  const bins = new Map();

  function key(material, cast, recv, tag) {
    return `${material.uuid}|${cast ? 1 : 0}${recv ? 1 : 0}|${tag || ''}`;
  }

  return {
    /**
     * @param {THREE.BufferGeometry} geo consumed — do not reuse it after this call
     * @param {THREE.Material} material
     * @param {object} [t] { pos:[x,y,z], rot:[x,y,z], scale:[x,y,z], cast, recv, tag }
     *   `tag` forces the geometry into its own bin and therefore its own mesh, which is how the
     *   back wall stays separately hideable for the cutaway in the hero framing.
     */
    add(geo, material, t = {}) {
      if (!geo || !material) return;
      normaliseGeometry(geo);
      if (t.pos || t.rot || t.scale) {
        _pos.set(t.pos ? t.pos[0] : 0, t.pos ? t.pos[1] : 0, t.pos ? t.pos[2] : 0);
        _euler.set(t.rot ? t.rot[0] : 0, t.rot ? t.rot[1] : 0, t.rot ? t.rot[2] : 0);
        _quat.setFromEuler(_euler);
        _scale.set(t.scale ? t.scale[0] : 1, t.scale ? t.scale[1] : 1, t.scale ? t.scale[2] : 1);
        _mat4.compose(_pos, _quat, _scale);
        geo.applyMatrix4(_mat4);
      }
      const cast = t.cast !== false;
      const recv = t.recv !== false;
      const k = key(material, cast, recv, t.tag);
      let bin = bins.get(k);
      if (!bin) {
        bin = { material, cast, recv, tag: t.tag || null, geos: [] };
        bins.set(k, bin);
      }
      bin.geos.push(geo);
    },

    /** Merge every bin, add the meshes to `group`, return them. */
    flush(prefix = 'room') {
      const meshes = [];
      for (const bin of bins.values()) {
        let geo = null;
        if (bin.geos.length === 1) {
          geo = bin.geos[0];
        } else {
          geo = mergeGeometries(bin.geos, false);
          if (!geo) {
            // Never lose geometry to a merge failure — fall back to one mesh per piece.
            console.warn('[room] geometry merge failed; falling back to unmerged meshes');
            for (const g of bin.geos) {
              const m = new THREE.Mesh(g, bin.material);
              m.castShadow = bin.cast;
              m.receiveShadow = bin.recv;
              if (bin.tag) m.userData.tag = bin.tag;
              group.add(m);
              meshes.push(m);
              ctx.track?.(g);
            }
            continue;
          }
          for (const g of bin.geos) g.dispose();
        }
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, bin.material);
        mesh.name = `${prefix}.${bin.tag ? `${bin.tag}.` : ''}${bin.material.name || 'mat'}`;
        if (bin.tag) mesh.userData.tag = bin.tag;
        mesh.castShadow = bin.cast;
        mesh.receiveShadow = bin.recv;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        group.add(mesh);
        meshes.push(mesh);
        ctx.track?.(geo);
      }
      bins.clear();
      return meshes;
    },
  };
}

// ── materials ─────────────────────────────────────────────────────────────────────────────────

/**
 * The one way this module asks for a material.
 *
 * Every geometry above writes UVs in metres, so the repeat we want is 1 / tileMetres — then a
 * 6.8 m wall and a 0.15 m reveal share one continuous grain automatically. `vertexColors` is on
 * for everything so the baked corner occlusion and dirt gradients cost nothing at runtime.
 *
 * @param {object} ctx
 * @param {string} name a canonical CONTRACTS §10 material name
 * @param {object} [extra] any material property override, plus `tint` for the albedo multiplier
 */
export function surfaceMaterial(ctx, name, extra = {}) {
  const base = ctx.materials.get(name);
  const opts = { vertexColors: true, ...extra };
  const tint = opts.tint;
  delete opts.tint;
  const tm = base.userData && base.userData.tileMetres;
  if (tm && !opts.uvRepeat) opts.uvRepeat = [1 / tm[0], 1 / tm[1]];
  // With no explicit tint, hand `tinted()` back the recipe's OWN albedo multiplier. Passing white
  // instead — which is what "no tint" naïvely means — would silently discard it, and since every
  // recipe carries one (floor.wood is 0x9d7f5f over a honey plank map, brick.exterior is 0xa8674c
  // over grey brick) that single line would bleach half the room. Round-tripping through
  // getHex()/setHex() is exact to 8 bits and safeColour() is idempotent on it.
  const hex = tint !== undefined ? tint
    : (base.color && base.color.isColor ? base.color.getHex() : null);
  return ctx.materials.tinted(name, hex, opts);
}

/** Linear interpolation helper used all over the shell. */
export const mix = (a, b, t) => a + (b - a) * t;
