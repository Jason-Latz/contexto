import nlp from 'compromise'
import { getActiveTargetLanguage, lookup } from '../language/loader.js'
import { getLanguageInfo } from '../language/registry.js'
import { scanExpressions } from './expressionScanner.js'
import { buildReplacement } from '../language/replacement.js'
import { baseSpanStyle, unknownSpanStyle } from './spanStyles.js'
import { cleanGloss, posLabel } from './hoverCard.js'
import { isTextNodeSafeToRewrite } from './domWalker.js'
import type { CandidateToken, ExpressionMatch, NounTranslationEntry, PartOfSpeech, TranslationEntry } from '../types/index.js'
import { getEntry, recordSeen } from '../store/lexiconStore.js'
import { recordWordSeen } from '../store/sessionStore.js'
import { getLevel } from '../store/settingsStore.js'
import type { OnboardingLevel } from '../types/index.js'

interface InjectionOptions {
  shouldRecordExposure?: (lemma: string) => boolean
}

interface ParsedTextNode {
  text: string
  expressionMatches: ExpressionMatch[]
  tokens: CandidateToken[]
}

interface ReplacementRange {
  start: number
  end: number
  priority?: number
}

interface ReplacementCandidate extends ReplacementRange {
  span: HTMLSpanElement
  recordExposure?: () => void
}

// Text nodes that have already been processed by this content script run.
// WeakSet is used (not DOM attributes) because Text nodes have no dataset.
// Entries are garbage-collected automatically when nodes leave the DOM.
const processedNodes = new WeakSet<Text>()
const parsedNodeCache = new WeakMap<Text, ParsedTextNode>()
let parsedNodeCacheHits = 0
let parsedNodeCacheMisses = 0

// Minimum word count for a text node to receive any replacements.
// Very short nodes (single navigation labels, button text) give compromise.js
// too little sentence context for reliable POS tagging.
const MIN_WORD_COUNT = 3

// English pronouns that compromise.js tags as nouns — we must filter them out
// manually. Includes personal, possessive, reflexive, relative, and common
// indefinite pronouns that appear in noun positions.
const PRONOUN_BLOCKLIST = new Set([
  'i', 'me', 'my', 'mine', 'myself',
  'you', 'your', 'yours', 'yourself', 'yourselves',
  'he', 'him', 'his', 'himself',
  'she', 'her', 'hers', 'herself',
  'it', 'its', 'itself',
  'we', 'us', 'our', 'ours', 'ourselves',
  'they', 'them', 'their', 'theirs', 'themselves',
  'who', 'whom', 'whose', 'which', 'that',
  'this', 'these', 'those',
  'one', 'ones', 'everyone', 'someone', 'anyone', 'nobody',
  'somebody', 'anybody', 'nothing', 'something', 'anything', 'everything',
])

// A bare-infinitive slot — "to taste" / "can taste" — is the ONE context every
// target language renders faithfully with the uninflected dictionary target
// ("to probar", "can schmecken"): the slot itself is an infinitive. Inflected
// slots ("tastes", "roasted", "tasting") would put an infinitive where the
// sentence needs agreement, so they stay English. German alone could also take
// present-plural slots (sie schmecken), but a per-language carve-out is not
// worth the asymmetry while verbs are opt-in.
//
// The marker check is grammatical, not textual: compromise tags every modal
// (can/could/may/might/must/shall/should/will/would, plus contractions like
// "can't" and "cannot") as Modal, while the homograph proper nouns that a text
// list would trip over ("In May, begin...", "Will Smith taste...") are tagged
// Month/ProperNoun. Only "to" needs a text match (compromise calls it a plain
// Conjunction).
function opensInfinitiveSlot(precedingLower: string, precedingTags: readonly string[]): boolean {
  return precedingLower === 'to' || precedingTags.includes('Modal')
}

const IRREGULAR_VERB_LEMMAS: Record<string, string> = {
  am: 'be',
  are: 'be',
  is: 'be',
  was: 'be',
  were: 'be',
  been: 'be',
  being: 'be',
  did: 'do',
  does: 'do',
  done: 'do',
  had: 'have',
  has: 'have',
  having: 'have',
  went: 'go',
  gone: 'go',
  made: 'make',
  said: 'say',
  saw: 'see',
  seen: 'see',
  took: 'take',
  taken: 'take',
  thought: 'think',
  knew: 'know',
  known: 'know',
}

// ---------- Singularisation helpers ----------

// Try to singularize a plural noun surface form using compromise.js.
// Falls back to a suffix-stripping heuristic for cases compromise misses,
// as documented in CLAUDE.md's "compromise.js known limitations" section.
function singularize(word: string): string {
  // Singularize per-word (not as part of a sentence) to avoid index drift — see CLAUDE.md
  const singular = nlp(word).nouns().toSingular().text()
  if (singular && singular.toLowerCase() !== word.toLowerCase()) {
    return singular.toLowerCase()
  }

  // Fallback suffix stripping for regular plurals compromise may miss
  const w = word.toLowerCase()
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y'  // cities → city
  if (w.endsWith('ves') && w.length > 4) return w.slice(0, -3) + 'fe' // knives → knife
  if (w.endsWith('ses') || w.endsWith('xes') || w.endsWith('zes')) return w.slice(0, -2)
  if (w.endsWith('s') && w.length > 3) return w.slice(0, -1)

  return w
}

function lemmatizeVerb(word: string): string {
  const lower = word.toLowerCase()
  if (IRREGULAR_VERB_LEMMAS[lower]) return IRREGULAR_VERB_LEMMAS[lower]

  const infinitive = nlp(word).verbs().toInfinitive().text()
  if (infinitive) return infinitive.toLowerCase()

  if (lower.endsWith('ies') && lower.length > 4) return lower.slice(0, -3) + 'y'
  if (lower.endsWith('ing') && lower.length > 5) {
    const stem = lower.slice(0, -3)
    return stem.endsWith(stem.slice(-1).repeat(2)) ? stem.slice(0, -1) : stem
  }
  if (lower.endsWith('ed') && lower.length > 4) return lower.slice(0, -2)
  if (lower.endsWith('s') && lower.length > 3) return lower.slice(0, -1)
  return lower
}

function matchCapitalization(source: string, replacement: string): string {
  if (!source || !replacement) return replacement

  const firstLetterIndex = replacement.search(/\p{L}/u)
  if (firstLetterIndex === -1) return replacement

  const sourceLetters = source.match(/\p{L}/gu) ?? []
  if (sourceLetters.length === 0) return replacement

  if (sourceLetters.every((letter) => letter === letter.toUpperCase())) {
    return replacement.toUpperCase()
  }

  const sourceFirstLetter = sourceLetters[0]!
  if (sourceFirstLetter !== sourceFirstLetter.toUpperCase()) {
    return replacement
  }

  return (
    replacement.slice(0, firstLetterIndex) +
    replacement[firstLetterIndex].toUpperCase() +
    replacement.slice(firstLetterIndex + 1)
  )
}

// ---------- Span construction ----------

// The citation form a learner should memorise: definite article + singular
// ("la casa", "das Haus"). Rendered through the active language's own adapter
// (the synthetic "the x" context triggers its definite-article path) so
// stressed-a Spanish feminines, German capitalization, and fr/it élision all
// come out right without duplicating any grammar here.
function nounCitationForm(entry: NounTranslationEntry): string {
  return buildReplacement(getActiveTargetLanguage(), entry, 'the x', 4, false).displayText
}

// Build a <span> element that displays `displayText` and carries the original
// English word plus what the entry can teach (gloss, part of speech, and for
// nouns the citation form/gender/plural) as data attributes for the hover card.
function buildSpan(
  displayText: string,
  originalEnglish: string,
  entry: TranslationEntry,
): HTMLSpanElement {
  const span = document.createElement('span')
  span.textContent = displayText
  // Let screen readers and speech tools pronounce the injected target word in
  // the language actually displayed rather than inheriting the English page.
  span.lang = getLanguageInfo(getActiveTargetLanguage()).htmlLang
  span.setAttribute('data-contexto', 'true')
  span.setAttribute('data-source', originalEnglish)
  span.setAttribute('data-target', displayText)
  span.setAttribute('data-base-target', entry.target)
  span.setAttribute('data-gloss', cleanGloss(entry.sourceGloss))
  span.setAttribute('data-pos', posLabel(entry))
  if (entry.partOfSpeech === 'noun') {
    span.setAttribute('data-article-form', nounCitationForm(entry))
    if (entry.gender) span.setAttribute('data-gender', entry.gender)
    if (entry.plural) span.setAttribute('data-plural', entry.plural)
  }
  span.setAttribute('style', baseSpanStyle())
  return span
}

function attachLemma(span: HTMLSpanElement, lemma: string): void {
  span.setAttribute('data-lemma', lemma)

  if (getEntry(lemma).selfMarkedUnknown) {
    span.setAttribute('data-contexto-unknown', 'true')
    span.setAttribute('style', unknownSpanStyle())
  }
}

function shouldRecordExposure(options: InjectionOptions, lemma: string): boolean {
  return options.shouldRecordExposure?.(lemma) ?? true
}

function isCompatibleEntry(entry: TranslationEntry, token: CandidateToken): boolean {
  return entry.partOfSpeech === token.partOfSpeech
}

// Common English words are exactly where the imported ("medium") tier picks the
// wrong dominant sense, so a medium entry only renders once it is RARER than the
// common band; hand-verified ("high") entries render at any frequency. Kept in
// sync with COMMON_BAND_ZIPF in scripts/qa_language_pack.py.
const MEDIUM_OK_ZIPF = 5.0

// Skip-what-you-know floor: a learner already knows the most common words, so
// words at/above the level's English-frequency (Zipf) floor are not replaced —
// the tool spends its replacements on rarer vocabulary worth learning. No level
// set (e.g. before first-run init, or in tests) means no floor. Starting values;
// tune to taste.
const LEVEL_FLOOR: Record<OnboardingLevel, number> = {
  beginner: 7.5,
  intermediate: 6.0,
  advanced: 5.0,
}

// True when the entry would render exactly as the English source, so a learner
// sees no foreign word at all. Nouns render with an article ("la nature", "der
// Link") and stay visually distinct; non-nouns show the bare target, so a target
// identical to the source (a cognate like "civil", "digital", "mobile") is a
// wasted slot — the core loop is about DIFFERENT words. Gate it out.
function rendersIdenticalToSource(entry: TranslationEntry): boolean {
  return entry.partOfSpeech !== 'noun' && entry.target === entry.source
}

// An entry may render on the page when it is QA-eligible (content word, not a
// polysemy quarantine) AND either verified or rare enough to trust. See the
// QUALITY GATE note on extractPageCandidates.
function isReplaceable(entry: TranslationEntry): boolean {
  if (entry.eligible !== true) return false
  if (rendersIdenticalToSource(entry)) return false
  if (entry.confidence === 'high') return true
  return (entry.enZipf ?? 0) < MEDIUM_OK_ZIPF
}

// The English-frequency ceiling above which words are assumed already known and
// are skipped, based on the current level.
function knownWordCeiling(level: OnboardingLevel | null = getLevel()): number {
  return level ? LEVEL_FLOOR[level] : Infinity
}

function isAboveKnownCeiling(entry: TranslationEntry, ceiling: number): boolean {
  return (entry.enZipf ?? 0) >= ceiling
}

function isStandaloneFunctionReplacement(entry: TranslationEntry): boolean {
  return entry.partOfSpeech === 'function' && entry.functionSubtype !== 'determiner'
}

function hasEnoughWords(text: string): boolean {
  return text.trim().split(/\s+/).length >= MIN_WORD_COUNT
}

function rangesOverlap(a: ReplacementRange, b: ReplacementRange): boolean {
  return a.start < b.end && a.end > b.start
}

function rangeLength(range: ReplacementRange): number {
  return range.end - range.start
}

export function selectNonOverlappingReplacementRanges<T extends ReplacementRange>(
  candidates: T[],
): T[] {
  const selected: T[] = []
  const occupiedRanges: ReplacementRange[] = []
  const ordered = [...candidates].sort((a, b) =>
    (b.priority ?? 0) - (a.priority ?? 0) ||
    a.start - b.start ||
    rangeLength(b) - rangeLength(a) ||
    a.end - b.end,
  )

  for (const candidate of ordered) {
    if (candidate.end <= candidate.start) continue
    if (occupiedRanges.some(range => rangesOverlap(range, candidate))) continue

    selected.push(candidate)
    occupiedRanges.push(candidate)
  }

  return selected.sort((a, b) => a.start - b.start || a.end - b.end)
}

function parseTextNode(node: Text): ParsedTextNode | null {
  const text = node.nodeValue ?? ''
  if (!hasEnoughWords(text)) return null

  const cached = parsedNodeCache.get(node)
  if (cached?.text === text) {
    parsedNodeCacheHits++
    return cached
  }

  const parsed = {
    text,
    expressionMatches: scanExpressions(text),
    tokens: extractTokens(text),
  }
  parsedNodeCache.set(node, parsed)
  parsedNodeCacheMisses++
  return parsed
}

export function resetParseCacheDiagnostics(): void {
  parsedNodeCacheHits = 0
  parsedNodeCacheMisses = 0
}

export function getParseCacheDiagnostics(): { hits: number; misses: number } {
  return {
    hits: parsedNodeCacheHits,
    misses: parsedNodeCacheMisses,
  }
}

// ---------- Token extraction ----------

// POS-tag the full text node content and extract tokens that have supported
// language-pack entries. Exact-match function words use the pack directly so
// common short words are not lost when compromise tags them inconsistently.
// The full text is passed in one call (not word-by-word) for accurate sentence-context tagging.
// Positions are recovered by scanning forward through the original string, which handles
// repeated words correctly without relying on offsets that compromise doesn't expose.
function extractTokens(text: string): CandidateToken[] {
  const doc = nlp(text)
  // json() returns one object per sentence, each with a terms array
  const sentences: Array<{ terms: Array<{ text: string; tags: string[] }> }> = doc.json()

  const tokens: CandidateToken[] = []
  let searchOffset = 0  // tracks our position in `text` as we step through terms

  for (const sentence of sentences) {
    // The previous REAL term in this sentence, for the verb infinitive-slot
    // check. Reset per sentence: a marker cannot reach across a boundary.
    // Contractions produce a phantom empty-text term ("can't" -> "can't" + ""),
    // which must not clobber the lookback, so empty surfaces are skipped.
    let previousLower = ''
    let previousTags: string[] = []

    for (const term of sentence.terms) {
      const surface = term.text
      const tags: string[] = term.tags ?? []

      // Find where this term appears in the original string, starting from our cursor.
      // Scanning forward (not always from 0) correctly handles repeated words.
      const idx = text.indexOf(surface, searchOffset)
      if (idx === -1) {
        // Safety: if we can't locate the term, skip it without moving the cursor
        continue
      }
      // Advance cursor past this term for the next search
      searchOffset = idx + surface.length

      const isNoun = tags.includes('Noun') || tags.includes('Singular') || tags.includes('Plural')
      const isAdverb = tags.includes('Adverb')
      const isAdjective = tags.includes('Adjective')
      const isVerb = tags.includes('Verb') || tags.includes('Infinitive') || tags.includes('Gerund')
      const lowerSurface = surface.toLowerCase()
      const precededBy = previousLower
      const precededByTags = previousTags
      if (surface.length > 0) {
        previousLower = lowerSurface
        previousTags = tags
      }

      if (tags.includes('Hyphenated')) {
        continue
      }

      const exactEntry = lookup(lowerSurface)
      if (exactEntry && isStandaloneFunctionReplacement(exactEntry)) {
        tokens.push({
          word: surface,
          lemma: lowerSurface,
          start: idx,
          end: idx + surface.length,
          partOfSpeech: 'function',
          isPlural: false,
        })
        continue
      }

      if (isNoun) {
        const lemma = singularize(surface)

        // Filter out pronouns — compromise tags them as nouns
        if (PRONOUN_BLOCKLIST.has(lemma) || PRONOUN_BLOCKLIST.has(lowerSurface)) continue

        // Drop possessives — "company's" → "company" may not be in the dictionary,
        // and the possessive form is misleading for simple in-place replacement
        if (surface.includes("'")) continue

        tokens.push({
          word: surface,
          lemma,
          start: idx,
          end: idx + surface.length,
          partOfSpeech: 'noun',
          isPlural: tags.includes('Plural'),
        })
      } else if (isVerb) {
        // Only bare-infinitive slots (see opensInfinitiveSlot): the surface must
        // BE the base form and follow "to" or a modal. Anything else would swap
        // an inflected English verb for an uninflected target.
        const lemma = lemmatizeVerb(surface)
        if (lowerSurface !== lemma || !opensInfinitiveSlot(precededBy, precededByTags)) continue
        tokens.push({
          word: surface,
          lemma,
          start: idx,
          end: idx + surface.length,
          partOfSpeech: 'verb',
          isPlural: false,
        })
      } else if (isAdjective) {
        tokens.push({
          word: surface,
          lemma: lowerSurface,
          start: idx,
          end: idx + surface.length,
          partOfSpeech: 'adjective',
          isPlural: false,
        })
      } else if (isAdverb) {
        tokens.push({
          word: surface,
          lemma: surface.toLowerCase(),
          start: idx,
          end: idx + surface.length,
          partOfSpeech: 'adverb',
          isPlural: false,
        })
      }
    }
  }

  return tokens
}

// ---------- DOM replacement ----------

// Replace `node` with a DocumentFragment that interleaves unchanged text runs
// and injected replacement spans.
// The node is marked in processedNodes BEFORE any DOM mutation so that
// the Phase 4 MutationObserver cannot re-process it between mutation steps.
function replaceTextNode(
  node: Text,
  replacements: Array<{ start: number; end: number; span: HTMLSpanElement }>,
): void {
  if (replacements.length === 0) return

  const text = node.nodeValue ?? ''
  const fragment = document.createDocumentFragment()
  let cursor = 0

  // Mark as processed before touching the DOM
  processedNodes.add(node)

  for (const { start, end, span } of replacements) {
    if (start > cursor) {
      fragment.appendChild(document.createTextNode(text.slice(cursor, start)))
    }
    fragment.appendChild(span)
    cursor = end
  }

  if (cursor < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(cursor)))
  }

  node.parentNode?.replaceChild(fragment, node)
}

// ---------- Page-level candidate extraction ----------

// Scan all text nodes once and return one representative CandidateToken per
// unique eligible lemma. Deduplication by lemma is intentional: the density
// cap means "fraction of distinct eligible words to replace today", not
// "fraction of total token positions". Passing duplicates to selectTokens
// would skew scoring toward frequently-repeated words.
//
// Tokens that overlap with expression spans or have no dictionary entry are
// excluded here so selectTokens only scores genuinely replaceable candidates.
//
// QUALITY GATE + SKIP-WHAT-YOU-KNOW. Two filters decide what becomes a candidate
// (offline signals `eligible` / `enZipf` come from scripts/qa_language_pack.py):
//   1. isReplaceable — content word, not a polysemy quarantine, and either
//      hand-verified ("high") or rarer than the common band. The imported
//      ("medium") tier gets the dominant sense wrong precisely for COMMON words
//      (it→"tecnología de la información"), so medium entries only render once
//      they are rare enough that a single dominant sense is reliable. This keeps
//      the valuable rare/long-tail vocabulary while suppressing the broken head.
//   2. isAboveKnownCeiling — words a learner at the current level already knows
//      (too frequent in English) are skipped, so replacements teach new words.
// Gating here (not at load) keeps the full pack available for hover/export and
// for promotion. Expanding coverage is additive: verify a common word and mark
// it "high" (see imports/.../common-words-to-verify.json) — no code change.
//
// `disabledPartsOfSpeech` comes from the popup's Word Types card (verbs are off
// by default). Filtering candidates is sufficient to keep a POS off the page:
// injectReplacements only renders lemmas approved from these candidates.
export function extractPageCandidates(
  nodes: Text[],
  disabledPartsOfSpeech: readonly PartOfSpeech[] = [],
  level: OnboardingLevel | null = getLevel(),
): CandidateToken[] {
  const seenLemmas = new Set<string>()
  const candidates: CandidateToken[] = []
  const ceiling = knownWordCeiling(level)
  const disabledPos = new Set<PartOfSpeech>(disabledPartsOfSpeech)

  for (const node of nodes) {
    if (processedNodes.has(node)) continue

    const parsed = parseTextNode(node)
    if (!parsed) continue

    // Expression ranges must be excluded so we don't offer a lemma that will
    // be covered by a multi-word expression span in the replacement pass.
    // A disabled expression claims no range, so its constituent words stay
    // available to the unigram pass below.
    const occupiedRanges: Array<[number, number]> = []

    for (const match of parsed.expressionMatches) {
      if (disabledPos.has('expression')) break
      const lemma = match.entry.source.toLowerCase()
      if (seenLemmas.has(lemma)) continue
      if (!isReplaceable(match.entry)) continue
      if (isAboveKnownCeiling(match.entry, ceiling)) continue
      seenLemmas.add(lemma)
      occupiedRanges.push([match.start, match.end])
      candidates.push({
        word: match.original,
        lemma,
        start: match.start,
        end: match.end,
        partOfSpeech: 'expression',
        isPlural: false,
      })
    }

    for (const token of parsed.tokens) {
      if (seenLemmas.has(token.lemma)) continue

      const overlaps = occupiedRanges.some(([s, e]) => token.start < e && token.end > s)
      if (overlaps) continue

      const entry = lookup(token.lemma)
      if (!entry || !isCompatibleEntry(entry, token)) continue
      if (disabledPos.has(entry.partOfSpeech)) continue
      if (!isReplaceable(entry)) continue
      if (isAboveKnownCeiling(entry, ceiling)) continue

      seenLemmas.add(token.lemma)
      candidates.push(token)
    }
  }

  return candidates
}

// ---------- Main export ----------

// Process a single text node: replace every token whose lemma is in
// `approvedLemmas` (decided by the page-level word selector) plus any
// multi-word expressions found in the node.
//
// `approvedLemmas` is built once per page by the caller (index.ts):
//   const candidates = extractPageCandidates(textNodes)
//   const selected   = selectTokens(candidates, Math.floor(density * candidates.length))
//   const approved   = new Set(selected.map(t => t.lemma))
//
// This guarantees every occurrence of a selected lemma is replaced, regardless
// of which text node it appears in or how many other words surround it.
export function injectReplacements(
  node: Text,
  approvedLemmas: ReadonlySet<string>,
  options: InjectionOptions = {},
): void {
  if (processedNodes.has(node)) return

  // The DOM walker excludes authoring surfaces, but injection is the final
  // mutation boundary and must enforce that invariant itself. Dynamic apps can
  // move a collected text node into a contenteditable composer before this
  // function runs, and direct callers must not be able to bypass compose safety.
  if (!isTextNodeSafeToRewrite(node)) return

  const parsed = parseTextNode(node)
  if (!parsed) return

  const { text } = parsed

  const candidates: ReplacementCandidate[] = []

  // --- Pass 1: expression scan (bigrams and trigrams) ---
  // Must run first so multi-word expressions are claimed before their constituent
  // words are considered individually by the unigram pass below.
  for (const match of parsed.expressionMatches) {
    const lemma = match.entry.source.toLowerCase()
    if (!approvedLemmas.has(lemma)) continue

    const span = buildSpan(match.entry.target, match.original, match.entry)
    attachLemma(span, lemma)
    candidates.push({
      start: match.start,
      end: match.end,
      priority: 2,
      span,
      recordExposure: shouldRecordExposure(options, lemma)
        ? () => {
            recordSeen(lemma)
            recordWordSeen({ englishLemma: lemma, seenAt: Date.now() })
          }
        : undefined,
    })
  }

  // --- Pass 2: unigram nouns and adverbs ---
  // Replace every token whose lemma was approved at the page level.
  for (const token of parsed.tokens) {
    // Only replace lemmas approved by the page-level word selector
    if (!approvedLemmas.has(token.lemma)) continue

    const entry = lookup(token.lemma)
    if (!entry) continue

    if (entry.partOfSpeech === 'expression' || !isCompatibleEntry(entry, token)) {
      continue
    }

    const replacement = buildReplacement(getActiveTargetLanguage(), entry, text, token.start, token.isPlural)
    const originalEnglish = text.slice(replacement.replacementStart, token.end)
    const displayText = matchCapitalization(originalEnglish, replacement.displayText)
    const span = buildSpan(displayText, originalEnglish, entry)

    // data-lemma stores the English lemma (e.g. "dog") so the hover handler
    // can save the correct lexicon key for unknown-word review.
    attachLemma(span, token.lemma)

    candidates.push({
      start: replacement.replacementStart,
      end: token.end,
      priority: 1,
      span,
      recordExposure: shouldRecordExposure(options, token.lemma)
        ? () => {
            // Record only replacements that survive overlap filtering so stats
            // match what the reader actually saw on the page.
            recordSeen(token.lemma)
            recordWordSeen({ englishLemma: token.lemma, seenAt: Date.now() })
          }
        : undefined,
    })
  }

  const replacements = selectNonOverlappingReplacementRanges(candidates)
  for (const replacement of replacements) {
    replacement.recordExposure?.()
  }

  replaceTextNode(node, replacements)
}

export function restoreReplacements(root: ParentNode = document): void {
  const spans = [...root.querySelectorAll<HTMLElement>('[data-contexto="true"]')]
  const affectedParents = new Set<Node>()

  for (const span of spans) {
    const source = span.getAttribute('data-source') ?? span.textContent ?? ''
    const parent = span.parentNode
    if (parent) affectedParents.add(parent)
    span.replaceWith(document.createTextNode(source))
  }

  // Rejoining adjacent text nodes preserves sentence context for the next NLP
  // pass after a live density re-render.
  for (const parent of affectedParents) {
    parent.normalize()
  }
}
