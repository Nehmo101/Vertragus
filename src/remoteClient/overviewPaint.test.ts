/**
 * Guard for the overview paint budget: pulses stay compositor-only, and no
 * window `touchmove` is registered as cancelable. There is no DOM runner, so
 * this reads the sheets and the client sources the way `RemoteTerminal.test.ts`
 * reads the component.
 *
 * Every assertion is paired with a self-check on its own scanning, so a
 * regex that quietly stops matching fails loudly instead of passing vacuously.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const dir = dirname(fileURLToPath(import.meta.url))

const SHEETS = ['styles.css', 'overview.css', 'terminal.css'] as const

function read(name: string): string {
  return readFileSync(join(dir, name), 'utf8')
}

function keyframeBlocks(css: string): { name: string; body: string }[] {
  const blocks: { name: string; body: string }[] = []
  const marker = /@keyframes\s+([\w-]+)\s*\{/g
  let match: RegExpExecArray | null
  while ((match = marker.exec(css))) {
    const name = match[1]
    const bodyStart = match.index + match[0].length
    let depth = 1
    let i = bodyStart
    while (i < css.length && depth > 0) {
      const ch = css[i]
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
      i += 1
    }
    blocks.push({ name, body: css.slice(bodyStart, i - 1) })
  }
  return blocks
}

function clientSources(): { name: string; source: string }[] {
  return readdirSync(dir)
    .filter((name) => /\.tsx?$/.test(name) && !name.endsWith('.test.ts'))
    .map((name) => ({ name, source: read(name) }))
}

function windowTouchMoves(source: string): string[] {
  return [...source.matchAll(/window\.addEventListener\(\s*['"]touchmove['"][^)]*\)/g)].map(
    (match) => match[0]
  )
}

describe('keyframes stay compositor-only', () => {
  const sheets = SHEETS.map((name) => ({ name, css: read(name) }))
  const blocks = sheets.flatMap((sheet) =>
    keyframeBlocks(sheet.css).map((block) => ({ sheet: sheet.name, ...block }))
  )

  it('finds the pulse and the terminal rise it is about to police', () => {
    const names = blocks.map((block) => block.name)
    expect(names).toContain('vg-pulse')
    expect(names).toContain('term-rise')
    expect(blocks.length).toBeGreaterThan(0)
  })

  it('animates no box-shadow in any keyframe block of the three sheets', () => {
    const offenders = blocks.filter((block) => /box-shadow\s*:/.test(block.body))
    expect(
      offenders,
      offenders.map((block) => `${block.sheet} @keyframes ${block.name}`).join(', ')
    ).toEqual([])
  })

  it('keeps the working pulse on transform and opacity', () => {
    const pulse = blocks.find((block) => block.name === 'vg-pulse')
    expect(pulse).toBeDefined()
    expect(pulse?.body).toContain('transform:')
    expect(pulse?.body).toContain('opacity:')
    expect(pulse?.sheet).toBe('styles.css')
  })
})

describe('window touchmove stays passive', () => {
  const files = clientSources()
  const registrations = files.flatMap((file) =>
    windowTouchMoves(file.source).map((call) => ({ file: file.name, call }))
  )

  it('finds the overview pull listener it is about to police', () => {
    expect(files.some((file) => file.name === 'usePullToRefresh.ts')).toBe(true)
    expect(registrations.some((entry) => entry.file === 'usePullToRefresh.ts')).toBe(true)
  })

  it('registers no window touchmove with passive false', () => {
    for (const entry of registrations) {
      expect(entry.call, entry.file).not.toMatch(/passive:\s*false/)
      expect(entry.call, entry.file).toContain('passive: true')
    }
  })
})

describe('the pull overlay does not insert layout height', () => {
  const overview = read('overview.css')
  const app = read('App.tsx')

  it('finds the indicator rule and the App mount', () => {
    expect(overview).toContain('.pull-indicator')
    expect(app).toContain('ref={pullIndicator}')
    expect(app).toContain('pull-indicator')
  })

  it('is position fixed and driven by custom properties, not height', () => {
    const start = overview.indexOf('.pull-indicator {')
    expect(start).toBeGreaterThan(-1)
    const end = overview.indexOf('}', start)
    const rule = overview.slice(start, end)
    expect(rule).toContain('position: fixed')
    expect(rule).toContain('var(--pull-shown')
    expect(rule).toContain('var(--pull-opacity')
    expect(rule).toContain('transform:')
    expect(app).not.toContain('pullIndicatorHeight')
    expect(app).not.toContain('pull.distance')
  })
})
