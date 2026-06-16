import type { LexiconEntry } from '../types/index.js'
import { WordLifecycleState } from '../types/index.js'

const STORAGE_KEY = 'contexto_lexicon'

// Baseline seenCount applied to pre-populated words during onboarding.
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

// True when the in-memory lexicon has unsaved changes.
let dirty = false

// The exact lemmas changed since the last flush. flushLexiconMerge() writes ONLY
// these onto a fresh read of storage, so a popup write can't clobber a concurrent
// content-script write (and vice-versa) for lemmas neither of them touched.
const dirtyLemmas = new Set<string>()

// Mark a single lemma as having unsaved changes.
function touch(englishLemma: string): void {
  dirty = true
  dirtyLemmas.add(englishLemma)
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

// Read persisted lexicon data from chrome.storage.local and REPLACE the in-memory
// map. Not idempotent — every call re-reads and overwrites, discarding any unflushed
// changes — so it must run once at startup before any mutation. Serialised through
// writeChain so it cannot interleave with an in-flight merge-write.
export function loadLexicon(): Promise<void> {
  const run = writeChain.then(() => doLoad())
  writeChain = run.catch(() => {})
  return run
}

async function doLoad(): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  const raw = result[STORAGE_KEY] as Record<string, Partial<LexiconEntry>> | undefined
  if (raw) {
    lexicon = new Map(
      Object.entries(raw).map(([lemma, entry]) => [lemma, normalizeEntry(entry)]),
    )
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
// Called once during onboarding based on the user's chosen proficiency level.
// Skips words that already have a lexicon entry (e.g. from a previous session).
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

  const result = await chrome.storage.local.get(STORAGE_KEY)
  const stored = (result[STORAGE_KEY] ?? {}) as Record<string, LexiconEntry>
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...stored, ...pending } })

  // Clear only the lemmas actually written; anything dirtied during the await
  // stays pending for the next flush.
  for (const lemma of pendingLemmas) dirtyLemmas.delete(lemma)
  dirty = dirtyLemmas.size > 0
}

export function isDirty(): boolean { return dirty }
export function clearDirty(): void {
  dirty = false
  dirtyLemmas.clear()
}
