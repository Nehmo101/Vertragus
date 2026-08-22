import { describe, expect, it, vi } from 'vitest'
import {
  executeCommand,
  resolveProfile,
  VOICE_TOOLS,
  type VoiceHost,
  type VoiceHostProfile,
  type VoiceHostWorkspace
} from './commands'

function workspace(partial: Partial<VoiceHostWorkspace> & Pick<VoiceHostWorkspace, 'workspaceId' | 'name' | 'profileId'>): VoiceHostWorkspace {
  return {
    active: true,
    agents: [],
    ...partial
  }
}

function createHost(overrides: Partial<VoiceHost> & { profiles?: VoiceHostProfile[]; workspaces?: VoiceHostWorkspace[] } = {}): VoiceHost & {
  started: { profileId: string; goal?: string }[]
  stopped: string[]
  sent: { workspaceId: string; text: string }[]
  yolo?: boolean
  quit: number
} {
  const profiles = overrides.profiles ?? [
    { id: 'p-uwe', name: 'UWE' },
    { id: 'p-build', name: 'Build' }
  ]
  const workspaces = overrides.workspaces ?? [
    workspace({
      workspaceId: 'ws-1',
      name: 'Paradiso',
      profileId: 'p-uwe',
      profileName: 'UWE',
      active: true,
      taskText: 'xyz',
      agents: [{ agentId: 'a-1', name: 'Caronte', roleId: 'worker', state: 'running' }]
    })
  ]
  const started: { profileId: string; goal?: string }[] = []
  const stopped: string[] = []
  const sent: { workspaceId: string; text: string }[] = []
  const host: VoiceHost & {
    started: typeof started
    stopped: typeof stopped
    sent: typeof sent
    yolo?: boolean
    quit: number
  } = {
    started,
    stopped,
    sent,
    quit: 0,
    listProfiles: overrides.listProfiles ?? (() => profiles),
    listWorkspaces: overrides.listWorkspaces ?? (() => workspaces),
    startWorkspace: overrides.startWorkspace ?? (async (profileId, goal) => {
      started.push({ profileId, goal })
    }),
    stopWorkspace: overrides.stopWorkspace ?? (async (workspaceId) => {
      stopped.push(workspaceId)
    }),
    focusWorkspace: overrides.focusWorkspace ?? vi.fn(),
    focusAgent: overrides.focusAgent ?? vi.fn(),
    hideAll: overrides.hideAll ?? vi.fn(),
    openSettings: overrides.openSettings ?? vi.fn(),
    openProfileEditor: overrides.openProfileEditor ?? vi.fn(),
    setYolo:
      overrides.setYolo ??
      ((enabled) => {
        host.yolo = enabled
      }),
    sendToOrchestrator: overrides.sendToOrchestrator ?? (async (workspaceId, text) => {
      sent.push({ workspaceId, text })
    }),
    quitApp:
      overrides.quitApp ??
      (() => {
        host.quit += 1
      })
  }
  return host
}

describe('VOICE_TOOLS', () => {
  it('exports snake_case function tools including start_workspace and confirm_quit', () => {
    const names = VOICE_TOOLS.map((tool) => tool.name)
    expect(new Set(names)).toEqual(
      new Set([
        'list_profiles',
        'list_workspaces',
        'start_workspace',
        'stop_workspace',
        'focus_workspace',
        'focus_agent',
        'hide_all',
        'open_settings',
        'open_profile_editor',
        'set_yolo',
        'send_to_orchestrator',
        'status',
        'end_session',
        'quit_app',
        'confirm_quit'
      ])
    )
    for (const tool of VOICE_TOOLS) {
      expect(tool.type).toBe('function')
      expect(tool.parameters).toMatchObject({ type: 'object' })
    }
  })
})

describe('resolveProfile / start_workspace', () => {
  it('resolves UWE case-insensitively and starts with a goal', async () => {
    const host = createHost()
    expect(resolveProfile(host, 'uwe').ok).toBe(true)
    const result = await executeCommand(
      host,
      'start_workspace',
      { profile: 'uwe', goal: 'xyz' },
      'de'
    )
    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/UWE/)
    expect(result.message).toMatch(/xyz/)
    expect(host.started).toEqual([{ profileId: 'p-uwe', goal: 'xyz' }])
  })

  it('refuses to start when two profiles match and lists the candidates', async () => {
    const host = createHost({
      profiles: [
        { id: 'a', name: 'UWE Alpha' },
        { id: 'b', name: 'UWE Beta' }
      ]
    })
    const result = await executeCommand(host, 'start_workspace', { profile: 'UWE' }, 'de')
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/UWE Alpha/)
    expect(result.message).toMatch(/UWE Beta/)
    expect(host.started).toEqual([])
  })

  it('reports a missing profile without calling start', async () => {
    const host = createHost()
    const result = await executeCommand(host, 'start_workspace', { profile: 'Nirwana' }, 'en')
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not found/i)
    expect(host.started).toEqual([])
  })

  it('prefers an exact name over a longer startsWith candidate', () => {
    const host = createHost({
      profiles: [
        { id: 'p-code', name: 'Code' },
        { id: 'p-codegen', name: 'Codegen' }
      ]
    })
    const resolved = resolveProfile(host, 'Code')
    expect(resolved).toEqual({ ok: true, item: { id: 'p-code', name: 'Code' } })
  })

  it('refuses a short prefix that matches more than one profile', () => {
    const host = createHost({
      profiles: [
        { id: 'p-code', name: 'Code' },
        { id: 'p-codegen', name: 'Codegen' }
      ]
    })
    const resolved = resolveProfile(host, 'Co')
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.reason).toBe('ambiguous')
    expect(resolved.candidates.map((profile) => profile.name)).toEqual(['Code', 'Codegen'])
  })
})

describe('stop_workspace and send_to_orchestrator', () => {
  it('stops by workspace Commedia name', async () => {
    const host = createHost()
    const result = await executeCommand(host, 'stop_workspace', { workspace: 'paradiso' })
    expect(result.ok).toBe(true)
    expect(host.stopped).toEqual(['ws-1'])
  })

  it('sends to the only active workspace and refuses when several run', async () => {
    const one = createHost()
    const sent = await executeCommand(one, 'send_to_orchestrator', { text: 'weiter' })
    expect(sent.ok).toBe(true)
    expect(one.sent).toEqual([{ workspaceId: 'ws-1', text: 'weiter' }])

    const many = createHost({
      workspaces: [
        workspace({ workspaceId: 'ws-1', name: 'Paradiso', profileId: 'p-uwe', active: true }),
        workspace({ workspaceId: 'ws-2', name: 'Inferno', profileId: 'p-build', active: true })
      ]
    })
    const refused = await executeCommand(many, 'send_to_orchestrator', { text: 'weiter' })
    expect(refused.ok).toBe(false)
    expect(refused.message).toMatch(/Paradiso/)
    expect(refused.message).toMatch(/Inferno/)
    expect(many.sent).toEqual([])
  })
})

describe('executeCommand edge cases', () => {
  it('returns an error for an unknown tool', async () => {
    const result = await executeCommand(createHost(), 'launch_missiles', {})
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/Unbekanntes Werkzeug/)
  })

  it('does not quit on quit_app and only quits on confirm_quit', async () => {
    const host = createHost()
    const ask = await executeCommand(host, 'quit_app', {})
    expect(ask.ok).toBe(true)
    expect(ask.confirmQuit).toBe(true)
    expect(host.quit).toBe(0)
    const confirm = await executeCommand(host, 'confirm_quit', {})
    expect(confirm.ok).toBe(true)
    expect(host.quit).toBe(1)
  })

  it('refuses a bare confirm_quit with no prior quit_app', async () => {
    const host = createHost()
    const bare = await executeCommand(host, 'confirm_quit', {})
    expect(bare.ok).toBe(false)
    expect(host.quit).toBe(0)
  })

  it('marks end_session so the session layer can hang up', async () => {
    const result = await executeCommand(createHost(), 'end_session', {}, 'en')
    expect(result).toMatchObject({ ok: true, endSession: true })
  })

  it('matches umlaut-folded profile names', async () => {
    const host = createHost({ profiles: [{ id: 'p-g', name: 'Größe' }] })
    const result = await executeCommand(host, 'start_workspace', { profile: 'grosse' })
    expect(result.ok).toBe(true)
    expect(host.started).toEqual([{ profileId: 'p-g', goal: undefined }])
  })
})
