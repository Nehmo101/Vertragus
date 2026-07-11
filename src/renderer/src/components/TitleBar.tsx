import { useEffect, useState } from 'react'
import { useAppStore, activeProfile } from '@renderer/store/useAppStore'
import type { WorkspaceProfile } from '@shared/profile'
import WhaleLogo from '@renderer/components/WhaleLogo'

function useClock(): string {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return now.toTimeString().slice(0, 8)
}

function profileSummary(p: WorkspaceProfile): string {
  const parts: string[] = []
  if (p.orchestrator) parts.push(`${p.orchestrator.provider}/${p.orchestrator.model}`)
  for (const slot of p.agents) parts.push(`${slot.count}× ${slot.model}`)
  return parts.join(' · ') || 'leer'
}

function profileAgentCount(p: WorkspaceProfile): number {
  return (p.orchestrator ? 1 : 0) + p.agents.reduce((n, s) => n + s.count, 0)
}

export default function TitleBar(): JSX.Element {
  const store = useAppStore()
  const clock = useClock()
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmKill, setConfirmKill] = useState(false)

  const profile = activeProfile(store)
  const running = store.agents.filter((a) => a.status === 'running').length
  const anyRunning = running > 0

  const displayDir = (profile?.workingDir || '')
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]:)?\/(Users|home)\/[^/]+/, '~')

  const onStopClick = (): void => {
    if (anyRunning) {
      setConfirmKill((v) => !v)
      setMenuOpen(false)
    } else {
      void store.startAll()
    }
  }

  return (
    <>
      <header className="titlebar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <WhaleLogo size={30} />
          <div style={{ lineHeight: 1.05 }}>
            <div className="wordmark">
              Orca<span className="dash">-</span>Strator
            </div>
            <div className="wordmark-sub">Agent Control Center</div>
          </div>
        </div>

        <div className="tb-divider" />
        <div className="repo-path">
          <span className="path" title={profile?.workingDir || undefined}>
            {profile?.workingDir ? displayDir : 'kein Arbeitsverzeichnis'}
          </span>
          {store.gitInfo?.isRepo && store.gitInfo.branch && (
            <span className="branch-pill">{store.gitInfo.branch}</span>
          )}
        </div>

        <div className="spacer" />

        <div className="live-counter no-drag">
          <span className="pulse-dot" />
          <span>
            <b>{running}</b> aktiv
          </span>
          <span className="sep">·</span>
          <span className="clock">{clock}</span>
        </div>

        <button
          className={`yolo-btn ${store.yoloMaster ? 'on' : ''}`}
          onClick={store.toggleYolo}
          title="Yolo-Master: neue Agents starten ohne Bestätigungen"
        >
          <span className="yolo-track">
            <span className="yolo-knob" />
          </span>
          <span className="label">YOLO</span>
        </button>

        <button className={`stop-btn ${anyRunning ? '' : 'resume'}`} onClick={onStopClick}>
          <span style={{ fontSize: 13, lineHeight: 1 }}>{anyRunning ? '⛔' : '▶'}</span>
          <span>{anyRunning ? 'Alle stoppen' : 'Alle starten'}</span>
        </button>

        <div style={{ position: 'relative' }} className="no-drag">
          <button
            className="profile-btn"
            onClick={() => {
              setMenuOpen((v) => !v)
              setConfirmKill(false)
            }}
          >
            <span className="profile-avatar">
              {(profile?.name ?? 'OS').slice(0, 2).toUpperCase()}
            </span>
            <span className="name">{profile?.name ?? '—'}</span>
            <span className="caret">▾</span>
          </button>
          {menuOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="profile-menu">
                <div className="menu-caption">Workspace-Profile</div>
                {store.profiles.map((p) => (
                  <button
                    key={p.id}
                    className="menu-item"
                    onClick={() => {
                      void store.selectProfile(p.id)
                      setMenuOpen(false)
                    }}
                  >
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                      <span className="title">{p.name}</span>
                      <span className="sub">{profileSummary(p)}</span>
                    </span>
                    <span
                      className="check"
                      style={{ opacity: p.id === store.activeProfileId ? 1 : 0 }}
                    >
                      ✓
                    </span>
                  </button>
                ))}
                <div className="menu-sep" />
                <button
                  className="menu-action"
                  onClick={() => {
                    setMenuOpen(false)
                    if (profile) store.openEditor(profile)
                  }}
                >
                  <span style={{ fontSize: 13 }}>⚙</span> Profil-Editor öffnen…
                </button>
              </div>
            </>
          )}
        </div>

        <div className="tb-divider" />
        <div className="win-controls no-drag">
          <button className="win-btn" title="Minimieren" onClick={() => window.orca.win.minimize()}>
            ─
          </button>
          <button
            className="win-btn"
            title="Maximieren"
            style={{ fontSize: 11 }}
            onClick={() => window.orca.win.maximizeToggle()}
          >
            ▢
          </button>
          <button className="win-btn close" title="Schließen" onClick={() => window.orca.win.close()}>
            ✕
          </button>
        </div>
      </header>

      {confirmKill && (
        <>
          <div className="confirm-backdrop" onClick={() => setConfirmKill(false)} />
          <div className="confirm-pop">
            <div className="head">
              <span style={{ fontSize: 16 }}>⛔</span>
              <b>Alle Agents stoppen?</b>
            </div>
            <div className="text">
              {running} laufende Agents werden sofort beendet. Nicht committete Änderungen in
              Sandbox-Worktrees gehen verloren.
            </div>
            <div className="actions">
              <button className="btn-ghost" onClick={() => setConfirmKill(false)}>
                Abbrechen
              </button>
              <button
                className="btn-danger"
                onClick={() => {
                  setConfirmKill(false)
                  void store.stopAll()
                }}
              >
                Alle stoppen
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}

export { profileSummary, profileAgentCount }
