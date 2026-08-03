// The camera's white balance — the one stage the stack was missing.
// OWNER: RENDER.
//
// Every other module is physically honest: the key is a 4800 K low winter sun, the room is built
// out of cream, oatmeal, birch and warm oak, and the IBL is a single-bounce proxy of exactly that
// room. Multiply all of it together and the scene illuminant lands around R:B 1.5 in linear —
// which is *correct*, and which is also why the render printed as caramel. A photographer standing
// in this room does not shoot it on a 6500 K balance and hand you a sepia frame; they set the
// camera near the light and the cream walls come back cream.
//
// So: a von-Kries-style channel gain, applied in scene-linear BEFORE depth of field, bloom and
// ACES, because that is where a sensor's WB gains actually live. Applying it after the tonemap
// would fight the shoulder and shift the hue of everything already rolled off.
//
// Two properties worth keeping:
//  · The gain is normalised to Rec.709 luma, so white balance never changes exposure. The stop is
//    still owned entirely by `renderer.toneMappingExposure`.
//  · It is only ever a *partial* correction (see LIGHT's `whiteBalance`): a full correction would
//    neutralise the golden hour, and the whole point of the last twenty minutes of the round is
//    that the room goes gold. What we remove is the amber tint on the room's ambient, not the
//    warmth of the light sources.

import { Effect, EffectAttribute, BlendFunction } from 'postprocessing';
import * as THREE from 'three';

const FRAGMENT = /* glsl */ `
uniform vec3 wbGain;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = vec4(inputColor.rgb * wbGain, inputColor.a);
}
`;

const LUMA = new THREE.Vector3(0.2126, 0.7152, 0.0722);
const _illum = new THREE.Color();

export class WhiteBalanceEffect extends Effect {
  constructor() {
    super('WhiteBalanceEffect', FRAGMENT, {
      // Ordering only. EffectPass sorts by `attributes` descending with a stable sort, so carrying
      // DEPTH (which the pass already binds for DoF) is what keeps this ahead of the blur stages.
      attributes: EffectAttribute.DEPTH,
      blendFunction: BlendFunction.SRC,
      uniforms: new Map([['wbGain', new THREE.Uniform(new THREE.Vector3(1, 1, 1))]]),
    });
  }

  /**
   * @param {THREE.Color} illuminant scene illuminant in linear working space; the gain is its
   *   reciprocal, so passing pure white is a no-op.
   */
  setIlluminant(illuminant) {
    if (!illuminant) return;
    _illum.copy(illuminant);
    const r = 1 / Math.max(1e-3, _illum.r);
    const g = 1 / Math.max(1e-3, _illum.g);
    const b = 1 / Math.max(1e-3, _illum.b);
    // Renormalise so a neutral grey keeps its luminance: WB is a hue operation, never a stop.
    const l = LUMA.x * r + LUMA.y * g + LUMA.z * b;
    const k = l > 1e-5 ? 1 / l : 1;
    this.uniforms.get('wbGain').value.set(r * k, g * k, b * k);
  }

  /** Current gain, for the debug overlay. */
  get gain() {
    return this.uniforms.get('wbGain').value;
  }
}
