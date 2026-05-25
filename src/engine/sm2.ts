/**
 * sm2.ts — SM-2 spaced repetition algorithm.
 *
 * Pure module: no side effects, no imports from the store layer.
 * Takes the current SRS fields from a LexiconEntry and a correct/incorrect
 * result, returns the updated values to be merged back by the caller.
 *
 * SM-2 interval schedule:
 *   Repetition 0 (first correct)  → 1 day
 *   Repetition 1 (second correct) → 3 days
 *   Repetition 2+ (subsequent)    → round(prevInterval × easeFactor)
 *
 * Any incorrect answer resets the interval to 1 day and repetitions to 0.
 */

import type { LexiconEntry } from '../types/index.js'

// ---------------------------------------------------------------------------
// Constants (from CLAUDE.md Code Standards → SM-2 Parameters)
// ---------------------------------------------------------------------------

const MIN_EASE_FACTOR       = 1.3
const EASE_INCREMENT_CORRECT = 0.1
const EASE_DECREMENT_INCORRECT = 0.2
const INITIAL_INTERVAL      = 1   // days after first correct repetition
const SECOND_INTERVAL       = 3   // days after second correct repetition

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

// Only the three SRS fields that SM-2 updates — merged back into the entry
// by wordLifecycle.ts so sm2.ts stays free of store dependencies.
export interface SM2Result {
  srsInterval: number
  srsEaseFactor: number
  srsRepetitions: number
}

// ---------------------------------------------------------------------------
// Core algorithm
// ---------------------------------------------------------------------------

/**
 * Compute the next SM-2 state given the current lexicon entry and whether the
 * quiz answer was correct.
 *
 * Correct maps to quality=5; incorrect maps to quality=1.
 * All incorrect answers (quality < 3) reset the interval to 1 day.
 */
export function scheduleSM2(entry: LexiconEntry, correct: boolean): SM2Result {
  if (!correct) {
    // Incorrect: reset repetition counter and interval; decrease ease factor.
    // Ease factor floors at MIN_EASE_FACTOR — never drops below 1.3 regardless
    // of how many times the user gets a word wrong.
    return {
      srsInterval: INITIAL_INTERVAL,
      srsEaseFactor: Math.max(MIN_EASE_FACTOR, entry.srsEaseFactor - EASE_DECREMENT_INCORRECT),
      srsRepetitions: 0,
    }
  }

  // Correct: advance interval based on how many consecutive correct repetitions
  // have already been recorded.
  let newInterval: number
  if (entry.srsRepetitions === 0) {
    newInterval = INITIAL_INTERVAL
  } else if (entry.srsRepetitions === 1) {
    newInterval = SECOND_INTERVAL
  } else {
    // Standard SM-2 formula for subsequent repetitions.
    newInterval = Math.round(entry.srsInterval * entry.srsEaseFactor)
  }

  return {
    srsInterval: newInterval,
    srsEaseFactor: entry.srsEaseFactor + EASE_INCREMENT_CORRECT,
    srsRepetitions: entry.srsRepetitions + 1,
  }
}
