import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearDirty,
  flushLexiconMerge,
  getDirtyEntries,
  isDirty,
  markUnknown,
} from '../src/store/lexiconStore.js'

// In-memory chrome.storage.local stub. setGate, when set, lets a test hold a set()
// in flight to exercise the "dirtied during the await" path.
let storage: Record<string, unknown> = {}
let setCalls = 0
let setGate: Promise<void> | null = null

globalThis.chrome = {
  storage: {
    local: {
      async get(key: string) {
        return key in storage ? { [key]: storage[key] } : {}
      },
      async set(obj: Record<string, unknown>) {
        setCalls++
        if (setGate) await setGate
        Object.assign(storage, obj)
      },
    },
  },
} as any

function reset(): void {
  storage = {}
  setCalls = 0
  setGate = null
  clearDirty()
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

test('merge-write preserves stored lemmas this writer never touched (anti-clobber)', async () => {
  reset()
  storage.contexto_lexicon = { other: { seenCount: 99 } }

  markUnknown('mine', true)
  await flushLexiconMerge()

  const written = storage.contexto_lexicon as Record<string, any>
  assert.ok('other' in written, 'untouched lemma survives the merge')
  assert.equal(written.other.seenCount, 99)
  assert.equal(written.mine.selfMarkedUnknown, true)
})

test('a no-op flush never calls storage.set', async () => {
  reset()
  await flushLexiconMerge()
  assert.equal(setCalls, 0)
  assert.equal(isDirty(), false)
})

test('a lemma dirtied during the set() await stays pending after the flush settles', async () => {
  reset()
  markUnknown('a', true)

  const gate = deferred()
  setGate = gate.promise

  const flushing = flushLexiconMerge()
  // Let doMergeWrite snapshot the dirty set and reach the gated set().
  await new Promise(resolve => setTimeout(resolve, 0))

  // Dirtied after the snapshot — must not be cleared by this flush.
  markUnknown('c', true)
  gate.resolve()
  await flushing

  assert.ok('c' in getDirtyEntries(), 'c remains pending')
  assert.equal(isDirty(), true)
  const written = storage.contexto_lexicon as Record<string, any>
  assert.ok('a' in written, 'a was persisted')
  assert.ok(!('c' in written), 'c was not persisted by this flush')
})

test('serialized flushes both persist their lemmas', async () => {
  reset()
  markUnknown('a', true)
  const first = flushLexiconMerge()
  markUnknown('b', true)
  const second = flushLexiconMerge()
  await Promise.all([first, second])

  const written = storage.contexto_lexicon as Record<string, any>
  assert.ok('a' in written)
  assert.ok('b' in written)
  assert.equal(isDirty(), false)
})
