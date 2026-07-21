import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@main': fileURLToPath(new URL('./src/main', import.meta.url)),
      '@renderer': fileURLToPath(new URL('./src/renderer/src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'apps/**/*.test.ts'],
    // Unit tests run in plain Node without the Electron binary. Electron's entry
    // point honors this override and returns a path string instead of trying to
    // download the platform binary at import time (which 403s in CI and, since
    // Electron 43, hard-fails the suite load for any module that imports electron).
    env: { ELECTRON_OVERRIDE_DIST_PATH: fileURLToPath(new URL('./node_modules/.bin', import.meta.url)) },
    coverage: { reporter: ['text', 'json-summary'] }
  }
})
