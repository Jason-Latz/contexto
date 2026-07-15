import assert from 'node:assert/strict'
import test from 'node:test'

// In-memory chrome + fetch stubs, following coreLoopSimulation.test.ts: the
// real settings store, loader, and candidate extraction run unmocked.

const storage: Record<string, unknown> = {}
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
        for (const [key, value] of Object.entries(obj)) {
          storage[key] = structuredClone(value)
        }
      },
    },
  },
} as any

// Minimal pack: one noun, one verb, both hand-verified and rare enough to pass
// every quality gate, so the only gates under test are the POS ones.
const PACK = JSON.stringify({
  version: 'test',
  sourceLanguage: 'en',
  targetLanguage: 'es',
  displayName: 'Spanish',
  sources: { test: { name: 'test', url: 'https://example.test', license: 'CC' } },
  entries: {
    kitchen: {
      source: 'kitchen', target: 'cocina', partOfSpeech: 'noun', gender: 'feminine',
      plural: 'cocinas', sourceGloss: 'room where food is cooked', frequencyRank: 10,
      confidence: 'high', sourceIds: ['test'], eligible: true, enZipf: 4.0,
    },
    taste: {
      source: 'taste', target: 'probar', partOfSpeech: 'verb',
      sourceGloss: 'to sample food', frequencyRank: 20,
      confidence: 'high', sourceIds: ['test'], eligible: true, enZipf: 4.0,
    },
  },
})
globalThis.fetch = async () => new Response(PACK, { status: 200 })

const SETTINGS_KEY = 'contexto_settings'
const { loadSettings, getDisabledPartsOfSpeech } = await import('../src/store/settingsStore.js')
const { loadLanguagePack } = await import('../src/language/loader.js')
const { extractPageCandidates } = await import('../src/content/injector.js')

const node = (text: string) => ({ nodeValue: text } as Text)
const lemmas = (candidates: Array<{ lemma: string }>) => candidates.map(c => c.lemma).sort()

test('verbs are disabled by default, and an explicit choice overrides it', async () => {
  delete storage[SETTINGS_KEY]
  await loadSettings()
  assert.deepEqual([...getDisabledPartsOfSpeech()], ['verb'],
    'fresh install (and pre-feature stored settings) must default verbs off')

  storage[SETTINGS_KEY] = { disabledPartsOfSpeech: [] }
  await loadSettings()
  assert.deepEqual([...getDisabledPartsOfSpeech()], [], 'opting verbs back in must persist')

  storage[SETTINGS_KEY] = { disabledPartsOfSpeech: ['noun'] }
  await loadSettings()
  assert.deepEqual([...getDisabledPartsOfSpeech()], ['noun'])
})

test('disabled parts of speech never become candidates', async () => {
  delete storage[SETTINGS_KEY]
  await loadSettings()
  await loadLanguagePack('es')

  // "to taste" is a bare-infinitive slot, so the verb qualifies when enabled.
  const text = 'We would like to taste the soup in the kitchen today.'

  assert.deepEqual(lemmas(extractPageCandidates([node(text)], [])), ['kitchen', 'taste'])
  assert.deepEqual(lemmas(extractPageCandidates([node(text)], ['verb'])), ['kitchen'])
  assert.deepEqual(lemmas(extractPageCandidates([node(text)], ['noun'])), ['taste'])
})

test('verbs only qualify in bare-infinitive slots', async () => {
  delete storage[SETTINGS_KEY]
  await loadSettings()
  await loadLanguagePack('es')

  const casesWithoutTaste = [
    // Inflected surfaces: an uninflected target would read as a grammar error.
    'He tastes the soup in the kitchen every single day.',
    'She tasted the soup in the kitchen late last night.',
    'He was tasting the soup in the kitchen this morning.',
    // Base form, but not after to/modal: only German would render this right.
    'They taste the soup in the kitchen every single day.',
  ]
  for (const text of casesWithoutTaste) {
    assert.deepEqual(lemmas(extractPageCandidates([node(text)], [])), ['kitchen'], text)
  }

  const casesWithTaste = [
    'You must taste the soup before you serve it to anyone.',
    'We want to taste the soup before dinner is served tonight.',
    // Contractions leave a phantom empty term that must not break the lookback.
    "You can't taste the soup from the kitchen just yet.",
  ]
  for (const text of casesWithTaste) {
    assert.ok(lemmas(extractPageCandidates([node(text)], [])).includes('taste'), text)
  }
})

test('the marker check is grammatical: homograph proper nouns do not open a slot', async () => {
  delete storage[SETTINGS_KEY]
  await loadSettings()
  await loadLanguagePack('es')

  // "May" the month and "Will" the name spell like modals but are tagged
  // Month/ProperNoun; a text-only marker list would swap these verbs.
  const properNounCases = [
    'In May taste the strawberries from the kitchen garden outside.',
    'Will Smith taste the soup from the kitchen this evening?',
  ]
  for (const text of properNounCases) {
    assert.ok(!lemmas(extractPageCandidates([node(text)], [])).includes('taste'), text)
  }
})
