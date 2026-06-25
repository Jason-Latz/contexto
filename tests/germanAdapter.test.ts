import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGermanReplacement } from '../src/language/germanAdapter.js'
import type { Gender, NounTranslationEntry, TranslationEntry } from '../src/types/index.js'

function noun(source: string, target: string, plural: string, gender: Gender): NounTranslationEntry {
  return {
    source, target, plural, gender,
    partOfSpeech: 'noun', sourceGloss: '', frequencyRank: 1, confidence: 'high', sourceIds: ['test'],
  }
}

const dog = noun('dog', 'Hund', 'Hunde', 'masculine')
const cat = noun('cat', 'Katze', 'Katzen', 'feminine')
const house = noun('house', 'Haus', 'Häuser', 'neuter')

test('German definite article: der (m) / die (f) / das (n)', () => {
  assert.equal(buildGermanReplacement(dog, 'the dog ran', 4, false).displayText, 'der Hund')
  assert.equal(buildGermanReplacement(cat, 'the cat ran', 4, false).displayText, 'die Katze')
  assert.equal(buildGermanReplacement(house, 'the house stood', 4, false).displayText, 'das Haus')
})

test('German definite plural is die for all genders', () => {
  assert.equal(buildGermanReplacement(dog, 'the dogs ran', 4, true).displayText, 'die Hunde')
  assert.equal(buildGermanReplacement(house, 'the houses stood', 4, true).displayText, 'die Häuser')
})

test('German indefinite article: ein (m/n) / eine (f)', () => {
  assert.equal(buildGermanReplacement(dog, 'a dog ran', 2, false).displayText, 'ein Hund')
  assert.equal(buildGermanReplacement(house, 'a house stood', 2, false).displayText, 'ein Haus')
  assert.equal(buildGermanReplacement(cat, 'a cat ran', 2, false).displayText, 'eine Katze')
})

test('German consumes the English article (replacementStart)', () => {
  assert.equal(buildGermanReplacement(dog, 'the dog ran', 4, false).replacementStart, 0)
  assert.equal(buildGermanReplacement(dog, 'a dog ran', 2, false).replacementStart, 0)
})

test('German nouns are always capitalized, even from a lowercase import', () => {
  const lower = noun('dog', 'hund', 'hunde', 'masculine')
  assert.equal(buildGermanReplacement(lower, 'the dog ran', 4, false).displayText, 'der Hund')
  assert.equal(buildGermanReplacement(lower, 'dogs ran', 0, true).displayText, 'Hunde')
})

test('German with no article renders the bare capitalized noun', () => {
  const result = buildGermanReplacement(dog, 'dogs everywhere', 0, true)
  assert.equal(result.displayText, 'Hunde')
  assert.equal(result.replacementStart, 0)
})

test('German non-noun entries pass through unchanged (no capitalization)', () => {
  const adj: TranslationEntry = {
    source: 'fast', target: 'schnell', partOfSpeech: 'adjective',
    sourceGloss: '', frequencyRank: 2, confidence: 'high', sourceIds: ['test'],
  }
  assert.equal(buildGermanReplacement(adj, 'a fast car', 2, false).displayText, 'schnell')
})
