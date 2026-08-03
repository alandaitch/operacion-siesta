// OPERATION NAPTIME — BABY — one input state, three sources.
//
// `input.state` is the single object every other module reads (gameplay/shared.js mergedInput()
// picks `forward/strafe/action/pull/eat` straight out of it), so keyboard, gamepad and touch all
// write into the same fields and nothing downstream cares which one is live. Aliases are published
// for the same button — `action` / `push` / `headbutt` are one bit — because the gameplay module
// probes several names and a missing alias would silently drop a verb.
//
// Look is accumulated as a DELTA and flushed once per frame in update(). Mouse deltas arrive at
// device rate (often faster than the frame), a gamepad stick is a rate that has to be integrated
// against dt, and a touch drag is a delta; summing them into one pending pair and clearing it each
// frame keeps all three at the same sensitivity and stops a 144 Hz mouse from turning four times
// faster than a 60 Hz one.
//
// LOOK WITHOUT POINTER LOCK — this is not a fallback, it is a first-class path. Pointer lock is
// the only way a mouse can turn indefinitely, but it is also fragile (it needs a user gesture, the
// browser can refuse it, Escape drops it, and it cannot be re-requested for over a second after an
// exit) and on a laptop trackpad it is close to useless anyway: at 0.0023 rad/px a 200 px swipe —
// about all the travel a trackpad has — buys 26° of yaw, so turning around means a dozen swipes.
// So three unlocked sources exist alongside it, and each one alone is enough to play the game:
//   · DRAG-TO-LOOK. Hold a button and move. The scale is far higher than the locked one precisely
//     because the gesture is bounded by the size of the trackpad rather than by the desk.
//   · WHEEL. On a macOS trackpad a two-finger swipe is a wheel event with fractional deltas on both
//     axes; it is the most natural "look around" gesture there is and it needs no lock at all.
//     Nothing else in the game uses the wheel, so it is mapped unconditionally while playing.
//   · ARROW-KEY LOOK. The arrows used to duplicate WASD, which is the one binding a keyboard-only
//     player never needs twice; they now turn the head instead, so there is always a way to look
//     that cannot be refused by the browser or defeated by the hardware.
// A trackpad announces itself: wheel events with a fractional delta, or any horizontal delta at
// all, are something a notched mouse wheel cannot produce. When we see one we latch `trackpad` and
// switch to the trackpad sensitivity, which is a separate stored setting from the mouse one.
//
// Losing pointer lock therefore does NOT pause. It used to, which is the behaviour an FPS trains
// you to expect, but it makes a browser that silently refuses the lock look exactly like a game
// whose camera is broken — you click, nothing locks, and any attempt to look pauses the game.
// Escape still pauses, explicitly, which is the part players actually rely on.

const DEFAULTS = {
  sensitivity: 1.0, invertY: false, gamepadSensitivity: 1.0,
  trackpadSensitivity: 1.0, touchLook: 1.0,
};
const MOUSE_SCALE = 0.0023;   // radians per pixel at sensitivity 1, pointer-locked
const DRAG_SCALE = 0.0062;    // unlocked drag: ~2.7× locked, because the gesture is bounded
const WHEEL_SCALE = 0.0034;   // radians per wheel unit
const KEY_LOOK_RATE = 2.2;    // radians per second on the arrow keys
const PAD_SCALE = 2.9;        // radians per second at full stick deflection
const PAD_DEAD = 0.18;
const TOUCH_SCALE = 0.0040;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** localStorage that degrades to memory in private mode instead of throwing. */
function makeStore(prefix = 'on.') {
  const mem = new Map();
  let ls = null;
  try {
    ls = typeof localStorage !== 'undefined' ? localStorage : null;
    if (ls) { ls.setItem(`${prefix}probe`, '1'); ls.removeItem(`${prefix}probe`); }
  } catch { ls = null; }
  return {
    get(key, fallback) {
      try {
        const raw = ls ? ls.getItem(prefix + key) : mem.get(prefix + key);
        if (raw === null || raw === undefined) return fallback;
        const v = JSON.parse(raw);
        return v === null || v === undefined ? fallback : v;
      } catch { return fallback; }
    },
    set(key, value) {
      try {
        const raw = JSON.stringify(value);
        if (ls) ls.setItem(prefix + key, raw);
        else mem.set(prefix + key, raw);
      } catch { /* quota or private mode: the session still works */ }
    },
  };
}

const MOVE_KEYS = {
  KeyW: [0, 1],
  KeyS: [0, -1],
  KeyA: [1, -1],
  KeyD: [1, 1],
};

// Arrows steer the head, not the body. Values are the sign of the *look delta* the mouse would
// produce for the same intent — baby.js applies `yaw -= look.x`, so turning left is a negative x.
const LOOK_KEYS = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  ArrowUp: [0, 1], ArrowDown: [0, -1],
};

export function createInput(ctx) {
  const events = ctx.events;
  const store = makeStore();
  const canvas = (ctx.renderer && ctx.renderer.domElement) || null;
  const doc = typeof document !== 'undefined' ? document : null;
  const win = typeof window !== 'undefined' ? window : null;

  const settings = {
    sensitivity: clamp(Number(store.get('sensitivity', DEFAULTS.sensitivity)) || 1, 0.15, 5),
    gamepadSensitivity: clamp(Number(store.get('gamepadSensitivity', DEFAULTS.gamepadSensitivity)) || 1, 0.15, 5),
    trackpadSensitivity: clamp(Number(store.get('trackpadSensitivity', DEFAULTS.trackpadSensitivity)) || 1, 0.15, 5),
    invertY: !!store.get('invertY', DEFAULTS.invertY),
  };

  const state = {
    forward: 0,
    strafe: 0,
    moving: false,
    sprint: false,
    look: { x: 0, y: 0 },
    // one bit, three names — gameplay/shared.js probes all of them
    action: false, push: false, headbutt: false,
    pull: false, grab: false, yank: false,
    eat: false,
    objectives: false,
    crouch: false,
    source: 'keyboard',
    pointerLocked: false,
    touch: false,
    gamepad: false,
    /** Latched the first time an input produces something a notched mouse wheel cannot. */
    trackpad: false,
    /** Which look source last moved the camera — HUD may want to hint the right gesture. */
    lookSource: 'none',
  };

  let pendingX = 0;
  let pendingY = 0;
  const held = new Set();
  const lookHeld = new Set();
  /** Unlocked drag-to-look: the last pointer position, and whether a button is down on the game. */
  let dragging = false;
  let dragX = 0;
  let dragY = 0;
  let padIndex = -1;
  let padPrev = [];
  let rumbleUntil = 0;
  let touchLayer = null;
  let disposed = false;

  const alive = () => ctx.state && (ctx.state.mode === 'playing');
  const typing = (t) => !!(t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

  function setPush(v) { state.action = v; state.push = v; state.headbutt = v; }
  function setPull(v) { state.pull = v; state.grab = v; state.yank = v; }

  // ── keyboard ─────────────────────────────────────────────────────────────────────────────────

  function recomputeMove() {
    let f = 0;
    let s = 0;
    for (const code of held) {
      const m = MOVE_KEYS[code];
      if (!m) continue;
      if (m[0] === 0) f += m[1];
      else s += m[1];
    }
    state.forward = clamp(f, -1, 1);
    state.strafe = clamp(s, -1, 1);
    state.moving = Math.abs(state.forward) + Math.abs(state.strafe) > 0.15;
  }

  function onKeyDown(e) {
    if (typing(e.target)) return;
    const c = e.code;
    if (MOVE_KEYS[c] || LOOK_KEYS[c] || c === 'Space' || c === 'Tab') e.preventDefault();
    if (e.repeat) return;
    state.source = 'keyboard';
    if (MOVE_KEYS[c]) { held.add(c); recomputeMove(); return; }
    if (LOOK_KEYS[c]) { lookHeld.add(c); return; }
    switch (c) {
      case 'ShiftLeft': case 'ShiftRight': state.sprint = true; break;
      case 'Space': setPush(true); break;
      case 'KeyE': setPull(true); break;
      case 'KeyF': state.eat = true; break;
      case 'Tab': state.objectives = true; events.emit('ui:objectives:request', {}); break;
      case 'KeyV': toggleView(); break;
      case 'Escape': togglePause(); break;
      case 'KeyC': state.crouch = true; break;
      default: break;
    }
  }

  function onKeyUp(e) {
    const c = e.code;
    if (MOVE_KEYS[c]) { held.delete(c); recomputeMove(); return; }
    if (LOOK_KEYS[c]) { lookHeld.delete(c); return; }
    switch (c) {
      case 'ShiftLeft': case 'ShiftRight': state.sprint = false; break;
      case 'Space': setPush(false); break;
      case 'KeyE': setPull(false); break;
      case 'KeyF': state.eat = false; break;
      case 'Tab': state.objectives = false; break;
      case 'KeyC': state.crouch = false; break;
      default: break;
    }
  }

  function clearAll() {
    held.clear();
    lookHeld.clear();
    dragging = false;
    recomputeMove();
    state.sprint = false;
    setPush(false);
    setPull(false);
    state.eat = false;
    state.objectives = false;
    pendingX = 0;
    pendingY = 0;
  }

  // ── view & pause ─────────────────────────────────────────────────────────────────────────────

  function toggleView() {
    if (!ctx.state) return;
    const next = ctx.state.view === 'third' ? 'first' : 'third';
    ctx.state.view = next;
    events.emit('view:changed', { view: next });
  }

  function togglePause() {
    if (!ctx.state) return;
    const mode = ctx.state.mode;
    if (mode !== 'playing' && mode !== 'paused') return;
    const paused = mode === 'playing';
    // UI owns the menu; we own the state flip so Escape works even before a menu exists.
    ctx.state.mode = paused ? 'paused' : 'playing';
    if (paused) clearAll();
    events.emit('ui:pause', { paused });
    if (paused && doc && doc.pointerLockElement) {
      try { doc.exitPointerLock(); } catch { /* already gone */ }
    }
  }

  // ── mouse ────────────────────────────────────────────────────────────────────────────────────

  /** Anything a notched wheel cannot produce means we are on a precision surface. */
  function noteTrackpad() {
    if (state.trackpad) return;
    state.trackpad = true;
    events.emit('input:trackpad', {});
  }

  const lookScale = () => (state.trackpad ? settings.trackpadSensitivity : settings.sensitivity);

  function addLook(dx, dy, source) {
    if (!alive()) return;
    pendingX += dx;
    pendingY += dy * (settings.invertY ? -1 : 1);
    state.lookSource = source;
  }

  function onMouseMove(e) {
    if (!alive()) return;
    if (state.pointerLocked) {
      const s = MOUSE_SCALE * settings.sensitivity;
      addLook((e.movementX || 0) * s, (e.movementY || 0) * s, 'lock');
      return;
    }
    if (!dragging) return;
    // Unlocked: the browser gives no movementX on some paths, and on others it gives one that
    // stops dead at the screen edge. Client coordinates are the only thing that is always right.
    const s = DRAG_SCALE * lookScale();
    addLook((e.clientX - dragX) * s, (e.clientY - dragY) * s, 'drag');
    dragX = e.clientX;
    dragY = e.clientY;
  }

  function onPointerDown(e) {
    if (state.touch || e.pointerType === 'touch') return;
    state.source = 'mouse';
    if (e.pointerType === 'pen') noteTrackpad();
    if (!alive()) return;
    dragging = true;
    dragX = e.clientX;
    dragY = e.clientY;
    // Still ask for the lock — a mouse user wants it, and it costs nothing when it is refused,
    // because drag-to-look is already armed above and simply never fires once the lock engages.
    if (doc && !doc.pointerLockElement && canvas && canvas.requestPointerLock) {
      const r = canvas.requestPointerLock();
      if (r && typeof r.catch === 'function') r.catch(() => { /* too soon after an exit; ignore */ });
    }
    if (e.button === 0) setPush(true);
    else if (e.button === 2) setPull(true);
  }

  function onPointerUp(e) {
    if (state.touch || e.pointerType === 'touch') return;
    dragging = false;
    if (e.button === 0) setPush(false);
    else if (e.button === 2) setPull(false);
  }

  /**
   * Two-finger swipe on a trackpad, or a wheel on a mouse. Nothing else in the game uses the
   * wheel, so it is look, unconditionally, while playing. Fractional or horizontal deltas are
   * the trackpad tell — a notched wheel emits whole multiples on deltaY only.
   */
  function onWheel(e) {
    if (!alive()) return;
    const dx = e.deltaX || 0;
    const dy = e.deltaY || 0;
    if (dx !== 0 || dy % 1 !== 0 || Math.abs(dy) < 12) noteTrackpad();
    e.preventDefault();
    // deltaMode 1 is lines, 2 is pages; normalise both to something pixel-ish.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const s = WHEEL_SCALE * lookScale();
    addLook(-dx * unit * s, -dy * unit * s, 'wheel');
  }

  function onLockChange() {
    const locked = !!(doc && doc.pointerLockElement && doc.pointerLockElement === canvas);
    const lost = state.pointerLocked && !locked;
    state.pointerLocked = locked;
    if (locked) dragging = false; // the lock owns the pointer now; do not double-count
    if (lost) {
      // Deliberately NOT a pause: see the header. Losing the lock leaves the player with drag,
      // wheel and arrow look, all of which work, so the round carries on.
      clearAll();
      events.emit('input:pointerlock', { locked: false });
    } else if (locked) {
      events.emit('input:pointerlock', { locked: true });
    }
  }

  // ── gamepad ──────────────────────────────────────────────────────────────────────────────────

  const axis = (v) => {
    const a = Math.abs(v);
    if (a < PAD_DEAD) return 0;
    const t = (a - PAD_DEAD) / (1 - PAD_DEAD);
    return Math.sign(v) * t * t; // squared response: precise near centre, quick at the edge
  };

  function pollGamepad(dt) {
    if (!win || !win.navigator || !win.navigator.getGamepads) return;
    let pads;
    try { pads = win.navigator.getGamepads(); } catch { return; }
    if (!pads) return;
    let pad = padIndex >= 0 ? pads[padIndex] : null;
    if (!pad || !pad.connected) {
      pad = null;
      for (let i = 0; i < pads.length; i++) {
        if (pads[i] && pads[i].connected) { pad = pads[i]; padIndex = i; break; }
      }
    }
    if (!pad) { state.gamepad = false; return; }
    state.gamepad = true;

    const ax = pad.axes || [];
    const lx = axis(ax[0] || 0);
    const ly = axis(ax[1] || 0);
    const rx = axis(ax[2] || 0);
    const ry = axis(ax[3] || 0);
    const btn = pad.buttons || [];
    const down = (i) => !!(btn[i] && (btn[i].pressed || btn[i].value > 0.5));

    if (Math.abs(lx) + Math.abs(ly) > 0.02) {
      state.forward = clamp(-ly, -1, 1);
      state.strafe = clamp(lx, -1, 1);
      state.moving = true;
      state.source = 'gamepad';
    } else if (state.source === 'gamepad' && held.size === 0 && !state.touch) {
      state.forward = 0;
      state.strafe = 0;
      state.moving = false;
    }

    if (Math.abs(rx) + Math.abs(ry) > 0.02) {
      const s = PAD_SCALE * settings.gamepadSensitivity * dt;
      pendingX += rx * s;
      pendingY += ry * s * (settings.invertY ? -1 : 1);
      state.source = 'gamepad';
    }

    // Standard mapping: A / RT shove, X / LT grab, B eat, Y view, RB or L3 sprint.
    const push = down(0) || down(7);
    const eat = down(1);
    const pull = down(2) || down(6);
    const sprint = down(5) || down(10);
    const objectives = down(8);
    if (push || eat || pull || sprint || objectives || down(3) || down(9)) state.source = 'gamepad';
    if (state.source === 'gamepad') {
      setPush(push);
      setPull(pull);
      state.eat = eat;
      state.sprint = sprint;
      state.objectives = objectives;
    }
    if (down(3) && !padPrev[3]) toggleView();
    if (down(9) && !padPrev[9]) togglePause();
    for (let i = 0; i < btn.length; i++) padPrev[i] = down(i);
  }

  /** Haptics on impact. Silently absent on pads and browsers that do not implement it. */
  function rumble(strength, ms) {
    if (padIndex < 0 || !win || !win.navigator || !win.navigator.getGamepads) return;
    const now = win.performance ? win.performance.now() : Date.now();
    if (now < rumbleUntil) return;
    rumbleUntil = now + ms * 0.7;
    let pad = null;
    try { pad = win.navigator.getGamepads()[padIndex]; } catch { return; }
    const act = pad && (pad.vibrationActuator || (pad.hapticActuators && pad.hapticActuators[0]));
    if (!act) return;
    try {
      if (act.playEffect) {
        const p = act.playEffect('dual-rumble', {
          duration: ms, strongMagnitude: clamp(strength, 0, 1), weakMagnitude: clamp(strength * 0.7, 0, 1),
        });
        if (p && p.catch) p.catch(() => {});
      } else if (act.pulse) {
        act.pulse(clamp(strength, 0, 1), ms);
      }
    } catch { /* not supported */ }
  }

  // ── touch ────────────────────────────────────────────────────────────────────────────────────

  const touchLook = { id: -1, x: 0, y: 0 };
  const touchStick = { id: -1, ox: 0, oy: 0, x: 0, y: 0, el: null, knob: null };

  function styleEl(el, css) { for (const k in css) el.style[k] = css[k]; return el; }

  function buildTouchLayer() {
    if (touchLayer || !doc || !doc.body) return;
    const t = ctx.i18n && ctx.i18n.t ? (k) => ctx.i18n.t(k) : (k) => k;
    touchLayer = styleEl(doc.createElement('div'), {
      position: 'fixed', inset: '0', zIndex: '14', pointerEvents: 'none',
      touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none',
    });
    touchLayer.id = 'on-touch';
    touchLayer.setAttribute('aria-hidden', 'false');

    const base = styleEl(doc.createElement('div'), {
      position: 'absolute', left: '0', bottom: '0', width: '46vw', height: '58vh',
      pointerEvents: 'auto', touchAction: 'none',
    });
    const ring = styleEl(doc.createElement('div'), {
      position: 'absolute', width: '34vw', maxWidth: '190px', aspectRatio: '1',
      left: '6vw', bottom: '8vh', borderRadius: '50%',
      border: '2px solid rgba(255,255,255,0.22)', background: 'rgba(255,255,255,0.05)',
      opacity: '0.55', transition: 'opacity 160ms linear',
    });
    const knob = styleEl(doc.createElement('div'), {
      position: 'absolute', width: '38%', aspectRatio: '1', left: '31%', top: '31%',
      borderRadius: '50%', background: 'rgba(255,255,255,0.30)',
      boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
    });
    ring.appendChild(knob);
    base.appendChild(ring);
    touchStick.el = ring;
    touchStick.knob = knob;

    const lookZone = styleEl(doc.createElement('div'), {
      position: 'absolute', right: '0', top: '0', width: '54vw', height: '100%',
      pointerEvents: 'auto', touchAction: 'none',
    });

    function button(labelKey, right, bottom, size, glyph) {
      const b = styleEl(doc.createElement('div'), {
        position: 'absolute', right, bottom, width: size, height: size, borderRadius: '50%',
        border: '2px solid rgba(255,255,255,0.28)', background: 'rgba(20,16,12,0.30)',
        pointerEvents: 'auto', touchAction: 'none', display: 'grid', placeItems: 'center',
        backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
      });
      b.setAttribute('role', 'button');
      b.setAttribute('aria-label', t(labelKey));
      const dot = styleEl(doc.createElement('div'), {
        width: glyph, height: glyph, borderRadius: '50%', background: 'rgba(255,255,255,0.55)',
      });
      b.appendChild(dot);
      return b;
    }

    const bPush = button('ui.touch.push', '6vw', '9vh', '22vw', '34%');
    const bPull = button('ui.touch.grab', '30vw', '20vh', '16vw', '26%');
    const bEat = button('ui.touch.eat', '30vw', '4vh', '16vw', '18%');
    const bView = button('ui.touch.view', '4vw', '82vh', '12vw', '22%');

    const bind = (el, on, off) => {
      el.addEventListener('touchstart', (e) => { e.preventDefault(); on(); }, { passive: false });
      el.addEventListener('touchend', (e) => { e.preventDefault(); off(); }, { passive: false });
      el.addEventListener('touchcancel', () => off(), { passive: true });
    };
    bind(bPush, () => setPush(true), () => setPush(false));
    bind(bPull, () => setPull(true), () => setPull(false));
    bind(bEat, () => { state.eat = true; }, () => { state.eat = false; });
    bind(bView, () => toggleView(), () => {});

    touchLayer.appendChild(base);
    touchLayer.appendChild(lookZone);
    touchLayer.appendChild(bPush);
    touchLayer.appendChild(bPull);
    touchLayer.appendChild(bEat);
    touchLayer.appendChild(bView);
    doc.body.appendChild(touchLayer);

    base.addEventListener('touchstart', onStickStart, { passive: false });
    base.addEventListener('touchmove', onStickMove, { passive: false });
    base.addEventListener('touchend', onStickEnd, { passive: false });
    base.addEventListener('touchcancel', onStickEnd, { passive: false });
    lookZone.addEventListener('touchstart', onLookStart, { passive: false });
    lookZone.addEventListener('touchmove', onLookMove, { passive: false });
    lookZone.addEventListener('touchend', onLookEnd, { passive: false });
    lookZone.addEventListener('touchcancel', onLookEnd, { passive: false });
  }

  function onStickStart(e) {
    e.preventDefault();
    const t = e.changedTouches[0];
    touchStick.id = t.identifier;
    touchStick.ox = t.clientX;
    touchStick.oy = t.clientY;
    if (touchStick.el) {
      touchStick.el.style.opacity = '0.9';
      const w = touchStick.el.offsetWidth || 140;
      touchStick.el.style.left = `${t.clientX - w * 0.5}px`;
      touchStick.el.style.bottom = `${(win ? win.innerHeight : 0) - t.clientY - w * 0.5}px`;
    }
    onStickMove(e);
  }

  function onStickMove(e) {
    let t = null;
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === touchStick.id) t = e.changedTouches[i];
    }
    if (!t) return;
    e.preventDefault();
    const R = 62;
    const dx = clamp((t.clientX - touchStick.ox) / R, -1, 1);
    const dy = clamp((t.clientY - touchStick.oy) / R, -1, 1);
    state.strafe = dx;
    state.forward = -dy;
    state.moving = Math.abs(dx) + Math.abs(dy) > 0.15;
    state.sprint = Math.hypot(dx, dy) > 0.92;
    state.source = 'touch';
    if (touchStick.knob) {
      touchStick.knob.style.transform = `translate(${dx * 34}%, ${dy * 34}%)`;
    }
  }

  function onStickEnd(e) {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier !== touchStick.id) continue;
      touchStick.id = -1;
      state.forward = 0;
      state.strafe = 0;
      state.moving = false;
      state.sprint = false;
      if (touchStick.knob) touchStick.knob.style.transform = 'translate(0,0)';
      if (touchStick.el) touchStick.el.style.opacity = '0.55';
    }
  }

  function onLookStart(e) {
    e.preventDefault();
    const t = e.changedTouches[0];
    touchLook.id = t.identifier;
    touchLook.x = t.clientX;
    touchLook.y = t.clientY;
    state.source = 'touch';
  }

  function onLookMove(e) {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.identifier !== touchLook.id) continue;
      e.preventDefault();
      const s = TOUCH_SCALE * settings.sensitivity;
      pendingX += (t.clientX - touchLook.x) * s;
      pendingY += (t.clientY - touchLook.y) * s * (settings.invertY ? -1 : 1);
      touchLook.x = t.clientX;
      touchLook.y = t.clientY;
    }
  }

  function onLookEnd(e) {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === touchLook.id) touchLook.id = -1;
    }
  }

  function onFirstTouch() {
    if (state.touch) return;
    state.touch = true;
    state.source = 'touch';
    buildTouchLayer();
  }

  // ── wiring ───────────────────────────────────────────────────────────────────────────────────

  if (win) {
    win.addEventListener('keydown', onKeyDown, { passive: false });
    win.addEventListener('keyup', onKeyUp, { passive: true });
    win.addEventListener('blur', clearAll);
    win.addEventListener('touchstart', onFirstTouch, { passive: true, capture: true });
  }
  if (doc) {
    doc.addEventListener('pointerdown', onPointerDown);
    doc.addEventListener('pointerup', onPointerUp);
    doc.addEventListener('pointercancel', onPointerUp);
    doc.addEventListener('mousemove', onMouseMove);
    doc.addEventListener('pointerlockchange', onLockChange);
    doc.addEventListener('contextmenu', preventContext);
    // Not passive: while playing this consumes the gesture, otherwise a two-finger swipe
    // rubber-bands the page instead of turning the baby's head.
    doc.addEventListener('wheel', onWheel, { passive: false });
  }
  if (canvas) canvas.addEventListener('contextmenu', preventContext);

  function preventContext(e) {
    if (ctx.state && ctx.state.mode === 'playing') e.preventDefault();
  }

  const api = {
    state,
    settings,
    update,
    dispose,
    rumble,
    setSensitivity(v) {
      settings.sensitivity = clamp(Number(v) || 1, 0.15, 5);
      store.set('sensitivity', settings.sensitivity);
    },
    setTrackpadSensitivity(v) {
      settings.trackpadSensitivity = clamp(Number(v) || 1, 0.15, 5);
      store.set('trackpadSensitivity', settings.trackpadSensitivity);
    },
    setGamepadSensitivity(v) {
      settings.gamepadSensitivity = clamp(Number(v) || 1, 0.15, 5);
      store.set('gamepadSensitivity', settings.gamepadSensitivity);
    },
    setInvertY(v) {
      settings.invertY = !!v;
      store.set('invertY', settings.invertY);
    },
    /** Test/telemetry hook: inject a look delta in radians, as any real source would. */
    look(dx, dy) { addLook(dx || 0, dy || 0, 'api'); },
    reset() { clearAll(); },
  };

  const offs = [
    events.on('baby:bump', (e) => rumble(clamp((e && e.force ? e.force : 3) / 10, 0.15, 1), 110)),
    events.on('prop:shattered', () => rumble(0.85, 180)),
    events.on('prop:toppled', () => rumble(0.35, 90)),
    events.on('camera:shake', (e) => rumble(clamp((e && e.amount ? e.amount : 0.3) * 0.8, 0.1, 1), 120)),
    events.on('game:over', () => { clearAll(); rumble(1, 400); }),
    // UI's settings panel emits this; before, nothing listened and the sensitivity slider was inert.
    events.on('input:settings', (e) => {
      if (!e) return;
      if (e.sensitivity !== undefined) api.setSensitivity(e.sensitivity);
      if (e.trackpadSensitivity !== undefined) api.setTrackpadSensitivity(e.trackpadSensitivity);
      if (e.gamepadSensitivity !== undefined) api.setGamepadSensitivity(e.gamepadSensitivity);
      if (e.invertY !== undefined) api.setInvertY(e.invertY);
    }),
  ];

  if (typeof navigator !== 'undefined' && (navigator.maxTouchPoints > 1) && win && !win.matchMedia?.('(pointer: fine)')?.matches) {
    onFirstTouch();
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────────────

  function update(dt) {
    if (disposed) return;
    const step = Math.min(dt || 0, 0.05);
    pollGamepad(step);
    if (lookHeld.size && alive()) {
      let ky = 0;
      let kp = 0;
      for (const code of lookHeld) {
        const k = LOOK_KEYS[code];
        if (!k) continue;
        ky += k[0];
        kp += k[1];
      }
      // Held keys are a rate, so they integrate against dt the way the gamepad stick does.
      const s = KEY_LOOK_RATE * settings.sensitivity * step;
      if (ky || kp) addLook(ky * s, -kp * s, 'keys');
    }
    if (ctx.state && ctx.state.mode !== 'playing') {
      pendingX = 0;
      pendingY = 0;
    }
    state.look.x = pendingX;
    state.look.y = pendingY;
    pendingX = 0;
    pendingY = 0;
    state.moving = Math.abs(state.forward) + Math.abs(state.strafe) > 0.15;
  }

  function dispose() {
    disposed = true;
    if (win) {
      win.removeEventListener('keydown', onKeyDown);
      win.removeEventListener('keyup', onKeyUp);
      win.removeEventListener('blur', clearAll);
      win.removeEventListener('touchstart', onFirstTouch, { capture: true });
    }
    if (doc) {
      doc.removeEventListener('pointerdown', onPointerDown);
      doc.removeEventListener('pointerup', onPointerUp);
      doc.removeEventListener('mousemove', onMouseMove);
      doc.removeEventListener('pointerlockchange', onLockChange);
      doc.removeEventListener('contextmenu', preventContext);
    }
    if (canvas) canvas.removeEventListener('contextmenu', preventContext);
    for (let i = 0; i < offs.length; i++) if (offs[i]) offs[i]();
    if (touchLayer && touchLayer.parentNode) touchLayer.parentNode.removeChild(touchLayer);
    touchLayer = null;
  }

  ctx.track({ dispose });

  return api;
}
