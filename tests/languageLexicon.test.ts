import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearDirty,
  flushLexiconMerge,
  getEntry,
  lexiconStorageKey,
  loadLexicon,
  markUnknown,
} from '../src/store/lexiconStore.js'

let storage: Record<string, unknown> = {}

globalThis.chrome = {
  storage: {
    local: {
      async get(key: string) {
        return key in storage ? { [key]: structuredClone(storage[key]) } : {}
      },
      async set(values: Record<string, unknown>) {
        for (const [key, value] of Object.entries(values)) {
          storage[key] = structuredClone(value)
        }
      },
    },
  },
} as any

test('saved and review state is isolated by target language', async () => {
  storage = {}
  clearDirty()

  await loadLexicon('es')
  markUnknown('market', true)
  await flushLexiconMerge()

  await loadLexicon('de')
  assert.equal(getEntry('market').selfMarkedUnknown, false,
    'a Spanish saved word must not appear in German')

  markUnknown('river', true)
  await flushLexiconMerge()

  await loadLexicon('es')
  assert.equal(getEntry('market').selfMarkedUnknown, true)
  assert.equal(getEntry('river').selfMarkedUnknown, false,
    'German progress must not leak back into Spanish')
})

test('the legacy shared lexicon migrates only to the selected language', async () => {
  storage = {
    contexto_lexicon: {
      legacy: { selfMarkedUnknown: true, selfMarkedUnknownAt: 123 },
    },
  }
  clearDirty()

  await loadLexicon('fr')
  assert.equal(getEntry('legacy').selfMarkedUnknown, true)
  assert.ok(storage[lexiconStorageKey('fr')], 'legacy data copied into French')
  assert.equal(storage.contexto_lexicon_migrated_to_language, 'fr')

  await loadLexicon('it')
  assert.equal(getEntry('legacy').selfMarkedUnknown, false,
    'the old shared map must not be copied into a second language')
  assert.equal(storage.contexto_lexicon !== undefined, true,
    'legacy data remains as a recoverable migration backup')
})
