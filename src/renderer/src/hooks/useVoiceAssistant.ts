import { useCallback, useEffect, useRef, useState } from 'react'

export type VoiceAssistantState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error'

export interface VoiceHistoryTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface VoiceConfirmation {
  prompt: string
}

export interface VoiceTurnResult {
  ok: boolean
  transcript?: string
  replyText?: string
  replyAudio?: Uint8Array | ArrayBuffer
  confirmationRequired?: VoiceConfirmation | string
  reason?: string
}

export interface VoiceProgressEvent {
  status?: string
  stage?: string
  message?: string
  error?: string
}

interface VoiceBridge {
  voiceAssistant: {
    turn(request: {
      audio?: Uint8Array
      mimeType?: string
      text?: string
      history: VoiceHistoryTurn[]
    }): Promise<VoiceTurnResult>
    onProgress?: (callback: (event: VoiceProgressEvent) => void) => () => void
  }
  voiceOverlay: {
    hide(): Promise<void> | void
    moved?: ((x: number, y: number) => Promise<void> | void) |
      ((bounds: { x: number; y: number }) => Promise<void> | void)
  }
  events?: {
    onVoiceAssistant?: (callback: (event: VoiceProgressEvent) => void) => () => void
  }
}

export interface UseVoiceAssistantResult {
  state: VoiceAssistantState
  transcript: string
  reply: string
  error: string
  confirmation: VoiceConfirmation | null
  history: VoiceHistoryTurn[]
  toggleRecording(): Promise<void>
  submitText(text: string): Promise<void>
  hide(): void
  reportMoved(x: number, y: number): void
}

const MAX_HISTORY_TURNS = 10

export function trimVoiceHistory(history: VoiceHistoryTurn[]): VoiceHistoryTurn[] {
  return history.slice(-MAX_HISTORY_TURNS)
}

export function progressState(event: VoiceProgressEvent): VoiceAssistantState | null {
  const value = (event.status ?? event.stage ?? '').toLowerCase()
  if (value === 'listening' || value === 'recording') return 'listening'
  if (value === 'speaking') return 'speaking'
  if (value === 'error' || value === 'failed') return 'error'
  if (value === 'transcribing' || value === 'thinking' || value.startsWith('acting')) return 'thinking'
  if (value === 'idle' || value === 'done') return 'idle'
  return null
}

export function pickVoiceMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm'
  const choices = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  return choices.find((type) => MediaRecorder.isTypeSupported(type)) ?? 'audio/webm'
}

function bridge(): VoiceBridge {
  return window.orca as unknown as VoiceBridge
}

function confirmationFrom(result: VoiceTurnResult): VoiceConfirmation | null {
  if (!result.confirmationRequired) return null
  return typeof result.confirmationRequired === 'string'
    ? { prompt: result.confirmationRequired }
    : result.confirmationRequired
}

export function useVoiceAssistant(): UseVoiceAssistantResult {
  const [state, setState] = useState<VoiceAssistantState>('idle')
  const [transcript, setTranscript] = useState('')
  const [reply, setReply] = useState('')
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState<VoiceConfirmation | null>(null)
  const [history, setHistory] = useState<VoiceHistoryTurn[]>([])
  const historyRef = useRef<VoiceHistoryTurn[]>([])
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)

  const updateHistory = useCallback((next: VoiceHistoryTurn[]): void => {
    const trimmed = trimVoiceHistory(next)
    historyRef.current = trimmed
    setHistory(trimmed)
  }, [])

  const cleanupRecording = useCallback((): void => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    recorderRef.current = null
    chunksRef.current = []
  }, [])

  const playReply = useCallback(async (bytes: Uint8Array | ArrayBuffer): Promise<void> => {
    audioRef.current?.pause()
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    const copy = new Uint8Array(data.byteLength)
    copy.set(data)
    const url = URL.createObjectURL(new Blob([copy.buffer], { type: 'audio/mpeg' }))
    audioUrlRef.current = url
    const audio = new Audio(url)
    audioRef.current = audio
    setState('speaking')
    audio.addEventListener('ended', () => setState('idle'), { once: true })
    audio.addEventListener('error', () => setState('error'), { once: true })
    await audio.play()
  }, [])

  const runTurn = useCallback(async (request: { audio?: Uint8Array; mimeType?: string; text?: string }): Promise<void> => {
    setState('thinking')
    setError('')
    setConfirmation(null)
    try {
      const result = await bridge().voiceAssistant.turn({ ...request, history: historyRef.current })
      if (!result.ok) throw new Error(result.reason || 'voice_turn_failed')
      const userText = (result.transcript || request.text || '').trim()
      const assistantText = (result.replyText || '').trim()
      if (userText) setTranscript(userText)
      if (assistantText) setReply(assistantText)
      const additions: VoiceHistoryTurn[] = []
      if (userText) additions.push({ role: 'user', content: userText })
      if (assistantText) additions.push({ role: 'assistant', content: assistantText })
      updateHistory([...historyRef.current, ...additions])
      setConfirmation(confirmationFrom(result))
      if (result.replyAudio) await playReply(result.replyAudio)
      else setState('idle')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setState('error')
    }
  }, [playReply, updateHistory])

  const stopRecording = useCallback(async (): Promise<void> => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    await new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => resolve(), { once: true })
      recorder.stop()
    })
  }, [])

  const toggleRecording = useCallback(async (): Promise<void> => {
    if (recorderRef.current?.state === 'recording') {
      await stopRecording()
      return
    }
    audioRef.current?.pause()
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = pickVoiceMimeType()
      const recorder = new MediaRecorder(stream, { mimeType })
      streamRef.current = stream
      recorderRef.current = recorder
      chunksRef.current = []
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size) chunksRef.current.push(event.data)
      })
      recorder.addEventListener('stop', () => {
        const chunks = chunksRef.current
        cleanupRecording()
        const blob = new Blob(chunks, { type: mimeType })
        if (!blob.size) {
          setError('empty_recording')
          setState('error')
          return
        }
        void blob.arrayBuffer().then((buffer) => runTurn({ audio: new Uint8Array(buffer), mimeType }))
      })
      recorder.start(250)
      setState('listening')
    } catch (cause) {
      cleanupRecording()
      setError(cause instanceof Error ? cause.message : String(cause))
      setState('error')
    }
  }, [cleanupRecording, runTurn, stopRecording])

  const submitText = useCallback(async (text: string): Promise<void> => {
    const value = text.trim()
    if (value) await runTurn({ text: value })
  }, [runTurn])

  useEffect(() => {
    const api = bridge()
    const subscribe = api.events?.onVoiceAssistant ?? api.voiceAssistant.onProgress
    if (!subscribe) return
    return subscribe((event) => {
      const next = progressState(event)
      if (next) setState(next)
      if (event.error) setError(event.error)
    })
  }, [])

  useEffect(() => () => {
    cleanupRecording()
    audioRef.current?.pause()
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
  }, [cleanupRecording])

  const hide = useCallback((): void => { void bridge().voiceOverlay.hide() }, [])
  const reportMoved = useCallback((x: number, y: number): void => {
    const moved = bridge().voiceOverlay.moved
    if (!moved) return
    if (moved.length >= 2) void (moved as (left: number, top: number) => Promise<void> | void)(x, y)
    else void (moved as (bounds: { x: number; y: number }) => Promise<void> | void)({ x, y })
  }, [])

  return { state, transcript, reply, error, confirmation, history, toggleRecording, submitText, hide, reportMoved }
}
