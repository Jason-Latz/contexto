import type { LexiconEntry, TargetLanguage } from '../types/index.js'
import { WordLifecycleState } from '../types/index.js'

// Learning state is target-language specific. The original single
// `contexto_lexicon` map made a Spanish save/review/known decision leak into
// German, French, and Italian because every record was keyed only by its English
// lemma. New stores use one key per language; the legacy map is retained as a
// recoverable backup after it is copied into the language active at migration.
const LEGACY_STORAGE_KEY = 'contexto_lexicon'
const MIGRATION_KEY = 'contexto_lexicon_migrated_to_language'

export function lexiconStorageKey(language: TargetLanguage): string {
  return `contexto_lexicon_${language}`
}

export function getLexiconLanguage(): TargetLanguage {
  return activeLanguage
}

// Baseline seenCount applied to pre-populated words during first-run init.
// High enough to depress novelty scores (noveltyScore = 1/(1+seenCount)),
// but not so high that the words are permanently deprioritised.
const PREPOPULATE_SEEN_COUNT = 3

const DEFAULT_ENTRY: Readonly<LexiconEntry> = {
  seenCount: 0,
  lastSeenAt: 0,
  lastReviewedAt: 0,
  srsInterval: 0,
  srsEaseFactor: 2.5,
  srsRepetitions: 0,
  recallHistory: [],
  lifecycleState: WordLifecycleState.Unseen,
  selfMarkedKnown: false,
  selfMarkedUnknown: false,
  selfMarkedUnknownAt: 0,
}

// In-memory store, populated once at startup from chrome.storage.local.
// Never written on every injection — only flushed on visibilitychange or the
// 3-minute interval fallback (per CLAUDE.md storage write strategy).
let lexicon: Map<string, LexiconEntry> = new Map()
let activeLanguage: TargetLanguage = 'es'

// True when the in-memory lexicon has unsaved changes.
let dirty = false

// The exact lemmas changed since the last flush. flushLexiconMerge() writes ONLY
// these onto a fresh read of storage, so a popup write can't clobber a concurrent
// content-script write (and vice-versa) for lemmas neither of them touched.
const dirtyLemmas = new Set<string>()

// A Set alone cannot distinguish "this lemma was already pending" from "this
// same lemma changed again while its write was in flight." Keep a generation so
// a completed write clears only the exact mutation version it accepted.
const dirtyVersions = new Map<string, number>()

// Mark a single lemma as having unsaved changes.
function touch(englishLemma: string): void {
  dirty = true
  dirtyLemmas.add(englishLemma)
  dirtyVersions.set(englishLemma, (dirtyVersions.get(englishLemma) ?? 0) + 1)
}

// Serialises every storage read/replace (loadLexicon) and merge-write
// (flushLexiconMerge) within this JS context, so a load can't interleave with a
// write's read-modify-write and clear dirty flags for values it never persisted.
let writeChain: Promise<void> = Promise.resolve()

function makeDefaultEntry(): LexiconEntry {
  return { ...DEFAULT_ENTRY, recallHistory: [] }
}

// Exported for migration tests. Upgrades a raw stored entry (possibly written by
// an older version missing newer fields) to a complete LexiconEntry, filling
// defaults for any absent field so the in-memory shape is always consistent.
export function normalizeEntry(raw: Partial<LexiconEntry>): LexiconEntry {
  return {
    ...makeDefaultEntry(),
    ...raw,
    recallHistory: Array.isArray(raw.recallHistory) ? raw.recallHistory : [],
    lastReviewedAt: raw.lastReviewedAt ?? 0,
    selfMarkedKnown: raw.selfMarkedKnown ?? false,
    selfMarkedUnknown: raw.selfMarkedUnknown ?? false,
    selfMarkedUnknownAt: raw.selfMarkedUnknownAt ?? 0,
  }
}

// Read one language's persisted lexicon and REPLACE the in-memory map. Startup
// loads once; a live language switch flushes any pending old-language mutations
// before loading the new map. Serialised through writeChain so it cannot
// interleave with an in-flight merge-write.
export function loadLexicon(language: TargetLanguage = 'es'): Promise<void> {
  const run = writeChain.then(async () => {
    // A live language switch must never strand dirty progress in the previous
    // language's in-memory map. Flush it to that language's key before replacing
    // the map with the newly selected language.
    if (dirty) await doMergeWrite()
    await doLoad(language)
  })
  writeChain = run.catch(() => {})
  return run
}

async function doLoad(language: TargetLanguage): Promise<void> {
  const storageKey = lexiconStorageKey(language)
  const result = await chrome.storage.local.get(storageKey)
  let raw = result[storageKey] as Record<string, Partial<LexiconEntry>> | undefined

  // One-time migration for pre-multilingual storage. The settings-selected
  // language owns the old progress; other languages start clean. The marker and
  // copied store publish together, while the legacy value stays untouched as a
  // rollback/recovery source.
  if (!raw) {
    const migration = await chrome.storage.local.get(MIGRATION_KEY)
    if (!migration[MIGRATION_KEY]) {
      const legacy = await chrome.storage.local.get(LEGACY_STORAGE_KEY)
      const legacyRaw = legacy[LEGACY_STORAGE_KEY] as Record<string, Partial<LexiconEntry>> | undefined
      if (legacyRaw && Object.keys(legacyRaw).length > 0) {
        raw = legacyRaw
        await chrome.storage.local.set({
          [storageKey]: legacyRaw,
          [MIGRATION_KEY]: language,
        })
      }
    }
  }

  activeLanguage = language
  clearDirty()
  if (raw) {
    lexicon = new Map(
      Object.entries(raw).map(([lemma, entry]) => [lemma, normalizeEntry(entry)]),
    )
  } else {
    lexicon = new Map()
  }
}

// Return the lexicon entry for a word, or a fresh default if it has never been seen.
// Always returns a value — never throws.
export function getEntry(englishLemma: string): LexiconEntry {
  return lexicon.get(englishLemma) ?? makeDefaultEntry()
}

// Record that a word was displayed as a replacement on the current page.
// Advances the lifecycle state from Unseen to Learning on first encounter.
export function recordSeen(englishLemma: string): void {
  const entry = lexicon.get(englishLemma) ?? makeDefaultEntry()
  entry.seenCount++
  entry.lastSeenAt = Date.now()
  if (entry.lifecycleState === WordLifecycleState.Unseen) {
    entry.lifecycleState = WordLifecycleState.Learning
  }
  lexicon.set(englishLemma, entry)
  touch(englishLemma)
}

// Mark or unmark a word as self-known. This legacy flag excludes words from
// replacement entirely — the word selector checks it before scoring.
export function markKnown(englishLemma: string, known: boolean): void {
  const entry = lexicon.get(englishLemma) ?? makeDefaultEntry()
  entry.selfMarkedKnown = known
  if (known) {
    entry.selfMarkedUnknown = false
    entry.selfMarkedUnknownAt = 0
  }
  lexicon.set(englishLemma, entry)
  touch(englishLemma)
}

// Mark or unmark a word as user-unknown. Unknown words stay in replacement
// rotation but are saved for popup review and export.
export function markUnknown(englishLemma: string, unknown: boolean): void {
  const entry = lexicon.get(englishLemma) ?? makeDefaultEntry()
  entry.selfMarkedUnknown = unknown
  entry.selfMarkedUnknownAt = unknown
    ? entry.selfMarkedUnknownAt || Date.now()
    : 0
  if (unknown) {
    entry.selfMarkedKnown = false
    if (entry.lifecycleState === WordLifecycleState.Unseen) {
      entry.lifecycleState = WordLifecycleState.Learning
    }
  }
  lexicon.set(englishLemma, entry)
  touch(englishLemma)
}

// Pre-populate lemmas with a baseline seenCount to reflect assumed prior exposure.
// Called by the silent first-run init (ensureFirstRunInit) with the top lemmas
// for the default level. Skips words that already have a lexicon entry (e.g.
// from a previous session or a concurrent tab's first-run init).
export function prepopulate(lemmas: string[]): void {
  for (const lemma of lemmas) {
    if (!lexicon.has(lemma)) {
      lexicon.set(lemma, { ...makeDefaultEntry(), seenCount: PREPOPULATE_SEEN_COUNT })
      touch(lemma)
    }
  }
}

// Overwrite a single lexicon entry. Used by wordLifecycle.ts after applying a
// quiz result — keeps all direct store mutations inside this module.
export function updateEntry(englishLemma: string, entry: LexiconEntry): void {
  lexicon.set(englishLemma, entry)
  touch(englishLemma)
}

// Serialise the in-memory lexicon for writing to chrome.storage.local.
// Called by the storage flush in index.ts alongside the session store.
export function getLexiconForStorage(): Record<string, LexiconEntry> {
  return Object.fromEntries(lexicon)
}

// The entries for lemmas changed since the last flush. Used by flushLexiconMerge
// (and exposed for tests) so writers persist only what they touched.
export function getDirtyEntries(): Record<string, LexiconEntry> {
  const out: Record<string, LexiconEntry> = {}
  for (const lemma of dirtyLemmas) {
    const entry = lexicon.get(lemma)
    if (entry) out[lemma] = entry
  }
  return out
}

// Persist only the dirty lemmas, merged onto a FRESH read of storage. This is the
// clobber-safe write path shared by the popup (mark-known, quiz results) and the
// content script (passive flushes): because each writer overlays only the lemmas it
// changed, a concurrent writer's untouched lemmas survive instead of being reverted
// by a whole-map overwrite. Rejects to the caller on storage failure but keeps the
// chain alive for the next flush. No-op when nothing is dirty.
export function flushLexiconMerge(): Promise<void> {
  const run = writeChain.then(() => doMergeWrite())
  writeChain = run.catch(() => {})
  return run
}

async function doMergeWrite(): Promise<void> {
  if (!dirty) return
  const pending = getDirtyEntries()
  const pendingLemmas = Object.keys(pending)
  if (pendingLemmas.length === 0) {
    clearDirty()
    return
  }
  const pendingVersions = new Map(
    pendingLemmas.map(lemma => [lemma, dirtyVersions.get(lemma)]),
  )
  const storageKey = lexiconStorageKey(activeLanguage)
  const result = await chrome.storage.local.get(storageKey)
  const stored = (result[storageKey] ?? {}) as Record<string, LexiconEntry>
  await chrome.storage.local.set({ [storageKey]: { ...stored, ...pending } })

  // Clear only the lemmas actually written; anything dirtied during the await
  // stays pending for the next flush.
  for (const lemma of pendingLemmas) {
    if (dirtyVersions.get(lemma) !== pendingVersions.get(lemma)) continue
    dirtyLemmas.delete(lemma)
    dirtyVersions.delete(lemma)
  }
  dirty = dirtyLemmas.size > 0
}

export function isDirty(): boolean { return dirty }
export function clearDirty(): void {
  dirty = false
  dirtyLemmas.clear()
  dirtyVersions.clear()
}
