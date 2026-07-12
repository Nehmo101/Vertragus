import { useEffect, useState } from 'react'
import { useAppStore, activeProfile } from '@renderer/store/useAppStore'
import type { WorkspaceProfile } from '@shared/profile'
import type { UpdateState } from '@shared/ipc'
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
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [branchSwitching, setBranchSwitching] = useState(false)

  const profile = activeProfile(store)
  const running = store.agents.filter((a) => a.status === 'running').length
  const anyRunning = running > 0
  const updateVisible =
    update?.status === 'available' ||
    update?.status === 'downloading' ||
    update?.status === 'downloaded' ||
    (update?.status === 'error' && Boolean(update.availableVersion))
  const updateLabel =
    update?.status === 'downloading'
      ? `Update ${Math.round(update.progress ?? 0)} %`
      : update?.status === 'downloaded'
        ? 'Update installieren'
        : update?.status === 'available'
          ? 'Aktualisierung verfügbar'
          : update?.status === 'error'
            ? 'Update erneut prüfen'
            : 'Self-Update'
  const updateTitle = update?.status === 'downloaded' && anyRunning
    ? 'Vor der Installation bitte alle Agents stoppen.'
    : update?.message ??
      (update?.availableVersion
        ? `Main-Update ${update.availableVersion} ist verfügbar.`
        : 'Neue Version vom Main-Branch installieren.')

  const activeProfileId = store.activeProfileId
  const refreshGit = store.refreshGit
  useEffect(() => {
    if (!window.orca?.updates) return
    const unsubscribe = window.orca.updates.onState(setUpdate)
    void window.orca.updates.state().then(setUpdate)
    return unsubscribe
  }, [])
  useEffect(() => {
    if (!menuOpen && !confirmKill) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        setConfirmKill(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [confirmKill, menuOpen])
  useEffect(() => {
    const refresh = (): void => {
      if (!document.hidden) void refreshGit()
    }
    const interval = setInterval(refresh, 10_000)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', refresh)
    }
  }, [activeProfileId, refreshGit])
  const displayDir = (profile?.workingDir || '')
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]:)?\/(Users|home)\/[^/]+/, '~')

  const remoteLabel = store.gitInfo?.remote?.replace(/(https?:\/\/)[^/@]+@/i, '$1')
  const gitTitle = store.gitInfo?.isRepo
    ? [
        store.gitInfo.branch ? `Branch: ${store.gitInfo.branch}` : undefined,
        store.gitInfo.defaultBranch ? `Standard-Branch: ${store.gitInfo.defaultBranch}` : undefined,
        remoteLabel ? `Remote: ${remoteLabel}` : undefined,
        `Arbeitsbaum: ${store.gitInfo.dirty ? 'ungespeicherte Änderungen' : 'sauber'}`
      ]
        .filter(Boolean)
        .join('\n')
    : undefined

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
          <WhaleLogo size={34} />
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
          {store.gitInfo?.isRepo && (
            <label
              className={`branch-pill branch-picker no-drag ${store.gitInfo.dirty ? 'dirty' : ''}`}
              title={gitTitle}
            >
              <span>Branch:</span>
              <select
                aria-label={'Aktuellen Git-Branch ausw\u00e4hlen'}
                value={store.gitInfo.branch ?? ''}
                disabled={branchSwitching || !store.gitInfo.branches?.length}
                onChange={(event) => {
                  const branch = event.target.value
                  if (!branch || branch === store.gitInfo?.branch) return
                  setBranchSwitching(true)
                  void store.switchGitBranch(branch).finally(() => setBranchSwitching(false))
                }}
              >
                {store.gitInfo.branch && !store.gitInfo.branches?.includes(store.gitInfo.branch) && (
                  <option value={store.gitInfo.branch}>{store.gitInfo.branch}</option>
                )}
                {store.gitInfo.branches?.map((branch) => (
                  <option key={branch} value={branch}>{branch}</option>
                ))}
              </select>
              {branchSwitching && <span className="branch-spinner" aria-hidden="true">{'\u21bb'}</span>}
              {store.gitInfo.dirty && <span className="dirty-mark">● dirty</span>}
            </label>
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

        {updateVisible && (
          <button
            type="button"
            className={`self-update-btn ${update?.status ?? ''}`}
            title={updateTitle}
            aria-live="polite"
            disabled={update?.status === 'downloading' || (update?.status === 'downloaded' && anyRunning)}
            onClick={() => {
              if (update?.status === 'available') void window.orca.updates.download()
              else if (update?.status === 'downloaded') void window.orca.updates.install()
              else void window.orca.updates.check()
            }}
          >
            <span aria-hidden="true">↻</span>
            <span>{updateLabel}</span>
          </button>
        )}

        <button
          type="button"
          className="theme-toggle-btn no-drag"
          onClick={store.toggleTheme}
          title="Erscheinung: Hell / Dunkel umschalten"
          aria-label="Hell/Dunkel umschalten"
        >
          <span className={`theme-toggle-swatch ${store.theme === 'light' ? 'active' : ''}`} aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
            </svg>
          </span>
          <span className={`theme-toggle-swatch ${store.theme === 'dark' ? 'active' : ''}`} aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
            </svg>
          </span>
        </button>

        <button type="button"
          className={`yolo-btn ${store.yoloMaster ? 'on' : ''}`}
          onClick={store.toggleYolo}
          title="Yolo-Master: neue Agents starten ohne Bestätigungen"
        >
          <span className="yolo-track">
            <span className="yolo-knob" />
          </span>
          <span className="label">YOLO</span>
        </button>

        <button type="button" className={`stop-btn ${anyRunning ? '' : 'resume'}`} onClick={onStopClick}>
          {anyRunning ? (
            <svg className="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="12" r="9" /><rect x="9" y="9" width="6" height="6" rx="1.4" />
            </svg>
          ) : (
            <svg className="button-icon" viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 4.5v15l12-7.5z" />
            </svg>
          )}
          <span>{anyRunning ? 'Alle stoppen' : 'Alle starten'}</span>
        </button>

        <div style={{ position: 'relative' }} className="no-drag">
          <button type="button"
            className="profile-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Workspace-Profil wählen"
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
              <div className="profile-menu" role="menu" aria-label="Workspace-Profile">
                <div className="menu-caption">Workspace-Profile</div>
                {store.profiles.map((p) => (
                  <button type="button"
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
                <button type="button"
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
          <button type="button" className="win-btn" title="Minimieren" onClick={() => window.orca.win.minimize()}>
            ─
          </button>
          <button type="button"
            className="win-btn"
            title="Maximieren"
            style={{ fontSize: 11 }}
            onClick={() => window.orca.win.maximizeToggle()}
          >
            ▢
          </button>
          <button type="button" className="win-btn close" title="Schließen" onClick={() => window.orca.win.close()}>
            ✕
          </button>
        </div>
      </header>

      {confirmKill && (
        <>
          <div className="confirm-backdrop" onClick={() => setConfirmKill(false)} />
          <div className="confirm-pop" role="alertdialog" aria-modal="true" aria-labelledby="stop-agents-title">
            <div className="head">
              <span style={{ fontSize: 16 }}>⛔</span>
              <b id="stop-agents-title">Alle Agents stoppen?</b>
            </div>
            <div className="text">
              {running} laufende Agents werden sofort beendet. Nicht committete Änderungen in
              Sandbox-Worktrees gehen verloren.
            </div>
            <div className="actions">
              <button type="button" className="btn-ghost" onClick={() => setConfirmKill(false)}>
                Abbrechen
              </button>
              <button type="button"
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
