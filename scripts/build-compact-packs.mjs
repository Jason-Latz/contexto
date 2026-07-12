// Build step: convert the verbose committed language packs into the compact "c1"
// tuple format that actually ships in dist/. Runs after the vite build (which
// copies public/ verbatim into dist/), overwriting dist/language-packs/*.json with
// the compact form. The verbose files stay the committed source of truth.
//
// The tuple layout MUST match src/language/packFormat.ts (expander). A round-trip
// unit test (tests/packFormat.test.ts) imports compactEntry from here and
// expandCompactEntry from there and fails on any drift.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'public', 'language-packs')
const OUT = path.join(ROOT, 'dist', 'language-packs')

const POS_CODES = ['noun', 'adverb', 'adjective', 'verb', 'expression', 'function']
const CONF_CODES = ['high', 'medium', 'low']

// One verbose entry -> positional tuple. `source` and `sourceIds` are dropped:
// source is always the entry key, and sourceIds is provenance the runtime never reads.
export function compactEntry(e) {
  return [
    e.target,
    POS_CODES.indexOf(e.partOfSpeech),
    e.sourceGloss,
    e.frequencyRank,
    CONF_CODES.indexOf(e.confidence),
    e.gender ?? 0,
    e.plural ?? 0,
    e.enZipf ?? 0,
    e.eligible ? 1 : 0,
    e.functionSubtype ?? 0,
  ]
}

export function compactPack(pack) {
  const entries = {}
  for (const [key, e] of Object.entries(pack.entries)) {
    // The compact form reconstructs `source` from the key, so they must be equal
    // (they always are — importers lowercase every source). Fail loudly if that
    // ever changes rather than silently altering a source's casing.
    if (e.source !== key) throw new Error(`compact-packs: source "${e.source}" !== key "${key}"`)
    entries[key] = compactEntry(e)
  }
  return {
    format: 'c1',
    version: pack.version,
    sourceLanguage: pack.sourceLanguage,
    targetLanguage: pack.targetLanguage,
    displayName: pack.displayName,
    sources: pack.sources,
    entries,
  }
}

function main() {
  if (!fs.existsSync(OUT)) {
    console.warn(`[compact-packs] ${OUT} missing — run the vite build first; skipping.`)
    return
  }
  let before = 0
  let after = 0
  for (const file of fs.readdirSync(SRC)) {
    if (!file.endsWith('.json')) continue
    const verbose = JSON.parse(fs.readFileSync(path.join(SRC, file), 'utf8'))
    const compact = JSON.stringify(compactPack(verbose))
    fs.writeFileSync(path.join(OUT, file), compact)
    before += fs.statSync(path.join(SRC, file)).size
    after += Buffer.byteLength(compact)
  }
  console.log(`[compact-packs] shipped compact packs: ${(before / 1048576).toFixed(1)}MB -> ${(after / 1048576).toFixed(1)}MB`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
