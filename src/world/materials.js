// OPERATION NAPTIME — module MAT — the procedural PBR material library.
// OWNER: MAT. Implements CONTRACTS.md §10 exactly. Everyone else consumes it and nobody else
// constructs a MeshStandardMaterial, so texture memory, anisotropy and the quality tiers stay
// under one roof.
//
//   ctx.materials.get('floor.wood')                          → cached, shared, never dispose it
//   ctx.materials.tinted('plastic.toy', 0x2f7fbf, {...})     → cached clone with overrides
//   ctx.materials.tiled('plaster.wall', 8.0, 2.78)           → cached clone tiled to a real surface
//   ctx.materials.has(name) / names() / all() / atlas(name) / textureSet(name)
//   await ctx.materials.prewarm(onProgress)                  → generate the heavy maps, with yields
//   ctx.materials.setEnvironment(tex, intensity)             → LIGHT owns the IBL and its strength
//   ctx.materials.stats()                                    → { built, textures, estimatedMB, … }
//
// HOW IT WORKS
//  · Lazy. Nothing is built until it is first asked for, so a tier that never shows the balcony
//    never pays for brick. `get()` never returns undefined: an unknown name warns once and hands
//    back a vivid magenta debug material, so the mistake shows up in a screenshot rather than as a
//    crash halfway through the build.
//  · Declarative. Every recipe lives in ./mat/recipes.*.js as a spec — texture, roughness band,
//    sheen lobe, tiling extent in real metres — and ./mat/util.js turns that into a THREE material.
//    Quality-tier downgrades (no sheen on `low`, transmission only where it earns its cost) happen
//    in one place, so no recipe has to know what tier it is on.
//  · Tiled in metres, not in magic numbers. Each recipe declares the real-world extent of the
//    surface it usually dresses; the repeat comes from that divided by the generator's tileMetres.
//    If your mesh is a different size, call `tiled(name, w, h)` and you get a cached clone whose
//    maps share the same GPU upload.
//  · envMapIntensity belongs to LIGHT. Materials only carry a relative `userData.envBoost` (foil
//    and chrome want more environment than plaster does); `setEnvironment` multiplies the two, and
//    applies to materials built later as well.

import * as THREE from 'three';
import { createTextureLibrary } from './textures.js';
import { hairStrands, laptopUI, skyGradient } from './mat/generators.js';
import { atLeast, reinstallPatches, safeColour } from './mat/util.js';
import { ARCHITECTURE, WOOD } from './mat/recipes.arch.js';
import { SOFT } from './mat/recipes.soft.js';
import { HARD } from './mat/recipes.hard.js';
import { PRINT, NATURE, CHARACTERS, TECH, EXTERIOR } from './mat/recipes.props.js';

/** Every canonical material name in CONTRACTS §10 → its recipe. This list is closed. */
export const RECIPES = Object.freeze({
  ...ARCHITECTURE, ...WOOD, ...SOFT, ...HARD, ...PRINT, ...NATURE, ...CHARACTERS, ...TECH, ...EXTERIOR,
});

/** Sorted list of every material name the library answers to. */
export const MATERIAL_NAMES = Object.freeze(Object.keys(RECIPES).sort());

/**
 * What `prewarm()` builds up front, with a yield between each so the loading bar keeps painting:
 * every material whose texture set is generated at 512 px or more. What is left to build lazily is
 * the 256 px tail — paper, plastic, twill, overlays — none of which costs more than ~20 ms, so the
 * world build never stalls long enough to be felt.
 */
const PREWARM = Object.freeze([
  'concrete.ceiling', 'floor.wood', 'plaster.wall', 'rug.wool',
  'fabric.boucle', 'fabric.velvetCream', 'fabric.mesh', 'fabric.sheer',
  'wood.ply', 'wood.plyEdge', 'wood.oak', 'wood.walnut', 'concrete.beam',
  'fabric.playpenTrim', 'fabric.playmat', 'fabric.muslin', 'fabric.navyRib', 'fabric.plush',
  'metal.blackAnodised', 'metal.chrome', 'ceramic.white', 'ceramic.terracotta', 'marble.white',
  'glass.clear', 'foil.snack', 'rattan', 'lampshade',
  'skin.baby', 'hair.baby', 'leaf.monstera',
  'card.print', 'vinyl.black', 'vinyl.sleeve', 'paper.magazine', 'art.canvas',
  'brick.exterior', 'sky.backdrop', 'screen.laptop',
]);

/**
 * THE TRANSMISSION BUDGET — the most expensive single decision in this library.
 *
 * `MeshPhysicalMaterial.transmission > 0` is not a shading feature, it is a *render topology*
 * feature. Every frame in which any transmissive material survives frustum culling,
 * `WebGLRenderer.renderTransmissionPass()` re-renders the entire opaque scene into a second
 * full-resolution 4×MSAA HalfFloat target, resolves it and regenerates its whole mip chain — and
 * does that resolve+mip a SECOND time if any of those materials is `DoubleSide` (three r170 renders
 * the back faces of double-sided transmissive objects into the same target in a follow-up loop).
 * The price is per *frame*, not per object, and it is paid at full resolution even when the
 * adaptive controller has scaled the main frame down.
 *
 * MEASURED, at `high`, 1600×900, full resolution, with tools/perfprobe.mjs. Seventeen materials
 * carried transmission when this started (three recipes plus fourteen `tinted()` clones of them):
 *
 *     17 transmissive materials (as shipped)                       40.26 ms
 *      1 — `glass.clear` only, everything else substituted         31.60 ms
 *      0 — transmission is `ultra` only                            21.87 ms
 *
 * Note the shape of that. Going 17 → 1 saved 8.7 ms, and going 1 → 0 saved another 9.7 ms, because
 * **the pass is priced per frame, not per material**: sixteen of the seventeen were only ever
 * paying for extra back-face renders and a second resolve, while the seventeenth was still holding
 * the whole scene re-render open by itself. There is no cheap way to keep "just one".
 *
 * So the budget below is EMPTY, and that is a deliberate verdict rather than a default. The brief
 * this was done under said one material could survive "only if it earns its 7 ms", and the obvious
 * candidate was the glass coffee table — refraction is the whole point of a glass slab. It does not
 * earn it. One 1.10 × 0.55 m slab costs 9.7 ms, 31% of the frame, and it cannot even be scoped to
 * frames the table is in: BABY builds the baby's corneas out of `glass.clear` and DRESS builds two
 * glass bottles out of it, so the pass is open essentially always. `glass.clear` gets the
 * Fresnel-alpha substitute in ./mat/recipes.hard.js instead, which is a better-looking pane than
 * the milky opacity-0.18 fallback it had before and costs nothing.
 *
 *   ultra — every transmission its recipe asks for. That is the reference look and what
 *           `?quality=ultra` screenshots are for.
 *   high and below — the names in TRANSMISSION_BUDGET, and nothing else. Empty ships nothing.
 *
 * TO SHIP THE TABLE'S REAL REFRACTION AT `high`, add 'glass.clear' to the array — that is the whole
 * change, and the numbers above are what it costs. Everything else in this library authors a
 * substitute rather than a `transmission: 0`: `translucency` in ./mat/util.js (the forward-scatter
 * lobe a backlit voile, a backlit leaf and a lit lampshade actually need) and `thinGlass` (Fresnel
 * alpha plus the arris tint), both a handful of ALU instead of a second scene render.
 *
 * Anything not on this list gets its `transmission` block skipped below `ultra` — including a
 * `transmission` raised through `tinted()` by a consumer, which is why `applyOverrides` checks the
 * budget too. Transmission lives under one roof or it does not stay budgeted.
 */
const TRANSMISSION_BUDGET = Object.freeze([]);

/** MAT's own generators (the three maps TEX does not carry) and their share of the texel budget. */
const CUSTOM = Object.freeze({
  hairStrands: { fn: hairStrands, share: 0.5, cap: 512 },
  laptopUI: { fn: laptopUI, share: 0.25, cap: 256 },
  skyGradient: { fn: skyGradient, share: 0.5, cap: 512 },
});

const pow2 = (v) => Math.max(16, 2 ** Math.round(Math.log2(Math.max(16, v))));

/** Stable key for the variant cache — object key order must not create a second material. */
function stableKey(o) {
  if (!o) return '';
  return Object.keys(o).sort().map((k) => `${k}=${JSON.stringify(o[k])}`).join(',');
}

/** Material properties that are THREE.Color instances and therefore take a hex, not a number. */
const COLOUR_PROPS = new Set(['color', 'emissive', 'sheenColor', 'specularColor', 'attenuationColor']);

/**
 * The material library.
 * @param {object} ctx the standard context (uses quality, renderer, track)
 */
export function createMaterialLibrary(ctx = {}) {
  const quality = ctx.quality || { tier: 'high', anisotropy: 8, textureSize: 1024, aoQuality: 2 };
  const tier = quality.tier || 'high';
  const maxAniso = ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? 16;
  const anisotropy = Math.max(1, Math.min(quality.anisotropy ?? 8, maxAniso));

  const tex = createTextureLibrary(ctx);
  const customSets = new Map(); // key → { map, dispose } from ./mat/generators.js
  const cache = new Map(); // canonical name → material
  const variants = new Map(); // variant key → material
  const setFor = new Map(); // canonical name → the texture set it was built from
  const built = [];
  const warned = new Set();
  let debugMat = null;
  let env = { texture: undefined, intensity: 1 };
  let lastSet = null;

  /**
   * The one gate for real transmission (see TRANSMISSION_BUDGET above). `ultra` is unrestricted;
   * every other tier allows only the budgeted names, and `low`/`medium` allow none at all because
   * they build MeshStandardMaterial, which has no transmission to give.
   */
  const transmissionAllowed = (name) => atLeast(tier, 'high')
    && (tier === 'ultra' || TRANSMISSION_BUDGET.includes(name));

  // ── the toolkit every recipe receives ────────────────────────────────────────────────────
  const B = {
    THREE,
    ctx,
    quality,
    tier,
    anisotropy,
    /** Sheen and clearcoat are dropped on `low`, where the library builds Standard materials. */
    canSheen: atLeast(tier, 'medium'),
    canClearcoat: atLeast(tier, 'medium'),
    /**
     * May the material currently being built carry real transmission? See TRANSMISSION_BUDGET.
     * Called with no argument inside a recipe (it defaults to the name `build()` is resolving),
     * or with an explicit name from anywhere else.
     */
    transmits: (name = B.building) => transmissionAllowed(name),

    /** The canonical name of the recipe `build()` is running, for `transmits()`. */
    building: null,

    /** Fetch a TEX set: 'name' or ['name', params]. */
    set(spec) {
      const s = Array.isArray(spec) ? tex.get(spec[0], spec[1]) : tex.get(spec);
      lastSet = s;
      return s;
    },

    /** Fetch one of MAT's own generated sets (hair, the laptop UI, the sky). */
    gen(name, params = {}) {
      const entry = CUSTOM[name];
      if (!entry) throw new Error(`[mat] unknown generator "${name}"`);
      const key = `${name}|${stableKey(params)}`;
      let s = customSets.get(key);
      if (!s) {
        const size = params.size || Math.min(entry.cap, pow2((quality.textureSize || 1024) * entry.share));
        s = entry.fn({ ...params, size });
        for (const slot of ['map', 'normalMap', 'orm', 'alphaMap']) {
          if (s[slot]) s[slot].anisotropy = anisotropy;
        }
        customSets.set(key, s);
        ctx.track?.(s);
      }
      lastSet = s;
      return s;
    },
  };

  // ── plumbing ────────────────────────────────────────────────────────────────────────────

  function applyEnv(mat) {
    if (mat.userData.noEnv) return mat;
    if (env.texture !== undefined && 'envMap' in mat) {
      mat.envMap = env.texture;
      mat.needsUpdate = true;
    }
    if ('envMapIntensity' in mat) {
      mat.envMapIntensity = env.intensity * (mat.userData.envBoost ?? 1);
    }
    return mat;
  }

  function register(mat, name) {
    if (!mat.name) mat.name = name;
    mat.userData.mat = name;
    if (mat.userData.envBoost === undefined) mat.userData.envBoost = 1;
    applyEnv(mat);
    built.push(mat);
    ctx.track?.(mat);
    return mat;
  }

  /** The magenta of shame. One instance, shared, impossible to miss in a screenshot. */
  function debugMaterial() {
    if (debugMat) return debugMat;
    debugMat = new THREE.MeshStandardMaterial({
      name: 'debug.missing',
      color: 0xff00c8,
      emissive: 0x4a0038,
      roughness: 0.35,
      metalness: 0,
    });
    debugMat.userData.mat = 'debug.missing';
    debugMat.userData.envBoost = 1;
    built.push(debugMat);
    ctx.track?.(debugMat);
    return debugMat;
  }

  /** Give a cloned material its own texture instances so a retile cannot leak into the original. */
  function retile(mat, repeat, offset) {
    const orm = mat.roughnessMap;
    const seen = new Map();
    const copy = (t) => {
      if (!t) return null;
      if (seen.has(t)) return seen.get(t);
      const c = t.clone();
      c.userData = { matClone: true };
      if (repeat) c.repeat.set(repeat[0], repeat[1]);
      if (offset) c.offset.set(offset[0], offset[1]);
      c.anisotropy = anisotropy;
      seen.set(t, c);
      return c;
    };
    for (const slot of ['map', 'normalMap', 'alphaMap', 'emissiveMap', 'thicknessMap', 'roughnessMap']) {
      if (mat[slot]) mat[slot] = copy(mat[slot]);
    }
    // The packed ORM is one texture bound three times — keep it that way after cloning.
    if (orm) {
      const c = seen.get(orm);
      if (mat.metalnessMap) mat.metalnessMap = c;
      if (mat.aoMap) mat.aoMap = c;
    }
    if (repeat) mat.userData.repeat = [repeat[0], repeat[1]];
    return mat;
  }

  function applyOverrides(mat, opts) {
    for (const [k, v] of Object.entries(opts || {})) {
      if (v === undefined || k === 'uvRepeat' || k === 'uvOffset') continue;
      if (k === 'roughRange' && Array.isArray(v)) {
        mat.userData.roughRange = [v[0], v[1]];
        reinstallPatches(mat);
        continue;
      }
      if (k === 'envBoost') {
        mat.userData.envBoost = v;
        continue;
      }
      // A consumer raising transmission through tinted() would reopen the render-target pass this
      // library exists to keep shut (`lamps.js` does exactly that for the pendant stem). Turning it
      // OFF is always allowed; turning it on obeys the same budget the recipes do.
      if (k === 'transmission' && v > 0 && !transmissionAllowed(mat.userData?.mat)) continue;
      if (k === 'normalScale' && typeof v === 'number') {
        mat.normalScale = new THREE.Vector2(v, v);
        continue;
      }
      if (COLOUR_PROPS.has(k)) {
        if (mat[k] && mat[k].isColor) mat[k].setHex(v);
        continue;
      }
      if (k in mat) mat[k] = v;
    }
    return mat;
  }

  /** Clone `name` once per key, mutate it, cache it. Used by both tinted() and tiled(). */
  function makeVariant(name, key, mutate) {
    const hit = variants.get(key);
    if (hit) return hit;
    const base = api.get(name);
    if (base === debugMat) return debugMat;
    const m = base.clone(); // clone drops onBeforeCompile but JSON-copies userData…
    reinstallPatches(m); // …which is exactly what this reads to put the patches back
    mutate(m);
    register(m, name);
    variants.set(key, m);
    return m;
  }

  function build(name) {
    lastSet = null;
    B.building = name; // so a recipe can just ask `B.transmits()` about itself
    let mat;
    try {
      mat = RECIPES[name](B);
    } finally {
      B.building = null;
    }
    if (lastSet) setFor.set(name, lastSet);
    return register(mat, name);
  }

  // ── the frozen API (CONTRACTS §10) ───────────────────────────────────────────────────────
  const api = {
    /**
     * The canonical accessor. Cached and shared — never dispose what it returns.
     * Never returns undefined: an unknown name warns once and returns magenta.
     */
    get(name) {
      const hit = cache.get(name);
      if (hit) return hit;
      if (!RECIPES[name]) {
        if (!warned.has(name)) {
          warned.add(name);
          console.warn(`[mat] unknown material "${name}" — returning the magenta debug material. `
            + 'CONTRACTS §10 has the closed list of names.');
        }
        return debugMaterial();
      }
      let mat;
      try {
        mat = build(name);
      } catch (err) {
        // A recipe that throws must not take the world build down with it — the room still gets
        // built, and the failure is magenta and obvious in the very next screenshot.
        console.error(`[mat] recipe "${name}" failed —`, err);
        mat = debugMaterial();
      }
      cache.set(name, mat);
      return mat;
    },

    /** True if `name` is one of the canonical materials. */
    has: (name) => Object.prototype.hasOwnProperty.call(RECIPES, name),

    /**
     * A cached clone with a different tint and any property overrides.
     * `opts` also understands `uvRepeat` / `uvOffset` (which clone the maps first — this is how a
     * book gets one column of the spine atlas), `roughRange: [lo, hi]` and `envBoost`.
     */
    tinted(name, hex = 0xffffff, opts = {}) {
      const key = `${name}|${(hex >>> 0).toString(16)}|${stableKey(opts)}`;
      return makeVariant(name, key, (m) => {
        if (opts.uvRepeat || opts.uvOffset) retile(m, opts.uvRepeat, opts.uvOffset);
        if (hex !== null && hex !== undefined && m.color) m.color.setHex(safeColour(hex >>> 0, !!m.map));
        applyOverrides(m, opts);
        m.name = `${name}~${(hex >>> 0).toString(16)}`;
      });
    },

    /**
     * A cached clone tiled for a surface `w` x `h` metres. Use this whenever your mesh is a very
     * different size from the extent the recipe assumed (see ./mat/recipes.*.js).
     */
    tiled(name, w, h = w) {
      const base = api.get(name);
      const tm = base.userData?.tileMetres;
      if (!tm) return base;
      const rep = [Math.max(0.02, w / tm[0]), Math.max(0.02, h / tm[1])];
      const key = `${name}|tile|${rep[0].toFixed(4)}x${rep[1].toFixed(4)}`;
      return makeVariant(name, key, (m) => {
        retile(m, rep, null);
        m.name = `${name}~${w}x${h}m`;
      });
    },

    /** Every material name, sorted. */
    names: () => MATERIAL_NAMES.slice(),

    /** Every material built so far, including variants — LIGHT iterates this. */
    all: () => built.slice(),

    /** The TEX set behind a material, for atlases, thickness maps and height fields. */
    textureSet: (name) => {
      api.get(name);
      return setFor.get(name) || null;
    },

    /** The atlas descriptor of a material whose texture is one (`card.print`), or null. */
    atlas: (name) => api.textureSet(name)?.atlas || null,

    /** The texture library, for anyone who needs a raw set (DRESS: leaf height fields, decals). */
    textures: tex,

    /**
     * Apply the IBL. LIGHT owns both the environment map and its global strength; each material
     * keeps a relative `userData.envBoost` so chrome and foil stay hotter than plaster. Applies to
     * everything built so far and everything built later.
     * @param {THREE.Texture|null} texture pass `null` to use `scene.environment` instead
     * @param {number} intensity global multiplier
     */
    setEnvironment(texture, intensity = 1) {
      env = { texture, intensity };
      for (const m of built) applyEnv(m);
      return api;
    },

    /** The current global environment intensity (LIGHT may read it back). */
    environmentIntensity: () => env.intensity,

    /**
     * Build the heavy materials up front, yielding between each so the loading bar can paint.
     * @param {(progress:number, name:string)=>void} [onProgress]
     */
    async prewarm(onProgress) {
      for (let i = 0; i < PREWARM.length; i++) {
        const name = PREWARM[i];
        try {
          api.get(name);
        } catch (err) {
          console.error(`[mat] prewarm failed for "${name}"`, err);
        }
        onProgress?.((i + 1) / PREWARM.length, name);
        // Two hops: one to let the paint land, one to let the browser breathe.
        await new Promise((r) => setTimeout(r, 0));
      }
      return api;
    },

    /** Profiling hook for the integrator. */
    stats() {
      const t = tex.stats();
      let customBytes = 0;
      for (const s of customSets.values()) {
        const w = s.map?.image?.width || s.size || 256;
        const h = s.map?.image?.height || s.size || 256;
        const maps = 1 + (s.normalMap ? 1 : 0) + (s.orm ? 1 : 0) + (s.alphaMap ? 1 : 0);
        customBytes += w * h * 4 * maps * 1.34; // + the mip chain
      }
      return {
        built: cache.size,
        variants: variants.size,
        textures: t.count + customSets.size,
        estimatedMB: Math.round((t.megabytes + customBytes / 1048576) * 10) / 10,
        generationMs: t.ms,
        tier,
        slowest: t.slowest,
      };
    },

    /** Drop every material, every clone we made, and the whole texture library. */
    dispose() {
      for (const m of built) {
        for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap', 'emissiveMap', 'thicknessMap']) {
          const t = m[slot];
          if (t && t.userData && t.userData.matClone) {
            t.dispose();
            t.userData.matClone = false;
          }
        }
        m.dispose();
      }
      built.length = 0;
      cache.clear();
      variants.clear();
      setFor.clear();
      warned.clear();
      debugMat = null;
      for (const s of customSets.values()) s.dispose?.();
      customSets.clear();
      tex.dispose();
    },
  };

  return api;
}
