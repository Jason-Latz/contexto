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
- NEXT (on prep completion or 05:10 wake): read calibration numbers; if confirm-bucket
  precision is high, commit prep, then launch the Phase 1 adjudication mega-workflow on
  the flagged/ambiguous residual (sonnet proposer/refuter -> opus escalation).
  Do NOT ship any pack change before gold calibration numbers exist.
