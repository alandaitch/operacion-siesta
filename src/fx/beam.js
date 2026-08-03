// FX · the light-shaft volume, shared by the dust field and the sprite lighting.
//
// LIGHT publishes the beam that ./world/lighting/shafts.js rasterises (`ctx.fx.setLightShafts(...)`
// and the `light:shafts` event), and this file turns that description into the handful of uniforms
// a particle shader needs to ask "am I standing in the sun?".
//
// Beam space is deliberately the same non-orthogonal basis shafts.js uses — across = world X,
// up = world Y, along = the direction the photons travel — so a mote and the volumetric slice it
// is standing inside agree to the millimetre. Inverting that basis maps a world point to
// (across, up, along); a soft rectangular falloff on the first two and an exponential extinction on
// the third is the beam, and repeating the glazing's mullion pitch across `across` puts the window
// bars into it. That is why the motes brighten in bands: they are inside the same god rays.
//
// When `quality.volumetrics` is off LIGHT never builds the shafts at all, so we synthesise the beam
// from the glazing aperture in LAYOUT and the sun direction. The dust still knows where the light
// is on every tier — it just has no volume to sit inside.

import * as THREE from 'three';

export const BEAM_GLSL = /* glsl */ `
uniform mat3 uBeamInv;
uniform vec3 uBeamOrigin;
uniform vec2 uBeamHalf;
uniform vec3 uBeamTravel;
uniform vec3 uBeamColour;
uniform float uBeamIntensity;
uniform float uBeamLength;
uniform float uBeamPitch;

/** 0..1 — how much sun is reaching this world point through the glazing. */
float fxBeam( vec3 p ) {
  vec3 bs = uBeamInv * ( p - uBeamOrigin );
  float s = bs.z;
  if ( s < 0.0 || s > uBeamLength ) return 0.0;
  vec2 q = abs( bs.xy ) / uBeamHalf;
  float radial = ( 1.0 - smoothstep( 0.80, 1.0, q.x ) ) * ( 1.0 - smoothstep( 0.78, 1.0, q.y ) );
  if ( radial <= 0.0 ) return 0.0;
  // the mullions, at the glazing's real pitch
  float ax = bs.x + uBeamHalf.x;
  float ph = mod( ax, uBeamPitch );
  float bar = smoothstep( 0.010, 0.058, min( ph, uBeamPitch - ph ) );
  // the sheer panel hanging flat across the right third scatters rather than blocks
  float sheer = smoothstep( 1.84, 1.98, ax ) * ( 1.0 - smoothstep( 2.90, 3.04, ax ) );
  bar *= mix( 1.0, 0.40, sheer );
  float along = exp( - s * 0.11 ) * smoothstep( 0.0, 0.45, s );
  return radial * bar * along;
}

/** Henyey-Greenstein forward scattering for a view direction (fragment → eye is -view). */
float fxPhase( vec3 viewDir, float g ) {
  float mu = - dot( viewDir, uBeamTravel );
  float gg = g * g;
  return ( 1.0 - gg ) / pow( 1.0 + gg - 2.0 * g * mu, 1.5 );
}
`;

const _basis = new THREE.Matrix3();

/** Allocate the uniform block. One instance is shared by every FX shader. */
export function createBeamUniforms(layout) {
  const g = layout?.glazing || { x0: -1.6, x1: 3.4, sillY: 0.06, headY: 2.5, z: -4.6, mullionSpacing: 1.0 };
  const halfX = (g.x1 - g.x0) * 0.5;
  const halfY = (g.headY - g.sillY) * 0.5;
  return {
    uBeamInv: { value: new THREE.Matrix3() },
    uBeamOrigin: { value: new THREE.Vector3((g.x0 + g.x1) * 0.5, (g.sillY + g.headY) * 0.5, g.z + 0.05) },
    uBeamHalf: { value: new THREE.Vector2(halfX, halfY) },
    uBeamTravel: { value: new THREE.Vector3(0.32, -0.30, 0.90).normalize() },
    uBeamColour: { value: new THREE.Color(1.0, 0.94, 0.84) },
    uBeamIntensity: { value: 0.0 },
    uBeamLength: { value: 9.0 },
    uBeamPitch: { value: g.mullionSpacing || 1.0 },
  };
}

/**
 * Point the beam. `travel` is the direction photons move (i.e. −sunDir).
 * The basis is non-orthogonal on purpose — see the header.
 */
export function aimBeam(uniforms, travel) {
  const t = uniforms.uBeamTravel.value;
  t.copy(travel).normalize();
  if (Math.abs(t.z) < 1e-3) t.z = t.z < 0 ? -1e-3 : 1e-3; // the basis is singular edge-on to the glass
  _basis.set(
    1, 0, t.x,
    0, 1, t.y,
    0, 0, t.z,
  );
  uniforms.uBeamInv.value.copy(_basis).invert();
}

/**
 * Adopt the *geometry* LIGHT published — the payload of `light:shafts`
 * (`{ enabled, origin, direction, aperture, length, half, colour, intensity }`). Brightness is not
 * taken from here: on medium and low there are no shafts at all and the dust still has to know
 * where the sun is, so `setBeamLight` drives that from the daylight state instead.
 */
export function applyShaftPayload(uniforms, payload) {
  if (!payload || !payload.direction) return false;
  aimBeam(uniforms, payload.direction);
  if (payload.origin) {
    uniforms.uBeamOrigin.value.set(payload.origin.x, payload.origin.y, payload.origin.z + 0.05);
  }
  if (payload.half) uniforms.uBeamHalf.value.set(payload.half.x, payload.half.y);
  if (payload.length) uniforms.uBeamLength.value = payload.length;
  return true;
}

/** Colour and strength of the sun arriving through the glazing, straight off the daylight curve. */
export function setBeamLight(uniforms, colour, intensity) {
  if (colour) uniforms.uBeamColour.value.copy(colour);
  uniforms.uBeamIntensity.value = intensity < 0 ? 0 : intensity;
}
