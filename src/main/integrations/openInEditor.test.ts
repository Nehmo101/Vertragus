import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
vi.mock('@main/agents/resolveCommand', () => ({ resolveLaunch: vi.fn() }))

import { openWorktreeInEditor } from './openInEditor'

describe('openWorktreeInEditor', () => {
  it('prefers the VS Code CLI when it launches successfully', async () => {
    const exec = vi.fn(async () => undefined)
    const openPath = vi.fn(async () => '')
    const result = await openWorktreeInEditor('/repo/.vertragus-worktrees/t1', {
      resolve: vi.fn(async () => ({ file: '/usr/bin/code', args: ['/repo/.vertragus-worktrees/t1'] })),
      exec,
      openPath
    })

    expect(result).toEqual({ opened: 'editor' })
    expect(exec).toHaveBeenCalledWith('/usr/bin/code', ['/repo/.vertragus-worktrees/t1'])
    expect(openPath).not.toHaveBeenCalled()
  })

  it('falls back to the OS file manager when the code CLI is missing', async () => {
    const openPath = vi.fn(async () => '')
    const result = await openWorktreeInEditor('/w', {
      resolve: vi.fn(async () => ({ file: 'code', args: ['/w'] })),
      exec: vi.fn(async () => {
        throw Object.assign(new Error('spawn code ENOENT'), { code: 'ENOENT' })
      }),
      openPath
    })

    expect(result).toEqual({ opened: 'folder' })
    expect(openPath).toHaveBeenCalledWith('/w')
  })

  it('surfaces a clear error when even the file manager cannot open the path', async () => {
    await expect(
      openWorktreeInEditor('/gone', {
        resolve: vi.fn(async () => ({ file: 'code', args: ['/gone'] })),
        exec: vi.fn(async () => {
          throw new Error('nope')
        }),
        openPath: vi.fn(async () => 'No application found')
      })
    ).rejects.toThrow(/Ordner konnte nicht geöffnet werden/)
  })
})
