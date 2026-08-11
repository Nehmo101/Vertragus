/**
 * logo-compare.mjs — Sichtungswerkzeug für die Fusione-Marke.
 *
 * Rendert die historischen Stände des Zeichens (aus C:\git\vertragus-archiv)
 * gegen den aktuellen Repo-Stand: je 28/64/160 px, auf dunklem und hellem
 * Grund, plus nearest-neighbour-Vergrößerung der Kleinstgrößen, damit man
 * sieht, was bei Panel-Größe tatsächlich auf dem Schirm landet.
 *
 * Aufruf:  node scripts/logo-compare.mjs <ausgabe.png> [variante...]
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

/* ---------------------------------------------------------------- Paletten */

const DARK = {
  name: 'dark',
  ground: '#0e1013',
  bg: '#0e1013',
  text: '#eae6db',
  accent: '#cba35a',
  accentStrong: '#f0dcaf',
  accentSoft: 'rgba(203,163,90,0.12)',
  accentLine: 'rgba(203,163,90,0.4)',
  sage: '#2f7d6d',
  label: '#eae6db'
}

const LIGHT = {
  name: 'light',
  ground: '#ede8dd',
  bg: '#ede8dd',
  text: '#20242b',
  accent: '#936c2b',
  accentStrong: '#b98a3c',
  accentSoft: 'rgba(147,108,43,0.12)',
  accentLine: 'rgba(147,108,43,0.45)',
  sage: '#1e5148',
  label: '#20242b'
}

/** color-mix(in srgb, a p%, b (100-p)%) vorberechnet (librsvg kann kein color-mix). */
function mix(a, b, p) {
  const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
  const [ar, ag, ab] = hex(a)
  const [br, bg, bb] = hex(b)
  const t = p / 100
  const ch = (x, y) => Math.round(x * t + y * (1 - t))
  return `rgb(${ch(ar, br)},${ch(ag, bg)},${ch(ab, bb)})`
}

/* ------------------------------------------------------------- Geometrien */

const V1_PATH =
  'M121 24.2 C117.5 23.1 114 22.1 110.5 21.2 C109.2 20.8 107.6 20.3 106.3 20.2 ' +
  'C105.6 20.1 105.2 20 104.8 20 C104 19.2 103.2 18.7 102.4 18.8 C101.6 18.9 100.9 19.4 100 19.9 ' +
  'C96.5 20.1 93 19.4 89.5 18.6 C86.5 18 84.2 17.7 82 17.6 C78.5 17.35 75.5 17.1 72.5 16.8 ' +
  'C68.5 16.35 64.5 15.95 61.5 16.05 C58.5 16.35 55.8 17 53.5 17.9 C52.2 18.4 51 18.9 50 19.4 ' +
  'C47 20.6 43.8 21.6 40.5 22.35 C36.5 23.2 31.5 23.45 26.8 23.35 C24.5 23.3 22.5 23 20.9 22.65 ' +
  'C20.3 22.55 20.2 23.2 20.75 23.4 C24.4 24.4 28.8 24.75 33 24.65 C37.5 24.55 41.5 24 44.8 23.2 ' +
  'C45.8 22.95 46.7 22.68 47.5 22.4 C45.9 23.5 44.3 24.6 43 25.5 C41.3 26.8 39.7 27.9 38.5 29 ' +
  'C36.6 30.6 34.8 32 33 33.2 C31.6 34.3 30.3 35.3 29.2 36.2 C28.5 36.8 28.5 37.35 29.3 37.25 ' +
  'C31.5 35.9 33.8 34.3 36 32.6 C38.8 30.4 41.6 28.2 44 26 C44.9 25.2 45.7 24.7 46.5 24.4 ' +
  'C44.9 26.3 43.2 28.5 41.8 30.4 C40.4 32.2 38.9 33.5 37.4 34.6 C36.2 35.9 35.1 37.2 34.2 38.6 ' +
  'C33.6 39.3 33.8 39.85 34.7 39.6 C36.4 38.2 38 36.6 39.6 34.9 C42.4 31.9 45 29.2 47.5 27.2 ' +
  'C48.7 26.3 49.9 25.4 51 24.6 C54 22.5 57 21.6 60 21.55 C63 21.5 66 22.3 68.5 23.4 ' +
  'C72 25 75.8 27.6 78.5 29.8 C79.3 30.4 80.2 30.7 81 30.6 C83.4 31.6 86 32.6 88.4 33.8 ' +
  'C90.8 34.9 93.2 35.9 95.6 36.9 C97.1 37.5 98.4 38 99.6 38.3 C100.5 38.5 100.7 37.9 100 37.5 ' +
  'C97.4 36.1 94.6 34.7 92 33.2 C90 32.05 88.2 30.9 86.6 29.7 C86.3 29.45 86.05 29.2 85.8 29 ' +
  'C88.6 30 92 31 95.5 31.9 C99.5 32.9 103.5 33.6 107.5 34.1 C109.5 34.35 111.2 34.5 112.6 34.55 ' +
  'C113.7 34.6 113.9 33.9 113.1 33.55 C109.5 32.6 105.5 31.7 101.5 30.8 C97 29.75 92.5 28.3 88.5 26.4 ' +
  'C89.5 25.6 90.8 24.9 92.5 24.3 C95.5 23.3 99 22.75 102.5 22.7 C106.5 22.65 110.5 23 114 23.4 ' +
  'C116.8 23.7 119.2 23.95 121 24.2 Z'

const V4_SILHOUETTE =
  'M126.6 22.2 C125.2 19.6 122.0 17.8 116.2 17.6 C109.2 17.4 100.4 16.8 91.4 16.4 ' +
  'C81.8 16.0 72.6 16.2 63.6 17.4 C55.0 18.6 46.8 20.2 38.6 21.4 C31.6 22.4 26.8 22.2 25.0 21.0 ' +
  'C23.8 20.2 25.6 19.4 29.2 19.8 C34.4 20.8 39.2 23.6 41.4 27.6 C42.6 30.4 41.8 33.2 43.4 34.8 ' +
  'C45.6 36.6 49.2 34.8 53.0 31.2 C58.6 26.6 65.6 23.2 73.8 21.6 C82.6 20.0 91.4 21.0 98.8 24.2 ' +
  'C105.4 27.0 110.8 29.6 114.2 31.6 C117.4 33.4 120.0 33.6 121.6 32.0 C123.6 29.8 124.8 26.2 125.6 23.4 ' +
  'C126.0 22.4 127.2 22.0 126.6 22.2 Z'
const V4_TAIL =
  'M44.8 33.6 C41.2 31.4 37.0 28.2 34.0 25.8 C31.2 23.6 29.0 23.4 28.2 24.6 C26.4 23.8 22.0 23.6 18.5 23.5'
const V4_EAR =
  'M108.2 17.4 C104.6 14.2 99.6 13.4 96.8 14.6 C94.4 15.4 93.8 17.6 95.8 19.0 C98.4 20.6 103.8 20.0 108.2 17.4 Z'
const V4_EAR_INNER =
  'M104.8 17.8 C103.0 16.0 100.8 15.6 99.4 16.2 C98.2 16.8 98.4 18.0 99.8 18.6 C101.4 19.2 103.4 18.6 104.8 17.8 Z'
const V4_PAW = 'M40.0 35.4 C38.2 33.8 37.0 35.6 38.4 36.8 C39.6 37.6 41.0 36.2 40.0 35.4 Z'
const V4_HIGHLIGHT =
  'M124.2 21.8 C120.0 19.4 114.4 18.0 108.4 17.8 C102.2 17.6 96.4 16.6 90.4 16.2 C85.0 15.8 80.0 15.4 75.6 15.6'

/* ------------------------------------------------------------- Renderer */

/** Stand von 2026-07-17 (e39245e) — Urfassung, flache Fläche + 4 Tempolinien. */
function renderV1(p, { badge }) {
  return `
  <defs>
    <mask id="slits" maskUnits="userSpaceOnUse" x="-24" y="0" width="160" height="64">
      <rect x="-24" y="0" width="160" height="64" fill="#fff"/>
      <rect x="-24" y="17" width="86" height="1.6" fill="#000"/>
      <rect x="-24" y="19.9" width="80" height="1.5" fill="#000"/>
    </mask>
  </defs>
  ${badge ? `<rect x="6" y="6" width="108" height="108" rx="27" fill="${p.accentSoft}" stroke="${p.accentLine}" stroke-width="2"/>` : ''}
  <g transform="translate(14.5 37.4) scale(0.85)">
    <g stroke="${p.sage}" stroke-linecap="round" fill="none">
      <line x1="-14" y1="17.8" x2="68" y2="17.8" stroke-width="1.6"/>
      <line x1="-10" y1="20.65" x2="62" y2="20.65" stroke-width="1.5"/>
      <line x1="-16" y1="23.5" x2="18.5" y2="23.5" stroke-width="1.5"/>
      <line x1="-6" y1="27.2" x2="46" y2="27.2" stroke-width="1.4"/>
    </g>
    <path d="${V1_PATH}" fill="${p.accent}" mask="url(#slits)"/>
    <circle cx="110.2" cy="22.35" r="0.75" fill="${p.bg}" opacity="0.85"/>
  </g>`
}

/** Stand von 2026-08-10 (2d87a48) — „AAA"-Feinschliff v4, aktueller Repo-Stand. */
function renderV4(p, { badge, size }) {
  const compact = size <= 52
  const strokeWidth = compact ? 0.54 : 0.44
  const markScale = compact ? 0.91 : 0.88
  const lineBoost = compact ? 0.1 : 0
  const eyeBoost = compact ? 0.1 : 0
  return `
  <defs>
    <linearGradient id="bronze" x1="0.12" y1="0.04" x2="0.88" y2="0.96">
      <stop offset="0" stop-color="${p.accentStrong}"/>
      <stop offset="0.48" stop-color="${p.accent}"/>
      <stop offset="1" stop-color="${mix(p.accent, p.text, 68)}"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${p.accent}" stop-opacity="0"/>
      <stop offset="0.45" stop-color="${p.accent}" stop-opacity="0.35"/>
      <stop offset="1" stop-color="${p.accent}" stop-opacity="0"/>
    </linearGradient>
    <mask id="slits" maskUnits="userSpaceOnUse" x="-24" y="0" width="160" height="64">
      <rect x="-24" y="0" width="160" height="64" fill="#fff"/>
      <line x1="-14" y1="17.8" x2="68" y2="17.8" stroke="#000" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="-10" y1="20.65" x2="62" y2="20.65" stroke="#000" stroke-width="1.4" stroke-linecap="round"/>
    </mask>
  </defs>
  ${badge ? `<rect x="6" y="6" width="108" height="108" rx="27" fill="${p.accentSoft}" stroke="${p.accentLine}" stroke-width="2"/>` : ''}
  <g transform="translate(13.2 36.6) scale(${markScale})">
    <g stroke="${p.sage}" stroke-linecap="round" fill="none">
      <line x1="-14" y1="17.8" x2="68" y2="17.8" stroke-width="${1.6 + lineBoost}"/>
      <line x1="-10" y1="20.65" x2="62" y2="20.65" stroke-width="${1.5 + lineBoost}"/>
      <line x1="-16" y1="23.5" x2="18.5" y2="23.5" stroke-width="${1.5 + lineBoost}"/>
      <line x1="-6" y1="27.2" x2="46" y2="27.2" stroke-width="${1.4 + lineBoost}"/>
    </g>
    <path d="${V4_TAIL}" fill="none" stroke="${p.sage}" stroke-width="${1.2 + lineBoost}" stroke-linecap="round" opacity="0.88"/>
    <path d="${V4_SILHOUETTE}" fill="url(#bronze)" stroke="${p.accentLine}" stroke-width="${strokeWidth}"
          stroke-linejoin="round" stroke-linecap="round" paint-order="stroke fill" mask="url(#slits)"/>
    <path d="${V4_HIGHLIGHT}" fill="none" stroke="url(#sheen)" stroke-width="0.9" stroke-linecap="round" opacity="0.55"/>
    <path d="${V4_PAW}" fill="${mix(p.accent, p.text, 78)}" opacity="0.85"/>
    <path d="${V4_EAR}" fill="${mix(p.accent, p.text, 92)}"/>
    <path d="${V4_EAR_INNER}" fill="${mix(p.accent, p.text, 55)}" opacity="0.7"/>
    <circle cx="113" cy="21.4" r="${1.14 + eyeBoost}" fill="${p.bg}" stroke="${p.accentLine}" stroke-width="0.32"/>
  </g>`
}

/**
 * Restaurierter Stand: v1-Geometrie, aber mit eigener Kompakt-Auslegung —
 * ohne Badge, formatfüllend, Tempolinien laufen hinter dem Hund aus statt
 * quer durch ihn. Parameter sind bewusst offen, damit man sie sichten kann.
 */
function makeRestored(opt = {}) {
  // Voreinstellung = der ausgelieferte Stand (fusioneMark.ts FUSIONE_COMPACT).
  // Verbindlich ist immer `loadLiveRenderer`; diese Funktion dient dazu,
  // Abwandlungen nebeneinander zu sichten, bevor man sie festschreibt.
  const o = {
    compactAt: 48,
    compactScale: 1.02,
    compactX: -6.6,
    compactY: 9,
    compactLineEnd: 30,
    compactOutline: 1.2,
    compactSlits: false,
    compactLines: [{ x1: -20, y1: 21.5, x2: 30, y2: 21.5, w: 2.4 }],
    ...opt
  }
  return (p, { badge, size }) => {
    const compact = size <= o.compactAt
    const showBadge = badge && !compact
    const scale = compact ? o.compactScale : 0.85
    const tx = compact ? o.compactX : 14.5
    const ty = compact ? o.compactY : 37.4
    const lines = [
      { x1: -14, y1: 17.8, x2: 68, y2: 17.8, w: 1.6 },
      { x1: -10, y1: 20.65, x2: 62, y2: 20.65, w: 1.5 },
      { x1: -16, y1: 23.5, x2: 18.5, y2: 23.5, w: 1.5 },
      { x1: -6, y1: 27.2, x2: 46, y2: 27.2, w: 1.4 }
    ]
    const drawn = compact
      ? o.compactLines ?? lines.map((l) => ({ ...l, x2: Math.min(l.x2, o.compactLineEnd) }))
      : lines
    const useSlits = compact ? o.compactSlits : true
    return `
  <defs>
    <mask id="slits" maskUnits="userSpaceOnUse" x="-24" y="0" width="160" height="64">
      <rect x="-24" y="0" width="160" height="64" fill="#fff"/>
      <rect x="-24" y="17" width="86" height="1.6" fill="#000"/>
      <rect x="-24" y="19.9" width="80" height="1.5" fill="#000"/>
    </mask>
  </defs>
  ${showBadge ? `<rect x="6" y="6" width="108" height="108" rx="27" fill="${p.accentSoft}" stroke="${p.accentLine}" stroke-width="2"/>` : ''}
  <g transform="translate(${tx} ${ty}) scale(${scale})">
    <g stroke="${p.sage}" stroke-linecap="round" fill="none">
      ${drawn.map((l) => `<line x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}" stroke-width="${l.w}"/>`).join('\n      ')}
    </g>
    <path d="${V1_PATH}" fill="${p.accent}" ${compact && o.compactOutline ? `stroke="${p.accent}" stroke-width="${o.compactOutline}" stroke-linejoin="round" stroke-linecap="round"` : ''} ${useSlits ? 'mask="url(#slits)"' : ''}/>
    <circle cx="110.2" cy="22.35" r="${compact ? 1.0 : 0.75}" fill="${p.bg}" opacity="0.85"/>
  </g>`
  }
}

export const VARIANTS = {
  v1: { label: 'v1  e39245e  2026-07-17  Urfassung', render: renderV1 },
  v4: { label: 'v4  2d87a48  2026-08-10  "AAA"-Feinschliff', render: renderV4 },
  restored: {
    label: 'restauriert  v1-Geometrie + Kompakt-Auslegung',
    render: makeRestored(),
    frame: (size) =>
      size <= 48
        ? { viewBox: '0 0 120 75', w: Math.round(size * 1.6), h: size }
        : { viewBox: '0 0 120 120', w: size, h: size }
  }
}

export { makeRestored }

/** Erlaubt, weitere Stände zur Laufzeit anzumelden (z. B. den restaurierten). */
export function registerVariant(key, label, render, frame, full = false) {
  VARIANTS[key] = { label, render, frame, full }
}

/* --------------------------------------------- Der echte, gebaute Bestand */

/**
 * Rendert die tatsächliche HoundLogo-Komponente (kein Nachbau): HoundLogo.tsx
 * wird mit esbuild gebündelt, per react-dom/server zu SVG-Markup gerendert und
 * die Token durch Hex-Werte ersetzt (librsvg kennt keine CSS-Variablen).
 */
export async function loadLiveRenderer(root = join(import.meta.dirname, '..')) {
  const viteDir = join(require.resolve('vite/package.json'), '..')
  const esbuild = require(require.resolve('esbuild', { paths: [viteDir] }))
  const out = await esbuild.build({
    entryPoints: [join(root, 'src/renderer/src/panel/HoundLogo.tsx')],
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    write: false,
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    alias: { '@renderer': join(root, 'src/renderer/src') }
  })
  // Muss unterhalb von node_modules liegen, damit `react/jsx-runtime` auflöst.
  const cache = join(root, 'node_modules', '.cache')
  mkdirSync(cache, { recursive: true })
  const bundle = join(cache, 'logo-compare-live.mjs')
  writeFileSync(bundle, out.outputFiles[0].text, 'utf8')
  const mod = await import(pathToFileURL(bundle).href)
  const HoundLogo = mod.default
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { createElement } = await import('react')

  return (p, { badge, size, hero }) => {
    const svg = renderToStaticMarkup(createElement(HoundLogo, { size, badge, hero }))
    return svg
      .replaceAll('var(--accent-soft)', p.accentSoft)
      .replaceAll('var(--accent-line)', p.accentLine)
      .replaceAll('var(--accent-strong, var(--accent))', p.accentStrong)
      .replaceAll('var(--accent-strong)', p.accentStrong)
      .replaceAll('var(--accent)', p.accent)
      .replaceAll('var(--sage)', p.sage)
      .replaceAll('var(--bg)', p.bg)
      .replaceAll('var(--text)', p.text)
  }
}

/* ------------------------------------------------------------- Kontaktbogen */

const SIZES = [28, 64, 160]
const ZOOM = { 28: 5, 64: 2, 160: 1 }

async function cell(variant, palette, size, badge) {
  const v = VARIANTS[variant]
  const body = v.render(palette, { badge, size })
  // `full: true` heißt: der Renderer liefert bereits ein komplettes <svg>
  // (so kommt die echte Komponente unverändert auf den Bogen).
  const f = v.full
    ? { viewBox: null, w: null, h: null }
    : v.frame
      ? v.frame(size)
      : { viewBox: '0 0 120 120', w: size, h: size }
  const svg = v.full
    ? body.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f.viewBox}" width="${f.w}" height="${f.h}">${body}</svg>`
  // Bewusst ohne density-Override: so entsteht exakt das Pixelbild, das die
  // App bei dieser Größe zeigt. Die Vergrößerung danach ist nearest-neighbour.
  const png = await sharp(Buffer.from(svg)).png().toBuffer()
  if (v.full) {
    const meta = await sharp(png).metadata()
    f.w = meta.width
    f.h = meta.height
  }
  const z = ZOOM[size] ?? 1
  if (z === 1) return { png, w: f.w, h: f.h, size }
  const up = await sharp(png)
    .resize(Math.round(f.w * z), Math.round(f.h * z), { kernel: 'nearest' })
    .png()
    .toBuffer()
  return { png: up, w: Math.round(f.w * z), h: Math.round(f.h * z), size }
}

export async function buildSheet(outPath, variantKeys, { badge = true, title = 'Fusione' } = {}) {
  const palettes = [DARK, LIGHT]
  const pad = 28
  const rowLabelW = 300
  const colW = 200
  const cellH = 200
  const headerH = 70
  const blockH = 40 + cellH

  const width = rowLabelW + palettes.length * SIZES.length * colW + pad * 2
  const height = headerH + variantKeys.length * (blockH + 30) + pad * 2

  const overlays = []
  const labels = []

  labels.push(
    `<text x="${pad}" y="${pad + 30}" fill="#f5f2ea" font-family="sans-serif" font-size="26" font-weight="bold">${title}</text>`
  )
  palettes.forEach((p, pi) => {
    SIZES.forEach((s, si) => {
      const x = pad + rowLabelW + (pi * SIZES.length + si) * colW
      labels.push(
        `<text x="${x + colW / 2}" y="${pad + 58}" fill="#b9b3a5" font-family="sans-serif" font-size="15" text-anchor="middle">${s}px ${p.name}${ZOOM[s] > 1 ? ` (${ZOOM[s]}×)` : ''}</text>`
      )
    })
  })

  for (let vi = 0; vi < variantKeys.length; vi++) {
    const key = variantKeys[vi]
    const top = pad + headerH + vi * (blockH + 30)
    labels.push(
      `<text x="${pad}" y="${top + cellH / 2}" fill="#f5f2ea" font-family="sans-serif" font-size="17">${VARIANTS[key].label}</text>`
    )
    for (let pi = 0; pi < palettes.length; pi++) {
      for (let si = 0; si < SIZES.length; si++) {
        const p = palettes[pi]
        const s = SIZES[si]
        const c = await cell(key, p, s, badge)
        const x = pad + rowLabelW + (pi * SIZES.length + si) * colW
        // Grundfläche der Zelle in Palettenfarbe
        labels.push(
          `<rect x="${x + 8}" y="${top}" width="${colW - 16}" height="${cellH}" fill="${p.ground}" stroke="#3a3f47"/>`
        )
        overlays.push({
          input: c.png,
          left: Math.round(x + colW / 2 - c.w / 2),
          top: Math.round(top + cellH / 2 - c.h / 2)
        })
      }
    }
  }

  const bg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="#191c21"/>
    ${labels.join('\n')}
  </svg>`

  const base = await sharp(Buffer.from(bg)).png().toBuffer()
  await sharp(base).composite(overlays).png().toFile(outPath)
  return outPath
}

/* ------------------------------------------------------------- CLI */

if (process.argv[1] && process.argv[1].endsWith('logo-compare.mjs')) {
  const out = process.argv[2] || join(mkdtempSync(join(tmpdir(), 'logo-')), 'compare.png')
  const keys = process.argv.slice(3).filter((k) => VARIANTS[k])
  await buildSheet(out, keys.length ? keys : Object.keys(VARIANTS))
  console.log(out)
}
