import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@renderer/store/useAppStore'
import Modal from '@renderer/components/ui/Modal'
import type { Idea } from '@shared/inbox'
import {
  assessProfileOrchestrator,
  isTransferBlocking,
  previewIdeaTransferBriefing
} from '@shared/inboxTransfer'
import type { WorkspaceProfile } from '@shared/profile'

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
  const { t } = useTranslation()
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
            ? t('ideaTransfer.dupPlanned')
            : t('ideaTransfer.dupRunning')
        )
        return
      }
      if (result.transfer.status === 'failed') {
        setError(result.transfer.error ?? t('ideaTransfer.transferFailed'))
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
      showToast(t('ideaTransfer.toastTransferred', { title: idea.title }))
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
        setError(result.transfer.error ?? t('ideaTransfer.retryFailed'))
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
      showToast(t('ideaTransfer.toastRetried'))
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
    <Modal
      className="idea-transfer-modal"
      labelledBy="idea-transfer-title"
      onClose={onClose}
      closeOnScrim={!busy}
      closeOnEscape={!busy}
    >
        <div className="modal-head">
          <span className="modal-gear">➜</span>
          <div style={{ flex: 1 }}>
            <div className="modal-title" id="idea-transfer-title">{t('ideaTransfer.title')}</div>
            <div className="modal-sub">{t('ideaTransfer.sub', { title: idea.title })}</div>
          </div>
          <button type="button" className="modal-close" aria-label={t('ideaTransfer.closeAria')} onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          {idea.transfer && (
            <div className={`inbox-transfer-status status-${idea.transfer.status}`}>
              {t('ideaTransfer.statusLine', {
                status: t(`ideaTransfer.statusLabel.${idea.transfer.status}`, {
                  defaultValue: idea.transfer.status
                })
              })}
              {idea.transfer.planId && t('ideaTransfer.planSuffix', { planId: idea.transfer.planId })}
              {idea.transfer.status === 'planned' && t('ideaTransfer.plannedHint')}
            </div>
          )}

          <label className="inbox-field">
            <span>{t('ideaTransfer.profileLabel')}</span>
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
                    {!ok ? t('ideaTransfer.profileDisabled') : ''}
                  </option>
                )
              })}
            </select>
          </label>

          {noEligibleProfiles && (
            <div className="inbox-transfer-hint">{t('ideaTransfer.noEligible')}</div>
          )}

          <div className="inbox-briefing-preview">
            <button
              type="button"
              className="btn-ghost"
              aria-expanded={briefingPreviewOpen}
              onClick={() => setBriefingPreviewOpen((open) => !open)}
            >
              {briefingPreviewOpen ? t('ideaTransfer.briefingHide') : t('ideaTransfer.briefingShow')}
            </button>
            {!briefingPreview.ok && (
              <div className="inbox-error" role="alert">
                {briefingPreview.message}
              </div>
            )}
            {briefingPreviewOpen && briefingPreview.ok && (
              <>
                <div className="inbox-transfer-hint">{t('ideaTransfer.briefingHint')}</div>
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
            <div className="inbox-transfer-hint">{t('ideaTransfer.needsCloneHint')}</div>
          )}

          {needsAuth && (
            <div className="inbox-transfer-hint">
              <div>{transfer?.error ?? t('ideaTransfer.needsAuth')}</div>
              <button
                type="button"
                className="btn-secondary"
                style={{ marginTop: 8 }}
                disabled={busy}
                onClick={githubLoginClick}
              >
                {githubAuth?.oauthConfigured
                  ? t('ideaTransfer.githubBrowser')
                  : t('ideaTransfer.githubTerminal')}
              </button>
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>
            {t('ideaTransfer.cancel')}
          </button>
          {canRetry && (
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void retry()}>
              {t('ideaTransfer.retry')}
            </button>
          )}
          {needsAuth ? (
            <button type="button" className="btn-primary" disabled={busy} onClick={githubLoginClick}>
              {t('ideaTransfer.githubConnect')}
            </button>
          ) : needsClone ? (
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !selectedEligible || !briefingPreview.ok}
              onClick={() => void runTransfer(true)}
            >
              {t('ideaTransfer.cloneTransfer')}
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              disabled={busy || blocking || !selectedEligible || !briefingPreview.ok}
              onClick={() => void runTransfer()}
            >
              {busy ? t('ideaTransfer.transferring') : t('ideaTransfer.transferPlan')}
            </button>
          )}
        </div>
    </Modal>
  )
}
