import { loadLanguagePack, lookup } from '../language/loader.js'
import type { LexiconEntry, NounTranslationEntry, TranslationEntry } from '../types/index.js'

type Filter = 'all' | 'session'

interface UnknownWord {
  lemma: string
  markedAt: number
}

interface ExportRow {
  english: string
  spanish: string
  partOfSpeech: string
  gloss: string
  gender: string
  plural: string
  addedAt: string
}

export async function renderUnknownWordsList(
  container: HTMLElement,
  lexicon: Record<string, LexiconEntry>,
  sessionLemmas: ReadonlySet<string>,
): Promise<void> {
  await loadLanguagePack('es')

  const allUnknown = collectUnknownWords(lexicon)
  const sessionUnknown = allUnknown.filter(word => sessionLemmas.has(word.lemma))

  const section = document.createElement('div')
  section.className = 'section'

  const title = document.createElement('div')
  title.className = 'section-title'
  title.textContent = 'Unknown Words'
  section.appendChild(title)

  const filterBar = document.createElement('div')
  filterBar.className = 'word-filter'

  const allBtn = document.createElement('button')
  allBtn.className = 'filter-btn active'
  allBtn.textContent = `All (${allUnknown.length})`

  const sessionBtn = document.createElement('button')
  sessionBtn.className = 'filter-btn'
  sessionBtn.textContent = `This session (${sessionUnknown.length})`

  filterBar.appendChild(allBtn)
  filterBar.appendChild(sessionBtn)
  section.appendChild(filterBar)

  const exportActions = document.createElement('div')
  exportActions.className = 'export-actions'

  const csvBtn = buildExportButton('CSV', () => {
    const words = currentFilter === 'session' ? sessionUnknown : allUnknown
    downloadText(
      exportFilename('contexto-unknown-words', 'csv'),
      'text/csv;charset=utf-8',
      buildCsv(words),
    )
  })

  const quizletBtn = buildExportButton('Quizlet TSV', () => {
    const words = currentFilter === 'session' ? sessionUnknown : allUnknown
    downloadText(
      exportFilename('contexto-quizlet', 'tsv'),
      'text/tab-separated-values;charset=utf-8',
      buildQuizletTsv(words),
    )
  })

  exportActions.appendChild(csvBtn)
  exportActions.appendChild(quizletBtn)
  section.appendChild(exportActions)

  const list = document.createElement('div')
  list.className = 'word-list'
  section.appendChild(list)

  let currentFilter: Filter = 'all'

  function renderList(): void {
    while (list.firstChild) list.removeChild(list.firstChild)

    const words = currentFilter === 'session' ? sessionUnknown : allUnknown
    const hasWords = words.length > 0
    csvBtn.disabled = !hasWords
    quizletBtn.disabled = !hasWords

    if (!hasWords) {
      const empty = document.createElement('span')
      empty.className = 'empty-msg'
      empty.textContent = currentFilter === 'session'
        ? 'No unknown words saved this session.'
        : 'No unknown words saved yet.'
      list.appendChild(empty)
      return
    }

    for (const word of words) {
      const chip = document.createElement('span')
      chip.className = 'word-chip'
      chip.textContent = word.lemma
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

function collectUnknownWords(lexicon: Record<string, LexiconEntry>): UnknownWord[] {
  return Object.entries(lexicon)
    .filter(([, entry]) => entry.selfMarkedUnknown)
    .map(([lemma, entry]) => ({
      lemma,
      markedAt: entry.selfMarkedUnknownAt ?? 0,
    }))
    .sort((a, b) => b.markedAt - a.markedAt || a.lemma.localeCompare(b.lemma))
}

function buildExportButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'export-button'
  button.textContent = label
  button.addEventListener('click', onClick)
  return button
}

function toExportRows(words: readonly UnknownWord[]): ExportRow[] {
  return words.map(word => {
    const entry = lookup(word.lemma)
    const noun = getNounEntry(entry)

    return {
      english: word.lemma,
      spanish: entry?.target ?? '',
      partOfSpeech: entry?.partOfSpeech ?? '',
      gloss: entry?.sourceGloss ?? '',
      gender: noun?.gender ?? '',
      plural: noun?.plural ?? '',
      addedAt: word.markedAt ? new Date(word.markedAt).toISOString() : '',
    }
  })
}

function getNounEntry(entry: TranslationEntry | null): NounTranslationEntry | null {
  return entry?.partOfSpeech === 'noun' ? entry : null
}

function buildCsv(words: readonly UnknownWord[]): string {
  const rows = toExportRows(words)
  const header = ['English', 'Spanish', 'Part of speech', 'Gloss', 'Gender', 'Plural', 'Added at']
  return [
    header.map(escapeCsvCell).join(','),
    ...rows.map(row => [
      row.english,
      row.spanish,
      row.partOfSpeech,
      row.gloss,
      row.gender,
      row.plural,
      row.addedAt,
    ].map(escapeCsvCell).join(',')),
  ].join('\n')
}

function buildQuizletTsv(words: readonly UnknownWord[]): string {
  return toExportRows(words)
    .map(row => {
      const definition = row.gloss ? `${row.english} - ${row.gloss}` : row.english
      return [row.spanish || row.english, definition].map(escapeTsvCell).join('\t')
    })
    .join('\n')
}

function escapeCsvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function escapeTsvCell(value: string): string {
  return value.replace(/\t/g, ' ').replace(/\r?\n/g, ' ')
}

function exportFilename(base: string, extension: string): string {
  const stamp = new Date().toISOString().slice(0, 10)
  return `${base}-${stamp}.${extension}`
}

function downloadText(filename: string, mimeType: string, content: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
