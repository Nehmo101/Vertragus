/**
 * Pure, testable helpers for the integrator-owned voice + canvas IPC handlers.
 *
 * Keeping the sender guards, the flat↔nested request/result adaptation, and the
 * orchestrator:send resolution here (instead of inline in `ipc/register.ts`)
 * lets them be unit tested — including the mandatory authorization and
 * validation negative cases — without standing up an Electron window.
 */
import type {
  VoiceAssistantTurnRequest,
  VoiceAssistantTurnResult
} from '@main/voice/types'
import type {
  OrchestratorSendResult,
  VoiceOverlayTurnRequest,
  VoiceOverlayTurnResult
} from '@shared/voiceAssistant'

export const VOICE_WINDOW_FORBIDDEN =
  'Der Sprachassistent hat keinen direkten Agent- oder Spawn-Zugriff.'
export const VOICE_TURN_FORBIDDEN = 'Sprachassistent-Turns sind nur aus dem Overlay erlaubt.'
export const OVERLAY_CONTROL_FORBIDDEN = 'Overlay-Steuerung ist hier nicht erlaubt.'

/** The voice overlay window must never reach a privileged agent/spawn channel. */
export function guardNotVoiceWindow(isVoiceWindow: boolean): void {
  if (isVoiceWindow) throw new Error(VOICE_WINDOW_FORBIDDEN)
}

/** Only the overlay window (or the main window as host) may run a voice turn. */
export function guardVoiceTurnAllowed(isVoiceWindow: boolean, isMainWindow: boolean): void {
  if (!isVoiceWindow && !isMainWindow) throw new Error(VOICE_TURN_FORBIDDEN)
}

/** hide/moved may only be driven by the overlay window itself or the main window. */
export function guardOverlayControl(isVoiceWindow: boolean, isMainWindow: boolean): void {
  if (!isVoiceWindow && !isMainWindow) throw new Error(OVERLAY_CONTROL_FORBIDDEN)
}

/**
 * Adapt the flat renderer overlay request into the nested main-process request.
 * Text takes precedence over audio; malformed history entries are dropped; a
 * missing mime type / duration fall back to safe defaults.
 */
export function adaptVoiceTurnRequest(
  raw: VoiceOverlayTurnRequest | undefined | null
): VoiceAssistantTurnRequest {
  const request = raw ?? ({ history: [] } as VoiceOverlayTurnRequest)
  const typed = typeof request.text === 'string' && request.text.trim() ? request.text : undefined
  const history = Array.isArray(request.history)
    ? request.history
        .filter((turn) => turn && typeof turn.content === 'string' && turn.content.trim().length > 0)
        .map((turn) => ({
          role: turn.role === 'assistant' ? ('assistant' as const) : ('user' as const),
          content: turn.content
        }))
    : []
  return {
    text: typed,
    audio:
      !typed && request.audio
        ? {
            bytes: request.audio,
            mimeType: typeof request.mimeType === 'string' && request.mimeType ? request.mimeType : 'audio/webm',
            durationMs: Number.isFinite(request.durationMs) ? Number(request.durationMs) : 0
          }
        : undefined,
    history
  }
}

/** Flatten the nested main-process result into the flat shape the overlay reads. */
export function adaptVoiceTurnResult(result: VoiceAssistantTurnResult): VoiceOverlayTurnResult {
  return {
    ok: result.ok,
    transcript: result.transcript,
    replyText: result.replyText,
    replyAudio: result.replyAudio ? result.replyAudio.bytes : null,
    confirmationRequired: result.confirmationRequired
      ? { tool: result.confirmationRequired.tool, prompt: result.confirmationRequired.prompt }
      : null,
    reason: result.error
  }
}

export interface OrchestratorSendDeps {
  hasProfile(profileId: string): boolean
  activeSessionId(profileId: string): string | undefined
  findOrchestratorId(sessionId: string): string | undefined
  seed(agentId: string, text: string): Promise<boolean>
}

/**
 * Resolve a canvas-composer orchestrator send: validate inputs, resolve the
 * target session + orchestrator agent, and seed the message. Authorization
 * (main-window only) is enforced by the caller before this runs.
 */
export async function resolveOrchestratorSend(
  deps: OrchestratorSendDeps,
  profileId: unknown,
  workspaceSessionId: unknown,
  text: unknown
): Promise<OrchestratorSendResult> {
  const id = typeof profileId === 'string' ? profileId : ''
  const message = typeof text === 'string' ? text.trim() : ''
  if (!id || !message) return { ok: false, reason: 'invalid' }
  if (!deps.hasProfile(id)) return { ok: false, reason: 'profile_not_found' }
  const sessionId =
    typeof workspaceSessionId === 'string' && workspaceSessionId
      ? workspaceSessionId
      : deps.activeSessionId(id)
  if (!sessionId) return { ok: false, reason: 'no_orchestrator' }
  const orchestratorId = deps.findOrchestratorId(sessionId)
  if (!orchestratorId) return { ok: false, reason: 'no_orchestrator' }
  const seeded = await deps.seed(orchestratorId, message)
  return seeded ? { ok: true } : { ok: false, reason: 'seed_failed' }
}
