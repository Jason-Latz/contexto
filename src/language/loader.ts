import type {
  EntryConfidence,
  LanguagePack,
  TargetLanguage,
  TranslationEntry,
} from '../types/index.js'

const DEFAULT_TARGET_LANGUAGE: TargetLanguage = 'es'
const MIN_CONFIDENCE: EntryConfidence[] = ['high', 'medium']

let activePack: LanguagePack | null = null
let entries: Map<string, TranslationEntry> | null = null

function isUsableEntry(entry: TranslationEntry): boolean {
  if (!MIN_CONFIDENCE.includes(entry.confidence)) return false

  if (entry.partOfSpeech === 'noun') {
    return Boolean(entry.target && entry.plural && entry.gender)
  }

  return Boolean(entry.target)
}

export async function loadLanguagePack(
  targetLanguage: TargetLanguage = DEFAULT_TARGET_LANGUAGE,
): Promise<void> {
  if (activePack?.targetLanguage === targetLanguage && entries !== null) return

  if (!chrome.runtime?.id || chrome.runtime.id === 'invalid') {
    throw new Error('[Textum] Extension context invalidated; refresh the page to restore it')
  }

  const response = await fetch(chrome.runtime.getURL(`language-packs/${targetLanguage}.json`))
  if (!response.ok) {
    throw new Error(`[Textum] Failed to load ${targetLanguage} language pack`)
  }

  const pack = (await response.json()) as LanguagePack
  if (pack.sourceLanguage !== 'en' || pack.targetLanguage !== targetLanguage) {
    throw new Error(`[Textum] Invalid language pack metadata for ${targetLanguage}`)
  }

  activePack = pack
  entries = new Map(
    Object.entries(pack.entries)
      .filter(([, entry]) => isUsableEntry(entry))
      .map(([key, entry]) => [key.toLowerCase(), entry]),
  )
}

export function getActiveLanguagePack(): LanguagePack | null {
  return activePack
}

export function lookup(englishLemma: string): TranslationEntry | null {
  return entries?.get(englishLemma.toLowerCase()) ?? null
}

export function getExpressionKeys(): string[] {
  if (!entries) return []

  const keys: string[] = []
  for (const [key, entry] of entries) {
    if (entry.partOfSpeech === 'expression') keys.push(key)
  }
  return keys
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
