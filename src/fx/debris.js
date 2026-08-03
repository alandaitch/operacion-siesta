// FX · solid debris. The bits that are too small for Rapier to be allowed to care about.
//
// PHYS shatters the vase into a dozen convex Voronoi shards and simulates them properly. What it
// cannot afford is the other two hundred pieces: the chips, the grit, the soil crumbs, the torn
// corner of a board book. Those live here, on a scalar ballistic integrator with one analytic
// ground plane each — no broadphase, no solver, ~30 flops a piece — and they are drawn as three
// InstancedMeshes wearing real materials from the library, so they are lit, fogged and
// shadow-receiving exactly like the room around them. That is the whole point of doing them as
// geometry instead of as sprites: a ceramic chip lying on the rug has to catch the window.
//
// Three pools, because three shapes and three materials:
//   chip    — an irregular octahedron in `ceramic.white`, tinted per instance (also stands in for
//             wood splinters, plastic and plaster; the tint does the work)
//   pebble  — a lumpy icosahedron in `soil`, for the monstera's pot and for crumbs
//   scrap   — a thin double-sided quad in `paper.page`, flown on a flutter integrator rather than a
//             ballistic one, because paper does not fall, it argues with the air
//
// Coming to rest is a gameplay event, not a physics one: a piece that stops moving on a horizontal
// surface calls back into the decal system before it fades, which is how soil ends up permanently
// ground into the rug.

import * as THREE from 'three';
import { makeRng } from '../core/rng.js';

const GRAVITY = -9.81;

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _spin = new THREE.Quaternion();
const _axis = new THREE.Vector3();

/** An octahedron with its vertices pushed around: reads as a fracture chip, not as a die. */
function chipGeometry(seed) {
  const geo = new THREE.OctahedronGeometry(0.5, 0);
  const pos = geo.getAttribute('position');
  const r = makeRng(seed);
  // The same source vertex appears several times in a non-indexed polyhedron, so displace by a
  // hash of the rounded position rather than by index, or the facets come apart.
  const cache = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let d = cache.get(key);
    if (!d) {
      d = [0.55 + r() * 0.75, 0.55 + r() * 0.75, 0.40 + r() * 0.80];
      cache.set(key, d);
    }
    pos.setXYZ(i, pos.getX(i) * d[0], pos.getY(i) * d[1], pos.getZ(i) * d[2]);
  }
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** A lumpy little ball for soil and crumbs. */
function pebbleGeometry(seed) {
  const geo = new THREE.IcosahedronGeometry(0.5, 0);
  const pos = geo.getAttribute('position');
  const r = makeRng(seed);
  const cache = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let d = cache.get(key);
    if (!d) { d = 0.72 + r() * 0.52; cache.set(key, d); }
    pos.setXYZ(i, pos.getX(i) * d, pos.getY(i) * d, pos.getZ(i) * d);
  }
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * One pool.
 * @param {object} o
 * @param {THREE.BufferGeometry} o.geometry
 * @param {THREE.Material} o.material
 * @param {number} o.capacity
 * @param {string} o.name
 * @param {(x,y,z,tag)=>void} [o.onRest] called once when a piece settles, before it fades
 */
function createPool({ geometry, material, capacity, name, onRest }) {
  const cap = Math.max(4, capacity | 0);

  const px = new Float32Array(cap);
  const py = new Float32Array(cap);
  const pz = new Float32Array(cap);
  const vx = new Float32Array(cap);
  const vy = new Float32Array(cap);
  const vz = new Float32Array(cap);
  const qx = new Float32Array(cap);
  const qy = new Float32Array(cap);
  const qz = new Float32Array(cap);
  const qw = new Float32Array(cap);
  const wx = new Float32Array(cap);
  const wy = new Float32Array(cap);
  const wz = new Float32Array(cap);
  const sx = new Float32Array(cap);
  const sy = new Float32Array(cap);
  const sz = new Float32Array(cap);
  const age = new Float32Array(cap);
  const life = new Float32Array(cap);
  const rest = new Float32Array(cap);   // the surface height this piece lands on
  const bounce = new Float32Array(cap);
  const colR = new Float32Array(cap);
  const colG = new Float32Array(cap);
  const colB = new Float32Array(cap);
  const mode = new Uint8Array(cap);     // 0 ballistic · 1 flutter
  const state = new Uint8Array(cap);    // 0 flying · 1 settled · 2 reported
  const phase = new Float32Array(cap);
  // What this piece should leave behind when it stops. Carried per particle, because settling
  // happens seconds after the spawn and the emitter's context is long gone by then.
  const tag = new Uint8Array(cap);

  const free = new Int32Array(cap);
  let freeCount = cap;
  for (let i = 0; i < cap; i++) free[i] = cap - 1 - i;
  const active = new Int32Array(cap);
  let activeCount = 0;

  const mesh = new THREE.InstancedMesh(geometry, material, cap);
  mesh.name = name;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = false;   // a 10 mm chip is a sub-texel caster; it would only alias
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.count = 0;
  mesh.visible = false;

  function release(i) {
    const slot = active[i];
    activeCount--;
    active[i] = active[activeCount];
    free[freeCount++] = slot;
  }

  return {
    mesh,
    capacity: cap,
    get count() { return activeCount; },

    spawn(o) {
      let slot;
      if (freeCount > 0) {
        slot = free[--freeCount];
      } else {
        // Recycle the oldest rather than dropping the request: a shatter must always produce chips.
        let best = 0;
        let bestFrac = -1;
        for (let i = 0; i < activeCount; i++) {
          const s = active[i];
          const f = age[s] / (life[s] || 1);
          if (f > bestFrac) { bestFrac = f; best = i; }
        }
        slot = active[best];
        activeCount--;
        active[best] = active[activeCount];
      }
      px[slot] = o.x; py[slot] = o.y; pz[slot] = o.z;
      vx[slot] = o.vx || 0; vy[slot] = o.vy || 0; vz[slot] = o.vz || 0;
      qx[slot] = o.qx || 0; qy[slot] = o.qy || 0; qz[slot] = o.qz || 0; qw[slot] = o.qw !== undefined ? o.qw : 1;
      wx[slot] = o.wx || 0; wy[slot] = o.wy || 0; wz[slot] = o.wz || 0;
      sx[slot] = o.sx || 0.01; sy[slot] = o.sy || o.sx || 0.01; sz[slot] = o.sz || o.sx || 0.01;
      age[slot] = 0;
      life[slot] = o.life > 0.1 ? o.life : 5;
      rest[slot] = o.rest !== undefined ? o.rest : 0;
      bounce[slot] = o.bounce !== undefined ? o.bounce : 0.28;
      colR[slot] = o.r !== undefined ? o.r : 1;
      colG[slot] = o.g !== undefined ? o.g : 1;
      colB[slot] = o.b !== undefined ? o.b : 1;
      mode[slot] = o.flutter ? 1 : 0;
      state[slot] = 0;
      phase[slot] = o.phase || 0;
      tag[slot] = o.tag | 0;
      active[activeCount++] = slot;
      return true;
    },

    step(dt, t) {
      for (let i = activeCount - 1; i >= 0; i--) {
        const s = active[i];
        const a = age[s] + dt;
        if (a >= life[s]) { release(i); continue; }
        age[s] = a;
        if (state[s] >= 1) continue; // settled: nothing left to integrate

        const half = sy[s] * 0.5;
        if (mode[s] === 1) {
          // Paper: heavy drag, a lateral sway that swaps sign, and only a third of its weight
          // reaching the floor. It is the sway, not the fall, that reads as paper.
          const k = Math.exp(-2.6 * dt);
          vx[s] = vx[s] * k + Math.sin(t * 5.1 + phase[s]) * 0.55 * dt;
          vz[s] = vz[s] * k + Math.cos(t * 4.3 + phase[s] * 1.7) * 0.55 * dt;
          vy[s] = vy[s] * k + GRAVITY * 0.30 * dt;
          wx[s] = Math.sin(t * 3.3 + phase[s]) * 3.4;
          wz[s] = Math.cos(t * 2.7 + phase[s] * 0.6) * 3.0;
        } else {
          const k = Math.exp(-0.9 * dt);
          vx[s] *= k;
          vz[s] *= k;
          vy[s] = vy[s] * k + GRAVITY * dt;
        }

        px[s] += vx[s] * dt;
        py[s] += vy[s] * dt;
        pz[s] += vz[s] * dt;

        if (py[s] <= rest[s] + half) {
          py[s] = rest[s] + half;
          if (vy[s] < -0.25 && bounce[s] > 0.02) {
            vy[s] = -vy[s] * bounce[s];
            vx[s] *= 0.55;
            vz[s] *= 0.55;
            wx[s] *= 0.6; wy[s] *= 0.6; wz[s] *= 0.6;
          } else {
            // Landed. Lie down: roll the piece so its shortest axis is vertical.
            vy[s] = 0;
            vx[s] *= 0.25;
            vz[s] *= 0.25;
            if (Math.abs(vx[s]) + Math.abs(vz[s]) < 0.06) {
              state[s] = 1;
              vx[s] = 0; vz[s] = 0; wx[s] = 0; wy[s] = 0; wz[s] = 0;
              py[s] = rest[s] + half * 0.65;
              if (onRest && tag[s]) onRest(px[s], py[s], pz[s], tag[s]);
              // Everything that settles gets a short, unhurried disappearance.
              const remaining = life[s] - age[s];
              if (remaining > 2.2) life[s] = age[s] + 2.2;
            }
          }
        }

        if (state[s] === 0) {
          // Integrate the rotation as an axis-angle step: cheaper and more stable than a
          // quaternion derivative at these angular rates.
          const wlen = Math.hypot(wx[s], wy[s], wz[s]);
          if (wlen > 1e-4) {
            _axis.set(wx[s] / wlen, wy[s] / wlen, wz[s] / wlen);
            _spin.setFromAxisAngle(_axis, wlen * dt);
            _q.set(qx[s], qy[s], qz[s], qw[s]).premultiply(_spin).normalize();
            qx[s] = _q.x; qy[s] = _q.y; qz[s] = _q.z; qw[s] = _q.w;
          }
        }
      }
    },

    upload() {
      let n = 0;
      const marr = mesh.instanceMatrix.array;
      const carr = mesh.instanceColor.array;
      for (let i = 0; i < activeCount; i++) {
        const s = active[i];
        const f = age[s] / life[s];
        // Shrink away over the last 20% rather than popping out.
        const k = f > 0.8 ? Math.max(0, 1 - (f - 0.8) / 0.2) : 1;
        if (k <= 0.02) continue;
        _p.set(px[s], py[s], pz[s]);
        _q.set(qx[s], qy[s], qz[s], qw[s]);
        _s.set(sx[s] * k, sy[s] * k, sz[s] * k);
        _m.compose(_p, _q, _s);
        _m.toArray(marr, n * 16);
        carr[n * 3] = colR[s];
        carr[n * 3 + 1] = colG[s];
        carr[n * 3 + 2] = colB[s];
        n++;
      }
      mesh.count = n;
      mesh.visible = n > 0;
      if (n > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
      }
      return n;
    },

    clear() {
      activeCount = 0;
      freeCount = cap;
      for (let i = 0; i < cap; i++) free[i] = cap - 1 - i;
      mesh.count = 0;
      mesh.visible = false;
    },

    dispose() {
      geometry.dispose();
      mesh.dispose();
    },
  };
}

/**
 * @param {object} o
 * @param {object} o.materials ctx.materials
 * @param {number} o.capacity total debris budget, split across the three pools
 * @param {(x,y,z,tag)=>void} [o.onRest]
 */
export function createDebris({ materials, capacity, onRest }) {
  const total = Math.max(9, capacity | 0);
  const chipCap = Math.max(4, Math.round(total * 0.46));
  const pebbleCap = Math.max(4, Math.round(total * 0.34));
  const scrapCap = Math.max(3, total - chipCap - pebbleCap);

  const scrapGeo = new THREE.PlaneGeometry(1, 1, 1, 1);

  const chip = createPool({
    geometry: chipGeometry(0x5c1a7),
    material: materials.get('ceramic.white'),
    capacity: chipCap,
    name: 'fx.debris.chip',
    onRest: onRest || null,
  });
  const pebble = createPool({
    geometry: pebbleGeometry(0x50113),
    material: materials.get('soil'),
    capacity: pebbleCap,
    name: 'fx.debris.pebble',
    onRest: onRest || null,
  });
  const scrap = createPool({
    geometry: scrapGeo,
    material: materials.get('paper.page'),
    capacity: scrapCap,
    name: 'fx.debris.scrap',
    onRest: onRest || null,
  });

  const pools = [chip, pebble, scrap];
  const group = new THREE.Group();
  group.name = 'fx.debris';
  group.matrixAutoUpdate = false;
  for (const p of pools) group.add(p.mesh);

  return {
    group,
    chip,
    pebble,
    scrap,
    pools,
    get count() { return chip.count + pebble.count + scrap.count; },
    step(dt, t) { for (const p of pools) p.step(dt, t); },
    upload() { let n = 0; for (const p of pools) n += p.upload(); return n; },
    clear() { for (const p of pools) p.clear(); },
    dispose() { for (const p of pools) p.dispose(); },
  };
}
