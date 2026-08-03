# OPERATION NAPTIME — Engineering Contracts

**Read this file completely before writing a single line.** Every module in this game is
authored by a different agent working in parallel. These contracts are the only thing keeping
the build coherent. Violating them breaks everyone else.

---

## 0. The pitch

A photoreal 3D game. You are a **10-month-old baby** who has just escaped the playpen in the
middle of a real Buenos Aires living room (modeled from a reference photograph). You crawl
around in **first person** (default) or **third person** (toggle `V`), and your job is to
**destroy as much as possible** — knock over the vase, pull books off the shelves, tip the
speaker, drag the plant, yank the laptop off the sofa — and **eat things you absolutely should
not eat** — before **Mamá/Papá** walks in from the hallway and picks you up. Game over is being
lifted into the air by two enormous hands.

Tone: a cinematic AAA stealth-sandbox played entirely at knee height. Think *Hitman* commotion
systems, *Untitled Goose Game* mischief, *Half-Life: Alyx* interior fidelity.

Target: **60 fps at 1080p on an M-series Mac in Chrome.** Never ship a frame that costs more
than it is worth.

---

## 1. Hard rules (non-negotiable)

1. **You own only the files assigned to you.** Never edit another module's file, never edit
   `src/main.js`, `index.html`, `CONTRACTS.md`, `src/core/*` unless they are explicitly yours.
   If you need something from another module, use the interfaces below or the event bus.
2. **ES modules only.** `import * as THREE from 'three'`. No globals, no `window.*` writes
   except the debug hooks listed in §7.
3. **No network at runtime.** No CDN, no fetch, no external textures, no external fonts, no
   `.glb`/`.hdr` files. **Every texture and every mesh in this game is generated procedurally in
   code.** This is a hard constraint and also the aesthetic thesis: we prove a photoreal room
   can be authored entirely in maths.
4. **No `Math.random()` at module scope or during construction.** Use the seeded RNG from
   `src/core/rng.js` (`import { rng, makeRng } from '../core/rng.js'`) so the room is identical
   every run and screenshots are stable and diffable. Runtime particles/gameplay may use
   `rng()` too — just never bare `Math.random()`.
5. **Everything you add to the scene must respect the quality tiers** (§5). If your effect is
   expensive, gate it.
6. **Dispose properly.** Anything you create, you can destroy. Meshes/geometries/materials get
   registered via `ctx.track(obj)` so teardown is automatic.
7. **All user-visible text goes through i18n.** Never hardcode an English or Spanish string in
   game code. Add the key to `src/i18n/strings.js` (owner: UI agent) or emit an event with a
   key, never a sentence.
8. **Units are metres, seconds, radians.** Y is up. Gravity is -9.81.
9. **Never break the build.** Run `npm run build` before you report done. A module that throws
   at import time takes the whole game down.

---

## 2. The room — canonical layout

This is the single source of truth for geometry. All modules must agree on it. It is exported
as data from `src/world/layout.js` (owner: Room agent) — read it, do not re-derive it.

Origin `(0,0,0)` is the centre of the floor. **+X is right** (toward the sofa wall), **+Z is
toward the camera/entrance** (away from the window), **+Y is up**.

```
                        WINDOW WALL  z = -4.60
   x=-3.40 ┌──────────────────────────────────────────────┐ x=+3.40
           │  radiator      [glazing, black frames]  plant│
   S       │  ▒▒▒▒▒▒        ░░░░░░░░░░░░░░░░░░░░░░░   lamp│  S
   H       │              armchair   coffee                │  O
   E       │      ottoman      table(glass)   pouf        │  F
   L       │                                              │  A
   V       │            [ cream area rug ]                │  (L-shape,
   I       │                                              │   right wall)
   N       │                                              │
   G       │        ┌────────────────────────┐            │
           │        │      P L A Y P E N     │            │
           │        │   (baby starts here)   │            │
           │        └────────────────────────┘            │
           │  espresso                            rattan  │
           └──────────────────────────────────────────────┘
                     ENTRANCE / HALLWAY  z = +3.40
```

| Element | Position (x, y, z) | Size (w, h, d) | Notes |
|---|---|---|---|
| Floor | 0, 0, -0.6 | 6.80 × — × 8.00 | warm micro-cement / wide plank, x∈[-3.4,3.4] z∈[-4.6,3.4] |
| Ceiling | 0, 2.78, -0.6 | same | **board-formed raw concrete**, mottled dark stains, formwork lines every 0.30 m running along X |
| Downstand beam | 0, 2.62, -3.05 | 6.80 × 0.32 × 0.42 | the ceiling steps down toward the window |
| Left wall (shelf wall) | -3.40 | h 2.78 | plain white painted plaster, slightly warm |
| Right wall | +3.40 | h 2.78 | white; sofa sits against it |
| Back wall (entrance) | z = +3.40 | h 2.78 | white; doorway opening at x∈[1.4,2.4], h 2.10 → hallway (parent enters here) |
| Window wall | z = -4.60 | | full-height black-framed glazing x∈[-1.60, 3.40], sill 0.06, head 2.50; mullions every 1.05 m; beyond it a balcony with planters, bare winter trees, a red-brick building |
| Sheer curtains | z = -4.48 | h 2.42 | 3 panels: gathered at x≈-1.5, open x∈[0.3,1.4], gathered at x≈3.2. Must have real folds + subsurface translucency |
| Shelving unit | x -3.22, z ∈ [-3.20, 1.20] | d 0.36, staggered h 0.42 / 0.60 / 0.78 | birch plywood open cubes, exposed ply edges. Filled with books, vinyl, 2 black bookshelf speakers, white ridged vase, mug, magazines |
| Framed artwork | -3.30, 1.05, 0.85 | 0.90 × 1.15 | abstract: yellow triangle + magenta/violet blob on off-white, thin pale wood frame, leaning back 4° |
| Espresso machine | -3.15, 0.72, 2.25 | 0.30 × 0.38 × 0.42 | matte black + chrome portafilter |
| Area rug | 0.90, 0.008, -1.80 | 4.60 × — × 4.00 | cream wool, short pile, visible weave + fringe |
| Sofa (L-sectional) | 2.55, —, -0.50 | 1.60 × 0.72 × 4.20 + chaise 2.00 × 0.42 × 1.30 toward -x at z≈1.30 | cream velvet/chenille, deep seats, 2 navy ribbed cushions, **a dark laptop resting on the seat at (2.30, 0.46, 0.60)** |
| Bouclé armchair | -0.35, —, -3.45 | 0.78 × 0.74 × 0.80 | rounded chunky bouclé, rotated +24° |
| Bouclé ottoman | -1.45, —, -2.05 | 1.15 × 0.42 × 0.85 | big rounded rectangle |
| Cylinder pouf | 0.95, —, -1.35 | r 0.33, h 0.42 | bouclé |
| Glass coffee table | 0.95, —, -2.35 | 1.10 × 0.36 × 0.55 | 12 mm low-iron glass slab + two glass legs, waterfall. Needs real refraction/reflection |
| Round side table | 1.70, —, -3.25 | r 0.22, h 0.50 | white marble top, slim chrome stem |
| Playpen | 0.00, —, 2.00 | 2.80 × 0.62 × 2.60 | beige padded tube frame, white mesh panels (translucent), zip door on the -z face, padded play mat inside |
| Play-gym arch | 0.15, —, 1.70 | 0.75 span | fabric arch, hanging elephant + rings |
| Toy pile | 0.30, —, 1.85 | — | ~14 plushies, a wooden ukulele, a red box, a board book, teether rings |
| Monstera | 1.60, —, -4.15 | h 1.35 | ceramic pot, 9 fenestrated leaves |
| Second plant | 2.35, —, -4.25 | h 0.85 | |
| Floor lamp | 2.95, —, -4.10 | h 1.55 | cream mushroom dome shade, emissive |
| Pendant bulb | 0.30, 1.62, -1.20 | — | bare E27 on a black cord from the slab — **swingable, a physics pendulum** |
| Rattan chair | 3.00, —, 3.05 | 0.55 | cane/rattan, bottom-right of the reference photo |
| Radiator | -1.20 … -0.20, 0.32, -4.52 | | white steel column radiator under the glazing |
| Snack bag | 1.35, 0.02, -0.55 | | orange foil crisp bag on the rug — **edible** |

**Camera / baby scale.** Crawling eye height **0.42 m**. Head radius 0.115 m. Body capsule
radius 0.16, half-height 0.13. This scale is what sells the fantasy: the sofa is a *cliff*, the
coffee table is a *bridge*. Everything must read as oversized from down there.

---

## 3. Module map & ownership

| File | Owner | Exports |
|---|---|---|
| `src/core/engine.js` | **RENDER** | `createEngine(canvas, quality) → engine` |
| `src/core/postfx.js` | **RENDER** | `createPostFX(engine, quality) → { composer, update, resize, setDoF, impact }` |
| `src/world/layout.js` | **ROOM** | `LAYOUT` (frozen data object, §2) |
| `src/world/room.js` | **ROOM** | `buildRoom(ctx) → { group, colliders[], props[] }` |
| `src/world/furniture.js` | **FURN** | `buildFurniture(ctx) → { group, colliders[], props[] }` |
| `src/world/dressing.js` | **DRESS** | `buildDressing(ctx) → { group, props[] }` (books, toys, vase, plants, clutter) |
| `src/world/materials.js` | **MAT** | `createMaterialLibrary(ctx) → materials` |
| `src/world/textures.js` | **MAT** | procedural texture generators |
| `src/world/lighting.js` | **LIGHT** | `createLighting(ctx) → { update, sun, env, setTimeOfDay }` |
| `src/physics/physics.js` | **PHYS** | `createPhysics(ctx) → physics` |
| `src/player/baby.js` | **BABY** | `createBaby(ctx) → baby` |
| `src/player/camera.js` | **BABY** | `createCameraRig(ctx, baby) → rig` |
| `src/player/input.js` | **BABY** | `createInput(ctx) → input` |
| `src/gameplay/rules.js` | **GAME** | `createRules(ctx) → rules` |
| `src/gameplay/interactions.js` | **GAME** | `createInteractions(ctx) → interactions` |
| `src/ai/parent.js` | **AI** | `createParent(ctx) → parent` |
| `src/audio/audio.js` | **AUDIO** | `createAudio(ctx) → audio` |
| `src/fx/particles.js` | **FX** | `createFX(ctx) → fx` |
| `src/ui/hud.js` | **UI** | `createHUD(ctx) → hud` |
| `src/ui/menus.js` | **UI** | `createMenus(ctx) → menus` |
| `src/i18n/strings.js` | **UI** | `STRINGS`, `createI18n(lang) → i18n` |

Files owned by the **integrator (main agent), do not touch**: `src/main.js`, `index.html`,
`src/core/eventbus.js`, `src/core/rng.js`, `src/core/quality.js`, `src/core/shots.js`,
`src/core/context.js`, `vite.config.js`, `tools/*`.

---

## 4. The context object (`ctx`)

Every factory receives exactly one argument, `ctx`:

```js
ctx = {
  THREE,                     // the three namespace
  scene,                     // THREE.Scene
  camera,                    // THREE.PerspectiveCamera (the live one)
  renderer,                  // THREE.WebGLRenderer
  engine,                    // from createEngine
  quality,                   // see §5
  rng(),  makeRng(seed),     // seeded randoms
  events,                    // EventBus: on(name,fn) off(name,fn) emit(name,payload)
  track(disposable),         // register for teardown; returns the same object
  materials,                 // MaterialLibrary (null while MAT itself is building)
  physics,                   // PhysicsWorld (null during early boot)
  audio,                     // AudioBus
  i18n,                      // { t(key, vars), lang, setLang(l) }
  fx,                        // FX system
  props,                     // PropRegistry, see §6
  layout,                    // LAYOUT data
  state,                     // live game state (read-only for most modules)
  dt,                        // last frame delta (clamped 0..0.05)
  elapsed,                   // seconds since round start
  debug,                     // { enabled, gui? }
}
```

Modules return an object that may implement any of:
`update(dt, ctx)`, `fixedUpdate(dt, ctx)`, `lateUpdate(dt, ctx)`, `resize(w, h)`,
`reset()`, `dispose()`. `main.js` calls whichever exist, in the module order above.

---

## 5. Quality tiers

`ctx.quality` is `{ tier, shadowMapSize, aoQuality, ssr, dof, motionBlur, volumetrics,
particleBudget, anisotropy, textureSize, pixelRatio, softShadows }`.

Tiers: `'low' | 'medium' | 'high' | 'ultra'` (default `high`, auto-detected then user
overridable in Settings). Rules:

- **ultra**: 2048 shadows, GTAO high, SSR on, DoF on, volumetric god rays on, 2048px textures,
  pixelRatio ≤ 2, particle budget 4000.
- **high**: 2048 shadows, GTAO medium, SSR on, DoF on, light shafts on, 1024px textures,
  pixelRatio ≤ 1.75, budget 2000.
- **medium**: 1024 shadows, AO low, no SSR, DoF off, 512px textures, pixelRatio ≤ 1.25, 800.
- **low**: 512 shadows, no AO, no SSR, 256px textures, pixelRatio 1, 300.

Always read the tier; never assume ultra. If your feature is off, it must cost **zero** — no
hidden render targets, no orphan update loops.

---

## 6. Props: the destruction registry

Anything the baby can interact with is a **prop**, registered by its author with
`ctx.props.register(spec)`:

```js
ctx.props.register({
  id: 'vase',                 // unique, kebab-case
  object3d: mesh,             // the visual
  body: rigidBodyOrNull,      // rapier RigidBody, or null for static-only
  kind: 'knockable',          // 'knockable' | 'edible' | 'pullable' | 'scenery' | 'hazard'
  labelKey: 'prop.vase',      // i18n key, e.g. "Ceramic vase" / "Jarrón de cerámica"
  points: 250,                // chaos points when successfully toppled/eaten
  noise: 0.85,                // 0..1 how loud the destruction is (drives parent AI)
  mass: 1.2,                  // kg
  fragile: true,              // shatters into shards instead of tumbling
  edibleTime: 1.4,            // seconds of holding to eat (kind:'edible' only)
  reaction: 'gross',          // 'yum' | 'gross' | 'spicy' | 'dangerous' (edible only)
  onTopple(prop, ctx) {},     // optional custom behaviour
});
```

The registry emits, and everyone may listen:

| Event | Payload | Meaning |
|---|---|---|
| `prop:toppled` | `{ prop, impulse, position }` | a knockable went down for the first time |
| `prop:shattered` | `{ prop, position, shards }` | a fragile prop broke |
| `prop:eaten` | `{ prop, reaction }` | baby ate something |
| `prop:pulled` | `{ prop, position }` | something was dragged/yanked |
| `noise` | `{ position, loudness, source }` | **anything loud. The parent AI listens to this.** |
| `score` | `{ delta, total, combo, reasonKey }` | |
| `combo` | `{ count, multiplier }` | |
| `parent:state` | `{ from, to }` | `idle→suspicious→searching→spotted→catching` |
| `parent:sees` | `{ level }` | 0..1 detection meter |
| `game:start` / `game:over` | `{ reason, score, stats }` | reason: `caught` \| `timeup` |
| `baby:crawl` | `{ speed, surface }` | for audio + fx |
| `baby:bump` | `{ force, position, normal }` | headbutt / collision |
| `fx:impact` | `{ position, force, material }` | request a hit effect |
| `camera:shake` | `{ amount, duration }` | |
| `ui:toast` | `{ key, vars, icon }` | transient message |

---

## 7. Debug & screenshot hooks (owned by integrator, respect them)

`main.js` sets:
- `window.__GAME__` — the context, for console poking.
- `window.__READY__ = true` once the first N frames have rendered and everything settled.
- URL params: `?shot=<name>` freezes the game into a scripted camera framing (see
  `src/core/shots.js`) for the automated review harness; `?quality=ultra`; `?lang=es`;
  `?nohud=1`; `?free=1` free-fly camera; `?stats=1`.

**When `?shot=` is active the game is paused and deterministic.** Your module must not animate
randomly in that mode; check `ctx.state.mode === 'photo'` and freeze non-deterministic motion
(but *do* keep your materials, lights and geometry fully present — the reviewers are looking at
exactly that).

---

## 8. Art direction bible

Late-afternoon winter light in Buenos Aires, ~17:30. Sun low and to the -Z/-X, raking through
the glazing, bouncing off the cream rug and up onto the raw concrete slab.

- **Colour**: warm neutrals (cream, oatmeal, birch, milk), one hard accent of navy, one of
  terracotta from the brick building outside. The only saturated things in the room are the
  toys — that's the joke, and it's also the composition's focal hierarchy.
- **Light**: strong key from the window, huge soft fill from the rug bounce, dim warm practical
  from the floor lamp and the pendant. Contrast ratio should be *high* — we want real
  chiaroscuro, not a flat ambient wash. **If the render looks like an unlit CAD model, you have
  failed.**
- **Materials**: nothing is pure white, nothing is pure black, nothing has roughness 1.0 or
  0.0. Every surface needs micro-variation: the plaster has a faint orange-peel normal, the
  concrete has aggregate and formwork, the plywood has grain *and* end-grain on exposed edges,
  the bouclé has actual loop geometry via normal+parallax, the rug has anisotropic sheen, the
  velvet needs a real sheen/fuzz term.
- **Camera**: 55–65° vertical FOV in first person (wide, baby-like, slight barrel distortion),
  handheld micro-motion always present, DoF with a shallow-ish focus that follows the
  interaction target, ACES filmic tonemapping, subtle bloom, chromatic aberration only at the
  edges, fine film grain that does **not** crawl.
- **The tell of a cheap render**: no contact shadows, uniform roughness, hard rectangular
  silhouettes, no dust in the air, perfectly aligned objects. Fix all five. **Nothing in this
  room is perfectly axis-aligned.** Books lean. The rug is slightly rucked. The armchair is 24°
  off. Cushions are dented.

---

## 9. Definition of done for your module

1. `npm run build` passes.
2. `npm run dev` runs and the game does not throw in the console.
3. Your feature is visible/audible/playable and respects all four quality tiers.
4. You added your props to the registry with real `points`/`noise`/`mass` values.
5. All your strings are i18n keys, in both `en` and `es`.
6. You wrote a 5–15 line comment header in your file explaining the approach and any tricky
   maths, in English.
7. You did not touch anyone else's files.

---

## 10. `ctx.materials` — the frozen material API

The MAT agent implements this exactly; everyone else consumes it. **Never construct a
`MeshStandardMaterial` inline** — ask the library, so that texture memory, anisotropy and quality
tiers stay under one roof.

```js
ctx.materials.get(name)                  // → THREE.Material (cached, shared, never dispose it)
ctx.materials.tinted(name, 0xff8844, {roughness: 0.6})  // → cached clone with overrides
ctx.materials.has(name)                  // → boolean
```

`get()` **must never return undefined** — an unknown name logs a warning once and returns a
magenta debug material so the mistake is visible in a screenshot instead of crashing the build.

Canonical names (this list is closed; if you need one that isn't here, use the closest match):

| Group | Names |
|---|---|
| Architecture | `concrete.ceiling`, `concrete.beam`, `plaster.wall`, `plaster.ceilingEdge`, `floor.wood`, `floor.skirting` |
| Wood | `wood.ply`, `wood.plyEdge`, `wood.oak`, `wood.walnut`, `wood.birchToy`, `rattan` |
| Soft goods | `fabric.boucle`, `fabric.velvetCream`, `fabric.navyRib`, `fabric.navyFlat`, `fabric.sheer`, `fabric.mesh`, `fabric.playpenTrim`, `fabric.playmat`, `fabric.muslin`, `fabric.plush`, `fabric.denim`, `rug.wool`, `lampshade` |
| Hard goods | `glass.clear`, `glass.window`, `metal.blackAnodised`, `metal.chrome`, `metal.brass`, `metal.steelWhite`, `metal.speakerGrille`, `ceramic.white`, `ceramic.glazed`, `ceramic.terracotta`, `marble.white`, `plastic.toy`, `plastic.matte`, `silicone`, `foil.snack` |
| Print | `paper.book`, `paper.page`, `paper.magazine`, `card.print`, `vinyl.black`, `vinyl.sleeve`, `art.canvas` |
| Nature | `leaf.monstera`, `leaf.small`, `soil`, `bark` |
| Characters | `skin.baby`, `skin.parent`, `hair.baby`, `hair.parent`, `cloth.onesie`, `cloth.diaper`, `cloth.parent`, `eye` |
| Tech | `screen.laptop`, `screen.off`, `emissive.bulb`, `emissive.lampshade` |
| Exterior | `brick.exterior`, `foliage.tree`, `sky.backdrop`, `glass.exterior` |

## 11. `ctx.physics` — the frozen physics API

Rapier 0.14 (`@dimforge/rapier3d-compat`). PHYS implements, everyone consumes.

```js
physics.addStatic(object3d, { shape='box', friction=0.8, restitution=0.1, size?, radius?, halfHeight? })
physics.addDynamic(object3d, { shape='box', mass=1, friction=0.7, restitution=0.15,
                               linearDamping=0.15, angularDamping=0.4, ccd=false, sleep=true })
   → { body, collider, object3d }   // transform is synced to object3d every fixed step
physics.addCharacter(position, { radius=0.16, halfHeight=0.13 })
   → { controller, collider, body, move(desiredTranslation) → appliedTranslation, grounded }
physics.raycast(origin, direction, maxDistance, { exclude?, solid=true })
   → { point, normal, distance, object3d, prop } | null
physics.sphereCast(origin, radius, direction, maxDistance) → same shape
physics.overlapSphere(center, radius) → object3d[]
physics.impulse(handleOrObject, vec3, atPoint?)
physics.remove(handleOrObject)
physics.setGravityScale(handleOrObject, s)
physics.freeze(handleOrObject, bool)     // for photo mode determinism
physics.onContact(cb)                    // cb({ a, b, force, position, normal }) — drives impact FX
physics.debugMesh()                      // returns a LineSegments of the collider wireframe (?debug=phys)
```

Shapes: `'box' | 'ball' | 'cylinder' | 'capsule' | 'cone' | 'trimesh' | 'hull'`. If `size`/`radius`
is omitted, PHYS derives it from the object's bounding box — **so build your meshes with sane
geometry origins.**

Rules: dynamic bodies sleep by default; only ~40 may be awake at once (PHYS enforces a budget and
puts the furthest-from-camera ones back to sleep). Never step the world yourself.

## 12. i18n key conventions

`ui.*` menus and HUD · `prop.*` object names · `verb.*` interaction prompts · `toast.*` transient
messages · `parent.*` NPC barks · `end.*` game-over copy · `tut.*` tutorial hints.

Every key **must** exist in both `en` and `es`. Spanish is **rioplatense** (voseo: *agarrá*,
*tirá*, *comé*, *escondete*), not neutral Spanish. It should be funny in both languages, not
translated-funny — write the joke twice.

## 13. How you work

- You may run: `npm run build` (must pass), `node -e ...`, `cat`, `grep`. Nothing else.
- **Do not** run `npm install`, add dependencies, edit `package.json`, start dev servers, or run
  `tools/shoot.mjs` — the integrator owns the render harness and parallel browsers would thrash
  the machine.
- Available imports: `three` (0.170), `three/addons/*`, `postprocessing` (6.39), `n8ao` (1.10),
  `@dimforge/rapier3d-compat` (0.14). Nothing else exists.
- Write real code. No `TODO`, no `// implement later`, no placeholder cubes standing in for a
  described object. If the brief says nine fenestrated monstera leaves, build nine fenestrated
  monstera leaves.
- Budget: your module should add well under 8 ms/frame at 1080p on the `high` tier.
- When you finish, report in ≤200 words: what you built, the props you registered, anything you
  need from another module, and the exact output of `npm run build`.
