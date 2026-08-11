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
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'tests/**/*.test.ts'],
    // Unit tests run in plain Node without the Electron binary. Electron's entry
    // point honors this override and returns a path string instead of trying to
    // download the platform binary at import time.
    env: {
      ELECTRON_OVERRIDE_DIST_PATH: fileURLToPath(new URL('./node_modules/.bin', import.meta.url))
    },
    coverage: {
      reporter: ['text', 'json-summary'],
      include: ['src/**', 'scripts/**'],
      exclude: ['**/dist/**', '**/*.test.ts', '**/*.d.ts', 'src/renderer/src/env.d.ts'],
      // Ratchet thresholds: set just below the measured status quo so coverage
      // can only move up. Raise them deliberately, never lower. Seeded low while
      // the skeleton grows; ratchet up from M2 on.
      thresholds: {
        statements: 0,
        branches: 0,
        functions: 0,
        lines: 0
      }
    }
  }
})
