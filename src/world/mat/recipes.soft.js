// OPERATION NAPTIME — module MAT — soft goods.
//
// Two thirds of this room is fabric, and fabric is where a real-time render usually dies: a cream
// sofa lit by a window is 90% sheen. Every material here is MeshPhysicalMaterial with a real sheen
// lobe (Estevez–Kulla), because the retro-reflective fuzz at the grazing angle is the whole reason
// a bouclé chair looks expensive and a diffuse cream box does not.
//
// The three numbers that matter per fabric:
//   sheen          — how much fuzz there is (velvet 1.0, bouclé 0.85, denim 0.2)
//   sheenRoughness — how tight the rim is. LOW is sharp and bright (velvet, 0.30), HIGH is broad
//                    and woolly (bouclé, 0.92). Get these two backwards and velvet reads as felt.
//   sheenColor     — always warmer/lighter than the albedo. Fibre tips scatter forward and lose
//                    saturation, which is why a navy cushion rims pale blue-grey, not navy.
//
// On the `low` tier the library builds these as MeshStandardMaterial and the sheen costs nothing.

import { makeMaterial } from './util.js';

export const SOFT = {
  /**
   * Bouclé — armchair, ottoman, pouf. The loop field comes from the generator (real overlapping
   * wool loops, not fabric-ish noise) with baked crevice AO; the material's job is the broad,
   * woolly sheen sitting on top of it. normalScale 1.15 on top of the generator's already strong
   * 2.1 keeps the loops legible at 40 cm, which is the distance the baby's face is from the chair.
   *
   * sheenColor R:B fix (see histogram before/after in the M4 report): the loop-density pass
   * (tileMetres 0.16→0.085, loopsPerTile 17→26) is roughly an 8x increase in loops-per-m², which
   * is an 8x increase in high-frequency normal variation feeding a *broad* sheenRoughness (0.94)
   * lobe — Charlie/Neubelt fires across most of the NoH range at that roughness, not just the
   * silhouette rim the way velvet's tight 0.18 lobe does. So a sheenColor that used to tint a
   * thin rim now tints most of the visible surface. 0xfae9cc had R:B 1.225 — noticeably warmer
   * than velvet's near-white 0xfffaf2 (R:B 1.054) — and at 8x the coverage that pushed the whole
   * object sepia. Cooled to 0xf6ecd8 (R:B 1.139, still lighter+warmer than the 0xf0e7d8 albedo
   * per the header rule above) without touching sheen amount/roughness or any loop geometry.
   */
  'fabric.boucle': (B) => makeMaterial(B, {
    tex: 'boucle',
    physical: true,
    colour: 0xe6e2d6,
    rough: [0.35, 0.55],
    normal: 1.15,
    ao: 0.4,
    extent: [0.8, 0.8],
    envBoost: 4.0,
    sheen: { amount: 0.85, roughness: 0.94, colour: 0xf6ecd8 },
  }),

  /**
   * The cream velvet/chenille sectional. sheen 1.0 with a tight sheenRoughness 0.30 and a
   * near-white sheen colour: the rim-lit fuzz along the seat fronts and the arm rolls is the
   * single most expensive-looking thing in the frame. The roughness band is deliberately wide
   * (0.48–0.88) so the generator's directional pile streaks produce a real anisotropic shift as
   * the camera crawls past.
   */
  'fabric.velvetCream': (B) => makeMaterial(B, {
    tex: 'velvetChenille',
    physical: true,
    colour: 0xebe1cf,
    rough: [0.48, 0.88],
    normal: 0.45,
    extent: [1.2, 1.2],
    sheen: { amount: 1.0, roughness: 0.18, colour: 0xfffaf2 },
    envBoost: 1.05,
  }),

  /** The navy ribbed lumbar cushion. Cord has a directional sheen — tighter than wool, softer
   *  than velvet — and deep valleys, so the baked AO stays near full. */
  'fabric.navyRib': (B) => makeMaterial(B, {
    tex: 'ribbedCorduroy',
    physical: true,
    colour: 0x323d5c,
    rough: [0.62, 0.88],
    normal: 1.2,
    ao: 0.95,
    extent: [0.45, 0.45],
    sheen: { amount: 0.6, roughness: 0.5, colour: 0x9fb0cc },
  }),

  /** The flatter navy cushion: plain twill, barely any fuzz. */
  'fabric.navyFlat': (B) => makeMaterial(B, {
    tex: ['twillCotton', { colour: 0x2b3550 }],
    physical: true,
    colour: 0x30395a,
    rough: [0.72, 0.92],
    normal: 0.9,
    extent: [0.45, 0.45],
    sheen: { amount: 0.28, roughness: 0.6, colour: 0x93a3bd },
  }),

  /**
   * The sheer curtains — the hardest material in the room, and the one the transmission budget in
   * ../materials.js takes the most away from. They span most of the window wall, so they were
   * paying for the full-resolution transmission pass (and, being DoubleSide, for its second resolve
   * and mip regeneration) in almost every frame of the game. Below `ultra` they no longer get it.
   *
   * FOUR mechanisms replace it, none of them a render target. Read them together — no single one is
   * sufficient, and the failure they exist to prevent is a flat chalky rectangle:
   *
   *  1. ALPHA is the see-through, and always was. `props.opacity` times the voile's own alphaMap
   *     punches genuine holes for the brick and the railing behind. Transmission never carried
   *     this: it does not composite cleanly through a DoubleSide, depthWrite:false surface. Opacity
   *     goes 0.55 → 0.62 because transmission used to contribute some of the cloth's own body.
   *  2. TRANSLUCENCY (util.js) is the glow, and it is the real fix. The window softbox sits at
   *     z = −4.53, BEHIND the cloth at −4.48, and the sun rakes in from further out still — so the
   *     front face of a curtain has dot(N, L) < 0 for every light that matters and three gives it
   *     no direct diffuse whatsoever. A curtain that simply loses `transmission` is not dimmer, it
   *     is *unlit*. This lobe is the light that goes in the back and comes out the front: broad
   *     (power 2.0, so it is a glow and not a specular flare), warm (0xffe4bc — daylight through
   *     cream cotton loses blue first), with a 0.34 ambient floor so folds turned edge-on to the
   *     sun stay luminous instead of going black.
   *  3. SHEEN, widened from 0.42 to 0.88. A tight lobe draws a hard rim, which is what a satin
   *     does; a voile is a cloud of loose fibres and scatters over almost the whole hemisphere. The
   *     wide lobe is what puts light on the *sides* of the folds rather than only their crests, and
   *     it is the difference between reading as gathered cloth and reading as corrugated card.
   *  4. A LOW EMISSIVE, modulated by the weave map (like `emissive.lampshade`), standing in for the
   *     one thing the other three cannot reach: the whole window wall is an area light behind this
   *     cloth, and a RectAreaLight lights the front face of a backlit sheet exactly as poorly as a
   *     directional one does. Kept deliberately small — emissive ignores the normal, so it is the
   *     one term here that genuinely does flatten if overdone — and textured, so the threads still
   *     read inside it.
   *
   * depthWrite stays off and alphaTest stays 0: three panels overlap in front of the glazing, so
   * they must blend and sort rather than cut out, and a mipmapped alphaMap under an alphaTest is
   * exactly the bug that once turned the playpen mesh solid (see `fabric.mesh`).
   */
  'fabric.sheer': (B) => {
    const real = B.transmits(); // ultra only — see TRANSMISSION_BUDGET
    const mat = makeMaterial(B, {
      tex: 'sheerVoile',
      physical: true,
      colour: real ? 0xf8f5ef : 0xf1e9d8,
      rough: [0.50, 0.72],
      normal: 0.6,
      extent: [1.0, 1.0],
      alpha: true,
      sheen: real
        ? { amount: 1.0, roughness: 0.42, colour: 0xfff4e4 }
        : { amount: 1.0, roughness: 0.88, colour: 0xfff0d2 },
      transmission: {
        amount: 0.35, thickness: 0.004, ior: 1.36,
        attenuationColour: 0xfff0d8, attenuationDistance: 0.35,
      },
      translucency: real ? null : { colour: 0xffd9a4, strength: 0.55, power: 2.0, ambient: 0.14 },
      props: {
        side: B.THREE.DoubleSide,
        transparent: true,
        // 0.55 → 0.52, DOWN not up. The first attempt raised it, reasoning that transmission had
        // been contributing some of the cloth's body — but measured against the frame it replaces,
        // what transmission was actually contributing was the *backdrop*: at 0.62 the floor lamp
        // standing behind the right-hand panel stopped reading through it, and a sheer you cannot
        // see the room through is a bedsheet. The panel's brightness comes back from the albedo
        // and the sheen instead, both of which keep the folds.
        opacity: real ? 0.55 : 0.52,
        depthWrite: false,
        alphaTest: 0,
        emissive: real ? 0x000000 : 0xf9dcae,
        emissiveIntensity: real ? 0 : 0.035,
      },
      // envBoost stays where it was. Raising it looked like the obvious way to put the lost light
      // back, and it is the wrong light: the IBL over this cloth is dominated by a cool winter sky,
      // so leaning on it desaturates the panel toward chalk — measured, it took the gathered
      // panel's R:B from 1.112 to 1.077. The warm energy has to come from the warm sources, which
      // is the translucency lobe and the emissive.
      envBoost: 1.15,
    });
    // Reuse the weave as the emissive map so the glow carries the thread grid instead of being a
    // flat lit card. Same texture object, no extra upload.
    if (!real) mat.emissiveMap = mat.map;
    return mat;
  },

  /**
   * The playpen's white mesh — a genuinely see-through veil, not a cutout card. alphaTest against a
   * mipmapped alphaMap is what was killing it: at any distance beyond the first mip the box filter
   * averages the holes toward the surrounding thread value and the test passes everywhere, so the
   * panel goes solid. A real alpha blend with depthWrite off does the physically correct thing at
   * every mip — the far panel settles at its true ~30% open-weave veil instead of fogging to opaque
   * or vanishing. Cooled to a grey-white (not the warm room tint) so it reads as its own material
   * against the warm bounce, per REFERENCE's "soft grey-white veil".
   */
  'fabric.mesh': (B) => makeMaterial(B, {
    tex: 'meshNet',
    physical: true,
    colour: 0xeef0f2,
    rough: [0.62, 0.86],
    normal: 1.0,
    // The meshNet generator authors a 0.05 m tile holding 10 cells, i.e. 5 mm holes. `extent` is
    // the world size ONE tile covers, so it has to match that, not the size of the panel.
    extent: [0.06, 0.06],
    alpha: true,
    sheen: { amount: 0.55, roughness: 0.55, colour: 0xf2f6fb },
    props: {
      side: B.THREE.DoubleSide,
      transparent: true,
      alphaTest: 0,
      depthWrite: false,
    },
    envBoost: 1.1,
  }),

  /** The padded beige tube frame: quilted ripstop nylon. Technical fabric, so the sheen is tight
   *  (0.32) — that hard little highlight along the tube is what says "nylon", not "wool". */
  'fabric.playpenTrim': (B) => makeMaterial(B, {
    tex: 'quiltedNylon',
    physical: true,
    colour: 0xf0e9dc,
    rough: [0.64, 0.84],
    normal: 0.95,
    ao: 0.95,
    extent: [2.7, 0.25],
    sheen: { amount: 0.42, roughness: 0.55, colour: 0xefe6d4 },
  }),

  /** The play mat: padded foam under a soft-touch print, not a glazed tile — the clearcoat was the
   *  whole reason it read as ceramic; it is almost gone now, and the roughness sits high and matte. */
  'fabric.playmat': (B) => makeMaterial(B, {
    tex: 'playMatPrint',
    physical: true,
    colour: 0xf4f3f0,
    rough: [0.62, 0.84],
    normal: 0.95,
    ao: 0.9,
    extent: [2.6, 2.6],
    clearcoat: { amount: 0.05, roughness: 0.55 },
  }),

  /** The white muslin blanket, bunched in a corner of the playpen. Thin, double-sided, and
   *  woolly-sheened so the crumple edges catch light the way loose cotton does. */
  'fabric.muslin': (B) => makeMaterial(B, {
    tex: 'muslinCrinkle',
    physical: true,
    colour: 0xf6f3ec,
    rough: [0.80, 0.95],
    normal: 1.0,
    ao: 0.9,
    extent: [0.7, 0.7],
    sheen: { amount: 0.55, roughness: 0.7, colour: 0xfffbf3 },
    props: { side: B.THREE.DoubleSide },
  }),

  /**
   * Plush toys. Dead matte with a very broad sheen: fur has no highlight, it has a glow. Left at
   * near-white so `materials.tinted('fabric.plush', hex)` lands the true toy colour — the toys are
   * the one saturated thing in the room and this map must not be quietly muddying that multiply.
   */
  'fabric.plush': (B) => makeMaterial(B, {
    tex: 'plushFuzz',
    physical: true,
    colour: 0xffffff,
    rough: [0.90, 0.985],
    normal: 1.3,
    ao: 0.9,
    extent: [0.04, 0.04],
    sheen: { amount: 0.95, roughness: 0.75, colour: 0xfff0dd },
  }),

  /** Denim / heavy cotton, for whatever the parent is wearing below the waist. */
  'fabric.denim': (B) => makeMaterial(B, {
    tex: 'twillCotton',
    physical: true,
    colour: 0x46536e,
    rough: [0.75, 0.92],
    normal: 0.9,
    extent: [0.5, 0.5],
    sheen: { amount: 0.2, roughness: 0.65, colour: 0x9fb0c6 },
  }),

  /**
   * The cream wool rug — the bounce card for the whole room. Short dense pile: high roughness, a
   * broad sheen for the pile, and the generator's weave normal at full strength so the lay
   * direction shifts tone as the camera crawls across it. envBoost is up slightly because in the
   * reference the rug is the brightest large surface in the lower half of the frame.
   */
  'rug.wool': (B) => makeMaterial(B, {
    tex: 'woolRugPile',
    physical: true,
    colour: 0xefe6d5,
    rough: [0.80, 0.96],
    normal: 1.0,
    ao: 0.95,
    extent: [4.6, 4.0],
    sheen: { amount: 0.55, roughness: 0.85, colour: 0xfff2df },
    envBoost: 1.1,
  }),

  /**
   * The unlit fabric of the floor lamp's mushroom dome (the glowing version is
   * `emissive.lampshade`). Double-sided, warm cream, soft sheen along the drum.
   */
  lampshade: (B) => makeMaterial(B, {
    tex: ['muslinCrinkle', { seed: 31099, colour: 0xf6ecd9, tileMetres: 0.2 }],
    physical: true,
    colour: 0xf7edda,
    rough: [0.66, 0.88],
    normal: 0.8,
    ao: 0.9,
    extent: [1.07, 0.3],
    sheen: { amount: 0.45, roughness: 0.6, colour: 0xfff3dd },
    props: { side: B.THREE.DoubleSide },
  }),
};
