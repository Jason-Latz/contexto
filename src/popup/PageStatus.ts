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
 * A tab with no content script (browser pages, the Web Store, a tab opened before
 * the extension was installed) rejects the message. That is 'unreachable', which
 * is an answer, not a failure.
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

interface StatusCopy {
  headline: string
  hint?: string
  // Drives the dot colour: is Contexto doing its job on this page?
  tone: 'working' | 'idle'
}

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
    case 'unreachable':
      return {
        tone: 'idle',
        headline: 'Contexto does not run on this page.',
        hint: 'Browser pages and the Chrome Web Store are off limits. Tabs opened before Contexto was installed need a reload.',
      }
  }
}

const LOADING: PageStatus = { kind: 'loading', swapped: 0, language: 'es' }
const UNREACHABLE: PageStatus = { kind: 'unreachable', swapped: 0, language: 'es' }

// Ask the active tab's content script for its status. Any failure to reach one
// means there is no content script there, which is itself the answer.
async function queryActiveTab(): Promise<PageStatus> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (typeof tab?.id !== 'number') return UNREACHABLE

    const reply = chrome.tabs.sendMessage(tab.id, { type: PAGE_STATUS_MESSAGE })
    const timeout = new Promise<PageStatus>(resolve =>
      setTimeout(() => resolve(LOADING), QUERY_TIMEOUT_MS))

    return (await Promise.race([reply, timeout]) as PageStatus | undefined) ?? UNREACHABLE
  } catch {
    return UNREACHABLE
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

    const copy = describe(status)
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
