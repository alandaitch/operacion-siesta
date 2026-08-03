// Functional QA harness — "does it actually work?", as opposed to shoot.mjs's "does it look right?".
//
// Boots the game for real (no ?shot), starts a round, drives the character with synthetic input for
// a while, and reports: console errors, sustained frame rate, draw calls, whether the baby actually
// moved, whether props actually got destroyed, whether the score moved, whether the parent AI
// changed state, and whether anything leaked. Also grabs a few in-play screenshots.
//
//   node tools/smoke.mjs
//   node tools/smoke.mjs --seconds 40 --quality high --lang es --round play

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
const seconds = Number(flag('seconds', 30));
const quality = String(flag('quality', 'high'));
const lang = String(flag('lang', 'en'));
const roundName = String(flag('round', 'play'));

const outDir = path.join(root, 'shots', roundName);
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
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

const errors = [];
const warnings = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  else if (m.type() === 'warning') warnings.push(m.text());
});
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));

console.log(`booting…`);
await page.goto(`http://127.0.0.1:${port}/?quality=${quality}&lang=${lang}&stats=1`, { waitUntil: 'load' });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 90000 });
const bootMs = await page.evaluate(() => Math.round(performance.now()));
console.log(`booted in ${bootMs} ms`);

await page.screenshot({ path: path.join(outDir, '00-title.png') });

// Start the round: try the real menu first (that is also a test of the menu), then force it.
await page.mouse.move(800, 450);
await page.mouse.click(800, 450);
await page.waitForTimeout(400);
await page.keyboard.press('Enter');
await page.waitForTimeout(900);

let mode = await page.evaluate(() => window.__GAME__?.state?.mode);
if (mode !== 'playing') {
  console.log(`menu did not start the round (mode=${mode}) — forcing`);
  await page.evaluate(() => {
    const g = window.__GAME__;
    g.events.emit('ui:start');
    g.state.mode = 'playing';
    g.events.emit('game:start', {});
  });
  await page.waitForTimeout(600);
  mode = await page.evaluate(() => window.__GAME__?.state?.mode);
}
console.log(`mode=${mode}`);

const before = await page.evaluate(() => {
  const g = window.__GAME__;
  return {
    pos: g.baby?.position ? [g.baby.position.x, g.baby.position.y, g.baby.position.z] : null,
    yaw: g.baby?.look ? g.baby.look.yaw : null,
    score: g.state.score,
    props: g.props.list.length,
    ruined: g.props.stats(),
  };
});

// Path length, not net displacement: a baby that crawls in a circle has still moved, and a baby
// wedged against the playpen wall has not, and only one of those is a bug. Sampled from the page.
await page.evaluate(() => {
  const g = window.__GAME__;
  window.__PATH__ = 0;
  let px = g.baby.position.x;
  let pz = g.baby.position.z;
  window.__YAW__ = 0;
  let py = g.baby.look.yaw;
  const wrap = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
  window.__PATH_TIMER__ = setInterval(() => {
    const b = g.baby.position;
    window.__PATH__ += Math.hypot(b.x - px, b.z - pz);
    px = b.x;
    pz = b.z;
    // Cumulative, wrapped. The drive script sweeps the look back and forth, so the NET change
    // between the first and last sample is near zero however well the control works.
    window.__YAW__ += Math.abs(wrap(g.baby.look.yaw - py));
    py = g.baby.look.yaw;
  }, 50);
});

// Drive it. A crawl-forward-and-bash loop, plus look-around and the interaction verbs.
const script = [
  ['KeyW', 2600], ['KeyA', 700], ['KeyW', 1800], ['Space', 220], ['KeyW', 1200],
  ['KeyD', 900], ['Space', 220], ['KeyW', 2000], ['KeyE', 1400], ['KeyW', 1500],
  ['KeyD', 800], ['Space', 220], ['KeyF', 1800], ['KeyW', 1800], ['ShiftLeft+KeyW', 2200],
  ['KeyA', 900], ['Space', 220], ['KeyW', 2200], ['KeyE', 1200], ['KeyW', 1600],
];
const fpsSamples = [];
const t0 = Date.now();
let shotIdx = 1;
let i = 0;
while (Date.now() - t0 < seconds * 1000) {
  const [keys, ms] = script[i % script.length];
  i++;
  const parts = keys.split('+');
  for (const k of parts) await page.keyboard.down(k);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Look with the wheel, which is the trackpad path and needs no pointer lock — a bare
    // mouse.move() produces no look at all off pointer lock, so a harness that used one was
    // measuring a baby that could not steer and reporting it as broken locomotion.
    await page.mouse.wheel(Math.sin(Date.now() / 700) * 26, 0);
    await page.waitForTimeout(90);
  }
  for (const k of parts.reverse()) await page.keyboard.up(k);

  const s = await page.evaluate(() => {
    const g = window.__GAME__;
    return {
      fps: g.engine?.stats?.fps ?? null,
      draws: g.engine?.stats?.drawCalls ?? null,
      tris: g.engine?.stats?.triangles ?? null,
      score: g.state.score,
      mode: g.state.mode,
    };
  });
  if (s.fps) fpsSamples.push(s.fps);
  if (i === 3 || i === 9 || i === 15) {
    await page.screenshot({ path: path.join(outDir, `0${shotIdx++}-play.png`) });
  }
}

const after = await page.evaluate(() => {
  const g = window.__GAME__;
  clearInterval(window.__PATH_TIMER__);
  return {
    path: +(window.__PATH__ || 0).toFixed(2),
    yawTravel: +(window.__YAW__ || 0).toFixed(2),
    renderScale: g.engine?.getRenderScale ? +g.engine.getRenderScale().toFixed(3) : null,
    pos: g.baby?.position ? [g.baby.position.x, g.baby.position.y, g.baby.position.z] : null,
    score: g.state.score,
    mode: g.state.mode,
    combo: g.state.bestCombo ?? g.state.combo,
    ruined: g.props.stats(),
    stats: g.engine?.stats || null,
    parent: g.parent?.state ?? null,
    threat: g.parent?.getThreat?.() ?? null,
    memory: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    awake: g.physics?.awakeCount?.() ?? null,
  };
});

await page.screenshot({ path: path.join(outDir, '99-final.png') });

// Third person too — this is a documented feature and must not be broken.
await page.keyboard.press('KeyV');
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(outDir, '98-thirdperson.png') });

// Language switch must not throw.
await page.evaluate(() => window.__GAME__?.i18n?.setLang?.('es'));
await page.waitForTimeout(500);

const moved = before.pos && after.pos
  ? Math.hypot(after.pos[0] - before.pos[0], after.pos[2] - before.pos[2])
  : 0;
const fps = fpsSamples.length ? fpsSamples.slice(2) : [];
const avgFps = fps.length ? fps.reduce((a, b) => a + b, 0) / fps.length : 0;
const minFps = fps.length ? Math.min(...fps) : 0;

const report = {
  bootMs,
  mode: after.mode,
  movedMetres: +moved.toFixed(2),
  pathMetres: after.path,
  yawTravelRadians: after.yawTravel,
  renderScale: after.renderScale,
  scoreBefore: before.score,
  scoreAfter: after.score,
  propsRegistered: before.props,
  propsRuined: after.ruined,
  bestCombo: after.combo,
  parentState: after.parent,
  threat: after.threat,
  avgFps: +avgFps.toFixed(1),
  minFps: +minFps.toFixed(1),
  drawCalls: after.stats?.drawCalls ?? null,
  triangles: after.stats?.triangles ?? null,
  heapMB: after.memory,
  awakeBodies: after.awake,
  errors: [...new Set(errors)].slice(0, 25),
  warnings: [...new Set(warnings)].slice(0, 12),
};

fs.writeFileSync(path.join(outDir, '_smoke.json'), JSON.stringify(report, null, 2));
await browser.close();
await server.close();

console.log('\n' + JSON.stringify(report, null, 2));
const bad = [];
if (report.pathMetres < 6) bad.push(`the baby crawled only ${report.pathMetres} m of path — locomotion or input is broken`);
if (report.yawTravelRadians < 3.0) bad.push(`the head turned only ${report.yawTravelRadians} rad in total — the look control is not reaching the character`);
if (report.propsRegistered < 30) bad.push(`only ${report.propsRegistered} props registered`);
if (report.propsRuined?.done === 0) bad.push('nothing was destroyed in the whole run');
if (report.avgFps && report.avgFps < 45) bad.push(`average fps ${report.avgFps} is below target`);
if (report.errors.filter((e) => !e.includes('404')).length) bad.push('console errors');
console.log(bad.length ? `\nFAIL:\n  - ${bad.join('\n  - ')}` : '\nPASS');
process.exit(bad.length ? 1 : 0);
