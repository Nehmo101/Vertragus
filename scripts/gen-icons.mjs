/**
 * Renders build/icon.svg into the raster icons electron-builder needs
 * (build/icon.png) plus a renderer favicon. Run: node scripts/gen-icons.mjs
 */
import sharp from 'sharp'
import { readFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(join(root, 'build/icon.svg'))

mkdirSync(join(root, 'src/renderer/public'), { recursive: true })

await sharp(svg, { density: 384 }).resize(1024, 1024).png().toFile(join(root, 'build/icon.png'))
await sharp(svg, { density: 384 })
  .resize(256, 256)
  .png()
  .toFile(join(root, 'src/renderer/public/favicon.png'))

console.log('icons written: build/icon.png (1024), src/renderer/public/favicon.png (256)')
