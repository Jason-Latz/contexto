// Minimum and maximum density values the user can set via the slider.
// These match the proficiency model's clamping range.
const MIN_DENSITY = 0.01  // 1%
const MAX_DENSITY = 1.00  // 100%

// Density is stored as a 0–1 fraction; display as percentage (e.g. 0.20 → "20%").
function toPercent(density: number): string {
  return `${Math.round(density * 100)}%`
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
  const settings = stored[SETTINGS_KEY] ?? {}
  const currentDensity: number = typeof settings.density === 'number'
    ? settings.density
    : 0.20

  const section = document.createElement('div')
  section.className = 'section'

  const title = document.createElement('div')
  title.className = 'section-title'
  title.textContent = 'Eligible Word Density'
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
  })

  // Write the new density on mouseup/touchend so we don't hammer storage on
  // every pixel of slider drag.
  slider.addEventListener('change', () => {
    const newDensity = parseInt(slider.value, 10) / 100
    void chrome.storage.local.set({
      [SETTINGS_KEY]: { ...settings, density: newDensity },
    })
  })

  sliderRow.appendChild(slider)
  sliderRow.appendChild(label)
  section.appendChild(sliderRow)

  container.appendChild(section)
}
