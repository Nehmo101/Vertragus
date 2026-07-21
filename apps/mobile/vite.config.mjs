import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': resolve(root, '../../src/shared') } },
  // Target a modern baseline (matches tsconfig ES2022). Vite's default browser
  // baseline made esbuild 0.28 hard-error when downleveling destructuring; the
  // mobile companion app runs on modern devices, so no downleveling is needed.
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: { host: '127.0.0.1' }
})

