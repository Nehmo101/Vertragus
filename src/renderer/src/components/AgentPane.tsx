import { memo, useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { AgentInstanceInfo } from '@shared/agents'
import { LIMIT_KIND_LABELS } from '@shared/agents'
import { summarizeUsage, TELEMETRY_STATUS_LABELS, TELEMETRY_STATUS_TITLES } from '@shared/telemetry'
import { PROVIDER_THEME, STATUS_THEME, XTERM_THEME } from '@renderer/ui/theme'
import { formatTokenBreakdown, formatTokenCount, formatUsd } from '@renderer/telemetryFormat'
import LoreName from '@renderer/components/LoreName'
import { isAgentTerminalChunk } from './terminalStream'
import { createTerminalFrameWriter } from './terminalFrameWriter'
import { terminalEnterData } from '@renderer/components/terminalEnter'
import styles from './responsiveGuards.module.css'

interface Props {
  agent: AgentInstanceInfo
  onClose?: () => void
  onPopout?: () => void
  onFocus?: () => void
  onHandoff?: () => void
  focused?: boolean
  subdued?: boolean
}

/**
 * Live terminal bound to a real agent PTY. Replays the scrollback buffer via
 * seq numbers, then streams — duplicates and gaps are impossible by design.
 */
export function useAgentTerminal(agentId: string, inputEnabled: boolean): React.RefObject<HTMLDivElement> {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const inputEnabledRef = useRef(inputEnabled)

  useEffect(() => {
    inputEnabledRef.current = inputEnabled
    if (terminalRef.current) terminalRef.current.options.disableStdin = !inputEnabled
  }, [inputEnabled])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace",
      fontSize: 11,
      lineHeight: 1.35,
      theme: XTERM_THEME,
      // Agent CLIs redraw progress lines while input stays active. A blinking
      // block cursor makes those cursor moves look like terminal flicker.
      cursorBlink: false,
      cursorStyle: 'bar',
      cursorWidth: 1,
      cursorInactiveStyle: 'none',
      scrollback: 4000,
      disableStdin: !inputEnabledRef.current,
      allowProposedApi: true
    })
    terminalRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    const frameWriter = createTerminalFrameWriter((data) => term.write(data))

    // Preserve Ctrl/Cmd+C as SIGINT when nothing is selected, but let xterm's
    // copy event handler place an active terminal selection on the clipboard.
    term.attachCustomKeyEventHandler((event) => {
      const enterData = terminalEnterData(event)
      if (enterData) {
        if (inputEnabledRef.current) {
          window.orca.agents.markInteractiveUsed(agentId)
          window.orca.agents.write(agentId, enterData)
        }
        return false
      }

      const modifier = event.ctrlKey || event.metaKey
      const isCopy = modifier && !event.altKey && event.key.toLowerCase() === 'c'
      return !(event.type === 'keydown' && isCopy && term.hasSelection())
    })

    let disposed = false
    let lastSeq = 0
    let ready = false
    const queue: Array<{ data: string; seq: number }> = []

    const unsubscribe = window.orca.agents.onData((chunk) => {
      if (!isAgentTerminalChunk(agentId, chunk.id)) return
      if (!ready) {
        queue.push(chunk)
        return
      }
      if (chunk.seq <= lastSeq) return
      lastSeq = chunk.seq
      frameWriter.write(chunk.data)
    })

    void window.orca.agents.buffer(agentId).then((snap) => {
      if (disposed) return
      let initialData = snap.data
      lastSeq = snap.seq
      ready = true
      for (const chunk of queue) {
        if (chunk.seq > lastSeq) {
          lastSeq = chunk.seq
          initialData += chunk.data
        }
      }
      queue.length = 0
      frameWriter.write(initialData)
    })

    const onInput = term.onData((data) => {
      if (inputEnabledRef.current) window.orca.agents.write(agentId, data)
    })
    // onData also carries automatic terminal protocol replies. Only real user
    // keyboard/paste actions reserve a warm team pane from orchestrator reuse.
    const onKey = term.onKey(() => window.orca.agents.markInteractiveUsed(agentId))
    const onPaste = (): void => window.orca.agents.markInteractiveUsed(agentId)
    host.addEventListener('paste', onPaste, true)

    let lastSize = ''
    const doFit = (): void => {
      try {
        fit.fit()
        const size = `${term.cols}x${term.rows}`
        if (size === lastSize) return
        lastSize = size
        window.orca.agents.resize(agentId, term.cols, term.rows)
      } catch {
        // host not laid out yet
      }
    }
    doFit()
    let resizeFrame: number | undefined
    const observer = new ResizeObserver(() => {
      if (resizeFrame != null) return
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined
        doFit()
      })
    })
    observer.observe(host)

    return () => {
      disposed = true
      observer.disconnect()
      if (resizeFrame != null) cancelAnimationFrame(resizeFrame)
      onInput.dispose()
      onKey.dispose()
      host.removeEventListener('paste', onPaste, true)
      unsubscribe()
      frameWriter.dispose()
      term.dispose()
      terminalRef.current = null
    }
  }, [agentId])

  return hostRef
}

/**
 * The xterm instance is deliberately isolated from status and usage updates.
 * It is recreated only when its backing PTY instance changes.
 */
const TerminalHost = memo(function TerminalHost({
  agentId,
  inputEnabled
}: {
  agentId: string
  inputEnabled: boolean
}): JSX.Element {
  const hostRef = useAgentTerminal(agentId, inputEnabled)
  return <div className="pane-term" ref={hostRef} />
})

export default function AgentPane({ agent, onClose, onPopout, onFocus, onHandoff, focused, subdued }: Props): JSX.Element {
  const provider = PROVIDER_THEME[agent.provider]
  const status = STATUS_THEME[agent.status]
  const isOrch = agent.kind === 'orchestrator'
  const yoloLive = agent.yolo && agent.status === 'running'
  const usage = agent.usage
  const telemetry = summarizeUsage(usage)
  const limit = agent.limitWarning

  return (
    <div
      className={`pane ${styles.agentPane} ${isOrch ? 'orch' : ''} ${yoloLive && !isOrch ? 'yolo-live' : ''} ${focused ? 'focused' : ''} ${subdued ? 'subdued' : ''}`}
      onMouseDown={onFocus}
    >
      <div className="pane-head">
        <span className="chip sz-27" style={{ background: provider.bg, color: provider.fg }}>
          {provider.mono}
        </span>
        <div className="pane-title-block">
          <div className="pane-line1">
            <LoreName name={agent.name} className="pane-name" />
            <span className="pane-model">{agent.model || 'CLI-Standard'}</span>
            {isOrch && <span className="badge-orch">Orchestrator</span>}
            {agent.yolo && <span className="badge-yolo">YOLO</span>}
            {limit && (
              <span className="badge-limit" title={limit.note ?? 'Limit erkannt'}>
                ⚠ {LIMIT_KIND_LABELS[limit.kind]}
              </span>
            )}
            {agent.handoffTo && (
              <span className="badge-handoff" title={`übergeben an ${agent.handoffTo.name}`}>
                ↪ {agent.handoffTo.name}
              </span>
            )}
            {agent.handoffFrom && (
              <span className="badge-handoff from" title={`übernommen von ${agent.handoffFrom.name}`}>
                ↩ {agent.handoffFrom.name}
              </span>
            )}
          </div>
          <div className="pane-line2">
            <span
              className="pane-dot"
              style={{
                background: status.dot,
                boxShadow: `0 0 8px ${status.dot}`
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
        {onHandoff && (
          <button
            type="button"
            className={`pane-icon-btn handoff ${limit ? 'warn' : ''}`}
            title={limit ? `Limit nahe — an anderen Agent übergeben` : 'Arbeit an anderen Agent übergeben'}
            aria-label="Arbeit an anderen Agent übergeben"
            onClick={onHandoff}
          >
            ⇄
          </button>
        )}
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

      <TerminalHost
        agentId={agent.id}
        inputEnabled={agent.status === 'running'}
      />

      <div className="pane-foot">
        {usage ? (
          <>
            {telemetry.steps != null && <span><span className="k">Schritte</span> <b>{telemetry.steps}</b></span>}
            {telemetry.tokens != null && (
              <span title={formatTokenBreakdown(usage.tokensIn, usage.tokensOut)}>
                <span className="k">Tokens</span> <b>{formatTokenCount(telemetry.tokens)}</b>
              </span>
            )}
            {telemetry.costUsd != null && (
              <span><span className="k">Kosten</span> <b className="cost">{formatUsd(telemetry.costUsd)}</b></span>
            )}
          </>
        ) : (
          <span className="telemetry-status absent" title={TELEMETRY_STATUS_TITLES.absent}>
            {TELEMETRY_STATUS_LABELS.absent}
          </span>
        )}
        {usage && telemetry.status !== 'present' && (
          <span className={`telemetry-status ${telemetry.status}`} title={TELEMETRY_STATUS_TITLES[telemetry.status]}>
            {TELEMETRY_STATUS_LABELS[telemetry.status]}
          </span>
        )}
        <span className="spacer" />
        {agent.branch && (
          <span className="agent-branch-tag" title={`Branch: ${agent.branch}`}>
            {agent.branch}
          </span>
        )}
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
