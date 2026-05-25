import type { NounTranslationEntry, TranslationEntry } from '../types/index.js'

export interface ReplacementResult {
  displayText: string
  replacementStart: number
  baseTarget: string
}

function getArticleStart(text: string, wordStart: number): number {
  const lookback = text.slice(Math.max(0, wordStart - 10), wordStart)
  const match = lookback.match(/(^|\W)(the|a|an)(\s+)$/i)
  if (!match) return wordStart
  return wordStart - (match[2].length + match[3].length)
}

function hadDefiniteArticle(text: string, wordStart: number): boolean {
  const before = text.slice(Math.max(0, wordStart - 15), wordStart).trimEnd().toLowerCase()
  return before.endsWith('the')
}

function hadIndefiniteArticle(text: string, wordStart: number): boolean {
  const before = text.slice(Math.max(0, wordStart - 15), wordStart).trimEnd().toLowerCase()
  return /\ba\b$/.test(before) || /\ban\b$/.test(before)
}

function definiteArticle(entry: NounTranslationEntry, isPlural: boolean): string {
  if (isPlural) return entry.gender === 'feminine' ? 'las' : 'los'
  return entry.gender === 'feminine' ? 'la' : 'el'
}

function indefiniteArticle(entry: NounTranslationEntry, isPlural: boolean): string {
  if (isPlural) return entry.gender === 'feminine' ? 'unas' : 'unos'
  return entry.gender === 'feminine' ? 'una' : 'un'
}

function nounReplacement(
  entry: NounTranslationEntry,
  fullText: string,
  wordStart: number,
  isPlural: boolean,
): ReplacementResult {
  const target = isPlural ? entry.plural : entry.target
  const replacementStart = getArticleStart(fullText, wordStart)

  if (hadDefiniteArticle(fullText, wordStart)) {
    return {
      displayText: `${definiteArticle(entry, isPlural)} ${target}`,
      replacementStart,
      baseTarget: entry.target,
    }
  }

  if (hadIndefiniteArticle(fullText, wordStart)) {
    return {
      displayText: `${indefiniteArticle(entry, isPlural)} ${target}`,
      replacementStart,
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
