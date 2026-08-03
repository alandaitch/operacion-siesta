// Quality tiers. Detected once from the GPU string + device memory, then overridable by the
// player in Settings and by ?quality= in the URL. Every module reads ctx.quality and must cost
// zero when its feature is disabled.
//
// On `pixelRatio`. These caps are deliberately far below the old ones, and below the device ratio
// on every Retina panel. A paired profile of this scene showed it is fill-bound end to end — AO,
// the twelve-tap shadow filter, the merged grade and SMAA all scale with pixel count — so on a
// 2× display the previous `high` cap of 1.75 was asking a laptop for 3× the fragments of a 1.0
// buffer, and it delivered about 6 fps. Rendering under native and letting SMAA carry the edges
// is what every shipping title does on this hardware. core/adaptive.js then scales *down* from
// these caps at runtime, so the number here is a ceiling, not a target.
//
// On `ultra`. Auto-detection no longer returns it, ever. It exists for a desktop with a discrete
// GPU and is reachable by `?quality=ultra` or from Settings; handing it to a MacBook because the
// GPU string says "Apple M3" is exactly the mistake that made the game unplayable for its author.

export const TIERS = {
  low: {
    tier: 'low',
    shadowMapSize: 512,
    softShadows: false,
    aoQuality: 0,
    ssr: false,
    dof: false,
    motionBlur: false,
    volumetrics: false,
    bloom: true,
    particleBudget: 300,
    anisotropy: 1,
    textureSize: 256,
    pixelRatio: 0.75,
    shadowDistance: 8,
    contactShadows: false,
  },
  medium: {
    tier: 'medium',
    shadowMapSize: 1024,
    softShadows: false,
    aoQuality: 1,
    ssr: false,
    dof: false,
    motionBlur: false,
    volumetrics: false,
    bloom: true,
    particleBudget: 800,
    anisotropy: 4,
    textureSize: 512,
    pixelRatio: 1.0,
    shadowDistance: 12,
    contactShadows: true,
  },
  high: {
    tier: 'high',
    shadowMapSize: 2048,
    softShadows: true,
    aoQuality: 2,
    ssr: true,
    dof: true,
    motionBlur: true,
    volumetrics: true,
    bloom: true,
    particleBudget: 2000,
    anisotropy: 8,
    textureSize: 1024,
    pixelRatio: 1.1,
    shadowDistance: 16,
    contactShadows: true,
  },
  ultra: {
    tier: 'ultra',
    shadowMapSize: 2048,
    softShadows: true,
    aoQuality: 3,
    ssr: true,
    dof: true,
    motionBlur: true,
    volumetrics: true,
    bloom: true,
    particleBudget: 4000,
    anisotropy: 16,
    textureSize: 2048,
    pixelRatio: 1.5,
    shadowDistance: 22,
    contactShadows: true,
  },
};

export function detectTier() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return 'medium';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    const mem = navigator.deviceMemory || 8;
    const cores = navigator.hardwareConcurrency || 4;
    const g = gpu.toLowerCase();
    const strong = /apple m[2-9]|rtx (30|40|50)|radeon rx (6|7|8)|arc a7/.test(g);
    const decent = /apple m1|apple gpu|rtx 20|gtx 16|radeon rx 5|iris xe/.test(g);
    // Note the ceiling: `high` is the best tier auto-detection will hand out. A GPU string tells
    // you the architecture, not the power budget or the panel it is driving, and an M-series
    // laptop on a 2× display is a very different machine from the desktop with the same string.
    if (strong && cores >= 8 && mem >= 8) return 'high';
    if (decent || (cores >= 8 && mem >= 8)) return 'high';
    if (cores >= 4) return 'medium';
    return 'low';
  } catch {
    return 'medium';
  }
}

export function makeQuality(name) {
  const base = TIERS[name] || TIERS.high;
  return { ...base, pixelRatio: Math.min(base.pixelRatio, window.devicePixelRatio || 1) };
}
