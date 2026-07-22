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
  type: 'object', required: ['ok', 'requestedSampleSize', 'batchSize', 'fileIndexBase', 'eligible', 'sampled', 'buckets', 'universeFingerprint', 'sampleFingerprint'],
  properties: {
    ok: { type: 'boolean' }, requestedSampleSize: { type: 'number' },
    batchSize: { type: 'number' }, fileIndexBase: { type: 'number' },
    eligible: { type: 'number' }, sampled: { type: 'number' },
    buckets: { type: 'object' }, universeFingerprint: { type: 'string' },
    sampleFingerprint: { type: 'string' }, notes: { type: 'string' },
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
  type: 'object', required: ['ok', 'sampled', 'errors', 'errorRate', 'decision', 'universeFingerprint', 'sampleFingerprint', 'falseKeys'],
  properties: {
    ok: { type: 'boolean' }, sampled: { type: 'number' }, errors: { type: 'number' },
    errorRate: { type: 'number' }, decision: { type: 'string' },
    universeFingerprint: { type: 'string' }, sampleFingerprint: { type: 'string' },
    falseKeys: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' },
  },
}

// ---------- Sample: stratified, seeded, ship-stratum-eligible ----------
phase('Sample')
log(`Sampling ${SAMPLE} ship-stratum ${LANG} mints (seed ${SEED}) for panel re-verification`)
const sampled = await agent(`${COMMON}
Do not implement sampling or integrity logic yourself. Run this tracked deterministic preflight/sampler exactly:
cd "${REPO}" && python3 -m pipeline.analysis.mint_panel_contract sample --language "${LANG}" --seed ${SEED} --sample-size ${SAMPLE} --batch-size ${BATCH} --file-index-base ${FILE_BASE} --output "${SAMPLE_FILE}"
It validates every ordered batch/fixup, excludes applied markers and minttrial-superseded rows, fingerprints the full effective queue+verdict universe, and refuses a stale frozen sample. Return the command's JSON object verbatim. If it exits nonzero, return its {ok:false,...} JSON and do not write anything else.`,
  { label: `panel-sample:${LANG}`, phase: 'Sample', model: 'sonnet', schema: SAMPLE_SCHEMA })

if (!sampled || !sampled.ok || !(sampled.sampled > 0)) {
  log(`No ship-stratum mints to panel for ${LANG} — nothing to verify`)
  return { aborted: 'sample', lang: LANG, sampled }
}
if (sampled.sampled !== Math.min(SAMPLE, sampled.eligible)) {
  log(`Panel sample integrity failure for ${LANG}: sampled=${sampled.sampled}, eligible=${sampled.eligible}, requested=${SAMPLE}`)
  return { aborted: 'sample_integrity', lang: LANG, sampled }
}
if (sampled.requestedSampleSize !== SAMPLE || sampled.batchSize !== BATCH || sampled.fileIndexBase !== FILE_BASE) {
  log(`Panel sample contract mismatch for ${LANG}`)
  return { aborted: 'sample_contract', lang: LANG, sampled }
}
if (!/^[a-f0-9]{64}$/.test(sampled.universeFingerprint)) {
  log(`Panel sample fingerprint failure for ${LANG}`)
  return { aborted: 'sample_fingerprint', lang: LANG, sampled }
}
if (!/^[a-f0-9]{64}$/.test(sampled.sampleFingerprint)) {
  log(`Panel deterministic sample fingerprint failure for ${LANG}`)
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
Do not implement reduction or integrity logic yourself. Run the tracked deterministic reducer exactly:
cd "${REPO}" && python3 -m pipeline.analysis.mint_panel_contract reduce --language "${LANG}" --seed ${SEED} --sample-size ${SAMPLE} --ship-bar ${SHIP_BAR} --batch-size ${BATCH} --file-index-base ${FILE_BASE} ${Array.from({ length: nAgents }, (_, k) => `--results "${AGENT_FILE(k)}"`).join(' ')} --output "${VERDICT_FILE}"
It recomputes the current universe and deterministic sample, requires exactly one judgment for every sampled key, verifies all error arithmetic, and writes the COMPLETE falseKeys list used by apply suppression. Return the command's JSON object verbatim. If it exits nonzero, return its {ok:false,...} JSON and do not write anything else.`,
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
if (reduced.sampleFingerprint !== sampled.sampleFingerprint) {
  log(`Panel reduce sample fingerprint mismatch for ${LANG}`)
  return { aborted: 'reduce_sample_fingerprint', lang: LANG, expected: sampled.sampleFingerprint, reduced }
}
if (!Array.isArray(reduced.falseKeys) || reduced.falseKeys.length !== reduced.errors) {
  log(`Panel reduce false-key completeness failure for ${LANG}`)
  return { aborted: 'reduce_false_keys', lang: LANG, reduced }
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
  falseKeys: reduced.falseKeys,
  decision: reduced.decision,
  verdictFile: VERDICT_FILE,
  applyStep: reduced.decision === 'ship'
    ? `python3 pipeline/analysis/apply_verdicts.py --language ${LANG} --mint-only --ship-stratum strict --panel-verdict ${VERDICT_FILE}`
    : '(blocked — apply nothing for this language)',
}
