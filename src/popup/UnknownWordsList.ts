import { loadLanguagePack, lookup } from '../language/loader.js'
import { openPracticePanel, countPracticeable } from './PracticePanel.js'
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

// Persistence + cross-section callbacks owned by the popup entry (index.ts), which
// holds the lexicon store. Keeps this module DOM-only — it never touches storage.
export interface UnknownWordsListHandlers {
  // Soft-remove: drop the word from the review list without permanently excluding it
  // from replacement (clears selfMarkedUnknown only).
  onMarkKnown: (lemma: string) => void | Promise<void>
  // Undo a soft-remove, restoring the word's ORIGINAL save time so it returns to its
  // previous list position rather than jumping to the top.
  onRestore: (lemma: string, markedAt: number) => void | Promise<void>
  // Notify the popup that the saved-unknown total changed (updates the stats panel).
  onUnknownTotalChange: (total: number) => void
}

// How long the "Marked known · Undo" affordance stays before auto-dismissing. The
// Undo control is a real focusable button, so this timeout is convenience, not the
// only way to undo.
const UNDO_VISIBLE_MS = 6000

export async function renderUnknownWordsList(
  container: HTMLElement,
  lexicon: Record<string, LexiconEntry>,
  sessionLemmas: ReadonlySet<string>,
  handlers: UnknownWordsListHandlers,
): Promise<void> {
  // The pack is only needed to enrich exports with the Spanish target/gloss; a
  // load failure must not blank the user's saved-words list or the popup.
  try {
    await loadLanguagePack('es')
  } catch (err) {
    console.warn('[Contexto] Language pack unavailable in popup; showing saved words without Spanish enrichment:', err)
  }

  // Mutable model — mark-known removes from here; Undo re-inserts.
  let allUnknown = collectUnknownWords(lexicon)
  let currentFilter: Filter = 'all'

  function wordsForFilter(): UnknownWord[] {
    return currentFilter === 'session'
      ? allUnknown.filter(word => sessionLemmas.has(word.lemma))
      : allUnknown
  }

  function sessionCount(): number {
    return allUnknown.filter(word => sessionLemmas.has(word.lemma)).length
  }

  const section = document.createElement('div')
  section.className = 'section'

  const title = document.createElement('div')
  title.className = 'section-title'
  title.textContent = 'Unknown Words'
  section.appendChild(title)

  const filterBar = document.createElement('div')
  filterBar.className = 'word-filter'

  const allBtn = document.createElement('button')
  allBtn.type = 'button'
  allBtn.className = 'filter-btn active'

  const sessionBtn = document.createElement('button')
  sessionBtn.type = 'button'
  sessionBtn.className = 'filter-btn'

  // Practice launches a staleness-ordered review over the saved-unknown words.
  // Built from .export-button (which has a :disabled rule); right-aligned in the row.
  const practiceBtn = document.createElement('button')
  practiceBtn.type = 'button'
  practiceBtn.className = 'export-button practice-launch'

  filterBar.appendChild(allBtn)
  filterBar.appendChild(sessionBtn)
  filterBar.appendChild(practiceBtn)

  // Swappable card body — hidden while the practice panel is open so the panel
  // takes over below the section title.
  const bodyWrap = document.createElement('div')
  bodyWrap.className = 'word-body'
  bodyWrap.appendChild(filterBar)
  section.appendChild(bodyWrap)

  const exportActions = document.createElement('div')
  exportActions.className = 'export-actions'

  const csvBtn = buildExportButton('CSV', () => {
    downloadText(
      exportFilename('contexto-unknown-words', 'csv'),
      'text/csv;charset=utf-8',
      buildCsv(wordsForFilter()),
    )
  })

  const quizletBtn = buildExportButton('Quizlet TSV', () => {
    downloadText(
      exportFilename('contexto-quizlet', 'tsv'),
      'text/tab-separated-values;charset=utf-8',
      buildQuizletTsv(wordsForFilter()),
    )
  })

  exportActions.appendChild(csvBtn)
  exportActions.appendChild(quizletBtn)
  bodyWrap.appendChild(exportActions)

  // Transient "Marked known · Undo" affordance (aria-live so it is announced).
  const undoBar = document.createElement('div')
  undoBar.className = 'word-undo'
  undoBar.setAttribute('role', 'status')
  undoBar.setAttribute('aria-live', 'polite')
  const undoText = document.createElement('span')
  const undoBtn = document.createElement('button')
  undoBtn.type = 'button'
  undoBtn.className = 'word-undo__btn'
  undoBtn.textContent = 'Undo'
  undoBar.appendChild(undoText)
  undoBar.appendChild(undoBtn)
  bodyWrap.appendChild(undoBar)

  let undoTimer: ReturnType<typeof setTimeout> | null = null
  // The pending optimistic-removal timer (the 140ms fade). Tracked so an Undo within
  // the fade window can cancel it instead of letting it strip the restored word out.
  let removalTimer: ReturnType<typeof setTimeout> | null = null
  let pendingUndo: UnknownWord | null = null

  function clearRemovalTimer(): void {
    if (removalTimer !== null) {
      clearTimeout(removalTimer)
      removalTimer = null
    }
  }

  function hideUndo(): void {
    undoBar.classList.remove('is-visible')
    pendingUndo = null
    if (undoTimer !== null) {
      clearTimeout(undoTimer)
      undoTimer = null
    }
  }

  function showUndo(word: UnknownWord): void {
    pendingUndo = word
    undoText.textContent = `Marked “${word.lemma}” as known. `
    undoBar.classList.add('is-visible')
    if (undoTimer !== null) clearTimeout(undoTimer)
    undoTimer = setTimeout(hideUndo, UNDO_VISIBLE_MS)
    // Marking known removes the chip (and its focus); move focus to Undo so keyboard
    // and screen-reader users can actually reach the time-limited control.
    undoBtn.focus()
  }

  undoBtn.addEventListener('click', () => {
    if (!pendingUndo) return
    const word = pendingUndo
    // Cancel any still-pending optimistic removal so it can't strip the word back out
    // after we restore it.
    clearRemovalTimer()
    hideUndo()
    // Re-add only if the removal already fired; otherwise the word is still present.
    if (!allUnknown.some(w => w.lemma === word.lemma)) {
      allUnknown = [...allUnknown, word].sort(compareUnknown)
    }
    // Persist first (the synchronous part of onRestore mutates the store) so the
    // practice count recomputed by afterModelChange sees the restored word.
    void handlers.onRestore(word.lemma, word.markedAt)
    afterModelChange()
  })

  const list = document.createElement('div')
  list.className = 'word-list'
  bodyWrap.appendChild(list)

  function handleMarkKnown(word: UnknownWord, chipEl: HTMLElement): void {
    // Optimistic fade, then drop from the model and persist the soft-remove.
    chipEl.classList.add('word-chip--leaving')
    void handlers.onMarkKnown(word.lemma)
    clearRemovalTimer()
    removalTimer = setTimeout(() => {
      removalTimer = null
      allUnknown = allUnknown.filter(w => w.lemma !== word.lemma)
      afterModelChange()
    }, 140)
    showUndo(word)
  }

  // Re-render the list, refresh the filter-count labels, and report the new total.
  function afterModelChange(): void {
    updateCounts()
    renderList()
    handlers.onUnknownTotalChange(allUnknown.length)
  }

  function updateCounts(): void {
    allBtn.textContent = `All (${allUnknown.length})`
    sessionBtn.textContent = `This session (${sessionCount()})`
    // Practiceable count comes from the store (answerable saved-unknown words), which
    // mark-known / Undo keep in sync. Disabled when there is nothing to practice or
    // the pack failed to load (every lookup misses).
    const practiceCount = countPracticeable()
    practiceBtn.textContent = `Practice (${practiceCount})`
    practiceBtn.disabled = practiceCount === 0
  }

  function renderList(): void {
    while (list.firstChild) list.removeChild(list.firstChild)

    const words = wordsForFilter()
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
      list.appendChild(buildChip(word, chipEl => handleMarkKnown(word, chipEl)))
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

  practiceBtn.addEventListener('click', () => {
    hideUndo()
    bodyWrap.style.display = 'none'
    // The card title becomes the panel's single eyebrow while practising.
    title.textContent = 'Practice'
    void openPracticePanel(section, {
      onClose: () => {
        title.textContent = 'Unknown Words'
        bodyWrap.style.display = ''
        updateCounts()
      },
    })
  })

  updateCounts()
  renderList()
  container.appendChild(section)
}

function compareUnknown(a: UnknownWord, b: UnknownWord): number {
  return b.markedAt - a.markedAt || a.lemma.localeCompare(b.lemma)
}

function collectUnknownWords(lexicon: Record<string, LexiconEntry>): UnknownWord[] {
  return Object.entries(lexicon)
    .filter(([, entry]) => entry.selfMarkedUnknown)
    .map(([lemma, entry]) => ({
      lemma,
      markedAt: entry.selfMarkedUnknownAt ?? 0,
    }))
    .sort(compareUnknown)
}

// Build one review chip. When the word resolves to a usable Spanish target the chip
// leads with the SPANISH word and reveals the English source + gloss inline on hover
// or keyboard focus (the English meaning also rides on the body's aria-label so it is
// not hover-only for screen-reader users). When there is no usable target — a missing
// or low-confidence entry, or a failed pack load — the chip falls back to showing the
// English lemma exactly as before, with no reveal.
function buildChip(word: UnknownWord, onMarkKnown: (chipEl: HTMLElement) => void): HTMLElement {
  const entry = lookup(word.lemma)
  const target = entry?.target ?? ''

  const chip = document.createElement('span')
  chip.className = 'word-chip'

  if (!target) {
    // English-only fallback: no usable Spanish to reveal, so the lemma is the chip.
    chip.classList.add('word-chip--plain')
    const plain = document.createElement('span')
    plain.className = 'word-chip__plain-text'
    plain.textContent = word.lemma
    chip.appendChild(plain)
  } else {
    const gloss = entry?.sourceGloss ?? ''
    const noun = getNounEntry(entry)

    // Focusable body: hover or Tab reveals the English meaning inline.
    const body = document.createElement('span')
    body.className = 'word-chip__body'
    body.tabIndex = 0
    body.setAttribute('aria-label', buildChipAriaLabel(word.lemma, entry, noun))

    const targetEl = document.createElement('span')
    targetEl.className = 'word-chip__target'
    targetEl.lang = 'es'
    targetEl.textContent = target
    body.appendChild(targetEl)

    // Revealed-on-hover/focus block. aria-hidden because the body's aria-label already
    // carries the same information — this avoids a duplicate screen-reader announcement.
    const reveal = document.createElement('span')
    reveal.className = 'word-chip__reveal'
    reveal.setAttribute('aria-hidden', 'true')

    const english = document.createElement('span')
    english.className = 'word-chip__english'
    english.textContent = word.lemma
    reveal.appendChild(english)

    if (gloss) {
      const glossEl = document.createElement('span')
      glossEl.className = 'word-chip__gloss'
      glossEl.textContent = gloss
      reveal.appendChild(glossEl)
    }

    body.appendChild(reveal)
    chip.appendChild(body)
  }

  // Mark-known: a separate target from the reveal body so revealing English never
  // graduates the word by accident.
  const knownBtn = document.createElement('button')
  knownBtn.type = 'button'
  knownBtn.className = 'word-chip__known'
  knownBtn.setAttribute('aria-label', `Mark ${word.lemma} as known`)
  knownBtn.title = 'Mark as known'
  const check = document.createElement('span')
  check.setAttribute('aria-hidden', 'true')
  check.textContent = '✓'
  knownBtn.appendChild(check)
  knownBtn.addEventListener('click', () => onMarkKnown(chip))
  chip.appendChild(knownBtn)

  return chip
}

// Flat, comma-joined accessible name, e.g. "perro, dog, noun, masculine, plural perros".
function buildChipAriaLabel(
  lemma: string,
  entry: TranslationEntry | null,
  noun: NounTranslationEntry | null,
): string {
  const parts = [entry?.target ?? '', lemma, entry?.partOfSpeech ?? '']
  if (noun) {
    parts.push(noun.gender)
    if (noun.plural) parts.push(`plural ${noun.plural}`)
  }
  return parts.filter(Boolean).join(', ')
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
