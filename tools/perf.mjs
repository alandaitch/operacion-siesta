// Frame-cost attribution. Boots the game once, starts a round, then measures sustained frame
// time with individual stages switched off and back on *inside a single page load*, re-measuring
// the baseline between every scenario. Guessing which pass is expensive is how you end up
// optimising the wrong thing; measuring across page reloads is how you end up with ±5 ms of
// noise and the wrong ranking, which is why every toggle here is reversible and paired.
//
//   node tools/perf.mjs
//   node tools/perf.mjs --quality ultra --pr 2 --reps 3
//
// `--pr` forces a device pixel ratio, so a 1x CI display can measure what a 2x Retina panel
// actually costs. Reported delta is (paired baseline − scenario), median across reps.

import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
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
const width = Number(flag('width', 1600));
const height = Number(flag('height', 900));
const forcedPr = Number(flag('pr', 0));
const reps = Number(flag('reps', 2));
const settleMs = Number(flag('settle', 450));
const windowMs = Number(flag('window', 1600));
const outName = String(flag('out', `perf-${quality}${forcedPr ? `-pr${forcedPr}` : ''}`));

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
const page = await browser.newPage({
  viewport: { width, height },
  deviceScaleFactor: forcedPr || undefined,
});
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

await page.goto(`http://127.0.0.1:${port}/?quality=${quality}&stats=1&noadaptive=1`, { waitUntil: 'load' });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });
await page.evaluate(() => {
  const g = window.__GAME__;
  g.events.emit('ui:start');
  g.state.mode = 'playing';
  g.events.emit('game:start', {});
});

// A rolling frame-time sampler independent of the game's own stats ring.
await page.evaluate(() => {
  window.__PERF__ = { t: [], on: false };
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    if (window.__PERF__.on) window.__PERF__.t.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// NOTE `noadaptive=1` above. core/adaptive.js scales the render resolution to hold 60 fps, which
// is exactly the wrong thing during a profile: it would absorb every cost we are trying to measure
// into a resolution change, and it fights the 'half resolution' scenario for ownership of
// renderer.setPixelRatio. Pinning the buffer is the only way these deltas mean anything.

// Reversible toggles: [label, disable, restore]. Every one must leave the stack exactly as it
// found it, because the next paired baseline is the control for the next scenario.
const SCENARIOS = [
  ['no-AO', 'const p=G.postfx.passes.aoPass; if(p) p.enabled=false;',
    'const p=G.postfx.passes.aoPass; if(p) p.enabled=true;'],
  ['no-SSR', 'const p=G.postfx.passes.ssrPass; if(p) p.enabled=false;',
    'const p=G.postfx.passes.ssrPass; if(p) p.enabled=true;'],
  // NOTE on reading 'no-SMAA': disabling the LAST pass also makes the previous one render
  // straight to screen, so this delta is (SMAA + one fullscreen copy). At 1.7 Mpx that copy is
  // well under a millisecond, so a 20 ms delta really is SMAA — but if you are chasing that
  // number, confirm against the control below rather than trusting one toggle.
  ['no-SMAA', 'const p=G.postfx.passes.smaaPass; if(p) p.enabled=false;',
    'const p=G.postfx.passes.smaaPass; if(p) p.enabled=true;'],
  // Same pass, same render targets, same topology — only the blend is zeroed, so the shader still
  // runs. If this is nearly free while 'no-SMAA' saves 20 ms, the cost is the pass's own targets
  // and blits on this driver, not the antialiasing maths.
  ['SMAA blend zeroed (pass still runs)',
    'const e=G.postfx.effects.smaa; if(e){G.__smaaOp=e.blendMode.opacity.value; e.blendMode.opacity.value=0;}',
    'const e=G.postfx.effects.smaa; if(e) e.blendMode.opacity.value=G.__smaaOp;'],
  ['no-grade (DoF+bloom+ACES+LUT+film)', 'const p=G.postfx.passes.gradePass; if(p) p.enabled=false;',
    'const p=G.postfx.passes.gradePass; if(p) p.enabled=true;'],
  ['no-DoF only', 'G.postfx.setFocusDistance(0);', 'G.postfx.setAutoFocus(true);'],
  ['no-bloom only', 'const b=G.postfx.effects.bloom; if(b) b.blendMode.opacity.value=0;',
    'const b=G.postfx.effects.bloom; if(b) b.blendMode.opacity.value=1;'],
  ['shadow rasterisation frozen', 'G.renderer.shadowMap.autoUpdate=false;',
    'G.renderer.shadowMap.autoUpdate=true;'],
  ['shadow SAMPLING off (map kept)', 'G.__sun.castShadow=false;', 'G.__sun.castShadow=true;'],
  ['shadow map 1024', 'G.__sun.shadow.mapSize.set(1024,1024); G.__sun.shadow.map=null;',
    'G.__sun.shadow.mapSize.set(G.__sunMapSize,G.__sunMapSize); G.__sun.shadow.map=null;'],
  ['shadow radius 1 (narrow poisson)', 'G.__sunRadius=G.__sun.shadow.radius; G.__sun.shadow.radius=1;',
    'G.__sun.shadow.radius=G.__sunRadius;'],
  ['rect-area lights off', 'for(const n of ["light.window","light.bounce"]){const l=G.scene.getObjectByName(n); if(l) l.intensity=0;}',
    'const w=G.scene.getObjectByName("light.window"); if(w) w.intensity=2.7; const b=G.scene.getObjectByName("light.bounce"); if(b) b.intensity=1.05;'],
  ['transparent objects hidden', `
    G.__hid=[]; G.scene.traverse(o=>{ if(o.isMesh && o.material && !Array.isArray(o.material) && (o.material.transparent||o.material.transmission>0) && o.visible){o.visible=false;G.__hid.push(o);} });`,
    'for(const o of G.__hid||[]) o.visible=true; G.__hid=[];'],
  ['half resolution', 'G.__pr=G.renderer.getPixelRatio(); G.renderer.setPixelRatio(G.__pr*0.5); G.renderer.setSize(innerWidth,innerHeight,false); G.postfx.resize();',
    'G.renderer.setPixelRatio(G.__pr); G.renderer.setSize(innerWidth,innerHeight,false); G.postfx.resize();'],
];

// Expose the sun so shadow scenarios can reach it without a module import.
await page.evaluate(() => {
  const g = window.__GAME__;
  g.__sun = g.scene.getObjectByName('light.sun');
  g.__sunMapSize = g.__sun ? g.__sun.shadow.mapSize.x : 2048;
});

async function sample() {
  await page.evaluate(() => { window.__PERF__.t.length = 0; window.__PERF__.on = false; });
  await page.waitForTimeout(settleMs);
  await page.evaluate(() => { window.__PERF__.t.length = 0; window.__PERF__.on = true; });
  await page.waitForTimeout(windowMs);
  return page.evaluate(() => {
    window.__PERF__.on = false;
    const t = window.__PERF__.t.slice().sort((a, b) => a - b);
    const g = window.__GAME__;
    // A scenario slow enough to fit no frames in the window is the answer, not an error.
    const pick = (q) => (t.length ? t[Math.min(t.length - 1, Math.max(0, Math.floor(t.length * q)))] : 1000);
    return {
      frames: t.length,
      medianMs: +pick(0.5).toFixed(2),
      p10Ms: +pick(0.1).toFixed(2),
      drawCalls: g.engine.stats.drawCalls,
      triangles: g.engine.stats.triangles,
      kilopixels: Math.round((g.renderer.domElement.width * g.renderer.domElement.height) / 1000),
    };
  });
}

const run = (src) => page.evaluate(new Function('const G = window.__GAME__;' + src));

const baselines = [];
const rows = [];
for (const [label, off, on] of SCENARIOS) {
  const deltas = [];
  let scen = null;
  let base = null;
  for (let r = 0; r < reps; r++) {
    base = await sample();
    baselines.push(base.medianMs);
    await run(off);
    scen = await sample();
    await run(on);
    deltas.push(base.medianMs - scen.medianMs);
  }
  deltas.sort((a, b) => a - b);
  const med = deltas[Math.floor(deltas.length / 2)];
  rows.push({ label, savedMs: +med.toFixed(2), scenarioMs: scen.medianMs, baselineMs: base.medianMs, samples: deltas.map((d) => +d.toFixed(2)) });
  console.log(`${label.padEnd(36)} saves ${med.toFixed(2).padStart(6)} ms   (${base.medianMs} → ${scen.medianMs})   [${deltas.map((d) => d.toFixed(1)).join(' ')}]`);
}

const finalBase = await sample();
baselines.sort((a, b) => a - b);
const baseMed = baselines[Math.floor(baselines.length / 2)];
console.log(`\nbaseline ${baseMed.toFixed(2)} ms (${(1000 / baseMed).toFixed(1)} fps) · ${finalBase.kilopixels} kpx · ${finalBase.drawCalls} draws · ${Math.round(finalBase.triangles / 1000)}k tris`);
console.log('\nranked:');
for (const r of [...rows].sort((a, b) => b.savedMs - a.savedMs)) {
  console.log(`  ${r.savedMs.toFixed(2).padStart(6)} ms  ${r.label}`);
}

fs.mkdirSync(path.join(root, 'shots'), { recursive: true });
fs.writeFileSync(path.join(root, 'shots', `_${outName}.json`),
  JSON.stringify({ quality, width, height, forcedPr, baselineMs: baseMed, final: finalBase, rows }, null, 2));

await browser.close();
await server.close();
