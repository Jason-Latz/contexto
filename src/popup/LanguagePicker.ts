/**
 * LanguagePicker.ts — Compact target-language selector for the popup.
 *
 * Lists every language in a compact native selector (English name + endonym)
 * and calls back on change. The caller (index.ts) owns persistence and
 * re-rendering the language-dependent
 * panels — this module is DOM-only and never touches storage.
 */

import type { TargetLanguage } from '../types/index.js'
import { LANGUAGES } from '../language/registry.js'

export interface LanguagePickerHandlers {
  // Fired when the user selects a different language. The caller persists the
  // choice and re-renders the language-dependent panels.
  onChange: (language: TargetLanguage) => void | Promise<void>
}

export function renderLanguagePicker(
  container: HTMLElement,
  activeLanguage: TargetLanguage,
  handlers: LanguagePickerHandlers,
): void {
  const section = document.createElement('div')
  section.className = 'section'

  const title = document.createElement('div')
  title.className = 'section-title'
  title.id = 'language-picker-label'
  title.textContent = 'Target Language'

  const select = document.createElement('select')
  select.className = 'lang-select'
  select.setAttribute('aria-labelledby', 'language-picker-label')

  for (const info of LANGUAGES) {
    const option = document.createElement('option')
    option.value = info.code
    option.textContent = `${info.displayName} — ${info.endonym}`
    option.lang = info.htmlLang
    option.selected = info.code === activeLanguage
    select.appendChild(option)
  }

  select.addEventListener('change', () => {
    const language = select.value as TargetLanguage
    void handlers.onChange(language)
  })

  section.appendChild(title)
  section.appendChild(select)
  container.appendChild(section)
}
