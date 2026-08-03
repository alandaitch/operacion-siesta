// Screen-space reflections, depth-only.
// OWNER: RENDER.
//
// Why depth-only: a NormalPass costs a second full geometry pass, and its normals include the
// high-frequency normal maps (rug weave, bouclé loops, plaster orange-peel) which turn a
// ray-marched reflection into a shimmering mess. Reconstructing the *geometric* normal from the
// depth buffer is free, is temporally rock-solid, and is exactly the surface we want to reflect
// off: the microcement floor and the low-iron glass slab.
//
// We also have no G-buffer, so there is no roughness channel. Instead the reflection weight is:
//     up-facing gate  ×  screen-space planarity  ×  Fresnel
//   · up-facing gate: only near-horizontal surfaces reflect. Walls and the ceiling are the two
//     biggest sources of SSR artefacts and they contribute nothing in this room.
//   · planarity: the second derivative of view-space depth. Flat (floor, tabletop, ottoman top)
//     stays sharp; bumpy (plush pile, monstera leaves, cushions) is treated as rough and both
//     faded out and blurred. That is a geometric roughness proxy, and it is honest about it.
//   · Fresnel: pow(1 - NdotV, 5). At grazing incidence *everything* reflects — wool included —
//     which is why the rug picking up a soft smear of window is correct rather than a bug.
//
// The march is 24 (32 on ultra) linear steps in view space with 6 binary-refinement steps at the
// crossing, a thickness test to reject hits behind thin geometry, an edge fade, and a
// per-pixel hash dither that depends only on gl_FragCoord — never on time — so photo mode is
// byte-stable.

import { Effect, EffectAttribute, BlendFunction } from 'postprocessing';
import * as THREE from 'three';

const FRAGMENT = /* glsl */ `
uniform mat4 camProj;
uniform mat4 camProjInv;
uniform mat4 camViewInv;
uniform float reflectStrength;
uniform float maxDistance;
uniform float thickness;
uniform float upFadeLow;
uniform float upFadeHigh;

vec3 viewFromDepth(const in vec2 suv, const in float d) {
  float vz = getViewZ(d);
  vec4 clipPos = vec4(vec3(suv, d) * 2.0 - 1.0, 1.0);
  float clipW = camProj[2][3] * vz + camProj[3][3];
  clipPos *= clipW;
  return (camProjInv * clipPos).xyz;
}

float dither(const in vec2 fragCoord) {
  vec3 p3 = fract(vec3(fragCoord.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  outputColor = inputColor;

  if (depth >= 0.9999) { return; }

  vec2 tx = texelSize;
  float dL = readDepth(uv - vec2(tx.x, 0.0));
  float dR = readDepth(uv + vec2(tx.x, 0.0));
  float dD = readDepth(uv - vec2(0.0, tx.y));
  float dU = readDepth(uv + vec2(0.0, tx.y));

  vec3 pos = viewFromDepth(uv, depth);
  vec3 pL = viewFromDepth(uv - vec2(tx.x, 0.0), dL);
  vec3 pR = viewFromDepth(uv + vec2(tx.x, 0.0), dR);
  vec3 pD = viewFromDepth(uv - vec2(0.0, tx.y), dD);
  vec3 pU = viewFromDepth(uv + vec2(0.0, tx.y), dU);

  // Pick the neighbour that is closest in depth on each axis: across a silhouette that keeps the
  // derivative on the near surface instead of smearing a normal between two objects.
  vec3 ddx = (abs(pR.z - pos.z) < abs(pos.z - pL.z)) ? (pR - pos) : (pos - pL);
  vec3 ddy = (abs(pU.z - pos.z) < abs(pos.z - pD.z)) ? (pU - pos) : (pos - pD);

  vec3 nrm = cross(ddx, ddy);
  float nl = length(nrm);
  if (nl < 1.0e-8) { return; }
  nrm /= nl;
  if (dot(nrm, -pos) < 0.0) { nrm = -nrm; }

  vec3 wNrm = normalize(mat3(camViewInv) * nrm);
  float upFace = smoothstep(upFadeLow, upFadeHigh, wNrm.y);
  if (upFace < 0.004) { return; }

  // Geometric roughness proxy: normalised second derivative of view-space depth.
  float curv = abs(pL.z + pR.z - 2.0 * pos.z) + abs(pU.z + pD.z - 2.0 * pos.z);
  curv /= max(0.04, abs(pos.z)) * 0.0055;
  float planar = 1.0 - smoothstep(0.6, 3.4, curv);
  if (planar < 0.02) { return; }

  vec3 viewDir = normalize(-pos);
  float ndv = clamp(dot(nrm, viewDir), 0.0, 1.0);
  float fresnel = 0.026 + 0.974 * pow(1.0 - ndv, 5.0);

  vec3 rayDir = normalize(reflect(-viewDir, nrm));

  // A ray heading back toward the eye cannot be resolved in screen space; fade it out early
  // rather than let it hit the near plane and streak.
  float towardCam = clamp(dot(rayDir, viewDir), 0.0, 1.0);
  float camFade = 1.0 - smoothstep(0.18, 0.72, towardCam);
  if (camFade < 0.01) { return; }

  float weight = reflectStrength * upFace * planar * fresnel * camFade;
  if (weight < 0.0015) { return; }

  float stepLen = maxDistance / float(marchSteps);
  vec3 stepVec = rayDir * stepLen;
  float jitter = dither(gl_FragCoord.xy);

  vec3 prevPos = pos + nrm * 0.012 + stepVec * (jitter * 0.9);
  vec3 rayPos = prevPos;

  float hit = 0.0;
  float travel = 0.0;
  vec2 hitUv = vec2(0.5);

  for (int i = 0; i < marchSteps; ++i) {
    prevPos = rayPos;
    rayPos += stepVec;

    vec4 clipPos = camProj * vec4(rayPos, 1.0);
    if (clipPos.w <= 0.0) { break; }
    vec2 suv = (clipPos.xy / clipPos.w) * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) { break; }

    float sceneDepth = readDepth(suv);
    if (sceneDepth >= 0.9999) { continue; }
    float sceneZ = getViewZ(sceneDepth);
    float delta = sceneZ - rayPos.z;

    if (delta > 0.0 && delta < thickness + stepLen * 0.35) {
      vec3 lo = prevPos;
      vec3 hi = rayPos;
      for (int k = 0; k < refineSteps; ++k) {
        vec3 mid = (lo + hi) * 0.5;
        vec4 mc = camProj * vec4(mid, 1.0);
        vec2 muv = (mc.xy / max(1.0e-4, mc.w)) * 0.5 + 0.5;
        float mz = getViewZ(readDepth(muv));
        if (mz - mid.z > 0.0) { hi = mid; } else { lo = mid; }
      }
      vec4 fc = camProj * vec4(hi, 1.0);
      hitUv = (fc.xy / max(1.0e-4, fc.w)) * 0.5 + 0.5;
      travel = float(i) / float(marchSteps);
      hit = 1.0;
      break;
    }
  }

  if (hit < 0.5) { return; }

  vec2 edge = abs(hitUv - 0.5) * 2.0;
  float edgeFade = (1.0 - smoothstep(0.72, 1.0, edge.x)) * (1.0 - smoothstep(0.72, 1.0, edge.y));
  float distFade = 1.0 - smoothstep(0.55, 1.0, travel);
  float total = weight * edgeFade * distFade;
  if (total < 0.001) { return; }

  // Roughness cone: widen the gather with distance travelled and with geometric roughness.
  float blurR = (1.2 + 9.0 * (1.0 - planar) + 7.0 * travel) * tx.x;
  vec3 refl = texture2D(inputBuffer, hitUv).rgb * 2.0;
  refl += texture2D(inputBuffer, hitUv + vec2(blurR, 0.0)).rgb;
  refl += texture2D(inputBuffer, hitUv - vec2(blurR, 0.0)).rgb;
  refl += texture2D(inputBuffer, hitUv + vec2(0.0, blurR)).rgb;
  refl += texture2D(inputBuffer, hitUv - vec2(0.0, blurR)).rgb;
  refl /= 6.0;

  // Fireflies from the window and the bare bulb would smear across the whole floor otherwise.
  refl = min(refl, vec3(6.0));

  outputColor = vec4(inputColor.rgb + refl * total, inputColor.a);
}
`;

export class SSREffect extends Effect {
  /**
   * @param {THREE.Camera} camera
   * @param {object} [options]
   * @param {number} [options.intensity=0.62] overall reflection strength
   * @param {number} [options.maxDistance=6.0] march length in metres
   * @param {number} [options.thickness=0.28] hit tolerance in metres
   * @param {number} [options.steps=24] linear march steps
   * @param {number} [options.refine=6] binary refinement steps
   */
  constructor(camera, options = {}) {
    const {
      intensity = 0.62,
      maxDistance = 6.0,
      thickness = 0.28,
      steps = 24,
      refine = 6,
    } = options;

    super('SSREffect', FRAGMENT, {
      attributes: EffectAttribute.DEPTH,
      blendFunction: BlendFunction.SRC,
      defines: new Map([
        ['marchSteps', Math.max(4, steps | 0).toFixed(0)],
        ['refineSteps', Math.max(1, refine | 0).toFixed(0)],
      ]),
      uniforms: new Map([
        ['camProj', new THREE.Uniform(new THREE.Matrix4())],
        ['camProjInv', new THREE.Uniform(new THREE.Matrix4())],
        ['camViewInv', new THREE.Uniform(new THREE.Matrix4())],
        ['reflectStrength', new THREE.Uniform(intensity)],
        ['maxDistance', new THREE.Uniform(maxDistance)],
        ['thickness', new THREE.Uniform(thickness)],
        ['upFadeLow', new THREE.Uniform(0.52)],
        ['upFadeHigh', new THREE.Uniform(0.86)],
      ]),
    });

    this.camera = camera;
  }

  set mainCamera(value) {
    this.camera = value;
  }

  get intensity() {
    return this.uniforms.get('reflectStrength').value;
  }

  set intensity(value) {
    this.uniforms.get('reflectStrength').value = value;
  }

  update(/* renderer, inputBuffer, deltaTime */) {
    const camera = this.camera;
    if (!camera) return;
    camera.updateMatrixWorld();
    this.uniforms.get('camProj').value.copy(camera.projectionMatrix);
    this.uniforms.get('camProjInv').value.copy(camera.projectionMatrixInverse);
    this.uniforms.get('camViewInv').value.copy(camera.matrixWorld);
  }
}
