import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKS = ['es']
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const VALID_POS = new Set(['noun', 'adverb', 'expression'])
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low'])
const VALID_SPANISH_GENDER = new Set(['masculine', 'feminine'])

function fail(message) {
  throw new Error(message)
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${label} must be a non-empty string`)
  }
}

function assertNoDuplicateEntryKeys(raw, language) {
  const entryKeyPattern = /^\s*"([^"]+)"\s*:\s*\{/gm
  const seen = new Map()
  const duplicates = []
  let match

  while ((match = entryKeyPattern.exec(raw)) !== null) {
    const key = match[1]
    if (key === 'entries') continue

    const line = raw.slice(0, match.index).split('\n').length
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
  requireString(entry.target, `${key}.target`)
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

  if (targetLanguage === 'es' && entry.partOfSpeech === 'noun') {
    if (!VALID_SPANISH_GENDER.has(entry.gender)) {
      fail(`${key}.gender must be masculine or feminine`)
    }
    requireString(entry.plural, `${key}.plural`)
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

async function validatePack(language) {
  const file = join(ROOT, 'public', 'language-packs', `${language}.json`)
  const raw = await readFile(file, 'utf8')
  assertNoDuplicateEntryKeys(raw, language)

  const pack = JSON.parse(raw)

  if (pack.sourceLanguage !== 'en') fail(`${language}: sourceLanguage must be en`)
  if (pack.targetLanguage !== language) fail(`${language}: targetLanguage mismatch`)
  requireString(pack.version, `${language}.version`)
  requireString(pack.displayName, `${language}.displayName`)

  if (!pack.entries || typeof pack.entries !== 'object' || Array.isArray(pack.entries)) {
    fail(`${language}: entries must be an object`)
  }

  for (const [key, entry] of Object.entries(pack.entries)) {
    validateEntry(key, entry, language)
  }

  assertUniqueFrequencyRanks(pack.entries, language)

  console.log(`OK ${language}: ${Object.keys(pack.entries).length} entries`)
}

for (const language of PACKS) {
  await validatePack(language)
}
