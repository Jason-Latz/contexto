import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSpanishReplacement } from '../src/language/spanishAdapter.js'
import type { NounTranslationEntry } from '../src/types/index.js'

const dog: NounTranslationEntry = {
  source: 'dog',
  target: 'perro',
  plural: 'perros',
  gender: 'masculine',
  partOfSpeech: 'noun',
  sourceGloss: 'a domesticated animal',
  frequencyRank: 1,
  confidence: 'high',
}

const city: NounTranslationEntry = {
  source: 'city',
  target: 'ciudad',
  plural: 'ciudades',
  gender: 'feminine',
  partOfSpeech: 'noun',
  sourceGloss: 'a large town',
  frequencyRank: 2,
  confidence: 'high',
}

test('Spanish adapter handles definite masculine nouns', () => {
  const result = buildSpanishReplacement(dog, 'the dog slept', 4, false)
  assert.equal(result.displayText, 'el perro')
  assert.equal(result.replacementStart, 0)
})

test('Spanish adapter handles indefinite feminine nouns', () => {
  const result = buildSpanishReplacement(city, 'a city grew', 2, false)
  assert.equal(result.displayText, 'una ciudad')
  assert.equal(result.replacementStart, 0)
})

test('Spanish adapter handles plural definite nouns', () => {
  const result = buildSpanishReplacement(dog, 'the dogs barked', 4, true)
  assert.equal(result.displayText, 'los perros')
  assert.equal(result.replacementStart, 0)
})
