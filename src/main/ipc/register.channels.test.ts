import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { IPC } from '@shared/ipc'

/**
 * Consistency contract for the 100+ IPC handler registrations in register.ts.
 * Behavioural coverage of every handler would require standing up the whole
 * main process; instead this pins the structural invariants that catch the real
 * bug classes: a handler wired to a non-existent channel (typo), or two handlers
 * fighting over the same channel (the second silently wins in Electron).
 */
const registerSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'register.ts'), 'utf8')

function registeredChannels(): string[] {
  // Matches ipcMain.handle(IPC.foo, …) and ipcMain.on(IPC.foo, …).
  return [...registerSrc.matchAll(/ipcMain\.(?:handle|on)\(\s*IPC\.(\w+)/g)].map((m) => m[1]!)
}

describe('register.ts IPC channel wiring', () => {
  it('registers every handler against a real IPC channel constant', () => {
    const known = new Set(Object.keys(IPC))
    const unknown = registeredChannels().filter((name) => !known.has(name))
    expect(unknown, `handlers reference non-existent IPC channels: ${unknown.join(', ')}`).toEqual([])
  })

  it('never registers the same channel twice (a duplicate silently overrides)', () => {
    const seen = new Map<string, number>()
    for (const name of registeredChannels()) seen.set(name, (seen.get(name) ?? 0) + 1)
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name)
    expect(dupes, `duplicate handler registrations: ${dupes.join(', ')}`).toEqual([])
  })

  it('registers a non-trivial number of handlers (guards against an accidental gutting)', () => {
    expect(registeredChannels().length).toBeGreaterThan(80)
  })
})
