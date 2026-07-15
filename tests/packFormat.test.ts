import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { expandCompactEntry } from '../src/language/packFormat.js'

// Import the build script's compactor by absolute path so this test verifies the
// SHIPPING codec (scripts/build-compact-packs.mjs) round-trips through the loader's
// expander (src/language/packFormat.ts). Any drift between the two fails here.
const { compactEntry } = await import(`${process.cwd()}/scripts/build-compact-packs.mjs`)

function loadVerbose(name: string): Record<string, any> {
  return JSON.parse(readFileSync(`${process.cwd()}/public/language-packs/${name}`, 'utf8')).entries
}

// Round-trip EVERY entry of real packs and assert every runtime-relevant field
// survives compact -> expand. Cores cover 2/3 genders + functions + high/medium
// confidence + expressions; tails cover confidence 'low' (code 2), enZipf 0, and
// niche expression entries — so all tuple positions and code values are exercised.
for (const name of ['es.json', 'de.json', 'es.tail.json', 'it.tail.json']) {
  test(`${name}: compact -> expand preserves all runtime fields`, () => {
    const entries = loadVerbose(name)
    let checked = 0
    for (const [key, e] of Object.entries(entries)) {
      const r = expandCompactEntry(key, compactEntry(e))
      assert.equal(r.source, key)
      assert.equal(r.target, e.target)
      assert.equal(r.partOfSpeech, e.partOfSpeech)
      assert.equal(r.sourceGloss, e.sourceGloss)
      assert.equal(r.frequencyRank, e.frequencyRank)
      assert.equal(r.confidence, e.confidence)
      assert.equal(r.enZipf ?? 0, e.enZipf ?? 0)
      assert.equal(r.eligible, e.eligible === true)
      if (e.partOfSpeech === 'noun') {
        assert.equal((r as any).gender, e.gender)
        assert.equal((r as any).plural, e.plural)
      }
      if (e.partOfSpeech === 'function') {
        assert.equal((r as any).functionSubtype, e.functionSubtype)
      }
      checked++
    }
    assert.equal(checked, Object.keys(entries).length)
    assert.ok(checked > 5000, `expected a substantial pack, got ${checked}`)
  })
}

// The loader must read the compact format the same as verbose. Isolation-safe:
// the fetch mock serves REAL files by default and the synthetic compact `it` pack
// only while `serveCompact` is on; afterwards the real `it` pack is reloaded into
// the shared loader cache so other test files still see real data.
test('loader reads a compact pack and expands entries on lookup', async () => {
  const root = pathToFileURL(`${process.cwd()}/public/`).href
  globalThis.chrome = {
    runtime: { id: 'test-extension', getURL: (p: string) => `${root}${p}` },
  } as any

  const compactPack = JSON.stringify({
    format: 'c1',
    version: '2026-07-01',
    sourceLanguage: 'en',
    targetLanguage: 'it',
    displayName: 'Italian',
    sources: { test: { name: 't', url: 'https://example.test', license: 'CC' } },
    // [target, posCode, gloss, rank, confCode, gender|0, plural|0, enZipf, eligible, fnSubtype|0]
    entries: {
      compacttestword: ['parolina', 2 /* adjective */, 'a test word', 7, 1 /* medium */, 0, 0, 3.0, 1, 0],
      compacttestnoun: ['gattino', 0 /* noun */, 'a kitten', 8, 0 /* high */, 'masculine', 'gattini', 4.0, 1, 0],
    },
  })
  let serveCompact = true
  globalThis.fetch = async (url: string | URL | Request) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    if (serveCompact && href.endsWith('it.json') && !href.endsWith('.tail.json')) {
      return new Response(compactPack, { status: 200 })
    }
    if (href.endsWith('.tail.json')) return new Response('', { status: 404 })
    return new Response(await readFile(new URL(href)), { status: 200 })
  }

  const { loadLanguagePack, lookup } = await import('../src/language/loader.js')
  await loadLanguagePack('it')

  const adj = lookup('compacttestword')
  assert.equal(adj?.target, 'parolina')
  assert.equal(adj?.partOfSpeech, 'adjective')
  assert.equal(adj?.confidence, 'medium')

  const noun = lookup('compacttestnoun')
  assert.equal(noun?.partOfSpeech, 'noun')
  assert.equal(noun?.target, 'gattino')
  if (noun?.partOfSpeech === 'noun') {
    assert.equal(noun.gender, 'masculine')
    assert.equal(noun.plural, 'gattini')
  }

  // Restore real data in the shared loader singleton for other test files: switch
  // languages (to force a reload past the same-language cache) then reload real it.
  serveCompact = false
  await loadLanguagePack('es')
  await loadLanguagePack('it')
  assert.equal(lookup('compacttestword'), null, 'synthetic compact entry cleared after restore')
})
