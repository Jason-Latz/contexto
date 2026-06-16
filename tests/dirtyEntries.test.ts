import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearDirty,
  getDirtyEntries,
  getEntry,
  isDirty,
  markKnown,
  markUnknown,
  recordSeen,
  updateEntry,
} from '../src/store/lexiconStore.js'

// The store is a module singleton with no chrome dependency for these pure paths,
// so each test resets with clearDirty() and uses a unique lemma to avoid bleed.

test('recordSeen registers the lemma as dirty', () => {
  clearDirty()
  recordSeen('alpha')
  assert.equal(isDirty(), true)
  assert.ok('alpha' in getDirtyEntries())
})

test('markUnknown and markKnown register the lemma as dirty', () => {
  clearDirty()
  markUnknown('bravo', true)
  assert.ok('bravo' in getDirtyEntries())

  clearDirty()
  markKnown('charlie', true)
  assert.ok('charlie' in getDirtyEntries())
})

test('updateEntry registers the lemma as dirty', () => {
  clearDirty()
  updateEntry('delta', { ...getEntry('delta'), seenCount: 7 })
  const dirtyEntries = getDirtyEntries()
  assert.ok('delta' in dirtyEntries)
  assert.equal(dirtyEntries.delta.seenCount, 7)
})

test('getDirtyEntries returns only the touched lemmas', () => {
  clearDirty()
  recordSeen('echo')
  recordSeen('foxtrot')
  const keys = Object.keys(getDirtyEntries()).sort()
  assert.deepEqual(keys, ['echo', 'foxtrot'])
})

test('clearDirty empties both the flag and the dirty set', () => {
  clearDirty()
  recordSeen('golf')
  assert.equal(isDirty(), true)
  clearDirty()
  assert.equal(isDirty(), false)
  assert.deepEqual(getDirtyEntries(), {})
})
