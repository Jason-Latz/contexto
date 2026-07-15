# Mint adjudication workflow scripts — 2026-07-15 run

Two parameterized Workflow scripts drive tonight's ~100k-row mint adjudication.
The orchestrator launches them via the **Workflow tool** (which runs the `agent()`
calls); this doc is the launch/resume/apply reference. Nothing here writes packs —
the orchestrator runs `apply_verdicts.py` only for languages the panel ships.

- `mint-adjudicate.workflow.js` — order one language's mint queue by evidence
  priority, then adjudicator -> refuter -> judge per batch, writing verdict files.
- `mint-panel.workflow.js` — independently re-verify a sample of that language's
  ship-stratum mints and emit a ship/block verdict.

Run **one language per launch** (the args carry the language). Launch all four in
parallel if the concurrency budget allows; each is self-contained.

## Design vs the 2026-07-12 run

- **Batch 100 (was 45).** Fewer agents for ~100k rows. The adjudicator prompt adds
  attention-dilution mitigations: process in ~15-row groups, emit exactly one JSON
  verdict line per record, summarizing/collapsing/omitting rows is forbidden, and
  the output file must have one line per record.
- **`pipeline()` per batch (no global barrier).** Each batch flows
  adjudicator(sonnet) -> refuter(sonnet) -> judge(opus, high, disputes only)
  independently, so an early time-out leaves finished batches shippable.
- **Evidence priority ordering** so early stopping is graceful (best-evidenced
  first): (a) dictionary, >=2 collapsed votes; (b) T1; (c) dictionary single-vote;
  (d) T2; (e) wiktinv-only; (f) T3 non-noun; then any leftover. `preSkip` rows are
  dropped entirely and counted.
- **Prompt-policy deltas** (see below): Wikipedia-langlink artifacts, cognate rule,
  T3 strictness, verb-infinitive rule.

## Launch commands

### Adjudicate (per language)

```
Workflow({ scriptPath: "docs/overnight-2026-07-15/mint-adjudicate.workflow.js",
           args: { lang: "de", queuePath: "pipeline/data/queues/mint-de.jsonl",
                   batchSize: 100, maxBatches: null } })
```

Repeat with `lang` = `de` | `fr` | `it` | `es`. `queuePath` defaults to
`pipeline/data/queues/mint-<lang>.jsonl` — keep it the canonical path, because
`apply_verdicts.py` re-derives provenance from that exact file.

- `maxBatches: null` — adjudicate the whole queue (bounded by the ordered row count).
- `maxBatches: 1` — **SMOKE test**: one-batch dry run through the full chain.
- `batchSize` — rows per adjudicator call (default 100).
- `fileIndexBase` (optional, default 10000) — see "Batch indexing" below.

### Panel (per language, after adjudication)

```
Workflow({ scriptPath: "docs/overnight-2026-07-15/mint-panel.workflow.js",
           args: { lang: "de", sampleSize: 120, seed: 20260715 } })
```

`sampleSize` default 120, `seed` default 20260715, `perAgent` optional (default 20,
so ~6 Opus verifiers at 120). Panel bar: **errorRate <= 0.05 => `ship`, else `block`.**

## Batch indexing & why it can't collide

`apply_verdicts.py` and `build_mint_queue.load_already_adjudicated_keys` both glob
**exactly** `mint-<lang>-*.jsonl` (a `mint2-` prefix would NOT be picked up, so it is
not an option). The 2026-07-12 run wrote `mint-<lang>-0..131.jsonl`, all already
applied (`.done` markers in `verdicts/applied/`).

Tonight batch `i` (logical) maps to **file index `fileIndexBase + i` = `10000 + i`**.
This base is safely above the existing max (131) and is a **pure function of the
args**, so the logical-batch -> file-index map is identical on every relaunch — the
key property that makes resume exact. Old `mint-<lang>-N` files are skipped by their
`.done` markers; new `10000+` files are applied. No overwrite, no stale marker.

(The rebuilt queue already excludes 2026-07-12's adjudicated keys via
`load_already_adjudicated_keys`, so tonight's rows are disjoint from prior verdicts.)

## Resume semantics (data-level, resumable)

Relaunch the **same args**; completed work is skipped. Because the script has **no
filesystem access**, all persistence and the resume checks live **inside the agents**:

- **Prepare** — if `mint-<lang>.ordered.jsonl` exists and is non-empty, it is NOT
  rebuilt (rebuilding could reorder rows and break in-flight batch line-ranges); its
  line count is reused. Ordering is deterministic (bucket ASC, enZipf DESC, key ASC).
- **Adjudicator** — if `raw/mint-<lang>-<fi>.jsonl` already has >= its slice's lines,
  returns `resumed` and writes nothing.
- **Refuter** — if `final/mint-<lang>-<fi>.jsonl` already covers the raw file, returns
  `resumed` (reads the dispute count back from it).
- **Judge** — if `fixup/mint-<lang>-<fi>.jsonl` already rules every disputed key,
  returns `resumed`.
- **Panel** — sample file and each `panel-<lang>-<seed>-agent-<k>.jsonl` are reused if
  present; the reducer always recomputes from the per-agent files.

Every file is written **atomically** (`<path>.tmp` then `mv`), so a kill mid-write
never leaves a partial file that a resume would trust. `runIndex` for the panel is the
seed (no clock available), so re-running the same seed targets the same output files.

## File locations

- Ordered queue (input to batches): `pipeline/data/queues/mint-<lang>.ordered.jsonl`
- Raw verdicts (adjudicator): `pipeline/data/verdicts/raw/mint-<lang>-<10000+i>.jsonl`
- Final verdicts (refuter): `pipeline/data/verdicts/final/mint-<lang>-<10000+i>.jsonl`
- Judge fixups: `pipeline/data/verdicts/fixup/mint-<lang>-<10000+i>.jsonl`
- Panel sample: `pipeline/data/verdicts/panel/panel-<lang>-<seed>-sample.jsonl`
- Panel per-agent: `pipeline/data/verdicts/panel/panel-<lang>-<seed>-agent-<k>.jsonl`
- Panel verdict (orchestrator reads this): `pipeline/data/verdicts/panel/panel-<lang>-<seed>.json`

### Verdict schemas

Final/fixup mint verdict line (consumed by `apply_verdicts.py`):

```
{ "key", "verdict": "mint"|"skip", "target", "shipTier": "tail"|"core-gap",
  "gender", "plural", "pos", "morphAuthority", "confidence": 0..1, "reason",
  "refuter": "agree"|"dispute"|"unreviewed",   // final only
  "judge": "opus" }                            // fixup only (replaces the final row)
```

`apply_verdicts.py` re-derives ground truth from the canonical queue: the target must
be one of the key's `alternatives`; noun gender/plural come from that alternative's
`morph` (missing morph => skip). `ship_stratum_ok` = `confidence>=0.8` AND
(`refuter=="agree"` OR a `judge` field). This is why an upheld judge ruling keeps
`confidence>=0.8`.

Panel verdict json:

```
{ "lang", "runIndex", "seed", "sampled", "errors", "errorRate", "decision": "ship"|"block",
  "shipBar": 0.05, "perAgent": [{ "agent", "checked", "errors" }], "errorExamples": [...] }
```

## Prompt-policy deltas vs 2026-07-12

Carried forward (hard-won): adjudicate against the **entry gloss** (`entrSenses`), not a
vague "dominant sense"; **never** use the target's own back-translation as evidence
(circular); never invent a target (must be a listed alternative); noun morph only from
the alternative's authority; proper nouns / abbreviations / multiword junk / non-noun
source-identical cognates => skip; default to skip when torn.

Added tonight:
- **Wikipedia-langlink rows** (evidenceTier present, or `sources` include `wikipedia`):
  the pair comes from cross-language article titles. Skip **topic-link drift** (English
  article links to a related-but-different target topic, e.g. `lardon`->`albardar`) and
  correct **plural-form titles** (e.g. `mitochondria`) to the singular teaching lemma.
- **T3 rows have no authority backing** — be strictest; default skip unless
  independently certain.
- **Cognate identical to English** — fine for **nouns only** (the article differs);
  non-noun identical target teaches nothing => skip.
- **Verbs** — a verb mint's target must be the **bare infinitive** (packs render the
  infinitive only); a conjugated form/participle => skip.

## Apply step (orchestrator runs this, per shipped language only)

For each language whose `panel-<lang>-<seed>.json` says `"decision": "ship"`:

```
python3 pipeline/analysis/apply_verdicts.py --language <lang> --mint-only --ship-stratum strict
npm run validate:language-packs   # MUST pass; if not, fix apply_verdicts.py (never hand-edit packs)
npm run typecheck && npm test && npm run build
```

`--mint-only` applies only `mint-<lang>-*.jsonl` (+ this language's `minttrial-mixed`
rows), never `audit-*`/`regloss-*`. `--ship-stratum strict` no-ops any mint that isn't
refuter-agreed-or-judge-ruled with `confidence>=0.8`. Application is idempotent via
`verdicts/applied/<file>.done` markers, so re-running only applies new verdict files.
Languages whose panel says `block` ship nothing.

## Validation performed

`node --check` on a bare workflow file fails with "Illegal return statement" for
**every** script in this family (including 2026-07-12's shipped `phase1-adjudication`),
because the Workflow tool wraps the body in an `async` function where top-level
`await`/`return` are legal. Validated instead by wrapping the body in
`async () => { ... }` and syntax-checking that (harness-equivalent): both scripts pass.
