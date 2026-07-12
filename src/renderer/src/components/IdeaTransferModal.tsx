import { useEffect, useState } from 'react'
import { useAppStore } from '@renderer/store/useAppStore'
import type { Idea } from '@shared/inbox'
import { isTransferActive } from '@shared/inboxTransfer'

const TRANSFER_STATUS_LABEL: Record<string, string> = {
  pending: 'Wartet',
  running: 'Läuft',
  planned: 'Plan im Review',
  failed: 'Fehlgeschlagen'
}

export default function IdeaTransferModal({
  idea,
  onClose,
  onTransferred
}: {
  idea: Idea
  onClose: () => void
  onTransferred: (idea: Idea) => void
}): JSX.Element {
  const store = useAppStore()
  const [profileId, setProfileId] = useState(store.activeProfileId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [lastResult, setLastResult] = useState<Idea['transfer']>()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  const runTransfer = async (clone?: boolean): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await window.orca.inbox.transferToProfile({
        ideaId: idea.id,
        profileId,
        clone,
        yoloMaster: store.yoloMaster
      })
      setLastResult(result.transfer)
      if (result.duplicate) {
        setError('Übergabe läuft bereits — keine zweite Planung gestartet.')
        return
      }
      if (result.transfer.status === 'failed') {
        setError(result.transfer.error ?? 'Übergabe fehlgeschlagen.')
        onTransferred(result.idea)
        return
      }
      await store.selectProfile(profileId)
      onTransferred(result.idea)
      window.location.hash = ''
      store.showToast(`Idee „${idea.title}" an Workspace übergeben — Planung läuft.`)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const retry = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await window.orca.inbox.transferRetry(idea.id, store.yoloMaster)
      setLastResult(result.transfer)
      if (result.transfer.status === 'failed') {
        setError(result.transfer.error ?? 'Wiederholung fehlgeschlagen.')
        onTransferred(result.idea)
        return
      }
      await store.selectProfile(profileId)
      onTransferred(result.idea)
      window.location.hash = ''
      store.showToast('Übergabe wiederholt — Workspace geöffnet.')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const transfer = lastResult ?? idea.transfer
  const needsClone = transfer?.action === 'needsClone'
  const canRetry = transfer?.status === 'failed' && transfer.retryable !== false

  return (
    <div className="modal-wrap">
      <div className="modal-scrim" onClick={() => !busy && onClose()} />
      <div className="modal idea-transfer-modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <span className="modal-gear">➜</span>
          <div style={{ flex: 1 }}>
            <div className="modal-title">An Workspace-Profil übergeben</div>
            <div className="modal-sub">
              Idee „{idea.title}" planen lassen — Review-Gate vor Subagent-Start
            </div>
          </div>
          <button type="button" className="modal-close" aria-label="Schließen" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          {idea.transfer && (
            <div className={`inbox-transfer-status status-${idea.transfer.status}`}>
              Status: {TRANSFER_STATUS_LABEL[idea.transfer.status] ?? idea.transfer.status}
              {idea.transfer.planId && ` · Plan ${idea.transfer.planId}`}
            </div>
          )}

          <label className="inbox-field">
            <span>Workspace-Profil</span>
            <select
              value={profileId}
              disabled={busy || isTransferActive(idea.transfer)}
              onChange={(e) => setProfileId(e.target.value)}
            >
              {store.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {!p.orchestrator ? ' (ohne Orchestrator)' : ''}
                </option>
              ))}
            </select>
          </label>

          {error && <div className="inbox-error">{error}</div>}

          {needsClone && (
            <div className="inbox-transfer-hint">
              Repository ist gebunden, aber noch nicht geklont. Klonen startet den vorhandenen
              GitHub-Bindungsflow.
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>
            Abbrechen
          </button>
          {canRetry && (
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void retry()}>
              Erneut versuchen
            </button>
          )}
          {needsClone ? (
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => void runTransfer(true)}
            >
              Klonen & übergeben
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              disabled={busy || isTransferActive(idea.transfer)}
              onClick={() => void runTransfer()}
            >
              {busy ? 'Übergabe…' : 'Übergeben & planen'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
