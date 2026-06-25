import assert from 'node:assert/strict'
import test from 'node:test'
import { buildItalianReplacement } from '../src/language/italianAdapter.js'
import type { Gender, NounTranslationEntry, TranslationEntry } from '../src/types/index.js'

function noun(source: string, target: string, plural: string, gender: Gender): NounTranslationEntry {
  return {
    source, target, plural, gender,
    partOfSpeech: 'noun', sourceGloss: '', frequencyRank: 1, confidence: 'high', sourceIds: ['test'],
  }
}

const dog = noun('dog', 'cane', 'cani', 'masculine')          // il / i
const student = noun('student', 'studente', 'studenti', 'masculine') // lo / gli (s impura)
const backpack = noun('backpack', 'zaino', 'zaini', 'masculine')     // lo / gli (z)
const friendM = noun('friend', 'amico', 'amici', 'masculine')       // l' / gli (vowel)
const house = noun('house', 'casa', 'case', 'feminine')             // la / le
const friendF = noun('girlfriend', 'amica', 'amiche', 'feminine')   // l' / le (vowel)

test('Italian definite masculine: il (default) / lo (s-impura, z) / l’ (vowel)', () => {
  assert.equal(buildItalianReplacement(dog, 'the dog ran', 4, false).displayText, 'il cane')
  assert.equal(buildItalianReplacement(student, 'the student left', 4, false).displayText, 'lo studente')
  assert.equal(buildItalianReplacement(backpack, 'the backpack fell', 4, false).displayText, 'lo zaino')
  assert.equal(buildItalianReplacement(friendM, 'the friend left', 4, false).displayText, "l'amico")
})

test('Italian definite feminine: la / l’ (vowel)', () => {
  assert.equal(buildItalianReplacement(house, 'the house stood', 4, false).displayText, 'la casa')
  assert.equal(buildItalianReplacement(friendF, 'the girlfriend left', 4, false).displayText, "l'amica")
})

test('Italian definite plural: i / gli (vowel or s-impura) / le (feminine)', () => {
  assert.equal(buildItalianReplacement(dog, 'the dogs ran', 4, true).displayText, 'i cani')
  assert.equal(buildItalianReplacement(friendM, 'the friends left', 4, true).displayText, 'gli amici')
  assert.equal(buildItalianReplacement(student, 'the students left', 4, true).displayText, 'gli studenti')
  assert.equal(buildItalianReplacement(house, 'the houses stood', 4, true).displayText, 'le case')
})

test('Italian indefinite masculine: un / uno (s-impura, z) / un (before vowel)', () => {
  assert.equal(buildItalianReplacement(dog, 'a dog ran', 2, false).displayText, 'un cane')
  assert.equal(buildItalianReplacement(student, 'a student left', 2, false).displayText, 'uno studente')
  assert.equal(buildItalianReplacement(backpack, 'a backpack fell', 2, false).displayText, 'uno zaino')
  assert.equal(buildItalianReplacement(friendM, 'a friend left', 2, false).displayText, 'un amico')
})

test('Italian indefinite feminine: una / un’ (vowel)', () => {
  assert.equal(buildItalianReplacement(house, 'a house stood', 2, false).displayText, 'una casa')
  assert.equal(buildItalianReplacement(friendF, 'a girlfriend left', 2, false).displayText, "un'amica")
})

test('Italian consumes the English article', () => {
  assert.equal(buildItalianReplacement(student, 'the student left', 4, false).replacementStart, 0)
  assert.equal(buildItalianReplacement(student, 'a student left', 2, false).replacementStart, 0)
})

test('Italian with no article renders the bare noun', () => {
  assert.equal(buildItalianReplacement(dog, 'dogs everywhere', 0, true).displayText, 'cani')
})

test('Italian treats semivowel i+vowel like a consonant (lo iodio, la iena)', () => {
  const iodine = noun('iodine', 'iodio', 'iodi', 'masculine')
  const hyena = noun('hyena', 'iena', 'iene', 'feminine')
  assert.equal(buildItalianReplacement(iodine, 'the iodine', 4, false).displayText, 'lo iodio')
  assert.equal(buildItalianReplacement(iodine, 'a iodine', 2, false).displayText, 'uno iodio')
  assert.equal(buildItalianReplacement(iodine, 'the iodines', 4, true).displayText, 'gli iodi')
  assert.equal(buildItalianReplacement(hyena, 'the hyena', 4, false).displayText, 'la iena')
  assert.equal(buildItalianReplacement(hyena, 'a hyena', 2, false).displayText, 'una iena')
  assert.equal(buildItalianReplacement(hyena, 'the hyenas', 4, true).displayText, 'le iene')
})

test('Italian non-noun entries pass through unchanged', () => {
  const adj: TranslationEntry = {
    source: 'fast', target: 'veloce', partOfSpeech: 'adjective',
    sourceGloss: '', frequencyRank: 2, confidence: 'high', sourceIds: ['test'],
  }
  assert.equal(buildItalianReplacement(adj, 'a fast car', 2, false).displayText, 'veloce')
})
