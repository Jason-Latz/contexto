# Third-Party Notices

Contexto's own source code is licensed under the MIT License (see `LICENSE`).
The distributed extension also bundles a third-party library and language-pack
data that carry their own attribution and, in one case, share-alike obligations.
This file accompanies the released build (`dist/THIRD_PARTY_NOTICES.md`).

## Bundled Software

### compromise

- Project: https://github.com/spencermountain/compromise
- Version: 14.x (bundled into `content/index.js`)
- Used for: English part-of-speech tagging and lemmatisation at runtime.
- License: MIT

```
The MIT License (MIT)

Copyright (c) 2019 Spencer Kelly

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Bundled Language-Pack Data

The shipped Spanish pack (`language-packs/es.json`) is a derivative work that
incorporates entries from FreeDict. Because FreeDict is licensed under
CC-BY-SA 3.0, the affected pack data is distributed under **CC-BY-SA 3.0** with
attribution below. Other sources are used only for optional enrichment or
corroboration.

## FreeDict English-Spanish

- Source ID: `freedict-eng-spa-2025.11.23`
- Source: https://download.freedict.org/dictionaries/eng-spa/2025.11.23/freedict-eng-spa-2025.11.23.src.tar.xz
- Project: https://freedict.org/
- Format: TEI P5 XML
- License: Creative Commons Attribution-ShareAlike 3.0 Unported
- Upstream notes: FreeDict English-Spanish is generated from WikDict data based
  on Wiktionary/DBnary.

## Kaikki / Wiktionary

- Source IDs: `kaikki-en`, `kaikki-es`
- Source: https://kaikki.org/dictionary/rawdata.html
- License: Wiktionary licenses, including CC-BY-SA and GFDL
- Usage: Optional enrichment for glosses, Spanish gender, and plural forms.

## Open Multilingual Wordnet

- Source ID: `omw`
- Source: https://omwn.org/
- License: Mixed open licenses by component wordnet
- Usage: Optional corroboration for translation confidence.

## Apertium English-Spanish

- Source ID: `apertium-eng-spa`
- Source: https://github.com/apertium/apertium-eng-spa
- License: GPL-2.0
- Usage: Optional corroboration for translation confidence.

Generated source details and checksums are recorded in
`pipeline/sources/es.lock.json` after running the import pipeline.
