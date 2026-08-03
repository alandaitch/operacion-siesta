// PHYS · the destruction sandbox. Rapier 0.14, CONTRACTS.md §11.
//
// The physics *is* the gameplay here, so this module is built around three ideas.
//
// 1. Determinism. The world only ever advances inside fixedUpdate() at a hard 1/60 s. update()
//    never steps; it only writes transforms. Every timer in here (contact rate limits, the
//    budget manager, shard lifetimes) counts simulated seconds, never wall clock, so two runs
//    of the same seed produce the same room and the screenshot harness stays diffable.
// 2. Smooth at any refresh rate. Each registered body keeps its previous and current physics
//    transform; update() lerps/slerps between them by an alpha that main.js can set explicitly
//    (setAlpha) or that we infer from the time since the last step. At 120 Hz that turns a
//    60 Hz simulation into motion with no visible stepping.
// 3. The core verb is *shoving*. The kinematic character controller reports every collider it
//    touched, and we convert the baby's momentum into an impulse on each dynamic body it hit,
//    capped so a 200 g board book scatters instead of being fired through a wall. Crawling into
//    a stack of books has to send them flying — that is the whole game.
//
// Everything else is housekeeping the other twelve agents depend on: colliders derived from
// their geometry (box / trimesh / convex hull), a 40-body awake budget that parks whatever is
// furthest behind the player, contact events filtered and rate limited so AUDIO gets one clean
// impact per hit, Voronoi shattering for the fragile props, spherical-joint pendulums for the
// bare bulb and the play-gym toys, and a settle() that fast-forwards the sim at load so nothing
// is caught mid-fall in a screenshot.

import * as THREE from 'three';
import { makeRng } from '../core/rng.js';
import { makeColliderDesc, boundsInBodyFrame, decomposeWorld } from './shapes.js';
import { createContactRouter, guessMaterial } from './contacts.js';
import { createBudget } from './budget.js';
import { createPendulums } from './pendulum.js';
import { scatterSeeds, voronoiCells, shardGeometry, geometryVolume } from './fracture.js';

const FIXED_DT = 1 / 60;
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const IDENT = new THREE.Matrix4();

// Scratch — allocated once, reused forever. Nothing in the step loop may allocate.
const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _box = new THREE.Box3();
const _vec = { x: 0, y: 0, z: 0 };
const _vec2 = { x: 0, y: 0, z: 0 };

const GROUP_BITS = { STATIC: 0x0001, DYNAMIC: 0x0002, CHARACTER: 0x0004, SHARD: 0x0008 };
const ig = (membership, filter) => (((membership << 16) | filter) >>> 0);

export async function createPhysics(ctx) {
  const RAPIER = await import('@dimforge/rapier3d-compat');
  await RAPIER.init();

  const tier = (ctx && ctx.quality && ctx.quality.tier) || 'high';
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;
  world.numSolverIterations = tier === 'ultra' ? 8 : tier === 'high' ? 6 : 4;
  world.numAdditionalFrictionIterations = tier === 'low' ? 2 : 4;

  const eventQueue = new RAPIER.EventQueue(true);

  const GROUPS = {
    static: ig(GROUP_BITS.STATIC, 0xffff),
    dynamic: ig(GROUP_BITS.DYNAMIC, 0xffff),
    character: ig(GROUP_BITS.CHARACTER, GROUP_BITS.STATIC | GROUP_BITS.DYNAMIC | GROUP_BITS.SHARD),
    shard: ig(GROUP_BITS.SHARD, GROUP_BITS.STATIC | GROUP_BITS.DYNAMIC | GROUP_BITS.SHARD | GROUP_BITS.CHARACTER),
    bits: GROUP_BITS,
  };

  // --- bookkeeping ----------------------------------------------------------------------
  const records = [];          // everything with a body
  const dynamicRecords = [];   // the subset we sync + budget
  const byBody = new Map();    // bodyHandle  → record
  const byCollider = new Map();// colliderHandle → record
  const byObject = new Map();  // Object3D    → record
  const shardRecords = [];
  const characters = [];

  let simTime = 0;
  let alpha = 1;
  let alphaExplicit = false;
  let sinceStep = 0;
  let frozen = false;
  let autoSettled = false;
  let stepMs = 0;
  let shatterSeq = 0;
  let removedCount = 0;

  const shardGroup = new THREE.Group();
  shardGroup.name = 'phys.shards';
  shardGroup.matrixAutoUpdate = false;
  if (ctx && ctx.scene) ctx.scene.add(shardGroup);

  // Fracture randomness is seeded from a counter, never Math.random — shatter the same vase in
  // the same order twice and you get the same shards, so screenshots stay diffable.
  const rngFor = (salt) => makeRng((0x5ba7e2 ^ Math.imul(salt, 2654435761)) >>> 0);

  const contacts = createContactRouter({
    world,
    recordForCollider: (h) => byCollider.get(h) || null,
    minForce: 2.5,   // a dropped teether ring still ticks; nothing resting ever does
    minSpeed: 0.12,
    minSpin: 0.8,
    maxPerPairPerSecond: 6,
  });

  // Quality tiers: fewer simultaneously awake bodies and coarser fracture on weak hardware.
  // Nothing here is a hidden cost when it is turned down — it is simply less simulation.
  const TIER_BUDGET = { low: 18, medium: 28, high: 40, ultra: 40 };
  const TIER_PIECES = { low: 6, medium: 9, high: 16, ultra: 24 };
  const TIER_SHARD_LIFE = { low: 7, medium: 10, high: 14, ultra: 14 };
  const budget = createBudget({
    maxAwake: TIER_BUDGET[tier] !== undefined ? TIER_BUDGET[tier] : 40,
    wakeRadius: 0.8,
    sleepFloor: -2,
  });

  // --- resolution helpers ---------------------------------------------------------------
  function recordOf(x) {
    if (x === null || x === undefined || x === false) return null; // handle 0 is a legal handle
    if (x.__physRecord === true) return x;
    if (x.record && x.record.__physRecord === true) return x.record;
    if (typeof x === 'number') return byBody.get(x) || byCollider.get(x) || null;
    if (x.isObject3D) {
      let o = x;
      while (o) {
        const r = byObject.get(o);
        if (r) return r;
        o = o.parent;
      }
      return null;
    }
    if (x.body && x.body.handle !== undefined) return byBody.get(x.body.handle) || null; // prop / wrapper
    if (typeof x.applyImpulse === 'function') return byBody.get(x.handle) || null;       // RigidBody
    if (typeof x.parent === 'function') return byCollider.get(x.handle) || null;         // Collider
    if (x.object3d) return recordOf(x.object3d);
    return null;
  }

  function bodyOf(x) {
    if (x === null || x === undefined || x === false) return null;
    const rec = recordOf(x);
    if (rec && rec.body) return rec.body;
    if (typeof x === 'number') { try { return world.getRigidBody(x) || null; } catch { return null; } }
    if (x.body && typeof x.body.applyImpulse === 'function') return x.body;
    if (typeof x.applyImpulse === 'function') return x;
    if (typeof x.parent === 'function') { try { return x.parent(); } catch { return null; } }
    return null;
  }

  // --- transform sync -------------------------------------------------------------------
  // Bodies live in world space; their Object3D usually does not (DRESS parents everything to a
  // group). We cache one inverted parent matrix per unique parent per sync pass.
  const parentCache = new Map();
  let syncTick = 0;

  function parentInverse(parent) {
    let entry = parentCache.get(parent);
    if (!entry) {
      entry = { tick: -1, mat: new THREE.Matrix4(), identity: false };
      parentCache.set(parent, entry);
    }
    if (entry.tick !== syncTick) {
      entry.tick = syncTick;
      const e = parent.matrixWorld.elements;
      const id = IDENT.elements;
      let same = true;
      for (let i = 0; i < 16; i++) {
        if (Math.abs(e[i] - id[i]) > 1e-9) { same = false; break; }
      }
      entry.identity = same;
      if (!same) entry.mat.copy(parent.matrixWorld).invert();
    }
    return entry;
  }

  function captureRecord(rec, resetPrev) {
    const t = rec.body.translation();
    const r = rec.body.rotation();
    if (resetPrev) {
      rec.prevPos.set(t.x, t.y, t.z);
      rec.prevQuat.set(r.x, r.y, r.z, r.w);
    } else {
      rec.prevPos.copy(rec.curPos);
      rec.prevQuat.copy(rec.curQuat);
    }
    rec.curPos.set(t.x, t.y, t.z);
    rec.curQuat.set(r.x, r.y, r.z, r.w);
  }

  function applyRecord(rec, a) {
    const o = rec.object3d;
    if (!o) return;
    if (a >= 0.999) {
      _p.copy(rec.curPos);
      _q.copy(rec.curQuat);
    } else {
      _p.lerpVectors(rec.prevPos, rec.curPos, a);
      _q.slerpQuaternions(rec.prevQuat, rec.curQuat, a);
    }
    const parent = o.parent;
    if (!parent) {
      o.position.copy(_p);
      o.quaternion.copy(_q);
      return;
    }
    const entry = parentInverse(parent);
    if (entry.identity) {
      o.position.copy(_p);
      o.quaternion.copy(_q);
    } else {
      _m.compose(_p, _q, UNIT_SCALE).premultiply(entry.mat);
      _m.decompose(o.position, o.quaternion, _s);
    }
  }

  function syncAll(resetPrev) {
    for (let i = 0; i < dynamicRecords.length; i++) {
      const rec = dynamicRecords[i];
      if (rec.removed || !rec.body) continue;
      captureRecord(rec, true);
      if (resetPrev) applyRecord(rec, 1);
    }
    syncTick++;
  }

  // --- registration ---------------------------------------------------------------------
  function makeRecord(object3d, body, collider, opts, kindTag) {
    const rec = {
      __physRecord: true,
      id: opts.id || (object3d && object3d.name) || `body${body.handle}`,
      object3d: object3d || null,
      body,
      collider: collider || null,
      colliderHandles: collider ? [collider.handle] : [],
      kind: kindTag,
      dynamic: kindTag === 'dynamic' || kindTag === 'shard' || kindTag === 'pendulum',
      material: opts.material || guessMaterial(object3d, kindTag === 'static' ? 'wood' : 'generic'),
      mass: opts.mass !== undefined ? opts.mass : 1,
      _prop: opts.prop || null,
      pinned: !!opts.pinned,
      settled: false,
      removed: false,
      recycle: opts.recycle || (kindTag === 'shard' ? 'remove' : 'home'),
      dist2: 0,
      prevPos: new THREE.Vector3(),
      prevQuat: new THREE.Quaternion(),
      curPos: new THREE.Vector3(),
      curQuat: new THREE.Quaternion(),
      homePos: new THREE.Vector3(),
      homeQuat: new THREE.Quaternion(),
      shard: null,
    };

    // PHYS may register a body before or after its author registers the prop, so resolve lazily.
    Object.defineProperty(rec, 'prop', {
      configurable: true,
      enumerable: true,
      get() {
        return (this.object3d && this.object3d.userData && this.object3d.userData.prop) || this._prop || null;
      },
      set(v) { this._prop = v; },
    });

    const t = body.translation();
    const r = body.rotation();
    rec.curPos.set(t.x, t.y, t.z);
    rec.prevPos.copy(rec.curPos);
    rec.homePos.copy(rec.curPos);
    rec.curQuat.set(r.x, r.y, r.z, r.w);
    rec.prevQuat.copy(rec.curQuat);
    rec.homeQuat.copy(rec.curQuat);

    records.push(rec);
    byBody.set(body.handle, rec);
    if (collider) byCollider.set(collider.handle, rec);
    if (object3d) {
      byObject.set(object3d, rec);
      object3d.userData.physics = rec;
    }
    if (rec.dynamic) dynamicRecords.push(rec);
    return rec;
  }

  function unregister(rec) {
    if (!rec || rec.removed) return;
    rec.removed = true;
    removedCount++;
    for (let i = 0; i < rec.colliderHandles.length; i++) byCollider.delete(rec.colliderHandles[i]);
    byBody.delete(rec.body.handle);
    if (rec.object3d) {
      byObject.delete(rec.object3d);
      if (rec.object3d.userData) rec.object3d.userData.physics = null;
    }
    let i = records.indexOf(rec);
    if (i >= 0) records.splice(i, 1);
    i = dynamicRecords.indexOf(rec);
    if (i >= 0) dynamicRecords.splice(i, 1);
    i = shardRecords.indexOf(rec);
    if (i >= 0) shardRecords.splice(i, 1);
    try { world.removeRigidBody(rec.body); } catch { /* already gone */ }
  }

  function configureCollider(desc, opts, mass, isStatic) {
    desc.setFriction(opts.friction !== undefined ? opts.friction : (isStatic ? 0.8 : 0.7));
    desc.setRestitution(opts.restitution !== undefined ? opts.restitution : (isStatic ? 0.1 : 0.15));
    // Average both ways: this is a room of soft furnishings, so a bouncy prop landing on the
    // wool rug should be damped by it rather than keeping its own restitution (Max would).
    if (RAPIER.CoefficientCombineRule) {
      desc.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average);
      desc.setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Average);
    }
    if (!isStatic) {
      desc.setMass(Math.max(0.005, mass));
      desc.setCollisionGroups(opts.groups !== undefined ? opts.groups : GROUPS.dynamic);
      desc.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
      desc.setContactForceEventThreshold(
        opts.contactThreshold !== undefined ? opts.contactThreshold : contacts.thresholdFor(mass),
      );
    } else {
      desc.setCollisionGroups(opts.groups !== undefined ? opts.groups : GROUPS.static);
    }
    if (opts.sensor) desc.setSensor(true);
    return desc;
  }

  // --- public: statics ------------------------------------------------------------------
  function addStatic(object3d, opts = {}) {
    if (!object3d) {
      console.warn('[phys] addStatic called with no object3d');
      return null;
    }
    let built;
    try {
      built = makeColliderDesc(RAPIER, object3d, opts);
    } catch (err) {
      console.warn('[phys] addStatic could not build a collider for', object3d.name || object3d, err);
      return null;
    }
    decomposeWorld(object3d, _p, _q, _s);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(_p.x, _p.y, _p.z)
        .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }),
    );
    configureCollider(built.desc, opts, 0, true);
    if (built.offset && (built.offset.x || built.offset.y || built.offset.z)) {
      built.desc.setTranslation(built.offset.x, built.offset.y, built.offset.z);
    }
    const collider = world.createCollider(built.desc, body);
    const rec = makeRecord(object3d, body, collider, opts, 'static');
    rec.half = built.half || null;
    return rec;
  }

  // --- public: dynamics -----------------------------------------------------------------
  function addDynamic(object3d, opts = {}) {
    if (!object3d) {
      console.warn('[phys] addDynamic called with no object3d');
      return null;
    }
    const mass = opts.mass !== undefined ? opts.mass : 1;
    let built;
    try {
      built = makeColliderDesc(RAPIER, object3d, opts);
    } catch (err) {
      console.warn('[phys] addDynamic could not build a collider for', object3d.name || object3d, err);
      return null;
    }
    decomposeWorld(object3d, _p, _q, _s);

    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(_p.x, _p.y, _p.z)
      .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
      .setLinearDamping(opts.linearDamping !== undefined ? opts.linearDamping : 0.15)
      .setAngularDamping(opts.angularDamping !== undefined ? opts.angularDamping : 0.4)
      .setCanSleep(opts.sleep !== false)
      .setCcdEnabled(!!opts.ccd);
    if (opts.gravityScale !== undefined) desc.setGravityScale(opts.gravityScale);
    if (opts.startAsleep) desc.setSleeping(true);
    if (opts.linvel) desc.setLinvel(opts.linvel.x || 0, opts.linvel.y || 0, opts.linvel.z || 0);
    if (opts.solverIterations) desc.setAdditionalSolverIterations(opts.solverIterations);

    const body = world.createRigidBody(desc);
    configureCollider(built.desc, opts, mass, false);
    if (built.offset && (built.offset.x || built.offset.y || built.offset.z)) {
      built.desc.setTranslation(built.offset.x, built.offset.y, built.offset.z);
    }
    const collider = world.createCollider(built.desc, body);

    const rec = makeRecord(object3d, body, collider, { ...opts, mass }, 'dynamic');
    rec.half = built.half || null;
    return rec;
  }

  // --- public: the baby -----------------------------------------------------------------
  function addCharacter(position, opts = {}) {
    const radius = opts.radius !== undefined ? opts.radius : 0.16;
    const halfHeight = opts.halfHeight !== undefined ? opts.halfHeight : 0.13;
    const charMass = opts.mass !== undefined ? opts.mass : 9.0; // a 10-month-old
    const px = position ? (position.x || 0) : 0;
    const py = position ? (position.y || 0) : 0;
    const pz = position ? (position.z || 0) : 0;

    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(px, py, pz),
    );
    // The contract describes the baby as a capsule (r 0.16, hh 0.13) and the extents below match
    // that exactly — but the collider is a CYLINDER of the same bounds, deliberately. Rapier's
    // stair handling never fires for a rounded sole: every ledge reads as an unclimbable slope
    // off the bottom hemisphere, and the baby simply stops dead at the playpen sill. A flat sole
    // of identical footprint climbs the sill and is stopped by the sofa, which is the design.
    const shape = opts.shape || 'cylinder';
    const cd = shape === 'capsule'
      ? RAPIER.ColliderDesc.capsule(halfHeight, radius)
      : RAPIER.ColliderDesc.cylinder(halfHeight + radius, radius);
    cd.setFriction(0.4)
      .setRestitution(0)
      .setCollisionGroups(opts.groups !== undefined ? opts.groups : GROUPS.character);
    const collider = world.createCollider(cd, body);

    const skin = opts.offset !== undefined ? opts.offset : 0.02;
    const controller = world.createCharacterController(skin);
    controller.setUp({ x: 0, y: 1, z: 0 });
    controller.setSlideEnabled(true);
    // 0.12 m: enough to mount the play mat and the padded playpen sill, nowhere near the sofa.
    // Rapier measures the step from the collider's skin, so the requested height plus the
    // controller offset is what actually yields a 0.12 m effective step (measured: 0.12 climbs,
    // 0.16 does not, 0.42 never).
    const stepHeight = opts.autostep !== undefined ? opts.autostep : 0.12;
    controller.enableAutostep(stepHeight + skin, 0.05, true);
    controller.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(opts.maxSlope !== undefined ? opts.maxSlope : 50));
    controller.setMinSlopeSlideAngle(THREE.MathUtils.degToRad(48));
    controller.enableSnapToGround(opts.snapToGround !== undefined ? opts.snapToGround : 0.08);
    controller.setApplyImpulsesToDynamicBodies(false); // we do our own, below, with caps
    controller.setCharacterMass(charMass);
    controller.setNormalNudgeFactor(0.0001);

    const rec = makeRecord(opts.object3d || null, body, collider, {
      ...opts, mass: charMass, material: opts.material || 'flesh', pinned: true,
    }, 'character');
    rec.dynamic = false;

    const collisionOut = new RAPIER.CharacterCollision();
    const pushPool = [];
    const collisionPool = [];
    const applied = new THREE.Vector3();
    const velocity = new THREE.Vector3();
    const desired = new THREE.Vector3();
    const groundNormal = new THREE.Vector3(0, 1, 0);
    const excludeSelf = (c) => c.handle !== collider.handle;

    const wrapper = {
      controller,
      collider,
      body,
      record: rec,
      object3d: opts.object3d || null,
      radius,
      halfHeight,
      shape,
      /** Distance from the body origin to the sole — the same for both collider shapes. */
      footOffset: halfHeight + radius,
      autostep: stepHeight,
      mass: charMass,
      grounded: false,
      groundNormal,
      groundCollider: null,
      groundObject: null,
      groundMaterial: 'floor',
      collisions: [],
      pushed: [],
      velocity,
      desiredVelocity: desired,
      pushGain: opts.pushGain !== undefined ? opts.pushGain : 0.55,
      leanAccel: opts.leanAccel !== undefined ? opts.leanAccel : 2.2,
      maxPushDeltaV: opts.maxPushDeltaV !== undefined ? opts.maxPushDeltaV : 3.0,

      isGrounded() { return wrapper.grounded; },

      position(out = new THREE.Vector3()) {
        const t = body.translation();
        return out.set(t.x, t.y, t.z);
      },

      setPosition(p) {
        if (!p) return;
        body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
        body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
        captureRecord(rec, true);
      },

      /**
       * @param desiredTranslation {x,y,z} movement wanted this step (metres, already dt-scaled)
       * @returns THREE.Vector3 the translation actually applied (a fresh vector, safe to keep)
       */
      move(desiredTranslation, dt = FIXED_DT) {
        wrapper.collisions.length = 0;
        wrapper.pushed.length = 0;
        if (!desiredTranslation) { applied.set(0, 0, 0); return applied.clone(); }

        _vec.x = desiredTranslation.x || 0;
        _vec.y = desiredTranslation.y || 0;
        _vec.z = desiredTranslation.z || 0;

        try {
          controller.computeColliderMovement(
            collider, _vec, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, excludeSelf,
          );
        } catch (err) {
          console.error('[phys] character move failed', err);
          applied.set(0, 0, 0);
          return applied.clone();
        }

        const mv = controller.computedMovement();
        applied.set(mv.x, mv.y, mv.z);
        const t = body.translation();
        _vec2.x = t.x + mv.x;
        _vec2.y = t.y + mv.y;
        _vec2.z = t.z + mv.z;
        body.setNextKinematicTranslation(_vec2);

        const invDt = dt > 0 ? 1 / dt : 60;
        velocity.set(mv.x * invDt, mv.y * invDt, mv.z * invDt);
        // The shove uses *intent*, not the resolved movement: the controller stops you dead
        // against the very stack you are trying to flatten, and a zeroed velocity there would
        // make the books immovable. Wanting to move into something is what shoves it.
        desired.set(_vec.x * invDt, _vec.y * invDt, _vec.z * invDt);

        wrapper.grounded = controller.computedGrounded();
        wrapper.groundCollider = null;
        wrapper.groundObject = null;
        wrapper.groundMaterial = 'floor';
        let bestUp = 0.55;

        const n = controller.numComputedCollisions();
        for (let i = 0; i < n; i++) {
          const hit = controller.computedCollision(i, collisionOut);
          if (!hit || !hit.collider) continue;
          const other = hit.collider;
          const orec = byCollider.get(other.handle) || null;
          const nrm = hit.normal1;
          const pt = hit.witness1;

          let entry = collisionPool[wrapper.collisions.length];
          if (!entry) {
            entry = {
              collider: null, object3d: null, prop: null, material: 'generic', dynamic: false,
              normal: new THREE.Vector3(), point: new THREE.Vector3(), impulse: 0,
            };
            collisionPool[wrapper.collisions.length] = entry;
          }
          entry.collider = other;
          entry.object3d = orec ? orec.object3d : null;
          entry.prop = orec ? orec.prop : null;
          entry.material = orec ? orec.material : 'generic';
          entry.normal.set(nrm.x, nrm.y, nrm.z);
          entry.point.set(pt.x, pt.y, pt.z);
          entry.impulse = 0;
          entry.dynamic = false;

          if (nrm.y > bestUp) {
            bestUp = nrm.y;
            groundNormal.set(nrm.x, nrm.y, nrm.z);
            wrapper.groundCollider = other;
            wrapper.groundObject = entry.object3d;
            wrapper.groundMaterial = entry.material;
          }

          // ---- THE SHOVE -----------------------------------------------------------
          const ob = other.parent();
          if (ob && ob.isDynamic && ob.isDynamic()) {
            entry.dynamic = true;
            // Only lateral contacts shove. A near-vertical normal means the baby is standing on
            // the thing (the play mat, a cushion, a toy) and pressing it through the floor is not
            // the fantasy. Horizontal intent only, so the constant gravity component of the
            // desired translation never leaks into the impulse.
            const into = nrm.y < 0.7 ? -(desired.x * nrm.x + desired.z * nrm.z) : 0;
            const speed = into > 0 ? into : 0;
            const m2 = Math.max(0.02, ob.mass() || 0.2);
            let j = speed > 0 ? charMass * (speed * wrapper.pushGain + wrapper.leanAccel * dt) : 0;
            const cap = m2 * wrapper.maxPushDeltaV;
            if (j > cap) j = cap;
            if (j > 1e-4) {
              _vec.x = -nrm.x * j;
              _vec.y = -nrm.y * j * 0.4;   // do not launch things at the ceiling
              _vec.z = -nrm.z * j;
              _vec2.x = pt.x; _vec2.y = pt.y; _vec2.z = pt.z;
              ob.applyImpulseAtPoint(_vec, _vec2, true);
              entry.impulse = j;

              let push = pushPool[wrapper.pushed.length];
              if (!push) {
                push = { object3d: null, prop: null, body: null, impulse: 0, material: 'generic', point: new THREE.Vector3() };
                pushPool[wrapper.pushed.length] = push;
              }
              push.object3d = entry.object3d;
              push.prop = entry.prop;
              push.body = ob;
              push.impulse = j;
              push.material = entry.material;
              push.point.copy(entry.point);
              wrapper.pushed.push(push);
            }
          }

          wrapper.collisions.push(entry);
        }

        // Snap-to-ground can land us on a surface with no reported collision. Probe for it.
        if (wrapper.grounded && !wrapper.groundCollider) {
          const t2 = body.translation();
          const hit = api.raycast(
            { x: t2.x, y: t2.y, z: t2.z }, { x: 0, y: -1, z: 0 },
            halfHeight + radius + 0.2, { exclude: collider },
          );
          if (hit) {
            groundNormal.copy(hit.normal);
            wrapper.groundCollider = hit.collider;
            wrapper.groundObject = hit.object3d;
            wrapper.groundMaterial = hit.material;
          }
        }

        return applied.clone();
      },

      remove() {
        const i = characters.indexOf(wrapper);
        if (i >= 0) characters.splice(i, 1);
        try { world.removeCharacterController(controller); } catch { /* already gone */ }
        unregister(rec);
      },
    };

    characters.push(wrapper);
    return wrapper;
  }

  // --- public: queries ------------------------------------------------------------------
  const _ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  let _excludeSet = null;
  const _rayPredicate = (c) => !(_excludeSet && _excludeSet.has(c.handle));
  const _ballCache = new Map();

  function ballShape(radius) {
    const key = Math.round(radius * 1000);
    let b = _ballCache.get(key);
    if (!b) {
      b = new RAPIER.Ball(Math.max(0.001, key / 1000));
      if (_ballCache.size < 48) _ballCache.set(key, b);
    }
    return b;
  }

  function buildExclude(exclude) {
    if (!exclude) return null;
    const list = Array.isArray(exclude) ? exclude : [exclude];
    let set = null;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e) continue;
      let handles = null;
      if (typeof e === 'number') handles = [e];
      else if (e.handle !== undefined && typeof e.parent === 'function') handles = [e.handle];
      else {
        const rec = recordOf(e);
        if (rec) handles = rec.colliderHandles;
      }
      if (!handles) continue;
      if (!set) set = new Set();
      for (let k = 0; k < handles.length; k++) set.add(handles[k]);
    }
    return set;
  }

  function hitResult(collider, point, normal, distance) {
    const rec = collider ? byCollider.get(collider.handle) : null;
    return {
      point,
      normal,
      distance,
      collider: collider || null,
      body: collider ? collider.parent() : null,
      object3d: rec ? rec.object3d : null,
      prop: rec ? rec.prop : null,
      material: rec ? rec.material : 'generic',
      record: rec || null,
    };
  }

  function raycast(origin, direction, maxDistance = 10, opts = {}) {
    if (!origin || !direction) return null;
    _p.set(direction.x || 0, direction.y || 0, direction.z || 0);
    const len = _p.length();
    if (len < 1e-9) return null;
    _p.multiplyScalar(1 / len);

    _ray.origin.x = origin.x; _ray.origin.y = origin.y; _ray.origin.z = origin.z;
    _ray.dir.x = _p.x; _ray.dir.y = _p.y; _ray.dir.z = _p.z;

    _excludeSet = buildExclude(opts.exclude);
    let hit = null;
    try {
      hit = world.castRayAndGetNormal(
        _ray, maxDistance, opts.solid !== false,
        opts.filterFlags !== undefined ? opts.filterFlags : RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        opts.filterGroups, undefined, undefined,
        _excludeSet ? _rayPredicate : undefined,
      );
    } catch (err) {
      console.error('[phys] raycast failed', err);
      hit = null;
    }
    _excludeSet = null;
    if (!hit) return null;

    const d = hit.timeOfImpact;
    return hitResult(
      hit.collider,
      new THREE.Vector3(origin.x + _p.x * d, origin.y + _p.y * d, origin.z + _p.z * d),
      new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      d,
    );
  }

  function sphereCast(origin, radius, direction, maxDistance = 5, opts = {}) {
    if (!origin || !direction) return null;
    _p.set(direction.x || 0, direction.y || 0, direction.z || 0);
    const len = _p.length();
    if (len < 1e-9) return null;
    _p.multiplyScalar(1 / len);

    _excludeSet = buildExclude(opts.exclude);
    let hit = null;
    try {
      hit = world.castShape(
        origin, { x: 0, y: 0, z: 0, w: 1 }, _p, ballShape(radius), 0, maxDistance, true,
        opts.filterFlags !== undefined ? opts.filterFlags : RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        opts.filterGroups, undefined, undefined,
        _excludeSet ? _rayPredicate : undefined,
      );
    } catch (err) {
      console.error('[phys] sphereCast failed', err);
      hit = null;
    }
    _excludeSet = null;
    if (!hit) return null;

    const d = hit.time_of_impact;
    const w = hit.witness1 || { x: 0, y: 0, z: 0 };
    const n = hit.normal1 || { x: 0, y: 1, z: 0 };
    return hitResult(
      hit.collider,
      new THREE.Vector3(origin.x + _p.x * d + w.x, origin.y + _p.y * d + w.y, origin.z + _p.z * d + w.z),
      new THREE.Vector3(-n.x, -n.y, -n.z),
      d,
    );
  }

  const _overlapOut = [];
  const _overlapSeen = new Set();
  function overlapSphere(center, radius) {
    _overlapOut.length = 0;
    _overlapSeen.clear();
    if (!center) return [];
    try {
      world.intersectionsWithShape(
        center, { x: 0, y: 0, z: 0, w: 1 }, ballShape(radius),
        (c) => {
          const rec = byCollider.get(c.handle);
          if (rec && rec.object3d && !_overlapSeen.has(rec.object3d)) {
            _overlapSeen.add(rec.object3d);
            _overlapOut.push(rec.object3d);
          }
          return true;
        },
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      );
    } catch (err) {
      console.error('[phys] overlapSphere failed', err);
    }
    return _overlapOut.slice();
  }

  // --- public: forces & state -----------------------------------------------------------
  function impulse(handleOrObject, vec3, atPoint) {
    const body = bodyOf(handleOrObject);
    if (!body || !vec3 || !body.isDynamic || !body.isDynamic()) return false;
    _vec.x = vec3.x || 0; _vec.y = vec3.y || 0; _vec.z = vec3.z || 0;
    if (atPoint) {
      _vec2.x = atPoint.x; _vec2.y = atPoint.y; _vec2.z = atPoint.z;
      body.applyImpulseAtPoint(_vec, _vec2, true);
    } else {
      body.applyImpulse(_vec, true);
    }
    return true;
  }

  function torqueImpulse(handleOrObject, vec3) {
    const body = bodyOf(handleOrObject);
    if (!body || !vec3 || !body.isDynamic || !body.isDynamic()) return false;
    _vec.x = vec3.x || 0; _vec.y = vec3.y || 0; _vec.z = vec3.z || 0;
    body.applyTorqueImpulse(_vec, true);
    return true;
  }

  function setVelocity(handleOrObject, linear, angular) {
    const body = bodyOf(handleOrObject);
    if (!body) return false;
    if (linear) body.setLinvel({ x: linear.x || 0, y: linear.y || 0, z: linear.z || 0 }, true);
    if (angular) body.setAngvel({ x: angular.x || 0, y: angular.y || 0, z: angular.z || 0 }, true);
    return true;
  }

  function remove(handleOrObject) {
    const rec = recordOf(handleOrObject);
    if (rec) { unregister(rec); return true; }
    const body = bodyOf(handleOrObject);
    if (!body) return false;
    try { world.removeRigidBody(body); } catch { /* already gone */ }
    return true;
  }

  function setGravityScale(handleOrObject, s) {
    const body = bodyOf(handleOrObject);
    if (!body) return false;
    body.setGravityScale(s, true);
    return true;
  }

  function freeze(a, b) {
    // freeze(bool) — whole world, for photo-mode determinism.
    if (a === undefined || typeof a === 'boolean') {
      frozen = a === undefined ? true : a;
      return frozen;
    }
    // freeze(body, bool) — one body pinned in place, collisions intact.
    const rec = recordOf(a);
    const body = bodyOf(a);
    if (!body) return false;
    const on = b !== false;
    if (on) {
      if (rec) rec.frozenType = body.bodyType();
      body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      body.setBodyType(RAPIER.RigidBodyType.Fixed, false);
    } else {
      body.setBodyType(
        rec && rec.frozenType !== undefined ? rec.frozenType : RAPIER.RigidBodyType.Dynamic, true,
      );
      if (rec) rec.frozenType = undefined;
    }
    return true;
  }

  function wake(handleOrObject) {
    const body = bodyOf(handleOrObject);
    if (!body) return false;
    body.wakeUp();
    return true;
  }

  function sleep(handleOrObject) {
    const body = bodyOf(handleOrObject);
    if (!body) return false;
    body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    body.sleep();
    return true;
  }

  function teleport(handleOrObject, position, quaternion) {
    const rec = recordOf(handleOrObject);
    const body = bodyOf(handleOrObject);
    if (!body) return false;
    if (position) body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    if (quaternion) {
      body.setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w }, true);
    }
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    if (rec) { captureRecord(rec, true); applyRecord(rec, 1); }
    return true;
  }

  /** How far a body has strayed from where it was authored — GAME uses this to detect topples. */
  function displacement(handleOrObject) {
    const rec = recordOf(handleOrObject);
    if (!rec) return null;
    _q2.copy(rec.homeQuat).invert().premultiply(rec.curQuat);
    const angle = 2 * Math.acos(Math.min(1, Math.abs(_q2.w)));
    return { distance: rec.curPos.distanceTo(rec.homePos), angle };
  }

  function returnHome(rec) {
    if (!rec || rec.removed) return;
    if (rec.recycle === 'remove') {
      if (rec.shard) killShard(rec);
      else unregister(rec);
      return;
    }
    rec.body.setTranslation({ x: rec.homePos.x, y: rec.homePos.y + 0.05, z: rec.homePos.z }, true);
    rec.body.setRotation({ x: rec.homeQuat.x, y: rec.homeQuat.y, z: rec.homeQuat.z, w: rec.homeQuat.w }, true);
    rec.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    rec.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    captureRecord(rec, true);
    applyRecord(rec, 1);
  }

  // --- public: shattering ---------------------------------------------------------------
  function killShard(rec) {
    if (!rec || rec.removed) return;
    const mesh = rec.object3d;
    unregister(rec);
    if (mesh) {
      if (mesh.parent) mesh.parent.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
    }
  }

  function firstMaterial(object3d) {
    let mat = null;
    object3d.traverse((o) => {
      if (mat || !o.material) return;
      mat = Array.isArray(o.material) ? o.material[0] : o.material;
    });
    if (mat) return mat;
    if (ctx && ctx.materials && ctx.materials.get) return ctx.materials.get('ceramic.white');
    return new THREE.MeshStandardMaterial({ color: 0xd8d2c8, roughness: 0.55 });
  }

  /**
   * Break a prop into convex Voronoi shards. Removes the intact body, hides the source mesh and
   * returns the shard meshes so FX/DRESS can style them (they carry userData.shardFade 1→0).
   */
  function shatter(object3d, options = {}) {
    if (!object3d) {
      console.warn('[phys] shatter called with no object3d');
      return [];
    }
    const cap = TIER_PIECES[tier] !== undefined ? TIER_PIECES[tier] : 16;
    const pieces = Math.max(2, Math.min(cap, options.pieces !== undefined ? options.pieces : 12));
    const rec = recordOf(object3d);
    const lifetime = options.lifetime !== undefined
      ? options.lifetime
      : (TIER_SHARD_LIFE[tier] !== undefined ? TIER_SHARD_LIFE[tier] : 14);

    boundsInBodyFrame(object3d, _box);
    if (_box.isEmpty()) {
      console.warn('[phys] shatter: no geometry on', object3d.name || object3d);
      return [];
    }
    const half = _box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    half.set(Math.max(half.x, 0.006), Math.max(half.y, 0.006), Math.max(half.z, 0.006));
    const centre = _box.getCenter(new THREE.Vector3());

    decomposeWorld(object3d, _p, _q, _s);
    const worldPos = _p.clone();
    const worldQuat = _q.clone();
    const invQuat = worldQuat.clone().invert();

    // Impact focus in the fracture frame (box centre at origin).
    let focus = null;
    if (options.at) {
      focus = new THREE.Vector3(options.at.x, options.at.y, options.at.z)
        .sub(worldPos).applyQuaternion(invQuat).sub(centre);
    } else if (options.impulse) {
      focus = new THREE.Vector3(options.impulse.x, options.impulse.y, options.impulse.z)
        .applyQuaternion(invQuat);
      if (focus.lengthSq() > 1e-8) focus.normalize().multiply(half).multiplyScalar(-0.55);
      else focus = null;
    }

    const rnd = rngFor(++shatterSeq);
    const seeds = scatterSeeds(half, pieces, rnd, focus, focus ? 0.5 : 0);
    const cells = voronoiCells(half, seeds);
    if (!cells.length) {
      console.warn('[phys] shatter produced no cells for', object3d.name || object3d);
      return [];
    }

    const material = options.material || firstMaterial(object3d);
    const totalMass = options.mass !== undefined ? options.mass
      : (rec && rec.mass) || (rec && rec.prop && rec.prop.mass) || 0.8;
    const uvScale = Math.max(half.x, half.y, half.z) * 2;

    const geos = [];
    let volumeSum = 0;
    for (let i = 0; i < cells.length; i++) {
      const geo = shardGeometry(cells[i].points, uvScale);
      if (!geo) { geos.push(null); continue; }
      const v = geometryVolume(geo) || 1e-5;
      volumeSum += v;
      geos.push({ geo, v });
    }
    if (volumeSum <= 0) volumeSum = 1;

    const meshes = [];
    const worldCentre = centre.clone().applyQuaternion(worldQuat).add(worldPos);
    const impulseVec = options.impulse || null;
    const spread = options.spread !== undefined ? options.spread : 1;

    for (let i = 0; i < cells.length; i++) {
      const g = geos[i];
      if (!g) continue;
      const cell = cells[i];
      const local = _p2.copy(cell.center).add(centre);
      const wp = local.clone().applyQuaternion(worldQuat).add(worldPos);

      const mesh = new THREE.Mesh(g.geo, material);
      mesh.name = `${object3d.name || 'shard'}.shard${i}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.copy(wp);
      mesh.quaternion.copy(worldQuat);
      mesh.userData.shardFade = 1;
      mesh.userData.shardSource = object3d;
      mesh.userData.shardMaterial = (rec && rec.material) || guessMaterial(object3d, 'ceramic');
      shardGroup.add(mesh);

      const mass = Math.max(0.004, totalMass * (g.v / volumeSum));
      const positions = new Float32Array(cell.points.length * 3);
      for (let k = 0; k < cell.points.length; k++) {
        positions[k * 3] = cell.points[k].x;
        positions[k * 3 + 1] = cell.points[k].y;
        positions[k * 3 + 2] = cell.points[k].z;
      }
      let cd = null;
      try { cd = RAPIER.ColliderDesc.convexHull(positions); } catch { cd = null; }
      if (!cd) {
        g.geo.boundingBox.getSize(_s);
        cd = RAPIER.ColliderDesc.cuboid(
          Math.max(_s.x * 0.5, 0.004), Math.max(_s.y * 0.5, 0.004), Math.max(_s.z * 0.5, 0.004),
        );
      }
      cd.setMass(mass)
        .setFriction(0.72)
        .setRestitution(0.12)
        .setCollisionGroups(GROUPS.shard)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(contacts.thresholdFor(mass) * 1.6);

      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(wp.x, wp.y, wp.z)
          .setRotation({ x: worldQuat.x, y: worldQuat.y, z: worldQuat.z, w: worldQuat.w })
          .setLinearDamping(0.2)
          .setAngularDamping(0.5)
          .setCanSleep(true),
      );
      const collider = world.createCollider(cd, body);

      // Blow outward from the fracture centre, plus whatever the caller asked for.
      _p.copy(wp).sub(worldCentre);
      if (_p.lengthSq() < 1e-8) _p.set(rnd() - 0.5, rnd() * 0.4, rnd() - 0.5);
      _p.normalize().multiplyScalar(mass * (0.55 + rnd() * 0.7) * spread);
      _p.y += mass * 0.35 * spread;
      if (impulseVec) {
        _p.x += (impulseVec.x || 0) * mass * 0.5;
        _p.y += (impulseVec.y || 0) * mass * 0.5;
        _p.z += (impulseVec.z || 0) * mass * 0.5;
      }
      body.applyImpulse({ x: _p.x, y: _p.y, z: _p.z }, true);
      body.applyTorqueImpulse({
        x: (rnd() - 0.5) * mass * 0.02,
        y: (rnd() - 0.5) * mass * 0.02,
        z: (rnd() - 0.5) * mass * 0.02,
      }, true);

      const srec = makeRecord(mesh, body, collider, {
        mass,
        material: mesh.userData.shardMaterial,
        recycle: 'remove',
      }, 'shard');
      srec.shard = { born: simTime, life: lifetime, fade: 1 };
      shardRecords.push(srec);
      meshes.push(mesh);
    }

    // The intact prop is gone.
    if (rec) unregister(rec);
    object3d.visible = false;
    object3d.userData.shattered = true;

    if (ctx && ctx.events) {
      ctx.events.emit('fx:impact', {
        position: worldCentre,
        force: 1,
        material: (rec && rec.material) || guessMaterial(object3d, 'ceramic'),
      });
    }

    return meshes;
  }

  function updateShards(dt) {
    for (let i = shardRecords.length - 1; i >= 0; i--) {
      const rec = shardRecords[i];
      if (rec.removed) { shardRecords.splice(i, 1); continue; }
      const s = rec.shard;
      const age = simTime - s.born;
      if (age >= s.life) { killShard(rec); continue; }
      const fadeWindow = 3;
      const f = age > s.life - fadeWindow ? Math.max(0, (s.life - age) / fadeWindow) : 1;
      s.fade = f;
      const mesh = rec.object3d;
      if (!mesh) continue;
      mesh.userData.shardFade = f;
      // If nobody claimed the fade, shrink the shard away so it does not simply pop out.
      if (!mesh.userData.shardFadeHandled && f < 1) {
        const k = 0.15 + 0.85 * f;
        mesh.scale.setScalar(k);
      }
    }
  }

  // --- pendulums ------------------------------------------------------------------------
  const pendulums = createPendulums({
    RAPIER,
    world,
    GROUPS,
    registerLink: (object3d, body, collider, opts) => makeRecord(object3d, body, collider, opts, 'pendulum'),
    unregister,
  });

  // --- debug ----------------------------------------------------------------------------
  let debugLines = null;
  function ensureDebug() {
    if (debugLines) return debugLines;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true, depthTest: false, transparent: true, opacity: 0.85, toneMapped: false,
    });
    debugLines = new THREE.LineSegments(geo, mat);
    debugLines.name = 'phys.debug';
    debugLines.frustumCulled = false;
    debugLines.renderOrder = 999;
    debugLines.userData.update = updateDebug;
    if (ctx && ctx.track) { ctx.track(geo); ctx.track(mat); }
    return debugLines;
  }

  function updateDebug() {
    if (!debugLines) return null;
    const buffers = world.debugRender();
    const geo = debugLines.geometry;
    const vCount = buffers.vertices.length / 3;
    let posAttr = geo.getAttribute('position');
    let colAttr = geo.getAttribute('color');
    if (!posAttr || posAttr.count !== vCount) {
      posAttr = new THREE.BufferAttribute(new Float32Array(vCount * 3), 3);
      colAttr = new THREE.BufferAttribute(new Float32Array(vCount * 3), 3);
      geo.setAttribute('position', posAttr);
      geo.setAttribute('color', colAttr);
    }
    posAttr.array.set(buffers.vertices);
    for (let i = 0; i < vCount; i++) {
      colAttr.array[i * 3] = buffers.colors[i * 4];
      colAttr.array[i * 3 + 1] = buffers.colors[i * 4 + 1];
      colAttr.array[i * 3 + 2] = buffers.colors[i * 4 + 2];
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    geo.setDrawRange(0, vCount);
    geo.computeBoundingSphere();
    return debugLines;
  }

  // --- the loop -------------------------------------------------------------------------
  const focusPoint = new THREE.Vector3();
  function currentFocus() {
    if (characters.length) return characters[0].position(focusPoint);
    if (ctx && ctx.camera) return focusPoint.copy(ctx.camera.position);
    return focusPoint.set(0, 0.4, 0);
  }

  function stepOnce(withEvents) {
    if (withEvents) {
      world.step(eventQueue);
      simTime += FIXED_DT;
      contacts.drain(eventQueue, simTime);
    } else {
      world.step();
      simTime += FIXED_DT;
    }
  }

  /** Fast-forward the sim so nothing is caught mid-fall in a screenshot. */
  function settle(seconds = 1.2) {
    autoSettled = true; // an explicit settle satisfies the automatic one
    const steps = Math.max(0, Math.min(600, Math.round(seconds / FIXED_DT)));
    if (!steps) return 0;
    const wasFrozen = frozen;
    frozen = false;
    for (let i = 0; i < steps; i++) stepOnce(false);
    frozen = wasFrozen;
    eventQueue.clear();
    syncAll(true);
    for (let i = 0; i < dynamicRecords.length; i++) applyRecord(dynamicRecords[i], 1);
    syncTick++;
    return steps;
  }

  const api = {
    RAPIER,
    world,
    GROUPS,
    FIXED_DT,
    records,
    dynamicRecords,
    characters,
    pendulums: pendulums.all,

    // --- §11 frozen API -------------------------------------------------------------
    addStatic,
    addDynamic,
    addCharacter,
    raycast,
    sphereCast,
    overlapSphere,
    impulse,
    remove,
    setGravityScale,
    freeze,
    onContact: (cb) => contacts.on(cb),
    offContact: (cb) => contacts.off(cb),
    debugMesh() { ensureDebug(); updateDebug(); return debugLines; },

    // --- destruction & extras -------------------------------------------------------
    shatter,
    addPendulum: pendulums.addPendulum,
    torqueImpulse,
    setVelocity,
    teleport,
    displacement,
    wake,
    sleep,
    settle,
    updateDebug,
    bodyOf,
    recordOf,
    materialOf: (x) => { const r = recordOf(x); return r ? r.material : guessMaterial(x, 'generic'); },
    propOf: (x) => { const r = recordOf(x); return r ? r.prop : null; },
    get frozen() { return frozen; },
    setFrozen(v) { frozen = !!v; },
    get simTime() { return simTime; },
    get awakeBudget() { return budget.maxAwake; },
    setAwakeBudget(n) { budget.maxAwake = n; },

    /** main.js may drive interpolation explicitly; otherwise we infer it from frame time. */
    setAlpha(a) {
      alphaExplicit = true;
      alpha = a < 0 ? 0 : a > 1 ? 1 : a;
    },

    stats() {
      return {
        bodies: records.length,
        dynamic: dynamicRecords.length,
        awake: budget.awake,
        shards: shardRecords.length,
        contacts: contacts.dispatched,
        overflow: budget.overflow,
        removed: removedCount,
        stepMs,
        simTime,
      };
    },

    // --- lifecycle ------------------------------------------------------------------
    fixedUpdate(dt) {
      if (!autoSettled) {
        autoSettled = true;
        const photo = ctx && ctx.state && ctx.state.mode === 'photo';
        settle(photo ? 1.6 : 0.8);
      }
      if (frozen) return;

      const t0 = performance.now();
      stepOnce(true);
      stepMs = stepMs * 0.9 + (performance.now() - t0) * 0.1;

      for (let i = 0; i < dynamicRecords.length; i++) {
        const rec = dynamicRecords[i];
        if (rec.removed || !rec.body) continue;
        const asleep = rec.body.isSleeping();
        if (asleep) {
          // Land the visual exactly on the resting transform, then stop touching it entirely.
          if (!rec.settled) { captureRecord(rec, true); applyRecord(rec, 1); rec.settled = true; }
          continue;
        }
        rec.settled = false;
        captureRecord(rec, false);
      }
      for (let i = 0; i < characters.length; i++) captureRecord(characters[i].record, false);

      budget.tick(dt || FIXED_DT, dynamicRecords, currentFocus(), returnHome);
      updateShards(dt || FIXED_DT);

      if (!alphaExplicit) sinceStep = 0;
    },

    update(dt) {
      if (!alphaExplicit) {
        sinceStep += dt || 0;
        const a = sinceStep / FIXED_DT;
        alpha = a > 1 ? 1 : a < 0 ? 0 : a;
      }
      syncTick++;
      for (let i = 0; i < dynamicRecords.length; i++) {
        const rec = dynamicRecords[i];
        if (rec.removed || !rec.object3d) continue;
        // Nothing moved between the last two physics states: the visual is already correct.
        if (rec.prevPos.equals(rec.curPos) && rec.prevQuat.equals(rec.curQuat)) continue;
        applyRecord(rec, alpha);
      }
      for (let i = 0; i < characters.length; i++) {
        const rec = characters[i].record;
        if (rec.object3d && !rec.removed) applyRecord(rec, alpha);
      }
      if (debugLines && debugLines.parent && debugLines.visible) updateDebug();
    },

    reset() {
      for (let i = shardRecords.length - 1; i >= 0; i--) killShard(shardRecords[i]);
      shardRecords.length = 0;
      for (let i = 0; i < dynamicRecords.length; i++) {
        const rec = dynamicRecords[i];
        if (rec.removed || rec.kind === 'pendulum') continue;
        rec.body.setTranslation({ x: rec.homePos.x, y: rec.homePos.y, z: rec.homePos.z }, true);
        rec.body.setRotation(
          { x: rec.homeQuat.x, y: rec.homeQuat.y, z: rec.homeQuat.z, w: rec.homeQuat.w }, true,
        );
        rec.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
        rec.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
        rec.body.sleep();
        captureRecord(rec, true);
        applyRecord(rec, 1);
        if (rec.object3d) rec.object3d.visible = true;
      }
      contacts.clear();
      budget.reset();
      frozen = false;
      autoSettled = true;
      syncTick++;
    },

    dispose() {
      for (let i = shardRecords.length - 1; i >= 0; i--) killShard(shardRecords[i]);
      pendulums.disposeAll();
      for (let i = characters.length - 1; i >= 0; i--) characters[i].remove();
      records.length = 0;
      dynamicRecords.length = 0;
      byBody.clear();
      byCollider.clear();
      byObject.clear();
      parentCache.clear();
      contacts.listeners.clear();
      if (shardGroup.parent) shardGroup.parent.remove(shardGroup);
      if (debugLines) {
        if (debugLines.parent) debugLines.parent.remove(debugLines);
        debugLines.geometry.dispose();
        debugLines.material.dispose();
        debugLines = null;
      }
      try { eventQueue.free(); } catch { /* already freed */ }
      try { world.free(); } catch { /* already freed */ }
    },
  };

  // Settle while the boot overlay is still up, so the very first rendered frame is already at
  // rest and no screenshot ever catches a book halfway to the floor.
  if (ctx && ctx.events) {
    ctx.events.on('boot:done', () => {
      if (autoSettled) return;
      autoSettled = true;
      settle(ctx.state && ctx.state.mode === 'photo' ? 1.6 : 1.0);
    });
  }

  if (ctx && ctx.track) ctx.track({ dispose: () => api.dispose() });
  return api;
}
