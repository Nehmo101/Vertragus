/**
 * Tool definitions and execution for the free voice assistant (WS-C2).
 *
 * This module is intentionally free of Electron / main-process imports: every
 * side effect is routed through the injected `VoiceAssistantDeps`, so the tool
 * loop and the fuzzy profile resolver are pure and unit-testable. The concrete
 * dependency wiring (spawnProfileTeam, seedInteractive, agentManager, …) lives
 * in VoiceAssistantService.ts.
 */
import type { AgentInstanceInfo } from '@shared/agents'
import type { OrchestratorSnapshot, WorkspaceSessionSummary } from '@shared/orchestrator'
import type {
  ChatTool,
  ExecutedAction,
  UiCommand,
  VoiceAssistantConfirmation,
  VoiceAssistantUiState
} from '@main/voice/types'

export interface AssistantProfile {
  id: string
  name: string
}

export interface StartWorkspaceOutcome {
  ok: boolean
  sessionId?: string
  orchestratorId?: string
  agentCount: number
  goalSeeded: boolean
  reason?: string
}

/** All side effects the tools may trigger — every one is an existing main function. */
export interface VoiceAssistantDeps {
  listProfiles(): AssistantProfile[]
  listSessions(): WorkspaceSessionSummary[]
  listAgents(): AgentInstanceInfo[]
  snapshotForSession(sessionId: string): OrchestratorSnapshot | undefined
  startProfileWorkspace(input: { profileId: string; goal?: string }): Promise<StartWorkspaceOutcome>
  /** Seeds the orchestrator agent of a session; false when no orchestrator is running. */
  seedToOrchestrator(sessionId: string, text: string): Promise<boolean>
  /** Stops all agents of a profile (or every profile when omitted); returns the count stopped. */
  stopAgents(profileId?: string): Promise<number>
}

export const ALLOWED_LAYOUTS = ['canvas', 'tiles', 'focus'] as const
export type AllowedLayout = (typeof ALLOWED_LAYOUTS)[number]

export interface ToolExecutionContext {
  deps: VoiceAssistantDeps
  uiState?: VoiceAssistantUiState
}

export interface ToolOutcome {
  /** JSON-serialisable payload handed back to the model as the tool result. */
  result: Record<string, unknown>
  action?: ExecutedAction
  uiCommand?: UiCommand
  confirmation?: VoiceAssistantConfirmation
}

// ---------------------------------------------------------------------------
// Fuzzy profile resolution (normalize/deburr → exact → prefix → includes → Levenshtein≤2)
// ---------------------------------------------------------------------------

function deburr(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
}

/** Diacritic-free, digraph-folded, alphanumeric-only key for tolerant matching. */
export function normalizeName(value: string): string {
  return deburr(value)
    .replace(/ae/g, 'a')
    .replace(/oe/g, 'o')
    .replace(/ue/g, 'u')
    .replace(/[^a-z0-9]+/g, '')
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  let curr = new Array<number>(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]
}

export type ProfileResolution =
  | { status: 'ok'; profile: AssistantProfile }
  | { status: 'ambiguous'; options: AssistantProfile[] }
  | { status: 'none' }

/**
 * Resolve a spoken/typed profile name against the available profiles. Ties at
 * the strongest matching tier are reported as ambiguous so the assistant can
 * ask a clarifying question instead of guessing.
 */
export function resolveProfile(query: string, profiles: AssistantProfile[]): ProfileResolution {
  const q = normalizeName(query)
  if (!q || profiles.length === 0) return { status: 'none' }

  const indexed = profiles.map((profile) => ({ profile, key: normalizeName(profile.name) }))

  const tiers: Array<(entry: { key: string }) => boolean> = [
    (e) => e.key === q,
    (e) => e.key.startsWith(q) || q.startsWith(e.key),
    (e) => e.key.includes(q) || q.includes(e.key)
  ]

  for (const match of tiers) {
    const hits = indexed.filter(match)
    if (hits.length === 1) return { status: 'ok', profile: hits[0].profile }
    if (hits.length > 1) return { status: 'ambiguous', options: hits.map((h) => h.profile) }
  }

  // Final tolerant tier: closest Levenshtein distance within 2.
  let best: { profile: AssistantProfile; distance: number }[] = []
  for (const entry of indexed) {
    const distance = levenshtein(entry.key, q)
    if (distance > 2) continue
    if (best.length === 0 || distance < best[0].distance) {
      best = [{ profile: entry.profile, distance }]
    } else if (distance === best[0].distance) {
      best.push({ profile: entry.profile, distance })
    }
  }
  if (best.length === 1) return { status: 'ok', profile: best[0].profile }
  if (best.length > 1) return { status: 'ambiguous', options: best.map((b) => b.profile) }
  return { status: 'none' }
}

// ---------------------------------------------------------------------------
// Session targeting
// ---------------------------------------------------------------------------

type SessionResolution =
  | { status: 'ok'; session: WorkspaceSessionSummary }
  | { status: 'ambiguous'; options: AssistantProfile[] }
  | { status: 'none'; profileResolved: boolean }

function resolveTargetSession(
  profileName: string | undefined,
  ctx: ToolExecutionContext
): SessionResolution {
  const sessions = ctx.deps.listSessions()
  if (sessions.length === 0) return { status: 'none', profileResolved: false }

  if (profileName?.trim()) {
    const resolution = resolveProfile(profileName, ctx.deps.listProfiles())
    if (resolution.status === 'ambiguous') return { status: 'ambiguous', options: resolution.options }
    if (resolution.status === 'none') return { status: 'none', profileResolved: false }
    const forProfile = sessions.filter((s) => s.profileId === resolution.profile.id)
    if (forProfile.length === 0) return { status: 'none', profileResolved: true }
    return { status: 'ok', session: forProfile.find((s) => s.active) ?? forProfile[0] }
  }

  const preferredId = ctx.uiState?.activeSessionId
  if (preferredId) {
    const preferred = sessions.find((s) => s.id === preferredId)
    if (preferred) return { status: 'ok', session: preferred }
  }
  return { status: 'ok', session: sessions.find((s) => s.active) ?? sessions[0] }
}

// ---------------------------------------------------------------------------
// Tool schema (OpenAI function tools)
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS: ChatTool[] = [
  {
    type: 'function',
    function: {
      name: 'start_profile_workspace',
      description:
        'Startet ein Workspace-Team aus einem vorhandenen Profil (neuer Orchestrator + Subagenten). Optional wird direkt ein Ziel gesetzt.',
      parameters: {
        type: 'object',
        properties: {
          profileName: { type: 'string', description: 'Name des Profils, ungefähre Schreibweise erlaubt.' },
          goal: { type: 'string', description: 'Optionales Ziel, das dem Orchestrator übergeben wird.' }
        },
        required: ['profileName']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_to_orchestrator',
      description: 'Sendet eine Textnachricht an den Orchestrator der aktiven oder angegebenen Session.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Nachricht/Anweisung an den Orchestrator.' },
          profileName: { type: 'string', description: 'Optional: Profil, dessen Session gemeint ist.' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_status',
      description: 'Liefert einen kompakten Statusbericht (Ziel, Aktivität, Aufgaben, Findings) zum Verbalisieren.',
      parameters: {
        type: 'object',
        properties: {
          profileName: { type: 'string', description: 'Optional: Profil/Session, die gemeint ist.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'switch_layout',
      description: 'Wechselt das Workspace-Layout der Oberfläche.',
      parameters: {
        type: 'object',
        properties: {
          layout: { type: 'string', enum: [...ALLOWED_LAYOUTS] }
        },
        required: ['layout']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_view',
      description: 'Öffnet eine Ansicht/Navigationsziel in der App (z. B. inbox, canvas, settings).',
      parameters: {
        type: 'object',
        properties: {
          view: { type: 'string', description: 'Zielansicht.' }
        },
        required: ['view']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'stop_agents',
      description:
        'Stoppt alle Agenten (optional nur eines Profils). Destruktiv — erfordert eine ausdrückliche Bestätigung (confirmed=true).',
      parameters: {
        type: 'object',
        properties: {
          profileName: { type: 'string', description: 'Optional: nur Agenten dieses Profils stoppen.' },
          confirmed: { type: 'boolean', description: 'Muss true sein, um wirklich zu stoppen.' }
        }
      }
    }
  }
]

// ---------------------------------------------------------------------------
// Snapshot → compact status projection
// ---------------------------------------------------------------------------

function projectStatus(snapshot: OrchestratorSnapshot | undefined): Record<string, unknown> {
  if (!snapshot) return { available: false }
  const tasks = (snapshot.tasks ?? []).slice(0, 8).map((task) => ({
    title: task.title,
    status: task.status,
    phase: task.phase,
    lastAction: task.lastAction
  }))
  return {
    available: true,
    goal: snapshot.goal?.title ?? null,
    activity: snapshot.activity
      ? { phase: snapshot.activity.phase, summary: snapshot.activity.summary }
      : null,
    tasks,
    findings: (snapshot.findings ?? []).slice(-5).map((f) => f.title),
    pendingPlan: snapshot.pendingPlan ? { planId: snapshot.pendingPlan.planId } : null,
    budget: snapshot.budget
      ? { costUsd: snapshot.budget.costUsd, tokens: snapshot.budget.tokens }
      : undefined
  }
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

function ambiguityOutcome(tool: string, options: AssistantProfile[]): ToolOutcome {
  const names = options.map((o) => o.name)
  return {
    result: {
      ok: false,
      needsClarification: true,
      message: `Mehrere Profile passen: ${names.join(', ')}. Welches ist gemeint?`,
      options: names
    },
    action: { tool, ok: false, summary: `Mehrdeutiger Profilname (${names.join(', ')})` }
  }
}

async function runStartProfile(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolOutcome> {
  const profileName = typeof args.profileName === 'string' ? args.profileName : ''
  const goal = typeof args.goal === 'string' && args.goal.trim() ? args.goal.trim() : undefined
  const resolution = resolveProfile(profileName, ctx.deps.listProfiles())
  if (resolution.status === 'ambiguous') return ambiguityOutcome('start_profile_workspace', resolution.options)
  if (resolution.status === 'none') {
    return {
      result: { ok: false, message: `Kein Profil zu „${profileName}" gefunden.` },
      action: { tool: 'start_profile_workspace', ok: false, summary: `Profil „${profileName}" nicht gefunden` }
    }
  }

  const outcome = await ctx.deps.startProfileWorkspace({ profileId: resolution.profile.id, goal })
  const summary = outcome.ok
    ? `Workspace „${resolution.profile.name}" gestartet (${outcome.agentCount} Agenten${outcome.goalSeeded ? ', Ziel gesetzt' : ''})`
    : `Start von „${resolution.profile.name}" fehlgeschlagen`
  return {
    result: {
      ok: outcome.ok,
      profileName: resolution.profile.name,
      sessionId: outcome.sessionId,
      agentCount: outcome.agentCount,
      goalSeeded: outcome.goalSeeded,
      reason: outcome.reason
    },
    action: { tool: 'start_profile_workspace', ok: outcome.ok, summary, detail: outcome.reason }
  }
}

async function runSendToOrchestrator(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolOutcome> {
  const text = typeof args.text === 'string' ? args.text.trim() : ''
  const profileName = typeof args.profileName === 'string' ? args.profileName : undefined
  if (!text) {
    return {
      result: { ok: false, message: 'Leerer Text.' },
      action: { tool: 'send_to_orchestrator', ok: false, summary: 'Leere Nachricht abgelehnt' }
    }
  }
  const session = resolveTargetSession(profileName, ctx)
  if (session.status === 'ambiguous') return ambiguityOutcome('send_to_orchestrator', session.options)
  if (session.status === 'none') {
    const message = session.profileResolved
      ? 'Für dieses Profil läuft keine Session.'
      : 'Es läuft aktuell keine Workspace-Session.'
    return {
      result: { ok: false, reason: 'no_session', message },
      action: { tool: 'send_to_orchestrator', ok: false, summary: message }
    }
  }

  const seeded = await ctx.deps.seedToOrchestrator(session.session.id, text)
  const summary = seeded
    ? `Nachricht an Orchestrator „${session.session.profileName}" gesendet`
    : `Kein Orchestrator in „${session.session.profileName}" erreichbar`
  return {
    result: { ok: seeded, reason: seeded ? undefined : 'no_orchestrator', sessionId: session.session.id },
    action: { tool: 'send_to_orchestrator', ok: seeded, summary }
  }
}

function runGetStatus(args: Record<string, unknown>, ctx: ToolExecutionContext): ToolOutcome {
  const profileName = typeof args.profileName === 'string' ? args.profileName : undefined
  const session = resolveTargetSession(profileName, ctx)
  if (session.status === 'ambiguous') return ambiguityOutcome('get_status', session.options)
  if (session.status === 'none') {
    return {
      result: { ok: true, running: false, message: 'Es läuft aktuell keine Workspace-Session.' },
      action: { tool: 'get_status', ok: true, summary: 'Status: keine aktive Session' }
    }
  }
  const snapshot = ctx.deps.snapshotForSession(session.session.id)
  return {
    result: {
      ok: true,
      running: true,
      session: { name: session.session.name, profileName: session.session.profileName },
      status: projectStatus(snapshot)
    },
    action: { tool: 'get_status', ok: true, summary: `Status „${session.session.profileName}" abgefragt` }
  }
}

function runSwitchLayout(args: Record<string, unknown>): ToolOutcome {
  const layout = typeof args.layout === 'string' ? args.layout.trim().toLowerCase() : ''
  if (!(ALLOWED_LAYOUTS as readonly string[]).includes(layout)) {
    return {
      result: { ok: false, message: `Unbekanntes Layout „${layout}". Erlaubt: ${ALLOWED_LAYOUTS.join(', ')}.` },
      action: { tool: 'switch_layout', ok: false, summary: `Unbekanntes Layout „${layout}"` }
    }
  }
  return {
    result: { ok: true, layout },
    action: { tool: 'switch_layout', ok: true, summary: `Layout auf „${layout}" gewechselt` },
    uiCommand: { kind: 'switch_layout', layout }
  }
}

function runOpenView(args: Record<string, unknown>): ToolOutcome {
  const view = typeof args.view === 'string' ? args.view.trim() : ''
  if (!view) {
    return {
      result: { ok: false, message: 'Kein Ansichtsname angegeben.' },
      action: { tool: 'open_view', ok: false, summary: 'Leeres Navigationsziel abgelehnt' }
    }
  }
  return {
    result: { ok: true, view },
    action: { tool: 'open_view', ok: true, summary: `Ansicht „${view}" geöffnet` },
    uiCommand: { kind: 'open_view', view }
  }
}

async function runStopAgents(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolOutcome> {
  const profileName = typeof args.profileName === 'string' ? args.profileName : undefined
  const confirmed = args.confirmed === true

  let profileId: string | undefined
  let scopeLabel = 'alle Agenten'
  if (profileName?.trim()) {
    const resolution = resolveProfile(profileName, ctx.deps.listProfiles())
    if (resolution.status === 'ambiguous') return ambiguityOutcome('stop_agents', resolution.options)
    if (resolution.status === 'none') {
      return {
        result: { ok: false, message: `Kein Profil zu „${profileName}" gefunden.` },
        action: { tool: 'stop_agents', ok: false, summary: `Profil „${profileName}" nicht gefunden` }
      }
    }
    profileId = resolution.profile.id
    scopeLabel = `alle Agenten von „${resolution.profile.name}"`
  }

  if (!confirmed) {
    const prompt = `Wirklich ${scopeLabel} stoppen?`
    return {
      result: { ok: false, needsConfirmation: true, prompt },
      confirmation: { tool: 'stop_agents', prompt, args: { profileName, confirmed: true } }
    }
  }

  const stopped = await ctx.deps.stopAgents(profileId)
  return {
    result: { ok: true, stopped },
    action: { tool: 'stop_agents', ok: true, summary: `${stopped} Agent(en) gestoppt (${scopeLabel})` }
  }
}

/** Execute one tool call by name. Unknown tools return an error payload, never throw. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolOutcome> {
  switch (name) {
    case 'start_profile_workspace':
      return runStartProfile(args, ctx)
    case 'send_to_orchestrator':
      return runSendToOrchestrator(args, ctx)
    case 'get_status':
      return runGetStatus(args, ctx)
    case 'switch_layout':
      return runSwitchLayout(args)
    case 'open_view':
      return runOpenView(args)
    case 'stop_agents':
      return runStopAgents(args, ctx)
    default:
      return {
        result: { ok: false, message: `Unbekanntes Tool „${name}".` },
        action: { tool: name, ok: false, summary: `Unbekanntes Tool „${name}"` }
      }
  }
}

/** Parse tool-call argument JSON defensively; malformed JSON yields an empty object. */
export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw?.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
