import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { createSpillStore } from './spill'

const spillDir = join('/repo', '.vertragus', 'runs', 'ws-1', 'spill')

describe('createSpillStore — S1', () => {
  it('writes the content verbatim under .vertragus/runs/<id>/spill/ and returns the path', async () => {
    const writes: Array<{ path: string; data: string }> = []
    const store = createSpillStore('/repo', 'ws-1', {
      mkdir: vi.fn(async () => undefined),
      writeFile: (async (path: unknown, data: unknown) => {
        writes.push({ path: String(path), data: String(data) })
      }) as never,
      warn: vi.fn()
    })

    const path = await store.save('read-output-caronte', 'full text\nwith lines')
    expect(path).toBe(join(spillDir, '1-read-output-caronte.txt'))
    expect(writes).toEqual([{ path, data: 'full text\nwith lines' }])
  })

  it('normalizes names to [a-z0-9-] and never yields an empty name', async () => {
    const store = createSpillStore('/repo', 'ws-1', {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined) as never,
      warn: vi.fn()
    })

    expect(await store.save('Inspect Diff: src/A.ts!', 'x')).toBe(
      join(spillDir, '1-inspect-diff-src-a-ts.txt')
    )
    // Nothing survives normalization → the fallback name, still seq-unique.
    expect(await store.save('///***///', 'x')).toBe(join(spillDir, '2-output.txt'))
  })

  it('increments the seq per save — files never overwrite each other', async () => {
    const paths: string[] = []
    const store = createSpillStore('/repo', 'ws-1', {
      mkdir: vi.fn(async () => undefined),
      writeFile: (async (path: unknown) => {
        paths.push(String(path))
      }) as never,
      warn: vi.fn()
    })

    await store.save('diff', 'a')
    await store.save('diff', 'b')
    await store.save('diff', 'c')
    expect(paths).toEqual([
      join(spillDir, '1-diff.txt'),
      join(spillDir, '2-diff.txt'),
      join(spillDir, '3-diff.txt')
    ])
  })

  it('fails soft on mkdir errors: warns once, then answers undefined silently', async () => {
    const warn = vi.fn()
    const write = vi.fn(async () => undefined)
    const store = createSpillStore('/repo', 'ws-1', {
      mkdir: vi.fn(async () => {
        throw new Error('EROFS')
      }),
      writeFile: write as never,
      warn
    })

    expect(await store.save('a', 'x')).toBeUndefined()
    expect(await store.save('b', 'x')).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
  })

  it('fails soft on write errors: warns once, then answers undefined silently', async () => {
    const warn = vi.fn()
    const store = createSpillStore('/repo', 'ws-1', {
      mkdir: vi.fn(async () => undefined),
      writeFile: (async () => {
        throw new Error('ENOSPC')
      }) as never,
      warn
    })

    expect(await store.save('a', 'x')).toBeUndefined()
    expect(await store.save('b', 'x')).toBeUndefined()
    expect(await store.save('c', 'x')).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
