// Decisive A/B on where the frame time actually goes. Boots one page, plays, then toggles a single
// suspect at runtime and re-measures. No code changes, no guessing.
import { chromium } from 'playwright';
import { createServer } from 'vite';
const server = await createServer({ root: process.cwd(), configFile: process.cwd()+'/vite.config.js',
  server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const port = server.httpServer.address().port;
const b = await chromium.launch({ headless: false, args: ['--use-angle=metal','--enable-gpu','--window-position=2400,80','--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto(`http://127.0.0.1:${port}/?quality=high&stats=1&noadaptive=1`, { waitUntil: 'load' });
await p.waitForFunction('window.__READY__===true', null, { timeout: 90000 });
await p.evaluate(() => { const g = window.__GAME__; g.state.mode='playing'; g.events.emit('game:start',{}); });

const measure = async (label, setup) => {
  await p.evaluate(setup);
  await p.waitForTimeout(2500);
  const r = await p.evaluate(() => {
    const s = window.__GAME__.engine.stats;
    return { fps: +s.fps.toFixed(1), frameMs: +(s.frameMs||0).toFixed(2), draws: s.drawCalls, tris: s.triangles };
  });
  console.log(`${label.padEnd(34)} fps ${String(r.fps).padStart(5)}  frame ${String(r.frameMs).padStart(6)}ms  draws ${String(r.draws).padStart(4)}  tris ${r.tris}`);
  return r;
};

await measure('baseline', () => {});

// MeshPhysicalMaterial.transmission makes three.js render the whole scene into a separate
// transmission render target, at full resolution, every frame. The sheer curtains and the glass
// coffee table both use it, and they cover a large part of the frame.
await measure('- transmission on all materials', () => {
  const g = window.__GAME__; let n = 0;
  g.scene.traverse((o) => {
    const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of ms) if (m && m.transmission > 0) { m.transmission = 0; m.needsUpdate = true; n++; }
  });
  window.__N_TRANSMISSIVE__ = n;
});
await measure('- post FX (verified bypass)', () => {
  const g = window.__GAME__;
  g.postfx.render = () => { window.__BYPASSED__ = (window.__BYPASSED__ || 0) + 1; g.renderer.render(g.scene, g.camera); };
});
console.log('transmissive materials found:', await p.evaluate(() => window.__N_TRANSMISSIVE__),
            '| bypass frames:', await p.evaluate(() => window.__BYPASSED__ || 0));
await b.close(); await server.close();
