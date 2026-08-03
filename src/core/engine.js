// Renderer, scene and camera bootstrap.
// OWNER: RENDER. See CONTRACTS.md before editing.
//
// Approach. This file deliberately does as little "look" work as possible: it owns the WebGL2
// context, colour management and the shadow map, and nothing else. Three decisions matter here:
//
//  1. `toneMapping = NoToneMapping`. The composer's ToneMappingEffect performs ACES with a proper
//     white point *after* bloom/DoF/grade, so letting three tonemap per-material would double up
//     and crush the highlights before the lens ever sees them. `toneMappingExposure` still matters
//     though: three's ACES shader chunk multiplies by it, and the composer's tone mapping effect
//     includes that chunk, so this uniform *is* the exposure control for the whole post chain.
//     POSTFX drives it; leave it at 1.0 here.
//  2. Antialiasing is off at the context level; SMAA runs at the end of the post chain.
//     Both were tested against MSAA on this GPU (see postfx.js) and came back within noise of
//     it — SMAA is kept for the better edge quality at the same cost, not because MSAA is
//     bandwidth-expensive here the way it would be on a discrete desktop GPU.
//  3. `shadowMap.autoUpdate` is left on here but `shadowNeedsUpdate()` is exported so LIGHT can
//     turn it off and refresh on demand. The room is architecturally static: re-rasterising four
//     2048² shadow maps every frame for a slab that never moves is the single dumbest cost in an
//     interior renderer.
//
// The stats ring buffer needs `renderer.info.autoReset = false`, because the composer issues a
// dozen `renderer.render()` calls per frame and three resets the counters on every one of them;
// with autoReset off we accumulate the true per-frame totals and reset once in `tickStats()`.

import * as THREE from 'three';

const STAT_FRAMES = 30;

export function createEngine(canvas, quality) {
  THREE.ColorManagement.enabled = true;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // SMAA happens in post
    alpha: false,
    depth: true,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    precision: 'highp',
    logarithmicDepthBuffer: false,
    failIfMajorPerformanceCaveat: false,
  });

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping; // POST owns ACES
  renderer.toneMappingExposure = 1.0; // read by the composer's ACES chunk — see header note
  renderer.autoClear = true;
  renderer.sortObjects = true;
  renderer.info.autoReset = false;
  renderer.debug.checkShaderErrors = true;

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = quality.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = true;

  const scene = new THREE.Scene();
  // LIGHT owns the environment and the sky backdrop. A black clear colour behind an interior is
  // wrong (it makes every window edge read as a hole), but it is not our call to make.
  scene.background = null;
  scene.environmentIntensity = 1.0;

  const baseFov = 62; // wide, baby-like; the art bible asks for 55–65 vertical
  const camera = new THREE.PerspectiveCamera(baseFov, 1, 0.02, 45);
  camera.position.set(0.0, 0.42, 2.0); // crawling eye height, near the playpen
  camera.lookAt(0.1, 0.5, -1.6);
  camera.updateProjectionMatrix();

  // --- capability probe ---------------------------------------------------------------------
  const gl = renderer.getContext();
  const isWebGL2 =
    typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

  let maxSamples = 0;
  try {
    maxSamples = isWebGL2 ? gl.getParameter(gl.MAX_SAMPLES) | 0 : 0;
  } catch {
    maxSamples = 0;
  }

  const caps = {
    webgl2: isWebGL2,
    float32Filterable: renderer.extensions.has('OES_texture_float_linear'),
    halfFloatFilterable: isWebGL2 || renderer.extensions.has('OES_texture_half_float_linear'),
    maxSamples,
    anisotropy: renderer.capabilities.getMaxAnisotropy(),
    maxTextureSize: renderer.capabilities.maxTextureSize,
    maxTextures: renderer.capabilities.maxTextures,
    precision: renderer.capabilities.precision,
  };

  if (!isWebGL2) {
    console.warn('[engine] WebGL2 unavailable — post-processing will be degraded.');
  }

  // --- size ---------------------------------------------------------------------------------
  // `renderScale` is a second, dynamic multiplier on top of the tier's pixel-ratio cap, owned by
  // core/adaptive.js. Everything expensive in this renderer is fill-bound — the AO, the shadow
  // filter, the grade, SMAA — so resolution is the one knob that trades quality for frame rate
  // smoothly instead of in visible steps, and it is the knob a laptop actually needs. Photo mode
  // never touches it, so screenshots stay byte-comparable.
  const size = { width: 1, height: 1, pixelRatio: 1, renderScale: 1 };
  let renderScale = 1;

  function clampedPixelRatio() {
    const device = window.devicePixelRatio || 1;
    const cap = quality.pixelRatio || 1;
    return Math.max(0.4, Math.min(device, cap) * renderScale);
  }

  function resize(w, h) {
    const width = Math.max(1, Math.floor(w));
    const height = Math.max(1, Math.floor(h));
    const pr = clampedPixelRatio();
    size.width = width;
    size.height = height;
    size.pixelRatio = pr;
    size.renderScale = renderScale;
    renderer.setPixelRatio(pr);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  // --- stats --------------------------------------------------------------------------------
  const dtRing = new Float32Array(STAT_FRAMES);
  const callRing = new Float32Array(STAT_FRAMES);
  const triRing = new Float32Array(STAT_FRAMES);
  let ringIndex = 0;
  let ringCount = 0;

  const stats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0, programs: 0 };

  function tickStats(dt) {
    const info = renderer.info;
    dtRing[ringIndex] = dt > 1e-6 ? dt : 1 / 60;
    callRing[ringIndex] = info.render.calls;
    triRing[ringIndex] = info.render.triangles;
    ringIndex = (ringIndex + 1) % STAT_FRAMES;
    ringCount = Math.min(ringCount + 1, STAT_FRAMES);

    let sumDt = 0;
    let sumCalls = 0;
    let sumTris = 0;
    for (let i = 0; i < ringCount; i++) {
      sumDt += dtRing[i];
      sumCalls += callRing[i];
      sumTris += triRing[i];
    }
    stats.fps = sumDt > 0 ? ringCount / sumDt : 0;
    stats.frameMs = (sumDt / ringCount) * 1000;
    stats.drawCalls = Math.round(sumCalls / ringCount);
    stats.triangles = Math.round(sumTris / ringCount);
    stats.programs = info.programs ? info.programs.length : 0;
    info.reset();
  }

  // --- shadow control (LIGHT drives this) ----------------------------------------------------
  /** Force one shadow-map refresh on the next render. Cheap; call it whenever the sun moves or a
   *  large caster settles. Pair with `setShadowAutoUpdate(false)` for a static room. */
  function shadowNeedsUpdate() {
    renderer.shadowMap.needsUpdate = true;
  }

  function setShadowAutoUpdate(enabled) {
    renderer.shadowMap.autoUpdate = !!enabled;
    if (!enabled) renderer.shadowMap.needsUpdate = true;
  }

  const engine = {
    renderer,
    scene,
    camera,
    quality,
    caps,
    stats,
    size,
    baseFov,
    resize,
    tickStats,
    shadowNeedsUpdate,
    setShadowAutoUpdate,

    getRenderScale() { return renderScale; },

    /** Set the dynamic resolution multiplier. Returns true if it actually changed the buffer. */
    setRenderScale(s) {
      const next = Math.max(0.4, Math.min(1, s || 1));
      if (Math.abs(next - renderScale) < 0.004) return false;
      renderScale = next;
      resize(size.width, size.height);
      return true;
    },

    /** Fog hook for LIGHT. Exponential fog is wrong for a 7 m room, but a very slight linear haze
     *  in the far corners sells depth; either way the decision belongs to the lighting agent. */
    setFog(fog = null) {
      scene.fog = fog;
      return fog;
    },

    /** Convenience so LIGHT does not have to reach into `scene` for the IBL. */
    setEnvironment(texture, intensity = 1.0) {
      scene.environment = texture || null;
      scene.environmentIntensity = intensity;
      return texture;
    },

    setFov(fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    },

    dispose() {
      renderer.dispose();
    },
  };

  return engine;
}
