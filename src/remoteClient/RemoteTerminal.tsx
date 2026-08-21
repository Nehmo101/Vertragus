/**
 * One agent's terminal in the browser. Reuses xterm (the same renderer the
 * desktop window uses) and the lossless snapshot-then-stream attach.
 *
 * Phones and a raw xterm keyboard do not mix — a mobile keyboard fights the
 * hidden textarea xterm relies on — so the primary input is an explicit text
 * field with a send button, plus a key row for the keys a composer needs
 * (Enter, Esc, Tab, Ctrl-C, arrows). Direct xterm typing still works on a
 * physical keyboard and is forwarded the same way.
 *
 * Two rules govern everything below, both learned from the phone being
 * unusable:
 *
 * 1. The `Terminal` is built once per `agentId` and survives every re-render.
 *    `useRemote()` hands back a fresh object each render, so an effect that
 *    depends on `api` is an effect that runs on every workspace push — and
 *    rebuilding the terminal throws away the scrollback and drops the reader
 *    back at the bottom. Everything the effect needs from props is reached
 *    through a ref instead; nothing outside `agentId` may enter its deps.
 * 2. Reading the history is a first-class job, not a side effect of xterm's
 *    viewport. `.xterm-viewport` does not pan reliably under a finger on iOS
 *    Safari, so the drag, its inertia and the page/top/end controls are ours
 *    (`terminalScroll.ts`), and new output never yanks a reader who has
 *    scrolled away from the bottom.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'
import { haptic } from './haptics'
import type { RemoteCopy } from './i18n'
import type { RemoteApi } from './useRemote'
import { bufferPlainText } from './terminalBuffer'
import { clampFontSize, localFontStore, readFontSize, writeFontSize } from './terminalFont'
import {
  flingVelocity,
  isDrag,
  linesFromPixels,
  momentumStep,
  pageScrollLines,
  pushSample,
  type TouchSample
} from './terminalScroll'

const XTERM_THEME = {
  background: 'rgba(0,0,0,0)',
  foreground: '#eae6db',
  cursor: '#cba35a',
  selectionBackground: 'rgba(203,163,90,0.3)'
}

/** Kept in sync with the `lineHeight` below: the pre-layout cell-height guess. */
const LINE_HEIGHT = 1.4

/** Decorations must be opaque hex — the addon rejects rgba(). */
const SEARCH_OPTIONS: ISearchOptions = {
  caseSensitive: false,
  decorations: {
    matchBackground: '#3f351f',
    matchOverviewRuler: '#8a6f3a',
    activeMatchBackground: '#6f5624',
    activeMatchColorOverviewRuler: '#cba35a'
  }
}

/** How long a "copied" / "copy failed" note stays on screen. */
const NOTE_MS = 2400

type IconName =
  | 'search'
  | 'close'
  | 'copy'
  | 'top'
  | 'bottom'
  | 'pageUp'
  | 'pageDown'
  | 'prev'
  | 'next'
  | 'latest'

/**
 * Inline paths rather than glyphs: the CSP forbids an icon font, and the
 * arrow characters that would do this job (⤒, ⇞) render as tofu on exactly
 * the phones this client exists for.
 */
const ICON_PATHS: Record<IconName, string> = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4.4-4.4',
  close: 'M6 6l12 12M18 6L6 18',
  copy: 'M9 9h10v10H9zM15 6H5v10',
  top: 'M5 4h14M12 20V8M7 13l5-5 5 5',
  bottom: 'M5 20h14M12 4v12M7 11l5 5 5-5',
  pageUp: 'M12 19V7M6 13l6-6 6 6',
  pageDown: 'M12 5v12M6 11l6 6 6-6',
  prev: 'M6 15l6-6 6 6',
  next: 'M6 9l6 6 6-6',
  latest: 'M12 5v13M6 12l6 6 6-6'
}

function Icon({ name }: { name: IconName }): React.JSX.Element {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={ICON_PATHS[name]} />
    </svg>
  )
}

function isCoarsePointer(): boolean {
  return window.matchMedia('(pointer: coarse)').matches
}

/**
 * Queried at the moment it matters, never cached: the JS momentum glide below
 * is the one motion in this view that no CSS rule can reach (`styles.css`
 * collapses durations and forces `scroll-behavior: auto`, neither of which
 * touches a rAF loop), and the phone's setting can be flipped from Control
 * Centre while the terminal is open.
 */
function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * The clipboard over a plain-HTTP tailnet address: `navigator.clipboard` only
 * exists in a secure context, which `http://host.ts.net` is not, so the
 * deprecated selection path is the one that actually runs on the phone.
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* Fall through to the selection path below. */
  }
  const carrier = document.createElement('textarea')
  carrier.value = text
  carrier.setAttribute('readonly', '')
  carrier.style.position = 'fixed'
  carrier.style.opacity = '0'
  carrier.style.pointerEvents = 'none'
  document.body.appendChild(carrier)
  try {
    carrier.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    carrier.remove()
  }
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
  const searchRef = useRef<SearchAddon | null>(null)
  const searchFieldRef = useRef<HTMLInputElement>(null)
  const fitFrameRef = useRef(0)
  /** Mirrors `following` for the effect: scroll handlers must not re-subscribe. */
  const followRef = useRef(true)

  const [title, setTitle] = useState(agentId)
  const [roleColor, setRoleColor] = useState('#cba35a')
  const [exited, setExited] = useState<number | null>(null)
  const [line, setLine] = useState('')
  const [fontSize, setFontSize] = useState(() => readFontSize(localFontStore()))
  const [following, setFollowing] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<{ index: number; count: number } | null>(null)
  const [note, setNote] = useState<'copied' | 'copyFailed' | null>(null)
  const [composing, setComposing] = useState(false)

  /**
   * What the long-lived effect reads from props and state, kept current
   * without becoming deps of it — `api` is a new object on every render of
   * `App`, and re-running that effect means rebuilding the terminal. The sync
   * runs before the effect below on mount because effects fire in order.
   */
  const apiRef = useRef(api)
  const copyRef = useRef(copy)
  const fontSizeRef = useRef(fontSize)
  useEffect(() => {
    apiRef.current = api
    copyRef.current = copy
  })

  /**
   * Refits are coalesced into one frame: an opening keyboard fires
   * `visualViewport`, `window` and the `ResizeObserver` within a few
   * milliseconds of each other, and `fit()` reflows the whole buffer.
   */
  const scheduleFit = useCallback((): void => {
    if (fitFrameRef.current !== 0) return
    fitFrameRef.current = window.requestAnimationFrame(() => {
      fitFrameRef.current = 0
      const term = termRef.current
      const fit = fitRef.current
      if (!term || !fit) return
      try {
        fit.fit()
      } catch {
        return /* The view is not laid out yet; the next resize will do it. */
      }
      apiRef.current.resize(agentId, term.cols, term.rows)
      // A shorter viewport must not push the newest line out of sight.
      if (followRef.current) term.scrollToBottom()
    })
  }, [agentId])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      allowTransparency: true,
      theme: XTERM_THEME,
      fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace",
      fontSize: fontSizeRef.current,
      lineHeight: LINE_HEIGHT,
      cursorBlink: false,
      scrollback: 5000
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.open(host)
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    const syncFollowing = (): void => {
      const buffer = term.buffer.active
      const atBottom = buffer.viewportY >= buffer.baseY
      if (atBottom === followRef.current) return
      followRef.current = atBottom
      setFollowing(atBottom)
    }

    /**
     * The rendered cell height, not the configured one: xterm rounds the line
     * height to device pixels, and a drag that assumes otherwise drifts away
     * from the finger over a long swipe.
     */
    const cellHeight = (): number => {
      const rows = term.element?.querySelector<HTMLElement>('.xterm-rows')
      if (rows && term.rows > 0 && rows.clientHeight > 0) return rows.clientHeight / term.rows
      return fontSizeRef.current * LINE_HEIGHT
    }

    /** False when the viewport did not move: the buffer ends here. */
    const scrollByLines = (lines: number): boolean => {
      const before = term.buffer.active.viewportY
      term.scrollLines(lines)
      // `onScroll` reports this too; syncing here as well keeps the pill
      // truthful even if a frame's worth of scrolls is coalesced away.
      syncFollowing()
      return term.buffer.active.viewportY !== before
    }

    let momentumFrame = 0
    const stopMomentum = (): void => {
      if (momentumFrame !== 0) window.cancelAnimationFrame(momentumFrame)
      momentumFrame = 0
    }
    const startMomentum = (velocity: number): void => {
      if (velocity === 0 || prefersReducedMotion()) return
      let speed = velocity
      let carry = 0
      let last = performance.now()
      const step = (now: number): void => {
        const advanced = momentumStep(speed, now - last, cellHeight(), carry)
        last = now
        speed = advanced.velocity
        carry = advanced.carry
        // Hitting either end stops the glide instead of spinning a dead rAF.
        if (advanced.lines !== 0 && !scrollByLines(advanced.lines)) speed = 0
        momentumFrame = speed === 0 ? 0 : window.requestAnimationFrame(step)
      }
      momentumFrame = window.requestAnimationFrame(step)
    }

    interface Drag {
      last: number
      travel: number
      carry: number
      samples: readonly TouchSample[]
    }
    let drag: Drag | null = null

    const onTouchStart = (event: TouchEvent): void => {
      stopMomentum()
      const touch = event.touches[0]
      // A second finger is a pinch; hand it back to the browser untouched.
      if (event.touches.length !== 1 || !touch) {
        drag = null
        return
      }
      drag = {
        last: touch.clientY,
        travel: 0,
        carry: 0,
        samples: [{ y: touch.clientY, t: event.timeStamp }]
      }
    }

    const onTouchMove = (event: TouchEvent): void => {
      if (!drag) return
      const touch = event.touches[0]
      // A finger joined mid-drag: abandon the gesture rather than fling on it.
      if (event.touches.length !== 1 || !touch) {
        drag = null
        return
      }
      const delta = touch.clientY - drag.last
      drag.last = touch.clientY
      drag.travel += Math.abs(delta)
      drag.samples = pushSample(drag.samples, { y: touch.clientY, t: event.timeStamp })
      // Below the slop this is still a tap: leave it to xterm's selection.
      if (!isDrag(drag.travel)) return
      // The listener is registered non-passively for exactly this line.
      event.preventDefault()
      const step = linesFromPixels(-delta, cellHeight(), drag.carry)
      drag.carry = step.carry
      if (step.lines !== 0) scrollByLines(step.lines)
    }

    const onTouchEnd = (event: TouchEvent): void => {
      const gesture = drag
      drag = null
      if (!gesture || !isDrag(gesture.travel)) return
      const lifted = event.changedTouches[0]
      const samples = lifted
        ? pushSample(gesture.samples, { y: lifted.clientY, t: event.timeStamp })
        : gesture.samples
      startMomentum(flingVelocity(samples))
    }

    const onTouchCancel = (): void => {
      drag = null
    }

    host.addEventListener('touchstart', onTouchStart, { passive: true })
    host.addEventListener('touchmove', onTouchMove, { passive: false })
    host.addEventListener('touchend', onTouchEnd, { passive: true })
    host.addEventListener('touchcancel', onTouchCancel, { passive: true })

    const offScroll = term.onScroll(syncFollowing)
    const offResults = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      setMatches({ index: resultIndex, count: resultCount })
    })
    const offInput = term.onData((data) => apiRef.current.sendInput(agentId, data))

    /**
     * A reconnect re-attaches and replays the whole scrollback. Without the
     * reset the phone would show the session twice over.
     */
    let snapshotWritten = false
    const detach = apiRef.current.attach(agentId, {
      onSnapshot: (snapshot, _cols, _rows, name, color) => {
        setTitle(name)
        setRoleColor(color)
        if (snapshotWritten) term.reset()
        snapshotWritten = true
        term.write(snapshot, () => {
          term.scrollToBottom()
          syncFollowing()
        })
        scheduleFit()
        if (!isCoarsePointer()) term.focus()
      },
      // No scroll call here: xterm holds the viewport where the reader put it.
      onData: (data) => term.write(data),
      onExit: (exitCode) => {
        setExited(exitCode ?? 0)
        term.write(`\r\n\x1b[90m— ${copyRef.current.terminalExit(exitCode ?? 0)} —\x1b[0m\r\n`)
      }
    })

    const observer = new ResizeObserver(() => scheduleFit())
    observer.observe(host)
    window.addEventListener('resize', scheduleFit)
    window.visualViewport?.addEventListener('resize', scheduleFit)

    return () => {
      stopMomentum()
      if (fitFrameRef.current !== 0) {
        window.cancelAnimationFrame(fitFrameRef.current)
        fitFrameRef.current = 0
      }
      observer.disconnect()
      window.removeEventListener('resize', scheduleFit)
      window.visualViewport?.removeEventListener('resize', scheduleFit)
      host.removeEventListener('touchstart', onTouchStart)
      host.removeEventListener('touchmove', onTouchMove)
      host.removeEventListener('touchend', onTouchEnd)
      host.removeEventListener('touchcancel', onTouchCancel)
      offScroll.dispose()
      offResults.dispose()
      offInput.dispose()
      detach()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
  }, [agentId, scheduleFit])

  useEffect(() => {
    fontSizeRef.current = fontSize
    writeFontSize(localFontStore(), fontSize)
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    scheduleFit()
  }, [fontSize, scheduleFit])

  useEffect(() => {
    if (note === null) return
    const timer = window.setTimeout(() => setNote(null), NOTE_MS)
    return () => window.clearTimeout(timer)
  }, [note])

  useEffect(() => {
    if (searchOpen) searchFieldRef.current?.focus()
  }, [searchOpen])

  const jumpTo = (edge: 'top' | 'bottom'): void => {
    const term = termRef.current
    if (!term) return
    if (edge === 'top') term.scrollToTop()
    else term.scrollToBottom()
    haptic('tap')
  }

  const page = (direction: -1 | 1): void => {
    const term = termRef.current
    if (!term) return
    term.scrollLines(direction * pageScrollLines(term.rows))
    haptic('tap')
  }

  const find = (direction: 'next' | 'prev'): void => {
    const addon = searchRef.current
    if (!addon || query.trim() === '') return
    const hit =
      direction === 'next'
        ? addon.findNext(query, SEARCH_OPTIONS)
        : addon.findPrevious(query, SEARCH_OPTIONS)
    // `onDidChangeResults` stays quiet when the result set did not change,
    // so a search that finds nothing has to be recorded here.
    if (!hit) setMatches({ index: -1, count: 0 })
    haptic('tap')
  }

  const closeSearch = (): void => {
    searchRef.current?.clearDecorations()
    setSearchOpen(false)
    setQuery('')
    setMatches(null)
  }

  const copyBuffer = (): void => {
    const term = termRef.current
    if (!term) return
    const buffer = term.buffer.active
    const lines: string[] = []
    for (let index = 0; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
    }
    void writeClipboard(bufferPlainText(lines)).then((ok) => {
      setNote(ok ? 'copied' : 'copyFailed')
      haptic(ok ? 'confirm' : 'warn')
    })
  }

  const sendLine = (): void => {
    api.sendInput(agentId, `${line}\r`)
    setLine('')
    // Sending is a deliberate act: the answer belongs on screen.
    termRef.current?.scrollToBottom()
    haptic('confirm')
  }

  const sendKey = (data: string): void => {
    api.sendInput(agentId, data)
    haptic('tap')
  }

  const bumpFont = (delta: number): void => {
    setFontSize((current) => clampFontSize(current + delta))
    haptic('tap')
  }

  /**
   * Keeps the software keyboard open when a key or a scroll control is
   * tapped: without this the field loses focus, the keyboard collapses and
   * the layout jumps under the finger mid-sentence.
   */
  const keepFocus = (event: React.MouseEvent): void => event.preventDefault()

  /**
   * `resultIndex` is -1 when the addon stopped counting past its highlight
   * limit — then the total is still true and worth showing on its own.
   */
  const matchDigits =
    matches === null
      ? ''
      : matches.count === 0
        ? copy.searchNoMatch
        : matches.index < 0
          ? `${matches.count}`
          : `${matches.index + 1}/${matches.count}`

  /**
   * `3/17` is the right size for a bar that also has to hold the field, and the
   * wrong thing to hear read out as "three slash seventeen". The two other
   * cases are already sentences, or a total that has nothing to be ordinal to.
   */
  const matchSpoken =
    matches !== null && matches.count > 0 && matches.index >= 0
      ? copy.searchResult(matches.index + 1, matches.count)
      : matchDigits

  return (
    <div className="terminal-view" style={{ '--role': roleColor } as React.CSSProperties}>
      <header className="terminal-header">
        <button className="back" onClick={onBack} aria-label={copy.back} type="button">
          ‹
        </button>
        <span className="terminal-title">{title}</span>
        <span
          className={`dot ${exited === null ? 'live' : 'dead'}`}
          role="img"
          aria-label={exited === null ? copy.terminalLive : copy.terminalDead}
          title={exited === null ? copy.terminalLive : copy.terminalDead}
        />
        <button
          type="button"
          className="icon-btn"
          aria-label={searchOpen ? copy.searchClose : copy.searchOpen}
          aria-expanded={searchOpen}
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
        >
          <Icon name={searchOpen ? 'close' : 'search'} />
        </button>
        <button type="button" className="icon-btn" aria-label={copy.copyBuffer} onClick={copyBuffer}>
          <Icon name="copy" />
        </button>
      </header>

      {searchOpen && (
        <form
          className="search-bar"
          role="search"
          onSubmit={(event) => {
            event.preventDefault()
            find('next')
          }}
        >
          <input
            ref={searchFieldRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setMatches(null)
            }}
            placeholder={copy.searchPlaceholder}
            aria-label={copy.searchPlaceholder}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
          />
          <span className="search-count" role="status">
            <span aria-hidden="true">{matchDigits}</span>
            <span className="terminal-sr">{matchSpoken}</span>
          </span>
          {/* Closing lives on the header toggle; the bar spends its width on
              the field, which is the part a thumb has to hit. */}
          <button
            type="button"
            aria-label={copy.searchPrev}
            onMouseDown={keepFocus}
            onClick={() => find('prev')}
          >
            <Icon name="prev" />
          </button>
          <button type="submit" aria-label={copy.searchNext} onMouseDown={keepFocus}>
            <Icon name="next" />
          </button>
        </form>
      )}

      {/* Named, so the one part of this screen with no visible label of its
          own can be found and entered deliberately. */}
      <div className="terminal-stage" role="region" aria-label={copy.terminalRegion}>
        <div className="terminal-host" ref={hostRef} />
        {!following && (
          <button type="button" className="jump-latest" onClick={() => jumpTo('bottom')}>
            <Icon name="latest" />
            {copy.jumpToLatest}
          </button>
        )}
      </div>

      {/* The state a sighted reader gets from the pill, spoken. */}
      <p className="terminal-sr" role="status">
        {following ? copy.following : copy.paused}
      </p>

      {/* Hidden while the keyboard is up: those rows are worth more as terminal. */}
      {!composing && !searchOpen && (
        <div className="nav-row" role="group" aria-label={copy.historyControls}>
          <button
            type="button"
            aria-label={copy.toTop}
            onMouseDown={keepFocus}
            onClick={() => jumpTo('top')}
          >
            <Icon name="top" />
          </button>
          <button
            type="button"
            aria-label={copy.pageUp}
            onMouseDown={keepFocus}
            onClick={() => page(-1)}
          >
            <Icon name="pageUp" />
          </button>
          <button
            type="button"
            aria-label={copy.pageDown}
            onMouseDown={keepFocus}
            onClick={() => page(1)}
          >
            <Icon name="pageDown" />
          </button>
          <button
            type="button"
            aria-label={copy.toBottom}
            onMouseDown={keepFocus}
            onClick={() => jumpTo('bottom')}
          >
            <Icon name="bottom" />
          </button>
          <span className="nav-gap" />
          <button
            type="button"
            className="font-btn"
            onMouseDown={keepFocus}
            onClick={() => bumpFont(-1)}
            aria-label={copy.fontSmaller}
          >
            A−
          </button>
          <button
            type="button"
            className="font-btn"
            onMouseDown={keepFocus}
            onClick={() => bumpFont(1)}
            aria-label={copy.fontLarger}
          >
            A+
          </button>
        </div>
      )}

      {note !== null && (
        <p className="terminal-note" role="status">
          {note === 'copied' ? copy.copyDone : copy.copyFailed}
        </p>
      )}

      <div className="key-row">
        <div className="key-scroller" role="toolbar" aria-label={copy.keyRowLabel}>
          <button type="button" onMouseDown={keepFocus} onClick={() => sendKey('\x1b')}>
            Esc
          </button>
          <button type="button" onMouseDown={keepFocus} onClick={() => sendKey('\t')}>
            Tab
          </button>
          <button type="button" onMouseDown={keepFocus} onClick={() => sendKey('\r')}>
            Enter
          </button>
          <button type="button" onMouseDown={keepFocus} onClick={() => sendKey('\x03')}>
            Ctrl-C
          </button>
          <button type="button" onMouseDown={keepFocus} onClick={() => sendKey('\x1b[D')}>
            ←
          </button>
          <button type="button" onMouseDown={keepFocus} onClick={() => sendKey('\x1b[A')}>
            ↑
          </button>
          <button type="button" onMouseDown={keepFocus} onClick={() => sendKey('\x1b[B')}>
            ↓
          </button>
          <button type="button" onMouseDown={keepFocus} onClick={() => sendKey('\x1b[C')}>
            →
          </button>
        </div>
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
          onFocus={() => setComposing(true)}
          onBlur={() => setComposing(false)}
          placeholder={copy.terminalInput}
          aria-label={copy.terminalInput}
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
