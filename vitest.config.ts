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
      /**
       * Ratchet thresholds: set ~2 points below the measured status quo so
       * coverage can only move up. Raise them deliberately, never lower.
       *
       * Measured at M6a (891 tests): statements/lines 63.1, branches 89.6,
       * functions 80.0. The statement figure is dominated by React components
       * — there is no DOM test runner in this project, so every `.tsx` file
       * counts as uncovered while its extracted logic (`panel/viewModel`,
       * `settings/model`, `zones/geometry`, `zones/autoLayout`) is tested at
       * close to 100 %. Note what is NOT in that list: the hooks themselves
       * (`useSettings` and friends) hold their validation inline and are
       * untested — extracting one is the cheapest way to raise the statement
       * number. That is why the branch and function numbers are the meaningful
       * ones, and why the statement gate is the loosest of the four.
       */
      thresholds: {
        statements: 61,
        branches: 87,
        functions: 78,
        lines: 61
      }
    }
  }
})
