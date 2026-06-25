/**
 * PracticePanel.ts — In-popup practice over saved-unknown words, stalest first.
 *
 * Opened from the Unknown Words card. Quizzes ONLY words the user saved as unknown,
 * ordered by orderUnknownByStaleness so the longest-untouched words come first, and
 * filtered to those with a usable target (no blank/unanswerable cards). Each answer
 * runs applyQuizResult (which stamps lastReviewedAt, advancing staleness) and is
 * persisted through the clobber-safe merge-write.
 *
 * Flashcard format: show the target word, reveal the English meaning + gloss on
 * demand, then the user self-grades know / don't-know (which maps to a correct /
 * incorrect SM-2 result). The in-memory lexicon store is the source of truth (loaded
 * once at popup init and kept current by mutations), so the panel does NOT re-read
 * storage, which would drop pending changes.
 */

import { getLexiconForStorage, getEntry, flushLexiconMerge } from '../store/lexiconStore.js'
import { applyQuizResult } from '../engine/wordLifecycle.js'
import { orderUnknownByStaleness } from '../engine/reviewQueue.js'
import { loadLanguagePack, lookup } from '../language/loader.js'
import { getLanguageInfo } from '../language/registry.js'
import type { TargetLanguage } from '../types/index.js'

// Cap one practice run so a long backlog doesn't become an endless session.
const MAX_BATCH = 10

export interface PracticePanelOptions {
  onClose: () => void
}

// Saved-unknown lemmas that can actually be practiced (resolve to a usable target),
// stalest-first. Shared by the count and the queue so the two can't drift.
function practiceableLemmas(): string[] {
  return orderUnknownByStaleness(getLexiconForStorage())
    .filter(lemma => Boolean(lookup(lemma)?.target))
}

// Drives the "Practice (N)" button label and disabled state.
export function countPracticeable(): number {
  return practiceableLemmas().length
}

export async function openPracticePanel(
  host: HTMLElement,
  activeLanguage: TargetLanguage,
  options: PracticePanelOptions,
): Promise<void> {
  // BCP-47 tag for the active language, applied to rendered target text.
  const targetLang = getLanguageInfo(activeLanguage).htmlLang

  // Pack is normally already loaded by the list render; this is a defensive no-op.
  try {
    await loadLanguagePack(activeLanguage)
  } catch {
    // If the pack can't load, the queue below is empty and we show the empty state.
  }

  const queue = practiceableLemmas().slice(0, MAX_BATCH)

  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null

  const panel = document.createElement('div')
  panel.className = 'practice-panel'

  const header = document.createElement('div')
  header.className = 'practice-header'

  // No eyebrow label here — the host card's title is swapped to "Practice" while the
  // panel is open, so a label here would be a duplicate.
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

  header.appendChild(progress)
  header.appendChild(closeBtn)

  const content = document.createElement('div')
  content.className = 'practice-content'

  panel.appendChild(header)
  panel.appendChild(content)
  host.appendChild(panel)

  function clearContent(): void {
    while (content.firstChild) content.removeChild(content.firstChild)
  }

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

  let index = 0      // queue cursor (advances over skips too)
  let answered = 0   // questions actually shown + answered (drives the count/progress)

  function showDone(): void {
    progress.textContent = ''
    clearContent()
    const done = document.createElement('p')
    done.className = 'practice-empty'
    done.textContent = `Done — reviewed ${answered} word${answered === 1 ? '' : 's'}.`
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
    const dict = lookup(lemma)
    const target = dict?.target ?? ''
    if (!entry.selfMarkedUnknown || !target) {
      showNext()
      return
    }

    progress.textContent = `${answered + 1} of ${queue.length}`
    renderFront(lemma, target, dict?.sourceGloss ?? '')
  }

  // Front of the card: the Spanish word and a button to reveal the answer.
  function renderFront(lemma: string, target: string, gloss: string): void {
    clearContent()
    content.appendChild(textEl('p', 'practice-prompt', 'Do you know this word?'))
    const term = textEl('p', 'practice-term', target)
    term.lang = targetLang
    content.appendChild(term)

    const showBtn = document.createElement('button')
    showBtn.type = 'button'
    showBtn.className = 'practice-show'
    showBtn.textContent = 'Show answer'
    showBtn.addEventListener('click', () => renderBack(lemma, target, gloss))
    content.appendChild(showBtn)
    showBtn.focus()
  }

  // Back of the card: the English meaning + gloss, then self-grade buttons.
  function renderBack(lemma: string, target: string, gloss: string): void {
    clearContent()
    const term = textEl('p', 'practice-term', target)
    term.lang = targetLang
    content.appendChild(term)

    const answer = document.createElement('div')
    answer.className = 'practice-answer'
    answer.tabIndex = -1
    answer.setAttribute('aria-label', gloss ? `${lemma}, ${gloss}` : lemma)
    answer.appendChild(textEl('span', 'practice-answer__en', lemma))
    if (gloss) answer.appendChild(textEl('span', 'practice-answer__gloss', gloss))
    content.appendChild(answer)

    const grades = document.createElement('div')
    grades.className = 'practice-grade'
    grades.appendChild(gradeButton('Didn’t know', lemma, false))
    grades.appendChild(gradeButton('Knew it', lemma, true))
    content.appendChild(grades)

    // Focus the revealed answer so screen readers announce it; Tab reaches the
    // grade buttons next.
    answer.focus()
  }

  function gradeButton(label: string, lemma: string, known: boolean): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = known ? 'practice-grade__btn practice-grade__btn--know' : 'practice-grade__btn'
    btn.textContent = label
    btn.addEventListener('click', () => grade(lemma, known))
    return btn
  }

  // Self-grade maps to an SM-2 correct/incorrect result (which stamps lastReviewedAt)
  // and is persisted clobber-safe before advancing.
  function grade(lemma: string, known: boolean): void {
    applyQuizResult(lemma, known)
    void flushLexiconMerge()
    answered++
    showNext()
  }

  showNext()
}

function textEl(tag: string, className: string, text: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text
  return node
}
