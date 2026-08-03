// OPERATION NAPTIME — module MAT — glass, metal, ceramic, stone, plastic, foil.
//
// Glass policy, because it is the expensive decision in this file. three re-renders the WHOLE scene
// into a second full-resolution target for any frame in which a material with `transmission > 0` is
// visible — 7.1 ms of a 40.3 ms frame, measured — so transmission is priced per *frame*, not per
// object, and ../materials.js hands out exactly one licence for it below `ultra`:
//
//   glass.clear  (the coffee table, 1.10 x 0.55 m) — HOLDS THE ONLY LICENCE. It is the hero
//     refraction of the room, the baby crawls under it, it is small on screen, and it is FrontSide,
//     so unlike a double-sided curtain it never triggers the second resolve+mip of that target.
//     ior 1.52 and a green attenuation: real float glass is green on edge, and that edge tint —
//     visible only through the 12 mm thickness and along the waterfall legs — is the single tell
//     that separates good glass from a grey transparent box.
//   glass.window (5 m of glazing) — transmission only on `ultra`. Everywhere else it is a
//     low-opacity dielectric with a strong environment term, which for a flat pane facing a bright
//     exterior is very nearly indistinguishable and costs a hundredth as much. This was already the
//     right shape before there was a budget; the budget just made it the rule instead of the
//     exception.
//
// Metals are all metalness 1 driven by a real metalness channel, with roughness bands that are
// narrow and LOW. Anodised black is 0.35, not 0.9 — matte black metal is still metal, and giving
// it wool-grade roughness is how a render ends up with black plastic window frames.

import { makeMaterial } from './util.js';

export const HARD = {
  /**
   * The coffee table slab. See the glass policy note above.
   *
   * It also carries fingerprints. A glass table in a flat with a ten-month-old is never clean, and
   * because `material.roughness` is what drives the refraction blur, the smudges soften what you
   * see *through* the glass exactly where a hand has been — which is a thing you cannot fake with
   * a decal. The smudge map's authored range is 0.50–1.00, so the band is stretched (and negative
   * at the low end) to land clean glass at 0.02 and a greasy print at 0.22.
   */
  'glass.clear': (B) => makeMaterial(B, {
    physical: true,
    // With transmission the albedo is what the refracted image is multiplied by, so it wants to be
    // near-white. Without it, a near-white DIELECTRIC albedo is a milky diffuse wash sitting on top
    // of the room behind — the classic "sheet of tracing paper" glass. The substitute drops the
    // albedo almost to black (glass has essentially no diffuse; everything you see is transmitted
    // or reflected) and gets the reflection back through envBoost instead, which is the term that
    // is actually Fresnel-weighted.
    colour: B.transmits() ? 0xf9fdfa : 0x161c19,
    roughMap: { tex: ['smudgeOverlay', { seed: 58311, tileMetres: 0.45 }], extent: [1.1, 0.55] },
    // The old band (-0.18..0.22) against a mid-heavy smudge map put the WHOLE slab around 0.10-0.14
    // roughness — three's transmission path uses roughness to pick the mip LOD on the transmission
    // sampler, so the entire table blurred the rug behind it into a milky wash. This band lands
    // clean glass at ~0.015 (a mirror) and only a real fingerprint softens it, up to 0.06.
    rough: [-0.044, 0.06],
    metal: 0,
    transmission: {
      amount: 1.0, thickness: 0.012, ior: 1.52,
      // Green edge tint: real 12mm low-iron glass is neutral through the face and unmistakably
      // green along a sightline through the thickness. attenuationDistance 0.55 keeps the face
      // (0.012 m path) at ~98% transmittance — invisibly neutral — while an 8mm-plus edge sightline
      // drops well below 60%, which is the arris tell. (Full per-pixel thickness would need a
      // thickness map baked to the merged slab/leg UVs — that is FURN's mesh, not MAT's; this gets
      // the face right and gets the edge close without it.)
      attenuationColour: 0x9fdcc0, attenuationDistance: 0.55,
    },
    // The substitute (see setThinGlass in ./util.js). The same green, the same 12 mm story, but
    // driven by the Schlick term instead of Beer–Lambert through a transmission sample: alpha
    // climbs toward opaque as the sightline flattens, and the green arrives with it. `power` is
    // 4.2 rather than the physical 5 because the camera lives at 42 cm and the slab is 40 cm up,
    // so widening the grazing band slightly is what puts the effect where the game is played.
    thinGlass: B.transmits() ? null : { colour: 0x8ed4b2, gain: 0.88, power: 4.2, tint: 0.55 },
    props: {
      side: B.THREE.FrontSide,
      transparent: !B.transmits(),
      opacity: B.transmits() ? 1.0 : 0.16,
      depthWrite: true,
      specularIntensity: 1.0,
    },
    // NormalBlending multiplies the outgoing radiance by alpha, so at a face-on alpha of 0.16 the
    // reflection has to be authored ~6x hot just to arrive at its real strength. That is what this
    // is, not an art choice: 0.16 x 2.9 lands the pane's reflectivity back where physics puts it.
    envBoost: B.transmits() ? 1.0 : 2.9,
  }),

  /** The full-height glazing. Big, flat, and cheap by design — 5 m of pane is the last thing that
   *  should be holding the transmission pass open, so it only gets it where the budget is off. */
  'glass.window': (B) => makeMaterial(B, {
    physical: true,
    colour: 0xf2f7f6,
    rough: 0.045,
    metal: 0,
    transmission: { amount: 0.95, thickness: 0.004, ior: 1.52, attenuationColour: 0xd6ece0, attenuationDistance: 1.2 },
    props: {
      side: B.THREE.DoubleSide,
      transparent: !B.transmits(),
      opacity: B.transmits() ? 1.0 : 0.14,
      depthWrite: false,
    },
    envBoost: 1.35,
  }),

  /**
   * Matte black anodised aluminium: window mullions, the espresso machine body, the speaker
   * cabinets — one recipe, three very different lighting situations. It was authored as a 2%-albedo
   * full conductor (metal:1, colour 0x26282b), which is physically backwards: real anodising is a
   * thick dyed OXIDE layer over the aluminium, optically a dielectric coating, not bare metal. As a
   * full conductor it has zero diffuse term, so on the espresso machine (lit broadly, not against a
   * bright backdrop) it read as a void, and on the mullions (flanking a much brighter exterior) an
   * unclamped specular response would just mirror the sky at full brightness. A modest metalness
   * with a moderate roughness and a capped specularIntensity solves both at once: a near-black
   * diffuse base carries the body everywhere, and a soft, deliberately unspectacular highlight rides
   * on top of it rather than a mirror reflection of whatever is behind camera.
   */
  'metal.blackAnodised': (B) => makeMaterial(B, {
    tex: 'anodisedBlack',
    colour: 0x121316,
    rough: [0.40, 0.60],
    metal: 0.15,
    normal: 0.5,
    extent: [0.6, 0.6],
    props: { specularIntensity: 0.6, specularColor: 0x9aa0a6 },
    envBoost: 0.62,
  }),

  /** Chrome: the side-table stem, the portafilter, the lamp neck. Near-mirror with fingerprints —
   *  the roughness band bottoms out at 0.04, and the smudges are what stop it looking like a
   *  raytracer test sphere. */
  'metal.chrome': (B) => makeMaterial(B, {
    tex: 'chromeSmudge',
    colour: 0xeef1f3,
    rough: [0.04, 0.24],
    metal: 1,
    normal: 0.5,
    extent: [0.3, 0.3],
    envBoost: 1.25,
  }),

  /** Brass: shelf pins, the lamp collar. Brushed, so the highlight stretches along the grain. */
  'metal.brass': (B) => makeMaterial(B, {
    tex: ['brushedMetal', { colour: 0xc9a24a, baseRough: 0.38 }],
    colour: 0xd0a94f,
    rough: [0.22, 0.50],
    metal: 1,
    normal: 0.8,
    extent: [0.2, 0.2],
    envBoost: 1.15,
  }),

  /**
   * The white column radiator under the glazing. Painted steel is a DIELECTRIC — the metalness
   * channel of the brushed-metal set is deliberately not bound, and metalness drops to 0.04. Paint
   * over metal still shows the substrate's directional micro-scratches through the roughness,
   * which is why this is not just white plaster. `extent` is per-column (39 mm), not the whole
   * radiator face — one tile stretched across all six columns was throwing away all the micro-detail
   * the camera is actually close enough to resolve.
   */
  'metal.steelWhite': (B) => makeMaterial(B, {
    tex: ['brushedMetal', { colour: 0xdedad0, baseRough: 0.45 }],
    colour: 0xe6e2d8,
    rough: [0.26, 0.48],
    metal: 0.04,
    useMetalMap: false,
    normal: 1.0,
    extent: [0.045, 0.060],
  }),

  /** The knitted grille cloth on the bookshelf speakers. Cloth over a cavity, not metal: the AO
   *  is what makes the weave sit *in front of* darkness rather than on a black card. */
  'metal.speakerGrille': (B) => makeMaterial(B, {
    tex: 'speakerCloth',
    physical: true,
    colour: 0x1d1f22,
    rough: [0.78, 0.95],
    metal: 0,
    normal: 1.0,
    ao: 1.0,
    extent: [0.16, 0.16],
    sheen: { amount: 0.25, roughness: 0.8, colour: 0x6b6f76 },
  }),

  /** The tall ridged vase on the shelf. Thick glaze: low roughness plus a clearcoat, so the
   *  highlight has the double-layer look real glaze has (a sharp specular over a soft one). */
  'ceramic.white': (B) => makeMaterial(B, {
    tex: 'ceramicGlaze',
    physical: true,
    colour: 0xf7f4ee,
    rough: [0.06, 0.22],
    normal: 0.55,
    extent: [0.3, 0.3],
    clearcoat: { amount: 0.45, roughness: 0.06 },
    envBoost: 1.1,
  }),

  /** The little mug and bottle: a duller, warmer, cheaper glaze than the vase. */
  'ceramic.glazed': (B) => makeMaterial(B, {
    tex: ['ceramicGlaze', { seed: 8877, colour: 0xe9e4d6, size: 256 }],
    physical: true,
    colour: 0xeae5d8,
    rough: [0.10, 0.30],
    normal: 0.5,
    extent: [0.09, 0.09],
    clearcoat: { amount: 0.32, roughness: 0.1 },
  }),

  /** Unglazed terracotta plant pot: grog speckle, throwing rings, chalky and thirsty-looking. */
  'ceramic.terracotta': (B) => makeMaterial(B, {
    tex: 'terracotta',
    colour: 0xb56943,
    rough: [0.78, 0.94],
    normal: 0.9,
    ao: 0.9,
    extent: [0.28, 0.28],
  }),

  /** The round side table top. Polished marble: clearcoat 0.35 over a low base roughness, and a
   *  very soft normal — polished stone has depth, not relief. */
  'marble.white': (B) => makeMaterial(B, {
    tex: 'marbleWhite',
    physical: true,
    colour: 0xf4f2ed,
    rough: [0.09, 0.26],
    normal: 0.25,
    extent: [0.44, 0.44],
    clearcoat: { amount: 0.35, roughness: 0.06 },
    envBoost: 1.15,
  }),

  /**
   * Saturated moulded toy plastic — stacking cups, rattles, the red box. DRESS tints this per toy.
   * A thin clearcoat is doing real work: injection-moulded ABS has a skin, and without it the toys
   * are the only objects in the room that look like untextured primitives.
   */
  'plastic.toy': (B) => makeMaterial(B, {
    tex: 'plasticMatte',
    physical: true,
    colour: 0xdd5a52,
    rough: [0.28, 0.50],
    normal: 0.55,
    extent: [0.12, 0.12],
    clearcoat: { amount: 0.35, roughness: 0.12 },
  }),

  /** Dark utility plastic: adjusters, buckles, the laptop shell, cable mouldings. */
  'plastic.matte': (B) => makeMaterial(B, {
    tex: ['plasticMatte', { colour: 0x2c2c30 }],
    colour: 0x303035,
    rough: [0.55, 0.78],
    normal: 0.5,
    extent: [0.2, 0.2],
  }),

  /**
   * The teether ring hanging off the playpen rail. Soft, slightly translucent, faintly tacky — a
   * little translucency and a low clearcoat is exactly what medical-grade silicone looks like.
   *
   * It used to ask for `transmission: 0.18`, and that was the single worst-value transmission in
   * the room: the largest object wearing this material is a 30 mm ring, and 0.18 of a framebuffer
   * copy across 30 mm of screen is invisible — yet a visible teether was enough on its own to hold
   * the whole transmission pass open for the frame. The thin-sheet lobe gives a 6 mm rubber section
   * everything it was actually getting (a warm edge where a light is behind it) for no pass at all,
   * and unlike transmission it survives on `medium` and `low` too.
   */
  silicone: (B) => makeMaterial(B, {
    tex: ['plasticMatte', { colour: 0xdfa3b4, seed: 5911 }],
    physical: true,
    colour: 0xe0a6b6,
    rough: [0.48, 0.70],
    normal: 0.45,
    extent: [0.08, 0.08],
    sheen: { amount: 0.3, roughness: 0.8, colour: 0xffdce6 },
    clearcoat: { amount: 0.15, roughness: 0.3 },
    transmission: { amount: 0.18, thickness: 0.004, ior: 1.41, attenuationColour: 0xd98ba0, attenuationDistance: 0.02 },
    // Tight (power 5) and weak: a 6 mm silicone section only lights up when you are looking almost
    // straight through it into a lamp, which is also what keeps this honest on DRESS's black
    // `silicone~24242a` speaker surround — at that lobe width it is a faint edge, not a pink wash.
    translucency: B.transmits() ? null : { colour: 0xffc9d4, strength: 0.25, power: 5.0, ambient: 0.10 },
  }),

  /**
   * The orange foil crisp bag on the rug — the most fun material in the room and the one the baby
   * wants most. The generator gives it a piecewise-planar Voronoi facet field with hard creases;
   * the material's job is to keep metalness high (0.95 over a 0.72–1.0 map, so the ink-printed
   * areas stay slightly less metallic than the scuffed bare-metal ridges) and the roughness band
   * tight at 0.25–0.50 so every facet flips between a glint and a dull plane as the camera moves.
   * normalScale 1.5 on top of the generator's 2.4: it should crinkle almost cartoonishly.
   */
  'foil.snack': (B) => makeMaterial(B, {
    tex: 'foilCrinkle',
    colour: 0xdd8926,
    rough: [0.25, 0.50],
    metal: 0.95,
    normal: 1.5,
    ao: 0.85,
    extent: [0.22, 0.3],
    envBoost: 1.35,
  }),
};
