// LIGHT · widening three's soft shadow filter.
//
// The problem. `THREE.PCFSoftShadowMap` is a fixed nine-tap bilinear tent spanning two texels and
// it deliberately ignores `shadow.radius`. With a shadow camera fitted tightly to a 7 × 8 m room
// and a 2048² map, one texel is 5.4 mm, so every shadow edge in the game is a 1 cm penumbra —
// pin-sharp. That is correct for a laser and wrong for a winter sun coming through sheer curtains,
// where the penumbra under the ottoman should be several centimetres and grow with distance.
//
// The fix. Swap that one branch of `ShaderChunk.shadowmap_pars_fragment` for a rotated Poisson
// disc scaled by `shadowRadius`, rotated per pixel by an interleaved-gradient hash so the residual
// undersampling reads as fine noise (which the film grain then eats) instead of as banding.
//
// The tap count is the actual cost knob here — a paired A/B profile (tools/perf.mjs) found that
// disabling shadows outright saves ~18 ms of a ~34 ms frame at `high`, while merely freezing the
// shadow-map *rasterisation* saves ~1.1–1.4 ms. Almost the entire cost is these texture2DCompare
// calls in the fragment shader, times full-screen, times the overdraw from this room's transparent
// surfaces (sheers, playpen mesh, glass table). So `installSoftShadows(taps)` is parameterised by
// tier: `ultra` gets the full 12-tap disc, everything else that still calls it (only `high` — see
// lighting.js) gets an 8-tap disc. The per-pixel rotation is kept at every tap count: it is what
// turns undersampling into fine noise instead of banding, and it must stay a pure function of
// `gl_FragCoord` (no time/frame term) so photo mode stays deterministic per CONTRACTS §7.
//
// This is a global patch to a shared shader chunk, so it is written defensively: it only fires if
// both anchors match exactly, it can only be applied once (first caller's tap count wins for the
// session), and `restore()` puts the original string back. Materials compile lazily on first
// render and LIGHT is constructed before the world is built, so every shadow receiver in the game
// picks the patched version up.

import * as THREE from 'three';

const CHUNK = 'shadowmap_pars_fragment';
const ANCHOR_START = '#elif defined( SHADOWMAP_TYPE_PCF_SOFT )';
const ANCHOR_END = '#elif defined( SHADOWMAP_TYPE_VSM )';

// A twelve-point Poisson disc on the unit circle — minimum-distance sampled, so no tap clumps.
// Used at `ultra`.
const DISC_12 = [
  [-0.326, -0.406], [-0.840, -0.074], [-0.696, 0.457], [-0.203, 0.621],
  [0.962, -0.195], [0.473, -0.480], [0.519, 0.767], [0.185, -0.893],
  [0.507, 0.064], [0.896, 0.412], [-0.322, -0.933], [-0.792, -0.598],
];

// An eight-point disc, hand-placed 45° apart in angle with a jittered radius (0.55–0.95) so it
// doesn't read as a regular octagon. Two-thirds the taps of DISC_12 for the same fragment-shader
// shape, used at `high` where the sampling cost is the dominant frame expense.
const DISC_8 = [
  [0.531, 0.142], [0.460, 0.797], [-0.160, 0.599], [-0.736, 0.425],
  [-0.560, -0.150], [-0.475, -0.823], [0.168, -0.628], [0.762, -0.440],
];

function buildReplacement(disc) {
  return `#elif defined( SHADOWMAP_TYPE_PCF_SOFT )

			// OPERATION NAPTIME · LIGHT — a Poisson PCF wide enough to read as a real penumbra.
			vec2 napTexel = vec2( 1.0 ) / shadowMapSize;
			float napIgn = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
			float napAng = napIgn * 6.28318530718;
			float napCos = cos( napAng );
			float napSin = sin( napAng );
			vec2 napScale = napTexel * max( shadowRadius, 1.0 );
			shadow = 0.0;
			#define NAP_TAP( ox, oy ) shadow += texture2DCompare( shadowMap, shadowCoord.xy + vec2( ox * napCos - oy * napSin, ox * napSin + oy * napCos ) * napScale, shadowCoord.z );
${disc.map(([x, y]) => `			NAP_TAP( ${x.toFixed(3)}, ${y.toFixed(3)} )`).join('\n')}
			#undef NAP_TAP
			shadow *= ( 1.0 / ${disc.length}.0 );

		`;
}

let original = null;
let installedTaps = 0;

/**
 * Install the wide-penumbra filter with `taps` samples (12 → the full disc, anything less → the
 * 8-tap disc — there are only two authored discs, picked by the caller's tier). Safe to call more
 * than once; returns true if the chunk is currently patched. `taps` defaults to 12 to preserve the
 * old zero-arg behaviour for any caller that hasn't been updated.
 */
export function installSoftShadows(taps = 12) {
  if (original !== null) return true;
  const src = THREE.ShaderChunk[CHUNK];
  if (typeof src !== 'string') return false;
  const i = src.indexOf(ANCHOR_START);
  const j = i < 0 ? -1 : src.indexOf(ANCHOR_END, i);
  if (i < 0 || j < 0) {
    console.warn('[light] three\'s PCF_SOFT branch has moved — falling back to the stock filter.');
    return false;
  }
  const disc = taps >= 10 ? DISC_12 : DISC_8;
  original = src;
  installedTaps = disc.length;
  THREE.ShaderChunk[CHUNK] = src.slice(0, i) + buildReplacement(disc) + src.slice(j);
  return true;
}

/** How many taps are actually installed right now (0 if unpatched). Mostly for `?stats=1`. */
export function currentTapCount() {
  return installedTaps;
}

/** Put three's own shader chunk back. */
export function restoreSoftShadows() {
  if (original === null) return;
  THREE.ShaderChunk[CHUNK] = original;
  original = null;
  installedTaps = 0;
}
