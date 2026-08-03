// OPERATION NAPTIME — module ROOM — the architecture.
// OWNER: ROOM. Implements CONTRACTS.md §3: buildRoom(ctx) → { group, colliders, props, update }.
//
// This file assembles five sub-builders and owns nothing itself except the wiring, the physics and
// the prop registration. Everything the baby crawls inside is here; everything it can knock over
// belongs to FURN and DRESS.
//
//   ./room/shell.js      floor, plaster, the board-formed slab, the downstand beam, the corridor
//   ./room/glazing.js    the five-bay black-framed window wall and its sliding door
//   ./room/curtains.js   three sheer panels with real swept folds, and their track
//   ./room/radiator.js   the twenty-two-column steel radiator under the glazing
//   ./room/exterior.js   the balcony, railing, planter, four bare trees, the brick building
//
// TWO BATCHES, NOT ONE. Everything architectural accumulates per material and is merged into one
// mesh per material at flush time, so the entire window wall — jambs, head, sill, four mullions,
// two sliding leaves, the track and the handle — is a single draw call. The exterior gets its own
// batch and its own group because it must not share a bounding sphere with the room: none of it
// casts or receives a shadow (LIGHT fits the sun's shadow camera to a constant box at z ≥ −4.80,
// so every one of those objects is behind its near plane) and merging it into the room's meshes
// would drag a 30 m-wide facade into the room's culling volume.
//
// COLLIDERS ARE DESCRIPTORS, NOT MESHES. The sub-builders push `{ name, pos, size }` records and
// this file turns each into an empty Object3D plus one static Rapier cuboid. Building them from
// the merged visual meshes instead would hand Rapier a 12 000-triangle trimesh for a wall.
// The result is a sealed volume: floor, four walls, slab, beam, glazing, corridor. The baby cannot
// leave the flat, and the parent's corridor is real space rather than a black rectangle.

import * as THREE from 'three';
import { LAYOUT } from './layout.js';
import { createBatch } from './room/geom.js';
import { buildShell } from './room/shell.js';
import { buildGlazing } from './room/glazing.js';
import { buildCurtains } from './room/curtains.js';
import { buildRadiator } from './room/radiator.js';
import { buildExterior } from './room/exterior.js';

export function buildRoom(ctx) {
  if (!ctx.layout) ctx.layout = LAYOUT;

  const group = new THREE.Group();
  group.name = 'room';

  const shellGroup = new THREE.Group();
  shellGroup.name = 'room.architecture';
  group.add(shellGroup);

  const exteriorGroup = new THREE.Group();
  exteriorGroup.name = 'room.exterior';
  group.add(exteriorGroup);

  const colliderGroup = new THREE.Group();
  colliderGroup.name = 'room.colliders';
  colliderGroup.visible = false;
  group.add(colliderGroup);

  const batch = createBatch(ctx, shellGroup);
  const outBatch = createBatch(ctx, exteriorGroup);

  /** @type {Array<{name:string,pos:number[],size:number[]}>} */
  const colliderSpecs = [];
  /** @type {Array<object>} */
  const propSpecs = [];

  buildShell(ctx, batch, colliderSpecs);
  buildGlazing(ctx, batch, colliderSpecs);
  buildRadiator(ctx, batch, colliderSpecs);
  const curtains = buildCurtains(ctx, group, batch, propSpecs);
  buildExterior(ctx, outBatch);

  const meshes = batch.flush('room');
  const outMeshes = outBatch.flush('exterior');
  for (const m of outMeshes) {
    m.castShadow = false;
    m.receiveShadow = false;
  }

  // THE CUTAWAY. The reference photograph — and the `hero` shot that reproduces it — is taken from
  // 2.35 m up at z = +4.60, i.e. from a mezzanine BEHIND the entrance wall looking down into the
  // room. A solid 2.78 m wall between the lens and the set would fill the frame, so the back wall
  // merges into its own mesh (tag 'back') and hides itself whenever the camera is behind it and
  // not standing in the corridor. This is the standard archviz cutaway; three.js skips invisible
  // objects when rasterising the shadow map too, so the wall stops shadowing as well as drawing.
  const backWall = meshes.filter((m) => m.userData.tag === 'back');
  const cutZ = LAYOUT.room.maxZ + 0.04;
  const hallX0 = LAYOUT.hallway.x0 - 0.10;
  const hallX1 = LAYOUT.hallway.x1 + 0.10;
  let backVisible = true;
  const updateCutaway = () => {
    const p = ctx.camera && ctx.camera.position;
    if (!p) return;
    const behind = p.z > cutZ && !(p.x > hallX0 && p.x < hallX1);
    if (behind === !backVisible) return;
    backVisible = !behind;
    for (const m of backWall) m.visible = backVisible;
  };
  updateCutaway();

  // ── physics ─────────────────────────────────────────────────────────────────────────────────
  const colliders = [];
  if (ctx.physics) {
    for (const c of colliderSpecs) {
      const anchor = new THREE.Object3D();
      anchor.name = c.name;
      anchor.position.set(c.pos[0], c.pos[1], c.pos[2]);
      colliderGroup.add(anchor);
      anchor.updateMatrixWorld(true);
      const rec = ctx.physics.addStatic(anchor, {
        shape: 'box',
        size: c.size,
        friction: c.friction !== undefined ? c.friction : 0.78,
        restitution: c.restitution !== undefined ? c.restitution : 0.06,
        material: c.material,
        id: c.name,
      });
      if (rec) colliders.push(rec);
    }
  }

  // ── props ───────────────────────────────────────────────────────────────────────────────────
  const props = [];
  for (const spec of propSpecs) props.push(ctx.props.register(spec));

  return {
    group,
    colliders,
    props,
    meshes,
    /** Gentle idle motion. Frozen deterministically in photo mode by the curtain solver itself. */
    update(dt) {
      updateCutaway();
      curtains.update(dt);
    },
    reset() {
      curtains.reset();
    },
    dispose() {
      curtains.dispose();
    },
  };
}

export default buildRoom;
