// OPERATION NAPTIME — module ROOM — the white steel column radiator under the glazing.
// OWNER: ROOM.
//
// This object exists for one reason: it is the only thing in the room that sits *between* the
// crawling camera and the brightest surface in the frame. Everything about it is therefore a
// silhouette problem, and a silhouette is exactly what a box does not have.
//
// So it is built the way the real thing is welded. `tubeChainProfile` (geom.js) unions four
// circular tubes on a 19 mm pitch into one scalloped section — adjacent circles meet at
// ±acos(gap / 2r) from the axis, so each interior tube only contributes the arc between those two
// angles and the outline comes out exact. Twenty-two of those sections stand side by side on a
// 45.5 mm pitch with a 6.5 mm slot between them, and it is that comb of slots, backlit by five
// metres of window, that makes the object read.
//
// On top of the columns is a real slotted top grille (two edge rails plus one bar per column, so
// you can see down into the dark between the tubes), behind them two wall brackets, and at each
// end a chrome tail: a thermostatic valve on the right, a lockshield on the left, both dropping
// through a floor escutcheon. Every arris on the flat parts is chamfered by 1.2–1.5 mm.
//
// One clash resolution: LAYOUT puts the radiator at z = −4.520 with a 95 mm depth, whose back face
// lands 2.5 mm inside the glazing frame's room face at −4.570. The back is clamped forward by
// 1.5 mm rather than left interpenetrating — a Z-fighting flicker on a bright vertical edge is one
// of the loudest artefacts a still frame can carry.

import {
  chamferBox, prism, chamferProfile, tubeChainProfile,
  surfaceMaterial, noise2, smoothstep, clamp01, mix,
} from './geom.js';

/** A regular polygon, for the pipework. */
function circle(r, seg = 12) {
  const pts = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return pts;
}

/**
 * @param {object} ctx
 * @param {object} batch the shared geometry batcher
 * @param {Array} colliders
 */
export function buildRadiator(ctx, batch, colliders) {
  const L = ctx.layout;
  const D = L.radiator;
  const G = L.glazing;
  const tier = ctx.quality?.tier || 'high';
  const arcSteps = tier === 'low' ? 3 : tier === 'medium' ? 4 : 5;

  const steel = surfaceMaterial(ctx, 'metal.steelWhite');
  const chrome = surfaceMaterial(ctx, 'metal.chrome');
  const knob = surfaceMaterial(ctx, 'plastic.matte', { tint: 0xe7e4dd, roughRange: [0.34, 0.58] });

  // Clamp the back face clear of the window frame; see the header note.
  const halfD = D.d * 0.5;
  const zBack = Math.max(D.z - halfD, G.frameFront + 0.0015);
  const zc = zBack + halfD;
  const yc = D.y;
  const h = D.h;

  // ── the columns ─────────────────────────────────────────────────────────────────────────────
  // Local x is world X (the 39 mm width of one column), local y is world Z (its 96 mm depth).
  const section = tubeChainProfile(D.tubes, D.tubeRadius, D.tubeGap, arcSteps);
  const depthHalf = D.tubeRadius + (D.tubes - 1) * D.tubeGap * 0.5;

  for (let i = 0; i < D.columns; i++) {
    const x = D.x0 + D.columnPitch * (i + 0.5);
    // Every column is very slightly different: real ones are pressed, painted and knocked.
    const wob = (noise2(i * 1.7, 3.1, 0x9a11) - 0.5) * 0.0015;
    const geo = prism(section, h, {
      axis: 'y',
      name: 'radiator.column',
      colour: (px, py, pz, nx) => {
        // Front faces catch the window; the scalloped returns between tubes go dark, and the
        // sideways-facing arcs are occluded by the neighbouring column 6.5 mm away.
        const front = clamp01(py / depthHalf * 0.5 + 0.5);
        let c = mix(0.46, 1.0, Math.pow(front, 1.35));
        c *= mix(0.58, 1.0, 1 - Math.abs(nx) * 0.92);
        // Dust and a faint rust bloom collect low down and at the joints.
        c *= mix(0.82, 1.0, smoothstep(-h * 0.5, -h * 0.5 + 0.14, pz));
        c *= 1 + (noise2(px * 40 + i * 3.3, pz * 26, 0x2f7c) - 0.5) * 0.06;
        c = clamp01(c);
        return [c, c * 0.998, c * 0.985];
      },
    });
    batch.add(geo, steel, { pos: [x + wob, yc, zc], cast: true, recv: true });
  }

  // ── the top grille ──────────────────────────────────────────────────────────────────────────
  // Two edge rails and one bar per column. The slots between the bars show the dark cavity, which
  // is the only place in the object where the value drops to near-black — and that is what stops
  // the whole thing reading as a white cut-out.
  {
    const gy = D.grilleY;
    const gw = D.w + 0.010;
    const gcx = (D.x0 + D.x1) * 0.5;
    for (const rz of [zc - depthHalf - 0.004, zc + depthHalf + 0.004]) {
      batch.add(chamferBox(gw, 0.008, 0.012, 0.0012, {
        seg: [Math.round(gw / 0.2), 1, 1], at: [gcx, gy, rz], name: 'radiator.grilleRail',
        colour: (lx, ly) => {
          const c = mix(0.62, 1.0, clamp01(ly / 0.008 + 0.5));
          return [c, c, c * 0.99];
        },
      }), steel, { pos: [gcx, gy, rz], cast: true, recv: true });
    }
    const slotD = depthHalf * 2 - 0.006;
    for (let i = 0; i < D.columns; i++) {
      const x = D.x0 + D.columnPitch * (i + 0.5);
      batch.add(chamferBox(D.columnPitch * 0.66, 0.006, slotD, 0.0010, {
        at: [x, gy, zc], name: 'radiator.grilleBar',
        colour: (lx, ly) => {
          const c = mix(0.50, 0.98, clamp01(ly / 0.006 + 0.5));
          return [c, c, c * 0.99];
        },
      }), steel, { pos: [x, gy, zc], cast: true, recv: false });
    }
    // End caps, so the grille does not float off the ends of the comb.
    for (const ex of [D.x0 - 0.004, D.x1 + 0.004]) {
      batch.add(chamferBox(0.010, 0.010, slotD + 0.012, 0.0012, {
        at: [ex, gy - 0.001, zc], name: 'radiator.grilleEnd', colour: () => [0.80, 0.80, 0.80],
      }), steel, { pos: [ex, gy - 0.001, zc], cast: true, recv: true });
    }
  }

  // ── the wall brackets ───────────────────────────────────────────────────────────────────────
  // Behind the radiator, so mostly what you get is a sliver of dark between the columns and the
  // reveal. That sliver is worth the forty triangles.
  for (const bx of [D.x0 + 0.15, D.x1 - 0.15]) {
    const plateH = 0.20;
    const plateY = yc + 0.10;
    batch.add(chamferBox(0.030, plateH, 0.008, 0.0012, {
      at: [bx, plateY, D.bracketZ], name: 'radiator.bracketPlate',
      colour: () => [0.44, 0.44, 0.45],
    }), steel, { pos: [bx, plateY, D.bracketZ], cast: true, recv: true });
    const armZ0 = D.bracketZ + 0.004;
    const armZ1 = zBack + 0.010;
    batch.add(chamferBox(0.014, 0.010, armZ1 - armZ0, 0.0012, {
      at: [bx, plateY + plateH * 0.5 - 0.012, (armZ0 + armZ1) * 0.5], name: 'radiator.bracketArm',
      colour: () => [0.52, 0.52, 0.53],
    }), steel, {
      pos: [bx, plateY + plateH * 0.5 - 0.012, (armZ0 + armZ1) * 0.5], cast: true, recv: true,
    });
  }

  // ── valve, lockshield and their tails ───────────────────────────────────────────────────────
  // The tails rise 12 mm PROUD of the column faces rather than inside them, which is both what an
  // angled valve actually does and the only way an 8.5 mm pipe does not end up buried in the comb.
  const tailZ = zc + depthHalf + 0.012;
  const tailTop = D.valve.y + 0.02;
  const mirrorX = D.x0 + (D.x1 - D.valve.x);
  for (const t of [{ x: D.valve.x, head: true }, { x: mirrorX, head: false }]) {
    // The drop to the floor, plus the escutcheon that hides the hole in the boards.
    batch.add(prism(circle(0.0085, 10), tailTop, {
      axis: 'y', name: 'radiator.tail', colour: () => [0.90, 0.90, 0.94],
    }), chrome, { pos: [t.x, tailTop * 0.5, tailZ], cast: true, recv: true });
    batch.add(prism(chamferProfile(circle(0.024, 12), 0.002), 0.006, {
      name: 'radiator.escutcheon', colour: () => [0.86, 0.86, 0.89],
    }), chrome, { pos: [t.x, 0.004, tailZ], rot: [Math.PI / 2, 0, 0], cast: false, recv: true });
    // The valve body: a squat hex, then either a thermostatic head or a plain lockshield cap.
    batch.add(prism(chamferProfile(circle(D.valve.radius, 6), 0.0015), 0.034, {
      axis: 'y', name: 'radiator.valveBody', colour: () => [0.78, 0.78, 0.82],
    }), chrome, { pos: [t.x, tailTop + 0.017, tailZ], cast: true, recv: true });
    // The elbow back into the bottom tapping of the end column.
    batch.add(prism(circle(0.0085, 10), 0.040, {
      name: 'radiator.elbow', colour: () => [0.88, 0.88, 0.92],
    }), chrome, { pos: [t.x, tailTop + 0.030, tailZ - 0.020], cast: true, recv: true });
    if (t.head) {
      batch.add(prism(chamferProfile(circle(0.021, 14), 0.002), 0.046, {
        axis: 'y', name: 'radiator.valveHead', colour: (px, py, pz) => {
          const c = mix(0.70, 1.0, clamp01(pz / 0.046 + 0.5));
          return [c, c, c * 0.98];
        },
      }), knob, { pos: [t.x, tailTop + 0.057, tailZ], cast: true, recv: true });
    } else {
      batch.add(prism(chamferProfile(circle(0.014, 10), 0.0015), 0.018, {
        axis: 'y', name: 'radiator.lockshield', colour: () => [0.82, 0.82, 0.86],
      }), chrome, { pos: [t.x, tailTop + 0.043, tailZ], cast: true, recv: true });
    }
  }

  // ── the collider ────────────────────────────────────────────────────────────────────────────
  colliders.push({
    name: 'room.radiator',
    pos: [D.cx, yc, zc],
    size: [D.w + 0.02, D.grilleY - 0.02, depthHalf * 2 + 0.02],
    friction: 0.42,
    restitution: 0.08,
    material: 'metal',
  });

  return { steel, chrome, zc, depthHalf };
}
