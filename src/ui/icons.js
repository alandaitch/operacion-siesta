// UI · the icon set. Twenty-two glyphs, all drawn on the same 24-unit grid with the same
// 1.55-unit stroke and round joins, because a mixed-weight icon set is the fastest way to make an
// interface look assembled rather than designed.
//
// They are stroke-only and inherit `currentColor`, so a chip, a toast and a results row can share
// one glyph and still tint independently. No fills except where a glyph needs a solid dot.

import { svgEl } from './dom.js';

const P = (d, extra) => ['path', { d, ...(extra || {}) }];
const C = (cx, cy, r, extra) => ['circle', { cx, cy, r, ...(extra || {}) }];
const DOT = (cx, cy, r) => ['circle', { cx, cy, r, fill: 'currentColor', stroke: 'none' }];

/** name → array of node specs. */
const ICONS = {
  // a vase going over, with the arc of the fall behind it
  knockable: [
    ['g', { transform: 'rotate(-24 12 14)' }, [
      P('M10.2 5h3.6v2.9c1.9 1 3 2.9 3 5 0 3-2.2 5.1-4.8 5.1S7.2 15.9 7.2 12.9c0-2.1 1.1-4 3-5z'),
      P('M10.2 5h3.6'),
    ]],
    P('M17.6 4.6a8.4 8.4 0 0 1 2.3 4.6', { opacity: 0.45 }),
  ],
  // pulled toward you: a handle and a shortening line
  pullable: [
    P('M19 5.5v13'),
    P('M15.4 12H4.6'),
    P('M8.6 8.2 4.6 12l4 3.8'),
  ],
  // the classic bitten disc
  edible: [
    P('M20.4 10.6A9 9 0 1 1 13.4 3.6a3.3 3.3 0 0 0 3.5 3.5 3.3 3.3 0 0 0 3.5 3.5z'),
    DOT(9.4, 10.4, 1.05),
    DOT(12.6, 14.6, 1.05),
    DOT(8, 15.2, 0.85),
  ],
  hazard: [
    P('M12 3.4 21.6 20.2H2.4z'),
    P('M12 9.6v4.6'),
    DOT(12, 17.3, 1.05),
  ],
  fragile: [
    C(12, 12, 8.6),
    P('M12.6 3.6 9.9 10l3.9 1.4-3 9'),
  ],
  scenery: [
    P('M4 8.6 12 4l8 4.6v7L12 20l-8-4.4z'),
    P('M12 12v8'),
    P('M4 8.6 12 12l8-3.4', { opacity: 0.5 }),
  ],
  objective: [
    C(12, 12, 8.6),
    C(12, 12, 4.2),
    DOT(12, 12, 1.4),
  ],
  new: [
    P('M12 2.8 14 8.9l6.1 2.1-6.1 2.1-2 6.1-2-6.1L3.9 11 10 8.9z'),
    P('M19.2 3.4v3.2M17.6 5h3.2', { opacity: 0.55 }),
  ],
  zone: [
    P('M3.4 5.4h17.2v13.2H3.4z'),
    P('M3.4 11.4h6.6v7.2', { opacity: 0.55 }),
    P('M14 5.4v6h6.6', { opacity: 0.55 }),
  ],
  variety: [
    C(6.4, 8, 3),
    P('M14.4 4.9h5.6v5.6h-5.6z'),
    P('M12 13.4 16.6 21H7.4z'),
  ],
  nap: [
    P('M20.2 14.6A8.4 8.4 0 0 1 9.4 3.8 8.4 8.4 0 1 0 20.2 14.6z'),
    P('M14.6 3.6h3.8l-3.8 4h3.8', { opacity: 0.55 }),
  ],
  spit: [
    P('M12 3.4c3.5 4.2 5.4 6.9 5.4 9.3a5.4 5.4 0 1 1-10.8 0c0-2.4 1.9-5.1 5.4-9.3z'),
    P('M9.4 13.6a2.6 2.6 0 0 0 2.6 2.6', { opacity: 0.6 }),
  ],
  pendant: [
    P('M12 2.6v5.2'),
    P('M9.2 12.4a2.8 2.8 0 1 1 5.6 0c0 1.4-.9 2-1.3 2.9l-.3 1h-2.4l-.3-1c-.4-.9-1.3-1.5-1.3-2.9z'),
    P('M10.8 18.4h2.4M10.6 20.4h2.8'),
  ],
  combo: [
    P('M13.2 2.6 4.8 13.8h5.6L9.6 21.4 18.4 10h-5.8z'),
  ],
  crayon: [
    P('M5.4 18.6 15.2 8.8l3 3-9.8 9.8H5.4z'),
    P('M15.2 8.8 17 5.2l2 .8.8 2-3.6 1.8z'),
  ],
  coin: [
    C(12, 12, 8.4),
    C(12, 12, 5),
    P('M12 8.6v6.8', { opacity: 0.6 }),
  ],
  pacifier: [
    C(12, 15.8, 4.4),
    P('M9.6 9.4h4.8v2.2H9.6z'),
    C(12, 6.6, 3),
  ],
  snack: [
    P('M6.6 7.6h10.8l-1.1 12.2H7.7z'),
    P('M6.6 7.6 5.2 4.4l3 1.4 1.6-1.6 1.6 1.6 1.6-1.6 1.6 1.6 3-1.4-1.4 3.2'),
  ],
  clock: [
    C(12, 12, 8.6),
    P('M12 7.2V12l3.2 2'),
  ],
  distance: [
    P('M4.6 19.2h9.8a4 4 0 0 0 0-8H9.6a3.4 3.4 0 0 1 0-6.8h9.8'),
    DOT(4.6, 19.2, 1.5),
    DOT(19.4, 4.4, 1.5),
  ],
  trophy: [
    P('M7.6 3.8h8.8v5a4.4 4.4 0 0 1-8.8 0z'),
    P('M7.6 5.2H4.8v1.6a3 3 0 0 0 3 3M16.4 5.2h2.8v1.6a3 3 0 0 1-3 3'),
    P('M12 13.2v3.6M8.6 20.2h6.8l-.8-3.4H9.4z'),
  ],
  ledge: [
    P('M3.6 19h6.8v-5h6.6V9h3.4'),
    P('M6.4 15.2 3.6 19l3.8 1', { opacity: 0.55 }),
  ],
};

/** A 24×24 stroke icon that inherits colour. Returns a detached SVGElement. */
export function icon(name, cls) {
  const spec = ICONS[name] || ICONS.scenery;
  return svgEl(`svg${cls ? `.${cls}` : ''}`, {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.55,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  }, build(spec));
}

function build(spec) {
  const out = [];
  for (let i = 0; i < spec.length; i++) {
    const [tag, attrs, kids] = spec[i];
    out.push(svgEl(tag, attrs, kids ? build(kids) : null));
  }
  return out;
}

export function hasIcon(name) {
  return Object.prototype.hasOwnProperty.call(ICONS, name);
}

/** Toast/score-popup icon names arrive from other modules as free strings; map them onto the set. */
const ALIAS = {
  eat: 'edible',
  edible: 'edible',
  push: 'knockable',
  pull: 'pullable',
  chain: 'combo',
  crayon: 'crayon',
  coin: 'coin',
  pacifier: 'pacifier',
  snack: 'snack',
  spit: 'spit',
  nap: 'nap',
  zone: 'zone',
  variety: 'variety',
  new: 'new',
  objective: 'objective',
  pendant: 'pendant',
  hazard: 'hazard',
  fragile: 'fragile',
  knockable: 'knockable',
  pullable: 'pullable',
  scenery: 'scenery',
  ledge: 'ledge',
};

export function resolveIcon(name) {
  if (!name) return 'objective';
  return ALIAS[name] || (hasIcon(name) ? name : 'objective');
}
