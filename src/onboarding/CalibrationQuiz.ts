import { getTopNLemmas, lookup } from '../language/loader.js'
import { markKnown, prepopulate } from '../store/lexiconStore.js'
import { getDensity, getLevelDensity, completeOnboarding } from '../store/settingsStore.js'
import type { OnboardingLevel, TranslationEntry } from '../types/index.js'

const QUIZ_WORD_COUNT = 10
const SAMPLE_POOL_SIZE = 3000
const DISTRACTOR_POOL_SIZE = 3000
const OPTIONS_PER_QUESTION = 4
// Score below this threshold triggers an automatic level drop.
const PASS_THRESHOLD = 5

const PREPOPULATE_COUNT: Record<OnboardingLevel, number> = {
  beginner:     300,
  intermediate: 1500,
  advanced:     3000,
}

const LEVEL_LABELS: Record<OnboardingLevel, string> = {
  beginner:     'Beginner',
  intermediate: 'Intermediate',
  advanced:     'Advanced',
}

const LEVEL_DROP: Partial<Record<OnboardingLevel, OnboardingLevel>> = {
  advanced:     'intermediate',
  intermediate: 'beginner',
  // beginner has no lower level — no drop applied
}

interface QuizQuestion {
  englishLemma: string  // correct answer
  targetWord:   string  // shown to user
  wordType:     string  // 'noun' | 'adverb' | 'expression'
  options:      string[] // 4 English lemmas, shuffled
  correctIndex: number
}

// ---------- Level inference ----------

// Infer the current OnboardingLevel from the stored density value.
// This avoids needing a separate getLevel() export from settingsStore.
function inferCurrentLevel(): OnboardingLevel | null {
  const density = getDensity()
  for (const level of ['beginner', 'intermediate', 'advanced'] as OnboardingLevel[]) {
    if (Math.abs(density - getLevelDensity(level)) < 0.001) return level
  }
  return null
}

// ---------- Question building ----------

// Build a pool of English lemmas keyed by their word type for distractor sampling.
// Pre-computed once per quiz to avoid repeated full-pool scans.
function buildDistractorPoolByType(): Map<string, string[]> {
  const pool = getTopNLemmas(DISTRACTOR_POOL_SIZE)
  const byType = new Map<string, string[]>()

  for (const lemma of pool) {
    const entry = lookup(lemma)
    if (!entry) continue
    const type = entry.partOfSpeech
    const list = byType.get(type) ?? []
    list.push(lemma)
    byType.set(type, list)
  }

  return byType
}

// Pick 3 distractor lemmas of the same word type as `exclude`.
// Falls back to any available lemmas if the same-type pool is too small.
function pickDistractors(
  exclude: string,
  wordType: string,
  byType: Map<string, string[]>,
): string[] {
  let candidates = (byType.get(wordType) ?? []).filter(l => l !== exclude)

  // Fallback: merge all types if same-type pool is insufficient
  if (candidates.length < OPTIONS_PER_QUESTION - 1) {
    const all: string[] = []
    for (const [, lemmas] of byType) all.push(...lemmas)
    candidates = all.filter(l => l !== exclude)
  }

  // Shuffle and take 3
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
  }

  return candidates.slice(0, OPTIONS_PER_QUESTION - 1)
}

// Sample QUIZ_WORD_COUNT lemmas evenly distributed across the top SAMPLE_POOL_SIZE
// by frequency rank, ensuring each has a valid target-language translation.
function buildQuizQuestions(): QuizQuestion[] {
  const pool = getTopNLemmas(SAMPLE_POOL_SIZE)
  if (pool.length === 0) return []

  const byType = buildDistractorPoolByType()
  const step = Math.floor(pool.length / QUIZ_WORD_COUNT)
  const questions: QuizQuestion[] = []

  for (let i = 0; i < QUIZ_WORD_COUNT && questions.length < QUIZ_WORD_COUNT; i++) {
    const lemma = pool[i * step]
    if (!lemma) continue

    const entry = lookup(lemma) as TranslationEntry | null
    if (!entry?.target) continue

    const distractors = pickDistractors(lemma, entry.partOfSpeech, byType)
    if (distractors.length < OPTIONS_PER_QUESTION - 1) continue

    // Shuffle [correct, ...distractors] and record the correct position
    const options = [lemma, ...distractors]
    for (let j = options.length - 1; j > 0; j--) {
      const k = Math.floor(Math.random() * (j + 1))
      ;[options[j], options[k]] = [options[k], options[j]]
    }

    questions.push({
      englishLemma: lemma,
      targetWord:   entry.target,
      wordType:     entry.partOfSpeech,
      options,
      correctIndex: options.indexOf(lemma),
    })
  }

  return questions
}

// ---------- Main export ----------

export function showCalibrationQuiz(): Promise<void> {
  return new Promise(resolve => {
    const questions = buildQuizQuestions()

    const overlay = document.createElement('div')
    overlay.id = 'contexto-calibration'
    overlay.setAttribute('style', [
      'position: fixed',
      'inset: 0',
      'z-index: 2147483646',
      'background: rgba(0,0,0,0.55)',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'font-family: system-ui, sans-serif',
    ].join('; '))

    const card = document.createElement('div')
    card.setAttribute('style', [
      'background: #fff',
      'border-radius: 12px',
      'padding: 32px 36px',
      'max-width: 460px',
      'width: 90%',
      'box-shadow: 0 8px 32px rgba(0,0,0,0.25)',
    ].join('; '))

    overlay.appendChild(card)
    document.body.appendChild(overlay)

    runQuestion(card, overlay, questions, 0, 0, resolve)
  })
}

// ---------- Question renderer ----------

function runQuestion(
  card: HTMLDivElement,
  overlay: HTMLDivElement,
  questions: QuizQuestion[],
  index: number,
  score: number,
  onDone: () => void,
): void {
  if (index >= questions.length) {
    showSummary(card, overlay, score, questions.length, onDone)
    return
  }

  const q = questions[index]
  card.innerHTML = ''

  // Progress indicator
  const progress = document.createElement('p')
  progress.textContent = `Question ${index + 1} of ${questions.length}`
  progress.setAttribute('style', 'margin: 0 0 16px; font-size: 0.85rem; color: #888; text-align: right;')

  // Prompt
  const prompt = document.createElement('p')
  prompt.textContent = 'What does this Spanish word mean?'
  prompt.setAttribute('style', 'margin: 0 0 12px; font-size: 0.9rem; color: #555;')

  // Target-language word
  const target = document.createElement('div')
  target.textContent = q.targetWord
  target.setAttribute('style', [
    'font-size: 2rem',
    'font-weight: 700',
    'color: #1a1a2e',
    'text-align: center',
    'margin: 0 0 28px',
    'letter-spacing: 0.02em',
  ].join('; '))

  // Options
  const optionGroup = document.createElement('div')
  optionGroup.setAttribute('style', 'display: flex; flex-direction: column; gap: 10px;')

  const buttons: HTMLButtonElement[] = q.options.map((lemma, i) => {
    const btn = document.createElement('button')
    btn.textContent = lemma
    btn.setAttribute('style', [
      'padding: 11px 16px',
      'border: 2px solid #d0d8e4',
      'border-radius: 8px',
      'background: #f7f9fc',
      'color: #1a1a2e',
      'font-size: 0.95rem',
      'text-align: left',
      'cursor: pointer',
      'transition: background 0.1s, border-color 0.1s',
    ].join('; '))

    btn.addEventListener('mouseenter', () => {
      if (!btn.disabled) {
        btn.style.background = '#eaf0fb'
        btn.style.borderColor = '#7a9cc8'
      }
    })
    btn.addEventListener('mouseleave', () => {
      if (!btn.disabled) {
        btn.style.background = '#f7f9fc'
        btn.style.borderColor = '#d0d8e4'
      }
    })

    btn.addEventListener('click', () => {
      // Disable all buttons immediately to prevent double-clicks
      buttons.forEach(b => { b.disabled = true; b.style.cursor = 'default' })

      const correct = i === q.correctIndex
      if (correct) {
        btn.style.background = '#d4edda'
        btn.style.borderColor = '#28a745'
        btn.style.color = '#155724'
        markKnown(q.englishLemma, true)
      } else {
        btn.style.background = '#f8d7da'
        btn.style.borderColor = '#dc3545'
        btn.style.color = '#721c24'
        // Also highlight the correct answer in green
        buttons[q.correctIndex].style.background = '#d4edda'
        buttons[q.correctIndex].style.borderColor = '#28a745'
        buttons[q.correctIndex].style.color = '#155724'
        // Incorrect — word stays unseen (no markKnown call needed; default state is unseen)
      }

      const nextScore = score + (correct ? 1 : 0)
      // Auto-advance to next question after a brief pause so the user can see the feedback
      setTimeout(() => {
        runQuestion(card, overlay, questions, index + 1, nextScore, onDone)
      }, 900)
    })

    optionGroup.appendChild(btn)
    return btn
  })

  card.appendChild(progress)
  card.appendChild(prompt)
  card.appendChild(target)
  card.appendChild(optionGroup)
}

// ---------- Summary screen ----------

function showSummary(
  card: HTMLDivElement,
  overlay: HTMLDivElement,
  score: number,
  total: number,
  onDone: () => void,
): void {
  const currentLevel = inferCurrentLevel()
  const droppedLevel = (score < PASS_THRESHOLD && currentLevel)
    ? LEVEL_DROP[currentLevel] ?? null
    : null

  card.innerHTML = ''
  card.setAttribute('style', card.getAttribute('style') + '; text-align: center;')

  const icon = document.createElement('div')
  icon.textContent = score >= PASS_THRESHOLD ? '✓' : '↓'
  icon.setAttribute('style', [
    'font-size: 2.5rem',
    'margin-bottom: 12px',
    `color: ${score >= PASS_THRESHOLD ? '#28a745' : '#e67e22'}`,
  ].join('; '))

  const headline = document.createElement('h2')
  headline.textContent = `You knew ${score} of ${total} words`
  headline.setAttribute('style', 'margin: 0 0 12px; font-size: 1.4rem; color: #1a1a2e;')

  const detail = document.createElement('p')
  detail.setAttribute('style', 'margin: 0 0 28px; font-size: 0.95rem; color: #555; line-height: 1.5;')

  if (droppedLevel) {
    detail.textContent =
      `We've adjusted your level to ${LEVEL_LABELS[droppedLevel]} so replacements start at a comfortable pace.`
  } else if (score >= PASS_THRESHOLD) {
    detail.textContent = 'Great — Contexto will skip words you already know and focus on new ones.'
  } else {
    // currentLevel is beginner and score < 5 — no lower level to drop to
    detail.textContent = 'No worries — Contexto will start with the most common words.'
  }

  const continueBtn = document.createElement('button')
  continueBtn.textContent = 'Start reading'
  continueBtn.setAttribute('style', [
    'padding: 12px 32px',
    'background: #1a1a2e',
    'color: #fff',
    'border: none',
    'border-radius: 8px',
    'font-size: 1rem',
    'cursor: pointer',
  ].join('; '))

  continueBtn.addEventListener('click', () => {
    overlay.remove()
    if (droppedLevel) {
      // Apply the level drop: re-save settings and re-populate the lexicon.
      // completeOnboarding is async but we fire-and-forget — the lexicon update
      // (prepopulate) is synchronous and takes effect immediately for this page.
      const lemmas = getTopNLemmas(PREPOPULATE_COUNT[droppedLevel])
      prepopulate(lemmas)
      void completeOnboarding(droppedLevel)
    }
    onDone()
  })

  card.appendChild(icon)
  card.appendChild(headline)
  card.appendChild(detail)
  card.appendChild(continueBtn)
}
