// Mint panel workflow (2026-07-15 run). ONE language per launch. After a
// language's mint verdicts are complete (or time-boxed), independently
// re-verifies a stratified sample of SHIP-STRATUM-eligible mints with a panel of
// Opus fluent-speaker agents, then reduces to a batch error rate and a ship/block
// decision. It does NOT touch the packs — the ORCHESTRATOR runs apply_verdicts.py
// only for languages whose panel says ship.
//
// Launch:
//   Workflow({ scriptPath: "docs/overnight-2026-07-15/mint-panel.workflow.js",
//              args: { lang: "de", sampleSize: 120, seed: 20260715 } })
// Panel bar: errorRate <= 0.05 => decision "ship", else "block".
// Output: pipeline/data/verdicts/panel/panel-<lang>-<seed>.json
// Resume: relaunch the SAME args — the sample and each panel agent detect their
//   existing output file and return without redoing work; the reducer always
//   recomputes from the per-agent files. runIndex is the seed (deterministic).
export const meta = {
  name: 'mint-panel-2026-07-15',
  description: 'Independent Opus panel re-verification of ship-stratum mints for one language; ship/block at 5% error',
  phases: [
    { title: 'Sample', detail: 'stratified seeded sample of ship-stratum-eligible mints', model: 'sonnet' },
    { title: 'Panel', detail: '~6 independent Opus fluent-speaker verifiers, ~20 words each', model: 'opus' },
    { title: 'Reduce', detail: 'aggregate error rate, write panel verdict json, ship/block', model: 'sonnet' },
  ],
}

const REPO = '/Users/jason/Downloads/CS Classes/Projects/Textum'
// The harness delivers args as a JSON STRING (proven by args-probe.workflow.js);
// parse defensively and ABORT on a missing lang rather than silently defaulting
// (a silent de default here would panel German for every language).
let A = {}
if (typeof args === 'string') { try { A = JSON.parse(args) } catch { A = {} } }
else if (typeof args !== 'undefined' && args) { A = args }
if (!A.lang) {
  log(`ABORT bad_args: args.lang missing. Received: ${JSON.stringify(A).slice(0, 300)}`)
  return { aborted: 'bad_args', receivedArgs: A }
}
const LANG = A.lang
const LNAME = { de: 'German', fr: 'French', it: 'Italian', es: 'Spanish' }[LANG] || LANG
const SAMPLE = A.sampleSize || 120
const SEED = A.seed || 20260715
const PER_AGENT = A.perAgent || 20      // ~6 agents at sampleSize 120
const BATCH = A.batchSize || 100
const FILE_BASE = A.fileIndexBase || 10000
const SHIP_BAR = 0.05                    // errorRate must be <= this to ship
const RUNIDX = SEED                      // deterministic run index (script has no clock)

const PANEL_DIR = 'pipeline/data/verdicts/panel'
const SAMPLE_FILE = `${PANEL_DIR}/panel-${LANG}-${RUNIDX}-sample.jsonl`
const AGENT_FILE = (k) => `${PANEL_DIR}/panel-${LANG}-${RUNIDX}-agent-${k}.jsonl`
const VERDICT_FILE = `${PANEL_DIR}/panel-${LANG}-${RUNIDX}.json`

const COMMON = `Repo: ${REPO} (paths contain spaces — always quote them). python3 available. Do NOT git commit. public/language-packs/ is READ-ONLY (this workflow never writes packs; the orchestrator applies verdicts only if this panel ships). Write ONLY the file this task names, atomically: write <path>.tmp then rename it (mv) onto <path>. mkdir -p parents first. Your final message is machine-read — return ONLY the structured output.`

const VERIFY_POLICY = `Verify each mint as a fluent native ${LNAME} speaker, adversarially — you are the last line before it ships:
(a) the target correctly translates the English word's GLOSSED sense (entrSenses) — NOT the target's own back-translation (that is circular);
(b) for a noun, gender + plural are correct per the cited morph authority;
(c) for a verb, the target is the bare infinitive (packs render infinitive only);
(d) no Wikipedia-langlink artifact — the pair is a real translation, not a related-topic article link (e.g. lardon->albardar) and not an uncorrected plural-form title (e.g. mitochondria);
(e) genuinely teachable (not a proper noun, abbreviation, or multiword junk; a non-noun identical to the English source teaches nothing).
Mark ok:false if ANY check fails.`

const SAMPLE_SCHEMA = {
  type: 'object', required: ['ok', 'eligible', 'sampled', 'buckets', 'universeFingerprint'],
  properties: {
    ok: { type: 'boolean' }, eligible: { type: 'number' }, sampled: { type: 'number' },
    buckets: { type: 'object' }, universeFingerprint: { type: 'string' }, notes: { type: 'string' },
  },
}
const AGENT_SCHEMA = {
  type: 'object', required: ['ok', 'checked', 'errors'],
  properties: {
    ok: { type: 'boolean' }, checked: { type: 'number' }, errors: { type: 'number' },
    errorKeys: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' },
  },
}
const REDUCE_SCHEMA = {
  type: 'object', required: ['ok', 'sampled', 'errors', 'errorRate', 'decision', 'universeFingerprint'],
  properties: {
    ok: { type: 'boolean' }, sampled: { type: 'number' }, errors: { type: 'number' },
    errorRate: { type: 'number' }, decision: { type: 'string' },
    universeFingerprint: { type: 'string' }, notes: { type: 'string' },
  },
}

// ---------- Sample: stratified, seeded, ship-stratum-eligible ----------
phase('Sample')
log(`Sampling ${SAMPLE} ship-stratum ${LANG} mints (seed ${SEED}) for panel re-verification`)
const sampled = await agent(`${COMMON}
Build a stratified, seeded sample of SHIP-STRATUM-ELIGIBLE ${LNAME} mints for panel audit.
PREFLIGHT BEFORE RESUME OR SAMPLING: count "${REPO}/pipeline/data/queues/mint-${LANG}.ordered.jsonl" and derive every expected batch at ${BATCH} rows with file indices starting at ${FILE_BASE}. For each batch, either its matching applied/*.done marker must exist (immutable prior wave), OR its final file must contain exactly one unique row per key in the matching ordered-queue slice. For every final row with refuter:"dispute", the matching fixup file must contain exactly one ruling for that key. If any expected batch/fixup is absent, short, duplicate-keyed, or foreign-keyed, return {ok:false,eligible:0,sampled:0,buckets:{},universeFingerprint:"",notes:"incomplete verdict universe: ..."} and DO NOT create or reuse a sample.
Collect candidates ONLY from expected file-index >=${FILE_BASE} final files that DO NOT have a matching applied/*.done marker; this makes the panel audit exactly the pending wave the applier would change. Apply fixup overrides: for any key present in the matching fixup file (same basename), the fixup row REPLACES the final row. Do not include older file indices or already-applied batches.
Ship-stratum-eligible = verdict=="mint" AND confidence>=0.8 AND (refuter=="agree" OR the row has a "judge" field). Mirror ship_stratum_ok in pipeline/analysis/apply_verdicts.py exactly.
Stratify by EVIDENCE bucket: join each key to its record in "${REPO}/pipeline/data/queues/mint-${LANG}.jsonl" (fall back to mint-${LANG}.ordered.jsonl) and bucket by (dict>=2 votes / T1 / dict single-vote / T2 / wiktinv-only / T3 / other), using evidenceTier and the top alternative's votes/sources exactly as the adjudication workflow's Prepare step did.
Draw ${SAMPLE} rows with random.Random(${SEED}) (build_minttrial_sample.py conventions: seeded, sample without replacement within a stratum), allocated across buckets proportional to bucket size with at least 1 from each non-empty bucket; if fewer than ${SAMPLE} eligible mints exist, take them all.
ALWAYS compute the complete eligible universe and the exact deterministic expected sample before looking at an existing sample file. Compute universeFingerprint as SHA-256 over canonical compact JSON for the effective eligible rows sorted by key (at minimum key, target, verdict, confidence, refuter/judge, and originating file index).
Write each sampled row to "${REPO}/${SAMPLE_FILE}" (atomic .tmp then mv) as the verdict line ENRICHED with the queue evidence needed to verify it blind: {key, target, pos, shipTier, gender, plural, confidence, entrSenses, chosenAlternative:{target,glosses,morph,sources,votes}, evidenceTier, enZipf, lang:"${LANG}"}.
RESUME (only after the preflight passes): if "${REPO}/${SAMPLE_FILE}" already exists and is non-empty, require its ordered key list to equal the freshly recomputed deterministic expected sample exactly — membership and line count alone are NOT sufficient because it may have been frozen from a partial universe. If exact, do not rebuild it. If different, return ok:false and block; never silently reuse or overwrite it, and explicitly report that any old "${REPO}/${VERDICT_FILE}" is stale and must not authorize apply.
Return {ok, eligible:<all pending ship-stratum mints>, sampled:<rows written/counted>, buckets:{bucket:count}, universeFingerprint, notes}.`,
  { label: `panel-sample:${LANG}`, phase: 'Sample', model: 'sonnet', schema: SAMPLE_SCHEMA })

if (!sampled || !sampled.ok || !(sampled.sampled > 0)) {
  log(`No ship-stratum mints to panel for ${LANG} — nothing to verify`)
  return { aborted: 'sample', lang: LANG, sampled }
}
if (sampled.sampled !== Math.min(SAMPLE, sampled.eligible)) {
  log(`Panel sample integrity failure for ${LANG}: sampled=${sampled.sampled}, eligible=${sampled.eligible}, requested=${SAMPLE}`)
  return { aborted: 'sample_integrity', lang: LANG, sampled }
}
if (!/^[a-f0-9]{64}$/.test(sampled.universeFingerprint)) {
  log(`Panel sample fingerprint failure for ${LANG}`)
  return { aborted: 'sample_fingerprint', lang: LANG, sampled }
}
const nAgents = Math.max(1, Math.ceil(sampled.sampled / PER_AGENT))
log(`${LANG}: ${sampled.sampled} ship-stratum mints sampled, buckets=${JSON.stringify(sampled.buckets)}. Fanning out ${nAgents} independent Opus verifiers (~${PER_AGENT} each).`)

// ---------- Panel: independent Opus verifiers over disjoint slices ----------
phase('Panel')
const slices = Array.from({ length: nAgents }, (_, k) => ({ k, lo: k * PER_AGENT + 1, hi: (k + 1) * PER_AGENT }))
const panel = (await parallel(slices.map((s) => () =>
  agent(`${COMMON}
You are INDEPENDENT PANEL VERIFIER ${s.k + 1} of ${nAgents}, a fluent native ${LNAME} speaker. Verify only YOUR slice of the sample — do not look at other verifiers' slices.
Read: sed -n '${s.lo},${s.hi}p' "${REPO}/${SAMPLE_FILE}"  (each line is one ship-stratum mint with its evidence).
RESUME: if "${REPO}/${AGENT_FILE(s.k)}" exists, validate that its unique key set exactly equals your sample slice (no missing, duplicate, or foreign keys). If exact, return {ok:true,checked:<its line count>,errors:<its ok:false count>,errorKeys:[...]} without redoing it. If invalid, return {ok:false,checked:0,errors:0,errorKeys:[],notes:"invalid frozen panel slice"}; never count a partial file.
${VERIFY_POLICY}
Write one line per checked word to "${REPO}/${AGENT_FILE(s.k)}" (atomic .tmp then mv): {key, ok:true|false, reason:"<=15 words"}. Verify each independently from the evidence; do not rubber-stamp.
Return {ok, checked:<words>, errors:<ok:false count>, errorKeys:[failing keys]}.`,
    { label: `panel:${LANG}:${s.k}`, phase: 'Panel', model: 'opus', effort: 'high', schema: AGENT_SCHEMA }),
))).filter(Boolean)

const panelChecked = panel.reduce((s, r) => s + (r && r.checked || 0), 0)
const panelErrors = panel.reduce((s, r) => s + (r && r.errors || 0), 0)
log(`${LANG}: panel returned ${panelChecked} checked, ${panelErrors} flagged across ${panel.length}/${nAgents} verifiers`)
if (panel.length !== nAgents || panel.some((r) => !r || !r.ok) || panelChecked !== sampled.sampled) {
  log(`${LANG}: panel incomplete — refusing to reduce or write a ship verdict`)
  return { aborted: 'panel_incomplete', lang: LANG, expectedAgents: nAgents, returnedAgents: panel.length, expectedRows: sampled.sampled, checked: panelChecked }
}

// ---------- Reduce: write the panel verdict json, decide ship/block ----------
phase('Reduce')
const reduced = await agent(`${COMMON}
Reduce the ${LNAME} panel run into a single verdict. Read exactly agent files 0 through ${nAgents - 1} for run ${RUNIDX}; ignore no file and include no extra glob matches. Re-validate that their disjoint unique keys exactly cover "${REPO}/${SAMPLE_FILE}" before writing anything. If not, return {ok:false,sampled:0,errors:0,errorRate:1,decision:"block",universeFingerprint:"${sampled.universeFingerprint}",notes:"panel coverage mismatch"} without writing a verdict.
sampled = total lines across all agent files; errors = total lines with ok:false; errorRate = errors / sampled (0 if sampled==0).
decision = "ship" if errorRate <= ${SHIP_BAR} else "block".
Write "${REPO}/${VERDICT_FILE}" (atomic .tmp then mv): {lang:"${LANG}", runIndex:${RUNIDX}, seed:${SEED}, universeFingerprint:"${sampled.universeFingerprint}", sampled, errors, errorRate, decision, shipBar:${SHIP_BAR}, perAgent:[{agent:<k>, checked, errors}], errorExamples:[{key,reason} up to 20 from the ok:false lines]}.
Return {ok, sampled, errors, errorRate, decision, universeFingerprint:"${sampled.universeFingerprint}", notes}.`,
  { label: `panel-reduce:${LANG}`, phase: 'Reduce', model: 'sonnet', schema: REDUCE_SCHEMA })

if (!reduced || !reduced.ok) {
  log(`Panel reduce failed for ${LANG}`)
  return { aborted: 'reduce', lang: LANG, sampled: sampled.sampled, panelChecked, panelErrors, reduced }
}
if (reduced.sampled !== sampled.sampled || reduced.sampled !== panelChecked) {
  log(`Panel reduce integrity failure for ${LANG}: reduced=${reduced.sampled}, sample=${sampled.sampled}, checked=${panelChecked}`)
  return { aborted: 'reduce_integrity', lang: LANG, sampled: sampled.sampled, panelChecked, reduced }
}
if (reduced.universeFingerprint !== sampled.universeFingerprint) {
  log(`Panel reduce fingerprint mismatch for ${LANG}`)
  return { aborted: 'reduce_fingerprint', lang: LANG, expected: sampled.universeFingerprint, reduced }
}
log(`${LANG} PANEL VERDICT: ${reduced.errors}/${reduced.sampled} errors = ${reduced.errorRate} -> ${reduced.decision.toUpperCase()} (bar ${SHIP_BAR}). Written to ${VERDICT_FILE}`)

return {
  lang: LANG,
  seed: SEED,
  runIndex: RUNIDX,
  universeFingerprint: reduced.universeFingerprint,
  sampled: reduced.sampled,
  errors: reduced.errors,
  errorRate: reduced.errorRate,
  decision: reduced.decision,
  verdictFile: VERDICT_FILE,
  applyStep: reduced.decision === 'ship'
    ? `python3 pipeline/analysis/apply_verdicts.py --language ${LANG} --mint-only --ship-stratum strict`
    : '(blocked — apply nothing for this language)',
}
