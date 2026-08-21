/**
 * Voice tools and their host-side execution. Profile/workspace names are
 * spoken, never ids — resolution is deliberately fuzzy so STT drift still
 * hits the right row, and ambiguous matches refuse instead of guessing.
 */
import { normalizeWake } from './wakePhrase'

export type VoiceLocale = 'de' | 'en'

export interface VoiceHostProfile {
  id: string
  name: string
}

export interface VoiceHostAgent {
  agentId: string
  name: string
  roleId: string
  state: string
}

export interface VoiceHostWorkspace {
  workspaceId: string
  name: string
  profileId: string
  profileName?: string
  active: boolean
  taskText?: string
  agents: VoiceHostAgent[]
}

export interface VoiceHost {
  listProfiles(): VoiceHostProfile[]
  listWorkspaces(): VoiceHostWorkspace[]
  startWorkspace(profileId: string, goal?: string): Promise<void>
  stopWorkspace(workspaceId: string): Promise<void>
  focusWorkspace(workspaceId: string): void
  focusAgent(agentId: string): void
  hideAll(): void
  openSettings(): void
  openProfileEditor(profileId?: string): void
  setYolo(enabled: boolean): void | Promise<void>
  sendToOrchestrator(workspaceId: string, text: string): Promise<void>
  quitApp(): void
}

export interface VoiceCommandResult {
  ok: boolean
  message: string
  endSession?: boolean
  confirmQuit?: boolean
}

export interface VoiceFunctionTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

export const VOICE_TOOLS: VoiceFunctionTool[] = [
  {
    type: 'function',
    name: 'list_profiles',
    description: 'List configured Vertragus profiles by spoken name.',
    parameters: { type: 'object', properties: {} }
  },
  {
    type: 'function',
    name: 'list_workspaces',
    description: 'List workspaces with their Commedia names, profile, and agents.',
    parameters: { type: 'object', properties: {} }
  },
  {
    type: 'function',
    name: 'start_workspace',
    description:
      'Start a workspace for a profile. `profile` is the spoken profile name, never an id.',
    parameters: {
      type: 'object',
      properties: {
        profile: { type: 'string', description: 'Spoken profile name' },
        goal: { type: 'string', description: 'Optional task goal for the run' }
      },
      required: ['profile']
    }
  },
  {
    type: 'function',
    name: 'stop_workspace',
    description:
      'Stop a workspace by Commedia name, or by profile name when that profile has exactly one active workspace.',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Spoken workspace Commedia name' },
        profile: { type: 'string', description: 'Spoken profile name' }
      }
    }
  },
  {
    type: 'function',
    name: 'focus_workspace',
    description: 'Focus the CLI windows of a workspace, addressed by Commedia name.',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Spoken workspace Commedia name' }
      },
      required: ['workspace']
    }
  },
  {
    type: 'function',
    name: 'focus_agent',
    description: 'Focus one agent window by Commedia code-name across all workspaces.',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Spoken agent Commedia name' }
      },
      required: ['agent']
    }
  },
  {
    type: 'function',
    name: 'hide_all',
    description: 'Hide every agent window. The panel stays.',
    parameters: { type: 'object', properties: {} }
  },
  {
    type: 'function',
    name: 'open_settings',
    description: 'Open the Vertragus settings window.',
    parameters: { type: 'object', properties: {} }
  },
  {
    type: 'function',
    name: 'open_profile_editor',
    description: 'Open the profile editor, optionally for a named profile.',
    parameters: {
      type: 'object',
      properties: {
        profile: { type: 'string', description: 'Spoken profile name' }
      }
    }
  },
  {
    type: 'function',
    name: 'set_yolo',
    description: 'Set the yolo master switch. Subagents skip confirmation when enabled.',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true to enable yolo, false to disable' }
      },
      required: ['enabled']
    }
  },
  {
    type: 'function',
    name: 'send_to_orchestrator',
    description:
      'Send a text instruction to a workspace orchestrator. Defaults to the only active workspace.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message for the orchestrator' },
        workspace: { type: 'string', description: 'Spoken workspace Commedia name' }
      },
      required: ['text']
    }
  },
  {
    type: 'function',
    name: 'status',
    description: 'Speak a short snapshot of running workspaces and their agents.',
    parameters: { type: 'object', properties: {} }
  },
  {
    type: 'function',
    name: 'end_session',
    description: 'End the voice session and go back to waiting for the wake phrase.',
    parameters: { type: 'object', properties: {} }
  },
  {
    type: 'function',
    name: 'quit_app',
    description:
      'Ask the user to confirm quitting Vertragus. Does not quit. Call confirm_quit only after they confirm.',
    parameters: { type: 'object', properties: {} }
  },
  {
    type: 'function',
    name: 'confirm_quit',
    description: 'Quit Vertragus after the user confirmed. This actually exits the app.',
    parameters: { type: 'object', properties: {} }
  }
]

export async function executeCommand(
  host: VoiceHost,
  name: string,
  args: Record<string, unknown>,
  locale: VoiceLocale = 'de'
): Promise<VoiceCommandResult> {
  try {
    switch (name) {
      case 'list_profiles':
        return listProfiles(host, locale)
      case 'list_workspaces':
        return listWorkspaces(host, locale)
      case 'start_workspace':
        return await startWorkspace(host, args, locale)
      case 'stop_workspace':
        return await stopWorkspace(host, args, locale)
      case 'focus_workspace':
        return focusWorkspace(host, args, locale)
      case 'focus_agent':
        return focusAgent(host, args, locale)
      case 'hide_all':
        host.hideAll()
        return ok(t(locale, 'Alles weg.', 'All hidden.'))
      case 'open_settings':
        host.openSettings()
        return ok(t(locale, 'Einstellungen sind offen.', 'Settings are open.'))
      case 'open_profile_editor':
        return openProfileEditor(host, args, locale)
      case 'set_yolo':
        return await setYolo(host, args, locale)
      case 'send_to_orchestrator':
        return await sendToOrchestrator(host, args, locale)
      case 'status':
        return status(host, locale)
      case 'end_session':
        return {
          ok: true,
          endSession: true,
          message: t(
            locale,
            'Alles klar, ich höre wieder auf das Weckwort.',
            'Okay, back to the wake phrase.'
          )
        }
      case 'quit_app':
        return {
          ok: true,
          confirmQuit: true,
          message: t(
            locale,
            'Soll ich Vertragus wirklich beenden?',
            'Should I really quit Vertragus?'
          )
        }
      case 'confirm_quit':
        host.quitApp()
        return ok(t(locale, 'Beende Vertragus.', 'Quitting Vertragus.'))
      default:
        return fail(t(locale, `Unbekanntes Werkzeug: ${name}.`, `Unknown tool: ${name}.`))
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return fail(t(locale, `Das hat nicht geklappt: ${detail}`, `That failed: ${detail}`))
  }
}

export function resolveProfile(
  host: VoiceHost,
  spoken: string
): SpokenResolve<VoiceHostProfile> {
  return resolveSpoken(host.listProfiles(), spoken, (profile) => profile.name)
}

type SpokenResolve<T> =
  | { ok: true; item: T }
  | { ok: false; reason: 'missing' | 'ambiguous'; candidates: T[] }

function resolveSpoken<T>(
  items: readonly T[],
  spoken: string,
  nameOf: (item: T) => string
): SpokenResolve<T> {
  const needle = spoken.trim()
  if (!needle) return { ok: false, reason: 'missing', candidates: [] }

  const layers: Array<(name: string) => boolean> = [
    (name) => name.toLowerCase() === needle.toLowerCase(),
    (name) => name.toLowerCase().startsWith(needle.toLowerCase()),
    (name) => name.toLowerCase().includes(needle.toLowerCase()),
    (name) => normalizeWake(name) === normalizeWake(needle)
  ]

  for (const pred of layers) {
    const hits = items.filter((item) => pred(nameOf(item)))
    if (hits.length === 1) return { ok: true, item: hits[0]! }
    if (hits.length > 1) return { ok: false, reason: 'ambiguous', candidates: hits }
  }
  return { ok: false, reason: 'missing', candidates: [] }
}

function resolveWorkspace(host: VoiceHost, spoken: string): SpokenResolve<VoiceHostWorkspace> {
  return resolveSpoken(host.listWorkspaces(), spoken, (workspace) => workspace.name)
}

function resolveAgent(
  host: VoiceHost,
  spoken: string
): SpokenResolve<VoiceHostAgent & { workspaceId: string }> {
  const agents = host.listWorkspaces().flatMap((workspace) =>
    workspace.agents.map((agent) => ({ ...agent, workspaceId: workspace.workspaceId }))
  )
  return resolveSpoken(agents, spoken, (agent) => agent.name)
}

function listProfiles(host: VoiceHost, locale: VoiceLocale): VoiceCommandResult {
  const names = host.listProfiles().map((profile) => profile.name)
  if (names.length === 0) {
    return ok(t(locale, 'Keine Profile konfiguriert.', 'No profiles configured.'))
  }
  return ok(
    t(locale, `Profile: ${joinList(names, locale)}.`, `Profiles: ${joinList(names, locale)}.`)
  )
}

function listWorkspaces(host: VoiceHost, locale: VoiceLocale): VoiceCommandResult {
  const workspaces = host.listWorkspaces()
  if (workspaces.length === 0) {
    return ok(t(locale, 'Keine Workspaces.', 'No workspaces.'))
  }
  const parts = workspaces.map((workspace) => {
    const profile = workspace.profileName ?? workspace.profileId
    const running = workspace.active
      ? t(locale, 'läuft', 'running')
      : t(locale, 'steht', 'stopped')
    return `${workspace.name} (${profile}, ${running})`
  })
  return ok(
    t(locale, `Workspaces: ${joinList(parts, locale)}.`, `Workspaces: ${joinList(parts, locale)}.`)
  )
}

async function startWorkspace(
  host: VoiceHost,
  args: Record<string, unknown>,
  locale: VoiceLocale
): Promise<VoiceCommandResult> {
  const spoken = asString(args.profile)
  if (!spoken) {
    return fail(t(locale, 'Welches Profil soll ich starten?', 'Which profile should I start?'))
  }
  const resolved = resolveProfile(host, spoken)
  if (!resolved.ok) return profileResolveError(resolved, locale)
  const goal = asString(args.goal)
  await host.startWorkspace(resolved.item.id, goal)
  if (goal) {
    return ok(
      t(
        locale,
        `Starte ${resolved.item.name} mit Ziel ${goal}.`,
        `Starting ${resolved.item.name} with goal ${goal}.`
      )
    )
  }
  return ok(t(locale, `Starte ${resolved.item.name}.`, `Starting ${resolved.item.name}.`))
}

async function stopWorkspace(
  host: VoiceHost,
  args: Record<string, unknown>,
  locale: VoiceLocale
): Promise<VoiceCommandResult> {
  const workspaceName = asString(args.workspace)
  const profileName = asString(args.profile)
  let target: VoiceHostWorkspace | undefined

  if (workspaceName) {
    const resolved = resolveWorkspace(host, workspaceName)
    if (!resolved.ok) return workspaceResolveError(resolved, locale)
    target = resolved.item
  } else if (profileName) {
    const profile = resolveProfile(host, profileName)
    if (!profile.ok) return profileResolveError(profile, locale)
    const active = host
      .listWorkspaces()
      .filter((workspace) => workspace.active && workspace.profileId === profile.item.id)
    if (active.length === 0) {
      return fail(
        t(
          locale,
          `Kein laufender Workspace für ${profile.item.name}.`,
          `No running workspace for ${profile.item.name}.`
        )
      )
    }
    if (active.length > 1) {
      return fail(
        t(
          locale,
          `Mehrere Workspaces für ${profile.item.name}: ${joinList(active.map((w) => w.name), locale)}. Welchen soll ich stoppen?`,
          `Several workspaces for ${profile.item.name}: ${joinList(active.map((w) => w.name), locale)}. Which should I stop?`
        )
      )
    }
    target = active[0]
  } else {
    return fail(
      t(
        locale,
        'Welchen Workspace oder welches Profil soll ich stoppen?',
        'Which workspace or profile should I stop?'
      )
    )
  }

  await host.stopWorkspace(target!.workspaceId)
  return ok(t(locale, `Stoppe ${target!.name}.`, `Stopping ${target!.name}.`))
}

function focusWorkspace(
  host: VoiceHost,
  args: Record<string, unknown>,
  locale: VoiceLocale
): VoiceCommandResult {
  const spoken = asString(args.workspace)
  if (!spoken) {
    return fail(t(locale, 'Welchen Workspace soll ich zeigen?', 'Which workspace should I show?'))
  }
  const resolved = resolveWorkspace(host, spoken)
  if (!resolved.ok) return workspaceResolveError(resolved, locale)
  host.focusWorkspace(resolved.item.workspaceId)
  return ok(t(locale, `Zeige ${resolved.item.name}.`, `Showing ${resolved.item.name}.`))
}

function focusAgent(
  host: VoiceHost,
  args: Record<string, unknown>,
  locale: VoiceLocale
): VoiceCommandResult {
  const spoken = asString(args.agent)
  if (!spoken) {
    return fail(t(locale, 'Welchen Agenten soll ich zeigen?', 'Which agent should I show?'))
  }
  const resolved = resolveAgent(host, spoken)
  if (!resolved.ok) {
    if (resolved.reason === 'ambiguous') {
      const names = unique(resolved.candidates.map((agent) => agent.name))
      return fail(
        t(
          locale,
          `Mehrere Agenten passen: ${joinList(names, locale)}. Welchen meinst du?`,
          `Several agents match: ${joinList(names, locale)}. Which one?`
        )
      )
    }
    return fail(t(locale, `Agent ${spoken} nicht gefunden.`, `Agent ${spoken} not found.`))
  }
  host.focusAgent(resolved.item.agentId)
  return ok(t(locale, `Zeige ${resolved.item.name}.`, `Showing ${resolved.item.name}.`))
}

function openProfileEditor(
  host: VoiceHost,
  args: Record<string, unknown>,
  locale: VoiceLocale
): VoiceCommandResult {
  const spoken = asString(args.profile)
  if (!spoken) {
    host.openProfileEditor()
    return ok(t(locale, 'Profil-Editor ist offen.', 'Profile editor is open.'))
  }
  const resolved = resolveProfile(host, spoken)
  if (!resolved.ok) return profileResolveError(resolved, locale)
  host.openProfileEditor(resolved.item.id)
  return ok(
    t(
      locale,
      `Profil-Editor für ${resolved.item.name} ist offen.`,
      `Profile editor for ${resolved.item.name} is open.`
    )
  )
}

async function setYolo(
  host: VoiceHost,
  args: Record<string, unknown>,
  locale: VoiceLocale
): Promise<VoiceCommandResult> {
  const enabled = asBoolean(args.enabled)
  if (enabled === undefined) {
    return fail(t(locale, 'Yolo an oder aus?', 'Yolo on or off?'))
  }
  await host.setYolo(enabled)
  return ok(
    enabled
      ? t(locale, 'Yolo ist an.', 'Yolo is on.')
      : t(locale, 'Yolo ist aus.', 'Yolo is off.')
  )
}

async function sendToOrchestrator(
  host: VoiceHost,
  args: Record<string, unknown>,
  locale: VoiceLocale
): Promise<VoiceCommandResult> {
  const text = asString(args.text)
  if (!text) {
    return fail(t(locale, 'Was soll ich dem Orchestrator sagen?', 'What should I tell the orchestrator?'))
  }
  const workspaceName = asString(args.workspace)
  let target: VoiceHostWorkspace | undefined
  if (workspaceName) {
    const resolved = resolveWorkspace(host, workspaceName)
    if (!resolved.ok) return workspaceResolveError(resolved, locale)
    target = resolved.item
  } else {
    const active = host.listWorkspaces().filter((workspace) => workspace.active)
    if (active.length === 1) {
      target = active[0]
    } else if (active.length === 0) {
      return fail(t(locale, 'Kein Workspace läuft.', 'No workspace is running.'))
    } else {
      return fail(
        t(
          locale,
          `Mehrere Workspaces laufen: ${joinList(active.map((w) => w.name), locale)}. Welchen meinst du?`,
          `Several workspaces are running: ${joinList(active.map((w) => w.name), locale)}. Which one?`
        )
      )
    }
  }
  await host.sendToOrchestrator(target!.workspaceId, text)
  return ok(
    t(
      locale,
      `An ${target!.name} geschickt.`,
      `Sent to ${target!.name}.`
    )
  )
}

function status(host: VoiceHost, locale: VoiceLocale): VoiceCommandResult {
  const running = host.listWorkspaces().filter((workspace) => workspace.active)
  if (running.length === 0) {
    return ok(t(locale, 'Kein Workspace läuft.', 'No workspace is running.'))
  }
  const parts = running.map((workspace) => {
    const profile = workspace.profileName ?? workspace.profileId
    const agentCount = workspace.agents.length
    const agentBit =
      agentCount === 1
        ? t(locale, '1 Agent', '1 agent')
        : t(locale, `${agentCount} Agenten`, `${agentCount} agents`)
    const goal = workspace.taskText ? t(locale, `, Ziel ${workspace.taskText}`, `, goal ${workspace.taskText}`) : ''
    return `${workspace.name} (${profile}, ${agentBit}${goal})`
  })
  if (running.length === 1) {
    return ok(
      t(locale, `Ein Workspace läuft: ${parts[0]}.`, `One workspace is running: ${parts[0]}.`)
    )
  }
  return ok(
    t(
      locale,
      `${running.length} Workspaces: ${joinList(parts, locale)}.`,
      `${running.length} workspaces: ${joinList(parts, locale)}.`
    )
  )
}

function profileResolveError(
  resolved: Extract<SpokenResolve<VoiceHostProfile>, { ok: false }>,
  locale: VoiceLocale
): VoiceCommandResult {
  if (resolved.reason === 'ambiguous') {
    const names = unique(resolved.candidates.map((profile) => profile.name))
    return fail(
      t(
        locale,
        `Mehrere Profile passen: ${joinList(names, locale)}. Welches meinst du?`,
        `Several profiles match: ${joinList(names, locale)}. Which one?`
      )
    )
  }
  return fail(t(locale, 'Profil nicht gefunden.', 'Profile not found.'))
}

function workspaceResolveError(
  resolved: Extract<SpokenResolve<VoiceHostWorkspace>, { ok: false }>,
  locale: VoiceLocale
): VoiceCommandResult {
  if (resolved.reason === 'ambiguous') {
    const names = unique(resolved.candidates.map((workspace) => workspace.name))
    return fail(
      t(
        locale,
        `Mehrere Workspaces passen: ${joinList(names, locale)}. Welchen meinst du?`,
        `Several workspaces match: ${joinList(names, locale)}. Which one?`
      )
    )
  }
  return fail(t(locale, 'Workspace nicht gefunden.', 'Workspace not found.'))
}

function ok(message: string): VoiceCommandResult {
  return { ok: true, message }
}

function fail(message: string): VoiceCommandResult {
  return { ok: false, message }
}

function t(locale: VoiceLocale, de: string, en: string): string {
  return locale === 'en' ? en : de
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

function joinList(items: string[], locale: VoiceLocale): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]!
  const head = items.slice(0, -1).join(', ')
  const last = items[items.length - 1]!
  return locale === 'en' ? `${head} and ${last}` : `${head} und ${last}`
}

function unique(items: string[]): string[] {
  return [...new Set(items)]
}
