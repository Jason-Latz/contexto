import type { Gender, TargetLanguage } from '../types/index.js'

export interface LanguageInfo {
  code: TargetLanguage
  // English display name shown in the popup picker.
  displayName: string
  // Endonym, shown alongside the English name.
  endonym: string
  // Genders this language's nouns may carry (validation + data import enforce this).
  genders: ReadonlyArray<Gender>
  // BCP-47 lang attribute for rendered target text (drives correct speech/spellcheck).
  htmlLang: string
}

// The single source of truth for which target languages exist and their metadata.
// Order is the order shown in the popup picker.
export const LANGUAGES: readonly LanguageInfo[] = [
  { code: 'es', displayName: 'Spanish', endonym: 'Español', genders: ['masculine', 'feminine'], htmlLang: 'es' },
  { code: 'de', displayName: 'German', endonym: 'Deutsch', genders: ['masculine', 'feminine', 'neuter'], htmlLang: 'de' },
  { code: 'fr', displayName: 'French', endonym: 'Français', genders: ['masculine', 'feminine'], htmlLang: 'fr' },
  { code: 'it', displayName: 'Italian', endonym: 'Italiano', genders: ['masculine', 'feminine'], htmlLang: 'it' },
] as const

const BY_CODE: Record<TargetLanguage, LanguageInfo> = Object.fromEntries(
  LANGUAGES.map((info) => [info.code, info]),
) as Record<TargetLanguage, LanguageInfo>

export function getLanguageInfo(code: TargetLanguage): LanguageInfo {
  return BY_CODE[code]
}

export function isTargetLanguage(value: unknown): value is TargetLanguage {
  return typeof value === 'string' && value in BY_CODE
}
