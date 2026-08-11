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
  orderWorkspaces,
  workspaceCardClass,
  workspacePlaceTooltip
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
    expect(workspacePlaceTooltip(workspace())).toMatch(/Himmelssphären/)
    expect(workspacePlaceTooltip(workspace({ name: 'Paradiso II' }))).toMatch(/Himmelssphären/)
    // A name the roster does not know gets no card at all — a box repeating the
    // word under the cursor is worse than nothing.
    expect(workspacePlaceTooltip(workspace({ name: 'Eigenbau' }))).toBeUndefined()
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
