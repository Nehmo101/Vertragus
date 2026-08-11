import HoundLogo from './HoundLogo'
import './panel.css'

/**
 * M0 skeleton of the panel: brand header + empty states. The live profile
 * list, workspace cards and footer controls land in M3 — the glass look and
 * hover reveal are already real so the core visual concept is verifiable
 * from the first boot.
 */
export function PanelApp(): React.JSX.Element {
  return (
    <aside className="panel glass">
      <header className="panel-brand">
        <HoundLogo size={30} />
        <span className="panel-wordmark">VERTRAGVS</span>
      </header>
      <div className="panel-divider" />
      <section className="panel-section">
        <h2 className="panel-label">Profile</h2>
        <p className="panel-empty">Noch keine Profile — kommt in M3.</p>
      </section>
      <section className="panel-section">
        <h2 className="panel-label">Laufende Workspaces</h2>
        <p className="panel-empty">Keine aktiven Workspaces.</p>
      </section>
    </aside>
  )
}
