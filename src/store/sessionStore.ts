import type { WordSeen } from '../types/index.js'

// In-memory only — session state is not read back from storage on page load.
// It IS flushed alongside the lexicon store on visibilitychange / 3-minute
// interval so the Phase 3 quiz system can access recent WordSeen objects.

interface Session {
  pageUrl: string
  startedAt: number
  wordsSeen: WordSeen[]
  revealCount: number   // total replacements shown this session (for proficiency model)
}

let session: Session = makeSession()

function getCurrentPageUrl(): string {
  return typeof window === 'undefined' ? '' : window.location.href
}

function makeSession(): Session {
  return {
    pageUrl: getCurrentPageUrl(),
    startedAt: Date.now(),
    wordsSeen: [],
    revealCount: 0,
  }
}

// Reset to a fresh session. Called at the start of each page load in index.ts.
export function initSession(): void {
  session = makeSession()
}

// Record a single word replacement. Called by the injector after each successful
// span injection so Phase 3 has sentence context for the contextual quiz format.
export function recordWordSeen(entry: WordSeen): void {
  session.wordsSeen.push(entry)
  session.revealCount++
}

export function getRevealCount(): number {
  return session.revealCount
}

export function getWordsSeen(): readonly WordSeen[] {
  return session.wordsSeen
}

// Serialise session for writing to chrome.storage.local alongside the lexicon.
export function getSessionForStorage(): Session {
  return { ...session, wordsSeen: [...session.wordsSeen] }
}
