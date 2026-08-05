# CLAUDE.md — Contexto

> Living context doc (workspace Tenet 2). Keep it lean, high-level, and durable —
> no volatile selectors, regexes, or line numbers. Update it when structure,
> commands, conventions, or state change.

## Working conventions

- Prefer frequent, small checkpoint commits. Once a coherent unit of work is
  verified, commit it promptly rather than accumulating unrelated changes.
- Keep each commit single-purpose and exclude unrelated user or agent work from
  the shared working tree.

## Product contract

Contexto is a Chrome extension for passive language immersion: it swaps a
user-controlled percentage of eligible English words on any web page for their
equivalents in the chosen target language (**Spanish, German, French, or
Italian**), showing the English source + definition on hover and saving
click-to-mark unknown words for export. Fully on-device — no runtime network
calls.

**Naming:** the repo folder is `Textum`, but the product is **Contexto**.

## Architecture map

- `src/` — extension source (content scripts, popup logic, word injector).
- `src/language/` — per-language grammar adapters (`{spanish,german,french,italian}Adapter.ts`),
  shared article detection (`articles.ts`), dispatch (`replacement.ts`), and the
  `registry.ts` source of truth for supported languages + allowed genders.
- `pipeline/import_wikt/` — Wiktextract → pack importer (de/fr/it). `pipeline/import_es/` —
  the original FreeDict-based Spanish importer. `pipeline/import_tail/` — builds the niche
  **tail** shards from the English Wiktextract translation tables. `scripts/` — validate/QA
  tooling (`stream_en_translations.py` reduces the 3GB English dump to a small cache).
- `public/language-packs/` — bundled shards per language: `<lang>.json` (**core**, eager) +
  `<lang>.tail.json` (**niche tail**, lazy). Only the active language's shards load at runtime.
- `popup/` — popup UI source (incl. the target-language picker).
- `dist/` — build output (gitignored); what you load unpacked in Chrome.
- `release/` — packaged `.zip` for the store (gitignored).
- `site/` — the **NEW** static landing site (deploys to Vercel, root dir = `site/`).
- `store-assets/` — Chrome Web Store listing draft + assets.
- `fixtures/` — local test pages (e.g. `spanish-article.html`).

## Commands

Extension (see `package.json`):

```bash
npm run build      # build extension into dist/
npm test           # TS unit tests + python pipeline tests
npm run typecheck  # tsc --noEmit
npm run package    # build + zip into release/
npm run validate:language-packs            # validates es/de/fr/it core + *.tail shards
npm run build:language-pack -- --language de   # rebuild a de/fr/it core pack from its Wiktextract cache
npm run test:live-multilang                # headed: screenshot de/fr/it replacement (needs `npm run build` first)
npm run test:live-tab-sync                 # headed: settings-sync + page-status gate (needs build); red/green, exits 1

# Niche tail shards (public/language-packs/<lang>.tail.json):
curl -s --compressed https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl \
  | python3 scripts/stream_en_translations.py pipeline/data/en-tr-cache.jsonl   # ~13 min, one-time
python3 -m pipeline.import_tail.build --language es --wikt-extract pipeline/data/kaikki-es.jsonl
node tests/live/run-perf.mjs               # headed: multi-site core-vs-default-tail perf (needs build)
```

Site (static, no build step):

```bash
# preview the site
cd site && python3 -m http.server
```

The site lives in `site/` and deploys to **Vercel with Root Directory = `site`**.

## Multi-language (de/fr/it) — 2026-06

- **Picker:** popup target-language selector (`src/popup/LanguagePicker.ts`) persists
  `settings.targetLanguage`; the content script loads `language-packs/<lang>.json` and
  dispatches grammar via `buildReplacement(activeTargetLanguage, …)`.
- **Grammar adapters** render articles/gender/plural per language: German der/die/das +
  ein/eine + **neuter** + noun **capitalization**; French le/la/l'/les + élision; Italian
  il/lo/la/l'/i/gli/le + un/uno/una/un'. Spanish unchanged. Covered by per-language tests.
- **Data:** de/fr/it packs are built by `pipeline/import_wikt` by INVERTING a kaikki
  target-language Wiktextract extract (gloss→word), giving authoritative gender + plural.
  Extracts cache under `pipeline/data/wikt-cache/` (gitignored; re-download from kaikki.org).
  ≥50k entries each; all `medium` tier so the rare long-tail renders and the common band is
  gated (mirrors Spanish). `enZipf` MUST match `qa_language_pack.py` (re-QA must be a no-op).
- **Adding a language:** add it to `TargetLanguage`, `src/language/registry.ts`,
  `GENDERS_BY_LANGUAGE` in the validator, a `<lang>Adapter.ts` + dispatch entry, and build
  the pack. The loader/injector/popup are already language-generic.

## Vocabulary tiers — core + progressive niche tail (2026-07-15)

Each language ships two shards. **This is the performance design: the full vocabulary
works by default, and the tail must never block or slow the core first pass.**

- **core** (`<lang>.json`) — curated, frequency-ranked, high/medium-confidence. Loaded
  eagerly on every page; the first replacement pass waits only on this.
- **tail** (`<lang>.tail.json`) — niche, `low`-confidence long-tail words (real English
  words gated on `/usr/share/dict/words` OR wordfreq, `enZipf < 5.0`, deduped vs core).
  **Loads progressively BY DEFAULT** (Aggressive Mode is retired; a stored
  `aggressiveMode` key is ignored; there is no user-facing tier toggle). After the
  core-only first pass renders, the content script's `schedulePercolation()` calls
  `ensureTailLoaded()` (`src/language/loader.ts`): the build ships the tail as a chunk
  manifest + 4,000-entry compact chunk files (`scripts/build-compact-packs.mjs`), each
  fetched/merged in its own `requestIdleCallback` slice; when merged, tail words
  percolate into the open page **INCREMENTALLY** (`renderIncrementalTailPass`): tail
  arrival is additive, so only the marginal lemmas are injected into the still-
  unreplaced text, in time-budgeted slices with idle yields — existing spans are never
  torn down, and the page-wide density target is preserved (erring on slightly fewer
  injections, since leftover text fragments parse with less sentence context). A
  genuine settings/language change still takes the full restore-and-re-render path.
- **Heap discipline:** the tail Map stores compact TUPLES; an entry is expanded to a
  full object only on a lookup hit (then cached), and merge slices validate tuples
  allocation-free. Measured 2026-07-15 (`tests/live/run-perf.mjs`, es): core first pass
  3186ms avg (baseline 3357ms, -5.1%); longest percolation-window main-thread task 83ms
  (harness gates it at 250ms; the no-tail page-work baseline in that window is 68ms);
  percolation completes ~5.7s avg; heap post-GC like-for-like: core-only 27.5MB vs full
  core+tail 38.4MB, so today's tail retains ~11MB. Committed public tail files stay
  single verbose packs (pipeline/validator untouched); chunking is dist-only.
- **Data ceiling:** 100k/language is NOT reachable from free offline Wiktextract/FreeDict
  with quality gating (the remainder is non-dictionary junk). To push higher, add another
  independent source dictionary (e.g. FreeDict eng-deu/fra/ita, as es already stacks FreeDict
  core + Spanish Wiktextract tail) — not a paid API.

Conventions to preserve:
- Tail entries are `confidence: "low"`, `frequencyRank` offset by 1,000,000 (sort after core),
  `enZipf < 5.0`. Never let tail keys overlap core (the validator enforces disjointness).
- The tail must never block or slow the core first pass: keep `loadLanguagePack()`
  core-only, keep the tail load idle-chunked and off the critical path, and keep
  `isTailLoaded()` meaning "fully merged" (the live-settings diff keys on it via
  `tailLoaded` to fire exactly one percolation reconcile).

## Live settings sync + page status (2026-07-09)

The content script owns one reconcile path, `reconcileWithStoredSettings()` in
`src/content/index.ts`: it reloads settings from storage, then `applyCurrentSettings()`
diffs them against **`appliedSettings`** and re-renders if they differ. It runs from
`storage.onChanged` and from `pageshow` when `event.persisted` (a bfcache restore).

Conventions to preserve:
- **`appliedSettings` records what a pass actually RENDERED**, never the live settings
  at the moment it happened to finish (`renderedRuntimeSettings()` reads the language and
  tail back from the loader). A settings write can land mid-pass and move them underneath.
- **A change arriving mid-pass queues unconditionally**; `runQueuedReplacementRefresh()`
  re-diffs after the pass lands and drops the work if it turned out to be a no-op. Do not
  "optimise" that into an eager diff, and do not diff against `onChanged`'s `oldValue`.
- **A too-short page keeps watching.** `watchForReadableContent()` arms a bounded
  MutationObserver (60s, debounced) so client-rendered pages that fill in after
  `document_idle` still get injected. Tear it down through `stopContentWatcher()`.
- **The popup never blocks on the page.** `renderPageStatus()` fires its
  `chrome.tabs.sendMessage` query without awaiting and races it against a timeout; a
  wedged tab must never cost the user their controls. `describePageStatus()` computes
  status live on every query, so it cannot go stale. **No manifest permission is needed**
  to message an already-injected content script (verified: the error is "Receiving end
  does not exist", not a permission error).

Measured facts worth not re-deriving: a **frozen** background tab DOES receive its queued
`storage.onChanged` on resume (so it self-heals), and real **bfcache** is unreachable
under Playwright because attaching CDP disables it.

## Popup review features (2026-06)

Quizzing is on-demand only, via the popup Practice panel. The auto-popping quiz
banner (`src/quiz/`), its "Quizzes" toggle (`settings.quizzesEnabled`), and the
post-quiz density auto-adjustment were removed in 2026-07: the core loop is
passive exposure plus click-to-save, and quizzes must never interrupt reading.

First run is silent: there is no onboarding overlay (the old `src/onboarding/`
level picker was removed in 2026-07). On the first content-script run,
`ensureFirstRunInit` (`src/content/firstRun.ts`) applies intermediate defaults
(density 0.15, top-1500 lemma prepopulation) and sets `settings.onboarded`, so
the very first page visited gets replacements. The level concept stays internal
(known-words floor); existing users keep their chosen level.

The popup "Unknown Words" card is a review surface for saved-unknown words:

- **Target-first chips** — each chip leads with the active language's target and reveals
  the English source + gloss inline on hover/focus (English also on `aria-label`); words
  with no usable target fall back to an English-only chip. Practice + chips load the
  active-language pack and tag target text with the right BCP-47 `lang`.
- **Mark known = soft remove** — the ✓ clears `selfMarkedUnknown` only (does NOT set
  `selfMarkedKnown`), so the word leaves the list but stays eligible for replacement;
  an aria-live Undo restores it with its original save time.
- **Practice**: `src/popup/PracticePanel.ts` body-swaps the card into a self-graded
  flashcard quiz (target word, reveal English + gloss, know / don't-know) over
  saved-unknown words only, ordered stalest-first by
  `src/engine/reviewQueue.ts` (`max(lastReviewedAt, selfMarkedUnknownAt)`).

Conventions to preserve:
- `LexiconEntry.lastReviewedAt` is the review-staleness signal, stamped by
  `applyQuizResult` (not `lastSeenAt`, which is passive page exposure).
- All lexicon writes go through `lexiconStore.flushLexiconMerge()` (dirty-lemma
  merge-on-fresh-read) — popup AND the content-script flushes — so concurrent
  contexts can't clobber each other's untouched lemmas. Don't reintroduce whole-map
  `getLexiconForStorage()` writes.

## Word Types + verb policy (2026-07-14)

Contexto is a **vocabulary tool, not a grammar tutor** (Jason, pre-ship review).
What we can't render faithfully gets gated or disabled, not engineered around:

- `settings.disabledPartsOfSpeech` (default `['verb']`) + popup "Word Types" card
  (Nouns/Verbs/Adjectives/Adverbs/Phrases). Enforced in `extractPageCandidates`;
  carried through the live-settings diff so toggles re-render open tabs.
- **Verbs render as the bare infinitive** (packs carry no conjugations). When
  enabled, verbs only qualify in bare-infinitive slots (after "to"/a modal,
  surface == base form) — the one context all four languages render correctly.
  The hover card tags verb targets "· infinitive". Long-term path if verbs ever
  matter more: re-import keeping Wiktextract 3sg-present + gerund `forms` and
  conjugate present tense only (past is periphrastic in de/fr/it — avoid).
- Adjectives keep their known no-agreement problem by choice (accepted for now).

## Current state

- **Long-tail expansion wave 1 landed (2026-07-16, on main):** +5,357 panel-verified
  tail words (fr +1,339 / it +1,869 / de +1,073 / es +1,076); tails now es 39,440 ·
  de 19,367 · fr 17,638 · it 12,580. Every language batch shipped under an independent
  Opus panel at the 5% tail bar (de 0.0% / it 0.83% / fr 3.33% / es 4.17%, n=120).
  Three NEW target-proposing sources power the mint queue: Wikipedia langlinks
  (`pipeline/sources/parse_wikipedia_langlinks.py`), Spanish-Wiktextract inversion
  (wiktinv), FreeDict eng-es; plus a gloss-match corroboration vote and a
  wikidata+wiktextract morphology compose. Factory: resumable
  adjudicate->refute->judge->panel->apply workflows in `docs/overnight-2026-07-15/`
  (also the full run ledger in `OVERNIGHT_PLAN.md`, gitignored). Wave 2 (remaining
  ~46k-row shippable pool) drains via the same path. Measured ceiling: full 2x per
  language is NOT reachable from current free sources (es pool caps at ~1.2x);
  next levers are other-language Wiktionary editions and FreeDict supplements.

- **Default-on progressive tail landed (2026-07-15, + incremental percolation after
  adversarial review):** Aggressive Mode is retired (setting, popup toggle, live-diff
  key, tests); the niche tail loads by default in idle-time chunks after the core
  first pass and percolates into the open page INCREMENTALLY — only the marginal
  lemmas are injected, existing spans are never torn down (see "Vocabulary tiers").
  The review caught the first version paying a full restore+re-render on every page
  (0.5-3.3s main-thread freeze on big pages); incremental percolation cut that to
  83ms max (measured while scrolling the largest fixture). Live proof:
  `test:live-tab-sync` gained PERCOLATE-default (es-tail-only "photon" -> fotón, no
  toggle), PERCOLATE-incremental (0 teardowns during percolation), PERCOLATE-switch
  (de-tail-only "wildlife" -> Fauna after a language switch); 22/22 green, red/green
  proven by disabling the incremental branch. Perf (es, 5 fixtures): first pass -5.1%
  vs baseline; percolation-window longtask 83ms max (gated at 250ms; no-tail page
  work is 68ms of it); heap post-GC core-only 27.5MB vs full 38.4MB. Artifacts:
  `docs/overnight-2026-07-15/perf-after-task1b.{json,log}` + `shots/`. Bug found in
  passing: the live harness's teardown counters observed `document.documentElement`,
  which is NULL at init-script time, so observe() threw and REG-firstrun's churn
  assertion had been vacuous; all counters now observe `document`.
- **Gloss repair run landed (2026-07-14, remove/rebuild/regloss):** (1) the 2,683
  unreachable legacy synthetic-compound es entries are GONE (es core 47,317; no
  backfill — FreeDict past the imported 45.8k is the junk band; growth belongs to the
  gold-gated minting engine); (2) suspect glosses repaired by SENSE-ALIGNED regloss
  (`pipeline/import_es/regloss_legacy.py`: pick the Wiktionary sense whose own es
  translation table contains the entry's target): 77 auto-applied under hardened
  guards (dominance by table size, near-tie -> queue, sole-aligned must be the page's
  first sense, meta/dangling glosses rejected — each guard earned by a reviewed
  failure like death->Grim Reaper or judicial->an 1881 land-law clause) + 26 more
  applied through a hand-adjudicated verdict batch; provenance marker =
  `regloss-sense-aligned` on sourceIds; (3) the adjudication engine has a **regloss
  verdict** (`build_regloss_queue.py` + `apply_regloss_row`; gloss provenance-checked
  like targets, stale-target freshness guard, in npm test), exercised end to end by
  that batch; remaining queues: es ~178 sub-band rows / de 141 / fr 126 / it 86.
  Sense-level cache: `pipeline/data/en-sense-cache.jsonl` (96k words, rebuild via
  `scripts/stream_en_sense_translations.py`). es lint flags 4,147 -> ~1,400 (mostly
  the 826 unreachable freedict multi-word phrases + queued judgment calls).
  **Hard-won lesson: automated sense selection fails in unfixable ways (sparse
  per-sense translation tables, gloss-less dominant blocks); anything the guards
  can't prove goes to the queue, never auto-ships.**
- **Pre-ship triage run landed (2026-07-14):** (1) hover-card self-replacement
  fixed — the SPA observer used an unmarked tooltip inner span as its walk root and
  `buildTextWalker` never checked the root's ancestors; now `closest()` (regression
  since 124cdd3, proven red-green by the TOOLTIP-self live scenario + tooltip-overlap
  fixture). (2) Popup page-status is cause-specific: "native Chrome pages" copy only
  on walled-off pages (URL missing/non-http), stale http tabs get "reload this tab",
  file:// points at the file-access permission. (3) Word Types toggles + verb policy
  (see section above). (4) `scripts/lint_glosses.py` wrote a gloss review queue to
  `docs/gloss-lint/` — **top data finding: ALL es entries with frequencyRank < 4568
  (the whole visible band) are legacy pre-pipeline `curated-contexto` LLM seeds**;
  narrow single-sense glosses (version -> "software release"), ~2.0k templated
  "related to X" glosses, ~3.5k synthetic two-word headwords ("team guide") — the
  largest category (authoritative counts: docs/gloss-lint/SUMMARY.md). The
  adjudication engine cannot write sourceGloss (audits only retarget/gate), so gloss
  repair needs either a regloss verdict or regeneration; es queue 4,147 rows
  (3,368 renderable) awaits Jason's remove/rebuild/regloss decision.
- **Overnight multi-source vocab run landed (2026-07-12):** +3,169 panel-verified tail
  words (de +2,450 · it +447 · es +272; fr 0 — failed its error-rate panel bar, by
  design). Four offline sources integrated under `pipeline/sources/` (FreeDict eng-X,
  Apertium, OMW sense-ranked, Wikidata lexemes as gender/plural authority) plus a
  reusable gold-gated adjudication engine in `pipeline/analysis/` (queue builders,
  strict-stratum applier + tests, gold scorers). **Audit auto-apply failed its gate**
  (confident LLM changes measured 28-38% wrong vs gold) so zero existing entries were
  changed; 137 proposed fixes await review in
  `docs/overnight-2026-07-12/audit-review-queue.md`. First representative rendered-band
  error rates (gloss-is-the-contract policy): de 10% · it 12% · fr 14.7% (25% in the
  common band) · es 16%. Full story + next levers:
  `docs/overnight-2026-07-12/MORNING_REPORT.md`.
- **Beta-tester tab-sync bugs fixed (2026-07-09, committed b8084ff):** a live language switch now
  updates every open tab (the settings diff ignored `targetLanguage`); pages that render
  their content after `document_idle` now translate without toggling the language; the popup
  leads with a per-page status card saying what Contexto is doing and why. Proven red to
  green by `npm run test:live-tab-sync` (17 scenarios, headed Chromium). See "Live settings
  sync + page status" above. Known follow-up: the popup's **"Replaced this session" counter
  reads a stale 0** until the session store flushes, which undercuts the new status card.
- **Core-loop simplicity + fidelity run landed on `main` (2026-07-07):** both pretests
  removed (level-picker overlay + auto quiz banner); first run is silent (intermediate
  defaults, top-1500 prepopulate, injects on the first page); deterministic core-loop
  simulation tests added; hover card now teaches gender/article/plural at a glance. Full
  writeup: `docs/overnight-2026-07-07/MORNING_REPORT.md`.
- **Rendered-band accuracy — 4-language double-confirmed audits (2026-07-07/08):**
  **es ~90–100%** (FreeDict-based, solid), but the three **Wiktextract-inverted packs share
  a systemic wrong-sense problem: de ~71–87%, fr ~85%, it ~85%**. ~390 sampled confirmed
  errors have been fixed across es/de/fr/it (retarget to the dominant sense with correct
  gender/plural, or gate when no single word teaches it). Root cause: the gloss→word
  inversion picks a non-dominant sense. **Top open data task: a sense-ranked re-import for
  de/fr/it** — the patches cover only the sampled slices, not the whole band.
- **Two fidelity improvements (2026-07-08):** (1) the popup now strips gloss `#POS`
  artifacts via the hover card's `cleanGloss` (chips, Practice, CSV/Quizlet export); (2)
  cognates that render identically to English (~1994 non-noun exact target==source matches)
  are no longer injected (gated in `isReplaceable`) — identical strings teach nothing, and
  nouns are exempt since they render with a distinct article.
- **Niche tail + Aggressive Mode shipped (2026-07):** each language pack now has a
  lazy-loaded, quarantined tail shard. core+tail = es 88.1k · de 73.2k · fr 72.1k · it 68.9k.
  Default page load + injection unchanged (core-only). See "Vocabulary tiers" above.
- **German, French, Italian shipped**: ≥55k-entry core packs (de 57.4k · fr 55.8k · it 58.6k) +
  grammar adapters + popup picker. es core unchanged (FreeDict).
- **Shipped + site live (2026-07-25):** Contexto is published on the Chrome Web Store
  (`https://chromewebstore.google.com/detail/contexto/ogoledejcmghodooklpmeeeggpafnejo`)
  and the landing site is deployed at **https://trycontexto.org** (Vercel project
  `contexto`, Root Directory `site`, domain registered through Vercel with its
  nameservers). Site copy now covers all four target languages and links to the
  listing from the header pill, the hero, and the CTA; canonical/OG/Twitter URLs
  point at the apex domain, and `www.trycontexto.org` 308-redirects to it.
  Redeploy with `vercel deploy --prod --yes` from `site/`. The demo paragraph
  closes on "context" turning into **contexto** (lowest `data-th`, so it is the
  first word to flip); keep that word the punchline if the copy is reworked.
