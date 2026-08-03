// LIGHT · god rays through the glazing, as participating media rather than as a lens flare.
//
// THE SHAPE OF THE PROBLEM. A light shaft is an integral of scattered radiance along the view ray
// through a volume. Two cheap ways to fake it both fail here: a screen-space radial blur off the
// sun's screen position is a *lens* artefact and dies the moment the sun is off-frame (which it
// almost always is at 15° elevation from a camera 42 cm off the floor), and a solid extruded box
// with additive blending has no idea what is in front of it, so the beam paints straight over the
// ottoman.
//
// WHAT THIS DOES INSTEAD. The beam volume is the whole window aperture extruded along the sun
// direction — a sheared box, because an oblique extrusion of a rectangle is not a rotated box. It
// is rasterised as a stack of camera-facing slices, the classic billboard-slicing approach:
//
//   · each frame the eight corners of the volume are projected onto the camera axis to get the
//     depth range the beam occupies, and N slice planes are spread across it;
//   · for each slice, the corners are perspective-projected onto that plane and the 2D bounding
//     box taken, so a slice covers the beam's actual footprint and nothing else — the difference
//     between ~15% of the screen and 100% of it, N times over;
//   · slices are drawn additively with depth *test* on and depth write off. That is where the
//     depth awareness comes from: any slice behind the sofa fails the test and vanishes, so the
//     beam is genuinely occluded by the room instead of being painted on top of it.
//
// The fragment shader does the rest analytically. World position → beam space through a
// precomputed inverse basis gives (a, b, s): across the aperture, up the aperture, and along the
// beam. Soft rectangular falloff on (a, b), exponential extinction on s, an aperture mask that
// reproduces the mullion shadows and the sheer curtain's attenuation as a function of `a` alone,
// two octaves of drifting value noise for the turbulence, and a Henyey–Greenstein phase term so
// the beam blooms when you crawl around to look up it and fades when you look across it.
//
// r06 review (two blockers on `godrays`, one major on `curtains`): the volume had no occlusion
// term at all — every fragment inside the sheared box scattered equally regardless of whether the
// sofa, a wall or the ottoman stood between it and the sun, so a room full of furniture produced a
// uniform glow dome instead of beams with any shape. The textbook fix is a dedicated depth pass
// from the sun, but this project already renders one every time the shadow map updates (see
// lighting.js's `sun`) — CONTRACTS' "no per-frame full-scene pass" rule is about *adding* a pass,
// not reusing one that already exists, so `createShafts(ctx, sun)` now takes the sun light and
// samples its existing RGBA-packed shadow map directly in the fragment shader (4-tap rotated
// Poisson, same deterministic per-pixel hash as softshadow.js, so photo mode stays byte-identical
// per CONTRACTS §7). Zero extra render targets, zero extra draw calls.
//
// Costs nothing when `quality.volumetrics` is false — the module is never constructed.

import * as THREE from 'three';

const VERT = /* glsl */ `
precision highp float;
varying vec3 vWorldPos;
void main() {
  // Slices are authored directly in world space; the model matrix is here only so the mesh
  // survives being parented to a transformed group.
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform mat3 uBeamInv;      // world → beam space (columns: across, up, along)
uniform vec3 uBeamOrigin;   // centre of the aperture, on the glass plane
uniform vec2 uBeamHalf;     // half-width / half-height of the aperture, metres
uniform float uBeamLen;
uniform vec3 uTravel;       // unit vector the photons travel along
uniform vec3 uColour;
uniform float uIntensity;
uniform float uSlab;        // metres of depth each slice stands in for
uniform float uTime;
uniform float uExtinction;
uniform vec3 uRoomMin;
uniform vec3 uRoomMax;
uniform sampler2D uSunShadowMap;
uniform mat4 uSunShadowMatrix;
uniform vec2 uSunShadowTexel;
uniform float uUseShadow;

varying vec3 vWorldPos;

// Same RGBA depth packing three.js's own shadow chunk uses (see WebGLShadowMap's MeshDepthMaterial
// with RGBADepthPacking) — the sun's shadow map is a plain colour target, not a depth texture.
float napUnpackDepth( vec4 v ) {
  return dot( v, vec4( 1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0 ) );
}

// Fraction of a small rotated-Poisson disc that is unoccluded from the sun at this world point.
// Reuses the sun's existing shadow map (see the module header) — no extra pass, no extra target.
// A floor under the occluded case rather than a hard 0: the beam is participating media, and even
// the shadowed side of the room still has some scattered skylight in the air.
float sunOcclusion( vec3 worldPos ) {
  if ( uUseShadow < 0.5 ) return 1.0;
  vec4 sc = uSunShadowMatrix * vec4( worldPos, 1.0 );
  if ( sc.z <= 0.0 || sc.z >= 1.0 || sc.x <= 0.0 || sc.x >= 1.0 || sc.y <= 0.0 || sc.y >= 1.0 ) return 1.0;
  float ign = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
  float ang = ign * 6.28318530718;
  float cs = cos( ang );
  float sn = sin( ang );
  vec2 d0 = vec2( 0.68, 0.18 );
  vec2 d1 = vec2( -0.18, 0.68 );
  vec2 d2 = vec2( -0.68, -0.18 );
  vec2 d3 = vec2( 0.18, -0.68 );
  float bias = 0.0018;
  float lit = 0.0;
  lit += step( sc.z - bias, napUnpackDepth( texture2D( uSunShadowMap, sc.xy + vec2( d0.x * cs - d0.y * sn, d0.x * sn + d0.y * cs ) * uSunShadowTexel * 2.0 ) ) );
  lit += step( sc.z - bias, napUnpackDepth( texture2D( uSunShadowMap, sc.xy + vec2( d1.x * cs - d1.y * sn, d1.x * sn + d1.y * cs ) * uSunShadowTexel * 2.0 ) ) );
  lit += step( sc.z - bias, napUnpackDepth( texture2D( uSunShadowMap, sc.xy + vec2( d2.x * cs - d2.y * sn, d2.x * sn + d2.y * cs ) * uSunShadowTexel * 2.0 ) ) );
  lit += step( sc.z - bias, napUnpackDepth( texture2D( uSunShadowMap, sc.xy + vec2( d3.x * cs - d3.y * sn, d3.x * sn + d3.y * cs ) * uSunShadowTexel * 2.0 ) ) );
  return mix( 0.35, 1.0, lit * 0.25 );
}

float nhash( vec3 p ) {
  p = fract( p * 0.3183099 + vec3( 0.11, 0.17, 0.23 ) );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
float vnoise3( vec3 x ) {
  vec3 i = floor( x );
  vec3 f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( mix( nhash( i + vec3( 0.0, 0.0, 0.0 ) ), nhash( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ),
         mix( nhash( i + vec3( 0.0, 1.0, 0.0 ) ), nhash( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),
    mix( mix( nhash( i + vec3( 0.0, 0.0, 1.0 ) ), nhash( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ),
         mix( nhash( i + vec3( 0.0, 1.0, 1.0 ) ), nhash( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ), f.z );
}

// What the glazing lets through, as a function of position across the aperture. Slim matte black
// mullions every 1.05 m, one sheer panel hanging flat across x 0.30…1.40, and the two gathered
// bundles at either end — which scatter rather than block, so they dim the beam without cutting it.
float apertureMask( float ax, float by ) {
  float ph = mod( ax, 1.05 );
  float d = min( ph, 1.05 - ph );
  // r06 ("godrays" blocker): this cut was so narrow (~6 cm either side of a mullion) that ~95% of
  // the 5 m aperture was one uncut slab with no high-frequency shape to make beams out of. Widened
  // so the mullion shadow is actually legible in the volume, and the flat sheer panel now blocks
  // most of the beam behind it (was 0.34, i.e. barely dimming it) so it reads as a dark band.
  float m = smoothstep( 0.020, 0.11, d );
  float flat_ = smoothstep( 1.86, 1.98, ax ) * ( 1.0 - smoothstep( 2.92, 3.04, ax ) );
  m *= mix( 1.0, 0.18, flat_ );
  float bundleL = smoothstep( 0.24, 0.06, abs( ax - 0.10 ) );
  float bundleR = smoothstep( 0.26, 0.06, abs( ax - 4.80 ) );
  m *= mix( 1.0, 0.46, max( bundleL, bundleR ) );
  // the head and sill frames
  m *= smoothstep( 0.0, 0.09, by ) * ( 1.0 - smoothstep( 2.35, 2.44, by ) );
  return m;
}

void main() {
  vec3 rel = vWorldPos - uBeamOrigin;
  vec3 bs = uBeamInv * rel;                    // ( across, up, along )

  float s = bs.z;
  if ( s < 0.0 || s > uBeamLen ) discard;

  vec2 q = abs( bs.xy ) / uBeamHalf;
  float radial = ( 1.0 - smoothstep( 0.80, 1.0, q.x ) ) * ( 1.0 - smoothstep( 0.78, 1.0, q.y ) );
  if ( radial <= 0.0015 ) discard;

  // where this ray started life on the glass
  float ax = ( bs.x + uBeamHalf.x );
  float by = ( bs.y + uBeamHalf.y );
  float gate = apertureMask( ax, by );
  if ( gate <= 0.004 ) discard;

  // the air thins out along the beam, and there is nothing to scatter right at the glass
  float along = exp( - s * uExtinction ) * smoothstep( 0.0, 0.55, s );

  // keep it inside the room: the volume runs on past the walls and the floor
  vec3 fade = min( ( vWorldPos - uRoomMin ) / 0.35, ( uRoomMax - vWorldPos ) / 0.35 );
  float room = clamp( min( min( fade.x, fade.y ), fade.z ), 0.0, 1.0 );
  if ( room <= 0.0 ) discard;

  // dust turbulence: two octaves drifting slowly along the beam and rising on the room's thermals
  vec3 np = vWorldPos * 1.35 + uTravel * ( uTime * 0.11 ) + vec3( 0.0, uTime * 0.035, 0.0 );
  float n = vnoise3( np ) * 0.62 + vnoise3( np * 2.7 + 13.1 ) * 0.38;
  float turb = 0.52 + 0.72 * n;

  // Henyey–Greenstein forward scattering. Light leaves the fragment along -view, so the
  // scattering cosine against the photons' direction of travel is -dot( view, travel ): the beam
  // blazes when you crawl round and face the window, and thins when you look along it.
  vec3 view = normalize( vWorldPos - cameraPosition );
  float mu = - dot( view, uTravel );
  // r06 ("armchair", "curtains"): g=0.66 gave the view-aligned case (camera facing back up the
  // beam toward the window, which is exactly how several review framings are set up) a ~14x peak
  // over the view-perpendicular case, on top of an already-unoccluded volume — together an
  // additive veil with no pixel below sRGB 84. Softened to g=0.42 (still clearly forward-scattering
  // haze, not a diffuse fog) so the ratio tops out under 4x, and the phase clamp now bounds it
  // explicitly rather than relying on the softened g alone.
  const float g = 0.42;
  float hg = ( 1.0 - g * g ) / pow( 1.0 + g * g - 2.0 * g * mu, 1.5 );
  float phase = 0.32 + 0.68 * clamp( hg * 0.30, 0.0, 1.3 );

  // no wall of glow in the player's face when the baby crawls into the beam
  float near = smoothstep( 0.10, 0.65, length( vWorldPos - cameraPosition ) );

  float occlusion = sunOcclusion( vWorldPos );

  float density = radial * gate * along * room * turb * phase * near * occlusion * uSlab * uIntensity;
  gl_FragColor = vec4( uColour * density, 1.0 );
}
`;

/** The glazing aperture, straight out of CONTRACTS §2. */
const APERTURE = { x0: -1.60, x1: 3.40, y0: 0.06, y1: 2.50, z: -4.55 };
const BEAM_LENGTH = 9.0;

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _basis = new THREE.Matrix3();

export function createShafts(ctx, sun) {
  const tier = ctx.quality?.tier || 'high';
  const SLICES = tier === 'ultra' ? 22 : 14;

  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(SLICES * 4 * 3);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const index = new Uint16Array(SLICES * 6);
  for (let i = 0; i < SLICES; i++) {
    const v = i * 4;
    index.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
  }
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.2, -1.5), 14);

  const material = new THREE.ShaderMaterial({
    name: 'light.shafts',
    uniforms: {
      uBeamInv: { value: new THREE.Matrix3() },
      uBeamOrigin: { value: new THREE.Vector3() },
      uBeamHalf: { value: new THREE.Vector2(1, 1) },
      uBeamLen: { value: BEAM_LENGTH },
      uTravel: { value: new THREE.Vector3(0, 0, 1) },
      uColour: { value: new THREE.Color(1, 0.93, 0.82) },
      uIntensity: { value: 0 },
      uSlab: { value: 0.4 },
      uTime: { value: 0 },
      uExtinction: { value: 0.115 },
      uRoomMin: { value: new THREE.Vector3(-3.34, -0.02, -4.55) },
      uRoomMax: { value: new THREE.Vector3(3.34, 2.72, 3.30) },
      uSunShadowMap: { value: null },
      uSunShadowMatrix: { value: new THREE.Matrix4() },
      uSunShadowTexel: { value: new THREE.Vector2(1 / 2048, 1 / 2048) },
      uUseShadow: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'light.shafts';
  mesh.frustumCulled = false;
  mesh.renderOrder = 12;
  mesh.matrixAutoUpdate = false;
  mesh.visible = false;

  // The eight world-space corners of the beam volume, rebuilt whenever the sun moves.
  const corners = [];
  for (let i = 0; i < 8; i++) corners.push(new THREE.Vector3());
  const travel = new THREE.Vector3(0, 0, 1);
  const origin = new THREE.Vector3(
    (APERTURE.x0 + APERTURE.x1) * 0.5,
    (APERTURE.y0 + APERTURE.y1) * 0.5,
    APERTURE.z,
  );
  const half = new THREE.Vector2((APERTURE.x1 - APERTURE.x0) * 0.5, (APERTURE.y1 - APERTURE.y0) * 0.5);
  material.uniforms.uBeamOrigin.value.copy(origin);
  material.uniforms.uBeamHalf.value.copy(half);

  let intensity = 0;

  /** Rebuild the sheared box and the world→beam basis for a new sun direction. */
  function setSun(sunDir) {
    travel.copy(sunDir).negate().normalize();
    material.uniforms.uTravel.value.copy(travel);
    // Beam space is deliberately non-orthogonal: across = world X, up = world Y, along = travel.
    // Inverting that basis is what maps a world point onto (a, b, s) inside the extrusion.
    _basis.set(
      1, 0, travel.x,
      0, 1, travel.y,
      0, 0, travel.z,
    );
    material.uniforms.uBeamInv.value.copy(_basis).invert();

    let k = 0;
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sx = -1; sx <= 1; sx += 2) {
        const px = origin.x + sx * half.x;
        const py = origin.y + sy * half.y;
        corners[k++].set(px, py, origin.z);
        corners[k++].set(
          px + travel.x * BEAM_LENGTH,
          py + travel.y * BEAM_LENGTH,
          origin.z + travel.z * BEAM_LENGTH,
        );
      }
    }
  }

  /** Colour + strength for the current time of day. 0 hides the mesh entirely. */
  function setState(d) {
    material.uniforms.uColour.value.copy(d.shaftColour);
    intensity = d.shaftIntensity * Math.min(1, 0.25 + d.sunIntensity * 0.28);
    // r06: dropped from 0.55 alongside the occlusion + aperture-mask changes above — the additive
    // veil on `curtains`/`godrays` was partly an unoccluded volume and partly this being tuned for
    // a volume with no ceiling on it. Re-verified against both shots with histogram.mjs.
    material.uniforms.uIntensity.value = intensity * 0.40;
  }

  /**
   * Lay the slice stack out for this frame's camera. Returns false when the beam is entirely
   * behind the camera, in which case nothing is drawn at all.
   */
  function layout(camera) {
    if (intensity <= 0.008) {
      mesh.visible = false;
      return false;
    }
    mesh.visible = true;

    // Bind whatever the sun's own shadow pass produced this update — see the module header. The
    // map is null until the first shadow render has happened, and `shadow.matrix`/`mapSize` are
    // only meaningful once `updateMatrices()` has run at least once, so this degrades gracefully
    // to "unoccluded" (the old behaviour) rather than sampling garbage.
    const sm = sun?.shadow;
    if (sm?.map?.texture) {
      material.uniforms.uSunShadowMap.value = sm.map.texture;
      material.uniforms.uSunShadowMatrix.value.copy(sm.matrix);
      material.uniforms.uSunShadowTexel.value.set(1 / sm.mapSize.x, 1 / sm.mapSize.y);
      material.uniforms.uUseShadow.value = 1;
    } else {
      material.uniforms.uUseShadow.value = 0;
    }
    camera.getWorldPosition(_camPos);
    camera.getWorldDirection(_fwd);
    _up.set(0, 1, 0);
    _right.crossVectors(_fwd, _up);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(_right, _fwd).normalize();

    let dMin = Infinity;
    let dMax = -Infinity;
    for (let i = 0; i < 8; i++) {
      const d = _v.copy(corners[i]).sub(_camPos).dot(_fwd);
      if (d < dMin) dMin = d;
      if (d > dMax) dMax = d;
    }
    const nearest = Math.max(camera.near + 0.06, 0.12);
    dMin = Math.max(dMin, nearest);
    dMax = Math.min(dMax, 26);
    if (!(dMax > dMin + 1e-3)) {
      mesh.visible = false;
      return false;
    }

    const slab = (dMax - dMin) / SLICES;
    material.uniforms.uSlab.value = Math.min(1.6, slab) * 0.85;

    const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const tanW = tanH * camera.aspect;
    let p = 0;
    for (let i = 0; i < SLICES; i++) {
      // Far slices first: additive blending does not care about order, but drawing back to front
      // keeps early-Z rejection working in our favour when the room occludes the far end.
      const d = dMax - slab * (i + 0.5);
      let aMin = Infinity;
      let aMax = -Infinity;
      let bMin = Infinity;
      let bMax = -Infinity;
      for (let c = 0; c < 8; c++) {
        _v.copy(corners[c]).sub(_camPos);
        const cd = _v.dot(_fwd);
        if (cd < 0.02) {
          // A corner behind the camera projects to infinity — take the whole frustum instead.
          aMin = -tanW * d; aMax = tanW * d; bMin = -tanH * d; bMax = tanH * d;
          break;
        }
        const k = d / cd;
        const a = _v.dot(_right) * k;
        const b = _v.dot(_up) * k;
        if (a < aMin) aMin = a;
        if (a > aMax) aMax = a;
        if (b < bMin) bMin = b;
        if (b > bMax) bMax = b;
      }
      const mg = slab * 0.6 + 0.05;
      aMin = Math.max(aMin - mg, -tanW * d);
      aMax = Math.min(aMax + mg, tanW * d);
      bMin = Math.max(bMin - mg, -tanH * d);
      bMax = Math.min(bMax + mg, tanH * d);
      if (aMax <= aMin || bMax <= bMin) {
        // Degenerate slice — collapse it to a point so it rasterises nothing.
        for (let q = 0; q < 4; q++) {
          positions[p++] = _camPos.x;
          positions[p++] = _camPos.y;
          positions[p++] = _camPos.z;
        }
        continue;
      }
      const cx = _camPos.x + _fwd.x * d;
      const cy = _camPos.y + _fwd.y * d;
      const cz = _camPos.z + _fwd.z * d;
      const quad = [[aMin, bMin], [aMax, bMin], [aMax, bMax], [aMin, bMax]];
      for (let q = 0; q < 4; q++) {
        const [a, b] = quad[q];
        positions[p++] = cx + _right.x * a + _up.x * b;
        positions[p++] = cy + _right.y * a + _up.y * b;
        positions[p++] = cz + _right.z * a + _up.z * b;
      }
    }
    geometry.attributes.position.needsUpdate = true;
    return true;
  }

  return {
    mesh,
    slices: SLICES,
    setSun,
    setState,
    layout,
    setTime(t) {
      material.uniforms.uTime.value = t;
    },
    get intensity() {
      return intensity;
    },
    /** The volume FX should fill with dust motes. */
    describe() {
      return {
        origin: origin.clone(),
        direction: travel.clone(),
        aperture: { ...APERTURE },
        length: BEAM_LENGTH,
        half: { x: half.x, y: half.y },
        colour: material.uniforms.uColour.value.clone(),
        intensity,
      };
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
