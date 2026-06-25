// Shared article-detection + phonetics used by every per-language grammar adapter.
//
// Each target language renders a noun with its own article system, but they all
// key off the SAME signal: a leading English article ("the"/"a"/"an") in the
// source text, and the first letter/sound of the target word. This module owns
// that shared machinery so the per-language adapters only encode their grammar.

export interface ReplacementResult {
  displayText: string
  replacementStart: number
  baseTarget: string
}

export type ArticleKind = 'definite' | 'indefinite' | null

export interface DetectedArticle {
  kind: ArticleKind
  // Offset in `text` where the replacement span should begin, so a leading English
  // article ("the "/"a "/"an ") is consumed by the target-language replacement.
  start: number
}

// Detect a leading English article in ONE pass. Deriving both the article kind
// and the consumed-character offset from the same match keeps them in agreement.
// The leading (^|\W) boundary prevents words like "breathe" or "banana" from
// registering a false "the"/"a".
export function detectArticle(text: string, wordStart: number): DetectedArticle {
  const lookback = text.slice(Math.max(0, wordStart - 16), wordStart)
  const match = lookback.match(/(^|\W)(the|an|a)(\s+)$/i)
  if (!match) return { kind: null, start: wordStart }

  const article = match[2].toLowerCase()
  const consumed = match[2].length + match[3].length
  return {
    kind: article === 'the' ? 'definite' : 'indefinite',
    start: wordStart - consumed,
  }
}

// First whitespace-delimited word of a (possibly multi-word) target, used for the
// phonetic checks that decide articles — only the leading sound matters.
export function firstWord(target: string): string {
  return target.trim().split(/\s+/)[0] ?? ''
}

// Vowel-initial test (covers accented vowels) for élision and article selection
// in French and Italian.
const VOWEL_INITIAL = /^[aeiouàâäáåèéêëìíîïòóôöøùúûü]/i

export function startsWithVowel(word: string): boolean {
  return VOWEL_INITIAL.test(firstWord(word))
}
