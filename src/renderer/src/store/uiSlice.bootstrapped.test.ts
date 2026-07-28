import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { useAppStore } from '@renderer/store/useAppStore'

describe('uiSlice bootstrapped flag', () => {
  it('starts un-bootstrapped so the workspace can show a loading state', () => {
    expect(useAppStore.getState().bootstrapped).toBe(false)
  })

  it('is flipped exactly at the end of init() (source contract)', () => {
    // init() lives in useAppStore.ts and is too IPC-heavy to run in a unit
    // test; like the canvas-default migration test we pin the source contract:
    // the bootstrap must end by setting the flag.
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'useAppStore.ts'),
      'utf8'
    )
    expect(source).toMatch(/set\(\{ bootstrapped: true \}\)/)
    // The flag is set after the fire-and-forget refreshes, i.e. at the very end.
    const initEnd = source.indexOf('set({ bootstrapped: true })')
    expect(initEnd).toBeGreaterThan(source.indexOf('refreshModels()'))
  })
})
