import { completeOnboarding, getLevelDensity } from '../store/settingsStore.js'
import { prepopulate } from '../store/lexiconStore.js'
import { getTopNLemmas } from '../language/loader.js'
import type { OnboardingLevel } from '../types/index.js'
import { showCalibrationQuiz } from './CalibrationQuiz.js'

// Number of top-frequency lemmas to pre-populate per level.
// Pre-population seeds the lexicon with assumed prior exposure so the
// word selector depresses novelty scores for common words the user likely knows.
const PREPOPULATE_COUNT: Record<OnboardingLevel, number> = {
  beginner:     300,
  intermediate: 1500,
  advanced:     3000,
}

// Inject the level picker overlay into the current page and resolve once
// the user has completed onboarding (level chosen + calibration quiz done).
export function showLevelPicker(): Promise<void> {
  return new Promise(resolve => {
    const overlay = buildOverlay(resolve)
    document.body.appendChild(overlay)
  })
}

function buildOverlay(onDone: () => void): HTMLDivElement {
  const overlay = document.createElement('div')
  overlay.id = 'contexto-onboarding'
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
    'max-width: 440px',
    'width: 90%',
    'box-shadow: 0 8px 32px rgba(0,0,0,0.25)',
    'text-align: center',
  ].join('; '))

  const title = document.createElement('h2')
  title.textContent = 'Welcome to Contexto'
  title.setAttribute('style', 'margin: 0 0 8px; font-size: 1.4rem; color: #1a1a2e;')

  const subtitle = document.createElement('p')
  subtitle.textContent = 'Choose your starting level. Contexto will replace English words with Spanish as you browse.'
  subtitle.setAttribute('style', 'margin: 0 0 24px; font-size: 0.95rem; color: #555; line-height: 1.5;')

  const levels: OnboardingLevel[] = ['beginner', 'intermediate', 'advanced']
  const levelLabels: Record<OnboardingLevel, string> = {
    beginner:     'Beginner — ~300 common words',
    intermediate: 'Intermediate — ~1 500 words',
    advanced:     'Advanced — ~3 000 words',
  }

  const buttonGroup = document.createElement('div')
  buttonGroup.setAttribute('style', 'display: flex; flex-direction: column; gap: 10px;')

  for (const level of levels) {
    const density = Math.round(getLevelDensity(level) * 100)
    const btn = document.createElement('button')
    btn.textContent = `${levelLabels[level]}  (${density}% replacement density)`
    btn.setAttribute('style', [
      'padding: 12px 16px',
      'border: 2px solid #7a9cc8',
      'border-radius: 8px',
      'background: #f4f8ff',
      'color: #1a1a2e',
      'font-size: 0.95rem',
      'cursor: pointer',
      'transition: background 0.15s',
    ].join('; '))

    btn.addEventListener('mouseenter', () => {
      btn.style.background = '#ddeeff'
    })
    btn.addEventListener('mouseleave', () => {
      btn.style.background = '#f4f8ff'
    })

    btn.addEventListener('click', () => {
      overlay.remove()
      handleLevelChosen(level, onDone)
    })

    buttonGroup.appendChild(btn)
  }

  card.appendChild(title)
  card.appendChild(subtitle)
  card.appendChild(buttonGroup)
  overlay.appendChild(card)

  return overlay
}

async function handleLevelChosen(level: OnboardingLevel, onDone: () => void): Promise<void> {
  // Pre-populate the lexicon with top-N lemmas before saving onboarding state,
  // so the word selector has depressed novelty scores from the very first page.
  const lemmas = getTopNLemmas(PREPOPULATE_COUNT[level])
  prepopulate(lemmas)

  await completeOnboarding(level)

  // Show the calibration quiz to let the user fine-tune the pre-population.
  await showCalibrationQuiz()

  onDone()
}
