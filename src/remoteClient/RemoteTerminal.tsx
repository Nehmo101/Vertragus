/**
 * One agent's terminal in the browser: the chrome around `TerminalReader`.
 *
 * The output itself is a page of text in a native scroller (`TerminalReader.tsx`,
 * fed by a headless xterm parser sized to the PTY). What lives here is
 * everything around it — the header, the search bar, the key row, the
 * composer, the jump-to-latest pill — and the three things a phone needs from
 * a terminal that a raw xterm keyboard cannot give it: an explicit text field
 * with a send button, a row for the keys a composer lacks (Enter, Esc, Tab,
 * Ctrl-C, arrows), and a clipboard that works over plain HTTP.
 *
 * Two rules, both learned from the phone being unusable:
 *
 * 1. Nothing this chrome does reaches the shared PTY's shape. A+/A− is CSS on
 *    the reader; opening the keys, the search bar or the software keyboard
 *    changes what fits on this screen and nothing else. The desktop window
 *    owns the size; the phone renders it.
 * 2. Nothing moves the reader's viewport unless the reader asked for it:
 *    jump-to-latest, a search hit, a sent line. New output never yanks a
 *    paused reader, and neither does a reconnect (`terminalAttach.ts`).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import './terminal.css'
import { haptic } from './haptics'
import type { RemoteCopy } from './i18n'
import type { RemoteApi } from './useRemote'
import { clampFontSize, localFontStore, readFontSize, writeFontSize } from './terminalFont'
import { COMPACT_MAX_WIDTH_PX, isCompactChrome } from './terminalChrome'
import {
  DEFAULT_ROLE_COLOR,
  TerminalReader,
  type TerminalMeta,
  type TerminalReaderHandle
} from './TerminalReader'

/** How long a "copied" / "copy failed" note stays on screen. */
const NOTE_MS = 2400

type IconName = 'search' | 'close' | 'copy' | 'prev' | 'next' | 'latest' | 'keys' | 'more'

/**
 * Inline paths rather than glyphs: the CSP forbids an icon font, and the
 * arrow characters that would do this job render as tofu on exactly the
 * phones this client exists for.
 */
const ICON_PATHS: Record<IconName, string> = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4.4-4.4',
  close: 'M6 6l12 12M18 6L6 18',
  copy: 'M9 9h10v10H9zM15 6H5v10',
  prev: 'M6 15l6-6 6 6',
  next: 'M6 9l6 6 6-6',
  latest: 'M12 5v13M6 12l6 6 6-6',
  keys: 'M3 7h18v11H3zM6 10h2v2H6zm4 0h2v2h-2zm4 0h2v2h-2zm4 0h1v2h-1zM6 14h12',
  // Filled circles: the overflow glyph. Stroke-only paths render as hollow
  // rings here, and a unicode ⋮ is tofu on the phones this client is for.
  more: 'M12 6.5a1.75 1.75 0 1 1 0-3.5 1.75 1.75 0 0 1 0 3.5zm0 7.25a1.75 1.75 0 1 1 0-3.5 1.75 1.75 0 0 1 0 3.5zm0 7.25a1.75 1.75 0 1 1 0-3.5 1.75 1.75 0 0 1 0 3.5z'
}

function Icon({ name }: { name: IconName }): React.JSX.Element {
  return (
    <svg
      className={name === 'more' ? 'icon icon-fill' : 'icon'}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
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
  const readerRef = useRef<TerminalReaderHandle>(null)
  const searchFieldRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const [title, setTitle] = useState(agentId)
  const [roleColor, setRoleColor] = useState(DEFAULT_ROLE_COLOR)
  const [exited, setExited] = useState<number | null>(null)
  const [line, setLine] = useState('')
  const [fontSize, setFontSize] = useState(() => readFontSize(localFontStore()))
  const [following, setFollowing] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
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
   * Control keys cost a 44 px strip the reader is hungrier for. A phone
   * starts with them folded so reading is the full stage; focusing the
   * composer unfolds them (the keyboard is already up). A laptop has room and
   * a physical keyboard, so they start open. The toggle in the bottom bar is
   * the way to reach Esc / Ctrl-C without opening the composer.
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

  useEffect(() => {
    const query = window.matchMedia(
      `(pointer: coarse), (max-width: ${COMPACT_MAX_WIDTH_PX}px)`
    )
    const update = (): void => setCompact(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  /** What the snapshot and the exit frame say about the agent. */
  const onMeta = useCallback((meta: Partial<TerminalMeta>): void => {
    if (meta.title !== undefined) setTitle(meta.title)
    if (meta.roleColor !== undefined) setRoleColor(meta.roleColor)
    if (meta.exited !== undefined) setExited(meta.exited)
  }, [])

  /** False until the reader has actually moved the size off its stored value. */
  const fontAppliedRef = useRef(false)
  useEffect(() => {
    // Not on mount: opening a terminal must not write back a preference
    // nobody expressed.
    if (!fontAppliedRef.current) {
      fontAppliedRef.current = true
      return
    }
    writeFontSize(localFontStore(), fontSize)
  }, [fontSize])

  useEffect(() => {
    if (note === null) return
    const timer = window.setTimeout(() => setNote(null), NOTE_MS)
    return () => window.clearTimeout(timer)
  }, [note])

  useEffect(() => {
    if (searchOpen) searchFieldRef.current?.focus()
  }, [searchOpen])

  /**
   * The overflow menu is a disclosure, not a focus trap: it must not steal the
   * composer. Close on a tap outside or Escape; do not `.focus()` anything.
   */
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return
      setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  const jumpToLatest = (): void => {
    readerRef.current?.jumpToLatest()
    haptic('tap')
  }

  const find = (direction: 'next' | 'prev'): void => {
    const reader = readerRef.current
    if (!reader || query.trim() === '') return
    setMatches(reader.find(query, direction))
    haptic('tap')
  }

  const closeSearch = (): void => {
    readerRef.current?.clearSearch()
    setSearchOpen(false)
    setQuery('')
    setMatches(null)
  }

  const showNote = (kind: 'copied' | 'copyFailed'): void => {
    noteSeq.current += 1
    setNote({ kind, seq: noteSeq.current })
  }

  const copyBuffer = (): void => {
    const text = readerRef.current?.historyText()
    if (text === undefined) return
    void writeClipboard(text).then((ok) => {
      showNote(ok ? 'copied' : 'copyFailed')
      haptic(ok ? 'confirm' : 'warn')
    })
  }

  const sendLine = (): void => {
    api.sendInput(agentId, `${line}\r`)
    setLine('')
    // Sending is a deliberate act: the answer belongs on screen.
    readerRef.current?.jumpToLatest()
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
   * key row, the search bar, the header, the overflow menu, the jump-to-latest
   * pill, the keys toggle.
   */
  const keepFocus = (event: React.MouseEvent): void => event.preventDefault()

  /**
   * `index` is -1 when nothing matched — then the total is still true and
   * worth showing on its own, and "no match" says so in words.
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
        <div className="header-menu" ref={menuRef}>
          <button
            type="button"
            className="icon-btn"
            aria-label={copy.terminalMenu}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onMouseDown={keepFocus}
            onClick={() => {
              setMenuOpen((open) => !open)
              haptic('tap')
            }}
          >
            <Icon name="more" />
          </button>
          {menuOpen ? (
            <div className="header-menu-list" role="menu">
              <button
                type="button"
                role="menuitem"
                className="header-menu-item"
                aria-label={searchOpen ? copy.searchClose : copy.searchOpen}
                aria-expanded={searchOpen}
                onMouseDown={keepFocus}
                onClick={() => {
                  setMenuOpen(false)
                  if (searchOpen) closeSearch()
                  else setSearchOpen(true)
                }}
              >
                <Icon name={searchOpen ? 'close' : 'search'} />
                {searchOpen ? copy.searchClose : copy.searchOpen}
              </button>
              <button
                type="button"
                role="menuitem"
                className="header-menu-item"
                aria-label={copy.copyBuffer}
                onMouseDown={keepFocus}
                onClick={() => {
                  setMenuOpen(false)
                  copyBuffer()
                }}
              >
                <Icon name="copy" />
                {copy.copyBuffer}
              </button>
              <div className="header-menu-fonts">
                <button
                  type="button"
                  role="menuitem"
                  className="font-btn"
                  onMouseDown={keepFocus}
                  onClick={() => bumpFont(-1)}
                  aria-label={copy.fontSmaller}
                >
                  A−
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="font-btn"
                  onMouseDown={keepFocus}
                  onClick={() => bumpFont(1)}
                  aria-label={copy.fontLarger}
                >
                  A+
                </button>
              </div>
            </div>
          ) : null}
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
          {/* Closing lives in the overflow menu; the bar spends its width on
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
        <TerminalReader
          ref={readerRef}
          agentId={agentId}
          api={api}
          exitBanner={copy.terminalExit}
          fontSize={fontSize}
          onMeta={onMeta}
          onFollowingChange={setFollowing}
        />
        {!following && (
          <button type="button" className="jump-latest" onMouseDown={keepFocus} onClick={jumpToLatest}>
            <Icon name="latest" />
            {copy.jumpToLatest}
          </button>
        )}
      </div>

      {/* The state a sighted reader gets from the pill, spoken. */}
      <p className="terminal-sr" role="status">
        {following ? copy.following : copy.paused}
      </p>

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
        className="input-bar terminal-bar"
        onSubmit={(event) => {
          event.preventDefault()
          sendLine()
        }}
      >
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
