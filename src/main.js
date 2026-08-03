// OPERATION NAPTIME — integrator.
//
// Boot order matters: quality → engine → i18n → physics → materials → lighting → world →
// characters → gameplay → UI → post-processing (last, because it wraps the final scene/camera).
// Every module is a factory that takes ctx and returns an object with optional lifecycle hooks.
// This file is owned by the integrator; module agents must not edit it.

import * as THREE from 'three';
import { createEventBus } from './core/eventbus.js';
import { createContext } from './core/context.js';
import { detectTier, makeQuality } from './core/quality.js';
import { createAdaptive } from './core/adaptive.js';
import { rng, makeRng, rand, randInt, pick, jitter, gauss } from './core/rng.js';
import { getShot } from './core/shots.js';

import { createEngine } from './core/engine.js';
import { createPostFX } from './core/postfx.js';
import { createI18n } from './i18n/strings.js';
import { createPhysics } from './physics/physics.js';
import { createMaterialLibrary } from './world/materials.js';
import { createLighting } from './world/lighting.js';
import { LAYOUT } from './world/layout.js';
import { buildRoom } from './world/room.js';
import { buildFurniture } from './world/furniture.js';
import { buildDressing } from './world/dressing.js';
import { createFX } from './fx/particles.js';
import { createBaby } from './player/baby.js';
import { createCameraRig } from './player/camera.js';
import { createInput } from './player/input.js';
import { createParent } from './ai/parent.js';
import { createRules } from './gameplay/rules.js';
import { createInteractions } from './gameplay/interactions.js';
import { createAudio } from './audio/audio.js';
import { createHUD } from './ui/hud.js';
import { createMenus } from './ui/menus.js';

const params = new URLSearchParams(location.search);
const bootFill = document.getElementById('boot-fill');
const bootStep = document.getElementById('boot-step');
const bootEl = document.getElementById('boot');

let stepIndex = 0;
const TOTAL_STEPS = 15;
function step(label) {
  stepIndex++;
  if (bootFill) bootFill.style.right = `${Math.max(0, 100 - (stepIndex / TOTAL_STEPS) * 100)}%`;
  if (bootStep) bootStep.textContent = label;
  // Yield so the browser can actually paint the progress bar between heavy build phases.
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

function fatal(err) {
  console.error(err);
  const el = document.getElementById('boot-err');
  if (el) el.textContent = `${err?.message || err}\n\n${err?.stack || ''}`.slice(0, 1400);
  if (bootStep) bootStep.textContent = 'failed to start';
}

async function boot() {
  const canvas = document.getElementById('view');
  const events = createEventBus();

  const qualityName = params.get('quality') || localStorage.getItem('on.quality') || detectTier();
  const quality = makeQuality(qualityName);

  await step('renderer');
  const engine = createEngine(canvas, quality);
  const { renderer, scene, camera } = engine;

  const ctx = createContext({
    renderer,
    scene,
    camera,
    engine,
    quality,
    events,
    rngFns: { rng, makeRng, rand, randInt, pick, jitter, gauss },
  });
  ctx.layout = LAYOUT;
  ctx.debug.enabled = params.has('stats');

  const shotName = params.get('shot');
  const shot = shotName ? getShot(shotName) : null;
  if (shot) {
    ctx.state.mode = 'photo';
    ctx.state.shot = shotName;
  }

  await step('language');
  const lang = params.get('lang') || localStorage.getItem('on.lang') || (navigator.language?.startsWith('es') ? 'es' : 'en');
  ctx.i18n = createI18n(lang);
  document.documentElement.lang = ctx.i18n.lang;

  await step('physics');
  ctx.physics = await createPhysics(ctx);

  await step('materials');
  ctx.materials = createMaterialLibrary(ctx);
  if (ctx.materials.prewarm) await ctx.materials.prewarm();

  await step('lighting');
  ctx.lighting = createLighting(ctx);

  await step('architecture');
  const room = buildRoom(ctx);
  scene.add(room.group);

  await step('furniture');
  const furniture = buildFurniture(ctx);
  scene.add(furniture.group);

  await step('set dressing');
  const dressing = buildDressing(ctx);
  scene.add(dressing.group);

  await step('effects');
  ctx.fx = createFX(ctx);

  await step('audio');
  ctx.audio = createAudio(ctx);

  await step('protagonist');
  const baby = createBaby(ctx);
  ctx.baby = baby;
  if (baby.group) scene.add(baby.group);

  const cameraRig = createCameraRig(ctx, baby);
  const input = createInput(ctx);
  ctx.input = input;

  await step('the parent');
  const parent = createParent(ctx);
  ctx.parent = parent;
  if (parent.group) scene.add(parent.group);

  await step('rules');
  const rules = createRules(ctx);
  const interactions = createInteractions(ctx);

  await step('interface');
  const hud = createHUD(ctx);
  const menus = createMenus(ctx);
  if (params.has('nohud')) hud.setVisible?.(false);

  await step('post-processing');
  const postfx = createPostFX(ctx);
  ctx.postfx = postfx;

  // ---------------------------------------------------------------------------------------
  const modules = [
    ctx.lighting,
    ctx.physics,
    room,
    furniture,
    dressing,
    ctx.materials,
    input,
    baby,
    cameraRig,
    parent,
    interactions,
    rules,
    ctx.fx,
    ctx.audio,
    hud,
    menus,
    postfx,
  ].filter(Boolean);

  // Rigs that are attached after the module list is frozen (the free-fly camera, mostly).
  const modulesLate = [];

  const call = (hook, ...args) => {
    for (const m of [...modules, ...modulesLate]) {
      if (typeof m[hook] === 'function') {
        try {
          m[hook](...args);
        } catch (err) {
          console.error(`[${hook}]`, err);
        }
      }
    }
  };

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    engine.resize(w, h);
    call('resize', w, h);
  }
  window.addEventListener('resize', resize, { passive: true });
  resize();

  // Dynamic resolution. Off in photo mode and in the free-fly camera, both of which want a fixed
  // buffer; `?noadaptive=1` pins it for anyone benchmarking a specific resolution.
  const adaptive = createAdaptive(ctx, {
    targetFps: 60,
    enabled: !shot && !params.has('noadaptive'),
    onResize: () => call('resize', window.innerWidth, window.innerHeight),
  });
  ctx.adaptive = adaptive;

  // --- settle -----------------------------------------------------------------------------
  // Fast-forward the simulation so nothing is visibly dropping into place on the first frame.
  try {
    ctx.physics.settle?.(1.6);
  } catch (err) {
    console.warn('[settle]', err);
  }

  // --- optional debug rigs ------------------------------------------------------------------
  if (params.get('debug') === 'phys') {
    const dbg = ctx.physics.debugMesh?.();
    if (dbg) scene.add(dbg);
  }
  if (params.has('free')) {
    const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.6, -1.2);
    camera.position.set(0.2, 1.9, 3.6);
    controls.enableDamping = true;
    modulesLate.push({ update: () => controls.update() });
    // Freeze the character/camera modules the same way photo mode does, so the rig does not
    // fight OrbitControls for the camera; `free` distinguishes it for anything that cares.
    ctx.state.mode = 'photo';
    ctx.state.free = true;
    hud.setVisible?.(false);
    menus.setVisible?.(false);
    document.getElementById('view').style.cursor = 'grab';
  }

  // --- photo mode --------------------------------------------------------------------------
  if (shot) {
    if (shot.pos) {
      camera.position.fromArray(shot.pos);
      camera.lookAt(new THREE.Vector3().fromArray(shot.target));
      camera.fov = shot.fov || 55;
      camera.updateProjectionMatrix();
    }
    // A shot's `dof` is the focus distance in metres; 0 means hyperfocal (nothing blurs).
    postfx.setFocusDistance?.(shot.dof || 0);
    hud.setVisible?.(false);
    menus.setVisible?.(false);
    document.getElementById('view').style.cursor = 'default';
  }

  // --- the loop ----------------------------------------------------------------------------
  const clock = new THREE.Clock();
  const FIXED = 1 / 60;
  let accumulator = 0;
  let framesRendered = 0;

  function frame() {
    requestAnimationFrame(frame);
    const raw = clock.getDelta();
    const dt = Math.min(raw, 0.05);
    ctx.dt = dt;

    const playing = ctx.state.mode === 'playing';
    const photo = ctx.state.mode === 'photo';

    if (playing) {
      ctx.elapsed += dt;
      accumulator += dt;
      let steps = 0;
      while (accumulator >= FIXED && steps < 5) {
        call('fixedUpdate', FIXED, ctx);
        accumulator -= FIXED;
        steps++;
      }
    } else if (photo && framesRendered < 90) {
      // Let the world settle (cloth, physics rest, TAA convergence) before the harness shoots.
      accumulator += FIXED;
      while (accumulator >= FIXED) {
        call('fixedUpdate', FIXED, ctx);
        accumulator -= FIXED;
      }
    }

    call('update', dt, ctx);
    call('lateUpdate', dt, ctx);

    postfx.render(dt);
    // After the render, so the delta it measures is a whole frame including the present.
    adaptive.update(dt);
    framesRendered++;

    if (framesRendered === 3 && bootEl && !bootEl.classList.contains('done')) {
      bootEl.classList.add('done');
      setTimeout(() => bootEl.remove(), 1000);
      events.emit('boot:done');
    }
    if (!window.__READY__ && framesRendered >= (photo ? 100 : 12)) {
      window.__READY__ = true;
    }
  }

  window.__GAME__ = ctx;
  window.__SHOT__ = shotName || null;
  frame();

  if (!shot) {
    ctx.state.mode = 'menu';
    menus.showMain?.();
  }
}

boot().catch(fatal);
window.addEventListener('unhandledrejection', (e) => fatal(e.reason));
