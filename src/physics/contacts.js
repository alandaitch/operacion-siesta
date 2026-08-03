// PHYS · contact events, material classification, rate limiting.
//
// Rapier fires a contact-force event whenever the summed contact force between two colliders
// passes that collider's threshold. Left raw this is a firehose — a book resting on a shelf
// generates its own weight in force every single step — so two filters run here. First, each
// collider's threshold is set from its own weight (mass·g·k), which silences resting contacts
// entirely. Second, a per-pair rate limit caps a colliding pair at ~6 events per second, because
// AUDIO plays one sample per event and a tumbling vinyl crate would otherwise machine-gun.
//
// The event also carries a `materialGuess`: the harder of the two surfaces, derived from the
// material names in CONTRACTS.md §10 ("glass.clear" → glass). AUDIO picks a sample from it and
// FX picks a particle. `damped` is true when the other surface is a soft absorber (rug, bouclé,
// plush) so a vase landing on the rug thuds instead of cracking.

import * as THREE from 'three';

const PREFIX_CATEGORY = {
  concrete: 'concrete', plaster: 'plaster', floor: 'wood', wood: 'wood', rattan: 'wicker',
  fabric: 'fabric', rug: 'rug', lampshade: 'fabric', cloth: 'fabric',
  glass: 'glass', metal: 'metal', ceramic: 'ceramic', marble: 'stone', brick: 'stone',
  plastic: 'plastic', silicone: 'rubber', foil: 'foil',
  paper: 'paper', card: 'paper', vinyl: 'vinyl', art: 'canvas',
  leaf: 'leaf', foliage: 'leaf', soil: 'soil', bark: 'wood',
  skin: 'flesh', hair: 'flesh', eye: 'glass',
  screen: 'glass', emissive: 'glass', sky: 'none',
};

const KEYWORD_CATEGORY = [
  ['plush', 'plush'], ['teddy', 'plush'], ['bunny', 'plush'], ['muslin', 'fabric'],
  ['cushion', 'fabric'], ['pillow', 'fabric'], ['blanket', 'fabric'], ['boucle', 'fabric'],
  ['velvet', 'fabric'], ['mesh', 'fabric'], ['curtain', 'fabric'], ['playmat', 'fabric'],
  ['book', 'paper'], ['magazine', 'paper'], ['page', 'paper'],
  ['vase', 'ceramic'], ['mug', 'ceramic'], ['pot', 'ceramic'], ['bowl', 'ceramic'],
  ['glass', 'glass'], ['window', 'glass'], ['bulb', 'glass'], ['laptop', 'plastic'],
  ['speaker', 'wood'], ['ukulele', 'wood'], ['shelf', 'wood'], ['ply', 'wood'],
  ['toy', 'plastic'], ['ring', 'plastic'], ['cup', 'plastic'], ['box', 'card'],
  ['snack', 'foil'], ['bag', 'foil'], ['crisp', 'foil'],
  ['rug', 'rug'], ['carpet', 'rug'], ['radiator', 'metal'], ['chrome', 'metal'],
  ['espresso', 'metal'], ['lamp', 'metal'], ['plant', 'leaf'], ['monstera', 'leaf'],
];

/** How "loud and bright" a surface is on impact. Higher wins the materialGuess. */
const HARDNESS = {
  glass: 10, ceramic: 9, stone: 9, marble: 9, metal: 8, vinyl: 7, wicker: 6.5, wood: 6,
  plastic: 5, concrete: 5, plaster: 4, canvas: 4, paper: 4, card: 4, foil: 4, rubber: 3.5,
  leaf: 3, soil: 2, rug: 2, fabric: 1.5, plush: 1, flesh: 1, none: 0, generic: 3,
};

const SOFT = new Set(['rug', 'fabric', 'plush', 'soil', 'flesh', 'rubber']);

/** Map a material/mesh name onto one of the categories above. */
export function categoriseName(name) {
  if (!name) return null;
  const lower = String(name).toLowerCase();
  const dot = lower.indexOf('.');
  if (dot > 0) {
    const cat = PREFIX_CATEGORY[lower.slice(0, dot)];
    if (cat) return cat;
  }
  if (PREFIX_CATEGORY[lower]) return PREFIX_CATEGORY[lower];
  for (let i = 0; i < KEYWORD_CATEGORY.length; i++) {
    if (lower.includes(KEYWORD_CATEGORY[i][0])) return KEYWORD_CATEGORY[i][1];
  }
  return null;
}

/** Best guess at what an Object3D is made of: material name → mesh name → object name. */
export function guessMaterial(object3d, fallback = 'generic') {
  if (!object3d) return fallback;
  let found = null;
  const visit = (o) => {
    if (found) return;
    const m = o.material;
    if (m) {
      const mats = Array.isArray(m) ? m : [m];
      for (let i = 0; i < mats.length; i++) {
        const cat = (mats[i] && mats[i].userData && mats[i].userData.physMaterial)
          || categoriseName(mats[i] && mats[i].name);
        if (cat) { found = cat; return; }
      }
    }
    const byName = categoriseName(o.name);
    if (byName) { found = byName; return; }
  };
  visit(object3d);
  if (!found && object3d.traverse) object3d.traverse(visit);
  return found || fallback;
}

export function hardnessOf(cat) {
  return HARDNESS[cat] !== undefined ? HARDNESS[cat] : HARDNESS.generic;
}

export function createContactRouter({
  world,
  recordForCollider,
  minForce = 2.5,
  minSpeed = 0.12,
  minSpin = 0.8,
  maxPerPairPerSecond = 6,
}) {
  const listeners = new Set();
  const lastByPair = new Map();
  const minInterval = 1 / Math.max(1, maxPerPairPerSecond);
  let lastPrune = 0;
  let dispatched = 0;

  // Scratch for the position/normal probe; copied into a fresh payload before dispatch, because
  // a dozen subscribers may hold onto the event and a shared object would rot under them.
  const scratch = { px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0 };

  const speed2 = minSpeed * minSpeed;
  const spin2 = minSpin * minSpin;
  function moving(body) {
    if (!body || body.isSleeping()) return false;
    if (body.isKinematic && body.isKinematic()) return true;
    const v = body.linvel();
    if (v.x * v.x + v.y * v.y + v.z * v.z > speed2) return true;
    const w = body.angvel();
    return w.x * w.x + w.y * w.y + w.z * w.z > spin2;
  }

  function fillPosition(c1, c2) {
    let got = false;
    try {
      if (c1 && c2) {
        world.contactPair(c1, c2, (manifold) => {
          if (got) return;
          if (manifold.numSolverContacts() > 0) {
            const p = manifold.solverContactPoint(0);
            if (p) {
              scratch.px = p.x; scratch.py = p.y; scratch.pz = p.z;
              got = true;
            }
          }
          const n = manifold.normal();
          if (n) { scratch.nx = n.x; scratch.ny = n.y; scratch.nz = n.z; }
        });
      }
    } catch {
      got = false;
    }
    if (!got) {
      // Fall back to the midpoint between the two collider origins.
      const t1 = c1 ? c1.translation() : null;
      const t2 = c2 ? c2.translation() : null;
      if (t1 && t2) {
        scratch.px = (t1.x + t2.x) * 0.5;
        scratch.py = (t1.y + t2.y) * 0.5;
        scratch.pz = (t1.z + t2.z) * 0.5;
      } else if (t1) {
        scratch.px = t1.x; scratch.py = t1.y; scratch.pz = t1.z;
      }
    }
  }

  return {
    listeners,
    get dispatched() { return dispatched; },

    /** @returns unsubscribe */
    on(cb) {
      if (typeof cb !== 'function') return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    off(cb) { listeners.delete(cb); },

    /** Threshold a collider should use so its own resting weight never fires an event. */
    thresholdFor(mass) {
      return Math.max(minForce, (mass || 1) * 9.81 * 2.2);
    },

    drain(queue, simTime) {
      if (!queue) return;
      if (listeners.size === 0) {
        queue.drainContactForceEvents(() => {});
        return;
      }
      queue.drainContactForceEvents((event) => {
        const force = event.totalForceMagnitude();
        if (force < minForce) return;

        const h1 = event.collider1();
        const h2 = event.collider2();
        const key = h1 < h2 ? h1 * 1048576 + h2 : h2 * 1048576 + h1;
        const last = lastByPair.get(key);
        if (last !== undefined && simTime - last < minInterval) return;

        let c1 = null;
        let c2 = null;
        try { c1 = world.getCollider(h1) || null; } catch { c1 = null; }
        try { c2 = world.getCollider(h2) || null; } catch { c2 = null; }
        const r1 = recordForCollider(h1);
        const r2 = recordForCollider(h2);

        // A pile of toys resting on each other exceeds the force threshold forever. An *impact*
        // needs something actually moving, so require one of the two bodies to be in motion.
        const b1 = r1 ? r1.body : (c1 ? c1.parent() : null);
        const b2 = r2 ? r2.body : (c2 ? c2.parent() : null);
        if (!moving(b1) && !moving(b2)) return;
        lastByPair.set(key, simTime);

        const dir = event.maxForceDirection();
        if (dir) { scratch.nx = dir.x; scratch.ny = dir.y; scratch.nz = dir.z; }
        fillPosition(c1, c2);

        const ma = (r1 && r1.material) || 'generic';
        const mb = (r2 && r2.material) || 'generic';
        const harder = hardnessOf(ma) >= hardnessOf(mb) ? ma : mb;
        // Normalised 0..1 hit strength; ~600 N (a dropped mug on tile) reads as 1.
        const refMass = Math.max(0.08, Math.min((r1 && r1.mass) || 1, (r2 && r2.mass) || 1));

        const payload = {
          a: r1 ? r1.object3d : null,
          b: r2 ? r2.object3d : null,
          propA: (r1 && r1.prop) || null,
          propB: (r2 && r2.prop) || null,
          prop: (r1 && r1.prop) || (r2 && r2.prop) || null,
          colliderA: c1,
          colliderB: c2,
          bodyA: b1,
          bodyB: b2,
          force,
          impact: Math.min(1, force / (240 + refMass * 340)),
          position: new THREE.Vector3(scratch.px, scratch.py, scratch.pz),
          normal: new THREE.Vector3(scratch.nx, scratch.ny, scratch.nz),
          materialA: ma,
          materialB: mb,
          materialGuess: harder,
          materialSoft: harder === ma ? mb : ma,
          damped: SOFT.has(ma) || SOFT.has(mb),
        };

        dispatched++;
        for (const cb of listeners) {
          try { cb(payload); } catch (err) { console.error('[phys] contact listener threw:', err); }
        }
      });

      if (simTime - lastPrune > 4) {
        lastPrune = simTime;
        for (const [k, t] of lastByPair) if (simTime - t > 3) lastByPair.delete(k);
      }
    },

    clear() {
      lastByPair.clear();
    },
  };
}
