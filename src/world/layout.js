// OPERATION NAPTIME — module ROOM — the canonical dimensions of the apartment.
// OWNER: ROOM. Implements CONTRACTS.md §2 and extends it into a complete, deep-frozen dataset.
//
// WHY THIS FILE EXISTS
// Fourteen agents are building one room in parallel. If FURN derives the sofa's footprint from the
// contract table and DRESS derives the cushion positions from the sofa, the two drift by a
// centimetre and a laptop ends up floating. So every number that more than one module could
// possibly need lives here exactly once, in metres, radians and world space, and everybody reads
// it instead of re-deriving it. `LAYOUT` is deep-frozen: a module that tries to "just nudge" a
// value gets a silent no-op in sloppy mode and a TypeError in strict mode, which is the point.
//
// CONVENTIONS
//  · Origin (0,0,0) is the centre of the floor. +X right (sofa wall), +Z toward the entrance,
//    +Y up. Metres, seconds, radians.
//  · `x0 < x1`, `z0 < z1`, `y0 < y1` always. `cx/cy/cz` are centres. `w/h/d` are full sizes.
//  · Angles are stored twice: `deg` for reading, `rot` in radians for using. Nothing in this room
//    is square to anything else, and those angles are canonical — if FURN turns the armchair by
//    24° and DRESS puts the throw on it at 22°, the throw slides off.
//  · Anything named `*Nominal` is the number the contract table states; the sibling value is the
//    built one, and the comment says why they differ. There are exactly two such cases and both
//    are clash resolutions of a few centimetres.
//
// A NOTE ON THE TWO ADJUSTMENTS
//  1. `glazing.mullionSpacing` is 1.000 m, not the contract's "~1.05 m": the opening is exactly
//     5.00 m wide, and 5 equal bays is the only spacing near 1.05 that lands a mullion on both
//     jambs. Unequal bays in a shopfront-style glazing line reads as a modelling error.
//  2. `radiator.z` is -4.520 as specified, but the glazing frame's room-side face had to be pulled
//     back to -4.570 so the radiator's 95 mm depth clears it. See `glazing.frameFront`.

const DEG = Math.PI / 180;

/** Recursively freeze a plain object graph. Arrays included; nothing here is meant to be mutable. */
function deepFreeze(o) {
  if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o;
  Object.freeze(o);
  for (const k of Object.keys(o)) deepFreeze(o[k]);
  return o;
}

// ── the shell ─────────────────────────────────────────────────────────────────────────────────

const ROOM = {
  minX: -3.40, maxX: 3.40,
  minZ: -4.60, maxZ: 3.40,
  width: 6.80, depth: 8.00, height: 2.78,
  cx: 0.00, cz: -0.60,
  floorY: 0.00, ceilingY: 2.78,
  /** Padding used by anything that wants to keep clear of the plaster (AI pathing, spawns). */
  inset: 0.12,
};

const WALLS = {
  /** Concrete-and-plaster apartment: 150 mm partitions, no skirting anywhere. */
  thickness: 0.15,
  /** Outer faces (the inner faces are ROOM.minX / maxX / minZ / maxZ). */
  outerMinX: -3.55, outerMaxX: 3.55, outerMinZ: -4.75, outerMaxZ: 3.55,
  /** Every architectural arris is chamfered by this much. Perfectly sharp 90° edges are the most
   *  common tell of amateur real-time art, and 3 mm is what a plastered corner actually has. */
  arris: 0.003,
  /** The plaster only exists where it can be seen; these are the faces we actually build. */
  faces: ['left', 'right', 'back', 'windowPier'],
};

const CEILING = {
  y: 2.78,
  /** Timber formwork boards ~300 mm wide running along X, so the seams are lines of constant Z. */
  boardWidth: 0.30,
  boardAxis: 'x',
  /** Peak-to-peak of the geometric board relief. The normal map carries the fine seam; this is the
   *  slow bow of each board that makes raking window light break into 300 mm bands. */
  boardRelief: 0.0016,
  /** Slabs sag. 9 mm over 6.8 m is barely measurable and completely visible under a low sun. */
  sag: 0.009,
  /** The small black ceiling rose the pendant flex drops out of. */
  rose: { x: 0.30, y: 2.78, z: -1.20, radius: 0.055, thickness: 0.014 },
};

/** The downstand beam: the ceiling steps down toward the window. Contract §2 exact. */
const BEAM = {
  cx: 0.00, y: 2.62, z: -3.05,
  w: 6.80, h: 0.32, d: 0.42,
  x0: -3.40, x1: 3.40,
  y0: 2.46, y1: 2.78,
  z0: -3.26, z1: -2.84,
  /** Crisper than the plaster: a cast concrete arris chips to about 2 mm, not 3. */
  arris: 0.002,
};

const FLOOR = {
  y: 0.00,
  /** Plank length / plank width of the texture tile — planks run along Z, toward the window. */
  plankLength: 2.40, plankWidth: 0.19, plankAxis: 'z',
  /** Amplitude of the screed undulation baked into the vertices (±). */
  undulation: 0.0014,
};

const DOORWAY = {
  x0: 1.40, x1: 2.40, cx: 1.90, width: 1.00,
  z: 3.40, height: 2.10,
  /** The reveal is the wall thickness; the jamb faces are the wall segments' own side faces. */
  revealDepth: 0.15,
  /** Where the parent's silhouette fills the frame. AI reads this. */
  threshold: { x: 1.90, y: 0.00, z: 3.475 },
};

/** A short, dim corridor the parent walks out of. Sealed at the far end — the room is a closed
 *  volume and the baby must not be able to leave it. */
const HALLWAY = {
  x0: 1.12, x1: 2.68, cx: 1.90, width: 1.56,
  z0: 3.55, z1: 5.45, depth: 1.90,
  height: 2.34,
  floorY: 0.00,
  wallThickness: 0.12,
  /** A doorway-shaped brighter panel on the +X wall, implying a lit room off the corridor. This is
   *  the light trap: it gives the hallway a value gradient so it reads as depth, not a black hole. */
  spill: { x: 2.68, y0: 0.02, y1: 2.02, z0: 4.35, z1: 5.20 },
  /** Where the parent waits before a round starts, and the path they take to the threshold. */
  spawn: { x: 1.90, y: 0.00, z: 5.05 },
  path: [[1.90, 0.00, 5.05], [1.90, 0.00, 4.10], [1.90, 0.00, 3.48], [1.90, 0.00, 2.90]],
};

// ── the window wall ───────────────────────────────────────────────────────────────────────────

const GLAZING = (() => {
  const x0 = -1.60;
  const x1 = 3.40;
  const bays = 5;                      // 5.00 m / 5 = 1.00 m — see the header note
  const span = x1 - x0;
  const spacing = span / bays;
  const mullionX = [];
  for (let i = 1; i < bays; i++) mullionX.push(+(x0 + spacing * i).toFixed(3));
  return {
    z: -4.60,                          // the nominal wall plane
    x0, x1, span, bays,
    mullionSpacingNominal: 1.05,
    mullionSpacing: spacing,
    mullionX,                          // [-0.60, 0.40, 1.40, 2.40]
    sillY: 0.06, headY: 2.50,
    /** The frame is a 90 mm deep box section sitting in the wall opening. */
    frameBack: -4.660, frameFront: -4.570, frameDepth: 0.090,
    /** Face widths of the profiles, seen from the room. */
    jambWidth: 0.058, headWidth: 0.062, sillWidth: 0.070, mullionWidth: 0.046,
    /** The glass plane of the fixed bays. */
    glassZ: -4.615, glassThickness: 0.010,
    /** The sliding-door section occupies the two right-hand bays. */
    slider: {
      x0: 1.40, x1: 3.40,
      /** Outer track: the fixed leaf. Inner track: the leaf that actually slides. */
      fixed: { x0: 2.40, x1: 3.40, z: -4.638, glassZ: -4.638 },
      slide: { x0: 1.40, x1: 2.42, z: -4.590, glassZ: -4.590 },
      stileWidth: 0.052, railHeight: 0.062,
      trackY: 0.062, trackZ0: -4.660, trackZ1: -4.566, trackRise: 0.012,
      handle: { x: 1.545, y0: 0.86, y1: 1.26, radius: 0.011, standoff: 0.048 },
    },
    /** Plaster returns above the head and below the sill. */
    headPanel: { y0: 2.50, y1: 2.78 },
    sillPanel: { y0: 0.00, y1: 0.06 },
    /** The solid pier between the left wall and the start of the glazing. */
    pier: { x0: -3.40, x1: -1.60, width: 1.80 },
  };
})();

/** Three sheer panels. Widths are the *hung* widths; the cloth in a gathered panel is roughly
 *  2.4x that, which is where the fold count comes from. */
const CURTAINS = {
  z: -4.48,
  topY: 2.42, trackY: 2.455, hemY: 0.00,
  /** How much cloth lies on the floor. Sheers always pool a little; it is the cheapest possible
   *  cue that the fabric has weight. */
  pool: 0.055,
  trackX0: -1.78, trackX1: 3.40,
  panels: [
    {
      id: 'curtain-left', side: 'left', propId: 'curtain-left',
      cx: -1.50, width: 0.34, gathers: 13, gathered: true,
      /** How far the fold crests stand off the base plane (±, metres). */
      foldDepth: 0.045, seed: 0x0c1a,
    },
    {
      id: 'curtain-mid', side: 'mid', propId: null,
      cx: 0.85, width: 1.10, x0: 0.30, x1: 1.40, gathers: 7, gathered: false,
      foldDepth: 0.026, seed: 0x0c2b,
    },
    {
      id: 'curtain-right', side: 'right', propId: 'curtain-right',
      cx: 3.20, width: 0.36, gathers: 14, gathered: true,
      foldDepth: 0.048, seed: 0x0c3c,
    },
  ],
};

const RADIATOR = {
  x0: -1.20, x1: -0.20, cx: -0.70, w: 1.00,
  y: 0.32, y0: 0.03, y1: 0.61, h: 0.58,
  z: -4.520, d: 0.095,
  columns: 22, columnPitch: 1.00 / 22,
  /** Each column is four overlapping tubes in section — a classic 4-column steel radiator. */
  tubeRadius: 0.0195, tubeGap: 0.019, tubes: 4,
  grilleY: 0.616, bracketZ: -4.566,
  valve: { x: -0.245, y: 0.10, radius: 0.016 },
};

// ── the world beyond the glass ────────────────────────────────────────────────────────────────

const EXTERIOR = {
  /** Street level. The flat is a couple of floors up, which is why the bare trees reach the sill
   *  and why the brick facade opposite fills most of the window. */
  groundY: -3.05,
  balcony: {
    x0: -2.10, x1: 3.80, z0: -4.75, z1: -6.35,
    topY: -0.03, thickness: 0.14,
  },
  railing: {
    z: -6.28, y0: -0.03, height: 1.06,
    x0: -2.10, x1: 3.80,
    postPitch: 0.108, postSize: 0.014,
    railDepth: 0.030, railHeight: 0.042,
  },
  planter: {
    x0: -1.90, x1: -0.30, cz: -5.62, w: 1.60, h: 0.34, d: 0.42,
    topY: 0.31, clumps: 11,
  },
  trees: [
    { x: -4.60, z: -8.40, height: 6.20, lean: -0.07, seed: 0x7e1 },
    { x: 0.80, z: -9.90, height: 7.05, lean: 0.05, seed: 0x7e2 },
    { x: 5.20, z: -8.90, height: 5.60, lean: 0.09, seed: 0x7e3 },
    { x: -9.10, z: -10.60, height: 6.60, lean: -0.04, seed: 0x7e4 },
  ],
  building: {
    frontZ: -13.40, depth: 3.40,
    x0: -17.00, x1: 13.00, y0: -3.05, y1: 11.20,
    windows: {
      w: 1.25, h: 1.65, pitchX: 2.35, pitchY: 2.95,
      firstX: -9.40, firstY: -1.30, cols: 9, rows: 4,
      reveal: 0.11,
      /** Column-major indices (col * rows + row) of the few windows with a light on. */
      lit: [5, 13, 26, 31],
    },
    parapet: { height: 0.42, overhang: 0.10 },
  },
  sky: { radius: 33.0, segments: 24 },
};

// ── furniture and dressing anchors (CONTRACTS §2, for FURN and DRESS) ─────────────────────────

const FURNITURE = {
  shelving: {
    x: -3.22, backX: -3.40, z0: -3.20, z1: 1.20, length: 4.40,
    depth: 0.36, heights: [0.42, 0.60, 0.78],
    /** Cube module: the run is a staircase of these at three heights, some stacked two high. */
    module: 0.42, plyThickness: 0.018,
    rot: -1.0 * DEG, deg: -1.0,
  },
  artwork: { x: -3.30, y: 1.05, z: 0.85, w: 0.90, h: 1.15, leanDeg: 4, lean: 4 * DEG, frame: 0.028 },
  espresso: { x: -3.15, y: 0.72, z: 2.25, w: 0.30, h: 0.38, d: 0.42, deg: 8, rot: 8 * DEG },
  rug: {
    x: 0.90, y: 0.008, z: -1.80, w: 4.60, d: 4.00,
    deg: -2.5, rot: -2.5 * DEG, pile: 0.012, fringe: 0.07,
  },
  sofa: {
    x: 2.55, z: -0.50, w: 1.60, h: 0.72, d: 4.20,
    seatY: 0.42, armH: 0.56, backH: 0.72,
    chaise: { w: 2.00, h: 0.42, d: 1.30, x: 1.90, z: 1.30 },
    laptop: { x: 2.30, y: 0.46, z: 0.60, deg: -14, rot: -14 * DEG },
    cushions: [
      { x: 2.90, y: 0.58, z: -1.55, kind: 'rib', deg: 12 },
      { x: 2.75, y: 0.50, z: 0.10, kind: 'flat', deg: -7 },
    ],
    deg: 0, rot: 0,
  },
  armchair: { x: -0.35, z: -3.45, w: 0.78, h: 0.74, d: 0.80, seatY: 0.40, deg: 24, rot: 24 * DEG },
  ottoman: { x: -1.45, z: -2.05, w: 1.15, h: 0.42, d: 0.85, deg: -6, rot: -6 * DEG },
  pouf: { x: 0.95, z: -1.35, radius: 0.33, h: 0.42, deg: 11, rot: 11 * DEG },
  coffeeTable: {
    x: 0.95, z: -2.35, w: 1.10, h: 0.36, d: 0.55,
    slab: 0.012, deg: 3, rot: 3 * DEG,
  },
  sideTable: { x: 1.70, z: -3.25, radius: 0.22, h: 0.50, stem: 0.022, top: 0.024 },
  playpen: {
    x: 0.00, z: 2.00, w: 2.80, h: 0.62, d: 2.60,
    tube: 0.055, meshInset: 0.03, matThickness: 0.022,
    door: { face: '-z', x0: -0.55, x1: 0.55 },
    deg: 1.5, rot: 1.5 * DEG,
  },
  playGym: { x: 0.15, z: 1.70, span: 0.75, height: 0.52, deg: -18, rot: -18 * DEG },
  toyPile: { x: 0.30, z: 1.85, radius: 0.55, count: 14 },
  monstera: { x: 1.60, z: -4.15, height: 1.35, potRadius: 0.17, leaves: 9 },
  plant2: { x: 2.35, z: -4.25, height: 0.85, potRadius: 0.12 },
  floorLamp: { x: 2.95, z: -4.10, height: 1.55, shadeRadius: 0.19 },
  pendant: {
    x: 0.30, y: 1.62, z: -1.20,
    cordTop: 2.78, cordLength: 1.16, cordRadius: 0.0035, bulbRadius: 0.033,
  },
  rattanChair: { x: 3.00, z: 3.05, size: 0.55, height: 0.74, deg: -18, rot: -18 * DEG },
  snackBag: { x: 1.35, y: 0.02, z: -0.55, w: 0.16, h: 0.05, d: 0.22, deg: 37, rot: 37 * DEG },
};

// ── the protagonist ───────────────────────────────────────────────────────────────────────────

const BABY = {
  eyeHeight: 0.42,
  headRadius: 0.115,
  bodyRadius: 0.16,
  bodyHalfHeight: 0.13,
  /** Inside the playpen, facing the room. This is where a round begins. */
  start: { x: -0.72, y: 0.30, z: 2.72, heading: Math.PI * 0.82 },
};

// ── the export ────────────────────────────────────────────────────────────────────────────────

export const LAYOUT = deepFreeze({
  version: 1,
  units: 'metres, seconds, radians; +X right, +Y up, +Z toward the entrance',

  room: ROOM,
  walls: WALLS,
  ceiling: CEILING,
  beam: BEAM,
  floor: FLOOR,
  doorway: DOORWAY,
  hallway: HALLWAY,
  glazing: GLAZING,
  curtains: CURTAINS,
  radiator: RADIATOR,
  exterior: EXTERIOR,

  ...FURNITURE,
  baby: BABY,

  /** Handy derived boxes so nobody hand-writes them. */
  bounds: {
    interior: { x0: -3.40, x1: 3.40, y0: 0.00, y1: 2.78, z0: -4.60, z1: 3.40 },
    playable: { x0: -3.28, x1: 3.28, y0: 0.00, y1: 2.78, z0: -4.48, z1: 3.28 },
  },
});

export default LAYOUT;
