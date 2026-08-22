English | [Deutsch](REMOTE-CLIENT-MOBILE.de.md)

# Remote Client (phone / Tailscale)

Analysis of the previous Tailgate client, what this PR changes, and what
deliberately stays open afterwards. The client lives in `src/remoteClient`
and is served as `out/remote` by the remote server.

## What went wrong before

The client was a **scaled-down desktop panel**, not a phone UI.

### Readability

- Its own colour world (`#0f1512`, garish verdigris), not the
  bronze/graphite language of the panel. Figtree/JetBrains Mono were
  referenced but **never loaded** — system UI, and the 16px fields were
  missing.
- Goal, task and orchestrator questions sat on **one line with ellipsis**
  (`white-space: nowrap`). Unreadable at 390px width.
- Agents were **chips without status**. `statusText` already came from the
  host; the type and the UI ignored it. Working/waiting looked identical,
  except stopped was transparent.
- The `?` badges were 20×20px (Apple HIG: 44px). Questions to the human
  were a grey one-liner, not a banner.
- Fixed 12.5px terminal font, no A+/A− step.

### Scrolling

Causes, not "too much content":

1. `html, body, #root, .app { height: 100% }` **nailed** the page to the
   viewport height.
2. `.workspace-list { flex: 1; overflow-y: auto }` was the intended
   scroller, but **without `min-height: 0`**. Flex children then never
   shrink; `overflow-y: auto` never engages.
3. iOS Safari pans **document scroll** reliably, inner overflow boxes
   often not — and `-webkit-overflow-scrolling` was missing.
4. The safe area was wrongly attached to the header **bottom**; the list
   had no bottom inset. The software keyboard (`visualViewport`) was
   ignored; composer and terminal bar sat under the keys.

### A new pairing link on every restart

Not a UI bug. In `createRemoteController`:

- With an OS keyring: token encrypted in `vertragus-v2.json`.
- **Without a keyring** (common on Linux, and on Windows/macOS when
  `safeStorage` is not yet unlocked at boot): token only in RAM. Every
  start executed `if (!token()) persistToken(mintPairingToken())` — new
  QR, old phone dead.
- Even with the same token: sessions live only in the process. After a
  desktop restart the phone got `session_revoked`, but the hash was
  already stripped from the URL (`sessionStorage`). Scan again.

## What this PR does

| Topic | Change |
| --- | --- |
| Stable link | Token additionally in `userData/remote-pairing.token` (0600). Never silently overwrite when the ciphertext cannot be unlocked. `Regenerate` remains the only rotation path. |
| Phone stays paired | Pairing token + session in `localStorage`. After a desktop restart: silent re-pair via the stored token. |
| Scrolling | Document scroll, sticky header, no inner overflow on the list. Terminal as `position: fixed` on `visualViewport.height`. |
| Reading | 17px body, 16px inputs, goals wrap, agent rows with role·status, 44px touch, warning banner for `ask_user`. |
| Brand | Caprasimo/Figtree/JetBrains Mono, bronze/verdigris, the Fusione mark. |
| Terminal | Larger default font, A+/A−, Esc/Tab/Enter/Ctrl-C/arrows, no auto-focus of the hidden xterm textarea on the phone. |

The gateway allow-list stays at six verbs. No promote, no settings, no CLI
permission TUIs on the phone.

## Design ideas (implemented vs. later)

### In now, because they make the phone usable

- Cards collapse/expand; ended workspaces behind a toggle.
- Start form as `<details>`, closed when a run is already alive.
- Stop only on the second tap.
- Sticky header with connection status.
- Locale from `hello.locale`.

### Next stage, without widening the allow-list

- **PWA manifest + icon**, "Add to Home Screen" — the stable link is what
  makes that worthwhile.
- **Pull-to-refresh** (the ⟳ stays).
- **Haptics** on stop / answers (`navigator.vibrate`).
- **Question inbox** at the top, independent of the card — `ask_user` must
  not disappear under the fold.
- Terminal: optional **wrap** instead of horizontal xterm scrolling;
  snapshot search.
- Override light/dark locally instead of only following the desktop.

### Needs a new gateway verb — not in v1

- Promote / worktree cleanup (deliberately desktop-only, see the handbook).
- Mirroring CLI permission dialogs to the phone (`ask-user` tier).
- Live `statusText` push finer than the workspace summary cadence.
- Reading retro / briefing.

### Do not

- A second MCP server or a mirror of all `APP_CHANNELS`.
- Rebuilding raw xterm as the primary phone keyboard.
- Putting the token into `electron-store` as plain text.

## The second pass — from 3/10 in the hand

The first pass made the client readable. Held on a phone over Tailscale it
still rated 3/10, with two defects named by the person holding it: scrolling
the terminal history was "nearly impossible", and leaving a terminal always
landed back at the very top of the overview.

### The two named defects had one shape

Neither was a gesture problem. Both were state being destroyed underneath
the user.

- **The terminal was rebuilt on nearly every render.** `useRemote()` returns
  a fresh object literal, so `api` changed identity on every render of
  `App` — and `App` re-renders on every `workspaces` push. The create-and-
  attach effect listed `api` in its dependencies, so each push disposed the
  `Terminal`, re-attached, and re-wrote the snapshot. Scrolling up worked;
  the next push dropped the reader back at the bottom. `A+`/`A−` wiped the
  buffer through the same door.
- **Returning from a terminal unmounted the whole overview.** `App`
  early-returned `<RemoteTerminal>`, which took the document scroll offset,
  the expanded cards and every half-typed draft with it. Restoring the
  offset alone would have fixed one of those three, and would still have
  fought the browser's own `history.scrollRestoration`.

The fixes are structural, not cosmetic: the terminal is created once per
agent and reaches props through refs; the overview stays mounted under the
terminal's fixed overlay, hidden rather than unmounted, so nothing is
restored because nothing is lost.

### What the client gained

| Area | Change |
| --- | --- |
| Terminal history | A touch scroller with inertia over the rendered cell height, jump-to-latest, page and end controls, search over the scrollback, copy that works over plain HTTP (a tailnet URL is not a secure context, so `navigator.clipboard` is absent), font size 11–24 persisted. |
| Overview | Question inbox across all workspaces with a jump from the header, the task board the wire always carried, deterministic ordering, pull-to-refresh, collapse-all, a local theme override, drafts that survive every transition. |
| Navigation | The hardware back gesture closes the terminal instead of leaving the app; one history entry, pushed without a URL so the pairing fragment stays stripped. |
| Connection | Reconnect on wake (visibility, `online`, bfcache) instead of waiting out the backoff ceiling; a socket the browser still calls `OPEN` is proven dead by a `refresh` round-trip; identical pushes keep their array identity. Re-attaching a terminal names the tail the client already holds, so the wire sends the remainder rather than the whole scrollback; and a pairing that reaches nobody is told apart from one that was refused — only the refusal leads back to the QR code, the unreachable one waits on the same backoff and tries again on wake. |
| Frame | Installable (manifest, maskable and apple-touch icons), WCAG-corrected palette in both themes, `prefers-contrast` and dynamic type honoured, the visual-viewport geometry published as a documented three-variable contract. |

### What the split bought

The client's one stylesheet became three — shell, overview, terminal — each
owned by the component that uses it, and the decisions came out of the
`.tsx` files into pure modules with tests. That is not tidiness for its own
sake: this project has no DOM test runner, so logic left inside a component
is untested by construction. The scroll accumulator, the momentum decay, the
inbox aggregation, the task grouping, the history state machine and the
reveal predicate are all argued about in tests now, not in a browser.
