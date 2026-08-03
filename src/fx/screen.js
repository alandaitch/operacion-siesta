// FX · the two screen channels. Used sparingly, on purpose.
//
// This is a photoreal game, so there is no HUD flash, no cartoon impact frame and nothing that
// looks like a shader from a mobile match-3. What there is: a warm bloom that swells from the
// centre when the baby eats something good, and a cold green cast that creeps in from the corners
// when it eats something it very much should not have. Both are lens behaviour — a real camera
// blooming on a highlight, a real grade going sick — not UI.
//
// One fullscreen triangle, drawn last in the scene pass so it goes through DoF, bloom, ACES and
// the film grade with everything else. That is the whole reason it lives in the scene graph rather
// than in a DOM overlay: a wash composited after the tone map looks like a sticker, and a wash
// composited before it looks like light.
//
// Premultiplied `over` blending gives both behaviours from one draw: the glow channel writes
// colour with zero alpha (pure addition) and the tint channel writes colour with alpha (a gel over
// the frame). Amplitudes are envelope-driven, and the whole mesh is hidden the instant both fall
// below a thousandth, so a quiet frame costs nothing at all.

import * as THREE from 'three';

const VERT = /* glsl */ `
precision highp float;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform vec3 uGlowColour;
uniform float uGlow;
uniform vec3 uTintColour;
uniform float uTint;
uniform float uAspect;

varying vec2 vUv;

void main() {
  vec2 d = ( vUv - 0.5 ) * vec2( uAspect, 1.0 );
  float r = length( d ) * 1.42;

  // Glow: a wide soft bloom out of the middle of the frame, hottest where the lens would be.
  float glow = uGlow * ( 0.35 + 0.85 * exp( - r * r * 1.9 ) );

  // Tint: the opposite shape — the corners go first, the way a grade does.
  float tint = uTint * smoothstep( 0.18, 1.05, r ) * 0.92 + uTint * 0.16;

  vec3 rgb = uGlowColour * glow + uTintColour * tint;
  gl_FragColor = vec4( rgb, clamp( tint, 0.0, 0.92 ) );
}
`;

export function createScreenFX() {
  // A single oversized triangle: no diagonal seam, one fewer vertex, and the UVs still land on
  // [0,1] across the visible area.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -1, -1, 0, 3, -1, 0, -1, 3, 0,
  ]), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const material = new THREE.ShaderMaterial({
    name: 'fx.screen',
    uniforms: {
      uGlowColour: { value: new THREE.Color(1, 0.72, 0.42) },
      uGlow: { value: 0 },
      uTintColour: { value: new THREE.Color(0.42, 0.72, 0.36) },
      uTint: { value: 0 },
      uAspect: { value: 1.777 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    fog: false,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'fx.screen';
  mesh.frustumCulled = false;
  mesh.renderOrder = 9990;
  mesh.matrixAutoUpdate = false;
  mesh.visible = false;

  const glow = { value: 0, target: 0, attack: 26, decay: 2.6 };
  const tint = { value: 0, target: 0, attack: 6.5, decay: 1.1 };

  function envelope(ch, dt) {
    if (ch.target > ch.value) {
      ch.value += (ch.target - ch.value) * Math.min(1, ch.attack * dt);
      if (ch.value > ch.target - 0.004) { ch.value = ch.target; ch.target = 0; }
    } else {
      ch.value *= Math.exp(-ch.decay * dt);
      if (ch.value < 0.0008) ch.value = 0;
    }
  }

  return {
    object3d: mesh,
    material,

    /** A warm bloom out of the centre. `strength` 0..1, `decay` in seconds. */
    flash(colour, strength, decay = 0.42) {
      material.uniforms.uGlowColour.value.copy(colour);
      glow.target = Math.max(glow.target, Math.min(1.2, strength));
      glow.decay = 1 / Math.max(0.06, decay);
    },

    /** A colour cast creeping in from the corners. `strength` 0..1, `decay` in seconds. */
    cast(colour, strength, decay = 1.6) {
      material.uniforms.uTintColour.value.copy(colour);
      tint.target = Math.max(tint.target, Math.min(0.85, strength));
      tint.decay = 1 / Math.max(0.10, decay);
    },

    step(dt) {
      if (glow.value === 0 && glow.target === 0 && tint.value === 0 && tint.target === 0) {
        mesh.visible = false;
        return;
      }
      envelope(glow, dt);
      envelope(tint, dt);
      material.uniforms.uGlow.value = glow.value;
      material.uniforms.uTint.value = tint.value;
      mesh.visible = glow.value > 0.001 || tint.value > 0.001;
    },

    setAspect(a) {
      material.uniforms.uAspect.value = a;
    },

    clear() {
      glow.value = 0; glow.target = 0;
      tint.value = 0; tint.target = 0;
      material.uniforms.uGlow.value = 0;
      material.uniforms.uTint.value = 0;
      mesh.visible = false;
    },

    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
