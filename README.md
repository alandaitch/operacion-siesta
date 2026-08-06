# OPERATION NAPTIME · OPERACIÓN SIESTA

**[Play it → operacion-siesta.vercel.app](https://operacion-siesta.vercel.app)**

You are a ten-month-old baby. You have just escaped the playpen in the middle of a real living
room in Buenos Aires. You have about three minutes before someone walks in from the hallway, and
there are eighty-two things in here you are not supposed to touch.

First person by default, third person on `V`. English and rioplatense Spanish.

![The living room](docs/frames/hero.png)

---

## The brief

It started with one photograph of an apartment and a request: build a AAA-quality 3D game in
Three.js where a baby crawls around *that* room knocking things over and eating what it finds,
before it gets caught. Make it visually impressive down to the textures and the physics.
Distribute the work across subagents, give every element its own reviewer, and loop until it holds
up against real AAA games.

## The constraint

**Nothing in this repository is an asset.** No textures, no meshes, no HDRIs, no fonts, no audio
files. Every surface in that photograph — the board-formed concrete ceiling with its damp
staining, the bouclé with its overlapping wool loops, the crumpled foil of a crisp packet, the
fenestrated monstera leaf — is generated in code from noise functions at load time. So is the
baby, all 129,662 vertices of it, from an SDF mesher. So is every sound, synthesised in Web Audio:
the ceramic vase shattering is a modal resonator bank, the baby's voice is a formant model.

Six dependencies total: `three`, `@dimforge/rapier3d-compat`, `postprocessing`, `n8ao`, plus
`vite` and `playwright` for tooling.

## How it was built

Seventy-one subagents wrote this across seven workflows, working in parallel on files they each
owned exclusively. That only works with a contract, so three documents came first:

- **[CONTRACTS.md](CONTRACTS.md)** — module ownership, the frozen materials and physics APIs, the
  quality tiers, the prop registry and its events, the canonical room layout with every dimension.
  Without it, fourteen parallel agents write fourteen different games.
- **[REFERENCE.md](REFERENCE.md)** — the photograph translated into prose, surface by surface,
  because the subagents could not see the image. It reads like a location report.
- **[REVIEW.md](REVIEW.md)** — the standard the art reviewers judge against, written to make a
  generous review the failure mode it actually is.

Then five harnesses, because an agent that cannot see its own work is guessing:

| Tool | What it does |
|---|---|
| `tools/shoot.mjs` | Renders 27 scripted camera framings — one per element — through headed Chromium on the real GPU. Deterministic: photo mode freezes the world so rounds are diffable. |
| `tools/histogram.mjs` | Decodes a PNG with `zlib` and no dependencies, reporting luminance percentiles, clipping, and the red-to-blue ratio that catches a colour cast. |
| `tools/smoke.mjs` | Boots the real game, starts a round, drives it with synthetic input, and reports distance crawled, score, props destroyed, AI state, frame rate and console errors. |
| `tools/perfprobe.mjs` | Toggles one suspect at a time at runtime and re-measures. Settles performance arguments in about ninety seconds. |
| `tools/compare.mjs` | Builds blind side-by-side A/B composites from two rounds, order randomised, answer key written where the judges never see it. |

## What measurement did to intuition

This is the part worth reading. Three confident diagnoses were overturned by instruments built
along the way, and the fixes that mattered came from the corrections.

**"It's two stops overexposed."** Looking at a blown-out cream sofa, that seemed obvious. The
histogram said **zero percent of pixels were clipped** anywhere in the frame. A workflow acting on
the wrong diagnosis was already running and had to be killed. Sorting all 27 framings by red-to-blue
ratio then showed the real bug in one line: shots near the window measured 1.15, shots at the back
of the room 1.6, the hallway 2.35. The cool key light was fine; the *ambient* term was orange, and
it dominated wherever the key did not reach.

**"It's draw-call bound, and the shadow map is the cause."** Freezing shadows did cut draw calls by
36% — and bought 2.4 ms out of 40. Disabling every JS system in the game — baby, physics,
particles, AI, lighting — bought another 2.5 ms. So 88% of the frame was in none of the suspects.
The tell had been visible the whole time: half resolution gave exactly double the frame rate, the
signature of a fill-bound renderer. The real cost was `MeshPhysicalMaterial.transmission`, which
makes three.js re-render the entire scene into a separate full-resolution target every frame, and
prices it **per frame, not per material**: seventeen transmissive materials down to one saved
8.7 ms, and that last one down to zero saved another **9.7 ms**.

**"The baby's locomotion is broken — it moves 0.89 m in 25 seconds."** Two harness bugs, not game
bugs. Movement was measured as net displacement, so a baby crawling in circles scored zero; and the
harness looked around with `mouse.move()`, which produces no camera motion at all without pointer
lock, so the character genuinely could not steer itself. The instrument was reporting working
features as broken.

**The blind A/B judges had a position bias.** The first comparison round came back with judges
preferring the right-hand image in 14 of 15 pairs, against a key that had put the newer round on
the right only 6 times — p ≈ 0.001 under a fair coin. The instrument was measuring position, not
quality. Every pair is now rendered twice in opposite order, and a preference counts only when both
orderings name the same round.

**And the bug that was hiding in plain sight.** The adaptive resolution controller fed on the frame
delta, which is vsync-locked: a healthy 60 fps frame reads 16.7 ms however much GPU headroom is
spare. Its thresholds asked it to scale down above 15.7 ms and up below 11.3 ms. Under vsync, 11.3
is unreachable and 15.7 is exceeded by every frame — the climb branch could never fire and the drop
branch always did. The controller was mathematically guaranteed to walk to its floor and stay
there, and it did. Render scale went from 0.5 to 1.0 the moment the thresholds were expressed as
multiples of the vsync interval instead.

From 5–7 fps on the author's laptop to **60.1 average / 59.9 minimum at full resolution**.

## Numbers

| | |
|---|---:|
| Source files / lines | 111 / 47,219 |
| Tooling / documentation | 1,578 / 998 lines |
| Procedural texture generators | 96 |
| Material recipes | 61 |
| Interactive props | 82 (49 knockable · 14 edible · 12 pullable) |
| Scripted review framings | 27 |
| Frames rendered during development | 328, across 60 rounds |
| Subagents | 71, in 7 workflows |
| Frame time | 40.26 ms → 22.8 ms |
| Bundle | 3.9 MB |

## Running it

```bash
npm install && npm run dev
```

Useful URL parameters: `?free=1` free-fly camera · `?debug=phys` collider wireframes ·
`?shot=<name>` photo mode · `?stats=1` · `?quality=ultra` · `?lang=es`

```bash
node tools/smoke.mjs --seconds 20     # does it work?
node tools/shoot.mjs --round rNN      # does it look right?
node tools/perfprobe.mjs              # where is the frame going?
```

## Still open

[RESUME.md](RESUME.md) carries the live state. The short version: the art review's 135 findings
have a long tail, draw calls could come down with batching, and the baby's skin still reads more
like plastic than skin.

## The whole conversation

**[Read it as it happened →](https://operacion-siesta.vercel.app/transcript.html)** — the full
session rendered the way it looked in the terminal, tool calls and all. Every wrong turn above is
in there, in the order it happened. Generated by `tools/transcript-html.mjs` straight from the
session log, with a redaction pass over tool output (the first command in the session was a recon
`ls` of the parent directory, which is nobody's business).

[docs/TRANSCRIPT.md](docs/TRANSCRIPT.md) is the same thing as plain markdown.

---

Built with [Claude Code](https://claude.com/claude-code).
