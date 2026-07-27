// Deterministic Chrome Web Store screenshots from the final built extension.
//
//   npm run build
//   npm run capture:store-assets
//
// The script captures into a temporary directory first. It starts publishing
// the new five-file set to store-assets/screenshots/ only after every image
// exists and has the required 1280x800 dimensions, so capture or validation
// failures leave the existing store assets untouched.
import { chromium } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const DIST = path.join(ROOT, 'dist')
const STORE_FIXTURE = path.join(ROOT, 'store-assets', 'demo-article.html')
const STORE_SCREENSHOTS = path.join(ROOT, 'store-assets', 'screenshots')
const WIDTH = 1280
const HEIGHT = 800

const OUTPUTS = [
  '01-immersion-es.png',
  '02-hover-de-grammar.png',
  '03-popup-languages-status.png',
  '04-popup-controls.png',
  '05-popup-review.png',
]

// These are the pre-v0.3.0 assets. They are removed only after the complete new
// set has been captured and validated.
const RETIRED_OUTPUTS = [
  '01-immersion.png',
  '02-hover-tooltip.png',
  '03-saved-word.png',
  '04-popup.png',
]

const SETTINGS_KEY = 'contexto_settings'
const LEXICON_KEY = 'contexto_lexicon'
const SESSION_KEY = 'contexto_session'

const FIXED_NOW = Date.UTC(2026, 6, 26, 12, 0, 0)
const SAVED_LEMMAS = ['book', 'family', 'window', 'word', 'school']

function assertInputs() {
  if (!fs.existsSync(DIST)) {
    throw new Error('dist/ is missing; run `npm run build` first')
  }
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error('dist/manifest.json is missing; rebuild the extension')
  }
  if (!fs.existsSync(STORE_FIXTURE)) {
    throw new Error(`store fixture is missing: ${STORE_FIXTURE}`)
  }
}

function makeCaptureBuild(parentDir) {
  const captureDist = path.join(parentDir, 'extension')
  fs.cpSync(DIST, captureDist, { recursive: true })

  // The production extension intentionally has no background worker. A tiny
  // capture-only worker gives Playwright a stable extension context from which
  // to seed chrome.storage.local; it is never copied into dist/ or the package.
  const manifestFile = path.join(captureDist, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  manifest.background = { service_worker: 'capture-sw.js' }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
  fs.writeFileSync(
    path.join(captureDist, 'capture-sw.js'),
    'self.addEventListener("install", () => self.skipWaiting())\n',
  )
  return captureDist
}

async function getServiceWorker(context) {
  let [worker] = context.serviceWorkers()
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 15000 })
  }
  return worker
}

function settingsFor(targetLanguage, density) {
  return {
    onboarded: true,
    level: 'advanced',
    targetLanguage,
    density,
    replacementsEnabled: true,
    blockedDomains: [],
    disabledPartsOfSpeech: ['verb'],
    domainDecisions: {},
  }
}

function seededLexicon() {
  return Object.fromEntries(SAVED_LEMMAS.map((lemma, index) => [
    lemma,
    {
      seenCount: 4 + index,
      lastSeenAt: FIXED_NOW - (index + 1) * 60_000,
      lastReviewedAt: FIXED_NOW - (index + 2) * 86_400_000,
      srsInterval: 1,
      srsEaseFactor: 2.5,
      srsRepetitions: 0,
      recallHistory: [],
      lifecycleState: 'learning',
      selfMarkedKnown: false,
      selfMarkedUnknown: true,
      selfMarkedUnknownAt: FIXED_NOW - index * 1_000,
    },
  ]))
}

function seededSession() {
  return {
    pageUrl: pathToFileURL(STORE_FIXTURE).href,
    startedAt: FIXED_NOW - 30 * 60_000,
    wordsSeen: SAVED_LEMMAS.map((englishLemma, index) => ({
      englishLemma,
      seenAt: FIXED_NOW - (index + 1) * 60_000,
    })),
  }
}

async function seedStorage(worker, targetLanguage, density, includeReviewData = false) {
  await worker.evaluate(async ({ settingsKey, lexiconKey, sessionKey, settings, lexicon, session }) => {
    await chrome.storage.local.clear()
    await chrome.storage.local.set({
      [settingsKey]: settings,
      [lexiconKey]: lexicon,
      [sessionKey]: session,
    })
  }, {
    settingsKey: SETTINGS_KEY,
    lexiconKey: LEXICON_KEY,
    sessionKey: SESSION_KEY,
    settings: settingsFor(targetLanguage, density),
    lexicon: includeReviewData ? seededLexicon() : {},
    session: includeReviewData
      ? seededSession()
      : { pageUrl: '', startedAt: FIXED_NOW, wordsSeen: [] },
  })
}

async function waitForStableReplacements(page, selector = '[data-contexto="true"]') {
  await page.waitForSelector(selector, { timeout: 12000 })

  let previous = -1
  let unchangedSamples = 0
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    const count = await page.locator('[data-contexto="true"]').count()
    if (count === previous) unchangedSamples++
    else unchangedSamples = 0
    if (unchangedSamples >= 4) return
    previous = count
    await page.waitForTimeout(400)
  }
  throw new Error('replacement count did not settle before screenshot capture')
}

async function disableMotion(page) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation: none !important;
        caret-color: transparent !important;
        transition: none !important;
      }
    `,
  })
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready
  })
}

async function captureViewport(page, outputDir, filename) {
  await disableMotion(page)
  await page.screenshot({
    path: path.join(outputDir, filename),
    fullPage: false,
    animations: 'disabled',
  })
  console.log(`captured ${filename}`)
}

async function openFixture(context) {
  const page = await context.newPage()
  await page.setViewportSize({ width: WIDTH, height: HEIGHT })
  await page.goto(pathToFileURL(STORE_FIXTURE).href, { waitUntil: 'load' })
  return page
}

async function preparePopup(popup, articlePage) {
  // Keep the article as Chrome's active tab while the popup reloads in the
  // background. The real PageStatus code then queries the real article content
  // script rather than describing the popup page itself.
  await articlePage.bringToFront()
  await popup.reload({ waitUntil: 'domcontentloaded' })
  await popup.waitForSelector('.lang-option', { timeout: 10000 })
  await popup.waitForSelector('.page-status__headline:not(:empty)', { timeout: 10000 })
  await popup.waitForSelector('.word-chip', { timeout: 10000 })

  // The production popup is 340px wide. Center that exact UI on the required
  // store canvas without changing any product styles inside the popup.
  await popup.addStyleTag({
    content: `
      html {
        min-height: 100%;
        background: #f4f6f9;
        scrollbar-width: none;
      }
      html::-webkit-scrollbar { display: none; }
      body {
        margin-left: auto !important;
        margin-right: auto !important;
      }
    `,
  })
  await disableMotion(popup)
}

async function scrollSectionToTop(page, title) {
  const section = page.locator('.section').filter({
    has: page.locator('.section-title', { hasText: title }),
  }).first()
  await section.waitFor({ state: 'visible', timeout: 10000 })
  await section.evaluate(element => {
    const top = element.getBoundingClientRect().top + window.scrollY - 24
    window.scrollTo({ top: Math.max(0, top), behavior: 'instant' })
  })
  await page.waitForTimeout(100)
}

function pngDimensions(filename) {
  const png = fs.readFileSync(filename)
  const signature = '89504e470d0a1a0a'
  if (png.subarray(0, 8).toString('hex') !== signature) {
    throw new Error(`${filename} is not a PNG`)
  }
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  }
}

function publishCompleteSet(tempOutputDir) {
  for (const filename of OUTPUTS) {
    const source = path.join(tempOutputDir, filename)
    if (!fs.existsSync(source)) throw new Error(`missing capture: ${filename}`)
    const dimensions = pngDimensions(source)
    if (dimensions.width !== WIDTH || dimensions.height !== HEIGHT) {
      throw new Error(
        `${filename} is ${dimensions.width}x${dimensions.height}; expected ${WIDTH}x${HEIGHT}`,
      )
    }
  }

  fs.mkdirSync(STORE_SCREENSHOTS, { recursive: true })
  for (const filename of OUTPUTS) {
    fs.copyFileSync(
      path.join(tempOutputDir, filename),
      path.join(STORE_SCREENSHOTS, filename),
    )
  }
  for (const filename of RETIRED_OUTPUTS) {
    fs.rmSync(path.join(STORE_SCREENSHOTS, filename), { force: true })
  }
}

async function run() {
  assertInputs()
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contexto-store-capture-'))
  const tempOutput = path.join(tempRoot, 'screenshots')
  const userDataDir = path.join(tempRoot, 'profile')
  fs.mkdirSync(tempOutput)

  let context
  try {
    const captureDist = makeCaptureBuild(tempRoot)
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      viewport: { width: WIDTH, height: HEIGHT },
      screen: { width: WIDTH, height: HEIGHT },
      args: [
        `--disable-extensions-except=${captureDist}`,
        `--load-extension=${captureDist}`,
        '--no-first-run',
        '--no-default-browser-check',
        `--window-size=${WIDTH},${HEIGHT}`,
      ],
    })

    const worker = await getServiceWorker(context)

    // 1. Readable Spanish immersion, intentionally below the wall-of-translation
    // densities used by the test harness.
    await seedStorage(worker, 'es', 0.35)
    let article = await openFixture(context)
    await waitForStableReplacements(article)
    await captureViewport(article, tempOutput, '01-immersion-es.png')
    await article.close()

    // 2. German grammar card: "sentence" is present in the stable fixture,
    // eligible in the current rendered band, and has the irregular plural Sätze.
    // This one capture visibly
    // demonstrates both the article and plural without altering production data.
    await seedStorage(worker, 'de', 1)
    article = await openFixture(context)
    const sentence = article.locator('[data-contexto="true"][data-base-target="Satz"]').first()
    await waitForStableReplacements(
      article,
      '[data-contexto="true"][data-base-target="Satz"]',
    )
    await sentence.hover()
    await article.locator('#contexto-tooltip').waitFor({ state: 'visible', timeout: 5000 })
    await article.waitForTimeout(150)
    await captureViewport(article, tempOutput, '02-hover-de-grammar.png')
    await article.close()

    // 3–5. Current popup states. Italian is active so the four-language picker
    // and target-first review chips demonstrate that the product is multilingual.
    await seedStorage(worker, 'it', 0.35, true)
    article = await openFixture(context)
    await waitForStableReplacements(article)

    const extensionId = new URL(worker.url()).host
    const popup = await context.newPage()
    await popup.setViewportSize({ width: WIDTH, height: HEIGHT })
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`, {
      waitUntil: 'domcontentloaded',
    })
    await preparePopup(popup, article)

    await popup.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await captureViewport(popup, tempOutput, '03-popup-languages-status.png')

    await scrollSectionToTop(popup, 'Word Types')
    await captureViewport(popup, tempOutput, '04-popup-controls.png')

    await scrollSectionToTop(popup, 'Unknown Words')
    await captureViewport(popup, tempOutput, '05-popup-review.png')

    await popup.close()
    await article.close()

    publishCompleteSet(tempOutput)
    console.log(`published ${OUTPUTS.length} screenshots -> ${STORE_SCREENSHOTS}`)
  } finally {
    if (context) await context.close().catch(() => {})
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
