import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { activeLocale, applyLocale } from '../i18n'
import { LoreTip } from '../lore/LoreTip'
import { applyTheme } from '../theme'
import { metaBlurb } from './titleBlurb'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { Locale, Translate } from '../i18n'
import type {
  TerminalAgentMeta,
  TerminalExitEvent,
  TerminalQuestionInbox
} from '../../../preload'
import HoundLogo from '../panel/HoundLogo'
import {
  bootOverlayClickThrough,
  bootOverlayVisible,
  isTerminalBootPhase,
  type TerminalBootPhase
} from '@shared/terminalBoot'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'
import { shouldFocusTerminal, trackWindowFocus } from './windowFocus'
import { XTERM_THEME } from './xtermTheme'
import {
  canSubmitAnswer,
  isUserQuestion,
  overlayKeyAction,
  overlayShows,
  shouldAutofocusOverlay,
  shouldForwardKeyToPty
} from './questionOverlay'

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

/**
 * The title bar's label: the agent's Commedia code-name, then role and engine.
 *
 * The name carries its lore card here for the same reason it does in the panel
 * — this window IS "Fortuna", and the one place a user asks who that is, is the
 * bar with the name in it.
 */
function metaLabel(
  t: Translate,
  locale: Locale,
  meta: TerminalAgentMeta | null,
  agentId: string,
  task: string | undefined
): React.JSX.Element {
  if (!meta) return <span className="cli-label-dim">{agentId}</span>
  const engine = [meta.provider, meta.model].filter(Boolean).join(' ')
  return (
    <>
      <LoreTip className="cli-name" name={meta.name} blurb={metaBlurb(t, locale, meta, task)} />
      <span className="cli-label-dim">
        {' · '}
        {meta.role}
        {engine ? ` · ${engine}` : ''}
      </span>
    </>
  )
}

/**
 * Grow: four arrows pushing out of the corners. Shrink: the same four pulled
 * back in. Drawn rather than typed, because the Unicode pair for this (⤢ / ⤡)
 * is a diagonal arrow in some fonts and a blank box in others.
 */
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
 * One MCP question over xterm. Keyed by questionId so a new question remounts
 * a blank draft; Escape hides without answering (parent keeps the question).
 */
function QuestionOverlay({
  question,
  onHide,
  onSubmit
}: {
  question: TerminalQuestionInbox
  onHide(): void
  onSubmit(agentId: string, questionId: string, text: string): Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [answer, setAnswer] = useState('')
  const [answerError, setAnswerError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    // Same Windows trap as xterm: textarea.focus() activates the BrowserWindow
    // even after showInactive(). Only grab the caret when this window already
    // has the OS keyboard; a background worker overlay waits for the existing
    // window 'focus' listener.
    if (!shouldAutofocusOverlay(document.hasFocus())) return
    inputRef.current?.focus()
  }, [])

  const submit = (): void => {
    if (!canSubmitAnswer(answer)) return
    const text = answer.trim()
    void onSubmit(question.agentId, question.questionId, text).then(
      () => setAnswer(''),
      (cause: unknown) => setAnswerError(cause instanceof Error ? cause.message : String(cause))
    )
  }

  return (
    <div className="cli-question" role="dialog" aria-modal="true">
      <form
        className="cli-question-form"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        {question.fromName ? <p className="cli-question-from">{question.fromName}</p> : null}
        <p className="cli-question-text">
          {isUserQuestion(question)
            ? t('terminal.userQuestion', { question: question.question })
            : question.question}
        </p>
        <textarea
          ref={inputRef}
          className="cli-question-input"
          rows={3}
          placeholder={t('terminal.answerPlaceholder')}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => {
            const action = overlayKeyAction(event)
            if (action === 'hide') {
              event.preventDefault()
              onHide()
              return
            }
            if (action === 'submit') {
              event.preventDefault()
              submit()
            }
          }}
        />
        {answerError ? <p className="cli-question-error">{answerError}</p> : null}
        <button type="submit" className="cli-question-send" disabled={!canSubmitAnswer(answer)}>
          {t('terminal.answerSend')}
        </button>
      </form>
    </div>
  )
}

/**
 * The agent's terminal window. It owns nothing but the view: the PTY lives in
 * the main process, this attaches to it, replays the scrollback and streams.
 */
export function TerminalApp({ agentId }: { agentId: string }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const hostRef = useRef<HTMLDivElement>(null)
  const [meta, setMeta] = useState<TerminalAgentMeta | null>(null)
  const [task, setTask] = useState<string | undefined>(undefined)
  const [exit, setExit] = useState<TerminalExitEvent | { exitCode: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Mirrors the window's real state; main answers with it on every toggle. */
  const [maximized, setMaximized] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const searchRef = useRef<SearchAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [boot, setBoot] = useState<TerminalBootPhase | null>(null)
  const [question, setQuestion] = useState<TerminalQuestionInbox | null>(null)
  const [dismissedQuestionId, setDismissedQuestionId] = useState<string | null>(null)
  const overlayVisibleRef = useRef(false)
  const overlayOpen = overlayShows(question, dismissedQuestionId)

  useLayoutEffect(() => {
    overlayVisibleRef.current = overlayOpen
  }, [overlayOpen])

  // The bridge is injected by preload before the bundle runs — stable for the
  // lifetime of the window, so it is read during render, not in the effect.
  const bridge = window.vertragus?.terminal
  const close = useCallback(() => bridge?.closeWindow(), [bridge])
  const minimize = useCallback(() => bridge?.minimizeWindow(), [bridge])
  const toggleMaximize = useCallback(() => {
    void bridge?.toggleMaximizeWindow().then(setMaximized, () => undefined)
  }, [bridge])

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
    // Agent CLIs print auth and PR URLs constantly; a link that cannot be
    // clicked is a login the user retypes by hand. The default handler calls
    // window.open, which the navigation lockdown routes to shell.openExternal
    // (https/mailto only) — nothing navigates inside this window.
    term.loadAddon(new WebLinksAddon())
    const search = new SearchAddon()
    term.loadAddon(search)
    searchRef.current = search
    termRef.current = term
    // Ctrl+F belongs to the 5000-line scrollback, not to the PTY (where it is
    // merely cursor-forward). Everything else passes through untouched.
    term.attachCustomKeyEventHandler((event) => {
      if (!shouldForwardKeyToPty(overlayVisibleRef.current)) return false
      if (event.type === 'keydown' && event.key === 'f' && (event.ctrlKey || event.metaKey)) {
        setSearchOpen(true)
        return false
      }
      return true
    })
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
    const offTask = bridge.onTask((event) => setTask(event.task))
    const offBoot = bridge.onBoot((event) => {
      setBoot(isTerminalBootPhase(event.boot) ? event.boot : null)
    })
    const offQuestion = bridge.onQuestion((event) => {
      setQuestion(event.question)
    })
    const offInput = term.onData((data) => {
      if (!shouldForwardKeyToPty(overlayVisibleRef.current)) return
      bridge.input(data)
    })

    const observer = new ResizeObserver(() => applyFit())
    observer.observe(host)

    // Panel click / later OS focus after showInactive: attach skipped term.focus().
    const onWindowFocus = (): void => {
      if (disposed) return
      if (overlayVisibleRef.current) {
        document.querySelector<HTMLTextAreaElement>('textarea.cli-question-input')?.focus()
        return
      }
      if (shouldFocusTerminal(document.hasFocus())) term.focus()
    }
    window.addEventListener('focus', onWindowFocus)

    void bridge
      .attach(agentId)
      .then((result) => {
        if (disposed) return
        // CLI windows cannot query settings; locale and theme ride on the attach.
        if (result.locale) void applyLocale(result.locale)
        if (result.theme) applyTheme(result.theme)
        setMeta(result.meta)
        setTask(result.task)
        setMaximized(result.maximized)
        setBoot(isTerminalBootPhase(result.boot) ? result.boot : null)
        setQuestion(result.question ?? null)
        if (result.exit) setExit(result.exit)
        term.write(result.snapshot)
        attached = true
        for (const chunk of queued) term.write(chunk)
        queued.length = 0
        applyFit()
        // Overlay textarea takes focus; don't type the first keystroke into xterm.
        if (!result.question && shouldFocusTerminal(document.hasFocus())) term.focus()
      })
      .catch((cause: unknown) => {
        if (disposed) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })

    return () => {
      disposed = true
      window.removeEventListener('focus', onWindowFocus)
      observer.disconnect()
      offData()
      offExit()
      offTask()
      offBoot()
      offQuestion()
      offInput.dispose()
      searchRef.current = null
      termRef.current = null
      term.dispose()
    }
  }, [agentId, bridge, t])

  // The bar renders after the state flip; focus it once it exists.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    searchRef.current?.clearDecorations()
    termRef.current?.focus()
  }, [])

  const hideQuestionOverlay = useCallback(() => {
    if (question) setDismissedQuestionId(question.questionId)
    termRef.current?.focus()
  }, [question])

  const submitQuestionAnswer = useCallback(
    (agentId: string, questionId: string, text: string): Promise<void> => {
      if (!bridge?.answerQuestion) return Promise.resolve()
      return bridge.answerQuestion(agentId, questionId, text)
    },
    [bridge]
  )

  const onSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      const query = event.currentTarget.value
      if (event.key === 'Escape') {
        event.preventDefault()
        closeSearch()
        return
      }
      if (event.key !== 'Enter' || query === '') return
      event.preventDefault()
      if (event.shiftKey) searchRef.current?.findPrevious(query)
      else searchRef.current?.findNext(query)
    },
    [closeSearch]
  )

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
        <span className="cli-label">{metaLabel(t, activeLocale(i18n.language), meta, agentId, task)}</span>
        <button
          className="cli-minimize"
          onClick={minimize}
          title={t('terminal.minimizeWindow')}
          aria-label={t('terminal.minimizeWindow')}
        >
          −
        </button>
        <button
          className="cli-maximize"
          onClick={toggleMaximize}
          title={maximized ? t('terminal.restoreWindow') : t('terminal.maximizeWindow')}
          aria-label={maximized ? t('terminal.restoreWindow') : t('terminal.maximizeWindow')}
          aria-pressed={maximized}
        >
          <MaximizeGlyph maximized={maximized} />
        </button>
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
      {searchOpen ? (
        <div className="cli-search">
          <input
            ref={searchInputRef}
            className="cli-search-input"
            type="text"
            placeholder={t('terminal.searchPlaceholder')}
            onKeyDown={onSearchKeyDown}
            onChange={(event) => {
              const query = event.currentTarget.value
              if (query) searchRef.current?.findNext(query, { incremental: true })
              else searchRef.current?.clearDecorations()
            }}
          />
          <button
            className="cli-search-close"
            onClick={closeSearch}
            title={t('terminal.searchClose')}
            aria-label={t('terminal.searchClose')}
          >
            ×
          </button>
        </div>
      ) : null}
      <div className="cli-terminal" ref={hostRef} />
      {bootOverlayVisible(boot) && boot ? (
        <div
          className={`cli-boot${bootOverlayClickThrough(boot) ? ' is-waiting' : ''}`}
          role="status"
          aria-live="polite"
          aria-busy={boot !== 'waiting'}
        >
          <div className="cli-boot-hound">
            <HoundLogo size={96} hero />
          </div>
          <p className="cli-boot-status">{t(`terminal.boot.${boot}`)}</p>
        </div>
      ) : null}
      {overlayOpen && question ? (
        <QuestionOverlay
          key={question.questionId}
          question={question}
          onHide={hideQuestionOverlay}
          onSubmit={submitQuestionAnswer}
        />
      ) : null}
    </div>
  )
}
