English | [Deutsch](REMOTE-CLIENT-SCROLL.de.md)

# Remote client: why it still does not scroll, and what to replace

Code-grounded analysis of `src/remoteClient` as of commit `bbc5300`, written
after the four passes recorded in [REMOTE-CLIENT-MOBILE.md](REMOTE-CLIENT-MOBILE.md).
That document tells the story of what was tried; this one only says what is
still wrong in the code that exists now, and what to replace. Line numbers
refer to the files at that commit.

## 1. Verdict

The terminal history cannot feel native because every pixel of its motion is
produced on the main thread by a hand-written gesture engine that deliberately
forbids the browser from panning (`touch-action: pinch-zoom` on the stage, host
and viewport), and no amount of tuning changes that ceiling. The same terminal
is also refitted, reflowed and the shared PTY resized by things that are not
viewport changes at all (the jump pills, the key row, a pinch, every keyboard
animation frame), and it renders on a local grid that differs from the PTY's,
which is why TUI output looks wrong on the phone. The overview's document
scroll is the right design, but the pull-to-refresh hook re-renders the whole
app on every touch move at the top of the list and inserts layout height in
front of a native pan that iOS has already started, so the most common flick,
the one from the top, is the one that misbehaves. The keyboard handling
positions a fixed overlay from JavaScript one frame behind the browser and
refits the terminal on every frame of the keyboard animation, so the composer
swims and the buffer reflows while the keys open. The recommendation is
structural: render the scrollback as plain DOM text inside a native scroller
fed by a headless xterm parser sized to the PTY, delete the gesture engine,
the local fit and the viewport chase, and delete the pull gesture from the
overview.

## 2. Findings

Each finding gives the symptom on the phone, the mechanism with citations, and
a confidence. "High" means the mechanism is read directly from the code or
from the xterm 5.5.0 bundle; "medium" means the code is certain but the
on-device severity is inferred from platform behaviour rather than measured.

### 2.1 Terminal history

**T1. A JS-synthesised pan cannot be native, on any phone.**
Symptom: the drag lags, the fling decelerates on a curve that is not the
platform's, there is no rubber band, no scrollbar, and a fast flick drops
frames.
Mechanism: the stage, host and viewport all declare `touch-action: pinch-zoom`
(`src/remoteClient/terminal.css:266`, `:293`, `:330`), so the compositor is
never allowed to pan. Every touchmove instead runs `onTouchMove` then
`paintScroll` (`src/remoteClient/RemoteTerminal.tsx:766-794`, `:681-703`): a
`scrollTop` write, a transform on `.xterm-screen`, xterm's own `_handleScroll`
into `scrollLines`, a re-render of every row by the DOM renderer, then layout
and paint, all on the main thread, per event. Momentum is a
`requestAnimationFrame` loop (`RemoteTerminal.tsx:710-733`,
`src/remoteClient/terminalScroll.ts:294-308`) with a friction constant
(`terminalScroll.ts:67`). The stylesheet already admits the cost: the phone
never sees a scrollbar because nothing native ever scrolls the element
(`terminal.css:318-325`). The repo's own learning, that Safari starts a native
pan the moment `pan-y` is granted and then ignores `preventDefault`
(`terminal.css:37-39`), is exactly why this design has to deny the pan, and
therefore why it can never use the compositor. Confidence: high.

**T2. The terminal is refitted, reflowed and the PTY resized by things that
are not viewport changes.**
Symptom: the reader's place jumps; the desktop's copy of the agent TUI
repaints when the phone merely scrolls to the top or opens the key row.
Mechanism: `has-jumps` adds 56 px of padding to the host
(`terminal.css:269-271`, set at `RemoteTerminal.tsx:1257` whenever the reader
is not at the very top or not following). The `ResizeObserver` on the host
(`RemoteTerminal.tsx:950-951`) fires, `requestFit('viewport')` runs `fit.fit()`
plus a second `term.resize` for the overscan row (`:533-539`), drops the pan
position and the sub-row transform (`:543-545`), and `hostResize` sends the
new size to the PTY because the cause is neither local nor transient
(`:546-559`, `src/remoteClient/terminalResize.ts:54-64`). The same chain runs
when the key row folds or unfolds (`terminal.css:461-463`), when the search
bar closes (`RemoteTerminal.tsx:1210-1252`; only the open half is judged
transient, because `ownFieldRef` follows `searchOpen`, `:481-487`), and when
the input bar appears on compact chrome (`terminal.css:592-604`). Each fit
reflows a 5000-line buffer twice. The desktop owns the same PTY and fits it on
its own `ResizeObserver` (`src/renderer/src/terminal/TerminalApp.tsx:341-342`,
`:373`), so two clients take turns resizing one shared process. Confidence:
high for the mechanism; medium for how often the user attributes the jump to
it.

**T3. The local grid is not the PTY's grid, so TUI output is rendered wrong.**
Symptom: Claude Code's Ink interface shows duplicated or torn lines on the
phone; the newest line is often hidden; with the keyboard up the terminal
shows a few rows of a thirty-row program.
Mechanism: the snapshot carries the PTY's `cols` and `rows`
(`src/shared/remote/protocol.ts:195-196`, filled at
`src/main/remote/terminalBridge.ts:191-192`) and the client ignores both
(`RemoteTerminal.tsx:912`, `_cols, _rows`). The phone fits xterm to its own
width instead, and `terminalResize.ts:20-25` documents the resulting mismatch
as "a slightly early wrap". That is true for a plain log and false for a TUI:
relative cursor movement and erase-line sequences assume the PTY's width, so a
narrower local grid wraps mid-sequence and the repaint lands on the wrong
rows. When a fit is refused as transient (`terminalResize.ts:113-116`,
`MIN_HOST_ROWS` at `:37`) the local terminal is still resized to the small
size (`RemoteTerminal.tsx:535`), so the PTY draws thirty rows into a local
eight-row grid. Separately, the overscan row (`terminalScroll.ts:316-329`,
applied at `RemoteTerminal.tsx:539`) makes the local grid one row taller than
the PTY believes, and `.terminal-host` / `.xterm` clip that row
(`terminal.css:278`, `:297-302`): a program that writes its newest line at the
PTY's last row lands it in the clipped row until the next line feed pushes it
up. Confidence: high for the mechanism; medium-high that this is the garbling
the user sees with Ink-based agents.

**T4. Pinch-zoom is granted and then defeated.**
Symptom: pinching the terminal shrinks the terminal instead of magnifying it.
Mechanism: a pinch changes `visualViewport.height` and `offsetTop`; the hook
rewrites `--vv-height` and `--vv-offset-top`
(`src/remoteClient/useVisualViewport.ts:196-204`); the overlay is sized and
placed by those (`terminal.css:53`, `:65`); the host shrinks; the
`ResizeObserver` and the `visualViewport` `resize` listener
(`RemoteTerminal.tsx:950-953`) refit xterm to fewer columns. The displacement
usually clears `KEYBOARD_MIN_PX` (`terminalResize.ts:73`) so the PTY is
spared, but the local buffer reflows to the zoomed box, which is the opposite
of a zoom. The A−/A+ pair in the header (`RemoteTerminal.tsx:1176-1193`)
exists because of this. Confidence: medium-high.

**T5. xterm snaps `scrollTop` to a row on the next frame; a native pan of
`.xterm-viewport` therefore stutters.**
This is the fact behind the fourth pass and the reason alternative (a) in
section 3.2 is rejected. In the 5.5.0 bundle
(`node_modules/@xterm/xterm/lib/xterm.js`, class `Viewport`):
`syncScrollArea` calls `_refresh` whenever `_lastScrollTop` differs from
`ydisp * rowHeight`; `_innerRefresh` writes `scrollTop = ydisp * rowHeight`
with `_ignoreNextScrollEvent` set; `_handleScroll` rounds
`scrollTop / rowHeight` to pick `ydisp`. Any sub-row position, native or
scripted, is snapped within one frame. xterm's own touch handlers
(`touchstart` passive and `touchmove` non-passive on `term.element`) add
`scrollTop += delta` on top of whatever else is moving. Confidence: high.

**T6. The phone runs xterm's DOM renderer.**
No renderer addon is loaded (`RemoteTerminal.tsx:45-47`; the desktop loads
`WebglAddon`, `TerminalApp.tsx:11`, `:60`). Every `ydisp` change rebuilds the
row elements. `src/remoteClient/styles.css:64-70` claims xterm "renders into a
canvas that no CSS rule can reach"; on this client that is not true.
Confidence: high.

**T7. Opening a terminal gives no feedback.**
Symptom: a tap on an agent row does nothing visible for up to a second or two
over Tailscale.
Mechanism: `.agent-row` has no `:active` style
(`src/remoteClient/overview.css:487-499`; compare `.primary:active` at
`styles.css:410-412`); the Suspense fallback is a bare background box
(`src/remoteClient/App.tsx:457`, `overview.css:77-85`); before the first paint
the client must load the terminal chunk, attach, receive and parse a snapshot
of up to 2 MB (`RemoteTerminal.tsx:923`), and fit. Confidence: high.

### 2.2 Overview

**O1. Pull-to-refresh renders the app on every touch move at the top and
inserts height in front of a native pan.**
Symptom: a flick that starts at the top of the list double-moves, then jumps
on release; the list feels sticky exactly where the user lands most often.
Mechanism: the window `touchmove` listener
(`src/remoteClient/usePullToRefresh.ts:499`) calls `track()` on every move
while still inside the slop (`:480-482`), and `track` is `setDistance`
(`:430-438`): a React render of `App` and every card per touch event. The
indicator whose height that state drives is an in-flow block above `<main>`
(`App.tsx:729-736`, `overview.css:137-144`), so the list is pushed down under
the finger while the browser is panning it. On iOS the first uncancelled move
(the slop is 8 px, `:55`) has already started the root scroller's own gesture;
`overscroll-behavior: contain` (`styles.css:194`) stops chaining but does not
remove the root's rubber band, and the later `preventDefault` from the armed
listener (`:400-402`) is ignored for the rest of that gesture, the same rule
the terminal sheet records at `terminal.css:37-39`. On release the strip holds
34 px for at least 700 ms (`:334-339`, `:289`) while the rubber band snaps
back. Confidence: high for the render-per-move and the layout insertion;
medium for the exact iOS interplay.

**O2. Every touch start walks the ancestor chain with `getComputedStyle`.**
`gestureChain` (`usePullToRefresh.ts:200-220`) forces style on every element
from the touched node to the root, synchronously, at the start of every
gesture in the app. Small, but it sits on the critical path of every scroll
start. Confidence: medium.

**O3. Paint-heavy chrome runs while the list scrolls.**
The sticky header and the back-to-top button use `backdrop-filter: blur(16px)`
(`styles.css:452`, `overview.css:830`); every working agent dot and every
attention dot runs an infinite `box-shadow` keyframe animation
(`overview.css:513-519`, `:362-368`, `styles.css:295-316`). `box-shadow` is
not a compositor property, so each frame repaints, and a list with several
working agents repaints continuously during a scroll. Confidence: medium.

**O4. Heights above the finger change under it.**
Card bodies are built only while expanded (`App.tsx:1423-1424`), the question
inbox and unsent-draft sections appear and disappear with the wire
(`App.tsx:737-752`), and a `workspaces` push is event-driven, not scheduled
(`src/main/remote/server.ts:404-408`). Safari has no scroll anchoring, so any
of these above the viewport shifts the reader's place. Confidence: medium.

What is right in the overview and must not be touched: the document is the
scroller, `html` carries `overflow-y: auto` and `overflow-x: clip`, `body` has
no overflow of its own, the header is sticky, the list has no inner overflow
box (`styles.css:183-215`, `overview.css:164-173`). The hidden-not-unmounted
overview under the terminal (`App.tsx:421-428`, `overview.css:42-58`) is also
right, and `useDocumentScrollLock` (`App.tsx:534-547`) is a sound belt for it.

### 2.3 Keyboard, composer, visual viewport

**K1. The terminal overlay chases the visual viewport from JavaScript, one
frame behind, and refits on every frame of the keyboard animation.**
Symptom: when the composer is focused the whole terminal swims for the length
of the keyboard animation, the input bar is intermittently under the keys, and
the buffer visibly reflows.
Mechanism: `--vv-offset-top` and `--vv-height` are written from a
`requestAnimationFrame` after each `visualViewport` event
(`useVisualViewport.ts:216-222`, `:191-207`); the overlay's `top` and `height`
are those variables (`terminal.css:53`, `:65`). `overview.css:27-35`
documents the resulting uncovered band. Each `visualViewport` `resize` also
calls `requestFit('viewport')` (`RemoteTerminal.tsx:953`), so xterm is
refitted on every animation frame in which the height changed. Confidence:
high.

**K2. iOS ignores `interactive-widget=resizes-content`.**
`src/remoteClient/index.html:44` asks for a resizing layout viewport; only
Android Chrome honours it. On iOS the layout viewport never shrinks; with
`html` at `overflow: hidden` under the terminal (`App.tsx:540`) Safari cannot
scroll the document to reveal the input, so it shifts the visual viewport
instead, the "shift state" the policy module describes
(`src/remoteClient/revealPolicy.ts:259-279`). That state is handled, but only
by the chase in K1. Confidence: high.

**K3. The overview reveal is a two-step.**
`revealFocus` waits 140 ms (`useVisualViewport.ts:54`) after the last growth
step and then scrolls by the centring delta (`revealPolicy.ts:251-256`). The
browser has already scrolled once; the user sees a second, delayed move.
Acceptable, and the policy module is well tested; low priority. Confidence:
medium.

### 2.4 Usability beyond scroll, ranked

**U1. The terminal header is a desktop toolbar.** Back, title, status dot,
search, copy, A−, A+, keys: eight items in one row
(`RemoteTerminal.tsx:1139-1208`), buttons at 40 px minimum
(`terminal.css:108-111`), the title ellipsised to whatever is left
(`terminal.css:142-150`). Everything is in the top strip, the part of the
screen a thumb cannot reach; the rare actions (search, copy, font) take the
space and the frequent ones (type, back) sit in the corners.

**U2. Typing is hidden behind a toggle.** On compact chrome the input bar is
gone until the keys are opened from the top-right toggle
(`terminal.css:592-604`, `RemoteTerminal.tsx:1194-1206`). The "how do I talk
to this agent" gesture is not discoverable.

**U3. No position indicator in 5000 lines.** No scrollbar
(`terminal.css:318-325`), no "line N of M", only two pills.

**U4. No tap feedback on the most-tapped control** (T7).

**U5. The overview header spends its slots on desktop notions.** Theme cycle,
refresh, inbox pill (`App.tsx:629-661`). Refresh duplicates the pull and the
wake-on-visibility; the theme toggle is a settings item.

**U6. Back is top-left only in the installed app.** The history entry
(`App.tsx:484-520`, `src/remoteClient/navState.ts:299-342`) is correct, but an
iOS home-screen app has no edge-swipe, so the `‹` at
`RemoteTerminal.tsx:1140-1148` is the only way out.

**U7. Card heads are dense.** Name, profile, count, attention dot in one
wrapping button plus a two-step stop (`App.tsx:1356-1415`); fine on a laptop,
crowded at 390 px. Lowest priority.

### 2.5 Complexity budget

Load-bearing and to keep unchanged: `useRemote.ts` (wire, reconnect, resume
tails, command queue), `terminalAttach.ts` (append vs replay),
`connection.ts`, `navState.ts` (drafts, history entry, storage),
`viewModel.ts`, `inbox.ts`, `taskBoard.ts`, `i18n.ts`, `themePreference.ts`,
`sendKey.ts`, `haptics.ts`, `terminalBuffer.ts` (copy), `terminalFont.ts`.

Accumulated workarounds that exist only because of the JS pan, the local fit
and the viewport chase, and that the target architecture deletes:

| Mechanism | Where | Lines |
| --- | --- | --- |
| Gesture engine, momentum, sub-row split, overscan, compact-chrome constant | `terminalScroll.ts` and its test | 378 + 512 |
| Pan, wheel, momentum, fit, resize, viewport listeners in the component | `RemoteTerminal.tsx:499-563`, `:632-870`, `:949-953`, `:1010-1023` | about 450 |
| Host-resize policy and transient-viewport heuristic | `terminalResize.ts` and its test | 116 + 104 |
| Pull-to-refresh hook, indicator, copy keys | `usePullToRefresh.ts` and its test, `App.tsx:702-735`, `overview.css:136-161` | 548 + 409 + about 40 |
| Visual-viewport chase (two of the three published variables) | `useVisualViewport.ts`, `terminal.css:42-86`, `overview.css:77-85` | about 80 |
| Touch-action ladder and jump padding | `terminal.css:26-40`, `:260-354`, `:418-427` | about 100 |
| Tests that pin the deleted mechanisms | `RemoteTerminal.test.ts:75-162`, `:182-241`, `:310-335` | about 180 |

Roughly 2,900 lines go. The replacement is about 500 lines, of which about
250 are plain `.ts` under test.

## 3. Target architecture

### 3.1 Terminal: a reader view, not a terminal emulator on the screen

Render the scrollback as ordinary DOM text inside a native scroller. A
headless xterm parser holds the buffer; the screen shows rows.

- **Parser.** `@xterm/headless` 5.5.0, the same core the bundle already
  ships without the renderer. It is added as a devDependency next to
  `@xterm/xterm`, which the phone then no longer imports. It is constructed
  with the PTY's `cols` and `rows` from the snapshot and resized only when a
  later snapshot reports a different size. The wire path stays exactly as it
  is: `planAttach`, `trackWritten` and `attachScroll` (`terminalAttach.ts`)
  feed `term.write`; `reset()` on a replay; the exit banner unchanged. The
  phone never sends a `resize` frame, and `RemoteApi.resize`
  (`src/remoteClient/useRemote.ts:971`) is removed from the phone API (the
  protocol type stays).
- **Rows.** `term.buffer.active` is walked. Lines below `baseY` are the
  scrollback and are immutable (the phone never resizes, so no reflow), so
  their DOM is append-only. The `rows` lines from `baseY` upward are the live
  region and are re-rendered per write, coalesced to one frame, replacing only
  rows whose run list changed. Scrollback sync is a marker on the last synced
  line (`ScrollbackSync` / `registerMarker`), not a count of xterm `onScroll`
  events — a DECSTBM region scroll fires `onScroll` without adding a line;
  trimming at the head drops the rows the marker no longer covers. Each row
  is a `pre`-styled block with one text node in
  the common case and `<span>` runs where attributes change (from the cell
  API: `getFgColorMode`, `getFgColor`, `getBgColor`, `isBold`, `isDim`,
  `isItalic`, `isUnderline`, `isInverse`, `getWidth`, `getChars`); width-0
  continuation cells are skipped. The alternate buffer renders the same way
  with no scrollback. The live-region renderer draws the cursor at
  `cursorX`/`cursorY`.
- **Scroller.** `.reader { overflow-y: auto; overscroll-behavior: contain;
  touch-action: pan-y pinch-zoom; -webkit-overflow-scrolling: touch }` with
  `user-select: text`. Rows soft-wrap (`white-space: pre-wrap;
  overflow-wrap: anywhere`) so the PTY's 80 to 200 columns read on a 390 px
  screen; this is the "wrap instead of horizontal scrolling" item the mobile
  doc lists as wished for. No JavaScript touches the scroll position during
  a gesture. Following is derived in a passive `scroll` listener from
  `scrollHeight - scrollTop - clientHeight` against the row height; when
  following and rows are appended, `scrollTop = scrollHeight` after the DOM
  patch. Jump-to-latest stays as the one pill; the jump-to-top pill and the
  nav row go, because a fling reaches the top natively.
- **Text features.** Native long-press selection replaces xterm's selection.
  The copy-whole-history button keeps `bufferPlainText(unwrapRows(...))` and
  `writeClipboard` (`RemoteTerminal.tsx:246-408`, `terminalBuffer.ts`).
  Search becomes a plain function over row texts plus a highlight class and a
  `scrollIntoView` on the row, replacing `SearchAddon`.
- **Font size and zoom.** A+ and A− set `font-size` on the reader; nothing
  reaches the PTY, nothing reflows a buffer. Pinch-zoom is genuinely
  available once the overlay stops chasing the visual viewport (3.3).
- **Input.** The key row and the composer stay the only keyboard sources.
  `inputmode="none"` and the xterm helper-textarea rules go with the renderer.

What this loses, stated honestly: mouse reporting into a TUI (a tap is not a
click in Claude Code's menus; today's touch-to-mouse path is unreliable on
the phone anyway) and xterm's own search decorations. What it gains beyond
scroll: the PTY is never resized by the phone, TUI output renders on the grid
it was drawn for, text is selectable, dynamic type works, and the bundle drops
the DOM renderer and two addons.

Known gap to decide (see section 6): the PTY's size can change while the
phone is attached, when the desktop window is resized. No server message
announces that today; the next snapshot on re-attach carries it. Until a
`size` server message exists, output after a desktop resize is parsed at the
old width until the next reconnect. That is a rarer form of the garbling that
happens on every open today. Decided: accepted for this cut; no `size`
message is added, and the reader resizes its parser only when a snapshot
names a different size.

### 3.2 Rejected alternatives for the terminal

**(a) Native scroll on `.xterm-viewport` with `pan-y`.** The repo's learning
about Safari and `preventDefault` is not the obstacle here: nothing would
need to cancel anything, and xterm's own touch handlers can be silenced with
capture-phase `stopPropagation`, which Safari honours regardless. The
obstacle is T5. xterm rewrites `scrollTop` to a row boundary within a frame
of every scroll event, so a native pan jitters by up to half a row and a
momentum scroll fights the snap on every frame. There is no public option to
disable it. Rejected.

**(a′) A native scroller of our own with xterm `position: sticky` inside it,
driven from the wrapper's `scrollTop`** through `scrollToLine` plus the
existing sub-row transform. This does get native gesture physics, momentum,
rubber band and a scrollbar, at about 150 lines, and is the fallback if 3.1
is refused. But the paint stays JS-driven one scroll event late, the DOM
renderer still rebuilds all rows on each line crossing (T6), the local-grid
problem (T3) remains unless the local size is pinned to the PTY's, which
makes xterm wider than the phone, and pinch and selection stay as they are.
Rejected as the target; acceptable as a stepping stone only if 3.1 cannot be
scheduled.

**(c) Keep the JS pan and fix its defects**: remove the `has-jumps` refit,
stop refitting on pinch, drop the overscan row when following, add tap
feedback. Each is a real fix, but T1 is a ceiling, not a defect. With the
compositor forbidden to pan, the best case is a main-thread scroller, and the
Safari `pan-y` rule is precisely what makes this alternative unable to ever
grant the browser the gesture. Rejected as a direction; the individual fixes
are listed in WP0 as a stop-gap if WP1 is delayed.

### 3.3 Keyboard: stop chasing the visual viewport

The terminal overlay becomes `position: fixed; inset: 0` in the layout
viewport and consumes neither `--vv-height` nor `--vv-offset-top`. On Android
Chrome, `interactive-widget=resizes-content` shrinks the layout viewport, the
overlay shrinks with it, the reader flexes, and the input bar stays above the
keys with no JavaScript. On iOS the layout viewport does not shrink and Safari
shifts the visual viewport by the keyboard height when the composer is
focused; the overlay stays put, so the header scrolls off the top and the
input bar sits directly above the keys, in the same frame as the keyboard,
because the browser did it. That is the native behaviour of every
fixed-layout web app on iOS; the current code fights it (K1) and the fight is
the swim. Dismissing the keyboard restores the header. No refit happens
because there is no fit.

`useVisualViewport` keeps publishing `--keyboard-inset` for the overview's
bottom padding (`styles.css:425`) and keeps `revealFocus` for the overview's
fields; the terminal half of `revealPolicy` (the `pinned` verdict) stays as a
harmless guard. `--vv-height` and `--vv-offset-top` are retired together with
their only consumers (`terminal.css`, `overview.css:77-85`).

Rejected: keeping the chase but moving it to a `transform` (same lag, still
refits); making the terminal a document-flow page (it would give the same iOS
shift for free but forfeits the hidden-overview design and its tests for no
further gain).

### 3.4 Overview: keep document scroll, remove what fights it

- Delete the pull-to-refresh gesture. The list is pushed, `wake()` runs on
  visibility, `online` and `pageshow` (`useRemote.ts:895-921`), the liveness
  probe convicts a dead route, and the header `⟳` remains for a deliberate
  refresh. If the orchestrator wants the gesture back, the only acceptable
  shape is: passive listeners only, never `preventDefault`, no React state
  per move, a `position: fixed` indicator moved by `transform` so the
  document height never changes, and the decision taken on `touchend`.
- Make the pulses compositor-only (animate `transform` and `opacity` on a
  pseudo-element instead of `box-shadow`), and use a solid header surface on
  coarse pointers instead of `backdrop-filter`.
- Leave the scroller, the sticky header, the hidden overview and the scroll
  lock exactly as they are.

## 4. Implementation plan

Independent packages. WP1 and WP2 share `terminal.css` and should ship
together. Tests: vitest runs in Node with no DOM, so every decision goes into
a plain `.ts` module and the `.tsx` is checked by source-reading tests in the
style of `RemoteTerminal.test.ts`.

### WP1: Terminal reader

Files:

- New `src/remoteClient/terminalRows.ts` (pure): `rowRuns(line, cols)`
  returning runs of `{ text, fg, bg, bold, dim, italic, underline, inverse }`
  from a minimal cell-reader interface; `liveRange(buffer)` returning
  `[baseY, baseY + rows)`; `followState({ scrollTop, scrollHeight,
  clientHeight, rowHeight })`; `findRow(rows, query, from, direction)`;
  `trimHead(prevLength, nextLength, baseY)` for scrollback trimming. Tests
  in `terminalRows.test.ts` with fake lines covering attribute runs, wide and
  zero-width cells, wrapped rows, head trimming, the follow threshold and
  search wrap-around.
- New `src/remoteClient/TerminalReader.tsx`: constructs the headless
  terminal from the snapshot's `cols` and `rows`, owns the append-only
  scrollback DOM and the live-region patch (coalesced to a frame via
  `onWriteParsed` or the `write` callback), the native scroller, following,
  the cursor glyph, search, font size and copy.
- `RemoteTerminal.tsx` shrinks to chrome: header, key row, input bar, exit
  state, `<TerminalReader>`. Delete the pan, wheel, momentum, fit and resize
  code and the `ResizeObserver` and `visualViewport` listeners; delete
  `terminalScroll.ts`, `terminalResize.ts` and their tests; remove `resize`
  from `RemoteApi`.
- `terminal.css`: replace the `.terminal-stage`, `.terminal-host` and xterm
  rules with `.reader`, `.row`, the 16-colour palette classes mapped to the
  brand tokens, and the jump-latest pill; delete the nav row, the jump-top
  pill and the `has-jumps` padding.
- `package.json`: add `@xterm/headless`. `@xterm/xterm`, `addon-fit` and
  `addon-search` stay, because the desktop terminal
  (`src/renderer/src/terminal/TerminalApp.tsx`) uses all three; only the phone
  bundle stops importing them.
- `RemoteTerminal.test.ts`: delete the blocks at `:75-162`, `:182-241` and
  `:310-335`; add: the component never calls `resize` on the API; the
  headless terminal is constructed from snapshot `cols` and `rows`;
  `.reader` declares `touch-action: pan-y` and `overscroll-behavior:
  contain`; no `touchmove` listener exists in the terminal sources.

Acceptance, on an iPhone (Safari) and an Android phone (Chrome) over
Tailscale:

1. A flick over the history decelerates with the platform curve, shows the
   native scrollbar and rubber-bands at both ends; a slow drag moves 1:1.
2. Long-press selects text and the callout copies it.
3. Output arriving while paused does not move the view; jump-to-latest
   returns and re-follows; a reconnect while paused appends and holds.
4. A Claude Code session renders its Ink interface without duplicated or torn
   lines, soft-wrapped at the desktop's column count.
5. A+, A−, opening the keys, focusing the composer and rotating the phone
   send no `resize` frame (assert with a logging `sendRaw` in dev, or by
   reading the gateway log).
6. The desktop terminal never repaints because of a phone action.

**Status: implemented** on this branch, with these deviations from the plan
above.

- `isCompactChrome` and `COMPACT_MAX_WIDTH_PX` moved from the deleted
  `terminalScroll.ts` into a new `terminalChrome.ts` (with a test); the
  chrome fold still needs them.
- `@xterm/xterm`, `addon-fit` and `addon-search` stay in `package.json` for
  the desktop terminal; the phone bundle imports none of them. The terminal
  chunk carries `@xterm/headless` instead and measures 43 kB gzipped; the
  entry chunk measures 67 kB against the 72 kB budget.
- There is no `touchmove` listener and no `preventDefault` anywhere in the
  reader. Passive `touchstart` / `touchend` / `touchcancel` / `scrollend`
  only note fingers and settle; see Review fixes.
- A paused reader keeps head rows the buffer has already trimmed (up to
  5000) rather than compensating `scrollTop`, so JavaScript writes the scroll
  position in exactly one place; the stale rows are dropped the next time the
  reader follows.
- The jump-to-top pill, the nav row and their five copy keys (`toTop`,
  `toBottom`, `pageUp`, `pageDown`, `historyControls`) are gone in both
  locales. The `has-jumps` host padding is gone with them; the reader has a
  permanent bottom padding the jump-to-latest pill floats over.
- Search highlights the matching row and centres it with `scrollTo` on the
  reader, a user-asked scroll like jump-to-latest.
- `RemoteApi.resize` is removed from the phone API; the wire type stays and
  the server still accepts the frame from older clients.
- The chrome's compact rules (input bar hidden until keys open) are
  unchanged; WP4 owns them.

Acceptance, as verified here: items 5 and 6 hold by construction and are
pinned by `RemoteTerminal.test.ts` (no `resize` exists to send; no fit
exists to run); the row rendering, the scrollback bookkeeping, following and
search are covered by `terminalRows.test.ts` and `terminalSync.test.ts`; the
build and bundle guard pass. Items 1 to 4 (native feel of the pan,
long-press selection, hold while paused, Ink rendering at the desktop's
column count) need a phone and remain to be checked on a device.

**Review fixes.** Scrollback sync is a marker on the last synced line
(`ScrollbackSync` / `registerMarker`), so a DECSTBM region scroll no longer
drops or duplicates rows. A rebuild stays deferred while the alternate
screen is shown (`renderPlan`). The follow snap is deferred while a finger
is down or momentum is settling (120 ms / `scrollend`). Stale head rows are
never trimmed under a finger. Multi-touch is tracked by touch count
(`noteTouches`).

### WP2: Keyboard, fixed overlay, no chase

Files: `terminal.css` (`.terminal-view { inset: 0 }`, no `var(--vv-`),
`overview.css:77-85` (same for `.terminal-pending`), `useVisualViewport.ts`
(stop publishing `--vv-height` and `--vv-offset-top`, keep `--keyboard-inset`
and `revealFocus`, update the docblock contract), `styles.css:127-129` (drop
the two fallbacks). Tests: `revealPolicy.test.ts` unchanged; add a CSS
source-reading test that `.terminal-view` contains `inset: 0` and that no
sheet references `--vv-height` or `--vv-offset-top`.

Acceptance: focusing the terminal composer on iOS puts the input bar directly
above the keyboard in the same frame the keyboard finishes, with no
frame-by-frame movement of the terminal; on Android the reader shrinks and the
bar stays above the keys; dismissing the keyboard restores the header; no
buffer reflow is visible in either case.

**Status: implemented** on this branch. `.terminal-view` and
`.terminal-pending` are `inset: 0`; `useVisualViewport.ts` publishes only
`--keyboard-inset` and keeps `revealFocus`; `styles.css` keeps the one
fallback. No sheet or module references the two retired variables, and
`RemoteTerminal.test.ts` pins that. The keyboard behaviour itself (input bar
above the keys in the same frame, no swim, no reflow) remains to be checked
on a device.

### WP3: Overview, delete the pull, calm the paint

Files: delete `usePullToRefresh.ts` and its test; `App.tsx:702-735` (the hook
call and the indicator); `overview.css:136-161`; `i18n.ts` remove
`pullToRefresh`, `releaseToRefresh`, `refreshing` and `pullNoAnswer` in both
locales (the i18n test at `i18n.test.ts:135-181` fails on an unreferenced
key, so the keys must go with the screen); `overview.css:505-519`, `:362-368`
and `styles.css:295-316` (pulse on a pseudo-element with `transform` and
`opacity`); `styles.css:441-460` (solid surface under `(pointer: coarse)`).
Tests: `i18n.test.ts` enforces the copy; add a CSS source-reading test that no
keyframe animates `box-shadow`.

Acceptance: a flick from `scrollY = 0` on iOS moves the list once, with the
native rubber band only; no React commit happens during a scroll gesture
(check with the React profiler in dev); ten working agents do not drop frames
during a scroll on a mid-range Android phone.

**Status: implemented** on this branch as the rebuild described in 3.4, not
as a deletion.

- `usePullToRefresh.ts` stays. Every window listener is `{ passive: true }`
  for its lifetime; the indicator is `position: fixed` and moved with
  `transform` / `opacity` through CSS custom properties on the element
  (`--pull-shown`, `--pull-opacity`), not React state per move. The refresh
  decision is taken on `touchend`. React phase state changes only at gesture
  boundaries (claim, arm, release, refreshing, done). The four copy keys stay
  in both locales.
- Gesture ownership is one `closest()` against `PULL_REFUSE_SELECTOR`, not
  the `getComputedStyle` ancestor walk in O2.
- Pulses (`vg-pulse`) animate `transform` and `opacity` on a pseudo-element.
  No keyframe in the three sheets animates `box-shadow`.
- `.app-header` and `.to-top` use a solid `--surface` and
  `backdrop-filter: none` under `(pointer: coarse)`.

Acceptance, as verified here: the passive window `touchmove`, the fixed
indicator that does not insert layout height, compositor-only keyframes and
the solid coarse-pointer header are pinned by `overviewPaint.test.ts`; the
distance curve, intent lock, phase machine and verdict are covered by
`usePullToRefresh.test.ts`; `i18n.test.ts` still requires the four pull keys.
The iOS flick-from-top rubber band, "no React commit during a scroll
gesture" and the frame budget with ten working agents need a phone and
remain to be checked on a device.

### WP4: Terminal chrome for the thumb

Files: `RemoteTerminal.tsx` (header reduced to back, title, status dot and one
overflow menu holding search, copy and the font pair; a permanent bottom bar
on compact chrome with keys toggle, input and send, the input never hidden),
`terminal.css` (`.terminal-bar` at `--touch` height with
`env(safe-area-inset-bottom)`), `overview.css` (`.agent-row:active`),
`App.tsx:457` (the pending state shows the terminal header with the agent's
name and a "connecting" note instead of a blank box), `i18n.ts` (new keys in
both locales). Tests: `i18n.test.ts`; a source-reading test that the input
bar is not hidden on compact chrome.

Acceptance: the composer is reachable with one thumb without touching the top
of the screen; a tap on an agent row flashes and shows a named, non-blank
screen within one frame.

**Status: implemented** on this branch.

- The header is back, title, status dot and one overflow menu
  (`copy.terminalMenu`) holding search, copy and the font pair. The menu
  closes on an outside tap and on Escape; it is not a focus trap.
- The input bar is a permanent `.terminal-bar` at `--touch` height with
  `env(safe-area-inset-bottom)`: keys toggle, field and send. Compact chrome
  no longer hides `.input-bar`.
- `.agent-row:active` scales the row (`transform: scale(0.97)`) and the row
  opts back into the tap highlight.
- Opening a terminal paints `TerminalPending` in the same frame as the tap
  (it lives in `App.tsx`, not the terminal chunk): back, the agent name, and
  `copy.terminalConnecting`.

Acceptance, as verified here: header composition, the un-hidden compact
input bar, `.agent-row:active` and the named pending screen are pinned by
`RemoteTerminal.test.ts` and `App.test.ts`; the new keys (`terminalMenu`,
`terminalConnecting`) are required in both locales by `i18n.test.ts`. Thumb
reach of the composer and "named screen within one frame" over Tailscale
need a phone and remain to be checked on a device.

### WP5: Overview header and card density (deferred)

Move the theme toggle out of the header (a menu or the pairing screen), keep
`⟳` and the inbox pill, reduce the card head to name and status with the
profile in the body. No scroll impact; schedule after WP1 to WP4.

### WP0: Stop-gap only if WP1 is not next

Do not do this if WP1 starts within the same iteration; it would be deleted.
Otherwise: make the jump pills float over the host without padding
(`terminal.css:269-271`) so `has-jumps` no longer fires the `ResizeObserver`;
ignore `visualViewport` `resize` for fitting when `isTransientViewport` is
true; apply the overscan row only when not following; add
`.agent-row:active`. Each is a two-line change and none of them lifts the
ceiling in T1.

## 5. What must stay

- The document is the overview's scroller: `html { overflow-y: auto }`, no
  overflow on `body`, no inner overflow on the list, sticky header
  (`styles.css:183-215`, `overview.css:164-173`).
- Any window-level `touchmove` listener stays `{ passive: true }` for its
  lifetime (`usePullToRefresh.ts:22-31`). WP3 rebuilt the pull in that
  shape; `overviewPaint.test.ts` pins the registration.
- The overview is hidden, not unmounted, under the terminal, and stays laid
  out (`App.tsx:421-428`, `overview.css:42-58`, `useDocumentScrollLock`).
- One history entry per open terminal, pushed without a URL, closed by the
  hardware back (`App.tsx:484-520`, `navState.ts:299-342`).
- The six command verbs (`src/shared/remote/protocol.ts:28-44`). WP1 removes
  a phone-initiated frame (`resize`) and adds nothing. A future `size`
  server-to-client message (the known gap in 3.1) is not a command and does
  not widen the allow-list, but it is a protocol change and needs the
  orchestrator's decision.
- No zod in the phone bundle (commit `09d4833`): `@xterm/headless` pulls
  none; keep `questionChoicesDisplay` on its zod-free path.
- Reconnect and resume unchanged: `terminalAttach.ts`, the resume tails in
  `useRemote.ts`, `REMOTE_COALESCE_MS` on the bridge. The reader consumes the
  same `onSnapshot`, `onData` and `onExit` handlers.
- 44 px touch targets (`--touch`), 16 px minimum input font, both locales for
  every copy key, and the CSP in `index.html` (everything bundled, no
  external script).
- The `hide` versus `minimize` distinction and the presets matrix are desktop
  concerns and are not touched by any package here.

## 6. Questions for the orchestrator

1. Does the phone need to click inside a TUI (mouse reporting)? Assumed no.
   **Decided: no mouse reporting.**
2. May WP1 add a `size` server-to-client message so a desktop resize reaches
   an attached phone, or is "parsed at the old width until the next
   reconnect" acceptable for the first cut? Assumed acceptable for the first
   cut.
   **Decided: no `size` message in this cut.** The reader resizes its parser
   only when a snapshot names a different size.
3. Delete pull-to-refresh outright (recommended) or rebuild it in the
   passive, fixed-indicator shape described in 3.4?
   **Decided: rebuilt passive, not deleted.** WP3 shipped that shape.
4. Is `@xterm/headless` an acceptable new devDependency? If not, the
   unopened `Terminal` from `@xterm/xterm` parses without `open()` at the
   cost of shipping the renderer the reader never uses.
   **Decided: `@xterm/headless` accepted.** The phone bundle imports it;
   `@xterm/xterm` stays for the desktop terminal.
