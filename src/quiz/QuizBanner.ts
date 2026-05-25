/**
 * QuizBanner.ts — Non-blocking bottom-corner quiz container.
 *
 * Triggers after 3 minutes of active reading time (tab-visible time only —
 * pauses when the tab is hidden). Shows 2–3 words drawn from the session word
 * pool (up to 7 candidates, deduplicated by lemma).
 *
 * Format selection per word (priority order):
 *   1. ContextualQuiz  — when sentenceContext and surfaceForm are both present
 *   2. ReverseRecall   — when the word has been seen ≥ 2 times this session
 *   3. MeaningRecall   — fallback
 * Each format falls back to the next if it cannot render (onCannotRender).
 *
 * Non-blocking: the outer wrapper has pointer-events: none so the page is
 * fully interactive behind the banner. Only the panel itself receives events.
 *
 * Shows at most once per page load. Dismissed words are not penalised.
 */

import { getWordsSeen } from '../store/sessionStore.js'
import { applyQuizResult } from '../engine/wordLifecycle.js'
import { adjustDensityAfterQuiz } from '../engine/proficiencyModel.js'
import { getDensity, setDensity } from '../store/settingsStore.js'
import { renderMeaningRecall }  from './MeaningRecall.js'
import { renderReverseRecall }  from './ReverseRecall.js'
import { renderContextualQuiz } from './ContextualQuiz.js'
import type { WordSeen } from '../types/index.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUIZ_TRIGGER_MS       = 3 * 60 * 1000  // 3 minutes of active reading
const CHECK_INTERVAL_MS     = 30_000          // how often to check elapsed time
const QUIZ_POOL_MAX         = 7               // max candidates in the session pool
const QUIZ_COUNT_MIN        = 2               // min words quizzed per banner session
const QUIZ_COUNT_MAX        = 3               // max words quizzed per banner session
const SESSION_SEEN_THRESHOLD = 2              // min session appearances for ReverseRecall

// ---------------------------------------------------------------------------
// Active-time tracking (module-level — one instance per page load)
// ---------------------------------------------------------------------------

let activeStartMs  = Date.now()  // when the current visible period started
let totalActiveMs  = 0           // accumulated visible milliseconds
let hasShownBanner = false       // only one banner per page load

function accumulateActiveTime(): void {
  if (document.visibilityState === 'hidden') {
    // Tab going away — bank the time elapsed since we last became visible.
    totalActiveMs += Date.now() - activeStartMs
  } else {
    // Tab returning — start a fresh visible period.
    activeStartMs = Date.now()
  }
}

function getActiveMs(): number {
  const currentPeriod = document.visibilityState === 'visible'
    ? Date.now() - activeStartMs
    : 0
  return totalActiveMs + currentPeriod
}

// ---------------------------------------------------------------------------
// Quiz candidate pool
// ---------------------------------------------------------------------------

/**
 * Build the quiz candidate pool from words replaced this session.
 *
 * Deduplicates by lemma, preferring the WordSeen entry that has sentenceContext
 * (richer data → better quiz format available). Returns up to QUIZ_POOL_MAX
 * entries sorted most-recently-seen first.
 */
function buildQuizPool(): WordSeen[] {
  const wordsSeen = getWordsSeen()
  const byLemma = new Map<string, WordSeen>()

  for (const w of wordsSeen) {
    const existing = byLemma.get(w.englishLemma)
    // Prefer entries with sentence context; otherwise keep the first occurrence.
    if (!existing || (!existing.sentenceContext && w.sentenceContext)) {
      byLemma.set(w.englishLemma, w)
    }
  }

  const unique = [...byLemma.values()]
  unique.sort((a, b) => b.seenAt - a.seenAt)
  return unique.slice(0, QUIZ_POOL_MAX)
}

/**
 * Shuffle the pool and return 2–3 words to quiz, capped by pool size.
 */
function selectQuizWords(pool: WordSeen[]): WordSeen[] {
  const shuffled = [...pool]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  // Random count between QUIZ_COUNT_MIN and QUIZ_COUNT_MAX, capped by pool size.
  const count = Math.min(
    QUIZ_COUNT_MIN + Math.floor(Math.random() * (QUIZ_COUNT_MAX - QUIZ_COUNT_MIN + 1)),
    pool.length,
  )
  return shuffled.slice(0, count)
}

// ---------------------------------------------------------------------------
// Format selection
// ---------------------------------------------------------------------------

type QuizFormat = 'contextual' | 'reverse' | 'meaning'

function selectFormat(word: WordSeen): QuizFormat {
  // ContextualQuiz requires both the surface form and captured sentence.
  if (word.surfaceForm && word.sentenceContext) return 'contextual'

  // ReverseRecall is used once the user has seen the word multiple times,
  // so they have some passive exposure before being asked to produce it.
  const sessionCount = getWordsSeen().filter(w => w.englishLemma === word.englishLemma).length
  if (sessionCount >= SESSION_SEEN_THRESHOLD) return 'reverse'

  return 'meaning'
}

// ---------------------------------------------------------------------------
// Quiz rendering with fallback chain
// ---------------------------------------------------------------------------

/**
 * Render the appropriate quiz format for `word` into `container`.
 * If a format cannot render (missing data), falls back down the priority chain.
 * contextual → reverse → meaning
 */
function renderQuiz(
  container: HTMLElement,
  word: WordSeen,
  format: QuizFormat,
  onResult: (correct: boolean) => void,
): void {
  // Clear any previous quiz content from the container.
  while (container.firstChild) container.removeChild(container.firstChild)

  if (format === 'contextual') {
    renderContextualQuiz(container, {
      englishLemma:    word.englishLemma,
      surfaceForm:     word.surfaceForm,
      sentenceContext: word.sentenceContext,
      onResult,
      onCannotRender: () => renderQuiz(container, word, 'reverse', onResult),
    })
  } else if (format === 'reverse') {
    renderReverseRecall(container, {
      englishLemma: word.englishLemma,
      targetWord:   word.targetWord,
      onResult,
      onCannotRender: () => renderQuiz(container, word, 'meaning', onResult),
    })
  } else {
    renderMeaningRecall(container, {
      englishLemma: word.englishLemma,
      targetWord:   word.targetWord,
      onResult,
    })
  }
}

// ---------------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------------

// The outer wrapper covers the full viewport but passes pointer events through,
// so the page is fully interactive behind it. Only the panel receives events.
const WRAPPER_STYLE = `
  position: fixed;
  bottom: 0;
  right: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 2147483647;
`

const PANEL_STYLE = `
  position: absolute;
  bottom: 16px;
  right: 16px;
  width: 400px;
  max-width: calc(100vw - 32px);
  background: #ffffff;
  border-radius: 12px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.14), 0 1px 4px rgba(0,0,0,0.08);
  padding: 18px 20px 16px;
  pointer-events: auto;
  font-family: system-ui, -apple-system, sans-serif;
  box-sizing: border-box;
`

const HEADER_STYLE = `
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
`

const LABEL_STYLE = `
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #6b7280;
  text-transform: uppercase;
`

const CLOSE_BTN_STYLE = `
  background: none;
  border: none;
  cursor: pointer;
  font-size: 18px;
  color: #9ca3af;
  padding: 0;
  line-height: 1;
`

const PROGRESS_STYLE = `
  font-size: 11px;
  color: #9ca3af;
  text-align: right;
  margin-top: 12px;
`

// ---------------------------------------------------------------------------
// Banner lifecycle
// ---------------------------------------------------------------------------

function showBanner(eligibleCount: number): void {
  if (hasShownBanner) return
  const pool = buildQuizPool()
  if (pool.length === 0) return  // nothing to quiz on this page

  hasShownBanner = true
  const words = selectQuizWords(pool)
  let currentIndex = 0
  const quizResults: boolean[] = []  // accumulates correct/incorrect for density adjustment

  // --- Wrapper (full-viewport, pointer-events: none) ---
  const wrapper = document.createElement('div')
  wrapper.style.cssText = WRAPPER_STYLE
  wrapper.setAttribute('data-textum-quiz', 'true')

  // --- Panel (actual visible banner, pointer-events: auto) ---
  const panel = document.createElement('div')
  panel.style.cssText = PANEL_STYLE

  // Header: label + close button
  const header = document.createElement('div')
  header.style.cssText = HEADER_STYLE

  const label = document.createElement('span')
  label.style.cssText = LABEL_STYLE
  label.textContent = 'Quick Recall'

  const closeBtn = document.createElement('button')
  closeBtn.style.cssText = CLOSE_BTN_STYLE
  closeBtn.textContent = '×'
  closeBtn.setAttribute('aria-label', 'Dismiss quiz')
  closeBtn.addEventListener('click', dismiss)

  header.appendChild(label)
  header.appendChild(closeBtn)

  // Content area (quiz renders here)
  const content = document.createElement('div')

  // Progress indicator: "1 of 2"
  const progress = document.createElement('div')
  progress.style.cssText = PROGRESS_STYLE

  panel.appendChild(header)
  panel.appendChild(content)
  panel.appendChild(progress)
  wrapper.appendChild(panel)
  document.body.appendChild(wrapper)

  function dismiss(): void {
    wrapper.remove()
  }

  function showNext(): void {
    if (currentIndex >= words.length) {
      dismiss()
      return
    }

    const word = words[currentIndex]
    currentIndex++

    progress.textContent = `${currentIndex} of ${words.length}`

    renderQuiz(content, word, selectFormat(word), (correct) => {
      applyQuizResult(word.englishLemma, correct)
      quizResults.push(correct)

      // After the final word, adjust density based on overall quiz accuracy.
      // adjustDensityAfterQuiz already clamps the result; setDensity persists it.
      if (currentIndex >= words.length) {
        const accuracy = quizResults.filter(Boolean).length / quizResults.length
        void setDensity(adjustDensityAfterQuiz(getDensity(), accuracy, eligibleCount))
      }

      showNext()
    })
  }

  showNext()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the 3-minute active-reading timer and wire it to the visibility tracker.
 * Called once from index.ts after the replacement pass completes.
 *
 * `eligibleCount` is the number of candidate tokens on this page (from
 * extractPageCandidates). It is forwarded to showBanner so that
 * adjustDensityAfterQuiz has the observation window it needs.
 */
export function startQuizTimer(eligibleCount: number): void {
  // Track visible vs hidden time so the clock doesn't run while the tab is hidden.
  document.addEventListener('visibilitychange', accumulateActiveTime)

  const checkInterval = setInterval(() => {
    if (hasShownBanner) {
      clearInterval(checkInterval)
      return
    }
    if (getActiveMs() >= QUIZ_TRIGGER_MS) {
      clearInterval(checkInterval)
      showBanner(eligibleCount)
    }
  }, CHECK_INTERVAL_MS)
}
