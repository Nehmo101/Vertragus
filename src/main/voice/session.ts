/**
 * Voice session state machine. Listening uses cheap local VAD + STT bursts;
 * the realtime socket is opened only after a wake hit so idle time does not
 * bill Speech-to-Speech.
 *
 * After `session.update`, this waits for `session.updated` (timeout ~2s)
 * before any item, response.create, or input audio. Sending those frames
 * earlier is a race the server drops — the silent-reply bug.
 */
import {
  executeCommand,
  VOICE_TOOLS,
  type VoiceHost,
  type VoiceLocale
} from '@shared/voice/commands'
import {
  SESSION_UPDATED_TIMEOUT_MS,
  VoiceClientError,
  type VoiceClient,
  type VoiceFunctionCall,
  type VoiceProvider,
  type VoiceRealtimeHandlers
} from './client'
import { buildVoiceInstructions } from '@shared/voice/instructions'
import { createVad, type Vad, type VadEvent } from './vad'
import { matchWakePhrase } from '@shared/voice/wakePhrase'

export type VoicePhase = 'idle' | 'listening' | 'engaged' | 'error'

export interface VoiceSessionConfig {
  wakePhrase: string
  voiceId: string
  locale: VoiceLocale
  /** Default xAI. Selects the empty-remainder greeting (force_message vs user text). */
  provider?: VoiceProvider
  idleTimeoutMs?: number
  /** Override for tests. Production default is {@link SESSION_UPDATED_TIMEOUT_MS}. */
  sessionUpdatedTimeoutMs?: number
}

export interface VoiceSessionDeps {
  host: VoiceHost
  client: VoiceClient
  config: VoiceSessionConfig
  onPhase?: (phase: VoicePhase) => void
  onTranscript?: (text: string, origin: 'user' | 'assistant') => void
  onAudioOut?: (pcm: Int16Array) => void
  onError?: (message: string) => void
  waitForPlayback?: () => Promise<void>
  setTimeout?: (handler: () => void, timeout: number) => unknown
  clearTimeout?: (id: unknown) => void
}

export interface VoiceSession {
  readonly phase: VoicePhase
  start(): void
  stop(): void
  pushPcm(pcm: Int16Array): Promise<void>
}

export function createVoiceSession(deps: VoiceSessionDeps): VoiceSession {
  const idleTimeoutMs = deps.config.idleTimeoutMs ?? 20_000
  const sessionUpdatedTimeoutMs = deps.config.sessionUpdatedTimeoutMs ?? SESSION_UPDATED_TIMEOUT_MS
  const waitForPlayback = deps.waitForPlayback ?? (async () => undefined)
  const scheduleTimeout = deps.setTimeout ?? ((handler: () => void, timeout: number) => setTimeout(handler, timeout))
  const cancelTimeout = deps.clearTimeout ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>))

  let phase: VoicePhase = 'idle'
  let vad: Vad = createVad()
  let wakeInFlight = false
  let pendingEndSession = false
  let skipNextResponseDone = false
  let socketReady = false
  let sessionUpdated = false
  let sessionUpdatedWaiter: ((ok: boolean) => void) | undefined
  const provider: VoiceProvider = deps.config.provider ?? 'xai'
  let responseInFlight = false
  let idleTimer: unknown = undefined
  const pcmQueue: Int16Array[] = []

  function clearIdleTimer(): void {
    if (idleTimer === undefined) return
    cancelTimeout(idleTimer)
    idleTimer = undefined
  }

  function armIdleTimer(): void {
    clearIdleTimer()
    if (phase !== 'engaged' || pendingEndSession) return
    idleTimer = scheduleTimeout(() => {
      idleTimer = undefined
      if (phase === 'engaged' && !pendingEndSession) dropToListening()
    }, idleTimeoutMs)
  }

  function setPhase(next: VoicePhase): void {
    if (phase === next) return
    phase = next
    deps.onPhase?.(next)
  }

  function keyterms(): string[] {
    return [deps.config.wakePhrase, ...deps.host.listProfiles().map((profile) => profile.name)]
  }

  function dropToListening(): void {
    clearIdleTimer()
    pendingEndSession = false
    skipNextResponseDone = false
    socketReady = false
    settleSessionUpdated(false)
    responseInFlight = false
    pcmQueue.length = 0
    deps.client.close()
    vad = createVad()
    if (phase === 'idle' || phase === 'error') return
    setPhase('listening')
  }

  function settleSessionUpdated(ok: boolean): void {
    sessionUpdated = ok
    const waiter = sessionUpdatedWaiter
    sessionUpdatedWaiter = undefined
    waiter?.(ok)
  }

  function fail(error: unknown): void {
    clearIdleTimer()
    const message = error instanceof Error ? error.message : String(error)
    const authFailed =
      (error instanceof VoiceClientError && error.authFailed) ||
      /401|403|unauthor|invalid_api_key/i.test(message)
    deps.onError?.(message)
    deps.client.close()
    socketReady = false
    settleSessionUpdated(false)
    pcmQueue.length = 0
    if (authFailed) {
      setPhase('error')
      return
    }
    vad = createVad()
    if (phase !== 'idle') setPhase('listening')
  }

  function waitForSessionUpdated(): Promise<boolean> {
    if (sessionUpdated) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timeout = scheduleTimeout(() => {
        if (sessionUpdatedWaiter === onSettle) sessionUpdatedWaiter = undefined
        resolve(true)
      }, sessionUpdatedTimeoutMs)
      const onSettle = (ok: boolean): void => {
        cancelTimeout(timeout)
        resolve(ok)
      }
      sessionUpdatedWaiter = onSettle
    })
  }

  function askResponse(): void {
    if (responseInFlight) return
    responseInFlight = true
    deps.client.requestResponse()
  }

  const realtimeHandlers: VoiceRealtimeHandlers = {
    onSessionUpdated: () => {
      settleSessionUpdated(true)
    },
    onAudioOut: (pcm) => {
      clearIdleTimer()
      deps.onAudioOut?.(pcm)
    },
    onTranscript: (text) => {
      clearIdleTimer()
      deps.onTranscript?.(text, 'assistant')
    },
    onText: (text) => {
      clearIdleTimer()
      deps.onTranscript?.(text, 'assistant')
    },
    onFunctionCall: (call) => handleFunctionCall(call),
    onResponseDone: () => {
      responseInFlight = false
      if (skipNextResponseDone) {
        skipNextResponseDone = false
        return
      }
      if (pendingEndSession) {
        pendingEndSession = false
        dropToListening()
        return
      }
      if (phase === 'engaged') armIdleTimer()
    },
    onError: (message, authFailed) => {
      if (authFailed) {
        clearIdleTimer()
        deps.onError?.(message)
        deps.client.close()
        settleSessionUpdated(false)
        setPhase('error')
        return
      }
      fail(message)
    },
    onClose: () => {
      socketReady = false
      if (phase === 'engaged') dropToListening()
    }
  }

  async function handleFunctionCall(call: VoiceFunctionCall): Promise<void> {
    clearIdleTimer()
    if (call.name === 'end_session') {
      pendingEndSession = true
      skipNextResponseDone = true
    }
    const result = await executeCommand(deps.host, call.name, call.arguments, deps.config.locale)
    deps.client.sendFunctionOutput(call.callId, result)
    if (result.endSession) {
      pendingEndSession = true
      skipNextResponseDone = true
    }
    await waitForPlayback()
    responseInFlight = false
    askResponse()
  }

  function flushQueuedAudio(): void {
    for (const chunk of pcmQueue) deps.client.appendInputAudio(chunk)
    pcmQueue.length = 0
  }

  async function engage(remainder: string): Promise<void> {
    setPhase('engaged')
    clearIdleTimer()
    pendingEndSession = false
    skipNextResponseDone = false
    socketReady = false
    settleSessionUpdated(false)
    sessionUpdated = false
    responseInFlight = false
    vad = createVad()
    try {
      await deps.client.connectRealtime(realtimeHandlers)
      deps.client.updateSession({
        voice: deps.config.voiceId,
        instructions: buildVoiceInstructions({
          locale: deps.config.locale,
          wakePhrase: deps.config.wakePhrase,
          profiles: deps.host.listProfiles()
        }),
        tools: VOICE_TOOLS,
        languageHint: deps.config.locale,
        keyterms: keyterms()
      })
      const ready = await waitForSessionUpdated()
      if (!ready) return
      socketReady = true
      flushQueuedAudio()
      const rest = remainder.trim()
      if (rest) {
        deps.client.sendUserText(rest)
        askResponse()
        return
      }
      const prompt = deps.config.locale === 'en' ? 'Yes?' : 'Ja?'
      if (provider === 'openai') {
        // OpenAI has no force_message; a user turn + response.create is the greeting.
        deps.client.sendUserText(prompt)
        askResponse()
        return
      }
      // xAI: force_message is the spoken greeting. Do not also requestResponse.
      deps.client.forceMessage(prompt)
    } catch (error) {
      fail(error)
    }
  }

  async function handleSpeechEnd(pcm: Int16Array): Promise<void> {
    if (wakeInFlight) return
    wakeInFlight = true
    try {
      const { text } = await deps.client.transcribe({
        pcm,
        language: deps.config.locale,
        keyterms: keyterms()
      })
      const transcript = text.trim()
      if (transcript) deps.onTranscript?.(transcript, 'user')
      const { hit, remainder } = matchWakePhrase(transcript, deps.config.wakePhrase)
      if (!hit) return
      await engage(remainder)
    } catch (error) {
      fail(error)
    } finally {
      wakeInFlight = false
    }
  }

  async function drainVad(event: VadEvent | undefined): Promise<void> {
    while (event) {
      if (event.type === 'speech_end') await handleSpeechEnd(event.pcm)
      event = vad.push(new Int16Array(0))
    }
  }

  return {
    get phase() {
      return phase
    },
    start(): void {
      if (phase === 'listening' || phase === 'engaged') return
      vad = createVad()
      clearIdleTimer()
      pendingEndSession = false
      skipNextResponseDone = false
      wakeInFlight = false
      socketReady = false
      settleSessionUpdated(false)
      sessionUpdated = false
      responseInFlight = false
      pcmQueue.length = 0
      setPhase('listening')
    },
    stop(): void {
      clearIdleTimer()
      pendingEndSession = false
      skipNextResponseDone = false
      socketReady = false
      settleSessionUpdated(false)
      sessionUpdated = false
      responseInFlight = false
      pcmQueue.length = 0
      deps.client.close()
      setPhase('idle')
    },
    async pushPcm(pcm: Int16Array): Promise<void> {
      if (phase === 'listening') {
        await drainVad(vad.push(pcm))
        return
      }
      if (phase !== 'engaged') return
      clearIdleTimer()
      if (socketReady) deps.client.appendInputAudio(pcm)
      else pcmQueue.push(pcm)
    }
  }
}
