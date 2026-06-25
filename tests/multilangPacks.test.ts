import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  getActiveLanguagePack,
  getActiveTargetLanguage,
  loadLanguagePack,
  lookup,
} from '../src/language/loader.js'
import { buildReplacement } from '../src/language/replacement.js'
import type { TargetLanguage } from '../src/types/index.js'

const root = pathToFileURL(process.cwd() + '/public/').href

globalThis.chrome = {
  runtime: {
    id: 'test-extension',
    getURL(path: string) {
      return `${root}${path}`
    },
  },
} as any

globalThis.fetch = async (url: string | URL | Request) => {
  const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
  const body = await readFile(new URL(href))
  return new Response(body, { status: 200 })
}

// Render a definite-article replacement the way the content script does, going
// through the real loaded pack (not a hand-built fixture).
function render(lang: TargetLanguage, english: string, fullText: string, wordStart: number): string {
  const entry = lookup(english)
  assert.ok(entry, `${lang}: expected an entry for "${english}"`)
  return buildReplacement(lang, entry!, fullText, wordStart, false).displayText
}

function genderOf(english: string): string | undefined {
  const entry = lookup(english)
  return entry && entry.partOfSpeech === 'noun' ? entry.gender : undefined
}

test('every shipped pack loads, is ≥50k entries, and reports its language', async () => {
  for (const lang of ['es', 'de', 'fr', 'it'] as const) {
    await loadLanguagePack(lang)
    assert.equal(getActiveTargetLanguage(), lang)
    const pack = getActiveLanguagePack()
    assert.equal(pack?.targetLanguage, lang)
    assert.ok(Object.keys(pack?.entries ?? {}).length >= 50_000, `${lang} pack must have ≥50k entries`)
  }
})

test('German pack renders correct articles incl. neuter from real data', async () => {
  await loadLanguagePack('de')
  assert.equal(genderOf('house'), 'neuter')
  assert.equal(render('de', 'house', 'the house stood', 4), 'das Haus')
  assert.equal(render('de', 'dog', 'the dog ran', 4), 'der Hund')
  assert.equal(render('de', 'woman', 'the woman left', 4), 'die Frau')
})

test('French pack élides l’ before a vowel from real data', async () => {
  await loadLanguagePack('fr')
  assert.equal(genderOf('water'), 'feminine')
  assert.equal(render('fr', 'water', 'the water rose', 4), "l'eau")
  assert.equal(render('fr', 'house', 'the house stood', 4), 'la maison')
  assert.equal(render('fr', 'book', 'the book fell', 4), 'le livre')
})

test('Italian pack picks lo / l’ from real data', async () => {
  await loadLanguagePack('it')
  assert.equal(render('it', 'student', 'the student left', 4), 'lo studente')
  assert.equal(render('it', 'friend', 'the friend left', 4), "l'amico")
  assert.equal(render('it', 'house', 'the house stood', 4), 'la casa')
  assert.equal(render('it', 'dog', 'the dog ran', 4), 'il cane')
})
