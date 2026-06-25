/**
 * LanguagePicker.ts — Target-language segmented control for the popup.
 *
 * Lists every language in the registry (English name + endonym) as a pill
 * group, marks the active one with aria-pressed, and calls back on change. The
 * caller (index.ts) owns persistence and re-rendering the language-dependent
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
  let current = activeLanguage

  const section = document.createElement('div')
  section.className = 'section'

  const title = document.createElement('div')
  title.className = 'section-title'
  title.id = 'language-picker-label'
  title.textContent = 'Target Language'

  const group = document.createElement('div')
  group.className = 'lang-picker'
  group.setAttribute('role', 'group')
  group.setAttribute('aria-labelledby', 'language-picker-label')

  const buttons = new Map<TargetLanguage, HTMLButtonElement>()

  function syncPressed(): void {
    for (const [code, btn] of buttons) {
      const isActive = code === current
      btn.setAttribute('aria-pressed', String(isActive))
      btn.classList.toggle('is-active', isActive)
    }
  }

  for (const info of LANGUAGES) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'lang-option'
    btn.lang = info.htmlLang
    // English name leads (matches the rest of the UI's language); the endonym is
    // a quieter sub-label so a learner recognises the language by sight too.
    btn.setAttribute('aria-label', `${info.displayName} (${info.endonym})`)

    const name = document.createElement('span')
    name.className = 'lang-option__name'
    name.textContent = info.displayName

    const endonym = document.createElement('span')
    endonym.className = 'lang-option__endonym'
    endonym.textContent = info.endonym

    btn.appendChild(name)
    btn.appendChild(endonym)

    btn.addEventListener('click', () => {
      if (current === info.code) return
      current = info.code
      syncPressed()
      void handlers.onChange(info.code)
    })

    buttons.set(info.code, btn)
    group.appendChild(btn)
  }

  syncPressed()

  section.appendChild(title)
  section.appendChild(group)
  container.appendChild(section)
}
