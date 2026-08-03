// PHYS · collider derivation from three.js geometry.
//
// Every module hands us an Object3D and a shape name; this file turns that into a Rapier
// ColliderDesc. The one subtlety worth knowing: a rigid body in Rapier has a position and a
// rotation but **no scale**, while a three Object3D usually has all three. So we define the
// "body frame" as the object's world position + world rotation with unit scale, and bake the
// object's world scale into the collider's vertices/half-extents instead. Every gather below
// therefore returns coordinates in that body frame, which means a collider offset of (0,0,0)
// for meshes and a simple centre offset for primitives. InstancedMesh is expanded per-instance
// so a shelf full of instanced books still produces a correct trimesh carcass.

import * as THREE from 'three';

const UNIT = new THREE.Vector3(1, 1, 1);

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _im = new THREE.Matrix4();
const _box = new THREE.Box3();

/** Decompose an object's world matrix into position / quaternion / scale. */
export function decomposeWorld(object3d, pos, quat, scale) {
  object3d.updateWorldMatrix(true, false);
  object3d.matrixWorld.decompose(pos, quat, scale);
}

/** Matrix mapping world space into the body frame (world pos + rot, unit scale). */
export function bodyFrameInverse(object3d, out = new THREE.Matrix4()) {
  object3d.updateWorldMatrix(true, false);
  object3d.matrixWorld.decompose(_p, _q, _s);
  out.compose(_p, _q, UNIT).invert();
  return out;
}

function isGeometryCarrier(o) {
  return !!(o && o.geometry && o.geometry.attributes && o.geometry.attributes.position &&
    !o.isLine && !o.isPoints && !o.isSprite && o.visible !== false);
}

/**
 * Axis-aligned bounds of the whole subtree expressed in the body frame.
 * Returns a THREE.Box3; empty if the object carries no geometry.
 */
export function boundsInBodyFrame(object3d, out = new THREE.Box3()) {
  const frameInv = bodyFrameInverse(object3d, new THREE.Matrix4());
  object3d.updateWorldMatrix(true, true);
  out.makeEmpty();
  object3d.traverse((child) => {
    if (!isGeometryCarrier(child)) return;
    const geo = child.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    if (!geo.boundingBox) return;
    const count = child.isInstancedMesh ? child.count : 1;
    for (let i = 0; i < count; i++) {
      _m.copy(frameInv).multiply(child.matrixWorld);
      if (child.isInstancedMesh) {
        child.getMatrixAt(i, _im);
        _m.multiply(_im);
      }
      _box.copy(geo.boundingBox).applyMatrix4(_m);
      out.union(_box);
    }
  });
  return out;
}

/**
 * Flatten a subtree into one vertex/index buffer in the body frame.
 * `stride` subsamples vertices (hull use only — never for trimeshes, it would shred the topology).
 */
export function gatherGeometry(object3d, { maxVertices = 120000, stride = 1 } = {}) {
  const frameInv = bodyFrameInverse(object3d, new THREE.Matrix4());
  object3d.updateWorldMatrix(true, true);

  const pos = [];
  const idx = [];
  let base = 0;
  let bailed = false;

  object3d.traverse((child) => {
    if (bailed || !isGeometryCarrier(child)) return;
    const geo = child.geometry;
    const attr = geo.attributes.position;
    const index = geo.index;
    const instances = child.isInstancedMesh ? child.count : 1;

    for (let inst = 0; inst < instances; inst++) {
      if (base > maxVertices) { bailed = true; return; }
      _m.copy(frameInv).multiply(child.matrixWorld);
      if (child.isInstancedMesh) {
        child.getMatrixAt(inst, _im);
        _m.multiply(_im);
      }
      if (stride > 1) {
        // Subsampled: vertices only, no topology (hulls do not need indices).
        for (let i = 0; i < attr.count; i += stride) {
          _p.fromBufferAttribute(attr, i).applyMatrix4(_m);
          pos.push(_p.x, _p.y, _p.z);
        }
        base = pos.length / 3;
      } else {
        for (let i = 0; i < attr.count; i++) {
          _p.fromBufferAttribute(attr, i).applyMatrix4(_m);
          pos.push(_p.x, _p.y, _p.z);
        }
        if (index) {
          for (let i = 0; i < index.count; i++) idx.push(base + index.getX(i));
        } else {
          for (let i = 0; i < attr.count; i++) idx.push(base + i);
        }
        base += attr.count;
      }
    }
  });

  return {
    positions: new Float32Array(pos),
    indices: new Uint32Array(idx),
    vertexCount: pos.length / 3,
    triangleCount: idx.length / 3,
  };
}

/**
 * Build a ColliderDesc for `object3d`.
 * Returns { desc, offset, half } — offset is the collider's translation inside the body frame.
 * Falls back to a box (and warns once per shape kind) whenever a fancier shape cannot be built.
 */
const warned = new Set();
function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[phys] ${msg}`);
}

export function makeColliderDesc(RAPIER, object3d, opts = {}) {
  const shape = opts.shape || 'box';
  const offset = new THREE.Vector3();

  // Explicit size always wins over derived bounds.
  let half = null;
  if (opts.size) {
    const s = opts.size;
    half = new THREE.Vector3(
      (s.x !== undefined ? s.x : s[0]) * 0.5,
      (s.y !== undefined ? s.y : s[1]) * 0.5,
      (s.z !== undefined ? s.z : s[2]) * 0.5,
    );
  }

  if (!half && shape !== 'trimesh' && shape !== 'hull') {
    const b = boundsInBodyFrame(object3d, new THREE.Box3());
    if (b.isEmpty()) {
      half = new THREE.Vector3(0.05, 0.05, 0.05);
    } else {
      b.getSize(_p);
      half = new THREE.Vector3(Math.max(_p.x * 0.5, 1e-3), Math.max(_p.y * 0.5, 1e-3), Math.max(_p.z * 0.5, 1e-3));
      b.getCenter(offset);
    }
  }
  if (opts.offset) offset.copy(opts.offset);

  const radial = half ? Math.max(half.x, half.z) : 0.05;

  switch (shape) {
    case 'ball': {
      const r = opts.radius !== undefined ? opts.radius : (half.x + half.y + half.z) / 3;
      return { desc: RAPIER.ColliderDesc.ball(Math.max(r, 1e-3)), offset, half };
    }
    case 'capsule': {
      const r = opts.radius !== undefined ? opts.radius : radial;
      const hh = opts.halfHeight !== undefined ? opts.halfHeight : Math.max(half.y - r, 1e-3);
      return { desc: RAPIER.ColliderDesc.capsule(hh, Math.max(r, 1e-3)), offset, half };
    }
    case 'cylinder': {
      const r = opts.radius !== undefined ? opts.radius : radial;
      const hh = opts.halfHeight !== undefined ? opts.halfHeight : half.y;
      return { desc: RAPIER.ColliderDesc.cylinder(Math.max(hh, 1e-3), Math.max(r, 1e-3)), offset, half };
    }
    case 'cone': {
      const r = opts.radius !== undefined ? opts.radius : radial;
      const hh = opts.halfHeight !== undefined ? opts.halfHeight : half.y;
      return { desc: RAPIER.ColliderDesc.cone(Math.max(hh, 1e-3), Math.max(r, 1e-3)), offset, half };
    }
    case 'trimesh': {
      const g = gatherGeometry(object3d, { maxVertices: opts.maxVertices || 120000 });
      if (g.triangleCount < 1) {
        warnOnce('trimesh', `trimesh requested for "${object3d.name || 'unnamed'}" but it has no triangles — using a box`);
        break;
      }
      const flags = RAPIER.TriMeshFlags
        ? (RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES | RAPIER.TriMeshFlags.DELETE_DEGENERATE_TRIANGLES)
        : undefined;
      let desc = null;
      try {
        desc = RAPIER.ColliderDesc.trimesh(g.positions, g.indices, flags);
      } catch (err) {
        try {
          desc = RAPIER.ColliderDesc.trimesh(g.positions, g.indices);
        } catch { desc = null; }
      }
      if (desc) return { desc, offset: new THREE.Vector3(), half: null, meta: g };
      warnOnce('trimesh-fail', `trimesh build failed for "${object3d.name || 'unnamed'}" — using a box`);
      break;
    }
    case 'hull': {
      const g = gatherGeometry(object3d, { stride: opts.stride || 1, maxVertices: opts.maxVertices || 20000 });
      if (g.vertexCount >= 4) {
        const desc = RAPIER.ColliderDesc.convexHull(g.positions);
        if (desc) return { desc, offset: new THREE.Vector3(), half: null, meta: g };
      }
      warnOnce('hull-fail', `convex hull failed for "${object3d.name || 'unnamed'}" — using a box`);
      break;
    }
    default:
      break;
  }

  // Box fallback (also the 'box' path).
  if (!half) {
    const b = boundsInBodyFrame(object3d, new THREE.Box3());
    if (b.isEmpty()) {
      half = new THREE.Vector3(0.05, 0.05, 0.05);
    } else {
      b.getSize(_p);
      half = new THREE.Vector3(Math.max(_p.x * 0.5, 1e-3), Math.max(_p.y * 0.5, 1e-3), Math.max(_p.z * 0.5, 1e-3));
      b.getCenter(offset);
    }
  }
  return { desc: RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z), offset, half };
}
