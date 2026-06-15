# Chrome Web Store Listing Draft

## Name

Contexto

## Short Description

Passive Spanish immersion while you read the web.

## Detailed Description

Contexto turns everyday reading into lightweight language practice. It replaces a user-controlled percentage of eligible English words with Spanish translations directly on the page. Hover over any translated word to see the original English word, a short English definition, and the Spanish translation. Click a translated word to save it as unknown for later review and local export.

Features:

- A live density slider — from a few words to nearly every eligible word — that updates the page instantly, no reload.
- Choose-your-level onboarding (Beginner, Intermediate, Advanced).
- Save words you don't know with one click, then export them to CSV (Excel/Sheets) or Quizlet-ready TSV.
- Per-domain blocking for sites you'd rather read untouched.
- Optional review quizzes, off by default.

Contexto is designed to feel quiet and academic rather than game-like. It uses a local Spanish language pack, stores learning state on your device, and makes no runtime translation API calls.

## Permission Rationale

- `storage`: saves replacement density, unknown-word state, and blocked domains locally.
- page access through content scripts: reads page text so eligible words can be replaced in context.

## Developer

Made by Jason Latz — https://jasonlatz.com (set this as the listing's "Developer website").

## Links

- Homepage: TBD — the deployed Vercel site URL (deploy from `site/`; see MORNING-CHECKLIST.md).
- Privacy policy URL: TBD — the deployed `/privacy/` page on the Vercel domain above.

## Release Checklist

- [x] Build passes.
- [x] Language pack validation passes.
- [x] Icons render at 16, 32, 48, and 128 px.
- [x] Privacy policy includes support contact.
- [ ] Store screenshots are captured from Spanish fixture and real article pages.
