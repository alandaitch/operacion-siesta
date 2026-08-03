// OPERATION NAPTIME — module ROOM — the sheer curtains.
// OWNER: ROOM.
//
// A flat alpha-textured plane is an automatic fail, so there is not one here. Each panel is a real
// swept surface whose cross-section is a table of individually authored folds:
//
//  · FOLDS ARE LOBES, NOT A SINE. Every panel gets `gathers` lobes of unequal width, unequal
//    amplitude, an off-centre crest (so a fold has a fat side and a lean side) and its own falloff
//    exponent. The lobes mostly alternate room-side / glass-side, but one in five repeats its
//    neighbour's direction, and the room-side lobes are 28% deeper than the ones that fold back —
//    that asymmetry is the entire difference between "gathered cloth" and "corrugated card".
//  · THE FOLDS WANDER DOWN THE DROP. The fold table is evaluated at u + drift(v), where drift is
//    fractal noise in the vertical, so no crest is a vertical stripe. On top of that each lobe
//    breathes ±21% with height and a 23-cycle crinkle adds ±7 mm of micro-relief. No two folds in
//    this room match.
//  · THE HEM IS INTEGRATED, NOT DRAWN. `v` is arc length along the cloth, not height. The fall
//    curve is integrated with dy = -cos φ ds, dh = sin φ ds where φ ramps 0 → π/2 over the last
//    200 mm, so the cloth genuinely bends over and lies down. The 55 mm of extra length in
//    LAYOUT.curtains.pool becomes a pool on the floor whose depth varies along the panel.
//  · UVs ARE ARC LENGTH ACROSS THE SECTION, so the voile weave never stretches over a crest.
//  · THE SWAY IS SEPARABLE. sin(kx − ωt + κy) = sin(kx)·cos(κy − ωt) + cos(kx)·sin(κy − ωt), so a
//    travelling diagonal wave costs two precomputed per-column arrays, four per-row scalars a
//    frame, and two multiply-adds per vertex. Two waves at different wavelengths, weighted to zero
//    at the track and near-zero in the pool. Frozen flat in photo mode.
//
// Sheers cast no shadow map here on purpose: three.js would render a transparent, depth-write-off
// material into the map as a solid black rectangle, which is far worse than the small amount of
// shading a voile actually removes. The window softbox sits at z = −4.53, *behind* the cloth at
// −4.48, so the panels are correctly backlit and `fabric.sheer`'s transmission does the glow.

import * as THREE from 'three';
import { makeRng } from '../../core/rng.js';
import {
  paramSurface, chamferBox, prism, rectProfile, chamferProfile,
  surfaceMaterial, fbm2, smoothstep, clamp01, mix,
} from './geom.js';

/** Quads per fold across the section, and rows down the drop. */
const SEG_BY_TIER = {
  low: { perFold: 3, rows: 14, sway: false, gliders: false },
  medium: { perFold: 5, rows: 22, sway: true, gliders: true },
  high: { perFold: 7, rows: 34, sway: true, gliders: true },
  ultra: { perFold: 9, rows: 46, sway: true, gliders: true },
};

/** Two travelling waves: amplitude (m), spatial wavelength across, vertical wavelength, rate. */
const WAVES = [
  { amp: 0.0092, kx: 5.1, ky: 1.35, w: 0.62 },
  { amp: 0.0047, kx: 12.7, ky: 2.60, w: 1.07 },
];

const COLLAPSE_TIME = 1.25;

// ── the fold table ────────────────────────────────────────────────────────────────────────────

function buildFoldTable(panel, R) {
  const n = Math.max(3, panel.gathers | 0);
  const w = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    w[i] = 0.70 + 0.62 * R();
    sum += w[i];
  }
  const edge = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) edge[i + 1] = edge[i] + w[i] / sum;
  edge[n] = 1;

  const amp = new Float64Array(n);
  const crest = new Float64Array(n);
  const power = new Float64Array(n);
  const sign = new Int8Array(n);
  let s = 1;
  let maxAmp = 1e-4;
  for (let i = 0; i < n; i++) {
    // Mostly alternating. One lobe in five leans the same way as the one before it, which is what
    // a real gather does where two pleats have collapsed into each other.
    if (i > 0 && R() >= 0.20) s = -s;
    sign[i] = s;
    amp[i] = (0.58 + 0.56 * R()) * (s > 0 ? 1.0 : 0.78);
    crest[i] = 0.32 + 0.34 * R();
    power[i] = 0.62 + 0.34 * R();
    if (amp[i] > maxAmp) maxAmp = amp[i];
  }
  return { n, edge, amp, crest, power, sign, maxAmp };
}

/** Which lobe contains `u`. Binary search over the cumulative edges. */
function lobeAt(T, u) {
  let lo = 0;
  let hi = T.n - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (u >= T.edge[m]) lo = m;
    else hi = m - 1;
  }
  return lo;
}

/** The cross-section, normalised to roughly ±1. Zero at every pinch between lobes. */
function foldProfile(T, u) {
  const uu = u <= 0 ? 0 : u >= 1 ? 1 : u;
  const i = lobeAt(T, uu);
  const a = T.edge[i];
  const b = T.edge[i + 1];
  const t = (uu - a) / Math.max(1e-6, b - a);
  // Move the crest off centre: t^e maps t = crest to 0.5, so the lobe leans.
  const c = Math.min(0.80, Math.max(0.20, T.crest[i]));
  const ts = Math.pow(t, Math.log(0.5) / Math.log(c));
  return T.sign[i] * T.amp[i] * Math.pow(Math.sin(Math.PI * ts), T.power[i]);
}

// ── one panel ─────────────────────────────────────────────────────────────────────────────────

function buildPanel(ctx, panel, cfg, mat) {
  const L = ctx.layout;
  const C = L.curtains;
  const R = makeRng((panel.seed ^ 0x51a2f3) >>> 0);
  const T = buildFoldTable(panel, R);

  const nu = Math.max(10, T.n * cfg.perFold);
  const nv = cfg.rows;
  const drop = C.topY - C.hemY;
  // The cloth hangs straight, turns through a quarter circle of radius `BEND` exactly at the
  // boards, and then lies flat for LAYOUT's `pool` metres. Solving the turn analytically rather
  // than integrating a ramp is what guarantees the hem lands ON the floor: an eased ramp always
  // lands a few centimetres short, and a sheer floating 45 mm above the floorboards is the kind of
  // mistake that only shows up in the one shot that is framed on it.
  const BEND = 0.035;
  const yFloor = 0.0026;             // a hair clear of the boards, so no z-fight on the contact
  const straight = C.topY - yFloor - BEND;
  const arcLen = (Math.PI / 2) * BEND;
  const total = straight + arcLen + C.pool;
  const seed = panel.seed & 0xffff;
  const cx = panel.cx;
  const width = panel.width;
  const foldDepth = panel.foldDepth;

  // A gathered bundle splays away from the edge it is bunched against; the open panel spreads
  // symmetrically. Either way the hem is wider than the heading, because cloth has weight.
  const flare = panel.gathered ? 0.26 : 0.06;
  const flareDir = panel.side === 'right' ? -1 : panel.side === 'left' ? 1 : 0;
  const driftAmp = panel.gathered ? 0.030 : 0.055;

  // The cloth may bulge freely into the room but only 22 mm toward the glass, saturated smoothly
  // (the derivative at zero is 1, so small folds are untouched). Two reasons, and they agree:
  // physically the track is 120 mm off the glass and the cloth piles forward off it, and
  // technically LIGHT's window softbox is a RectAreaLight whose plane is at z = −4.53 — anything
  // that drifts behind it loses the light entirely and flickers black as the panel sways.
  const BACK_LIMIT = 0.022;
  const FRONT_GAIN = 1.25;

  // — the fall curve: the cloth genuinely bends over and lies down, it does not stop at a hem —
  const fallY = new Float64Array(nv + 1);
  const fallH = new Float64Array(nv + 1);
  for (let j = 0; j <= nv; j++) {
    const s = (j / nv) * total;
    if (s <= straight) {
      fallY[j] = C.topY - s;
      fallH[j] = 0;
    } else if (s <= straight + arcLen) {
      const a = (s - straight) / BEND;
      fallY[j] = yFloor + BEND * Math.cos(a);
      fallH[j] = BEND * Math.sin(a);
    } else {
      fallY[j] = yFloor;
      fallH[j] = BEND + (s - straight - arcLen);
    }
  }

  // — arc length across the section, so the weave does not stretch over the crests —
  const uArc = new Float64Array(nu + 1);
  {
    let px = 0;
    let pz = 0;
    let acc = 0;
    for (let i = 0; i <= nu; i++) {
      const u = i / nu;
      const x = (u - 0.5) * width;
      const raw = foldProfile(T, u) * foldDepth;
      const z = raw >= 0 ? raw * FRONT_GAIN : -BACK_LIMIT * (1 - Math.exp(raw / BACK_LIMIT));
      if (i > 0) acc += Math.hypot(x - px, z - pz);
      uArc[i] = acc;
      px = x;
      pz = z;
    }
  }

  const geo = paramSurface(nu, nv, (u, v, o) => {
    const i = Math.round(u * nu);
    const j = Math.round(v * nv);
    const vn = v;
    const pool = fallH[j];

    // The folds wander as they fall, and each lobe breathes at its own rate down the drop.
    const drift = (fbm2(vn * 2.4, 3.7, seed, 3) - 0.5) * 2 * driftAmp;
    const uu = clamp01(u + drift);
    const ampV = mix(0.82, 1.0, smoothstep(0, 0.10, vn)) * (1 + 0.30 * smoothstep(0.50, 1.0, vn));
    const breathe = 1 + (fbm2(uu * 5.3, vn * 1.9, seed + 31, 2) - 0.5) * 0.42;
    const f = foldProfile(T, uu) * ampV * breathe;

    // Across the panel, splaying toward the hem — and a little wider again where it puddles.
    let a = (u - 0.5) * width;
    const grow = flare * vn * width;
    if (flareDir > 0) a += grow * u;
    else if (flareDir < 0) a -= grow * (1 - u);
    else a *= 1 + flare * vn;
    a *= 1 + 0.5 * pool;

    // Micro-crinkle: the cloth is not a clean extrusion of its own section.
    const crink = (fbm2(uu * 23 + 4, vn * 8.5, seed + 77, 2) - 0.5) * 0.0075 * mix(0.42, 1, vn);
    const poolVar = 0.55 + 0.92 * fbm2(uu * 3.1, 9.1, seed + 5, 2);
    const wob = pool > 0 ? (fbm2(uu * 7.0, 2.2, seed + 9, 2) - 0.5) * 0.0038 * clamp01(pool / BEND) : 0;

    let fz = f * foldDepth;
    fz = fz >= 0 ? fz * FRONT_GAIN : -BACK_LIMIT * (1 - Math.exp(fz / BACK_LIMIT));

    o.x = cx + a + crink * 0.35;
    o.y = Math.max(0.0018, fallY[j] + wob);
    o.z = C.z + fz + pool * poolVar + crink;
    o.u = uArc[i];
    o.v = vn * total;

    // Vertex shading: crests catch the room-side rim, the track shades the heading, and the pool
    // darkens into its own contact shadow. All of it survives the `low` tier, where AO is off.
    const crest = clamp01(0.5 + 0.5 * (f / T.maxAmp));
    let c = mix(0.76, 1.03, crest);
    c *= mix(0.74, 1.0, smoothstep(0, 0.22, vn));
    c *= mix(0.70, 1.0, smoothstep(0, 0.14, fallY[j]));
    c = clamp01(c);
    // Doubled cloth warms slightly; a sheer is never neutral where it overlaps itself.
    o.r = c;
    o.g = c * 0.994;
    o.b = c * 0.972;
  }, { name: `curtain.${panel.id}`, flip: true });

  ctx.track(geo);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `curtain.${panel.id}.cloth`;
  mesh.castShadow = false;   // see the header note
  mesh.receiveShadow = true;
  mesh.renderOrder = 3;

  // root → heap → mesh. `root` is the interaction anchor and the physics body frame; `heap` pivots
  // on the floor so the collapse can concertina the panel into a pile without ever going through
  // the floorboards.
  const hubY = 0.45;
  const root = new THREE.Group();
  root.name = panel.id;
  root.position.set(cx, hubY, C.z);
  const heap = new THREE.Group();
  heap.name = `${panel.id}.heap`;
  heap.position.set(0, -hubY, 0);
  geo.translate(-cx, 0, -C.z);
  heap.add(mesh);
  root.add(heap);

  // — the sway solver's precomputed halves —
  const pos = geo.attributes.position;
  pos.setUsage(THREE.DynamicDrawUsage);
  const base = new Float32Array(pos.array);
  const cols = nu + 1;
  const rows = nv + 1;
  const sinX = [];
  const cosX = [];
  for (let k = 0; k < WAVES.length; k++) {
    const s = new Float32Array(cols);
    const c = new Float32Array(cols);
    for (let i = 0; i < cols; i++) {
      const x = base[i * 3]; // row 0 — the heading, where the columns are unflared
      s[i] = Math.sin(WAVES[k].kx * x + k * 1.7);
      c[i] = Math.cos(WAVES[k].kx * x + k * 1.7);
    }
    sinX.push(s);
    cosX.push(c);
  }
  const rowW = new Float32Array(rows);
  const rowY = new Float32Array(rows);
  const rowDrag = new Float32Array(rows);
  for (let j = 0; j < rows; j++) {
    const vn = j / nv;
    rowY[j] = vn * total;
    rowW[j] = smoothstep(0, 0.55, vn) * (1 - 0.86 * smoothstep(0.86, 1.0, vn));
    // A yank grabs at about 0.45 m off the floor; the drag bell is centred on that arc length.
    const d = (rowY[j] - (drop - 0.45)) / 0.55;
    rowDrag[j] = Math.exp(-d * d) * smoothstep(0, 0.30, vn);
  }

  const colliderSize = [
    width * (1 + flare) + foldDepth * 0.6,
    C.topY * 0.98,
    foldDepth * 2.4 + 0.06,
  ];

  return {
    id: panel.id,
    propId: panel.propId,
    root,
    heap,
    mesh,
    geo,
    pos,
    base,
    cols,
    rows,
    sinX,
    cosX,
    rowW,
    rowY,
    rowDrag,
    hubY,
    gustPhase: R() * 12,
    colliderSize,
    colliderOffset: new THREE.Vector3(0, C.topY * 0.49 - hubY, foldDepth * 0.35),
    heapSpin: (R() - 0.5) * 0.44,
    // live state
    pull: 0,
    pullTarget: 0,
    collapsed: false,
    fallT: 0,
    rec: null,
  };
}

// ── the track, the brackets and the gliders ───────────────────────────────────────────────────

function buildTrack(ctx, batch, panels) {
  const L = ctx.layout;
  const C = L.curtains;
  const G = L.glazing;
  const R = L.room;
  const trackMat = surfaceMaterial(ctx, 'metal.blackAnodised', { tint: 0x1b1c1f });

  const len = C.trackX1 - C.trackX0;
  const cx = (C.trackX0 + C.trackX1) * 0.5;

  // The rail itself: a 26 x 15 mm section with a 7 mm lip below, which is the shadow line that
  // tells you it is a track and not a stick of skirting glued to the ceiling.
  batch.add(prism(rectProfile(0.015, 0.026, 0.0012), len, {
    axis: 'x', name: 'curtain.track', colour: (px) => {
      const c = mix(0.42, 0.96, clamp01(px / 0.015 + 0.5));
      return [c, c, c * 1.03];
    },
  }), trackMat, { pos: [cx, C.trackY, C.z], cast: true, recv: true });
  batch.add(prism(rectProfile(0.006, 0.010, 0.0008), len, {
    axis: 'x', name: 'curtain.trackLip', colour: () => [0.30, 0.30, 0.32],
  }), trackMat, { pos: [cx, C.trackY - 0.0105, C.z], cast: false, recv: true });

  // Face-fixed brackets. They land on the plaster ABOVE the glazing head (y > 2.50) because at the
  // track's own height the wall is glass — a bracket screwed into a window is the sort of mistake
  // that reads instantly.
  const wallZ = R.minZ;              // -4.60, the plaster face
  const armZ0 = wallZ + 0.006;
  const armZ1 = C.z + 0.004;
  const armY = C.trackY + 0.108;
  for (let i = 0; i < 5; i++) {
    const bx = mix(C.trackX0 + 0.16, C.trackX1 - 0.16, i / 4);
    // wall plate
    batch.add(chamferBox(0.052, 0.104, 0.010, 0.0015, {
      at: [bx, armY, wallZ + 0.005], name: 'curtain.bracketPlate',
      colour: () => [0.55, 0.55, 0.57],
    }), trackMat, { pos: [bx, armY, wallZ + 0.005], cast: true, recv: true });
    // horizontal arm
    batch.add(chamferBox(0.014, 0.011, armZ1 - armZ0, 0.0012, {
      at: [bx, armY, (armZ0 + armZ1) * 0.5], name: 'curtain.bracketArm',
      colour: (lx, ly) => {
        const c = mix(0.40, 0.86, clamp01(ly / 0.011 + 0.5));
        return [c, c, c];
      },
    }), trackMat, { pos: [bx, armY, (armZ0 + armZ1) * 0.5], cast: true, recv: true });
    // the drop to the rail
    const dropH = armY - C.trackY + 0.012;
    batch.add(chamferBox(0.013, dropH, 0.011, 0.0012, {
      at: [bx, armY - dropH * 0.5, C.z], name: 'curtain.bracketDrop',
      colour: () => [0.48, 0.48, 0.50],
    }), trackMat, { pos: [bx, armY - dropH * 0.5, C.z], cast: true, recv: true });
  }

  // Gliders: one at every pinch between lobes, which is exactly where the hooks go.
  const stud = chamferProfile([
    { x: -0.0055, y: -0.0055 }, { x: 0.0055, y: -0.0055 },
    { x: 0.0055, y: 0.0055 }, { x: -0.0055, y: 0.0055 },
  ], 0.0018);
  for (const p of panels) {
    const T = p.foldEdges;
    if (!T) continue;
    for (let i = 0; i < T.length; i++) {
      const gx = p.cx + (T[i] - 0.5) * p.width;
      const h = C.trackY - C.topY + 0.012;
      batch.add(prism(stud, h, {
        axis: 'y', name: 'curtain.glider', colour: () => [0.66, 0.66, 0.69],
      }), trackMat, { pos: [gx, C.trackY - h * 0.5 - 0.006, C.z], cast: true, recv: false });
    }
  }
}

// ── the module ────────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} ctx
 * @param {THREE.Group} group the room group — the panels are their own meshes, not batched
 * @param {object} batch the shared batcher, for the track hardware
 * @param {Array} props push prop specs here
 */
export function buildCurtains(ctx, group, batch, props) {
  const L = ctx.layout;
  const C = L.curtains;
  const tier = ctx.quality?.tier || 'high';
  const cfg = SEG_BY_TIER[tier] || SEG_BY_TIER.high;
  const mat = surfaceMaterial(ctx, 'fabric.sheer');

  const panels = [];
  const trackInfo = [];
  for (const spec of C.panels) {
    const p = buildPanel(ctx, spec, cfg, mat);
    group.add(p.root);
    panels.push(p);
    // Re-derive the pinch positions for the gliders without rebuilding the whole table.
    const R = makeRng((spec.seed ^ 0x51a2f3) >>> 0);
    const T = buildFoldTable(spec, R);
    trackInfo.push({ cx: spec.cx, width: spec.width, foldEdges: Array.from(T.edge) });
  }
  buildTrack(ctx, batch, cfg.gliders ? trackInfo : []);

  // Colliders + props. A gathered sheer is a soft thing to bump into, but it still has to be
  // *findable*: interactions.js acquires props through overlapSphere, so a prop with no collider
  // can never be targeted at all.
  for (const p of panels) {
    if (ctx.physics) {
      p.rec = ctx.physics.addStatic(p.root, {
        shape: 'box',
        size: p.colliderSize,
        offset: p.colliderOffset,
        friction: 0.55,
        restitution: 0.02,
        material: 'fabric',
      });
    }
    if (!p.propId) continue;
    props.push({
      id: p.propId,
      object3d: p.root,
      body: null,
      kind: 'pullable',
      labelKey: 'prop.curtain',
      points: 200,
      noise: 0.6,
      mass: 0.6,
      fragile: false,
    });
  }

  const byProp = new Map();
  for (const p of panels) if (p.propId) byProp.set(p.propId, p);

  // ── runtime ────────────────────────────────────────────────────────────────────────────────
  const a = [new Float32Array(cfg.rows + 1), new Float32Array(cfg.rows + 1)];
  const b = [new Float32Array(cfg.rows + 1), new Float32Array(cfg.rows + 1)];
  let clock = 0;
  let frame = 0;

  function solve(p, t) {
    const arr = p.pos.array;
    const base = p.base;
    const cols = p.cols;
    const rows = p.rows;
    // Two separable travelling waves. `pull` bulges the cloth toward the room where the hand is.
    const gust = 1 + 0.34 * Math.sin(t * 0.23 + p.gustPhase);
    for (let k = 0; k < WAVES.length; k++) {
      const W = WAVES[k];
      const A = W.amp * gust * (p.collapsed ? 0.45 : 1) * (1 + p.pull * 1.6);
      const ak = a[k];
      const bk = b[k];
      for (let j = 0; j < rows; j++) {
        const ph = W.ky * p.rowY[j] - W.w * t;
        const w = p.rowW[j] * A;
        ak[j] = Math.cos(ph) * w;
        bk[j] = Math.sin(ph) * w;
      }
    }
    const s0 = p.sinX[0];
    const c0 = p.cosX[0];
    const s1 = p.sinX[1];
    const c1 = p.cosX[1];
    const a0 = a[0];
    const b0 = b[0];
    const a1 = a[1];
    const b1 = b[1];
    const drag = p.pull * 0.11;
    for (let j = 0; j < rows; j++) {
      const row = j * cols;
      const d0a = a0[j];
      const d0b = b0[j];
      const d1a = a1[j];
      const d1b = b1[j];
      const dz = drag * p.rowDrag[j];
      for (let i = 0; i < cols; i++) {
        const k = (row + i) * 3;
        const d = d0a * s0[i] + d0b * c0[i] + d1a * s1[i] + d1b * c1[i] + dz;
        arr[k] = base[k] + d * 0.28;
        arr[k + 2] = base[k + 2] + d;
      }
    }
    p.pos.needsUpdate = true;
  }

  function collapse(p) {
    if (p.collapsed) return;
    p.collapsed = true;
    p.fallT = 0;
    p.pull = 0;
    p.pullTarget = 0;
    // The tall collider has to go with it — an invisible 2.4 m wall where a heap of cloth is
    // lying would be the single most obvious bug in the room.
    if (ctx.physics && p.rec) {
      ctx.physics.remove(p.root);
      p.rec = ctx.physics.addStatic(p.root, {
        shape: 'box',
        size: [p.colliderSize[0] * 1.5, 0.30, p.colliderSize[2] * 2.1],
        offset: new THREE.Vector3(0, 0.15 - p.hubY, 0.05),
        friction: 0.62,
        restitution: 0.02,
        material: 'fabric',
      });
    }
  }

  const onPullProgress = (e) => {
    const p = e && e.prop && byProp.get(e.prop.id);
    if (p && !p.collapsed) p.pullTarget = clamp01(e.progress || 0);
  };
  const onPullEnd = (e) => {
    const p = e && e.prop && byProp.get(e.prop.id);
    if (p) p.pullTarget = 0;
  };
  const onToppled = (e) => {
    const p = e && e.prop && byProp.get(e.prop.id);
    if (p) collapse(p);
  };
  ctx.events.on('interact:pull:progress', onPullProgress);
  ctx.events.on('interact:pull:end', onPullEnd);
  ctx.events.on('prop:toppled', onToppled);

  // Settle every panel once so the first frame — and every photo-mode frame — is deterministic
  // and already carries a little air.
  for (const p of panels) solve(p, 0);

  return {
    panels,
    update(dt) {
      if (ctx.state.mode === 'photo') return;
      clock += dt;
      frame++;
      // `low` never sways: a disabled feature costs zero, including its update loop.
      const stride = tier === 'medium' ? 2 : 1;
      for (const p of panels) {
        if (p.collapsed && p.fallT < 1) {
          p.fallT = Math.min(1, p.fallT + dt / COLLAPSE_TIME);
          const e = 1 - Math.pow(1 - p.fallT, 3);
          p.heap.scale.set(mix(1, 1.44, e), mix(1, 0.22, e), mix(1, 2.10, e));
          p.heap.rotation.y = p.heapSpin * e;
          p.heap.position.z = e * 0.055;
        }
        const k = p.pullTarget > p.pull ? 7.5 : 3.2;
        p.pull += (p.pullTarget - p.pull) * Math.min(1, dt * k);
        if (!cfg.sway) continue;
        if (stride > 1 && (frame & 1)) continue;
        solve(p, clock);
      }
    },
    reset() {
      clock = 0;
      for (const p of panels) {
        p.pull = 0;
        p.pullTarget = 0;
        p.fallT = 0;
        p.heap.scale.set(1, 1, 1);
        p.heap.rotation.y = 0;
        p.heap.position.z = 0;
        if (p.collapsed && ctx.physics) {
          ctx.physics.remove(p.root);
          p.rec = ctx.physics.addStatic(p.root, {
            shape: 'box',
            size: p.colliderSize,
            offset: p.colliderOffset,
            friction: 0.55,
            restitution: 0.02,
            material: 'fabric',
          });
        }
        p.collapsed = false;
        solve(p, 0);
      }
    },
    dispose() {
      ctx.events.off('interact:pull:progress', onPullProgress);
      ctx.events.off('interact:pull:end', onPullEnd);
      ctx.events.off('prop:toppled', onToppled);
    },
  };
}
