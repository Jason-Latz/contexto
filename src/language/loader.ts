import type {
  EntryConfidence,
  ExpressionTranslationEntry,
  LanguagePack,
  TargetLanguage,
  TranslationEntry,
} from '../types/index.js'
import { assertExtensionContextAvailable } from '../utils/extensionContext.js'
import { whenIdle } from '../utils/idle.js'
import {
  isCompactPack,
  expandCompactEntries,
  expandCompactEntry,
  POS_CODES,
  type CompactEntry,
  type CompactLanguagePack,
} from './packFormat.js'

// A pack as fetched: either the verbose committed form or the compact form that
// ships in dist/ (see packFormat.ts). Only the loader deals with the difference.
type AnyLanguagePack = LanguagePack | CompactLanguagePack

const DEFAULT_TARGET_LANGUAGE: TargetLanguage = 'es'
const MIN_CONFIDENCE: EntryConfidence[] = ['high', 'medium']

// How many tail entries to expand/merge in one synchronous burst between idle
// yields (the single-file fallback path). The shipping path uses physical build-
// time chunks of the same size, so a chunk's fetch+parse+merge is one bounded
// main-thread slice. Measured (see docs/overnight-2026-07-15): ~2-3ms parse +
// ~1ms merge per 4,000 compact entries, far under the 50ms slice budget even at
// 2x tail size and on slower hardware.
const TAIL_MERGE_SLICE = 4000

// The eager "core" shard (public/language-packs/<lang>.json): the curated,
// frequency-ranked, high/medium-confidence vocabulary. Loaded on every page.
let activePack: AnyLanguagePack | null = null
let entries: Map<string, TranslationEntry> | null = null
let expressionEntries: Array<[string, ExpressionTranslationEntry]> | null = null
// Different-language core loads can overlap in the popup. Only the newest
// request may publish into this module singleton; an older slow response must
// not overwrite the pack selected after it.
let coreLoadGeneration = 0

// The niche "tail" shard (public/language-packs/<lang>.tail.json): the niche,
// low-confidence long-tail vocabulary. It is NOT quarantined behind a toggle any
// more — it loads by default, but PROGRESSIVELY: the core first paint never waits
// on it, and it is fetched + merged in bounded idle-time slices after the first
// render (see ensureTailLoaded + the content script's percolation path).
//
// Heap discipline: the tail is kept as COMPACT tuples (arrays of primitives) and
// each entry is expanded into a full TranslationEntry only on a lookup hit, then
// cached. A page looks up a few hundred tail words, not the tens of thousands it
// carries, so the object-wrapper overhead of the whole tail is never paid. The
// verbose (test-only) shard stores its entries directly — same Map, TailSlot is a
// union — so both formats share one path. Measured to sit well under the old
// eager-tail heap (see the perf harness).
type TailSlot = CompactEntry | TranslationEntry
let tailSlots: Map<string, TailSlot> | null = null
let tailCache: Map<string, TranslationEntry> = new Map()
// Tail expressions are rare, so they are materialized once at merge time (the
// merge already expands each entry to validate it) and surfaced by
// getExpressionEntries — avoiding a full-tail scan on the injection hot path.
let tailExpressions: Array<[string, ExpressionTranslationEntry]> = []
let tailLoadedFor: TargetLanguage | null = null
// In-flight de-dupe: ensureTailLoaded is idempotent and coalesces concurrent
// callers for the SAME language onto one load; a call for a different language
// starts fresh (a stale load aborts itself via the generation check).
let tailLoadPromise: Promise<void> | null = null
let tailLoadingLang: TargetLanguage | null = null
// Bumped whenever the core language changes (which invalidates the tail). An
// in-flight progressive load captures the generation and abandons itself the
// moment it moves, so a fast language switch can never merge stale-language tail
// entries into the new language.
let tailGeneration = 0

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

// Normalize either pack format into the verbose runtime entry record.
function entriesOf(pack: AnyLanguagePack): Record<string, TranslationEntry> {
  return isCompactPack(pack) ? expandCompactEntries(pack) : pack.entries
}

function buildEntryMap(pack: AnyLanguagePack, allowLowConfidence: boolean): Map<string, TranslationEntry> {
  return new Map(
    Object.entries(entriesOf(pack))
      .filter(([, entry]) => isUsableEntry(entry, allowLowConfidence))
      .map(([key, entry]) => [key.toLowerCase(), entry]),
  )
}

// Expand a stored tail slot to a full runtime entry. Compact tuples are expanded
// (the deferred-materialization win); already-verbose slots (test shard) pass
// through. `source` is reconstructed from the lowercased key, which the tail Map
// is always keyed by.
function slotToEntry(key: string, slot: TailSlot): TranslationEntry {
  return Array.isArray(slot) ? expandCompactEntry(key, slot) : slot
}

// Usability check on a COMPACT tuple, without expanding it. Mirrors isUsableEntry
// (allowLowConfidence) but reads tuple positions directly so a merge slice
// allocates NOTHING — the whole tail is validated with zero garbage, which keeps
// each idle slice cheap and free of GC spikes even under page memory pressure.
// Tuple layout (packFormat.ts): [target,pos,gloss,rank,conf,gender,plural,...].
function isUsableCompactTuple(t: CompactEntry): boolean {
  if (!isStandaloneTarget(t[0])) return false
  if (POS_CODES[t[1]] === 'noun') {
    const plural = t[6]
    return Boolean(t[0] && plural && t[5] && typeof plural === 'string' && isStandaloneTarget(plural))
  }
  return Boolean(t[0])
}

// Merge one raw tail entry. Only the compact SLOT is retained (deferred
// materialization); compact tuples are validated allocation-free, and the verbose
// test-shard path falls back to isUsableEntry. Expressions are rare, so they are
// materialized here so getExpressionEntries needs no full-tail scan.
function mergeTailEntry(
  rawKey: string,
  slot: TailSlot,
  into: Map<string, TailSlot>,
  expressions: Array<[string, ExpressionTranslationEntry]>,
): void {
  const key = rawKey.toLowerCase()
  if (Array.isArray(slot)) {
    if (!isUsableCompactTuple(slot)) return
    into.set(key, slot)
    if (POS_CODES[slot[1]] === 'expression') {
      expressions.push([key, expandCompactEntry(key, slot) as ExpressionTranslationEntry])
    }
  } else {
    if (!isUsableEntry(slot, true)) return
    into.set(key, slot)
    if (slot.partOfSpeech === 'expression') {
      expressions.push([key, slot as ExpressionTranslationEntry])
    }
  }
}

// A chunk manifest is the compact tail's dist-only index: no entries, just how
// many physical chunk files (<lang>.tail.<i>.json) to fetch. The committed public
// tail files are ordinary single packs (verbose), so the loader supports both.
interface TailChunkManifest {
  format: 'c1-chunked'
  sourceLanguage: 'en'
  targetLanguage: TargetLanguage
  chunkCount: number
}

function isChunkManifest(pack: unknown): pack is TailChunkManifest {
  return (
    typeof pack === 'object' &&
    pack !== null &&
    (pack as TailChunkManifest).format === 'c1-chunked' &&
    typeof (pack as TailChunkManifest).chunkCount === 'number'
  )
}

function tailPackUrl(targetLanguage: TargetLanguage, chunkIndex?: number): string {
  const name = chunkIndex === undefined
    ? `${targetLanguage}.tail.json`
    : `${targetLanguage}.tail.${chunkIndex}.json`
  return chrome.runtime.getURL(`language-packs/${name}`)
}

// Publish a fully-merged tail into the module state, but only if no newer load
// (or language switch) has superseded this one. isTailLoaded() therefore means
// "fully merged for the active language", never "partway through".
function commitTail(
  targetLanguage: TargetLanguage,
  slots: Map<string, TailSlot>,
  expressions: Array<[string, ExpressionTranslationEntry]>,
  generation: number,
): void {
  if (generation !== tailGeneration) return
  tailSlots = slots
  tailExpressions = expressions
  tailCache = new Map()
  tailLoadedFor = targetLanguage
  expressionEntries = null // the combined core+tail expression cache is now stale
}

// Progressively fetch and merge the tail for `targetLanguage`. The shipping path
// reads a chunk manifest and fetches N physical chunks, merging each in its own
// idle slice (bounded fetch + parse + merge). The fallback path (a single verbose
// or compact pack, as the committed files and unit tests use) parses once, then
// merges the entries in bounded idle slices. A missing tail file is not an error.
async function loadTailProgressive(targetLanguage: TargetLanguage): Promise<void> {
  const generation = tailGeneration
  const slots = new Map<string, TailSlot>()
  const expressions: Array<[string, ExpressionTranslationEntry]> = []

  // A language may simply have no tail (a missing extension resource REJECTS the
  // fetch rather than returning a 404). Either way, commit an empty tail so
  // lookups resolve deterministically and percolation is not re-attempted.
  let response: Response
  try {
    response = await fetch(tailPackUrl(targetLanguage))
  } catch {
    // Deliberately swallowed: the realistic causes are a missing tail resource
    // (see above) and a mid-flight extension-context invalidation, and in both
    // cases "no tail, don't retry" is the intended policy — the tail is an
    // enhancement, never worth failing or re-spinning the pipeline over. A
    // genuinely corrupt tail (bad JSON/metadata) still throws past this catch
    // and is reported by schedulePercolation's warn.
    commitTail(targetLanguage, slots, expressions, generation)
    return
  }
  if (generation !== tailGeneration) return
  if (!response.ok) {
    commitTail(targetLanguage, slots, expressions, generation)
    return
  }

  const pack = (await response.json()) as TailChunkManifest | AnyLanguagePack
  if (generation !== tailGeneration) return
  if (pack.sourceLanguage !== 'en' || pack.targetLanguage !== targetLanguage) {
    throw new Error(`[Contexto] Invalid tail pack metadata for ${targetLanguage}`)
  }

  if (isChunkManifest(pack)) {
    for (let i = 0; i < pack.chunkCount; i++) {
      await whenIdle()
      if (generation !== tailGeneration) return
      const chunkResponse = await fetch(tailPackUrl(targetLanguage, i))
      if (!chunkResponse.ok) {
        throw new Error(`[Contexto] Missing tail chunk ${i} for ${targetLanguage}`)
      }
      const chunk = (await chunkResponse.json()) as CompactLanguagePack
      if (generation !== tailGeneration) return
      for (const key in chunk.entries) {
        mergeTailEntry(key, chunk.entries[key], slots, expressions)
      }
    }
  } else {
    const rawEntries = Object.entries((pack as AnyLanguagePack).entries)
    for (let i = 0; i < rawEntries.length; i += TAIL_MERGE_SLICE) {
      await whenIdle()
      if (generation !== tailGeneration) return
      for (const [key, slot] of rawEntries.slice(i, i + TAIL_MERGE_SLICE)) {
        mergeTailEntry(key, slot as TailSlot, slots, expressions)
      }
    }
  }

  commitTail(targetLanguage, slots, expressions, generation)
}

// Ensure the niche tail for `targetLanguage` is loaded, progressively and off the
// critical path. Idempotent: a no-op once the tail is merged, and concurrent
// callers for the same language share one in-flight load. Resolves when the tail
// is fully merged (or determined absent), which is the signal the content script
// uses to re-render so tail words percolate into the page.
export async function ensureTailLoaded(targetLanguage: TargetLanguage = DEFAULT_TARGET_LANGUAGE): Promise<void> {
  if (tailLoadedFor === targetLanguage && tailSlots !== null) return
  if (tailLoadPromise !== null && tailLoadingLang === targetLanguage) return tailLoadPromise

  tailLoadingLang = targetLanguage
  const promise = loadTailProgressive(targetLanguage)
  tailLoadPromise = promise
  try {
    await promise
  } finally {
    // Only clear if this call still owns the current load (a newer language may
    // have replaced it while we awaited).
    if (tailLoadPromise === promise) {
      tailLoadPromise = null
      tailLoadingLang = null
    }
  }
}

// Drop any tail state. Bumping the generation abandons an in-flight progressive
// load (its next slice check bails and its commit is ignored).
function resetTail(): void {
  tailGeneration++
  tailSlots = null
  tailCache = new Map()
  tailExpressions = []
  tailLoadedFor = null
}

// Load the active language's CORE shard. Cheap and eager: this is what the first
// paint waits on. The niche tail is loaded separately and progressively via
// ensureTailLoaded, so it never blocks this. Switching to a new language resets
// the tail (a new core invalidates it); staying on the same language is a no-op
// that preserves an already-loaded tail.
export async function loadLanguagePack(
  targetLanguage: TargetLanguage = DEFAULT_TARGET_LANGUAGE,
): Promise<void> {
  // Increment even when this target is already active: choosing the current
  // language again must still supersede an older different-language fetch.
  const generation = ++coreLoadGeneration
  const coreReady = activePack?.targetLanguage === targetLanguage && entries !== null
  if (coreReady) return

  assertExtensionContextAvailable()

  const response = await fetch(chrome.runtime.getURL(`language-packs/${targetLanguage}.json`))
  if (!response.ok) {
    throw new Error(`[Contexto] Failed to load ${targetLanguage} language pack`)
  }

  const pack = (await response.json()) as AnyLanguagePack
  if (generation !== coreLoadGeneration) return
  if (pack.sourceLanguage !== 'en' || pack.targetLanguage !== targetLanguage) {
    throw new Error(`[Contexto] Invalid language pack metadata for ${targetLanguage}`)
  }

  activePack = pack
  entries = buildEntryMap(pack, false)
  expressionEntries = null
  // A fresh core invalidates any previously-loaded tail (wrong language).
  resetTail()
}

// True when a non-empty niche tail is fully merged for the active language. An
// absent tail (404) commits an empty map so it is not re-fetched, but reads as
// "not loaded" so the content script's percolation reconcile is a no-op — a
// language with no tail never pays for a pointless re-render.
export function isTailLoaded(): boolean {
  return tailSlots !== null && tailSlots.size > 0
}

export function getActiveLanguagePack(): AnyLanguagePack | null {
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
  // Core is authoritative; the tail is a fallback so a niche word missing from
  // core can still be found/injected once the tail has percolated in.
  const core = entries?.get(key)
  if (core) return core
  if (tailSlots === null) return null

  const cached = tailCache.get(key)
  if (cached) return cached
  const slot = tailSlots.get(key)
  if (slot === undefined) return null

  // Materialize on demand and cache: only the tail words a page actually looks up
  // ever become full objects.
  const entry = slotToEntry(key, slot)
  tailCache.set(key, entry)
  return entry
}

export function getExpressionKeys(): string[] {
  return getExpressionEntries().map(([key]) => key)
}

export function getExpressionEntries(): Array<[string, ExpressionTranslationEntry]> {
  if (!entries) return []
  if (expressionEntries) return expressionEntries

  // Core expressions always; tail expressions too once the tail is merged (they
  // were materialized at merge time) so niche multi-word entries are scannable
  // rather than dead weight. The cache is invalidated whenever the tail changes.
  expressionEntries = []
  for (const [key, entry] of entries) {
    if (entry.partOfSpeech === 'expression') {
      expressionEntries.push([key, entry as ExpressionTranslationEntry])
    }
  }
  if (tailSlots !== null) {
    for (const pair of tailExpressions) expressionEntries.push(pair)
  }
  return expressionEntries
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
