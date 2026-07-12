import type {
  EntryConfidence,
  FunctionSubtype,
  Gender,
  LanguagePack,
  PartOfSpeech,
  TranslationEntry,
} from '../types/index.js'

// Compact pack format ("c1"): a build-time transform of the verbose committed
// packs that ships in dist/. Each entry is a positional TUPLE instead of an
// object-with-named-fields, which roughly halves JSON.parse time and cuts the
// on-disk/download size ~3-4x (no repeated field-name strings, no runtime-unused
// `sourceIds`). The verbose form stays the committed source of truth; the loader
// understands both. `source` is reconstructed from the entry key (they are always
// equal — the importers lowercase every source).
//
// Tuple layout — keep in exact sync with scripts/build-compact-packs.mjs
// (a round-trip unit test, tests/packFormat.test.ts, fails on any drift):
//   [target, posCode, gloss, frequencyRank, confCode, gender|0, plural|0, enZipf, eligible(1|0), functionSubtype|0]
export const COMPACT_FORMAT = 'c1'
export const POS_CODES: PartOfSpeech[] =
  ['noun', 'adverb', 'adjective', 'verb', 'expression', 'function']
export const CONF_CODES: EntryConfidence[] = ['high', 'medium', 'low']

export type CompactEntry = [
  string,            // 0 target
  number,            // 1 partOfSpeech code
  string,            // 2 sourceGloss
  number,            // 3 frequencyRank
  number,            // 4 confidence code
  string | 0,        // 5 gender (nouns) or 0
  string | 0,        // 6 plural (nouns) or 0
  number,            // 7 enZipf
  0 | 1,             // 8 eligible
  string | 0,        // 9 functionSubtype (functions) or 0
]

export interface CompactLanguagePack extends Omit<LanguagePack, 'entries'> {
  format: typeof COMPACT_FORMAT
  entries: Record<string, CompactEntry>
}

export function isCompactPack(pack: LanguagePack | CompactLanguagePack): pack is CompactLanguagePack {
  return (pack as CompactLanguagePack).format === COMPACT_FORMAT
}

// Runtime never reads `sourceIds` (provenance only, kept in the verbose packs for
// the validator); a single shared empty array satisfies the type at zero per-entry cost.
const NO_SOURCE_IDS: string[] = []

export function expandCompactEntry(key: string, t: CompactEntry): TranslationEntry {
  const base = {
    source: key,
    target: t[0],
    partOfSpeech: POS_CODES[t[1]],
    sourceGloss: t[2],
    frequencyRank: t[3],
    confidence: CONF_CODES[t[4]],
    enZipf: t[7],
    eligible: t[8] === 1,
    sourceIds: NO_SOURCE_IDS,
  }
  if (base.partOfSpeech === 'noun') {
    return { ...base, partOfSpeech: 'noun', gender: t[5] as Gender, plural: t[6] as string }
  }
  if (base.partOfSpeech === 'function') {
    return { ...base, partOfSpeech: 'function', functionSubtype: t[9] as FunctionSubtype }
  }
  return base as TranslationEntry
}

// Expand a whole compact pack's entries into the verbose runtime shape.
export function expandCompactEntries(pack: CompactLanguagePack): Record<string, TranslationEntry> {
  const out: Record<string, TranslationEntry> = {}
  for (const key in pack.entries) {
    out[key] = expandCompactEntry(key, pack.entries[key])
  }
  return out
}
