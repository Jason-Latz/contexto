import { loadLanguagePack } from '../language/loader.js'
import { collectTextNodes } from './domWalker.js'
import { extractPageCandidates, injectReplacements, restoreReplacements } from './injector.js'
import { removeHoverUI, setupHoverHandler } from './hoverHandler.js'
import { loadLexicon, getLexiconForStorage, isDirty, clearDirty } from '../store/lexiconStore.js'
import {
  areQuizzesEnabled,
  areReplacementsEnabled,
  getTargetLanguage,
  isOnboarded,
  loadSettings,
} from '../store/settingsStore.js'
import { initSession, getSessionForStorage } from '../store/sessionStore.js'
import { computeDensity } from '../engine/proficiencyModel.js'
import { selectTokens } from '../engine/wordSelector.js'
import { showLevelPicker } from '../onboarding/LevelPicker.js'
import { startQuizTimer, stopQuizTimer } from '../quiz/QuizBanner.js'
import { setupMutationObserver } from './mutationObserver.js'
import {
  isExtensionContextAvailable,
  isExtensionContextInvalidatedError,
} from '../utils/extensionContext.js'
import type { CandidateToken } from '../types/index.js'

// Pages with fewer words than this are too short for meaningful immersion
// (e.g. error pages, blank tabs, single-widget dashboards).
// Matches the 100-word threshold in CLAUDE.md.
const MIN_PAGE_WORD_COUNT = 100

// Storage flush interval fallback — guards against data loss on unexpected tab closure.
// The primary flush is on visibilitychange; this is the safety net.
const FLUSH_INTERVAL_MS = 3 * 60 * 1000  // 3 minutes
const SETTINGS_KEY = 'contexto_settings'

interface RuntimeSettings {
  density?: number
  replacementsEnabled?: boolean
  quizzesEnabled?: boolean
}

let mutationObserver: MutationObserver | null = null
let isReplacementPipelineActive = false
let isReplacementPipelineRunning = false
let pendingReplacementRefresh = false
let lastEligibleCount = 0
let activeApprovedLemmas: ReadonlySet<string> = new Set()
let recordedApprovedLemmas = new Set<string>()
let rankedPageLemmas: string[] = []
let replacementPipelineRunVersion = 0
let extensionContextInvalidated = false
let storageFlushInterval: ReturnType<typeof setInterval> | null = null

function countPageWords(): number {
  return (document.body.innerText ?? '').trim().split(/\s+/).filter(Boolean).length
}

// Write the lexicon and session stores together in one storage call.
// No-op when the lexicon has no unsaved changes.
async function flushStorage(): Promise<void> {
  if (extensionContextInvalidated) return
  if (!isExtensionContextAvailable()) {
    shutdownInvalidatedContext(true)
    return
  }
  if (!isDirty()) return
  try {
    await chrome.storage.local.set({
      contexto_lexicon: getLexiconForStorage(),
      contexto_session: getSessionForStorage(),
    })
    clearDirty()
  } catch (err) {
    if (isExtensionContextInvalidatedError(err)) {
      shutdownInvalidatedContext(true)
      return
    }
    console.warn('[Contexto] Storage flush failed:', err)
  }
}

function syncQuizTimer(quizzesEnabled: boolean): void {
  if (quizzesEnabled) {
    startQuizTimer(lastEligibleCount)
  } else {
    stopQuizTimer()
  }
}

function runQueuedReplacementRefresh(): void {
  if (!pendingReplacementRefresh || isReplacementPipelineRunning) return

  pendingReplacementRefresh = false
  if (isReplacementPipelineActive) {
    void refreshReplacementPipeline()
  } else {
    void startReplacementPipeline()
  }
}

function requestReplacementRefresh(): void {
  pendingReplacementRefresh = true
  runQueuedReplacementRefresh()
}

function beginReplacementPipelineRun(): number {
  replacementPipelineRunVersion++
  return replacementPipelineRunVersion
}

function isCurrentReplacementPipelineRun(runVersion: number): boolean {
  return !extensionContextInvalidated && runVersion === replacementPipelineRunVersion
}

function deactivateReplacementPipeline(restoreDom: boolean, flush = true): void {
  stopQuizTimer()
  mutationObserver?.disconnect()
  mutationObserver = null
  if (restoreDom) restoreReplacements(document)
  removeHoverUI()
  activeApprovedLemmas = new Set()
  recordedApprovedLemmas = new Set()
  rankedPageLemmas = []
  isReplacementPipelineActive = false
  lastEligibleCount = 0
  if (flush) void flushStorage()
}

function shutdownInvalidatedContext(restoreDom: boolean): void {
  if (extensionContextInvalidated) return

  extensionContextInvalidated = true
  pendingReplacementRefresh = false
  isReplacementPipelineRunning = false
  replacementPipelineRunVersion++

  if (storageFlushInterval !== null) {
    clearInterval(storageFlushInterval)
    storageFlushInterval = null
  }

  deactivateReplacementPipeline(restoreDom, false)
}

function rememberRecordedLemmas(lemmas: ReadonlySet<string>): void {
  for (const lemma of lemmas) {
    recordedApprovedLemmas.add(lemma)
  }
}

function updateRankedPageLemmas(pageCandidates: CandidateToken[]): string[] {
  const candidateLemmas = new Set(pageCandidates.map(candidate => candidate.lemma))
  const retainedRankedLemmas = rankedPageLemmas.filter(lemma => candidateLemmas.has(lemma))
  const retained = new Set(retainedRankedLemmas)

  // Existing lemmas keep their page rank so density changes feel additive:
  // increasing the slider adds more words instead of reshuffling the page.
  const newCandidates = pageCandidates.filter(candidate => !retained.has(candidate.lemma))
  const newRankedLemmas = selectTokens(newCandidates, newCandidates.length)
    .map(token => token.lemma)

  rankedPageLemmas = [...retainedRankedLemmas, ...newRankedLemmas]
  return rankedPageLemmas
}

async function renderReplacementPass(
  shouldRecordExposure?: (lemma: string) => boolean,
  isCurrentRun: () => boolean = () => true,
): Promise<boolean> {
  // Set up hover handling before injection so the first rendered span is covered.
  setupHoverHandler()

  // Walk and process all text nodes. collectTextNodes() may return [] if the
  // user chose Keep Paused on the high-stakes domain banner.
  const textNodes = await collectTextNodes(document.body)
  if (!isCurrentRun()) return false

  // --- Pass A: page-level word selection ---
  // Collect one representative candidate per unique eligible lemma across all
  // nodes, then run the word selector once for the whole page. This ensures
  // that once a lemma is chosen it is replaced in every text node, not just
  // the first node where it happened to beat the per-node density cap.
  const pageCandidates = extractPageCandidates(textNodes)
  lastEligibleCount = pageCandidates.length
  const density = computeDensity(pageCandidates.length)
  const maxReplacements = Math.floor(density * pageCandidates.length)
  const rankedLemmas = updateRankedPageLemmas(pageCandidates)
  const approvedLemmas = new Set(rankedLemmas.slice(0, maxReplacements))

  // --- Pass B: replacement ---
  // Replace every occurrence of every approved lemma across all text nodes.
  for (const node of textNodes) {
    injectReplacements(node, approvedLemmas, { shouldRecordExposure })
  }
  if (!isCurrentRun()) return false

  // Attach the SPA-safe MutationObserver now that approvedLemmas is settled.
  // It will apply the same replacement set to any DOM nodes added after the
  // current pass (route transitions, infinite scroll, dynamic widgets).
  mutationObserver = setupMutationObserver(approvedLemmas)
  activeApprovedLemmas = approvedLemmas
  return true
}

async function startReplacementPipeline(): Promise<void> {
  if (extensionContextInvalidated) return
  if (!isExtensionContextAvailable()) {
    shutdownInvalidatedContext(true)
    return
  }
  if (isReplacementPipelineActive) return
  if (isReplacementPipelineRunning) {
    pendingReplacementRefresh = true
    return
  }

  const runVersion = beginReplacementPipelineRun()
  isReplacementPipelineRunning = true

  try {
    await loadSettings()
    if (!isCurrentReplacementPipelineRun(runVersion)) return

    if (!areReplacementsEnabled()) return

    // Silently exit on pages with too little content — no readable immersion possible.
    if (countPageWords() < MIN_PAGE_WORD_COUNT) return

    // Load runtime data only after the user-facing replacement toggle is enabled.
    await loadLanguagePack(getTargetLanguage())
    await loadLexicon()
    if (!isCurrentReplacementPipelineRun(runVersion)) return

    // Reset the in-memory session for this page load.
    initSession()
    recordedApprovedLemmas = new Set()
    rankedPageLemmas = []

    // If the user has not completed onboarding, show the level picker overlay
    // and wait for it to finish before proceeding. The picker saves the level
    // and pre-populates the lexicon.
    if (!isOnboarded()) {
      await showLevelPicker()
      if (!isCurrentReplacementPipelineRun(runVersion)) return
    }

    const rendered = await renderReplacementPass(
      undefined,
      () => isCurrentReplacementPipelineRun(runVersion),
    )
    if (!rendered) return

    rememberRecordedLemmas(activeApprovedLemmas)
    isReplacementPipelineActive = true
    syncQuizTimer(areQuizzesEnabled())
  } catch (err) {
    if (isExtensionContextInvalidatedError(err)) {
      shutdownInvalidatedContext(true)
      return
    }
    console.warn('[Contexto] Startup failed, extension inactive:', err)
    deactivateReplacementPipeline(true)
  } finally {
    isReplacementPipelineRunning = false
    if (!extensionContextInvalidated) runQueuedReplacementRefresh()
  }
}

async function refreshReplacementPipeline(): Promise<void> {
  if (extensionContextInvalidated) return
  if (!isExtensionContextAvailable()) {
    shutdownInvalidatedContext(true)
    return
  }
  if (!isReplacementPipelineActive) {
    await startReplacementPipeline()
    return
  }
  if (isReplacementPipelineRunning) {
    pendingReplacementRefresh = true
    return
  }

  const runVersion = beginReplacementPipelineRun()
  isReplacementPipelineRunning = true

  try {
    await loadSettings()
    if (!isCurrentReplacementPipelineRun(runVersion)) return

    if (!areReplacementsEnabled()) {
      deactivateReplacementPipeline(true)
      return
    }

    mutationObserver?.disconnect()
    mutationObserver = null

    restoreReplacements(document)

    // Dynamic pages can shrink below the readable-content threshold; after a
    // live restore, stop cleanly instead of leaving a no-op observer attached.
    if (countPageWords() < MIN_PAGE_WORD_COUNT) {
      deactivateReplacementPipeline(false)
      return
    }

    const rendered = await renderReplacementPass(
      lemma => !recordedApprovedLemmas.has(lemma),
      () => isCurrentReplacementPipelineRun(runVersion),
    )
    if (!rendered) return

    rememberRecordedLemmas(activeApprovedLemmas)
    isReplacementPipelineActive = true
    syncQuizTimer(areQuizzesEnabled())
  } catch (err) {
    if (isExtensionContextInvalidatedError(err)) {
      shutdownInvalidatedContext(true)
      return
    }
    console.warn('[Contexto] Live density refresh failed, extension inactive:', err)
    deactivateReplacementPipeline(true)
  } finally {
    isReplacementPipelineRunning = false
    if (!extensionContextInvalidated) runQueuedReplacementRefresh()
  }
}

function stopReplacementPipeline(): void {
  pendingReplacementRefresh = false
  replacementPipelineRunVersion++
  deactivateReplacementPipeline(true)
  isReplacementPipelineRunning = false
}

function handleSettingsChange(settings: RuntimeSettings, previousSettings: RuntimeSettings): void {
  if (extensionContextInvalidated) return

  const replacementsEnabled = settings.replacementsEnabled ?? true
  const quizzesEnabled = settings.quizzesEnabled ?? false
  const densityChanged =
    typeof settings.density === 'number' &&
    settings.density !== previousSettings.density

  if (!replacementsEnabled) {
    stopReplacementPipeline()
    return
  }

  if (!isReplacementPipelineActive) {
    void startReplacementPipeline()
    return
  }

  if (densityChanged) {
    requestReplacementRefresh()
  }

  if (quizzesEnabled) {
    startQuizTimer(lastEligibleCount)
  } else {
    stopQuizTimer()
  }
}

async function main(): Promise<void> {
  // The manifest sets run_at: document_idle, so the DOM is ready by the time
  // this script executes. Guard defensively for edge cases (e.g. dynamic injection).
  if (document.readyState === 'loading') {
    await new Promise<void>((resolve) => {
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true })
    })
  }

  if (!isExtensionContextAvailable()) return

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[SETTINGS_KEY]) return
    handleSettingsChange(
      (changes[SETTINGS_KEY].newValue ?? {}) as RuntimeSettings,
      (changes[SETTINGS_KEY].oldValue ?? {}) as RuntimeSettings,
    )
  })

  // --- Storage write strategy ---
  // Primary: flush on visibilitychange (tab hidden / user navigates away).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void flushStorage()
    }
  })

  // Fallback: flush every 3 minutes so data isn't lost on crash or hard close.
  storageFlushInterval = setInterval(() => { void flushStorage() }, FLUSH_INTERVAL_MS)

  await startReplacementPipeline()
}

main().catch((err) => {
  if (isExtensionContextInvalidatedError(err)) {
    shutdownInvalidatedContext(true)
    return
  }
  console.warn('[Contexto] Startup failed, extension inactive:', err)
  deactivateReplacementPipeline(true)
})
