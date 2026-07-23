import { writeFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: mocks.execFile }
})

import {
  parseGitleaksReport,
  parseGitleaksVersion,
  scanStagedWithGitleaks,
  stagedScanArgs
} from './gitleaksGate'

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void

function callbackOf(args: unknown[]): ExecCallback {
  const callback = args[args.length - 1]
  if (typeof callback !== 'function') throw new Error('execFile-Callback fehlt')
  return callback as ExecCallback
}

function argvOf(call: unknown[]): string[] {
  return call[1] as string[]
}

function withCode(message: string, code: string | number | null): Error {
  return Object.assign(new Error(message), { code })
}

/** Probe answers with a version; the scan invocation is delegated to onScan. */
function mockGitleaks(options: {
  version?: string
  onScan: (argv: string[], callback: ExecCallback) => void
}): void {
  mocks.execFile.mockImplementation((...args: unknown[]) => {
    const argv = argvOf(args)
    const callback = callbackOf(args)
    if (argv[0] === 'version') {
      callback(null, options.version ?? '8.20.1', '')
      return
    }
    options.onScan(argv, callback)
  })
}

function reportPathOf(argv: string[]): string {
  const path = argv[argv.indexOf('--report-path') + 1]
  if (!path) throw new Error('kein --report-path Argument')
  return path
}

beforeEach(() => {
  mocks.execFile.mockReset()
})

describe('gitleaksGate scan', () => {
  it('reports clean and invokes gitleaks without a shell in the worktree', async () => {
    mockGitleaks({ onScan: (_argv, callback) => callback(null, '', '') })

    await expect(scanStagedWithGitleaks('/repo/worktree')).resolves.toEqual({ status: 'clean' })

    const probeCall = mocks.execFile.mock.calls[0]!
    expect(probeCall[0]).toBe('gitleaks')
    expect(argvOf(probeCall)).toEqual(['version'])

    const scanCall = mocks.execFile.mock.calls[1]!
    expect(scanCall[0]).toBe('gitleaks')
    expect(argvOf(scanCall)).toEqual([
      'git',
      '--staged',
      '--no-banner',
      '--redact',
      '--report-format', 'json',
      '--report-path', expect.stringContaining('vertragus-gitleaks-')
    ])
    const options = scanCall[2] as { cwd?: string; timeout?: number; shell?: unknown }
    expect(options.cwd).toBe('/repo/worktree')
    expect(options.timeout).toBe(60_000)
    // Negative test: a shell would enable injection via file names or config.
    expect(options.shell ?? false).toBe(false)
  })

  it('parses findings from the JSON report and never copies the secret', async () => {
    const sentinel = 'sentinel-raw-secret-value'
    mockGitleaks({
      onScan: (argv, callback) => {
        void writeFile(
          reportPathOf(argv),
          JSON.stringify([
            {
              Description: 'AWS Access Key',
              File: 'config/service.env',
              StartLine: 3,
              RuleID: 'aws-access-key-id',
              Match: sentinel,
              Secret: sentinel
            },
            { Description: '', File: '', StartLine: Number.NaN, RuleID: '' }
          ]),
          'utf8'
        ).then(
          () => callback(withCode('leaks found', 1), '', ''),
          (error) => callback(error as Error, '', '')
        )
      }
    })

    const result = await scanStagedWithGitleaks('/repo/worktree')

    expect(result).toEqual({
      status: 'findings',
      findings: [
        {
          file: 'config/service.env',
          line: 3,
          rule: 'aws-access-key-id',
          redactedMatch: 'AWS Access Key'
        },
        { file: '<unbekannte Datei>', line: 0, rule: 'unbekannte-regel', redactedMatch: 'REDACTED' }
      ]
    })
    // Redaction negative test: the raw secret must not leak into the result.
    expect(JSON.stringify(result)).not.toContain(sentinel)
  })

  it('returns unavailable when the binary is missing (ENOENT) and skips the scan', async () => {
    mocks.execFile.mockImplementation((...args: unknown[]) => {
      callbackOf(args)(withCode('spawn gitleaks ENOENT', 'ENOENT'), '', '')
    })

    await expect(scanStagedWithGitleaks('/repo/worktree')).resolves.toEqual({ status: 'unavailable' })
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
  })

  it('classifies a timeout kill as error, not as clean', async () => {
    mockGitleaks({
      onScan: (_argv, callback) =>
        callback(
          Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM', code: null }),
          '',
          ''
        )
    })

    const result = await scanStagedWithGitleaks('/repo/worktree')
    expect(result).toMatchObject({ status: 'error', message: expect.stringMatching(/Timeout/) })
  })

  it.each([
    ['8.18.4', 'protect'],
    ['v8.20.1', 'git']
  ])('picks the staged subcommand for gitleaks %s', async (version, expected) => {
    mockGitleaks({ version, onScan: (_argv, callback) => callback(null, '', '') })

    await expect(scanStagedWithGitleaks('/repo/worktree')).resolves.toEqual({ status: 'clean' })
    expect(argvOf(mocks.execFile.mock.calls[1]!)[0]).toBe(expected)
  })

  it('fails closed when exit code 1 comes without a usable report', async () => {
    mockGitleaks({
      onScan: (argv, callback) => {
        void writeFile(reportPathOf(argv), 'kein json', 'utf8').then(
          () => callback(withCode('leaks found', 1), '', ''),
          (error) => callback(error as Error, '', '')
        )
      }
    })
    await expect(scanStagedWithGitleaks('/repo/worktree')).resolves.toMatchObject({
      status: 'error',
      message: expect.stringMatching(/kein gültiges JSON/)
    })

    // Missing report file entirely.
    mockGitleaks({ onScan: (_argv, callback) => callback(withCode('leaks found', 1), '', '') })
    await expect(scanStagedWithGitleaks('/repo/worktree')).resolves.toMatchObject({
      status: 'error',
      message: expect.stringMatching(/nicht lesbar/)
    })

    // Contradiction: exit code 1 but an empty findings array.
    mockGitleaks({
      onScan: (argv, callback) => {
        void writeFile(reportPathOf(argv), '[]', 'utf8').then(
          () => callback(withCode('leaks found', 1), '', ''),
          (error) => callback(error as Error, '', '')
        )
      }
    })
    await expect(scanStagedWithGitleaks('/repo/worktree')).resolves.toMatchObject({
      status: 'error',
      message: expect.stringMatching(/keine Funde/)
    })
  })

  it('reports unexpected exit codes and failed version probes as error', async () => {
    mockGitleaks({
      onScan: (_argv, callback) => callback(withCode('config invalid', 126), '', 'bad config')
    })
    await expect(scanStagedWithGitleaks('/repo/worktree')).resolves.toMatchObject({
      status: 'error',
      message: expect.stringMatching(/Exit-Code 126/)
    })

    mocks.execFile.mockImplementation((...args: unknown[]) => {
      callbackOf(args)(withCode('boom', 2), '', 'unknown flag')
    })
    await expect(scanStagedWithGitleaks('/repo/worktree')).resolves.toMatchObject({
      status: 'error',
      message: expect.stringMatching(/Versionsermittlung/)
    })
  })
})

describe('gitleaksGate helpers', () => {
  it('parses version strings from typical probe output', () => {
    expect(parseGitleaksVersion('8.18.2')).toEqual({ major: 8, minor: 18 })
    expect(parseGitleaksVersion('v8.20.1')).toEqual({ major: 8, minor: 20 })
    expect(parseGitleaksVersion('gitleaks version 9.0.0')).toEqual({ major: 9, minor: 0 })
    expect(parseGitleaksVersion('nonsense')).toBeUndefined()
  })

  it('switches between protect (pre-8.19) and git (8.19+) syntax', () => {
    expect(stagedScanArgs({ major: 8, minor: 18 }, 'r.json')[0]).toBe('protect')
    expect(stagedScanArgs({ major: 8, minor: 19 }, 'r.json')[0]).toBe('git')
    expect(stagedScanArgs({ major: 9, minor: 0 }, 'r.json')[0]).toBe('git')
    expect(stagedScanArgs(undefined, 'r.json')[0]).toBe('git')
  })

  it('rejects malformed report payloads instead of guessing', () => {
    expect(parseGitleaksReport('{"not":"an array"}')).toMatchObject({ status: 'error' })
    expect(parseGitleaksReport('###')).toMatchObject({ status: 'error' })
    expect(parseGitleaksReport('[]')).toEqual({ status: 'clean' })
  })
})
