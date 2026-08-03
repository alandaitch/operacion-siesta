// OPERATION NAPTIME — BABY — the camera rig. First person by default, third on V, 0.5 s blend.
//
// FIRST PERSON. The eye is not a number in this file: it is the world position of the eye anchor
// bone-parented inside the baby's skull, so every bob, lag and weight shift the gait solved for is
// already in it. On top of that go three deliberate, separable layers:
//   · a figure-of-eight — sin(φ) laterally against sin(2φ) vertically — locked to the gait phase.
//     A single sine reads as a lift; the 1:2 Lissajous is what a head actually traces when weight
//     transfers from one arm to the other, and it is why this does not feel like a bobbing camera.
//   · handheld micro-motion from three decorrelated value-noise channels, always on, never zero,
//     because a perfectly still camera in a hand-held frame is the tell that it is a render.
//   · roll into turns, proportional to angular velocity, and a very short look lag so a flick has
//     weight without costing aim.
// The baby's own head is hidden in first person (mesh.setHeadVisible) and replaced at the bottom of
// frame by a pair of view-model hands: the real hand geometry, re-origined at the wrist, driven by
// the same gait phase. The anatomy puts the eyes 13 cm *in front* of the hand contacts, so the real
// hands are physically behind the lens — a view model is the only honest way to see them.
//
// THIRD PERSON. An orbit at 1.15 m behind and 0.42 m above the head, critically damped, with a
// sphere cast from the head to the desired position so the lens never enters the sofa, and the aim
// point lifted so the baby sits in the lower third of frame.
//
// Focus is NOT driven from here — gameplay/interactions.js racks it onto whatever is about to be
// ruined and would fight us for it. We only publish getFocusDistance() for anyone who asks.

import * as THREE from 'three';
import { makeNoise3 } from './baby/sdf.js';
import { getShot } from '../core/shots.js';

const FP_FOV = 63;
const FP_FOV_SPRINT = 66.5;
const TP_FOV = 52;
const VIEW_BLEND = 0.5;
const TP_DIST = 1.15;
const TP_HEIGHT = 0.42;
const TP_RADIUS = 0.11;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (t) => { const x = clamp01(t); return x * x * (3 - 2 * x); };
const damp = (cur, target, lambda, dt) => target + (cur - target) * Math.exp(-lambda * dt);

export function createCameraRig(ctx, baby) {
  const camera = ctx.camera;
  const events = ctx.events;
  const tier = (ctx.quality && ctx.quality.tier) || 'high';
  const photo = ctx.state && ctx.state.mode === 'photo';
  const shot = photo ? getShot(ctx.state.shot) : null;

  const noise = makeNoise3(0xca7ec4);

  // ── the view model lives in its own group, matched to the camera every frame ────────────────
  const viewGroup = new THREE.Group();
  viewGroup.name = 'baby.viewModel';
  viewGroup.matrixAutoUpdate = true;
  viewGroup.frustumCulled = false;
  ctx.scene.add(viewGroup);

  const hands = [];
  if (baby && baby.viewHandGeometry) {
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(baby.viewHandGeometry, ctx.materials.get('skin.baby'));
      m.name = i === 0 ? 'baby.viewHand.R' : 'baby.viewHand.L';
      m.castShadow = false;
      m.receiveShadow = false;
      m.frustumCulled = false;
      m.renderOrder = 4;
      if (i === 1) m.scale.set(-1, 1, 1); // the renderer flips the winding for a mirrored matrix
      viewGroup.add(m);
      hands.push(m);
    }
  }

  // Eyelids: two soft dark panels 55 mm from the lens. At that distance the depth of field turns
  // them into a wipe rather than a shape, which is exactly what a blink looks like from inside.
  const lids = [];
  if (tier !== 'low') {
    const lidGeo = ctx.track(new THREE.PlaneGeometry(0.26, 0.11));
    const lidMat = ctx.materials.tinted('skin.baby', 0x2a170f, {
      roughness: 0.95, transmission: 0, clearcoat: 0, sheen: 0, metalness: 0,
    });
    for (let i = 0; i < 2; i++) {
      const l = new THREE.Mesh(lidGeo, lidMat);
      l.position.set(0, i === 0 ? 0.12 : -0.12, -0.055);
      l.frustumCulled = false;
      l.castShadow = false;
      l.receiveShadow = false;
      l.renderOrder = 6;
      l.visible = false;
      viewGroup.add(l);
      lids.push(l);
    }
  }

  // A rare smear of drool across the bottom of the lens. High tier only; it is a garnish.
  let drool = null;
  if (tier === 'high' || tier === 'ultra') {
    const g = ctx.track(new THREE.CircleGeometry(0.028, 14));
    g.scale(1.9, 0.8, 1);
    drool = new THREE.Mesh(g, ctx.materials.tinted('silicone', 0xe9f2ef, {
      transparent: true, opacity: 0.30, transmission: 0, roughness: 0.06,
      clearcoat: 1, clearcoatRoughness: 0.02, depthWrite: false, metalness: 0,
    }));
    drool.position.set(0.03, -0.052, -0.062);
    drool.frustumCulled = false;
    drool.castShadow = false;
    drool.renderOrder = 5;
    drool.visible = false;
    viewGroup.add(drool);
  }

  // ── state ───────────────────────────────────────────────────────────────────────────────────
  let blend = ctx.state && ctx.state.view === 'third' ? 1 : 0;
  let yaw = baby ? baby.look.yaw : 0;
  let pitch = baby ? baby.look.pitch : 0;
  let roll = 0;
  let clock = 0;
  let trauma = 0;
  let traumaDecay = 3;
  let fov = FP_FOV;
  let focusDistance = 1.4;
  let focusClock = 0;
  let blinkIn = 3.2;
  let blinkT = 0;
  let droolIn = 26;
  let droolT = 0;
  const handLift = [0, 0];
  const handReach = [0, 0];
  let reachAmount = 0;

  const eye = new THREE.Vector3();
  const tpPos = new THREE.Vector3();
  const tpAim = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const final = new THREE.Vector3();
  const dirV = new THREE.Vector3();
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _e = new THREE.Euler(0, 0, 0, 'YXZ');
  const _q = new THREE.Quaternion();
  const smoothTp = new THREE.Vector3();
  let tpPrimed = false;

  // ── events ──────────────────────────────────────────────────────────────────────────────────
  const offs = [
    events.on('camera:shake', (e) => {
      if (!e || photo) return;
      trauma = clamp01(trauma + (e.amount || 0.3));
      traumaDecay = 1 / Math.max(0.08, e.duration || 0.3);
    }),
    events.on('baby:bump', (e) => {
      if (photo) return;
      trauma = clamp01(trauma + clamp((e && e.force ? e.force : 2) / 22, 0.04, 0.5));
      traumaDecay = 3.2;
    }),
    events.on('view:changed', () => { /* ctx.state.view is the truth; update() picks it up */ }),
  ];

  // ── helpers ─────────────────────────────────────────────────────────────────────────────────

  function eyePosition(out) {
    if (baby && baby.head) return baby.head.getWorldPosition(out);
    if (baby) return out.set(baby.position.x, baby.position.y + 0.42, baby.position.z);
    return out.set(0, 0.42, 0);
  }

  function lookDirection(y, p, out) {
    const cp = Math.cos(p);
    return out.set(-Math.sin(y) * cp, Math.sin(p), -Math.cos(y) * cp);
  }

  /** Three decorrelated channels of value noise. Never zero, never repeating on a short loop. */
  function handheld(t, out) {
    out.set(
      (noise(t * 0.62, 11.3, 0.5) - 0.5) + (noise(t * 1.9, 3.1, 0.5) - 0.5) * 0.35,
      (noise(t * 0.55, 27.7, 1.5) - 0.5) + (noise(t * 1.7, 9.4, 1.5) - 0.5) * 0.35,
      (noise(t * 0.48, 41.2, 2.5) - 0.5) + (noise(t * 1.5, 17.8, 2.5) - 0.5) * 0.35,
    );
    return out;
  }

  function refreshFocus(dt) {
    focusClock -= dt;
    if (focusClock > 0) return;
    focusClock = 0.1;
    if (blend > 0.5 && baby && baby.head) {
      focusDistance = clamp(camera.position.distanceTo(eyePosition(_v2)), 0.3, 12);
      return;
    }
    const phys = ctx.physics;
    if (!phys || !phys.raycast) return;
    lookDirection(yaw, pitch, dirV);
    _v.copy(camera.position).addScaledVector(dirV, 0.12);
    const ex = baby && baby.character ? { exclude: baby.character.collider } : undefined;
    const hit = phys.raycast(_v, dirV, 10, ex);
    focusDistance = hit ? clamp(hit.distance + 0.12, 0.25, 10) : 4.0;
  }

  // ── the view model ──────────────────────────────────────────────────────────────────────────

  function updateHands(dt, speedN, duck, fpWeight) {
    if (!hands.length) return;
    const vis = fpWeight > 0.02;
    for (let i = 0; i < 2; i++) hands[i].visible = vis;
    if (!vis) return;
    // Look far enough down and the baby's REAL hands come into frame on the floor. Slide the view
    // model out of shot before that happens rather than showing the player four hands.
    const stow = clamp01((-pitch - 0.55) / 0.45) * 0.16;
    // Nose to the skirting board: pull the hands back in so they cannot poke through the plaster.
    const wall = clamp01((0.52 - focusDistance) / 0.26) * 0.115;

    // How far the interaction system has committed us to grabbing something.
    const verb = ctx.state && ctx.state.verb;
    const wantReach = (verb === 'pull' || verb === 'eat') ? 1
      : (ctx.state && ctx.state.charge > 0.05) ? 0.55
        : (ctx.state && ctx.state.targetId) ? 0.18 : 0;
    reachAmount = damp(reachAmount, wantReach, 5, dt);

    for (let i = 0; i < 2; i++) {
      const sgn = i === 0 ? 1 : -1;
      const lift = baby ? baby.limbLift(i) : 0;
      // Spring the lift so the hand does not pop at the stance/swing boundary.
      handLift[i] = damp(handLift[i], lift, 11, dt);
      const t = handLift[i];
      const n = noise(clock * 0.9 + i * 5.3, 2.2, 0.5) - 0.5;
      const n2 = noise(clock * 1.4 + i * 8.1, 6.7, 0.5) - 0.5;

      const reach = i === 0 ? reachAmount : reachAmount * 0.25;
      handReach[i] = reach;

      const x = sgn * (0.118 - 0.02 * t) + reach * (0.035 - sgn * 0.045) + n * 0.010;
      const y = -0.205 + 0.128 * t + reach * 0.085 - duck * 0.035 + n2 * 0.008
        + Math.sin(clock * 2.1 + i) * 0.004 - stow;
      const z = -0.285 - 0.055 * t - reach * 0.075 - speedN * 0.02 + wall;
      hands[i].position.set(x, y, z);
      _e.set(
        -0.85 + t * 0.55 + reach * 0.35 + n2 * 0.10,
        sgn * (0.30 - t * 0.28) + reach * sgn * -0.25,
        sgn * (-0.55 + t * 0.30) + n * 0.14,
      );
      hands[i].quaternion.setFromEuler(_e);
      const s = i === 1 ? -1 : 1;
      hands[i].scale.set(s * 1.06, 1.06, 1.06);
    }
  }

  function updateLids(dt, fpWeight) {
    if (!lids.length) return;
    if (photo || fpWeight < 0.5) {
      lids[0].visible = false;
      lids[1].visible = false;
      return;
    }
    blinkIn -= dt;
    if (blinkIn <= 0 && blinkT <= 0) {
      blinkIn = 3.4 + noise(clock * 0.37, 5.5, 8.5) * 6.5;
      blinkT = 1;
    }
    if (blinkT > 0) {
      blinkT = Math.max(0, blinkT - dt / 0.15);
      const k = Math.sin((1 - blinkT) * Math.PI); // close and open
      lids[0].visible = true;
      lids[1].visible = true;
      lids[0].position.y = 0.12 - k * 0.115;
      lids[1].position.y = -0.12 + k * 0.105;
    } else {
      lids[0].visible = false;
      lids[1].visible = false;
    }
  }

  function updateDrool(dt, fpWeight) {
    if (!drool) return;
    if (photo || fpWeight < 0.5) { drool.visible = false; return; }
    droolIn -= dt;
    if (droolIn <= 0 && droolT <= 0) {
      droolIn = 34 + noise(clock * 0.11, 19.3, 4.5) * 40;
      droolT = 1;
    }
    if (droolT > 0) {
      droolT = Math.max(0, droolT - dt / 2.2);
      const k = 1 - droolT;
      drool.visible = true;
      drool.position.y = -0.050 - k * 0.014;
      drool.position.x = 0.03 + Math.sin(k * 3.4) * 0.006;
      drool.scale.set(1 + k * 0.35, 1 + k * 0.15, 1);
      if (drool.material.opacity !== undefined) {
        drool.material.opacity = 0.30 * Math.sin(Math.min(1, (1 - droolT) * 1.4) * Math.PI) + 0.02;
      }
    } else {
      drool.visible = false;
    }
  }

  // ── photo mode ──────────────────────────────────────────────────────────────────────────────

  function photoUpdate() {
    viewGroup.visible = false;
    if (!shot || !shot.follow || !baby) return;
    // A follow shot: main.js left the camera alone, so place it deterministically.
    const third = shot.follow === 'third';
    blend = third ? 1 : 0;
    if (ctx.state) ctx.state.view = third ? 'third' : 'first';
    yaw = baby.heading;
    pitch = third ? -0.16 : 0.05;
    eyePosition(eye);
    if (third) {
      lookDirection(yaw, pitch, dirV);
      tpAim.copy(eye).addScaledVector(dirV, 0.15);
      camera.position.copy(tpAim).addScaledVector(dirV, -TP_DIST).add(_v.set(0, TP_HEIGHT, 0));
    } else {
      camera.position.copy(eye);
    }
    _e.set(pitch, yaw, 0);
    camera.quaternion.setFromEuler(_e);
    const f = shot.fov || (third ? TP_FOV : FP_FOV);
    if (Math.abs(camera.fov - f) > 0.01) {
      camera.fov = f;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld(true);
  }

  // ── the frame ───────────────────────────────────────────────────────────────────────────────

  function update(dt) {
    if (photo) {
      photoUpdate();
      return;
    }
    const step = Math.min(dt || 0, 0.05);
    clock += step;

    const wantThird = !!(ctx.state && ctx.state.view === 'third');
    const target = wantThird ? 1 : 0;
    if (blend !== target) {
      const rate = step / VIEW_BLEND;
      blend = target > blend ? Math.min(target, blend + rate) : Math.max(target, blend - rate);
    }
    const k = smoothstep(blend);
    const fpWeight = 1 - k;

    // --- orientation --------------------------------------------------------------------------
    // A short lag on the player's own aim: enough to give a flick some mass, far too little to
    // cost accuracy. Lambda 26 settles in about 90 ms.
    const targetYaw = baby ? baby.look.yaw : yaw;
    const targetPitch = baby ? baby.look.pitch : pitch;
    let dyaw = targetYaw - yaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    yaw += dyaw * (1 - Math.exp(-26 * step));
    pitch = damp(pitch, targetPitch, 26, step);

    const speed = baby ? Math.hypot(baby.velocity.x, baby.velocity.z) : 0;
    const speedN = clamp01(speed / 2.0);
    const duck = baby ? baby.ducked : 0;
    const turn = baby ? clamp((baby.look.yaw - yaw) * 6 + (baby.gait ? baby.gait.springs.turn.x * 1.2 : 0), -1, 1) : 0;
    roll = damp(roll, -turn * 0.055 - (baby && baby.gait ? baby.gait.springs.lean.x * 0.35 : 0), 9, step);

    // --- first person -------------------------------------------------------------------------
    eyePosition(eye);
    const phase = baby ? baby.getGaitPhase() : 0;
    const ph = phase * Math.PI * 2;
    const bobAmp = (0.16 + 0.84 * speedN) * (speed > 0.05 ? 1 : 0.22);
    // The figure-of-eight: one lateral cycle per stride, two vertical.
    const bobX = Math.sin(ph) * 0.0125 * bobAmp;
    const bobY = Math.sin(ph * 2 + Math.PI * 0.5) * 0.0085 * bobAmp;
    const bobZ = Math.cos(ph * 2) * 0.0045 * bobAmp;

    handheld(clock, _v2);
    const hh = 0.0055 + speedN * 0.004;
    _e.set(pitch, yaw, roll);
    _q.setFromEuler(_e);
    desired.copy(eye);
    _v.set(bobX + _v2.x * hh, bobY + _v2.y * hh, bobZ + _v2.z * hh * 0.6).applyQuaternion(_q);
    desired.add(_v);

    // --- third person ---------------------------------------------------------------------------
    lookDirection(yaw, pitch, dirV);
    tpAim.copy(eye).addScaledVector(dirV, 0.10);
    tpPos.copy(tpAim).addScaledVector(dirV, -TP_DIST).add(_v.set(0, TP_HEIGHT * (1 - duck * 0.4), 0));

    if (!tpPrimed) {
      smoothTp.copy(tpPos);
      tpPrimed = true;
    }
    smoothTp.x = damp(smoothTp.x, tpPos.x, 11, step);
    smoothTp.y = damp(smoothTp.y, tpPos.y, 9, step);
    smoothTp.z = damp(smoothTp.z, tpPos.z, 11, step);

    if (k > 0.001 && ctx.physics && ctx.physics.sphereCast) {
      _v.copy(smoothTp).sub(tpAim);
      const dist = _v.length();
      if (dist > 1e-4) {
        _v.multiplyScalar(1 / dist);
        const ex = baby && baby.character ? { exclude: baby.character.collider } : undefined;
        const hit = ctx.physics.sphereCast(tpAim, TP_RADIUS, _v, dist, ex);
        if (hit && hit.distance < dist) {
          // Dolly in rather than clip: the sofa, the shelving, the wall behind the playpen.
          smoothTp.copy(tpAim).addScaledVector(_v, Math.max(0.22, hit.distance - 0.04));
        }
      }
    }

    final.copy(desired).lerp(smoothTp, k);

    // --- shake ------------------------------------------------------------------------------------
    if (trauma > 0) {
      trauma = Math.max(0, trauma - traumaDecay * step);
      const t2 = trauma * trauma;
      const n1 = noise(clock * 34, 1.7, 0.5) - 0.5;
      const n2 = noise(clock * 31, 8.3, 0.5) - 0.5;
      const n3 = noise(clock * 27, 15.1, 0.5) - 0.5;
      _e.set(pitch + n1 * 0.09 * t2, yaw + n2 * 0.09 * t2, roll + n3 * 0.14 * t2);
      camera.quaternion.setFromEuler(_e);
      _v.set(n2 * 0.02 * t2, n1 * 0.02 * t2, 0).applyQuaternion(camera.quaternion);
      final.add(_v);
    } else {
      _e.set(pitch, yaw, roll);
      camera.quaternion.setFromEuler(_e);
    }

    camera.position.copy(final);

    // --- fov ---------------------------------------------------------------------------------------
    const sprint = ctx.state && ctx.state.sprinting ? 1 : 0;
    const wantFov = (FP_FOV + (FP_FOV_SPRINT - FP_FOV) * sprint * clamp01(speedN * 1.4)) * (1 - k) + TP_FOV * k;
    const nextFov = damp(fov, wantFov, 6, step);
    if (Math.abs(nextFov - fov) > 0.01) {
      fov = nextFov;
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }

    camera.updateMatrixWorld(true);

    // --- the view model rides on the camera --------------------------------------------------------
    viewGroup.visible = fpWeight > 0.02;
    if (viewGroup.visible) {
      viewGroup.position.copy(camera.position);
      viewGroup.quaternion.copy(camera.quaternion);
      viewGroup.updateMatrixWorld(true);
    }
    updateHands(step, speedN, duck, fpWeight);
    updateLids(step, fpWeight);
    updateDrool(step, fpWeight);

    refreshFocus(step);
    if (ctx.state) ctx.state.focusDistance = focusDistance;
  }

  function reset() {
    yaw = baby ? baby.look.yaw : 0;
    pitch = baby ? baby.look.pitch : 0;
    roll = 0;
    trauma = 0;
    tpPrimed = false;
    blinkT = 0;
    droolT = 0;
    blinkIn = 3.2;
    droolIn = 26;
    handLift[0] = 0;
    handLift[1] = 0;
    reachAmount = 0;
  }

  ctx.track({
    dispose() {
      for (let i = 0; i < offs.length; i++) if (offs[i]) offs[i]();
      if (viewGroup.parent) viewGroup.parent.remove(viewGroup);
    },
  });

  // Prime the very first frame so nothing is rendered from the origin.
  if (photo) photoUpdate();
  else update(0);

  return {
    update,
    reset,
    camera,
    viewGroup,
    /** Metres from the lens to whatever the frame is about. POSTFX may use it; GAME overrides it. */
    getFocusDistance() { return focusDistance; },
    get view() { return blend > 0.5 ? 'third' : 'first'; },
    get blend() { return blend; },
    get yaw() { return yaw; },
    get pitch() { return pitch; },
    shake(amount, duration) {
      trauma = clamp01(trauma + (amount || 0.3));
      traumaDecay = 1 / Math.max(0.08, duration || 0.3);
    },
  };
}
