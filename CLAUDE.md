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

## Current state

- Landing site is built on branch **`site/landing`** (not pushed, not deployed).
- Translation-accuracy curation is in progress in `batch.json` / `decisions.json`
  (do not commit those alongside site work).
- Chrome Web Store submission is pending the steps in `MORNING-CHECKLIST.md`.
