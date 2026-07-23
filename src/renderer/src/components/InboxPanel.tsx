import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
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

// Label maps hold i18n key paths; the German/English copy lives in the locales.
const STATUS_LABEL_KEYS: Record<IdeaStatus, string> = {
  draft: 'inbox.status.draft',
  ready: 'inbox.status.ready',
  archived: 'inbox.status.archived',
  done: 'inbox.status.done'
}
const TRANSFER_STATUS_LABEL_KEYS: Record<string, string> = {
  pending: 'inbox.transferStatus.pending',
  running: 'inbox.transferStatus.running',
  planned: 'inbox.transferStatus.planned',
  failed: 'inbox.transferStatus.failed'
}
const SPEECH_STATE_LABEL_KEYS: Record<string, string> = {
  idle: 'inbox.speechState.idle',
  recording: 'inbox.speechState.recording',
  transcribing: 'inbox.speechState.transcribing',
  review: 'inbox.speechState.review',
  failed: 'inbox.speechState.failed'
}

/** Localized idea status (defined for every member of the known status union). */
function statusLabel(t: TFunction, status: IdeaStatus): string {
  return t(STATUS_LABEL_KEYS[status])
}

/** Localized transfer status; unknown backend states fall back to their raw id. */
function transferStatusLabel(t: TFunction, status: string): string {
  const key = TRANSFER_STATUS_LABEL_KEYS[status]
  return key ? t(key) : status
}

/** Localized speech state; unknown states fall back to their raw id. */
function speechStateLabel(t: TFunction, state: string): string {
  const key = SPEECH_STATE_LABEL_KEYS[state]
  return key ? t(key) : state
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
  const { t } = useTranslation()
  let detail = ''
  let warn = ''
  if (artifact.kind === 'text') {
    detail = artifact.text?.slice(0, 120) ?? ''
  } else if (artifact.kind === 'url') {
    detail = artifact.url ?? ''
    if (artifact.urlInvalid) warn = t('inbox.artifact.urlInvalid')
  } else if (artifact.kind === 'image') {
    detail = artifact.fileName ?? artifact.label
    if (artifact.missing) warn = t('inbox.artifact.imageMissing')
  } else {
    detail = artifact.fileName ?? artifact.sourcePath ?? ''
    if (artifact.missing) warn = t('inbox.artifact.fileMissing')
    else if (artifact.copied === false) warn = t('inbox.artifact.referenceOnly')
  }

  return (
    <div className={`inbox-artifact ${warn ? 'warn' : ''}`}>
      <div className="inbox-artifact-head">
        <span className="kind">{artifact.kind}</span>
        <span className="label">{artifact.label}</span>
        {onRemove && (
          <button type="button" className="icon-btn-sm" title={t('inbox.artifact.removeTitle')} onClick={onRemove}>
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
  const { t } = useTranslation()
  const attributes = listRemovableIdeaAttributes(idea)
  const history = sortedIdeaHistory(idea)
  const workspaces = workspaceReferences(idea)

  return (
    <>
      <div className={archiveStyles.archiveHead}>
        <h2 className={archiveStyles.archiveTitle}>{idea.title || t('inbox.archive.untitled')}</h2>
        <span className={archiveStyles.archiveStatus}>{statusLabel(t, idea.status)}</span>
        <button
          type="button"
          className="inbox-btn"
          disabled={saving}
          onClick={onRestore}
        >
          {t('inbox.archive.restore')}
        </button>
      </div>

      <section className={archiveStyles.archiveSection} aria-label={t('inbox.archive.content')}>
        <div className={archiveStyles.sectionLabel}>{t('inbox.archive.content')}</div>
        <p className={archiveStyles.readOnlyContent}>{idea.content || '—'}</p>
      </section>

      <section className={archiveStyles.archiveSection} aria-label={t('inbox.archive.attributes')}>
        <div className={archiveStyles.sectionLabel}>{t('inbox.archive.attributes')}</div>
        {attributes.length > 0 ? (
          <div className={archiveStyles.chipList}>
            {attributes.map((attribute) => (
              <span key={attribute.id} className={archiveStyles.readOnlyChip}>
                {attribute.label}: {attribute.value}
              </span>
            ))}
          </div>
        ) : (
          <div className={archiveStyles.muted}>{t('inbox.archive.noAttributes')}</div>
        )}
      </section>

      <section className={archiveStyles.archiveSection} aria-label={t('inbox.archive.workspaceLink')}>
        <div className={archiveStyles.sectionLabel}>{t('inbox.archive.workspaceLink')}</div>
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
          <div className={archiveStyles.muted}>{t('inbox.archive.noWorkspaceLink')}</div>
        )}
      </section>

      <section className={archiveStyles.archiveSection} aria-label={t('inbox.archive.transferTelemetry')}>
        <div className={archiveStyles.sectionLabel}>{t('inbox.archive.transferTelemetry')}</div>
        {idea.transfer ? (
          <div className={`inbox-transfer-status status-${idea.transfer.status}`}>
            {transferStatusLabel(t, idea.transfer.status)}
            {idea.transfer.error && ` — ${idea.transfer.error}`}
            {idea.transfer.planId && ` · Plan ${idea.transfer.planId}`}
          </div>
        ) : (
          <div className={archiveStyles.muted}>{t('inbox.archive.noTransferTelemetry')}</div>
        )}
      </section>

      <section className={archiveStyles.archiveSection} aria-label={t('inbox.archive.artifactsAria')}>
        <div className={archiveStyles.sectionLabel}>{t('inbox.artifacts', { count: idea.artifacts.length })}</div>
        <div className="inbox-artifact-list">
          {idea.artifacts.map((artifact) => (
            <ArtifactRow key={artifact.id} artifact={artifact} />
          ))}
          {idea.artifacts.length === 0 && (
            <div className={archiveStyles.muted}>{t('inbox.noArtifacts')}</div>
          )}
        </div>
      </section>

      <section className={archiveStyles.archiveSection} aria-label={t('inbox.archive.history')}>
        <div className={archiveStyles.sectionLabel}>{t('inbox.archive.history')}</div>
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
          <div className={archiveStyles.muted}>{t('inbox.archive.noHistory')}</div>
        )}
      </section>

      <div className="inbox-meta">
        {t('inbox.archive.meta', {
          id: idea.id,
          created: formatIdeaDate(idea.createdAt),
          archived: formatIdeaDate(ideaTimestamp(idea, 'archive'))
        })}
      </div>
    </>
  )
}

export default function InboxPanel(): JSX.Element {
  const { t } = useTranslation()
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
      setError(t('inbox.errors.copyFailed', { error: err instanceof Error ? err.message : String(err) }))
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
      setError(t('inbox.errors.archivedReadonly'))
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
        title: speech.voiceDraft.title.trim() || t('inbox.voiceDraft.defaultTitle'),
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
      setError(t('inbox.errors.unsupportedImage'))
      return
    }
    let dataUrl: string
    try {
      dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error ?? new Error(t('inbox.errors.imageRead')))
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
      aria-label={view === 'archive' ? t('inbox.ariaArchive') : t('inbox.ariaInbox')}
    >
      <div className="inbox-header">
        <div>
          <div className="inbox-title">
            {view === 'archive' ? t('inbox.titleArchive') : t('inbox.titleInbox')}
          </div>
          <div className="inbox-sub">
            {view === 'archive' ? t('inbox.subArchive') : t('inbox.subInbox')}
          </div>
        </div>
        <div className={archiveStyles.viewSwitch} role="tablist" aria-label={t('inbox.viewAria')}>
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
              {item === 'inbox' ? t('inbox.tabInbox') : t('inbox.tabArchive')}
            </button>
          ))}
        </div>
        <div className="inbox-speech-bar">
          <span className={`inbox-speech-status state-${speech.state}`}>
            {speechStateLabel(t, speech.state)}
          </span>
          <button
            type="button"
            className={`inbox-speech-mic ${speech.state === 'recording' ? 'recording' : ''}`}
            title={t('inbox.micTitle', {
              action:
                speech.state === 'recording'
                  ? t('inbox.micStop')
                  : speech.state === 'transcribing'
                    ? t('inbox.micCancel')
                    : t('inbox.micStartStop'),
              keys: shortcutKeys
            })}
            disabled={speech.state === 'review' || saving}
            aria-pressed={speech.state === 'recording'}
            aria-keyshortcuts={shortcutAriaKeys}
            onClick={() => void speech.toggleRecording()}
          >
            {speech.state === 'recording' ? '■' : '🎙'}
          </button>
          <kbd className="inbox-speech-shortcut" title={t('inbox.shortcutTitle', { keys: shortcutKeys })}>
            {shortcutKeys}
          </kbd>
          <button
            type="button"
            className="inbox-btn ghost sm"
            title={t('inbox.sttSettings')}
            onClick={() => openSpeechSettings()}
          >
            {t('inbox.sttButton')}
          </button>
        </div>
        <div className="spacer" />
        <button type="button" className="inbox-btn" disabled={saving || speechBusy} onClick={() => void createIdea()}>
          {t('inbox.newIdea')}
        </button>
        <button
          type="button"
          className="inbox-btn ghost"
          onClick={() => {
            window.location.hash = ''
          }}
        >
          {t('inbox.backToWorkspace')}
        </button>
      </div>

      {(error || speech.error) && (
        <div className="inbox-error">{error || speech.error}</div>
      )}

      {speech.status && Number.isFinite(speech.status.maxDurationMs) && Number.isFinite(speech.status.maxBytes) && (
        <div className="inbox-speech-hint">
          {t('inbox.speechLimit', {
            seconds: Math.round(speech.status.maxDurationMs / 1000),
            megabytes: Math.round(speech.status.maxBytes / (1024 * 1024)),
            model: speech.status.model
          })}
          {!speech.status.configured && ` · ${t('inbox.apiKeyMissing')}`}
        </div>
      )}

      {showVoiceReview && speech.voiceDraft && (
        <section className="inbox-voice-review" aria-label={t('inbox.voiceReviewAria')}>
          <div className="inbox-voice-review-head">
            <b>{t('inbox.voiceReviewHead')}</b>
            <span className="hint">{t('inbox.voiceReviewHint')}</span>
          </div>
          <label className="inbox-field">
            <span>{t('inbox.fieldTitle')}</span>
            <input
              value={speech.voiceDraft.title}
              onChange={(e) => speech.updateVoiceDraft({ title: e.target.value })}
            />
          </label>
          <label className="inbox-field">
            <span>{t('inbox.fieldContentEditable')}</span>
            <textarea
              rows={6}
              value={speech.voiceDraft.content}
              onChange={(e) => speech.updateVoiceDraft({ content: e.target.value })}
            />
          </label>
          <div className="inbox-voice-review-actions">
            <button type="button" className="inbox-btn ghost" onClick={speech.discardVoiceDraft}>
              {t('inbox.discard')}
            </button>
            <button
              type="button"
              className="inbox-btn"
              disabled={saving || !speech.voiceDraft.content.trim()}
              onClick={() => void confirmVoiceDraft()}
            >
              {t('inbox.saveAsIdea')}
            </button>
          </div>
        </section>
      )}

      <div className="inbox-body">
        <aside className="inbox-list">
          {loading && <div className="inbox-empty">{t('inbox.loading')}</div>}
          {!loading && visibleIdeas.length === 0 && (
            <div className="inbox-empty">
              {view === 'archive' ? t('inbox.emptyArchive') : t('inbox.emptyInbox')}
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
                <span className="status">{statusLabel(t, idea.status)}</span>
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
              {view === 'archive' ? t('inbox.pickArchive') : t('inbox.pickInbox')}
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
                  aria-label={t('inbox.titleAria')}
                />
                <select
                  value={draft.status}
                  onChange={(e) =>
                    setDraft({ ...draft, status: e.target.value as IdeaStatus })
                  }
                  aria-label={t('inbox.statusAria')}
                >
                  {IDEA_INPUT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {statusLabel(t, s)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="inbox-btn ghost"
                  disabled={saving || speechBusy || promptSession.phase === 'loading'}
                  aria-expanded={promptSession.open}
                  onClick={() => void runPromptEnhancement()}
                  title={t('inbox.sharpenTitle')}
                >
                  {promptSession.phase === 'loading' ? t('inbox.sharpening') : PROMPT_SHARPEN_LABEL}
                </button>
                <button
                  type="button"
                  className="inbox-btn"
                  disabled={saving || speechBusy || isTransferActive(draft.transfer)}
                  onClick={() => void saveDraft(true)}
                  title={t('inbox.transferToProfileTitle')}
                >
                  {t('inbox.transferToProfile')}
                </button>
                <button
                  type="button"
                  className="inbox-btn"
                  disabled={saving || speechBusy}
                  onClick={() => void saveDraft()}
                >
                  {t('inbox.save')}
                </button>
                <button
                  type="button"
                  className="inbox-btn danger"
                  disabled={speechBusy}
                  onClick={() => setConfirmDelete(true)}
                >
                  {t('inbox.delete')}
                </button>
              </div>

              {draft.transfer && (
                <div className={`inbox-transfer-status status-${draft.transfer.status}`}>
                  {transferStatusLabel(t, draft.transfer.status)}
                  {draft.transfer.error && ` — ${draft.transfer.error}`}
                  {draft.transfer.planId && ` · Plan ${draft.transfer.planId}`}
                  <button
                    type="button"
                    className="inbox-transfer-reset"
                    disabled={saving}
                    onClick={() => void resetTransfer()}
                  >
                    {t('inbox.resetTransfer')}
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
                <span>{t('inbox.contentLabel')}</span>
                <textarea
                  value={draft.content}
                  onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                  onPaste={handleContentPaste}
                  rows={8}
                  placeholder={t('inbox.contentPlaceholder')}
                />
              </label>

              <label className="inbox-field">
                <span>{t('inbox.tagsLabel')}</span>
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
                  {t('inbox.profileId')}
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
                  {t('inbox.workspaceId')}
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
                  {t('inbox.planId')}
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
                  {t('inbox.taskId')}
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

              <section className={archiveStyles.attributeSection} aria-label={t('inbox.removeAttributesLabel')}>
                <div className={archiveStyles.sectionLabel}>{t('inbox.removeAttributesLabel')}</div>
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
                          aria-label={t('inbox.removeAttributeAria', { label: option.label, value: option.value })}
                          title={t('inbox.removeAttributeTitle', { label: option.label })}
                          onClick={() => void removeAttribute(option.attribute)}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className={archiveStyles.muted}>{t('inbox.noRemovableAttributes')}</div>
                )}
              </section>

              <div className="inbox-artifacts">
                <div className="inbox-artifacts-head">
                  <span>{t('inbox.artifacts', { count: draft.artifacts.length })}</span>
                  <div className="inbox-artifact-actions">
                    <button type="button" className="inbox-btn sm" disabled={saving} onClick={() => void addFile()}>
                      {t('inbox.file')}
                    </button>
                  </div>
                </div>

                <div className="inbox-artifact-add">
                  <input
                    placeholder={t('inbox.urlPlaceholder')}
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                  />
                  <button type="button" className="inbox-btn sm" disabled={saving} onClick={() => void addUrl()}>
                    {t('inbox.addUrl')}
                  </button>
                </div>
                <div className="inbox-artifact-add">
                  <textarea
                    placeholder={t('inbox.textPlaceholder')}
                    value={textInput}
                    onChange={(e) => setTextInput(e.target.value)}
                    rows={2}
                  />
                  <button type="button" className="inbox-btn sm" disabled={saving} onClick={() => void addText()}>
                    {t('inbox.addText')}
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
                    <div className="inbox-empty small">{t('inbox.noArtifacts')}</div>
                  )}
                </div>
              </div>

              <div className="inbox-meta">
                {t('inbox.editor.meta', {
                  id: draft.id,
                  created: formatIdeaDate(draft.createdAt),
                  updated: formatIdeaDate(draft.updatedAt)
                })}
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
              <b>{t('inbox.deleteConfirmTitle')}</b>
            </div>
            <div className="text">
              {t('inbox.deleteConfirmText', { title: draft.title })}
            </div>
            <div className="actions">
              <button type="button" className="btn-ghost" onClick={() => setConfirmDelete(false)}>
                {t('inbox.cancel')}
              </button>
              <button type="button" className="btn-danger" disabled={saving} onClick={() => void deleteIdea()}>
                {t('inbox.delete')}
              </button>
            </div>
          </div>
        </>
      )}
    </main>
  )
}
