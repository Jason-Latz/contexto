import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeEntry } from '../src/store/lexiconStore.js'
import { WordLifecycleState } from '../src/types/index.js'

test('normalizeEntry defaults lastReviewedAt to 0 for entries written before the field existed', () => {
  // A legacy stored entry from before lastReviewedAt was added.
  const legacy = {
    seenCount: 4,
    lastSeenAt: 1_700_000_000_000,
    srsInterval: 3,
    srsEaseFactor: 2.5,
    srsRepetitions: 1,
    recallHistory: [true, false],
    lifecycleState: WordLifecycleState.Learning,
    selfMarkedKnown: false,
    selfMarkedUnknown: true,
    selfMarkedUnknownAt: 1_700_000_000_000,
  }

  const upgraded = normalizeEntry(legacy)
  assert.equal(upgraded.lastReviewedAt, 0)
  // Pre-existing fields must survive the upgrade untouched.
  assert.equal(upgraded.seenCount, 4)
  assert.equal(upgraded.srsInterval, 3)
  assert.deepEqual(upgraded.recallHistory, [true, false])
  assert.equal(upgraded.selfMarkedUnknown, true)
  assert.equal(upgraded.selfMarkedUnknownAt, 1_700_000_000_000)
})

test('normalizeEntry preserves a present lastReviewedAt', () => {
  const upgraded = normalizeEntry({ lastReviewedAt: 1_725_000_000_000 })
  assert.equal(upgraded.lastReviewedAt, 1_725_000_000_000)
})

test('normalizeEntry treats an explicitly-undefined lastReviewedAt as 0', () => {
  const upgraded = normalizeEntry({ lastReviewedAt: undefined })
  assert.equal(upgraded.lastReviewedAt, 0)
})

test('normalizeEntry fills the standard defaults for a completely empty record', () => {
  const upgraded = normalizeEntry({})
  assert.equal(upgraded.lastReviewedAt, 0)
  assert.equal(upgraded.seenCount, 0)
  assert.equal(upgraded.lastSeenAt, 0)
  assert.equal(upgraded.selfMarkedKnown, false)
  assert.equal(upgraded.selfMarkedUnknown, false)
  assert.equal(upgraded.selfMarkedUnknownAt, 0)
  assert.deepEqual(upgraded.recallHistory, [])
  assert.equal(upgraded.lifecycleState, WordLifecycleState.Unseen)
})
