import { loadLanguagePack } from '../language/loader.js'
import { collectTextNodes } from './domWalker.js'
import { injectReplacements, extractPageCandidates } from './injector.js'
import { setupHoverHandler } from './hoverHandler.js'
import { loadLexicon, getLexiconForStorage, isDirty, clearDirty } from '../store/lexiconStore.js'
import { getTargetLanguage, isOnboarded, loadSettings } from '../store/settingsStore.js'
import { initSession, getSessionForStorage } from '../store/sessionStore.js'
import { computeDensity } from '../engine/proficiencyModel.js'
import { selectTokens } from '../engine/wordSelector.js'
import { showLevelPicker } from '../onboarding/LevelPicker.js'
import { startQuizTimer } from '../quiz/QuizBanner.js'
import { setupMutationObserver } from './mutationObserver.js'

// Pages with fewer words than this are too short for meaningful immersion
// (e.g. error pages, blank tabs, single-widget dashboards).
// Matches the 100-word threshold in CLAUDE.md.
const MIN_PAGE_WORD_COUNT = 100

// Storage flush interval fallback — guards against data loss on unexpected tab closure.
// The primary flush is on visibilitychange; this is the safety net.
const FLUSH_INTERVAL_MS = 3 * 60 * 1000  // 3 minutes

function countPageWords(): number {
  return (document.body.innerText ?? '').trim().split(/\s+/).filter(Boolean).length
}

// Write the lexicon and session stores together in one storage call.
// No-op when the lexicon has no unsaved changes.
async function flushStorage(): Promise<void> {
  if (!isDirty()) return
  await chrome.storage.local.set({
    textum_lexicon: getLexiconForStorage(),
    textum_session: getSessionForStorage(),
  })
  clearDirty()
}

async function main(): Promise<void> {
  // The manifest sets run_at: document_idle, so the DOM is ready by the time
  // this script executes. Guard defensively for edge cases (e.g. dynamic injection).
  if (document.readyState === 'loading') {
    await new Promise<void>((resolve) => {
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true })
    })
  }

  const wordCount = countPageWords()

  // Silently exit on pages with too little content — no readable immersion possible
  if (wordCount < MIN_PAGE_WORD_COUNT) return

  // Load persisted state before making any decisions that depend on it.
  // loadSettings must come first — isOnboarded() reads from it.
  try {
    await loadSettings()
    await loadLanguagePack(getTargetLanguage())
    await loadLexicon()
  } catch (err) {
    console.warn('[Textum] Startup failed, extension inactive:', err)
    return
  }

  // Reset the in-memory session for this page load.
  initSession()

  // If the user has not completed onboarding, show the level picker overlay
  // and wait for it to finish before proceeding. The picker saves the level,
  // pre-populates the lexicon, and runs the calibration quiz.
  if (!isOnboarded()) {
    await showLevelPicker()
  }

  // Set up hover handler BEFORE injecting spans so that even the first span
  // is already covered by the delegated listener when it appears in the DOM.
  setupHoverHandler()

  // Walk and process all text nodes. collectTextNodes() may return [] if the
  // user chose Keep Paused on the high-stakes domain banner.
  const textNodes = await collectTextNodes(document.body)

  // --- Pass A: page-level word selection ---
  // Collect one representative candidate per unique eligible lemma across all
  // nodes, then run the word selector once for the whole page. This ensures
  // that once a lemma is chosen it is replaced in every text node, not just
  // the first node where it happened to beat the per-node density cap.
  const pageCandidates = extractPageCandidates(textNodes)
  const density = computeDensity(pageCandidates.length)
  const maxReplacements = Math.floor(density * pageCandidates.length)
  const selectedTokens = selectTokens(pageCandidates, maxReplacements)
  const approvedLemmas = new Set(selectedTokens.map(t => t.lemma))

  // --- Pass B: replacement ---
  // Replace every occurrence of every approved lemma across all text nodes.
  for (const node of textNodes) {
    injectReplacements(node, approvedLemmas)
  }

  // Attach the SPA-safe MutationObserver now that approvedLemmas is settled.
  // It will apply the same replacement set to any DOM nodes added after the
  // initial pass (route transitions, infinite scroll, dynamic widgets).
  setupMutationObserver(approvedLemmas)

  // Start the active-reading timer. Pass the page candidate count so the quiz
  // banner can forward it to adjustDensityAfterQuiz after the session completes.
  startQuizTimer(pageCandidates.length)

  // --- Storage write strategy ---
  // Primary: flush on visibilitychange (tab hidden / user navigates away).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void flushStorage()
    }
  })

  // Fallback: flush every 3 minutes so data isn't lost on crash or hard close.
  setInterval(() => { void flushStorage() }, FLUSH_INTERVAL_MS)
}

main()
