import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '.' }
}))
vi.mock('@main/windows', () => ({
  closePaneWindows: vi.fn()
}))
vi.mock('@main/config/store', () => ({
  getSetting: () => undefined
}))

import { ScrollbackBuffer } from '@main/agents/AgentManager'

describe('ScrollbackBuffer', () => {
  it('accumulates appended chunks in order', () => {
    const b = new ScrollbackBuffer(100)
    b.append('foo')
    b.append('bar')
    expect(b.toString()).toBe('foobar')
    expect(b.length).toBe(6)
  })

  it('evicts oldest content once the limit is exceeded, keeping the newest chars', () => {
    const b = new ScrollbackBuffer(5)
    b.append('abc')
    b.append('defg')
    // Total would be 7; only the last 5 chars are retained.
    expect(b.toString()).toBe('cdefg')
    expect(b.length).toBe(5)
  })

  it('trims across a chunk boundary without corrupting later chunks', () => {
    const b = new ScrollbackBuffer(4)
    b.append('12')
    b.append('34')
    b.append('56')
    expect(b.toString()).toBe('3456')
    expect(b.length).toBe(4)
  })

  it('tail returns only the last n chars', () => {
    const b = new ScrollbackBuffer(1000)
    b.append('hello ')
    b.append('world')
    expect(b.tail(5)).toBe('world')
    expect(b.tail(0)).toBe('')
    expect(b.tail(999)).toBe('hello world')
  })

  it('reset replaces the whole buffer', () => {
    const b = new ScrollbackBuffer(100)
    b.append('old content')
    b.reset('fresh')
    expect(b.toString()).toBe('fresh')
    expect(b.length).toBe(5)
    b.reset()
    expect(b.toString()).toBe('')
    expect(b.length).toBe(0)
  })

  it('memoized flatten stays correct after further appends', () => {
    const b = new ScrollbackBuffer(100)
    b.append('a')
    expect(b.toString()).toBe('a')
    b.append('b')
    expect(b.toString()).toBe('ab')
  })

  it('ignores empty appends', () => {
    const b = new ScrollbackBuffer(100)
    b.append('x')
    b.append('')
    expect(b.toString()).toBe('x')
    expect(b.length).toBe(1)
  })
})
