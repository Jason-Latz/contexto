import type { LexiconEntry, TargetLanguage } from '../types/index.js'
import { isTargetLanguage } from '../language/registry.js'
import {
  loadLexicon,
  getEntry,
  markUnknown,
  updateEntry,
  flushLexiconMerge,
} from '../store/lexiconStore.js'
import { renderStatsPanel } from './StatsPanel.js'
import { renderDensitySlider } from './DensitySlider.js'
import { renderLanguagePicker } from './LanguagePicker.js'
import { renderUnknownWordsList, type UnknownWordsListHandlers } from './UnknownWordsList.js'

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
  targetLanguage?: TargetLanguage
  [key: string]: unknown
}

const DEFAULT_TARGET_LANGUAGE: TargetLanguage = 'es'

function readTargetLanguage(settings: PopupSettings): TargetLanguage {
  return isTargetLanguage(settings.targetLanguage)
    ? settings.targetLanguage
    : DEFAULT_TARGET_LANGUAGE
}

async function init(): Promise<void> {
  const root = document.getElementById('root')!

  const stored = await chrome.storage.local.get([LEXICON_KEY, SESSION_KEY, SETTINGS_KEY])
  const lexicon  = (stored[LEXICON_KEY]  ?? {}) as Record<string, LexiconEntry>
  const session  = (stored[SESSION_KEY]  ?? {}) as SessionStore
  const settings = (stored[SETTINGS_KEY] ?? {}) as PopupSettings

  // Load the lexicon store so mark-known / practice writes go through the
  // clobber-safe merge path instead of overwriting the whole map.
  await loadLexicon()

  let activeLanguage = readTargetLanguage(settings)

  renderLanguagePicker(root, activeLanguage, {
    // Persist the choice, then rebuild the language-dependent panels so the
    // Practice + Unknown Words cards immediately reflect the new pack.
    onChange: async (language) => {
      activeLanguage = language
      await updateSettings({ targetLanguage: language })
      await renderLanguageDependentPanels()
    },
  })
  renderFeatureToggles(root, settings)

  // Stats — session word count, unknown words, learning queue size.
  const statsHandle = renderStatsPanel(root, lexicon, session)

  // Density slider — reads and writes chrome.storage.local directly.
  await renderDensitySlider(root)

  renderBlockedDomains(root, settings)

  // Unknown words list — all / session filter with local exports.
  const sessionLemmas = new Set(
    (session.wordsSeen ?? []).map(w => w.englishLemma),
  )

  const handlers: UnknownWordsListHandlers = {
    // Soft-remove: drop from the review list without permanently excluding the
    // word from replacement (markUnknown(false) leaves selfMarkedKnown untouched).
    onMarkKnown: async (lemma) => {
      markUnknown(lemma, false)
      await flushLexiconMerge()
    },
    // Restore with the ORIGINAL save time so the word returns to its old slot.
    onRestore: async (lemma, markedAt) => {
      updateEntry(lemma, {
        ...getEntry(lemma),
        selfMarkedUnknown: true,
        selfMarkedUnknownAt: markedAt,
        selfMarkedKnown: false,
      })
      await flushLexiconMerge()
    },
    onUnknownTotalChange: (total) => statsHandle.setSavedUnknown(total),
  }

  // Container the language-dependent Unknown Words / Practice panels live in, so
  // a language switch can rebuild them in place without re-rendering the popup.
  const languagePanels = document.createElement('div')
  languagePanels.className = 'lang-dependent'
  root.appendChild(languagePanels)

  async function renderLanguageDependentPanels(): Promise<void> {
    while (languagePanels.firstChild) languagePanels.removeChild(languagePanels.firstChild)
    await renderUnknownWordsList(languagePanels, lexicon, sessionLemmas, handlers, activeLanguage)
  }

  await renderLanguageDependentPanels()
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

async function updateSettings(patch: Partial<PopupSettings>): Promise<void> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY)
  const current = (stored[SETTINGS_KEY] ?? {}) as PopupSettings
  await chrome.storage.local.set({
    [SETTINGS_KEY]: { ...current, ...patch },
  })
}

function renderFeatureToggles(container: HTMLElement, initialSettings: PopupSettings): void {
  const settings = {
    replacementsEnabled: initialSettings.replacementsEnabled ?? true,
    quizzesEnabled: initialSettings.quizzesEnabled ?? false,
    aggressiveMode: (initialSettings.aggressiveMode as boolean | undefined) ?? false,
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

  // Aggressive mode injects the quarantined niche "tail" vocabulary (rare,
  // low-confidence words). Off by default — opting in trades precision for reach.
  const aggressiveToggle = buildToggleRow(
    'Aggressive Mode',
    settings.aggressiveMode,
    async enabled => {
      settings.aggressiveMode = enabled
      await updateSettings({ aggressiveMode: enabled })
    },
    'Also swap rare niche words (larger vocabulary, lower accuracy).',
  )

  rows.appendChild(replacementToggle)
  rows.appendChild(quizToggle)
  rows.appendChild(aggressiveToggle)
  section.appendChild(title)
  section.appendChild(rows)
  container.appendChild(section)
}

function buildToggleRow(
  labelText: string,
  initialEnabled: boolean,
  onChange: (enabled: boolean) => Promise<void>,
  hintText?: string,
): HTMLDivElement {
  let enabled = initialEnabled

  const row = document.createElement('div')
  row.className = 'toggle-row'

  const label = document.createElement('span')
  label.className = 'toggle-label'
  label.textContent = labelText

  // Optional secondary line under the label, for toggles that need a word of
  // explanation (e.g. aggressive mode). Kept inside the label cell so the On/Off
  // button stays vertically centered against the label+hint block.
  if (hintText) {
    const wrap = document.createElement('span')
    const hint = document.createElement('span')
    hint.className = 'toggle-hint'
    hint.textContent = hintText
    wrap.appendChild(label)
    wrap.appendChild(hint)
    row.appendChild(wrap)
  }

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
  // When there's a hint the label is already inside a wrapper appended above.
  if (!hintText) row.appendChild(label)
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
