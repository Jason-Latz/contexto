import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFrenchReplacement } from '../src/language/frenchAdapter.js'
import type { Gender, NounTranslationEntry, TranslationEntry } from '../src/types/index.js'

function noun(source: string, target: string, plural: string, gender: Gender): NounTranslationEntry {
  return {
    source, target, plural, gender,
    partOfSpeech: 'noun', sourceGloss: '', frequencyRank: 1, confidence: 'high', sourceIds: ['test'],
  }
}

const book = noun('book', 'livre', 'livres', 'masculine')
const house = noun('house', 'maison', 'maisons', 'feminine')
const friendM = noun('friend', 'ami', 'amis', 'masculine')
const friendF = noun('friend', 'amie', 'amies', 'feminine')
const man = noun('man', 'homme', 'hommes', 'masculine')

test('French definite article: le (m) / la (f)', () => {
  assert.equal(buildFrenchReplacement(book, 'the book fell', 4, false).displayText, 'le livre')
  assert.equal(buildFrenchReplacement(house, 'the house stood', 4, false).displayText, 'la maison')
})

test('French definite élides to l’ before a vowel or mute h', () => {
  assert.equal(buildFrenchReplacement(friendM, 'the friend left', 4, false).displayText, "l'ami")
  assert.equal(buildFrenchReplacement(friendF, 'the friend left', 4, false).displayText, "l'amie")
  assert.equal(buildFrenchReplacement(man, 'the man left', 4, false).displayText, "l'homme")
})

test('French definite plural is les (no élision)', () => {
  assert.equal(buildFrenchReplacement(book, 'the books fell', 4, true).displayText, 'les livres')
  assert.equal(buildFrenchReplacement(friendM, 'the friends left', 4, true).displayText, 'les amis')
})

test('French indefinite article: un (m) / une (f), no élision', () => {
  assert.equal(buildFrenchReplacement(book, 'a book fell', 2, false).displayText, 'un livre')
  assert.equal(buildFrenchReplacement(house, 'a house stood', 2, false).displayText, 'une maison')
  assert.equal(buildFrenchReplacement(friendM, 'a friend left', 2, false).displayText, 'un ami')
})

test('French consumes the English article', () => {
  assert.equal(buildFrenchReplacement(book, 'the book fell', 4, false).replacementStart, 0)
  assert.equal(buildFrenchReplacement(friendM, 'the friend left', 4, false).replacementStart, 0)
})

test('French with no article renders the bare noun', () => {
  assert.equal(buildFrenchReplacement(book, 'books everywhere', 0, true).displayText, 'livres')
})

test('French aspirated h blocks élision (le héros), mute h still élides (l’hôtel)', () => {
  const hero = noun('hero', 'héros', 'héros', 'masculine')
  const bean = noun('bean', 'haricot', 'haricots', 'masculine')
  const hotel = noun('hotel', 'hôtel', 'hôtels', 'masculine')
  assert.equal(buildFrenchReplacement(hero, 'the hero left', 4, false).displayText, 'le héros')
  assert.equal(buildFrenchReplacement(bean, 'the bean', 4, false).displayText, 'le haricot')
  assert.equal(buildFrenchReplacement(hotel, 'the hotel', 4, false).displayText, "l'hôtel")
})

test('French non-noun entries pass through unchanged', () => {
  const adj: TranslationEntry = {
    source: 'fast', target: 'rapide', partOfSpeech: 'adjective',
    sourceGloss: '', frequencyRank: 2, confidence: 'high', sourceIds: ['test'],
  }
  assert.equal(buildFrenchReplacement(adj, 'a fast car', 2, false).displayText, 'rapide')
})
