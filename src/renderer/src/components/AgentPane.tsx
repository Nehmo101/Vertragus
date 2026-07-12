import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { AgentInstanceInfo } from '@shared/agents'
import { PROVIDER_THEME, STATUS_THEME, XTERM_THEME } from '@renderer/ui/theme'
import LoreName from '@renderer/components/LoreName'

interface Props {
  agent: AgentInstanceInfo
  onClose?: () => void
  onPopout?: () => void
  onFocus?: () => void
  focused?: boolean
  subdued?: boolean
}

/**
 * Live terminal bound to a real agent PTY. Replays the scrollback buffer via
 * seq numbers, then streams — duplicates and gaps are impossible by design.
 */
function useAgentTerminal(agentId: string): React.RefObject<HTMLDivElement> {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace",
      fontSize: 11,
      lineHeight: 1.35,
      theme: XTERM_THEME,
      cursorBlink: true,
      scrollback: 4000,
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    let lastSeq = 0
    let ready = false
    const queue: Array<{ data: string; seq: number }> = []

    const unsubscribe = window.orca.agents.onData((chunk) => {
      if (chunk.id !== agentId) return
      if (!ready) {
        queue.push(chunk)
        return
      }
      if (chunk.seq <= lastSeq) return
      lastSeq = chunk.seq
      term.write(chunk.data)
    })

    void window.orca.agents.buffer(agentId).then((snap) => {
      if (snap.data) term.write(snap.data)
      lastSeq = snap.seq
      ready = true
      for (const chunk of queue) {
        if (chunk.seq > lastSeq) {
          lastSeq = chunk.seq
          term.write(chunk.data)
        }
      }
      queue.length = 0
    })

    const onInput = term.onData((data) => {
      window.orca.agents.write(agentId, data)
    })

    const doFit = (): void => {
      try {
        fit.fit()
        window.orca.agents.resize(agentId, term.cols, term.rows)
      } catch {
        // host not laid out yet
      }
    }
    doFit()
    const observer = new ResizeObserver(doFit)
    observer.observe(host)

    return () => {
      observer.disconnect()
      onInput.dispose()
      unsubscribe()
      term.dispose()
    }
  }, [agentId])

  return hostRef
}

export default function AgentPane({ agent, onClose, onPopout, onFocus, focused, subdued }: Props): JSX.Element {
  const hostRef = useAgentTerminal(agent.id)
  const provider = PROVIDER_THEME[agent.provider]
  const status = STATUS_THEME[agent.status]
  const isOrch = agent.kind === 'orchestrator'
  const yoloLive = agent.yolo && agent.status === 'running'
  const usage = agent.usage
  const tokens = (usage?.tokensIn ?? 0) + (usage?.tokensOut ?? 0)

  return (
    <div
      className={`pane ${isOrch ? 'orch' : ''} ${yoloLive && !isOrch ? 'yolo-live' : ''} ${focused ? 'focused' : ''} ${subdued ? 'subdued' : ''}`}
      onMouseDown={onFocus}
    >
      <div className="pane-head">
        <span className="chip sz-27" style={{ background: provider.bg, color: provider.fg }}>
          {provider.mono}
        </span>
        <div className="pane-title-block">
          <div className="pane-line1">
            <LoreName name={agent.name} className="pane-name" />
            <span className="pane-model">{agent.model}</span>
            {isOrch && <span className="badge-orch">Orchestrator</span>}
            {agent.yolo && <span className="badge-yolo">YOLO</span>}
          </div>
          <div className="pane-line2">
            <span
              className="pane-dot"
              style={{
                background: status.dot,
                boxShadow: `0 0 8px ${status.dot}`,
                animation: status.pulse
                  ? `dotpulse ${status.pulse} ease-in-out infinite`
                  : 'none'
              }}
            />
            <span className="pane-status" style={{ color: status.text }}>
              {status.label}
            </span>
            <span className="sep">·</span>
            <span className="pane-role" title={agent.role}>
              {agent.role}
            </span>
          </div>
        </div>
        {onPopout && (
          <button type="button" className="pane-icon-btn" title="Als eigenes Fenster" aria-label="Agent als eigenes Fenster öffnen" onClick={onPopout}>
            ⧉
          </button>
        )}
        {onClose && (
          <button type="button" className="pane-icon-btn close" title="Agent schließen" aria-label="Agent schließen" onClick={onClose}>
            ✕
          </button>
        )}
      </div>

      <div className={`pane-term ${agent.status === 'stopped' ? 'stopped' : ''}`} ref={hostRef} />

      <div className="pane-foot">
        {usage ? (
          <>
            {usage.steps != null && <span><span className="k">Schritte</span> <b>{usage.steps}</b></span>}
            {tokens > 0 && (
              <span title={`${usage.tokensIn ?? 0} Eingabe · ${usage.tokensOut ?? 0} Ausgabe`}>
                <span className="k">Tokens</span> <b>{tokens.toLocaleString()}</b>
              </span>
            )}
            {usage.costUsd != null && (
              <span><span className="k">Kosten</span> <b className="cost">${usage.costUsd.toFixed(4)}</b></span>
            )}
          </>
        ) : (
          <span className="usage-unavailable" title="Dieser Provider liefert derzeit keine Telemetrie an Orca-Strator">
            Nutzungsdaten nicht verfügbar
          </span>
        )}
        <span className="spacer" />
        {agent.worktree && (
          <span className="wt-tag" title={`Worktree: ${agent.worktree}`}>
            wt
          </span>
        )}
        <span className="id">{agent.id}</span>
      </div>
    </div>
  )
}
