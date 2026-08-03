// AI · the catch. Two seconds of scripted camera that has to be funny and a little devastating.
//
// The whole shot is built around one fact: the lens is 0.42 m off a wooden floor and the thing
// coming for it is 1.74 m tall. So we never cut and we never move the camera off the baby — we
// simply let an adult arrive.
//
//   0.00–0.45  THE LOOM.  The camera stays exactly where the baby's eyes are and tilts up. Two
//              hands come down out of the top of the frame from 0.95 m, wider than the frame is.
//              FOV holds at the wide, barrel-ish first-person value: the room is still enormous.
//   0.45–0.82  THE GRAB.  The hands converge to ±0.175 m either side of the lens — closer than the
//              focus distance, so they go soft and swallow the edges of the picture — and close.
//              One shake, one octave down in the score, and the FOV punches from 62° to 46°, which
//              is the moment the room stops being yours.
//   0.82–1.55  THE LIFT.  Now the camera is a passenger. It rises 0.78 m on an ease-out with a
//              slight overshoot, swings toward the parent's hip, rolls 14° and gains a 9 Hz damped
//              wobble — the legs kicking. The look target slides from their chest to their face,
//              so the pitch that was +38° at the start relaxes to +8° and the floor drops out of
//              the bottom of the frame. That drop is the joke: the room tilts away from you.
//
// It ends on their face, slightly out of focus, from about 0.30 m. `parent:caught` goes out at
// 1.45 s so GAME's game-over lands on the last beat rather than over the top of it, and if nobody
// is listening we emit `game:over` ourselves at 2.5 s so the round can never wedge.

import * as THREE from 'three';

const T_LOOM = 0.45;
const T_GRAB = 0.82;
const T_LIFT = 1.55;
const T_CAUGHT = 1.45;
const T_FALLBACK = 2.50;
const T_DONE = 3.20;

const sstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = THREE.MathUtils.lerp;

export function createCatch(ctx, deps) {
  const { anim, group } = deps;

  const anchor = new THREE.Vector3();
  const anchor0 = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();
  const chest0 = new THREE.Vector3();
  const handL = new THREE.Vector3();
  const handR = new THREE.Vector3();
  const right = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const headPos = new THREE.Vector3();
  const hipPos = new THREE.Vector3();
  const hipBias = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _qRoll = new THREE.Quaternion();
  const _v = new THREE.Vector3();

  let active = false;
  let t = 0;
  let baseFov = 62;
  let emittedCaught = false;
  let emittedOver = false;
  let camDriven = false;
  let viewModel;
  /** How much distance the torso has to close by pouring forward rather than by walking. */
  let leanIn = 0;
  const footAnchor = new THREE.Vector3();

  function begin(babyHead, over) {
    if (active) return;
    active = true;
    t = 0;
    emittedCaught = false;
    emittedOver = false;
    leanIn = Math.max(0, Math.min(over || 0, 0.95));
    footAnchor.copy(group.position);
    anchor0.copy(babyHead);
    anchor.copy(babyHead);
    baseFov = ctx.camera ? ctx.camera.fov : 62;

    // Freeze the protagonist. BABY owns its own controller, so we set the flag it already honours
    // (`state.climbing` is its "somebody else is scripting me, hold still" gate — the same one
    // interactions.js uses to hoist the baby onto a ledge) and publish the semantic ones for
    // anybody who wants a better hook later.
    if (ctx.state) {
      ctx.state.captured = true;
      ctx.state.frozen = true;
      ctx.state.inputLocked = true;
      ctx.state.climbing = true;
    }
    try {
      ctx.baby?.freeze?.(true);
      ctx.input?.setEnabled?.(false);
    } catch {
      /* BABY and INPUT are authored in parallel; the shot must play regardless */
    }
    ctx.events.emit('baby:captured', { position: anchor.clone(), by: 'parent' });
    ctx.events.emit('camera:shake', { amount: 0.42, duration: 0.28 });
    ctx.events.emit('fx:impact', { position: anchor.clone(), force: 0.35, material: 'fabric' });
  }

  /** Where the parent's hands should be, and where they are looking. */
  function driveBody(p) {
    // Character basis. `group.rotation.y` is the heading; forward is +Z in their own frame.
    const h = group.rotation.y;
    fwd.set(Math.sin(h), 0, Math.cos(h));
    right.set(Math.cos(h), 0, -Math.sin(h));

    const loom = clamp01(t / T_LOOM);
    const grab = clamp01((t - T_LOOM) / (T_GRAB - T_LOOM));
    const lift = clamp01((t - T_GRAB) / (T_LIFT - T_GRAB));

    // Closing the last of the gap: one long stride over the playpen rail or down beside the coffee
    // table, timed with the hands. `leanIn` is set so the feet end exactly 0.66 m from the baby —
    // close enough for the arms to matter, and still outside GAME's 0.52 m proximity catch, which
    // is what buys this shot its second and a half before the results card lands.
    const reachOut = Math.max(0, sstep(loom) * 0.86 + sstep(grab) * 0.14 - 0.55 * sstep(lift));
    if (leanIn > 0.001) {
      group.position.copy(footAnchor).addScaledVector(fwd, leanIn * reachOut);
    }

    // hands: wide and high → narrow and level with the lens → rising with the anchor
    const spread = lerp(0.42, 0.175, sstep(grab));
    const drop = lerp(0.95, 0.02, sstep(loom) * 0.72 + sstep(grab) * 0.28);
    const push = lerp(0.10, -0.02, sstep(grab));
    handL.copy(anchor).addScaledVector(right, spread).addScaledVector(fwd, push);
    handR.copy(anchor).addScaledVector(right, -spread).addScaledVector(fwd, push);
    if (lift <= 0) {
      handL.y = anchor0.y + drop;
      handR.y = anchor0.y + drop;
    } else {
      handL.y = anchor.y + 0.02;
      handR.y = anchor.y + 0.02;
    }
    p.armMode = lift > 0.02 ? 'carry' : 'reach';
    p.reachL = handL;
    p.reachR = handR;
    p.handClose = lerp(0.02, 0.78, sstep(clamp01((t - T_LOOM * 0.8) / 0.34)));

    // They fold all the way down to the floor — an adult reaching a point 0.42 m up has to — and
    // come back up with the weight of a ten-month-old.
    const fold = sstep(loom) * (1 - sstep(lift));
    p.crouch = 0.88 * sstep(loom) * (1 - sstep(lift * 1.1));
    p.lean = 0.62 * fold - 0.10 * sstep(lift);
    p.speed = 0;
    p.turnRate = 0;
    // hipsBias is in CHARACTER space: +z forward, +x their left. The pelvis pours forward over
    // planted feet while they reach (the leg IK runs out of length and extends the trailing leg,
    // which is what a lunge is), then shifts onto the carrying hip as they stand up.
    hipBias.set(0.035 * sstep(lift), -0.030 * fold + 0.014 * Math.sin(sstep(lift) * Math.PI), 0.20 * fold);
    p.hipsBias = hipBias;
    p.lookAt = anchor;
    p.lookWeight = 1;
    p.blink = lift > 0.55 ? 0 : undefined;
  }

  /** The camera. Called from lateUpdate so it wins against whatever BABY's rig did. */
  function driveCamera() {
    const cam = ctx.camera;
    if (!cam) return;
    const h = group.rotation.y;
    fwd.set(Math.sin(h), 0, Math.cos(h));
    right.set(Math.cos(h), 0, -Math.sin(h));

    const loom = clamp01(t / T_LOOM);
    const grab = clamp01((t - T_LOOM) / (T_GRAB - T_LOOM));
    const lift = clamp01((t - T_GRAB) / (T_LIFT - T_GRAB));
    const after = Math.max(0, t - T_LIFT);

    anim.boneWorld('head', headPos, null);
    anim.boneWorld('hips', hipPos, null);
    chest0.copy(hipPos).addScaledVector(up, 0.30);

    // ── the anchor: the baby, then the baby in the air ────────────────────────────────
    const k = sstep(lift);
    // ease-out with a little overshoot at the top — nobody lifts a baby smoothly
    const kOver = k + 0.075 * Math.sin(k * Math.PI) * (1 - k);
    anchor.copy(anchor0);
    if (lift > 0) {
      _v.copy(hipPos).addScaledVector(fwd, 0.34);
      _v.y = hipPos.y + 0.30;
      anchor.lerp(_v, kOver);
      // the kick: 9 Hz, damped, the reason this reads as a person and not a crane
      const wob = Math.exp(-3.1 * (t - T_GRAB));
      anchor.y += 0.036 * Math.sin((t - T_GRAB) * 57) * wob;
      anchor.x += right.x * 0.022 * Math.sin((t - T_GRAB) * 39) * wob;
      anchor.z += right.z * 0.022 * Math.sin((t - T_GRAB) * 39) * wob;
    } else {
      // squirming before the hands land
      anchor.x += Math.sin(t * 21) * 0.006 * loom;
      anchor.y += Math.sin(t * 17) * 0.004 * loom;
    }

    // ── where we are forced to look ───────────────────────────────────────────────────
    // chest while they loom (so we are craning up at a torso), face once we are level with it
    lookTarget.copy(chest0).lerp(headPos, sstep(clamp01((t - T_GRAB * 0.55) / 0.85)));
    // during the grab the eye is dragged down to the closing hands, which is what sells the size
    if (grab > 0 && lift <= 0) {
      _v.copy(handL).lerp(handR, 0.5);
      _v.y += 0.16;
      lookTarget.lerp(_v, 0.42 * sstep(grab));
    }

    cam.position.copy(anchor);
    // a hair of dolly back so the hands have somewhere to be
    cam.position.addScaledVector(fwd, -0.045 * sstep(grab) * (1 - sstep(lift)));

    _m.lookAt(cam.position, lookTarget, up);
    _q.setFromRotationMatrix(_m);

    // roll: the room tilts away, then settles onto their hip
    let roll = 0.055 * sstep(loom);
    roll += 0.19 * sstep(lift) * (1 - 0.55 * sstep(clamp01(after / 0.7)));
    roll += 0.035 * Math.sin(t * 6.3) * sstep(grab) * Math.exp(-1.2 * Math.max(0, t - T_GRAB));
    _v.set(0, 0, 1).applyQuaternion(_q);
    _qRoll.setFromAxisAngle(_v, roll);
    cam.quaternion.copy(_qRoll).multiply(_q);

    const fov = lerp(baseFov, 46, sstep(grab)) + (54 - 46) * sstep(lift);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld(true);
    camDriven = true;

    // BABY's first-person view model (their own hands, the eyelids) is parked on the camera during
    // that module's update(), which ran before we moved it. Bring it with us, or the baby's hands
    // stay on the floor while the rest of them goes up in the air.
    if (viewModel === undefined) viewModel = ctx.scene ? (ctx.scene.getObjectByName('baby.viewModel') || null) : null;
    if (viewModel && viewModel.visible) {
      viewModel.position.copy(cam.position);
      viewModel.quaternion.copy(cam.quaternion);
      viewModel.updateMatrixWorld(true);
    }

    // focus rides the hands in, then the face
    const focus = lift > 0 ? Math.max(0.24, cam.position.distanceTo(headPos)) : lerp(1.6, 0.30, sstep(grab));
    const pf = ctx.postfx;
    if (pf) {
      if (pf.setFocusDistance) pf.setFocusDistance(focus);
      else if (pf.setDoF) pf.setDoF(focus);
    }
  }

  return {
    get active() { return active; },
    get t() { return t; },
    /** True once the state machine may stop steering and let this run the show. */
    get holding() { return active && t >= T_GRAB; },
    begin,

    /** Called from update(); writes the parent's pose. @returns true while the shot owns them. */
    update(dt, p) {
      if (!active) return false;
      t += dt;
      driveBody(p);

      if (!emittedCaught && t >= T_CAUGHT) {
        emittedCaught = true;
        ctx.events.emit('camera:shake', { amount: 0.22, duration: 0.3 });
        ctx.events.emit('parent:caught', { position: anchor.clone(), reason: 'caught' });
      }
      if (!emittedOver && t >= T_FALLBACK) {
        emittedOver = true;
        // GAME owns game:over and normally beats us to it; this is the belt and braces so a round
        // can never end up stuck in 'playing' with a baby in the air.
        if (!ctx.state || ctx.state.mode !== 'over') {
          ctx.events.emit('game:over', { reason: 'caught', score: (ctx.state && ctx.state.score) || 0, stats: null });
        }
      }
      return true;
    },

    lateUpdate() {
      if (!active) return;
      driveCamera();
    },

    get finished() { return active && t >= T_DONE; },

    reset() {
      if (camDriven && ctx.camera && Math.abs(ctx.camera.fov - baseFov) > 0.01) {
        ctx.camera.fov = baseFov;
        ctx.camera.updateProjectionMatrix();
      }
      camDriven = false;
      active = false;
      t = 0;
      emittedCaught = false;
      emittedOver = false;
      if (ctx.state) {
        ctx.state.captured = false;
        ctx.state.frozen = false;
        ctx.state.inputLocked = false;
        ctx.state.climbing = false;
      }
      try {
        ctx.baby?.freeze?.(false);
        ctx.input?.setEnabled?.(true);
      } catch {
        /* optional */
      }
    },
  };
}
