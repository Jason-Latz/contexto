import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('performance harness fails closed when its real-page fixtures are absent', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contexto-perf-harness-'))

  try {
    const liveDir = path.join(fixtureRoot, 'tests', 'live')
    const distDir = path.join(fixtureRoot, 'dist')
    const playwrightDir = path.join(fixtureRoot, 'node_modules', 'playwright')
    fs.mkdirSync(path.join(liveDir, 'fixtures'), { recursive: true })
    fs.mkdirSync(path.join(distDir, 'language-packs'), { recursive: true })
    fs.mkdirSync(playwrightDir, { recursive: true })

    fs.copyFileSync(
      path.join(process.cwd(), 'tests', 'live', 'run-perf.mjs'),
      path.join(liveDir, 'run-perf.mjs'),
    )
    fs.writeFileSync(path.join(liveDir, 'fixtures', 'percolate-tail.html'), '<main>photon</main>')
    fs.writeFileSync(path.join(distDir, 'manifest.json'), '{"manifest_version":3}')
    fs.writeFileSync(
      path.join(playwrightDir, 'package.json'),
      JSON.stringify({ name: 'playwright', type: 'module', exports: './index.js' }),
    )
    fs.writeFileSync(
      path.join(playwrightDir, 'index.js'),
      `
const page = {
  goto: async () => {},
  locator: () => ({ count: async () => 1 }),
  waitForTimeout: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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

    const result = spawnSync(process.execPath, [path.join(liveDir, 'run-perf.mjs')], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    })
    const output = `${result.stdout}${result.stderr}`

    assert.notEqual(
      result.status,
      0,
      `performance harness reported success without measuring any site:\n${output}`,
    )
    assert.match(output, /missing performance fixture/i)
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
