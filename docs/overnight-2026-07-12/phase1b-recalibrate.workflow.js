// Phase 1b: post-mortem the failed gold gate, expand gold representatively, re-gate a
// policy-hardened engine v2 on the SHIP-STRATUM metric (only changes ship; unanimous
// chain + confidence>=0.8), trial the mint path against an independent panel, and
// auto-continue to the fan-out ONLY if the numbers clear.
export const meta = {
  name: 'vocab-phase1b-recalibrate',
  description: 'Gold-gate post-mortem + representative gold expansion + engine v2 re-gate + mint trial, then gated fan-out',
  phases: [
    { title: 'Postmortem', detail: 'classify all 131 gate failures; detect stale gold', model: 'opus' },
    { title: 'GoldExpand', detail: 'representative Opus labels: de/fr/it 150 each, es 120', model: 'opus' },
    { title: 'Regate', detail: 'engine v2 blind over gold2; ship-stratum falseChange must clear', model: 'sonnet' },
    { title: 'MintTrial', detail: 'mint sample -> unanimous chain -> independent panel error rate', model: 'sonnet' },
    { title: 'Adjudicate', detail: 'fan-out for languages/paths that cleared', model: 'sonnet' },
    { title: 'Apply', detail: 'strict ship-stratum apply + full gates', model: 'sonnet' },
  ],
}

const REPO = '/Users/jason/Downloads/CS Classes/Projects/Textum'
const BATCH = 45
const MAX_BATCHES = 300
const LANGS = ['de', 'fr', 'it', 'es']
const LNAME = { de: 'German', fr: 'French', it: 'Italian', es: 'Spanish' }

const COMMON = `Repo: ${REPO}. python3 available. Do NOT git commit. public/language-packs/ is READ-ONLY except for pipeline/analysis/apply_verdicts.py in the Apply stage. Scripts in pipeline/analysis/, data in pipeline/data/. Your final message is machine-read — return the structured output only.`

const RULES = `NON-NEGOTIABLE RULES:
- Never invent a translation: a retarget/mint target must be one of the queue record's listed alternatives (each from a real dictionary source).
- Noun gender/plural come ONLY from the record's morph authority fields; no authority => gate/skip.
- POLICY (v2, learned from the failed gate):
  * RETARGET only when the CURRENT target teaches a WRONG or clearly non-dominant sense. If the current target is a correct rendering of the dominant sense, verdict is keep even when an alternative is arguably better — synonym churn is a defect, not an improvement.
  * GATE: proper nouns, demonyms, toponyms, abbreviations, multiword junk, vulgar-only glosses, non-noun targets identical to the English source; AND highly polysemous common English words (enZipf>=4.5 with many distinct entrSenses) where no single target cleanly owns the dominant sense.
  * DEFAULT TO KEEP when the current target is plausibly right; default to gate/skip when torn between change options. Never split the difference with a low-confidence change.
  * Confidence honesty: only changes with confidence>=0.8 AND refuter agreement will ship; a change you rate 0.6 is a wasted change — rate honestly.`

const SIMPLE = { type: 'object', required: ['ok', 'notes'], properties: { ok: { type: 'boolean' }, notes: { type: 'string' } } }
const BCOUNT = { type: 'object', required: ['keep', 'change', 'gate', 'disputed'], properties: { keep: { type: 'number' }, change: { type: 'number' }, gate: { type: 'number' }, disputed: { type: 'number' } } }
const PM = {
  type: 'object', required: ['ok', 'staleGoldCount', 'failureModes', 'promptAddendum', 'notes'],
  properties: { ok: { type: 'boolean' }, staleGoldCount: { type: 'number' }, failureModes: { type: 'object' }, promptAddendum: { type: 'string', maxLength: 1600 }, notes: { type: 'string' } },
}
const GOLD2 = { type: 'object', required: ['ok', 'rows', 'estPackErrorRate', 'notes'], properties: { ok: { type: 'boolean' }, rows: { type: 'number' }, estPackErrorRate: { type: 'number' }, notes: { type: 'string' } } }
const REGATE = {
  type: 'object', required: ['ok', 'perLang', 'notes'],
  properties: { ok: { type: 'boolean' }, perLang: { type: 'object' }, notes: { type: 'string' } },
}
const MINTM = {
  type: 'object', required: ['ok', 'sampled', 'unanimous', 'panelErrorRate', 'perLangErrorRate', 'notes'],
  properties: { ok: { type: 'boolean' }, sampled: { type: 'number' }, unanimous: { type: 'number' }, panelErrorRate: { type: 'number' }, perLangErrorRate: { type: 'object' }, notes: { type: 'string' } },
}
const APPLYR = { type: 'object', required: ['ok', 'applied', 'skipped', 'notes'], properties: { ok: { type: 'boolean' }, applied: { type: 'number' }, skipped: { type: 'number' }, notes: { type: 'string' } } }

// ---------- Postmortem + gold expansion (parallel) ----------
phase('Postmortem')
log('Post-mortem of gate attempt 2 + representative gold expansion')

const pmP = agent(`${COMMON}
POST-MORTEM of the failed gold gate (pipeline/data/evidence/gold-gate-attempt2.{json,md}). Inputs: verdicts pipeline/data/verdicts/final/gold-mixed-*.jsonl (+fixup), answer key pipeline/data/queues/gold-answers.jsonl, blind queue pipeline/data/queues/gold-queue.jsonl, current packs (read-only), original gold pipeline/data/gold/gold.jsonl.
For EVERY disagreement (96 falseKeeps + 35 falseChanges):
1. STALE-GOLD CHECK FIRST: many prior-audit es gold rows were mined from audit runs whose fixes were ALREADY APPLIED to the packs on 2026-07-07/08. If gold says retarget->X and the pack's CURRENT target already equals X (or gold says gate and the entry is already eligible:false), the engine's "keep" was CORRECT and the gold row is STALE. Count these exactly.
2. Classify the rest: polysemy-policy miss (engine kept a polysemous common word gold gates), proper-noun/teachability miss, synonym-churn (engine changed a fine target), genuine wrong-sense miss, morphology, gold-label-suspect (quote why).
3. Recompute the REAL metrics after removing stale rows: agreement, falseKeep, falseChange per language; ALSO falseChange restricted to the ship-stratum (refuter=="agree" or judge-ruled, confidence>=0.8).
Write pipeline/data/evidence/gold-gate-postmortem.{json,md}. Return staleGoldCount, failureModes (mode->count), and promptAddendum: <=1600 chars of the most valuable CONCRETE instructions (with 2-3 verbatim example mistakes) to add to the adjudicator prompt to prevent the observed failure modes.`,
  { label: 'postmortem', phase: 'Postmortem', model: 'opus', effort: 'high', schema: PM })

const goldExpand = parallel(LANGS.map((lang) => () =>
  agent(`${COMMON}
You are labeling GROUND TRUTH for ${LNAME[lang]}. Draw a REPRESENTATIVE sample (stratified by enZipf band and evidence bucket, NOT by expected verdict) of ${lang === 'es' ? 120 : 150} rendered-band entries from pipeline/data/queues/audit-${lang}.jsonl, EXCLUDING keys present in pipeline/data/queues/gold-queue.jsonl. Random seed 20260712.
For each entry judge with great care (you are fluent in ${LNAME[lang]} and English): verdict keep/retarget/gate under this policy — retarget ONLY if the current target teaches a wrong/non-dominant sense (correct-but-improvable = keep); gate proper nouns/non-teachables and polysemous common words with no clean dominant target; also judge genderOk/pluralOk for nouns.
Write pipeline/data/gold2/gold2-${lang}.jsonl: {lang,key,source,target,verdict,correctedTarget,correctedGender,correctedPlural,genderOk,pluralOk,rationale}. correctedTarget MUST come from the record's alternatives (or null with verdict gate).
Return rows and your estimated per-band error rate of the ${lang} pack in notes.`,
    { label: `gold2:${lang}`, phase: 'GoldExpand', model: 'opus', effort: 'high', schema: GOLD2 })))

const pm = await pmP
const gold2 = (await goldExpand).filter(Boolean)
if (!pm || !pm.ok || gold2.length < 4) {
  log('Postmortem or gold expansion failed — stopping for manual review')
  return { aborted: 'postmortem-or-gold2', pm, gold2 }
}
log(`Postmortem: ${pm.staleGoldCount} stale gold rows; modes=${JSON.stringify(pm.failureModes)}. Gold2: ${gold2.map((g) => g.rows).join('/')} rows.`)

const ADDENDUM = `LEARNED FAILURE MODES (from tonight's measured gate failures — take these seriously):
${pm.promptAddendum}`

// ---------- engine v2 ----------
const V_RAW = (kind, lang, i) => `pipeline/data/verdicts/raw/${kind}-${lang}-${i}.jsonl`
const V_FIN = (kind, lang, i) => `pipeline/data/verdicts/final/${kind}-${lang}-${i}.jsonl`
const V_FIX = (kind, lang, i) => `pipeline/data/verdicts/fixup/${kind}-${lang}-${i}.jsonl`
const QFILE = (kind, lang) => `pipeline/data/queues/${kind}-${lang}.jsonl`

function adjPrompt(kind, lang, i, qfile) {
  const lo = i * BATCH + 1, hi = (i + 1) * BATCH
  const mint = kind.startsWith('mint')
  return `${COMMON}
${RULES}
${ADDENDUM}
You are the ADJUDICATOR, fluent in ${LNAME[lang] || 'the target language (mixed file: each record names its lang)'} and English. Read lines ${lo}-${hi} of ${qfile} (sed -n '${lo},${hi}p'). Each line carries EVIDENCE: source votes, English sense buckets with glosses, OMW sense ranks, target-language glosses.
${mint
  ? 'Verdict per record: "mint" (the ONE alternative whose glosses show it teaches the DOMINANT everyday sense, and is teachable) or "skip". shipTier: from shipTierHint, downgraded to tail (or skip if enZipf>=5) unless unanimous across sources and obviously right.'
  : 'Verdict per record: "keep" / "retarget" (only if current teaches a wrong or non-dominant sense; newTarget/newGender/newPlural from the chosen alternative record) / "gate".'}
Write one JSON line per record to ${V_RAW(kind, lang, i)} (create dirs): {key, verdict${mint ? ', target, shipTier, gender, plural, morphAuthority' : ', newTarget, newGender, newPlural, morphAuthority'}, pos, confidence:0-1, reason:"<short>"}. Cover EVERY line exactly once. Return counts (change=${mint ? 'mint' : 'retarget'}, gate=${mint ? 'skip' : 'gate'}, disputed=0).`
}
function refPrompt(kind, lang, i, qfile) {
  const lo = i * BATCH + 1, hi = (i + 1) * BATCH
  return `${COMMON}
${RULES}
${ADDENDUM}
REFUTER pass, fluent in ${LNAME[lang] || 'each record\'s language'} and English. Verdicts for lines ${lo}-${hi} of ${qfile} are in ${V_RAW(kind, lang, i)}. Attack every change (${kind.startsWith('mint') ? 'mint' : 'retarget/gate'}), every keep with confidence<0.75, and ~20% of remaining keeps: does the evidence truly support it? Wrong/non-dominant sense? Synonym churn mislabeled as retarget? Missing morphology authority?
Write ${V_FIN(kind, lang, i)}: each raw line + "refuter":"agree"|"dispute" (+refuterReason) or "unreviewed". Never change verdicts yourself. Return counts with disputed = disputes.`
}
function judgePrompt(kind, lang, i, qfile) {
  return `${COMMON}
${RULES}
${ADDENDUM}
FINAL JUDGE (ships tonight). For each "refuter":"dispute" line in ${V_FIN(kind, lang, i)}, re-read its record in ${qfile} (match by key) and rule. When in doubt: keep (audit) / skip (mint). Write ONLY disputed lines with final verdicts + "judge":"opus" to ${V_FIX(kind, lang, i)}. Return counts (disputed = rulings).`
}
const runBatch = (kind, lang, i, qfile) =>
  agent(adjPrompt(kind, lang, i, qfile), { label: `adj:${kind}:${lang}:${i}`, phase: kind === 'gold2' ? 'Regate' : kind === 'minttrial' ? 'MintTrial' : 'Adjudicate', model: 'sonnet', schema: BCOUNT })
    .then((a) => a && agent(refPrompt(kind, lang, i, qfile), { label: `ref:${kind}:${lang}:${i}`, phase: kind === 'gold2' ? 'Regate' : kind === 'minttrial' ? 'MintTrial' : 'Adjudicate', model: 'sonnet', schema: BCOUNT }))
    .then((r) => (r && r.disputed > 0)
      ? agent(judgePrompt(kind, lang, i, qfile), { label: `judge:${kind}:${lang}:${i}`, phase: kind === 'gold2' ? 'Regate' : kind === 'minttrial' ? 'MintTrial' : 'Adjudicate', model: 'opus', effort: 'high', schema: BCOUNT }).then(() => r)
      : r)

// ---------- Regate on gold2 ----------
phase('Regate')
const g2prep = await agent(`${COMMON}
Build the blind gold2 queue: pipeline/analysis/build_audit_queue.py logic (reuse/import it) enriches the entries whose keys appear in pipeline/data/gold2/gold2-{de,fr,it,es}.jsonl, shuffled (seed 20260712), WITHOUT any verdict fields -> pipeline/data/queues/gold2-mixed.jsonl; answer key (verdicts) -> pipeline/data/queues/gold2-answers.jsonl. Also PATCH pipeline/analysis/apply_verdicts.py to accept --ship-stratum strict: changes apply ONLY when (refuter=="agree" OR line has judge ruling in fixup) AND confidence>=0.8; everything else is a no-op keep/skip. Self-test the patch on a fixture. Return rows count in notes as "rows=N".`,
  { label: 'gold2:prep', phase: 'Regate', model: 'sonnet', schema: SIMPLE })
if (!g2prep || !g2prep.ok) { log('gold2 prep failed'); return { aborted: 'gold2-prep', pm, g2prep } }
const g2rows = parseInt((g2prep.notes.match(/rows=(\d+)/) || [0, 570])[1], 10)
const g2batches = Math.ceil(g2rows / BATCH)
log(`Regate: ${g2rows} blind gold2 rows in ${g2batches} batches`)
await parallel(Array.from({ length: g2batches }, (_, i) => () => runBatch('gold2', 'mixed', i, 'pipeline/data/queues/gold2-mixed.jsonl')))

const regate = await agent(`${COMMON}
Write/refresh pipeline/analysis/compare_gold2.py: join final/gold2-mixed-*.jsonl (+fixup overrides) against pipeline/data/queues/gold2-answers.jsonl BY KEY. Per language report n, agreement, falseKeepRate (informational only), and the DECISIVE metric shipStratumFalseChangeRate = among changes that satisfy (refuter=="agree" OR judge-ruled) AND confidence>=0.8, the fraction where gold2 says keep. Also report nShipChanges per language. Write pipeline/data/evidence/gold2-gate.{json,md} with confusion matrices + quoted failures. Return perLang = {lang: {n, agreement, falseKeep, shipFalseChange, nShipChanges}}.`,
  { label: 'gold2:compare', phase: 'Regate', model: 'sonnet', schema: REGATE })

const auditPass = {}
if (regate && regate.ok) {
  for (const lang of LANGS) {
    const m = regate.perLang[lang]
    auditPass[lang] = !!m && m.shipFalseChange < 0.02 && m.nShipChanges >= 15
  }
}
log(`Regate verdict: ${JSON.stringify(regate && regate.perLang)}; audit unlock: ${JSON.stringify(auditPass)}`)

// ---------- Mint trial ----------
phase('MintTrial')
const mtprep = await agent(`${COMMON}
Build the mint trial sample: stratified random (seed 20260712) from pipeline/data/queues/mint-{de,fr,it,es}.jsonl — de 150, it 90, fr 70, es 50 rows -> pipeline/data/queues/minttrial-mixed.jsonl (keep each record's lang field). Return rows in notes as "rows=N".`,
  { label: 'minttrial:prep', phase: 'MintTrial', model: 'sonnet', schema: SIMPLE })
const mtrows = parseInt(((mtprep && mtprep.notes.match(/rows=(\d+)/)) || [0, 360])[1], 10)
const mtbatches = Math.ceil(mtrows / BATCH)
await parallel(Array.from({ length: mtbatches }, (_, i) => () => runBatch('minttrial', 'mixed', i, 'pipeline/data/queues/minttrial-mixed.jsonl')))

const mintPanel = await agent(`${COMMON}
INDEPENDENT PANEL AUDIT of the mint trial. Collect every unanimous-chain mint (verdict mint, refuter agree or judge-ruled, confidence>=0.8) from final/minttrial-mixed-*.jsonl (+fixup). For EACH, verify from scratch as a fluent speaker with the queue evidence (pipeline/data/queues/minttrial-mixed.jsonl): (a) target is a correct translation of the English word's dominant everyday sense, (b) noun gender/plural correct per the cited authority, (c) genuinely teachable. Be adversarial — you are the last line before these ship.
Write pipeline/data/evidence/mint-trial-panel.{json,md} with every failure quoted. Return sampled (=trial rows), unanimous (=ship-eligible count), panelErrorRate (errors/unanimous), perLangErrorRate.`,
  { label: 'minttrial:panel', phase: 'MintTrial', model: 'opus', effort: 'high', schema: MINTM })

const mintPass = {}
if (mintPanel && mintPanel.ok) {
  for (const lang of LANGS) {
    const r = mintPanel.perLangErrorRate[lang]
    mintPass[lang] = mintPanel.panelErrorRate < 0.02 && (r === undefined || r < 0.03)
  }
}
log(`Mint trial: ${mintPanel && mintPanel.unanimous}/${mintPanel && mintPanel.sampled} unanimous, panel error ${mintPanel && mintPanel.panelErrorRate}; unlock: ${JSON.stringify(mintPass)}`)

// ---------- Gated fan-out ----------
phase('Adjudicate')
const descriptors = []
const per = {}
const auditCounts = { de: 70926, fr: 70142, it: 66898, es: 82821 }
const mintCounts = { de: 5927, it: 1201, fr: 704, es: 587 }
for (const lang of LANGS) {
  per[`audit:${lang}`] = auditPass[lang] ? Math.ceil(auditCounts[lang] / BATCH) : 0
  per[`mint:${lang}`] = mintPass[lang] ? Math.ceil(mintCounts[lang] / BATCH) : 0
}
for (let i = 0; descriptors.length < MAX_BATCHES; i++) {
  let added = false
  for (const lang of LANGS) {
    for (const kind of ['mint', 'audit']) { // mint first: "more words" is the headline ask
      if (i < per[`${kind}:${lang}`] && descriptors.length < MAX_BATCHES) { descriptors.push({ kind, lang, i }); added = true }
    }
  }
  if (!added) break
}
if (descriptors.length === 0) {
  log('Nothing unlocked — returning for manual review')
  return { aborted: 'nothing-unlocked', pm, regate, mintPanel, auditPass, mintPass }
}
log(`Fan-out: ${descriptors.length} batches (mint-first). Unlocked audit: ${LANGS.filter((l) => auditPass[l])}; mint: ${LANGS.filter((l) => mintPass[l])}`)
const stats = (await parallel(descriptors.map((d) => () => runBatch(d.kind, d.lang, d.i, QFILE(d.kind, d.lang))))).filter(Boolean)
log(`Adjudicated ${stats.length}/${descriptors.length} batches`)

// ---------- Apply + gates ----------
phase('Apply')
const applies = await parallel(LANGS.filter((l) => auditPass[l] || mintPass[l]).map((lang) => () =>
  agent(`${COMMON}
Run pipeline/analysis/apply_verdicts.py --language ${lang} --ship-stratum strict (sole pack writer for ${lang}; audit files only if ${auditPass[lang] ? 'YES' : 'NO — skip audit files'}, mint files only if ${mintPass[lang] ? 'YES' : 'NO — skip mint files'}). Then npm run validate:language-packs MUST pass (fix the script, never hand-edit packs). Report applied/skipped + validator status.`,
    { label: `apply:${lang}`, phase: 'Apply', model: 'sonnet', schema: APPLYR })))

const gates = await agent(`${COMMON}
Run from ${REPO}: npm run validate:language-packs && npm run typecheck && npm test && npm run build. Report pass/fail per gate, quoting failures. Do not fix product code.`,
  { label: 'gates:full', phase: 'Apply', model: 'sonnet', schema: SIMPLE })

return {
  pm: { staleGoldCount: pm.staleGoldCount, failureModes: pm.failureModes },
  regate: regate && regate.perLang, auditPass, mintPass,
  mintPanel: mintPanel && { unanimous: mintPanel.unanimous, panelErrorRate: mintPanel.panelErrorRate },
  batchesRun: stats.length, batchesPlanned: descriptors.length, applies, gates,
  moreWorkRemains: Object.values(per).reduce((s, n) => s + n, 0) > descriptors.length,
}