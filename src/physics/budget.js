// PHYS · awake-body budget and out-of-world recovery.
//
// The room contains a few hundred knockable things — books, toys, vinyl, plush, shards. Rapier
// is happy to simulate all of them, but the frame budget is not, so at most `maxAwake` dynamic
// bodies may be awake at once. Once a second we count the awake ones and, if we are over, force
// the furthest from the player back to sleep (they are behind the baby, nobody is looking).
// Bodies close to the player get woken instead, so brushing past a toy pile always does
// something even if Rapier had parked it.
//
// Anything that leaks through the floor — a shard squeezed out by a stack, a book flung into a
// seam — is caught below y = -2 and either teleported back to where it was authored or, if it
// was spawned at runtime, removed outright.

export function createBudget({ maxAwake = 40, wakeRadius = 0.8, sleepFloor = -2 } = {}) {
  const scratch = [];
  let timer = 0;
  let lastFocusX = 0, lastFocusY = 0, lastFocusZ = 0;
  let overflowEvents = 0;
  let awakeCount = 0;
  let limit = maxAwake;

  return {
    get awake() { return awakeCount; },
    get overflow() { return overflowEvents; },
    get maxAwake() { return limit; },
    set maxAwake(n) { limit = Math.max(4, Math.min(200, n | 0)); },

    /** Called every fixed step. `records` is the live array of dynamic records. */
    tick(dt, records, focus, onFall) {
      timer += dt;
      if (timer < 1) return;
      timer = 0;

      const fx = focus ? focus.x : 0;
      const fy = focus ? focus.y : 0;
      const fz = focus ? focus.z : 0;
      const focusMoved = (fx - lastFocusX) ** 2 + (fy - lastFocusY) ** 2 + (fz - lastFocusZ) ** 2 > 4e-4;
      lastFocusX = fx; lastFocusY = fy; lastFocusZ = fz;

      scratch.length = 0;
      let awake = 0;
      let woken = 0;

      for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        const body = rec.body;
        if (!body || rec.removed || !rec.dynamic) continue;

        const sleeping = body.isSleeping();
        // Position: use the cached transform from the last sync — no WASM round-trip.
        const dx = rec.curPos.x - fx;
        const dy = rec.curPos.y - fy;
        const dz = rec.curPos.z - fz;
        const d2 = dx * dx + dy * dy + dz * dz;

        if (rec.curPos.y < sleepFloor) {
          onFall(rec);
          continue;
        }

        if (!sleeping) {
          awake++;
          if (!rec.pinned) {
            rec.dist2 = d2;
            scratch.push(rec);
          }
        } else if (focusMoved && woken < 8 && d2 < wakeRadius * wakeRadius && awake < limit) {
          body.wakeUp();
          woken++;
          awake++;
        }
      }

      awakeCount = awake;

      if (awake > limit && scratch.length) {
        overflowEvents++;
        // Furthest first, then sleep until we are back inside budget.
        scratch.sort((a, b) => b.dist2 - a.dist2);
        let over = awake - limit;
        for (let i = 0; i < scratch.length && over > 0; i++) {
          const rec = scratch[i];
          // Never park something the player is basically touching.
          if (rec.dist2 < 0.35 * 0.35) continue;
          rec.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
          rec.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
          rec.body.sleep();
          rec.settled = true;
          over--;
          awakeCount--;
        }
        scratch.length = 0;
      }
    },

    reset() {
      timer = 0;
      overflowEvents = 0;
      awakeCount = 0;
      scratch.length = 0;
    },
  };
}
