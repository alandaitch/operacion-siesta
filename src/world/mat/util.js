// OPERATION NAPTIME — module MAT — shared material plumbing.
//
// Three ideas live here and nothing else.
//
//  1. `makeMaterial(B, spec)` — one declarative constructor for every PBR surface in the room. It
//     pulls a texture set from the TEX library, wires the packed ORM (AO in .r, roughness in .g,
//     metalness in .b — one upload, three maps), computes the tiling repeat from a real-world
//     extent in metres rather than a magic number, and applies the quality-tier downgrades in ONE
//     place so no recipe has to think about the `low` tier.
//  2. The roughness band. A texture's authored roughness is whatever the generator felt like; art
//     direction wants a specific band per surface ("the floor rakes between 0.35 and 0.60"). Rather
//     than re-baking textures we patch one line of GLSL after `<roughnessmap_fragment>`:
//         roughnessFactor = lo + (hi - lo) * roughnessFactor;
//     Zero runtime cost, exact control, and it is why nothing in this room has a flat roughness.
//     With a roughness map the scalar `material.roughness` MUST stay at 1 (three multiplies the
//     scalar by the sampled channel); the band is what guarantees the *effective* roughness is
//     never 0 or 1.
//  3. A fake subsurface term. Baby skin needs light to seem to survive a trip through a thin
//     volume. Real SSS is out of budget, so we add a wrapped, back-scattering rim per light, using
//     `directLight.direction` and `directLight.color` inside the light loop.
//  4. A thin-sheet TRANSLUCENCY lobe — the substitute for `transmission` on everything the
//     transmission budget in ../materials.js turns off below `ultra`. See `setTranslucency`.
//
// All three patches are installed through a single `onBeforeCompile` per material with a matching
// `customProgramCacheKey`, because two materials that differ only in an injected constant must not
// share a compiled program. `Material.clone()` does not carry `onBeforeCompile`, so the patch
// parameters also live in `userData` (JSON-safe on purpose — three deep-copies userData through
// JSON on clone) and `reinstallPatches()` puts them back on a variant.

import * as THREE from 'three';

export const TIER_RANK = Object.freeze({ low: 0, medium: 1, high: 2, ultra: 3 });

/** True when `tier` is at least `min` ('low' < 'medium' < 'high' < 'ultra'). */
export function atLeast(tier, min) {
  return (TIER_RANK[tier] ?? 2) >= (TIER_RANK[min] ?? 2);
}

const g = (v) => Number(v).toFixed(4);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const r4 = (v) => Math.round(v * 1e4) / 1e4;

// ───────────────────────────────────────────────────────── shader patches ──

/** Per-material patch state. Kept out of userData so userData stays JSON-serialisable. */
const PATCH = new WeakMap();

/**
 * The one place both light-loop patches are assembled. They inject after the SAME `RE_Direct(...)`
 * call, so they cannot be two independent string replaces — the second would find its anchor inside
 * the text the first one just inserted and nest the whole block. One replace, one brace scope per
 * effect, no shared locals.
 *
 * ⚠ THE ANCHOR IS NOT IN THE SHADER YET WHEN `onBeforeCompile` RUNS. `WebGLRenderer.getProgram()`
 * calls `material.onBeforeCompile( parameters )` and only *then* hands `parameters` to
 * `acquireProgram()`, which is what runs `resolveIncludes()`. So at patch time the fragment shader
 * still reads `#include <lights_fragment_begin>` and contains no `RE_Direct(` call anywhere — a
 * `.split(CALL).join(...)` against it silently matches nothing and the patch evaporates. (The
 * roughness band and the thin-glass patch do not hit this because their anchors ARE `#include`
 * directives, which is exactly why they worked while this did not. Verified by reading
 * `gl.getShaderSource()` off every live program: 48 carried the roughness band, 0 carried the
 * subsurface rim.)
 *
 * So we expand the chunk ourselves and substitute the expanded, patched text for the directive.
 * `resolveIncludes` is recursive, so any `#include` inside the chunk still resolves normally, and
 * `#pragma unroll_loop_start` survives because `unrollLoops()` runs later on the resolved source.
 */
const LIGHTS_BEGIN = '#include <lights_fragment_begin>';
const RE_DIRECT_CALL = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';

function lightLoopInjection(s) {
  let body = '';
  if (s.sss) {
    const { c, strength } = s.sss;
    // A real terminator, not a global halo: the old version multiplied `totalDiffuse` by a purely
    // view-facing Fresnel term with no light-direction test, so every rounded limb got the same
    // orange rim regardless of where the key light actually was — a flat wrap, not subsurface.
    // This version is gated per-light using `directLight.direction` and `directLight.color` (both
    // in scope right after every RE_Direct call — point, spot AND directional all share this exact
    // call text, so one replace patches all three): `wrap` warms the terminator edge as the surface
    // turns away from a light, `back` adds true back-scatter when the viewer is roughly opposite
    // the light (the classic "glowing ear" look). Because it accumulates into
    // `reflectedLight.directDiffuse` per light rather than post-multiplying the light-independent
    // sum, a shadowed limb now actually goes dark.
    body += `	{
		float wrap = saturate( ( dot( geometryNormal, directLight.direction ) + 0.45 ) / 1.45 );
		float back = pow( saturate( dot( geometryViewDir, -directLight.direction ) ), 3.0 );
		reflectedLight.directDiffuse += directLight.color * vec3( ${g(c.r)}, ${g(c.g)}, ${g(c.b)} ) * ( back * wrap * ${g(strength)} );
	}
`;
  }
  if (s.trans) {
    const { c, strength, power, ambient } = s.trans;
    // THIN-SHEET TRANSLUCENCY — the substitute for `transmission` (see ../materials.js).
    //
    // A voile hangs between the sun and the room and a monstera leaf leans into the window, so on
    // both of them the *front* face has dot(N, L) < 0 and three hands them no direct diffuse at
    // all. That is the actual reason a curtain that merely loses `transmission` goes flat and
    // chalky: it is not being lit by the thing lighting it in the photograph. This puts that light
    // back the way cloth and leaf-blade actually pass it, per light and inside the shadow test:
    //
    //   `bl`  — how squarely the light lands on the BACK of the sheet. `-geometryNormal` is correct
    //           for both faces: three flips the normal toward the viewer on a DoubleSide surface,
    //           so this is always "the side facing away from me".
    //   `fwd` — the forward-scatter lobe. Real fabric scatters strongly forward and weakly
    //           sideways, which is why a net curtain flares when you look toward the sun through it
    //           and stays a calm veil when you do not. `power` is the tightness of that flare.
    //   `ambient` — the diffuse floor, the light that gets through a thread scattering every which
    //           way. Without it a fold turned edge-on to the sun would go black.
    //
    // `directLight.color` already carries the shadow term, so a curtain the balcony railing is
    // shadowing stops glowing exactly where the shadow crosses it. Cost: eight ALU per light, no
    // render target, no second scene traversal.
    body += `	{
		float bl = saturate( dot( -geometryNormal, directLight.direction ) );
		float fwd = pow( saturate( dot( geometryViewDir, -directLight.direction ) ), ${g(power)} );
		reflectedLight.directDiffuse += directLight.color * vec3( ${g(c.r)}, ${g(c.g)}, ${g(c.b)} ) * ( bl * ( ${g(ambient)} + fwd ) * ${g(strength)} );
	}
`;
  }
  if (!body) return null;
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  if (!chunk || !chunk.includes(RE_DIRECT_CALL)) {
    // A three upgrade renamed the chunk or reworded the call. Fail loudly rather than shipping a
    // room whose backlit fabric quietly stopped being backlit — that is the exact failure this
    // whole patch was written to fix, and it is invisible in a screenshot until you compare two.
    console.warn('[mat] lights_fragment_begin no longer contains the RE_Direct anchor — the '
      + 'translucency and subsurface patches are inert. Check three\'s ShaderChunk after an upgrade.');
    return null;
  }
  return chunk.split(RE_DIRECT_CALL).join(`${RE_DIRECT_CALL}\n${body}`);
}

function state(mat) {
  let s = PATCH.get(mat);
  if (s) return s;
  s = { rough: null, sss: null, trans: null, glass: null, key: '-' };
  PATCH.set(mat, s);
  mat.onBeforeCompile = (shader) => {
    if (s.glass) {
      const { c, gain, power, tint } = s.glass;
      // `opaque_fragment` is where `gl_FragColor = vec4( outgoingLight, diffuseColor.a )` happens,
      // and `geometryNormal`, `geometryViewDir`, `outgoingLight` and `diffuseColor` are all still
      // in scope one line above it. See setThinGlass for what this is for.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `	{
		float fres = pow( 1.0 - saturate( dot( geometryNormal, geometryViewDir ) ), ${g(power)} );
		outgoingLight *= mix( vec3( 1.0 ), vec3( ${g(c.r)}, ${g(c.g)}, ${g(c.b)} ), fres * ${g(tint)} );
		diffuseColor.a = mix( diffuseColor.a, 1.0, fres * ${g(gain)} );
	}
	#include <opaque_fragment>`,
      );
    }
    if (s.rough) {
      const [lo, hi] = s.rough;
      // The clamp lets a band run outside [0,1] — which is how a map with a narrow authored range
      // (the glass smudges live in 0.50–1.00) gets stretched across a useful spread — while still
      // guaranteeing the shipped roughness is never 0 and never 1.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
	roughnessFactor = clamp( ${g(lo)} + ${g(hi - lo)} * roughnessFactor, 0.015, 0.995 );`,
      );
    }
    const inject = lightLoopInjection(s);
    if (inject) shader.fragmentShader = shader.fragmentShader.replace(LIGHTS_BEGIN, inject);
  };
  mat.customProgramCacheKey = () => s.key;
  return s;
}

function rekey(mat, s) {
  const a = s.rough ? `r${g(s.rough[0])}_${g(s.rough[1])}` : 'r-';
  const b = s.sss ? `s${g(s.sss.strength)}_${g(s.sss.power)}_${s.sss.c.getHexString()}` : 's-';
  const c = s.trans
    ? `t${g(s.trans.strength)}_${g(s.trans.power)}_${g(s.trans.ambient)}_${s.trans.c.getHexString()}`
    : 't-';
  const d = s.glass
    ? `g${g(s.glass.gain)}_${g(s.glass.power)}_${g(s.glass.tint)}_${s.glass.c.getHexString()}`
    : 'g-';
  s.key = `${a}|${b}|${c}|${d}`;
  mat.needsUpdate = true;
}

/**
 * Remap the sampled roughness into [lo, hi]. Only meaningful with a roughnessMap; the scalar
 * `material.roughness` stays 1 so the map is not scaled twice.
 */
export function setRoughnessBand(mat, lo, hi) {
  const s = state(mat);
  s.rough = [clamp(lo, -2, 0.99), clamp(hi, -1, 2)];
  mat.userData.roughRange = s.rough.slice();
  rekey(mat, s);
  return mat;
}

/** Warm view-facing translucency (ears, fingers, leaf margins). `hex` is the transmitted colour. */
export function setSubsurface(mat, hex, strength = 0.35, power = 2.5) {
  const s = state(mat);
  s.sss = { c: new THREE.Color(hex), strength, power };
  mat.userData.sss = { hex, strength, power };
  rekey(mat, s);
  return mat;
}

/**
 * Light that goes IN one side of a thin sheet and comes OUT the other — a backlit voile, a backlit
 * leaf, a lampshade lit from inside. This is what a material gets instead of `transmission` on
 * every tier below `ultra`; see TRANSMISSION_BUDGET in ../materials.js for why, and
 * `lightLoopInjection` above for the shading model.
 *
 * @param {number} hex   the colour that survives the trip (always warmer/lighter than the albedo —
 *                       forward scattering loses saturation the same way a sheen lobe does)
 * @param {number} strength overall gain
 * @param {number} power tightness of the forward lobe: 1.5 is a broad woolly glow, 6 is a sharp
 *                       flare you only see looking almost straight into the light
 * @param {number} ambient the fraction that scatters out in every direction rather than forward
 */
export function setTranslucency(mat, hex, strength = 0.8, power = 2.5, ambient = 0.25) {
  const s = state(mat);
  s.trans = {
    c: new THREE.Color(hex),
    strength: clamp(strength, 0, 8),
    power: clamp(power, 0.5, 24),
    ambient: clamp(ambient, 0, 2),
  };
  mat.userData.translucency = {
    hex, strength: s.trans.strength, power: s.trans.power, ambient: s.trans.ambient,
  };
  rekey(mat, s);
  return mat;
}

/**
 * Fresnel-weighted glass for a blended pane with no transmission pass behind it.
 *
 * A fixed low `opacity` is wrong about glass twice over. First, three multiplies the whole
 * outgoing radiance by alpha under NormalBlending, so a pane at opacity 0.18 also throws away 82%
 * of its own reflection — the one thing a transmission-less pane has left. Second, it makes the
 * glass equally see-through head-on and edge-on, and no glass does that: normal incidence reflects
 * about 4% and grazing incidence approaches a mirror. From a camera 42 cm off the floor, most of
 * the coffee table IS grazing.
 *
 * So the alpha is driven by the same Schlick term the specular already uses, and the green that
 * real float glass shows along a long sightline through its thickness rides on it — that arris tint
 * is what `attenuationColour` used to buy, and it is the tell that separates glass from perspex.
 *
 * @param {number} hex     the colour of a long path through the slab (low-iron float glass: green)
 * @param {number} gain    how far toward opaque the grazing angle drives alpha (0–1)
 * @param {number} power   Schlick exponent — 5 is physical, lower widens the grazing band
 * @param {number} tint    how strongly the path colour applies at grazing
 */
export function setThinGlass(mat, hex, gain = 0.85, power = 4.5, tint = 0.5) {
  const s = state(mat);
  s.glass = {
    c: new THREE.Color(hex),
    gain: clamp(gain, 0, 1),
    power: clamp(power, 1, 8),
    tint: clamp(tint, 0, 1),
  };
  mat.userData.thinGlass = { hex, gain: s.glass.gain, power: s.glass.power, tint: s.glass.tint };
  rekey(mat, s);
  return mat;
}

/** Re-apply the patches described by `userData` — used after `clone()`, which drops them. */
export function reinstallPatches(mat) {
  const rr = mat.userData?.roughRange;
  const ss = mat.userData?.sss;
  const tl = mat.userData?.translucency;
  const gl = mat.userData?.thinGlass;
  if (rr) setRoughnessBand(mat, rr[0], rr[1]);
  if (ss) setSubsurface(mat, ss.hex, ss.strength, ss.power);
  if (tl) setTranslucency(mat, tl.hex, tl.strength, tl.power, tl.ambient);
  if (gl) setThinGlass(mat, gl.hex, gl.gain, gl.power, gl.tint);
  return mat;
}

// ──────────────────────────────────────────────────────────────── colours ──

const NEAR_WHITE = 0xf6f2ea;
const NEAR_BLACK = 0x0d0e10;

/**
 * The room has no pure black and no pure white in it, ever — a #fff albedo is the single fastest
 * way to make a render look synthetic. A 0xffffff *tint over a texture* is legal (it means "no
 * tint"), a 0xffffff albedo on an untextured material is not.
 */
export function safeColour(hex, hasMap) {
  if (hex === 0xffffff && !hasMap) return NEAR_WHITE;
  if (hex === 0x000000) return NEAR_BLACK;
  return hex;
}

// ───────────────────────────────────────────────────────────────── maps ────

/**
 * Attach a TEX set to a material. Clones the textures when a repeat/offset is needed (a clone
 * shares `Texture.source`, so it costs no extra VRAM) and keeps the packed ORM as ONE texture
 * bound to roughnessMap/metalnessMap/aoMap.
 */
export function applyMaps(mat, set, opts = {}) {
  const {
    repeat = null, offset = null, anisotropy = 8, normalScale = 1,
    ao = 1, useAlpha = false, useMetalMap = true, clampWrap = false,
  } = opts;
  if (!set) return mat;

  // A repeat of exactly 1 is what the textures already carry, so it needs no private copy.
  const trivial = !offset && !clampWrap && (!repeat || (repeat[0] === 1 && repeat[1] === 1));
  const needsOwn = !trivial;
  const take = (t) => {
    if (!t) return null;
    const out = needsOwn ? t.clone() : t;
    if (needsOwn) {
      out.userData = { matClone: true };
      if (repeat) out.repeat.set(repeat[0], repeat[1]);
      if (offset) out.offset.set(offset[0], offset[1]);
      if (clampWrap) {
        out.wrapS = THREE.ClampToEdgeWrapping;
        out.wrapT = THREE.ClampToEdgeWrapping;
      }
    }
    out.anisotropy = anisotropy;
    return out;
  };

  mat.map = take(set.map);
  if (set.normalMap) {
    mat.normalMap = take(set.normalMap);
    mat.normalScale = new THREE.Vector2(normalScale, normalScale);
  }
  const orm = take(set.orm);
  if (orm) {
    mat.roughnessMap = orm;
    mat.roughness = 1; // multiplier for the packed .g — see the header note on the roughness band
    if (useMetalMap && set.metalnessMap) {
      mat.metalnessMap = orm;
      mat.metalness = 1;
    }
    if (ao > 0 && set.aoMap) {
      mat.aoMap = orm;
      mat.aoMapIntensity = ao;
    }
  }
  if (useAlpha && set.alphaMap) mat.alphaMap = take(set.alphaMap);
  return mat;
}

/** Repeat counts for a surface `extent` metres across, given the set's real-world tile size. */
export function repeatForExtent(set, extent) {
  if (!set || !extent) return null;
  const tm = set.tileMetres || [1, 1];
  const w = Array.isArray(tm) ? tm[0] : tm;
  const h = Array.isArray(tm) ? (tm[1] ?? tm[0]) : tm;
  return [Math.max(0.05, r4(extent[0] / w)), Math.max(0.05, r4((extent[1] ?? extent[0]) / h))];
}

// ────────────────────────────────────────────────────── the constructor ────

/**
 * Build one material from a declarative spec. Everything the recipes do goes through here.
 *
 * spec = {
 *   tex:        'generatorName' | ['generatorName', params] | null
 *   texSet:     a pre-built texture set, when the recipe needs it for something else too
 *   physical:   want MeshPhysicalMaterial (auto-downgraded to Standard on the low tier)
 *   basic:      unlit MeshBasicMaterial (backdrops)
 *   colour:     hex tint (multiplies the albedo map)
 *   rough:      [lo, hi] roughness band (mapped) or a scalar (unmapped)
 *   metal:      metalness scalar, or the multiplier when a metalness map is present
 *   useMetalMap: false to ignore the set's metalness channel (paint over steel is a dielectric)
 *   normal:     normalScale
 *   ao:         aoMapIntensity, 0 to skip
 *   extent:     [w, h] metres the surface typically spans → the tiling repeat
 *   repeat:     explicit [u, v] override
 *   alpha:      true to bind the set's alphaMap
 *   roughMap:   { tex, extent } — bind only a roughness channel, no albedo (smudges on glass)
 *   envBoost:   relative environment strength; LIGHT multiplies it by the global intensity
 *   sheen:      { amount, roughness, colour }
 *   clearcoat:  { amount, roughness }
 *   transmission: { amount, thickness, ior, attenuationColour, attenuationDistance } — REQUESTED,
 *               not granted: it only survives if the transmission budget in ../materials.js says
 *               this material may pay for the transmission render pass on this tier. Author the
 *               substitute alongside it (`translucency`, sheen, opacity) rather than assuming it.
 *   translucency: { colour, strength, power, ambient } — the thin-sheet forward-scatter lobe
 *   thinGlass:  { colour, gain, power, tint } — Fresnel alpha + arris tint for blended glass
 *   sss:        { colour, strength, power }
 *   props:      any remaining THREE material properties, applied verbatim
 * }
 */
export function makeMaterial(B, spec) {
  const {
    tex = null, physical = false, basic = false,
    colour = 0xffffff, rough = 0.7, metal = 0, useMetalMap = true,
    normal = 1, ao = 1, extent = null, repeat = null, offset = null,
    alpha = false, clampWrap = false, envBoost = 1, roughMap = null,
    sheen = null, clearcoat = null, transmission = null, sss = null, translucency = null,
    thinGlass = null, props = {},
  } = spec;

  const set = spec.texSet || (tex ? B.set(tex) : null);
  // Note `transmission` counts toward `rich` even when the budget will refuse it: a recipe that
  // asked for transmission is describing a translucent surface, and the sheen and clearcoat of its
  // substitute need MeshPhysicalMaterial just as much as the real thing did.
  const rich = !basic && (physical || sheen || clearcoat || transmission) && B.canSheen;

  const Ctor = basic ? THREE.MeshBasicMaterial : rich ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const mat = new Ctor();

  mat.color = new THREE.Color(safeColour(colour, !!set));

  const rep = repeat || (set && set.tileable !== false ? repeatForExtent(set, extent) : null);
  applyMaps(mat, set, {
    repeat: rep,
    offset,
    anisotropy: B.anisotropy,
    normalScale: normal,
    ao: basic ? 0 : ao,
    useAlpha: alpha,
    useMetalMap,
    clampWrap,
  });

  // A roughness map with no albedo behind it: micro-variation grafted onto an otherwise untextured
  // surface (the fingerprints on the glass table). Only the packed ORM's .g channel is bound.
  if (roughMap && !mat.roughnessMap) {
    const rs = B.set(roughMap.tex);
    const rrep = roughMap.repeat || repeatForExtent(rs, roughMap.extent);
    let t = rs.orm;
    if (rrep && !(rrep[0] === 1 && rrep[1] === 1)) {
      t = t.clone();
      t.userData = { matClone: true };
      t.repeat.set(rrep[0], rrep[1]);
    }
    t.anisotropy = B.anisotropy;
    mat.roughnessMap = t;
    mat.roughness = 1;
  }

  if (!basic) {
    // Never exactly 0 and never exactly 1: a perfect mirror and a perfect diffuser are both things
    // that do not exist in a living room. With a map the band does the clamping in the shader and
    // the scalar has to stay at 1, or the map gets scaled twice.
    if (Array.isArray(rough)) {
      if (mat.roughnessMap) setRoughnessBand(mat, rough[0], rough[1]);
      else mat.roughness = clamp((rough[0] + rough[1]) * 0.5, 0.015, 0.985);
    } else if (mat.roughnessMap) {
      setRoughnessBand(mat, rough * 0.7, Math.min(0.99, rough * 1.35));
    } else {
      mat.roughness = clamp(rough, 0.015, 0.985);
    }
    // With a metalness map the scalar is the multiplier (default 1, i.e. take the map as authored);
    // without one it is the value itself.
    mat.metalness = mat.metalnessMap
      ? clamp(spec.metal === undefined ? 1 : metal, 0.02, 1)
      : clamp(metal, 0, 1);
  }

  if (rich) {
    if (sheen) {
      mat.sheen = sheen.amount;
      mat.sheenRoughness = clamp(sheen.roughness ?? 0.6, 0.05, 0.99);
      mat.sheenColor = new THREE.Color(sheen.colour ?? 0xf7efe2);
    }
    if (clearcoat && B.canClearcoat) {
      mat.clearcoat = clearcoat.amount;
      mat.clearcoatRoughness = clamp(clearcoat.roughness ?? 0.1, 0.02, 0.95);
    }
    if (transmission && B.transmits()) {
      mat.transmission = transmission.amount;
      mat.thickness = transmission.thickness ?? 0.01;
      mat.ior = transmission.ior ?? 1.5;
      if (transmission.attenuationColour !== undefined) {
        mat.attenuationColor = new THREE.Color(transmission.attenuationColour);
        mat.attenuationDistance = transmission.attenuationDistance ?? 0.5;
      }
    }
  }

  // Anything a downgraded material does not have (thicknessMap and specularIntensity only exist on
  // MeshPhysicalMaterial) is skipped rather than bolted on as a dead property.
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k === 'normalScale') mat.normalScale = new THREE.Vector2(v, v);
    else if (mat[k] && mat[k].isColor) mat[k].setHex(v);
    else if (k in mat) mat[k] = v;
  }

  // The subsurface rim is three ALU ops and MeshStandardMaterial compiles the same physical
  // shader, so it is never tiered away — a plastic-looking baby is a failure on any GPU.
  if (sss) setSubsurface(mat, sss.colour, sss.strength, sss.power);
  // Same reasoning for the thin-sheet lobe, and the same reason it is not tier-gated: it is the
  // cheap side of the trade, so the tiers that cannot afford transmission are exactly the tiers
  // that need it most.
  if (translucency) {
    setTranslucency(mat, translucency.colour, translucency.strength, translucency.power, translucency.ambient);
  }
  if (thinGlass) setThinGlass(mat, thinGlass.colour, thinGlass.gain, thinGlass.power, thinGlass.tint);

  mat.userData.envBoost = envBoost;
  if (set) {
    mat.userData.tex = Array.isArray(tex) ? tex[0] : tex;
    mat.userData.tileMetres = Array.isArray(set.tileMetres) ? set.tileMetres.slice(0, 2) : [set.tileMetres, set.tileMetres];
    if (rep) mat.userData.repeat = rep.slice();
  }
  return mat;
}
