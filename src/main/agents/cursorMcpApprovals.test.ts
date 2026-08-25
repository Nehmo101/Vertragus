import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CURSOR_APPROVALS_FILE,
  CURSOR_HOME_DIR,
  CURSOR_PROJECTS_DIR,
  cursorMcpApprovalKey,
  cursorProjectSlug,
  ensureCursorMcpApprovals
} from './cursorMcpApprovals'

let home: string
let workspace: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'vertragus-cursor-home-'))
  workspace = mkdtempSync(join(tmpdir(), 'vertragus-cursor-cwd-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

function writeProjectMcp(servers: Record<string, unknown>): void {
  mkdirSync(join(workspace, '.cursor'), { recursive: true })
  writeFileSync(
    join(workspace, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: servers }, null, 2)
  )
}

function approvalsPath(cwd = workspace): string {
  return join(
    home,
    CURSOR_HOME_DIR,
    CURSOR_PROJECTS_DIR,
    cursorProjectSlug(cwd),
    CURSOR_APPROVALS_FILE
  )
}

describe('cursorProjectSlug', () => {
  it('turns path separators into hyphens and trims edges', () => {
    expect(cursorProjectSlug('/repo/.vertragus/worktrees/a1')).toBe('repo-vertragus-worktrees-a1')
    expect(cursorProjectSlug('C:\\git\\UWE')).toBe('C-git-UWE')
    expect(cursorProjectSlug('--foo--')).toBe('foo')
  })
})

describe('cursorMcpApprovalKey', () => {
  it('is name plus 16 hex chars of sha256({ path, server })', () => {
    const server = { url: 'http://127.0.0.1:4711/mcp?ws=w&token=t' }
    const key = cursorMcpApprovalKey('/repo/a', 'vertragus', server)
    expect(key).toMatch(/^vertragus-[0-9a-f]{16}$/)
    expect(cursorMcpApprovalKey('/repo/a', 'vertragus', server)).toBe(key)
    expect(cursorMcpApprovalKey('/repo/b', 'vertragus', server)).not.toBe(key)
    expect(cursorMcpApprovalKey('/repo/a', 'github', server)).not.toBe(key)
  })
})

describe('ensureCursorMcpApprovals', () => {
  const deps = () => ({ homeDir: () => home })

  it('skips when there is no project mcp.json', () => {
    const result = ensureCursorMcpApprovals(workspace, deps())
    expect(result.outcome).toBe('skipped')
    expect(result.reason).toMatch(/no project mcp\.json/)
    expect(result.files).toEqual([])
  })

  it('skips an empty directory string', () => {
    expect(ensureCursorMcpApprovals('  ', deps()).outcome).toBe('skipped')
  })

  it('writes approval keys for every server in the project file', () => {
    const vertragus = { url: 'http://127.0.0.1:9/mcp?ws=w&token=t' }
    const github = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }
    writeProjectMcp({ vertragus, github })

    const result = ensureCursorMcpApprovals(workspace, deps())
    expect(result.outcome).toBe('granted')
    expect(result.keys).toEqual(
      expect.arrayContaining([
        cursorMcpApprovalKey(workspace, 'vertragus', vertragus),
        cursorMcpApprovalKey(workspace, 'github', github)
      ])
    )

    const written = JSON.parse(readFileSync(approvalsPath(), 'utf8')) as string[]
    expect(written).toEqual(expect.arrayContaining(result.keys))
  })

  it('merges into an existing approvals file and is idempotent', () => {
    writeProjectMcp({ vertragus: { url: 'http://127.0.0.1:1/mcp' } })
    mkdirSync(join(home, CURSOR_HOME_DIR, CURSOR_PROJECTS_DIR, cursorProjectSlug(workspace)), {
      recursive: true
    })
    writeFileSync(approvalsPath(), JSON.stringify(['keep-me-abc'], null, 2))

    const first = ensureCursorMcpApprovals(workspace, deps())
    expect(first.outcome).toBe('granted')
    const again = ensureCursorMcpApprovals(workspace, deps())
    expect(again.outcome).toBe('already-approved')

    const written = JSON.parse(readFileSync(approvalsPath(), 'utf8')) as string[]
    expect(written).toContain('keep-me-abc')
    expect(written).toEqual(expect.arrayContaining(first.keys))
  })

  it('treats a corrupt approvals file as empty rather than crashing', () => {
    writeProjectMcp({ vertragus: { url: 'http://127.0.0.1:1/mcp' } })
    mkdirSync(join(home, CURSOR_HOME_DIR, CURSOR_PROJECTS_DIR, cursorProjectSlug(workspace)), {
      recursive: true
    })
    writeFileSync(approvalsPath(), '{not-json')

    const result = ensureCursorMcpApprovals(workspace, deps())
    expect(result.outcome).toBe('granted')
    expect(JSON.parse(readFileSync(approvalsPath(), 'utf8'))).toEqual(expect.arrayContaining(result.keys))
  })

  it('does not throw when the home directory cannot be written', () => {
    writeProjectMcp({ vertragus: { url: 'http://127.0.0.1:1/mcp' } })
    const result = ensureCursorMcpApprovals(workspace, {
      homeDir: () => home,
      makeDir: () => {
        throw new Error('EACCES')
      },
      warn: () => undefined
    })
    expect(result.outcome).toBe('skipped')
    expect(result.reason).toMatch(/could not write/)
  })
})
