import { describe, expect, it } from 'vitest'
import { ScrollbackBuffer, SCROLLBACK_LIMIT } from './scrollback'

describe('ScrollbackBuffer', () => {
  it('keeps everything below the limit and memoizes the snapshot', () => {
    const buffer = new ScrollbackBuffer(100)
    buffer.append('hello ')
    buffer.append('world')
    expect(buffer.snapshot()).toBe('hello world')
    expect(buffer.snapshot()).toBe('hello world')
    expect(buffer.length).toBe(11)
  })

  it('ignores empty appends', () => {
    const buffer = new ScrollbackBuffer(100)
    buffer.append('')
    expect(buffer.length).toBe(0)
    expect(buffer.snapshot()).toBe('')
  })

  it('caps at the limit by trimming the head, including partial chunks', () => {
    const buffer = new ScrollbackBuffer(10)
    buffer.append('abcde')
    buffer.append('fghij')
    buffer.append('klm')
    expect(buffer.length).toBe(10)
    expect(buffer.snapshot()).toBe('defghijklm')
  })

  it('drops whole chunks that fall out of the window', () => {
    const buffer = new ScrollbackBuffer(4)
    buffer.append('aaaa')
    buffer.append('bbbb')
    expect(buffer.snapshot()).toBe('bbbb')
  })

  it('handles a single chunk larger than the limit', () => {
    const buffer = new ScrollbackBuffer(4)
    buffer.append('0123456789')
    expect(buffer.snapshot()).toBe('6789')
  })

  it('returns tails without flattening the whole buffer', () => {
    const buffer = new ScrollbackBuffer(100)
    buffer.append('one\n')
    buffer.append('two\n')
    buffer.append('three\n')
    expect(buffer.tail(0)).toBe('')
    expect(buffer.tail(6)).toBe('three\n')
    expect(buffer.tail(999)).toBe('one\ntwo\nthree\n')
  })

  it('resets to a placeholder', () => {
    const buffer = new ScrollbackBuffer(100)
    buffer.append('noise')
    buffer.reset('spawn failed')
    expect(buffer.snapshot()).toBe('spawn failed')
    expect(buffer.length).toBe(12)
    buffer.reset()
    expect(buffer.snapshot()).toBe('')
  })

  it('defaults to a ~2 MB window', () => {
    expect(SCROLLBACK_LIMIT).toBe(2_000_000)
    const buffer = new ScrollbackBuffer()
    buffer.append('x'.repeat(SCROLLBACK_LIMIT + 500))
    expect(buffer.length).toBe(SCROLLBACK_LIMIT)
  })
})
