// AI · procedural skinned-geometry builder.
//
// Everything the parent is made of is a swept tube or a warped ellipsoid, accumulated into one
// vertex soup per material and handed to a THREE.SkinnedMesh. Three ideas make it work:
//
//  1. Parallel-transport frames. A tube swept along a polyline with a naive up-vector twists
//     violently wherever the path bends (a bent elbow, a curled finger). We propagate the frame
//     by the minimal rotation that takes each tangent to the next, so the cross-section never
//     spins and the fabric folds stay where they were authored.
//  2. Weights come from the path, not from a paint tool. `limbPath()` walks a joint chain and
//     smoothsteps the skin weight across a blend band either side of every joint, which is what
//     produces a knee that creases instead of a knee that collapses.
//  3. UVs are emitted in METRES (u = arc around the tube, v = arc along it). The material library
//     tiles in real-world metres too, so `materials.tiled(name, 1, 1)` lines a 1 m² patch of twill
//     up with 1 m² of trouser, whatever the limb's radius — no per-part magic numbers.
//
// Winding: rings advance counter-clockwise about the tangent and quads are emitted (a, b, c, d)
// = (i,k), (i,k+1), (i+1,k+1), (i+1,k); that is the order whose face normal points outward.

import * as THREE from 'three';

const _t = new THREE.Vector3();
const _n = new THREE.Vector3();
const _b = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _d = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _alt = new THREE.Vector3(0, 0, 1);

const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1e-6)));
  return t * t * (3 - 2 * t);
};

/** Accumulates positions / uvs / skin indices / skin weights / indices for one skinned mesh. */
export class SkinBuilder {
  constructor(name = 'part') {
    this.name = name;
    this.pos = [];
    this.uv = [];
    this.si = [];
    this.sw = [];
    this.idx = [];
    this._wi = [0, 0, 0, 0];
    this._ww = [0, 0, 0, 0];
  }

  get vertexCount() {
    return this.pos.length / 3;
  }

  /** Normalise a weight spec: an integer bone index, or [[index, weight], …] (max 4 used). */
  _weights(w) {
    const i = this._wi;
    const s = this._ww;
    i[0] = i[1] = i[2] = i[3] = 0;
    s[0] = s[1] = s[2] = s[3] = 0;
    if (typeof w === 'number') {
      i[0] = w;
      s[0] = 1;
      return;
    }
    const n = Math.min(4, w.length);
    let sum = 0;
    for (let k = 0; k < n; k++) {
      i[k] = w[k][0] | 0;
      s[k] = Math.max(0, w[k][1]);
      sum += s[k];
    }
    if (sum <= 1e-6) {
      i[0] = typeof w[0] !== 'undefined' ? w[0][0] | 0 : 0;
      s[0] = 1;
      return;
    }
    const inv = 1 / sum;
    for (let k = 0; k < 4; k++) s[k] *= inv;
  }

  vertex(x, y, z, u, v, w) {
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    this._weights(w);
    this.si.push(this._wi[0], this._wi[1], this._wi[2], this._wi[3]);
    this.sw.push(this._ww[0], this._ww[1], this._ww[2], this._ww[3]);
    return this.pos.length / 3 - 1;
  }

  tri(a, b, c) {
    this.idx.push(a, b, c);
  }

  /** Outward-facing quad, split into two triangles. */
  quad(a, b, c, d) {
    this.idx.push(a, b, c, a, c, d);
  }

  /**
   * Sweep a closed tube along a polyline.
   * @param samples [{ p:Vector3, r|rx,rz:number, w:weights, shape?:(theta,t)=>number }]
   * @param opts { seg, capStart, capEnd, capScale, shape, uvOffset, flipCapNormals }
   */
  tube(samples, opts = {}) {
    const seg = Math.max(3, opts.seg || 12);
    const n = samples.length;
    if (n < 2) return null;

    // --- tangents ---------------------------------------------------------------------
    const tan = [];
    for (let i = 0; i < n; i++) {
      const a = samples[Math.max(0, i - 1)].p;
      const b = samples[Math.min(n - 1, i + 1)].p;
      const t = new THREE.Vector3().subVectors(b, a);
      if (t.lengthSq() < 1e-12) t.copy(tan[i - 1] || _up);
      tan.push(t.normalize());
    }

    // --- parallel-transported frames --------------------------------------------------
    const nor = [];
    const bin = [];
    let ref = Math.abs(tan[0].dot(_up)) > 0.94 ? _alt : _up;
    _n.copy(ref).addScaledVector(tan[0], -ref.dot(tan[0]));
    if (_n.lengthSq() < 1e-10) _n.set(1, 0, 0);
    nor.push(_n.clone().normalize());
    for (let i = 1; i < n; i++) {
      _q.setFromUnitVectors(tan[i - 1], tan[i]);
      const prev = nor[i - 1].clone().applyQuaternion(_q);
      prev.addScaledVector(tan[i], -prev.dot(tan[i]));
      if (prev.lengthSq() < 1e-10) prev.copy(nor[i - 1]);
      nor.push(prev.normalize());
    }
    for (let i = 0; i < n; i++) bin.push(new THREE.Vector3().crossVectors(tan[i], nor[i]).normalize());

    // --- arc length for v ------------------------------------------------------------
    const arc = [0];
    for (let i = 1; i < n; i++) arc.push(arc[i - 1] + samples[i].p.distanceTo(samples[i - 1].p));
    const total = arc[n - 1] || 1;

    const rings = [];
    const shapeFn = opts.shape || null;
    const v0 = opts.uvOffset || 0;

    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const rx = s.rx !== undefined ? s.rx : s.r;
      const rz = s.rz !== undefined ? s.rz : s.r;
      const t = arc[i] / total;
      const circ = Math.PI * (rx + rz);
      const ring = [];
      for (let k = 0; k < seg; k++) {
        const th = (k / seg) * Math.PI * 2;
        let k2 = 1;
        if (s.shape) k2 *= s.shape(th, t);
        if (shapeFn) k2 *= shapeFn(th, t, i);
        const ct = Math.cos(th) * rx * k2;
        const st = Math.sin(th) * rz * k2;
        _p.copy(s.p).addScaledVector(nor[i], ct).addScaledVector(bin[i], st);
        ring.push(this.vertex(_p.x, _p.y, _p.z, (k / seg) * circ, v0 + arc[i], s.w));
      }
      // duplicate the seam vertex so u wraps cleanly instead of shearing the whole texture
      const seam = ring[0];
      _p.fromArray(this.pos, seam * 3);
      ring.push(this.vertex(_p.x, _p.y, _p.z, circ, v0 + arc[i], s.w));
      rings.push(ring);
    }

    for (let i = 0; i < n - 1; i++) {
      for (let k = 0; k < seg; k++) {
        this.quad(rings[i][k], rings[i][k + 1], rings[i + 1][k + 1], rings[i + 1][k]);
      }
    }

    const capScale = opts.capScale !== undefined ? opts.capScale : 1;
    if (opts.capStart) this._dome(samples[0], tan[0], nor[0], bin[0], seg, -1, capScale, v0);
    if (opts.capEnd) {
      const i = n - 1;
      this._dome(samples[i], tan[i], nor[i], bin[i], seg, 1, capScale, v0 + total);
    }
    return rings;
  }

  /** Hemispherical cap on the end of a tube. `dir` = +1 forward along the tangent, -1 back. */
  _dome(sample, tan, nor, bin, seg, dir, capScale, v0) {
    const rings = 4;
    const rx = sample.rx !== undefined ? sample.rx : sample.r;
    const rz = sample.rz !== undefined ? sample.rz : sample.r;
    const depth = ((rx + rz) * 0.5) * capScale;
    let prev = null;
    for (let j = 0; j <= rings; j++) {
      const psi = (j / rings) * (Math.PI * 0.5);
      const rr = Math.cos(psi);
      const off = Math.sin(psi) * depth * dir;
      if (j === rings) {
        _p.copy(sample.p).addScaledVector(tan, off);
        const pole = this.vertex(_p.x, _p.y, _p.z, 0, v0 + off, sample.w);
        for (let k = 0; k < seg; k++) {
          if (dir > 0) this.tri(prev[k], prev[k + 1], pole);
          else this.tri(prev[k + 1], prev[k], pole);
        }
        break;
      }
      const ring = [];
      for (let k = 0; k <= seg; k++) {
        const th = ((k % seg) / seg) * Math.PI * 2;
        const ct = Math.cos(th) * rx * rr;
        const st = Math.sin(th) * rz * rr;
        _p.copy(sample.p).addScaledVector(nor, ct).addScaledVector(bin, st).addScaledVector(tan, off);
        const circ = Math.PI * (rx + rz) * rr;
        ring.push(this.vertex(_p.x, _p.y, _p.z, (k / seg) * circ, v0 + off, sample.w));
      }
      if (prev) {
        for (let k = 0; k < seg; k++) {
          if (dir > 0) this.quad(prev[k], prev[k + 1], ring[k + 1], ring[k]);
          else this.quad(prev[k], ring[k], ring[k + 1], prev[k + 1]);
        }
      }
      prev = ring;
    }
  }

  /**
   * A UV-sphere ellipsoid with a per-vertex warp — the sculpting primitive for the head, the
   * shoulders, the heel of the palm and the ears.
   * @param opts { center, radius:Vector3, seg, rings, w, warp(dir,u,v,out)=>void, quaternion }
   */
  blob(opts) {
    const seg = Math.max(4, opts.seg || 16);
    const rings = Math.max(3, opts.rings || 12);
    const c = opts.center;
    const R = opts.radius;
    const warp = opts.warp || null;
    const quat = opts.quaternion || null;
    const uvScale = opts.uvScale !== undefined ? opts.uvScale : 1;
    const grid = [];
    for (let j = 0; j <= rings; j++) {
      const v = j / rings;
      const phi = v * Math.PI;
      const sp = Math.sin(phi);
      const cp = Math.cos(phi);
      const row = [];
      for (let k = 0; k <= seg; k++) {
        const u = k / seg;
        const th = u * Math.PI * 2;
        _d.set(sp * Math.sin(th), cp, sp * Math.cos(th));
        _p.set(_d.x * R.x, _d.y * R.y, _d.z * R.z);
        if (warp) warp(_d, u, v, _p);
        if (quat) _p.applyQuaternion(quat);
        _p.add(c);
        row.push(this.vertex(_p.x, _p.y, _p.z, u * uvScale, v * uvScale, opts.w));
      }
      grid.push(row);
    }
    for (let j = 0; j < rings; j++) {
      for (let k = 0; k < seg; k++) {
        const a = grid[j][k];
        const b = grid[j][k + 1];
        const c2 = grid[j + 1][k + 1];
        const d = grid[j + 1][k];
        if (j === 0) this.tri(a, c2, d);
        else if (j === rings - 1) this.tri(a, b, c2);
        else this.quad(a, b, c2, d);
      }
    }
    return grid;
  }

  /** Flat-ish disc used for fingernails and irises: a warped cap, not a full blob. */
  disc(center, normal, radius, w, opts = {}) {
    const seg = Math.max(5, opts.seg || 10);
    const bulge = opts.bulge !== undefined ? opts.bulge : 0.25;
    const squash = opts.squash !== undefined ? opts.squash : 1;
    _t.copy(normal).normalize();
    const ref = Math.abs(_t.dot(_up)) > 0.94 ? _alt : _up;
    _n.copy(ref).addScaledVector(_t, -ref.dot(_t)).normalize();
    _b.crossVectors(_t, _n);
    const centreIdx = this.vertex(
      center.x + _t.x * radius * bulge,
      center.y + _t.y * radius * bulge,
      center.z + _t.z * radius * bulge,
      0, 0, w,
    );
    const ring = [];
    for (let k = 0; k <= seg; k++) {
      const th = ((k % seg) / seg) * Math.PI * 2;
      const ct = Math.cos(th) * radius;
      const st = Math.sin(th) * radius * squash;
      _p.copy(center).addScaledVector(_n, ct).addScaledVector(_b, st);
      ring.push(this.vertex(_p.x, _p.y, _p.z, ct, st, w));
    }
    for (let k = 0; k < seg; k++) this.tri(centreIdx, ring[k], ring[k + 1]);
    return ring;
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.name = this.name;
    return g;
  }
}

/**
 * Turn a joint chain into tube samples with skin weights that blend across each joint.
 * @param joints [{ p:Vector3, bone:int, r:number, rz?:number }] in order, root → tip
 * @param opts { sub:number samples per segment, blend:metres either side of a joint,
 *               shape:(theta,t)=>number, radiusFn:(t,i)=>number }
 */
export function limbPath(joints, opts = {}) {
  const sub = Math.max(1, opts.sub || 3);
  const blend = opts.blend !== undefined ? opts.blend : 0.055;
  const out = [];
  const total = joints.length - 1;
  for (let i = 0; i < total; i++) {
    const a = joints[i];
    const b = joints[i + 1];
    const len = a.p.distanceTo(b.p) || 1e-4;
    const steps = i === total - 1 ? sub : sub;
    for (let s = 0; s <= steps; s++) {
      if (i > 0 && s === 0) continue; // shared with the previous segment's last sample
      const f = s / steps;
      const p = new THREE.Vector3().lerpVectors(a.p, b.p, f);
      const dFromA = f * len;
      const dFromB = (1 - f) * len;
      // weight blends only near the joint we are actually crossing
      let w;
      if (i > 0 && dFromA < blend) {
        const k = 0.5 + 0.5 * smoothstep(0, 1, dFromA / blend);
        w = [[a.bone, k], [joints[i - 1].bone, 1 - k]];
      } else if (i < total - 1 && dFromB < blend) {
        const k = 0.5 + 0.5 * smoothstep(0, 1, dFromB / blend);
        w = [[a.bone, k], [b.bone, 1 - k]];
      } else {
        w = [[a.bone, 1]];
      }
      const r = opts.radiusFn
        ? opts.radiusFn((i + f) / total, i, f)
        : THREE.MathUtils.lerp(a.r, b.r, f);
      const rz = opts.radiusZFn
        ? opts.radiusZFn((i + f) / total, i, f)
        : (a.rz !== undefined && b.rz !== undefined ? THREE.MathUtils.lerp(a.rz, b.rz, f) : undefined);
      out.push({ p, r, rz, w, shape: opts.shape || null });
    }
  }
  return out;
}

/** Seeded 2-D value noise, used for fabric folds and skin micro-form. Deterministic. */
export function makeFolds(rnd, count = 4) {
  const waves = [];
  for (let i = 0; i < count; i++) {
    waves.push({
      a: 0.012 + rnd() * 0.03,
      ka: 2 + Math.floor(rnd() * 5),
      kt: 1.5 + rnd() * 6,
      ph: rnd() * Math.PI * 2,
    });
  }
  return (theta, t) => {
    let s = 1;
    for (let i = 0; i < waves.length; i++) {
      const w = waves[i];
      s += w.a * Math.sin(theta * w.ka + t * w.kt + w.ph);
    }
    return s;
  };
}

export { smoothstep };
