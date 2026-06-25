import { setUnknown } from '../engine/wordLifecycle.js'
import { getActiveLanguagePack } from '../language/loader.js'
import {
  flushLexiconMerge,
  isDirty,
} from '../store/lexiconStore.js'
import { getSessionForStorage } from '../store/sessionStore.js'
import {
  isExtensionContextAvailable,
  isExtensionContextInvalidatedError,
} from '../utils/extensionContext.js'
import { baseSpanStyle, unknownSpanStyle, spanHoverFill } from './spanStyles.js'

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
let tipSourceEl: HTMLElement | null = null
let tipGlossEl: HTMLElement | null = null
let tipTargetEl: HTMLElement | null = null
let tipHintEl: HTMLElement | null = null
let activeSpan: HTMLElement | null = null
let isHoverHandlerSetup = false

// Brand ink surface (matches the popup tooltip tokens) with a light accent tint
// for the Spanish line so the dark tooltip echoes the brand without shouting.
const TIP_ACCENT = '#9ec3e0'   // light slate tint — system replacement
const TIP_MARK   = '#d8b483'   // warm tan tint — your saved marks
const TIP_MUTED  = '#aab6c2'
const TIP_HINT   = '#7f8d9b'

function makeTipLine(style: string): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('style', style)
  return el
}

// Display name of the currently loaded pack ("Spanish"/"German"/…), used to label
// the target line so the tooltip matches the active language rather than always
// saying "Spanish". Falls back to Spanish before any pack has loaded.
function activeLanguageName(): string {
  return getActiveLanguagePack()?.displayName ?? 'Spanish'
}

function getOrCreateTooltip(): HTMLElement {
  if (tooltip) return tooltip

  tooltip = document.createElement('div')
  tooltip.setAttribute('id', 'contexto-tooltip')
  tooltip.setAttribute('data-contexto-ui', 'true')
  tooltip.setAttribute('role', 'tooltip')
  tooltip.setAttribute('style', [
    'position: absolute',
    'z-index: 2147483647',
    'padding: 9px 11px',
    'background: #1b2733',
    'color: #eef2f6',
    'font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    'border-radius: 6px',
    'pointer-events: none',
    'max-width: 280px',
    'box-shadow: 0 6px 24px rgba(0,0,0,0.30)',
    'display: none',
  ].join('; '))

  // Structured hierarchy: English source (lead) · gloss (muted) · Spanish (accent) · hint (eyebrow).
  tipSourceEl = makeTipLine('font-size: 13px; font-weight: 600; color: #eef2f6;')
  tipGlossEl  = makeTipLine('font-size: 12px; color: ' + TIP_MUTED + '; margin-top: 2px;')
  tipTargetEl = makeTipLine('font-size: 13px; font-weight: 600; margin-top: 6px; color: ' + TIP_ACCENT + ';')
  tipHintEl   = makeTipLine(
    'font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: ' + TIP_HINT +
    '; margin-top: 8px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.08);',
  )

  tooltip.appendChild(tipSourceEl)
  tooltip.appendChild(tipGlossEl)
  tooltip.appendChild(tipTargetEl)
  tooltip.appendChild(tipHintEl)

  document.body.appendChild(tooltip)
  return tooltip
}

function positionTooltip(tip: HTMLElement, event: MouseEvent): void {
  const OFFSET = 12
  const w = tip.offsetWidth
  const h = tip.offsetHeight

  // Horizontal: keep inside the viewport on both edges.
  const minX = window.scrollX + OFFSET
  const maxX = window.scrollX + window.innerWidth - w - OFFSET
  const x = Math.max(minX, Math.min(event.pageX + OFFSET, maxX))

  // Vertical: place below the cursor, but flip above when it would overflow the
  // bottom of the viewport (constant on long articles), then clamp to be safe.
  const spaceBelow = window.innerHeight - (event.clientY + OFFSET)
  let y = event.pageY + OFFSET
  if (h + OFFSET > spaceBelow && event.clientY > h + OFFSET) {
    y = event.pageY - h - OFFSET
  }
  const minY = window.scrollY + OFFSET
  const maxY = window.scrollY + window.innerHeight - h - OFFSET
  y = Math.max(minY, Math.min(y, maxY))

  tip.style.left = `${x}px`
  tip.style.top = `${y}px`
}

function findContextoSpan(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const span = target.closest(`[${CONTEXTO_ATTR}="true"]`)
  return span instanceof HTMLElement ? span : null
}

// Clickable host elements whose click must never be swallowed by the unknown-word
// toggle. A managed span is a plain <span>, so a closest() match is always a
// genuine interactive ancestor (link, button, menu item, etc.).
// Interactive ancestors whose click must never be touched. Beyond the standard
// HTML/ARIA controls, this also catches JS-delegated widgets that look like plain
// <div>s but carry click behavior — e.g. Google's `jsaction` (used by the "People
// also ask" accordion) and any tab-focusable custom control (`tabindex>=0`).
const INTERACTIVE_ANCESTOR_SELECTOR =
  'a[href], button, summary, label, select, input, textarea, ' +
  '[role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], ' +
  '[role="menuitemradio"], [role="tab"], [role="option"], [role="checkbox"], ' +
  '[role="radio"], [role="switch"], [role="combobox"], [role="treeitem"], ' +
  '[contenteditable]:not([contenteditable="false"]), [onclick], [jsaction], ' +
  '[tabindex]:not([tabindex="-1"])'

function isInsideInteractive(span: HTMLElement): boolean {
  return span.closest(INTERACTIVE_ANCESTOR_SELECTOR) !== null
}

function applyHoverState(target: HTMLElement): void {
  target.style.backgroundColor = spanHoverFill(target.getAttribute(UNKNOWN_ATTR) === 'true')
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

  const source = target.getAttribute('data-source') ?? ''
  const translated = target.getAttribute('data-target') ?? ''
  const gloss = target.getAttribute('data-gloss') ?? ''

  if (tipSourceEl) tipSourceEl.textContent = source
  if (tipGlossEl) {
    tipGlossEl.textContent = gloss
    tipGlossEl.style.display = gloss ? 'block' : 'none'
  }
  if (tipTargetEl) {
    tipTargetEl.textContent = translated ? `${activeLanguageName()} · ${translated}` : ''
    tipTargetEl.style.display = translated ? 'block' : 'none'
    tipTargetEl.style.color = isUnknown ? TIP_MARK : TIP_ACCENT
  }
  if (tipHintEl) {
    tipHintEl.textContent = isUnknown
      ? 'Saved as unknown · click to remove'
      : 'Click to save as unknown'
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
      span.setAttribute('style', unknownSpanStyle())
    } else {
      span.removeAttribute(UNKNOWN_ATTR)
      span.setAttribute('style', baseSpanStyle())
    }
  }
}

async function flushUserMark(): Promise<void> {
  if (!isDirty()) return
  if (!isExtensionContextAvailable()) return

  try {
    // Merge-write only the lemmas changed here so this per-click save can't revert
    // a mark-known/quiz change the popup made to a different lemma. Session is
    // page-scoped and still written whole.
    await flushLexiconMerge()
    await chrome.storage.local.set({ contexto_session: getSessionForStorage() })
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
    // If the replaced word sits inside a link, button, or other interactive
    // element, let the host handle the click — swallowing it would break the
    // page's navigation. The word stays revealable on hover; save-as-unknown is
    // only offered for words in ordinary, non-interactive text.
    if (isInsideInteractive(target)) {
      hideTooltip()
      return
    }
    // Mark the word unknown, but do NOT preventDefault/stopPropagation: swallowing
    // the click breaks pages that wire interactivity through event delegation on a
    // high-up container (Google jsaction, React synthetic events, etc.) — the host
    // handler would never receive the event. Marking works regardless of bubbling.
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

// Plain-text representation of the tooltip contents. The on-screen tooltip is
// built as structured DOM (see showTooltip); these helpers produce the same
// information as a single string for tests and assistive/plain-text contexts.
// `lemma` is accepted for signature stability but no longer shown — the source
// surface form already conveys the word, so the duplicated "(lemma)" was dropped.
export function formatTooltipText(
  source: string,
  _lemma: string,
  translated: string,
  gloss: string,
): string {
  return `${source}\n${gloss}\n${activeLanguageName()}: ${translated}\nClick to save as unknown`
}

export function formatSavedUnknownTooltipText(
  source: string,
  _lemma: string,
  translated: string,
  gloss: string,
): string {
  return `${source}\n${gloss}\n${activeLanguageName()}: ${translated}\nSaved as unknown · click to remove`
}
