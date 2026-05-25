/**
 * wordLifecycle.ts — Word lifecycle state machine for the SRS system.
 *
 * Drives the progression: unseen → learning → reviewing → mature → graduated
 *
 * Two graduation paths:
 *   Self-marked: user explicitly marks a word as known — immediate, reversible,
 *     full removal from replacement rotation. Lifecycle state is unchanged;
 *     the selfMarkedKnown flag alone gates the word selector.
 *   Quiz-earned: srsInterval ≥ 21 days AND recall ≥ 0.85 over the last 3 quizzes.
 *     Drops to 10% maintenance frequency (enforced in wordSelector). Demoted back
 *     to Reviewing on next incorrect quiz answer (SM-2 resets interval to 1 day).
 *
 * This module owns all quiz result application. Quiz UI components call
 * applyQuizResult() — they never reach into sm2.ts or lexiconStore directly.
 */

import { scheduleSM2 } from './sm2.js'
import { getEntry, updateEntry, markKnown } from '../store/lexiconStore.js'
import { WordLifecycleState } from '../types/index.js'
import type { LexiconEntry } from '../types/index.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Interval thresholds that determine state boundaries.
const REVIEWING_MIN_INTERVAL = 7   // days — Learning → Reviewing (interval 7–21)
const MATURE_MIN_INTERVAL    = 21  // days — Reviewing → Mature   (interval > 21)
const GRADUATION_INTERVAL    = 21  // days — minimum interval for quiz-earned Graduated

// Graduation recall check: last N quiz results must meet the threshold fraction.
const GRADUATION_RECALL_WINDOW    = 3
const GRADUATION_RECALL_THRESHOLD = 0.85  // ≥85% correct = all 3 of last 3 with window=3

// recallHistory is capped so the array never grows unbounded in storage.
const RECALL_HISTORY_CAP = 10

// ---------------------------------------------------------------------------
// State computation
// ---------------------------------------------------------------------------

/**
 * Derive the lifecycle state from the current entry fields after an SM-2 update.
 *
 * State boundaries (interval-based, not repetition-based):
 *   Learning   — interval < 7 days  (includes post-reset words with interval = 1)
 *   Reviewing  — interval 7–21 days
 *   Mature     — interval > 21 days, graduation not yet reached
 *   Graduated  — interval ≥ 21 days AND last 3 quizzes ≥ 85% correct
 *
 * Graduated is checked first so a word at exactly interval = 21 with strong recall
 * is Graduated rather than Reviewing. A word at interval = 21 without strong recall
 * stays in Reviewing until the next correct quiz pushes its interval past 21.
 *
 * Note: Unseen is set by recordSeen() in lexiconStore, not here.
 */
function computeLifecycleState(entry: LexiconEntry): WordLifecycleState {
  // Graduated: long interval AND strong recent recall — checked before Mature
  // so the interval = 21 boundary belongs to Graduated, not Reviewing.
  if (
    entry.srsInterval >= GRADUATION_INTERVAL &&
    entry.recallHistory.length >= GRADUATION_RECALL_WINDOW
  ) {
    const recent = entry.recallHistory.slice(-GRADUATION_RECALL_WINDOW)
    const correctFraction = recent.filter(Boolean).length / recent.length
    if (correctFraction >= GRADUATION_RECALL_THRESHOLD) {
      return WordLifecycleState.Graduated
    }
  }

  if (entry.srsInterval > MATURE_MIN_INTERVAL) return WordLifecycleState.Mature
  if (entry.srsInterval >= REVIEWING_MIN_INTERVAL) return WordLifecycleState.Reviewing
  return WordLifecycleState.Learning
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply a quiz result for a word.
 *
 * Runs SM-2, appends to recallHistory, recomputes the lifecycle state, and
 * writes the updated entry back to the lexicon store (marks store dirty).
 * The storage flush happens separately via the visibilitychange / 3-min fallback.
 */
export function applyQuizResult(englishLemma: string, correct: boolean): void {
  const entry = getEntry(englishLemma)
  const sm2Result = scheduleSM2(entry, correct)

  // Append the outcome and cap the history length so storage stays bounded.
  const recallHistory = [...entry.recallHistory, correct].slice(-RECALL_HISTORY_CAP)

  // Build the updated entry, then derive its new state from the final field values.
  const updated: LexiconEntry = {
    ...entry,
    ...sm2Result,
    recallHistory,
    lifecycleState: computeLifecycleState({ ...entry, ...sm2Result, recallHistory }),
  }

  updateEntry(englishLemma, updated)
}

/**
 * Mark or unmark a word as self-known.
 *
 * Self-marked words are excluded from replacement immediately and indefinitely
 * (the word selector checks selfMarkedKnown before scoring). Reversible: passing
 * known=false re-enters the word into the normal rotation.
 *
 * Exposed here so quiz UI components import from a single lifecycle module
 * rather than reaching into lexiconStore directly.
 */
export function setKnown(englishLemma: string, known: boolean): void {
  markKnown(englishLemma, known)
}
