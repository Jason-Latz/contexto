import nlp from 'compromise'
import { lookup } from '../language/loader.js'
import { scanExpressions } from './expressionScanner.js'
import { buildSpanishReplacement } from '../language/spanishAdapter.js'
import type { CandidateToken, ExpressionMatch, TranslationEntry, WordSeen } from '../types/index.js'
import { recordSeen } from '../store/lexiconStore.js'
import { recordWordSeen } from '../store/sessionStore.js'

interface InjectionOptions {
  shouldRecordExposure?: (lemma: string) => boolean
}

// Text nodes that have already been processed by this content script run.
// WeakSet is used (not DOM attributes) because Text nodes have no dataset.
// Entries are garbage-collected automatically when nodes leave the DOM.
const processedNodes = new WeakSet<Text>()

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

// Inline styles for the injected replacement spans. Keeping styles here (rather
// than a stylesheet) avoids a separate CSS asset and keeps the content script
// fully self-contained in Phase 1. Phase 4 popup will allow customisation.
const SPAN_BASE_STYLE = [
  'border-bottom: 1px solid rgba(42, 92, 130, 0.55)',
  'background: rgba(42, 92, 130, 0.07)',
  'border-radius: 2px',
  'cursor: help',
  'color: inherit',
  'font-style: inherit',
].join('; ')

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

// ---------- Sentence context extraction ----------

// Extract the sentence that contains the character at `charOffset` from `text`,
// trimmed and capped at 200 characters. Used to populate WordSeen.sentenceContext
// for the Phase 3 contextual quiz.
function extractSentenceContext(text: string, charOffset: number): string {
  // Sentence boundaries: newlines or .!? followed by whitespace (or end of string).
  // Split into segments and find the one that contains charOffset.
  const boundary = /[.!?]\s+|\n+/g
  let segStart = 0
  let context = text  // fallback: entire text

  let match: RegExpExecArray | null
  while ((match = boundary.exec(text)) !== null) {
    const segEnd = match.index + match[0].length
    if (segEnd > charOffset) {
      // charOffset falls in the segment [segStart, segEnd)
      context = text.slice(segStart, segEnd).trim()
      break
    }
    segStart = segEnd
  }

  // If no boundary was crossed, the offset is in the last segment
  if (segStart <= charOffset && boundary.lastIndex === 0) {
    context = text.slice(segStart).trim()
  }

  // Cap at 200 characters
  if (context.length > 200) {
    context = context.slice(0, 197) + '…'
  }

  return context
}

// ---------- Span construction ----------

// Build a <span> element that displays `displayText` and carries the original
// English word as a data attribute for the hover handler.
function buildSpan(
  displayText: string,
  originalEnglish: string,
  entry: TranslationEntry,
): HTMLSpanElement {
  const span = document.createElement('span')
  span.textContent = displayText
  span.setAttribute('data-contexto', 'true')
  span.setAttribute('data-source', originalEnglish)
  span.setAttribute('data-target', displayText)
  span.setAttribute('data-base-target', entry.target)
  span.setAttribute('data-gloss', entry.sourceGloss)
  span.setAttribute('style', SPAN_BASE_STYLE)
  return span
}

function shouldRecordExposure(options: InjectionOptions, lemma: string): boolean {
  return options.shouldRecordExposure?.(lemma) ?? true
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

      const exactEntry = lookup(lowerSurface)
      if (exactEntry?.partOfSpeech === 'function') {
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
        tokens.push({
          word: surface,
          lemma: lemmatizeVerb(surface),
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
export function extractPageCandidates(nodes: Text[]): CandidateToken[] {
  const seenLemmas = new Set<string>()
  const candidates: CandidateToken[] = []

  for (const node of nodes) {
    if (processedNodes.has(node)) continue

    const text = node.nodeValue ?? ''
    if (text.trim().split(/\s+/).length < MIN_WORD_COUNT) continue

    // Expression ranges must be excluded so we don't offer a lemma that will
    // be covered by a multi-word expression span in the replacement pass.
    const expressionMatches = scanExpressions(text)
    const occupiedRanges: Array<[number, number]> = []

    for (const match of expressionMatches) {
      const lemma = match.entry.source.toLowerCase()
      if (seenLemmas.has(lemma)) continue
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

    for (const token of extractTokens(text)) {
      if (seenLemmas.has(token.lemma)) continue

      const overlaps = occupiedRanges.some(([s, e]) => token.start < e && token.end > s)
      if (overlaps) continue

      if (!lookup(token.lemma)) continue

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

  const text = node.nodeValue ?? ''
  if (text.trim().split(/\s+/).length < MIN_WORD_COUNT) return

  const replacements: Array<{ start: number; end: number; span: HTMLSpanElement }> = []
  // Track occupied character ranges so the unigram pass skips expression-covered words
  const occupiedRanges: Array<[number, number]> = []

  // --- Pass 1: expression scan (bigrams and trigrams) ---
  // Must run first so multi-word expressions are claimed before their constituent
  // words are considered individually by the unigram pass below.
  const expressionMatches: ExpressionMatch[] = scanExpressions(text)
  for (const match of expressionMatches) {
    const lemma = match.entry.source.toLowerCase()
    if (!approvedLemmas.has(lemma)) continue

    const span = buildSpan(match.entry.target, match.original, match.entry)
    span.setAttribute('data-lemma', lemma)
    replacements.push({ start: match.start, end: match.end, span })
    occupiedRanges.push([match.start, match.end])

    if (shouldRecordExposure(options, lemma)) {
      recordSeen(lemma)
      recordWordSeen({
        englishLemma: lemma,
        surfaceForm: match.original,
        targetWord: match.entry.target,
        sourceGloss: match.entry.sourceGloss,
        sentenceContext: extractSentenceContext(text, match.start),
        seenAt: Date.now(),
      })
    }
  }

  // --- Pass 2: unigram nouns and adverbs ---
  // Replace every token whose lemma was approved at the page level.
  const allTokens = extractTokens(text)

  for (const token of allTokens) {
    // Only replace lemmas approved by the page-level word selector
    if (!approvedLemmas.has(token.lemma)) continue

    // Skip tokens that overlap with a reserved expression span
    const overlaps = occupiedRanges.some(([s, e]) => token.start < e && token.end > s)
    if (overlaps) continue

    const entry = lookup(token.lemma)
    if (!entry) continue

    if (entry.partOfSpeech === 'expression') {
      continue
    }

    const replacement = buildSpanishReplacement(entry, text, token.start, token.isPlural)
    const originalEnglish = text.slice(replacement.replacementStart, token.end)
    const displayText = matchCapitalization(originalEnglish, replacement.displayText)
    const span = buildSpan(displayText, originalEnglish, entry)

    // data-lemma stores the English lemma (e.g. "dog") so the hover handler
    // can call setKnown with the correct lexicon key.
    span.setAttribute('data-lemma', token.lemma)

    replacements.push({ start: replacement.replacementStart, end: token.end, span })
    occupiedRanges.push([replacement.replacementStart, token.end])

    // Record the replacement in the lexicon and session stores so Phase 3
    // can schedule quizzes and the proficiency model can track the reveal rate.
    const targetDisplayed = span.textContent ?? entry.target
    if (shouldRecordExposure(options, token.lemma)) {
      recordSeen(token.lemma)
      const wordSeen: WordSeen = {
        englishLemma:    token.lemma,
        surfaceForm:     token.word,   // exact surface form for contextual quiz blanking
        targetWord:      targetDisplayed,
        sourceGloss:     entry.sourceGloss,
        sentenceContext: extractSentenceContext(text, token.start),
        seenAt:          Date.now(),
      }
      recordWordSeen(wordSeen)
    }
  }

  // Sort replacements by position before building the fragment
  replacements.sort((a, b) => a.start - b.start)

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
