# Contexto Privacy Policy

_Last updated: June 14, 2026_

Contexto runs entirely on your device, in Chrome, using a bundled Spanish
language pack. It has a single purpose: to replace eligible English words on
the pages you read with their Spanish equivalents and help you review the words
you save.

## Data Collected

Contexto stores its state in `chrome.storage.local` on your own device,
including:

- selected replacement density
- saved unknown-word and review state
- blocked-domain settings
- recent session words for local quiz behavior

This data never leaves your device.

## Data We Do Not Collect or Sell

Contexto does not collect personal information, browsing history, or page
content on any server. **We do not sell, rent, or transfer your data to third
parties, and we do not use it for any purpose unrelated to the single purpose
above.**

## Network Use

Contexto makes no runtime network calls. It does not send page text, browsing
history, or translation requests to any server, and it uses no hosted backend
or translation API. Unknown-word exports (CSV / Quizlet TSV) are generated
locally from data already stored on your device.

## Page Access

Contexto's content script runs on the pages you visit so it can read page text
and replace eligible English words in context — this is the only reason it
needs broad page access, and the text is processed locally and never
transmitted. Contexto skips form controls, code blocks, editable content, its
own UI, non-English content, and any domains you block.

## Contact

Made by Jason Latz — https://jasonlatz.com. For support or questions, open an
issue at https://github.com/Jason-Latz/contexto/issues.
