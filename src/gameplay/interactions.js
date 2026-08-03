// GAME · reticle targeting and the four verbs. CONTRACTS.md §6, §11.
//
// Everything the baby can do to the room happens here. The module is a small state machine over a
// target and one active action, and it is written to work whether BABY's real character controller
// exists yet or not — every reach into another module is optional-chained and falls back.
//
// TARGETING. A sphere cast (r 7 cm) runs from the eye along the view axis for 55 cm — a
// ten-month-old's actual reach — plus an overlap query at 15 Hz for things beside the head that the
// centre ray misses. Candidates are scored by angle-off-axis and distance, weighted so an
// un-ruined prop beats a ruined one and an edible beats a book, and the *current* target keeps a
// 1.3× bonus plus a 0.3 s grace window before it can be stolen. That hysteresis is the difference
// between a reticle and a strobe light.
//
// THE VERBS
//  · PUSH (Space)  charge up to 0.85 s, release into a lunge. The impulse is applied at the
//    contact point, 75% of the way up the collider, so things tip instead of sliding — a shove
//    at the centre of mass is a push, a shove above it is a topple.
//  · PULL (hold E) a critically-damped spring drags the body toward a point 30 cm in front of the
//    face. The per-step impulse is capped at PULL_FORCE·dt, which is what makes this physical: a
//    board book flies out of the shelf, the espresso machine does not move at all, and letting go
//    keeps the momentum. Props with no rigid body (curtains) get a timed yank instead.
//  · EAT (hold F)  the body is parked under the floor and the mesh is animated into the mouth,
//    shrinking. Moving or being spotted cancels it with a spit-take that fires the object back out.
//  · CLIMB (Space, contextual) a forward-then-down probe finds ledges between 7 and 40 cm — the
//    play mat, the padded playpen sill, the rucked edge of the rug — and scripts a 0.62 s hop.

import * as THREE from 'three';
import {
  VERB, VERB_KEY, VERB_BINDING, createKeyReader, mergedInput, recordFor,
  captureRest, parkProp, clamp, clamp01, smoothstep,
} from './shared.js';

const REACH = 0.55;            // sphere-cast range: a baby's arm
const REACH_RADIUS = 0.07;
const PROXIMITY = 0.72;        // the wider "I could flop onto that" query
const MAX_ANGLE = Math.PI * 0.42;
const PROXIMITY_HZ = { low: 8, medium: 12, high: 15, ultra: 15 };
const PROBE_HZ = 12;

const CHARGE_TIME = 0.85;
const PUSH_COOLDOWN = 0.34;
const LUNGE_TIME = 0.28;

const PULL_FORCE = 34;         // newtons — roughly what a determined ten-month-old manages
const PULL_ANCHOR = 0.30;
const PULL_BREAK = 1.30;
const PULL_YANK_TIME = 0.85;   // bodiless pullables (curtains): hold this long
const PULL_TRAVEL = 0.30;      // metres of drag that count as a yank
const PULL_STALL_EPS = 0.002;  // metres/frame below which a spent dynamic drag counts as "not moving"
const PULL_STALL_TIME = 0.35;  // seconds of no further progress, once fired, before letting go

const EAT_SPEED_TOLERANCE = 0.45; // m/s of actual movement before the spit-take
const CHEW_INTERVAL = 0.42;

const CLIMB_TIME = 0.62;
const CLIMB_MIN = 0.07;
const CLIMB_MAX = 0.40;
const CLIMB_COOLDOWN = 0.5;

export function createInteractions(ctx) {
  const events = ctx.events;
  const keys = createKeyReader();
  const tier = (ctx.quality && ctx.quality.tier) || 'high';
  const proximityPeriod = 1 / (PROXIMITY_HZ[tier] || 15);

  // --- scratch (nothing in the frame loop allocates) --------------------------------------
  const eye = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const flat = new THREE.Vector3();
  const objPos = new THREE.Vector3();
  const toObj = new THREE.Vector3();
  const anchor = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const hitPoint = new THREE.Vector3();
  const mouth = new THREE.Vector3();
  const recPos = new THREE.Vector3();
  const recQuat = new THREE.Quaternion();
  const climbFrom = new THREE.Vector3();
  const climbTo = new THREE.Vector3();
  const lastBabyPos = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  // --- state --------------------------------------------------------------------------------
  let target = null;
  let targetGrace = 0;
  let rayProp = null;
  let hasHitPoint = false;
  let candidates = [];
  let proximityTimer = 0;
  let probeTimer = 0;

  let verb = VERB.NONE;
  let charge = 0;
  let charging = false;
  let pushCooldown = 0;
  let lungeT = 0;

  let pulling = null;     // { prop, rec, work, yank, lastPos }
  let eating = null;      // { prop, rec, t, duration, from, chew, parent }
  let climbing = null;    // { t, from, to, wrapper, offsetY }
  let climbLedge = null;  // { point, y } — the last successful probe
  let climbCooldown = 0;

  let babySpeed = 0;
  let eatLatch = false;
  let promptTimer = 0;
  let lastPromptKey = '';
  let focusTimer = 0;
  const shoveClock = new Map();

  // --- plumbing ------------------------------------------------------------------------------

  function playing() {
    return ctx.state && ctx.state.mode === 'playing';
  }

  function character() {
    const b = ctx.baby;
    const c = (b && (b.character || b.controller || b.charCtl)) || null;
    if (c && typeof c.setPosition === 'function') return c;
    const arr = ctx.physics && ctx.physics.characters;
    if (arr && arr.length && typeof arr[0].setPosition === 'function') return arr[0];
    return null;
  }

  function babyPosition(out) {
    const b = ctx.baby;
    if (b && b.position) return out.set(b.position.x, b.position.y, b.position.z);
    const ch = character();
    if (ch) return ch.position(out);
    if (ctx.camera) return out.copy(ctx.camera.position).setY(0);
    return out.set(0, 0, 0);
  }

  /** The eye: the baby's head if BABY built one, otherwise the live camera. */
  function pose() {
    const b = ctx.baby;
    const third = ctx.state && ctx.state.view === 'third';
    if (b && b.head && b.head.isObject3D) b.head.getWorldPosition(eye);
    else if (b && b.position) eye.set(b.position.x, b.position.y + (b.eyeHeight || 0.42), b.position.z);
    else if (ctx.camera) eye.copy(ctx.camera.position);
    else eye.set(0, 0.42, 0);
    if (!third && ctx.camera) eye.copy(ctx.camera.position);
    if (ctx.camera) ctx.camera.getWorldDirection(fwd);
    else fwd.set(0, 0, -1);
    if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, -1);
    flat.set(fwd.x, 0, fwd.z);
    if (flat.lengthSq() < 1e-8) flat.set(0, 0, -1);
    flat.normalize();
  }

  function propOf(obj) {
    if (!obj) return null;
    if (ctx.props && ctx.props.fromObject) return ctx.props.fromObject(obj);
    return (obj.userData && obj.userData.prop) || null;
  }

  function interactable(prop) {
    if (!prop || prop.eaten) return false;
    if (prop.object3d && prop.object3d.visible === false) return false;
    if (prop.kind === 'scenery' && !prop.climbable) return false;
    return true;
  }

  function worldPosition(prop, out) {
    const rec = recordFor(ctx, prop);
    if (rec && rec.curPos) return out.copy(rec.curPos);
    if (prop.object3d) return prop.object3d.getWorldPosition(out);
    if (prop.restPosition) return out.copy(prop.restPosition);
    return out.set(0, 0, 0);
  }

  // --- targeting -------------------------------------------------------------------------------

  function scoreProp(prop) {
    if (!interactable(prop)) return -1;
    worldPosition(prop, objPos);
    toObj.copy(objPos).sub(eye);
    const dist = toObj.length();
    if (dist > PROXIMITY || dist < 1e-4) return -1;
    toObj.multiplyScalar(1 / dist);
    const cosA = clamp(toObj.dot(fwd), -1, 1);
    const ang = Math.acos(cosA);
    if (ang > MAX_ANGLE) return -1;

    const aim = 1 - ang / MAX_ANGLE;
    const near = 1 - clamp01(dist / PROXIMITY);
    let s = (0.22 + 0.78 * Math.pow(aim, 1.6)) * (0.34 + 0.66 * near);
    if (prop === rayProp) s *= 1.45;
    if (!prop.toppled) s *= 2.2;
    if (prop.kind === 'edible') s *= 1.15;
    if (prop.kind === 'pullable') s *= 1.08;
    if (prop === target) s *= 1.3;
    return s;
  }

  function acquire(dt) {
    // 1. the centre channel — a short sphere cast along the view axis
    rayProp = null;
    hasHitPoint = false;
    const phys = ctx.physics;
    if (phys && phys.sphereCast) {
      const ch = character();
      tmp.copy(eye).addScaledVector(fwd, 0.02);
      const hit = phys.sphereCast(tmp, REACH_RADIUS, fwd, REACH, ch ? { exclude: ch.collider } : undefined);
      if (hit) {
        const p = hit.prop || propOf(hit.object3d);
        if (p && interactable(p)) {
          rayProp = p;
          hitPoint.copy(hit.point);
          hasHitPoint = true;
        }
      }
    }

    // 2. the peripheral channel — everything within flopping distance, refreshed at 15 Hz
    proximityTimer -= dt;
    if (proximityTimer <= 0) {
      proximityTimer = proximityPeriod;
      candidates.length = 0;
      if (phys && phys.overlapSphere) {
        tmp.copy(eye).addScaledVector(flat, 0.20);
        if (tmp.y < 0.14) tmp.y = 0.14;
        const objs = phys.overlapSphere(tmp, PROXIMITY);
        for (let i = 0; i < objs.length; i++) {
          const p = propOf(objs[i]);
          if (p && interactable(p) && candidates.indexOf(p) < 0) candidates.push(p);
        }
      }
    }

    // 3. score
    let best = null;
    let bestScore = 0;
    if (rayProp) {
      const s = scoreProp(rayProp);
      if (s > bestScore) { bestScore = s; best = rayProp; }
    }
    for (let i = 0; i < candidates.length; i++) {
      const p = candidates[i];
      if (p === rayProp) continue;
      const s = scoreProp(p);
      if (s > bestScore) { bestScore = s; best = p; }
    }

    if (best) {
      if (best !== target) {
        target = best;
        targetGrace = 0;
        events.emit('interact:target', { prop: target, id: target.id, labelKey: target.labelKey });
      } else {
        targetGrace = 0;
      }
    } else if (target) {
      // Grace: losing the reticle for a couple of frames must not blink the prompt away.
      targetGrace += dt;
      if (targetGrace > 0.3 || !interactable(target)) {
        target = null;
        targetGrace = 0;
        events.emit('interact:target', { prop: null, id: null, labelKey: null });
      }
    }
  }

  // --- the climb probe ---------------------------------------------------------------------------

  function probeLedge() {
    climbLedge = null;
    const phys = ctx.physics;
    if (!phys || !phys.raycast) return;
    const ch = character();
    const exclude = ch ? ch.collider : undefined;

    tmp.copy(eye);
    const down = phys.raycast(tmp, { x: 0, y: -1, z: 0 }, 1.6, { exclude });
    const groundY = down ? down.point.y : (ctx.baby && ctx.baby.position ? ctx.baby.position.y : 0);

    tmp.set(eye.x, groundY + 0.13, eye.z);
    const ahead = phys.raycast(tmp, flat, 0.44, { exclude });
    if (!ahead) return;
    // A wall is not a ledge: something you can climb has a lip you can see over.
    if (Math.abs(ahead.normal.y) > 0.6) return;

    tmp2.copy(ahead.point).addScaledVector(flat, 0.13);
    tmp2.y = groundY + 0.72;
    const top = phys.raycast(tmp2, { x: 0, y: -1, z: 0 }, 0.80, { exclude });
    if (!top || top.normal.y < 0.55) return;
    const rise = top.point.y - groundY;
    if (rise < CLIMB_MIN || rise > CLIMB_MAX) return;

    climbLedge = {
      x: top.point.x + flat.x * 0.09,
      y: top.point.y,
      z: top.point.z + flat.z * 0.09,
      ground: groundY,
      rise,
    };
  }

  // --- verbs ------------------------------------------------------------------------------------

  function primaryVerb() {
    if (climbing) return VERB.CLIMB;
    if (eating) return VERB.EAT;
    if (pulling) return VERB.PULL;
    if (target) {
      if (target.kind === 'edible') return VERB.EAT;
      if (target.kind === 'pullable') return VERB.PULL;
      if (target.climbable && climbLedge) return VERB.CLIMB;
      return VERB.PUSH;
    }
    if (climbLedge) return VERB.CLIMB;
    return VERB.NONE;
  }

  function canPull(prop) {
    if (!prop) return false;
    if (prop.kind === 'pullable') return true;
    const rec = recordFor(ctx, prop);
    return !!(rec && rec.body && rec.body.isDynamic && rec.body.isDynamic());
  }

  // ---- PUSH -------------------------------------------------------------------------------------

  function releasePush() {
    const power = 0.35 + 0.65 * charge;
    lungeT = LUNGE_TIME;
    pushCooldown = PUSH_COOLDOWN;

    events.emit('baby:lunge', {
      direction: { x: flat.x, y: 0.12, z: flat.z },
      power,
      duration: LUNGE_TIME,
      charge,
    });
    if (ctx.postfx && ctx.postfx.impact) ctx.postfx.impact(0.16 + 0.44 * charge);
    events.emit('camera:shake', { amount: 0.22 + 0.5 * charge, duration: 0.22 });

    const prop = target;
    if (!prop) {
      events.emit('baby:bump', {
        force: 2 + 6 * charge,
        position: { x: eye.x + flat.x * 0.2, y: eye.y - 0.1, z: eye.z + flat.z * 0.2 },
        normal: { x: -flat.x, y: 0, z: -flat.z },
      });
      charge = 0;
      return;
    }

    const rec = recordFor(ctx, prop);
    const dynamic = !!(rec && rec.body && rec.body.isDynamic && rec.body.isDynamic());
    worldPosition(prop, objPos);

    // Where the head lands. Above the centre of mass, so the thing rotates rather than slides.
    if (hasHitPoint && rayProp === prop) tmp.copy(hitPoint);
    else {
      tmp.copy(objPos);
      const halfY = rec && rec.half ? rec.half.y : 0.08;
      tmp.y += halfY * 0.75;
    }

    let j = 0;
    if (dynamic) {
      const mass = clamp(rec.mass || prop.mass || 1, 0.03, 9);
      const dv = 1.05 + 2.35 * charge;
      j = mass * dv;
      tmp2.copy(flat).multiplyScalar(1).addScaledVector(UP, 0.22).normalize().multiplyScalar(j);
      ctx.physics.wake(rec);
      ctx.physics.impulse(rec, tmp2, tmp);
      // A flick of spin off the contact point sells the tumble without needing a big impulse.
      ctx.physics.torqueImpulse(rec, {
        x: flat.z * j * 0.045,
        y: (charge - 0.5) * j * 0.02,
        z: -flat.x * j * 0.045,
      });
    }

    events.emit('interact:push', {
      prop,
      charge,
      impulse: j,
      dynamic,
      position: { x: tmp.x, y: tmp.y, z: tmp.z },
    });
    events.emit('baby:bump', {
      force: 3 + 9 * charge,
      position: { x: tmp.x, y: tmp.y, z: tmp.z },
      normal: { x: -flat.x, y: 0, z: -flat.z },
    });
    events.emit('fx:impact', {
      position: { x: tmp.x, y: tmp.y, z: tmp.z },
      force: 0.4 + charge,
      material: (ctx.physics && ctx.physics.materialOf && ctx.physics.materialOf(prop.object3d)) || 'generic',
    });
    events.emit('noise', {
      position: { x: tmp.x, y: tmp.y, z: tmp.z },
      loudness: clamp01((prop.noise || 0.3) * (0.45 + 0.55 * charge)),
      source: `push:${prop.id}`,
    });
    charge = 0;
  }

  // ---- PULL --------------------------------------------------------------------------------------

  function startPull(prop) {
    const rec = recordFor(ctx, prop);
    const dynamic = !!(rec && rec.body && rec.body.isDynamic && rec.body.isDynamic());
    pulling = {
      prop,
      rec: dynamic ? rec : null,
      yank: dynamic ? 0 : 0,
      work: 0,
      t: 0,
      fired: false,
      stall: 0,
      last: new THREE.Vector3(),
    };
    if (dynamic && rec.curPos) pulling.last.copy(rec.curPos);
    else worldPosition(prop, pulling.last);
    events.emit('interact:pull:start', { prop, dynamic });
    events.emit('noise', {
      position: { x: pulling.last.x, y: pulling.last.y, z: pulling.last.z },
      loudness: clamp01((prop.noise || 0.3) * 0.25),
      source: `pull:${prop.id}`,
    });
  }

  function stepPull(dt) {
    const p = pulling;
    if (!p) return;
    p.t += dt;
    const prop = p.prop;

    if (!p.rec) {
      // Bodiless pullable — a curtain, a tablecloth, the playpen's zip door. A timed yank, not a
      // continuous drag: once it completes there is nothing left to hold on to, so fire it and
      // let go in the same frame. Without the endPull() here the player stays welded to a spent
      // target for as long as they hold the key — `pulling` never clears, `primaryVerb()` stays
      // pinned to PULL, and `startPull` (an `else if` against `pulling` below) can never run for
      // anything else.
      p.yank = clamp01(p.yank + dt / PULL_YANK_TIME);
      events.emit('interact:pull:progress', { prop, progress: p.yank, position: p.last });
      if (p.yank >= 1 && !p.fired) {
        firePull();
        endPull(false);
      }
      return;
    }

    const rec = p.rec;
    if (rec.removed || !rec.curPos) { endPull(false); return; }
    recPos.copy(rec.curPos);

    anchor.copy(eye).addScaledVector(flat, PULL_ANCHOR);
    anchor.y = Math.max(0.12, eye.y - 0.10);
    tmp.copy(anchor).sub(recPos);
    const dist = tmp.length();
    if (dist > PULL_BREAK) { endPull(true); return; }

    const mass = clamp(rec.mass || prop.mass || 1, 0.02, 40);
    // Critically damped approach toward the mouth, then a hard cap on how much force a baby has.
    const speed = Math.min(dist * 6.5, 2.8);
    tmp2.copy(tmp).normalize().multiplyScalar(speed);
    if (rec.body.linvel) {
      const v = rec.body.linvel();
      tmp2.x -= v.x; tmp2.y -= v.y; tmp2.z -= v.z;
    }
    tmp2.multiplyScalar(mass * 0.3);
    tmp2.y += mass * 9.81 * dt * 0.92; // hold it up while it is in the hand
    const cap = PULL_FORCE * dt;
    if (tmp2.lengthSq() > cap * cap) tmp2.setLength(cap);

    ctx.physics.wake(rec);
    ctx.physics.impulse(rec, tmp2, null);

    const stepMoved = recPos.distanceTo(p.last);
    p.work += stepMoved;
    p.last.copy(recPos);
    p.yank = clamp01(p.work / PULL_TRAVEL);
    events.emit('interact:pull:progress', { prop, progress: p.yank, position: recPos });
    if (p.work > 0.12 && !p.fired) firePull();

    // Unlike the bodiless branch, a dynamic prop is meant to keep dragging for as long as it is
    // actually moving — yank clamping at 1 (PULL_TRAVEL reached) does not mean "done". But once
    // it has already fired and then stops making progress — wedged against furniture, or simply
    // at rest at the end of what the baby can drag it — holding the key must not weld the player
    // to it forever either. Let go only after a beat of genuinely no movement, so a prop that is
    // still sliding (even slowly) never gets cut loose mid-drag.
    if (p.fired && p.yank >= 1) {
      p.stall = stepMoved < PULL_STALL_EPS ? p.stall + dt : 0;
      if (p.stall >= PULL_STALL_TIME) { endPull(false); return; }
    } else {
      p.stall = 0;
    }
  }

  function firePull() {
    const p = pulling;
    if (!p || p.fired) return;
    p.fired = true;
    const prop = p.prop;
    const pos = p.rec && p.rec.curPos ? p.rec.curPos : p.last;
    events.emit('interact:pull', { prop, position: { x: pos.x, y: pos.y, z: pos.z } });
    events.emit('prop:pulled', { prop, position: { x: pos.x, y: pos.y, z: pos.z } });
    if (ctx.props && ctx.props.topple) ctx.props.topple(prop, 1.0, pos.clone ? pos.clone() : pos);
    if (ctx.postfx && ctx.postfx.impact) ctx.postfx.impact(0.3);
    events.emit('camera:shake', { amount: 0.3, duration: 0.25 });
  }

  function endPull(snapped) {
    const p = pulling;
    pulling = null;
    if (!p) return;
    events.emit('interact:pull:end', { prop: p.prop, snapped: !!snapped, progress: p.yank });
    events.emit('ui:prompt:clear', { verb: VERB.PULL });
  }

  // ---- EAT ----------------------------------------------------------------------------------------

  function startEat(prop) {
    const rec = recordFor(ctx, prop);
    const g = captureRest(prop);
    const from = {
      pos: prop.object3d ? prop.object3d.position.clone() : new THREE.Vector3(),
      quat: prop.object3d ? prop.object3d.quaternion.clone() : new THREE.Quaternion(),
      scale: prop.object3d ? prop.object3d.scale.clone() : new THREE.Vector3(1, 1, 1),
      world: new THREE.Vector3(),
      worldQuat: new THREE.Quaternion(),
    };
    if (rec && rec.curPos) { from.world.copy(rec.curPos); from.worldQuat.copy(rec.curQuat); }
    else worldPosition(prop, from.world);

    // Park the body first: rapier stops writing the transform, which hands us the mesh.
    parkProp(ctx, prop);
    if (prop.object3d) {
      prop.object3d.position.copy(from.pos);
      prop.object3d.quaternion.copy(from.quat);
      prop.object3d.scale.copy(from.scale);
      prop.object3d.visible = true;
    }

    const difficulty = (ctx.state && ctx.state.eatScale) || 1;
    eating = {
      prop,
      rec,
      g,
      from,
      t: 0,
      duration: Math.max(0.5, (prop.edibleTime || 1.5) * difficulty),
      chew: 0,
    };
    if (ctx.state) ctx.state.eating = true;
    events.emit('interact:eat:start', { prop, duration: eating.duration });
    events.emit('baby:eat:start', { prop, duration: eating.duration, labelKey: prop.labelKey });
  }

  function stepEat(dt) {
    const e = eating;
    if (!e) return;
    const prop = e.prop;
    e.t += dt;
    const t = clamp01(e.t / e.duration);

    // Chewing is audible. That is the whole risk of the verb.
    e.chew -= dt;
    if (e.chew <= 0) {
      e.chew = CHEW_INTERVAL;
      worldPosition(prop, tmp);
      events.emit('noise', {
        position: { x: eye.x, y: eye.y - 0.05, z: eye.z },
        loudness: clamp01(0.22 + 0.16 * (prop.noise || 0.3)),
        source: `chew:${prop.id}`,
      });
      events.emit('baby:chew', { prop, progress: t });
    }

    // Into the mouth: 16 cm in front of the face, dropping and shrinking as it goes.
    mouth.copy(eye).addScaledVector(fwd, 0.16).addScaledVector(UP, -0.055);
    const o = prop.object3d;
    if (o) {
      const k = smoothstep(t);
      if (o.parent) {
        tmp.copy(mouth);
        o.parent.updateWorldMatrix(true, false);
        o.parent.worldToLocal(tmp);
      } else {
        tmp.copy(mouth);
      }
      o.position.lerpVectors(e.from.pos, tmp, k);
      const s = 1 - 0.88 * k * k;
      o.scale.set(e.from.scale.x * s, e.from.scale.y * s, e.from.scale.z * s);
      o.rotateOnAxis(UP, dt * (1.8 + 5 * t)); // gnawed at, turned over
    }

    events.emit('interact:eat:progress', { prop, progress: t });
    events.emit('baby:eat:progress', { prop, progress: t });

    if (t >= 1) finishEat();
  }

  function finishEat() {
    const e = eating;
    if (!e) return;
    eating = null;
    eatLatch = true;
    if (ctx.state) ctx.state.eating = false;
    const prop = e.prop;
    if (prop.object3d) {
      prop.object3d.visible = false;
      prop.object3d.scale.setScalar(0.001);
    }
    events.emit('interact:eat:done', { prop });
    events.emit('baby:eat:done', { prop, reaction: prop.reaction || 'yum' });
    if (ctx.props && ctx.props.eat) ctx.props.eat(prop);
    if (ctx.postfx && ctx.postfx.impact) ctx.postfx.impact(0.22);
    events.emit('camera:shake', { amount: 0.18, duration: 0.3 });
  }

  function cancelEat(reasonKey) {
    const e = eating;
    if (!e) return;
    eating = null;
    eatLatch = true;
    if (ctx.state) ctx.state.eating = false;
    const prop = e.prop;
    const o = prop.object3d;
    if (o) {
      o.position.copy(e.from.pos);
      o.quaternion.copy(e.from.quat);
      o.scale.copy(e.from.scale);
      o.visible = true;
    }
    // Spit it back out, with feeling.
    const g = prop.__game;
    const rec = e.rec;
    if (g && g.parked && rec && ctx.physics) {
      try {
        ctx.physics.freeze(rec, false);
        ctx.physics.teleport(rec, e.from.world, e.from.worldQuat);
        const mass = clamp(rec.mass || prop.mass || 0.2, 0.02, 4);
        tmp.copy(flat).multiplyScalar(1.1).addScaledVector(UP, 1.5).multiplyScalar(mass * 0.55);
        ctx.physics.impulse(rec, tmp, null);
        ctx.physics.torqueImpulse(rec, { x: mass * 0.02, y: mass * 0.01, z: mass * 0.02 });
      } catch {
        /* the body may already be gone; the visual is restored either way */
      }
      g.parked = false;
    }
    events.emit('interact:eat:cancel', { prop, reasonKey: reasonKey || 'toast.spit' });
    events.emit('baby:spit', { prop, position: { x: eye.x, y: eye.y - 0.05, z: eye.z } });
    events.emit('ui:toast', { key: reasonKey || 'toast.spit', icon: 'spit', vars: {} });
    events.emit('noise', {
      position: { x: eye.x, y: eye.y, z: eye.z },
      loudness: 0.42,
      source: 'spit',
    });
    events.emit('fx:impact', { position: { x: eye.x, y: eye.y - 0.05, z: eye.z }, force: 0.5, material: 'generic' });
    if (ctx.postfx && ctx.postfx.impact) ctx.postfx.impact(0.3);
  }

  // ---- CLIMB --------------------------------------------------------------------------------------

  function startClimb() {
    if (!climbLedge || climbing || climbCooldown > 0) return;
    const wrapper = character();
    babyPosition(climbFrom);
    const foot = wrapper ? (wrapper.footOffset || 0.29) : 0;
    if (wrapper) wrapper.position(climbFrom);
    climbTo.set(climbLedge.x, climbLedge.y + foot + 0.005, climbLedge.z);
    climbing = { t: 0, wrapper, rise: climbLedge.rise };
    if (ctx.state) ctx.state.climbing = true;
    events.emit('baby:climb', {
      from: { x: climbFrom.x, y: climbFrom.y, z: climbFrom.z },
      to: { x: climbTo.x, y: climbTo.y, z: climbTo.z },
      duration: CLIMB_TIME,
      rise: climbLedge.rise,
    });
    events.emit('noise', {
      position: { x: climbTo.x, y: climbTo.y, z: climbTo.z },
      loudness: 0.28,
      source: 'climb',
    });
    events.emit('camera:shake', { amount: 0.14, duration: 0.35 });
  }

  function stepClimb(dt) {
    const c = climbing;
    if (!c) return;
    c.t += dt;
    const t = clamp01(c.t / CLIMB_TIME);
    const k = smoothstep(t);
    tmp.lerpVectors(climbFrom, climbTo, k);
    // A hop, not a lift: overshoot the top by a few centimetres in the middle of the move.
    tmp.y += Math.sin(Math.PI * t) * (0.05 + c.rise * 0.25);

    if (c.wrapper) c.wrapper.setPosition(tmp);
    else {
      const b = ctx.baby;
      if (b && b.position && typeof b.position.set === 'function') b.position.set(tmp.x, tmp.y, tmp.z);
      if (b && b.group && b.group.position !== (b && b.position)) b.group.position.set(tmp.x, tmp.y, tmp.z);
    }

    if (t >= 1) {
      climbing = null;
      climbCooldown = CLIMB_COOLDOWN;
      if (ctx.state) ctx.state.climbing = false;
      events.emit('baby:climb:end', { position: { x: climbTo.x, y: climbTo.y, z: climbTo.z } });
    }
  }

  // --- the shove report ---------------------------------------------------------------------------
  // BABY's fixedUpdate runs before ours, so the character controller's `pushed` list is fresh:
  // crawling into a stack of books is an interaction too, and AI/AUDIO want to know about it.

  function reportShoves(dt) {
    const ch = character();
    if (!ch || !ch.pushed || !ch.pushed.length) return;
    for (let i = 0; i < ch.pushed.length; i++) {
      const push = ch.pushed[i];
      if (!push || push.impulse < 0.12) continue;
      const prop = push.prop || propOf(push.object3d);
      if (!prop) continue;
      const now = ctx.elapsed || 0;
      const last = shoveClock.get(prop.id) || -1;
      if (now - last < 0.3) continue;
      shoveClock.set(prop.id, now);
      events.emit('baby:shove', {
        prop,
        impulse: push.impulse,
        position: { x: push.point.x, y: push.point.y, z: push.point.z },
      });
      events.emit('noise', {
        position: { x: push.point.x, y: push.point.y, z: push.point.z },
        loudness: clamp01((prop.noise || 0.3) * clamp01(push.impulse * 0.5)),
        source: `shove:${prop.id}`,
      });
    }
  }

  // --- prompts --------------------------------------------------------------------------------------

  function currentProgress() {
    if (eating) return clamp01(eating.t / eating.duration);
    if (pulling) return pulling.yank;
    if (climbing) return clamp01(climbing.t / CLIMB_TIME);
    if (charging) return clamp01(charge);
    return 0;
  }

  function emitPrompt(dt) {
    promptTimer -= dt;
    const v = verb;
    const prop = eating ? eating.prop : pulling ? pulling.prop : target;
    const progress = currentProgress();
    const key = `${v}|${prop ? prop.id : '-'}|${progress > 0 ? Math.round(progress * 25) : 0}`;
    if (key === lastPromptKey && promptTimer > 0) return;
    lastPromptKey = key;
    promptTimer = 0.2;

    if (v === VERB.NONE) {
      events.emit('ui:prompt', {
        active: false, verb: VERB.NONE, verbKey: null, labelKey: null,
        propId: null, progress: 0, binding: null,
      });
      if (ctx.state) { ctx.state.verb = VERB.NONE; ctx.state.targetId = null; }
      return;
    }

    const alternatives = [];
    if (prop && v !== VERB.PULL && canPull(prop)) {
      alternatives.push({ verb: VERB.PULL, verbKey: VERB_KEY.pull, binding: VERB_BINDING.pull });
    }
    if (prop && v === VERB.EAT) {
      alternatives.push({ verb: VERB.PUSH, verbKey: VERB_KEY.push, binding: VERB_BINDING.push });
    }

    if (prop) worldPosition(prop, objPos);
    else if (climbLedge) objPos.set(climbLedge.x, climbLedge.y, climbLedge.z);
    else objPos.copy(eye).addScaledVector(flat, 0.3);
    events.emit('ui:prompt', {
      active: true,
      verb: v,
      verbKey: VERB_KEY[v] || null,
      binding: VERB_BINDING[v] || null,
      labelKey: prop ? prop.labelKey || 'prop.unknown' : v === VERB.CLIMB ? 'prop.ledge' : null,
      propId: prop ? prop.id : null,
      kind: prop ? prop.kind : 'ledge',
      progress,
      charging,
      spent: prop ? !!prop.toppled : false,
      alternatives,
      position: { x: objPos.x, y: objPos.y, z: objPos.z },
    });
    if (ctx.state) {
      ctx.state.verb = v;
      ctx.state.targetId = prop ? prop.id : null;
    }
  }

  /** Rack focus onto whatever the baby is about to ruin — the art bible asks for exactly this. */
  function driveFocus(dt) {
    if (!ctx.postfx) return;
    focusTimer -= dt;
    if (focusTimer > 0) return;
    focusTimer = 0.12;
    const prop = eating ? eating.prop : pulling ? pulling.prop : target;
    if (prop && ctx.postfx.setFocusTarget) {
      worldPosition(prop, objPos);
      ctx.postfx.setFocusTarget(objPos);
    } else if (ctx.postfx.setAutoFocus) {
      ctx.postfx.setAutoFocus(true);
    }
  }

  // --- lifecycle -------------------------------------------------------------------------------------

  function abort() {
    if (eating) cancelEat('toast.spit');
    if (pulling) endPull(false);
    if (climbing) {
      climbing = null;
      if (ctx.state) ctx.state.climbing = false;
    }
    charging = false;
    charge = 0;
    keys.clear();
  }

  function update(dt) {
    const mode = ctx.state ? ctx.state.mode : 'boot';
    if (mode === 'photo') return;
    if (mode !== 'playing') {
      if (eating || pulling || charging) abort();
      if (target) {
        target = null;
        verb = VERB.NONE;
        emitPrompt(1);
      }
      keys.clearEdges();
      return;
    }

    const step = Math.min(dt, 0.05);
    pose();

    // How fast is the baby actually moving? An eat cancels on movement, not on intent.
    babyPosition(tmp2);
    if (lastBabyPos.lengthSq() > 0) {
      babySpeed = step > 0 ? lastBabyPos.distanceTo(tmp2) / step : 0;
    }
    lastBabyPos.copy(tmp2);

    if (pushCooldown > 0) pushCooldown -= step;
    if (climbCooldown > 0) climbCooldown -= step;
    if (lungeT > 0) lungeT -= step;

    probeTimer -= step;
    if (probeTimer <= 0) {
      probeTimer = 1 / PROBE_HZ;
      if (!climbing) probeLedge();
    }

    if (!eating && !pulling && !climbing) acquire(step);

    const input = mergedInput(ctx, keys);
    verb = primaryVerb();

    // --- EAT ------------------------------------------------------------------------------
    // The latch stops a held F from swallowing the whole room in one press.
    if (!input.eat) eatLatch = false;
    if (eating) {
      if (!input.eat) cancelEat('toast.spit');
      else if (babySpeed > EAT_SPEED_TOLERANCE || input.moving) cancelEat('toast.spit.moved');
      else stepEat(step);
    } else if (input.eat && !eatLatch && target && target.kind === 'edible' && !target.eaten
               && !pulling && !climbing) {
      startEat(target);
    }

    // --- PULL -----------------------------------------------------------------------------
    if (pulling) {
      if (!input.pull) endPull(false);
      else stepPull(step);
    } else if (input.pull && target && canPull(target) && !eating && !climbing) {
      startPull(target);
    }

    // --- PUSH / CLIMB ----------------------------------------------------------------------
    if (climbing) {
      stepClimb(step);
    } else if (!eating && !pulling) {
      const wantsClimb = verb === VERB.CLIMB && climbLedge;
      if (input.push) {
        if (wantsClimb) {
          startClimb();
          charge = 0;
          charging = false;
        } else if (pushCooldown <= 0) {
          charging = true;
          charge = clamp01(charge + step / CHARGE_TIME);
        }
      } else if (charging) {
        charging = false;
        releasePush();
      }
    }
    keys.clearEdges();

    if (ctx.state) {
      ctx.state.charge = charge;
      ctx.state.lunging = lungeT > 0;
    }

    emitPrompt(step);
    driveFocus(step);
  }

  function fixedUpdate(dt) {
    if (!ctx.state || ctx.state.mode !== 'playing') return;
    reportShoves(dt);
  }

  function reset() {
    abort();
    target = null;
    rayProp = null;
    candidates.length = 0;
    verb = VERB.NONE;
    charge = 0;
    pushCooldown = 0;
    climbCooldown = 0;
    climbLedge = null;
    lungeT = 0;
    babySpeed = 0;
    eatLatch = false;
    lastBabyPos.set(0, 0, 0);
    shoveClock.clear();
    lastPromptKey = '';
    promptTimer = 0;
    if (ctx.state) {
      ctx.state.eating = false;
      ctx.state.climbing = false;
      ctx.state.charge = 0;
      ctx.state.verb = VERB.NONE;
      ctx.state.targetId = null;
    }
    events.emit('ui:prompt', {
      active: false, verb: VERB.NONE, verbKey: null, labelKey: null, propId: null, progress: 0, binding: null,
    });
  }

  const offs = [
    events.on('game:reset', reset),
    events.on('game:over', abort),
    events.on('parent:state', (p) => {
      if (!p) return;
      if ((p.to === 'spotted' || p.to === 'catching') && eating) cancelEat('toast.spit.caught');
    }),
  ];

  ctx.track({
    dispose() {
      for (let i = 0; i < offs.length; i++) offs[i] && offs[i]();
      keys.dispose();
    },
  });

  return {
    update,
    fixedUpdate,
    reset,
    get target() { return target; },
    get verb() { return verb; },
    get charge() { return charge; },
    get progress() { return currentProgress(); },
    get eating() { return eating ? eating.prop : null; },
    get pulling() { return pulling ? pulling.prop : null; },
    get ledge() { return climbLedge; },
    dispose() {
      for (let i = 0; i < offs.length; i++) offs[i] && offs[i]();
      keys.dispose();
    },
  };
}
