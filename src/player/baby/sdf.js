// OPERATION NAPTIME — BABY — signed-distance toolkit + a surface-nets mesher.
//
// Why an SDF at all. A baby is the one thing in this room that cannot be built out of lathes and
// boxes: it is a single continuous blob of fat with no hard edges anywhere, and every seam between
// two primitives would read instantly as CG. So the body is authored as a field — twenty-odd
// ellipsoids, tapered capsules and tori combined with polynomial smooth-min — and then polygonised.
// Smooth-min IS the blend: the fillet between the thigh and the belly is exactly the shape a real
// nappy-clad hip has, and it costs nothing but a few flops.
//
// The mesher is naive surface nets (dual contouring without the QEF): one vertex per sign-changing
// cell placed at the average of its edge crossings, one quad per sign-changing grid edge. It gives
// smoother, more even topology than marching cubes at the same resolution and needs no 256-entry
// tables. Normals are taken analytically from the gradient of the field rather than from the
// facets, which is what keeps a 8.5 mm voxel grid from looking faceted.
//
// Two details that matter for the render:
//  · Output is NON-INDEXED with per-face cubic-projection UVs. A per-vertex projection would smear
//    any triangle that straddles two projection axes; per-face it is a hard seam in the pore
//    detail only, which is invisible, and three derives the tangent frame per pixel from the UV
//    derivatives so the normal map still works.
//  · Vertices are displaced along the analytic normal by two octaves of value noise AFTER
//    extraction. Amplitude 1–2 mm at a 60 mm wavelength: a 2° normal error, far below what is
//    visible, and it destroys the machine-perfect symmetry that makes procedural characters read
//    as procedural.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ─────────────────────────────────────────────────────────────── combinators ──

/** Polynomial smooth minimum (iq). k is the blend width in metres. */
export function smin(a, b, k) {
  if (k <= 0) return a < b ? a : b;
  const h = clamp(k - Math.abs(a - b), 0, k) / k;
  return (a < b ? a : b) - h * h * k * 0.25;
}

/** Smooth maximum — the dual of smin, used for intersections. */
export function smax(a, b, k) {
  return -smin(-a, -b, k);
}

/** Smooth subtraction: carve `cut` out of `d`. */
export function ssub(d, cut, k) {
  return -smin(-d, cut, k);
}

// ──────────────────────────────────────────────────────────────── primitives ──

export function sdSphere(px, py, pz, cx, cy, cz, r) {
  const x = px - cx;
  const y = py - cy;
  const z = pz - cz;
  return Math.sqrt(x * x + y * y + z * z) - r;
}

/** iq's ellipsoid bound — not an exact distance, but conservative and stable under smin. */
export function sdEllipsoid(px, py, pz, cx, cy, cz, rx, ry, rz) {
  const x = (px - cx) / rx;
  const y = (py - cy) / ry;
  const z = (pz - cz) / rz;
  const k0 = Math.sqrt(x * x + y * y + z * z);
  if (k0 < 1e-9) return -Math.min(rx, Math.min(ry, rz));
  const ax = x / rx;
  const ay = y / ry;
  const az = z / rz;
  const k1 = Math.sqrt(ax * ax + ay * ay + az * az);
  return (k0 * (k0 - 1.0)) / k1;
}

/** Distance to a segment, minus r — i.e. a capsule. */
export function sdCapsule(px, py, pz, ax, ay, az, bx, by, bz, r) {
  const pax = px - ax;
  const pay = py - ay;
  const paz = pz - az;
  const bax = bx - ax;
  const bay = by - ay;
  const baz = bz - az;
  const dd = bax * bax + bay * bay + baz * baz;
  let h = dd > 1e-12 ? (pax * bax + pay * bay + paz * baz) / dd : 0;
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  const dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}

/**
 * Tapered capsule (iq's round cone): radius r1 at a, r2 at b, with a correct conical side rather
 * than a linear radius lerp. This is the workhorse — every limb segment is one of these.
 */
export function sdRoundCone(px, py, pz, ax, ay, az, bx, by, bz, r1, r2) {
  const bax = bx - ax;
  const bay = by - ay;
  const baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  if (l2 < 1e-12) return sdSphere(px, py, pz, ax, ay, az, Math.max(r1, r2));
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1.0 / l2;

  const pax = px - ax;
  const pay = py - ay;
  const paz = pz - az;

  const y = pax * bax + pay * bay + paz * baz;
  const z = y - l2;

  const qx = pax * l2 - bax * y;
  const qy = pay * l2 - bay * y;
  const qz = paz * l2 - baz * y;
  const x2 = qx * qx + qy * qy + qz * qz;
  const y2 = y * y * l2;
  const z2 = z * z * l2;

  const k = (rr < 0 ? -1 : rr > 0 ? 1 : 0) * rr * rr * x2;
  if ((z < 0 ? -1 : 1) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if ((y < 0 ? -1 : 1) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

/** Axis-aligned rounded box. `r` is the corner radius and is already subtracted from the half-size. */
export function sdRoundBox(px, py, pz, cx, cy, cz, hx, hy, hz, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  const qz = Math.abs(pz - cz) - (hz - r);
  const mx = qx > 0 ? qx : 0;
  const my = qy > 0 ? qy : 0;
  const mz = qz > 0 ? qz : 0;
  const outside = Math.sqrt(mx * mx + my * my + mz * mz);
  const inside = Math.min(Math.max(qx, Math.max(qy, qz)), 0);
  return outside + inside - r;
}

/**
 * A torus around an arbitrary axis. Every crease on this baby — the wrist band, the thigh roll,
 * the elastic on the nappy — is one of these, either subtracted (a groove) or unioned (a bulge).
 * `ux,uy,uz` must be unit length.
 */
export function sdTorusAxis(px, py, pz, cx, cy, cz, ux, uy, uz, R, r) {
  const dx = px - cx;
  const dy = py - cy;
  const dz = pz - cz;
  const h = dx * ux + dy * uy + dz * uz;
  const rx = dx - ux * h;
  const ry = dy - uy * h;
  const rz = dz - uz * h;
  const radial = Math.sqrt(rx * rx + ry * ry + rz * rz) - R;
  return Math.sqrt(radial * radial + h * h) - r;
}

/** Signed distance to a plane through `c` with unit normal `n` (positive on the +n side). */
export function sdPlane(px, py, pz, cx, cy, cz, nx, ny, nz) {
  return (px - cx) * nx + (py - cy) * ny + (pz - cz) * nz;
}

// ───────────────────────────────────────────────────────────────────── noise ──

/**
 * Deterministic trilinear value noise. Integer-hash based, so there is no permutation table to
 * seed and two runs with the same seed are bit-identical.
 */
export function makeNoise3(seed = 1) {
  const S = (seed >>> 0) || 1;
  function h(ix, iy, iz) {
    let n = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(iz | 0, 1274126177) ^ S;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n ^= n >>> 16;
    return (n >>> 0) / 4294967296;
  }
  return function noise(x, y, z) {
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const fz = Math.floor(z);
    const tx = x - fx;
    const ty = y - fy;
    const tz = z - fz;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const sz = tz * tz * (3 - 2 * tz);
    const c000 = h(fx, fy, fz);
    const c100 = h(fx + 1, fy, fz);
    const c010 = h(fx, fy + 1, fz);
    const c110 = h(fx + 1, fy + 1, fz);
    const c001 = h(fx, fy, fz + 1);
    const c101 = h(fx + 1, fy, fz + 1);
    const c011 = h(fx, fy + 1, fz + 1);
    const c111 = h(fx + 1, fy + 1, fz + 1);
    const x00 = c000 + (c100 - c000) * sx;
    const x10 = c010 + (c110 - c010) * sx;
    const x01 = c001 + (c101 - c001) * sx;
    const x11 = c011 + (c111 - c011) * sx;
    const y0 = x00 + (x10 - x00) * sy;
    const y1 = x01 + (x11 - x01) * sy;
    return y0 + (y1 - y0) * sz;
  };
}

// ─────────────────────────────────────────────────────────────── surface nets ──

// Corner c of a cell: dx = c&1, dy = (c>>1)&1, dz = (c>>2)&1.
const CORNER_DX = [0, 1, 0, 1, 0, 1, 0, 1];
const CORNER_DY = [0, 0, 1, 1, 0, 0, 1, 1];
const CORNER_DZ = [0, 0, 0, 0, 1, 1, 1, 1];
// The 12 cell edges as corner pairs.
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],   // along +x
  [0, 2], [1, 3], [4, 6], [5, 7],   // along +y
  [0, 4], [1, 5], [2, 6], [3, 7],   // along +z
];

/**
 * Polygonise `field` over an axis-aligned box.
 * @returns {{verts:Float32Array, quads:Int32Array, vertCount:number, quadCount:number, voxel:number}}
 */
export function polygonise(field, min, max, voxel) {
  const nx = Math.max(1, Math.ceil((max[0] - min[0]) / voxel));
  const ny = Math.max(1, Math.ceil((max[1] - min[1]) / voxel));
  const nz = Math.max(1, Math.ceil((max[2] - min[2]) / voxel));
  const cx = nx + 1;
  const cy = ny + 1;
  const cz = nz + 1;

  const vals = new Float32Array(cx * cy * cz);
  for (let k = 0; k < cz; k++) {
    const z = min[2] + k * voxel;
    for (let j = 0; j < cy; j++) {
      const y = min[1] + j * voxel;
      let idx = cx * (j + cy * k);
      for (let i = 0; i < cx; i++, idx++) {
        vals[idx] = field(min[0] + i * voxel, y, z);
      }
    }
  }

  const cellVert = new Int32Array(nx * ny * nz).fill(-1);
  const verts = [];
  const cv = new Float64Array(8);

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = vals[(i + CORNER_DX[c]) + cx * ((j + CORNER_DY[c]) + cy * (k + CORNER_DZ[c]))];
          cv[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;

        let ax = 0;
        let ay = 0;
        let az = 0;
        let n = 0;
        for (let e = 0; e < 12; e++) {
          const a = EDGES[e][0];
          const b = EDGES[e][1];
          const va = cv[a];
          const vb = cv[b];
          if ((va < 0) === (vb < 0)) continue;
          const denom = va - vb;
          const t = Math.abs(denom) < 1e-12 ? 0.5 : clamp(va / denom, 0, 1);
          ax += CORNER_DX[a] + (CORNER_DX[b] - CORNER_DX[a]) * t;
          ay += CORNER_DY[a] + (CORNER_DY[b] - CORNER_DY[a]) * t;
          az += CORNER_DZ[a] + (CORNER_DZ[b] - CORNER_DZ[a]) * t;
          n++;
        }
        if (!n) continue;
        const inv = 1 / n;
        cellVert[i + nx * (j + ny * k)] = verts.length / 3;
        verts.push(
          min[0] + (i + ax * inv) * voxel,
          min[1] + (j + ay * inv) * voxel,
          min[2] + (k + az * inv) * voxel,
        );
      }
    }
  }

  // One quad per sign-changing grid edge, wound so the front face points out of the surface.
  const quads = [];
  const cellAt = (i, j, k) => cellVert[i + nx * (j + ny * k)];
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const v0 = vals[i + cx * (j + cy * k)];
        const in0 = v0 < 0;
        // +x edge: the four cells around it are offset in (y, z).
        if (i < nx && j > 0 && k > 0) {
          const v1 = vals[i + 1 + cx * (j + cy * k)];
          if (in0 !== (v1 < 0)) {
            const a = cellAt(i, j, k);
            const b = cellAt(i, j - 1, k);
            const c = cellAt(i, j - 1, k - 1);
            const d = cellAt(i, j, k - 1);
            if (a >= 0 && b >= 0 && c >= 0 && d >= 0) {
              if (in0) quads.push(a, b, c, d);
              else quads.push(d, c, b, a);
            }
          }
        }
        // +y edge: cells offset in (z, x).
        if (j < ny && i > 0 && k > 0) {
          const v1 = vals[i + cx * (j + 1 + cy * k)];
          if (in0 !== (v1 < 0)) {
            const a = cellAt(i, j, k);
            const b = cellAt(i, j, k - 1);
            const c = cellAt(i - 1, j, k - 1);
            const d = cellAt(i - 1, j, k);
            if (a >= 0 && b >= 0 && c >= 0 && d >= 0) {
              if (in0) quads.push(a, b, c, d);
              else quads.push(d, c, b, a);
            }
          }
        }
        // +z edge: cells offset in (x, y).
        if (k < nz && i > 0 && j > 0) {
          const v1 = vals[i + cx * (j + cy * (k + 1))];
          if (in0 !== (v1 < 0)) {
            const a = cellAt(i, j, k);
            const b = cellAt(i - 1, j, k);
            const c = cellAt(i - 1, j - 1, k);
            const d = cellAt(i, j - 1, k);
            if (a >= 0 && b >= 0 && c >= 0 && d >= 0) {
              if (in0) quads.push(a, b, c, d);
              else quads.push(d, c, b, a);
            }
          }
        }
      }
    }
  }

  return {
    verts: new Float32Array(verts),
    quads: new Int32Array(quads),
    vertCount: verts.length / 3,
    quadCount: quads.length / 4,
    voxel,
  };
}

/**
 * Turn a polygonised field into renderable triangle soup.
 *
 * @param {object} mesh          the result of polygonise()
 * @param {object} opts
 * @param {(x,y,z)=>number} opts.field       the same field, for analytic normals
 * @param {number} [opts.extent]             metres of surface per UV unit (see materials §10)
 * @param {(x,y,z,nx,ny,nz)=>number} [opts.displace]  outward displacement in metres
 * @param {(x,y,z)=>boolean} [opts.filter]   keep only quads whose centre passes
 * @param {(x,y,z,nx,ny,nz)=>void} [opts.each] called once per kept source vertex
 * @returns {{position:Float32Array, normal:Float32Array, uv:Float32Array,
 *            source:Uint32Array, count:number, srcPos:Float32Array, srcNrm:Float32Array}}
 */
export function tessellate(mesh, opts = {}) {
  const { field, extent = 0.45, displace = null, filter = null } = opts;
  const vc = mesh.vertCount;
  const eps = mesh.voxel * 0.34;
  const srcPos = new Float32Array(vc * 3);
  const srcNrm = new Float32Array(vc * 3);

  for (let v = 0; v < vc; v++) {
    const x = mesh.verts[v * 3];
    const y = mesh.verts[v * 3 + 1];
    const z = mesh.verts[v * 3 + 2];
    let nx = field(x + eps, y, z) - field(x - eps, y, z);
    let ny = field(x, y + eps, z) - field(x, y - eps, z);
    let nz = field(x, y, z + eps) - field(x, y, z - eps);
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    srcNrm[v * 3] = nx;
    srcNrm[v * 3 + 1] = ny;
    srcNrm[v * 3 + 2] = nz;
    const d = displace ? displace(x, y, z, nx, ny, nz) : 0;
    srcPos[v * 3] = x + nx * d;
    srcPos[v * 3 + 1] = y + ny * d;
    srcPos[v * 3 + 2] = z + nz * d;
  }

  // Which quads survive the filter?
  const keep = [];
  for (let q = 0; q < mesh.quadCount; q++) {
    if (filter) {
      let cxs = 0;
      let cys = 0;
      let czs = 0;
      for (let c = 0; c < 4; c++) {
        const v = mesh.quads[q * 4 + c];
        cxs += srcPos[v * 3];
        cys += srcPos[v * 3 + 1];
        czs += srcPos[v * 3 + 2];
      }
      if (!filter(cxs * 0.25, cys * 0.25, czs * 0.25)) continue;
    }
    keep.push(q);
  }

  const triCount = keep.length * 2;
  const position = new Float32Array(triCount * 9);
  const normal = new Float32Array(triCount * 9);
  const uv = new Float32Array(triCount * 6);
  const source = new Uint32Array(triCount * 3);
  const inv = 1 / Math.max(1e-4, extent);
  const TRI = [0, 1, 2, 0, 2, 3];
  let o3 = 0;
  let o2 = 0;
  let os = 0;

  for (let n = 0; n < keep.length; n++) {
    const q = keep[n];
    for (let t = 0; t < 2; t++) {
      // Face normal, for the cubic projection axis.
      let fx = 0;
      let fy = 0;
      let fz = 0;
      for (let c = 0; c < 3; c++) {
        const v = mesh.quads[q * 4 + TRI[t * 3 + c]];
        fx += srcNrm[v * 3];
        fy += srcNrm[v * 3 + 1];
        fz += srcNrm[v * 3 + 2];
      }
      const ax = Math.abs(fx);
      const ay = Math.abs(fy);
      const az = Math.abs(fz);
      const axis = ax > ay && ax > az ? 0 : ay > az ? 1 : 2;
      for (let c = 0; c < 3; c++) {
        const v = mesh.quads[q * 4 + TRI[t * 3 + c]];
        const px = srcPos[v * 3];
        const py = srcPos[v * 3 + 1];
        const pz = srcPos[v * 3 + 2];
        position[o3] = px;
        position[o3 + 1] = py;
        position[o3 + 2] = pz;
        normal[o3] = srcNrm[v * 3];
        normal[o3 + 1] = srcNrm[v * 3 + 1];
        normal[o3 + 2] = srcNrm[v * 3 + 2];
        if (axis === 0) {
          uv[o2] = pz * inv;
          uv[o2 + 1] = py * inv;
        } else if (axis === 1) {
          uv[o2] = px * inv;
          uv[o2 + 1] = pz * inv;
        } else {
          uv[o2] = px * inv;
          uv[o2 + 1] = py * inv;
        }
        source[os] = v;
        o3 += 3;
        o2 += 2;
        os += 1;
      }
    }
  }

  return { position, normal, uv, source, count: triCount * 3, srcPos, srcNrm, vertCount: vc };
}

/**
 * Mirror triangle soup across x = 0, flipping the winding so the surface still faces outward.
 * Used for the second hand, the second foot and the second ear — the field is only ever evaluated
 * once and asymmetry is added afterwards by the noise displacement, which is not mirrored.
 */
export function mirrorX(soup) {
  const n = soup.count;
  const position = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const source = new Uint32Array(n);
  for (let t = 0; t < n; t += 3) {
    for (let c = 0; c < 3; c++) {
      const src = t + c;
      const dst = t + (2 - c); // reversed winding
      position[dst * 3] = -soup.position[src * 3];
      position[dst * 3 + 1] = soup.position[src * 3 + 1];
      position[dst * 3 + 2] = soup.position[src * 3 + 2];
      normal[dst * 3] = -soup.normal[src * 3];
      normal[dst * 3 + 1] = soup.normal[src * 3 + 1];
      normal[dst * 3 + 2] = soup.normal[src * 3 + 2];
      uv[dst * 2] = -soup.uv[src * 2];
      uv[dst * 2 + 1] = soup.uv[src * 2 + 1];
      source[dst] = soup.source[src];
    }
  }
  return { position, normal, uv, source, count: n, vertCount: soup.vertCount };
}

/** Concatenate triangle soups into one attribute set. */
export function joinSoups(list) {
  let n = 0;
  for (const s of list) n += s.count;
  const position = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  let o = 0;
  for (const s of list) {
    position.set(s.position.subarray(0, s.count * 3), o * 3);
    normal.set(s.normal.subarray(0, s.count * 3), o * 3);
    uv.set(s.uv.subarray(0, s.count * 2), o * 2);
    o += s.count;
  }
  return { position, normal, uv, count: n };
}
