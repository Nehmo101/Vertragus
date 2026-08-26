English | [Deutsch](PROMPT-INTAKE-ARCHIVE.de.md)

# Prompt: Intake, Scout, and the run archive

> Copy-paste-ready agent prompt. Primary source for ordering and
> non-goals: [`PLAN-INTAKE-ARCHIVE.md`](./PLAN-INTAKE-ARCHIVE.md) and
> [`HANDBOOK-HARNESS.md`](./HANDBOOK-HARNESS.md). Do **not** rebuild
> A1–A3 / Remote / C1–C6 / D / E / F / G / H — those are in place.
> Do **not** stamp a Python ADW graph or a second trace database.

---

## Role

You work in the repo **Vertragus** (Electron panel + in-app MCP server).
Implement the intake / Scout / archive-timeline program in **tracks**
(not everything in one PR). Each track: its own branch, green tests, a
PR that references `docs/PLAN-INTAKE-ARCHIVE.md` and
`docs/HANDBOOK-HARNESS.md`.

Language of tool descriptions, contracts, and orchestrator / role
prompts: **English** (imperative). Docs are English-canonical with
maintained German `.de.md` twins — whoever touches docs maintains both.
UI strings go through the i18n layers (de + en).

---

## Context — what already exists (do not rebuild)

| Area | Status |
| --- | --- |
| Human questions | `ask_user` + `PendingQuestions` + panel badge + `answer_question` |
| Goal at Play | `workspaces:start {goal}`, refill `workspaces:goal` |
| Plan outside the model | task board → `.vertragus/runs/<id>/tasks.json` |
| Worker assignment shape | `start_agent` task must already carry goal, files, DoD, verify |
| Handoff | C4 `baseBranch` + handoff block from `agent_done` |
| Structured reports | G3 `resultSchema` on `report_done` |
| Mid-run mapper | Explorer role (`CHANGE NOTHING`) |
| Run artefacts | `events.jsonl`, `meta.json`, `tasks.json`; Stop does not delete them |
| Nest events in the journal | `onLeadCreated` taps lead and worker-nest queues |
| Live nesting | `parentId` on `WorkspaceSummary.agents` |
| Newest-run briefing | E3 Resume (new process; old tickets void) |
| Learnings UI | Retro fold-out (not a timeline) |
| Extra system prompts | `INITIAL_ROLE_PROMPTS` + `appendUserRolePrompt` (never replace the host prompt) |

Code anchors: listed at the bottom of
[`PLAN-INTAKE-ARCHIVE.md`](./PLAN-INTAKE-ARCHIVE.md).

SSSF ([repo](https://github.com/disler/super-simple-software-factory),
[video](https://www.youtube.com/watch?v=haUfb1ievTE)) is a **source of
ideas**, not a port. Take: intake as step 0, four-line brief, Scout
before code questions, same projection for live and history, `parentId`
on spans. Refuse: Python DAG, stamped `adws/`, SQLite visualizer, token
oracles, "ask at most once then assume".

---

## Hard non-goals (never)

- Peer-to-peer between subagents or leads
- A pre-started team / playbooks that spawn windows
- An orchestrator that commits, merges, tests, or pushes itself
- Autodelete of worktrees, branches, or run directories
- A second orchestration product (kanban, DAG engine, cloud runner,
  Python ADW scripts in the user's repo)
- Grandchild events in the root `await_events` queue
- A second MCP server or a second trace database
- Invented token / dollar totals
- Changing Resume into "respawn the old CLIs"
- Replacing Explorer
- `stop_agent` / `focus_agent` on the remote gateway
- New gateway verbs in these tracks (panel IPC only)

---

## Track ordering

```
I1  Intake loop (prompt + ask_user description)     Wave 1
S1  Scout builtin role + extra prompt + colour      Wave 1 (parallel with I1)
A1  parentId on agent_started + meta endedAt        Wave 2 (owns events.ts)
A2  listRuns / readRunProjection leaf               Wave 1 or 2
T1  Pure timeline projection + tests                Wave 3 after A1 for nesting
T2  Panel: card button + profile archive fold-out   Wave 3
```

Hot files: at most one open PR mutates `Workspace.ts`, `spawn.ts`,
`events.ts`, `profile.ts`. I1 must not edit `events.ts`. S1 must not
edit `Workspace.ts`. A1 is the one `events.ts` PR.

---

## TRACK I1 — Intake loop (prompt + ask_user)

### Goal

When the user names a goal and anything needed for a perfect worker
assignment is missing, the orchestrator **always asks** — Scrum
acceptance criteria and Definition of Done. When the goal already
contains that, it **does not ask**. Either way it **reformulates** a
four-line brief onto the task board and into every `start_agent` task.

### Do

1. In `buildOrchestratorSystemPrompt`, insert **step 0** before "Break
   the goal into tasks…":
   - Extract what the goal already specifies.
   - If a `scout` role is in Available roles and code facts are
     missing, `start_agent{role:scout,…}` on a cheap slot, wait,
     quote findings (do not paste transcripts). No other roles during
     intake.
   - Gap-check against AC (observable happy path, non-goals, flip
     cases) and DoD (named verify command, review?, docs twins?,
     PR/promote/leave-branch, what `inspect_agent` must show).
   - Holes → **one** numbered `ask_user`. Do not drip. Another round
     only if the answer opens a new hole.
   - No holes → do not call `ask_user`.
   - Write the brief on the task board, then the existing loop.
2. Four-line brief (language of the goal; quote their specifics):

   ```
   <the ask>
   Where: <paths actually seen>
   Done means: <observable result + proving command>
   Out of scope: <named temptations>
   ```

   Each `start_agent` task is that brief sliced for one agent. Do not
   write HOW. Do not address the harness inside the task.

3. Rewrite the `ask_user` **tool description**: AC/DoD holes are user
   decisions; code facts are Scout or a HEAD Read; guessing is
   forbidden; product-choice / destructive / scope-change stay valid.
4. Extend `INITIAL_ROLE_PROMPTS.orchestrator` with: batch questions at
   the user's altitude; after answers, the brief is what the user
   should see, not a loop diary.
5. Tests: snapshot / substring tests on the new loop text and on the
   `ask_user` description. Byte-stability of the **subagent contract**
   stays unless you have a real reason to touch it (you should not).

### Done when

- A thin goal in the prompt makes the orchestrator ask before any
  Worker.
- A complete goal (ask + where + done means + out of scope + verify)
  does not force `ask_user`.
- Scout is mentioned only as a role that might be in Available roles.
- No new MCP tool. No `events.ts` change.

### Prompt (short)

> Implement Track I1 from `docs/PLAN-INTAKE-ARCHIVE.md`: orchestrator
> step 0 (intake), four-line brief, `ask_user` description. Scout is
> opt-in via existing Available roles. No new tools, no DAG.

---

## TRACK S1 — Scout role

### Goal

Eighth builtin role `scout`: intake recon for the orchestrator. Slot
opt-in. Do not forget the default extra system prompt.

### Do

1. `SCOUT_ROLE_ID`, template in `BUILTIN_ROLE_TEMPLATES` (English,
   100–200 words, `CHANGE NOTHING`, cite paths, structure by question,
   name unknowns, helpers read-only, skip helpers when greps suffice,
   no contract duplication).
2. `INITIAL_ROLE_PROMPTS.scout`: reader = orchestrator, language of
   the task, answer then coordinates, distill, no folder tour.
3. Ninth muted colour in `ROLE_COLOR_POOL`; Scout takes the new reserved
   slot; custom roles still start after the reserved block.
4. `roles.test.ts`: eight builtins, Scout in `CHANGE NOTHING` with
   reviewer/architect/explorer, colour uniqueness, pool length.
5. `profile.test.ts`: `createEmptyProfile` `rolePrompts` ids include
   `scout`. Do **not** auto-add a scout slot (`slots` stays `[]`).
6. Optional i18n hint in the profile editor that Scout is intake recon
   (both locales).

Recommend (in the orchestrator prompt, I1 or a one-line add here):
when starting Scout, pass a `resultSchema` with `findings[]`,
`unknowns[]`, `summary`.

### Done when

- `builtinRoleTemplate('scout')` exists; `start_agent{role:scout}`
  resolves like Explorer.
- New profiles get the extra prompt; old profiles without a scout
  slot cannot spawn one.
- `pnpm` tests for roles / rolePrompt / profile green.

### Prompt (short)

> Implement Track S1 from `docs/PLAN-INTAKE-ARCHIVE.md`: builtin Scout,
> `INITIAL_ROLE_PROMPTS.scout`, colour pool + tests. No slot auto-insert.
> Do not replace Explorer.

---

## TRACK A1 — parentId on events + run meta on stop

### Goal

Archived journals can rebuild the agent tree and say why a run ended.

### Do

1. Optional `parentId` (and optionally capped `taskSubject`) on
   `agent_started`. Stamp it where the event is pushed
   (`toolsOrchestrator.ts`), from `runtime.parentOf`. Old journals
   stay valid.
2. Optional `endedAt`, `endReason` (`user_stop` | `retro` | `crash` |
   `unknown`), `pullRequestUrl` on `runMetaSchema`. Write them in
   `stopWorkspace` / retro finish. Fail-soft.
3. Exhaustive event tests + journal/resume tests for missing new
   fields.
4. This PR owns `events.ts`. Do not sneak in `ci_status` or other
   kinds.

### Done when

- A helper's `agent_started` in the journal has `parentId` of its
  worker.
- A Stopped run's `meta.json` has `endedAt` and `endReason: user_stop`.
- Pre-A1 fixture lines still parse.

### Prompt (short)

> Implement Track A1 from `docs/PLAN-INTAKE-ARCHIVE.md`: `parentId` on
> `agent_started`, stop meta. One `events.ts` PR. Old journals valid.

---

## TRACK A2 — list archived runs (IPC)

### Goal

Leaf module + panel IPC to list a profile's runs from
`.vertragus/runs/`, including the live one. No UI yet (or a stub list
is fine if T2 is the same branch — prefer a separate PR).

### Do

1. `listRuns(repoPath, profileId)` next to `resume.ts` / `searchRuns.ts`:
   fail-soft, newest first, skip other profiles, include meta-less
   dirs if they have a journal.
2. `runs:list` / `runs:get` in `APP_CHANNELS` **and** preload; parity
   test. Panel-only. Capped payload (no full jsonl on list).
3. `runs:get` returns events + meta + tasks for one id (the timeline
   input). Size-cap or spill like `search_runs` (name a huge journal
   instead of swallowing it).

### Done when

- Unit tests with a fake fs of several run dirs.
- IPC rejected from a CLI window.

### Prompt (short)

> Implement Track A2 from `docs/PLAN-INTAKE-ARCHIVE.md`: `listRuns` +
> `runs:list`/`runs:get` IPC. Fail-soft. No remote verb. No renderer
> required in this PR.

---

## TRACK T1 — timeline projection

### Goal

Pure function journal → view model. Same function for live and
archive.

### Do

1. `src/shared/runTimeline.ts` (+ `.test.ts`). Input: `RunMeta`,
   `AgentEvent[]`, optional `TaskBoardState`. Output: lanes (ordered
   like `orderByParent`), spans (`startedAt`/`endedAt`/`status`/
   `summary`/`hostFacts`/`parentId`), derived chapters (intake /
   implement / review / integrate / pr), inspector records.
2. Fixtures: flat team; lead + workers; worker + helpers; Stop without
   retro; `pull_request` ok and fail; missing `parentId` (pre-A1)
   flattens honestly.
3. Metrics: duration from timestamps, agent count, PR url. **No**
   invented tokens or dollars.
4. Prefer `agent_done.summary` + host facts; never invent success.

### Done when

- Tests pin nesting, chapters, and the flatten-without-parentId case.
- No Electron imports.

### Prompt (short)

> Implement Track T1 from `docs/PLAN-INTAKE-ARCHIVE.md`: pure
> `runTimeline.ts` over the journal. Nesting via `parentId`. Host-truth
> metrics only.

---

## TRACK T2 — panel timeline + archive UI

### Goal

Two doors, one view: button on the workspace card; history fold-out
on the profile row (the door after the square Stop).

### Do

1. `ArchivePanel` under `ProfileRow` (same mount/error rules as
   `RetroPanel`). Rows from `runs:list`. Click → timeline.
2. Timeline on `WorkspaceCard` (running and `orchestrator_exited`).
   Uses `runs:get` on that `workspaceId` (journal is live).
3. Detail: swimlanes, `+N more`, inspector with nested summaries and
   PR. i18n `panel.archive*` / `panel.timeline*` **en+de**.
4. Empty states: no runs; journal unreadable; still running.
5. Do not embed a second windowing product. Fold-out + expanded card
   (or one panel window if the card is too tight — keep it in-panel).

### Done when

- Stop a workspace, open the profile history, see the run, open the
  timeline, see agents / helpers / PR if the journal has them.
- Open the same timeline from a live card while agents are working.
- i18n guard green. No remote changes.

### Prompt (short)

> Implement Track T2 from `docs/PLAN-INTAKE-ARCHIVE.md`: profile
> archive fold-out + workspace-card timeline, both via `runs:list` /
> `runs:get` and `runTimeline`. i18n both locales. No DAG, no token
> footer.

---

## After T2 (optional)

Only if a later assignment asks: quiet `user_answer` event; Resume
from a specific archive row; host quality commands as `kind=code`
(landscape W2); phone read-only `runs:get`; structured `ask_user`
fields. Not in the first six tracks.

---

## Definition of done

`corepack pnpm run ci` green. Coverage ratchet not lowered. Docs
twins in the same change if you touch a canonical doc. Each PR names
the track (I1 / S1 / A1 / A2 / T1 / T2) and the handbook non-goals
it refused.
