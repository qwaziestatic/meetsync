import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Build tooling decision: MANUAL multi-entry config, not @crxjs/vite-plugin.
 *
 * Why not crxjs:
 *  - crxjs rewrites the manifest and injects an HMR client/loader shim into
 *    every entry. When it breaks (it went through a long unmaintained-beta
 *    stretch across Vite major bumps), it breaks inside that magic layer,
 *    which is exactly where an MV3 bug is hardest to debug.
 *  - Our surface is small and stable: one service worker, one side panel
 *    page, one tiny content script. Manual config gives deterministic output
 *    filenames, which the manifest references literally.
 *
 * Trade-off we accept: no true HMR. `npm run dev` runs `vite build --watch`;
 * reload the extension (or just the panel) to see changes.
 *
 * TWO BUILD PASSES (chained by the npm scripts):
 *
 *  1. `vite build` (default)         -> worker + side panel, ES modules.
 *  2. `vite build --mode content`    -> content script, single IIFE.
 *
 * The content script CANNOT share the main Rollup graph: MV3 content scripts
 * are classic scripts (no ES modules), so they must be emitted as an IIFE,
 * and Rollup refuses to code-split IIFE output. Sharing one graph with the
 * module worker would let Rollup hoist src/shared/* into a chunk the IIFE
 * can't import. Two graphs means shared modules are simply inlined into the
 * content bundle — correct, at the cost of a few duplicated bytes.
 */
export default defineConfig(({ mode }) => {
  // ---- Pass 2: content script (classic-script world) ----------------------
  if (mode === 'content') {
    return {
      build: {
        outDir: 'dist',
        // Never wipe the main pass's output — this pass only ADDS files.
        emptyOutDir: false,
        target: 'chrome116',
        sourcemap: true,
        rollupOptions: {
          input: { calendar: 'src/content/calendar.js' },
          output: {
            // Single self-contained classic script at the exact path the
            // manifest's content_scripts entry references.
            format: 'iife',
            entryFileNames: 'content/calendar.js',
          },
        },
      },
    };
  }

  // ---- Pass 1: service worker + side panel (ES-module world) --------------
  return {
    plugins: [react()],

    // Relative base so the built HTML references ./assets/... — robust under
    // the chrome-extension:// origin regardless of how the page is opened.
    base: './',

    build: {
      outDir: 'dist',
      // Production builds start clean. Dev watch must NOT empty: the content
      // pass ran first (see npm scripts) and its output lives in the same
      // dist/, so emptying here would silently delete dist/content/.
      emptyOutDir: mode === 'production',

      // Chrome-only target, pinned to the manifest's minimum_chrome_version.
      target: 'chrome116',

      // Handy while developing; strip for the Web Store upload (smaller zip).
      sourcemap: true,

      rollupOptions: {
        // Two entries, one graph:
        //  - sidepanel: normal Vite HTML entry -> dist/sidepanel.html + assets
        //  - background: plain JS entry -> dist/background.js
        input: {
          sidepanel: 'sidepanel.html',
          background: 'src/background/index.js',
        },
        output: {
          // The service worker MUST land at a stable, unhashed path because
          // manifest.json references it by literal filename. The panel's JS
          // can hash freely — its HTML is rewritten by Vite to match.
          entryFileNames: (chunk) =>
            chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/chunk-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },

    // Why code-splitting can't break the worker in THIS pass: the manifest
    // declares `"background": { "type": "module" }`, so the worker is an
    // ES-module service worker and a static `import` of a shared chunk (e.g.
    // src/shared/messages.js, used by both worker and panel) is legal. Rollup
    // only ever emits static imports for shared chunks in the worker entry —
    // never dynamic import() — so no output shape here is unloadable.
    // (public/ is copied verbatim into dist/, which is how manifest.json
    // ships.)
  };
});
