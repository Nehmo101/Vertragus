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
import type { RemoteApi } from './useRemote'

const XTERM_THEME = {
  background: 'rgba(0,0,0,0)',
  foreground: '#e7efe9',
  cursor: '#8fd6bd',
  selectionBackground: 'rgba(143,214,189,0.3)'
}

export function RemoteTerminal({
  agentId,
  api,
  onBack
}: {
  agentId: string
  api: RemoteApi
  onBack: () => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [title, setTitle] = useState(agentId)
  const [roleColor, setRoleColor] = useState('#8fd6bd')
  const [exited, setExited] = useState<number | null>(null)
  const [line, setLine] = useState('')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      allowTransparency: true,
      theme: XTERM_THEME,
      fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace",
      fontSize: 12.5,
      lineHeight: 1.35,
      cursorBlink: false,
      scrollback: 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
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
        term.focus()
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

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', applyFit)
      offInput.dispose()
      detach()
      term.dispose()
      termRef.current = null
    }
  }, [agentId, api])

  const sendLine = (): void => {
    api.sendInput(agentId, `${line}\r`)
    setLine('')
  }

  const key = (data: string): void => api.sendInput(agentId, data)

  return (
    <div className="terminal-view" style={{ '--role': roleColor } as React.CSSProperties}>
      <header className="terminal-header">
        <button className="back" onClick={onBack} aria-label="Zurück">
          ‹
        </button>
        <span className="terminal-title">{title}</span>
        <span className={`dot ${exited === null ? 'live' : 'dead'}`} />
      </header>
      <div className="terminal-host" ref={hostRef} />
      <div className="key-row">
        <button onClick={() => key('\x1b')}>Esc</button>
        <button onClick={() => key('\t')}>Tab</button>
        <button onClick={() => key('\x03')}>Ctrl-C</button>
        <button onClick={() => key('\x1b[A')}>↑</button>
        <button onClick={() => key('\x1b[B')}>↓</button>
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
          placeholder="Eingabe an den Agent …"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button type="submit">Senden</button>
      </form>
    </div>
  )
}
