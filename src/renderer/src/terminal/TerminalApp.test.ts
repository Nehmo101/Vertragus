import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'TerminalApp.tsx'), 'utf8')

function applyFitBody(): string {
  const start = source.indexOf('const applyFit = (): void => {')
  const end = source.indexOf('const scheduleFitRetries')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('TerminalApp first fit', () => {
  it('asks FitAddon.proposeDimensions and the helper before resizing the PTY', () => {
    const body = applyFitBody()
    expect(body).toContain('fit.proposeDimensions()')
    expect(body).toContain('ptyFitSize(')
    expect(body).toContain('bridge.resize(size.cols, size.rows)')
    expect(body).not.toMatch(/\btry\s*\{|\bcatch\s*[({]/)
    expect(body).not.toContain('term.cols')
  })

  it('retries fit after layout without waiting for a user drag', () => {
    expect(source).toContain("addEventListener('resize', applyFit)")
    expect(source).toContain('scheduleFitRetries()')
    expect(source).toContain('window.requestAnimationFrame')
  })
})
