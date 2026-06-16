/**
 * PracticePanel.ts — In-popup practice over saved-unknown words, stalest first.
 *
 * Opened from the Unknown Words card. Quizzes ONLY words the user saved as unknown,
 * ordered by orderUnknownByStaleness so the longest-untouched words come first, and
 * filtered to those with a usable Spanish target (no blank/unanswerable cards). Each
 * answer runs applyQuizResult (which stamps lastReviewedAt, advancing staleness) and
 * is persisted through the clobber-safe merge-write.
 *
 * Reuses MeaningRecall (Spanish → pick the English meaning) — the same recall
 * direction as the chips. The in-memory lexicon store is the source of truth (loaded
 * once at popup init and kept current by mutations), so the panel does NOT re-read
 * storage, which would drop pending changes.
 */

import { getLexiconForStorage, getEntry, flushLexiconMerge } from '../store/lexiconStore.js'
import { applyQuizResult } from '../engine/wordLifecycle.js'
import { orderUnknownByStaleness } from '../engine/reviewQueue.js'
import { loadLanguagePack, lookup } from '../language/loader.js'
import { renderMeaningRecall } from '../quiz/MeaningRecall.js'

// Cap one practice run so a long backlog doesn't become an endless session.
const MAX_BATCH = 10

export interface PracticePanelOptions {
  onClose: () => void
}

// Count of saved-unknown words that can actually be practiced (have a usable target).
// Drives the "Practice (N)" button label and disabled state.
export function countPracticeable(): number {
  const lexicon = getLexiconForStorage()
  return orderUnknownByStaleness(lexicon).filter(lemma => Boolean(lookup(lemma)?.target)).length
}

export async function openPracticePanel(host: HTMLElement, options: PracticePanelOptions): Promise<void> {
  // Pack is normally already loaded by the list render; this is a defensive no-op.
  try {
    await loadLanguagePack('es')
  } catch {
    // If the pack can't load, the queue below is empty and we show the empty state.
  }

  const queue = orderUnknownByStaleness(getLexiconForStorage())
    .filter(lemma => Boolean(lookup(lemma)?.target))
    .slice(0, MAX_BATCH)

  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null

  const panel = document.createElement('div')
  panel.className = 'practice-panel'

  const header = document.createElement('div')
  header.className = 'practice-header'

  const label = document.createElement('span')
  label.className = 'practice-label'
  label.textContent = 'Practice'

  const progress = document.createElement('span')
  progress.className = 'practice-progress'

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'practice-close'
  closeBtn.setAttribute('aria-label', 'Close practice')
  const closeGlyph = document.createElement('span')
  closeGlyph.setAttribute('aria-hidden', 'true')
  closeGlyph.textContent = '×'
  closeBtn.appendChild(closeGlyph)

  header.appendChild(label)
  header.appendChild(progress)
  header.appendChild(closeBtn)

  const content = document.createElement('div')
  content.className = 'practice-content'

  // Screen-reader feedback — MeaningRecall gives only a brief colour cue otherwise.
  const status = document.createElement('div')
  status.className = 'practice-status'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')

  panel.appendChild(header)
  panel.appendChild(content)
  panel.appendChild(status)
  host.appendChild(panel)

  function close(): void {
    panel.remove()
    document.removeEventListener('keydown', onKeydown)
    options.onClose()
    opener?.focus?.()
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
    }
  }
  document.addEventListener('keydown', onKeydown)
  closeBtn.addEventListener('click', close)

  if (queue.length === 0) {
    progress.textContent = ''
    const empty = document.createElement('p')
    empty.className = 'practice-empty'
    empty.textContent = 'No words to practice yet — save some unknown words first.'
    content.appendChild(empty)
    closeBtn.focus()
    return
  }

  let index = 0

  function showDone(): void {
    progress.textContent = ''
    status.textContent = ''
    while (content.firstChild) content.removeChild(content.firstChild)
    const done = document.createElement('p')
    done.className = 'practice-empty'
    done.textContent = `Done — reviewed ${index} word${index === 1 ? '' : 's'}.`
    content.appendChild(done)
    closeBtn.focus()
  }

  function showNext(): void {
    if (index >= queue.length) {
      showDone()
      return
    }

    const lemma = queue[index]
    index++

    // A word marked known in another tab since the queue was built must be skipped,
    // not resurrected.
    const entry = getEntry(lemma)
    const target = lookup(lemma)?.target ?? ''
    if (!entry.selfMarkedUnknown || !target) {
      showNext()
      return
    }

    progress.textContent = `${index} of ${queue.length}`
    while (content.firstChild) content.removeChild(content.firstChild)

    renderMeaningRecall(content, {
      englishLemma: lemma,
      targetWord: target,
      onResult: (correct) => {
        applyQuizResult(lemma, correct)
        void flushLexiconMerge()
        status.textContent = correct ? 'Correct.' : `Incorrect — “${target}” means “${lemma}”.`
        showNext()
      },
    })

    // Move focus into the freshly-rendered question for keyboard play.
    content.querySelector('button')?.focus()
  }

  showNext()
}
