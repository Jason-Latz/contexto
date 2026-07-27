---
name: "source-command-gates"
description: "Run the Contexto verification gates in order (typecheck, test, build). Read/build-only; never push or deploy."
---

# source-command-gates

Use this skill when the user asks to run the migrated source command `gates`.

## Command Template

Run the project's verification gates in this exact order. Stop at the first failure and report it.

```bash
# 1. Type-check the whole project (tsc --noEmit).
npm run typecheck

# 2. Unit + pipeline tests.
#    Prerequisite: python3 must be on PATH — `npm test` ends with
#    `python3 -m unittest discover pipeline/import_es/tests`.
#    The pipeline tests use only the Python standard library (no pip install needed).
npm test

# 3. Production build of the extension (vite build + popup config).
npm run build
```

Notes:
- There is no `lint` script in package.json, so no lint gate is run here.
- An optional Playwright live harness exists at `tests/live/run-live.mjs` but is NOT
  wired into any npm script, so it is intentionally omitted from the gates. To run it
  manually you would first need `npm run build`, then `npx playwright install chromium`,
  then `node tests/live/run-live.mjs` (launches headed Chromium with the built MV3 extension).
- Build/test only — never push or deploy from this command.
