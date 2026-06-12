import { setUnknown } from '../engine/wordLifecycle.js'
import {
  clearDirty,
  getLexiconForStorage,
  isDirty,
} from '../store/lexiconStore.js'
import { getSessionForStorage } from '../store/sessionStore.js'
import {
  isExtensionContextAvailable,
  isExtensionContextInvalidatedError,
} from '../utils/extensionContext.js'
import { BASE_SPAN_STYLE, UNKNOWN_SPAN_STYLE } from './spanStyles.js'

// The data attribute written by injector.ts to identify Contexto-managed spans.
const CONTEXTO_ATTR = 'data-contexto'

// Session-scoped counter. Resets with the page — no cross-session tracking.
let sessionUnknownMarkCount = 0

// ---------------------------------------------------------------------------
// Span visual states
// ---------------------------------------------------------------------------

const UNKNOWN_ATTR = 'data-contexto-unknown'

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

let tooltip: HTMLElement | null = null
let activeSpan: HTMLElement | null = null
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

function findContextoSpan(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const span = target.closest(`[${CONTEXTO_ATTR}="true"]`)
  return span instanceof HTMLElement ? span : null
}

function applyHoverState(target: HTMLElement): void {
  const hoverColor = target.getAttribute(UNKNOWN_ATTR) === 'true'
    ? 'rgba(132, 86, 22, 0.2)'
    : 'rgba(42, 92, 130, 0.14)'
  target.style.backgroundColor = hoverColor
}

function clearHoverState(target: HTMLElement): void {
  target.style.backgroundColor = ''
}

function showTooltip(target: HTMLElement, event: MouseEvent): void {
  const tip = getOrCreateTooltip()
  const isUnknown = target.getAttribute(UNKNOWN_ATTR) === 'true'
  if (activeSpan && activeSpan !== target) {
    clearHoverState(activeSpan)
  }
  activeSpan = target

  if (isUnknown) {
    const source = target.getAttribute('data-source') ?? ''
    const lemma = target.getAttribute('data-lemma') ?? source
    const translated = target.getAttribute('data-target') ?? ''
    const gloss = target.getAttribute('data-gloss') ?? ''
    tip.textContent = formatSavedUnknownTooltipText(source, lemma, translated, gloss)
    tip.style.whiteSpace = 'pre-line'
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
  if (activeSpan) {
    clearHoverState(activeSpan)
    activeSpan = null
  }
  if (tooltip) tooltip.style.display = 'none'
}

// ---------------------------------------------------------------------------
// Unknown-word interaction
// ---------------------------------------------------------------------------

function applyUnknownStateToLemma(lemma: string, unknown: boolean): void {
  const spans = document.querySelectorAll<HTMLElement>(`[${CONTEXTO_ATTR}="true"]`)
  for (const span of spans) {
    if (span.getAttribute('data-lemma') !== lemma) continue

    if (unknown) {
      span.setAttribute(UNKNOWN_ATTR, 'true')
      span.setAttribute('style', UNKNOWN_SPAN_STYLE)
    } else {
      span.removeAttribute(UNKNOWN_ATTR)
      span.setAttribute('style', BASE_SPAN_STYLE)
    }
  }
}

async function flushUserMark(): Promise<void> {
  if (!isDirty()) return
  if (!isExtensionContextAvailable()) return

  try {
    await chrome.storage.local.set({
      contexto_lexicon: getLexiconForStorage(),
      contexto_session: getSessionForStorage(),
    })
    clearDirty()
  } catch (err) {
    if (isExtensionContextInvalidatedError(err)) return
    console.warn('[Contexto] Failed to save unknown-word mark:', err)
  }
}

function handleSpanClick(target: HTMLElement): void {
  // data-lemma is set by injector.ts to token.lemma (e.g. "dog") — the key
  // used in the lexicon store.
  const englishLemma = target.getAttribute('data-lemma')
  if (!englishLemma) return

  const isUnknown = target.getAttribute(UNKNOWN_ATTR) === 'true'

  if (isUnknown) {
    setUnknown(englishLemma, false)
    applyUnknownStateToLemma(englishLemma, false)
  } else {
    setUnknown(englishLemma, true)
    applyUnknownStateToLemma(englishLemma, true)
    sessionUnknownMarkCount++
  }

  void flushUserMark()

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
    const target = findContextoSpan(event.target)
    if (!target) return

    applyHoverState(target)
    showTooltip(target, event)
  })

  document.body.addEventListener('mouseout', (event: MouseEvent) => {
    const target = findContextoSpan(event.target)
    if (!target) return

    const nextTarget = findContextoSpan(event.relatedTarget)
    if (nextTarget === target) return

    if (activeSpan === target) {
      hideTooltip()
    } else {
      clearHoverState(target)
    }
  })

  document.body.addEventListener('mousemove', (event: MouseEvent) => {
    if (tooltip && tooltip.style.display !== 'none') {
      if (!activeSpan || !activeSpan.isConnected || findContextoSpan(event.target) !== activeSpan) {
        hideTooltip()
        return
      }
      positionTooltip(tooltip, event)
    }
  })

  // Unknown-word save: delegated click on all Contexto spans.
  document.body.addEventListener('click', (event: MouseEvent) => {
    const target = findContextoSpan(event.target)
    if (!target) {
      hideTooltip()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    handleSpanClick(target)
  })

  // Dynamic sites can remove or recycle the hovered span without dispatching a
  // useful mouseout event. These page-level exits keep the tooltip from sticking.
  document.addEventListener('scroll', hideTooltip, true)
  window.addEventListener('blur', hideTooltip)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hideTooltip()
  })
}

export function removeHoverUI(): void {
  tooltip?.remove()
  tooltip = null
  activeSpan = null
}

export function getSessionUnknownMarkCount(): number {
  return sessionUnknownMarkCount
}

export function formatTooltipText(
  source: string,
  lemma: string,
  translated: string,
  gloss: string,
): string {
  return `${source} (${lemma})\n${gloss}\nSpanish: ${translated}\nClick to save as unknown`
}

export function formatSavedUnknownTooltipText(
  source: string,
  lemma: string,
  translated: string,
  gloss: string,
): string {
  return `${source} (${lemma})\n${gloss}\nSpanish: ${translated}\nSaved as unknown - click to remove`
}
