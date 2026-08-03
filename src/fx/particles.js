// OPERATION NAPTIME — module FX. Airborne particles, debris, decals and the two screen channels.
// OWNER: FX. See CONTRACTS.md before editing.
//
// WHAT IS HERE, AND WHY IT IS SHAPED LIKE THIS
//
//  1. AMBIENT DUST (./motes.js). One THREE.Points draw carrying every mote in the flat, animated
//     entirely in the vertex shader from a closed-form function of time, brightened by the *same*
//     beam volume LIGHT rasterises for its god rays (./beam.js) so the motes hang inside the real
//     shafts and go dark in the mullion shadows. This one effect does more for "AAA interior" than
//     everything else in the module combined, and it costs no CPU at all.
//  2. BILLBOARDS (./billboards.js). A pooled, zero-allocation instanced quad system for puffs,
//     powder, wisps and glints. One draw call, one material, per-instance additive share, and an
//     analytic soft-particle fade (./softness.js) so nothing is sliced in half by the rug.
//  3. DEBRIS (./debris.js). Chips, soil and paper scraps as real InstancedMeshes wearing real
//     library materials, on a scalar ballistic integrator. PHYS simulates the twelve big Voronoi
//     shards; these are the two hundred bits it cannot afford to.
//  4. DECALS (./decals.js). Multiply-blended projected quads that PERSIST FOR THE ROUND. Soil in
//     the rug, a coffee ring, drool, crumbs, ceramic powder. The room accumulating the evidence is
//     the emotional payoff of the whole game, so this is the pool that never fades out.
//  5. SCREEN (./screen.js). A warm bloom on a good mouthful, a green cast on a bad one, a small
//     burst on a combo. Sparing, and composited before the tone map so it reads as light.
//
// EVERYTHING IS BUDGETED. ctx.quality.particleBudget is split across the four pools and then again
// across the emitters inside the billboard pool, so a shatter plume can never starve the ambient
// dust. Nothing here allocates per frame: pools are struct-of-arrays, spawn options are read out
// of one reused scratch object, and every vector in the hot path is module scope.
//
// PHOTO MODE. `?shot=` freezes the simulation but *not* the dust: the mote field is evaluated at a
// pinned phase, so a screenshot always has air in it and always the same air.

import * as THREE from 'three';
import { createSpriteAtlas, CELL } from './sprites.js';
import { createBeamUniforms, applyShaftPayload, setBeamLight, aimBeam } from './beam.js';
import { makeSoftnessUniforms } from './softness.js';
import { createMoteField } from './motes.js';
import { createBillboards, OWNER } from './billboards.js';
import { createDebris } from './debris.js';
import { createDecals } from './decals.js';
import { createScreenFX } from './screen.js';
import { makeRng } from '../core/rng.js';

// ── colour ───────────────────────────────────────────────────────────────────────────────────
// Everything downstream of us is scene-referred linear until the composer's ACES pass, so every
// colour in this file is authored as the hex you would read off a swatch and converted once.

const s2l = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function lin(hex, gain = 1) {
  return [
    s2l(((hex >> 16) & 255) / 255) * gain,
    s2l(((hex >> 8) & 255) / 255) * gain,
    s2l((hex & 255) / 255) * gain,
  ];
}

// ── the material response table ──────────────────────────────────────────────────────────────
// Keyed by the `materialGuess` categories PHYS reports in src/physics/contacts.js. Each entry says
// what a hit on that surface throws into the air, what solid bits it sheds, and what it leaves
// behind. This table is the difference between "a generic poof" and "that is a ceramic vase".

const RESPONSE = {
  rug: {
    cloud: { cell: CELL.PUFF, colour: lin(0xdcd4c2, 0.85), n: 3, size: 0.10, grow: 2.6, life: 1.7, alpha: 0.34, lift: 0.13, drag: 3.1, spread: 0.42, swirl: 0.30 },
    decal: null, minDecal: 2,
  },
  fabric: {
    cloud: { cell: CELL.PUFF, colour: lin(0xd6d0c4, 0.80), n: 2, size: 0.085, grow: 2.4, life: 1.5, alpha: 0.26, lift: 0.12, drag: 3.3, spread: 0.36, swirl: 0.26 },
    decal: null, minDecal: 2,
  },
  plush: {
    cloud: { cell: CELL.PUFF, colour: lin(0xdad4c8, 0.78), n: 2, size: 0.075, grow: 2.2, life: 1.3, alpha: 0.20, lift: 0.11, drag: 3.4, spread: 0.30, swirl: 0.22 },
    decal: null, minDecal: 2,
  },
  paper: {
    cloud: { cell: CELL.POWDER, colour: lin(0xf2eee2, 0.85), n: 2, size: 0.06, grow: 2.1, life: 1.0, alpha: 0.22, lift: 0.10, drag: 3.6, spread: 0.30, swirl: 0.30 },
    solid: { pool: 'scrap', n: 3, size: 0.026, colour: lin(0xf4f0e6), flutter: true, life: 5.5, spread: 0.9 },
    decal: null, minDecal: 2,
  },
  canvas: {
    cloud: { cell: CELL.POWDER, colour: lin(0xece6d8, 0.8), n: 2, size: 0.06, grow: 2.0, life: 0.9, alpha: 0.20, lift: 0.09, drag: 3.6, spread: 0.28, swirl: 0.24 },
    decal: null, minDecal: 2,
  },
  ceramic: {
    cloud: { cell: CELL.POWDER, colour: lin(0xf6f2ea, 1.05), n: 4, size: 0.075, grow: 3.1, life: 1.5, alpha: 0.42, lift: 0.16, drag: 3.0, spread: 0.62, swirl: 0.36 },
    solid: { pool: 'chip', n: 4, size: 0.011, colour: lin(0xf2eee4), life: 6.0, spread: 1.5 },
    decal: 'powder', minDecal: 0.45,
  },
  stone: {
    cloud: { cell: CELL.GRIT, colour: lin(0xd8d2c6, 0.9), n: 3, size: 0.07, grow: 2.8, life: 1.3, alpha: 0.36, lift: 0.13, drag: 3.2, spread: 0.55, swirl: 0.30 },
    solid: { pool: 'chip', n: 3, size: 0.010, colour: lin(0xd4cec2), life: 6.0, spread: 1.3 },
    decal: 'chalk', minDecal: 0.55,
  },
  glass: {
    cloud: { cell: CELL.POWDER, colour: lin(0xdfe9ec, 0.95), n: 3, size: 0.06, grow: 2.6, life: 1.0, alpha: 0.24, lift: 0.14, drag: 3.4, spread: 0.75, swirl: 0.34 },
    solid: { pool: 'chip', n: 4, size: 0.009, colour: lin(0xdae6ea), life: 6.5, spread: 1.9 },
    glint: { n: 5, colour: lin(0xffffff, 1.5), size: 0.045, life: 0.34, spread: 2.2 },
    decal: null, minDecal: 2,
  },
  metal: {
    cloud: { cell: CELL.POWDER, colour: lin(0xc9c9cc, 0.7), n: 1, size: 0.05, grow: 2.0, life: 0.7, alpha: 0.16, lift: 0.10, drag: 4.0, spread: 0.35, swirl: 0.24 },
    glint: { n: 3, colour: lin(0xfff2dc, 1.3), size: 0.038, life: 0.26, spread: 1.6 },
    decal: null, minDecal: 2,
  },
  wood: {
    cloud: { cell: CELL.GRIT, colour: lin(0xbb9c76, 0.8), n: 2, size: 0.065, grow: 2.4, life: 1.1, alpha: 0.30, lift: 0.11, drag: 3.3, spread: 0.45, swirl: 0.28 },
    solid: { pool: 'chip', n: 2, size: 0.009, colour: lin(0xa88a64), life: 5.5, spread: 1.1 },
    decal: null, minDecal: 2,
  },
  wicker: {
    cloud: { cell: CELL.GRIT, colour: lin(0xc7a97e, 0.78), n: 2, size: 0.055, grow: 2.2, life: 1.0, alpha: 0.24, lift: 0.10, drag: 3.4, spread: 0.40, swirl: 0.26 },
    decal: null, minDecal: 2,
  },
  concrete: {
    cloud: { cell: CELL.GRIT, colour: lin(0xcfcac0, 0.9), n: 3, size: 0.08, grow: 2.9, life: 1.4, alpha: 0.34, lift: 0.12, drag: 3.1, spread: 0.50, swirl: 0.30 },
    decal: 'dust', minDecal: 0.62,
  },
  plaster: {
    cloud: { cell: CELL.POWDER, colour: lin(0xefebe2, 1.0), n: 3, size: 0.075, grow: 2.9, life: 1.4, alpha: 0.36, lift: 0.15, drag: 3.1, spread: 0.48, swirl: 0.32 },
    decal: 'chalk', minDecal: 0.6,
  },
  plastic: {
    cloud: { cell: CELL.POWDER, colour: lin(0xdcdcde, 0.6), n: 1, size: 0.05, grow: 2.0, life: 0.7, alpha: 0.14, lift: 0.10, drag: 3.8, spread: 0.32, swirl: 0.24 },
    decal: null, minDecal: 2,
  },
  rubber: {
    cloud: { cell: CELL.PUFF, colour: lin(0xd0c4c8, 0.6), n: 1, size: 0.05, grow: 2.0, life: 0.7, alpha: 0.13, lift: 0.09, drag: 3.9, spread: 0.28, swirl: 0.22 },
    decal: null, minDecal: 2,
  },
  foil: {
    cloud: { cell: CELL.POWDER, colour: lin(0xf0c680, 0.7), n: 1, size: 0.045, grow: 1.9, life: 0.6, alpha: 0.14, lift: 0.14, drag: 3.6, spread: 0.4, swirl: 0.34 },
    glint: { n: 6, colour: lin(0xffd489, 1.7), size: 0.042, life: 0.40, spread: 1.9 },
    solid: { pool: 'scrap', n: 2, size: 0.016, colour: lin(0xe8a441), flutter: true, life: 4.5, spread: 1.1 },
    decal: null, minDecal: 2,
  },
  vinyl: {
    cloud: { cell: CELL.POWDER, colour: lin(0x8f8f92, 0.5), n: 2, size: 0.055, grow: 2.1, life: 0.9, alpha: 0.18, lift: 0.10, drag: 3.6, spread: 0.42, swirl: 0.26 },
    solid: { pool: 'chip', n: 2, size: 0.008, colour: lin(0x2b2b2e), life: 5.0, spread: 1.2 },
    decal: null, minDecal: 2,
  },
  leaf: {
    cloud: { cell: CELL.GRIT, colour: lin(0x86a05c, 0.7), n: 2, size: 0.06, grow: 2.2, life: 1.1, alpha: 0.22, lift: 0.12, drag: 3.4, spread: 0.45, swirl: 0.34 },
    solid: { pool: 'scrap', n: 2, size: 0.030, colour: lin(0x6f8a4a), flutter: true, life: 6.0, spread: 0.9 },
    decal: null, minDecal: 2,
  },
  soil: {
    cloud: { cell: CELL.GRIT, colour: lin(0x7d6349, 0.75), n: 4, size: 0.08, grow: 2.7, life: 1.5, alpha: 0.40, lift: 0.09, drag: 3.0, spread: 0.55, swirl: 0.28 },
    solid: { pool: 'pebble', n: 6, size: 0.010, colour: lin(0x6b5340), life: 7.0, spread: 1.4 },
    decal: 'soil', minDecal: 0.25,
  },
  flesh: {
    cloud: { cell: CELL.PUFF, colour: lin(0xd8cfc6, 0.5), n: 1, size: 0.055, grow: 1.9, life: 0.8, alpha: 0.11, lift: 0.10, drag: 3.8, spread: 0.24, swirl: 0.20 },
    decal: null, minDecal: 2,
  },
  generic: {
    cloud: { cell: CELL.PUFF, colour: lin(0xd6d0c6, 0.75), n: 2, size: 0.07, grow: 2.3, life: 1.1, alpha: 0.24, lift: 0.12, drag: 3.3, spread: 0.40, swirl: 0.28 },
    decal: null, minDecal: 2,
  },
};
/**
 * What a settling piece of debris grinds into the surface. Carried through the debris pool as a
 * one-byte tag, because a chip lands two seconds after the thing that threw it stopped caring.
 */
const REST = [
  null,
  { kind: 'soil', chance: 0.55, size: 0.055 },
  { kind: 'crumbs', chance: 0.42, size: 0.045 },
  { kind: 'powder', chance: 0.30, size: 0.060 },
  { kind: 'chalk', chance: 0.28, size: 0.055 },
  { kind: 'dust', chance: 0.24, size: 0.055 },
];
const REST_TAG = { soil: 1, crumbs: 2, powder: 3, chalk: 4, dust: 5 };

/** A single crumb out of the corner of a mouth. Hoisted so the chew handler allocates nothing. */
const CRUMB_SPEC = { pool: 'pebble', n: 1, size: 0.005, colour: lin(0xc8a878), life: 6, spread: 0.35, tag: REST_TAG.crumbs };

RESPONSE.card = RESPONSE.paper;
RESPONSE.marble = RESPONSE.stone;
RESPONSE.brick = RESPONSE.stone;
RESPONSE.none = RESPONSE.generic;

/** Reaction → screen channel. `dangerous` is not funny, so it gets the coldest cast. */
const REACTION = {
  yum: { glow: 0xffc27a, strength: 0.30, decay: 0.55 },
  spicy: { cast: 0xff7a4a, strength: 0.34, decay: 1.5, glow: 0xff9a5a, glowStrength: 0.20 },
  gross: { cast: 0x6fa84a, strength: 0.42, decay: 2.1 },
  dangerous: { cast: 0x4a86a8, strength: 0.48, decay: 2.4 },
};

// ── scratch ──────────────────────────────────────────────────────────────────────────────────
const SP = {};                     // the one spawn-options object; reused for every particle
const CFG = {};                    // the one cloud-config object, likewise
const _pos = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _bit = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _rayO = new THREE.Vector3();
const _down = { x: 0, y: -1, z: 0 };
const _colour = new THREE.Color();
const _travel = new THREE.Vector3();
const _buffer = new THREE.Vector2();
const GROUND = { y: 0, nx: 0, ny: 1, nz: 0, found: false, material: 'rug' };
const PHOTO_PHASE = 8.35;          // the frozen time the mote field is evaluated at for screenshots

function readVec(v, out, dx = 0, dy = 0, dz = 0) {
  if (!v) { out.set(dx, dy, dz); return out; }
  if (v.isVector3) return out.copy(v);
  return out.set(
    Number.isFinite(v.x) ? v.x : dx,
    Number.isFinite(v.y) ? v.y : dy,
    Number.isFinite(v.z) ? v.z : dz,
  );
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Copy a cloud spec into the shared scratch, with overrides. Keeps the emitters allocation-free. */
function cloudCfg(base, o) {
  CFG.cell = o && o.cell !== undefined ? o.cell : base.cell;
  CFG.colour = o && o.colour !== undefined ? o.colour : base.colour;
  CFG.n = o && o.n !== undefined ? o.n : base.n;
  CFG.size = o && o.size !== undefined ? o.size : base.size;
  CFG.grow = o && o.grow !== undefined ? o.grow : base.grow;
  CFG.life = o && o.life !== undefined ? o.life : base.life;
  CFG.alpha = o && o.alpha !== undefined ? o.alpha : base.alpha;
  CFG.lift = o && o.lift !== undefined ? o.lift : base.lift;
  CFG.drag = o && o.drag !== undefined ? o.drag : base.drag;
  CFG.spread = o && o.spread !== undefined ? o.spread : base.spread;
  CFG.swirl = o && o.swirl !== undefined ? o.swirl : base.swirl;
  return CFG;
}

export function createFX(ctx) {
  const quality = ctx.quality || {};
  const tier = quality.tier || 'high';
  const events = ctx.events;
  const layout = ctx.layout;

  // FX owns its own random stream. Sharing ctx.rng() with the world build would make the room
  // depend on how many particles happened to spawn, which is exactly what we are trying to avoid.
  const rnd = makeRng(0xf0cacc1a);
  const rr = (a, b) => a + (b - a) * rnd();
  const jit = (a) => (rnd() * 2 - 1) * a;

  // ── budgets ────────────────────────────────────────────────────────────────────────────────
  const BUDGET = Math.max(60, quality.particleBudget || 2000);
  const moteCount = Math.round(BUDGET * 0.55);
  const spriteCap = Math.round(BUDGET * 0.30);
  const debrisCap = Math.round(BUDGET * 0.12);
  const decalCap = Math.min(128, Math.max(12, Math.round(BUDGET * 0.06)));
  const atlasSize = tier === 'low' ? 128 : tier === 'medium' ? 256 : 512;

  // ── the scene graph ────────────────────────────────────────────────────────────────────────
  const group = new THREE.Group();
  group.name = 'fx';
  // Everything in this module is authored in world space; keep the group at the origin.
  group.matrixAutoUpdate = false;
  ctx.scene.add(group);

  const atlas = createSpriteAtlas(atlasSize);
  ctx.track?.(atlas);

  const beam = createBeamUniforms(layout);
  const softness = makeSoftnessUniforms(layout);

  const motes = createMoteField({ count: moteCount, layout, beam });
  const bill = createBillboards({ capacity: spriteCap, atlas, softness });
  const decals = createDecals({ capacity: decalCap, atlas, rand: rnd });
  const screen = createScreenFX();

  // Debris needs the material library; if MAT somehow failed we simply do without solids rather
  // than taking the boot down.
  let debris = null;
  try {
    if (ctx.materials?.get) {
      debris = createDebris({
        materials: ctx.materials,
        capacity: debrisCap,
        onRest: (x, y, z, kind) => onDebrisRest(x, y, z, kind),
      });
    }
  } catch (err) {
    console.warn('[fx] debris pools unavailable —', err);
    debris = null;
  }

  group.add(motes.object3d);
  group.add(bill.object3d);
  group.add(decals.object3d);
  if (debris) group.add(debris.group);
  group.add(screen.object3d);

  // ── state ──────────────────────────────────────────────────────────────────────────────────
  let clock = 0;
  let budgetScale = 1;
  let enabled = true;
  let shaftPayload = null;
  let lightClock = 999;
  let tokens = 6;               // impact rate limiter
  let suppressImpact = 0;       // guards the nested fx:impact PHYS emits while shattering
  const lastBaby = new THREE.Vector3(NaN, NaN, NaN);
  let crawlDistance = 0;
  let sawCrawlEvents = false;
  let crawlSurface = null;
  let crawlSpeed = 0;
  const counters = { sprites: 0, debris: 0, decals: 0, spawns: 0, dropped: 0 };

  const rugRect = layout?.rug || { x: 0.9, z: -1.8, w: 4.6, d: 4.0, y: 0.008 };
  const rugPile = (rugRect.pile || 0.012) + (rugRect.y || 0.008);

  function insideRug(x, z) {
    return Math.abs(x - rugRect.x) < rugRect.w * 0.5 && Math.abs(z - rugRect.z) < rugRect.d * 0.5;
  }

  /**
   * What is underneath (x, y, z), and which way is it facing. One raycast per *effect*, never per
   * particle. Falls back to the rug/floor planes if PHYS is not up yet.
   */
  function probeGround(x, y, z) {
    GROUND.found = false;
    GROUND.material = 'rug';
    const phys = ctx.physics;
    if (phys && typeof phys.raycast === 'function') {
      _rayO.set(x, y + 0.08, z);
      let hit = null;
      try {
        hit = phys.raycast(_rayO, _down, 1.8);
      } catch {
        hit = null;
      }
      if (hit && hit.point) {
        GROUND.y = hit.point.y;
        GROUND.nx = hit.normal.x;
        GROUND.ny = hit.normal.y;
        GROUND.nz = hit.normal.z;
        GROUND.material = hit.material || 'rug';
        GROUND.found = true;
        return GROUND;
      }
    }
    GROUND.y = insideRug(x, z) ? rugPile : 0;
    GROUND.nx = 0; GROUND.ny = 1; GROUND.nz = 0;
    return GROUND;
  }

  /** An orthonormal pair spanning the plane perpendicular to `n` (already normalised). */
  function tangents(n) {
    _tmp.set(0, 1, 0);
    if (Math.abs(n.y) > 0.94) _tmp.set(1, 0, 0);
    _tan.crossVectors(_tmp, n);
    if (_tan.lengthSq() < 1e-8) _tan.set(1, 0, 0);
    _tan.normalize();
    _bit.crossVectors(n, _tan).normalize();
  }

  // ── emitters ───────────────────────────────────────────────────────────────────────────────

  /** A cloud of soft billboards blown off a surface along its normal. */
  function emitCloud(cfg, owner, x, y, z, n, strength, scale = 1) {
    if (!cfg) return;
    const count = Math.max(1, Math.round(cfg.n * (0.55 + 0.75 * strength) * budgetScale));
    tangents(n);
    const cr = cfg.colour[0];
    const cg = cfg.colour[1];
    const cb = cfg.colour[2];
    for (let i = 0; i < count; i++) {
      const speed = cfg.spread * (0.35 + strength * 1.15) * rr(0.5, 1.35);
      const ta = rnd() * Math.PI * 2;
      const tr = rr(0.25, 1.0);
      const ox = (_tan.x * Math.cos(ta) + _bit.x * Math.sin(ta)) * tr;
      const oy = (_tan.y * Math.cos(ta) + _bit.y * Math.sin(ta)) * tr;
      const oz = (_tan.z * Math.cos(ta) + _bit.z * Math.sin(ta)) * tr;
      const push = 0.30 + 0.55 * rnd();
      SP.x = x + ox * 0.045 + n.x * 0.02;
      SP.y = y + oy * 0.045 + n.y * 0.02 + 0.012;
      SP.z = z + oz * 0.045 + n.z * 0.02;
      SP.vx = (ox + n.x * push) * speed;
      SP.vy = (oy + n.y * push) * speed + 0.06;
      SP.vz = (oz + n.z * push) * speed;
      SP.size = cfg.size * scale * rr(0.7, 1.45);
      SP.grow = cfg.grow * rr(0.85, 1.2);
      SP.life = cfg.life * rr(0.75, 1.3);
      SP.alpha = cfg.alpha * (0.55 + 0.65 * strength);
      SP.cell = cfg.cell;
      SP.r = cr; SP.g = cg; SP.b = cb;
      SP.additive = 0;
      SP.drag = cfg.drag;
      SP.lift = cfg.lift;
      SP.swirl = cfg.swirl;
      SP.rot = rnd() * Math.PI * 2;
      SP.spin = jit(0.9);
      SP.owner = owner;
      if (bill.spawn(SP)) counters.spawns++; else counters.dropped++;
    }
  }

  /** Specular sparks: additive, short, and no bigger than a highlight. */
  function emitGlints(cfg, owner, x, y, z, n, strength) {
    if (!cfg) return;
    const count = Math.max(1, Math.round(cfg.n * (0.4 + strength) * budgetScale));
    const cr = cfg.colour[0];
    const cg = cfg.colour[1];
    const cb = cfg.colour[2];
    for (let i = 0; i < count; i++) {
      const ax = rnd() * Math.PI * 2;
      const ay = Math.acos(rr(-0.15, 1));
      const dx = Math.sin(ay) * Math.cos(ax);
      const dy = Math.cos(ay);
      const dz = Math.sin(ay) * Math.sin(ax);
      const speed = cfg.spread * rr(0.4, 1.3) * (0.5 + strength);
      SP.x = x + n.x * 0.012; SP.y = y + n.y * 0.012 + 0.008; SP.z = z + n.z * 0.012;
      SP.vx = dx * speed; SP.vy = dy * speed * 0.8 + 0.15; SP.vz = dz * speed;
      SP.size = cfg.size * rr(0.55, 1.4);
      SP.grow = 0.55;
      SP.life = cfg.life * rr(0.7, 1.3);
      SP.alpha = 0.9 * (0.4 + 0.7 * strength);
      SP.cell = CELL.GLINT;
      SP.r = cr; SP.g = cg; SP.b = cb;
      SP.additive = 1;
      SP.drag = 2.0;
      SP.lift = -0.6;
      SP.swirl = 0;
      SP.rot = rnd() * Math.PI * 2;
      SP.spin = jit(4.0);
      SP.owner = owner;
      if (bill.spawn(SP)) counters.spawns++; else counters.dropped++;
    }
  }

  /** Solid bits, thrown off a surface and left to fall. */
  function emitSolids(cfg, x, y, z, n, strength, restY, multiplier = 1, tag = 0) {
    if (!debris || !cfg) return;
    const pool = debris[cfg.pool] || debris.chip;
    const count = Math.max(1, Math.round(cfg.n * multiplier * (0.5 + strength) * budgetScale));
    const cr = cfg.colour[0];
    const cg = cfg.colour[1];
    const cb = cfg.colour[2];
    for (let i = 0; i < count; i++) {
      const ax = rnd() * Math.PI * 2;
      const ay = Math.acos(rr(-0.1, 1));
      const dx = Math.sin(ay) * Math.cos(ax);
      const dy = Math.cos(ay);
      const dz = Math.sin(ay) * Math.sin(ax);
      const speed = cfg.spread * rr(0.35, 1.25) * (0.45 + strength);
      const s = cfg.size * rr(0.6, 1.55);
      SP.x = x + n.x * 0.014 + jit(0.02);
      SP.y = y + n.y * 0.014 + 0.012;
      SP.z = z + n.z * 0.014 + jit(0.02);
      SP.vx = (dx + n.x * 0.5) * speed;
      SP.vy = (dy + n.y * 0.5) * speed + rr(0.4, 1.5);
      SP.vz = (dz + n.z * 0.5) * speed;
      SP.sx = s * rr(0.7, 1.4);
      SP.sy = cfg.flutter ? s * 0.12 : s * rr(0.55, 1.1);
      SP.sz = s * rr(0.7, 1.4);
      SP.qx = rnd() - 0.5; SP.qy = rnd() - 0.5; SP.qz = rnd() - 0.5; SP.qw = rnd() - 0.5;
      const ql = Math.hypot(SP.qx, SP.qy, SP.qz, SP.qw) || 1;
      SP.qx /= ql; SP.qy /= ql; SP.qz /= ql; SP.qw /= ql;
      SP.wx = jit(14); SP.wy = jit(14); SP.wz = jit(14);
      SP.life = cfg.life * rr(0.75, 1.25);
      SP.rest = restY;
      SP.bounce = cfg.flutter ? 0 : rr(0.12, 0.34);
      SP.r = cr * rr(0.82, 1.14);
      SP.g = cg * rr(0.82, 1.14);
      SP.b = cb * rr(0.82, 1.14);
      SP.flutter = !!cfg.flutter;
      SP.phase = rnd() * 6.283;
      SP.tag = tag || cfg.tag || 0;
      pool.spawn(SP);
      counters.spawns++;
    }
  }

  /** A debris piece has stopped moving. Grind it into the surface. */
  function onDebrisRest(x, y, z, tag) {
    const spec = REST[tag] || null;
    if (!spec || rnd() > spec.chance) return;
    decals.stamp({
      x, y: y + 0.002, z, nx: 0, ny: 1, nz: 0,
      kind: spec.kind,
      size: spec.size * rr(0.65, 1.4),
    });
  }

  // ── the public verbs ───────────────────────────────────────────────────────────────────────

  /**
   * The universal hit. `opts`: { position, normal?, material?, force?, strength?, damped?,
   * solids?, decal? }. `force` is the loose scale other modules already emit on `fx:impact`
   * (roughly 0..1.5); `strength` is the normalised 0..1 form PHYS reports as `impact`.
   */
  function impact(opts) {
    if (!enabled || !opts || isPhoto()) return;
    const strength = clamp(
      opts.strength !== undefined ? opts.strength : (opts.force !== undefined ? opts.force * 0.62 : 0.4),
      0.03, 1,
    );
    if (strength < 0.045) return;

    readVec(opts.position, _pos, 0, 0.2, 0);
    readVec(opts.normal, _nrm, 0, 1, 0);
    if (_nrm.lengthSq() < 1e-8) _nrm.set(0, 1, 0);
    _nrm.normalize();
    // A contact normal from Rapier points either way; particles always fly away from the surface,
    // and on a floor hit that means up.
    if (_nrm.y < -0.35) _nrm.negate();

    const key = opts.material || 'generic';
    const res = RESPONSE[key] || RESPONSE.generic;
    const damped = !!opts.damped;

    emitCloud(res.cloud, OWNER.IMPACT, _pos.x, _pos.y, _pos.z, _nrm, strength * (damped ? 1.15 : 1));
    if (!damped && res.glint) emitGlints(res.glint, OWNER.IMPACT, _pos.x, _pos.y, _pos.z, _nrm, strength);

    if (res.solid && strength > 0.30 && opts.solids !== false) {
      const g = probeGround(_pos.x, _pos.y, _pos.z);
      emitSolids(res.solid, _pos.x, _pos.y, _pos.z, _nrm, strength, g.y, 1, REST_TAG[res.decal] || 0);
    }

    // Only a real hit leaves a mark, and only on something roughly horizontal.
    const wants = opts.decal !== undefined ? opts.decal : res.decal;
    if (wants && strength >= (res.minDecal || 0.6) && _nrm.y > 0.55) {
      const g = probeGround(_pos.x, _pos.y, _pos.z);
      decals.stamp({
        x: _pos.x + jit(0.02), y: g.y, z: _pos.z + jit(0.02),
        nx: g.nx, ny: g.ny, nz: g.nz,
        kind: wants,
        coverage: undefined,
      });
    }
  }

  /**
   * The plume PHYS does not simulate. `opts`: { prop?, object3d?, position, material?, impulse?,
   * pieces? }. If the prop still has an intact body we ask PHYS to fracture it first — nothing
   * else in the build currently does, and a `fragile` prop that only puffs is a bug you can see.
   */
  function shatter(opts) {
    if (!enabled || !opts || isPhoto()) return null;
    const prop = opts.prop || null;
    const object3d = opts.object3d || prop?.object3d || null;
    readVec(opts.position, _pos, 0, 0.4, 0);
    if (object3d && !opts.position) object3d.getWorldPosition(_pos);

    const material = opts.material
      || (ctx.physics?.materialOf ? ctx.physics.materialOf(object3d) : null)
      || 'ceramic';
    const res = RESPONSE[material] || RESPONSE.ceramic;

    // 1. the real fracture, once
    let shards = null;
    if (object3d && ctx.physics?.shatter && !object3d.userData.shattered) {
      suppressImpact++;
      try {
        shards = ctx.physics.shatter(object3d, {
          at: { x: _pos.x, y: _pos.y, z: _pos.z },
          impulse: opts.impulse || null,
          pieces: opts.pieces,
          mass: prop?.mass,
        });
      } catch (err) {
        console.warn('[fx] fracture failed for', object3d.name || object3d, err);
      }
      suppressImpact--;
    }

    // 2. the plume — a fast bright core that dies in a third of a second, and a slow cloud that
    //    hangs for two. One alone reads as a firework; together they read as a thing breaking.
    _nrm.set(0, 1, 0);
    const cloud = res.cloud || RESPONSE.ceramic.cloud;
    emitCloud(cloud, OWNER.SHATTER, _pos.x, _pos.y, _pos.z, _nrm, 1.0, 1.15);
    emitCloud(cloud, OWNER.SHATTER, _pos.x, _pos.y, _pos.z, _nrm, 0.75, 2.15);
    for (let i = 0; i < Math.round(5 * budgetScale); i++) {
      const ax = rnd() * Math.PI * 2;
      const rad = rr(0.02, 0.16);
      SP.x = _pos.x + Math.cos(ax) * rad;
      SP.y = _pos.y + rr(-0.05, 0.10);
      SP.z = _pos.z + Math.sin(ax) * rad;
      SP.vx = Math.cos(ax) * rr(0.5, 1.6);
      SP.vy = rr(0.2, 0.9);
      SP.vz = Math.sin(ax) * rr(0.5, 1.6);
      SP.size = cloud.size * rr(0.9, 1.8);
      SP.grow = 3.6;
      SP.life = rr(0.9, 1.9);
      SP.alpha = cloud.alpha * 0.85;
      SP.cell = CELL.WISP;
      SP.r = cloud.colour[0]; SP.g = cloud.colour[1]; SP.b = cloud.colour[2];
      SP.additive = 0;
      SP.drag = 2.6; SP.lift = 0.22; SP.swirl = 0.5;
      SP.rot = ax; SP.spin = jit(1.4);
      SP.owner = OWNER.SHATTER;
      bill.spawn(SP);
    }
    if (res.glint) emitGlints(res.glint, OWNER.SHATTER, _pos.x, _pos.y, _pos.z, _nrm, 1.0);

    // 3. the chips PHYS is not going to bother with, and the dust ring they leave
    const g = probeGround(_pos.x, _pos.y, _pos.z);
    if (res.solid) {
      emitSolids(res.solid, _pos.x, _pos.y, _pos.z, _nrm, 1.0, g.y, 2.2, REST_TAG[res.decal] || 0);
    }
    if (res.decal) {
      const rings = 3;
      for (let i = 0; i < rings; i++) {
        const ax = rnd() * Math.PI * 2;
        const rad = rr(0.03, 0.26);
        decals.stamp({
          x: _pos.x + Math.cos(ax) * rad,
          y: g.y,
          z: _pos.z + Math.sin(ax) * rad,
          nx: g.nx, ny: g.ny, nz: g.nz,
          kind: res.decal,
          size: rr(0.10, 0.26),
        });
      }
    }
    events?.emit('camera:shake', { amount: 0.34, duration: 0.28 });
    return shards;
  }

  /**
   * A liquid or granular spill: a stain that lands, a few droplets that bounce, a low haze.
   * `opts`: { position, normal?, kind?, radius?, splashes? }
   */
  function spill(opts) {
    if (!enabled || !opts || isPhoto()) return;
    readVec(opts.position, _pos, 0, 0.05, 0);
    const kind = opts.kind || 'splash';
    const g = probeGround(_pos.x, _pos.y, _pos.z);
    const radius = opts.radius !== undefined ? opts.radius : 0.16;

    decals.stamp({
      x: _pos.x, y: g.y, z: _pos.z, nx: g.nx, ny: g.ny, nz: g.nz,
      kind, size: radius * 2,
    });
    const satellites = Math.round((opts.splashes !== undefined ? opts.splashes : 4) * budgetScale);
    for (let i = 0; i < satellites; i++) {
      const ax = rnd() * Math.PI * 2;
      const rad = radius * rr(0.7, 2.1);
      decals.stamp({
        x: _pos.x + Math.cos(ax) * rad,
        y: g.y,
        z: _pos.z + Math.sin(ax) * rad,
        nx: g.nx, ny: g.ny, nz: g.nz,
        kind,
        size: radius * rr(0.18, 0.5),
        coverage: 0.55,
      });
    }

    _nrm.set(g.nx, g.ny, g.nz).normalize();
    const tintHex = kind === 'drool' ? 0xd8dde0 : kind === 'soil' ? 0x7d6349 : 0x6b4a30;
    emitCloud(cloudCfg(RESPONSE.generic.cloud, {
      cell: CELL.PUFF, colour: lin(tintHex, 0.75), n: 3, size: radius * 0.7, grow: 2.1,
      life: 0.9, alpha: 0.22, lift: 0.06, drag: 3.6, spread: 0.5, swirl: 0.2,
    }), OWNER.SPILL, _pos.x, g.y + 0.02, _pos.z, _nrm, 0.7);
  }

  /**
   * A free-standing puff of dust — kicked up by a knee, a dropped cushion, a curtain being yanked.
   * `opts`: { position, normal?, colour?, count?, size?, strength?, cell? }
   */
  function dust(opts) {
    // LIGHT falls back to calling `dust()` with a shaft description if `setLightShafts` is missing;
    // be tolerant of receiving one anyway.
    if (opts && (opts.aperture || opts.direction) && !opts.position) { setLightShafts(opts); return; }
    if (!enabled || !opts || isPhoto()) return;
    readVec(opts.position, _pos, 0, 0.05, 0);
    readVec(opts.normal, _nrm, 0, 1, 0);
    if (_nrm.lengthSq() < 1e-8) _nrm.set(0, 1, 0);
    _nrm.normalize();
    const base = RESPONSE[opts.material || 'rug'] || RESPONSE.rug;
    const cfg = cloudCfg(base.cloud, {
      cell: opts.cell,
      colour: opts.colour !== undefined ? lin(opts.colour, opts.gain || 0.85) : undefined,
      n: opts.count,
      size: opts.size,
    });
    emitCloud(cfg, opts.owner !== undefined ? opts.owner : OWNER.DUST,
      _pos.x, _pos.y, _pos.z, _nrm, clamp(opts.strength !== undefined ? opts.strength : 0.5, 0.05, 1));
  }

  /**
   * Stamp a mark. `opts`: { position, normal?, kind?, size?, coverage?, tint? }
   * Decals persist for the round; this is how the room fills up with what you did to it.
   */
  function decal(opts) {
    if (!enabled || !opts) return false;
    readVec(opts.position, _pos, 0, 0, 0);
    let nx = 0; let ny = 1; let nz = 0;
    let y = _pos.y;
    if (opts.normal) {
      readVec(opts.normal, _nrm, 0, 1, 0);
      nx = _nrm.x; ny = _nrm.y; nz = _nrm.z;
    } else {
      const g = probeGround(_pos.x, _pos.y, _pos.z);
      y = g.y; nx = g.nx; ny = g.ny; nz = g.nz;
    }
    return decals.stamp({
      x: _pos.x, y, z: _pos.z, nx, ny, nz,
      kind: opts.kind || 'soil',
      size: opts.size,
      coverage: opts.coverage,
      tint: opts.tint,
      aspect: opts.aspect,
      roll: opts.roll,
    });
  }

  /**
   * A short radial burst — a combo landing, a foil bag popping, a lightbulb catching the sun.
   * `opts`: { position, colour?, count?, size?, speed?, life?, additive?, cell?, flash? }
   */
  function burst(opts) {
    if (!enabled || !opts || isPhoto()) return;
    readVec(opts.position, _pos, 0, 0.4, 0);
    const count = Math.max(1, Math.round((opts.count !== undefined ? opts.count : 8) * budgetScale));
    const col = opts.colour !== undefined ? lin(opts.colour, opts.gain || 1.4) : lin(0xffd9a0, 1.4);
    const speed = opts.speed !== undefined ? opts.speed : 1.5;
    const size = opts.size !== undefined ? opts.size : 0.05;
    const life = opts.life !== undefined ? opts.life : 0.5;
    const cell = opts.cell !== undefined ? opts.cell : CELL.GLINT;
    const additive = opts.additive !== undefined ? opts.additive : 1;
    for (let i = 0; i < count; i++) {
      const ax = rnd() * Math.PI * 2;
      const ay = Math.acos(rr(-1, 1));
      const dx = Math.sin(ay) * Math.cos(ax);
      const dy = Math.cos(ay);
      const dz = Math.sin(ay) * Math.sin(ax);
      const sp = speed * rr(0.45, 1.3);
      SP.x = _pos.x; SP.y = _pos.y; SP.z = _pos.z;
      SP.vx = dx * sp; SP.vy = dy * sp * 0.85 + 0.2; SP.vz = dz * sp;
      SP.size = size * rr(0.6, 1.4);
      SP.grow = 0.7;
      SP.life = life * rr(0.75, 1.25);
      SP.alpha = 0.95;
      SP.cell = cell;
      SP.r = col[0]; SP.g = col[1]; SP.b = col[2];
      SP.additive = additive;
      SP.drag = 3.0;
      SP.lift = -0.5;
      SP.swirl = 0.15;
      SP.rot = rnd() * Math.PI * 2;
      SP.spin = jit(5);
      SP.owner = opts.owner !== undefined ? opts.owner : OWNER.BURST;
      bill.spawn(SP);
    }
    if (opts.flash) {
      _colour.setRGB(col[0], col[1], col[2]);
      screen.flash(_colour, opts.flash, 0.30);
    }
  }

  // ── the light shafts ───────────────────────────────────────────────────────────────────────

  /** LIGHT calls this whenever it rebakes. See ./beam.js. */
  function setLightShafts(payload) {
    shaftPayload = payload || null;
    applyShaftPayload(beam, shaftPayload);
    return true;
  }

  /** Track the sun even on tiers with no volumetrics, so the dust always knows where the light is. */
  function refreshLight() {
    const day = ctx.lighting?.daylight;
    if (!day) return;
    // Always re-aim from the live sun rather than from the last published shaft: LIGHT only
    // republishes when it rebakes the IBL, and over a three-minute round the sun visibly moves
    // between those. The aperture geometry still comes from the payload.
    _travel.copy(day.sunDir).negate();
    aimBeam(beam, _travel);
    // The dust is scattering the *direct* sun, so its strength follows the key, not the exposure.
    const strength = 0.55 + 1.35 * (day.shaftIntensity || 0) * Math.min(1, 0.3 + (day.sunIntensity || 0) * 0.25);
    setBeamLight(beam, day.shaftColour, strength);
    // Everything that is not the sun: the window softbox and the rug bounce, arriving from
    // everywhere. It is what keeps motes in the far corner from vanishing entirely.
    motes.setAmbient(0.020 + 0.030 * (day.envIntensity || 1), day.windowColour);
  }

  // ── event wiring ───────────────────────────────────────────────────────────────────────────
  const offs = [];
  const on = (name, fn) => { if (events) offs.push(events.on(name, fn)); };
  let offContact = null;

  function isPhoto() {
    return ctx.state?.mode === 'photo';
  }

  /** Token bucket. AUDIO already rate-limits per collider pair; this caps the whole room. */
  function spend() {
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }

  on('fx:impact', (p) => {
    if (!p || suppressImpact > 0) return;
    if (!spend()) return;
    impact({
      position: p.position,
      normal: p.normal,
      material: p.material,
      force: p.force,
    });
  });

  on('prop:shattered', (p) => {
    if (!p) return;
    shatter({ prop: p.prop, object3d: p.prop?.object3d, position: p.position });
  });

  on('prop:toppled', (p) => {
    if (!p || !p.position || p.prop?.fragile) return;
    if (!spend()) return;
    const mat = ctx.physics?.materialOf ? ctx.physics.materialOf(p.prop?.object3d) : 'generic';
    impact({
      position: p.position,
      normal: { x: 0, y: 1, z: 0 },
      material: mat,
      strength: clamp(0.35 + (p.impulse || 0) * 0.25, 0.3, 1),
    });
  });

  /** Some props are containers, and the game never says so. Their id does. */
  const SPILLS = [
    [/mug|cup|coffee|espresso|bottle/, 'coffee', 0.09],
    [/monstera|plant|pot|planter/, 'soil', 0.15],
  ];

  on('prop:toppled', (p) => {
    if (!p || !p.position || isPhoto()) return;
    const id = String(p.prop?.id || '');
    for (let i = 0; i < SPILLS.length; i++) {
      if (!SPILLS[i][0].test(id)) continue;
      spill({ position: p.position, kind: SPILLS[i][1], radius: SPILLS[i][2], splashes: 5 });
      if (SPILLS[i][1] === 'soil' && debris) {
        _nrm.set(0, 1, 0);
        const g = probeGround(p.position.x, p.position.y, p.position.z);
        emitSolids(RESPONSE.soil.solid, p.position.x, p.position.y + 0.05, p.position.z,
          _nrm, 0.8, g.y, 2.0, REST_TAG.soil);
      }
      break;
    }
  });

  on('prop:pulled', (p) => {
    if (!p || !p.position) return;
    dust({ position: p.position, material: 'fabric', strength: 0.55, count: 3 });
  });

  on('baby:bump', (p) => {
    if (!p || !p.position) return;
    const f = clamp((p.force || 0) / 12, 0, 1);
    if (f < 0.12 || !spend()) return;
    impact({ position: p.position, normal: p.normal, material: 'rug', strength: f * 0.8 });
  });

  on('baby:shove', (p) => {
    if (!p || !p.position) return;
    dust({ position: p.position, material: 'rug', strength: 0.35, count: 2, size: 0.07 });
  });

  // BABY emits baby:crawl at 12 Hz (far too often to puff on) and baby:step once per hand plant,
  // which is exactly the beat a knee-dust wants.
  on('baby:crawl', (p) => {
    sawCrawlEvents = true;
    if (!p) return;
    crawlSpeed = p.speed || 0;
    crawlSurface = p.surface === 'mat' ? 'fabric' : (p.surface || null);
  });

  on('baby:step', (p) => {
    sawCrawlEvents = true;
    if (!p || !p.position || isPhoto() || !enabled) return;
    const speed = p.speed !== undefined ? p.speed : crawlSpeed;
    if (speed < 0.22 || rnd() > 0.5) return;
    kneeDust(p.position.x, p.position.y, p.position.z,
      crawlSurface || (insideRug(p.position.x, p.position.z) ? 'rug' : 'wood'),
      clamp(0.14 + speed * 0.16, 0.10, 0.45));
  });

  on('baby:chew', (p) => {
    // Crumbs falling out of the mouth, which is the single most baby thing in the game.
    const o = p?.prop?.object3d;
    if (!o) return;
    o.getWorldPosition(_tmp);
    if (rnd() < 0.45) {
      const g = probeGround(_tmp.x, _tmp.y, _tmp.z);
      emitSolids(CRUMB_SPEC, _tmp.x, _tmp.y - 0.02, _tmp.z, _nrm.set(0, 1, 0), 0.3, g.y);
    }
  });

  on('prop:eaten', (p) => {
    const reaction = REACTION[p?.reaction] || REACTION.yum;
    readVec(p?.position, _pos, 0, 0.4, 0);
    if (reaction.glow) {
      _colour.setHex(reaction.glow);
      screen.flash(_colour, reaction.glowStrength !== undefined ? reaction.glowStrength : reaction.strength, reaction.decay);
    }
    if (reaction.cast) {
      _colour.setHex(reaction.cast);
      screen.cast(_colour, reaction.strength, reaction.decay);
    }
    burst({
      position: _pos,
      colour: reaction.cast || reaction.glow || 0xffc27a,
      count: 7, size: 0.028, speed: 0.85, life: 0.42, additive: 0.85,
    });
    const g = probeGround(_pos.x, _pos.y, _pos.z);
    decals.stamp({ x: _pos.x + jit(0.06), y: g.y, z: _pos.z + jit(0.06), nx: g.nx, ny: g.ny, nz: g.nz, kind: 'crumbs' });
  });

  on('baby:spit', (p) => {
    readVec(p?.position, _pos, 0, 0.35, 0);
    burst({ position: _pos, colour: 0xdfe6e8, count: 6, size: 0.016, speed: 1.1, life: 0.5, additive: 0.25, cell: CELL.MOTE });
    const g = probeGround(_pos.x, _pos.y, _pos.z);
    spill({ position: { x: _pos.x + jit(0.08), y: g.y, z: _pos.z + jit(0.08) }, kind: 'drool', radius: 0.045, splashes: 2 });
  });

  on('combo', (p) => {
    if (!p || !p.count || p.count < 2 || isPhoto()) return;
    const baby = babyPosition();
    if (!baby) return;
    // Small, warm, and over in a third of a second. This is not a cartoon.
    burst({
      position: _tmp.set(baby.x, baby.y + 0.30, baby.z),
      colour: 0xffcf92, count: Math.min(12, 3 + p.count), size: 0.022,
      speed: 0.9, life: 0.34, additive: 1,
      flash: Math.min(0.22, 0.05 + p.count * 0.02),
    });
  });

  on('game:start', () => api.reset());
  on('game:reset', () => api.reset());
  on('light:shafts', (p) => setLightShafts(p));

  if (ctx.physics?.onContact) {
    offContact = ctx.physics.onContact((e) => {
      if (!enabled || isPhoto() || suppressImpact > 0) return;
      const strength = e.impact || 0;
      if (strength < 0.06) return;
      if (!spend()) return;
      impact({
        position: e.position,
        normal: e.normal,
        material: e.materialGuess,
        strength,
        damped: e.damped,
      });
    });
  }

  // ── the baby's own dust ────────────────────────────────────────────────────────────────────

  function babyPosition() {
    const b = ctx.baby;
    if (!b) return null;
    if (b.group) return b.group.getWorldPosition(_tmp);
    if (b.position) return _tmp.copy(b.position);
    return null;
  }

  function kneeDust(x, y, z, surface, strength = 0.24) {
    const res = RESPONSE[surface] || RESPONSE.rug;
    _nrm.set(0, 1, 0);
    const cfg = cloudCfg(res.cloud, { n: 1, size: res.cloud.size * 0.55, alpha: res.cloud.alpha * 0.55 });
    emitCloud(cfg, OWNER.CRAWL, x + jit(0.07), y + 0.012, z + jit(0.07), _nrm, strength);
  }

  /** Fallback for a build where BABY is not reporting its own footfalls: watch it ourselves. */
  function crawlTick(dt) {
    if (sawCrawlEvents) return;
    const p = babyPosition();
    if (!p) return;
    if (Number.isNaN(lastBaby.x)) { lastBaby.copy(p); return; }
    const moved = p.distanceTo(lastBaby);
    lastBaby.copy(p);
    if (moved < 1e-4 || moved > 0.5) return; // 0.5 m in a frame is a teleport, not a crawl
    crawlDistance += moved;
    // One small puff every 40 cm of crawling: enough to see, nowhere near enough to notice.
    if (crawlDistance >= 0.40) {
      crawlDistance = 0;
      const surface = insideRug(p.x, p.z) ? 'rug' : 'wood';
      kneeDust(p.x, p.y, p.z, surface);
    }
    void dt;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────────────────────

  let viewportH = 1080;
  let lastFov = -1;

  function pushProjection(fov) {
    if (fov === lastFov) return;
    lastFov = fov;
    motes.setProjection(viewportH, fov);
  }

  const api = {
    group,
    motes,
    billboards: bill,
    debris,
    decals,
    screen,
    OWNER,
    CELL,

    impact,
    shatter,
    spill,
    dust,
    decal,
    burst,
    setLightShafts,

    /**
     * Scale the live particle budget. Capacity is allocated once from the tier, so this lowers the
     * per-emitter caps and the drawn mote count rather than reallocating; asking for more than the
     * tier allows is clamped.
     */
    setBudget(n) {
      const want = Math.max(0, n | 0);
      budgetScale = clamp(want / BUDGET, 0.04, 1);
      bill.setBudgetScale(budgetScale);
      motes.setCount(Math.round(moteCount * budgetScale));
      return budgetScale * BUDGET;
    },

    setEnabled(v) {
      enabled = !!v;
      if (!enabled) {
        bill.clear();
        debris?.clear();
        screen.clear();
      }
    },

    update(dt) {
      const photo = isPhoto();
      const step = photo ? 0 : clamp(dt || 0, 0, 0.05);
      clock += step;
      tokens = Math.min(6, tokens + step * 14);

      // The camera rig runs before us but its world matrix is only refreshed inside render(), so
      // ask for it explicitly rather than billboarding a frame late.
      const camera = ctx.camera;
      if (camera) {
        camera.updateWorldMatrix(true, false);
        bill.setCamera(camera);
        pushProjection(camera.fov);
      }

      lightClock += step;
      if (lightClock > 0.25 || photo) {
        lightClock = 0;
        refreshLight();
      }
      motes.setTime(photo ? PHOTO_PHASE : clock);

      if (!photo && enabled) {
        crawlTick(step);
        bill.step(step, clock);
        debris?.step(step, clock);
        decals.step(step);
        screen.step(step);
      }

      counters.sprites = bill.upload();
      counters.debris = debris ? debris.upload() : 0;
      counters.decals = decals.upload();
    },

    resize(w, h) {
      const size = ctx.renderer?.getDrawingBufferSize
        ? ctx.renderer.getDrawingBufferSize(_buffer)
        : null;
      viewportH = size ? Math.max(1, size.y) : Math.max(1, h || 1080);
      lastFov = -1;
      screen.setAspect(Math.max(0.2, (w || 1920) / Math.max(1, h || 1080)));
    },

    reset() {
      bill.clear();
      debris?.clear();
      decals.clear();
      screen.clear();
      clock = 0;
      crawlDistance = 0;
      tokens = 6;
      lastBaby.set(NaN, NaN, NaN);
      counters.spawns = 0;
      counters.dropped = 0;
    },

    stats() {
      return {
        budget: BUDGET,
        scale: budgetScale,
        motes: motes.count,
        sprites: counters.sprites,
        spriteCap,
        debris: counters.debris,
        decals: counters.decals,
        decalCap,
        spawned: counters.spawns,
        dropped: counters.dropped,
        beam: beam.uBeamIntensity.value,
      };
    },

    dispose() {
      for (const off of offs) {
        try { off?.(); } catch { /* ignore */ }
      }
      offs.length = 0;
      try { offContact?.(); } catch { /* ignore */ }
      offContact = null;
      if (group.parent) group.parent.remove(group);
      motes.dispose();
      bill.dispose();
      decals.dispose();
      debris?.dispose();
      screen.dispose();
      atlas.dispose();
    },
  };

  ctx.track?.(api);
  refreshLight();
  setLightShafts(ctx.lighting?.shafts ? { enabled: true, ...ctx.lighting.shafts.describe() } : null);
  api.resize(window.innerWidth, window.innerHeight);

  return api;
}
