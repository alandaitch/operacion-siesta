// AI · navigation. A 0.15 m occupancy grid over the flat, a chamfer clearance field, A* and a
// string-pulled path. Everything here is built once, at construction, from LAYOUT — never from
// the live scene graph — so the parent's route is byte-identical in every run and screenshot.
//
// The three ideas:
//
//  · CLEARANCE, NOT INFLATION. Instead of fattening every obstacle by the parent's radius and
//    throwing away the result, we keep a distance-to-nearest-obstacle field in metres (two-pass
//    3-4 chamfer, which is within 2 % of Euclidean and costs one sweep each way). Passability is
//    then just `clear >= radius`, and the A* step cost carries a penalty as clearance falls, so
//    the parent takes the middle of a gap rather than shaving the corner of the ottoman. It also
//    gives the steering a scalar to slow down and pull their elbows in with.
//  · STRING PULLING. Grid A* produces a staircase. We walk the raw cells and keep a vertex only
//    when the straight line from the last kept vertex to the next candidate stops being walkable,
//    which turns 40 cells into 3–5 waypoints and removes every 45° zig-zag.
//  · ONE DECLARED CORRIDOR. LAYOUT's playpen (x ∈ [-1.40, 1.40], z ∈ [0.70, 3.30]) and the sofa's
//    chaise return (which reaches x = 1.50 at z ∈ [0.55, 1.85]) leave a 70 mm slot between them,
//    and that slot is the *only* connection between the doorway and the rest of the room — the
//    flat is otherwise topologically sealed for anything wider than a cat. Rather than let A* fail
//    silently we declare that slot as a corridor rectangle that clears blockers, so the parent
//    genuinely sidles between the playpen and the chaise on their way in. If a future furniture
//    change reopens a wider route the corridor simply stops mattering; if it seals the flat again,
//    `connected` goes false, the radius relaxes, and the console says so.

const V2 = (x, z) => ({ x, z });

const CELL = 0.15;
/** Half the parent's shoulder-to-shoulder width, minus the amount a person will happily brush. */
const RADII = [0.21, 0.17, 0.14, 0.11, 0.08];
/** Above this much room either side, a corridor stops feeling like a squeeze. */
const COMFORT = 0.55;

const CH_A = 1.0;      // chamfer weights (in cells)
const CH_B = 1.41421356;

/** Point-in-rotated-rectangle. `rot` is the rectangle's yaw about +Y. */
function inRect(px, pz, cx, cz, hw, hd, rot) {
  const dx = px - cx;
  const dz = pz - cz;
  if (rot) {
    const c = Math.cos(-rot);
    const s = Math.sin(-rot);
    const rx = dx * c - dz * s;
    const rz = dx * s + dz * c;
    return Math.abs(rx) <= hw && Math.abs(rz) <= hd;
  }
  return Math.abs(dx) <= hw && Math.abs(dz) <= hd;
}

/** A tiny binary heap keyed on f. Rebuilt-free: A* over 3 000 cells never grows past a few hundred. */
class Heap {
  constructor() {
    this.n = [];
    this.f = [];
  }

  get size() {
    return this.n.length;
  }

  clear() {
    this.n.length = 0;
    this.f.length = 0;
  }

  push(node, f) {
    const n = this.n;
    const fs = this.f;
    let i = n.length;
    n.push(node);
    fs.push(f);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (fs[p] <= fs[i]) break;
      const tn = n[p]; n[p] = n[i]; n[i] = tn;
      const tf = fs[p]; fs[p] = fs[i]; fs[i] = tf;
      i = p;
    }
  }

  pop() {
    const n = this.n;
    const fs = this.f;
    const top = n[0];
    const last = n.pop();
    const lastF = fs.pop();
    if (n.length) {
      n[0] = last;
      fs[0] = lastF;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < n.length && fs[l] < fs[m]) m = l;
        if (r < n.length && fs[r] < fs[m]) m = r;
        if (m === i) break;
        const tn = n[m]; n[m] = n[i]; n[i] = tn;
        const tf = fs[m]; fs[m] = fs[i]; fs[i] = tf;
        i = m;
      }
    }
    return top;
  }
}

/**
 * @param ctx the game context (needs ctx.layout)
 * @returns the navigation grid + queries. Pure data after construction; no per-frame allocation
 *          except the waypoint array handed back by findPath().
 */
export function createNav(ctx) {
  const L = ctx.layout;
  const room = L.room;
  const hall = L.hallway;
  const door = L.doorway;

  // ── extents: the flat is the room plus the corridor the parent lives in ────────────────
  const x0 = room.minX;
  const x1 = room.maxX;
  const z0 = room.minZ;
  const z1 = hall.z1;
  const nx = Math.ceil((x1 - x0) / CELL);
  const nz = Math.ceil((z1 - z0) / CELL);
  const count = nx * nz;

  const solid = new Uint8Array(count);      // wall / furniture
  const clear = new Float32Array(count);    // metres to the nearest solid cell centre
  const idx = (i, k) => k * nx + i;
  const cx = (i) => x0 + (i + 0.5) * CELL;
  const cz = (k) => z0 + (k + 0.5) * CELL;
  const ci = (x) => Math.floor((x - x0) / CELL);
  const ck = (z) => Math.floor((z - z0) / CELL);

  // ── the walkable envelope ──────────────────────────────────────────────────────────────
  // Three convex pieces: the room, the doorway reveal cut through the 150 mm back wall, and the
  // hallway beyond it. Everything outside all three is solid before a single stick of furniture
  // is placed.
  const PAD = 0.055;   // plaster is not a surface you walk with your shoulder against
  function insideEnvelope(px, pz) {
    if (px > room.minX + PAD && px < room.maxX - PAD && pz > room.minZ + PAD && pz < room.maxZ - 0.02) return true;
    if (px > door.x0 + 0.04 && px < door.x1 - 0.04 && pz >= room.maxZ - 0.03 && pz <= hall.z0 + 0.03) return true;
    if (px > hall.x0 + PAD && px < hall.x1 - PAD && pz > hall.z0 - 0.03 && pz < hall.z1 - PAD) return true;
    return false;
  }

  // ── obstacles, straight out of LAYOUT ──────────────────────────────────────────────────
  const F = L;
  const shelfZ = (F.shelving.z0 + F.shelving.z1) * 0.5;
  const rects = [
    // shelving run, espresso machine on its end unit
    { cx: F.shelving.x, cz: shelfZ, w: F.shelving.depth, d: F.shelving.length, rot: F.shelving.rot },
    { cx: F.espresso.x, cz: F.espresso.z, w: F.espresso.d, d: F.espresso.w, rot: F.espresso.rot },
    // the sectional: the run down the right wall, then the chaise turning into the room
    { cx: F.sofa.x, cz: F.sofa.z, w: F.sofa.w, d: F.sofa.d, rot: F.sofa.rot },
    { cx: F.sofa.chaise.x, cz: F.sofa.chaise.z, w: F.sofa.chaise.w, d: F.sofa.chaise.d, rot: F.sofa.rot },
    { cx: F.armchair.x, cz: F.armchair.z, w: F.armchair.w, d: F.armchair.d, rot: F.armchair.rot },
    { cx: F.ottoman.x, cz: F.ottoman.z, w: F.ottoman.w, d: F.ottoman.d, rot: F.ottoman.rot },
    { cx: F.coffeeTable.x, cz: F.coffeeTable.z, w: F.coffeeTable.w, d: F.coffeeTable.d, rot: F.coffeeTable.rot },
    { cx: F.playpen.x, cz: F.playpen.z, w: F.playpen.w, d: F.playpen.d, rot: F.playpen.rot },
    { cx: F.rattanChair.x, cz: F.rattanChair.z, w: F.rattanChair.size, d: F.rattanChair.size, rot: F.rattanChair.rot },
    // the radiator and the curtain line, so nobody walks into the glazing
    { cx: L.radiator.cx, cz: L.radiator.z, w: L.radiator.w, d: L.radiator.d + 0.10, rot: 0 },
    {
      cx: (L.curtains.trackX0 + L.curtains.trackX1) * 0.5,
      cz: L.curtains.z,
      w: L.curtains.trackX1 - L.curtains.trackX0,
      d: 0.16,
      rot: 0,
    },
  ];
  const circles = [
    { cx: F.pouf.x, cz: F.pouf.z, r: F.pouf.radius + 0.02 },
    { cx: F.sideTable.x, cz: F.sideTable.z, r: F.sideTable.radius + 0.03 },
    { cx: F.monstera.x, cz: F.monstera.z, r: F.monstera.potRadius + 0.13 },
    { cx: F.plant2.x, cz: F.plant2.z, r: F.plant2.potRadius + 0.09 },
    { cx: F.floorLamp.x, cz: F.floorLamp.z, r: F.floorLamp.shadeRadius + 0.07 },
  ];

  // See the header. The slot between the playpen's +x face (1.434 m, including its 1.5° yaw) and
  // the chaise's -x tip (1.50 m in the built sofa) is 66 mm wide, and it is the only way in or out
  // of the room. We declare a 0.66 m lane through it, pushed toward the playpen because brushing a
  // mesh panel reads better than brushing velvet, and the A* clearance term keeps them centred in
  // it. Anything walking this lane will overlap the chaise's rounded corner by a few centimetres;
  // that is the least-bad reading of a genuine clash between LAYOUT.playpen and LAYOUT.sofa.chaise.
  const corridors = [
    { cx: 1.58, cz: 1.24, w: 0.72, d: 2.05 },
  ];

  function rebuild(radius) {
    for (let k = 0; k < nz; k++) {
      const pz = cz(k);
      for (let i = 0; i < nx; i++) {
        const px = cx(i);
        let blocked = !insideEnvelope(px, pz);
        if (!blocked) {
          for (let r = 0; r < rects.length && !blocked; r++) {
            const q = rects[r];
            if (inRect(px, pz, q.cx, q.cz, q.w * 0.5, q.d * 0.5, q.rot || 0)) blocked = true;
          }
          for (let r = 0; r < circles.length && !blocked; r++) {
            const q = circles[r];
            const dx = px - q.cx;
            const dz = pz - q.cz;
            if (dx * dx + dz * dz <= q.r * q.r) blocked = true;
          }
          if (blocked) {
            for (let r = 0; r < corridors.length; r++) {
              const q = corridors[r];
              if (inRect(px, pz, q.cx, q.cz, q.w * 0.5, q.d * 0.5, 0)) {
                blocked = false;
                break;
              }
            }
          }
        }
        solid[idx(i, k)] = blocked ? 1 : 0;
      }
    }

    // two-pass chamfer distance transform, in cells, then converted to metres
    const BIG = 1e6;
    for (let k = 0; k < nz; k++) {
      for (let i = 0; i < nx; i++) {
        const p = idx(i, k);
        if (solid[p]) {
          clear[p] = 0;
          continue;
        }
        let best = BIG;
        if (i > 0) best = Math.min(best, clear[p - 1] + CH_A);
        if (k > 0) best = Math.min(best, clear[p - nx] + CH_A);
        if (i > 0 && k > 0) best = Math.min(best, clear[p - nx - 1] + CH_B);
        if (i < nx - 1 && k > 0) best = Math.min(best, clear[p - nx + 1] + CH_B);
        clear[p] = best;
      }
    }
    for (let k = nz - 1; k >= 0; k--) {
      for (let i = nx - 1; i >= 0; i--) {
        const p = idx(i, k);
        if (solid[p]) continue;
        let best = clear[p];
        if (i < nx - 1) best = Math.min(best, clear[p + 1] + CH_A);
        if (k < nz - 1) best = Math.min(best, clear[p + nx] + CH_A);
        if (i < nx - 1 && k < nz - 1) best = Math.min(best, clear[p + nx + 1] + CH_B);
        if (i > 0 && k < nz - 1) best = Math.min(best, clear[p + nx - 1] + CH_B);
        clear[p] = best;
      }
    }
    // Edge cells of the array are outside the flat and already solid, so no clamp is needed; the
    // 0.5-cell offset makes a cell whose neighbour is solid read as "half a cell of room", which
    // is the honest answer.
    for (let p = 0; p < count; p++) clear[p] = clear[p] === 0 ? 0 : (clear[p] - 0.5) * CELL;
    navRadius = radius;
  }

  let navRadius = RADII[0];
  const passable = (i, k) => (i >= 0 && k >= 0 && i < nx && k < nz && clear[idx(i, k)] >= navRadius);

  // ── connectivity, and the relaxation that guarantees it ────────────────────────────────
  const reach = new Uint8Array(count);
  function flood(si, sk) {
    reach.fill(0);
    if (!passable(si, sk)) return 0;
    const stack = [idx(si, sk)];
    reach[stack[0]] = 1;
    let n = 0;
    while (stack.length) {
      const p = stack.pop();
      n++;
      const i = p % nx;
      const k = (p - i) / nx;
      for (let d = 0; d < 4; d++) {
        const ni = i + (d === 0 ? 1 : d === 1 ? -1 : 0);
        const nk = k + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (!passable(ni, nk)) continue;
        const np = idx(ni, nk);
        if (reach[np]) continue;
        reach[np] = 1;
        stack.push(np);
      }
    }
    return n;
  }

  // The hallway spawn must be able to reach the far corner of the room; that is the whole game.
  const probeA = [hall.spawn.x, hall.spawn.z];
  const probeB = [-2.30, -2.20];
  let connected = false;
  for (let r = 0; r < RADII.length; r++) {
    rebuild(RADII[r]);
    const si = ci(probeA[0]);
    const sk = ck(probeA[1]);
    flood(si, sk);
    const bi = ci(probeB[0]);
    const bk = ck(probeB[1]);
    if (reach[idx(bi, bk)]) {
      connected = true;
      break;
    }
  }
  if (!connected) {
    console.warn('[ai] the flat is not walkable from the hallway at any body radius — the parent '
      + 'will approach in a straight line. Check LAYOUT.playpen against LAYOUT.sofa.chaise.');
    rebuild(RADII[RADII.length - 1]);
    flood(ci(probeA[0]), ck(probeA[1]));
  }

  // ── queries ────────────────────────────────────────────────────────────────────────────

  function clearanceAt(x, z) {
    const i = ci(x);
    const k = ck(z);
    if (i < 0 || k < 0 || i >= nx || k >= nz) return 0;
    return clear[idx(i, k)];
  }

  const _near = { x: 0, z: 0, ok: false };
  /** The nearest passable cell centre to (x,z), searched in rings. Authored anchor points are
   *  written by hand in metres; this is what stops one of them landing inside a pouf. */
  function nearestOpen(x, z, maxRings = 14) {
    const i0 = ci(x);
    const k0 = ck(z);
    if (passable(i0, k0)) {
      _near.x = x;
      _near.z = z;
      _near.ok = true;
      return _near;
    }
    for (let r = 1; r <= maxRings; r++) {
      let best = -1;
      let bestD = Infinity;
      for (let k = k0 - r; k <= k0 + r; k++) {
        for (let i = i0 - r; i <= i0 + r; i++) {
          if (Math.max(Math.abs(i - i0), Math.abs(k - k0)) !== r) continue;
          if (!passable(i, k)) continue;
          const dx = cx(i) - x;
          const dz = cz(k) - z;
          const d = dx * dx + dz * dz - clear[idx(i, k)] * 0.02;
          if (d < bestD) {
            bestD = d;
            best = idx(i, k);
          }
        }
      }
      if (best >= 0) {
        const i = best % nx;
        _near.x = cx(i);
        _near.z = cz((best - i) / nx);
        _near.ok = true;
        return _near;
      }
    }
    _near.x = x;
    _near.z = z;
    _near.ok = false;
    return _near;
  }

  /** Supercover walk: is the straight segment (ax,az)→(bx,bz) walkable end to end? */
  function walkable(ax, az, bx, bz) {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(len / (CELL * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      if (!passable(ci(ax + dx * t), ck(az + dz * t))) return false;
    }
    return true;
  }

  // A* scratch, allocated once
  const gScore = new Float32Array(count);
  const came = new Int32Array(count);
  const stamp = new Int32Array(count);
  const closed = new Uint8Array(count);
  let epoch = 0;
  const open = new Heap();
  const raw = [];

  const NEIGH = [
    [1, 0, CH_A], [-1, 0, CH_A], [0, 1, CH_A], [0, -1, CH_A],
    [1, 1, CH_B], [1, -1, CH_B], [-1, 1, CH_B], [-1, -1, CH_B],
  ];

  /**
   * @returns an array of {x,z} waypoints from just-after the start to the goal, or null. The array
   *          is freshly allocated (a path lives for many seconds, so this is not a hot path).
   */
  function findPath(sx, sz, gx, gz) {
    // nearestOpen hands back a shared scratch object, so read it out before asking again.
    let n0 = nearestOpen(sx, sz);
    const s = { x: n0.x, z: n0.z };
    n0 = nearestOpen(gx, gz);
    const g = { x: n0.x, z: n0.z };
    const si = ci(s.x);
    const sk = ck(s.z);
    const gi = ci(g.x);
    const gk = ck(g.z);
    if (!passable(si, sk) || !passable(gi, gk)) return null;

    const startP = idx(si, sk);
    const goalP = idx(gi, gk);
    if (startP === goalP) return [V2(g.x, g.z)];

    // A straight shot is by far the most common case once they are in the room.
    if (walkable(s.x, s.z, g.x, g.z)) return [V2(gx, gz)];

    epoch++;
    open.clear();
    gScore[startP] = 0;
    came[startP] = -1;
    stamp[startP] = epoch;
    closed[startP] = 0;
    const h0 = Math.hypot(gi - si, gk - sk);
    open.push(startP, h0);

    let found = false;
    let guard = 0;
    while (open.size && guard++ < 20000) {
      const p = open.pop();
      if (closed[p] === 1 && stamp[p] === epoch) continue;
      closed[p] = 1;
      stamp[p] = epoch;
      if (p === goalP) {
        found = true;
        break;
      }
      const i = p % nx;
      const k = (p - i) / nx;
      const gp = gScore[p];
      for (let n = 0; n < NEIGH.length; n++) {
        const ni = i + NEIGH[n][0];
        const nk = k + NEIGH[n][1];
        if (!passable(ni, nk)) continue;
        // no corner cutting: a diagonal needs both orthogonal neighbours open
        if (NEIGH[n][2] > 1 && (!passable(i + NEIGH[n][0], k) || !passable(i, k + NEIGH[n][1]))) continue;
        const np = idx(ni, nk);
        if (stamp[np] === epoch && closed[np]) continue;
        // Hug the middle of a gap. The penalty is quadratic so a comfortable route is barely
        // taxed and a 40 cm squeeze costs nearly double.
        const room01 = Math.min(1, clear[np] / COMFORT);
        const squeeze = (1 - room01) * (1 - room01);
        const step = NEIGH[n][2] * (1 + 1.35 * squeeze);
        const tentative = gp + step;
        if (stamp[np] === epoch && tentative >= gScore[np]) continue;
        gScore[np] = tentative;
        came[np] = p;
        stamp[np] = epoch;
        closed[np] = 0;
        open.push(np, tentative + Math.hypot(gi - ni, gk - nk) * 1.001);
      }
    }
    if (!found) return null;

    raw.length = 0;
    let p = goalP;
    while (p >= 0) {
      const i = p % nx;
      raw.push(cx(i), cz((p - i) / nx));
      p = came[p];
    }
    // raw is goal → start, flattened; walk it backwards and string-pull
    const n = raw.length / 2;
    const out = [];
    let anchorX = s.x;
    let anchorZ = s.z;
    let lastX = anchorX;
    let lastZ = anchorZ;
    for (let a = n - 2; a >= 0; a--) {
      const px = raw[a * 2];
      const pz = raw[a * 2 + 1];
      if (walkable(anchorX, anchorZ, px, pz)) {
        lastX = px;
        lastZ = pz;
        continue;
      }
      out.push(V2(lastX, lastZ));
      anchorX = lastX;
      anchorZ = lastZ;
      lastX = px;
      lastZ = pz;
    }
    out.push(V2(g.x, g.z));
    // The requested goal may be a hair off a cell centre (a chore anchor, a last-known position);
    // keep it if the last leg is still walkable, so they finish at the authored spot.
    if (walkable(out[out.length - 1].x, out[out.length - 1].z, gx, gz)) {
      out[out.length - 1] = V2(gx, gz);
    }
    return out;
  }

  return {
    cell: CELL,
    nx,
    nz,
    x0,
    z0,
    connected,
    get radius() { return navRadius; },
    comfort: COMFORT,
    passable,
    passableAt: (x, z) => passable(ci(x), ck(z)),
    clearanceAt,
    nearestOpen,
    walkable,
    findPath,
    /** Debug: how much of the flat the parent can actually reach. */
    stats() {
      let open2 = 0;
      for (let p = 0; p < count; p++) if (clear[p] >= navRadius) open2++;
      return { cells: count, walkable: open2, radius: navRadius, connected };
    },
  };
}
