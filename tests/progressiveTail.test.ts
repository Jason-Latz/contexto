import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  ensureTailLoaded,
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

// Source lemmas that cannot exist in the real core packs, so their presence in
// lookup() is proof the (synthetic) tail was loaded and consulted.
const TAIL_SOURCE = 'zzznichetailword'
const TAIL_EXPRESSION = 'zzz niche phrase'

// Compact tuple layout (packFormat.ts):
//   [target, posCode, gloss, rank, confCode, gender|0, plural|0, enZipf, eligible, fnSubtype|0]
// posCode: noun=0 adverb=1 adjective=2 verb=3 expression=4 function=5; conf low=2.
const TAIL_WORD_TUPLE = ['nischenwort', 1, 'a niche test word', 1_000_001, 2, 0, 0, 0, 1, 0]
const TAIL_EXPR_TUPLE = ['nischenphrase', 4, 'a niche test expression', 1_000_002, 2, 0, 0, 0, 1, 0]

// The shipping tail is served as a chunk manifest + physical chunk files. This
// mirrors what scripts/build-compact-packs.mjs emits into dist/.
const DE_TAIL_MANIFEST = JSON.stringify({
  format: 'c1-chunked',
  version: '2026-07-01',
  sourceLanguage: 'en',
  targetLanguage: 'de',
  displayName: 'German',
  chunkCount: 2,
})
const DE_TAIL_CHUNK_0 = JSON.stringify({
  format: 'c1',
  version: '2026-07-01',
  sourceLanguage: 'en',
  targetLanguage: 'de',
  displayName: 'German',
  entries: { [TAIL_SOURCE]: TAIL_WORD_TUPLE },
})
const DE_TAIL_CHUNK_1 = JSON.stringify({
  format: 'c1',
  version: '2026-07-01',
  sourceLanguage: 'en',
  targetLanguage: 'de',
  displayName: 'German',
  entries: { [TAIL_EXPRESSION]: TAIL_EXPR_TUPLE },
})

// A verbose single-file tail (the committed public format + the fallback path).
const FR_TAIL_VERBOSE = JSON.stringify({
  version: '2026-07-01',
  sourceLanguage: 'en',
  targetLanguage: 'fr',
  displayName: 'French',
  entries: {
    [TAIL_SOURCE]: {
      source: TAIL_SOURCE,
      target: 'motrare',
      partOfSpeech: 'adverb',
      sourceGloss: 'a niche test word',
      frequencyRank: 1_000_001,
      confidence: 'low',
      sourceIds: ['test'],
      enZipf: 0,
      eligible: true,
    },
  },
})

interface FetchCounts {
  manifest: number
  chunks: number
}
let counts: FetchCounts
function installFetch(): void {
  counts = { manifest: 0, chunks: 0 }
  globalThis.fetch = async (url: string | URL | Request) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url

    // Manifest-level tail fetch (<lang>.tail.json): counted whatever the outcome.
    if (/\.tail\.json$/.test(href)) {
      counts.manifest++
      if (href.endsWith('de.tail.json')) return new Response(DE_TAIL_MANIFEST, { status: 200 })
      if (href.endsWith('fr.tail.json')) return new Response(FR_TAIL_VERBOSE, { status: 200 })
      // Any other language's tail is treated as absent for this test.
      return new Response('', { status: 404 })
    }
    if (href.endsWith('de.tail.0.json')) {
      counts.chunks++
      return new Response(DE_TAIL_CHUNK_0, { status: 200 })
    }
    if (href.endsWith('de.tail.1.json')) {
      counts.chunks++
      return new Response(DE_TAIL_CHUNK_1, { status: 200 })
    }
    const body = await readFile(new URL(href))
    return new Response(body, { status: 200 })
  }
}

// The loader is a module singleton shared across the tests in this file, so a
// prior test can leave a tail loaded. Force a fresh core (which resets the tail)
// by bouncing through a different language before each scenario. Only core packs
// are fetched here, so it never touches the tail fetch counters.
async function reloadCore(lang: 'de' | 'fr' | 'it' | 'es'): Promise<void> {
  await loadLanguagePack(lang === 'es' ? 'it' : 'es')
  await loadLanguagePack(lang)
}

test('the tail does not load with the core, and its words are not injectable until then', async () => {
  installFetch()

  await reloadCore('de')
  assert.equal(getActiveLanguagePack()?.targetLanguage, 'de', 'core pack loaded')
  assert.equal(isTailLoaded(), false, 'the tail must NOT be merged just because the core loaded')
  assert.equal(counts.manifest, 0, 'no tail fetch on a plain core load')
  assert.equal(lookup(TAIL_SOURCE), null, 'tail word not injectable before the tail percolates in')
  assert.equal(getExpressionKeys().includes(TAIL_EXPRESSION), false, 'tail expression not scannable yet')
})

test('ensureTailLoaded merges the chunked tail by default and its words resolve', async () => {
  installFetch()
  await reloadCore('de')

  await ensureTailLoaded('de')
  assert.equal(isTailLoaded(), true, 'tail fully merged after ensureTailLoaded resolves')
  assert.equal(counts.manifest, 1, 'manifest fetched once')
  assert.equal(counts.chunks, 2, 'both physical chunks fetched exactly once')

  const tailEntry = lookup(TAIL_SOURCE)
  assert.ok(tailEntry, 'tail word IS injectable once the tail is merged')
  assert.equal(tailEntry?.target, 'nischenwort')
  assert.equal(tailEntry?.source, TAIL_SOURCE, 'source reconstructed from the key')
  // Tail expressions must be scannable (materialized at merge time).
  assert.equal(getExpressionKeys().includes(TAIL_EXPRESSION), true, 'tail expression scannable after merge')
})

test('lookup materializes a tail entry on demand and caches it (stable reference)', async () => {
  installFetch()
  await reloadCore('de')
  await ensureTailLoaded('de')

  const first = lookup(TAIL_SOURCE)
  const second = lookup(TAIL_SOURCE)
  assert.ok(first && second)
  assert.strictEqual(first, second, 'the expanded entry is cached, not re-expanded per lookup')
})

test('ensureTailLoaded is idempotent and coalesces concurrent callers', async () => {
  installFetch()
  await reloadCore('de')

  // Two concurrent calls must share one in-flight load, not fetch twice.
  await Promise.all([ensureTailLoaded('de'), ensureTailLoaded('de')])
  assert.equal(counts.manifest, 1, 'manifest fetched once across concurrent callers')
  assert.equal(counts.chunks, 2, 'chunks fetched once across concurrent callers')

  // A call after the tail is loaded is a no-op (no further fetches).
  await ensureTailLoaded('de')
  assert.equal(counts.manifest, 1, 'no re-fetch once the tail is already merged')
})

test('switching the core language drops the old tail', async () => {
  installFetch()
  await reloadCore('de')
  await ensureTailLoaded('de')
  assert.equal(isTailLoaded(), true)
  assert.ok(lookup(TAIL_SOURCE), 'de tail word present')

  // A new core language invalidates the tail immediately.
  await loadLanguagePack('es')
  assert.equal(isTailLoaded(), false, 'tail dropped on language switch')
  assert.equal(lookup(TAIL_SOURCE), null, 'old-language tail word no longer resolves')
})

test('the single-file (verbose) tail path merges in slices', async () => {
  installFetch()
  await reloadCore('fr')
  await ensureTailLoaded('fr')

  assert.equal(isTailLoaded(), true)
  const entry = lookup(TAIL_SOURCE)
  assert.ok(entry, 'verbose single-file tail word resolves')
  assert.equal(entry?.target, 'motrare')
})

test('a missing tail shard is tolerated (core-only, no throw)', async () => {
  installFetch()
  // it has no tail file in this test (404).
  await reloadCore('it')
  await ensureTailLoaded('it')
  assert.equal(getActiveLanguagePack()?.targetLanguage, 'it')
  // An absent tail reads as "not loaded" (empty), so the content script never
  // fires a pointless percolation reconcile for a language with no tail.
  assert.equal(isTailLoaded(), false, 'an absent tail is not "loaded"')
  assert.equal(lookup(TAIL_SOURCE), null)
})

test('a re-run after an absent tail does not re-fetch', async () => {
  installFetch()
  await reloadCore('it')
  await ensureTailLoaded('it')
  const firstManifest = counts.manifest
  // The empty tail is committed, so a second ensureTailLoaded is a no-op.
  await ensureTailLoaded('it')
  assert.equal(counts.manifest, firstManifest, 'absent tail is not re-fetched on every percolation')
})
