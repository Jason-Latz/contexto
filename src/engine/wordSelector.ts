import { lookup } from '../language/loader.js'
import { getEntry } from '../store/lexiconStore.js'
import { WordLifecycleState } from '../types/index.js'
import type { CandidateToken, LexiconEntry } from '../types/index.js'

// Scoring weights — activated for Phase 3.
// α: prefer frequent words (learner encounters them most on real pages)
// β: prefer novel words (decay exposure to avoid showing the same word every visit)
// γ: prefer words whose SRS interval is due or overdue
const ALPHA = 0.4
const BETA  = 0.3
const GAMMA = 0.3

// Maximum frequency rank across the v1 language pack.
// Used to normalise frequencyRank to [0, 1] so it's comparable with other scores.
// A word at rank 1 (most frequent) gets freqScore ≈ 1.0;
// a word at rank MAX_RANK gets freqScore ≈ 0.
const MAX_FREQ_RANK = 10_000

// Used to convert srsInterval (days) to milliseconds for the overdue calculation.
const MS_PER_DAY = 86_400_000

// Graduated words stay in rotation at this fraction of their computed score.
// 10% maintenance means they win the density cap competition rarely — enough
// to keep the memory trace active, not enough to crowd out new learning.
const GRADUATED_MAINTENANCE_RATE = 0.1

interface ScoredToken {
  token: CandidateToken
  score: number
}

// ---------------------------------------------------------------------------
// Component score functions — each returns a value in [0, 1]
// ---------------------------------------------------------------------------

// Higher score = more frequent = more likely to be a useful word to expose.
function freqScore(freqRank: number): number {
  return Math.max(0, 1 - freqRank / MAX_FREQ_RANK)
}

// Decays with each exposure so the same word isn't shown on every page visit.
// A word never seen scores 1.0; one seen 10 times scores ~0.09.
function noveltyScore(seenCount: number): number {
  return 1 / (1 + seenCount)
}

// Returns 0 for words that have never been quizzed (srsInterval === 0 means
// no SM-2 interval has been set yet) or are not yet due.
// Scales linearly from 0 → 1.0 as the word becomes overdue, capped at 1.0
// at one day past due. Beyond one day the score stays at 1.0 — the word is
// already maximally prioritised and further staleness adds no extra signal.
//
// lastSeenAt is used as a proxy for last-quizzed-at because the lexicon does
// not track quiz timestamps separately. This is a reasonable approximation —
// words are typically shown on the same session they are quizzed.
function srsOverdueScore(entry: LexiconEntry): number {
  if (entry.srsInterval === 0) return 0  // no SM-2 schedule yet

  const dueAt      = entry.lastSeenAt + entry.srsInterval * MS_PER_DAY
  const overdueDays = (Date.now() - dueAt) / MS_PER_DAY
  return Math.min(1, Math.max(0, overdueDays))
}

// ---------------------------------------------------------------------------
// Token scoring
// ---------------------------------------------------------------------------

// Score a single candidate token using the weighted formula:
//   score = α×freqScore + β×noveltyScore + γ×srsScore
// Returns 0 for tokens whose dictionary entry is missing or whose legacy
// selfMarkedKnown flag is set (they must never appear in the output).
// selfMarkedUnknown is deliberately not excluded — it is a review/export mark.
// Graduated words are scaled down to GRADUATED_MAINTENANCE_RATE of their
// computed score so they appear only occasionally as passive maintenance.
function scoreToken(token: CandidateToken): number {
  const dictEntry = lookup(token.lemma)
  if (!dictEntry) return 0

  const lexEntry = getEntry(token.lemma)

  // Self-marked known words are permanently excluded from replacement.
  if (lexEntry.selfMarkedKnown) return 0

  const raw =
    ALPHA * freqScore(dictEntry.frequencyRank) +
    BETA  * noveltyScore(lexEntry.seenCount) +
    GAMMA * srsOverdueScore(lexEntry)

  // Graduated words appear at reduced frequency as passive maintenance.
  // They are not excluded entirely — a score of 0 would remove them from
  // rotation forever, defeating the purpose of the maintenance interval.
  if (lexEntry.lifecycleState === WordLifecycleState.Graduated) {
    return raw * GRADUATED_MAINTENANCE_RATE
  }

  return raw
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

// Select at most `maxReplacements` tokens from `candidates`, choosing those
// with the highest scores. Candidates that score 0 (unknown lemma, known word)
// are filtered out before ranking.
//
// `maxReplacements` = Math.floor(density × totalEligibleCount), computed by
// the caller (index.ts) using the proficiency model's current density.
export function selectTokens(
  candidates: CandidateToken[],
  maxReplacements: number,
): CandidateToken[] {
  if (maxReplacements <= 0) return []

  const scored: ScoredToken[] = candidates
    .map(token => ({ token, score: scoreToken(token) }))
    .filter(({ score }) => score > 0)

  // Sort descending by score — highest-value words are replaced first.
  scored.sort((a, b) => b.score - a.score)

  return scored.slice(0, maxReplacements).map(({ token }) => token)
}
