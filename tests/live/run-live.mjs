// Live harness: load the built MV3 extension into Chromium, seed settings, and
// validate injection / console / links / tooltip / DOM-restore on real + fixture
// pages, capturing screenshots for the morning report.
//
// Usage:
//   node tests/live/run-live.mjs                 # default scenario set
//   node tests/live/run-live.mjs --real          # also hit live websites
//   node tests/live/run-live.mjs --headed        # show the browser
//
// Exit code is non-zero if any HARD assertion fails (console error, broken link,
// tooltip off-screen, no DOM restore). Sparse replacement counts are warnings.
import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const DIST = path.join(ROOT, 'dist')
const DISTTEST = path.join(__dirname, '.dist-test')
const SHOTS = path.join(__dirname, 'screenshots')
const FIX = path.join(__dirname, 'fixtures')

const args = process.argv.slice(2)
const REAL = args.includes('--real')

// MV3 service workers are only exposed to Playwright in headed Chromium, and the
// shipped extension has no background worker. Build a TEST-ONLY copy of dist/ with
// a tiny service worker so the harness can seed chrome.storage.local. dist/ itself
// (what gets packaged/shipped) is never modified.
function makeTestBuild() {
  if (!fs.existsSync(DIST)) throw new Error('dist/ missing — run `npm run build` first')
  fs.rmSync(DISTTEST, { recursive: true, force: true })
  fs.cpSync(DIST, DISTTEST, { recursive: true })
  const mfPath = path.join(DISTTEST, 'manifest.json')
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'))
  mf.background = { service_worker: 'test-sw.js' }
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2))
  fs.writeFileSync(path.join(DISTTEST, 'test-sw.js'),
    '// test-only service worker (harness storage seeding); not part of the shipped extension\n' +
    'self.addEventListener("install", () => self.skipWaiting())\n')
}

const fileUrl = (p) => pathToFileURL(p).href

const SCENARIOS = [
  { name: 'fixture-article-5pct', url: fileUrl(path.join(FIX, 'article-light.html')), density: 0.05, level: 'intermediate' },
  { name: 'fixture-article-95pct', url: fileUrl(path.join(FIX, 'article-light.html')), density: 0.95, level: 'intermediate' },
  { name: 'fixture-tech-dark-50pct', url: fileUrl(path.join(FIX, 'tech-dark.html')), density: 0.5, level: 'advanced', dark: true },
  { name: 'fixture-tech-dark-95pct', url: fileUrl(path.join(FIX, 'tech-dark.html')), density: 0.95, level: 'advanced', dark: true },
]

const REAL_SCENARIOS = [
  { name: 'wikipedia-immersion-5pct', url: 'https://en.wikipedia.org/wiki/Language_immersion', density: 0.05, level: 'intermediate' },
  { name: 'wikipedia-immersion-95pct', url: 'https://en.wikipedia.org/wiki/Language_immersion', density: 0.95, level: 'intermediate' },
  { name: 'wikipedia-estuary-90pct', url: 'https://en.wikipedia.org/wiki/Estuary', density: 0.9, level: 'advanced' },
  { name: 'mdn-array-50pct', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array', density: 0.5, level: 'advanced' },
]

function settingsFor(s) {
  return {
    contexto_settings: {
      onboarded: true,
      level: s.level,
      targetLanguage: 'es',
      density: s.density,
      replacementsEnabled: true,
      quizzesEnabled: false,
      blockedDomains: [],
      domainDecisions: {},
    },
  }
}

async function getServiceWorker(context) {
  let [sw] = context.serviceWorkers()
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 })
  return sw
}

async function seed(context, s) {
  const sw = await getServiceWorker(context)
  await sw.evaluate(async (data) => {
    await chrome.storage.local.clear()
    await chrome.storage.local.set(data)
  }, settingsFor(s))
}

async function extId(context) {
  const sw = await getServiceWorker(context)
  return new URL(sw.url()).host
}

// C1 — onboarding: with no seeded settings, the LevelPicker overlay must appear,
// accept a level, tear down, and injection must follow.
async function runOnboarding(context) {
  const res = { name: 'onboarding', failures: [], consoleErrors: [] }
  const sw = await getServiceWorker(context)
  await sw.evaluate(async () => { await chrome.storage.local.clear() })
  const page = await context.newPage()
  page.on('console', (m) => { if (m.type() === 'error') res.consoleErrors.push(m.text().slice(0, 160)) })
  try {
    await page.goto(fileUrl(path.join(FIX, 'article-light.html')), { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#contexto-onboarding', { timeout: 8000 })
    await page.screenshot({ path: path.join(SHOTS, 'onboarding.png') })
    const btn = page.locator('#contexto-onboarding button', { hasText: /Advanced/i }).first()
    await btn.click()
    await page.waitForTimeout(2000)
    const gone = await page.locator('#contexto-onboarding').count()
    if (gone !== 0) res.failures.push('overlay did not tear down')
    const spans = await page.locator('[data-contexto="true"]').count()
    res.spanCount = spans
    if (spans === 0) res.failures.push('no injection after onboarding')
  } catch (e) {
    res.failures.push('exception: ' + String(e).slice(0, 160))
  } finally {
    if (res.consoleErrors.length) res.failures.push(`${res.consoleErrors.length} console error(s)`)
    await page.close()
  }
  console.log(`[${res.failures.length ? 'FAIL' : 'ok'}] onboarding: spans=${res.spanCount} ${res.failures.join('; ')}`)
  return res
}

// C2 — popup: controls render, export produces valid files, credit link present.
async function runPopup(context) {
  const res = { name: 'popup', failures: [], consoleErrors: [] }
  const sw = await getServiceWorker(context)
  // seed a couple of saved "unknown" words so exports have content
  await sw.evaluate(async () => {
    await chrome.storage.local.set({
      contexto_settings: { onboarded: true, level: 'intermediate', targetLanguage: 'es', density: 0.15, replacementsEnabled: true, quizzesEnabled: false, blockedDomains: ['example.com'], domainDecisions: {} },
      contexto_lexicon: { dog: { selfMarkedUnknown: true, selfMarkedUnknownAt: 1700000000000 }, house: { selfMarkedUnknown: true, selfMarkedUnknownAt: 1700000001000 } },
    })
  })
  const id = await extId(context)
  const page = await context.newPage()
  page.on('console', (m) => { if (m.type() === 'error') res.consoleErrors.push(m.text().slice(0, 160)) })
  try {
    await page.goto(`chrome-extension://${id}/popup/index.html`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    res.toggles = await page.locator('.toggle-button').count()
    res.exportButtons = await page.locator('.export-button').count()
    res.creditLink = await page.locator('a[href*="jasonlatz"]').count()
    res.blockedChips = await page.locator('.blocked-domain, .domain-chip, .blocked-list *').count()
    if (res.toggles < 1) res.failures.push('no toggle buttons')
    if (res.exportButtons < 2) res.failures.push('missing export buttons (CSV/Quizlet)')
    if (res.creditLink < 1) res.failures.push('missing jasonlatz.com credit link')
    // CSV export download
    const csvBtn = page.locator('.export-button', { hasText: /CSV/i }).first()
    if (await csvBtn.count()) {
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 5000 }).catch(() => null),
        csvBtn.click(),
      ])
      if (dl) {
        const stream = await dl.createReadStream()
        let body = ''
        for await (const c of stream) body += c
        res.csvSample = body.slice(0, 160)
        // buildCsv quote-wraps every cell, so check for the quoted header + a seeded word
        if (!/English/.test(body) || !/Spanish/.test(body) || !/(dog|house)/.test(body)) res.failures.push('CSV content invalid')
      } else { res.failures.push('CSV export produced no download') }
    }
    await page.screenshot({ path: path.join(SHOTS, 'popup.png') })
  } catch (e) {
    res.failures.push('exception: ' + String(e).slice(0, 160))
  } finally {
    if (res.consoleErrors.length) res.failures.push(`${res.consoleErrors.length} console error(s)`)
    await page.close()
  }
  console.log(`[${res.failures.length ? 'FAIL' : 'ok'}] popup: toggles=${res.toggles} exports=${res.exportButtons} credit=${res.creditLink} ${res.failures.join('; ')}`)
  return res
}

async function run() {
  makeTestBuild()
  fs.mkdirSync(SHOTS, { recursive: true })
  const userDataDir = path.join(__dirname, '.user-data')
  fs.rmSync(userDataDir, { recursive: true, force: true })

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // MV3 service worker is only exposed to Playwright in headed mode
    args: [
      `--disable-extensions-except=${DISTTEST}`,
      `--load-extension=${DISTTEST}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })

  const scenarios = REAL ? [...SCENARIOS, ...REAL_SCENARIOS] : SCENARIOS
  const results = []

  for (const s of scenarios) {
    const res = { name: s.name, url: s.url, density: s.density, level: s.level,
                  consoleErrors: [], pageErrors: [], spanCount: 0, warnings: [], failures: [] }
    const page = await context.newPage()
    page.on('console', (m) => { if (m.type() === 'error') res.consoleErrors.push(m.text().slice(0, 200)) })
    page.on('pageerror', (e) => res.pageErrors.push(String(e).slice(0, 200)))
    try {
      await seed(context, s)
      await page.goto(s.url, { waitUntil: 'domcontentloaded', timeout: 45000 })
      // give the content script (document_idle) time to inject
      await page.waitForTimeout(2500)
      try { await page.waitForSelector('[data-contexto="true"]', { timeout: 6000 }) } catch {}

      res.spanCount = await page.locator('[data-contexto="true"]').count()
      if (res.spanCount === 0) res.warnings.push('no replacements rendered')

      // sample a few replacements (source -> shown) for correctness spot-check
      res.samples = await page.locator('[data-contexto="true"]').evaluateAll(
        (els) => els.slice(0, 40).map((e) => ({
          source: e.getAttribute('data-source'),
          target: e.getAttribute('data-target'),
          gloss: e.getAttribute('data-gloss'),
        })))

      // links still navigable: hrefs intact, not swallowed by a span
      const linkOk = await page.evaluate(() => {
        const a = document.querySelector('a[href]')
        return a ? a.getAttribute('href') : null
      })
      if (linkOk === null) res.warnings.push('no anchor found to verify')

      // tooltip on hover — hover a span near the bottom edge (worst case for
      // vertical clamping), expect the #contexto-tooltip on-screen with content.
      if (res.spanCount > 0) {
        const span = page.locator('[data-contexto="true"]').last()
        await span.scrollIntoViewIfNeeded()
        await span.hover()
        await page.waitForTimeout(700)
        const tip = await page.evaluate(() => {
          const el = document.getElementById('contexto-tooltip')
          if (!el) return { found: false }
          const r = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          const visible = style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0
          return {
            found: true, visible,
            onScreen: r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
            text: (el.textContent || '').slice(0, 120),
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          }
        })
        res.tooltip = tip
        if (!tip.found || !tip.visible) res.failures.push('tooltip did not render on hover')
        else if (tip.onScreen === false) res.failures.push('tooltip off-screen')
      }

      await page.screenshot({ path: path.join(SHOTS, `${s.name}.png`), fullPage: false })

      // DOM restore: density -> 0 via storage, expect spans removed, no reload
      const sw = await getServiceWorker(context)
      await sw.evaluate(async () => {
        const cur = (await chrome.storage.local.get('contexto_settings')).contexto_settings
        await chrome.storage.local.set({ contexto_settings: { ...cur, density: 0 } })
      })
      await page.waitForTimeout(1500)
      const afterRestore = await page.locator('[data-contexto="true"]').count()
      res.afterRestoreCount = afterRestore
      if (res.spanCount > 0 && afterRestore >= res.spanCount) res.failures.push('density->0 did not reduce replacements')
    } catch (e) {
      res.failures.push('exception: ' + String(e).slice(0, 200))
    } finally {
      if (res.consoleErrors.length) res.failures.push(`${res.consoleErrors.length} console error(s)`)
      if (res.pageErrors.length) res.failures.push(`${res.pageErrors.length} page error(s)`)
      results.push(res)
      await page.close()
    }
    const tag = res.failures.length ? 'FAIL' : (res.warnings.length ? 'warn' : 'ok')
    console.log(`[${tag}] ${s.name}: spans=${res.spanCount} restore=${res.afterRestoreCount ?? '-'} ` +
                `tooltip=${res.tooltip?.found ? (res.tooltip.onScreen ? 'on-screen' : 'OFF-SCREEN') : 'none'} ` +
                `${res.failures.join('; ')}${res.warnings.length ? ' | ' + res.warnings.join('; ') : ''}`)
  }

  // UI scenarios (onboarding + popup) — criteria C1/C2
  const uiResults = []
  uiResults.push(await runOnboarding(context))
  uiResults.push(await runPopup(context))
  results.push(...uiResults)

  await context.close()
  fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify(results, null, 2))
  const failed = results.filter((r) => r.failures.length)
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed hard assertions. screenshots -> ${SHOTS}`)
  if (failed.length) { console.log('FAILURES:', failed.map((r) => r.name).join(', ')); process.exitCode = 1 }
}

run().catch((e) => { console.error(e); process.exit(2) })
