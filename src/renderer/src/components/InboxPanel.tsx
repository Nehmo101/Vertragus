import { useCallback, useEffect, useState } from 'react'
import type { Idea, IdeaArtifact, IdeaStatus } from '@shared/inbox'
import { IDEA_STATUSES } from '@shared/inbox'
import { isTransferActive } from '@shared/inboxTransfer'
import type { InboxSpeechSettings } from '@shared/inboxSpeech'
import { DEFAULT_TRANSCRIPTION_ENDPOINT, DEFAULT_TRANSCRIPTION_MODEL } from '@shared/inboxSpeech'
import { useInboxSpeech } from '@renderer/hooks/useInboxSpeech'
import IdeaTransferModal from '@renderer/components/IdeaTransferModal'
import { PROMPT_SHARPEN_LABEL, sharpenInboxPrompt } from '@renderer/inboxPrompt'
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

function InboxSpeechSettingsPanel({
  open,
  onClose,
  onSaved
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
}): JSX.Element | null {
  const [settings, setSettings] = useState<InboxSpeechSettings | null>(null)
  const [model, setModel] = useState(DEFAULT_TRANSCRIPTION_MODEL)
  const [language, setLanguage] = useState('de')
  const [endpointUrl, setEndpointUrl] = useState(DEFAULT_TRANSCRIPTION_ENDPOINT)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    void window.orca.inboxSpeech.getSettings().then((s) => {
      setSettings(s)
      setModel(s.model)
      setLanguage(s.language)
      setEndpointUrl(s.endpointUrl)
      setApiKey('')
      setError('')
    })
  }, [open])

  if (!open) return null

  const save = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      await window.orca.inboxSpeech.setSettings({
        model,
        language,
        endpointUrl,
        ...(apiKey ? { apiKey } : {})
      })
      setApiKey('')
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const clearKey = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      await window.orca.inboxSpeech.setSettings({ apiKey: '' })
      setApiKey('')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="confirm-backdrop" onClick={onClose} />
      <div className="confirm-pop inbox-speech-settings" role="dialog" aria-modal="true">
        <div className="head">
          <b>Sprache-zu-Text (Cloud)</b>
        </div>
        <div className="text">
          API-Schlüssel wird verschlüsselt im Main-Prozess gespeichert und nie an den Renderer
          zurückgegeben.
        </div>
        <label className="inbox-field">
          <span>Modell</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <label className="inbox-field">
          <span>Sprache</span>
          <input value={language} onChange={(e) => setLanguage(e.target.value)} />
        </label>
        <label className="inbox-field">
          <span>Transcriptions-Endpunkt</span>
          <input value={endpointUrl} onChange={(e) => setEndpointUrl(e.target.value)} />
        </label>
        <label className="inbox-field">
          <span>
            API-Schlüssel {settings?.hasApiKey ? '(gespeichert — leer lassen zum Behalten)' : ''}
          </span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={settings?.hasApiKey ? '••••••••' : 'sk-…'}
            autoComplete="off"
          />
        </label>
        {error && <div className="inbox-error">{error}</div>}
        <div className="actions">
          {settings?.hasApiKey && (
            <button type="button" className="btn-ghost" disabled={saving} onClick={() => void clearKey()}>
              Schlüssel löschen
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={onClose}>
            Abbrechen
          </button>
          <button type="button" className="btn-primary" disabled={saving} onClick={() => void save()}>
            Speichern
          </button>
        </div>
      </div>
    </>
  )
}

export default function InboxPanel(): JSX.Element {
  const speech = useInboxSpeech()
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Idea | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [textInput, setTextInput] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [promptPreviewOpen, setPromptPreviewOpen] = useState(false)

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

  const selectIdea = (idea: Idea): void => {
    setSelectedId(idea.id)
    setDraft({ ...idea })
    setConfirmDelete(false)
    setPromptPreviewOpen(false)
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
  const sharpenedPrompt = draft ? sharpenInboxPrompt(draft) : null

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
            onClick={() => setSettingsOpen(true)}
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
                  disabled={saving || speechBusy}
                  aria-expanded={promptPreviewOpen}
                  onClick={() => setPromptPreviewOpen((open) => !open)}
                  title="Rohe Idee als orchestrator-taugliches Briefing prüfen"
                >
                  {PROMPT_SHARPEN_LABEL}
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
                </div>
              )}

              {promptPreviewOpen && sharpenedPrompt && (
                <section className="inbox-briefing-preview inbox-prompt-preview" aria-live="polite">
                  <div className="inbox-prompt-preview-head">
                    <b>Geschärftes Orchestrator-Briefing</b>
                    <span>Vorschau · noch nicht übertragen</span>
                  </div>
                  {sharpenedPrompt.ok ? (
                    <>
                      {sharpenedPrompt.warnings.length > 0 && (
                        <div className="inbox-transfer-hint">
                          {sharpenedPrompt.warnings.join(' ')}
                        </div>
                      )}
                      <pre className="inbox-briefing-preview-content">
                        {sharpenedPrompt.briefing}
                      </pre>
                    </>
                  ) : (
                    <div className="inbox-error" role="alert">
                      {sharpenedPrompt.message}
                    </div>
                  )}
                </section>
              )}

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

      <InboxSpeechSettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => void speech.refreshStatus()}
      />

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
