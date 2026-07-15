// ---------- Language pack schema ----------

export type SourceLanguage = 'en'
export type TargetLanguage = 'es' | 'de' | 'fr' | 'it'
export type PartOfSpeech = 'noun' | 'adverb' | 'adjective' | 'verb' | 'expression' | 'function'
export type EntryConfidence = 'high' | 'medium' | 'low'
// Grammatical gender across all supported target languages. Spanish, French and
// Italian use masculine/feminine; German adds neuter. Per-language validation
// enforces the allowed subset (see scripts/validate-language-packs.mjs).
export type Gender = 'masculine' | 'feminine' | 'neuter'
/** @deprecated use {@link Gender} — kept as an alias for older Spanish-only call sites. */
export type SpanishGender = Gender
export type FunctionSubtype = 'preposition' | 'conjunction' | 'determiner' | 'pronoun'

export interface LanguagePackSource {
  name: string
  url: string
  license: string
  version?: string
  fetchedAt?: string
  notes?: string
}

interface BaseTranslationEntry {
  source: string
  target: string
  partOfSpeech: PartOfSpeech
  sourceGloss: string
  frequencyRank: number
  confidence: EntryConfidence
  sourceIds: string[]
  // Quality/eligibility signals written offline by scripts/qa_language_pack.py.
  // `eligible`: content part-of-speech and not a polysemy quarantine — may render.
  // `enZipf`: English-frequency (Zipf 0–8) of the source word; drives the
  // skip-what-you-know level floor and the common-band quality gate.
  eligible?: boolean
  enZipf?: number
}

export interface NounTranslationEntry extends BaseTranslationEntry {
  partOfSpeech: 'noun'
  gender: Gender
  plural: string
}

export interface AdverbTranslationEntry extends BaseTranslationEntry {
  partOfSpeech: 'adverb'
}

export interface AdjectiveTranslationEntry extends BaseTranslationEntry {
  partOfSpeech: 'adjective'
}

export interface VerbTranslationEntry extends BaseTranslationEntry {
  partOfSpeech: 'verb'
}

export interface ExpressionTranslationEntry extends BaseTranslationEntry {
  partOfSpeech: 'expression'
}

export interface FunctionTranslationEntry extends BaseTranslationEntry {
  partOfSpeech: 'function'
  functionSubtype: FunctionSubtype
}

export type TranslationEntry =
  | NounTranslationEntry
  | AdverbTranslationEntry
  | AdjectiveTranslationEntry
  | VerbTranslationEntry
  | ExpressionTranslationEntry
  | FunctionTranslationEntry

export interface LanguagePack {
  version: string
  sourceLanguage: SourceLanguage
  targetLanguage: TargetLanguage
  displayName: string
  sources?: Record<string, LanguagePackSource>
  entries: Record<string, TranslationEntry>
}

// ---------- Runtime types ----------

export interface ExpressionMatch {
  start: number
  end: number
  original: string
  entry: ExpressionTranslationEntry
}

export interface CandidateToken {
  word: string
  lemma: string
  start: number
  end: number
  partOfSpeech: PartOfSpeech
  isPlural: boolean
}

// ---------- Lexicon store ----------

// Word lifecycle states. Passive exposure uses only Unseen and Learning;
// the remaining states are driven by popup practice quiz results.
export enum WordLifecycleState {
  Unseen    = 'unseen',
  Learning  = 'learning',
  Reviewing = 'reviewing',
  Mature    = 'mature',
  Graduated = 'graduated',
}

// Per-word persistent record stored in chrome.storage.local.
export interface LexiconEntry {
  seenCount: number;           // times this word has been displayed as a replacement
  lastSeenAt: number;          // Unix timestamp ms; 0 if never shown
  lastReviewedAt: number;      // Unix timestamp ms of the last quiz/review; 0 if never reviewed.
                               // Distinct from lastSeenAt (passive page exposure) — this is the
                               // staleness signal for the popup's "practice stale words" review.
  srsInterval: number;         // SM-2 interval in days (0 until first quiz)
  srsEaseFactor: number;       // SM-2 ease factor (initialised to 2.5)
  srsRepetitions: number;      // SM-2 consecutive correct repetitions (determines interval schedule)
  recallHistory: boolean[];    // quiz outcomes, most recent last (capped at last 10 for graduation check)
  lifecycleState: WordLifecycleState;
  selfMarkedKnown: boolean;    // legacy/user-known removal flag
  selfMarkedUnknown: boolean;  // user explicitly saved this word for review/export
  selfMarkedUnknownAt: number; // Unix timestamp ms; 0 if not saved as unknown
}

// ---------- Session store ----------

// A record of a single word replacement made during the current page session.
// Deliberately minimal: the popup reads only englishLemma (session stats and
// the session filter), so nothing else is captured per injection.
export interface WordSeen {
  englishLemma: string;
  seenAt: number;           // Unix timestamp ms
}

// ---------- Settings store ----------

export type OnboardingLevel = 'beginner' | 'intermediate' | 'advanced';

// The subset of settings the content script watches for live changes.
// `tailLoaded` is not a user setting — it is a render-input the content script
// tracks so that when the niche tail finishes percolating in, the diff notices
// the vocabulary grew and re-renders (the same mechanism the retired Aggressive
// Mode toggle used, now driven purely by loader state).
export interface RuntimeSettings {
  density?: number
  replacementsEnabled?: boolean
  tailLoaded?: boolean
  blockedDomains?: string[]
  targetLanguage?: TargetLanguage
  disabledPartsOfSpeech?: PartOfSpeech[]
}

// ---------- Popup <-> content script ----------

// Sent by the popup to the active tab; answered with a PageStatus.
export const PAGE_STATUS_MESSAGE = 'contexto:page-status'

// Why the current page looks the way it does.
//   off          replacements are switched off entirely
//   blocked      this domain is on the user's blocked list
//   paused       the user chose Keep Paused on this domain's high-stakes banner
//   too-short    not enough readable text to be worth swapping
//   loading      a replacement pass is in flight, or content has just arrived
//   active       the pipeline ran; `swapped` may still be 0 (nothing eligible)
//   error        the pipeline failed (e.g. the language pack would not load)
// A tab with no content script never answers at all; the popup classifies that
// case itself from the tab's URL (see PageStatus.ts describeNoScript).
export type PageStatusKind =
  | 'off' | 'blocked' | 'paused' | 'too-short' | 'loading' | 'active' | 'error'

export interface PageStatus {
  kind: PageStatusKind
  swapped: number
  language: TargetLanguage
}
