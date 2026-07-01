// Multi-site performance harness. Loads the built extension in a real Chromium
// and measures, on several real web pages, how long the content script takes to
// finish injecting replacements and how much JS heap the renderer uses — in two
// modes: CORE-only (default) vs AGGRESSIVE (core + the lazy niche tail). The
// core-vs-aggressive delta on the same page isolates the cost of the 100k-word
// tail, answering "does the bigger dictionary hurt page speed?".
//
//   npm run build && node tests/live/run-perf.mjs
//
// Real-page fixtures live in tests/live/fixtures/perf/ (gitignored, reproducible
// via the curl commands in the morning report). Results -> tests/live/perf-results.json
import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const DIST = path.join(ROOT, 'dist')
const DISTTEST = path.join(__dirname, '.dist-test')
const SHOTS = path.join(__dirname, 'screenshots')
const FIXDIR = path.join(__dirname, 'fixtures', 'perf')

const LANG = 'es' // measured in the shipping default language
// Real content-heavy pages saved as local fixtures (offline + deterministic).
// (A JS-rendered page like a news site has no readable text in its static HTML,
// so it is not a useful injection/perf fixture.)
const SITES = [
  'wikipedia-photosynthesis',
  'wikipedia-roman-empire',
  'gutenberg-alice',
  'pg-essay',
  'mdn-array',
].filter((name) => fs.existsSync(path.join(FIXDIR, `${name}.html`)))

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

function settingsFor(aggressive) {
  return {
    contexto_settings: {
      onboarded: true, level: 'advanced', targetLanguage: LANG, density: 0.95,
      replacementsEnabled: true, quizzesEnabled: false, aggressiveMode: aggressive,
      blockedDomains: [], domainDecisions: {},
    },
  }
}

// Poll the replacement count until it stops changing (injection settled) or a cap
// is hit; return {ms, count} measured from when polling began (post page-load).
async function measureInjection(page) {
  const start = Date.now()
  let last = -1
  let stableFor = 0
  const DEADLINE = 12000
  while (Date.now() - start < DEADLINE) {
    const count = await page.locator('[data-contexto="true"]').count()
    if (count === last) {
      stableFor += 150
      if (count > 0 && stableFor >= 600) break
    } else {
      stableFor = 0
      last = count
    }
    await page.waitForTimeout(150)
  }
  return { ms: Date.now() - start, count: last }
}

async function heapMB(page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const { metrics } = await cdp.send('Performance.getMetrics')
  const heap = metrics.find((m) => m.name === 'JSHeapUsedSize')
  await cdp.detach()
  return heap ? +(heap.value / (1024 * 1024)).toFixed(1) : null
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

  const rows = []
  let failures = 0

  for (const site of SITES) {
    const url = pathToFileURL(path.join(FIXDIR, `${site}.html`)).href
    const perMode = {}
    for (const aggressive of [false, true]) {
      const mode = aggressive ? 'aggressive' : 'core'
      const sw = await getServiceWorker(context)
      await sw.evaluate(async (data) => {
        await chrome.storage.local.clear()
        await chrome.storage.local.set(data)
      }, settingsFor(aggressive))

      const page = await context.newPage()
      // Only the EXTENSION's own errors matter; real-page fixtures loaded over
      // file:// emit unrelated console noise (blocked external resources, CSP).
      const consoleErrors = []
      page.on('console', (m) => {
        if (m.type() === 'error' && m.text().includes('Contexto')) consoleErrors.push(m.text().slice(0, 160))
      })
      await page.goto(url, { waitUntil: 'load' })
      const { ms, count } = await measureInjection(page)
      const heap = await heapMB(page)
      perMode[mode] = { ms, count, heap, errors: consoleErrors.length }

      // Injection proof on two distinct real pages (aggressive mode) for the report.
      if (aggressive && (site === 'wikipedia-photosynthesis' || site === 'gutenberg-alice')) {
        await page.screenshot({ path: path.join(SHOTS, `inject-${site}.png`), fullPage: false })
      }
      if (mode === 'core' && (count === 0 || consoleErrors.length > 0)) failures++
      await page.close()
    }
    rows.push({ site, ...perMode })
    const c = perMode.core, a = perMode.aggressive
    console.log(
      `${site.padEnd(26)} core: ${String(c.count).padStart(4)} repl / ${String(c.ms).padStart(5)}ms / ${c.heap}MB` +
      `   aggressive: ${String(a.count).padStart(4)} repl / ${String(a.ms).padStart(5)}ms / ${a.heap}MB`,
    )
  }

  // Popup screenshot showing the aggressive-mode toggle for the report.
  try {
    const sw = await getServiceWorker(context)
    await sw.evaluate(async (data) => { await chrome.storage.local.set(data) }, settingsFor(true))
    const host = new URL((await getServiceWorker(context)).url()).host
    const popup = await context.newPage()
    await popup.goto(`chrome-extension://${host}/popup/index.html`, { waitUntil: 'domcontentloaded' })
    await popup.waitForTimeout(1200)
    await popup.screenshot({ path: path.join(SHOTS, 'perf-popup-toggle.png') })
    await popup.close()
  } catch (e) { console.warn('popup screenshot failed:', e.message) }

  await context.close()

  const summary = {
    language: LANG, sites: rows.length, generatedFrom: 'tests/live/fixtures/perf',
    rows,
    aggregate: {
      coreAvgMs: Math.round(rows.reduce((s, r) => s + r.core.ms, 0) / rows.length),
      aggressiveAvgMs: Math.round(rows.reduce((s, r) => s + r.aggressive.ms, 0) / rows.length),
      coreAvgHeapMB: +(rows.reduce((s, r) => s + (r.core.heap || 0), 0) / rows.length).toFixed(1),
      aggressiveAvgHeapMB: +(rows.reduce((s, r) => s + (r.aggressive.heap || 0), 0) / rows.length).toFixed(1),
    },
  }
  fs.writeFileSync(path.join(__dirname, 'perf-results.json'), JSON.stringify(summary, null, 2))
  console.log('\naggregate:', JSON.stringify(summary.aggregate))
  console.log(`results -> tests/live/perf-results.json  screenshots -> ${SHOTS}`)
  if (failures) { console.log(`FAILURES: ${failures} site(s) rendered nothing in core mode`); process.exitCode = 1 }
}

run().catch((e) => { console.error(e); process.exit(2) })
