import { useCallback, useEffect, useRef, useState } from 'react'
import type { InboxSpeechStatus, InboxSpeechUiState } from '@shared/inboxSpeech'
import {
  INBOX_SPEECH_MAX_DURATION_MS,
  microphoneErrorMessage
} from '@shared/inboxSpeech'

export interface VoiceIdeaDraft {
  title: string
  content: string
}

interface UseInboxSpeechResult {
  state: InboxSpeechUiState
  error: string
  status: InboxSpeechStatus | null
  voiceDraft: VoiceIdeaDraft | null
  toggleRecording: () => Promise<void>
  discardVoiceDraft: () => void
  updateVoiceDraft: (patch: Partial<VoiceIdeaDraft>) => void
  refreshStatus: () => Promise<void>
}

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm'
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? 'audio/webm'
}

export function useInboxSpeech(): UseInboxSpeechResult {
  const [state, setState] = useState<InboxSpeechUiState>('idle')
  const [error, setError] = useState('')
  const [status, setStatus] = useState<InboxSpeechStatus | null>(null)
  const [voiceDraft, setVoiceDraft] = useState<VoiceIdeaDraft | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const startedAtRef = useRef(0)
  const limitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stopRecordingRef = useRef<() => Promise<void>>(async () => undefined)

  const refreshStatus = useCallback(async (): Promise<void> => {
    const next = await window.orca.inboxSpeech.status()
    setStatus(next)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshStatus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [refreshStatus])

  const cleanupStream = useCallback((): void => {
    if (limitTimerRef.current) {
      clearTimeout(limitTimerRef.current)
      limitTimerRef.current = null
    }
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    recorderRef.current = null
    chunksRef.current = []
  }, [])

  const stopRecording = useCallback(async (): Promise<void> => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return

    await new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => resolve(), { once: true })
      recorder.stop()
    })
  }, [])

  useEffect(() => {
    stopRecordingRef.current = stopRecording
  }, [stopRecording])

  const finishRecording = useCallback(async (): Promise<void> => {
    const durationMs = Math.max(0, Date.now() - startedAtRef.current)
    const mimeType = recorderRef.current?.mimeType || pickMimeType()
    cleanupStream()

    const blob = new Blob(chunksRef.current, { type: mimeType })
    chunksRef.current = []

    if (blob.size === 0) {
      setState('failed')
      setError('Aufnahme ist leer.')
      return
    }

    setState('transcribing')
    setError('')

    try {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const result = await window.orca.inboxSpeech.transcribe({
        mimeType,
        bytes,
        durationMs
      })
      if (!result.ok) {
        setState('failed')
        setError(result.message)
        return
      }
      const firstLine = result.text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? ''
      setVoiceDraft({
        title: firstLine.slice(0, 120) || 'Sprachnotiz',
        content: result.text
      })
      setState('review')
    } catch (err) {
      setState('failed')
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [cleanupStream])

  const startRecording = useCallback(async (): Promise<void> => {
    setError('')
    setVoiceDraft(null)

    if (!status?.configured) {
      setState('failed')
      setError('Kein API-Schlüssel hinterlegt. Bitte in den Einstellungen speichern.')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mimeType = pickMimeType()
      const recorder = new MediaRecorder(stream, { mimeType })
      recorderRef.current = recorder
      chunksRef.current = []
      startedAtRef.current = Date.now()

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      })
      recorder.addEventListener('stop', () => {
        void finishRecording()
      })

      recorder.start(250)
      setState('recording')

      const maxMs = status?.maxDurationMs ?? INBOX_SPEECH_MAX_DURATION_MS
      limitTimerRef.current = setTimeout(() => {
        void stopRecordingRef.current()
      }, maxMs)
    } catch (err) {
      cleanupStream()
      setState('failed')
      setError(microphoneErrorMessage(err))
    }
  }, [cleanupStream, finishRecording, status])

  const toggleRecording = useCallback(async (): Promise<void> => {
    if (state === 'recording') {
      await stopRecording()
      return
    }
    if (state === 'transcribing') {
      await window.orca.inboxSpeech.abort()
      setState('idle')
      setError('')
      return
    }
    if (state === 'review') return
    await startRecording()
  }, [startRecording, state, stopRecording])

  const discardVoiceDraft = useCallback((): void => {
    setVoiceDraft(null)
    setError('')
    setState('idle')
    void window.orca.inboxSpeech.abort()
  }, [])

  const updateVoiceDraft = useCallback((patch: Partial<VoiceIdeaDraft>): void => {
    setVoiceDraft((current) => (current ? { ...current, ...patch } : current))
  }, [])

  useEffect(() => () => {
    void window.orca.inboxSpeech.abort()
    cleanupStream()
  }, [cleanupStream])

  return {
    state,
    error,
    status,
    voiceDraft,
    toggleRecording,
    discardVoiceDraft,
    updateVoiceDraft,
    refreshStatus
  }
}
