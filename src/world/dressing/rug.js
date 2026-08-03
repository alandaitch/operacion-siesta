// OPERATION NAPTIME — module DRESS — the cream wool rug.
//
// The rug is the bounce card for the entire room: it is the largest bright surface below the
// window and the reason the undersides of the furniture are lit at all. It is also the single
// easiest object to get wrong, because a rug modelled as a plane at y = 0.012 reads as a printed
// decal on the floor. Three things fix that, and all three are geometry, not shading:
//
//  1. Real thickness with a visible edge. The perimeter drops to the floor as its own ribbon of
//     quads, so the pile has a lit top edge and a shadowed under-edge everywhere you look across
//     it — that dark line is what makes it sit ON the floor.
//  2. It is not flat. A broad two-octave ruck runs through it, a fold ridge crosses it diagonally
//     (someone dragged the ottoman), and the corner nearest the shelving has curled up 5 cm.
//  3. It is loaded. Every furniture leg presses a soft dish into the pile — the same trick as a
//     footprint in snow. Those dishes are what glue the sofa and the ottoman to the floor.
//
// The fringe is 264 instanced strands on the two short edges, splayed and never parallel.

import * as THREE from 'three';
import { noise2, smoothstep, mix, clamp } from './util.js';

const W = 4.60;
const DP = 4.00;
const THICK = 0.012;
const CENTRE = { x: 0.90, z: -1.80 };
const YAW = 0.058; // ~3.3° off the walls, exactly as in the photograph

/** The built height field, published for everything DRESS lays ON the rug. See `rugTop`. */
let heightField = null;

/** Furniture feet, in world coordinates, that press into the pile. */
const LOADS = [
  { x: 2.30, z: 1.15, r: 0.30, d: 0.0075 }, // sofa chaise foot
  { x: 2.30, z: -0.40, r: 0.34, d: 0.0080 }, // sofa front feet
  { x: 2.30, z: -1.55, r: 0.30, d: 0.0070 },
  { x: -0.35, z: -3.45, r: 0.40, d: 0.0065 }, // armchair
  { x: -1.45, z: -2.05, r: 0.48, d: 0.0085 }, // ottoman
  { x: 0.95, z: -1.35, r: 0.30, d: 0.0060 }, // pouf
  { x: 0.55, z: -2.35, r: 0.16, d: 0.0045 }, // coffee table glass legs
  { x: 1.35, z: -2.35, r: 0.16, d: 0.0045 },
];

export function buildRug(D) {
  const rng = D.stream('rug');
  const group = new THREE.Group();
  group.name = 'rug';
  group.position.set(CENTRE.x, 0, CENTRE.z);
  group.rotation.y = YAW;
  D.add(group);

  // Loads, brought into the rug's own frame once.
  const cos = Math.cos(-YAW);
  const sin = Math.sin(-YAW);
  const loads = LOADS.map((l) => {
    const dx = l.x - CENTRE.x;
    const dz = l.z - CENTRE.z;
    return { x: dx * cos + dz * sin, z: -dx * sin + dz * cos, r: l.r, d: l.d };
  });

  const cornerX = -W / 2;
  const cornerZ = DP / 2;

  function height(x, z) {
    const nx = x / W + 0.5;
    const nz = z / DP + 0.5;
    let y = THICK;
    y += (noise2(nx * 3.1, nz * 2.9, 1, 411, 3) - 0.5) * 0.0125;
    y += (noise2(nx * 11, nz * 9.5, 1, 412, 2) - 0.5) * 0.0032;
    // The drag fold: a soft ridge running across the rug where the ottoman was pushed.
    const fold = (x * 0.78 + z * 0.62) - 0.30;
    y += Math.exp(-(fold * fold) / (2 * 0.24 * 0.24)) * 0.013;
    // The curled corner nearest the shelving.
    const dc = Math.hypot(x - cornerX, z - cornerZ);
    y += smoothstep(0.95, 0.05, dc) ** 1.6 * 0.058;
    // Furniture dishes.
    for (let i = 0; i < loads.length; i++) {
      const l = loads[i];
      const dx = x - l.x;
      const dz = z - l.z;
      const d2 = (dx * dx + dz * dz) / (l.r * l.r);
      if (d2 < 6) y -= Math.exp(-d2) * l.d;
    }
    // The pile thins toward the bound edge.
    const edge = Math.min(W / 2 - Math.abs(x), DP / 2 - Math.abs(z));
    y *= mix(0.58, 1, smoothstep(0, 0.11, edge));
    return Math.max(0.0015, y);
  }

  // ── the pile surface, as an explicit grid so the perimeter can carry its own skirt ────────
  const NX = D.lod(26, 40, 58, 76);
  const NZ = D.lod(22, 34, 50, 66);
  const verts = [];
  const uvs = [];
  const idx = [];
  for (let j = 0; j <= NZ; j++) {
    for (let i = 0; i <= NX; i++) {
      const x = -W / 2 + (i / NX) * W;
      const z = -DP / 2 + (j / NZ) * DP;
      verts.push(x, height(x, z), z);
      uvs.push(i / NX, 1 - j / NZ);
    }
  }
  const row = NX + 1;
  for (let j = 0; j < NZ; j++) {
    for (let i = 0; i < NX; i++) {
      const a = j * row + i;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  // Skirt: a ribbon from the boundary ring down to the floor.
  const boundary = [];
  for (let i = 0; i <= NX; i++) boundary.push(i);
  for (let j = 1; j <= NZ; j++) boundary.push(j * row + NX);
  for (let i = NX - 1; i >= 0; i--) boundary.push(NZ * row + i);
  for (let j = NZ - 1; j >= 1; j--) boundary.push(j * row);
  const skirtBase = verts.length / 3;
  for (let k = 0; k < boundary.length; k++) {
    const v = boundary[k] * 3;
    // The cut edge tucks very slightly under, which is what a bound rug edge actually does.
    const inward = 0.004;
    const x = verts[v];
    const z = verts[v + 2];
    const ix = x - Math.sign(x) * (Math.abs(x) > W / 2 - 0.02 ? inward : 0);
    const iz = z - Math.sign(z) * (Math.abs(z) > DP / 2 - 0.02 ? inward : 0);
    verts.push(ix, Math.min(verts[v + 1] * 0.12, 0.0016), iz);
    uvs.push(uvs[boundary[k] * 2], uvs[boundary[k] * 2 + 1]);
  }
  for (let k = 0; k < boundary.length; k++) {
    const k2 = (k + 1) % boundary.length;
    const a = boundary[k];
    const b = boundary[k2];
    const c = skirtBase + k;
    const d = skirtBase + k2;
    idx.push(a, c, b, b, c, d);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = D.mesh(geo, D.mat('rug.wool'), { name: 'rug.pile' });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);

  // ── fringe: two edges, 132 strands each ──────────────────────────────────────────────────
  const strandCount = D.lod(64, 96, 132, 132);
  const strandGeo = new THREE.CylinderGeometry(0.0011, 0.0018, 0.052, 4, 3, false);
  strandGeo.translate(0, -0.026, 0); // hang from the origin
  const fringeMat = D.tint('rug.wool', 0xf3ece0, { roughRange: [0.84, 0.99] });
  const inst = D.instanced(strandGeo, fringeMat, strandCount * 2, { name: 'rug.fringe', receive: true });
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  let n = 0;
  for (const side of [-1, 1]) {
    for (let i = 0; i < strandCount; i++) {
      const t = (i + 0.5) / strandCount;
      const z = -DP / 2 + t * DP * 0.985 + (rng() - 0.5) * 0.006;
      const x = side * (W / 2 - 0.002);
      const y = height(x, z) * 0.62 + 0.0035;
      // Strands lie almost flat on the floor, splayed, a few kicked up over their neighbours.
      const flop = 1.42 + rng() * 0.34;
      e.set((rng() - 0.5) * 0.5, (rng() - 0.5) * 0.6, side * flop);
      q.setFromEuler(e);
      p.set(x, Math.max(0.004, y), z);
      s.set(1, 0.72 + rng() * 0.5, 1);
      inst.setMatrixAt(n++, m.compose(p, q, s));
    }
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.computeBoundingSphere();
  inst.castShadow = D.atLeast('medium');
  group.add(inst);

  heightField = height;

  D.prop({
    id: 'rug',
    object3d: group,
    kind: 'scenery',
    labelKey: 'prop.rug',
    points: 0,
    noise: 0.05,
    mass: 9,
    anchor: true,
    climbable: false,
    phys: {
      shape: 'box',
      size: { x: W, y: 0.024, z: DP },
      offset: new THREE.Vector3(0, 0, 0),
      friction: 0.95,
      restitution: 0.02,
    },
  });

  return { group, height: (x, z) => height(clamp(x, -W / 2, W / 2), clamp(z, -DP / 2, DP / 2)) };
}

/**
 * World-space top-of-pile height, for anything that has to rest ON the rug — the snack bag, the
 * pacifier, the crayons, a sock. It samples the *real* displaced surface, so a crayon lying in the
 * drag fold sits 13 mm higher than one lying in the dish under the ottoman, which is the whole
 * reason the rug was built with a height field in the first place. Returns 0 off the rug.
 */
export function rugTop(worldX, worldZ) {
  const dx = worldX - CENTRE.x;
  const dz = worldZ - CENTRE.z;
  const cos = Math.cos(-YAW);
  const sin = Math.sin(-YAW);
  const x = dx * cos + dz * sin;
  const z = -dx * sin + dz * cos;
  if (Math.abs(x) > W / 2 || Math.abs(z) > DP / 2) return 0;
  return heightField ? heightField(x, z) : THICK;
}

/** True when a world point lands on the rug at all. */
export function onRug(worldX, worldZ) {
  const dx = worldX - CENTRE.x;
  const dz = worldZ - CENTRE.z;
  const x = dx * Math.cos(-YAW) + dz * Math.sin(-YAW);
  const z = -dx * Math.sin(-YAW) + dz * Math.cos(-YAW);
  return Math.abs(x) <= W / 2 && Math.abs(z) <= DP / 2;
}
