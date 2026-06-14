// Replaced-word span styling.
//
// The marker has to read on ANY host page. Low-alpha slate/tan washes tuned for
// white backgrounds disappear on dark sites, so we sample the page background
// once and pick a light- or dark-page variant. Differentiation between states is
// carried by colour + underline weight (slate 1px = system replacement,
// warm tan 2px = a word you saved), which survives both themes.

interface SpanTheme {
  baseLine: string
  baseFill: string
  baseHover: string
  unknownLine: string
  unknownFill: string
  unknownHover: string
}

const LIGHT_THEME: SpanTheme = {
  baseLine: 'rgba(47, 93, 128, 0.55)',
  baseFill: 'rgba(47, 93, 128, 0.07)',
  baseHover: 'rgba(47, 93, 128, 0.14)',
  unknownLine: 'rgba(132, 86, 22, 0.82)',
  unknownFill: 'rgba(132, 86, 22, 0.13)',
  unknownHover: 'rgba(132, 86, 22, 0.20)',
}

const DARK_THEME: SpanTheme = {
  baseLine: 'rgba(125, 170, 205, 0.75)',
  baseFill: 'rgba(125, 170, 205, 0.16)',
  baseHover: 'rgba(125, 170, 205, 0.24)',
  unknownLine: 'rgba(216, 180, 131, 0.85)',
  unknownFill: 'rgba(216, 180, 131, 0.20)',
  unknownHover: 'rgba(216, 180, 131, 0.28)',
}

let cachedIsDark: boolean | null = null

function parseColor(color: string): [number, number, number, number] | null {
  const match = color.match(/rgba?\(([^)]+)\)/)
  if (!match) return null
  const parts = match[1].split(',').map(s => parseFloat(s.trim()))
  if (parts.length < 3 || parts.some(Number.isNaN)) return null
  return [parts[0], parts[1], parts[2], parts.length >= 4 ? parts[3] : 1]
}

function relativeLuminance(r: number, g: number, b: number): number {
  // Rec. 601 luma is sufficient for a light/dark decision and avoids the cost of
  // full sRGB linearisation on every page load.
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

function detectDarkBackground(): boolean {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') {
    return false
  }
  // Use the first element with an opaque background, walking body → html.
  for (const el of [document.body, document.documentElement]) {
    if (!el) continue
    const parsed = parseColor(getComputedStyle(el).backgroundColor)
    if (parsed && parsed[3] > 0.2) {
      return relativeLuminance(parsed[0], parsed[1], parsed[2]) < 0.5
    }
  }
  return false
}

function theme(): SpanTheme {
  if (cachedIsDark === null) cachedIsDark = detectDarkBackground()
  return cachedIsDark ? DARK_THEME : LIGHT_THEME
}

// Re-sample the page background (e.g. a site that toggles dark mode after load).
export function resetSpanThemeCache(): void {
  cachedIsDark = null
}

const COMMON = 'border-radius: 2px; cursor: pointer; color: inherit; ' +
  'font-style: inherit; transition: background-color 0.12s ease'

export function baseSpanStyle(): string {
  const t = theme()
  return `border-bottom: 1px solid ${t.baseLine}; background: ${t.baseFill}; ${COMMON}`
}

export function unknownSpanStyle(): string {
  const t = theme()
  return `border-bottom: 2px solid ${t.unknownLine}; background: ${t.unknownFill}; ${COMMON}`
}

export function spanHoverFill(unknown: boolean): string {
  const t = theme()
  return unknown ? t.unknownHover : t.baseHover
}
