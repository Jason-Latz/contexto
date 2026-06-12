# Contexto Privacy Policy Draft

Contexto runs locally in Chrome and uses a bundled Spanish language pack.

## Data Collected

Contexto stores extension state in `chrome.storage.local`, including:

- selected replacement density
- saved unknown-word and review state
- blocked-domain settings
- recent session words for local quiz behavior

This data stays on the user's device.

## Network Use

Contexto v1 does not send page text, browsing history, or translation requests to a server. The extension does not use a hosted backend or runtime translation API.

Unknown-word exports are generated locally from data already stored on the user's device.

## Page Access

Contexto needs access to page text so it can replace eligible English words with Spanish translations. Contexto skips form controls, code blocks, editable content, its own UI, and user-blocked domains.

## Third Parties

Contexto v1 does not share user data with third parties.

## Contact

For support, open an issue at https://github.com/Jason-Latz/contexto/issues.
