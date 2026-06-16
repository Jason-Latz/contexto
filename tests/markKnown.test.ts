import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getEntry,
  getLexiconForStorage,
  markKnown,
  markUnknown,
  updateEntry,
} from '../src/store/lexiconStore.js'

// Singleton store, no chrome dependency for these paths. Unique lemma per test.

test('markUnknown(true) saves the word and stamps a first-save time', () => {
  markUnknown('uno', true)
  const entry = getEntry('uno')
  assert.equal(entry.selfMarkedUnknown, true)
  assert.ok(entry.selfMarkedUnknownAt > 0)
  assert.equal(entry.selfMarkedKnown, false)
})

test('soft-remove: markUnknown(false) drops it from review WITHOUT marking it known', () => {
  // This is the F2 "mark as known" effect: the word leaves the review list but is
  // NOT permanently excluded from replacement (selfMarkedKnown stays false).
  markUnknown('dos', true)
  markUnknown('dos', false)
  const entry = getEntry('dos')
  assert.equal(entry.selfMarkedUnknown, false)
  assert.equal(entry.selfMarkedUnknownAt, 0)
  assert.equal(entry.selfMarkedKnown, false)
})

test('markUnknown(true) preserves an existing first-save time (does not refresh it)', () => {
  // Undo relies on the original save time being preserved by the `|| Date.now()`
  // floor — but only while selfMarkedUnknownAt is still non-zero. After a
  // soft-remove zeroes it, restoring the original time needs a direct write
  // (updateEntry), which is what the popup Undo does.
  updateEntry('tres', { ...getEntry('tres'), selfMarkedUnknown: true, selfMarkedUnknownAt: 12_345 })
  markUnknown('tres', true)
  assert.equal(getEntry('tres').selfMarkedUnknownAt, 12_345)
})

test('markUnknown twice keeps the first-save time (natural double-mark path)', () => {
  markUnknown('siete', true)
  const first = getEntry('siete').selfMarkedUnknownAt
  assert.ok(first > 0)
  markUnknown('siete', true)
  assert.equal(getEntry('siete').selfMarkedUnknownAt, first)
})

test('markKnown(true) excludes from replacement and clears the unknown mark', () => {
  markUnknown('cuatro', true)
  markKnown('cuatro', true)
  const entry = getEntry('cuatro')
  assert.equal(entry.selfMarkedKnown, true)
  assert.equal(entry.selfMarkedUnknown, false)
  assert.equal(entry.selfMarkedUnknownAt, 0)
})

test('markKnown(false) re-enters rotation without resurrecting the unknown mark', () => {
  markKnown('cinco', true)
  markKnown('cinco', false)
  const entry = getEntry('cinco')
  assert.equal(entry.selfMarkedKnown, false)
  assert.equal(entry.selfMarkedUnknown, false)
})

test('marks round-trip through getLexiconForStorage', () => {
  markUnknown('seis', true)
  const serialized = getLexiconForStorage()
  assert.equal(serialized.seis.selfMarkedUnknown, true)
  assert.ok(serialized.seis.selfMarkedUnknownAt > 0)
})
