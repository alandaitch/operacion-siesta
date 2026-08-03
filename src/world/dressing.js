// OPERATION NAPTIME — module DRESS — the set dressing.
// OWNER: DRESS. Implements CONTRACTS.md §3 (`buildDressing(ctx) → { group, props, update }`).
//
// ROOM builds the shell and FURN builds the furniture; this module puts the *life* into the room.
// Everything a ten-month-old would head straight for lives here: fifty-one books, two studio
// monitors, a knobbly ceramic vase, a crate of records, a nine-leaf monstera, fourteen plush toys,
// a ukulele, a dark laptop on the sofa and an orange foil packet on the rug. Sixty-seven registered
// props, fourteen of them edible. That census IS the game economy — the objective board in
// gameplay/objectives.js filters itself against what it finds in the registry, so anything this
// file fails to build simply stops being a thing the player can be asked to do.
//
// THE FREEZE / THAW LADDER
// Sixty-seven rigid bodies awake at once would blow PHYS's forty-body budget on the first frame,
// and — worse — they would *settle*. The composition here is authored, not simulated: the book
// stack is mid-collapse, the plush toys interpenetrate, the records lean on each other. Let the
// solver near any of that at load and it tidies the room up for you.
//
// So every prop gets a real dynamic body which is then frozen (Rapier flips it to a fixed body:
// same cost as a static collider, zero motion), and the sweep in `update()` below thaws the
// handful within 1.15 m of the baby. Freezing rather than swapping the body is the important part
// — GAME caches one physics record per prop when the round starts, so a prop whose record is
// destroyed and rebuilt on approach would silently drop out of the topple watcher and could never
// score again. The exceptions are declared at the call site: the monstera's pot is live from frame
// one (the highest-value target in the game must never feel bolted down), the play-gym toys hang
// on spherical joints, and the rug and the play mat are `anchor: true` — the baby stands on those,
// and a floor that can be thawed is a floor that can be knocked over.
//
// Build order is load-bearing in exactly one place: the rug publishes its displaced height field,
// and everything lying on the rug samples it, so the rug goes first.

import { createDresser } from './dressing/util.js';
import { buildRug } from './dressing/rug.js';
import { buildShelfObjects } from './dressing/shelf.js';
import { buildBooks } from './dressing/books.js';
import { buildPlants } from './dressing/plants.js';
import { buildPlaypen, MAT_TOP } from './dressing/playpen.js';
import { buildToys } from './dressing/toys.js';
import { buildClutter } from './dressing/clutter.js';

/** How close the baby has to get before a frozen prop is thawed into a live body. */
const PROMOTE_RADIUS = 1.15;
const PROMOTE_INTERVAL = 0.2;
/** Thaws per sweep. Rate-limited so barging into the toy pile cannot spike a frame. */
const PROMOTE_BUDGET = 6;

export function buildDressing(ctx) {
  const D = createDresser(ctx);

  // The rug first: it owns the height field that the snack bag, the pacifier, the crayons and
  // both socks sample to sit ON the pile rather than a millimetre above it.
  buildRug(D);

  buildShelfObjects(D);
  buildBooks(D);
  buildPlants(D);
  const playpen = buildPlaypen(D);
  buildToys(D, MAT_TOP);
  buildClutter(D);

  const promoted = [];
  let sweepTimer = 0;
  const focus = { x: 0, y: 0.42, z: 0 };

  /** Where the baby actually is, falling back to the live camera during early boot. */
  function readFocus() {
    const baby = ctx.baby;
    const p = (baby && (baby.position || (baby.group && baby.group.position))) || ctx.camera?.position;
    if (!p) return false;
    focus.x = p.x;
    focus.y = p.y;
    focus.z = p.z;
    return true;
  }

  function sweep() {
    if (!ctx.physics || !readFocus()) return;
    const list = D.promotable;
    let budget = PROMOTE_BUDGET;
    const r2 = PROMOTE_RADIUS * PROMOTE_RADIUS;
    for (let i = list.length - 1; i >= 0 && budget > 0; i--) {
      const entry = list[i];
      const home = entry.home.world;
      const dx = home.x - focus.x;
      const dy = home.y - focus.y;
      const dz = home.z - focus.z;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      const record = D.promote(entry.prop);
      if (record) {
        promoted.push(entry.prop);
        budget--;
      } else {
        // Nothing to thaw (no body, or already live): drop it so we stop retrying every sweep.
        list.splice(i, 1);
      }
    }
  }

  return {
    group: D.group,
    props: D.props,

    update(dt) {
      // Photo mode is deterministic and the camera never moves: promoting mid-settle could nudge
      // a prop between the harness's two screenshots, so nothing is promoted there.
      if (ctx.state.mode !== 'photo') {
        sweepTimer += dt;
        if (sweepTimer >= PROMOTE_INTERVAL) {
          sweepTimer = 0;
          sweep();
        }
      }
      // The play-gym cords follow their pendulums every frame, in every mode — in photo mode the
      // world is settled and the cords have to end up hanging correctly under the arch.
      playpen.update();
    },

    reset() {
      for (let i = promoted.length - 1; i >= 0; i--) D.demote(promoted[i]);
      promoted.length = 0;
      sweepTimer = 0;
    },

    /** Debug hook: `__GAME__.props.list.length` never tells you how the budget is spent. */
    stats() {
      return {
        props: D.props.length,
        edible: D.props.filter((p) => p.kind === 'edible').length,
        frozen: D.promotable.length,
        thawed: promoted.length,
      };
    },

    dispose() {
      if (D.group.parent) D.group.parent.remove(D.group);
    },
  };
}
