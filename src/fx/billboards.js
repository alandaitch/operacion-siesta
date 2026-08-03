// FX · the pooled billboard particle system. Every puff, powder cloud, wisp and glint in the game
// is one instance of one quad in one draw call.
//
// STORAGE. A struct-of-arrays pool of Float32Arrays sized once at construction from
// ctx.quality.particleBudget, plus three InstancedBufferAttributes that mirror the live subset.
// Nothing in here allocates after the constructor returns: `spawn()` takes a scratch options object
// the caller owns, `step()` integrates in place, and the upload is a straight typed-array copy of
// the first `count` slots. That matters more than it sounds — a particle system that allocates is a
// particle system that stutters the moment the vase actually breaks.
//
// BLENDING. One material serves both alpha-blended smoke and additive glints, because the blend is
// premultiplied `over`: src·1 + dst·(1−src.a). A fragment that writes rgb = colour·a and a = a is
// ordinary alpha compositing; one that writes the same rgb but a = 0 is pure addition; anything
// between crossfades. So `additive` is a per-instance float and there is still only one draw call.
//
// SOFTNESS. Each fragment gets a spherical thickness term from its own quad UV (a billboard is
// standing in for a ball of dust, so it should be thin at the silhouette) and then the analytic
// scene fade from ./softness.js. Together they are what stop a puff from being sliced in half by
// the rug.
//
// BUDGETS. Every emitter declares a share of the pool. When an emitter is at its cap its own
// oldest particle is recycled rather than a stranger's, so a long shatter plume can never eat the
// ambient dust the camera is looking at.

import * as THREE from 'three';
import { ATLAS_GLSL } from './sprites.js';
import { SOFTNESS_GLSL } from './softness.js';

/** Emitter tags. Each owns a slice of the pool; see DEFAULT_SHARES. */
export const OWNER = {
  IMPACT: 0,
  SHATTER: 1,
  DUST: 2,
  SPILL: 3,
  BURST: 4,
  CRAWL: 5,
  COUNT: 6,
};

const DEFAULT_SHARES = [0.30, 0.42, 0.30, 0.16, 0.20, 0.16];

const VERT = /* glsl */ `
precision highp float;

attribute vec3 iPos;
attribute vec4 iQuad;   // size (m) · rotation (rad) · alpha · atlas cell
attribute vec4 iTint;   // linear rgb · additive share

uniform vec3 uCamRight;
uniform vec3 uCamUp;

varying vec2 vUv;
varying vec4 vTint;
varying float vAlpha;
varying float vCell;
varying vec3 vWorld;
varying float vRadius;

void main() {
  float s = iQuad.x;
  float c = cos( iQuad.y );
  float n = sin( iQuad.y );
  vec2 q = position.xy;
  vec2 rq = vec2( q.x * c - q.y * n, q.x * n + q.y * c ) * s;
  vec3 world = iPos + uCamRight * rq.x + uCamUp * rq.y;

  vUv = uv;
  vTint = iTint;
  vAlpha = iQuad.z;
  vCell = iQuad.w;
  vWorld = world;
  vRadius = s * 0.5;

  gl_Position = projectionMatrix * viewMatrix * vec4( world, 1.0 );
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uAtlas;
uniform float uSoftScale;
uniform float uOpacity;

varying vec2 vUv;
varying vec4 vTint;
varying float vAlpha;
varying float vCell;
varying vec3 vWorld;
varying float vRadius;

${ATLAS_GLSL}
${SOFTNESS_GLSL}

void main() {
  vec4 tex = texture2D( uAtlas, fxAtlasUV( vUv, vCell ) );
  float a = tex.a * vAlpha * uOpacity;
  if ( a <= 0.0025 ) discard;

  // The quad is a ball of dust seen flat: thin at the rim, thick through the middle.
  vec2 d = vUv - 0.5;
  float thick = sqrt( max( 0.0, 1.0 - min( 1.0, dot( d, d ) * 4.0 ) ) );
  a *= mix( 0.52, 1.0, thick );

  // …and it must not slice through the room.
  a *= fxSoftness( vWorld, vRadius * uSoftScale );

  // Nothing detonates in the lens.
  float dist = length( vWorld - cameraPosition );
  a *= smoothstep( 0.055, 0.26, dist );
  if ( a <= 0.0025 ) discard;

  vec3 colour = vTint.rgb * ( 0.30 + 1.35 * tex.r );
  // Premultiplied 'over' with a per-instance additive share — see the header.
  gl_FragColor = vec4( colour * a, a * ( 1.0 - vTint.a ) );
}
`;

/** The unit quad every billboard is an instance of. Authored inline so the pool owns no helper
 *  geometry it would have to dispose in the right order. */
const QUAD_POS = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
const QUAD_UV = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
const QUAD_INDEX = new Uint16Array([0, 1, 2, 0, 2, 3]);

/**
 * @param {object} opts
 * @param {number} opts.capacity pool size
 * @param {THREE.Texture} opts.atlas the sprite atlas
 * @param {object} opts.softness uniform block from ./softness.js
 * @param {number[]} [opts.shares] per-owner fractions of the pool
 */
export function createBillboards({ capacity, atlas, softness, shares = DEFAULT_SHARES }) {
  const cap = Math.max(8, capacity | 0);

  // --- the pool ------------------------------------------------------------------------------
  const px = new Float32Array(cap);
  const py = new Float32Array(cap);
  const pz = new Float32Array(cap);
  const vx = new Float32Array(cap);
  const vy = new Float32Array(cap);
  const vz = new Float32Array(cap);
  const age = new Float32Array(cap);
  const life = new Float32Array(cap);
  const sizeA = new Float32Array(cap);
  const sizeB = new Float32Array(cap);
  const rot = new Float32Array(cap);
  const spin = new Float32Array(cap);
  const peak = new Float32Array(cap);
  const cell = new Float32Array(cap);
  const colR = new Float32Array(cap);
  const colG = new Float32Array(cap);
  const colB = new Float32Array(cap);
  const add = new Float32Array(cap);
  const drag = new Float32Array(cap);
  const lift = new Float32Array(cap);
  const swirl = new Float32Array(cap);
  const owner = new Uint8Array(cap);
  const alive = new Uint8Array(cap);

  const free = new Int32Array(cap);
  let freeCount = cap;
  for (let i = 0; i < cap; i++) free[i] = cap - 1 - i;

  const active = new Int32Array(cap);
  const depth2 = new Float32Array(cap);
  let activeCount = 0;

  const ownerCount = new Int32Array(OWNER.COUNT);
  const ownerCap = new Int32Array(OWNER.COUNT);
  function recomputeCaps(budgetScale) {
    for (let i = 0; i < OWNER.COUNT; i++) {
      ownerCap[i] = Math.max(4, Math.round(cap * (shares[i] || 0.2) * budgetScale));
    }
  }
  recomputeCaps(1);

  // --- the mesh ------------------------------------------------------------------------------
  const iPos = new Float32Array(cap * 3);
  const iQuad = new Float32Array(cap * 4);
  const iTint = new Float32Array(cap * 4);

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex(new THREE.BufferAttribute(QUAD_INDEX.slice(), 1));
  geometry.setAttribute('position', new THREE.BufferAttribute(QUAD_POS.slice(), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(QUAD_UV.slice(), 2));
  const aPos = new THREE.InstancedBufferAttribute(iPos, 3);
  const aQuad = new THREE.InstancedBufferAttribute(iQuad, 4);
  const aTint = new THREE.InstancedBufferAttribute(iTint, 4);
  aPos.setUsage(THREE.DynamicDrawUsage);
  aQuad.setUsage(THREE.DynamicDrawUsage);
  aTint.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('iPos', aPos);
  geometry.setAttribute('iQuad', aQuad);
  geometry.setAttribute('iTint', aTint);
  geometry.instanceCount = 0;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.2, -0.6), 12);

  const material = new THREE.ShaderMaterial({
    name: 'fx.billboards',
    uniforms: {
      ...softness,
      uAtlas: { value: atlas },
      uCamRight: { value: new THREE.Vector3(1, 0, 0) },
      uCamUp: { value: new THREE.Vector3(0, 1, 0) },
      uSoftScale: { value: 1.35 },
      uOpacity: { value: 1 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });

  const camPos = new THREE.Vector3();

  /**
   * Order the live set back to front. three sorts *objects*, never the instances inside one, so an
   * unsorted pool composites a near puff before the far one behind it and the far one then blends
   * over the top. Insertion sort, because the array is near-sorted every frame after the first —
   * particles barely move relative to each other between frames — so this is O(n) in practice and
   * only degenerates on the frame a big plume is born, where the depths are all within a few
   * centimetres of each other anyway.
   */
  function sortByDepth() {
    for (let i = 0; i < activeCount; i++) {
      const s = active[i];
      const dx = px[s] - camPos.x;
      const dy = py[s] - camPos.y;
      const dz = pz[s] - camPos.z;
      depth2[s] = dx * dx + dy * dy + dz * dz;
    }
    for (let i = 1; i < activeCount; i++) {
      const v = active[i];
      const d = depth2[v];
      let j = i - 1;
      while (j >= 0 && depth2[active[j]] < d) {
        active[j + 1] = active[j];
        j--;
      }
      active[j + 1] = v;
    }
  }

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'fx.billboards';
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.matrixAutoUpdate = false;
  mesh.visible = false;

  // --- allocation ----------------------------------------------------------------------------
  function release(slot, activeIndex) {
    alive[slot] = 0;
    ownerCount[owner[slot]]--;
    free[freeCount++] = slot;
    activeCount--;
    active[activeIndex] = active[activeCount];
  }

  /** The oldest live particle belonging to `own`, as an index into `active`, or -1. */
  function oldestOf(own) {
    let best = -1;
    let bestFrac = -1;
    for (let i = 0; i < activeCount; i++) {
      const s = active[i];
      if (owner[s] !== own) continue;
      const f = age[s] / (life[s] || 1);
      if (f > bestFrac) { bestFrac = f; best = i; }
    }
    return best;
  }

  function claim(own) {
    if (ownerCount[own] >= ownerCap[own]) {
      const i = oldestOf(own);
      if (i < 0) return -1;
      release(active[i], i);
    }
    if (freeCount === 0) {
      // The pool is full of somebody else's particles. Take the globally oldest.
      let best = -1;
      let bestFrac = -1;
      for (let i = 0; i < activeCount; i++) {
        const s = active[i];
        const f = age[s] / (life[s] || 1);
        if (f > bestFrac) { bestFrac = f; best = i; }
      }
      if (best < 0) return -1;
      release(active[best], best);
    }
    const slot = free[--freeCount];
    alive[slot] = 1;
    owner[slot] = own;
    ownerCount[own]++;
    active[activeCount++] = slot;
    return slot;
  }

  // --- the API -------------------------------------------------------------------------------
  const api = {
    object3d: mesh,
    material,
    capacity: cap,
    get count() { return activeCount; },

    /**
     * Emit one particle. `o` is read and never retained, so callers reuse one scratch object.
     * Fields: x,y,z · vx,vy,vz · size,grow · life · alpha · cell · r,g,b · additive · drag ·
     *         lift · spin · rot · swirl · owner
     */
    spawn(o) {
      const slot = claim(o.owner | 0);
      if (slot < 0) return false;
      px[slot] = o.x; py[slot] = o.y; pz[slot] = o.z;
      vx[slot] = o.vx || 0; vy[slot] = o.vy || 0; vz[slot] = o.vz || 0;
      age[slot] = 0;
      life[slot] = o.life > 0.02 ? o.life : 0.6;
      sizeA[slot] = o.size > 0 ? o.size : 0.1;
      sizeB[slot] = sizeA[slot] * (o.grow !== undefined ? o.grow : 1.8);
      rot[slot] = o.rot || 0;
      spin[slot] = o.spin || 0;
      peak[slot] = o.alpha !== undefined ? o.alpha : 0.7;
      cell[slot] = o.cell || 0;
      colR[slot] = o.r !== undefined ? o.r : 1;
      colG[slot] = o.g !== undefined ? o.g : 1;
      colB[slot] = o.b !== undefined ? o.b : 1;
      add[slot] = o.additive || 0;
      drag[slot] = o.drag !== undefined ? o.drag : 2.4;
      lift[slot] = o.lift !== undefined ? o.lift : 0.10;
      swirl[slot] = o.swirl !== undefined ? o.swirl : 0.35;
      return true;
    },

    /** Integrate. `t` is elapsed seconds, used for the deterministic turbulence field. */
    step(dt, t) {
      for (let i = activeCount - 1; i >= 0; i--) {
        const s = active[i];
        const a = age[s] + dt;
        if (a >= life[s]) { release(s, i); continue; }
        age[s] = a;

        // Exponential drag, integrated exactly so the result does not depend on the frame rate.
        const k = Math.exp(-drag[s] * dt);
        let ux = vx[s] * k;
        let uy = vy[s] * k;
        let uz = vz[s] * k;

        // A standing turbulence field: cheap, deterministic, and enough to stop a puff from
        // expanding as a perfect disc. Warm air off the rug carries it up and toward the window.
        const sw = swirl[s];
        if (sw > 0) {
          const wx = Math.sin(py[s] * 2.7 + pz[s] * 1.9 + t * 0.9);
          const wy = Math.sin(px[s] * 2.3 - pz[s] * 2.1 + t * 0.7);
          const wz = Math.cos(px[s] * 1.7 + py[s] * 2.9 + t * 1.1);
          ux += wx * sw * dt;
          uy += wy * sw * 0.55 * dt;
          uz += wz * sw * dt;
        }
        uy += lift[s] * dt;

        vx[s] = ux; vy[s] = uy; vz[s] = uz;
        px[s] += ux * dt;
        py[s] += uy * dt;
        pz[s] += uz * dt;
        rot[s] += spin[s] * dt;
      }
    },

    /** Write the live subset into the instance buffers, farthest first. */
    upload() {
      if (activeCount > 1) sortByDepth();
      let n = 0;
      for (let i = 0; i < activeCount; i++) {
        const s = active[i];
        const f = age[s] / life[s];
        // Fast in, long tail out: dust hangs. A symmetric fade reads as a video-game poof.
        const fadeIn = f < 0.08 ? f / 0.08 : 1;
        const fadeOut = f < 0.42 ? 1 : 1 - (f - 0.42) / 0.58;
        const alpha = peak[s] * fadeIn * fadeOut * fadeOut;
        if (alpha <= 0.002) continue;
        const o3 = n * 3;
        const o4 = n * 4;
        iPos[o3] = px[s]; iPos[o3 + 1] = py[s]; iPos[o3 + 2] = pz[s];
        iQuad[o4] = sizeA[s] + (sizeB[s] - sizeA[s]) * f;
        iQuad[o4 + 1] = rot[s];
        iQuad[o4 + 2] = alpha;
        iQuad[o4 + 3] = cell[s];
        iTint[o4] = colR[s]; iTint[o4 + 1] = colG[s]; iTint[o4 + 2] = colB[s];
        iTint[o4 + 3] = add[s];
        n++;
      }
      geometry.instanceCount = n;
      mesh.visible = n > 0;
      if (n > 0) {
        aPos.needsUpdate = true;
        aQuad.needsUpdate = true;
        aTint.needsUpdate = true;
      }
      return n;
    },

    /** Camera basis for the billboards, in world space. */
    setCamera(camera) {
      const e = camera.matrixWorld.elements;
      material.uniforms.uCamRight.value.set(e[0], e[1], e[2]);
      material.uniforms.uCamUp.value.set(e[4], e[5], e[6]);
      camPos.set(e[12], e[13], e[14]);
    },

    setOpacity(v) {
      material.uniforms.uOpacity.value = v;
    },

    /** 0..1 — scales every emitter's share of the pool when the budget is turned down. */
    setBudgetScale(scale) {
      recomputeCaps(Math.max(0.05, Math.min(1, scale)));
    },

    clear() {
      for (let i = activeCount - 1; i >= 0; i--) release(active[i], i);
      activeCount = 0;
      freeCount = cap;
      for (let i = 0; i < cap; i++) { free[i] = cap - 1 - i; alive[i] = 0; }
      for (let i = 0; i < OWNER.COUNT; i++) ownerCount[i] = 0;
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
