// OPERATION NAPTIME — BABY — the protagonist. CONTRACTS.md §2 (scale), §11 (physics), §7 (photo).
//
// Three systems stacked on each other, in this order every fixed step:
//
//  1. THE CONTROLLER. A kinematic capsule (a cylinder, actually — see physics.js on why a rounded
//     sole never climbs a sill) driven with real inertia: 4.2 m/s² of acceleration, 14 rad/s² of
//     angular acceleration and a top speed of 1.15 m/s, or 2.0 for the four seconds of sprint the
//     stamina bar allows. Nothing here snaps to a heading; a baby at full tilt overshoots its turn.
//     The horizontal velocity is re-read from the translation the controller actually applied, so
//     crawling into the sofa stops the legs instead of pedalling on the spot.
//  2. AUTO-DUCK. A ray straight up finds the coffee table's underside at 0.35 m; the collider
//     shrinks from 0.58 m to 0.31 m tall, the body drops to keep the sole planted, the pose
//     flattens and camera.js takes the eye down with it. Un-ducking is gated on real clearance so
//     the baby can never inflate inside the table.
//  3. THE POSE. gait.js owns the crawl; rig.js turns it into bones. This file only feeds it the
//     state it needs and forwards the events other modules care about.
//
// Photo mode is a separate, deterministic path: the contacts are seeded analytically for a steady
// crawl, the phase is frozen at 0.90 (right hand descending into its plant, left knee in flight),
// every spring is snapped to its target rather than integrated, and the head turns toward whatever
// camera the shot placed. Two runs produce identical pixels.

import * as THREE from 'three';
import { makeRng } from '../core/rng.js';
import { getShot } from '../core/shots.js';
import { buildBabyMesh } from './baby/mesh.js';
import { createRig } from './baby/rig.js';
import { createGait } from './baby/gait.js';
import { A } from './baby/anatomy.js';

const BASE_SPEED = 1.15;
const SPRINT_SPEED = 2.00;
const ACCEL = 4.2;
const DECEL = 7.6;
const ANG_ACCEL = 14.0;
const ANG_MAX = 3.6;
const STAMINA_DRAIN = 1 / 4.0;   // four seconds of sprint
const STAMINA_REFILL = 1 / 9.0;  // and nine to get it back
const STAND_HALF = 0.29;         // collider half-height, standing (0.16 radius + 0.13 half-height)
const DUCK_HALF = 0.155;
const DUCK_ENTER = 0.575;        // headroom that forces a duck
const DUCK_EXIT = 0.700;         // and the headroom needed to come back up
const CRAWL_EVENT_HZ = 12;

/** Where the baby poses for the two dedicated review shots. Faces halfway between both cameras. */
const PHOTO_POSE = { x: 0.619, z: -0.792, heading: 1.287, phase: 0.90, speed: 0.95 };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const wrapPi = (a) => {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
};

export function createBaby(ctx) {
  const events = ctx.events;
  const layout = ctx.layout;
  const start = (layout && layout.baby && layout.baby.start) || { x: 0, y: 0.30, z: 1.55, heading: Math.PI };
  // LAYOUT stores the heading in a +Z-forward convention; the model faces -Z, hence the half turn.
  const START_HEADING = wrapPi((start.heading || 0) + Math.PI);

  const rand = makeRng(0xba61ee);
  const photo = ctx.state.mode === 'photo';
  const shot = photo ? getShot(ctx.state.shot) : null;

  // ── the body ────────────────────────────────────────────────────────────────────────────────
  const mesh = buildBabyMesh(ctx);
  const rig = createRig(mesh);
  const group = mesh.group;
  group.position.set(start.x, 0, start.z);
  group.rotation.y = START_HEADING;

  // ── physics ─────────────────────────────────────────────────────────────────────────────────
  let foot = STAND_HALF;
  let colliderHalf = STAND_HALF;
  const character = ctx.physics && ctx.physics.addCharacter
    ? ctx.physics.addCharacter({ x: start.x, y: start.y + 0.02, z: start.z }, {
      radius: 0.16, halfHeight: 0.13, mass: 9.0, autostep: 0.12, snapToGround: 0.09,
    })
    : null;
  const canResize = !!(character && character.collider && typeof character.collider.setHalfHeight === 'function');

  // ── state ───────────────────────────────────────────────────────────────────────────────────
  const velocity = new THREE.Vector3();
  const applied = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const look = { yaw: START_HEADING, pitch: 0.12 };
  let heading = START_HEADING;
  let angVel = 0;
  let vy = 0;
  let stamina = 1;
  let sprintLock = false;
  let duckAmt = 0;
  let wantDuck = false;
  let eyeHeight = A.eyeHeight;
  let grounded = true;
  let crawlClock = 0;
  let bumpClock = 0;
  let surface = null;
  let mouthOpen = 0;
  let lungeTime = 0;
  const lungeDir = new THREE.Vector3();
  let reachProp = null;
  let blink = 0;
  let blinkIn = 2.4 + rand() * 3.0;
  let saccadeIn = 0.8;
  const saccadeAim = { x: 0, y: 0 };

  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _origin = new THREE.Vector3();
  const _up = { x: 0, y: 1, z: 0 };
  const _down = { x: 0, y: -1, z: 0 };
  const gaitState = {
    pos: group.position, heading: 0, speed: 0, angVel: 0, grounded: true,
    duck: 0, lookYaw: 0, lookPitch: 0, sprint: 0, mouth: 0,
  };

  // ── ground probing ──────────────────────────────────────────────────────────────────────────
  // The gait plants contacts in world space and needs the floor height wherever a hand lands: the
  // rucked lip of the rug, the padded play mat, the playpen sill. One short ray per plant.
  function probe(x, z, fallbackY) {
    const phys = ctx.physics;
    if (!phys || !phys.raycast) return fallbackY;
    _origin.set(x, fallbackY + 0.36, z);
    const hit = phys.raycast(_origin, _down, 0.80, character ? { exclude: character.collider } : undefined);
    if (!hit) return fallbackY;
    // Never let a probe find the ceiling of something the baby is under, or a fallen prop's top
    // more than a hand's height above the floor.
    if (hit.point.y > fallbackY + 0.22) return fallbackY;
    return hit.point.y;
  }

  const gait = createGait(ctx, {
    probe,
    rand,
    emit: (kind, limb) => {
      if (kind === 'plant' && limb && limb.def.kind === 'hand' && ctx.state.mode === 'playing') {
        // Audio paces its own footsteps off baby:crawl; this is only for FX that want the beat.
        events.emit('baby:step', { limb: limb.def.name, position: limb.plant, speed: velocity.length() });
      }
    },
  });

  // ── helpers ─────────────────────────────────────────────────────────────────────────────────

  function setBodyY(y) {
    if (!character) return;
    character.position(_v2);
    _v2.y = y;
    character.setPosition(_v2);
  }

  function syncFromCharacter() {
    if (!character) return;
    character.position(_v2);
    group.position.set(_v2.x, _v2.y - foot, _v2.z);
  }

  function surfaceName() {
    const obj = character && character.groundObject;
    const mat = character && character.groundMaterial;
    const hay = `${obj && obj.name ? obj.name : ''} ${mat || ''}`.toLowerCase();
    if (/playmat|\bmat\b|foam|playpen/.test(hay)) return 'mat';
    if (/rug|wool|carpet/.test(hay)) return 'rug';
    if (/floor|wood|plank|concrete|screed/.test(hay)) return 'wood';
    return null; // let AUDIO fall back to its own zone test
  }

  // ── movement ────────────────────────────────────────────────────────────────────────────────

  function updateDuck(dt) {
    const phys = ctx.physics;
    if (!phys || !phys.raycast || !canResize) {
      duckAmt = 0;
      return;
    }
    const gy = group.position.y;
    const ex = character ? { exclude: character.collider } : undefined;
    _origin.set(group.position.x, gy + 0.10, group.position.z);
    const up = phys.raycast(_origin, _up, 0.95, ex);
    let head = up ? up.distance + 0.10 : 9;
    // Look a little ahead as well, so the duck starts before the forehead arrives.
    const fx = -Math.sin(heading) * 0.26;
    const fz = -Math.cos(heading) * 0.26;
    _origin.set(group.position.x + fx, gy + 0.10, group.position.z + fz);
    const ahead = phys.raycast(_origin, _up, 0.95, ex);
    if (ahead) head = Math.min(head, ahead.distance + 0.10);

    if (!wantDuck && head < DUCK_ENTER) wantDuck = true;
    else if (wantDuck && head > DUCK_EXIT) wantDuck = false;

    const target = wantDuck ? 1 : 0;
    duckAmt += (target - duckAmt) * clamp01(dt * 7);
    if (duckAmt < 0.004) duckAmt = 0;
    if (duckAmt > 0.996) duckAmt = 1;

    const half = STAND_HALF - (STAND_HALF - DUCK_HALF) * duckAmt;
    if (Math.abs(half - colliderHalf) > 0.0005) {
      const delta = half - colliderHalf;
      colliderHalf = half;
      character.collider.setHalfHeight(half);
      foot = half;
      character.footOffset = half; // interactions.js reads this when it scripts a climb
      character.position(_v2);
      setBodyY(_v2.y + delta); // keep the sole where it was
    }
  }

  function fixedUpdate(dt) {
    if (photo) return;
    if (!ctx.state || ctx.state.mode !== 'playing') {
      syncFromCharacter();
      return;
    }
    if (ctx.state.climbing) {
      // interactions.js is scripting a hop onto a ledge; follow it rather than fight it.
      syncFromCharacter();
      velocity.set(0, 0, 0);
      vy = 0;
      return;
    }

    const inp = (ctx.input && ctx.input.state) || {};
    let f = clamp(inp.forward || 0, -1, 1);
    let r = clamp(inp.strafe || 0, -1, 1);
    let mag = Math.hypot(f, r);
    if (mag > 1) { f /= mag; r /= mag; mag = 1; }

    // --- stamina ------------------------------------------------------------------------------
    const wantSprint = !!inp.sprint && mag > 0.1 && !sprintLock;
    if (wantSprint && stamina > 0) {
      stamina -= STAMINA_DRAIN * dt;
      if (stamina <= 0) { stamina = 0; sprintLock = true; }
    } else {
      stamina = clamp01(stamina + STAMINA_REFILL * dt);
      if (sprintLock && stamina > 0.30) sprintLock = false;
    }
    const sprinting = wantSprint && stamina > 0;
    if (ctx.state) {
      ctx.state.stamina = stamina;
      ctx.state.sprinting = sprinting;
    }

    // --- desired velocity ---------------------------------------------------------------------
    const sy = Math.sin(look.yaw);
    const cy = Math.cos(look.yaw);
    const dirX = -sy * f + cy * r;
    const dirZ = -cy * f - sy * r;
    const speedMul = (ctx.state && ctx.state.speedMultiplier) || 1;
    const top = (sprinting ? SPRINT_SPEED : BASE_SPEED) * speedMul * (1 - duckAmt * 0.30);
    desired.set(dirX * top, 0, dirZ * top);

    // A headbutt is a scripted lunge: it overrides the stick for its duration.
    if (lungeTime > 0) {
      lungeTime = Math.max(0, lungeTime - dt);
      desired.copy(lungeDir).multiplyScalar(top * 1.55);
    }

    const rate = (mag > 0.05 || lungeTime > 0 ? ACCEL : DECEL) * (0.55 + 0.45 * (1 - duckAmt));
    _v.copy(desired).sub(velocity);
    const step = rate * dt;
    if (_v.lengthSq() > step * step) _v.setLength(step);
    velocity.add(_v);
    velocity.y = 0;

    // --- turning, with momentum -----------------------------------------------------------------
    let desiredHeading = look.yaw;
    if (mag > 0.05) {
      const moveH = Math.atan2(-dirX, -dirZ);
      // Blend toward the look direction so a pure strafe crawls diagonally rather than sideways —
      // a ten-month-old has no sidestep, and the head can only twist so far off the shoulders.
      desiredHeading = moveH + wrapPi(look.yaw - moveH) * 0.42;
    }
    const err = wrapPi(desiredHeading - heading);
    const wTarget = clamp(err * 6.4, -ANG_MAX, ANG_MAX);
    angVel += clamp(wTarget - angVel, -ANG_ACCEL * dt, ANG_ACCEL * dt);
    heading = wrapPi(heading + angVel * dt);

    // --- duck & gravity --------------------------------------------------------------------------
    updateDuck(dt);
    vy -= 9.81 * dt;
    if (grounded && vy < 0) vy = -1.2;
    vy = clamp(vy, -12, 6);

    // --- move ------------------------------------------------------------------------------------
    if (character) {
      _v.set(velocity.x * dt, vy * dt, velocity.z * dt);
      const out = character.move(_v, dt);
      applied.copy(out);
      grounded = character.grounded;
      if (grounded && vy < 0) vy = 0;
      // The controller is the authority on how far we got: hitting the sofa must stop the legs.
      if (dt > 1e-5) {
        velocity.x = applied.x / dt;
        velocity.z = applied.z / dt;
      }
      character.position(_v2);
      group.position.set(_v2.x, _v2.y - foot, _v2.z);
      reportShoves();
    } else {
      group.position.x += velocity.x * dt;
      group.position.z += velocity.z * dt;
    }

    group.rotation.y = heading;

    // --- events ------------------------------------------------------------------------------------
    crawlClock -= dt;
    if (crawlClock <= 0) {
      crawlClock = 1 / CRAWL_EVENT_HZ;
      const s = Math.hypot(velocity.x, velocity.z);
      surface = surfaceName();
      events.emit('baby:crawl', { speed: s, surface, sprinting, position: group.position });
    }
    if (bumpClock > 0) bumpClock -= dt;
  }

  /** Turn the controller's contact list into one bump event per real collision. */
  function reportShoves() {
    if (!character || !character.pushed || !character.pushed.length) return;
    let best = null;
    for (let i = 0; i < character.pushed.length; i++) {
      const p = character.pushed[i];
      if (!best || p.impulse > best.impulse) best = p;
    }
    if (!best || best.impulse < 0.30 || bumpClock > 0) return;
    bumpClock = 0.22;
    const force = clamp(best.impulse * 2.4, 0.5, 12);
    gait.bump(force);
    events.emit('baby:bump', {
      force,
      position: { x: best.point.x, y: best.point.y, z: best.point.z },
      normal: { x: -velocity.x, y: 0, z: -velocity.z },
      prop: best.prop || null,
    });
    // Charging head-first into something solid at speed puts a baby on its face.
    if (lungeTime > 0 && force > 4.5) {
      gait.faceplant();
      events.emit('camera:shake', { amount: 0.55, duration: 0.4 });
    }
  }

  // ── per-frame ───────────────────────────────────────────────────────────────────────────────

  function updateLook(dt) {
    const inp = (ctx.input && ctx.input.state) || {};
    const l = inp.look;
    if (l && ctx.state.mode === 'playing') {
      look.yaw = wrapPi(look.yaw - l.x);
      look.pitch = clamp(look.pitch - l.y, -1.05, 1.15);
    }
  }

  const eyeBaseZ = mesh.eyes && mesh.eyes.length === 2
    ? [mesh.eyes[0].position.z, mesh.eyes[1].position.z]
    : [0, 0];

  function updateEyes(dt, frozen) {
    const eyes = mesh.eyes;
    if (!eyes || eyes.length < 2) return;
    let bx = 0;
    let by = 0;
    if (frozen) {
      saccadeAim.x = 0;
      saccadeAim.y = 0;
      blink = 0;
    } else {
      blinkIn -= dt;
      if (blinkIn <= 0) {
        blinkIn = 2.6 + rand() * 3.8;
        blink = 1;
      }
      blink = Math.max(0, blink - dt * 7.5);
      saccadeIn -= dt;
      if (saccadeIn <= 0) {
        saccadeIn = 0.5 + rand() * 1.6;
        saccadeAim.x = (rand() - 0.5) * 0.26;
        saccadeAim.y = (rand() - 0.5) * 0.16;
      }
      const k = Math.sin(Math.min(1, blink) * Math.PI);
      bx = k;
      by = k;
    }
    const relYaw = clamp(gaitState.lookYaw * 0.35 + saccadeAim.x, -0.32, 0.32);
    const relPitch = clamp(-gaitState.lookPitch * 0.28 + saccadeAim.y, -0.22, 0.22);
    for (let i = 0; i < 2; i++) {
      const e = eyes[i];
      const toe = i === 0 ? -0.10 : 0.115;
      e.rotation.y = toe + relYaw;
      e.rotation.x = relPitch;
      // A blink with no lid geometry: the eyeball withdraws into the socket and the carved lids
      // close over it. Cheaper than a blend shape and, at this size, indistinguishable.
      e.position.z = eyeBaseZ[i] + bx * 0.0068;
      e.scale.set(1, 1 - by * 0.40, 1);
    }
  }

  function feedGait() {
    const speed = Math.hypot(velocity.x, velocity.z);
    gaitState.pos = group.position;
    gaitState.heading = heading;
    gaitState.speed = speed;
    gaitState.angVel = angVel;
    gaitState.grounded = grounded;
    gaitState.duck = duckAmt;
    gaitState.lookYaw = wrapPi(look.yaw - heading);
    gaitState.lookPitch = look.pitch;
    gaitState.sprint = (ctx.state && ctx.state.sprinting) ? 1 : 0;
    gaitState.mouth = mouthOpen;
    return gaitState;
  }

  function updateReach() {
    const prop = reachProp;
    if (!prop || !prop.object3d || prop.eaten) {
      gait.reachAt(null);
      return;
    }
    prop.object3d.getWorldPosition(_v);
    const d = _v.distanceTo(group.position);
    if (d > 0.85) {
      gait.reachAt(null);
      return;
    }
    const verb = ctx.state && ctx.state.verb;
    const committed = verb === 'pull' || verb === 'eat' || (ctx.state && ctx.state.charge > 0.08);
    gait.reachAt(_v, committed ? 1 : 0.34);
  }

  function update(dt) {
    const mode = ctx.state ? ctx.state.mode : 'boot';
    if (mode === 'photo') {
      posePhoto();
      return;
    }
    const step = Math.min(dt, 0.05);
    if (mode === 'playing') {
      updateLook(step);
      updateReach();
      if (mouthOpen > 0) mouthOpen = Math.max(0, mouthOpen - step * 1.6);
      gait.update(step, feedGait());
    } else {
      // Menus and pause: keep breathing, stop crawling.
      velocity.set(0, 0, 0);
      gait.update(Math.min(step, 0.02), feedGait());
    }
    rig.solve(gait.pose);
    updateEyes(step, false);
    finishFrame();
  }

  function finishFrame() {
    group.updateMatrixWorld(true);
    mesh.eyeAnchor.getWorldPosition(_v);
    eyeHeight = _v.y - group.position.y;
    if (ctx.state) {
      ctx.state.ducked = duckAmt > 0.5;
      ctx.state.eyeHeight = eyeHeight;
    }
    if (mesh.setHeadVisible) {
      mesh.setHeadVisible(!(ctx.state && ctx.state.view === 'first'));
    }
  }

  // ── photo mode ──────────────────────────────────────────────────────────────────────────────

  let photoReady = false;
  function posePhoto() {
    if (!photoReady) {
      photoReady = true;
      const wants = !!(shot && (shot.needsBaby || shot.follow)) || ctx.state.shot === 'hero';
      group.visible = wants;
      if (!wants) return;
      if (shot && shot.needsBaby) {
        group.position.set(PHOTO_POSE.x, 0, PHOTO_POSE.z);
        heading = PHOTO_POSE.heading;
      } else {
        group.position.set(start.x, 0, start.z);
        heading = START_HEADING;
      }
      group.rotation.y = heading;
      if (character) {
        character.setPosition({ x: group.position.x, y: group.position.y + foot, z: group.position.z });
      }
      // Land the body on whatever it is standing on before the contacts are seeded.
      group.position.y = probe(group.position.x, group.position.z, 0);
      gait.reset(group.position, heading);
      gait.seedPlants(group.position, heading, PHOTO_POSE.phase, 0.27);
      look.yaw = heading;
      look.pitch = 0.10;
    }
    if (!group.visible) return;

    // Turn the head toward the camera the shot placed, up to a believable limit.
    let rel = 0;
    if (ctx.camera) {
      mesh.eyeAnchor.getWorldPosition(_v);
      _v2.copy(ctx.camera.position).sub(_v);
      const toCam = Math.atan2(-_v2.x, -_v2.z);
      rel = clamp(wrapPi(toCam - heading), -0.98, 0.98);
      gait.setPhotoHeadYaw(clamp(rel - rel * 0.62, -0.30, 0.30));
      const dist = Math.hypot(_v2.x, _v2.z);
      gaitState.lookPitch = clamp(Math.atan2(_v2.y, dist), -0.5, 0.6);
    }
    gaitState.pos = group.position;
    gaitState.heading = heading;
    gaitState.speed = PHOTO_POSE.speed;
    gaitState.angVel = 0;
    gaitState.grounded = true;
    gaitState.duck = 0;
    gaitState.lookYaw = rel;
    gaitState.sprint = 0;
    gaitState.mouth = 0.18;
    gait.update(0, gaitState, true);
    rig.solve(gait.pose);
    updateEyes(0, true);
    group.updateMatrixWorld(true);
    mesh.eyeAnchor.getWorldPosition(_v);
    eyeHeight = _v.y - group.position.y;
    // The `firstPerson` framing puts the lens inside the skull; everything else wants a head.
    if (mesh.setHeadVisible) mesh.setHeadVisible(!(shot && shot.follow === 'first'));
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────────────────────

  function reset() {
    velocity.set(0, 0, 0);
    angVel = 0;
    vy = 0;
    stamina = 1;
    sprintLock = false;
    duckAmt = 0;
    wantDuck = false;
    mouthOpen = 0;
    lungeTime = 0;
    reachProp = null;
    heading = START_HEADING;
    look.yaw = START_HEADING;
    look.pitch = 0.12;
    if (canResize && Math.abs(colliderHalf - STAND_HALF) > 1e-4) {
      colliderHalf = STAND_HALF;
      foot = STAND_HALF;
      character.collider.setHalfHeight(STAND_HALF);
      character.footOffset = STAND_HALF;
    }
    group.position.set(start.x, 0, start.z);
    group.rotation.y = heading;
    if (character) character.setPosition({ x: start.x, y: start.y + 0.02, z: start.z });
    group.position.y = probe(start.x, start.z, 0);
    gait.reset(group.position, heading);
    rig.solve(gait.pose);
    group.updateMatrixWorld(true);
  }

  // ── wiring ──────────────────────────────────────────────────────────────────────────────────

  const offs = [
    events.on('baby:lunge', (e) => {
      if (!e) return;
      const d = e.direction || { x: 0, y: 0, z: -1 };
      lungeDir.set(d.x || 0, 0, d.z || 0);
      if (lungeDir.lengthSq() < 1e-6) lungeDir.set(-Math.sin(heading), 0, -Math.cos(heading));
      lungeDir.normalize();
      lungeTime = e.duration || 0.28;
      gait.lunge((e.duration || 0.28) + 0.14);
    }),
    events.on('interact:target', (e) => { reachProp = e && e.prop ? e.prop : null; }),
    events.on('baby:eat:start', () => { mouthOpen = 1; }),
    events.on('baby:chew', () => { mouthOpen = Math.max(mouthOpen, 0.85); }),
    events.on('baby:eat:done', () => { mouthOpen = 0.4; }),
    events.on('baby:spit', () => { mouthOpen = 1; }),
    events.on('prop:toppled', (e) => {
      const pts = e && e.prop ? (e.prop.points || 0) : 0;
      if (pts >= 150 && Math.hypot(velocity.x, velocity.z) < 0.8) gait.flap();
    }),
    events.on('prop:shattered', () => {
      if (Math.hypot(velocity.x, velocity.z) < 0.9) gait.flap();
    }),
    events.on('game:reset', reset),
    events.on('game:start', reset),
  ];

  ctx.track({
    dispose() {
      for (let i = 0; i < offs.length; i++) if (offs[i]) offs[i]();
      if (character && character.remove) character.remove();
    },
  });

  // First evaluation so the very first rendered frame is already posed, never a T-pose.
  if (photo) {
    posePhoto();
  } else {
    group.position.y = probe(start.x, start.z, 0);
    gait.reset(group.position, heading);
    rig.solve(gait.pose);
    finishFrame();
  }

  return {
    group,
    mesh,
    rig,
    gait,
    character,
    head: mesh.eyeAnchor,
    mouth: mesh.mouthAnchor,
    position: group.position,
    velocity,
    look,
    viewHandGeometry: mesh.viewHandGeometry,
    get heading() { return heading; },
    get eyeHeight() { return eyeHeight; },
    get stamina() { return stamina; },
    get ducked() { return duckAmt; },
    get grounded() { return grounded; },
    get surface() { return surface; },
    get pose() { return gait.pose; },
    getGaitPhase() { return gait.phase; },
    limbLift(i) { return gait.limbLift(i); },
    update,
    fixedUpdate,
    reset,
  };
}
