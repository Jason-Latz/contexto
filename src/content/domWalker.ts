import {
  getDomainDecision,
  isDomainBlocked,
  setDomainDecision,
} from '../store/settingsStore.js'

// CSS selectors for elements whose text nodes must never be processed.
// Replacing words inside these elements would break functionality, corrupt code
// samples, or confuse the user by altering UI chrome and form inputs.
const SKIP_SELECTORS: readonly string[] = [
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
  '[contenteditable]',
  '[contenteditable="true"]',
  // Common code editor containers
  '.ace_editor',
  '.CodeMirror',
  '.cm-editor',
  // Monaco editor (VS Code web, GitHub Codespaces)
  '.monaco-editor',
  // Contexto-managed UI and replacement spans must never be translated.
  '[data-contexto]',
  '[data-contexto-ui]',
  '[data-contexto-quiz]',
  '#contexto-tooltip',
  '#contexto-onboarding',
  '#contexto-calibration',
  // Elements explicitly tagged as non-English — skip to avoid double-translation
  '[lang]:not([lang^="en"])',
]

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
    const banner = document.createElement('div')
    banner.setAttribute('id', 'contexto-hsd-banner')
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
      'align-items: center',
      'gap: 16px',
      'box-shadow: 0 2px 8px rgba(0,0,0,0.4)',
    ].join('; '))

    const message = document.createElement('span')
    message.style.flex = '1'
    banner.setAttribute('data-contexto-ui', 'true')
    message.textContent =
      `Contexto: ${category} site detected (${hostname}). Enable language immersion here?`

    const enableBtn = document.createElement('button')
    enableBtn.textContent = 'Enable'
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
      banner.remove()
      resolve(enabled)
    }

    enableBtn.addEventListener('click', () => dismiss(true), { once: true })
    pauseBtn.addEventListener('click', () => dismiss(false), { once: true })

    banner.appendChild(message)
    banner.appendChild(enableBtn)
    banner.appendChild(pauseBtn)
    document.body.appendChild(banner)
  })
}

// Check whether the extension should run on the current page.
// Returns true if the page is safe to proceed, false if the user chose Keep Paused.
//
// The user's banner decision is persisted in settingsStore so the same domain
// is never asked again after the first visit.
async function checkHighStakesDomain(): Promise<boolean> {
  const hostname = window.location.hostname.replace(/^www\./, '')

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

// Return true if any ancestor of `node` (up to but not including `root`)
// matches any selector in SKIP_SELECTORS.
function isInsideSkippedElement(node: Node, root: Element): boolean {
  let ancestor: Node | null = node.parentElement
  while (ancestor && ancestor !== root) {
    if (ancestor instanceof Element) {
      for (const selector of SKIP_SELECTORS) {
        if (ancestor.matches(selector)) return true
      }
    }
    ancestor = ancestor.parentElement
  }
  return false
}

// Build a TreeWalker that visits only non-empty text nodes.
// The acceptNode filter rejects empty/whitespace-only nodes and any node
// whose ancestor matches SKIP_SELECTORS.
function buildTextWalker(root: Element): TreeWalker {
  for (const selector of SKIP_SELECTORS) {
    if (root.matches(selector)) {
      return document.createTreeWalker(document.createElement('div'), NodeFilter.SHOW_TEXT)
    }
  }

  return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Text): number {
      // Fast-reject: empty or pure-whitespace text nodes are never worth processing
      if (!node.nodeValue || node.nodeValue.trim().length === 0) {
        return NodeFilter.FILTER_REJECT
      }
      if (isInsideSkippedElement(node, root)) {
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
