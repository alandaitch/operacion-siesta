// FURN · the glass coffee table and the marble side table.
//
// The coffee table is three pieces of 12 mm low-iron glass in a waterfall: a slab that overhangs
// its two end panels by 6 mm on each face, every arris rounded by 1.8 mm. That radius is the whole
// point — a polished glass edge is never a mathematical 90°, and the thin bright line the arris
// picks up along the top edge is what makes the slab read as *thick* rather than as a transparent
// plane. All three pieces merge into one mesh so the transmission pass copies the framebuffer once
// instead of three times.
//
// The side table is a lathe stack: a 41 mm marble top with a bullnose edge that domes over and
// tucks back under, a tapered chrome stem with a collar, and a small weighted disc base. It is a
// dynamic body with a 160 mm collider radius — narrower than the top, so a determined baby can
// actually put it on the floor, which is the point of its 300 chaos points.

import * as THREE from 'three';
import { chamferBox, lathe, xform, mergeParts, shadows, DEG } from './geo.js';

export function buildCoffeeTable(kit, origin, yaw) {
  const group = new THREE.Group();
  group.name = 'coffeeTable';
  group.position.set(origin[0], origin[1], origin[2]);
  group.rotation.y = yaw;

  const W = 1.10;
  const H = 0.36;
  const D = 0.55;
  const T = 0.012;
  const arris = 0.0018;

  const slab = xform(chamferBox(W, T, D, arris, 1), { pos: [0, H - T * 0.5, 0] });
  const legL = xform(chamferBox(T, H - T, D, arris, 1), { pos: [-(W * 0.5 - T * 0.5 - 0.006), (H - T) * 0.5, 0] });
  const legR = xform(chamferBox(T, H - T, D, arris, 1), { pos: [W * 0.5 - T * 0.5 - 0.006, (H - T) * 0.5, 0] });

  const glass = kit.mesh(mergeParts([slab, legL, legR]), kit.mat('glass.clear'), 'coffeeTable.glass');
  glass.renderOrder = 2;
  group.add(glass);

  // Thin colliders only: the volume under the slab stays empty so nothing blocks the crawl-under.
  kit.box(group, 'coffeeTable.collider.top', [0, H - T * 0.5, 0], [W, T, D], { material: 'glass', friction: 0.35 });
  kit.box(group, 'coffeeTable.collider.legL', [-(W * 0.5 - 0.012), (H - T) * 0.5, 0], [T + 0.004, H - T, D], { material: 'glass', friction: 0.35 });
  kit.box(group, 'coffeeTable.collider.legR', [W * 0.5 - 0.012, (H - T) * 0.5, 0], [T + 0.004, H - T, D], { material: 'glass', friction: 0.35 });

  shadows(group, true, false);
  return { group, top: H };
}

export function buildSideTable(kit, origin, yaw) {
  const group = new THREE.Group();
  group.name = 'sideTable';
  group.position.set(origin[0], origin[1], origin[2]);
  group.rotation.y = yaw;

  const tmM = kit.tm('marble.white');
  const tmC = kit.tm('metal.chrome');

  // Marble top: flat face, bullnose edge, tucked-back underside.
  // NB every profile below runs bottom→top. LatheGeometry derives its normals from the tangent
  // rotated clockwise, so a profile authored top→bottom comes out inside-out and back-facing —
  // which is exactly how this table was invisible before.
  const top = lathe([
    [0.0000, 0.4585],
    [0.0450, 0.4585],
    [0.0520, 0.4600],
    [0.1980, 0.4615],
    [0.2150, 0.4665],
    [0.2220, 0.4760],
    [0.2215, 0.4890],
    [0.2135, 0.4972],
    [0.1980, 0.5000],
    [0.0000, 0.5000],
  ], 56, tmM[0], tmM[1]);
  group.add(kit.mesh(top, kit.unit('marble.white'), 'sideTable.top'));

  const stem = lathe([
    [0.0000, 0.0290],
    [0.0300, 0.0290],
    [0.0300, 0.0330],
    [0.0182, 0.0420],
    [0.0163, 0.1200],
    [0.0170, 0.3200],
    [0.0182, 0.4480],
    [0.0295, 0.4555],
    [0.0290, 0.4600],
    [0.0000, 0.4600],
  ], 28, tmC[0], tmC[1]);
  group.add(kit.mesh(stem, kit.unit('metal.chrome'), 'sideTable.stem'));

  const base = lathe([
    [0.0000, 0.0000],
    [0.1180, 0.0000],
    [0.1275, 0.0025],
    [0.1300, 0.0120],
    [0.1250, 0.0235],
    [0.1120, 0.0290],
    [0.0000, 0.0290],
  ], 44, tmC[0], tmC[1]);
  group.add(kit.mesh(base, kit.unit('metal.chrome'), 'sideTable.base'));

  shadows(group, true, true);
  return {
    group,
    dynamic: {
      shape: 'cylinder',
      radius: 0.16,
      halfHeight: 0.25,
      mass: 5.5,
      friction: 0.7,
      restitution: 0.08,
      linearDamping: 0.4,
      angularDamping: 0.45,
      material: 'stone',
    },
    topY: 0.50,
  };
}
