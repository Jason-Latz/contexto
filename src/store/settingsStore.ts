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
  // Aggressive mode: also inject the quarantined niche "tail" vocabulary
  // (public/language-packs/<lang>.tail.json). Off by default — the tail is
  // low-confidence long-tail words, so opting in trades precision for coverage.
  aggressiveMode: boolean
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
    aggressiveMode: false,
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
      aggressiveMode: raw.aggressiveMode ?? false,
      blockedDomains: raw.blockedDomains ?? [],
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

// Mark onboarding complete for the given level.
// Sets density to the level default and persists immediately.
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

// The learner's onboarding level, or null before onboarding. Drives the
// skip-what-you-know frequency floor in candidate selection.
export function getLevel(): OnboardingLevel | null {
  return settings.level
}

export function areReplacementsEnabled(): boolean {
  return settings.replacementsEnabled
}

export function areQuizzesEnabled(): boolean {
  return settings.quizzesEnabled
}

export function isAggressiveMode(): boolean {
  return settings.aggressiveMode
}

// Toggle aggressive mode (inject the quarantined niche tail) and persist.
export async function setAggressiveMode(enabled: boolean): Promise<void> {
  await persistSettings({ aggressiveMode: enabled })
}

// Update the stored density and persist immediately.
// Called by QuizBanner (post-quiz adjustment) and the popup DensitySlider
// (manual override). Value is expected to already be clamped by the caller.
export async function setDensity(density: number): Promise<void> {
  await persistSettings({ density })
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
