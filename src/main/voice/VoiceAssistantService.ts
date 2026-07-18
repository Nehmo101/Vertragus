/**
 * Free voice assistant brain (WS-C2), main process only.
 *
 * Turn pipeline: STT (reuses `transcribeInboxAudio`) → chat/completions with a
 * bounded tool loop → optional TTS. The service is stateless: conversation
 * history is supplied per request by the caller (overlay), so a main-process
 * restart never strands a session. API keys never leave the main process — they
 * only enter provider Authorization headers and are redacted from every value
 * returned to the caller.
 */
import { getSetting, setSetting } from '@main/config/store'
import {
  hasChatApiKey,
  hasSeparateChatApiKey,
  hasSeparateTtsApiKey,
  hasTtsApiKey,
  readChatApiKey,
  readTtsApiKey,
  writeChatApiKey,
  clearChatApiKey,
  writeTtsApiKey,
  clearTtsApiKey
} from '@main/config/secrets'
import { OpenAIChatProvider } from '@main/voice/OpenAIChatProvider'
import { OpenAITtsProvider } from '@main/voice/OpenAITtsProvider'
import {
  executeTool,
  parseToolArguments,
  TOOL_DEFINITIONS,
  type VoiceAssistantDeps
} from '@main/voice/assistantTools'
import {
  validateVoiceEndpointUrl,
  type ChatMessage,
  type ChatProvider,
  type ExecutedAction,
  type TtsProvider,
  type UiCommand,
  type VoiceAssistantConfirmation,
  type VoiceAssistantProgressEvent,
  type VoiceAssistantSettings,
  type VoiceAssistantSettingsPatch,
  type VoiceAssistantTurnRequest,
  type VoiceAssistantTurnResult
} from '@main/voice/types'

// ---------------------------------------------------------------------------
// Defaults & settings keys
// ---------------------------------------------------------------------------

const DEFAULT_CHAT_MODEL = 'gpt-4o-mini'
const DEFAULT_CHAT_ENDPOINT = 'https://api.openai.com/v1/chat/completions'
const CHAT_PATH = '/v1/chat/completions'
const DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts'
const DEFAULT_TTS_VOICE = 'alloy'
const DEFAULT_TTS_FORMAT = 'mp3'
const DEFAULT_TTS_ENDPOINT = 'https://api.openai.com/v1/audio/speech'
const TTS_PATH = '/v1/audio/speech'

const S_CHAT_MODEL = 'voiceAssistant.chatModel'
const S_CHAT_ENDPOINT = 'voiceAssistant.chatEndpointUrl'
const S_TTS_MODEL = 'voiceAssistant.ttsModel'
const S_TTS_VOICE = 'voiceAssistant.ttsVoice'
const S_TTS_FORMAT = 'voiceAssistant.ttsFormat'
const S_TTS_ENDPOINT = 'voiceAssistant.ttsEndpointUrl'
const S_TTS_ENABLED = 'voiceAssistant.ttsEnabled'

const MAX_TOOL_ITERATIONS = 4
const CONTEXT_CHAR_CAP = 7000

const TTS_MIME_BY_FORMAT: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm'
}

// ---------------------------------------------------------------------------
// Provider / dependency injection (test hooks)
// ---------------------------------------------------------------------------

type TranscribeFn = (payload: {
  mimeType: string
  bytes: Uint8Array | ArrayBuffer | Buffer
  durationMs: number
}) => Promise<{ ok: true; text: string } | { ok: false; code: string; message: string }>

let chatProvider: ChatProvider = new OpenAIChatProvider()
let ttsProvider: TtsProvider = new OpenAITtsProvider()
let transcribeOverride: TranscribeFn | null = null
let depsOverride: VoiceAssistantDeps | null = null

/** Test hook: inject a mock chat provider. */
export function __setChatProviderForTest(provider: ChatProvider): void {
  chatProvider = provider
}
/** Test hook: inject a mock TTS provider. */
export function __setTtsProviderForTest(provider: TtsProvider): void {
  ttsProvider = provider
}
/** Test hook: inject a mock transcription function. */
export function __setTranscribeForTest(fn: TranscribeFn | null): void {
  transcribeOverride = fn
}
/** Test hook: inject mock main-process dependencies. */
export function __setDepsForTest(deps: VoiceAssistantDeps | null): void {
  depsOverride = deps
}

async function runTranscribe(payload: Parameters<TranscribeFn>[0]): ReturnType<TranscribeFn> {
  if (transcribeOverride) return transcribeOverride(payload)
  const { transcribeInboxAudio } = await import('@main/voice/InboxSpeechService')
  return transcribeInboxAudio(payload)
}

/** Wire the tools to the real main-process functions (lazy so tests stay light). */
async function buildProductionDeps(): Promise<VoiceAssistantDeps> {
  const [agents, sessionsMod, spawnMod, repoMod, storeMod] = await Promise.all([
    import('@main/agents/AgentManager'),
    import('@main/orchestrator/WorkspaceSessionRegistry'),
    import('@main/agents/spawnProfile'),
    import('@main/config/workspaceRepo'),
    import('@main/config/store')
  ])
  const { agentManager } = agents
  const { workspaceSessions } = sessionsMod
  const { spawnProfileTeam } = spawnMod
  const { getActiveRepoOverridePath } = repoMod
  const { getProfile, listProfiles } = storeMod

  return {
    listProfiles: () => listProfiles().map((p) => ({ id: p.id, name: p.name })),
    listSessions: () => workspaceSessions.list(),
    listAgents: () => agentManager.list(),
    snapshotForSession: (sessionId) => workspaceSessions.getById(sessionId)?.engine.snapshot(),
    startProfileWorkspace: async ({ profileId, goal }) => {
      const profile = getProfile(profileId)
      if (!profile) {
        return { ok: false, agentCount: 0, goalSeeded: false, reason: 'profile_not_found' }
      }
      const override = getActiveRepoOverridePath()
      const spawned = await spawnProfileTeam(
        profile,
        false,
        override ? { workingDirOverride: override } : undefined
      )
      const orchestrator = spawned.find((a) => a.kind === 'orchestrator')
      const sessionId = orchestrator?.workspaceSessionId
      let goalSeeded = false
      if (goal && orchestrator && sessionId) {
        workspaceSessions.getById(sessionId)?.engine.setGoal(goal)
        // Seeding waits for the CLI boot handshake; fire-and-forget like the
        // inbox transfer so the voice turn returns promptly.
        void agentManager.seedInteractive(orchestrator.id, goal)
        goalSeeded = true
      }
      return {
        ok: Boolean(orchestrator),
        sessionId,
        orchestratorId: orchestrator?.id,
        agentCount: spawned.length,
        goalSeeded,
        reason: orchestrator ? undefined : 'no_orchestrator'
      }
    },
    seedToOrchestrator: async (sessionId, text) => {
      const orchestrator = agentManager
        .list()
        .find((a) => a.workspaceSessionId === sessionId && a.kind === 'orchestrator')
      if (!orchestrator) return false
      void agentManager.seedInteractive(orchestrator.id, text)
      return true
    },
    stopAgents: async (profileId) => {
      const running = agentManager.list(profileId).filter((a) => a.status !== 'stopped').length
      await agentManager.killAll(profileId)
      return running
    }
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function safeEndpoint(raw: string | undefined, path: string, fallback: string): string {
  const candidate = raw?.trim() || fallback
  try {
    return validateVoiceEndpointUrl(candidate, path)
  } catch {
    return fallback
  }
}

export function getVoiceAssistantSettings(): VoiceAssistantSettings {
  return {
    chatModel: getSetting<string>(S_CHAT_MODEL)?.trim() || DEFAULT_CHAT_MODEL,
    chatEndpointUrl: safeEndpoint(getSetting<string>(S_CHAT_ENDPOINT), CHAT_PATH, DEFAULT_CHAT_ENDPOINT),
    ttsModel: getSetting<string>(S_TTS_MODEL)?.trim() || DEFAULT_TTS_MODEL,
    ttsVoice: getSetting<string>(S_TTS_VOICE)?.trim() || DEFAULT_TTS_VOICE,
    ttsFormat: getSetting<string>(S_TTS_FORMAT)?.trim() || DEFAULT_TTS_FORMAT,
    ttsEndpointUrl: safeEndpoint(getSetting<string>(S_TTS_ENDPOINT), TTS_PATH, DEFAULT_TTS_ENDPOINT),
    ttsEnabled: getSetting<boolean>(S_TTS_ENABLED) ?? true,
    hasChatApiKey: hasChatApiKey(),
    hasTtsApiKey: hasTtsApiKey(),
    usesTranscriptionKeyForChat: !hasSeparateChatApiKey(),
    usesTranscriptionKeyForTts: !hasSeparateTtsApiKey()
  }
}

export function setVoiceAssistantSettings(patch: VoiceAssistantSettingsPatch): VoiceAssistantSettings {
  if (patch.chatModel !== undefined) {
    const model = patch.chatModel.trim()
    if (!model) throw new Error('Chat-Modell darf nicht leer sein.')
    setSetting(S_CHAT_MODEL, model)
  }
  if (patch.chatEndpointUrl !== undefined) {
    setSetting(S_CHAT_ENDPOINT, validateVoiceEndpointUrl(patch.chatEndpointUrl, CHAT_PATH))
  }
  if (patch.ttsModel !== undefined) {
    const model = patch.ttsModel.trim()
    if (!model) throw new Error('TTS-Modell darf nicht leer sein.')
    setSetting(S_TTS_MODEL, model)
  }
  if (patch.ttsVoice !== undefined) {
    const voice = patch.ttsVoice.trim()
    if (!voice) throw new Error('TTS-Stimme darf nicht leer sein.')
    setSetting(S_TTS_VOICE, voice)
  }
  if (patch.ttsFormat !== undefined) {
    const format = patch.ttsFormat.trim().toLowerCase()
    if (!TTS_MIME_BY_FORMAT[format]) {
      throw new Error(`Unbekanntes TTS-Format „${patch.ttsFormat}".`)
    }
    setSetting(S_TTS_FORMAT, format)
  }
  if (patch.ttsEndpointUrl !== undefined) {
    setSetting(S_TTS_ENDPOINT, validateVoiceEndpointUrl(patch.ttsEndpointUrl, TTS_PATH))
  }
  if (patch.ttsEnabled !== undefined) {
    setSetting(S_TTS_ENABLED, Boolean(patch.ttsEnabled))
  }
  if (patch.chatApiKey !== undefined) {
    if (!patch.chatApiKey.trim()) clearChatApiKey()
    else writeChatApiKey(patch.chatApiKey)
  }
  if (patch.ttsApiKey !== undefined) {
    if (!patch.ttsApiKey.trim()) clearTtsApiKey()
    else writeTtsApiKey(patch.ttsApiKey)
  }
  return getVoiceAssistantSettings()
}

// ---------------------------------------------------------------------------
// Context & prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'Du bist der Sprachassistent von Vertragus, einem Control-Center für KI-Agenten-Teams.',
  'Antworte kurz, natürlich und auf Deutsch — deine Antwort wird vorgelesen.',
  'Du kennst das App-Layout und den Live-Zustand über den mitgelieferten Kontext.',
  'Nutze Werkzeuge, um Aktionen auszuführen (Profil starten, an den Orchestrator senden,',
  'Status abrufen, Layout/Ansicht wechseln, Agenten stoppen). Erfinde keine Fakten:',
  'stützt dich auf Kontext und Tool-Ergebnisse. Bei mehrdeutigen Profilnamen frage nach.',
  'Destruktive Aktionen (Agenten stoppen) nur nach ausdrücklicher Bestätigung ausführen.'
].join(' ')

function clamp(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}… [gekürzt]` : value
}

function buildContext(deps: VoiceAssistantDeps, req: VoiceAssistantTurnRequest): string {
  const sessions = deps.listSessions().slice(0, 8)
  const agents = deps.listAgents().slice(0, 20)
  const context = {
    ui: req.uiState ?? {},
    profiles: deps.listProfiles().map((p) => ({ id: p.id, name: p.name })),
    sessions: sessions.map((s) => ({
      id: s.id,
      profileName: s.profileName,
      name: s.name,
      active: s.active,
      taskSummary: s.taskSummary
    })),
    agents: agents.map((a) => ({ name: a.name, role: a.role, kind: a.kind, status: a.status })),
    orchestrators: sessions
      .filter((s) => s.active)
      .map((s) => {
        const snap = deps.snapshotForSession(s.id)
        if (!snap) return { session: s.name, available: false }
        return {
          session: s.name,
          profileName: s.profileName,
          goal: snap.goal?.title ?? null,
          activity: snap.activity
            ? { phase: snap.activity.phase, summary: snap.activity.summary }
            : null,
          tasks: (snap.tasks ?? []).slice(0, 6).map((t) => ({
            title: t.title,
            status: t.status,
            phase: t.phase,
            lastAction: t.lastAction
          })),
          findings: (snap.findings ?? []).slice(-5).map((f) => f.title),
          pendingPlan: snap.pendingPlan ? { planId: snap.pendingPlan.planId } : null,
          budget: snap.budget ? { tokens: snap.budget.tokens, costUsd: snap.budget.costUsd } : undefined
        }
      })
  }
  return clamp(JSON.stringify(context), CONTEXT_CHAR_CAP)
}

// ---------------------------------------------------------------------------
// Secret redaction (defence in depth: keys must never appear in output)
// ---------------------------------------------------------------------------

function redactSecrets(value: string, secrets: string[]): string {
  let out = value
  for (const secret of secrets) {
    if (secret && secret.length >= 8 && out.includes(secret)) {
      out = out.split(secret).join('«redigiert»')
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Turn pipeline
// ---------------------------------------------------------------------------

function emptyResult(overrides: Partial<VoiceAssistantTurnResult>): VoiceAssistantTurnResult {
  return {
    ok: false,
    transcript: '',
    replyText: '',
    replyAudio: null,
    actions: [],
    uiCommands: [],
    confirmationRequired: null,
    ...overrides
  }
}

export async function runVoiceAssistantTurn(
  req: VoiceAssistantTurnRequest,
  onProgress?: (event: VoiceAssistantProgressEvent) => void,
  override?: VoiceAssistantDeps
): Promise<VoiceAssistantTurnResult> {
  const progress = (event: VoiceAssistantProgressEvent): void => {
    try {
      onProgress?.(event)
    } catch {
      /* progress sinks must never break a turn */
    }
  }
  const settings = getVoiceAssistantSettings()
  const chatApiKey = readChatApiKey()
  const ttsApiKey = readTtsApiKey()
  const secrets = [chatApiKey, ttsApiKey].filter((s): s is string => Boolean(s))
  const redact = (text: string): string => redactSecrets(text, secrets)

  // 1) Transcript
  let transcript = ''
  const typed = req.text?.trim()
  if (typed) {
    transcript = typed
  } else if (req.audio) {
    progress({ stage: 'transcribing' })
    const stt = await runTranscribe({
      mimeType: req.audio.mimeType,
      bytes: req.audio.bytes,
      durationMs: req.audio.durationMs
    })
    if (!stt.ok) {
      progress({ stage: 'error', detail: stt.code })
      return emptyResult({ error: redact(stt.message) })
    }
    transcript = stt.text
  } else {
    return emptyResult({ error: 'Kein Text und kein Audio übergeben.' })
  }

  if (!chatApiKey) {
    progress({ stage: 'error', detail: 'no_api_key' })
    return emptyResult({ transcript, error: 'Kein API-Schlüssel für den Chat-Dienst konfiguriert.' })
  }

  const deps = override ?? depsOverride ?? (await buildProductionDeps())

  // 2) Context + message thread
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: `Aktueller App-Kontext (JSON):\n${buildContext(deps, req)}` }
  ]
  for (const entry of req.history ?? []) {
    if (entry.content?.trim()) messages.push({ role: entry.role, content: entry.content })
  }
  messages.push({ role: 'user', content: transcript })

  // 3) Bounded tool loop
  const actions: ExecutedAction[] = []
  const uiCommands: UiCommand[] = []
  let confirmation: VoiceAssistantConfirmation | null = null
  let replyText = ''

  try {
    let finished = false
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      progress({ stage: 'thinking' })
      const choice = await chatProvider.complete({
        messages,
        tools: TOOL_DEFINITIONS,
        model: settings.chatModel,
        endpointUrl: settings.chatEndpointUrl,
        apiKey: chatApiKey
      })
      if (choice.toolCalls.length === 0) {
        replyText = choice.content?.trim() ?? ''
        finished = true
        break
      }
      messages.push({ role: 'assistant', content: choice.content, tool_calls: choice.toolCalls })
      for (const call of choice.toolCalls) {
        const args = parseToolArguments(call.function.arguments)
        progress({ stage: 'acting', tool: call.function.name })
        const outcome = await executeTool(call.function.name, args, { deps, uiState: req.uiState })
        if (outcome.action) actions.push(outcome.action)
        if (outcome.uiCommand) uiCommands.push(outcome.uiCommand)
        if (outcome.confirmation) confirmation = outcome.confirmation
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify(outcome.result)
        })
      }
    }

    // The model still wanted tools after the cap: force a closing spoken reply.
    if (!finished) {
      progress({ stage: 'thinking' })
      const closing = await chatProvider.complete({
        messages,
        model: settings.chatModel,
        endpointUrl: settings.chatEndpointUrl,
        apiKey: chatApiKey
      })
      replyText = closing.content?.trim() ?? ''
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    progress({ stage: 'error', detail: 'chat_failed' })
    return emptyResult({ transcript, actions, uiCommands, error: redact(message) })
  }

  if (!replyText) {
    replyText = confirmation ? confirmation.prompt : 'Erledigt.'
  }
  replyText = redact(replyText)

  // 4) TTS (optional)
  let replyAudio: VoiceAssistantTurnResult['replyAudio'] = null
  if (settings.ttsEnabled && ttsApiKey && replyText) {
    progress({ stage: 'speaking' })
    try {
      const audio = await ttsProvider.synthesize({
        text: replyText,
        model: settings.ttsModel,
        voice: settings.ttsVoice,
        format: settings.ttsFormat,
        endpointUrl: settings.ttsEndpointUrl,
        apiKey: ttsApiKey
      })
      replyAudio = {
        bytes: Uint8Array.from(audio),
        mimeType: TTS_MIME_BY_FORMAT[settings.ttsFormat] ?? 'audio/mpeg'
      }
    } catch {
      // TTS is best-effort; the spoken text stays visible even if synthesis fails.
      replyAudio = null
    }
  }

  progress({ stage: 'done' })
  return {
    ok: true,
    transcript,
    replyText,
    replyAudio,
    actions: actions.map((a) => ({ ...a, summary: redact(a.summary), detail: a.detail ? redact(a.detail) : undefined })),
    uiCommands,
    confirmationRequired: confirmation
  }
}
