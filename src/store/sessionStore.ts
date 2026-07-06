import type { WordSeen } from '../types/index.js'

// In-memory only — session state is not read back from storage on page load.
// It IS flushed alongside the lexicon store on visibilitychange / 3-minute
// interval so the popup can show session stats and filter by this session.

interface Session {
  pageUrl: string
  startedAt: number
  wordsSeen: WordSeen[]
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
  }
}

// Reset to a fresh session. Called at the start of each page load in index.ts.
export function initSession(): void {
  session = makeSession()
}

// Record a single word replacement. Called by the injector after each successful
// span injection so the popup's session stats and session filter stay accurate.
export function recordWordSeen(entry: WordSeen): void {
  session.wordsSeen.push(entry)
}

// Serialise session for writing to chrome.storage.local alongside the lexicon.
export function getSessionForStorage(): Session {
  return { ...session, wordsSeen: [...session.wordsSeen] }
}
