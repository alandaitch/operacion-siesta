// The context object every module receives, plus the PropRegistry — the spine of the game.
//
// A "prop" is anything the baby can ruin: a vase to topple, a snack bag to eat, a curtain to
// yank. Authors of the room/furniture/dressing modules register props; the rules, AI, audio and
// FX modules only ever see the registry and the event bus. That indirection is what lets a
// dozen agents write these systems in parallel without importing each other.

import * as THREE from 'three';

export function createPropRegistry(events) {
  /** @type {Map<string, any>} */
  const byId = new Map();
  const byObject = new WeakMap();
  const list = [];

  const DEFAULTS = {
    kind: 'scenery',
    points: 0,
    noise: 0.3,
    mass: 1,
    fragile: false,
    edibleTime: 1.5,
    reaction: 'yum',
    toppled: false,
    eaten: false,
    restPosition: null,
    restQuaternion: null,
    labelKey: 'prop.unknown',
  };

  return {
    list,
    register(spec) {
      if (!spec || !spec.id) throw new Error('[props] every prop needs an id');
      if (byId.has(spec.id)) {
        console.warn(`[props] duplicate prop id "${spec.id}" — ignoring the second one`);
        return byId.get(spec.id);
      }
      const prop = { ...DEFAULTS, ...spec };
      if (prop.object3d) {
        prop.restPosition = prop.object3d.getWorldPosition(new THREE.Vector3());
        prop.restQuaternion = prop.object3d.getWorldQuaternion(new THREE.Quaternion());
        prop.object3d.userData.prop = prop;
        byObject.set(prop.object3d, prop);
        prop.object3d.traverse((o) => byObject.set(o, prop));
      }
      byId.set(prop.id, prop);
      list.push(prop);
      events.emit('prop:registered', { prop });
      return prop;
    },
    get: (id) => byId.get(id),
    fromObject(obj) {
      let o = obj;
      while (o) {
        const p = byObject.get(o);
        if (p) return p;
        o = o.parent;
      }
      return null;
    },
    ofKind: (kind) => list.filter((p) => p.kind === kind),
    /** Mark a prop as ruined. Idempotent — only the first topple scores. */
    topple(prop, impulse = 1, position = null) {
      if (!prop || prop.toppled) return false;
      prop.toppled = true;
      const pos = position || prop.object3d?.getWorldPosition(new THREE.Vector3()) || new THREE.Vector3();
      events.emit('prop:toppled', { prop, impulse, position: pos });
      events.emit('noise', {
        position: pos,
        loudness: prop.noise * Math.min(1, 0.4 + impulse * 0.6),
        source: prop.id,
      });
      if (prop.fragile) events.emit('prop:shattered', { prop, position: pos });
      prop.onTopple?.(prop, impulse);
      return true;
    },
    eat(prop) {
      if (!prop || prop.eaten) return false;
      prop.eaten = true;
      prop.toppled = true;
      const pos = prop.object3d?.getWorldPosition(new THREE.Vector3()) || new THREE.Vector3();
      events.emit('prop:eaten', { prop, reaction: prop.reaction, position: pos });
      events.emit('noise', { position: pos, loudness: prop.noise * 0.5, source: prop.id });
      return true;
    },
    stats() {
      const total = list.filter((p) => p.points > 0).length;
      const done = list.filter((p) => p.points > 0 && p.toppled).length;
      return { total, done, ratio: total ? done / total : 0 };
    },
    reset() {
      for (const p of list) {
        p.toppled = false;
        p.eaten = false;
      }
    },
  };
}

export function createContext({ renderer, scene, camera, engine, quality, events, rngFns }) {
  const disposables = new Set();

  const ctx = {
    THREE,
    renderer,
    scene,
    camera,
    engine,
    quality,
    events,
    ...rngFns,
    props: createPropRegistry(events),
    materials: null,
    physics: null,
    audio: null,
    i18n: null,
    fx: null,
    layout: null,
    baby: null,
    lighting: null,
    parent: null,
    state: {
      mode: 'boot', // boot | menu | playing | paused | over | photo
      score: 0,
      combo: 0,
      multiplier: 1,
      timeLeft: 180,
      view: 'first', // first | third
      caught: false,
      started: false,
      shot: null,
    },
    dt: 0,
    elapsed: 0,
    debug: { enabled: false },
    track(obj) {
      if (obj) disposables.add(obj);
      return obj;
    },
    disposeAll() {
      for (const d of disposables) {
        try {
          d.dispose?.();
        } catch {
          /* ignore */
        }
      }
      disposables.clear();
    },
  };
  return ctx;
}
