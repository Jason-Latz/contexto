# Chrome Web Store Listing Draft

## Name

Contexto

## Short Description

Passive Spanish immersion while you read the web.

## Detailed Description

Contexto turns everyday reading into lightweight language practice. It replaces a user-controlled percentage of eligible English words with Spanish translations directly on the page. Hover over any translated word to see the original English word, a short English definition, and the Spanish translation. Click a translated word to save it as unknown for later review and local export.

Contexto is designed to feel quiet and academic rather than game-like. It uses a local Spanish language pack, stores learning state on your device, and makes no runtime translation API calls in v1.

## Permission Rationale

- `storage`: saves replacement density, unknown-word state, and blocked domains locally.
- page access through content scripts: reads page text so eligible words can be replaced in context.

## Release Checklist

- Build passes.
- Language pack validation passes.
- Icons render at 16, 32, 48, and 128 px.
- Privacy policy includes support contact.
- Store screenshots are captured from Spanish fixture and real article pages.
