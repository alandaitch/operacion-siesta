// OPERATION NAPTIME — module MAT — architecture and wood.
//
// The room is read from a photograph taken from 2.3 m up, so the ceiling slab is the largest
// object in the frame and the floor is the second. Those two surfaces carry the render; the rest
// of this file is the birch plywood the shelving run is built from, plus the timbers.
//
// Every `extent` below is the real-world size (metres) of the surface the material usually dresses.
// The library turns that into a texture repeat via the generator's own tileMetres, so nobody has
// to hand-tune a repeat number, and `materials.tiled(name, w, h)` overrides it per mesh.

import { makeMaterial } from './util.js';

export const ARCHITECTURE = {
  /**
   * The hero. Board-formed raw concrete, whitewashed unevenly, damp blotches, 30 cm formwork
   * seams. normalScale 0.9 is tuned so the seam fins and the aggregate catch the low window light
   * without turning the slab into embossed wallpaper; the roughness band stays high and narrow
   * (0.82–0.97) because concrete has no gloss anywhere — the *variation* is what reads, not shine.
   * A touch of cool in the tint separates it from the warm plaster it meets at the wall line.
   */
  'concrete.ceiling': (B) => makeMaterial(B, {
    tex: 'concreteBoardFormed',
    colour: 0xf3f4f2,
    rough: [0.82, 0.97],
    normal: 0.9,
    ao: B.quality.aoQuality > 0 ? 0.85 : 1.0, // baked AO does all the work when GTAO is off
    extent: [6.8, 8.0],
    envBoost: 0.85,
  }),

  /**
   * The downstand beam over the window: same slab, damper, and it never sees direct sun. Half the
   * resolution of the ceiling on purpose — it is a 0.42 m soffit strip at the far end of the room,
   * and a second full-size board-formed set would cost 12 MB to say almost the same thing.
   */
  'concrete.beam': (B) => makeMaterial(B, {
    tex: ['concreteBoardFormed', { seed: 1177, stain: 0.75, size: 512 }],
    colour: 0xe9eae8,
    rough: [0.84, 0.97],
    normal: 0.85,
    ao: 0.95,
    repeat: [2.8, 0.6],
    envBoost: 0.8,
  }),

  /**
   * Painted plaster. Warm off-white (#EDE7DC family), roughness ~0.95 with a very gentle
   * orange-peel normal — 0.35 rather than 1.0, because a wall that catches its own roller texture
   * in every grazing light is the classic procedural-render tell.
   */
  'plaster.wall': (B) => makeMaterial(B, {
    tex: 'plasterWall',
    colour: 0xefe9de,
    rough: [0.80, 0.97],
    normal: 0.35,
    extent: [6.8, 2.78],
  }),

  /** The shallow plastered return where the slab meets the wall — cooler, a little dirtier. */
  'plaster.ceilingEdge': (B) => makeMaterial(B, {
    tex: ['plasterWall', { seed: 2299, colour: 0xe6ded2, size: 256 }],
    colour: 0xe8e3d9,
    rough: [0.9, 0.97],
    normal: 0.3,
    extent: [6.8, 0.5],
  }),

  /**
   * The floor. Warm mid-brown wide planks, and the single most important thing here is the
   * roughness band: 0.35–0.60. The low sun rakes in at 12–18°, and a floor with one flat roughness
   * turns that into a uniform wash. Banded, the plank figure and the scuff streaks break the
   * highlight into a band that moves with the camera. No clearcoat — this is a matte oiled floor,
   * not a lacquered one; the sheen is anisotropic-by-roughness only.
   */
  'floor.wood': (B) => makeMaterial(B, {
    tex: 'woodFloorPlank',
    colour: 0x9d7f5f,
    rough: [0.35, 0.60],
    normal: 0.75,
    ao: 0.8,
    extent: [6.8, 8.0],
    envBoost: 0.9,
  }),

  /** Painted skirting: same plaster stock, but paint on timber is satin, not chalk. */
  'floor.skirting': (B) => makeMaterial(B, {
    tex: ['plasterWall', { seed: 2255, colour: 0xf2ede4, size: 256 }],
    colour: 0xf1ece3,
    rough: [0.48, 0.68],
    normal: 0.3,
    extent: [6.8, 0.12],
  }),
};

export const WOOD = {
  /** Birch ply face veneer for the shelving cubes. Satin, slightly open-grained, never glossy. */
  'wood.ply': (B) => makeMaterial(B, {
    tex: 'plywoodBirch',
    colour: 0xe4cda6,
    rough: [0.52, 0.74],
    normal: 0.7,
    extent: [0.6, 0.6],
  }),

  /**
   * The exposed laminated edge — 15 plies, amber glue lines, the odd core void. This is the detail
   * that makes the shelving read as self-built rather than bought, so it gets its baked AO at full
   * strength and a stronger normal than the face veneer.
   */
  'wood.plyEdge': (B) => makeMaterial(B, {
    tex: 'plywoodEdge',
    colour: 0xe8d3ae,
    rough: [0.42, 0.76],
    normal: 1.0,
    ao: 1.0,
    extent: [0.6, 0.018],
  }),

  /** Oiled oak — a warmer, more open grain than the floor and a shade lighter. */
  'wood.oak': (B) => makeMaterial(B, {
    tex: ['woodFloorPlank', { seed: 3311, colour: 0xa8845c, tileMetres: [1.2, 0.5], size: 512 }],
    colour: 0xb2966f,
    rough: [0.40, 0.62],
    normal: 0.7,
    ao: 0.8,
    extent: [1.2, 0.5],
  }),

  /** Walnut: dark, tight, oiled to a low satin. Reads almost black in the far corners. */
  'wood.walnut': (B) => makeMaterial(B, {
    tex: ['woodFloorPlank', { seed: 3322, colour: 0x5f4530, tileMetres: [1.2, 0.5], size: 512 }],
    colour: 0x6d5138,
    rough: [0.34, 0.55],
    normal: 0.65,
    ao: 0.85,
    extent: [1.2, 0.5],
  }),

  /**
   * The wooden toys — the ukulele body, stacking rings. Lacquered birch, so it gets a thin
   * clearcoat: a toy that has been in a mouth is glossier than furniture and that reads instantly.
   */
  'wood.birchToy': (B) => makeMaterial(B, {
    tex: ['plywoodBirch', { seed: 4411, colour: 0xe8d3ad }],
    colour: 0xecd7b0,
    rough: [0.30, 0.52],
    normal: 0.55,
    extent: [0.25, 0.25],
    clearcoat: { amount: 0.28, roughness: 0.18 },
  }),

  /**
   * Cane webbing. A real alphaMap with octagonal holes, double-sided because you see the back of
   * the seat from crawling height, and a small sheen because polished cane is satin, not matte.
   * alphaTest rather than blending: cane is a hard cutout and blending would sort badly against
   * the rug behind it.
   */
  rattan: (B) => makeMaterial(B, {
    tex: 'rattanCane',
    colour: 0xcfa86c,
    rough: [0.36, 0.64],
    normal: 1.1,
    ao: 1.0,
    extent: [0.45, 0.45],
    alpha: true,
    sheen: { amount: 0.35, roughness: 0.45, colour: 0xf3e0bd },
    props: { alphaTest: 0.42, side: B.THREE.DoubleSide },
  }),
};
