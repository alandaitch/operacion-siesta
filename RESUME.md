# Where we left off — 2026-08-03, full resolution at a locked 60

**Live: https://operacion-siesta.vercel.app** — rebuilt and redeployed, verified 200.

`tools/smoke.mjs`: **renderScale 1.0, 60.1 avg / 59.9 min fps, 470 draw calls, errors [],
warnings [], PASS.** The game now renders at full resolution and holds vsync. It was shipping at
half resolution as recently as this morning.

Two findings got it there, and both were things measurement contradicted.

## 1. Transmission was 17 ms of the frame, not 7

`MeshPhysicalMaterial.transmission` makes three.js render the entire scene into a separate
full-resolution target every frame, and it prices that pass PER FRAME, not per material. The
numbers: 17 transmissive materials -> 1 saved 8.7 ms (40.26 -> 31.60), and that last 1 -> 0 saved
another **9.7 ms** (31.60 -> 21.87). One glass slab holds the whole second scene render open.

That killed the plan of keeping the coffee table transmissive — it could not be scoped to frames
containing the table either, because BABY builds the baby's corneas and DRESS two bottles from the
same `glass.clear`. Everything got an authored substitute instead: a `translucency` thin-sheet
forward-scatter lobe and a `thinGlass` Fresnel-alpha patch, both in `mat/util.js`, costing a few
ALU. `ultra` keeps real transmission, expressed through a single `TRANSMISSION_BUDGET` in
materials.js; re-enabling any material is a one-line edit with its cost written beside it.

The curtains came out better, not worse: the fold structure is crisper where transmission had
smeared it, and the glass table stopped rendering as an opaque milky slab. Frame: 40.26 -> 22.8 ms.

## 2. The adaptive controller was structurally blind to vsync

`src/core/adaptive.js` fed on the frame delta, which is vsync-locked — a healthy 60 fps frame
reads ~16.7 ms however much GPU headroom is spare. Its thresholds were `highWater = budget * 0.94`
(15.7 ms) and `lowWater = budget * 0.68` (11.3 ms), so under vsync the climb branch was
**unreachable** and the drop branch fired on **every frame**. The controller was guaranteed to
walk to its 0.5 floor and stay there, and it did.

Now `highWater = budget * 1.15` (only scale down once we are visibly missing vsync) and
`lowWater = budget * 1.02` (holding the interval IS the evidence of headroom). renderScale went
0.5 -> 1.0 with the frame rate unchanged at 60.

**Note for whoever profiles this next: a vsync-locked frame delta cannot measure GPU headroom.**
If finer control is ever needed, use `EXT_disjoint_timer_query_webgl2`, not the rAF delta.

## What I got wrong, so it is not repeated

Three of my own diagnoses were overturned by instruments in this project. Shadows were NOT the
bottleneck (freezing them cut draw calls 36% but bought 2.4 ms of 40); every JS system combined —
baby, physics, particles, AI, lighting — costs ~2.5 ms; and an earlier "two stops overexposed" was
false (0% clipping). The tell that reframed everything was simple: half resolution gave exactly
double the frame rate, which is the signature of a fill-bound renderer. Reach for
`tools/perfprobe.mjs` early — three cheap runs killed two wrong hypotheses.

## Still open

- `src/world/mat/util.js`: a light-loop shader patch had never applied to any material in this
  project. The agent that found it fixed it; worth a look at what it now changes.
- DRESS builds every monstera blade with `tinted('leaf.monstera', <hex>)`, which replaces the
  recipe colour outright, so the recipe has no albedo lever for those leaves.
- The art review's 135 findings still have a long tail; the material and lighting notes in the
  older sections below are unaddressed.
- Draw calls are 470-880 depending on view. Batching furniture and dressing is the next perf win,
  but there is no longer any urgency: the frame is at 22.8 ms with a 16.7 ms budget met.

---

# Where we left off — 2026-08-03, deployed

**Live: https://operacion-siesta.vercel.app** (built from this tree, verified 200.)

The game works: `tools/smoke.mjs` passes with `"errors": []`, `"warnings": []`, ~56 avg / 43 min
fps, the round is winnable (0 -> 4315 score, 11 props ruined, best combo 11) and the parent stays
`idle` at threat 0.28 for a 20 s run.

## The one real quality problem left, and what it is NOT

The adaptive controller holds 60 fps by pinning `renderScale` at its 0.5 floor, so the frame is
rendered at half resolution and upscaled. That is the main thing still standing between this and
looking AAA on Alan's laptop.

I tested the obvious suspect and it is **not** screen-space reflections. Disabling SSR at the
`high` tier moved `renderScale` not at all (0.501 -> 0.500) and `avgFps` not at all (56.4 -> 55.3),
so the change was reverted — SSR is back on at `high` because it costs nothing measurable and buys
the floor and the glass table their reflections.

That result is the diagnosis: **the renderer is not fill-bound, it is draw-call bound.** Halving
the pixel count bought nothing, which only happens when the cost is CPU or vertex side. The run
reports 694-963 draw calls for ~800k triangles.

The strongest lead, unverified: `src/world/lighting.js` keeps `shadowMap.autoUpdate` alive
whenever anything is moving (`motionTimer`, `setShadowAuto`), and in play the baby is always
moving — so every frame re-renders the full shadow map and roughly doubles the draw calls. The
room is static; only the baby, the parent and the loose props ever need a shadow refresh.

The proper fix is a split shadow setup: one shadow map baked once for the static room, plus a
small tight-frustum dynamic light covering only the characters and awake props. Second-cheapest
option is refreshing the shadow map every other frame while moving. Either should let the
adaptive controller climb off its floor, which is worth far more than any single material fix.

Second lead: batch the room. 963 draw calls is high for one interior — `createBatch` exists in
`src/world/room/geom.js` and is used for the shell, but furniture and dressing are largely
individual meshes.

## Art review

A 27-agent review of round r06 produced 135 attributed findings and a fix wave ran against them.
`tools/compare.mjs` now emits every blind A/B pair twice in opposite order, because the first run
showed the judges picking RIGHT in 14 of 15 pairs against a key that favoured it only 6 times —
position bias, not quality. Count a shot as a real preference only when both orderings name the
same round.

---

# Where we left off — 2026-08-03

Both things Alan reported from playing it are fixed and measured. The round is winnable for the
first time. A full 27-agent art review of r06 has run and produced 135 attributed findings, and
the first fix wave against them is in flight.

## The two Alan reported

**"It runs very slowly on his MacBook."** Two causes, both confirmed by measurement rather than
inspection.

- `detectTier()` handed any 8-core M-series machine `ultra`, and `ultra` capped `pixelRatio` at 2.
  On a Retina panel that is 5.76 Mpx at 1600×900 CSS. A paired profile at that resolution measured
  a **143–220 ms frame — about 5–7 fps**, which is exactly what he saw. Auto-detection now returns
  `high` at most, and never `ultra`; `ultra` is reachable only from Settings or `?quality=ultra`.
- The whole renderer is fill-bound, so the pixel-ratio caps were the wrong shape everywhere. They
  are now low 0.75 · medium 1.0 · high 1.1 · ultra 1.5, all well under a 2× panel.
- On top of that, `src/core/adaptive.js` (new) is a closed loop: it watches the median frame time
  and scales the render resolution to hold 60 fps. Down fast and proportional, up slow and in
  small steps, with a cooldown — asymmetric hysteresis, so the resolution does not visibly breathe.
  It is disabled in photo mode and by `?noadaptive=1`.

Measured at `high`, 1600×900, via `tools/smoke.mjs`: **43.1 avg / 29.4 min fps → 59.5 avg / 56.2
min, with `"errors": []` and `"warnings": []`** — the first completely clean run this project has
had. Note the controller is still sitting near its 0.5 floor, i.e. it is buying that frame rate
with resolution. Getting it to climb is what the outstanding SMAA work is for.

**"On the laptop trackpad he cannot look sideways."** The cause was not subtle once measured:
`onMouseMove` returned early unless pointer lock was engaged, so with no lock there was **no look
at all, on either axis** — and at 0.0023 rad/px even a working lock buys only 26° per 200 px
swipe, which is all the travel a trackpad has. Losing the lock also force-paused the game, so a
browser that quietly refused it looked identical to a broken camera.

Look now has four independent sources, each sufficient on its own, and losing pointer lock no
longer pauses (Escape still does):

| path | verified travel |
|---|---|
| two-finger swipe / wheel, horizontal | 173° |
| two-finger swipe / wheel, vertical | 60° |
| drag-to-look, button held, no lock | 102° |
| arrow keys (they no longer duplicate WASD) | 76° yaw / 66° pitch |

`tools/look.mjs` exercises each path separately and also asserts turn direction and that no look
leaks while paused. It passes. A trackpad is auto-detected (fractional or horizontal wheel delta)
and gets its own stored sensitivity. Related: `input.js` never listened for `input:settings`, so
the sensitivity slider in Settings had been inert; it is wired now.

## Also fixed this round

- **The round was unwinnable.** The baby starts inside the playpen and the only exit is the zip
  door. A pull that had already fired never released while the key was held, so the first thing a
  player grabbed welded them to it — `pulling` stayed truthy, the verb stayed pinned, and nothing
  else could ever be targeted, including the door. `tools/escape.mjs` now drives the whole first
  minute end to end and passes: the door is targeted, opened, and the baby gets out and wrecks
  things. (I first mis-diagnosed this as a prop-registration bug in FURN; it was not — the
  parenting was already correct, and the FURN agent was right to change nothing.)
- **The parent caught you instantly.** There was no grace period at all, and `catching` was
  reachable from any state without passing through `spotted`. Now a 40 s grace (floor 15 s, only a
  real startle shortens it) and `catching` only via `spotted → chasing`. At 25 s: `idle`, threat
  0.17. At 70 s it comes for you, as designed.
- **`bestCombo` was never "always 0".** The combo engine was correct all along; `smoke.mjs` was
  sampling `ctx.state.combo` — the live counter, which decays — once at the end of the run. It now
  reads the published round peak, and reports 11. Two other smoke metrics were measuring the wrong
  thing the same way and are fixed: "moved" was net displacement (a baby crawling in circles
  inside the playpen scored 0) and is now cumulative path length, and yaw travel was the net
  difference between first and last sample (near zero, because the drive script sweeps the look
  back and forth) and is now cumulative, reporting 14.03 rad. **Both of those were reporting real
  features as broken.** Be suspicious of this harness before believing it about the game.
- **Score was 415/160 before the player moved.** `resetRound()` skipped its physics reset on the
  first round only, so boot-settle motion scored as player topples — and flagged those props
  ruined, which quietly removed them from the round. Reset is now unconditional and authoritative,
  plus a settle-grace window. `scoreBefore` is 0. `ctx.state.bestCombo` now published.
- **i18n**: 9 keys were missing in *both* languages (`furniture.js` defaults `labelKey` to
  `prop.<id>`, and 8 of its 12 registrations relied on that with kebab-case ids that never matched
  the camelCase keys). `tools/i18n-check.mjs` is new and exits non-zero on any referenced-but-
  missing or one-language-only key — 262 keys, currently clean. 77 defined-but-unreferenced keys
  are reported as warnings; the `prop.coffeeTable`-vs-`prop.coffee-table` family is a rename smell
  worth a look.
- **Discoverability**: a `tut.escape` hint for the playpen door, and the controls panel now shows
  the drag/swipe/arrow look bindings instead of just "MOUSE".
- **The GL feedback loop** — RENDER traced it and added an explicit depth-copy target so the AO,
  SSR and grade passes no longer sample the depth attachment they are writing into.
- **Three shot framings were reviewing the wrong object**: `floor`'s camera stood inside the
  playpen so the frame contained no floor, `radiator`'s stood inside the armchair, and
  `babyFace`'s sat on the skin of the pouf with only the baby's crown visible. All three moved,
  each with a comment saying why, since it breaks r06 comparability for those shots.

## The art review — r06

27 framings, one dedicated critic each, judged against shipped AAA interiors per `REVIEW.md`.
**All 27 came back NOT_AAA.** Mean scores /10:

| believability | lighting | materials | grade | composition | detail | silhouette |
|---|---|---|---|---|---|---|
| 2.30 | 2.67 | 2.89 | 3.00 | 3.15 | 3.15 | 3.85 |

135 findings, 67 of them blockers, attributed by module: **MAT 35 (17 blockers) · LIGHT 26 (19) ·
RENDER 22 (10) · DRESS 19 (6) · FURN 18 (8) · ROOM 6 (3) · BABY 5 (3) · AI 3 (1) · FX 1.**

Everything is on disk and survives this session:
- `shots/r06/_review.json` — the whole structured result, `fixesByModule`, and every
  `brokenOrMissing` bug report.
- `shots/r06/_fixes-LIGHT.md`, `shots/r06/_fixes-MAT.md` — per-module briefs, blockers first.

**MAT has landed.** Highlights, all measured rather than asserted: the ceiling albedo is genuinely
fixed — a clean-ceiling region crop went from **r−b +52.9 to +5.7**, now reading cooler than the
plaster wall in the same frame. Velvet, bouclé, rug and plush had their *frequency* rewritten
rather than their amplitude cranked (bouclé loops 17→26 per tile at 3.3 mm, velvet fibre tightened
2–3×). `fabric.sheer` and `fabric.mesh` now carry transparency with real alpha instead of
`alphaTest`, so the brick reads through the curtains and the rug reads through the playpen netting.
`metal.blackAnodised`, `glass.clear` and `skin.baby` were re-authored as physically sane. MAT also
caught its *own* mis-implementation of the velvet fix by unit-testing `latticeFor` against the
formula — it had made the nap 20–60× coarser — and corrected it before reporting.

Two things MAT left for others: rattan colour/scale and the sofa UV-tiling-authority fight are in
`src/world/furniture/*` (FURN's), and `cloth.parent` needs either a new canonical name or AI
calling `tinted()`.

**LIGHT has landed.** Preserved and measuring well: `sun.shadow.normalBias` 0.014 → 0.0035 with
`bias` -0.00012 → -0.00028 and a per-axis shadow frustum (~1.9× tighter vertically, free) — this
restored contact shadows across the entire game, which were being deleted wholesale; the `sky.js`
warm-brown floor-probe fix that was making all shadows saddle-brown; the pendant at ~30 cd; a
hallway fill that made the parent's face legible; and god-ray occlusion **reusing the sun's
existing shadow map, at zero extra passes**. Luminance histograms confirm the contrast work
survived every subsequent correction.

### The warmth regression, and two refuted diagnoses — read this before touching lighting

A whole-frame warmth regression appeared. It took three passes and refuted **both** proposed causes,
so record the eliminations rather than re-running them:

- **Refuted #1 (LIGHT's):** "boosting the sun +15–35% multiplied against the room's warm albedo."
  Reverting the sun boost moved `hero` 1.516 → 1.527. Wrong direction, inside noise.
- **Refuted #2 (mine):** "the ambient cut removed the room's *cool* sources (window R:B 0.92,
  hemisphere, sky probe) while leaving sun 1.19 and bounce 1.73, so contrast improved by deleting
  cool light." Sounded airtight. LIGHT tested it the right way — analytically, before touching
  code — by summing intensity × colour per source from `evaluate()` at hero's frozen photo time.
  **Aggregate light-budget R:B: ≈1.07 before, ≈1.06 after.** The lighting never warmed. LIGHT then
  spent a further pass pushing every source cooler and moved `hero` only 1.527 → 1.496, correctly
  reporting that it cannot go further without contradicting REFERENCE's cool-key/warm-bounce brief.

**The actual cause is `fabric.boucle`**, and the attribution is tight. Light budget unchanged
(measured), grade unchanged (RENDER made no colour edits this session), and:

| frame | dominant material | r06 | now | delta |
|---|---|---|---|---|
| `sofa` | velvet | 1.196 | 1.194 | — |
| `ceiling` | concrete | 1.261 | 1.264 | — |
| `ottoman` | **bouclé** | 1.555 | **1.724** | +0.17 |
| `armchair` | **bouclé** | 1.144 | **1.255** | +0.11 |
| `hero` | whole room, 3 bouclé objects | 1.326 | **1.496** ⚠ | +0.17 |

Every bouclé-dominated frame moved; the velvet and concrete controls did not budge. LIGHT reached
the same conclusion independently from the other side ("`ottoman` stayed saturated-orange
regardless of my lighting cuts"). Prime suspect is a warm sheen term now multiplied over far more
loop geometry after `loopsPerTile` went 17 → 26 — which would also explain why it is worst on low
objects seen from a crawling camera. **A MAT agent is on it, with `sofa` as a mandatory control and
instructions not to fix it by flattening the loop structure. In flight.**

### The blind A/B was measuring position, not quality — do not trust the old result

The 15 r01-vs-r06 pairs completed, and decoded against the answer key they come out r01 7 · r06 6 ·
equivalent 2. That reads as "six rounds of work changed nothing". **It is not a real result.**

**Judges chose RIGHT in 14 of the 15 pairs**, against a key that had r06 on the right in only 6 of
them. Under a fair coin that is p ≈ 0.001. The composite is geometrically symmetric — two equal
flex panels, identical borders, labels below each — so this is not a layout artefact; it is the
judge favouring the last frame it was shown. Every A/B number this project has produced so far,
including anything the previous session concluded from one, is confounded.

Fixed for the next round, in both files:
- `tools/compare.mjs` now emits every pair twice, `<shot>.png` and `<shot>.rev.png`, same two
  frames in opposite order, and records both in the answer key.
- `tools/wf-review.js` judges both with independent agents and folds them: a pair counts as a real
  preference only when the two judgements pick **opposite sides** (i.e. agree on a frame). Two
  judgements picking the *same side* are position bias and are reported as `discardedForPositionBias`
  rather than averaged in. It pairs by index, not by the agent-returned `shot` string — the
  critique agents in this same workflow routinely return a paragraph in that field.

Raw judgements are kept at `shots/r06/_ab.json` so the bias is auditable. **Regenerate the
composites with the new `compare.mjs` before the next A/B; the existing ones have no reversed
half.**

### The diagnosis, in one line each

- **LIGHT** — there is no key/fill structure; the room is a constant ambient wash, which is the
  "unlit CAD model" failure CONTRACTS §8 names explicitly. The colour-temperature split is
  inverted (shadows go saddle-brown instead of cool, traced to a dark warm-brown floor card
  dominating the low hemisphere in `sky.js`). And `sun.shadow.normalBias = 0.014` is wider than
  the window mullion flanges and a full radius of the rattan leg tubes, so **it is deleting every
  contact shadow in the game** — the baby is not grounded on the rug, the ottoman floats, pots
  have no darkening beneath them.
- **MAT** — no micro-detail at the height this game is actually played at (0.42 m). The velvet
  reads as moulded plastic, the bouclé has no loops, the rug reads as burlap. The concrete
  ceiling, which REFERENCE calls the most characterful surface in the room, measures r−b +33 to
  +59: it is sepia barn wood where it should be chalky and slightly cool. `fabric.sheer` and
  `fabric.mesh` are both fully opaque, which kills the curtains and the playpen netting.
  `metal.blackAnodised`, `glass.clear`, `skin.baby` and the two emissives are physically wrong.
- **RENDER** — bloom is authored as if its input were display-referred but runs before ACES on a
  scene-referred buffer, so it fires on mid-cream diffuse and there is no true black anywhere in
  any frame. The N8AO radius is 0.55 m, a room-scale kernel that cannot register contact at
  furniture scale; several reviewers independently asked for a second short-range AO term.

## Still open

1. **Post-process antialiasing costs ~21 ms of a ~40 ms frame on this driver, and swapping the
   algorithm does not help.** This is a settled negative result, not an open guess.
   - RENDER's tier pass landed (`high` AO to `halfRes`, `transparencyAware` to `ultra` only, SMAA
     preset `HIGH → MEDIUM`) and moved the baseline 41.00 → 40.60 ms — inside the noise. Disabling
     SMAA outright still saves **21.5 ms**, and dropping the preset barely moved it (23.3 → 21.5),
     so the cost is not in the sample counts.
   - Zeroing SMAA's blend while leaving the pass running saved only ~1.4 ms, which looked like a
     clean "it's the render-target switches, not the maths" verdict. So RENDER merged `FXAAEffect`
     — no sub-passes, no extra targets — into the existing grade draw. **`no-grade` then jumped
     from ~4.3 ms to ~30.0 ms.** FXAA inline, with none of the topology overhead, cost more than
     SMAA's whole three-pass chain. That refutes the topology hypothesis outright.
   - Conclusion: the cost tracks the **edge search itself** — texture reads whose UV depends on the
     result of the previous read, which defeat prefetch on a tile-based GPU (what ANGLE-Metal sits
     on). It is a property of the technique class, so no post-AA algorithm dodges it. The FXAA
     merge was reverted because it measured worse.
   - **MSAA was then tested and came back within noise of SMAA.** Two clean back-to-back smoke
     runs: MSAA 55.7 avg fps / 533 draws, SMAA 56.1 / 831 draws, same render scale. Draw calls
     fell by exactly SMAA's two removed sub-passes; wall-clock did not move. So the old comment
     ("MSAA on a HalfFloat target is not worth the bandwidth") was wrong in its *reasoning* — this
     is a tile-based GPU, MSAA resolves in tile memory — but right in its *conclusion*, by
     accident. SMAA is kept for the better edge quality at the same price. **Both comments
     (`postfx.js` and `engine.js:13`) have been rewritten to say that instead.**
   - Along the way RENDER found a bug in my own `tools/perf.mjs`: its `no-SMAA` scenario restores
     `enabled = true` unconditionally, so testing an alternative AA by merely *disabling* the SMAA
     pass silently stacks SMAA back on for every later scenario in the run. Only matters if you
     swap the AA out again — but if you do, null the pass rather than disabling it.
   - **Bottom line: antialiasing costs ~20 ms on this driver and no available option avoids it.**
     Stop looking for a cheaper AA. The remaining levers are resolution (what `adaptive.js`
     already does) or shipping without post-AA below `high`.
   - Note the "~90 ms of a 143 ms frame" AO figure I originally briefed is historical: it was
     measured when `high` capped `pixelRatio` at 1.75 (≈4410 kpx at DPR 2). At the current cap of
     1.1 the frame is ≈1742 kpx and AO costs ~10 ms. RENDER caught the discrepancy rather than
     reporting against a baseline it could tell was stale.
   - **Re-measure with `tools/perf.mjs --quality high --pr 2 --reps 3` once the GPU is free.**
     Every harness now runs its dev server with `hmr: false, watch: null`, because concurrent
     agents saving files were reloading pages mid-measurement and producing nonsense. `perf.mjs`
     also has an `SMAA blend zeroed` control scenario for exactly this question.
   - Until this is resolved, `adaptive.js` holds 60 fps by sitting near its 0.5 resolution floor,
     which is a real visual cost.

   **The GL feedback loop is genuinely fixed**, and the cause was not on anyone's suspect list:
   `SMAAEffect` declares `EffectAttribute.DEPTH` unconditionally, for every edge-detection mode,
   not just depth mode — so the composer built its own depth blit machinery even though nothing
   needed it. Every depth-consuming pass now has its depth texture pre-armed before `addPass()`,
   fed from a `DepthTexture` we own on `composer.inputBuffer` and copied into a private target by
   a `LambdaPass` writing `gl_FragDepth` (never `blitFramebuffer`). Smoke run: zero warnings, zero
   errors, 58.2 avg / 51.4 min fps.
2. **Draw calls: 841, triangles 914k.** Untested as a bottleneck. Worth a batching pass only
   after the fill-rate work, and only if measured.
3. **The rest of the review wave** — DRESS (19), FURN (18), ROOM (6), BABY (5). BABY's three
   blockers are worth reading first: reviewers report the baby's head rendering as a lightbulb and
   a hard-edged skin-coloured cone protruding from it.
4. **The blind A/B phase** of the review workflow (15 r01-vs-r06 pairs) had judged 2 of 15 when I
   last looked. Resume with
   `Workflow({scriptPath: "tools/wf-review.js", resumeFromRunId: "wf_4b610850-738"})` — completed
   agents return cached results.
5. **Shoot a fresh round r07 and re-review** once LIGHT and MAT land. Note `floor`, `radiator` and
   `babyFace` are not comparable to r06 any more.

## Tooling

| Tool | What it does |
|---|---|
| `tools/shoot.mjs` | Renders the 27 scripted framings via headed Chromium on the real GPU. ~40–60 s per shot, deterministic. |
| `tools/histogram.mjs` | Luminance percentiles, % clipped/crushed and R:B warmth from a PNG. Settles look arguments with numbers; has already overturned one confident wrong diagnosis. |
| `tools/compare.mjs` | Blind side-by-side A/B composites, order randomised per shot, answer key written separately. |
| `tools/smoke.mjs` | Boots the real game, plays a round with synthetic input, reports path length, yaw travel, score, props ruined, parent state, fps, draw calls, render scale, console errors. |
| `tools/escape.mjs` | **New.** The first minute end to end: out of the playpen through the zip door, then wreck something. This is the "is the game winnable" test. |
| `tools/look.mjs` | **New.** One check per look input path — wheel, drag, arrows — reporting degrees travelled, plus turn direction and paused-leak. |
| `tools/perf.mjs` | **New.** Paired per-pass cost attribution. Toggles one thing at a time inside a single page load and re-measures a baseline between each, because measuring across reloads gave ±5 ms of noise and the wrong ranking. `--pr 2` simulates a Retina panel. |
| `tools/i18n-check.mjs` | **New.** Static key diff over `src/`; non-zero on missing or one-language-only keys. |
| `tools/probe.mjs` | Interrogates the live scene — positions, prop counts, mesh hierarchies. |

URL params: `?shot=<name>` photo mode · `?free=1` orbit camera · `?debug=phys` colliders ·
`?stats=1` · `?quality=ultra` · `?lang=es` · `?nohud=1` · **`?noadaptive=1`** pins the resolution.
