import { describe, expect, it } from 'vitest'
import type { AgentInstanceInfo } from '@shared/agents'
import { buildAgentResumeState, RESUME_SCROLLBACK_CHARS } from './resumeState'

function info(overrides: Partial<AgentInstanceInfo> = {}): AgentInstanceInfo {
  return {
    id: 'codex-01',
    profileId: 'default',
    workspaceSessionId: 'session-1',
    name: 'Nesso',
    provider: 'codex',
    model: '',
    role: 'Subagent · Backend',
    kind: 'sub',
    mode: 'task',
    yolo: false,
    taskId: 't-1',
    workingDir: '/repo',
    worktree: '/repo/.vertragus-worktrees/session-1/codex-01',
    branch: 'vertragus/session-1/codex-01',
    status: 'running',
    startedAt: 100,
    ...overrides
  }
}

describe('buildAgentResumeState', () => {
  it('keeps the resume-relevant info and drops the bulky preflight report', () => {
    const state = buildAgentResumeState(
      info({ preflight: { checks: [] } as never }),
      'output',
      123
    )

    expect(state.capturedAt).toBe(123)
    expect(state.info).toMatchObject({
      id: 'codex-01',
      taskId: 't-1',
      worktree: '/repo/.vertragus-worktrees/session-1/codex-01',
      branch: 'vertragus/session-1/codex-01'
    })
    expect(state.info.preflight).toBeUndefined()
  })

  it('strips ANSI, redacts secrets and caps the scrollback tail', () => {
    const secretLine = 'Authorization: Bearer abc123def456ghi789'
    const filler = 'x'.repeat(RESUME_SCROLLBACK_CHARS + 5_000)
    const state = buildAgentResumeState(
      info(),
      `${filler}\n\u001b[31mrot\u001b[0m ${secretLine}`,
      1
    )

    expect(state.scrollbackTail).not.toContain('\u001b')
    expect(state.scrollbackTail).toContain('rot')
    expect(state.scrollbackTail).toContain('Bearer [redacted]')
    expect(state.scrollbackTail).not.toContain('abc123def456ghi789')
    expect(state.scrollbackTail.length).toBeLessThanOrEqual(RESUME_SCROLLBACK_CHARS + 50)
    expect(state.scrollbackTail).toContain('...(gekürzt)...')
  })
})
