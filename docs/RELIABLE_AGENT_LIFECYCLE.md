# Reliable Agent Lifecycle

Vertragus treats long-running workers as asynchronous jobs. MCP calls no
longer need to stay open until an agent finishes:

1. `dispatch_subagent` returns a `taskId` immediately.
2. `dispatch_batch` returns all accepted task IDs immediately.
3. `execute_plan` returns a `runId` immediately.
4. `get_task_status`, `list_tasks`, and `get_plan_status` expose phase,
   heartbeat, progress, terminal state, and result.

Workers emit a heartbeat every 30–60 seconds (45 seconds by default). Lifecycle
timers are cleaned up on success, error, cancellation, and provider rejection.

## Worker contract

A successful implementation task is accepted only when Vertragus can verify one of
these outcomes in the isolated worktree:

- a full, unambiguous Git commit hash; or
- an explicit, verified `no-changes` result.

Before the commit, Vertragus runs the configured quality commands, `git diff
--check`, a staged-diff size/secret scan, and the security gate. Files generated
or formatted by a gate are staged and checked again before the commit.

## Shared-file ownership

Planner tasks declare `ownership` and `expectedFiles`. Shared schemas, main IPC,
preload, the profile model, and global renderer styles may be owned by exactly
one final `integrator` task. That task must depend on every feature task and
receives their terminal results, commit hashes, and integration notes. Feature
tasks remain modular and isolated.

## Integration and acceptance

For aggregate Auto-PR, Vertragus creates a visible system-owned `Integration &
Abnahme` task. It verifies every worker commit, cherry-picks the commits into a
dedicated integration worktree, scans the aggregate diff, reruns all configured
quality gates, and only then publishes the PR. Conflicts and red gates remain
blocked for inspection; Vertragus does not force-push or guess a conflict resolution.

After publication, Vertragus waits up to 90 seconds for GitHub checks to appear and
follows them with a bounded 20-minute `gh pr checks --watch` run. PR publication
and remote-CI are separate states, so failed, cancelled, timed-out, or unavailable
checks remain visible without pretending that the PR itself was not created.

New profiles default to this acceptance sequence:

1. `corepack pnpm typecheck`
2. `corepack pnpm test`
3. `corepack pnpm lint`
4. mandatory diff and security gates

## Restart recovery

Closing or crashing the app no longer loses session progress. The orchestrator
snapshot (goal, task DAG, findings, budget, dispatch prompts) is written to a
per-session file under `userData/sessions/` — throttled during the run, flushed
synchronously in the ordered `before-quit` sequence, bounded by a hard
deadline. A clean-shutdown marker distinguishes crashes from normal exits.

On the next start the session registry rehydrates every persisted session under
its original id, so the restored DAG and goal appear in the existing UI without
starting any agent process. Tasks that were running are marked *interrupted*;
a single action re-dispatches them with their original prompt into their
preserved worktree (the same recovery-worktree path used for failure retries),
so partial files are never lost. Terminal scrollback tails and agent metadata
are additionally persisted as redacted resume states — periodically while
agents run and once more at shutdown.

## Capacity model

The UI separates four values that previously looked interchangeable:

- prewarmed interactive team agents;
- maximum task parallelism from the planner;
- active and waiting provider processes;
- provider hard limits.

With adaptive team startup, profile slots are a capability pool rather than an
eager process list. Only the orchestrator is prestarted; validated plan nodes
activate the selected roles. Follow-up plans may add roles later, while
unselected workers remain off.

Task cards show phase, last action, progress, and heartbeat age. A running task
without a fresh heartbeat for 90 seconds is marked stale.
