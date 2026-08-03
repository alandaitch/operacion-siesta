// UI · the settings model: one object, persisted, applied live to whoever owns each dial.
//
// The HUD is constructed before the menus, so whichever asks first creates the singleton and the
// persisted values are applied during boot — that is why the player's volume and language are
// already right on the very first frame rather than after they open Settings.
//
// TWO STORAGE FORMATS, ON PURPOSE. `on.lang` and `on.quality` are read by main.js with a bare
// `localStorage.getItem`, so they are written as raw unquoted strings; everything else lives in a
// JSON blob under `on.ui`. Writing "es" as '"es"' would silently drop the player back to English
// on the next reload, which is exactly the sort of bug that survives three review rounds.
//
// LIVE QUALITY. Only the dials that can honestly change mid-frame are applied without a restart:
// pixel ratio, shadow filtering, anisotropy, particle budget. Render targets, texture sizes and
// the post-processing chain were sized at construction, so the panel says so and offers a restart
// instead of pretending.

import { TIERS, detectTier } from '../core/quality.js';
import { createStore, clamp } from './dom.js';

export const QUALITY_OPTIONS = ['auto', 'low', 'medium', 'high', 'ultra'];
export const DIFFICULTIES = ['gentle', 'standard', 'feral'];

const DEFAULTS = {
  view: 'first',
  quality: 'auto',
  master: 0.85,
  music: 0.7,
  sfx: 1.0,
  sensitivity: 1.0,
  trackpadSensitivity: 1.0,
  invertY: false,
  reducedMotion: false,
  subtitles: false,
  photosensitive: false,
  difficulty: 'standard',
};

/** Fields that can be pushed into ctx.quality without rebuilding anything. */
const LIVE_QUALITY_FIELDS = [
  'tier',
  'pixelRatio',
  'softShadows',
  'anisotropy',
  'particleBudget',
  'shadowDistance',
  'contactShadows',
];

export function getSettings(ctx) {
  if (ctx.__uiSettings) return ctx.__uiSettings;
  const s = createSettings(ctx);
  ctx.__uiSettings = s;
  return s;
}

function createSettings(ctx) {
  const store = createStore('on.');
  const root = document.getElementById('ui-root');
  const bootTier = (ctx.quality && ctx.quality.tier) || 'high';
  const detected = detectTier();

  const values = { ...DEFAULTS, ...(store.get('ui', {}) || {}) };
  values.quality = store.getRaw('quality', '') || 'auto';
  if (QUALITY_OPTIONS.indexOf(values.quality) < 0) values.quality = 'auto';
  values.difficulty = store.get('difficulty', DEFAULTS.difficulty) || DEFAULTS.difficulty;
  if (DIFFICULTIES.indexOf(values.difficulty) < 0) values.difficulty = 'standard';
  values.view = values.view === 'third' ? 'third' : 'first';

  const listeners = new Set();

  function persist() {
    const blob = {};
    for (const k in DEFAULTS) if (k !== 'quality' && k !== 'difficulty') blob[k] = values[k];
    store.set('ui', blob);
  }

  // --- appliers ---------------------------------------------------------------------------

  function applyMotion() {
    if (root) root.classList.toggle('calm', !!values.reducedMotion);
    if (ctx.state) ctx.state.reducedMotion = !!values.reducedMotion;
    ctx.events.emit('ui:motion', { reduced: !!values.reducedMotion });
  }

  function applyFlash() {
    if (root) root.style.setProperty('--flash', values.photosensitive ? '0.35' : '1');
    if (ctx.state) ctx.state.photosensitive = !!values.photosensitive;
    ctx.events.emit('ui:photosensitive', { on: !!values.photosensitive });
  }

  function applySubtitles() {
    if (ctx.state) ctx.state.subtitles = !!values.subtitles;
    ctx.events.emit('ui:subtitles', { on: !!values.subtitles });
  }

  function applyAudio() {
    const a = ctx.audio;
    if (a) {
      a.setMasterVolume?.(values.master);
      a.setBusVolume?.('music', values.music);
      a.setBusVolume?.('sfx', values.sfx);
      a.setBusVolume?.('ambience', values.sfx * 0.8);
      a.setBusVolume?.('ui', values.sfx * 0.7);
    }
    ctx.events.emit('audio:settings', {
      master: values.master,
      music: values.music,
      sfx: values.sfx,
      ambience: values.sfx * 0.8,
      ui: values.sfx * 0.7,
    });
  }

  function applyInput() {
    if (ctx.state) {
      ctx.state.mouseSensitivity = values.sensitivity;
      ctx.state.sensitivity = values.sensitivity;
      ctx.state.invertY = !!values.invertY;
    }
    ctx.events.emit('input:settings', {
      sensitivity: values.sensitivity,
      trackpadSensitivity: values.trackpadSensitivity,
      invertY: !!values.invertY,
    });
  }

  function applyView() {
    if (ctx.state) ctx.state.view = values.view;
    ctx.events.emit('ui:view', { view: values.view });
    ctx.events.emit('view:change', { view: values.view });
  }

  function applyDifficulty() {
    store.set('difficulty', values.difficulty);
    if (ctx.state) ctx.state.difficulty = values.difficulty;
    ctx.events.emit('game:difficulty', { preset: values.difficulty });
  }

  function effectiveTier() {
    return values.quality === 'auto' ? detected : values.quality;
  }

  function applyQuality() {
    // Persisted raw, because main.js reads this key with a bare getItem on the next boot.
    store.setRaw('quality', values.quality === 'auto' ? '' : values.quality);
    const tier = effectiveTier();
    const preset = TIERS[tier];
    if (!preset || !ctx.quality) return;

    const dpr = window.devicePixelRatio || 1;
    for (const f of LIVE_QUALITY_FIELDS) {
      ctx.quality[f] = f === 'pixelRatio' ? Math.min(preset.pixelRatio, dpr) : preset[f];
    }
    const r = ctx.renderer;
    if (r && r.shadowMap) {
      const want = preset.softShadows ? 2 /* PCFSoftShadowMap */ : 1 /* PCFShadowMap */;
      if (r.shadowMap.type !== want) {
        r.shadowMap.type = want;
        r.shadowMap.needsUpdate = true;
      }
    }
    ctx.engine?.resize?.(window.innerWidth, window.innerHeight);
    ctx.postfx?.resize?.();
    ctx.engine?.shadowNeedsUpdate?.();
    ctx.events.emit('quality:changed', { tier, live: true });
  }

  function notify(key) {
    for (const fn of [...listeners]) {
      try {
        fn(key, values[key], values);
      } catch (err) {
        console.error('[settings] listener threw', err);
      }
    }
  }

  // --- api --------------------------------------------------------------------------------

  const api = {
    values,
    get detected() {
      return detected;
    },
    get bootTier() {
      return bootTier;
    },
    get effectiveTier() {
      return effectiveTier();
    },
    /** True when the chosen tier cannot be fully realised without a reload. */
    get needsRestart() {
      return effectiveTier() !== bootTier;
    },
    get(key) {
      return values[key];
    },
    set(key, value) {
      if (!(key in values) && key !== 'lang') return;
      if (key === 'lang') {
        api.setLanguage(value);
        return;
      }
      if (values[key] === value) return;
      values[key] = value;
      persist();
      switch (key) {
        case 'view':
          applyView();
          break;
        case 'quality':
          applyQuality();
          break;
        case 'master':
        case 'music':
        case 'sfx':
          applyAudio();
          break;
        case 'sensitivity':
        case 'trackpadSensitivity':
        case 'invertY':
          applyInput();
          break;
        case 'reducedMotion':
          applyMotion();
          break;
        case 'subtitles':
          applySubtitles();
          break;
        case 'photosensitive':
          applyFlash();
          break;
        case 'difficulty':
          applyDifficulty();
          break;
        default:
          break;
      }
      notify(key);
    },
    setNumber(key, value, lo = 0, hi = 1) {
      api.set(key, clamp(Number(value) || 0, lo, hi));
    },
    setLanguage(lang) {
      const i18n = ctx.i18n;
      if (!i18n || lang === i18n.lang) return;
      store.setRaw('lang', lang);
      i18n.setLang(lang);
      ctx.events.emit('ui:lang', { lang });
      notify('lang');
    },
    get lang() {
      return ctx.i18n ? ctx.i18n.lang : 'en';
    },
    resetAll() {
      Object.assign(values, DEFAULTS);
      persist();
      applyView();
      applyQuality();
      applyAudio();
      applyInput();
      applyMotion();
      applySubtitles();
      applyFlash();
      applyDifficulty();
      notify('*');
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Re-push everything at whoever might have booted after us. */
    applyAll() {
      applyView();
      applyAudio();
      applyInput();
      applyMotion();
      applySubtitles();
      applyFlash();
    },
  };

  // Apply the persisted state immediately, minus quality (main.js already booted with it) and
  // difficulty (rules reads the same store key at construction and would double-fire).
  api.applyAll();
  if (ctx.state) ctx.state.difficulty = values.difficulty;

  return api;
}
