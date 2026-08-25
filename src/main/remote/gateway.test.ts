import { describe, expect, it, vi } from 'vitest'
import { REMOTE_COMMANDS, type RemoteWorkspaceSummary } from '@shared/remote/protocol'
import type { WorkspaceSummary } from '@main/appIpc'
import { runRemoteCommand, type RemoteGatewayHost } from './gateway'

function host(overrides: Partial<RemoteGatewayHost> = {}): RemoteGatewayHost {
  return {
    listWorkspaces: () => [
      {
        workspaceId: 'w1',
        name: 'Paradiso',
        profileId: 'p1',
        active: true,
        agents: []
      }
    ],
    listProfiles: () => [{ id: 'p1', name: 'Profile', repoPath: '/repo' }],
    startWorkspace: vi.fn(),
    stopWorkspace: vi.fn(),
    answerQuestion: vi.fn(),
    userMessage: vi.fn(),
    assignGoal: vi.fn(),
    ...overrides
  }
}

describe('runRemoteCommand', () => {
  it('lists workspaces and profiles', async () => {
    const h = host()
    expect(await runRemoteCommand(h, 'workspaces:list', undefined)).toMatchObject({
      ok: true,
      result: [{ workspaceId: 'w1' }]
    })
    expect(await runRemoteCommand(h, 'profiles:list', undefined)).toMatchObject({
      ok: true,
      result: [{ id: 'p1' }]
    })
  })

  it('starts a workspace by profileId', async () => {
    const start = vi.fn()
    const result = await runRemoteCommand(host({ startWorkspace: start }), 'workspaces:start', 'p1')
    expect(result).toEqual({ ok: true, result: { started: 'p1' } })
    expect(start).toHaveBeenCalledWith('p1')
  })

  it('stops a workspace by workspaceId', async () => {
    const stop = vi.fn()
    const result = await runRemoteCommand(host({ stopWorkspace: stop }), 'workspaces:stop', 'w1')
    expect(result).toEqual({ ok: true, result: { stopped: 'w1' } })
    expect(stop).toHaveBeenCalledWith('w1')
  })

  it('refuses start/stop without an argument instead of throwing', async () => {
    expect(await runRemoteCommand(host(), 'workspaces:start', undefined)).toMatchObject({ ok: false })
    expect(await runRemoteCommand(host(), 'workspaces:stop', undefined)).toMatchObject({ ok: false })
  })

  it('turns a host failure into a gateway error, not a crash', async () => {
    const result = await runRemoteCommand(
      host({
        startWorkspace: () => {
          throw new Error('no repo path')
        }
      }),
      'workspaces:start',
      'p1'
    )
    expect(result).toEqual({ ok: false, error: 'no repo path' })
  })

  it('starts with a goal from structured args (H2) — profileId may travel either way', async () => {
    const start = vi.fn()
    const h = host({ startWorkspace: start })

    const viaArgs = await runRemoteCommand(h, 'workspaces:start', undefined, {
      profileId: 'p1',
      goal: '  Fix the login bug  '
    })
    expect(viaArgs).toEqual({ ok: true, result: { started: 'p1', goal: true } })
    expect(start).toHaveBeenCalledWith('p1', 'Fix the login bug')

    // Old client shape: profileId in `arg`, no goal — still one-argument call.
    const viaArg = await runRemoteCommand(h, 'workspaces:start', 'p1', { goal: '   ' })
    expect(viaArg).toEqual({ ok: true, result: { started: 'p1' } })
    expect(start).toHaveBeenLastCalledWith('p1')
  })

  it('answers a question through the host (H1) and refuses incomplete args', async () => {
    const answer = vi.fn()
    const h = host({ answerQuestion: answer })
    const args = { workspaceId: 'w1', agentId: 'a1', questionId: 'q1', text: 'Use bcrypt.' }

    const result = await runRemoteCommand(h, 'answer_question', undefined, args)
    expect(result).toEqual({ ok: true, result: { answered: 'q1', agentId: 'a1' } })
    expect(answer).toHaveBeenCalledWith(args)

    for (const missing of ['workspaceId', 'agentId', 'questionId', 'text'] as const) {
      const broken = { ...args, [missing]: '  ' }
      expect(await runRemoteCommand(h, 'answer_question', undefined, broken)).toMatchObject({
        ok: false
      })
    }
    expect(await runRemoteCommand(h, 'answer_question', undefined, undefined)).toMatchObject({
      ok: false
    })
    expect(answer).toHaveBeenCalledTimes(1)
  })

  it('turns an answer the host refuses into a gateway error the client can show', async () => {
    const result = await runRemoteCommand(
      host({
        answerQuestion: () => {
          throw new Error('that question is already answered')
        }
      }),
      'answer_question',
      undefined,
      { workspaceId: 'w1', agentId: 'a1', questionId: 'q1', text: 'x' }
    )
    expect(result).toEqual({ ok: false, error: 'that question is already answered' })
  })

  it('delivers a user_message through the host (D2) and refuses incomplete args', async () => {
    const steer = vi.fn()
    const h = host({ userMessage: steer })

    const result = await runRemoteCommand(h, 'user_message', undefined, {
      workspaceId: 'w1',
      text: 'Focus on the parser first.'
    })
    expect(result).toEqual({ ok: true, result: { delivered: 'w1' } })
    expect(steer).toHaveBeenCalledWith({ workspaceId: 'w1', text: 'Focus on the parser first.' })

    const targeted = await runRemoteCommand(h, 'user_message', undefined, {
      workspaceId: 'w1',
      text: 'Run the login flow.',
      targetAgentId: '  a1  '
    })
    expect(targeted).toEqual({ ok: true, result: { delivered: 'w1' } })
    expect(steer).toHaveBeenCalledWith({
      workspaceId: 'w1',
      text: 'Run the login flow.',
      targetAgentId: 'a1'
    })

    expect(await runRemoteCommand(h, 'user_message', undefined, { text: 'x' })).toMatchObject({
      ok: false
    })
    expect(
      await runRemoteCommand(h, 'user_message', undefined, { workspaceId: 'w1', text: '  ' })
    ).toMatchObject({ ok: false })
    expect(steer).toHaveBeenCalledTimes(2)
  })

  it('assigns a late goal through the host (H2 refill) and refuses incomplete args', async () => {
    const assign = vi.fn()
    const h = host({ assignGoal: assign })

    const result = await runRemoteCommand(h, 'workspaces:goal', undefined, {
      workspaceId: 'w1',
      goal: '  Fix the login bug  '
    })
    expect(result).toEqual({ ok: true, result: { goal: 'w1' } })
    expect(assign).toHaveBeenCalledWith({ workspaceId: 'w1', goal: 'Fix the login bug' })

    expect(await runRemoteCommand(h, 'workspaces:goal', undefined, { goal: 'x' })).toMatchObject({
      ok: false
    })
    expect(
      await runRemoteCommand(h, 'workspaces:goal', undefined, { workspaceId: 'w1', goal: '  ' })
    ).toMatchObject({ ok: false })
    expect(assign).toHaveBeenCalledTimes(1)
  })

  it('turns a refused late goal into a gateway error the client can show', async () => {
    const result = await runRemoteCommand(
      host({
        assignGoal: () => {
          throw new Error('this run already has a goal')
        }
      }),
      'workspaces:goal',
      undefined,
      { workspaceId: 'w1', goal: 'Second goal' }
    )
    expect(result).toEqual({ ok: false, error: 'this run already has a goal' })
  })

  it('the exposed surface is exactly seven read/lifecycle/steer verbs — no settings, no editing', () => {
    // A guard against scope creep: this list is the whole remote surface.
    expect([...REMOTE_COMMANDS].sort()).toEqual([
      'answer_question',
      'profiles:list',
      'user_message',
      'workspaces:goal',
      'workspaces:list',
      'workspaces:start',
      'workspaces:stop'
    ])
    // S4/S1: the panel's run-folder channel is deliberately NOT mirrored here.
    // Opening a directory means something on the machine the app runs on and
    // nothing at all in a paired browser, so the phone never gets a verb for it.
    expect([...REMOTE_COMMANDS]).not.toContain('workspaces:openRunFolder')
  })

  it('S4: forwards the panel summary as it stands — the board rides workspaces:list', async () => {
    // The gateway carries whatever the WorkspaceDirectory produces, so the
    // phone gets the task board without a verb of its own. Typed from the
    // panel's own summary on purpose: if the two structs ever drift, this stops
    // compiling instead of silently shipping a half-empty card.
    const fromPanel: WorkspaceSummary = {
      workspaceId: 'w1',
      name: 'Paradiso',
      profileId: 'p1',
      active: true,
      agents: [
        {
          agentId: 'a1',
          name: 'Caronte',
          roleId: 'worker',
          roleColor: '#2f7d6d',
          state: 'working'
        }
      ],
      tasks: [
        {
          taskId: 'task-1',
          subject: 'Build the parser',
          status: 'in_progress',
          ownerAgentId: 'a1',
          blockedBy: [],
          ready: false
        }
      ]
    }
    const forwarded: RemoteWorkspaceSummary[] = [fromPanel]
    const result = await runRemoteCommand(
      host({ listWorkspaces: () => forwarded }),
      'workspaces:list',
      undefined
    )
    expect(result).toMatchObject({
      ok: true,
      result: [{ workspaceId: 'w1', tasks: [{ taskId: 'task-1', ready: false }] }]
    })
  })
})
