/**
 * ReverseRecall.ts — Quiz format: English word → correct target-language form.
 *
 * Presents the English lemma and asks the user to identify the correct translated
 * word from four options. Used when a word has been seen multiple times this
 * session but no sentence context exists for it.
 *
 * Options are target-language base values (plain word, no article) so all four choices
 * are grammatically comparable. Distractors are drawn from session words first,
 * falling back to random dictionary samples.
 *
 * Calls onResult(correct) after a 900ms feedback delay.
 */

import { getWordsSeen } from '../store/sessionStore.js'
import { lookup, sampleLemmas } from '../language/loader.js'

const FEEDBACK_DELAY_MS = 900
const DISTRACTOR_COUNT  = 3

// ---------------------------------------------------------------------------
// Distractor building
// ---------------------------------------------------------------------------

/**
 * Resolve an English lemma to its target-language string, or null if the pack
 * entry is missing or has no `de` field (e.g. polysemous entries — shouldn't
 * appear in the session pool, but guard defensively).
 */
function targetFor(lemma: string): string | null {
  const entry = lookup(lemma)
  return entry?.target ?? null
}

/**
 * Build four shuffled target-language option strings: the correct answer plus
 * three distractors.
 *
 * Returns the options array and the correct target string.
 */
function buildOptions(englishLemma: string): { options: string[]; correctTarget: string } | null {
  const correctTarget = targetFor(englishLemma)
  // If the correct word somehow has no target form, we can't render this quiz.
  if (correctTarget === null) return null

  // Collect target forms of other session words, skipping duplicates.
  const sessionPool = getWordsSeen()
  const seenTargets = new Set<string>([correctTarget])
  const distractorPool: string[] = []

  for (const w of sessionPool) {
    if (w.englishLemma === englishLemma) continue
    const target = targetFor(w.englishLemma)
    if (target === null || seenTargets.has(target)) continue
    seenTargets.add(target)
    distractorPool.push(target)
  }

  let distractors = distractorPool.slice(0, DISTRACTOR_COUNT)

  // Pad from the dictionary when the session pool doesn't have enough variety.
  if (distractors.length < DISTRACTOR_COUNT) {
    const needed = DISTRACTOR_COUNT - distractors.length
    // Exclude by English lemma so sampleLemmas' dedup logic works correctly;
    const excludeLemmas = new Set([englishLemma])
    const fallbackLemmas = sampleLemmas(needed, excludeLemmas)
    for (const lemma of fallbackLemmas) {
      const target = targetFor(lemma)
      if (target === null || seenTargets.has(target)) continue
      seenTargets.add(target)
      distractors.push(target)
    }
  }

  // Shuffle all four options.
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
    margin-bottom: 6px;
    font-family: system-ui, sans-serif;
  `,
  englishWord: `
    font-size: 22px;
    font-weight: 700;
    color: #1a1a1a;
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

export interface ReverseRecallProps {
  englishLemma: string  // shown to the user
  targetWord: string    // the displayed form from the page (may include article) —
                        // used only as a hint to QuizBanner for format selection;
                        // the correct option is the plain `de` value from the dictionary
  onResult: (correct: boolean) => void
  onCannotRender: () => void  // called if the dictionary entry is missing
}

/**
 * Render a ReverseRecall quiz into `container`.
 * Calls onCannotRender() if the word cannot be resolved to a target string
 * (e.g. data race during dictionary load — QuizBanner falls back to MeaningRecall).
 */
export function renderReverseRecall(
  container: HTMLElement,
  { englishLemma, onResult, onCannotRender }: ReverseRecallProps,
): void {
  const built = buildOptions(englishLemma)
  if (built === null) {
    onCannotRender()
    return
  }

  const { options, correctTarget } = built
  let answered = false

  // Prompt
  const prompt = document.createElement('p')
  prompt.style.cssText = STYLES.prompt
  prompt.textContent = 'What is the Spanish translation for...'

  // English word
  const word = document.createElement('p')
  word.style.cssText = STYLES.englishWord
  word.textContent = englishLemma

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
  container.appendChild(word)
  container.appendChild(grid)
}
