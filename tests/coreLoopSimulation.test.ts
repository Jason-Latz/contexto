import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { ensureFirstRunInit, FIRST_RUN_PREPOPULATE_COUNT } from '../src/content/firstRun.js'
import { extractPageCandidates } from '../src/content/injector.js'
import { selectTokens } from '../src/engine/wordSelector.js'
import { setKnown, setUnknown } from '../src/engine/wordLifecycle.js'
import { loadLanguagePack, lookup } from '../src/language/loader.js'
import {
  clearDirty,
  flushLexiconMerge,
  getEntry,
  loadLexicon,
  recordSeen,
} from '../src/store/lexiconStore.js'
import { getDensity, getLevel, loadSettings } from '../src/store/settingsStore.js'
import type { LexiconEntry, TranslationEntry } from '../src/types/index.js'

// ============================================================================
// Deterministic simulation of the core teaching loop.
//
// A synthetic user browses many pages that share one large vocabulary, driving
// the REAL selection pipeline end to end: the real silent first-run init
// (intermediate defaults + top-1500 prepopulation), the real candidate gates
// in extractPageCandidates (quality gate + known-word floor), the real scorer
// in selectTokens (freq/novelty/SRS + selfMarkedKnown exclusion), and the real
// lexicon store persisted through flushLexiconMerge. Only the platform is
// stubbed (chrome.storage, fetch, Date.now) — no src/ logic is mocked.
//
// Invariants under test:
//   A. New-words-only: every selected word passes the quality gate (medium
//      confidence requires enZipf < 5.0) and the intermediate known-floor
//      (enZipf < 6.0); selfMarkedKnown words are never selected after marking.
//   B. Breadth: novelty decay rotates exposure across the vocabulary instead
//      of re-picking the same top-scoring words on every page.
//   C. Prepopulation: a first-run prepopulated word (seenCount = 3) loses a
//      scarce slot to an equally-frequent unseen word.
//   D. Click-to-save round trip: the hover-card save path (setUnknown) lands
//      in the storage the popup reads and does NOT remove the word from
//      rotation, while the mark-known path (setKnown) permanently does.
//   E. Determinism: the whole simulation runs on a fixed virtual clock and is
//      reproducible run-to-run.
// ============================================================================

// ---- deterministic virtual clock -------------------------------------------
// Everything time-dependent in the pipeline (recordSeen/markUnknown stamps,
// srsOverdueScore) reads Date.now, so pinning it removes all wall-clock
// dependence. freshInstall() resets the clock, so every run sees the exact
// same timestamp schedule.

const SIM_EPOCH = Date.UTC(2026, 0, 1)
const HOUR = 60 * 60 * 1000
let virtualNow = SIM_EPOCH
const realDateNow = Date.now
Date.now = () => virtualNow
after(() => {
  Date.now = realDateNow
})

// ---- chrome + fetch stubs ---------------------------------------------------

let storage: Record<string, unknown> = {}

globalThis.chrome = {
  runtime: {
    id: 'test-extension',
    getURL(path: string) {
      return `chrome-extension://test/${path}`
    },
  },
  storage: {
    local: {
      async get(key: string) {
        return key in storage ? { [key]: structuredClone(storage[key]) } : {}
      },
      async set(obj: Record<string, unknown>) {
        // Deep-clone like the real chrome.storage (values cross a serialization
        // boundary). Without this, stored entries would share identity with the
        // live in-memory LexiconEntry objects and every "persisted state"
        // assertion below would be vacuously true.
        for (const [key, value] of Object.entries(obj)) {
          storage[key] = structuredClone(value)
        }
      },
    },
  },
} as any

// ---- synthetic language pack ------------------------------------------------
// Pseudo-words with a CVCVC shape ("babak", "melok", …). compromise tags these
// as singular nouns and singularize() leaves them untouched (they never end in
// "s"), so the real extractTokens path produces one noun candidate per word.

const CONSONANTS = ['b', 'd', 'f', 'g', 'k', 'l', 'm', 'n', 'p', 'r', 't', 'z']
const VOWELS = ['a', 'e', 'i', 'o', 'u']

function genWord(i: number): string {
  const c1 = CONSONANTS[i % 12]
  const v1 = VOWELS[Math.floor(i / 12) % 5]
  const c2 = CONSONANTS[Math.floor(i / 60) % 12]
  const v2 = VOWELS[Math.floor(i / 720) % 5]
  return `${c1}${v1}${c2}${v2}k` // injective for i < 3600
}

// The rotation pool: the page vocabulary the breadth invariant runs over.
// Ranks 1600..3990 sit just past the top-1500 prepopulation band, and the
// resulting freqScore spread (0.4 * 2390/10000 ≈ 0.096) is smaller than the
// first novelty-decay step (0.30 → 0.15), so ANY unseen pool word outscores
// any once-seen pool word. That is the property that makes invariant B sharp:
// if novelty decay regressed, frequency order would freeze the same top slice
// on every page.
const ROTATION_COUNT = 240
const ROTATION_WORDS = Array.from({ length: ROTATION_COUNT }, (_, i) => genWord(i))

// Trap words appear on EVERY page with near-top frequency ranks (just above
// the prepopulation cutoff so they are unseen, i.e. maximally novel). If their
// gate were removed each would immediately outscore the whole rotation pool,
// so "never a candidate / never selected" is a live assertion, not decoration.
const FLOOR_TRAP_WORDS = Array.from({ length: 6 }, (_, i) => genWord(300 + i)) // enZipf 6.5: known-floor
const GATE_TRAP_WORDS = Array.from({ length: 6 }, (_, i) => genWord(310 + i)) // medium @ 5.5: quality gate
const INELIGIBLE_TRAP_WORDS = Array.from({ length: 6 }, (_, i) => genWord(320 + i)) // eligible: false
const ALL_TRAP_WORDS = [...FLOOR_TRAP_WORDS, ...GATE_TRAP_WORDS, ...INELIGIBLE_TRAP_WORDS]

// The prepopulation twins: identical frequencyRank and enZipf; only their
// first-run seeding differs (see pack construction below).
const TWIN_PREPOPULATED = genWord(340)
const TWIN_FRESH = genWord(341)

function nounEntry(
  source: string,
  opts: { rank: number; confidence: 'high' | 'medium'; enZipf: number; eligible?: boolean },
): TranslationEntry {
  return {
    source,
    target: `${source}ung`,
    partOfSpeech: 'noun',
    gender: 'neuter',
    plural: `${source}ungen`,
    sourceGloss: `gloss of ${source}`,
    frequencyRank: opts.rank,
    confidence: opts.confidence,
    sourceIds: ['test'],
    enZipf: opts.enZipf,
    eligible: opts.eligible ?? true,
  }
}

const packEntries: Record<string, TranslationEntry> = {}

// 1) Fillers, ranks 0..1498: the realistic "common word" head — high enZipf
//    (already floor-excluded) and never on any page. They exist so the real
//    top-1500 first-run prepopulation has a genuine head to consume.
const FILLER_COUNT = FIRST_RUN_PREPOPULATE_COUNT - 1 // 1499
for (let i = 0; i < FILLER_COUNT; i++) {
  const w = genWord(400 + i)
  packEntries[w] = nounEntry(w, { rank: i, confidence: 'high', enZipf: 6.8 })
}

// 2) The twins, both rank 1499. getTopNLemmas sorts by rank with a stable
//    sort, so insertion order breaks the tie: TWIN_PREPOPULATED is inserted
//    first and becomes the 1500th (last) prepopulated lemma; TWIN_FRESH is the
//    1501st and stays unseen. Equal rank + equal enZipf means selection between
//    them is decided purely by novelty decay (invariant C).
packEntries[TWIN_PREPOPULATED] = nounEntry(TWIN_PREPOPULATED, { rank: 1499, confidence: 'high', enZipf: 4.5 })
packEntries[TWIN_FRESH] = nounEntry(TWIN_FRESH, { rank: 1499, confidence: 'high', enZipf: 4.5 })

// 3) The rotation pool, spanning confidence tiers and enZipf bands: high
//    entries reach into the 5.0–6.0 band (renderable only BECAUSE they are
//    hand-verified), medium entries stay under the 5.0 quality gate.
ROTATION_WORDS.forEach((w, i) => {
  const high = i % 2 === 0
  packEntries[w] = nounEntry(w, {
    rank: 1600 + i * 10,
    confidence: high ? 'high' : 'medium',
    enZipf: high ? 2.5 + (i % 7) * 0.5 : 2.5 + (i % 5) * 0.5,
  })
})

// 4) The traps (see above).
FLOOR_TRAP_WORDS.forEach((w, i) => {
  packEntries[w] = nounEntry(w, { rank: 1501 + i, confidence: 'high', enZipf: 6.5 })
})
GATE_TRAP_WORDS.forEach((w, i) => {
  // enZipf 5.5 sits ABOVE the 5.0 medium quality gate but BELOW the 6.0
  // intermediate floor, so only the quality gate excludes these.
  packEntries[w] = nounEntry(w, { rank: 1511 + i, confidence: 'medium', enZipf: 5.5 })
})
INELIGIBLE_TRAP_WORDS.forEach((w, i) => {
  // Polysemy-quarantine shape: fine confidence/frequency but eligible: false.
  packEntries[w] = nounEntry(w, { rank: 1521 + i, confidence: 'high', enZipf: 4.0, eligible: false })
})

const PACK_RANK = new Map(Object.entries(packEntries).map(([w, e]) => [w, e.frequencyRank]))

const SYNTHETIC_PACK = JSON.stringify({
  version: 'test',
  sourceLanguage: 'en',
  targetLanguage: 'de',
  displayName: 'German',
  sources: { test: { name: 'test', url: 'https://example.test', license: 'CC' } },
  entries: packEntries,
})

globalThis.fetch = async () => new Response(SYNTHETIC_PACK, { status: 200 })

// ---- simulation harness -----------------------------------------------------

// Mirror the content-script startup order on a fresh install (index.ts:
// settings -> pack -> lexicon -> silent first-run init) and reset the virtual
// clock so every simulation run sees an identical timestamp schedule.
async function freshInstall(): Promise<void> {
  virtualNow = SIM_EPOCH
  storage = {
    // Explicit not-yet-onboarded settings + empty lexicon force loadSettings /
    // loadLexicon to overwrite module-level state left by earlier tests.
    contexto_settings: { onboarded: false },
    contexto_lexicon: {},
  }
  clearDirty()
  await loadSettings()
  await loadLanguagePack('de')
  await loadLexicon()
  await ensureFirstRunInit()

  // Post-conditions of the silent (pretest-free) first run that the whole
  // simulation depends on: intermediate defaults + exactly the top-1500 seeded.
  assert.equal(getLevel(), 'intermediate', 'fresh install must default to the intermediate level')
  assert.equal(getDensity(), 0.15, 'fresh install must default to 0.15 density')
  assert.equal(
    Object.keys(storage.contexto_lexicon as object).length,
    FIRST_RUN_PREPOPULATE_COUNT,
    'first run must seed exactly the top-1500 lemmas',
  )
}

function pageNode(text: string): Text {
  return { nodeValue: text } as Text
}

// One page: the full rotation pool (deterministically re-ordered per page so
// nothing hinges on a fixed candidate order) plus every trap word, grouped
// into plain sentences the real compromise-based extractor can parse.
function buildPageText(pageIndex: number): string {
  const offset = (pageIndex * 37) % ROTATION_WORDS.length
  const words = [
    ...ROTATION_WORDS.slice(offset),
    ...ROTATION_WORDS.slice(0, offset),
    ...ALL_TRAP_WORDS,
  ]
  const sentences: string[] = []
  for (let i = 0; i < words.length; i += 8) {
    sentences.push('The ' + words.slice(i, i + 8).join(' and the ') + ' happened here.')
  }
  return sentences.join(' ')
}

const PAGE_COUNT = 20
const MARK_KNOWN_AFTER_PAGE = 8
const MARK_KNOWN_COUNT = 5

interface PageRecord {
  candidates: string[]
  slots: number
  selected: string[]
}

interface SimResult {
  pages: PageRecord[]
  distinctCurve: number[] // cumulative distinct words exposed, after each page
  markedKnown: string[]
}

// Browse PAGE_COUNT pages. Per page this mirrors renderReplacementPass in
// src/content/index.ts: extractPageCandidates over the page's text nodes, a
// density cap of floor(density * eligibleCount), selectTokens for the winners,
// then one recordSeen per surviving replacement (what the injector's
// recordExposure callback does) and a real merge-flush to storage. After page
// MARK_KNOWN_AFTER_PAGE the user marks the 5 most frequent already-exposed
// words as known (the setKnown path) — those must never be selected again.
async function runSimulation(): Promise<SimResult> {
  await freshInstall()

  const distinctExposed = new Set<string>()
  const pages: PageRecord[] = []
  const distinctCurve: number[] = []
  let markedKnown: string[] = []

  for (let page = 0; page < PAGE_COUNT; page++) {
    virtualNow += HOUR // deterministic time between page visits

    const candidates = extractPageCandidates([pageNode(buildPageText(page))])
    const slots = Math.floor(getDensity() * candidates.length)
    const selected = selectTokens(candidates, slots).map((token) => token.lemma)

    for (const lemma of selected) {
      recordSeen(lemma)
      distinctExposed.add(lemma)
    }
    await flushLexiconMerge()

    pages.push({ candidates: candidates.map((c) => c.lemma), slots, selected })
    distinctCurve.push(distinctExposed.size)

    if (page === MARK_KNOWN_AFTER_PAGE - 1) {
      // The most frequent exposed words: the ones the scorer would otherwise
      // re-pick soonest, so the exclusion assertion has maximum bite.
      markedKnown = [...distinctExposed]
        .sort((a, b) => PACK_RANK.get(a)! - PACK_RANK.get(b)!)
        .slice(0, MARK_KNOWN_COUNT)
      for (const lemma of markedKnown) setKnown(lemma, true)
      await flushLexiconMerge()
    }
  }

  return { pages, distinctCurve, markedKnown }
}

let cachedSim: SimResult | null = null

async function simOnce(): Promise<SimResult> {
  cachedSim ??= await runSimulation()
  return cachedSim
}

// Mirrors the injector's gate constants (LEVEL_FLOOR.intermediate and
// MEDIUM_OK_ZIPF in src/content/injector.ts).
const INTERMEDIATE_FLOOR = 6.0
const MEDIUM_OK_ZIPF = 5.0

// ---- A: new-words-only ------------------------------------------------------

test('A: every selected word respects the quality gate and known-floor across the whole browse', async () => {
  const sim = await simOnce()

  // Live-trap preconditions: every trap word is on every page AND resolvable in
  // the loaded pack, so the ONLY thing keeping it out is the candidate gate.
  const pageText = buildPageText(0)
  for (const trap of ALL_TRAP_WORDS) {
    assert.ok(pageText.includes(trap), `trap "${trap}" must appear in the page text`)
    assert.ok(lookup(trap), `trap "${trap}" must exist in the loaded pack`)
  }

  for (const [i, page] of sim.pages.entries()) {
    // Self-contained liveness: the gate assertions below are meaningless on an
    // empty selection (test B pins the exact cap, but must not be relied on).
    assert.ok(page.selected.length > 0, `page ${i + 1}: nothing was selected`)
    const candidateSet = new Set(page.candidates)
    for (const trap of ALL_TRAP_WORDS) {
      assert.equal(
        candidateSet.has(trap),
        false,
        `page ${i + 1}: gated word "${trap}" must never become a candidate`,
      )
    }

    for (const lemma of page.selected) {
      const entry = lookup(lemma)
      assert.ok(entry, `page ${i + 1}: selected "${lemma}" has no pack entry`)
      assert.equal(entry.eligible, true, `page ${i + 1}: selected "${lemma}" is not QA-eligible`)
      assert.ok(
        (entry.enZipf ?? 0) < INTERMEDIATE_FLOOR,
        `page ${i + 1}: "${lemma}" (enZipf ${entry.enZipf}) violates the intermediate known-floor`,
      )
      if (entry.confidence === 'medium') {
        assert.ok(
          (entry.enZipf ?? 0) < MEDIUM_OK_ZIPF,
          `page ${i + 1}: medium-confidence "${lemma}" (enZipf ${entry.enZipf}) violates the quality gate`,
        )
      }
    }
  }
})

test('A: selfMarkedKnown words are never selected again after being marked', async () => {
  const sim = await simOnce()

  assert.equal(sim.markedKnown.length, MARK_KNOWN_COUNT)
  for (const lemma of sim.markedKnown) {
    assert.ok(
      sim.pages.slice(0, MARK_KNOWN_AFTER_PAGE).some((page) => page.selected.includes(lemma)),
      `"${lemma}" must have genuinely been in rotation before being marked known`,
    )
  }

  for (const [i, page] of sim.pages.entries()) {
    if (i < MARK_KNOWN_AFTER_PAGE) continue
    for (const lemma of sim.markedKnown) {
      assert.equal(
        page.selected.includes(lemma),
        false,
        `page ${i + 1}: selfMarkedKnown "${lemma}" was selected again`,
      )
    }
  }
})

// ---- B: breadth -------------------------------------------------------------

test('B: novelty decay spreads exposure across the vocabulary instead of re-picking the same words', async (t) => {
  const sim = await simOnce()
  const firstPage = sim.pages[0]

  // Sanity floor so the multiplier below cannot be satisfied trivially: the
  // extractor must actually surface (nearly) the whole rotation pool, and the
  // per-page density cap must be a meaningful batch.
  assert.ok(
    firstPage.candidates.length >= ROTATION_COUNT - 10,
    `only ${firstPage.candidates.length} of ${ROTATION_COUNT} pool words became candidates`,
  )
  assert.ok(firstPage.slots >= 30, `per-page slot count ${firstPage.slots} too small for a breadth claim`)

  // The density cap is filled exactly — never exceeded, never underfilled
  // (there are always more positively-scored candidates than slots).
  for (const [i, page] of sim.pages.entries()) {
    assert.equal(page.selected.length, page.slots, `page ${i + 1} must fill the density cap exactly`)
  }

  t.diagnostic(`per-page slots: ${firstPage.slots}; distinct-word growth: ${sim.distinctCurve.join(', ')}`)

  // Measured behavior (2026-07): slots = 36 and the curve grows 36 per page
  // until the 240-word pool is exhausted on page 7 (36, 72, …, 216, 240, 240…).
  // Thresholds are set with headroom below that so they fail on regression, not
  // on noise: deleting novelty decay pins the curve at 36 (= one page's worth).
  const finalDistinct = sim.distinctCurve.at(-1)!
  assert.ok(
    sim.distinctCurve[2] >= 2.5 * firstPage.slots,
    `after 3 pages only ${sim.distinctCurve[2]} distinct words exposed (< 2.5 pages' worth)`,
  )
  assert.ok(
    finalDistinct >= 5 * firstPage.slots,
    `after ${PAGE_COUNT} pages only ${finalDistinct} distinct words exposed (< 5x the per-page count ${firstPage.slots})`,
  )
  assert.ok(
    finalDistinct >= ROTATION_COUNT - 10,
    `rotation never reached ${ROTATION_COUNT - 10} of the ${ROTATION_COUNT}-word pool (got ${finalDistinct})`,
  )
})

// ---- C: prepopulation effect --------------------------------------------------

test('C: a prepopulated common word loses a scarce slot to an equally-frequent unseen word', async () => {
  await freshInstall()

  // The twins share frequencyRank and enZipf; first-run seeding is the only
  // difference between them.
  assert.equal(getEntry(TWIN_PREPOPULATED).seenCount, 3, 'twin A must be prepopulated at seenCount 3')
  assert.equal(getEntry(TWIN_FRESH).seenCount, 0, 'twin B must be unseen')

  const candidates = extractPageCandidates([
    pageNode(`The ${TWIN_PREPOPULATED} and the ${TWIN_FRESH} happened here.`),
  ])
  // Both pass the gates; page order (and pack order) put the prepopulated twin
  // FIRST, so any tie-break would favor it — the fresh twin can only win the
  // scarce slot through novelty decay.
  assert.deepEqual(
    candidates.map((c) => c.lemma),
    [TWIN_PREPOPULATED, TWIN_FRESH],
  )

  assert.deepEqual(
    selectTokens(candidates, 1).map((t) => t.lemma),
    [TWIN_FRESH],
    'with one slot, the unseen twin must beat the prepopulated twin',
  )
  assert.ok(
    selectTokens(candidates, 2).map((t) => t.lemma).includes(TWIN_PREPOPULATED),
    'the prepopulated twin is deprioritized, not excluded',
  )
})

// ---- D: click-to-save round trip ---------------------------------------------

test('D: hover-card save-unknown reaches the popup and keeps the word in rotation; mark-known removes it', async () => {
  await freshInstall()

  // One page visit that exposes a batch of words.
  virtualNow += HOUR
  const candidates = extractPageCandidates([pageNode(buildPageText(0))])
  const selected = selectTokens(candidates, Math.floor(getDensity() * candidates.length))
  assert.ok(selected.length > 0)
  for (const token of selected) recordSeen(token.lemma)
  const target = selected[0].lemma

  // The hover-card click path (handleSpanClick in src/content/hoverHandler.ts):
  // setUnknown(lemma, true) followed by flushUserMark's flushLexiconMerge().
  virtualNow += 60_000
  const clickedAt = virtualNow
  setUnknown(target, true)
  await flushLexiconMerge()

  // (i) It appears in the saved-unknown set the popup reads: the popup loads
  // contexto_lexicon from chrome.storage and filters on selfMarkedUnknown
  // (collectUnknownWords in src/popup/UnknownWordsList.ts).
  const stored = storage.contexto_lexicon as Record<string, LexiconEntry>
  const popupUnknownList = Object.entries(stored)
    .filter(([, entry]) => entry.selfMarkedUnknown)
    .map(([lemma]) => lemma)
  assert.deepEqual(popupUnknownList, [target])
  assert.equal(stored[target].selfMarkedUnknownAt, clickedAt)
  assert.equal(stored[target].selfMarkedKnown, false)

  // (ii) selfMarkedUnknown does NOT exclude the word from future replacement:
  // on the next page it still scores > 0 (selectTokens drops zero-scored
  // candidates even with unlimited slots).
  virtualNow += HOUR
  const nextCandidates = extractPageCandidates([pageNode(buildPageText(1))])
  const allScored = selectTokens(nextCandidates, nextCandidates.length).map((t) => t.lemma)
  assert.ok(allScored.includes(target), 'a saved-unknown word must remain eligible for replacement')

  // (iii) selfMarkedKnown DOES permanently exclude it — same page, same slots,
  // only the flag differs.
  setKnown(target, true)
  await flushLexiconMerge()
  const afterKnown = extractPageCandidates([pageNode(buildPageText(2))])
  const allScoredAfter = selectTokens(afterKnown, afterKnown.length).map((t) => t.lemma)
  assert.equal(allScoredAfter.includes(target), false, 'a self-marked-known word must never be selected')

  const storedAfter = storage.contexto_lexicon as Record<string, LexiconEntry>
  assert.equal(storedAfter[target].selfMarkedKnown, true)
  assert.equal(
    storedAfter[target].selfMarkedUnknown,
    false,
    'mark-known clears the unknown flag, so the word also leaves the popup list',
  )
})

// ---- E: determinism -----------------------------------------------------------

test('E: the simulation is fully deterministic run-to-run', async () => {
  const base = await simOnce()
  const again = await runSimulation()

  assert.deepEqual(
    again.pages.map((p) => p.selected),
    base.pages.map((p) => p.selected),
    'per-page selections must be identical across runs',
  )
  assert.deepEqual(again.distinctCurve, base.distinctCurve)
  assert.deepEqual(again.markedKnown, base.markedKnown)
})
