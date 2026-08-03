// OPERATION NAPTIME — module ROOM — everything on the far side of the glass.
// OWNER: ROOM.
//
// Forty per cent of several shots is this, and none of it is ever in focus or ever closer than
// four metres, so the entire brief is VALUE STRUCTURE AND SILHOUETTE, cheaply. Four depth planes,
// each a distinct tonal band, is what makes a window read as a window rather than as a lightbox:
//
//   1. the balcony slab and its black railing   — near, darkest, hardest edges, ~1.6–2.4 m out
//   2. the terracotta planter and its greenery  — the only saturated thing outside
//   3. four bare winter trees                   — mid grey, broken, 4–6 m out
//   4. the red-brick building opposite          — light warm mass, 9 m out, half-buried in fog
//
// The building is not a box with windows painted on. The openings are REAL HOLES: a dark backing
// wall sits 110 mm behind a brick skin built as five spandrel bands and four rows of piers, so
// every window has a genuine self-shadowing reveal, and four of them are lit. That reveal is the
// only reason a facade looks like masonry instead of wallpaper.
//
// Nothing out here casts or receives a shadow. LIGHT fits the sun's shadow camera to a constant
// box around the room (z ≥ −4.80), so every one of these objects is behind its near plane; asking
// for shadows would cost a full extra pass of geometry and produce precisely nothing. The scene's
// exponential fog is doing the aerial perspective, and it is worth about 50% out at the brick.
//
// The sky is NOT built here. LIGHT owns `scene.background` (a cube bake of its own sky shader) and
// a second dome would either z-fight with it or double its energy.

import { makeRng } from '../../core/rng.js';
import * as THREE from 'three';
import {
  chamferBox, paramSurface, prism, chamferProfile, tube,
  surfaceMaterial, fbm2, noise2, smoothstep, clamp01, mix,
} from './geom.js';

const TIER = {
  low: { postStep: 3, treeDepth: 2, leafPerClump: 3, clumpScale: 0.5, groundSeg: 3 },
  medium: { postStep: 2, treeDepth: 3, leafPerClump: 4, clumpScale: 0.75, groundSeg: 5 },
  high: { postStep: 1, treeDepth: 4, leafPerClump: 7, clumpScale: 1, groundSeg: 8 },
  ultra: { postStep: 1, treeDepth: 4, leafPerClump: 8, clumpScale: 1, groundSeg: 10 },
};

// ── helpers ───────────────────────────────────────────────────────────────────────────────────

/**
 * A single leaf card: a folded, drooping quad with the midrib as a real crease. The card is a
 * plain rectangle — `leaf.small`'s alpha channel cuts the blade shape, and narrowing the geometry
 * as well would give a leaf half the width it is meant to have.
 */
function leafCard(len, wid, droop, curl) {
  return paramSurface(2, 4, (u, v, o) => {
    const s = v * len;
    const across = (u - 0.5) * wid * 2;
    // The midrib creases the blade; the tip droops and the whole leaf twists a little.
    const fold = (1 - Math.abs(u - 0.5) * 2) * curl * wid;
    const tw = curl * 0.8 * v;
    o.x = across * Math.cos(tw);
    o.y = s - droop * s * s / len;
    o.z = fold + across * Math.sin(tw) * 0.6;
    o.u = u;
    o.v = v;
    const c = mix(0.68, 1.0, v);
    o.r = c;
    o.g = c;
    o.b = c;
  }, { name: 'exterior.leaf' });
}

// ── the trees ─────────────────────────────────────────────────────────────────────────────────

/**
 * A bare winter tree: a leaning trunk that forks three ways, each fork forking again, down to
 * twigs. All of it is `tube()`, all of it is deterministic from the tree's own seed, and the
 * radii taper by 0.62 per generation so the silhouette thins the way a real crown does.
 */
function buildTree(batch, mat, spec, cfg) {
  const R = makeRng((spec.seed ^ 0x77a3b1) >>> 0);
  const ground = spec.groundY;
  const H = spec.height;

  // A crown is 2–3 m across, and two things sit inside that radius: the balcony railing at
  // z = −6.28 and the brick facade at z = −13.40. Clamping the spine rather than the finished
  // geometry bends a branch along the boundary instead of letting it grow through a handrail.
  const clampPt = (v) => {
    if (v.z > -6.80) v.z = -6.80;
    else if (v.z < -13.10) v.z = -13.10;
    if (v.x > 11.5) v.x = 11.5;
    else if (v.x < -15.5) v.x = -15.5;
    if (v.y < ground + 0.02) v.y = ground + 0.02;
  };

  const push = (from, dir, len, r0, r1, gen) => {
    const steps = gen === 0 ? 5 : gen === 1 ? 3 : 2;
    const pts = [];
    const radii = [];
    const cur = from.clone();
    const d = dir.clone().normalize();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      clampPt(cur);
      pts.push(cur.clone());
      radii.push(mix(r0, r1, t) * (1 + (R() - 0.5) * 0.16));
      // A branch is never straight: it wanders and it droops under its own weight.
      d.x += (R() - 0.5) * 0.16;
      d.z += (R() - 0.5) * 0.16;
      d.y -= 0.045 * gen;
      d.normalize();
      cur.addScaledVector(d, len / steps);
    }
    const sides = gen === 0 ? 6 : gen === 1 ? 5 : 4;
    batch.add(tube(pts, radii, sides, {
      name: `exterior.branch${gen}`,
      colour: (px, py, pz, nx) => {
        // Bark is lit from the room side and from above; the undersides go to silhouette.
        const c = clamp01(mix(0.30, 1.0, 0.5 + 0.5 * (nx * 0.35 + 0.62))
          * mix(0.72, 1.0, smoothstep(ground, ground + H * 0.7, py))
          * (1 + (noise2(px * 7, py * 7, 0x4c19) - 0.5) * 0.20));
        return [c, c * 0.98, c * 0.94];
      },
    }), mat, { cast: false, recv: false });
    return { end: pts[pts.length - 1], dir: d.clone(), r: r1 };
  };

  const trunkLen = H * 0.44;
  const base = new THREE.Vector3(spec.x, ground, spec.z);
  const trunkDir = new THREE.Vector3(spec.lean, 1, spec.lean * 0.6).normalize();
  const trunk = push(base, trunkDir, trunkLen, H * 0.026, H * 0.013, 0);

  const grow = (node, gen, len) => {
    if (gen > cfg.treeDepth) return;
    const n = gen === 1 ? 3 : R() < 0.35 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + R() * 1.9;
      const spread = 0.34 + 0.24 * R() + gen * 0.05;
      const dir = new THREE.Vector3(
        node.dir.x + Math.cos(a) * spread,
        node.dir.y * (0.86 - gen * 0.05),
        node.dir.z + Math.sin(a) * spread,
      ).normalize();
      const l = len * (0.58 + 0.28 * R());
      const child = push(node.end, dir, l, node.r, node.r * 0.60, gen);
      grow(child, gen + 1, l);
    }
  };
  grow(trunk, 1, H * 0.27);
}

// ── the module ────────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} ctx
 * @param {object} batch a batcher whose flush target is the exterior group
 */
export function buildExterior(ctx, batch) {
  const L = ctx.layout;
  const E = L.exterior;
  const tier = ctx.quality?.tier || 'high';
  const cfg = TIER[tier] || TIER.high;
  const R = makeRng(0x0e57e21);

  const brick = surfaceMaterial(ctx, 'brick.exterior');
  const brickDark = surfaceMaterial(ctx, 'brick.exterior', { tint: 0x352724, roughRange: [0.86, 0.97] });
  const glassOut = surfaceMaterial(ctx, 'glass.exterior', { vertexColors: false });
  const glassLit = surfaceMaterial(ctx, 'glass.exterior', {
    tint: 0x3a3126, emissive: 0xffa860, emissiveIntensity: 1.5, envBoost: 0.5,
    vertexColors: false,
  });
  const concrete = surfaceMaterial(ctx, 'concrete.beam', { tint: 0xb9b2a6 });
  const street = surfaceMaterial(ctx, 'concrete.beam', { tint: 0x4d4a45, roughRange: [0.80, 0.96] });
  const steel = surfaceMaterial(ctx, 'metal.blackAnodised', { tint: 0x16171a });
  const pot = surfaceMaterial(ctx, 'ceramic.terracotta');
  const soil = surfaceMaterial(ctx, 'soil');
  const barkMat = surfaceMaterial(ctx, 'bark');
  const foliage = surfaceMaterial(ctx, 'foliage.tree', { uvRepeat: [1, 1] });

  // ── 1. the street, five metres below ────────────────────────────────────────────────────────
  // Without this the gap between the balcony edge and the building opposite is a strip of bright
  // sky where the ground should be, which is the single fastest way to break a window.
  {
    // Sized to stay inside the camera's 45 m far plane at its furthest corner; a ground plane that
    // gets clipped shows a hard horizon line straight through the middle of the window.
    const s = cfg.groundSeg;
    const geo = paramSurface(s, s, (u, v, o) => {
      const x = mix(-26, 26, u);
      const z = mix(-4.0, -30, v);
      o.x = x;
      o.y = E.groundY + (fbm2(x * 0.12, z * 0.12, 0x3a71, 2) - 0.5) * 0.10;
      o.z = z;
      o.u = x * 0.25;
      o.v = z * 0.25;
      const c = clamp01(0.55 + (fbm2(x * 0.3, z * 0.3, 0x3a72, 3) - 0.5) * 0.35);
      o.r = c;
      o.g = c * 0.99;
      o.b = c * 0.97;
      // NOT flipped: v runs toward −Z here, which reverses the winding relative to the room's own
      // floor, so the default winding is the one that faces the sky.
    }, { flip: false, name: 'exterior.street' });
    batch.add(geo, street, { cast: false, recv: false });
  }

  // ── 2. the building opposite ────────────────────────────────────────────────────────────────
  const B = E.building;
  const WIN = B.windows;
  const faceZ = B.frontZ;
  const backZ = faceZ - WIN.reveal;
  {
    // The dark backing wall the reveals are cut into.
    const bw = B.x1 - B.x0;
    const bh = (B.y1 + B.parapet.height) - B.y0;
    const bcx = (B.x0 + B.x1) * 0.5;
    const bcy = (B.y0 + B.y1 + B.parapet.height) * 0.5;
    batch.add(chamferBox(bw, bh, B.depth, 0.004, {
      seg: [8, 6, 1], at: [bcx, bcy, backZ - B.depth * 0.5],
      skip: ['-z', '-y'], name: 'exterior.buildingMass',
      colour: () => [0.30, 0.28, 0.27],
    }), brickDark, { pos: [bcx, bcy, backZ - B.depth * 0.5], cast: false, recv: false });

    // Window rectangles, column-major, exactly as LAYOUT.exterior.building.windows.lit indexes.
    const colX = [];
    for (let c = 0; c < WIN.cols; c++) colX.push(WIN.firstX + c * WIN.pitchX);
    const rowY = [];
    for (let r = 0; r < WIN.rows; r++) rowY.push(WIN.firstY + r * WIN.pitchY);
    const hw = WIN.w * 0.5;
    const hh = WIN.h * 0.5;

    // Vertex tint: masonry is not one value. A slow blotch plus a vertical grime gradient, and the
    // whole facade cools with height because the sky is what is lighting it up there.
    const brickColour = (wx, wy) => {
      let c = 0.80 + (fbm2(wx * 0.22, wy * 0.22, 0x6b21, 3) - 0.5) * 0.30;
      c *= mix(0.74, 1.06, smoothstep(B.y0, B.y1 * 0.8, wy));
      c = clamp01(c);
      return [c, c * 0.965, c * 0.94];
    };
    const addSkin = (x0, x1, y0, y1, name) => {
      const w = x1 - x0;
      const h = y1 - y0;
      if (w < 0.02 || h < 0.02) return;
      const cx = (x0 + x1) * 0.5;
      const cy = (y0 + y1) * 0.5;
      batch.add(chamferBox(w, h, WIN.reveal, 0.004, {
        seg: [Math.max(1, Math.round(w / 1.4)), Math.max(1, Math.round(h / 1.4)), 1],
        at: [cx, cy, faceZ - WIN.reveal * 0.5], skip: ['-z'], name,
        colour: (lx, ly, lz, nx, ny, nz) => {
          const base = brickColour(lx + cx, ly + cy);
          // Up-facing returns are sill reveals and catch the whole sky; down-facing returns are
          // head reveals over an opening and are the darkest brick on the elevation.
          const k = nz > 0.5 ? 1 : ny > 0.5 ? 1.12 : ny < -0.5 ? 0.50 : 0.72;
          return [clamp01(base[0] * k), clamp01(base[1] * k), clamp01(base[2] * k)];
        },
      }), brick, { pos: [cx, cy, faceZ - WIN.reveal * 0.5], cast: false, recv: false });
    };

    // Bands: spandrel, window row, spandrel, … up to the parapet.
    let yCursor = B.y0;
    for (let r = 0; r < WIN.rows; r++) {
      const wy0 = rowY[r] - hh;
      const wy1 = rowY[r] + hh;
      addSkin(B.x0, B.x1, yCursor, wy0, `exterior.spandrel${r}`);
      // Piers between the openings.
      let xCursor = B.x0;
      for (let c = 0; c < WIN.cols; c++) {
        addSkin(xCursor, colX[c] - hw, wy0, wy1, `exterior.pier${r}_${c}`);
        xCursor = colX[c] + hw;
      }
      addSkin(xCursor, B.x1, wy0, wy1, `exterior.pier${r}_end`);
      yCursor = wy1;
    }
    addSkin(B.x0, B.x1, yCursor, B.y1 + B.parapet.height, 'exterior.spandrelTop');

    // The glass in the openings, set back inside the reveal.
    const lit = new Set(B.windows.lit);
    for (let c = 0; c < WIN.cols; c++) {
      for (let r = 0; r < WIN.rows; r++) {
        const isLit = lit.has(c * WIN.rows + r);
        const gx = colX[c];
        const gy = rowY[r];
        batch.add(chamferBox(WIN.w - 0.02, WIN.h - 0.02, 0.02, 0.003, {
          seg: [1, 2, 1], at: [gx, gy, backZ + 0.012], name: 'exterior.window',
        }), isLit ? glassLit : glassOut, {
          pos: [gx, gy, backZ + 0.012], cast: false, recv: false,
        });
        // A single transom, so the openings are not four empty rectangles.
        batch.add(chamferBox(WIN.w - 0.02, 0.045, 0.03, 0.003, {
          at: [gx, gy + WIN.h * 0.16, backZ + 0.03], name: 'exterior.transom',
          colour: () => [0.42, 0.40, 0.38],
        }), brickDark, { pos: [gx, gy + WIN.h * 0.16, backZ + 0.03], cast: false, recv: false });
      }
    }

    // The coping: a pale concrete cap overhanging the parapet. It is the crispest horizontal in
    // the frame and it is what tells you the mass has a top.
    const py = B.y1 + B.parapet.height;
    batch.add(chamferBox(bw + B.parapet.overhang * 2, 0.09,
      B.depth + B.parapet.overhang, 0.004, {
        seg: [10, 1, 1], at: [bcx, py + 0.045, faceZ - B.depth * 0.5 + B.parapet.overhang * 0.5],
        name: 'exterior.coping', colour: (lx, ly, lz, nx, ny) => {
          const c = ny > 0.5 ? 0.98 : ny < -0.5 ? 0.42 : 0.72;
          return [c, c * 0.99, c * 0.97];
        },
      }), concrete, {
      pos: [bcx, py + 0.045, faceZ - B.depth * 0.5 + B.parapet.overhang * 0.5],
      cast: false, recv: false,
    });
  }

  // ── 3. the bare winter trees ────────────────────────────────────────────────────────────────
  for (const t of E.trees) {
    buildTree(batch, barkMat, { ...t, groundY: E.groundY }, cfg);
  }

  // ── 4. the balcony ──────────────────────────────────────────────────────────────────────────
  const BA = E.balcony;
  {
    const w = BA.x1 - BA.x0;
    const d = Math.abs(BA.z1 - BA.z0);
    const cx = (BA.x0 + BA.x1) * 0.5;
    const cz = (BA.z0 + BA.z1) * 0.5;
    const cy = BA.topY - BA.thickness * 0.5;
    batch.add(chamferBox(w, BA.thickness, d, 0.004, {
      seg: [Math.round(w / 0.4), 1, Math.round(d / 0.4)], at: [cx, cy, cz],
      name: 'exterior.balcony',
      colour: (lx, ly, lz, nx, ny) => {
        const wx = lx + cx;
        const wz = lz + cz;
        // Wet-looking weathered concrete: streaks running out from the building, darker at the
        // drip edge, and a rain shadow under the sill.
        let c = ny > 0.5 ? 0.92 : 0.40;
        c *= 1 + (fbm2(wx * 1.6, wz * 0.7, 0x9911, 3) - 0.5) * 0.26;
        if (ny > 0.5) c *= mix(0.80, 1.0, smoothstep(BA.z0, BA.z0 - 0.55, wz));
        return [clamp01(c), clamp01(c) * 0.99, clamp01(c) * 0.96];
      },
    }), concrete, { pos: [cx, cy, cz], cast: false, recv: false });
    // A kerb at the threshold. The balcony deck falls 30 mm below the room's boards, and without
    // this the 30 mm band at z = −4.75 is a slot you can see daylight through from crawling height.
    batch.add(chamferBox(w, 0.08, 0.13, 0.003, {
      seg: [Math.round(w / 0.5), 1, 1], at: [cx, -0.005, BA.z0 - 0.055],
      name: 'exterior.kerb',
      colour: (lx, ly, lz, nx, ny) => {
        const c = ny > 0.5 ? 0.86 : 0.44;
        return [c, c * 0.99, c * 0.96];
      },
    }), concrete, { pos: [cx, -0.005, BA.z0 - 0.055], cast: false, recv: false });
    // The drip nosing along the outer edge.
    batch.add(chamferBox(w + 0.02, 0.05, 0.035, 0.003, {
      seg: [Math.round(w / 0.5), 1, 1], at: [cx, BA.topY - 0.055, BA.z1 + 0.02],
      name: 'exterior.balconyNose', colour: () => [0.58, 0.57, 0.55],
    }), concrete, { pos: [cx, BA.topY - 0.055, BA.z1 + 0.02], cast: false, recv: false });
  }

  // ── 5. the railing ──────────────────────────────────────────────────────────────────────────
  const RA = E.railing;
  {
    const postProfile = chamferProfile([
      { x: -RA.postSize * 0.5, y: -RA.postSize * 0.5 },
      { x: RA.postSize * 0.5, y: -RA.postSize * 0.5 },
      { x: RA.postSize * 0.5, y: RA.postSize * 0.5 },
      { x: -RA.postSize * 0.5, y: RA.postSize * 0.5 },
    ], 0.0012);
    const topY = RA.y0 + RA.height;
    const barY = (RA.y0 + topY) * 0.5;
    const postColour = (px, py, pz) => {
      // Vertical value break: black steel against a bright sky is not one flat tone, it picks up
      // a sky rim on the top half and goes to nothing at the slab.
      const c = clamp01(mix(0.55, 1.35, clamp01((pz + RA.height * 0.5) / RA.height)) * 0.7);
      return [c, c, c * 1.08];
    };

    const runPosts = (from, to, axisIsX, fixed) => {
      const n = Math.max(2, Math.floor(Math.abs(to - from) / (RA.postPitch * cfg.postStep)));
      const step = (to - from) / n;
      for (let i = 0; i <= n; i++) {
        const p = from + step * i;
        const jig = (noise2(i * 2.3, axisIsX ? 1 : 9, 0x5511) - 0.5) * 0.0016;
        batch.add(prism(postProfile, RA.height, {
          axis: 'y', name: 'exterior.baluster', colour: postColour,
        }), steel, {
          pos: axisIsX ? [p, barY + jig, fixed] : [fixed, barY + jig, p],
          cast: false, recv: false,
        });
      }
    };
    const runRail = (from, to, axisIsX, fixed, y) => {
      const len = Math.abs(to - from);
      const mid = (from + to) * 0.5;
      const geo = chamferBox(
        axisIsX ? len : RA.railDepth, RA.railHeight, axisIsX ? RA.railDepth : len, 0.0015,
        {
          seg: [axisIsX ? Math.round(len / 0.5) : 1, 1, axisIsX ? 1 : Math.round(len / 0.5)],
          at: [axisIsX ? mid : fixed, y, axisIsX ? fixed : mid], name: 'exterior.rail',
          colour: (lx, ly) => {
            const c = clamp01(mix(0.42, 1.15, clamp01(ly / RA.railHeight + 0.5)) * 0.72);
            return [c, c, c * 1.08];
          },
        },
      );
      batch.add(geo, steel, {
        pos: [axisIsX ? mid : fixed, y, axisIsX ? fixed : mid], cast: false, recv: false,
      });
    };

    runPosts(RA.x0, RA.x1, true, RA.z);
    runRail(RA.x0 - 0.02, RA.x1 + 0.02, true, RA.z, topY - RA.railHeight * 0.5);
    runRail(RA.x0 - 0.02, RA.x1 + 0.02, true, RA.z, RA.y0 + 0.055);
    // The two returns back to the facade — depth cues right at the frame edges.
    for (const rx of [RA.x0, RA.x1]) {
      runPosts(RA.z, BA.z0 + 0.10, false, rx);
      runRail(RA.z, BA.z0 + 0.06, false, rx, topY - RA.railHeight * 0.5);
      runRail(RA.z, BA.z0 + 0.06, false, rx, RA.y0 + 0.055);
    }
  }

  // ── 6. the planter ──────────────────────────────────────────────────────────────────────────
  const PL = E.planter;
  {
    const w = PL.x1 - PL.x0;
    const cx = (PL.x0 + PL.x1) * 0.5;
    const cy = PL.topY - PL.h * 0.5;
    batch.add(chamferBox(w, PL.h, PL.d, 0.005, {
      seg: [Math.round(w / 0.25), 2, 2], at: [cx, cy, PL.cz], name: 'exterior.planter',
      colour: (lx, ly, lz, nx, ny) => {
        let c = ny > 0.5 ? 0.55 : 0.86;
        c *= 1 + (fbm2((lx + cx) * 3.1, (ly + cy) * 3.1, 0x2255, 3) - 0.5) * 0.24;
        // Salt bloom creeps up the outside of a terracotta trough from the bottom.
        c *= mix(1.14, 1.0, smoothstep(-PL.h * 0.5, -PL.h * 0.5 + 0.16, ly));
        return [clamp01(c), clamp01(c * 0.97), clamp01(c * 0.93)];
      },
    }), pot, { pos: [cx, cy, PL.cz], cast: false, recv: false });

    // Soil, dished slightly below the rim.
    batch.add(paramSurface(6, 3, (u, v, o) => {
      const x = mix(PL.x0 + 0.03, PL.x1 - 0.03, u);
      const z = mix(PL.cz - PL.d * 0.5 + 0.03, PL.cz + PL.d * 0.5 - 0.03, v);
      o.x = x;
      o.y = PL.topY - 0.045 - Math.sin(Math.PI * u) * Math.sin(Math.PI * v) * 0.012;
      o.z = z;
      o.u = x;
      o.v = z;
      const c = clamp01(0.55 + (fbm2(x * 6, z * 6, 0x77aa, 3) - 0.5) * 0.4);
      o.r = c;
      o.g = c;
      o.b = c;
    }, { flip: true, name: 'exterior.soil' }), soil, { cast: false, recv: false });

    // Scrappy greenery — the only saturated thing on the far side of the glass.
    const leaves = [];
    for (let k = 0; k < 4; k++) {
      leaves.push(leafCard(0.15 + 0.06 * k, 0.032 + 0.008 * k, 0.26 + 0.16 * k, 0.24));
    }
    for (let i = 0; i < PL.clumps; i++) {
      const t = (i + 0.5) / PL.clumps;
      const cxk = mix(PL.x0 + 0.09, PL.x1 - 0.09, t) + (R() - 0.5) * 0.05;
      const czk = PL.cz + (R() - 0.5) * PL.d * 0.5;
      const base = PL.topY - 0.05;
      const n = cfg.leafPerClump;
      for (let j = 0; j < n; j++) {
        const a = (j / n) * Math.PI * 2 + R() * 1.4;
        // Mostly upright with a couple of stragglers flopping over the rim — a trough of scrappy
        // greenery, not a topiary.
        const tilt = R() < 0.22 ? 0.85 + R() * 0.55 : 0.14 + R() * 0.44;
        const s = (0.75 + 0.75 * R()) * cfg.clumpScale;
        const src = leaves[(j + i) % leaves.length];
        batch.add(src.clone().scale(s, s, s), foliage, {
          pos: [cxk + Math.cos(a) * 0.02, base + R() * 0.02, czk + Math.sin(a) * 0.02],
          rot: [tilt * Math.cos(a), -a, tilt * Math.sin(a)],
          cast: false, recv: false,
        });
      }
    }
    for (const g of leaves) g.dispose();
  }
}
