/**
 * ContextualQuiz.ts — Quiz format: blanked sentence → correct target-language word.
 *
 * The highest-value quiz format. Shows the original English sentence with the
 * target word replaced by "___", and asks the user to pick the correct
 * translation from four options. The sentence provides context that mirrors real
 * reading conditions, making recall more transferable than isolated-word formats.
 *
 * Requires WordSeen.sentenceContext and WordSeen.surfaceForm (the exact surface
 * form as it appeared on the page, e.g. "dogs" for the lemma "dog"). Without
 * these, QuizBanner should fall back to ReverseRecall.
 *
 * Options are target-language base values (same logic as ReverseRecall).
 * Calls onResult(correct) after a 900ms feedback delay.
 */

import { getWordsSeen } from '../store/sessionStore.js'
import { lookup, sampleLemmas } from '../language/loader.js'

const FEEDBACK_DELAY_MS = 900
const DISTRACTOR_COUNT  = 3

// ---------------------------------------------------------------------------
// Sentence blanking
// ---------------------------------------------------------------------------

/**
 * Replace the first whole-word occurrence of `surfaceForm` in `sentence` with
 * "___", preserving the surrounding text exactly.
 *
 * Uses a word-boundary regex (\b) so "house" in "household" is not blanked.
 * Case-insensitive to handle sentence-initial capitalisation ("Dog" → "dog").
 *
 * Returns null if no match is found (shouldn't happen in practice since the
 * sentence was captured from the same text node as the surface form).
 */
function blankWord(sentence: string, surfaceForm: string): string | null {
  // Escape any regex metacharacters in the surface form — most English words
  // are plain, but hyphens in compounds or apostrophes in contractions could
  // interfere with the pattern if not escaped.
  const escaped = surfaceForm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`\\b${escaped}\\b`, 'i')
  if (!pattern.test(sentence)) return null
  return sentence.replace(pattern, '___')
}

// ---------------------------------------------------------------------------
// Distractor building (same strategy as ReverseRecall — target values)
// ---------------------------------------------------------------------------

function targetFor(lemma: string): string | null {
  return lookup(lemma)?.target ?? null
}

function buildOptions(englishLemma: string): { options: string[]; correctTarget: string } | null {
  const correctTarget = targetFor(englishLemma)
  if (correctTarget === null) return null

  const seenTargets = new Set<string>([correctTarget])
  const distractorPool: string[] = []

  for (const w of getWordsSeen()) {
    if (w.englishLemma === englishLemma) continue
    const target = targetFor(w.englishLemma)
    if (target === null || seenTargets.has(target)) continue
    seenTargets.add(target)
    distractorPool.push(target)
  }

  let distractors = distractorPool.slice(0, DISTRACTOR_COUNT)

  if (distractors.length < DISTRACTOR_COUNT) {
    const needed = DISTRACTOR_COUNT - distractors.length
    const excludeLemmas = new Set([englishLemma])
    for (const lemma of sampleLemmas(needed, excludeLemmas)) {
      const target = targetFor(lemma)
      if (target === null || seenTargets.has(target)) continue
      seenTargets.add(target)
      distractors.push(target)
    }
  }

  const options = [correctTarget, ...distractors]
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[options[i], options[j]] = [options[j], options[i]]
  }

  return { options, correctTarget }
}

// ---------------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------------

const STYLES = {
  prompt: `
    font-size: 13px;
    color: #888;
    margin-bottom: 8px;
    font-family: system-ui, sans-serif;
  `,
  sentence: `
    font-size: 14px;
    color: #374151;
    line-height: 1.55;
    margin-bottom: 16px;
    font-family: system-ui, sans-serif;
  `,
  blank: `
    font-weight: 700;
    color: #1a1a1a;
    letter-spacing: 0.05em;
  `,
  grid: `
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  `,
  optionBase: `
    padding: 8px 12px;
    border: 1.5px solid #d1d5db;
    border-radius: 6px;
    background: #fff;
    cursor: pointer;
    font-size: 14px;
    font-family: system-ui, sans-serif;
    color: #1a1a1a;
    text-align: left;
    transition: background 0.15s, border-color 0.15s;
  `,
  correct: `
    background: #dcfce7 !important;
    border-color: #16a34a !important;
    color: #15803d !important;
  `,
  incorrect: `
    background: #fee2e2 !important;
    border-color: #dc2626 !important;
    color: #b91c1c !important;
  `,
  muted: `
    opacity: 0.45;
    cursor: default;
  `,
}

export interface ContextualQuizProps {
  englishLemma: string
  surfaceForm: string    // exact surface form for blanking (e.g. "dogs")
  sentenceContext: string
  onResult: (correct: boolean) => void
  onCannotRender: () => void  // called if blanking fails or dictionary entry is missing
}

/**
 * Render a ContextualQuiz into `container`.
 *
 * The sentence is split into before/blank/after parts and assembled from text
 * nodes — no innerHTML — so page scripts cannot inject content through the
 * sentence context.
 */
export function renderContextualQuiz(
  container: HTMLElement,
  { englishLemma, surfaceForm, sentenceContext, onResult, onCannotRender }: ContextualQuizProps,
): void {
  const built = buildOptions(englishLemma)
  if (built === null) {
    onCannotRender()
    return
  }

  const blanked = blankWord(sentenceContext, surfaceForm)
  if (blanked === null) {
    onCannotRender()
    return
  }

  const { options, correctTarget } = built
  let answered = false

  // Prompt
  const prompt = document.createElement('p')
  prompt.style.cssText = STYLES.prompt
  prompt.textContent = 'Fill in the blank with the Spanish translation:'

  // Sentence with blank — built from DOM text nodes, not innerHTML.
  // Split on "___" and render the blank as a styled <span> between the halves.
  const sentenceEl = document.createElement('p')
  sentenceEl.style.cssText = STYLES.sentence

  const blankIndex = blanked.indexOf('___')
  if (blankIndex === -1) {
    // Shouldn't happen since blankWord() returned non-null, but guard anyway.
    onCannotRender()
    return
  }

  const before = blanked.slice(0, blankIndex)
  const after  = blanked.slice(blankIndex + 3)

  const blankSpan = document.createElement('span')
  blankSpan.style.cssText = STYLES.blank
  blankSpan.textContent = '___'

  sentenceEl.appendChild(document.createTextNode(before))
  sentenceEl.appendChild(blankSpan)
  sentenceEl.appendChild(document.createTextNode(after))

  // Option buttons
  const grid = document.createElement('div')
  grid.style.cssText = STYLES.grid

  const buttons: HTMLButtonElement[] = options.map(target => {
    const btn = document.createElement('button')
    btn.style.cssText = STYLES.optionBase
    btn.textContent = target
    btn.addEventListener('click', () => {
      if (answered) return
      answered = true

      const correct = target === correctTarget

      // Replace blank with the correct translated word to show the full answer.
      blankSpan.textContent = correctTarget

      buttons.forEach(b => {
        if (b.textContent === correctTarget) {
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
  container.appendChild(sentenceEl)
  container.appendChild(grid)
}
