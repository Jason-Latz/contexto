# Textum

Textum is a Chrome extension for passive language immersion. It replaces a user-controlled percentage of eligible English words on web pages with Spanish translations, then shows the original English word and definition on hover.

## Current V1 Scope

- Target language: Spanish
- Runtime translation source: bundled local language pack
- Runtime network calls: none
- Supported replacements: nouns, adverbs, and fixed expressions
- User controls: density slider, known-word marking, blocked domains
- Deferred: live translation APIs, notifications, nudges, verbs, adjectives

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

This creates `release/textum-extension.zip` from `dist/`.

## Language Packs

Language packs live in `public/language-packs/`. V1 ships `es.json`.

Each entry includes the English source, Spanish target, part of speech, English gloss, frequency rank, and confidence. Spanish noun entries also include gender and plural form so article/plural replacement is deterministic.
