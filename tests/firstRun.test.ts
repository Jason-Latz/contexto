import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureFirstRunInit, FIRST_RUN_PREPOPULATE_COUNT } from '../src/content/firstRun.js'
import { getDensity, getLevel, isOnboarded, loadSettings } from '../src/store/settingsStore.js'
import { clearDirty, lexiconStorageKey, loadLexicon } from '../src/store/lexiconStore.js'
import { loadLanguagePack } from '../src/language/loader.js'
import type { LexiconEntry } from '../src/types/index.js'

// ---- chrome + fetch stubs -------------------------------------------------

let storage: Record<string, unknown> = {}
let settingsSetCalls = 0
let lexiconSetCalls = 0

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
        return key in storage ? { [key]: storage[key] } : {}
      },
      async set(obj: Record<string, unknown>) {
        if ('contexto_settings' in obj) settingsSetCalls++
        if (lexiconStorageKey('es') in obj) lexiconSetCalls++
        Object.assign(storage, obj)
      },
    },
  },
} as any

// A synthetic core pack larger than FIRST_RUN_PREPOPULATE_COUNT, so the test
// proves the seed is capped at exactly that count (not "everything in the pack").
// frequencyRank == index, so the top-N lemmas are word0000..word1499.
const PACK_SIZE = FIRST_RUN_PREPOPULATE_COUNT + 100

function lemmaAt(rank: number): string {
  return `word${String(rank).padStart(4, '0')}`
}

const packEntries: Record<string, unknown> = {}
for (let rank = 0; rank < PACK_SIZE; rank++) {
  const source = lemmaAt(rank)
  packEntries[source] = {
    source,
    target: `wort${rank}`,
    partOfSpeech: 'adverb',
    sourceGloss: 'test gloss',
    frequencyRank: rank,
    confidence: 'medium',
    sourceIds: ['test'],
    enZipf: 4.0,
    eligible: true,
  }
}

const SYNTHETIC_PACK = JSON.stringify({
  version: 'test',
  sourceLanguage: 'en',
  targetLanguage: 'es',
  displayName: 'Spanish',
  sources: { test: { name: 'test', url: 'https://example.test', license: 'CC' } },
  entries: packEntries,
})

globalThis.fetch = async () => new Response(SYNTHETIC_PACK, { status: 200 })

// Mirror the content-script startup order: settings -> pack -> lexicon -> init.
async function startupThroughInit(): Promise<void> {
  await loadSettings()
  await loadLanguagePack('es')
  await loadLexicon('es')
  await ensureFirstRunInit()
}

function storedSettings(): Record<string, unknown> {
  return (storage.contexto_settings ?? {}) as Record<string, unknown>
}

function storedLexicon(): Record<string, LexiconEntry> {
  return (storage[lexiconStorageKey('es')] ?? {}) as Record<string, LexiconEntry>
}

function reset(): void {
  storage = {}
  settingsSetCalls = 0
  lexiconSetCalls = 0
  clearDirty()
}

// ---- tests ----------------------------------------------------------------
//
// NOTE on ordering: settingsStore keeps module-level state, and loadSettings()
// only overwrites it when a stored value exists. The first test therefore runs
// against the genuine fresh-install state (module defaults + empty storage);
// later tests seed storage.contexto_settings explicitly so loadSettings()
// deterministically resets the in-memory state left by earlier tests.

test('first run silently applies intermediate defaults and prepopulates the top lemmas', async () => {
  reset()
  await startupThroughInit()

  // The silent default is the old "intermediate" onboarding choice.
  assert.equal(FIRST_RUN_PREPOPULATE_COUNT, 1500)
  assert.equal(isOnboarded(), true)
  assert.equal(getLevel(), 'intermediate')
  assert.equal(getDensity(), 0.15)

  // Defaults are persisted immediately (no reload needed for other contexts).
  assert.equal(storedSettings().onboarded, true)
  assert.equal(storedSettings().level, 'intermediate')
  assert.deepEqual(storedSettings().languageLevels, { es: 'intermediate' })
  assert.equal(storedSettings().density, 0.15)

  // Exactly the top-1500 lemmas by frequencyRank are seeded, at seenCount 3.
  const lexicon = storedLexicon()
  assert.equal(Object.keys(lexicon).length, FIRST_RUN_PREPOPULATE_COUNT)
  assert.equal(lexicon[lemmaAt(0)]?.seenCount, 3)
  assert.equal(lexicon[lemmaAt(FIRST_RUN_PREPOPULATE_COUNT - 1)]?.seenCount, 3)
  assert.equal(lemmaAt(FIRST_RUN_PREPOPULATE_COUNT) in lexicon, false,
    'lemmas beyond the top-N must not be seeded')
})

test('first-run init is idempotent: a second call writes nothing', async () => {
  // Continues from the previous test's completed init (no reset), so this is a
  // genuine second call in an already-initialized context.
  const settingsWrites = settingsSetCalls
  const lexiconWrites = lexiconSetCalls

  await ensureFirstRunInit()

  assert.equal(settingsSetCalls, settingsWrites, 'no settings rewrite')
  assert.equal(lexiconSetCalls, lexiconWrites, 'no lexicon rewrite')
  assert.equal(getLevel(), 'intermediate')
})

test('existing users are untouched (migration)', async () => {
  reset()
  storage.contexto_settings = {
    onboarded: true,
    level: 'advanced',
    targetLanguage: 'es',
    density: 0.42,
    replacementsEnabled: true,
  }

  await loadSettings()
  await loadLexicon()
  await ensureFirstRunInit()

  assert.equal(getLevel(), 'advanced')
  assert.equal(getDensity(), 0.42)
  assert.equal(settingsSetCalls, 0, 'no settings write for an onboarded user')
  assert.equal(lexiconSetCalls, 0, 'no prepopulation for an onboarded user')
})

test('a racing first-run tab cannot corrupt lexicon entries that already exist', async () => {
  reset()
  // Seed a not-yet-onboarded settings object so loadSettings() overwrites the
  // in-memory "onboarded" state left by the previous test (see NOTE above).
  storage.contexto_settings = { onboarded: false }
  settingsSetCalls = 0
  // Simulate another context having already seeded/used the lexicon (e.g. a
  // second "first run" tab that flushed before us but crashed before setting
  // the onboarded flag, leaving user progress on a top lemma behind).
  storage.contexto_lexicon = {
    [lemmaAt(0)]: {
      seenCount: 42,
      lastSeenAt: 123,
      lastReviewedAt: 0,
      srsInterval: 0,
      srsEaseFactor: 2.5,
      srsRepetitions: 0,
      recallHistory: [],
      lifecycleState: 'learning',
      selfMarkedKnown: false,
      selfMarkedUnknown: true,
      selfMarkedUnknownAt: 123,
    },
  }

  await startupThroughInit()

  const lexicon = storedLexicon()
  assert.equal(Object.keys(lexicon).length, FIRST_RUN_PREPOPULATE_COUNT)
  // The pre-existing entry survives the re-init instead of being reset to the
  // seed baseline: prepopulate() skips lemmas that already have an entry, and
  // the flush merges onto a fresh read of storage.
  assert.equal(lexicon[lemmaAt(0)]?.seenCount, 42)
  assert.equal(lexicon[lemmaAt(0)]?.selfMarkedUnknown, true)
  assert.equal(lexicon[lemmaAt(1)]?.seenCount, 3)
})
