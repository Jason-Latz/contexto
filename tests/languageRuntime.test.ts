import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { scanExpressions } from '../src/content/expressionScanner.js'
import { formatTooltipText } from '../src/content/hoverHandler.js'
import { loadLanguagePack, lookup } from '../src/language/loader.js'
import { selectTokens } from '../src/engine/wordSelector.js'
import { selectNonOverlappingReplacementRanges } from '../src/content/injector.js'
import type { CandidateToken } from '../src/types/index.js'

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

test('language pack loads high-confidence Spanish entries', async () => {
  await loadLanguagePack('es')
  const dog = lookup('dog')
  assert.equal(dog?.target, 'perro')
  assert.equal(dog?.partOfSpeech, 'noun')
})

test('fixed expressions are discovered from the active pack', async () => {
  await loadLanguagePack('es')
  const matches = scanExpressions('Of course, this example matters.')
  assert.equal(matches[0]?.entry.target, 'por supuesto')
})

test('expression scanner prefers the longest match at the same start', async () => {
  await loadLanguagePack('es')
  const matches = scanExpressions('The alternating series test is useful.')

  assert.equal(matches[0]?.entry.source, 'alternating series test')
})

test('expression scanner requires whitespace inside phrase matches', async () => {
  await loadLanguagePack('es')
  const matches = scanExpressions('Of, course, this should not match the phrase.')

  assert.equal(matches.some((match) => match.entry.source === 'of course'), false)
})

test('reported criterion phrase prefers phrase replacement over misleading parts', async () => {
  await loadLanguagePack('es')
  const matches = scanExpressions('It acts as a standard of judgment to measure skills.')

  assert.equal(matches[0]?.entry.source, 'a standard of judgment')
  assert.equal(matches[0]?.entry.target, 'un criterio')
})

test('selector honors the eligible-word density cap', async () => {
  await loadLanguagePack('es')
  const candidates: CandidateToken[] = [
    { word: 'dog', lemma: 'dog', start: 0, end: 3, partOfSpeech: 'noun', isPlural: false },
    { word: 'city', lemma: 'city', start: 4, end: 8, partOfSpeech: 'noun', isPlural: false },
  ]

  assert.equal(selectTokens(candidates, 0).length, 0)
  assert.equal(selectTokens(candidates, 1).length, 1)
  assert.equal(selectTokens(candidates, 2).length, 2)
})

test('replacement range selection prefers noun phrase replacement over article fragments', () => {
  const selected = selectNonOverlappingReplacementRanges([
    { id: 'an', start: 0, end: 2 },
    { id: 'opportunity', start: 0, end: 14 },
    { id: 'next', start: 15, end: 19 },
  ])

  assert.deepEqual(selected.map((range) => range.id), ['opportunity', 'next'])
})

test('replacement range selection keeps expression priority over article-consuming nouns', () => {
  const selected = selectNonOverlappingReplacementRanges([
    { id: 'noun-with-article', start: 0, end: 12, priority: 1 },
    { id: 'expression', start: 4, end: 24, priority: 2 },
  ])

  assert.deepEqual(selected.map((range) => range.id), ['expression'])
})

test('tooltip text includes source, gloss, and Spanish target', () => {
  const text = formatTooltipText('the dog', 'dog', 'el perro', 'a domesticated animal')
  assert.match(text, /the dog/)
  assert.match(text, /a domesticated animal/)
  assert.match(text, /Spanish: el perro/)
  assert.match(text, /Click to save as unknown/)
})

test('expanded runtime loads non-noun imported entries', async () => {
  await loadLanguagePack('es')
  const accurate = lookup('accurate')
  const accelerate = lookup('accelerate')
  const without = lookup('without')

  assert.equal(accurate?.partOfSpeech, 'adjective')
  assert.equal(accelerate?.partOfSpeech, 'verb')
  assert.equal(without?.partOfSpeech, 'function')
})

test('runtime does not load prefix or suffix marker targets', async () => {
  await loadLanguagePack('es')

  assert.equal(lookup('to'), null)
  assert.equal(lookup('apian'), null)
})

test('candidate extraction skips standalone determiners', async () => {
  await loadLanguagePack('es')
  globalThis.window = { location: { href: 'https://example.test/article' } } as any
  const { extractPageCandidates } = await import('../src/content/injector.js')
  const candidates = extractPageCandidates([
    { nodeValue: 'The company and they agreed to funding.' } as Text,
  ])
  const lemmas = new Set(candidates.map((candidate) => candidate.lemma))

  assert.equal(lemmas.has('the'), false)
  assert.equal(lemmas.has('company'), true)
})

test('duplicate imported headwords keep noun sense for plural noun contexts', async () => {
  await loadLanguagePack('es')
  const number = lookup('number')

  assert.equal(number?.partOfSpeech, 'noun')
  assert.equal(number?.target, 'número')
  if (number?.partOfSpeech === 'noun') {
    assert.equal(number.plural, 'números')
  }
})

test('duplicate imported headwords keep adverb sense for well', async () => {
  await loadLanguagePack('es')
  const well = lookup('well')

  assert.equal(well?.partOfSpeech, 'adverb')
  assert.equal(well?.target, 'bien')
})

test('hyphenated compounds are not replaced as partial fragments', async () => {
  await loadLanguagePack('es')
  globalThis.window = { location: { href: 'https://example.test/article' } } as any
  const { extractPageCandidates } = await import('../src/content/injector.js')
  const candidates = extractPageCandidates([
    { nodeValue: 'The well-developed system is useful.' } as Text,
  ])
  const lemmas = new Set(candidates.map((candidate) => candidate.lemma))

  assert.equal(lemmas.has('well'), false)
  assert.equal(lemmas.has('developed'), false)
})

test('candidate extraction reuses parsed text node cache', async () => {
  await loadLanguagePack('es')
  globalThis.window = { location: { href: 'https://example.test/article' } } as any
  const {
    extractPageCandidates,
    getParseCacheDiagnostics,
    resetParseCacheDiagnostics,
  } = await import('../src/content/injector.js')
  const node = {
    nodeValue: 'The numbers are useful, and of course context matters.',
  } as Text

  resetParseCacheDiagnostics()
  extractPageCandidates([node])
  extractPageCandidates([node])

  assert.deepEqual(getParseCacheDiagnostics(), { hits: 1, misses: 1 })
})

test('parsed text node cache invalidates when node text changes', async () => {
  await loadLanguagePack('es')
  globalThis.window = { location: { href: 'https://example.test/article' } } as any
  const {
    extractPageCandidates,
    getParseCacheDiagnostics,
    resetParseCacheDiagnostics,
  } = await import('../src/content/injector.js')
  const node = {
    nodeValue: 'The numbers are useful, and of course context matters.',
  } as Text

  resetParseCacheDiagnostics()
  extractPageCandidates([node])
  node.nodeValue = 'The cities are useful, and of course context matters.'
  extractPageCandidates([node])

  assert.deepEqual(getParseCacheDiagnostics(), { hits: 0, misses: 2 })
})
