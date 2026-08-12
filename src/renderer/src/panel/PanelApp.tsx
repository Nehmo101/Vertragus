import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import HoundLogo from './HoundLogo'
import { PanelFooter } from './PanelFooter'
import { ProfileRow } from './ProfileRow'
import { WorkspaceCard } from './WorkspaceCard'
import { CloseIcon, MinusIcon } from './icons'
import { trackPanelPointer } from './pointerOver'
import { usePanelData } from './usePanelData'
import {
  expandedWorkspaceId,
  nextSelectedWorkspaceId,
  orderWorkspaces,
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
   * Which card the user last chose. `undefined` until the first click so the
   * active workspace stays open by default; see expandedWorkspaceId.
   */
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<SelectedWorkspaceId>(undefined)
  const expandedId = expandedWorkspaceId(workspaces, selectedWorkspaceId)
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
        <button
          type="button"
          className="panel-icon-button panel-brand-button"
          title={t('panel.hideAll')}
          aria-label={t('panel.hideAll')}
          onClick={panel.hideAll}
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
        <section className="panel-section">
          <h2 className="panel-label">{t('panel.profilesLabel')}</h2>
          {panel.profiles.length === 0 ? (
            <p className="panel-empty">{t('panel.noProfiles')}</p>
          ) : (
            <ul className="panel-list">
              {panel.profiles.map((profile) => (
                <ProfileRow
                  key={profile.id}
                  profile={profile}
                  onStart={panel.startWorkspace}
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
          <h2 className="panel-label">{t('panel.workspacesLabel')}</h2>
          {workspaces.length === 0 ? (
            <p className="panel-empty">{t('panel.noWorkspaces')}</p>
          ) : (
            <div className="panel-cards">
              {workspaces.map((workspace) => (
                <WorkspaceCard
                  key={workspace.workspaceId}
                  workspace={workspace}
                  expanded={workspace.workspaceId === expandedId}
                  onToggle={() =>
                    setSelectedWorkspaceId((current) =>
                      nextSelectedWorkspaceId(workspaces, current, workspace.workspaceId)
                    )
                  }
                  onStop={panel.stopWorkspace}
                  onFocusAgent={panel.focusAgent}
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
      />
    </aside>
  )
}
