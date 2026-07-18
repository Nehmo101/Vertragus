/**
 * Exchangeable voice provider interfaces (main process only).
 *
 * Besides speech-to-text this module also carries the abstract chat and
 * text-to-speech provider contracts used by the free voice assistant
 * (WS-C2). Keeping the interfaces abstract leaves a clean upgrade path to a
 * future realtime provider without touching the assistant service.
 */
import type { Buffer } from 'node:buffer'
import { isPrivateOrLocalHost, ALLOWED_TRANSCRIPTION_HOSTS } from '@shared/inboxSpeechEndpoint'

export interface TranscriptionRequest {
  audio: Buffer
  mimeType: string
  model: string
  language: string
  endpointUrl: string
  apiKey: string
  signal?: AbortSignal
}

export interface TranscriptionProvider {
  transcribe(req: TranscriptionRequest): Promise<string>
}

// ---------------------------------------------------------------------------
// Chat provider (OpenAI-compatible /chat/completions with tool calls)
// ---------------------------------------------------------------------------

export interface ChatToolFunction {
  name: string
  description: string
  /** JSON schema for the tool arguments. */
  parameters: Record<string, unknown>
}

export interface ChatTool {
  type: 'function'
  function: ChatToolFunction
}

export interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  role: ChatRole
  content: string | null
  tool_calls?: ChatToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ChatCompletionRequest {
  messages: ChatMessage[]
  tools?: ChatTool[]
  model: string
  endpointUrl: string
  apiKey: string
  temperature?: number
  signal?: AbortSignal
}

export interface ChatCompletionChoice {
  content: string | null
  toolCalls: ChatToolCall[]
}

export interface ChatProvider {
  complete(req: ChatCompletionRequest): Promise<ChatCompletionChoice>
}

// ---------------------------------------------------------------------------
// Text-to-speech provider (OpenAI-compatible /audio/speech)
// ---------------------------------------------------------------------------

export interface TtsRequest {
  text: string
  model: string
  voice: string
  /** Response audio container, e.g. `mp3`. */
  format: string
  endpointUrl: string
  apiKey: string
  signal?: AbortSignal
}

export interface TtsProvider {
  synthesize(req: TtsRequest): Promise<Buffer>
}

// ---------------------------------------------------------------------------
// Feature-local endpoint hardening (SSRF guard shared with transcription).
// ---------------------------------------------------------------------------

/**
 * Validate + normalize a voice-assistant endpoint URL. Reuses the transcription
 * SSRF allowlist (`api.openai.com`, no private/local hosts) but pins the path to
 * the endpoint kind so a stored URL cannot redirect an API key elsewhere.
 */
export function validateVoiceEndpointUrl(raw: string, requiredPath: string): string {
  const endpointUrl = raw.trim()
  if (!endpointUrl) throw new Error('Endpunkt-URL darf nicht leer sein.')

  let url: URL
  try {
    url = new URL(endpointUrl)
  } catch {
    throw new Error('Endpunkt-URL ist ungültig.')
  }

  if (url.protocol !== 'https:') {
    throw new Error('Nur HTTPS-Endpunkte sind für den Sprachassistenten erlaubt.')
  }

  const host = url.hostname.toLowerCase()
  if (isPrivateOrLocalHost(host)) {
    throw new Error('Lokale oder private Endpunkte sind nicht erlaubt.')
  }
  if (!ALLOWED_TRANSCRIPTION_HOSTS.has(host)) {
    throw new Error(`Host "${url.hostname}" ist für den Sprachassistenten nicht freigegeben.`)
  }
  if (url.username || url.password) {
    throw new Error('Anmeldedaten in der URL sind nicht erlaubt.')
  }

  const path = url.pathname.replace(/\/+$/, '') || '/'
  if (path !== requiredPath) {
    throw new Error(`Pfad muss ${requiredPath} sein.`)
  }
  return `${url.origin}${requiredPath}`
}

// ---------------------------------------------------------------------------
// Voice assistant service contract (feature-local; mirrored 1:1 by the
// integrator into src/shared/voiceAssistant.ts).
// ---------------------------------------------------------------------------

export interface VoiceAssistantHistoryEntry {
  role: 'user' | 'assistant'
  content: string
}

export interface VoiceAssistantUiState {
  layout?: string
  view?: string
  activeSessionId?: string
  activeProfileId?: string
}

export interface VoiceAssistantAudioInput {
  bytes: Uint8Array | ArrayBuffer | Buffer
  mimeType: string
  durationMs: number
}

export interface VoiceAssistantTurnRequest {
  audio?: VoiceAssistantAudioInput
  /** When set, STT is skipped and this text is used as the user turn. */
  text?: string
  history?: VoiceAssistantHistoryEntry[]
  uiState?: VoiceAssistantUiState
}

export type UiCommandKind = 'switch_layout' | 'open_view' | 'set_active_session'

export interface UiCommand {
  kind: UiCommandKind
  layout?: string
  view?: string
  sessionId?: string
  profileId?: string
}

/** One executed side-effect, kept for an auditable turn trail. */
export interface ExecutedAction {
  tool: string
  ok: boolean
  summary: string
  detail?: string
}

export interface VoiceAssistantConfirmation {
  tool: string
  prompt: string
  args: Record<string, unknown>
}

export interface VoiceAssistantReplyAudio {
  bytes: Uint8Array
  mimeType: string
}

export interface VoiceAssistantTurnResult {
  ok: boolean
  transcript: string
  replyText: string
  replyAudio?: VoiceAssistantReplyAudio | null
  actions: ExecutedAction[]
  uiCommands: UiCommand[]
  confirmationRequired?: VoiceAssistantConfirmation | null
  error?: string
}

export type VoiceAssistantStage =
  | 'transcribing'
  | 'thinking'
  | 'acting'
  | 'speaking'
  | 'done'
  | 'error'

export interface VoiceAssistantProgressEvent {
  stage: VoiceAssistantStage
  tool?: string
  detail?: string
}

export interface VoiceAssistantSettings {
  chatModel: string
  chatEndpointUrl: string
  ttsModel: string
  ttsVoice: string
  ttsFormat: string
  ttsEndpointUrl: string
  ttsEnabled: boolean
  hasChatApiKey: boolean
  hasTtsApiKey: boolean
  /** True when chat falls back to the shared transcription key. */
  usesTranscriptionKeyForChat: boolean
  /** True when TTS falls back to the shared transcription key. */
  usesTranscriptionKeyForTts: boolean
}

export interface VoiceAssistantSettingsPatch {
  chatModel?: string
  chatEndpointUrl?: string
  ttsModel?: string
  ttsVoice?: string
  ttsFormat?: string
  ttsEndpointUrl?: string
  ttsEnabled?: boolean
  /** Empty string clears the separate chat key (falls back to transcription). */
  chatApiKey?: string
  /** Empty string clears the separate TTS key (falls back to transcription). */
  ttsApiKey?: string
}
