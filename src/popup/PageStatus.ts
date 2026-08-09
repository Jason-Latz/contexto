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

// Keep the active tab identity alongside its answer so every status can offer a
// direct recovery action (pause/resume/enable/reload) without another query.
// For pages with a content script, the reply's hostname is authoritative because
// Chrome may withhold tab.url even while that content script can answer.
interface PopupPageStatus {
  status: PageStatus | null
  url: string | undefined
  tabId: number | undefined
}

export interface PageSessionSnapshot {
  replacedThisSession: number
  sessionLemmas: string[]
}

// Runtime-normalize because an already-open tab can keep running the previous
// content-script version after an extension update. Missing/malformed lemma data
// must fail closed to an empty active-page session, never revive a stale global
// storage snapshot. Deriving the count from the normalized set keeps both popup
// surfaces coherent even if a reply's explicit count is inconsistent.
export function normalizePageSession(
  status: { sessionLemmas?: unknown; replacedThisSession?: unknown } | null | undefined,
): PageSessionSnapshot {
  if (!Array.isArray(status?.sessionLemmas)) {
    return { replacedThisSession: 0, sessionLemmas: [] }
  }

  const sessionLemmas = [...new Set(
    status.sessionLemmas.filter(
      (lemma): lemma is string => typeof lemma === 'string' && lemma.length > 0,
    ),
  )]
  return { replacedThisSession: sessionLemmas.length, sessionLemmas }
}

export function describe(status: PageStatus): StatusCopy {
  switch (status.kind) {
    case 'communication-site':
      return {
        tone: 'idle',
        headline: 'Disabled on email and chat sites.',
        hint: 'Contexto never changes pages where text could become an outgoing message.',
      }
    case 'active': {
      if (status.swapped === 0) {
        return {
          tone: 'idle',
          headline: 'No eligible words found on this page.',
          hint: 'Your immersion amount, word types, and available vocabulary all affect what can change.',
        }
      }
      const language = getLanguageInfo(status.language).displayName
      const words = status.swapped === 1 ? '1 word' : `${status.swapped} words`
      return { tone: 'working', headline: `${words} changed to ${language} on this page.` }
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
        hint: 'Resume here whenever you want to continue immersing.',
      }
    case 'paused':
      return {
        tone: 'idle',
        headline: 'Waiting for permission on this site.',
        hint: 'Contexto pauses by default on medical, legal, financial, and other sensitive sites.',
      }
    case 'off':
      return {
        tone: 'idle',
        headline: 'Contexto is off everywhere.',
        hint: 'Turn it on here or with the control directly below.',
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

const LOADING: PageStatus = {
  kind: 'loading',
  swapped: 0,
  replacedThisSession: 0,
  sessionLemmas: [],
  language: 'es',
}

// Ask the active tab's content script for its status. Any failure to reach one
// means there is no content script there, which is itself an answer — the tab's
// URL (fetched with the same query) then tells describeNoScript why.
async function queryActiveTab(): Promise<PopupPageStatus> {
  let tab: chrome.tabs.Tab | undefined
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  } catch {
    return { status: null, url: undefined, tabId: undefined }
  }
  if (typeof tab?.id !== 'number') {
    return { status: null, url: tab?.url, tabId: undefined }
  }

  try {
    const reply = chrome.tabs.sendMessage(tab.id, { type: PAGE_STATUS_MESSAGE })
    const timeout = new Promise<PageStatus>(resolve =>
      setTimeout(() => resolve(LOADING), QUERY_TIMEOUT_MS))

    return {
      status: (await Promise.race([reply, timeout]) as PageStatus | undefined) ?? null,
      url: tab.url,
      tabId: tab.id,
    }
  } catch {
    return { status: null, url: tab.url, tabId: tab.id }
  }
}

function hostnameFromUrl(url: string | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

async function updateSettings(
  mutate: (settings: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY)
  const current = (stored[SETTINGS_KEY] ?? {}) as Record<string, unknown>
  await chrome.storage.local.set({ [SETTINGS_KEY]: mutate(current) })
}

interface StatusAction {
  label: string
  run: () => Promise<void>
}

function actionFor(result: PopupPageStatus): StatusAction | null {
  const hostname = result.status?.hostname || hostnameFromUrl(result.url)
  const kind = result.status?.kind

  if (kind === 'active' && hostname) {
    return {
      label: 'Pause on this site',
      run: () => updateSettings(settings => {
        const blocked = Array.isArray(settings.blockedDomains)
          ? settings.blockedDomains.filter((item): item is string => typeof item === 'string')
          : []
        return {
          ...settings,
          blockedDomains: [...new Set([...blocked, hostname])].sort(),
        }
      }),
    }
  }

  if (kind === 'blocked' && hostname) {
    return {
      label: 'Resume on this site',
      run: () => updateSettings(settings => {
        const blocked = Array.isArray(settings.blockedDomains)
          ? settings.blockedDomains.filter((item): item is string => typeof item === 'string')
          : []
        return {
          ...settings,
          // Remove every parent-domain rule that currently covers this hostname;
          // otherwise a button labelled Resume would appear to do nothing.
          blockedDomains: blocked.filter(domain =>
            hostname !== domain && !hostname.endsWith(`.${domain}`)),
        }
      }),
    }
  }

  if (kind === 'paused' && hostname) {
    return {
      label: 'Enable on this site',
      run: () => updateSettings(settings => ({
        ...settings,
        domainDecisions: {
          ...(
            settings.domainDecisions && typeof settings.domainDecisions === 'object'
              ? settings.domainDecisions as Record<string, boolean>
              : {}
          ),
          [hostname]: true,
        },
      })),
    }
  }

  if (kind === 'off') {
    return {
      label: 'Turn Contexto on',
      run: () => updateSettings(settings => ({ ...settings, replacementsEnabled: true })),
    }
  }

  if ((kind === 'error' || result.status === null) && result.tabId !== undefined && hostname) {
    const tabId = result.tabId
    return {
      label: 'Reload this tab',
      run: () => chrome.tabs.reload(tabId),
    }
  }

  return null
}

export function renderPageStatus(
  container: HTMLElement,
  onPageSession: (snapshot: PageSessionSnapshot) => void = () => {},
): void {
  const section = document.createElement('div')
  section.className = 'section page-status'

  const row = document.createElement('div')
  row.className = 'page-status__row'

  const dot = document.createElement('span')
  dot.className = 'page-status__dot'

  const text = document.createElement('div')
  text.className = 'page-status__text'
  // The one line users check to answer "is it working?", so announce updates
  // without putting the adjacent action button inside a live-status role.
  text.setAttribute('role', 'status')
  text.setAttribute('aria-live', 'polite')
  const headline = document.createElement('div')
  headline.className = 'page-status__headline'
  const hint = document.createElement('div')
  hint.className = 'page-status__hint'

  text.appendChild(headline)
  text.appendChild(hint)
  row.appendChild(dot)
  row.appendChild(text)
  section.appendChild(row)

  const action = document.createElement('button')
  action.type = 'button'
  action.className = 'page-status__action'
  action.hidden = true
  section.appendChild(action)
  container.appendChild(section)

  // Only the newest query may paint: a settings change can overtake an in-flight
  // one, and the stale reply would describe the previous language.
  let queryToken = 0

  async function refresh(loadingRetriesLeft = MAX_LOADING_RETRIES): Promise<void> {
    const token = ++queryToken
    const result = await queryActiveTab()
    if (token !== queryToken) return

    // The active content script owns the authoritative in-memory page session.
    // A no-script response has no readable session; normalizePageSession also
    // provides the empty fallback for a timeout or an older content script.
    onPageSession(normalizePageSession(result.status))

    const copy = result.status ? describe(result.status) : describeNoScript(result.url)
    headline.textContent = copy.headline
    hint.textContent = copy.hint ?? ''
    hint.hidden = !copy.hint
    section.classList.toggle('is-working', copy.tone === 'working')

    const nextAction = actionFor(result)
    action.hidden = nextAction === null
    action.disabled = false
    action.textContent = nextAction?.label ?? ''
    action.onclick = nextAction
      ? () => {
          action.disabled = true
          action.textContent = 'Working…'
          void nextAction.run()
            .then(() => setTimeout(() => void refresh(), SETTLE_AFTER_CHANGE_MS))
            .catch(() => {
              action.disabled = false
              action.textContent = nextAction.label
            })
        }
      : null

    if (result.status?.kind === 'loading' && loadingRetriesLeft > 0) {
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
