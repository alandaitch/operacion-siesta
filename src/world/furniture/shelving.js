// FURN · the birch-ply shelving run down the left wall, and the low unit the espresso machine
// stands on at the near end.
//
// The bay grid is not a free choice: DRESS's `dressing/shelf.js` publishes a frozen model of this
// carcass (`SHELF` — x −3.22, depth 0.36, eight 0.55 m bays from z −3.20, heights
// 0.60/0.78/0.42/0.78/0.60/0.78/0.60/0.42, bottom deck top at y 0.024, the tall bays split by a
// mid shelf at 0.40) and places forty-five books, twenty records, two monitors, the vase and the
// leaning artwork against those exact numbers. So the grid below is that model, to the millimetre.
// Anything I want to jitter has to fit inside the tolerance DRESS leaves, which is why the
// misalignments here are horizontal (each bay's front plane wanders ±3 mm, each upright leans up
// to 0.3°) and never vertical — a shimmed deck would float a book.
//
// What makes it read as self-built rather than bought: uprights are SHARED between bays and run to
// the tallest of their two neighbours, so the silhouette is a staircase of stacked cubes with the
// dividers standing proud of the low decks; the carcass touches the floor only at those nine
// uprights, with the plinth recessed 25 mm so a shadow line runs the whole length underneath; and
// every exposed front is finished with a real 4 mm strip of `wood.plyEdge`, its UVs rotated 90° on
// the uprights so the fifteen laminations stack across the 18 mm instead of running up the height.
// Bodies merge into one draw call, edges into a second; colliders are exact boxes on empty proxies
// so the cubes stay hollow and DRESS can drop books inside them.

import * as THREE from 'three';
import { chamferBox, projectUV, xform, mergeParts, shadows, DEG } from './geo.js';

const T = 0.018;        // 18 mm ply
const ES = 0.004;       // the proud laminated edge
const BACK_T = 0.006;   // 6 mm back panel

// --- DRESS's frozen model. Do not drift from these. ---------------------------------------
const BAY_H = [0.60, 0.78, 0.42, 0.78, 0.60, 0.78, 0.60, 0.42];
const BAY_W = 0.55;
const Z0 = -3.20;
const X_C = -3.22;
const DEPTH = 0.36;
const DECK_Y = 0.024;   // top face of the bottom deck
const MID_Y = 0.40;     // top face of the mid shelf in the 0.78 bays
const TALL = 0.70;      // above this a bay gets a mid shelf

const X_BACK = X_C - DEPTH * 0.5;   // -3.40, against the plaster
const X_FRONT = X_C + DEPTH * 0.5;  // -3.04, the face toward the room
const PLINTH_H = DECK_Y - T;        // 6 mm of daylight under the carcass

/** Which bays got a back panel — whoever built this ran out of ply halfway down the wall. */
const HAS_BACK = [true, true, false, true, false, false, true, true];

export function buildShelving(kit) {
  const group = new THREE.Group();
  group.name = 'shelving';

  const tmPly = kit.tm('wood.ply');
  const tmEdge = kit.tm('wood.plyEdge');
  // Every panel is UV'd about its own centre, so without this each one would show the identical
  // patch of grain — eight decks cut from the same texel. A per-panel origin offset re-phases the
  // tile, which is also what cutting eight shelves out of one 2.4 m sheet actually does.
  const phase = () => [0, kit.rand(-0.6, 0.6), kit.rand(-0.6, 0.6)];
  const uvFace = () => ({ def: [tmPly[0], tmPly[1], false], origin: phase() });
  // Deck fronts: the long axis is z, the 18 mm is y → the edge tile maps straight.
  const uvEdgeH = () => ({
    x: [tmEdge[0], tmEdge[1], false], def: [tmEdge[0], tmEdge[1], false], origin: [0, 0, kit.rand(-0.3, 0.3)],
  });
  // Uprights: the long axis is y, the 18 mm is z → swap, so the plies still stack across the edge.
  const uvEdgeV = () => ({
    x: [tmEdge[0], tmEdge[1], true], def: [tmEdge[0], tmEdge[1], false], origin: [0, kit.rand(-0.3, 0.3), 0],
  });

  const faces = [];
  const edges = [];
  const bodyD = DEPTH - ES;         // the panel body stops short; the edge strip finishes it
  const LX_BODY = X_C - ES * 0.5;
  const LX_EDGE = X_FRONT - ES * 0.5;

  const bays = [];
  for (let i = 0; i < BAY_H.length; i++) {
    const z0 = Z0 + i * BAY_W;
    bays.push({
      i,
      h: BAY_H[i],
      z0,
      z1: z0 + BAY_W,
      zc: z0 + BAY_W * 0.5,
      dx: kit.rand(0, 0.005),       // this bay's front plane, up to 5 mm proud of its neighbours
    });
  }

  /** One deck: an 18 mm body inset from the front plus its laminated edge strip. */
  function deck(bay, topY, name) {
    const inner = BAY_W - T;        // the clear span between two shared uprights
    const y = topY - T * 0.5;
    const roll = kit.jit(0.22) * DEG;
    faces.push(xform(projectUV(chamferBox(bodyD, T, inner, 0.0012), uvFace()), {
      pos: [LX_BODY + bay.dx, y, bay.zc], rot: [roll, 0, 0],
    }));
    edges.push(xform(projectUV(chamferBox(ES, T, inner, 0.0008), uvEdgeH()), {
      pos: [LX_EDGE + bay.dx, y, bay.zc], rot: [roll, 0, 0],
    }));
    kit.box(group, name, [X_C + bay.dx, y, bay.zc], [DEPTH, T, inner], { material: 'wood' });
  }

  for (const bay of bays) {
    deck(bay, DECK_Y, `shelving.b${bay.i}.deck`);
    deck(bay, bay.h, `shelving.b${bay.i}.top`);
    if (bay.h > TALL) deck(bay, MID_Y, `shelving.b${bay.i}.mid`);

    // Recessed plinth: the carcass floats 6 mm off the floor between the uprights.
    faces.push(xform(projectUV(chamferBox(bodyD - 0.05, PLINTH_H, BAY_W - T - 0.01, 0.001), uvFace()), {
      pos: [LX_BODY + bay.dx - 0.025, PLINTH_H * 0.5, bay.zc],
    }));

    if (HAS_BACK[bay.i]) {
      faces.push(xform(projectUV(chamferBox(BACK_T, bay.h - T * 2, BAY_W - T, 0.0008), uvFace()), {
        pos: [X_BACK + 0.003 + BACK_T * 0.5, bay.h * 0.5, bay.zc],
      }));
    }
  }

  // --- the nine shared uprights ------------------------------------------------------------
  for (let j = 0; j <= BAY_H.length; j++) {
    const z = Z0 + j * BAY_W;
    const h = Math.max(BAY_H[j - 1] || 0, BAY_H[j] || 0);
    const dx = j === 0 ? bays[0].dx : j === bays.length ? bays[bays.length - 1].dx
      : (bays[j - 1].dx + bays[j].dx) * 0.5;
    const lean = kit.jit(0.30) * DEG;   // ~1.5 mm out of plumb at the head
    faces.push(xform(projectUV(chamferBox(bodyD, h, T, 0.0012), uvFace()), {
      pos: [LX_BODY + dx, h * 0.5, z], rot: [lean, 0, 0],
    }));
    edges.push(xform(projectUV(chamferBox(ES, h, T, 0.0008), uvEdgeV()), {
      pos: [LX_EDGE + dx, h * 0.5, z], rot: [lean, 0, 0],
    }));
    kit.box(group, `shelving.upright${j}`, [X_C + dx, h * 0.5, z], [DEPTH, h, T], { material: 'wood' });
  }

  // --- the detached low unit at the near end, under the espresso machine --------------------
  // Nothing else is placed on this one, so it gets the misalignment the run cannot afford: a real
  // 1.4° yaw and its own front plane.
  const EZ0 = 1.950;
  const EZ1 = 2.560;
  const EH = 0.530;
  const eZc = (EZ0 + EZ1) * 0.5;
  const eYaw = 1.4 * DEG;
  const eCos = Math.cos(eYaw);
  const eSin = Math.sin(eYaw);
  const eDx = 0.010;
  const eInner = EZ1 - EZ0 - T * 2;

  const eUnit = new THREE.Group();
  eUnit.name = 'shelving.espressoUnit';
  eUnit.position.set(X_C + eDx, 0, eZc);
  eUnit.rotation.y = eYaw;
  group.add(eUnit);

  /** Bake the unit's transform into the geometry so it can merge with the rest of the run. */
  const eBake = (geo, lx, ly, lz) => xform(geo, {
    pos: [X_C + eDx + lx * eCos + lz * eSin, ly, eZc - lx * eSin + lz * eCos],
    rot: [0, eYaw, 0],
  });

  for (const side of [-1, 1]) {
    const lz = side * (EZ1 - EZ0 - T) * 0.5;
    faces.push(eBake(projectUV(chamferBox(bodyD, EH, T, 0.0012), uvFace()), -ES * 0.5, EH * 0.5, lz));
    edges.push(eBake(projectUV(chamferBox(ES, EH, T, 0.0008), uvEdgeV()), DEPTH * 0.5 - ES * 0.5, EH * 0.5, lz));
    kit.box(eUnit, `shelving.e.side${side > 0 ? 'R' : 'L'}`, [0, EH * 0.5, lz], [DEPTH, EH, T], { material: 'wood' });
  }
  for (const ly of [DECK_Y - T * 0.5, EH * 0.5, EH - T * 0.5]) {
    faces.push(eBake(projectUV(chamferBox(bodyD, T, eInner, 0.0012), uvFace()), -ES * 0.5, ly, 0));
    edges.push(eBake(projectUV(chamferBox(ES, T, eInner, 0.0008), uvEdgeH()), DEPTH * 0.5 - ES * 0.5, ly, 0));
    kit.box(eUnit, `shelving.e.deck${Math.round(ly * 1000)}`, [0, ly, 0], [DEPTH, T, eInner], { material: 'wood' });
  }
  faces.push(eBake(
    projectUV(chamferBox(BACK_T, EH - T * 2, eInner, 0.0008), uvFace()),
    -DEPTH * 0.5 + 0.003 + BACK_T * 0.5, EH * 0.5, 0,
  ));
  faces.push(eBake(
    projectUV(chamferBox(bodyD - 0.05, PLINTH_H, eInner, 0.001), uvFace()),
    -ES * 0.5 - 0.025, PLINTH_H * 0.5, 0,
  ));

  const faceMesh = kit.mesh(mergeParts(faces), kit.unit('wood.ply'), 'shelving.carcasses');
  const edgeMesh = kit.mesh(mergeParts(edges), kit.unit('wood.plyEdge'), 'shelving.edges');
  group.add(faceMesh, edgeMesh);

  shadows(group, true, true);
  return {
    group,
    /** Where the espresso machine stands: the top face of the detached near-end unit. */
    espressoTop: { x: X_C + eDx, y: EH, z: eZc, yaw: eYaw },
    bays,
  };
}
