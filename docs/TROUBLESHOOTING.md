English | [Deutsch](TROUBLESHOOTING.de.md)

# Troubleshooting

## The first-steps card says no CLI was found

Vertragus looks for the provider's command on your `PATH`. Two common causes:

- **It is genuinely not installed**, or installed for a different user. Run
  the command yourself in a terminal (`claude --version`); if that fails,
  Vertragus cannot find it either.
- **The app was launched from Finder or the Dock on macOS.** A GUI app
  inherits a minimal `PATH`, not the one your shell builds. Vertragus reads
  your login shell's `PATH` to compensate; if your CLI lives somewhere only a
  non-standard shell config exports, start Vertragus once from a terminal to
  confirm, then move the CLI onto a normal path.

Press ⟳ on the card after installing — it re-probes rather than serving the
cached answer.

## A CLI is installed but reports "not signed in"

Sign in where the CLI wants you to: its own terminal session. Vertragus shows
the exact command and copies it for you, but it never runs a login flow on
your behalf. Those flows open browsers and print device codes; a puppet
typing into them would break on the first prompt change and could not tell
you honestly whether it worked.

Some CLIs expose no status command at all. Those report **unknown**, not
"signed out" — Vertragus does not guess.

## The orchestrator is marked idle

`orchestrator_idle` means the process is alive but has not called a tool for
two minutes. That is different from a crash: long-polls do not trigger it,
because a parked `await_events` counts as activity.

Usually the CLI is waiting on something invisible — a permission prompt in
its own terminal, or a model that stopped mid-turn. Focus its window and
look. If it is genuinely stuck, **Replace orchestrator** on the card starts a
successor with a fresh context that keeps the team, the queue and the board.

## An agent's window died without reporting

The card greys the agent out and the event says `confirmed: false` — the
process ended without a terminal report. Its worktree, branch and any commits
survive; nothing is cleaned up automatically.

Read the terminal tail with the orchestrator's `read_output`, or open the
run folder from the card and look at the journal. If the work is usable,
chain a new agent onto that branch (`start_agent{baseBranch}`); if not, its
worktree can be removed with the panel's broom.

## `integrate_conflict` — a merge was refused

The host merged one agent's branch into another's worktree and hit a
conflict. Nothing was changed: the merge is aborted and the worktree stays
clean, which is the point — a half-merged checkout is worse than no merge.

The event names the conflicting files. Task an agent with resolving it (give
it both branches), or restructure the work so the two agents stop editing the
same lines. The orchestrator never resolves conflicts by running git itself.

## Promote refuses to run

Promoting merges an agent's branch into the repository's own checkout, and it
refuses while that checkout is dirty. Commit or stash your own changes first.
This is deliberate: promote is the one place where agent work reaches the
branch you actually work on, and it must never silently mix with uncommitted
edits of yours.

## Stale worktrees pile up

Nothing is auto-deleted — not worktrees, not branches, not run artefacts.
That is a doctrine choice: an agent's checkout is evidence until you decide
otherwise.

The panel's broom lists worktrees no live workspace is using, and removes
only what you tick. Branches stay either way; delete them with git when you
are done with them.

## Where run artefacts live, and whether they can be deleted

Every run writes into `.vertragus/runs/<workspaceId>/` inside the repository
it works on:

| File | What it is |
| --- | --- |
| `events.jsonl` | the run journal — every event, past the in-memory ring |
| `tasks.json` | the task board snapshot |
| `succession.json` | an unconsumed handoff package, if a succession was in flight |
| `spill/` | oversized tool output, kept verbatim instead of truncated |

All of it is safe to delete when a run is over. The cost is memory:
`search_runs` finds nothing in a deleted journal, and "resume the last run"
has nothing to resume from.

## The phone cannot pair

Remote access is off by default and binds to your Tailscale address. If the
settings show no address, Tailscale is not running or this machine is not in
your tailnet.

The pairing token is stored encrypted through the OS keyring. On a machine
with a locked or absent keyring, unlocking fails — the settings say so.
Regenerating the code is the only rotation path, and it severs every existing
session immediately.

## The panel looks black instead of translucent

The glass effect needs a compositing window manager. On Linux without one
(some bare X11 sessions), the panel falls back to an opaque background rather
than rendering as an unpainted rectangle. Zone tiling is also unreliable
under Wayland, which gives applications no absolute window positioning at
all — that is a platform limit, not a setting.

## Cursor Agent asks to approve every MCP server

Vertragus launches Cursor with `--approve-mcps` and also writes
`~/.cursor/projects/<slug>/mcp-approvals.json` for every server in that
worktree's `.cursor/mcp.json` (the same state-file trick as Claude/Kimi
trust). Orchestrators never get `--force` / `--yolo`.

If the TUI still stops on a confirmation, the greyhound overlay lifts to
click-through (`waiting`) so you can click Approve in the window. The first
turn stays on hold until the Vertragus MCP session exists — that is
deliberate, so `await_events` does not burn tokens against missing tools.

If approvals keep returning after an update, the hash format Cursor uses
may have changed — open an issue with the Cursor CLI version.

## Cursor Agent crashes immediately on Windows

The orchestrator window prints `Error: node-loader:` / `An Application
Control policy has blocked this file`, then the panel says the orchestrator
never became ready. The blocked file lives under
`%LOCALAPPDATA%\cursor-agent\versions\…\` and is an unsigned native addon
(`.node`) — commonly `file_service.win32-x64-msvc.node` or
`merkle-tree-napi.win32-x64-msvc.node`.

That is Windows Smart App Control, AppLocker, or WDAC refusing to load the
addon. Vertragus cannot override the policy. Confirm it outside the panel:
`cursor-agent` in a normal terminal dies the same way.

What to do:

- **Smart App Control** (Windows Security → App & browser control). Microsoft
  documents no per-file exception; turning it off and restarting is the
  workaround they publish. [Cursor tracks this](https://forum.cursor.com/t/windows-11-pro-smart-app-control-cursor-agent-fails-to-start-because-merkle-tree-napi-win32-x64-msvc-node-is-blocked/164831)
  as unsigned native modules in the agent install — signing those files is
  Cursor's fix, not Vertragus's.
- **AppLocker / WDAC / company EDR.** Ask for an allow rule covering
  `%LOCALAPPDATA%\cursor-agent\`. Defender exclusions do not bypass
  Application Control.
- If Smart App Control is already off and a normal terminal still dies, this
  is a Cursor CLI bug. Open it with them; attaching the orchestrator window
  dump is enough.

## Something else

Open an issue with your OS, the Vertragus version (Settings shows it), the
provider CLI and its version. If a run is involved, the journal in the run
folder is the most useful thing you can attach — it holds every event the
orchestrator saw.
