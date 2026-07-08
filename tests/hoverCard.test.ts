// Hover teaching-card composition: part-of-speech labels, gloss sanitation,
// and the target line's citation form / gender hint / plural hint, including
// entries whose grammar fields are missing (verbs, adjectives, expressions).
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cleanGloss, composeTargetGrammar, posLabel } from '../src/content/hoverCard.js'
import type { TranslationEntry } from '../src/types/index.js'

function entry(partial: Record<string, unknown>): TranslationEntry {
  return {
    source: 'x', target: 'y', sourceGloss: '', frequencyRank: 1,
    confidence: 'high', sourceIds: [], ...partial,
  } as unknown as TranslationEntry
}

test('posLabel maps entry kinds to learner-facing labels', () => {
  assert.equal(posLabel(entry({ partOfSpeech: 'noun', gender: 'feminine', plural: 'ys' })), 'noun')
  assert.equal(posLabel(entry({ partOfSpeech: 'verb' })), 'verb')
  assert.equal(posLabel(entry({ partOfSpeech: 'adjective' })), 'adjective')
  assert.equal(posLabel(entry({ partOfSpeech: 'expression' })), 'phrase')
  assert.equal(posLabel(entry({ partOfSpeech: 'function', functionSubtype: 'preposition' })), 'preposition')
})

test('posLabel never yields "undefined" for a function entry missing its subtype', () => {
  assert.equal(posLabel(entry({ partOfSpeech: 'function' })), '')
})

test('cleanGloss strips Wiktionary sense-anchor artifacts', () => {
  assert.equal(
    cleanGloss('anyone engaged in agriculture on a farm#Noun.'),
    'anyone engaged in agriculture on a farm.',
  )
  assert.equal(
    cleanGloss('The state#Noun or character trait of being cheap#Adjective (stingy).'),
    'The state or character trait of being cheap (stingy).',
  )
})

test('cleanGloss keeps glosses about the actual # symbol and handles null', () => {
  assert.equal(cleanGloss('the hash sign (the # symbol)'), 'the hash sign (the # symbol)')
  assert.equal(cleanGloss(null), '')
  assert.equal(cleanGloss(undefined), '')
})

test('noun with article form leads with the citation form', () => {
  const g = composeTargetGrammar({
    translated: 'Un granjero', baseTarget: 'granjero',
    articleForm: 'el granjero', gender: 'masculine', plural: 'granjeros',
  })
  assert.equal(g.targetDisplay, 'el granjero')
  assert.equal(g.genderHint, '')     // "el" already signals masculine
  assert.equal(g.pluralHint, '')     // granjeros = granjero + s, predictable
})

test('German noun surfaces a non-obvious plural', () => {
  const g = composeTargetGrammar({
    translated: 'Haus', baseTarget: 'Haus',
    articleForm: 'das Haus', gender: 'neuter', plural: 'Häuser',
  })
  assert.equal(g.targetDisplay, 'das Haus')
  assert.equal(g.pluralHint, 'pl. Häuser')
  assert.equal(g.genderHint, '')     // "das" already signals neuter
})

test('plural identical to the singular is not repeated', () => {
  const g = composeTargetGrammar({
    translated: 'Fenster', baseTarget: 'Fenster',
    articleForm: 'das Fenster', gender: 'neuter', plural: 'Fenster',
  })
  assert.equal(g.pluralHint, '')
})

test('accent-shift +es plurals count as predictable', () => {
  const g = composeTargetGrammar({
    translated: 'información', baseTarget: 'información',
    articleForm: 'la información', gender: 'feminine', plural: 'informaciones',
  })
  assert.equal(g.pluralHint, '')
})

test('Spanish stressed-a feminine gets a gender hint despite "el"', () => {
  const g = composeTargetGrammar({
    translated: 'el agua', baseTarget: 'agua',
    articleForm: 'el agua', gender: 'feminine', plural: 'aguas',
  })
  assert.equal(g.targetDisplay, 'el agua')
  assert.equal(g.genderHint, 'fem.')
})

test('French élision hides gender, so the hint spells it out', () => {
  const g = composeTargetGrammar({
    translated: "l'eau", baseTarget: 'eau',
    articleForm: "l'eau", gender: 'feminine', plural: 'eaux',
  })
  assert.equal(g.genderHint, 'fem.')
  assert.equal(g.pluralHint, 'pl. eaux')
})

test('entries without grammar fields render clean (no null/undefined leakage)', () => {
  // Adjectives, verbs, adverbs, and expressions carry no article/gender/plural:
  // every attribute except data-target reads back null.
  const g = composeTargetGrammar({
    translated: 'Fresco', baseTarget: 'fresco',
    articleForm: null, gender: null, plural: null,
  })
  assert.equal(g.targetDisplay, 'fresco') // base target: citation over sentence casing
  assert.equal(g.genderHint, '')
  assert.equal(g.pluralHint, '')
  for (const v of Object.values(g)) {
    assert.doesNotMatch(String(v), /undefined|null/)
  }
})

test('falls back to the displayed text when even base target is missing', () => {
  const g = composeTargetGrammar({
    translated: 'schrecken', baseTarget: null,
    articleForm: null, gender: null, plural: null,
  })
  assert.equal(g.targetDisplay, 'schrecken')
})
