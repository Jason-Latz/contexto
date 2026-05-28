import { collectTextNodesSync } from './domWalker.js'
import { injectReplacements } from './injector.js'

// The data attribute written by injector.ts — used to gate characterData processing.
const CONTEXTO_ATTR = 'data-contexto'

// How long to wait after the last mutation before processing. Batches rapid DOM
// bursts (virtual scroll recycling, SPA route transitions) into a single pass.
const DEBOUNCE_MS = 500

// Guard flag: prevents the observer's own DOM writes (span insertion) from
// triggering a re-entrant processing cycle.
let isInjecting = false

let debounceTimer: ReturnType<typeof setTimeout> | null = null

// Queued subtree roots collected during the debounce window.
// Processing the root of each added subtree (not individual text nodes) lets
// us batch-walk the full subtree once rather than walking each added node separately.
const pendingRoots = new Set<Element>()

// Whether any characterData mutations arrived during the debounce window.
// These are rare (virtual scroll recyclers that reuse DOM nodes with fresh text)
// and are handled by re-walking the parent element.
const pendingCharacterDataParents = new Set<Element>()

function scheduleFlush(approvedLemmas: ReadonlySet<string>): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    flush(approvedLemmas)
  }, DEBOUNCE_MS)
}

function flush(approvedLemmas: ReadonlySet<string>): void {
  if (isInjecting) return
  isInjecting = true

  try {
    // Process childList roots first — these are new subtrees added to the DOM.
    for (const root of pendingRoots) {
      // Skip if this root was removed before the debounce fired (e.g. a transient
      // loading spinner that appeared and disappeared within the debounce window).
      if (!document.contains(root)) continue

      const nodes = collectTextNodesSync(root)
      for (const node of nodes) {
        injectReplacements(node, approvedLemmas)
      }
    }
    pendingRoots.clear()

    // Process characterData parents — text content of an existing node changed.
    // Only arrives when the parent carries data-contexto (a Contexto-managed span whose
    // text was recycled). Re-inject so the replacement stays active after recycling.
    for (const parent of pendingCharacterDataParents) {
      if (!document.contains(parent)) continue
      const nodes = collectTextNodesSync(parent)
      for (const node of nodes) {
        injectReplacements(node, approvedLemmas)
      }
    }
    pendingCharacterDataParents.clear()
  } finally {
    isInjecting = false
  }
}

/**
 * Attach a MutationObserver to document.body that applies word replacements to
 * newly added subtrees. Call this once from index.ts after the initial injection
 * pass has completed and approvedLemmas is settled for the page.
 *
 * The observer is SPA-safe:
 *   - 500 ms debounce absorbs rapid bursts (route transitions, infinite scroll)
 *   - isInjecting guard prevents re-entrant cycles from span insertions
 *   - characterData processing is gated on the parent carrying data-contexto,
 *     so routine text edits on the page are never processed
 */
export function setupMutationObserver(approvedLemmas: ReadonlySet<string>): MutationObserver {
  const observer = new MutationObserver((mutations) => {
    // Drop mutations that originated from our own injection pass.
    if (isInjecting) return

    let hasWork = false

    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          // Only Element nodes have subtrees worth walking. Added Text nodes are
          // the leaf children of those elements and will be reached via the walker.
          if (node instanceof Element) {
            pendingRoots.add(node)
            hasWork = true
          } else if (node instanceof Text && node.parentElement) {
            // Text node added directly (e.g. innerHTML rebuild that creates bare
            // text children). Walk from the parent element so SKIP_SELECTORS apply.
            pendingRoots.add(node.parentElement)
            hasWork = true
          }
        }
      } else if (mutation.type === 'characterData') {
        // A text node's data changed. Only act when the parent is a Contexto span —
        // virtual scroll recyclers reuse the span node but write new text into it.
        const parent = mutation.target.parentElement
        if (parent && parent.hasAttribute(CONTEXTO_ATTR)) {
          pendingCharacterDataParents.add(parent)
          hasWork = true
        }
      }
    }

    if (hasWork) scheduleFlush(approvedLemmas)
  })

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  })

  return observer
}
