// OPERATION NAPTIME — module AI — Mamá/Papá.
// OWNER: AI. Assembles ./parent/{body,mesh,anim,nav,senses,chores,catch}.js into the one NPC the
// whole game is actually about.
//
// THE SHAPE OF IT. Eight states — idle, chore, suspicious, searching, spotted, chasing, catching,
// calming — driven by two independent senses and one memory. Hearing is a decaying scalar fed by
// the global `noise` bus and attenuated through the doorway; vision is a ~100° × ±26° cone with
// line-of-sight rays and a detection meter that *fills* rather than triggers. Memory is a single
// last-known point plus a queue of places a real person checks: in the playpen, under the glass
// table, over the back of the chaise, behind the ottoman, behind the sheers.
//
// WHY IT IS NOT A GUARD. A guard patrols. This one has seven chores, and the tension in the game
// is not being hunted — it is not knowing *why they came in*. They walk in with a mug, put it on
// the coffee table with their eyeline at 0.9 m, and walk out again; because the vertical cone is
// only ±26° a baby on the floor is genuinely below their attention until they crouch. The one
// chore that will get you caught is picking the crisp packet off the rug, which puts their eyes at
// 0.35 m in the middle of your rug.
//
// THINGS THAT MATTER AND ARE EASY TO GET WRONG:
//  · Sense, then decide, then pose, then refresh the head transform for next frame. The vision
//    cone is read off the *animated* head bone, so where they are looking is literally the pose the
//    animator solved, not a separate variable that can drift out of sync with it.
//  · GAME ends the round on proximity while we are in `spotted` or `catching`, so we never enter
//    either state closer than 0.55 m, and we stop dead the moment `catching` begins. That is what
//    buys the catch cinematic its 1.5 seconds before the results card lands.
//  · Photo mode freezes them mid-stride in the doorway (`?shot=parent`) with every damping term
//    converged, so the review harness gets the same frame every run.
//
// i18n keys emitted, all of which UI already ships in `en` and rioplatense `es`:
//   parent.bark.hello · .what · .coming · .quiet · .found · .no · .gotcha · .sigh
// The HUD subtitles every bark and also subtitles our state transitions on its own, so barks are
// deliberately sparse: most of a chore is silent, which is the whole point of the chore.

import * as THREE from 'three';
import { buildParentBody } from './parent/body.js';
import { createAnimator } from './parent/anim.js';
import { createNav } from './parent/nav.js';
import { createSenses } from './parent/senses.js';
import { createChoreBook } from './parent/chores.js';
import { createCatch } from './parent/catch.js';

const S = {
  IDLE: 'idle',
  CHORE: 'chore',
  SUSPICIOUS: 'suspicious',
  SEARCHING: 'searching',
  SPOTTED: 'spotted',
  CHASING: 'chasing',
  CATCHING: 'catching',
  CALMING: 'calming',
};

/** How much of the room's tension each state is worth on its own. */
const STATE_THREAT = {
  idle: 0.06, chore: 0.24, suspicious: 0.46, searching: 0.62,
  spotted: 0.86, chasing: 0.96, catching: 1.0, calming: 0.30,
};

/** How hard they are looking in each state — a multiplier on how fast the detection meter fills. */
const STATE_FOCUS = {
  idle: 0.85, chore: 0.80, suspicious: 1.9, searching: 1.7,
  spotted: 2.6, chasing: 2.6, catching: 3.0, calming: 1.0,
};

const TIER = [
  { id: 'gentle', chore: [30, 46], walk: 0.62, search: 1.00, chase: 1.62, lose: 3.6, budget: 12.0, react: 0.55 },
  { id: 'standard', chore: [20, 33], walk: 0.72, search: 1.16, chase: 1.95, lose: 2.7, budget: 15.0, react: 0.42 },
  { id: 'feral', chore: [12, 21], walk: 0.84, search: 1.34, chase: 2.35, lose: 2.1, budget: 19.0, react: 0.30 },
];
const PRESET_INDEX = { gentle: 0, standard: 1, feral: 2 };

const CATCH_R = 0.86;        // feet-to-baby distance at which the hands come down, out in the open
const REACH_R = 1.35;        // …and when you are under or inside something they have to lean over
const LUNGE_MAX = 0.70;      // how far off the nav grid they will step to get their hands on you
const MIN_SAFE_R = 0.60;     // never end up closer than GAME's own 0.52 m proximity catch
const WP_R = 0.20;
const GOAL_MOVE = 0.34;

// GRACE PERIOD — the round's opening. Per CONTRACTS §0 the parent is absent for roughly the first
// 40 s: they potter in the hallway, choreTimer keeps counting down, senses keep listening, but
// nothing is allowed to *act* on any of it — no chore walks them into the room, no alertness or
// detection reading is allowed to open a state transition. A sufficiently loud noise can still pull
// the grace period in (a crash two metres from the doorway should not be ignorable), but never below
// GRACE_MIN — otherwise a single early prop-topple would erase the round's whole cold open.
const GRACE_BASE = 40;
const GRACE_MIN = 15;
const GRACE_REACT = 1.5;     // reaction beat after a loud noise before the shortened grace elapses

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const damp = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));
const wrapPi = (a) => {
  let v = a;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v < -Math.PI) v += Math.PI * 2;
  return v;
};

export function createParent(ctx) {
  const events = ctx.events;
  const L = ctx.layout;
  const rng = ctx.makeRng ? ctx.makeRng(0x9a11ce) : () => 0.5;

  const body = buildParentBody(ctx);
  const anim = createAnimator(body, ctx);
  const nav = createNav(ctx);
  const senses = createSenses(ctx);
  const book = createChoreBook(ctx);
  const group = body.group;
  group.name = 'parent';
  const catcher = createCatch(ctx, { anim, group });

  // ── live state ──────────────────────────────────────────────────────────────────────────
  const self = {
    pos: group.position,
    heading: Math.PI,
    speed: 0,
    turnRate: 0,
    eye: new THREE.Vector3(L.hallway.spawn.x, 1.62, L.hallway.spawn.z),
    headQuat: new THREE.Quaternion(),
    blind: false,
    calm: true,
    exclude: null,
    /** 0 = shoulder-width gap, 1 = all the room in the world. Set by follow(). */
    squeeze: 1,
  };

  let state = S.IDLE;
  let stateT = 0;
  let clock = 0;
  let tier = TIER[1];
  let tierIndex = 1;
  let pressure = 0;
  let lastBarkT = -99;
  let fedFixed = 0;
  let seesSent = -1;
  /** Round-clock (ctx.elapsed) timestamp at which the opening grace period ends. Reset every round. */
  let graceUntil = GRACE_BASE;

  // navigation
  let path = null;
  let pathIdx = 0;
  const goal = { x: L.hallway.spawn.x, z: L.hallway.spawn.z, has: false };
  let repathT = 0;
  let blockedT = 0;

  // tasks
  let task = null;            // the active chore or search entry
  let taskT = 0;
  let taskPhase = 'travel';   // travel | act
  let choreTimer = 12;
  const searchQueue = [];
  let searchT = 0;
  let lunge = 0;              // metres already stepped off the grid during the final approach

  // memory
  const memory = { x: 0, y: 0.3, z: 0, t: -99, valid: false, kind: 'none' };

  // idle pottering, in the corridor
  const IDLE_SPOTS = [
    { x: 1.90, z: 4.92, look: [2.60, 1.45, 5.15], dwell: [2.4, 4.2] },
    { x: 1.52, z: 4.32, look: [1.20, 1.20, 4.60], dwell: [1.8, 3.4] },
    { x: 2.28, z: 4.16, look: [2.66, 1.30, 4.70], dwell: [1.6, 3.0] },
    { x: 1.90, z: 3.74, look: [0.60, 0.95, 0.40], dwell: [1.4, 2.8] }, // glances into the room
  ];
  let idleSpot = null;
  let idleDwell = 0;

  // reusable pose object handed to the animator; never reallocated
  const pose = {
    speed: 0,
    turnRate: 0,
    crouch: 0,
    lean: 0,
    armMode: 'swing',
    reachL: null,
    reachR: null,
    handClose: undefined,
    lookAt: null,
    lookWeight: 1,
    frozen: false,
    blink: undefined,
    hipsBias: null,
  };
  const lookScratch = new THREE.Vector3();
  const babyPos = new THREE.Vector3();
  const babyHead = new THREE.Vector3();
  const eyeOffset = new THREE.Vector3(0, 0.0945, 0.0705);
  const _headP = new THREE.Vector3();
  const _headQ = new THREE.Quaternion();

  // ── helpers ─────────────────────────────────────────────────────────────────────────────

  function emitState(to) {
    if (state === to) return;
    const from = state;
    state = to;
    stateT = 0;
    if (to !== S.CHASING) lunge = 0;
    senses.setFocus(STATE_FOCUS[to] === undefined ? 1 : STATE_FOCUS[to]);
    self.calm = to === S.IDLE || to === S.CHORE || to === S.CALMING;
    if (ctx.state) ctx.state.parentState = to;
    events.emit('parent:state', { from, to, position: self.eye.clone() });
  }

  let barkWarned = false;
  function bark(key, force) {
    if (!force && clock - lastBarkT < 3.4) return;
    lastBarkT = clock;
    // The HUD prints whatever key we send straight into the subtitle, so a key UI does not ship
    // would appear on screen as "parent.bark.whatever". Fail closed instead.
    let k = key;
    if (ctx.i18n && typeof ctx.i18n.t === 'function' && ctx.i18n.t(k) === k) {
      if (!barkWarned) {
        barkWarned = true;
        console.warn(`[ai] no i18n copy for bark "${k}" — falling back. See src/i18n/strings.js.`);
      }
      k = 'parent.bark.what';
    }
    events.emit('parent:bark', { key: k, state, position: self.eye.clone() });
  }

  function targetBaby() {
    const b = ctx.baby;
    if (b && b.position) babyPos.copy(b.position);
    else if (ctx.camera) babyPos.copy(ctx.camera.position);
    else babyPos.set(0, 0, 1.55);
    const src = b && (b.head || b.group);
    if (src && src.getWorldPosition) src.getWorldPosition(babyHead);
    else babyHead.set(babyPos.x, babyPos.y + 0.42, babyPos.z);
    return babyPos;
  }

  const flatDist = (x, z) => Math.hypot(x - self.pos.x, z - self.pos.z);

  function remember(x, y, z, kind) {
    memory.x = x;
    memory.y = y;
    memory.z = z;
    memory.t = clock;
    memory.valid = true;
    memory.kind = kind;
  }

  function setGoal(x, z, force) {
    if (!force && goal.has && Math.hypot(goal.x - x, goal.z - z) < GOAL_MOVE && path && repathT > 0) return;
    goal.x = x;
    goal.z = z;
    goal.has = true;
    path = nav.findPath(self.pos.x, self.pos.z, x, z);
    if (!path || !path.length) path = [{ x, z }];
    pathIdx = 0;
    repathT = state === S.CHASING ? 0.30 : 0.55;
  }

  /** @returns the distance still to run to the goal, or 0 once arrived. */
  function follow(dt, maxSpeed) {
    if (!path || pathIdx >= path.length) {
      self.speed = damp(self.speed, 0, 9, dt);
      return 0;
    }
    let wp = path[pathIdx];
    let d = Math.hypot(wp.x - self.pos.x, wp.z - self.pos.z);
    const last = pathIdx === path.length - 1;
    if (d < (last ? WP_R * 0.75 : WP_R * 1.7)) {
      if (last) {
        self.speed = damp(self.speed, 0, 11, dt);
        return 0;
      }
      pathIdx++;
      wp = path[pathIdx];
      d = Math.hypot(wp.x - self.pos.x, wp.z - self.pos.z);
    }

    let want = Math.atan2(wp.x - self.pos.x, wp.z - self.pos.z);

    // Centring. Sample the clearance field a stride either side and steer toward the roomier one
    // whenever the lane is tight. Without this a waypoint that is 0.15 m off the centreline is
    // enough to walk a 0.66 m corridor into its wall and stay there.
    const room = nav.clearanceAt(self.pos.x, self.pos.z);
    self.squeeze = clamp01((room - nav.radius) / 0.24);
    if (self.squeeze < 1) {
      const rx = Math.cos(self.heading);
      const rz = -Math.sin(self.heading);
      const cl = nav.clearanceAt(self.pos.x - rx * 0.26, self.pos.z - rz * 0.26);
      const cr = nav.clearanceAt(self.pos.x + rx * 0.26, self.pos.z + rz * 0.26);
      want += clamp((cr - cl) * 1.7, -0.75, 0.75) * (1 - self.squeeze);
    }

    const err = wrapPi(want - self.heading);
    const turn = (state === S.CHASING ? 5.4 : 3.3) * (1 + 0.6 * clamp01(Math.abs(err)));
    const step = clamp(err, -turn * dt, turn * dt);
    self.heading = wrapPi(self.heading + step);
    self.turnRate = damp(self.turnRate, step / Math.max(dt, 1e-4), 10, dt);

    // Do not walk hard into a turn, arrive gently, and go carefully when it is tight.
    let scale = clamp(Math.cos(err) * 1.3, 0, 1);
    if (last) scale *= clamp(d / 0.62, 0.14, 1);
    if (self.squeeze < 1) scale *= 0.46 + 0.54 * self.squeeze;

    self.speed = damp(self.speed, maxSpeed * scale, 6.5, dt);
    const mx = Math.sin(self.heading) * self.speed * dt;
    const mz = Math.cos(self.heading) * self.speed * dt;

    // Wall sliding, not clamping. Snapping back to the nearest open cell centre looks identical to
    // being stuck, because it *is* being stuck: the same illegal step is retried every frame.
    if (nav.passableAt(self.pos.x + mx, self.pos.z + mz)) {
      self.pos.x += mx;
      self.pos.z += mz;
      blockedT = 0;
    } else if (nav.passableAt(self.pos.x + mx * 1.6, self.pos.z)) {
      self.pos.x += mx * 1.6;
      blockedT += dt;
    } else if (nav.passableAt(self.pos.x, self.pos.z + mz * 1.6)) {
      self.pos.z += mz * 1.6;
      blockedT += dt;
    } else {
      blockedT += dt;
    }

    // Wedged for the better part of a second: the plan is wrong, not the controller. Replan, and
    // if we are somehow off the mesh entirely, step back onto it.
    if (blockedT > 0.7) {
      blockedT = 0;
      if (!nav.passableAt(self.pos.x, self.pos.z)) {
        const near = nav.nearestOpen(self.pos.x, self.pos.z, 6);
        if (near.ok) {
          self.pos.x = near.x;
          self.pos.z = near.z;
        }
      }
      repathT = -1;
      setGoal(goal.x, goal.z, true);
    }
    return d + (path.length - 1 - pathIdx) * 0.6;
  }

  function faceToward(dt, x, z, rate) {
    const want = Math.atan2(x - self.pos.x, z - self.pos.z);
    const err = wrapPi(want - self.heading);
    const step = clamp(err, -rate * dt, rate * dt);
    self.heading = wrapPi(self.heading + step);
    self.turnRate = damp(self.turnRate, step / Math.max(dt, 1e-4), 10, dt);
    self.speed = damp(self.speed, 0, 11, dt);
  }

  /** Look ahead at adult head height — this is what keeps a baby below their cone. */
  function lookAhead(distance, height) {
    lookScratch.set(
      self.pos.x + Math.sin(self.heading) * distance,
      height,
      self.pos.z + Math.cos(self.heading) * distance,
    );
    pose.lookAt = lookScratch;
    pose.lookWeight = 1;
  }

  /** A slow scan across the room while they walk, which is how a person actually searches. */
  function lookScan(height, width, rate) {
    const a = Math.sin(clock * rate) * width;
    lookScratch.set(
      self.pos.x + Math.sin(self.heading + a) * 2.6,
      height,
      self.pos.z + Math.cos(self.heading + a) * 2.6,
    );
    pose.lookAt = lookScratch;
    pose.lookWeight = 1;
  }

  function resetPose() {
    pose.crouch = 0;
    pose.lean = 0;
    pose.armMode = 'swing';
    pose.reachL = null;
    pose.reachR = null;
    pose.handClose = undefined;
    pose.lookAt = null;
    pose.lookWeight = 1;
    pose.frozen = false;
    pose.blink = undefined;
    pose.hipsBias = null;
  }

  // ── task plumbing ───────────────────────────────────────────────────────────────────────

  function beginChore() {
    // Weighted pick, never the same one twice running.
    let total = 0;
    for (const c of book.chores) total += c === task ? 0 : (c.weight || 1) * (c.danger ? 0.6 + pressure : 1);
    let r = rng() * total;
    let chosen = book.chores[0];
    for (const c of book.chores) {
      if (c === task) continue;
      const w = (c.weight || 1) * (c.danger ? 0.6 + pressure : 1);
      r -= w;
      if (r <= 0) {
        chosen = c;
        break;
      }
    }
    task = chosen;
    taskT = 0;
    taskPhase = 'travel';
    const near = nav.nearestOpen(chosen.stand[0], chosen.stand[1]);
    setGoal(near.x, near.z, true);
    emitState(S.CHORE);
    // Mostly they say nothing at all, which is far worse. The HUD already subtitles the state.
    if (rng() < 0.32) bark(chosen.barkKey, true);
  }

  function buildSearchQueue(x, z) {
    searchQueue.length = 0;
    const near = book.searchesNear(x, z, 3);
    for (const s of near) searchQueue.push(s);
    searchT = 0;
  }

  function beginSearch(x, z, kind) {
    remember(x, memory.y, z, kind);
    buildSearchQueue(x, z);
    task = null;
    taskPhase = 'travel';
    taskT = 0;
    const near = nav.nearestOpen(x, z);
    setGoal(near.x, near.z, true);
    emitState(S.SEARCHING);
  }

  function nextIdleSpot() {
    let i = Math.floor(rng() * IDLE_SPOTS.length) % IDLE_SPOTS.length;
    if (IDLE_SPOTS[i] === idleSpot) i = (i + 1) % IDLE_SPOTS.length;
    idleSpot = IDLE_SPOTS[i];
    idleDwell = idleSpot.dwell[0] + rng() * (idleSpot.dwell[1] - idleSpot.dwell[0]);
    const near = nav.nearestOpen(idleSpot.x, idleSpot.z);
    setGoal(near.x, near.z, true);
  }

  function goHome() {
    task = null;
    idleSpot = null;
    emitState(S.CALMING);
    const near = nav.nearestOpen(L.hallway.path[1][0], L.hallway.path[1][2]);
    setGoal(near.x, near.z, true);
  }

  // ── the state machine ───────────────────────────────────────────────────────────────────

  /**
   * @param live true only while a round is actually running. On the title screen they still potter
   *        in the corridor — it is the best thing behind a menu — but nothing escalates, because a
   *        catch cinematic playing over the main menu would be quite the bug.
   * @param graceActive true while the round's opening grace period is still running: choreTimer and
   *        the senses keep ticking underneath, but nothing here is allowed to open a state
   *        transition off of them. See GRACE_BASE / GRACE_MIN above.
   */
  function think(dt, live, graceActive) {
    const det = live && !graceActive ? senses.detection : 0;
    const alert = live && !graceActive ? senses.alertness : 0;
    const startle = live && !graceActive ? senses.takeStartle() : 0;
    targetBaby();
    const dBaby = flatDist(babyPos.x, babyPos.z);
    if (!live && state !== S.IDLE && state !== S.CALMING) goHome();

    if (startle > 0) {
      remember(senses.state.lastHeard.x, senses.state.lastHeard.y, senses.state.lastHeard.z, 'heard');
    }

    // A baby inside the playpen or under the glass table is standing on cells the parent cannot
    // occupy, so the grid can only ever get them to the edge of it. That is the moment a real
    // parent leans over the rail — see enterCatch().
    const reachR = nav.passableAt(babyPos.x, babyPos.z) ? CATCH_R : REACH_R;

    // ── spotted: the only door into the top of the ladder ────────────────────────────
    // `catching` is reachable only through `chasing`, which is reachable only through this. We do
    // not shortcut straight to a catch even when detection maxes out at point-blank range — the
    // double-take in the SPOTTED case below is what makes this an NPC and not a trap trigger.
    if (!graceActive && state !== S.CATCHING && state !== S.SPOTTED && state !== S.CHASING
        && det >= 1 - 1e-6) {
      remember(babyPos.x, babyHead.y, babyPos.z, 'seen');
      emitState(S.SPOTTED);
      bark('parent.bark.found', true);
      events.emit('camera:shake', { amount: 0.30, duration: 0.35 });
    }

    switch (state) {
      // ── the corridor ──────────────────────────────────────────────────────────────
      case S.IDLE: {
        choreTimer -= dt * (0.75 + 1.1 * pressure);
        if (!idleSpot) nextIdleSpot();
        const left = follow(dt, tier.walk * 0.72);
        if (left <= 0) {
          idleDwell -= dt;
          faceToward(dt, idleSpot.look[0], idleSpot.look[2], 2.0);
          lookScratch.set(idleSpot.look[0], idleSpot.look[1], idleSpot.look[2]);
          pose.lookAt = lookScratch;
          pose.armMode = clock % 11 < 4 ? 'hips' : 'relax';
          if (idleDwell <= 0) {
            nextIdleSpot();
            if (rng() < 0.35) bark('parent.bark.hello');
          }
        } else {
          lookAhead(2.4, 1.42);
        }
        if (alert > 0.34 || det > 0.22) {
          emitState(S.SUSPICIOUS);
          bark('parent.bark.what', true);
        } else if (startle > 0) {
          beginSearch(memory.x, memory.z, 'heard');
        } else if (choreTimer <= 0 && live && !graceActive) {
          beginChore();
        }
        break;
      }

      case S.CHORE: {
        if (taskPhase === 'travel') {
          const left = follow(dt, tier.walk);
          lookAhead(2.6, 1.34);
          if (left <= 0) {
            taskPhase = 'act';
            taskT = 0;
            faceToward(dt, task.faceAt[0], task.faceAt[2], 3.0);
          }
        } else {
          taskT += dt;
          faceToward(dt, task.faceAt[0], task.faceAt[2], 2.6);
          task.apply(clamp01(taskT / task.dwell), pose);
          if (taskT >= task.dwell) {
            choreTimer = tier.chore[0] + rng() * (tier.chore[1] - tier.chore[0]);
            choreTimer *= 1.25 - 0.7 * pressure;
            goHome();
          }
        }
        if (alert > 0.34 || det > 0.22) {
          emitState(S.SUSPICIOUS);
          bark('parent.bark.what', true);
        }
        if (startle > 0) beginSearch(memory.x, memory.z, 'heard');
        break;
      }

      case S.CALMING: {
        const left = follow(dt, tier.walk * 0.92);
        lookAhead(2.4, 1.40);
        if (left <= 0) {
          idleSpot = null;
          emitState(S.IDLE);
        }
        if (alert > 0.40 || det > 0.26) {
          emitState(S.SUSPICIOUS);
          bark('parent.bark.what', true);
        }
        if (startle > 0) beginSearch(memory.x, memory.z, 'heard');
        break;
      }

      // ── something is not right ────────────────────────────────────────────────────
      case S.SUSPICIOUS: {
        // They stop dead, straighten, and turn toward it. This pause is the player's cue.
        self.speed = damp(self.speed, 0, 12, dt);
        pose.armMode = 'relax';
        const tx = memory.valid ? memory.x : babyPos.x;
        const tz = memory.valid ? memory.z : babyPos.z;
        if (stateT > tier.react * 0.5) faceToward(dt, tx, tz, 2.8);
        lookScratch.set(tx, memory.valid ? clamp(memory.y, 0.12, 1.3) : 0.5, tz);
        pose.lookAt = lookScratch;
        pose.crouch = 0.04;
        pose.lean = 0.06;
        if (startle > 0 || alert > 0.62 || det > 0.45) {
          bark(startle > 0 ? 'parent.bark.coming' : 'parent.bark.quiet', true);
          beginSearch(tx, tz, memory.kind || 'heard');
        } else if (stateT > 2.4 && alert < 0.18 && det < 0.08) {
          goHome();
        }
        break;
      }

      case S.SEARCHING: {
        searchT += dt;
        if (senses.visible) remember(babyPos.x, babyHead.y, babyPos.z, 'seen');
        if (taskPhase === 'travel') {
          const left = follow(dt, tier.search);
          lookScan(0.62, 0.55, 1.7);
          if (left <= 0) {
            if (task) {
              // arrived at the peek spot itself
              taskPhase = 'act';
              taskT = 0;
              bark(task.barkKey);
            } else if (searchQueue.length) {
              // arrived at the last-known point; head for the first place worth checking
              task = searchQueue.shift();
              const near = nav.nearestOpen(task.stand[0], task.stand[1]);
              setGoal(near.x, near.z, true);
            } else {
              bark('parent.bark.sigh', true);
              goHome();
            }
          }
        } else {
          taskT += dt;
          // Down on one knee with their nose 30 cm off the rug: this is the most dangerous the
          // parent ever is short of actually seeing you.
          senses.setFocus(STATE_FOCUS.searching * 1.5);
          faceToward(dt, task.faceAt[0], task.faceAt[2], 3.2);
          task.apply(clamp01(taskT / task.dwell), pose);
          if (taskT >= task.dwell) {
            senses.setFocus(STATE_FOCUS.searching);
            task = null;
            if (searchQueue.length) {
              taskPhase = 'travel';
            } else {
              bark('parent.bark.sigh', true);
              goHome();
            }
          }
        }
        if (searchT > tier.budget) {
          bark('parent.bark.sigh', true);
          goHome();
        }
        break;
      }

      // ── the ladder's top ──────────────────────────────────────────────────────────
      case S.SPOTTED: {
        // A beat of pure double-take before they move. Half a second is the difference between
        // an NPC and a person.
        self.speed = damp(self.speed, 0, 14, dt);
        faceToward(dt, babyPos.x, babyPos.z, 4.4);
        lookScratch.copy(babyHead);
        pose.lookAt = lookScratch;
        pose.armMode = 'relax';
        pose.lean = -0.06 + 0.16 * clamp01(stateT / tier.react);
        remember(babyPos.x, babyHead.y, babyPos.z, 'seen');
        if (stateT >= tier.react) {
          emitState(S.CHASING);
          bark('parent.bark.no', true);
        }
        break;
      }

      case S.CHASING: {
        setGoal(babyPos.x, babyPos.z, false);
        const left = follow(dt, tier.chase * (1 + 0.16 * pressure));
        lookScratch.copy(babyHead);
        pose.lookAt = lookScratch;
        pose.lookWeight = 1;
        pose.lean = 0.16 + 0.34 * clamp01(lunge / LUNGE_MAX);
        if (senses.visible) remember(babyPos.x, babyHead.y, babyPos.z, 'seen');
        if (dBaby <= reachR) {
          enterCatch(dBaby);
        } else if (left <= 0 && lunge < LUNGE_MAX && dBaby > MIN_SAFE_R) {
          // The grid says we have arrived and they are still out of reach, which means they are
          // inside or underneath something. Step off the grid — over the playpen rail, onto one
          // knee beside the coffee table — but never more than 0.70 m, and never into the wall.
          const stepLen = Math.min(tier.chase * 0.5 * dt, LUNGE_MAX - lunge, dBaby - MIN_SAFE_R);
          faceToward(dt, babyPos.x, babyPos.z, 4.0);
          if (stepLen > 0) {
            self.pos.x += ((babyPos.x - self.pos.x) / dBaby) * stepLen;
            self.pos.z += ((babyPos.z - self.pos.z) / dBaby) * stepLen;
            lunge += stepLen;
            self.speed = 0.55;
          }
        } else if (senses.seenAgeSeconds() > tier.lose) {
          bark('parent.bark.quiet', true);
          beginSearch(memory.x, memory.z, 'seen');
        }
        break;
      }

      case S.CATCHING:
      default:
        self.speed = 0;
        break;
    }
  }

  function enterCatch(dBaby) {
    if (catcher.active) return;
    self.speed = 0;
    path = null;
    emitState(S.CATCHING);
    bark('parent.bark.gotcha', true);
    // Face them squarely; the whole shot depends on the hands arriving symmetrically.
    self.heading = Math.atan2(babyPos.x - self.pos.x, babyPos.z - self.pos.z);
    // Everything past MIN_SAFE_R is closed by the body rather than by walking: the torso pours
    // forward over whatever is in the way while the feet stay planted. It also guarantees the feet
    // never end up inside GAME's 0.52 m proximity radius before the shot has played.
    const over = clamp((dBaby === undefined ? 0 : dBaby) - (MIN_SAFE_R + 0.06), 0, REACH_R);
    catcher.begin(babyHead, over);
  }

  // ── frame plumbing ──────────────────────────────────────────────────────────────────────

  function refreshHead() {
    if (anim.boneWorld('head', _headP, _headQ)) {
      self.headQuat.copy(_headQ);
      self.eye.copy(eyeOffset).applyQuaternion(_headQ).add(_headP);
    } else {
      self.eye.set(self.pos.x, 1.62, self.pos.z);
      self.headQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), self.heading);
    }
  }

  function applyTransform() {
    group.rotation.y = self.heading;
    group.updateMatrixWorld(true);
  }

  const PHOTO_POS = new THREE.Vector3(L.doorway.cx, 0, 3.44);
  const PHOTO_LOOK = new THREE.Vector3(0.60, 0.74, -0.62);
  function posePhoto(dt) {
    self.pos.copy(PHOTO_POS);
    // Facing into the room, turned a few degrees off square because nothing here is square.
    self.heading = Math.atan2(1.05 - PHOTO_POS.x, -0.30 - PHOTO_POS.z);
    self.speed = 1.05;
    anim.setSpeed(1.05);
    anim.setPhase(0.17);      // right foot mid-swing, left foot planted forward
    resetPose();
    pose.frozen = true;
    pose.turnRate = 0;
    pose.lean = 0.03;
    pose.armMode = 'swing';
    pose.lookAt = PHOTO_LOOK;
    pose.lookWeight = 1;
    pose.blink = 0;
    anim.pose(dt, pose);
    applyTransform();
    refreshHead();
  }

  function update(dt) {
    const mode = ctx.state ? ctx.state.mode : 'playing';

    if (mode === 'photo') {
      posePhoto(dt);
      return;
    }

    clock += dt;
    stateT += dt;

    // If nobody drove the fixed step this frame (menus, game over) keep the gait honest anyway.
    if (fedFixed <= 0) anim.advance(dt, self.speed);
    fedFixed = 0;

    resetPose();

    if (catcher.active) {
      catcher.update(dt, pose);
      pose.turnRate = 0;
      anim.pose(dt, pose);
      applyTransform();
      refreshHead();
      seesSent = 1;
      events.emit('parent:sees', { level: 1, visible: true, distance: 0.4, state });
      return;
    }

    repathT -= dt;
    senses.update(dt, self);

    // GRACE PERIOD. `ctx.elapsed` only advances while playing (main.js), so it is a clean "seconds
    // since round start" clock even across pause/menu. A loud noise can pull the grace period in —
    // it never makes them literally deaf — but the floor at GRACE_MIN protects the round's cold
    // open from a single early prop-topple. See the constants above and senses.js's AWARENESS note.
    const live = mode === 'playing';
    const elapsed = live ? (ctx.elapsed || 0) : 0;
    if (live && elapsed < graceUntil && senses.state.startle > 0) {
      graceUntil = clamp(elapsed + GRACE_REACT, GRACE_MIN, graceUntil);
    }
    const graceActive = live && elapsed < graceUntil;
    if (graceActive) {
      // Keep the underlying meters from silently filling up behind the gate — otherwise the instant
      // grace ends, a fully-primed detection value would slam the state machine straight through
      // suspicious/searching/spotted in one frame. A quiet residual is fine; a loaded one is not.
      senses.state.detection = Math.min(senses.state.detection, 0.05);
      senses.state.alertness = Math.min(senses.state.alertness, 0.20);
    }

    // 'over' and 'paused' stop the brain but keep them breathing.
    if (mode === 'playing' || mode === 'menu' || mode === 'boot') think(dt, live, graceActive);
    else {
      self.speed = damp(self.speed, 0, 8, dt);
      pose.armMode = 'relax';
    }

    // think() may have started the catch this very frame; hand the pose straight over so the
    // hands are already on their way down on the frame the state changes.
    if (catcher.active) catcher.update(dt, pose);

    // The only way in or out of the room is a 0.7 m slot between the playpen and the chaise. When
    // they are in it, they slow down (follow() does that) and pull their elbows in, which is both
    // what a person does and the thing that makes the squeeze legible from the floor.
    if (self.squeeze < 0.55 && self.speed > 0.12 && pose.armMode === 'swing') {
      pose.armMode = 'relax';
      pose.lean += 0.06 * (1 - self.squeeze);
    }

    pose.turnRate = self.turnRate;
    anim.pose(dt, pose);
    applyTransform();
    refreshHead();

    // The HUD's detection meter, POSTFX's damage vignette and AUDIO's stinger all ride this.
    const level = clamp01(senses.detection);
    seesSent = level;
    events.emit('parent:sees', {
      level,
      visible: senses.visible,
      distance: senses.state.distance,
      state,
    });
    if (ctx.state) {
      ctx.state.parentAlert = senses.alertness;
      ctx.state.parentThreat = api.getThreat();
    }
  }

  function fixedUpdate(dt) {
    if (ctx.state && ctx.state.mode === 'photo') return;
    fedFixed += dt;
    const fall = anim.advance(dt, self.speed);
    if (fall) {
      // Footsteps are for AUDIO; they deliberately do NOT go on the `noise` bus, or the parent
      // would hear themselves and spend the round investigating their own slippers.
      events.emit('parent:step', {
        side: fall,
        position: self.pos.clone(),
        speed: self.speed,
        surface: self.pos.z > L.room.maxZ ? 'hall' : 'floor',
      });
    }
  }

  function lateUpdate() {
    if (catcher.active) catcher.lateUpdate();
  }

  function reset() {
    catcher.reset();
    senses.reset();
    anim.reset();
    self.pos.set(L.hallway.spawn.x, 0, L.hallway.spawn.z);
    self.heading = Math.PI;
    self.speed = 0;
    self.turnRate = 0;
    state = S.IDLE;
    stateT = 0;
    clock = 0;
    lastBarkT = -99;
    seesSent = -1;
    path = null;
    pathIdx = 0;
    goal.has = false;
    task = null;
    taskPhase = 'travel';
    taskT = 0;
    searchQueue.length = 0;
    searchT = 0;
    idleSpot = null;
    memory.valid = false;
    memory.t = -99;
    pressure = 0;
    graceUntil = GRACE_BASE;
    choreTimer = (tier.chore[0] * 0.55) + rng() * 4;
    resetPose();
    anim.pose(1 / 60, pose);
    applyTransform();
    refreshHead();
    if (ctx.state) ctx.state.parentState = state;
  }

  function setTier(i) {
    tierIndex = clamp(Math.round(i), 0, 2);
    tier = TIER[tierIndex];
    senses.setDifficulty(tierIndex);
  }

  // ── wiring ──────────────────────────────────────────────────────────────────────────────
  const offs = [
    events.on('game:reset', () => reset()),
    events.on('game:start', () => {
      reset();
      choreTimer = tier.chore[0] * 0.5 + rng() * 5;
    }),
    events.on('light:sun', (p) => senses.setSunDirection(p && (p.direction || p.dir || p))),
  ];

  // The parent is not destructible, but registering them means AUDIO/FX can resolve a name from a
  // raycast hit and the catch reads as an object in the world rather than a special case.
  try {
    ctx.props.register({
      id: 'parent',
      object3d: group,
      body: null,
      kind: 'scenery',
      labelKey: 'prop.parent',
      points: 0,
      noise: 0.2,
      mass: 68,
    });
  } catch {
    /* a duplicate id from a hot reload must not take the boot down */
  }

  const api = {
    group,
    body,
    anim,
    nav,
    senses,
    get state() { return state; },
    get position() { return self.pos; },
    get eye() { return self.eye; },
    get detection() { return senses.detection; },
    get alertness() { return senses.alertness; },
    get memory() { return memory; },
    update,
    fixedUpdate,
    lateUpdate,
    reset,

    /** 0..1 — how much of the room's oxygen this NPC is currently taking up. */
    getThreat() {
      const st = ctx.state || {};
      const dur = st.duration || 180;
      const timeT = clamp01(1 - (st.timeLeft === undefined ? dur : st.timeLeft) / dur);
      const chaos = clamp01(st.chaos || 0);
      const own = 0.08 + 0.28 * timeT + 0.34 * chaos + 0.24 * senses.alertness + 0.30 * senses.detection;
      return clamp01(Math.max(pressure, own, STATE_THREAT[state] || 0));
    },

    /**
     * GAME pushes a 0..1 escalation every 0.4 s with a descriptor; menus push a 0..2 tier index or
     * a preset name. Both are honoured, and neither can be mistaken for the other.
     */
    setDifficulty(v, meta) {
      if (meta && typeof meta === 'object') {
        if (meta.preset && PRESET_INDEX[meta.preset] !== undefined) setTier(PRESET_INDEX[meta.preset]);
        if (Number.isFinite(v)) pressure = clamp01(v);
        return tierIndex;
      }
      if (typeof v === 'string') {
        if (PRESET_INDEX[v] !== undefined) setTier(PRESET_INDEX[v]);
        return tierIndex;
      }
      if (!Number.isFinite(v)) return tierIndex;
      if (v > 1.0001 || Number.isInteger(v)) setTier(v);
      else pressure = clamp01(v);
      return tierIndex;
    },

    /** Status effects (sticky hands, the giggles) scale how fast the meter fills. */
    setStealth(k) { senses.setStealth(k); },
    setDetectionScale(k) { senses.setStealth(k); },

    dispose() {
      for (const off of offs) off && off();
      senses.dispose();
      catcher.reset();
    },
  };

  ctx.track({ dispose: () => api.dispose() });

  // Park them in the corridor and settle every damping term before the first frame is shown.
  reset();
  for (let i = 0; i < 6; i++) {
    resetPose();
    if (ctx.state && ctx.state.mode === 'photo') posePhoto(1 / 30);
    else {
      anim.pose(1 / 30, pose);
      applyTransform();
    }
  }
  refreshHead();

  return api;
}
