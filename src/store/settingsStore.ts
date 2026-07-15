import type { OnboardingLevel, PartOfSpeech, TargetLanguage } from '../types/index.js'

const STORAGE_KEY = 'contexto_settings'

// Verbs render as the bare dictionary infinitive (no conjugation yet), which
// reads wrong in most sentence slots, so they are the one part of speech
// disabled out of the box. The popup's Word Types card opts back in.
export const DEFAULT_DISABLED_PARTS_OF_SPEECH: readonly PartOfSpeech[] = ['verb']

// Density defaults per level; user-adjustable via the popup slider.
const LEVEL_DENSITY: Record<OnboardingLevel, number> = {
  beginner:     0.05,
  intermediate: 0.15,
  advanced:     0.30,
}

interface Settings {
  onboarded: boolean
  level: OnboardingLevel | null
  targetLanguage: TargetLanguage
  density: number
  replacementsEnabled: boolean
  blockedDomains: string[]
  // Parts of speech the user has switched off in the popup's Word Types card.
  // Entries whose partOfSpeech is listed here are never candidates.
  disabledPartsOfSpeech: PartOfSpeech[]
  // Per-hostname decisions made on the high-stakes banner.
  // true = user allowed replacements; false = user paused for that domain.
  domainDecisions: Record<string, boolean>
}

// In-memory settings, populated once at startup from chrome.storage.local.
let settings: Settings = makeDefaultSettings()

function makeDefaultSettings(): Settings {
  return {
    onboarded: false,
    level: null,
    targetLanguage: 'es',
    density: LEVEL_DENSITY.beginner,
    replacementsEnabled: true,
    blockedDomains: [],
    disabledPartsOfSpeech: [...DEFAULT_DISABLED_PARTS_OF_SPEECH],
    domainDecisions: {},
  }
}

// Load persisted settings from chrome.storage.local into memory.
// Safe to call multiple times — subsequent calls overwrite in-memory state.
export async function loadSettings(): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  const raw = result[STORAGE_KEY] as Settings | undefined
  if (raw) {
    settings = {
      ...makeDefaultSettings(),
      ...raw,
      targetLanguage: raw.targetLanguage ?? 'es',
      replacementsEnabled: raw.replacementsEnabled ?? true,
      blockedDomains: raw.blockedDomains ?? [],
      disabledPartsOfSpeech: raw.disabledPartsOfSpeech ?? [...DEFAULT_DISABLED_PARTS_OF_SPEECH],
      domainDecisions: raw.domainDecisions ?? {},
    }
  }
}

// Read the latest persisted settings without disturbing in-memory state.
async function readStoredSettings(): Promise<Partial<Settings>> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  return (result[STORAGE_KEY] ?? {}) as Partial<Settings>
}

// Persist a partial patch by merging it onto the LATEST stored settings rather
// than our (possibly stale) in-memory copy. The content script and the popup
// both write contexto_settings; writing the whole in-memory object would clobber
// fields the popup changed since this tab last loaded (last-writer-wins race).
async function persistSettings(patch: Partial<Settings>): Promise<void> {
  const stored = await readStoredSettings()
  const merged: Settings = { ...makeDefaultSettings(), ...stored, ...patch }
  settings = merged
  await chrome.storage.local.set({ [STORAGE_KEY]: merged })
}

export function isOnboarded(): boolean {
  return settings.onboarded
}

// Mark first-run initialization complete for the given level.
// Sets density to the level default and persists immediately. Called by the
// silent first-run init (ensureFirstRunInit) with the default level.
export async function completeOnboarding(level: OnboardingLevel): Promise<void> {
  await persistSettings({
    onboarded: true,
    level,
    density: LEVEL_DENSITY[level],
  })
}

export function getDensity(): number {
  return settings.density
}

// The learner's level, or null before first-run init completes. Drives the
// skip-what-you-know frequency floor in candidate selection.
export function getLevel(): OnboardingLevel | null {
  return settings.level
}

export function areReplacementsEnabled(): boolean {
  return settings.replacementsEnabled
}

// Update the stored density and persist immediately.
// Called by the popup DensitySlider (manual override). Value is expected to
// already be clamped by the caller.
export async function setDensity(density: number): Promise<void> {
  await persistSettings({ density })
}

export function getTargetLanguage(): TargetLanguage {
  return settings.targetLanguage
}

export function getDisabledPartsOfSpeech(): readonly PartOfSpeech[] {
  return settings.disabledPartsOfSpeech
}

export function getBlockedDomains(): readonly string[] {
  return settings.blockedDomains
}

export function isDomainBlocked(hostname: string): boolean {
  return settings.blockedDomains.some(domain =>
    hostname === domain || hostname.endsWith(`.${domain}`),
  )
}

export async function addBlockedDomain(hostname: string): Promise<void> {
  const clean = hostname.trim().toLowerCase().replace(/^www\./, '')
  if (!clean) return
  const current = (await readStoredSettings()).blockedDomains ?? settings.blockedDomains
  if (current.includes(clean)) return
  await persistSettings({ blockedDomains: [...current, clean].sort() })
}

export async function removeBlockedDomain(hostname: string): Promise<void> {
  const current = (await readStoredSettings()).blockedDomains ?? settings.blockedDomains
  await persistSettings({ blockedDomains: current.filter(domain => domain !== hostname) })
}

// Return the stored high-stakes banner decision for a hostname, or null if
// the user has never been shown the banner for this domain.
export function getDomainDecision(hostname: string): boolean | null {
  const value = settings.domainDecisions[hostname]
  return value === undefined ? null : value
}

// Persist the user's choice from the high-stakes banner.
// allowed=true: replacements enabled for this domain.
// allowed=false: replacements paused for this domain.
export async function setDomainDecision(hostname: string, allowed: boolean): Promise<void> {
  const storedDecisions = (await readStoredSettings()).domainDecisions ?? {}
  await persistSettings({
    domainDecisions: { ...storedDecisions, [hostname]: allowed },
  })
}
