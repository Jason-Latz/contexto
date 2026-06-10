import { getExpressionEntries } from '../language/loader.js'
import type { ExpressionMatch, ExpressionTranslationEntry } from '../types/index.js'

interface TextToken {
  value: string
  start: number
  end: number
}

interface ExpressionPattern {
  key: string
  words: string[]
  entry: ExpressionTranslationEntry
}

interface ExpressionIndex {
  source: Array<[string, ExpressionTranslationEntry]>
  byFirstWord: Map<string, ExpressionPattern[]>
}

const WORD_RE = /[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu

let cachedIndex: ExpressionIndex | null = null

function tokenize(text: string): TextToken[] {
  const tokens: TextToken[] = []
  let match: RegExpExecArray | null

  WORD_RE.lastIndex = 0
  while ((match = WORD_RE.exec(text)) !== null) {
    tokens.push({
      value: match[0].toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  return tokens
}

function getExpressionIndex(): ExpressionIndex {
  const source = getExpressionEntries()
  if (cachedIndex?.source === source) return cachedIndex

  const byFirstWord = new Map<string, ExpressionPattern[]>()
  for (const [key, entry] of source) {
    const words = key.toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) continue

    const bucket = byFirstWord.get(words[0]) ?? []
    bucket.push({ key, words, entry })
    byFirstWord.set(words[0], bucket)
  }

  for (const bucket of byFirstWord.values()) {
    bucket.sort((a, b) => b.words.length - a.words.length || a.key.localeCompare(b.key))
  }

  cachedIndex = { source, byFirstWord }
  return cachedIndex
}

function hasWhitespaceSeparators(text: string, tokens: TextToken[], startIndex: number, wordCount: number): boolean {
  for (let offset = 0; offset < wordCount - 1; offset++) {
    const left = tokens[startIndex + offset]
    const right = tokens[startIndex + offset + 1]
    if (!left || !right) return false
    if (!/^\s+$/.test(text.slice(left.end, right.start))) return false
  }
  return true
}

function matchesPattern(text: string, tokens: TextToken[], startIndex: number, pattern: ExpressionPattern): boolean {
  if (startIndex + pattern.words.length > tokens.length) return false

  for (let offset = 0; offset < pattern.words.length; offset++) {
    if (tokens[startIndex + offset]?.value !== pattern.words[offset]) return false
  }

  return hasWhitespaceSeparators(text, tokens, startIndex, pattern.words.length)
}

// Scan raw text for known fixed expressions using a first-word index.
//
// This pass MUST run before the unigram token pass in injector.ts so expression
// spans reserve their ranges before individual words are considered. Matching is
// case-insensitive, preserves the original text slice for hover, and resolves
// overlaps greedily: earlier match wins, with longer match winning ties.
export function scanExpressions(text: string): ExpressionMatch[] {
  const index = getExpressionIndex()
  const tokens = tokenize(text)
  const rawMatches: ExpressionMatch[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const patterns = index.byFirstWord.get(token.value)
    if (!patterns) continue

    for (const pattern of patterns) {
      if (!matchesPattern(text, tokens, i, pattern)) continue

      const endToken = tokens[i + pattern.words.length - 1]!
      rawMatches.push({
        start: token.start,
        end: endToken.end,
        original: text.slice(token.start, endToken.end),
        entry: pattern.entry,
      })
    }
  }

  const deduped: ExpressionMatch[] = []
  let cursor = 0
  for (const match of rawMatches) {
    if (match.start >= cursor) {
      deduped.push(match)
      cursor = match.end
    }
  }

  return deduped
}
