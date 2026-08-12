import { describe, expect, it } from 'vitest'
import type { WorkspaceAgentSummary, WorkspaceSummary } from '../../../preload'
import { translator } from '../i18n'
import {
  agentCountLabel,
  agentDotClass,
  agentDotKind,
  agentStatusLine,
  agentTooltip,
  errorText,
  expandedWorkspaceId,
  nextSelectedWorkspaceId,
  orderWorkspaces,
  workspaceCardClass,
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

describe('tooltips', () => {
  it('reveals who a Commedia figure is, numbered clones included', () => {
    expect(agentTooltip(agent({ name: 'Caronte' }))).toMatch(/Fährmann/)
    expect(agentTooltip(agent({ name: 'Virgilio 2' }))).toMatch(/Führer/)
    expect(agentTooltip(agent({ name: 'Nobody' }))).toBeUndefined()
  })

  it('reveals what kind of place a workspace is, cycle suffix included', () => {
    expect(workspaceTooltip(t, workspace())).toMatch(/Himmelssphären/)
    expect(workspaceTooltip(t, workspace({ name: 'Paradiso II' }))).toMatch(/Himmelssphären/)
    // An unknown name is still a name — never an empty tooltip.
    expect(workspaceTooltip(t, workspace({ name: 'Eigenbau' }))).toBe('Eigenbau')
  })

  it('appends the current task to the workspace tooltip once one exists', () => {
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
