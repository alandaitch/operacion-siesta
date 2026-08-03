// UI · the small toolkit hud.js and menus.js are both built out of.
//
// Nothing here is clever, but four things are deliberate:
//
//  · `el()` / `svgEl()` build nodes without innerHTML, so no user-facing string ever goes through
//    an HTML parser and a prop label containing "<" cannot break the layout.
//  · `createStore()` is a localStorage wrapper that never throws (private browsing) and can write
//    RAW strings as well as JSON — main.js reads `on.lang` and `on.quality` with a bare getItem,
//    so those two keys must not be quoted.
//  · `createNav()` is the focus model for the whole interface: one linear ring of focusables per
//    screen, driven identically by keyboard, gamepad and mouse, with a designed focus ring instead
//    of the browser's outline. Focus is moved by attribute *and* by real .focus(), so screen
//    readers follow along.
//  · `createGamepad()` converts an analogue stick into discrete, repeat-able direction edges — the
//    same 380 ms / 130 ms repeat curve every console menu uses, because anything else feels wrong.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
/** Frame-rate independent exponential approach. */
export const damp = (cur, goal, lambda, dt) => goal + (cur - goal) * Math.exp(-lambda * dt);
export const smoothstep = (t) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
/** Overshooting ease used for anything that "pops". */
export const easeBack = (t) => {
  const x = clamp01(t);
  const c = 1.70158 + 1;
  const p = x - 1;
  return 1 + c * p * p * p + 1.70158 * p * p;
};

// ── DOM ────────────────────────────────────────────────────────────────────────────────────

/**
 * el('div.foo.bar', { title: 'x' }, [child, 'text'])
 * A leading tag with dotted classes keeps the call sites readable at a glance.
 */
export function el(spec, attrs, children) {
  const parts = String(spec).split('.');
  const node = document.createElement(parts[0] || 'div');
  for (let i = 1; i < parts.length; i++) if (parts[i]) node.classList.add(parts[i]);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'text') node.textContent = String(v);
      else if (k === 'style') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(node, children);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgEl(spec, attrs, children) {
  const parts = String(spec).split('.');
  const node = document.createElementNS(SVG_NS, parts[0] || 'svg');
  for (let i = 1; i < parts.length; i++) if (parts[i]) node.classList.add(parts[i]);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  if (children === null || children === undefined) return;
  if (Array.isArray(children)) {
    for (let i = 0; i < children.length; i++) append(node, children[i]);
    return;
  }
  if (typeof children === 'string' || typeof children === 'number') {
    node.appendChild(document.createTextNode(String(children)));
    return;
  }
  if (children.nodeType) node.appendChild(children);
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Write text only when it actually changed — the HUD calls this sixty times a second. */
export function setText(node, value) {
  const s = value == null ? '' : String(value);
  if (node.__t !== s) {
    node.__t = s;
    node.textContent = s;
  }
  return node;
}

export function setClass(node, name, on) {
  if (node.classList.contains(name) !== !!on) node.classList.toggle(name, !!on);
}

/** Restart a CSS animation by yanking the class and forcing a reflow. */
export function replay(node, name) {
  node.classList.remove(name);
  void node.offsetWidth;
  node.classList.add(name);
}

// ── persistence ────────────────────────────────────────────────────────────────────────────

export function createStore(prefix = 'on.') {
  const mem = new Map();
  let ls = null;
  try {
    ls = typeof localStorage !== 'undefined' ? localStorage : null;
    if (ls) {
      ls.setItem(`${prefix}__probe`, '1');
      ls.removeItem(`${prefix}__probe`);
    }
  } catch {
    ls = null;
  }
  const read = (k) => {
    try {
      return ls ? ls.getItem(k) : (mem.has(k) ? mem.get(k) : null);
    } catch {
      return null;
    }
  };
  const write = (k, v) => {
    try {
      if (ls) ls.setItem(k, v);
      else mem.set(k, v);
    } catch {
      mem.set(k, v);
    }
  };
  return {
    get(key, fallback = null) {
      const raw = read(prefix + key);
      if (raw === null) return fallback;
      try {
        return JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        write(prefix + key, JSON.stringify(value));
      } catch {
        /* unserialisable — nothing to do */
      }
    },
    /** Unquoted. main.js reads `on.lang` / `on.quality` with a bare getItem. */
    getRaw(key, fallback = null) {
      const v = read(prefix + key);
      return v === null || v === '' ? fallback : v;
    },
    setRaw(key, value) {
      write(prefix + key, String(value));
    },
  };
}

// ── environment ────────────────────────────────────────────────────────────────────────────

export function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function isCoarsePointer() {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/**
 * One number drives every dimension in ui.css. 1.0 is 1920×1080; a 1280×720 window lands near
 * 0.78 and a 4K display near 1.9. The height term is weighted harder than the width because a
 * phone in landscape is wide and very short, and there the interface must shrink, not stretch.
 */
export function uiScale(w, h) {
  const byW = w / 1920;
  const byH = h / 1080;
  const raw = Math.min(byW, byH * 1.16);
  return clamp(Math.pow(raw, 0.72), 0.62, 2.1);
}

// ── focus / navigation ─────────────────────────────────────────────────────────────────────

/**
 * A linear focus ring over whatever `collect()` returns. Every screen owns one; only the visible
 * screen's nav is `active`. Mouse hover adopts focus so the ring never disagrees with the pointer.
 */
export function createNav(collect, opts = {}) {
  let items = [];
  let index = -1;
  let active = false;

  function refresh() {
    items = (collect() || []).filter((n) => n && !n.hasAttribute('disabled') && n.offsetParent !== null);
    if (index >= items.length) index = items.length - 1;
    paint();
  }

  function paint() {
    for (let i = 0; i < items.length; i++) {
      const on = active && i === index;
      if (items[i].getAttribute('data-focus') === (on ? '1' : null)) continue;
      if (on) items[i].setAttribute('data-focus', '1');
      else items[i].removeAttribute('data-focus');
    }
  }

  function focus(i, { scroll = true } = {}) {
    if (!items.length) return;
    index = ((i % items.length) + items.length) % items.length;
    paint();
    const node = items[index];
    if (node && active) {
      try {
        node.focus({ preventScroll: true });
      } catch {
        /* older browsers */
      }
      if (scroll && node.scrollIntoView) {
        node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
  }

  function move(delta) {
    if (!items.length) return;
    focus(index < 0 ? (delta > 0 ? 0 : items.length - 1) : index + delta);
    opts.onMove?.();
  }

  function activate() {
    const node = items[index];
    if (!node) return false;
    node.click();
    return true;
  }

  return {
    refresh,
    focus,
    move,
    activate,
    get index() {
      return index;
    },
    get current() {
      return items[index] || null;
    },
    set active(v) {
      active = !!v;
      if (active) {
        refresh();
        if (index < 0) index = 0;
        focus(index, { scroll: false });
      } else {
        for (let i = 0; i < items.length; i++) items[i].removeAttribute('data-focus');
      }
    },
    get active() {
      return active;
    },
    /** Hover adopts focus, so pointer and ring never disagree. */
    bindHover(node) {
      node.addEventListener('pointerenter', () => {
        if (!active) return;
        refresh();
        const i = items.indexOf(node);
        if (i >= 0 && i !== index) {
          index = i;
          paint();
          opts.onMove?.();
        }
      });
      return node;
    },
  };
}

// ── gamepad ────────────────────────────────────────────────────────────────────────────────

const DEAD = 0.45;
const REPEAT_FIRST = 0.38;
const REPEAT_NEXT = 0.13;

/**
 * Polls the first connected pad and returns discrete edges. Buttons: 0 = confirm (A/✕),
 * 1 = back (B/○), 9 = start. D-pad 12–15 and the left stick both drive the direction repeat.
 */
export function createGamepad() {
  const out = { up: false, down: false, left: false, right: false, confirm: false, back: false, start: false };
  const heldDir = { x: 0, y: 0 };
  const held = new Set();
  let repeat = 0;

  function poll(dt) {
    out.up = out.down = out.left = out.right = false;
    out.confirm = out.back = out.start = false;
    let pads;
    try {
      pads = navigator.getGamepads ? navigator.getGamepads() : null;
    } catch {
      return out;
    }
    if (!pads) return out;
    let pad = null;
    for (let i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected) { pad = pads[i]; break; }
    if (!pad) {
      held.clear();
      heldDir.x = heldDir.y = 0;
      return out;
    }

    const ax = pad.axes[0] || 0;
    const ay = pad.axes[1] || 0;
    const b = pad.buttons;
    const dpad = (i) => !!(b[i] && b[i].pressed);
    const x = dpad(15) ? 1 : dpad(14) ? -1 : Math.abs(ax) > DEAD ? Math.sign(ax) : 0;
    const y = dpad(13) ? 1 : dpad(12) ? -1 : Math.abs(ay) > DEAD ? Math.sign(ay) : 0;

    if (x !== heldDir.x || y !== heldDir.y) {
      heldDir.x = x;
      heldDir.y = y;
      repeat = x || y ? REPEAT_FIRST : 0;
      if (y < 0) out.up = true;
      if (y > 0) out.down = true;
      if (x < 0) out.left = true;
      if (x > 0) out.right = true;
    } else if (x || y) {
      repeat -= dt;
      if (repeat <= 0) {
        repeat = REPEAT_NEXT;
        if (y < 0) out.up = true;
        if (y > 0) out.down = true;
        if (x < 0) out.left = true;
        if (x > 0) out.right = true;
      }
    }

    const edge = (i, name) => {
      const on = dpad(i);
      const key = `b${i}`;
      if (on && !held.has(key)) {
        held.add(key);
        out[name] = true;
      } else if (!on) held.delete(key);
    };
    edge(0, 'confirm');
    edge(1, 'back');
    edge(9, 'start');
    return out;
  }

  return { poll, state: out };
}
