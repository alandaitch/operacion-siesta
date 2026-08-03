// LIGHT · the procedural sky and the image-based lighting rig.
//
// There is no .hdr in this project and there never will be, so the environment is *rendered*.
// Two things are built here from the same shader:
//
//  1. THE BACKDROP. A dome carrying an analytic winter sky — cool grey-blue zenith, a warm haze
//     band wrapped around the horizon and biased toward the sun's azimuth, long flat cloud
//     striation, an HDR sun disc, and a terracotta roofline where the neighbours' brick flank cuts
//     the skyline. Rendered once into a HalfFloat cube target and handed to `scene.background`, so
//     the window looks at real radiance rather than at a flat card.
//
//  2. THE PROBE. A crude proxy of *this specific room* — floor, cream rug with the sunlit strip
//     the window throws across it, ceiling slab, four walls, the sofa's cream flank, the ply shelf
//     run, and a window wall built as four pieces around an open aperture so the sky pours straight
//     through it. Run through PMREMGenerator that becomes the env map. This is the whole reason the
//     room reads as an interior: ambient arriving from the window direction is bright and cool,
//     ambient from the corners is dim, ambient from below is warm rug bounce. A plain hemisphere
//     light cannot do that and it is exactly what makes cheap real-time interiors look flat.
//
// Everything is authored above 1.0 in linear so the composer's ACES has something to roll off.
// The probe is baked at the origin of a scene whose contents are the real room translated by
// -PROBE, i.e. the probe sits at roughly a standing adult's eye — a compromise that keeps the
// window's solid angle honest for furniture at both baby and sofa height.

import * as THREE from 'three';

/** Where the single environment probe lives, in world space. */
export const PROBE = new THREE.Vector3(0.0, 1.05, -0.80);

const SKY_VERT = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uHaze;
uniform vec3 uGround;
uniform vec3 uCity;
uniform vec3 uSunColour;
uniform vec3 uSunDir;
uniform float uSunDisc;
uniform float uGain;
uniform float uCloud;
varying vec3 vWorldPos;

float h21( vec2 p ) {
  p = fract( p * vec2( 443.897, 441.423 ) );
  p += dot( p, p.yx + 19.19 );
  return fract( ( p.x + p.y ) * p.x );
}
float vnoise2( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( h21( i ), h21( i + vec2( 1.0, 0.0 ) ), u.x ),
              mix( h21( i + vec2( 0.0, 1.0 ) ), h21( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
float fbm2( vec2 p ) {
  float s = 0.0;
  float a = 0.5;
  for ( int i = 0; i < 4; i ++ ) { s += a * vnoise2( p ); p *= 2.03; a *= 0.5; }
  return s;
}

void main() {
  vec3 d = normalize( vWorldPos );
  float up = clamp( d.y, 0.0, 1.0 );

  vec3 sky = mix( uHorizon, uZenith, pow( up, 0.52 ) );

  // Warm haze hugging the horizon, strongest in the sun's quarter of the sky.
  vec2 fd = normalize( vec2( d.x, d.z ) + 1e-5 );
  vec2 fs = normalize( vec2( uSunDir.x, uSunDir.z ) + 1e-5 );
  float az = max( dot( fd, fs ), 0.0 );
  float low = pow( 1.0 - up, 3.0 );
  sky = mix( sky, uHaze, low * ( 0.28 + 0.72 * pow( az, 2.2 ) ) );

  // Winter overcast: long bands, stretched horizontally, thinning toward the zenith.
  float band = fbm2( vec2( fd.x * 2.2 + fd.y * 0.7, up * 6.5 ) * 1.6 + uCloud );
  float cloud = smoothstep( 0.44, 0.86, band ) * ( 0.22 + 0.5 * up );
  sky = mix( sky, sky * 1.24 + uHaze * 0.10, cloud );

  // The sun: a ~2.8°-wide disc (fatter than the real 0.53° so a 256² cube face can hold it
  // without scintillating) plus two halo lobes for the forward-scattered aureole.
  float cd = dot( d, uSunDir );
  float disc = smoothstep( 0.99940, 0.99978, cd );
  float halo = pow( max( cd, 0.0 ), 260.0 ) * 0.55 + pow( max( cd, 0.0 ), 22.0 ) * 0.09;
  vec3 col = sky + uSunColour * ( disc * uSunDisc + halo * uSunDisc * 0.055 );

  // A terracotta roofline right on the skyline, then the street below it.
  float roof = smoothstep( 0.060, 0.018, d.y ) * smoothstep( -0.035, 0.006, d.y );
  col = mix( col, uCity, roof * 0.7 );
  col = mix( col, uGround, smoothstep( 0.008, -0.05, d.y ) );

  gl_FragColor = vec4( col * uGain, 1.0 );
}
`;

/** The shared sky shader. One instance drives both the backdrop dome and the probe dome. */
export function createSkyMaterial() {
  return new THREE.ShaderMaterial({
    name: 'light.sky',
    uniforms: {
      uZenith: { value: new THREE.Color(0x7f9dc0) },
      uHorizon: { value: new THREE.Color(0xc6d3dd) },
      uHaze: { value: new THREE.Color(0xf2e6cd) },
      uGround: { value: new THREE.Color(0x4b443a) },
      uCity: { value: new THREE.Color(0x8d5f4c) },
      uSunColour: { value: new THREE.Color(1, 0.92, 0.82) },
      uSunDir: { value: new THREE.Vector3(-0.34, 0.27, -0.90) },
      uSunDisc: { value: 55 },
      uGain: { value: 3.1 },
      uCloud: { value: 4.31 },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    // The dome is the farthest thing in either bake scene, so it behaves as a skybox: written
    // first (renderOrder -1) and depth-tested, which lets the room proxy panels sit in front of it
    // without the far dome overwriting them when three sorts opaques front-to-back.
    depthWrite: true,
    depthTest: true,
    fog: false,
    toneMapped: false,
  });
}

/** Push a daylight state into the sky shader's uniforms. */
export function applySkyState(material, d) {
  const u = material.uniforms;
  u.uZenith.value.copy(d.skyZenith);
  u.uHorizon.value.copy(d.skyHorizon);
  u.uHaze.value.copy(d.skyHaze);
  u.uGround.value.copy(d.skyGround);
  u.uCity.value.copy(d.skyCity);
  u.uSunColour.value.copy(d.sunColour);
  u.uSunDir.value.copy(d.sunDir);
  u.uSunDisc.value = d.sunDisc;
  u.uGain.value = d.skyGain;
}

// ---------------------------------------------------------------------------------------------
// proxy helpers

const _c = new THREE.Color();
const _amb = new THREE.Color();
const _key = new THREE.Color();
const _tint = new THREE.Color();

/** An unlit emitter plane. `gain` is a linear multiplier — values above 1 are the point. */
function panel(w, h, hex, gain) {
  _c.setHex(hex, THREE.SRGBColorSpace);
  const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, fog: false, toneMapped: false });
  mat.color.setRGB(_c.r * gain, _c.g * gain, _c.b * gain, THREE.LinearSRGBColorSpace);
  mat.userData.baseHex = hex;
  mat.userData.baseGain = gain;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.matrixAutoUpdate = false;
  return mesh;
}

function place(mesh, x, y, z, rx = 0, ry = 0, rz = 0) {
  mesh.position.set(x - PROBE.x, y - PROBE.y, z - PROBE.z);
  mesh.rotation.set(rx, ry, rz);
  mesh.updateMatrix();
  return mesh;
}

/**
 * The radiance proxy of the room. Returns the scene plus a `tune(d)` that rescales every panel
 * for the current daylight, so a rebake at 18:40 is genuinely a different room, not the same one
 * dimmed.
 */
export function createProbeScene(skyMaterial) {
  const scene = new THREE.Scene();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(90, 24, 16), skyMaterial);
  dome.matrixAutoUpdate = false;
  dome.renderOrder = -1;
  dome.updateMatrix();
  scene.add(dome);

  const H = Math.PI / 2;
  const panels = [];
  /**
   * `sunLit` is a *brightness* weight: how much brighter this surface gets when the key is up.
   * `warm` is a separate *hue* weight, 0 = this surface only ever sees skylight, 1 = its radiance
   * is the low sun bouncing straight off it. The two are deliberately not the same number. The
   * sheers are the brightest thing in the room (sunLit 2.6) but they are a diffuser hung in front
   * of the whole sky, so their hue is mostly daylight, not sunset. Collapsing the two into one
   * value is what used to smear an amber tint over the entire probe.
   * @param {THREE.Mesh} m @param {number} sunLit @param {number} warm 0..1
   */
  const add = (m, sunLit = 0, warm = 0.25) => {
    m.userData.sunLit = sunLit;
    m.userData.warm = warm;
    panels.push(m);
    scene.add(m);
    return m;
  };

  // floor + rug ------------------------------------------------------------------------------
  // r06 finding ("floor"): this dark warm-brown card was the single biggest panel in the probe
  // (the whole 6.8x8.0 footprint) and it dominated the low hemisphere of every PMREM bake, which
  // is why every shadowed cream surface in the game — the ottoman, the rug itself, the underside
  // of the sofa — rendered saddle-brown (r/b 2.0) instead of the cool/neutral bounce the brief
  // asks for. Lightened and desaturated so it stops being the loudest thing below the horizon, and
  // the cream rug panel raised so *it* is what the low hemisphere actually sees.
  add(place(panel(6.8, 8.0, 0x7d6a58, 0.22), 0, 0.001, -0.6, -H), 0.35, 0.45);
  add(place(panel(4.6, 4.0, 0xd9cebb, 0.85), 0.9, 0.012, -1.8, -H, 0, 0.045), 1.05, 0.35);
  // the long rectangle the low sun throws across the rug — the single brightest bounce in the room
  add(place(panel(3.4, 1.5, 0xf6ecd8, 1.55), 0.55, 0.020, -2.95, -H, 0, 0.16), 1.6, 0.85);

  // ceiling + walls --------------------------------------------------------------------------
  // The slab never sees the sun; everything reaching it is skylight plus rug bounce.
  add(place(panel(6.8, 8.0, 0xa9a49b, 0.19), 0, 2.778, -0.6, H), 0.05, 0.30);
  add(place(panel(8.0, 2.78, 0xd8d1c5, 0.24), -3.398, 1.39, -0.6, 0, H), 0.25, 0.22);
  add(place(panel(8.0, 2.78, 0xdcd5c9, 0.28), 3.398, 1.39, -0.6, 0, -H), 0.45, 0.40);
  add(place(panel(6.8, 2.78, 0xd4cdc1, 0.20), 0, 1.39, 3.398, 0, Math.PI), 0.10, 0.18);

  // the sofa's cream flank and seat, the biggest single bounce card on the +X side
  add(place(panel(4.2, 0.62, 0xe6dcc6, 0.42), 1.78, 0.36, -0.5, 0, -H), 0.7, 0.42);
  add(place(panel(4.2, 1.55, 0xe6dcc6, 0.34), 2.55, 0.44, -0.5, -H), 0.8, 0.45);
  // the ply shelf run on the left
  add(place(panel(4.4, 0.72, 0xc4a274, 0.26), -3.20, 0.40, -1.0, 0, H), 0.3, 0.20);

  // window wall: three pieces around an open aperture (x -1.60…3.40, y 0.06…2.50) -------------
  add(place(panel(1.8, 2.78, 0x2a2a2c, 0.13), -2.50, 1.39, -4.595), 0.05, 0.10);
  add(place(panel(5.0, 0.28, 0x2a2a2c, 0.12), 0.90, 2.64, -4.595), 0.05, 0.10);
  add(place(panel(5.0, 0.06, 0x2a2a2c, 0.12), 0.90, 0.03, -4.595), 0.05, 0.10);

  // the sheers: one flat panel drawn across x 0.30…1.40 and two gathered bundles. They are the
  // softbox — lit from behind they are the brightest large surface in the frame. Bright, but a
  // diffuser in front of the whole sky reads as daylight, so their hue stays near the cool end.
  add(place(panel(1.10, 2.42, 0xfff4e2, 2.30), 0.85, 1.27, -4.50), 2.6, 0.30);
  add(place(panel(0.30, 2.42, 0xfff0d8, 1.75), -1.50, 1.27, -4.50), 2.2, 0.26);
  add(place(panel(0.32, 2.42, 0xfff0d8, 1.60), 3.20, 1.27, -4.50), 2.0, 0.26);

  // the neighbours' brick flank, off to +X so the sun's quarter of the sky stays open
  add(place(panel(16, 7.0, 0xa8674c, 0.30), 5.5, 3.2, -13.0), 0.9, 0.70);
  // the balcony deck, catching the last of the light
  add(place(panel(6.0, 1.6, 0x7a6f62, 0.34), 0.9, -0.02, -5.4, -H), 1.0, 0.65);

  const base = panels.map((m) => ({ mesh: m, hex: m.material.userData.baseHex, gain: m.material.userData.baseGain, sunLit: m.userData.sunLit, warm: m.userData.warm }));

  return {
    scene,
    dome,
    /** Rescale every proxy for the current sun. */
    tune(d) {
      // Ambient part follows the sky, the direct part follows the key. At blue hour the sunlit
      // strip on the rug simply stops existing, which is what kills the bounce and lets the
      // practicals take over.
      const amb = 0.28 + 0.72 * Math.min(1.6, d.skyGain / 3.1);
      const key = Math.min(1.25, d.sunIntensity / 3.55);

      // TWO illuminants, not one global "warm" knob. A panel the sun never reaches — the slab, the
      // far wall, the shaded flank of the sofa — is lit by daylight arriving through the glazing,
      // which is cool. Only the surfaces the key actually rakes across are lit by the low sun.
      // The previous revision multiplied *every* panel by the same warm tint, so the whole probe —
      // and with it every surface in the room the key does not reach — picked up an amber cast that
      // got worse the further you stood from the window. Both colours are normalised to luminance 1
      // and the blend of two luminance-1 colours is still luminance 1, so this is a pure hue split:
      // brightness (`g`) is computed exactly as before and is untouched by the white balance.
      _amb.copy(d.windowColour);
      _key.copy(d.sunColour).lerp(_amb, 0.30); // still clearly warm, no longer molten

      for (const p of base) {
        _c.setHex(p.hex, THREE.SRGBColorSpace);
        const g = p.gain * (amb * (1 - p.sunLit * 0.55) + key * p.sunLit * 0.75);
        // A surface only swings toward the sun's hue while the sun is actually up.
        _tint.copy(_amb).lerp(_key, p.warm * Math.min(1, key * 1.15));
        const m = p.mesh.material;
        m.color.setRGB(
          _c.r * g * _tint.r,
          _c.g * g * _tint.g,
          _c.b * g * _tint.b,
          THREE.LinearSRGBColorSpace,
        );
      }
    },
    dispose() {
      dome.geometry.dispose();
      for (const p of base) {
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
      }
      panels.length = 0;
    },
  };
}

/** The sky-only scene that becomes `scene.background`. */
export function createBackdropScene(skyMaterial) {
  const scene = new THREE.Scene();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(90, 32, 20), skyMaterial);
  dome.matrixAutoUpdate = false;
  dome.renderOrder = -1;
  dome.updateMatrix();
  scene.add(dome);
  return {
    scene,
    dispose() {
      dome.geometry.dispose();
    },
  };
}
