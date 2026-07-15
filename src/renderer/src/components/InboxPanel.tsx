import { useCallback, useEffect, useRef, useState } from 'react'
import type { Idea, IdeaArtifact, IdeaStatus } from '@shared/inbox'
import { IDEA_STATUSES } from '@shared/inbox'
import { isTransferActive } from '@shared/inboxTransfer'
import { useInboxSpeech } from '@renderer/hooks/useInboxSpeech'
import { useAppStore } from '@renderer/store/useAppStore'
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
import styles from './responsiveGuards.module.css'

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

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function ArtifactRow({
  artifact,
  onRemove
}: {
  artifact: IdeaArtifact
  onRemove: () => void
}): JSX.Element {
  let detail = ''
  let warn = ''
  if (artifact.kind === 'text') {
    detail = artifact.text?.slice(0, 120) ?? ''
  } else if (artifact.kind === 'url') {
    detail = artifact.url ?? ''
    if (artifact.urlInvalid) warn = 'Ungültige URL'
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
        <button type="button" className="icon-btn-sm" title="Artefakt entfernen" onClick={onRemove}>
          ✕
        </button>
      </div>
      <div className="inbox-artifact-body" title={detail}>
        {detail || '—'}
      </div>
      {warn && <div className="inbox-artifact-warn">{warn}</div>}
    </div>
  )
}

export default function InboxPanel(): JSX.Element {
  const speech = useInboxSpeech()
  const openSpeechSettings = useAppStore((state) => state.openSpeechSettings)
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Idea | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [textInput, setTextInput] = useState('')
  const [transferOpen, setTransferOpen] = useState(false)
  const [promptSession, setPromptSession] = useState<PromptEnhancementSession>(
    INITIAL_PROMPT_ENHANCEMENT_SESSION
  )
  const promptSessionRef = useRef(promptSession)
  const activePromptRef = useRef<{ requestId: string; generation: number }>()
  const titleInputRef = useRef<HTMLInputElement>(null)

  const commitPromptSession = (next: PromptEnhancementSession): void => {
    promptSessionRef.current = next
    setPromptSession(next)
  }

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const list = await window.orca.inbox.list()
      setIdeas(list)
      if (selectedId) {
        const current = list.find((i) => i.id === selectedId)
        if (current) setDraft({ ...current })
        else {
          setSelectedId(list[0]?.id ?? null)
          setDraft(list[0] ? { ...list[0] } : null)
        }
      } else if (list[0]) {
        setSelectedId(list[0].id)
        setDraft({ ...list[0] })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [selectedId])

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
      if (active) void window.orca.inbox.abortPromptEnhancement(active.requestId).catch(() => undefined)
    }
  }, [])

  const closePromptReview = (showAborted = true): void => {
    const active = activePromptRef.current
    activePromptRef.current = undefined
    if (active) {
      void window.orca.inbox.abortPromptEnhancement(active.requestId).catch(() => undefined)
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
    const requestId = globalThis.crypto?.randomUUID?.() ??
      `prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
      const result = await window.orca.inbox.enhancePrompt({
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

  const createIdea = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      const idea = await window.orca.inbox.create()
      const list = await window.orca.inbox.list()
      setIdeas(list)
      selectIdea(idea)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const saveDraft = async (openTransferAfterSave = false): Promise<void> => {
    if (!draft) return
    setSaving(true)
    setError('')
    try {
      const updated = await window.orca.inbox.update({
        id: draft.id,
        title: draft.title,
        content: draft.content,
        status: draft.status,
        tags: draft.tags,
        refs: draft.refs
      })
      const list = await window.orca.inbox.list()
      setIdeas(list)
      setDraft({ ...updated })
      if (openTransferAfterSave) setTransferOpen(true)
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
      const idea = await window.orca.inbox.create({
        title: speech.voiceDraft.title.trim() || 'Sprachnotiz',
        content: speech.voiceDraft.content,
        status: 'draft',
        tags: ['sprache']
      })
      const list = await window.orca.inbox.list()
      setIdeas(list)
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
      const list = await window.orca.inbox.delete(draft.id)
      setIdeas(list)
      setConfirmDelete(false)
      if (list[0]) selectIdea(list[0])
      else {
        setSelectedId(null)
        setDraft(null)
      }
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
      const updated = await window.orca.inbox.transferReset(draft.id)
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
      const updated = await window.orca.inbox.addArtifact(draft.id, {
        kind: 'text',
        text: textInput.trim()
      })
      setTextInput('')
      setDraft({ ...updated })
      const list = await window.orca.inbox.list()
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
      const updated = await window.orca.inbox.addArtifact(draft.id, {
        kind: 'url',
        url: urlInput.trim()
      })
      setUrlInput('')
      setDraft({ ...updated })
      const list = await window.orca.inbox.list()
      setIdeas(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const addFile = async (): Promise<void> => {
    if (!draft) return
    const picked = await window.orca.pickFile()
    if (!picked) return
    setSaving(true)
    setError('')
    try {
      const updated = await window.orca.inbox.addArtifact(draft.id, {
        kind: 'file',
        grantId: picked.grantId,
        label: picked.fileName
      })
      setDraft({ ...updated })
      const list = await window.orca.inbox.list()
      setIdeas(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const removeArtifact = async (artifactId: string): Promise<void> => {
    if (!draft) return
    setSaving(true)
    setError('')
    try {
      const updated = await window.orca.inbox.removeArtifact(draft.id, artifactId)
      setDraft({ ...updated })
      const list = await window.orca.inbox.list()
      setIdeas(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const speechBusy = speech.state === 'recording' || speech.state === 'transcribing'
  const showVoiceReview = speech.state === 'review' && speech.voiceDraft
  return (
    <main className={`inbox-panel ${styles.inboxPanel}`} aria-label="Ideen-Inbox">
      <div className="inbox-header">
        <div>
          <div className="inbox-title">Ideen-Inbox</div>
          <div className="inbox-sub">Ideen, Notizen und Spracheingabe — unabhängig vom Workspace</div>
        </div>
        <div className="inbox-speech-bar">
          <span className={`inbox-speech-status state-${speech.state}`}>
            {SPEECH_STATE_LABEL[speech.state] ?? speech.state}
          </span>
          <button
            type="button"
            className={`inbox-speech-mic ${speech.state === 'recording' ? 'recording' : ''}`}
            title={
              speech.state === 'recording'
                ? 'Aufnahme stoppen'
                : speech.state === 'transcribing'
                  ? 'Abbrechen'
                  : 'Spracheingabe starten/stoppen'
            }
            disabled={speech.state === 'review' || saving}
            aria-pressed={speech.state === 'recording'}
            onClick={() => void speech.toggleRecording()}
          >
            {speech.state === 'recording' ? '■' : '🎙'}
          </button>
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

      {speech.status && (
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
          {!loading && ideas.length === 0 && (
            <div className="inbox-empty">Noch keine Ideen. Erstelle die erste oder nutze 🎙.</div>
          )}
          {ideas.map((idea) => (
            <button
              type="button"
              key={idea.id}
              className={`inbox-row ${idea.id === selectedId ? 'active' : ''}`}
              onClick={() => selectIdea(idea)}
            >
              <div className="row-title">{idea.title}</div>
              <div className="row-meta">
                <span className="status">{STATUS_LABEL[idea.status]}</span>
                <span>{fmtDate(idea.updatedAt)}</span>
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
            <div className="inbox-empty">Wähle oder erstelle eine Idee.</div>
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
                  {IDEA_STATUSES.map((s) => (
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
                  Übergabe {TRANSFER_STATUS_LABEL[draft.transfer.status] ?? draft.transfer.status}
                  {draft.transfer.error && ` — ${draft.transfer.error}`}
                  {draft.transfer.planId && ` · Plan ${draft.transfer.planId}`}
                  <button
                    type="button"
                    className="inbox-transfer-reset"
                    disabled={saving}
                    onClick={() => void resetTransfer()}
                  >
                    Zuruecksetzen
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
                  rows={8}
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
                      onRemove={() => void removeArtifact(artifact.id)}
                    />
                  ))}
                  {draft.artifacts.length === 0 && (
                    <div className="inbox-empty small">Keine Artefakte.</div>
                  )}
                </div>
              </div>

              <div className="inbox-meta">
                ID: {draft.id} · erstellt {fmtDate(draft.createdAt)} · aktualisiert{' '}
                {fmtDate(draft.updatedAt)}
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
