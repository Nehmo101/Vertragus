import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CliTabState } from '../../../preload'
import { applyLocale } from '../i18n'
import { CloseIcon } from '../panel/icons'
import { applyTheme } from '../theme'
import './workspaceTabs.css'

function MaximizeGlyph({ maximized }: { maximized: boolean }): React.JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {maximized ? (
        <path d="M5 1v4H1M11 5H7V1M1 7h4v4M7 11V7h4" />
      ) : (
        <path d="M1 4.5V1h3.5M11 4.5V1H7.5M1 7.5V11h3.5M11 7.5V11H7.5" />
      )}
    </svg>
  )
}

/**
 * Chrome for `ui.cliWindowMode === 'tabs'`: one strip of agent tabs plus
 * window controls. Each tab is a host WebContentsView; this renderer only
 * switches them. Controls opt out of the drag region so clicks reach Chromium.
 */
export function WorkspaceTabsApp({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const bridge = window.vertragus?.cliTabs
  const [state, setState] = useState<CliTabState | null>(null)

  useEffect(() => {
    if (!bridge) return
    let alive = true
    const apply = (next: CliTabState): void => {
      if (!alive) return
      setState(next)
      if (next.locale) void applyLocale(next.locale)
      if (next.theme) applyTheme(next.theme)
    }
    bridge.attach().then(apply, () => undefined)
    const off = bridge.onState(apply)
    return () => {
      alive = false
      off()
    }
  }, [bridge, workspaceId])

  const select = useCallback(
    (agentId: string) => {
      bridge?.select(agentId)
    },
    [bridge]
  )
  const close = useCallback(() => bridge?.closeWindow(), [bridge])
  const minimize = useCallback(() => bridge?.minimizeWindow(), [bridge])
  const toggleMaximize = useCallback(() => {
    void bridge?.toggleMaximizeWindow()
  }, [bridge])

  const tabs = state?.tabs ?? []
  const selected = state?.selectedAgentId
  const maximized = state?.maximized === true

  return (
    <div className="wt">
      <header className="wt-bar">
        <span className="wt-title">{t('workspaceTabs.title')}</span>
        <nav className="wt-tabs" aria-label={t('workspaceTabs.title')}>
          {tabs.map((tab) => {
            const active = tab.agentId === selected
            return (
              <button
                key={tab.agentId}
                type="button"
                className={`wt-tab${active ? ' is-active' : ''}`}
                style={{ '--role-color': tab.roleColor } as React.CSSProperties}
                onClick={() => select(tab.agentId)}
                title={t('workspaceTabs.select', { agent: tab.title })}
                aria-label={t('workspaceTabs.select', { agent: tab.title })}
                aria-current={active ? 'page' : undefined}
              >
                {tab.title}
              </button>
            )
          })}
        </nav>
        <button
          type="button"
          className="wt-btn"
          onClick={minimize}
          title={t('workspaceTabs.minimize')}
          aria-label={t('workspaceTabs.minimize')}
        >
          −
        </button>
        <button
          type="button"
          className="wt-btn"
          onClick={toggleMaximize}
          title={maximized ? t('workspaceTabs.restore') : t('workspaceTabs.maximize')}
          aria-label={maximized ? t('workspaceTabs.restore') : t('workspaceTabs.maximize')}
          aria-pressed={maximized}
        >
          <MaximizeGlyph maximized={maximized} />
        </button>
        <button
          type="button"
          className="wt-btn wt-close"
          onClick={close}
          title={t('workspaceTabs.close')}
          aria-label={t('workspaceTabs.close')}
        >
          <CloseIcon size={11} />
        </button>
      </header>
    </div>
  )
}
