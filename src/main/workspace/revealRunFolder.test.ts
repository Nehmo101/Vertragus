import { describe, expect, it, vi } from 'vitest'
import { revealRunFolder } from './revealRunFolder'

const DIR = '/repo/.vertragus/runs/ws-1'

describe('revealRunFolder', () => {
  it('treats the empty string as success — that is the whole openPath contract', async () => {
    const open = vi.fn(async () => '')
    await expect(revealRunFolder(open, DIR)).resolves.toBeUndefined()
    expect(open).toHaveBeenCalledWith(DIR)
  })

  it('rejects on a RESOLVED error string, naming the path and the OS reason', async () => {
    // The trap this module exists for: openPath resolves on failure, so an
    // `await shell.openPath(dir)` with no check is a click that silently does
    // nothing on a run whose folder was never written.
    const open = vi.fn(async () => 'No such file or directory')
    await expect(revealRunFolder(open, DIR, 'en')).rejects.toThrow(
      'Run folder /repo/.vertragus/runs/ws-1 could not be opened — No such file or directory'
    )
  })

  /** The sentence is the locale table's; only the OS reason rides along raw. */
  it('speaks the stored locale, keeping the path and the OS reason', async () => {
    const open = vi.fn(async () => 'No such file or directory')
    await expect(revealRunFolder(open, DIR, 'de')).rejects.toThrow(
      'Lauf-Ordner /repo/.vertragus/runs/ws-1 konnte nicht geöffnet werden — No such file or directory'
    )
  })

  it('lets a genuine rejection through instead of swallowing it', async () => {
    const open = vi.fn(async () => {
      throw new Error('shell unavailable')
    })
    await expect(revealRunFolder(open, DIR)).rejects.toThrow(/shell unavailable/)
  })
})
