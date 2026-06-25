import type { Gender, NounTranslationEntry, TranslationEntry } from '../types/index.js'
import { type ReplacementResult, detectArticle } from './articles.js'

// German articles inflect by case; for an in-place page replacement we render the
// NOMINATIVE, the neutral citation form a reader expects ("der Hund", "die Katze").

// Definite: der (m) / die (f) / das (n) / die (plural, all genders).
function definiteArticle(gender: Gender, isPlural: boolean): string {
  if (isPlural) return 'die'
  if (gender === 'feminine') return 'die'
  if (gender === 'neuter') return 'das'
  return 'der'
}

// Indefinite: ein (m/n) / eine (f). German has NO plural indefinite article, so a
// plural noun is rendered bare (null) and the English "a/an" is still consumed.
function indefiniteArticle(gender: Gender, isPlural: boolean): string | null {
  if (isPlural) return null
  if (gender === 'feminine') return 'eine'
  return 'ein' // masculine and neuter
}

// German common nouns are always capitalized. Wiktionary targets already are, but
// capitalize the first letter defensively so a lowercase import never renders wrong.
function capitalizeNoun(target: string): string {
  if (!target) return target
  const idx = target.search(/\p{L}/u)
  if (idx === -1) return target
  return target.slice(0, idx) + target[idx]!.toUpperCase() + target.slice(idx + 1)
}

function nounReplacement(
  entry: NounTranslationEntry,
  fullText: string,
  wordStart: number,
  isPlural: boolean,
): ReplacementResult {
  const noun = capitalizeNoun(isPlural ? entry.plural : entry.target)
  const baseTarget = capitalizeNoun(entry.target)
  const detected = detectArticle(fullText, wordStart)

  if (detected.kind === 'definite') {
    return {
      displayText: `${definiteArticle(entry.gender, isPlural)} ${noun}`,
      replacementStart: detected.start,
      baseTarget,
    }
  }

  if (detected.kind === 'indefinite') {
    const article = indefiniteArticle(entry.gender, isPlural)
    return {
      displayText: article ? `${article} ${noun}` : noun,
      replacementStart: detected.start,
      baseTarget,
    }
  }

  return { displayText: noun, replacementStart: wordStart, baseTarget }
}

export function buildGermanReplacement(
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
