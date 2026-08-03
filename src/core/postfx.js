// Post-processing stack — the difference between a tech demo and a photograph.
// OWNER: RENDER. See CONTRACTS.md before editing.
//
// The chain, in order, each stage gated by ctx.quality:
//
//   RenderPass  →  N8AO  →  [SSR]  →  [ lens · DoF · bloom · ACES · LUT · film ]  →  SMAA
//                                      \_______ one merged EffectPass _______/
//
// Notes on the shape of it:
//  · Everything before ACES lives in a HalfFloat buffer, scene-referred. The renderer itself has
//    NoToneMapping (see engine.js) so nothing gets crushed before the grade.
//  · N8AO is the single biggest fidelity win in an interior — it is what puts the shadow into the
//    corner where the plinth meets the floor, under the sofa, behind the books. Tuned at 0.55 m
//    world radius, which is roughly one sofa cushion.
//  · SSR is depth-only (no NormalPass, no G-buffer); the rationale is in render/ssrEffect.js.
//    The floor and the glass coffee table are the payoff.
//  · The grade pass merges six effects into one fullscreen draw. That is the entire point of the
//    postprocessing library. Only SMAA gets its own pass, because it is a convolution effect and
//    may not be merged — see the "8. edges" block below for why it stays SMAA (an FXAA swap was
//    measured, not assumed, and made things worse, not better).
//  · Photo mode (`ctx.state.mode === 'photo'`) freezes every time-varying term — grain phase,
//    impact envelope, sprint smear, focus pull — and passes dt = 0 to the composer so the
//    library's own `time` uniform never advances. Screenshots are byte-comparable across rounds.

import * as THREE from 'three';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  DepthOfFieldEffect,
  ToneMappingEffect,
  ToneMappingMode,
  LUT3DEffect,
  SMAAEffect,
  SMAAPreset,
  EdgeDetectionMode,
  BlendFunction,
  Pass,
  LambdaPass,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

import { SSREffect } from './render/ssrEffect.js';
import { LensEffect } from './render/lensEffect.js';
import { FilmEffect } from './render/filmEffect.js';
import { createFilmLUT } from './render/lut.js';
import { makeRng } from './rng.js';

const GRAIN_HZ = 12; // film, not video
const DOF_BOKEH = 1.7;
const PHOTO_GRAIN_SEED = 41.7; // pinned phase for deterministic screenshots
const IMPACT_DECAY = 0.25; // seconds
const FOCUS_TAU = 0.16; // focus-puller time constant
const SPRINT_TAU = 0.22;
const DAMAGE_TAU = 0.30;

// N8AO is fill-rate bound and is the single largest line item in the whole frame — on a laptop
// its full-resolution mode (tier 2, what `high` used to run) measured at roughly 10x the cost of
// its half-res mode. Half-resolution AO with depth-aware upsampling is the standard shipping
// configuration for exactly this reason: the AO term is low-frequency by nature (it is a
// contact-darkening term, not detail), so upsampling it back to full res from half loses
// essentially nothing visually while cutting the sample/denoise cost ~4x. `ultra` stays full-res
// for the workstation tier this game also has to look its best on.
const AO_TIERS = {
  1: { aoSamples: 16, denoiseSamples: 4, denoiseRadius: 12, denoiseIterations: 1, halfRes: true },
  2: { aoSamples: 16, denoiseSamples: 8, denoiseRadius: 12, denoiseIterations: 2, halfRes: true },
  3: { aoSamples: 64, denoiseSamples: 8, denoiseRadius: 6, denoiseIterations: 2, halfRes: false },
};

export function createPostFX(ctx) {
  const { renderer, scene, quality } = ctx;
  const engine = ctx.engine || null;

  let camera = ctx.camera;
  let camNear = camera.near;
  let camFar = camera.far;

  const drawing = renderer.getDrawingBufferSize(new THREE.Vector2());
  const width = Math.max(1, drawing.x);
  const height = Math.max(1, drawing.y);

  // multisampling stays 0 — SMAA runs instead. This was tested, not assumed: on a TBDR GPU
  // (Apple Silicon under ANGLE-Metal is one) MSAA's resolve is free of the main-memory-bandwidth
  // cost that makes it expensive on a discrete desktop GPU, and SMAA's edge search is exactly the
  // dependent-texture-fetch pattern that class of GPU is worst at — so MSAA looked like the fix
  // for the ~20 ms antialiasing cost this file's history documents (see "8. edges" below). It
  // wasn't: `multisampling: Math.min(4, engine.caps.maxSamples)` with SMAA's pass removed
  // entirely (not merely disabled — see the note below on why removal, not disabling, matters
  // for a clean comparison) measured within noise of plain SMAA — draw calls dropped by SMAA's
  // two removed sub-passes, but wall-clock frame time did not move. On this driver, right now,
  // antialiasing costs roughly the same ~20 ms whichever of these two techniques supplies it; SMAA
  // stays because it is the better result for an equal price, and because switching techniques
  // for no measured win is pure churn.
  const composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,
    multisampling: 0, // see above — tested against MSAA, not assumed
    stencilBuffer: false,
    depthBuffer: true,
  });

  // ---------------------------------------------------------------------------------------
  // 1. scene
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  // ---------------------------------------------------------------------------------------
  // A private, non-swapping depth texture for every pass below that needs one (N8AO, SSR,
  // DepthOfFieldEffect, and LensEffect's depth-attribute ordering trick).
  //
  // postprocessing's own EffectComposer has an automatic path for this: any pass with
  // needsDepthTexture=true makes it blit RenderPass's depth into a dedicated "stable" render
  // target and hand that texture out via setDepthTexture. On this machine — WebGL2 via ANGLE's
  // Metal backend, i.e. a Mac, which is exactly the platform named in every public report of
  // this failure — that automatic path still throws two GL_INVALID_OPERATION warnings every
  // frame the moment any pass needs depth: a glBlitFramebuffer complaint that the read/write
  // depth attachments alias, and — once a later pass's ping-pong swap lands it back on writing
  // into the exact buffer RenderPass wrote into — a genuine "feedback loop formed between
  // framebuffer and active texture" from sampling a depth texture that is simultaneously the
  // current draw target's own depth attachment. Verified by bisection on this exact chain:
  // disabling only the SSR pass removes the feedback-loop warning (it is the one whose swap
  // parity lands it back on RenderPass's buffer); the blit warning fires the instant *any* pass
  // requests a depth texture, independent of which. This is a known, still-open class of bug in
  // postprocessing 6.x on Mac (pmndrs/postprocessing#416; the #740 mitigation added the "stable"
  // indirection above but does not cover every pass ordering, ours included — a real fix is
  // slated for v7).
  //
  // The fix: never let a pass ask the composer for a depth texture. Every consumer below is
  // pre-armed with a texture (or has needsDepthTexture forced off) before it is added, so
  // EffectComposer.addPass() never builds its own depthRenderTarget/blit machinery at all. The
  // texture we hand out is one WE own: it is never used as anyone's colour output, so it can
  // never be simultaneously a sampler and the current framebuffer's attachment, and we populate
  // it with a plain draw-based copy (gl_FragDepth), never blitFramebuffer, sidestepping the
  // Metal blit-validation bug too. The copy runs as a LambdaPass immediately after RenderPass —
  // needsSwap stays false, so it never disturbs the colour ping-pong — and therefore always sees
  // this frame's fresh depth before anything downstream reads it.
  composer.inputBuffer.depthTexture = new THREE.DepthTexture(width, height);

  const depthCopyTarget = new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  depthCopyTarget.texture.name = 'PostFX.StableDepthCarrier';
  depthCopyTarget.depthTexture = new THREE.DepthTexture(width, height);

  const depthCopyMaterial = new THREE.ShaderMaterial({
    uniforms: { srcDepth: new THREE.Uniform(null) },
    depthTest: false,
    depthWrite: true,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D srcDepth;
      varying vec2 vUv;
      void main() {
        gl_FragDepth = texture2D(srcDepth, vUv).r;
        gl_FragColor = vec4(0.0);
      }
    `,
  });
  const depthCopyMesh = new THREE.Mesh(Pass.fullscreenGeometry, depthCopyMaterial);
  depthCopyMesh.frustumCulled = false;
  const depthCopyCamera = new THREE.OrthographicCamera();

  const depthCopyPass = new LambdaPass(() => {
    depthCopyMaterial.uniforms.srcDepth.value = composer.inputBuffer.depthTexture;
    renderer.setRenderTarget(depthCopyTarget);
    renderer.render(depthCopyMesh, depthCopyCamera);
  });
  depthCopyPass.needsDepthTexture = false;
  composer.addPass(depthCopyPass);

  // ---------------------------------------------------------------------------------------
  // 2. ambient occlusion
  let aoPass = null;
  if (quality.aoQuality > 0) {
    const tier = AO_TIERS[Math.min(3, quality.aoQuality)] || AO_TIERS[2];
    aoPass = new N8AOPostPass(scene, camera, width, height);
    aoPass.needsDepthTexture = false; // we hand it a depth texture ourselves — see block above
    const c = aoPass.configuration;
    c.aoRadius = 0.55; // metres — about one sofa cushion
    c.distanceFalloff = 0.62; // tight, so contact darkening stays contact-sized
    c.intensity = 3.5;
    c.screenSpaceRadius = false;
    c.colorMultiply = true;
    // Pure-black occlusion in a warm interior reads as dirt. A near-black warm brown keeps the
    // crevices in the same colour family as the bounce light.
    c.color = new THREE.Color(0x140f0a);
    c.aoSamples = tier.aoSamples;
    c.denoiseSamples = tier.denoiseSamples;
    c.denoiseRadius = tier.denoiseRadius;
    c.denoiseIterations = tier.denoiseIterations;
    c.halfRes = tier.halfRes;
    c.depthAwareUpsampling = true;
    c.accumulate = false; // no temporal history — photo mode must be deterministic
    // n8ao's auto-detection traverses the whole scene graph looking for transparent materials.
    // We know the answer (glass slab, sheer curtains, mesh playpen), so state it once and turn
    // the traversal off.
    aoPass.autoDetectTransparency = false;
    // transparencyAware renders the scene's transparent objects an extra two times (with and
    // without depth write) at FULL resolution — `renderTransparency()`'s targets are sized off
    // `this.width/height` directly and are not scaled by `halfRes`. That means its cost doesn't
    // shrink with the halfRes change above; if anything its share of N8AO's total goes *up* now
    // that the main AO compute is ~4x cheaper. It buys AO under the glass slab and the sheer
    // curtains, a real but small fidelity win for a laptop that is already fill-rate bound and
    // failing its frame budget. Reserve it for `ultra`, where the budget exists to afford it.
    if (quality.tier === 'ultra') c.transparencyAware = true;
    composer.addPass(aoPass);
    aoPass.setDepthTexture(depthCopyTarget.depthTexture);
  }

  // ---------------------------------------------------------------------------------------
  // 3. screen-space reflections
  let ssrEffect = null;
  let ssrPass = null;
  if (quality.ssr) {
    const ultra = quality.tier === 'ultra';
    ssrEffect = new SSREffect(camera, {
      intensity: ultra ? 0.7 : 0.6,
      maxDistance: 6.0,
      thickness: 0.28,
      steps: ultra ? 32 : 24,
      refine: 6,
    });
    ssrPass = new EffectPass(camera, ssrEffect);
    // Pre-arm the depth texture before addPass(): EffectPass computes needsDepthTexture inside
    // its own initialize() (called synchronously from addPass), and it only comes out true when
    // getDepthTexture() is still null at that point. Set first, and the composer never asks.
    ssrPass.setDepthTexture(depthCopyTarget.depthTexture);
    composer.addPass(ssrPass);
  }

  // ---------------------------------------------------------------------------------------
  // 4–7. the merged grade pass
  const lensEffect = new LensEffect({ chromaticAberration: 0.0034 });

  let dofEffect = null;
  if (quality.dof) {
    // Checked what resolutionScale actually buys us here, since it's easy to assume it scales
    // the whole effect: postprocessing's DepthOfFieldEffect.setSize() only scales the "near"
    // bokeh chain (renderTarget/renderTargetNear/renderTargetCoCBlurred) by it — the CoC pass,
    // the mask pass and, notably, the "far" bokeh FILL pass (renderTargetFar, the wide-kernel
    // gather that produces the background blur, which is the visually dominant one in a room
    // seen from knee height) are all sized off the full frame resolution regardless of this
    // value. So resolutionScale is real but partial: it does not make DoF ~4x cheaper the way
    // halfRes does for AO. Measured in isolation this stage was already cheap relative to AO/
    // SMAA (a few ms inside the merged grade pass), so it isn't this round's lever — noted here
    // so nobody "fixes" a perceived regression by cranking this further expecting a big win.
    dofEffect = new DepthOfFieldEffect(camera, {
      focusDistance: 1.2, // metres — arm's length for a crawling baby
      focusRange: 0.55, // shallow-ish; a macro feel at knee height
      bokehScale: DOF_BOKEH,
      resolutionScale: quality.tier === 'ultra' ? 0.65 : 0.5,
    });
  }

  let bloomEffect = null;
  if (quality.bloom !== false) {
    bloomEffect = new BloomEffect({
      blendFunction: BlendFunction.ADD,
      mipmapBlur: true,
      luminanceThreshold: 0.72,
      luminanceSmoothing: 0.3,
      intensity: 0.55,
      radius: 0.74,
      levels: quality.tier === 'low' ? 6 : 8,
    });
  }

  const toneMappingEffect = new ToneMappingEffect({
    mode: ToneMappingMode.ACES_FILMIC,
    whitePoint: 4.0,
    middleGrey: 0.6,
    adaptive: false, // deterministic screenshots; no eye adaptation
  });

  const lut = createFilmLUT(engine?.caps || {});
  const lutEffect = new LUT3DEffect(lut, { tetrahedralInterpolation: false });

  const filmEffect = new FilmEffect({
    vignette: 0.34,
    vignetteStart: 0.38,
    grain: quality.tier === 'low' ? 0.022 : 0.028,
  });

  // Order matters and EffectPass re-sorts by `attributes` descending (stable). LensEffect carries
  // the DEPTH attribute purely so it lands ahead of DoF; everything after it is attribute-free and
  // therefore keeps the order written here.
  const gradeEffects = [lensEffect];
  if (dofEffect) gradeEffects.push(dofEffect);
  if (bloomEffect) gradeEffects.push(bloomEffect);
  gradeEffects.push(toneMappingEffect, lutEffect, filmEffect);

  const gradePass = new EffectPass(camera, ...gradeEffects);
  gradePass.setDepthTexture(depthCopyTarget.depthTexture); // see the depth-copy block above
  composer.addPass(gradePass);

  // ---------------------------------------------------------------------------------------
  // 8. edges
  //
  // Investigated as a possible ~20 ms structural cost (see tools/perf.mjs's "SMAA blend zeroed"
  // scenario). Two things were measured, in order:
  //
  //  1. Zeroing SMAA's blend weight while leaving SMAAEffect.update() running — same render
  //     targets, same edge-detection/weights draws, same preset-controlled search-step math,
  //     only the final composite contribution silenced — saved ~1.4 ms. Disabling the pass
  //     outright saved ~28.7 ms. That gap looked like a smoking gun for "it's the render-target
  //     switching, not the math" (SMAAEffect.update() does a clear + two full target-switching
  //     draws every frame on top of the merged pass's own blend, and ANGLE's Metal backend is
  //     known to make setRenderTarget calls expensive).
  //  2. So FXAAEffect — a genuinely single-shader effect with no internal sub-passes, no extra
  //     render targets, mergeable straight into the grade pass above for zero additional target
  //     switches — was tried as the direct test of that theory, per the coordinator's hypothesis
  //     3. It made things worse: with FXAA folded into gradePass, "no-grade" went from ~4.3 ms to
  //     ~30 ms — i.e. FXAA alone cost more than SMAA's entire pass did, with strictly fewer
  //     target switches than SMAA. That rules out "render-target/encoder switching count" as the
  //     root cause: FXAA has none of that overhead and was still expensive.
  //
  // The cost tracks the *edge-search itself* — SMAA's weights pass and FXAA's inline search both
  // walk along local contrast with texture reads whose UVs depend on the previous read's result,
  // and dependent/data-varying texture fetches are a documented slow path on tile-based GPUs
  // (which is what ANGLE's Metal backend sits on top of on a Mac) because they defeat prefetch.
  // That is a property of spatial edge-search antialiasing generically, not of SMAA specifically.
  //
  // A third candidate followed from that read: MSAA doesn't edge-search at all, and a TBDR GPU
  // resolves it in tile memory instead of paying the main-memory bandwidth that makes MSAA
  // expensive on a discrete desktop GPU — so it looked like a structural escape from the whole
  // technique class, not just another instance of it. Tested (not assumed): composer
  // `multisampling` set to `Math.min(4, engine.caps.maxSamples)` with the SMAA pass removed
  // entirely, A/B'd against plain SMAA. It came back within noise of SMAA's cost — real draw
  // calls disappeared (SMAA's two sub-passes), but wall-clock frame time did not move. So:
  // antialiasing costs roughly the same ~20 ms on this driver no matter which of these three
  // techniques supplies it. SMAA is kept because it's the better result for an equal price, and
  // because swapping techniques for no measured win is pure churn — not because the earlier
  // "not worth the bandwidth" reasoning about MSAA was correct (it wasn't, see engine.js).
  //
  // This is the "say so and stop chasing it" result: kept plain SMAA, at the preset already
  // dropped from HIGH to MEDIUM for `high` (a real, if small, win), because no in-budget
  // alternative reduced the antialiasing cost and this game already ships well above its frame
  // target once N8AO's halfRes change (above) is accounted for.
  const SMAA_PRESET_BY_TIER = {
    low: SMAAPreset.LOW,
    medium: SMAAPreset.MEDIUM,
    high: SMAAPreset.MEDIUM,
    ultra: SMAAPreset.HIGH,
  };
  const smaaEffect = new SMAAEffect({
    preset: SMAA_PRESET_BY_TIER[quality.tier] ?? SMAAPreset.MEDIUM,
    edgeDetectionMode: EdgeDetectionMode.COLOR,
  });
  const smaaPass = new EffectPass(camera, smaaEffect);
  // SMAAEffect declares EffectAttribute.DEPTH unconditionally (it reserves the attribute for
  // every edge-detection mode, not only EdgeDetectionMode.DEPTH) — same pre-arm as the passes
  // above, see the depth-copy block near the top of this function.
  smaaPass.setDepthTexture(depthCopyTarget.depthTexture);
  composer.addPass(smaaPass);

  composer.setSize(width, height, false);

  // ---------------------------------------------------------------------------------------
  // live state
  const grainRng = makeRng(0x9e3779b1);
  const focusTarget = new THREE.Vector3();
  const camWorld = new THREE.Vector3();
  const camForward = new THREE.Vector3();
  const probeOrigin = new THREE.Vector3();

  let hasFocusTarget = false;
  let focusManual = false; // someone else is driving focus; stop auto-focusing
  let autoFocus = true;
  let autoFocusClock = 0;
  let focusDistance = 1.2;
  let focusGoal = 1.2;
  let dofActive = !!dofEffect;

  let impactT = 0;
  let sprintT = 0;
  let sprintGoal = 0;
  let damageT = 0;
  let damageGoal = 0;

  let grainSeed = PHOTO_GRAIN_SEED;
  let grainClock = 0;
  let advancedThisFrame = false;

  // three's ACES chunk multiplies by `toneMappingExposure`, and ToneMappingEffect includes that
  // chunk, so the renderer uniform *is* the exposure control for the whole post chain. We write it
  // every frame (base × impact dip) but adopt any external change first, so LIGHT can still own
  // the value and we only ever ride on top of it.
  let baseExposure = renderer.toneMappingExposure || 1.0;
  let lastWrittenExposure = baseExposure;

  function isPhoto() {
    return ctx.state?.mode === 'photo';
  }

  function rebindCamera(next) {
    camera = next;
    camNear = next.near;
    camFar = next.far;
    composer.setMainCamera(next);
    if (aoPass) aoPass.camera = next;
    if (ssrEffect) ssrEffect.camera = next;
    if (dofEffect) dofEffect.camera = next;
  }

  let dofArmed = null;
  function applyFocus() {
    if (!dofEffect) return;
    if (!dofActive) {
      // A shot asked for "everything sharp". Collapse the circle of confusion and make the blend
      // a straight pass-through, so the composite is bit-for-bit the unblurred frame.
      if (dofArmed !== false) {
        dofEffect.bokehScale = 0;
        dofEffect.blendMode.opacity.value = 0;
        dofArmed = false;
      }
      return;
    }
    if (dofArmed !== true) {
      dofEffect.bokehScale = DOF_BOKEH;
      dofEffect.blendMode.opacity.value = 1;
      dofArmed = true;
    }
    // Focus range widens with distance the way a real lens' depth of field does, so the macro
    // feel at 0.3 m does not become an unusable 3 cm slice when the baby looks across the room.
    dofEffect.cocMaterial.focusDistance = focusDistance;
    dofEffect.cocMaterial.focusRange = THREE.MathUtils.clamp(0.28 + focusDistance * 0.34, 0.3, 3.2);
  }

  // Auto-focus: a 20 Hz probe down the camera axis. Without it the lens would sit at a fixed
  // 1.2 m and the whole point of a shallow depth of field at knee height — that the world in
  // front of the baby's face is sharp and everything else falls away — would be lost. GAME may
  // override at any time with setFocusTarget/setFocusDistance, which latches focusManual.
  function probeCentreDistance() {
    const phys = ctx.physics;
    if (!phys || typeof phys.raycast !== 'function') return 0;
    camera.getWorldPosition(camWorld);
    camera.getWorldDirection(camForward);
    // Start clear of the baby's own capsule, otherwise Rapier reports a zero-distance solid hit.
    probeOrigin.copy(camWorld).addScaledVector(camForward, 0.14);
    try {
      const hit = phys.raycast(probeOrigin, camForward, 12);
      if (!hit || !(hit.distance > 0)) return 0;
      return THREE.MathUtils.clamp(hit.distance + 0.14, 0.25, 12);
    } catch {
      return 0;
    }
  }

  function advance(dt) {
    const photo = isPhoto();
    const step = photo ? 0 : Math.min(0.05, Math.max(0, dt || 0));

    // focus
    if (hasFocusTarget) {
      camera.getWorldPosition(camWorld);
      focusGoal = Math.max(0.08, camWorld.distanceTo(focusTarget));
    } else if (autoFocus && !focusManual && !photo && dofEffect && ctx.state?.mode === 'playing') {
      autoFocusClock += step;
      if (autoFocusClock >= 0.05) {
        autoFocusClock = 0;
        const d = probeCentreDistance();
        focusGoal = d > 0 ? d : 4.0;
      }
    }
    if (photo || step <= 0) {
      focusDistance = focusGoal;
    } else {
      focusDistance += (focusGoal - focusDistance) * (1 - Math.exp(-step / FOCUS_TAU));
    }

    // envelopes
    if (photo) {
      impactT = 0;
      sprintT = 0;
      damageT = 0;
      grainSeed = PHOTO_GRAIN_SEED;
    } else {
      impactT = Math.max(0, impactT - step / IMPACT_DECAY);
      sprintT += (sprintGoal - sprintT) * (1 - Math.exp(-step / SPRINT_TAU));
      damageT += (damageGoal - damageT) * (1 - Math.exp(-step / DAMAGE_TAU));

      grainClock += step;
      const period = 1 / GRAIN_HZ;
      while (grainClock >= period) {
        grainClock -= period;
        grainSeed = 1 + grainRng() * 512;
      }
    }

    if (renderer.toneMappingExposure !== lastWrittenExposure) {
      baseExposure = renderer.toneMappingExposure;
    }
    lastWrittenExposure = baseExposure * (1.0 - 0.145 * impactT);
    renderer.toneMappingExposure = lastWrittenExposure;

    lensEffect.apply(impactT, sprintT);
    filmEffect.apply(impactT, damageT, grainSeed);
    applyFocus();
  }

  const offs = [];

  // ---------------------------------------------------------------------------------------
  const api = {
    composer,
    passes: { renderPass, aoPass, ssrPass, gradePass, smaaPass },
    effects: {
      lens: lensEffect,
      ssr: ssrEffect,
      dof: dofEffect,
      bloom: bloomEffect,
      toneMapping: toneMappingEffect,
      lut: lutEffect,
      film: filmEffect,
      smaa: smaaEffect,
    },

    update(dt) {
      advance(dt);
      advancedThisFrame = true;
    },

    render(dt) {
      const d = Math.min(0.05, Math.max(0, dt || 0));
      if (!advancedThisFrame) advance(d);
      advancedThisFrame = false;

      const live = ctx.camera;
      if (live && (live !== camera || live.near !== camNear || live.far !== camFar)) {
        rebindCamera(live);
      }

      // Freezing the library clock pins every built-in `time`-driven term in photo mode.
      composer.render(isPhoto() ? 0 : d);

      engine?.tickStats?.(d);
    },

    // main.js resizes the engine first (which owns renderer.setSize + pixel ratio), so the
    // authoritative size here is the drawing buffer, not the CSS size we were handed.
    resize() {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      const w = Math.max(1, size.x);
      const h = Math.max(1, size.y);
      composer.setSize(w, h, false);
      // composer.inputBuffer's depthTexture (attached above) is resized as part of setSize();
      // our own depthCopyTarget is not the composer's, so it needs its own resize here.
      depthCopyTarget.setSize(w, h);
    },

    /** Metres from the camera. Pass 0 (or a negative) to mean "hyperfocal — nothing blurs". */
    setFocusDistance(d) {
      hasFocusTarget = false;
      focusManual = true;
      if (!(d > 0)) {
        dofActive = false;
        return;
      }
      dofActive = !!dofEffect;
      focusGoal = d;
      if (isPhoto()) focusDistance = d;
    },

    /** Rack focus onto a world position — the interaction target, usually. */
    setFocusTarget(v3) {
      if (!v3) {
        hasFocusTarget = false;
        return;
      }
      focusTarget.copy(v3);
      hasFocusTarget = true;
      focusManual = true;
      dofActive = !!dofEffect;
      if (isPhoto()) {
        camera.getWorldPosition(camWorld);
        focusDistance = Math.max(0.08, camWorld.distanceTo(focusTarget));
        focusGoal = focusDistance;
      }
    },

    /** Hand focus back to the automatic centre-of-frame probe. */
    setAutoFocus(enabled = true) {
      autoFocus = !!enabled;
      if (enabled) {
        focusManual = false;
        hasFocusTarget = false;
        dofActive = !!dofEffect;
      }
    },

    /** A short punch: CA spike, vignette pinch, exposure dip. Decays over ~0.25 s. */
    impact(strength = 0.5) {
      if (isPhoto()) return;
      impactT = Math.min(1, impactT + THREE.MathUtils.clamp(strength, 0, 1));
    },

    /** 0..1 — a speed smear at the frame edges only. */
    setSprint(t01) {
      sprintGoal = THREE.MathUtils.clamp(t01 || 0, 0, 1);
    },

    /** 0..1 — warm red vignette bias as the parent closes in. */
    setDamage(t01) {
      damageGoal = THREE.MathUtils.clamp(t01 || 0, 0, 1);
    },

    /** Exposure in linear multiples, applied inside ACES (i.e. after DoF and bloom composite).
     *  LIGHT may use this to balance the key without touching every light intensity in the room. */
    setExposure(e) {
      baseExposure = e > 0 ? e : 1;
      lastWrittenExposure = baseExposure;
      renderer.toneMappingExposure = baseExposure;
    },

    getExposure() {
      return baseExposure;
    },

    /** No user-visible strings live in the render stack; kept for interface symmetry. */
    setLang() {},

    reset() {
      impactT = 0;
      sprintT = 0;
      sprintGoal = 0;
      damageT = 0;
      damageGoal = 0;
      grainClock = 0;
      grainSeed = PHOTO_GRAIN_SEED;
      hasFocusTarget = false;
      focusManual = false;
      autoFocusClock = 0;
      focusGoal = 1.2;
      focusDistance = 1.2;
      dofActive = !!dofEffect;
    },

    dispose() {
      for (const off of offs) {
        try {
          off?.();
        } catch {
          /* ignore */
        }
      }
      offs.length = 0;
      lut.dispose();
      // composer.dispose() tears down composer.inputBuffer, which cascades to the DepthTexture
      // we attached to it. depthCopyTarget is ours, not the composer's, so it needs its own call
      // (which likewise cascades to its own attached DepthTexture).
      depthCopyTarget.dispose();
      depthCopyMaterial.dispose();
      composer.dispose();
    },
  };

  // ---------------------------------------------------------------------------------------
  // Event wiring. GAME/BABY/FX may call impact()/setDamage() directly, but subscribing here means
  // the lens still reacts to a shattering vase even if nobody remembers to.
  const events = ctx.events;
  if (events) {
    offs.push(
      events.on('prop:shattered', () => api.impact(0.85)),
      events.on('fx:impact', (p) =>
        api.impact(THREE.MathUtils.clamp((p?.force || 1) * 0.18, 0.08, 1)),
      ),
      events.on('baby:bump', (p) => {
        const f = THREE.MathUtils.clamp((p?.force || 0) / 12, 0, 1);
        if (f > 0.14) api.impact(f * 0.6);
      }),
      events.on('parent:sees', (p) => api.setDamage(p?.level || 0)),
      events.on('game:start', () => api.reset()),
    );
  }

  ctx.track?.(api);
  advance(0);

  return api;
}
