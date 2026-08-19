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
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  plugins: [react()]
})
