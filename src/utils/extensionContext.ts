const EXTENSION_CONTEXT_INVALIDATED = 'Extension context invalidated'

export function isExtensionContextAvailable(): boolean {
  try {
    return (
      typeof chrome !== 'undefined' &&
      Boolean(chrome.runtime?.id) &&
      chrome.runtime.id !== 'invalid'
    )
  } catch {
    return false
  }
}

export function isExtensionContextInvalidatedError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : ''

  return message.includes(EXTENSION_CONTEXT_INVALIDATED)
}

export function assertExtensionContextAvailable(): void {
  if (!isExtensionContextAvailable()) {
    throw new Error('[Contexto] Extension context invalidated; refresh the page to restore it')
  }
}
