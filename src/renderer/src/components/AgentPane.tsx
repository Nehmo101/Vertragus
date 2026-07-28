import { memo, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import type { AgentInstanceInfo, HandoffLink } from '@shared/agents'
import { LIMIT_KIND_LABELS } from '@shared/agents'
import { absentTelemetryNotice, summarizeUsage, TELEMETRY_STATUS_LABELS, TELEMETRY_STATUS_TITLES } from '@shared/telemetry'
import { PROVIDER_THEME, STATUS_THEME, XTERM_THEME } from '@renderer/ui/theme'
import { formatTokenBreakdown, formatTokenCount, formatUsd } from '@renderer/telemetryFormat'
import { useAppStore, effectivePaneReadable } from '@renderer/store/useAppStore'
import { paneReadableSummary } from '@renderer/orchestratorActivity'
import LoreName from '@renderer/components/LoreName'
import { useLayoutStore, paneFontSize } from '@renderer/store/layoutStore'
import { isAgentTerminalChunk } from './terminalStream'
import { createTerminalFrameWriter } from './terminalFrameWriter'
import { terminalEnterData } from '@renderer/components/terminalEnter'
import { paneSearchKeyAction, type PaneSearchApi } from './paneSearch'
import styles from './responsiveGuards.module.css'
import paneStyles from './AgentPane.module.css'

interface Props {
  agent: AgentInstanceInfo
  onClose?: () => void
  onPopout?: () => void
  onFocus?: () => void
  onHandoff?: () => void
  focused?: boolean
  subdued?: boolean
}

function handoffState(t: TFunction, link: HandoffLink): string {
  switch (link.handshake?.phase) {
    case 'awaiting-context': return ` · ${t('agentPane.handoffPhase.awaitingContext')}`
    case 'awaiting-ack': return ` · ${t('agentPane.handoffPhase.awaitingAck')}`
    case 'completing':
    case 'completed': return ` · ${t('agentPane.handoffPhase.confirmed')}`
    case 'failed': return ` · ${t('agentPane.handoffPhase.failed')}`
    default: return ''
  }
}

/**
 * Live terminal bound to a real agent PTY. Replays the scrollback buffer via
 * seq numbers, then streams — duplicates and gaps are impossible by design.
 *
 * The per-pane font size is persisted in the layoutStore (keyed by agentId);
 * the hook reads it imperatively (getState + subscribe) instead of a React
 * subscription so font changes never re-render the pane.
 */
export function useAgentTerminal(
  agentId: string,
  inputEnabled: boolean,
  searchApiRef?: MutableRefObject<PaneSearchApi | null>
): React.RefObject<HTMLDivElement> {
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
      fontSize: paneFontSize(useLayoutStore.getState(), agentId),
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
    const search = new SearchAddon()
    term.loadAddon(search)
    if (searchApiRef) {
      searchApiRef.current = {
        findNext: (query, incremental) => search.findNext(query, { incremental }),
        findPrevious: (query) => search.findPrevious(query),
        clear: () => search.clearDecorations()
      }
    }
    term.open(host)
    const frameWriter = createTerminalFrameWriter((data) => term.write(data))

    // Preserve Ctrl/Cmd+C as SIGINT when nothing is selected, but let xterm's
    // copy event handler place an active terminal selection on the clipboard.
    term.attachCustomKeyEventHandler((event) => {
      const enterData = terminalEnterData(event)
      if (enterData) {
        if (inputEnabledRef.current) {
          window.vertragus.agents.markInteractiveUsed(agentId)
          window.vertragus.agents.write(agentId, enterData)
        }
        return false
      }

      const modifier = event.ctrlKey || event.metaKey
      // Ctrl/Cmd+0 resets the pane font size back to the default.
      if (
        event.type === 'keydown' &&
        modifier &&
        !event.altKey &&
        (event.key === '0' || event.code === 'Digit0')
      ) {
        useLayoutStore.getState().resetPaneFontSize(agentId)
        return false
      }

      const isCopy = modifier && !event.altKey && event.key.toLowerCase() === 'c'
      return !(event.type === 'keydown' && isCopy && term.hasSelection())
    })

    let disposed = false
    let lastSeq = 0
    let ready = false
    const queue: Array<{ data: string; seq: number }> = []

    const unsubscribe = window.vertragus.agents.onData((chunk) => {
      if (!isAgentTerminalChunk(agentId, chunk.id)) return
      if (!ready) {
        queue.push(chunk)
        return
      }
      if (chunk.seq <= lastSeq) return
      lastSeq = chunk.seq
      frameWriter.write(chunk.data)
    })

    void window.vertragus.agents.buffer(agentId).then((snap) => {
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
      if (inputEnabledRef.current) window.vertragus.agents.write(agentId, data)
    })
    // onData also carries automatic terminal protocol replies. Only real user
    // keyboard/paste actions reserve a warm team pane from orchestrator reuse.
    const onKey = term.onKey(() => window.vertragus.agents.markInteractiveUsed(agentId))
    const onPaste = (): void => window.vertragus.agents.markInteractiveUsed(agentId)
    host.addEventListener('paste', onPaste, true)

    let lastSize = ''
    const doFit = (): void => {
      try {
        fit.fit()
        const size = `${term.cols}x${term.rows}`
        if (size === lastSize) return
        lastSize = size
        window.vertragus.agents.resize(agentId, term.cols, term.rows)
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

    // Ctrl/Cmd+wheel over the terminal changes the font size (8-20 px).
    // Capture phase so xterm's own scroll handling cannot swallow the event.
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      event.stopPropagation()
      const store = useLayoutStore.getState()
      const current = paneFontSize(store, agentId)
      store.setPaneFontSize(agentId, current + (event.deltaY < 0 ? 1 : -1))
    }
    host.addEventListener('wheel', onWheel, { passive: false, capture: true })

    // Apply persisted font changes (wheel/Ctrl+0, including from a popout
    // window of the same agent) directly to the terminal.
    const unsubscribeFont = useLayoutStore.subscribe((state) => {
      const size = paneFontSize(state, agentId)
      if (term.options.fontSize !== size) {
        term.options.fontSize = size
        lastSize = ''
        doFit()
      }
    })

    return () => {
      disposed = true
      observer.disconnect()
      if (resizeFrame != null) cancelAnimationFrame(resizeFrame)
      onInput.dispose()
      onKey.dispose()
      host.removeEventListener('paste', onPaste, true)
      host.removeEventListener('wheel', onWheel, { capture: true })
      unsubscribeFont()
      unsubscribe()
      frameWriter.dispose()
      if (searchApiRef) searchApiRef.current = null
      term.dispose()
      terminalRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- searchApiRef ist ein stabiles Ref-Objekt
  }, [agentId])

  return hostRef
}

/**
 * The xterm instance is deliberately isolated from status and usage updates.
 * It is recreated only when its backing PTY instance changes.
 */
const TerminalHost = memo(function TerminalHost({
  agentId,
  inputEnabled,
  searchApiRef
}: {
  agentId: string
  inputEnabled: boolean
  /** Stabiles Ref-Objekt — bricht die memo()-Isolation nicht. */
  searchApiRef?: MutableRefObject<PaneSearchApi | null>
}): JSX.Element {
  const hostRef = useAgentTerminal(agentId, inputEnabled, searchApiRef)
  return <div className="pane-term" ref={hostRef} />
})

/**
 * Small reusable info button with a popover for secondary details (branch,
 * worktree, agent id) that do not need a permanent footer slot. Escape or a
 * click outside closes it. Visible texts are hard German, i18n follows later
 * (kept umlaut-free to satisfy the renderer i18n hardcode guard).
 */
export function PaneInfoPopover({
  entries
}: {
  entries: Array<{ label: string; value: string }>
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span className={paneStyles.infoWrap} ref={wrapRef}>
      <button
        type="button"
        className={`${paneStyles.infoBtn} ${open ? paneStyles.infoBtnOpen : ''}`}
        /* i18n-spaeter */
        title="Details (Branch, Worktree, Agent-ID)"
        aria-label="Agent-Details anzeigen"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        ℹ
      </button>
      {open && (
        /* i18n-spaeter */
        <div className={paneStyles.infoPopover} role="dialog" aria-label="Agent-Details">
          <dl>
            {entries.map((entry) => (
              <div key={entry.label} style={{ display: 'contents' }}>
                <dt>{entry.label}</dt>
                <dd title={entry.value}>{entry.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </span>
  )
}

export default function AgentPane({ agent, onClose, onPopout, onFocus, onHandoff, focused, subdued }: Props): JSX.Element {
  const { t } = useTranslation()
  const provider = PROVIDER_THEME[agent.provider]
  const status = STATUS_THEME[agent.status]
  const isOrch = agent.kind === 'orchestrator'
  const yoloLive = agent.yolo && agent.status === 'running'
  const usage = agent.usage
  const telemetry = summarizeUsage(usage)
  const absence = absentTelemetryNotice(agent.mode)
  const limit = agent.limitWarning
  const readable = useAppStore((s) => effectivePaneReadable(s, agent.id))
  const togglePaneReadable = useAppStore((s) => s.togglePaneReadable)
  // The snapshot only feeds the readable summary; subscribe to it only while
  // "Lesbar" is on, so orchestrator ticks don't re-render raw terminal panes.
  const orchestrator = useAppStore((s) => (readable ? s.orchestrator : undefined))
  const summary = readable ? paneReadableSummary(agent, orchestrator) : null

  // Scrollback search: the loupe button toggles the field, Enter = next,
  // Shift+Enter = previous, Escape closes. The addon API arrives via a ref
  // from the terminal hook.
  const searchApiRef = useRef<PaneSearchApi | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const closeSearch = (): void => {
    setSearchOpen(false)
    setSearchQuery('')
    searchApiRef.current?.clear()
  }
  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    const action = paneSearchKeyAction(event)
    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    if (action === 'close') closeSearch()
    else if (searchQuery) {
      if (action === 'next') searchApiRef.current?.findNext(searchQuery)
      else searchApiRef.current?.findPrevious(searchQuery)
    }
  }

  // Secondary details move into the info popover instead of the footer.
  /* i18n-spaeter */
  const infoEntries: Array<{ label: string; value: string }> = [
    ...(agent.branch ? [{ label: 'Branch', value: agent.branch }] : []),
    ...(agent.worktree ? [{ label: 'Worktree', value: agent.worktree }] : []),
    { label: 'Agent-ID', value: agent.id }
  ]

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
            <span className="pane-model">{agent.model || t('agentPane.cliDefault')}</span>
            {isOrch && <span className="badge-orch">{t('agentPane.orchestrator')}</span>}
            {agent.yolo && <span className="badge-yolo">YOLO</span>}
            {limit && (
              <span className="badge-limit" title={limit.note ?? t('agentPane.limitDetected')}>
                ⚠ {LIMIT_KIND_LABELS[limit.kind]}
              </span>
            )}
            {agent.handoffTo && (
              <span className="badge-handoff" title={`${t('agentPane.handoffToTitle', { name: agent.handoffTo.name })}${handoffState(t, agent.handoffTo)}`}>
                ↪ {agent.handoffTo.name}{handoffState(t, agent.handoffTo)}
              </span>
            )}
            {agent.handoffFrom && (
              <span className="badge-handoff from" title={`${t('agentPane.handoffFromTitle', { name: agent.handoffFrom.name })}${handoffState(t, agent.handoffFrom)}`}>
                ↩ {agent.handoffFrom.name}{handoffState(t, agent.handoffFrom)}
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
        {searchOpen && (
          <input
            className={paneStyles.searchInput}
            type="text"
            /* i18n-spaeter */
            placeholder="Suchen…"
            aria-label="Im Terminal-Verlauf suchen"
            autoFocus
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value)
              if (event.target.value) searchApiRef.current?.findNext(event.target.value, true)
              else searchApiRef.current?.clear()
            }}
            onKeyDown={onSearchKeyDown}
          />
        )}
        <button
          type="button"
          className="pane-icon-btn"
          /* i18n-spaeter */
          title="Suche im Verlauf (Enter = weiter, Shift+Enter = vorheriger Treffer, Esc = beenden)"
          aria-label="Suche im Terminal-Verlauf umschalten"
          aria-pressed={searchOpen}
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
        >
          ⌕
        </button>
        {onHandoff && (
          <button
            type="button"
            className={`pane-icon-btn handoff ${limit ? 'warn' : ''}`}
            title={limit ? t('agentPane.handoffLimitTitle') : t('agentPane.handoffTitle')}
            aria-label={t('agentPane.handoffAria')}
            onClick={onHandoff}
          >
            ⇄
          </button>
        )}
        {onPopout && (
          <button type="button" className="pane-icon-btn" title={t('agentPane.popoutTitle')} aria-label={t('agentPane.popoutAria')} onClick={onPopout}>
            ⧉
          </button>
        )}
        {onClose && (
          <button type="button" className="pane-icon-btn close" title={t('agentPane.closeTitle')} aria-label={t('agentPane.closeAria')} onClick={onClose}>
            ✕
          </button>
        )}
      </div>

      <div className="pane-body">
        <TerminalHost
          agentId={agent.id}
          inputEnabled={agent.status === 'running'}
          searchApiRef={searchApiRef}
        />
        {readable && summary && (
          <div className="pane-readable" role="status" aria-live="polite">
            <div className="pane-readable-head">
              <span className="pane-readable-tag">{t('agentPane.readableTag')}</span>
              <span className="pane-readable-phase">{summary.phaseLabel}</span>
            </div>
            <div className="pane-readable-headline">{summary.headline}</div>
            {summary.lines.length > 0 && (
              <ul className="pane-readable-lines">
                {summary.lines.map((line, index) => (
                  <li key={`${line}-${index}`}>{line}</li>
                ))}
              </ul>
            )}
            {summary.nextStep && (
              <div className="pane-readable-next">
                <span>{t('agentPane.nextStep')}</span>
                {summary.nextStep}
              </div>
            )}
            <div className="pane-readable-hint">
              {t('agentPane.readableHint')}
            </div>
          </div>
        )}
      </div>

      <div className="pane-foot">
        <label
          className={`pane-readable-toggle ${readable ? 'on' : ''}`}
          title={t('agentPane.readableToggleTitle')}
        >
          <input
            type="checkbox"
            checked={readable}
            onChange={() => togglePaneReadable(agent.id)}
          />
          <span className="mark" aria-hidden="true">✓</span>
          <span className="label">{t('agentPane.readable')}</span>
        </label>
        {usage ? (
          <>
            {telemetry.steps != null && <span><span className="k">{t('agentPane.steps')}</span> <b>{telemetry.steps}</b></span>}
            {telemetry.tokens != null && (
              <span title={formatTokenBreakdown(usage.tokensIn, usage.tokensOut)}>
                <span className="k">{t('agentPane.tokens')}</span> <b>{formatTokenCount(telemetry.tokens)}</b>
              </span>
            )}
            {telemetry.costUsd != null && (
              <span><span className="k">{t('agentPane.cost')}</span> <b className="cost">{formatUsd(telemetry.costUsd)}</b></span>
            )}
          </>
        ) : (
          <span className="telemetry-status absent" title={absence.title}>
            {absence.label}
          </span>
        )}
        {usage && telemetry.status !== 'present' && (
          <span className={`telemetry-status ${telemetry.status}`} title={TELEMETRY_STATUS_TITLES[telemetry.status]}>
            {TELEMETRY_STATUS_LABELS[telemetry.status]}
          </span>
        )}
        <span className="spacer" />
        {/* Secondary details (branch, worktree, agent id) live in the info
            popover; status/provider/model/telemetry stay always visible. */}
        <PaneInfoPopover entries={infoEntries} />
      </div>
    </div>
  )
}
