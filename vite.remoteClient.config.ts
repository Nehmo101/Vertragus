import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The remote web client — a standalone browser bundle, NOT part of the
 * electron-vite build. It is deliberately separate from the desktop renderer:
 * the renderer talks to Electron through the `window.vertragus` preload bridge,
 * and shimming that over a socket would couple this client to every renderer
 * refactor. This client speaks only the remote WebSocket protocol.
 *
 * Output lands in `out/remote`, next to the main bundle, where the remote
 * server's static handler serves it (`remoteStaticRoot()` in index.ts).
 *
 * `src/remoteClient/public/` is Vite's default public directory for this root
 * and is copied to the bundle root verbatim: the PWA manifest and its icons.
 * The icons are renders of `build/icon.svg` at the sizes the phones actually
 * ask for — 180 for iOS's home screen, 192/512 for Android, 32 for the tab,
 * plus a 512 maskable one whose mark sits at 64 % of the canvas so Android's
 * shape crop cannot cut into it. `scripts/gen-icons.mjs` owns the desktop
 * icon set and has no reason to know about these; regenerate them with sharp
 * from the same SVG if the mark ever changes.
 *
 * ## The manifest is monolingual, deliberately
 *
 * AGENTS.md requires user-visible copy in both locales, and the manifest is a
 * static file that cannot read `hello.locale` — it is fetched by the browser
 * before the client has spoken to any host. Rather than ship English strings
 * to a German default, it now carries no prose at all: `description` (the only
 * sentence it had, shown solely in Android's install sheet — iOS ignores the
 * manifest entirely and reads the apple-* tags) is gone, and what remains is
 * `name` / `short_name`, which are the product's name and identical in every
 * locale. The alternative — serving the manifest through `staticFiles.ts` with
 * the host's locale substituted — buys one install-sheet sentence at the price
 * of making a static asset dynamic, and was not worth it. This is the written
 * decision, not a silent exception.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/remoteClient'),
  // Relative asset URLs — the client is served from the server root.
  base: './',
  build: {
    outDir: resolve(__dirname, 'out/remote'),
    emptyOutDir: true
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  plugins: [react()]
})
