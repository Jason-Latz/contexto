// Phase 1/2 mega-workflow: gold-gated LLM adjudication over the audit queue (fix wrong
// entries) and the mint queue (new multi-source-verified words), applied per language
// with all invariants enforced, gates run at the end. Launch with:
//   Workflow({ scriptPath: "docs/overnight-2026-07-12/phase1-adjudication.workflow.js" })
// Re-launch the same file for subsequent runs: the Queues stage excludes already-
// adjudicated keys, so each run continues from the high-water mark.
export const meta = {
  name: 'vocab-phase1-adjudicate',
  description: 'Gold-gated adjudication: audit existing pack entries + mint new verified words, apply + gates',
  phases: [
    { title: 'Queues', detail: 'build enriched audit/mint/gold queues + apply tooling', model: 'sonnet' },
    { title: 'GoldGate', detail: 'engine must beat gold (falseKeep<2%, falseChange<2%) before anything ships', model: 'sonnet' },
    { title: 'Adjudicate', detail: 'proposer -> refuter -> opus fixup, interleaved audit+mint batches', model: 'sonnet' },
    { title: 'Apply', detail: 'per-language apply with invariants, then full gate run', model: 'sonnet' },
  ],
}

const REPO = '/Users/jason/Downloads/CS Classes/Projects/Textum'
const BATCH = 45
const MAX_BATCHES = 340 // ~2.3 agents/batch keeps a run under the 1000-agent cap
const LANGS = ['de', 'fr', 'it', 'es']

const COMMON = `Repo: ${REPO}. python3 available. Do NOT git commit. Language packs under public/language-packs/ may ONLY be modified by pipeline/analysis/apply_verdicts.py (Apply stage); every other agent treats them as READ-ONLY. Scripts live in pipeline/analysis/, data in pipeline/data/. Your final message is machine-read — return the structured output only.`

const RULES = `NON-NEGOTIABLE RULES:
- You never invent a translation. A retarget/mint target must be one of the candidate targets listed IN the queue record (each came from a real dictionary source).
- gender/plural for nouns come ONLY from the morph fields in the queue record (wikidata/wiktextract authority). If a noun's chosen target has no authoritative gender+plural in the record, verdict must be "gate" (audit) or "skip" (mint) — never guess morphology.
- Prefer gate/skip over any verdict you are not confident in. A wrong word taught is worse than no word.
- Teachability: gate/skip proper nouns, abbreviations, multiword junk, vulgar-only glosses, and non-noun targets spelled identically to the English source (they teach nothing; nouns are exempt — articles differ).`

const QCOUNTS = {
  type: 'object', required: ['ok', 'counts', 'goldBatches', 'notes'],
  properties: { ok: { type: 'boolean' }, counts: { type: 'object' }, goldBatches: { type: 'number' }, notes: { type: 'string' } },
}
const SIMPLE = {
  type: 'object', required: ['ok', 'notes'],
  properties: { ok: { type: 'boolean' }, notes: { type: 'string' } },
}
const BCOUNT = {
  type: 'object', required: ['keep', 'change', 'gate', 'disputed'],
  properties: { keep: { type: 'number' }, change: { type: 'number' }, gate: { type: 'number' }, disputed: { type: 'number' } },
}
const GOLDM = {
  type: 'object', required: ['ok', 'falseKeepRate', 'falseChangeRate', 'agreement', 'n', 'notes'],
  properties: { ok: { type: 'boolean' }, falseKeepRate: { type: 'number' }, falseChangeRate: { type: 'number' }, agreement: { type: 'number' }, n: { type: 'number' }, notes: { type: 'string' } },
}
const APPLYR = {
  type: 'object', required: ['ok', 'applied', 'skipped', 'notes'],
  properties: { ok: { type: 'boolean' }, applied: { type: 'number' }, skipped: { type: 'number' }, notes: { type: 'string' } },
}

// ---------- Stage 0: queues + tooling ----------
phase('Queues')
log('Building enriched audit/mint/gold queues + apply tooling')

const [auditQ, mintQ, tooling] = await parallel([
  () => agent(`${COMMON}
Write/refresh pipeline/analysis/build_audit_queue.py and run it. Purpose: an ENRICHED, PRIORITIZED queue of existing pack entries for LLM adjudication.
Inputs: pipeline/data/evidence/{lang}-evidence.jsonl (buckets+votes), packs (read-only), pipeline/data/en-tr-cache.jsonl, slim wikt caches pipeline/data/wikt-cache/slim-{de,fr,it}.jsonl (and es glosses from pipeline/data/kaikki.jsonl or the freedict_aligned/wiktionary_extracted data — use what exists), pipeline/data/sources/*.jsonl.
Output pipeline/data/queues/audit-{lang}.jsonl, one enriched record per entry:
{lang,key,source,target,pos,gender,plural,tier,bucket,enZipf,
 entrSenses:[{gloss,containsCurrent:bool}], omw:[{senseRank,gloss,targets[<=6]}]|null,
 currentTargetGlosses:[<=3 target-language glosses of the CURRENT target],
 alternatives:[{target,votes:int,sources:[names],omwBestSenseRank:int|null,glosses:[<=2],morph:{gender,plural,authority}|null}] (<=5, best first),
 morph:{wikidata:{gender,plural}|null,wiktextract:{gender,plural}|null}}
Ordering (process-first priority): rendered-band only (eligible AND (confidence high OR enZipf<5)); buckets flag-* and ambiguous before confirm and no-evidence; within that enZipf DESCENDING (most-seen first); language order de,fr,it,es interleaved is handled by the caller so just emit per-lang files.
RESUME SUPPORT: scan pipeline/data/verdicts/final/ and fixup/ for keys already adjudicated and EXCLUDE them.
ALSO: emit pipeline/data/queues/gold-queue.jsonl — a stratified ~400-row subset of pipeline/data/gold/gold.jsonl records enriched IDENTICALLY (join by lang+source): include ALL fresh de/fr/it/es rows plus a stratified es prior-audit sample covering keep/retarget/gate verdicts; do NOT include the gold verdict in the queue record (blind test) but write the answer key to pipeline/data/queues/gold-answers.jsonl.
Return counts per lang + goldBatches = ceil(goldQueueRows/${BATCH}).`,
    { label: 'queue:audit+gold', phase: 'Queues', model: 'sonnet', schema: QCOUNTS }),
  () => agent(`${COMMON}
Write/refresh pipeline/analysis/build_mint_queue.py and run it. Purpose: an ENRICHED queue of NET-NEW word candidates (words we could teach but don't have).
Inputs: pipeline/data/universe/en-candidates.jsonl (212k missing English lemmas), all pipeline/data/sources/*.jsonl, slim wikt caches, en-tr-cache, packs (read-only, for dedup vs core+tail keys).
A candidate row is (english word, lang) where the word is missing in that lang's core+tail. Attach every candidate target that ANY source proposes, with votes/sources/omwBestSenseRank/glosses/morph exactly like the audit queue's alternatives field. KEEP ONLY candidates where some target has >=2 independent source votes (freedict, apertium, omw, en-tr-cache count as independent; multiple rows from one source count once).
Output pipeline/data/queues/mint-{lang}.jsonl:
{lang,key,source,enZipf,entrSenses:[{gloss,containsAny:bool}],
 alternatives:[{target,votes,sources,omwBestSenseRank,glosses,morph}] (<=5, best first),
 shipTierHint:"tail" if enZipf<5.0 else "core-gap"}
Ordering: enZipf DESCENDING (teach the most useful missing words first). RESUME SUPPORT: exclude keys already in pipeline/data/verdicts/final/ or fixup/ mint files.
Return counts per lang (goldBatches: 0).`,
    { label: 'queue:mint', phase: 'Queues', model: 'sonnet', schema: QCOUNTS }),
  () => agent(`${COMMON}
Write/refresh pipeline/analysis/apply_verdicts.py + a tiny fixture self-test, then run the self-test (do NOT touch the real packs in this stage).
Contract: reads verdict files pipeline/data/verdicts/final/{audit|mint}-{lang}-*.jsonl, with per-line overrides from pipeline/data/verdicts/fixup/ (same basename; fixup wins). Applies to public/language-packs/{lang}.json / {lang}.tail.json:
- audit keep -> no-op. audit gate -> eligible:false. audit retarget -> replace target (+gender/plural from the verdict's morph authority fields) ONLY IF the verdict's newTarget appears in that key's queue-record alternatives (re-read the queue file to enforce provenance) AND (non-noun OR authoritative gender+plural present); else downgrade to gate.
- mint -> new entry. shipTier tail: goes to {lang}.tail.json with confidence:"low", frequencyRank = 1,000,000 + (stable increment continuing from the current max tail rank), enZipf recorded, eligible true, sourceIds naming the real dictionary sources. shipTier core-gap: ONLY if votes were unanimous across >=3 sources AND verdict confidence >=0.9 -> {lang}.json with confidence:"high"; otherwise write to tail if enZipf<5.0, else drop.
- Invariants enforced in-code (fail loudly, skip the row, count it): key==source.lower(), gender in per-language allowed set, standalone target/plural, core/tail key disjointness, tail ranks unique, no duplicate keys, nouns always have gender+plural, non-nouns never do.
- Idempotent: a marker file pipeline/data/verdicts/applied/<basename>.done per fully-applied verdict file; already-marked files are skipped.
Return ok + notes describing the self-test result.`,
    { label: 'tooling:apply', phase: 'Queues', model: 'sonnet', schema: SIMPLE }),
])

if (!auditQ || !auditQ.ok || !mintQ || !mintQ.ok || !tooling || !tooling.ok) {
  log('Queue/tooling stage failed — aborting before any adjudication')
  return { aborted: 'queues', auditQ, mintQ, tooling }
}
log(`Queues ready. audit=${JSON.stringify(auditQ.counts)} mint=${JSON.stringify(mintQ.counts)} goldBatches=${auditQ.goldBatches}`)

// ---------- engine prompt builders ----------
const V_RAW = (kind, lang, i) => `pipeline/data/verdicts/raw/${kind}-${lang}-${i}.jsonl`
const V_FIN = (kind, lang, i) => `pipeline/data/verdicts/final/${kind}-${lang}-${i}.jsonl`
const V_FIX = (kind, lang, i) => `pipeline/data/verdicts/fixup/${kind}-${lang}-${i}.jsonl`
const QFILE = (kind, lang) => kind === 'gold' ? 'pipeline/data/queues/gold-queue.jsonl' : `pipeline/data/queues/${kind}-${lang}.jsonl`

function adjPrompt(kind, lang, i) {
  const lo = i * BATCH + 1, hi = (i + 1) * BATCH
  const mint = kind === 'mint'
  return `${COMMON}
${RULES}
You are the ADJUDICATOR, fluent in ${lang === 'de' ? 'German' : lang === 'fr' ? 'French' : lang === 'it' ? 'Italian' : 'Spanish'} and English. Read lines ${lo}-${hi} of ${QFILE(kind, lang)} (sed -n '${lo},${hi}p'). Each line is one enriched candidate with EVIDENCE: source votes, English sense buckets (entrSenses, with gloss text), OMW sense ranks where present, and target-language dictionary glosses of each candidate target.
For each record decide, using the evidence FIRST and your own fluency second:
${mint
  ? '- verdict "mint" (pick the ONE alternative whose glosses show it teaches the DOMINANT everyday sense of the English word, and which is teachable) or "skip". Set shipTier from shipTierHint but downgrade core-gap to tail (or skip if enZipf>=5) unless the choice is unanimous across sources and obviously right.'
  : '- verdict "keep" (current target teaches the dominant everyday sense; a learner meeting this English word in normal text is taught the right thing), "retarget" (a listed alternative clearly teaches the dominant sense better — set newTarget/newGender/newPlural from that alternative record), or "gate" (no listed candidate cleanly teaches it, or non-teachable).'}
Write one JSON line per record to ${V_RAW(kind, lang, i)} (create dirs): {key, verdict${mint ? ', target, shipTier, gender, plural, morphAuthority' : ', newTarget, newGender, newPlural, morphAuthority'}, pos, confidence:0-1, reason:"<short>"}. Cover EVERY line in your range exactly once. Then return the counts (change = ${mint ? 'mint' : 'retarget'} count, gate = ${mint ? 'skip' : 'gate'} count, disputed = 0).`
}
function refPrompt(kind, lang, i) {
  const lo = i * BATCH + 1, hi = (i + 1) * BATCH
  return `${COMMON}
${RULES}
You are the REFUTER, fluent in ${lang === 'de' ? 'German' : lang === 'fr' ? 'French' : lang === 'it' ? 'Italian' : 'Spanish'} and English. Another model adjudicated lines ${lo}-${hi} of ${QFILE(kind, lang)} into ${V_RAW(kind, lang, i)}. Your job is to PROVE IT WRONG wherever possible.
Re-read the queue lines (sed -n '${lo},${hi}p') alongside its verdicts. Attack: every ${kind === 'mint' ? 'mint' : 'retarget and gate'} verdict, every keep/mint with confidence<0.75, and a ~20% sample of the remaining keeps. For each attacked verdict: does the evidence really support it? Would it teach a wrong or non-dominant sense? Is morphology authority present where required?
Write ${V_FIN(kind, lang, i)}: copy each raw line, adding "refuter":"agree" or "refuter":"dispute" (+ "refuterReason" when disputing; unattacked lines get "refuter":"unreviewed"). Do NOT change verdicts yourself — disputes go to a judge. Return counts with disputed = number of disputes.`
}
function judgePrompt(kind, lang, i) {
  return `${COMMON}
${RULES}
You are the FINAL JUDGE (this decision ships tonight). ${V_FIN(kind, lang, i)} contains verdicts where "refuter":"dispute". For each disputed line, re-read its full queue record from ${QFILE(kind, lang)} (match by key), weigh the adjudicator's verdict against the refuter's objection, and rule. When in doubt: gate/skip.
Write ONLY the disputed lines, with your final ruling in the same verdict format (no refuter field, add "judge":"opus"), to ${V_FIX(kind, lang, i)}. Return counts for your rulings (disputed = lines you ruled on).`
}

// one batch through the full engine; returns compact stats
const runBatch = (kind, lang, i) =>
  agent(adjPrompt(kind, lang, i), { label: `adj:${kind}:${lang}:${i}`, phase: 'Adjudicate', model: 'sonnet', schema: BCOUNT })
    .then((a) => a && agent(refPrompt(kind, lang, i), { label: `ref:${kind}:${lang}:${i}`, phase: 'Adjudicate', model: 'sonnet', schema: BCOUNT }))
    .then((r) => (r && r.disputed > 0)
      ? agent(judgePrompt(kind, lang, i), { label: `judge:${kind}:${lang}:${i}`, phase: 'Adjudicate', model: 'opus', effort: 'high', schema: BCOUNT }).then((j) => ({ kind, lang, i, disputed: r.disputed, judged: j ? j.disputed : 0 }))
      : { kind, lang, i, disputed: 0, judged: 0 })

// ---------- Stage 1: gold gate ----------
phase('GoldGate')
const goldBatches = Math.max(1, auditQ.goldBatches)
log(`Gold gate: running the engine blind over ${goldBatches} gold batches`)
await parallel(Array.from({ length: goldBatches }, (_, i) => () => runBatch('gold', 'mixed', i)))

const comparePrompt = (attempt) => `${COMMON}
Write/refresh pipeline/analysis/compare_gold.py and run it: join the engine's gold verdicts (pipeline/data/verdicts/final/gold-mixed-*.jsonl with fixup overrides from pipeline/data/verdicts/fixup/) against the answer key pipeline/data/queues/gold-answers.jsonl.
Metrics (report per-language AND pooled, with n):
- falseKeepRate: engine says keep where gold says retarget/gate (wrong words we would leave in packs)
- falseChangeRate: engine says retarget/gate where gold says keep (good words we would corrupt/remove)
- agreement: exact verdict match rate
Write pipeline/data/evidence/gold-gate-attempt${attempt}.json + .md with confusion matrix and quoted example failures. Return the pooled metrics.`

let gate = await agent(comparePrompt(1), { label: 'goldgate:compare-1', phase: 'GoldGate', model: 'sonnet', schema: GOLDM })
let unlocked = gate && gate.ok && gate.falseKeepRate < 0.02 && gate.falseChangeRate < 0.02

if (!unlocked && gate && gate.ok) {
  log(`Gold gate attempt 1 FAILED (falseKeep=${gate.falseKeepRate}, falseChange=${gate.falseChangeRate}). Escalating all non-keeps + disputes to Opus and retesting.`)
  await parallel(Array.from({ length: goldBatches }, (_, i) => () =>
    agent(`${COMMON}
${RULES}
Opus re-adjudication pass for the gold gate. Read ${V_FIN('gold', 'mixed', i)}; for EVERY line whose verdict is not "keep" OR whose refuter field is "dispute" OR whose confidence < 0.8, re-read its queue record from pipeline/data/queues/gold-queue.jsonl and issue your own final verdict (same format, "judge":"opus-retest"). Write those lines to ${V_FIX('gold', 'mixed', i)} (overwrite). Return counts (disputed = lines re-ruled).`,
      { label: `goldgate:opus-retest:${i}`, phase: 'GoldGate', model: 'opus', effort: 'high', schema: BCOUNT })))
  gate = await agent(comparePrompt(2), { label: 'goldgate:compare-2', phase: 'GoldGate', model: 'sonnet', schema: GOLDM })
  unlocked = gate && gate.ok && gate.falseKeepRate < 0.02 && gate.falseChangeRate < 0.02
}

if (!unlocked) {
  log('GOLD GATE FAILED after 2 attempts — shipping NOTHING. See gold-gate-attempt*.md')
  return { aborted: 'gold-gate', gate, auditQ: auditQ.counts, mintQ: mintQ.counts }
}
log(`GOLD GATE PASSED (falseKeep=${gate.falseKeepRate}, falseChange=${gate.falseChangeRate}, agreement=${gate.agreement}, n=${gate.n}). Unlocking the fleet.`)

// ---------- Stage 2: interleaved audit+mint fan-out ----------
phase('Adjudicate')
const descriptors = []
const per = {}
for (const kind of ['audit', 'mint']) {
  const counts = kind === 'audit' ? auditQ.counts : mintQ.counts
  for (const lang of LANGS) per[`${kind}:${lang}`] = Math.ceil((counts[lang] || 0) / BATCH)
}
// round-robin interleave: audit-de, mint-de, audit-fr, mint-fr, ... so an early death stays balanced
for (let i = 0; descriptors.length < MAX_BATCHES; i++) {
  let added = false
  for (const lang of LANGS) {
    for (const kind of ['audit', 'mint']) {
      if (i < per[`${kind}:${lang}`] && descriptors.length < MAX_BATCHES) {
        descriptors.push({ kind, lang, i }); added = true
      }
    }
  }
  if (!added) break
}
log(`Fan-out: ${descriptors.length} batches of ${BATCH} (cap ${MAX_BATCHES}); remaining work continues in the next run of this same script.`)

const stats = await parallel(descriptors.map((d) => () => runBatch(d.kind, d.lang, d.i)))
const done = stats.filter(Boolean)
log(`Adjudicated ${done.length}/${descriptors.length} batches; ${done.reduce((s, x) => s + x.disputed, 0)} disputes sent to Opus.`)

// ---------- Stage 3: apply + gates ----------
phase('Apply')
const applies = await parallel(LANGS.map((lang) => () =>
  agent(`${COMMON}
Run pipeline/analysis/apply_verdicts.py for language "${lang}" ONLY (it must support a --language flag; add it if missing). It applies all unapplied verdict files for ${lang} (audit + mint, fixup-aware, provenance-enforced, invariant-enforced, idempotent via applied/ markers) to public/language-packs/${lang}.json and ${lang}.tail.json. This agent is the ONLY writer for ${lang} pack files in this run.
Then run: npm run validate:language-packs — it MUST pass; if it fails, fix apply_verdicts.py (never hand-edit pack JSON), re-run from the markers, and re-validate. Report applied/skipped counts and validator status.`,
    { label: `apply:${lang}`, phase: 'Apply', model: 'sonnet', schema: APPLYR })))

const gates = await agent(`${COMMON}
Run the full gate suite from ${REPO}: npm run validate:language-packs && npm run typecheck && npm test && npm run build. Report pass/fail per gate with the failing output quoted if any fail. Do not fix product code; just report.`,
  { label: 'gates:full', phase: 'Apply', model: 'sonnet', schema: SIMPLE })

return {
  gate, batchesRun: done.length, batchesPlanned: descriptors.length,
  auditQueue: auditQ.counts, mintQueue: mintQ.counts,
  applies, gates,
  moreWorkRemains: Object.values(per).reduce((s, n) => s + n, 0) > descriptors.length,
}