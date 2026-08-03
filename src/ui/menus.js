// UI · title, settings, controls, credits, pause and the end-of-mission results screen.
//
// OWNERSHIP OF THE GAME STATE. main.js parks the game in `mode:'menu'` and calls showMain(); the
// round only begins when this module writes `mode:'playing'`. Everything downstream keys off that
// single field — rules.js stops its clock, interactions.js aborts a half-eaten crayon, physics
// stops stepping — so pausing and resuming needed no new plumbing anywhere else.
//
// ONE FOCUS MODEL FOR THREE INPUTS. Every screen owns a linear ring of `[data-nav]` elements.
// A settings *row* is one focusable control rather than a cluster of buttons: up/down walks the
// list, left/right changes the value. That is how a console settings menu behaves, it makes the
// gamepad and keyboard paths literally the same code, and the mouse still clicks anything
// directly because hover adopts focus.
//
// THE TITLE CAMERA. The game renders live behind the title, so the camera flies a five-pose loop
// through the room — smoothstepped per leg, which gives a slow ease-out into each pose and reads
// as a deliberate attract-mode move rather than a lerp. It is driven from `lateUpdate`, after the
// player's camera rig has written its own transform, and the focus distance is pushed at 4 Hz so
// the depth of field racks with the move. Reduced motion parks it on the hero pose.
//
// AUDIO. The context is not built until a real gesture, so the first click or key on any menu
// calls ctx.audio.unlock() before anything else happens.

import * as THREE from 'three';
import {
  el, clear, setText, setClass, clamp, clamp01, smoothstep, damp,
  createNav, createGamepad, uiScale, prefersReducedMotion,
} from './dom.js';
import { icon } from './icons.js';
import { getSettings, QUALITY_OPTIONS, DIFFICULTIES } from './settings.js';
import './ui.css';

const VIEWS = ['first', 'third'];
const BOOLS = [false, true];

/** Five poses through the room, in the order a cinematographer would shoot them. */
const TITLE_PATH = [
  { pos: [-2.35, 1.32, 2.25], look: [0.70, 0.62, -3.20], fov: 46 },
  { pos: [-0.35, 0.86, 1.35], look: [2.55, 0.55, -1.10], fov: 44 },
  { pos: [1.30, 1.62, -0.45], look: [-2.90, 0.80, -1.30], fov: 48 },
  { pos: [0.45, 0.52, -1.95], look: [1.75, 1.15, -4.45], fov: 50 },
  { pos: [-1.55, 2.05, 2.95], look: [0.35, 0.48, -1.05], fov: 52 },
];
const LEG_TIME = 9.5;

const KEY_ROWS = [
  ['ui.ctrl.move', ['W', 'A', 'S', 'D']],
  // Look has three independent, un-lockable paths (input.js) — a mouse click still engages
  // pointer lock behind the scenes, but nothing here depends on it, which is the point: a
  // trackpad user gets a real answer without ever seeing the word "lock".
  ['ui.ctrl.look', ['CLICK', '+', 'DRAG']],
  ['ui.ctrl.lookSwipe', ['⇆ SWIPE ⇅']],
  ['ui.ctrl.lookArrows', ['←', '→', '↑', '↓']],
  ['ui.ctrl.sprint', ['SHIFT']],
  ['ui.ctrl.push', ['SPACE']],
  ['ui.ctrl.pull', ['E']],
  ['ui.ctrl.eat', ['F']],
  ['ui.ctrl.climb', ['SPACE']],
  ['ui.ctrl.view', ['V']],
  ['ui.ctrl.objectives', ['TAB']],
  ['ui.ctrl.pause', ['ESC']],
  ['ui.ctrl.menuNav', ['↑', '↓']],
  ['ui.ctrl.menuSelect', ['ENTER']],
  ['ui.ctrl.menuBack', ['ESC']],
];

const CATEGORY_ICON = {
  knockable: 'knockable',
  pullable: 'pullable',
  edible: 'edible',
  hazard: 'hazard',
  fragile: 'fragile',
};

export function createMenus(ctx) {
  const events = ctx.events;
  const i18n = ctx.i18n;
  const settings = getSettings(ctx);
  const photo = ctx.state && ctx.state.mode === 'photo';

  const root = document.getElementById('ui-root') || document.body;
  const layer = el('div.ui-layer.menus');
  root.appendChild(layer);

  const pad = createGamepad();
  let reduced = prefersReducedMotion() || !!settings.get('reducedMotion');
  let current = null;          // screen id
  const stack = [];            // for back()
  let roundLive = false;
  let pendingToast = false;
  let unlocked = false;

  // title camera
  let titleActive = false;
  let titleT = 0;
  let focusClock = 0;
  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();
  let savedFov = 0;

  // results
  let lastStats = null;
  let overScoreShown = 0;
  let overScoreTarget = 0;
  let overCountT = 0;

  // live text bindings, so a language change repaints in place with no rebuild
  const texts = [];
  function T(node, key, vars) {
    texts.push({ node, key, vars: vars || null });
    setText(node, i18n.t(key, vars));
    return node;
  }
  function repaintTexts() {
    for (let i = 0; i < texts.length; i++) {
      const b = texts[i];
      setText(b.node, i18n.t(b.key, typeof b.vars === 'function' ? b.vars() : b.vars));
    }
  }

  function tick() {
    events.emit('ui:tick');
  }
  function confirmSound() {
    events.emit('ui:confirm');
  }
  function backSound() {
    events.emit('ui:back');
  }

  function unlockAudio() {
    if (unlocked) return;
    unlocked = true;
    try {
      ctx.audio?.unlock?.();
    } catch {
      /* an audio context that refuses to build must not stop the game */
    }
  }

  // ══ screens ═════════════════════════════════════════════════════════════════════════════

  const screens = {};

  function makeScreen(id, cls) {
    const node = el(`div.screen${cls ? `.${cls}` : ''}`, { 'data-screen': id });
    layer.appendChild(node);
    const nav = createNav(() => [...node.querySelectorAll('[data-nav]')], { onMove: tick });
    screens[id] = { id, node, nav };
    return screens[id];
  }

  /**
   * `transient` buttons live on a screen that is rebuilt from scratch (the results), so they must
   * not register a permanent language binding — otherwise `texts` would grow by two per round.
   */
  function button(labelKey, onClick, cls, subKey, transient) {
    const label = el('span');
    const kids = [label];
    if (subKey) kids.push(T(el('span.btn-sub'), subKey));
    const b = el('button.btn', {
      type: 'button',
      'data-nav': '',
      onclick: (e) => {
        e.preventDefault();
        unlockAudio();
        onClick();
      },
    }, kids);
    if (cls) for (const c of cls.split(/\s+/)) if (c) b.classList.add(c);
    if (transient) setText(label, i18n.t(labelKey));
    else T(label, labelKey);
    return b;
  }

  // --- TITLE -------------------------------------------------------------------------------
  const title = makeScreen('title');
  {
    const list = el('div.menu-list', null, [
      button('ui.menu.start', beginRound),
      button('ui.menu.settings', () => show('settings')),
      button('ui.menu.controls', () => show('controls')),
      button('ui.menu.credits', () => show('credits')),
    ]);
    title.node.append(
      el('div.scrim'),
      el('div.title-wrap', null, [
        T(el('div.title-kicker'), 'game.location'),
        el('div.title-type', null, [
          T(el('span'), 'game.titleTop'),
          T(el('span'), 'game.titleBottom'),
        ]),
        T(el('div.title-tagline'), 'game.tagline'),
        list,
      ]),
      el('div.title-foot', null, [
        T(el('span'), 'ui.ctrl.menuNav'),
        el('span', { text: '·' }),
        T(el('span'), 'ui.ctrl.menuSelect'),
      ]),
    );
  }

  // --- SETTINGS ----------------------------------------------------------------------------
  const settingsScreen = makeScreen('settings');
  const qualityNote = el('div.quality-note');
  {
    const body = el('div.panel-body');
    const panel = el('div.panel', null, [
      el('div.panel-head', null, [
        T(el('div.panel-title'), 'ui.set.title'),
        T(el('div.ui-label'), 'ui.set.saved'),
      ]),
      body,
      el('div.panel-foot', null, [
        button('ui.set.reset', () => {
          settings.resetAll();
          syncSettingsUI();
          confirmSound();
        }, 'btn-solid'),
        button('ui.menu.back', back, 'btn-solid primary'),
      ]),
    ]);
    settingsScreen.node.append(el('div.scrim.solid'), panel);

    // A mouse user never sees this — it only earns its place once input.js has actually latched
    // `state.trackpad` (a fractional or horizontal wheel delta, something a notched wheel cannot
    // produce). update() below toggles it live off the same flag, since it can only ever flip on
    // *during* a round, never while this panel is already open.
    const trackpadRow = sliderRow('ui.set.trackpadSensitivity', null, 'trackpadSensitivity', 0.2, 3, 0.05,
      (v) => `${v.toFixed(2)}×`);
    trackpadRow.style.display = 'none';

    body.append(group('ui.set.group.game', [
      segRow('ui.set.language', null, () => i18n.lang, ['en', 'es'],
        ['ui.set.lang.en', 'ui.set.lang.es'], (v) => settings.setLanguage(v)),
      segRow('ui.menu.difficulty', null, () => settings.get('difficulty'), DIFFICULTIES,
        ['ui.menu.diff.gentle', 'ui.menu.diff.standard', 'ui.menu.diff.feral'],
        (v) => settings.set('difficulty', v), (v) => `ui.menu.diff.${v}.note`),
      segRow('ui.set.view', null, () => settings.get('view'), VIEWS,
        ['ui.set.view.first', 'ui.set.view.third'], (v) => settings.set('view', v)),
      sliderRow('ui.set.sensitivity', null, 'sensitivity', 0.2, 3, 0.05,
        (v) => `${v.toFixed(2)}×`),
      trackpadRow,
      boolRow('ui.set.invertY', null, 'invertY'),
    ]));

    const qualityRow = segRow('ui.set.quality', null, () => settings.get('quality'),
      QUALITY_OPTIONS,
      ['ui.set.quality.auto', 'ui.set.quality.low', 'ui.set.quality.medium',
        'ui.set.quality.high', 'ui.set.quality.ultra'],
      (v) => {
        settings.set('quality', v);
        syncQualityNote();
      });
    body.append(group('ui.set.group.display', [qualityRow, qualityNote]));

    body.append(group('ui.set.group.audio', [
      sliderRow('ui.set.master', null, 'master', 0, 1, 0.01, pct),
      sliderRow('ui.set.music', null, 'music', 0, 1, 0.01, pct),
      sliderRow('ui.set.sfx', null, 'sfx', 0, 1, 0.01, pct),
    ]));

    body.append(group('ui.set.group.access', [
      boolRow('ui.set.reducedMotion', 'ui.set.reducedMotion.note', 'reducedMotion'),
      boolRow('ui.set.subtitles', 'ui.set.subtitles.note', 'subtitles'),
      boolRow('ui.set.photosensitive', 'ui.set.photosensitive.note', 'photosensitive'),
    ]));
  }

  function pct(v) {
    return `${Math.round(v * 100)}%`;
  }

  function group(labelKey, rows) {
    return el('div.group', null, [T(el('div.ui-label'), labelKey), ...rows]);
  }

  /** A row whose value is one of a small set. Left/right cycles; clicking a chip picks it. */
  function segRow(nameKey, noteKey, get, options, optionKeys, set, noteFor) {
    const note = el('div.row-note');
    const seg = el('div.seg');
    const buttons = [];
    for (let i = 0; i < options.length; i++) {
      const b = el('button', {
        type: 'button',
        role: 'radio',
        onclick: (e) => {
          e.stopPropagation();
          unlockAudio();
          set(options[i]);
          sync();
          confirmSound();
        },
      });
      T(b, optionKeys[i]);
      seg.appendChild(b);
      buttons.push(b);
    }
    const nameNode = T(el('div.row-name'), nameKey);
    const left = el('div', null, noteKey || noteFor ? [nameNode, note] : [nameNode]);
    const row = el('div.row', { 'data-nav': '', tabindex: '0', role: 'group' }, [left, seg]);

    function sync() {
      const v = get();
      for (let i = 0; i < buttons.length; i++) {
        buttons[i].setAttribute('aria-checked', options[i] === v ? 'true' : 'false');
      }
      const key = noteFor ? noteFor(v) : noteKey;
      if (key) setText(note, i18n.t(key));
      note.style.display = key ? '' : 'none';
      syncQualityNote();
    }
    row.__sync = sync;
    row.__adjust = (dir) => {
      const v = get();
      const i = options.indexOf(v);
      const next = options[(i + dir + options.length) % options.length];
      set(next);
      sync();
      tick();
    };
    row.addEventListener('click', () => row.__adjust(1));
    sync();
    return row;
  }

  function boolRow(nameKey, noteKey, key) {
    return segRow(nameKey, noteKey, () => !!settings.get(key), BOOLS,
      ['ui.set.off', 'ui.set.on'], (v) => settings.set(key, v));
  }

  function sliderRow(nameKey, noteKey, key, lo, hi, step, format) {
    const val = el('div.slider-val');
    const input = el('input', {
      type: 'range', min: lo, max: hi, step,
      value: settings.get(key),
      tabindex: '-1',
      'aria-label': nameKey,
      oninput: (e) => {
        unlockAudio();
        settings.setNumber(key, parseFloat(e.target.value), lo, hi);
        sync();
      },
      onchange: () => tick(),
    });
    const slider = el('div.slider', null, [input, val]);
    const nameNode = T(el('div.row-name'), nameKey);
    const left = el('div', null, noteKey ? [nameNode, T(el('div.row-note'), noteKey)] : [nameNode]);
    const row = el('div.row', { 'data-nav': '', tabindex: '0', role: 'group' }, [left, slider]);

    function sync() {
      const v = settings.get(key);
      input.value = String(v);
      setText(val, format(v));
      slider.style.setProperty('--fill', `${((v - lo) / (hi - lo)) * 100}%`);
    }
    row.__sync = sync;
    row.__adjust = (dir) => {
      settings.setNumber(key, clamp(settings.get(key) + dir * step * 4, lo, hi), lo, hi);
      sync();
      tick();
    };
    sync();
    return row;
  }

  function syncQualityNote() {
    clear(qualityNote);
    if (!settings.needsRestart) {
      qualityNote.style.display = 'none';
      return;
    }
    qualityNote.style.display = '';
    qualityNote.append(
      el('span', { text: i18n.t('ui.set.quality.note', { tier: i18n.t(`ui.set.quality.${settings.detected}`) }) }),
      el('button.link', {
        type: 'button',
        onclick: () => location.reload(),
        text: i18n.t('ui.set.quality.restart'),
      }),
    );
  }

  function syncSettingsUI() {
    const rows = settingsScreen.node.querySelectorAll('.row');
    for (let i = 0; i < rows.length; i++) rows[i].__sync?.();
    syncQualityNote();
  }

  // --- CONTROLS ----------------------------------------------------------------------------
  const controls = makeScreen('controls');
  {
    const grid = el('div.keys');
    for (const [key, caps] of KEY_ROWS) {
      grid.appendChild(el('div.key-row', null, [
        T(el('span'), key),
        el('div.key-caps', null, caps.map((c) => el('span.keycap', { text: c }))),
      ]));
    }
    controls.node.append(el('div.scrim.solid'), el('div.panel', null, [
      el('div.panel-head', null, [T(el('div.panel-title'), 'ui.ctrl.title')]),
      el('div.panel-body', null, [
        grid,
        T(el('div.row-note', { style: { marginTop: 'calc(var(--u) * 18)' } }), 'ui.ctrl.gamepad'),
      ]),
      el('div.panel-foot', null, [button('ui.menu.back', back, 'btn-solid primary')]),
    ]));
  }

  // --- CREDITS -----------------------------------------------------------------------------
  const credits = makeScreen('credits');
  {
    const lines = [
      ['ui.credits.room', 'ui.credits.roomBody'],
      ['ui.credits.tech', 'ui.credits.techBody'],
      ['ui.credits.thanks', 'ui.credits.thanksBody'],
    ].map(([h, b]) => el('div.credit-line', null, [T(el('b'), h), T(el('p'), b)]));
    credits.node.append(el('div.scrim.solid'), el('div.panel', null, [
      el('div.panel-head', null, [T(el('div.panel-title'), 'ui.credits.title')]),
      el('div.panel-body', null, [T(el('div.prose'), 'ui.credits.body'), ...lines]),
      el('div.panel-foot', null, [button('ui.menu.back', back, 'btn-solid primary')]),
    ]));
  }

  // --- PAUSE -------------------------------------------------------------------------------
  const pause = makeScreen('pause');
  const pauseObjs = el('div');
  {
    const keyGrid = el('div.keys');
    for (const [key, caps] of KEY_ROWS.slice(0, 8)) {
      keyGrid.appendChild(el('div.key-row', null, [
        T(el('span'), key),
        el('div.key-caps', null, caps.map((c) => el('span.keycap', { text: c }))),
      ]));
    }
    pause.node.append(el('div.scrim.blur'), el('div.panel', null, [
      el('div.panel-head', null, [
        T(el('div.panel-title'), 'ui.menu.paused'),
        T(el('div.ui-label'), 'ui.menu.pausedSub'),
      ]),
      el('div.panel-body', null, [
        el('div.group', null, [T(el('div.ui-label'), 'ui.menu.objectives'), pauseObjs]),
        el('div.group', null, [T(el('div.ui-label'), 'ui.ctrl.title'), keyGrid]),
      ]),
      el('div.panel-foot', null, [
        button('ui.menu.quit', quitToTitle, 'btn-solid'),
        button('ui.menu.restart', restartRound, 'btn-solid'),
        button('ui.menu.settings', () => show('settings'), 'btn-solid'),
        button('ui.menu.resume', resume, 'btn-solid primary'),
      ]),
    ]));
  }

  let objData = [];
  function paintPauseObjectives() {
    clear(pauseObjs);
    if (!objData.length) {
      pauseObjs.appendChild(el('div.empty', { text: i18n.t('ui.menu.noObjectives') }));
      return;
    }
    for (const o of objData) {
      const target = o.unit === 'm' ? Math.round(o.target) : o.target;
      pauseObjs.appendChild(el(`div.obj${o.done ? '.done' : ''}`, null, [
        el('div.obj-top', null, [
          el('div.obj-text', { text: i18n.t(o.key, { target }) }),
          el('div.obj-bonus', { text: `+${i18n.number(o.bonus || 0)}` }),
        ]),
        el('div.obj-bar', null, [
          el('i', { style: { transform: `scaleX(${(o.fraction || 0).toFixed(3)})` } }),
        ]),
      ]));
    }
  }

  // --- GAME OVER ---------------------------------------------------------------------------
  const over = makeScreen('over');
  const overBody = el('div.over-card');
  over.node.append(el('div.scrim.solid'), el('div.over', null, [overBody]));
  const overRoot = over.node.querySelector('.over');

  function statRow(iconName, labelKey, count, points, delay) {
    const kids = [
      icon(iconName, 'stat-ico'),
      el('div.stat-name', { text: i18n.t(labelKey) }),
      el('div.stat-count', { text: i18n.number(count) }),
    ];
    kids.push(el('div.stat-pts', { text: points > 0 ? `+${i18n.number(points)}` : '—' }));
    return el('div.stat-row', { style: { animationDelay: `${delay}ms` } }, kids);
  }

  function meter(labelKey, valueText, fraction) {
    const fill = el('i');
    const node = el('div.meter', null, [
      el('div.meter-top', null, [
        el('div.ui-label', { text: i18n.t(labelKey) }),
        el('div.meter-val', { text: valueText }),
      ]),
      el('div.meter-track', null, [fill]),
    ]);
    // one frame later so the transition actually runs
    requestAnimationFrame(() => {
      fill.style.transform = `scaleX(${clamp01(fraction).toFixed(3)})`;
    });
    return node;
  }

  function tagList(items, cls) {
    if (!items.length) return null;
    return el('div.tag-list', null, items.map((it) => el(`div.tag${cls ? `.${cls}` : ''}${it.reaction ? `.${it.reaction}` : ''}`, null, [
      el('i'),
      el('span', { text: i18n.t(it.labelKey || it.key) }),
    ])));
  }

  /** `fresh` is false when we are only repainting after a language change: the score has already
   *  counted up and restarting it would look like a glitch. */
  function buildOver(fresh = true) {
    clear(overBody);
    const s = lastStats;
    if (!s) return;
    setClass(overRoot, 'caught', s.reason === 'caught');

    overScoreTarget = s.score || 0;
    if (fresh) {
      overScoreShown = 0;
      overCountT = 0;
    }
    const scoreNode = el('div.over-score.ui-num', { text: i18n.number(fresh ? 0 : overScoreShown) });
    overScoreNode = scoreNode;

    const head = el('div.over-head', null, [
      el('div', null, [
        el('div.over-verdict', { text: i18n.t(`end.title.${s.reason === 'caught' ? 'caught' : 'timeup'}`) }),
        el('div.over-sub', { text: i18n.t(`end.sub.${s.reason === 'caught' ? 'caught' : 'timeup'}`) }),
      ]),
      el('div.over-scoreblock', null, [
        el('div.ui-label', { text: i18n.t('end.score') }),
        scoreNode,
        el('div.over-rank', { text: i18n.t(s.rankKey || 'end.rank.crawler') }),
        s.isHighScore ? el('div.over-record', { text: i18n.t('end.newHighScore') }) : null,
      ]),
    ]);

    // ---- left column: the breakdown
    const rows = el('div.stat-rows');
    const cats = ['knockable', 'pullable', 'edible', 'hazard', 'fragile'];
    let delay = 120;
    for (const c of cats) {
      const n = (s.byCategory && s.byCategory[c]) || 0;
      if (!n) continue;
      rows.appendChild(statRow(
        CATEGORY_ICON[c], `end.cat.${c}`, n,
        (s.pointsByCategory && s.pointsByCategory[c]) || 0, delay,
      ));
      delay += 90;
    }
    if (!rows.childElementCount) {
      rows.appendChild(el('div.empty', { text: i18n.t('end.eatenNone') }));
    }
    rows.appendChild(statRow('combo', 'end.bestCombo', s.bestCombo || 0, 0, delay));
    delay += 90;
    if (s.objectiveBonus > 0) {
      rows.appendChild(statRow('objective', 'end.objectiveBonus',
        (s.objectivesDone || []).length, s.objectiveBonus, delay));
      delay += 90;
    }
    if ((s.zones || []).length) {
      rows.appendChild(statRow('zone', 'end.zones', s.zones.length, 0, delay));
    }

    const left = el('div.over-col', null, [
      el('div', null, [el('div.ui-label', { text: i18n.t('end.breakdown') }), rows]),
      meter('end.completion',
        i18n.t('end.props', { done: s.propsRuined || 0, total: s.propsTotal || 0 }),
        s.completion || 0),
    ]);

    // ---- right column: the trophies
    const eaten = tagList(s.eaten || []);
    const disc = tagList((s.discoveries || []).map((d) => ({ labelKey: d.labelKey })), 'new');
    const objDone = tagList((s.objectivesDone || []).map((o) => ({ labelKey: o.key })));

    const right = el('div.over-col', null, [
      el('div', null, [
        el('div.ui-label', { text: i18n.t('end.eaten') }),
        eaten || el('div.empty', { text: i18n.t('end.eatenNone') }),
      ]),
      el('div', null, [
        el('div.ui-label', { text: i18n.t('end.discoveries') }),
        disc || el('div.empty', { text: i18n.t('end.discoveriesNone') }),
      ]),
      objDone ? el('div', null, [
        el('div.ui-label', { text: i18n.t('end.objectives') }),
        objDone,
      ]) : null,
      el('div.stat-rows', null, [
        statRow('clock', 'end.time', 0, 0, 0),
        statRow('distance', 'end.distance', 0, 0, 60),
        statRow('trophy', 'end.highScore', 0, 0, 120),
      ]),
    ]);
    // The three summary rows want text, not counts — patch them after construction so statRow
    // stays a single shape.
    const summary = right.querySelectorAll('.stat-rows .stat-row');
    setText(summary[0].querySelector('.stat-count'), i18n.time(s.timeSurvived || 0));
    setText(summary[0].querySelector('.stat-pts'), '');
    setText(summary[1].querySelector('.stat-count'), i18n.metres(s.distance || 0));
    setText(summary[1].querySelector('.stat-pts'), '');
    setText(summary[2].querySelector('.stat-count'), i18n.number(s.best || 0));
    setText(summary[2].querySelector('.stat-pts'),
      s.isHighScore && s.previousBest > 0 ? i18n.t('end.previousBest', { n: s.previousBest }) : '');

    const foot = el('div.over-foot', null, [
      el('div.spacer', { text: i18n.t('end.runs', { n: s.runs || 1 }) }),
      button('end.menu', quitToTitle, 'btn-solid', null, true),
      button('end.retry', retry, 'btn-solid primary', null, true),
    ]);

    overBody.append(head, el('div.over-grid', null, [left, right]), foot);
  }

  let overScoreNode = null;

  // ══ navigation ══════════════════════════════════════════════════════════════════════════

  function show(id, { push = true } = {}) {
    if (current === id) return;
    if (current) {
      if (push && id !== 'title') stack.push(current);
      screens[current].node.classList.remove('on', 'fade');
      screens[current].nav.active = false;
    }
    current = id;
    const s = screens[id];
    s.node.classList.add('on', 'fade');
    s.nav.refresh();
    s.nav.active = true;
    // The results screen opens on RETRY, the panels open on their first item.
    if (id === 'over') s.nav.focus(-1, { scroll: false });
    else if (s.nav.index < 0) s.nav.focus(0, { scroll: false });
    layer.style.pointerEvents = 'auto';
    if (id === 'settings') syncSettingsUI();
    if (id === 'pause') paintPauseObjectives();
  }

  function hideAll() {
    if (current) {
      screens[current].node.classList.remove('on', 'fade');
      screens[current].nav.active = false;
    }
    current = null;
    stack.length = 0;
    layer.style.pointerEvents = 'none';
  }

  function back() {
    backSound();
    const prev = stack.pop();
    if (prev) {
      const from = current;
      current = null;
      screens[from].node.classList.remove('on', 'fade');
      screens[from].nav.active = false;
      show(prev, { push: false });
      return;
    }
    if (ctx.state.mode === 'paused') resume();
    else showMain();
  }

  // ══ transitions ═════════════════════════════════════════════════════════════════════════

  function showMain() {
    if (photo) return;
    hideAll();
    titleActive = true;
    titleT = reduced ? LEG_TIME * 4.35 : 0;
    if (!savedFov && ctx.camera) savedFov = ctx.engine?.baseFov || ctx.camera.fov;
    if (ctx.state) ctx.state.mode = 'menu';
    show('title', { push: false });
  }

  function restoreCamera() {
    titleActive = false;
    if (ctx.engine && savedFov) ctx.engine.setFov(savedFov);
    ctx.postfx?.setAutoFocus?.(true);
  }

  function beginRound() {
    unlockAudio();
    confirmSound();
    if (pendingToast) {
      pendingToast = false;
      events.emit('ui:toast', {
        key: 'toast.roundStart',
        icon: 'nap',
        vars: { minutes: Math.round(((ctx.state && ctx.state.duration) || 180) / 60) },
      });
    }
    hideAll();
    restoreCamera();
    ctx.state.mode = 'playing';
    events.emit('ui:play', { from: 'menu' });
  }

  function pauseGame() {
    if (ctx.state.mode !== 'playing') return;
    ctx.state.mode = 'paused';
    try {
      if (document.pointerLockElement) document.exitPointerLock();
    } catch {
      /* not locked */
    }
    events.emit('input:release', { reason: 'pause' });
    backSound();
    show('pause', { push: false });
  }

  function resume() {
    hideAll();
    ctx.state.mode = 'playing';
    confirmSound();
    events.emit('input:capture', { reason: 'resume' });
  }

  function restartRound() {
    hideAll();
    events.emit('game:restart');
    events.emit('ui:toast', {
      key: 'toast.roundStart',
      icon: 'nap',
      vars: { minutes: Math.round(((ctx.state && ctx.state.duration) || 180) / 60) },
    });
    ctx.state.mode = 'playing';
    confirmSound();
  }

  function retry() {
    hideAll();
    ctx.state.mode = 'playing';
    confirmSound();
  }

  function quitToTitle() {
    if (roundLive) {
      events.emit('game:restart');
      pendingToast = true;
    }
    ctx.state.mode = 'menu';
    backSound();
    showMain();
  }

  // ══ input ═══════════════════════════════════════════════════════════════════════════════

  const NAV_UP = { ArrowUp: 1, KeyW: 1 };
  const NAV_DOWN = { ArrowDown: 1, KeyS: 1 };
  const NAV_LEFT = { ArrowLeft: 1, KeyA: 1 };
  const NAV_RIGHT = { ArrowRight: 1, KeyD: 1 };

  function onKey(e) {
    if (photo) return;
    unlockAudio();
    const mode = ctx.state ? ctx.state.mode : 'boot';
    const open = !!current;

    if (e.code === 'Escape') {
      e.preventDefault();
      if (current === 'title') return;   // nowhere further back to go
      if (open) back();
      else if (mode === 'playing') pauseGame();
      return;
    }
    if (e.code === 'KeyP' && !open && mode === 'playing') {
      e.preventDefault();
      pauseGame();
      return;
    }
    if (!open) return;

    const nav = screens[current].nav;
    // A range input steals the arrow keys the moment it is clicked; hand focus back to its row so
    // the ring, the gamepad and the keyboard never disagree about what is selected.
    const ae = document.activeElement;
    if (ae && ae.tagName === 'INPUT') ae.blur();
    const focused = nav.current;
    if (NAV_UP[e.code]) {
      e.preventDefault();
      nav.move(-1);
    } else if (NAV_DOWN[e.code]) {
      e.preventDefault();
      nav.move(1);
    } else if (NAV_LEFT[e.code] || NAV_RIGHT[e.code]) {
      if (focused && focused.__adjust) {
        e.preventDefault();
        focused.__adjust(NAV_RIGHT[e.code] ? 1 : -1);
      }
    } else if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') {
      e.preventDefault();
      nav.activate();
    }
  }

  function onPointerDown() {
    unlockAudio();
  }

  window.addEventListener('keydown', onKey, { passive: false });
  window.addEventListener('pointerdown', onPointerDown, { passive: true });

  function pollPad(dt) {
    const mode = ctx.state ? ctx.state.mode : 'boot';
    if (!current && mode !== 'playing') return;
    const p = pad.poll(dt);
    if (!p.up && !p.down && !p.left && !p.right && !p.confirm && !p.back && !p.start) return;
    unlockAudio();
    if (!current) {
      if (p.start) pauseGame();
      return;
    }
    const nav = screens[current].nav;
    if (p.up) nav.move(-1);
    if (p.down) nav.move(1);
    const focused = nav.current;
    if ((p.left || p.right) && focused && focused.__adjust) focused.__adjust(p.right ? 1 : -1);
    if (p.confirm) nav.activate();
    if (p.back || p.start) back();
  }

  // ══ the title camera ════════════════════════════════════════════════════════════════════

  function driveTitleCamera(dt) {
    const cam = ctx.camera;
    if (!cam) return;
    if (!reduced) titleT += dt;

    const legs = TITLE_PATH.length;
    const total = titleT / LEG_TIME;
    const i = Math.floor(total) % legs;
    const j = (i + 1) % legs;
    const k = smoothstep(total - Math.floor(total));

    const A = TITLE_PATH[i];
    const B = TITLE_PATH[j];
    _a.set(A.pos[0], A.pos[1], A.pos[2]);
    _b.set(B.pos[0], B.pos[1], B.pos[2]);
    camPos.lerpVectors(_a, _b, k);
    _a.set(A.look[0], A.look[1], A.look[2]);
    _b.set(B.look[0], B.look[1], B.look[2]);
    camLook.lerpVectors(_a, _b, k);

    if (!reduced) {
      // handheld: two incommensurate sines per axis so it never visibly repeats
      const t = titleT;
      camPos.x += Math.sin(t * 0.41) * 0.017 + Math.sin(t * 0.97) * 0.006;
      camPos.y += Math.sin(t * 0.33 + 1.7) * 0.012 + Math.sin(t * 1.13) * 0.004;
      camPos.z += Math.sin(t * 0.27 + 0.6) * 0.015;
    }

    cam.position.copy(camPos);
    cam.lookAt(camLook);
    const fov = A.fov + (B.fov - A.fov) * k;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }

    focusClock -= dt;
    if (focusClock <= 0) {
      focusClock = 0.25;
      ctx.postfx?.setFocusDistance?.(camPos.distanceTo(camLook));
    }
  }

  // ══ lifecycle ═══════════════════════════════════════════════════════════════════════════

  function update(dt) {
    if (photo) return;
    const step = Math.min(dt || 0, 0.05);
    pollPad(step);

    if (current === 'settings') {
      const wantTrackpadRow = !!(ctx.input && ctx.input.state && ctx.input.state.trackpad);
      const shown = trackpadRow.style.display !== 'none';
      if (wantTrackpadRow !== shown) {
        trackpadRow.style.display = wantTrackpadRow ? '' : 'none';
        screens.settings.nav.refresh();
      }
    }

    if (overScoreNode) {
      overCountT += step;
      if (reduced || overCountT > 1.5) overScoreShown = overScoreTarget;
      else overScoreShown = damp(overScoreShown, overScoreTarget, 3.4, step);
      const v = Math.abs(overScoreTarget - overScoreShown) < 2 ? overScoreTarget : overScoreShown;
      setText(overScoreNode, i18n.number(v));
      if (v === overScoreTarget && overCountT > 1.6) overScoreNode = null;
    }
  }

  /** After the player's camera rig has had its say — the title move must win. */
  function lateUpdate(dt) {
    if (photo || !titleActive) return;
    if (!ctx.state || (ctx.state.mode !== 'menu' && ctx.state.mode !== 'boot')) return;
    driveTitleCamera(Math.min(dt || 0, 0.05));
  }

  function resize(w, h) {
    root.style.setProperty('--u', `${uiScale(w || window.innerWidth, h || window.innerHeight).toFixed(4)}px`);
    if (current) screens[current].nav.refresh();
  }

  // ══ wiring ══════════════════════════════════════════════════════════════════════════════

  const offs = [
    events.on('game:start', () => {
      roundLive = true;
    }),
    events.on('game:over', (p) => {
      if (photo) return;
      roundLive = false;
      lastStats = (p && p.stats) || null;
      if (!lastStats) return;
      buildOver();
      show('over', { push: false });
    }),
    events.on('game:objectives', (p) => {
      objData = (p && p.list) || [];
      if (current === 'pause') paintPauseObjectives();
    }),
    events.on('ui:lang', () => {
      repaintTexts();
      syncSettingsUI();
      if (current === 'pause') paintPauseObjectives();
      if (current === 'over') buildOver(false);
    }),
    events.on('ui:motion', (p) => {
      reduced = prefersReducedMotion() || !!(p && p.reduced);
    }),
    events.on('game:pause', pauseGame),
    events.on('game:resume', resume),
  ];

  // Hover adopts focus, so the designed ring and the pointer never disagree about what is
  // selected. `pointerenter` does not bubble, but it is still delivered to ancestors during the
  // capture phase — one listener therefore covers every screen, including ones rebuilt later.
  layer.addEventListener('pointerenter', (e) => {
    const t = e.target;
    if (!current || !t || typeof t.closest !== 'function') return;
    const item = t.closest('[data-nav]');
    if (!item) return;
    const nav = screens[current].nav;
    nav.refresh();
    const items = [...screens[current].node.querySelectorAll('[data-nav]')];
    const i = items.indexOf(item);
    if (i >= 0 && i !== nav.index) nav.focus(i, { scroll: false });
  }, true);

  resize(window.innerWidth, window.innerHeight);
  syncQualityNote();

  const api = {
    showMain,
    show,
    update,
    lateUpdate,
    resize,
    pause: pauseGame,
    resume,
    setVisible(v) {
      layer.style.display = v === false ? 'none' : '';
      if (v === false) hideAll();
    },
    get open() {
      return current;
    },
    dispose() {
      for (let i = 0; i < offs.length; i++) offs[i]();
      offs.length = 0;
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown);
      layer.remove();
    },
  };

  ctx.track(api);
  return api;
}
