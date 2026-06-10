// ---------- Language pack schema ----------

export type SourceLanguage = 'en'
export type TargetLanguage = 'es'
export type PartOfSpeech = 'noun' | 'adverb' | 'adjective' | 'verb' | 'expression' | 'function'
export type EntryConfidence = 'high' | 'medium' | 'low'
export type SpanishGender = 'masculine' | 'feminine'
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
}

export interface NounTranslationEntry extends BaseTranslationEntry {
  partOfSpeech: 'noun'
  gender: SpanishGender
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

// Word lifecycle states. Phase 2 uses only Unseen and Learning;
// the remaining states are driven by quiz results in Phase 3.
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
  srsInterval: number;         // SM-2 interval in days (0 until first quiz)
  srsEaseFactor: number;       // SM-2 ease factor (initialised to 2.5)
  srsRepetitions: number;      // SM-2 consecutive correct repetitions (determines interval schedule)
  recallHistory: boolean[];    // quiz outcomes, most recent last (capped at last 10 for graduation check)
  lifecycleState: WordLifecycleState;
  selfMarkedKnown: boolean;    // user explicitly marked this word as known
}

// ---------- Session store ----------

// A record of a single word replacement made during the current page session.
// sentenceContext is trimmed to the sentence containing the word, capped at 200 chars,
// and stored for use by the Phase 3 contextual quiz.
export interface WordSeen {
  englishLemma: string;
  surfaceForm: string;      // the exact surface form as it appeared on the page (e.g. "dogs")
  targetWord: string;       // the displayed target-language form, including an article if shown
  sourceGloss: string;
  sentenceContext: string;
  seenAt: number;           // Unix timestamp ms
}

// ---------- Settings store ----------

export type OnboardingLevel = 'beginner' | 'intermediate' | 'advanced';
