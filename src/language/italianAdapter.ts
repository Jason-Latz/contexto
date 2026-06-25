import type { NounTranslationEntry, TranslationEntry } from '../types/index.js'
import { type ReplacementResult, detectArticle, firstWord, startsWithVowel } from './articles.js'

// Italian article selection turns on the leading sound of the noun:
//   - "s impura" (s + consonant), z, gn, pn, ps, x, y, semivowel i+vowel → lo / gli / uno
//   - a true vowel                                                       → l' / gli / un'
//   - anything else                                                      → il / i / un / la / le / una
// Determined from the first word's spelling.

// Semivowel "i" before another vowel (iodio, iato, iena) behaves like a consonant:
// it takes lo/gli/uno and does NOT élide ("lo iodio", "la iena" — never "l'iodio").
function isSemivowelI(word: string): boolean {
  return /^i[aeiouàèéìíòóù]/i.test(firstWord(word))
}

function startsImpure(word: string): boolean {
  const w = firstWord(word).toLowerCase()
  if (/^z/.test(w)) return true
  if (/^(gn|pn|ps|x|y)/.test(w)) return true
  if (/^s[^aeiouàèéìíòóùú]/.test(w)) return true // s followed by a consonant
  return isSemivowelI(w)
}

// A true vowel onset (élides / takes gli), excluding the semivowel-i case.
function startsTrueVowel(word: string): boolean {
  return startsWithVowel(word) && !isSemivowelI(word)
}

interface Article {
  article: string
  glue: string // '' for an elided article (l', un'), ' ' otherwise
}

// Definite: il/lo/l' (m sg), la/l' (f sg), i/gli (m pl), le (f pl).
function definiteArticle(gender: NounTranslationEntry['gender'], isPlural: boolean, target: string): Article {
  const vowel = startsTrueVowel(target)

  if (isPlural) {
    if (gender === 'feminine') return { article: 'le', glue: ' ' }
    if (vowel || startsImpure(target)) return { article: 'gli', glue: ' ' }
    return { article: 'i', glue: ' ' }
  }

  if (vowel) return { article: "l'", glue: '' } // both genders élide before a vowel
  if (gender === 'feminine') return { article: 'la', glue: ' ' }
  if (startsImpure(target)) return { article: 'lo', glue: ' ' }
  return { article: 'il', glue: ' ' }
}

// Indefinite (singular only): un/uno (m), una/un' (f). English "a/an" is always
// singular; a plural is defensively rendered bare.
function indefiniteArticle(gender: NounTranslationEntry['gender'], target: string): Article | null {
  if (gender === 'feminine') {
    if (startsTrueVowel(target)) return { article: "un'", glue: '' }
    return { article: 'una', glue: ' ' }
  }
  if (startsImpure(target)) return { article: 'uno', glue: ' ' }
  return { article: 'un', glue: ' ' } // includes masculine-before-vowel: "un amico"
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
    const indefinite = isPlural ? null : indefiniteArticle(entry.gender, target)
    return {
      displayText: indefinite ? `${indefinite.article}${indefinite.glue}${target}` : target,
      replacementStart: detected.start,
      baseTarget: entry.target,
    }
  }

  return { displayText: target, replacementStart: wordStart, baseTarget: entry.target }
}

export function buildItalianReplacement(
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
