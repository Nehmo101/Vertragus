import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { applyLocale } from '../i18n'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import type { TerminalAgentMeta, TerminalExitEvent } from '../../../preload'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'
import { trackWindowFocus } from './windowFocus'
import { XTERM_THEME } from './xtermTheme'

/**
 * WebGL is feature-detected exactly once per renderer process: a machine
 * without a usable GL context would otherwise pay the failed context creation
 * on every window. `undefined` = not probed yet, `false` = DOM renderer.
 */
let webglUsable: boolean | undefined

function loadRenderer(term: Terminal): void {
  if (webglUsable === false) return
  try {
    const addon = new WebglAddon()
    // A lost context (GPU reset, driver update) must degrade, not go black.
    addon.onContextLoss(() => {
      webglUsable = false
      addon.dispose()
    })
    term.loadAddon(addon)
    webglUsable = true
  } catch (error) {
    webglUsable = false
    console.warn('[terminal] WebGL renderer unavailable — falling back to DOM', error)
  }
}

function metaLabel(meta: TerminalAgentMeta | null, agentId: string): React.JSX.Element {
  if (!meta) return <span className="cli-label-dim">{agentId}</span>
  const engine = [meta.provider, meta.model].filter(Boolean).join(' ')
  return (
    <>
      {meta.name}
      <span className="cli-label-dim">
        {' · '}
        {meta.role}
        {engine ? ` · ${engine}` : ''}
      </span>
    </>
  )
}

/**
 * The agent's terminal window. It owns nothing but the view: the PTY lives in
 * the main process, this attaches to it, replays the scrollback and streams.
 */
export function TerminalApp({ agentId }: { agentId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const hostRef = useRef<HTMLDivElement>(null)
  const [meta, setMeta] = useState<TerminalAgentMeta | null>(null)
  const [exit, setExit] = useState<TerminalExitEvent | { exitCode: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The bridge is injected by preload before the bundle runs — stable for the
  // lifetime of the window, so it is read during render, not in the effect.
  const bridge = window.vertragus?.terminal
  const close = useCallback(() => bridge?.closeWindow(), [bridge])

  // Focus, not hover, decides whether this window is solid: hover means the
  // user is reading it, focus means they are typing in it.
  useEffect(
    () =>
      trackWindowFocus(document.documentElement.classList, {
        addEventListener: (type, listener) => window.addEventListener(type, listener),
        removeEventListener: (type, listener) => window.removeEventListener(type, listener),
        hasFocus: () => document.hasFocus()
      }),
    []
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host || !bridge) return

    const term = new Terminal({
      allowTransparency: true,
      theme: XTERM_THEME,
      fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
      fontSize: 12.5,
      lineHeight: 1.35,
      // Agent CLIs redraw progress lines constantly; a blinking block cursor
      // reads as flicker.
      cursorBlink: false,
      cursorStyle: 'bar',
      cursorWidth: 1,
      scrollback: 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    loadRenderer(term)

    const applyFit = (): void => {
      try {
        fit.fit()
        bridge.resize(term.cols, term.rows)
      } catch {
        // Fitting before the window has a layout is expected and harmless.
      }
    }

    let attached = false
    let disposed = false
    const queued: string[] = []

    const offData = bridge.onData(({ data }) => {
      if (attached) term.write(data)
      else queued.push(data)
    })
    const offExit = bridge.onExit((event) => {
      setExit(event)
      term.write(`\r\n\x1b[90m${t('terminal.exitLine', { code: event.exitCode })}\x1b[0m\r\n`)
    })
    const offInput = term.onData((data) => bridge.input(data))

    const observer = new ResizeObserver(() => applyFit())
    observer.observe(host)

    void bridge
      .attach(agentId)
      .then((result) => {
        if (disposed) return
        // CLI windows cannot query settings; the locale rides on the attach.
        if (result.locale) void applyLocale(result.locale)
        setMeta(result.meta)
        if (result.exit) setExit(result.exit)
        term.write(result.snapshot)
        attached = true
        for (const chunk of queued) term.write(chunk)
        queued.length = 0
        applyFit()
        term.focus()
      })
      .catch((cause: unknown) => {
        if (disposed) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })

    return () => {
      disposed = true
      observer.disconnect()
      offData()
      offExit()
      offInput.dispose()
      term.dispose()
    }
  }, [agentId, bridge, t])

  const roleColor = meta?.roleColor ?? 'var(--verdigris)'
  const running = exit === null
  const notice = bridge ? error : t('common.bridgeMissing')

  return (
    <div className="cli glass" style={{ '--role-color': roleColor } as React.CSSProperties}>
      <header className="cli-titlebar">
        <span
          className={`cli-status ${running ? 'is-running' : 'is-stopped'}`}
          title={
            running ? t('terminal.running') : t('terminal.stopped', { code: exit?.exitCode })
          }
        />
        <span className="cli-label">{metaLabel(meta, agentId)}</span>
        <button
          className="cli-close"
          onClick={close}
          title={t('terminal.closeWindow')}
          aria-label={t('terminal.closeWindow')}
        >
          ×
        </button>
      </header>
      {notice ? <div className="cli-error">{notice}</div> : null}
      <div className="cli-terminal" ref={hostRef} />
    </div>
  )
}
