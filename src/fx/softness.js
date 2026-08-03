// FX · analytic soft particles.
//
// THE PROBLEM. A billboard is a flat quad. Where it crosses the rug you get a razor-straight line
// across the puff — the single most recognisable "this is a real-time render" artefact there is.
// The textbook fix is a soft-particle fade: sample the scene depth buffer at the fragment, and
// fade the particle out as its own depth approaches the depth already in the buffer.
//
// WHY NOT THAT, HERE. The scene depth for this frame lives in the depth attachment of the
// composer's own render target (RENDER owns it, N8AO consumes it), and it is being written by the
// very pass our particles are drawn in. Sampling it there is a framebuffer feedback loop, which
// WebGL2 forbids. The alternatives are a second full scene pass into an FX-owned depth target
// (~300 duplicated draw calls for a room this dense) or inserting a pass into another module's
// composer. Both cost more than the artefact does.
//
// WHAT THIS DOES INSTEAD. The room is *known geometry*: LAYOUT gives us its shell and the eight
// large objects standing in it, and everything else in here is small enough that a particle never
// visibly intersects it. So the fade runs against an analytic proxy — the interior box, inverted,
// unioned with a handful of oriented-about-Y boxes for the sofa, the chaise, the ottoman, the
// armchair, the coffee table, the pouf and the playpen. `fxSoftness(p)` returns the distance from
// a world point to the nearest proxy surface, normalised by the particle's own radius, and the
// fragment shader multiplies alpha by it.
//
// The behaviour is the same as a depth-buffer fade in the case that matters (a puff sitting on the
// rug loses its lower half instead of being guillotined by it) and degrades gracefully in the case
// it cannot see (a puff behind the sofa fades a little early). It costs ~40 ALU and no passes.
//
// Box SDF: q = |p - c| - h ; d = |max(q,0)| + min(max(q.x,q.y,q.z), 0). Exact outside, a good
// approximation inside, which is all a fade needs.

import * as THREE from 'three';

/** How many furniture proxies the shader carries. Fixed so the loop is unrollable in GLSL ES 1.0. */
export const SOFT_BOXES = 7;

export const SOFTNESS_GLSL = /* glsl */ `
uniform vec3 uRoomMin;
uniform vec3 uRoomMax;
uniform vec3 uBoxC[ ${SOFT_BOXES} ];
uniform vec3 uBoxH[ ${SOFT_BOXES} ];

float fxBoxDistance( vec3 p, vec3 c, vec3 h ) {
  vec3 q = abs( p - c ) - h;
  return length( max( q, 0.0 ) ) + min( max( q.x, max( q.y, q.z ) ), 0.0 );
}

/** Distance from a world point to the nearest proxy surface in the room, in metres. */
float fxProxyDistance( vec3 p ) {
  vec3 a = p - uRoomMin;
  vec3 b = uRoomMax - p;
  float d = min( min( min( a.x, a.y ), a.z ), min( min( b.x, b.y ), b.z ) );
  for ( int i = 0; i < ${SOFT_BOXES}; i++ ) {
    d = min( d, fxBoxDistance( p, uBoxC[ i ], uBoxH[ i ] ) );
  }
  return d;
}

/** 0 at a surface, 1 once the fragment is one radius clear of everything. */
float fxSoftness( vec3 p, float radius ) {
  return clamp( fxProxyDistance( p ) / max( radius, 0.02 ), 0.0, 1.0 );
}
`;

/**
 * Build the uniform block from LAYOUT. Boxes are axis-aligned bounds of the real objects — the
 * armchair is turned 24° and the rug 2.5°, but a proxy that is a few centimetres generous is
 * exactly what a soft fade wants.
 */
export function makeSoftnessUniforms(layout) {
  const L = layout || {};
  const room = L.bounds?.interior || { x0: -3.4, x1: 3.4, y0: 0, y1: 2.78, z0: -4.6, z1: 3.4 };

  const centres = [];
  const halves = [];
  const push = (cx, cy, cz, hx, hy, hz) => {
    centres.push(new THREE.Vector3(cx, cy, cz));
    halves.push(new THREE.Vector3(Math.max(hx, 0.01), Math.max(hy, 0.01), Math.max(hz, 0.01)));
  };

  // Only the *solid lower body* of each piece is a proxy. A bounding box up to the back of the
  // sofa would swallow every puff kicked up off the seat cushions, which are open air as far as a
  // particle is concerned; the base and the seat pad are the parts that actually occlude one.
  const sofa = L.sofa;
  if (sofa) {
    const sy = sofa.seatY || 0.42;
    push(sofa.x, sy * 0.5, sofa.z, sofa.w * 0.5, sy * 0.5, sofa.d * 0.5);
    const ch = sofa.chaise;
    if (ch) push(ch.x, ch.h * 0.5, ch.z, ch.w * 0.5, ch.h * 0.5, ch.d * 0.5);
  }
  const ott = L.ottoman;
  if (ott) push(ott.x, ott.h * 0.5, ott.z, ott.w * 0.5, ott.h * 0.5, ott.d * 0.5);
  const arm = L.armchair;
  if (arm) {
    const sy = arm.seatY || 0.40;
    push(arm.x, sy * 0.5, arm.z, arm.w * 0.55, sy * 0.5, arm.d * 0.55);
  }
  const tbl = L.coffeeTable;
  if (tbl) push(tbl.x, tbl.h - 0.02, tbl.z, tbl.w * 0.5, 0.02, tbl.d * 0.5);
  const pouf = L.pouf;
  if (pouf) push(pouf.x, pouf.h * 0.5, pouf.z, pouf.radius, pouf.h * 0.5, pouf.radius);
  const pen = L.playpen;
  if (pen) push(pen.x, 0.03, pen.z, pen.w * 0.5, 0.03, pen.d * 0.5);

  // Pad or trim to exactly SOFT_BOXES; unused slots are a degenerate box buried under the floor.
  while (centres.length < SOFT_BOXES) {
    centres.push(new THREE.Vector3(0, -1000, 0));
    halves.push(new THREE.Vector3(0.01, 0.01, 0.01));
  }
  centres.length = SOFT_BOXES;
  halves.length = SOFT_BOXES;

  return {
    uRoomMin: { value: new THREE.Vector3(room.x0 + 0.01, room.y0, room.z0 + 0.01) },
    uRoomMax: { value: new THREE.Vector3(room.x1 - 0.01, room.y1 - 0.01, room.z1 - 0.01) },
    uBoxC: { value: centres },
    uBoxH: { value: halves },
  };
}
