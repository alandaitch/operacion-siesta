// "Can a player actually get out of the playpen?" — the first sixty seconds, tested end to end.
//
// The round starts with the baby INSIDE the playpen (LAYOUT.baby.start is (-0.72, 2.72), and the
// pen occupies x∈[-1.4,1.4] z∈[0.7,3.3]). The only way out is the zip door on the -z face, which
// is registered as a `pullable` prop. A smoke test that drives W and a wandering look will crawl
// in circles inside the pen forever and report healthy locomotion, because the path length is
// real — it just never goes anywhere. This checks the thing that actually matters.
//
// It steers by writing the character's look yaw directly, which is what a competent player's hand
// does, then uses only real key input for everything else. Phases:
//   1. face the door, crawl to it
//   2. press the grab verb until the door opens
//   3. crawl through and confirm the baby is outside the pen footprint
//   4. head for the rug and try to wreck something
//
//   node tools/escape.mjs [--quality high] [--seconds 70]

import { chromium } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const quality = String(flag('quality', 'high'));
const budget = Number(flag('seconds', 70));

const outDir = path.join(root, 'shots', 'escape');
fs.mkdirSync(outDir, { recursive: true });

const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.js'),
  server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false, watch: null },
  // hmr:false + watch:null — a harness must not reload halfway through a measurement because
  // another agent saved a file. Every run reads the source once, at boot.
  logLevel: 'error',
});
await server.listen();
const port = server.httpServer.address().port;

const browser = await chromium.launch({
  headless: false,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--force-color-profile=srgb',
    '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    '--window-position=2400,80'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://127.0.0.1:${port}/?quality=${quality}&stats=1`, { waitUntil: 'load' });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 90000 });
await page.evaluate(() => {
  const g = window.__GAME__;
  g.events.emit('ui:start');
  g.state.mode = 'playing';
  g.events.emit('game:start', {});
});
await page.waitForTimeout(400);

/** Aim the head at a world point, the way a player would, and report where we are. */
const steerTo = (tx, tz) => page.evaluate(([x, z]) => {
  const g = window.__GAME__;
  const b = g.baby.position;
  const dx = x - b.x;
  const dz = z - b.z;
  // camera.js: forward is (-sin(yaw), ·, -cos(yaw)), so the heading that points at (dx,dz) is
  // atan2(-dx, -dz). Write it straight into the look state; the controller chases it with its
  // own angular acceleration, so this is a hand on a mouse, not a teleport.
  g.baby.look.yaw = Math.atan2(-dx, -dz);
  return {
    x: +b.x.toFixed(2), z: +b.z.toFixed(2),
    dist: +Math.hypot(dx, dz).toFixed(2),
    target: g.state.targetId || null,
    verb: g.state.verb || null,
  };
}, [tx, tz]);

const snap = () => page.evaluate(() => {
  const g = window.__GAME__;
  const b = g.baby.position;
  const inPen = b.x > -1.45 && b.x < 1.45 && b.z > 0.65 && b.z < 3.35;
  const door = g.props.list.find((p) => p.id === 'playpen-door');
  return {
    x: +b.x.toFixed(2), z: +b.z.toFixed(2), inPen,
    // `toppled` is what core/context.js's registry actually sets — it is the one ruined flag,
    // whether the prop was knocked, pulled or eaten.
    doorOpen: door ? !!door.toppled : null,
    score: g.state.score,
    ruined: g.props.stats(),
    parent: g.parent?.state ?? null,
    mode: g.state.mode,
    fps: Math.round(g.engine.stats.fps),
    renderScale: +(g.engine.getRenderScale?.() ?? 1).toFixed(2),
  };
});

const log = [];
const t0 = Date.now();
const elapsed = () => (Date.now() - t0) / 1000;

// ── phase 1+2: to the door, and open it ─────────────────────────────────────────────────────
// The door is the -z face at x∈[-0.55,0.55]; aim at its middle, from inside.
let opened = false;
let pressing = false;
await page.keyboard.down('KeyW');
while (elapsed() < budget * 0.5 && !opened) {
  const s = await steerTo(0, 0.72);
  // Within arm's reach of the door, hold the grab verb.
  const want = s.dist < 0.85;
  if (want && !pressing) { await page.keyboard.down('KeyE'); pressing = true; }
  else if (!want && pressing) { await page.keyboard.up('KeyE'); pressing = false; }
  await page.waitForTimeout(120);
  const st = await snap();
  if (st.doorOpen || !st.inPen) opened = true;
  if (Math.round(elapsed() * 10) % 20 === 0) log.push({ t: +elapsed().toFixed(1), phase: 'door', ...st, dist: s.dist, target: s.target });
}
if (pressing) await page.keyboard.up('KeyE');
const atDoor = await snap();
await page.screenshot({ path: path.join(outDir, '1-door.png') });

// ── phase 3: through the gap ────────────────────────────────────────────────────────────────
let out = false;
const outDeadline = elapsed() + 18;
while (elapsed() < outDeadline && !out) {
  await steerTo(0, -0.4);
  await page.waitForTimeout(120);
  const st = await snap();
  if (!st.inPen) out = true;
}
const escaped = await snap();
await page.screenshot({ path: path.join(outDir, '2-out.png') });

// ── phase 4: wreck something ────────────────────────────────────────────────────────────────
// The snack bag is on the rug at (1.35, -0.55) and the coffee table at (0.95, -2.35).
const before = escaped.ruined.done;
const targets = [[1.35, -0.55], [0.95, -2.35], [2.30, 0.60]];
let ti = 0;
while (elapsed() < budget) {
  const [tx, tz] = targets[ti % targets.length];
  const s = await steerTo(tx, tz);
  if (s.dist < 0.7) {
    await page.keyboard.press('Space');
    await page.keyboard.down('KeyE');
    await page.waitForTimeout(500);
    await page.keyboard.up('KeyE');
    ti++;
  }
  await page.waitForTimeout(120);
}
await page.keyboard.up('KeyW');
const final = await snap();
await page.screenshot({ path: path.join(outDir, '3-final.png') });

const report = {
  quality,
  reachedDoor: atDoor,
  escapedPlaypen: !escaped.inPen,
  escapeSeconds: out ? +elapsed().toFixed(1) : null,
  final,
  propsRuinedDuringRampage: final.ruined.done - before,
  errors: [...new Set(errors)].filter((e) => !e.includes('404')).slice(0, 10),
  trace: log.slice(0, 20),
};
fs.writeFileSync(path.join(outDir, '_escape.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await browser.close();
await server.close();

const bad = [];
if (!report.escapedPlaypen) bad.push('the baby never got out of the playpen — the round is unwinnable');
if (report.propsRuinedDuringRampage < 1) bad.push('nothing was destroyed after escaping');
if (report.errors.length) bad.push('console errors');
console.log(bad.length ? `\nFAIL:\n  - ${bad.join('\n  - ')}` : '\nPASS');
process.exit(bad.length ? 1 : 0);
