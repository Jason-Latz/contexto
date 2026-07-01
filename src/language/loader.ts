import type {
  EntryConfidence,
  ExpressionTranslationEntry,
  LanguagePack,
  TargetLanguage,
  TranslationEntry,
} from '../types/index.js'
import { assertExtensionContextAvailable } from '../utils/extensionContext.js'

const DEFAULT_TARGET_LANGUAGE: TargetLanguage = 'es'
const MIN_CONFIDENCE: EntryConfidence[] = ['high', 'medium']

// The eager "core" shard (public/language-packs/<lang>.json): the curated,
// frequency-ranked, high/medium-confidence vocabulary. Loaded on every page.
let activePack: LanguagePack | null = null
let entries: Map<string, TranslationEntry> | null = null
let expressionEntries: Array<[string, ExpressionTranslationEntry]> | null = null

// The lazy "tail" shard (public/language-packs/<lang>.tail.json): the niche,
// low-confidence long-tail vocabulary. QUARANTINED — it is only fetched/parsed
// when aggressive mode is on, so a default page load never touches it (keeping
// per-tab memory + parse cost at the core baseline) and, because lookup() only
// consults it when loaded, tail words are never injected unless the user opts in.
let tailEntries: Map<string, TranslationEntry> | null = null
let tailLoadedFor: TargetLanguage | null = null

function isStandaloneTarget(target: string): boolean {
  const trimmed = target.trim()
  return !trimmed.startsWith('-') && !trimmed.endsWith('-')
}

// `allowLowConfidence` is set for the tail shard, whose entries are all `low`
// confidence by construction (that IS the tier). Structural requirements — a
// standalone target, and gender+plural for nouns so the grammar adapters can
// inflect — still apply so anything the injector renders is well-formed.
function isUsableEntry(entry: TranslationEntry, allowLowConfidence = false): boolean {
  if (!allowLowConfidence && !MIN_CONFIDENCE.includes(entry.confidence)) return false
  if (!isStandaloneTarget(entry.target)) return false

  if (entry.partOfSpeech === 'noun') {
    return Boolean(entry.target && entry.plural && entry.gender && isStandaloneTarget(entry.plural))
  }

  return Boolean(entry.target)
}

function buildEntryMap(pack: LanguagePack, allowLowConfidence: boolean): Map<string, TranslationEntry> {
  return new Map(
    Object.entries(pack.entries)
      .filter(([, entry]) => isUsableEntry(entry, allowLowConfidence))
      .map(([key, entry]) => [key.toLowerCase(), entry]),
  )
}

// Fetch + parse the quarantined tail shard for `targetLanguage`. A missing tail
// file is not an error — a language may simply have no tail yet — so it yields an
// empty tail rather than throwing.
async function loadTailShard(targetLanguage: TargetLanguage): Promise<void> {
  if (tailLoadedFor === targetLanguage && tailEntries !== null) return

  const response = await fetch(chrome.runtime.getURL(`language-packs/${targetLanguage}.tail.json`))
  if (!response.ok) {
    tailEntries = new Map()
    tailLoadedFor = targetLanguage
    return
  }

  const pack = (await response.json()) as LanguagePack
  if (pack.sourceLanguage !== 'en' || pack.targetLanguage !== targetLanguage) {
    throw new Error(`[Contexto] Invalid tail pack metadata for ${targetLanguage}`)
  }

  tailEntries = buildEntryMap(pack, true)
  tailLoadedFor = targetLanguage
}

// Load the active language. `includeTail` (aggressive mode) additionally fetches
// the quarantined tail shard; when false the tail is dropped so its niche words
// stop being eligible for injection immediately.
export async function loadLanguagePack(
  targetLanguage: TargetLanguage = DEFAULT_TARGET_LANGUAGE,
  includeTail = false,
): Promise<void> {
  const coreReady = activePack?.targetLanguage === targetLanguage && entries !== null

  if (!coreReady) {
    assertExtensionContextAvailable()

    const response = await fetch(chrome.runtime.getURL(`language-packs/${targetLanguage}.json`))
    if (!response.ok) {
      throw new Error(`[Contexto] Failed to load ${targetLanguage} language pack`)
    }

    const pack = (await response.json()) as LanguagePack
    if (pack.sourceLanguage !== 'en' || pack.targetLanguage !== targetLanguage) {
      throw new Error(`[Contexto] Invalid language pack metadata for ${targetLanguage}`)
    }

    activePack = pack
    entries = buildEntryMap(pack, false)
    expressionEntries = null
    // A fresh core invalidates any previously-loaded tail (wrong language).
    tailEntries = null
    tailLoadedFor = null
  }

  if (includeTail) {
    await loadTailShard(targetLanguage)
  } else {
    tailEntries = null
    tailLoadedFor = null
  }
}

// True when the quarantined tail shard is currently loaded (aggressive mode).
export function isTailLoaded(): boolean {
  return tailEntries !== null
}

export function getActiveLanguagePack(): LanguagePack | null {
  return activePack
}

// The target language of the currently loaded pack. Drives per-language grammar
// dispatch at the replacement site so it always matches the pack actually loaded
// (rather than the settings value, which can change before the new pack loads).
export function getActiveTargetLanguage(): TargetLanguage {
  return activePack?.targetLanguage ?? DEFAULT_TARGET_LANGUAGE
}

export function lookup(englishLemma: string): TranslationEntry | null {
  const key = englishLemma.toLowerCase()
  // Core is authoritative; the tail (only present in aggressive mode) is a
  // fallback so a niche word missing from core can still be found/injected.
  return entries?.get(key) ?? tailEntries?.get(key) ?? null
}

export function getExpressionKeys(): string[] {
  return getExpressionEntries().map(([key]) => key)
}

export function getExpressionEntries(): Array<[string, ExpressionTranslationEntry]> {
  if (!entries) return []
  if (expressionEntries) return expressionEntries

  expressionEntries = []
  for (const [key, entry] of entries) {
    if (entry.partOfSpeech === 'expression') {
      expressionEntries.push([key, entry])
    }
  }
  return expressionEntries
}

export function sampleLemmas(n: number, exclude: ReadonlySet<string>): string[] {
  if (!entries) return []

  const candidates: string[] = []
  for (const [lemma, entry] of entries) {
    if (entry.partOfSpeech === 'expression') continue
    if (exclude.has(lemma)) continue
    candidates.push(lemma)
  }

  const result: string[] = []
  for (let i = 0; i < n && i < candidates.length; i++) {
    const j = i + Math.floor(Math.random() * (candidates.length - i))
    ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
    result.push(candidates[i])
  }
  return result
}

export function getTopNLemmas(n: number): string[] {
  if (!entries) return []

  const ranked: Array<{ lemma: string; rank: number }> = []
  for (const [lemma, entry] of entries) {
    if (entry.partOfSpeech === 'expression') continue
    ranked.push({ lemma, rank: entry.frequencyRank })
  }

  ranked.sort((a, b) => a.rank - b.rank)
  return ranked.slice(0, n).map(entry => entry.lemma)
}
