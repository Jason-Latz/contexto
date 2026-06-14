import { defineConfig } from 'vite'
import { resolve } from 'path'
import { copyFileSync, cpSync } from 'fs'

// Plugin: after the content script build, copy manifest.json and the entire
// public/ directory into dist/. This is the first build to run (emptyOutDir: true),
// so it owns the dist/ setup step.
//
// @crxjs/vite-plugin is not used — it conflicts with Vite 8 — so manifest and
// static assets are handled manually here.
//
// lib mode does not auto-copy publicDir, so we use cpSync explicitly.
const copyStaticAssetsPlugin = () => ({
  name: 'copy-static-assets',
  closeBundle() {
    copyFileSync(
      resolve(__dirname, 'manifest.json'),
      resolve(__dirname, 'dist/manifest.json'),
    )
    cpSync(
      resolve(__dirname, 'public'),
      resolve(__dirname, 'dist'),
      { recursive: true },
    )
    // Ship the license + third-party notices inside the loaded extension and the
    // release zip (built from dist/). compromise.js is MIT and the bundled
    // Spanish pack derives from FreeDict (CC-BY-SA 3.0); both require their
    // notices to accompany the distributed copy.
    copyFileSync(
      resolve(__dirname, 'LICENSE'),
      resolve(__dirname, 'dist/LICENSE'),
    )
    copyFileSync(
      resolve(__dirname, 'THIRD_PARTY_NOTICES.md'),
      resolve(__dirname, 'dist/THIRD_PARTY_NOTICES.md'),
    )
  },
})

// Content script build.
//
// IIFE format is required for Chrome content scripts — they are injected as
// plain scripts and cannot contain ES module import/export syntax.
//
// Using build.lib with a single entry avoids the Rollup restriction that
// forbids multiple inputs when code splitting is off (which IIFE forces).
// The popup is built separately in vite.popup.config.ts.
export default defineConfig({
  plugins: [copyStaticAssetsPlugin()],
  publicDir: false,  // handled by copyStaticAssetsPlugin above

  build: {
    lib: {
      entry: resolve(__dirname, 'src/content/index.ts'),
      formats: ['iife'],
      name: '_contexto',  // IIFE wrapper name — never assigned by the caller
    },
    rollupOptions: {
      output: {
        // Override the default lib naming scheme (which appends the format) so
        // the output matches the path declared in manifest.json.
        entryFileNames: 'content/index.js',
      },
    },
    outDir: 'dist',
    emptyOutDir: true,   // wipe dist/ before the content script build
    sourcemap: false,
    target: 'chrome120',
  },

  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
})
