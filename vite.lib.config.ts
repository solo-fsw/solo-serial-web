/**
 * vite.lib.config.ts — Vite build configuration for the standalone IIFE library.
 *
 * Produces:  dist/lib/v{major}.{minor}/solo-serial.js
 *
 * The output is a self-contained IIFE that registers a `SoloSerial` global on
 * `window`, so users can load it with a plain <script> tag from GitHub Pages.
 *
 * Build:  npx vite build --config vite.lib.config.ts
 *         (or via the `build:lib` npm script)
 */

import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg     = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string };
const version = pkg.version;                        // e.g. "0.1.0"
const [major, minor] = version.split('.').slice(0, 2);  // e.g. "0", "1"

export default defineConfig({
  // Inject the version string into the library at build time.
  define: {
    __LIB_VERSION__: JSON.stringify(version),
  },

  // Don't copy the public/ folder into the lib output directory.
  publicDir: false,

  build: {
    // Output goes into dist/lib/v{major}.{minor}/ so:
    //   • GH Pages URL: https://<org>.github.io/<repo>/lib/v0.1/solo-serial.js
    //   • Each minor version gets its own folder — allows patch updates without breaking consumer URLs.
    //   • A breaking v1 will be at .../lib/v1.0/solo-serial.js
    outDir:      `dist/lib/v${major}.${minor}`,
    emptyOutDir: true,           // clear the versioned subfolder on each lib build

    lib: {
      entry:   resolve(__dirname, 'src/lib/index.ts'),
      name:    'SoloSerial',     // sets window.SoloSerial
      formats: ['iife'],
      // Vite appends the format suffix; for a single IIFE the output will be:
      //   solo-serial.iife.js  → renamed to  solo-serial.js  via rollupOptions below
      fileName: () => 'solo-serial',
    },

    rollupOptions: {
      output: {
        // Produce  solo-serial.js  (not  solo-serial.iife.js)
        entryFileNames: 'solo-serial.js',
        // Keep the library in a single file — no dynamic chunk splitting.
        inlineDynamicImports: true,
      },
    },

    // Keep the source readable for debugging; tree-shake dead code.
    minify:     true,
    sourcemap:  true,
  },
});
