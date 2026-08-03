// OPERATION NAPTIME — module DRESS — a one-shot verlet cloth, relaxed at build time.
//
// The muslin blanket in the playpen is the one object in this room that cannot be modelled by
// hand: a bunched sheet is nothing but self-collision history, and a sculpted "cloth-shaped blob"
// reads as a beanbag every time. So we run an actual solver — once, at load, for a few hundred
// steps — and freeze the result into a static BufferGeometry.
//
// The trick that produces folds rather than a flat sheet is the initial condition: the particles
// start compressed into a footprint *smaller* than their rest lengths allow (`gather`), so the
// distance constraints have nowhere to push but up and out. Gravity then packs that buckling down
// onto the floor. Two hundred and forty steps of 8 ms is about 2 ms of build time.
//
// Self-collision is approximated by a cheap layer-separation pass (particles that end up within
// `thickness` of each other in XZ get pushed apart in Y) — full self-collision is not worth the
// build time for one blanket, and the layer pass is what stops the surface interpenetrating
// visibly at the crease lines.

import * as THREE from 'three';
import { noise2 } from './util.js';

/**
 * @param {object} o
 * @param {number} o.size cloth side in metres
 * @param {number} o.divisions particles per side
 * @param {number} o.gather 0..1 — how far the sheet is crushed inward before it is released
 * @param {number} o.floor y of the surface it lands on
 * @param {number} o.thickness fabric thickness used by the layer-separation pass
 * @param {number} o.steps solver steps
 * @param {() => number} o.rng seeded random
 * @param {Array<{x,y,z,r}>} [o.obstacles] spheres the cloth must drape over
 * @returns {THREE.BufferGeometry}
 */
export function relaxedCloth({
  size = 0.8, divisions = 15, gather = 0.5, floor = 0, thickness = 0.012,
  steps = 240, rng, obstacles = [], seed = 7,
}) {
  const N = divisions + 1;
  const count = N * N;
  const rest = size / divisions;
  const cur = new Float32Array(count * 3);
  const prev = new Float32Array(count * 3);
  const r = rng || Math.random;

  // Initial condition: compressed footprint, wavy height, small random kick.
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = (j * N + i) * 3;
      const u = i / divisions - 0.5;
      const v = j / divisions - 0.5;
      const swirl = (u * v) * 0.35;
      const n = noise2(i * 0.7, j * 0.7, 1, seed, 2);
      cur[k] = u * size * (1 - gather) + swirl * size * 0.2 + (r() - 0.5) * rest * 0.3;
      cur[k + 1] = floor + 0.10 + n * 0.16 + (j % 2) * 0.01;
      cur[k + 2] = v * size * (1 - gather) - swirl * size * 0.15 + (r() - 0.5) * rest * 0.3;
      prev[k] = cur[k] - (r() - 0.5) * 0.002;
      prev[k + 1] = cur[k + 1];
      prev[k + 2] = cur[k + 2] - (r() - 0.5) * 0.002;
    }
  }

  // Constraint list: structural, shear and one bend link — bend is what keeps the folds broad
  // instead of crumpling into noise.
  const links = [];
  const at = (i, j) => j * N + i;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (i < N - 1) links.push(at(i, j), at(i + 1, j), rest, 1);
      if (j < N - 1) links.push(at(i, j), at(i, j + 1), rest, 1);
      if (i < N - 1 && j < N - 1) links.push(at(i, j), at(i + 1, j + 1), rest * Math.SQRT2, 0.55);
      if (i > 0 && j < N - 1) links.push(at(i, j), at(i - 1, j + 1), rest * Math.SQRT2, 0.55);
      if (i < N - 2) links.push(at(i, j), at(i + 2, j), rest * 2, 0.22);
      if (j < N - 2) links.push(at(i, j), at(i, j + 2), rest * 2, 0.22);
    }
  }

  const dt = 1 / 120;
  const g = -9.81 * dt * dt;
  const damp = 0.985;
  const iterations = 6;

  for (let s = 0; s < steps; s++) {
    // Integrate.
    for (let k = 0; k < count; k++) {
      const i3 = k * 3;
      for (let a = 0; a < 3; a++) {
        const p = cur[i3 + a];
        const q = prev[i3 + a];
        prev[i3 + a] = p;
        cur[i3 + a] = p + (p - q) * damp + (a === 1 ? g : 0);
      }
    }
    // Satisfy.
    for (let it = 0; it < iterations; it++) {
      for (let l = 0; l < links.length; l += 4) {
        const a = links[l] * 3;
        const b = links[l + 1] * 3;
        const restLen = links[l + 2];
        const stiff = links[l + 3];
        const dx = cur[b] - cur[a];
        const dy = cur[b + 1] - cur[a + 1];
        const dz = cur[b + 2] - cur[a + 2];
        const d = Math.hypot(dx, dy, dz) || 1e-6;
        const diff = ((d - restLen) / d) * 0.5 * stiff;
        const mx = dx * diff;
        const my = dy * diff;
        const mz = dz * diff;
        cur[a] += mx; cur[a + 1] += my; cur[a + 2] += mz;
        cur[b] -= mx; cur[b + 1] -= my; cur[b + 2] -= mz;
      }
      // Floor + obstacles.
      for (let k = 0; k < count; k++) {
        const i3 = k * 3;
        if (cur[i3 + 1] < floor + thickness * 0.5) {
          cur[i3 + 1] = floor + thickness * 0.5;
          // Friction against the mat: kill lateral drift so the heap stays where it was dropped.
          prev[i3] += (cur[i3] - prev[i3]) * 0.45;
          prev[i3 + 2] += (cur[i3 + 2] - prev[i3 + 2]) * 0.45;
        }
        for (let o = 0; o < obstacles.length; o++) {
          const ob = obstacles[o];
          const dx = cur[i3] - ob.x;
          const dy = cur[i3 + 1] - ob.y;
          const dz = cur[i3 + 2] - ob.z;
          const d = Math.hypot(dx, dy, dz);
          if (d < ob.r && d > 1e-5) {
            const f = ob.r / d;
            cur[i3] = ob.x + dx * f;
            cur[i3 + 1] = ob.y + dy * f;
            cur[i3 + 2] = ob.z + dz * f;
          }
        }
      }
    }
  }

  // Layer separation: sort by height inside each XZ cell and stack the layers apart.
  const cell = thickness * 2.2;
  const buckets = new Map();
  for (let k = 0; k < count; k++) {
    const i3 = k * 3;
    const key = `${Math.round(cur[i3] / cell)}|${Math.round(cur[i3 + 2] / cell)}`;
    let list = buckets.get(key);
    if (!list) { list = []; buckets.set(key, list); }
    list.push(k);
  }
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => cur[a * 3 + 1] - cur[b * 3 + 1]);
    for (let i = 1; i < list.length; i++) {
      const lo = list[i - 1] * 3 + 1;
      const hi = list[i] * 3 + 1;
      if (cur[hi] - cur[lo] < thickness) cur[hi] = cur[lo] + thickness;
    }
  }

  // Build the surface.
  const positions = new Float32Array(count * 3);
  positions.set(cur);
  const uvs = new Float32Array(count * 2);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      uvs[k * 2] = i / divisions;
      uvs[k * 2 + 1] = j / divisions;
    }
  }
  const index = [];
  for (let j = 0; j < divisions; j++) {
    for (let i = 0; i < divisions; i++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      index.push(a, d, b, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}
