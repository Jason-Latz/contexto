import type { NounTranslationEntry, TranslationEntry } from '../types/index.js'

export interface ReplacementResult {
  displayText: string
  replacementStart: number
  baseTarget: string
}

type ArticleKind = 'definite' | 'indefinite' | null

interface DetectedArticle {
  kind: ArticleKind
  // Offset in `text` where the replacement span should begin, so the English
  // article ("the "/"a "/"an ") is consumed by the Spanish replacement.
  start: number
}

// Detect a leading English article in ONE pass. Deriving both the article kind
// and the consumed-character offset from the same match keeps them in agreement —
// a previous split between a 10-char and a 15-char window left "the el perro" on
// the page. The leading (^|\W) boundary also prevents words like "breathe" or
// "banana" from registering a false "the"/"a".
function detectArticle(text: string, wordStart: number): DetectedArticle {
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

// Feminine singular nouns beginning with a STRESSED "a"/"ha" take the masculine
// singular article (el agua, un arma) even though they remain feminine for
// plurals and adjectives. Accented initials are always stressed; the rest is a
// curated set of the common cases.
const STRESSED_A_FEMININE = new Set([
  'agua', 'águila', 'aguila', 'alma', 'ala', 'arma', 'arpa', 'ave', 'área', 'area',
  'aula', 'hacha', 'hada', 'habla', 'hambre', 'ancla', 'asma', 'acta', 'aspa',
  'ánfora', 'anfora', 'áncora', 'ancora', 'aya', 'haba', 'asa',
])

function takesMasculineSingularForm(target: string, gender: NounTranslationEntry['gender']): boolean {
  if (gender !== 'feminine') return false
  const firstWord = target.trim().toLowerCase().split(/\s+/)[0] ?? ''
  if (/^h?[áà]/.test(firstWord)) return true
  return STRESSED_A_FEMININE.has(firstWord)
}

function definiteArticle(
  entry: NounTranslationEntry,
  isPlural: boolean,
  target: string,
): string {
  if (isPlural) return entry.gender === 'feminine' ? 'las' : 'los'
  if (takesMasculineSingularForm(target, entry.gender)) return 'el'
  return entry.gender === 'feminine' ? 'la' : 'el'
}

function indefiniteArticle(
  entry: NounTranslationEntry,
  isPlural: boolean,
  target: string,
): string {
  if (isPlural) return entry.gender === 'feminine' ? 'unas' : 'unos'
  if (takesMasculineSingularForm(target, entry.gender)) return 'un'
  return entry.gender === 'feminine' ? 'una' : 'un'
}

function nounReplacement(
  entry: NounTranslationEntry,
  fullText: string,
  wordStart: number,
  isPlural: boolean,
): ReplacementResult {
  const target = isPlural ? entry.plural : entry.target
  const detected = detectArticle(fullText, wordStart)

  if (detected.kind === 'definite') {
    return {
      displayText: `${definiteArticle(entry, isPlural, target)} ${target}`,
      replacementStart: detected.start,
      baseTarget: entry.target,
    }
  }

  if (detected.kind === 'indefinite') {
    return {
      displayText: `${indefiniteArticle(entry, isPlural, target)} ${target}`,
      replacementStart: detected.start,
      baseTarget: entry.target,
    }
  }

  return { displayText: target, replacementStart: wordStart, baseTarget: entry.target }
}

export function buildSpanishReplacement(
  entry: TranslationEntry,
  fullText: string,
  wordStart: number,
  isPlural: boolean,
): ReplacementResult {
  if (entry.partOfSpeech === 'noun') {
    return nounReplacement(entry, fullText, wordStart, isPlural)
  }

  return {
    displayText: entry.target,
    replacementStart: wordStart,
    baseTarget: entry.target,
  }
}
