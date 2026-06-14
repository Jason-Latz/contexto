# Contexto

Contexto is a Chrome extension for passive language immersion. It replaces a user-controlled percentage of eligible English words on web pages with Spanish translations, then shows the original English word and definition on hover.

## Current V1 Scope

- Target language: Spanish
- Runtime translation source: bundled local language pack
- Runtime network calls: none
- Supported replacements: content words (nouns, verbs, adjectives, adverbs) and fixed
  expressions, selected by English frequency and verification — see [Quality & word selection](#quality--word-selection)
- User controls: live density slider, choose-your-level onboarding, click-to-save
  unknown words, CSV / Quizlet-TSV export, per-domain blocking, optional review quizzes (off by default)
- Deferred: live translation APIs, notifications, nudges, and full morphology-aware inflection

## Development

```bash
npm install
npm run validate:language-packs
npm run typecheck
npm test
npm run build
```

The build output is written to `dist/`.

## Load In Chrome

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable Developer Mode.
4. Click **Load unpacked**.
5. Select the `dist/` folder.

Use `fixtures/spanish-article.html` for a local smoke test.

## Package For Release

```bash
npm run package
```

This creates `release/contexto-extension-v<version>.zip` from `dist/`.

## Language Packs

Language packs live in `public/language-packs/`. V1 ships `es.json`.

Each entry includes the English source, Spanish target, part of speech, English gloss, frequency rank, and confidence. Spanish noun entries also include gender and plural form so article/plural replacement is deterministic.

### Quality & word selection

The pack mixes ~2.3k hand-verified (`confidence: "high"`) entries with a large
imported (`"medium"`) tier. Wrong-sense errors and the words a learner already
knows are the *same set* — common English words — so the runtime selects words by
**English frequency**, not blanket confidence:

- `scripts/qa_language_pack.py` (`npm run qa:language-pack`, needs
  `pip install wordfreq`) annotates every entry with `enZipf` (English frequency)
  and `eligible` (a content word, not a polysemy quarantine), and corrects a few
  audit-flagged targets.
- At runtime ([`injector.ts`](src/content/injector.ts)) a word is replaced only
  if it is eligible **and** either verified (`high`) or rarer than the common band
  (where the import's dominant sense is unreliable). A per-level **known-word
  floor** then skips words the learner already knows, so replacements focus on the
  rarer vocabulary worth learning.

Expanding coverage of the common band is additive and needs no code change: the
QA pass writes `imports/language-packs/es/common-words-to-verify.json` (the common
words currently gated out, most-frequent first). Translate a batch — e.g. in a
chat assistant — promote those entries to `confidence: "high"`, and they render.

## Credits

Made by **Jason Latz** — [jasonlatz.com](https://jasonlatz.com).

## License & contributing

Contexto is open source under the [MIT License](LICENSE). Issues and pull
requests are welcome — improving the Spanish language pack (correcting or adding
translations) is especially valuable; see [Quality & word selection](#quality--word-selection).
Bundled-library and language-pack data attributions are listed in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
