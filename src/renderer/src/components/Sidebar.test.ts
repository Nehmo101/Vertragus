import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import i18n from '@renderer/i18n'

// The suite asserts the authored German strings; force the de locale.
beforeAll(async () => {
  await i18n.changeLanguage('de')
})
import { workspaceProfileSchema } from '@shared/profile'
import type { OrchestratorSnapshot } from '@shared/orchestrator'
import { useAppStore } from '@renderer/store/useAppStore'
import { useLayoutStore } from '@renderer/store/layoutStore'
import {
  openPublicationCount,
  SIDEBAR_SECTION_ORDER,
  SidebarView
} from '@renderer/components/Sidebar'
import { workspaceRunPresentation } from '@renderer/components/workspaceRunStatus'

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    location: { hash: '' },
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined
  }
})

beforeEach(() => {
  useAppStore.setState({
    profiles: [],
    activeProfileId: '',
    workspaceSessions: [],
    activeWorkspaceSessionId: null,
    agents: [],
    orchestrators: {},
    mcpServers: [],
    health: [],
    githubAuth: null,
    reopenedAgentIds: []
  })

  useLayoutStore.setState({ sidebarSections: {} })
})

describe('Sidebar rendering', () => {
  it('turns the collapsed sidebar into a functional, accessible navigation rail', () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarView, {
        store: useAppStore.getState(),
        width: 420,
        collapsed: true,
        onToggle: (): void => undefined
      })
    )

    expect(markup).toContain('panel-collapsed')
    expect(markup).toContain('data-testid="sidebar-rail"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('aria-label="Linke Seitenleiste ausklappen"')
    expect(markup).toContain('aria-label="Agent-Workspace"')
    expect(markup).toContain('aria-label="Ideen und Artefakte verwalten"')
    expect(markup).toContain('aria-label="Neuen Workspace starten"')
    expect(markup).toContain('aria-current="page"')
    expect(markup.match(/<button/g)?.length).toBe(9)
    expect(markup).not.toContain('data-sidebar-section=')
    expect(markup).not.toContain('style="width:420px"')
  })

  it('keeps profile state and waiting attention visible in rail mode', () => {
    const profile = workspaceProfileSchema.parse({ id: 'alpha', name: 'Alpha Team' })
    useAppStore.setState({
      profiles: [profile],
      activeProfileId: profile.id,
      agents: [
        {
          id: 'waiting-agent',
          profileId: profile.id,
          name: 'Pippin',
          provider: 'codex',
          model: '',
          role: 'Subagent',
          kind: 'sub',
          mode: 'interactive',
          yolo: false,
          workingDir: '.',
          status: 'waiting',
          startedAt: 1
        }
      ]
    })

    const markup = renderToStaticMarkup(
      createElement(SidebarView, {
        store: useAppStore.getState(),
        collapsed: true,
        onToggle: (): void => undefined
      })
    )

    expect(markup).toContain('data-attention="subagent"')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('AL</span>')
    expect(markup).toContain('Pippin wartet auf deine Rückmeldung.')
  })

  it('renders the six product sections in the required order', () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarView, { store: useAppStore.getState() })
    )
    const renderedOrder = Array.from(
      markup.matchAll(/data-sidebar-section="([^"]+)"/g),
      (match) => match[1]
    )

    expect(renderedOrder).toEqual([...SIDEBAR_SECTION_ORDER])
    expect(markup.indexOf('Workspace-Profile')).toBeLessThan(markup.indexOf('Profil-Workspaces'))
    expect(markup.indexOf('Profil-Workspaces')).toBeLessThan(markup.indexOf('Navigation'))
    expect(markup.indexOf('Navigation')).toBeLessThan(markup.indexOf('MCP-Server'))
    expect(markup.indexOf('MCP-Server')).toBeLessThan(markup.indexOf('KI-Provider'))
    expect(markup.indexOf('KI-Provider')).toBeLessThan(markup.indexOf('Infrastruktur'))
  })

  it('renders waiting-agent attention visibly and with an accessible label', () => {
    const profile = workspaceProfileSchema.parse({ id: 'alpha', name: 'Alpha' })
    useAppStore.setState({
      profiles: [profile],
      activeProfileId: profile.id,
      workspaceSessions: [
        {
          id: 'session-alpha',
          profileId: profile.id,
          profileName: profile.name,
          name: 'Rivendell',
          taskSummary: 'Schema, IPC und Store verbinden',
          sequence: 1,
          startedAt: 1,
          active: true
        }
      ],
      activeWorkspaceSessionId: 'session-alpha',
      agents: [
        {
          id: 'pippin',
          profileId: profile.id,
          workspaceSessionId: 'session-alpha',
          name: 'Pippin',
          provider: 'codex',
          model: '',
          role: 'Subagent',
          kind: 'sub',
          mode: 'interactive',
          yolo: false,
          workingDir: '.',
          status: 'waiting',
          startedAt: 1
        }
      ]
    })

    const markup = renderToStaticMarkup(
      createElement(SidebarView, { store: useAppStore.getState() })
    )

    expect(markup).toContain('data-user-attention="subagent"')
    expect(markup).toContain('workspace-attention-indicator')
    expect(markup).toContain('workspace-task-summary')
    expect(markup).toContain('Schema, IPC und Store verbinden')
    expect(markup).toContain('Pippin wartet auf deine Rückmeldung.')
  })
})

describe('sidebar section collapse', () => {
  it('renders one toggle per section, all open by default', () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarView, { store: useAppStore.getState() })
    )

    for (const id of SIDEBAR_SECTION_ORDER) {
      expect(markup).toContain(`aria-controls="sidebar-section-${id}"`)
      expect(markup).toContain(`id="sidebar-section-${id}"`)
    }
    const expandedToggles = markup.match(/aria-expanded="true" aria-controls="sidebar-section-/g)
    expect(expandedToggles?.length).toBe(SIDEBAR_SECTION_ORDER.length)
  })

  it('hides a collapsed section body but keeps the attention counter on the header', () => {
    const profile = workspaceProfileSchema.parse({ id: 'alpha', name: 'Alpha' })
    useAppStore.setState({
      profiles: [profile],
      activeProfileId: profile.id,
      agents: [
        {
          id: 'pippin',
          profileId: profile.id,
          name: 'Pippin',
          provider: 'codex',
          model: '',
          role: 'Subagent',
          kind: 'sub',
          mode: 'interactive',
          yolo: false,
          workingDir: '.',
          status: 'waiting',
          startedAt: 1
        }
      ]
    })
    useLayoutStore.setState({ sidebarSections: { 'workspace-profiles': false } })

    const markup = renderToStaticMarkup(
      createElement(SidebarView, { store: useAppStore.getState() })
    )

    expect(markup).not.toContain('id="sidebar-section-workspace-profiles"')
    expect(markup).toContain('aria-expanded="false" aria-controls="sidebar-section-workspace-profiles"')
    expect(markup).toContain('data-section-badge="workspace-profiles"')
    // Sektion bleibt als leere Huelle im DOM, damit die Reihenfolge stabil bleibt.
    expect(markup).toContain('data-sidebar-section="workspace-profiles"')
  })
})

describe('navigation badges and rows', () => {
  const snapshotWithWork: OrchestratorSnapshot = {
    profileId: 'alpha',
    workspaceSessionId: 'session-alpha',
    goal: null,
    tasks: [],
    pendingApprovals: [
      {
        id: 'approval-1',
        kind: 'plan-review',
        profileId: 'alpha',
        workspaceSessionId: 'session-alpha',
        title: 'Plan wartet',
        summary: '1 Aufgabe',
        createdAt: 1,
        actions: []
      }
    ],
    integration: {
      status: 'prepared',
      items: [
        { taskId: 't1', title: 'Feature A', status: 'prepared', findingCount: 0 },
        { taskId: 't2', title: 'Feature B', status: 'published', findingCount: 0 },
        { taskId: 't3', title: 'Feature C', status: 'blocked', findingCount: 1 },
        { taskId: 't4', title: 'Feature D', status: 'skipped', findingCount: 0 }
      ]
    }
  }

  it('counts only unpublished, unskipped integration items as open publications', () => {
    expect(openPublicationCount([snapshotWithWork])).toBe(2)
    expect(openPublicationCount([])).toBe(0)
    expect(openPublicationCount([{ goal: null, tasks: [] }])).toBe(0)
  })

  it('shows approval and publication counters as badges on the nav rows', () => {
    useAppStore.setState({ orchestrators: { 'session-alpha': snapshotWithWork } })

    const markup = renderToStaticMarkup(
      createElement(SidebarView, { store: useAppStore.getState() })
    )

    expect(markup).toContain('data-nav-badge="approvals"')
    expect(markup).toContain('data-nav-badge="changes"')
    expect(markup).toMatch(/data-nav-badge="approvals"[^>]*>1</)
    expect(markup).toMatch(/data-nav-badge="changes"[^>]*>2</)
  })

  it('omits the badges when nothing is open', () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarView, { store: useAppStore.getState() })
    )

    expect(markup).not.toContain('data-nav-badge=')
  })

  it('renders the Mission Control navigation row', () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarView, { store: useAppStore.getState() })
    )

    expect(markup).toContain('Mission Control')
    expect(markup).toContain('Remote-Steuerung und Freigaben')
  })
})

describe('infrastructure rows', () => {
  it('exposes an explicit edit button for the RetroSync target', () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarView, { store: useAppStore.getState() })
    )

    expect(markup).toContain('aria-label="Ziel bearbeiten"')
  })
})

describe('workspace run status', () => {
  it.each([
    ['success', 'success', 'success', 'Erfolgreich'],
    ['needs-work', 'incomplete', 'failure', 'Unvollständig'],
    ['error', 'failed', 'failure', 'Fehlgeschlagen'],
    ['stopped', 'stopped', 'neutral', 'Abgebrochen']
  ])(
    'maps terminal status %s to a visible %s presentation',
    (terminalStatus, state, tone, label) => {
      expect(workspaceRunPresentation({ activeAgents: 0, terminalStatus })).toMatchObject({
        state,
        tone,
        label
      })
    }
  )

  it('keeps running and never-started workspaces neutral', () => {
    expect(workspaceRunPresentation({ activeAgents: 2, terminalStatus: 'error' })).toMatchObject({
      state: 'running',
      tone: 'neutral',
      label: '2 aktiv'
    })
    expect(workspaceRunPresentation({ activeAgents: 0 })).toMatchObject({
      state: 'not-started',
      tone: 'neutral',
      label: 'Nicht gestartet'
    })
    expect(workspaceRunPresentation({
      activeAgents: 0,
      terminalStatus: 'success',
      gitPostProcessingStatus: 'running'
    })).toMatchObject({
      state: 'running',
      tone: 'neutral',
      label: 'Git wird verarbeitet'
    })
  })

  it('lets Git post-processing override a stale prior terminal result', () => {
    expect(workspaceRunPresentation({
      activeAgents: 0,
      terminalStatus: 'success',
      gitPostProcessingStatus: 'failed'
    })).toMatchObject({ state: 'failed', tone: 'failure', label: 'Git fehlgeschlagen' })
    expect(workspaceRunPresentation({
      activeAgents: 0,
      terminalStatus: 'error',
      gitPostProcessingStatus: 'pushed'
    })).toMatchObject({ state: 'success', tone: 'success' })
  })

  it('keeps cancellations and unknown status values neutral without reflecting input', () => {
    const unknown = workspaceRunPresentation({
      activeAgents: 0,
      terminalStatus: '<img src=x onerror=alert(1)>'
    })

    expect(unknown).toMatchObject({
      state: 'unknown',
      tone: 'neutral',
      label: 'Status unbekannt'
    })
    expect(unknown.label).not.toContain('img')
    expect(workspaceRunPresentation({
      activeAgents: 0,
      terminalStatus: 'stopped',
      orchestratorAgentStatus: 'error'
    }).tone).toBe('neutral')
  })

  it('renders a terminal result with redundant text, symbol and accessible status', () => {
    const profile = workspaceProfileSchema.parse({ id: 'alpha', name: 'Alpha' })
    useAppStore.setState({
      profiles: [profile],
      activeProfileId: profile.id,
      workspaceSessions: [
        {
          id: 'session-alpha',
          profileId: profile.id,
          profileName: profile.name,
          name: 'Rivendell',
          sequence: 1,
          startedAt: 1,
          active: true,
          taskSummary: undefined
        }
      ],
      activeWorkspaceSessionId: 'session-alpha',
      orchestrators: {
        'session-alpha': {
          profileId: profile.id,
          workspaceSessionId: 'session-alpha',
          goal: null,
          tasks: [],
          lastRetro: {
            id: 'retro-1',
            profileId: profile.id,
            workspaceSessionId: 'session-alpha',
            planId: 'plan-1',
            goal: 'Test goal',
            status: 'success',
            summary: 'Done',
            modelStats: [],
            learnings: [],
            createdAt: 2
          }
        }
      }
    })

    const markup = renderToStaticMarkup(
      createElement(SidebarView, { store: useAppStore.getState() })
    )

    expect(markup).toContain('data-orchestrator-status="success"')
    expect(markup).toContain('data-tone="success"')
    expect(markup).toContain('aria-label="Orchestrator-Lauf erfolgreich"')
    expect(markup).toContain('✓')
    expect(markup).toContain('Erfolgreich')
  })
})
