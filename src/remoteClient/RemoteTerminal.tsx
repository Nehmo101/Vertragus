/**
 * One agent's terminal in the browser. Reuses xterm (the same renderer the
 * desktop window uses) and the lossless snapshot-then-stream attach.
 *
 * Phones and a raw xterm keyboard do not mix — a mobile keyboard fights the
 * hidden textarea xterm relies on — so the primary input is an explicit text
 * field with a send button, plus a key row for the keys a composer needs
 * (Enter, Esc, Tab, Ctrl-C, arrows). Direct xterm typing still works on a
 * physical keyboard and is forwarded the same way.
 */
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'
import type { RemoteCopy } from './i18n'
import type { RemoteApi } from './useRemote'

const XTERM_THEME = {
  background: 'rgba(0,0,0,0)',
  foreground: '#eae6db',
  cursor: '#cba35a',
  selectionBackground: 'rgba(203,163,90,0.3)'
}

const FONT_MIN = 12
const FONT_MAX = 18
const FONT_DEFAULT = 14

function isCoarsePointer(): boolean {
  return window.matchMedia('(pointer: coarse)').matches
}

export function RemoteTerminal({
  agentId,
  api,
  copy,
  onBack
}: {
  agentId: string
  api: RemoteApi
  copy: RemoteCopy
  onBack: () => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [title, setTitle] = useState(agentId)
  const [roleColor, setRoleColor] = useState('#cba35a')
  const [exited, setExited] = useState<number | null>(null)
  const [line, setLine] = useState('')
  const [fontSize, setFontSize] = useState(FONT_DEFAULT)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      allowTransparency: true,
      theme: XTERM_THEME,
      fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace",
      fontSize,
      lineHeight: 1.4,
      cursorBlink: false,
      scrollback: 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit
    const applyFit = (): void => {
      try {
        fit.fit()
        api.resize(agentId, term.cols, term.rows)
      } catch {
        /* layout not ready yet */
      }
    }

    const offInput = term.onData((data) => api.sendInput(agentId, data))
    const detach = api.attach(agentId, {
      onSnapshot: (snapshot, _cols, _rows, name, color) => {
        setTitle(name)
        setRoleColor(color)
        term.write(snapshot)
        applyFit()
        if (!isCoarsePointer()) term.focus()
      },
      onData: (data) => term.write(data),
      onExit: (exitCode) => {
        setExited(exitCode ?? 0)
        term.write(`\r\n\x1b[90m— beendet · exit ${exitCode ?? 0} —\x1b[0m\r\n`)
      }
    })

    const observer = new ResizeObserver(() => applyFit())
    observer.observe(host)
    window.addEventListener('resize', applyFit)
    window.visualViewport?.addEventListener('resize', applyFit)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', applyFit)
      window.visualViewport?.removeEventListener('resize', applyFit)
      offInput.dispose()
      detach()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [agentId, api, fontSize])

  const sendLine = (): void => {
    api.sendInput(agentId, `${line}\r`)
    setLine('')
  }

  const key = (data: string): void => api.sendInput(agentId, data)

  const bumpFont = (delta: number): void => {
    setFontSize((current) => Math.min(FONT_MAX, Math.max(FONT_MIN, current + delta)))
  }

  return (
    <div className="terminal-view" style={{ '--role': roleColor } as React.CSSProperties}>
      <header className="terminal-header">
        <button className="back" onClick={onBack} aria-label={copy.back} type="button">
          ‹
        </button>
        <span className="terminal-title">{title}</span>
        <span
          className={`dot ${exited === null ? 'live' : 'dead'}`}
          title={exited === null ? copy.terminalLive : copy.terminalDead}
        />
        <button
          type="button"
          className="font-btn"
          onClick={() => bumpFont(-1)}
          aria-label={copy.fontSmaller}
        >
          A−
        </button>
        <button
          type="button"
          className="font-btn"
          onClick={() => bumpFont(1)}
          aria-label={copy.fontLarger}
        >
          A+
        </button>
      </header>
      <div className="terminal-host" ref={hostRef} />
      <div className="key-row" role="toolbar" aria-label="Steuertasten">
        <button type="button" onClick={() => key('\x1b')}>
          Esc
        </button>
        <button type="button" onClick={() => key('\t')}>
          Tab
        </button>
        <button type="button" onClick={() => key('\r')}>
          Enter
        </button>
        <button type="button" onClick={() => key('\x03')}>
          Ctrl-C
        </button>
        <button type="button" onClick={() => key('\x1b[D')}>
          ←
        </button>
        <button type="button" onClick={() => key('\x1b[A')}>
          ↑
        </button>
        <button type="button" onClick={() => key('\x1b[B')}>
          ↓
        </button>
        <button type="button" onClick={() => key('\x1b[C')}>
          →
        </button>
      </div>
      <form
        className="input-bar"
        onSubmit={(event) => {
          event.preventDefault()
          sendLine()
        }}
      >
        <input
          value={line}
          onChange={(event) => setLine(event.target.value)}
          placeholder={copy.terminalInput}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="send"
        />
        <button type="submit">{copy.composerSend}</button>
      </form>
    </div>
  )
}
