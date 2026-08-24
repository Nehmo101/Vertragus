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
 * Four rules govern everything below, all four learned from the phone being
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
 *    Safari *as a native overflow box*, so the drag, its inertia and the
 *    page/top/end controls are ours (`terminalScroll.ts`). Writing
 *    `scrollTop` 1:1 is necessary but not sufficient: xterm's scroll listener
 *    sets `ydisp = round(scrollTop / cellHeight)` and the next rAF snaps
 *    `scrollTop` back to a whole row, so a slow drag that never crosses half
 *    a cell in one frame still does nothing. The drag therefore keeps the
 *    real pixel position itself (`desiredTop`), writes the line-aligned
 *    `scrollTop` xterm will accept, and shifts `.xterm-screen` by the
 *    sub-row remainder so the paint follows the finger inside a cell.
 *    Because xterm binds its own touch scrolling to an element *inside* this
 *    host, "ours" has to be taken rather than assumed. See the capture-phase
 *    listeners in the effect below.
 * 3. Nothing moves the reader's viewport unless the reader asked for it. New
 *    output never yanks a paused reader, and neither does a reconnect: the
 *    phone reconnects routinely by design, and re-attaching continues the
 *    terminal that is already on screen instead of rebuilding it
 *    (`terminalAttach.ts`).
 * 4. The PTY belongs to the session, not to this phone. A software keyboard
 *    or an A+/A− tap changes what *this* screen shows and must never reach the
 *    host, because the desktop window is attached to the same PTY and a
 *    `resize` repaints the agent's TUI there too (`terminalResize.ts`).
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
import { attachScroll, planAttach, trackWritten } from './terminalAttach'
import { safeRoleColor } from './viewModel'
import { bufferPlainText, unwrapRows, type BufferRow } from './terminalBuffer'
import { clampFontSize, localFontStore, readFontSize, writeFontSize } from './terminalFont'
import { viewportDisplacementPx } from './revealPolicy'
import { hostResize, isTransientViewport, type TerminalSize } from './terminalResize'
import {
  applyFingerDelta,
  applyWheelDelta,
  bufferCanScroll,
  clampScrollTop,
  COMPACT_MAX_WIDTH_PX,
  flingVelocity,
  isCompactChrome,
  isDrag,
  maxScrollTop,
  momentumStepPixels,
  OVERSCAN_ROWS,
  overscanRowCount,
  pageScrollLines,
  pushSample,
  splitScrollPx,
  subrowTransform,
  viewportCanScroll,
  wheelDeltaPx,
  type TouchSample
} from './terminalScroll'

const XTERM_THEME = {
  background: 'rgba(0,0,0,0)',
  foreground: '#eae6db',
  cursor: '#cba35a',
  selectionBackground: 'rgba(203,163,90,0.3)'
}

/**
 * The role tint until a snapshot names one — and again if a snapshot names
 * something that is not a colour. `safeRoleColor` is the same guard `App.tsx`
 * puts in front of the same wire value: it reaches a style attribute, and a
 * style attribute is not a place to put a string off a socket unchecked.
 */
const DEFAULT_ROLE_COLOR = '#cba35a'

/**
 * xterm's `lineHeight` multiplier, and nothing more. It is deliberately not
 * used as a cell-height estimate: xterm's real cell height is
 * `floor(ceil(measuredCharHeight × dpr) × lineHeight) / dpr`, and the measured
 * character height is 1.2–1.35 × the font size, so `fontSize × LINE_HEIGHT`
 * runs about 20 % short. The drag measures the rendered height instead and
 * banks its pixels until it can.
 */
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
  | 'keys'

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
  latest: 'M12 5v13M6 12l6 6 6-6',
  keys: 'M3 7h18v11H3zM6 10h2v2H6zm4 0h2v2h-2zm4 0h2v2h-2zm4 0h1v2h-1zM6 14h12'
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

/** Coarse pointer, or a window that is a phone in all but name. */
function compactChromeNow(): boolean {
  return isCompactChrome({
    coarse: isCoarsePointer(),
    widthPx: window.innerWidth
  })
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
 * How far the visible viewport is displaced inside the layout viewport, right
 * now. Sampled at the moment of the fit rather than during render, because the
 * event this exists to catch — a keyboard raised by a tap on the terminal
 * output — changes nothing this component renders on, so a value read during
 * render would always be the one from before the keyboard.
 */
function viewportDisplacement(): number {
  const viewport = window.visualViewport
  if (!viewport) return 0
  return viewportDisplacementPx({
    innerHeight: window.innerHeight,
    height: viewport.height,
    offsetTop: viewport.offsetTop
  })
}

/**
 * The clipboard on a plain-HTTP tailnet address, and why it is built the way
 * it is.
 *
 * `navigator.clipboard` exists only in a secure context, and `http://host.ts.net`
 * is not one. So `execCommand('copy')` is not a fallback here — on the phone it
 * is the only path that ever runs, and it has to be right.
 *
 * What that command copies is the *frame's* selection, and there are exactly
 * two ways to hand it one:
 *
 *  - a DOM `Range` over rendered text. This is what a reader's own long-press
 *    produces, it needs no focus, and the engine asks only that the selection
 *    be a non-collapsed range outside a password field.
 *  - a text control's own selection, which becomes the frame's selection only
 *    while that control has focus. `setSelectionRange()` on an unfocused
 *    `<textarea>` writes two numbers onto the element and nothing else — which
 *    is why the familiar recipe works (`select()` focuses as a side effect)
 *    and why replacing `select()` with `setSelectionRange()` alone breaks it.
 *
 * The two do not compose. `range.selectNodeContents(textarea)` selects the
 * textarea's light-DOM child text node, which has no renderer: an empty
 * selection that copies nothing, and that *replaces* a good one. So each
 * attempt below uses one mechanism and only one.
 *
 * `contentEditable` belongs to the text-control case alone. It is in the
 * circulated iOS recipe because iOS refused to select inside a `readonly`
 * field — a plain element needs nothing of the sort. And setting it and then
 * unsetting it before the copy, as that recipe does, is the flakiest part of
 * it: changing `contentEditable` rebuilds WebKit's editing state and takes the
 * selection with it. The rule here is that nothing touches a carrier between
 * installing its selection and invoking the copy.
 *
 * None of which decides what actually lands on the clipboard, because the
 * `copy` handler below does, by writing the text into `clipboardData` itself.
 * The selection's only remaining job is to make the copy command *enabled* so
 * that the event fires at all. That is also what makes the answer honest: a
 * copy nobody handled did not happen, and this reports it rather than
 * returning a cheerful `true` over an empty clipboard.
 */

/**
 * Run the copy command with a handler that supplies the payload, and answer
 * whether the clipboard really took it.
 */
function copyThroughEvent(text: string): boolean {
  let handled = false
  const onCopy = (event: ClipboardEvent): void => {
    handled = true
    // No `clipboardData`: leave the default alone. It serialises the selection
    // this was called with, which is the carrier's own text — the carriers
    // below are built so that both outcomes are the same string.
    if (!event.clipboardData) return
    event.clipboardData.setData('text/plain', text)
    event.preventDefault()
  }
  // Listening for the length of one synchronous call, so no copy of the
  // reader's own can land inside the window where this is registered.
  document.addEventListener('copy', onCopy)
  try {
    // `execCommand` dispatches the event synchronously, so `handled` is
    // settled by the time it returns. A disabled command — nothing selected —
    // returns false, and that is the case worth reporting.
    return document.execCommand('copy') && handled
  } catch {
    return false
  } finally {
    document.removeEventListener('copy', onCopy)
  }
}

/** A 1×1 box at a defined position: out of the way, and genuinely rendered. */
function placeCarrier(carrier: HTMLElement): void {
  carrier.setAttribute('aria-hidden', 'true')
  const style = carrier.style
  // `position: fixed` with no offsets leaves the element wherever static flow
  // would have put it — often below the fold, which iOS then scrolls to.
  style.position = 'fixed'
  style.top = '0'
  style.left = '0'
  style.width = '1px'
  style.height = '1px'
  style.padding = '0'
  style.border = 'none'
  style.outline = 'none'
  style.boxShadow = 'none'
  style.background = 'transparent'
  // Clipped, never hidden: `opacity: 0`, `visibility: hidden` and
  // `display: none` all take the renderer away, and text with no renderer is
  // text with nothing to select.
  style.overflow = 'hidden'
  // Under 16px iOS zooms the page the instant a field takes focus.
  style.fontSize = '16px'
  // `styles.css` turns selection off on buttons only, and nothing on <body>
  // reaches this element today. Saying it here means nothing has to keep on
  // not reaching it.
  style.setProperty('-webkit-user-select', 'text')
  style.setProperty('user-select', 'text')
}

/**
 * First attempt: a plain, non-editable element and a `Range` over its text.
 * Nothing is focused, so no keyboard rises, no field is blurred, the page does
 * not zoom, and there is no `readonly` to fight because there is no text
 * control to be read-only.
 */
function copyFromRange(text: string): boolean {
  const selection = window.getSelection()
  if (!selection) return false
  const carrier = document.createElement('div')
  placeCarrier(carrier)
  // The default serialisation of this selection is the answer for an engine
  // that fires `copy` without a `clipboardData`, so the newlines have to
  // survive as newlines rather than collapse into spaces.
  carrier.style.whiteSpace = 'pre'
  carrier.textContent = text
  document.body.appendChild(carrier)
  try {
    const range = document.createRange()
    range.selectNodeContents(carrier)
    selection.removeAllRanges()
    selection.addRange(range)
    return copyThroughEvent(text)
  } catch {
    return false
  } finally {
    // The carrier leaves with its selection. A range over a removed node is
    // dead anyway; clearing it keeps a stale highlight off the page.
    selection.removeAllRanges()
    carrier.remove()
  }
}

/**
 * Second attempt, and the reason there is one: this is the recipe every engine
 * has been tested against for a decade. It costs a focus — the one thing the
 * first attempt avoids — so it runs only when the first came back false.
 *
 * No `readonly`. A read-only field is the documented way to keep iOS's
 * keyboard down and the documented reason iOS then refuses to select the
 * field's text. The keyboard is answered instead by the element being gone and
 * focus being handed back before this task ends, which is before the keyboard
 * would have been raised.
 */
function copyFromTextarea(text: string): boolean {
  const carrier = document.createElement('textarea')
  placeCarrier(carrier)
  carrier.value = text
  document.body.appendChild(carrier)
  try {
    carrier.focus({ preventScroll: true })
    // `select()` is focus-and-select in both engines, and it is the call the
    // rewrite before this one dropped. The explicit range is its belt: the
    // textarea normalises line endings, so the length comes from the value it
    // ended up holding rather than from the string that was handed in.
    carrier.select()
    carrier.setSelectionRange(0, carrier.value.length)
    return copyThroughEvent(text)
  } catch {
    return false
  } finally {
    carrier.remove()
  }
}

async function writeClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      /* Fall through — but note this one crosses a microtask boundary, so
         WebKit's "inside a user gesture" check may already have lapsed. On the
         deployment that matters `navigator.clipboard` is undefined and the
         path below is reached with no `await` in between, which is the case
         this is written for. */
    }
  }
  // Whatever the reader was typing in, handed back at the end: the second
  // attempt takes focus, and a composer left blurred mid-sentence collapses
  // the keyboard and reflows the column under the thumb.
  const active = document.activeElement
  const restore = active instanceof HTMLElement ? active : null
  const field =
    restore instanceof HTMLInputElement || restore instanceof HTMLTextAreaElement ? restore : null
  const caret =
    field && field.selectionStart !== null && field.selectionEnd !== null
      ? { start: field.selectionStart, end: field.selectionEnd }
      : null
  try {
    // Least invasive first. Both attempts are synchronous, so both are still
    // inside the tap that asked for them.
    return copyFromRange(text) || copyFromTextarea(text)
  } finally {
    if (restore) restore.focus({ preventScroll: true })
    if (field && caret) {
      try {
        // Focusing re-installs a control's own selection as the frame's, so
        // the caret has to be put back rather than left wherever clearing the
        // carrier's selection left it.
        field.setSelectionRange(caret.start, caret.end)
      } catch {
        /* Not every input type has a selection to restore; the focus above is
           the part that mattered. */
      }
    }
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
  const [roleColor, setRoleColor] = useState(DEFAULT_ROLE_COLOR)
  const [exited, setExited] = useState<number | null>(null)
  const [line, setLine] = useState('')
  const [fontSize, setFontSize] = useState(() => readFontSize(localFontStore()))
  const [following, setFollowing] = useState(true)
  const [atTop, setAtTop] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<{ index: number; count: number } | null>(null)
  /**
   * Carries a sequence number, not just a kind: a second copy while the first
   * note is still up must restart the 2400 ms timer, and `setNote('copied')`
   * over `'copied'` is a no-op React never re-runs the effect for.
   */
  const [note, setNote] = useState<{ kind: 'copied' | 'copyFailed'; seq: number } | null>(null)
  const noteSeq = useRef(0)
  const [composing, setComposing] = useState(false)
  /**
   * Control keys cost a 44 px strip the terminal is hungrier for. A phone
   * starts with them folded so reading is the full stage; focusing the
   * composer unfolds them (the keyboard is already up). A laptop has room and
   * a physical keyboard, so they start open. The header toggle is the way to
   * reach Esc / Ctrl-C without opening the composer.
   */
  const [keysOverride, setKeysOverride] = useState<boolean | null>(null)
  const [compact, setCompact] = useState(() => compactChromeNow())
  /**
   * Compact chrome folds the keys until the reader asks. A laptop always has
   * room, so the default follows `compact` instead of a layout effect — that
   * effect was `setState` in the body, which eslint rejects as a cascading
   * render. Once the reader hits the toggle, `keysOverride` is the source.
   */
  const keysOpen = keysOverride ?? !compact

  /**
   * What the long-lived effect reads from props and state, kept current
   * without becoming deps of it — `api` is a new object on every render of
   * `App`, and re-running that effect means rebuilding the terminal. The sync
   * runs before the effect below on mount because effects fire in order.
   */
  const apiRef = useRef(api)
  const copyRef = useRef(copy)
  const agentIdRef = useRef(agentId)
  const fontSizeRef = useRef(fontSize)
  /**
   * One of this view's own fields has focus. Half of the transient test — the
   * half that is true before the viewport has moved. The other half is
   * measured at fit time, because a keyboard raised by a tap on the output
   * sets no flag here at all; `isTransientViewport` weighs the two.
   */
  const ownFieldRef = useRef(false)
  useEffect(() => {
    apiRef.current = api
    copyRef.current = copy
    agentIdRef.current = agentId
    ownFieldRef.current = composing || searchOpen
  })

  useEffect(() => {
    const query = window.matchMedia(
      `(pointer: coarse), (max-width: ${COMPACT_MAX_WIDTH_PX}px)`
    )
    const update = (): void => setCompact(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  /** The size this client last asked the host for; reset with the terminal. */
  const sentSizeRef = useRef<TerminalSize | undefined>(undefined)
  /** True while every refit queued for the next frame is a font change. */
  const localFitRef = useRef(false)
  /**
   * Pixel position the gesture owns, shared with the coalesced fit so a
   * cell-height change can drop it instead of painting a remainder measured
   * against the old cell.
   */
  const desiredTopRef = useRef<number | undefined>(undefined)

  /**
   * Refits are coalesced into one frame: an opening keyboard fires
   * `visualViewport`, `window` and the `ResizeObserver` within a few
   * milliseconds of each other, and `fit()` reflows the whole buffer.
   *
   * The cause travels with the request because it decides whether the host
   * hears about the result. A frame opened by a font tap stays local; one real
   * viewport change anywhere in the same frame outranks it.
   */
  const requestFit = useCallback((cause: 'viewport' | 'font'): void => {
    if (cause === 'viewport') localFitRef.current = false
    else if (fitFrameRef.current === 0) localFitRef.current = true
    if (fitFrameRef.current !== 0) return
    fitFrameRef.current = window.requestAnimationFrame(() => {
      fitFrameRef.current = 0
      const local = localFitRef.current
      localFitRef.current = false
      const term = termRef.current
      const fit = fitRef.current
      if (!term || !fit) return
      // Asked, not caught: `FitAddon.fit()` returns *silently* when the view is
      // not laid out, so a try/catch around it guards a path that cannot happen
      // while xterm's untouched 80×24 goes to the host behind it.
      const fitted = fit.proposeDimensions()
      if (fitted) {
        fit.fit()
        // One extra local row, clipped by `.terminal-host { overflow: hidden }`.
        // The sub-row translate can then reveal the next line; without this
        // `.xterm-screen` is exactly `rows` tall and the remainder is a gap.
        if (term.rows >= 1) term.resize(term.cols, overscanRowCount(term.rows))
      }
      // A leftover sub-row translate was measured against the previous cell
      // height; drop it. The next gesture re-splits against the new cell.
      desiredTopRef.current = undefined
      const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
      if (screen) screen.style.transform = 'none'
      const size = hostResize({
        fitted,
        sent: sentSizeRef.current,
        local,
        transient: isTransientViewport({
          coarse: isCoarsePointer(),
          ownField: ownFieldRef.current,
          displacement: viewportDisplacement()
        })
      })
      if (size) {
        sentSizeRef.current = size
        apiRef.current.resize(agentIdRef.current, size.cols, size.rows)
      }
      // A shorter viewport must not push the newest line out of sight.
      if (followRef.current) term.scrollToBottom()
    })
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    sentSizeRef.current = undefined
    localFitRef.current = false
    const term = new Terminal({
      allowTransparency: true,
      theme: XTERM_THEME,
      // Stated here rather than read from `--font-mono` in `styles.css`, which
      // says the same list. xterm wants a font *string* at construction, so
      // consuming the token means `getComputedStyle`, and an empty answer —
      // the sheet not applied yet, or not applied at all — does not fall back
      // to this list: it falls back to xterm's own `courier-new`, whose cell
      // is a different width, which is a wrong `cols` sent to a PTY the
      // desktop shares. A literal cannot come back empty. The duplicate is the
      // cheaper of the two risks, and it is a duplicate of one line.
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

    /**
     * xterm parks a hidden textarea at the cursor to receive key events, and
     * focuses it from its own `mousedown` handler. On a phone that means every
     * tap on the output opens the software keyboard: the visual viewport
     * halves, the terminal refits to about twelve rows, and — before the rules
     * in `terminalResize.ts` — those twelve rows went to the shared PTY and
     * repainted the agent's TUI on the desktop as well.
     *
     * `inputmode="none"` is the narrowest instrument that stops it. The
     * textarea stays focusable, so xterm's focus tracking, its selection and a
     * hardware keyboard on a tablet all keep working; only the on-screen
     * keyboard, which this view replaces with its own composer, stays down.
     *
     * WebKit has only honoured the attribute since Safari 16.4, though, and
     * this client is reached from whatever phone the reader has. So it is not
     * allowed to be the only thing standing there: `isTransientViewport`
     * measures the viewport at every fit, and a keyboard that comes up here
     * anyway is caught by the measurement rather than by a flag this view sets
     * about its own fields. Both are pinned in `RemoteTerminal.test.ts`.
     */
    if (isCoarsePointer()) term.textarea?.setAttribute('inputmode', 'none')

    /** Set before disposal: a queued `write` callback must not touch a corpse. */
    let disposed = false

    const syncFollowing = (): void => {
      const buffer = term.buffer.active
      const atBottom = buffer.viewportY >= buffer.baseY
      const atStart = buffer.viewportY <= 0
      if (atBottom !== followRef.current) {
        followRef.current = atBottom
        setFollowing(atBottom)
      }
      setAtTop(atStart)
    }

    /**
     * The rendered cell height, not the configured one: xterm rounds the line
     * height to device pixels, and a wheel in `deltaMode: 1` (lines) has to
     * spend them at that scale. Zero rather than a guess when there is nothing
     * to measure — `wheelDeltaPx` falls back to a 16 px line instead.
     */
    const cellHeight = (): number => {
      const rows = term.element?.querySelector<HTMLElement>('.xterm-rows')
      if (rows && term.rows > 0 && rows.clientHeight > 0) return rows.clientHeight / term.rows
      return 0
    }

    /**
     * xterm's real scroller. We write a *line-aligned* `scrollTop` so its
     * `round(scrollTop / cellHeight)` matches `floor(desired / cellHeight)`
     * and the rAF snap-back does not fight us; the sub-row remainder lives
     * on `.xterm-screen` as a transform (see `paintScroll`).
     */
    const viewportEl = (): HTMLElement | null =>
      term.element?.querySelector('.xterm-viewport') ?? null

    const screenEl = (): HTMLElement | null =>
      term.element?.querySelector('.xterm-screen') ?? null

    /** Is there any history under this gesture for a drag to move? */
    const canScroll = (): boolean => {
      const buffer = term.buffer.active
      if (buffer.type === 'alternate') return false
      const port = viewportEl()
      if (port && viewportCanScroll(port)) return true
      return bufferCanScroll({ alternate: false, baseY: buffer.baseY })
    }

    let painting = false
    let lastYdisp = term.buffer.active.viewportY

    const readTop = (): number => {
      const port = viewportEl()
      if (desiredTopRef.current !== undefined) return desiredTopRef.current
      return port?.scrollTop ?? 0
    }

    const clearSubrow = (): void => {
      desiredTopRef.current = undefined
      const screen = screenEl()
      if (screen) screen.style.transform = 'none'
    }

    /** Paint `next` as line-aligned scrollTop plus a sub-row screen shift. */
    const paintScroll = (next: number): void => {
      const port = viewportEl()
      if (!port) return
      const max = maxScrollTop(port.scrollHeight, port.clientHeight)
      const clamped = clampScrollTop(next, max)
      const cell = cellHeight()
      if (cell <= 0) {
        // Pre-layout: do not write an unaligned scrollTop xterm will snap.
        desiredTopRef.current = clamped
        return
      }
      const split = splitScrollPx(clamped, cell)
      desiredTopRef.current = clamped
      const screen = screenEl()
      if (screen) screen.style.transform = subrowTransform(split.remainderPx)
      painting = true
      if (port.scrollTop !== split.lineTop) port.scrollTop = split.lineTop
      painting = false
      lastYdisp = term.buffer.active.viewportY
      // `onScroll` reports a line change; syncing here keeps the pill
      // truthful when only the remainder moved.
      syncFollowing()
    }

    let momentumFrame = 0
    const stopMomentum = (): void => {
      if (momentumFrame !== 0) window.cancelAnimationFrame(momentumFrame)
      momentumFrame = 0
    }
    const startMomentum = (velocity: number): void => {
      if (velocity === 0 || prefersReducedMotion()) return
      let speed = velocity
      let last = performance.now()
      const step = (now: number): void => {
        const port = viewportEl()
        if (!port) {
          momentumFrame = 0
          return
        }
        const advanced = momentumStepPixels(
          speed,
          now - last,
          readTop(),
          maxScrollTop(port.scrollHeight, port.clientHeight)
        )
        last = now
        speed = advanced.velocity
        if (advanced.moved) paintScroll(advanced.scrollTop)
        // Hitting either end stops the glide instead of spinning a dead rAF.
        momentumFrame = speed === 0 ? 0 : window.requestAnimationFrame(step)
      }
      momentumFrame = window.requestAnimationFrame(step)
    }

    interface Drag {
      last: number
      travel: number
      samples: readonly TouchSample[]
    }
    let drag: Drag | null = null

    const onTouchStart = (event: TouchEvent): void => {
      stopMomentum()
      const touch = event.touches[0]
      // A second finger is a pinch; hand it back to the browser untouched.
      // Nothing to scroll — the alternate screen, a session that has not filled
      // one screen — is left alone too: consuming a gesture we cannot answer
      // makes the screen read as hung. Do not stopPropagation in those cases:
      // xterm's own handler (TUI mouse, selection) is the one that should run.
      if (event.touches.length !== 1 || !touch || !canScroll()) {
        drag = null
        return
      }
      event.stopPropagation()
      drag = {
        last: touch.clientY,
        travel: 0,
        samples: [{ y: touch.clientY, t: event.timeStamp }]
      }
    }

    const onTouchMove = (event: TouchEvent): void => {
      if (!drag) return
      event.stopPropagation()
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
      const port = viewportEl()
      if (!port) return
      const max = maxScrollTop(port.scrollHeight, port.clientHeight)
      // Nothing to move: do not spend preventDefault on a hung screen.
      if (max <= 0) return
      // Still paint if Safari already marked the move non-cancelable: returning
      // here was a dead finger (no JS pan, and pinch-zoom grants no native one).
      if (event.cancelable) event.preventDefault()
      const next = applyFingerDelta(readTop(), delta, max)
      if (next.moved) paintScroll(next.scrollTop)
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

    /**
     * Trackpads and mice send `wheel`, not touch. xterm already listens, but
     * our capture-phase touch handlers do not cover it, and on a laptop the
     * complaint was the same as on the phone: the stage does not pan. Driving
     * `scrollTop` here is the same path the finger takes, so a pixel-mode
     * trackpad (deltaMode 0) moves 1:1 and a line-mode mouse (deltaMode 1)
     * spends whole cells. Ctrl-wheel is the browser's zoom and is left alone.
     */
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey) {
        // Stop xterm seeing this: its handleWheel preventDefault's a ctrl-wheel
        // and that is what cancels the browser's zoom. We do not preventDefault.
        event.stopPropagation()
        return
      }
      const port = viewportEl()
      if (!port || !canScroll()) return
      const delta = wheelDeltaPx(event, cellHeight())
      if (delta === 0) return
      const next = applyWheelDelta(
        readTop(),
        delta,
        maxScrollTop(port.scrollHeight, port.clientHeight)
      )
      if (!next.moved) return
      event.preventDefault()
      event.stopPropagation()
      paintScroll(next.scrollTop)
    }

    /*
     * Capture, and `stopPropagation` on both of the events xterm listens for.
     *
     * `bindMouse()` registers xterm's own `touchstart`/`touchmove` on
     * `term.element` — the `.xterm` div that `open(host)` appends *inside* this
     * host — and there is no opt-out: `attachCustomWheelEventHandler` covers the
     * wheel and has no touch counterpart, and `cancelEvents` is off, so xterm's
     * `cancel()` neither prevents nor stops anything. On the bubble phase our
     * listeners therefore ran *second*, on a viewport xterm had already moved:
     * `Viewport.handleTouchMove` does `scrollTop += rawDelta` with no slop, no
     * carry and no second-finger check, and the DOM `scroll` event that follows
     * sets ydisp *absolutely* to `round(scrollTop / cellHeight)`. Every carried
     * value `terminalScroll.ts` computed was overwritten by xterm's rounding
     * one event later, a 3 px wobble during a long press scrolled, and a
     * two-finger pinch scrolled the buffer.
     *
     * Capturing at the host and stopping there means those handlers never run.
     * It costs nothing else: `stopPropagation` does not cancel a default
     * action, so the browser's own pinch-zoom, the long-press callout and the
     * synthetic mouse events xterm's selection is built on all still happen.
     * The drag itself writes a line-aligned `scrollTop` plus a sub-row
     * transform, so xterm's rounding is a follower of `desiredTop`, not the
     * owner of the position.
     */
    const captured = { capture: true } as const
    host.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
    host.addEventListener('touchmove', onTouchMove, { capture: true, passive: false })
    host.addEventListener('touchend', onTouchEnd, { capture: true, passive: true })
    host.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: true })
    host.addEventListener('wheel', onWheel, { capture: true, passive: false })

    const offScroll = term.onScroll(() => {
      syncFollowing()
      const ydisp = term.buffer.active.viewportY
      // An outside scroll (jump-to-top, page buttons, live follow) must
      // drop the sub-row shift; one we just painted must keep it.
      if (!painting && ydisp !== lastYdisp) {
        clearSubrow()
      }
      lastYdisp = ydisp
    })
    const offResults = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      setMatches({ index: resultIndex, count: resultCount })
    })
    const offInput = term.onData((data) => apiRef.current.sendInput(agentIdRef.current, data))

    /**
     * The tail of the host's byte stream as written so far, and the marker a
     * re-attach aligns on. Only host bytes go in here: the exit banner below is
     * this client's own text, and letting it into the tail would make the next
     * snapshot look like a different session.
     */
    let written = ''
    let exitBannerShown = false
    const writeExitBanner = (exitCode: number): void => {
      if (exitBannerShown) return
      exitBannerShown = true
      term.write(`\r\n\x1b[90m— ${copyRef.current.terminalExit(exitCode)} —\x1b[0m\r\n`)
    }

    const detach = apiRef.current.attach(agentId, {
      /**
       * A reconnect is the same stream seen again from further back, not a new
       * session — see `terminalAttach.ts`. The plan says whether this snapshot
       * continues the terminal on screen (the normal case, in which the local
       * buffer, the alternate screen and the reader's place all survive) or
       * whether the two streams diverged far enough that a rebuild is earned.
       *
       * `exitCode` arrives as `undefined` from a gateway that does not forward
       * it yet; that is "no news", not "still running".
       */
      onSnapshot: (snapshot, _cols, _rows, name, color, exitCode?: number | null) => {
        setTitle(name)
        setRoleColor(safeRoleColor(color) ?? DEFAULT_ROLE_COLOR)
        const plan = planAttach({ snapshot, written })
        if (plan.kind === 'replay') {
          term.reset()
          written = ''
          exitBannerShown = false
        }
        written = trackWritten(written, plan.data)
        const scroll = attachScroll(plan, followRef.current)
        term.write(plan.data, () => {
          if (disposed) return
          if (scroll === 'bottom') term.scrollToBottom()
          syncFollowing()
        })
        if (exitCode !== undefined) {
          setExited(exitCode)
          // Re-drawn after a rebuild: `reset()` erased the banner a previous
          // `onExit` wrote, and the bridge never re-fires `exit` for a PTY that
          // was already dead when this client attached.
          if (exitCode !== null) writeExitBanner(exitCode)
        }
        requestFit('viewport')
        if (!isCoarsePointer()) term.focus()
      },
      // No scroll call here: xterm holds the viewport where the reader put it.
      onData: (data) => {
        written = trackWritten(written, data)
        term.write(data)
      },
      onExit: (exitCode) => {
        setExited(exitCode ?? 0)
        writeExitBanner(exitCode ?? 0)
      }
    })

    const onViewportChange = (): void => requestFit('viewport')
    const observer = new ResizeObserver(onViewportChange)
    observer.observe(host)
    window.addEventListener('resize', onViewportChange)
    window.visualViewport?.addEventListener('resize', onViewportChange)

    return () => {
      disposed = true
      desiredTopRef.current = undefined
      stopMomentum()
      if (fitFrameRef.current !== 0) {
        window.cancelAnimationFrame(fitFrameRef.current)
        fitFrameRef.current = 0
      }
      observer.disconnect()
      window.removeEventListener('resize', onViewportChange)
      window.visualViewport?.removeEventListener('resize', onViewportChange)
      host.removeEventListener('touchstart', onTouchStart, captured)
      host.removeEventListener('touchmove', onTouchMove, captured)
      host.removeEventListener('touchend', onTouchEnd, captured)
      host.removeEventListener('touchcancel', onTouchCancel, captured)
      host.removeEventListener('wheel', onWheel, captured)
      offScroll.dispose()
      offResults.dispose()
      offInput.dispose()
      detach()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
  }, [agentId, requestFit])

  /** False until the reader has actually moved the size off its stored value. */
  const fontAppliedRef = useRef(false)
  useEffect(() => {
    fontSizeRef.current = fontSize
    // Not on mount. The terminal is constructed with this size already, and
    // opening a terminal must not write back a preference nobody expressed —
    // nor spend the first fit, the one the host is waiting for, on a font.
    if (!fontAppliedRef.current) {
      fontAppliedRef.current = true
      return
    }
    writeFontSize(localFontStore(), fontSize)
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    requestFit('font')
  }, [fontSize, requestFit])

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
    term.scrollLines(direction * pageScrollLines(Math.max(1, term.rows - OVERSCAN_ROWS)))
    haptic('tap')
  }

  const find = (direction: 'next' | 'prev'): void => {
    const addon = searchRef.current
    if (!addon || query.trim() === '') return
    // Both calls end in `_fireResults`, and `SEARCH_OPTIONS` sets the
    // `decorations` that gate it, so `onDidChangeResults` reports every call
    // including one that matches nothing. The counter needs nothing from here.
    if (direction === 'next') addon.findNext(query, SEARCH_OPTIONS)
    else addon.findPrevious(query, SEARCH_OPTIONS)
    haptic('tap')
  }

  const closeSearch = (): void => {
    searchRef.current?.clearDecorations()
    setSearchOpen(false)
    setQuery('')
    setMatches(null)
  }

  const showNote = (kind: 'copied' | 'copyFailed'): void => {
    noteSeq.current += 1
    setNote({ kind, seq: noteSeq.current })
  }

  const copyBuffer = (): void => {
    const term = termRef.current
    if (!term) return
    // The *normal* buffer, never `active`. While a full-screen TUI holds the
    // alternate screen, `active` is one screenful with no history behind it,
    // and "copy the history" must not quietly mean "copy one screen".
    const buffer = term.buffer.normal
    const rows: BufferRow[] = []
    for (let index = 0; index < buffer.length; index += 1) {
      const row = buffer.getLine(index)
      // Untrimmed, and carrying the wrap flag: a row that is continued is full
      // by definition, so trimming it here would eat the spaces at the wrap
      // point. `unwrapRows` rejoins first, `bufferPlainText` trims after — which
      // is the difference between pasting a stack trace and pasting the phone's
      // 38-column fragments of one.
      rows.push({
        text: row?.translateToString(false) ?? '',
        wrapped: row?.isWrapped ?? false
      })
    }
    void writeClipboard(bufferPlainText(unwrapRows(rows))).then((ok) => {
      showNote(ok ? 'copied' : 'copyFailed')
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
   * Keeps the software keyboard open when a control is tapped while the
   * composer has it: without this the field loses focus, the keyboard
   * collapses and the layout jumps under the finger mid-sentence.
   *
   * It belongs on every control that is *reachable* with the keyboard up — the
   * key row, the search bar, the header, the jump-to-latest pill. Not on the
   * history row below: that row renders only while nothing is focused, so a
   * `keepFocus` there would guard a keyboard that is already down.
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

  const viewClass = [
    'terminal-view',
    keysOpen ? 'is-keys-open' : '',
    composing ? 'is-composing' : '',
    searchOpen ? 'is-search-open' : '',
    compact ? 'is-compact' : ''
  ]
    .filter((name) => name !== '')
    .join(' ')

  return (
    <div className={viewClass} style={{ '--role': roleColor } as React.CSSProperties}>
      <header className="terminal-header">
        <button
          className="back"
          onMouseDown={keepFocus}
          onClick={onBack}
          aria-label={copy.back}
          type="button"
        >
          ‹
        </button>
        <span className="terminal-title">{title}</span>
        <span
          className={`dot ${exited === null ? 'live' : 'dead'}`}
          role="img"
          aria-label={exited === null ? copy.terminalLive : copy.terminalDead}
          title={exited === null ? copy.terminalLive : copy.terminalDead}
        />
        <div className="header-tools">
          <button
            type="button"
            className="icon-btn"
            aria-label={searchOpen ? copy.searchClose : copy.searchOpen}
            aria-expanded={searchOpen}
            onMouseDown={keepFocus}
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          >
            <Icon name={searchOpen ? 'close' : 'search'} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={copy.copyBuffer}
            onMouseDown={keepFocus}
            onClick={copyBuffer}
          >
            <Icon name="copy" />
          </button>
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
          <button
            type="button"
            className="icon-btn keys-toggle"
            aria-label={keysOpen ? copy.keysHide : copy.keysShow}
            aria-pressed={keysOpen}
            onMouseDown={keepFocus}
            onClick={() => {
              setKeysOverride(!(keysOverride ?? !compact))
              haptic('tap')
            }}
          >
            <Icon name="keys" />
          </button>
        </div>
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
      <div
        className={`terminal-stage${!atTop || !following ? ' has-jumps' : ''}`}
        role="region"
        aria-label={copy.terminalRegion}
      >
        <div className="terminal-host" ref={hostRef} />
        {!atTop && (
          <button
            type="button"
            className="jump-top"
            onMouseDown={keepFocus}
            onClick={() => jumpTo('top')}
          >
            <Icon name="top" />
            {copy.toTop}
          </button>
        )}
        {!following && (
          <button
            type="button"
            className="jump-latest"
            onMouseDown={keepFocus}
            onClick={() => jumpTo('bottom')}
          >
            <Icon name="latest" />
            {copy.jumpToLatest}
          </button>
        )}
      </div>

      {/* The state a sighted reader gets from the pill, spoken. */}
      <p className="terminal-sr" role="status">
        {following ? copy.following : copy.paused}
      </p>

      {/*
        Page/top/end on a pointer-fine, tall screen. Hidden on the phone by
        CSS: pixel scrolling and the jump-to-latest pill do that job, and the
        strip is a whole row of terminal. Font size lives in the header so it
        stays reachable when this row is gone.
      */}
      {!composing && !searchOpen && (
        <div className="nav-row" role="group" aria-label={copy.historyControls}>
          <button type="button" aria-label={copy.toTop} onClick={() => jumpTo('top')}>
            <Icon name="top" />
          </button>
          <button type="button" aria-label={copy.pageUp} onClick={() => page(-1)}>
            <Icon name="pageUp" />
          </button>
          <button type="button" aria-label={copy.pageDown} onClick={() => page(1)}>
            <Icon name="pageDown" />
          </button>
          <button type="button" aria-label={copy.toBottom} onClick={() => jumpTo('bottom')}>
            <Icon name="bottom" />
          </button>
        </div>
      )}

      {note !== null && (
        <p className="terminal-note" role="status">
          {note.kind === 'copied' ? copy.copyDone : copy.copyFailed}
        </p>
      )}

      {/*
          A dead PTY drops everything written to it — `TerminalBridge.input`
          returns without a word once the attachment is gone — so the controls
          that write stop offering to. The dot above says why.
      */}
      <div className="key-row">
        <div className="key-scroller" role="toolbar" aria-label={copy.keyRowLabel}>
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={() => sendKey('\x1b')}
            disabled={exited !== null}
          >
            Esc
          </button>
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={() => sendKey('\t')}
            disabled={exited !== null}
          >
            Tab
          </button>
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={() => sendKey('\r')}
            disabled={exited !== null}
          >
            Enter
          </button>
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={() => sendKey('\x03')}
            disabled={exited !== null}
          >
            Ctrl-C
          </button>
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={() => sendKey('\x1b[D')}
            disabled={exited !== null}
          >
            ←
          </button>
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={() => sendKey('\x1b[A')}
            disabled={exited !== null}
          >
            ↑
          </button>
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={() => sendKey('\x1b[B')}
            disabled={exited !== null}
          >
            ↓
          </button>
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={() => sendKey('\x1b[C')}
            disabled={exited !== null}
          >
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
          disabled={exited !== null}
        />
        <button type="submit" disabled={exited !== null}>
          {copy.composerSend}
        </button>
      </form>
    </div>
  )
}
