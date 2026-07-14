// Pure composition logic for the hover teaching card.
//
// The injector writes what an entry can teach onto the span as data attributes
// (part of speech, noun citation form, gender, plural); the hover handler reads
// them back and renders. Everything that DECIDES what to show lives here as
// pure functions so missing-field behaviour (verbs, adjectives, expressions
// carry no gender/plural) is unit-testable without a DOM.

import type { TranslationEntry } from '../types/index.js'

// Learner-facing part-of-speech label. Function words show their concrete
// subtype (preposition/conjunction/pronoun), more useful than "function".
export function posLabel(entry: TranslationEntry): string {
  if (entry.partOfSpeech === 'expression') return 'phrase'
  if (entry.partOfSpeech === 'function') return entry.functionSubtype ?? ''
  return entry.partOfSpeech
}

// A handful of imported glosses carry Wiktionary sense-anchor artifacts like
// "common#Noun" or "cheap#Adjective". Strip the anchor, keep the word. Glosses
// about the actual "#" symbol are untouched (the # is not followed by a POS).
export function cleanGloss(gloss: string | null | undefined): string {
  if (!gloss) return ''
  return gloss.replace(
    /#(?:Noun|Verb|Adjective|Adverb|Pronoun|Preposition|Conjunction|Determiner|Interjection)\b/g,
    '',
  )
}

export interface TargetGrammar {
  // Citation form leading the target line: "la casa" / "das Haus" for nouns,
  // the base target for everything else. Never empty while `translated` is set.
  targetDisplay: string
  // "fem." / "masc.", only when the article shown does not reveal the gender
  // (French/Italian élision "l'eau"; Spanish stressed-a feminines "el agua").
  genderHint: string
  // "pl. Häuser", only when the plural is not a predictable +s/+es form.
  pluralHint: string
  // "infinitive" for verbs: the shown target is the dictionary form, not a
  // conjugation, and the learner should read it as such.
  formHint: string
}

export interface TargetGrammarAttrs {
  translated: string          // data-target: the text shown on the page
  baseTarget: string | null   // data-base-target: uninflected dictionary target
  articleForm: string | null  // data-article-form: definite article + singular (nouns)
  gender: string | null       // data-gender (nouns)
  plural: string | null       // data-plural (nouns)
  pos?: string | null         // data-pos: learner-facing posLabel() value
}

const GENDER_ABBREV: Record<string, string> = {
  feminine: 'fem.',
  masculine: 'masc.',
  neuter: 'neut.',
}

// Case- and accent-insensitive comparison base, so "información" + "es" matches
// "informaciones" and regular accent-shift plurals are not flagged as notable.
function foldForCompare(word: string): string {
  return word.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function genderHint(articleForm: string | null, gender: string | null): string {
  if (!articleForm || !gender) return ''
  const article = articleForm.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  const opaque =
    article.startsWith("l'") ||               // fr/it élision hides gender
    (article === 'el' && gender === 'feminine') // es stressed-a feminine takes "el"
  return opaque ? GENDER_ABBREV[gender] ?? '' : ''
}

function pluralHint(baseTarget: string | null, translated: string, plural: string | null): string {
  if (!plural) return ''
  const base = foldForCompare(baseTarget || translated)
  const p = foldForCompare(plural)
  if (p === base || p === `${base}s` || p === `${base}es`) return ''
  return `pl. ${plural}`
}

// Compose the grammar shown on the target line. All inputs come straight from
// getAttribute() and may be null (non-noun entries carry no article/gender/
// plural); the output strings are always safe to render: empty, never
// "null"/"undefined".
export function composeTargetGrammar(attrs: TargetGrammarAttrs): TargetGrammar {
  return {
    targetDisplay: attrs.articleForm || attrs.baseTarget || attrs.translated,
    genderHint: genderHint(attrs.articleForm, attrs.gender),
    pluralHint: pluralHint(attrs.baseTarget, attrs.translated, attrs.plural),
    formHint: attrs.pos === 'verb' ? 'infinitive' : '',
  }
}
