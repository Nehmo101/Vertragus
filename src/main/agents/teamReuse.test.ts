import { describe, expect, it } from 'vitest'
import type { AgentInstanceInfo } from '@shared/agents'
import { agentIdentityInstruction, isReusableTeamMember } from './teamReuse'

const teamAgent: AgentInstanceInfo = {
  id: 'sub-02',
  name: 'Nesso',
  provider: 'cursor',
  profileId: 'profile-a',
  workspaceSessionId: 'session-a',
  model: 'composer',
  role: 'Subagent · worker',
  kind: 'sub',
  mode: 'interactive',
  yolo: false,
  teamRole: 'worker',
  workingDir: 'C:\repo',
  status: 'running',
  startedAt: 1
}

describe('profile team reuse', () => {
  it('reuses an untouched matching prestarted pane', () => {
    expect(
      isReusableTeamMember(
        teamAgent,
        { provider: 'cursor', model: 'composer', role: 'worker' },
        { hasPty: true, interactiveUsed: false }
      )
    ).toBe(true)
  })

  it('keeps manually used or differently assigned panes out of automatic dispatch', () => {
    const target = { provider: 'cursor' as const, model: 'composer', role: 'worker' }
    expect(isReusableTeamMember(teamAgent, target, { hasPty: true, interactiveUsed: true })).toBe(false)
    expect(
      isReusableTeamMember(
        { ...teamAgent, teamRole: 'review' },
        target,
        { hasPty: true, interactiveUsed: false }
      )
    ).toBe(false)
  })

  it('never claims a matching pane from another profile or workspace session', () => {
    const target = {
      provider: 'cursor' as const,
      model: 'composer',
      role: 'worker',
      profileId: 'profile-a',
      workspaceSessionId: 'session-a'
    }
    expect(
      isReusableTeamMember(
        { ...teamAgent, profileId: 'profile-b' },
        target,
        { hasPty: true, interactiveUsed: false }
      )
    ).toBe(false)
    expect(
      isReusableTeamMember(
        { ...teamAgent, workspaceSessionId: 'session-b' },
        target,
        { hasPty: true, interactiveUsed: false }
      )
    ).toBe(false)
  })

  it('binds the runtime prompt to the same Commedia name shown in the pane header', () => {
    expect(agentIdentityInstruction('Nesso')).toContain('Dein Name in Vertragus ist Nesso.')
  })
})
