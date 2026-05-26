/**
 * Scaffold for future API-backed language-pack generation.
 *
 * V1 intentionally ships local language packs only. This script exists so the
 * later backend/API workflow has a stable place to land without putting API keys
 * or runtime translation calls into the Chrome extension.
 */

const enabled = process.env.CONTEXTO_TRANSLATION_API_ENABLED === '1'

if (!enabled) {
  console.log('Contexto pack generation is disabled by default.')
  console.log('Set CONTEXTO_TRANSLATION_API_ENABLED=1 when a backend/API workflow exists.')
  process.exit(0)
}

throw new Error('API-backed pack generation is not implemented for v1.')
