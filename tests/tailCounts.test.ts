import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Verifies the shipped shards: each language pairs a curated core with a
// substantial niche tail, and every tail entry is well-formed for quarantine.
// Counts are asserted against a floor comfortably below what the pipeline
// currently produces (so honest regeneration variance doesn't flake), and the
// per-language ceilings are documented for the record.
const PACKS = `${process.cwd()}/public/language-packs`

function load(name: string): Record<string, any> {
  return JSON.parse(readFileSync(`${PACKS}/${name}`, 'utf8')).entries
}

// Floors (well under the achieved es 88.1k / de 73.2k / fr 72.1k / it 68.9k).
const FLOORS: Record<string, { core: number; total: number }> = {
  es: { core: 50000, total: 85000 },
  de: { core: 57000, total: 71000 },
  fr: { core: 55000, total: 70000 },
  it: { core: 58000, total: 67000 },
}

for (const [lang, floor] of Object.entries(FLOORS)) {
  test(`${lang}: core + niche tail clears the coverage floor`, () => {
    const core = load(`${lang}.json`)
    const tail = load(`${lang}.tail.json`)
    const coreN = Object.keys(core).length
    const tailN = Object.keys(tail).length

    assert.ok(coreN >= floor.core, `${lang} core ${coreN} < ${floor.core}`)
    assert.ok(tailN >= 8000, `${lang} tail ${tailN} unexpectedly small`)
    assert.ok(coreN + tailN >= floor.total, `${lang} core+tail ${coreN + tailN} < ${floor.total}`)
  })

  test(`${lang}: every tail entry is quarantine-safe (low-confidence, niche, disjoint)`, () => {
    const coreKeys = new Set(Object.keys(load(`${lang}.json`)))
    const tail = load(`${lang}.tail.json`)
    for (const [key, entry] of Object.entries(tail)) {
      assert.equal(entry.confidence, 'low', `${lang}.tail ${key} must be low confidence`)
      assert.ok((entry.enZipf ?? 0) < 5.0, `${lang}.tail ${key} enZipf ${entry.enZipf} not niche (< 5.0)`)
      assert.equal(coreKeys.has(key), false, `${lang}.tail ${key} duplicates a core key`)
    }
  })
}
