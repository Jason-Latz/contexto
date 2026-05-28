import type { OnboardingLevel, TargetLanguage } from '../types/index.js'

const STORAGE_KEY = 'contexto_settings'

// Density defaults per onboarding level — user-adjustable in Phase 4 popup.
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
  quizzesEnabled: boolean
  blockedDomains: string[]
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
    quizzesEnabled: false,
    blockedDomains: [],
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
      quizzesEnabled: raw.quizzesEnabled ?? false,
      blockedDomains: raw.blockedDomains ?? [],
      domainDecisions: raw.domainDecisions ?? {},
    }
  }
}

// Persist current in-memory settings to chrome.storage.local.
// Called after any mutation (onboarding completion, domain decision).
async function saveSettings(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings })
}

export function isOnboarded(): boolean {
  return settings.onboarded
}

// Mark onboarding complete for the given level.
// Sets density to the level default and persists immediately.
export async function completeOnboarding(level: OnboardingLevel): Promise<void> {
  settings.onboarded = true
  settings.level = level
  settings.density = LEVEL_DENSITY[level]
  await saveSettings()
}

export function getDensity(): number {
  return settings.density
}

export function areReplacementsEnabled(): boolean {
  return settings.replacementsEnabled
}

export function areQuizzesEnabled(): boolean {
  return settings.quizzesEnabled
}

// Update the stored density and persist immediately.
// Called by QuizBanner (post-quiz adjustment) and the popup DensitySlider
// (manual override). Value is expected to already be clamped by the caller.
export async function setDensity(density: number): Promise<void> {
  settings.density = density
  await saveSettings()
}

// Return the configured density for a specific level, regardless of current state.
// Used by LevelPicker to show a preview before the user confirms.
export function getLevelDensity(level: OnboardingLevel): number {
  return LEVEL_DENSITY[level]
}

export function getTargetLanguage(): TargetLanguage {
  return settings.targetLanguage
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
  if (!settings.blockedDomains.includes(clean)) {
    settings.blockedDomains = [...settings.blockedDomains, clean].sort()
    await saveSettings()
  }
}

export async function removeBlockedDomain(hostname: string): Promise<void> {
  settings.blockedDomains = settings.blockedDomains.filter(domain => domain !== hostname)
  await saveSettings()
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
  settings.domainDecisions[hostname] = allowed
  await saveSettings()
}
