English | [Deutsch](PROMPT-MCP-HARNESS.de.md)

# Prompt: Vertragus MCP & Harness — all open topics

> Copy-paste-ready agent prompt. Primary source for ordering and
> non-goals: [`HANDBOOK-HARNESS.md`](./HANDBOOK-HARNESS.md). Code anchors
> below. Do **not** rebuild A1–A3 / Remote v1 / C1–C2 — those are in place.

---

## Role

You work in the repo **Vertragus** (Electron panel + in-app MCP server).
Goal: take the internal MCP/harness loop from "stable and remotely
steerable" to "knowing, humanly steerable, optionally broad" — without
breaking the non-goals below.

Work in **tracks** (not everything in one PR). Each track: its own branch
`cursor/<short>-94bd` (or the repo convention), green tests, a PR
referencing this document and `docs/HANDBOOK-HARNESS.md`.

Language of tool descriptions, contracts and orchestrator prompts:
**English** (imperative). Docs are English-canonical with maintained German
`.de.md` twins — whoever touches docs maintains both. UI strings go through
the i18n layers (de + en).

---

## Context — what already exists (do not touch except to integrate)

| Area | Status |
| --- | --- |
| Lifecycle | `orchestrator_exited`, quit awaited, sync `beginAgent` → `starting`, `slotWithCapacity` |
| MCP auth | per-agent HMAC subtokens, host/origin rebinding, MCP configs in `.git/info/exclude` |
| Start | async `start_agent` → `{state:'starting'}` + events `agent_started` / `agent_start_failed` |
| Events | `EventQueue` + `await_events.eventsDropped` (field on the result, no synthetic event) |
| Verify | `inspect_agent` (`status`/`diff`/`log`/`file`); host facts on `agent_done` |
| Tools today | Orch: 8 tools in `ORCHESTRATOR_TOOL_NAMES`; sub: `report_done` / `ask_orchestrator` / `report_progress` |
| Identity | binary: `?ws=&token=<orch>` vs `?ws=&agent=&token=<sub>` |
| Remote v1 | 4 gateway verbs; MCP stays loopback; typing into a PTY does **not** resolve `ask_orchestrator` |

Code anchors:

- `src/main/mcp/server.ts` — HTTP, identity, sessions
- `src/main/mcp/toolsOrchestrator.ts` / `toolsSubagent.ts`
- `src/main/mcp/pendingQuestions.ts` / `eventQueue.ts` / `types.ts` / `attach.ts`
- `src/shared/schema/events.ts`
- `src/shared/prompts/orchestrator.ts` / `contract.ts` / `roles.ts`
- Workspace/host: the AgentHost implementation (WorkspaceManager / Workspace)
- Remote: gateway allow-list, `protocol.ts`

---

## Hard non-goals (never)

- Peer-to-peer between subagents **or** leads
- A pre-started team / playbooks that spawn windows
- An orchestrator that is supposed to commit/merge/test/push itself
- Autodelete of worktrees/branches
- Hardcoded model catalogues, RAG
- A second orchestration as a product (kanban, DAG, cloud runner, workspace-per-area)
- Automatic nesting / a nesting profile toggle — the root decides via tool, default flat
- Depth > 1 (lead starts lead). Workers may spawn one helper level; helpers cannot spawn
- Grandchild events in the root's `await_events` queue (helper events land in the worker nest queue)
- A second MCP server for driving the browser (the extension pairs on `/browser` of the existing listener)
- `read_output` as verification (debug / unconfirmed exit only)
- Remote as a second MCP server or a mirror of all APP_CHANNELS
- Tunnels/TLS/accounts/internet exposure as part of these tracks
- `git status` on every `list_agents` / `await_events` (do not make the feed expensive)
- A synthetic `events_dropped` event (the gap stays a field on the tool result)

---

## Track ordering

```
Track 0  H1 + H2     remote/panel edges for the human in the loop
Track 1  C3 + C4     snapshot commit + handoff package on start_agent
Track 2  C5          orchestrator idle watchdog
Track 3  D           goal UI, user_message, ask_user  (needs 0)
Track 4  slot/provider choice on start_agent          (small, any time after 0)
Track 5  F           multi-orch lead (needs 1; does not need Remote)
Track 6  E           integrate/gate, briefing, resume, budget, eval, extra MCP
Track 7  H           nested workers, live user_message targeting, first-party /browser
```

Below: **one prompt block per track**. For an "everything" assignment:
Track 0→7 sequentially, one PR each. For an "MCP tools only" assignment:
Tracks 1–5 plus the D3/D2 parts that touch events/tools; H1/H2 still first
when remote/panel is affected.

---

## TRACK 0 — H1 `answer_question` + H2 `workspaces:start {goal}`

### Goal

A human (panel + remote) can answer MCP questions and start a workspace
with a goal — without a second orchestrator brain.

### H1 — `answer_question`

Problem: `ask_orchestrator` parks in `PendingQuestions`. The answer only
comes through the orchestrator tool `send_to_agent{questionId}`. Typing
into the subagent TUI does not release the waiter. Typing into the
orchestrator TUI while `await_events` is parked → a second turn.

Implement **one** host path (same as the MCP tool):

```
answer_question { workspaceId, agentId, questionId, text }
```

- Extend the gateway allow-list by exactly this command
- Panel: badge → text field uses the same path
- Sentinel ASK: keep `deliverAnswer` into the PTY, but the registry stays
  one truth
- No new orchestration, no second question map

### H2 — goal at start

```
workspaces:start { profileId, goal?: string }
```

- The host seeds the goal like the assignment handshake
- Without a goal: starting allowed (back-compat), the UI shows "no goal —
  orchestrator waiting"
- Panel + remote share the field; the desktop is not TUI-typing only

### Done when

- Tests: a registry answer from the gateway wakes `ask_orchestrator`
- Remote client / panel can close a question
- A start with a goal appears in the orchestrator seed; without a goal, no crash
- Update the README remote section (what the phone can do now)

### Prompt (short)

> Implement H1 `answer_question` and H2 `workspaces:start{goal}` per
> `docs/HANDBOOK-HARNESS.md`. One host path with MCP `send_to_agent{questionId}`;
> gateway allow-list +1; panel badge; goal seed. No new MCP tools in this
> track except integration tests against existing tools.

---

## TRACK 1 — C3 snapshot commit + C4 handoff package

### C3 snapshot commit (default on)

On `agent_done` / the host done path: if the worktree is dirty → commit on
the agent branch:

```
vertragus: <agent> / <role> — <first line of the summary>
```

- No push, no `--force`
- Worker prompt (`roles.ts` / contract): "do not commit yourself — the host snapshots"
- Commit failures must not swallow `agent_done` (as with snapshot facts today)

### C4 handoff on `start_agent`

When `baseBranch` is set: the host attaches the last relevant `agent_done`
(summary, files, SHA, branch) to the task text before the contract is
appended. The reviewer does not reconstruct the diff from prose. The star
topology stays.

### Done when

- Unit/integration: dirty → commit; clean → no empty commit
- `start_agent{baseBranch}` contains the handoff block in the seed
- `inspect_agent` + host facts remain correct, unchanged
- Prompt texts adjusted

### Prompt (short)

> Implement C3 snapshot commit and C4 handoff package. Host truth for git;
> only wire up MCP `start_agent` / `report_done`. No merge, no push, no
> feed `git status`.

---

## TRACK 2 — C5 orchestrator idle watchdog

### Goal

The process is alive but no longer calls `await_events` / orchestrator
tools. ≠ `orchestrator_exited` (process death).

### Design

- Watchdog on the last orchestrator MCP tool call
- Event `orchestrator_idle` + panel/remote card
- Optionally a reminder line into the TUI, once per silent phase
- Does **not** wake the orchestrator (it is not polling anyway)

### Done when

- Event schema extended + tests
- Panel shows idle; remote reads the summary
- No false positives during a normal `await_events` long-poll
  (timeouts ≠ idle)

### Prompt (short)

> Implement C5 `orchestrator_idle` watchdog. Distinct from
> `orchestrator_exited`. Idle = no more orchestrator tool calls, not
> "await_events had an empty result".

---

## TRACK 3 — Phase D human in the loop

Prerequisite: Track 0 (H1/H2).

### D1 goal at Play

As soon as `start({goal})` exists: mandatory panel field (or a clear
warning), `VERTRAGUS_DEV_RUN` from env/stdin.

### D2 `user_message` wakes `await_events`

Composer on the workspace card (desktop + remote, not just raw xterm):

1. text into the orchestrator TUI (visible)
2. push `user_message` into the EventQueue → a parked `await_events` returns immediately

Remote: a new message type in `protocol.ts` (zod union), e.g. `steer` /
`user_message`. Do not pre-build in B1 beyond not welding the gateway shut.

### D3 `ask_user` + badge answer

A new **orchestrator MCP tool**, blocking, ticket like
`ask_orchestrator`:

- Event `user_question` on the workspace card
- Remove/replace the prompt line "answer with the best-supported option"
- Subagent questions: host path = H1
- User questions: their own waiter; **one** text field, two backends
- Update `ORCHESTRATOR_TOOL_NAMES` + allowlists (`attach.ts`) + prompt
  `orchestrator.ts`

### D4 yolo as a policy (later in the track or a follow-up)

Tiers `yolo` / `ask-user` / `ask-orchestrator`. Remote v1 does not make
CLI permission TUIs "pretty". Keep the threat model in the README.

### Done when

- The composer wakes `await_events` (test with fake host + EventQueue)
- `ask_user` round trip incl. ticket resume
- Panel + remote badge for user and agent questions
- The prompt names `ask_user` / `user_message`

### Prompt (short)

> Phase D: D1 goal UI, D2 `user_message` event + composer, D3 MCP tool
> `ask_user` with ticket. H1/H2 assumed. One text field, two backends. No
> peer-to-peer, no second orchestrator.

---

## TRACK 4 — provider/slot choice on `start_agent`

### Problem

`slotWithCapacity` takes the first slot of the role with room. The
orchestrator can override `model`, not the provider → diversity often dead.

### Design (choose one, prefer the profile rule if simpler)

- `start_agent{role, slotId? | providerId?}` **or**
- profile rule: one role = one slot

The host keeps enforcing the cap synchronously through the reservation.

### Done when

- Explicit provider/slot choice possible without a cap regression
- Unknown slotId/providerId → a clear `toolError`
- The prompt documents the parameters

### Prompt (short)

> Extend `start_agent` with optional slot/provider choice without TOCTOU
> and without cap bugs. No new nesting.

---

## TRACK 5 — Phase F multi-orchestration (lead)

Prerequisite: Track 1 (C3/C4). Does **not** need Remote.

### A third MCP identity

Today binary. New:

```
/mcp?ws=&token=<orch>                 → root tools (+ start_orchestrator)
/mcp?ws=&agent=<id>&token=<sub>       → leaf tools
/mcp?ws=&lead=<id>&token=<per-agent>  → lead tools (union)
```

### Lead tools

| Direction | Tools |
| --- | --- |
| Downward (subtree) | `start_agent`, `send_to_agent`, `await_events`, `list_agents`, `stop_agent`, `read_output`, `inspect_agent` |
| Upward | `report_done`, `ask_orchestrator`, `report_progress` |
| Forbidden | `record_retro`, `start_orchestrator` |

### Root additionally

```
start_orchestrator{area, task, maxSubagents?, model?, baseBranch?}
```

- `area` label for prompt/panel
- `maxSubagents` = sub-budget, not a second profile limit
- `profile.maxSubagents` global over root children + grandchildren
- `start_agent` stays on the root (flat + hybrid)

### Fan-in

- Every lead: its own `EventQueue`
- Root `await_events` sees **direct children only**
- Grandchild events only in the lead queue
- The retro tap subscribes to **all** queues
- `PendingQuestions` one registry; `agent_question` into the parent queue
- Questions climb one level, never two; no skip-level; no peer questions

### Lead death

- The root gets `agent_exited` for the lead
- Reparent: grandchildren → direct children of the root; queue merge `subtree_adopted`
- Not: stopping grandchildren; not: orphaned `ask_orchestrator`

### Caps (host, not prompt)

- Depth exactly 1
- Max leads e.g. 4
- Global `maxSubagents` incl. leads/grandchildren
- Async start + per-agent tokens as today
- Per-role limits global in v1

### Panel / remote

- `parentId` + `kind: 'orchestrator' | 'lead' | <role>`
- Indentation, no tree widget
- `answer_question` addresses the parent from `agentId`
- `start_orchestrator` is **not** a remote API

### Prompt (short)

> Implement Phase F multi-orch per the handbook: third identity `lead=`,
> own queues, `start_orchestrator`, fan-in of direct children only,
> reparent on lead death. Default flat. No auto-nesting, no depth > 1, no
> grandchildren in the root queue, no peer-to-peer. Needs C3/C4.

---

## TRACK 6 — Phase E integration, memory, eval

Prerequisite: Track 1 (C). D/F optionally parallel where independent.

### E1 `integrate_branch` / verify gate / promote

- Host merge in the target worktree
- Events `integrate_ok` | `integrate_conflict`
- Gate: worker snapshot + reviewer without blockers + tester `success`
- Promote to `<base>` = **user click** (not Remote-v1 phone)

### E2 briefing + repo notes

- Capped block of `AGENTS.md`/`CLAUDE.md`/`README`/`git log -8` into the
  orchestrator prompt
- `record_retro.repoNotes[]` analogous to model learnings, deletable in the retro panel
- No RAG

### E3 journal / resume

- `.vertragus/runs/<id>/events.jsonl` beyond the gap
- Re-spawn in old worktrees
- Open tickets after a crash = dead, say it honestly

### E4 budget

- Sum of agent-seconds + `maxRuntimeMin`
- `budget_warning` events; no new starts over the limit
- No guessed token counters

### E5 loop eval

- Mini repo with a bug; assert worker + `inspect` + tester success +
  orchestrator worktree without its own diff
- Keep the handover live test

### E6 playbooks, extra MCP, role templates

- Playbook = goal template, **not** a pre-started team
- Extra MCP only for workers (`attach.ts` dialects)
- Templates Janitor/Explorer; a third-party browser MCP still via extra MCP (first-party extension is Track 7)

### Prompt (short)

> Phase E per the handbook: integrate/gate/promote (user click), briefing,
> journal/resume, budget wall clock, loop eval, playbooks + extra MCP for
> workers. No RAG, no autodelete, the orchestrator does not merge itself
> except through the host tool `integrate_branch`.

---

## TRACK 7 — Phase H nested workers, live steering, Chromium extension

**Status: implemented.** Do not rebuild. Handbook Phase H;
[`CHROMIUM-EXTENSION.md`](./CHROMIUM-EXTENSION.md).

### Goal

Workers may offload a slice, the human can keep talking to the
orchestrator after delegation, and a worker can test a live web app in
the user's real Chromium — without a second product, without
lead-starts-lead, without grandchild events in the root queue.

### Nested workers (helpers)

- `canSpawnHelpers`: no parent or parent is a lead → yes; parent already
  a worker nest → no
- `runtime.nests` (same shape as leads, `area: helpers`); not counted
  toward `MAX_LEADS`; `MAX_HELPERS_PER_WORKER = 3`
- Worker down-tools: `WORKER_DOWN_TOOL_NAMES` (no `task_*`, no
  `start_orchestrator`); `helpers: true` on the MCP contract
- Fan-in via `queueForAgent`; `adoptSubtree` one level up

### Live steering

- Composer `targetAgentId`; still `user_message` on the **root** queue
- `resolveUserMessageTarget` sets `relayVia*` for non-direct children
- Do not type into the orchestrator TUI

### First-party Chromium extension

- Same HTTP listener, `/browser`, loopback token
- `chrome-extension:` origin only on that path
- Worker tools `browser_*`; disconnected → `browser_disconnected`
- Unpacked MV3 `extensions/chromium/`

### Done when

- Helper events never reach the root `await_events`
- A follow-up from the composer can be relayed to a helper
- A worker can snapshot/click a real tab when the extension is paired
- `pnpm run ci` green; MCP version `1.1.0`

### Prompt (short)

> Implement Phase H per the handbook: one helper level under a worker,
> composer targeting with relay, first-party `/browser` extension. No
> second MCP, no lead-starts-lead, no grandchild events in the root queue.

---

## Cross-cutting — check on every track

1. **Events:** schema in `events.ts`; one owner per event type (see the
   comment in `types.ts`); no duplicates MCP vs host/sentinel.
2. **Tools:** `ORCHESTRATOR_TOOL_NAMES` / `SUBAGENT_TOOL_NAMES` and the
   provider allowlists in `attach.ts` in sync; the prompt `orchestrator.ts`
   + contract name new tools.
3. **Timeouts:** long-polls under the 60s MCP timeout (`await_events` ~50s,
   `ask_*` ~50s, ticket resume).
4. **Security:** loopback MCP; do not commit tokens; minimal remote
   allow-list; an honest yolo threat model.
5. **Tests:** unit for queue/questions/tools; integration where spawning;
   `pnpm run ci` green.
6. **Docs:** handbook status line / README only when user-visible behaviour changes.

---

## Master prompt (everything in one assignment)

If you want to kick off **all** topics in one agent run, paste this:

```
You are a coding agent in Vertragus. Read first:
- docs/HANDBOOK-HARNESS.md
- docs/PROMPT-MCP-HARNESS.md  (this document)
- src/main/mcp/* , src/shared/schema/events.ts , src/shared/prompts/*

Goal: implement all open harness/MCP tracks — but in separate PRs/commits
in the order Track 0 → 6. Follow the non-goals strictly. Do not rebuild
anything from "What PR #17 landed".

Per track:
1. Create a branch
2. Minimal diff per the track section
3. Tests + ci
4. Short PR body with the track ID and done criteria
5. Only then the next track

Start with Track 0 (H1 answer_question + H2 start{goal}).
If a track is blocked, stop and report the blocker — do not quietly build
Track 5 before Track 1.
```

---

## Single prompts (copy-paste)

### Track 0 only

```
Implement Track 0 from docs/PROMPT-MCP-HARNESS.md: H1 answer_question
(gateway + panel, same path as send_to_agent{questionId}) and H2
workspaces:start{goal}. Tests, README remote section. No new
orchestration tools.
```

### Track 1 only

```
Implement Track 1 (C3 snapshot commit + C4 handoff) from
docs/PROMPT-MCP-HARNESS.md. Host git truth; agent_done must not die on
commit failures; start_agent{baseBranch} gets the handoff. Worker prompt:
do not commit yourself.
```

### Track 2 only

```
Implement Track 2 C5 orchestrator_idle from docs/PROMPT-MCP-HARNESS.md.
Distinct from orchestrator_exited. No false positives during the
await_events long-poll.
```

### Track 3 only

```
Implement Phase D (Track 3) from docs/PROMPT-MCP-HARNESS.md.
Prerequisite H1/H2. D2 user_message wakes await_events; D3 ask_user MCP
tool with ticket; one text field, two backends; allowlists + prompt.
```

### Track 4 only

```
Implement Track 4 start_agent slot/provider choice from
docs/PROMPT-MCP-HARNESS.md. Keep caps sync/race-free.
```

### Track 5 only

```
Implement Phase F multi-orch (Track 5) from docs/PROMPT-MCP-HARNESS.md
and HANDBOOK-HARNESS.md. Third identity lead=; own queues; fan-in;
reparent; caps host-side. Default flat. Needs C3/C4.
```

### Track 6 only

```
Implement Phase E (Track 6) from docs/PROMPT-MCP-HARNESS.md:
integrate_branch/gate/promote, briefing/repoNotes, journal/resume,
budget, loop eval, playbooks + extra MCP workers-only. Respect the
non-goals.
```

### Track 7 only

```
Implement Phase H (Track 7) from docs/PROMPT-MCP-HARNESS.md and
HANDBOOK-HARNESS.md: one helper level under a worker, composer targeting
with relay, first-party /browser Chromium extension. No second MCP, no
lead-starts-lead, no grandchild events in the root queue.
```

---

## Overall acceptance (end of Track 7)

- A human can set goals from panel/remote, steer (`user_message`, optionally targeted), and
  answer agent and user questions
- The host knows git (inspect, done facts, snapshot commit, handoff)
- Idle and exit are distinguishable
- The root can optionally nest leads without an event storm
- Workers may spawn one helper level; helper events stay out of the root queue
- A paired Chromium extension lets a worker test a live web app
- Integrate/gate/promote and resume exist without autodelete/RAG
- `pnpm run ci` green; handbook status updated
