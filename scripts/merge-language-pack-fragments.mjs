import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cwd } from 'node:process'

const VALID_POS = new Set(['noun', 'adverb', 'adjective', 'verb', 'expression', 'function'])
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low'])
const VALID_SPANISH_GENDER = new Set(['masculine', 'feminine'])
const VALID_FUNCTION_SUBTYPE = new Set(['preposition', 'conjunction', 'determiner', 'pronoun'])

function fail(message) {
  throw new Error(message)
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${label} must be a non-empty string`)
  }
}

function validateEntry(key, entry, targetLanguage, label) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    fail(`${label}:${key} must be an object`)
  }

  requireString(entry.source, `${label}:${key}.source`)
  requireString(entry.target, `${label}:${key}.target`)
  requireString(entry.sourceGloss, `${label}:${key}.sourceGloss`)

  if (key !== entry.source.toLowerCase()) {
    fail(`${label}:${key} must match source lowercased (${entry.source})`)
  }

  if (!VALID_POS.has(entry.partOfSpeech)) {
    fail(`${label}:${key}.partOfSpeech is invalid`)
  }

  if (!VALID_CONFIDENCE.has(entry.confidence)) {
    fail(`${label}:${key}.confidence is invalid`)
  }

  if (!Number.isInteger(entry.frequencyRank) || entry.frequencyRank <= 0) {
    fail(`${label}:${key}.frequencyRank must be a positive integer`)
  }

  if (!Array.isArray(entry.sourceIds) || entry.sourceIds.length === 0) {
    fail(`${label}:${key}.sourceIds must be a non-empty array`)
  }

  if (targetLanguage === 'es' && entry.partOfSpeech === 'noun') {
    if (!VALID_SPANISH_GENDER.has(entry.gender)) {
      fail(`${label}:${key}.gender must be masculine or feminine`)
    }
    requireString(entry.plural, `${label}:${key}.plural`)
  }

  if (entry.partOfSpeech !== 'noun') {
    if ('gender' in entry) fail(`${label}:${key} non-noun must not include gender`)
    if ('plural' in entry) fail(`${label}:${key} non-noun must not include plural`)
  }

  if (entry.partOfSpeech === 'function') {
    if (!VALID_FUNCTION_SUBTYPE.has(entry.functionSubtype)) {
      fail(`${label}:${key}.functionSubtype is invalid`)
    }
  } else if ('functionSubtype' in entry) {
    fail(`${label}:${key} non-function must not include functionSubtype`)
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

function parseArgs(argv) {
  let targetLanguage = 'es'
  const fragments = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--target') {
      targetLanguage = argv[++i]
      if (!targetLanguage) fail('--target requires a language code')
    } else {
      fragments.push(arg)
    }
  }

  if (fragments.length === 0) {
    fail('Usage: node scripts/merge-language-pack-fragments.mjs [--target es] <fragment.json>...')
  }

  return { targetLanguage, fragments }
}

const { targetLanguage, fragments } = parseArgs(process.argv.slice(2))
const root = cwd()
const packFile = join(root, 'public', 'language-packs', `${targetLanguage}.json`)
const pack = await readJson(packFile)

if (pack.sourceLanguage !== 'en') fail(`${packFile}: sourceLanguage must be en`)
if (pack.targetLanguage !== targetLanguage) fail(`${packFile}: targetLanguage mismatch`)
if (!pack.entries || typeof pack.entries !== 'object' || Array.isArray(pack.entries)) {
  fail(`${packFile}: entries must be an object`)
}

const mergedEntries = { ...pack.entries }
const baseKeys = new Set(Object.keys(mergedEntries))
const addedFragmentKeys = new Set()
const ranks = Object.values(mergedEntries)
  .map(entry => entry.frequencyRank)
  .filter(Number.isInteger)
let nextRank = Math.max(0, ...ranks) + 1

const report = {
  added: 0,
  skippedExisting: 0,
  skippedFragmentDuplicate: 0,
  fragments: [],
}

for (const fragmentFile of fragments) {
  const fragment = await readJson(fragmentFile)
  const entries = fragment.entries ?? fragment
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    fail(`${fragmentFile}: expected an entries object or a raw entry map`)
  }

  const fragmentSeen = new Set()
  const fragmentReport = {
    file: fragmentFile,
    input: 0,
    added: 0,
    skippedExisting: 0,
    skippedFragmentDuplicate: 0,
  }

  for (const [key, entry] of Object.entries(entries)) {
    fragmentReport.input++
    validateEntry(key, entry, targetLanguage, fragmentFile)

    if (fragmentSeen.has(key)) {
      fragmentReport.skippedFragmentDuplicate++
      report.skippedFragmentDuplicate++
      continue
    }
    fragmentSeen.add(key)

    if (baseKeys.has(key)) {
      fragmentReport.skippedExisting++
      report.skippedExisting++
      continue
    }

    if (addedFragmentKeys.has(key)) {
      fragmentReport.skippedFragmentDuplicate++
      report.skippedFragmentDuplicate++
      continue
    }

    mergedEntries[key] = { ...entry, frequencyRank: nextRank++ }
    addedFragmentKeys.add(key)
    fragmentReport.added++
    report.added++
  }

  report.fragments.push(fragmentReport)
}

const output = {
  ...pack,
  entries: mergedEntries,
}

await writeFile(packFile, `${JSON.stringify(output, null, 2)}\n`)

console.log(JSON.stringify(report, null, 2))
