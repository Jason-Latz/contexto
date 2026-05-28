import { setKnown } from '../engine/wordLifecycle.js'

// The data attribute written by injector.ts to identify Contexto-managed spans.
const CONTEXTO_ATTR = 'data-contexto'

// Threshold for the informational self-mark warning toast.
// Not a hard cap — the user may mark as many words as they like.
const SELF_MARK_WARNING_AT = 10

// Session-scoped counter. Resets with the page — no cross-session tracking.
let sessionSelfMarkCount = 0

// Tracks whether the 10-mark warning has already been shown this session
// so it only fires once even if the user continues marking.
let warningShown = false

// ---------------------------------------------------------------------------
// Span visual states
// ---------------------------------------------------------------------------

// Applied by injector.ts — reproduced here so we can restore it on unmark.
const BASE_SPAN_STYLE = [
  'border-bottom: 1px solid rgba(42, 92, 130, 0.55)',
  'background: rgba(42, 92, 130, 0.07)',
  'border-radius: 2px',
  'cursor: help',
  'color: inherit',
  'font-style: inherit',
].join('; ')

// Applied when the user marks a word as known. Muted to signal it is no longer
// active in the replacement rotation, but left in place so the user can see
// which words they have marked on this page.
const KNOWN_SPAN_STYLE = [
  'border-bottom: 1px dashed #c8c8c8',
  'cursor: default',
  'color: #aaa',
  'font-style: normal',
  'opacity: 0.6',
].join('; ')

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

let tooltip: HTMLElement | null = null
let isHoverHandlerSetup = false

function getOrCreateTooltip(): HTMLElement {
  if (tooltip) return tooltip

  tooltip = document.createElement('div')
  tooltip.setAttribute('id', 'contexto-tooltip')
  tooltip.setAttribute('data-contexto-ui', 'true')
  tooltip.setAttribute('style', [
    'position: absolute',
    'z-index: 2147483647',
    'padding: 8px 10px',
    'background: #17202a',
    'color: #f4f7fa',
    'font-size: 13px',
    'font-family: system-ui, -apple-system, sans-serif',
    'border-radius: 4px',
    'pointer-events: none',
    'max-width: 280px',
    'box-shadow: 0 2px 8px rgba(0,0,0,0.35)',
    'display: none',
    'line-height: 1.4',
  ].join('; '))

  document.body.appendChild(tooltip)
  return tooltip
}

function positionTooltip(tip: HTMLElement, event: MouseEvent): void {
  const OFFSET = 12
  const x = event.pageX + OFFSET
  const y = event.pageY + OFFSET
  const maxX = window.scrollX + window.innerWidth - tip.offsetWidth - OFFSET
  tip.style.left = `${Math.min(x, maxX)}px`
  tip.style.top = `${y}px`
}

function showTooltip(target: HTMLElement, event: MouseEvent): void {
  const tip = getOrCreateTooltip()
  const isKnown = target.getAttribute('data-contexto-known') === 'true'

  if (isKnown) {
    tip.textContent = 'Known - click to undo'
  } else {
    const source = target.getAttribute('data-source') ?? ''
    const lemma = target.getAttribute('data-lemma') ?? source
    const translated = target.getAttribute('data-target') ?? ''
    const gloss = target.getAttribute('data-gloss') ?? ''
    tip.textContent = formatTooltipText(source, lemma, translated, gloss)
    tip.style.whiteSpace = 'pre-line'
  }

  tip.style.display = 'block'
  positionTooltip(tip, event)
}

function hideTooltip(): void {
  if (tooltip) tooltip.style.display = 'none'
}

// ---------------------------------------------------------------------------
// Self-mark warning toast
// ---------------------------------------------------------------------------

function showSelfMarkWarning(): void {
  if (warningShown) return
  warningShown = true

  const toast = document.createElement('div')
  toast.setAttribute('style', [
    'position: fixed',
    'bottom: 16px',
    'left: 16px',
    'z-index: 2147483647',
    'max-width: 320px',
    'background: #1e2a3a',
    'color: #e8edf2',
    'font-size: 13px',
    'font-family: system-ui, -apple-system, sans-serif',
    'border-radius: 8px',
    'padding: 10px 14px',
    'box-shadow: 0 4px 16px rgba(0,0,0,0.25)',
    'display: flex',
    'align-items: flex-start',
    'gap: 10px',
    'line-height: 1.45',
  ].join('; '))

  const msg = document.createElement('span')
  msg.textContent =
    "You've marked many words as known this session — make sure you're being honest with yourself."

  const closeBtn = document.createElement('button')
  closeBtn.setAttribute('style', [
    'background: none',
    'border: none',
    'color: #8fa8c0',
    'font-size: 16px',
    'cursor: pointer',
    'padding: 0',
    'line-height: 1',
    'flex-shrink: 0',
  ].join('; '))
  closeBtn.textContent = '×'
  closeBtn.setAttribute('aria-label', 'Dismiss')
  closeBtn.addEventListener('click', () => toast.remove())

  toast.appendChild(msg)
  toast.appendChild(closeBtn)
  document.body.appendChild(toast)

  // Auto-dismiss after 8 seconds so it doesn't persist indefinitely.
  setTimeout(() => toast.remove(), 8_000)
}

// ---------------------------------------------------------------------------
// Self-mark interaction
// ---------------------------------------------------------------------------

function handleSpanClick(target: HTMLElement): void {
  // data-lemma is set by injector.ts to token.lemma (e.g. "dog") — the key
  // used in the lexicon store.
  const englishLemma = target.getAttribute('data-lemma')
  if (!englishLemma) return

  const isKnown = target.getAttribute('data-contexto-known') === 'true'

  if (isKnown) {
    // Second click — undo the mark.
    setKnown(englishLemma, false)
    target.removeAttribute('data-contexto-known')
    target.setAttribute('style', BASE_SPAN_STYLE)
  } else {
    // First click — mark as known.
    setKnown(englishLemma, true)
    target.setAttribute('data-contexto-known', 'true')
    target.setAttribute('style', KNOWN_SPAN_STYLE)

    sessionSelfMarkCount++
    if (sessionSelfMarkCount >= SELF_MARK_WARNING_AT) {
      showSelfMarkWarning()
    }
  }

  // Hide the tooltip immediately after a click — the word's state has changed
  // and the stale tooltip text should not linger.
  hideTooltip()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function setupHoverHandler(): void {
  if (isHoverHandlerSetup) return
  isHoverHandlerSetup = true

  document.body.addEventListener('mouseover', (event: MouseEvent) => {
    const target = event.target as HTMLElement
    if (!target.hasAttribute(CONTEXTO_ATTR)) return

    // Known words use a muted style with no hover highlight — the base style
    // applied at mark time is already visually distinct.
    if (target.getAttribute('data-contexto-known') !== 'true') {
      target.style.backgroundColor = 'rgba(42, 92, 130, 0.14)'
    }
    showTooltip(target, event)
  })

  document.body.addEventListener('mouseout', (event: MouseEvent) => {
    const target = event.target as HTMLElement
    if (!target.hasAttribute(CONTEXTO_ATTR)) return
    target.style.backgroundColor = ''
    hideTooltip()
  })

  document.body.addEventListener('mousemove', (event: MouseEvent) => {
    if (tooltip && tooltip.style.display !== 'none') {
      positionTooltip(tooltip, event)
    }
  })

  // Self-mark: delegated click on all Contexto spans.
  document.body.addEventListener('click', (event: MouseEvent) => {
    const target = event.target as HTMLElement
    if (!target.hasAttribute(CONTEXTO_ATTR)) return
    handleSpanClick(target)
  })
}

export function removeHoverUI(): void {
  tooltip?.remove()
  tooltip = null
}

// Exported for use by the popup's KnownWordsList to display the session count.
export function getSessionSelfMarkCount(): number {
  return sessionSelfMarkCount
}

export function formatTooltipText(
  source: string,
  lemma: string,
  translated: string,
  gloss: string,
): string {
  return `${source} (${lemma})\n${gloss}\nSpanish: ${translated}\nClick to mark known`
}
