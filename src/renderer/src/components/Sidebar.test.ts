import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { workspaceProfileSchema } from '@shared/profile'
import { useAppStore } from '@renderer/store/useAppStore'
import { SIDEBAR_SECTION_ORDER, SidebarView } from '@renderer/components/Sidebar'

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
  it('replaces all sidebar content with an accessible expand control when collapsed', () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarView, {
        store: useAppStore.getState(),
        width: 420,
        collapsed: true,
        onToggle: (): void => undefined
      })
    )

    expect(markup).toContain('panel-collapsed')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('aria-label="Linke Seitenleiste ausklappen"')
    expect(markup).not.toContain('data-sidebar-section=')
    expect(markup).not.toContain('style="width:420px"')
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
