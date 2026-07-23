import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from 'react'
import type {
  Idea,
  IdeaArchiveView,
  IdeaArtifact,
  IdeaStatus,
  RemovableIdeaAttribute
} from '@shared/inbox'
import { IDEA_INPUT_STATUSES, IMAGE_ARTIFACT_MIME_TYPES, type ImageArtifactMime } from '@shared/inbox'
import { isTransferActive } from '@shared/inboxTransfer'
import { useInboxSpeech } from '@renderer/hooks/useInboxSpeech'
import { useAppStore } from '@renderer/store/useAppStore'
import {
  speechShortcutAriaKeys,
  speechShortcutKeys,
  useSpeechShortcutContext
} from '@renderer/features/speechShortcut/SpeechShortcutProvider'
import IdeaTransferModal from '@renderer/components/IdeaTransferModal'
import PromptEnhancementReview from '@renderer/components/PromptEnhancementReview'
import type { PromptEnhancementIpcResult, PromptEnhancementSelection } from '@shared/promptEnhancement'
import {
  INITIAL_PROMPT_ENHANCEMENT_SESSION,
  PROMPT_SHARPEN_LABEL,
  abortPromptEnhancementSession,
  closePromptEnhancementSession,
  confirmPromptEnhancementApply,
  copyPromptEnhancement,
  createOfferedDeterministicFallback,
  promptEnhancementSourceFromIdea,
  requestPromptApplyConfirmation,
  settlePromptEnhancementSession,
  startPromptEnhancementSession,
  type PromptEnhancementSession
} from '@renderer/inboxPrompt'
import {
  formatIdeaDate,
  ideaTimestamp,
  ideaTimestampLabel,
  ideasForView,
  listRemovableIdeaAttributes,
  sortedIdeaHistory,
  workspaceReferences
} from './inboxArchive'
import styles from './responsiveGuards.module.css'
import archiveStyles from './InboxPanel.module.css'

const STATUS_LABEL: Record<IdeaStatus, string> = {
  draft: 'Entwurf',
  ready: 'Bereit',
  archived: 'Archiv',
  done: 'Erledigt'
}
const TRANSFER_STATUS_LABEL: Record<string, string> = {
  pending: 'Übergabe wartet',
  running: 'Planung läuft',
  planned: 'Plan im Review',
  failed: 'Übergabe fehlgeschlagen'
}

const SPEECH_STATE_LABEL: Record<string, string> = {
  idle: 'Bereit',
  recording: 'Aufnahme…',
  transcribing: 'Transkribiert…',
  review: 'Vorschau',
  failed: 'Fehler'
}

function createPromptRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function ArtifactRow({
  artifact,
  preview,
  onRemove
}: {
  artifact: IdeaArtifact
  /** In-session thumbnail data URL for a just-pasted image (not persisted). */
  preview?: string
  onRemove?: () => void
}): JSX.Element {
  let detail = ''
  let warn = ''
  if (artifact.kind === 'text') {
    detail = artifact.text?.slice(0, 120) ?? ''
  } else if (artifact.kind === 'url') {
    detail = artifact.url ?? ''
    if (artifact.urlInvalid) warn = 'Ungültige URL'
  } else if (artifact.kind === 'image') {
    detail = artifact.fileName ?? artifact.label
    if (artifact.missing) warn = 'Bild fehlt'
  } else {
    detail = artifact.fileName ?? artifact.sourcePath ?? ''
    if (artifact.missing) warn = 'Datei fehlt'
    else if (artifact.copied === false) warn = 'Nur Referenz (nicht kopiert)'
  }

  return (
    <div className={`inbox-artifact ${warn ? 'warn' : ''}`}>
      <div className="inbox-artifact-head">
        <span className="kind">{artifact.kind}</span>
        <span className="label">{artifact.label}</span>
        {onRemove && (
          <button type="button" className="icon-btn-sm" title="Artefakt entfernen" onClick={onRemove}>
            ✕
          </button>
        )}
      </div>
      {artifact.kind === 'image' && preview && (
        <img className="inbox-artifact-thumb" src={preview} alt={artifact.label} />
      )}
      <div className="inbox-artifact-body" title={detail}>
        {detail || '—'}
      </div>
      {warn && <div className="inbox-artifact-warn">{warn}</div>}
    </div>
  )
}

function ArchiveDetail({
  idea,
  saving,
  onRestore
}: {
  idea: Idea
  saving: boolean
  onRestore: () => void
}): JSX.Element {
  const attributes = listRemovableIdeaAttributes(idea)
  const history = sortedIdeaHistory(idea)
  const workspaces = workspaceReferences(idea)

  return (
    <>
      <div className={archiveStyles.archiveHead}>
        <h2 className={archiveStyles.archiveTitle}>{idea.title || 'Unbenannte Idee'}</h2>
        <span className={archiveStyles.archiveStatus}>{STATUS_LABEL[idea.status]}</span>
        <button
          type="button"
          className="inbox-btn"
          disabled={saving}
          onClick={onRestore}
        >
          Wiederherstellen
        </button>
      </div>

      <section className={archiveStyles.archiveSection} aria-label="Inhalt">
        <div className={archiveStyles.sectionLabel}>Inhalt</div>
        <p className={archiveStyles.readOnlyContent}>{idea.content || '—'}</p>
      </section>

      <section className={archiveStyles.archiveSection} aria-label="Attribute">
        <div className={archiveStyles.sectionLabel}>Attribute</div>
        {attributes.length > 0 ? (
          <div className={archiveStyles.chipList}>
            {attributes.map((attribute) => (
              <span key={attribute.id} className={archiveStyles.readOnlyChip}>
                {attribute.label}: {attribute.value}
              </span>
            ))}
          </div>
        ) : (
          <div className={archiveStyles.muted}>Keine Tags oder Verknüpfungsattribute.</div>
        )}
      </section>

      <section className={archiveStyles.archiveSection} aria-label="Workspace-Verknüpfung">
        <div className={archiveStyles.sectionLabel}>Workspace-Verknüpfung</div>
        {workspaces.length > 0 ? (
          <div className={archiveStyles.factList}>
            {workspaces.map((reference) => (
              <div key={reference.label} className={archiveStyles.factRow}>
                <span className={archiveStyles.factLabel}>{reference.label}</span>
                <span className={archiveStyles.factValue}>{reference.value}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className={archiveStyles.muted}>Keine Workspace-Verknüpfung erhalten.</div>
        )}
      </section>

      <section className={archiveStyles.archiveSection} aria-label="Übergabe-Telemetrie">
        <div className={archiveStyles.sectionLabel}>Übergabe-Telemetrie</div>
        {idea.transfer ? (
          <div className={`inbox-transfer-status status-${idea.transfer.status}`}>
            {TRANSFER_STATUS_LABEL[idea.transfer.status] ?? idea.transfer.status}
            {idea.transfer.error && ` — ${idea.transfer.error}`}
            {idea.transfer.planId && ` · Plan ${idea.transfer.planId}`}
          </div>
        ) : (
          <div className={archiveStyles.muted}>Keine Übergabe-Telemetrie vorhanden.</div>
        )}
      </section>

      <section className={archiveStyles.archiveSection} aria-label="Artefakte">
        <div className={archiveStyles.sectionLabel}>Artefakte ({idea.artifacts.length})</div>
        <div className="inbox-artifact-list">
          {idea.artifacts.map((artifact) => (
            <ArtifactRow key={artifact.id} artifact={artifact} />
          ))}
          {idea.artifacts.length === 0 && (
            <div className={archiveStyles.muted}>Keine Artefakte.</div>
          )}
        </div>
      </section>

      <section className={archiveStyles.archiveSection} aria-label="Verarbeitungshistorie">
        <div className={archiveStyles.sectionLabel}>Verarbeitungshistorie</div>
        {history.length > 0 ? (
          <ol className={archiveStyles.historyList}>
            {history.map((entry, index) => (
              <li key={`${entry.at}:${entry.kind}:${index}`} className={archiveStyles.historyItem}>
                <time className={archiveStyles.historyTime} dateTime={new Date(entry.at).toISOString()}>
                  {formatIdeaDate(entry.at)}
                </time>
                <span className={archiveStyles.historyKind}>{entry.kind}</span>
                <span className={archiveStyles.historyDetail}>{entry.detail || '—'}</span>
              </li>
            ))}
          </ol>
        ) : (
          <div className={archiveStyles.muted}>Keine Verarbeitungshistorie vorhanden.</div>
        )}
      </section>

      <div className="inbox-meta">
        ID: {idea.id} · erstellt {formatIdeaDate(idea.createdAt)} · archiviert{' '}
        {formatIdeaDate(ideaTimestamp(idea, 'archive'))}
      </div>
    </>
  )
}

export default function InboxPanel(): JSX.Element {
  const speech = useInboxSpeech()
  const openSpeechSettings = useAppStore((state) => state.openSpeechSettings)
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [view, setView] = useState<IdeaArchiveView>('inbox')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Idea | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [textInput, setTextInput] = useState('')
  // In-session thumbnails for just-pasted images (artifactId → data URL); not persisted.
  const [imagePreviews, setImagePreviews] = useState<Record<string, string>>({})
  const [transferOpen, setTransferOpen] = useState(false)
  const [promptSession, setPromptSession] = useState<PromptEnhancementSession>(
    INITIAL_PROMPT_ENHANCEMENT_SESSION
  )
  const promptSessionRef = useRef(promptSession)
  const activePromptRef = useRef<{ requestId: string; generation: number }>()
  const titleInputRef = useRef<HTMLInputElement>(null)
  const visibleIdeas = ideasForView(ideas, view)

  const commitPromptSession = (next: PromptEnhancementSession): void => {
    promptSessionRef.current = next
    setPromptSession(next)
  }

  const reconcileIdeas = useCallback((
    list: Idea[],
    preferredId: string | null = selectedId,
    targetView: IdeaArchiveView = view
  ): void => {
    const candidates = ideasForView(list, targetView)
    const selected = candidates.find((idea) => idea.id === preferredId) ?? candidates[0]
    setIdeas(list)
    setSelectedId(selected?.id ?? null)
    setDraft(selected ? { ...selected } : null)
  }, [selectedId, view])

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const list = await window.vertragus.inbox.list()
      reconcileIdeas(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [reconcileIdeas])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh()
    }, 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return () => {
      const active = activePromptRef.current
      activePromptRef.current = undefined
      promptSessionRef.current = closePromptEnhancementSession(promptSessionRef.current)
      if (active) void window.vertragus.inbox.abortPromptEnhancement(active.requestId).catch(() => undefined)
    }
  }, [])

  const closePromptReview = (showAborted = true): void => {
    const active = activePromptRef.current
    activePromptRef.current = undefined
    if (active) {
      void window.vertragus.inbox.abortPromptEnhancement(active.requestId).catch(() => undefined)
    }
    commitPromptSession(
      active && showAborted
        ? abortPromptEnhancementSession(promptSessionRef.current, active.requestId)
        : closePromptEnhancementSession(promptSessionRef.current)
    )
  }

  const runPromptEnhancement = async (
    explicitSelection?: PromptEnhancementSelection
  ): Promise<void> => {
    if (!draft || promptSessionRef.current.phase === 'loading') return
    const source = promptEnhancementSourceFromIdea(draft)
    const requestId = createPromptRequestId()
    const started = startPromptEnhancementSession(
      promptSessionRef.current,
      requestId,
      source,
      explicitSelection
    )
    if (started === promptSessionRef.current) return
    const active = { requestId, generation: started.generation }
    activePromptRef.current = active
    commitPromptSession(started)

    try {
      const result = await window.vertragus.inbox.enhancePrompt({
        requestId,
        source,
        explicitSelection
      })
      if (activePromptRef.current?.requestId !== requestId) return
      commitPromptSession(
        settlePromptEnhancementSession(
          promptSessionRef.current,
          requestId,
          active.generation,
          result
        )
      )
    } catch (err) {
      if (activePromptRef.current?.requestId !== requestId) return
      const failure: PromptEnhancementIpcResult = {
        status: 'invalid-input',
        code: 'invalid-input',
        message: err instanceof Error ? err.message : String(err)
      }
      commitPromptSession(
        settlePromptEnhancementSession(
          promptSessionRef.current,
          requestId,
          active.generation,
          failure
        )
      )
    } finally {
      if (activePromptRef.current?.requestId === requestId) activePromptRef.current = undefined
    }
  }

  const showDeterministicFallback = (): void => {
    const original = promptSessionRef.current.original
    if (!original) return
    const fallback = createOfferedDeterministicFallback(original)
    if (!fallback) return
    commitPromptSession({
      ...promptSessionRef.current,
      phase: 'result',
      requestId: undefined,
      result: fallback,
      copied: false,
      confirmApply: false
    })
  }

  const copyPromptResult = async (): Promise<void> => {
    const result = promptSessionRef.current.result
    if (!result) return
    const generation = promptSessionRef.current.generation
    try {
      const copied = await copyPromptEnhancement(result, (text) => navigator.clipboard.writeText(text))
      if (
        copied &&
        promptSessionRef.current.generation === generation &&
        promptSessionRef.current.result === result
      ) {
        commitPromptSession({ ...promptSessionRef.current, copied: true })
      }
    } catch (err) {
      setError(`Kopieren fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const confirmPromptApply = (): void => {
    const result = promptSessionRef.current.result
    if (!draft || !result) return
    if (!promptSessionRef.current.confirmApply) return
    setDraft(confirmPromptEnhancementApply(draft, promptSessionRef.current))
    closePromptReview(false)
    window.setTimeout(() => titleInputRef.current?.focus(), 0)
  }

  const selectIdea = (idea: Idea): void => {
    closePromptReview(false)
    setSelectedId(idea.id)
    setDraft({ ...idea })
    setConfirmDelete(false)
    setUrlInput('')
    setTextInput('')
  }

  const selectView = (nextView: IdeaArchiveView): void => {
    if (nextView === view) return
    closePromptReview(false)
    const first = ideasForView(ideas, nextView)[0]
    setView(nextView)
    setSelectedId(first?.id ?? null)
    setDraft(first ? { ...first } : null)
    setConfirmDelete(false)
    setUrlInput('')
    setTextInput('')
  }

  const createIdea = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      const idea = await window.vertragus.inbox.create()
      const list = await window.vertragus.inbox.list()
      setIdeas(list)
      setView('inbox')
      selectIdea(idea)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const saveDraft = async (openTransferAfterSave = false): Promise<void> => {
    if (!draft) return
    if (draft.status === 'archived') {
      setError('Archivierte Ideen muessen vor dem Bearbeiten wiederhergestellt werden.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const updated = await window.vertragus.inbox.update({
        id: draft.id,
        title: draft.title,
        content: draft.content,
        status: draft.status,
        tags: draft.tags,
        refs: draft.refs
      })
      const list = await window.vertragus.inbox.list()
      reconcileIdeas(list, updated.id)
      if (openTransferAfterSave && updated.status !== 'archived') setTransferOpen(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const confirmVoiceDraft = async (): Promise<void> => {
    if (!speech.voiceDraft) return
    setSaving(true)
    setError('')
    try {
      const idea = await window.vertragus.inbox.create({
        title: speech.voiceDraft.title.trim() || 'Sprachnotiz',
        content: speech.voiceDraft.content,
        status: 'draft',
        tags: ['sprache']
      })
      const list = await window.vertragus.inbox.list()
      setIdeas(list)
      setView('inbox')
      selectIdea(idea)
      speech.discardVoiceDraft()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const deleteIdea = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    setError('')
    try {
      const list = await window.vertragus.inbox.delete(draft.id)
      reconcileIdeas(list, null)
      setConfirmDelete(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const resetTransfer = async (): Promise<void> => {
    if (!draft?.transfer) return
    setSaving(true)
    setError('')
    try {
      const updated = await window.vertragus.inbox.transferReset(draft.id)
      setDraft({ ...updated })
      setIdeas((current) => current.map((idea) => (idea.id === updated.id ? updated : idea)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const addText = async (): Promise<void> => {
    if (!draft || !textInput.trim()) return
    setSaving(true)
    setError('')
    try {
      const updated = await window.vertragus.inbox.addArtifact(draft.id, {
        kind: 'text',
        text: textInput.trim()
      })
      setTextInput('')
      setDraft({ ...updated })
      const list = await window.vertragus.inbox.list()
      setIdeas(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const addUrl = async (): Promise<void> => {
    if (!draft || !urlInput.trim()) return
    setSaving(true)
    setError('')
    try {
      const updated = await window.vertragus.inbox.addArtifact(draft.id, {
        kind: 'url',
        url: urlInput.trim()
      })
      setUrlInput('')
      setDraft({ ...updated })
      const list = await window.vertragus.inbox.list()
      setIdeas(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const addFile = async (): Promise<void> => {
    if (!draft) return
    const picked = await window.vertragus.pickFile()
    if (!picked) return
    setSaving(true)
    setError('')
    try {
      const updated = await window.vertragus.inbox.addArtifact(draft.id, {
        kind: 'file',
        grantId: picked.grantId,
        label: picked.fileName
      })
      setDraft({ ...updated })
      const list = await window.vertragus.inbox.list()
      setIdeas(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const attachImageBlob = async (blob: Blob, name?: string): Promise<void> => {
    if (!draft) return
    if (!IMAGE_ARTIFACT_MIME_TYPES.includes(blob.type as ImageArtifactMime)) {
      setError('Nicht unterstützter Bildtyp — erlaubt: PNG, JPEG, GIF, WebP.')
      return
    }
    let dataUrl: string
    try {
      dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error ?? new Error('Bild konnte nicht gelesen werden.'))
        reader.readAsDataURL(blob)
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    setSaving(true)
    setError('')
    try {
      const updated = await window.vertragus.inbox.addArtifact(draft.id, {
        kind: 'image',
        dataBase64: base64,
        mimeType: blob.type,
        name
      })
      const added = updated.artifacts[updated.artifacts.length - 1]
      if (added) setImagePreviews((prev) => ({ ...prev, [added.id]: dataUrl }))
      setDraft({ ...updated })
      const list = await window.vertragus.inbox.list()
      setIdeas(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  // Paste an image (e.g. a screenshot) directly into the content field to attach it as an artifact.
  const handleContentPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    if (!draft) return
    const images = Array.from(event.clipboardData?.items ?? []).filter(
      (item) => item.kind === 'file' && item.type.startsWith('image/')
    )
    if (images.length === 0) return
    event.preventDefault()
    for (const item of images) {
      const file = item.getAsFile()
      if (file) void attachImageBlob(file, file.name || undefined)
    }
  }

  const removeArtifact = async (artifactId: string): Promise<void> => {
    if (!draft) return
    setSaving(true)
    setError('')
    try {
      const updated = await window.vertragus.inbox.removeArtifact(draft.id, artifactId)
      setDraft({ ...updated })
      const list = await window.vertragus.inbox.list()
      setIdeas(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const removeAttribute = async (attribute: RemovableIdeaAttribute): Promise<void> => {
    if (!draft || view !== 'inbox') return
    setSaving(true)
    setError('')
    try {
      const updated = await window.vertragus.inbox.removeAttribute(draft.id, attribute)
      const list = await window.vertragus.inbox.list()
      reconcileIdeas(list, updated.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const restoreIdea = async (): Promise<void> => {
    if (!draft || view !== 'archive') return
    setSaving(true)
    setError('')
    try {
      const restored = await window.vertragus.inbox.restoreIdea(draft.id)
      const list = await window.vertragus.inbox.list()
      setView('inbox')
      reconcileIdeas(list, restored.id, 'inbox')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const speechBusy = speech.state === 'recording' || speech.state === 'transcribing'
  const showVoiceReview = speech.state === 'review' && speech.voiceDraft

  // Ctrl/Cmd+Shift+M → speech.toggle routes here while the Inbox is mounted (active context).
  const speechConfigured = speech.status?.configured ?? false
  const shortcutContext = useMemo(
    () => ({ configured: speechConfigured, state: speech.state, toggleRecording: speech.toggleRecording }),
    [speechConfigured, speech.state, speech.toggleRecording]
  )
  useSpeechShortcutContext('inbox', shortcutContext)
  const shortcutKeys = speechShortcutKeys()
  const shortcutAriaKeys = speechShortcutAriaKeys()

  return (
    <main
      className={`inbox-panel ${styles.inboxPanel}`}
      aria-label={view === 'archive' ? 'Ideen-Archiv' : 'Ideen-Inbox'}
    >
      <div className="inbox-header">
        <div>
          <div className="inbox-title">
            {view === 'archive' ? 'Ideen-Archiv' : 'Ideen-Inbox'}
          </div>
          <div className="inbox-sub">
            {view === 'archive'
              ? 'Archivierte Ideen mit ihrer Verarbeitungshistorie'
              : 'Ideen, Notizen und Spracheingabe — unabhängig vom Workspace'}
          </div>
        </div>
        <div className={archiveStyles.viewSwitch} role="tablist" aria-label="Ideenansicht">
          {(['inbox', 'archive'] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={view === item}
              className={`${archiveStyles.viewTab} ${
                view === item ? archiveStyles.viewTabActive : ''
              }`}
              onClick={() => selectView(item)}
            >
              {item === 'inbox' ? 'Inbox' : 'Archiv'}
            </button>
          ))}
        </div>
        <div className="inbox-speech-bar">
          <span className={`inbox-speech-status state-${speech.state}`}>
            {SPEECH_STATE_LABEL[speech.state] ?? speech.state}
          </span>
          <button
            type="button"
            className={`inbox-speech-mic ${speech.state === 'recording' ? 'recording' : ''}`}
            title={`${
              speech.state === 'recording'
                ? 'Aufnahme stoppen'
                : speech.state === 'transcribing'
                  ? 'Abbrechen'
                  : 'Spracheingabe starten/stoppen'
            } · Kürzel ${shortcutKeys} · Shortcut ${shortcutKeys}`}
            disabled={speech.state === 'review' || saving}
            aria-pressed={speech.state === 'recording'}
            aria-keyshortcuts={shortcutAriaKeys}
            onClick={() => void speech.toggleRecording()}
          >
            {speech.state === 'recording' ? '■' : '🎙'}
          </button>
          <kbd className="inbox-speech-shortcut" title={`Kürzel ${shortcutKeys} · Shortcut ${shortcutKeys}`}>
            {shortcutKeys}
          </kbd>
          <button
            type="button"
            className="inbox-btn ghost sm"
            title="Cloud-STT Einstellungen"
            onClick={() => openSpeechSettings()}
          >
            ⚙ STT
          </button>
        </div>
        <div className="spacer" />
        <button type="button" className="inbox-btn" disabled={saving || speechBusy} onClick={() => void createIdea()}>
          ＋ Neue Idee
        </button>
        <button
          type="button"
          className="inbox-btn ghost"
          onClick={() => {
            window.location.hash = ''
          }}
        >
          ← Workspace
        </button>
      </div>

      {(error || speech.error) && (
        <div className="inbox-error">{error || speech.error}</div>
      )}

      {speech.status && Number.isFinite(speech.status.maxDurationMs) && Number.isFinite(speech.status.maxBytes) && (
        <div className="inbox-speech-hint">
          Limit: {Math.round(speech.status.maxDurationMs / 1000)}s ·{' '}
          {Math.round(speech.status.maxBytes / (1024 * 1024))} MB · Modell {speech.status.model}
          {!speech.status.configured && ' · API-Schlüssel fehlt'}
        </div>
      )}

      {showVoiceReview && speech.voiceDraft && (
        <section className="inbox-voice-review" aria-label="Sprachtranskript Vorschau">
          <div className="inbox-voice-review-head">
            <b>Neuer Ideenentwurf aus Sprache</b>
            <span className="hint">Erst nach Bestätigung gespeichert</span>
          </div>
          <label className="inbox-field">
            <span>Titel</span>
            <input
              value={speech.voiceDraft.title}
              onChange={(e) => speech.updateVoiceDraft({ title: e.target.value })}
            />
          </label>
          <label className="inbox-field">
            <span>Inhalt (editierbar)</span>
            <textarea
              rows={6}
              value={speech.voiceDraft.content}
              onChange={(e) => speech.updateVoiceDraft({ content: e.target.value })}
            />
          </label>
          <div className="inbox-voice-review-actions">
            <button type="button" className="inbox-btn ghost" onClick={speech.discardVoiceDraft}>
              Verwerfen
            </button>
            <button
              type="button"
              className="inbox-btn"
              disabled={saving || !speech.voiceDraft.content.trim()}
              onClick={() => void confirmVoiceDraft()}
            >
              Als Idee speichern
            </button>
          </div>
        </section>
      )}

      <div className="inbox-body">
        <aside className="inbox-list">
          {loading && <div className="inbox-empty">Lade…</div>}
          {!loading && visibleIdeas.length === 0 && (
            <div className="inbox-empty">
              {view === 'archive'
                ? 'Noch keine archivierten Ideen.'
                : 'Noch keine Ideen. Erstelle die erste oder nutze 🎙.'}
            </div>
          )}
          {visibleIdeas.map((idea) => (
            <button
              type="button"
              key={idea.id}
              className={`inbox-row ${idea.id === selectedId ? 'active' : ''}`}
              onClick={() => selectIdea(idea)}
            >
              <div className="row-title">{idea.title}</div>
              <div className="row-meta">
                <span className="status">{STATUS_LABEL[idea.status]}</span>
                <span>
                  {ideaTimestampLabel(view)} {formatIdeaDate(ideaTimestamp(idea, view))}
                </span>
              </div>
              {idea.tags.length > 0 && (
                <div className="row-tags">
                  {idea.tags.map((tag) => (
                    <span key={tag} className="tag">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </button>
          ))}
        </aside>

        <section className="inbox-editor">
          {!draft ? (
            <div className="inbox-empty">
              {view === 'archive'
                ? 'Wähle eine archivierte Idee.'
                : 'Wähle oder erstelle eine Idee.'}
            </div>
          ) : view === 'archive' ? (
            <ArchiveDetail idea={draft} saving={saving} onRestore={() => void restoreIdea()} />
          ) : (
            <>
              <div className="inbox-editor-head">
                <input
                  ref={titleInputRef}
                  className="inbox-title-input"
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  aria-label="Titel"
                />
                <select
                  value={draft.status}
                  onChange={(e) =>
                    setDraft({ ...draft, status: e.target.value as IdeaStatus })
                  }
                  aria-label="Status"
                >
                  {IDEA_INPUT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="inbox-btn ghost"
                  disabled={saving || speechBusy || promptSession.phase === 'loading'}
                  aria-expanded={promptSession.open}
                  onClick={() => void runPromptEnhancement()}
                  title="Lokalen Draft im Main-Prozess mit der verknüpften Provider-Konfiguration schärfen"
                >
                  {promptSession.phase === 'loading' ? 'Wird geschärft …' : PROMPT_SHARPEN_LABEL}
                </button>
                <button
                  type="button"
                  className="inbox-btn"
                  disabled={saving || speechBusy || isTransferActive(draft.transfer)}
                  onClick={() => void saveDraft(true)}
                  title="Idee an Workspace-Profil übergeben und Orchestrator-Planung starten"
                >
                  An Profil übergeben
                </button>
                <button
                  type="button"
                  className="inbox-btn"
                  disabled={saving || speechBusy}
                  onClick={() => void saveDraft()}
                >
                  Speichern
                </button>
                <button
                  type="button"
                  className="inbox-btn danger"
                  disabled={speechBusy}
                  onClick={() => setConfirmDelete(true)}
                >
                  Löschen
                </button>
              </div>

              {draft.transfer && (
                <div className={`inbox-transfer-status status-${draft.transfer.status}`}>
                  {TRANSFER_STATUS_LABEL[draft.transfer.status] ?? draft.transfer.status}
                  {draft.transfer.error && ` — ${draft.transfer.error}`}
                  {draft.transfer.planId && ` · Plan ${draft.transfer.planId}`}
                  <button
                    type="button"
                    className="inbox-transfer-reset"
                    disabled={saving}
                    onClick={() => void resetTransfer()}
                  >
                    Zurücksetzen
                  </button>
                </div>
              )}

              <PromptEnhancementReview
                session={promptSession}
                onCancel={() => closePromptReview(true)}
                onRetry={(selection) => void runPromptEnhancement(selection)}
                onFallback={showDeterministicFallback}
                onCopy={() => void copyPromptResult()}
                onRequestApply={() =>
                  commitPromptSession(requestPromptApplyConfirmation(promptSessionRef.current))
                }
                onConfirmApply={confirmPromptApply}
                onCancelApply={() =>
                  commitPromptSession({ ...promptSessionRef.current, confirmApply: false })
                }
              />

              <label className="inbox-field">
                <span>Inhalt</span>
                <textarea
                  value={draft.content}
                  onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                  onPaste={handleContentPaste}
                  rows={8}
                  placeholder="Text eingeben — oder ein Bild (Screenshot) direkt hier einfügen (Strg+V)."
                />
              </label>

              <label className="inbox-field">
                <span>Tags (kommagetrennt)</span>
                <input
                  value={draft.tags.join(', ')}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean)
                    })
                  }
                />
              </label>

              <div className="inbox-refs">
                <label>
                  Profil-ID
                  <input
                    value={draft.refs?.profileId ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        refs: { ...draft.refs, profileId: e.target.value || undefined }
                      })
                    }
                  />
                </label>
                <label>
                  Workspace-ID
                  <input
                    value={draft.refs?.workspaceId ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        refs: { ...draft.refs, workspaceId: e.target.value || undefined }
                      })
                    }
                  />
                </label>
                <label>
                  Plan-ID
                  <input
                    value={draft.refs?.planId ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        refs: { ...draft.refs, planId: e.target.value || undefined }
                      })
                    }
                  />
                </label>
                <label>
                  Task-ID
                  <input
                    value={draft.refs?.taskId ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        refs: { ...draft.refs, taskId: e.target.value || undefined }
                      })
                    }
                  />
                </label>
              </div>

              <section className={archiveStyles.attributeSection} aria-label="Attribute entfernen">
                <div className={archiveStyles.sectionLabel}>Attribute entfernen</div>
                {listRemovableIdeaAttributes(draft).length > 0 ? (
                  <div className={archiveStyles.attributeList}>
                    {listRemovableIdeaAttributes(draft).map((option) => (
                      <span key={option.id} className={archiveStyles.attributeChip}>
                        <span className={archiveStyles.attributeValue}>
                          {option.label}: {option.value}
                        </span>
                        <button
                          type="button"
                          className={archiveStyles.attributeRemove}
                          disabled={saving}
                          aria-label={`${option.label} ${option.value} entfernen`}
                          title={`${option.label} entfernen`}
                          onClick={() => void removeAttribute(option.attribute)}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className={archiveStyles.muted}>Keine entfernbaren Attribute.</div>
                )}
              </section>

              <div className="inbox-artifacts">
                <div className="inbox-artifacts-head">
                  <span>Artefakte ({draft.artifacts.length})</span>
                  <div className="inbox-artifact-actions">
                    <button type="button" className="inbox-btn sm" disabled={saving} onClick={() => void addFile()}>
                      Datei
                    </button>
                  </div>
                </div>

                <div className="inbox-artifact-add">
                  <input
                    placeholder="URL (https://…)"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                  />
                  <button type="button" className="inbox-btn sm" disabled={saving} onClick={() => void addUrl()}>
                    URL hinzufügen
                  </button>
                </div>
                <div className="inbox-artifact-add">
                  <textarea
                    placeholder="Text-Artefakt"
                    value={textInput}
                    onChange={(e) => setTextInput(e.target.value)}
                    rows={2}
                  />
                  <button type="button" className="inbox-btn sm" disabled={saving} onClick={() => void addText()}>
                    Text hinzufügen
                  </button>
                </div>

                <div className="inbox-artifact-list">
                  {draft.artifacts.map((artifact) => (
                    <ArtifactRow
                      key={artifact.id}
                      artifact={artifact}
                      preview={imagePreviews[artifact.id]}
                      onRemove={() => void removeArtifact(artifact.id)}
                    />
                  ))}
                  {draft.artifacts.length === 0 && (
                    <div className="inbox-empty small">Keine Artefakte.</div>
                  )}
                </div>
              </div>

              <div className="inbox-meta">
                ID: {draft.id} · erstellt {formatIdeaDate(draft.createdAt)} · aktualisiert{' '}
                {formatIdeaDate(draft.updatedAt)}
              </div>
            </>
          )}
        </section>
      </div>

      {transferOpen && draft && (
        <IdeaTransferModal
          idea={draft}
          onClose={() => setTransferOpen(false)}
          onTransferred={(idea) => {
            setDraft({ ...idea })
            void refresh()
          }}
        />
      )}

      {confirmDelete && draft && (
        <>
          <div className="confirm-backdrop" onClick={() => setConfirmDelete(false)} />
          <div className="confirm-pop" role="alertdialog" aria-modal="true">
            <div className="head">
              <b>Idee löschen?</b>
            </div>
            <div className="text">
              „{draft.title}“ und alle Artefakt-Metadaten werden unwiderruflich entfernt.
            </div>
            <div className="actions">
              <button type="button" className="btn-ghost" onClick={() => setConfirmDelete(false)}>
                Abbrechen
              </button>
              <button type="button" className="btn-danger" disabled={saving} onClick={() => void deleteIdea()}>
                Löschen
              </button>
            </div>
          </div>
        </>
      )}
    </main>
  )
}
