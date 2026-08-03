export const meta = {
  name: 'naptime-art-review',
  description: 'One ruthless art critic per rendered element, plus blind A/B against the previous round',
  phases: [
    { title: 'Critique', detail: 'a dedicated reviewer per element, scored against shipped AAA titles' },
    { title: 'Blind A/B', detail: 'randomised side-by-side, provenance hidden' },
  ],
}

// Repo-relative by default; pass args.root to point it somewhere else.
const ROOT = (typeof args === 'object' && args && args.root) || '.'

// `args` normally arrives as a real object, but tolerate a JSON string: getting this wrong silently
// falls back to the defaults and runs zero agents, which looks like success and is not.
const A = typeof args === 'string' ? JSON.parse(args) : args || {}
if (!A.shots || !A.shots.length) throw new Error('wf-review needs args.shots — got ' + JSON.stringify(args).slice(0, 200))

const round = A.round || 'r01'
const prev = A.prev || null
const shots = A.shots
const compareDir = A.compareDir || null
const compareShots = A.compareShots || []

const SCORE = {
  type: 'object',
  additionalProperties: false,
  required: ['shot', 'verdict', 'scores', 'fixes'],
  properties: {
    shot: { type: 'string' },
    verdict: { enum: ['AAA', 'CLOSE', 'NOT_AAA'] },
    overall: { type: 'number' },
    scores: {
      type: 'object',
      additionalProperties: false,
      required: ['silhouette', 'materials', 'lighting', 'composition', 'detail', 'grade', 'believability'],
      properties: {
        silhouette: { type: 'number' },
        materials: { type: 'number' },
        lighting: { type: 'number' },
        composition: { type: 'number' },
        detail: { type: 'number' },
        grade: { type: 'number' },
        believability: { type: 'number' },
      },
    },
    whatWorks: { type: 'string' },
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['module', 'problem', 'fix', 'severity'],
        properties: {
          module: {
            enum: ['RENDER', 'TEX', 'MAT', 'PHYS', 'ROOM', 'FURN', 'DRESS', 'LIGHT', 'BABY', 'AI', 'GAME', 'AUDIO', 'FX', 'UI'],
          },
          problem: { type: 'string' },
          fix: { type: 'string', description: 'specific and actionable in code' },
          severity: { enum: ['blocker', 'major', 'minor'] },
        },
      },
    },
    brokenOrMissing: { type: 'string', description: 'anything that looks like a bug rather than a taste issue' },
  },
}

const AB = {
  type: 'object',
  additionalProperties: false,
  required: ['shot', 'better', 'confidence', 'reasoning'],
  properties: {
    shot: { type: 'string' },
    better: { enum: ['LEFT', 'RIGHT', 'EQUIVALENT'] },
    confidence: { enum: ['low', 'medium', 'high'] },
    margin: { type: 'string', description: 'how much better, in plain words' },
    reasoning: { type: 'string' },
    regressions: { type: 'string', description: 'anything the weaker frame does BETTER, so we do not lose it' },
  },
}

phase('Critique')

const critiques = await parallel(
  shots.map((shot) => () =>
    agent(
      `You are the dedicated art reviewer for ONE element of a real-time game frame. Your element: "${shot}".

FIRST read ${ROOT}/REVIEW.md — it defines the standard and the scoring. Then read
${ROOT}/REFERENCE.md, which describes the real photograph the room is modelled from, so you can
judge fidelity as well as craft. ${ROOT}/CONTRACTS.md §8 has the art-direction bible and §3 the
module map (you must attribute every fix to the module that owns it).

Then LOOK at the image: ${ROOT}/shots/${round}/${shot}.png
Read it with the Read tool. Study it properly — zoom your attention into the corners, the material
transitions, the shadow terminators, the silhouette edges.

You may also read the source of the module that owns what you are looking at (everything is under
${ROOT}/src/) to make your fixes concrete and correctly targeted. Do NOT edit any file — you are
a reviewer this round.

Judge it against shipped AAA titles, not against "good for a browser". Be ruthless. If it would
not survive in a trailer for a game that cost $100M, say NOT_AAA and explain exactly why in terms
a programmer can act on. Score all seven axes. Give at most five fixes, ordered by leverage, each
assigned to the owning module, each specific enough to implement without asking you a question.

If the image is black, empty, obviously broken, or missing the thing it is supposed to show, say
so loudly in brokenOrMissing — that is a bug report, not an art note, and it outranks everything.`,
      { label: `review:${shot}`, phase: 'Critique', schema: SCORE }
    )
  )
)

const valid = critiques.filter(Boolean)
const notAAA = valid.filter((c) => c.verdict !== 'AAA')
log(`Critique: ${valid.length} elements reviewed — ${valid.filter((c) => c.verdict === 'AAA').length} AAA, ${valid.filter((c) => c.verdict === 'CLOSE').length} close, ${valid.filter((c) => c.verdict === 'NOT_AAA').length} not there yet`)

// COUNTERBALANCED A/B. Each pair is judged twice — once on `<shot>.png` and once on
// `<shot>.rev.png`, which is the same two frames in the opposite order — by two independent
// agents that never see each other's answer. A preference counts only if the two judgements pick
// the same ROUND, i.e. opposite SIDES. Two judgements that pick the same side are the judge's
// position bias and are discarded.
//
// This is not theoretical caution. The uncounterbalanced r01-vs-r06 run returned RIGHT in 14 of
// 15 pairs against a key that had the newer round on the right only 6 times (p ~= 0.001), so its
// headline result — "the two rounds are equivalent" — was an artefact of ordering and nothing
// else. Anything that reports an A/B without this is reporting noise.
let ab = []
if (compareDir && compareShots.length) {
  phase('Blind A/B')
  const pairs = compareShots.flatMap((shot) => [shot, `${shot}.rev`])
  ab = (
    await parallel(
      pairs.map((shot) => () =>
        agent(
          `You are judging a blind A/B of two renders of the same scene, framing "${shot}".

Read ${ROOT}/REVIEW.md first (see especially "The blind pairs"). Then look at the composite:
${ROOT}/compare/${compareDir}/${shot}.png

It contains two frames side by side, labelled only LEFT and RIGHT. You are NOT told which is
which, the order was randomised independently per shot, and there is no pattern to infer. One may
be older, one may be newer, or they may be from different approaches entirely — it does not
matter. Judge only what you see.

Say which frame is better and why, on the axes in REVIEW.md. Be specific about the differences
you can actually point at — "the LEFT frame has a visible sheen band raking across the floor
where RIGHT is a flat wash" — not vague preference. Then, importantly, list anything the WEAKER
frame does better, so that improvement is not thrown away.

If they are genuinely equivalent, say EQUIVALENT. Do not manufacture a difference.`,
          { label: `ab:${shot}`, phase: 'Blind A/B', schema: AB }
        )
      )
    )
  )
  log(`Blind A/B: ${ab.filter(Boolean).length} judgements over ${compareShots.length} pairs (each judged in both orders)`)

  // Fold the two orderings together. `better` is still a SIDE — the workflow is deliberately
  // blind to which round that is — so all we can determine here is whether the pair of
  // judgements is CONSISTENT (opposite sides ⇒ they agree on a frame) or POSITION-BIASED (same
  // side ⇒ the judge just preferred where it sat). Decoding to a round needs the answer key,
  // which lives outside this workflow on purpose.
  // Pair by INDEX, not by the agent-returned `shot` field. `pairs` was built as
  // [a, a.rev, b, b.rev, ...] and parallel() preserves order (a dead agent is a null in place),
  // so index 2i and 2i+1 are the two orderings of compareShots[i]. Keying off `shot` would be
  // fragile: the schema lets an agent put anything in that string, and the critique agents in
  // this same workflow routinely return a whole paragraph there instead of the bare name.
  const paired = compareShots.map((shot, i) => {
    const fwd = ab[i * 2]
    const rev = ab[i * 2 + 1]
    if (!fwd || !rev) return { shot, status: 'incomplete' }
    if (fwd.better === 'EQUIVALENT' && rev.better === 'EQUIVALENT') return { shot, status: 'equivalent' }
    if (fwd.better === 'EQUIVALENT' || rev.better === 'EQUIVALENT') return { shot, status: 'weak', fwd: fwd.better, rev: rev.better }
    if (fwd.better !== rev.better) {
      return { shot, status: 'consistent', prefers: fwd.better, confidence: fwd.confidence, reasoning: fwd.reasoning }
    }
    return { shot, status: 'position-biased', side: fwd.better }
  })
  const consistent = paired.filter((p) => p.status === 'consistent').length
  const biased = paired.filter((p) => p.status === 'position-biased').length
  log(`A/B after counterbalancing: ${consistent} consistent, ${biased} discarded as position bias, ${paired.length - consistent - biased} equivalent/weak`)
  ab = { judgements: ab.filter(Boolean), paired, consistent, discardedForPositionBias: biased }
}

const fixes = valid.flatMap((c) => (c.fixes || []).map((f) => ({ ...f, shot: c.shot })))
const byModule = {}
for (const f of fixes) (byModule[f.module] ||= []).push(f)

return {
  round,
  prev,
  verdicts: valid.map((c) => ({ shot: c.shot, verdict: c.verdict, overall: c.overall, scores: c.scores })),
  broken: valid.filter((c) => c.brokenOrMissing && c.brokenOrMissing.trim().length > 3)
    .map((c) => ({ shot: c.shot, issue: c.brokenOrMissing })),
  notAAA: notAAA.map((c) => c.shot),
  fixesByModule: byModule,
  fixCount: fixes.length,
  blockers: fixes.filter((f) => f.severity === 'blocker'),
  ab,
}
