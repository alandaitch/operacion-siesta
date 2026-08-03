// GAME · the chaos economy: combos, multipliers, popups, ranks and the save file.
//
// The whole round is built to make the player chase the combo. Ruin something within COMBO_WINDOW
// seconds of the last thing and the counter climbs; let it lapse and you drop to x1. The window is
// published on ctx.state every frame so the HUD can draw a bar that visibly, tensely empties.
//
// The multiplier curve is deliberately gentle at the bottom and steep at the top (x1 → x1.5 → x2.3
// → x3.6 → x8): two quick shoves feel like a bonus, an eight-object rampage feels like a crime.
// The cap is x8, reached at a chain of twelve.
//
// Self-balancing economy. GAME does not own the `points` values — DRESS, FURN and ROOM do, and
// they are written in parallel by other agents. So at round start we sum every registered prop and
// scale the whole economy so that ruining literally everything at x1 is worth TARGET_BASE_TOTAL.
// Combos, method bonuses, objectives and the survivor bonus then land a good run at 8–14k and a
// perfect one at ~25k no matter what numbers the set dressers picked.

import { createStore, roundScore, clamp01 } from './shared.js';

/** Ruining the entire room once, with no combo at all, is worth this. */
export const TARGET_BASE_TOTAL = 5000;
/** What "a perfect disaster" scores — used for the chaos meter and the escalation curve. */
export const TARGET_PERFECT = 18000;

export const COMBO_TABLE = Object.freeze([1, 1.25, 1.5, 1.9, 2.3, 2.7, 3.1, 3.6, 4.2, 5, 6, 8]);

export const RANKS = Object.freeze([
  { max: 1500, key: 'end.rank.angel' },      // you barely woke up
  { max: 4000, key: 'end.rank.crawler' },
  { max: 8000, key: 'end.rank.menace' },
  { max: 13000, key: 'end.rank.gremlin' },   // the honest target for a good run
  { max: 18000, key: 'end.rank.wrecker' },
  { max: 25000, key: 'end.rank.hurricane' }, // a perfect disaster lands here
  { max: Infinity, key: 'end.rank.legend' },
]);

export function rankFor(score) {
  for (let i = 0; i < RANKS.length; i++) if (score < RANKS[i].max) return RANKS[i].key;
  return RANKS[RANKS.length - 1].key;
}

export function multiplierFor(combo) {
  if (combo <= 1) return COMBO_TABLE[0];
  const i = Math.min(COMBO_TABLE.length - 1, combo - 1);
  return COMBO_TABLE[i];
}

export function createScoring(ctx, opts = {}) {
  const events = ctx.events;
  const store = createStore('on.');

  let comboWindow = opts.comboWindow || 3.5;
  let pointsScale = 1;      // difficulty
  let economyScale = 1;     // normalisation against whatever the set dressers registered

  let score = 0;
  let combo = 0;
  let comboTimer = 0;
  let bestCombo = 0;
  let awards = 0;

  // --- the ledger: "first time you ever ruined this" ---------------------------------------
  const ledger = store.get('ledger', {}) || {};
  const discoveries = [];

  function isDiscovery(prop) {
    if (!prop || !prop.id) return false;
    return !ledger[prop.id];
  }

  function recordDiscovery(prop) {
    if (!prop || !prop.id) return false;
    const entry = ledger[prop.id];
    if (entry) {
      entry.n = (entry.n || 0) + 1;
      return false;
    }
    ledger[prop.id] = { n: 1, at: Date.now() };
    discoveries.push({ id: prop.id, labelKey: prop.labelKey || 'prop.unknown' });
    return true;
  }

  function saveLedger() {
    store.set('ledger', ledger);
  }

  // --- normalisation ------------------------------------------------------------------------
  function calibrate(totalBase) {
    if (!(totalBase > 0)) {
      economyScale = 1;
      return economyScale;
    }
    const raw = TARGET_BASE_TOTAL / totalBase;
    economyScale = Math.max(0.3, Math.min(3.5, raw));
    return economyScale;
  }

  // --- awarding -------------------------------------------------------------------------------
  /**
   * @param spec {{ amount, reasonKey, labelKey?, propId?, position?, combo?, mult?, icon?, crit? }}
   *   `amount` is pre-multiplier and pre-scale. Set `combo:false` for flat awards (objectives,
   *   survivor bonus) that should neither advance nor consume the chain.
   */
  function award(spec) {
    const useCombo = spec.combo !== false;
    const scaled = (spec.amount || 0) * (spec.scaled === false ? 1 : economyScale) * pointsScale * (spec.mult || 1);
    if (useCombo) {
      if (comboTimer > 0) combo = Math.min(combo + 1, 99);
      else combo = 1;
      comboTimer = comboWindow;
      if (combo > bestCombo) bestCombo = combo;
    }
    const multiplier = useCombo ? multiplierFor(combo) : 1;
    const delta = roundScore(scaled * multiplier);
    score += delta;
    awards++;

    if (ctx.state) {
      ctx.state.score = score;
      ctx.state.combo = combo;
      ctx.state.multiplier = multiplier;
      // The live counter empties on purpose (that's the tension the HUD draws) — this is the
      // peak reached so far this round, so anything polling ctx.state mid-round (or the end
      // screen via stats.bestCombo, see buildStats()) can show the run's high point, not
      // whatever the chain happens to be at the instant it looks.
      ctx.state.bestCombo = bestCombo;
    }

    events.emit('score', {
      delta,
      total: score,
      combo,
      multiplier,
      reasonKey: spec.reasonKey || 'toast.chaos',
    });
    // Richer payload for the floating number the HUD draws at the point of impact.
    events.emit('ui:score', {
      amount: delta,
      total: score,
      combo,
      multiplier,
      reasonKey: spec.reasonKey || 'toast.chaos',
      labelKey: spec.labelKey || null,
      propId: spec.propId || null,
      position: spec.position || null,
      icon: spec.icon || null,
      crit: !!spec.crit || multiplier >= 4,
    });
    if (useCombo) {
      events.emit('combo', { count: combo, multiplier, window: comboWindow, remaining: comboTimer });
    }
    return delta;
  }

  function tick(dt) {
    if (comboTimer > 0) {
      comboTimer -= dt;
      if (comboTimer <= 0) {
        comboTimer = 0;
        if (combo > 0) {
          const ended = combo;
          combo = 0;
          if (ctx.state) {
            ctx.state.combo = 0;
            ctx.state.multiplier = 1;
          }
          events.emit('combo', { count: 0, multiplier: 1, window: comboWindow, remaining: 0, ended });
          events.emit('combo:end', { count: ended });
        }
      }
    }
    if (ctx.state) {
      ctx.state.comboWindow = comboWindow;
      ctx.state.comboRemaining = comboTimer;
      ctx.state.comboFraction = comboWindow > 0 ? clamp01(comboTimer / comboWindow) : 0;
    }
  }

  function reset() {
    score = 0;
    combo = 0;
    comboTimer = 0;
    bestCombo = 0;
    awards = 0;
    discoveries.length = 0;
    if (ctx.state) {
      ctx.state.score = 0;
      ctx.state.combo = 0;
      ctx.state.multiplier = 1;
      ctx.state.comboRemaining = 0;
      ctx.state.comboFraction = 0;
      ctx.state.bestCombo = 0;
    }
  }

  return {
    award,
    tick,
    reset,
    calibrate,
    isDiscovery,
    recordDiscovery,
    saveLedger,
    get discoveries() { return discoveries; },
    get score() { return score; },
    get combo() { return combo; },
    get bestCombo() { return bestCombo; },
    get multiplier() { return multiplierFor(combo); },
    get comboRemaining() { return comboTimer; },
    get economyScale() { return economyScale; },
    get awards() { return awards; },
    set comboWindow(v) { comboWindow = v; },
    get comboWindow() { return comboWindow; },
    set pointsScale(v) { pointsScale = v; },
    get pointsScale() { return pointsScale; },
    /** Persisted best. Returns true when this run beat it. */
    commitHighScore(rankKey, difficulty) {
      const key = `best.${difficulty}`;
      const prev = store.get(key, { score: 0, rank: null }) || { score: 0, rank: null };
      const beaten = score > (prev.score || 0);
      if (beaten) store.set(key, { score, rank: rankKey, at: Date.now() });
      const runs = (store.get('runs', 0) || 0) + 1;
      store.set('runs', runs);
      saveLedger();
      return { beaten, previous: prev.score || 0, best: beaten ? score : prev.score || 0, bestRank: beaten ? rankKey : prev.rank, runs };
    },
    highScore(difficulty) {
      const prev = store.get(`best.${difficulty}`, { score: 0, rank: null }) || { score: 0, rank: null };
      return { score: prev.score || 0, rank: prev.rank || null };
    },
    store,
  };
}
