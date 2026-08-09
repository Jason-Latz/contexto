import {
  getDomainDecision,
  isDomainBlocked,
  setDomainDecision,
} from '../store/settingsStore.js'
import { isCommunicationSite } from './communicationSites.js'

// CSS selectors for elements whose text nodes must never be rewritten. These
// exclusions are safe to check with closest() all the way to the top of the
// document. That matters for dynamic editors: the SPA observer may receive a
// newly inserted <span> as its walk root even though that span is several levels
// inside a contenteditable email composer.
const UNBOUNDED_SKIP_SELECTORS: readonly string[] = [
  'script',
  'style',
  'noscript',
  'code',
  'pre',
  'textarea',
  'input',
  'select',
  'option',
  'button',
  'label',
  'svg',
  'math',
  // Any authoring surface is a hard safety boundary. Contexto must never mutate
  // user-authored text: doing so can corrupt a framework's draft state and can
  // change the content that an email/message form submits.
  '[contenteditable]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[aria-multiline="true"]',
  // Common code editor containers
  '.ace_editor',
  '.CodeMirror',
  '.cm-editor',
  // Monaco editor (VS Code web, GitHub Codespaces)
  '.monaco-editor',
  // Rich-text editor containers. Most also carry contenteditable, but keeping
  // their stable host markers here makes the safety rule fail closed if an app
  // toggles contenteditable while mounting or reconciling an editor.
  '.ProseMirror',
  '.ql-editor',
  '.mce-content-body',
  '.cke_editable',
  '[data-lexical-editor]',
  '[data-slate-editor]',
  // Contexto-managed UI and replacement spans must never be translated.
  '[data-contexto]',
  '[data-contexto-ui]',
  '#contexto-tooltip',
]

// Elements explicitly tagged as non-English are skipped to avoid translating
// them twice. This selector is deliberately scoped to the current walk root:
// checking it with an unbounded closest() would let <html lang="de"> disable an
// otherwise-English page whose CMS mislabeled the document language.
const FOREIGN_LANGUAGE_SELECTOR = '[lang]:not([lang^="en"]):not([lang=""])'

// One compound selector so each matches()/closest() safety check is one call.
const UNBOUNDED_SKIP_SELECTOR = UNBOUNDED_SKIP_SELECTORS.join(', ')

// Domains where involuntary word replacement carries a real risk of harm:
// misreading a medical dosage, misinterpreting a legal clause, or misunderstanding
// a financial figure. The extension asks for explicit consent before proceeding.
const HIGH_STAKES_DOMAINS: { pattern: RegExp; category: string }[] = [
  {
    pattern: /\.(nih|cdc|who)\.gov$|webmd\.com|mayoclinic\.org|medlineplus\.gov/,
    category: 'medical',
  },
  {
    pattern: /courts\.gov|uscourts\.gov|law\.|legislation\./,
    category: 'legal',
  },
  {
    pattern: /\.(irs|sec|fdic|federalreserve)\.gov$/,
    category: 'financial or regulatory',
  },
  {
    pattern: /\.gov$|\.mil$/,
    category: 'government or military',
  },
  {
    pattern: /chase\.com|bankofamerica\.com|wellsfargo\.com|paypal\.com|stripe\.com/,
    category: 'banking',
  },
]

// Inject a consent banner into the page and return a Promise that resolves to
// true ("Enable") or false ("Keep Paused") based on the user's button click.
// The banner is removed from the DOM as soon as a choice is made.
function showHighStakesBanner(hostname: string, category: string): Promise<boolean> {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const banner = document.createElement('div')
    banner.setAttribute('id', 'contexto-hsd-banner')
    banner.setAttribute('role', 'dialog')
    banner.setAttribute('aria-modal', 'false')
    banner.setAttribute('aria-labelledby', 'contexto-hsd-message')
    banner.setAttribute('style', [
      'position: fixed',
      'top: 0',
      'left: 0',
      'right: 0',
      'z-index: 2147483647',
      'background: #1e2a3a',
      'color: #e8edf2',
      'font-family: system-ui, -apple-system, sans-serif',
      'font-size: 14px',
      'padding: 12px 20px',
      'display: flex',
      'flex-wrap: wrap',
      'align-items: center',
      'gap: 16px',
      'box-shadow: 0 2px 8px rgba(0,0,0,0.4)',
    ].join('; '))

    const message = document.createElement('span')
    message.id = 'contexto-hsd-message'
    message.style.flex = '1'
    banner.setAttribute('data-contexto-ui', 'true')
    message.textContent =
      `Contexto is paused because ${hostname} may contain ${category} information. Enable immersion here?`

    const enableBtn = document.createElement('button')
    enableBtn.textContent = 'Enable here'
    enableBtn.setAttribute('style', [
      'padding: 6px 14px',
      'background: #3a7bd5',
      'color: #fff',
      'border: none',
      'border-radius: 4px',
      'font-size: 13px',
      'cursor: pointer',
      'flex-shrink: 0',
    ].join('; '))

    const pauseBtn = document.createElement('button')
    pauseBtn.textContent = 'Keep Paused'
    pauseBtn.setAttribute('style', [
      'padding: 6px 14px',
      'background: transparent',
      'color: #a0b4c8',
      'border: 1px solid #a0b4c8',
      'border-radius: 4px',
      'font-size: 13px',
      'cursor: pointer',
      'flex-shrink: 0',
    ].join('; '))

    function dismiss(enabled: boolean): void {
      document.removeEventListener('keydown', onKeydown)
      banner.remove()
      previousFocus?.focus?.()
      resolve(enabled)
    }

    function onKeydown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      event.preventDefault()
      dismiss(false)
    }

    enableBtn.addEventListener('click', () => dismiss(true), { once: true })
    pauseBtn.addEventListener('click', () => dismiss(false), { once: true })
    document.addEventListener('keydown', onKeydown)

    banner.appendChild(message)
    banner.appendChild(enableBtn)
    banner.appendChild(pauseBtn)
    document.body.appendChild(banner)
    enableBtn.focus()
  })
}

// Check whether the extension should run on the current page.
// Returns true if the page is safe to proceed, false if the user chose Keep Paused.
//
// The user's banner decision is persisted in settingsStore so the same domain
// is never asked again after the first visit.
async function checkHighStakesDomain(): Promise<boolean> {
  const hostname = window.location.hostname.replace(/^www\./, '')

  // Email/chat sites are a non-overrideable product safety boundary, not a
  // high-stakes banner choice. The startup path also exits before loading a
  // language pack; this duplicate guard protects direct walker callers.
  if (isCommunicationSite(hostname)) return false

  if (isDomainBlocked(hostname)) return false

  for (const { pattern, category } of HIGH_STAKES_DOMAINS) {
    if (pattern.test(hostname)) {
      // Return the stored decision immediately if the user has answered before.
      const stored = getDomainDecision(hostname)
      if (stored !== null) return stored

      // First visit to this high-stakes domain — show the banner and persist the answer.
      const allowed = await showHighStakesBanner(hostname, category)
      await setDomainDecision(hostname, allowed)
      return allowed
    }
  }

  return true
}

function documentIsEditable(doc: Document | null): boolean {
  return doc?.designMode?.toLowerCase() === 'on'
}

// Defense-in-depth predicate used by both the walker and the injector. The
// injector checks again immediately before its DOM write, so a node collected
// as ordinary article text cannot be moved into a composer between collection
// and replacement.
export function isTextNodeSafeToRewrite(node: Text): boolean {
  const parent = node.parentElement
  if (!parent) return false
  if (documentIsEditable(parent.ownerDocument)) return false
  if (parent instanceof HTMLElement && parent.isContentEditable) return false
  return parent.closest(UNBOUNDED_SKIP_SELECTOR) === null
}

// The language exclusion is scoped to the supplied walk root. All structural
// and editable exclusions above are intentionally unbounded.
function isInsideForeignLanguageElement(node: Text, root: Element): boolean {
  let ancestor: Element | null = node.parentElement
  while (ancestor) {
    if (ancestor.matches(FOREIGN_LANGUAGE_SELECTOR)) return true
    if (ancestor === root) break
    ancestor = ancestor.parentElement
  }
  return false
}

// Build a TreeWalker that visits only non-empty text nodes.
// The acceptNode filter rejects empty/whitespace-only nodes and any node
// whose ancestor matches SKIP_SELECTORS.
function buildTextWalker(root: Element): TreeWalker {
  // closest() is essential here. The MutationObserver queues the immediate
  // added subtree, which can be a plain descendant inside an email composer,
  // rich-text editor, form control, or our own hover UI.
  if (
    documentIsEditable(root.ownerDocument) ||
    (root instanceof HTMLElement && root.isContentEditable) ||
    root.closest(UNBOUNDED_SKIP_SELECTOR) ||
    root.matches(FOREIGN_LANGUAGE_SELECTOR)
  ) {
    return document.createTreeWalker(document.createElement('div'), NodeFilter.SHOW_TEXT)
  }

  return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Text): number {
      // Fast-reject: empty or pure-whitespace text nodes are never worth processing
      if (!node.nodeValue || node.nodeValue.trim().length === 0) {
        return NodeFilter.FILTER_REJECT
      }
      if (!isTextNodeSafeToRewrite(node) || isInsideForeignLanguageElement(node, root)) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
}

// Synchronous variant of collectTextNodes — no high-stakes check.
// Used by the MutationObserver to filter newly added subtrees without
// re-showing the async banner (the domain decision is already settled by
// the time any mutation fires).
export function collectTextNodesSync(root: Element): Text[] {
  const walker = buildTextWalker(root)
  const nodes: Text[] = []
  let node: Node | null
  while ((node = walker.nextNode()) !== null) {
    nodes.push(node as Text)
  }
  return nodes
}

// Collect all processable text nodes under `root`.
// Returns an empty array if:
//   - the current page is a high-stakes domain and the user chose Keep Paused
//   - root has no processable text nodes
export async function collectTextNodes(root: Element = document.body): Promise<Text[]> {
  const allowed = await checkHighStakesDomain()
  if (!allowed) return []

  const walker = buildTextWalker(root)
  const nodes: Text[] = []

  let node: Node | null
  while ((node = walker.nextNode()) !== null) {
    nodes.push(node as Text)
  }

  return nodes
}
