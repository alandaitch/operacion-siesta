// OPERATION NAPTIME — module MAT — print, foliage, characters, screens, the world outside.
//
// Three things in this file are doing more work than they look like they are:
//
//  · leaf.monstera and leaf.small are lanterns. A backlit monstera blade goes acid green while its
//    veins go black, and that single effect is what stops houseplants in a real-time render looking
//    like green cardboard. On `ultra` that is real transmission; on every other tier the
//    transmission budget in ../materials.js swaps it for the thin-sheet lobe, which is the same
//    optical story (light in the back, out the front, tinted by what it passed through) for a few
//    ALU instead of a second full-resolution render of the entire scene.
//  · skin.baby gets three separate translucency cues: a warm sheen for the peach fuzz, a
//    view-facing subsurface rim injected into the shader, and — on `ultra` only — a whisper of real
//    transmission driven by the generator's thickness map (bright = thin = ears and fingers).
//    Roughness sits at 0.45–0.62 with a 0.06 clearcoat: baby skin is soft, slightly wet-looking,
//    and never plastic.
//  · card.print is an ATLAS of eight book spines. `materials.atlas('card.print')` hands DRESS the
//    uvFor(i) helper, and `materials.tinted('card.print', hex, { uvOffset, uvRepeat })` produces a
//    per-book variant that shares the same GPU upload.

import { makeMaterial } from './util.js';

/**
 * A cheap "hot core, dim shoulder" falloff for a small emissive envelope (the bare bulb): the
 * object-space radius from the vertical axis drives an exponent on totalEmissiveRadiance so the
 * silhouette is not a flat glowing slab. Object-space rather than world/view space so it stays
 * correct regardless of camera and is fully deterministic for photo mode.
 */
function applyRadialEmissiveFalloff(mat, THREE, radius, edgeFactor = 0.12, power = 1.6) {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
	totalEmissiveRadiance *= mix( ${edgeFactor.toFixed(4)}, 1.0, pow( 1.0 - clamp( length( vObjPos.xz ) / ${radius.toFixed(4)}, 0.0, 1.0 ), ${power.toFixed(4)} ) );`,
      );
  };
  mat.customProgramCacheKey = () => `radialEmissive_${radius}_${edgeFactor}_${power}`;
  return mat;
}

export const PRINT = {
  /** Uncoated book board. Matte, fibrous, and slightly yellowed. */
  'paper.book': (B) => makeMaterial(B, {
    tex: 'paperCover',
    colour: 0xeae3d4,
    rough: [0.72, 0.92],
    normal: 0.6,
    extent: [0.2, 0.2],
  }),

  /** Book block / loose pages. Double-sided, because a board book lies open on the rug. */
  'paper.page': (B) => makeMaterial(B, {
    tex: ['paperCover', { seed: 41077, colour: 0xf4f0e6 }],
    colour: 0xf5f1e7,
    rough: [0.78, 0.95],
    normal: 0.5,
    extent: [0.21, 0.21],
    props: { side: B.THREE.DoubleSide },
  }),

  /** Magazines in the shelving cube. Coated stock: low roughness plus a clearcoat is what makes
   *  the pile catch the window as a stack of hard little highlights. */
  'paper.magazine': (B) => makeMaterial(B, {
    tex: 'magazineCover',
    physical: true,
    colour: 0xf2efe8,
    rough: [0.16, 0.34],
    normal: 0.3,
    repeat: [1, 1],
    clearcoat: { amount: 0.25, roughness: 0.08 },
    envBoost: 1.05,
  }),

  /** The book-spine atlas: eight spines in one texture. See the header note. */
  'card.print': (B) => makeMaterial(B, {
    tex: 'printedSpine',
    colour: 0xece7dd,
    rough: [0.68, 0.90],
    normal: 0.7,
    repeat: [1, 1],
  }),

  /** A record face. Vinyl is a lacquer: low roughness, a clearcoat, and the concentric groove
   *  normal that turns a point light into the long arc of anisotropic sheen you get on a record. */
  'vinyl.black': (B) => makeMaterial(B, {
    tex: 'vinylGrooves',
    physical: true,
    colour: 0xdedbd6,
    rough: [0.12, 0.32],
    normal: 0.9,
    repeat: [1, 1],
    clearcoat: { amount: 0.5, roughness: 0.05 },
    envBoost: 1.2,
  }),

  /** The record sleeve: uncoated board, ring wear where the disc has sat for years. */
  'vinyl.sleeve': (B) => makeMaterial(B, {
    tex: 'vinylSleeve',
    colour: 0xe4ded2,
    rough: [0.52, 0.76],
    normal: 0.5,
    repeat: [1, 1],
  }),

  /** The leaning abstract canvas: yellow wedge, magenta blob, visible weave, matte acrylic. */
  'art.canvas': (B) => makeMaterial(B, {
    tex: 'abstractArtwork',
    colour: 0xf0ece2,
    rough: [0.70, 0.90],
    normal: 0.7,
    repeat: [1, 1],
  }),
};

export const NATURE = {
  /**
   * Monstera. Double-sided (you crawl under it), a real alphaMap carrying the fenestrations and
   * the edge splits, a waxy sheen on the top surface, and transmission so a backlit leaf glows.
   * alphaTest rather than blending — nine leaves blending against each other would sort wrong and
   * the fenestrations must be genuine holes, not soft ones.
   */
  'leaf.monstera': (B) => makeMaterial(B, {
    tex: 'leafMonstera',
    physical: true,
    colour: 0x8fbf7e,
    rough: [0.32, 0.55],
    normal: 1.0,
    repeat: [1, 1],
    alpha: true,
    sheen: { amount: 0.5, roughness: 0.35, colour: 0xe6f3c8 },
    // thickness:attenuationDistance used to be a 0.1 ratio — Beer-Lambert transmittance at that
    // ratio is ~1.0, i.e. no attenuation at all, so a backlit leaf just went flat white instead of
    // luminous green with dark veins. Both numbers now actually produce visible absorption.
    transmission: {
      amount: 0.22, thickness: 0.0012, ior: 1.42,
      attenuationColour: 0x3f7a26, attenuationDistance: 0.0009,
    },
    // Below `ultra` the transmission budget takes that away, and it is no loss here: nine
    // DoubleSide blades were each triggering the transmission target's second resolve and mip
    // regeneration, to buy 0.22 of a blurred framebuffer copy across a 0.3 mm leaf. What a backlit
    // leaf actually is, is a lantern — a thin blade with the sun on the far side, glowing the
    // yellow-green that survives a pass through chlorophyll while the veins stay dark. That is
    // precisely the thin-sheet lobe, and it does it per light and inside the shadow test.
    //
    // The strength is small (0.14, not the 1.0 the first pass guessed) because it lands on top of
    // a blade the sun is already hitting square from behind, so `bl` and `fwd` are both near 1
    // over most of the visible leaf — measured, 0.42 brightened a backlit blade by 47%. Note also
    // that the transmission it replaces was a strongly ABSORBING one (thickness 0.0012 against an
    // attenuation distance of 0.0009 is ~26% transmittance), so dropping it lifts the blade on its
    // own. The obvious counterweight — darkening this albedo — does nothing: DRESS builds every
    // blade with `tinted('leaf.monstera', <its own hex>)`, which replaces this colour outright.
    translucency: B.transmits() ? null : { colour: 0x9ecf62, strength: 0.14, power: 2.6, ambient: 0.14 },
    props: {
      side: B.THREE.DoubleSide, alphaTest: 0.35, depthWrite: true,
      // MSAA coverage on the cutout edge instead of a hard binary test — softens the fenestration
      // staircase without needing to blend (which would sort badly against the other leaves).
      alphaToCoverage: true,
    },
  }),

  /** The second plant and the balcony planter: smaller, darker, same lantern trick. */
  'leaf.small': (B) => makeMaterial(B, {
    tex: 'leafSmall',
    physical: true,
    colour: 0x8ab87a,
    rough: [0.36, 0.60],
    normal: 1.0,
    repeat: [1, 1],
    alpha: true,
    sheen: { amount: 0.4, roughness: 0.4, colour: 0xdaeebc },
    transmission: {
      amount: 0.25, thickness: 0.0003, ior: 1.42,
      attenuationColour: 0x477f30, attenuationDistance: 0.004,
    },
    translucency: B.transmits() ? null : { colour: 0x93c65b, strength: 0.13, power: 2.8, ambient: 0.14 },
    props: { side: B.THREE.DoubleSide, alphaTest: 0.4, depthWrite: true },
  }),

  /** Potting compost: clumps, perlite specks, and full baked AO so the surface reads as loose. */
  soil: (B) => makeMaterial(B, {
    tex: 'soil',
    colour: 0x4b3a2c,
    rough: [0.88, 0.97],
    normal: 1.2,
    ao: 1.0,
    extent: [0.24, 0.24],
  }),

  /** Bark for the bare winter trees beyond the glazing and for the thicker plant stems. */
  bark: (B) => makeMaterial(B, {
    tex: 'bark',
    colour: 0x5a5044,
    rough: [0.85, 0.96],
    normal: 1.3,
    ao: 1.0,
    extent: [0.35, 0.7],
  }),
};

export const CHARACTERS = {
  /** Ten-month-old skin. See the header note — three translucency cues, none of them expensive. */
  'skin.baby': (B) => {
    const set = B.set('babySkin');
    return makeMaterial(B, {
      texSet: set,
      physical: true,
      colour: 0xf4cdb2,
      rough: [0.52, 0.74],
      normal: 0.75,
      // 0.45 m tiled the pore/fuzz detail over more than double a baby's skull — less than half a
      // tile was ever visible, so the crown rendered as a glazed egg. 0.055 m puts a tile roughly
      // every 5.5 cm, which resolves at the ~60 cm the camera actually gets to the face.
      extent: [0.055, 0.055],
      sheen: { amount: 0.35, roughness: 0.75, colour: 0xffd8bd },
      clearcoat: { amount: 0.02, roughness: 0.42 },
      // 0.06 of transmission is under the threshold of visibility on skin — the ear-and-finger
      // translucency people actually see is the `sss` rim below, and always was. But 0.06 was
      // enough to make a baby who is on screen in every single frame of a third-person shot hold
      // the transmission pass open by himself, so the budget takes it below `ultra` and `sss` gets
      // the 0.04 back (0.14 → 0.18). The thicknessMap goes with it: it only feeds transmission.
      transmission: {
        amount: 0.06, thickness: 0.006, ior: 1.4,
        attenuationColour: 0xc9553a, attenuationDistance: 0.012,
      },
      // Desaturated hard and gated by light direction now (see util.js) — the old version was a
      // strong, colour-saturated, always-on rim that flooded every mid-tone regardless of the key.
      // NOTE: this rim had never actually reached a shader until the anchor bug documented in
      // util.js was fixed, so it is now live for the first time. Raising it to compensate for the
      // transmission the budget takes away was the obvious move and was measured instead: the
      // `babyFace` frame is byte-identical with this term at 0.16 and at 0, because `wrap` and
      // `back` only overlap in a narrow band and the baby is already sitting at p90 = 234 in that
      // framing. So it stays at its authored value and the blown-out baby stays BABY's blocker.
      sss: { colour: 0xc98a72, strength: 0.14, power: 3.4 },
      props: B.transmits() ? { thicknessMap: set.thicknessMap } : {},
    });
  },

  /** The parent. Adult skin: coarser, less translucent, a touch more oil on the forehead. */
  'skin.parent': (B) => makeMaterial(B, {
    tex: ['babySkin', { seed: 53099, colour: 0xe6b894, tileMetres: 0.12, size: 256 }],
    physical: true,
    colour: 0xe8bc99,
    rough: [0.42, 0.66],
    normal: 0.8,
    extent: [1.6, 1.6],
    sheen: { amount: 0.2, roughness: 0.8, colour: 0xffd2b4 },
    clearcoat: { amount: 0.05, roughness: 0.5 },
    sss: { colour: 0xc25f42, strength: 0.24, power: 3.0 },
  }),

  /**
   * Baby hair: fine, wispy, and sparse. The alpha is dense at the root and breaks into individual
   * strands at the tips, so on a scalp dome it reads as thin hair with skin showing through —
   * which is what a ten-month-old actually has — and on a card it reads as strands. High sheen
   * with a tight sheenRoughness gives the long specular streak hair has and diffuse alone cannot.
   */
  'hair.baby': (B) => makeMaterial(B, {
    texSet: B.gen('hairStrands', { seed: 61061, colour: 0x8a6242, density: 0.7 }),
    physical: true,
    colour: 0x8d6746,
    rough: [0.30, 0.58],
    normal: 1.2,
    extent: [0.16, 0.16],
    alpha: true,
    sheen: { amount: 0.9, roughness: 0.25, colour: 0xf0d7ae },
    props: { side: B.THREE.DoubleSide, alphaTest: 0.3, depthWrite: true },
  }),

  /** The parent's hair: darker, denser, coarser strands. */
  'hair.parent': (B) => makeMaterial(B, {
    texSet: B.gen('hairStrands', { seed: 61411, colour: 0x2f2620, density: 0.95, strands: 60 }),
    physical: true,
    colour: 0x33291f,
    rough: [0.26, 0.52],
    normal: 1.1,
    extent: [0.2, 0.2],
    alpha: true,
    sheen: { amount: 0.75, roughness: 0.22, colour: 0xb08a5e },
    props: { side: B.THREE.DoubleSide, alphaTest: 0.35, depthWrite: true },
  }),

  /** The onesie: soft washed cotton, oatmeal, a little bobbled. */
  'cloth.onesie': (B) => makeMaterial(B, {
    tex: ['twillCotton', { colour: 0xdcd6c8, seed: 33077, size: 256 }],
    physical: true,
    colour: 0xded8ca,
    rough: [0.72, 0.92],
    normal: 0.95,
    extent: [0.4, 0.4],
    sheen: { amount: 0.3, roughness: 0.7, colour: 0xfff4e2 },
  }),

  /** The nappy. Crinkled non-woven face over a polyethylene backsheet — hence the thin clearcoat,
   *  which is the only reason it reads as a nappy and not as a small white cushion. */
  'cloth.diaper': (B) => makeMaterial(B, {
    tex: ['muslinCrinkle', { colour: 0xf7f5f2, seed: 31077, size: 256 }],
    physical: true,
    colour: 0xf8f6f3,
    rough: [0.58, 0.82],
    normal: 1.0,
    ao: 0.9,
    extent: [0.3, 0.3],
    sheen: { amount: 0.35, roughness: 0.6, colour: 0xfffdf8 },
    clearcoat: { amount: 0.12, roughness: 0.4 },
  }),

  /**
   * The parent's top: dark slate cotton. extent used to be 1.6 m — twillCotton is authored at a
   * 0.08 m design scale, so the weave sat 20x past its own resolution and never resolved to
   * anything but a flat slab. Matched to the generator's real tile now, so the thread structure the
   * sheen term needs to modulate is actually there.
   */
  'cloth.parent': (B) => makeMaterial(B, {
    tex: ['twillCotton', { colour: 0x394452 }],
    physical: true,
    colour: 0x4a5768,
    rough: [0.74, 0.92],
    normal: 1.15,
    extent: [0.11, 0.11],
    sheen: { amount: 0.35, roughness: 0.68, colour: 0x9aa7b6 },
  }),

  /**
   * The eyeball. One material for sclera and iris — BABY and AI tint it per part
   * (`materials.tinted('eye', 0x4a3526, { roughness: 0.1 })` for the iris). Clearcoat 1.0 with a
   * near-zero clearcoatRoughness is the cornea: a wet, hard, tiny highlight. An eye without that
   * second specular layer is the fastest way to make a character look dead.
   */
  eye: (B) => makeMaterial(B, {
    physical: true,
    colour: 0xf1ebe1,
    rough: 0.19,
    metal: 0,
    clearcoat: { amount: 1.0, roughness: 0.03 },
    envBoost: 1.3,
  }),
};

export const TECH = {
  /**
   * The laptop on the sofa, lid half open, screen on. The generated UI map doubles as the
   * emissiveMap so only the glyph rows glow; the panel itself stays a dark dielectric with a
   * clearcoat, which is what makes a screen read as glass with an image behind it rather than as
   * a glowing sticker.
   */
  'screen.laptop': (B) => {
    const ui = B.gen('laptopUI', {});
    const mat = makeMaterial(B, {
      texSet: ui,
      physical: true,
      rough: [0.06, 0.20],
      normal: 0.2,
      repeat: [1, 1],
      clearcoat: { amount: 0.55, roughness: 0.04 },
      props: {
        emissive: 0xdfe9f7,
        emissiveIntensity: B.tier === 'low' ? 1.15 : 1.35,
      },
      envBoost: 0.9,
    });
    // The same texture bound twice: albedo for the dark chrome, emissive for the glyph rows. One
    // upload, and the panel only glows where there is actually something on it.
    mat.emissiveMap = mat.map;
    return mat;
  },

  /** A screen that is off: near-black glass that still shows fingerprints and the room's
   *  reflection. The smudge roughness variation is the whole point — a uniform dark panel is
   *  invisible, a smudged one reads instantly as a phone or a sleeping monitor. */
  'screen.off': (B) => makeMaterial(B, {
    tex: 'chromeSmudge',
    physical: true,
    colour: 0x14171b,
    rough: [0.05, 0.24],
    metal: 0.02,
    useMetalMap: false,
    normal: 0.3,
    extent: [0.3, 0.2],
    clearcoat: { amount: 0.5, roughness: 0.05 },
    envBoost: 1.2,
  }),

  /**
   * The bare E27 on its black cord. Emissive intensity in linear against the composer's 0.72 bloom
   * threshold: it blooms into a small hot point without dragging the exposure down, which is
   * exactly the relationship the reference photo has — the practicals are ON but weak next to
   * daylight. `transmission` used to be the "reads brighter on the filament side" mechanism, but it
   * composites the backdrop (frequently the bright sheer curtain) OVER the emissive and flattens it
   * to a grey disc instead — dropped in favour of alpha + a real radial hot-core falloff so the
   * silhouette itself carries the gradient.
   */
  'emissive.bulb': (B) => {
    const mat = makeMaterial(B, {
      physical: true,
      colour: 0xf8eeda,
      rough: 0.10,
      metal: 0,
      props: {
        emissive: 0xffc078,
        emissiveIntensity: B.tier === 'low' ? 22 : 30,
        transparent: true,
        opacity: 0.66,
        depthWrite: false,
        side: B.THREE.FrontSide,
      },
      envBoost: 0.6,
    });
    applyRadialEmissiveFalloff(mat, B.THREE, 0.0301, 0.12, 1.6);
    return mat;
  },

  /**
   * The floor lamp's dome, lit from inside: the fabric both glows and passes light, so the shade
   * has a bright rim at the mouth and a softer body. It measured as neutral-to-blue and barely
   * brighter than the wall behind it — inverting the brief's cool-daylight/warm-practical split on
   * the one object meant to carry the warm end. Intensity and colour temperature (2700K) both
   * raised hard, and the emissive reuses the crinkle map itself (like screen.laptop's UI trick) so
   * the muslin weave actually shows in the glow instead of the shade being a flat lit disc.
   */
  'emissive.lampshade': (B) => {
    const real = B.transmits();
    const mat = makeMaterial(B, {
      tex: ['muslinCrinkle', { seed: 31099, colour: 0xf6ecd9, tileMetres: 0.2 }],
      physical: true,
      colour: 0xf9f0dd,
      rough: [0.60, 0.85],
      normal: 1.5,
      extent: [3.2, 0.9],
      sheen: { amount: 0.4, roughness: real ? 0.6 : 0.78, colour: 0xfff2da },
      transmission: { amount: 0.45, thickness: 0.0035, ior: 1.35, attenuationColour: 0xffd9a2, attenuationDistance: 0.022 },
      // A dome with the bulb inside it is the textbook case for the thin-sheet lobe and a poor one
      // for transmission: what is behind this shade is the room the lamp is lighting, not something
      // worth refracting, and being DoubleSide it was paying the transmission target's second
      // resolve for the privilege. `lamp`, `lampUp` and `lampDown` are point lights *inside* the
      // dome, so dot(-N, L) is ~1 across the whole shell and the lobe lights it evenly, warm and
      // brightest at the mouth where the section is thinnest to the eye.
      translucency: real ? null : { colour: 0xffcf93, strength: 0.10, power: 1.8, ambient: 0.12 },
      props: {
        side: B.THREE.DoubleSide,
        emissive: 0xffb268,
        emissiveIntensity: B.tier === 'low' ? 3.4 : (real ? 4.5 : 4.05),
      },
      envBoost: 0.7,
    });
    mat.emissiveMap = mat.map;
    return mat;
  },
};

export const EXTERIOR = {
  /** The red-brick building a few metres beyond the balcony. Seen through glass and out of focus,
   *  so it is generated small — but the running bond and the recessed mortar still have to read,
   *  because that terracotta is one of only two accent colours in the whole palette. */
  'brick.exterior': (B) => makeMaterial(B, {
    tex: 'brickExterior',
    colour: 0xa8674c,
    rough: [0.82, 0.95],
    normal: 1.0,
    ao: 0.9,
    extent: [9, 12],
  }),

  /** Balcony planter greenery and the scrappy foliage on the bare winter trees. */
  'foliage.tree': (B) => makeMaterial(B, {
    tex: ['leafSmall', { seed: 52552, colour: 0x2f5a2c }],
    physical: true,
    colour: 0x6f9463,
    rough: [0.45, 0.70],
    normal: 0.9,
    repeat: [1, 1],
    alpha: true,
    sheen: { amount: 0.25, roughness: 0.5, colour: 0xc8dca8 },
    props: { side: B.THREE.DoubleSide, alphaTest: 0.4 },
  }),

  /**
   * The sky. Unlit, backfaced, depth-write off — it is a backdrop, not a surface. The colour
   * multiplier runs above 1.0 in linear so the horizon haze actually crosses the bloom threshold;
   * a sky clamped at 1.0 always reads as a painted card taped behind the window.
   */
  'sky.backdrop': (B) => {
    const sky = B.gen('skyGradient', { sunHeight: 0.34 });
    const mat = new B.THREE.MeshBasicMaterial({
      map: sky.map,
      side: B.THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    mat.color.setRGB(1.5, 1.44, 1.36);
    mat.userData.noEnv = true;
    mat.userData.envBoost = 0;
    return mat;
  },

  /** The neighbours' windows. Dark, hard, reflective — no transmission at all: you are never
   *  meant to see into them, only to see the sky bend across them. */
  'glass.exterior': (B) => makeMaterial(B, {
    tex: 'smudgeOverlay',
    colour: 0x1e2a36,
    rough: [0.05, 0.26],
    metal: 0.08,
    normal: 0.3,
    extent: [1.2, 1.6],
    envBoost: 1.4,
  }),
};
