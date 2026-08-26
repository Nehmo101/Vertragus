import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { providerPreset } from '@main/providers/presets'
import {
  applyCursorRunEverything,
  argvHasCursorForce,
  CURSOR_APPROVAL_UNRESTRICTED,
  CURSOR_CLI_FILE,
  CURSOR_FORCE_FLAG,
  CURSOR_RUN_EVERYTHING_ARGS,
  CURSOR_SANDBOX_DISABLED,
  CURSOR_SANDBOX_FLAG,
  CURSOR_YOLO_ALIAS,
  cursorUsesProjectDialect,
  ensureCursorRunEverythingConfig,
  mergeCursorRunEverythingConfig
} from './cursorRunMode'

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'vertragus-cursor-run-'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('cursorUsesProjectDialect', () => {
  it('matches the shipped Cursor preset, the project MCP dialect, and cursor-agent', () => {
    expect(cursorUsesProjectDialect(providerPreset('cursor')!)).toBe(true)
    expect(cursorUsesProjectDialect(providerPreset('claude')!)).toBe(false)
    expect(
      cursorUsesProjectDialect({ presetId: 'claude', mcp: { kind: 'cursor-project' } })
    ).toBe(true)
    expect(
      cursorUsesProjectDialect({
        presetId: 'ollama',
        mcp: { kind: 'none' },
        command: 'C:\\Tools\\cursor-agent.exe'
      })
    ).toBe(true)
    expect(
      cursorUsesProjectDialect({
        presetId: 'ollama',
        mcp: { kind: 'none' },
        command: 'C:\\Tools\\cursor-agent.cmd'
      })
    ).toBe(true)
    expect(
      cursorUsesProjectDialect({ presetId: 'ollama', mcp: { kind: 'none' }, command: 'ollama' })
    ).toBe(false)
  })
})

describe('applyCursorRunEverything', () => {
  it('matches the shipped Cursor yoloArgs', () => {
    expect(providerPreset('cursor')!.yoloArgs).toEqual([...CURSOR_RUN_EVERYTHING_ARGS])
  })

  it('adds --force and --sandbox disabled when argv has neither', () => {
    expect(applyCursorRunEverything(['--trust'])).toEqual([
      '--trust',
      CURSOR_FORCE_FLAG,
      CURSOR_SANDBOX_FLAG,
      CURSOR_SANDBOX_DISABLED
    ])
  })

  it('keeps --yolo and only turns the sandbox off', () => {
    expect(applyCursorRunEverything(['--trust', CURSOR_YOLO_ALIAS])).toEqual([
      '--trust',
      CURSOR_YOLO_ALIAS,
      CURSOR_SANDBOX_FLAG,
      CURSOR_SANDBOX_DISABLED
    ])
  })

  it('is a no-op when the preset vector is already present', () => {
    const argv = ['--trust', ...CURSOR_RUN_EVERYTHING_ARGS]
    expect(applyCursorRunEverything(argv)).toBe(argv)
    expect(argv).toEqual(['--trust', ...CURSOR_RUN_EVERYTHING_ARGS])
  })

  it('forces sandbox disabled when a stored config left it enabled', () => {
    expect(applyCursorRunEverything(['--force', '--sandbox', 'enabled'])).toEqual([
      '--force',
      '--sandbox',
      'disabled'
    ])
  })

  it('treats -f as already-forced', () => {
    expect(argvHasCursorForce(['-f'])).toBe(true)
    expect(applyCursorRunEverything(['-f'])).toEqual(['-f', '--sandbox', 'disabled'])
  })
})

describe('mergeCursorRunEverythingConfig', () => {
  it('fills the required CLI schema on an empty file', () => {
    expect(mergeCursorRunEverythingConfig(null)).toEqual({
      version: 1,
      editor: { vimMode: false },
      permissions: { allow: [], deny: [] },
      approvalMode: CURSOR_APPROVAL_UNRESTRICTED,
      sandbox: { mode: CURSOR_SANDBOX_DISABLED }
    })
  })

  it('keeps foreign keys and existing permissions', () => {
    const merged = mergeCursorRunEverythingConfig({
      version: 1,
      editor: { vimMode: true },
      permissions: { allow: ['Shell(ls)'], deny: ['Shell(rm)'] },
      hints: true,
      sandbox: { networkAccess: 'allow' }
    })
    expect(merged).toMatchObject({
      editor: { vimMode: true },
      permissions: { allow: ['Shell(ls)'], deny: ['Shell(rm)'] },
      hints: true,
      approvalMode: CURSOR_APPROVAL_UNRESTRICTED,
      sandbox: { networkAccess: 'allow', mode: CURSOR_SANDBOX_DISABLED }
    })
  })

  it('repairs a corrupt or partial existing file', () => {
    expect(
      mergeCursorRunEverythingConfig({ version: '1', editor: [], permissions: 3, sandbox: 1 })
    ).toEqual({
      version: 1,
      editor: { vimMode: false },
      permissions: { allow: [], deny: [] },
      approvalMode: CURSOR_APPROVAL_UNRESTRICTED,
      sandbox: { mode: CURSOR_SANDBOX_DISABLED }
    })
  })
})

describe('ensureCursorRunEverythingConfig', () => {
  it('writes .cursor/cli.json for an empty worktree', () => {
    const result = ensureCursorRunEverythingConfig(workspace)
    expect(result.outcome).toBe('written')
    const path = join(workspace, '.cursor', CURSOR_CLI_FILE)
    expect(result.path).toBe(path)
    const written = JSON.parse(readFileSync(path, 'utf8')) as {
      approvalMode: string
      sandbox: { mode: string }
    }
    expect(written.approvalMode).toBe(CURSOR_APPROVAL_UNRESTRICTED)
    expect(written.sandbox.mode).toBe(CURSOR_SANDBOX_DISABLED)
  })

  it('is already-set when the file already is Run Everything', () => {
    mkdirSync(join(workspace, '.cursor'))
    writeFileSync(
      join(workspace, '.cursor', CURSOR_CLI_FILE),
      JSON.stringify(mergeCursorRunEverythingConfig(null))
    )
    const result = ensureCursorRunEverythingConfig(workspace)
    expect(result.outcome).toBe('already-set')
  })

  it('skips an empty cwd', () => {
    expect(ensureCursorRunEverythingConfig('  ').outcome).toBe('skipped')
  })

  it('skips when the directory cannot be created', () => {
    const result = ensureCursorRunEverythingConfig(workspace, {
      warn: () => undefined,
      makeDir: () => {
        throw new Error('eacces')
      }
    })
    expect(result.outcome).toBe('skipped')
    expect(result.reason).toMatch(/could not create/)
  })

  it('skips when the write fails', () => {
    const result = ensureCursorRunEverythingConfig(workspace, {
      warn: () => undefined,
      writeFile: () => {
        throw new Error('disk full')
      }
    })
    expect(result.outcome).toBe('skipped')
    expect(result.reason).toMatch(/could not write/)
  })

  it('warns on the console when no logger is injected', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const result = ensureCursorRunEverythingConfig(workspace, {
        writeFile: () => {
          throw new Error('disk full')
        }
      })
      expect(result.outcome).toBe('skipped')
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('replaces an unparseable cli.json', () => {
    mkdirSync(join(workspace, '.cursor'))
    writeFileSync(join(workspace, '.cursor', CURSOR_CLI_FILE), 'not-json')
    const result = ensureCursorRunEverythingConfig(workspace)
    expect(result.outcome).toBe('written')
  })

  it('upgrades unrestricted-but-sandboxed to Run Everything', () => {
    mkdirSync(join(workspace, '.cursor'))
    writeFileSync(
      join(workspace, '.cursor', CURSOR_CLI_FILE),
      JSON.stringify({ approvalMode: CURSOR_APPROVAL_UNRESTRICTED, sandbox: { mode: 'enabled' } })
    )
    const result = ensureCursorRunEverythingConfig(workspace)
    expect(result.outcome).toBe('written')
    const written = JSON.parse(
      readFileSync(join(workspace, '.cursor', CURSOR_CLI_FILE), 'utf8')
    ) as { sandbox: { mode: string } }
    expect(written.sandbox.mode).toBe(CURSOR_SANDBOX_DISABLED)
  })
})
