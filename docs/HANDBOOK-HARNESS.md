English | [Deutsch](HANDBOOK-HARNESS.de.md)

# Vertragus as an AI Harness

Ideas that come from the code — not from a generic agent roadmap.

Copy-paste-ready agent prompts for all open tracks:
[`PROMPT-MCP-HARNESS.md`](./PROMPT-MCP-HARNESS.md).

**Status:** [PR #17](https://github.com/Nehmo101/Vertragus/pull/17) has
**implemented** BigBoy A1–A3, Remote (B) and Harness C1/C2 (`inspect_agent`,
host facts on `agent_done`). This document is the plan for what comes after.

**Thesis, unchanged:** The loop already is a harness. What is missing is
*host truth* for git state, diffs, and the human in the event stream.
BigBoy makes the loop *stable and remotely steerable*. It does not make it
*knowing*.

---

## What PR #17 landed (do not build again)

| Plan | In the code |
| --- | --- |
| A1 Lifecycle | `orchestrator_exited`, quit awaited, `beginAgent` reserves synchronously (`starting`), `slotWithCapacity` (overflow onto the next slot of the same role) |
| A2 MCP | async `start_agent` → `{state:'starting'}` plus `agent_started` / `agent_start_failed`; per-agent HMAC subtokens; host/origin rebinding; MCP configs in `.git/info/exclude`; `await_events.eventsDropped` (**field on the tool result**, no synthetic `events_dropped` event) |
| A3 Panel | real `WorkspaceDirectory.onChange` (no 4s poll), panelBounds, glob window security, xterm links/search, main-process i18n, zustand removed |
| B Remote | HTTP+WS, Tailscale bind, pairing, gateway allow-list, web client, settings |
| H3 Prompt | `orchestrator.ts` knows async start / `agent_started` / `agent_start_failed` |
| C1 `inspect_agent` | Read-only git against the agent's worktree (`status` / `diff` / `log` / `file`) |
| C2 Host facts on `agent_done` | `branch`, `headSha`, `uncommitted`, `changedFiles`, `diffStat` — not as git-status on every `list_agents` |

The gateway allow-list has been **five verbs** since Track 0:
`workspaces:list`, `workspaces:start` (now with optional `goal`),
`workspaces:stop`, `profiles:list`, `answer_question`; `user_message` (D2)
and `workspaces:goal` (H2 refill) came later — seven today. No `focus_agent` /
`stop_agent` on the gateway. `resize` exists in the WS protocol; it is not a
product goal of Remote v1.

Do not duplicate: lifecycle, MCP auth, EventQueue gap, panel push, remote
server.

---

## What is still missing after #17

| Hook / phase | Status |
| --- | --- |
| H1 `answer_question` on the gateway | **implemented** (Track 0) — one host path (`mcp/answerQuestion.ts`), gateway verb, panel badge |
| H2 `workspaces:start {goal}` | **implemented** (Track 0) — goal seed over the assignment handshake, back-compat without a goal; refill (`workspaces:goal`) hands a bare-started run its goal later |
| C3 snapshot commit / C4 handoff package | **implemented** (Track 1) — `snapshotDone` commits dirty worktrees on done; `start_agent{baseBranch}` carries a handoff block |
| C5 orchestrator idle watchdog | **implemented** (Track 2) — `orchestrator_idle` event + panel/remote hint; timeouts ≠ idle (touch at call start and end) |
| C6 orchestrator succession (context handoff) | **S1 in the code** — see [`ORCHESTRATOR-SUCCESSION.md`](./ORCHESTRATOR-SUCCESSION.md) |
| C7 model/provider reseat (switch mid-run) | **spec only** — see [`MODEL-PROVIDER-SWITCH.md`](./MODEL-PROVIDER-SWITCH.md) |
| D human in the loop | **D1–D4 implemented** (Track 3 + follow-up) — goal UI, `user_message` wakes `await_events`, `ask_user` with ticket; D4 tiers `yolo`/`ask-user`/`ask-orchestrator` (store mirror to `yoloMaster`, contract approval rule, threat model in the README) |
| E integrate / briefing / eval | **core implemented** (Track 6) — `integrate_branch` + gate warning + promote click, briefing + `repoNotes`, journal + resume (E3, briefing instead of re-spawn), budget wall clock, Janitor/Explorer, playbooks, extra MCP for workers (E6), loop eval (E5, `tests/integration/loopEval`) — Phase E complete |
| F multi-orch (Lead, depth 1) | **implemented** (Track 5) — third identity `lead=`, own queues, `start_orchestrator`, fan-in of direct children only, reparent (`subtree_adopted`), caps host-side |
| H nested workers / live steer / browser | **implemented** — workers may spawn one helper level; composer targeting on `user_message`; first-party `/browser` loopback (not a second MCP) |

---

## Two hooks that Remote still cements

H3 is done in #17. H1 and H2 are missing — without them the human stays at
the terminal, just over Tailscale.

### H1 — "answering questions = terminal attach + typing" does not hold for MCP

`ask_orchestrator` parks in `PendingQuestions`. The answer only comes
through `send_to_agent{questionId}` (the orchestrator's MCP tool). Typing
into the *subagent* TUI does not release the waiter. Typing into the
*orchestrator* TUI while `await_events` is parked starts, depending on the
CLI, a second turn — two brains, one process.

Subagent badges in `WorkspaceSummary` are the right display. To *answer*,
the gateway needs **one** extra command that takes the same path as the MCP
tool:

```
answer_question { workspaceId, agentId, questionId, text }
```

That is not new orchestration. That is the allow-list one line longer, and
the panel can use the same host path (badge → text field). Without this
line, the phone cannot answer MCP questions — only CLI permission dialogs,
which really do live in the TUI.

Sentinel ASK is the exception that almost belongs in the TUI
(`deliverAnswer` types into the PTY). Still, the answer should go through
the same registry, otherwise there are two truths.

### H2 — `workspaces:start` without a goal is unusable on the phone

Play today starts an empty orchestrator; the goal is typed into the TUI
(`devRun.ts`, `workspaces:start(profileId)`). On the desktop this is already
the class of bug that `autoSubmitTasks` was meant to solve. On the phone
with xterm + software keyboard it is the worst path in the entire remote
plan.

Cheap in B1/B2:

```
workspaces:start { profileId, goal: string }
```

The host seeds the goal over the same handshake as any assignment. Panel
and remote client share the field. Without a goal, starting stays allowed
(back-compat), but the card shows "no goal — orchestrator waiting".

**Refill (follow-up).** That waiting state is not a dead end: the "no goal"
line on the card is a field, on the panel (`workspaces:goal` IPC) and on the
phone (`workspaces:goal` gateway verb) alike. It takes the very same
`Workspace.assignGoal` handshake — a run that already carries a goal refuses
with `goal_already_set`, because a second first-turn typed into a CLI that
drives the MCP loop is the two-brains failure H1 documents; steering a
running goal stays `user_message`'s job. A delivered refill also rewrites the
run's `meta.json`, so E3 Resume briefs on the goal the run actually got.

### H3 — done in PR #17

`buildOrchestratorSystemPrompt` knows `{state:'starting'}`, `agent_started`
and `agent_start_failed`. `send_to_agent` against `starting` is a clear
error. So is `inspect_agent`.

### Slot mapping, even after A1.3

`slotWithCapacity` takes the first slot of the role *with free capacity*.
Limits sum over all slots. That closes TOCTOU and the cap bug.

It does **not** close: two worker slots, Claude vs. Codex. The orchestrator
can override `model`, not the provider. "First with room" still wins, so
usually always Claude.

**Implemented (Track 4):** `start_agent{role, providerId?, slotId?}` — an
explicit choice fails hard (unknown/full = error, no silent fallback);
without a choice it stays "first with room". The orchestrator prompt lists
the slots (provider/model) per role so the choice is informed. Caps remain
sync through the reservation.

---

## What is already strong (do not build again)

| Layer | Status |
| --- | --- |
| Runtime | PTYs, visible terminals, boot overlay until MCP session, measured seed handshake |
| Isolation | mandatory worktrees, no shared checkout, no autodelete |
| Communication | `await_events`, `ask_orchestrator` with ticket |
| Delegation | slots = blueprint, not a pre-started team |
| Learning | retro → Wilson + insights into the next prompt |
| Providers | one declarative schema |
| Identity | URL-bound, per-agent HMAC subtokens, host/origin check, MCP configs in `.git/info/exclude` |
| Push / lifecycle | `orchestrator_exited`, quit awaited, `onChange` feed instead of a 4s poll |
| Remote | Tailscale bind, pairing, four gateway verbs, web client |

New power after this comes as a *host tool or event in the existing loop*,
not as a second orchestration and not as a second remote path.

---

## The three holes that BigBoy does not close

### 1. The orchestrator cannot see its agents' work — C1/C2

Every agent including the orchestrator has its own worktree
(`Workspace.createWorktreeFor`). Claude's Read/Grep run in the
*orchestrator's* checkout (HEAD), not in Caronte's files. `read_output` is
TUI tail. Codex/Kimi orchestrators do not have the read tools at all.

**This PR:** `inspect_agent` reads the agent's worktree; `agent_done`
carries host facts. Remote changes nothing here — inspect stays an
orchestrator tool, not a gateway command.

### 2. Handoff hangs on "please commit" in the task text — stays C3/C4

Worker prompt: do not commit unless the task says so. Orchestrator prompt:
have them commit first, then `baseBranch`. C2 says *whether* the branch is
dirty; C3 still has to snapshot-commit, otherwise a reviewer on
`baseBranch` still reviews HEAD when the worker has not committed.

### 3. The human is not a participant of the event loop

Play without a goal. Prompt: answer user questions yourself. No `ask_user`,
no `user_message` that wakes `await_events`. Panel = launcher
(`?` = tooltip + focus).

BigBoy Remote makes the launcher remotely steerable. Without H1/H2 the
human stays *at* the terminal, just over Tailscale.

---

## Phase C — harness core (after PR #17)

Small surface, big lever. The prerequisites are in place: reservation,
async start, gap signal (`eventsDropped`), push feed. `inspect_agent`
against `starting` is the same error as `send_to_agent`.

### C1 `inspect_agent` — the host reads the agent's worktree — **implemented**

```
inspect_agent{agentId, view: status | diff | log | file, path?, lines?}
```

Read-only, never the main checkout. Capped (20k chars diff, 80k file, log
max 50); the truncation marker names the way out (set `path`,
`view: file`, or read `status`) instead of just "truncated". `path` is
mandatory for `file` and optional for `diff` — the host then diffs only
that file or that directory. Prompt: verification goes through
`inspect_agent` — `status` first (porcelain + diffstat), full diff only on
anomalies —, never through own git commands, never through `read_output`.
Provider-neutral.
An orchestrator tool, not a gateway command (remote must not read arbitrary
repo files). Stopped agents stay inspectable — the worktree survives
`stop_agent`.

### C2 `agent_done` carries host facts — **implemented**

On `report_done` / sentinel DONE the host attaches to the event:

- `branch`, `headSha`, `changedFiles[]`, `uncommitted`, `diffStat`

Git hangs must not swallow the done event: snapshot fails → event without
facts, orchestrator inspects afterwards. Sentinel DONE sets
`doneSinceAssignment` synchronously so that `agent_exited.confirmed` is
also correct while the snapshot is still running.

**Not** on every `list_agents` / `await_events`: that would be `git status`
on every worktree in the main loop. The porcelain dot on the card can later
derive from the *last* `agent_done` or call `inspect_agent` deliberately —
do not make the feed expensive.

### C3 snapshot commit on done (default on)

Dirty worktree → commit on the agent's branch

```
vertragus: <agent> / <role> — <first line of the summary>
```

No push, no `--force`. Worker prompt: "do not commit yourself — the host
snapshots." `baseBranch` points at work afterwards.

### C4 handoff package on `start_agent`

When `baseBranch` is set: the host attaches the last `agent_done` (summary,
files, SHA) to the task. The reviewer does not have to reconstruct the diff
from prose. The star topology stays.

### C5 orchestrator *idle* (not exit)

A1.1 is process death. The other death: the process lives but no longer
calls `await_events`. Subagents without MCP already have the 120s silence
hint for this. The orchestrator does not.

A watchdog on the last orchestrator tool call → event `orchestrator_idle` +
panel/remote card. Optionally one reminder line into the TUI, once per
silent phase. Does not wake it (it is not calling anyway).

### C6 orchestrator succession (context handoff)

The root orchestrator is the only LLM that accumulates the run. Subagents
have isolated contexts; on long runs *its* window fills up — not theirs.

**Succession** = serial replacement of `orchestratorRecord` in the same
workspace: fresh context, structured host package, team and `EventQueue`
stay. This is **not** a second parallel root, not a Lead (F), not a C4
worker package.

Quick decisions (details and state machine in the dedicated doc):

- Trigger: orchestrator tool `request_succession` (self-declare); user
  button as escape; **no** host token counter
- Cutover: rotate `orchToken` → spawn/seed successor → kill old PTY;
  `subToken` and worker URLs unchanged
- Same `EventQueue` + `PendingQuestions`; the package carries `eventCursor`
- `record_retro` is run end, not handoff — the host blocks non-active
- C5 is orthogonal (silence ≠ context-full); C3 should land before/with
  hardening so the SHAs in the package are correct

Full plan: [`docs/ORCHESTRATOR-SUCCESSION.md`](./ORCHESTRATOR-SUCCESSION.md).

**S1 in the code:** `request_succession` (ninth orchestrator tool), host
package, `orchToken` rotation (old URL → 401, subagent URLs stay), successor
seed with `eventCursor` and open questions — the package is rendered once as
prose (roster, questions, next actions, decisions, risks, note, event tail),
no additional JSON dump —, fence `succession_in_progress` on mutating tools,
`record_retro` forbidden meanwhile. User button, C5 and C3 SHA hardening
come later.

### C7 model/provider reseat (switch mid-run)

Provider and model are launch-time argv — a live PTY cannot be re-pointed.
What a long run needs anyway: the root whose provider hit its rate limit, the
worker that failed the same task twice, the phase that wants a stronger model.

**Reseat** = same seat (role, slot, worktree, branch, queue, open questions),
new process, context carried in a host-built package. For the root that is C6
with one extra field (`request_succession{successor:{providerId, model,
effort}}`) plus a preflight, because a wrong model string must refuse instead
of leaving the run without a driver. For a worker it is a new tool
(`reseat_agent`), because today's `stop_agent` + `start_agent` loses the
uncommitted work, the open question, the identity and the slot — and cannot
leave the profile's slots at all.

Full plan: [`docs/MODEL-PROVIDER-SWITCH.md`](./MODEL-PROVIDER-SWITCH.md).

---

## Phase D — human in the loop (after C, Remote benefits)

H1/H2 should already exist as edges in BigBoy B. D fills them.

### D1 goal at Play

See H2. As soon as `start({goal})` exists: mandatory panel field,
`VERTRAGUS_DEV_RUN` from env/stdin.

### D1b long block windows — `mcpToolTimeoutSec`

A provider can declare that its MCP tool timeout is raisable
process-locally (`mcpToolTimeoutSec`, Claude preset: 600s — env
`MCP_TIMEOUT`/`MCP_TOOL_TIMEOUT`; the Codex mechanism exists, the preset
deliberately does not declare it). From this the host derives windows with
margin (claim ≥ 120s, otherwise nothing): `await_events` default 300s /
max 570s instead of 50/55s, and **per agent** the same window for the ask
blocks — `ask_user` over the orchestrator's window, `ask_orchestrator` over
the window of the *asking* agent (a Codex worker with a 60s default keeps
ticketing while a Claude worker in the same run blocks for minutes). Every
avoided idle answer (`events: []`, `answer: null`) is one saved model turn
over the entire context. `VERTRAGUS_ASK_TIMEOUT_MS` still beats everything
except the workspace option — the integration tests must be able to force
the ticket path.

### D2 `user_message` wakes `await_events`

Composer on the card (desktop + remote client, **not** just raw xterm).
Sending:

1. writes into the orchestrator TUI (visible)
2. pushes `user_message` into the EventQueue → a parked `await_events`
   returns immediately

Remote v1 has `terminal_input`. That is enough for CLI dialogs. It is not
enough to get the orchestrator out of `await_events`. D2 is the one WS
message type that B can add later (`steer` / `user_message`) as soon as D2
lands in the host. Do not pre-build it in B1 — just do not close the
gateway in a way that a new message kind needs a protocol reissue
(`protocol.ts` as a zod union makes that cheap).

### D3 `ask_user` + badge answer

Orchestrator tool, blocking, ticket like `ask_orchestrator`.
`user_question` on the workspace card. The prompt line "answer with the
best-supported option" is dropped.

Subagent questions: the same host path as H1 `answer_question`. User
questions: resolving the `ask_user` waiter. One text field, two backends.

### D4 yolo as a policy

**Status: implemented.** `agentPolicy` in the store (mirrored with
`yoloMaster`, one truth), three-way picker in the settings window,
`ask-user` takes the yolo flags away from the subagents,
`ask-orchestrator` hangs an approval rule into the task contract (both
dialects); an honest threat model in the README. Cursor yolo subagents
are launched in **Run Everything** (`--force --sandbox disabled` plus a
project `.cursor/cli.json`) so Auto-review / sandbox does not still
prompt; orchestrators never get those flags.

Today a bool; remote × default yolo = RCE on the PC (BigBoy states this
correctly; opt-in + Tailscale bind + kill switch is the v1 answer).

After that, not in B: tiers `yolo` / `ask-user` / `ask-orchestrator`.
Remote v1 must not try to make CLI permission TUIs pretty on the phone —
that is exactly the path that does not replace H1.

---

## Phase E — integration, memory, eval (late)

Unchanged in substance, clearly *after* C.

### E1 `integrate_branch` / verify gate / promote

Host merge in the target worktree, events `integrate_ok` |
`integrate_conflict`. Gate: worker snapshot + reviewer without blockers +
tester `success`, then warn when "done" without the gate. Promote to
`<base>` is a **user click** (desktop; the remote allow-list deliberately
has no worktree deletion — promote likewise does not belong in phone v1,
too close to "overwrite my repo"). Since A3 that click can be made once in
the profile instead of once per branch — same host merge, same refusals,
see Phase A3.

### E2 briefing + repo notes

Capped block of `AGENTS.md`/`CLAUDE.md`/`README`/`git log -8` into the
orchestrator prompt. `record_retro.repoNotes[]` analogous to model
learnings, deletable in the existing retro panel. No RAG.

### E3 journal beyond the gap / resume

**Status: implemented.** The journal writes `events.jsonl` + `meta.json`
(goal, profile, `resumedFrom`); `resume.ts` reads fail-soft, picks the
profile's most recent run and builds the resume briefing for a NEW
orchestrator (branches/worktrees stay, chaining via
`start_agent{baseBranch}`); panel button "Resume last run" in the Play
fold-out. No re-spawn of old CLI processes — open tickets after a crash =
dead, the briefing says so verbatim.

A2.3 makes the gap *visible*. Resume additionally needs a journal
(`.vertragus/runs/<id>/events.jsonl`) + re-spawn in old worktrees. Open
tickets after a crash = dead, say it honestly. Late.

### E4 budget as a wall clock

`maxSubagents` is concurrency. Sum of agent-seconds + `maxRuntimeMin` →
`budget_warning` / no new starts. No guessed token counters.

### E5 loop eval

**Status: implemented** (`tests/integration/loopEval.integration.test.ts`):
temp repo with a planted bug, real `git worktree` machinery (spawn/seed
faked, no CLI processes), worker fixes in its worktree → `snapshotDone`
commits (C3) → `inspect_agent` shows the fix → tester with `baseBranch` on
the worker's branch sees it (C4 for real) and reports success without
uncommitted changes — orchestrator worktree and main checkout without a
diff of their own.

The handover live test stays. Second probe: mini repo with a bug, goal to
the orchestrator, assert worker + `inspect` shows the file + tester success
+ orchestrator worktree without its own diff.

### E6 playbooks, extra MCP, missing roles

**Status: implemented** (playbooks/roles in Track 6, extra MCP in the
follow-up). Slot schema `extraMcp: [{name, url}]` (name TOML-safe,
`vertragus` reserved, max 4); all five attach dialects write the extra
servers (Claude strict file, Codex `-c` overrides, Kimi/Cursor/Grok project
files) — **only for subagents**, never orchestrator/lead. No form field:
the store preserves `extraMcp` across editor saves (like zones),
configuration happens via profile JSON.

Playbook = goal template, not a pre-started team. Extra MCP only to
workers (`mcp/attach.ts` knows the dialects). Templates Janitor/Explorer,
no new mechanics. A third-party browser MCP still attaches via extra MCP;
the first-party Chromium extension is Phase H (`browser_*` on the worker
identity, same listener).

A cockpit trace (goal, porcelain dot, last events) falls out largely as a
derivation of C2 + the A3.1 feed — panel and remote client can draw the
same `WorkspaceSummary`. No third store.

---

## Phase F — multi-orchestration (the root decides)

Conceivable: yes. Sensible: **sometimes**, and only when the main
orchestrator chooses it. The default stays a flat team. Whoever always
nests has the old mistake in a new form — context explosion, unanswered
questions, too many windows — just one level deeper.

This is **not** a second product (no kanban, no DAG engine, no second
workspace per area). It is a third MCP identity in *the same* workspace,
with its own EventQueue, so the root does not see every worker event of its
subtrees.

### When yes, when no

The root gets the tool. The host never auto-nests and also does not refuse
because "the task looks small" — that would be the opposite of "it
decides". The prompt says when it *should* need it:

| Nest | Stay flat |
| --- | --- |
| ≥2 independent workstreams that barely share files | One area, one bug, one module |
| Each stream needs its own review/test loop | A pipeline on *the same* files: architect → worker → reviewer (`baseBranch`, not a Lead) |
| Without nesting, `await_events` would drown the root (>~6 parallel leaf agents with ongoing back and forth) | Two, three workers that the root dispatches itself |

Hybrid is allowed and intended: the root starts a worker for something
small *and* a sub-orchestrator for a large stream.

### A third identity, not a role

Today binary (`server.ts`):

```
/mcp?ws=&token=<orch>              → eight orchestrator tools (incl. inspect_agent)
/mcp?ws=&agent=<id>&token=<sub>    → report_done / ask / progress
```

Added:

```
/mcp?ws=&lead=<id>&token=<per-agent>  → lead tools (below)
```

A sub-orchestrator is **not** a slot `roleId: orchestrator`. It draws a
guide name (`NameAllocator` kind `orchestrator`), the bronze colour (or a
darker bronze), the same provider/model as the profile's `orchestrator`
(overridable), and **no yolo**.

**Lead tools** (a union, deliberately):

| Direction | Tools |
| --- | --- |
| Downward (scoped to its own subtree) | `start_agent`, `send_to_agent`, `await_events`, `list_agents`, `stop_agent`, `read_output`, `inspect_agent` |
| Upward (like a subagent to the root) | `report_done`, `ask_orchestrator`, `report_progress` |
| Forbidden | `record_retro` (root only), `start_orchestrator` (depth 1) |

**Root tools** additionally:

```
start_orchestrator{area, task, maxSubagents?, model?, baseBranch?}
```

`area` is a short label for prompt and panel ("payments", `docs`).
`maxSubagents` is the **sub-budget** the root gives away — not a second
profile limit. `profile.maxSubagents` remains the global cap over root
children + all grandchildren (A1.3 reservation workspace-wide).

`start_agent` stays on the root. Without the tool it could not work flat
and could not work hybrid.

### Fan-in: the whole point

Every lead has its own `EventQueue`. The root's `await_events` sees **only
direct children** (workers it started itself, and leads). Grandchildren's
events land only in the lead's queue.

Otherwise nesting is useless: the root would have the same event storm,
plus more processes.

The retro tap (`WorkspaceManager` `onPush`) subscribes to **all** queues —
the statistics after the stop need the grandchildren, the root loop does
not.

`PendingQuestions` can stay one registry (already `agentId`-keyed). The
`agent_question` event must go into the queue of that agent's *parent*, not
always into the root queue.

### Questions climb one level, never two

```
Worker --ask--> Lead --(answers or ask_orchestrator)--> Root --(later ask_user)--> Human
```

A worker cannot call the root — its URL has no root tools. A lead that
needs a user decision asks the root; the root asks (today via prompt, later
via `ask_user`) the human. No skip-level, no peer questions between leads.
Coordinating two areas = lead asks root, root decides or sends the other
lead an instruction (`send_to_agent` on the other lead).

`answer_question` (H1) addresses the same host path; panel/remote shows `?`
on the lead *and* on the worker. Answers to the worker go to its parent
lead, not to the root, unless the worker is a direct child of the root.

### Git / handoff

Same mechanism as flat, one level higher:

1. The lead has workers snapshot (C3) or commits through the host
2. The lead integrates onto *its* branch (`baseBranch` / later
   `integrate_branch`)
3. The lead `report_done` with its branch/SHA
4. The root starts the next lead or a merge worker with
   `baseBranch` = lead branch

Without C (inspect + snapshot), multi-orch is blindness times the number of
leads. Hence **after C**, not before.

### Death of a lead

A1.1: root death lets subagents run, card greyed. Analogously:

Lead process dies → root gets `agent_exited` for the lead. **Reparent:**
living grandchildren become direct children of the root, their queue is
merged into the root queue (`subtree_adopted`). Work is not lost; the root
suddenly sees more events — only in the failure case, that is the deal.

Not: stop the grandchildren (too harsh). Not: grandchildren without a
parent (orphaned `ask_orchestrator`).

### Caps the host enforces (not the prompt)

- Depth exactly 1: `start_orchestrator` only on the root identity,
  otherwise tool error
- Max leads e.g. 4 (a constant, the profile may be tighter)
- Global `maxSubagents` incl. leads and grandchildren
- Async start (A2.1) applies to leads too — the seed must not blow 60s
- Per-agent tokens (A2.2) apply to leads too; a lead token opens neither
  root tools nor sibling subtrees

Per-role limits are **global** in v1 (one reservation net). Two leads that
both want "2 workers" share the same worker cap. Sub-budgets
(`start_orchestrator{maxSubagents:n}`) only bound the *size of the
subtree*, not the role composition. Finer (`roles` on the lead) comes
later; otherwise we build a second profile.

### Prompt edges (root)

Short, English, like the rest:

- Default flat. `start_orchestrator` only when the "Nest" table above
  applies.
- A lead is an area with its own verification loop, not a rename of
  `start_agent`.
- After `start_orchestrator`, do not poll the grandchildren —
  `await_events` delivers only lead events; you look into the subtree with
  `inspect_agent` on the lead (its worktree/branch), not with `read_output`
  on grandchildren.
- Done = every lead `report_done` + root verifies (inspect on lead
  branches) + one merge path + `record_retro`.

Lead prompt: area, parent name, the same roles/limits as the profile, plus
"you start no orchestrators. You report upward."

### Panel / remote

`WorkspaceSummary.agents` gets `parentId` + `kind:
'orchestrator' | 'lead' | <role>`. A flat list with indentation is enough
for v1 — no tree widget. The lead row shows `childCount` and the `?` when
*it* has a question for the root. Grandchild `?`s hang on the lead until
the card is expanded (otherwise the root card blinks constantly).

Remote allow-list: no new command beyond the already planned
`answer_question` (the parent follows from `agentId`). `start_orchestrator`
is not a remote API — only the root agent calls the tool.

### Ordering relative to C–E

Needs: A1.3 reservation, A2.1 async start, A2.2 per-agent tokens, A2.3 gap
(per queue). Needs C (inspect/snapshot), otherwise every lead is as blind
as the root today.

Does not need B. `ask_user` (D) becomes more important with a level in
between, but is not a blocker — leads ask the root, the root answers
(today) itself or later the user.

Do not build this into BigBoy A/B: it is an identity rework in
`server.ts` / `toolsOrchestrator.ts` / `Workspace.ts`, while A is touching
lifecycle and tokens right there.

---

## What we deliberately do not want

- Peer-to-peer between subagents **or between leads**
- A pre-started team / playbooks that spawn windows
- An orchestrator that commits, merges, tests, pushes itself
- Autodelete of worktrees/branches
- Hardcoded model catalogues
- RAG
- A second orchestration as a **product** (kanban, DAG engine, cloud
  runner, one workspace per area)
- Automatic nesting / a nesting profile toggle — the root decides via
  tool, default flat
- Automatic succession from guessed token counters (C6 is self-declare +
  optional user button, no host guessing game)
- Depth > 1 (lead starts lead). Workers may spawn **one** helper level;
  helpers cannot spawn. That is not a second lead identity.
- Grandchild events in the root's `await_events` queue (helper events
  land in the worker's nest queue, never in the root feed)
- A second MCP server for driving the browser (the extension pairs on
  `/browser` of the existing loopback listener)
- `read_output` as verification
- **Remote as a second MCP server or a mirror of all APP_CHANNELS**
  (the BigBoy allow-list is the right boundary)
- **This handbook as a parallel lifecycle/auth rework** — that is A/B
- Tunnels, TLS, an account system, internet exposure, a native app, the
  archive's `apps/mobile` (BigBoy non-goals, adopted here)
- Pi as a seventh provider (the wrap overlays spawn; slots stay Claude /
  Cursor / Codex / Kimi / Grok / Ollama)

---

## Ordering (tracks, not calendars)

```
PR #17   A1–A3 + B Remote + H3 + C1 inspect_agent + C2 done facts
     │
     ├─ still open on Remote:  H1 answer_question   H2 start{goal}
     │
     └─ Phase C   C3/C4 snapshot commit + handoff package     later
            C5 orchestrator idle watchdog              later
            C6 orchestrator succession (context handoff)  S1
            C7 model/provider reseat (needs C3 + C6)     spec
            F   multi-orch (root decides; needs C, does not need B)
            D   goal UI, user_message, ask_user (needs H1/H2)
            E   integrate/gate, briefing, resume, budget, eval
```

F after that: without inspect, every lead is exactly as blind as the one
root before. D gets cheaper once H1/H2 are pulled in. E needs C (without
inspect and snapshot, the gate is theatre). C6 needs C1/C2 (there), should
take C3 along, and is **not** F — succession replaces the root serially; F
nests beneath it.

The jump to the *strong* harness remains C (the host knows git). The jump
to the *steerable* harness remains D + H1/H2 (human in the loop, also from
the phone). F is the jump to the *broad* execution, which the root only
chooses when flat no longer carries. C6 is the jump to the *long*
execution, when the root context fills up. A/B are the foundation.

---

## Phase G — dsh adoption (S1–S5): implemented

Five patterns from the DeepSeek harness research
([`RESEARCH-DEEPSEEK-HARNESS.md`](RESEARCH-DEEPSEEK-HARNESS.md), plan in
[`PLAN-DSH-ADOPTION.md`](PLAN-DSH-ADOPTION.md)), all landed:

### G1 spill instead of truncation — **implemented**

`spill.ts` (fail-soft like the journal) stores oversizes verbatim under
`.vertragus/runs/<ws>/spill/`; `read_output{full}` and
`inspect_agent`-`diff`/`file` deliver a head/tail preview + path instead of
silent capping. Save errors degrade to the inline tail with a note, never
to a tool error. Thresholds: 6,000 / 2,000 / 1,000 characters.

### G2 quiet events — **implemented**

A `quiet` flag in the event envelope; the queue wakes waiters only on
non-quiet events, quiet events ride along on the next wake **or timeout**
(the cursor advances; listeners — journal, panel, retro — still see
everything immediately). Quiet are the echoes of the orchestrator's own
tool calls (`integrate_ok`/`integrate_conflict`, `agent_stopped`,
`user_question`) and `agent_progress` (MCP as well as sentinel).
`report_progress` is now honestly named: "visible on the next wake". The
idle hint and the sentinel ASK wiring warning still wake — both demand a
reaction.

### G3 structured reports (`resultSchema`) — **implemented**

`start_agent{resultSchema}` (subset validator in
`shared/schema/resultSchema.ts`, no ajv; fail-loud before the reservation;
rejected for sentinel roles because their done path cannot validate). An
invalid `result` on `report_done` goes back as an error **to the child**
(exact paths, no `agent_done` push) — the retry loop runs at the child, the
orchestrator only sees validated results. `agent_done.result` and
`handoff.lastResult` carry the result onward.

### G4 task board with CAS revisions — **implemented**

`taskBoard.ts`: in-memory truth + atomic snapshot
`.vertragus/runs/<ws>/tasks.json` (tmp+rename, fail-soft).
`task_create` / `task_update` / `task_list` for the root **and** leads
(owner fencing via `inScope`; `delete`/`reassign` root-only;
`stale_revision` carries the current task). `start_agent{taskId}` claims
mechanically and seeds subject/description; `agent_done` writes only
`lastReport` — **`complete` remains an explicit orchestrator decision
after verification.** Succession carries the board untruncatable in the
package, resume resets tasks of dead owners to `pending`. Board ≠
assignment: the task is "what needs doing", the assignment "what I told
the agent".

### G5 `search_runs` — **implemented**

Root-only full-text search over the journals of recent runs (including the
running one): substring, case-insensitive, excerpts ±120 characters,
journals >5 MB are skipped by name instead of silently dropped. The
institutional memory for looking things up — complements retro learnings
(push), does not replace them.

Open from the plan: loop-eval scenarios for G3/G4 (schema tester, two-task
board with succession) — unit/integration tests cover the paths, the
end-to-end scenario is follow-up work.

## Phase H — nested workers, live steering, first-party browser: implemented

Three product edges that stay inside the existing harness: workers may
offload a slice, the human can keep talking to the orchestrator after
delegation, and a worker can drive the user's real Chromium. None of
these is a second product. Lead-starts-lead stays forbidden. Fan-in is
unchanged: the root's `await_events` still sees **only direct children**.

### H.1 Nested workers (one helper level)

A worker that **may nest** is a direct child of the root, or a worker
whose parent is a lead. A helper (parent already owns a worker nest)
cannot spawn. Host gate: `canSpawnHelpers` in `mcp/types.ts`.

The nest reuses the lead runtime shape (`EventQueue`, subtree budget)
under `runtime.nests`, not `runtime.leads` — it is **not** counted
toward `MAX_LEADS`. Cap: `MAX_HELPERS_PER_WORKER = 3`; the profile
`maxSubagents` still counts every helper.

On connect, a nest-capable worker gets the reporting tools plus the
downward subset (`WORKER_DOWN_TOOL_NAMES`: start/send/await/list/stop/
read/inspect/integrate) and `browser_*`. It does **not** get `task_*`,
`ask_user`, `start_orchestrator`, or the idle watchdog. `start_agent`
on a nest refuses `taskId` (`helpers_have_no_board`). MCP workers
started by the root or a lead get `helpers: true` in the contract;
sentinel workers do not (no MCP tools to nest with).

Helper events go to the worker's nest queue via `queueForAgent`. The
root and the lead still only see their own direct children. Death of
the nest owner reparents one level up (`adoptSubtree`, same as a lead).

### H.2 Live steering (composer targeting)

The composer already existed (D2). The upgrade is an optional
**addressee**. Delivery stays one host path: `user_message` on the
**root** queue, which is what wakes a parked `await_events`. The host
never writes into a nest or lead queue from the composer — that would
be skip-level / a second brain.

`resolveUserMessageTarget`: empty / orchestrator id = untargeted (the
orchestrator handles it). A root-level child is `targetAgentId` only.
A helper (or a lead's worker that is not a root child) also sets
`relayViaAgentId` to the **root-level** ancestor, so the orchestrator
`send_to_agent`s a child it can actually address and asks that child
to pass the text down. Panel and phone both expose the select.
Display-only prefix in the orchestrator TUI:
`User (via Vertragus) → Name: text`. Do not type into the orchestrator
PTY while `await_events` is parked.

### H.3 First-party Chromium extension

Not extra MCP. Same HTTP listener as `/mcp`, path `/browser`, loopback
token. `chrome-extension:` / `moz-extension:` origins are accepted
**only** on that path. Workers (and helpers) get `browser_status`,
`browser_tabs`, `navigate`, `snapshot`, `click`, `fill`, `press`,
`screenshot`. A disconnected extension is `browser_disconnected`, never
a silent no-op. Orchestrators and leads do not get the tools — they
delegate.

Unpacked MV3 in `extensions/chromium/`; packaged as extraResources
`chromium-extension`. Settings has an **Install Chromium extension**
button that opens `chrome://extensions` and the unpacked folder, then
copies the pairing URL. How-to:
[`CHROMIUM-EXTENSION.md`](./CHROMIUM-EXTENSION.md). MCP tool-contract
version bumped to `1.1.0`.

## Phase H — Pi harness wrap: implemented

Pi is a spawn overlay, not a provider. Slots stay Claude / Cursor / Codex /
Kimi / Grok / Ollama (model route and subscription). When the wrap is on,
every agent process is `pi`; native CLIs are not spawned. Default off;
resolved at workspace start like `yoloMaster` (next Play).

### H1 overlay, not a seventh provider — **implemented**

`PROVIDER_PRESET_IDS` is unchanged. `agents/piHarness.ts` maps preset → Pi
`--provider` (`claude`→`anthropic`, `codex`→`openai-codex`,
`kimi`→`kimi-coding`, `cursor`→`github-copilot`, `grok`→`xai`; `ollama`
and custom omit `--provider` and pass `--model` only). `spawn.ts` replaces
argv entirely — Ollama's `run --nowordwrap` must not leak. Native yolo
flags are not forwarded (Pi has no permission prompts). `--tools` is not
restricted in v1 (it can hide MCP tools).

### H2 MCP via `.pi/mcp.json` — **implemented**

Pi has no native MCP. The launch writes `.pi/mcp.json` (`mcpServers`, same
key as Cursor, different file) and loads only the pinned `pi-mcp-adapter`
(`--no-extensions -e`). The Vertragus server is `{ url, lifecycle: "eager" }`
so MCP tools exist before the first user turn (the adapter's default is lazy
and races the trailing positional prompt). Extra servers stay as `{ url }` /
stdio. Native attach (`.cursor/mcp.json`, Claude transient JSON, Grok cage,
Claude/Kimi trust preaccept) is skipped. The file is on
`WORKTREE_SECRET_FILES`. The role prompt is written to `.pi/APPEND_SYSTEM.md`
and passed as `--append-system-prompt <absolute path>` so argv never carries
a multiline prompt; that file has no token and is not on
`WORKTREE_SECRET_FILES`. Wrap-on Ollama reports over MCP (`isPtyOnly` is
false).

### H3 settings toggle — **implemented**

`piHarnessEnabled` in app settings, IPC, and Settings. Cursor's closest Pi
backend is `github-copilot`; Ollama has no Pi backend — both are
documented, not papered over.

### H4 lockfile pin and Dependabot — **implemented**

`@earendil-works/pi-coding-agent` and `pi-mcp-adapter` are production
dependencies (the same package name the adapter imports — staying on the
deprecated `@mariozechner/pi-coding-agent` 0.73.1 made `-e` fail at
extension load and Pi `process.exit(1)` before `session_start`). POSIX
spawn runs Electron as Node on a CJS entry that polyfills TTY then
imports the package `bin.pi` (`dist/cli.js`), with `ELECTRON_RUN_AS_NODE=1`.
Windows spawn uses PATH `node` for that same entry and omits the env:
ConPTY cannot attach stdio to `electron.exe` (WINDOWS subsystem) and the
agent window stays blank. Node.js must be on PATH.
CI boots that Play-shaped path (`scripts/pi-play-smoke.mjs`): isolated
userData, wrap on via the settings store, throwaway git repo, pass only
when the orchestrator PTY shows a TUI and Vertragus MCP attached.
Pi 0.84 treats `-r` as `--resume`, so the entry is the *script* (argv[1]),
not a Node `-r` in front of the CLI — if Electron does not consume `-r`,
print mode stays on and a trailing Play goal plus no Pi API key is
`process.exit(1)`. The polyfill sets `stdin`/`stdout`/`stderr`.isTTY
(and a `setRawMode` stub when the stream has none). `-e` loads the installed
adapter directory (versioned `npm:pi-mcp-adapter@x.y.z` if the package is
missing). PATH `pi` remains the fallback when the CLI is not on disk (no
entry, no `RUN_AS_NODE`). `.github/dependabot.yml` allow-lists only those
two names, grouped as `pi-harness`, weekly, no automerge — overlay flags
are a contract. The CLI, photon WASM, the MCP adapter, native keyring
trees, and the CLI's unscoped `typebox` / `jiti` (the extension loader
`require.resolve`s them from unpacked `loader.js`) are unpacked
(`asarUnpack` in `electron-builder.yml`). Universal macOS sets
`mac.x64ArchFiles` to `**/node_modules/**`: per-arch optional `.node` files
(clipboard, koffi, keyring, node-pty) are byte-identical across the two
temp apps, and `@electron/universal` refuses to skip lipo unless the
pattern says that is expected. A scoped brace list misses unscoped addons
such as koffi. `mac.mergeASARs` stays false: the unpacked Pi trees make
`@electron/universal`'s brace-glob of unpack paths overflow minimatch
(`pattern is too long`), and the JS inside asar is already arch-identical.

## Phase A3 — automation: adoption without a click, and the run's pull request

Off by default, per profile (`automation` in `shared/schema/profile.ts`),
and deliberately built on the merge paths that already exist — an
automated adoption is a **missing click, never a second merge path**.

### A3.1 auto-integrate / auto-promote

`autoIntegrate` merges every branch a direct child reports as a clean
`success` into the **orchestrator's** worktree; `autoPromote` merges it
into the **repository's own checkout** — E1's Promote without the click,
including its refusal on a dirty checkout. Both run through
`mergeBranchIntoWorktree` / `Workspace.promoteAgentBranch`, both push the
existing `integrate_ok` / `integrate_conflict` events (new optional field
`target: worktree | checkout`), and neither ever throws into the report
path: `report_done` and the sentinel done hand over to
`Workspace.adoptOnDone` and are done with it. Narrow on purpose: only a
`success`, never the orchestrator's own branch, and only agents that report
to the root queue — a lead's workers are the lead's business.

### A3.2 auto-PR

`autoPr` opens the run's pull request when the work is done: at
`record_retro` (the orchestrator's own end-of-run call, which gets the URL
back in its answer) or when the user stops the workspace — whichever comes
first, at most once per run. Head is the run's own integration branch (the
orchestrator's, else the checkout's when that is the one ahead), base is
`prBaseBranch` or the branch the checkout is on. `agents/pullRequest.ts`
pushes with `git push -u` (never `--force`) and opens the PR with `gh`; a
missing or logged-out `gh` is not a failed run but a `pull_request` event
carrying the ready-made GitHub compare URL, which the panel card shows as a
link. The orchestrator prompt renders an automation block for exactly the
switches that are on, so it stops telling the user to merge a branch the
host already merged.

## Per-identity extra system prompts

Optional, per profile (`rolePrompts` in `shared/schema/profile.ts`). The
profile editor lists Orchestrator, Lead and every role template. A **new**
profile ships with short starter texts (`INITIAL_ROLE_PROMPTS` in
`prompts/rolePrompt.ts`) the user can edit, clear, or restore; an existing
profile that never stored extras stays empty. Empty means the shipped /
host-generated prompt only. Starters are a **communication overlay**
(who reads the report, the language of the goal, a distilled handoff) —
not a second copy of the shipped role duties or the orchestrator loop.
A filled field is
**appended** at spawn (`appendUserRolePrompt`) after the Worker/Tester
role text, the orchestrator loop prompt, the lead prompt, and the
successor seed alike. It never replaces those, so a user cannot erase
"never commit" or the `await_events` loop. Custom roles still have their
own template prompt (what the role *does*); the profile field is how
that role *speaks* in this project.

## Appendix: code anchors

| Topic | Where | Status |
| --- | --- | --- |
| Orchestrator exit | `Workspace.ts` `handleExit` → `orchestrator_exited` | **PR #17** |
| Slot with free capacity | `Workspace.ts` `slotWithCapacity` | **PR #17** |
| Async `start_agent` | `toolsOrchestrator.ts`, prompt in `orchestrator.ts` | **PR #17** |
| Per-agent subtoken + origin | `server.ts` `subagentToken`, `isAllowedHostHeader` | **PR #17** |
| Gap visible | `eventQueue.ts` `droppedSince` → `await_events.eventsDropped` | **PR #17** |
| Panel push | `WorkspaceDirectory.onChange` | **PR #17** |
| Quit awaited | `index.ts` `before-quit` | **PR #17** |
| Sixteen orchestrator tools (incl. `request_succession`, `search_runs`, `task_*`) | `toolsOrchestrator.ts` incl. `inspect_agent` | **C6 S1 / G** |
| Host facts on `agent_done` | `toolsSubagent.ts` `report_done`, sentinel in `Workspace.ts` | **PR #17** |
| MCP identity threefold (root/lead/leaf) | `server.ts` `McpIdentity` incl. `lead=` + `leadToken` | **Track 5** |
| One orchestrator per workspace | `Workspace.startOrchestrator` throws on a second — C6 replaces serially, does not nest | **C6 S1** |
| Goal at Play | `workspaces:start{goal}` panel + gateway, seed via `Workspace.assignGoal` | **Track 0** |
| MCP questions from phone/panel | `answer_question` gateway verb + `workspaces:answerQuestion`, one path in `mcp/answerQuestion.ts` | **Track 0** |
| Worker "never commit" + host snapshot | `roles.ts`, `Workspace.snapshotDone`, `commitWorktree`, handoff in `toolsOrchestrator.ts` | **Track 1** |
| `runStats.ts` "cursor has no agent_done" | outdated (`none` = Ollama) | ignore |
| Automation: adoption without a click, run pull request | `schema/profile.ts` `automation`, `Workspace.adoptOnDone` / `openRunPullRequest`, `agents/pullRequest.ts` | **A3** |
| Worker helpers (one extra level) | `types.ts` `canSpawnHelpers` / `ensureNest` / `MAX_HELPERS_PER_WORKER` | **Phase H** |
| Live `user_message` targeting | `userMessageTarget.ts`, `Workspace.postUserMessage` | **Phase H** |
| Chromium `/browser` bridge | `browserBridge.ts`, `toolsBrowser.ts`, `extensions/chromium/` | **Phase H** |
| Pi harness wrap (not a seventh provider) | `agents/piHarness.ts`, `spawn.ts` overlay, `.pi/mcp.json`, settings `piHarnessEnabled`, lockfile pin, `.github/dependabot.yml`, `electron-builder.yml` | **H** |
| Per-identity extra system prompt | `schema/profile.ts` `rolePrompts`, `prompts/rolePrompt.ts`, profile editor | **this** |
