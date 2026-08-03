// Seeded, deterministic randomness.
// The entire room is procedurally generated; if it used Math.random() the screenshots taken by
// the automated art-review harness would differ every run and "did this get better?" would be
// unanswerable. mulberry32 is fast, has a decent period for our purposes, and is 4 lines.

export function makeRng(seed = 0x5eed1e) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The global room seed. Everything built at load time draws from this. */
export const rng = makeRng(0x0ca11ed);

/** Uniform in [min,max). */
export const rand = (min, max, r = rng) => min + (max - min) * r();
/** Integer in [min,max]. */
export const randInt = (min, max, r = rng) => Math.floor(min + (max - min + 1) * r());
/** Pick one. */
export const pick = (arr, r = rng) => arr[Math.floor(r() * arr.length) % arr.length];
/** Symmetric jitter around 0. */
export const jitter = (amount, r = rng) => (r() * 2 - 1) * amount;
/** Gaussian-ish via sum of uniforms (Irwin–Hall, n=3), mean 0, ~unit-ish spread. */
export const gauss = (r = rng) => (r() + r() + r() - 1.5) * 1.1547;
