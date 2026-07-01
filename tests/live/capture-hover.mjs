// Capture a hover-tooltip screenshot for the report: load the styled Alice in
// Wonderland fixture with Spanish + aggressive mode, hover an injected word, and
// screenshot the tooltip (English source + gloss + target).
import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const DISTTEST = path.join(__dirname, '.dist-test')
const SHOTS = path.join(__dirname, 'screenshots')
const PAGE = pathToFileURL(path.join(__dirname, 'fixtures', 'perf', 'pg-essay.html')).href

async function sw(context) {
  let [s] = context.serviceWorkers()
  if (!s) s = await context.waitForEvent('serviceworker', { timeout: 15000 })
  return s
}

const context = await chromium.launchPersistentContext(path.join(__dirname, '.user-data'), {
  headless: false,
  args: [`--disable-extensions-except=${DISTTEST}`, `--load-extension=${DISTTEST}`,
    '--no-first-run', '--no-default-browser-check'],
})
await (await sw(context)).evaluate(async () => {
  await chrome.storage.local.clear()
  await chrome.storage.local.set({ contexto_settings: {
    onboarded: true, level: 'advanced', targetLanguage: 'es', density: 0.9,
    replacementsEnabled: true, quizzesEnabled: false, aggressiveMode: true,
    blockedDomains: [], domainDecisions: {},
  } })
})
const page = await context.newPage()
await page.goto(PAGE, { waitUntil: 'load' })
await page.waitForSelector('[data-contexto="true"]', { timeout: 8000 })

await page.waitForTimeout(800)
await page.screenshot({ path: path.join(SHOTS, 'inject-pg-essay.png') })
console.log('saved', path.join(SHOTS, 'inject-pg-essay.png'), 'replacements:', await page.locator('[data-contexto="true"]').count())
await context.close()
