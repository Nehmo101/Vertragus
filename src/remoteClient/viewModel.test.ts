import { describe, expect, it } from 'vitest'
import type { RemoteAgentSummary, RemoteWorkspaceSummary } from '@shared/remote/protocol'
import {
  agentDotKind,
  agentNeedsAttention,
  agentStatusLine,
  endedWorkspaces,
  everyCardExpanded,
  hasActiveWorkspace,
  isWorkspaceExpanded,
  liveWorkspaces,
  orderWorkspaces,
  setAllExpanded,
  workspaceGoalLine,
  workspaceNeedsAttention
} from './viewModel'

function agent(overrides: Partial<RemoteAgentSummary> = {}): RemoteAgentSummary {
  return {
    agentId: 'a1',
    name: 'Caronte',
    roleId: 'worker',
    roleLabel: 'Worker',
    roleColor: '#2f7d6d',
    state: 'working',
    ...overrides
  }
}

function workspace(overrides: Partial<RemoteWorkspaceSummary> = {}): RemoteWorkspaceSummary {
  return {
    workspaceId: 'w1',
    name: 'Paradiso',
    profileId: 'p1',
    active: true,
    agents: [agent()],
    ...overrides
  }
}

const labels = { working: 'arbeitet', waiting: 'wartet', stopped: 'beendet' }

describe('orderWorkspaces', () => {
  it('puts live cards above ended ones', () => {
    const ended = workspace({ workspaceId: 'old', active: false })
    const live = workspace({ workspaceId: 'now', active: true })
    expect(orderWorkspaces([ended, live]).map((entry) => entry.workspaceId)).toEqual(['now', 'old'])
  })

  it('is a total order, so a reshuffled push cannot move a row', () => {
    const items = [
      workspace({ workspaceId: 'w1', name: 'Purgatorio' }),
      workspace({ workspaceId: 'w2', name: 'inferno' }),
      workspace({ workspaceId: 'w3', name: 'Paradiso' }),
      workspace({ workspaceId: 'w4', name: 'Limbo', active: false })
    ]
    const order = orderWorkspaces(items).map((entry) => entry.workspaceId)
    expect(order).toEqual(['w2', 'w3', 'w1', 'w4'])
    expect(orderWorkspaces([...items].reverse()).map((entry) => entry.workspaceId)).toEqual(order)
  })

  it('breaks a shared name on the workspace id', () => {
    const items = [
      workspace({ workspaceId: 'b', name: 'Paradiso' }),
      workspace({ workspaceId: 'a', name: 'Paradiso' })
    ]
    expect(orderWorkspaces(items).map((entry) => entry.workspaceId)).toEqual(['a', 'b'])
    expect(orderWorkspaces([...items].reverse()).map((entry) => entry.workspaceId)).toEqual([
      'a',
      'b'
    ])
  })

  it('leaves the source array alone', () => {
    const items = [
      workspace({ workspaceId: 'z', name: 'Zeta' }),
      workspace({ workspaceId: 'a', name: 'Alpha' })
    ]
    orderWorkspaces(items)
    expect(items.map((entry) => entry.workspaceId)).toEqual(['z', 'a'])
  })
})

describe('expand all / collapse all', () => {
  const items = [
    workspace({ workspaceId: 'w1', active: true }),
    workspace({ workspaceId: 'w2', active: false })
  ]

  it('writes an explicit decision per card so a push cannot re-open one', () => {
    expect(setAllExpanded(items, false)).toEqual({ w1: false, w2: false })
    expect(setAllExpanded(items, true)).toEqual({ w1: true, w2: true })
    expect(setAllExpanded([], true)).toEqual({})
  })

  it('knows which way the list-wide toggle should go', () => {
    expect(everyCardExpanded(items, setAllExpanded(items, true))).toBe(true)
    expect(everyCardExpanded(items, setAllExpanded(items, false))).toBe(false)
    // Defaults count: the live card is open without an entry of its own.
    expect(everyCardExpanded(items, {})).toBe(false)
    expect(everyCardExpanded([items[0]!], {})).toBe(true)
    expect(everyCardExpanded([], {})).toBe(false)
  })
})

describe('live vs ended', () => {
  it('splits the list without dropping either side', () => {
    const items = [
      workspace({ workspaceId: 'a', active: true }),
      workspace({ workspaceId: 'b', active: false })
    ]
    expect(hasActiveWorkspace(items)).toBe(true)
    expect(liveWorkspaces(items)).toHaveLength(1)
    expect(endedWorkspaces(items)).toHaveLength(1)
    expect(hasActiveWorkspace(endedWorkspaces(items))).toBe(false)
  })
})

describe('attention', () => {
  it('flags a user question and a waiting subagent', () => {
    expect(
      workspaceNeedsAttention(
        workspace({ userQuestion: { questionId: 'q', question: 'Ship it?' } })
      )
    ).toBe(true)
    expect(
      agentNeedsAttention(agent({ pendingQuestion: 'Use bcrypt?' }))
    ).toBe(true)
    expect(agentNeedsAttention(agent({ roleId: 'orchestrator', pendingQuestion: 'Go?' }))).toBe(
      false
    )
  })
})

describe('expansion', () => {
  it('defaults live and attention cards open, ended cards shut', () => {
    expect(isWorkspaceExpanded(workspace({ active: true }), {})).toBe(true)
    expect(isWorkspaceExpanded(workspace({ active: false }), {})).toBe(false)
    expect(
      isWorkspaceExpanded(
        workspace({
          active: false,
          userQuestion: { questionId: 'q', question: 'Still there?' }
        }),
        {}
      )
    ).toBe(true)
    expect(isWorkspaceExpanded(workspace({ active: true }), { w1: false })).toBe(false)
  })
})

describe('agent status line', () => {
  it('reads role · task while working, and keeps the task after stop', () => {
    expect(agentStatusLine(agent({ statusText: 'T-142' }), labels)).toBe('Worker · T-142')
    expect(agentStatusLine(agent({ state: 'stopped', statusText: 'T-142' }), labels)).toBe(
      'Worker · beendet · T-142'
    )
    expect(agentDotKind(agent({ roleId: 'orchestrator' }))).toBe('working-orchestrator')
    expect(agentDotKind(agent({ state: 'waiting' }))).toBe('idle')
  })
})

describe('goal line', () => {
  const copy = { goal: (goal: string) => `Ziel: ${goal}`, noGoal: 'Kein Ziel' }
  it('quotes a delivered goal and tells the truth on a bare start', () => {
    expect(workspaceGoalLine(workspace({ goalText: 'Fix login' }), copy)).toBe('Ziel: Fix login')
    expect(workspaceGoalLine(workspace({ active: true }), copy)).toBe('Kein Ziel')
    expect(workspaceGoalLine(workspace({ active: false }), copy)).toBeUndefined()
  })
})

describe('the task board on the wire', () => {
  // S4 added `tasks` to the desktop summary and the gateway forwards that
  // summary verbatim, so the board reaches the phone without a verb of its own.
  // `RemoteWorkspaceSummary` now DECLARES the field, which is what makes these
  // assertions mean something: the object below is typed, so a helper that
  // rebuilt its cards field by field — the natural way to lose the board —
  // would have to drop a member the shared type names.
  const withBoard: RemoteWorkspaceSummary = workspace({
    goalText: 'Fix login',
    tasks: [
      { taskId: 'task-1', subject: 'Build the parser', status: 'completed', blockedBy: [], ready: false },
      {
        taskId: 'task-2',
        subject: 'Wire the panel',
        status: 'pending',
        ownerAgentId: 'a1',
        blockedBy: ['task-1'],
        ready: true
      }
    ]
  })

  it('survives the helpers that reshape the list', () => {
    const [ordered] = orderWorkspaces([workspace({ workspaceId: 'old', active: false }), withBoard])
    expect(ordered?.tasks?.map((task) => task.taskId)).toEqual(['task-1', 'task-2'])
    expect(liveWorkspaces([withBoard])[0]?.tasks).toHaveLength(2)
    expect(liveWorkspaces([withBoard])[0]?.tasks?.[1]).toMatchObject({
      ownerAgentId: 'a1',
      blockedBy: ['task-1'],
      ready: true
    })
  })

  it('changes nothing this client already drew', () => {
    // The client draws no board yet (a deliberate post-1.0 call); carrying the
    // field must therefore stay invisible in every line it does draw.
    expect(workspaceNeedsAttention(withBoard)).toBe(false)
    expect(agentStatusLine(withBoard.agents[0]!, labels)).toBe('Worker · arbeitet')
    expect(
      workspaceGoalLine(withBoard, { goal: (goal) => `Ziel: ${goal}`, noGoal: 'Kein Ziel' })
    ).toBe('Ziel: Fix login')
  })
})
