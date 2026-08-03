// FURN · the cane chair clipped by the bottom-right corner of the reference photograph.
//
// The whole object exists to be looked at closely from 40 cm off the floor, so the seat and the
// back are NOT the `rattan` cutout material on a quad. They are the actual weave: three strand
// families (warp, weft and one diagonal) swept as flattened tubes that undulate ±1.2 mm and pass
// genuinely over and under each other — warp j rides over weft i wherever (i + j) is even, which
// is the whole of plain weave in one line of arithmetic. You can see daylight through the holes,
// each strand casts its own shadow on the one below it, and the octagonal gaps left by the
// diagonal family are what makes it read as *cane* rather than as basket-weave wallpaper.
//
// That costs ~22k triangles, so it is gated: below the `high` tier the panels fall back to the
// `rattan` material's alphaMap cutout on a lightly dished quad, which is the same weave drawn by
// the texture generator and, at the distance those tiers are targeting, indistinguishable.
//
// The frame is bentwood: no straight members anywhere, every leg splayed and slightly curved, the
// back hoop a single sweep rising from the seat ring to 0.74 m and back down.

import * as THREE from 'three';
import {
  tubeThrough, deformGeometry, scaleUV, xform, mergeParts, shadows, clamp, DEG,
} from './geo.js';

const SEAT_Y = 0.425;
const SEAT_RX = 0.243;
const SEAT_RZ = 0.228;

/**
 * A plain-weave cane panel in the XZ plane, normal +Y, centred on the origin.
 * Strands are round tubes squashed to a 0.42 aspect on Y, so one scale flattens every family.
 */
function caneWeave({
  w, d, pitch = 0.022, strandR = 0.0029, flat = 0.42, amp = 0.0030,
  diagonal = true, ellipse = null, seed = 31,
}) {
  const parts = [];
  const inside = (x, z) => {
    if (!ellipse) return Math.abs(x) <= w * 0.5 && Math.abs(z) <= d * 0.5;
    return (x / ellipse[0]) ** 2 + (z / ellipse[1]) ** 2 <= 1;
  };
  /** March along `dir` from the centre line and keep the part that is inside the outline. */
  const strand = (ox, oz, dx, dz, phase, lift) => {
    const half = Math.max(w, d) * 0.75;
    const step = pitch * 0.5;
    let run = [];
    for (let t = -half; t <= half + 1e-6; t += step) {
      const x = ox + dx * t;
      const z = oz + dz * t;
      if (!inside(x, z)) {
        if (run.length > 3) parts.push(tubeThrough(run, strandR, { radialSegments: 4, tubularSegments: run.length }));
        run = [];
        continue;
      }
      const u = (dx !== 0 ? x : z) / pitch;
      run.push(new THREE.Vector3(x, lift + amp * Math.cos(Math.PI * u + phase), z));
    }
    if (run.length > 3) parts.push(tubeThrough(run, strandR, { radialSegments: 4, tubularSegments: run.length }));
  };

  const nx = Math.ceil(w / pitch * 0.5);
  const nz = Math.ceil(d / pitch * 0.5);
  for (let j = -nz; j <= nz; j++) strand(0, j * pitch, 1, 0, j * Math.PI, 0);
  for (let i = -nx; i <= nx; i++) strand(i * pitch, 0, 0, 1, i * Math.PI + Math.PI, 0);

  if (diagonal) {
    const dp = pitch * 2;
    const s = Math.SQRT1_2;
    const n = Math.ceil((w + d) / dp * 0.5);
    for (let k = -n; k <= n; k++) {
      strand(k * dp * s, -k * dp * s, s, s, k * Math.PI, amp * 1.55);
    }
  }
  const geo = mergeParts(parts);
  if (!geo) return null;
  return xform(geo, { scale: [1, flat, 1] });
}

export function buildRattanChair(kit, origin, yaw) {
  const group = new THREE.Group();
  group.name = 'rattanChair';
  group.position.set(origin[0], origin[1], origin[2]);
  group.rotation.y = yaw;
  group.rotation.x = 0.5 * DEG;   // one leg is fractionally short, as ever

  const cane = kit.tint('wood.birchToy', 0xcaa068, { roughRange: [0.34, 0.62] });
  const frameMat = kit.tint('wood.oak', 0xc09963, { roughRange: [0.36, 0.60] });
  const detailed = kit.atLeast('high');

  // --- the frame ------------------------------------------------------------------------
  const frame = [];

  /** Seat ring and the lower stretcher: bent tubes, slightly out of round. */
  const ring = (rx, rz, y, tubeR, wobble, seg) => {
    const pts = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const k = 1 + Math.sin(a * 3 + 0.7) * wobble;
      pts.push(new THREE.Vector3(Math.sin(a) * rx * k, y + Math.sin(a * 2) * wobble * 0.5, Math.cos(a) * rz * k));
    }
    return tubeThrough(pts, tubeR, { radialSegments: 6, closed: true, tubularSegments: seg * 3 });
  };
  frame.push(scaleUV(ring(SEAT_RX, SEAT_RZ, SEAT_Y, 0.0165, 0.012, 22), 6, 0.6));
  frame.push(scaleUV(ring(SEAT_RX * 0.80, SEAT_RZ * 0.80, 0.145, 0.0105, 0.016, 18), 6, 0.5));

  // Four splayed legs, each with its own bow.
  const legAt = [[-0.66, 0.02], [0.66, -0.02], [2.42, 0.03], [3.76, -0.01]];
  for (let i = 0; i < 4; i++) {
    const a = legAt[i][0] + legAt[i][1];
    const sx = Math.sin(a);
    const sz = Math.cos(a);
    const topX = sx * SEAT_RX * 0.96;
    const topZ = sz * SEAT_RZ * 0.96;
    const splay = 1.30 + kit.rand(-0.05, 0.05);
    frame.push(scaleUV(tubeThrough([
      new THREE.Vector3(topX * splay, 0.004, topZ * splay),
      new THREE.Vector3(topX * (splay * 0.55 + 0.45) * 1.02, 0.145, topZ * (splay * 0.55 + 0.45) * 1.02),
      new THREE.Vector3(topX * 1.01, 0.32, topZ * 1.01),
      new THREE.Vector3(topX, SEAT_Y + 0.012, topZ),
    ], 0.0145, { radialSegments: 6, tubularSegments: 16 }), 4, 0.5));
  }

  // The back hoop: one sweep from the seat ring up to 0.74 and down again, leaning back 11°.
  const hoop = [];
  for (let i = 0; i <= 26; i++) {
    const t = i / 26;
    const a = Math.PI * (0.30 + t * 1.40);          // around the back of the seat ring
    const rise = Math.sin(Math.PI * clamp((t - 0.06) / 0.88, 0, 1));
    const y = SEAT_Y - 0.02 + rise * 0.335;
    const lean = rise * 0.075;                       // the top of the hoop rocks back
    hoop.push(new THREE.Vector3(
      Math.sin(a) * SEAT_RX * (1 - rise * 0.12),
      y,
      Math.cos(a) * SEAT_RZ * (1 - rise * 0.10) + lean,
    ));
  }
  frame.push(scaleUV(tubeThrough(hoop, 0.0155, { radialSegments: 7, tubularSegments: 60 }), 8, 0.6));

  // Two uprights inside the hoop, holding the back panel.
  for (const s of [-1, 1]) {
    frame.push(scaleUV(tubeThrough([
      new THREE.Vector3(s * 0.145, SEAT_Y - 0.01, 0.176),
      new THREE.Vector3(s * 0.140, SEAT_Y + 0.14, 0.204),
      new THREE.Vector3(s * 0.121, SEAT_Y + 0.30, 0.238),
    ], 0.0105, { radialSegments: 5, tubularSegments: 10 }), 4, 0.4));
  }

  group.add(kit.mesh(mergeParts(frame), frameMat, 'rattanChair.frame'));

  // --- the woven panels -----------------------------------------------------------------
  if (detailed) {
    const seat = caneWeave({
      w: SEAT_RX * 2, d: SEAT_RZ * 2, pitch: 0.0225, ellipse: [SEAT_RX - 0.012, SEAT_RZ - 0.012], seed: 41,
    });
    if (seat) {
      // Somebody has been sitting in it: the weave dishes 14 mm in the middle.
      deformGeometry(seat, (v) => {
        const r2 = (v.x / SEAT_RX) ** 2 + (v.z / SEAT_RZ) ** 2;
        v.y -= 0.014 * Math.max(0, 1 - r2) ** 0.85;
      });
      const m = kit.mesh(seat, cane, 'rattanChair.seat');
      m.position.y = SEAT_Y + 0.008;
      group.add(m);
    }

    const back = caneWeave({ w: 0.30, d: 0.285, pitch: 0.0215, diagonal: true, seed: 43 });
    if (back) {
      deformGeometry(back, (v) => {
        v.y -= 0.010 * Math.max(0, 1 - (v.x / 0.16) ** 2);   // the back panel bellies backward
      });
      const m = kit.mesh(back, cane, 'rattanChair.back');
      m.rotation.set(Math.PI * 0.5 - 11 * DEG, 0, 0);
      m.position.set(0, SEAT_Y + 0.155, 0.200);
      group.add(m);
    }
  } else {
    const flatMat = kit.mat('rattan');
    const seat = new THREE.CircleGeometry(SEAT_RX - 0.014, 26);
    seat.scale(1, SEAT_RZ / SEAT_RX, 1);
    seat.rotateX(-Math.PI * 0.5);
    scaleUV(seat, (SEAT_RX * 2) / 0.45, (SEAT_RZ * 2) / 0.45);
    const sm = kit.mesh(seat, flatMat, 'rattanChair.seat', { cast: false });
    sm.position.y = SEAT_Y + 0.004;
    group.add(sm);

    const back = new THREE.PlaneGeometry(0.30, 0.285, 1, 1);
    scaleUV(back, 0.30 / 0.45, 0.285 / 0.45);
    const bm = kit.mesh(back, flatMat, 'rattanChair.back', { cast: false });
    bm.rotation.set(-11 * DEG, 0, 0);
    bm.position.set(0, SEAT_Y + 0.155, 0.198);
    group.add(bm);
  }

  // --- colliders ------------------------------------------------------------------------
  kit.box(group, 'rattanChair.seat.collider', [0, SEAT_Y - 0.02, 0], [SEAT_RX * 2, 0.07, SEAT_RZ * 2], { material: 'wicker' });
  kit.box(group, 'rattanChair.back.collider', [0, SEAT_Y + 0.17, 0.205], [SEAT_RX * 1.9, 0.34, 0.07], { material: 'wicker' });
  for (let i = 0; i < 4; i++) {
    const a = legAt[i][0] + legAt[i][1];
    kit.box(group, `rattanChair.leg${i}`,
      [Math.sin(a) * SEAT_RX * 1.15, 0.21, Math.cos(a) * SEAT_RZ * 1.15],
      [0.045, 0.42, 0.045], { material: 'wicker' });
  }

  shadows(group, true, true);
  return { group };
}
