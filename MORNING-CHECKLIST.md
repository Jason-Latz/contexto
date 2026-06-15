# Morning Checklist — Ship Contexto

Ordered manual steps to finish the Chrome Web Store submission. Do them top to bottom.

## 1. Deploy the landing site to Vercel

- [ ] Import this repo into Vercel (New Project -> import `Textum`).
- [ ] Set **Root Directory = `site`** (the site is a static folder, no build step).
- [ ] Deploy.
- [ ] Note the public URL: `__________` (production domain).
- [ ] Note the privacy URL: `<production-domain>/privacy/` -> `__________`.

## 2. Capture extension store screenshots (1280x800)

- [ ] Load the extension unpacked (`npm run build`, then load `dist/` at `chrome://extensions`).
- [ ] Capture from `fixtures/spanish-article.html` with the extension active.
- [ ] Capture from a real article (e.g. a news/blog page) with the extension active.
- [ ] Export each at exactly **1280x800**.

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

## Known polish items

Non-blocking; clean up when convenient.

- **SEO/meta — placeholder Open Graph URL.** `site/index.html` line 20 sets
  `og:url` to `https://contexto.example.com/` rather than the real deploy domain.
  When the link is shared it unfurls with a canonical URL pointing at a
  non-existent example domain. Fix: replace the `content="https://contexto.example.com/"`
  value with the real production URL (or drop the `og:url` tag until the domain is
  known), and make `og:image` an absolute URL on that same domain for reliable
  unfurling across all scrapers.
- **Accessibility — focusable disabled CTA badge.** The "Coming soon" badge
  (`.badge-btn` span, `site/index.html` lines 332-341) has `role="button"` +
  `tabindex="0"` + `aria-disabled="true"` but no key/click handler, so it is
  keyboard-focusable yet announces as a disabled button that does nothing —
  slightly confusing for assistive-tech users (`cursor:not-allowed` already makes
  it read as disabled visually). Fix: drop `tabindex="0"` (and optionally
  `role="button"`) so the non-interactive badge leaves the tab order, keeping
  `aria-disabled` and the visible text. Alternatively make it a real
  `<button disabled>` for native semantics.
