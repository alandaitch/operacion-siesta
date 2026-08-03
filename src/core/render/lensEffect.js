// The lens: radial chromatic aberration and the sprint smear.
// OWNER: RENDER.
//
// This runs BEFORE depth of field. It resamples the input buffer with a per-channel radial offset,
// so it has to see the sharp frame; if DoF ran first we would be fringing a blurred green against
// a sharp red and the corners would fall apart. EffectPass sorts its effects by `attributes`
// descending, so the only way to guarantee we precede DepthOfFieldEffect is to declare DEPTH as
// well — the pass already binds a depth texture for DoF, so the attribute costs nothing and no
// depth is actually sampled here.
//
// Exposure deliberately does NOT live here: three's ACES chunk multiplies by the renderer's
// `toneMappingExposure` uniform, which postprocessing's ToneMappingEffect inherits, so the stop is
// already applied at exactly the right point in the chain — after DoF and bloom have composited,
// immediately before the curve. Adding a second multiply here would double it.
//
// On aberration: the built-in ChromaticAberrationEffect offsets the whole frame by a constant,
// which reads as a cheap VHS filter. Real glass disperses as a function of radius — exactly zero
// on the optical axis. Hence smoothstep(0.75, 1.0, r) squared: nothing at all inside the middle
// 75 % of the frame, roughly 3 px of separation at 1080p in the very corner.
//
// The sprint smear sits behind a uniform-only branch. A condition that depends solely on a uniform
// is coherent across every fragment of the draw, so when the baby is not sprinting the five extra
// taps genuinely do not execute.

import { Effect, EffectAttribute, BlendFunction } from 'postprocessing';
import * as THREE from 'three';

const LENS_FRAGMENT = /* glsl */ `
uniform float caAmount;
uniform float sprintAmount;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 delta = uv - 0.5;
  float cornerNorm = 2.0 / sqrt(aspect * aspect + 1.0);
  float radius = length(delta * vec2(aspect, 1.0)) * cornerNorm;

  float bite = smoothstep(0.75, 1.0, radius);
  bite *= bite;

  vec2 off = delta * (caAmount * bite);
  vec3 col;
  col.r = texture2D(inputBuffer, uv + off).r;
  col.g = inputColor.g;
  col.b = texture2D(inputBuffer, uv - off).b;

  if (sprintAmount > 0.0015) {
    float smear = sprintAmount * smoothstep(0.40, 1.0, radius);
    vec3 acc = col;
    float wsum = 1.0;
    for (int i = 1; i <= 5; ++i) {
      float t = float(i) / 5.0;
      float k = 1.0 - t * 0.55;
      acc += texture2D(inputBuffer, uv - delta * (t * smear)).rgb * k;
      wsum += k;
    }
    col = acc / wsum;
  }

  outputColor = vec4(col, inputColor.a);
}
`;

export class LensEffect extends Effect {
  constructor({ chromaticAberration = 0.0034 } = {}) {
    super('LensEffect', LENS_FRAGMENT, {
      attributes: EffectAttribute.DEPTH, // ordering only — see the header note
      blendFunction: BlendFunction.SRC,
      uniforms: new Map([
        ['caAmount', new THREE.Uniform(chromaticAberration)],
        ['sprintAmount', new THREE.Uniform(0)],
      ]),
    });

    this.baseAberration = chromaticAberration;
  }

  /**
   * @param {number} impact 0..1 punch envelope
   * @param {number} sprint 0..1 speed cue
   */
  apply(impact, sprint) {
    this.uniforms.get('caAmount').value = this.baseAberration * (1.0 + 3.4 * impact);
    this.uniforms.get('sprintAmount').value = 0.052 * sprint + 0.028 * impact;
  }
}
