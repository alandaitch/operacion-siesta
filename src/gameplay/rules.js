// GAME · the round: three minutes of naptime, one chaos score, one parent walking in.
//
// WHAT MAKES A RUN. Every ruined prop pays base points × how you did it × where it was × how close
// the parent was × the combo multiplier. The combo is the thing you actually chase: ruin something
// within COMBO_WINDOW seconds of the last one and the counter climbs to x8, and the window is
// published on ctx.state every frame so the HUD can draw it emptying.
//
// TOPPLE DETECTION. Nobody tells us a vase fell over — we watch. Every scoring prop with a rigid
// body gets a baseline transform at round start, and a round-robin watcher (a slice of the list per
// frame, so the cost is flat regardless of how many props DRESS registered) compares the live
// physics transform against it. Displacement OR tilt OR a drop counts. That is what makes chains
// work: a book knocked off the shelf by another book scores on its own, credited as `chain`.
//
// ESCALATION. Chaos, elapsed time and accumulated noise feed one 0..1 threat value that is pushed
// to the parent AI, while the light drifts from 17:20 toward dusk. The room closes in as you wreck
// it, which is both the difficulty curve and the reason the last minute feels different.
//
// EVERYTHING DEGRADES. AI, LIGHT, UI and AUDIO are authored in parallel; every call into them is
// optional and every objective that depends on a prop nobody registered is filtered out of the
// pool before the round starts.

import * as THREE from 'three';
import { createScoring, TARGET_PERFECT, rankFor, multiplierFor } from './scoring.js';
import { createStatusSystem } from './status.js';
import { createObjectives } from './objectives.js';
import {
  METHOD_BONUS, ZONES, basePoints, isScoring, isElevated, zoneOf, effectFor, propMatches,
  recordFor, sampleRecord, quatAngle, restoreProp, captureRest, createKeyReader,
  clamp, clamp01, damp,
} from './shared.js';

export const DIFFICULTY = Object.freeze({
  gentle: { id: 'gentle', duration: 210, threat: 0.72, points: 0.92, window: 4.5, eat: 0.85, survivor: 1200 },
  standard: { id: 'standard', duration: 180, threat: 1.0, points: 1.0, window: 3.5, eat: 1.0, survivor: 1500 },
  feral: { id: 'feral', duration: 150, threat: 1.38, points: 1.18, window: 3.0, eat: 1.15, survivor: 2000 },
});

const KIND_MULT = Object.freeze({ knockable: 1.0, pullable: 1.1, edible: 1.0, hazard: 1.25, scenery: 1.0 });

const DISCOVERY_BONUS = 125;
const VARIETY_BONUS = 150;
const ZONE_BONUS = 900;
const ZONE_MIN_PROPS = 3;
const CREDIT_WINDOW = 2.6;     // seconds a push/pull still counts as "you did that"
const WATCH_PER_FRAME = { low: 6, medium: 8, high: 12, ultra: 14 };
const CATCH_TIMEOUT = 1.7;     // if AI announces 'catching' but never confirms
const CATCH_RADIUS = 0.52;
// A round starts already sitting through ctx.physics.settle() (see resetRound()), but that is a
// best effort, not a guarantee every body is asleep the instant the player gets control. For this
// short window after `elapsed` resets to 0, the topple watcher treats any motion it sees as the
// tail of that settle finishing, not as something the player caused: it re-baselines instead of
// scoring. This is the belt to resetRound()'s suspenders — the contract is score===0 at round
// start, full stop, regardless of how the physics engine's sleep timing behaves on a given run.
const SETTLE_GRACE = 0.35;

export function createRules(ctx) {
  const events = ctx.events;
  const tier = (ctx.quality && ctx.quality.tier) || 'high';
  const perFrame = WATCH_PER_FRAME[tier] || 12;

  const scoring = createScoring(ctx);
  const status = createStatusSystem(ctx);
  const keys = createKeyReader();

  // --- round state ---------------------------------------------------------------------------
  let preset = DIFFICULTY[(scoring.store.get('difficulty', 'standard') || 'standard')] || DIFFICULTY.standard;
  let running = false;
  let over = false;
  let elapsed = 0;
  let timeLeft = preset.duration;
  let distance = 0;
  let crawlBucket = 0;
  let detection = 0;
  let noiseHeat = 0;
  let threat = 0;
  let lastThreatSent = -1;
  let threatClock = 0;
  let duskSent = -1;
  let catchTimer = 0;
  let variety = [];

  const ruined = { knockable: 0, pullable: 0, edible: 0, hazard: 0, scenery: 0, fragile: 0 };
  const pointsBy = { knockable: 0, pullable: 0, edible: 0, hazard: 0, scenery: 0 };
  const eatenList = [];
  const zonesCleared = [];
  const credit = new Map();   // propId → { method, t }
  const swung = new Set();

  // --- topple watcher -------------------------------------------------------------------------
  const watch = [];
  let watchCursor = 0;
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _babyPos = new THREE.Vector3();
  const _lastBaby = new THREE.Vector3();
  let hasLastBaby = false;
  const _parentPos = new THREE.Vector3();

  function buildWatch() {
    watch.length = 0;
    watchCursor = 0;
    // (The pendant's swing is detected below through its registered prop — the `w.pendant` branch
    // in the watch loop — so there is no separate rapier-side pendulum list to maintain here.)
    const list = (ctx.props && ctx.props.list) || [];
    for (let i = 0; i < list.length; i++) {
      const prop = list[i];
      // Scoring props are watched for topples; the pendant is watched for swinging even if its
      // author gave it no points.
      if (!isScoring(prop) && !propMatches(prop, 'pendant')) continue;
      captureRest(prop);
      const rec = recordFor(ctx, prop);
      if (!rec) continue;
      const w = {
        prop,
        rec,
        pos0: new THREE.Vector3(),
        quat0: new THREE.Quaternion(),
        move: 0,
        tilt: 0.52,
        pendant: propMatches(prop, 'pendant'),
      };
      if (!sampleRecord(rec, w.pos0, w.quat0)) continue;
      const half = rec.half;
      const footprint = half ? Math.min(half.x, half.z) : 0.06;
      w.move = clamp(Math.max(0.055, footprint * 0.9) + (rec.mass || 0.5) * 0.008, 0.055, 0.16);
      watch.push(w);
    }
  }

  function tickWatch() {
    if (!watch.length) return;
    const n = Math.min(perFrame, watch.length);
    const settling = elapsed < SETTLE_GRACE;
    for (let k = 0; k < n; k++) {
      const w = watch[watchCursor];
      watchCursor = (watchCursor + 1) % watch.length;
      const prop = w.prop;
      if (!prop || prop.toppled || prop.eaten) continue;
      const rec = w.rec;
      if (!rec || rec.removed) continue;
      if (!sampleRecord(rec, _pos, _quat)) continue;

      if (settling) {
        // Still inside the post-reset grace window: whatever this is, it is not the player's
        // doing. Track it as the new rest pose so it can never retroactively count once the
        // window ends, instead of leaving a stale baseline that would read as a huge topple.
        w.pos0.copy(_pos);
        w.quat0.copy(_quat);
        continue;
      }

      // The pendant is not "toppled" — it swings. Different objective, no score.
      if (w.pendant) {
        if (!swung.has(prop.id) && _pos.distanceTo(w.pos0) > 0.045) {
          swung.add(prop.id);
          objectives.feed('swing', { prop });
          events.emit('ui:toast', { key: 'toast.swing', icon: 'pendant', vars: {} });
        }
        continue;
      }

      const moved = _pos.distanceTo(w.pos0);
      const dropped = w.pos0.y - _pos.y;
      const tilted = quatAngle(_quat, w.quat0);
      if (moved > w.move || dropped > 0.10 || tilted > w.tilt) {
        const impulse = clamp(moved * 2 + tilted, 0.2, 3);
        ctx.props.topple(prop, impulse, _pos.clone());
      }
    }
  }

  // --- environment for the objective board ------------------------------------------------------
  const env = {
    count(pred) {
      const list = (ctx.props && ctx.props.list) || [];
      let n = 0;
      for (let i = 0; i < list.length; i++) {
        try {
          if (pred(list[i])) n++;
        } catch {
          /* a malformed prop should never take the board down */
        }
      }
      return n;
    },
    hasPendulum() {
      const p = ctx.physics;
      return !!(p && p.pendulums && p.pendulums.length);
    },
    detection: () => detection,
    bonusScale: () => preset.points,
    awardBonus(amount, reasonKey, labelKey) {
      scoring.award({ amount, reasonKey, labelKey, combo: false, scaled: false, icon: 'objective' });
    },
  };
  const objectives = createObjectives(ctx, env);

  // --- scoring hooks ------------------------------------------------------------------------------

  function methodFor(prop) {
    const c = credit.get(prop.id);
    if (c && (ctx.elapsed || elapsed) - c.t < CREDIT_WINDOW) return c.method;
    return 'chain';
  }

  function noteVariety(kind) {
    variety.push(kind);
    if (variety.length > 3) variety.shift();
    if (variety.length === 3 && variety[0] !== variety[1] && variety[1] !== variety[2] && variety[0] !== variety[2]) {
      variety.length = 0;
      scoring.award({ amount: VARIETY_BONUS, reasonKey: 'toast.variety', combo: false, scaled: false, icon: 'variety' });
      events.emit('ui:toast', { key: 'toast.variety', icon: 'variety', vars: {} });
    }
  }

  function checkZone(prop) {
    const z = zoneOf(prop);
    if (!z) return;
    if (zonesCleared.indexOf(z.id) >= 0) return;
    const list = (ctx.props && ctx.props.list) || [];
    let total = 0;
    let done = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!isScoring(p)) continue;
      const pz = zoneOf(p);
      if (!pz || pz.id !== z.id) continue;
      total++;
      if (p.toppled || p.eaten) done++;
    }
    if (total < ZONE_MIN_PROPS || done < total) return;
    zonesCleared.push(z.id);
    scoring.award({
      amount: ZONE_BONUS, reasonKey: 'toast.perfectZone', labelKey: z.key,
      combo: false, scaled: false, icon: 'zone', crit: true,
    });
    events.emit('ui:toast', { key: 'toast.perfectZone', icon: 'zone', vars: { zone: z.key } });
    events.emit('game:zone', { id: z.id, key: z.key, cleared: zonesCleared.length, total: ZONES.length });
    events.emit('camera:shake', { amount: 0.5, duration: 0.5 });
  }

  function awardRuin(prop, position, method) {
    const kind = prop.kind || 'knockable';
    let mult = METHOD_BONUS[method] || 1;
    mult *= KIND_MULT[kind] || 1;
    if (prop.fragile) mult *= 1.35;
    if (isElevated(prop)) mult *= 1.25;
    // Doing it while the parent is nearly onto you is worth more. Risk is the whole game.
    mult *= 1 + detection * (method === 'eat' ? 0.7 : 0.5);

    const reasonKey = method === 'eat' ? 'toast.eaten'
      : method === 'pull' ? 'toast.yanked'
        : method === 'chain' ? 'toast.chain' : 'toast.toppled';

    const delta = scoring.award({
      amount: basePoints(prop) * mult,
      reasonKey,
      labelKey: prop.labelKey,
      propId: prop.id,
      position,
      icon: kind,
      crit: !!prop.fragile,
    });

    ruined[kind] = (ruined[kind] || 0) + 1;
    pointsBy[kind] = (pointsBy[kind] || 0) + delta;
    if (prop.fragile) ruined.fragile++;

    if (scoring.recordDiscovery(prop)) {
      scoring.award({
        amount: DISCOVERY_BONUS, reasonKey: 'toast.discovery', labelKey: prop.labelKey,
        combo: false, scaled: false, icon: 'new',
      });
      events.emit('ui:toast', { key: 'toast.discovery', icon: 'new', vars: { name: prop.labelKey } });
    }

    noteVariety(kind);
    checkZone(prop);
    return delta;
  }

  function onToppled(payload) {
    if (!running || !payload || !payload.prop) return;
    const prop = payload.prop;
    if (!isScoring(prop)) return;
    const method = methodFor(prop);
    awardRuin(prop, payload.position || null, method);
    objectives.feed('topple', { prop, method });
  }

  function onEaten(payload) {
    if (!running || !payload || !payload.prop) return;
    const prop = payload.prop;
    eatenList.push({ id: prop.id, labelKey: prop.labelKey || 'prop.unknown', reaction: prop.reaction || 'yum' });
    if (isScoring(prop)) awardRuin(prop, payload.position || null, 'eat');
    objectives.feed('eat', { prop });

    const effect = effectFor(prop);
    if (effect) status.apply(effect, prop);
    events.emit('game:ate', { prop, effect, reaction: prop.reaction || 'yum', count: eatenList.length });
  }

  function onShattered(payload) {
    if (!running || !payload || !payload.prop) return;
    objectives.feed('shatter', { prop: payload.prop });
  }

  // --- escalation -----------------------------------------------------------------------------------

  function escalate(dt) {
    noiseHeat = damp(noiseHeat, 0, 0.28, dt);
    const chaos01 = clamp01(scoring.score / TARGET_PERFECT);
    const timeT = preset.duration > 0 ? clamp01(elapsed / preset.duration) : 0;
    const raw = 0.12 + 0.50 * chaos01 + 0.26 * timeT + 0.30 * noiseHeat;
    threat = clamp01(raw * preset.threat);

    if (ctx.state) {
      ctx.state.chaos = chaos01;
      ctx.state.threat = threat;
      ctx.state.noiseHeat = noiseHeat;
    }

    threatClock -= dt;
    if (threatClock <= 0 && Math.abs(threat - lastThreatSent) > 0.02) {
      threatClock = 0.4;
      lastThreatSent = threat;
      const p = ctx.parent;
      if (p) {
        // AI's signature is a 0..1 level; the descriptor rides along for anyone who wants more.
        try {
          p.setDifficulty?.(threat, { preset: preset.id, chaos: chaos01, time: timeT, noise: noiseHeat });
        } catch {
          /* the AI module is authored in parallel — never let it take the round down */
        }
        try {
          p.setDetectionScale?.(status.stealthMultiplier());
          p.setStealth?.(status.stealthMultiplier());
        } catch {
          /* optional */
        }
      }
      events.emit('game:threat', { threat, chaos: chaos01, preset: preset.id });
    }

    // The light closes in: 17:20 at rest, past 18:35 when the room is destroyed.
    const dusk = clamp01(0.35 * timeT + 0.65 * chaos01);
    if (Math.abs(dusk - duskSent) > 0.015) {
      duskSent = dusk;
      const hours = 17.33 + 1.25 * dusk;
      const l = ctx.lighting;
      if (l) {
        try {
          if (typeof l.setDusk === 'function') l.setDusk(dusk);
          else l.setTimeOfDay?.(hours, { hours, t: dusk, dusk, chaos: ctx.state ? ctx.state.chaos : 0 });
        } catch {
          /* LIGHT is authored in parallel; a signature mismatch must not end the round */
        }
      }
      events.emit('game:dusk', { dusk, hours });
    }
  }

  // --- the round ------------------------------------------------------------------------------------

  function calibrate() {
    const list = (ctx.props && ctx.props.list) || [];
    let total = 0;
    for (let i = 0; i < list.length; i++) total += basePoints(list[i]);
    scoring.calibrate(total);
    return total;
  }

  function start() {
    if (running) return;
    resetRound();
    running = true;
    over = false;
    elapsed = 0;
    timeLeft = preset.duration;
    if (ctx.state) {
      ctx.state.started = true;
      ctx.state.caught = false;
      ctx.state.timeLeft = timeLeft;
      ctx.state.duration = preset.duration;
      ctx.state.difficulty = preset.id;
      ctx.state.eatScale = preset.eat;
    }
    ctx.elapsed = 0;
    calibrate();
    buildWatch();
    objectives.build();
    objectives.publish();
    events.emit('game:start', {
      difficulty: preset.id,
      duration: preset.duration,
      props: watch.length,
      best: scoring.highScore(preset.id),
    });
    events.emit('ui:toast', { key: 'toast.roundStart', icon: 'nap', vars: { minutes: Math.round(preset.duration / 60) } });
  }

  /** Put the room, the score and every timer back to the start of a round. */
  function resetRound() {
    const list = (ctx.props && ctx.props.list) || [];
    for (let i = 0; i < list.length; i++) restoreProp(ctx, list[i]);

    // This must run identically for round one and every round after it — otherwise round one
    // inherits whatever main.js's single boot-time ctx.physics.settle(1.6) happened to leave
    // behind (which is not guaranteed to be fully asleep for every prop, e.g. a precariously
    // stacked book), and any leftover motion gets picked up a few frames later by the topple
    // watcher below as if the player had caused it — that is the root of "score is non-zero
    // before the player has done anything". Unconditionally parking every body at its authored
    // transform and re-settling here is what makes "second round starts exactly like the first"
    // true rather than aspirational.
    if (ctx.physics) {
      try {
        ctx.physics.reset();
        ctx.physics.settle(0.6);
      } catch {
        /* ignore */
      }
    }

    if (ctx.props && ctx.props.reset) ctx.props.reset();

    scoring.reset();
    status.reset();
    credit.clear();
    swung.clear();
    eatenList.length = 0;
    zonesCleared.length = 0;
    variety.length = 0;
    for (const k in ruined) ruined[k] = 0;
    for (const k in pointsBy) pointsBy[k] = 0;
    distance = 0;
    crawlBucket = 0;
    detection = 0;
    noiseHeat = 0;
    threat = 0;
    lastThreatSent = -1;
    duskSent = -1;
    catchTimer = 0;
    elapsed = 0;
    timeLeft = preset.duration;
    _lastBaby.set(0, 0, 0);
    hasLastBaby = false;

    if (ctx.state) {
      ctx.state.timeLeft = timeLeft;
      ctx.state.duration = preset.duration;
      ctx.state.caught = false;
      ctx.state.chaos = 0;
      ctx.state.threat = 0;
      ctx.state.distance = 0;
      ctx.state.eatScale = preset.eat;
      ctx.state.difficulty = preset.id;
    }
    scoring.comboWindow = preset.window;
    scoring.pointsScale = preset.points;
    buildWatch();
    objectives.reset();
    events.emit('game:reset', { difficulty: preset.id, duration: preset.duration });
  }

  function buildStats(reason) {
    const list = (ctx.props && ctx.props.list) || [];
    let total = 0;
    let done = 0;
    for (let i = 0; i < list.length; i++) {
      if (!isScoring(list[i])) continue;
      total++;
      if (list[i].toppled || list[i].eaten) done++;
    }
    const rankKey = rankFor(scoring.score);
    const record = scoring.commitHighScore(rankKey, preset.id);
    return {
      reason,
      score: scoring.score,
      rankKey,
      difficulty: preset.id,
      best: record.best,
      bestRank: record.bestRank,
      isHighScore: record.beaten,
      previousBest: record.previous,
      runs: record.runs,
      timeSurvived: Math.round(elapsed * 10) / 10,
      timeLeft: Math.max(0, Math.round(timeLeft * 10) / 10),
      duration: preset.duration,
      propsRuined: done,
      propsTotal: total,
      completion: total ? done / total : 0,
      byCategory: {
        knockable: ruined.knockable,
        pullable: ruined.pullable,
        edible: ruined.edible,
        hazard: ruined.hazard,
        fragile: ruined.fragile,
      },
      pointsByCategory: { ...pointsBy },
      bestCombo: scoring.bestCombo,
      bestMultiplier: multiplierFor(scoring.bestCombo),
      eaten: eatenList.slice(),
      eatenCount: eatenList.length,
      distance: Math.round(distance * 10) / 10,
      objectives: objectives.snapshot(),
      objectivesDone: objectives.completed.slice(),
      objectiveBonus: objectives.bonusEarned,
      zones: zonesCleared.slice(),
      perfectDisaster: zonesCleared.length > 0,
      discoveries: scoring.discoveries.slice(),
      economyScale: Math.round(scoring.economyScale * 100) / 100,
    };
  }

  function end(reason) {
    if (!running || over) return;
    running = false;
    over = true;

    if (reason === 'timeup') {
      scoring.award({
        amount: preset.survivor, reasonKey: 'toast.survived', combo: false, scaled: false, icon: 'nap', crit: true,
      });
    }

    const stats = buildStats(reason);
    if (ctx.state) {
      ctx.state.mode = 'over';
      ctx.state.caught = reason === 'caught';
      ctx.state.started = false;
      ctx.state.timeLeft = Math.max(0, timeLeft);
    }
    status.reset();
    events.emit('game:over', { reason, score: stats.score, stats });
  }

  // --- per-frame ---------------------------------------------------------------------------------------

  function trackDistance(dt) {
    const b = ctx.baby;
    if (b && b.position) _babyPos.set(b.position.x, 0, b.position.z);
    else if (ctx.camera) _babyPos.set(ctx.camera.position.x, 0, ctx.camera.position.z);
    else return;
    if (hasLastBaby) {
      const d = _lastBaby.distanceTo(_babyPos);
      if (d < 1) { // a teleport (climb, reset) is not crawling
        distance += d;
        crawlBucket += d;
        if (crawlBucket >= 1) {
          objectives.feed('crawl', { metres: crawlBucket });
          crawlBucket = 0;
        }
      }
    }
    _lastBaby.copy(_babyPos);
    hasLastBaby = true;
    if (ctx.state) ctx.state.distance = distance;
  }

  function checkCatch(dt) {
    if (catchTimer > 0) {
      catchTimer -= dt;
      if (catchTimer <= 0) {
        end('caught');
        return;
      }
    }
    const p = ctx.parent;
    if (!p) return;
    const st = p.state || (ctx.state && ctx.state.parentState);
    if (st !== 'catching' && st !== 'spotted') return;
    const src = p.position || (p.group && p.group.position) || null;
    if (!src || !ctx.baby || !ctx.baby.position) return;
    _parentPos.set(src.x, 0, src.z);
    _babyPos.set(ctx.baby.position.x, 0, ctx.baby.position.z);
    if (_parentPos.distanceTo(_babyPos) <= CATCH_RADIUS) end('caught');
  }

  let lastTab = false;

  function update(dt) {
    const mode = ctx.state ? ctx.state.mode : 'boot';
    if (mode === 'photo') return;

    // Tab shows the objective board. It is a hold, not a toggle — you glance at it mid-crawl.
    if (keys.consume('objectives')) {
      events.emit('ui:objectives', { visible: true, list: objectives.snapshot() });
    } else if (!keys.down.objectives && lastTab) {
      events.emit('ui:objectives', { visible: false, list: objectives.snapshot() });
    }
    lastTab = keys.down.objectives;
    keys.clearEdges();

    // 'paused' and 'menu' simply stop the clock — no timer runs outside 'playing'.
    if (mode !== 'playing') return;
    // Whoever put us back into 'playing' after a game over wants another round.
    if (!running) {
      over = false;
      start();
    }

    const step = Math.min(dt, 0.05);
    elapsed += step;
    timeLeft = Math.max(0, preset.duration - elapsed);
    if (ctx.state) {
      ctx.state.timeLeft = timeLeft;
      ctx.state.elapsed = elapsed;
    }

    scoring.tick(step);
    status.update(step);
    tickWatch();
    trackDistance(step);
    objectives.update(step);
    escalate(step);
    checkCatch(step);

    if (timeLeft <= 0) end('timeup');
  }

  // --- wiring ---------------------------------------------------------------------------------------

  const offs = [
    events.on('prop:toppled', onToppled),
    events.on('prop:eaten', onEaten),
    events.on('prop:shattered', onShattered),
    events.on('interact:push', (p) => {
      if (p && p.prop) credit.set(p.prop.id, { method: 'push', t: ctx.elapsed || elapsed });
    }),
    events.on('interact:pull', (p) => {
      if (p && p.prop) credit.set(p.prop.id, { method: 'pull', t: ctx.elapsed || elapsed });
    }),
    events.on('interact:pull:start', (p) => {
      if (p && p.prop) credit.set(p.prop.id, { method: 'pull', t: ctx.elapsed || elapsed });
    }),
    events.on('baby:shove', (p) => {
      if (p && p.prop) credit.set(p.prop.id, { method: 'push', t: ctx.elapsed || elapsed });
    }),
    events.on('noise', (p) => {
      if (!running || !p) return;
      noiseHeat = clamp01(noiseHeat + (p.loudness || 0) * 0.22);
    }),
    events.on('parent:sees', (p) => {
      detection = clamp01((p && p.level) || 0);
      if (ctx.state) ctx.state.detection = detection;
      objectives.feed('detect', { level: detection });
    }),
    events.on('parent:state', (p) => {
      if (!p) return;
      if (ctx.state) ctx.state.parentState = p.to;
      if (p.to === 'catching' && running && catchTimer <= 0) catchTimer = CATCH_TIMEOUT;
      if (p.to !== 'catching' && catchTimer > 0) catchTimer = 0;
    }),
    events.on('parent:caught', () => end('caught')),
    events.on('game:caught', () => end('caught')),
    events.on('combo', (p) => {
      if (p && p.multiplier) objectives.feed('combo', { multiplier: p.multiplier });
    }),
    events.on('game:difficulty', (p) => {
      if (p && p.preset) api.setDifficulty(p.preset);
    }),
    events.on('game:restart', () => {
      over = false;
      resetRound();
    }),
    events.on('ui:objectives:request', () => {
      events.emit('ui:objectives', { visible: true, list: objectives.snapshot() });
    }),
  ];

  const api = {
    update,
    reset() {
      running = false;
      over = false;
      resetRound();
    },
    start() {
      over = false;
      start();
    },
    end,
    setDifficulty(name) {
      const next = DIFFICULTY[name];
      if (!next) return preset.id;
      preset = next;
      scoring.store.set('difficulty', next.id);
      scoring.comboWindow = preset.window;
      scoring.pointsScale = preset.points;
      if (!running) {
        timeLeft = preset.duration;
        if (ctx.state) {
          ctx.state.timeLeft = timeLeft;
          ctx.state.duration = preset.duration;
          ctx.state.difficulty = preset.id;
          ctx.state.eatScale = preset.eat;
        }
      }
      events.emit('game:difficulty:set', { preset: preset.id, duration: preset.duration });
      return preset.id;
    },
    get difficulty() { return preset.id; },
    get running() { return running; },
    get objectives() { return objectives.snapshot(); },
    get status() { return status.list(); },
    /** Live numbers for the HUD; ctx.state carries the same values for pollers. */
    get stats() {
      return {
        score: scoring.score,
        combo: scoring.combo,
        multiplier: scoring.multiplier,
        comboRemaining: scoring.comboRemaining,
        comboWindow: scoring.comboWindow,
        timeLeft,
        elapsed,
        duration: preset.duration,
        detection,
        threat,
        chaos: clamp01(scoring.score / TARGET_PERFECT),
        distance,
        eaten: eatenList.length,
        bestCombo: scoring.bestCombo,
        ruined: { ...ruined },
        zones: zonesCleared.slice(),
        difficulty: preset.id,
        status: status.list(),
        objectives: objectives.snapshot(),
        highScore: scoring.highScore(preset.id),
      };
    },
    dispose() {
      for (let i = 0; i < offs.length; i++) offs[i] && offs[i]();
      keys.dispose();
      status.dispose();
    },
  };

  ctx.track({ dispose: () => api.dispose() });

  if (ctx.state) {
    ctx.state.difficulty = preset.id;
    ctx.state.duration = preset.duration;
    ctx.state.timeLeft = preset.duration;
    ctx.state.eatScale = preset.eat;
    ctx.state.speedMultiplier = 1;
    ctx.state.stealthMultiplier = 1;
  }
  scoring.comboWindow = preset.window;
  scoring.pointsScale = preset.points;

  return api;
}
