import type { LexiconEntry } from '../types/index.js'
import { WordLifecycleState } from '../types/index.js'

interface Stats {
  unknownWords: number
  totalLearning: number
}

function computeStats(lexicon: Record<string, LexiconEntry>): Stats {
  let unknownWords = 0
  let totalLearning = 0

  for (const entry of Object.values(lexicon)) {
    if (entry.selfMarkedUnknown) {
      unknownWords++
    }

    if (
      !entry.selfMarkedKnown &&
      entry.lifecycleState !== WordLifecycleState.Unseen &&
      entry.lifecycleState !== WordLifecycleState.Graduated
    ) {
      totalLearning++
    }
  }

  return {
    unknownWords,
    totalLearning,
  }
}

// Handle returned to the popup so a later action (mark-known, practice) can update
// a live count without rebuilding the whole panel.
export interface StatsPanelHandle {
  setReplacedThisSession(count: number): void
  setSavedUnknown(count: number): void
}

export function renderStatsPanel(
  container: HTMLElement,
  lexicon: Record<string, LexiconEntry>,
): StatsPanelHandle {
  const stats = computeStats(lexicon)

  const section = document.createElement('div')
  section.className = 'section'

  const title = document.createElement('div')
  title.className = 'section-title'
  title.textContent = 'Session'
  section.appendChild(title)

  const rows: [string, string | number][] = [
    // The active-tab query updates this asynchronously; zero is the safe
    // no-script/timeout/version-skew fallback.
    ['Replaced this session', 0],
    ['Saved unknown', stats.unknownWords],
    ['In learning queue', stats.totalLearning],
  ]

  // Captured so live popup data can update either value without rebuilding the panel.
  let replacedThisSessionValue: HTMLSpanElement | null = null
  let savedUnknownValue: HTMLSpanElement | null = null

  for (const [label, value] of rows) {
    const row = document.createElement('div')
    row.className = 'stat-row'

    const lbl = document.createElement('span')
    lbl.textContent = label

    const val = document.createElement('span')
    val.className = 'stat-value'
    val.textContent = String(value)
    if (label === 'Replaced this session') replacedThisSessionValue = val
    if (label === 'Saved unknown') savedUnknownValue = val

    row.appendChild(lbl)
    row.appendChild(val)
    section.appendChild(row)
  }

  container.appendChild(section)

  return {
    setReplacedThisSession(count: number): void {
      if (replacedThisSessionValue) replacedThisSessionValue.textContent = String(count)
    },
    setSavedUnknown(count: number): void {
      if (savedUnknownValue) savedUnknownValue.textContent = String(count)
    },
  }
}
