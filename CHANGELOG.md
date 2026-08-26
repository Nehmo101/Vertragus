English | [Deutsch](CHANGELOG.de.md)

# Changelog

All notable changes to Vertragus are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
No release has been tagged yet; everything lives under Unreleased.

## [Unreleased]

### Added

- **Pi wrap MCP as first-class tools.** The community adapter's default is a
  lazy `mcp()` proxy, so a wrap that only wrote `{ url, lifecycle: "eager" }`
  could connect without ever exposing `await_events`. `.pi/mcp.json` now
  sets `directTools: true`, `toolPrefix: "none"`, `auth: false`,
  `httpTransport: "streamable-http"`, `requestTimeoutMs` (default 600 s,
  matching Claude's MCP tool window), `idleTimeout: 0`, and
  `lifecycle: "lazy-keep-alive"`
  so the adapter does not connect at load and then tear that handshake
  down on `session_start`. The `mcp` proxy stays registered so extras and a
  cold metadata cache still have a fallback. Spawn sets
  `MCP_DIRECT_TOOLS=vertragus` so session_start waits for those tools.
- **Pi Play smoke.** CI boots the real Electron app with isolated
  userData, the Pi wrap on, and a throwaway git repo (`scripts/pi-play-smoke.mjs`).
  It passes only when the orchestrator PTY shows a TUI and Vertragus MCP
  attached — the Windows blank-window regression. No provider keys; not
  part of `pnpm run ci`.
- **Per-identity system prompts in the profile editor.** Orchestrator, Lead,
  Worker, Tester and every other role can carry an optional extra prompt
  (tone, language, how they report back). It is appended to the host-generated
  or shipped role text — it never replaces the loop, isolation rules or the
  reporting contract. A new profile starts with short English starter texts
  (audience, language of the goal, distilled handoff — not a second copy of
  the shipped role) the user can edit, clear, or restore.
- **Faster MCP handover, no wasted first turn, greyhound boot overlay.**
  The CLI window opens as soon as the host has a PTY — before worktree and
  spawn — so MCP initialize overlaps CLI boot instead of waiting behind it.
  The first Enter is held until the Vertragus MCP session exists, so an
  orchestrator that has not attached yet does not burn tokens on
  `await_events`. During `preparing` → `worktree` → `mcp` → `cli` →
  `handshake` the xterm is live and a compact titlebar status names the
  phase. The full greyhound overlay appears only while waiting for a late
  MCP session (`waiting`, click-through) so leftover Cursor approvals can
  be clicked.   Cursor launches still use `--approve-mcps` and
  also write `~/.cursor/projects/<slug>/mcp-approvals.json` so the TUI
  does not stop on every server. Extra MCP servers stay subagent-only.
  Every native Cursor launch is **Run Everything** (`--force --sandbox
  disabled` plus `.cursor/cli.json`) so Auto-review cannot still prompt,
  including orchestrators and `ask-user` workers.
- **Phase H — nested workers, live steering, first-party Chromium
  extension.** MCP workers may spawn one helper level (cap 3; helpers
  cannot nest; lead-starts-lead stays forbidden). Helper events stay in
  the worker's nest queue — the root's `await_events` still sees only
  direct children. The workspace-card composer (panel and phone) can
  address a worker, lead or helper; delivery remains `user_message` on
  the root queue, with `relayViaAgentId` when the orchestrator cannot
  `send_to_agent` the addressee. An unpacked Manifest V3 extension pairs
  on loopback `/browser` so a worker can drive the user's real Chromium
  tabs (`browser_*` tools; disconnected is a tool error). MCP
  tool-contract version is now `1.1.0`. How-to:
  [`docs/CHROMIUM-EXTENSION.md`](docs/CHROMIUM-EXTENSION.md). Settings →
  Browser extension has an **Install Chromium extension** button that
  opens `chrome://extensions` and the unpacked folder (Chromium will not
  silent-load an unpacked MV3 from Electron).
- **Automation band in the profile (all switches off by default):**
  - Adopt a finished agent branch without the panel click — into the
    orchestrator's worktree (`autoIntegrate`) and/or into the repository's
    own checkout (`autoPromote`). Same host merges as before, same
    refusals: only a clean `success` is adopted, a dirty checkout is still
    refused, and a conflict aborts and is reported as
    `integrate_conflict` (both integrate events gained an optional
    `target`).
  - Open the run's pull request automatically (`autoPr`) when the work is
    done — at `record_retro`, which gets the URL back in its answer, or
    when the workspace is stopped, at most once per run. Pushes with
    `git push -u` (never `--force`) and opens the PR with the GitHub CLI;
    without `gh` the new `pull_request` event carries the ready-made
    compare URL, which the workspace card shows as a link. Base branch,
    remote and draft mode are configurable.
- **A phone client you can actually work from.** The remote web client
  ([`docs/REMOTE-CLIENT-MOBILE.md`](docs/REMOTE-CLIENT-MOBILE.md)) gained a
  touch scroller with inertia over the terminal history, jump-to-latest and
  page/end controls, search over the scrollback, copy that works over plain
  HTTP, a question inbox that collects every open `ask_user` and agent
  question across workspaces, the task board the wire already carried, a
  local light/dark override, pull-to-refresh, haptics, and a PWA manifest
  with maskable and apple-touch icons so it installs to the home screen.
- **A goal can be handed over after a bare start (H2 refill).** The "no
  goal — the orchestrator is waiting" line on a running workspace card is now
  a field, in the panel and in the phone client: the text typed there reaches
  the orchestrator over the same handshake the start goal takes, and becomes
  its first user turn. A run that already has a goal refuses a second one
  (steer it with a message instead), and a delivered refill is written into
  the run's `meta.json`, so Resume briefs on it. New panel channel
  `workspaces:goal` and the gateway's seventh verb of the same name.
- **Phase G (dsh adoption), all five patterns:**
  - Spill instead of truncation — oversized `read_output` and
    `inspect_agent` results are stored verbatim under
    `.vertragus/runs/<ws>/spill/` and returned as head/tail preview + path.
  - Quiet events — echoes of the orchestrator's own tool calls and
    `agent_progress` no longer wake `await_events`; they ride along on the
    next wake or timeout.
  - Structured reports — `start_agent{resultSchema}` validates the agent's
    final report as a JSON object; invalid results bounce back to the child
    with exact paths.
  - Shared task board — `task_create` / `task_update` / `task_list` with
    CAS revisions, `blockedBy` dependencies and ownership; survives
    succession and resume; `start_agent{taskId}` claims a task.
  - `search_runs` — root-only full-text search over this repository's past
    run journals.
- `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md` and this changelog, each
  with a German `.de.md` twin.
- `scripts/docsTwins.test.ts` — CI guard for the dual-language docs:
  matching heading trees and link targets per twin pair, no German copy in
  English canonicals, no orphan twins, no dead doc links or doc references
  in source comments.
- **English blurbs for every agent, workspace and place name**, so the
  English UI no longer shows German hover cards.
- **Code-signing and notarization plumbing**, dormant until repository
  secrets exist: Azure Trusted Signing for Windows, Developer ID plus
  notarization for macOS (which only joins releases once signing works,
  because Squirrel.Mac refuses unsigned auto-updates), per-OS post-package
  signature verification, and `docs/SIGNING.md`.
- **Provider verification matrix**: argv snapshots for every preset and
  launch shape, a `PRESET_VERIFICATION` map with a drift hint in the
  provider editor, a weekly best-effort spawn probe workflow, and
  `docs/RELEASE-CHECKLIST.md`.
- Integration scenarios for the Phase-G features: a `resultSchema` loop
  over a real MCP server, and a task board carried across a succession.
- Guards against language drift: a scanner that fails on German literals
  in the main process outside `mainMessages.ts`, and a parity check for the
  remote client's copy.

- **Succession survives a host crash.** The handoff package now lives beside
  the run's other artefacts instead of in the app's own data directory, and
  a resume that finds an unconsumed one seeds the successor from it — while
  saying plainly that the dead run's questions are void. A package the
  journal contradicts is refused, and a failed handoff retires its own
  package so it can never be replayed over newer work.
- **Replace the orchestrator from the panel.** A dead or silent orchestrator
  can be swapped for a fresh-context successor that keeps the team, the
  queue and the board; the predecessor's window stays open as the
  post-mortem.
- **The task board on the workspace card**, read-only and live, with the
  run's artefact folder one click away — and the same board on the phone,
  because the gateway already forwards the summary.
- **A guided first run**: which agent CLIs are installed, whether they are
  signed in, a button to the first profile, and a pointer at Play.

- **A guarded release path.** `scripts/release-version.mjs` runs as the first
  job of the release workflow and refuses a tag that disagrees with
  `package.json` (or that carries a prerelease suffix, or whose patch is not
  `0`) before any release object or artifact exists; CI now also runs its full
  gate on tags, so a release build is no longer the one build without a smoke
  test. `docs/RELEASE-CHECKLIST.md` gained the versioning convention and a
  numbered tag runbook marked human vs. automated.
- A pull-request template carrying the release tables, and a bug-report issue
  template that asks for OS, Vertragus version and provider CLI version.

### Fixed

- **Cursor Agent on Windows died at Play with "never became ready"** while the
  orchestrator window already showed `An Application Control policy has
  blocked this file` (`file_service.win32-x64-msvc.node` under
  `%LOCALAPPDATA%\cursor-agent\`). Smart App Control / AppLocker / WDAC
  blocks unsigned native addons; the seed handshake treated the crash dump
  as a quiet banner and waited out the keyboard timeout. Boot now fails
  fast, the panel names the blocked file, and
  [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) records the
  workaround (Vertragus cannot override the policy).
- **Pi wrap exited immediately on Play.** The lockfile still spawned
  `@mariozechner/pi-coding-agent` 0.73.1 while `pi-mcp-adapter` 2.27
  imports `@earendil-works/pi-coding-agent`, so extension load failed and
  Pi `process.exit(1)` before `session_start`. Electron-as-node also left
  stdin/stdout non-TTY, so even a matching CLI would pick print mode; a
  Play goal then calls `session.prompt` and Pi exits 1 when it has no
  provider API key (Claude Code login is a different store). Spawn now
  runs `@earendil-works/pi-coding-agent` via a CJS entry that polyfills
  TTY then imports `dist/cli.js` (not Node `-r` — Pi's `-r` is
  `--resume`), writes the role prompt to `.pi/APPEND_SYSTEM.md`, and
  eager-attaches the Vertragus MCP server. Packaged builds unpack
  `typebox` and `jiti` so the adapter can load from asar-unpacked
  `loader.js`.
- **Pi wrap on Windows opened a blank agent window.** ConPTY cannot attach
  stdio to `electron.exe` (WINDOWS subsystem); the child exited 0 with no
  output. The wrap now runs PATH `node` on Windows and keeps Electron-as-node
  on POSIX. Node.js must be on PATH.
- **Zone overlay Save slid off small screens.** The bottom chrome was a
  single nowrap row that grew with every role chip, so Cancel and Save
  painted past the work area. The bar now wraps inside the overlay; Save
  stays on screen.
- **The phone terminal rebuilt itself on nearly every render.** `useRemote()`
  returns a fresh object literal, so `api` changed identity on every render
  of `App`, and the terminal's create-and-attach effect depended on it —
  every workspace push disposed the terminal and re-wrote its snapshot,
  dropping the reader back at the bottom. Scrolling the history was not
  hard; it was being undone. `A+`/`A−` wiped the buffer the same way.
- **Leaving a phone terminal landed at the top of the overview**, because
  `App` early-returned the terminal and unmounted the list — scroll offset,
  expanded cards and half-typed drafts with it. The overview now stays
  mounted under the terminal's fixed overlay.
- **The phone terminal's history jumped in whole lines and barely panned.**
  A finger now owns a pixel position xterm cannot snap back to a whole row:
  the DOM `scrollTop` stays line-aligned (so xterm's rounding is a follower)
  and `.xterm-screen` shifts by the sub-row remainder. A laptop trackpad and
  mouse wheel share that path. Control keys fold on the phone so the stage
  is taller; the overview is a 42 rem column on a wide screen.
- Three reconnect races in the remote client: an uncancelled backoff timer
  that built a second socket on wake, a live socket leaked on every
  supersede, and `reset()` leaving a socket open forever. A phone that
  sleeps now reconnects on wake instead of waiting out the backoff ceiling,
  and a socket the browser still calls `OPEN` is proven dead by a `refresh`
  round-trip.
- A phone reconnecting could freeze the desktop app for fifteen seconds. The
  resume marker added to stop the client re-downloading its whole scrollback
  handed the main process a naive substring search over a two-million-character
  buffer; a repetitive run plus a marker miss — a progress bar and a restarted
  agent will do it — blocked every PTY, window and parked tool call at once.
  The search is linear now, on both sides of the wire.
- A phone opening the remote client with no route to the desktop hung on a
  spinner forever: the pairing request rejected on a network failure and
  nothing retried. An unreachable desktop is now told apart from one that
  refused, retried on the socket's own backoff and on every wake signal, and
  only a refusal sends the phone back to the QR code.
- The remote client's sticky header never resolved against a scrolling
  scrollport (`body` was the scroll container), six colour pairs failed
  WCAG AA on a phone in daylight, and the keyboard-reveal could scroll the
  document out from under the fixed terminal overlay.
- **Provider detection on macOS.** An app started from Finder or the Dock
  inherits a minimal `PATH`, so every probe — health, login status, model
  discovery — reported an installed CLI as missing, and the first-steps card
  told the user no agent CLI was found. The probes now recover the login
  shell's `PATH` once on a miss, the same way the spawn path already did.
- **The glass panel on Linux without a compositor**, where transparency
  rendered as a black or unpainted rectangle. Windows now fall back to an
  opaque themed background, with an explicit `VERTRAGUS_TRANSPARENT`
  override because no reliable compositor signal exists and a window that
  paints black cannot be used to reach its own settings.
- Two German sentences reached the panel through worktree cleanup while
  containing no umlaut, which is exactly what the drift guard tested for.
  Both are localized now, and the guard also matches German function words —
  which immediately surfaced three more.
- Errors an ordinary button press can produce — resume with nothing
  journaled, a conflicted promote, the succession refusals, the
  answer-a-question races, a run folder that will not open — were raw
  English technical strings; they are localized. Validation errors that only
  a broken renderer can trigger, and tool errors written for the
  orchestrator model, stay raw on purpose and now say so.
- A failed boot showed "the workspace manager is not wired up yet" while the
  real reason went only to a console the user cannot open.

- The PTY-idle hint reached the orchestrator model in German on an
  otherwise English channel; it is English now.
- A subagent's result schema leaked in the registry when the agent exited
  on its own (only `stop_agent` and start failures released it).
- The profile editor interpolated a German failure fragment into an English
  sentence; provider auth hints and discovery details now follow the UI
  language.
- On a true first run the UI language follows the operating system instead
  of defaulting to German; a stored choice always wins.

### Changed

- **The app version is `1.0.0`** — the first tagged release. The committed
  version is a patch BASE (`X.Y.0`): main-channel prereleases add the run
  number to it, so main is opened at `X.(Y+1).0` right after a tag. Those
  prereleases sort above the released stable, which is harmless because the
  update CHANNEL, not the version order, keeps the two audiences apart.
- `MCP_SERVER_VERSION` is `1.0.0` and documented as a tool-CONTRACT version:
  it moves when the MCP tool surface moves, not with every app release.
- `@vitest/coverage-v8` and `vitest` are both pinned exactly to `3.2.7`; the
  coverage instrumenter that gates releases no longer floats away from the
  runner it declares as an exact peer.
- The remote client sets `<html lang>` from the host's `hello.locale` instead
  of shipping a hardcoded `de`.

- **Documentation is now English-canonical with maintained German twins.**
  The German handbook `docs/HANDBUCH-HARNESS.md` was translated to
  `docs/HANDBOOK-HARNESS.md` (German original now
  `docs/HANDBOOK-HARNESS.de.md`; the old path is a stub);
  `docs/PROMPT-MCP-HARNESS.md` and `docs/REMOTE-CLIENT-MOBILE.md` are now
  English with German twins; `docs/ORCHESTRATOR-SUCCESSION.md` and
  `README.md` gained German twins. `docs/PLAN-DSH-ADOPTION.md` and
  `docs/RESEARCH-DEEPSEEK-HARNESS.md` stay German as historical records.
- The README's remote threat model moved to `SECURITY.md`; the README keeps
  a short summary and a link.
- The Docs role prompt now states the new language policy: docs are
  English-canonical with maintained German `.de.md` twins — write both when
  touching docs.
