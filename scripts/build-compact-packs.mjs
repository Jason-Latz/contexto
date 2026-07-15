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

// The niche tail ships as physical chunks so the runtime loader can fetch + parse
// + merge each in one bounded idle slice (see src/language/loader.ts). Keep this
// in sync with the loader's TAIL_MERGE_SLICE. Measured: ~2-3ms parse + ~1ms merge
// per 4,000 compact entries, comfortably under the 50ms slice budget even at 2x
// tail size (docs/overnight-2026-07-15).
const TAIL_CHUNK_SIZE = 4000
const TAIL_MANIFEST_FORMAT = 'c1-chunked'

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

// A tail pack -> a tiny chunk manifest plus N physical compact chunk files. The
// manifest carries the metadata (no entries); each chunk is an ordinary compact
// pack the loader merges in one idle slice. Returns { manifest, chunks, bytes }.
function chunkTailPack(pack, lang) {
  const compact = compactPack(pack)
  const keys = Object.keys(compact.entries)
  const chunkCount = Math.max(1, Math.ceil(keys.length / TAIL_CHUNK_SIZE))

  let bytes = 0
  for (let i = 0; i < chunkCount; i++) {
    const slice = keys.slice(i * TAIL_CHUNK_SIZE, (i + 1) * TAIL_CHUNK_SIZE)
    const entries = {}
    for (const k of slice) entries[k] = compact.entries[k]
    const chunk = JSON.stringify({
      format: 'c1',
      version: compact.version,
      sourceLanguage: compact.sourceLanguage,
      targetLanguage: compact.targetLanguage,
      displayName: compact.displayName,
      entries,
    })
    fs.writeFileSync(path.join(OUT, `${lang}.tail.${i}.json`), chunk)
    bytes += Buffer.byteLength(chunk)
  }

  const manifest = JSON.stringify({
    format: TAIL_MANIFEST_FORMAT,
    version: compact.version,
    sourceLanguage: compact.sourceLanguage,
    targetLanguage: compact.targetLanguage,
    displayName: compact.displayName,
    sources: compact.sources,
    chunkCount,
  })
  bytes += Buffer.byteLength(manifest)
  return { manifest, chunkCount, bytes }
}

// A tail file name is `<lang>.tail.json`; capture the lang. Core files (`<lang>.json`)
// return null and take the single-file compact path.
function tailLangOf(file) {
  const m = /^([a-z]{2})\.tail\.json$/.exec(file)
  return m ? m[1] : null
}

function main() {
  if (!fs.existsSync(OUT)) {
    console.warn(`[compact-packs] ${OUT} missing — run the vite build first; skipping.`)
    return
  }
  // Clear any stale tail chunks from a previous build (the tail can shrink), so
  // the manifest's chunkCount is never contradicted by leftover files.
  for (const file of fs.readdirSync(OUT)) {
    if (/^[a-z]{2}\.tail\.\d+\.json$/.test(file)) fs.rmSync(path.join(OUT, file))
  }

  let before = 0
  let after = 0
  for (const file of fs.readdirSync(SRC)) {
    if (!file.endsWith('.json')) continue
    const verbose = JSON.parse(fs.readFileSync(path.join(SRC, file), 'utf8'))
    before += fs.statSync(path.join(SRC, file)).size

    const lang = tailLangOf(file)
    if (lang) {
      // Overwrite the vite-copied verbose tail with the manifest + write chunks.
      const { manifest, chunkCount, bytes } = chunkTailPack(verbose, lang)
      fs.writeFileSync(path.join(OUT, file), manifest)
      after += bytes
      console.log(`[compact-packs] ${file}: ${chunkCount} chunk(s)`)
    } else {
      const compact = JSON.stringify(compactPack(verbose))
      fs.writeFileSync(path.join(OUT, file), compact)
      after += Buffer.byteLength(compact)
    }
  }
  console.log(`[compact-packs] shipped compact packs: ${(before / 1048576).toFixed(1)}MB -> ${(after / 1048576).toFixed(1)}MB`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
