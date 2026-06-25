import type { TargetLanguage, TranslationEntry } from '../types/index.js'
import type { ReplacementResult } from './articles.js'
import { buildSpanishReplacement } from './spanishAdapter.js'
import { buildGermanReplacement } from './germanAdapter.js'
import { buildFrenchReplacement } from './frenchAdapter.js'
import { buildItalianReplacement } from './italianAdapter.js'

type ReplacementBuilder = (
  entry: TranslationEntry,
  fullText: string,
  wordStart: number,
  isPlural: boolean,
) => ReplacementResult

const BUILDERS: Record<TargetLanguage, ReplacementBuilder> = {
  es: buildSpanishReplacement,
  de: buildGermanReplacement,
  fr: buildFrenchReplacement,
  it: buildItalianReplacement,
}

// Render a target-language replacement for `entry`, applying the active language's
// article + gender + plural + élision/capitalization rules.
export function buildReplacement(
  targetLanguage: TargetLanguage,
  entry: TranslationEntry,
  fullText: string,
  wordStart: number,
  isPlural: boolean,
): ReplacementResult {
  return BUILDERS[targetLanguage](entry, fullText, wordStart, isPlural)
}
