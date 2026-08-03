// Dynamic resolution. OWNER: integrator.
//
// Why this exists. A quality tier is a guess made once, from a GPU string, about a machine we
// cannot see. It gets the architecture right and the thermal envelope, the display scale, the
// other twenty tabs and the power mode all wrong. This is the closed loop that corrects it: it
// watches the frame time the machine actually delivers and moves one continuous knob — the render
// resolution — until the frame fits the budget. Every expensive stage in this renderer is
// fill-bound (the AO, the poisson shadow filter, the merged grade pass, SMAA), so resolution buys
// frame rate almost linearly, and it degrades smoothly instead of popping a feature off.
//
// How it decides. The controller reads the median of a short ring of frame times, not the mean,
// because a single 200 ms hitch from a shader compile or a GC must not be allowed to collapse the
// resolution. It then applies asymmetric hysteresis:
//   · DOWN is fast and proportional. If the median is over budget we scale by roughly the ratio
//     the budget needs, in one step, clamped. A player in a slideshow wants it fixed now.
//   · UP is slow and cautious. We only climb after the frame has been comfortably under budget
//     (below the low-water mark, which is well under the target) for a sustained stretch, and we
//     climb in small steps. This is what stops the oscillation that a symmetric controller shows
//     as a resolution that visibly breathes.
// A change costs a renderer resize and a composer reallocation, so a cooldown enforces a minimum
// spacing between moves, and moves smaller than the engine's own epsilon are dropped.
//
// What it must never do. Touch anything in photo mode (`ctx.state.mode === 'photo'`), because the
// screenshot harness requires byte-comparable frames; run before the scene has settled, because
// the first seconds are dominated by shader compilation and would drive it straight to the floor;
// or override a resolution the player has chosen by hand — `setEnabled(false)` latches it off.

const RING = 24;

export function createAdaptive(ctx, options = {}) {
  const engine = ctx.engine;
  if (!engine || typeof engine.setRenderScale !== 'function') {
    return { update() {}, reset() {}, setEnabled() {}, get scale() { return 1; } };
  }

  const targetFps = options.targetFps || 60;
  const budgetMs = 1000 / targetFps;
  // Aim slightly under the budget: a controller that targets exactly 16.7 ms sits on the vsync
  // boundary and flips between 60 and 30 fps every few seconds.
  //
  // These are expressed as multiples of the vsync interval, and that is the whole subtlety. The
  // signal we get is the frame DELTA, which is vsync-locked: on a healthy 60 fps frame it reads
  // ~16.7 ms no matter how much GPU headroom is going spare. The original thresholds (0.94 and
  // 0.68 of the budget) therefore described an impossible world — 11.3 ms is unreachable under
  // vsync, so the climb branch could never fire, while 15.7 ms is exceeded by every single
  // vsynced frame, so the drop branch always fired. The controller was guaranteed to walk to its
  // floor and stay there, which is exactly what it did: renderScale pinned at 0.5 while the frame
  // had headroom to spare.
  //
  // So: only scale DOWN once we are visibly missing vsync, and treat holding the interval as the
  // evidence of headroom that it is. Climbing is still slow, small-stepped and cooldown-gated, so
  // sitting exactly on the boundary costs at most a slow breathe rather than an oscillation.
  const highWater = budgetMs * 1.15;
  const lowWater = budgetMs * 1.02;
  const minScale = options.minScale || 0.5;
  const maxScale = options.maxScale || 1;
  const cooldownS = options.cooldown || 0.55;
  const climbAfterS = options.climbAfter || 1.6;

  const ring = new Float32Array(RING);
  const sorted = new Float32Array(RING);
  let ringIndex = 0;
  let ringCount = 0;

  let scale = maxScale;
  let enabled = options.enabled !== false;
  let warmup = options.warmup ?? 2.5; // seconds of grace for shader compilation
  let cooldown = 0;
  let comfortable = 0;
  let moves = 0;

  function median() {
    sorted.set(ring);
    const view = sorted.subarray(0, ringCount);
    view.sort();
    return view[ringCount >> 1];
  }

  function apply(next) {
    const clamped = Math.max(minScale, Math.min(maxScale, next));
    if (!engine.setRenderScale(clamped)) return false;
    scale = engine.getRenderScale();
    // The engine resized its own drawing buffer; every module that owns a render target of its
    // own — the composer above all — has to be told. main.js hands us its resize fan-out.
    options.onResize?.();
    moves++;
    cooldown = cooldownS;
    comfortable = 0;
    ringCount = 0; // the old samples describe a resolution that no longer exists
    ringIndex = 0;
    ctx.events?.emit('quality:renderScale', { scale, targetFps });
    return true;
  }

  function update(dt) {
    if (!enabled) return;
    const step = Math.min(dt || 0, 0.25);
    const mode = ctx.state ? ctx.state.mode : 'boot';
    // Photo mode is deterministic by contract; menus are not worth measuring and a paused frame
    // is not representative of a moving one.
    if (mode === 'photo' || mode === 'boot') return;
    if (warmup > 0) {
      warmup -= step;
      return;
    }
    if (cooldown > 0) cooldown -= step;

    const ms = step * 1000;
    // A frame long enough to be a stall rather than a cost — a shader compile, a GC, a tab that
    // just came back to the foreground — is not evidence about steady-state resolution.
    if (ms > 250) return;
    ring[ringIndex] = ms;
    ringIndex = (ringIndex + 1) % RING;
    ringCount = Math.min(ringCount + 1, RING);
    if (ringCount < RING) return;

    const med = median();
    if (cooldown > 0) return;

    if (med > highWater && scale > minScale) {
      // Cost scales with pixel count, so the resolution ratio is the square root of the time
      // ratio. Take 80% of the indicated step; overshooting down looks worse than converging.
      const want = scale * Math.sqrt(highWater / med);
      apply(scale - (scale - want) * 0.8);
      return;
    }

    if (med < lowWater && scale < maxScale) {
      comfortable += step;
      if (comfortable >= climbAfterS) apply(scale + 0.06);
      return;
    }
    comfortable = 0;
  }

  return {
    update,
    get scale() { return scale; },
    get moves() { return moves; },
    /** Frame-time budget the loop is holding to, in ms. Read by the HUD's stats overlay. */
    get budgetMs() { return budgetMs; },
    setEnabled(on) {
      enabled = !!on;
      if (!enabled) return;
      warmup = 0.8;
      ringCount = 0;
      ringIndex = 0;
    },
    setTargetFps() { /* fixed for the round; a mid-round change would invalidate the ring */ },
    reset() {
      ringCount = 0;
      ringIndex = 0;
      comfortable = 0;
      cooldown = 0;
      warmup = Math.max(warmup, 1.0);
    },
  };
}
