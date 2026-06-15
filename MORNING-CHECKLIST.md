# Morning Checklist — Ship Contexto

Ordered manual steps to finish the Chrome Web Store submission. Do them top to bottom.

_Status: the landing site is merged into `main` (was `site/landing`). Step 2 (screenshots) and both polish items below are done. Steps 1 and 3 are yours (Vercel deploy + filling the listing)._

## 1. Deploy the landing site to Vercel

- [ ] Import this repo into Vercel (New Project -> import `Textum`).
- [ ] Set **Root Directory = `site`** (the site is a static folder, no build step).
- [ ] Deploy.
- [ ] Note the public URL: `__________` (production domain).
- [ ] Note the privacy URL: `<production-domain>/privacy/` -> `__________`.

## 2. Extension store screenshots (1280x800) — DONE

Captured with the real extension (`dist/`) loaded via Playwright, all exactly 1280x800, in
`store-assets/screenshots/` — upload all four:

- [x] `01-immersion.png` — the demo article with words replaced in Spanish (slate underline).
- [x] `02-hover-tooltip.png` — the hover card (English + definition + Spanish). The page is a live
      capture; the tooltip overlay is a faithful composite of the extension's exact tooltip
      (overlay layers don't paint in a headless-driven window). Re-grab in real Chrome if you want a pure capture.
- [x] `03-saved-word.png` — a saved word shown with the warm-tan underline.
- [x] `04-popup.png` — the popup (density slider, session stats, CSV/Quizlet export, blocked domains).

Demo page: `store-assets/demo-article.html` (the content script needs >=100 words to activate, which is
why the short `fixtures/spanish-article.html` rendered nothing). Optionally add a real-article capture from your own Chrome.

## 3. Fill the Chrome Web Store listing

- [ ] Open the Chrome Web Store developer dashboard for the item.
- [ ] Fill the listing fields from `store-assets/listing-draft.md` (name, short + detailed
      description, permission rationale, developer website).
- [ ] Set the **Privacy policy URL** to the deployed `/privacy/` page (from step 1).
- [ ] Complete the **data-use disclosures**: no data collected, no data sold or transferred,
      all processing on-device (no runtime network calls).
- [ ] Upload the package: `release/contexto-extension-v0.0.10.zip`.
- [ ] Submit for review.

## 4. After approval

- [ ] Flip the site CTA from "Coming soon" to a real Chrome Web Store link
      (the `.badge-btn` span in `site/index.html`).

## Polish items — RESOLVED

- [x] **Accessibility — focusable disabled CTA badge.** Fixed: dropped `role="button"` and
      `tabindex` from the "Coming soon" `.badge-btn`, so it leaves the tab order and no longer
      announces as a do-nothing disabled button.
- [x] **SEO/meta — placeholder Open Graph URL.** Fixed: removed the fake `og:url`. After you deploy,
      optionally re-add `<meta property="og:url">` with the real domain and make `og:image` an
      absolute URL on that domain for the most reliable link unfurls.
