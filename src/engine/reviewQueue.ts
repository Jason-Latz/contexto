/**
 * reviewQueue.ts — Stalest-first ordering of saved-unknown words for popup practice.
 *
 * Pure module: no store, loader, DOM, or clock dependency (mirrors sm2.ts). The
 * popup's practice flow calls this to decide which unknown words to quiz, then
 * filters out any word without a usable Spanish target (a loader concern) before
 * sizing the batch.
 *
 * "Stale" = not reviewed or thought about in a while. The staleness key is
 * max(lastReviewedAt, selfMarkedUnknownAt):
 *   - lastReviewedAt advances each time the word is quizzed (applyQuizResult).
 *   - selfMarkedUnknownAt is the original save time — the floor for never-quizzed
 *     words (lastReviewedAt = 0), so an old save still outranks a fresh one.
 * Ordering ascending by that key puts the longest-untouched words first.
 */

import type { LexiconEntry } from '../types/index.js'

/**
 * Return the saved-unknown lemmas ordered stalest-first.
 *
 * Includes a lemma only when selfMarkedUnknown is set and selfMarkedKnown is not
 * (a word marked known is, by the soft-remove semantics, no longer unknown — the
 * selfMarkedKnown guard is belt-and-suspenders).
 *
 * Ordering: ascending by max(lastReviewedAt, selfMarkedUnknownAt). Deterministic
 * tie-break by selfMarkedUnknownAt then lemma so the queue is stable across runs.
 */
export function orderUnknownByStaleness(lexicon: Record<string, LexiconEntry>): string[] {
  return Object.entries(lexicon)
    .filter(([, entry]) => entry.selfMarkedUnknown && !entry.selfMarkedKnown)
    .map(([lemma, entry]) => ({
      lemma,
      staleness: Math.max(entry.lastReviewedAt, entry.selfMarkedUnknownAt),
      savedAt: entry.selfMarkedUnknownAt,
    }))
    .sort((a, b) =>
      a.staleness - b.staleness ||
      a.savedAt - b.savedAt ||
      a.lemma.localeCompare(b.lemma),
    )
    .map(candidate => candidate.lemma)
}
