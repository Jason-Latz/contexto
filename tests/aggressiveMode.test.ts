import assert from 'node:assert/strict'
import test from 'node:test'

// In-memory chrome.storage.local so the settings store's merge-on-latest-read
// persistence path can be exercised without a browser.
const store: Record<string, unknown> = {}
globalThis.chrome = {
  storage: {
    local: {
      async get(key: string) {
        return { [key]: store[key] }
      },
      async set(obj: Record<string, unknown>) {
        Object.assign(store, obj)
      },
    },
  },
} as any

const SETTINGS_KEY = 'contexto_settings'
const {
  loadSettings,
  isAggressiveMode,
  setAggressiveMode,
} = await import('../src/store/settingsStore.js')

test('aggressive mode defaults to off', async () => {
  delete store[SETTINGS_KEY]
  await loadSettings()
  assert.equal(isAggressiveMode(), false)
})

test('setAggressiveMode persists across a reload', async () => {
  delete store[SETTINGS_KEY]
  await loadSettings()
  await setAggressiveMode(true)
  assert.equal(isAggressiveMode(), true)

  // A fresh load reads it back from storage — it was actually persisted.
  await loadSettings()
  assert.equal(isAggressiveMode(), true)
})

test('setAggressiveMode is merge-safe — it does not clobber other fields', async () => {
  // Simulate the popup having just written an unrelated field to storage.
  store[SETTINGS_KEY] = { quizzesEnabled: true, density: 0.42, aggressiveMode: false }
  await setAggressiveMode(true)

  const persisted = store[SETTINGS_KEY] as Record<string, unknown>
  assert.equal(persisted.aggressiveMode, true)
  assert.equal(persisted.quizzesEnabled, true, 'quizzesEnabled must survive the aggressive-mode write')
  assert.equal(persisted.density, 0.42, 'density must survive the aggressive-mode write')
})
