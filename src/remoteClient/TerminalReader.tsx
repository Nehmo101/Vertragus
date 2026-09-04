/**
 * The agent's output as a page of text the phone can scroll natively.
 *
 * Nothing here pans. A headless xterm parses the byte stream at the PTY's own
 * size; this component walks its buffer and keeps a column of plain `.row`
 * elements inside one `overflow-y: auto` box that the browser owns outright —
 * touch, momentum, rubber band, scrollbar, long-press selection and pinch are
 * all the platform's, which is the difference between the scroller the third
 * and fourth passes tuned and one that feels like the phone.
 *
 * Four rules, learned from the passes before this one:
 *
 * 1. Built once per `agentId`. The effect below depends on nothing else;
 *    `api`, `copy` and the callbacks are reached through refs, because
 *    `useRemote()` hands back a new object on every workspace push and an
 *    effect keyed on it would rebuild the buffer under the reader.
 * 2. The phone never resizes the PTY. The parser takes `cols`/`rows` from the
 *    snapshot and is resized only when a later snapshot names a different
 *    size; a font step is CSS on this box and reaches nobody.
 * 3. JS writes the scroll position in exactly one place — `snapToLatest`, and
 *    only while the reader is following — and never while a finger is down.
 *    Everything else the viewport does is the browser's.
 * 4. A reconnect continues the buffer (`terminalAttach.ts`); only a plan that
 *    earned a rebuild resets the parser, and that resets the DOM with it.
 *
 * The DOM is two columns: `.scrollback` holds the lines below `baseY`, which
 * the parser never rewrites once they leave the live region (no reflow — see
 * rule 2), so it is append-only and trimmed from the head in step with the
 * buffer; `.live` holds the last `rows` lines and is re-rendered per burst of
 * writes, one animation frame per burst, replacing only the rows whose
 * painted content changed (`rowSignature`).
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Terminal } from '@xterm/headless'
import type { RemoteApi } from './useRemote'
import { prefersReducedMotion } from './navState'
import { attachScroll, planAttach, trackWritten } from './terminalAttach'
import { bufferPlainText, unwrapRows, type BufferRow } from './terminalBuffer'
import {
  countMatches,
  findRow,
  followState,
  isPlainRun,
  liveRange,
  rowRuns,
  rowSignature,
  rowText,
  runPresentation,
  scrollbackPatch,
  type RowRun
} from './terminalRows'
import { safeRoleColor } from './viewModel'

/** Lines the parser keeps above the screen. */
export const SCROLLBACK_LINES = 5000

/**
 * The role tint until a snapshot names one — and again if a snapshot names
 * something that is not a colour. `safeRoleColor` is the same guard `App.tsx`
 * puts in front of the same wire value: it reaches a style attribute, and a
 * style attribute is not a place to put a string off a socket unchecked.
 */
export const DEFAULT_ROLE_COLOR = '#cba35a'

/** Used for the follow slack when the sheet's line height cannot be read. */
const FALLBACK_ROW_HEIGHT_PX = 20

/**
 * While the reader is paused, rows the buffer has already trimmed stay in the
 * DOM so the view does not jump (Safari has no scroll anchoring). Past this
 * many they are dropped anyway; the jump costs less than an unbounded page.
 */
const MAX_STALE_ROWS = SCROLLBACK_LINES

/** What the snapshot and the exit frame tell the chrome about the agent. */
export interface TerminalMeta {
  title: string
  roleColor: string
  exited: number | null
}

export interface TerminalReaderHandle {
  /** Follow again and show the newest output. */
  jumpToLatest(): void
  /** Highlight the next / previous row containing `query`; `-1` for none. */
  find(query: string, direction: 'next' | 'prev'): { index: number; count: number }
  clearSearch(): void
  /** The whole history as paste-ready text — see `terminalBuffer.ts`. */
  historyText(): string
}

/** What the long-lived effect exposes to the handle. */
interface Engine {
  term: Terminal
  setFollow(next: boolean): void
  snapToLatest(): void
  texts(): string[]
  rowElement(index: number): HTMLElement | null
  scrollTo(top: number): void
}

function fillRow(row: HTMLElement, runs: readonly RowRun[]): void {
  if (runs.length === 0) {
    row.textContent = ''
    return
  }
  if (runs.length === 1 && isPlainRun(runs[0]!)) {
    row.textContent = runs[0]!.text
    return
  }
  const doc = row.ownerDocument
  const fragment = doc.createDocumentFragment()
  for (const run of runs) {
    if (isPlainRun(run)) {
      fragment.append(doc.createTextNode(run.text))
      continue
    }
    const span = doc.createElement('span')
    const shown = runPresentation(run)
    if (shown.className !== '') span.className = shown.className
    if (shown.color) span.style.color = shown.color
    if (shown.background) span.style.backgroundColor = shown.background
    span.textContent = run.text
    fragment.append(span)
  }
  row.replaceChildren(fragment)
}

function makeRow(doc: Document, runs: readonly RowRun[]): HTMLDivElement {
  const row = doc.createElement('div')
  row.className = 'row'
  fillRow(row, runs)
  return row
}

export const TerminalReader = forwardRef<
  TerminalReaderHandle,
  {
    agentId: string
    api: RemoteApi
    /** The exit banner's copy, read through a ref when the banner is written. */
    exitBanner: (exitCode: number) => string
    fontSize: number
    onMeta: (meta: Partial<TerminalMeta>) => void
    onFollowingChange: (following: boolean) => void
  }
>(function TerminalReader({ agentId, api, exitBanner, fontSize, onMeta, onFollowingChange }, ref) {
  const readerRef = useRef<HTMLDivElement>(null)
  const scrollbackRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<Engine | null>(null)
  /** Mirrors the chrome's `following`; the effect must not re-subscribe on it. */
  const followRef = useRef(true)
  const matchIndex = useRef(-1)
  const matchElement = useRef<HTMLElement | null>(null)

  /**
   * Everything the long-lived effect reads from props, kept current without
   * becoming deps of it. The sync runs before the effect below on mount
   * because effects fire in order.
   */
  const apiRef = useRef(api)
  const exitBannerRef = useRef(exitBanner)
  const onMetaRef = useRef(onMeta)
  const onFollowingRef = useRef(onFollowingChange)
  useEffect(() => {
    apiRef.current = api
    exitBannerRef.current = exitBanner
    onMetaRef.current = onMeta
    onFollowingRef.current = onFollowingChange
  })

  useEffect(() => {
    const reader = readerRef.current
    const scrollbackEl = scrollbackRef.current
    const liveEl = liveRef.current
    if (!reader || !scrollbackEl || !liveEl) return
    const doc = reader.ownerDocument
    // 80x24 until the first snapshot says what the PTY really is.
    const term = new Terminal({ cols: 80, rows: 24, scrollback: SCROLLBACK_LINES })
    const scratch = term.buffer.active.getNullCell()

    /** Set before disposal: a queued write callback must not touch a corpse. */
    let disposed = false
    let frame = 0
    /** `onScroll` events since the last render — lines that entered the scrollback. */
    let pendingScrolled = 0
    /** The `baseY` the scrollback DOM was last brought level with. */
    let syncedBase = 0
    /** Head rows the buffer has trimmed but a paused reader still sees. */
    let staleRows = 0
    let rebuild = true
    /** The live region alone: a switch between the two screens. */
    let rebuildLive = false
    let liveSignatures: string[] = []
    let scrollbackTexts: string[] = []
    let liveTexts: string[] = []
    let rowHeightPx = FALLBACK_ROW_HEIGHT_PX
    let touchDown = false
    let snapPending = false
    let exited = false

    const setFollow = (next: boolean): void => {
      if (followRef.current === next) return
      followRef.current = next
      onFollowingRef.current(next)
    }

    /** The one place JS moves this viewport, and never under a finger. */
    const snapToLatest = (): void => {
      if (touchDown) {
        snapPending = true
        return
      }
      snapPending = false
      reader.scrollTop = reader.scrollHeight
    }

    const readRowHeight = (): void => {
      const parsed = Number.parseFloat(doc.defaultView?.getComputedStyle(reader).lineHeight ?? '')
      rowHeightPx = Number.isFinite(parsed) && parsed > 0 ? parsed : FALLBACK_ROW_HEIGHT_PX
    }

    const renderScrollback = (): void => {
      const normal = term.buffer.normal
      const base = Math.max(0, normal.baseY)
      const domCount = scrollbackEl.childElementCount - staleRows
      const patch = rebuild
        ? { dropHead: domCount, appendFrom: 0 }
        : scrollbackPatch({ synced: syncedBase, domCount, base, scrolled: pendingScrolled })
      pendingScrolled = 0
      if (patch.appendFrom === 0 && scrollbackEl.childElementCount > 0) {
        // A rebuild verdict: nothing on screen is still in the buffer.
        scrollbackEl.replaceChildren()
        scrollbackTexts = []
        staleRows = 0
      } else {
        staleRows += patch.dropHead
      }
      if (base > patch.appendFrom) {
        const fragment = doc.createDocumentFragment()
        for (let index = patch.appendFrom; index < base; index += 1) {
          const runs = rowRuns(normal.getLine(index), term.cols, -1, scratch)
          fragment.append(makeRow(doc, runs))
          scrollbackTexts.push(rowText(runs))
        }
        scrollbackEl.append(fragment)
      }
      syncedBase = base
      // Stale head rows leave once the reader is following again (the view is
      // about to be pinned to the bottom, so nothing jumps) or once there are
      // too many of them to keep.
      if (staleRows > 0 && (followRef.current || staleRows > MAX_STALE_ROWS)) {
        for (let index = 0; index < staleRows; index += 1) scrollbackEl.firstElementChild?.remove()
        scrollbackTexts.splice(0, staleRows)
        staleRows = 0
      }
    }

    const renderLive = (): void => {
      const active = term.buffer.active
      const range = liveRange(active, term.rows)
      if (rebuild || rebuildLive) {
        liveEl.replaceChildren()
        liveSignatures = []
        rebuildLive = false
      }
      while (liveEl.childElementCount < term.rows) liveEl.append(makeRow(doc, []))
      while (liveEl.childElementCount > term.rows) liveEl.lastElementChild?.remove()
      liveSignatures.length = term.rows
      liveTexts = []
      const cursorRow = exited ? -1 : active.cursorY
      for (let index = 0; index < term.rows; index += 1) {
        const line = range.from + index < range.to ? active.getLine(range.from + index) : undefined
        const runs = rowRuns(line, term.cols, index === cursorRow ? active.cursorX : -1, scratch)
        liveTexts.push(rowText(runs))
        const signature = rowSignature(runs)
        if (liveSignatures[index] !== signature) {
          fillRow(liveEl.children[index] as HTMLElement, runs)
          liveSignatures[index] = signature
        }
      }
    }

    const render = (): void => {
      frame = 0
      if (disposed) return
      const alternate = term.buffer.active.type === 'alternate'
      // A full-screen program owns the whole screen and has no history.
      scrollbackEl.style.display = alternate ? 'none' : ''
      if (!alternate) renderScrollback()
      renderLive()
      rebuild = false
      readRowHeight()
      if (followRef.current) snapToLatest()
    }

    /** One frame per burst of writes, however many frames arrive in it. */
    const scheduleRender = (): void => {
      if (disposed || frame !== 0) return
      frame = window.requestAnimationFrame(render)
    }

    const offScroll = term.onScroll(() => {
      // The alternate screen scrolls into nothing; only the normal buffer
      // grows a scrollback worth appending.
      if (term.buffer.active.type === 'normal') pendingScrolled += 1
    })
    const offBufferChange = term.buffer.onBufferChange(() => {
      // The normal buffer's scrollback is untouched by a full-screen program
      // coming and going; only the live rows have to be drawn afresh.
      rebuildLive = true
      scheduleRender()
    })

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
      term.write(`\r\n\x1b[90m— ${exitBannerRef.current(exitCode)} —\x1b[0m\r\n`, scheduleRender)
    }

    const detach = apiRef.current.attach(agentId, {
      /**
       * A reconnect is the same stream seen again from further back, not a new
       * session — see `terminalAttach.ts`. The plan says whether this snapshot
       * continues the buffer on screen (the normal case) or whether the two
       * streams diverged far enough that a rebuild is earned.
       *
       * `cols`/`rows` are the PTY's, owned by the desktop. The parser is sized
       * to them so cursor movement and erase sequences land where the program
       * meant them; the phone never sends a size of its own.
       *
       * `exitCode` arrives as `undefined` from a gateway that does not forward
       * it yet; that is "no news", not "still running".
       */
      onSnapshot: (snapshot, cols, rows, name, color, exitCode?: number | null) => {
        onMetaRef.current({ title: name, roleColor: safeRoleColor(color) ?? DEFAULT_ROLE_COLOR })
        if (
          Number.isInteger(cols) &&
          Number.isInteger(rows) &&
          cols >= 1 &&
          rows >= 1 &&
          (cols !== term.cols || rows !== term.rows)
        ) {
          term.resize(cols, rows)
          rebuild = true
        }
        const plan = planAttach({ snapshot, written })
        if (plan.kind === 'replay') {
          term.reset()
          written = ''
          exitBannerShown = false
          rebuild = true
        }
        written = trackWritten(written, plan.data)
        const scroll = attachScroll(plan, followRef.current)
        term.write(plan.data, () => {
          if (disposed) return
          if (scroll === 'bottom') setFollow(true)
          scheduleRender()
        })
        if (exitCode !== undefined) {
          exited = exitCode !== null
          onMetaRef.current({ exited: exitCode })
          // Re-drawn after a rebuild: `reset()` erased the banner a previous
          // `onExit` wrote, and the bridge never re-fires `exit` for a PTY that
          // was already dead when this client attached.
          if (exitCode !== null) writeExitBanner(exitCode)
        }
      },
      // No scroll call here: a paused reader stays where they are.
      onData: (data) => {
        written = trackWritten(written, data)
        term.write(data, scheduleRender)
      },
      onExit: (exitCode) => {
        exited = true
        onMetaRef.current({ exited: exitCode ?? 0 })
        writeExitBanner(exitCode ?? 0)
      }
    })

    /**
     * Following is read off the scroller, not written into it: the browser
     * moved the view, this only takes note. Passive, so nothing here can delay
     * the pan.
     */
    const onViewportScroll = (): void => {
      setFollow(
        followState({
          scrollTop: reader.scrollTop,
          scrollHeight: reader.scrollHeight,
          clientHeight: reader.clientHeight,
          rowHeight: rowHeightPx
        })
      )
    }
    const onTouchStart = (): void => {
      touchDown = true
    }
    const onTouchEnd = (): void => {
      touchDown = false
      if (snapPending && followRef.current) snapToLatest()
    }
    reader.addEventListener('scroll', onViewportScroll, { passive: true })
    reader.addEventListener('touchstart', onTouchStart, { passive: true })
    reader.addEventListener('touchend', onTouchEnd, { passive: true })
    reader.addEventListener('touchcancel', onTouchEnd, { passive: true })

    engineRef.current = {
      term,
      setFollow,
      snapToLatest,
      texts: () => [...scrollbackTexts, ...liveTexts],
      rowElement: (index) => {
        const element =
          index < scrollbackTexts.length
            ? scrollbackEl.children[index]
            : liveEl.children[index - scrollbackTexts.length]
        return element instanceof HTMLElement ? element : null
      },
      scrollTo: (top) => {
        reader.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
      }
    }
    scheduleRender()

    return () => {
      disposed = true
      engineRef.current = null
      if (frame !== 0) window.cancelAnimationFrame(frame)
      reader.removeEventListener('scroll', onViewportScroll)
      reader.removeEventListener('touchstart', onTouchStart)
      reader.removeEventListener('touchend', onTouchEnd)
      reader.removeEventListener('touchcancel', onTouchEnd)
      offScroll.dispose()
      offBufferChange.dispose()
      detach()
      term.dispose()
      scrollbackEl.replaceChildren()
      liveEl.replaceChildren()
    }
  }, [agentId])

  /**
   * A font step changes every row's height. The reader who was at the newest
   * line stays there; a paused reader keeps their scroll offset and the
   * browser keeps their place as well as it can.
   */
  useEffect(() => {
    if (followRef.current) engineRef.current?.snapToLatest()
  }, [fontSize])

  const clearHighlight = (): void => {
    matchElement.current?.classList.remove('is-match')
    matchElement.current = null
  }

  useImperativeHandle(
    ref,
    () => ({
      jumpToLatest() {
        const engine = engineRef.current
        if (!engine) return
        engine.setFollow(true)
        engine.snapToLatest()
      },
      find(query, direction) {
        const engine = engineRef.current
        if (!engine) return { index: -1, count: 0 }
        const texts = engine.texts()
        const index = findRow(texts, query, matchIndex.current, direction)
        clearHighlight()
        matchIndex.current = index
        if (index >= 0) {
          const element = engine.rowElement(index)
          const reader = readerRef.current
          if (element && reader) {
            element.classList.add('is-match')
            matchElement.current = element
            // The reader is the offset parent (`position: relative`), so this
            // is the row's place inside the scroller. Centred, like a find bar.
            engine.scrollTo(element.offsetTop - (reader.clientHeight - element.offsetHeight) / 2)
          }
        }
        return { index, count: countMatches(texts, query) }
      },
      clearSearch() {
        clearHighlight()
        matchIndex.current = -1
      },
      historyText() {
        const engine = engineRef.current
        if (!engine) return ''
        // The *normal* buffer, never `active`. While a full-screen TUI holds
        // the alternate screen, `active` is one screenful with no history
        // behind it, and "copy the history" must not quietly mean "copy one
        // screen".
        const buffer = engine.term.buffer.normal
        const rows: BufferRow[] = []
        for (let index = 0; index < buffer.length; index += 1) {
          const row = buffer.getLine(index)
          // Untrimmed, and carrying the wrap flag: a row that is continued is
          // full by definition, so trimming it here would eat the spaces at
          // the wrap point. `unwrapRows` rejoins first, `bufferPlainText`
          // trims after.
          rows.push({
            text: row?.translateToString(false) ?? '',
            wrapped: row?.isWrapped ?? false
          })
        }
        return bufferPlainText(unwrapRows(rows))
      }
    }),
    []
  )

  return (
    <div className="reader" ref={readerRef} style={{ fontSize: `${fontSize}px` }}>
      <div className="scrollback" ref={scrollbackRef} />
      <div className="live" ref={liveRef} />
    </div>
  )
})
