// Mint adjudication workflow (2026-07-15 run). ONE language per launch.
// Orders a rebuilt mint queue by evidence priority, then runs a per-batch
// adjudicator -> refuter -> judge pipeline (each batch flows independently, no
// global barrier). Every batch's I/O happens INSIDE its agents (this script has
// no filesystem access): agents read their queue slice and write their verdict
// files (raw -> final -> fixup) atomically, returning only compact counts.
//
// Launch (per language):
//   Workflow({ scriptPath: "docs/overnight-2026-07-15/mint-adjudicate.workflow.js",
//              args: { lang: "de", queuePath: "pipeline/data/queues/mint-de.jsonl",
//                      batchSize: 100, maxBatches: null } })
// Smoke (one batch dry run): args.maxBatches = 1.
// Resume: relaunch the SAME args. Batch i deterministically maps to file index
//   fileIndexBase+i, so a completed batch's agents detect their output file and
//   return "resumed" without redoing work. Nothing is keyed off wall-clock.
export const meta = {
  name: 'mint-adjudicate-2026-07-15',
  description: 'Evidence-priority-ordered mint adjudication (adjudicator->refuter->judge) for one language, resumable',
  phases: [
    { title: 'Prepare', detail: 'drop preSkip rows, order by evidence priority into a stable ordered queue', model: 'sonnet' },
    { title: 'Adjudicate', detail: 'per-batch adjudicator(sonnet)->refuter(sonnet)->judge(opus) pipeline', model: 'sonnet' },
  ],
}

const REPO = '/Users/jason/Downloads/CS Classes/Projects/Textum'
// Args may arrive as an object or (defensively) as a JSON string; a missing lang
// ABORTS rather than silently defaulting — on the first smoke run a default here
// masked args not arriving at all, and maxBatches was silently ignored.
let A = {}
if (typeof args === 'string') { try { A = JSON.parse(args) } catch { A = {} } }
else if (typeof args !== 'undefined' && args) { A = args }
if (!A.lang) {
  log(`ABORT bad_args: args.lang missing. Received: ${JSON.stringify(A).slice(0, 300)}`)
  return { aborted: 'bad_args', receivedArgs: A }
}
const LANG = A.lang
const LNAME = { de: 'German', fr: 'French', it: 'Italian', es: 'Spanish' }[LANG] || LANG
const QUEUE = A.queuePath || `pipeline/data/queues/mint-${LANG}.jsonl`
const ORDERED = `pipeline/data/queues/mint-${LANG}.ordered.jsonl`
const BATCH = A.batchSize || 100
const MAXB = (A.maxBatches === undefined || A.maxBatches === null) ? null : A.maxBatches
// mint-<lang>-N.jsonl files from the 2026-07-12 run top out at index 131 and are
// already applied (.done markers). apply_verdicts.py globs EXACTLY mint-<lang>-*.jsonl
// (a "mint2-" prefix would NOT be picked up), and build_mint_queue's
// load_already_adjudicated_keys globs the same, so tonight's files must (a) match
// that glob and (b) never collide with an existing index. A fixed high base keeps
// the logical-batch -> file-index map a pure function of args, so resume is exact.
const FILE_BASE = A.fileIndexBase || 10000

const COMMON = `Repo: ${REPO} (paths contain spaces — always quote them). python3 available. Do NOT git commit. public/language-packs/ is READ-ONLY here (only pipeline/analysis/apply_verdicts.py ever writes packs, and only after a panel passes). Write ONLY the verdict/queue files this task names, and write each atomically: write <path>.<your-batch-id>.tmp (NOT bare .tmp — concurrent batches collided on shared tmp names) then rename it (mv) onto <path>. Create parent dirs first (mkdir -p).
SCRATCH DISCIPLINE (a prior batch was silently corrupted by this): if you need ANY intermediate file (slice extracts, helper scripts, key lists), put it ONLY under "${REPO}/pipeline/data/scratch/<your-unique-task-id>/" (mkdir -p it; e.g. mint-de-10008/ or prep-de/). NEVER write or read a generically-named file (slice.jsonl, tmp.py, existing_keys.txt, verdicts.tmp) in the session scratchpad or any shared directory — many batch agents run concurrently and interleaved writes to same-named files have already swapped rows between batches undetected. Prefer re-reading slices directly from the canonical file with sed over caching copies. Your final message is machine-read — return ONLY the structured output.`

const RULES = `NON-NEGOTIABLE MINT RULES:
- Never invent a translation: a mint target must be copied verbatim from one of the record's listed alternatives (each came from a real dictionary/source).
- Noun gender/plural come ONLY from the chosen alternative's morph authority fields. If no sense-correct alternative carries morph.gender AND morph.plural, verdict = skip. Never guess morphology.
- Verbs render as the BARE INFINITIVE (packs carry no conjugations): a verb mint's target MUST be the infinitive; a conjugated form or participle => skip.
- Prefer skip over any mint you are not confident in. A wrong word taught is worse than no word. Only mints with confidence>=0.8 AND refuter agreement (or a judge ruling) ship.
- SKIP: proper nouns, demonyms, toponyms, abbreviations, multiword junk, vulgar-only glosses; and non-noun targets spelled identically to the English source (they teach nothing — nouns are exempt because the article differs).`

const ADDENDUM = `LEARNED FAILURE MODES (measured on prior runs — take these seriously):
ADJUDICATE AGAINST THE ENTRY'S GLOSS (entrSenses), NOT the word's vague "dominant sense." The biggest prior failure was accepting a target that teaches a DIFFERENT sense than the record's own gloss. The gloss IS the sense to teach: if the chosen target does not translate THAT sense it is wrong however common the target is — pick a gloss-matching alternative or skip.
NEVER treat a target's OWN back-translation glosses as evidence the sense matches — that is circular. (\`wishfully\`->\`vogliosamente\` "self-corroborated by the target's gloss" actually means lustfully.)
DON'T OVER-MINT: when torn, skip. A cognate/synonym that is "more direct" is not a reason to mint if the sense is off.
TONIGHT'S EVIDENCE NOTES:
- evidenceTier is a trust signal: T1 > T2 > T3. Plain dictionary rows with >=2 collapsed votes are strong; single-vote dictionary rows are weaker.
- WIKIPEDIA-LANGLINK rows (evidenceTier present, or an alternative whose sources include "wikipedia"): the pairing came from cross-language ARTICLE TITLES, so watch two artifacts. (1) TOPIC-LINK drift — the English article links to a target article about a RELATED but different topic (e.g. lardon -> albardar); that is not a translation => skip. (2) PLURAL-FORM titles — the article title may be a plural (e.g. mitochondria); mint the singular teaching lemma, and for nouns the morph must describe that singular.
- T3 rows have NO authority backing: be STRICTEST. Default to skip unless you are independently certain as a fluent speaker AND (noun has authoritative morph / verb is a clean infinitive).`

const PREP = {
  type: 'object', required: ['ok', 'orderable', 'preSkip', 'buckets', 'notes'],
  properties: {
    ok: { type: 'boolean' }, orderable: { type: 'number' }, preSkip: { type: 'number' },
    buckets: { type: 'object' }, notes: { type: 'string' },
  },
}
const ADJ = {
  type: 'object', required: ['ok', 'status', 'minted', 'skipped', 'written'],
  properties: {
    ok: { type: 'boolean' }, status: { type: 'string' },
    minted: { type: 'number' }, skipped: { type: 'number' }, written: { type: 'number' }, notes: { type: 'string' },
  },
}
const REF = {
  type: 'object', required: ['ok', 'status', 'minted', 'skipped', 'disputed', 'agreed'],
  properties: {
    ok: { type: 'boolean' }, status: { type: 'string' },
    minted: { type: 'number' }, skipped: { type: 'number' },
    disputed: { type: 'number' }, agreed: { type: 'number' }, notes: { type: 'string' },
  },
}
const JUDGE = {
  type: 'object', required: ['ok', 'status', 'judged'],
  properties: { ok: { type: 'boolean' }, status: { type: 'string' }, judged: { type: 'number' }, notes: { type: 'string' } },
}

// ---------- Prepare: preSkip filter + evidence-priority ordering ----------
phase('Prepare')
log(`Preparing ${LANG}: filtering preSkip rows and ordering ${QUEUE} by evidence priority`)
const prep = await agent(`${COMMON}
Build a STABLE, evidence-priority-ordered mint queue for ${LNAME} from "${REPO}/${QUEUE}".
Each input row is an enriched candidate: {key, source, lang, enZipf, pos?, entrSenses, alternatives:[{target,votes,sources,glosses,morph:{gender,plural,authority}|null}], evidenceTier:"T1"|"T2"|"T3"|null (present only on wiki-involved rows), preSkip:"cognate_nonnoun"|"noun_no_morph_any"|null (may be absent on older rows), shipTierHint}.

STEP 1 — DROP preSkip rows entirely (do NOT queue them; count them). A row is preSkip if its preSkip field is a non-null string. If the field is ABSENT (older schema), derive it: preSkip if (pos is not "noun" AND every alternative's target equals the source spelling) -> cognate_nonnoun; or (pos == "noun" AND no alternative has morph.gender) -> noun_no_morph_any.

STEP 2 — bucket every surviving row (compute, do not trust a prebuilt order):
  bestVotes = max alternative "votes" (default 1). wikiInvolved = evidenceTier in {T1,T2,T3} OR any alternative's sources include "wikipedia". wiktinvOnly = the union of all alternatives' sources is a subset of {"wiktinv"}.
  bucket 0 (a): NOT wikiInvolved AND bestVotes>=2   [dictionary, multi-vote]
  bucket 1 (b): evidenceTier == "T1"
  bucket 2 (c): NOT wikiInvolved AND bestVotes==1    [dictionary, single-vote]
  bucket 3 (d): evidenceTier == "T2"
  bucket 4 (e): wiktinvOnly
  bucket 5 (f): evidenceTier == "T3" AND pos != "noun"
  bucket 6 (other): anything left (e.g. a T3 noun with morph) — keep it, ordered last so early-stopping never silently drops a shippable row.

STEP 3 — write "${REPO}/${ORDERED}" (atomic .tmp then mv): the surviving rows as VERBATIM copies of the input rows (do not alter any field — apply_verdicts.py re-derives provenance from the canonical ${QUEUE} by key, so keys and content must stay identical), sorted by (bucket ASC, then enZipf DESC, then key ASC) for determinism.
RESUME: if "${REPO}/${ORDERED}" already exists and is non-empty, DO NOT rebuild it (rebuilding could reorder rows and break in-flight batch line-ranges) — just count its lines and report.
Return {ok, orderable:<lines written/counted>, preSkip:<count dropped>, buckets:{"0":n,...,"6":n}, notes}.`,
  { label: `prepare:${LANG}`, phase: 'Prepare', model: 'sonnet', schema: PREP })

if (!prep || !prep.ok || !(prep.orderable > 0)) {
  log(`Prepare failed or produced no orderable rows for ${LANG} — nothing to adjudicate`)
  return { aborted: 'prepare', lang: LANG, prep }
}
let numBatches = Math.ceil(prep.orderable / BATCH)
if (MAXB !== null) numBatches = Math.min(numBatches, MAXB)
log(`${LANG}: ${prep.orderable} orderable rows (${prep.preSkip} preSkip dropped), buckets=${JSON.stringify(prep.buckets)}. Dispatching ${numBatches} batch(es) of ${BATCH} (file indices ${FILE_BASE}..${FILE_BASE + numBatches - 1}).`)

// ---------- per-batch file paths (fileIndex is a pure function of the batch) ----------
const RAW = (fi) => `pipeline/data/verdicts/raw/mint-${LANG}-${fi}.jsonl`
const FIN = (fi) => `pipeline/data/verdicts/final/mint-${LANG}-${fi}.jsonl`
const FIX = (fi) => `pipeline/data/verdicts/fixup/mint-${LANG}-${fi}.jsonl`

const adjP = (b) => `${COMMON}
${RULES}
${ADDENDUM}
You are the ADJUDICATOR, fluent in ${LNAME} and English. MINT adjudication: decide which NEW candidate words to add to the ${LNAME} pack.
Read your slice: sed -n '${b.lo},${b.hi}p' "${REPO}/${ORDERED}"  (up to ${BATCH} records; the last batch may have fewer).
SLICE INTEGRITY (mandatory before any adjudication): extract your slice KEY LIST twice, independently, straight from the canonical ordered file (never from a cached copy):
  sed -n '${b.lo},${b.hi}p' "${REPO}/${ORDERED}" | python3 -c "import sys,json; [print(json.loads(l)['key']) for l in sys.stdin]"
Run that twice and diff the outputs: they must be byte-identical with the expected count. If they differ, your reads are racing something — re-run until two consecutive extractions agree. Every verdict you emit must be for a key in this set, and after writing your verdict file verify (mechanically, with a diff against the key list) that your file contains EXACTLY one line per slice key except keys you skipped for idempotence.
RESUME: if "${REPO}/${RAW(b.fi)}" already exists, VALIDATE it against your slice key set: every key in it must belong to the set, and (its keys + keys found in existing final/fixup mint-${LANG}-*.jsonl files) must cover the whole set. If valid, return {ok:true,status:"resumed",minted:0,skipped:0,written:<its line count>} and write nothing. If INVALID (foreign keys, or gaps not explained by idempotence), delete it (rm) and adjudicate from scratch.
IDEMPOTENCE: skip any key that already appears in an existing "${REPO}/pipeline/data/verdicts/final/mint-${LANG}-*.jsonl" or ".../fixup/mint-${LANG}-*.jsonl" file (do not re-adjudicate it; do not emit a line for it).
ATTENTION DISCIPLINE (this batch is large): work through the rows in small groups of ~15 and emit results as you go. Emit EXACTLY ONE JSON verdict line per input record — never summarize, never collapse ("the rest are skips" is FORBIDDEN), never omit a row. The output must have one line per adjudicated record.
Per record decide "mint" or "skip":
- mint: choose the ONE alternative whose glosses/evidence teach the record's GLOSSED English sense (entrSenses) and that is teachable; copy its target verbatim.
- NOUN mint: the chosen alternative MUST carry morph.gender AND morph.plural; else skip.
- VERB mint: target MUST be the bare infinitive; else skip.
- shipTier: take shipTierHint, but downgrade "core-gap" to "tail" unless the choice is unanimous across >=3 sources AND confidence>=0.9.
Write one JSON line per record to "${REPO}/${RAW(b.fi)}" (atomic .tmp then mv): for a mint {key, verdict:"mint", target, shipTier, gender, plural, pos, morphAuthority, confidence:0-1, reason:"<=12 words"}; for a skip {key, verdict:"skip", pos, confidence:0-1, reason:"<=12 words"}.
Return {ok, status:"processed", minted:<mint count>, skipped:<skip count>, written:<total lines>}.`

const refP = (b) => `${COMMON}
${RULES}
${ADDENDUM}
You are the REFUTER, fluent in ${LNAME} and English. The adjudicator wrote "${REPO}/${RAW(b.fi)}" for lines ${b.lo}-${b.hi} of "${REPO}/${ORDERED}".
VALIDATE THE RAW FILE FIRST (a prior run had cross-batch row contamination): extract your slice key set (sed -n '${b.lo},${b.hi}p' "${REPO}/${ORDERED}" piped through python3 to print each line's key; run twice, must agree). If the raw file contains ANY key outside the slice set, or its keys plus keys in existing final/fixup mint-${LANG}-*.jsonl files do not cover the slice set, it is corrupt: delete it (rm "${REPO}/${RAW(b.fi)}") and return {ok:false,status:"corrupt_raw",minted:0,skipped:0,disputed:0,agreed:0} — the batch will re-run on the next launch. Do not refute a corrupt file.
RESUME: if "${REPO}/${FIN(b.fi)}" already exists and its key set equals the raw file's key set, this batch is already refuted — read it and return {ok:true,status:"resumed",minted:<verdict=="mint" count>,skipped:<skip count>,disputed:<refuter=="dispute" count>,agreed:<refuter=="agree" count>}.
Otherwise re-read the same queue slice (sed -n '${b.lo},${b.hi}p' "${REPO}/${ORDERED}") alongside the raw verdicts and PROVE THEM WRONG wherever possible. Attack every "mint" and every line with confidence<0.75, and sample ~20% of the skips (a wrongful skip loses a good word). For each attacked line ask: is the target really a correct translation of the record's GLOSSED sense (not its own back-translation)? wrong/non-dominant sense? Wikipedia langlink topic-artifact or plural-title error? verb not an infinitive? noun missing authoritative morph? non-noun cognate identical to English?
Write "${REPO}/${FIN(b.fi)}" (atomic .tmp then mv): copy each raw line and add "refuter":"agree" or "refuter":"dispute" (+ "refuterReason" when disputing); lines you did not attack get "refuter":"unreviewed". Do NOT change verdicts yourself — disputes go to the judge. One line per raw line.
Return {ok, status:"processed", minted:<mint count>, skipped:<skip count>, disputed:<disputes>, agreed:<agrees>}.`

const judgeP = (b) => `${COMMON}
${RULES}
${ADDENDUM}
You are the FINAL JUDGE (Opus — this ruling ships tonight). "${REPO}/${FIN(b.fi)}" has lines with "refuter":"dispute".
RESUME: if "${REPO}/${FIX(b.fi)}" already exists and already contains a ruling for every disputed key in the final file, return {ok:true,status:"resumed",judged:<its line count>}.
For each "refuter":"dispute" line, re-read its record in "${REPO}/${ORDERED}" (match by key), weigh the adjudicator's mint against the refuter's objection, and rule: uphold the mint ONLY if the evidence truly teaches the entry's glossed sense with authoritative morph (nouns) / a clean infinitive (verbs); otherwise overturn to skip. When in doubt: skip.
Write ONLY the disputed lines to "${REPO}/${FIX(b.fi)}" (atomic .tmp then mv), same schema, add "judge":"opus" and DROP the refuter field. An upheld mint MUST keep confidence>=0.8 so it clears the ship stratum; a skip ruling is a skip.
Return {ok, status:"processed", judged:<lines ruled>}.`

// ---------- Adjudicate: one independent pipeline per batch ----------
phase('Adjudicate')
const batches = Array.from({ length: numBatches }, (_, i) => ({
  i, fi: FILE_BASE + i, lo: i * BATCH + 1, hi: (i + 1) * BATCH,
}))

const results = (await pipeline(
  batches,
  (b) => agent(adjP(b), { label: `adj:mint:${LANG}:${b.fi}`, phase: 'Adjudicate', model: 'sonnet', schema: ADJ }),
  (adj, b) => (adj && adj.ok)
    ? agent(refP(b), { label: `ref:mint:${LANG}:${b.fi}`, phase: 'Adjudicate', model: 'sonnet', schema: REF })
    : null,
  (ref, b) => {
    if (!ref || !ref.ok) return ref || null
    if (ref.disputed > 0) {
      return agent(judgeP(b), { label: `judge:mint:${LANG}:${b.fi}`, phase: 'Adjudicate', model: 'opus', effort: 'high', schema: JUDGE })
        .then((j) => ({ ...ref, judged: (j && j.judged) || 0 }))
    }
    return { ...ref, judged: 0 }
  },
)).filter(Boolean)

const sum = (k) => results.reduce((s, r) => s + (r && r[k] || 0), 0)
const completed = results.length
log(`${LANG}: completed ${completed}/${numBatches} batches; minted=${sum('minted')} skipped=${sum('skipped')} disputed=${sum('disputed')} judged=${sum('judged')}`)

return {
  lang: LANG,
  orderable: prep.orderable,
  preSkipDropped: prep.preSkip,
  buckets: prep.buckets,
  batchSize: BATCH,
  batchesDispatched: numBatches,
  batchesCompleted: completed,
  fileIndexRange: [FILE_BASE, FILE_BASE + numBatches - 1],
  minted: sum('minted'),
  skipped: sum('skipped'),
  disputed: sum('disputed'),
  judged: sum('judged'),
  corruptRawBatches: results.filter((r) => r && r.status === 'corrupt_raw').length,
  moreWorkRemains: Math.ceil(prep.orderable / BATCH) > numBatches,
  nextStep: `Panel-gate then apply: Workflow mint-panel.workflow.js {lang:"${LANG}"}, then (if ship) python3 pipeline/analysis/apply_verdicts.py --language ${LANG} --mint-only --ship-stratum strict`,
}
