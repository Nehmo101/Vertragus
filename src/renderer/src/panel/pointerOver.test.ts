import { describe, expect, it } from 'vitest'
import { POINTER_OVER_CLASS, trackPanelPointer } from './pointerOver'

function fakeTarget(): { classes: Set<string>; add(t: string): void; remove(t: string): void } {
  const classes = new Set<string>()
  return {
    classes,
    add: (token) => void classes.add(token),
    remove: (token) => void classes.delete(token)
  }
}

function fakeSource(): {
  emit(inside: boolean): void
  onPointer(listener: (event: { inside: boolean }) => void): () => void
  listeners: number
} {
  const listeners: ((event: { inside: boolean }) => void)[] = []
  return {
    get listeners() {
      return listeners.length
    },
    emit: (inside) => listeners.forEach((listener) => listener({ inside })),
    onPointer(listener) {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    }
  }
}

describe('trackPanelPointer', () => {
  it('adds the class while the pointer is inside and drops it again', () => {
    const target = fakeTarget()
    const source = fakeSource()
    trackPanelPointer(target, source)

    expect(target.classes.has(POINTER_OVER_CLASS)).toBe(false)
    source.emit(true)
    expect(target.classes.has(POINTER_OVER_CLASS)).toBe(true)
    source.emit(false)
    expect(target.classes.has(POINTER_OVER_CLASS)).toBe(false)
  })

  it('unsubscribes and clears the class on cleanup', () => {
    const target = fakeTarget()
    const source = fakeSource()
    const stop = trackPanelPointer(target, source)

    source.emit(true)
    stop()
    expect(source.listeners).toBe(0)
    expect(target.classes.has(POINTER_OVER_CLASS)).toBe(false)

    // A push that arrives after the cleanup must not resurrect the class.
    source.emit(true)
    expect(target.classes.has(POINTER_OVER_CLASS)).toBe(false)
  })

  it('accepts a custom class name', () => {
    const target = fakeTarget()
    const source = fakeSource()
    trackPanelPointer(target, source, 'x-over')

    source.emit(true)
    expect([...target.classes]).toEqual(['x-over'])
  })
})
