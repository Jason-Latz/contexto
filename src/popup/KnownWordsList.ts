import type { LexiconEntry } from '../types/index.js'
import { WordLifecycleState } from '../types/index.js'

type Filter = 'all' | 'session'

/**
 * Render the known words list section into `container`.
 *
 * "All" mode: all self-marked or graduated lemmas in the lexicon.
 * "Session" mode: intersection of the above with words seen this session.
 */
export function renderKnownWordsList(
  container: HTMLElement,
  lexicon: Record<string, LexiconEntry>,
  sessionLemmas: ReadonlySet<string>,
): void {
  // Collect all known/graduated lemmas from the lexicon.
  const allKnown = Object.entries(lexicon)
    .filter(([, entry]) =>
      entry.selfMarkedKnown || entry.lifecycleState === WordLifecycleState.Graduated,
    )
    .map(([lemma]) => lemma)
    .sort()

  const section = document.createElement('div')
  section.className = 'section'

  const title = document.createElement('div')
  title.className = 'section-title'
  title.textContent = 'Known Words'
  section.appendChild(title)

  // Filter bar
  const filterBar = document.createElement('div')
  filterBar.className = 'known-filter'

  const allBtn = document.createElement('button')
  allBtn.className = 'filter-btn active'
  allBtn.textContent = `All (${allKnown.length})`

  const sessionKnown = allKnown.filter(l => sessionLemmas.has(l))
  const sessionBtn = document.createElement('button')
  sessionBtn.className = 'filter-btn'
  sessionBtn.textContent = `This session (${sessionKnown.length})`

  filterBar.appendChild(allBtn)
  filterBar.appendChild(sessionBtn)
  section.appendChild(filterBar)

  // Word chip list
  const list = document.createElement('div')
  list.className = 'known-list'
  section.appendChild(list)

  let currentFilter: Filter = 'all'

  function renderList(): void {
    while (list.firstChild) list.removeChild(list.firstChild)

    const words = currentFilter === 'session' ? sessionKnown : allKnown

    if (words.length === 0) {
      const empty = document.createElement('span')
      empty.className = 'empty-msg'
      empty.textContent = currentFilter === 'session'
        ? 'No words marked known this session.'
        : 'No known words yet — click a replaced word to mark it.'
      list.appendChild(empty)
      return
    }

    for (const lemma of words) {
      const chip = document.createElement('span')
      chip.className = 'known-chip'
      chip.textContent = lemma
      list.appendChild(chip)
    }
  }

  allBtn.addEventListener('click', () => {
    currentFilter = 'all'
    allBtn.classList.add('active')
    sessionBtn.classList.remove('active')
    renderList()
  })

  sessionBtn.addEventListener('click', () => {
    currentFilter = 'session'
    sessionBtn.classList.add('active')
    allBtn.classList.remove('active')
    renderList()
  })

  renderList()
  container.appendChild(section)
}
