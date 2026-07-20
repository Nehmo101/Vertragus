import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CODEX_RUNTIME_DIR_NAME } from './codexSandbox'
import {
  codexRuntimeCanaryArgs,
  panePreflightInternals,
  type PanePreflightInput
} from './panePreflight'

const childProcess = vi.hoisted(() => ({
  execFile: vi.fn(),
  invocations: [] as Array<{
    file: string
    args: string[]
    options: {
      cwd?: string
      env?: NodeJS.ProcessEnv
      timeout?: number
    }
  }>
}))

vi.mock('node:child_process', () => ({ execFile: childProcess.execFile }))
vi.mock('@main/agents/resolveCommand', () => ({
  resolveLaunch: vi.fn(async (_command: string, args: string[]) => ({
    file: 'codex.exe',
    args
  }))
}))

type ExecCallback = (error: Error | null, stdout?: string, stderr?: string) => void

const fixtureRoots: string[] = []

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vertragus-pane-preflight-'))
  fixtureRoots.push(root)
  return root
}

function mockCanaryExecution(error?: Error): void {
  childProcess.execFile.mockImplementation(
    (file: string, args: string[], options: Record<string, unknown>, callback: ExecCallback) => {
      childProcess.invocations.push({
        file,
        args,
        options: options as (typeof childProcess.invocations)[number]['options']
      })
      callback(error ?? null, '', '')
    }
  )
}

function codexInput(workingDir: string, worktree?: string): PanePreflightInput {
  return { provider: 'codex', workingDir, worktree }
}

afterEach(async () => {
  childProcess.execFile.mockReset()
  childProcess.invocations.length = 0
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Codex runtime preflight', () => {
  it('passes an untrusted worker path as one argv value and keeps every sandbox safety flag', () => {
    const worker = 'C:\\repo & whoami\\.vertragus-worktrees\\worker'
    const args = codexRuntimeCanaryArgs(worker)

    expect(args).toEqual([
      'sandbox',
      '-c',
      'sandbox_workspace_write.exclude_slash_tmp=true',
      '--permission-profile',
      ':workspace',
      '-C',
      worker,
      'powershell.exe',
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      expect.stringMatching(/ORCA_CODEX_CANARY_PATH.*WriteAllText/)
    ])
    expect(args.at(-1)).not.toContain(worker)
    expect(args).not.toContain('exec')
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it('uses and cleans a narrow pool workspace below the profile runtime root', async () => {
    const profile = await fixtureRoot()
    const runtimeRoot = join(profile, CODEX_RUNTIME_DIR_NAME)
    const sentinel = join(runtimeRoot, 'keep-existing.txt')
    await mkdir(runtimeRoot)
    await writeFile(sentinel, 'keep')
    mockCanaryExecution()

    const result = await panePreflightInternals.providerRuntimeCanary(
      codexInput(profile),
      profile,
      undefined,
      'win32'
    )

    expect(childProcess.invocations).toHaveLength(1)
    const invocation = childProcess.invocations[0]!
    const canaryWorkspace = invocation.options.cwd!
    const markerPath = invocation.options.env?.ORCA_CODEX_CANARY_PATH
    const runtimeDir = invocation.options.env?.TEMP
    expect(dirname(canaryWorkspace)).toBe(runtimeRoot)
    expect(relative(runtimeRoot, canaryWorkspace)).toMatch(/^preflight-workspace-/)
    expect(invocation.args).toContain(canaryWorkspace)
    expect(markerPath && dirname(markerPath)).toBe(canaryWorkspace)
    expect(runtimeDir && dirname(runtimeDir)).toBe(canaryWorkspace)
    expect(invocation.options.env?.TMP).toBe(runtimeDir)
    expect(invocation.options.env?.TMPDIR).toBe(runtimeDir)
    expect(invocation.options.timeout).toBe(12_000)
    expect(result.detail).toContain(canaryWorkspace)
    await expect(access(canaryWorkspace)).rejects.toThrow()
    await expect(access(markerPath!)).rejects.toThrow()
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep')
  })

  it('checks the exact canonical worker and cleans only its generated runtime entries', async () => {
    const profile = await fixtureRoot()
    const worker = join(profile, '.vertragus-worktrees', 'session', 'worker')
    const runtimeRoot = join(worker, CODEX_RUNTIME_DIR_NAME)
    const sentinel = join(runtimeRoot, 'keep-existing.txt')
    await mkdir(runtimeRoot, { recursive: true })
    await writeFile(sentinel, 'keep')
    mockCanaryExecution()

    const paths = await panePreflightInternals.canonicalPreflightPaths(
      codexInput(profile, join(worker, 'nested', '..'))
    )
    await panePreflightInternals.providerRuntimeCanary(
      codexInput(profile, paths.workerWorkspace),
      paths.profileWorkspace,
      paths.workerWorkspace,
      'win32'
    )

    expect(paths.workerWorkspace).toBe(worker)
    expect(childProcess.invocations).toHaveLength(1)
    const invocation = childProcess.invocations[0]!
    const markerPath = invocation.options.env?.ORCA_CODEX_CANARY_PATH
    const runtimeDir = invocation.options.env?.TEMP
    expect(invocation.options.cwd).toBe(worker)
    expect(invocation.args).toContain(worker)
    expect(markerPath && dirname(markerPath)).toBe(worker)
    expect(runtimeDir && dirname(runtimeDir)).toBe(runtimeRoot)
    await expect(access(markerPath!)).rejects.toThrow()
    await expect(access(runtimeDir!)).rejects.toThrow()
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep')
  })

  it('reports timeout and stderr without retrying in Yolo mode', async () => {
    const profile = await fixtureRoot()
    const failure = Object.assign(new Error('Command failed'), {
      killed: true,
      stderr: 'sandbox bootstrap denied'
    })
    mockCanaryExecution(failure)

    await expect(
      panePreflightInternals.providerRuntimeCanary(
        codexInput(profile),
        profile,
        undefined,
        'win32'
      )
    ).rejects.toThrow(/Timeout nach 12000 ms; stderr: sandbox bootstrap denied/)
    expect(childProcess.invocations).toHaveLength(1)
    expect(childProcess.invocations[0]?.args).not.toContain(
      '--dangerously-bypass-approvals-and-sandbox'
    )
  })

  it('preserves explicit Yolo and non-Windows skip semantics', async () => {
    const profile = await fixtureRoot()

    await expect(
      panePreflightInternals.providerRuntimeCanary(
        { ...codexInput(profile), yolo: true },
        profile,
        undefined,
        'win32'
      )
    ).resolves.toMatchObject({ status: 'warning', detail: expect.stringContaining('Yolo') })
    await expect(
      panePreflightInternals.providerRuntimeCanary(
        codexInput(profile),
        profile,
        undefined,
        'linux'
      )
    ).resolves.toMatchObject({ status: 'warning', detail: expect.stringContaining('Windows') })
    expect(childProcess.execFile).not.toHaveBeenCalled()
  })
})
