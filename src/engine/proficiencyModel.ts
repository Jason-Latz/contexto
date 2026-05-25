// Proficiency model — governs the density of word replacements on the page.
//
// The reveal rate is a SAFETY BRAKE only:
//   - It blocks density increases when the current session's reveal rate exceeds 40%.
//   - It never drives density downward.
//   - Only quiz accuracy (Phase 3) can move density in both directions.
//
// Density adjustments are capped at ±2 percentage points per session to
// prevent jarring jumps from a single unusual page.

import { getDensity } from '../store/settingsStore.js'
import { getRevealCount } from '../store/sessionStore.js'

// Minimum number of eligible tokens that must have been observed before
// the proficiency model considers adjusting density. Below this threshold
// the sample size is too small to be meaningful.
const MIN_OBSERVATION_WINDOW = 20

// If more than this fraction of eligible tokens were replaced in a session,
// the reveal rate is too high and a density increase is blocked.
const MAX_REVEAL_RATE = 0.40

// Maximum density change (in absolute percentage points) per session.
const MAX_DENSITY_DELTA = 0.02

// Density is bounded between these values at all times.
const MIN_DENSITY = 0.01
const MAX_DENSITY = 1.00

// Compute the density to use for the current page.
//
// `eligibleCount` — total number of candidate tokens that could be replaced
//   (after dictionary lookup, before density cap is applied).
//
// For Phase 2, this simply returns the stored density unchanged. The proficiency
// model's adjustment logic fires at session end (Phase 3 wires quiz accuracy).
// The reveal-rate brake is enforced here to prevent density from being increased
// when the current session is already too dense.
export function computeDensity(eligibleCount: number): number {
  // Not enough data yet — return stored density as-is.
  if (eligibleCount < MIN_OBSERVATION_WINDOW) {
    return getDensity()
  }

  const currentDensity = getDensity()
  const revealRate = getRevealCount() / eligibleCount

  // Safety brake: if the reveal rate already exceeds the ceiling, cap density
  // at the current stored value (do not allow it to grow further this session).
  if (revealRate > MAX_REVEAL_RATE) {
    return currentDensity
  }

  return currentDensity
}

// Clamp a density value to the permitted range.
export function clampDensity(density: number): number {
  return Math.min(MAX_DENSITY, Math.max(MIN_DENSITY, density))
}

// Compute an adjusted density value after a quiz session (Phase 3 entry point).
// `quizAccuracy` is a value in [0, 1] representing the fraction of correct answers.
//
// Rules:
//   - accuracy ≥ 0.80 → increase density by up to MAX_DENSITY_DELTA
//   - accuracy < 0.60 → decrease density by up to MAX_DENSITY_DELTA
//   - 0.60 ≤ accuracy < 0.80 → no change
//
// The delta is scaled linearly within each band to avoid cliff-edge jumps.
// Blocked by the reveal-rate brake if the current session is already too dense.
export function adjustDensityAfterQuiz(
  currentDensity: number,
  quizAccuracy: number,
  eligibleCount: number,
): number {
  // Not enough data — no adjustment.
  if (eligibleCount < MIN_OBSERVATION_WINDOW) return currentDensity

  const revealRate = getRevealCount() / eligibleCount
  const revealRateBlocked = revealRate > MAX_REVEAL_RATE

  let delta = 0

  if (quizAccuracy >= 0.80) {
    // Scale delta from 0 to MAX_DENSITY_DELTA as accuracy goes from 0.80 → 1.0
    const scale = (quizAccuracy - 0.80) / 0.20
    delta = +MAX_DENSITY_DELTA * scale
    if (revealRateBlocked) delta = 0  // brake prevents increase
  } else if (quizAccuracy < 0.60) {
    // Scale delta from 0 to MAX_DENSITY_DELTA as accuracy goes from 0.60 → 0.0
    const scale = (0.60 - quizAccuracy) / 0.60
    delta = -MAX_DENSITY_DELTA * scale
    // Reveal rate brake never suppresses a decrease — it only blocks increases
  }

  return clampDensity(currentDensity + delta)
}
