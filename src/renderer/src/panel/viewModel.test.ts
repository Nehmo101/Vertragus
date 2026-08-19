import { describe, expect, it } from 'vitest'
import type { WorkspaceAgentSummary, WorkspaceSummary } from '../../../preload'
import { translator } from '../i18n'
import {
  agentCanCloseWindow,
  agentCountLabel,
  agentDotClass,
  agentDotKind,
  agentNeedsAttention,
  agentRowClass,
  agentStatusLine,
  agentTooltip,
  areAllWorkspacesExpanded,
  errorText,
  EXPAND_ALL_WORKSPACES,
  expandedWorkspaceId,
  filterWorkspaces,
  isWorkspaceExpanded,
  nextExpandAllSelection,
  nextSelectedProfileId,
  nextSelectedWorkspaceId,
  orderWorkspaces,
  resolveSelectedProfileId,
  shouldFocusWorkspaceOnToggle,
  workspaceCardClass,
  workspaceCountByProfile,
  workspaceHasWaitingSubagent,
  workspaceNeedsAttention,
  workspacePlaceTooltip,
  workspaceTooltip
} from './viewModel'

/** The authored language — the assertions below read as the real UI reads. */
const t = translator('de')
const en = translator('en')

function agent(overrides: Partial<WorkspaceAgentSummary> = {}): WorkspaceAgentSummary {
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

function workspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    workspaceId: 'w1',
    name: 'Paradiso',
    profileId: 'p1',
    active: true,
    agents: [agent()],
    ...overrides
  }
}

describe('agent dots', () => {
  it('pulses bronze for the orchestrator and verdigris for everyone else', () => {
    expect(agentDotKind(agent({ roleId: 'orchestrator' }))).toBe('working-orchestrator')
    expect(agentDotKind(agent())).toBe('working')
    expect(agentDotClass(agent({ roleId: 'orchestrator' }))).toBe(
      'panel-dot is-working is-orchestrator'
    )
  })

  it('goes matt as soon as the agent is not working', () => {
    expect(agentDotKind(agent({ state: 'waiting' }))).toBe('idle')
    expect(agentDotKind(agent({ state: 'stopped', roleId: 'orchestrator' }))).toBe('idle')
    expect(agentDotClass(agent({ state: 'waiting' }))).toBe('panel-dot is-idle')
  })
})

describe('agent status line', () => {
  it('reads "<Rolle> · <Notiz>" when the host supplies a note', () => {
    expect(agentStatusLine(t, agent({ roleLabel: 'Orchestrator', statusText: 'plant' }))).toBe(
      'Orchestrator · plant'
    )
    expect(agentStatusLine(t, agent({ statusText: 'T-142' }))).toBe('Worker · T-142')
  })

  it('never renders an empty status — the state itself is the fallback', () => {
    expect(agentStatusLine(t, agent({ roleLabel: 'Reviewer', state: 'waiting' }))).toBe(
      'Reviewer · wartet'
    )
    expect(agentStatusLine(t, agent({ statusText: '   ' }))).toBe('Worker · arbeitet')
    expect(agentStatusLine(t, agent({ state: 'stopped' }))).toBe('Worker · beendet')
  })

  it('keeps the last task on a finished or waiting agent', () => {
    expect(agentStatusLine(t, agent({ state: 'stopped', statusText: 'T-142' }))).toBe(
      'Worker · beendet · T-142'
    )
    expect(agentStatusLine(t, agent({ state: 'waiting', statusText: 'T-142' }))).toBe(
      'Worker · wartet · T-142'
    )
    expect(agentStatusLine(en, agent({ state: 'stopped', statusText: 'T-142' }))).toBe(
      'Worker · stopped · T-142'
    )
  })

  it('speaks the language it is handed, not the one it was authored in', () => {
    expect(agentStatusLine(en, agent({ roleLabel: 'Reviewer', state: 'waiting' }))).toBe(
      'Reviewer · waiting'
    )
    expect(agentStatusLine(en, agent({ state: 'stopped' }))).toBe('Worker · stopped')
  })

  it('falls back to the raw role id when the host has no label', () => {
    expect(agentStatusLine(t, agent({ roleLabel: undefined, roleId: 'bugjaeger' }))).toBe(
      'bugjaeger · arbeitet'
    )
  })
})

describe('dismissing a finished agent window', () => {
  it('offers ✕ only while a stopped agent still has an open window', () => {
    expect(agentCanCloseWindow(agent({ state: 'stopped', windowOpen: true }))).toBe(true)
    expect(agentCanCloseWindow(agent({ state: 'stopped' }))).toBe(false)
    expect(agentCanCloseWindow(agent({ state: 'working', windowOpen: true }))).toBe(false)
    expect(t('panel.closeAgentWindow', { agent: 'Caronte' })).toMatch(/schließen/)
    expect(en('panel.closeAgentWindow', { agent: 'Caronte' })).toMatch(/Close/)
  })
})

describe('tooltips', () => {
  it('reveals who a Commedia figure is, numbered clones included', () => {
    expect(agentTooltip(t, agent({ name: 'Caronte' }))).toMatch(/Fährmann/)
    expect(agentTooltip(t, agent({ name: 'Virgilio 2' }))).toMatch(/Führer/)
    expect(agentTooltip(t, agent({ name: 'Nobody' }))).toBeUndefined()
  })

  it('appends the agent\'s current task to its hover card', () => {
    const withTask = agent({ statusText: 'Parser-Bug in tokenizer.ts fixen' })
    expect(agentTooltip(t, withTask)).toMatch(/Fährmann/)
    expect(agentTooltip(t, withTask)).toContain(
      'Aktuelle Aufgabe: Parser-Bug in tokenizer.ts fixen'
    )
    expect(agentTooltip(en, withTask)).toContain(
      'Current task: Parser-Bug in tokenizer.ts fixen'
    )
    // Whitespace is not a task — the blurb stands alone.
    expect(agentTooltip(t, agent({ statusText: '   ' }))).not.toContain('Aufgabe')
    // A name outside the roster still gets a card once there is a task.
    expect(agentTooltip(t, agent({ name: 'Nobody', statusText: 'Docs schreiben' }))).toBe(
      'Aktuelle Aufgabe: Docs schreiben'
    )
  })

  it('labels the orchestrator\'s task line as delegated, not as its own', () => {
    const orchestrator = agent({
      name: 'Virgilio',
      roleId: 'orchestrator',
      statusText: 'Parser-Bug fixen'
    })
    expect(agentTooltip(t, orchestrator)).toContain('Zuletzt delegiert: Parser-Bug fixen')
    expect(agentTooltip(en, orchestrator)).toContain('Last delegated: Parser-Bug fixen')
  })

  it('reveals what kind of place a workspace is, cycle suffix included', () => {
    expect(workspacePlaceTooltip(workspace())).toMatch(/Himmelssphären/)
    expect(workspacePlaceTooltip(workspace({ name: 'Paradiso II' }))).toMatch(/Himmelssphären/)
    // A name the roster does not know gets no card at all — a box repeating the
    // word under the cursor is worse than nothing.
    expect(workspacePlaceTooltip(workspace({ name: 'Eigenbau' }))).toBeUndefined()
    expect(workspaceTooltip(t, workspace({ name: 'Eigenbau' }))).toBeUndefined()
  })

  it('appends the current task to the workspace hover card once one exists', () => {
    const withTask = workspace({ taskText: 'Parser-Bug in tokenizer.ts fixen' })
    expect(workspaceTooltip(t, withTask)).toMatch(/Himmelssphären/)
    expect(workspaceTooltip(t, withTask)).toContain(
      'Aktuelle Aufgabe: Parser-Bug in tokenizer.ts fixen'
    )
    expect(workspaceTooltip(en, withTask)).toContain(
      'Current task: Parser-Bug in tokenizer.ts fixen'
    )
    // Whitespace is not a task — the blurb stands alone.
    expect(workspaceTooltip(t, workspace({ taskText: '   ' }))).not.toContain('Aufgabe')
    // An unknown name with a task still gets a card — the task carries it.
    expect(workspaceTooltip(t, workspace({ name: 'Eigenbau', taskText: 'Docs schreiben' }))).toBe(
      'Aktuelle Aufgabe: Docs schreiben'
    )
  })
})

describe('cards', () => {
  it('marks an active workspace and counts its agents in German', () => {
    expect(workspaceCardClass(workspace())).toBe('panel-card is-active')
    expect(workspaceCardClass(workspace({ active: false }))).toBe('panel-card')
    expect(agentCountLabel(t, workspace())).toBe('1 Agent')
    expect(agentCountLabel(t, workspace({ agents: [agent(), agent()] }))).toBe('2 Agenten')
    expect(agentCountLabel(t, workspace({ agents: [] }))).toBe('0 Agenten')
    expect(agentCountLabel(en, workspace())).toBe('1 agent')
    expect(agentCountLabel(en, workspace({ agents: [agent(), agent()] }))).toBe('2 agents')
  })

  it('sorts live workspaces above finished ones without reordering peers', () => {
    const finished = workspace({ workspaceId: 'w0', active: false })
    const live = workspace({ workspaceId: 'w1' })
    const live2 = workspace({ workspaceId: 'w2' })
    expect(orderWorkspaces([finished, live, live2]).map((entry) => entry.workspaceId)).toEqual([
      'w1',
      'w2',
      'w0'
    ])
  })
})

describe('attention blink', () => {
  const orch = agent({
    agentId: 'orch',
    roleId: 'orchestrator',
    roleLabel: 'Orchestrator',
    pendingQuestion: 'which provider?'
  })
  const workerWaiting = agent({
    agentId: 'w',
    roleId: 'worker',
    pendingQuestion: 'which db?'
  })
  const workerIdle = agent({ agentId: 'w2', roleId: 'worker' })

  it('pulses the workspace when only the orchestrator waits on the user', () => {
    const card = workspace({ agents: [orch, workerIdle] })
    expect(workspaceNeedsAttention(card)).toBe(true)
    expect(workspaceCardClass(card)).toBe('panel-card is-active needs-attention')
    expect(agentNeedsAttention(orch)).toBe(false)
    expect(agentRowClass(orch)).toBe('panel-agent')
  })

  it('pulses the subagent row instead when a worker is waiting', () => {
    const card = workspace({ agents: [orch, workerWaiting] })
    expect(workspaceNeedsAttention(card)).toBe(false)
    expect(workspaceCardClass(card)).toBe('panel-card is-active')
    expect(agentNeedsAttention(workerWaiting)).toBe(true)
    expect(agentRowClass(workerWaiting)).toBe('panel-agent needs-attention')
  })

  it('ignores blank pending questions', () => {
    const blank = agent({ roleId: 'orchestrator', pendingQuestion: '   ' })
    expect(workspaceNeedsAttention(workspace({ agents: [blank] }))).toBe(false)
    expect(agentNeedsAttention(agent({ pendingQuestion: '   ' }))).toBe(false)
  })

  it('hints on the collapsed card only while a subagent row would blink', () => {
    expect(workspaceHasWaitingSubagent(workspace({ agents: [orch, workerWaiting] }))).toBe(true)
    // An orchestrator question pulses the card itself — no extra dot.
    expect(workspaceHasWaitingSubagent(workspace({ agents: [orch, workerIdle] }))).toBe(false)
    expect(workspaceHasWaitingSubagent(workspace({ agents: [] }))).toBe(false)
    expect(t('panel.subagentWaiting')).toBe('Ein Subagent wartet auf Rückmeldung')
    expect(en('panel.subagentWaiting')).toBe('A subagent is waiting for your reply')
  })
})

describe('profile workspace filter', () => {
  const a1 = workspace({ workspaceId: 'w1', profileId: 'p1' })
  const a2 = workspace({ workspaceId: 'w2', profileId: 'p1', active: false })
  const b1 = workspace({ workspaceId: 'w3', profileId: 'p2', active: false })

  it('counts workspaces per profileId', () => {
    const counts = workspaceCountByProfile([a1, a2, b1])
    expect(counts.get('p1')).toBe(2)
    expect(counts.get('p2')).toBe(1)
    expect(counts.get('missing')).toBeUndefined()
    expect(workspaceCountByProfile([])).toEqual(new Map())
  })

  it('filters to one profile or passes the full list through', () => {
    expect(filterWorkspaces([a1, a2, b1], null).map((entry) => entry.workspaceId)).toEqual([
      'w1',
      'w2',
      'w3'
    ])
    expect(filterWorkspaces([a1, a2, b1], 'p1').map((entry) => entry.workspaceId)).toEqual([
      'w1',
      'w2'
    ])
    expect(filterWorkspaces([a1, a2, b1], 'gone')).toEqual([])
  })

  it('toggles the selected profile and clears a vanished one', () => {
    expect(nextSelectedProfileId(null, 'p1')).toBe('p1')
    expect(nextSelectedProfileId('p1', 'p1')).toBeNull()
    expect(nextSelectedProfileId('p1', 'p2')).toBe('p2')
    // Zero workspaces still toggles — the empty state is a truthful filter.
    expect(nextSelectedProfileId('p1', 'p1')).toBeNull()
    expect(resolveSelectedProfileId([{ id: 'p1' }, { id: 'p2' }], 'p1')).toBe('p1')
    expect(resolveSelectedProfileId([{ id: 'p2' }], 'p1')).toBeNull()
    expect(resolveSelectedProfileId([{ id: 'p1' }], null)).toBeNull()
  })

  it('keeps card expansion coherent against the filtered list', () => {
    const filtered = filterWorkspaces([a1, a2, b1], 'p2')
    expect(expandedWorkspaceId(filtered, undefined)).toBeNull()
    expect(expandedWorkspaceId(filtered, 'w1')).toBeNull()
    expect(nextSelectedWorkspaceId(filtered, undefined, 'w3')).toBe('w3')
    expect(expandedWorkspaceId(filtered, 'w3')).toBe('w3')
  })
})

describe('expanded workspace selection', () => {
  const live = workspace({ workspaceId: 'w1', active: true })
  const other = workspace({ workspaceId: 'w2', active: false, agents: [agent(), agent()] })
  const empty = workspace({ workspaceId: 'w3', active: false, agents: [] })

  it('defaults to the active workspace until the user clicks', () => {
    expect(expandedWorkspaceId([live, other], undefined)).toBe('w1')
    expect(expandedWorkspaceId([other], undefined)).toBeNull()
    expect(expandedWorkspaceId([], undefined)).toBeNull()
  })

  it('honours an explicit selection and collapses on toggle', () => {
    expect(expandedWorkspaceId([live, other], 'w2')).toBe('w2')
    expect(nextSelectedWorkspaceId([live, other], undefined, 'w1')).toBeNull()
    expect(nextSelectedWorkspaceId([live, other], undefined, 'w2')).toBe('w2')
    expect(nextSelectedWorkspaceId([live, other], 'w2', 'w2')).toBeNull()
    expect(nextSelectedWorkspaceId([live, other], null, 'w1')).toBe('w1')
    expect(expandedWorkspaceId([live, other], null)).toBeNull()
  })

  it('falls back when the selected workspace disappears', () => {
    expect(expandedWorkspaceId([live, other], 'gone')).toBe('w1')
    expect(expandedWorkspaceId([other], 'gone')).toBeNull()
    // After a collapse, a vanished list stays collapsed — no phantom expand.
    expect(expandedWorkspaceId([], null)).toBeNull()
  })

  it('still expands a card whose agent list is empty', () => {
    expect(expandedWorkspaceId([empty, live], 'w3')).toBe('w3')
    expect(empty.agents).toEqual([])
    expect(t('panel.noAgents')).toBe('Noch keine Agenten.')
    expect(en('panel.noAgents')).toBe('No agents yet.')
  })

  it('expands every card via the section-header sentinel', () => {
    expect(areAllWorkspacesExpanded(undefined)).toBe(false)
    expect(areAllWorkspacesExpanded(EXPAND_ALL_WORKSPACES)).toBe(true)
    expect(nextExpandAllSelection(undefined)).toBe(EXPAND_ALL_WORKSPACES)
    expect(nextExpandAllSelection(EXPAND_ALL_WORKSPACES)).toBeNull()
    expect(isWorkspaceExpanded([live, other], EXPAND_ALL_WORKSPACES, 'w1')).toBe(true)
    expect(isWorkspaceExpanded([live, other], EXPAND_ALL_WORKSPACES, 'w2')).toBe(true)
    expect(isWorkspaceExpanded([live, other], undefined, 'w1')).toBe(true)
    expect(isWorkspaceExpanded([live, other], undefined, 'w2')).toBe(false)
    // Leaving expand-all by clicking a card selects that one alone.
    expect(nextSelectedWorkspaceId([live, other], EXPAND_ALL_WORKSPACES, 'w2')).toBe('w2')
    expect(t('panel.expandAllWorkspaces')).toBe('Alle Workspaces aufklappen')
    expect(en('panel.collapseAllWorkspaces')).toBe('Collapse all workspaces')
  })

  it('focuses CLI windows only when an active card is opened or selected', () => {
    expect(shouldFocusWorkspaceOnToggle('w1', live)).toBe(true)
    expect(shouldFocusWorkspaceOnToggle(null, live)).toBe(false)
    expect(shouldFocusWorkspaceOnToggle(undefined, live)).toBe(false)
    expect(shouldFocusWorkspaceOnToggle(EXPAND_ALL_WORKSPACES, live)).toBe(false)
    expect(shouldFocusWorkspaceOnToggle('w2', other)).toBe(false)
    expect(shouldFocusWorkspaceOnToggle('w1', other)).toBe(false)
  })
})

describe('errorText', () => {
  it('strips the Electron IPC wrapper and keeps the message', () => {
    expect(
      errorText(
        new Error(
          "Error invoking remote method 'workspaces:start': Error: Workspace-Manager ist noch nicht verdrahtet."
        )
      )
    ).toBe('Workspace-Manager ist noch nicht verdrahtet.')
    expect(errorText(new Error('kaputt'))).toBe('kaputt')
    expect(errorText('kaputt')).toBe('kaputt')
  })
})
