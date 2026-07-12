// Phase 1c: complete the limit-killed mint fan-out for the UNLOCKED languages only
// (de/it/es passed the independent panel at 1.18% error; fr failed and ships nothing),
// apply mint-only under the strict ship stratum, run gates, and compile the audit
// review queue for morning human review (audit auto-apply FAILED its gate: 28-38%
// adjudicated ship-stratum falseChange — no existing entry is auto-changed).
export const meta = {
  name: 'vocab-phase1c-mint-ship',
  description: 'Finish mint adjudication for de/it/es, apply mint-only, gates, audit review queue',
  phases: [
    { title: 'Inventory', detail: 'which mint batches need adj/ref/judge after the limit kill', model: 'sonnet' },
    { title: 'Complete', detail: 'finish only the missing stages per batch', model: 'sonnet' },
    { title: 'Apply', detail: 'mint-only strict-stratum apply for de/it/es + validator', model: 'sonnet' },
    { title: 'ReviewQueue', detail: 'compile audit fixes for morning human review', model: 'sonnet' },
  ],
}

const REPO = '/Users/jason/Downloads/CS Classes/Projects/Textum'
const BATCH = 45
const MINT_LANGS = ['de', 'it', 'es'] // fr FAILED the mint panel — ships nothing
const LNAME = { de: 'German', it: 'Italian', es: 'Spanish' }

const COMMON = `Repo: ${REPO}. python3 available. Do NOT git commit. public/language-packs/ is READ-ONLY except for pipeline/analysis/apply_verdicts.py in the Apply stage. Your final message is machine-read — return the structured output only.`

const RULES = `NON-NEGOTIABLE RULES:
- Never invent a translation: a mint target must be one of the queue record's listed alternatives (each from a real dictionary source).
- Noun gender/plural come ONLY from the record's morph authority fields; no authority => skip.
- RETARGET/MINT only for the sense the record's evidence supports; DEFAULT TO SKIP when torn. Confidence honesty: only mints with confidence>=0.8 AND refuter agreement ship.
- GATE/SKIP: proper nouns, demonyms, toponyms, abbreviations, multiword junk, vulgar-only glosses, non-noun targets identical to the English source; polysemous common English words (enZipf>=4.5, many entrSenses) with no single clean dominant target.`

const ADDENDUM = `LEARNED FAILURE MODES (measured tonight — take these seriously):
ADJUDICATE AGAINST THE ENTRY GLOSS, NOT THE WORD'S "DOMINANT SENSE." The biggest failure (33 real falseKeeps, all es) was keeping a target that teaches a DIFFERENT sense than the entry's own gloss (entrSenses), rationalized as "the dominant everyday sense." The gloss IS the sense to teach: if the current target doesn't translate THAT sense it is wrong, however common the target is -- retarget to a gloss-matching candidate or gate. Verbatim misses:
- \`felt\` gloss "matted wool fabric" -> kept \`sentir\` (to feel); gloss is the fabric (fieltro), not the verb.
- \`make\` gloss "brand/manufacturer" noun -> kept \`hacer\` (verb); POS+sense mismatch, gloss wants \`marca\`.
- \`blue\` gloss "sad/melancholic" -> kept \`azul\` (color only); azul lacks the mood sense.
NEVER treat currentTargetGlosses as evidence the sense matches -- it is the target's OWN back-translation (circular). \`wishfully\`->\`vogliosamente\` was kept "self-corroborated by the target's gloss"; it means lustfully.
DON'T OVER-CHANGE: 24% of confident (conf>=0.8) ship-stratum verdicts corrupted a GOOD entry. If the current target already translates the gloss sense, KEEP. Don't retarget to a cognate/synonym just because it's "more direct". Don't GATE a sense-correct noun only for missing gender/plural, nor gate a transparent compositional phrase. Gate only for a real wrong-sense with no gloss-matching candidate, vulgarity, or a true proper noun.`

const INV = {
  type: 'object', required: ['ok', 'perLang', 'notes'],
  properties: { ok: { type: 'boolean' }, perLang: { type: 'object' }, notes: { type: 'string' } },
}
const BCOUNT = { type: 'object', required: ['keep', 'change', 'gate', 'disputed'], properties: { keep: { type: 'number' }, change: { type: 'number' }, gate: { type: 'number' }, disputed: { type: 'number' } } }
const SIMPLE = { type: 'object', required: ['ok', 'notes'], properties: { ok: { type: 'boolean' }, notes: { type: 'string' } } }
const APPLYR = { type: 'object', required: ['ok', 'applied', 'skipped', 'notes'], properties: { ok: { type: 'boolean' }, applied: { type: 'number' }, skipped: { type: 'number' }, notes: { type: 'string' } } }

// ---------- Inventory ----------
phase('Inventory')
const inv = await agent(`${COMMON}
Inventory the mint adjudication state after last night's usage-limit kill. For each lang in de,it,es with queue pipeline/data/queues/mint-<lang>.jsonl (batch size ${BATCH}, batch i covers lines i*${BATCH}+1..(i+1)*${BATCH}):
- totalBatches = ceil(queueRows/${BATCH})
- needFull: batch indexes with NO pipeline/data/verdicts/raw/mint-<lang>-<i>.jsonl
- needRef: raw exists but NO pipeline/data/verdicts/final/mint-<lang>-<i>.jsonl (also treat a final file with FEWER lines than its raw as needRef)
- needJudge: final exists, contains "refuter":"dispute" lines, but NO pipeline/data/verdicts/fixup/mint-<lang>-<i>.jsonl
Also check minttrial: final/minttrial-mixed-*.jsonl with dispute lines lacking fixup -> minttrialNeedJudge indexes.
Return perLang = {de:{totalBatches,needFull:[...],needRef:[...],needJudge:[...]}, it:{...}, es:{...}, minttrial:{needJudge:[...]}}. Arrays of integers, exact.`,
  { label: 'inventory', phase: 'Inventory', model: 'sonnet', effort: 'low', schema: INV })
if (!inv || !inv.ok) { log('Inventory failed'); return { aborted: 'inventory', inv } }
log(`Inventory: ${inv.notes}`)

// ---------- engine (v2, same contracts as phase1b) ----------
const V_RAW = (lang, i) => `pipeline/data/verdicts/raw/mint-${lang}-${i}.jsonl`
const V_FIN = (lang, i) => `pipeline/data/verdicts/final/mint-${lang}-${i}.jsonl`
const V_FIX = (lang, i) => `pipeline/data/verdicts/fixup/mint-${lang}-${i}.jsonl`
const QF = (lang) => `pipeline/data/queues/mint-${lang}.jsonl`

const adjP = (lang, i) => {
  const lo = i * BATCH + 1, hi = (i + 1) * BATCH
  return `${COMMON}
${RULES}
${ADDENDUM}
ADJUDICATOR, fluent in ${LNAME[lang]} and English. Read lines ${lo}-${hi} of ${QF(lang)} (sed -n '${lo},${hi}p'). Verdict per record: "mint" (the ONE alternative whose glosses show it teaches the record's glossed sense and is teachable) or "skip". shipTier from shipTierHint, downgraded to tail (or skip if enZipf>=5) unless unanimous across sources and obviously right.
Write one JSON line per record to ${V_RAW(lang, i)}: {key, verdict, target, shipTier, gender, plural, morphAuthority, pos, confidence:0-1, reason:"<short>"}. Cover EVERY line exactly once. Return counts (change=mint, gate=skip, disputed=0).`
}
const refP = (lang, i) => {
  const lo = i * BATCH + 1, hi = (i + 1) * BATCH
  return `${COMMON}
${RULES}
${ADDENDUM}
REFUTER, fluent in ${LNAME[lang]} and English. Verdicts for lines ${lo}-${hi} of ${QF(lang)} are in ${V_RAW(lang, i)}. Attack every mint and every skip with confidence<0.75: wrong/non-glossed sense? not teachable? missing morphology authority? Write ${V_FIN(lang, i)}: each raw line + "refuter":"agree"|"dispute" (+refuterReason) or "unreviewed". Never change verdicts yourself. Return counts with disputed = disputes.`
}
const judP = (lang, i, fin, fix, qf) => `${COMMON}
${RULES}
${ADDENDUM}
FINAL JUDGE (ships today). For each "refuter":"dispute" line in ${fin}, re-read its record in ${qf} (match by key) and rule; when in doubt: skip. Write ONLY disputed lines with final verdicts + "judge":"opus" to ${fix}. Return counts (disputed = rulings).`

const chainFromRef = (lang, i) =>
  agent(refP(lang, i), { label: `ref:mint:${lang}:${i}`, phase: 'Complete', model: 'sonnet', schema: BCOUNT })
    .then((r) => (r && r.disputed > 0)
      ? agent(judP(lang, i, V_FIN(lang, i), V_FIX(lang, i), QF(lang)), { label: `judge:mint:${lang}:${i}`, phase: 'Complete', model: 'opus', effort: 'high', schema: BCOUNT }).then(() => r)
      : r)

phase('Complete')
const work = []
for (const lang of MINT_LANGS) {
  const p = inv.perLang[lang] || {}
  for (const i of (p.needFull || [])) work.push({ lang, i, mode: 'full' })
  for (const i of (p.needRef || [])) work.push({ lang, i, mode: 'ref' })
  for (const i of (p.needJudge || [])) work.push({ lang, i, mode: 'judge' })
}
const mtJudge = ((inv.perLang.minttrial || {}).needJudge || [])
log(`Completing ${work.length} mint batches (+${mtJudge.length} minttrial judges)`)

const done = (await parallel([
  ...work.map((w) => () =>
    w.mode === 'full'
      ? agent(adjP(w.lang, w.i), { label: `adj:mint:${w.lang}:${w.i}`, phase: 'Complete', model: 'sonnet', schema: BCOUNT }).then((a) => a && chainFromRef(w.lang, w.i))
      : w.mode === 'ref'
        ? chainFromRef(w.lang, w.i)
        : agent(judP(w.lang, w.i, V_FIN(w.lang, w.i), V_FIX(w.lang, w.i), QF(w.lang)), { label: `judge:mint:${w.lang}:${w.i}`, phase: 'Complete', model: 'opus', effort: 'high', schema: BCOUNT })),
  ...mtJudge.map((i) => () =>
    agent(judP('mixed', i, `pipeline/data/verdicts/final/minttrial-mixed-${i}.jsonl`, `pipeline/data/verdicts/fixup/minttrial-mixed-${i}.jsonl`, 'pipeline/data/queues/minttrial-mixed.jsonl'), { label: `judge:minttrial:${i}`, phase: 'Complete', model: 'opus', effort: 'high', schema: BCOUNT })),
])).filter(Boolean)
log(`Completed ${done.length}/${work.length + mtJudge.length} chains`)

// ---------- Apply (mint only) ----------
phase('Apply')
const applies = await parallel(MINT_LANGS.map((lang) => () =>
  agent(`${COMMON}
Run pipeline/analysis/apply_verdicts.py --language ${lang} --ship-stratum strict applying MINT VERDICTS ONLY (mint-${lang}-*.jsonl plus the ${lang} rows of minttrial-mixed-*.jsonl; add a --mint-only flag if missing; NEVER apply audit-* files — the audit path failed its gate). Requirements: dedupe by key with minttrial verdicts winning (panel-verified); provenance check (target must be in the key's queue alternatives); nouns require authoritative gender+plural; tail entries confidence:"low", frequencyRank continuing after current max tail rank (offset >=1,000,000), enZipf<5.0, disjoint from core; core-gap only at unanimous>=3 sources AND confidence>=0.9 (else tail/drop). Idempotent via applied/ markers.
Then npm run validate:language-packs MUST pass (fix the script if not, never hand-edit packs). Report applied/skipped + validator status + new tail/core counts for ${lang}.`,
    { label: `apply:${lang}`, phase: 'Apply', model: 'sonnet', schema: APPLYR })))

const gates = await agent(`${COMMON}
Run from ${REPO}: npm run validate:language-packs && npm run typecheck && npm test && npm run build. Report pass/fail per gate, quoting failures. Do not fix product code.`,
  { label: 'gates:full', phase: 'Apply', model: 'sonnet', schema: SIMPLE })

// ---------- Review queue for the audit path ----------
phase('ReviewQueue')
const review = await agent(`${COMMON}
Compile the MORNING REVIEW QUEUE for the audit path (auto-apply failed its gate; a human one-click list is tonight's deliverable). Sources:
1. gold2 Opus labels: pipeline/data/gold2/gold2-{de,fr,it,es}.jsonl — every retarget/gate verdict with rationale (~70 rows; highest confidence, labeled at effort-high).
2. Engine v2 ship-stratum changes from the gold2 blind run: final/gold2-mixed-*.jsonl (+fixup), annotated with whether gold2 agreed (from pipeline/data/evidence/gold2-gate.json) — include measured precision per language so the reader knows the trust level.
Write docs/overnight-2026-07-12/audit-review-queue.jsonl (one row per proposed fix: {lang,key,source,currentTarget,proposedVerdict,proposedTarget,gender,plural,rationale,provenance,enZipf}, sorted enZipf DESC within lang) and audit-review-queue.md (readable summary: counts, precision context, top-20 preview per language). Return ok + counts in notes.`,
  { label: 'review-queue', phase: 'ReviewQueue', model: 'sonnet', schema: SIMPLE })

return { inventory: inv.perLang, completed: done.length, applies, gates, review }