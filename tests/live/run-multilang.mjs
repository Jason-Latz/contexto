// Live multi-language proof: load the built extension, switch the target language
// to German / French / Italian, and screenshot real word replacement on a fixture
// page — verifying the new packs + grammar adapters render in a real browser.
//
//   npm run build && node tests/live/run-multilang.mjs
//
// Screenshots -> tests/live/screenshots/multilang-<lang>.png  (+ popup-picker.png)
import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const DIST = path.join(ROOT, 'dist')
const DISTTEST = path.join(__dirname, '.dist-test')
const SHOTS = path.join(__dirname, 'screenshots')
const FIX = path.join(__dirname, 'fixtures')
const PAGE = pathToFileURL(path.join(FIX, 'article-light.html')).href

const LANGS = [
  { code: 'de', name: 'German' },
  { code: 'fr', name: 'French' },
  { code: 'it', name: 'Italian' },
]

function makeTestBuild() {
  if (!fs.existsSync(DIST)) throw new Error('dist/ missing — run `npm run build` first')
  fs.rmSync(DISTTEST, { recursive: true, force: true })
  fs.cpSync(DIST, DISTTEST, { recursive: true })
  const mfPath = path.join(DISTTEST, 'manifest.json')
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'))
  mf.background = { service_worker: 'test-sw.js' }
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2))
  fs.writeFileSync(path.join(DISTTEST, 'test-sw.js'),
    'self.addEventListener("install", () => self.skipWaiting())\n')
}

async function getServiceWorker(context) {
  let [sw] = context.serviceWorkers()
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 })
  return sw
}

function settingsFor(code) {
  return {
    contexto_settings: {
      onboarded: true, level: 'advanced', targetLanguage: code, density: 0.95,
      replacementsEnabled: true, quizzesEnabled: false, blockedDomains: [], domainDecisions: {},
    },
  }
}

async function run() {
  makeTestBuild()
  fs.mkdirSync(SHOTS, { recursive: true })
  const userDataDir = path.join(__dirname, '.user-data')
  fs.rmSync(userDataDir, { recursive: true, force: true })

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${DISTTEST}`,
      `--load-extension=${DISTTEST}`,
      '--no-first-run', '--no-default-browser-check',
    ],
  })

  const results = []
  let failures = 0

  for (const lang of LANGS) {
    const sw = await getServiceWorker(context)
    await sw.evaluate(async (data) => {
      await chrome.storage.local.clear()
      await chrome.storage.local.set(data)
    }, settingsFor(lang.code))

    const page = await context.newPage()
    const consoleErrors = []
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)) })
    await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    try { await page.waitForSelector('[data-contexto="true"]', { timeout: 6000 }) } catch {}

    const spanCount = await page.locator('[data-contexto="true"]').count()
    const samples = await page.locator('[data-contexto="true"]').evaluateAll(
      (els) => els.slice(0, 24).map((e) => ({
        source: e.getAttribute('data-source'), target: e.getAttribute('data-target'),
      })))
    await page.screenshot({ path: path.join(SHOTS, `multilang-${lang.code}.png`), fullPage: false })

    const ok = spanCount > 0 && consoleErrors.length === 0
    if (!ok) failures++
    results.push({ lang: lang.code, spanCount, consoleErrors, samples })
    console.log(`[${ok ? 'ok' : 'FAIL'}] ${lang.name}: ${spanCount} replacements${consoleErrors.length ? ` — ${consoleErrors.length} console error(s)` : ''}`)
    console.log('   ' + samples.slice(0, 12).map((s) => `${s.source}→${s.target}`).join('  '))
    await page.close()
  }

  // Popup screenshot showing the language picker (seed Italian as active).
  const sw = await getServiceWorker(context)
  await sw.evaluate(async (data) => { await chrome.storage.local.set(data) }, settingsFor('it'))
  const id = new URL((await getServiceWorker(context)).url()).host
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${id}/popup/index.html`, { waitUntil: 'domcontentloaded' })
  await popup.waitForTimeout(1000)
  await popup.screenshot({ path: path.join(SHOTS, 'popup-picker.png') })
  await popup.close()

  await context.close()
  fs.writeFileSync(path.join(SHOTS, 'multilang-results.json'), JSON.stringify(results, null, 2))
  console.log(`\nscreenshots -> ${SHOTS}`)
  if (failures) { console.log(`FAILURES: ${failures} language(s) rendered nothing or logged errors`); process.exitCode = 1 }
}

run().catch((e) => { console.error(e); process.exit(2) })
