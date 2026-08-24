English | [Deutsch](MODEL-PROVIDER-SWITCH.de.md)

# Model and Provider Switch Mid-Run (Reseat)

Plan for changing the **model, the provider, or the effort level of a running
agent** — root orchestrator and worker alike — without throwing the run away.

**Status:** spec only. Nothing of this is in the runtime yet. The orchestrator
half is a small extension of C6 succession (already shipped as S1); the worker
half is a new tool with no predecessor.

**Not this feature:**

| Lookalike | What it actually is |
| --- | --- |
| Profile editor provider/model fields | Configuration for the *next* Play, not for the run in flight |
| `start_agent{providerId, model}` | Choice at birth, bounded by the profile slots |
| C4 `start_agent{baseBranch}` | A *different* agent continues on a branch — a new seat, not the same one |
| C6 succession | Same feature family, but the seat keeps the profile's provider today |
| Phase F `start_orchestrator{model}` | A nested Lead, started once, never re-seated |
| `stop_agent` + `start_agent` | Today's workaround — and it silently loses work (see §3.2) |

**One-line verdict:** A running CLI cannot change its provider, so a switch is
either a provider-declared in-session command (model only, same provider) or a
**reseat** — same seat (role, slot, worktree, branch, queue, open questions),
new process, context carried across in a host-built package.

---

## 1. Problem

Provider and model are **launch-time argv**. `spawnAgent` composes the
executable (`provider.command`), the model (`modelArg`, or positional for
Ollama), the effort flag, the MCP attach dialect and the system-prompt
delivery once, at spawn. Nothing in a live PTY process can be re-pointed
afterwards.

Every real reason to switch, however, arrives *mid-run*:

- The provider's rate limit or quota window closes. The CLI keeps running and
  stops being useful — or dies.
- The model is wrong for the phase: cheap and fast for the survey, strong for
  the tricky refactor, cheap again for the mechanical follow-up.
- One provider failed twice at the same task and a second opinion is the whole
  point of having six of them.
- The user watches a terminal and knows better than the run does.

Today the answers are: restart the workspace (throws away the run), or
`stop_agent` + `start_agent` (see §3.2 for what that loses), or nothing at all
for the root.

---

## 2. Two mechanisms, one feature

### 2.1 In-session model switch (same process)

Some CLIs take a slash command that swaps the model inside the running
session (`/model …`). Context is fully preserved and the switch costs nothing.

Its limits are hard: it can never change the **provider** (that is a different
executable), it is not declared anywhere in `ProviderConfig` today, and typing
into a PTY mid-turn is either swallowed or mangled. For the root it is worse
than that — typing into the orchestrator TUI while `await_events` is parked
starts a second turn in a process that is already driving the loop, which is
exactly the two-brains failure the handbook names under H1.

So this path is an **optimization**, gated to: provider declares it, same
provider, agent is idle, host measures the acceptance. Never the mechanism a
provider switch relies on. Details in §7.

### 2.2 Reseat (new process, transferred context)

The general mechanism. Kill the CLI, keep the **seat** — everything that is
host state rather than model state — and start a new CLI in it with a package
that says what happened so far.

What "the seat" means, per kind:

| Seat property | Orchestrator | Worker |
| --- | --- | --- |
| Identity in the roster | new `agentId` (C6 decided this) | **same `agentId`** (see §4) |
| Worktree / branch | new orch worktree | **same worktree, same branch** |
| Event queue | same instance | same instance |
| Open questions | same registry | same registry, **not cancelled** |
| Slot reservation | none | held across the gap |
| MCP token | `orchToken` rotated | per-agent subtoken rotated |
| Context transfer | succession package (`handoff.ts`) | worker package (C4 block, host-enriched) |

Both halves are lossy in the same way: the new process gets a structured brief,
not the predecessor's transcript. That is the price, and it is the reason a
reseat is a *decision*, not something the host does on its own.

---

## 3. What the code does today

### 3.1 The orchestrator seat

C6 succession already performs a full seat handover: `requestSuccession` freezes
a package (`buildSuccessionPackage`), persists it, rotates `orchToken`, spawns
and seeds the successor, then kills the predecessor's PTY — with the same
`EventQueue`, the same `PendingQuestions` and the same subagents throughout.
`replaceOrchestratorFromHost()` is the same path from the host, and it accepts
a dead predecessor.

The single thing it cannot do is change the seat's brain:
`spawnOrchestratorRecord` reads `this.profile.orchestrator.providerId` and
`this.profile.orchestrator.model` directly. A successor is therefore always the
same model as the incumbent that ran out of context — or out of quota.

That makes the orchestrator half of this feature **one parameter plus a
preflight**, not a new mechanism.

### 3.2 The worker seat

There is no reseat. The nearest thing an orchestrator can do is
`stop_agent{agentId}` followed by `start_agent{role, providerId?, model?,
baseBranch: <the branch>}`. That works — C3 and C4 make the branch and the
handoff block real — but it is not the same seat, and four things go missing:

1. **Uncommitted work.** `stopAgent` goes straight to `terminate`, which kills
   the PTY. Only `snapshotDone` commits a dirty worktree, and it runs on
   `agent_done`. Stopping a worker mid-task therefore discards everything it
   has not committed — and the role prompts tell workers *not* to commit.
   This is the sharpest edge in the current workaround.
2. **The open question.** `terminate` calls `questions.cancelForAgent`. A
   worker parked in `ask_orchestrator` loses its waiter on the way out.
3. **Identity.** New `agentId`, new name (`names.release`), new window. The
   task board's `ownerAgentId`, every note the orchestrator wrote about that
   agent, and every event already on the queue now point at a corpse.
4. **The provider is not free.** `beginAgent` resolves the slot through
   `slotWithCapacity(role, {providerId})`, which is a **hard error** when no
   slot of that role runs the requested provider. Moving a reviewer from Codex
   to Claude is impossible unless the profile happens to declare a Claude
   reviewer slot. The stop also frees the slot, so a concurrent `start_agent`
   can take it before the replacement does.

The assignment text is not stored on `AgentRecord` at all, so even a perfect
caller has to remember and resend the task verbatim.

---

## 4. Design decisions (defaults)

| Decision | Default | Why |
| --- | --- | --- |
| Mechanism | Reseat first; in-session `/model` later and optional | Only the reseat can change a provider; it must not depend on the fragile path |
| Orchestrator surface | `request_succession{successor:{providerId?, model?, effort?}}` | The state machine, the fencing and the package already exist — do not build a second cutover |
| Worker surface | New tool `reseat_agent{agentId, providerId?, model?, effort?, reason?, note?}` | `stop_agent` + `start_agent` cannot express "same seat" |
| Worker `agentId` | **Unchanged**; a `generation` counter rises | A worker's identity is its branch and its task, not its process (the root chose the opposite for its own window identity — deliberately) |
| Worker worktree/branch | **Reused** | The work in progress *is* the handover; a fresh branch would need a merge to say the same thing |
| Uncommitted work | **Host snapshot-commits before the kill** | Same commit path as C3 (`commitWorktree`), so the package's SHA is true |
| Slot | **Held** across the gap | Freeing it invites a race for the seat the reseat is about to take |
| Slot vs. provider | A reseat **may leave the profile's slots** | Otherwise a provider switch depends on the profile having guessed it in advance. The slot's *capacity* still binds; its provider does not |
| Open questions | **Kept**; the successor is told about them | An orphaned MCP waiter is worse than a delayed answer (C6 made this call already) |
| Preflight | Health + auth + model list **before** anything is killed or rotated | A wrong model string must fail as a refusal, not as a run without a driver |
| Persistence | Run-local; the profile is **not** rewritten | The profile is the user's configuration; a switch is a fact about this run. The run's `meta.json` carries it so E3 resume restarts the seat that actually ran |
| Host autonomy | The host **never switches by itself** | Same rule that keeps C5 from spawning: detect, report, let the orchestrator or the user decide |
| Effort | Rides along with model and provider | `EFFORT_LEVELS` is already provider-agnostic; a provider without `effortArg` drops it |

---

## 5. Orchestrator reseat — C6 plus one field

### 5.1 Tool surface

```
request_succession{
  reason: "context_full" | "long_run" | "user_requested"
        | "provider_limit" | "provider_switch" | "other",
  successor?: { providerId?: string, model?: string, effort?: "low"|"medium"|"high" },
  goal?, decisions?, risks?, nextActions?, agentNotes?, note?   // unchanged
}
```

Two new reasons, because "my provider stopped serving me" and "I want a
stronger model for the endgame" are not `other` — the panel, the journal and
the retro all read this field.

Host side: `SuccessionRequest` carries the override, the succession state
holds it, and `spawnOrchestratorRecord` takes a `seat` argument instead of
reading the profile. The package records both ends
(`predecessor{providerId, model}` already exists; add `successor{…}`), so the
successor's own seed says which brain it replaced.

`replaceOrchestratorFromHost({providerId?, model?, effort?})` is the same
override from the panel — and because it accepts a dead predecessor, it is the
answer to "Claude hit its limit and the orchestrator died": pick another
provider, keep the team, keep the queue.

### 5.2 Preflight before the cutover

The cutover order in C6 is: rotate token, spawn successor, kill predecessor.
That order is right when the successor is the same CLI that just worked. With
an override, spawn failure stops being a freak event — a typo'd model name is
now the *likely* failure — and by then the incumbent's token is already dead.

So a reseat validates before it enters `PREPARING`:

1. Provider exists in the registry and can hold the root seat (§5.3).
2. `health.ts` version probe answers inside `HEALTH_TIMEOUT_MS`.
3. `authStatus.ts` is not `logged-out` (`unknown` passes, with the state
   recorded in the event — half the CLIs cannot answer honestly and guessing is
   worse).
4. The model appears in `discovery.ts`'s list for that provider, when the
   provider has a discoverable list. An unknown list is a warning, never a
   refusal — hard-coded catalogues are a handbook non-goal.

Failing any of 1–3 refuses the tool call with the reason. Nothing is frozen,
no token rotates, the incumbent keeps driving.

### 5.3 What the target provider must be able to do

The root drives the loop through MCP. A provider with `mcp: {kind: 'none'}` —
Ollama today — **cannot hold the orchestrator seat**, and a reseat into it must
refuse rather than produce a silent root. This is worth a guard test: it is an
invariant about descriptors, and descriptors are user-editable.

`systemPromptDelivery: {kind: 'pty'}` (Cursor, Ollama) is allowed but
expensive: the whole succession package goes through the seed handshake as
typed text. The package cap (`PACKAGE_MAX_CHARS`, 48k) is sized for a launch
flag, not for a TUI paste. A PTY-delivered successor gets a tighter cap and the
existing measured handshake decides whether it worked — `interactiveReady`
already refuses a seed that was not accepted.

---

## 6. Worker reseat — `reseat_agent`

### 6.1 Tool surface

```
reseat_agent{
  agentId: string,
  providerId?: string,
  model?: string,
  effort?: "low" | "medium" | "high",
  reason?: "provider_limit" | "stuck" | "second_opinion" | "cost" | "user_requested" | "other",
  note?: string          // one line for the successor, capped like an orchNote
}
```

Async like `start_agent`: returns `{state: "reseating", agentId, generation}`
quickly, and the queue carries the outcome. At least one of `providerId`,
`model`, `effort` must differ from what the agent runs — a reseat that changes
nothing is a restart, and restarts have their own cost.

### 6.2 State machine

```
RUNNING
  │ reseat_agent
  ▼
SNAPSHOT        — commitWorktree if dirty (C3 path); facts recorded
  │
  ▼
PACKAGED        — worker handoff package built from HOST state
  │
  ▼
SWAPPING        — rotate subtoken; kill PTY; keep record, slot, name, questions
  │
  ▼
SEEDING         — spawn new CLI in the SAME worktree; seed role prompt +
  │               contract (new dialect!) + package
  ▼
RUNNING'        — generation + 1
```

The kill must **not** go through `terminate`: that releases the name, closes
the window, drops the registry entry and cancels the agent's pending
questions — the exact four things the seat is supposed to keep. This is the
worker-side twin of C6's "must not go through `stopWorkspace`" rule, and it
deserves the same explicit note in the code.

Failure after `SNAPSHOT` never loses work: the branch holds the commit. Failure
in `SEEDING` leaves the record `stopped` with its worktree intact and emits
`agent_reseat_failed` — from there `start_agent{baseBranch}` is a real fallback,
because by then the work *is* committed.

The package is the C4 block (`contract.ts`) with the fields the host already
computes: branch, `headSha`, `changedFiles`, `diffStat` from the snapshot; the
agent's last summary and last `agent_done` result; its open question if it has
one; and the **original assignment text**. That last one needs a new capped
field on `AgentRecord` (`lastAssignment`), set where the task is delivered —
without it the orchestrator has to resend the task from its own context, which
is the context a reseat exists to stop spending.

### 6.3 The dialect transition

A provider switch can cross the MCP/sentinel line, and that is a state change
in the record, not just different argv. `reportingForProvider` derives the mode
from `mcp.kind === 'none'`, so:

- **mcp → sentinel:** the contract text must be rebuilt with the sentinel
  protocol, `record.sentinel` created, the silence watchdog armed,
  `suppressSentinel` handled around the seed.
- **sentinel → mcp:** the parser and the watchdog go away, and the new process
  gets its own subagent MCP URL and pre-approved tools.

Also provider-specific and therefore rebuilt per reseat: the yolo flags (D4
tiers), the extra MCP servers of the slot (E6, dialect differs per provider),
and the `.git/info/exclude`-scoped config files, which are written per spawn
with a `fileTag` — the tag must include the generation so a stale config from
the predecessor cannot be picked up.

---

## 7. In-session model switch (optional fast path)

Only worth building after the reseat exists, because it is the only path that
can *lie*: if the CLI silently rejects the model, the host believes something
about the run that is not true.

Descriptor surface, optional and per provider:

```
modelSwitch?: { kind: 'slash', template: '/model {model}', confirm?: string }
```

Host rules:

- Same provider only. A `providerId` in the request means reseat, always.
- Only when the agent is **not mid-turn** — for a worker, between assignments;
  for the root, never through the PTY while `await_events` is parked (H1).
  In practice that leaves the root out entirely until there is a non-PTY way
  in, which is fine: the root already has the succession path.
- Measured like the seed handshake: type, then confirm from the scrollback
  (`confirm` pattern, or the model name echoing back). No confirmation means
  the switch **failed** and the record keeps its old model.
- On success: `record.model` updated, `agent_model_changed` on the queue.

If a provider declares nothing, the fast path does not exist for it and every
switch is a reseat. That is the honest default.

---

## 8. Triggers: who decides

| Trigger | Path | Note |
| --- | --- | --- |
| Orchestrator, for itself | `request_succession{successor}` | It is the only one that knows its own context pressure |
| Orchestrator, for a worker | `reseat_agent` | "Codex failed this twice, put Claude on it" is an orchestration decision |
| User, on the root | Panel/Remote "Replace orchestrator" gains a provider/model picker | Works on a dead root too |
| User, on a worker | Agent card action → IPC → `reseat_agent` host path | Same host path as the tool, never a second one |
| Host, on a detected provider failure | **Hint event only** | `discovery.ts` already has `AUTH_FAILURE_PATTERN`; a rate-limit pattern in the scrollback earns a `provider_limit_suspected` event and a card, not an automatic switch |

The host never switches on its own. Guessing token budgets is already a
rejected idea (E4), and a host that re-seats a worker behind the
orchestrator's back breaks the one rule the whole harness rests on: host truth
first, but host *decisions* never.

---

## 9. Events, panel, remote

New members of `AGENT_EVENT_TYPES`:

| Event | Meaning |
| --- | --- |
| `agent_reseated` | `{agentId, generation, from:{providerId, model, effort}, to:{…}, reason}` |
| `agent_reseat_failed` | Seeding failed; the record is stopped, the branch holds the snapshot |
| `agent_model_changed` | In-session switch confirmed (§7) |
| `provider_limit_suspected` | Host observation, no action taken |

`orchestrator_handoff_started` and `orchestrator_started` gain the seat fields
rather than getting siblings — a reseat of the root *is* a succession.

Panel and Remote: the agent card shows the live provider/model (it shows the
record, so this follows once the record is right) plus a generation badge when
> 1, and the run summary lists what the seat has been. Both locales, plus
`mainMessages.ts` for anything the main process emits.

---

## 10. Failure modes

| Mode | Mitigation |
| --- | --- |
| Target CLI missing or logged out | Preflight refuses before anything is frozen or killed |
| Model name wrong | Discovery warning; the spawn's own failure keeps the predecessor (root) or the snapshot (worker) |
| Provider cannot hold the root seat | Hard refusal on `mcp.kind === 'none'`, pinned by a guard test |
| Package too large for a PTY-delivered successor | Tighter cap + measured handshake; refuse rather than half-seed |
| Worker dirty on kill | Snapshot commit precedes the kill; a git failure aborts the reseat |
| Two processes on one worktree | The kill is awaited before the spawn; the record's generation gates late output from the predecessor |
| Stale per-agent config file | `fileTag` includes the generation |
| Open question mid-reseat | Registry keeps it; the successor's package lists it |
| Slot stolen during the gap | The reservation is never released |
| Reseat during a succession | Refuse both ways — one cutover at a time per workspace |
| Reseat loop (each new provider fails) | Cap consecutive reseats per agent; the cap refusal is an event, not a silent stop |
| Resume after crash | `meta.json` carries the current seat, so E3 does not resurrect the profile's provider |

---

## 11. Code touch list (when implementing)

| File | Change |
| --- | --- |
| `src/shared/schema/provider.ts` | Optional `modelSwitch` descriptor (§7 only) |
| `src/shared/schema/handoff.ts` | `successor` seat block; two new reasons |
| `src/shared/schema/events.ts` | The four events of §9 |
| `src/shared/schema/tasks.ts` | Nothing — same `ownerAgentId`, which is the point |
| `src/shared/prompts/orchestrator.ts` | When to reseat vs. succeed vs. stop; that a reseat costs the worker's context |
| `src/shared/prompts/contract.ts` | Reseat variant of the C4 handoff block |
| `src/shared/prompts/orchestratorHandoff.ts` | Render the seat change in the successor seed |
| `src/main/providers/health.ts`, `authStatus.ts`, `discovery.ts` | Reused as the preflight; no new probes |
| `src/main/mcp/toolsOrchestrator.ts` | `reseat_agent`; `successor` on `request_succession`; tool name lists (root and lead) |
| `src/main/mcp/types.ts` | Host API for both |
| `src/main/mcp/server.ts` | Subtoken rotation per generation |
| `src/main/workspace/Workspace.ts` | `seat` argument on `spawnOrchestratorRecord`; `reseatAgent` state machine; snapshot-before-kill; slot hold; dialect transition; `lastAssignment` on the record |
| `src/main/ipc.ts`, panel, remote | Picker on the replace action; agent card action; badges |
| `src/shared/mainMessages.ts`, renderer i18n, remote i18n | Both languages |
| Tests | See §12 |

---

## 12. Sequencing

```
M0  This spec + handbook pointer (C7)
     │
M1  Root seat override: successor{providerId, model, effort} + preflight
    + the two new reasons — reuses the whole C6 cutover
     │
M2  Host/panel picker on "Replace orchestrator" (covers the dead root)
     │
M3  reseat_agent: snapshot-before-kill, record generation, slot hold,
    dialect transition, lastAssignment
     │
M4  In-session /model fast path, provider-declared and measured
     │
M5  meta.json/journal carry the seat into E3 resume; live probe
```

M1 is genuinely small and independently useful — it is the answer to a root
that lost its provider. M3 is the large one, because it touches the record's
lifecycle. M4 is optional forever.

### Test plan

**Unit:** preflight refusals (missing CLI, logged out, `mcp: none` for the
root); seat override reaches `spawnAgent`'s argv; reseat rejects a no-op
change; snapshot precedes the kill; `terminate` is not on the reseat path
(name, window, registry, questions all survive); slot count unchanged across
the gap; dialect transition creates/destroys the sentinel parser; generation
in `fileTag`; reseat during succession refuses both ways.

**Integration:** full MCP loop — worker asks a question, is reseated, the
question is still answerable afterwards; a reseated worker's `report_done`
lands on the same `agentId` and the same branch; a sentinel worker reseated
onto an MCP provider reports through the tool and vice versa; root reseat to
a second provider keeps subagent URLs valid and invalidates the old
`orchToken`.

**Live** (`VERTRAGUS_LIVE=1`): real Claude root reseated onto Codex mid-run
with workers up; real Codex worker reseated onto Claude with uncommitted work
in its worktree — the commit must be in the branch and the successor must see
it.

**Guard:** every provider descriptor that may hold the root seat declares an
MCP attach; the docs twins of this file stay in sync.

---

## 13. Non-goals

- Automatic host-side switching on guessed token counts or cost budgets
- Switching mid-turn, or interrupting a running turn to switch
- Migrating a CLI's own conversation state between providers (there is no such
  format; the package is the transfer)
- A second merge or branch path — a worker reseat reuses its branch, a root
  reseat gets a fresh orch worktree exactly like today
- Rewriting the profile from a run-local decision
- Per-turn model routing, a router, or a cost optimizer
- Reseating a Lead's children implicitly when the Lead is reseated
- Depth or nesting changes of any kind — a reseat replaces, never adds

---

## 14. Relation to the harness handbook

Recorded as **C7 model/provider reseat** under Phase C, directly after C6, in
[`HANDBOOK-HARNESS.md`](./HANDBOOK-HARNESS.md). It needs C3 (the snapshot
commit that makes a worker reseat safe) and C6 (the cutover it extends); it is
independent of F, and it is not a second product surface.
