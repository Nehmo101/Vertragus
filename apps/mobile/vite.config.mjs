import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': resolve(root, '../../src/shared') } },
  build: { outDir: 'dist', emptyOutDir: true },
  server: { host: '127.0.0.1' }
})

