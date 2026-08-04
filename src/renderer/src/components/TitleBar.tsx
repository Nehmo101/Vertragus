import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
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
import { useEscapeToClose } from '@renderer/components/ui/useEscapeToClose'
import { buildOverflowMenuItems, type OverflowItemId } from './titleBarOverflow'
import styles from './responsiveGuards.module.css'
import tb from './TitleBar.module.css'

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

/** Minimal translate signature so i18next's `t` can be passed straight through. */
type SummaryTranslate = (key: string) => string

function profileSummary(p: WorkspaceProfile, t: SummaryTranslate): string {
  const cliDefault = t('titlebar.cliDefault')
  const parts: string[] = []
  if (p.orchestrator) {
    parts.push(
      `${p.orchestrator.provider}/${resolveModel(p.orchestrator.provider, p.orchestrator) || cliDefault}`
    )
  }
  for (const slot of p.agents) {
    parts.push(`${slot.count}× ${slot.provider}/${resolveModel(slot.provider, slot) || cliDefault}`)
  }
  return parts.join(' · ') || t('titlebar.profileSummaryEmpty')
}

function profileAgentCount(p: WorkspaceProfile): number {
  return (p.orchestrator ? 1 : 0) + p.agents.reduce((n, s) => n + s.count, 0)
}

export default function TitleBar(): JSX.Element {
  // Select only the fields TitleBar reads (deriving the running-agent count so
  // usage-only ticks that don't change the count don't re-render the bar). The
  // repo fields feed effectiveRepoRef/knownRepos, which take a RepoState slice.
  const store = useAppStore(
    useShallow((s) => ({
      profiles: s.profiles,
      activeProfileId: s.activeProfileId,
      activeRepo: s.activeRepo,
      recentRepos: s.recentRepos,
      appInfo: s.appInfo,
      cliReadable: s.cliReadable,
      gitInfo: s.gitInfo,
      githubAuth: s.githubAuth,
      theme: s.theme,
      uiDensity: s.uiDensity,
      startMode: s.startMode,
      cycleStartMode: s.cycleStartMode,
      yoloMaster: s.yoloMaster,
      running: s.agents.filter((a) => a.status === 'running').length,
      stopAllRequestId: s.stopAllRequestId,
      addRepoFromFolder: s.addRepoFromFolder,
      refreshGit: s.refreshGit,
      selectRepo: s.selectRepo,
      setUiDensity: s.setUiDensity,
      startAll: s.startAll,
      stopAll: s.stopAll,
      switchGitBranch: s.switchGitBranch,
      toggleCliReadable: s.toggleCliReadable,
      toggleTheme: s.toggleTheme,
      toggleYolo: s.toggleYolo
    }))
  )
  const { t, i18n } = useTranslation()
  const activeLanguage: ResolvedLanguage = i18n.language.startsWith('de') ? 'de' : 'en'
  const clock = useClock()
  const [menuOpen, setMenuOpen] = useState(false)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [confirmKill, setConfirmKill] = useState(false)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [branchSwitching, setBranchSwitching] = useState(false)
  const [remote, setRemote] = useState<RemoteStatus | null>(null)
  const overflowBtnRef = useRef<HTMLButtonElement>(null)
  const overflowMenuRef = useRef<HTMLDivElement>(null)

  const repoRef = effectiveRepoRef(store)
  const repoPath = repoRef?.path.trim() ?? ''
  const repoLabel = repoRef ? repoRefLabel(repoRef) : t('titlebar.noRepo')
  const repos = knownRepos(store)
  const activeRepoKey = repoPath ? repoRefKey(repoPath) : ''
  const running = store.running
  const anyRunning = running > 0
  const updateVisible =
    update?.status === 'available' ||
    update?.status === 'downloading' ||
    update?.status === 'downloaded' ||
    (update?.status === 'error' && Boolean(update.availableVersion))
  const updateLabel =
    update?.status === 'downloading'
      ? t('titlebar.update.downloading', { percent: Math.round(update.progress ?? 0) })
      : update?.status === 'downloaded'
        ? t('titlebar.update.install')
        : update?.status === 'available'
          ? t('titlebar.update.available')
          : update?.status === 'error'
            ? t('titlebar.update.retry')
            : t('titlebar.update.self')
  const updateTitle = update?.status === 'downloaded' && anyRunning
    ? t('titlebar.update.stopAgentsFirst')
    : update?.message ??
      (update?.availableVersion
        ? t('titlebar.update.mainAvailable', { version: update.availableVersion })
        : t('titlebar.update.installMain'))

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

  // Overflow menu: Escape closes and returns focus to the ⋯ button (pattern
  // from components/ui/Modal.tsx); an outside click closes via the backdrop.
  const closeOverflow = (): void => {
    setOverflowOpen(false)
    overflowBtnRef.current?.focus()
  }
  useEscapeToClose(closeOverflow, { enabled: overflowOpen })
  useEffect(() => {
    if (!overflowOpen) return
    overflowMenuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
  }, [overflowOpen])
  const onOverflowMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const menu = overflowMenuRef.current
    if (!menu) return
    const items = Array.from(
      menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])')
    )
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement as HTMLElement)
    let next: number
    if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % items.length
    else if (event.key === 'ArrowUp')
      next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else return
    event.preventDefault()
    items[next].focus()
  }

  // Stop-all via shortcut (Mod+Shift+.): requestStopAll() in the agentsSlice
  // bumps the request id; the existing confirm dialog then opens here — the
  // shortcut therefore NEVER stops directly.
  useEffect(() => {
    return useAppStore.subscribe((state, prev) => {
      if (state.stopAllRequestId === prev.stopAllRequestId) return
      // Without running agents there is nothing to confirm (same as the button).
      if (!state.agents.some((a) => a.status === 'running')) return
      setMenuOpen(false)
      setOverflowOpen(false)
      setConfirmKill(true)
    })
  }, [])

  const remoteLabel = store.gitInfo?.remote?.replace(/(https?:\/\/)[^/@]+@/i, '$1')
  const gitTitle = store.gitInfo?.isRepo
    ? [
        store.gitInfo.branch ? t('titlebar.git.branch', { branch: store.gitInfo.branch }) : undefined,
        store.gitInfo.defaultBranch
          ? t('titlebar.git.defaultBranch', { branch: store.gitInfo.defaultBranch })
          : undefined,
        remoteLabel ? t('titlebar.git.remote', { remote: remoteLabel }) : undefined,
        store.gitInfo.dirty ? t('titlebar.git.treeDirty') : t('titlebar.git.treeClean')
      ]
        .filter(Boolean)
        .join('\n')
    : undefined

  const onStopClick = (): void => {
    if (anyRunning) {
      setConfirmKill((v) => !v)
      setMenuOpen(false)
      setOverflowOpen(false)
    } else {
      void store.startAll()
    }
  }

  // Rarely used toggles live in the overflow menu; the item list is pure logic
  // (titleBarOverflow.ts), only the ids are mapped to actions here.
  const overflowItems = buildOverflowMenuItems(
    {
      language: activeLanguage,
      theme: store.theme,
      cliReadable: store.cliReadable,
      uiDensity: store.uiDensity,
      updateVisible,
      updateLabel,
      updateDisabled:
        update?.status === 'downloading' || (update?.status === 'downloaded' && anyRunning),
      updateChannel: update?.channel && update.status !== 'unsupported' ? update.channel : null,
      startMode: store.startMode
    },
    t
  )
  const onOverflowItem = (id: OverflowItemId): void => {
    switch (id) {
      case 'language':
        void setAppLanguage(activeLanguage === 'de' ? 'en' : 'de')
        break
      case 'theme':
        store.toggleTheme()
        break
      case 'readable':
        store.toggleCliReadable()
        break
      case 'density':
        store.setUiDensity(store.uiDensity === 'compact' ? 'comfortable' : 'compact')
        break
      case 'startMode':
        store.cycleStartMode()
        break
      case 'showRail':
        closeOverflow()
        void window.vertragus.rail.toggle()
        break
      case 'update':
        closeOverflow()
        if (update?.status === 'available') void window.vertragus.updates.download()
        else if (update?.status === 'downloaded') void window.vertragus.updates.install()
        else void window.vertragus.updates.check()
        break
      case 'updateChannel':
        void window.vertragus.updates
          .setChannel(update?.channel === 'stable' ? 'main' : 'stable')
          .then(setUpdate)
        break
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
            {repoPath ? compactHome(repoPath) : t('titlebar.noWorkingDir')}
          </span>
          {store.gitInfo?.isRepo && (
            <label
              className={`branch-pill branch-picker no-drag ${store.gitInfo.dirty ? 'dirty' : ''}`}
              title={gitTitle}
            >
              <span>{t('titlebar.branchLabel')}</span>
              <select
                aria-label={t('titlebar.branchPickAria')}
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

        <div className="live-counter no-drag">
          <span className="pulse-dot" />
          <span>
            <b>{running}</b> {t('titlebar.activeCount')}
          </span>
          <span className="sep">·</span>
          <span className="clock">{clock}</span>
        </div>

        <button
          type="button"
          className={`remote-title-badge no-drag ${remote?.enabled ? 'active' : ''}`}
          title={remote?.enabled ? t('titlebar.remoteActiveTitle', { tunnel: remote.tunnel }) : t('titlebar.remoteSetupTitle')}
          onClick={() => { window.location.hash = '#/remote' }}
        >
          <span className="pulse-dot" />
          {remote?.enabled ? t('titlebar.remoteOn') : t('titlebar.remoteOff')}
        </button>

        <button type="button"
          className={`yolo-btn ${tb.yoloMaster} ${store.yoloMaster ? 'on' : ''}`}
          onClick={store.toggleYolo}
          title={t('titlebar.yoloTitle')}
          aria-pressed={store.yoloMaster}
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
          <span>{anyRunning ? t('titlebar.stopAll') : t('titlebar.startAll')}</span>
        </button>

        <div style={{ position: 'relative' }} className="no-drag">
          <button type="button"
            className="repo-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t('titlebar.repoSwitch')}
            title={repoPath || t('titlebar.noRepoSelected')}
            onClick={() => {
              setMenuOpen((v) => !v)
              setOverflowOpen(false)
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
              <div className="profile-menu repo-menu" role="menu" aria-label={t('titlebar.repoSwitch')}>
                <div className="menu-caption">{t('titlebar.repoSwitch')}</div>
                {repos.length === 0 && (
                  <div className="repo-menu-empty">{t('titlebar.repoMenuEmpty')}</div>
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
                  <span style={{ fontSize: 13 }}>＋</span> {t('titlebar.chooseFolder')}
                </button>
                {store.activeRepo && (
                  <button type="button"
                    className="menu-action"
                    onClick={() => {
                      setMenuOpen(false)
                      void store.selectRepo(null)
                    }}
                  >
                    <span style={{ fontSize: 13 }}>↩</span> {t('titlebar.followProfile')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        <div style={{ position: 'relative' }} className="no-drag">
          <button
            type="button"
            ref={overflowBtnRef}
            className={tb.overflowBtn}
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            aria-label={t('titlebar.moreOptions')}
            title={t('titlebar.moreOptions')}
            onClick={() => {
              setOverflowOpen((v) => !v)
              setMenuOpen(false)
              setConfirmKill(false)
            }}
          >
            ⋯
          </button>
          {overflowOpen && (
            <>
              <div className="menu-backdrop" onClick={closeOverflow} />
              <div
                ref={overflowMenuRef}
                className={`profile-menu ${tb.overflowMenu}`}
                role="menu"
                aria-label={t('titlebar.moreOptions')}
                onKeyDown={onOverflowMenuKeyDown}
              >
                <div className="menu-caption">{t('titlebar.viewUpdates')}</div>
                {overflowItems.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className="menu-item"
                    role={item.role}
                    aria-checked={item.role === 'menuitemcheckbox' ? item.checked : undefined}
                    disabled={item.disabled}
                    title={
                      item.id === 'language'
                        ? t('titlebar.languageGroup')
                        : item.id === 'update'
                          ? updateTitle
                          : undefined
                    }
                    onClick={() => onOverflowItem(item.id)}
                  >
                    <span className="title">{item.label}</span>
                    {item.role === 'menuitemcheckbox' ? (
                      <span className="check" style={{ opacity: item.checked ? 1 : 0 }} aria-hidden="true">
                        ✓
                      </span>
                    ) : (
                      item.detail && <span className={tb.detail}>{item.detail}</span>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="tb-divider" />
        <div className="win-controls no-drag">
          <button type="button" className="win-btn" title={t('titlebar.minimize')} onClick={() => window.vertragus.win.minimize()}>
            ─
          </button>
          <button type="button"
            className="win-btn"
            title={t('titlebar.maximize')}
            style={{ fontSize: 11 }}
            onClick={() => window.vertragus.win.maximizeToggle()}
          >
            ▢
          </button>
          <button type="button" className="win-btn close" title={t('titlebar.close')} onClick={() => window.vertragus.win.close()}>
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
              <b id="stop-agents-title">{t('titlebar.stopConfirmTitle')}</b>
            </div>
            <div className="text">{t('titlebar.stopConfirmText', { n: running })}</div>
            <div className="actions">
              <button type="button" className="btn-ghost" onClick={() => setConfirmKill(false)}>
                {t('titlebar.cancel')}
              </button>
              <button type="button"
                className="btn-danger"
                onClick={() => {
                  setConfirmKill(false)
                  void store.stopAll()
                }}
              >
                {t('titlebar.stopAll')}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}

export { profileSummary, profileAgentCount }
