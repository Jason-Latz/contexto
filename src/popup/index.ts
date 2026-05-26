import type { LexiconEntry } from '../types/index.js'
import { renderStatsPanel } from './StatsPanel.js'
import { renderDensitySlider } from './DensitySlider.js'
import { renderKnownWordsList } from './KnownWordsList.js'

const LEXICON_KEY  = 'contexto_lexicon'
const SESSION_KEY  = 'contexto_session'
const SETTINGS_KEY = 'contexto_settings'

interface SessionStore {
  wordsSeen?: Array<{ englishLemma: string }>
}

async function init(): Promise<void> {
  const root = document.getElementById('root')!

  const stored = await chrome.storage.local.get([LEXICON_KEY, SESSION_KEY, SETTINGS_KEY])
  const lexicon  = (stored[LEXICON_KEY]  ?? {}) as Record<string, LexiconEntry>
  const session  = (stored[SESSION_KEY]  ?? {}) as SessionStore
  const settings = stored[SETTINGS_KEY] ?? {}

  renderLanguagePanel(root)

  // Stats — session word count, known words, learning queue size.
  renderStatsPanel(root, lexicon, session)

  // Density slider — reads and writes chrome.storage.local directly.
  await renderDensitySlider(root)

  renderBlockedDomains(root, settings)

  // Known words list — all / session filter.
  const sessionLemmas = new Set(
    (session.wordsSeen ?? []).map(w => w.englishLemma),
  )
  renderKnownWordsList(root, lexicon, sessionLemmas)
}

init()

function renderLanguagePanel(container: HTMLElement): void {
  const section = document.createElement('div')
  section.className = 'section'

  const title = document.createElement('div')
  title.className = 'section-title'
  title.textContent = 'Target Language'

  const value = document.createElement('div')
  value.className = 'stat-value'
  value.textContent = 'Spanish'

  section.appendChild(title)
  section.appendChild(value)
  container.appendChild(section)
}

function renderBlockedDomains(container: HTMLElement, settings: any): void {
  const blockedDomains = Array.isArray(settings.blockedDomains)
    ? settings.blockedDomains as string[]
    : []

  const section = document.createElement('div')
  section.className = 'section'

  const title = document.createElement('div')
  title.className = 'section-title'
  title.textContent = 'Blocked Domains'

  const form = document.createElement('form')
  form.className = 'domain-form'

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'example.com'
  input.className = 'domain-input'

  const addBtn = document.createElement('button')
  addBtn.type = 'submit'
  addBtn.textContent = 'Block'
  addBtn.className = 'domain-button'

  const list = document.createElement('div')
  list.className = 'domain-list'

  function renderList(): void {
    while (list.firstChild) list.removeChild(list.firstChild)
    if (blockedDomains.length === 0) {
      const empty = document.createElement('span')
      empty.className = 'empty-msg'
      empty.textContent = 'No blocked domains.'
      list.appendChild(empty)
      return
    }

    for (const domain of blockedDomains) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'domain-chip'
      row.textContent = `${domain} ×`
      row.addEventListener('click', () => {
        const index = blockedDomains.indexOf(domain)
        if (index >= 0) blockedDomains.splice(index, 1)
        void chrome.storage.local.set({
          [SETTINGS_KEY]: { ...settings, blockedDomains },
        })
        renderList()
      })
      list.appendChild(row)
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault()
    const domain = input.value.trim().toLowerCase().replace(/^www\./, '')
    if (!domain || blockedDomains.includes(domain)) return
    blockedDomains.push(domain)
    blockedDomains.sort()
    input.value = ''
    void chrome.storage.local.set({
      [SETTINGS_KEY]: { ...settings, blockedDomains },
    })
    renderList()
  })

  form.appendChild(input)
  form.appendChild(addBtn)
  section.appendChild(title)
  section.appendChild(form)
  section.appendChild(list)
  renderList()
  container.appendChild(section)
}
