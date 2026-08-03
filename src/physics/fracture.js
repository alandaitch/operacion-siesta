// PHYS · Voronoi fracture.
//
// When the vase goes off the shelf we need shards, not a puff of sprites. The maths here is the
// cheapest honest 3D Voronoi you can write: scatter N seed points inside the source bounding
// box, and for each seed build its cell as the intersection of half-spaces — the six box faces
// plus one perpendicular bisector against every other seed. A convex polyhedron defined purely
// by planes is turned back into vertices by brute force: solve every triple of planes for its
// intersection point (Cramer's rule) and keep the points that satisfy *all* the planes. With
// ~17 planes that is 680 tiny 3×3 solves per cell — microseconds, and it is exact, so every
// shard is genuinely convex and Rapier's convexHull never rejects it.
//
// Seeds are biased toward the impact point, so a vase struck low shatters into small pieces
// near the floor and big slabs up top. That asymmetry is what makes fracture read as physical
// rather than procedural.

import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';

/** Sum of three uniforms, mean 0, ~unit spread (matches core/rng.js gauss). */
function gaussLike(r) {
  return (r() + r() + r() - 1.5) * 1.1547;
}

/**
 * Scatter `count` seeds inside a box of half-extents `half`, optionally clustered near `focus`.
 * Seeds keep a minimum separation so we do not produce paper-thin slivers.
 */
export function scatterSeeds(half, count, r, focus = null, focusBias = 0.45) {
  const seeds = [];
  const minSep = Math.min(half.x, half.y, half.z) * 0.34;
  const minSep2 = minSep * minSep;
  const sigma = new THREE.Vector3(half.x * 0.42, half.y * 0.42, half.z * 0.42);

  for (let i = 0; i < count; i++) {
    let ok = false;
    let x = 0, y = 0, z = 0;
    for (let attempt = 0; attempt < 10 && !ok; attempt++) {
      if (focus && r() < focusBias) {
        x = focus.x + gaussLike(r) * sigma.x;
        y = focus.y + gaussLike(r) * sigma.y;
        z = focus.z + gaussLike(r) * sigma.z;
      } else {
        x = (r() * 2 - 1) * half.x * 0.90;
        y = (r() * 2 - 1) * half.y * 0.90;
        z = (r() * 2 - 1) * half.z * 0.90;
      }
      x = Math.max(-half.x * 0.97, Math.min(half.x * 0.97, x));
      y = Math.max(-half.y * 0.97, Math.min(half.y * 0.97, y));
      z = Math.max(-half.z * 0.97, Math.min(half.z * 0.97, z));
      ok = true;
      for (let j = 0; j < seeds.length; j++) {
        const s = seeds[j];
        const dx = s.x - x, dy = s.y - y, dz = s.z - z;
        if (dx * dx + dy * dy + dz * dz < minSep2) { ok = false; break; }
      }
    }
    seeds.push(new THREE.Vector3(x, y, z));
  }
  return seeds;
}

/**
 * Voronoi cells of `seeds` clipped to the box [-half, +half].
 * Returns [{ center: Vector3, points: Vector3[] (relative to center), volume: number }].
 * Cells that collapse to fewer than 4 non-coplanar points are dropped.
 */
export function voronoiCells(half, seeds) {
  const scale = Math.max(half.x, half.y, half.z);
  const eps = 1e-6 + scale * 2e-4;
  const dedupe2 = (scale * 1e-3) * (scale * 1e-3);
  const cells = [];

  // Plane buffer: n.x, n.y, n.z, d  meaning  n·p <= d.
  const P = 6 + Math.max(0, seeds.length - 1);
  const pl = new Float64Array(P * 4);

  for (let i = 0; i < seeds.length; i++) {
    let n = 0;
    const put = (nx, ny, nz, d) => {
      pl[n * 4] = nx; pl[n * 4 + 1] = ny; pl[n * 4 + 2] = nz; pl[n * 4 + 3] = d; n++;
    };
    put(1, 0, 0, half.x); put(-1, 0, 0, half.x);
    put(0, 1, 0, half.y); put(0, -1, 0, half.y);
    put(0, 0, 1, half.z); put(0, 0, -1, half.z);

    const si = seeds[i];
    for (let j = 0; j < seeds.length; j++) {
      if (j === i) continue;
      const sj = seeds[j];
      let nx = sj.x - si.x, ny = sj.y - si.y, nz = sj.z - si.z;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-9) continue;
      nx /= len; ny /= len; nz /= len;
      const mx = (si.x + sj.x) * 0.5, my = (si.y + sj.y) * 0.5, mz = (si.z + sj.z) * 0.5;
      put(nx, ny, nz, nx * mx + ny * my + nz * mz);
    }

    const pts = [];
    for (let a = 0; a < n - 2; a++) {
      const a1 = pl[a * 4], b1 = pl[a * 4 + 1], c1 = pl[a * 4 + 2], d1 = pl[a * 4 + 3];
      for (let b = a + 1; b < n - 1; b++) {
        const a2 = pl[b * 4], b2 = pl[b * 4 + 1], c2 = pl[b * 4 + 2], d2 = pl[b * 4 + 3];
        for (let c = b + 1; c < n; c++) {
          const a3 = pl[c * 4], b3 = pl[c * 4 + 1], c3 = pl[c * 4 + 2], d3 = pl[c * 4 + 3];

          const co1 = b2 * c3 - b3 * c2;
          const co2 = a2 * c3 - a3 * c2;
          const co3 = a2 * b3 - a3 * b2;
          const det = a1 * co1 - b1 * co2 + c1 * co3;
          if (det > -1e-10 && det < 1e-10) continue;
          const inv = 1 / det;

          const x = (d1 * co1 - b1 * (d2 * c3 - d3 * c2) + c1 * (d2 * b3 - d3 * b2)) * inv;
          const y = (a1 * (d2 * c3 - d3 * c2) - d1 * co2 + c1 * (a2 * d3 - a3 * d2)) * inv;
          const z = (a1 * (b2 * d3 - b3 * d2) - b1 * (a2 * d3 - a3 * d2) + d1 * co3) * inv;

          let inside = true;
          for (let k = 0; k < n; k++) {
            if (pl[k * 4] * x + pl[k * 4 + 1] * y + pl[k * 4 + 2] * z > pl[k * 4 + 3] + eps) { inside = false; break; }
          }
          if (!inside) continue;

          let dup = false;
          for (let k = 0; k < pts.length; k++) {
            const p = pts[k];
            const dx = p.x - x, dy = p.y - y, dz = p.z - z;
            if (dx * dx + dy * dy + dz * dz < dedupe2) { dup = true; break; }
          }
          if (!dup) pts.push(new THREE.Vector3(x, y, z));
        }
      }
    }

    if (pts.length < 4) continue;

    const center = new THREE.Vector3();
    for (let k = 0; k < pts.length; k++) center.add(pts[k]);
    center.multiplyScalar(1 / pts.length);

    // Reject degenerate (near-planar) cells: they make hopeless colliders.
    const ext = new THREE.Box3().setFromPoints(pts).getSize(new THREE.Vector3());
    if (ext.x * ext.y * ext.z < (scale * 0.03) ** 3) continue;

    for (let k = 0; k < pts.length; k++) pts[k].sub(center);
    cells.push({ center, points: pts, volume: ext.x * ext.y * ext.z * 0.5 });
  }

  return cells;
}

/** Signed volume of a closed triangle soup (non-indexed) — exact for convex hulls. */
export function geometryVolume(geometry) {
  const pos = geometry.getAttribute('position');
  if (!pos) return 0;
  let v = 0;
  for (let i = 0; i < pos.count; i += 3) {
    const ax = pos.getX(i), ay = pos.getY(i), az = pos.getZ(i);
    const bx = pos.getX(i + 1), by = pos.getY(i + 1), bz = pos.getZ(i + 1);
    const cx = pos.getX(i + 2), cy = pos.getY(i + 2), cz = pos.getZ(i + 2);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return Math.abs(v);
}

/**
 * Planar UVs projected onto each triangle's dominant axis, so shards keep whatever texture the
 * source material carries instead of rendering as untextured facets.
 */
function addShardUVs(geometry, scale = 1) {
  const pos = geometry.getAttribute('position');
  const nrm = geometry.getAttribute('normal');
  if (!pos) return;
  const uv = new Float32Array(pos.count * 2);
  const inv = 1 / Math.max(scale, 1e-4);
  for (let i = 0; i < pos.count; i++) {
    const nx = nrm ? Math.abs(nrm.getX(i)) : 0;
    const ny = nrm ? Math.abs(nrm.getY(i)) : 1;
    const nz = nrm ? Math.abs(nrm.getZ(i)) : 0;
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let u, v;
    if (nx >= ny && nx >= nz) { u = z; v = y; }
    else if (ny >= nz) { u = x; v = z; }
    else { u = x; v = y; }
    uv[i * 2] = u * inv * 0.5 + 0.5;
    uv[i * 2 + 1] = v * inv * 0.5 + 0.5;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Convex shard geometry from a cell's point cloud. Returns null if the hull collapses. */
export function shardGeometry(points, uvScale = 1) {
  if (!points || points.length < 4) return null;
  let geo = null;
  try {
    geo = new ConvexGeometry(points);
  } catch {
    return null;
  }
  const pos = geo.getAttribute('position');
  if (!pos || pos.count < 3) { geo.dispose(); return null; }
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  addShardUVs(geo, uvScale);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}
