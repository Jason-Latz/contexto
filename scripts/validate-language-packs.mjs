import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKS = ['es', 'de', 'fr', 'it']
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const VALID_POS = new Set(['noun', 'adverb', 'adjective', 'verb', 'expression', 'function'])
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low'])
// Allowed noun genders per target language. German adds neuter; the romance
// languages are masculine/feminine only. Mirrors src/language/registry.ts.
const GENDERS_BY_LANGUAGE = {
  es: new Set(['masculine', 'feminine']),
  fr: new Set(['masculine', 'feminine']),
  it: new Set(['masculine', 'feminine']),
  de: new Set(['masculine', 'feminine', 'neuter']),
}
const VALID_FUNCTION_SUBTYPE = new Set(['preposition', 'conjunction', 'determiner', 'pronoun'])
const SIZE_WARNING_GZIP_BYTES = 10 * 1024 * 1024

function fail(message) {
  throw new Error(message)
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${label} must be a non-empty string`)
  }
}

function requireStandaloneTarget(value, label) {
  requireString(value, label)

  const trimmed = value.trim()
  if (trimmed.startsWith('-') || trimmed.endsWith('-')) {
    fail(`${label} must be a standalone replacement, not a prefix/suffix marker`)
  }
}

function assertNoDuplicateEntryKeys(raw, language) {
  const entryKeyPattern = /^\s*"([^"]+)"\s*:\s*\{/gm
  const seen = new Map()
  const duplicates = []
  let match
  let line = 1
  let lastIndex = 0

  while ((match = entryKeyPattern.exec(raw)) !== null) {
    const key = match[1]
    line += raw.slice(lastIndex, match.index).split('\n').length - 1
    lastIndex = match.index

    if (key === 'entries') continue

    if (seen.has(key)) {
      duplicates.push(`${key} (lines ${seen.get(key)} and ${line})`)
    } else {
      seen.set(key, line)
    }
  }

  if (duplicates.length > 0) {
    fail(`${language}: duplicate entries found: ${duplicates.join(', ')}`)
  }
}

function validateEntry(key, entry, targetLanguage) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    fail(`${key} must be an object`)
  }

  requireString(entry.source, `${key}.source`)
  requireStandaloneTarget(entry.target, `${key}.target`)
  requireString(entry.sourceGloss, `${key}.sourceGloss`)

  if (key !== entry.source.toLowerCase()) {
    fail(`${key} must match source lowercased (${entry.source})`)
  }

  if (!VALID_POS.has(entry.partOfSpeech)) {
    fail(`${key}.partOfSpeech is invalid`)
  }

  if (!VALID_CONFIDENCE.has(entry.confidence)) {
    fail(`${key}.confidence is invalid`)
  }

  if (!Number.isInteger(entry.frequencyRank) || entry.frequencyRank <= 0) {
    fail(`${key}.frequencyRank must be a positive integer`)
  }

  if (!Array.isArray(entry.sourceIds) || entry.sourceIds.length === 0) {
    fail(`${key}.sourceIds must be a non-empty array`)
  }
  for (const [index, sourceId] of entry.sourceIds.entries()) {
    requireString(sourceId, `${key}.sourceIds[${index}]`)
  }

  if (entry.partOfSpeech === 'noun') {
    const allowed = GENDERS_BY_LANGUAGE[targetLanguage] ?? GENDERS_BY_LANGUAGE.es
    if (!allowed.has(entry.gender)) {
      fail(`${key}.gender must be one of ${[...allowed].join('/')}`)
    }
    requireStandaloneTarget(entry.plural, `${key}.plural`)
  }

  if (entry.partOfSpeech !== 'noun') {
    if ('gender' in entry) fail(`${key} non-noun must not include gender`)
    if ('plural' in entry) fail(`${key} non-noun must not include plural`)
  }

  if (entry.partOfSpeech === 'function') {
    if (!VALID_FUNCTION_SUBTYPE.has(entry.functionSubtype)) {
      fail(`${key}.functionSubtype is invalid`)
    }
  } else if ('functionSubtype' in entry) {
    fail(`${key} non-function must not include functionSubtype`)
  }
}

function assertUniqueFrequencyRanks(entries, language) {
  const seen = new Map()
  const duplicates = []

  for (const [key, entry] of Object.entries(entries)) {
    if (seen.has(entry.frequencyRank)) {
      duplicates.push(`${entry.frequencyRank}: ${seen.get(entry.frequencyRank)} and ${key}`)
    } else {
      seen.set(entry.frequencyRank, key)
    }
  }

  if (duplicates.length > 0) {
    fail(`${language}: duplicate frequencyRank values found: ${duplicates.join(', ')}`)
  }
}

async function validatePackFile(language, file, label) {
  const raw = await readFile(file, 'utf8')
  assertNoDuplicateEntryKeys(raw, label)

  const pack = JSON.parse(raw)

  if (pack.sourceLanguage !== 'en') fail(`${label}: sourceLanguage must be en`)
  if (pack.targetLanguage !== language) fail(`${label}: targetLanguage mismatch`)
  requireString(pack.version, `${label}.version`)
  requireString(pack.displayName, `${label}.displayName`)

  if (!pack.sources || typeof pack.sources !== 'object' || Array.isArray(pack.sources)) {
    fail(`${label}: sources must be an object`)
  }
  for (const [sourceId, source] of Object.entries(pack.sources)) {
    requireString(source.name, `${label}.sources.${sourceId}.name`)
    requireString(source.url, `${label}.sources.${sourceId}.url`)
    requireString(source.license, `${label}.sources.${sourceId}.license`)
  }

  if (!pack.entries || typeof pack.entries !== 'object' || Array.isArray(pack.entries)) {
    fail(`${label}: entries must be an object`)
  }

  for (const [key, entry] of Object.entries(pack.entries)) {
    validateEntry(key, entry, language)
  }

  assertUniqueFrequencyRanks(pack.entries, label)

  const rawBytes = Buffer.byteLength(raw)
  const gzipBytes = (await import('node:zlib')).gzipSync(raw).byteLength
  if (gzipBytes > SIZE_WARNING_GZIP_BYTES) {
    console.warn(`WARN ${label}: gzip size ${gzipBytes} bytes exceeds ${SIZE_WARNING_GZIP_BYTES}`)
  }

  console.log(`OK ${label}: ${Object.keys(pack.entries).length} entries (${rawBytes} bytes raw, ${gzipBytes} bytes gzip)`)
  return pack
}

async function fileExists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

async function validateLanguage(language) {
  const coreFile = join(ROOT, 'public', 'language-packs', `${language}.json`)
  const core = await validatePackFile(language, coreFile, language)

  // The niche tail shard is optional (a language may not have one yet). When
  // present it is validated the same way, and its keys must be disjoint from
  // core so lookup() never has an ambiguous entry across the two shards.
  const tailFile = join(ROOT, 'public', 'language-packs', `${language}.tail.json`)
  if (await fileExists(tailFile)) {
    const tail = await validatePackFile(language, tailFile, `${language}.tail`)
    const coreKeys = new Set(Object.keys(core.entries))
    const overlap = Object.keys(tail.entries).filter((key) => coreKeys.has(key))
    if (overlap.length > 0) {
      fail(`${language}.tail: ${overlap.length} keys overlap core (e.g. ${overlap.slice(0, 5).join(', ')})`)
    }
    console.log(`OK ${language}: core+tail = ${Object.keys(core.entries).length + Object.keys(tail.entries).length} entries`)
  }
}

for (const language of PACKS) {
  await validateLanguage(language)
}
