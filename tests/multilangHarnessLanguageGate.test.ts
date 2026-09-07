import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('multi-language harness fails when every requested language renders Spanish', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contexto-multilang-harness-'))

  try {
    const liveDir = path.join(fixtureRoot, 'tests', 'live')
    const fixtureDir = path.join(liveDir, 'fixtures')
    const distDir = path.join(fixtureRoot, 'dist')
    const playwrightDir = path.join(fixtureRoot, 'node_modules', 'playwright')
    fs.mkdirSync(fixtureDir, { recursive: true })
    fs.mkdirSync(distDir, { recursive: true })
    fs.mkdirSync(playwrightDir, { recursive: true })

    fs.copyFileSync(
      path.join(process.cwd(), 'tests', 'live', 'run-multilang.mjs'),
      path.join(liveDir, 'run-multilang.mjs'),
    )
    fs.writeFileSync(path.join(fixtureDir, 'article-light.html'), '<main>house</main>')
    fs.writeFileSync(path.join(distDir, 'manifest.json'), '{"manifest_version":3}')
    fs.writeFileSync(
      path.join(playwrightDir, 'package.json'),
      JSON.stringify({ name: 'playwright', type: 'module', exports: './index.js' }),
    )
    fs.writeFileSync(
      path.join(playwrightDir, 'index.js'),
      `
const replacement = { source: 'house', target: 'la casa', lang: 'es' }
const locator = {
  count: async () => 1,
  evaluateAll: async (callback) =>
    String(callback).includes("getAttribute('lang')") ? ['es'] : [replacement],
}
const page = {
  on: () => {},
  goto: async () => {},
  waitForTimeout: async () => {},
  waitForSelector: async () => {},
  locator: () => locator,
  screenshot: async () => {},
  close: async () => {},
}
const worker = {
  url: () => 'chrome-extension://contexto-test/test-sw.js',
  evaluate: async () => {},
}
const context = {
  serviceWorkers: () => [worker],
  waitForEvent: async () => worker,
  newPage: async () => page,
  close: async () => {},
}
export const chromium = {
  launchPersistentContext: async () => context,
}
`,
    )

    const result = spawnSync(process.execPath, [path.join(liveDir, 'run-multilang.mjs')], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    })
    const output = `${result.stdout}${result.stderr}`

    assert.notEqual(
      result.status,
      0,
      `multi-language harness accepted Spanish output for German, French, and Italian:\n${output}`,
    )
    assert.match(output, /wrong language/i)
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
