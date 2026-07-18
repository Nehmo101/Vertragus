import { describe, expect, it } from 'vitest'
import { canvasBoardKey, isSafeCanvasIdentifier, parsePersistedBoards } from './canvasStore'

describe('canvasStore validation and workspace boundary', () => {
  it('rejects invalid empty input instead of creating a shared board', () => {
    expect(isSafeCanvasIdentifier('')).toBe(false)
    expect(() => canvasBoardKey('')).toThrow('Invalid canvas board identifier')
  })

  it.each(['../outside', '..\\outside', '/tmp/link-target', 'session/subdir'])(
    'rejects traversal and symlink-shaped identifiers: %s',
    (identifier) => {
      expect(isSafeCanvasIdentifier(identifier)).toBe(false)
      expect(() => canvasBoardKey('profile', identifier)).toThrow('Invalid canvas board identifier')
    }
  )

  it('drops malformed and non-finite persisted coordinates', () => {
    const boards = parsePersistedBoards(JSON.stringify({ boards: { safe: { ok: { x: 1, y: 2 }, bad: { x: '1', y: 2 } } } }))
    expect(boards).toEqual({ safe: { ok: { x: 1, y: 2 } } })
  })
})
