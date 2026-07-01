# CLAUDE.md — Contexto

> Living context doc (workspace Tenet 2). Keep it lean, high-level, and durable —
> no volatile selectors, regexes, or line numbers. Update it when structure,
> commands, conventions, or state change.

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

# Niche tail shards (public/language-packs/<lang>.tail.json):
curl -s --compressed https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl \
  | python3 scripts/stream_en_translations.py pipeline/data/en-tr-cache.jsonl   # ~13 min, one-time
python3 -m pipeline.import_tail.build --language es --wikt-extract pipeline/data/kaikki-es.jsonl
node tests/live/run-perf.mjs               # headed: multi-site core-vs-aggressive perf (needs build)
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

## Vocabulary tiers — core + niche tail (2026-07)

Each language ships two shards. **This is the performance design: getting to a large
vocabulary without slowing the default page load.**

- **core** (`<lang>.json`) — curated, frequency-ranked, high/medium-confidence. Loaded
  eagerly on every page (as before). This is what gets injected by default.
- **tail** (`<lang>.tail.json`) — niche, `low`-confidence long-tail words (real English
  words gated on `/usr/share/dict/words` OR wordfreq, `enZipf < 5.0`, deduped vs core).
  **Quarantined:** lazy-loaded and only when **Aggressive Mode** is on, so a default page
  never fetches/parses it and its words are never injected. Quarantine is enforced entirely
  in `src/language/loader.ts` — `lookup()` only consults the tail Map when it's loaded; the
  injector is unchanged. `loadLanguagePack(lang, includeTail)`; toggling aggressive mode
  reconciles the tail in place on the open tab.
- **Aggressive Mode** = `settings.aggressiveMode` (default off) + popup toggle. Coverage:
  es 88.1k · de 73.2k · fr 72.1k · it 68.9k (core+tail). Perf cost of the tail: ~+4.5% inject
  time, ~+10MB heap, only when opted in (see `tests/live/run-perf.mjs`).
- **Data ceiling:** 100k/language is NOT reachable from free offline Wiktextract/FreeDict
  with quality gating (the remainder is non-dictionary junk). To push higher, add another
  independent source dictionary (e.g. FreeDict eng-deu/fra/ita, as es already stacks FreeDict
  core + Spanish Wiktextract tail) — not a paid API.

Conventions to preserve:
- Tail entries are `confidence: "low"`, `frequencyRank` offset by 1,000,000 (sort after core),
  `enZipf < 5.0`. Never let tail keys overlap core (the validator enforces disjointness).
- Don't inject the tail by default — the whole point is quarantine. Keep the core shard the
  eager one; keep the tail lazy.

## Popup review features (2026-06)

The popup "Unknown Words" card is a review surface for saved-unknown words:

- **Target-first chips** — each chip leads with the active language's target and reveals
  the English source + gloss inline on hover/focus (English also on `aria-label`); words
  with no usable target fall back to an English-only chip. Practice + chips load the
  active-language pack and tag target text with the right BCP-47 `lang`.
- **Mark known = soft remove** — the ✓ clears `selfMarkedUnknown` only (does NOT set
  `selfMarkedKnown`), so the word leaves the list but stays eligible for replacement;
  an aria-live Undo restores it with its original save time.
- **Practice** — `src/popup/PracticePanel.ts` body-swaps the card into a MeaningRecall
  quiz over saved-unknown words only, ordered stalest-first by
  `src/engine/reviewQueue.ts` (`max(lastReviewedAt, selfMarkedUnknownAt)`).
  Independent of the global Quizzes toggle.

Conventions to preserve:
- `LexiconEntry.lastReviewedAt` is the review-staleness signal, stamped by
  `applyQuizResult` (not `lastSeenAt`, which is passive page exposure).
- All lexicon writes go through `lexiconStore.flushLexiconMerge()` (dirty-lemma
  merge-on-fresh-read) — popup AND the content-script flushes — so concurrent
  contexts can't clobber each other's untouched lemmas. Don't reintroduce whole-map
  `getLexiconForStorage()` writes.

## Current state

- **Niche tail + Aggressive Mode shipped (2026-07):** each language pack now has a
  lazy-loaded, quarantined tail shard. core+tail = es 88.1k · de 73.2k · fr 72.1k · it 68.9k.
  Default page load + injection unchanged (core-only). See "Vocabulary tiers" above.
- **German, French, Italian shipped**: ≥55k-entry core packs (de 57.4k · fr 55.8k · it 58.6k) +
  grammar adapters + popup picker. Adversarial accuracy audit 94–96% on the rendered band. es
  core unchanged (FreeDict).
- Landing site is built on branch **`site/landing`** (not pushed, not deployed). Still
  Spanish-only copy — update for the new languages before launch.
- Chrome Web Store submission is pending the steps in `MORNING-CHECKLIST.md`.
