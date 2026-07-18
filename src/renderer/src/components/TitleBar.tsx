import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { setAppLanguage, type ResolvedLanguage } from '@renderer/i18n'
import { useAppStore, effectiveRepoRef, knownRepos } from '@renderer/store/useAppStore'
import type { WorkspaceProfile } from '@shared/profile'
import { resolveModel } from '@shared/models'
import { repoRefKey, repoRefLabel } from '@shared/repoSwitcher'
import type { UpdateState } from '@shared/ipc'
import type { RemoteStatus } from '@shared/remote'
import HoundLogo from '@renderer/components/HoundLogo'
import GitWorkspaceTree from '@renderer/components/GitWorkspaceTree'
import styles from './responsiveGuards.module.css'

/** Collapse the user's home directory to `~` for a compact repo-path display. */
function compactHome(value: string): string {
  return value.replace(/\\/g, '/').replace(/^([A-Za-z]:)?\/(Users|home)\/[^/]+/, '~')
}

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
  if (p.orchestrator) {
    parts.push(
      `${p.orchestrator.provider}/${resolveModel(p.orchestrator.provider, p.orchestrator) || 'CLI-Standard'}`
    )
  }
  for (const slot of p.agents) {
    parts.push(`${slot.count}× ${slot.provider}/${resolveModel(slot.provider, slot) || 'CLI-Standard'}`)
  }
  return parts.join(' · ') || 'leer'
}

function profileAgentCount(p: WorkspaceProfile): number {
  return (p.orchestrator ? 1 : 0) + p.agents.reduce((n, s) => n + s.count, 0)
}

export default function TitleBar(): JSX.Element {
  const store = useAppStore()
  const { t, i18n } = useTranslation()
  const activeLanguage: ResolvedLanguage = i18n.language.startsWith('de') ? 'de' : 'en'
  const clock = useClock()
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmKill, setConfirmKill] = useState(false)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [branchSwitching, setBranchSwitching] = useState(false)
  const [remote, setRemote] = useState<RemoteStatus | null>(null)

  const repoRef = effectiveRepoRef(store)
  const repoPath = repoRef?.path.trim() ?? ''
  const repoLabel = repoRef ? repoRefLabel(repoRef) : 'Kein Repo'
  const repos = knownRepos(store)
  const activeRepoKey = repoPath ? repoRefKey(repoPath) : ''
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
    if (!window.vertragus?.updates) return
    const unsubscribe = window.vertragus.updates.onState(setUpdate)
    void window.vertragus.updates.state().then(setUpdate)
    return unsubscribe
  }, [])
  useEffect(() => {
    if (!window.vertragus?.remote) return
    const unsubscribe = window.vertragus.remote.onStatus(setRemote)
    void window.vertragus.remote.status().then(setRemote)
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
      <header className={`titlebar ${styles.titlebar}`}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <HoundLogo size={34} />
          <div style={{ lineHeight: 1.05 }}>
            <div className="wordmark">
              VERTRAG<span className="dash">V</span>S
            </div>
            <div className="wordmark-sub">
              <span className="wordmark-sub-label">Agent Orchestration</span>
              {store.appInfo?.version && (
                <>
                  <span className="wordmark-sub-separator" aria-hidden="true">{'\u00b7'}</span>
                  <span
                    className="wordmark-version"
                    title={t('titlebar.versionTitle', { version: store.appInfo.version })}
                  >
                    v{store.appInfo.version}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="tb-divider" />
        <div className="repo-path">
          <span className="path" title={repoPath || undefined}>
            {repoPath ? compactHome(repoPath) : 'kein Arbeitsverzeichnis'}
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
          <GitWorkspaceTree
            repoBound={Boolean(repoPath)}
            repoLabel={repoLabel}
            gitInfo={store.gitInfo}
            githubAuth={store.githubAuth}
          />
        </div>

        <div className="spacer" />

        <div className="lang-switch no-drag" role="group" aria-label={t('titlebar.languageGroup')}>
          {(['de', 'en'] as const).map((language) => (
            <button
              key={language}
              type="button"
              className={`lang-btn ${activeLanguage === language ? 'active' : ''}`}
              aria-pressed={activeLanguage === language}
              onClick={() => void setAppLanguage(language)}
            >
              {language.toUpperCase()}
            </button>
          ))}
        </div>

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
              if (update?.status === 'available') void window.vertragus.updates.download()
              else if (update?.status === 'downloaded') void window.vertragus.updates.install()
              else void window.vertragus.updates.check()
            }}
          >
            <span aria-hidden="true">↻</span>
            <span>{updateLabel}</span>
          </button>
        )}

        <button
          type="button"
          className={`remote-title-badge no-drag ${remote?.enabled ? 'active' : ''}`}
          title={remote?.enabled ? `Mission Control: ${remote.tunnel}` : 'Mission Control einrichten'}
          onClick={() => { window.location.hash = '#/remote' }}
        >
          <span className="pulse-dot" />
          Remote {remote?.enabled ? 'aktiv' : 'aus'}
        </button>

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

        <button
          type="button"
          className={`readable-btn no-drag ${store.cliReadable ? 'on' : ''}`}
          onClick={store.toggleCliReadable}
          title="Globale Voreinstellung: CLI-Fenster zeigen eine lesbare Zusammenfassung dessen, was der Agent gerade macht, statt der Rohausgabe. Pro Fenster unten übersteuerbar."
          aria-pressed={store.cliReadable}
        >
          <span className="readable-check" aria-hidden="true">✓</span>
          <span className="label">Lesbar</span>
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
            className="repo-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Repository wechseln"
            title={repoPath || 'Kein Repository ausgewählt'}
            onClick={() => {
              setMenuOpen((v) => !v)
              setConfirmKill(false)
            }}
          >
            <span className="repo-btn-icon" aria-hidden="true">⑂</span>
            <span className="name">{repoLabel}</span>
            <span className="caret">▾</span>
          </button>
          {menuOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="profile-menu repo-menu" role="menu" aria-label="Repository wechseln">
                <div className="menu-caption">Repository wechseln</div>
                {repos.length === 0 && (
                  <div className="repo-menu-empty">
                    Noch kein Repository. Wähle unten einen Ordner.
                  </div>
                )}
                {repos.map((repo) => {
                  const active = repoRefKey(repo.path) === activeRepoKey
                  return (
                    <button type="button"
                      key={repoRefKey(repo.path)}
                      className="menu-item"
                      title={repo.path}
                      onClick={() => {
                        void store.selectRepo(repo)
                        setMenuOpen(false)
                      }}
                    >
                      <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                        <span className="title">{repoRefLabel(repo)}</span>
                        <span className="sub">{compactHome(repo.path)}</span>
                      </span>
                      <span className="check" style={{ opacity: active ? 1 : 0 }}>
                        ✓
                      </span>
                    </button>
                  )
                })}
                <div className="menu-sep" />
                <button type="button"
                  className="menu-action"
                  onClick={() => {
                    setMenuOpen(false)
                    void store.addRepoFromFolder()
                  }}
                >
                  <span style={{ fontSize: 13 }}>＋</span> Ordner wählen…
                </button>
                {store.activeRepo && (
                  <button type="button"
                    className="menu-action"
                    onClick={() => {
                      setMenuOpen(false)
                      void store.selectRepo(null)
                    }}
                  >
                    <span style={{ fontSize: 13 }}>↩</span> Dem aktiven Profil folgen
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        <div className="tb-divider" />
        <div className="win-controls no-drag">
          <button type="button" className="win-btn" title="Minimieren" onClick={() => window.vertragus.win.minimize()}>
            ─
          </button>
          <button type="button"
            className="win-btn"
            title="Maximieren"
            style={{ fontSize: 11 }}
            onClick={() => window.vertragus.win.maximizeToggle()}
          >
            ▢
          </button>
          <button type="button" className="win-btn close" title="Schließen" onClick={() => window.vertragus.win.close()}>
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
