/**
 * Shared voice-assistant + voice-overlay contract (the integrator-owned mirror
 * of the feature-local main types in `src/main/voice/types.ts`).
 *
 * Two shapes live here on purpose:
 *  - The *renderer-facing* overlay contract (`VoiceOverlayTurnRequest` /
 *    `VoiceOverlayTurnResult`) is deliberately FLAT: the overlay hook builds a
 *    raw `Uint8Array` of audio and reads a raw `Uint8Array` reply back. The
 *    `voiceAssistant:turn` IPC handler adapts this flat shape to/from the nested
 *    main-process `VoiceAssistantTurnRequest`/`VoiceAssistantTurnResult`.
 *  - The progress / ui-command / settings types are mirrored 1:1 with the main
 *    process so the same objects cross the IPC boundary unchanged.
 *
 * API keys never appear in any type here — settings expose booleans only.
 */

export interface VoiceOverlayHistoryTurn {
  role: 'user' | 'assistant'
  content: string
}

/** Flat request the overlay sends over IPC (adapted to the nested main request). */
export interface VoiceOverlayTurnRequest {
  /** Raw captured audio; omitted when the user typed text instead. */
  audio?: Uint8Array
  /** MIME type of `audio` (e.g. `audio/webm`); ignored when `text` is set. */
  mimeType?: string
  /** Recorded duration in ms; the overlay may omit it (defaults to 0). */
  durationMs?: number
  /** When set, transcription is skipped and this text is the user turn. */
  text?: string
  /** Last few turns for stateless context (already trimmed by the overlay). */
  history: VoiceOverlayHistoryTurn[]
}

/** Confirmation surfaced to the overlay for a destructive tool (e.g. stop_agents). */
export interface VoiceOverlayConfirmation {
  tool?: string
  prompt: string
}

/** Flat result the overlay consumes (raw reply audio bytes, no envelope). */
export interface VoiceOverlayTurnResult {
  ok: boolean
  transcript?: string
  replyText?: string
  /** Raw synthesized speech, played as an audio blob; null when TTS is off. */
  replyAudio?: Uint8Array | null
  confirmationRequired?: VoiceOverlayConfirmation | null
  /** Machine-readable failure hint (mirrors the main result `error`). */
  reason?: string
}

export type VoiceAssistantStage =
  | 'transcribing'
  | 'thinking'
  | 'acting'
  | 'speaking'
  | 'done'
  | 'error'

/**
 * Progress event pushed on `ev:voiceAssistant`. `stage`/`tool`/`detail` mirror
 * the main event; `error` is filled by the handler on the `error` stage so the
 * overlay can render a reason without reaching into `detail`.
 */
export interface VoiceAssistantProgressEvent {
  stage: VoiceAssistantStage
  tool?: string
  detail?: string
  error?: string
}

export type VoiceUiCommandKind = 'switch_layout' | 'open_view' | 'set_active_session'

/** A UI navigation side-effect requested by an assistant tool, pushed on `ev:uiCommand`. */
export interface VoiceUiCommand {
  kind: VoiceUiCommandKind
  layout?: string
  view?: string
  sessionId?: string
  profileId?: string
}

/** Settings surface for the assistant. Key presence is exposed as booleans only. */
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
  usesTranscriptionKeyForChat: boolean
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

/** Result of seeding the orchestrator agent from the canvas composer. */
export interface OrchestratorSendResult {
  ok: boolean
  reason?: 'invalid' | 'profile_not_found' | 'no_orchestrator' | 'seed_failed' | string
}
