import type { NounTranslationEntry, TranslationEntry } from '../types/index.js'
import { type ReplacementResult, detectArticle, firstWord, startsWithVowel } from './articles.js'

// Common "h aspiré" nouns: an aspirated h blocks élision (le héros, la hache — never
// l'héros). The mute h (l'homme, l'hôtel) is the default; this is the curated set of
// frequent exceptions. (héros is aspirated, but héroïne/héroïque are mute — so the
// check is per-word, not by prefix.)
const ASPIRATED_H = new Set([
  'hache', 'haie', 'haine', 'hall', 'halle', 'halte', 'hamac', 'hameau', 'hamster',
  'hanche', 'handicap', 'hangar', 'hareng', 'hargne', 'haricot', 'harnais', 'harpe',
  'hasard', 'hâte', 'hausse', 'haut', 'hauteur', 'havre', 'hérisson', 'hernie',
  'héron', 'héros', 'hêtre', 'hibou', 'hiérarchie', 'hochet', 'hockey', 'homard',
  'honte', 'hoquet', 'horde', 'hors', 'hotte', 'houle', 'housse', 'hublot', 'huit',
  'hurlement', 'hutte',
])

// French definite articles: le (m) / la (f) / les (plural). le/la élide to l' before
// a vowel or a MUTE h; an aspirated h (ASPIRATED_H) keeps le/la.
function elides(target: string): boolean {
  const w = firstWord(target).toLowerCase()
  if (w.startsWith('h')) return !ASPIRATED_H.has(w)
  return startsWithVowel(w)
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
