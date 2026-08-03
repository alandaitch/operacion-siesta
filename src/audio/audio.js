// AUDIO · the mixer, the spatialiser and the event wiring.
//
// There are no audio files in this project. Every sound is synthesised at runtime (see sfx.js,
// voice.js, music.js) and every reverb is a procedurally generated impulse response (ir.js).
//
// Signal flow:
//     voice ─► [hallway LP] ─► tap ─┬─► PannerNode(HRTF) ─► bus(sfx|ambience|ui) ─┐
//                                   ├─► roomSend  ─► sfxRoomIn  ─► roomConvolver ─┤
//                                   └─► hallSend  ─► sfxHallIn  ─► hallConvolver ─┤
//     score layers ─► musicDuck ─► musicBus ─► roomSend ─────────────────────────┤
//                                                                    master ◄─────┘
//     master ─► glue compressor ─► brickwall limiter ─► destination
//
// Three things earn their keep here. (1) The AudioContext is not constructed until a real user
// gesture, so Chrome never prints the autoplay warning and photo mode costs literally nothing.
// (2) Voices are pooled with a hard cap (24 on high) and the *quietest* voice is stolen, not the
// oldest — a distant book landing should never cut off the vase shattering in your face.
// (3) Anything past the doorway at z = +3.4 is low-passed at 620 Hz and sent to a separate,
// longer, darker hallway convolver, because hearing the parent move in the next room is the
// whole stealth loop and it has to be legible without being loud.

import * as THREE from 'three';
import { makeBuffer, gainNode, filterNode, clamp, smoothstep } from './dsp.js';
import { makeRoomIR, makeHallIR } from './ir.js';
import { BUFFERS, SOUNDS, MATERIAL_SOUND } from './sfx.js';
import { createScore } from './music.js';
import { createAmbience } from './ambience.js';

const STORE_KEY = 'on.audio';

const BUS_NAMES = ['music', 'sfx', 'ambience', 'ui'];

const VOICE_CAP = { low: 10, medium: 16, high: 24, ultra: 28 };
const VARIANTS = { low: 2, medium: 2, high: 3, ultra: 4 };

/** Minimum seconds between two plays of the same sound name. */
const RATE = {
  'baby.pat.rug': 0.055,
  'baby.pat.wood': 0.055,
  'baby.pat.mat': 0.055,
  'baby.squeal': 1.7,
  'baby.giggle': 2.2,
  'baby.grunt': 0.9,
  'baby.babble': 2.4,
  'baby.hiccup': 3.5,
  'baby.raspberry': 2.6,
  'baby.breath': 2.8,
  'baby.chew': 0.35,
  'baby.gasp': 1.4,
  'baby.bonk': 0.35,
  'parent.step.wood': 0.14,
  'parent.step.rug': 0.14,
  'parent.bark': 1.6,
  'parent.sigh': 3,
  'world.clockTick': 0.5,
  'world.cordCreak': 1.1,
  'ui.score': 0.06,
  'ui.combo': 0.25,
  'ui.toast': 0.2,
};
const RATE_DEFAULT = 0.028;

const STATE_THREAT = {
  idle: 0,
  calm: 0,
  asleep: 0,
  patrol: 0.16,
  patrolling: 0.16,
  walking: 0.2,
  suspicious: 0.42,
  alert: 0.58,
  searching: 0.78,
  hunting: 0.85,
  spotted: 1,
  catching: 1,
  caught: 1,
};

// The rug and the play mat, from CONTRACTS §2. Used to pick footstep/hand-pat timbres.
const RUG = { x0: -1.4, x1: 3.2, z0: -3.8, z1: 0.2 };
const MAT = { x0: -1.4, x1: 1.4, z0: 0.7, z1: 3.3 };
const DOOR_Z = 3.22;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();

function readSettings() {
  const out = { master: 0.85, music: 0.7, sfx: 1, ambience: 0.8, ui: 0.7, muted: false };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) Object.assign(out, JSON.parse(raw));
    for (const b of BUS_NAMES) {
      const v = localStorage.getItem(`${STORE_KEY}.${b}`);
      if (v !== null && v !== '') out[b] = parseFloat(v);
    }
    const m = localStorage.getItem(`${STORE_KEY}.master`);
    if (m !== null && m !== '') out.master = parseFloat(m);
    const mute = localStorage.getItem(`${STORE_KEY}.muted`) ?? localStorage.getItem('on.muted');
    if (mute !== null) out.muted = mute === 'true' || mute === '1';
  } catch {
    /* private mode, or a corrupt blob — the defaults are fine */
  }
  for (const k of ['master', ...BUS_NAMES]) {
    if (!Number.isFinite(out[k])) out[k] = 0.8;
    out[k] = clamp(out[k], 0, 1);
  }
  return out;
}

function writeSettings(s) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* nothing we can do, and nothing that should break the game */
  }
}

function surfaceAt(x, z) {
  if (x >= MAT.x0 && x <= MAT.x1 && z >= MAT.z0 && z <= MAT.z1) return 'mat';
  if (x >= RUG.x0 && x <= RUG.x1 && z >= RUG.z0 && z <= RUG.z1) return 'rug';
  return 'wood';
}

/** Best guess at what a prop is made of, without reaching into another module's internals. */
function guessCategory(prop) {
  if (!prop) return 'generic';
  const hay = `${prop.id || ''} ${prop.labelKey || ''} ${prop.material || ''} ${prop.object3d?.name || ''}`.toLowerCase();
  const table = [
    ['vase', 'ceramic'], ['mug', 'ceramic'], ['pot', 'ceramic'], ['bowl', 'ceramic'], ['plate', 'ceramic'],
    ['glass', 'glass'], ['bulb', 'glass'], ['window', 'glass'], ['pendant', 'glass'],
    ['snack', 'foil'], ['crisp', 'foil'], ['bag', 'foil'], ['foil', 'foil'],
    ['book', 'paper'], ['magazine', 'paper'], ['paper', 'paper'], ['art', 'canvas'],
    ['vinyl', 'vinyl'], ['record', 'vinyl'],
    ['speaker', 'wood'], ['ukulele', 'wood'], ['shelf', 'wood'], ['ply', 'wood'], ['wood', 'wood'],
    ['plush', 'plush'], ['teddy', 'plush'], ['bunny', 'plush'], ['giraffe', 'plush'], ['elephant', 'plush'],
    ['cushion', 'fabric'], ['blanket', 'fabric'], ['muslin', 'fabric'], ['curtain', 'fabric'], ['sofa', 'fabric'],
    ['plant', 'leaf'], ['monstera', 'leaf'], ['leaf', 'leaf'], ['soil', 'soil'],
    ['radiator', 'metal'], ['espresso', 'metal'], ['lamp', 'metal'], ['chrome', 'metal'], ['metal', 'metal'],
    ['marble', 'stone'], ['stone', 'stone'], ['concrete', 'stone'],
    ['laptop', 'plastic'], ['toy', 'plastic'], ['ring', 'plastic'], ['cup', 'plastic'], ['rattle', 'plastic'],
    ['box', 'card'], ['rattan', 'wicker'], ['basket', 'wicker'],
    ['teether', 'rubber'], ['silicone', 'rubber'],
  ];
  for (let i = 0; i < table.length; i++) if (hay.includes(table[i][0])) return table[i][1];
  return 'generic';
}

export function createAudio(ctx) {
  const photo = ctx.state?.mode === 'photo';

  // Photo mode never synthesises anything: no context, no listeners, no timers, zero cost.
  if (photo) {
    return {
      unlock() {},
      update() {},
      play() {
        return null;
      },
      setMasterVolume() {},
      setBusVolume() {},
      setMuted() {},
      setListener() {},
      duck() {},
      reset() {},
      dispose() {},
      get ready() {
        return false;
      },
    };
  }

  const events = ctx.events;
  const settings = readSettings();
  const tier = ctx.quality?.tier || 'high';
  const cap = VOICE_CAP[tier] || 20;
  const defaultVariants = VARIANTS[tier] || 3;
  const useConvolver = tier !== 'low';
  const hrtf = tier === 'high' || tier === 'ultra';

  // Two independent seeded streams: one for rendering buffers (so the pools are byte-identical
  // every run) and one for per-play jitter.
  const bufRng = ctx.makeRng ? ctx.makeRng(0x0a0d10) : Math.random;
  const playRng = ctx.makeRng ? ctx.makeRng(0x5eaf00d) : Math.random;

  let ac = null;
  let ready = false;
  let disposed = false;

  let master;
  let comp;
  let limiter;
  const buses = {};
  let musicDuck;
  let ambDuck;
  let roomConv = null;
  let hallConv = null;
  let roomReturn = null;
  let hallReturn = null;
  let sfxRoomIn = null;
  let sfxHallIn = null;
  let ambRoomIn = null;
  let ambHallIn = null;
  let musicRoomSend = null;

  const pools = new Map();
  const warm = [];
  let warmCursor = 0;
  const voices = [];
  const lastPlay = new Map();
  const recentKeys = new Map();
  let score = null;
  let ambience = null;
  const missing = new Set();

  let duckUntil = 0;

  // gameplay state the audio drives itself from
  let threat = 0;
  let threatTarget = 0;
  let chaos = 0;
  let parentState = 'idle';
  let seesLevel = 0;
  let crawlSpeed = 0;
  let crawlSurface = null;
  let crawlSince = 0;
  let crawlPhase = 0;
  let crawlLimb = 0;
  let babyIdleIn = 5;
  let parentStepAcc = 0;
  let statsAcc = 0;
  const lastParentPos = new THREE.Vector3();
  let haveParentPos = false;
  const listenerPos = new THREE.Vector3(0, 0.42, 0);

  // ---------------------------------------------------------------------------------------------
  // graph
  // ---------------------------------------------------------------------------------------------

  function build() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return false;
    ac = new Ctor({ latencyHint: 'interactive' });

    limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.06;
    limiter.connect(ac.destination);

    comp = ac.createDynamicsCompressor();
    comp.threshold.value = -19;
    comp.knee.value = 14;
    comp.ratio.value = 2.8;
    comp.attack.value = 0.006;
    comp.release.value = 0.2;
    comp.connect(limiter);

    master = gainNode(ac, settings.muted ? 0.0001 : settings.master);
    master.connect(comp);

    for (const b of BUS_NAMES) buses[b] = gainNode(ac, settings[b]);
    musicDuck = gainNode(ac, 1);
    ambDuck = gainNode(ac, 1);
    musicDuck.connect(buses.music);
    ambDuck.connect(buses.ambience);
    for (const b of BUS_NAMES) buses[b].connect(master);

    if (useConvolver) {
      roomConv = ac.createConvolver();
      roomConv.normalize = true;
      roomConv.buffer = makeRoomIR(ac, bufRng);
      roomReturn = gainNode(ac, 0.85);
      roomConv.connect(roomReturn);
      roomReturn.connect(master);

      hallConv = ac.createConvolver();
      hallConv.normalize = true;
      hallConv.buffer = makeHallIR(ac, bufRng);
      const hallTone = filterNode(ac, 'lowpass', 1700, 0.7);
      hallReturn = gainNode(ac, 0.8);
      hallConv.connect(hallTone);
      hallTone.connect(hallReturn);
      hallReturn.connect(master);

      // Per-bus send collectors, so muting a bus also mutes its reverb tail.
      sfxRoomIn = gainNode(ac, settings.sfx);
      sfxHallIn = gainNode(ac, settings.sfx);
      ambRoomIn = gainNode(ac, settings.ambience);
      ambHallIn = gainNode(ac, settings.ambience);
      sfxRoomIn.connect(roomConv);
      sfxHallIn.connect(hallConv);
      ambRoomIn.connect(roomConv);
      ambHallIn.connect(hallConv);

      musicRoomSend = gainNode(ac, 0.22);
      buses.music.connect(musicRoomSend);
      musicRoomSend.connect(roomConv);
    }

    // Warm-up queue, cheapest and most-used first.
    const keys = Object.keys(BUFFERS).sort((a, b) => (BUFFERS[a].pri || 5) - (BUFFERS[b].pri || 5));
    for (const k of keys) {
      const want = Math.min(BUFFERS[k].variants || defaultVariants, defaultVariants + 1);
      warm.push({ key: k, want: Math.max(1, want) });
    }

    score = createScore({ ac, r: playRng, out: musicDuck, quality: ctx.quality });
    ambience = createAmbience({
      ac,
      r: playRng,
      out: ambDuck,
      quality: ctx.quality,
      buf,
      makePanner,
      play,
      roomSend: ambRoomIn,
      hallSend: ambHallIn,
    });
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // buffer pools
  // ---------------------------------------------------------------------------------------------

  function buildVariant(key) {
    const spec = BUFFERS[key];
    if (!spec) return null;
    let pool = pools.get(key);
    if (!pool) {
      pool = [];
      pools.set(key, pool);
    }
    const b = makeBuffer(ac, spec.seconds);
    try {
      spec.build(b.getChannelData(0), ac.sampleRate, bufRng, pool.length);
    } catch (err) {
      console.error(`[audio] failed to render buffer "${key}"`, err);
    }
    pool.push(b);
    return b;
  }

  function buf(key) {
    let pool = pools.get(key);
    if (!pool || pool.length === 0) return buildVariant(key);
    if (pool.length === 1) return pool[0];
    return pool[Math.floor(playRng() * pool.length) % pool.length];
  }

  function warmup(budgetMs) {
    if (warmCursor >= warm.length) return;
    const t0 = performance.now();
    while (warmCursor < warm.length && performance.now() - t0 < budgetMs) {
      const job = warm[warmCursor];
      const pool = pools.get(job.key);
      if (!pool || pool.length < job.want) buildVariant(job.key);
      else warmCursor++;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // spatialisation
  // ---------------------------------------------------------------------------------------------

  function toVec(p, out) {
    if (!p) return null;
    if (Array.isArray(p)) return out.set(p[0] || 0, p[1] || 0, p[2] || 0);
    if (p.isVector3 || (typeof p.x === 'number' && typeof p.z === 'number')) {
      return out.set(p.x, p.y || 0, p.z);
    }
    return null;
  }

  function setPannerPos(p, v) {
    if (p.positionX) {
      p.positionX.value = v.x;
      p.positionY.value = v.y;
      p.positionZ.value = v.z;
    } else if (p.setPosition) {
      p.setPosition(v.x, v.y, v.z);
    }
  }

  function makePanner(pos, o = {}) {
    const p = ac.createPanner();
    p.panningModel = hrtf ? 'HRTF' : 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = o.ref === undefined ? 0.8 : o.ref;
    p.rolloffFactor = o.rolloff === undefined ? 1.15 : o.rolloff;
    p.maxDistance = o.max === undefined ? 30 : o.max;
    const v = toVec(pos, _v) || _v.set(0, 0.5, 0);
    setPannerPos(p, v);
    return p;
  }

  function setListener(pos, quat) {
    if (!ready) return;
    const L = ac.listener;
    const p = toVec(pos, _v);
    if (p) {
      listenerPos.copy(p);
      if (L.positionX) {
        L.positionX.value = p.x;
        L.positionY.value = p.y;
        L.positionZ.value = p.z;
      } else if (L.setPosition) {
        L.setPosition(p.x, p.y, p.z);
      }
    }
    if (quat) {
      _q.set(quat.x || 0, quat.y || 0, quat.z || 0, quat.w === undefined ? 1 : quat.w);
      _fwd.set(0, 0, -1).applyQuaternion(_q);
      _up.set(0, 1, 0).applyQuaternion(_q);
      if (L.forwardX) {
        L.forwardX.value = _fwd.x;
        L.forwardY.value = _fwd.y;
        L.forwardZ.value = _fwd.z;
        L.upX.value = _up.x;
        L.upY.value = _up.y;
        L.upZ.value = _up.z;
      } else if (L.setOrientation) {
        L.setOrientation(_fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // voices
  // ---------------------------------------------------------------------------------------------

  function freeVoice(v) {
    const i = voices.indexOf(v);
    if (i >= 0) voices.splice(i, 1);
    if (v.timer) clearTimeout(v.timer);
    for (let k = 0; k < v.nodes.length; k++) {
      try {
        v.nodes[k].disconnect();
      } catch {
        /* already gone */
      }
    }
    v.nodes.length = 0;
  }

  function steal() {
    let worst = null;
    let worstScore = Infinity;
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      const s = v.level * v.priority;
      if (s < worstScore) {
        worstScore = s;
        worst = v;
      }
    }
    if (!worst) return;
    const t = ac.currentTime;
    try {
      worst.input.gain.cancelScheduledValues(t);
      worst.input.gain.setTargetAtTime(0.0001, t, 0.01);
    } catch {
      /* whatever it was, it is going away */
    }
    const v = worst;
    if (v.timer) clearTimeout(v.timer);
    v.timer = setTimeout(() => freeVoice(v), 60);
    v.level = -1;
  }

  function play(name, opts = {}) {
    if (!ready || disposed || settings.muted) return null;
    const gen = SOUNDS[name];
    if (!gen) {
      if (!missing.has(name)) {
        missing.add(name);
        console.warn(`[audio] unknown sound "${name}"`);
      }
      return null;
    }

    const now = ac.currentTime;
    const limit = RATE[name] === undefined ? RATE_DEFAULT : RATE[name];
    const last = lastPlay.get(name);
    if (last !== undefined && now - last < limit) return null;

    const pos = toVec(opts.position, _s);
    const dist = pos ? pos.distanceTo(listenerPos) : 0;
    if (dist > 28) return null;

    const priority = opts.priority === undefined ? 1 : opts.priority;
    const gain = opts.gain === undefined ? 1 : opts.gain;
    const level = (gain * priority) / (1 + dist * 0.55);
    if (level < 0.004) return null;

    if (voices.length >= cap) {
      // Only steal for something that actually matters more than the quietest thing playing.
      let quietest = Infinity;
      for (let i = 0; i < voices.length; i++) quietest = Math.min(quietest, voices[i].level * voices[i].priority);
      if (level * priority <= quietest) return null;
      steal();
    }
    lastPlay.set(name, now);

    const bus = buses[opts.bus] ? opts.bus : name.startsWith('ui.') ? 'ui' : 'sfx';
    const nodes = [];
    const input = gainNode(ac, gain);
    nodes.push(input);

    // Through the doorway: dull it, and swap the reverb send for the hallway one.
    const through = opts.hallway === true || (opts.hallway !== false && pos && pos.z > DOOR_Z);
    let node = input;
    if (through) {
      const lp = filterNode(ac, 'lowpass', 620, 0.8);
      const lp2 = filterNode(ac, 'lowpass', 1500, 0.6);
      node.connect(lp);
      lp.connect(lp2);
      nodes.push(lp, lp2);
      node = lp2;
    }
    const tap = gainNode(ac, through ? 0.62 : 1);
    node.connect(tap);
    nodes.push(tap);

    if (pos) {
      const panner = makePanner(pos, opts.panner);
      tap.connect(panner);
      panner.connect(buses[bus]);
      nodes.push(panner);
    } else {
      tap.connect(buses[bus]);
    }

    if (useConvolver && opts.dry !== true) {
      const roomIn = bus === 'ambience' ? ambRoomIn : sfxRoomIn;
      const hallIn = bus === 'ambience' ? ambHallIn : sfxHallIn;
      // Far things are wetter: the direct sound falls off, the reverberant field does not.
      const wet = clamp(0.16 + 0.5 * smoothstep(0.4, 6, dist), 0, 0.7);
      if (through) {
        const hs = gainNode(ac, wet * 1.9 + 0.25);
        tap.connect(hs);
        hs.connect(hallIn);
        const rs = gainNode(ac, wet * 0.3);
        tap.connect(rs);
        rs.connect(roomIn);
        nodes.push(hs, rs);
      } else {
        const rs = gainNode(ac, wet * (opts.wet === undefined ? 1 : opts.wet));
        tap.connect(rs);
        rs.connect(roomIn);
        nodes.push(rs);
      }
    }

    const A = {
      ac,
      t: now + 0.004,
      sr: ac.sampleRate,
      r: playRng,
      dest: input,
      buf,
      quality: ctx.quality,
    };

    let dur = 0.4;
    try {
      const d = gen(A, opts);
      if (Number.isFinite(d) && d > 0) dur = d;
    } catch (err) {
      console.error(`[audio] "${name}" threw while building`, err);
    }

    const voice = { name, nodes, input, level, priority, end: now + dur, timer: null };
    voices.push(voice);
    voice.timer = setTimeout(() => freeVoice(voice), (dur + 0.35) * 1000);
    return voice;
  }

  // ---------------------------------------------------------------------------------------------
  // helpers used by the event wiring
  // ---------------------------------------------------------------------------------------------

  function fired(key, window_) {
    const now = ac ? ac.currentTime : 0;
    const last = recentKeys.get(key);
    if (last !== undefined && now - last < window_) return true;
    recentKeys.set(key, now);
    return false;
  }

  function duck(amount = 0.35, ms = 600) {
    if (!ready) return;
    const t = ac.currentTime;
    const depth = clamp(1 - amount, 0.05, 1);
    const until = t + ms / 1000;
    duckUntil = Math.max(duckUntil, until);
    musicDuck.gain.cancelScheduledValues(t);
    musicDuck.gain.setTargetAtTime(depth, t, 0.015);
    musicDuck.gain.setTargetAtTime(1, duckUntil, Math.max(0.08, ms / 3200));
    ambDuck.gain.cancelScheduledValues(t);
    ambDuck.gain.setTargetAtTime(clamp(1 - amount * 0.55, 0.2, 1), t, 0.02);
    ambDuck.gain.setTargetAtTime(1, duckUntil, Math.max(0.1, ms / 2600));
  }

  function playImpact(category, o = {}) {
    const name = MATERIAL_SOUND[category] || 'impact.thud';
    return play(name, o);
  }

  function propPosition(prop, fallback) {
    if (fallback) return fallback;
    if (prop?.object3d) return prop.object3d.getWorldPosition(new THREE.Vector3());
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // events
  // ---------------------------------------------------------------------------------------------

  const off = [];
  const on = (name, fn) => off.push(events.on(name, fn));

  on('prop:toppled', (e) => {
    if (!ready || !e?.prop) return;
    const prop = e.prop;
    if (prop.fragile) return; // prop:shattered handles it, and does it better
    const pos = propPosition(prop, e.position);
    const cat = guessCategory(prop);
    const intensity = clamp(0.35 + (e.impulse || 1) * 0.35 + (prop.noise || 0.3) * 0.4, 0.15, 1);
    const damped = pos ? surfaceAt(pos.x, pos.z) !== 'wood' : false;
    playImpact(cat, { position: pos, intensity, damped, gain: 0.7 + (prop.noise || 0.3) * 0.5, priority: 1.6 });
    recentKeys.set(`prop:${prop.id}`, ac.currentTime);
    if ((prop.noise || 0) > 0.55) duck(0.22, 420);
    // A crash is funny. The baby thinks so too.
    if ((prop.points || 0) >= 150 && playRng() < 0.55) {
      setTimeout(() => play('baby.giggle', { position: babyPos(), gain: 0.75, priority: 1.2 }), 260 + playRng() * 260);
    }
  });

  on('prop:shattered', (e) => {
    if (!ready) return;
    const prop = e?.prop;
    const pos = propPosition(prop, e?.position);
    const key = pos ? `shatter:${Math.round(pos.x * 3)}:${Math.round(pos.z * 3)}` : 'shatter';
    if (fired(key, 0.25)) return;
    const cat = guessCategory(prop);
    const isPlant = /plant|monstera|pot/.test(`${prop?.id || ''}${prop?.labelKey || ''}`);
    if (isPlant) play('world.plantCrash', { position: pos, gain: 1, priority: 3 });
    else if (cat === 'glass') play('impact.glass.shatter', { position: pos, gain: 1, priority: 3 });
    else play('impact.ceramic.shatter', { position: pos, gain: 1, priority: 3 });
    if (prop) recentKeys.set(`prop:${prop.id}`, ac.currentTime);
    duck(0.42, 900);
    setTimeout(() => play('baby.squeal', { position: babyPos(), gain: 0.85, priority: 1.6 }), 380 + playRng() * 300);
  });

  on('prop:eaten', (e) => {
    if (!ready) return;
    const prop = e?.prop;
    const pos = propPosition(prop, e?.position) || babyPos();
    if (guessCategory(prop) === 'foil') play('impact.foil.crinkle', { position: pos, gain: 0.8, intensity: 0.7 });
    const reaction = e?.reaction || prop?.reaction || 'yum';
    const map = { yum: 'baby.yum', gross: 'baby.gross', spicy: 'baby.spicy', dangerous: 'baby.dangerous' };
    play(map[reaction] || 'baby.yum', { position: pos, gain: 0.95, priority: 2 });
  });

  on('prop:pulled', (e) => {
    if (!ready) return;
    const pos = propPosition(e?.prop, e?.position);
    const cat = guessCategory(e?.prop);
    const name = cat === 'paper' || cat === 'canvas' ? 'impact.paper.rustle' : 'impact.cloth';
    play(name, { position: pos, gain: 0.7, intensity: 0.55, priority: 0.9 });
  });

  // The AI's hearing channel. If nothing already made a sound for this source, make one now, so a
  // module that emits `noise` without a topple is never silent.
  on('noise', (e) => {
    if (!ready || !e) return;
    const loud = clamp(e.loudness === undefined ? 0.4 : e.loudness, 0, 1);
    if (loud > 0.62) duck(0.2 + loud * 0.2, 400 + loud * 400);
    if (e.source && recentKeys.has(`prop:${e.source}`)) {
      if (ac.currentTime - recentKeys.get(`prop:${e.source}`) < 0.25) return;
    }
    if (fired(`noise:${e.source || 'x'}`, 0.18)) return;
    if (loud < 0.18) return;
    const pos = toVec(e.position, new THREE.Vector3());
    playImpact('generic', {
      position: pos,
      intensity: loud,
      gain: 0.55 + loud * 0.45,
      damped: pos ? surfaceAt(pos.x, pos.z) !== 'wood' : false,
      priority: 1.1,
    });
  });

  on('fx:impact', (e) => {
    if (!ready || !e) return;
    const pos = toVec(e.position, new THREE.Vector3());
    const key = pos ? `fx:${Math.round(pos.x * 3)}:${Math.round(pos.z * 3)}` : 'fx';
    if (fired(key, 0.2)) return;
    const cat = e.material || 'generic';
    const force = clamp(e.force === undefined ? 0.6 : e.force, 0.05, 1);
    if (force >= 0.95 && (cat === 'ceramic' || cat === 'glass' || cat === 'stone')) {
      play(cat === 'glass' ? 'impact.glass.shatter' : 'impact.ceramic.shatter', { position: pos, gain: 1, priority: 3 });
      duck(0.4, 850);
      return;
    }
    playImpact(cat, {
      position: pos,
      intensity: force,
      damped: pos ? surfaceAt(pos.x, pos.z) !== 'wood' : false,
      gain: 0.7,
      priority: 1,
    });
  });

  on('baby:crawl', (e) => {
    crawlSpeed = clamp(e?.speed === undefined ? 0.5 : e.speed, 0, 3);
    crawlSurface = e?.surface || null;
    crawlSince = 0;
  });

  on('baby:bump', (e) => {
    if (!ready) return;
    const f = clamp(e?.force === undefined ? 0.5 : e.force, 0.05, 1);
    play('baby.bonk', { position: toVec(e?.position, new THREE.Vector3()) || babyPos(), gain: 0.5 + f * 0.5, intensity: f, priority: 1.5 });
  });

  on('parent:state', (e) => {
    if (!e) return;
    const to = e.to || e.state || 'idle';
    parentState = to;
    threatTarget = Math.max(STATE_THREAT[to] === undefined ? 0.3 : STATE_THREAT[to], seesLevel * 0.9);
    if (!ready) return;
    const p = parentPos();
    if (to === 'suspicious') play('parent.cloth', { position: p, gain: 0.5, priority: 1 });
    if (to === 'spotted') {
      score.stab();
      duck(0.15, 1400);
      play('baby.gasp', { position: babyPos(), gain: 1, priority: 3 });
    }
    if (to === 'catching') {
      play('parent.cloth', { position: p, gain: 0.9, priority: 2 });
      play('parent.lift', { position: babyPos(), gain: 0.9, priority: 3 });
    }
    if (to === 'idle' && e.from && e.from !== 'idle') play('parent.sigh', { position: p, gain: 0.6, priority: 1 });
  });

  on('parent:sees', (e) => {
    seesLevel = clamp(e?.level === undefined ? 0 : e.level, 0, 1);
    threatTarget = Math.max(STATE_THREAT[parentState] === undefined ? 0 : STATE_THREAT[parentState], seesLevel * 0.9);
  });

  on('parent:bark', (e) => {
    if (!ready) return;
    const p = toVec(e?.position, new THREE.Vector3()) || parentPos();
    play('parent.bark', { position: p, gain: 0.85, priority: 2.5 });
    duck(0.25, 900);
  });

  on('parent:sit', () => play('parent.sofaCreak', { position: parentPos(), gain: 0.8, priority: 1.2 }));

  on('score', (e) => {
    if (!ready) return;
    play('ui.score', { combo: e?.combo || 1, gain: 0.8, bus: 'ui', priority: 0.8, dry: true });
  });

  on('combo', (e) => {
    if (!ready) return;
    if ((e?.count || 0) < 2) return;
    play('ui.combo', { combo: e.count, gain: 0.8, bus: 'ui', priority: 1, dry: true });
  });

  on('ui:toast', () => play('ui.toast', { gain: 0.7, bus: 'ui', dry: true, priority: 0.6 }));
  on('ui:tick', () => play('ui.tick', { gain: 0.7, bus: 'ui', dry: true, priority: 0.5 }));
  on('ui:confirm', () => play('ui.confirm', { gain: 0.8, bus: 'ui', dry: true, priority: 0.7 }));
  on('ui:back', () => play('ui.back', { gain: 0.7, bus: 'ui', dry: true, priority: 0.6 }));

  on('game:start', () => {
    chaos = 0;
    threat = 0;
    threatTarget = 0;
    babyIdleIn = 4 + playRng() * 4;
    if (ready) score.start();
  });

  on('game:over', (e) => {
    if (!ready) return;
    const caught = (e?.reason || 'timeup') === 'caught';
    score.setIntensity(0, 0);
    score.stop(0.5);
    setTimeout(() => score.cadence(caught ? 'caught' : 'timeup'), 420);
    if (caught) setTimeout(() => play('parent.sigh', { position: parentPos(), gain: 0.8, priority: 3 }), 900);
    ambience?.setActive(false);
  });

  on('audio:settings', (e) => {
    if (!e) return;
    for (const k of ['master', ...BUS_NAMES]) if (Number.isFinite(e[k])) applyVolume(k, e[k]);
    if (typeof e.muted === 'boolean') api.setMuted(e.muted);
  });

  // ---------------------------------------------------------------------------------------------
  // positions of things we do not own
  // ---------------------------------------------------------------------------------------------

  const _baby = new THREE.Vector3(0, 0.2, 1.6);
  function babyPos() {
    const b = ctx.baby;
    const src = b?.head || b?.group || b;
    if (src?.getWorldPosition) src.getWorldPosition(_baby);
    else if (src?.position) _baby.copy(src.position);
    else if (ctx.camera) _baby.copy(ctx.camera.position);
    return _baby;
  }

  const _parent = new THREE.Vector3(1.9, 0.9, 3.6);
  function parentPos() {
    const p = ctx.parent;
    const src = p?.group || p;
    if (src?.getWorldPosition) src.getWorldPosition(_parent);
    else if (src?.position) _parent.copy(src.position);
    return _parent;
  }

  // ---------------------------------------------------------------------------------------------
  // per-frame
  // ---------------------------------------------------------------------------------------------

  function updateCrawl(dt) {
    crawlSince += dt;
    if (crawlSince > 0.3) crawlSpeed *= Math.max(0, 1 - dt * 6);
    if (crawlSpeed < 0.04) {
      crawlPhase = Math.min(crawlPhase, 0.8);
      return;
    }
    // ~0.30 m per limb placement for a 10-month-old; hands and knees alternate.
    crawlPhase += (crawlSpeed * dt) / 0.3;
    while (crawlPhase >= 1) {
      crawlPhase -= 1;
      crawlLimb ^= 1;
      const p = babyPos();
      const surf = crawlSurface || surfaceAt(p.x, p.z);
      const name = surf === 'wood' ? 'baby.pat.wood' : surf === 'mat' ? 'baby.pat.mat' : 'baby.pat.rug';
      play(name, {
        position: p,
        gain: (crawlLimb ? 0.85 : 0.6) * clamp(0.45 + crawlSpeed * 0.5, 0.35, 1.1),
        intensity: clamp(0.3 + crawlSpeed * 0.4, 0.15, 1),
        rate: crawlLimb ? 1 : 1.09,
        priority: 0.7,
      });
    }
  }

  function updateParentSteps(dt) {
    const walking = threat > 0.12 || parentState === 'searching' || parentState === 'patrol';
    const p = parentPos();
    let moved = 0;
    if (haveParentPos) moved = p.distanceTo(lastParentPos);
    lastParentPos.copy(p);
    if (!haveParentPos) {
      haveParentPos = true;
      return;
    }
    // If the AI actually moves its transform, step on distance. Otherwise fall back to a cadence.
    if (moved > 0.0005) parentStepAcc += moved;
    else if (walking) parentStepAcc += dt * (0.55 + threat * 0.45);
    else return;

    const stride = 0.66 - threat * 0.14;
    if (parentStepAcc < stride) return;
    parentStepAcc = 0;
    const surf = surfaceAt(p.x, p.z);
    play(surf === 'wood' ? 'parent.step.wood' : 'parent.step.rug', {
      position: p,
      gain: 0.55 + threat * 0.4,
      intensity: 0.45 + threat * 0.4,
      priority: 2.2,
    });
  }

  function updateBabyIdle(dt) {
    if (ctx.state.mode !== 'playing') return;
    babyIdleIn -= dt * (threat > 0.7 ? 0.4 : 1);
    if (babyIdleIn > 0) return;
    babyIdleIn = 5 + playRng() * 9;
    const p = babyPos();
    const roll = playRng();
    const name =
      roll < 0.3 ? 'baby.babble' : roll < 0.52 ? 'baby.breath' : roll < 0.7 ? 'baby.giggle' : roll < 0.82 ? 'baby.grunt' : roll < 0.93 ? 'baby.raspberry' : 'baby.hiccup';
    play(name, { position: p, gain: name === 'baby.breath' ? 0.5 : 0.75, priority: 0.9 });
  }

  function updateCord() {
    const pens = ctx.physics?.pendulums;
    if (!ambience || !pens || pens.length === 0) return;
    let e = 0;
    for (let i = 0; i < pens.length; i++) {
      const b = pens[i]?.body;
      if (!b || typeof b.linvel !== 'function') continue;
      const v = b.linvel();
      e = Math.max(e, Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z));
    }
    ambience.cordEnergy = clamp(e / 1.2, 0, 1);
  }

  function applyVolume(which, value) {
    const v = clamp(value, 0, 1);
    settings[which] = v;
    if (ready) {
      const t = ac.currentTime;
      if (which === 'master') {
        if (!settings.muted) master.gain.setTargetAtTime(v, t, 0.05);
      } else if (buses[which]) {
        buses[which].gain.setTargetAtTime(v, t, 0.05);
        if (which === 'sfx' && sfxRoomIn) {
          sfxRoomIn.gain.setTargetAtTime(v, t, 0.05);
          sfxHallIn.gain.setTargetAtTime(v, t, 0.05);
        }
        if (which === 'ambience' && ambRoomIn) {
          ambRoomIn.gain.setTargetAtTime(v, t, 0.05);
          ambHallIn.gain.setTargetAtTime(v, t, 0.05);
        }
      }
    }
    writeSettings(settings);
  }

  // ---------------------------------------------------------------------------------------------
  // public API
  // ---------------------------------------------------------------------------------------------

  let gestureHooks = null;

  function unlock() {
    if (disposed) return;
    if (!ac) {
      if (!build()) return;
    }
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    if (!ready) {
      ready = true;
      // Prime the two or three sounds most likely to be needed in the first 200 ms.
      buf('patRug');
      buf('thud');
      const mode = ctx.state?.mode;
      score.start();
      score.setIntensity(0, 0);
      if (mode === 'menu' || mode === 'playing') ambience.setActive(true);
    }
    if (gestureHooks) {
      gestureHooks();
      gestureHooks = null;
    }
  }

  // Never construct the context before a gesture — Chrome warns, and it is rude besides.
  const onGesture = () => unlock();
  window.addEventListener('pointerdown', onGesture, { passive: true });
  window.addEventListener('keydown', onGesture, { passive: true });
  window.addEventListener('touchstart', onGesture, { passive: true });
  gestureHooks = () => {
    window.removeEventListener('pointerdown', onGesture);
    window.removeEventListener('keydown', onGesture);
    window.removeEventListener('touchstart', onGesture);
  };

  const api = {
    get ready() {
      return ready;
    },
    get context() {
      return ac;
    },
    unlock,
    play,

    setMasterVolume(v) {
      applyVolume('master', v);
    },
    setBusVolume(bus, v) {
      if (BUS_NAMES.indexOf(bus) < 0) return;
      applyVolume(bus, v);
    },
    setMuted(m) {
      settings.muted = !!m;
      writeSettings(settings);
      if (ready) master.gain.setTargetAtTime(settings.muted ? 0.0001 : settings.master, ac.currentTime, 0.04);
    },
    get muted() {
      return settings.muted;
    },
    setListener,
    duck,

    update(dt) {
      if (!ready || disposed) return;
      const d = Math.min(dt || 0, 0.05);

      // listener follows the live camera
      if (ctx.camera) {
        ctx.camera.matrixWorld.decompose(_v, _q, _s);
        setListener(_v, _q);
      }

      warmup(ctx.quality?.tier === 'low' ? 0.9 : 1.8);

      // threat / chaos smoothing → the score's two inputs
      threat += clamp(threatTarget - threat, -d * 2.2, d * 1.6);
      statsAcc += d;
      if (statsAcc > 0.25) {
        statsAcc = 0;
        const st = ctx.props?.stats?.();
        if (st) chaos = clamp(st.ratio * 1.35, 0, 1);
      }
      const mode = ctx.state?.mode;
      const playing = mode === 'playing';
      score.setIntensity(playing ? threat : 0, playing ? chaos : 0);
      if (playing && !score.running) score.start();
      score.update(d);

      if (ambience) {
        ambience.setActive(mode === 'menu' || mode === 'playing');
        ambience.update(d);
      }

      if (playing) {
        updateCrawl(d);
        updateParentSteps(d);
        updateBabyIdle(d);
        updateCord();
      }

      // reap voices whose scheduled tail has passed (the timeout is the primary path; this is a
      // safety net for when the tab was throttled and timers piled up)
      const now = ac.currentTime;
      for (let i = voices.length - 1; i >= 0; i--) {
        if (voices[i].end + 1.5 < now) freeVoice(voices[i]);
      }
      if (recentKeys.size > 256) recentKeys.clear();
    },

    reset() {
      threat = 0;
      threatTarget = 0;
      chaos = 0;
      seesLevel = 0;
      parentState = 'idle';
      crawlSpeed = 0;
      crawlPhase = 0;
      parentStepAcc = 0;
      haveParentPos = false;
      babyIdleIn = 4 + (ready ? playRng() : 0.5) * 4;
      recentKeys.clear();
      lastPlay.clear();
      if (ready) {
        for (let i = voices.length - 1; i >= 0; i--) freeVoice(voices[i]);
        score.setIntensity(0, 0);
        ambience?.setActive(true);
      }
    },

    dispose() {
      disposed = true;
      for (let i = 0; i < off.length; i++) off[i]();
      off.length = 0;
      if (gestureHooks) {
        gestureHooks();
        gestureHooks = null;
      }
      if (!ac) return;
      for (let i = voices.length - 1; i >= 0; i--) freeVoice(voices[i]);
      score?.dispose();
      ambience?.dispose();
      pools.clear();
      try {
        master.disconnect();
      } catch {
        /* gone */
      }
      ac.close().catch(() => {});
      ac = null;
      ready = false;
    },
  };

  return api;
}
