// FURN · the bouclé family — tub armchair, ottoman, cylindrical pouf.
//
// The armchair is the one object here that could not be built from primitives. Its shell is a
// closed cross-section (a 170 mm wall with a full roll over the top) swept along a squircle plan
// path, with a height curve that runs 0.74 m at the back down to 0.55 m at the two arm tips. The
// plan is a superellipse |x/A|^n + |z/B|^n = 1 rather than a circle, because a tub chair is wider
// than it is deep and its arms flatten as they come forward; the outward normal at each station is
// the normalised gradient of that implicit function, which is what the sweep needs anyway.
//
// The ottoman and the pouf are dynamic bodies (12–16 kg): shoveable, not toppleable. Both get a
// top-surface dent from somebody having sat on them and a piped seam around the widest point — the
// pouf's is a swept cord, not a texture, because that little cast shadow under the welt is the
// difference between "upholstery" and "a cylinder with a fabric shader".

import * as THREE from 'three';
import {
  softBox, chamferBox, lathe, pipingLoop, projectUV, shellSweep, deformGeometry,
  makeNoise3, shadows, clamp, DEG,
} from './geo.js';

/** Station list around a superellipse, with outward normals, skipping the front opening. */
function tubPath(A, B, n, halfOpenDeg, stations) {
  const half = halfOpenDeg * DEG;
  const start = Math.PI * 0.5 - half;
  const sweep = Math.PI * 2 - half * 2;
  const out = [];
  for (let i = 0; i < stations; i++) {
    const phi = start - (i / (stations - 1)) * sweep;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const x = A * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
    const z = B * Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
    // ∇((x/A)^n + (z/B)^n)
    let gx = (n * Math.sign(x) * Math.pow(Math.abs(x), n - 1)) / Math.pow(A, n);
    let gz = (n * Math.sign(z) * Math.pow(Math.abs(z), n - 1)) / Math.pow(B, n);
    const l = Math.hypot(gx, gz) || 1;
    gx /= l;
    gz /= l;
    out.push({ x, z, nx: gx, nz: gz });
  }
  return out;
}

/** Closed cross-section of the shell wall: flat bottom, straight faces, full roll on top. */
function tubProfile(thickness, yBase, yTop) {
  const t = thickness * 0.5;
  const pts = [];
  const fillet = Math.min(0.022, t * 0.5);
  // outer face, bottom → top
  pts.push({ r: t, y: yBase + fillet });
  pts.push({ r: t, y: yTop - t });
  // the roll
  for (let i = 1; i < 9; i++) {
    const a = (i / 9) * Math.PI;
    pts.push({ r: t * Math.cos(a), y: yTop - t + t * Math.sin(a) });
  }
  // inner face, top → bottom
  pts.push({ r: -t, y: yTop - t });
  pts.push({ r: -t, y: yBase + fillet });
  // bottom fillets
  pts.push({ r: -t + fillet * 0.4, y: yBase });
  pts.push({ r: t - fillet * 0.4, y: yBase });
  return pts;
}

export function buildArmchair(kit, origin, yaw) {
  const group = new THREE.Group();
  group.name = 'armchair';
  group.position.set(origin[0], origin[1], origin[2]);
  group.rotation.y = yaw;
  group.rotation.z = 0.4 * DEG; // the floor is not flat and neither is this chair

  const tm = kit.tm('fabric.boucle');
  const boucle = kit.unit('fabric.boucle');
  const dark = kit.tint('fabric.boucle', 0xd6c9b3, { uvRepeat: [1, 1] });
  const uv = { def: [tm[0], tm[1], false] };

  const T = 0.17;
  const A = 0.39 - T * 0.5;
  const B = 0.40 - T * 0.5;
  const Y_BASE = 0.10;
  const Y_TOP = 0.74;

  const path = tubPath(A, B, 3.1, 36, 56);
  const profile = tubProfile(T, Y_BASE, Y_TOP);
  const shell = shellSweep(path, profile, {
    heightAt: (t) => 0.548 + 0.192 * Math.pow(Math.sin(Math.PI * clamp(t, 0, 1)), 0.72),
    thickAt: (t) => 1 + 0.10 * Math.pow(Math.sin(Math.PI * clamp(t, 0, 1)), 2),
    tileU: tm[0],
    tileV: tm[1],
  });
  // Bouclé is a loop pile: break the swept surface with a millimetre of noise so it never reads
  // as an extruded profile.
  const wob = makeNoise3(6151);
  deformGeometry(shell, (v) => {
    const d = wob(v.x * 9, v.y * 9, v.z * 9) * 0.0022;
    const l = Math.hypot(v.x, v.z) || 1;
    v.x += (v.x / l) * d;
    v.z += (v.z / l) * d;
    v.y += wob(v.x * 6 + 11, v.y * 6, v.z * 6) * 0.0016;
  });
  group.add(kit.mesh(shell, boucle, 'armchair.shell'));

  // Plinth: recessed, so the chair floats on a shadow line.
  const plinth = chamferBox(0.70, 0.10, 0.72, 0.028, 2);
  projectUV(plinth, uv);
  const plinthMesh = kit.mesh(plinth, dark, 'armchair.plinth');
  plinthMesh.position.y = 0.05;
  group.add(plinthMesh);

  // The seat platform inside the tub, then the deep cushion on it.
  const deckGeo = softBox(0.60, 0.20, 0.62, { radius: 0.05, segments: 3, bulge: 0.008, wrinkle: 0.0012, seed: 771 });
  projectUV(deckGeo, uv);
  const deckMesh = kit.mesh(deckGeo, dark, 'armchair.deck');
  deckMesh.position.set(0, 0.20, -0.01);
  group.add(deckMesh);

  const cushGeo = softBox(0.585, 0.165, 0.60, {
    radius: 0.055,
    segments: 5,
    sag: 0.032,
    sagAt: [0.08, 0.14],
    sagSpread: 1.1,
    bulge: 0.03,
    bulgeAt: 0.42,
    corner: 0.007,
    dents: [{ u: -0.3, v: -0.25, depth: 0.01, r: 0.5 }],
    wrinkle: 0.0026,
    wrinkleScale: 9,
    seed: 3301,
  });
  projectUV(cushGeo, uv);
  const cushion = kit.mesh(cushGeo, boucle, 'armchair.cushion');
  cushion.position.set(0.006, 0.385, 0.005);
  cushion.rotation.y = 1.4 * DEG;
  group.add(cushion);

  const welt = kit.mesh(
    projectUV(pipingLoop(0.578, 0.594, 0, 0.0072, 0.055, { wobble: 0.0014, seed: 88, radialSegments: 6 }), uv),
    kit.tint('fabric.boucle', 0xf4ecdf, { uvRepeat: [1, 1], roughRange: [0.70, 0.92] }),
    'armchair.cushion.welt',
  );
  welt.position.set(0.006, 0.385 + 0.055, 0.005);
  welt.rotation.y = 1.4 * DEG;
  group.add(welt);

  // A soft bolster slumped against the inside of the back.
  const bolGeo = softBox(0.44, 0.20, 0.15, {
    radius: 0.068, segments: 4, bulge: 0.016, sag: 0.014, corner: 0.012,
    dents: [{ u: 0.2, v: 0, depth: 0.016, r: 0.5 }], wrinkle: 0.0022, seed: 3407,
  });
  projectUV(bolGeo, uv);
  const bolster = kit.mesh(bolGeo, boucle, 'armchair.bolster');
  bolster.position.set(-0.04, 0.545, -0.20);
  bolster.rotation.set(-14 * DEG, 4 * DEG, 3 * DEG);
  group.add(bolster);

  kit.box(group, 'armchair.collider', [0, 0.37, 0], [0.78, 0.74, 0.80], { material: 'fabric' });

  shadows(group, true, true);
  return { group };
}

export function buildOttoman(kit, origin, yaw) {
  const group = new THREE.Group();
  group.name = 'ottoman';
  group.position.set(origin[0], origin[1] + 0.21, origin[2]);
  group.rotation.y = yaw;

  const tm = kit.tm('fabric.boucle');
  const boucle = kit.unit('fabric.boucle');
  const dark = kit.tint('fabric.boucle', 0xd4c7b1, { uvRepeat: [1, 1] });
  const uv = { def: [tm[0], tm[1], false] };

  const bodyH = 0.355;
  const bodyGeo = softBox(1.15, bodyH, 0.85, {
    radius: 0.085,
    segments: 5,
    bulge: 0.030,
    bulgeAt: 0.44,
    sag: 0.014,
    sagAt: [0.22, -0.1],
    dents: [
      { u: -0.35, v: 0.18, depth: 0.017, r: 0.55 },
      { u: 0.45, v: -0.3, depth: 0.009, r: 0.4 },
    ],
    wrinkle: 0.0028,
    wrinkleScale: 8,
    seed: 4111,
  });
  projectUV(bodyGeo, uv);
  const body = kit.mesh(bodyGeo, boucle, 'ottoman.body');
  body.position.y = -0.21 + 0.065 + bodyH * 0.5;
  group.add(body);

  const plinth = chamferBox(1.05, 0.07, 0.75, 0.018, 2);
  projectUV(plinth, uv);
  const plinthMesh = kit.mesh(plinth, dark, 'ottoman.plinth');
  plinthMesh.position.y = -0.21 + 0.035;
  group.add(plinthMesh);

  const seam = kit.mesh(
    projectUV(pipingLoop(1.176, 0.876, 0, 0.008, 0.09, { wobble: 0.0018, seed: 191, radialSegments: 7 }), uv),
    kit.tint('fabric.boucle', 0xf3ebde, { uvRepeat: [1, 1], roughRange: [0.70, 0.92] }),
    'ottoman.seam',
  );
  seam.position.y = -0.21 + 0.065 + bodyH * 0.46;
  group.add(seam);

  shadows(group, true, true);
  return {
    group,
    dynamic: {
      shape: 'box',
      size: { x: 1.13, y: 0.42, z: 0.83 },
      mass: 16,
      friction: 0.95,
      restitution: 0.02,
      linearDamping: 0.9,
      angularDamping: 3.2,
      material: 'fabric',
    },
  };
}

export function buildPouf(kit, origin, yaw) {
  const group = new THREE.Group();
  group.name = 'pouf';
  group.position.set(origin[0], origin[1] + 0.21, origin[2]);
  group.rotation.y = yaw;

  const tm = kit.tm('fabric.boucle');
  const boucle = kit.unit('fabric.boucle');
  const R = 0.335;
  const H = 0.42;

  // Barrel-bulged profile, in local coordinates centred on the body (y ∈ [-0.21, 0.21]).
  const prof = [
    [0.0, -0.21],
    [0.245, -0.21],
    [0.288, -0.196],
    [0.318, -0.15],
    [R, -0.03],
    [0.331, 0.07],
    [0.312, 0.152],
    [0.278, 0.196],
    [0.232, 0.21],
    [0.0, 0.212],
  ];
  const geo = lathe(prof, 48, tm[0], tm[1]);
  const wob = makeNoise3(5209);
  deformGeometry(geo, (v) => {
    const rr = Math.hypot(v.x, v.z);
    // Somebody sat here: an off-centre dish in the top surface.
    const du = (v.x - 0.06) / 0.30;
    const dv = (v.z + 0.05) / 0.30;
    const top = clamp((v.y + 0.02) / 0.23, 0, 1);
    v.y -= 0.026 * Math.exp(-(du * du + dv * dv)) * top * top;
    const n = wob(v.x * 10, v.y * 10, v.z * 10) * 0.0026;
    if (rr > 1e-4) {
      v.x += (v.x / rr) * n;
      v.z += (v.z / rr) * n;
    }
    v.y += wob(v.x * 7 + 3, v.y * 7, v.z * 7) * 0.0018;
  });
  group.add(kit.mesh(geo, boucle, 'pouf.body'));

  const seam = kit.mesh(
    projectUV(
      pipingLoop(R * 2 + 0.012, R * 2 + 0.012, 0, 0.0075, R + 0.006, { radialSegments: 7 }),
      { def: [tm[0], tm[1], false] },
    ),
    kit.tint('fabric.boucle', 0xf3ebde, { uvRepeat: [1, 1], roughRange: [0.70, 0.92] }),
    'pouf.seam',
  );
  seam.position.y = -0.028;
  group.add(seam);

  shadows(group, true, true);
  return {
    group,
    height: H,
    dynamic: {
      shape: 'cylinder',
      radius: 0.332,
      halfHeight: 0.21,
      mass: 12,
      friction: 0.9,
      restitution: 0.03,
      linearDamping: 0.7,
      angularDamping: 2.8,
      material: 'fabric',
    },
  };
}
