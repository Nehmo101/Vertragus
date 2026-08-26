English | [Deutsch](PLAN-LANDSCAPE.de.md)

# Landscape adoption plan

Stand: 26 August 2026. No program code in this change.

Implements the gaps in [`RESEARCH-LANDSCAPE.md`](RESEARCH-LANDSCAPE.md)
as **single-topic PRs**, with **parallel waves** wherever the files do
not collide. C7 reseat stays the spec in
[`MODEL-PROVIDER-SWITCH.md`](MODEL-PROVIDER-SWITCH.md). Doctrine stays
[`HANDBOOK-HARNESS.md`](HANDBOOK-HARNESS.md): one host path, no second
product, no autodelete, no peer-to-peer, no RAG, no cloud runner.

Sizes are **S / M / L** (files and risk), not calendar time.

---

## Doctrine for every track

- New power is a **host tool, event, IPC verb, or panel surface** in
  the existing loop — not a kanban product, not a DAG engine, not a
  second MCP server.
- Host truth over agent prose. Diffs come from git against the agent's
  worktree (`inspectWorktree.ts`), never from the PTY tail.
- Comments, steering and answers reuse `user_message` /
  `send_to_agent` / `answer_question`. No second brain typing into a
  parked orchestrator TUI.
- Workers still never commit; promote stays a human click (or the
  existing Automation host merges). Setup scripts may install deps;
  they must not `git commit` / `git push`.
- Fail-loud on contract errors, fail-soft on disk/network extras
  (same shape as `journal.ts` / `pullRequest.ts`).
- Tests sit next to the subject. Coverage ratchet does not go down.
- User-facing strings: renderer i18next **en+de**,
  `src/shared/mainMessages.ts`, `src/remoteClient/i18n.ts` — always
  both locales. Docs: English canonical plus German twin.

---

## How to run tracks in parallel

The bottleneck is not "too many ideas". It is **four hot files**. Two
PRs that both edit one of them will fight, even if the features are
independent.

| Hot file | Why it serializes |
| --- | --- |
| `src/main/workspace/Workspace.ts` | Lifecycle, summary, succession, inspect, PR, budget |
| `src/main/agents/spawn.ts` | Argv, env, MCP attach, yolo flags. Pi wrap exit ([`PLAN-PI-EXIT.md`](PLAN-PI-EXIT.md)) owns this file until it lands. |
| `src/shared/schema/events.ts` | Discriminated union + exhaustive test list |
| `src/shared/schema/profile.ts` | Automation, caps, any per-profile setting |

**Rule:** at most **one open PR** mutates each hot file. Push logic
into a **leaf module** so Wave 1 never needs `Workspace.ts`.

### File ownership

Each track below names a **primary directory**. Other tracks may read
those files, not rewrite them, until the owning PR has landed.

### i18n and IPC merge rules

- Renderer keys live in namespaces: `review.*`, `notify.*`,
  `readiness.*`, `sandbox.*`, `ci.*`, `reseat.*`. Parallel PRs then
  merge `en.json` / `de.json` without overlapping keys.
- New IPC: add the channel in `appIpc.ts` **and** `preload/index.ts`
  in the same PR (`ipc.test.ts` asserts the lists match).
- New remote verb: only when the phone must **do** something the
  summary cannot show. Read-only inspect is the one candidate; it is
  Wave 2 and optional. Do not add `stop_agent` / `focus_agent`.

### What stays serial

- Two preset PRs that both edit `presets.ts` (lane P is a queue).
- Anything that wraps spawn (`W3` port env, then `S1` sandbox).
- Pi wrap exit ([`PLAN-PI-EXIT.md`](PLAN-PI-EXIT.md)) before W3 / S1 / P2
  (`spawn.ts`, Pi block of `attach.ts`, `electron-builder.yml`).
- C7 M1–M3 (one state machine). M2 (panel picker) can overlap M3
  *prep* but must not land before M1.
- Event-kind additions: land in the PR that **first produces** the
  event, not as an empty schema dump.

---

## Wave map

```
Wave 1 — four PRs in parallel (leaf modules)
  N1 notifications          settings + new notify.ts
  P1 extra presets          presets.ts queue (Gemini, then OpenCode, …)
  R1 panel review           IPC → existing inspectAgent
  W1 gitignored copy        worktree.ts + profile preservePatterns
        │
        ▼
Wave 2 — after R1 and W1 (W2/W3 own Workspace.ts + spawn.ts)
  R2 line comments          user_message (no new event)
  R3 phone inspect          optional 8th gateway verb
  W2 setup/run scripts      profile + createWorktreeFor
  W3 port block             spawn env; same PR as W2 preferred
  T1 process snapshot       new processStats.ts + summary fields
        │
        ▼
Wave 3 — after spawn.ts and Workspace.ts are free
  S1 sandbox opt-in         spawn wrapper; SECURITY twins
  C1 CI on host PRs         pullRequest.ts + ci_status event
  C7 reseat M1→M5           existing spec
  P2 ACP attach dialect     attach.ts; not a seventh provider
  V1 preview URL on card    needs W3
        │
        ▼
Wave 4 — medium fit, only once review + readiness exist
  Issue-body playbook seed, skills sync, worktree pool, A/B via R1
```

N1 and P1 do not block Wave 2. If they slip, start Wave 2 anyway.

---

## Wave 1 — four independent PRs

Goal: operator ping, broader CLIs, a human diff, runnable worktrees.
**None of these PRs edit `Workspace.ts` or `events.ts`.**

### N1 — notifications

**Size S. Lane: operator. Files: new `src/main/notify.ts`,
`store/settings.ts`, settings UI, remote `haptics.ts`.**

Subscribe to `WorkspaceDirectory.onChange` / the events the card
already sees. Fire an Electron `Notification` (and the existing phone
haptic) on `ask_user` / `agent_question`, `agent_done`,
`orchestrator_idle`. Opt-in in Settings; default **on** for questions,
**on** for idle, **off** for every `agent_done` (that one is noisy).

No new event kinds. Do not parse the TUI.

**Done when:** a parked `ask_user` produces a desktop notification
with the workspace name, and clicking it focuses the panel; tests
cover quiet/disabled and missing Notification permission.

### P1 — extra presets

**Size S per CLI (M if the attach dialect is new). Lane: providers.
Files: `src/main/providers/presets.ts`, `presetVerification.ts`,
matrix tests. Queue, do not fork.**

Ship **one verified CLI per PR**: Gemini CLI, then OpenCode, then Amp
/ Copilot CLI / Droid / Qwen Code as they are probed. Custom providers
already exist; a preset is coverage, not architecture. Pi stays a wrap,
not a seventh id ([`HANDBOOK-HARNESS.md`](HANDBOOK-HARNESS.md)).

Unknown flags kill a launch — do not guess argv. `PRESET_VERIFICATION`
must name the CLI version actually probed.

**Done when:** the first-run card shows the new dot, spawn tests cover
the preset, and a live probe note is in the PR (or "not installed").

ACP is **not** this track — that is P2.

### R1 — panel review

**Size M. Lane: operator. Files: `appIpc.ts` + preload
(`workspaces:inspect`), `inspectWorktree.ts` (UI-sized unified diff,
unchanged MCP caps), `WorkspaceCard` / a small `AgentDiff` pane,
renderer i18n.**

`Workspace.inspectAgent` already exists. The panel cannot call it.
Expose a **request/response** IPC (not a gateway verb yet) that
returns host git facts for one agent: status, changed files, scoped
diff. Spill oversized bodies the same way MCP does.

A line comment in this wave is a composer prefill
`path:line — text`, sent through existing `workspaces:userMessage`
with the agent as addressee. Full comment UX is R2.

Do not embed a Monaco editor if a simple file list + unified diff
meets the bar. Do not treat `read_output` as the diff.

**Done when:** opening a worker row shows the host diff of that
worktree, a comment sends `user_message` (asserted in tests), and
`inspect_agent` MCP behaviour is unchanged (cap + spill).

### W1 — copy gitignored files

**Size S. Lane: isolation. Files: `src/main/agents/worktree.ts`,
`schema/profile.ts` `preservePatterns`, profile editor.**

After `git worktree add`, copy selected **already-gitignored** files
from the repo checkout into the new worktree (`.env`, `.env.local`,
plus profile patterns). Refuse to copy tracked files. Never commit
them. Default list is small; the user extends it.

Keep the copy **inside `createWorktree`**, so `Workspace.ts` does not
change. Autodelete remains forbidden.

**Done when:** a worktree created from a repo with `.env` (gitignored)
contains that file; a tracked `README.md` is not duplicated by copy;
unit tests cover missing source (skip) and path escape (refuse).

---

## Wave 2 — deepen operator and isolation

Start when R1 and W1 are on `main`. **W2+W3 is the one PR allowed to
edit `Workspace.ts` and `spawn.ts` in this wave.**

### R2 — inline comments

**Size S. After R1. Files: AgentDiff pane only + i18n.**

Click a diff line → composer scoped to that agent, prefix
`file:line`. Delivery is still `user_message`. Optional: a
`review_comment` quiet event later if the orchestrator must see it in
the journal; v1 does not need that.

### R3 — phone review (optional verb)

**Size S–M. After R1. Files: `protocol.ts`, `gateway.ts`, remote
client.**

Product call: either (a) put a **capped** `changedFiles` + `diffStat`
on `WorkspaceAgentSummary` (no new verb, needs a tiny
`Workspace.ts` summary change — **wait until W2 lands**), or (b) add
read-only `workspaces:inspect` as the eighth gateway verb, same host
path as R1.

Prefer (a) if the phone only needs "what changed"; (b) if the phone
must open a file. Do not mirror all of `APP_CHANNELS`.

### W2 — setup and run scripts

**Size M. After W1. Files: `profile.ts`, profile editor,
`Workspace.createWorktreeFor`, maybe `worktree.ts`.**

Per-profile `scripts.setup` (after worktree create: `pnpm install`,
symlinks) and `scripts.run` (user-clicked Run, not auto on spawn).
`scripts.archive` is **not** autodelete of the worktree; it may free
a bound port or a docker compose project the setup started.

No shell string built from agent names: `execFile` + argv, cwd = the
worktree. Fail-soft: a failed setup is a card warning, the agent
still starts (the CLI can retry). Setup must not git-write.

### W3 — port block

**Size S. Same PR as W2.**

Assign a stable port range per agent (hash of `agentId` into
3100–3999, or a host allocator). Export `VERTRAGUS_PORT` /
`VERTRAGUS_PORT_END` in `buildAgentEnv`. Document that app configs
should read them. Collision with a human process: skip and take the
next free port, record it on the agent summary.

### T1 — process snapshot

**Size S–M. Parallel with R2. Files: new
`src/main/agents/processStats.ts` (pid → RSS, open listen ports).
Summary fields on the agent row — wait for W2 if that means
`Workspace.ts`, otherwise IPC like R1.**

Read `/proc` (Linux) / best-effort elsewhere. Never invent token
counts. If a CLI writes a usage file we already know, show it as
"vendor-admitted". Wall-clock `maxRuntimeMin` stays the budget gate.

abtop remains a complementary TUI; this is the in-panel snapshot.

**Done when:** the card can show RSS + listen port for a live agent
without waking `await_events`.

---

## Wave 3 — safety, reseat, CI, ACP

Start when W2/W3 have released `spawn.ts` and `Workspace.ts`. These
four can run **in parallel** if they keep to their files:

| Track | May edit | Must not edit |
| --- | --- | --- |
| S1 sandbox | `spawn.ts`, `agentPolicy`, `SECURITY.md` | `Workspace.ts` (read policy at spawn only) |
| C1 CI | `pullRequest.ts`, `events.ts` (`ci_status`), `Workspace.ts` PR poller | `spawn.ts` |
| C7 reseat | `Workspace.ts`, `toolsOrchestrator.ts`, handoff, events | `pullRequest.ts` |
| P2 ACP | `attach.ts`, `provider.ts` `mcp.kind`, spawn MCP args | `Workspace.ts` |

**C1 and C7 both want `Workspace.ts` and `events.ts`.** Sequence:
land **C1 first** (smaller, additive poller) then **C7 M1**. S1 and
P2 do not wait.

### S1 — sandbox opt-in

**Size L. Linux first.** Opt-in in Settings (off by default). Wrap
the agent process (bubblewrap / landlock on Linux; document "partial"
on Windows/macOS). Inherit to helpers. Fail-closed: if the sandbox
cannot start, refuse spawn rather than fall back to host YOLO.

YOLO inside a sandbox is a different threat than YOLO on the host —
update [`../SECURITY.md`](../SECURITY.md) twins. Do not claim
containers in v1 (Sculptor-style Docker is a later optional backend,
not this track).

### C1 — CI on host PRs

**Size M.** After `automation.autoPr` opens a PR, poll `gh pr checks`
on an interval (same `execFile` + timeout rules as
`pullRequest.ts`). Push `ci_status` (quiet while pending, wake on
red/green). Card badge next to the existing PR line. No CI babysitter
in v1 — that is a playbook on a red event, not a new loop.

### C7 — reseat (M1–M5)

**Size L total; M1 is S.** Follow
[`MODEL-PROVIDER-SWITCH.md`](MODEL-PROVIDER-SWITCH.md) §12:

- M1 root `successor{providerId, model, effort}` + preflight
- M2 panel picker on Replace orchestrator (parallelizable with M3
  *code* once M1 is on main)
- M3 `reseat_agent` (the large worker state machine)
- M4 in-session `/model` (optional forever)
- M5 `meta.json` seat for resume

Do not start M3 while C1 still owns `Workspace.ts`.

### P2 — ACP dialect

**Size M.** New `mcp.kind: 'acp'` (JSON-RPC stdio) next to
claude-json / Codex `-c` / project files. Only for CLIs that speak
ACP. Sentinel remains for everyone else. This is an attach dialect,
not a provider id.

### V1 — preview URL

**Size S. After W3.** Put `previewUrl` (`http://127.0.0.1:${port}`)
on the agent summary. The card links it; `/browser` stays the worker
tool for driving the user's Chromium. Do not embed a browser in the
panel.

---

## Wave 4 — medium fit, after the loop is reviewable

Only after R1 + W2 exist. Each is its own PR. None is a second
product.

- **Issue-body seed:** a playbook (or paste into the Play goal) that
  fills `workspaces:start {goal}` from a GitHub issue URL the user
  provided. No Linear/Jira sync, no auto-spawn per ticket.
- **Agent Skills sync:** optional profile extra copying
  `~/.agentskills/` into vendor dirs. Convenience, not RAG.
- **Worktree pool:** Emdash-style reserves. Worth it only after W2
  (a pooled empty tree still lacks `node_modules`).
- **Same-task A/B:** two `start_agent`s + R1 to pick a winner. No
  DAG engine.
- **Headless Play:** document `VERTRAGUS_DEV_RUN` as the CI path;
  do not grow a cloud fleet.

---

## Out of scope (reminders)

From the handbook, so a neighbour feature does not become a track:

- Peer-to-peer mailboxes (Claude Agent Teams)
- Kanban / DAG / cloud runner as a product
- Autodelete of worktrees (Pane)
- Orchestrator that runs git, tests, or push
- Parsing vendor TUIs
- Signing/notarization as a landscape track (see `SIGNING.md` — a
  cost decision, not a missing ADE feature)

---

## PR checklist

Every track PR:

- [ ] Single topic; handbook track id in the description (`N1`, `R1`, …)
- [ ] `pnpm run ci` green
- [ ] Tests next to the subject; no skipped tests; ratchet unchanged
      or up
- [ ] i18n both locales in the right layer; namespaced keys
- [ ] Docs twins if a canonical doc changed
- [ ] Hot-file rule: this PR is the only open mutator of each file
      it touches in the table above
- [ ] No new remote verb unless this *is* R3
- [ ] No autodelete, no second MCP, no orchestrator git
