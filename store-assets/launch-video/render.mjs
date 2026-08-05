// Render the Contexto launch demo to frames + mp4 via Playwright's deterministic seek.
//   node render.mjs                      full render -> contexto-launch.mp4
//   node render.mjs --stills 0.6,2.4,4,6.5,9.5,11,14.5,18   contact sheet only
//   node render.mjs --fps 30 --dur 20 --dsf 2 --out foo.mp4
import { chromium } from 'playwright';
import ffmpegPath from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FFMPEG = ffmpegPath;
const W = 1920, H = 1080;

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const FPS = +arg('fps', 30), DUR = +arg('dur', 20), DSF = +arg('dsf', 1);
const OUT = arg('out', 'contexto-launch.mp4');
const STILLS = arg('stills', null);
const pad = (n, w = 4) => String(n).padStart(w, '0');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DSF });
await page.addInitScript(() => { window.__RENDER = true; });
await page.goto('file://' + join(HERE, 'demo.html'));
await page.evaluate(() => window.__ready);
await page.waitForTimeout(120);

async function shoot(t, path) {
  await page.evaluate((tt) => window.__seek(tt), t);
  await page.screenshot({ path, clip: { x: 0, y: 0, width: W, height: H } });
}

if (STILLS) {
  const dir = join(HERE, 'stills');
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const ts = STILLS.split(',').map(Number);
  const files = [];
  for (const t of ts) { const f = join(dir, `still-${t}.png`); await shoot(t, f); files.push(f); console.log('still', t); }
  const cols = Math.min(4, ts.length);
  const rows = Math.ceil(ts.length / cols);
  spawnSync(FFMPEG, ['-y', ...files.flatMap(f => ['-i', f]),
    '-filter_complex', `${ts.map((_, i) => `[${i}:v]scale=640:-1[s${i}]`).join(';')};${ts.map((_, i) => `[s${i}]`).join('')}xstack=inputs=${ts.length}:layout=${gridLayout(cols, rows, 640, 360)}[o]`,
    '-map', '[o]', join(dir, 'contact-sheet.png')], { stdio: 'inherit' });
  console.log('contact sheet ->', join(dir, 'contact-sheet.png'));
  await browser.close();
  process.exit(0);
}

function gridLayout(cols, rows, cw, ch) {
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = c === 0 ? '0' : Array.from({ length: c }, () => 'w0').join('+');
    const y = r === 0 ? '0' : Array.from({ length: r }, () => 'h0').join('+');
    cells.push(`${x}_${y}`);
  }
  return cells.join('|');
}

// full render
const framesDir = join(HERE, 'frames');
rmSync(framesDir, { recursive: true, force: true }); mkdirSync(framesDir, { recursive: true });
const total = Math.round(DUR * FPS);
const t0 = Date.now();
for (let f = 0; f < total; f++) {
  await shoot(f / FPS, join(framesDir, `f-${pad(f)}.png`));
  if (f % 30 === 0) process.stdout.write(`\rframe ${f}/${total}  ${(((Date.now()-t0)/1000)).toFixed(0)}s`);
}
process.stdout.write(`\rrendered ${total} frames                       \n`);
await browser.close();

const outPath = join(HERE, OUT);
const r = spawnSync(FFMPEG, ['-y', '-framerate', String(FPS), '-i', join(framesDir, 'f-%04d.png'),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '17', '-preset', 'slow',
  '-vf', DSF > 1 ? `scale=${W}:${H}:flags=lanczos` : 'null,format=yuv420p',
  '-movflags', '+faststart', outPath], { stdio: 'inherit' });
console.log(r.status === 0 ? `\n✓ ${outPath}` : `\nffmpeg failed (${r.status})`);
process.exit(r.status || 0);
