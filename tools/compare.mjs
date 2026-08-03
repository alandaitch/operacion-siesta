// Blind A/B composite builder.
//
// Takes the same scripted shot from two rounds and lays them side by side in one PNG, in a
// randomised (but recorded) order, labelled only LEFT / RIGHT. The art-review agents are shown
// the composite with no provenance, so "which of these is better" is an honest judgement rather
// than a confirmation of whichever one they were told is newer. The answer key is written to a
// separate file the judges are never given.
//
// COUNTERBALANCING, and why it is not optional. The first run of this harness (r01 vs r06) came
// back with judges choosing RIGHT in 14 of 15 pairs, across a key that had put the newer round on
// the right only 6 times. Under a fair coin that is p ~= 0.001: the instrument was measuring
// position, not quality, and the resulting "the two rounds are equivalent" was meaningless. The
// composite itself is geometrically symmetric — two equal flex panels, identical borders — so the
// bias is in the judge, which is the well-documented tendency of a language model to favour the
// last thing it was shown. Layout cannot fix that; only asking twice can.
//
// So every pair is now emitted TWICE: `<shot>.png` and `<shot>.rev.png`, the same two frames in
// opposite order. Judge both, independently, and count a shot as a real preference only when the
// two judgements name the same ROUND. A shot where both judgements name the same SIDE is the
// judge's position bias and must be discarded, not averaged.
//
// Compositing is done by rendering an HTML page in the same headless Chromium the shot harness
// uses — no image library needed.
//
//   node tools/compare.mjs --a r01 --b r02              all shots present in both
//   node tools/compare.mjs --a r01 --b r02 sofa ceiling

import { chromium } from 'playwright';
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
  argv.splice(i, 2);
  return v;
};
const A = String(flag('a', 'r01'));
const B = String(flag('b', 'r02'));
const seed = Number(flag('seed', 1337));
const outName = String(flag('out', `${A}-vs-${B}`));
const only = argv.filter((s) => !s.startsWith('--'));

const dirA = path.join(root, 'shots', A);
const dirB = path.join(root, 'shots', B);
const outDir = path.join(root, 'compare', outName);
fs.mkdirSync(outDir, { recursive: true });

const listing = (d) =>
  new Set(
    fs
      .readdirSync(d)
      .filter((f) => f.endsWith('.png') && !f.includes('FAILED'))
      .map((f) => f.replace(/\.png$/, ''))
  );

const inA = listing(dirA);
const inB = listing(dirB);
const shots = [...inA].filter((s) => inB.has(s)).filter((s) => !only.length || only.includes(s));

// Deterministic coin flip per shot so a re-run of this script reproduces the same pairing.
let s = seed >>> 0;
const flip = () => {
  s = (s * 1664525 + 1013904223) >>> 0;
  return s / 4294967296 > 0.5;
};

const browser = await chromium.launch({ headless: true, args: ['--force-color-profile=srgb', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 3220, height: 940 }, deviceScaleFactor: 1 });
const key = {};

for (const shot of shots) {
  const swap = flip();
  const left = swap ? path.join(dirB, `${shot}.png`) : path.join(dirA, `${shot}.png`);
  const right = swap ? path.join(dirA, `${shot}.png`) : path.join(dirB, `${shot}.png`);
  key[shot] = { LEFT: swap ? B : A, RIGHT: swap ? A : B };
  key[`${shot}.rev`] = { LEFT: swap ? A : B, RIGHT: swap ? B : A };

  // Inline as data URIs: a page created with setContent has an about:blank origin and Chromium
  // refuses to load file:// images into it, which silently hangs the "are the images ready" wait.
  const dataUri = (f) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
  const leftSrc = dataUri(left);
  const rightSrc = dataUri(right);

  const html = (aSrc, bSrc) => `<!doctype html><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#101010;font:600 22px/1 ui-sans-serif,system-ui,sans-serif;color:#eee}
    .wrap{display:flex;gap:10px;padding:10px}
    figure{flex:1;display:flex;flex-direction:column;gap:8px}
    img{width:100%;height:auto;display:block;border:1px solid #2a2a2a}
    figcaption{letter-spacing:.35em;text-align:center;color:#bbb}
  </style><div class="wrap">
    <figure><img src="${aSrc}"><figcaption>LEFT</figcaption></figure>
    <figure><img src="${bSrc}"><figcaption>RIGHT</figcaption></figure>
  </div>`;

  const render = async (a, b, file) => {
    const markup = html(a, b);
    await page.setContent(markup, { waitUntil: 'load' });
    await page.waitForFunction('Array.from(document.images).every(i => i.complete && i.naturalWidth > 0)');
    const box = await page.locator('.wrap').boundingBox();
    await page.screenshot({ path: path.join(outDir, file), clip: box });
  };
  await render(leftSrc, rightSrc, `${shot}.png`);
  await render(rightSrc, leftSrc, `${shot}.rev.png`);
  console.log(`· ${shot} (+ reversed)`);
}

await browser.close();
fs.writeFileSync(path.join(root, 'compare', `${outName}.key.json`), JSON.stringify(key, null, 2));
console.log(`\n${shots.length} composites -> compare/${outName}/`);
console.log(`answer key -> compare/${outName}.key.json  (do NOT show this to the judges)`);
