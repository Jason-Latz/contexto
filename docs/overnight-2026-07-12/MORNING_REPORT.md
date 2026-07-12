# Morning report — overnight vocab run, 2026-07-12

## Headline

**+3,169 new verified words shipped to main** (de +2,450 · it +447 · es +272), every one
backed by at least two independent dictionaries, morphology from an authoritative source
(never a model), and a three-stage LLM chain (adjudicator, refuter, judge) whose output
was measured at **1.18% error by an independent Opus panel** before anything shipped.
French shipped **zero** new words because it failed that same panel bar. That is the
system working, not failing.

**Zero existing entries were changed.** The audit engine, even after a measured 35-point
improvement, could not prove its confident changes safe (28-38% of them would have
corrupted a good entry), so its gate held and its output became a
**137-row human review queue** (`audit-review-queue.md`) instead of pack edits.

All gates green after shipping: validator (4 languages), typecheck, 124/124 node tests +
32 python tests, build (compact packs 108.8MB -> 30.2MB).

## Coverage now (core+tail)

| lang | before | after | delta |
|------|--------|-------|-------|
| es | 88,092 | 88,364 | +272 |
| de | 73,240 | 75,690 | +2,450 |
| fr | 72,132 | 72,132 | 0 (panel-blocked) |
| it | 68,856 | 69,303 | +447 |

All new words are tail entries (lazy-loaded, Aggressive Mode only): default page load and
lookup speed untouched by construction. No core-gap candidate cleared the unanimous
3-source + 0.9-confidence bar, so core packs are byte-identical. This composes with the
sibling session's compact tuple pack format (d74e032), which shipped tonight's larger
tails at 72% smaller parse cost.

## The real discovery: measured pack error rates

First representative (not verdict-stratified) Opus-labeled samples of the rendered band,
under the strict "the entry's gloss is the contract" policy:

- **de 10.0%** (n=150, uniform across frequency bands)
- **it 12.0%** (n=150)
- **fr 14.7%** (n=150, rising to **25% in the common band** — the Wiktextract-inversion
  wrong-sense flaw concentrates exactly where users see words most)
- **es 16.0%** (n=120 — higher than the prior "~90-100%" belief because this policy also
  counts non-teachables/gate-worthy entries as errors, not only wrong translations)

## What the night actually built (all committed, 16 commits)

1. **Four new source integrations** under `pipeline/sources/`: FreeDict eng-de/fr/it
   (880k rows), Apertium bidix (126k, es is trunk-quality), OMW/WordNet sense-ranked
   translations (363k rows, with a cross-sense pooling filter fixing upstream French
   WOLF contamination), Wikidata lexemes (266k lemmas with authoritative gender/plural;
   es file carries a known ~0.2% Portuguese-contamination denylist).
2. **Deterministic evidence merge** (`pipeline/analysis/merge_evidence.py`): all 302,320
   pack entries bucketed by source votes + en-Wiktextract sense buckets in ~16s.
3. **A calibrated shipping discipline**: gold calibration proved blind auto-apply unsafe
   (confirm bucket = 4.25% wrong); gold gate v1 failed; the Opus post-mortem found the
   two real failure modes (judge against the entry gloss, not the word's "dominant
   sense"; never accept the target's own back-translation as evidence) plus 52 stale
   gold rows; engine v2 with those lessons re-gated on fresh representative gold.
4. **The adjudication engine** (queue builders, verdict applier with invariant +
   provenance enforcement and idempotent markers, gold scorers) — all reusable for the
   next run.

## What was correctly refused

- **Audit auto-apply, all languages**: adjudicated ship-stratum falseChange de 37.5% /
  es 30.8% / fr 28.6% / it 27.8% vs the 2% bar. Proposed fixes went to the review queue.
- **French mints**: failed the per-language panel bar.
- **~1,725 de / 640 it mint "skips"**: the engine judged no candidate taught the glossed
  sense cleanly.

## Recoverable pools (next levers, biggest first)

1. **1,155 de nouns blocked only on morphology authority** (`mint_no_morph`) — a better
   Wikidata plural-form join likely unlocks most of them at zero quality cost.
2. **~200k single-source universe words** — admitting (en-tr-cache + target-language
   Wiktextract gloss-match) as an agreement pair, or stacking FreeDict eng-X as es
   already does, grows the mint universe without lowering the two-source bar.
3. **The 137-row review queue** — 69 rows are effort-high Opus labels (the most
   trustworthy); one click each in the morning.
4. **558 ship-stratum no-ops** (confidence/refuter near-misses) — re-adjudicable cheaply.
5. **fr mint re-trial** after diagnosing its panel failures (WOLF-derived OMW noise is
   the prime suspect).

## Run mechanics

Five workflows, ~790 agents, ~53M subagent tokens, two usage-window deaths survived with
zero lost work (data-level resume: verdict files + applied markers + self-excluding
queues). Model split: Sonnet did the volume (adjudication, refutation, sources), Opus
did judgment (gold labels, post-mortem, panel, disputed rulings), Fable orchestrated.
Full ledger: `STATE.md`. Perf note: headed perf test not run overnight (needs a
display); design guarantees hold (core untouched, tail lazy) — worth one
`node tests/live/run-perf.mjs` pass when convenient.
