English | [Deutsch](README.de.md)

<p align="center">
  <img src="build/icon.svg" width="112" alt="Vertragus — a greyhound in full sprint with verdigris speed lines" />
</p>

<h1 align="center">Vertragus</h1>

<p align="center">
  <b>Orchestrate AI coding agents in parallel</b><br />
  A translucent panel that runs your agent CLIs as a coordinated team
</p>

Vertragus is a small always-on-top glass panel. You define **profiles** — a
repo path, an orchestrator CLI (Claude, Codex, Kimi, Cursor, Grok Build, …) and a set of
subagent roles — and press play. The orchestrator opens in its own translucent
terminal window, and starts **visible** subagent windows on demand. Agents and
orchestrator talk over a slim in-app MCP server with true blocking
communication: no polling, no starving workers.

The name is *vertragus*, the ancient Gaulish-Latin word for a greyhound.
Agents are named after the Divine Comedy — orchestrators get guides
(Virgilio, Beatrice, …), subagents get the cast (Caronte, Ulisse, …),
workspaces get places (Paradiso, Inferno, …).

> **Status: first stable milestone.** Vertragus works and is heavily
> tested — around 1900 tests, a coverage ratchet, and a real-Electron boot
> check on Windows, macOS and Linux. It is also young: downloads are
> unsigned by choice, releases carry no macOS build, and agents are not
> sandboxed. Those limits are named where they matter, not buried.

The handbook [`docs/HANDBOOK-HARNESS.md`](docs/HANDBOOK-HARNESS.md)
is the code-grounded map of the harness core; serial root succession
(fresh context, same team) is described in
[`docs/ORCHESTRATOR-SUCCESSION.md`](docs/ORCHESTRATOR-SUCCESSION.md).

## How a run works

A **profile** is a blueprint, not a pre-started team: a repository path, one
orchestrator (provider, model, effort), and **slots** ("a reviewer runs on
codex, at most two of them"). Pressing **Play** starts a workspace with only
the orchestrator; it decides which agents it actually needs, bounded by the
slot caps and the profile-wide `maxSubagents`. The Play button folds out a
**goal field** — the goal is typed into the orchestrator over the same
keyboard handshake as any assignment, so what the card shows is what the
orchestrator really received. **Playbooks** are one-click goal templates on
that fold-out, never a pre-configured crew.

Everything the orchestrator can do goes through its MCP tools — there is no
second path:

| Tool | What it does |
| --- | --- |
| `start_agent{role, task, model?, providerId?, slotId?, baseBranch?, resultSchema?, taskId?}` | Start a subagent in its own worktree. Explicit provider/slot choice fails hard instead of silently falling back; `baseBranch` chains onto another agent's result; `resultSchema` makes the agent's final report a validated JSON object; `taskId` claims a board task and seeds its subject into the assignment. |
| `send_to_agent{agentId, text, questionId?}` | Answer an agent's question or give a follow-up instruction. |
| `await_events{cursor, timeoutSec?}` | The main loop: block until something happens. True long-poll, no busy polling. |
| `list_agents` / `read_output` / `inspect_agent` | Snapshot, raw terminal tail, and **read-only git facts** (status/diff/log/file) from an agent's worktree — verification is host truth, not the agent's word. Oversized output spills to a file (preview + path) instead of being truncated. |
| `stop_agent` | End an agent; files, branch and worktree stay. |
| `integrate_branch{agentId, branch}` | The one sanctioned merge path: a **host-side** merge into the target agent's worktree. Conflicts abort cleanly and are reported (`integrate_conflict`); a gate warning flags integrating unverified work. |
| `ask_user{question, ticket?}` | Ask the human and block for the answer (panel badge and phone); ticket-resume survives the MCP request timeout. |
| `start_orchestrator{area, task, …}` | Start a **lead** (see below). |
| `record_retro{summary, learnings, repoNotes?}` | The run retrospective, once at the end. |
| `request_succession{reason, …}` | Replace a context-full root with a successor that keeps the same team, queue and open questions. |
| `task_create` / `task_update` / `task_list` | The shared **task board**: host state with CAS revisions, `blockedBy` dependencies and ownership. It survives succession and resume — the plan lives on the host, not in the model context. |
| `search_runs{query, maxResults?}` | Full-text search over this repository's past run journals — the root's institutional memory. |

Subagents report back with `report_done` / `ask_orchestrator` /
`report_progress`. Every task carries a **contract** appended by the MCP
layer, so no spawn path can produce an agent that never reports. CLIs without
MCP support (e.g. Ollama) speak a **sentinel dialect** instead — echo-safe
marker lines parsed from the PTY, same events, same question registry.

Lifecycle, questions, progress, integration and budget all arrive as typed
**events** (eighteen kinds) on a per-workspace queue with cursors; the ring
keeps the last 1000 and the on-disk journal keeps everything.

## Git isolation — and how work comes back

- **Every agent gets its own worktree and `vertragus/*` branch** — parallel
  agents (and parallel workspaces on the same repo) never trample each other.
  Nothing is auto-deleted; the panel's broom lists stale worktrees for
  explicit cleanup.
- **Workers never commit.** When an agent reports done, the host snapshots
  its dirty worktree into a commit on the agent's branch (pinned committer
  identity, `--no-verify`, no push) and attaches host facts — branch, HEAD,
  changed files, diffstat — to the `agent_done` event.
- **Handoffs are packages, not prose.** `start_agent{baseBranch}` inserts the
  predecessor's own report, status and file list between task and contract,
  with the standing instruction to verify against the checkout.
- **Promote is a human click.** Merging the final result into the
  repository's own branch happens from the panel (and refuses a dirty main
  checkout); the orchestrator never runs git itself, and the remote
  allow-list deliberately has no promote verb.

## The human stays in the loop

- **Steering:** a composer on every workspace card (panel and phone) sends a
  `user_message` that wakes the orchestrator's `await_events` immediately.
  The text shows in its terminal display-only — delivery is the event, so
  there is no second brain typing into the TUI.
- **Questions in both directions:** an agent's open question shows as a `?`
  badge answerable from panel or phone (one host path, one question
  registry); the orchestrator's `ask_user` shows on the workspace card the
  same way.
- **Idle watchdog:** an orchestrator process that is alive but has stopped
  calling tools for two minutes gets flagged (`orchestrator_idle`) on the
  card and the remote client — distinct from process death, and long-polls
  don't false-positive.
- **Subagent policy tiers** (`yolo` / `ask-user` / `ask-orchestrator`)
  govern how far agents act on their own — see the threat model below.

## Scale and endurance

- **Leads (depth 1, opt-in):** the root can start sub-orchestrators that own
  one area each with their own team and event queue. Fan-in is the point: a
  subtree's events never flood the root, grandchildren are invisible to it,
  leads never talk to each other, and a dying lead's agents are reparented to
  the root (`subtree_adopted`). The host never auto-nests.
- **Succession:** when the root's context fills, `request_succession` hands
  the same workspace — team, queue, open questions — to a fresh-context
  successor; the old orchestrator token is rotated so the predecessor is
  locked out at cutover.
- **Runtime budget:** `maxRuntimeMin` is a wall clock over agent-seconds
  (never a guessed token counter): a warning at 80 %, no new starts once
  spent.
- **Journal & resume:** every event of a run is appended to
  `.vertragus/runs/<id>/events.jsonl` (plus a `meta.json` with goal and
  identity) in the repository. "Resume last run" on the Play fold-out starts
  a **new** orchestrator briefed on the previous run — its agents, branches
  and reports. Honestly scoped: worktrees and branches survive and can be
  chained via `baseBranch`; processes and open tickets do not, and the
  briefing says so.
- **Memory:** each run ends in a retrospective — per-model strengths and
  weaknesses steer future model choice, durable **repo notes** feed the next
  orchestrator's briefing (alongside the project doc and recent `git log`),
  and both are inspectable and deletable in the panel's retro view. No RAG,
  no index.

## Providers

Provider presets ship for **Claude Code, Codex, Kimi, Cursor Agent, Grok
Build and Ollama**; custom providers are data, not code — command, args,
model/effort flags, yolo flags, MCP attach dialect, system-prompt delivery.
The in-app MCP server is loopback-only with per-identity tokens
(orchestrator / lead / subagent), and each CLI is attached through its own
verified dialect: a strict transient config file (Claude), process-local
`-c` overrides (Codex), or a merged project file in the agent's worktree
(Kimi, Cursor, Grok — token-carrying files are kept out of the user's git
history). Orchestrators and leads run on a strict tool allow-list; workers
run unrestricted — their discipline is the contract, not a tool cage.

A slot can declare **extra MCP servers** (`extraMcp: [{name, url}]`, e.g. a
browser tool) that its agents attach in addition to Vertragus — subagents
only, never the orchestrator or a lead, and the name `vertragus` is reserved
so nothing can shadow the reporting channel.

## Desktop niceties

Translucent, theme-aware windows with adjustable glass; per-role window
colours that match the panel's status dots; per-profile **zones** that pin
role windows to screen regions; a global hide-all hotkey; autostart and a
self-updater with a stable/main channel switch; German and English UI.

## Remote access (Tailscale)

Vertragus can be driven from your phone or another browser while it runs on
your PC. It is **off by default**; enable it under **Settings → Remote access**.

- **Transport is your tailnet.** The remote server binds, by default, to the
  machine's auto-detected [Tailscale](https://tailscale.com) address
  (`100.64.0.0/10`). Traffic is WireGuard-encrypted by Tailscale end to end, so
  Vertragus adds no TLS and opens no port to the public internet. `0.0.0.0`
  (all interfaces, including your LAN) is available behind an explicit typed
  confirmation — use it only when you understand the exposure.
- **Pairing.** Enabling generates a 256-bit pairing token, shown as a QR code
  and a link. Scanning it on a device on the same tailnet exchanges the token
  for a session; the token is stored encrypted at rest (Electron `safeStorage`)
  and, so the QR survives a restart even without a keyring, in a 0600 file
  under userData. Regenerating it is the only way the link changes — it
  disconnects every paired device. The phone also keeps the pairing token in
  `localStorage` and silently mints a new session if the desktop restarted.
- **What a remote device can do.** Watch any agent's terminal live, type into
  it, start a workspace **with a goal** (the host seeds it into the
  orchestrator over the same handshake as any assignment; starting without a
  goal stays allowed and the card says "no goal — the orchestrator is
  waiting"), stop workspaces, send the orchestrator a steering message, and
  **answer an agent's open MCP question** from its `?` badge. The command
  allow-list is exactly six verbs: `workspaces:list`, `workspaces:start`,
  `workspaces:stop`, `profiles:list`, `answer_question`, `user_message`.
  There is no `focus_agent` or `stop_agent` on the gateway.
  `answer_question` takes the same host path as the orchestrator's
  `send_to_agent{questionId}`, so it resolves the parked `ask_orchestrator`
  wait (and delivers sentinel answers into the agent's PTY) — one question
  registry, one truth. Typing into a raw PTY still only reaches the CLI
  (permission dialogs live there). A remote device **cannot** edit profiles,
  providers or settings, touch windows or zones, remove worktrees, or promote
  branches.
- **Threat model — read this.** By default subagents run in YOLO mode
  (`--dangerously-skip-permissions`). **A paired device therefore has code
  execution on your PC through the agents it drives.** Only pair devices you
  would trust with the machine itself. The settings section lists connected
  devices and lets you disconnect any of them; disabling remote access or
  regenerating the token severs every session immediately. The full threat
  model — the three subagent policy tiers (`yolo` / `ask-user` /
  `ask-orchestrator`), what each one actually enforces, and how to report a
  vulnerability — lives in [`SECURITY.md`](SECURITY.md).

## Signing

Downloads are **unsigned by choice** — certificates are a recurring cost
this project does not carry. Windows SmartScreen interrupts the installer's
first run: click **More info → Run anyway**. Verify any download against the
sha512 hashes in the release's `latest.yml` / `main.yml`, the same values the
auto-updater checks. Releases carry no macOS files at all, because
Squirrel.Mac refuses unsigned auto-updates and a mac build that can never
update itself is worse than none — build it locally with
`pnpm run build:mac`. The signing machinery is implemented and dormant, so
this is one secret away from changing. Details and the verification recipe:
[`docs/SIGNING.md`](docs/SIGNING.md).

## Install

Download the installer for your system from the
[releases page](https://github.com/Nehmo101/Vertragus/releases):
`Vertragus-<version>-setup.exe` on Windows, `.AppImage` or `.deb` on Linux.
Windows SmartScreen will interrupt the first run — click **More info → Run
anyway**; downloads are unsigned by choice, and
[`docs/SIGNING.md`](docs/SIGNING.md) explains why and how to verify a file
against the hashes the auto-updater itself checks.

**There is no macOS download.** Squirrel.Mac refuses to apply unsigned
updates, so a mac release would install once and never update itself again;
shipping nothing is the more honest option. On macOS, build it from a
checkout (see Development below) — everything works, only the packaged
download is missing.

Updates arrive on their own. Settings offers two channels: **stable**, which
follows tagged releases, and **main**, which follows every green build of the
default branch.

## Before the first run

Vertragus drives agent CLIs — it does not ship or replace them. Install at
least one yourself and sign in, in your own terminal:

| CLI | Install | Sign in |
| --- | --- | --- |
| Claude Code | `npm i -g @anthropic-ai/claude-code` | `claude auth login` |
| Codex | `npm i -g @openai/codex` | `codex login` |
| Kimi, Cursor, Grok Build, Ollama | see each vendor's instructions | vendor-specific |

Nothing else is required. Vertragus stores no API keys of its own and never
logs in for you: the CLI you already trust keeps its own session.

## The first run

The panel opens with a **first-steps card** that walks the four things a
first run needs, in the order it actually fails in:

1. **Which CLIs were found** — a dot per provider, with what went wrong when
   one cannot start. Install one and press ⟳.
2. **Login status** — for CLIs that expose one, plus the exact command to
   copy when they do not. Signing in happens in your terminal; Vertragus only
   shows the command.
3. **The first profile** — a repository path and an orchestrator. The rest can
   stay as it is.
4. **Press ▶** — the field beside it carries the goal. Leave it empty and the
   orchestrator waits for word.

From then on the workspace card is the run: agent rows with their status, the
shared **task board** (read-only — completing a task stays the orchestrator's
decision after it verified the work), a composer to steer, `?` badges for
questions in either direction, and a folder button that opens the run's own
artefacts (`spill/`, `tasks.json`, the event journal). When an orchestrator
dies or goes silent, **Replace orchestrator** hands the same team, queue and
board to a fresh-context successor.

Something not going the way you expect is covered in
[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

## Development

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev        # launch with HMR
corepack pnpm run ci     # lint + typecheck + test + build — the canonical gate
```

`VERTRAGUS_DEV_RUN=<repo> pnpm dev` starts a headless dev workspace on a real
repository without touching the UI. The test suite (1500+ tests) includes
integration tests that drive the full MCP loop over a real HTTP server and
the orchestration chain over a real git repository — worker fix, snapshot
commit, `inspect_agent`, tester on the worker's branch, clean orchestrator
worktree.

Windows is the primary, owner-verified platform; macOS and Linux are built in
CI on a best-effort basis.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the build/test workflow and the
language policy (docs are English-canonical with maintained German `.de.md`
twins), and [`CHANGELOG.md`](CHANGELOG.md) for what changed.

## License

[MIT](./LICENSE) © 2026 Nehmo101
