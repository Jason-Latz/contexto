import type { NounTranslationEntry, TranslationEntry } from '../types/index.js'
import { type ReplacementResult, detectArticle, firstWord, startsWithVowel } from './articles.js'

// French definite articles: le (m) / la (f) / les (plural). le/la élide to l'
// before a vowel or (mute) h. Aspirated h ("le héros") is a small minority and
// not distinguished here without a per-word list — the common case is mute h.
function elides(target: string): boolean {
  const w = firstWord(target).toLowerCase()
  return startsWithVowel(w) || w.startsWith('h')
}

interface Article {
  article: string
  glue: string // '' for the elided "l'", ' ' otherwise
}

function definiteArticle(gender: NounTranslationEntry['gender'], isPlural: boolean, target: string): Article {
  if (isPlural) return { article: 'les', glue: ' ' }
  if (elides(target)) return { article: "l'", glue: '' }
  return { article: gender === 'feminine' ? 'la' : 'le', glue: ' ' }
}

// Indefinite: un (m) / une (f) / des (plural). None élide ("un ami", "une amie").
function indefiniteArticle(gender: NounTranslationEntry['gender'], isPlural: boolean): Article {
  if (isPlural) return { article: 'des', glue: ' ' }
  return { article: gender === 'feminine' ? 'une' : 'un', glue: ' ' }
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
    const { article, glue } = definiteArticle(entry.gender, isPlural, target)
    return { displayText: `${article}${glue}${target}`, replacementStart: detected.start, baseTarget: entry.target }
  }

  if (detected.kind === 'indefinite') {
    const { article, glue } = indefiniteArticle(entry.gender, isPlural)
    return { displayText: `${article}${glue}${target}`, replacementStart: detected.start, baseTarget: entry.target }
  }

  return { displayText: target, replacementStart: wordStart, baseTarget: entry.target }
}

export function buildFrenchReplacement(
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
