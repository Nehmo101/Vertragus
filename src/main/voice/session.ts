/**
 * Voice session state machine. Listening uses cheap local VAD + STT bursts;
 * the realtime socket is opened only after a wake hit so idle time does not
 * bill Speech-to-Speech.
 */
import {
  executeCommand,
  VOICE_TOOLS,
  type VoiceHost,
  type VoiceLocale
} from './commands'
import { buildVoiceInstructions } from './instructions'
import { createVad, type Vad, type VadEvent } from './vad'
import { matchWakePhrase } from './wakePhrase'
import { XaiError, type XaiClient, type XaiFunctionCall, type XaiRealtimeHandlers } from './xai'

export type VoicePhase = 'idle' | 'listening' | 'engaged' | 'error'

export interface VoiceSessionConfig {
  wakePhrase: string
  voiceId: string
  locale: VoiceLocale
  idleTimeoutMs?: number
}

export interface VoiceSessionDeps {
  host: VoiceHost
  client: XaiClient
  config: VoiceSessionConfig
  onPhase?: (phase: VoicePhase) => void
  onTranscript?: (text: string, origin: 'user' | 'assistant') => void
  onAudioOut?: (pcm: Int16Array) => void
  onError?: (message: string) => void
  waitForPlayback?: () => Promise<void>
}

export interface VoiceSession {
  readonly phase: VoicePhase
  start(): void
  stop(): void
  pushPcm(pcm: Int16Array): Promise<void>
}

export function createVoiceSession(deps: VoiceSessionDeps): VoiceSession {
  const idleTimeoutMs = deps.config.idleTimeoutMs ?? 20_000
  const waitForPlayback = deps.waitForPlayback ?? (async () => undefined)

  let phase: VoicePhase = 'idle'
  let vad: Vad = createVad()
  let wakeInFlight = false
  let pendingEndSession = false
  let socketReady = false
  const pcmQueue: Int16Array[] = []

  function setPhase(next: VoicePhase): void {
    if (phase === next) return
    phase = next
    deps.onPhase?.(next)
  }

  function keyterms(): string[] {
    return [deps.config.wakePhrase, ...deps.host.listProfiles().map((profile) => profile.name)]
  }

  function dropToListening(): void {
    pendingEndSession = false
    socketReady = false
    pcmQueue.length = 0
    deps.client.close()
    vad = createVad()
    if (phase === 'idle' || phase === 'error') return
    setPhase('listening')
  }

  function fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const authFailed =
      (error instanceof XaiError && error.authFailed) || /401|403|unauthor|invalid_api_key/i.test(message)
    deps.onError?.(message)
    deps.client.close()
    socketReady = false
    pcmQueue.length = 0
    if (authFailed) {
      setPhase('error')
      return
    }
    vad = createVad()
    if (phase !== 'idle') setPhase('listening')
  }

  const realtimeHandlers: XaiRealtimeHandlers = {
    onAudioOut: (pcm) => deps.onAudioOut?.(pcm),
    onTranscript: (text) => deps.onTranscript?.(text, 'assistant'),
    onText: (text) => deps.onTranscript?.(text, 'assistant'),
    onFunctionCall: (call) => handleFunctionCall(call),
    onResponseDone: () => {
      if (!pendingEndSession) return
      pendingEndSession = false
      dropToListening()
    },
    onIdleTimeout: () => {
      dropToListening()
    },
    onError: (message, authFailed) => {
      if (authFailed) {
        deps.onError?.(message)
        deps.client.close()
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

  async function handleFunctionCall(call: XaiFunctionCall): Promise<void> {
    const result = await executeCommand(deps.host, call.name, call.arguments, deps.config.locale)
    deps.client.sendFunctionOutput(call.callId, result)
    if (result.endSession) pendingEndSession = true
    await waitForPlayback()
    deps.client.requestResponse()
  }

  async function engage(remainder: string): Promise<void> {
    setPhase('engaged')
    pendingEndSession = false
    socketReady = false
    try {
      await deps.client.connectRealtime(realtimeHandlers)
      deps.client.updateSession({
        voice: deps.config.voiceId || 'eve',
        instructions: buildVoiceInstructions({
          locale: deps.config.locale,
          wakePhrase: deps.config.wakePhrase,
          profiles: deps.host.listProfiles()
        }),
        tools: VOICE_TOOLS,
        idleTimeoutMs,
        languageHint: deps.config.locale,
        keyterms: keyterms()
      })
      socketReady = true
      for (const chunk of pcmQueue) deps.client.appendInputAudio(chunk)
      pcmQueue.length = 0
      const rest = remainder.trim()
      if (rest) {
        deps.client.sendUserText(rest)
        deps.client.requestResponse()
      } else {
        deps.client.forceMessage(deps.config.locale === 'en' ? 'Yes?' : 'Ja?')
      }
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
      pendingEndSession = false
      wakeInFlight = false
      socketReady = false
      pcmQueue.length = 0
      setPhase('listening')
    },
    stop(): void {
      pendingEndSession = false
      socketReady = false
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
      if (socketReady) deps.client.appendInputAudio(pcm)
      else pcmQueue.push(pcm)
    }
  }
}
