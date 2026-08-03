// The print: vignette, film grain, and the "you are about to be caught" warm-red bias.
// OWNER: RENDER.
//
// Runs LAST in the grade pass, after ACES and after the 3D LUT, and declares
// `inputColorSpace = SRGBColorSpace` so the whole thing operates on display-referred code values.
// Grain added in scene-linear looks like sensor noise; grain added in print space looks like film,
// which is the point.
//
// Grain is two octaves of a cheap 3D hash — one at pixel frequency, one at half frequency so the
// structure has some size to it — modulated by 4·L·(1−L) so it peaks in the midtones and stays out
// of the blacks and the blown window, exactly like a real emulsion. Crucially the seed only
// changes at ~12 Hz (driven by createPostFX, not by `time`), because 60 Hz grain crawls and reads
// as video noise; 12 Hz reads as a projected print. In photo mode the seed is pinned to a
// constant so consecutive screenshots are byte-identical.

import { Effect, BlendFunction } from 'postprocessing';
import * as THREE from 'three';

const FRAGMENT = /* glsl */ `
uniform float vignetteStrength;
uniform float vignetteStart;
uniform float grainAmount;
uniform float grainSeed;
uniform float damage;

float filmHash(const in vec3 seed) {
  vec3 p3 = fract(seed * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 col = inputColor.rgb;

  vec2 delta = uv - 0.5;
  float cornerNorm = 2.0 / sqrt(aspect * aspect + 1.0);
  float radius = length(delta * vec2(aspect, 1.0)) * cornerNorm;

  col *= 1.0 - vignetteStrength * smoothstep(vignetteStart, 1.14, radius);

  if (damage > 0.002) {
    float ring = smoothstep(0.28, 1.05, radius);
    col = mix(col, col * vec3(1.10, 0.40, 0.30), damage * ring * 0.92);
    col *= mix(vec3(1.0), vec3(1.038, 0.972, 0.940), damage * 0.55);
  }

  if (grainAmount > 0.0001) {
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float resp = mix(0.30, 1.0, clamp(4.0 * lum * (1.0 - lum), 0.0, 1.0));
    float fine = filmHash(vec3(gl_FragCoord.xy, grainSeed)) - 0.5;
    float coarse = filmHash(vec3(floor(gl_FragCoord.xy * 0.5), grainSeed * 1.77 + 11.0)) - 0.5;
    col += (fine * 0.62 + coarse * 0.38) * grainAmount * resp;
  }

  outputColor = vec4(clamp(col, 0.0, 1.0), inputColor.a);
}
`;

export class FilmEffect extends Effect {
  constructor({ vignette = 0.42, vignetteStart = 0.38, grain = 0.028 } = {}) {
    super('FilmEffect', FRAGMENT, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map([
        ['vignetteStrength', new THREE.Uniform(vignette)],
        ['vignetteStart', new THREE.Uniform(vignetteStart)],
        ['grainAmount', new THREE.Uniform(grain)],
        ['grainSeed', new THREE.Uniform(7.31)],
        ['damage', new THREE.Uniform(0)],
      ]),
    });

    this.inputColorSpace = THREE.SRGBColorSpace;
    this.baseVignette = vignette;
    this.baseVignetteStart = vignetteStart;
    this.baseGrain = grain;
  }

  /**
   * @param {number} impact 0..1 punch envelope — pinches the vignette inward
   * @param {number} damage 0..1 parent proximity — warm red bias in the corners
   * @param {number} seed grain phase, stepped at ~12 Hz by the owner
   */
  apply(impact, damage, seed) {
    const u = this.uniforms;
    u.get('vignetteStrength').value = this.baseVignette + 0.2 * impact + 0.1 * damage;
    u.get('vignetteStart').value = this.baseVignetteStart - 0.16 * impact - 0.06 * damage;
    u.get('damage').value = damage;
    u.get('grainSeed').value = seed;
  }

  set grain(value) {
    this.baseGrain = value;
    this.uniforms.get('grainAmount').value = value;
  }

  get grain() {
    return this.baseGrain;
  }
}
