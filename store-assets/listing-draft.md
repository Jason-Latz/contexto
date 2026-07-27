# Chrome Web Store Listing — v0.3.0 Update

## Existing Item

- Item ID: `ogoledejcmghodooklpmeeeggpafnejo`
- Public listing:
  https://chromewebstore.google.com/detail/contexto/ogoledejcmghodooklpmeeeggpafnejo

## Name

Contexto

## Short Description

Learn Spanish, German, French, or Italian while you read — words change in context, fully on-device.

## Detailed Description

Contexto turns everyday web reading into passive language immersion. Choose
Spanish, German, French, or Italian and set how many eligible English words you
want to replace. Contexto changes them directly on the page, so you meet new
vocabulary in the context you were already reading.

Hover over any translated word to see its English source and a short definition.
Click it to save it as unknown. In the popup, review saved words with the target
language first, reveal the English meaning, practice with optional self-graded
flashcards, or export to CSV and Quizlet-ready TSV.

Features:

- Switch among Spanish, German, French, and Italian at any time.
- Adjust replacement density live, without reloading the page.
- Choose nouns, adjectives, adverbs, phrases, and optional bare-infinitive verbs.
- Language-aware noun rendering for articles, gender, plurals, capitalization,
  and elision.
- See a live status explaining what Contexto is doing on the current page.
- Pause replacement globally or block individual domains.
- Start immediately with sensible defaults and no onboarding flow.
- Review only when you choose; Contexto never interrupts the page with a quiz.

Contexto is designed to feel quiet and academic rather than game-like. Its
language packs are bundled with the extension, and its extended vocabulary loads
progressively on-device after the first pass. It makes no runtime network or
translation API calls. Settings, saved words, and review state stay in Chrome's
local extension storage.

## Permission Rationale

- `storage`: stores the selected language, replacement settings, blocked
  domains, saved words, and review progress locally in Chrome.
- Page access through content scripts: Contexto reads eligible visible text on
  pages you visit so it can replace words in context. Processing stays on-device;
  page text is never transmitted. Forms, code, editable controls, non-English
  content, and blocked domains are skipped.

## Privacy / Data-Use Disclosures

- Contexto has one purpose: passive, in-context vocabulary learning.
- No user data is collected, sold, or transferred.
- Page text and browsing activity are processed only on the user's device.
- No remote code, analytics, hosted backend, or runtime translation API is used.
- User settings and learning state remain in `chrome.storage.local`.

## Developer and Links

- Developer: Jason Latz
- Developer website: https://jasonlatz.com
- Product homepage: https://trycontexto.org/
- Privacy policy: https://trycontexto.org/privacy/
- Support: https://github.com/Jason-Latz/contexto/issues

## v0.3.0 Asset Set

Capture these from the final v0.3.0 build with
`npm run capture:store-assets`. Each image must be exactly 1280×800:

1. `01-immersion-es.png` — Spanish immersion at a readable density.
2. `02-hover-de-grammar.png` — German `der Satz` hover card with its irregular
   plural, `Sätze`.
3. `03-popup-languages-status.png` — live page status and four-language picker.
4. `04-popup-controls.png` — Word Types, session, density, and domain controls.
5. `05-popup-review.png` — target-first saved words and the Practice launcher.

Do not reuse the pre-v0.3.0 screenshots: they show retired interface elements.

## Release Checks

- [x] No Wave 2 language passed its final panel; no Wave 2 pack data is included.
- [x] Package and manifest versions are both `0.3.0`.
- [x] Typecheck, tests, language-pack validation, build, and live gates pass.
- [x] The five v0.3.0 screenshots are freshly captured and visually reviewed.
- [x] `release/contexto-extension-v0.3.0.zip` is built and inspected.
- [ ] Listing text, links, screenshots, permissions, and privacy answers match
      this document.
- [ ] The update is uploaded to the existing item and submitted with staged
      publishing.
