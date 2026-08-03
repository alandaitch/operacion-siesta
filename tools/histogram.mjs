// Measure a render instead of arguing about it.
//
// Decodes a PNG (no dependencies — zlib plus a small un-filter loop) and prints the numbers that
// actually settle a look argument: luminance distribution, how much of the frame is clipped at
// either end, and the red-vs-blue balance that tells you whether the grade has gone sepia.
//
//   node tools/histogram.mjs shots/r01/hero.png
//   node tools/histogram.mjs shots/r01/*.png --json

import fs from 'node:fs';
import zlib from 'node:zlib';

function decodePng(buf) {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error('not a PNG');
  let p = 8;
  let w = 0, h = 0, depth = 8, color = 6, interlace = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      color = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
  if (interlace) throw new Error('interlaced PNG unsupported');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color];
  if (!channels) throw new Error(`unsupported colour type ${color}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const row = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prior ? prior[x] : 0;
      const c = prior && x >= channels ? prior[x - channels] : 0;
      let v = row[x];
      switch (filter) {
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, channels, data: out };
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

function analyse(file) {
  const { w, h, channels, data } = decodePng(fs.readFileSync(file));
  const n = w * h;
  const hist = new Uint32Array(256);
  let clipped = 0, crushed = 0, sumR = 0, sumG = 0, sumB = 0, sumL = 0, sumSat = 0;
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    hist[Math.round(lum)]++;
    if (r >= 253 && g >= 253 && b >= 253) clipped++;
    if (lum <= 3) crushed++;
    sumR += r; sumG += g; sumB += b; sumL += lum;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    sumSat += mx === 0 ? 0 : (mx - mn) / mx;
  }
  const pct = (t) => {
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= n * t) return i;
    }
    return 255;
  };
  const meanR = sumR / n, meanG = sumG / n, meanB = sumB / n;
  return {
    file,
    size: `${w}x${h}`,
    meanLuma: +(sumL / n).toFixed(1),
    p01: pct(0.01), p10: pct(0.1), median: pct(0.5), p90: pct(0.9), p99: pct(0.99),
    clippedPct: +((clipped / n) * 100).toFixed(3),
    crushedPct: +((crushed / n) * 100).toFixed(3),
    meanRGB: [+meanR.toFixed(1), +meanG.toFixed(1), +meanB.toFixed(1)],
    // >1 means the frame leans warm/sepia, <1 means it leans cool. Daylight interiors with warm
    // bounce land around 1.05-1.20; anything past ~1.35 reads as an amber filter.
    warmth: +(meanR / Math.max(1, meanB)).toFixed(3),
    meanSaturation: +(sumSat / n).toFixed(3),
    dynamicRange: pct(0.99) - pct(0.01),
  };
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('usage: node tools/histogram.mjs <file.png> [more.png] [--json]');
  process.exit(2);
}

const rows = files.map((f) => {
  try {
    return analyse(f);
  } catch (e) {
    return { file: f, error: e.message };
  }
});

if (json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const r of rows) {
    if (r.error) {
      console.log(`${r.file}: ERROR ${r.error}`);
      continue;
    }
    console.log(`\n${r.file}  ${r.size}`);
    console.log(`  luminance   mean ${r.meanLuma}   p1 ${r.p01}  p10 ${r.p10}  median ${r.median}  p90 ${r.p90}  p99 ${r.p99}   (range ${r.dynamicRange})`);
    console.log(`  clipped     ${r.clippedPct}% pure white   crushed ${r.crushedPct}% pure black`);
    console.log(`  colour      mean RGB ${r.meanRGB.join(' / ')}   warmth R:B ${r.warmth}   saturation ${r.meanSaturation}`);
    const notes = [];
    if (r.clippedPct > 0.5) notes.push(`OVEREXPOSED — ${r.clippedPct}% of the frame is pure white, target is under 0.5%`);
    if (r.crushedPct > 2) notes.push(`CRUSHED — ${r.crushedPct}% is pure black, detail is being lost in shadow`);
    if (r.warmth > 1.35) notes.push(`SEPIA — R:B of ${r.warmth} means the whole frame is amber; a daylight interior wants ~1.05-1.20`);
    if (r.warmth < 0.92) notes.push(`COLD — R:B of ${r.warmth}, the frame has lost its warm bounce`);
    if (r.dynamicRange < 90) notes.push(`FLAT — only ${r.dynamicRange} levels between p1 and p99, the image has no contrast`);
    if (r.median > 200) notes.push(`the median pixel is ${r.median} — the frame is mostly highlight, which almost always means overexposure`);
    for (const nn of notes) console.log(`  ⚠ ${nn}`);
    if (!notes.length) console.log(`  ✓ no obvious exposure or balance problems`);
  }
}
