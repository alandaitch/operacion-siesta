// FX · decals. The evidence.
//
// The emotional payoff of this game is not the moment the vase breaks; it is looking back across
// the room ninety seconds later and seeing the trail of soil, crumbs, coffee and drool you left
// getting there. So decals persist for the whole round, and they are the only thing in FX that
// never fades out on its own.
//
// PROJECTION. Each decal is a single quad built from a tangent basis around the contact normal,
// lifted 3 mm off the surface and given a negative polygon offset so it wins the depth test
// against the surface it is lying on without ever writing depth itself. That is the cheap decal —
// no clipping against the receiver's triangles — and it is the right one here, because every
// surface that receives one (the rug, the floor, a seat cushion, the play mat) is locally flat at
// the 15 cm scale a decal occupies.
//
// BLENDING. Multiply, not alpha. `dst · src` means a decal modulates whatever light the surface
// was already receiving: soil ground into the cream rug gets darker in the shadow under the sofa
// and warmer where the window rakes across it, for free, with no lighting code of its own. It also
// buys the one thing alpha compositing cannot — a tint above 1.0 *lightens*, which is how ceramic
// powder and flour sit on a dark floor. Coverage is `mix(vec3(1.0), tint, alpha)`, so a decal with
// no coverage is a no-op multiply by white.
//
// One InstancedBufferGeometry, one draw call, uploaded only on the frames something changed.

import * as THREE from 'three';
import { ATLAS_GLSL, CELL } from './sprites.js';

const VERT = /* glsl */ `
precision highp float;

attribute vec3 iPos;
attribute vec3 iRight;   // tangent · half-width
attribute vec3 iUp;      // bitangent · half-height
attribute vec4 iTint;    // linear multiply tint · atlas cell
attribute vec2 iFade;    // coverage · unused

varying vec2 vUv;
varying vec3 vTint;
varying float vCell;
varying float vCoverage;

void main() {
  vec3 world = iPos + iRight * ( position.x * 2.0 ) + iUp * ( position.y * 2.0 );
  vUv = uv;
  vTint = iTint.rgb;
  vCell = iTint.w;
  vCoverage = iFade.x;
  gl_Position = projectionMatrix * viewMatrix * vec4( world, 1.0 );
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uAtlas;
uniform float uOpacity;

varying vec2 vUv;
varying vec3 vTint;
varying float vCell;
varying float vCoverage;

${ATLAS_GLSL}

void main() {
  vec4 tex = texture2D( uAtlas, fxAtlasUV( vUv, vCell ) );
  float cov = tex.a * vCoverage * uOpacity;
  if ( cov <= 0.004 ) discard;
  // The atlas' detail channel decides how *concentrated* the stain is at this texel, so a soil
  // patch is dark in its clumps and barely there at its fringe instead of being a flat wash.
  vec3 tint = mix( vec3( 1.0 ), vTint, clamp( 0.35 + tex.r * 0.95, 0.0, 1.0 ) );
  gl_FragColor = vec4( mix( vec3( 1.0 ), tint, cov ), 1.0 );
}
`;

/** Preset stains. Tints are linear multipliers: below 1 darkens, above 1 lightens. */
export const DECAL = {
  soil: { cell: CELL.STAIN, tint: [0.30, 0.21, 0.14], size: [0.10, 0.22], coverage: 0.95 },
  crumbs: { cell: CELL.SPECKS, tint: [0.44, 0.36, 0.26], size: [0.07, 0.15], coverage: 0.80 },
  coffee: { cell: CELL.RING, tint: [0.40, 0.28, 0.18], size: [0.09, 0.14], coverage: 0.85 },
  drool: { cell: CELL.DRIP, tint: [0.68, 0.71, 0.74], size: [0.035, 0.075], coverage: 0.72 },
  splash: { cell: CELL.SPLAT, tint: [0.46, 0.36, 0.25], size: [0.10, 0.20], coverage: 0.88 },
  powder: { cell: CELL.POWDER, tint: [1.34, 1.32, 1.26], size: [0.10, 0.26], coverage: 0.55 },
  chalk: { cell: CELL.SMEAR, tint: [1.22, 1.21, 1.18], size: [0.08, 0.18], coverage: 0.45 },
  scuff: { cell: CELL.SMEAR, tint: [0.66, 0.63, 0.60], size: [0.07, 0.16], coverage: 0.55 },
  dust: { cell: CELL.STAIN, tint: [0.78, 0.76, 0.72], size: [0.09, 0.20], coverage: 0.45 },
};

const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _alt = new THREE.Vector3(1, 0, 0);

/**
 * @param {object} o
 * @param {number} o.capacity max simultaneous decals
 * @param {THREE.Texture} o.atlas
 * @param {() => number} o.rand seeded 0..1 source
 */
export function createDecals({ capacity, atlas, rand }) {
  const cap = Math.max(4, capacity | 0);

  const iPos = new Float32Array(cap * 3);
  const iRight = new Float32Array(cap * 3);
  const iUp = new Float32Array(cap * 3);
  const iTint = new Float32Array(cap * 4);
  const iFade = new Float32Array(cap * 2);

  const target = new Float32Array(cap);  // the coverage this decal is fading toward
  const born = new Float32Array(cap);
  const used = new Uint8Array(cap);
  const order = new Int32Array(cap);     // insertion order, oldest first
  let orderCount = 0;
  let cursor = 0;
  let live = 0;
  let dirty = true;
  let fading = 0;

  const QUAD_POS = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  const QUAD_UV = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const QUAD_INDEX = new Uint16Array([0, 1, 2, 0, 2, 3]);

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex(new THREE.BufferAttribute(QUAD_INDEX, 1));
  geometry.setAttribute('position', new THREE.BufferAttribute(QUAD_POS, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(QUAD_UV, 2));
  const aPos = new THREE.InstancedBufferAttribute(iPos, 3);
  const aRight = new THREE.InstancedBufferAttribute(iRight, 3);
  const aUp = new THREE.InstancedBufferAttribute(iUp, 3);
  const aTint = new THREE.InstancedBufferAttribute(iTint, 4);
  const aFade = new THREE.InstancedBufferAttribute(iFade, 2);
  for (const a of [aPos, aRight, aUp, aTint, aFade]) a.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('iPos', aPos);
  geometry.setAttribute('iRight', aRight);
  geometry.setAttribute('iUp', aUp);
  geometry.setAttribute('iTint', aTint);
  geometry.setAttribute('iFade', aFade);
  geometry.instanceCount = 0;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.4, -0.6), 12);

  const material = new THREE.ShaderMaterial({
    name: 'fx.decals',
    uniforms: {
      uAtlas: { value: atlas },
      uOpacity: { value: 1 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    blending: THREE.MultiplyBlending,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'fx.decals';
  mesh.frustumCulled = false;
  // First of all the transparents. A decal belongs to the surface it is lying on, so the glass
  // table, the sheer curtains and the playpen mesh must all composite *over* it — and none of them
  // writes depth, so ordering is the only thing that decides it.
  mesh.renderOrder = -1;
  mesh.matrixAutoUpdate = false;
  mesh.visible = false;

  /** Right-handed tangent frame around `n`, with a random roll so no two stains line up. */
  function basis(nx, ny, nz, roll) {
    _n.set(nx, ny, nz);
    if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0);
    _n.normalize();
    const ref = Math.abs(_n.y) > 0.94 ? _alt : _up;
    _t.crossVectors(ref, _n);
    if (_t.lengthSq() < 1e-8) _t.set(1, 0, 0);
    _t.normalize();
    _b.crossVectors(_n, _t).normalize();
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    const tx = _t.x * c + _b.x * s;
    const ty = _t.y * c + _b.y * s;
    const tz = _t.z * c + _b.z * s;
    const bx = -_t.x * s + _b.x * c;
    const by = -_t.y * s + _b.y * c;
    const bz = -_t.z * s + _b.z * c;
    _t.set(tx, ty, tz);
    _b.set(bx, by, bz);
  }

  const api = {
    object3d: mesh,
    capacity: cap,
    get count() { return live; },

    /**
     * Stamp one. `o`: { x,y,z, nx,ny,nz, kind|cell, size, tint[3], coverage, aspect, roll }.
     * Returns false only if the pool has zero capacity.
     */
    stamp(o) {
      if (cap <= 0) return false;
      const preset = DECAL[o.kind] || DECAL.soil;
      const cell = o.cell !== undefined ? o.cell : preset.cell;
      const tint = o.tint || preset.tint;
      const cov = o.coverage !== undefined ? o.coverage : preset.coverage;
      const lo = preset.size[0];
      const hi = preset.size[1];
      const size = o.size !== undefined ? o.size : lo + (hi - lo) * rand();
      const aspect = o.aspect !== undefined ? o.aspect : 0.82 + rand() * 0.4;
      const roll = o.roll !== undefined ? o.roll : rand() * Math.PI * 2;

      // Oldest-first replacement. A round can produce more mess than the pool holds, and losing
      // the first crumb of the round is invisible next to losing the one you just made.
      let slot;
      if (live < cap) {
        while (used[cursor]) cursor = (cursor + 1) % cap;
        slot = cursor;
        cursor = (cursor + 1) % cap;
        used[slot] = 1;
        live++;
        order[orderCount++] = slot;
      } else {
        slot = order[0];
        for (let i = 1; i < orderCount; i++) order[i - 1] = order[i];
        order[orderCount - 1] = slot;
      }

      basis(o.nx !== undefined ? o.nx : 0, o.ny !== undefined ? o.ny : 1, o.nz !== undefined ? o.nz : 0, roll);
      const hw = size * 0.5;
      const hh = hw * aspect;
      const o3 = slot * 3;
      // 3 mm of standoff plus the polygon offset: neither alone survives a rucked wool rug.
      iPos[o3] = o.x + _n.x * 0.003;
      iPos[o3 + 1] = o.y + _n.y * 0.003;
      iPos[o3 + 2] = o.z + _n.z * 0.003;
      iRight[o3] = _t.x * hw; iRight[o3 + 1] = _t.y * hw; iRight[o3 + 2] = _t.z * hw;
      iUp[o3] = _b.x * hh; iUp[o3 + 1] = _b.y * hh; iUp[o3 + 2] = _b.z * hh;
      const o4 = slot * 4;
      iTint[o4] = tint[0]; iTint[o4 + 1] = tint[1]; iTint[o4 + 2] = tint[2]; iTint[o4 + 3] = cell;
      iFade[slot * 2] = 0;
      iFade[slot * 2 + 1] = 0;
      target[slot] = cov;
      born[slot] = 0;
      fading++;
      dirty = true;
      return true;
    },

    /** Only the fade-in costs anything; a settled room of decals uploads nothing at all. */
    step(dt) {
      if (fading <= 0) return;
      let stillFading = 0;
      for (let i = 0; i < cap; i++) {
        if (!used[i]) continue;
        const cur = iFade[i * 2];
        const want = target[i];
        if (cur >= want - 0.001) continue;
        // ~0.25 s to full: a spill lands, it does not appear.
        const next = Math.min(want, cur + dt * want * 4.0);
        iFade[i * 2] = next;
        born[i] += dt;
        if (next < want - 0.001) stillFading++;
        dirty = true;
      }
      fading = stillFading;
    },

    upload() {
      if (!dirty) return live;
      let n = 0;
      // The instance buffers are indexed by slot, so the draw range has to cover the highest live
      // slot; unused slots carry zero coverage and are discarded in one texel-free branch.
      for (let i = 0; i < cap; i++) if (used[i]) n = i + 1;
      geometry.instanceCount = n;
      mesh.visible = n > 0;
      if (n > 0) {
        aPos.needsUpdate = true;
        aRight.needsUpdate = true;
        aUp.needsUpdate = true;
        aTint.needsUpdate = true;
        aFade.needsUpdate = true;
      }
      dirty = false;
      return live;
    },

    setOpacity(v) {
      material.uniforms.uOpacity.value = v;
    },

    clear() {
      used.fill(0);
      iFade.fill(0);
      live = 0;
      orderCount = 0;
      cursor = 0;
      fading = 0;
      dirty = true;
      geometry.instanceCount = 0;
      mesh.visible = false;
    },

    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };

  return api;
}
