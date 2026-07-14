/**
 * PageStatus.ts — "is it working right now?" for the page behind the popup.
 *
 * Without this the popup shows only global controls, so a page with no
 * replacements is indistinguishable from a broken extension. It asks the active
 * tab's content script what it is doing and renders the answer in plain words.
 *
 * The content script computes its status live on every query, so nothing here is
 * cached, and the card re-asks whenever settings change so it cannot go stale
 * behind a language switch. The query never blocks the rest of the popup: a page
 * whose main thread is wedged must not cost the user their language picker.
 *
 * A tab with no content script rejects the message. The tab's URL then says WHY:
 * host permissions only expose the URL on pages we can inject into, so a page
 * whose URL is missing or non-http is one Chrome walls off from extensions
 * (its own native pages, the Web Store), while a readable http page with no
 * script simply predates the install and needs a reload. Each cause gets its
 * own copy so the user is never told "browser pages" while reading an article.
 */

import { PAGE_STATUS_MESSAGE, type PageStatus } from '../types/index.js'
import { getLanguageInfo } from '../language/registry.js'

const SETTINGS_KEY = 'contexto_settings'

// A page mid-render answers 'loading'. Re-ask a bounded number of times so the
// card settles on the real answer instead of sitting on the transient one.
const LOADING_RETRY_MS = 700
const MAX_LOADING_RETRIES = 4

// A wedged page never replies. Show the neutral 'loading' copy rather than
// hanging, or claiming the page is unreachable when it may be perfectly fine.
const QUERY_TIMEOUT_MS = 1500

// How long to let the content script re-render before re-asking after a change.
const SETTLE_AFTER_CHANGE_MS = 600

export interface StatusCopy {
  headline: string
  hint?: string
  // Drives the dot colour: is Contexto doing its job on this page?
  tone: 'working' | 'idle'
}

// The active tab either answered with a PageStatus or has no content script at
// all, in which case its URL (when visible) is the evidence for why.
type PopupPageStatus = PageStatus | { kind: 'no-script'; url: string | undefined }

function describe(status: PageStatus): StatusCopy {
  switch (status.kind) {
    case 'active': {
      if (status.swapped === 0) {
        return {
          tone: 'idle',
          headline: 'No swappable words on this page.',
          hint: 'Raise the density below, or turn on Aggressive Mode for rarer words.',
        }
      }
      const language = getLanguageInfo(status.language).displayName
      const words = status.swapped === 1 ? '1 word' : `${status.swapped} words`
      return { tone: 'working', headline: `${words} swapped into ${language} on this page.` }
    }
    case 'loading':
      return { tone: 'working', headline: 'Looking for words to swap...' }
    case 'too-short':
      return {
        tone: 'idle',
        headline: 'Nothing to swap here.',
        hint: 'Contexto skips pages with less than 100 words of text.',
      }
    case 'blocked':
      return {
        tone: 'idle',
        headline: 'Paused on this site.',
        hint: 'Remove it from Blocked Domains below to resume.',
      }
    case 'paused':
      return {
        tone: 'idle',
        headline: 'Paused on this site.',
        hint: 'You chose to skip Contexto here when you first visited.',
      }
    case 'off':
      return {
        tone: 'idle',
        headline: 'Text replacement is off.',
        hint: 'Turn it back on under Features.',
      }
    case 'error':
      return {
        tone: 'idle',
        headline: 'Contexto could not run on this page.',
        hint: 'Reloading the page usually fixes it.',
      }
  }
}

function isWebStoreUrl(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url)
    return hostname === 'chromewebstore.google.com' ||
      (hostname === 'chrome.google.com' && pathname.startsWith('/webstore'))
  } catch {
    return false
  }
}

// Why is there no content script on this tab? Host permissions only expose a
// tab's URL where injection is allowed, so a missing URL means Chrome refused
// us the page entirely — the same conclusion as a chrome:// scheme.
// Exported for unit tests.
export function describeNoScript(url: string | undefined): StatusCopy {
  if (url && /^https?:/i.test(url) && !isWebStoreUrl(url)) {
    return {
      tone: 'idle',
      headline: 'Contexto is not loaded in this tab.',
      hint: 'This tab was open before Contexto was installed or updated. Reload the page to start.',
    }
  }
  if (url?.startsWith('file:')) {
    return {
      tone: 'idle',
      headline: 'Contexto does not run on local files yet.',
      hint: 'Allow "access to file URLs" for Contexto in Chrome\'s extension settings, then reload.',
    }
  }
  return {
    tone: 'idle',
    headline: 'Contexto does not run on native Chrome pages.',
    hint: 'Chrome blocks extensions on its own pages, like settings, the new tab page, and the Web Store.',
  }
}

const LOADING: PageStatus = { kind: 'loading', swapped: 0, language: 'es' }

// Ask the active tab's content script for its status. Any failure to reach one
// means there is no content script there, which is itself an answer — the tab's
// URL (fetched with the same query) then tells describeNoScript why.
async function queryActiveTab(): Promise<PopupPageStatus> {
  let tab: chrome.tabs.Tab | undefined
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  } catch {
    return { kind: 'no-script', url: undefined }
  }
  if (typeof tab?.id !== 'number') return { kind: 'no-script', url: tab?.url }

  try {
    const reply = chrome.tabs.sendMessage(tab.id, { type: PAGE_STATUS_MESSAGE })
    const timeout = new Promise<PageStatus>(resolve =>
      setTimeout(() => resolve(LOADING), QUERY_TIMEOUT_MS))

    return (await Promise.race([reply, timeout]) as PageStatus | undefined)
      ?? { kind: 'no-script', url: tab.url }
  } catch {
    return { kind: 'no-script', url: tab.url }
  }
}

export function renderPageStatus(container: HTMLElement): void {
  const section = document.createElement('div')
  section.className = 'section page-status'
  // The one line users check to answer "is it working?", so announce updates.
  section.setAttribute('role', 'status')
  section.setAttribute('aria-live', 'polite')

  const row = document.createElement('div')
  row.className = 'page-status__row'

  const dot = document.createElement('span')
  dot.className = 'page-status__dot'

  const text = document.createElement('div')
  const headline = document.createElement('div')
  headline.className = 'page-status__headline'
  const hint = document.createElement('div')
  hint.className = 'page-status__hint'

  text.appendChild(headline)
  text.appendChild(hint)
  row.appendChild(dot)
  row.appendChild(text)
  section.appendChild(row)
  container.appendChild(section)

  // Only the newest query may paint: a settings change can overtake an in-flight
  // one, and the stale reply would describe the previous language.
  let queryToken = 0

  async function refresh(loadingRetriesLeft = MAX_LOADING_RETRIES): Promise<void> {
    const token = ++queryToken
    const status = await queryActiveTab()
    if (token !== queryToken) return

    const copy = status.kind === 'no-script' ? describeNoScript(status.url) : describe(status)
    headline.textContent = copy.headline
    hint.textContent = copy.hint ?? ''
    hint.hidden = !copy.hint
    section.classList.toggle('is-working', copy.tone === 'working')

    if (status.kind === 'loading' && loadingRetriesLeft > 0) {
      setTimeout(() => {
        if (token === queryToken) void refresh(loadingRetriesLeft - 1)
      }, LOADING_RETRY_MS)
    }
  }

  void refresh()

  // Any settings write (language, density, toggles, blocked domains) changes what
  // the page renders. Give the content script a moment, then re-ask.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[SETTINGS_KEY]) return
    setTimeout(() => void refresh(), SETTLE_AFTER_CHANGE_MS)
  })
}
