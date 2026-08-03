// FURN · the cream modular sectional.
//
// The whole object is authored in a local frame whose origin is the sofa's centre, +X pointing at
// the wall and +Z running along the wall toward the entrance; the group then carries the ~1° yaw
// that stops it being square to anything. Nothing here is a box with cushions on top: the plinth is
// recessed 30 mm so there is a real shadow gap under the carcass, every cushion is a `softBox` with
// its own sag centre, bulge and dent, each one carries two piping cords as actual swept tubes, and
// the 15 mm gaps between them show the darker upholstered deck underneath — which is the seam line
// the eye actually reads. The back cushions lean by shear rather than rotation so their bases stay
// flat on the seat. Two navy cushions, one corduroy and one twill, are propped off-centre with
// karate-chop dents.

import * as THREE from 'three';
import { softBox, chamferBox, pipingLoop, projectUV, shadows, DEG } from './geo.js';

const D = 1.50;          // depth, wall-to-front
const HD = D * 0.5;
const ARM_END = -2.10;   // far end of the run (toward the window)
const CHAISE_Z0 = 1.05;  // where the back stops and the chaise begins
const CHAISE_END = 2.35;
const CHAISE_X0 = -1.05; // the chaise reaches this far into the room
const BACK_FRONT = 0.35;
const DECK = 0.29;       // top of the upholstered seat deck
const CUSH = 0.17;       // seat cushion thickness
const ARM_W = 0.28;
const ARM_H = 0.56;
const TOP = 0.72;
const PLINTH = 0.115;
// The chaise runs at exactly the same deck and cushion height as the main seat: it is one
// continuous sectional, and DRESS drops the laptop at y 0.46 (LAYOUT.sofa.laptop) expecting to
// land on it. 0.29 + 0.17 = 0.46.
const CH_DECK = DECK;
const CH_CUSH = CUSH;

export function buildSofa(kit, origin, yaw) {
  const group = new THREE.Group();
  group.name = 'sofa';
  group.position.set(origin[0], origin[1], origin[2]);
  group.rotation.y = yaw;

  const tmV = kit.tm('fabric.velvetCream');
  const velvet = kit.unit('fabric.velvetCream');
  const deck = kit.tint('fabric.velvetCream', 0xd8ccb5, { uvRepeat: [1, 1] });
  const piping = kit.tint('fabric.velvetCream', 0xf1e7d5, { uvRepeat: [1, 1], roughRange: [0.40, 0.74] });
  const uvAll = { def: [tmV[0], tmV[1], false] };

  const add = (geo, mat, name) => {
    projectUV(geo, uvAll);
    const m = kit.mesh(geo, mat, name);
    group.add(m);
    return m;
  };

  // ── plinths ───────────────────────────────────────────────────────────────
  const runLen = CHAISE_Z0 - ARM_END;
  add(
    chamferBox(D - 0.06, PLINTH, runLen - 0.06, 0.012),
    deck, 'sofa.plinth',
  ).position.set(0, PLINTH * 0.5, (ARM_END + CHAISE_Z0) * 0.5);

  add(
    chamferBox(0.75 - CHAISE_X0 - 0.06, PLINTH, CHAISE_END - CHAISE_Z0 - 0.05, 0.012),
    deck, 'sofa.plinth.chaise',
  ).position.set((CHAISE_X0 + 0.75) * 0.5, PLINTH * 0.5, (CHAISE_Z0 + CHAISE_END) * 0.5);

  // ── carcass: the upholstered base the cushions sit in ─────────────────────
  const baseH = DECK - PLINTH + 0.02;
  add(
    softBox(D, baseH, runLen, {
      radius: 0.035, segments: 3, bulge: 0.013, bulgeAt: 0.55, wrinkle: 0.0014, seed: 811,
    }),
    velvet, 'sofa.carcass',
  ).position.set(0, PLINTH - 0.02 + baseH * 0.5, (ARM_END + CHAISE_Z0) * 0.5);

  const chBaseH = CH_DECK - PLINTH + 0.02;
  add(
    softBox(0.75 - CHAISE_X0, chBaseH, CHAISE_END - CHAISE_Z0 + 0.02, {
      radius: 0.032, segments: 3, bulge: 0.011, bulgeAt: 0.55, wrinkle: 0.0013, seed: 812,
    }),
    velvet, 'sofa.carcass.chaise',
  ).position.set((CHAISE_X0 + 0.75) * 0.5, PLINTH - 0.02 + chBaseH * 0.5, (CHAISE_Z0 + CHAISE_END) * 0.5 + 0.01);

  // ── the back ──────────────────────────────────────────────────────────────
  const backH = TOP - PLINTH + 0.03;
  add(
    softBox(0.75 - BACK_FRONT, backH, runLen, {
      radius: 0.055, segments: 4, bulge: 0.014, bulgeAt: 0.62, lean: 0.022,
      wrinkle: 0.0018, seed: 903,
    }),
    velvet, 'sofa.back',
  ).position.set((BACK_FRONT + 0.75) * 0.5 - 0.011, PLINTH - 0.03 + backH * 0.5, (ARM_END + CHAISE_Z0) * 0.5);

  // ── the arm: low, chunky, big roll ────────────────────────────────────────
  const armH = ARM_H - PLINTH + 0.03;
  add(
    softBox(D, armH, ARM_W, {
      radius: 0.115, segments: 4, bulge: 0.012, bulgeAt: 0.5, sag: 0.009, sagSpread: 1.4,
      wrinkle: 0.0016, seed: 977,
    }),
    velvet, 'sofa.arm',
  ).position.set(0, PLINTH - 0.03 + armH * 0.5, ARM_END + ARM_W * 0.5);

  // A stitched roll seam over the arm crown — one cord, following the roll.
  const armPipe = kit.mesh(
    projectUV(pipingLoop(D - 0.02, ARM_W - 0.014, 0, 0.0085, 0.1, { radialSegments: 7 }), uvAll),
    piping, 'sofa.arm.piping',
  );
  armPipe.position.set(0, ARM_H - 0.02, ARM_END + ARM_W * 0.5);
  group.add(armPipe);

  // ── seat cushions ─────────────────────────────────────────────────────────
  const seatZ0 = ARM_END + ARM_W;
  const seatSpan = CHAISE_Z0 - seatZ0;
  const gap = 0.016;
  const cw = (seatSpan - gap * 2) / 3;
  const cushFront = -HD + 0.03;        // the cushion overhangs the carcass by 30 mm
  const cushBack = BACK_FRONT + 0.02;  // and tucks 20 mm under the back
  const cushDepth = cushBack - cushFront;
  const cushX = (cushFront + cushBack) * 0.5;

  const seatSpec = [
    { sagAt: [-0.15, 0.12], sag: 0.030, yaw: 0.9, dent: null },
    { sagAt: [0.05, -0.08], sag: 0.036, yaw: -1.4, dent: { u: -0.35, v: 0.3, depth: 0.012, r: 0.5 } },
    { sagAt: [-0.05, -0.18], sag: 0.026, yaw: 1.6, dent: null },
  ];

  for (let i = 0; i < 3; i++) {
    const s = seatSpec[i];
    const z = seatZ0 + cw * 0.5 + i * (cw + gap);
    const geo = softBox(cushDepth, CUSH, cw, {
      radius: 0.05,
      segments: 5,
      sag: s.sag,
      sagAt: s.sagAt,
      sagSpread: 1.15,
      bulge: 0.026,
      bulgeAt: 0.4,
      corner: 0.006,
      dents: s.dent ? [s.dent] : null,
      wrinkle: 0.0024,
      wrinkleScale: 8,
      seed: 1200 + i * 37,
    });
    const m = add(geo, velvet, `sofa.seat.cushion${i}`);
    m.position.set(cushX, DECK + CUSH * 0.5, z + kit.jit(0.006));
    m.rotation.y = s.yaw * DEG;
    m.rotation.z = kit.jit(0.6) * DEG;

    for (const sign of [1, -1]) {
      const p = kit.mesh(
        projectUV(
          pipingLoop(cushDepth - 0.004, cw - 0.004, 0, 0.0075, 0.05, { wobble: 0.0016, seed: 300 + i, radialSegments: 6 }),
          uvAll,
        ),
        piping, `sofa.seat.piping${i}${sign > 0 ? 'T' : 'B'}`,
      );
      p.position.copy(m.position);
      p.position.y += sign * (CUSH * 0.5 - 0.028) - (sign > 0 ? s.sag * 0.35 : 0);
      p.rotation.copy(m.rotation);
      group.add(p);
    }
  }

  // ── back cushions ─────────────────────────────────────────────────────────
  const bcH = 0.31;
  const bcT = 0.23;
  for (let i = 0; i < 3; i++) {
    const z = seatZ0 + cw * 0.5 + i * (cw + gap);
    const geo = softBox(bcT, bcH, cw - 0.02, {
      radius: 0.06,
      segments: 4,
      sag: 0.012,
      sagAt: [0, kit.jit(0.3)],
      bulge: 0.022,
      bulgeAt: 0.45,
      corner: 0.008,
      lean: 0.055,
      dents: [{ u: 0.4, v: kit.jit(0.4), depth: 0.014, r: 0.55, top: false }],
      wrinkle: 0.0026,
      wrinkleScale: 9,
      seed: 1500 + i * 53,
    });
    const m = add(geo, velvet, `sofa.back.cushion${i}`);
    m.position.set(BACK_FRONT - bcT * 0.5 + 0.005, DECK + CUSH - 0.02 + bcH * 0.5, z + kit.jit(0.01));
    m.rotation.y = kit.jit(1.6) * DEG;
    m.rotation.x = kit.jit(1.2) * DEG;
  }

  // ── chaise cushions ───────────────────────────────────────────────────────
  const chW = (0.75 - CHAISE_X0) - 0.06;
  const chD = (CHAISE_END - CHAISE_Z0) - 0.05;
  for (let i = 0; i < 2; i++) {
    const w = (chW - gap) * 0.5;
    const geo = softBox(w, CH_CUSH, chD, {
      radius: 0.048,
      segments: 4,
      sag: 0.022 + i * 0.008,
      sagAt: [kit.jit(0.25), kit.jit(0.3)],
      bulge: 0.022,
      bulgeAt: 0.42,
      corner: 0.005,
      wrinkle: 0.0022,
      seed: 1800 + i * 61,
    });
    const m = add(geo, velvet, `sofa.chaise.cushion${i}`);
    m.position.set(
      CHAISE_X0 + 0.03 + w * 0.5 + i * (w + gap),
      CH_DECK + CH_CUSH * 0.5,
      (CHAISE_Z0 + CHAISE_END) * 0.5,
    );
    m.rotation.y = kit.jit(1.1) * DEG;

    const p = kit.mesh(
      projectUV(pipingLoop(w - 0.004, chD - 0.004, 0, 0.0072, 0.048, { wobble: 0.0014, seed: 420 + i, radialSegments: 6 }), uvAll),
      piping, `sofa.chaise.piping${i}`,
    );
    p.position.copy(m.position);
    p.position.y += CH_CUSH * 0.5 - 0.026;
    p.rotation.copy(m.rotation);
    group.add(p);
  }

  // ── the two navy cushions ─────────────────────────────────────────────────
  const tmRib = kit.tm('fabric.navyRib');
  const rib = kit.unit('fabric.navyRib');
  const ribGeo = softBox(0.46, 0.155, 0.46, {
    radius: 0.075,
    segments: 5,
    corner: 0.028,
    bulge: 0.018,
    sag: 0.016,
    sagAt: [0.15, -0.1],
    dents: [{ u: 0, v: 0.1, depth: 0.026, r: 0.42 }],
    wrinkle: 0.0022,
    wrinkleScale: 11,
    seed: 2201,
  });
  projectUV(ribGeo, { def: [tmRib[0], tmRib[1], false] });
  const ribMesh = kit.mesh(ribGeo, rib, 'sofa.cushion.navyRib');
  // Propped into the corner where the arm meets the back, tipped up on its edge.
  ribMesh.position.set(0.11, DECK + CUSH + 0.10, seatZ0 + 0.28);
  ribMesh.rotation.set(-64 * DEG, 12 * DEG, 6 * DEG);
  group.add(ribMesh);

  const tmFlat = kit.tm('fabric.navyFlat');
  const flat = kit.unit('fabric.navyFlat');
  const flatGeo = softBox(0.44, 0.125, 0.44, {
    radius: 0.062,
    segments: 5,
    corner: 0.03,
    bulge: 0.014,
    sag: 0.02,
    sagAt: [-0.2, 0.15],
    dents: [{ u: 0.25, v: -0.2, depth: 0.018, r: 0.5 }],
    wrinkle: 0.0019,
    wrinkleScale: 10,
    seed: 2311,
  });
  projectUV(flatGeo, { def: [tmFlat[0], tmFlat[1], false] });
  const flatMesh = kit.mesh(flatGeo, flat, 'sofa.cushion.navyFlat');
  flatMesh.position.set(cushX + 0.16, DECK + CUSH + 0.045, seatZ0 + cw * 1.5 + 0.34);
  flatMesh.rotation.set(-18 * DEG, -27 * DEG, 9 * DEG);
  group.add(flatMesh);

  // ── colliders: two simplified boxes, per the brief ────────────────────────
  kit.box(group, 'sofa.collider.main',
    [0, TOP * 0.5, (ARM_END + CHAISE_Z0) * 0.5],
    [D, TOP, runLen],
    { material: 'fabric' });
  kit.box(group, 'sofa.collider.chaise',
    [(CHAISE_X0 + 0.75) * 0.5, (CH_DECK + CH_CUSH) * 0.5, (CHAISE_Z0 + CHAISE_END) * 0.5 + 0.05],
    [0.75 - CHAISE_X0, CH_DECK + CH_CUSH, CHAISE_END - CHAISE_Z0 - 0.1],
    { material: 'fabric' });

  shadows(group, true, true);
  return {
    group,
    /** DRESS puts the laptop here — the world point of the middle seat cushion's crown. */
    laptopSeat: new THREE.Vector3(cushX, DECK + CUSH, seatZ0 + cw * 1.5 + gap),
  };
}
