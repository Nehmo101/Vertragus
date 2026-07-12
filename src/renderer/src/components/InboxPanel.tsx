import { useCallback, useEffect, useState } from 'react'
import type { Idea, IdeaArtifact, IdeaStatus } from '@shared/inbox'
import { IDEA_STATUSES } from '@shared/inbox'

const STATUS_LABEL: Record<IdeaStatus, string> = {
  draft: 'Entwurf',
  ready: 'Bereit',
  archived: 'Archiv',
  done: 'Erledigt'
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
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Idea | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [textInput, setTextInput] = useState('')

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
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectIdea = (idea: Idea): void => {
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

  const saveDraft = async (): Promise<void> => {
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
    const path = await window.orca.pickFile()
    if (!path) return
    setSaving(true)
    setError('')
    try {
      const updated = await window.orca.inbox.addArtifact(draft.id, {
        kind: 'file',
        sourcePath: path
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

  return (
    <main className="inbox-panel" aria-label="Ideen-Inbox">
      <div className="inbox-header">
        <div>
          <div className="inbox-title">Ideen-Inbox</div>
          <div className="inbox-sub">Ideen, Notizen und Artefakte lokal speichern</div>
        </div>
        <div className="spacer" />
        <button type="button" className="inbox-btn" disabled={saving} onClick={() => void createIdea()}>
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

      {error && <div className="inbox-error">{error}</div>}

      <div className="inbox-body">
        <aside className="inbox-list">
          {loading && <div className="inbox-empty">Lade…</div>}
          {!loading && ideas.length === 0 && (
            <div className="inbox-empty">Noch keine Ideen. Erstelle die erste.</div>
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
                  className="inbox-btn"
                  disabled={saving}
                  onClick={() => void saveDraft()}
                >
                  Speichern
                </button>
                <button
                  type="button"
                  className="inbox-btn danger"
                  onClick={() => setConfirmDelete(true)}
                >
                  Löschen
                </button>
              </div>

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

      {confirmDelete && draft && (
        <>
          <div className="confirm-backdrop" onClick={() => setConfirmDelete(false)} />
          <div className="confirm-pop" role="alertdialog" aria-modal="true">
            <div className="head">
              <b>Idee löschen?</b>
            </div>
            <div className="text">
              „{draft.title}" und alle Artefakt-Metadaten werden unwiderruflich entfernt.
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
