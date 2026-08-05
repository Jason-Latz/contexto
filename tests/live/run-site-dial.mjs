/* Headless check for the landing page's scroll-driven dial (site/).
   Serves site/ itself, so it is a single self-contained pass/fail gate:
       npm run test:site-dial
   Exits 1 on any failed assertion. */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("../../site", import.meta.url));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer(async (req, res) => {
  let path = normalize(decodeURIComponent(req.url.split("?")[0]));
  if (path.endsWith("/")) path += "index.html";
  try {
    const body = await readFile(join(SITE, path));
    // No caching: the whole point is to test the file on disk right now.
    res.writeHead(200, {
      "content-type": TYPES[extname(path)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  ·  " + detail : ""}`);
}

// Two rAF ticks, so the scroll handler's throttled render has landed.
const settle = (page) =>
  page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  );

const state = (page) =>
  page.evaluate(() => {
    const st = document.getElementById("ctx-stage");
    const rg = document.getElementById("ctx-range");
    return {
      scrubbing: st.classList.contains("is-scrubbing"),
      value: Number(rg.value),
      pinTop: Math.round(document.getElementById("ctx-pin").getBoundingClientRect().top),
      onWords: document.querySelectorAll(".manifesto .w.on").length,
      cueHidden: document.getElementById("ctx-cue").classList.contains("is-hidden"),
      idle: rg.classList.contains("is-idle"),
    };
  });

// scrollY where the pin engages (progress 0), and how far it then travels.
const anchors = (page) =>
  page.evaluate(() => {
    const st = document.getElementById("ctx-stage");
    const pad = parseFloat(getComputedStyle(st).paddingTop) || 0;
    const sticky = parseFloat(st.style.getPropertyValue("--dial-top")) || 0;
    return {
      engage: st.getBoundingClientRect().top + scrollY + pad - sticky,
      scrub: document.getElementById("ctx-scrub").offsetHeight,
      sticky,
    };
  });

const to = async (page, y) => {
  await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: "instant" }), y);
  await settle(page);
  await settle(page);
};

const browser = await chromium.launch();

/* ---------------- desktop: scroll drives the dial ---------------- */
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(ORIGIN + "/", { waitUntil: "load" });
  await settle(page);

  check("desktop: pin is armed", (await state(page)).scrubbing === true);

  const a = await anchors(page);
  check("scrub distance is real", a.scrub > 200, `${a.scrub}px`);

  await to(page, a.engage);
  const p0 = await state(page);
  // The drift hands the dial to the scroll scrub on the very first pixel; that
  // handoff must not jump, whenever in the drift it happens to land.
  await to(page, a.engage + 2);
  const p0b = await state(page);
  check(
    "handoff into the scrub does not jump",
    Math.abs(p0b.value - p0.value) <= 3,
    `${p0.value}% -> ${p0b.value}%`
  );

  await to(page, a.engage + a.scrub * 0.5);
  const p50 = await state(page);
  await to(page, a.engage + a.scrub);
  const p100 = await state(page);

  check(
    "scroll raises the dial",
    p0.value < p50.value && p50.value < p100.value,
    `${p0.value}% -> ${p50.value}% -> ${p100.value}%`
  );
  check("dial reaches the top", p100.value === 100);
  check("every word flips by the top", p100.onWords === 14, `${p100.onWords}/14`);
  check(
    "card stays pinned across the scrub",
    Math.abs(p0.pinTop - a.sticky) <= 1 && Math.abs(p100.pinTop - a.sticky) <= 1,
    `top ${p0.pinTop} -> ${p100.pinTop}, sticky ${a.sticky}`
  );
  check("cue steps aside once it moves", p100.cueHidden === true);
  check("idle halo is dropped", p100.idle === false);

  await to(page, a.engage + a.scrub + 400);
  check(
    "card releases after the stage",
    (await state(page)).pinTop < a.sticky - 300
  );

  await to(page, a.engage + a.scrub * 0.25);
  const back = await state(page);
  check("scrubbing is bidirectional", back.value > 0 && back.value < 100, `${back.value}%`);

  /* ---- tabbing past the slider is not taking hold of it ----
     Checked from 25%, so a frozen dial and a scroll-driven one land far apart
     and this cannot pass by accident. */
  await page.focus("#ctx-range");
  await page.keyboard.press("Tab");
  await to(page, a.engage + a.scrub * 0.75);
  const tabbed = await state(page);
  check(
    "Tab does not steal the dial from scroll",
    tabbed.value > 65 && tabbed.value < 85,
    `${tabbed.value}%, wanted ~75 (25 would mean Tab froze it)`
  );

  /* ---- the hand still wins, and keeps winning ---- */
  await page.evaluate(() => {
    const rg = document.getElementById("ctx-range");
    rg.value = 70;
    rg.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle(page);
  check("dragging sets the dial", (await state(page)).value === 70);

  await to(page, a.engage + a.scrub);
  const held = await state(page);
  check("scroll lets go once dragged", held.value === 70, `${held.value}%, wanted 70`);

  /* ---- the demo promises nothing the extension cannot render ---- */
  const swaps = await page.evaluate(() =>
    [...document.querySelectorAll(".manifesto .w")].map((w) => [w.dataset.en, w.dataset.es])
  );
  // Verbs ship disabled by default, and the packs carry only bare infinitives,
  // so a conjugated English word must never appear as a swap here.
  const verbs = swaps.filter(([en]) =>
    ["living", "learned", "read", "understood"].includes(en)
  );
  check("no verb swaps remain", verbs.length === 0, JSON.stringify(verbs));
  check(
    "vivir / leer are gone",
    !swaps.some(([, es]) => es === "vivir" || es === "leer")
  );
  await page.close();
}

/* -------- a window shrunk mid-scrub keeps the reader's place -------- */
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(ORIGIN + "/", { waitUntil: "load" });
  await settle(page);
  const a = await anchors(page);

  await to(page, a.engage + a.scrub);
  check("scrolled to the top of the dial", (await state(page)).value === 100);

  await page.setViewportSize({ width: 1280, height: 560 });
  await settle(page);
  await settle(page);
  const shrunk = await state(page);
  check("shrunk window disarms the pin", shrunk.scrubbing === false);
  check("shrunk window holds the dial", shrunk.value === 100, `${shrunk.value}%, wanted 100`);
  check(
    "shrunk window says drag, not scroll",
    (await page.textContent("#ctx-cue-text")).trim() === "Drag the dial toward Spanish"
  );

  // Growing back re-arms the pin, but the dial is the reader's now: it must not
  // lurch, and it must never re-arm on a compressed range.
  await page.setViewportSize({ width: 1280, height: 800 });
  await settle(page);
  await to(page, a.engage + a.scrub * 0.4);
  const grown = await state(page);
  check("re-armed window does not lurch the dial", grown.value === 100, `${grown.value}%`);
  check(
    "re-armed window keeps the drag wording",
    (await page.textContent("#ctx-cue-text")).trim() === "Drag the dial toward Spanish"
  );
  await page.close();
}

/* -------- the real handoff: drift fully settled, then scroll in -------- */
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(ORIGIN + "/", { waitUntil: "load" });
  // The opening drift runs 0 -> 42% -> 22% over 6s once the card is on screen.
  await page.waitForTimeout(6600);
  const settled = await state(page);
  check("drift settles at the floor", settled.value === 22, `${settled.value}%`);

  const a = await anchors(page);
  await to(page, a.engage);
  const at0 = await state(page);
  await to(page, a.engage + 3);
  const at1 = await state(page);
  check(
    "settled drift hands over without a jump",
    at0.value === 22 && Math.abs(at1.value - 22) <= 2,
    `${settled.value}% -> ${at0.value}% -> ${at1.value}%`
  );

  await to(page, a.engage + a.scrub * 0.5);
  const half = await state(page);
  check(
    "scrub uses its whole length from the floor",
    half.value > 55 && half.value < 70,
    `halfway = ${half.value}%`
  );
  await page.close();
}

/* ---------------- short viewport: no pin, nothing clipped ---------------- */
{
  const page = await browser.newPage({ viewport: { width: 390, height: 600 } });
  await page.goto(ORIGIN + "/", { waitUntil: "load" });
  await settle(page);
  check("short viewport: pin stays off", (await state(page)).scrubbing === false);
  check(
    "short viewport: cue says drag",
    (await page.textContent("#ctx-cue-text")).trim() === "Drag the dial toward Spanish"
  );
  await page.close();
}

/* ---------------- reduced motion: no pin, dial pre-set ---------------- */
{
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  await page.goto(ORIGIN + "/", { waitUntil: "load" });
  await settle(page);
  const s = await state(page);
  check("reduced motion: pin stays off", s.scrubbing === false);
  check("reduced motion: dial pre-set", s.value === 22, `${s.value}%`);
  await page.close();
}

await browser.close();
server.close();

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
