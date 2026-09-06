/**
 * Scrollback sync against a real headless xterm. The DOM is a `string[]` of
 * row texts that patches are applied to; after each burst it must equal
 * `buffer.normal` lines below `baseY`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { ScrollbackSync, type ScrollbackPatch } from './terminalRows'

const terminals: Terminal[] = []

afterEach(() => {
  for (const term of terminals) term.dispose()
  terminals.length = 0
})

function open(opts: { cols?: number; rows?: number; scrollback?: number } = {}): Terminal {
  const term = new Terminal({
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 10,
    scrollback: opts.scrollback ?? 1000,
    allowProposedApi: true
  })
  terminals.push(term)
  return term
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    term.write(data, resolve)
  })
}

function lines(count: number, prefix: string): string {
  let data = ''
  for (let index = 0; index < count; index += 1) data += `${prefix}${index}\r\n`
  return data
}

function scrollbackOf(term: Terminal): string[] {
  const { normal } = term.buffer
  const base = Math.max(0, normal.baseY)
  const rows: string[] = []
  for (let index = 0; index < base; index += 1) {
    rows.push(normal.getLine(index)?.translateToString(true) ?? '')
  }
  return rows
}

function applyPatch(dom: string[], patch: ScrollbackPatch, term: Terminal): string[] {
  const next = patch.appendFrom === 0 ? [] : dom.slice(patch.dropHead)
  const { normal } = term.buffer
  const base = Math.max(0, normal.baseY)
  for (let index = patch.appendFrom; index < base; index += 1) {
    next.push(normal.getLine(index)?.translateToString(true) ?? '')
  }
  return next
}

function step(
  sync: ScrollbackSync,
  term: Terminal,
  dom: string[],
  rebuild = false
): { patch: ScrollbackPatch; dom: string[] } {
  const patch = sync.next(dom.length, rebuild)
  const nextDom = applyPatch(dom, patch, term)
  sync.mark(Math.max(0, term.buffer.normal.baseY))
  return { patch, dom: nextDom }
}

describe('ScrollbackSync against a headless Terminal', () => {
  it('does not drop or duplicate rows on a DECSTBM region scroll', async () => {
    const term = open({ cols: 80, rows: 10, scrollback: 1000 })
    const sync = new ScrollbackSync(term)
    await write(term, lines(30, 'line '))
    const filled = step(sync, term, [])
    expect(filled.dom).toEqual(scrollbackOf(term))
    await write(term, `\x1b[3;8r\x1b[8;1H${'\n'.repeat(20)}`)
    const base = Math.max(0, term.buffer.normal.baseY)
    const region = step(sync, term, filled.dom)
    expect(region.patch).toEqual({ dropHead: 0, appendFrom: base })
    expect(region.dom).toEqual(scrollbackOf(term))
  })

  it('keeps the simulated DOM equal to the buffer across a full scrollback', async () => {
    const term = open({ cols: 80, rows: 10, scrollback: 50 })
    const sync = new ScrollbackSync(term)
    let dom: string[] = []
    for (const burst of [40, 40, 40, 40, 40]) {
      await write(term, lines(burst, 'L'))
      const result = step(sync, term, dom)
      dom = result.dom
      expect(dom).toEqual(scrollbackOf(term))
      expect(dom.length).toBeLessThanOrEqual(50)
    }
  })

  it('drops every row when ED 3 clears the scrollback', async () => {
    const term = open({ cols: 80, rows: 10, scrollback: 50 })
    const sync = new ScrollbackSync(term)
    await write(term, lines(80, 'E'))
    const filled = step(sync, term, [])
    expect(filled.dom.length).toBeGreaterThan(0)
    await write(term, '\x1b[3J')
    const cleared = step(sync, term, filled.dom)
    expect(cleared.patch).toEqual({ dropHead: filled.dom.length, appendFrom: 0 })
    expect(cleared.dom).toEqual([])
    expect(scrollbackOf(term)).toEqual([])
  })

  it('appends only the new lines of a burst that does not trim', async () => {
    const term = open({ cols: 80, rows: 10, scrollback: 1000 })
    const sync = new ScrollbackSync(term)
    await write(term, lines(15, 'A'))
    const first = step(sync, term, [])
    await write(term, lines(5, 'B'))
    const second = step(sync, term, first.dom)
    expect(second.patch).toEqual({ dropHead: 0, appendFrom: first.dom.length })
    expect(second.dom.slice(0, first.dom.length)).toEqual(first.dom)
    expect(second.dom).toEqual(scrollbackOf(term))
    expect(second.dom.length).toBeGreaterThan(first.dom.length)
  })

  it('rebuilds from 0 after a reset', async () => {
    const term = open({ cols: 80, rows: 10, scrollback: 50 })
    const sync = new ScrollbackSync(term)
    await write(term, lines(20, 'R'))
    const first = step(sync, term, [])
    expect(first.dom.length).toBeGreaterThan(0)
    term.reset()
    const second = step(sync, term, first.dom, true)
    expect(second.patch).toEqual({ dropHead: first.dom.length, appendFrom: 0 })
    expect(second.dom).toEqual(scrollbackOf(term))
    expect(second.dom).toEqual([])
  })
})
