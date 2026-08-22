import { describe, expect, it } from 'vitest'
import type { RemoteAgentSummary, RemoteWorkspaceSummary } from '@shared/remote/protocol'
import {
  advanceSeenLive,
  agentDotKind,
  agentNeedsAttention,
  agentStatusLine,
  everyCardExpanded,
  hasActiveWorkspace,
  isWorkspaceExpanded,
  keepSelectedProfile,
  orderWorkspaces,
  overviewRows,
  rowWorkspaces,
  safeRoleColor,
  setAllExpanded,
  startFormOpen,
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

  it('compares codepoints, not locale collation', () => {
    // The invariant the module claims: the phone and the desktop must produce
    // the SAME order, and ICU collation differs between those two engines. An
    // all-ASCII fixture cannot hold it — codepoint and collation agree there.
    // 'ä' is U+00E4, above every ASCII letter, so codepoint order puts Zeta
    // first and any German collation puts Ärger first.
    const items = [
      workspace({ workspaceId: 'w1', name: 'Zeta' }),
      workspace({ workspaceId: 'w2', name: 'Ärger' })
    ]
    expect(orderWorkspaces(items).map((entry) => entry.name)).toEqual(['Zeta', 'Ärger'])
    // Self-check: if these two ever agreed, the assertion above would be
    // vacuous and would keep passing after a switch to localeCompare.
    expect('ärger'.localeCompare('zeta', 'de')).toBeLessThan(0)
  })
})

describe('the start form', () => {
  it('never folds shut over text the user is still typing', () => {
    // A workspace started from the DESKTOP flips `hasLiveRun` under a form the
    // user is halfway through — the one case where the default must not win.
    expect(startFormOpen(null, true, true)).toBe(true)
    expect(startFormOpen(null, true, false)).toBe(false)
    expect(startFormOpen(null, false, false)).toBe(true)
  })

  it('lets the user’s own decision outrank both', () => {
    expect(startFormOpen(false, false, true)).toBe(false)
    expect(startFormOpen(true, true, false)).toBe(true)
  })
})

describe('the profile picker', () => {
  const profiles = [{ id: 'p1' }, { id: 'p2' }]

  it('keeps a selection that still exists', () => {
    expect(keepSelectedProfile('p2', profiles)).toBe('p2')
  })

  it('drops one the desktop deleted rather than starting against a ghost', () => {
    expect(keepSelectedProfile('gone', profiles)).toBe('p1')
    expect(keepSelectedProfile('gone', [])).toBe('')
    expect(keepSelectedProfile('', profiles)).toBe('p1')
  })
})

describe('role colour from the wire', () => {
  it('passes a hex colour through in every length CSS accepts', () => {
    expect(safeRoleColor('#2f7d6d')).toBe('#2f7d6d')
    expect(safeRoleColor(' #ABC ')).toBe('#ABC')
    expect(safeRoleColor('#2f7d6dcc')).toBe('#2f7d6dcc')
    expect(safeRoleColor('#abcd')).toBe('#abcd')
  })

  it('refuses anything that could carry more than a colour', () => {
    // A custom property is a token stream: everything after the value is
    // substituted too, wherever the sheet uses var(--role).
    expect(safeRoleColor('red; background: url(https://x/1.png)')).toBeUndefined()
    expect(safeRoleColor('var(--bg)')).toBeUndefined()
    expect(safeRoleColor('url(https://x/1.png)')).toBeUndefined()
    expect(safeRoleColor('#2f7d6d;')).toBeUndefined()
    expect(safeRoleColor('#12345')).toBeUndefined()
    expect(safeRoleColor('rgb(0,0,0)')).toBeUndefined()
    expect(safeRoleColor('')).toBeUndefined()
    expect(safeRoleColor(undefined)).toBeUndefined()
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

  const rows = (source: RemoteWorkspaceSummary[]): ReturnType<typeof overviewRows> =>
    overviewRows(source, new Set(), true)

  it('knows which way the list-wide toggle should go', () => {
    expect(everyCardExpanded(rows(items), setAllExpanded(items, true))).toBe(true)
    expect(everyCardExpanded(rows(items), setAllExpanded(items, false))).toBe(false)
    // Defaults count: the live card is open without an entry of its own.
    expect(everyCardExpanded(rows(items), {})).toBe(false)
    expect(everyCardExpanded(rows([items[0]!]), {})).toBe(true)
    expect(everyCardExpanded([], {})).toBe(false)
  })

  it('reads a just-ended card the way the card reads itself', () => {
    const ended = workspace({ workspaceId: 'w1', active: false })
    const watched = overviewRows([ended], new Set(['w1']), false)
    expect(everyCardExpanded(watched, {})).toBe(true)
    // The same workspace, never seen running here, defaults shut.
    expect(everyCardExpanded(overviewRows([ended], new Set(), true), {})).toBe(false)
  })
})

describe('live vs ended', () => {
  it('knows whether anything is running', () => {
    const items = [
      workspace({ workspaceId: 'a', active: true }),
      workspace({ workspaceId: 'b', active: false })
    ]
    expect(hasActiveWorkspace(items)).toBe(true)
    expect(hasActiveWorkspace([items[1]!])).toBe(false)
    expect(hasActiveWorkspace([])).toBe(false)
  })
})

describe('the run that ends while you are watching it', () => {
  const live = workspace({ workspaceId: 'w1', name: 'Paradiso', active: true })
  const ended = workspace({ workspaceId: 'w1', name: 'Paradiso', active: false })
  const other = workspace({ workspaceId: 'w2', name: 'Aaa', active: true })
  const stale = workspace({ workspaceId: 'w9', name: 'Limbo', active: false })

  it('remembers what it has seen running, and forgets what the host drops', () => {
    const seen = advanceSeenLive(new Set(), [live, stale])
    expect([...seen]).toEqual(['w1'])
    // The memory outlives the run: this is the whole point.
    expect([...advanceSeenLive(seen, [ended, stale])]).toEqual(['w1'])
    // …but not the workspace. A recycled id must not inherit a place.
    expect([...advanceSeenLive(seen, [stale])]).toEqual([])
  })

  it('hands back the same set when nothing changed, so a quiet push is free', () => {
    const seen = advanceSeenLive(new Set(), [live])
    expect(advanceSeenLive(seen, [live])).toBe(seen)
    expect(advanceSeenLive(seen, [ended])).toBe(seen)
    expect(advanceSeenLive(seen, [ended, other])).not.toBe(seen)
  })

  it('keeps the card in the same slot AND the same position when the run ends', () => {
    const seen = advanceSeenLive(new Set(), [live, other, stale])
    const before = overviewRows([live, other, stale], seen, false)
    const after = overviewRows([ended, other, stale], seen, false)
    // Same keys, same order, same array — one keyed list is what lets React
    // keep the component (and the card's open answers, and the user's place).
    expect(before.map((row) => row.key)).toEqual(after.map((row) => row.key))
    expect(after.map((row) => row.key)).toEqual(['w2', 'w1', 'ended-divider'])
    const card = after.find((row) => row.key === 'w1')
    expect(card).toMatchObject({ kind: 'workspace', justEnded: true })
    expect(before.find((row) => row.key === 'w1')).toMatchObject({ justEnded: false })
  })

  it('never drops a watched run behind the ended toggle', () => {
    const seen = advanceSeenLive(new Set(), [live])
    const rows = overviewRows([ended, stale], seen, false)
    expect(rows.filter((row) => row.kind === 'workspace').map((row) => row.key)).toEqual(['w1'])
    // The one that was already over when the client opened stays folded away.
    expect(rows.find((row) => row.kind === 'ended-divider')).toMatchObject({ count: 1 })
    const shown = overviewRows([ended, stale], seen, true)
    expect(rowWorkspaces(shown).map((entry) => entry.workspaceId)).toEqual(['w1', 'w9'])
    // …and it is not announced as having just ended: it ended before the user
    // ever opened this client, and a notice that is wrong the first time it is
    // read is worth less than none.
    expect(shown.find((row) => row.key === 'w9')).toMatchObject({ justEnded: false })
    expect(shown.find((row) => row.key === 'w1')).toMatchObject({ justEnded: true })
  })

  it('draws no divider when nothing is folded away', () => {
    const seen = advanceSeenLive(new Set(), [live, other])
    expect(overviewRows([live, other], seen, false).every((row) => row.kind === 'workspace')).toBe(
      true
    )
    expect(overviewRows([], new Set(), true)).toEqual([])
  })

  it('sorts each group on keys a push cannot change', () => {
    const items = [
      workspace({ workspaceId: 'w1', name: 'Purgatorio' }),
      workspace({ workspaceId: 'w2', name: 'inferno' }),
      workspace({ workspaceId: 'w3', name: 'Paradiso' }),
      workspace({ workspaceId: 'w4', name: 'Limbo', active: false })
    ]
    const keys = (source: RemoteWorkspaceSummary[]): string[] =>
      overviewRows(source, new Set(), true).map((row) => row.key)
    expect(keys(items)).toEqual(['w2', 'w3', 'w1', 'ended-divider', 'w4'])
    expect(keys([...items].reverse())).toEqual(keys(items))
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
  it('keeps a card the user is reading open when its run ends under them', () => {
    // Without this the DEFAULT flips from open to shut on the push that ends
    // the run, and a card nobody touched folds itself away mid-read.
    const ended = workspace({ workspaceId: 'w1', active: false })
    expect(isWorkspaceExpanded(ended, {}, true)).toBe(true)
    expect(isWorkspaceExpanded(ended, {}, false)).toBe(false)
    // An explicit decision still outranks it, in both directions.
    expect(isWorkspaceExpanded(ended, { w1: false }, true)).toBe(false)
  })

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
    const [carried] = rowWorkspaces(overviewRows([withBoard], new Set(), false))
    expect(carried?.tasks).toHaveLength(2)
    expect(carried?.tasks?.[1]).toMatchObject({
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
