import { getExpressionKeys, lookup } from '../language/loader.js'
import type { ExpressionMatch, ExpressionTranslationEntry } from '../types/index.js'

// Scan raw text for all known multi-word expressions (bigrams and trigrams).
//
// This pass MUST run before the unigram token pass in injector.ts so that
// expression spans are reserved first. Individual words that fall inside an
// expression match are then skipped by the unigram pass, preventing double
// replacement (e.g. "of" and "course" being replaced independently when
// "of course" should map to "natürlich").
//
// Returns matches sorted by start position, with overlaps resolved greedily
// (earlier and longer match wins).
export function scanExpressions(text: string): ExpressionMatch[] {
  const lowerText = text.toLowerCase()
  const expressionKeys = getExpressionKeys()
  const rawMatches: ExpressionMatch[] = []

  for (const key of expressionKeys) {
    let searchFrom = 0

    while (searchFrom < lowerText.length) {
      const idx = lowerText.indexOf(key, searchFrom)
      if (idx === -1) break

      // Enforce word boundaries so we don't match a key inside a longer word.
      // A boundary is any non-word character (space, punctuation, start/end of string).
      const charBefore = idx > 0 ? lowerText[idx - 1] : ' '
      const charAfter =
        idx + key.length < lowerText.length ? lowerText[idx + key.length] : ' '
      const boundaryBefore = /\W/.test(charBefore)
      const boundaryAfter = /\W/.test(charAfter)

      if (boundaryBefore && boundaryAfter) {
        const entry = lookup(key) as ExpressionTranslationEntry
        rawMatches.push({
          start: idx,
          end: idx + key.length,
          // Slice from the original (not lowercased) string to preserve capitalisation
          original: text.slice(idx, idx + key.length),
          entry,
        })
      }

      // Advance by 1 to catch overlapping occurrences (e.g. repeated phrases)
      searchFrom = idx + 1
    }
  }

  // Sort by start position; on ties prefer the longer match (greedy)
  rawMatches.sort((a, b) => a.start - b.start || b.end - a.end)

  // Remove overlapping matches — keep the earliest (and longest at that position)
  const deduped: ExpressionMatch[] = []
  let cursor = 0
  for (const match of rawMatches) {
    if (match.start >= cursor) {
      deduped.push(match)
      cursor = match.end
    }
  }

  return deduped
}
