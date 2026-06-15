import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Golden regression set: a frozen list of verified English→Spanish pairs that
// must remain correct in the shipped pack. "hand" entries are independently
// authored ground truth (target must be one of an acceptable set); "snapshot"
// entries pin a verified entry's exact target/gender/plural to catch regressions.
// Built by scripts/build_golden.py.

interface PackEntry {
  target?: string
  partOfSpeech?: string
  gender?: string
  plural?: string
  eligible?: boolean
  confidence?: string
}
interface Golden {
  source: string
  kind: 'hand' | 'snapshot'
  acceptable?: string[]
  target?: string
  partOfSpeech?: string
  gender?: string
  plural?: string
}

const cwd = process.cwd()
const pack: { entries: Record<string, PackEntry> } = JSON.parse(
  readFileSync(`${cwd}/public/language-packs/es.json`, 'utf8'),
)
const golden: Golden[] = JSON.parse(
  readFileSync(`${cwd}/tests/fixtures/golden-es.json`, 'utf8'),
)

const find = (source: string): PackEntry | undefined =>
  pack.entries[source] ?? pack.entries[source.toLowerCase()]

test('golden set has at least 150 verified pairs', () => {
  assert.ok(golden.length >= 150, `golden set too small: ${golden.length}`)
})

test('every golden pair is eligible, high-confidence, and correct', () => {
  const failures: string[] = []
  for (const g of golden) {
    const e = find(g.source)
    if (!e) { failures.push(`${g.source}: missing from pack`); continue }
    if (e.eligible !== true) failures.push(`${g.source}: not eligible`)
    if (e.confidence !== 'high') failures.push(`${g.source}: not high-confidence (${e.confidence})`)
    const target = (e.target ?? '').trim()
    if (g.kind === 'hand') {
      if (!g.acceptable!.includes(target)) {
        failures.push(`${g.source}: target "${target}" not in [${g.acceptable!.join(', ')}]`)
      }
    } else {
      if (target !== g.target) failures.push(`${g.source}: target "${target}" != "${g.target}"`)
      if (g.partOfSpeech === 'noun') {
        if ((e.gender ?? '') !== (g.gender ?? '')) failures.push(`${g.source}: gender "${e.gender}" != "${g.gender}"`)
        if ((e.plural ?? '') !== (g.plural ?? '')) failures.push(`${g.source}: plural "${e.plural}" != "${g.plural}"`)
      }
    }
  }
  assert.equal(failures.length, 0, `\n  ${failures.join('\n  ')}`)
})
