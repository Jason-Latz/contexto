import assert from 'node:assert/strict'
import test from 'node:test'
import { orderUnknownByStaleness } from '../src/engine/reviewQueue.js'
import { normalizeEntry } from '../src/store/lexiconStore.js'
import type { LexiconEntry } from '../src/types/index.js'

function mk(partial: Partial<LexiconEntry>): LexiconEntry {
  return normalizeEntry(partial)
}

test('includes only saved-unknown words', () => {
  const ordered = orderUnknownByStaleness({
    saved: mk({ selfMarkedUnknown: true, selfMarkedUnknownAt: 100 }),
    normal: mk({ selfMarkedUnknown: false }),
    known: mk({ selfMarkedUnknown: false, selfMarkedKnown: true }),
  })
  assert.deepEqual(ordered, ['saved'])
})

test('excludes a word that is both unknown and known (defensive)', () => {
  const ordered = orderUnknownByStaleness({
    conflicted: mk({ selfMarkedUnknown: true, selfMarkedKnown: true, selfMarkedUnknownAt: 100 }),
  })
  assert.deepEqual(ordered, [])
})

test('orders ascending by max(lastReviewedAt, selfMarkedUnknownAt) — stalest first', () => {
  const ordered = orderUnknownByStaleness({
    // never reviewed, saved long ago -> stalest
    old: mk({ selfMarkedUnknown: true, selfMarkedUnknownAt: 100, lastReviewedAt: 0 }),
    // reviewed recently -> freshest, even though saved earlier than `mid`
    fresh: mk({ selfMarkedUnknown: true, selfMarkedUnknownAt: 50, lastReviewedAt: 9000 }),
    // never reviewed, saved more recently than `old`
    mid: mk({ selfMarkedUnknown: true, selfMarkedUnknownAt: 500, lastReviewedAt: 0 }),
  })
  assert.deepEqual(ordered, ['old', 'mid', 'fresh'])
})

test('never-reviewed words (lastReviewedAt 0) sort by their save time', () => {
  const ordered = orderUnknownByStaleness({
    later: mk({ selfMarkedUnknown: true, selfMarkedUnknownAt: 300 }),
    earlier: mk({ selfMarkedUnknown: true, selfMarkedUnknownAt: 100 }),
  })
  assert.deepEqual(ordered, ['earlier', 'later'])
})

test('breaks ties deterministically by savedAt then lemma', () => {
  const ordered = orderUnknownByStaleness({
    // identical staleness key (200) and savedAt (200) -> lemma tie-break
    zebra: mk({ selfMarkedUnknown: true, selfMarkedUnknownAt: 200, lastReviewedAt: 0 }),
    apple: mk({ selfMarkedUnknown: true, selfMarkedUnknownAt: 200, lastReviewedAt: 0 }),
    // same staleness key (200) via lastReviewedAt but earlier savedAt -> comes first
    mango: mk({ selfMarkedUnknown: true, selfMarkedUnknownAt: 50, lastReviewedAt: 200 }),
  })
  assert.deepEqual(ordered, ['mango', 'apple', 'zebra'])
})

test('empty lexicon yields an empty queue', () => {
  assert.deepEqual(orderUnknownByStaleness({}), [])
})

test('a single saved-unknown word yields just that word', () => {
  const ordered = orderUnknownByStaleness({
    solo: mk({ selfMarkedUnknown: true, selfMarkedUnknownAt: 1 }),
  })
  assert.deepEqual(ordered, ['solo'])
})
