import HoundLogo from './HoundLogo'
import { PanelFooter } from './PanelFooter'
import { ProfileRow } from './ProfileRow'
import { WorkspaceCard } from './WorkspaceCard'
import { PANEL_STRINGS } from './strings'
import { usePanelData } from './usePanelData'
import { orderWorkspaces } from './viewModel'
import './panel.css'

/**
 * The panel — Vertragus' primary surface.
 *
 * Three bands under one glass sheet: the brand, what you can start (profiles),
 * and what is running (workspaces with their agents). The footer holds the two
 * app-wide switches. Everything else the app can do lives in a window this
 * panel opens.
 */
export function PanelApp(): React.JSX.Element {
  const panel = usePanelData()
  const workspaces = orderWorkspaces(panel.workspaces)

  return (
    <aside className="panel glass">
      <header className="panel-brand">
        <HoundLogo size={30} />
        <span className="panel-wordmark">{PANEL_STRINGS.wordmark}</span>
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
      />
    </aside>
  )
}
