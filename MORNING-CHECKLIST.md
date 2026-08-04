# Contexto v0.3.1 Chrome Web Store Update Checklist

Contexto v0.3.0 is already public. This checklist updates the existing item
`ogoledejcmghodooklpmeeeggpafnejo`; it is not a first-time submission.

Use staged publishing so Chrome Web Store approval and public rollout remain
separate, observable steps.

## 1. Freeze the v0.3.1 Source State

- [x] Spanish, Italian, and French finished their complete frozen Wave 2
      universes; German remains safely resumable with 60 adjudications pending.
- [x] The unused deterministic seed `20260720` panel completed for each finished
      language: es 8/120, it 9/120, fr 14/120.
- [x] All three finished languages exceeded the 5% ship bar and are blocked.
      No Wave 2 verdict was applied and no language pack changed.
- [x] German received no partial panel or application.
- [x] Confirm the working tree contains no unrelated generated or personal
      files.
- [x] Set `version` to `0.3.1` in both `package.json` and `manifest.json`.
- [x] Keep the manifest and store short descriptions aligned.

## 2. Run the Release Gates

Run against the exact source state that will be packaged:

```bash
npm run typecheck
npm test
npm run build
```

Run those three source gates in that exact order and stop at the first failure.
After they pass, install the pinned live-test browser if this machine does not
already have it, then run the data and browser gates:

```bash
npx playwright install chromium
npm run validate:language-packs
npm run test:live-multilang
npm run test:live-tab-sync
node tests/live/run-perf.mjs
```

- [x] Every required command exits successfully.
- [x] Review the live-test screenshots and logs, not only their exit codes.
- [x] Confirm the core first pass remains independent of progressive tail
      loading.
- [x] Confirm no runtime network or remote-code dependency was introduced.

## 3. Capture Current Store Screenshots

The June screenshots show retired interface elements and must not be reused.
After the final build passes:

```bash
npm run capture:store-assets
```

The capture uses the real built extension, a clean temporary Chrome profile, and
the stable `store-assets/demo-article.html` fixture. It publishes these five
files only after all five 1280×800 captures succeed:

- [x] `store-assets/screenshots/01-immersion-es.png`
- [x] `store-assets/screenshots/02-hover-de-grammar.png`
- [x] `store-assets/screenshots/03-popup-languages-status.png`
- [x] `store-assets/screenshots/04-popup-controls.png`
- [x] `store-assets/screenshots/05-popup-review.png`

Visually confirm:

- [x] Replacements are legible without overwhelming the article.
- [x] The German hover card teaches `der Satz` and `pl. Sätze`.
- [x] All four target languages and a real active-page status are visible.
- [x] Aggressive Mode, the Quizzes toggle, and onboarding do not appear.
- [x] Word Types, target-first saved words, and Practice match the final build.
- [x] No browser profile data, unrelated tabs, or developer-only UI is visible.

## 4. Build and Inspect the Upload

- [x] Review the complete release diff and commit the exact v0.3.1 source and
      metadata state.
- [ ] Push the release commits to `main`.
- [x] Release source commit: `24a3c53186de235ddaccaa886f13d66083062ffd`.

```bash
npm run package
shasum -a 256 release/contexto-extension-v0.3.1.zip
```

- [x] The package is `release/contexto-extension-v0.3.1.zip`.
- [x] Its embedded manifest reports v0.3.1.
- [x] The ZIP contains only the production extension.
- [x] It contains no `.DS_Store`, source maps, test service worker, test profile,
      screenshots, or development cache.
- [x] SHA-256: `c144ee34aaec6dc8f6e86b89725a890076f2ca37b79f8d3ae3717ead73192f4f`.
- [x] Confirm the ZIP was produced from the recorded release commit.
- [x] Smoke-test the packaged build in a clean Chrome profile.

## 5. Update the Existing Store Item

Open the Chrome Web Store Developer Dashboard and select the existing Contexto
item.

- [ ] Upload `release/contexto-extension-v0.3.1.zip`.
- [ ] Apply the copy from `store-assets/listing-draft.md`.
- [ ] Set the homepage to `https://trycontexto.org/`.
- [ ] Set the privacy policy to `https://trycontexto.org/privacy/`.
- [ ] Upload all five current screenshots in their numbered order.
- [ ] Reconfirm the single-purpose and data-use disclosures.
- [ ] Reconfirm that `storage` and broad page access match their disclosed,
      on-device purposes.
- [ ] Resolve every dashboard warning.
- [ ] Submit the update for review with staged publishing.

## 6. Monitor Review and Release

- [ ] Save the submission timestamp and submitted ZIP SHA-256.
- [ ] Monitor the item status until review completes.
- [ ] If Chrome rejects the update, preserve its exact feedback before changing
      the package or listing.
- [ ] Once approved, verify the approved version and package before releasing
      the staged update.
- [ ] Release v0.3.1 publicly.
- [ ] Confirm the public listing reports v0.3.1.
- [ ] Install/update from the public listing and perform one final article,
      hover-card, language-switch, saved-word, and Practice smoke test.
- [ ] Tag the recorded release commit as v0.3.1, push the tag, and record the
      store publication date.

## Already Complete

- The production site is live at https://trycontexto.org/.
- The privacy policy is live at https://trycontexto.org/privacy/.
- The site already links to the public Chrome Web Store item.
- `www.trycontexto.org` redirects to the apex domain.
