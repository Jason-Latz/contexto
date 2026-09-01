import type { OnboardingLevel, PartOfSpeech, TargetLanguage } from '../types/index.js'
import { getLanguageInfo, isTargetLanguage } from '../language/registry.js'
import { DEFAULT_DISABLED_PARTS_OF_SPEECH } from '../store/settingsStore.js'
import {
  getLexiconForStorage,
  loadLexicon,
  getEntry,
  markUnknown,
  updateEntry,
  flushLexiconMerge,
} from '../store/lexiconStore.js'
import { renderDensitySlider } from './DensitySlider.js'
import { renderLanguagePicker } from './LanguagePicker.js'
import { renderPageStatus } from './PageStatus.js'
import {
  renderUnknownWordsList,
  type UnknownWordsListHandle,
  type UnknownWordsListHandlers,
} from './UnknownWordsList.js'

const SETTINGS_KEY = 'contexto_settings'

interface PopupSettings {
  replacementsEnabled?: boolean
  blockedDomains?: string[]
  targetLanguage?: TargetLanguage
  level?: OnboardingLevel | null
  languageLevels?: Partial<Record<TargetLanguage, OnboardingLevel>>
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

  const stored = await chrome.storage.local.get(SETTINGS_KEY)
  const settings = (stored[SETTINGS_KEY] ?? {}) as PopupSettings

  let activeLanguage = readTargetLanguage(settings)
  let languageChangeVersion = 0
  let targetLanguageWriteChain: Promise<void> = Promise.resolve()

  // Keep target-language settings writes ordered without making pack loads wait
  // on one another. The popup can therefore render the newest choice promptly,
  // while storage still settles in the same order as the user's selections.
  function persistTargetLanguage(language: TargetLanguage): Promise<void> {
    const run = targetLanguageWriteChain.then(() => updateSettings({ targetLanguage: language }))
    targetLanguageWriteChain = run.catch(() => {})
    return run
  }

  // Learning state belongs to the selected target language. Loading through the
  // store also performs the one-time migration from the original shared map.
  await loadLexicon(activeLanguage)
  let lexicon = getLexiconForStorage()

  let latestSessionLemmas = new Set<string>()
  let liveUnknownWordsHandle: UnknownWordsListHandle | null = null
  let advancedSettingsElement: HTMLDetailsElement | null = null

  // First card: what Contexto is doing on the page behind the popup. Answers
  // "is this thing working?" before the user has to guess from the controls.
  // Fills in asynchronously — the controls below must never wait on the page.
  renderPageStatus(root, snapshot => {
    latestSessionLemmas = new Set(snapshot.sessionLemmas)
    liveUnknownWordsHandle?.setSessionLemmas(latestSessionLemmas)
  })

  // Jason's preferred quick-control order: global on/off and immersion amount
  // stay at the top, immediately after the current-page status.
  renderFeatureToggles(root, settings)
  await renderDensitySlider(root)

  renderLanguagePicker(root, activeLanguage, {
    // Persist the choice, then rebuild the language-dependent panels so the
    // Practice + Saved Words card immediately reflects the new pack.
    onChange: async (language) => {
      const changeVersion = ++languageChangeVersion
      activeLanguage = language
      settings.targetLanguage = language
      // The list's handlers mutate the module-global lexicon store. Remove the
      // old language's controls before that store can switch underneath them;
      // the replacement panel is staged off-DOM and committed when ready.
      liveUnknownWordsHandle = null
      languagePanels.replaceChildren()
      await persistTargetLanguage(language)
      if (changeVersion !== languageChangeVersion) return
      await loadLexicon(language)
      if (changeVersion !== languageChangeVersion) return
      const nextLexicon = getLexiconForStorage()
      lexicon = nextLexicon
      latestSessionLemmas = new Set()
      const rendered = await renderLanguageDependentPanels(
        language,
        nextLexicon,
        () => changeVersion === languageChangeVersion,
      )
      if (!rendered) return
      if (advancedSettingsElement) {
        advancedSettingsElement.remove()
        advancedSettingsElement = renderAdvancedSettings(root, settings, language)
      }
    },
  })

  const handlers: UnknownWordsListHandlers = {
    // Remove from Saved Words without claiming the learner knows it or excluding
    // it from future replacement (markUnknown(false) leaves known state untouched).
    onRemoveSaved: async (lemma) => {
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
  }

  // Container the language-dependent Saved Words / Practice panel lives in, so
  // a language switch can rebuild them in place without re-rendering the popup.
  const languagePanels = document.createElement('div')
  languagePanels.className = 'lang-dependent'
  root.appendChild(languagePanels)

  async function renderLanguageDependentPanels(
    panelLanguage: TargetLanguage = activeLanguage,
    panelLexicon: Record<string, typeof lexicon[string]> = lexicon,
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    // Build off-DOM across the awaited pack load. A superseded render can then
    // be discarded without appending a stale second card beside the latest one.
    const staging = document.createElement('div')
    const handle = await renderUnknownWordsList(
      staging,
      panelLexicon,
      latestSessionLemmas,
      handlers,
      panelLanguage,
    )
    if (!isCurrent()) return false

    liveUnknownWordsHandle = null
    languagePanels.replaceChildren(...staging.childNodes)
    liveUnknownWordsHandle = handle
    // The active-tab reply can land while the language pack is loading.
    handle.setSessionLemmas(latestSessionLemmas)
    return true
  }

  const initialLanguageVersion = languageChangeVersion
  await renderLanguageDependentPanels(
    activeLanguage,
    lexicon,
    () => initialLanguageVersion === languageChangeVersion,
  )
  advancedSettingsElement = renderAdvancedSettings(root, settings, activeLanguage)
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
  }

  const section = document.createElement('div')
  section.className = 'section'

  const title = document.createElement('div')
  title.className = 'section-title'
  title.textContent = 'Contexto Everywhere'

  const rows = document.createElement('div')
  rows.className = 'toggle-list'

  const replacementToggle = buildToggleRow(
    'Replace words on websites',
    settings.replacementsEnabled,
    async enabled => {
      settings.replacementsEnabled = enabled
      await updateSettings({ replacementsEnabled: enabled })
    },
  )

  rows.appendChild(replacementToggle)
  section.appendChild(title)
  section.appendChild(rows)
  container.appendChild(section)

  // A page-status recovery action can turn the global setting back on. Keep
  // this top control truthful without rebuilding the popup.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return
    const next = changes[SETTINGS_KEY]?.newValue as PopupSettings | undefined
    if (!next || typeof next.replacementsEnabled !== 'boolean') return
    settings.replacementsEnabled = next.replacementsEnabled
    replacementToggle.setEnabled(next.replacementsEnabled)
  })
}

function renderAdvancedSettings(
  container: HTMLElement,
  settings: PopupSettings,
  activeLanguage: TargetLanguage,
): HTMLDetailsElement {
  const details = document.createElement('details')
  details.className = 'section advanced-settings'

  const summary = document.createElement('summary')
  summary.className = 'advanced-settings__summary'
  summary.textContent = 'Advanced settings'

  const body = document.createElement('div')
  body.className = 'advanced-settings__body'
  renderVocabularyDifficulty(body, settings, activeLanguage)
  renderWordTypeToggles(body, settings)
  renderBlockedDomains(body, settings)

  const privacy = document.createElement('p')
  privacy.className = 'privacy-note'
  privacy.textContent = 'Processed on device. Page text and learning data never leave Chrome.'
  body.appendChild(privacy)

  const feedback = document.createElement('a')
  feedback.className = 'feedback-link'
  feedback.href = 'https://github.com/Jason-Latz/contexto/issues/new?labels=translation'
  feedback.target = '_blank'
  feedback.rel = 'noopener noreferrer'
  feedback.textContent = 'Report a translation issue ↗'
  body.appendChild(feedback)

  details.appendChild(summary)
  details.appendChild(body)
  container.appendChild(details)
  return details
}

function renderVocabularyDifficulty(
  container: HTMLElement,
  settings: PopupSettings,
  language: TargetLanguage,
): void {
  const levels = settings.languageLevels ?? {}
  let selected = levels[language] ?? settings.level ?? 'intermediate'

  const section = document.createElement('div')
  section.className = 'section'

  const title = document.createElement('div')
  title.className = 'section-title'
  title.textContent = 'Vocabulary Difficulty'

  const hint = document.createElement('p')
  hint.className = 'setting-hint'
  hint.textContent = `What Contexto assumes you already know in ${getLanguageInfo(language).displayName}. Separate from immersion amount.`

  const group = document.createElement('div')
  group.className = 'level-picker'
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', `${getLanguageInfo(language).displayName} vocabulary difficulty`)

  const options: Array<{ level: OnboardingLevel; label: string }> = [
    { level: 'beginner', label: 'New' },
    { level: 'intermediate', label: 'Some' },
    { level: 'advanced', label: 'Comfortable' },
  ]
  const buttons = new Map<OnboardingLevel, HTMLButtonElement>()

  function sync(): void {
    for (const [level, button] of buttons) {
      const active = level === selected
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-pressed', String(active))
    }
  }

  for (const option of options) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'level-option'
    button.textContent = option.label
    button.addEventListener('click', () => {
      if (selected === option.level) return
      selected = option.level
      settings.languageLevels = { ...(settings.languageLevels ?? {}), [language]: selected }
      sync()
      void updateSettings({ languageLevels: settings.languageLevels })
    })
    buttons.set(option.level, button)
    group.appendChild(button)
  }

  sync()
  section.appendChild(title)
  section.appendChild(hint)
  section.appendChild(group)
  container.appendChild(section)
}

// Which kinds of words get swapped. Verbs are off by default: Contexto cannot
// conjugate yet, so a verb renders as the dictionary infinitive — fine for
// vocabulary, but it reads less naturally, and the hint says so honestly.
function renderWordTypeToggles(container: HTMLElement, initialSettings: PopupSettings): void {
  const WORD_TYPES: Array<{ pos: PartOfSpeech; label: string; hint?: string }> = [
    { pos: 'noun', label: 'Nouns' },
    {
      pos: 'verb', label: 'Verbs',
      hint: 'Lower fidelity: verbs show as the dictionary form because conjugation is hard. Off by default.',
    },
    { pos: 'adjective', label: 'Adjectives' },
    { pos: 'adverb', label: 'Adverbs' },
    { pos: 'expression', label: 'Phrases' },
  ]

  const disabled = new Set<PartOfSpeech>(
    Array.isArray(initialSettings.disabledPartsOfSpeech)
      ? initialSettings.disabledPartsOfSpeech as PartOfSpeech[]
      : DEFAULT_DISABLED_PARTS_OF_SPEECH,
  )

  const section = document.createElement('div')
  section.className = 'section'

  const title = document.createElement('div')
  title.className = 'section-title'
  title.textContent = 'Word Types'

  const rows = document.createElement('div')
  rows.className = 'toggle-list'

  for (const { pos, label, hint } of WORD_TYPES) {
    rows.appendChild(buildToggleRow(label, !disabled.has(pos), async enabled => {
      if (enabled) disabled.delete(pos)
      else disabled.add(pos)
      await updateSettings({ disabledPartsOfSpeech: [...disabled].sort() })
    }, hint))
  }

  section.appendChild(title)
  section.appendChild(rows)
  container.appendChild(section)
}

type ToggleRow = HTMLDivElement & { setEnabled(value: boolean): void }

function buildToggleRow(
  labelText: string,
  initialEnabled: boolean,
  onChange: (enabled: boolean) => Promise<void>,
  hintText?: string,
): ToggleRow {
  let enabled = initialEnabled

  const row = document.createElement('div') as ToggleRow
  row.className = 'toggle-row'

  const label = document.createElement('span')
  label.className = 'toggle-label'
  label.textContent = labelText

  // Optional secondary line under the label, for toggles that need a word of
  // explanation (e.g. the Verbs word-type). Kept inside the label cell so the
  // On/Off button stays vertically centered against the label+hint block.
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
    const previous = enabled
    enabled = !previous
    render()
    button.disabled = true
    void onChange(enabled)
      .catch(() => {
        enabled = previous
        render()
      })
      .finally(() => { button.disabled = false })
  })

  render()
  row.setEnabled = (value: boolean) => {
    enabled = value
    render()
  }
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

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return
    const next = changes[SETTINGS_KEY]?.newValue as PopupSettings | undefined
    if (!next || !Array.isArray(next.blockedDomains)) return
    blockedDomains.splice(
      0,
      blockedDomains.length,
      ...next.blockedDomains.filter((domain): domain is string => typeof domain === 'string'),
    )
    renderList()
  })
}
