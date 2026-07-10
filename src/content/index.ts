import { getActiveTargetLanguage, isTailLoaded, loadLanguagePack } from '../language/loader.js'
import { collectTextNodes } from './domWalker.js'
import { extractPageCandidates, injectReplacements, restoreReplacements } from './injector.js'
import { removeHoverUI, setupHoverHandler } from './hoverHandler.js'
import { loadLexicon, flushLexiconMerge, isDirty } from '../store/lexiconStore.js'
import {
  areReplacementsEnabled,
  getBlockedDomains,
  getDensity,
  getDomainDecision,
  getTargetLanguage,
  isAggressiveMode,
  isDomainBlocked,
  loadSettings,
} from '../store/settingsStore.js'
import { initSession, getSessionForStorage } from '../store/sessionStore.js'
import { computeDensity } from '../engine/proficiencyModel.js'
import { selectTokens } from '../engine/wordSelector.js'
import { ensureFirstRunInit } from './firstRun.js'
import { setupMutationObserver, type MutationObserverHandle } from './mutationObserver.js'
import {
  isExtensionContextAvailable,
  isExtensionContextInvalidatedError,
} from '../utils/extensionContext.js'
import { PAGE_STATUS_MESSAGE, type PageStatus } from '../types/index.js'
import type { CandidateToken, RuntimeSettings } from '../types/index.js'

// Pages with fewer words than this are too short for meaningful immersion
// (e.g. error pages, blank tabs, single-widget dashboards).
// Matches the 100-word threshold in CLAUDE.md.
const MIN_PAGE_WORD_COUNT = 100

// Storage flush interval fallback — guards against data loss on unexpected tab closure.
// The primary flush is on visibilitychange; this is the safety net.
const FLUSH_INTERVAL_MS = 3 * 60 * 1000  // 3 minutes
const SETTINGS_KEY = 'contexto_settings'

// How long to keep watching a too-short page for content that arrives late, and
// how long the DOM must settle before we pay for another innerText measurement.
const CONTENT_WATCH_TIMEOUT_MS = 60 * 1000
const CONTENT_WATCH_DEBOUNCE_MS = 500

let mutationObserver: MutationObserverHandle | null = null
let isReplacementPipelineActive = false
let isReplacementPipelineRunning = false
let pendingReplacementRefresh = false
let activeApprovedLemmas: ReadonlySet<string> = new Set()
let recordedApprovedLemmas = new Set<string>()
let rankedPageLemmas: string[] = []
let replacementPipelineRunVersion = 0
let extensionContextInvalidated = false
let storageFlushInterval: ReturnType<typeof setInterval> | null = null
let pipelineFailed = false

// The settings this tab has actually rendered with. Change detection diffs
// against this rather than storage.onChanged's oldValue, so a tab that never
// received an event — frozen in the background, or restored from the bfcache —
// still converges the next time it is shown.
let appliedSettings: RuntimeSettings | null = null

// Watches a too-short page for content that arrives after document_idle.
let contentWatcher: MutationObserver | null = null
let contentWatchDebounce: ReturnType<typeof setTimeout> | null = null
let contentWatchTimeout: ReturnType<typeof setTimeout> | null = null

function countPageWords(): number {
  // body can be transiently null (document rewrite); a status query must not throw.
  return (document.body?.innerText ?? '').trim().split(/\s+/).filter(Boolean).length
}

// The settings currently in memory, in the shape change detection compares.
function currentRuntimeSettings(): RuntimeSettings {
  return {
    density: getDensity(),
    replacementsEnabled: areReplacementsEnabled(),
    aggressiveMode: isAggressiveMode(),
    blockedDomains: [...getBlockedDomains()],
    targetLanguage: getTargetLanguage(),
  }
}

// The settings a finished render pass actually consumed — NOT whatever is in
// memory when it happens to finish. A reconcile can call loadSettings() while a
// pass is still awaiting its pack or walking the DOM, so language and tail are
// read back from the loader (what truly got loaded) and density is the value the
// pass was handed. Recording live settings here would let an A -> B -> A toggle
// leave the page rendered in B while every later diff believes it is in A.
function renderedRuntimeSettings(density: number): RuntimeSettings {
  return {
    density,
    replacementsEnabled: true,
    aggressiveMode: isTailLoaded(),
    blockedDomains: [...getBlockedDomains()],
    targetLanguage: getActiveTargetLanguage(),
  }
}

// Does the difference between two settings snapshots change what this page renders?
function rendersDifferently(previous: RuntimeSettings, next: RuntimeSettings): boolean {
  return (
    next.density !== previous.density ||
    (next.targetLanguage ?? 'es') !== (previous.targetLanguage ?? 'es') ||
    (next.aggressiveMode ?? false) !== (previous.aggressiveMode ?? false) ||
    JSON.stringify(next.blockedDomains ?? []) !== JSON.stringify(previous.blockedDomains ?? [])
  )
}

function stopContentWatcher(): void {
  contentWatcher?.disconnect()
  contentWatcher = null
  if (contentWatchDebounce !== null) {
    clearTimeout(contentWatchDebounce)
    contentWatchDebounce = null
  }
  if (contentWatchTimeout !== null) {
    clearTimeout(contentWatchTimeout)
    contentWatchTimeout = null
  }
}

// A client-rendered page is often under MIN_PAGE_WORD_COUNT at document_idle and
// fills in a moment later. The SPA MutationObserver is only attached after a
// successful render pass, so without this watcher such a page is never
// reconsidered and stays untranslated for the life of the tab.
//
// Bounded on both axes: it disconnects at the first successful start, and gives
// up after CONTENT_WATCH_TIMEOUT_MS (measuring the page one last time first, in
// case a never-quiet DOM kept starving the debounce).
function watchForReadableContent(): void {
  if (contentWatcher !== null || extensionContextInvalidated) return

  // countPageWords() forces a layout, so only measure once the DOM has settled.
  contentWatcher = new MutationObserver(() => {
    if (contentWatchDebounce !== null) clearTimeout(contentWatchDebounce)
    contentWatchDebounce = setTimeout(() => {
      contentWatchDebounce = null
      if (countPageWords() < MIN_PAGE_WORD_COUNT) return
      stopContentWatcher()
      void startReplacementPipeline()
    }, CONTENT_WATCH_DEBOUNCE_MS)
  })
  // characterData too: some frameworks mount empty text nodes and fill them in
  // place, which produces no childList mutation at all.
  contentWatcher.observe(document.body, { childList: true, subtree: true, characterData: true })

  contentWatchTimeout = setTimeout(() => {
    contentWatchTimeout = null
    const readable = countPageWords() >= MIN_PAGE_WORD_COUNT
    stopContentWatcher()
    if (readable) void startReplacementPipeline()
  }, CONTENT_WATCH_TIMEOUT_MS)
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
    // Merge-write only the lemmas this tab changed (flushLexiconMerge clears them)
    // so a passive flush can't revert lemmas the popup changed in another context.
    // The session store is page-scoped, so it is still written whole.
    await flushLexiconMerge()
    await chrome.storage.local.set({ contexto_session: getSessionForStorage() })
  } catch (err) {
    if (isExtensionContextInvalidatedError(err)) {
      shutdownInvalidatedContext(true)
      return
    }
    console.warn('[Contexto] Storage flush failed:', err)
  }
}

function runQueuedReplacementRefresh(): void {
  if (!pendingReplacementRefresh || isReplacementPipelineRunning) return

  pendingReplacementRefresh = false
  if (!isReplacementPipelineActive) {
    void startReplacementPipeline()
    return
  }
  // Re-diff now that appliedSettings reflects the render that just landed. A
  // change queued mid-run may have been undone before the run finished, in which
  // case there is nothing left to do.
  if (appliedSettings === null || rendersDifferently(appliedSettings, currentRuntimeSettings())) {
    void refreshReplacementPipeline()
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
  mutationObserver?.disconnect()
  mutationObserver = null
  if (restoreDom) restoreReplacements(document)
  removeHoverUI()
  activeApprovedLemmas = new Set()
  recordedApprovedLemmas = new Set()
  rankedPageLemmas = []
  isReplacementPipelineActive = false
  if (flush) void flushStorage()
}

function shutdownInvalidatedContext(restoreDom: boolean): void {
  if (extensionContextInvalidated) return

  extensionContextInvalidated = true
  pendingReplacementRefresh = false
  isReplacementPipelineRunning = false
  replacementPipelineRunVersion++
  stopContentWatcher()

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
  density: number,
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
  pipelineFailed = false

  try {
    await loadSettings()
    if (!isCurrentReplacementPipelineRun(runVersion)) return

    if (!areReplacementsEnabled()) return

    // Silently exit on pages with too little content — no readable immersion
    // possible yet. Keep watching: a client-rendered page fills in later.
    if (countPageWords() < MIN_PAGE_WORD_COUNT) {
      watchForReadableContent()
      return
    }
    // The page is readable, so any watcher armed by an earlier run is done.
    stopContentWatcher()

    // Load runtime data only after the user-facing replacement toggle is enabled.
    // Aggressive mode additionally loads the quarantined niche tail shard.
    await loadLanguagePack(getTargetLanguage(), isAggressiveMode())
    await loadLexicon()
    if (!isCurrentReplacementPipelineRun(runVersion)) return

    // Reset the in-memory session for this page load.
    initSession()
    recordedApprovedLemmas = new Set()
    rankedPageLemmas = []

    // First run: silently apply the intermediate defaults and seed the lexicon,
    // then proceed straight to replacement on this very page load. Must run
    // after the pack + lexicon loads above (prepopulation reads the pack's top
    // lemmas and merges onto the loaded lexicon). No-op once onboarded.
    await ensureFirstRunInit()
    if (!isCurrentReplacementPipelineRun(runVersion)) return

    const density = computeDensity()
    const rendered = await renderReplacementPass(
      density,
      undefined,
      () => isCurrentReplacementPipelineRun(runVersion),
    )
    if (!rendered) return

    rememberRecordedLemmas(activeApprovedLemmas)
    isReplacementPipelineActive = true
    appliedSettings = renderedRuntimeSettings(density)
  } catch (err) {
    if (isExtensionContextInvalidatedError(err)) {
      shutdownInvalidatedContext(true)
      return
    }
    console.warn('[Contexto] Startup failed, extension inactive:', err)
    pipelineFailed = true
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
  pipelineFailed = false

  try {
    await loadSettings()
    if (!isCurrentReplacementPipelineRun(runVersion)) return

    if (!areReplacementsEnabled()) {
      deactivateReplacementPipeline(true)
      return
    }

    // Reconcile the loaded pack with the current aggressive-mode setting: this
    // lazy-loads the niche tail when it was just turned on, or drops it when
    // turned off, so the re-render below injects the right vocabulary set.
    await loadLanguagePack(getTargetLanguage(), isAggressiveMode())
    if (!isCurrentReplacementPipelineRun(runVersion)) return

    mutationObserver?.disconnect()
    mutationObserver = null

    restoreReplacements(document)

    // Dynamic pages can shrink below the readable-content threshold; after a
    // live restore, stop cleanly instead of leaving a no-op observer attached.
    // Keep watching in case the next route brings the content back.
    if (countPageWords() < MIN_PAGE_WORD_COUNT) {
      deactivateReplacementPipeline(false)
      watchForReadableContent()
      return
    }

    const density = computeDensity()
    const rendered = await renderReplacementPass(
      density,
      lemma => !recordedApprovedLemmas.has(lemma),
      () => isCurrentReplacementPipelineRun(runVersion),
    )
    if (!rendered) return

    rememberRecordedLemmas(activeApprovedLemmas)
    isReplacementPipelineActive = true
    appliedSettings = renderedRuntimeSettings(density)
  } catch (err) {
    if (isExtensionContextInvalidatedError(err)) {
      shutdownInvalidatedContext(true)
      return
    }
    console.warn('[Contexto] Live density refresh failed, extension inactive:', err)
    pipelineFailed = true
    deactivateReplacementPipeline(true)
  } finally {
    isReplacementPipelineRunning = false
    if (!extensionContextInvalidated) runQueuedReplacementRefresh()
  }
}

function stopReplacementPipeline(): void {
  pendingReplacementRefresh = false
  replacementPipelineRunVersion++
  stopContentWatcher()
  deactivateReplacementPipeline(true)
  isReplacementPipelineRunning = false
}

// Bring this page in line with the settings currently in memory.
function applyCurrentSettings(): void {
  if (extensionContextInvalidated) return

  if (!areReplacementsEnabled()) {
    stopReplacementPipeline()
    return
  }

  // Mid-run the applied baseline is still in flux, so there is nothing sound to
  // diff against yet. Queue unconditionally; runQueuedReplacementRefresh re-diffs
  // once the run has landed and drops the work if it turned out to be a no-op.
  if (isReplacementPipelineRunning) {
    pendingReplacementRefresh = true
    return
  }

  if (!isReplacementPipelineActive) {
    void startReplacementPipeline()
    return
  }

  // A language switch, a blocked/unblocked domain, or a density change must take
  // effect on the open tab immediately — the refresh reloads the pack, re-runs the
  // domain check, and re-renders. Diffing against what this page actually rendered
  // (rather than against an event's oldValue) means a tab that never saw the write
  // still converges.
  if (appliedSettings === null || rendersDifferently(appliedSettings, currentRuntimeSettings())) {
    requestReplacementRefresh()
  }
}

// Re-read settings from storage, then reconcile the page against them.
//
// This is the single entry point for every settings change, which keeps the
// in-memory store authoritative for readers like describePageStatus(). It also
// covers the events a page never receives: Chrome does not replay
// storage.onChanged for a tab that was frozen in the background or held in the
// bfcache, so such a tab can be arbitrarily stale by the time the user looks at
// it again. Running this whenever the page is shown closes that gap.
async function reconcileWithStoredSettings(): Promise<void> {
  if (extensionContextInvalidated) return
  if (!isExtensionContextAvailable()) {
    shutdownInvalidatedContext(true)
    return
  }

  try {
    await loadSettings()
  } catch (err) {
    if (isExtensionContextInvalidatedError(err)) {
      shutdownInvalidatedContext(true)
      return
    }
    console.warn('[Contexto] Could not re-read settings:', err)
    return
  }

  applyCurrentSettings()
}

// Describe what Contexto is doing on THIS page, right now, for the popup.
// Everything is measured live rather than remembered, so the answer can never go
// stale behind a page that has since grown, shrunk, or been re-rendered.
function describePageStatus(): PageStatus {
  const language = getTargetLanguage()
  const swapped = document.querySelectorAll('[data-contexto="true"]').length

  if (!areReplacementsEnabled()) return { kind: 'off', swapped: 0, language }
  if (pipelineFailed) return { kind: 'error', swapped: 0, language }

  // Blocked and paused look the same on the page but have different escape
  // hatches, so the popup needs to tell them apart.
  const hostname = window.location.hostname.replace(/^www\./, '')
  if (isDomainBlocked(hostname)) return { kind: 'blocked', swapped: 0, language }
  if (getDomainDecision(hostname) === false) return { kind: 'paused', swapped: 0, language }

  // Mid-run, or readable content is present but no pass has landed yet (the
  // content watcher is about to fire). Never report "too short" for a full page.
  if (isReplacementPipelineRunning) return { kind: 'loading', swapped, language }
  if (!isReplacementPipelineActive) {
    return countPageWords() >= MIN_PAGE_WORD_COUNT
      ? { kind: 'loading', swapped, language }
      : { kind: 'too-short', swapped: 0, language }
  }

  return { kind: 'active', swapped, language }
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
    void reconcileWithStoredSettings()
  })

  // Answer the popup's per-page status query. Replies synchronously, so the
  // listener must not return true.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if ((message as { type?: string } | null)?.type !== PAGE_STATUS_MESSAGE) return
    sendResponse(describePageStatus())
  })

  // Restored from the bfcache: this DOM predates the restore, and a page in the
  // bfcache is not guaranteed to receive the settings events it slept through.
  // A frozen background tab does get its queued events on resume (measured), so
  // this covers only the restore case; it is a no-op on an ordinary navigation,
  // where `persisted` is false.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) void reconcileWithStoredSettings()
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
