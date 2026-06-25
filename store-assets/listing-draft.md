# Chrome Web Store Listing Draft

## Name

Contexto

## Short Description

Passive language immersion while you read — Spanish, German, French, or Italian, swapped into any page. Fully on-device.

## Detailed Description

Contexto turns everyday reading into lightweight language practice. Choose your target language — Spanish, German, French, or Italian — and it replaces a user-controlled percentage of eligible English words with translations directly on the page, with the correct article and gender (der/die/das, le/la, il/lo/la…). Hover over any translated word to see the original English word, a short English definition, and the translation. Click a translated word to save it as unknown for later review and local export.

Built for breadth: each language ships a large on-device vocabulary (50,000+ words), so it keeps surfacing new words long after the basics — ideal if you already know the common vocabulary and want to grow the long tail.

Features:

- Switch target language anytime — Spanish, German, French, or Italian.
- A live density slider — from a few words to nearly every eligible word — that updates the page instantly, no reload.
- Choose-your-level onboarding (Beginner, Intermediate, Advanced).
- Save words you don't know with one click, then export them to CSV (Excel/Sheets) or Quizlet-ready TSV.
- Per-domain blocking for sites you'd rather read untouched.
- Optional review quizzes, off by default.

Contexto is designed to feel quiet and academic rather than game-like. It uses local language packs, stores learning state on your device, and makes no runtime translation API calls.

## Permission Rationale

- `storage`: saves replacement density, unknown-word state, and blocked domains locally.
- page access through content scripts: reads page text so eligible words can be replaced in context.

## Developer

Made by Jason Latz — https://jasonlatz.com (set this as the listing's "Developer website").

## Links

- Homepage: https://contexto-mauve.vercel.app
- Privacy policy URL: https://contexto-mauve.vercel.app/privacy/

## Release Checklist

- [x] Build passes.
- [x] Language pack validation passes.
- [x] Icons render at 16, 32, 48, and 128 px.
- [x] Privacy policy includes support contact.
- [x] Store screenshots captured (1280×800) — store-assets/screenshots/ (immersion, hover tooltip, saved word, popup).
