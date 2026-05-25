import { defineConfig } from 'vite'
import { resolve } from 'path'

// Popup build.
//
// Unlike the content script and background worker (which use lib/IIFE mode),
// the popup is a regular HTML page and can use ES modules. Vite's HTML input
// mode processes popup/index.html, bundles its <script type="module"> entry,
// and outputs the result as dist/popup/index.html with inlined or referenced assets.
//
// emptyOutDir is false — the content script build already owns dist/ setup.
export default defineConfig({
  publicDir: false,

  build: {
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup/index.html'),
      },
      output: {
        // Keep all popup assets under dist/popup/ so the manifest path is satisfied.
        entryFileNames: 'popup/[name].js',
        chunkFileNames: 'popup/[name].js',
        assetFileNames: 'popup/[name].[ext]',
      },
    },
    outDir: 'dist',
    emptyOutDir: false,   // preserve content script and background worker outputs
    sourcemap: false,
    target: 'chrome120',
  },

  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
})
