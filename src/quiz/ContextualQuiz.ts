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
import { getActiveLanguagePack, lookup, sampleLemmas } from '../language/loader.js'

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

  // Dedupe so the same target string can't fill two option slots (which would
  // otherwise double-mark when a distractor equals the correct answer).
  const uniqueOptions: string[] = []
  const optionSeen = new Set<string>()
  for (const option of [correctTarget, ...distractors]) {
    if (optionSeen.has(option)) continue
    optionSeen.add(option)
    uniqueOptions.push(option)
  }

  const options = uniqueOptions
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
    color: #475569;
    margin-bottom: 8px;
    font-family: system-ui, sans-serif;
  `,
  sentence: `
    font-size: 14px;
    color: #475569;
    line-height: 1.55;
    margin-bottom: 16px;
    font-family: system-ui, sans-serif;
  `,
  blank: `
    font-weight: 700;
    color: #1b2733;
    letter-spacing: 0.05em;
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
  const langName = getActiveLanguagePack()?.displayName ?? 'Spanish'
  const prompt = document.createElement('p')
  prompt.style.cssText = STYLES.prompt
  prompt.textContent = `Fill in the blank with the ${langName} translation:`

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

  // The exact button representing the correct answer, captured by identity so a
  // duplicate target string can't cause two buttons to be marked correct.
  let correctBtn: HTMLButtonElement | null = null

  const buttons: HTMLButtonElement[] = options.map(target => {
    const btn = document.createElement('button')
    btn.style.cssText = STYLES.optionBase
    btn.textContent = target
    if (target === correctTarget) correctBtn = btn
    btn.addEventListener('click', () => {
      if (answered) return
      answered = true

      const correct = btn === correctBtn

      // Replace blank with the correct translated word to show the full answer.
      blankSpan.textContent = correctTarget

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
  container.appendChild(sentenceEl)
  container.appendChild(grid)
}
