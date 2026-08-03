// GAME · the rotating objective board (hold Tab).
//
// Three optional goals at a time, drawn with the seeded RNG from a pool of fourteen. Complete one
// and a new one slides in two seconds later, so the board is a rotation rather than a checklist —
// it keeps suggesting a *next* thing to break, which is the job of an objective in a sandbox.
//
// Every objective is filtered against the props that actually exist before it can be drawn: if
// DRESS never registered a pendant, "make the pendant swing" simply never appears, rather than
// sitting on the board forever taunting a player who cannot complete it. That check is the whole
// reason this file knows anything about prop ids.
//
// Objectives take a feed of gameplay facts (a topple, an eat, a pull, a shatter, a combo, metres
// crawled, the current detection level) and return how much progress that fact is worth. Nothing
// here touches physics or the scene.

import { zoneOf, propMatches, isOnFloor, isElevated, isScoring } from './shared.js';

/**
 * `on(type, data, env)` → progress to add (number), or `-Infinity` to wipe progress back to zero.
 * `available(env)` → can this objective ever be completed in the room as built?
 */
export const OBJECTIVE_POOL = [
  {
    id: 'shelf',
    key: 'obj.shelf',
    target: 3,
    bonus: 900,
    available: (env) => env.count((p) => isScoring(p) && onShelf(p)) >= 3,
    on: (type, d) => (type === 'topple' && onShelf(d.prop) ? 1 : 0),
  },
  {
    id: 'floorSnack',
    key: 'obj.floorSnack',
    target: 1,
    bonus: 700,
    available: (env) => env.count((p) => p.kind === 'edible' && isOnFloor(p)) >= 1,
    on: (type, d) => (type === 'eat' && isOnFloor(d.prop) ? 1 : 0),
  },
  {
    id: 'pendant',
    key: 'obj.pendant',
    target: 1,
    bonus: 650,
    available: (env) => env.count((p) => propMatches(p, 'pendant')) >= 1 || env.hasPendulum(),
    on: (type) => (type === 'swing' ? 1 : 0),
  },
  {
    id: 'laptop',
    key: 'obj.laptop',
    target: 1,
    bonus: 900,
    available: (env) => env.count((p) => propMatches(p, 'laptop')) >= 1,
    on: (type, d) => ((type === 'topple' || type === 'pull') && propMatches(d.prop, 'laptop') ? 1 : 0),
  },
  {
    id: 'combo',
    key: 'obj.combo',
    target: 1,
    bonus: 800,
    available: () => true,
    on: (type, d) => (type === 'combo' && d.multiplier >= 4 ? 1 : 0),
  },
  {
    id: 'silent',
    key: 'obj.silent',
    target: 3,
    bonus: 950,
    available: () => true,
    on: (type, d, env) => {
      if (type === 'detect') return d.level > 0.8 ? -Infinity : 0;
      if (type === 'topple' || type === 'eat') return env.detection() < 0.3 ? 1 : 0;
      return 0;
    },
  },
  {
    id: 'plant',
    key: 'obj.plant',
    target: 1,
    bonus: 700,
    available: (env) => env.count((p) => isScoring(p) && propMatches(p, 'plant')) >= 1,
    on: (type, d) => (type === 'topple' && propMatches(d.prop, 'plant') ? 1 : 0),
  },
  {
    id: 'shatter',
    key: 'obj.shatter',
    target: 2,
    bonus: 850,
    available: (env) => env.count((p) => p.fragile) >= 2,
    on: (type) => (type === 'shatter' ? 1 : 0),
  },
  {
    id: 'toys',
    key: 'obj.toys',
    target: 5,
    bonus: 800,
    available: (env) => env.count((p) => isScoring(p) && inZone(p, 'playpen')) >= 5,
    on: (type, d) => (type === 'topple' && inZone(d.prop, 'playpen') ? 1 : 0),
  },
  {
    id: 'curtain',
    key: 'obj.curtain',
    target: 1,
    bonus: 700,
    available: (env) => env.count((p) => propMatches(p, 'curtain')) >= 1,
    on: (type, d) => ((type === 'pull' || type === 'topple') && propMatches(d.prop, 'curtain') ? 1 : 0),
  },
  {
    id: 'speakers',
    key: 'obj.speakers',
    target: 2,
    bonus: 850,
    available: (env) => env.count((p) => propMatches(p, 'speaker')) >= 2,
    on: (type, d) => (type === 'topple' && propMatches(d.prop, 'speaker') ? 1 : 0),
  },
  {
    id: 'crawl',
    key: 'obj.crawl',
    target: 40,
    bonus: 500,
    unit: 'm',
    available: () => true,
    on: (type, d) => (type === 'crawl' ? d.metres : 0),
  },
  {
    id: 'eatThree',
    key: 'obj.eatThree',
    target: 3,
    bonus: 900,
    available: (env) => env.count((p) => p.kind === 'edible') >= 3,
    on: (type) => (type === 'eat' ? 1 : 0),
  },
  {
    id: 'window',
    key: 'obj.window',
    target: 2,
    bonus: 750,
    available: (env) => env.count((p) => isScoring(p) && inZone(p, 'window')) >= 2,
    on: (type, d) => (type === 'topple' && inZone(d.prop, 'window') ? 1 : 0),
  },
];

function inZone(prop, id) {
  const z = zoneOf(prop);
  return !!z && z.id === id;
}

function onShelf(prop) {
  if (!prop) return false;
  return inZone(prop, 'shelf') || (isElevated(prop) && propMatches(prop, 'shelf'));
}

export function createObjectives(ctx, env) {
  const events = ctx.events;
  const ACTIVE = 3;
  const REFILL_DELAY = 2.0;

  let pool = [];
  let active = [];
  let queue = [];
  let refill = 0;
  let dirty = true;
  const completed = [];

  function build() {
    pool = OBJECTIVE_POOL.filter((o) => {
      try {
        return o.available(env);
      } catch {
        return false;
      }
    });
    // Deterministic shuffle from the seeded generator, so a given seed always offers the same
    // opening three and the screenshot harness sees a stable board.
    const order = pool.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(ctx.rng() * (i + 1)) % (i + 1);
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
    queue = order;
    active = [];
    completed.length = 0;
    for (let i = 0; i < ACTIVE && queue.length; i++) take();
    dirty = true;
  }

  function take() {
    const def = queue.shift();
    if (!def) return null;
    const entry = { def, id: def.id, key: def.key, target: def.target, bonus: def.bonus, progress: 0, done: false, fresh: 1 };
    active.push(entry);
    return entry;
  }

  function snapshot() {
    return active.map((e) => ({
      id: e.id,
      key: e.key,
      progress: Math.min(e.progress, e.target),
      target: e.target,
      unit: e.def.unit || null,
      bonus: Math.round(e.bonus * env.bonusScale()),
      done: e.done,
      fraction: e.target > 0 ? Math.min(1, e.progress / e.target) : 0,
    }));
  }

  function publish() {
    dirty = false;
    events.emit('game:objectives', { list: snapshot(), completed: completed.slice() });
  }

  /** Feed a gameplay fact to the board. */
  function feed(type, data) {
    if (!active.length) return;
    for (let i = 0; i < active.length; i++) {
      const e = active[i];
      if (e.done) continue;
      let add = 0;
      try {
        add = e.def.on(type, data, env) || 0;
      } catch {
        add = 0;
      }
      if (add === 0) continue;
      if (add === -Infinity) {
        if (e.progress > 0) {
          e.progress = 0;
          dirty = true;
          events.emit('objective:reset', { id: e.id, key: e.key });
        }
        continue;
      }
      e.progress += add;
      dirty = true;
      if (e.progress >= e.target) complete(e);
    }
  }

  function complete(entry) {
    entry.done = true;
    entry.progress = entry.target;
    const bonus = Math.round(entry.bonus * env.bonusScale());
    completed.push({ id: entry.id, key: entry.key, bonus });
    events.emit('objective:complete', { id: entry.id, key: entry.key, bonus });
    events.emit('ui:toast', { key: 'toast.objective', icon: 'objective', vars: { name: entry.key, bonus } });
    env.awardBonus(bonus, 'toast.objective', entry.key);
    refill = REFILL_DELAY;
    dirty = true;
  }

  function update(dt) {
    if (refill > 0) {
      refill -= dt;
      if (refill <= 0) {
        refill = 0;
        for (let i = active.length - 1; i >= 0; i--) {
          if (active[i].done) active.splice(i, 1);
        }
        while (active.length < ACTIVE && queue.length) take();
        dirty = true;
      }
    }
    if (dirty) publish();
  }

  return {
    build,
    feed,
    update,
    snapshot,
    publish,
    get completed() { return completed; },
    get bonusEarned() { return completed.reduce((a, c) => a + c.bonus, 0); },
    reset() {
      build();
      refill = 0;
      publish();
    },
  };
}
