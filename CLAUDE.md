# CLAUDE.md — Contexto

> Living context doc (workspace Tenet 2). Keep it lean, high-level, and durable —
> no volatile selectors, regexes, or line numbers. Update it when structure,
> commands, conventions, or state change.

## Product contract

Contexto is a Chrome extension for passive Spanish immersion: it swaps a
user-controlled percentage of eligible English words on any web page for their
Spanish equivalents, showing the English source + definition on hover and
saving click-to-mark unknown words for export. Fully on-device — no runtime
network calls.

**Naming:** the repo folder is `Textum`, but the product is **Contexto**.

## Architecture map

- `src/` — extension source (content scripts, popup logic, word injector).
- `pipeline/` + `scripts/` — data tooling for building/validating the language pack.
- `public/language-packs/` — the bundled Spanish pack (`es.json`) shipped at runtime.
- `popup/` — popup UI source.
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
npm run validate:language-packs
```

Site (static, no build step):

```bash
# preview the site
cd site && python3 -m http.server
```

The site lives in `site/` and deploys to **Vercel with Root Directory = `site`**.

## Popup review features (2026-06)

The popup "Unknown Words" card is a review surface for saved-unknown words:

- **Spanish-first chips** — each chip leads with the Spanish target and reveals the
  English source + gloss inline on hover/focus (English also on `aria-label`); words
  with no usable target fall back to an English-only chip.
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

- Landing site is built on branch **`site/landing`** (not pushed, not deployed).
- Translation-accuracy curation is in progress in `batch.json` / `decisions.json`
  (do not commit those alongside site work).
- Chrome Web Store submission is pending the steps in `MORNING-CHECKLIST.md`.
