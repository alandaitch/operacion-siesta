// FURN · the per-build toolkit handed to every sub-builder.
//
// Three jobs. (1) It owns FURN's own seeded RNG stream — a private `makeRng` rather than the shared
// global one, so the exact tilt of every book-leaning, cushion-denting jitter in this module stays
// identical no matter what DRESS or ROOM draw before us. (2) It fronts the material library with a
// `unit()` accessor that returns a repeat-of-1 clone of a canonical material, which is what pairs
// with geo.js's metre-accurate `projectUV`. (3) It collects collider descriptions as empty proxy
// Object3Ds so a merged 400-triangle mesh can still be backed by six exact boxes.

import * as THREE from 'three';
import { makeRng } from '../../core/rng.js';

/** Read a dotted path out of LAYOUT, falling back to the literal from CONTRACTS §2. */
export function fromLayout(ctx, path, fallback) {
  let node = ctx && ctx.layout;
  if (!node) return fallback;
  for (const key of path.split('.')) {
    if (node == null || typeof node !== 'object' || !(key in node)) return fallback;
    node = node[key];
  }
  if (node == null) return fallback;
  if (Array.isArray(node)) return node.slice();
  if (typeof node === 'object' && 'x' in node) return [node.x, node.y ?? 0, node.z ?? 0];
  return node;
}

export function createKit(ctx, seed = 0xf0217e) {
  const rng = makeRng(seed);
  const quality = ctx.quality || { tier: 'high' };
  const tier = quality.tier || 'high';
  const rank = { low: 0, medium: 1, high: 2, ultra: 3 }[tier] ?? 2;
  const unitCache = new Map();
  const geoms = [];
  const colliders = [];

  const missing = new THREE.MeshStandardMaterial({ color: 0xff00c8, roughness: 0.4 });

  const kit = {
    ctx,
    THREE,
    tier,
    rank,
    /** true from the named tier upward */
    atLeast: (name) => rank >= ({ low: 0, medium: 1, high: 2, ultra: 3 }[name] ?? 2),
    quality,
    rng,
    rand: (min, max) => min + (max - min) * rng(),
    jit: (a) => (rng() * 2 - 1) * a,
    pick: (arr) => arr[Math.floor(rng() * arr.length) % arr.length],
    deg: (d) => (d * Math.PI) / 180,

    /** A canonical material (CONTRACTS §10). */
    mat(name) {
      const m = ctx.materials ? ctx.materials.get(name) : null;
      return m || missing;
    },

    /** A cached clone with overrides — tints, roughness bands, envBoost. */
    tint(name, hex, opts) {
      if (!ctx.materials) return missing;
      return ctx.materials.tinted(name, hex, opts || {});
    },

    /**
     * The repeat-of-1 variant of a canonical material. Pair with geo.js `projectUV` / `scaleUV`,
     * which write UVs already divided by the texture's real tile size.
     */
    unit(name) {
      const hit = unitCache.get(name);
      if (hit) return hit;
      if (!ctx.materials) return missing;
      const base = ctx.materials.get(name);
      const hex = base && base.color ? base.color.getHex() : 0xffffff;
      const m = ctx.materials.tinted(name, hex, { uvRepeat: [1, 1] });
      unitCache.set(name, m);
      return m;
    },

    /** The real-world tile size (metres) of a material's texture set. */
    tm(name) {
      const base = ctx.materials ? ctx.materials.get(name) : null;
      const t = base && base.userData ? base.userData.tileMetres : null;
      if (!t) return [1, 1];
      return [t[0] || 1, t[1] || t[0] || 1];
    },

    /** Track a geometry for teardown and return it. */
    keep(geo) {
      if (geo) {
        geoms.push(geo);
        ctx.track?.(geo);
      }
      return geo;
    },

    /** Mesh + shadow flags + geometry tracking in one call. */
    mesh(geo, material, name, { cast = true, receive = true } = {}) {
      kit.keep(geo);
      const m = new THREE.Mesh(geo, material);
      m.name = name;
      m.castShadow = cast;
      m.receiveShadow = receive;
      return m;
    },

    /**
     * Register a static box collider. `parent` gives the frame; the proxy carries no geometry, so
     * PHYS uses the explicit size and never has to walk a merged mesh.
     */
    box(parent, name, position, size, { rotY = 0, rotX = 0, rotZ = 0, material = null, friction = 0.85, restitution = 0.05 } = {}) {
      const proxy = new THREE.Object3D();
      proxy.name = name;
      proxy.position.set(position[0], position[1], position[2]);
      proxy.rotation.set(rotX, rotY, rotZ);
      parent.add(proxy);
      colliders.push({
        object3d: proxy,
        opts: {
          shape: 'box',
          size: { x: size[0], y: size[1], z: size[2] },
          friction,
          restitution,
          material: material || undefined,
        },
      });
      return proxy;
    },

    /** Anything more exotic (cylinders under a lamp base, the playpen door leaf). */
    collider(object3d, opts) {
      colliders.push({ object3d, opts });
      return object3d;
    },

    colliders,
    geoms,
  };

  ctx.track?.(missing);
  return kit;
}
