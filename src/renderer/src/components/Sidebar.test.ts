import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { workspaceProfileSchema } from '@shared/profile'
import { useAppStore } from '@renderer/store/useAppStore'
import {
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
})

describe('Sidebar rendering', () => {
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
    expect(markup).toContain('Pippin wartet auf deine Rückmeldung.')
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
          active: true
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
