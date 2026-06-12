// Minimum and maximum density values the user can set via the slider.
// These match the proficiency model's clamping range.
const MIN_DENSITY = 0.00  // 0%
const MAX_DENSITY = 1.00  // 100%
const STORAGE_WRITE_THROTTLE_MS = 150
const DENSITY_TOOLTIP =
  'Not every word can be replaced: some words change meaning in context, and the current language-pack dictionary is intentionally limited.'

// Density is stored as a 0–1 fraction; display as percentage (e.g. 0.20 → "20%").
function toPercent(density: number): string {
  return `${Math.round(density * 100)}%`
}

interface PopupSettings {
  density?: number
  [key: string]: unknown
}

/**
 * Render the density slider section into `container`.
 *
 * Reading and writing density goes directly through chrome.storage.local so the
 * popup remains decoupled from the content script's settingsStore module.
 */
export async function renderDensitySlider(container: HTMLElement): Promise<void> {
  const SETTINGS_KEY = 'contexto_settings'

  const stored = await chrome.storage.local.get(SETTINGS_KEY)
  const settings = (stored[SETTINGS_KEY] ?? {}) as PopupSettings
  const currentDensity: number = typeof settings.density === 'number'
    ? settings.density
    : 0.20
  let lastPersistedDensity = currentDensity
  let queuedDensity = currentDensity
  let lastWriteAt = 0
  let throttleTimer: ReturnType<typeof setTimeout> | null = null
  let writeChain: Promise<void> = Promise.resolve()

  async function persistDensity(density: number): Promise<void> {
    if (density === lastPersistedDensity) return

    lastPersistedDensity = density
    lastWriteAt = Date.now()
    writeChain = writeChain
      .catch(() => undefined)
      .then(async () => {
        const latest = await chrome.storage.local.get(SETTINGS_KEY)
        const latestSettings = (latest[SETTINGS_KEY] ?? {}) as PopupSettings
        await chrome.storage.local.set({
          [SETTINGS_KEY]: { ...latestSettings, density },
        })
      })
    await writeChain
  }

  function flushQueuedDensity(): void {
    if (throttleTimer !== null) {
      clearTimeout(throttleTimer)
      throttleTimer = null
    }
    void persistDensity(queuedDensity)
  }

  function requestDensityWrite(density: number): void {
    queuedDensity = density

    const elapsed = Date.now() - lastWriteAt
    if (elapsed >= STORAGE_WRITE_THROTTLE_MS) {
      flushQueuedDensity()
      return
    }

    if (throttleTimer === null) {
      throttleTimer = setTimeout(() => {
        throttleTimer = null
        void persistDensity(queuedDensity)
      }, STORAGE_WRITE_THROTTLE_MS - elapsed)
    }
  }

  const section = document.createElement('div')
  section.className = 'section'

  const title = document.createElement('div')
  title.className = 'section-title section-title-with-info'

  const titleText = document.createElement('span')
  titleText.textContent = 'Eligible Word Density'

  const infoIcon = document.createElement('button')
  infoIcon.type = 'button'
  infoIcon.className = 'info-icon'
  infoIcon.setAttribute('aria-label', 'Why every word may not be replaced')
  infoIcon.setAttribute('aria-describedby', 'density-tooltip')
  infoIcon.textContent = 'i'

  const tooltip = document.createElement('span')
  tooltip.id = 'density-tooltip'
  tooltip.className = 'info-tooltip'
  tooltip.setAttribute('role', 'tooltip')
  tooltip.textContent = DENSITY_TOOLTIP

  infoIcon.appendChild(tooltip)
  title.appendChild(titleText)
  title.appendChild(infoIcon)
  section.appendChild(title)

  const sliderRow = document.createElement('div')
  sliderRow.className = 'slider-row'

  const slider = document.createElement('input')
  slider.type = 'range'
  slider.min = String(Math.round(MIN_DENSITY * 100))
  slider.max = String(Math.round(MAX_DENSITY * 100))
  slider.step = '1'
  slider.value = String(Math.round(currentDensity * 100))

  const label = document.createElement('span')
  label.className = 'slider-label'
  label.textContent = toPercent(currentDensity)

  slider.addEventListener('input', () => {
    label.textContent = `${slider.value}%`
    requestDensityWrite(parseInt(slider.value, 10) / 100)
  })

  // Ensure the final slider position is persisted immediately on release/commit.
  slider.addEventListener('change', flushQueuedDensity)

  sliderRow.appendChild(slider)
  sliderRow.appendChild(label)
  section.appendChild(sliderRow)

  container.appendChild(section)
}
