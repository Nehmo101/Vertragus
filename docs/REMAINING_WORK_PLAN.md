# Remaining Work Plan — Audit Follow-up (Architecture Refactors)

This plan tracks the **only** audit findings still open after the main remediation
branch (`claude/scan-everything-r66a2y`). Everything security-, performance-,
quality-, test-, and dependency-related is already done and merged. What remains
are **behavior-preserving structural refactors** — no active bug, maintainability
only. See `audit-report.md` for the full findings and what was fixed.

## Ground rules (apply to every part)

- **Behavior-preserving only.** No feature/signature/timing changes. Identical
  runtime behavior; only module structure changes.
- **Preserve every public export.** If you move a symbol to a new file, re-export
  it from the original module so all existing import paths keep working. Grep for
  importers first (`grep -rn "from '<module>'" src`).
- **One part per PR.** Branch off the latest `main`, do the part, open a PR to
  `main`, and merge only when CI is green.
- **Green gate.** Each part must pass `corepack pnpm run ci` (icons + lint +
  typecheck + test + mobile build + electron-vite build). At minimum:
  `pnpm run typecheck`, `npx vitest run` (full suite — currently **1297** tests),
  and `pnpm run lint`, all green.
- **Small commits.** Commit each safe extraction separately so a mid-work stop
  never leaves a broken tree.
- **Do NOT run `git checkout`/`reset`/`stash`** against files you don't own in a
  shared tree.

## Parts (do in order)

### Part 1 — A8: Provider descriptor
- **Scope:** `src/main/providers/` (+ `src/shared/providers.ts` if present).
- **Goal:** consolidate per-provider behavior that already lives under
  `src/main/providers/` (login labels, capacities, health checks, model handling)
  into a single descriptor table; have the sibling files read from it. Do **not**
  refactor provider `switch`es that live in Engine/AgentManager (out of scope).
- **Done when:** duplication within `providers/` is reduced to one descriptor,
  exports preserved, green gate passes.

### Part 2 — A2 remainder: AgentManager extraction
- **Scope:** `src/main/agents/` only. `AgentManager.ts` is ~1,741 lines
  (`ScrollbackBuffer` was already extracted to `scrollbackBuffer.ts`).
- **Goal:** extract the Cursor workspace-trust dispatch/monitor/retry logic, the
  resume-state sweep, and preflight bookkeeping into their own modules; the class
  delegates to them. Preserve the `agentManager` singleton and all exports/import
  paths (tests import `{ AgentManager, ScrollbackBuffer }` from
  `@main/agents/AgentManager`).
- **Done when:** `AgentManager.ts` is materially smaller, green gate passes.

### Part 3 — A3: Store slices
- **Scope:** `src/renderer/src/store/` only. `useAppStore.ts` is ~1,303 lines.
- **Goal:** move module-scope selector/helper functions to `selectors.ts` and the
  `AppState` interface to `types.ts` (re-exported); split the `create()` closure
  into per-domain slice creators (`createAgentsSlice`, `createProfilesSlice`,
  `createOrchestratorSlice`, `createUiSlice`, …) composed in the final `create()`.
  Identical state shape, action names, signatures, and initial values.
- **Verify with:** `pnpm run typecheck:web` + `npx vitest run src/renderer` (plus
  the full gate before merge). Preserve every export from `@renderer/store/useAppStore`.
- **Done when:** store is sliced, public API identical, green gate passes.

### Part 4 — A1: Engine split
- **Scope:** `src/main/orchestrator/` only. `Engine.ts` is ~3,998 lines (largest).
- **Goal:** extract cohesive concerns into modules (snapshot construction/redaction,
  persistence-throttle + push-coalescing, benchmark bookkeeping, subagent-support
  maps, activity/reliability helpers, large pure functions/tables). Keep the
  `OrchestratorEngine` class public methods and all exports identical.
- **Done when:** `Engine.ts` is materially smaller, green gate passes. Consider
  doing this as several small PRs if one is too large to review.

### Part 5 — A6 + A7: Broadcast fanout & config change-notification
- **Scope:** `src/main/ipc/register.ts`, `src/main/windows.ts`, and the renderer
  config store as needed.
- **A6:** revisit the per-window PTY-chunk / snapshot broadcast fanout — introduce
  a single subscription surface instead of re-serializing to every window
  independently (the L2/M1 debouncing already reduced frequency; this is the
  structural piece).
- **A7:** config state is mirrored per-window with no change notification, so
  multi-window views can go stale — add a change-notification broadcast so all
  windows stay in sync.
- **Done when:** multi-window config stays consistent, broadcast fanout is
  centralized, green gate passes.

### Part 6 — M5: Standardize IPC validation
- **Scope:** `src/main/ipc/register.ts` (+ `src/shared/ipcValidation.ts`).
- **Goal:** migrate the "trust-the-compile-time-type" handlers onto the
  authorize-sender + zod-parse-`unknown` controller pattern already used by
  profile/workspace/ideas handlers; extend `ipcValidation.ts` (or a handler
  wrapper) to apply it uniformly. Sender-auth (H2) and missing-profile (L10) are
  already fixed — this is the remaining validation-style consistency.
- **Done when:** one validation convention across handlers, green gate passes.

### Part 7 — L5: Relocate orchestratorTraining (cleanup)
- **Scope:** `src/shared/orchestratorTraining.ts` + its two importers
  (`src/main/orchestrator/orchestratorTraining.test.ts`,
  `src/shared/planEstimate.test.ts`).
- **Goal:** move the test-validated training catalog out of `src/shared` into a
  fixtures/docs location so it no longer looks like shipped production code; update
  the two import paths. (Low value — the "dead" claim was mostly refuted since a
  test uses `trainingScenarioById`; this is purely placement cleanup.)
- **Done when:** catalog relocated, imports updated, green gate passes.

## Driver workflow (self-perpetuating prompts)

Each part is executed by a prompt that: reads this plan, does the named part per
its spec and the ground rules, runs the green gate, opens a PR to `main`, merges
on green, and then **prints a ready-to-paste follow-up prompt for the next part**.
The starting prompt is Part 1; each completion hands off to the next until Part 7,
after which the plan is complete and the manual packaged-app smoke test is the only
remaining step.
