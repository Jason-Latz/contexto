// Proficiency model — governs the density of word replacements on the page.
//
// Density is only ever moved by an explicit user action (the popup slider);
// page render reads the stored value unchanged. The former post-quiz density
// auto-adjustment left with the auto-popping quiz banner.

import { getDensity } from '../store/settingsStore.js'

// Density to use for the current page: the user's stored value, unchanged.
export function computeDensity(): number {
  return getDensity()
}
