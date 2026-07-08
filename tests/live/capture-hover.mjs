// Capture hover-card screenshots: load the built extension on the committed
// article fixture, hover injected words (a noun and a non-noun where possible),
// and screenshot the tooltip card for Spanish and German.
//
//   npm run build && node tests/live/capture-hover.mjs [label]
//
// `label` (default "after") prefixes the output files, so a before/after pair is
//   node tests/live/capture-hover.mjs before   (on the old build)
//   node tests/live/capture-hover.mjs after    (on the new build)
// Screenshots -> tests/live/screenshots/hover-<label>-<lang>-<kind>.png
import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const DIST = path.join(ROOT, 'dist')
const DISTTEST = path.join(__dirname, '.dist-test')
const SHOTS = path.join(__dirname, 'screenshots')
const PAGE = pathToFileURL(path.join(__dirname, 'fixtures', 'article-light.html')).href

const LABEL = process.argv[2] ?? 'after'
const LANGS = ['es', 'de']

function makeTestBuild() {
  if (!fs.existsSync(DIST)) throw new Error('dist/ missing, run `npm run build` first')
  fs.rmSync(DISTTEST, { recursive: true, force: true })
  fs.cpSync(DIST, DISTTEST, { recursive: true })
  const mfPath = path.join(DISTTEST, 'manifest.json')
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'))
  mf.background = { service_worker: 'test-sw.js' }
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2))
  fs.writeFileSync(path.join(DISTTEST, 'test-sw.js'),
    'self.addEventListener("install", () => self.skipWaiting())\n')
}

async function sw(context) {
  let [s] = context.serviceWorkers()
  if (!s) s = await context.waitForEvent('serviceworker', { timeout: 15000 })
  return s
}

// Pick one span handle per kind. data-pos is only present on new builds; the
// fallbacks (an article-bearing target = noun, a bare single word = non-noun)
// keep the script usable on old builds for the BEFORE capture.
async function pickSpans(page) {
  const spans = page.locator('[data-contexto="true"]')
  const n = await spans.count()
  let noun = null
  let other = null
  for (let i = 0; i < n && (!noun || !other); i++) {
    const s = spans.nth(i)
    const pos = await s.getAttribute('data-pos')
    const target = (await s.getAttribute('data-target')) ?? ''
    const isNoun = pos ? pos === 'noun' : target.includes(' ')
    if (isNoun && !noun) noun = s
    if (!isNoun && !other && (pos ? pos !== 'noun' : true)) other = s
  }
  return { noun, other }
}

async function captureHover(page, span, file) {
  await span.hover()
  const tip = page.locator('#contexto-tooltip')
  await tip.waitFor({ state: 'visible', timeout: 4000 })
  // The card positions itself on mousemove; let layout settle before shooting.
  await page.waitForTimeout(150)
  // Full-viewport shot: the card in its page context reads best, and clip
  // math against the absolutely-positioned card proved unreliable.
  await page.screenshot({ path: file })
  const text = await tip.innerText()
  console.log(`saved ${file}\n  card: ${text.replace(/\n/g, ' | ')}`)
  await page.mouse.move(5, 5) // dismiss before the next capture
}

async function run() {
  makeTestBuild()
  fs.mkdirSync(SHOTS, { recursive: true })
  const userDataDir = path.join(__dirname, '.user-data')
  fs.rmSync(userDataDir, { recursive: true, force: true })

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${DISTTEST}`, `--load-extension=${DISTTEST}`,
      '--no-first-run', '--no-default-browser-check'],
  })

  for (const lang of LANGS) {
    await (await sw(context)).evaluate(async (settings) => {
      await chrome.storage.local.clear()
      await chrome.storage.local.set(settings)
    }, {
      contexto_settings: {
        onboarded: true, level: 'advanced', targetLanguage: lang, density: 0.95,
        replacementsEnabled: true, blockedDomains: [], domainDecisions: {},
      },
    })

    const page = await context.newPage()
    await page.goto(PAGE, { waitUntil: 'load' })
    await page.waitForSelector('[data-contexto="true"]', { timeout: 8000 })
    await page.waitForTimeout(500)

    const { noun, other } = await pickSpans(page)
    if (noun) await captureHover(page, noun, path.join(SHOTS, `hover-${LABEL}-${lang}-noun.png`))
    else console.log(`[${lang}] no noun-like span found`)
    if (other) await captureHover(page, other, path.join(SHOTS, `hover-${LABEL}-${lang}-other.png`))
    else console.log(`[${lang}] no non-noun span found`)
    await page.close()
  }

  await context.close()
}

run().catch((e) => { console.error(e); process.exit(2) })
