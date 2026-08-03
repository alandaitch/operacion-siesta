// GAME · timed status effects — the consequences of putting things in your mouth.
//
// Eating is the risk/reward spine of the round, so every edible has to *do* something to you.
// Four effects, each a plain timer with a start/end event so UI, FX and POSTFX can visualise them
// without knowing the rules:
//
//   waxy    8 s   crayon   — the world goes smeary magenta-violet, like drawing on your own eyes
//   hiccup 18 s   coin     — an involuntary "HIC" every ~3 s that the parent can hear
//   calm   15 s   pacifier — detection fills at 55%; the only defensive item in the game
//   sugar  12 s   snack    — +40% crawl speed and a lens smear at the frame edges
//
// The speed and stealth multipliers are published on ctx.state (speedMultiplier / stealthMultiplier)
// because BABY and AI read state every frame anyway; the events are for everyone else. The screen
// tint is a single DOM layer that only exists while a visual effect is running, so a round with no
// crayon in it costs exactly zero — and UI can claim the job entirely by setting
// ctx.state.claimStatusVisuals = true before the first effect fires.

import { clamp01, damp } from './shared.js';

export const STATUS_DEFS = Object.freeze({
  waxy: {
    id: 'waxy',
    duration: 8,
    toastKey: 'toast.status.waxy',
    labelKey: 'status.waxy',
    icon: 'crayon',
    visual: 'tint',
    colour: '#c8348f',
  },
  hiccup: {
    id: 'hiccup',
    duration: 18,
    toastKey: 'toast.status.hiccup',
    labelKey: 'status.hiccup',
    icon: 'coin',
    visual: null,
    interval: 3.1,
    loudness: 0.62,
  },
  calm: {
    id: 'calm',
    duration: 15,
    toastKey: 'toast.status.calm',
    labelKey: 'status.calm',
    icon: 'pacifier',
    visual: null,
    stealth: 0.55,
  },
  sugar: {
    id: 'sugar',
    duration: 12,
    toastKey: 'toast.status.sugar',
    labelKey: 'status.sugar',
    icon: 'snack',
    visual: 'rush',
    colour: '#ff9a3c',
    speed: 1.4,
  },
});

export function createStatusSystem(ctx) {
  const events = ctx.events;
  const active = new Map(); // id → { def, t, duration, next }
  const lowTier = ctx.quality && ctx.quality.tier === 'low';

  let layer = null;
  let tintT = 0;
  let rushT = 0;
  let pulse = 0;

  // --- the overlay ------------------------------------------------------------------------
  function claimed() {
    return !!(ctx.state && ctx.state.claimStatusVisuals);
  }

  function ensureLayer() {
    if (layer || claimed() || typeof document === 'undefined' || !document.body) return layer;
    layer = document.createElement('div');
    layer.id = 'game-status-layer';
    layer.setAttribute('aria-hidden', 'true');
    const s = layer.style;
    s.position = 'fixed';
    s.inset = '0';
    s.pointerEvents = 'none';
    s.zIndex = '18';
    s.opacity = '0';
    s.mixBlendMode = 'soft-light';
    s.willChange = 'opacity';
    document.body.appendChild(layer);
    return layer;
  }

  function dropLayer() {
    if (!layer) return;
    if (layer.parentNode) layer.parentNode.removeChild(layer);
    layer = null;
  }

  function paintLayer() {
    const a = tintT * 0.62;
    const b = rushT * 0.5;
    if (a <= 0.001 && b <= 0.001) {
      if (layer) {
        layer.style.opacity = '0';
        // Nothing visual is running any more: give the DOM node back.
        dropLayer();
      }
      return;
    }
    if (!ensureLayer()) return;
    // Crayon: a waxy magenta smear, heaviest where a toddler would have scribbled — the middle.
    // Sugar: a warm ring at the edges that breathes with the pulse.
    const wobble = lowTier ? 0 : Math.sin(pulse * 2.4) * 0.06;
    const parts = [];
    if (a > 0.001) {
      parts.push(
        `radial-gradient(120% 90% at 46% 54%, rgba(200,52,143,${(a * (0.55 + wobble)).toFixed(3)}) 0%, ` +
        `rgba(148,64,186,${(a * 0.42).toFixed(3)}) 42%, rgba(90,40,120,${(a * 0.22).toFixed(3)}) 100%)`,
      );
    }
    if (b > 0.001) {
      const k = lowTier ? b : b * (0.82 + Math.sin(pulse * 7.6) * 0.18);
      parts.push(
        `radial-gradient(78% 62% at 50% 50%, rgba(255,180,90,0) 42%, rgba(255,154,60,${(k * 0.85).toFixed(3)}) 100%)`,
      );
    }
    layer.style.background = parts.join(',');
    layer.style.opacity = '1';
  }

  // --- public ------------------------------------------------------------------------------

  function apply(id, source = null) {
    const def = STATUS_DEFS[id];
    if (!def) return null;
    const existing = active.get(id);
    if (existing) {
      // Two crayons do not stack — they refresh, with a little extra for the second helping.
      existing.t = 0;
      existing.duration = Math.min(def.duration * 1.6, existing.duration * 0.4 + def.duration);
      events.emit('status:refresh', { id, duration: existing.duration, source });
      return existing;
    }
    const rec = {
      def,
      id,
      t: 0,
      duration: def.duration,
      next: def.interval ? def.interval * 0.6 : 0,
      source,
    };
    active.set(id, rec);
    events.emit('status:start', {
      id,
      duration: rec.duration,
      labelKey: def.labelKey,
      icon: def.icon,
      colour: def.colour || null,
      source: source ? source.id : null,
    });
    events.emit('ui:toast', { key: def.toastKey, icon: def.icon, vars: {} });
    return rec;
  }

  function clear(id) {
    const rec = active.get(id);
    if (!rec) return;
    active.delete(id);
    events.emit('status:end', { id });
  }

  function babyPosition(out) {
    const b = ctx.baby;
    if (b && b.position) return out.set(b.position.x, b.position.y, b.position.z);
    if (ctx.camera) return out.copy(ctx.camera.position);
    return out.set(0, 0.42, 0);
  }

  const _pos = { x: 0, y: 0, z: 0 };
  const EMPTY = Object.freeze([]);
  let rushWasOn = false;

  function update(dt) {
    const step = dt > 0 ? Math.min(dt, 0.05) : 0;
    pulse += step;

    if (active.size) {
      for (const rec of [...active.values()]) {
        rec.t += step;
        if (rec.def.interval) {
          rec.next -= step;
          if (rec.next <= 0) {
            rec.next = rec.def.interval * (0.82 + ((rec.t * 7.3) % 1) * 0.36);
            hiccup(rec);
          }
        }
        if (rec.t >= rec.duration) clear(rec.id);
      }
    }

    const wantTint = active.has('waxy') ? 1 : 0;
    const wantRush = active.has('sugar') ? 1 : 0;
    tintT = damp(tintT, wantTint, 3.5, step);
    rushT = damp(rushT, wantRush, 3.0, step);
    if (tintT < 0.002) tintT = 0;
    if (rushT < 0.002) rushT = 0;

    if (!claimed()) paintLayer();
    else if (layer) dropLayer();

    // The sugar rush is a genuine speed smear at the frame edges — POSTFX already owns that dial.
    if (ctx.postfx && ctx.postfx.setSprint && (rushT > 0.002 || rushWasOn)) {
      ctx.postfx.setSprint(rushT * 0.75);
      rushWasOn = rushT > 0.002;
    }

    if (ctx.state) {
      ctx.state.speedMultiplier = speedMultiplier();
      ctx.state.stealthMultiplier = stealthMultiplier();
      ctx.state.status = active.size ? [...active.keys()] : EMPTY;
    }
  }

  function hiccup(rec) {
    const b = babyPosition(_pos);
    events.emit('noise', { position: { x: b.x, y: b.y + 0.35, z: b.z }, loudness: rec.def.loudness, source: 'hiccup' });
    events.emit('baby:hiccup', { position: { x: b.x, y: b.y, z: b.z }, loudness: rec.def.loudness });
    events.emit('camera:shake', { amount: 0.16, duration: 0.18 });
    if (ctx.postfx && ctx.postfx.impact) ctx.postfx.impact(0.14);
  }

  function speedMultiplier() {
    let m = 1;
    for (const rec of active.values()) if (rec.def.speed) m *= rec.def.speed;
    return m;
  }

  /** < 1 means the parent's detection meter fills slower. */
  function stealthMultiplier() {
    let m = 1;
    for (const rec of active.values()) if (rec.def.stealth) m *= rec.def.stealth;
    return m;
  }

  function reset() {
    for (const id of [...active.keys()]) clear(id);
    active.clear();
    tintT = 0;
    rushT = 0;
    if (ctx.postfx && ctx.postfx.setSprint && rushWasOn) {
      ctx.postfx.setSprint(0);
      rushWasOn = false;
    }
    dropLayer();
    if (ctx.state) {
      ctx.state.speedMultiplier = 1;
      ctx.state.stealthMultiplier = 1;
      ctx.state.status = EMPTY;
    }
  }

  return {
    apply,
    clear,
    update,
    reset,
    has: (id) => active.has(id),
    get size() { return active.size; },
    speedMultiplier,
    stealthMultiplier,
    /** [{ id, remaining, duration, labelKey, icon }] — the HUD's status tray. */
    list() {
      const out = [];
      for (const rec of active.values()) {
        out.push({
          id: rec.id,
          labelKey: rec.def.labelKey,
          icon: rec.def.icon,
          duration: rec.duration,
          remaining: Math.max(0, rec.duration - rec.t),
          t: clamp01(rec.t / rec.duration),
        });
      }
      return out;
    },
    dispose() {
      reset();
    },
  };
}
