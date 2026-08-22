import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import HoundLogo from './HoundLogo'
import { OnboardingCard } from './OnboardingCard'
import { shouldShowOnboarding } from './onboardingViewModel'
import { PanelFooter } from './PanelFooter'
import { ProfileRow } from './ProfileRow'
import { WorkspaceCard } from './WorkspaceCard'
import { ChevronIcon, CloseIcon, MinusIcon } from './icons'
import { trackPanelPointer } from './pointerOver'
import { usePanelData } from './usePanelData'
import {
  areAllWorkspacesExpanded,
  filterWorkspaces,
  isWorkspaceExpanded,
  nextExpandAllSelection,
  nextSelectedProfileId,
  nextSelectedWorkspaceId,
  orderWorkspaces,
  resolveSelectedProfileId,
  shouldFocusWorkspaceOnToggle,
  workspaceCountByProfile,
  workspaceIdToFocusForProfile,
  type SelectedWorkspaceId
} from './viewModel'
import './panel.css'

/**
 * The panel — Vertragus' primary surface.
 *
 * Three bands under one glass sheet: the brand, what you can start (profiles),
 * and what is running (workspaces with their agents). The head carries the two
 * app-wide window actions (hide everything, quit), the footer the two switches.
 * Everything else the app can do lives in a window this panel opens.
 */
export function PanelApp(): React.JSX.Element {
  const { t } = useTranslation()
  const panel = usePanelData()
  const workspaces = orderWorkspaces(panel.workspaces)
  /**
   * Profile filter for the workspace list below. `null` shows every workspace;
   * a still-listed id narrows the cards. Cleared automatically when the
   * profile disappears so the filter cannot stick on a missing row.
   */
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null)
  const activeProfileId = resolveSelectedProfileId(panel.profiles, selectedProfileId)
  const visibleWorkspaces = filterWorkspaces(workspaces, activeProfileId)
  const countsByProfile = workspaceCountByProfile(workspaces)
  /**
   * Which card the user last chose. `undefined` until the first click so the
   * active workspace stays open by default; see expandedWorkspaceId.
   */
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<SelectedWorkspaceId>(undefined)
  const allExpanded = areAllWorkspacesExpanded(selectedWorkspaceId)
  const expandAllLabel = allExpanded
    ? t('panel.collapseAllWorkspaces')
    : t('panel.expandAllWorkspaces')
  /** Profile whose worktree-cleanup list is unfolded; at most one at a time. */
  const [cleanupProfileId, setCleanupProfileId] = useState<string | null>(null)
  /** Profile whose retro view is unfolded; same one-at-a-time rule. */
  const [retroProfileId, setRetroProfileId] = useState<string | null>(null)

  /**
   * Hover, measured in the main process. The whole panel is a drag region, and
   * Windows hands those to the compositor — CSS `:hover` therefore only fires
   * over the buttons. See pointerOver.ts / main/windows/panelHover.ts.
   */
  useEffect(() => {
    if (!panel.bridge) return
    return trackPanelPointer(document.documentElement.classList, panel.bridge)
  }, [panel.bridge])

  return (
    <aside className="panel glass">
      <header className="panel-brand">
        <HoundLogo size={30} />
        <span className="panel-wordmark">{t('panel.wordmark')}</span>
        <span className="panel-brand-spacer" />
        {/*
          − minimizes the PANEL, ✕ quits: the two things a window's head is
          expected to do. Hide-all is a different verb — it clears the agents
          and deliberately leaves this strip standing — and keeps its own eye
          in the footer.
        */}
        <button
          type="button"
          className="panel-icon-button panel-brand-button"
          title={t('panel.minimize')}
          aria-label={t('panel.minimize')}
          onClick={panel.minimizePanel}
        >
          <MinusIcon />
        </button>
        <button
          type="button"
          className="panel-icon-button panel-brand-button panel-quit"
          title={t('panel.quit')}
          aria-label={t('panel.quit')}
          onClick={panel.quitApp}
        >
          <CloseIcon />
        </button>
      </header>
      <div className="panel-divider" />

      <div className="panel-scroll">
        {/*
          WP-7: the first-run card. Mounted only while there is no profile, so
          its two shell-outs (provider health, login status) run when somebody
          is actually looking at them and never on a panel render.
        */}
        {panel.bridge &&
        shouldShowOnboarding(
          panel.profiles,
          panel.settings?.onboardingDismissed ?? false,
          panel.profilesLoaded && panel.settings !== null
        ) ? (
          <OnboardingCard
            bridge={panel.bridge}
            onNewProfile={(providerId) => panel.editProfile(undefined, providerId)}
            onDismiss={panel.dismissOnboarding}
          />
        ) : null}

        <section className="panel-section">
          <h2 className="panel-label">
            {t('panel.profilesLabel')}
            <span className="panel-label-count" title={t('panel.workspaceTotal', { count: workspaces.length })}>
              {workspaces.length}
            </span>
          </h2>
          {panel.profiles.length === 0 ? (
            <p className="panel-empty">{t('panel.noProfiles')}</p>
          ) : (
            <ul className="panel-list">
              {panel.profiles.map((profile) => (
                <ProfileRow
                  key={profile.id}
                  profile={profile}
                  count={countsByProfile.get(profile.id) ?? 0}
                  selected={profile.id === activeProfileId}
                  onSelect={(profileId) => {
                    const next = nextSelectedProfileId(activeProfileId, profileId)
                    setSelectedProfileId(next)
                    if (next === null) return
                    const workspaceId = workspaceIdToFocusForProfile(workspaces, next)
                    if (workspaceId) panel.focusWorkspace(workspaceId)
                  }}
                  onStart={panel.startWorkspace}
                  onResume={panel.resumeWorkspace}
                  onEdit={panel.editProfile}
                  cleanupOpen={cleanupProfileId === profile.id}
                  onToggleCleanup={(profileId) =>
                    setCleanupProfileId((current) => (current === profileId ? null : profileId))
                  }
                  retroOpen={retroProfileId === profile.id}
                  onToggleRetro={(profileId) =>
                    setRetroProfileId((current) => (current === profileId ? null : profileId))
                  }
                  bridge={panel.bridge}
                />
              ))}
            </ul>
          )}
          <button
            type="button"
            className="panel-new"
            title={t('panel.newProfileTitle')}
            onClick={() => panel.editProfile(undefined)}
          >
            {t('panel.newProfile')}
          </button>
        </section>

        <section className="panel-section">
          <h2 className="panel-label">
            {t('panel.workspacesLabel')}
            {visibleWorkspaces.length === 0 ? null : (
              <button
                type="button"
                className="panel-label-chevron"
                title={expandAllLabel}
                aria-label={expandAllLabel}
                aria-expanded={allExpanded}
                onClick={() => setSelectedWorkspaceId((current) => nextExpandAllSelection(current))}
              >
                <ChevronIcon expanded={allExpanded} />
              </button>
            )}
          </h2>
          {visibleWorkspaces.length === 0 ? (
            <p className="panel-empty">{t('panel.noWorkspaces')}</p>
          ) : (
            <div className="panel-cards">
              {visibleWorkspaces.map((workspace) => (
                <WorkspaceCard
                  key={workspace.workspaceId}
                  workspace={workspace}
                  expanded={isWorkspaceExpanded(
                    visibleWorkspaces,
                    selectedWorkspaceId,
                    workspace.workspaceId
                  )}
                  onToggle={() => {
                    const next = nextSelectedWorkspaceId(
                      visibleWorkspaces,
                      selectedWorkspaceId,
                      workspace.workspaceId
                    )
                    setSelectedWorkspaceId(next)
                    if (shouldFocusWorkspaceOnToggle(next, workspace)) {
                      panel.focusWorkspace(workspace.workspaceId)
                    }
                  }}
                  onStop={panel.stopWorkspace}
                  onSucceedOrchestrator={panel.succeedOrchestrator}
                  onFocusAgent={panel.focusAgent}
                  onCloseAgentWindow={panel.closeAgentWindow}
                  onAssignGoal={panel.assignGoal}
                  onAnswerQuestion={panel.answerQuestion}
                  onUserMessage={panel.sendUserMessage}
                  onPromoteAgent={panel.promoteAgent}
                  onOpenRunFolder={panel.openRunFolder}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {panel.bridge ? null : <p className="panel-error">{t('common.bridgeMissing')}</p>}
      {panel.error ? (
        <button type="button" className="panel-error is-clickable" onClick={panel.dismissError}>
          {panel.error}
        </button>
      ) : null}
      <PanelFooter
        yolo={panel.settings?.yoloMaster ?? false}
        onToggleYolo={panel.toggleYolo}
        onHideAll={panel.hideAll}
        onSettings={panel.openSettings}
        hotkeyError={panel.settings?.hideAllHotkeyError}
        updateReady={panel.update?.status === 'downloaded'}
        updateVersion={panel.update?.availableVersion}
        onInstallUpdate={panel.installUpdate}
        bridge={panel.bridge}
        voiceEnabled={panel.settings?.voiceEnabled ?? false}
        voiceWakePhrase={panel.settings?.voiceWakePhrase ?? 'Hey Vertragus'}
        onToggleVoice={panel.toggleVoice}
      />
    </aside>
  )
}
