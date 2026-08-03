// LIGHT · the daylight model — one number in, a whole hour of Buenos Aires winter out.
//
// `t` runs 0 → 1 across 16:30 → 18:45. At 0 the sun is 15.5° up and rakes long hard rectangles
// across the floor; at 1 it is 3° *below* the horizon, the sky has gone indigo, and the only
// things left burning are the floor lamp and the bare bulb. Everything else in this module is
// keyframed against that one parameter: sun elevation and azimuth, colour temperature, the four
// colours of the sky gradient, the strength of the window softbox and the rug bounce, fog, the
// exposure the grade should be riding, and how loud the practicals are relative to daylight.
//
// Two details worth knowing:
//  · Colours are keyed as sRGB hex but interpolated in *linear* working space (THREE.Color does
//    the conversion on setHex), because lerping a sunset in gamma space goes muddy in the middle.
//  · The sun's own colour comes from a blackbody fit, then is normalised to luminance 1 so that
//    `sunIntensity` is the only brightness control. Changing the temperature never changes the
//    exposure, which is what you want when the timer is dragging the sun down mid-round.

import * as THREE from 'three';

const DEG = Math.PI / 180;
export const HOUR_START = 16.5;
export const HOUR_END = 18.75;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, k) => a + (b - a) * k;

/**
 * Keyframes. `elev`/`azim` in degrees — azimuth 0 means straight in through the glazing along -Z,
 * negative puts the sun toward -X, which is where the street opens up past the neighbours' brick
 * flank. Intensities are in the artistic scale the whole project uses: the ACES grade sits near
 * exposure 1.0 with the key around 3.5.
 */
// r06 art review (26 LIGHT findings): the room reads as an unlit CAD model because almost every
// shot's energy sits in the non-directional terms (the window RectAreaLight, which cannot cast a
// shadow, plus the hemisphere/env ambient) and too little sits in the shadow-casting sun. Several
// passes at fixing this while keeping the room's colour temperature honest did NOT work, and each
// is worth recording so the next pass does not repeat it:
//   1. sun x1.35, win x0.62, bounce x1.15, hemi x0.60, env x0.68 — fixed contrast, immediately
//      broke colour temperature: it moved energy OUT of the two relatively cool terms (window,
//      hemisphere) and INTO the two relatively warm ones (the sun's blackbody, the rug bounce).
//   2. sun x1.15 (kelvin +400K to compensate), win x0.85 (kelvin +300K), bounce x0.60, hemi x0.85,
//      env x0.75 — cooled the *light sources* correctly (verified numerically: sun R:B 1.19,
//      window R:B 0.92 at t=0.44, both reasonable), but `hero` still measured R:B 1.516 on
//      histogram.mjs, worse than the r06 baseline (1.326) it was meant to fix.
//   3. sun reverted to x1.00 (its original magnitude, on the theory that boosting the *strongest*
//      light's absolute magnitude was amplifying the room's warm albedo even with a near-neutral
//      light colour), contrast held via *cutting the ambient* instead (win x0.95, hemi x0.80,
//      env x0.75). REFUTED by render: with everything else held, reverting the sun alone moved
//      `hero` from 1.516 to 1.527 — a change in the wrong direction and inside measurement noise.
//      The "boosted key amplifies warm albedo" story cannot be the (main) mechanism, because the
//      thing it says to undo did nothing when undone.
//
// Pass 4 (current, this session) started from a cheaper question: does the *light budget itself*
// even carry the warmth, or does it arrive somewhere else in the pipeline? `evaluate()` is pure,
// so summing intensity×colour per source at hero's render time (t≈0.444, the DEFAULT_TIME photo
// mode actually freezes on) is arithmetic, not a render:
//   pass-3 budget:  sun R:B 1.19 (i 3.16) · win 0.92 (i 2.08) · bounce 1.73 (i 0.50)
//                   · hemi 0.81 (i 0.24) · env 0.38 (i 0.76)  →  aggregate R:B ≈ 1.06
// That average is close to neutral — nowhere near the 1.5+ the rendered PNGs show. Cutting the
// (cool) ambient in pass 3 barely moved this number either (r06-reconstructed aggregate ≈ 1.07 →
// pass-3 ≈ 1.06), which matches pass 3's near-zero measured effect on `hero` and confirms the
// diagnostic is trustworthy. The ~0.4–0.5 gap between "budget says ~1.06" and "render says ~1.5"
// has to be closing somewhere downstream of this file: the room's own materials are warm by
// design (REFERENCE: cream/oatmeal, birch, warm mid-brown floor — none of it owned by LIGHT) and/
// or however postfx.js's ACES operator treats saturation in the mid-tones. Neither is a light-
// colour bug.
//
// Pass 4 changes (hue/composition only, zero change to shadow-casting geometry or overall
// exposure, so the contact-shadow and contrast work from earlier passes is untouched):
//   · sun kelvin pushed further cool at the three "daylight" keys (t 0/0.35/0.62 — the golden-hour
//     keys past t=0.62 are left warm on purpose, that is the sunset arc REFERENCE wants).
//   · hemi/env recomposed, not just re-scaled: hemi (flat, normal-only wash — literally the "unlit
//     CAD model" ambient r06 flagged) cut harder, env (direction-aware IBL baked from the actual
//     room probe, and by far the coolest term measured: R:B 0.38) restored more, while keeping
//     hemi+env's *total* within ~3% of pass 3's already-cut level so the contrast gain is not
//     spent back.
//   · bounce's colour (not its intensity, which pass 3 already found governs the ottoman's near-
//     field problem, not hero's) pulled ~30% toward white at the daylight keys.
//   · the interior god-ray shaft's blend toward `haze` cut from 0.30 to 0.14 — the shaft is an
//     additive screen-space veil with no albedo to filter it, so it lands in the framebuffer close
//     to its authored hue; `haze` itself (the sky gradient's warm horizon band) is left alone
//     because it is also the exterior backdrop colour seen through the glazing, and REFERENCE
//     wants that warm.
// Measured (tools/shoot.mjs --round L4b, ultra, 1600×900): hero 1.527 → 1.496, ottoman 1.750 →
// 1.724, ceiling 1.289 → 1.264, sofa 1.210 → 1.194, armchair 1.292 → 1.255. Every shot moved
// cooler, none moved warmer, and luminance histograms (mean/median/percentiles/clip%) are
// unchanged to within noise before vs after — the contrast gain is intact. But the move is small
// (~0.02–0.04 per shot) despite hitting every source's hue at once, which is itself the finding:
// light colour has been pushed about as far as pass 1–3's colour-temperature story allows without
// contradicting REFERENCE's explicit "cool daylight / warm bounce / warm practicals" split (sun is
// now R:B 1.06, already close to window's 0.92), and it is not the lever that closes the
// remaining ~0.4 gap to the 1.05–1.20 target. That gap most plausibly lives in the room's material
// albedo (MAT-owned) and/or the ACES grade (RENDER-owned, postfx.js) — outside this file's reach.
// Re-shot and verified this session (2 rounds of tools/shoot.mjs, both spent — see the LIGHT
// handoff report for the frontier and next steps).
const KEYS = [
  {
    t: 0.00, elev: 15.5, azim: -21, kelvin: 7150,
    sun: 3.55, win: 2.57, winK: 7800, bounce: 0.58, hemi: 0.19, env: 0.97,
    practical: 0.16, exposure: 1.00, fogD: 0.023, shaft: 0.50,
    zenith: 0x7f9dc0, horizon: 0xc6d3dd, haze: 0xf0ead9, ground: 0x4b443a, city: 0x8d5f4c,
    skyGain: 3.10, disc: 55, fog: 0xb6c4d1, bounceC: 0xfff2e6, hemiG: 0x9c9a96,
  },
  {
    t: 0.35, elev: 10.4, azim: -26, kelvin: 6700,
    sun: 3.30, win: 2.23, winK: 7100, bounce: 0.53, hemi: 0.17, env: 0.90,
    practical: 0.28, exposure: 1.03, fogD: 0.026, shaft: 0.72,
    zenith: 0x7793b8, horizon: 0xcdd2d4, haze: 0xf3e5cd, ground: 0x463f36, city: 0x8f5f4a,
    skyGain: 2.70, disc: 48, fog: 0xb8c0c6, bounceC: 0xffeedf, hemiG: 0x9b9791,
  },
  {
    t: 0.62, elev: 5.2, azim: -32, kelvin: 5500,
    sun: 2.72, win: 1.60, winK: 6200, bounce: 0.41, hemi: 0.15, env: 0.75,
    practical: 0.50, exposure: 1.10, fogD: 0.030, shaft: 1.00,
    zenith: 0x63799f, horizon: 0xd8c39c, haze: 0xffcf92, ground: 0x3b342d, city: 0x9a5c40,
    skyGain: 1.90, disc: 34, fog: 0xbaa88c, bounceC: 0xffe1c1, hemiG: 0x9a8e82,
  },
  {
    t: 0.82, elev: 1.2, azim: -37, kelvin: 3150,
    sun: 1.25, win: 0.93, winK: 5100, bounce: 0.22, hemi: 0.12, env: 0.54,
    practical: 0.76, exposure: 1.24, fogD: 0.034, shaft: 0.58,
    zenith: 0x4a5a8a, horizon: 0xd2a074, haze: 0xff9d5c, ground: 0x2b2620, city: 0x8a4a34,
    skyGain: 1.15, disc: 14, fog: 0xa4826c, bounceC: 0xffc494, hemiG: 0x937a5f,
  },
  {
    t: 0.93, elev: -1.4, azim: -40, kelvin: 2700,
    sun: 0.22, win: 0.53, winK: 7700, bounce: 0.09, hemi: 0.12, env: 0.42,
    practical: 0.91, exposure: 1.40, fogD: 0.036, shaft: 0.10,
    zenith: 0x33406f, horizon: 0x9a7a80, haze: 0xd8785e, ground: 0x1e1a18, city: 0x5f3730,
    skyGain: 0.72, disc: 3.0, fog: 0x6b6070, bounceC: 0xffc7a0, hemiG: 0x77644e,
  },
  {
    t: 1.00, elev: -3.2, azim: -42, kelvin: 2450,
    sun: 0.03, win: 0.33, winK: 9500, bounce: 0.06, hemi: 0.10, env: 0.35,
    practical: 1.00, exposure: 1.55, fogD: 0.038, shaft: 0.00,
    zenith: 0x222c56, horizon: 0x5c5570, haze: 0x7d5f66, ground: 0x151316, city: 0x40292a,
    skyGain: 0.50, disc: 0.4, fog: 0x4a4860, bounceC: 0xffcdac, hemiG: 0x655645,
  },
];

/** Prebuilt linear-space colours, one set per keyframe, so evaluate() never allocates. */
const COLOUR_SLOTS = ['zenith', 'horizon', 'haze', 'ground', 'city', 'fog', 'bounceC', 'hemiG'];
const KEY_COLOURS = KEYS.map((k) => {
  const o = {};
  for (const slot of COLOUR_SLOTS) o[slot] = new THREE.Color().setHex(k[slot], THREE.SRGBColorSpace);
  return o;
});

/**
 * Blackbody fit (Tanner Helland's piecewise approximation), converted to the linear working
 * space and normalised to luminance 1. Cached, because we only ever ask for a handful of values.
 */
const kelvinCache = new Map();
export function kelvinColour(K, out = new THREE.Color()) {
  const key = Math.round(K / 25) * 25;
  let hit = kelvinCache.get(key);
  if (!hit) {
    const t = Math.min(40000, Math.max(1000, key)) / 100;
    let r;
    let g;
    let b;
    if (t <= 66) {
      r = 255;
      g = 99.4708025861 * Math.log(t) - 161.1195681661;
      b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    } else {
      r = 329.698727446 * (t - 60) ** -0.1332047592;
      g = 288.1221695283 * (t - 60) ** -0.0755148492;
      b = 255;
    }
    const c = new THREE.Color();
    const q = (v) => Math.min(1, Math.max(0, v / 255));
    // setRGB with an explicit sRGB space runs the transfer function for us.
    c.setRGB(q(r), q(g), q(b), THREE.SRGBColorSpace);
    const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    if (lum > 1e-4) c.multiplyScalar(1 / lum);
    hit = c;
    kelvinCache.set(key, hit);
  }
  return out.copy(hit);
}

/** Accepts 0..1, or an hour-of-day like 17.75, and returns the normalised parameter. */
export function normaliseTime(t) {
  if (!Number.isFinite(t)) return 0;
  const v = t > 1.5 ? (t - HOUR_START) / (HOUR_END - HOUR_START) : t;
  return clamp01(v);
}

/** 16:30 … 18:45, for the debug overlay only — never shown to the player. */
export function clockLabel(t) {
  const h = HOUR_START + normaliseTime(t) * (HOUR_END - HOUR_START);
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(mm === 60 ? hh + 1 : hh).padStart(2, '0')}:${String(mm === 60 ? 0 : mm).padStart(2, '0')}`;
}

/** A fresh, fully-allocated state object. LIGHT keeps exactly one and refills it every change. */
export function createDaylightState() {
  return {
    t: 0,
    hours: HOUR_START,
    elevation: 0,
    azimuth: 0,
    sunAboveHorizon: true,
    sunDir: new THREE.Vector3(0, 1, 0),
    sunColour: new THREE.Color(1, 1, 1),
    sunIntensity: 0,
    skyZenith: new THREE.Color(),
    skyHorizon: new THREE.Color(),
    skyHaze: new THREE.Color(),
    skyGround: new THREE.Color(),
    skyCity: new THREE.Color(),
    skyGain: 1,
    sunDisc: 0,
    windowColour: new THREE.Color(),
    windowIntensity: 0,
    bounceColour: new THREE.Color(),
    bounceIntensity: 0,
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    hemiIntensity: 0,
    envIntensity: 1,
    exposure: 1,
    practical: 0,
    lampColour: new THREE.Color(),
    bulbColour: new THREE.Color(),
    lampIntensity: 0,
    bulbIntensity: 0,
    fogColour: new THREE.Color(),
    fogDensity: 0,
    shaftColour: new THREE.Color(),
    shaftIntensity: 0,
  };
}

const _tmp = new THREE.Color();

/**
 * Fill `out` for the given time. Pure: same `t` in, same numbers out, every run.
 * @param {number} t01 0..1 (or an hour, see normaliseTime)
 * @param {ReturnType<createDaylightState>} out
 */
export function evaluate(t01, out) {
  const t = normaliseTime(t01);
  let i = 0;
  while (i < KEYS.length - 2 && t > KEYS[i + 1].t) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const span = b.t - a.t;
  const u = clamp01(span > 1e-6 ? (t - a.t) / span : 0);
  // Smootherstep between keys: no visible corner as the sun crosses a keyframe.
  const f = u * u * u * (u * (u * 6 - 15) + 10);
  const ca = KEY_COLOURS[i];
  const cb = KEY_COLOURS[i + 1];

  out.t = t;
  out.hours = HOUR_START + t * (HOUR_END - HOUR_START);

  const elev = lerp(a.elev, b.elev, f);
  const azim = lerp(a.azim, b.azim, f);
  out.elevation = elev;
  out.azimuth = azim;
  out.sunAboveHorizon = elev > 0;
  const ce = Math.cos(elev * DEG);
  out.sunDir.set(Math.sin(azim * DEG) * ce, Math.sin(elev * DEG), -Math.cos(azim * DEG) * ce).normalize();

  kelvinColour(lerp(a.kelvin, b.kelvin, f), out.sunColour);
  out.sunIntensity = lerp(a.sun, b.sun, f);

  out.skyZenith.lerpColors(ca.zenith, cb.zenith, f);
  out.skyHorizon.lerpColors(ca.horizon, cb.horizon, f);
  out.skyHaze.lerpColors(ca.haze, cb.haze, f);
  out.skyGround.lerpColors(ca.ground, cb.ground, f);
  out.skyCity.lerpColors(ca.city, cb.city, f);
  out.skyGain = lerp(a.skyGain, b.skyGain, f);
  out.sunDisc = lerp(a.disc, b.disc, f);

  kelvinColour(lerp(a.winK, b.winK, f), out.windowColour);
  out.windowIntensity = lerp(a.win, b.win, f);

  out.bounceColour.lerpColors(ca.bounceC, cb.bounceC, f);
  out.bounceIntensity = lerp(a.bounce, b.bounce, f);

  // The hemisphere's sky half stands for "everything arriving from above", which in this room is
  // the whole upper hemisphere and not just the warm haze band sitting on the horizon. Mixing
  // toward the zenith keeps that term cool; taking the horizon straight made the blanket fill go
  // amber the moment the sun dropped, which is the opposite of what a real skylight does.
  out.hemiSky.lerpColors(out.skyHorizon, out.skyZenith, 0.45);
  out.hemiGround.lerpColors(ca.hemiG, cb.hemiG, f);
  out.hemiIntensity = lerp(a.hemi, b.hemi, f);

  out.envIntensity = lerp(a.env, b.env, f);
  out.exposure = lerp(a.exposure, b.exposure, f);

  out.practical = lerp(a.practical, b.practical, f);
  // 2700 K tungsten in the shade, a touch warmer in the bare bulb because it is a lower wattage
  // and it dips further as the room darkens and the dimmer-less circuit sags. Both are deliberately
  // weak: at 16:30 the lamp is ~5% of the key, at 18:45 it is the key.
  kelvinColour(2750 - out.practical * 130, out.lampColour);
  kelvinColour(2560 - out.practical * 120, out.bulbColour);
  out.lampIntensity = 0.42 + out.practical * 1.95;
  // r06 finding: the bare E27 peaked at ~1.7 cd across the whole day curve, 20-25x below a real
  // 40 W bulb's ~36 cd, so it left no warm pool on the slab and cast no shadow of its own fitting.
  // The PointLight is calibrated in candela (decay 2, see the constructor in lighting.js), so this
  // is a straight swap for the real number.
  out.bulbIntensity = 7.0 + out.practical * 29.0;

  out.fogColour.lerpColors(ca.fog, cb.fog, f);
  out.fogDensity = lerp(a.fogD, b.fogD, f);

  // The shafts take the sun's hue but pulled a little toward the haze — scattering is wavelength
  // dependent and the air in a beam always reads warmer and milkier than the source. Pass-4
  // finding: this is an *additive* screen-space veil, not a surface reflection, so it never goes
  // through an albedo multiply — it lands in the framebuffer at close to its authored hue with
  // nothing to dilute it. `haze` (the sky gradient's warm horizon band, R:B ~1.7) is deliberately
  // warm for the exterior backdrop seen through the glazing, so it is left alone; the fix is to
  // let less of it leak into the interior beam. 0.30 → 0.14 roughly halves the shaft's contributed
  // warmth in the wide establishing shots (hero, ceiling) where the beam covers real screen area,
  // without touching the backdrop's own sky colours at all.
  _tmp.copy(out.skyHaze);
  out.shaftColour.copy(out.sunColour).lerp(_tmp, 0.14);
  out.shaftIntensity = lerp(a.shaft, b.shaft, f);

  return out;
}
