// OPERATION NAPTIME — module ROOM — the window wall.
// OWNER: ROOM.
//
// Five metres of full-height glazing in slim matte-black aluminium, five equal bays, and a sliding
// door section in the right-hand two. This is the light source for the entire room, so the thing
// that matters most here is the SILHOUETTE OF THE FRAME: from crawling height every mullion is a
// black vertical against a blown-out exterior, and a flat box reads instantly as cardboard.
//
// So nothing here is a box. Every member is a real extruded section:
//   · the jambs are L-sections — a 12 mm face flange you see from the room and a 16 mm web that
//     runs back 90 mm into the reveal, which is why the frame has a dark inner return rather than
//     a single lit face;
//   · the mullions are T-sections, flange to the room and web back to the glazing line, so a
//     mullion catches ONE long soft highlight down its 11 mm flange and goes black on the returns.
//     That single highlight line is the whole reason the frame reads as anodised metal;
//   · the head and the sill are the same sections turned through 90° and run along X;
//   · every corner of every profile is chamfered by 1.5 mm before extrusion, so no arris anywhere
//     on the window wall is razor sharp.
//
// The slider is two leaves on two tracks 48 mm apart in depth — the outer leaf fixed, the inner one
// live — with their meeting stiles overlapping at x = 2.40, standing on a raised threshold with two
// rolled rails. That depth offset is what makes it read as a slider rather than a drawn-on mullion.
//
// The frame's vertex colours ramp from 0.42 at the back of the reveal to 1.0 at the room face, so
// even before a single light is added the sections have internal form instead of being a black
// cut-out. Against a 5-stop-brighter exterior that ramp is most of what you actually see.

import {
  prism, chamferProfile, chamferBox, surfaceMaterial, clamp01, mix,
} from './geom.js';

/** Axis-aligned rectangle profile; the caller chamfers it. */
const rect = (x0, x1, y0, y1) => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];

/** A circle, for the handle bar and its standoffs. */
function circle(r, seg = 14) {
  const pts = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return pts;
}

/**
 * An L-section frame member. Local x runs across the member's face, local y toward the room; both
 * are centred on zero, which is what `prism`'s axis remaps expect.
 * @param {number} face  the flange width seen from the room
 * @param {number} ft    flange thickness
 * @param {number} depth total depth, back of frame to room face
 * @param {number} wt    web thickness
 * @param {number} dir   +1 puts the web on the +x side of the section, -1 on the -x side
 */
function lSection(face, ft, depth, wt, dir) {
  const hx = face * 0.5;
  const hy = depth * 0.5;
  const wOut = dir > 0 ? hx : -hx;
  const wIn = dir > 0 ? hx - wt : -hx + wt;
  return chamferProfile([
    { x: -hx * dir, y: hy },       // inner edge of the flange, room face
    { x: wOut, y: hy },            // outer corner, room face
    { x: wOut, y: -hy },           // outer corner, back of frame
    { x: wIn, y: -hy },            // inner face of the web, back of frame
    { x: wIn, y: hy - ft },        // where the web meets the back of the flange
    { x: -hx * dir, y: hy - ft },  // inner edge of the flange, back face
  ], 0.0015);
}

/** A symmetric T-section mullion: flange to the room, web back to the glazing line. */
function tSection(face, ft, depth, wt) {
  const hx = face * 0.5;
  const hy = depth * 0.5;
  const hw = wt * 0.5;
  return chamferProfile([
    { x: -hx, y: hy }, { x: hx, y: hy }, { x: hx, y: hy - ft },
    { x: hw, y: hy - ft }, { x: hw, y: -hy }, { x: -hw, y: -hy }, { x: -hx, y: hy - ft },
  ], 0.0015);
}

/**
 * @param {object} ctx
 * @param {object} batch the shared geometry batcher
 * @param {Array} colliders
 */
export function buildGlazing(ctx, batch, colliders) {
  const L = ctx.layout;
  const G = L.glazing;
  const SL = G.slider;
  const zc = (G.frameBack + G.frameFront) * 0.5;
  const depth = G.frameDepth;

  const frameMat = surfaceMaterial(ctx, 'metal.blackAnodised');
  const glassMat = surfaceMaterial(ctx, 'glass.window', { vertexColors: false });
  const handleMat = surfaceMaterial(ctx, 'metal.blackAnodised', { tint: 0x35383d });

  /** Depth ramp: 0.42 at the back of the reveal, 1.0 at the room face. `z` is world. */
  const shade = (z) => {
    const t = clamp01((z - G.frameBack) / depth);
    const c = mix(0.42, 1.0, t * t * 0.65 + t * 0.35);
    return [c, c, c * 1.02];
  };
  // For every extruded member, `prism` hands the colour callback LOCAL profile coordinates and its
  // local y is world Z by construction — so this is the same one-liner for jambs, head, sill and
  // mullions regardless of which way they run.
  const memberColour = (px, py) => shade(py + zc);

  const midY = (G.sillY + G.headY) * 0.5;
  const runY = G.headY - G.sillY;
  const headBottom = G.headY - G.headWidth;
  const sillTop = G.sillY + G.sillWidth;

  // ── the perimeter frame ─────────────────────────────────────────────────────────────────────
  for (const j of [{ x: G.x0 + G.jambWidth * 0.5, dir: -1 }, { x: G.x1 - G.jambWidth * 0.5, dir: 1 }]) {
    const geo = prism(lSection(G.jambWidth, 0.012, depth, 0.016, j.dir), runY, {
      axis: 'y', name: 'glazing.jamb', colour: memberColour,
    });
    batch.add(geo, frameMat, { pos: [j.x, midY, zc], cast: true, recv: true });
  }

  // Head: for an 'x' member the profile's local x IS world Y, so dir +1 sends the web up into the
  // soffit. The head runs the full opening; the sill stops where the slider threshold takes over.
  {
    const geo = prism(lSection(G.headWidth, 0.012, depth, 0.016, 1), G.x1 - G.x0, {
      axis: 'x', name: 'glazing.head', colour: memberColour,
    });
    batch.add(geo, frameMat, {
      pos: [(G.x0 + G.x1) * 0.5, G.headY - G.headWidth * 0.5, zc], cast: true, recv: true,
    });
  }
  {
    const len = SL.x0 - G.x0;
    const geo = prism(lSection(G.sillWidth, 0.014, depth, 0.018, -1), len, {
      axis: 'x', name: 'glazing.sill', colour: memberColour,
    });
    batch.add(geo, frameMat, {
      pos: [G.x0 + len * 0.5, G.sillY + G.sillWidth * 0.5, zc], cast: true, recv: true,
    });
  }

  // ── the intermediate mullions ───────────────────────────────────────────────────────────────
  // Three of them: -0.60, 0.40 and 1.40. The fourth notional line at x = 2.40 is where the two
  // sliding leaves meet, and their stiles do that job — which is the whole point of a slider.
  const mullions = G.mullionX.filter((x) => x <= SL.x0 + 1e-6);
  for (const mx of mullions) {
    const geo = prism(tSection(G.mullionWidth, 0.011, depth, 0.020), runY, {
      axis: 'y', name: 'glazing.mullion', colour: memberColour,
    });
    batch.add(geo, frameMat, { pos: [mx, midY, zc], cast: true, recv: true });
  }

  // ── fixed glass ─────────────────────────────────────────────────────────────────────────────
  {
    const edges = [G.x0, ...mullions.filter((x) => x > G.x0 + 1e-6 && x < SL.x0 - 1e-6), SL.x0];
    const h = headBottom - sillTop;
    const cy = (headBottom + sillTop) * 0.5;
    for (let i = 0; i < edges.length - 1; i++) {
      // Tuck 5 mm behind the flange either side, so no pane edge is ever visible as a bright line.
      const a = edges[i] + (i === 0 ? G.jambWidth : G.mullionWidth * 0.5) - 0.005;
      const b = edges[i + 1] - G.mullionWidth * 0.5 + 0.005;
      const w = b - a;
      if (w <= 0.02) continue;
      const cx = (a + b) * 0.5;
      const geo = chamferBox(w, h, G.glassThickness, 0.0015, {
        seg: [2, 4, 1], at: [cx, cy, G.glassZ], name: 'glazing.pane',
      });
      batch.add(geo, glassMat, { pos: [cx, cy, G.glassZ], cast: false, recv: false });
    }
  }

  // ── the sliding door ────────────────────────────────────────────────────────────────────────
  // The threshold: a raised block off the floor with two rolled rails on top, one per leaf depth.
  // Twelve millimetres of geometry that does more for the "this is a door" read than the leaves.
  const trackLen = SL.x1 - SL.x0;
  const trackCx = (SL.x0 + SL.x1) * 0.5;
  {
    const h = SL.trackY - 0.005;
    const geo = chamferBox(trackLen, h, depth - 0.004, 0.0015, {
      seg: [14, 2, 2], at: [trackCx, 0.005 + h * 0.5, zc], name: 'glazing.threshold',
      colour: (lx, ly) => shade(zc + 0.0) && [
        mix(0.5, 0.78, clamp01((ly + h * 0.5) / h)),
        mix(0.5, 0.78, clamp01((ly + h * 0.5) / h)),
        mix(0.5, 0.80, clamp01((ly + h * 0.5) / h)),
      ],
    });
    batch.add(geo, frameMat, { pos: [trackCx, 0.005 + h * 0.5, zc], cast: true, recv: true });
    for (const rz of [SL.fixed.z, SL.slide.z]) {
      const rail = chamferBox(trackLen, SL.trackRise, 0.009, 0.001, {
        seg: [14, 1, 1], at: [trackCx, SL.trackY + SL.trackRise * 0.5, rz],
        name: 'glazing.trackRail', colour: () => [0.74, 0.74, 0.77],
      });
      batch.add(rail, frameMat, {
        pos: [trackCx, SL.trackY + SL.trackRise * 0.5, rz], cast: true, recv: true,
      });
    }
  }

  // The two leaves: a rectangular tube of stiles and rails around a pane.
  const leafBottom = SL.trackY + SL.trackRise;
  const leafTop = headBottom - 0.006; // the head-track gap
  const buildLeaf = (leaf) => {
    const h = leafTop - leafBottom;
    const cy = (leafTop + leafBottom) * 0.5;
    const sw = SL.stileWidth;
    const rh = SL.railHeight;
    const halfD = 0.019;
    const stileProfile = chamferProfile(rect(-sw * 0.5, sw * 0.5, -halfD, halfD), 0.0015);
    for (const sx of [leaf.x0 + sw * 0.5, leaf.x1 - sw * 0.5]) {
      batch.add(prism(stileProfile, h, {
        axis: 'y', name: 'glazing.stile', colour: (px, py) => shade(py + leaf.z),
      }), frameMat, { pos: [sx, cy, leaf.z], cast: true, recv: true });
    }
    const railProfile = chamferProfile(rect(-rh * 0.5, rh * 0.5, -halfD, halfD), 0.0015);
    for (const ry of [leafBottom + rh * 0.5, leafTop - rh * 0.5]) {
      batch.add(prism(railProfile, leaf.x1 - leaf.x0 - sw * 2, {
        axis: 'x', name: 'glazing.rail', colour: (px, py) => shade(py + leaf.z),
      }), frameMat, { pos: [(leaf.x0 + leaf.x1) * 0.5, ry, leaf.z], cast: true, recv: true });
    }
    const gw = (leaf.x1 - leaf.x0) - sw * 2 + 0.008;
    const gh = h - rh * 2 + 0.008;
    const cx = (leaf.x0 + leaf.x1) * 0.5;
    batch.add(chamferBox(gw, gh, G.glassThickness, 0.0015, {
      seg: [2, 4, 1], at: [cx, cy, leaf.glassZ], name: 'glazing.leafPane',
    }), glassMat, { pos: [cx, cy, leaf.glassZ], cast: false, recv: false });
  };
  buildLeaf(SL.fixed);
  buildLeaf(SL.slide);

  // The handle: a vertical D-bar standing 48 mm off the live leaf. It is small, and it is the only
  // curved thing on the entire window wall, which is exactly why the eye finds it.
  {
    const hd = SL.handle;
    const barZ = SL.slide.z + hd.standoff;
    batch.add(prism(circle(hd.radius, 12), hd.y1 - hd.y0, {
      axis: 'y', name: 'glazing.handleBar', colour: () => [0.96, 0.96, 0.98],
    }), handleMat, { pos: [hd.x, (hd.y0 + hd.y1) * 0.5, barZ], cast: true, recv: true });
    const armLen = hd.standoff + 0.012;
    for (const ay of [hd.y0 + 0.035, hd.y1 - 0.035]) {
      batch.add(prism(circle(hd.radius * 0.85, 10), armLen, {
        name: 'glazing.handleArm', colour: () => [0.88, 0.88, 0.90],
      }), handleMat, {
        pos: [hd.x, ay, SL.slide.z + armLen * 0.5 - 0.006], cast: true, recv: true,
      });
    }
  }

  // ── colliders ───────────────────────────────────────────────────────────────────────────────
  // One slab across the whole opening. The baby is not getting onto that balcony.
  colliders.push({
    name: 'room.glazing',
    pos: [(G.x0 + G.x1) * 0.5, G.headY * 0.5, G.glassZ],
    size: [G.x1 - G.x0, G.headY, 0.09],
    friction: 0.25,
    restitution: 0.05,
  });
  colliders.push({
    name: 'room.threshold',
    pos: [trackCx, SL.trackY * 0.5, zc],
    size: [trackLen, SL.trackY + SL.trackRise, depth],
  });

  return { frameMat, glassMat };
}
