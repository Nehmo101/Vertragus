English | [Deutsch](ORCHESTRATOR-SUCCESSION.de.md)

# Orchestrator Context Handoff (Succession)

Plan for replacing the **root** orchestrator mid-run when its LLM context is
exhausted — fresh brain, same team, same workspace.

**Status:** S1 vertical slice is in the runtime (`request_succession`, token
rotation, host-enriched package, successor seed). User button, C5 idle
escape hatch, C3 SHA alignment, and crash recovery from disk are later.

**Not this feature:**

| Lookalike | What it actually is |
| --- | --- |
| C4 Handoff-Paket | Worker → next worker via `start_agent{baseBranch}` |
| Phase F Multi-Orch | Concurrent nested **Lead** under the root |
| Live `handover` tests | Seed delivery into a CLI PTY |
| E3 Resume | Host recovery after crash / workspace restart |
| README “without a second orchestrator” | Rejects nesting-as-product and human-out-of-loop — **not** serial succession |

**One-line verdict:** Succession = serial replacement of
`Workspace.orchestratorRecord` inside the same workspace, same `EventQueue` /
`PendingQuestions` / subagents, with a host-enriched handoff package and a
fenced predecessor — not a Lead, not C4, not `stopWorkspace`.

---

## 1. Problem

The orchestrator is the only long-lived LLM that accumulates the run:

- It alone loops on `await_events` over the workspace `EventQueue` (ring 1000).
- It alone answers `ask_orchestrator` via `PendingQuestions`.
- Subagents already have isolated contexts; they rarely need succession.

Today there is exactly one orchestrator per workspace
(`Workspace.startOrchestrator` throws if one exists). If it dies,
`orchestrator_exited` greys the card; subagents keep running; **nobody drives
the loop**. There is no intentional “fresh context, same team” path.

Long runs therefore hit a failure mode the handbook did not yet name:
**context saturation of the root**.

---

## 2. Design decisions (defaults)

| Decision | Default | Why |
| --- | --- | --- |
| Trigger | Orch tool **primary**; user button **escape**; **no** host auto-detect | Host cannot see provider token counts (E4 already rejects guessed counters) |
| Tool name | `request_succession` | Self-declare ≠ run end (`record_retro`) |
| Identity | New orch `agentId` + new Guide name + **new orch worktree** | Process/window identity; NameAllocator already separates guides |
| `orchToken` | **Rotate on cutover** | Same URL for two CLIs = two brains on one queue — the critical race |
| `subToken` / worker MCP URLs | **Unchanged** | Must not rewrite every worker attach config |
| EventQueue | **Same instance**; package carries `eventCursor` | Do not close/recreate (unregister still owns lifetime) |
| PendingQuestions | **Same registry**; never clear on succession | Orphaned MCP waiters are worse than delay |
| Cutover order | Invalidate old token → spawn/seed successor → kill old PTY | Zombie predecessor cannot mutate after invalidation |
| Overlap | At most one **valid** orch token; brief spawn window only | Fence old tool calls with `succession_in_progress` |
| `record_retro` | Forbidden during succession / from non-active orch | Handoff ≠ run end; host enforces generation |
| C5 idle | Orthogonal | Detects silence; does not invent a package or auto-spawn |
| Phase F | Only **root** may succeed; Leads `report_done` | Succession ≠ nesting |

---

## 3. Host surface

### 3.1 Tool (ninth orchestrator tool)

```
request_succession{
  reason: "context_full" | "long_run" | "user_requested" | "other",
  goal?: { original?: string, current?: string },
  decisions?: string[],
  risks?: string[],
  nextActions?: string[],
  agentNotes?: { agentId: string, note: string }[],
  note?: string
}
```

Host validates, **enriches** with roster / open questions / cursor / git facts,
enters the succession state machine, returns quickly
`{ state: "succession_started", … }` (async, like `start_agent` — do not block
the 60s MCP timeout on full spawn).

### 3.2 Events (extend `AGENT_EVENT_TYPES`)

| Event | Meaning |
| --- | --- |
| `orchestrator_handoff_started` | Cutover began; package frozen |
| `orchestrator_started` | Successor accepted seed (mirrors `agent_started`) |
| `orchestrator_handoff_failed` | Spawn/seed failed; recovery policy below |
| `orchestrator_exited` | **Unplanned** death only — succession must not look like a crash |

### 3.3 Optional later

- Panel / Remote: `workspaces:succeed_orchestrator` with host-built minimal
  package (roster + open questions + goal stub) when the orch cannot self-declare.
- C5 idle card offers that button — C5 itself never spawns a successor.

---

## 4. State machine

```
RUNNING
  │ request_succession
  ▼
PREPARING          — draft package; reject concurrent succession
  │ atomic write
  ▼
PACKAGE_READY      — durable on disk; recoverable after crash
  │
  ▼
SUCCESSOR_STARTING — rotate orchToken; spawn + seed successor
  │
  ▼
CUTOVER            — bind successor as orchestratorRecord; kill old PTY
  │
  ▼
ACTIVE             — successor await_events{cursor: package.eventCursor}
```

**Persist:** `.vertragus/runs/<workspaceId>/succession.json` (atomic rename).

**Failure mid-handoff:**

- Before `PACKAGE_READY`: abort → grey card / predecessor unfenced if alive.
- After `PACKAGE_READY`: `recoverSuccession()` can spawn from package.
- Never leave two PTYs both believing they own the loop.

**Invariant table**

| Object | During succession |
| --- | --- |
| `workspaceId` | unchanged |
| `EventQueue` | same instance |
| `PendingQuestions` | same registry |
| Subagent PTYs / worktrees | keep running |
| `orchToken` | rotated at cutover |
| MCP identity kind | still `orchestrator` (not Lead) |

---

## 5. Handoff package schema

**Transport:** JSON on disk; the successor seed/system prompt renders the
package once as capped prose (no additional JSON dump — same content twice
would double the most expensive prompt of the system). Thin pointer event on
the queue.

```jsonc
{
  "schemaVersion": 1,
  "kind": "orchestrator_succession",
  "workspaceId": "...",
  "workspaceName": "...",
  "profileId": "...",
  "createdAt": 0,
  "reason": "context_full",
  "predecessor": { "agentId": "...", "name": "...", "providerId": "...", "model": "..." },
  "goal": { "original": "...", "current": "..." },
  "eventCursor": 0,
  "recentEvents": [],
  "agents": [],
  "openQuestions": [],
  "decisions": [],
  "risks": [],
  "nextActions": [],
  "branchesOfInterest": [],
  "orchWorktree": { "dirty": false, "changedFiles": [] },
  "limits": { "maxChars": 48000, "truncated": [] }
}
```

### Ownership & caps

| Field | Source | Cap |
| --- | --- | --- |
| `goal.*` | orch; host falls back to the delivered goal (`assignGoal`) when omitted | 2× 2k chars |
| `eventCursor` | **host** (`events.cursor` at freeze) | int |
| `recentEvents` | **host** | ≤40 or ≤24k; prefer done/question/exited/start_failed |
| `agents[]` | **host** roster + C2 facts | full roster; summary ≤500; files ≤20 |
| `agents[].orchNote` | orch optional | 300 |
| `openQuestions[]` | **host** from `PendingQuestions` | **never truncate** |
| `decisions` / `risks` / `nextActions` | orch | ≤15/10/10 × 300 |
| `orchWorktree` | **host** inspect | warning only — do not block |
| Total | host | **~48–64k**; truncate orch prose first, then `recentEvents` |

### Must not

- Full transcript / every `agent_progress`
- File diffs (use `inspect_agent`)
- Closing open questions
- Calling `record_retro`
- Claiming the run is finished

---

## 6. Prompt changes

**Incumbent** (`buildOrchestratorSystemPrompt`):

- Call `request_succession` when context is nearly full, the provider warns, or
  you are losing track of agents/decisions.
- Do **not** call it when the goal is done — that is `record_retro`.
- Do not code; do not retro on handoff; fill fields honestly; omit unknowns.
- After calling it, stop; further tools may fail (`succeeded` /
  `succession_in_progress`).

**Successor** (seed = system prompt + package block):

- You are a **continuation**, not a new run.
- First: read package → `list_agents` → clear open questions →
  `await_events` from **package.eventCursor**.
- Trust host facts over prose; verify with `inspect_agent`.
- `record_retro` only at true goal completion.

---

## 7. Code touch list (when implementing)

| File | Change |
| --- | --- |
| `src/shared/schema/handoff.ts` | **New** — zod package |
| `src/shared/schema/events.ts` | handoff / started / failed events |
| `src/shared/prompts/orchestrator.ts` | succession rules |
| `src/shared/prompts/orchestratorHandoff.ts` | **New** — format package into seed |
| `src/main/mcp/toolsOrchestrator.ts` | `request_succession`; extend tool name list |
| `src/main/mcp/types.ts` | host succeed API |
| `src/main/mcp/server.ts` | token rotation; session kill for old orch; instructions |
| `src/main/workspace/Workspace.ts` | `replaceOrchestrator` / succession SM; relax single-orch throw |
| `src/main/workspace/WorkspaceManager.ts` | notifyChange; never route via `stopWorkspace` |
| Panel / IPC / Remote (later) | badge, auto-focus, user button |
| Tests | see §9 |

**Must not** go through `unregisterWorkspace` / `stopWorkspace` — that closes
the EventQueue and kills the team.

---

## 8. Failure modes (summary)

| Mode | Mitigation |
| --- | --- |
| Mid-handoff crash | Durable `PACKAGE_READY`; recover spawn |
| Asks during cutover | Accept into registry; successor drains first |
| Old orch keeps tooling | Token rotate + generation gate + kill |
| Duplicate retro | Host reject non-active / in-progress |
| Cursor lost / ring gap | Packaged cursor + same queue + `eventsDropped` reconcile |
| Dirty orch worktree | Host warning only; no auto-commit |
| Remote on old PTY | New agentId/window; clients rebind from summary |
| Dual valid orch URLs | Forbidden — one valid token always |

---

## 9. Sequencing

```
Done (#17): C1, C2, EventQueue gaps, async start, tokens
     │
PR-S0  Spec (this doc) + handbook pointer
     │
PR-S1  Vertical slice: tool → package → token rotate → successor
       await_events at cursor → answer one planted question
     │
PR-S2  Harden + C3 alignment (committed worker truth in package),
       crash recovery, retro gate, panel badge
     │
PR-S3  User “Replace orchestrator” + optional C5 escape hatch
     │
PR-S4  Live probe (E5 family)
```

**Gates:**

- Block merge until C1/C2 stay green (already landed).
- Land C3 before/with PR-S2 — without snapshots, package SHAs lie.
- C4 (worker packages) is a **sibling** track, not a blocker.
- C5 / H1 / H2 / F do not gate S1.
- E3 journal strengthens resume later; S1 does not wait on it.

### Test plan

**Unit:** state machine; old-generation tool refusal; token 401; zod + caps;
cursor bootstrap; retro rejection; open questions always host-listed.

**Integration:** fake incumbent → succession → successor seed contains package;
ask during `PREPARING` answered only after `ACTIVE`; crash after
`PACKAGE_READY` recovers once; concurrent second call → `already_in_progress`.

**Live:** real provider + workers; force handoff; workers stay up; old MCP URL
fails; one live orch on panel/Remote.

Existing `tests/live/handover.live.test.ts` is **not** succession coverage.

---

## 10. Non-goals

- Nested / concurrent second root or Lead-as-successor
- Automatic host succession from guessed token usage
- Subagent context-succession tools
- Resetting EventQueue or cancelling open questions “to clean handoff”
- Treating succession as `record_retro` / end of run
- Peer-to-peer between old and new orch
- Autodelete of predecessor worktree
- Depth > 1 or auto-nesting “because context was full”

---

## 11. Relation to the harness handbook

Recorded as **C6 orchestrator succession** under Phase C (after C5) in
[`HANDBOOK-HARNESS.md`](./HANDBOOK-HARNESS.md), with explicit separation from
C4 and F; the handbook's missing-hooks table and track diagram carry it.
Implementation stays out of BigBoy A/B — this is a Workspace/MCP cutover, not a
second product surface.
