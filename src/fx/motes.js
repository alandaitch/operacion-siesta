// FX · ambient dust. The single biggest "this is a real interior" cue in the whole build.
//
// A late-afternoon room with a five-metre window has visible dust in it, and nothing else on the
// screen tells you the air is a medium. This is one THREE.Points draw call carrying every mote in
// the flat, and it costs no CPU at all: the motes' resting positions are uploaded once and every
// bit of motion happens in the vertex shader as a closed-form function of time.
//
// THE SIMULATION, SUCH AS IT IS.
//  · Two out-of-phase sinusoid pairs per axis give a lissajous wander that never repeats visibly
//    and never drifts — a proper turbulence integration would need CPU state and would desync
//    between a screenshot and a live frame.
//  · A slow signed vertical rise, wrapped through fract(), is the room's convection. Motes fade in
//    at the end they enter and out at the end they leave, so the wrap is invisible.
//  · Scale: 4 mm of wander for a mote and roughly 40 seconds to cross the room's height. Dust does
//    not swirl; it hangs, and the moment you animate it faster than that it reads as snow.
//
// THE LOOK.
//  · Brightness is the beam term from ./beam.js (so motes light up *inside* the real god rays, in
//    the same mullion bands the volumetrics draw) times a Henyey–Greenstein phase, so crawling
//    round to face the window makes the air blaze and looking away kills it.
//  · Each mote carries a slowly tumbling pseudo-normal; a tight power lobe against the half vector
//    between the sun and the eye is what makes them *twinkle* as the camera moves rather than
//    sitting there as static white pixels. This is view-dependent, so it works in photo mode too.
//  · Point size is a real projected size clamped to 1–4.5 px: a mote is 30 µm of lint, it is
//    supposed to be at the resolution limit, and anything bigger reads as ash.
//
// Additive, depth-tested, depth-write off — so the sofa occludes the air in front of it correctly
// and the motes never darken anything.

import * as THREE from 'three';
import { makeRng } from '../core/rng.js';
import { BEAM_GLSL } from './beam.js';

const VERT = /* glsl */ `
precision highp float;

// position (declared by three's own prefix) is the mote's resting place in world space.
attribute vec4 aPhase;   // x,y: wander phases · z: wander radius · w: mote size (metres)
attribute vec2 aDrift;   // x: signed vertical rise (column fractions/second) · y: tumble rate

uniform float uTime;
uniform float uPixelScale;   // viewportHeight / (2 tan(fov/2))
uniform float uYMin;
uniform float uYMax;
uniform float uAmbient;
uniform vec3 uAmbientColour;
uniform float uOpacity;
uniform float uSizeScale;
uniform float uGain;

${BEAM_GLSL}

varying vec3 vColour;

void main() {
  float t = uTime;

  // --- the wander ---------------------------------------------------------------------------
  vec3 p = position;
  float w = aPhase.z;
  p.x += sin( t * 0.213 + aPhase.x ) * w + sin( t * 0.537 + aPhase.y * 1.73 ) * w * 0.42;
  p.z += cos( t * 0.191 + aPhase.y ) * w + cos( t * 0.463 + aPhase.x * 1.31 ) * w * 0.38;

  // --- the column ---------------------------------------------------------------------------
  float span = uYMax - uYMin;
  float f = fract( ( position.y - uYMin ) / span + t * aDrift.x );
  p.y = uYMin + f * span + sin( t * 0.171 + aPhase.y ) * w * 0.8;
  // Fade at both ends of the column so the wrap never pops.
  float wrapFade = smoothstep( 0.0, 0.06, f ) * ( 1.0 - smoothstep( 0.94, 1.0, f ) );

  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  float dist = - mv.z;
  gl_Position = projectionMatrix * mv;

  // --- brightness ---------------------------------------------------------------------------
  vec3 view = normalize( p - cameraPosition );
  float beam = fxBeam( p );
  float phase = clamp( fxPhase( view, 0.62 ) * 0.20, 0.0, 2.6 );

  // A tumbling facet: the twinkle is a specular lobe on a normal that turns slowly, evaluated
  // against the half vector between the sun and the eye. Motion of the camera alone makes it fire.
  float tt = t * aDrift.y;
  vec3 n = normalize( vec3(
    sin( tt + aPhase.x * 6.28 ),
    cos( tt * 0.73 + aPhase.y * 6.28 ),
    sin( tt * 1.31 + aPhase.x * 3.14 )
  ) );
  vec3 half_ = normalize( - uBeamTravel - view );
  float spark = pow( max( dot( n, half_ ), 0.0 ), 30.0 );

  float lit = uBeamIntensity * beam * ( 0.16 + 0.95 * phase ) * ( 0.32 + 2.45 * spark );
  vec3 colour = uBeamColour * lit + uAmbientColour * uAmbient * ( 0.55 + 0.75 * spark );

  // --- size ---------------------------------------------------------------------------------
  // A real dust mote is 30 um across: at 2 m it covers a fiftieth of a pixel, and a physically
  // projected size would render nothing at all. What you actually see in a photograph is the
  // lens' own blur circle, which barely changes with distance — so the size here is authored in
  // pixels with only a mild near-field swell, scaled by resolution so 4K does not get finer dust
  // than 1080p does.
  float px = clamp( aPhase.w * uSizeScale * ( 1.55 + 1.25 / max( dist, 0.30 ) ), 1.0, 4.6 );
  gl_PointSize = px;

  // Nothing hangs in the player's face, and the far corners of the room are not full of glitter.
  float near = smoothstep( 0.10, 0.42, dist );
  float far = 1.0 - smoothstep( 9.5, 13.5, dist );

  vColour = colour * ( wrapFade * near * far * uOpacity * uGain );
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vColour;
void main() {
  // A gaussian core with a wide, very faint halo: that halo is what makes a 2 px dot read as a
  // scattering particle rather than as a stuck pixel.
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot( d, d ) * 4.0;
  float core = exp( - r2 * 4.6 );
  float halo = exp( - r2 * 1.15 ) * 0.30;
  gl_FragColor = vec4( vColour * ( core + halo ), 1.0 );
}
`;

/**
 * @param {object} opts
 * @param {number} opts.count how many motes
 * @param {object} opts.layout LAYOUT
 * @param {object} opts.beam shared beam uniforms from ./beam.js
 */
export function createMoteField({ count, layout, beam }) {
  const bounds = layout?.bounds?.interior || { x0: -3.4, x1: 3.4, y0: 0, y1: 2.78, z0: -4.6, z1: 3.4 };
  const yMin = bounds.y0 + 0.06;
  const yMax = bounds.y1 - 0.10;

  const n = Math.max(0, count | 0);
  const home = new Float32Array(n * 3);
  const phase = new Float32Array(n * 4);
  const drift = new Float32Array(n * 2);

  // Deterministic, and biased: a bit over half the motes live in the slab of air the window light
  // actually crosses, because that is where the eye is going to look for them.
  const r = makeRng(0x0d05713);
  for (let i = 0; i < n; i++) {
    const nearWindow = r() < 0.62;
    const x0 = nearWindow ? -1.75 : bounds.x0 + 0.12;
    const x1 = nearWindow ? 3.30 : bounds.x1 - 0.12;
    const z0 = nearWindow ? -4.45 : bounds.z0 + 0.12;
    const z1 = nearWindow ? 1.10 : bounds.z1 - 0.12;
    home[i * 3] = x0 + (x1 - x0) * r();
    // Slightly denser low down, where the light lands and where the camera lives.
    home[i * 3 + 1] = yMin + (yMax - yMin) * (r() ** 1.28);
    home[i * 3 + 2] = z0 + (z1 - z0) * r();

    phase[i * 4] = r() * 6.2831853;
    phase[i * 4 + 1] = r() * 6.2831853;
    phase[i * 4 + 2] = 0.018 + r() * 0.055;                 // wander radius, metres
    phase[i * 4 + 3] = 0.72 + r() * r() * 1.15;             // apparent size, in pixels at 1 m

    // Mostly sinking, occasionally caught in an updraft — about 40 s to cross the room.
    drift[i * 2] = (r() < 0.34 ? 1 : -1) * (0.006 + r() * 0.020);
    drift[i * 2 + 1] = 0.35 + r() * 1.5;                    // tumble rate
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(home, 3));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 4));
  geometry.setAttribute('aDrift', new THREE.BufferAttribute(drift, 2));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.4, -0.6), 9);

  const material = new THREE.ShaderMaterial({
    name: 'fx.motes',
    uniforms: {
      ...beam,
      uTime: { value: 0 },
      uPixelScale: { value: 600 },
      uYMin: { value: yMin },
      uYMax: { value: yMax },
      uAmbient: { value: 0.030 },
      uAmbientColour: { value: new THREE.Color(0.72, 0.78, 0.92) },
      uOpacity: { value: 1 },
      uSizeScale: { value: 1 },
      uGain: { value: 1 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'fx.motes';
  points.frustumCulled = false;
  points.renderOrder = 11;
  points.matrixAutoUpdate = false;

  let drawn = n;
  let opacity = 1;
  const refresh = () => { points.visible = drawn > 0 && opacity > 0.002; };
  refresh();

  return {
    object3d: points,
    material,
    capacity: n,
    get count() { return drawn; },

    /**
     * Resolution and field of view. `uPixelScale` is metres→pixels at 1 m (kept for anything that
     * wants a true projected size); `uSizeScale` keeps the motes the same *angular* size on any
     * display, and widens them slightly on a narrow lens the way a real blur circle does.
     */
    setProjection(viewportHeight, fovDeg) {
      const t = Math.tan(THREE.MathUtils.degToRad(fovDeg) * 0.5);
      material.uniforms.uPixelScale.value = viewportHeight / (2 * Math.max(t, 1e-4));
      material.uniforms.uSizeScale.value = Math.max(0.55, viewportHeight / 1080) * (62 / Math.max(20, fovDeg)) ** 0.35;
    },

    /** Overall brightness of the field. LIGHT-independent; a taste control. */
    setGain(g) {
      material.uniforms.uGain.value = g;
    },

    setTime(t) {
      material.uniforms.uTime.value = t;
    },

    /** Draw only the first `k` motes. The field is generated once; this is how the budget bends. */
    setCount(k) {
      drawn = Math.max(0, Math.min(n, k | 0));
      geometry.setDrawRange(0, drawn);
      refresh();
      return drawn;
    },

    /** Global dimmer, so a menu or a game-over can pull the air back without a rebuild. */
    setOpacity(v) {
      opacity = v;
      material.uniforms.uOpacity.value = v;
      refresh();
    },

    /** How much non-sun light the air picks up — LIGHT's environment intensity drives this. */
    setAmbient(intensity, colour) {
      material.uniforms.uAmbient.value = intensity;
      if (colour) material.uniforms.uAmbientColour.value.copy(colour);
    },

    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
