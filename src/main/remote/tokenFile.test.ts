import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPairingTokenFile } from './tokenFile'

describe('createPairingTokenFile', () => {
  it('round-trips a token and clears it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vertragus-token-'))
    const path = join(dir, 'remote-pairing.token')
    const store = createPairingTokenFile(path)

    expect(store.read()).toBeUndefined()
    store.write('tok-abc')
    expect(store.read()).toBe('tok-abc')
    expect(readFileSync(path, 'utf8')).toBe('tok-abc')
    store.clear()
    expect(store.read()).toBeUndefined()
  })

  it('treats a missing or empty file as no token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vertragus-token-'))
    const store = createPairingTokenFile(join(dir, 'missing.token'))
    expect(store.read()).toBeUndefined()
    store.clear()
    expect(store.read()).toBeUndefined()
  })
})
