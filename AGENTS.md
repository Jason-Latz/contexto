# Project: Immersion Extension

## Project Overview

Immersion Extension is a Chrome browser extension that passively replaces English words
with German equivalents on any webpage the user is reading, functioning as a stealth
language acquisition tool.

The system operates across four implementation phases:
- **Phase 0 — Pre-build**: Dictionary build pipeline (Python), toolchain setup, and
  compromise.js validation. No extension code is written until this phase is complete.
- **Phase 1 — Injection skeleton**: DOM walker, word injector, case detector, article
  lookup, and hover interaction. Minimum viable loop: page loads, nouns and adverbs
  are replaced, hover reveals original English.
- **Phase 2 — Selection intelligence**: Lexicon store, word selector scoring, proficiency
  model, density cap, and onboarding flow (level picker + calibration quiz).
- **Phase 3 — SRS and quiz**: SM-2 scheduling, quiz banner (three formats), word
  lifecycle state machine, self-mark interaction, and storage write strategy.
- **Phase 4 — Nudge system and polish**: Background alarm worker, three-tier nudge system,
  inactivity decay, full SPA-safe MutationObserver, and popup UI.

The extension is fully offline — no network calls at runtime. All German translations
come from a bundled dictionary loaded into memory at startup. State is persisted to
`chrome.storage.local` only.

## Tech Stack

### Extension
- **Language**: TypeScript (strict mode)
- **Bundler**: Vite 8 — manual multi-entry config (`vite.config.ts` + `vite.bg.config.ts`).
  `@crxjs/vite-plugin` is NOT used — version conflict with Vite 8. Manifest and static assets
  are copied manually via a `closeBundle` plugin. Two separate `build.lib` configs (one per
  entry) work around the Rollup restriction that forbids multiple IIFE inputs.
- **Browser target**: Chrome (Manifest V3)
- **NLP**: compromise.js (English lemmatisation — 40KB, no dependencies, browser-compatible)
- **Storage**: `chrome.storage.local` (lexicon store, session store, settings store)
- **Background worker**: Chrome service worker with `chrome.alarms` (nudge system, inactivity decay)

### Dictionary build pipeline (run once, not part of extension runtime)
- **Language**: Python 3.11
- **Sources**:
  - SUBTLEX-DE (frequency ranks — Ghent University psycholinguistics)
  - kaikki.org Wiktionary dump (German lemmas, gender, plural forms)
  - FreeDict `dict-de-en` TEI XML (English→German alignment)
  - NLTK WordNet (polysemy flagging)
- **Output**: `dictionary.json` (~600KB uncompressed, ~150KB gzipped), bundled with extension

### Environment
- No API keys required at runtime — fully offline
- No backend, no auth, no network calls after installation

## Project Structure

```
immersion-extension/
├── src/
│   ├── content/
│   │   ├── index.ts              # Content script entry point
│   │   ├── domWalker.ts          # Depth-first text node traversal, SKIP_SELECTORS blocklist
│   │   ├── injector.ts           # Token replacement pipeline, span construction
│   │   ├── caseDetector.ts       # Heuristic case detection (nominative/accusative/dative/genitive)
│   │   ├── articleTable.ts       # 4×3 article lookup table (case × gender × definite/indefinite)
│   │   ├── expressionScanner.ts  # Bigram/trigram scan for fixed multi-word expressions
│   │   ├── hoverHandler.ts       # Hover reveal of original English
│   │   └── mutationObserver.ts   # SPA-safe observer (debounce + guard + characterData)
│   ├── background/
│   │   ├── worker.ts             # Service worker entry point
│   │   ├── nudgeManager.ts       # Three-tier nudge logic (badge, popup, notification)
│   │   ├── alarmScheduler.ts     # chrome.alarms setup (30-minute nudge check cycle)
│   │   └── decayWorker.ts        # Inactivity decay applied on each alarm wake cycle
│   ├── popup/
│   │   ├── index.tsx             # Popup entry point
│   │   ├── StatsPanel.tsx        # Session stats display
│   │   ├── DensitySlider.tsx     # Manual density override
│   │   └── KnownWordsList.tsx    # Self-marked known words, filterable by session
│   ├── onboarding/
│   │   ├── LevelPicker.tsx       # Beginner / Intermediate / Advanced selector
│   │   └── CalibrationQuiz.tsx   # 10-word binary known/unknown spot-check
│   ├── quiz/
│   │   ├── QuizBanner.tsx        # Non-blocking bottom-viewport quiz container
│   │   ├── MeaningRecall.tsx     # German word → English meaning (4-option MC)
│   │   ├── ReverseRecall.tsx     # English word → German form (4-option MC)
│   │   └── ContextualQuiz.tsx    # Blanked sentence from current page
│   ├── engine/
│   │   ├── wordSelector.ts       # Scoring algorithm (α×freq + β×novelty + γ×SRSDue)
│   │   ├── proficiencyModel.ts   # Density governor (observation window, damping, decoupled reveal rate)
│   │   ├── sm2.ts                # SM-2 spaced repetition algorithm
│   │   └── wordLifecycle.ts      # State machine: unseen→learning→reviewing→mature→graduated
│   ├── store/
│   │   ├── lexiconStore.ts       # Per-word SRS data, recall history, graduation state
│   │   ├── sessionStore.ts       # Current session: words seen, quiz candidates, reveal count
│   │   └── settingsStore.ts      # Density, allowed/blocked domains, known words list
│   ├── dictionary/
│   │   └── loader.ts             # Loads dictionary.json into memory on startup (O(1) hash table)
│   └── types/
│       └── index.ts              # Shared TypeScript interfaces and enums
├── public/
│   └── dictionary.json           # Bundled English→German dictionary (output of build pipeline)
├── pipeline/                     # One-time dictionary build scripts (Python, not bundled)
│   ├── build_dictionary.py       # Main pipeline: fetch, align, score, output JSON
│   ├── fetch_subtlex.py          # Download and parse SUBTLEX-DE frequency list
│   ├── fetch_wiktionary.py       # Parse kaikki.org Wiktionary dump for lemmas + plurals + gender
│   ├── align_freedict.py         # Parse FreeDict TEI XML, align German→English
│   ├── flag_polysemy.py          # WordNet polysemy detection and manual review export
│   └── validate_schema.py        # Validate output dictionary.json against expected schema
├── manifest.json
├── vite.config.ts
├── tsconfig.json
├── package.json
├── AGENTS.md                     # This file
└── README.md
```

## Dictionary Entry Schema

```typescript
// Noun
{ "dog": { "de": "Hund", "plural": "Hunde", "gender": "m", "type": "noun", "freq_rank": 842 } }

// Adverb
{ "quickly": { "de": "schnell", "type": "adverb", "freq_rank": 1203 } }

// Fixed expression
{ "of course": { "de": "natürlich", "type": "expression", "freq_rank": 89 } }

// Polysemous — excluded from replacement
{ "bank": { "de": null, "polysemous": true, "type": "noun", "freq_rank": 156 } }
```

## Word Class Scope

**Included:** Nouns (with case detection), adverbs, fixed expressions.

**Permanently excluded:** Verbs (simple and separable), adjectives, prepositions, conjunctions,
pronouns. Verb exclusion is a principled scope decision, not a technical limitation — German
separable verbs split apart in a sentence and cannot be replaced in-place without producing
grammatically wrong output that teaches incorrect patterns.

## Code Standards

### General Principles
- Write simple, readable code — clarity is always preferred over cleverness
- Keep functions small and single-purpose; if a function does more than one thing, split it
- Always add inline comments explaining *why* a decision was made, not just what the code does
- Never hardcode values — use constants or config objects

### TypeScript (src/)
- Strict mode throughout
- Prefer interfaces over types for object shapes
- Always export types used across module boundaries
- Functional components only in popup/onboarding/quiz — no class components
- Components should stay under 150 lines; extract sub-components if larger
- File naming: `camelCase.ts` for logic/utilities, `PascalCase.tsx` for UI components
- Enums for all state machines (word lifecycle states, nudge tiers, quiz formats)

### Storage
- Never write to `chrome.storage.local` on every word injection — too expensive
- Write the lexicon store and session store together in one `chrome.storage.local.set()` call
- Write triggers: `document.addEventListener('visibilitychange')` (primary) + 3-minute
  interval fallback (guards against browser crashes)
- `chrome.storage.sync` is NOT used — 100KB quota cannot hold a full lexicon.
  The extension is explicitly a single-device tool in v1.

### DOM Manipulation
- Text nodes are tracked with a `WeakSet<Text>` at content script module scope — never
  use DOM attributes to mark processed nodes, as `Text` nodes have no `dataset`
- The `SKIP_SELECTORS` blocklist must be checked before processing any text node
- The DOM walker must pass full text node content to compromise.js (not word-by-word)
  for accurate POS tagging via sentence context

### SM-2 Parameters
- Initial ease factor: 2.5
- Minimum ease factor: 1.3
- Ease increment on correct: +0.1
- Ease decrement on incorrect: −0.2
- Initial interval: 1 day; second interval: 3 days
- Quality score mapping: correct → 5, incorrect → 1
- Intervals reset to 1 day when quality < 3 (all incorrect answers reset)

### Python (pipeline/)
- Python 3.11+
- Type hints on all function signatures
- One logical pipeline stage per file
- Validate output schema before writing final JSON

## Development Workflow

### Before Making Any Changes
1. Read and understand the relevant existing files before touching anything
2. Identify whether a similar pattern or utility already exists — never duplicate logic
3. Propose a clear plan describing:
   - What you are going to build or change and why
   - Which files will be created or modified
   - Any risks, tradeoffs, or open questions
4. Do not wait for explicit approval before writing code unless Jason specifically asks for a plan-only pass or the change is destructive/high-risk

### After Making Changes
1. Verify the change works as intended before declaring it complete
2. Check that no existing functionality was broken
3. Summarise what was built, what files were changed, and any follow-up items

### Build Order (follow this sequence strictly)

**Phase 0 — Pre-build ✓ COMPLETE**
1. Toolchain: `vite.config.ts`, `manifest.json` skeleton, `tsconfig.json`, install dependencies
2. compromise.js integration prototype — validate POS tagging and lemmatisation calls
3. Dictionary pipeline:
   a. `fetch_subtlex.py` — SUBTLEX-DE frequency list → ranked lemma list
   b. `fetch_wiktionary.py` — kaikki.org dump → German lemmas + gender + plurals
   c. `align_freedict.py` — FreeDict TEI XML → English↔German alignment
   d. `flag_polysemy.py` — WordNet polysemy detection + manual review export
   e. `build_dictionary.py` — assemble final `dictionary.json`
   f. `validate_schema.py` — validate output before bundling

Notes from Phase 0 — dictionary pipeline:
- SUBTLEX-DE: 190,499 entries; standard competition ranking; top words are function words (ich, ist, nicht)
- kaikki.org dump: 91,090 nouns + 2,377 adverbs extracted; 42.7% nouns missing plural (legitimate "no plural" entries)
- FreeDict alignment: 387,276 unique English keys, 161,245 with multiple German candidates (resolved by SUBTLEX rank)
- Polysemy threshold: SYNSET_THRESHOLD=13 (not 3) — WordNet is very granular; house=12 synsets, set=13, run=16.
  Using 3 wrongly excluded all common nouns. 8 forced exclusions: bank/bat/light/match/bark/spring/well/suit
- Final dictionary: 56,708 entries (53,197 nouns, 3,511 adverbs); all 7 schema checks pass; 369 KB raw / 144 KB gzip
- Scoring weights in wordSelector.ts: γ=0.0 (SRS weight) was zeroed pending Phase 3 — must be activated now

**Phase 1 — Injection skeleton ✓ COMPLETE**
4. `dictionary/loader.ts` — load `dictionary.json` into memory on startup
5. `content/expressionScanner.ts` — bigram/trigram pre-pass for fixed expressions
   (must run before unigram word selection)
6. `content/caseDetector.ts` — heuristic case detection (dative preposition list,
   genitive pattern, nominative/accusative fallback)
7. `content/articleTable.ts` — 4×3 article lookup table
8. `content/domWalker.ts` — depth-first text node traversal with `SKIP_SELECTORS` blocklist
   and high-stakes domain protection (injected DOM banner — confirm() stub replaced)
9. `content/injector.ts` — full token replacement pipeline; WeakSet guard; span construction;
   English article consumed by replacement span (getArticleStart)
10. `content/hoverHandler.ts` — hover reveal of original English
11. `content/index.ts` — content script entry point wiring

Notes from Phase 1:
- `web_accessible_resources` must declare `dictionary.json` for content script fetch() to
  succeed in Chrome MV3 — renderer-process fetch is treated as cross-origin without it
- `chrome.runtime.id` can be the string `"invalid"` (not undefined) when context is
  invalidated; guard must check `=== 'invalid'` in addition to falsiness

**Phase 2 — Selection intelligence ✓ COMPLETE**
12. `store/lexiconStore.ts` — full schema, chrome.storage.local read/write, pre-population logic
13. `store/sessionStore.ts` — session schema including `WordSeen` objects for contextual quiz
14. `store/settingsStore.ts` — allowed/blocked domains, density override
15. `engine/wordSelector.ts` — scoring algorithm (α×freq + β×novelty + γ×SRSDue), density cap
16. `engine/proficiencyModel.ts` — observation window (min 20 responses), damped adjustment
    (max 2pp/session), decoupled reveal rate (safety brake only, never drives density down)
17. `onboarding/LevelPicker.ts` — level selection triggers lexicon pre-population (vanilla DOM, not React)
18. `onboarding/CalibrationQuiz.ts` — MC quiz: show German word, pick correct English from 4 options;
    correct → markKnown; incorrect → stays in learning queue; summary screen with automatic level
    drop (Advanced→Intermediate→Beginner) if score < 5/10; re-runs prepopulate for new level

Notes from Phase 2:
- Onboarding overlays are vanilla TypeScript DOM (not React .tsx) — consistent with content script context
- Word selection runs once per page across all text nodes (extractPageCandidates deduplicates by lemma);
  every occurrence of an approved lemma is replaced in the replacement pass — not just the first
- Calibration quiz infers current level from stored density value (no getLevel() export needed)
- Sentence context for WordSeen is trimmed to the containing sentence, capped at 200 characters
- Scoring weights: α=0.6, β=0.4, γ=0.0 (SRS weight zeroed until Phase 3)
- Pre-population counts: Beginner=300, Intermediate=1500, Advanced=3000

**Phase 3 — SRS and quiz (Day 5–6)**
19. `engine/sm2.ts` — SM-2 algorithm (see parameters in Code Standards above)
20. `engine/wordLifecycle.ts` — state machine: unseen→learning→reviewing→mature→graduated
    (two graduation paths: self-marked immediate, quiz-earned threshold-gated)
21. `quiz/QuizBanner.tsx` — non-blocking bottom-viewport container, fires after 5 min active
    reading; tests 2–3 words from session candidate pool (bounded at 5–7 words)
22. `quiz/MeaningRecall.tsx` — German → English (4-option MC)
23. `quiz/ReverseRecall.tsx` — English → German (4-option MC)
24. `quiz/ContextualQuiz.tsx` — blanked sentence from current page (highest-value format)
    Note: injector.ts needs a small addition at this phase — capture sentence context at
    injection time and write it to sessionStore as part of the `WordSeen` object
25. Storage write strategy — `visibilitychange` + 3-minute interval fallback

**Phase 4 — Nudge system and polish ✓ COMPLETE**
26. `background/alarmScheduler.ts` — chrome.alarms at 30-minute interval
27. `background/decayWorker.ts` — inactivity decay (14-day grace, 0.5pts/inactive day,
    floor at 50% of last-session score)
28. `background/nudgeManager.ts` + `background/worker.ts` — three-tier nudge logic:
    - Tier 1: chrome.action.setBadgeText (1–5 words overdue < 3 days)
    - Tier 2: new-tab popup injection (5+ words overdue 3–7 days OR density increase blocked)
    - Tier 3: chrome.notifications (10+ words overdue 7+ days; permission requested on first
      Tier 3 event only)
29. `content/mutationObserver.ts` — full SPA-safe implementation (500ms debounce,
    `isInjecting` guard flag, `addedNodes` scoping, `characterData` for virtual scroll recycling)
30. `popup/` UI — stats panel, density slider, known words list with session filter

### Commands
- `npm run dev` — Start extension in development mode with HMR
- `npm run build` — Production build (outputs to `dist/`)
- `npm run typecheck` — TypeScript type checking without emitting
- `python pipeline/build_dictionary.py` — Run full dictionary build pipeline
- `python pipeline/validate_schema.py` — Validate dictionary.json schema

## Architecture Rules

- The dictionary is read-only at runtime — never write to it
- The extension makes zero network calls at runtime — no exceptions
- `chrome.storage.sync` is never used — single-device tool in v1
- The MutationObserver uses a `WeakSet<Text>`, not DOM attributes, to track processed nodes
- Expression scanning (bigram/trigram) must run before unigram word scoring
- The proficiency model's reveal rate is a safety brake only — it blocks density increases
  above 40% reveal rate but never drives density downward. Only quiz accuracy moves the
  score in both directions
- SM-2 interval scheduling is driven by quiz results only — passive page exposure queues a
  word for the next quiz but never advances its SRS interval directly
- Word graduation has two pathways: self-marked (immediate, full removal from rotation,
  reversible) and quiz-earned (interval ≥ 21 days AND recall ≥ 0.85 over last 3 quizzes,
  drops to 10% maintenance frequency, demoted on failure)
- High-stakes domain protection (medical, legal, financial, government, safety) uses a
  warn-then-decide banner before any replacements are made. Decision is stored permanently
  in `settingsStore` and never asked again for that domain

### compromise.js known limitations (verified March 2026)
- Singularize each noun individually (not batch) to avoid index drift
- "houses" and some regular plurals may not singularize standalone — add -s/-es strip fallback
- Irregular plurals (children, women, geese) work correctly
- Pronouns (I, she, he) are tagged as nouns — filter by checking against a pronoun blocklist
- Some irregular plurals (men) are missed entirely — acceptable edge case
- Possessives (company's) are dropped — acceptable for v1 scope
- The -s strip fallback in `singularize()` is overly broad: words like "news", "glass",
  "always" that end in 's' and are correctly tagged as nouns will produce wrong lemmas
  (e.g. "news" → "new"). These miss dictionary lookups silently. Acceptable for v1 but
  worth revisiting when the full pipeline dictionary is loaded.

## Known Limitations (v1 — do not attempt to fix these)

- **Single-device only**: `chrome.storage.sync` quota (100KB) cannot hold a full lexicon.
  Multi-device sync requires a backend with user accounts — out of scope for v1.
- **Density ceiling at 80%**: No full-immersion mode in v1.
- **Adjectives excluded**: Inflection complexity deferred to v2.
- **Case detection ~85% accuracy**: Acceptable for intermediate learners. Errors are subtle
  (primarily masculine accusative). A transitive verb list can push this above 90% later.
- **Short-form content**: Extension runs silently dormant on pages under 100 words.
- **Calibration re-run**: No re-calibrate button in v1 (noted as low-cost v1 patch for later).

## Current Focus
All four implementation phases complete. Extension is feature-complete for v1.

## User Preferences

- Jason no longer wants the `Textum` name. Use `Contexto` as the current working title and keep branding easy to change because the name is provisional.
- Contexto should not be German-specific; design product copy, architecture, and configuration around target-language packs. Spanish is the required test language from now on.
- Prefer deny-list behavior over allow-list behavior: Contexto should run broadly by default, with specific blocked domains/pages/settings where needed.
- Keep v1 minimal: remove or defer notification/nudge features unless Jason explicitly re-adds them.
- The end goal is Chrome Web Store distribution, so release work should account for store policy, privacy copy, icons, packaging, and permission minimization.
- Replacement density should be user-controlled by a slider that ranges from very few words to almost all/all eligible words where technically reasonable.
- Density changes from the popup should apply live to the active page, including moving to or from 0%, without requiring a page reload.
- Brand and UI direction should be minimalist and academic, not playful or heavy.
- Jason is open to a translation API or hybrid approach because hand-built/downloaded dictionaries may not scale well across target languages.
- For large language-pack word generation, Jason prefers using ChatGPT outside Codex and then pasting/validating the JSON locally to conserve Codex rate-limit tokens.
- Jason does not want Codex to pause for approval before ordinary code or data edits; proceed directly after explaining the intended change unless the edit is destructive or unusually risky.
- Do not show an initial calibration quiz during onboarding unless Jason explicitly asks to bring it back.
- Keep non-core learning features easy to disable from the popup. Quizzes should default off; text replacement should be separately pausable.

## 2026-05 Spanish-First Refactor Direction

- The active v1 architecture is language-pack based, not German-dictionary based. Treat older German-specific pipeline notes above as historical unless a file still actively implements them.
- Spanish (`public/language-packs/es.json`) is the required test target. Runtime must make no translation API calls in v1.
- Background nudges, alarms, notifications, and inactivity decay are deferred out of v1. Keep the manifest minimal.
- Hover must remain central: translated spans should be visibly marked and show the original English word plus English gloss/definition and Spanish translation.

Next steps (post-v1):
  - Load extension in Chrome and do end-to-end testing across all phases
  - Calibration re-run button (low-cost v1 patch deferred from Phase 2)
  - README for installation and development setup

Completed:
  - Phase 0 — Dictionary pipeline (fetch_subtlex, fetch_wiktionary, align_freedict, flag_polysemy,
    build_dictionary, validate_schema — all verified; 56,708-entry production dictionary bundled)
  - Phase 1 — Injection skeleton (DOM walker, injector, case detection, article replacement,
    hover reveal — verified working in Chrome)
  - Phase 2 — Selection intelligence (lexicon/session/settings stores, word selector, proficiency
    model, onboarding with level picker + MC calibration quiz — verified working in Chrome)
  - Phase 3 — SRS and quiz (SM-2, word lifecycle state machine, three quiz formats, QuizBanner,
    self-mark interaction with session warning toast, density adjustment after quiz)
  - Phase 4 — Nudge system and polish (MutationObserver, background alarm worker, inactivity
    decay, three-tier nudge system, popup UI with stats/density slider/known words list)
