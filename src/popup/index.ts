import type { LexiconEntry } from '../types/index.js'
import { renderStatsPanel } from './StatsPanel.js'
import { renderDensitySlider } from './DensitySlider.js'
import { renderUnknownWordsList } from './UnknownWordsList.js'

const LEXICON_KEY  = 'contexto_lexicon'
const SESSION_KEY  = 'contexto_session'
const SETTINGS_KEY = 'contexto_settings'

interface SessionStore {
  wordsSeen?: Array<{ englishLemma: string }>
}

interface PopupSettings {
  replacementsEnabled?: boolean
  quizzesEnabled?: boolean
  blockedDomains?: string[]
  [key: string]: unknown
}

async function init(): Promise<void> {
  const root = document.getElementById('root')!

  const stored = await chrome.storage.local.get([LEXICON_KEY, SESSION_KEY, SETTINGS_KEY])
  const lexicon  = (stored[LEXICON_KEY]  ?? {}) as Record<string, LexiconEntry>
  const session  = (stored[SESSION_KEY]  ?? {}) as SessionStore
  const settings = (stored[SETTINGS_KEY] ?? {}) as PopupSettings

  renderLanguagePanel(root)
  renderFeatureToggles(root, settings)

  // Stats — session word count, unknown words, learning queue size.
  renderStatsPanel(root, lexicon, session)

  // Density slider — reads and writes chrome.storage.local directly.
  await renderDensitySlider(root)

  renderBlockedDomains(root, settings)

  // Unknown words list — all / session filter with local exports.
  const sessionLemmas = new Set(
    (session.wordsSeen ?? []).map(w => w.englishLemma),
  )
  await renderUnknownWordsList(root, lexicon, sessionLemmas)
}

init().catch((err) => {
  console.warn('[Contexto] Popup failed to initialise:', err)
  const root = document.getElementById('root')
  if (root && !root.querySelector('.section')) {
    const notice = document.createElement('div')
    notice.className = 'section'
    notice.textContent = 'Could not load extension data. Try reopening the popup.'
    root.appendChild(notice)
  }
})

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

async function updateSettings(patch: Partial<PopupSettings>): Promise<void> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY)
  const current = (stored[SETTINGS_KEY] ?? {}) as PopupSettings
  await chrome.storage.local.set({
    [SETTINGS_KEY]: { ...current, ...patch },
  })
}

function renderFeatureToggles(container: HTMLElement, initialSettings: PopupSettings): void {
  const settings: Required<Pick<PopupSettings, 'replacementsEnabled' | 'quizzesEnabled'>> = {
    replacementsEnabled: initialSettings.replacementsEnabled ?? true,
    quizzesEnabled: initialSettings.quizzesEnabled ?? false,
  }

  const section = document.createElement('div')
  section.className = 'section'

  const title = document.createElement('div')
  title.className = 'section-title'
  title.textContent = 'Features'

  const rows = document.createElement('div')
  rows.className = 'toggle-list'

  const replacementToggle = buildToggleRow(
    'Text Replacement',
    settings.replacementsEnabled,
    async enabled => {
      settings.replacementsEnabled = enabled
      await updateSettings({ replacementsEnabled: enabled })
    },
  )

  const quizToggle = buildToggleRow(
    'Quizzes',
    settings.quizzesEnabled,
    async enabled => {
      settings.quizzesEnabled = enabled
      await updateSettings({ quizzesEnabled: enabled })
    },
  )

  rows.appendChild(replacementToggle)
  rows.appendChild(quizToggle)
  section.appendChild(title)
  section.appendChild(rows)
  container.appendChild(section)
}

function buildToggleRow(
  labelText: string,
  initialEnabled: boolean,
  onChange: (enabled: boolean) => Promise<void>,
): HTMLDivElement {
  let enabled = initialEnabled

  const row = document.createElement('div')
  row.className = 'toggle-row'

  const label = document.createElement('span')
  label.className = 'toggle-label'
  label.textContent = labelText

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'toggle-button'

  function render(): void {
    button.textContent = enabled ? 'On' : 'Off'
    button.setAttribute('aria-pressed', String(enabled))
    button.classList.toggle('is-on', enabled)
  }

  button.addEventListener('click', () => {
    enabled = !enabled
    render()
    void onChange(enabled)
  })

  render()
  row.appendChild(label)
  row.appendChild(button)
  return row
}

function renderBlockedDomains(container: HTMLElement, settings: PopupSettings): void {
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
        void updateSettings({ blockedDomains })
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
    void updateSettings({ blockedDomains })
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
