import { useEffect } from 'react'
import HoundLogo from './HoundLogo'
import { PanelFooter } from './PanelFooter'
import { ProfileRow } from './ProfileRow'
import { WorkspaceCard } from './WorkspaceCard'
import { CloseIcon, MinusIcon } from './icons'
import { trackPanelPointer } from './pointerOver'
import { PANEL_STRINGS } from './strings'
import { usePanelData } from './usePanelData'
import { orderWorkspaces } from './viewModel'
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
  const panel = usePanelData()
  const workspaces = orderWorkspaces(panel.workspaces)

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
        <span className="panel-wordmark">{PANEL_STRINGS.wordmark}</span>
        <span className="panel-brand-spacer" />
        <button
          type="button"
          className="panel-icon-button panel-brand-button"
          title={PANEL_STRINGS.hideAll}
          aria-label={PANEL_STRINGS.hideAll}
          onClick={panel.hideAll}
        >
          <MinusIcon />
        </button>
        <button
          type="button"
          className="panel-icon-button panel-brand-button panel-quit"
          title={PANEL_STRINGS.quit}
          aria-label={PANEL_STRINGS.quit}
          onClick={panel.quitApp}
        >
          <CloseIcon />
        </button>
      </header>
      <div className="panel-divider" />

      <div className="panel-scroll">
        <section className="panel-section">
          <h2 className="panel-label">{PANEL_STRINGS.profilesLabel}</h2>
          {panel.profiles.length === 0 ? (
            <p className="panel-empty">{PANEL_STRINGS.noProfiles}</p>
          ) : (
            <ul className="panel-list">
              {panel.profiles.map((profile) => (
                <ProfileRow
                  key={profile.id}
                  profile={profile}
                  onStart={panel.startWorkspace}
                  onEdit={panel.editProfile}
                />
              ))}
            </ul>
          )}
          <button
            type="button"
            className="panel-new"
            title={PANEL_STRINGS.newProfileTitle}
            onClick={() => panel.editProfile(undefined)}
          >
            {PANEL_STRINGS.newProfile}
          </button>
        </section>

        <section className="panel-section">
          <h2 className="panel-label">{PANEL_STRINGS.workspacesLabel}</h2>
          {workspaces.length === 0 ? (
            <p className="panel-empty">{PANEL_STRINGS.noWorkspaces}</p>
          ) : (
            <div className="panel-cards">
              {workspaces.map((workspace) => (
                <WorkspaceCard
                  key={workspace.workspaceId}
                  workspace={workspace}
                  onStop={panel.stopWorkspace}
                  onFocusAgent={panel.focusAgent}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {panel.bridge ? null : <p className="panel-error">{PANEL_STRINGS.bridgeMissing}</p>}
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
