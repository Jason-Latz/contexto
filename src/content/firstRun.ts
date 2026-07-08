import { completeOnboarding, isOnboarded } from '../store/settingsStore.js'
import { flushLexiconMerge, prepopulate } from '../store/lexiconStore.js'
import { getTopNLemmas } from '../language/loader.js'

// Number of top-frequency lemmas seeded as assumed prior exposure on first run.
// Matches the old "intermediate" onboarding choice, which is now the silent
// default level for every fresh install.
export const FIRST_RUN_PREPOPULATE_COUNT = 1500

// Silent first-run initialization (no user-facing onboarding): apply the
// intermediate defaults (level + density) and seed the lexicon with the top
// FIRST_RUN_PREPOPULATE_COUNT lemmas at a baseline seenCount, so the word
// selector depresses novelty scores for common words from the very first page.
//
// Callers must load the language pack (getTopNLemmas reads it) and the lexicon
// before calling. Existing users (onboarded=true) are untouched.
//
// Idempotent and race-safe when several tabs are all "first run" at once:
// - prepopulate() skips lemmas that already have a lexicon entry, and every
//   first-run writer seeds identical baseline values, so concurrent inits
//   converge on the same state instead of corrupting it.
// - The seeded lemmas are flushed through the dirty-lemma merge path BEFORE
//   the onboarded flag persists: a crash in between leaves onboarded=false,
//   so the next page load retries (an effective no-op re-seed).
// - completeOnboarding() merges its patch onto the latest stored settings, so
//   concurrent writers cannot clobber each other's unrelated fields.
export async function ensureFirstRunInit(): Promise<void> {
  if (isOnboarded()) return

  prepopulate(getTopNLemmas(FIRST_RUN_PREPOPULATE_COUNT))
  await flushLexiconMerge()
  await completeOnboarding('intermediate')
}
