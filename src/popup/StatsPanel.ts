import type { LexiconEntry } from '../types/index.js'
import { WordLifecycleState } from '../types/index.js'

interface SessionStore {
  wordsSeen?: Array<{ englishLemma: string }>
}

interface Stats {
  replacedThisSession: number
  knownWords: number
  totalLearning: number
}

function computeStats(
  lexicon: Record<string, LexiconEntry>,
  session: SessionStore,
): Stats {
  const seenLemmas = new Set((session.wordsSeen ?? []).map(w => w.englishLemma))

  let knownWords = 0
  let totalLearning = 0

  for (const entry of Object.values(lexicon)) {
    if (entry.selfMarkedKnown || entry.lifecycleState === WordLifecycleState.Graduated) {
      knownWords++
    } else if (entry.lifecycleState !== WordLifecycleState.Unseen) {
      totalLearning++
    }
  }

  return {
    replacedThisSession: seenLemmas.size,
    knownWords,
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
    ['Known / graduated', stats.knownWords],
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
