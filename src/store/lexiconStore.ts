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
  srsInterval: 0,
  srsEaseFactor: 2.5,
  srsRepetitions: 0,
  recallHistory: [],
  lifecycleState: WordLifecycleState.Unseen,
  selfMarkedKnown: false,
}

// In-memory store, populated once at startup from chrome.storage.local.
// Never written on every injection — only flushed on visibilitychange or the
// 3-minute interval fallback (per CLAUDE.md storage write strategy).
let lexicon: Map<string, LexiconEntry> = new Map()

// True when the in-memory lexicon has unsaved changes.
let dirty = false

// Load persisted lexicon data from chrome.storage.local into memory.
// Safe to call multiple times — subsequent calls are a no-op if already loaded.
export async function loadLexicon(): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  const raw = result[STORAGE_KEY] as Record<string, LexiconEntry> | undefined
  if (raw) {
    lexicon = new Map(Object.entries(raw))
  }
}

// Return the lexicon entry for a word, or a fresh default if it has never been seen.
// Always returns a value — never throws.
export function getEntry(englishLemma: string): LexiconEntry {
  return lexicon.get(englishLemma) ?? { ...DEFAULT_ENTRY }
}

// Record that a word was displayed as a replacement on the current page.
// Advances the lifecycle state from Unseen to Learning on first encounter.
export function recordSeen(englishLemma: string): void {
  const entry = lexicon.get(englishLemma) ?? { ...DEFAULT_ENTRY }
  entry.seenCount++
  entry.lastSeenAt = Date.now()
  if (entry.lifecycleState === WordLifecycleState.Unseen) {
    entry.lifecycleState = WordLifecycleState.Learning
  }
  lexicon.set(englishLemma, entry)
  dirty = true
}

// Mark or unmark a word as self-known. Self-known words are excluded from
// replacement entirely — the word selector checks this flag before scoring.
export function markKnown(englishLemma: string, known: boolean): void {
  const entry = lexicon.get(englishLemma) ?? { ...DEFAULT_ENTRY }
  entry.selfMarkedKnown = known
  lexicon.set(englishLemma, entry)
  dirty = true
}

// Pre-populate lemmas with a baseline seenCount to reflect assumed prior exposure.
// Called once during onboarding based on the user's chosen proficiency level.
// Skips words that already have a lexicon entry (e.g. from a previous session).
export function prepopulate(lemmas: string[]): void {
  for (const lemma of lemmas) {
    if (!lexicon.has(lemma)) {
      lexicon.set(lemma, { ...DEFAULT_ENTRY, seenCount: PREPOPULATE_SEEN_COUNT })
    }
  }
  dirty = true
}

// Overwrite a single lexicon entry. Used by wordLifecycle.ts after applying a
// quiz result — keeps all direct store mutations inside this module.
export function updateEntry(englishLemma: string, entry: LexiconEntry): void {
  lexicon.set(englishLemma, entry)
  dirty = true
}

// Serialise the in-memory lexicon for writing to chrome.storage.local.
// Called by the storage flush in index.ts alongside the session store.
export function getLexiconForStorage(): Record<string, LexiconEntry> {
  return Object.fromEntries(lexicon)
}

export function isDirty(): boolean { return dirty }
export function clearDirty(): void { dirty = false }
