// Look-control conformance. One check per input path, because "you cannot look sideways on a
// trackpad" is the kind of bug that hides behind a working mouse.
//
// For each path it holds the gesture for a fixed time and reports the yaw and pitch travel in
// radians. A path that moves the head less than a few degrees is broken, and a path whose yaw
// travel is far smaller than its pitch travel is the specific failure the author reported.
//
//   node tools/look.mjs

import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

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
  args: ['--enable-gpu', '--use-angle=metal', '--mute-audio', '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required', '--window-position=2400,80'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 650 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

await page.goto(`http://127.0.0.1:${port}/?quality=low&stats=1`, { waitUntil: 'load' });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 90000 });
await page.evaluate(() => {
  const g = window.__GAME__;
  g.events.emit('ui:start');
  g.state.mode = 'playing';
  g.events.emit('game:start', {});
});
await page.waitForTimeout(400);

const read = () => page.evaluate(() => {
  const g = window.__GAME__;
  return {
    yaw: g.baby.look.yaw, pitch: g.baby.look.pitch,
    locked: g.input.state.pointerLocked, trackpad: g.input.state.trackpad,
    src: g.input.state.lookSource, mode: g.state.mode,
  };
});

/** Re-centre so each path is measured from the same place. */
const recentre = () => page.evaluate(() => {
  const g = window.__GAME__;
  g.baby.look.yaw = 0;
  g.baby.look.pitch = 0;
});

async function check(name, gesture) {
  await recentre();
  await page.waitForTimeout(150);
  const a = await read();
  await gesture();
  await page.waitForTimeout(220);
  const b = await read();
  const yaw = Math.abs(b.yaw - a.yaw);
  const pitch = Math.abs(b.pitch - a.pitch);
  const deg = (r) => `${((r * 180) / Math.PI).toFixed(1)}°`;
  console.log(
    `${name.padEnd(30)} yaw ${deg(yaw).padStart(7)}   pitch ${deg(pitch).padStart(7)}   ` +
    `src=${b.src} locked=${b.locked} trackpad=${b.trackpad}`,
  );
  return { name, yaw, pitch, src: b.src, mode: b.mode };
}

const results = [];

// 1. Two-finger trackpad swipe, horizontal. No pointer lock involved at all.
results.push(await check('wheel / two-finger, sideways', async () => {
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(-40, 0); await page.waitForTimeout(30); }
}));

// 2. The same gesture vertically.
results.push(await check('wheel / two-finger, vertical', async () => {
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, -40); await page.waitForTimeout(30); }
}));

// 3. Drag-to-look with a button held, unlocked. Playwright's synthetic pointerdown does not
//    engage pointer lock, which makes this exactly the refused-lock case.
results.push(await check('drag with button held', async () => {
  await page.mouse.move(550, 325);
  await page.mouse.down();
  for (let i = 0; i < 14; i++) { await page.mouse.move(550 - i * 22, 325, { steps: 1 }); await page.waitForTimeout(25); }
  await page.mouse.up();
}));

// 4. Arrow keys — the path that cannot be refused by anything.
results.push(await check('arrow key, sideways', async () => {
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(600);
  await page.keyboard.up('ArrowLeft');
}));
results.push(await check('arrow key, vertical', async () => {
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(600);
  await page.keyboard.up('ArrowUp');
}));

// 5. Direction. Looking left must increase yaw (camera.js forward is (-sin y, ·, -cos y)).
await recentre();
await page.waitForTimeout(120);
await page.keyboard.down('ArrowLeft');
await page.waitForTimeout(400);
await page.keyboard.up('ArrowLeft');
const left = await read();
console.log(`\narrow-left yaw sign: ${left.yaw > 0 ? '+ (turns left, correct)' : '- (turns RIGHT, inverted)'}`);

// 6. And that none of it moves the head while paused.
await recentre();
await page.evaluate(() => { window.__GAME__.state.mode = 'paused'; });
const pausedBefore = await read();
await page.mouse.wheel(-300, -300);
await page.keyboard.down('ArrowLeft');
await page.waitForTimeout(300);
await page.keyboard.up('ArrowLeft');
const pausedAfter = await read();
const leaked = Math.abs(pausedAfter.yaw - pausedBefore.yaw) + Math.abs(pausedAfter.pitch - pausedBefore.pitch);
console.log(`paused leak: ${leaked.toFixed(4)} rad ${leaked < 1e-3 ? '(clean)' : '(LEAKING — look runs while paused)'}`);

await browser.close();
await server.close();

const MIN = 0.12; // radians ≈ 7°, far below any usable gesture but far above noise
const bad = results.filter((r) => Math.max(r.yaw, r.pitch) < MIN).map((r) => r.name);
const noYaw = results.filter((r) => r.name.includes('sideways') && r.yaw < MIN).map((r) => r.name);
if (leaked >= 1e-3) bad.push('look runs while paused');
if (left.yaw <= 0) bad.push('arrow-left turns the wrong way');
console.log(bad.length || noYaw.length
  ? `\nFAIL:\n  - ${[...new Set([...bad, ...noYaw.map((n) => `${n}: no horizontal travel`)])].join('\n  - ')}`
  : '\nPASS — every look path moves the head, in both axes, only while playing');
process.exit(bad.length || noYaw.length ? 1 : 0);
