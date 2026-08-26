English | [Deutsch](PLAN-INTAKE-ARCHIVE.de.md)

# Intake, Scout, and the run archive

Stand: 26 August 2026. Tracks I1–T2 are implemented in this change.

Specifies three product edges that still sit on top of the existing
loop: **intake before the team starts**, a **Scout** role for
code-backed recon, and a **timeline of archived runs** the square Stop
button currently throws away as UI. Copy-paste-ready implementation
prompt: [`PROMPT-INTAKE-ARCHIVE.md`](PROMPT-INTAKE-ARCHIVE.md).

Doctrine stays [`HANDBOOK-HARNESS.md`](HANDBOOK-HARNESS.md): one host
path, no second product, no autodelete, no peer-to-peer, no RAG, no
cloud runner, no DAG engine. Neighbouring ADEs are mapped in
[`RESEARCH-LANDSCAPE.md`](RESEARCH-LANDSCAPE.md). This plan is a
separate track from [`PLAN-LANDSCAPE.md`](PLAN-LANDSCAPE.md) (review,
sandbox, presets) and from C7
([`MODEL-PROVIDER-SWITCH.md`](MODEL-PROVIDER-SWITCH.md)).

Sizes are **S / M / L** (files and risk), not calendar time.

Sources for the visual and factory ideas:

- Operator screenshots of an ADW dashboard (run-card grid with
  per-agent Gantt) and of a session waterfall (request / plan / build
  blocks plus an event inspector).
- IndyDevDan, *My Super Simple Software Factory (For Agentic
  Engineers)* ([YouTube](https://www.youtube.com/watch?v=haUfb1ievTE)).
- [`disler/super-simple-software-factory`](https://github.com/disler/super-simple-software-factory)
  (skill + templates; visualizer on the `example` branch).

---

## Status

| Piece | Status |
| --- | --- |
| Intake loop (ask until AC + DoD, or skip) | **implemented** — prompt + `ask_user` copy; no new MCP tool |
| Scout builtin role | **implemented** — eighth shipped role, slot opt-in |
| Archive of stopped runs | **implemented** — journals already persist; profile fold-out + card button |
| Timeline view | **implemented** — projection over `events.jsonl`, not a second DB |
| SSSF Python ADW graphs | **refuse** — handbook non-goal (second orchestration) |
| Token / dollar meters as host truth | **refuse** — wall clock is the budget; vendor-admitted usage only |

---

## Doctrine

New power is a **host tool, event, IPC verb, or panel surface** in the
existing loop. Intake is a **prompt discipline** on the orchestrator
that already has `ask_user` and the task board. The timeline is a
**read of the journal the host already writes**. Scout is a **role
template plus a slot**, not a pre-started crew and not a second
control plane.

- Host truth over agent prose. Diffs and "what changed" come from git
  against the agent's worktree. Duration comes from event `ts`. A
  pull request comes from the `pull_request` event. Nested helpers
  come from `parentId` recorded on the event, not from a transcript.
- `ask_user` / `answer_question` stay the only path that parks the
  human. Do not type intake answers into a parked orchestrator TUI.
- Playbooks stay **goal templates**. The orchestrator still decides
  the team. A named SDLC chain in Python is the factory product this
  repo refuses.
- Workers still never commit. Promote stays a human click (or the
  existing Automation host merges).
- Fail-loud on contract errors, fail-soft on disk extras (same shape
  as `journal.ts` / `resume.ts`).
- Tests sit next to the subject. Coverage ratchet does not go down.
- User-facing strings: renderer i18next **en+de**,
  `src/shared/mainMessages.ts`, `src/remoteClient/i18n.ts` — always
  both locales. Docs: English canonical plus German twin.

---

## What already exists (do not rebuild)

| Need | Already in the code |
| --- | --- |
| Ask the human and block | `ask_user` + `PendingQuestions` + panel badge + phone (`answer_question`) |
| Seed a goal at Play | H2 `workspaces:start {goal}` / refill `workspaces:goal` |
| Durable plan outside the model | task board (`task_create` / `tasks.json`), survives succession and resume |
| Self-contained worker assignments | `start_agent` task contract: goal, files, definition of done, how to verify |
| Handoff between agents | C4 `baseBranch` + handoff block from `agent_done` |
| Structured reports | G3 `start_agent{resultSchema}` |
| Code mapping role | **Explorer** — mid-run map, `CHANGE NOTHING` |
| Full event history | `.vertragus/runs/<workspaceId>/events.jsonl` + `meta.json` + `tasks.json` |
| Subtree events in that journal | `WorkspaceManager.onLeadCreated` taps lead **and** worker-nest queues |
| Stop keeps artefacts | `stopWorkspace` closes processes; it does **not** delete the run dir |
| Newest-run briefing | E3 Resume — new orchestrator, old processes are gone |
| Learnings list | Retro fold-out under the profile (capped, not a timeline) |
| Open the run folder | `workspaces:openRunFolder` / `revealRunFolder` |
| Search old journals | root-only `search_runs` |
| Live nesting in the card | `parentId` on `WorkspaceSummary.agents` via `mcp.agentParent` |
| PR for the run | `pull_request` event + card line (Automation `autoPr`) |
| Wall-clock budget | `maxRuntimeMin` / `budget_warning` |

The hole is not "we have no history". The hole is **the panel forgets
the card**, **events do not carry `parentId`**, **the orchestrator is
told not to clarify a thin goal**, and **there is no Scout for
intake**.

---

## Screenshot reading

### The archive grid

Six dark run cards. Each shows a short id, a workflow name
(`adw_simple_sdlc`, `adw_build_test`, …), the task sentence, a
Gantt of agent lanes against wall time, a green success pill, a
timestamp, then footer metrics (money, duration, a large token
count). One card says `+2 more agents` when the roster overflows
the lane list.

What the card is actually saying: **which roles worked, in which
order, for how long, and whether the run was accepted.**

### The session timeline

Title *Super Simple Software Factory*. Session `ad066baa`, phase
`request`, live dot. Summary bar: the ask, success, started-at,
duration, cost, token split. Left rail: the engineer, then Planner
and Builder with model and a context-fill bar. Centre: horizontal
time with three **phase blocks** (Request, Plan, Build) and arrows
between them. Bottom: an inspector for the selected phase — events
(`phase_start`, `log`, `phase_end`) plus owner metadata.

What the detail view is actually saying: **one run, three kinds of
work (human / agent / code), click a block, read the events.**

### What Vertragus takes

- A **grid of past runs** that survives Stop, opened from the
  profile (the square already ended the live card).
- The same view **startable from a running workspace card**.
- **Agent swimlanes** against `ts`, not against a vendor TUI.
- **Nested overflow** (`+N more`) for helpers under workers under
  leads.
- An **inspector**: select a lane or a span, show the strong
  summary, host facts, and the events that belong to it.
- Derived **chapters** (intake, implement, review, integrate, PR)
  from events and the task board — labels for humans, not a new
  phase machine.

### What Vertragus refuses

- Dollar cost and million-token totals as **host truth**. The
  budget is wall clock (`maxRuntimeMin`). Landscape track T1 is
  explicit: never invent token counts; show vendor-admitted usage
  only. Duration is `lastEvent.ts - meta.startedAt`.
- A **factory DAG** (named ADW scripts that spawn a fixed
  planner-then-builder graph). Playbooks fill the goal field; the
  orchestrator still picks the team.
- `phase_start` / `phase_end` as a second event vocabulary. The
  journal already has `user_question`, `agent_started`,
  `agent_done`, `integrate_ok`, `pull_request`.
- A second SQLite visualizer app (Vue + Bun on port 4600). One
  projection over `events.jsonl`, rendered in the Electron panel.

---

## Super Simple Software Factory

### Sources

The video and the GitHub skill are the same product. The screenshots
are that product's UI. The README states the thesis in one line:
**code owns sequencing, retries, and acceptance; agents own only the
work inside one bounded phase.** "Agent proposes, code disposes."

v1 runs the Pi coding agent, stamps `adws/` into the target repo,
streams every event into `adws/adw_data/sssf.db` (WAL SQLite), and
ships five roster names: `planner`, `builder`, `scout`, `reviewer`,
`documenter`. There is no tester agent — `bun test` is a `kind=code`
phase. The visualizer is a read-only poll of that db (live and
history are the same `rowid > ?` query).

The skill's orchestrator (`SKILL.md`) is ordered to **list the ADWs
and wait**. It must not volunteer a status board, must not survey
the repo, and must not do ADW work itself. A separate cookbook,
`how_to_prompt_for_the_eng.md`, is read **before every launch**:
turn the engineer's sentence into a four-line prompt (ask / where /
done means / out of scope). Quote their specifics. Do not write the
plan. Do not pad. Show them the prompt that actually went out.

### What SSSF actually is

| SSSF part | What it does |
| --- | --- |
| ADW script | Thin Python: `run.phase(...)` then `ph.call(...)`; 12 starter chains |
| Roster YAML | One agent, one purpose, one model, `writes:` boundary, optional harness |
| Envelope | Typed JSON (`status`, `summary`, `notes_for_next_agent`, artefacts) |
| Gates | Code after the call: files exist, tests pass, diff matches claims |
| Correction | Re-prompt the **same** Pi session; never a cold restart |
| Scout | Read-only recon; cites paths; may spawn read-only helpers; writes `scout_findings.md` + `ScoutOutput` |
| Trace | `parent_id` nests spans; tool calls folded to one row; sessions table |
| Engineer lane | The incoming ask is a first-class phase, not a log line |
| Permissions | After every call, unauthorized git writes are rolled back |

Honest gaps SSSF names itself: it runs on the **current branch**,
there is **no sandbox**, **no merge step**, **no human-in-the-loop
approval phase**, and `claude_code` is stubbed. Those four are
exactly what Vertragus already has (worktrees, promote, `ask_user`,
many CLIs).

### Ideas worth taking

Map each idea onto a host path we already own, or a small prompt
change — not onto a Python graph.

| SSSF idea | Vertragus taking |
| --- | --- |
| **Intake as a first phase** (engineer lane, then maybe scout, then the team) | Orchestrator loop step 0: close AC + DoD before `start_agent` (except Scout) |
| **Four-line brief** (ask / where / done means / out of scope) | Reformulated assignment the orchestrator writes onto the task board and into every `start_agent` task |
| **"Intent is theirs, precision is yours"** | Clarify and order; never silently drop a constraint; never upgrade the idea |
| **Show the prompt that went out** | After intake, the user sees the brief (panel task list / timeline header) — host truth, not a chat claim |
| **Scout before questions about the code** | Builtin Scout role; only if the profile has a scout slot |
| **One agent, one purpose** | Already the role templates; Scout must not become a second Explorer |
| **Typed envelope + correction in-session** | Already G3 `resultSchema` and `ask_orchestrator` / follow-up `send_to_agent` |
| **Handoff notes for the next agent** | Already C4 handoff block; Scout `result` should carry `findings[]` |
| **Code owns known commands** | Keep Tester/Janitor as roles; do **not** have the orchestrator run `pnpm test`. Optional later: host quality gate (landscape W2), not this track |
| **Gates verify claims after the fact** | Already `inspect_agent` + host facts on `agent_done`. Intake DoD **names** the commands a tester should run |
| **Same query for live and history** | Timeline projection reads the journal while the run is live and after Stop |
| **`parent_id` on spans** | Put `parentId` on `agent_started` (and keep it on the live summary) |
| **Phase description is one sentence of intent** | Swimlane / chapter label from the task subject or the role prompt, never `"plan: Plan"` |
| **Do not volunteer a dashboard at startup** | Orchestrator with no goal still waits; with a thin goal it asks, it does not start coding |
| **Subagents of the scout** | Already allowed: workers may spawn one helper level. Scout is a worker. Helpers stay read-only because Scout's role forbids writes |

### Ideas to refuse

| SSSF idea | Why it is out |
| --- | --- |
| Python ADW owns the graph | Handbook: no second orchestration as a product (kanban, DAG, cloud runner) |
| Twelve stamped workflow files in the user's repo | Playbooks are goal text; slots stay a blueprint |
| SQLite `sssf.db` + Bun visualizer as the trace | We already journal JSONL; a second ingest path is two truths |
| Token and dollar totals as the card footer | Host cannot see billed tokens honestly; wall clock is the gate |
| "Ask at most one question; otherwise assume" | The user of *this* product asked the opposite: if anything is missing, **always** ask, Scrum-shaped, until AC + DoD are closed. Assumptions that would flip the code are `ask_user`, not silent defaults |
| Orchestrator must never read the application | Vertragus already lets the root Read HEAD. Scout is for **non-trivial** recon so the root does not drown. Tiny path checks stay a Read |
| Read-only enforced only by rollback after the fact | Keep prompt-level `CHANGE NOTHING` plus worktrees. A post-hoc `writes:` rollback on the user's checkout is a different product (SSSF has no worktree) |
| Resume = continue the same Pi `--session-id` | E3 Resume is honest: new process, briefing, old tickets void. Do not pretend the CLI comes back |
| Factory skill stamped into every repo | Vertragus is the host; `.vertragus/` is the run record, not a second framework inside the project |

The video's line that matters for us is not "build a software
factory". It is **agents plus code plus the engineer, at the right
moment**, with a trace you can read on the hundredth run. Vertragus
already put isolation, HITL, and multi-CLI on the host. This track
puts **intake**, **scout**, and **a readable archive** next to that.

### Scout in SSSF versus Explorer here

Explorer already ships. It maps unfamiliar territory **during** a
run. Scout in SSSF is **intake recon**: find where the ask lives,
cite paths, change nothing, optionally fan out read-only helpers,
return a structured finding list so the next phase does not guess.

We add Scout as a **distinct eighth builtin** because the user asked
for that name and because the job is different:

| | Explorer | Scout |
| --- | --- | --- |
| When | Mid-run, a worker or lead needs a map | Before the team starts, the orchestrator needs facts to close AC/DoD and to write assignments |
| Output | A map by question, with coordinates | Findings the brief can quote: paths, symbols, what is **not** there |
| Typical model | Cheap, fast | Same — mechanical recon, not architecture |
| Slot | Only if the profile has an `explorer` slot | Only if the profile has a `scout` slot ("when configured") |
| Helpers | One extra level, if the worker may nest | Same host rule; Scout's prompt holds them to read-only |

Do not delete Explorer. Do not auto-insert a Scout slot into existing
profiles (`createEmptyProfile` stays `slots: []`). The shipped
template plus `INITIAL_ROLE_PROMPTS.scout` exist so the editor can
add a slot. If Scout is not in `Available roles`, the orchestrator
must not invent the id.

Fallback when there is no Scout slot: the root may Read its own HEAD
for small facts; if an Explorer slot exists it may start Explorer
for a map; product and scope gaps still go to `ask_user`. Never start
a Worker to "just look around".

---

## Track I — User-request intake

### The gap

Today the orchestrator prompt says:

1. Break the goal into tasks and start the agents.
2. `ask_user` is **only** for scope changes, destructive actions,
   product choices.

The `ask_user` tool description repeats that restriction. A thin
goal therefore becomes a guessing team. That is the failure the
user named.

SSSF's engineer cookbook is the other extreme: at most one question,
otherwise assume. We take the **four-line brief** and refuse the
silence.

### The intake loop

New step 0, **before** any Worker / Reviewer / Tester / Docs /
Architect / Janitor / Lead:

1. Read the goal (and the repository briefing). List what is already
   specified.
2. If a Scout slot exists and the remaining gaps include "what does
   the code actually do / where does this live", start Scout on a
   cheap slot. Wait for `agent_done`. Quote its findings; do not
   paste the transcript.
3. Diff the goal + scout findings against the AC + DoD checklist
   below. Every hole is a question for the human, not an assumption.
4. If there are holes: **one** `ask_user` that batches them
   (numbered). Do not drip eight tickets. If the answer opens a new
   hole, one more round. Ticket-resume stays as today.
5. If there are no holes: **do not ask**. Write the brief anyway.
6. Put the brief on the task board (host truth). Then the existing
   loop: one task per `start_agent`, self-contained assignment.

Scout is the only agent that may start during intake. Leads and
workers wait.

A goal refill (`workspaces:goal`) is a first turn — run intake on
it. A later `user_message` is steering, not a second intake, unless
the user explicitly changes scope (then `ask_user` as today).

### Scrum questions

Questions aim at **acceptance criteria** and **Definition of Done**,
not at implementation taste.

**Acceptance criteria** (observable, Given/When/Then or a checklist):

- Who is it for, and on which surface (panel, phone, CLI, docs)?
- Happy path: what can a human **see or run** when it is true?
- Explicit non-goals / out of scope.
- Constraints already in this repo's doctrine (both locales, docs
  twins, tests next to the subject, no autodelete, …) — only ask
  when the goal would **override** them.
- Edge cases that would flip the design (empty input, Stop mid-run,
  resume, missing slot, …).

**Definition of Done** (host-checkable, not vibes):

- Which command must pass (name it; a Tester runs it, not the
  orchestrator)?
- Is a Reviewer required before integrate?
- Docs twins if docs are touched?
- PR expected, promote expected, or leave the branch?
- What `inspect_agent` must show (files, clean worktree, …)?

Do not ask the user what Scout (or a HEAD Read) can answer from the
code. Do not ask the user to pick a model. Do not ask whether to use
MCP tools.

### When the goal is already complete

If the prompt already names the ask, the where, the observable
result, the out-of-scope, and how it is verified — **skip
`ask_user`**. Still write the four-line brief onto the board so
subagents and the timeline see the same text. Still start Scout only
when a code fact is missing and a Scout slot exists.

Playbooks that paste a complete goal skip intake questions by
construction. That is the point of a good playbook.

### Reformulating work for subagents

The orchestrator is a translator, not a second product manager.

Four lines, SSSF-shaped, in the language of the goal:

```
<the ask — one imperative sentence; quote their specifics>
Where: <paths Scout or HEAD actually saw>
Done means: <observable result + the command that proves it>
Out of scope: <temptations named so nobody adds them>
```

Then each `start_agent` task is that brief **sliced**: this agent's
goal, files, AC for this slice, DoD / verify, out of scope. The
contract already demands that shape; intake makes it true instead of
hoped-for.

Do not write the worker's plan (how). Do not address the harness
("then call report_done", "use the reviewer") inside the task — the
contract and the orchestrator's own next `start_agent` own that.
Do not pad. After intake, the first user-visible artefact is the
brief on the board, not a diary of the loop.

### ask_user, not a second brain

No new MCP tool. Change:

- `buildOrchestratorSystemPrompt` loop (step 0).
- `ask_user` tool description: AC/DoD holes **are** user decisions;
  code facts are Scout/Read; guessing is forbidden.
- Orchestrator extra starter prompt: speak at the user's altitude;
  batch questions; after answers, show the brief.

v1 is one numbered blob in `question` (max 4_000). Structured
fields (`options[]`, per-item kinds) are a later PendingQuestions
change — only if the blob proves too messy. Do not add a second
question channel.

---

## Track S — Scout

### Why not only Explorer

See the comparison above. Explorer stays the mid-run mapper. Scout
is the intake specialist. Same isolation (`CHANGE NOTHING`),
different question.

### Slot is opt-in

`start_agent{role:"scout"}` works only when the profile lists a
scout slot (same as every other role). The orchestrator prompt
already prints `Available roles` from slots. If Scout is absent, the
intake loop uses HEAD Read / Explorer / `ask_user` as the fallback
and never names `scout`.

### Shipped role prompt

Add `SCOUT_ROLE_ID = 'scout'` to `BUILTIN_ROLE_TEMPLATES`. English,
100–200 words, no contract duplication (`report_done` lives in
`contract.ts`). Must say `CHANGE NOTHING`. Must: cite paths and
symbols; structure by the orchestrator's questions; name unknowns;
hold helpers to read-only; skip helpers when a couple of greps
suffice. Must not: plan the feature, edit, run the whole test
suite "to be sure", or dump a directory tour.

Recommend the orchestrator pass a `resultSchema` (G3) roughly:

```
findings: [{ file, symbol?, note }]
unknowns: [string]
summary: string
```

so the brief can quote coordinates. Schema is per-call, not a new
host type.

### Extra system prompt

`INITIAL_ROLE_PROMPTS.scout` is mandatory (the user named this).
Append-only overlay: audience = orchestrator, language of the task,
lead with the answer then coordinates, distill, no folder tour.
`appendUserRolePrompt` already refuses to replace the shipped text.
`createEmptyProfile` picks up new keys through
`initialRolePromptEntries` — update `profile.test.ts` expected ids.

### Colour pool

Seven builtins reserve `ROLE_COLOR_POOL[0..6]`; custom roles start
at `[7]`. An eighth builtin would steal pewter and push custom ids
onto Worker's verdigris. **Add a ninth muted tone**, assign it to
Scout, keep custom roles after the reserved block. Update
`roles.test.ts` (count, uniqueness, saturation check, "seven
documented roles" → eight, Explorer **and** Scout in the
`CHANGE NOTHING` list).

---

## Track A — Archive of stopped runs

### Stop already journals

`stopWorkspace` deletes the in-memory workspace, optionally opens
the run PR, finalizes retro, unregisters MCP. The directory
`.vertragus/runs/<id>/` stays. That is the archive. Do not copy it
elsewhere. Do not autodelete it. Worktree cleanup (broom) remains a
separate, explicit action.

### The panel forgets the card

The running-workspaces rail is a live set. After the square, the
card is gone. Retro shows a capped learning list (`MAX_RUN_RETROS =
50`) with a one-line tally — not when which agent worked, not the
PR URL, not helpers. Resume only briefs the **newest** journal.
`search_runs` is an orchestrator tool, not a human browser.

### Door: the profile row

User request: start from the **profile**. Add a history control
next to retro (chart) and cleanup (broom) — a fold-out, same
mount/error rules as `RetroPanel`.

Each row: workspace name, goal excerpt, startedAt, endedAt or
"running", end reason (user stop / retro / crash / unknown), status
pill derived from events (`record_retro` summary, last
`agent_done`, `orchestrator_exited`, Stop), PR url if the
`pull_request` event exists, duration. Click opens the **same
timeline** as the live card button.

A running workspace of that profile appears in the list too (its
journal is already on disk). Two doors, one projection.

Optional later (not v1): "Resume this run" for a row that is not
the newest. E3 today is newest-only on purpose.

### Run meta on stop

`meta.json` today: `workspaceId`, `profileId`, `workspaceName`,
`goal?`, `startedAt`, `resumedFrom?`. Add, fail-soft, on Stop and
on a clean retro finish:

- `endedAt`
- `endReason`: `user_stop` | `retro` | `crash` | `unknown`
- `pullRequestUrl?` (copy from the event, do not re-open)

Old metas without these fields stay valid (`z` optional). Derive
`endedAt` from the last event mtime when absent.

Do not rewrite history. Append-only journal stays the source of
spans.

---

## Track T — Timeline

### One projection, two doors

Pure function: `events.jsonl` + `meta.json` + `tasks.json` → a
view model (lanes, spans, chapters, inspector payloads). Used by:

- a button on `WorkspaceCard` (running or greyed `orchestrator_exited`)
- the archive fold-out under the profile
- tests with fixture journals (no Electron)

Live path: read the journal (append-only, same file). Do not push
the EventQueue ring to the renderer. Do not add a gateway verb in
v1 (phone does not need to *do* anything the summary cannot show).
`workspaces:openRunFolder` stays the escape hatch to raw files.

### Lanes and nesting

Y-axis: orchestrator, then leads, then workers, then helpers,
`orderByParent`-style. Colour = `roleColor`. X-axis: `ts` from
`agent_started` to `agent_done` / `agent_exited` / `agent_stopped`.
Overlapping bars are concurrent slots — that is the point.

`+N more` when lanes exceed a cap (six is enough for a card; the
detail view lists all).

Without `parentId` on journaled `agent_started`, helpers flatten to
the root and the user's "subagents of subagents" request is a lie.
That is why A1 lands before T2.

### Event inspector

Select a span or a chapter. Bottom panel (screenshot 2):

- identity (name, role, model if present, parent name)
- strong summary (`agent_done.summary`, distilled; host facts:
  branch, `diffStat`, `changedFiles`)
- nested children and **their** summaries
- events in range: questions, progress, integrate, PR, user
  messages, succession
- task board rows claimed by this agent

Chapters are derived, not stored: intake (`user_question` cluster
before the first worker `agent_started`), implement, review/test,
integrate, PR. Labels are i18n. Missing chapter = that kind of
event never happened (honest empty, not a failed gate).

### Summaries

Quality is mostly prompt-level (role extras already say distill).
The timeline must prefer:

1. `agent_done.summary` + `result` (if Scout/G3)
2. host facts on the same event
3. task `lastReport`
4. a one-line fallback from role + `changedFiles` if summary is
   empty — never invent a success

Orchestrator `record_retro.summary` is the run verdict at the top
of the detail view. User-stop without retro: "Stopped by the user"
plus the last brief on the board.

### Metrics

On the card and the header: **status**, **startedAt**, **duration**,
**agent count**, **PR** (link or "none"). Optional: wall-clock
budget used (`budget_warning`). Not in v1: dollars, input/output
tokens, context-fill percent (those are vendor TUI / Pi JSONL;
landscape T1 may later show vendor-admitted usage as such).

---

## Journal gaps to close first

| Gap | Effect on the timeline | Track |
| --- | --- | --- |
| No `parentId` on `agent_started` | Helpers and lead workers cannot nest after Stop | A1 |
| No `endedAt` / `endReason` on meta | Archive rows guess from mtime | A1 |
| No task text on `agent_started` | Lane label is only the role name | A1 optional: `taskSubject?` capped |
| Helper events are journaled but easy to miss in tests | Projection under-counts nests | T1 fixtures must include a nest tap |
| `ask_user` answers are not events (only `user_question`) | Inspector shows the question, not the answer | T1: read `PendingQuestions` only while live; archive cannot recover old answers unless we later persist them — **do not** log the answer as a second brain. Optional quiet `user_answer` event is a follow-up, not v1 |

A1 is the only `events.ts` mutation in this program. Own it in one
PR. Old journals parse without the new fields.

---

## Waves

Hot files: `Workspace.ts`, `spawn.ts`, `events.ts`, `profile.ts`.
At most one open PR mutates each.

```
Wave 1 — no Workspace.ts, no events.ts
  I1  intake prompt + ask_user description
  S1  Scout role + extra prompt + colour
        │
        ▼
Wave 2 — events.ts + journal meta (one PR)
  A1  parentId on agent_started, endedAt/endReason on meta
  A2  listRuns / readRunProjection leaf modules (can start in W1
      against today's events, then grow parentId)
        │
        ▼
Wave 3 — panel
  T1  projection + tests on fixture journals
  T2  WorkspaceCard button + ProfileRow archive fold-out
```

I1 and S1 do not block A2's first cut. T2 must not land before A1
if we advertise nesting on archived runs.

Remote: no new gateway verb in these waves. If the phone later needs
to **open** a timeline, that is a read-only eighth-or-ninth verb
with a capped payload — a follow-up, same debate as landscape R3.

---

## File ownership

| Track | Primary | May touch | Must not |
| --- | --- | --- | --- |
| I1 | `prompts/orchestrator.ts`, `orchestrator.test.ts` | `toolsOrchestrator.ts` (`ask_user` description only), `rolePrompt.ts` orchestrator extra, `contract.ts` only if a reminder line is truly required | `events.ts`, `Workspace.ts`, `profile.ts` |
| S1 | `prompts/roles.ts`, `rolePrompt.ts`, their tests | `profile.test.ts` expected `rolePrompts` ids, profile editor i18n if a hint names Scout | `Workspace.ts`, `events.ts`, `spawn.ts` |
| A1 | `schema/events.ts`, `toolsOrchestrator.ts` (stamp `parentId` where `agent_started` is pushed), `journal.ts` meta | `WorkspaceManager.stopWorkspace` (write `endedAt`) | `spawn.ts`, renderer |
| A2 | new `workspace/listRuns.ts` (next to `resume.ts` / `searchRuns.ts`) | `appIpc.ts` + `preload/index.ts` together | `events.ts` |
| T1 | new `shared/runTimeline.ts` (pure) | fixtures under the test file | Electron, Vue, SQLite |
| T2 | `panel/ArchivePanel.tsx`, `panel/RunTimeline.tsx`, `panel.css`, i18n `archive.*` / `timeline.*` | `ProfileRow.tsx`, `WorkspaceCard.tsx`, `usePanelData.ts` | `events.ts`, `spawn.ts` |

i18n: new keys under `panel.archive*` and `panel.timeline*` (or a
`archive` namespace) so landscape PRs do not collide. Both locales
in the same PR. IPC: `runs:list` / `runs:get` panel-only; add to
`APP_CHANNELS` and preload in the same PR (`ipc` parity test).

---

## Non-goals

- A Python/JSON DAG of phases the host executes
- Stamping `adws/` or a skill into the user's repository
- A second trace database or a Bun visualizer
- Autodelete of run dirs, worktrees, or branches
- Peer-to-peer between scouts, helpers, or leads
- Grandchild events in the root `await_events` queue (journal tap
  stays; fan-in stays)
- Token or dollar oracles
- Changing E3 Resume into "respawn the old CLIs"
- `stop_agent` / `focus_agent` on the remote allow-list
- Host-run test suites inside the orchestrator process
- Replacing Explorer, Janitor, or the task board
- Structured `ask_user` forms (v2 if needed)
- Phone timeline (v2)

---

## Code anchors

| Topic | Where |
| --- | --- |
| Orchestrator loop and `ask_user` line | `src/shared/prompts/orchestrator.ts` |
| `ask_user` tool description | `src/main/mcp/toolsOrchestrator.ts` |
| Role templates + colours | `src/shared/prompts/roles.ts` |
| Extra system prompts | `src/shared/prompts/rolePrompt.ts` |
| Task contract / handoff | `src/shared/prompts/contract.ts` |
| Events | `src/shared/schema/events.ts` |
| Journal + meta | `src/main/workspace/journal.ts` |
| Resume / read events | `src/main/workspace/resume.ts` |
| Search journals | `src/main/workspace/searchRuns.ts` |
| Stop + journal tap including nests | `src/main/workspace/WorkspaceManager.ts` |
| parentId live | `src/main/mcp/types.ts` `parentOf`, `src/main/index.ts` summary |
| Order nested rows | `src/main/workspace/orderByParent.ts` |
| Profile slots / empty profile | `src/shared/schema/profile.ts` |
| Panel card / profile row | `src/renderer/src/panel/WorkspaceCard.tsx`, `ProfileRow.tsx`, `RetroPanel.tsx` |
| PR on the card | `WorkspaceSummary.pullRequest` |
| Result schema | `src/shared/schema/resultSchema.ts` |

---

## Related docs

- [`HANDBOOK-HARNESS.md`](HANDBOOK-HARNESS.md) — non-goals, loop, nesting
- [`PROMPT-INTAKE-ARCHIVE.md`](PROMPT-INTAKE-ARCHIVE.md) — implementation prompt
- [`PROMPT-MCP-HARNESS.md`](PROMPT-MCP-HARNESS.md) — earlier tracks (do not rebuild)
- [`PLAN-LANDSCAPE.md`](PLAN-LANDSCAPE.md) — review, sandbox, T1 process snapshot
- [`RESEARCH-LANDSCAPE.md`](RESEARCH-LANDSCAPE.md) — neighbouring ADEs
- SSSF: [repo](https://github.com/disler/super-simple-software-factory),
  [video](https://www.youtube.com/watch?v=haUfb1ievTE)
