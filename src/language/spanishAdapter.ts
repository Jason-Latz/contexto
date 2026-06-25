import type { NounTranslationEntry, TranslationEntry } from '../types/index.js'
import { type ReplacementResult, detectArticle, firstWord } from './articles.js'

export type { ReplacementResult } from './articles.js'

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
  const first = firstWord(target).toLowerCase()
  if (/^h?[áà]/.test(first)) return true
  return STRESSED_A_FEMININE.has(first)
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
