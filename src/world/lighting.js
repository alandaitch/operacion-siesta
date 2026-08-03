// OPERATION NAPTIME — module LIGHT. Sun, sky, IBL, practicals, volumetrics.
// OWNER: LIGHT. Implements the last section of REFERENCE.md ("The light, precisely").
//
// The frame is built out of six sources and they are deliberately not equal:
//
//  1. IBL. There are no .hdr files in this project, so the environment is rendered: an analytic
//     sky dome plus a crude radiance proxy of *this* room (floor, cream rug with the sunlit strip
//     across it, slab, walls, the sofa's flank, and a window wall with a real hole in it) pushed
//     through PMREMGenerator. That single texture is why ambient arriving from the window is
//     bright and cool while ambient from the far corner is dim and warm — a hemisphere light
//     cannot express that, and its absence is the main reason cheap interiors look flat.
//  2. KEY. One directional light standing in for the low winter sun, ~15° up and raking in past
//     the left edge of the glazing. Its shadow camera is a stable square fitted to the room's
//     bounding sphere (not a 100 m frustum), texel-snapped so the edges do not crawl when the sun
//     moves, and it renders through a widened Poisson PCF (see ./lighting/softshadow.js) because
//     three's stock soft filter gives a 1 cm penumbra at this scale.
//  3. WINDOW SOFTBOX. A RectAreaLight filling the aperture. This is what puts a correctly shaped
//     specular smear on the glass table and a long soft gradient down the sofa's roll arm.
//  4. BOUNCE. A second, weak, warm RectAreaLight lying on the rug facing straight up, plus a low
//     hemisphere term. Without it the raw concrete ceiling reads as dead grey card.
//  5. PRACTICALS. The floor lamp's dome and the bare pendant bulb, both weak against daylight and
//     both driven from the same `practical` curve. The pendant's light tracks the physics
//     pendulum, so knocking the bulb swings the shadows in the room.
//  6. VOLUMETRICS. Camera-facing slices through the beam volume, depth-tested so the room occludes
//     them. See ./lighting/shafts.js.
//
// `setTimeOfDay(t)` moves all six at once from 16:30 to 18:45. During a round the light drifts
// on its own, so the room really does get more desperate as the timer runs down.
//
// Ambient occlusion is POSTFX's job (n8ao) and is deliberately not faked here with fill lights.

import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

import { createDaylightState, evaluate, normaliseTime, clockLabel } from './lighting/daylight.js';
import { createSkyMaterial, applySkyState, createProbeScene, createBackdropScene, PROBE } from './lighting/sky.js';
import { installSoftShadows, restoreSoftShadows } from './lighting/softshadow.js';
import { createShafts } from './lighting/shafts.js';

/** Fixtures, from CONTRACTS §2. Other modules build the meshes; we only light them. */
const FIXTURES = {
  lamp: new THREE.Vector3(2.95, 1.34, -4.10),
  pendant: new THREE.Vector3(0.30, 1.62, -1.20),
  window: { x0: -1.60, x1: 3.40, y0: 0.06, y1: 2.50, z: -4.53 },
  rug: { x: 0.90, z: -1.80, w: 4.60, d: 4.00 },
};

/** The volume the sun's shadow camera has to cover — the room plus a little air. */
const ROOM_BOX = new THREE.Box3(
  new THREE.Vector3(-3.55, -0.10, -4.80),
  new THREE.Vector3(3.55, 2.90, 3.60),
);

const DEFAULT_TIME = normaliseTime(17.5); // the reference photograph, ~17:30

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _sphere = new THREE.Sphere();
const _axisX = new THREE.Vector3();
const _axisY = new THREE.Vector3();
const _axisZ = new THREE.Vector3();
const _corner = new THREE.Vector3();

/**
 * r06 finding ("window"): the old shadow frustum was a square sized off ROOM_BOX's bounding
 * SPHERE (~5.9 m half-width) — a bound wide enough to cover the room from *any* direction, which
 * is a huge waste given the sun only ever sits in the narrow arc daylight.js's KEYS describe
 * (elev 1..15.5°, azim -21..-42°). Sampling the actual keyframe path once at import time and
 * keeping the worst-case per-axis span (not a single worst-case radius) buys real resolution for
 * free: the room is much taller (2.78 m) than the sun's near-horizontal elevation ever needs, so
 * the vertical half-extent comes out well under the horizontal one. Two independent extents, both
 * still *constants*, so the "snap the centre to a whole texel" trick in aimSun() still holds and
 * the shadow does not shimmer as the sun crosses the sky during a round.
 */
function computeShadowExtents() {
  const probe = createDaylightState();
  const centre = new THREE.Vector3();
  ROOM_BOX.getCenter(centre);
  const ax = new THREE.Vector3();
  const ay = new THREE.Vector3();
  const az = new THREE.Vector3();
  const c = new THREE.Vector3();
  let maxA = 0;
  let maxB = 0;
  for (let i = 0; i <= 40; i++) {
    evaluate(i / 40, probe);
    az.copy(probe.sunDir).normalize();
    ax.set(0, 1, 0).cross(az);
    if (ax.lengthSq() < 1e-6) ax.set(1, 0, 0);
    ax.normalize();
    ay.copy(az).cross(ax).normalize();
    for (let k = 0; k < 8; k++) {
      c.set(
        k & 1 ? ROOM_BOX.max.x : ROOM_BOX.min.x,
        k & 2 ? ROOM_BOX.max.y : ROOM_BOX.min.y,
        k & 4 ? ROOM_BOX.max.z : ROOM_BOX.min.z,
      ).sub(centre);
      const a = Math.abs(c.dot(ax));
      const b = Math.abs(c.dot(ay));
      if (a > maxA) maxA = a;
      if (b > maxB) maxB = b;
    }
  }
  return { a: maxA + 0.35, b: maxB + 0.35 };
}

export function createLighting(ctx) {
  const { scene, renderer, quality } = ctx;
  const engine = ctx.engine || null;
  const tier = quality?.tier || 'high';
  const rich = tier === 'high' || tier === 'ultra';
  const ultra = tier === 'ultra';

  const group = new THREE.Group();
  group.name = 'lighting';
  // Slices in ./lighting/shafts.js are authored in world space; keep this group at the origin.
  group.matrixAutoUpdate = false;

  const day = createDaylightState();
  let timeOfDay = DEFAULT_TIME;
  let autoAdvance = true;
  let manualHoldFor = 0;
  evaluate(timeOfDay, day);

  // A profiler pass (tools/perf.mjs) found the shadow cost is almost entirely fragment-shader
  // sampling, not map rasterisation: disabling shadows saved ~18 ms of a ~34 ms frame at `high`,
  // freezing rasterisation alone saved ~1.1–1.4 ms. So the tap count is tiered: `ultra` keeps the
  // full 12-tap disc, `high` — the only other tier where quality.softShadows is true — gets 8. The
  // per-pixel rotation (see softshadow.js) is unchanged at either count, which is what keeps
  // undersampling reading as fine grain-eaten noise instead of banding. `medium`/`low` never call
  // installSoftShadows at all (quality.softShadows is false there), so they stay on three's stock
  // nine-tap PCF_SOFT filter with zero patch cost.
  const softShadowsPatched = quality?.softShadows ? installSoftShadows(ultra ? 12 : 8) : false;

  // ── 1. environment ────────────────────────────────────────────────────────────────────────
  const skyMaterial = createSkyMaterial();
  const probe = createProbeScene(skyMaterial);
  const backdrop = createBackdropScene(skyMaterial);

  const pmrem = new THREE.PMREMGenerator(renderer);
  let envTarget = null;
  let envTexture = null;

  const cubeSize = tier === 'low' ? 128 : 256;
  const backdropTarget = new THREE.WebGLCubeRenderTarget(cubeSize, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  const backdropCamera = new THREE.CubeCamera(0.5, 260, backdropTarget);

  let appliedEnvIntensity = -1;

  function bakeEnvironment() {
    applySkyState(skyMaterial, day);
    probe.tune(day);

    // The backdrop the window actually looks at.
    backdropCamera.update(renderer, backdrop.scene);

    // …and the probe, which is the same sky seen from inside this particular room.
    const next = pmrem.fromScene(probe.scene, 0, 0.15, 260);
    const previous = envTarget;
    envTarget = next;
    envTexture = next.texture;
    if (previous) previous.dispose();

    appliedEnvIntensity = day.envIntensity;
    scene.environment = envTexture;
    scene.environmentIntensity = day.envIntensity;
    scene.background = backdropTarget.texture;
    scene.backgroundIntensity = 1.0;
    ctx.materials?.setEnvironment?.(envTexture, day.envIntensity);
  }

  // ── 2. key light ──────────────────────────────────────────────────────────────────────────
  const sun = new THREE.DirectionalLight(0xffe6c6, 3.5);
  sun.name = 'light.sun';
  sun.castShadow = true;
  sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
  // r06 review: normalBias was 0.014 (14 mm) — wider than the window mullion flanges (11 mm), a
  // full radius of the rattan chair's leg tubes (14.5 mm), and the baby's fingers. Every reviewer
  // who looked at a thin caster independently found the same failure: no contact shadow at all,
  // because the receiver sample was pushed clean past the caster before it ever touched. Dropped
  // to 3.5 mm — enough to clear one texel of slope error on the room's big flat surfaces (the
  // slab, the walls) without erasing anything under ~1 cm — and `bias` made proportionally more
  // negative to hold the acne those same flat surfaces would otherwise show at the tighter offset.
  sun.shadow.bias = -0.00028;
  sun.shadow.normalBias = 0.0035;
  // `shadow.radius` is what our patched Poisson filter scales its disc by (see softshadow.js);
  // three's own PCFShadowMap/PCFSoftShadowMap ignore it, so this is inert on medium/low and on
  // high/ultra if the patch ever fails to install. `shadow.blurSamples` was removed from here —
  // it is a WebGLShadowMap.VSMShadowMap-only setting and this project's renderer never selects
  // VSMShadowMap (see engine.js), so it was dead and misleading the next reader. Tightened from
  // 3.4 alongside the bias/extent changes above — a wide penumbra was blurring a 20 mm mullion
  // clean out of existence on top of the peter-panning.
  sun.shadow.radius = softShadowsPatched ? 2.1 : 2.0;
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far = 30;
  group.add(sun);
  group.add(sun.target);

  ROOM_BOX.getBoundingSphere(_sphere); // still used below to stand the light itself well clear of the room
  const SHADOW_EXTENTS = computeShadowExtents();

  /**
   * Point the key and fit its shadow. The extent is a constant square derived from the room's
   * bounding sphere rather than a per-angle tight fit, and the centre is snapped to whole shadow
   * texels: both are what stop the shadow edges from shimmering as the sun tracks down the sky.
   */
  function aimSun() {
    const centre = _sphere.center;
    sun.position.copy(centre).addScaledVector(day.sunDir, _sphere.radius + 6.0);
    sun.target.position.copy(centre);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();

    _axisZ.copy(day.sunDir).normalize();
    _axisX.set(0, 1, 0).cross(_axisZ);
    if (_axisX.lengthSq() < 1e-6) _axisX.set(1, 0, 0);
    _axisX.normalize();
    _axisY.copy(_axisZ).cross(_axisX).normalize();

    let dMin = Infinity;
    let dMax = -Infinity;
    let aMid = 0;
    let bMid = 0;
    _v2.copy(centre).sub(sun.position);
    aMid = _v2.dot(_axisX);
    bMid = _v2.dot(_axisY);
    for (let i = 0; i < 8; i++) {
      _corner.set(
        i & 1 ? ROOM_BOX.max.x : ROOM_BOX.min.x,
        i & 2 ? ROOM_BOX.max.y : ROOM_BOX.min.y,
        i & 4 ? ROOM_BOX.max.z : ROOM_BOX.min.z,
      ).sub(sun.position);
      const d = -_corner.dot(_axisZ); // depth along the camera's view direction
      if (d < dMin) dMin = d;
      if (d > dMax) dMax = d;
    }

    // Two independent texel sizes because the frustum is no longer square — see
    // computeShadowExtents() above. Each axis snaps to its own grid; that is still what stops the
    // shadow edges shimmering as the sun tracks down the sky, it is just two grids now instead of
    // one.
    const mapDim = Math.max(64, sun.shadow.mapSize.x);
    const texelA = (SHADOW_EXTENTS.a * 2) / mapDim;
    const texelB = (SHADOW_EXTENTS.b * 2) / mapDim;
    const aSnap = Math.round(aMid / texelA) * texelA;
    const bSnap = Math.round(bMid / texelB) * texelB;

    const cam = sun.shadow.camera;
    cam.left = aSnap - SHADOW_EXTENTS.a;
    cam.right = aSnap + SHADOW_EXTENTS.a;
    cam.bottom = bSnap - SHADOW_EXTENTS.b;
    cam.top = bSnap + SHADOW_EXTENTS.b;
    cam.near = Math.max(0.05, dMin - 0.6);
    cam.far = dMax + 0.6;
    cam.updateProjectionMatrix();
  }

  // ── 3. window softbox ─────────────────────────────────────────────────────────────────────
  let windowLight = null;
  let bounceLight = null;
  if (rich) {
    RectAreaLightUniformsLib.init();

    const w = FIXTURES.window;
    windowLight = new THREE.RectAreaLight(0xd6e6f6, 2.7, w.x1 - w.x0, w.y1 - w.y0);
    windowLight.name = 'light.window';
    windowLight.position.set((w.x0 + w.x1) * 0.5, (w.y0 + w.y1) * 0.5, w.z);
    windowLight.lookAt((w.x0 + w.x1) * 0.5, (w.y0 + w.y1) * 0.5, 0.6);
    group.add(windowLight);

    // The rug, doing what a five-metre cream bounce card does: filling the undersides of the
    // furniture and washing the raw slab so its formwork and its stains actually read. Sized
    // ~0.15 m past the physical rug on every side — r06 finding ("ottoman"): the ottoman sits at
    // x=-1.45, essentially right on the rug's literal x=-1.40 edge, so a card sized to match the
    // rug polygon exactly put it just past the light's footprint and left its -x face with no fill
    // at all. A first attempt widened this by a full metre, which instead dragged the ottoman's
    // *base* deep into the card's near-field — an area light this close to a receiver is far
    // brighter than its flat intensity number suggests, and it painted the whole object in the
    // bounce's raw warm hue instead of adding a modest fill. Kept small on purpose.
    const r = FIXTURES.rug;
    bounceLight = new THREE.RectAreaLight(0xffd9ae, 1.05, r.w + 0.3, r.d + 0.3);
    bounceLight.name = 'light.bounce';
    bounceLight.position.set(r.x, 0.03, r.z);
    bounceLight.lookAt(r.x, 3.0, r.z);
    group.add(bounceLight);
  }

  // A very low hemisphere term. On `rich` tiers this is nearly redundant with the IBL and is kept
  // small on purpose; on low/medium, where the probe is coarse, it is the safety net that keeps
  // the ceiling from going dead.
  const hemi = new THREE.HemisphereLight(0xc6d3dd, 0x9d9a95, rich ? 0.34 : 0.62);
  hemi.name = 'light.hemi';
  hemi.position.set(0, 2.6, -0.6);
  group.add(hemi);
  // r06 ("floor", "artwork"): the ground colour the daylight curve authors (hemiG) tracks the warm
  // rug bounce hue everywhere, including on walls and objects the rug bounce barely reaches, which
  // is part of why far surfaces read as one flat amber temperature instead of cool-key/warm-bounce.
  // Pulled toward a neutral cool grey here, in the one place both tiers actually apply it, rather
  // than hand-editing six keyframes' hex values.
  const HEMI_GROUND_COOL = new THREE.Color(0x93a1ad);
  const _hemiGround = new THREE.Color();

  // ── 4. practicals ─────────────────────────────────────────────────────────────────────────
  const lamp = new THREE.PointLight(0xffb774, 0.5, 5.5, 2);
  lamp.name = 'light.floorLamp';
  lamp.position.copy(FIXTURES.lamp);
  if (ultra) {
    lamp.castShadow = true;
    lamp.shadow.mapSize.set(512, 512);
    lamp.shadow.bias = -0.0016;
    lamp.shadow.normalBias = 0.02;
    lamp.shadow.camera.near = 0.06;
    lamp.shadow.camera.far = 6.0;
  }
  group.add(lamp);

  // r06 ("floorLamp"): the wall beside a lit 2700K shade measured *cooler* than neutral — the
  // fitting had no visible lighting signature of its own beyond the one point light. Two small,
  // non-shadow-casting splashes shape a warm ellipse above and below the shade so it reads as a
  // practical instead of a grey smudge; kept off `low`/`medium` since they are pure polish, not a
  // structural fix, and two extra unshadowed point lights are cheap but not free.
  let lampUp = null;
  let lampDown = null;
  if (rich) {
    lampUp = new THREE.PointLight(0xffb774, 0, 1.4, 2);
    lampUp.name = 'light.floorLampUp';
    lampUp.position.set(FIXTURES.lamp.x, FIXTURES.lamp.y + 0.16, FIXTURES.lamp.z);
    group.add(lampUp);
    lampDown = new THREE.PointLight(0xffb774, 0, 1.2, 2);
    lampDown.name = 'light.floorLampDown';
    lampDown.position.set(FIXTURES.lamp.x, FIXTURES.lamp.y - 0.04, FIXTURES.lamp.z);
    group.add(lampDown);
  }

  // r06 ("pendant"): widened from 4.6 to 7.0 so the ceiling slab (1.16 m above the fitting) is
  // still inside the falloff window once bulbIntensity is corrected below.
  const pendant = new THREE.PointLight(0xffb268, 0.4, 7.0, 2);
  pendant.name = 'light.pendant';
  pendant.position.copy(FIXTURES.pendant);
  group.add(pendant);

  // r06 ("parent"): the doorway threshold had no light of its own — the parent read as a flat
  // black-mask cutout with a razor shadow terminator across the face. Neither of these casts a
  // shadow (the sun's map already carries the real occlusion for the doorway architecture); they
  // exist purely so the character's face and silhouette separate from the hallway. `hallwayFill`
  // is the cool room-spill that puts the nose/cheekbones back; `hallwayRim` is a warm kicker from
  // behind that detaches the shoulder/hair edge from the wall, gated to `medium+` per CONTRACTS §5.
  const hallwayFill = new THREE.PointLight(0xbfd0e0, 0, 3.5, 2);
  hallwayFill.name = 'light.hallwayFill';
  hallwayFill.position.set(1.90, 1.45, 2.70);
  hallwayFill.castShadow = false;
  group.add(hallwayFill);

  let hallwayRim = null;
  if (tier !== 'low') {
    hallwayRim = new THREE.SpotLight(0xffd9ad, 0, 4.0, 0.55, 0.5, 1.4);
    hallwayRim.name = 'light.hallwayRim';
    hallwayRim.position.set(2.55, 1.90, 4.60);
    hallwayRim.target.position.set(1.90, 1.10, 3.40);
    hallwayRim.castShadow = false;
    group.add(hallwayRim);
    group.add(hallwayRim.target);
  }

  // The two emissive materials that belong to the fixtures. LIGHT owns how bright they read; MAT
  // owns what they are made of. Fetched lazily so a tier that never shows a lamp never builds them.
  let lampShadeMat = null;
  let bulbMat = null;
  let baseShadeEmissive = 1.6;
  let baseBulbEmissive = 7.0;
  let emissivesResolved = false;
  function resolveEmissives() {
    if (emissivesResolved || !ctx.materials) return;
    emissivesResolved = true;
    try {
      if (ctx.materials.has('emissive.lampshade')) {
        lampShadeMat = ctx.materials.get('emissive.lampshade');
        baseShadeEmissive = lampShadeMat.emissiveIntensity ?? 1.6;
      }
      if (ctx.materials.has('emissive.bulb')) {
        bulbMat = ctx.materials.get('emissive.bulb');
        baseBulbEmissive = bulbMat.emissiveIntensity ?? 7.0;
      }
    } catch (err) {
      console.warn('[light] could not reach the emissive fixture materials —', err);
    }
  }

  // ── 5. volumetrics ────────────────────────────────────────────────────────────────────────
  const shafts = quality.volumetrics ? createShafts(ctx, sun) : null;
  if (shafts) group.add(shafts.mesh);

  // ── applying a daylight state ─────────────────────────────────────────────────────────────
  // A whisper of aerial perspective. Exponential fog is overkill for a 7 m room, but at this
  // density it is worth about half a percent across the rug and 50% out at the neighbours' brick,
  // which is exactly the "something in the air" that separates a photograph from a render.
  let fog = null;

  function applyLights() {
    sun.color.copy(day.sunColour);
    sun.intensity = day.sunIntensity;
    sun.castShadow = day.sunIntensity > 0.05;
    aimSun();

    if (windowLight) {
      windowLight.color.copy(day.windowColour);
      windowLight.intensity = day.windowIntensity;
    }
    if (bounceLight) {
      bounceLight.color.copy(day.bounceColour);
      bounceLight.intensity = day.bounceIntensity;
    }
    hemi.color.copy(day.hemiSky);
    _hemiGround.copy(day.hemiGround).lerp(HEMI_GROUND_COOL, 0.45);
    hemi.groundColor.copy(_hemiGround);
    hemi.intensity = day.hemiIntensity * (rich ? 1 : 1.8);

    lamp.color.copy(day.lampColour);
    lamp.intensity = day.lampIntensity;
    if (lampUp) {
      lampUp.color.copy(day.lampColour);
      lampUp.intensity = day.lampIntensity * 0.55;
    }
    if (lampDown) {
      lampDown.color.copy(day.lampColour);
      lampDown.intensity = day.lampIntensity * 0.45;
    }
    pendant.color.copy(day.bulbColour);
    pendant.intensity = day.bulbIntensity;

    // Constant fixtures for a game-critical character read, not part of the day arc — scaled down
    // gently as the room goes dark so they don't read as their own light source at blue hour.
    const roomPresence = 0.35 + 0.65 * Math.min(1, day.envIntensity / 0.7);
    hallwayFill.intensity = 0.85 * roomPresence;
    if (hallwayRim) hallwayRim.intensity = 1.05 * roomPresence;

    resolveEmissives();
    if (lampShadeMat) lampShadeMat.emissiveIntensity = baseShadeEmissive * (0.30 + 0.85 * day.practical);
    if (bulbMat) bulbMat.emissiveIntensity = baseBulbEmissive * (0.34 + 0.80 * day.practical);

    if (shafts) {
      shafts.setSun(day.sunDir);
      shafts.setState(day);
    }

    if (engine) {
      if (!fog) {
        fog = new THREE.FogExp2(0xb6c4d1, day.fogDensity);
        engine.setFog(fog);
      }
      fog.color.copy(day.fogColour);
      fog.density = day.fogDensity;
    }

    scene.environmentIntensity = day.envIntensity;
    requestShadowUpdate();
  }

  // ── shadow refresh policy ─────────────────────────────────────────────────────────────────
  // The room is architecturally static: re-rasterising a 2048² map every frame for a slab that
  // never moves is pure waste. Shadows auto-update only while something is actually moving —
  // events and the baby's own displacement keep a short timer alive — and otherwise the map is
  // refreshed once, on demand.
  let motionTimer = 1.2;
  let autoShadow = true;
  let framesRendered = 0;
  const lastBabyPos = new THREE.Vector3(NaN, NaN, NaN);

  function requestShadowUpdate() {
    if (engine) engine.shadowNeedsUpdate();
    else renderer.shadowMap.needsUpdate = true;
  }

  function poke() {
    motionTimer = Math.max(motionTimer, 0.45);
  }

  function setShadowAuto(on) {
    if (autoShadow === on) return;
    autoShadow = on;
    if (engine) engine.setShadowAutoUpdate(on);
    else {
      renderer.shadowMap.autoUpdate = on;
      if (!on) renderer.shadowMap.needsUpdate = true;
    }
  }

  // ── pendant / fixture discovery ───────────────────────────────────────────────────────────
  // FURN builds the bulb and PHYS hangs it off a spherical joint. We do not own either, so we go
  // looking for it: the pendulum list first, then the prop registry, then the scene graph by name.
  let pendantObject = null;
  let lampObject = null;
  let discoverClock = 0;
  const PENDANT_RE = /pendant|bulb/i;
  const LAMP_RE = /floor.?lamp|lampshade|shade/i;

  function attachPendant(object3d) {
    if (object3d && object3d.isObject3D) pendantObject = object3d;
    return pendantObject;
  }
  function attachFloorLamp(object3d) {
    if (object3d && object3d.isObject3D) lampObject = object3d;
    return lampObject;
  }

  function discover() {
    if (!pendantObject) {
      const pends = ctx.physics?.pendulums;
      if (pends) {
        for (const p of pends) {
          if (p?.object3d && PENDANT_RE.test(p.object3d.name || '')) {
            pendantObject = p.object3d;
            break;
          }
        }
        // Only one pendulum in the room hangs from the slab; if nothing is named, take the first
        // whose anchor is up at ceiling height.
        if (!pendantObject) {
          for (const p of pends) {
            if (p?.object3d && p.anchor && p.anchor.y > 2.3) {
              pendantObject = p.object3d;
              break;
            }
          }
        }
      }
    }
    if (!pendantObject && ctx.props?.list) {
      for (const prop of ctx.props.list) {
        if (prop.object3d && PENDANT_RE.test(prop.id || '')) {
          pendantObject = prop.object3d;
          break;
        }
      }
    }
    if (!pendantObject) {
      scene.traverse((o) => {
        if (!pendantObject && o !== group && PENDANT_RE.test(o.name || '') && o.isObject3D) pendantObject = o;
      });
    }
    if (!lampObject) {
      scene.traverse((o) => {
        if (!lampObject && o !== group && LAMP_RE.test(o.name || '') && o.isObject3D) lampObject = o;
      });
    }
  }

  // ── event wiring ──────────────────────────────────────────────────────────────────────────
  const offs = [];
  const events = ctx.events;
  if (events) {
    const wake = () => poke();
    for (const name of ['prop:toppled', 'prop:shattered', 'prop:pulled', 'prop:eaten',
      'baby:crawl', 'baby:bump', 'fx:impact', 'parent:state', 'game:start']) {
      offs.push(events.on(name, wake));
    }
    offs.push(events.on('light:timeOfDay', (p) => {
      if (p && Number.isFinite(p.t)) api.setTimeOfDay(p.t, { immediate: !!p.immediate });
    }));
    offs.push(events.on('light:pendant', (p) => attachPendant(p?.object3d || p)));
    offs.push(events.on('light:floorLamp', (p) => attachFloorLamp(p?.object3d || p)));
    offs.push(events.on('game:start', () => {
      autoAdvance = true;
      manualHoldFor = 0;
    }));
  }

  /** Tell FX where the light shafts are so it can hang dust motes in them. */
  function publishShafts() {
    if (!events) return;
    const payload = shafts
      ? { enabled: shafts.intensity > 0.01, ...shafts.describe() }
      : { enabled: false };
    if (ctx.fx?.setLightShafts) ctx.fx.setLightShafts(payload);
    else if (ctx.fx?.dust) ctx.fx.dust(payload);
    events.emit('light:shafts', payload);
  }

  // ── env rebuild throttle ──────────────────────────────────────────────────────────────────
  const REBUILD_INTERVAL = tier === 'low' ? 2.4 : tier === 'medium' ? 1.2 : 0.55;
  const REBUILD_DELTA = tier === 'low' ? 0.10 : tier === 'medium' ? 0.045 : 0.018;
  let bakedTime = -1;
  let rebuildClock = 0;

  // ── exposure ──────────────────────────────────────────────────────────────────────────────
  let exposureBias = 1.0;
  let lastExposure = -1;
  function pushExposure() {
    const target = day.exposure * exposureBias;
    if (Math.abs(target - lastExposure) < 0.002) return;
    lastExposure = target;
    ctx.postfx?.setExposure?.(target);
  }

  // ── the module ────────────────────────────────────────────────────────────────────────────
  const api = {
    sun,
    hemi,
    lamp,
    pendant,
    group,
    shafts,
    get env() {
      return envTexture;
    },
    get windowLight() {
      return windowLight;
    },
    get bounceLight() {
      return bounceLight;
    },
    get timeOfDay() {
      return timeOfDay;
    },
    daylight: day,

    /** Put everything into the scene. Idempotent — safe to call again after a reset. */
    applyToScene() {
      if (group.parent !== scene) scene.add(group);
      applyLights();
      bakeEnvironment();
      bakedTime = timeOfDay;
      pushExposure();
      publishShafts();
      return api;
    },

    /**
     * Move the clock. `t` is 0..1 across 16:30 → 18:45, or an hour like 17.75.
     * @param {number} t
     * @param {{immediate?: boolean, manual?: boolean}} [opts] `immediate` rebakes the IBL on the
     *   spot rather than waiting for the throttle; `manual` (default true) parks the automatic
     *   drift for a few seconds so a scripted change is not immediately overridden.
     */
    setTimeOfDay(t, opts = {}) {
      timeOfDay = normaliseTime(t);
      evaluate(timeOfDay, day);
      applyLights();
      pushExposure();
      if (opts.manual !== false) manualHoldFor = 4.0;
      if (opts.immediate || Math.abs(timeOfDay - bakedTime) > 0.22) {
        bakeEnvironment();
        bakedTime = timeOfDay;
        publishShafts();
      }
      return api;
    },

    /** Let the round's timer drag the sun down, or stop it doing that. */
    setAutoAdvance(on) {
      autoAdvance = !!on;
      return api;
    },

    /** Multiplies the exposure the grade rides at; 1.0 is the authored look. */
    setExposureBias(b) {
      exposureBias = b > 0 ? b : 1;
      pushExposure();
      return api;
    },

    /** Refresh the shadow map on the next render. The room is static, so this is how it moves. */
    requestShadowUpdate,

    attachPendant,
    attachFloorLamp,

    /** The direction photons travel through the room, for anyone aligning to the key. */
    sunDirection(out = new THREE.Vector3()) {
      return out.copy(day.sunDir).negate();
    },

    update(dt) {
      framesRendered++;
      const photo = ctx.state?.mode === 'photo';
      const playing = ctx.state?.mode === 'playing';
      const step = photo ? 0 : Math.min(0.05, Math.max(0, dt || 0));

      // --- the clock ---------------------------------------------------------------------
      if (manualHoldFor > 0) manualHoldFor -= step;
      if (playing && autoAdvance && manualHoldFor <= 0) {
        const total = ctx.state.roundLength || 180;
        const left = Number.isFinite(ctx.state.timeLeft) ? ctx.state.timeLeft : total;
        // 0.26 → 0.88: starts in full afternoon, ends deep in the golden hour with the practicals
        // taking over. Never all the way to blue hour, because the player still has to see.
        const want = 0.26 + 0.62 * (1 - Math.min(1, Math.max(0, left / total)));
        if (Math.abs(want - timeOfDay) > 0.0004) {
          timeOfDay = want;
          evaluate(timeOfDay, day);
          applyLights();
          pushExposure();
        }
      }

      // --- IBL rebuild, throttled --------------------------------------------------------
      if (!photo) {
        rebuildClock += step;
        if (rebuildClock >= REBUILD_INTERVAL
          && (Math.abs(timeOfDay - bakedTime) > REBUILD_DELTA
            || Math.abs(day.envIntensity - appliedEnvIntensity) > 0.03)) {
          rebuildClock = 0;
          bakeEnvironment();
          bakedTime = timeOfDay;
          publishShafts();
        }
      }

      // --- fixtures ----------------------------------------------------------------------
      if (!pendantObject || !lampObject) {
        discoverClock += step;
        if (framesRendered < 4 || discoverClock > 0.4) {
          discoverClock = 0;
          if (framesRendered < 900) discover();
        }
      }
      if (pendantObject) {
        pendantObject.getWorldPosition(_v1);
        // Sit a couple of centimetres below the glass envelope: the filament, not the fitting.
        if (_v1.lengthSq() > 1e-6 && !pendant.position.equals(_v1)) {
          if (pendant.position.distanceToSquared(_v1) > 1e-8) poke();
          pendant.position.set(_v1.x, _v1.y - 0.015, _v1.z);
        }
      }
      if (lampObject) {
        lampObject.getWorldPosition(_v1);
        if (_v1.lengthSq() > 1e-6) {
          lamp.position.set(_v1.x, _v1.y - 0.02, _v1.z);
          if (lampUp) lampUp.position.set(_v1.x, _v1.y + 0.14, _v1.z);
          if (lampDown) lampDown.position.set(_v1.x, _v1.y - 0.06, _v1.z);
        }
      }

      // --- shadow refresh policy ---------------------------------------------------------
      const baby = ctx.baby?.group || ctx.baby?.object3d || null;
      if (baby) {
        baby.getWorldPosition(_v1);
        if (Number.isNaN(lastBabyPos.x) || _v1.distanceToSquared(lastBabyPos) > 2.5e-7) {
          lastBabyPos.copy(_v1);
          poke();
        }
      } else if (playing) {
        poke();
      }
      const settling = framesRendered < (photo ? 110 : 30);
      if (settling) {
        setShadowAuto(true);
      } else if (motionTimer > 0) {
        motionTimer -= step || 1 / 60;
        setShadowAuto(true);
      } else {
        setShadowAuto(false);
      }

      // --- volumetrics -------------------------------------------------------------------
      if (shafts) {
        shafts.setTime(photo ? 7.25 : ctx.elapsed || 0);
        shafts.layout(ctx.camera);
      }
    },

    resize() {
      // Slice footprints are recomputed from the camera every frame; nothing to do here.
    },

    reset() {
      api.setTimeOfDay(DEFAULT_TIME, { immediate: true, manual: false });
      autoAdvance = true;
      manualHoldFor = 0;
      motionTimer = 1.0;
      framesRendered = 0;
      lastBabyPos.set(NaN, NaN, NaN);
      return api;
    },

    /** Debug read-out for `?stats=1`. No user-visible strings live here. */
    state() {
      return {
        clock: clockLabel(timeOfDay),
        t: timeOfDay,
        elevation: day.elevation,
        azimuth: day.azimuth,
        sun: day.sunIntensity,
        env: day.envIntensity,
        exposure: day.exposure * exposureBias,
        practical: day.practical,
        shafts: shafts ? shafts.intensity : 0,
        softShadows: softShadowsPatched,
        autoShadow,
      };
    },

    dispose() {
      for (const off of offs) {
        try {
          off?.();
        } catch {
          /* ignore */
        }
      }
      offs.length = 0;
      if (group.parent) group.parent.remove(group);
      sun.dispose();
      hemi.dispose();
      lamp.dispose();
      lampUp?.dispose?.();
      lampDown?.dispose?.();
      pendant.dispose();
      hallwayFill.dispose();
      hallwayRim?.dispose?.();
      windowLight?.dispose?.();
      bounceLight?.dispose?.();
      shafts?.dispose();
      probe.dispose();
      backdrop.dispose();
      skyMaterial.dispose();
      backdropTarget.dispose();
      envTarget?.dispose();
      pmrem.dispose();
      envTexture = null;
      if (scene.environment) scene.environment = null;
      if (scene.background === backdropTarget.texture) scene.background = null;
      engine?.setFog?.(null);
      ctx.materials?.setEnvironment?.(null, 1);
      setShadowAuto(true);
      restoreSoftShadows();
    },
  };

  api.applyToScene();
  ctx.track?.(api);
  return api;
}
