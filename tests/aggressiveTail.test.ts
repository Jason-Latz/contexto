import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  getActiveLanguagePack,
  getExpressionKeys,
  loadLanguagePack,
  lookup,
  isTailLoaded,
} from '../src/language/loader.js'

const root = pathToFileURL(process.cwd() + '/public/').href

globalThis.chrome = {
  runtime: {
    id: 'test-extension',
    getURL(path: string) {
      return `${root}${path}`
    },
  },
} as any

// A source lemma that cannot exist in the real German core pack, so its presence
// in lookup() is proof the (synthetic) tail shard was loaded and consulted.
const TAIL_SOURCE = 'zzznichetailword'
const TAIL_EXPRESSION = 'zzz niche phrase'
const SYNTHETIC_DE_TAIL = JSON.stringify({
  version: '2026-07-01',
  sourceLanguage: 'en',
  targetLanguage: 'de',
  displayName: 'German',
  sources: { test: { name: 'test tail', url: 'https://example.test', license: 'CC' } },
  entries: {
    [TAIL_SOURCE]: {
      source: TAIL_SOURCE,
      target: 'nischenwort',
      partOfSpeech: 'adverb',
      sourceGloss: 'a niche test word',
      frequencyRank: 1_000_001,
      confidence: 'low',
      sourceIds: ['test'],
      enZipf: 0,
      eligible: true,
    },
    [TAIL_EXPRESSION]: {
      source: TAIL_EXPRESSION,
      target: 'nischenphrase',
      partOfSpeech: 'expression',
      sourceGloss: 'a niche test expression',
      frequencyRank: 1_000_002,
      confidence: 'low',
      sourceIds: ['test'],
      enZipf: 0,
      eligible: true,
    },
  },
})

let tailFetchCount = 0
function installCountingFetch(): void {
  tailFetchCount = 0
  globalThis.fetch = async (url: string | URL | Request) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    if (href.endsWith('de.tail.json')) {
      tailFetchCount++
      return new Response(SYNTHETIC_DE_TAIL, { status: 200 })
    }
    // Any other tail shard is treated as absent for this test.
    if (href.endsWith('.tail.json')) return new Response('', { status: 404 })
    const body = await readFile(new URL(href))
    return new Response(body, { status: 200 })
  }
}

test('the niche tail is quarantined by default and lazy-loaded only in aggressive mode', async () => {
  installCountingFetch()

  // 1) Default load (aggressive OFF): the tail shard is never fetched, and its
  //    words are not injectable — quarantine is enforced purely at the loader.
  await loadLanguagePack('de', false)
  assert.equal(getActiveLanguagePack()?.targetLanguage, 'de', 'core pack loaded')
  assert.equal(isTailLoaded(), false)
  assert.equal(tailFetchCount, 0, 'tail shard must NOT be fetched on a default page load')
  assert.equal(lookup(TAIL_SOURCE), null, 'tail word must not be injectable by default')
  assert.equal(getExpressionKeys().includes(TAIL_EXPRESSION), false, 'tail expression quarantined by default')

  // 2) Aggressive ON: the tail is fetched exactly once and its words resolve.
  await loadLanguagePack('de', true)
  assert.equal(isTailLoaded(), true)
  assert.equal(tailFetchCount, 1, 'tail shard fetched exactly once when aggressive mode turns on')
  const tailEntry = lookup(TAIL_SOURCE)
  assert.ok(tailEntry, 'tail word IS injectable in aggressive mode')
  assert.equal(tailEntry?.target, 'nischenwort')
  // Tail EXPRESSIONS must be scannable too (not dead weight) — they inject only
  // via getExpressionEntries, which must draw from the tail when it is loaded.
  assert.equal(getExpressionKeys().includes(TAIL_EXPRESSION), true, 'tail expression scannable in aggressive mode')

  // 3) Aggressive OFF again: the tail is dropped, re-quarantining its words.
  await loadLanguagePack('de', false)
  assert.equal(isTailLoaded(), false)
  assert.equal(lookup(TAIL_SOURCE), null, 're-quarantined when aggressive mode turns off')
  assert.equal(getExpressionKeys().includes(TAIL_EXPRESSION), false, 'tail expression re-quarantined when off')
})

test('a missing tail shard is tolerated (aggressive mode degrades to core-only)', async () => {
  globalThis.fetch = async (url: string | URL | Request) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    if (href.endsWith('.tail.json')) return new Response('', { status: 404 })
    const body = await readFile(new URL(href))
    return new Response(body, { status: 200 })
  }

  // fr has (in this test) no tail file; aggressive mode must not throw.
  await loadLanguagePack('fr', true)
  assert.equal(getActiveLanguagePack()?.targetLanguage, 'fr')
  assert.equal(lookup(TAIL_SOURCE), null)
})
