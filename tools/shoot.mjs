// Automated art-review harness.
//
// Boots the built game once per scripted camera framing (src/core/shots.js), waits for
// window.__READY__ (which main.js only sets after the world has settled and ~100 deterministic
// frames have rendered), and writes a PNG per shot. Those PNGs are what the art-review agents
// look at. Console errors are captured and reported per shot, because a beautiful screenshot of
// a broken build is worse than no screenshot.
//
// Usage:
//   node tools/shoot.mjs                       all shots -> shots/<round>/
//   node tools/shoot.mjs sofa playpen          only these
//   node tools/shoot.mjs --round r02 --w 1920 --h 1080 --quality ultra
//   node tools/shoot.mjs --headed              use the real GPU (much better, opens a window)

import { chromium } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  argv.splice(i, 2);
  return v;
};
const round = String(flag('round', 'latest'));
const W = Number(flag('w', 1600));
const H = Number(flag('h', 900));
const quality = String(flag('quality', 'ultra'));
const lang = String(flag('lang', 'en'));
const headed = !!flag('headed', true);
const concurrency = Number(flag('jobs', 3));
const timeoutMs = Number(flag('timeout', 60000));

const { SHOTS } = await import(path.join(root, 'src/core/shots.js'));
const requested = argv.filter((a) => !a.startsWith('--'));
const shotNames = (requested.length ? requested : Object.keys(SHOTS)).filter(
  (n) => SHOTS[n] && !SHOTS[n].follow
);

const outDir = path.join(root, 'shots', round);
fs.mkdirSync(outDir, { recursive: true });

const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.js'),
  server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false, watch: null },
  // hmr:false + watch:null — a round takes minutes and must render one fixed revision of the
  // source. Without this, a file saved mid-run reloads the page and the round is a mix.
  logLevel: 'error',
});
await server.listen();
const port = server.httpServer.address().port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({
  headless: !headed,
  args: [
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--use-angle=metal',
    '--force-color-profile=srgb',
    '--disable-lcd-text',
    '--hide-scrollbars',
    '--mute-audio',
    '--window-position=2400,80',
  ],
});

const results = [];
const queue = [...shotNames];

async function worker(id) {
  const page = await browser.newPage({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
  });
  while (queue.length) {
    const name = queue.shift();
    const errors = [];
    const onErr = (m) => {
      if (m.type() === 'error') errors.push(m.text());
    };
    page.on('console', onErr);
    page.on('pageerror', (e) => errors.push(String(e)));
    const t0 = Date.now();
    let ok = false;
    try {
      await page.goto(
        `${base}/?shot=${encodeURIComponent(name)}&quality=${quality}&lang=${lang}&nohud=1`,
        { waitUntil: 'load', timeout: timeoutMs }
      );
      await page.waitForFunction('window.__READY__ === true', null, { timeout: timeoutMs });
      await page.waitForTimeout(450);
      await page.screenshot({ path: path.join(outDir, `${name}.png`), type: 'png' });
      ok = true;
    } catch (err) {
      errors.push(`HARNESS: ${err.message}`);
      try {
        await page.screenshot({ path: path.join(outDir, `${name}.FAILED.png`) });
      } catch {
        /* ignore */
      }
    }
    page.off('console', onErr);
    results.push({ name, ok, ms: Date.now() - t0, errors: [...new Set(errors)].slice(0, 8) });
    process.stdout.write(
      `${ok ? '✓' : '✗'} ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)` +
        (errors.length ? `  ⚠ ${errors.length} console error(s)` : '') +
        '\n'
    );
  }
  await page.close();
}

await Promise.all(Array.from({ length: Math.min(concurrency, shotNames.length) }, (_, i) => worker(i)));

await browser.close();
await server.close();

const failed = results.filter((r) => !r.ok);
const withErrors = results.filter((r) => r.errors.length);
fs.writeFileSync(
  path.join(outDir, '_report.json'),
  JSON.stringify({ round, W, H, quality, results }, null, 2)
);

console.log(`\n${results.length - failed.length}/${results.length} shots written to shots/${round}/`);
if (withErrors.length) {
  console.log('\nCONSOLE ERRORS:');
  for (const r of withErrors) console.log(`  [${r.name}] ${r.errors.join('\n            ')}`);
}
process.exit(failed.length ? 1 : 0);
