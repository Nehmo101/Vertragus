English | [Deutsch](RESEARCH-LANDSCAPE.de.md)

# Competitive landscape: tools in Vertragus's neighbourhood

Stand: 26 August 2026. No code in this change — a map of neighbouring
tools, what they are good at, and which of their ideas would actually
fit Vertragus.

Primary sources: product sites and docs, GitHub READMEs, and a handful
of 2026 round-ups. Treat marketing copy as a claim, not a measurement.
The filter for "worth taking" is the handbook doctrine in
[`HANDBOOK-HARNESS.md`](HANDBOOK-HARNESS.md), not a generic agent
roadmap. An earlier, code-level study of one harness lives in
[`RESEARCH-DEEPSEEK-HARNESS.md`](RESEARCH-DEEPSEEK-HARNESS.md).

---

## How this map is drawn

Vertragus sits in a young category that did not have a stable name a
year ago. Round-ups call it an *agentic development environment*, a
*CLI orchestrator*, or an *agent kanban*. The shared job: you already
have coding-agent CLIs; the product is the layer that runs several of
them at once without them trampling each other.

Three layers, not one market:

| Layer | What it sells | Typical names |
| --- | --- | --- |
| **A. Desktop CLI orchestrators** | Worktrees, terminals, review, a human operator | Conductor, Emdash, Pane, Nimbalyst, Vibe Kanban, Claude Squad |
| **B. Sandboxed / remote workspaces** | Isolation stronger than a directory, or compute not on the laptop | Sculptor, OpenHands Agent Canvas, Mux, Warp |
| **C. Vendor harnesses** | The CLI itself growing teams, cloud VMs, missions | Claude Code Agent Teams, Codex, Cursor Cloud Agents, Factory Droid, Copilot |
| **D. Cloud-native agents** | Ticket in, PR out, no local CLI | Devin, Jules, Copilot cloud agent |

Vertragus is **A with a C-shaped core**. The panel looks like Conductor
or Pane. The loop — blocking MCP, host-truth git, hub-and-spoke
identities, succession, a CAS task board — is closer to a harness than
to a session multiplexer. Most A-tools still leave planning,
delegation, and merge decisions on the human. Vertragus puts those on
the orchestrator, with the host as the only path.

That is the comparison that matters. Feature checklists that treat
"has a kanban" or "has Slack" as wins miss the product.

---

## What Vertragus already is (do not rebuild)

Things neighbouring tools still mostly lack, and that this repo should
not re-implement as a second product:

- **One MCP loop, true long-poll.** `await_events` is blocking. No
  busy-wait, no starving workers. Typed events on a cursor queue, with
  an on-disk journal.
- **Host truth over agent prose.** `inspect_agent` reads the worktree;
  `agent_done` carries host facts; `integrate_branch` is a host merge;
  workers never commit; promote is a human click (or a profile
  Automation that still uses the same host merges).
- **Hub-and-spoke, not a hive.** Subagents and leads do not talk to
  each other. Fan-in is the point. Depth is capped (lead, then one
  helper level). The handbook names peer-to-peer as a non-goal.
- **Slots as a blueprint, not a pre-started crew.** Play starts the
  orchestrator; it decides whom to spawn, bounded by caps.
- **Endurance.** Succession (fresh-context root, same team), a CAS task
  board that survives it, structured `resultSchema` reports, spill
  instead of silent truncation, `search_runs`, retros and repo notes
  (no RAG).
- **Human in the loop as an event.** `user_message`, `ask_user`,
  question badges on panel and phone, policy tiers
  `yolo` / `ask-user` / `ask-orchestrator`.
- **First-party `/browser`**, not a second MCP server. Chromium
  extension on the existing loopback listener.
- **Windows as the primary, owner-verified platform.** Several polished
  competitors are macOS-only.
- **Tailscale remote** with a seven-verb allow-list. Phone can start,
  steer, and answer questions; it cannot edit profiles or promote.

Named limits, already in the README: unsigned downloads, no macOS
release artefact, agents are not sandboxed. The mid-run provider reseat
is spec-only — see [`MODEL-PROVIDER-SWITCH.md`](MODEL-PROVIDER-SWITCH.md).

---

## Category A — desktop CLI orchestrators

These are the closest products. They wrap the same CLIs, give each
session a git worktree, and put a human in front of a fleet. Almost
none of them make the *agents* a coordinated team; the human is the
orchestrator.

### Conductor

[conductor.build](https://conductor.build/) — Melty Labs, macOS-only
desktop, closed source, free today with paid collaboration planned.
~$22M Series A. The most polished "many agents, one Mac" app in 2026
write-ups.

**What it is:** parallel Claude Code, Codex, Cursor, and OpenCode
sessions, each in an isolated workspace (git worktree + branch). The
product is the review-and-merge step: sidebar, live status, a serious
diff viewer, PR page with checks, archive.

**What makes it:** low ceremony. Setup / run / archive **scripts** per
project (`.conductor/settings.toml`), **files-to-copy** for gitignored
secrets (`.env`), a Run button that starts the app from the workspace,
Linear as an optional intake, a `/resolve-merge-conflicts` slash
command, a Conductor API. Workspace notes in a gitignored `.context`
folder. Native Mac chrome.

**What it is not:** a multi-agent *harness*. You assign the work. There
is no blocking MCP team loop, no host-side `integrate_branch` contract,
no succession, no leads. macOS only — Vertragus's Windows-first stance
is a real counter.

### Emdash

[emdash.sh](https://emdash.sh/) /
[github.com/generalaction/emdash](https://github.com/generalaction/emdash)
— YC W26, Apache-2.0, Electron, macOS / Windows / Linux. Marketed as an
Agentic Development Environment.

**What it is:** 20+ CLI providers in a registry (Claude Code, Codex,
Amp, Cursor, Copilot, Gemini, Droid, OpenCode, Goose, Kimi, Kiro, Pi,
Cline, …), auto-detected. Each task is a worktree + PTY + conversation
+ review state. Built-in Monaco diffs. `gh` for PRs **and CI tracking**.
Linear / Jira / GitHub / GitLab / Notion / Asana as ticket intake.

**What makes it:** a **worktree pool** (pre-created reserves, claim in
~0.5–1 s instead of 3–7 s); **SSH remote execution** so the agents run
on a bigger machine; **Agent Skills** (`agentskills.io`) synced into
each vendor's native skills directory; preserve-patterns for `.env` and
`.claude/**`; provider-agnostic spawn (flags, keystroke injection,
session-id, resume). Bring-your-own-infra setup/teardown scripts.

**What it is not:** an orchestrator that *is* a team member. Emdash is
mission control for independent tasks. No host-truth merge gate, no
blocking event loop between agents, no succession. Automatic push-on-
create is the opposite of Vertragus's "workers never commit / never
push" rule.

### Pane

[runpane.com](https://runpane.com/) /
[github.com/dcouple/Pane](https://github.com/dcouple/Pane) — AGPL-3.0,
Electron, first-class Windows / macOS / Linux. Keyboard-first ("Vim
for agent management"). Agent-agnostic: if it is a CLI, it is a pane.

**What it is:** create a pane → worktree + agent + prompt. Built-in
diff, file explorer, commit / push / rebase / squash / merge from
shortcuts. A `runpane` CLI so an agent can spawn more panes. Remote
Pane: self-hosted daemon on loopback, exposed through Tailscale Serve
(or an explicit tunnel), desktop *or* phone PWA.

**What makes it:** **per-pane port ranges** so five `localhost:3000`
dev servers do not collide; **automatic secrets copy** into every
worktree; **cross-pane `@` mentions** to pull another terminal's
output into the current prompt; session persistence; Windows treated
as a first-class market, not a leftover.

**What it is not:** a coordinated team. Isolation and operator UX, not
a hub-and-spoke contract. Delete-pane-deletes-worktree is
autodelete — a named Vertragus non-goal. Remote is closer to "the
whole ADE lives on another box" than Vertragus's seven-verb phone
gateway.

### Nimbalyst

Formerly Crystal. [nimbalyst.com](https://nimbalyst.com/) — MIT
desktop + iOS, Claude Code / Codex first-class, OpenCode and Copilot
in alpha. Sessions on a kanban, one-click worktrees, inline file
review, linked files and sessions, visual editors (markdown, mockups,
diagrams). Native **iPhone** app for diffs and resume. Teams SKU.

**What makes it:** the operator surface is a *workspace above the
harness* — planning artefacts and sessions in one place — plus the
only native phone app in this list. Vertragus's remote client is a
PWA on the tailnet, not an App Store binary.

**What it is not:** host-side orchestration. The board is for humans.

### Vibe Kanban

[github.com/BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)
(~28k stars) / [vibekanban.com](https://vibekanban.com/) — Apache-2.0,
`npx vibe-kanban`. The company behind it shut down on 10 April 2026;
the local tool continues as community OSS. Paid cloud is gone.

**What it is:** the purest *agent kanban*. Issues → workspaces (branch
+ terminal + **dev server**) → inline diff comments that go back to
the agent → **in-app browser preview** (devtools, inspect, device
emulation) → PR. 10+ agents (Claude Code, Codex, Gemini, Copilot, Amp,
Cursor, OpenCode, Droid, Qwen Code, …). Central MCP config. SSH when
the board itself runs on a remote box.

**What makes it:** review-as-the-product, including *seeing the running
app*, not just the diff. Sub-issues. Team-shaped issue tracker.

**What it is not:** a live company, and not a harness. The handbook
names "kanban as a second orchestration product" as a non-goal;
Vertragus already has a host task board (`task_*`, CAS) that is *not*
a planning UI for humans.

### Terminal-native managers

- **Claude Squad** ([smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad),
  AGPL-3.0, ~8k stars): tmux + worktrees + a TUI. Claude Code, Codex,
  Gemini, OpenCode, Amp, Aider. YOLO flag. Review before applying.
  The lean default if you live in tmux.
- **Agent-Manager** ([YoanWai/agent-manager](https://github.com/YoanWai/agent-manager),
  MIT, Go): tmux sessions that survive the manager quitting. Full-file
  diff with **line comments piped back into the pane**. Resource
  gauges (CPU / RAM / disk / net) per process tree. Prompt injection
  without attaching.
- **Paneflow**: GPU-native multi-pane terminal, branch-aware,
  agent-agnostic. A control room, not a board.
- **abtop** ([graykode/abtop](https://github.com/graykode/abtop)): not
  a manager — `htop` for coding agents. Token usage, context-window
  fill, rate limits, child processes, open ports. Complements every
  tool in this list, including Vertragus.

### Other ADE desktops

- **Daintree** ([daintreehq/daintree](https://github.com/daintreehq/daintree)):
  many terminals × many worktrees, action palette (300+ actions),
  **broadcast one prompt to N agents**, context injection, an
  Assistant that drives the palette from your existing CLI, and an
  **MCP server with per-tier auth, audit log, and idempotency** so
  agents can call Daintree. Closest cousin to "the host is a tool".
- **Codeg** ([codeg.app](https://docs.codeg.app/guide/git)): aggregate
  sessions from many CLIs; `@mention` another agent into the current
  thread (side-by-side Claude + Codex); unattended to-do board with
  worktrees; native iOS/Android; ACP-compatible agents; a real Git
  client (commit / stash / rebase from the UI).
- **MindFlock**: Electron + tmux + worktrees, guided commit → push →
  PR → merge, **ticket ingestion** (Shortcut, Jira, Linear, GitHub,
  Asana) that *auto-starts* a seeded session per ticket.
- **Superset** ([superset.sh](https://superset.sh/)): macOS (Linux
  AppImage experimental), any CLI, worktrees, persistent terminals,
  **scheduled automations**, TypeScript SDK, **MCP server** to drive
  the ADE from another agent. Windows not yet.
- **Golutra**: Tauri, "one person, one AI squad", prompt injection
  into terminal streams, workflow templates, BSL 1.1. Roadmap: CEO
  agent, mobile remote.
- **Opcode** (formerly Claudia): Claude Code GUI, background agents.
  Development stalled — listed so it is not mistaken for a live bet.

---

## Category B — sandboxed and remote-execution workspaces

Worktrees isolate *files*. They do not isolate processes, ports,
`node_modules`, or a runaway `rm`. This layer treats that as the
actual problem.

### Sculptor

[imbue.com/product/sculptor](https://imbue.com/product/sculptor) /
[github.com/imbue-ai/sculptor](https://github.com/imbue-ai/sculptor)
— MIT, Imbue. Each agent in a **Docker / devcontainer** with its own
filesystem and git. Local repo untouched until you pull.

**What makes it:** **Pairing Mode** (mirror the container into your
IDE, two-way sync, then restore the original checkout); cached
devcontainer images so startup is seconds not minutes; CI Babysitter
(dispatch an agent at a red pipeline); fork an agent from a point in
session history; Pi as a swappable harness; Skills that run as full
agents. Merge Review UI for pull/push between container and host.

**Why it matters for Vertragus:** the README already names "agents are
not sandboxed". Sculptor is the existence proof that parallel coding
agents *can* stay off the host FS and still be reviewable. Pairing
Mode is a better "open this agent's work in my editor" than focusing
a PTY.

### OpenHands Agent Canvas

[openhands.dev/product/canvas](https://www.openhands.dev/product/canvas)
— local visual workspace, MIT core. Parallel worktrees. Connects to
OpenHands *or* Claude Code / Codex / Gemini CLI through the **Agent
Client Protocol** (ACP: JSON-RPC on stdio). Backends: laptop, remote
VM, OpenHands Cloud, Kubernetes. Automations on Slack / GitHub /
cron. MCP + Agent Skills library.

**What makes it:** ACP as a *second attach dialect* next to MCP.
Vertragus already special-cases Claude / Codex / Kimi / Cursor / Grok
/ Pi / sentinel. ACP is the emerging "editor ↔ coding agent" standard
(Zed, Copilot CLI, Canvas, dsh). A dialect here would cover agents
that will never speak Vertragus MCP.

### Warp and Mux

- **Warp**: an agentic terminal that auto-detects third-party CLIs
  (Claude Code, Codex, OpenCode, Amp, Copilot, Cursor, Gemini, Droid,
  Pi, Goose, …) and wraps them with a rich input editor, **desktop
  notifications**, **inline code-review comments**, Remote Control,
  and tab metadata. Not a worktree manager — a better glass around
  one (or several) CLIs. The notification + inline-comment pattern is
  the portable idea.
- **Mux** (Coder): local / worktree / **SSH** execution under one UI,
  own multi-model agent loop, desktop + browser. For teams that want
  agents on servers, not only laptops.

---

## Category C — vendor harnesses that now ship teams

These are not alternatives to the panel so much as the CLIs Vertragus
already drives — growing their *own* multi-agent stories. If they
become good enough, a thin ADE is unnecessary. If they stay
single-vendor, a panel that mixes them still has a job.

### Claude Code Agent Teams

Experimental (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). A lead
session plus 2–16 teammates, each with a full context window and its
own worktree. Shared task list under `~/.claude/tasks/`. **Mailbox
`SendMessage` — peer-to-peer**, including broadcasts. Teammates load
CLAUDE.md, MCP, and skills independently. Known limits around resume,
task coordination, and shutdown. Token use is several times a single
session.

Subagents (the `Agent` tool) remain the cheap parent-child path.
Teams are the hive.

**Collision with doctrine:** peer-to-peer is a named Vertragus
non-goal. The interesting steal is not the mailbox; it is
worktree-per-teammate *inside one vendor* plus a shared task list.
Vertragus already has both, host-side, across vendors.

### Codex

CLI + app + IDE + cloud. TOML-defined subagents, path-based
addressing, batch. Built-in worktrees and cloud environments. Skills,
automations, OS-level sandboxing, approval gates, RBAC in the
enterprise story. Ultra / parallel modes keep coordination inside
OpenAI's harness.

**Steal:** sandbox defaults that are *not* YOLO; cloud as an
execution backend rather than a second product; automations that
still end in a PR the human reviews.

### Cursor Cloud Agents

Isolated VMs with a full desktop. Agents click a mouse, drive a
browser, run tests, open PRs, attach **video artefacts**. Multi-repo
environments. MCP (including a Cloud MCP for run diagnostics).
Triggers: editor, cursor.com/agents, Slack `@Cursor`, GitHub
`@cursor`, Linear, API, Automations (schedule, PagerDuty, webhooks).
Hand the remote desktop back and forth with the agent. Secrets,
egress allow-lists, Tailscale into private networks.

Vertragus already has a Chromium extension against the *user's*
browser. Cloud Agents have a *disposable* desktop. Different safety
story, different cost.

### Factory Droid and GitHub Copilot

- **Factory Droid**: coordinator + specialist droids (code, review,
  test, docs, knowledge) + custom droids. Missions (`droid exec
  --mission`). Linear/Jira as first-class intake. OS sandbox
  (filesystem + network proxy) with inherited policy for subagents
  and hooks. `--worktree`, `--auto low|medium|high`, Skills, hooks,
  `AGENTS.md`. Headless CI. Droids post back to the ticket.
- **GitHub Copilot**: cloud agent (issue / comment → branch → PR →
  iterate on review). Desktop Copilot app: parallel sessions, local
  worktrees, cloud sandboxes, automations, canvases. Deepest GitHub
  enterprise controls. Copilot CLI speaks ACP.

### DeepSeek Harness

Already researched in [`RESEARCH-DEEPSEEK-HARNESS.md`](RESEARCH-DEEPSEEK-HARNESS.md).
Phase G took spill, quiet events, `resultSchema`, the CAS board, and
`search_runs`. Still unadopted and still interesting: OS sandbox +
permission presets, shadow-price compaction / token meter, ACP
server, LSP tools, Code Mode (`run_code`), session FTS, plugin seams.
Agent Teams in dsh share a *single* checkout — weaker isolation than
Vertragus.

---

## Category D — cloud-native agents

**Devin** (Cognition): isolated machines, playbooks, org knowledge,
child sessions, schedule, APIs. Best on well-scoped backlog tickets;
weak on fuzzy pair work. Reviewer latency is the bottleneck.

**Google Jules**: ephemeral cloud VMs, GitHub-integrated or
"repoless" (a preconfigured runtime as a serverless function). SDK
`jules.all()` for bounded-concurrency fleets. Plan approval. Not a
local CLI wrapper.

These compete for *delegated* work, not for "I am watching six PTYs
on my PC". Vertragus should not grow a cloud runner (handbook
non-goal). It should stay the best *local, mixed-vendor, host-truth*
loop — and make review and isolation good enough that you do not
leave for Devin on everyday tasks.

---

## Feature comparison

| Capability | Vertragus today | Common in neighbours |
| --- | --- | --- |
| Mixed-vendor CLI wrap | Yes (6 presets + custom + Pi wrap) | Emdash 20+, Pane any CLI, Warp 14+ |
| Worktree per agent | Yes, mandatory, no autodelete | Almost universal in A |
| Blocking MCP team loop | **Yes — distinctive** | Rare (Daintree/Superset expose MCP *of the ADE*; dsh/Claude Teams are single-vendor) |
| Host-truth inspect / snapshot commit / integrate | **Yes — distinctive** | Review UIs; merge is usually a human git click |
| Hub-and-spoke + leads + 1 helper level | **Yes — distinctive** | Claude Teams are P2P; most ADEs have no team at all |
| Succession + CAS task board + structured reports | **Yes — distinctive** | Shared task lists exist; few survive a root transplant |
| Visual diff / inline comments back to the agent | Overlay + `inspect_agent`; no Monaco review pane | Conductor, Emdash, Pane, Vibe Kanban, Warp, Agent-Manager |
| In-app preview of the running app | Chromium *worker tools*, no panel preview | Vibe Kanban built-in browser |
| Worktree setup (.env copy, install script, ports) | No first-class setup/run scripts; no port pool | Conductor scripts, Pane ports+secrets, Emdash preserve-patterns |
| Sandbox / containers | **Named gap** | Sculptor Docker, Factory OS sandbox, Codex OS sandbox, dsh bwrap/Seatbelt |
| Token / cost / context-window meter | Wall-clock `maxRuntimeMin` only | abtop, dsh token meter, Agent-Manager gauges |
| CI status on the PR the host opened | Automation can open a PR; no checks feed | Conductor checks, Emdash CI tracking, Sculptor CI babysitter |
| Issue-tracker intake | No | Emdash, Conductor, MindFlock, Factory, Cursor, Copilot |
| Skills standard (`agentskills.io`) | Per-CLI native, not a host catalog | Emdash sync, OpenHands library, Factory Skills, dsh skills |
| ACP dialect | No (MCP + sentinel + Pi) | OpenHands, Copilot CLI, dsh, Codeg |
| Remote: phone steer | Tailscale + 7 verbs | Pane daemon, Nimbalyst iOS, Emdash SSH *execution* |
| Same-task A/B (two models, pick a winner) | Possible by hand (`start_agent` twice) | Emdash "several agents on the same problem", Sculptor fork |
| Desktop notifications | No | Warp, CodeAgentSwarm |
| Signed macOS download | No (see [`SIGNING.md`](SIGNING.md)) | Conductor, Nimbalyst, Warp |
| Default YOLO | Yes (`yolo` tier) | Codex/Factory default tighter; Sculptor never on the host FS |

---

## Gaps worth taking

Ranked by fit with the existing loop. New power still arrives as a
**host tool, event, or panel surface**, not as a second product.

### High fit — host tools in the existing loop

1. **Review surface (the operator bottleneck).** Every serious ADE
   treats diff-review as the product. Vertragus has host facts and
   `inspect_agent`, but the human still reads a PTY or a raw diffstat.
   A panel (and phone) diff of the agent's worktree, with inline
   comments delivered as `user_message` / `send_to_agent` — one host
   path, no second brain in the TUI — is the highest-leverage UX gap.
   Warp and Agent-Manager already pipe line comments back into the
   agent; Vibe Kanban does it from the board.

2. **Worktree readiness.** Parallel agents that cannot `pnpm dev`
   because `.env` and `node_modules` and port 3000 live on the main
   checkout are theoretically isolated and practically stuck.
   Conductor's setup/run/archive scripts, Pane's port ranges and
   secrets copy, Emdash's preserve-patterns: this is host work, not
   orchestrator cleverness. A profile-level "copy these gitignored
   files, run this setup, assign a port block" would make isolation
   *runnable*. Do not autodelete the worktree afterwards.

3. **Sandbox (already a named README limit).** Worktrees are not a
   security boundary. Factory and dsh show OS-level FS/network
   sandboxes around the CLI; Sculptor shows containers plus a pairing
   path back to the editor. A first version can be opt-in, Linux
   first (bubblewrap / landlock), fail-closed, inherited by helpers.
   This also makes the `yolo` tier honest: YOLO inside a sandbox is a
   different threat than YOLO on the host.

4. **Token, context, and spend signals.** The runtime budget is a
   wall clock. abtop and dsh prove the operator also needs context
   fill, rate-limit, and spend. Even a read-only host snapshot
   (process RSS, last usage from the CLI if it exposes one, open
   ports) would stop "why is this machine on fire" being a guessing
   game. Do not invent a token oracle; measure what the process and
   the vendor already admit.

5. **CI on the PR the host already opens.** Automation can open a
   GitHub PR. Conductor and Emdash then *watch checks*. A `ci_status`
   event (and a card badge) is host truth, same family as
   `inspect_agent`. Sculptor's CI babysitter — spawn a worker on red
   — is a playbook on top, not a new loop.

6. **C7 reseat.** Spec already exists. Neighbours switch models
   mid-session as table stakes (Sculptor/Pi, dsh, every vendor TUI
   `/model`). Rate limits and "wrong model for this phase" are why
   people restart whole ADEs.

7. **More presets, same schema.** Gemini CLI, OpenCode, Amp, Copilot
   CLI, Droid, Qwen Code show up in every ADE matrix. Vertragus
   already treats providers as data. Shipping presets is not a new
   architecture — it is coverage. ACP as an *attach dialect* (next
   to Claude's config file and Codex `-c`) is the one structural
   add, and only for CLIs that speak it.

8. **Desktop / phone notifications on `ask_user`, `agent_done`,
   `orchestrator_idle`.** Warp's whole pitch for wrapping CLIs is
   "ping me when it stops". The events already exist.

### Medium fit — useful, but watch the doctrine

- **Issue-tracker *seed*, not a second tracker.** Emdash/MindFlock/
  Factory pull Linear/Jira/GitHub into the first prompt. A playbook
  or a `workspaces:start {goal}` that pastes the issue body is in
  bounds. Auto-spawning a session per ticket, or becoming an issue
  tracker, is the kanban-as-product non-goal.
- **SSH / remote *execution*** (agents run on a Mac mini or GPU box;
  the panel is a thin client). Different from today's Tailscale
  *control* path. Pane and Emdash do this. It is a backend for
  Workspace, not a new MCP. Keep the allow-list; do not open the
  internet.
- **In-panel preview.** Vibe Kanban's embedded browser is the QA
  loop humans actually use. Vertragus already drives the user's
  Chromium via `/browser`. A host-assigned preview URL (from the
  port block in (2)) on the card is smaller than embedding a
  browser, and stays one path.
- **Same-task A/B as a host operation.** "Start two workers on this
  task, different providers, I will promote one" is two
  `start_agent`s plus a review surface. Do not add a DAG engine.
- **Agent Skills catalog at host level.** Emdash's `~/.agentskills/`
  sync is convenience, not orchestration. Fine as a profile extra;
  not a RAG index.
- **Worktree pool.** Emdash's reserve worktrees are a latency trick.
  Worth it only after setup scripts exist — an empty pooled
  worktree is still missing `node_modules`.
- **Headless / CI spawn.** `droid exec`, `dsh --profile headless`,
  Jules `jules.run`. Vertragus already has `VERTRAGUS_DEV_RUN`. A
  documented non-UI Play that still uses the MCP loop is in
  character; a cloud fleet is not.

### Deliberate non-goals — look attractive, stay out

Copied from the handbook so a shiny competitor feature does not
accidentally become a track:

- Peer-to-peer between subagents or leads (Claude Agent Teams,
  Codeg `@mention` as a *team bus*, dsh experimental teams).
- Kanban / DAG engine / cloud runner as a **product**.
- Autodelete of worktrees (Pane's delete-pane-cleans-up).
- RAG.
- Orchestrator that commits, merges, tests, or pushes *itself*.
- Pre-started crews (playbooks stay goal templates).
- A second MCP server, a second remote that mirrors all IPC, tunnels
  and an account system, parsing vendor TUIs.

Daintree's "MCP of the ADE" is the seductive version of a second
orchestration: agents call 300 host actions. Vertragus already
decided the allow-list stays small and the host stays the only git
hand. Extra MCP on *workers* is the existing escape hatch.

---

## Suggested order (no code in this change)

The parallel adoption plan — waves, file ownership, PR-sized tracks —
is [`PLAN-LANDSCAPE.md`](PLAN-LANDSCAPE.md). If a later change
implements any of this, keep it single-topic and inside the loop:

1. **Review surface** — panel/phone diff from host git, comments as
   `user_message`. Unblocks (5) and A/B.
2. **Worktree readiness** — copy gitignored files, setup script, port
   block. Makes isolation real.
3. **Notifications** on events that already exist.
4. **CI status** on host-opened PRs.
5. **C7 reseat** (spec is ready).
6. **Sandbox opt-in** (Linux first).
7. **Presets + ACP dialect** as coverage, not a rewrite.
8. **Token/context snapshot** as host facts, not a guessed counter.

That order is operator pain first, safety second, coverage third —
the same sequence Conductor, Pane, and Sculptor accidentally agree
on, executed with Vertragus's host-truth rules instead of their
"human is the orchestrator" rules.

---

## Sources

Product and docs (retrieved 26 August 2026):

- [conductor.build](https://conductor.build/) and
  [Conductor docs](https://www.conductor.build/docs)
- [emdash.sh](https://emdash.sh/) and
  [Emdash introduction](https://generalaction-emdash-14.mintlify.app/introduction)
- [Pane](https://github.com/dcouple/Pane), [runpane.com](https://runpane.com/)
- [Nimbalyst](https://nimbalyst.com/)
- [Vibe Kanban](https://github.com/BloopAI/vibe-kanban)
- [Claude Squad](https://github.com/smtg-ai/claude-squad)
- [Sculptor](https://imbue.com/product/sculptor)
- [OpenHands Agent Canvas](https://www.openhands.dev/product/canvas)
- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [Cursor Cloud Agents](https://cursor.com/docs/cloud-agent)
- [Factory Droid CLI](https://docs.factory.ai/cli/droid-exec/overview)
- [Warp third-party CLI agents](https://docs.warp.dev/agents/cli-agents/overview/)
- [GitHub Copilot agents](https://docs.github.com/en/copilot)
- [Jules SDK](https://github.com/google-labs-code/jules-sdk/)
- [Daintree](https://github.com/daintreehq/daintree)
- [DeepSeek Harness notes](RESEARCH-DEEPSEEK-HARNESS.md)

Round-ups used as pointers, then checked against the products:

- [Augment: 9 open-source agent orchestrators](https://www.augmentcode.com/tools/open-source-agent-orchestrators)
- [Nimbalyst: best agent management tools 2026](https://nimbalyst.com/blog/best-agent-management-tools-2026/)
- [Developers Digest: Agent-Manager, Pane, Golutra](https://www.developersdigest.tech/blog/multi-agent-cli-orchestration-tools-compared-2026)
