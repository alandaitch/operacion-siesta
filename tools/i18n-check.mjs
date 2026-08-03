// tools/i18n-check.mjs — static i18n coverage checker (added by the UI agent, CONTRACTS §12).
//
// Not a JS parser — a pragmatic pass over source text that finds every user-visible string key
// actually used by the game and diffs it against src/i18n/strings.js, in both languages. Two
// kinds of reference:
//
//  1. LITERAL keys: any single-quoted string of the form "<category>.<rest>" (category is one of
//     the CONTRACTS §12 prefixes) appearing anywhere in src/, however it is used — i18n.t('x'),
//     T(node, 'x'), { key: 'x' }, subtitle('x'), cancelEat('x'), a plain lookup table entry. This
//     catches almost everything by construction, because nothing else in this codebase names
//     things "category.thing" with a dot — except three files that reuse the same short prefixes
//     ("ui", "parent") for an unrelated namespace (AUDIO's internal SFX-shot registry, and the
//     parent rig's per-part material-cache prefix in ai/parent/body.js). Those are excluded by
//     name below; nothing else collides (verified by hand while writing this script).
//  2. DERIVED prop labels: `ctx.props.register(spec)` (src/core/context.js) falls back to
//     `prop.<id>` whenever a caller omits `labelKey` entirely. FURN's local `register()` helper
//     in src/world/furniture.js relies on exactly that fallback for several props (this is what
//     produced the original "unknown key prop.playpen-door" bug). So every `id: 'x'` inside a
//     prop registration call implies a `prop.x` reference, unless that same call supplies a
//     literal `labelKey` (which wins) or a self-referential template like `prop.${spec.id}`
//     (same result as the fallback).
//
// A handful of keys are assembled from a genuinely runtime value (a quality tier, a verb id, a
// difficulty id) that no static scan can enumerate; those are pinned by hand below so a rename
// still trips this script.
//
// Exit 0 and print a summary when every referenced key exists in both `en` and `es`. Exit 1 and
// list every problem otherwise. Also warns (non-fatal) about STRINGS keys nobody references.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { STRINGS } from '../src/i18n/strings.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, '..', 'src');
const EXCLUDE = new Set(
  ['audio/audio.js', 'audio/sfx.js', 'ai/parent/body.js', 'i18n/strings.js'].map((p) => path.join(SRC, p)),
);
const PREFIX = '(?:ui|prop|verb|toast|parent|end|tut|obj|zone|status|sub|game)';
const LITERAL_RE = new RegExp(`'(${PREFIX}\\.[a-zA-Z0-9_.]+)'`, 'g');
const REGISTER_RE = /(?:\bregister|(?:D\.)?ctx\.props\.register|D\.prop|\bprops\.push)\(\s*\{/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** From text[open] === '{', return the substring up to its matching '}'. */
function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

const refs = new Map(); // key -> Set<relative file path>
const add = (key, file) => {
  if (!refs.has(key)) refs.set(key, new Set());
  refs.get(key).add(file);
};

for (const file of walk(SRC)) {
  if (EXCLUDE.has(file)) continue;
  const text = readFileSync(file, 'utf8');
  const rel = path.relative(SRC, file);
  let m;

  LITERAL_RE.lastIndex = 0;
  while ((m = LITERAL_RE.exec(text))) add(m[1], rel);

  REGISTER_RE.lastIndex = 0;
  while ((m = REGISTER_RE.exec(text))) {
    const braceStart = text.indexOf('{', m.index);
    if (braceStart < 0) continue;
    const block = matchBrace(text, braceStart);
    const idM = block.match(/\bid\s*:\s*'([a-zA-Z0-9_-]+)'/);
    if (!idM) continue; // not a real prop spec (e.g. the register() helper's own definition)
    const litM = block.match(/\blabelKey\s*:\s*'([a-zA-Z0-9_.]+)'/);
    const selfTemplate = /\blabelKey\s*:\s*`prop\.\$\{[a-zA-Z0-9_.]*id\}`/.test(block);
    const key = litM ? litM[1]
      : (selfTemplate || !block.includes('labelKey')) ? `prop.${idM[1]}` : null;
    if (key) add(key, rel);
  }
}

for (const k of [
  'ui.set.quality.low', 'ui.set.quality.medium', 'ui.set.quality.high', 'ui.set.quality.ultra',
  'verb.push', 'verb.pull', 'verb.eat', 'verb.climb', 'verb.none',
  'ui.menu.diff.gentle.note', 'ui.menu.diff.standard.note', 'ui.menu.diff.feral.note',
  'end.title.caught', 'end.title.timeup', 'end.sub.caught', 'end.sub.timeup',
  'end.cat.knockable', 'end.cat.pullable', 'end.cat.edible', 'end.cat.hazard', 'end.cat.fragile',
  // toys.js resolves its labelKey through a kind→label ternary this script does not evaluate.
  'prop.bunny', 'prop.teddy', 'prop.mouse', 'prop.giraffe', 'prop.rattle',
]) add(k, '(hand-verified: built from a runtime value, see header comment)');

let problems = 0;
for (const [key, files] of [...refs].sort((a, b) => a[0].localeCompare(b[0]))) {
  const missing = [!(key in STRINGS.en) && 'en', !(key in STRINGS.es) && 'es'].filter(Boolean);
  if (missing.length) {
    problems++;
    console.error(`missing in ${missing.join(', ')}: ${key}  (${[...files].join(', ')})`);
  }
}

const allDefined = new Set([...Object.keys(STRINGS.en), ...Object.keys(STRINGS.es)]);
const unused = [...allDefined].filter((k) => !refs.has(k)).sort();
if (unused.length) {
  console.warn(`\n${unused.length} key(s) defined but never referenced (informational, not fatal):`);
  for (const k of unused) console.warn(`  ${k}`);
}

if (problems) {
  console.error(`\n${problems} i18n problem(s) found.`);
  process.exit(1);
}
console.log(`\ni18n check OK — ${refs.size} keys referenced, all present in en and es.`);
