/**
 * Renders build/icon.svg into the raster icons electron-builder needs
 * (build/icon.png) plus a renderer favicon. Run: node scripts/gen-icons.mjs
 */
import sharp from 'sharp'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sizes = Object.freeze([16, 32, 48, 64, 128, 256, 512, 1024])
const icoSizes = Object.freeze([16, 32, 48, 64, 128, 256])
const icnsSizes = Object.freeze([16, 32, 64, 128, 256, 512, 1024])

export function validateIconSize(size) {
  if (!Number.isSafeInteger(size) || !sizes.includes(size)) {
    throw new TypeError(`Unsupported icon size: ${String(size)}`)
  }
  return size
}

export function resolveSafePath(baseDirectory, untrustedRelativePath) {
  if (typeof baseDirectory !== 'string' || baseDirectory.length === 0) {
    throw new TypeError('Icon output base directory must be a non-empty string')
  }
  if (
    typeof untrustedRelativePath !== 'string' ||
    untrustedRelativePath.length === 0 ||
    untrustedRelativePath.includes('\0') ||
    untrustedRelativePath.includes('\\') ||
    isAbsolute(untrustedRelativePath) ||
    posix.isAbsolute(untrustedRelativePath) ||
    win32.isAbsolute(untrustedRelativePath)
  ) {
    throw new TypeError(`Icon path must be a relative POSIX path: ${String(untrustedRelativePath)}`)
  }

  const resolvedBase = resolve(baseDirectory)
  const resolvedPath = resolve(resolvedBase, untrustedRelativePath)
  const pathFromBase = relative(resolvedBase, resolvedPath)
  if (
    pathFromBase.length === 0 ||
    pathFromBase === '..' ||
    pathFromBase.startsWith(`..${sep}`) ||
    isAbsolute(pathFromBase)
  ) {
    throw new Error(`Icon path escapes its output directory: ${untrustedRelativePath}`)
  }
  return resolvedPath
}

function projectPath(path) {
  return resolveSafePath(root, path)
}

function validateIconSizes(iconSizes, requiredSizes = sizes) {
  if (!Array.isArray(iconSizes) || iconSizes.length === 0) {
    throw new TypeError('Icon sizes must be a non-empty array')
  }

  const validatedSizes = iconSizes.map(validateIconSize)
  if (new Set(validatedSizes).size !== validatedSizes.length) {
    throw new TypeError('Icon sizes must not contain duplicates')
  }
  if (validatedSizes.length !== requiredSizes.length || !requiredSizes.every((size) => validatedSizes.includes(size))) {
    throw new TypeError('Icon sizes must include every required platform size')
  }
  return validatedSizes
}

function pngForSize(pngs, size) {
  const png = pngs.get(validateIconSize(size))
  if (!Buffer.isBuffer(png)) {
    throw new Error(`Missing PNG for icon size: ${size}`)
  }
  return png
}

function createIco(pngs, iconSizes) {
  const validatedSizes = validateIconSizes(iconSizes, icoSizes)
  const header = Buffer.alloc(6 + validatedSizes.length * 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(validatedSizes.length, 4)

  let offset = header.length
  for (const [index, size] of validatedSizes.entries()) {
    const png = pngForSize(pngs, size)
    const entry = 6 + index * 16
    header.writeUInt8(size === 256 ? 0 : size, entry)
    header.writeUInt8(size === 256 ? 0 : size, entry + 1)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  }

  return Buffer.concat([header, ...validatedSizes.map((size) => pngForSize(pngs, size))])
}

function createIcns(pngs) {
  const chunks = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024]
  ].map(([type, size]) => {
    const png = pngForSize(pngs, size)
    const chunk = Buffer.alloc(8 + png.length)
    chunk.write(type, 0, 4, 'ascii')
    chunk.writeUInt32BE(chunk.length, 4)
    png.copy(chunk, 8)
    return chunk
  })
  const header = Buffer.alloc(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(header.length + chunks.reduce((length, chunk) => length + chunk.length, 0), 4)
  return Buffer.concat([header, ...chunks])
}

export async function generateIcons({
  sourcePath = 'build/icon.svg',
  buildPath = 'build',
  rendererPublicPath = 'src/renderer/public',
  iconSizes = sizes
} = {}) {
  const validatedSizes = validateIconSizes(iconSizes)
  const svgPath = projectPath(sourcePath)
  const build = projectPath(buildPath)
  const linuxIcons = resolveSafePath(build, 'icons')
  const rendererPublic = projectPath(rendererPublicPath)
  const faviconPath = resolveSafePath(rendererPublic, 'favicon.png')
  const svg = readFileSync(svgPath)

  mkdirSync(linuxIcons, { recursive: true })
  mkdirSync(rendererPublic, { recursive: true })

  const pngs = new Map()
  for (const size of validatedSizes) {
    const png = await sharp(svg, { density: 384 }).resize(size, size).png().toBuffer()
    pngs.set(size, png)
    writeFileSync(resolveSafePath(linuxIcons, `${size}x${size}.png`), png)
  }

  writeFileSync(resolveSafePath(build, 'icon.png'), pngForSize(pngs, 1024))
  writeFileSync(resolveSafePath(build, 'icon.ico'), createIco(pngs, icoSizes))
  writeFileSync(resolveSafePath(build, 'icon.icns'), createIcns(pngs, icnsSizes))
  writeFileSync(faviconPath, pngForSize(pngs, 512))

  console.log('icons written: ICO, ICNS, 16-1024px Linux PNGs, and 512px favicon')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateIcons()
}
