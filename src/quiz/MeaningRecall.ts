/**
 * MeaningRecall.ts — Quiz format: target-language word → correct English meaning.
 *
 * Presents the translated word and asks the user to identify which of four
 * English options is the word being replaced. This is the fallback format used
 * when no sentence context is available for the word.
 *
 * Distractors are drawn from the current session word pool first (words the user
 * has already encountered on this page), falling back to random dictionary samples
 * if the pool is too small.
 *
 * Calls onResult(correct) after a 900ms feedback delay so the user can see
 * which answer was right before the banner dismisses.
 */

import { getWordsSeen } from '../store/sessionStore.js'
import { sampleLemmas } from '../language/loader.js'

// Delay between the user selecting an answer and onResult() being called.
// Long enough to read the feedback colour, short enough not to feel sluggish.
const FEEDBACK_DELAY_MS = 900

// ---------------------------------------------------------------------------
// Distractor building
// ---------------------------------------------------------------------------

function buildOptions(correctLemma: string): string[] {
  // Gather candidate distractors from words seen this session, excluding the
  // correct answer. Session words are the most contextually relevant distractors.
  const sessionLemmas = getWordsSeen()
    .map(w => w.englishLemma)
    .filter(lemma => lemma !== correctLemma)

  // Deduplicate while preserving order.
  const seen = new Set<string>()
  const pool: string[] = []
  for (const lemma of sessionLemmas) {
    if (!seen.has(lemma)) {
      seen.add(lemma)
      pool.push(lemma)
    }
  }

  const DISTRACTOR_COUNT = 3
  let distractors: string[] = pool.slice(0, DISTRACTOR_COUNT)

  // Pad with random dictionary samples if the session pool is too small.
  if (distractors.length < DISTRACTOR_COUNT) {
    const needed = DISTRACTOR_COUNT - distractors.length
    const exclude = new Set([correctLemma, ...distractors])
    const fallback = sampleLemmas(needed, exclude)
    distractors = [...distractors, ...fallback]
  }

  // Dedupe so the same string can't appear in two option slots (which would
  // otherwise let a distractor equal the correct answer and double-mark).
  const uniqueOptions: string[] = []
  const optionSeen = new Set<string>()
  for (const option of [correctLemma, ...distractors]) {
    if (optionSeen.has(option)) continue
    optionSeen.add(option)
    uniqueOptions.push(option)
  }

  // Shuffle all options so the correct answer isn't always in the same slot.
  const options = uniqueOptions
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[options[i], options[j]] = [options[j], options[i]]
  }
  return options
}

// ---------------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------------

const STYLES = {
  prompt: `
    font-size: 13px;
    color: #475569;
    margin-bottom: 6px;
    font-family: system-ui, sans-serif;
  `,
  targetWord: `
    font-size: 22px;
    font-weight: 700;
    color: #1b2733;
    margin-bottom: 16px;
    font-family: system-ui, sans-serif;
  `,
  grid: `
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  `,
  optionBase: `
    padding: 8px 12px;
    border: 1px solid #dce3ea;
    border-radius: 6px;
    background: #fff;
    cursor: pointer;
    font-size: 14px;
    font-family: system-ui, sans-serif;
    color: #1b2733;
    text-align: left;
    transition: background 0.15s, border-color 0.15s;
  `,
  correct: `
    background: #e8f1ea !important;
    border-color: #3f7d55 !important;
    color: #2f5d40 !important;
  `,
  incorrect: `
    background: #f6e7e5 !important;
    border-color: #a8443a !important;
    color: #7e3128 !important;
  `,
  muted: `
    opacity: 0.45;
    cursor: default;
  `,
}

export interface MeaningRecallProps {
  englishLemma: string  // correct answer
  targetWord: string    // displayed to the user
  onResult: (correct: boolean) => void
}

/**
 * Render a MeaningRecall quiz into `container` and return the root element.
 * The caller (QuizBanner) is responsible for mounting / unmounting the container.
 */
export function renderMeaningRecall(
  container: HTMLElement,
  { englishLemma, targetWord, onResult }: MeaningRecallProps,
): void {
  const options = buildOptions(englishLemma)
  let answered = false

  // Prompt
  const prompt = document.createElement('p')
  prompt.style.cssText = STYLES.prompt
  prompt.textContent = 'What does this translated word mean?'

  // Target-language word
  const word = document.createElement('p')
  word.style.cssText = STYLES.targetWord
  word.textContent = targetWord

  // Option buttons
  const grid = document.createElement('div')
  grid.style.cssText = STYLES.grid

  // The exact button element that represents the correct answer. Captured by
  // identity (not text) so feedback marks only one button even if two options
  // happen to share a string.
  let correctBtn: HTMLButtonElement | null = null

  const buttons: HTMLButtonElement[] = options.map(lemma => {
    const btn = document.createElement('button')
    btn.style.cssText = STYLES.optionBase
    btn.textContent = lemma
    if (lemma === englishLemma) correctBtn = btn
    btn.addEventListener('click', () => {
      if (answered) return
      answered = true

      const correct = btn === correctBtn

      // Apply feedback colours to all buttons, locating the correct one by
      // reference so a duplicate string can't get marked too.
      buttons.forEach(b => {
        if (b === correctBtn) {
          b.style.cssText = STYLES.optionBase + STYLES.correct
        } else if (b === btn && !correct) {
          b.style.cssText = STYLES.optionBase + STYLES.incorrect
        } else {
          b.style.cssText = STYLES.optionBase + STYLES.muted
        }
        b.disabled = true
      })

      setTimeout(() => onResult(correct), FEEDBACK_DELAY_MS)
    })
    return btn
  })

  buttons.forEach(btn => grid.appendChild(btn))

  container.appendChild(prompt)
  container.appendChild(word)
  container.appendChild(grid)
}
