// OPERATION NAPTIME — BABY — polygonising the anatomy into one skinned, shaded protagonist.
//
// anatomy.js authors the baby as signed-distance fields and a bind-pose skeleton; this file turns
// that into GPU geometry. Five decisions carry the whole look:
//
//  1. SPARSE EVALUATION. polygonise() walks a dense grid, and the head field alone is thirty
//     primitives, so every corner three centimetres from the surface would cost the full stack.
//     `guarded()` wraps a field in a union of bounding spheres and returns the (conservative,
//     always-positive) sphere distance for any point that cannot possibly be near the surface.
//     It is a valid lower bound, so the isosurface is bit-identical and the build is ~3× faster.
//  2. AUTO-WEIGHTING FROM CAPSULES. Each bone owns a capsule (BONES[].seg). A vertex scores every
//     bone by exp(-3.6·(d/r)²) where d is the distance to the bone AXIS and r its effective reach,
//     keeps the best four and normalises. An exponential kernel is local — the head cannot claim a
//     shoulder vertex — and it is smooth, which is what stops the elbow creasing into a candy
//     wrapper. Ratios are all that matter, so the absolute scale of the kernel is irrelevant.
//  3. MIRRORED PARTS GET A SECOND NOISE PASS. mirrorX() copies displaced vertices, so the left
//     hand would otherwise be an exact reflection of the right — the single loudest CG tell on a
//     character. perturb() re-displaces the mirror with a differently-phased noise, and because
//     the displacement is a pure function of position, duplicated soup vertices stay welded.
//  4. HEAD IS ITS OWN MESH, split by HEAD_SPLIT. First person hides it and keeps the body, so the
//     player never renders the inside of their own skull.
//  5. HAIR IS CARDS, NOT A CAP. Strands are grown from a whorl over the *actual* scalp — each root
//     is marched onto the SDF surface — and the alpha of `hair.baby` breaks the tips into
//     individual hairs. A solid dome would read as a helmet, which is the brief's explicit fail.

import * as THREE from 'three';
import { makeRng } from '../../core/rng.js';
import { polygonise, tessellate, mirrorX, joinSoups, makeNoise3 } from './sdf.js';
import {
  A, BONES, BONE_INDEX, HEAD_SPLIT,
  skinField, SKIN_BOUNDS,
  handField, HAND_BOUNDS,
  footField, FOOT_BOUNDS,
  earField, EAR_BOUNDS,
  onesieField, ONESIE_BOUNDS,
  nappyField, NAPPY_BOUNDS,
} from './anatomy.js';

/** Grid pitch in metres per tier. The skin is the only one big enough to feel a change. */
const VOXEL = {
  low: { skin: 0.0150, hand: 0.0062, foot: 0.0072, ear: 0.0052, cloth: 0.0140, hair: 18, seg: 4 },
  medium: { skin: 0.0115, hand: 0.0046, foot: 0.0054, ear: 0.0040, cloth: 0.0106, hair: 34, seg: 5 },
  // Hands stay the finest thing on the baby: they are the view model in first person and they are
  // 30 cm from the lens for the whole game. The feet are never seen at that distance.
  high: { skin: 0.0090, hand: 0.0034, foot: 0.0044, ear: 0.0032, cloth: 0.0082, hair: 58, seg: 6 },
  ultra: { skin: 0.0074, hand: 0.0029, foot: 0.0036, ear: 0.0026, cloth: 0.0070, hair: 78, seg: 6 },
};

// Conservative bounds around each anatomical group (the same spheres anatomy.js culls with).
const SKIN_SPHERES = [
  [0, 0.428, -0.222, 0.234],
  [0, 0.288, 0.020, 0.217],
  [0.084, 0.186, -0.104, 0.198],
  [-0.084, 0.186, -0.104, 0.198],
  [0.080, 0.168, 0.190, 0.220],
  [-0.080, 0.168, 0.190, 0.220],
];

const CLOTH_SPHERES = [
  [0, 0.300, 0.010, 0.230],
  [0, 0.255, 0.120, 0.210],
];

/**
 * Wrap `field` so that a point demonstrably far outside every bounding sphere returns the sphere
 * distance instead of the field. The value is a lower bound on the true distance and positive, so
 * the extracted isosurface is unchanged.
 */
function guarded(field, spheres, slack = 0.03) {
  return function guardedField(x, y, z) {
    let lower = 1e9;
    for (let i = 0; i < spheres.length; i++) {
      const s = spheres[i];
      const dx = x - s[0];
      const dy = y - s[1];
      const dz = z - s[2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - s[3];
      if (d < lower) lower = d;
      if (lower < slack) break;
    }
    if (lower > slack) return lower;
    return field(x, y, z);
  };
}

/** Two octaves of value noise, in metres, for the outward displacement of a soup. */
function makeDisplacer(noise, amp, freq, phase) {
  return (x, y, z) => {
    const a = noise(x * freq + phase, y * freq + phase * 0.7, z * freq - phase * 0.4) - 0.5;
    const b = noise(x * freq * 2.7 - phase, y * freq * 2.7, z * freq * 2.7 + phase) - 0.5;
    return (a * 0.72 + b * 0.28) * amp * 2;
  };
}

/**
 * Push every vertex of a triangle soup along its normal. The offset is a pure function of the
 * position, so the duplicated vertices of adjacent triangles move identically and no crack opens.
 */
function perturb(soup, fn) {
  const p = soup.position;
  const n = soup.normal;
  for (let i = 0; i < soup.count; i++) {
    const o = i * 3;
    const d = fn(p[o], p[o + 1], p[o + 2]);
    p[o] += n[o] * d;
    p[o + 1] += n[o + 1] * d;
    p[o + 2] += n[o + 2] * d;
  }
  return soup;
}

/** Analytic gradient of a field, normalised. */
function gradient(field, x, y, z, eps, out) {
  const gx = field(x + eps, y, z) - field(x - eps, y, z);
  const gy = field(x, y + eps, z) - field(x, y - eps, z);
  const gz = field(x, y, z + eps) - field(x, y, z - eps);
  const l = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
  out.set(gx / l, gy / l, gz / l);
  return out;
}

/** March along a ray from `c` until the field crosses zero. Used to plant hair on the real scalp. */
function marchToSurface(field, cx, cy, cz, dx, dy, dz, r0) {
  let r = r0;
  for (let i = 0; i < 28; i++) {
    const d = field(cx + dx * r, cy + dy * r, cz + dz * r);
    if (Math.abs(d) < 5e-5) break;
    r -= d * 0.9;
    if (r < 0.01 || r > 0.30) return null;
  }
  return r;
}

// ─────────────────────────────────────────────────────────────────── skinning ──

/**
 * Distance from a point to a bone's axis (the capsule segment, radius ignored — the radius is used
 * to normalise the falloff instead, which keeps a fat thigh greedier than a thin forearm).
 */
function segDistance2(px, py, pz, s) {
  const bax = s[3] - s[0];
  const bay = s[4] - s[1];
  const baz = s[5] - s[2];
  const pax = px - s[0];
  const pay = py - s[1];
  const paz = pz - s[2];
  const dd = bax * bax + bay * bay + baz * baz;
  let h = dd > 1e-12 ? (pax * bax + pay * bay + paz * baz) / dd : 0;
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  const dz = paz - baz * h;
  return dx * dx + dy * dy + dz * dz;
}

function buildWeightTable() {
  return BONES.map((b) => ({
    seg: b.seg,
    w: b.w,
    // Effective reach. 0.85·r + 20 mm: tight enough that the head cannot claim a shoulder,
    // wide enough that no vertex is ever left unweighted.
    inv: 1 / ((b.seg[6] * 0.85 + 0.020) ** 2),
  }));
}

/**
 * Compute 4-bone skin indices and weights for one triangle soup.
 * @returns {{index: Uint16Array, weight: Float32Array}}
 */
function weightSoup(soup, table, bias) {
  const n = soup.count;
  const index = new Uint16Array(n * 4);
  const weight = new Float32Array(n * 4);
  const bi = [0, 0, 0, 0];
  const bw = [0, 0, 0, 0];

  for (let v = 0; v < n; v++) {
    const o = v * 3;
    const x = soup.position[o];
    const y = soup.position[o + 1];
    const z = soup.position[o + 2];
    bi[0] = bi[1] = bi[2] = bi[3] = 0;
    bw[0] = bw[1] = bw[2] = bw[3] = 0;

    for (let b = 0; b < table.length; b++) {
      const t = table[b];
      const d2 = segDistance2(x, y, z, t.seg) * t.inv;
      if (d2 > 9) continue; // exp(-32) — numerically zero
      let s = t.w * Math.exp(-3.6 * d2);
      if (bias) s *= bias[b] === undefined ? 1 : bias[b];
      if (s <= bw[3]) continue;
      // insertion sort into the running top-4
      let k = 3;
      while (k > 0 && s > bw[k - 1]) {
        bw[k] = bw[k - 1];
        bi[k] = bi[k - 1];
        k--;
      }
      bw[k] = s;
      bi[k] = b;
    }

    let sum = bw[0] + bw[1] + bw[2] + bw[3];
    const w = v * 4;
    if (sum <= 1e-9) {
      index[w] = BONE_INDEX.root;
      weight[w] = 1;
      continue;
    }
    // Drop influences under 4% and renormalise — four near-equal weights smear a crease.
    for (let k = 0; k < 4; k++) if (bw[k] < sum * 0.04) bw[k] = 0;
    sum = bw[0] + bw[1] + bw[2] + bw[3];
    const inv = 1 / sum;
    for (let k = 0; k < 4; k++) {
      index[w + k] = bi[k];
      weight[w + k] = bw[k] * inv;
    }
  }
  return { index, weight };
}

function geometryFromSoup(soup, skin) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(soup.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(soup.normal, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(soup.uv, 2));
  if (skin) {
    g.setAttribute('skinIndex', new THREE.BufferAttribute(skin.index, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(skin.weight, 4));
  }
  g.computeBoundingSphere();
  return g;
}

// ────────────────────────────────────────────────────────────────────── hair ──

/**
 * Grow hair cards from a whorl. Every root is marched onto the real SDF scalp and every card hugs
 * the skull for its first third before lifting away, so the silhouette breaks up instead of
 * reading as one shell.
 */
function buildHair(field, count, segments, rand) {
  const cx = A.skull[0];
  const cy = A.skull[1];
  const cz = A.skull[2];
  const whorl = new THREE.Vector3(0.13, 0.93, 0.34).normalize();
  const pos = [];
  const nrm = [];
  const uvs = [];
  const idx = [];

  const root = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const n = new THREE.Vector3();
  const t = new THREE.Vector3();
  const side = new THREE.Vector3();
  const p = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  let made = 0;
  let guard = 0;
  while (made < count && guard++ < count * 30) {
    // Sample the scalp: upper hemisphere, biased toward the crown, never on the face.
    const u = rand();
    const phi = rand() * Math.PI * 2;
    const cosT = 1 - u * u * 1.35; // crowd the crown
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    dir.set(sinT * Math.cos(phi), cosT, sinT * Math.sin(phi));
    if (dir.y < -0.18) continue;
    // The hairline: nothing forward of the brow, nothing below the ears.
    if (dir.z < -0.30 && dir.y < 0.42) continue;
    if (Math.abs(dir.x) > 0.80 && dir.y < 0.25) continue;

    const r = marchToSurface(field, cx, cy, cz, dir.x, dir.y, dir.z, 0.105);
    if (r === null) continue;
    root.set(cx + dir.x * r, cy + dir.y * r, cz + dir.z * r);
    if (root.y < 0.452 && root.z < -0.245) continue; // the face proper
    gradient(field, root.x, root.y, root.z, 0.0016, n);
    if (n.y < -0.25) continue;

    // Growth direction: away from the whorl, flattened into the tangent plane.
    t.copy(dir).addScaledVector(whorl, -dir.dot(whorl));
    if (t.lengthSq() < 1e-6) t.set(0, 0, 1);
    t.normalize().addScaledVector(n, -t.dot(n));
    if (t.lengthSq() < 1e-6) t.set(0, 0.2, 1).normalize();
    t.normalize();

    const len = 0.020 + rand() * 0.028;
    const halfW = 0.0055 + rand() * 0.0065;
    const droop = 0.35 + rand() * 0.75;
    const u0 = rand() * 0.62;
    const uw = 0.22 + rand() * 0.16;
    const base = pos.length / 3;

    for (let k = 0; k <= segments; k++) {
      const s = k / segments;
      // Hug the scalp early, lift and fall away late.
      p.copy(root)
        .addScaledVector(t, len * s)
        .addScaledVector(n, len * 0.16 * Math.sin(s * 1.9))
        .addScaledVector(whorl, -len * droop * s * s * 0.55);
      const d = field(p.x, p.y, p.z);
      if (d < 0.0007) p.addScaledVector(n, 0.0007 - d);
      gradient(field, p.x, p.y, p.z, 0.0018, tmp);
      if (tmp.y < -0.6) tmp.copy(n);
      side.copy(tmp).cross(t);
      if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
      side.normalize();
      const w = halfW * (1 - 0.42 * s);
      pos.push(p.x - side.x * w, p.y - side.y * w, p.z - side.z * w);
      pos.push(p.x + side.x * w, p.y + side.y * w, p.z + side.z * w);
      nrm.push(tmp.x, tmp.y, tmp.z, tmp.x, tmp.y, tmp.z);
      uvs.push(u0, s, u0 + uw, s);
      if (k < segments) {
        const a = base + k * 2;
        idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
    }
    made++;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// ─────────────────────────────────────────────────────────────────────── eyes ──

/**
 * One eye: sclera, a painted iris cap that follows the sclera's curvature, a pupil, a corneal
 * bulge and a hard specular speck. The bulge is the reason a baby's eye reads as wet rather than
 * as a printed ball, and the speck guarantees a catchlight even in the dim corners of the room.
 */
function buildEye(ctx, side, track) {
  const g = new THREE.Group();
  // 27.8 mm across — enormous, and 1.3 mm wider than the palpebral fissure anatomy.js cuts, so
  // no line of sight through the aperture ever reaches the empty socket behind it.
  const R = 0.0139;
  const mats = ctx.materials;

  const sclera = new THREE.Mesh(
    track(new THREE.SphereGeometry(R, 22, 16)),
    mats.tinted('eye', 0xf3ece1, { roughness: 0.17 }),
  );
  sclera.castShadow = false;
  sclera.receiveShadow = true;
  g.add(sclera);

  // Iris: a cap of the same sphere, 0.2 mm proud, so it curves with the eyeball.
  const irisGeo = track(new THREE.SphereGeometry(R + 0.0002, 24, 12, 0, Math.PI * 2, 0, 0.52));
  irisGeo.rotateX(-Math.PI / 2);
  const iris = new THREE.Mesh(irisGeo, mats.tinted('eye', 0x4a3526, { roughness: 0.12 }));
  g.add(iris);

  const pupilGeo = track(new THREE.SphereGeometry(R + 0.0004, 20, 10, 0, Math.PI * 2, 0, 0.24));
  pupilGeo.rotateX(-Math.PI / 2);
  const pupil = new THREE.Mesh(pupilGeo, mats.tinted('eye', 0x0d0907, { roughness: 0.08 }));
  g.add(pupil);

  // The cornea: a slightly larger, slightly flattened cap of clear glass over the iris. Its apex
  // lands level with the lid margin, which is what makes an eye read as wet rather than painted.
  const corneaGeo = track(new THREE.SphereGeometry(R + 0.0011, 22, 12, 0, Math.PI * 2, 0, 0.62));
  corneaGeo.rotateX(-Math.PI / 2);
  corneaGeo.scale(1, 1, 1.05);
  const cornea = new THREE.Mesh(corneaGeo, ctx.materials.get('glass.clear'));
  cornea.renderOrder = 2;
  g.add(cornea);

  if ((ctx.quality?.tier || 'high') !== 'low') {
    const speck = new THREE.Mesh(
      track(new THREE.SphereGeometry(0.0013, 8, 6)),
      mats.tinted('emissive.bulb', 0xffffff, {
        emissive: 0xfff6e8, emissiveIntensity: 2.4, transmission: 0, transparent: false, roughness: 0.1,
      }),
    );
    speck.position.set(side * 0.0043, 0.0055, -0.0146);
    speck.renderOrder = 3;
    g.add(speck);
  }
  return g;
}

// ─────────────────────────────────────────────────────────────────── assembly ──

export function buildBabyMesh(ctx) {
  const tier = ctx.quality?.tier || 'high';
  const V = VOXEL[tier] || VOXEL.high;
  const track = (o) => (ctx.track ? ctx.track(o) : o);
  const rand = makeRng(0x0bab1e);
  const noise = makeNoise3(0xb0dd1e);
  const noise2 = makeNoise3(0x51ce7a);

  const skin = guarded(skinField, SKIN_SPHERES, 0.035);
  const onesie = guarded(onesieField, CLOTH_SPHERES, 0.035);
  const nappy = guarded(nappyField, CLOTH_SPHERES, 0.035);

  // --- skin: torso, limbs, head ------------------------------------------------------------
  const skinDisplace = makeDisplacer(noise, 0.0013, 17.0, 3.1);
  const skinMesh = polygonise(skin, SKIN_BOUNDS.min, SKIN_BOUNDS.max, V.skin);
  const nrm = HEAD_SPLIT.normal;
  const pt = HEAD_SPLIT.point;
  const isHead = (x, y, z) => (x - pt[0]) * nrm[0] + (y - pt[1]) * nrm[1] + (z - pt[2]) * nrm[2] > 0;

  const bodySkin = tessellate(skinMesh, {
    field: skin, extent: 0.45, displace: skinDisplace, filter: (x, y, z) => !isHead(x, y, z),
  });
  const headSkin = tessellate(skinMesh, {
    field: skin, extent: 0.45, displace: skinDisplace, filter: isHead,
  });

  // --- hands, feet, ears: built once on the right, mirrored, then re-noised -----------------
  const handSoup = tessellate(
    polygonise(handField, HAND_BOUNDS.min, HAND_BOUNDS.max, V.hand),
    { field: handField, extent: 0.30, displace: makeDisplacer(noise, 0.00055, 34, 1.7) },
  );
  const footSoup = tessellate(
    polygonise(footField, FOOT_BOUNDS.min, FOOT_BOUNDS.max, V.foot),
    { field: footField, extent: 0.30, displace: makeDisplacer(noise, 0.00055, 34, 5.3) },
  );
  const earSoup = tessellate(
    polygonise(earField, EAR_BOUNDS.min, EAR_BOUNDS.max, V.ear),
    { field: earField, extent: 0.24, displace: makeDisplacer(noise, 0.00035, 46, 2.9) },
  );

  const handL = perturb(mirrorX(handSoup), makeDisplacer(noise2, 0.00075, 29, 8.2));
  const footL = perturb(mirrorX(footSoup), makeDisplacer(noise2, 0.00075, 29, 11.4));
  const earL = perturb(mirrorX(earSoup), makeDisplacer(noise2, 0.00055, 41, 6.6));

  const bodySoup = joinSoups([bodySkin, handSoup, handL, footSoup, footL]);
  const headSoup = joinSoups([headSkin, earSoup, earL]);

  // --- clothes -------------------------------------------------------------------------------
  const onesieSoup = tessellate(
    polygonise(onesie, ONESIE_BOUNDS.min, ONESIE_BOUNDS.max, V.cloth),
    { field: onesie, extent: 0.40, displace: makeDisplacer(noise, 0.0016, 21, 0.6) },
  );
  const nappySoup = tessellate(
    polygonise(nappy, NAPPY_BOUNDS.min, NAPPY_BOUNDS.max, V.cloth),
    { field: nappy, extent: 0.30, displace: makeDisplacer(noise, 0.0019, 26, 7.9) },
  );

  // --- skeleton --------------------------------------------------------------------------------
  const group = new THREE.Group();
  group.name = 'baby';
  const bones = BONES.map((def) => {
    const b = new THREE.Bone();
    b.name = `baby.${def.name}`;
    return b;
  });
  const byName = Object.create(null);
  BONES.forEach((def, i) => {
    byName[def.name] = bones[i];
    if (def.parent) {
      const p = BONES[BONE_INDEX[def.parent]];
      bones[BONE_INDEX[def.parent]].add(bones[i]);
      bones[i].position.set(def.pos[0] - p.pos[0], def.pos[1] - p.pos[1], def.pos[2] - p.pos[2]);
    } else {
      bones[i].position.set(def.pos[0], def.pos[1], def.pos[2]);
    }
  });
  group.add(bones[0]);
  group.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);

  // --- meshes ------------------------------------------------------------------------------------
  const table = buildWeightTable();
  // The onesie must not be dragged around by the jaw or the cheeks, and the nappy belongs to the
  // hips even where the belly bone is nearer.
  const clothBias = {};
  clothBias[BONE_INDEX.jaw] = 0.1;
  clothBias[BONE_INDEX.cheekR] = 0.1;
  clothBias[BONE_INDEX.cheekL] = 0.1;
  clothBias[BONE_INDEX.head] = 0.35;
  const nappyBias = Object.assign({}, clothBias);
  nappyBias[BONE_INDEX.nappy] = 2.2;
  nappyBias[BONE_INDEX.belly] = 0.4;

  function skinned(name, soup, materialName, bias) {
    const geo = track(geometryFromSoup(soup, weightSoup(soup, table, bias)));
    const mesh = new THREE.SkinnedMesh(geo, ctx.materials.get(materialName));
    mesh.name = `baby.${name}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // one object, always near the camera, and it deforms past its bounds
    group.add(mesh);
    mesh.bind(skeleton, new THREE.Matrix4());
    return mesh;
  }

  const meshes = {
    body: skinned('body', bodySoup, 'skin.baby', null),
    head: skinned('head', headSoup, 'skin.baby', null),
    onesie: skinned('onesie', onesieSoup, 'cloth.onesie', clothBias),
    nappy: skinned('nappy', nappySoup, 'cloth.diaper', nappyBias),
  };

  // --- head furniture ----------------------------------------------------------------------------
  // Everything below lives in MODEL space but is parented to a bone, so the container cancels the
  // bone's bind translation and the children can use anatomy.js coordinates verbatim.
  const headSpace = new THREE.Object3D();
  headSpace.name = 'baby.headSpace';
  headSpace.position.set(-A.headJoint[0], -A.headJoint[1], -A.headJoint[2]);
  byName.head.add(headSpace);

  const jawSpace = new THREE.Object3D();
  jawSpace.name = 'baby.jawSpace';
  const jawPos = BONES[BONE_INDEX.jaw].pos;
  jawSpace.position.set(-jawPos[0], -jawPos[1], -jawPos[2]);
  byName.jaw.add(jawSpace);

  // Set back 5 mm from the anatomy's eye landmark: that lands the corneal apex level with the lid
  // surface instead of bulging out through the face.
  const eyeR = buildEye(ctx, 1, track);
  eyeR.position.set(A.eyeR[0], A.eyeR[1] - 0.0003, A.eyeR[2] + 0.005);
  eyeR.rotation.y = -0.10; // the eyes toe outward a touch, as everyone's do
  const eyeL = buildEye(ctx, -1, track);
  eyeL.position.set(A.eyeL[0], A.eyeL[1], A.eyeL[2] + 0.005);
  eyeL.rotation.y = 0.115;
  headSpace.add(eyeR, eyeL);

  // Two lower teeth, just cutting the gum. Nothing else in the mouth is visible at this size.
  const toothGeo = track(new THREE.BoxGeometry(0.0056, 0.0044, 0.0030));
  const toothMat = ctx.materials.tinted('ceramic.white', 0xfdfbf4, { roughness: 0.22 });
  const teeth = new THREE.Group();
  teeth.name = 'baby.teeth';
  for (let i = 0; i < 2; i++) {
    const t = new THREE.Mesh(toothGeo, toothMat);
    t.position.set((i ? -1 : 1) * 0.0038, 0.3958 + i * 0.0002, -0.2892);
    t.rotation.set(0.12, (i ? -1 : 1) * 0.09, (i ? -1 : 1) * 0.06);
    teeth.add(t);
  }
  jawSpace.add(teeth);

  const hairGeo = track(buildHair(skin, V.hair, V.seg, rand));
  const hair = new THREE.Mesh(hairGeo, ctx.materials.tiled('hair.baby', 0.06, 0.09));
  hair.name = 'baby.hair';
  hair.castShadow = tier !== 'low';
  hair.receiveShadow = false;
  hair.frustumCulled = false;
  headSpace.add(hair);

  // The eye the camera lives behind, and the mouth things get posted into.
  const eyeAnchor = new THREE.Object3D();
  eyeAnchor.name = 'baby.eyeAnchor';
  eyeAnchor.position.set(0, (A.eyeR[1] + A.eyeL[1]) * 0.5, (A.eyeR[2] + A.eyeL[2]) * 0.5 + 0.004);
  headSpace.add(eyeAnchor);

  const mouthAnchor = new THREE.Object3D();
  mouthAnchor.name = 'baby.mouthAnchor';
  mouthAnchor.position.set(A.mouth[0], A.mouth[1], A.mouth[2] - 0.012);
  headSpace.add(mouthAnchor);

  // --- the first-person view model ----------------------------------------------------------------
  // The same hand geometry, unskinned and re-origined at the wrist so camera.js can wave it about.
  const viewHand = geometryFromSoup(handSoup, null);
  viewHand.translate(-0.088, -0.030, 0.140);
  track(viewHand);

  const headParts = [meshes.head, hair, eyeR, eyeL];

  return {
    group,
    bones,
    byName,
    skeleton,
    meshes,
    headSpace,
    jawSpace,
    eyes: [eyeR, eyeL],
    hair,
    teeth,
    eyeAnchor,
    mouthAnchor,
    viewHandGeometry: viewHand,
    /** First person renders the body but never the inside of its own skull. */
    setHeadVisible(v) {
      for (let i = 0; i < headParts.length; i++) headParts[i].visible = v;
      teeth.visible = v;
    },
    stats() {
      return {
        body: bodySoup.count / 3,
        head: headSoup.count / 3,
        onesie: onesieSoup.count / 3,
        nappy: nappySoup.count / 3,
        hair: hairGeo.index ? hairGeo.index.count / 3 : 0,
      };
    },
  };
}
