# Overnight 2026-07-12 — live ledger (append every turn)

- 03:50 CDT — Other session's pack-format work already landed (d74e032 tuple format,
  d0c9308 tail round-trip, be08ba0 nit). Tree clean. Build on it; edit SOURCE packs only.
- 03:51 CDT — kaikki de/fr/it downloads started in background ->
  pipeline/data/wikt-cache/kaikki-{de,fr,it}.jsonl (.done markers on completion).
- 03:53 CDT — Phase 0 foundry workflow launched: runId **wf_c8ed516b-83b**
  (script: vocab-foundry-phase0-wf_c8ed516b-83b.js under the session workflows dir;
  resume with resumeFromRunId if it dies at the usage limit).
- 03:53 CDT — Persistent reset sleeper armed (Monitor task bcj0lb6kw, fires ~05:10 CDT).
  Re-arm a new sleeper each window (~10:10 CDT next) until the run is done.
- 04:08 CDT — Phase 0 COMPLETE (wf_c8ed516b-83b: 22 agents, 0 errors, ~1.48M tokens).
  Sources on disk under pipeline/data/sources/ (gitignored data, committed scripts):
  - freedict: de 772k rows (149.9k with gender; Ding; no glosses) · fr 15.7k (bare: no
    POS/gender — weak, enrichment-only) · it 92k (glosses, no gender). usable-with-care.
  - apertium: es 28.7k (TRUNK quality) · de 61.6k (nursery) · fr 15.4k (incubator,
    fra-eng repo) · it 20.1k (incubator). usable-with-care.
  - omw: es 164.8k · fr 137k · it 83.7k sense-ranked rows; NO German coverage.
    **BUG FOUND by verifier (fr REJECT 7/30): build_omw.py misattributes targets across
    senses** (die.v.03 -> "dé"). Repair queued; es/it need re-verify after fix.
  - wikidata lexemes: de 188.9k · fr 9.9k · it 34.1k · es 33.4k {lemma,gender,plural}.
    Two REJECT verdicts were verifier misfires (prompt assumed translation pairs; these
    are morphology-only). Real flag: possible pt contamination in es (conservadorismo).
    Morphology-specific re-verify queued. fr coverage thin (9.9k).
  - gold.jsonl: 3,331 records (3,191 prior-audit, ALL es; 140 fresh: 40 de/fr/it + 20 es).
    de/fr/it calibration rests on 40 each — thin; weight accordingly, expand if needed.
  - universe: 212,158 candidate English lemmas missing somewhere (en-candidates.jsonl).
    Note: pipeline/data/subtlex_ranked.json is a GERMAN freq list (mislabeled name).
  - kaikki de/fr/it dumps: DONE (~2.4GB), symlinked to wikt-cache/{German,French,Italian}.jsonl
    which is what import_wikt expects.
- 04:10 CDT — Committing Phase 0 scripts + docs (build_omw.py held back until repaired).
  Launching phase1-prep workflow: OMW repair, Wikidata morphology verify (+ es purity),
  evidence-merge builder (pipeline/analysis/merge_evidence.py), gold calibration.
- 04:47 CDT — Phase 1 prep COMPLETE (wf_d9b001fa-42f, 4 agents). Committed 72d0475,
  fa58c9b, 7a36803. Findings:
  - OMW bug was UPSTREAM (French WOLF wordnet pools targets across senses). Fixed via
    cross-sense pooling filter in build_omw.py; fr -9.2% rows, self-verify clean
    (fr 2/30 both unrelated one-off WOLF garbage; it/es 0/30).
  - Wikidata lexemes: de/fr trustworthy, it usable-with-care (~0.15-0.2% contamination),
    es has real pt contamination (~67% of 87 flagged; near-miss misspellings like
    lagosta/beleza). 356 contamination candidates listed in
    pipeline/data/qa_wikidata_lexeme_contamination_candidates.jsonl — apply as a
    DENYLIST when using wikidata-es as morphology authority.
  - Evidence merge: 302,320 entries bucketed (see notes in journal wf_d9b001fa-42f).
    de structurally CANNOT get flag-retarget (no OMW German) — its wrong-sense errors
    hide in ambiguous/confirm; the LLM engine must carry de via entr sense buckets +
    slim-de glosses. Slim wikt caches built: wikt-cache/slim-{de,fr,it}.jsonl.
  - CALIBRATION (opus, pipeline/data/evidence/calibration-report.md): AUTO-APPLY
    NOTHING. confirm FP 4.25% (>2% bar), flag-retarget precision only 12% (alternatives
    are usually synonyms of a fine target), morphology flags weak at tiny n. de/fr/it
    uncalibrated (40 gold rows each). => Deterministic layer = evidence enrichment only;
    ALL shipping decisions go through the LLM engine, which must first PASS THE GOLD
    GATE (falseKeep<2% AND falseChange<2% vs gold).
- 04:55 CDT — Authored the Phase 1/2 mega-workflow:
  **docs/overnight-2026-07-12/phase1-adjudication.workflow.js** — queues (audit+mint+
  gold, resume-aware) -> gold gate (2 attempts, opus retest) -> interleaved fan-out
  (340 batches x 45, adjudicator->refuter->opus judge) -> per-lang apply (sole pack
  writer, invariants + provenance enforced) -> full gates. Re-launch the SAME file for
  each subsequent run; queues exclude already-adjudicated keys. If a run dies at the
  usage limit, just relaunch (or resumeFromRunId).
- 04:44 CDT — Mega-workflow LAUNCHED early (used the window's last minutes): runId
  **wf_9e2f8021-090**. Continuation is DATA-LEVEL (verdict files + applied markers +
  queues excluding adjudicated keys): if a run dies, relaunch the same scriptPath
  FRESH — do NOT resumeFromRunId across a limit death (a cached compare-gold result
  could carry stale partial-data metrics).
- 05:12 CDT — Woke on reset timer; new 5h window. Workflow SURVIVED the boundary:
  queues built (audit de 70.9k / es 82.8k / fr 70.1k / it 66.9k; mint de 5,927 /
  it 1,201 / fr 704 / es 587; gold 399 blind + answers), 9/9 gold batches through
  adjudicator+refuter, compare agent pending. NOTE for morning: mint queues are small —
  the >=2-independent-source vote filter is the binding constraint on new words, not
  compute (~8.4k candidates from a 212k universe). If more volume is wanted, the lever
  is counting (en-tr-cache + target-lang wiktextract gloss-match) as an agreement pair,
  or importing another source — quality bar stays.
- Next sleeper armed for ~10:11 CDT (Monitor bykjykgs0).
- 05:25 CDT — wf_9e2f8021-090 COMPLETED: **GOLD GATE FAILED, correctly shipped NOTHING**
  (pooled agreement 57.4%, falseKeep 46.2%, falseChange 18.3%; but de 85%/8.8%,
  fr 70%/20.6%, it 75%/17.6% at n=40 each; es 49%/21.3% at n=279 dominates the pool).
  Three suspected artifacts, not necessarily engine failure:
  (1) es gold slice is verdict-stratified from prior audit runs AND ~390 of those fixes
  were ALREADY APPLIED to packs 2026-07-07/08 -> "keep" on an already-fixed entry is
  scored falseKeep (stale gold). (2) Gate metric over-constrained: only CHANGES ship, so
  the guarding metric is falseChange on the SHIP STRATUM (unanimous chain + conf>=0.8),
  not raw falseKeep. (3) de/fr/it n=40 too small to certify either way.
- 05:27 CDT — Launched **phase1b-recalibrate.workflow.js** (runId wf_5d8075d5-dca):
  Opus postmortem (stale-gold count, failure modes, promptAddendum fed into engine v2
  prompts at runtime) + representative gold2 (de/fr/it 150, es 120, stratified by band
  NOT verdict) + engine v2 re-gate (unlock per language: shipFalseChange<2%, n>=15) +
  mint trial (360 rows -> unanimous chain -> independent Opus panel; unlock:
  panel error <2%) + auto fan-out of ONLY unlocked paths (mint-first, 300 batches) +
  strict-stratum apply + full gates. If it returns aborted:'nothing-unlocked', read
  pipeline/data/evidence/{gold-gate-postmortem,gold2-gate,mint-trial-panel}.md before
  deciding anything.
- 05:40 CDT — phase1b run 1 aborted on a SCRIPT bug (postmortem set ok=false to mean
  "engine v1 has real flaws"; my abort condition read it as "postmortem failed").
  Postmortem substance (pipeline/data/evidence/gold-gate-postmortem.md):
  * 52 stale gold rows (fixes already in packs) -> real pooled falseKeep 28.2%, not 46%.
  * ROOT INSIGHT: adjudicate against the ENTRY GLOSS (the hover contract), not the
    word's "dominant sense" — all 33 real es misses were this. currentTargetGlosses is
    CIRCULAR evidence (target's own back-translation), never corroboration.
  * v1 confident changes corrupt MOST: ship-stratum falseChange 24.2% pooled
    (es 34.5 / fr 26.7 / de 9.1 / it 9.1). v2 addendum targets synonym-churn,
    morphology-overgate, no-evidence-overgate, polysemy-overgate.
  * Representative pack error rates (gold2, Opus-labeled): de ~10.0% uniform across
    bands; fr ~14.7% overall but 25% in the common band (es/it in journal
    wf_5d8075d5-dca). Morning-report material.
  * Gold label noise ~2-3% => gate now uses ADJUDICATED ship-stratum falseChange
    (compare agent classifies each disagreement engine-wrong vs gold-suspect, opus).
  Fixed both in phase1b-recalibrate.workflow.js; RESUMED with resumeFromRunId
  wf_5d8075d5-dca at 05:41 (pm + 4 gold2 agents replay from cache; Regate onward live).
