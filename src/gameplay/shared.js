// GAME · the vocabulary the two gameplay modules share.
//
// rules.js and interactions.js are constructed separately by main.js and never import each other
// — they talk over the event bus. What they *do* share is a dictionary: what a verb is called,
// what a prop is worth, which zone of the room it stands in, which status effect an edible
// carries, and how a prop is parked when it disappears down the baby's throat.
//
// Two design notes that matter:
//
// 1. Nothing here trusts another agent's data. DRESS may register a prop with no points, no mass
//    and no `effect`; FURN may never register a pendant at all. Every lookup degrades to a sane
//    default and every objective that depends on a missing prop simply never enters the pool.
// 2. Parking. Eating has to remove an object from the world *reversibly*, because reset() must
//    restore a whole round. So instead of destroying the body we sink it four metres under the
//    floor and freeze it: rapier stops touching the Object3D the moment prev==cur (see
//    physics.update), which hands the visual transform back to us for the swallow animation.

import * as THREE from 'three';

export const VERB = Object.freeze({
  NONE: 'none',
  PUSH: 'push',
  PULL: 'pull',
  EAT: 'eat',
  CLIMB: 'climb',
});

export const VERB_KEY = Object.freeze({
  push: 'verb.push',
  pull: 'verb.pull',
  eat: 'verb.eat',
  climb: 'verb.climb',
  none: null,
});

/** Physical key each verb is bound to, for the HUD's key cap. */
export const VERB_BINDING = Object.freeze({
  push: 'Space',
  pull: 'E',
  eat: 'F',
  climb: 'Space',
  none: null,
});

// --- economy ------------------------------------------------------------------------------

/** If an author left `points` at 0 we still want the thing to be worth ruining. */
export const KIND_DEFAULT_POINTS = Object.freeze({
  knockable: 120,
  pullable: 160,
  edible: 220,
  hazard: 260,
  scenery: 0,
});

/** How much more a verb is worth than a plain shove. Pulling is fiddly; eating is dangerous. */
export const METHOD_BONUS = Object.freeze({
  push: 1.0,
  pull: 1.18,
  eat: 1.0,
  chain: 1.3, // knocked over by something else the baby knocked over
  climb: 1.0,
});

export function basePoints(prop) {
  if (!prop) return 0;
  const p = Number(prop.points);
  if (Number.isFinite(p) && p > 0) return p;
  return KIND_DEFAULT_POINTS[prop.kind] || 0;
}

export function isScoring(prop) {
  return !!prop && basePoints(prop) > 0;
}

/** Nice round numbers read faster at a glance than 1273 does. */
export function roundScore(n) {
  const v = Math.max(0, n);
  if (v < 100) return Math.max(5, Math.round(v / 5) * 5);
  if (v < 1000) return Math.round(v / 10) * 10;
  return Math.round(v / 25) * 25;
}

// --- edible consequences ------------------------------------------------------------------

const EFFECT_PATTERNS = [
  [/crayon|wax|marker|pencil/i, 'waxy'],
  [/coin|moneda|button|batter|marble|bead/i, 'hiccup'],
  [/pacifier|dummy|chupete|soother|teether|mordillo/i, 'calm'],
  [/snack|crisp|chip|papas|cookie|galleta|biscuit|cereal|sugar|candy/i, 'sugar'],
];

/** Which timed status an edible inflicts. Authors may override with `prop.effect`. */
export function effectFor(prop) {
  if (!prop) return null;
  if (prop.effect) return prop.effect;
  const hay = `${prop.id || ''} ${prop.labelKey || ''}`;
  for (let i = 0; i < EFFECT_PATTERNS.length; i++) {
    if (EFFECT_PATTERNS[i][0].test(hay)) return EFFECT_PATTERNS[i][1];
  }
  return null;
}

// --- zones ---------------------------------------------------------------------------------
// Rectangles in XZ, tested in order — first match wins, so the tighter boxes come first.
// These follow CONTRACTS §2: the shelf run hugs x=-3.22, the sofa the right wall, the playpen
// the near half, the window wall the far end, and everything else is "the lounge".

export const ZONES = Object.freeze([
  { id: 'shelf', key: 'zone.shelf', minX: -3.42, maxX: -2.52, minZ: -3.60, maxZ: 2.60 },
  { id: 'playpen', key: 'zone.playpen', minX: -1.50, maxX: 1.60, minZ: 0.55, maxZ: 3.40 },
  { id: 'sofa', key: 'zone.sofa', minX: 1.50, maxX: 3.42, minZ: -2.70, maxZ: 2.40 },
  { id: 'window', key: 'zone.window', minX: -3.42, maxX: 3.42, minZ: -4.62, maxZ: -3.05 },
  { id: 'lounge', key: 'zone.lounge', minX: -3.42, maxX: 3.42, minZ: -3.05, maxZ: 0.55 },
]);

const _restV = new THREE.Vector3();

/** World rest position of a prop — falls back to wherever its mesh currently is. */
export function restPosition(prop, out = new THREE.Vector3()) {
  if (!prop) return out.set(0, 0, 0);
  if (prop.restPosition) return out.copy(prop.restPosition);
  if (prop.object3d) return prop.object3d.getWorldPosition(out);
  return out.set(0, 0, 0);
}

export function zoneOf(prop) {
  restPosition(prop, _restV);
  for (let i = 0; i < ZONES.length; i++) {
    const z = ZONES[i];
    if (_restV.x >= z.minX && _restV.x <= z.maxX && _restV.z >= z.minZ && _restV.z <= z.maxZ) return z;
  }
  return null;
}

/** Was this thing up on a shelf / a table, i.e. is toppling it a real fall? */
export function isElevated(prop) {
  restPosition(prop, _restV);
  return _restV.y > 0.58;
}

export function isOnFloor(prop) {
  restPosition(prop, _restV);
  return _restV.y < 0.22;
}

const ID_TESTS = {
  shelf: /shelf|book|vinyl|record|magazine|speaker|vase|mug|bottle|espresso/i,
  laptop: /laptop|notebook|macbook/i,
  pendant: /pendant|bulb|lamp\.?cord|ceiling/i,
  plant: /plant|monstera|pot|planter|soil/i,
  speaker: /speaker|monitor|woofer/i,
  curtain: /curtain|sheer|drape/i,
  toy: /toy|plush|teddy|bunny|giraffe|mouse|rattle|ukulele|blocks?|cup|ring|elephant|book\.board/i,
};

export function propMatches(prop, kindName) {
  const re = ID_TESTS[kindName];
  if (!re || !prop) return false;
  return re.test(`${prop.id || ''} ${prop.labelKey || ''}`);
}

// --- input ---------------------------------------------------------------------------------
// GAME owns Space / E / F / Tab. BABY owns movement, but we read its state too when it exposes
// one, so a gamepad or a touch stick wired up later drives the same verbs for free.

const KEY_MAP = {
  Space: 'push',
  KeyE: 'pull',
  KeyF: 'eat',
  Tab: 'objectives',
  KeyW: 'move',
  KeyA: 'move',
  KeyS: 'move',
  KeyD: 'move',
  ArrowUp: 'move',
  ArrowDown: 'move',
  ArrowLeft: 'move',
  ArrowRight: 'move',
};

const TYPING = /^(INPUT|TEXTAREA|SELECT)$/;

export function createKeyReader(target = typeof window !== 'undefined' ? window : null) {
  const down = { push: false, pull: false, eat: false, objectives: false, move: false };
  const edge = { push: false, pull: false, eat: false, objectives: false, move: false };
  const held = new Set();

  function recompute() {
    down.move = held.has('KeyW') || held.has('KeyA') || held.has('KeyS') || held.has('KeyD')
      || held.has('ArrowUp') || held.has('ArrowDown') || held.has('ArrowLeft') || held.has('ArrowRight');
  }

  function onDown(e) {
    if (e.target && e.target.tagName && TYPING.test(e.target.tagName)) return;
    const slot = KEY_MAP[e.code];
    if (!slot) return;
    // Space scrolls the page and Tab walks the focus ring; neither is welcome mid-crawl.
    if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
    if (e.repeat) return;
    held.add(e.code);
    if (slot === 'move') { recompute(); return; }
    if (!down[slot]) edge[slot] = true;
    down[slot] = true;
  }

  function onUp(e) {
    const slot = KEY_MAP[e.code];
    if (!slot) return;
    held.delete(e.code);
    if (slot === 'move') { recompute(); return; }
    down[slot] = false;
  }

  function clear() {
    held.clear();
    for (const k in down) down[k] = false;
    for (const k in edge) edge[k] = false;
  }

  if (target) {
    target.addEventListener('keydown', onDown, { passive: false });
    target.addEventListener('keyup', onUp, { passive: true });
    target.addEventListener('blur', clear);
  }

  return {
    down,
    /** True once per physical press. */
    consume(slot) {
      const v = edge[slot];
      edge[slot] = false;
      return v;
    },
    clearEdges() {
      for (const k in edge) edge[k] = false;
    },
    clear,
    dispose() {
      if (!target) return;
      target.removeEventListener('keydown', onDown);
      target.removeEventListener('keyup', onUp);
      target.removeEventListener('blur', clear);
      clear();
    },
  };
}

/** Merge our own keys with whatever BABY's input module exposes. Either may be authoritative. */
export function mergedInput(ctx, keys) {
  const s = (ctx.input && ctx.input.state) || {};
  const moving = Math.abs(s.forward || 0) + Math.abs(s.strafe || 0) > 0.15 || keys.down.move === true;
  return {
    push: keys.down.push || !!s.action || !!s.push || !!s.headbutt,
    pull: keys.down.pull || !!s.pull || !!s.grab || !!s.yank,
    eat: keys.down.eat || !!s.eat,
    moving,
  };
}

// --- physics helpers -----------------------------------------------------------------------

/** The physics record behind a prop, however its author chose to register it. */
export function recordFor(ctx, prop) {
  const phys = ctx.physics;
  if (!phys || !prop) return null;
  let rec = null;
  try {
    if (prop.body) rec = phys.recordOf(prop.body);
    if (!rec && prop.object3d) rec = phys.recordOf(prop.object3d);
  } catch {
    rec = null;
  }
  return rec && !rec.removed ? rec : null;
}

const _wp = new THREE.Vector3();
const _wq = new THREE.Quaternion();
const _ws = new THREE.Vector3();

/** Current world transform of a record, preferring the physics state over the scene graph. */
export function sampleRecord(rec, outPos, outQuat) {
  if (!rec) return false;
  if (rec.curPos && rec.curQuat) {
    outPos.copy(rec.curPos);
    outQuat.copy(rec.curQuat);
    return true;
  }
  if (rec.object3d) {
    rec.object3d.updateWorldMatrix(true, false);
    rec.object3d.matrixWorld.decompose(outPos, outQuat, _ws);
    return true;
  }
  return false;
}

/** Angle between two orientations, radians. */
export function quatAngle(a, b) {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, dot));
}

// --- parking (eaten props) -------------------------------------------------------------------

/** Remember everything reset() will need to put this prop back exactly where it was. */
export function captureRest(prop) {
  if (!prop) return null;
  let g = prop.__game;
  if (!g) {
    g = prop.__game = {
      parked: false,
      scale: new THREE.Vector3(1, 1, 1),
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      visible: true,
      captured: false,
    };
  }
  if (!g.captured && prop.object3d) {
    const o = prop.object3d;
    g.scale.copy(o.scale);
    g.pos.copy(o.position);
    g.quat.copy(o.quaternion);
    g.visible = o.visible;
    g.captured = true;
  }
  return g;
}

/**
 * Sink a prop's rigid body under the floor and freeze it. Rapier then leaves the Object3D alone
 * (prev==cur after the teleport), so the caller owns the mesh for the swallow animation.
 */
export function parkProp(ctx, prop) {
  const g = captureRest(prop);
  if (!g || g.parked) return g;
  const rec = recordFor(ctx, prop);
  if (rec && ctx.physics) {
    restPosition(prop, _wp);
    try {
      ctx.physics.setVelocity(rec, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
      ctx.physics.teleport(rec, { x: _wp.x, y: _wp.y - 6, z: _wp.z }, null);
      ctx.physics.freeze(rec, true);
    } catch {
      /* a body that has already been removed is fine — the visual is what matters */
    }
  }
  g.parked = true;
  return g;
}

/** Undo parkProp + any swallow animation. Used by rules.reset(). */
export function restoreProp(ctx, prop) {
  const g = prop && prop.__game;
  if (!g || !g.captured) return;
  const o = prop.object3d;
  if (o) {
    o.scale.copy(g.scale);
    o.position.copy(g.pos);
    o.quaternion.copy(g.quat);
    o.visible = g.visible;
  }
  if (g.parked) {
    const rec = recordFor(ctx, prop);
    if (rec && ctx.physics) {
      try {
        ctx.physics.freeze(rec, false);
        if (rec.homePos && rec.homeQuat) ctx.physics.teleport(rec, rec.homePos, rec.homeQuat);
        ctx.physics.sleep(rec);
      } catch {
        /* ignore */
      }
    }
    g.parked = false;
  }
}

// --- misc math -------------------------------------------------------------------------------

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Frame-rate independent exponential approach. */
export const damp = (current, target, lambda, dt) => target + (current - target) * Math.exp(-lambda * dt);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/** localStorage that never throws, and quietly becomes a memory store in private mode. */
export function createStore(prefix = 'on.') {
  const mem = new Map();
  let ls = null;
  try {
    ls = typeof localStorage !== 'undefined' ? localStorage : null;
    if (ls) {
      const probe = `${prefix}__probe`;
      ls.setItem(probe, '1');
      ls.removeItem(probe);
    }
  } catch {
    ls = null;
  }
  return {
    get(key, fallback = null) {
      const k = prefix + key;
      try {
        const raw = ls ? ls.getItem(k) : mem.get(k);
        if (raw === null || raw === undefined) return fallback;
        return JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      const k = prefix + key;
      let raw;
      try {
        raw = JSON.stringify(value);
      } catch {
        return false;
      }
      try {
        if (ls) ls.setItem(k, raw);
        else mem.set(k, raw);
        return true;
      } catch {
        mem.set(k, raw);
        return false;
      }
    },
  };
}
