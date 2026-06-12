import type { LexiconEntry } from '../types/index.js'
import { WordLifecycleState } from '../types/index.js'

interface SessionStore {
  wordsSeen?: Array<{ englishLemma: string }>
}

interface Stats {
  replacedThisSession: number
  unknownWords: number
  totalLearning: number
}

function computeStats(
  lexicon: Record<string, LexiconEntry>,
  session: SessionStore,
): Stats {
  const seenLemmas = new Set((session.wordsSeen ?? []).map(w => w.englishLemma))

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
    replacedThisSession: seenLemmas.size,
    unknownWords,
    totalLearning,
  }
}

export function renderStatsPanel(
  container: HTMLElement,
  lexicon: Record<string, LexiconEntry>,
  session: SessionStore,
): void {
  const stats = computeStats(lexicon, session)

  const section = document.createElement('div')
  section.className = 'section'

  const title = document.createElement('div')
  title.className = 'section-title'
  title.textContent = 'Session'
  section.appendChild(title)

  const rows: [string, string | number][] = [
    ['Replaced this session', stats.replacedThisSession],
    ['Saved unknown', stats.unknownWords],
    ['In learning queue', stats.totalLearning],
  ]

  for (const [label, value] of rows) {
    const row = document.createElement('div')
    row.className = 'stat-row'

    const lbl = document.createElement('span')
    lbl.textContent = label

    const val = document.createElement('span')
    val.className = 'stat-value'
    val.textContent = String(value)

    row.appendChild(lbl)
    row.appendChild(val)
    section.appendChild(row)
  }

  container.appendChild(section)
}
