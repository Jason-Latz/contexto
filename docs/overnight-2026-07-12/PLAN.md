# Overnight 2026-07-12 — Multi-source vocabulary expansion + band-wide audit

Mission: wake up to **materially more words and materially fewer wrong words**, landed on
`main` in small gated commits. Two outputs from ONE engine:

1. **Audit & fix the existing band** — de/fr/it wrong-sense/wrong-gender (the documented
   ~15-30% systemic problem) plus the es residual, across the WHOLE band, not sampled slices.
2. **Net-new verified words** — tail shard for `enZipf < 5.0` (quarantined, lazy), plus
   core gap-fill for common-band words ONLY at unanimous multi-source agreement
   (Jason approved core gap-fill 2026-07-12).

## Non-negotiables (ship rules)

- **Gender/plural NEVER come from a model.** Authoritative source order: Wikidata lexemes >
  target-language Wiktextract > FreeDict > morphological derivation (es/fr/it only).
  A noun with no authoritative gender+plural is GATED, not shipped.
- **Tail ship gate:** >=2 independent sources agree on `target` AND sense-dominance passes
  adjudication. Core gap-fill: unanimous sources + adjudication pass -> `confidence:"high"`
  (common-band entries only render at high, per injector gate); otherwise don't add to core.
- **Models judge, sources author.** LLM roles: sense-dominance adjudication
  (proposer/refuter, Opus escalation on disagreement), candidate prioritization, QA.
- All tail invariants hold: `confidence:"low"`, `frequencyRank` +1,000,000, `enZipf<5.0`,
  core/tail disjoint, gender in per-language allowed set.
- Gates before every commit batch: `npm run validate:language-packs`, `npm test`,
  `npm run typecheck`, `npm run build`. Perf: the tuple-pack format (landed tonight by the
  other session, commits d74e032/d0c9308/be08ba0) converts source JSON at build time —
  keep editing SOURCE packs in `public/language-packs/`; run `node tests/live/run-perf.mjs`
  once after big pack growth.
- Small commits to main, one logical change each. Never break green. Do NOT submit to
  Chrome Web Store. No em dashes in prose. No time estimates in reports.

## Budget windows + resume protocol

- Usage window resets ~05:05-05:10 CDT; next reset ~5h later (~10:10 CDT).
- Window 0 (now->reset): Phase 0 infra (this file, foundry workflow).
- A persistent Monitor sleeper fires just after each reset to re-invoke the session.
- If a workflow dies mid-flight (API limit), note its runId in STATE.md and relaunch with
  `resumeFromRunId` after the sleeper fires — completed agents return from cache.
- **STATE.md in this directory is the live ledger**: every turn, append runIds, batch
  progress, commit hashes. After compaction, read PLAN.md + STATE.md first.
- Model delegation (Jason: minimize Fable tokens): Fable orchestrates only. Opus = gold
  labeling, escalation judge, final review. Sonnet = adapters, proposer/refuter, verify.
  Haiku = mechanical filtering/formatting only.

## Phase 0 — Foundry (running now, workflow `vocab-foundry-phase0`)

Background: kaikki de/fr/it dumps downloading to `pipeline/data/wikt-cache/kaikki-{de,fr,it}.jsonl`
(`.done` marker files on completion).

Agents build, each with an adversarial verifier:
- FreeDict eng-deu/fra/ita -> `pipeline/data/sources/freedict-eng-{de,fr,it}.jsonl`
- Apertium bidix (eng-spa + any usable eng-X) -> `pipeline/data/sources/apertium-eng-{lang}.jsonl`
- OMW/WordNet sense-ranked translations (the sense-dominance backbone) ->
  `pipeline/data/sources/omw-eng-{lang}.jsonl`
- Wikidata lexemes (gender+plural authority) -> `pipeline/data/sources/wikidata-lexemes-{lang}.jsonl`
- Gold set (prior audit ledgers + fresh Opus labels) -> `pipeline/data/gold/gold.jsonl`
- Candidate universe (real English, enZipf<5.0, not in core∪tail) -> `pipeline/data/universe/`

## Phase 1 — Window 2: audit the existing band

1. Deterministic evidence merge: for every existing de/fr/it/es entry, attach all source
   votes + OMW sense rank + which en-tr-cache sense bucket produced it.
2. Deterministic resolution clears agree/disagree-obvious cases (no tokens).
3. Adjudication fan-out on the residual: Sonnet proposer vs Sonnet refuter; disagreement ->
   Opus judge with all evidence. Calibrate thresholds on the gold set FIRST; report
   gold accuracy before touching packs.
4. Reconcile: keep / retarget (re-verified against sources) / gate (`eligible:false`).
   Commit per language per batch.

## Phase 2 — Windows 2-3: mint new words

1. Universe x sources -> candidates with >=2-source target agreement.
2. Adjudication (same engine) on sense-dominance + pedagogical value.
3. Nouns: attach authoritative gender/plural or gate. Build tail additions via a script
   that enforces every invariant; core gap-fill only at unanimous+high.
4. Validate, gates, perf test, commit per language per batch.

## Phase 3 — Morning

Full gate run + `node tests/live/run-perf.mjs`; update `CLAUDE.md` Current state +
this dir's `MORNING_REPORT.md` (before/after counts per language, gold-set accuracy of the
adjudication engine, error-rate estimates, sample fixes, what was gated and why, runIds,
token notes); update auto-memory (overnight-task.md pointer + data-quality-strategy).
