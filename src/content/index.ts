import { ensureTailLoaded, getActiveTargetLanguage, isTailLoaded, loadLanguagePack } from '../language/loader.js'
import { collectTextNodes } from './domWalker.js'
import { extractPageCandidates, injectReplacements, restoreReplacements } from './injector.js'
import { removeHoverUI, setupHoverHandler } from './hoverHandler.js'
import {
  getLexiconLanguage,
  loadLexicon,
  flushLexiconMerge,
  isDirty,
} from '../store/lexiconStore.js'
import {
  DEFAULT_DISABLED_PARTS_OF_SPEECH,
  areReplacementsEnabled,
  getBlockedDomains,
  getDensity,
  getDisabledPartsOfSpeech,
  getDomainDecision,
  getLevel,
  getTargetLanguage,
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
import { whenIdle } from '../utils/idle.js'
import { PAGE_STATUS_MESSAGE, type PageStatus } from '../types/index.js'
import type { CandidateToken, PartOfSpeech, RuntimeSettings } from '../types/index.js'

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

function currentHostname(): string {
  return window.location.hostname.replace(/^www\./, '')
}

// The settings currently in memory, in the shape change detection compares.
// `tailLoaded` reads live loader state (not a stored setting): once the niche
// tail has percolated in, this flips true and the diff re-renders to inject it.
function currentRuntimeSettings(): RuntimeSettings {
  return {
    density: getDensity(),
    level: getLevel(),
    replacementsEnabled: areReplacementsEnabled(),
    tailLoaded: isTailLoaded(),
    blockedDomains: [...getBlockedDomains()],
    domainDecision: getDomainDecision(currentHostname()),
    targetLanguage: getTargetLanguage(),
    disabledPartsOfSpeech: [...getDisabledPartsOfSpeech()],
  }
}

// The settings a finished render pass actually consumed — NOT whatever is in
// memory when it happens to finish. A reconcile can call loadSettings() while a
// pass is still awaiting its pack or walking the DOM, so the language is read
// back from the loader (what truly got loaded) and density and the disabled-POS
// set are the values the pass was handed. Recording live settings here would let
// an A -> B -> A toggle leave the page rendered in B while every later diff
// believes it is in A.
//
// `tailLoaded` is the state AT CANDIDATE EXTRACTION, not at pass end: the
// progressive tail merges in the background, so its commit can land mid-pass —
// after the pass chose its candidates from the core-only lookup(), but before it
// finished. Reading isTailLoaded() live here would record that render as
// tail-inclusive, and the queued percolation re-diff would wrongly drop as a
// no-op, stranding the page without its tail words.
function renderedRuntimeSettings(
  density: number,
  level: RuntimeSettings['level'],
  disabledPartsOfSpeech: readonly PartOfSpeech[],
  tailLoadedAtExtraction: boolean,
): RuntimeSettings {
  return {
    density,
    level,
    replacementsEnabled: true,
    tailLoaded: tailLoadedAtExtraction,
    blockedDomains: [...getBlockedDomains()],
    domainDecision: getDomainDecision(currentHostname()),
    targetLanguage: getActiveTargetLanguage(),
    disabledPartsOfSpeech: [...disabledPartsOfSpeech],
  }
}

// Canonical comparison form: order-insensitive, with the pre-feature default
// applied so a snapshot from before the field existed diffs as unchanged.
function normalizedDisabledPos(settings: RuntimeSettings): string {
  return JSON.stringify(
    [...(settings.disabledPartsOfSpeech ?? DEFAULT_DISABLED_PARTS_OF_SPEECH)].sort(),
  )
}

// Does the difference between two settings snapshots change what this page renders?
function rendersDifferently(previous: RuntimeSettings, next: RuntimeSettings): boolean {
  return (
    next.density !== previous.density ||
    next.level !== previous.level ||
    (next.targetLanguage ?? 'es') !== (previous.targetLanguage ?? 'es') ||
    (next.tailLoaded ?? false) !== (previous.tailLoaded ?? false) ||
    JSON.stringify(next.blockedDomains ?? []) !== JSON.stringify(previous.blockedDomains ?? []) ||
    next.domainDecision !== previous.domainDecision ||
    normalizedDisabledPos(next) !== normalizedDisabledPos(previous)
  )
}

// Is the ONLY render-relevant difference that the niche tail finished loading?
// This is the additive case: everything already on the page stays valid, only
// new vocabulary became available — so the refresh can inject incrementally
// instead of tearing the page down and re-rendering it (a multi-second
// main-thread freeze on large pages). Any genuine settings/language change
// still takes the full restore-and-re-render path.
function isTailArrivalOnly(previous: RuntimeSettings, next: RuntimeSettings): boolean {
  return (
    (next.tailLoaded ?? false) &&
    !(previous.tailLoaded ?? false) &&
    next.density === previous.density &&
    next.level === previous.level &&
    (next.targetLanguage ?? 'es') === (previous.targetLanguage ?? 'es') &&
    JSON.stringify(next.blockedDomains ?? []) === JSON.stringify(previous.blockedDomains ?? []) &&
    next.domainDecision === previous.domainDecision &&
    normalizedDisabledPos(next) === normalizedDisabledPos(previous)
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

// What a finished pass reports: whether it rendered, and whether the tail was
// merged when its candidates were extracted (see renderedRuntimeSettings).
interface RenderPassResult {
  rendered: boolean
  tailLoadedAtExtraction: boolean
}

async function renderReplacementPass(
  density: number,
  level: RuntimeSettings['level'],
  disabledPartsOfSpeech: readonly PartOfSpeech[],
  shouldRecordExposure?: (lemma: string) => boolean,
  isCurrentRun: () => boolean = () => true,
): Promise<RenderPassResult> {
  // Set up hover handling before injection so the first rendered span is covered.
  setupHoverHandler()

  // Walk and process all text nodes. collectTextNodes() may return [] if the
  // user chose Keep Paused on the high-stakes domain banner.
  const textNodes = await collectTextNodes(document.body)
  const tailLoadedAtExtraction = isTailLoaded()
  if (!isCurrentRun()) return { rendered: false, tailLoadedAtExtraction }

  // --- Pass A: page-level word selection ---
  // Collect one representative candidate per unique eligible lemma across all
  // nodes, then run the word selector once for the whole page. This ensures
  // that once a lemma is chosen it is replaced in every text node, not just
  // the first node where it happened to beat the per-node density cap.
  const pageCandidates = extractPageCandidates(textNodes, disabledPartsOfSpeech, level)
  const maxReplacements = Math.floor(density * pageCandidates.length)
  const rankedLemmas = updateRankedPageLemmas(pageCandidates)
  const approvedLemmas = new Set(rankedLemmas.slice(0, maxReplacements))

  // --- Pass B: replacement ---
  // Replace every occurrence of every approved lemma across all text nodes.
  for (const node of textNodes) {
    injectReplacements(node, approvedLemmas, { shouldRecordExposure })
  }
  if (!isCurrentRun()) return { rendered: false, tailLoadedAtExtraction }

  // Attach the SPA-safe MutationObserver now that approvedLemmas is settled.
  // It will apply the same replacement set to any DOM nodes added after the
  // current pass (route transitions, infinite scroll, dynamic widgets).
  mutationObserver = setupMutationObserver(approvedLemmas)
  activeApprovedLemmas = approvedLemmas
  return { rendered: true, tailLoadedAtExtraction }
}

// How long one synchronous slice of the incremental tail pass may hold the main
// thread before yielding. The tail percolates in AFTER the page is already
// rendered and readable, so its work must stay imperceptible.
const INCREMENTAL_SLICE_BUDGET_MS = 30

// The ADDITIVE render pass for tail arrival: everything already injected on the
// page stays valid (same language, density, filters — only new vocabulary became
// available), so instead of restoring and re-rendering the whole page (a
// multi-second main-thread freeze on large pages), inject just the marginal
// lemmas into the still-unreplaced text.
//
// Correctness relies on measured injector mechanics:
// - The DOM walker skips [data-contexto] spans, so a fresh walk sees exactly the
//   text that is still English. Already-approved lemmas had every occurrence
//   replaced, so they cannot double-inject; unreplaced nodes keep their
//   parsedNodeCache entry (re-parse is a cache hit), and only the leftover text
//   runs of replaced nodes need fresh parses.
// - Density stays page-wide: the target is density * |already-injected lemmas +
//   candidates still on the page|, and only the shortfall is injected, taken in
//   the SAME page-rank order a full re-render would use (the initial pass
//   approved a prefix of rankedPageLemmas; this approves the next entries). The
//   parse of leftover fragments has less sentence context than a restored page
//   would, so when this differs from a full re-render it yields slightly FEWER
//   injections, never more.
// - Work is sliced under a time budget with idle yields, so the pass never
//   freezes the main thread the way the restore+re-render reconcile did.
async function renderIncrementalTailPass(
  density: number,
  level: RuntimeSettings['level'],
  disabledPartsOfSpeech: readonly PartOfSpeech[],
  isCurrentRun: () => boolean,
): Promise<RenderPassResult> {
  setupHoverHandler()

  const textNodes = await collectTextNodes(document.body)
  const tailLoadedAtExtraction = isTailLoaded()
  if (!isCurrentRun()) return { rendered: false, tailLoadedAtExtraction }

  // --- Pass A (sliced): candidates from the still-unreplaced text ---
  const pageCandidates: CandidateToken[] = []
  const seenLemmas = new Set<string>()
  let index = 0
  while (index < textNodes.length) {
    await whenIdle()
    if (!isCurrentRun()) return { rendered: false, tailLoadedAtExtraction }
    const sliceStart = performance.now()
    while (index < textNodes.length && performance.now() - sliceStart < INCREMENTAL_SLICE_BUDGET_MS) {
      // Per-node extraction so the time budget is honored between nodes; the
      // per-lemma dedupe extractPageCandidates does within one call is applied
      // across slices here.
      for (const candidate of extractPageCandidates([textNodes[index]], disabledPartsOfSpeech, level)) {
        if (seenLemmas.has(candidate.lemma)) continue
        seenLemmas.add(candidate.lemma)
        pageCandidates.push(candidate)
      }
      index++
    }
  }

  // --- Marginal selection at page-wide density ---
  const poolLemmas = new Set<string>(activeApprovedLemmas)
  for (const candidate of pageCandidates) poolLemmas.add(candidate.lemma)
  const targetTotal = Math.floor(density * poolLemmas.size)
  const marginalBudget = Math.max(0, targetTotal - activeApprovedLemmas.size)

  // Extend the retained page ranking with the new candidates. Existing entries
  // keep their rank (updateRankedPageLemmas would DROP the already-replaced
  // lemmas here, because their occurrences are no longer extractable), so later
  // full refreshes keep the additive-density behavior.
  const alreadyRanked = new Set(rankedPageLemmas)
  const newCandidates = pageCandidates.filter(candidate => !alreadyRanked.has(candidate.lemma))
  rankedPageLemmas = [
    ...rankedPageLemmas,
    ...selectTokens(newCandidates, newCandidates.length).map(token => token.lemma),
  ]

  const candidateLemmas = new Set(pageCandidates.map(candidate => candidate.lemma))
  const approvedNew = new Set<string>()
  for (const lemma of rankedPageLemmas) {
    if (approvedNew.size >= marginalBudget) break
    if (activeApprovedLemmas.has(lemma) || !candidateLemmas.has(lemma)) continue
    approvedNew.add(lemma)
  }

  // --- Pass B (sliced): inject only the marginal lemmas ---
  const shouldRecord = (lemma: string): boolean => !recordedApprovedLemmas.has(lemma)
  index = 0
  while (index < textNodes.length && approvedNew.size > 0) {
    await whenIdle()
    if (!isCurrentRun()) return { rendered: false, tailLoadedAtExtraction }
    const sliceStart = performance.now()
    while (index < textNodes.length && performance.now() - sliceStart < INCREMENTAL_SLICE_BUDGET_MS) {
      injectReplacements(textNodes[index], approvedNew, { shouldRecordExposure: shouldRecord })
      index++
    }
  }
  if (!isCurrentRun()) return { rendered: false, tailLoadedAtExtraction }

  // Reattach the SPA observer with the full replacement set so content added
  // later gets core AND tail vocabulary.
  const union = new Set([...activeApprovedLemmas, ...approvedNew])
  mutationObserver = setupMutationObserver(union)
  activeApprovedLemmas = union
  return { rendered: true, tailLoadedAtExtraction }
}

// Bring the niche tail in behind the first paint. The core-only pass has already
// rendered; this loads the tail progressively off the critical path and, once it
// has merged, re-renders through the normal reconcile so the tail words percolate
// into the page. Idempotent: a no-op once the tail is loaded for the active
// language, and ensureTailLoaded coalesces repeat calls while it is in flight.
function schedulePercolation(): void {
  if (extensionContextInvalidated) return
  if (isTailLoaded()) return

  const language = getActiveTargetLanguage()
  void ensureTailLoaded(language)
    .then(() => {
      if (extensionContextInvalidated) return
      // A language switch during the load supersedes this percolation; the new
      // language's pass will re-arm its own.
      if (getActiveTargetLanguage() !== language) return
      // The tail merged: the tailLoaded diff now differs from what was rendered,
      // so this reconciles the open page to include the niche vocabulary.
      requestReplacementRefresh()
    })
    .catch((err) => {
      if (isExtensionContextInvalidatedError(err)) {
        shutdownInvalidatedContext(true)
        return
      }
      console.warn('[Contexto] Tail percolation failed:', err)
    })
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
    // Only the CORE shard here — the first paint never waits on the niche tail,
    // which percolates in afterwards (schedulePercolation, below).
    await loadLanguagePack(getTargetLanguage())
    await loadLexicon(getTargetLanguage())
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
    const level = getLevel()
    const disabledPos = [...getDisabledPartsOfSpeech()]
    const pass = await renderReplacementPass(
      density,
      level,
      disabledPos,
      undefined,
      () => isCurrentReplacementPipelineRun(runVersion),
    )
    if (!pass.rendered) return

    rememberRecordedLemmas(activeApprovedLemmas)
    isReplacementPipelineActive = true
    appliedSettings = renderedRuntimeSettings(density, level, disabledPos, pass.tailLoadedAtExtraction)
    // First core-only pass has rendered; now bring the niche tail in behind it.
    schedulePercolation()
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

    // Reload the CORE for the active language (a no-op when unchanged; a language
    // switch resets the tail so it re-percolates for the new language below). The
    // niche tail is never loaded synchronously here — it comes in via
    // schedulePercolation once this pass has rendered.
    const targetLanguage = getTargetLanguage()
    const languageChanged = getLexiconLanguage() !== targetLanguage
    await loadLanguagePack(targetLanguage)
    if (!isCurrentReplacementPipelineRun(runVersion)) return

    // Exposure, saved-word, and review state belong to the target language.
    // Switch maps only when the language changed; density/tail refreshes retain
    // this tab's unflushed in-memory exposure state.
    if (languageChanged) {
      await loadLexicon(targetLanguage)
      if (!isCurrentReplacementPipelineRun(runVersion)) return
      // A page session and its exposure de-duplication are language-specific too.
      // The same English lemma encountered after a language switch teaches a
      // different target word and must be counted for the new language.
      initSession()
      recordedApprovedLemmas = new Set()
      rankedPageLemmas = []
    }

    // Tail arrival is ADDITIVE: nothing on the page went stale, so do not tear
    // it down — inject the marginal tail vocabulary incrementally instead of
    // paying a full restore+re-render freeze. Any other change falls through to
    // the full path below.
    if (appliedSettings !== null && isTailArrivalOnly(appliedSettings, currentRuntimeSettings())) {
      mutationObserver?.disconnect()
      mutationObserver = null

      const density = computeDensity()
      const level = getLevel()
      const disabledPos = [...getDisabledPartsOfSpeech()]
      const pass = await renderIncrementalTailPass(
        density,
        level,
        disabledPos,
        () => isCurrentReplacementPipelineRun(runVersion),
      )
      if (!pass.rendered) return

      rememberRecordedLemmas(activeApprovedLemmas)
      isReplacementPipelineActive = true
      appliedSettings = renderedRuntimeSettings(density, level, disabledPos, pass.tailLoadedAtExtraction)
      return
    }

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
    const level = getLevel()
    const disabledPos = [...getDisabledPartsOfSpeech()]
    const pass = await renderReplacementPass(
      density,
      level,
      disabledPos,
      lemma => !recordedApprovedLemmas.has(lemma),
      () => isCurrentReplacementPipelineRun(runVersion),
    )
    if (!pass.rendered) return

    rememberRecordedLemmas(activeApprovedLemmas)
    isReplacementPipelineActive = true
    appliedSettings = renderedRuntimeSettings(density, level, disabledPos, pass.tailLoadedAtExtraction)
    // Keep the tail percolating: a language switch reset it, and until it is
    // loaded this re-arms the background load (idempotent once loaded).
    schedulePercolation()
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
  const hostname = currentHostname()
  const swapped = document.querySelectorAll('[data-contexto="true"]').length
  const sessionLemmas = [...new Set(
    getSessionForStorage().wordsSeen.map(word => word.englishLemma),
  )]
  const replacedThisSession = sessionLemmas.length
  const context = { replacedThisSession, sessionLemmas, language, hostname }

  if (!areReplacementsEnabled()) {
    return { kind: 'off', swapped: 0, ...context }
  }
  if (pipelineFailed) {
    return { kind: 'error', swapped: 0, ...context }
  }

  // Blocked and paused look the same on the page but have different escape
  // hatches, so the popup needs to tell them apart.
  if (isDomainBlocked(hostname)) {
    return { kind: 'blocked', swapped: 0, ...context }
  }
  if (getDomainDecision(hostname) === false) {
    return { kind: 'paused', swapped: 0, ...context }
  }

  // Mid-run, or readable content is present but no pass has landed yet (the
  // content watcher is about to fire). Never report "too short" for a full page.
  if (isReplacementPipelineRunning) {
    return { kind: 'loading', swapped, ...context }
  }
  if (!isReplacementPipelineActive) {
    return countPageWords() >= MIN_PAGE_WORD_COUNT
      ? { kind: 'loading', swapped, ...context }
      : { kind: 'too-short', swapped: 0, ...context }
  }

  return { kind: 'active', swapped, ...context }
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
