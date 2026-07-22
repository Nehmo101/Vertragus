import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@renderer/store/useAppStore'
import type { Idea } from '@shared/inbox'
import {
  assessProfileOrchestrator,
  isTransferBlocking,
  previewIdeaTransferBriefing
} from '@shared/inboxTransfer'
import type { WorkspaceProfile } from '@shared/profile'

const TRANSFER_STATUS_LABEL: Record<string, string> = {
  pending: 'Wartet',
  running: 'Läuft',
  planned: 'Plan im Review',
  failed: 'Fehlgeschlagen'
}

function profileHasOrchestrator(profile: WorkspaceProfile): boolean {
  return assessProfileOrchestrator(profile).ok
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
  // Narrow store slices so agent stream ticks do not remount/collapse the profile <select>.
  const profiles = useAppStore((s) => s.profiles)
  const activeProfileId = useAppStore((s) => s.activeProfileId)
  const yoloMaster = useAppStore((s) => s.yoloMaster)
  const selectWorkspaceSession = useAppStore((s) => s.selectWorkspaceSession)
  const selectProfile = useAppStore((s) => s.selectProfile)
  const showToast = useAppStore((s) => s.showToast)
  const githubAuth = useAppStore((s) => s.githubAuth)
  const githubLogin = useAppStore((s) => s.githubLogin)
  const githubTerminalLogin = useAppStore((s) => s.githubTerminalLogin)

  const eligibleProfiles = useMemo(
    () => profiles.filter((profile) => profileHasOrchestrator(profile)),
    [profiles]
  )
  const defaultProfileId =
    eligibleProfiles.find((p) => p.id === activeProfileId)?.id ??
    eligibleProfiles[0]?.id ??
    activeProfileId
  const [profileId, setProfileId] = useState(defaultProfileId)
  const resolvedProfileId = eligibleProfiles.some((p) => p.id === profileId)
    ? profileId
    : defaultProfileId
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [lastResult, setLastResult] = useState<Idea['transfer']>()
  const [briefingPreviewOpen, setBriefingPreviewOpen] = useState(false)
  const briefingPreview = useMemo(() => previewIdeaTransferBriefing(idea), [idea])

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
      const result = await window.vertragus.inbox.transferToProfile({
        ideaId: idea.id,
        profileId: resolvedProfileId,
        clone,
        yoloMaster
      })
      setLastResult(result.transfer)
      if (result.duplicate) {
        setError(
          result.transfer.status === 'planned'
            ? 'Plan wartet im Review — keine zweite Planung gestartet.'
            : 'Übergabe läuft bereits — keine zweite Planung gestartet.'
        )
        return
      }
      if (result.transfer.status === 'failed') {
        setError(result.transfer.error ?? 'Übergabe fehlgeschlagen.')
        onTransferred(result.idea)
        return
      }
      if (result.workspaceSessionId) {
        await selectWorkspaceSession(resolvedProfileId, result.workspaceSessionId)
      } else {
        await selectProfile(resolvedProfileId)
      }
      onTransferred(result.idea)
      window.location.hash = ''
      showToast(`Idee „${idea.title}" an Workspace übergeben — Planung läuft.`)
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
      const result = await window.vertragus.inbox.transferRetry(idea.id, yoloMaster)
      setLastResult(result.transfer)
      if (result.transfer.status === 'failed') {
        setError(result.transfer.error ?? 'Wiederholung fehlgeschlagen.')
        onTransferred(result.idea)
        return
      }
      if (result.workspaceSessionId) {
        await selectWorkspaceSession(resolvedProfileId, result.workspaceSessionId)
      } else {
        await selectProfile(resolvedProfileId)
      }
      onTransferred(result.idea)
      window.location.hash = ''
      showToast('Übergabe wiederholt — Workspace geöffnet.')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const transfer = lastResult ?? idea.transfer
  const needsClone = transfer?.action === 'needsClone'
  const needsAuth = transfer?.action === 'needsAuth'
  const canRetry = transfer?.status === 'failed' && transfer.retryable !== false
  const blocking = isTransferBlocking(idea.transfer)
  const selectedEligible = eligibleProfiles.some((p) => p.id === resolvedProfileId)
  const noEligibleProfiles = eligibleProfiles.length === 0

  const githubLoginClick = (): void => {
    if (githubAuth?.oauthConfigured) {
      void githubLogin()
    } else {
      void githubTerminalLogin()
    }
  }

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
              {idea.transfer.status === 'planned' &&
                ' — Freigabe im Orchestrator-Panel; erneutes Planen erst nach Ablehnung.'}
            </div>
          )}

          <label className="inbox-field">
            <span>Workspace-Profil</span>
            <select
              value={resolvedProfileId}
              // Submit stays blocked via `blocking`; the target profile must remain choosable.
              disabled={busy || noEligibleProfiles}
              onChange={(e) => setProfileId(e.target.value)}
            >
              {profiles.map((p) => {
                const ok = profileHasOrchestrator(p)
                return (
                  <option key={p.id} value={p.id} disabled={!ok}>
                    {p.name}
                    {!ok ? ' (ohne Orchestrator — deaktiviert)' : ''}
                  </option>
                )
              })}
            </select>
          </label>

          {noEligibleProfiles && (
            <div className="inbox-transfer-hint">
              Kein Profil mit Orchestrator und aktivem Planner-Modus — bitte im Profil-Editor
              konfigurieren.
            </div>
          )}

          <div className="inbox-briefing-preview">
            <button
              type="button"
              className="btn-ghost"
              aria-expanded={briefingPreviewOpen}
              onClick={() => setBriefingPreviewOpen((open) => !open)}
            >
              {briefingPreviewOpen ? 'Briefing-Vorschau ausblenden' : 'Briefing-Vorschau anzeigen'}
            </button>
            {!briefingPreview.ok && (
              <div className="inbox-error" role="alert">
                {briefingPreview.message}
              </div>
            )}
            {briefingPreviewOpen && briefingPreview.ok && (
              <>
                <div className="inbox-transfer-hint">
                  Dieses Briefing wird an den Orchestrator übergeben. Rohmaterial ist als Kontext
                  markiert; die Planungsvorgaben bleiben verbindlich.
                </div>
                {briefingPreview.warnings.length > 0 && (
                  <div className="inbox-transfer-hint">
                    {briefingPreview.warnings.join(' ')}
                  </div>
                )}
                <pre className="inbox-briefing-preview-content">
                  {briefingPreview.briefing}
                </pre>
              </>
            )}
          </div>

          {error && <div className="inbox-error">{error}</div>}

          {needsClone && !needsAuth && (
            <div className="inbox-transfer-hint">
              Repository ist gebunden, aber noch nicht geklont. Klonen startet den vorhandenen
              GitHub-Bindungsflow.
            </div>
          )}

          {needsAuth && (
            <div className="inbox-transfer-hint">
              <div>{transfer?.error ?? 'GitHub-Anmeldung erforderlich.'}</div>
              <button
                type="button"
                className="btn-secondary"
                style={{ marginTop: 8 }}
                disabled={busy}
                onClick={githubLoginClick}
              >
                {githubAuth?.oauthConfigured
                  ? 'GitHub verbinden (Browser)'
                  : 'GitHub im Terminal verbinden'}
              </button>
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
          {needsAuth ? (
            <button type="button" className="btn-primary" disabled={busy} onClick={githubLoginClick}>
              GitHub verbinden
            </button>
          ) : needsClone ? (
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !selectedEligible || !briefingPreview.ok}
              onClick={() => void runTransfer(true)}
            >
              Klonen & übergeben
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              disabled={busy || blocking || !selectedEligible || !briefingPreview.ok}
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
