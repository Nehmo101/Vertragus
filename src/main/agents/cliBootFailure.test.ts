import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  diagnoseCliBootFailure,
  formatSeedFailure,
  isFatalCliBootOutput
} from './cliBootFailure'

const dump = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'cursor-agent-app-control.txt'),
  'utf8'
)

describe('isFatalCliBootOutput', () => {
  it('matches the measured cursor-agent 2026.08.11 Application Control dump', () => {
    expect(isFatalCliBootOutput(dump)).toBe(true)
  })

  it('matches Failed to load native binding without waiting for a path', () => {
    expect(isFatalCliBootOutput('Error: Failed to load native binding for win32/x64')).toBe(true)
  })

  it('leaves a healthy TUI banner alone', () => {
    expect(isFatalCliBootOutput('cursor-agent ready\u001b[?2004h')).toBe(false)
    expect(isFatalCliBootOutput('')).toBe(false)
  })

  it('still scans for the three fatal phrases — a silent regex drop would green this suite', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'cliBootFailure.ts'),
      'utf8'
    )
    expect(source).toContain('Application Control policy has blocked this file')
    expect(source).toContain('node-loader:')
    expect(source).toContain('Failed to load native binding')
  })
})

describe('diagnoseCliBootFailure', () => {
  it('names the blocked .node path from the measured dump', () => {
    const diagnosis = diagnoseCliBootFailure(dump)
    expect(diagnosis?.kind).toBe('application-control')
    expect(diagnosis?.blockedPath).toContain('file_service.win32-x64-msvc.node')
    expect(diagnosis?.blockedPath).toContain('2026.08.11-e8db854')
  })

  it('still classifies node-loader plus a path when the policy sentence is missing', () => {
    const diagnosis = diagnoseCliBootFailure(
      'Error: node-loader:\nC:\\Users\\t\\AppData\\Local\\cursor-agent\\versions\\x\\merkle-tree-napi.win32-x64-msvc.node'
    )
    expect(diagnosis).toMatchObject({
      kind: 'application-control',
      blockedPath: expect.stringContaining('merkle-tree-napi.win32-x64-msvc.node')
    })
  })

  it('quotes a native-binding failure that is not Application Control', () => {
    const diagnosis = diagnoseCliBootFailure(
      'Error: Failed to load native binding for win32/x64\n(expected: ./watcher.node)\nThe specified module could not be found'
    )
    expect(diagnosis?.kind).toBe('output')
    expect(diagnosis?.excerpt).toContain('Failed to load native binding')
  })

  it('ignores a short ready banner', () => {
    expect(diagnoseCliBootFailure('ready> ')).toBeUndefined()
  })

  it('quotes a long non-fatal dump so the panel is not mute', () => {
    const diagnosis = diagnoseCliBootFailure('panic: something exploded in the runtime bootstrap\n'.repeat(3))
    expect(diagnosis?.kind).toBe('output')
    expect(diagnosis?.excerpt).toContain('panic: something exploded')
  })
})

describe('formatSeedFailure', () => {
  it('speaks English when the stored locale is en', () => {
    const message = formatSeedFailure({
      name: 'Stazio',
      providerLabel: 'Cursor Agent',
      purpose: 'orchestrator-prompt',
      buffer: dump,
      locale: 'en'
    })
    expect(message).toContain('Stazio (Cursor Agent) could not start')
    expect(message).toContain('Application Control')
    expect(message).toContain('file_service.win32-x64-msvc.node')
    expect(message).toContain('TROUBLESHOOTING.md')
    expect(message).not.toMatch(/[äöüÄÖÜß]/)
  })

  it('speaks German by default — the schema locale', () => {
    const message = formatSeedFailure({
      name: 'Stazio',
      providerLabel: 'Cursor Agent',
      purpose: 'orchestrator-prompt',
      buffer: dump
    })
    expect(message).toContain('konnte nicht starten')
    expect(message).toContain('file_service.win32-x64-msvc.node')
  })

  it('keeps the generic never-ready sentence when the PTY said nothing', () => {
    expect(
      formatSeedFailure({
        name: 'Caronte',
        providerLabel: 'Claude Code',
        purpose: 'task',
        buffer: 'ready> ',
        locale: 'en'
      })
    ).toBe('Caronte (Claude Code) never became ready — the CLI did not accept its task.')
  })

  it('appends the CLI dump to a generic seed failure', () => {
    const message = formatSeedFailure({
      name: 'Ulisse',
      providerLabel: 'Claude Code',
      purpose: 'area',
      buffer: 'Error: Failed to load native binding for win32/x64\n(expected: ./watcher.node)',
      locale: 'en'
    })
    expect(message).toContain('never became ready — the CLI did not accept its area.')
    expect(message).toContain('CLI output:')
    expect(message).toContain('Failed to load native binding')
  })
})
