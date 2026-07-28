import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { IPC } from '@shared/ipc'
import { listIpcChannels } from '@shared/ipcManifest'

/**
 * Consistency contract for the 100+ IPC channel registrations. Registration is
 * manifest-driven (registerManifestChannels loops over src/shared/ipcManifest.ts),
 * so the classic bug classes are pinned against the manifest: a channel wired
 * to a non-existent IPC constant (typo), two entries fighting over the same
 * channel (the second ipcMain registration silently wins in Electron), or a
 * sneaky return to direct ipcMain wiring that would bypass the central
 * auth/validation pipeline.
 */
const registerSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'register.ts'), 'utf8')

const registerable = listIpcChannels().filter(
  (e) => e.spec.kind === 'invoke' || e.spec.kind === 'send'
)

describe('manifest-driven IPC channel wiring', () => {
  it('registers every handler against a real IPC channel constant', () => {
    const known = new Set<string>(Object.values(IPC))
    const unknown = registerable.filter((e) => !known.has(e.spec.channel)).map((e) => e.key)
    expect(unknown, `manifest entries reference non-existent IPC channels: ${unknown.join(', ')}`).toEqual([])
  })

  it('never registers the same channel twice (a duplicate silently overrides)', () => {
    const seen = new Map<string, number>()
    for (const { spec } of registerable) seen.set(spec.channel, (seen.get(spec.channel) ?? 0) + 1)
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name)
    expect(dupes, `duplicate channel registrations: ${dupes.join(', ')}`).toEqual([])
  })

  it('registers a non-trivial number of handlers (guards against an accidental gutting)', () => {
    expect(registerable.length).toBeGreaterThan(80)
  })

  it('register.ts wires channels only through registerManifestChannels (no direct ipcMain calls)', () => {
    expect(registerSrc).toMatch(/registerManifestChannels\(\s*manifestHandlers/)
    expect(
      registerSrc.match(/ipcMain\.(handle|on)\(/g) ?? [],
      'direct ipcMain wiring found in register.ts — new channels belong in the manifest ' +
        '(or in LEGACY_CHANNELS of ipcSurface.test.ts with a reason)'
    ).toEqual([])
  })
})
