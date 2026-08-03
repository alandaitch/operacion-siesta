// PHYS · pendulums for the bare bulb and the play-gym toys.
//
// The bulb hangs 1.1 m off the slab on a black fabric cord; the elephant and the rings hang off
// the fabric arch inside the playpen. Both want the same thing: a body that swings on a spherical
// joint and settles, not a bone chain animated by hand.
//
// A single-segment pendulum is a rigid rod on a ball joint — period 2π√(L/g), so 2.1 s for the
// bulb's 1.1 m cord, which is exactly the slow lazy swing the reference photo implies. Two or
// three segments turn it into a soft rope: intermediate links carry mass via
// setAdditionalMass() and deliberately carry *no collider*, so the cord itself never snags on
// anything, only the object at the end does.

import * as THREE from 'three';

const _v = new THREE.Vector3();

export function createPendulums({ RAPIER, world, registerLink, unregister, GROUPS }) {
  const all = [];

  function addPendulum(object3d, options = {}) {
    if (!object3d) {
      console.warn('[phys] addPendulum called without an object3d');
      return null;
    }
    const {
      length = 1.1,
      segments = 1,
      radius = 0.035,
      mass = 0.12,
      shape = 'ball',
      linearDamping = 0.25,
      angularDamping = 0.6,
      friction = 0.6,
      restitution = 0.05,
      material = null,
      swing = 0,
    } = options;

    object3d.updateWorldMatrix(true, false);
    object3d.getWorldPosition(_v);

    const anchor = options.anchor
      ? { x: options.anchor.x, y: options.anchor.y, z: options.anchor.z }
      : { x: _v.x, y: _v.y + length, z: _v.z };

    const segLen = length / Math.max(1, segments);
    const anchorBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(anchor.x, anchor.y, anchor.z),
    );

    const links = [];
    const joints = [];
    let prev = anchorBody;

    for (let k = 1; k <= segments; k++) {
      const y = anchor.y - segLen * k;
      const last = k === segments;
      const desc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(anchor.x, y, anchor.z)
        .setLinearDamping(last ? linearDamping : linearDamping * 1.6)
        .setAngularDamping(last ? angularDamping : angularDamping * 1.5)
        .setCanSleep(true);
      if (!last) desc.setAdditionalMass(Math.max(0.004, mass * 0.12));
      const body = world.createRigidBody(desc);

      let collider = null;
      if (last) {
        let cd;
        if (shape === 'box') cd = RAPIER.ColliderDesc.cuboid(radius, radius, radius);
        else if (shape === 'capsule') cd = RAPIER.ColliderDesc.capsule(Math.max(radius * 0.6, 0.005), radius);
        else if (shape === 'cylinder') cd = RAPIER.ColliderDesc.cylinder(Math.max(radius * 0.4, 0.005), radius);
        else cd = RAPIER.ColliderDesc.ball(radius);
        cd.setMass(Math.max(0.01, mass))
          .setFriction(friction)
          .setRestitution(restitution)
          .setCollisionGroups(GROUPS.dynamic)
          .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(Math.max(3, mass * 9.81 * 2.2));
        collider = world.createCollider(cd, body);
      }

      const j = world.createImpulseJoint(
        k === 1
          ? RAPIER.JointData.spherical({ x: 0, y: 0, z: 0 }, { x: 0, y: segLen, z: 0 })
          : RAPIER.JointData.spherical({ x: 0, y: -segLen * 0.5, z: 0 }, { x: 0, y: segLen * 0.5, z: 0 }),
        prev,
        body,
        true,
      );
      joints.push(j);

      links.push({ body, collider, last });
      prev = body;
    }

    const tip = links[links.length - 1];
    const record = registerLink(object3d, tip.body, tip.collider, {
      material: material || null,
      mass,
      kind: 'pendulum',
    });

    if (swing) {
      tip.body.applyImpulse({ x: swing * mass, y: 0, z: swing * mass * 0.35 }, true);
    }

    const pendulum = {
      object3d,
      anchorBody,
      anchor,
      links,
      joints,
      body: tip.body,
      collider: tip.collider,
      record,
      length,
      segments,

      /** World positions of anchor + every link, for LIGHT to draw the cord. */
      chain(out = []) {
        out.length = 0;
        out.push(new THREE.Vector3(anchor.x, anchor.y, anchor.z));
        for (let i = 0; i < links.length; i++) {
          const t = links[i].body.translation();
          out.push(new THREE.Vector3(t.x, t.y, t.z));
        }
        return out;
      },

      nudge(impulse) {
        if (!impulse) return;
        tip.body.applyImpulse(
          { x: impulse.x || 0, y: impulse.y || 0, z: impulse.z || 0 },
          true,
        );
      },

      setAnchor(p) {
        if (!p) return;
        anchor.x = p.x; anchor.y = p.y; anchor.z = p.z;
        anchorBody.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
      },

      sleep() { for (let i = 0; i < links.length; i++) links[i].body.sleep(); },
      wake() { for (let i = 0; i < links.length; i++) links[i].body.wakeUp(); },

      remove() {
        const i = all.indexOf(pendulum);
        if (i >= 0) all.splice(i, 1);
        for (let k = joints.length - 1; k >= 0; k--) {
          try { world.removeImpulseJoint(joints[k], false); } catch { /* already gone */ }
        }
        joints.length = 0;
        unregister(record);
        for (let k = links.length - 1; k >= 0; k--) {
          if (links[k].body === tip.body) continue; // removed with the record
          try { world.removeRigidBody(links[k].body); } catch { /* already gone */ }
        }
        links.length = 0;
        try { world.removeRigidBody(anchorBody); } catch { /* already gone */ }
      },
    };

    all.push(pendulum);
    return pendulum;
  }

  return {
    all,
    addPendulum,
    disposeAll() {
      for (let i = all.length - 1; i >= 0; i--) all[i].remove();
      all.length = 0;
    },
  };
}
