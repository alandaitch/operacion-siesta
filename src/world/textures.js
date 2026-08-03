// OPERATION NAPTIME — module TEX — the procedural texture engine.
// OWNER: MAT. Consumed by src/world/materials.js and by anyone who needs a surface.
//
// There are no image files in this game. Every albedo, normal, roughness, AO and alpha map in the
// room is arithmetic rendered into a typed array and uploaded as a THREE.DataTexture. This file
// is the front door: a registry of generators, a per-texture detail budget, a cache, and a
// self-test that profiles the lot.
//
// HOW TO USE IT (materials.js and friends):
//
//   const tex = createTextureLibrary(ctx);
//   const c = tex.get('concreteBoardFormed');            // cached; identical params → identical set
//   const mat = new THREE.MeshStandardMaterial({
//     map: c.map, normalMap: c.normalMap,
//     roughnessMap: c.roughnessMap, metalnessMap: c.metalnessMap, aoMap: c.aoMap,
//     roughness: 1, metalness: 1,                        // ← REQUIRED: three multiplies these
//   });
//   c.setRepeat(...c.repeatFor(6.8, 8.0));               // repeat from real-world metres
//
// THE FIVE THINGS EVERY CONSUMER MUST KNOW
//  1. `roughnessMap`, `metalnessMap` and `aoMap` are THE SAME TEXTURE — AO in .r, roughness in .g,
//     metalness in .b (the glTF ORM packing, which is exactly what three samples). One upload, not
//     three. Keep material.roughness = 1 and material.metalness = 1 or you will scale the map.
//     aoMap.channel is 0, i.e. it reads the same UV set as the albedo; set it to 1 yourself if
//     your mesh really carries a second UV set.
//  2. Every texture has flipY = false, so row 0 is v = 0 across albedo, normal, ORM and alpha.
//  3. Everything tiles seamlessly unless `tileable === false` (leaves, artwork, magazine, sleeve,
//     record — those are clamped). `tileMetres` says how much of the real world one tile covers;
//     `repeatFor(w, h)` turns metres into repeats so nobody has to guess scale.
//  4. Textures are shared and cached. NEVER dispose one yourself and never mutate .repeat on a
//     set you did not create — clone the texture (`t.clone()`) if you need per-object repeat.
//  5. Sizes come from ctx.quality.textureSize scaled by the per-generator DETAIL budget below.
//     Far-away or low-information surfaces generate at a quarter of the hero size; mipmaps and
//     anisotropy do the rest. A disabled quality tier must cost zero, so nothing is generated
//     until it is first requested (except what you pass to prewarm()).

import * as noise from './tex/noise.js';
import * as raster from './tex/raster.js';
import { configureRaster } from './tex/raster.js';

import {
  abstractArtwork, bark, brickExterior, canvasWeave, ceramicGlaze, concreteBoardFormed,
  marbleWhite, plasterWall, plywoodBirch, plywoodEdge, soil, terracotta, woodFloorPlank,
} from './tex/surfaces.js';
import {
  boucle, meshNet, muslinCrinkle, plushFuzz, playMatPrint, quiltedNylon, rattanCane, ribbedCorduroy,
  rugFringe, sheerVoile, twillCotton, velvetChenille, woolRugPile,
} from './tex/fabrics.js';
import {
  anodisedBlack, babySkin, bookCloth, brushedMetal, chromeSmudge, dirtOverlay, dustEdge,
  foilCrinkle, leafMonstera, leafSmall, magazineCover, paperCover, plasticMatte, printedSpine,
  scratchesOverlay, smudgeOverlay, speakerCloth, vinylGrooves, vinylSleeve,
} from './tex/objects.js';

// Re-export the toolkits so other modules can build one-off maps without importing internals.
export { noise, raster };
export {
  hashU, hash1, hash2, hash3, valueNoise2, valueNoise2xy, valueNoise3, gradNoise2, gradNoise3,
  simplex2, simplex3, worley2, worleyEdge2, W, fbmValue2, fbmValue2xy, fbmGrad2, fbmValue3,
  ridged2, turbulence2, warp2, WARP, torus2, stratifiedPoints, blueNoisePoints, localRng,
  clamp01, clamp, mix, smoothstep, fract, fade, wrapi,
} from './tex/noise.js';
export {
  makeCanvas, forEachPixel, heightToNormal, heightToAO, curvature, roughnessFrom, packORM,
  toTexture, beginSurface, finishSurface, fieldToBytes, lowFreqField, blurField, upsampleField,
  downsampleField, sampleField, stampDisc, stampDiscRgb, stampLine, stampRect, stampRectRgb,
  hexToRgb, hexToLinear, linearToByte, u8, configureRaster, rasterEnv,
} from './tex/raster.js';

// Re-export every generator so they can be called directly (they are pure: params in, maps out).
export {
  concreteBoardFormed, plasterWall, woodFloorPlank, plywoodBirch, plywoodEdge, brickExterior,
  marbleWhite, ceramicGlaze, terracotta, soil, bark, canvasWeave, abstractArtwork,
  boucle, velvetChenille, ribbedCorduroy, woolRugPile, rugFringe, sheerVoile, meshNet, rattanCane,
  plushFuzz, playMatPrint, muslinCrinkle, quiltedNylon, twillCotton,
  paperCover, bookCloth, printedSpine, magazineCover, vinylSleeve, vinylGrooves,
  brushedMetal, chromeSmudge, anodisedBlack, speakerCloth,
  leafMonstera, leafSmall, babySkin, foilCrinkle,
  dirtOverlay, dustEdge, scratchesOverlay, smudgeOverlay, plasticMatte,
};

/** Every generator, by name. `createTextureLibrary().get(name)` looks up here. */
export const GENERATORS = Object.freeze({
  // architecture
  concreteBoardFormed, plasterWall, woodFloorPlank, plywoodBirch, plywoodEdge, brickExterior,
  marbleWhite, ceramicGlaze, terracotta, soil, bark, canvasWeave, abstractArtwork,
  // soft goods
  boucle, velvetChenille, ribbedCorduroy, woolRugPile, rugFringe, sheerVoile, meshNet, rattanCane,
  plushFuzz, playMatPrint, muslinCrinkle, quiltedNylon, twillCotton,
  // print
  paperCover, bookCloth, printedSpine, magazineCover, vinylSleeve, vinylGrooves,
  // hard goods
  brushedMetal, chromeSmudge, anodisedBlack, speakerCloth, plasticMatte,
  // nature + characters
  leafMonstera, leafSmall, babySkin, foilCrinkle,
  // overlays
  dirtOverlay, dustEdge, scratchesOverlay, smudgeOverlay,
});

/** Sorted list of every generator name. */
export const TEXTURE_NAMES = Object.freeze(Object.keys(GENERATORS));

/** Generators whose output is a single object, not a tiling field (clamped wrapping). */
export const NON_TILING = Object.freeze(new Set([
  'abstractArtwork', 'magazineCover', 'vinylSleeve', 'vinylGrooves', 'leafMonstera', 'leafSmall', 'dustEdge',
]));

/**
 * Per-generator share of ctx.quality.textureSize. Powers of two only, so the resolved size stays
 * a power of two on every tier.
 *
 * The number that actually matters is texels per real-world metre (size / tileMetres), not the
 * raw resolution. The ceiling slab and the floor tile over 2.4 m, so they need the full budget
 * (≈426 texels/m); the bouclé tiles over 0.16 m and the rug over 0.30 m, so half the budget still
 * buys them 3200 and 1700 texels/m — four times the density of the floor. Everything else is seen
 * small, seen far, or carries little information, and mipmaps plus anisotropy cover the rest.
 */
export const DETAIL = Object.freeze({
  concreteBoardFormed: 1, woodFloorPlank: 1,
  boucle: 0.5, woolRugPile: 0.5,
  // The 15-lamination edge is the whole "self-built" tell but wraps an 18mm strip, so it needs
  // more of the budget than a 0.5 share buys it — bumped and capped separately below.
  plasterWall: 0.5, plywoodBirch: 0.5, plywoodEdge: 0.75, brickExterior: 0.5, marbleWhite: 0.5,
  // A single non-tiling canvas seen close in a portrait framing — the separable-weave moiré fix
  // needs the extra resolution to stay under Nyquist, and it costs nothing anywhere else since
  // there is exactly one of these in the whole room.
  ceramicGlaze: 0.5, terracotta: 0.5, abstractArtwork: 1.0, velvetChenille: 0.5,
  ribbedCorduroy: 0.5, sheerVoile: 0.5, meshNet: 0.5, rattanCane: 0.5, quiltedNylon: 0.5,
  playMatPrint: 0.5, muslinCrinkle: 0.5, printedSpine: 0.5, magazineCover: 0.5, vinylSleeve: 0.5,
  // The nine hero monstera leaves are alpha-cutout at close range — 0.5 left the fenestration edges
  // a binary staircase at 2-9 texels. 1.0 (2048 on ultra, via MAX_PX below) gets them into MSAA/
  // alphaToCoverage range while everything else on this line is unaffected.
  vinylGrooves: 0.5, leafMonstera: 1.0, babySkin: 0.5, foilCrinkle: 0.5,
  soil: 0.25, bark: 0.25, canvasWeave: 0.25, rugFringe: 0.25, plushFuzz: 0.25, twillCotton: 0.25,
  paperCover: 0.25, bookCloth: 0.25, brushedMetal: 0.25, chromeSmudge: 0.25, anodisedBlack: 0.25,
  speakerCloth: 0.25, leafSmall: 0.25, plasticMatte: 0.25, dirtOverlay: 0.25, dustEdge: 0.25,
  scratchesOverlay: 0.25, smudgeOverlay: 0.25,
});

/**
 * Absolute ceiling in texels per generator, applied after DETAIL. This is the VRAM governor: the
 * `ultra` tier doubles textureSize to 2048, which would otherwise quadruple the memory of all
 * 45 sets (>600 MB). Instead ultra spends its extra budget only where it shows — the board-formed
 * ceiling, which is the largest and most characterful surface in the frame — and everything else
 * stays at its `high` resolution. Total upload lands near 155 MB on high and 205 MB on ultra.
 */
export const MAX_PX = Object.freeze({
  concreteBoardFormed: 2048, woodFloorPlank: 1024, plywoodEdge: 1024, abstractArtwork: 1024,
  // Capped at 1024 even on ultra (not the full 2048 the finding suggested) — leafMonstera also
  // carries an alphaMap, so a 2048 leaf would be a ~95 MB single texture set against a total
  // ultra-tier budget note of ~205 MB. 1024 already fixes the alpha-cutout aliasing the finding
  // measured; it does not need the full doubling on top of that.
  leafMonstera: 1024,
});

/**
 * Suggested generator + params for each canonical material name in CONTRACTS §10. This is a
 * convenience for materials.js, not a contract — override freely. Colours are the ones the
 * reference photograph calls for.
 */
export const SUGGESTED_FOR_MATERIAL = Object.freeze({
  'concrete.ceiling': ['concreteBoardFormed', {}],
  'concrete.beam': ['concreteBoardFormed', { seed: 1177, stain: 0.75 }],
  'plaster.wall': ['plasterWall', {}],
  'plaster.ceilingEdge': ['plasterWall', { seed: 2299, colour: 0xe6ded2 }],
  'floor.wood': ['woodFloorPlank', {}],
  'floor.skirting': ['plasterWall', { seed: 2255, colour: 0xf2ede4 }],
  'wood.ply': ['plywoodBirch', {}],
  'wood.plyEdge': ['plywoodEdge', {}],
  'wood.oak': ['woodFloorPlank', { seed: 3311, colour: 0xa8845c, tileMetres: [1.2, 0.5] }],
  'wood.walnut': ['woodFloorPlank', { seed: 3322, colour: 0x5f4530, tileMetres: [1.2, 0.5] }],
  'wood.birchToy': ['plywoodBirch', { seed: 4411, colour: 0xe8d3ad }],
  rattan: ['rattanCane', {}],
  'fabric.boucle': ['boucle', {}],
  'fabric.velvetCream': ['velvetChenille', {}],
  'fabric.navyRib': ['ribbedCorduroy', {}],
  'fabric.navyFlat': ['twillCotton', { colour: 0x2b3550 }],
  'fabric.sheer': ['sheerVoile', {}],
  'fabric.mesh': ['meshNet', {}],
  'fabric.playpenTrim': ['quiltedNylon', {}],
  'fabric.playmat': ['playMatPrint', {}],
  'fabric.muslin': ['muslinCrinkle', {}],
  'fabric.plush': ['plushFuzz', {}],
  'fabric.denim': ['twillCotton', {}],
  'rug.wool': ['woolRugPile', {}],
  lampshade: ['muslinCrinkle', { seed: 31099, colour: 0xf6ecd9, tileMetres: 0.2 }],
  'metal.blackAnodised': ['anodisedBlack', {}],
  'metal.chrome': ['chromeSmudge', {}],
  'metal.brass': ['brushedMetal', { colour: 0xc9a24a, baseRough: 0.38 }],
  'metal.steelWhite': ['brushedMetal', { colour: 0xeceae4, baseRough: 0.45 }],
  'metal.speakerGrille': ['speakerCloth', {}],
  'ceramic.white': ['ceramicGlaze', {}],
  'ceramic.glazed': ['ceramicGlaze', { seed: 8877, colour: 0xe9e4d6 }],
  'ceramic.terracotta': ['terracotta', {}],
  'marble.white': ['marbleWhite', {}],
  'plastic.toy': ['plasticMatte', {}],
  'plastic.matte': ['plasticMatte', { colour: 0x2c2c30 }],
  silicone: ['plasticMatte', { colour: 0xdfa3b4, seed: 5911 }],
  'foil.snack': ['foilCrinkle', {}],
  'paper.book': ['paperCover', {}],
  'paper.page': ['paperCover', { seed: 41077, colour: 0xf4f0e6 }],
  'paper.magazine': ['magazineCover', {}],
  'card.print': ['printedSpine', {}],
  'vinyl.black': ['vinylGrooves', {}],
  'vinyl.sleeve': ['vinylSleeve', {}],
  'art.canvas': ['abstractArtwork', {}],
  'leaf.monstera': ['leafMonstera', {}],
  'leaf.small': ['leafSmall', {}],
  soil: ['soil', {}],
  bark: ['bark', {}],
  'skin.baby': ['babySkin', {}],
  'skin.parent': ['babySkin', { seed: 53099, colour: 0xe6b894, tileMetres: 0.12 }],
  'cloth.onesie': ['twillCotton', { colour: 0xdcd6c8, seed: 33077 }],
  'cloth.diaper': ['muslinCrinkle', { colour: 0xf7f5f2, seed: 31077 }],
  'cloth.parent': ['twillCotton', { colour: 0x394452 }],
  'brick.exterior': ['brickExterior', {}],
});

// ─────────────────────────────────────────────────────────────── cache ──

const pow2 = (v) => Math.max(16, 2 ** Math.round(Math.log2(Math.max(16, v))));

/** Texel size a generator gets on a given tier: DETAIL share of the budget, under its own cap. */
export function resolveSize(name, textureSize = 1024) {
  const cap = MAX_PX[name] ?? (DETAIL[name] >= 0.5 ? 512 : 256);
  return Math.min(pow2(textureSize * (DETAIL[name] ?? 0.5)), cap);
}

/** Stable key for the cache: identical (generator, size, params) must hit. */
function cacheKey(name, size, params) {
  const keys = Object.keys(params).filter((k) => k !== 'size').sort();
  let s = `${name}|${size}`;
  for (const k of keys) s += `|${k}=${params[k]}`;
  return s;
}

const DEBUG_SETS = new Map();

/** A 2x2 magenta set, returned when a generator throws so the mistake is visible, not fatal. */
function debugSet(name) {
  if (DEBUG_SETS.has(name)) return DEBUG_SETS.get(name);
  const data = new Uint8Array([255, 0, 190, 255, 200, 0, 150, 255, 200, 0, 150, 255, 255, 0, 190, 255]);
  const map = raster.toTexture(data, { size: 2, srgb: true, generateMipmaps: false, name: `${name}.debug` });
  const flat = new Uint8Array([128, 128, 255, 255, 128, 128, 255, 255, 128, 128, 255, 255, 128, 128, 255, 255]);
  const normalMap = raster.toTexture(flat, { size: 2, generateMipmaps: false, name: `${name}.debugN` });
  const orm = raster.toTexture(new Uint8Array([255, 200, 0, 255, 255, 200, 0, 255, 255, 200, 0, 255, 255, 200, 0, 255]), {
    size: 2, generateMipmaps: false, name: `${name}.debugORM`,
  });
  const set = {
    name, size: 2, map, normalMap, roughnessMap: orm, metalnessMap: null, aoMap: null, orm,
    alphaMap: null, tileMetres: [1, 1], normalScale: 1, isDebug: true, tileable: true,
    displacementish: { data: new Float32Array(4), size: 2, scale: 0, texture: null },
    repeatFor: () => [1, 1],
    setRepeat() { return this; },
    dispose() { map.dispose(); normalMap.dispose(); orm.dispose(); DEBUG_SETS.delete(name); },
  };
  DEBUG_SETS.set(name, set);
  return set;
}

/** Per-tier AO budget: baked AO matters MOST on low tiers, where there is no screen-space GTAO. */
const AO_BUDGET = {
  low: { aoSamples: 4, aoSteps: 3 },
  medium: { aoSamples: 6, aoSteps: 4 },
  high: { aoSamples: 8, aoSteps: 5 },
  ultra: { aoSamples: 12, aoSteps: 6 },
};

/**
 * The texture library. One per game; created by materials.js, which owns the material objects.
 * @param {object} ctx the standard context (uses ctx.quality, ctx.renderer, ctx.track)
 */
export function createTextureLibrary(ctx = {}) {
  const quality = ctx.quality || { textureSize: 1024, anisotropy: 8, tier: 'high' };
  const maxAniso = ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? 16;
  configureRaster({
    anisotropy: quality.anisotropy ?? 8,
    maxAnisotropy: maxAniso,
    tier: quality.tier || 'high',
    ...(AO_BUDGET[quality.tier] || AO_BUDGET.high),
  });

  const cache = new Map();
  const timings = [];
  let bytes = 0;

  /** Resolved pixel size for a generator on this quality tier. */
  function sizeFor(name, override) {
    if (override) return pow2(override);
    return resolveSize(name, quality.textureSize || 1024);
  }

  function build(name, params) {
    const gen = GENERATORS[name];
    const size = sizeFor(name, params.size);
    const key = cacheKey(name, size, params);
    const hit = cache.get(key);
    if (hit) return hit;

    let set;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    try {
      set = gen({ ...params, size });
    } catch (err) {
      console.error(`[tex] generator "${name}" failed —`, err);
      set = debugSet(name);
    }
    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    set.tileable = !NON_TILING.has(name);
    set.key = key;
    set.ms = ms;
    timings.push({ name, size, ms });
    // 3 RGBA maps (+alpha) and a third again for the mip chain.
    const maps = 3 + (set.alphaMap ? 1 : 0);
    bytes += size * size * 4 * maps * 1.34;
    cache.set(key, set);
    ctx.track?.(set);
    return set;
  }

  const api = {
    /**
     * Fetch (and generate on first use) a texture set.
     * @param {string} name one of TEXTURE_NAMES
     * @param {object} [params] generator params; `size` overrides the tier budget
     */
    get(name, params = {}) {
      if (!GENERATORS[name]) {
        console.warn(`[tex] unknown texture "${name}" — returning debug magenta`);
        return debugSet(name);
      }
      return build(name, params);
    },
    /** True if `name` is a known generator. */
    has: (name) => !!GENERATORS[name],
    /** Every generator name. */
    names: () => TEXTURE_NAMES.slice(),
    /** Resolved size (px) this tier would use for `name`. */
    sizeFor,
    /** The suggested (generator, params) pair for a canonical material name, or null. */
    suggestionFor(materialName) {
      const s = SUGGESTED_FOR_MATERIAL[materialName];
      return s ? { name: s[0], params: s[1] } : null;
    },
    /** Build the texture set a canonical material name asks for (see SUGGESTED_FOR_MATERIAL). */
    forMaterial(materialName) {
      const s = SUGGESTED_FOR_MATERIAL[materialName];
      if (!s) return null;
      return build(s[0], s[1]);
    },
    /**
     * Generate a list of sets up front (boot screen time is cheaper than a hitch mid-crawl).
     * Yields to the event loop between textures so the loading bar can actually paint.
     */
    async prewarm(names = ['concreteBoardFormed', 'plasterWall', 'woodFloorPlank', 'boucle', 'woolRugPile'], onProgress) {
      for (let i = 0; i < names.length; i++) {
        const n = names[i];
        if (Array.isArray(n)) api.get(n[0], n[1]);
        else api.get(n);
        onProgress?.((i + 1) / names.length, n);
        await new Promise((r) => setTimeout(r, 0));
      }
      return api;
    },
    /** Cache/pressure report: count, wall time spent generating, approximate VRAM. */
    stats() {
      const total = timings.reduce((a, t) => a + t.ms, 0);
      return {
        count: cache.size,
        ms: Math.round(total * 10) / 10,
        megabytes: Math.round((bytes / 1048576) * 10) / 10,
        slowest: timings.slice().sort((a, b) => b.ms - a.ms).slice(0, 6),
        tier: quality.tier,
      };
    },
    /** Generate every texture once and report timings (see the module-level selfTest). */
    selfTest: (opts) => selfTest({ ctx, quality, ...opts }),
    /** Drop every cached texture. Called by ctx.disposeAll via track(), or manually. */
    dispose() {
      for (const set of cache.values()) set.dispose?.();
      cache.clear();
      timings.length = 0;
      bytes = 0;
    },
  };

  // Convenience methods: lib.boucle({…}) === lib.get('boucle', {…}).
  for (const name of TEXTURE_NAMES) {
    api[name] = (params = {}) => api.get(name, params);
  }
  return api;
}

/**
 * Generate every texture once and return timings, so the integrator can profile the boot cost.
 * Disposes what it makes unless `keep` is true.
 * @returns {{total:number, count:number, megabytes:number, entries:Array, slowest:Array}}
 */
export function selfTest({ ctx = {}, quality = null, size = null, keep = false, only = null } = {}) {
  const q = quality || ctx.quality || { textureSize: 1024, anisotropy: 8, tier: 'high' };
  configureRaster({
    anisotropy: q.anisotropy ?? 8,
    maxAnisotropy: ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? 16,
    ...(AO_BUDGET[q.tier] || AO_BUDGET.high),
  });
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const names = only || TEXTURE_NAMES;
  const entries = [];
  let bytes = 0;
  const t0 = now();
  const made = [];
  for (const name of names) {
    const px = size ? pow2(size) : resolveSize(name, q.textureSize || 1024);
    const a = now();
    let set;
    let error = null;
    try {
      set = GENERATORS[name]({ size: px });
    } catch (err) {
      error = String(err && err.message ? err.message : err);
      set = null;
    }
    const ms = now() - a;
    if (set) {
      const maps = 3 + (set.alphaMap ? 1 : 0);
      bytes += px * px * 4 * maps * 1.34;
      made.push(set);
    }
    entries.push({ name, size: px, ms: Math.round(ms * 100) / 100, error });
  }
  const total = now() - t0;
  if (!keep) for (const s of made) s.dispose?.();
  return {
    total: Math.round(total * 10) / 10,
    count: entries.length,
    megabytes: Math.round((bytes / 1048576) * 10) / 10,
    tier: q.tier,
    entries,
    failures: entries.filter((e) => e.error),
    slowest: entries.slice().sort((a, b) => b.ms - a.ms).slice(0, 8),
  };
}
