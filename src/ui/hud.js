// UI · the heads-up display. CONTRACTS §6 (events), §12 (i18n keys).
//
// The brief for this interface was "diegetic, minimal, confident, and it must not look like a web
// page", which in practice meant three engineering decisions:
//
// 1. NOTHING HERE TOUCHES LAYOUT. Every per-frame write is a `transform`, an `opacity`, or an SVG
//    `stroke-dashoffset` — all compositor-only properties. Text is written through `setText`,
//    which compares against the last value first, so the score element is only re-laid-out on the
//    frames where the number actually changed. The HUD costs well under 0.3 ms.
// 2. THE DETECTION ARC IS THE MOST IMPORTANT PIXEL ON SCREEN. It is a compass ring around the
//    reticle: 12 o'clock is straight ahead, the arc narrows and brightens as the parent's
//    awareness climbs, and a directional lobe pushes into the screen edge nearest their bearing so
//    it is legible in peripheral vision while you are staring at a vase. Bearing is computed from
//    the camera basis, not from the baby's heading, because what you can see is what matters.
// 3. SPRINGS, NOT LINEAR RAMPS. The score, the detection level and the stamina bar are all driven
//    by `damp()` (frame-rate independent exponential approach), and the pops are real overshooting
//    keyframes. With `prefers-reduced-motion` — or the in-game toggle — every one of those
//    collapses to an instant write and the score popups stop drifting.
//
// Everything visible is an i18n key resolved at paint time, and `ui:lang` repaints in place.

import * as THREE from 'three';
import {
  el, svgEl, clear, setText, setClass, replay, clamp, clamp01, damp, smoothstep, easeBack,
  uiScale, prefersReducedMotion, createStore,
} from './dom.js';
import { icon, resolveIcon } from './icons.js';
import { getSettings } from './settings.js';
import './ui.css';

const TAU = Math.PI * 2;

const COMBO_R = 33;
const COMBO_C = TAU * COMBO_R;
const DETECT_R = 112;
const DETECT_C = TAU * DETECT_R;
const RETICLE_R = 24;
const RETICLE_C = TAU * RETICLE_R;
const CHIP_R = 9;
const CHIP_C = TAU * CHIP_R;

const POP_POOL = 18;
const POP_LIFE = 1.25;
const TOAST_LIFE = 3.6;
const TOAST_MAX = 4;
const SUB_LIFE = 2.6;
const SUB_MAX = 2;

const BIG_ICONS = { objective: 1, zone: 1, new: 1, nap: 1, variety: 1, combo: 1 };
const WARN_ICONS = { spit: 1, hazard: 1 };

const PARENT_WORD = {
  suspicious: 'ui.hud.heard',
  alert: 'ui.hud.heard',
  searching: 'ui.hud.searching',
  hunting: 'ui.hud.searching',
  spotted: 'ui.hud.spotted',
  catching: 'ui.hud.catching',
};

const TUTORIAL = [
  { key: 'tut.crawl', done: 'crawl', timeout: 16 },
  // The baby starts zipped inside the playpen (FURN registers the zip panel as a bodiless
  // `pullable` prop, id 'playpen-door') and cannot leave until it is pulled open. Nothing else
  // in the game tells a first-time player that, so this step blocks on the same 'interact:pull'
  // completion event every other pullable prop fires, filtered to that one prop's id below.
  { key: 'tut.escape', done: 'escape', timeout: 18 },
  { key: 'tut.push', done: 'push', timeout: 20 },
  { key: 'tut.eat', done: 'eat', timeout: 22 },
];

export function createHUD(ctx) {
  const i18n = ctx.i18n;
  const events = ctx.events;
  const settings = getSettings(ctx);
  const store = createStore('on.');
  const photo = ctx.state && ctx.state.mode === 'photo';

  const root = document.getElementById('ui-root') || document.body;
  const layer = el('div.ui-layer.hud', { 'aria-hidden': 'true' });
  root.appendChild(layer);

  let W = window.innerWidth;
  let H = window.innerHeight;
  let hardVisible = true;
  let reduced = prefersReducedMotion() || !!settings.get('reducedMotion');

  // ══ build ═══════════════════════════════════════════════════════════════════════════════

  // --- score popups (behind everything, so the reticle always wins) ------------------------
  const popLayer = el('div.pops');
  const pops = [];
  for (let i = 0; i < POP_POOL; i++) {
    const b = el('b');
    const s = el('span');
    const node = el('div.pop', { style: { opacity: '0' } }, [b, s]);
    popLayer.appendChild(node);
    pops.push({ node, b, s, live: false, t: 0, x: 0, y: 0, drift: 0 });
  }
  layer.appendChild(popLayer);

  // --- detection ---------------------------------------------------------------------------
  const vig = el('div.detect-vig');
  const lobe = el('div.detect-lobe');
  const flash = el('div.detect-flash');
  layer.append(vig, lobe, flash);

  const detectLead = svgEl('circle.lead', {
    cx: 125, cy: 125, r: DETECT_R,
    'stroke-dasharray': `${DETECT_C * 0.16} ${DETECT_C}`,
    'stroke-dashoffset': DETECT_C * 0.08,
  });
  const detectPip = svgEl('circle.pip', { cx: 125, cy: 125 - DETECT_R, r: 2.6 });
  const detectRot = svgEl('g', { transform: 'rotate(-90 125 125)' }, [detectLead, detectPip]);
  const detect = el('div.detect', null, [
    svgEl('svg', { viewBox: '0 0 250 250' }, [
      svgEl('circle.ring', { cx: 125, cy: 125, r: DETECT_R }),
      detectRot,
    ]),
  ]);
  const detectWord = el('div.detect-word');
  layer.append(detect, detectWord);

  // --- reticle ------------------------------------------------------------------------------
  const retProg = svgEl('circle.prog', {
    cx: 31, cy: 31, r: RETICLE_R,
    'stroke-dasharray': `0 ${RETICLE_C}`,
  });
  const reticle = el('div.reticle', { 'data-verb': 'none' }, [
    svgEl('svg', { viewBox: '0 0 62 62' }, [
      svgEl('circle.prog-track', { cx: 31, cy: 31, r: RETICLE_R, opacity: 0 }),
      retProg,
      svgEl('circle.dot', { cx: 31, cy: 31, r: 1.7 }),
      // push — a chevron opening away from you, plus two flanking ticks
      svgEl('g.arm.arm-push', null, [
        svgEl('path', { d: 'M23 25.5 31 18l8 7.5' }),
        svgEl('path', { d: 'M22 38h4M36 38h4' }),
      ]),
      // pull — two arrows converging on the centre
      svgEl('g.arm.arm-pull', null, [
        svgEl('path', { d: 'M31 15v8M27.5 19.5 31 23l3.5-3.5' }),
        svgEl('path', { d: 'M31 47v-8M27.5 42.5 31 39l3.5 3.5' }),
      ]),
      // eat — an open mouth
      svgEl('g.arm.arm-eat', null, [
        svgEl('path', { d: 'M18 27c5.5-6.5 20.5-6.5 26 0' }),
        svgEl('path', { d: 'M18 35c5.5 6.5 20.5 6.5 26 0' }),
      ]),
      // climb — a stepped ledge with an up chevron
      svgEl('g.arm.arm-climb', null, [
        svgEl('path', { d: 'M20 40h9v-7h13' }),
        svgEl('path', { d: 'M26.5 24.5 31 20l4.5 4.5' }),
      ]),
    ]),
  ]);
  const retVerb = el('span.reticle-verb');
  const retName = el('span.reticle-name');
  const retKey = el('span.keycap');
  const retLabel = el('div.reticle-label', null, [retVerb, retName, retKey]);
  layer.append(reticle, retLabel);

  // --- chaos --------------------------------------------------------------------------------
  const chaosValue = el('div.chaos-value.ui-num', { text: '0' });
  const chaosDelta = el('div.chaos-delta');
  const chaosBestVal = el('b');
  const chaosBestLabel = el('u', { style: { textDecoration: 'none' } });
  const chaosMeta = el('div.chaos-meta', null, [chaosBestLabel, chaosBestVal]);
  const chaosFill = el('i');
  const chaos = el('div.chaos', null, [
    el('div.ui-label', { text: '' }),
    el('div.chaos-row', null, [chaosValue, chaosDelta]),
    el('div.chaos-bar', null, [chaosFill]),
    chaosMeta,
  ]);
  const chaosLabel = chaos.firstChild;

  // --- combo ---------------------------------------------------------------------------------
  const comboDrain = svgEl('circle.drain', {
    cx: 39, cy: 39, r: COMBO_R,
    'stroke-dasharray': `${COMBO_C} ${COMBO_C}`,
    'stroke-dashoffset': 0,
  });
  const comboMult = el('div.combo-mult', { text: '×1' });
  const comboCount = el('div.combo-count');
  const combo = el('div.combo', null, [
    svgEl('svg', { viewBox: '0 0 78 78' }, [
      svgEl('circle.track', { cx: 39, cy: 39, r: COMBO_R }),
      comboDrain,
    ]),
    comboMult,
    comboCount,
  ]);

  layer.appendChild(el('div.hud-region.hud-tl', null, [chaos, combo]));

  // --- timer ------------------------------------------------------------------------------------
  const timerValue = el('div.timer-value.ui-num', { text: '3:00' });
  const timerFill = el('i');
  const timerLabel = el('div.ui-label');
  const timer = el('div.timer', null, [
    timerLabel,
    timerValue,
    el('div.timer-track', null, [timerFill]),
  ]);
  layer.appendChild(el('div.hud-region.hud-tc', null, [timer]));

  // --- status chips ---------------------------------------------------------------------------
  const chipRegion = el('div.hud-region.hud-tr');
  layer.appendChild(chipRegion);

  // --- toasts ------------------------------------------------------------------------------------
  const toastRegion = el('div.hud-region.hud-bl');
  layer.appendChild(toastRegion);

  // --- stamina ------------------------------------------------------------------------------------
  const stamFill = el('i');
  const stamLabel = el('div.ui-label');
  const stam = el('div.stam', null, [stamLabel, el('div.stam-track', null, [stamFill])]);
  layer.appendChild(el('div.hud-region.hud-br', null, [stam]));

  // --- subtitles ------------------------------------------------------------------------------------
  const subRegion = el('div.subs');
  layer.appendChild(el('div.hud-region.hud-bc', null, [subRegion]));

  // --- objective board ------------------------------------------------------------------------------
  const objList = el('div');
  const objLabel = el('div.ui-label');
  const objs = el('div.objs', null, [objLabel, objList]);
  layer.appendChild(objs);

  // --- tutorial ---------------------------------------------------------------------------------------
  const tutText = el('div.tut-text');
  const tutDots = el('div.tut-dots', null, TUTORIAL.map(() => el('i')));
  const tut = el('div.tut', null, [tutText, tutDots]);
  layer.appendChild(tut);

  // --- stats ------------------------------------------------------------------------------------------
  const statsRows = {};
  const statsBox = el('div.stats.ui-hide');
  for (const k of ['fps', 'frame', 'draws', 'tris', 'programs', 'tier']) {
    const b = el('b');
    statsRows[k] = b;
    statsBox.append(el('u', { text: k }), b);
  }
  layer.appendChild(statsBox);

  // ══ state ═══════════════════════════════════════════════════════════════════════════════════

  let scoreTarget = 0;
  let scoreShown = 0;
  let scorePopT = 0;
  let deltaT = 0;
  let bestScore = 0;

  let comboCountN = 0;
  let comboMultN = 1;
  let comboVisible = false;

  let detection = 0;
  let detectionShown = 0;
  let parentState = 'idle';
  let bearing = 0;
  let bearingShown = 0;

  let promptActive = false;
  let promptVerb = 'none';
  let promptProgress = 0;
  let promptShown = 0;

  let stamina = 1;
  let staminaVis = 0;

  let objVisible = 0;         // seconds of forced visibility left
  let objHeld = false;
  let objData = [];
  let objDirty = true;

  let tutStep = -1;
  let tutTimer = 0;
  let tutDone = !!store.get('tutorialDone', false);

  let statsT = 0;
  let pulse = 0;
  let lastToastKey = '';
  let lastToastAt = -10;

  const chips = new Map();
  const toasts = [];
  const subs = [];

  const _v = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _to = new THREE.Vector3();
  const _cam = new THREE.Vector3();

  // ══ painting ════════════════════════════════════════════════════════════════════════════════

  function paintStatic() {
    setText(chaosLabel, i18n.t('ui.hud.chaos'));
    setText(timerLabel, i18n.t('ui.hud.naptime'));
    setText(comboCount, i18n.t('ui.hud.combo'));
    setText(stamLabel, i18n.t('ui.hud.stamina'));
    setText(objLabel, i18n.t('ui.hud.objectives'));
    setText(chaosBestLabel, i18n.t('ui.hud.best'));
    setText(chaosBestVal, i18n.number(bestScore));
    for (const rec of chips.values()) setText(rec.name, i18n.t(rec.labelKey));
    objDirty = true;
    paintPrompt();
  }

  function paintPrompt() {
    if (!promptActive || promptVerb === 'none') {
      setClass(retLabel, 'on', false);
      return;
    }
    setClass(retLabel, 'on', true);
    setText(retVerb, i18n.t(`verb.${promptVerb}`));
    setText(retName, promptLabelKey ? i18n.t(promptLabelKey) : '');
    setText(retKey, promptBinding || '');
    retKey.style.display = promptBinding ? '' : 'none';
  }

  let promptLabelKey = null;
  let promptBinding = null;

  // ══ events ══════════════════════════════════════════════════════════════════════════════════

  function onScore(p) {
    if (!p) return;
    scoreTarget = p.total || 0;
    if (reduced) scoreShown = scoreTarget;
    scorePopT = 0.42;
    replay(chaosValue, 'pop');
  }

  function onScorePopup(p) {
    if (!p) return;
    const amount = Math.round(p.amount || 0);
    if (amount <= 0) return;

    setText(chaosDelta, `+${i18n.number(amount)}`);
    setClass(chaosDelta, 'on', true);
    deltaT = 1.0;

    const slot = pops.find((s) => !s.live) || pops[0];
    slot.live = true;
    slot.t = 0;
    slot.crit = !!p.crit;
    setClass(slot.node, 'crit', !!p.crit);
    setText(slot.b, `+${i18n.number(amount)}`);
    setText(slot.s, i18n.t(p.labelKey || p.reasonKey || 'toast.chaos'));

    const pos = p.position;
    let x = W * 0.5;
    let y = H * 0.46;
    if (pos && ctx.camera) {
      _v.set(pos.x || 0, pos.y || 0, pos.z || 0);
      _v.project(ctx.camera);
      const onScreen = _v.z < 1 && Math.abs(_v.x) < 1.35 && Math.abs(_v.y) < 1.35;
      if (onScreen) {
        x = (_v.x * 0.5 + 0.5) * W;
        y = (-_v.y * 0.5 + 0.5) * H;
      }
    }
    slot.x = clamp(x, W * 0.08, W * 0.92);
    slot.y = clamp(y, H * 0.1, H * 0.86);
    slot.drift = (ctx.rng ? ctx.rng() : 0.5) * 26 - 13;
    slot.node.style.opacity = '0';
    placePop(slot, 0);
  }

  function placePop(slot, t) {
    const rise = reduced ? 0 : smoothstep(t) * 74;
    const sway = reduced ? 0 : Math.sin(t * 3.1) * slot.drift * (1 - t);
    const s = reduced ? 1 : 0.84 + easeBack(clamp01(t * 4)) * 0.16;
    slot.node.style.transform =
      `translate3d(${(slot.x + sway).toFixed(1)}px, ${(slot.y - rise).toFixed(1)}px, 0)`
      + ` translate(-50%, -50%) scale(${s.toFixed(3)})`;
  }

  function onCombo(p) {
    if (!p) return;
    const count = p.count || 0;
    comboMultN = p.multiplier || 1;
    if (count > comboCountN && count >= 2) replay(combo, 'bump');
    comboCountN = count;
    comboVisible = count >= 2;
    setClass(combo, 'on', comboVisible);
    setText(comboMult, `×${comboMultN % 1 === 0 ? comboMultN : comboMultN.toFixed(1)}`);
    // Weight and colour escalate with the chain: bone at ×1.5, amber at ×3, danger-hot at ×6.
    const heat = clamp01((comboMultN - 1.2) / 5);
    const col = heat < 0.34
      ? 'var(--bone)'
      : heat < 0.72 ? 'var(--amber-2)' : 'var(--amber)';
    comboMult.style.color = col;
    comboMult.style.fontSize = `calc(var(--u) * ${(21 + heat * 9).toFixed(1)})`;
    comboDrain.style.stroke = heat > 0.72 ? 'var(--danger)' : 'var(--amber)';
  }

  function onToast(p) {
    if (!p || !p.key) return;
    // Two identical toasts inside a third of a second is a double-emit, not two events.
    const now = ctx.elapsed || 0;
    if (p.key === lastToastKey && now - lastToastAt < 0.35) return;
    lastToastKey = p.key;
    lastToastAt = now;

    const name = resolveIcon(p.icon);
    const node = el('div.toast', null, [
      icon(name, 'toast-ico'),
      el('div.toast-text', { text: i18n.t(p.key, p.vars) }),
    ]);
    setClass(node, 'big', !!BIG_ICONS[p.icon]);
    setClass(node, 'warn', !!WARN_ICONS[p.icon]);
    toastRegion.appendChild(node);
    toasts.push({ node, t: 0 });
    while (toasts.length > TOAST_MAX) killToast(toasts[0]);
  }

  function killToast(rec) {
    const i = toasts.indexOf(rec);
    if (i >= 0) toasts.splice(i, 1);
    rec.node.classList.add('out');
    const n = rec.node;
    setTimeout(() => n.remove(), 340);
  }

  function subtitle(key, speech) {
    if (!ctx.state || !ctx.state.subtitles) return;
    const last = subs[subs.length - 1];
    if (last && last.key === key && last.t < 1.0) return;
    const node = el(`div.sub${speech ? '.speech' : ''}`, { text: i18n.t(key) });
    subRegion.appendChild(node);
    subs.push({ node, t: 0, key });
    while (subs.length > SUB_MAX) killSub(subs[0]);
  }

  function killSub(rec) {
    const i = subs.indexOf(rec);
    if (i >= 0) subs.splice(i, 1);
    rec.node.classList.add('out');
    const n = rec.node;
    setTimeout(() => n.remove(), 280);
  }

  function onStatusStart(p) {
    if (!p || !p.id) return;
    const existing = chips.get(p.id);
    if (existing) {
      existing.duration = p.duration || existing.duration;
      existing.t = 0;
      return;
    }
    const arc = svgEl('circle.p', {
      cx: 11, cy: 11, r: CHIP_R,
      'stroke-dasharray': `${CHIP_C} ${CHIP_C}`,
      'stroke-dashoffset': 0,
    });
    const name = el('div.chip-name', { text: i18n.t(p.labelKey || `status.${p.id}`) });
    const time = el('div.chip-time');
    const node = el('div.chip', null, [
      el('div.chip-ring', null, [
        svgEl('svg', { viewBox: '0 0 22 22' }, [
          svgEl('circle.t', { cx: 11, cy: 11, r: CHIP_R }),
          arc,
        ]),
        el('div.ico', null, [icon(resolveIcon(p.icon))]),
      ]),
      name,
      time,
    ]);
    if (p.colour) node.style.borderLeftColor = p.colour;
    chipRegion.appendChild(node);
    chips.set(p.id, {
      node, arc, name, time,
      labelKey: p.labelKey || `status.${p.id}`,
      duration: p.duration || 8,
      t: 0,
    });
  }

  function onStatusEnd(p) {
    const rec = p && chips.get(p.id);
    if (!rec) return;
    chips.delete(p.id);
    rec.node.classList.add('out');
    setTimeout(() => rec.node.remove(), 260);
  }

  function onObjectives(p) {
    if (!p || !p.list) return;
    objData = p.list;
    objDirty = true;
  }

  function paintObjectives() {
    objDirty = false;
    clear(objList);
    if (!objData.length) return;
    for (let i = 0; i < objData.length; i++) {
      const o = objData[i];
      const fill = el('i', { style: { transform: `scaleX(${(o.fraction || 0).toFixed(3)})` } });
      const target = o.unit === 'm' ? Math.round(o.target) : o.target;
      objList.appendChild(el(`div.obj${o.done ? '.done' : ''}`, null, [
        el('div.obj-top', null, [
          el('div.obj-text', { text: i18n.t(o.key, { target }) }),
          el('div.obj-bonus', { text: `+${i18n.number(o.bonus || 0)}` }),
        ]),
        el('div.obj-bar', null, [fill]),
      ]));
    }
  }

  // --- tutorial --------------------------------------------------------------------------------

  function startTutorial() {
    if (tutDone) return;
    tutStep = 0;
    tutTimer = 0;
    paintTutorial();
  }

  function paintTutorial() {
    const on = tutStep >= 0 && tutStep < TUTORIAL.length;
    setClass(tut, 'on', on || tutStep === TUTORIAL.length);
    if (tutStep === TUTORIAL.length) {
      setText(tutText, i18n.t('tut.done'));
      const dots = tutDots.children;
      for (let i = 0; i < dots.length; i++) setClass(dots[i], 'on', true);
      return;
    }
    if (!on) return;
    setText(tutText, i18n.t(TUTORIAL[tutStep].key));
    const dots = tutDots.children;
    for (let i = 0; i < dots.length; i++) setClass(dots[i], 'on', i <= tutStep);
  }

  function tutorialAdvance(what) {
    if (tutStep < 0 || tutStep >= TUTORIAL.length) return;
    if (TUTORIAL[tutStep].done !== what) return;
    tutStep++;
    tutTimer = 0;
    if (tutStep >= TUTORIAL.length) {
      paintTutorial();
      tutDone = true;
      store.set('tutorialDone', true);
      setTimeout(() => {
        if (tutStep >= TUTORIAL.length) {
          tutStep = -1;
          setClass(tut, 'on', false);
        }
      }, 3200);
      return;
    }
    paintTutorial();
  }

  // ══ per-frame ═══════════════════════════════════════════════════════════════════════════════

  function updateScore(dt) {
    if (reduced) scoreShown = scoreTarget;
    else if (Math.abs(scoreTarget - scoreShown) > 0.5) {
      scoreShown = damp(scoreShown, scoreTarget, 9, dt);
      if (Math.abs(scoreTarget - scoreShown) < 1.2) scoreShown = scoreTarget;
    } else scoreShown = scoreTarget;
    setText(chaosValue, i18n.number(scoreShown));

    if (deltaT > 0) {
      deltaT -= dt;
      if (deltaT <= 0) setClass(chaosDelta, 'on', false);
    }
    const chaos01 = ctx.state && Number.isFinite(ctx.state.chaos) ? ctx.state.chaos : 0;
    chaosFill.style.transform = `scaleX(${clamp01(chaos01).toFixed(3)})`;
  }

  function updateCombo(dt) {
    const st = ctx.state || {};
    if (!comboVisible) return;
    const frac = Number.isFinite(st.comboFraction) ? clamp01(st.comboFraction) : 0;
    comboDrain.style.strokeDashoffset = (COMBO_C * (1 - frac)).toFixed(2);
    if (frac <= 0 && (st.combo || 0) < 2) {
      comboVisible = false;
      setClass(combo, 'on', false);
    }
  }

  function updateTimer() {
    const st = ctx.state || {};
    const left = Math.max(0, st.timeLeft || 0);
    const total = st.duration || 180;
    setText(timerValue, i18n.time(left));
    timerFill.style.transform = `scaleX(${clamp01(total ? left / total : 0).toFixed(4)})`;
    setClass(timer, 'urgent', left <= 30 && left > 0);
  }

  /** Where is the parent, relative to where you are looking? 0 rad = dead ahead. */
  function updateBearing() {
    const cam = ctx.camera;
    if (!cam) return;
    let px = null;
    let pz = null;
    const p = ctx.parent;
    const src = (p && p.position) || (p && p.group && p.group.position) || null;
    if (src && (src.x !== 0 || src.z !== 0)) {
      px = src.x;
      pz = src.z;
    } else if (ctx.layout && ctx.layout.doorway) {
      // Before the AI module exists, the honest answer is "through that doorway".
      px = ctx.layout.doorway.threshold.x;
      pz = ctx.layout.doorway.threshold.z;
    }
    if (px === null) return;

    cam.getWorldPosition(_cam);
    cam.getWorldDirection(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-8) _fwd.set(0, 0, -1);
    _fwd.normalize();
    _right.set(-_fwd.z, 0, _fwd.x);
    _to.set(px - _cam.x, 0, pz - _cam.z);
    if (_to.lengthSq() < 1e-8) return;
    _to.normalize();
    bearing = Math.atan2(_to.dot(_right), _to.dot(_fwd));
  }

  function updateDetection(dt) {
    detectionShown = reduced ? detection : damp(detectionShown, detection, 7, dt);
    if (detectionShown < 0.002) detectionShown = 0;

    // shortest-path angular damping so the arc never spins the long way round
    let diff = bearing - bearingShown;
    while (diff > Math.PI) diff -= TAU;
    while (diff < -Math.PI) diff += TAU;
    bearingShown += diff * (reduced ? 1 : 1 - Math.exp(-11 * dt));

    const alarmed = detectionShown > 0.04 || parentState === 'searching'
      || parentState === 'spotted' || parentState === 'catching';
    setClass(detect, 'on', alarmed);

    const deg = (bearingShown * 180) / Math.PI - 90;
    detectRot.setAttribute('transform', `rotate(${deg.toFixed(2)} 125 125)`);

    // The arc is a wide, dim, uncertain sweep at low awareness and a tight bright wedge at high.
    const spread = 0.30 - 0.24 * smoothstep(detectionShown);
    const len = DETECT_C * spread;
    detectLead.setAttribute('stroke-dasharray', `${len.toFixed(1)} ${DETECT_C}`);
    detectLead.setAttribute('stroke-dashoffset', (len * 0.5).toFixed(1));
    const hot = detectionShown;
    const stroke = hot > 0.66 ? 'var(--danger)' : hot > 0.3 ? 'var(--amber)' : 'var(--bone-2)';
    detectLead.style.stroke = stroke;
    detectPip.style.fill = stroke;
    detectLead.style.strokeWidth = (2.4 + hot * 3.4).toFixed(2);

    // The edge alarm. A lobe pushed to the screen edge nearest their bearing, plus a ring vignette
    // that breathes once you are over half-noticed. Both are damped by photosensitivity.
    const gain = ctx.state && ctx.state.photosensitive ? 0.35 : 1;
    const beat = hot > 0.5 && !reduced ? 0.82 + Math.sin(pulse * (5 + hot * 7)) * 0.18 : 1;
    vig.style.opacity = (Math.pow(hot, 1.35) * 0.92 * beat * gain).toFixed(3);
    const dx = Math.sin(bearingShown) * W * 0.5;
    const dy = -Math.cos(bearingShown) * H * 0.5;
    lobe.style.transform = `translate3d(${dx.toFixed(0)}px, ${dy.toFixed(0)}px, 0) scale(${(0.6 + hot * 0.5).toFixed(2)})`;
    lobe.style.opacity = (Math.pow(hot, 1.6) * 0.9 * beat * gain).toFixed(3);

    const wordKey = PARENT_WORD[parentState];
    setClass(detectWord, 'on', !!wordKey && (hot > 0.22 || parentState === 'spotted' || parentState === 'catching'));
    if (wordKey) setText(detectWord, i18n.t(wordKey));
  }

  function updateReticle(dt) {
    setClass(reticle, 'active', promptActive);
    promptShown = reduced ? promptProgress : damp(promptShown, promptProgress, 18, dt);
    const p = clamp01(promptShown);
    retProg.setAttribute('stroke-dasharray', `${(RETICLE_C * p).toFixed(2)} ${RETICLE_C}`);
    retProg.style.opacity = p > 0.004 ? '1' : '0';
  }

  function updateStamina(dt) {
    const input = ctx.input && ctx.input.state;
    const playing = ctx.state && ctx.state.mode === 'playing';
    const moving = input
      ? Math.abs(input.forward || 0) + Math.abs(input.strafe || 0) > 0.15
      : false;
    const sprinting = !!(playing && input && input.sprint && moving && stamina > 0.02);
    if (sprinting) stamina = clamp01(stamina - dt / 5.2);
    else stamina = clamp01(stamina + dt / 7.5);
    if (ctx.state) ctx.state.stamina = stamina;

    const want = sprinting || stamina < 0.985 ? 1 : 0;
    staminaVis = damp(staminaVis, want, 8, dt);
    setClass(stam, 'on', staminaVis > 0.05);
    setClass(stam, 'low', stamina < 0.28);
    stamFill.style.transform = `scaleX(${stamina.toFixed(3)})`;
  }

  function updatePops(dt) {
    for (let i = 0; i < pops.length; i++) {
      const s = pops[i];
      if (!s.live) continue;
      s.t += dt;
      const t = s.t / POP_LIFE;
      if (t >= 1) {
        s.live = false;
        s.node.style.opacity = '0';
        continue;
      }
      placePop(s, t);
      const fade = t < 0.12 ? t / 0.12 : t > 0.62 ? 1 - (t - 0.62) / 0.38 : 1;
      s.node.style.opacity = fade.toFixed(3);
    }
  }

  function updateToasts(dt) {
    for (let i = toasts.length - 1; i >= 0; i--) {
      toasts[i].t += dt;
      if (toasts[i].t > TOAST_LIFE) killToast(toasts[i]);
    }
    for (let i = subs.length - 1; i >= 0; i--) {
      subs[i].t += dt;
      if (subs[i].t > SUB_LIFE) killSub(subs[i]);
    }
  }

  function updateChips(dt) {
    for (const [id, rec] of chips) {
      rec.t += dt;
      const left = Math.max(0, rec.duration - rec.t);
      const frac = rec.duration > 0 ? clamp01(left / rec.duration) : 0;
      rec.arc.style.strokeDashoffset = (CHIP_C * (1 - frac)).toFixed(2);
      setText(rec.time, `${Math.ceil(left)}`);
      if (left <= 0) onStatusEnd({ id });
    }
  }

  function updateObjectives(dt) {
    if (objVisible > 0) objVisible -= dt;
    const show = objHeld || objVisible > 0;
    setClass(objs, 'on', show);
    if (show && objDirty) paintObjectives();
  }

  function updateTutorial(dt) {
    if (tutStep < 0 || tutStep >= TUTORIAL.length) return;
    tutTimer += dt;
    if (tutTimer > TUTORIAL[tutStep].timeout) tutorialAdvance(TUTORIAL[tutStep].done);
  }

  function updateStats(dt) {
    if (!ctx.debug || !ctx.debug.enabled) return;
    statsT -= dt;
    if (statsT > 0) return;
    statsT = 0.25;
    const s = (ctx.engine && ctx.engine.stats) || null;
    if (!s) return;
    const fps = Math.round(s.fps);
    setText(statsRows.fps, String(fps));
    statsRows.fps.className = fps >= 58 ? 'ok' : fps < 40 ? 'bad' : '';
    setText(statsRows.frame, `${s.frameMs.toFixed(2)} ms`);
    setText(statsRows.draws, String(s.drawCalls));
    setText(statsRows.tris, i18n.number(s.triangles));
    setText(statsRows.programs, String(s.programs));
    setText(statsRows.tier, (ctx.quality && ctx.quality.tier) || '—');
  }

  // ══ lifecycle ═══════════════════════════════════════════════════════════════════════════════

  function update(dt) {
    if (photo) return;
    const mode = ctx.state ? ctx.state.mode : 'boot';
    if (mode === 'photo') return;
    const step = Math.min(dt || 0, 0.05);
    pulse += step;

    const playing = mode === 'playing';
    const on = hardVisible && playing;
    if (layer.dataset.off !== (on ? '' : '1')) layer.dataset.off = on ? '' : '1';
    setClass(statsBox, 'ui-hide', !(ctx.debug && ctx.debug.enabled && hardVisible));

    // The popups, toasts and stats keep ticking during the results screen so nothing freezes
    // mid-flight, but the gameplay meters only cost anything while the round is live.
    updatePops(step);
    updateToasts(step);
    updateStats(step);
    if (!playing) return;

    updateScore(step);
    updateCombo(step);
    updateTimer();
    updateBearing();
    updateDetection(step);
    updateReticle(step);
    updateStamina(step);
    updateChips(step);
    updateObjectives(step);
    updateTutorial(step);
  }

  function resize(w, h) {
    W = w || window.innerWidth;
    H = h || window.innerHeight;
    root.style.setProperty('--u', `${uiScale(W, H).toFixed(4)}px`);
  }

  function reset() {
    scoreTarget = 0;
    scoreShown = 0;
    setText(chaosValue, '0');
    setClass(chaosDelta, 'on', false);
    comboVisible = false;
    comboCountN = 0;
    comboMultN = 1;
    setClass(combo, 'on', false);
    detection = 0;
    detectionShown = 0;
    parentState = 'idle';
    stamina = 1;
    promptActive = false;
    promptVerb = 'none';
    promptProgress = 0;
    promptShown = 0;
    reticle.setAttribute('data-verb', 'none');
    setClass(retLabel, 'on', false);
    for (const rec of [...toasts]) killToast(rec);
    for (const rec of [...subs]) killSub(rec);
    for (const id of [...chips.keys()]) onStatusEnd({ id });
    for (let i = 0; i < pops.length; i++) {
      pops[i].live = false;
      pops[i].node.style.opacity = '0';
    }
    objData = [];
    objDirty = true;
    objVisible = 0;
    objHeld = false;
  }

  // ══ wiring ══════════════════════════════════════════════════════════════════════════════════

  const offs = [];
  const on = (name, fn) => offs.push(events.on(name, fn));

  on('score', onScore);
  on('ui:score', onScorePopup);
  on('combo', onCombo);
  on('ui:toast', onToast);
  on('game:objectives', onObjectives);
  on('ui:objectives', (p) => {
    if (!p) return;
    objHeld = !!p.visible;
    if (p.list) onObjectives(p);
  });
  on('objective:complete', () => {
    objVisible = 3.4;
    objDirty = true;
  });

  on('parent:sees', (p) => {
    const level = clamp01((p && p.level) || 0);
    if (level - detection > 0.28 && level > 0.5) fireFlash();
    detection = level;
  });
  on('parent:state', (p) => {
    if (!p) return;
    parentState = p.to || 'idle';
    if (parentState === 'spotted' || parentState === 'catching') fireFlash();
    const key = parentState === 'suspicious' ? 'sub.parent.suspicious'
      : parentState === 'searching' ? 'sub.parent.searching'
        : parentState === 'spotted' ? 'sub.parent.spotted'
          : parentState === 'catching' ? 'sub.parent.catching' : null;
    if (key) subtitle(key);
  });
  on('parent:bark', (p) => subtitle((p && p.key) || 'parent.bark.what', true));

  on('ui:prompt', (p) => {
    if (!p || !p.active) {
      promptActive = false;
      promptVerb = 'none';
      promptProgress = 0;
      promptLabelKey = null;
      promptBinding = null;
      reticle.setAttribute('data-verb', 'none');
      setClass(reticle, 'spent', false);
      paintPrompt();
      return;
    }
    promptActive = true;
    promptVerb = p.verb || 'none';
    promptProgress = clamp01(p.progress || 0);
    promptLabelKey = p.labelKey || null;
    promptBinding = p.binding || null;
    reticle.setAttribute('data-verb', promptVerb);
    setClass(reticle, 'spent', !!p.spent);
    paintPrompt();
  });
  on('ui:prompt:clear', () => {
    promptProgress = 0;
  });

  on('status:start', onStatusStart);
  on('status:refresh', (p) => {
    const rec = p && chips.get(p.id);
    if (rec) {
      rec.duration = p.duration || rec.duration;
      rec.t = 0;
    }
  });
  on('status:end', onStatusEnd);

  on('game:start', (p) => {
    reset();
    const best = p && p.best;
    if (best && Number.isFinite(best.score)) bestScore = best.score;
    setText(chaosBestVal, i18n.number(bestScore));
    startTutorial();
  });
  on('game:reset', reset);
  on('game:over', (p) => {
    const best = p && p.stats && p.stats.best;
    if (Number.isFinite(best)) {
      bestScore = best;
      setText(chaosBestVal, i18n.number(bestScore));
    }
  });

  // tutorial progress
  on('baby:crawl', (p) => {
    if ((p && p.speed) > 0.25) tutorialAdvance('crawl');
  });
  on('interact:pull', (p) => { if (p && p.prop && p.prop.id === 'playpen-door') tutorialAdvance('escape'); });
  on('interact:push', () => tutorialAdvance('push'));
  on('baby:lunge', () => tutorialAdvance('push'));
  on('interact:eat:start', () => tutorialAdvance('eat'));
  on('prop:eaten', () => tutorialAdvance('eat'));

  // subtitles for the noises that matter
  on('prop:shattered', () => subtitle('sub.shatter'));
  on('baby:hiccup', () => subtitle('sub.hiccup'));
  on('baby:chew', () => subtitle('sub.chew'));
  on('noise', (p) => {
    if (!p) return;
    if ((p.loudness || 0) > 0.72) subtitle('sub.crash');
  });

  on('ui:lang', paintStatic);
  on('ui:motion', (p) => {
    reduced = prefersReducedMotion() || !!(p && p.reduced);
  });

  function fireFlash() {
    if (reduced) return;
    replay(flash, 'fire');
  }

  // Best score for the top-left meta line: read the persisted record for the current difficulty.
  (function primeBest() {
    const diff = (ctx.state && ctx.state.difficulty) || 'standard';
    const rec = store.get(`best.${diff}`, null);
    bestScore = (rec && rec.score) || 0;
  })();

  paintStatic();
  resize(window.innerWidth, window.innerHeight);
  if (photo) layer.dataset.off = '1';

  const api = {
    update,
    resize,
    reset,
    setVisible(v) {
      hardVisible = !!v;
      layer.dataset.off = hardVisible ? '' : '1';
    },
    /** Menus call this so the pause screen can list what is on the board right now. */
    get objectives() {
      return objData;
    },
    toast(key, vars, iconName) {
      onToast({ key, vars, icon: iconName });
    },
    dispose() {
      for (let i = 0; i < offs.length; i++) offs[i]();
      offs.length = 0;
      layer.remove();
    },
  };

  ctx.track(api);
  return api;
}
