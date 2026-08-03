// OPERATION NAPTIME — module FURN — every piece of furniture in the flat.
// OWNER: FURN. Implements CONTRACTS.md §2 (the layout table), §6 (props) and §11 (physics).
//
// This file is only assembly: each object lives in ./furniture/*, is authored in its own local
// frame with its origin on the floor, and is placed here at the LAYOUT coordinate with a rotation
// that is never zero. What it does own is the four decisions that cross object boundaries.
//
//  1. NOTHING SETTLES AT LOAD. Every dynamic body — ottoman, pouf, side table, floor lamp, the
//     espresso machine — is created asleep, exactly where it was authored. physics.settle() steps
//     the world before the first frame, and a sleeping body is not integrated, so the screenshot
//     harness sees the room as composed rather than as physics found it. They wake the instant the
//     baby shoves them, which is the only moment their simulation is worth paying for.
//  2. COLLIDERS ARE PROXIES, NOT MESHES. `kit.box` parks an empty Object3D at an exact size and
//     pose; PHYS never has to walk a merged 40k-triangle mesh to guess a bounding box. The
//     coffee table therefore gets three thin boxes (slab + two legs) with a genuinely empty volume
//     underneath, so the baby crawls under it, and the sofa gets two fat ones, so it does not.
//  3. THE PENDANT AND THE TEETHER HANG OFF REAL JOINTS. `physics.addPendulum` pins the point
//     (0, length, 0) of the swinging body to a fixed anchor, which means the flex and the webbing
//     strap can simply be children of that body: rigid, welded to the ceiling, zero update cost.
//  4. THE PLAYPEN DOOR IS THE TUTORIAL. It is registered as a bodiless `pullable`, so GAME runs
//     its timed-yank branch and hands us a progress event; on completion we unzip it (the slider
//     travels its real path), swing the leaf 62° on its hinge, and delete the collider that was
//     keeping the baby in. What is left is a 98 mm sill the character controller can autostep.

import * as THREE from 'three';
import { createKit, fromLayout } from './furniture/kit.js';
import { DEG } from './furniture/geo.js';
import { buildSofa } from './furniture/sofa.js';
import { buildArmchair, buildOttoman, buildPouf } from './furniture/boucle.js';
import { buildCoffeeTable, buildSideTable } from './furniture/tables.js';
import { buildShelving } from './furniture/shelving.js';
import { buildPlaypen } from './furniture/playpen.js';
import { buildFloorLamp, buildLampFlex, buildPendant } from './furniture/lamps.js';
import { buildRattanChair } from './furniture/rattan.js';
import { buildEspresso } from './furniture/espresso.js';

const DOOR_SWING = 62 * DEG;
const DOOR_TIME = 0.85;

export function buildFurniture(ctx) {
  const kit = createKit(ctx, 0xf0217e);
  const L = (path, fallback) => fromLayout(ctx, path, fallback);

  const group = new THREE.Group();
  group.name = 'furniture';

  // Anything PHYS drives lives here: an identity frame, so the transform sync never has to
  // invert a parent matrix.
  const dyn = new THREE.Group();
  dyn.name = 'furniture.dynamic';
  group.add(dyn);

  // ── the pieces ─────────────────────────────────────────────────────────────────────────
  const shelving = buildShelving(kit);
  group.add(shelving.group);

  const sofa = buildSofa(kit, [L('sofa.x', 2.55), 0, L('sofa.z', -0.50)], -0.9 * DEG);
  group.add(sofa.group);

  const armchair = buildArmchair(
    kit, [L('armchair.x', -0.35), 0, L('armchair.z', -3.45)], L('armchair.rot', 24 * DEG),
  );
  group.add(armchair.group);

  const ottoman = buildOttoman(
    kit, [L('ottoman.x', -1.45), 0, L('ottoman.z', -2.05)], L('ottoman.rot', -6 * DEG),
  );
  dyn.add(ottoman.group);

  const pouf = buildPouf(kit, [L('pouf.x', 0.95), 0, L('pouf.z', -1.35)], L('pouf.rot', 11 * DEG));
  dyn.add(pouf.group);

  const coffee = buildCoffeeTable(
    kit, [L('coffeeTable.x', 0.95), 0, L('coffeeTable.z', -2.35)], L('coffeeTable.rot', 3 * DEG),
  );
  group.add(coffee.group);

  const side = buildSideTable(kit, [L('sideTable.x', 1.70), 0, L('sideTable.z', -3.25)], -12 * DEG);
  dyn.add(side.group);

  const playpen = buildPlaypen(
    kit, [L('playpen.x', 0), 0, L('playpen.z', 2.00)], L('playpen.rot', 1.5 * DEG),
  );
  group.add(playpen.group);

  const lampX = L('floorLamp.x', 2.95);
  const lampZ = L('floorLamp.z', -4.10);
  const lamp = buildFloorLamp(kit, [lampX, 0, lampZ]);
  dyn.add(lamp.group);
  group.add(buildLampFlex(kit, [lampX - 0.12, 0, lampZ + 0.07], [lampX - 0.34, 0, lampZ - 0.20]));

  const rattan = buildRattanChair(
    kit, [L('rattanChair.x', 3.00), 0, L('rattanChair.z', 3.05)], L('rattanChair.rot', -18 * DEG),
  );
  group.add(rattan.group);

  const top = shelving.espressoTop;
  const espresso = buildEspresso(
    kit, [L('espresso.x', -3.15), top.y, top.z], top.yaw + L('espresso.rot', 8 * DEG),
  );
  dyn.add(espresso.group);

  const roseX = L('pendant.x', 0.30);
  const roseZ = L('pendant.z', -1.20);
  const roseY = L('ceiling.rose.y', 2.78);
  const pendant = buildPendant(
    kit, { x: roseX, y: roseY, z: roseZ }, roseY - L('pendant.y', 1.62),
  );
  group.add(pendant.rose);
  dyn.add(pendant.bulb);

  // The teether ring: a pendulum off the playpen's -x rail.
  const teetherAnchor = playpen.teetherAnchor.clone();
  playpen.group.updateMatrixWorld(true);
  playpen.group.localToWorld(teetherAnchor);
  playpen.ring.position.copy(teetherAnchor).setY(teetherAnchor.y - 0.135);
  playpen.ring.rotation.y = playpen.group.rotation.y;
  dyn.add(playpen.ring);

  group.updateMatrixWorld(true);

  // ── physics ────────────────────────────────────────────────────────────────────────────
  const phys = ctx.physics;
  const colliders = [];
  if (phys && phys.addStatic) {
    for (const c of kit.colliders) {
      const rec = phys.addStatic(c.object3d, c.opts);
      if (rec) colliders.push(rec);
    }
  }

  const bodies = {};
  const addDynamic = (name, object3d, spec) => {
    if (!phys || !phys.addDynamic || !spec) return null;
    const rec = phys.addDynamic(object3d, { ...spec, startAsleep: true, sleep: true });
    if (rec) bodies[name] = rec;
    return rec;
  };
  addDynamic('ottoman', ottoman.group, ottoman.dynamic);
  addDynamic('pouf', pouf.group, pouf.dynamic);
  addDynamic('sideTable', side.group, side.dynamic);
  addDynamic('floorLamp', lamp.group, lamp.dynamic);
  addDynamic('espresso', espresso.group, espresso.dynamic);

  let pendantJoint = null;
  let teetherJoint = null;
  if (phys && phys.addPendulum) {
    pendantJoint = phys.addPendulum(pendant.bulb, pendant.pendulum);
    teetherJoint = phys.addPendulum(playpen.ring, {
      anchor: { x: teetherAnchor.x, y: teetherAnchor.y, z: teetherAnchor.z },
      length: 0.135,
      segments: 1,
      radius: 0.050,
      mass: 0.055,
      shape: 'ball',
      linearDamping: 0.22,
      angularDamping: 0.5,
      restitution: 0.30,
      material: 'rubber',
    });
  }

  // ── the playpen door ───────────────────────────────────────────────────────────────────
  const door = { t: 0, target: 0, colliderLive: true, base: playpen.slider.position.clone() };

  function sliderTo(s) {
    const { zipPath, zipLen } = playpen;
    const d = Math.max(0, Math.min(zipLen[zipLen.length - 1], s));
    let i = 1;
    while (i < zipLen.length - 1 && zipLen[i] < d) i++;
    const span = Math.max(1e-6, zipLen[i] - zipLen[i - 1]);
    const t = (d - zipLen[i - 1]) / span;
    const a = zipPath[i - 1];
    const b = zipPath[i];
    playpen.slider.position.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, door.base.z);
    playpen.slider.rotation.z = Math.atan2(b.y - a.y, b.x - a.x) - Math.PI * 0.5;
  }

  function dropDoorCollider() {
    if (!door.colliderLive) return;
    door.colliderLive = false;
    if (phys && phys.remove) phys.remove(playpen.doorCollider);
  }

  function openDoor() {
    if (door.target > 0) return;
    door.target = 1;
    ctx.events?.emit('ui:toast', { key: 'toast.playpenOpen', icon: 'door', vars: {} });
  }

  // ── props ──────────────────────────────────────────────────────────────────────────────
  const props = [];
  const register = (spec) => {
    if (!ctx.props || !ctx.props.register) return null;
    const p = ctx.props.register({ labelKey: `prop.${spec.id}`, ...spec });
    if (p) props.push(p);
    return p;
  };

  register({
    id: 'pendant-bulb',
    object3d: pendant.bulb,
    body: pendantJoint ? pendantJoint.body : null,
    kind: 'knockable',
    points: 400,
    noise: 0.95,
    mass: 0.11,
    fragile: true,
  });
  register({
    id: 'floor-lamp',
    object3d: lamp.group,
    body: bodies.floorLamp ? bodies.floorLamp.body : null,
    kind: 'knockable',
    points: 350,
    noise: 0.8,
    mass: 4,
  });
  register({
    id: 'side-table',
    object3d: side.group,
    body: bodies.sideTable ? bodies.sideTable.body : null,
    kind: 'knockable',
    points: 300,
    noise: 0.75,
    mass: 5.5,
    fragile: true,
  });
  register({
    id: 'espresso-machine',
    object3d: espresso.group,
    body: bodies.espresso ? bodies.espresso.body : null,
    kind: 'knockable',
    points: 320,
    noise: 0.9,
    mass: 7.4,
  });
  register({
    id: 'pouf',
    object3d: pouf.group,
    body: bodies.pouf ? bodies.pouf.body : null,
    kind: 'pullable',
    points: 80,
    noise: 0.35,
    mass: 12,
  });
  register({
    id: 'ottoman',
    object3d: ottoman.group,
    body: bodies.ottoman ? bodies.ottoman.body : null,
    kind: 'pullable',
    points: 90,
    noise: 0.4,
    mass: 16,
    climbable: true,
  });
  register({
    id: 'playpen-teether',
    object3d: playpen.ring,
    body: teetherJoint ? teetherJoint.body : null,
    kind: 'knockable',
    points: 70,
    noise: 0.28,
    mass: 0.055,
  });
  register({
    id: 'playpen-door',
    object3d: playpen.panel,
    body: null,
    kind: 'pullable',
    points: 150,
    noise: 0.55,
    mass: 0.4,
    onTopple: openDoor,
  });

  // Scenery: no score, but GAME needs something to name and something to climb.
  register({ id: 'sofa', object3d: sofa.group, kind: 'scenery', noise: 0.2, mass: 90, climbable: true });
  register({ id: 'armchair', object3d: armchair.group, kind: 'scenery', noise: 0.2, mass: 26, climbable: true });
  register({ id: 'coffee-table', object3d: coffee.group, kind: 'scenery', noise: 0.4, mass: 34 });
  register({ id: 'rattan-chair', object3d: rattan.group, kind: 'scenery', noise: 0.45, mass: 3.4, climbable: true });

  // ── hand the two practicals to LIGHT ───────────────────────────────────────────────────
  ctx.events?.emit('light:pendant', { object3d: pendant.emitter });
  ctx.events?.emit('light:floorLamp', { object3d: lamp.head });

  // ── lifecycle ──────────────────────────────────────────────────────────────────────────
  sliderTo(0);

  return {
    group,
    colliders,
    props,
    /** DRESS may want these anchors; LAYOUT is still the source of truth for placement. */
    anchors: {
      laptopSeat: sofa.laptopSeat,
      espressoTop: shelving.espressoTop,
      shelvingBays: shelving.bays,
      pendantEmitter: pendant.emitter,
      lampHead: lamp.head,
    },

    update(dt) {
      if (ctx.state && ctx.state.mode === 'photo') return;
      if (door.t >= door.target) return;
      door.t = Math.min(door.target, door.t + dt / DOOR_TIME);
      const e = door.t * door.t * (3 - 2 * door.t);
      playpen.leaf.rotation.y = e * DOOR_SWING;
      // The zip runs first, the leaf follows: the slider is done by 55% of the animation.
      sliderTo(Math.min(1, door.t / 0.55) * playpen.zipTotal * 0.97);
      if (door.t > 0.22) dropDoorCollider();
    },

    reset() {
      door.t = 0;
      door.target = 0;
      playpen.leaf.rotation.y = 0;
      sliderTo(0);
      if (!door.colliderLive && phys && phys.addStatic) {
        const spec = kit.colliders.find((c) => c.object3d === playpen.doorCollider);
        if (spec) phys.addStatic(spec.object3d, spec.opts);
        door.colliderLive = true;
      }
      if (pendantJoint) pendantJoint.sleep();
      if (teetherJoint) teetherJoint.sleep();
    },
  };
}
