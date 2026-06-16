import assert from 'node:assert/strict'
import test from 'node:test'
import { applyQuizResult } from '../src/engine/wordLifecycle.js'
import { getEntry, updateEntry } from '../src/store/lexiconStore.js'

// Singleton store, no chrome dependency for these paths. Unique lemma per test.

test('applyQuizResult stamps lastReviewedAt — the F3 staleness signal', () => {
  assert.equal(getEntry('qa').lastReviewedAt, 0)
  applyQuizResult('qa', true)
  assert.ok(getEntry('qa').lastReviewedAt > 0)
})

test('applyQuizResult advances lastReviewedAt past an older value', () => {
  updateEntry('qb', { ...getEntry('qb'), lastReviewedAt: 1000 })
  applyQuizResult('qb', true)
  assert.ok(getEntry('qb').lastReviewedAt > 1000)
})

test('applyQuizResult appends the outcome to recallHistory', () => {
  applyQuizResult('qc', true)
  applyQuizResult('qc', false)
  const history = getEntry('qc').recallHistory
  assert.equal(history[history.length - 1], false)
  assert.equal(history[history.length - 2], true)
})

test('recallHistory is capped at the last 10 outcomes', () => {
  for (let i = 0; i < 12; i++) applyQuizResult('qd', true)
  assert.equal(getEntry('qd').recallHistory.length, 10)
})
