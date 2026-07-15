// Live regression gate for the four beta-tester reports. Loads the built
// extension into a real Chromium profile and drives the real popup UI.
//
//   npm run build && node tests/live/repro-bugs.mjs
//
// Exits non-zero if any scenario fails. To see it go red, build from before the
// fix (`git stash && npm run build`) and run it again.
//
// Fixtures are served over http:// rather than file:// so page lifecycle
// behaves the way it does on the web.
import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const DIST = path.join(ROOT, 'dist')
const DISTTEST = path.join(__dirname, '.dist-repro')
const FIXDIR = path.join(__dirname, 'fixtures')

const ONBOARDED_ES = {
  onboarded: true, level: 'advanced', targetLanguage: 'es', density: 0.9,
  replacementsEnabled: true, blockedDomains: [], domainDecisions: {},
}

function makeTestBuild() {
  if (!fs.existsSync(DIST)) throw new Error('dist/ missing — run `npm run build` first')
  fs.rmSync(DISTTEST, { recursive: true, force: true })
  fs.cpSync(DIST, DISTTEST, { recursive: true })
  const mfPath = path.join(DISTTEST, 'manifest.json')
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'))
  // A service worker is the only handle Playwright gives us on the extension
  // origin (storage seeding + the extension id). It is NOT part of the shipped
  // manifest, and no fix under test depends on it.
  mf.background = { service_worker: 'test-sw.js' }
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2))
  fs.writeFileSync(path.join(DISTTEST, 'test-sw.js'),
    'self.addEventListener("install", () => self.skipWaiting())\n')
}

function serveFixtures() {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '')
    const file = path.join(FIXDIR, name)
    if (!file.startsWith(FIXDIR) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(fs.readFileSync(file))
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve({ server, base: `http://127.0.0.1:${server.address().port}` })))
}

async function getServiceWorker(context) {
  let [sw] = context.serviceWorkers()
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 })
  return sw
}

async function launch(profileName) {
  const userDataDir = path.join(__dirname, `.user-data-${profileName}`)
  fs.rmSync(userDataDir, { recursive: true, force: true })
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${DISTTEST}`,
      `--load-extension=${DISTTEST}`,
      '--no-first-run', '--no-default-browser-check',
    ],
  })
  const sw = await getServiceWorker(context)
  return { context, sw, extId: new URL(sw.url()).host }
}

async function seed(sw, settings) {
  await sw.evaluate(async (data) => {
    await chrome.storage.local.clear()
    if (data) await chrome.storage.local.set({ contexto_settings: data })
  }, settings)
}

// Write settings straight to storage, the way the popup does.
async function setSetting(sw, patch) {
  await sw.evaluate(async (p) => {
    const cur = (await chrome.storage.local.get('contexto_settings')).contexto_settings ?? {}
    await chrome.storage.local.set({ contexto_settings: { ...cur, ...p } })
  }, patch)
}

const spans = page => page.locator('[data-contexto="true"]')
const pairs = page => spans(page).evaluateAll(els =>
  els.map(e => `${e.getAttribute('data-source')}→${e.getAttribute('data-target')}`))

// source word -> rendered target. Which words get chosen can shift between
// passes (page rank is retained across renders), so compare the TRANSLATIONS of
// the words both renders share, not the raw span list.
const targetsBySource = page => spans(page).evaluateAll(els =>
  Object.fromEntries(els.map(e => [e.getAttribute('data-source'), e.getAttribute('data-target')])))

// Do the two renders agree on every word they both replaced?
function sameLanguageAs(reference, actual) {
  const shared = Object.keys(actual).filter(source => source in reference)
  const agree = shared.filter(source => actual[source] === reference[source])
  return { shared: shared.length, agree: agree.length, ok: shared.length >= 3 && agree.length === shared.length }
}

// Drive the REAL popup UI: open the popup page and click a language pill.
async function clickLanguageInPopup(context, extId, displayName) {
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extId}/popup/index.html`, { waitUntil: 'domcontentloaded' })
  await popup.waitForSelector('.lang-option')
  await popup.locator('.lang-option', { hasText: displayName }).first().click()
  await popup.waitForTimeout(600)
  await popup.close()
}

// Read the popup's page-status card for whatever tab is currently active.
//
// In a real browser the popup is anchored to a window, so
// tabs.query({active,currentWindow}) returns the web tab. Playwright renders the
// popup as an ordinary tab, so we park it in the BACKGROUND of the same window,
// bring the page under test to the front, and reload the popup in place. Its
// query then resolves to the page under test, exactly as in production. No stubs.
async function readPageStatus(popup, pageUnderTest) {
  await pageUnderTest.bringToFront()
  await popup.evaluate(() => location.reload())
  try {
    await popup.waitForSelector('.page-status__headline:not(:empty)', { timeout: 8000 })
  } catch {
    // No status card at all — the state this whole feature exists to remove.
    return { headline: '(no page-status card)', hint: '', working: false }
  }
  return {
    headline: await popup.locator('.page-status__headline').innerText(),
    hint: await popup.locator('.page-status__hint').innerText().catch(() => ''),
    working: await popup.locator('.page-status').evaluate(el => el.classList.contains('is-working')),
  }
}

const report = []
function check(id, title, passed, detail) {
  report.push({ id, title, passed, detail })
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${id}: ${title}\n        ${detail}`)
}

// --- Bug 1: language change updates the open page without a refresh ----------
async function bug1(base) {
  const { context, sw, extId } = await launch('bug1')
  await seed(sw, ONBOARDED_ES)

  const page = await context.newPage()
  await page.goto(`${base}/article-light.html`, { waitUntil: 'domcontentloaded' })
  await spans(page).first().waitFor({ timeout: 8000 })
  const before = await pairs(page)

  await clickLanguageInPopup(context, extId, 'German')
  await page.bringToFront()
  await page.waitForTimeout(2000)
  const after = await pairs(page)

  check('BUG1', 'Language change updates the open page without a refresh',
    JSON.stringify(before) !== JSON.stringify(after) && after.length > 0,
    `before=[${before.slice(0, 3)}] after=[${after.slice(0, 3)}]`)

  // The old language must be fully gone, not layered under the new one.
  const stale = after.filter(p => before.includes(p))
  check('BUG1b', 'No stale spans from the previous language survive the switch',
    stale.length === 0, `${stale.length} stale pair(s) remain`)

  await context.close()
}

// --- Bug 2: a background tab shows the new language when switched to ---------
async function bug2(base) {
  const { context, sw, extId } = await launch('bug2')
  await seed(sw, ONBOARDED_ES)

  const tabA = await context.newPage()
  await tabA.goto(`${base}/article-light.html`, { waitUntil: 'domcontentloaded' })
  await spans(tabA).first().waitFor({ timeout: 8000 })

  const tabB = await context.newPage()
  await tabB.goto(`${base}/article-light.html`, { waitUntil: 'domcontentloaded' })
  await spans(tabB).first().waitFor({ timeout: 8000 })
  const before = await pairs(tabB)

  await tabA.bringToFront()
  await clickLanguageInPopup(context, extId, 'French')
  await tabB.bringToFront()
  await tabB.waitForTimeout(2500)
  const after = await pairs(tabB)

  check('BUG2', 'Background tab shows the new language once switched to',
    JSON.stringify(before) !== JSON.stringify(after) && after.length > 0,
    `tabB before=[${before.slice(0, 3)}] after=[${after.slice(0, 3)}]`)

  // Switching tabs with nothing changed must not re-render or churn.
  const settled = await pairs(tabB)
  await tabA.bringToFront(); await tabB.bringToFront()
  await tabB.waitForTimeout(1200)
  check('REG-switch', 'Plain tab switching with no settings change is a no-op',
    JSON.stringify(settled) === JSON.stringify(await pairs(tabB)),
    'span set identical across two focus changes')

  await context.close()
}

// --- Bug 4: first use translates one page, another tab needs a language toggle
async function bug4(base) {
  const { context, sw } = await launch('bug4')
  await seed(sw, null)  // true first run: no stored settings at all

  const tabA = await context.newPage()
  // First run persists settings mid-pass (silent onboarding), which now queues a
  // re-diff. Watch the DOM: that re-diff must resolve to a no-op, not a second
  // restore-and-re-render of the page the user is already reading.
  await tabA.addInitScript(() => {
    window.__removed = 0
    new MutationObserver(muts => {
      for (const m of muts) {
        for (const n of m.removedNodes) {
          if (n.nodeType === 1 && n.getAttribute?.('data-contexto') === 'true') window.__removed++
        }
      }
    }).observe(document, { childList: true, subtree: true }) // document, NOT documentElement: null at init-script time, observe() would throw and leave the counter dead
  })
  await tabA.goto(`${base}/article-light.html`, { waitUntil: 'domcontentloaded' })
  let ok = true
  try { await spans(tabA).first().waitFor({ timeout: 8000 }) } catch { ok = false }
  check('BUG4a', 'First page on a fresh install is translated', ok,
    `${await spans(tabA).count()} spans`)

  await tabA.waitForTimeout(2500)
  const removed = await tabA.evaluate(() => window.__removed)
  check('REG-firstrun', 'First run renders once, with no restore-and-re-render churn',
    removed === 0, `${removed} injected span(s) were torn down again`)

  // A page whose article renders 2.5s after document_idle, with NO toggle.
  const tabB = await context.newPage()
  await tabB.goto(`${base}/spa-late.html`, { waitUntil: 'domcontentloaded' })
  await tabB.waitForSelector('h1', { timeout: 8000 })
  await tabB.waitForTimeout(3000)
  const late = await spans(tabB).count()
  check('BUG4b', 'Late-rendering page translates on its own, no toggle needed',
    late > 0, `${late} spans after the article arrived`)

  await context.close()
}

// --- Bug 3: the popup says what is happening on this page -------------------
async function bug3(base) {
  const { context, sw, extId } = await launch('bug3')
  await seed(sw, ONBOARDED_ES)

  // Park the popup in the background of the same window (see readPageStatus).
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extId}/popup/index.html`, { waitUntil: 'domcontentloaded' })

  const article = await context.newPage()
  await article.goto(`${base}/article-light.html`, { waitUntil: 'domcontentloaded' })
  await spans(article).first().waitFor({ timeout: 8000 })
  const active = await readPageStatus(popup, article)
  check('BUG3-active', 'Popup reports the swap count on a working page',
    /\d+ words swapped into Spanish/.test(active.headline) && active.working,
    JSON.stringify(active.headline))

  const short = await context.newPage()
  await short.goto(`${base}/too-short.html`, { waitUntil: 'domcontentloaded' })
  await short.waitForTimeout(1200)
  const shortStatus = await readPageStatus(popup, short)
  check('BUG3-short', 'Popup explains a page with too little text',
    /Nothing to swap here/.test(shortStatus.headline) && !shortStatus.working,
    `${JSON.stringify(shortStatus.headline)} / ${JSON.stringify(shortStatus.hint)}`)

  const blank = await context.newPage()
  await blank.goto('about:blank')
  const blankStatus = await readPageStatus(popup, blank)
  check('BUG3-unreachable', 'Popup names native Chrome pages as the reason it cannot run',
    /native Chrome pages/.test(blankStatus.headline),
    JSON.stringify(blankStatus.headline))

  await setSetting(sw, { replacementsEnabled: false })
  await article.waitForTimeout(800)
  const offStatus = await readPageStatus(popup, article)
  check('BUG3-off', 'Popup explains that replacement is switched off',
    /Text replacement is off/.test(offStatus.headline), JSON.stringify(offStatus.headline))

  await setSetting(sw, { replacementsEnabled: true, blockedDomains: ['127.0.0.1'] })
  await article.waitForTimeout(1200)
  const pausedStatus = await readPageStatus(popup, article)
  check('BUG3-paused', 'Popup explains a blocked domain',
    /Paused on this site/.test(pausedStatus.headline), JSON.stringify(pausedStatus.headline))

  // A page whose main thread is wedged cannot answer the status query. The rest
  // of the popup must not wait on it: the user still gets their controls.
  const wedged = await context.newPage()
  await wedged.goto(`${base}/article-light.html`, { waitUntil: 'domcontentloaded' })
  await wedged.waitForTimeout(1500)
  wedged.evaluate(() => { const t = Date.now(); while (Date.now() - t < 5000) { /* block */ } })
    .catch(() => {})
  await wedged.waitForTimeout(200)
  await wedged.bringToFront()
  await popup.evaluate(() => location.reload())
  const controlsAppeared = await popup.locator('.lang-option').first()
    .waitFor({ timeout: 2500 }).then(() => true).catch(() => false)
  check('REG-popup-nonblocking', 'Popup renders its controls even when the page cannot reply',
    controlsAppeared, controlsAppeared ? 'language picker present within 2.5s' : 'popup was blank')

  await context.close()
}

// --- A tab frozen while the language changes -------------------------------
// Chrome freezes idle background tabs. Freeze one through CDP, change the
// language while it cannot run a line of JS, then resume it.
//
// NOTE: this scenario does NOT exercise the pageshow handler. Measurement shows
// a frozen tab receives its queued storage.onChanged on resume, so what is under
// test here is the targetLanguage diff. Real bfcache is unreachable under
// Playwright (attaching CDP disables it).
async function frozenTab(base) {
  const { context, sw } = await launch('frozen')
  await seed(sw, ONBOARDED_ES)

  const article = await context.newPage()
  await article.goto(`${base}/article-light.html`, { waitUntil: 'domcontentloaded' })
  await spans(article).first().waitFor({ timeout: 8000 })
  const before = await pairs(article)

  const other = await context.newPage()
  await other.goto(`${base}/tech-dark.html`, { waitUntil: 'domcontentloaded' })
  await other.bringToFront()

  let froze = true
  const cdp = await context.newCDPSession(article)
  try {
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' })
  } catch (e) { froze = false; console.log('        (freeze unavailable:', e.message.slice(0, 60), ')') }

  await setSetting(sw, { targetLanguage: 'it' })
  await new Promise(r => setTimeout(r, 1200))
  if (froze) await cdp.send('Page.setWebLifecycleState', { state: 'active' })

  await article.bringToFront()
  await article.waitForTimeout(2500)
  const after = await pairs(article)

  check('FROZEN', 'Tab frozen during a language change catches up when it resumes',
    JSON.stringify(before) !== JSON.stringify(after) && after.length > 0,
    `froze=${froze} before=[${before.slice(0, 2)}] after=[${after.slice(0, 2)}]`)

  // The pageshow handler ships for bfcache restores, which cannot be reached
  // here. What we CAN pin down is that it is safe: firing it on an up-to-date
  // page must not tear the page down and re-inject it. Count span removals
  // rather than comparing the final set, which a restore-and-reinject would
  // reproduce identically.
  await article.evaluate(() => {
    window.__removed = 0
    new MutationObserver(muts => {
      for (const m of muts) {
        for (const n of m.removedNodes) {
          if (n.nodeType === 1 && n.getAttribute?.('data-contexto') === 'true') window.__removed++
        }
      }
    }).observe(document, { childList: true, subtree: true }) // document, NOT documentElement: null at init-script time, observe() would throw and leave the counter dead
    dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  })
  await article.waitForTimeout(1500)
  const tornDown = await article.evaluate(() => window.__removed)
  check('PAGESHOW-noop', 'pageshow(persisted) on an up-to-date page re-renders nothing',
    tornDown === 0 && JSON.stringify(await pairs(article)) === JSON.stringify(after),
    `${tornDown} span(s) torn down, ${after.length} spans unchanged`)

  await context.close()
}

// --- Rapid A -> B -> A must not strand the page in B ------------------------
// This guards the settings-drain logic: a change queued while a pass is running
// must be re-diffed against what that pass actually rendered, and applied if it
// still differs.
//
// Honesty note: this does NOT reproduce the underlying interleaving. Measured in
// Chromium, a pass holds the main thread through its JSON parse and DOM walk, so
// the second storage event is not delivered until after the pass completes; the
// window in which appliedSettings could be recorded from stale live settings is
// only a few milliseconds wide. The invariant is worth pinning anyway, and this
// test does fail if the drain logic drops the second change.
async function raceBackAndForth(base) {
  const { context, sw } = await launch('race')
  await seed(sw, ONBOARDED_ES)

  const page = await context.newPage()
  await page.goto(`${base}/article-light.html`, { waitUntil: 'domcontentloaded' })
  await spans(page).first().waitFor({ timeout: 8000 })
  const spanish = await targetsBySource(page)

  // Switch away and straight back, faster than a pack load.
  await setSetting(sw, { targetLanguage: 'de' })
  await page.waitForTimeout(60)
  await setSetting(sw, { targetLanguage: 'es' })
  await page.waitForTimeout(4000)
  const settled = await targetsBySource(page)

  const verdict = sameLanguageAs(spanish, settled)
  check('RACE', 'Fast language switch away and back leaves the page in the chosen language',
    verdict.ok,
    `${verdict.agree}/${verdict.shared} shared words still Spanish; sample=${
      Object.entries(settled).slice(0, 3).map(([s, t]) => `${s}→${t}`)}`)

  // And the tab must not be wedged: a further switch still takes effect.
  await setSetting(sw, { targetLanguage: 'fr' })
  await page.waitForTimeout(3000)
  const french = await targetsBySource(page)
  const stillSpanish = sameLanguageAs(spanish, french)
  check('RACE-recover', 'A later language switch still applies after the race',
    Object.keys(french).length > 0 && !stillSpanish.ok,
    `sample=${Object.entries(french).slice(0, 3).map(([s, t]) => `${s}→${t}`)}`)

  await context.close()
}

// --- The hover card must never translate its own definition text -------------
// Hovering rewrites the tooltip's inner spans, and that mutation used to be
// picked up by the SPA observer with the unmarked inner span as the walk root,
// splicing replacement spans into our own gloss (regression from 124cdd3).
//
// Reproducing needs three alignments: a gloss containing a word that is itself
// an APPROVED lemma on the page ("password" -> "secret login code", with "code"
// in the article and density 1), the word tagged the same POS in the gloss as
// its pack entry ("code" is the gloss's head noun), and NO re-hover before the
// assertion — rewriting textContent would wipe the injected evidence.
async function tooltipSelfReplacement(base) {
  const { context, sw } = await launch('tooltip')
  await seed(sw, { ...ONBOARDED_ES, level: 'beginner', density: 1 })

  const page = await context.newPage()
  await page.goto(`${base}/tooltip-overlap.html`, { waitUntil: 'domcontentloaded' })
  const passwordSpan = page.locator('[data-contexto="true"][data-source="password"]').first()
  await passwordSpan.waitFor({ timeout: 8000 })

  // Sanity: the overlap word really is replaced on the page, so its lemma is
  // approved and WOULD be injected into the tooltip by the old walker. Match by
  // lemma: the rendered span's data-source may have absorbed an article.
  const codeOnPage = await page.locator('article [data-contexto="true"][data-lemma="code"]').count()

  // One hover writes the gloss into the tooltip; then wait out the observer's
  // 500 ms debounce so a (buggy) flush has fired before we look.
  await passwordSpan.hover()
  await page.waitForTimeout(1400)

  const injected = await page.locator('#contexto-tooltip [data-contexto="true"]').count()
  const { gloss, shown } = await page.evaluate(() => {
    const span = document.querySelector('[data-contexto="true"][data-source="password"]')
    const tip = document.getElementById('contexto-tooltip')
    // children[1] is the gloss line (source · gloss · target · hint).
    return {
      gloss: span?.getAttribute('data-gloss') ?? '',
      shown: tip?.children[1]?.textContent ?? '',
    }
  })
  check('TOOLTIP-self', 'Hover card text is never itself translated',
    codeOnPage > 0 && injected === 0 && shown === gloss,
    `overlap word replaced ${codeOnPage}x on page; ${injected} injected span(s) inside tooltip; ` +
    `gloss shown=${JSON.stringify(shown)} expected=${JSON.stringify(gloss)}`)

  await context.close()
}

// --- A page-level lang attribute must not disable the pipeline ---------------
// The skip list's [lang]:not([lang^="en"]) rule gates nested foreign snippets.
// Checked with an unbounded closest() it would also match <html lang="und"/
// "x-default"/"de"> — routine CMS boilerplate on English pages — and silently
// disable the whole walk (found in the 2026-07-14 review of the tooltip fix).
async function mislabeledLang(base) {
  const { context, sw } = await launch('mislabeled')
  await seed(sw, ONBOARDED_ES)

  const page = await context.newPage()
  await page.goto(`${base}/mislabeled-lang.html`, { waitUntil: 'domcontentloaded' })

  let translated = true
  try { await spans(page).first().waitFor({ timeout: 8000 }) } catch { translated = false }
  const count = await spans(page).count()

  // The genuinely-French nested paragraph must still be left alone.
  const inFrench = await page.locator('[lang="fr"] [data-contexto="true"]').count()

  check('LANG-mislabel', 'Page-level non-English lang attribute does not disable replacement',
    translated && count > 0 && inFrench === 0,
    `${count} spans on <html lang="x-default"> page; ${inFrench} inside the lang="fr" block`)

  await context.close()
}

// --- The niche tail loads by default and percolates in, no toggle -----------
// The tail is no longer gated behind Aggressive Mode. After the core-only first
// paint, the content script loads the tail off the critical path and re-renders
// so its words appear. Proven with words that live ONLY in a language's tail, so
// their target text is proof the tail merged.
//
//   'photon'  is es-tail-only (fotón) — not in the es core.
//   'wildlife' is de-tail-only (Fauna) — not in the de core.
// The first proves default-on percolation; the second proves a language switch
// re-percolates the NEW language's tail (not just the first load).
async function tailPercolation(base) {
  const { context, sw, extId } = await launch('percolate')
  // density 1 so every eligible word — including the single 'wildlife' — is
  // selected, making the tail-only assertions deterministic.
  await seed(sw, { ...ONBOARDED_ES, density: 1 })

  const page = await context.newPage()
  // Count span TEARDOWNS: percolation must be additive (inject the marginal tail
  // words into unreplaced text), never a restore-and-re-render of the page the
  // user is already reading. Red with the old full-reconcile percolation.
  await page.addInitScript(() => {
    window.__removed = 0
    new MutationObserver(muts => {
      for (const m of muts) {
        for (const n of m.removedNodes) {
          if (n.nodeType === 1 && n.getAttribute?.('data-contexto') === 'true') window.__removed++
        }
      }
    }).observe(document, { childList: true, subtree: true }) // document, NOT documentElement: null at init-script time, observe() would throw and leave the counter dead
  })
  await page.goto(`${base}/percolate-tail.html`, { waitUntil: 'domcontentloaded' })
  // The core paints first (some span appears without waiting on the tail).
  await spans(page).first().waitFor({ timeout: 8000 })

  // The es-tail-only word must appear on its own, with no toggle touched.
  const photon = page.locator('[data-contexto="true"][data-lemma="photon"]').first()
  let percolated = true
  try { await photon.waitFor({ timeout: 10000 }) } catch { percolated = false }
  const photonTarget = percolated ? await photon.getAttribute('data-base-target') : ''
  check('PERCOLATE-default', 'A tail-only word appears by default shortly after load, no toggle',
    percolated && /^fot[oó]n$/i.test(photonTarget ?? ''),
    `photon -> ${JSON.stringify(photonTarget)}`)

  const tornDown = await page.evaluate(() => window.__removed)
  check('PERCOLATE-incremental', 'Percolation adds tail words without tearing down existing spans',
    tornDown === 0, `${tornDown} core span(s) removed during percolation`)

  // Switching language must reset AND re-percolate the tail for the new language.
  await clickLanguageInPopup(context, extId, 'German')
  await page.bringToFront()
  const wildlife = page.locator('[data-contexto="true"][data-lemma="wildlife"]').first()
  let deTail = true
  try { await wildlife.waitFor({ timeout: 10000 }) } catch { deTail = false }
  const wildlifeTarget = deTail ? await wildlife.getAttribute('data-base-target') : ''
  check('PERCOLATE-switch', 'A language switch re-percolates the new language tail',
    deTail && /^fauna$/i.test(wildlifeTarget ?? ''),
    `wildlife -> ${JSON.stringify(wildlifeTarget)}`)

  await context.close()
}

async function run() {
  makeTestBuild()
  const { server, base } = await serveFixtures()
  try {
    await bug1(base)
    await bug2(base)
    await bug4(base)
    await bug3(base)
    await frozenTab(base)
    await raceBackAndForth(base)
    await tooltipSelfReplacement(base)
    await mislabeledLang(base)
    await tailPercolation(base)
  } finally {
    server.close()
  }
  fs.writeFileSync(path.join(__dirname, 'repro-results.json'), JSON.stringify(report, null, 2))
  const failed = report.filter(r => !r.passed)
  console.log(`\n${report.length - failed.length}/${report.length} scenarios pass.`)
  if (failed.length) {
    console.log('FAILING: ' + failed.map(f => f.id).join(', '))
    process.exitCode = 1
  }
}

run().catch((e) => { console.error(e); process.exit(2) })
