import { describe, expect, it } from 'vitest'
import { CAST_NAMES, GUIDE_NAMES } from '@shared/lore'
import { NameAllocator } from './names'

describe('NameAllocator', () => {
  it('draws from a shuffled bag instead of always taking the first names', () => {
    const allocator = new NameAllocator(() => 0.999_999)
    const drawn = Array.from({ length: 12 }, () => allocator.allocate('sub'))

    expect(drawn[0]).toBe(CAST_NAMES.at(-1))
    expect(drawn).not.toEqual(CAST_NAMES.slice(0, 12))
  })

  it('uses the complete pool without duplicates before adding suffixes', () => {
    let sample = 0.17
    const allocator = new NameAllocator(() => {
      sample = (sample + 0.37) % 1
      return sample
    })
    const drawn = CAST_NAMES.map(() => allocator.allocate('sub'))

    expect(new Set(drawn)).toEqual(new Set(CAST_NAMES))
    expect(allocator.allocate('sub')).toMatch(/ 2$/)
  })

  it('keeps orchestrator and subagent shuffle bags separate', () => {
    const allocator = new NameAllocator(() => 0.999_999)

    expect(allocator.allocate('orchestrator')).toBe(GUIDE_NAMES.at(-1))
    expect(allocator.allocate('sub')).toBe(CAST_NAMES.at(-1))
  })

  it('makes a released name available again after the current bag is consumed', () => {
    const allocator = new NameAllocator(() => 0.5)
    const drawn = CAST_NAMES.map(() => allocator.allocate('sub'))
    const released = drawn[7]

    allocator.release(released)

    expect(allocator.allocate('sub')).toBe(released)
  })
})
