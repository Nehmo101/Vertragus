English | [Deutsch](RESEARCH-OBSIDIAN-AI-SECOND-BRAIN.de.md)

# Research: Obsidian, AI agents, and the second brain (Eero Alvar)

Stand: 25 August 2026. Primary sources: two YouTube videos by
[Eero Alvar](https://www.youtube.com/@EeroAlvar), watched via their
published captions. Purpose: extract the philosophy and the demo, then
map both onto Vertragus **as it is in the code today** — what already
matches, what collides with handbook non-goals, and what (if anything)
is worth taking without starting a second product.

This is not a product track. It does not add tools, roles, or MCP
surface. Companion landscape (Obsidian + agentic development):
[`RESEARCH-OBSIDIAN-AGENTIC.md`](./RESEARCH-OBSIDIAN-AGENTIC.md).
Companion historical research:
[`RESEARCH-DEEPSEEK-HARNESS.md`](./RESEARCH-DEEPSEEK-HARNESS.md).
Doctrine: [`HANDBOOK-HARNESS.md`](./HANDBOOK-HARNESS.md).

---

## Sources

| | Video | URL |
| --- | --- | --- |
| A | *Obsidian and AI were made for each other* | https://www.youtube.com/watch?v=hhtExS5UQBI |
| B | *Second brain setup for doing* | https://www.youtube.com/watch?v=Y1xO9OsCBC4 |

Alvar presents them as a pair. A is the **AI direction** of a symbiotic
loop (agents living inside the vault). B is the **second-brain
direction** (why the vault exists, and why most note systems solve the
wrong problem). Watch B first if you care about the model; watch A
first if you care about the Pi/Obsidian garage he actually runs.

Captions are auto-generated. A few ASR slips are called out in
[Caveats](#caveats). Quotes below are cleaned from those captions, not
a studio transcript.

---

## The pair in one thesis

Alvar's claim is not "organize more notes" and not "chat with your
files." It is:

1. The brain is a **processor with a small context window**. Tracking
   projects, holding ideas, and remembering where things live is
   cognitive state the processor should not spend on itself.
2. External storage only helps if it does **state management**:
   knowledge moves in, ideas move out, and the only reason both exist
   is **execution**.
3. Once that store is a folder of markdown, a coding agent can live
   *inside* it. The agent gathers its own context. The vault becomes
   the interface; ChatGPT-in-the-browser becomes redundant.
4. Specialization beats one generic bot: **an agent is a folder with
   markdown** (prompt, skills, scripts). Write-scope is part of the
   prompt, not a platform feature.
5. AI must not take the thinking. It removes friction so the human
   spends the remaining budget on judgment, synthesis, and taste.
6. The failure mode is aesthetic procrastination — graphs, taxonomies,
   "Wikipedia articles" that never become a thing in the world.

Vertragus is not a second brain. It is a harness that already does
several of the *same jobs* for **coding runs**: isolate work, capture
unresolved state on the host, verify against disk, and measure value
by what landed — not by how pretty the graph is.

---

## Video: Second brain setup for doing

### Cognitive state, not storage

Opening move: "cognitive optimization" as allocating the brain's
processing power. A second brain is usually sold as information
architecture. Alvar says that solves the wrong problem. Storage is
part of it; it does not by itself produce better thinking or more
done. The actual problem is **cognitive state management** — in
agent terms, engineering the brain's context window.

The tax he names: tracking projects, holding ideas, remembering
locations, maintaining context across everything you are doing. The
brain managing its own state is the same class of waste as an LLM
stuffing the prompt with bookkeeping the host should own.

### Knowledge in, ideas out

Most note systems treat all cognitive content as one stream: ingest,
file, retrieve. Alvar splits it into two types that **behave in
opposite directions** and must not be treated equally.

| | Knowledge | Ideas |
| --- | --- | --- |
| Direction | World → brain | Brain → world |
| Arrival | Chosen (books, papers, courses, code) | Sporadic, uninvited |
| Load | Integrates into mental models; does not clog working memory | Sits in working memory; competes with the current task |
| Role | Expands what you can think and execute | How you create value — cannot throw away, cannot hold |
| Notes are | Transfer artifacts for *installation*, not Wikipedia pages | Evacuation, not organization |

The group-theory example: understanding a subject does not consume
the same resource as *remembering to look at that note later*. An
unresolved idea is a background process. Every one of them levies a
cognitive tax.

### Three operations

The two transfer directions plus the reason they exist give three
operations between brain and external system:

1. **Build knowledge.** Download from the world. Notes tell you where
   you left off so the brain can reorient. Means, not ends.
2. **Capture ideas.** Push them out the moment they arrive. No
   sorting, no tags, no "which folder." Pure evacuation. Process
   later.
3. **Execute.** Take knowledge and ideas and produce something. This
   is why 1 and 2 exist. An elaborate hoard that never ships is a
   failed system.

### The temporal contract

Capture that the brain does not trust is worse than no capture: you
write the idea down **and** keep a background copy, so you pay twice.
Alvar borrows the **temporal contract** from the channel No
Boilerplate (he says he is unsure who coined the term). Two rules:

1. Every fleeting idea goes into **one** trusted location the moment
   it arrives. One place. Zero routing decisions. Zero friction.
2. You **will** revisit. Frequency and format are yours; the
   commitment is not optional. The brain only releases the idea if it
   believes the note will surface again.

That loop is the trust: present-you captures because future-you
revisits; future-you revisits because past-you captured everything
worth capturing. His analogy is a **git commit** — state is saved,
you move on.

### A folder is the system

Implementation is deliberately boring: a directory of text files. No
proprietary platform, no subscription. Obsidian is "a file manager
that's got some markdown editing capabilities." It is **not** the
second brain. The same architecture works with pen and paper; it
works without AI.

What he actually uses Obsidian *for* (features, not identity):

- **Links instead of folders.** Ideas are a graph, not a hierarchy.
  You do not pre-decide where a note belongs. Structure emerges from
  connections. That is the anti-friction twin of "one inbox."
- **Fleeting notes.** Dedicated space for the temporal contract.
  Capture now, process on revisit.
- **Community plugins** he names in passing: semantic similar-notes
  (embeddings), calendar, terminal, LaTeX snippets. The point he
  argues is moldability, not a shopping list.
- **Plain text.** Portable, future-proof, any editor, and **readable
  by AI** without an API.

### Vault layout

Top-level directories follow the three operations, with Greek folder
names as emphasis (ASR is messy here; the English labels are the
ones that matter):

| Folder | Operation |
| --- | --- |
| Domains | Build knowledge |
| Thoughts | Capture ideas |
| Projects | Execute |
| Vault management | Images, templates, inbox, and the **AI** tree |

The last folder is the seam into video A: agents live next to the
inbox, not mixed into human notes.

### AI as efficiency, not a replacement

Everything above predates LLMs. What changed is the value
proposition: an agent *inside* the vault has the cognitive state —
what you have been learning, which ideas you captured, what you are
working on. Role: **move faster**, not think instead of you.

Across the three operations:

| Operation | AI's job |
| --- | --- |
| Knowledge | Tutor calibrated to *your* notes; map new concepts onto models you already have |
| Ideas | Talking partner: challenge, expand, connect to something you wrote months ago |
| Execute | Draft from notes, exhaust solution spaces faster |

Hard caveat, repeated: **do not hand over the thinking.** Challenge,
map, explore — yes. Judgment and taste stay human. The LLM does
mechanical surrounding work so the remaining context window is spent
on decisions and synthesis "that no LLM can replicate."

### Pseudo-productivity

Closing constraint: the system is a good procrastination toy.
Beautiful graphs, perfect folders, Wikipedia-grade notes feel like
work and produce nothing. Obsidian is "really satisfying," which is
exactly the trap. **Value is measured in what you produce with it.**

---

## Video: Obsidian and AI were made for each other

### The feedback loop

A is explicit about being the other half of B. The loop:

- AI gives the vault **execution power**.
- The vault gives the AI **total context**.

Once agents are fused into the second brain, Obsidian is his main
interface for AI — "a master operating system for pretty much
everything." Quality of output is quality of context. A coding agent
that already lives in the markdown does the "bring me up to speed"
work itself. No API: the vault is a folder.

### The agent garage

One generic assistant is the weak form. Specialized agents for
workflows are the strong form, because "AI is best when it's focused
into one thing." The implementation rhyme: **agents are folders with
markdown** — the same primitive Obsidian already is. The garage is a
directory, not a SaaS roster.

### Why Pi, not Claude Code

He runs [Pi](https://github.com/mariozechner/pi-mono) as the coding
agent of choice; Claude Code "will work equally fine." Preference:

- Fully customizable; he can mold it.
- **Minimal system prompt.** Claude Code's (~10k token) coding prompt
  is "a bit redundant when we're not doing any coding, we're doing
  Obsidian stuff and thinking stuff."

Any coding agent works; Pi is chosen for control. That is the same
split Vertragus already made: Pi is a **spawn overlay**, not a
seventh provider — see handbook Phase H. The overlay exists so slots
keep their model route while the process is a small, moldable CLI.

### The AI inbox and the vault boundary

Next to the regular inbox sits an **AI inbox** — the place that
stores agents. Example: a general-purpose `chats` agent whose
`agents.md` is the OpenClaw system prompt, plus one local constraint:
**write and edit only inside the AI inbox.** Human notes stay
unpolluted. He says this out loud as a design rule, not a nice-to-have.

He still *reads* the whole vault (that is the leverage). Writes to
human notes require **explicit permission** in the session. Link
creation in the demo waits for that grant; he watches the graph so
the model cannot silently rewrite the knowledge graph.

This is the PKM version of "workers run in worktrees; promote is a
click."

### Specialized agents in the demo

| Agent folder | Job | Local extras |
| --- | --- | --- |
| `chats` | General ChatGPT-replacement, but with vault search | OpenClaw `agents.md` + write boundary |
| Personal OpenClaw | "Based on everything you know about me…" | Mirrored `SOUL.md` / `USER.md` (filenames from captions; he censors the read-out) |
| Vault / link finder | Find missing links between notes | Hidden `.pi` skill, Python scanners, **sub-agents to verify** a hit is a real connection and not the same word |

The link-finder is the most harness-like slice: search is cheap,
verification is a second pass, edits are gated. He even floats
embeddings/cosine similarity as a *different* matching workflow — and
does not treat it as required.

### YouTube summaries

Own `agents.md` plus a Python script that fetches the transcript.
Paste a link; pick a cheap model (Gemini; Opus is "overkill"). He is
particular about **format**, not vibe:

1. Overview of the whole video
2. Section structure
3. **Key concepts** — mainly so he can form wiki links later. If the
   creator's definition of a word differs from the established one,
   note the difference **and prioritize the creator's definition**
4. Pure **argument structure** extracted from the talk

Output is a markdown file in the vault. The host of the summary is
the folder, not a chat transcript that will vanish.

### Outlier finder

A second YouTube tool, with its own skill. Goal: videos that
performed **meaningfully better than that channel's expected
baseline**, adjusted for how long the video has been up. Flow he
demos:

1. Short prompt ("find outliers in the AI agents niche")
2. Agent reads the skill
3. Finds a seed video
4. Walks the recommended page
5. Analyzes channels
6. Writes a report with thumbnails (example: a 62× outlier)

He says this class of job **needs an orchestrator** — search is not
a single completion. Outputs land in Obsidian because that is where
the rest of the work already is.

### Calibrated tutoring

Prompt pattern: "Go through my math notes. Get a grasp of my current
level. Explain the Riemann hypothesis assuming I know everything in
the notes; motivate anything beyond." Two sub-agents in parallel. The
pain he hits live: **LaTeX in the terminal UI** is unreadable; he
pastes into Obsidian (and mentions a not-yet-enabled extension). The
lesson is about **calibration to existing notes**, not about math
as a product feature.

### One interface, two windows

Closing pitch: one interface for all AI work; stop juggling web UIs.
He likes **Obsidian and the terminal as separate windows**. He notes
a community plugin for an integrated terminal and shows it as
optional, not as the architecture.

---

## Mapping onto Vertragus

### Already in the code

Alvar's primitives already have a host-side counterpart. The mapping
is *jobs*, not UI clones.

| Alvar | Vertragus today | Where |
| --- | --- | --- |
| Brain should not bookkeep its own state | Host owns lifecycle, questions, tasks, git facts | `eventQueue`, `PendingQuestions`, `taskBoard.ts`, `inspect_agent` |
| Knowledge in (capped, durable) | Briefing from `AGENTS.md` / `CLAUDE.md` / `README.md`, last commits, `repoNotes` | `Workspace` briefing, `retro.ts` |
| Ideas out / one inbox | Composer `user_message`, `ask_user`, `task_create` — one host path, not a second brain typing into the TUI | README handshake; handbook D / H.2 |
| Revisit commitment | Journals, `search_runs`, resume briefing, retro learnings | `journal.ts`, `searchRuns.ts`, E3 |
| Git-commit capture | `snapshotDone` commits the worktree on `report_done`; branch survives | `worktree.ts` — no autodelete |
| Agents as folders with markdown | Each agent is a worktree plus role prompt plus contract; Pi wrap writes `.pi/APPEND_SYSTEM.md` | `roles.ts`, `contract.ts`, `piHarness.ts` |
| Specialized agents | Slots and builtin roles (Worker, Reviewer, Tester, Architect, Docs, Janitor, Explorer) | `profile.ts`, `roles.ts` |
| Write boundary / no pollution | Mandatory worktrees under `.vertragus/worktrees/<id>`; checkout is not shared | `worktree.ts` |
| Explicit permission to touch "real" notes | `integrate_branch` + Promote click; `autoIntegrate` / `autoPromote` default **off** | handbook E1 / A3 |
| Sub-agent then verify | `start_agent` + `inspect_agent` / host facts on `agent_done`. Complete on the task board is an **orchestrator** decision after verification | G4 task board |
| Do not hand over judgment | `yolo` / `ask-user` / `ask-orchestrator` | D4 |
| Skills and extra tools | `extraMcp` on **workers only**; playbooks are **goal templates**, never a pre-started crew | E6, `profile.ts` |
| Browser-shaped research (outlier walk) | First-party `/browser` on the existing listener, not a second MCP | Phase H, [`CHROMIUM-EXTENSION.md`](./CHROMIUM-EXTENSION.md) |
| Pi for a small prompt | Pi wrap overlay; slots stay Claude / Cursor / Codex / Kimi / Grok / Ollama | handbook Phase H Pi wrap |
| Value = what shipped | Isolation stays until promote; retros score runs; no RAG hoard | handbook non-goals |
| Anti-Wikipedia notes | Briefing is capped and labelled untrusted; `repoNotes` max 20, user-deletable | `MAX_REPO_NOTES_PER_PROFILE` |

The README line "there is no second brain typing into the TUI" is a
**different** use of the phrase: it means "do not fork the
orchestrator's turn by typing into a parked PTY." Do not reuse
"second brain" as a panel label. The collision is terminological,
not architectural.

### Tensions with doctrine

These are the places where copying the video would fight the
handbook.

1. **Shared folder vs mandatory worktrees.** Alvar's agents `cd`
   into a vault subdirectory and read/write the same tree the human
   sees (with a prompt-level write fence). Vertragus has no
   shared-checkout mode. That is load-bearing: parallel agents must
   not trample each other. A vault-as-profile still works — **if the
   vault is a git repository** — but each agent sees a worktree copy
   under `.vertragus/worktrees/`, not the Obsidian working copy.
2. **Git is a gate.** Profiles need a repo path. A vault that is
   "just a folder" cannot be a Vertragus profile until `git init`.
   That is acceptable. It is not a reason to add a non-git mode.
3. **Read-the-whole-vault vs no RAG.** Workers can grep their
   worktree. The orchestrator briefing is capped on purpose. Semantic
   "similar notes" plugins and embedding indexes are the RAG-shaped
   thing the handbook lists as a non-goal. Do not add a vector store
   "because Obsidian has Smart Connections."
4. **Write fence in `agents.md` vs unrestricted workers.** Workers
   are not tool-caged; discipline is the contract. Host-enforced
   path allow-lists would be a second security product. The worktree
   *is* the fence. Promoting into the human checkout stays a click
   (or an explicit automation switch).
5. **Agent garage as a product.** Folder-per-agent inside Obsidian
   is his OS. Vertragus' OS is the panel, the MCP allow-list, and
   slots. Do not grow a PKM chrome (PARA, daily notes, graph view).
6. **OpenClaw identity files.** `SOUL.md` / `USER.md` as a personal
   companion is adjacent to retro learnings, not a replacement. We
   already push a capped insight list. We do not build a soul.
7. **Depth and fan-out.** His Pi session spawns "a lot of
   sub-agents" from one folder. Vertragus caps helpers
   (`MAX_HELPERS_PER_WORKER = 3`), forbids lead-starts-lead, and
   keeps grandchild events out of the root `await_events` queue.
8. **Playbooks that spawn crews.** His specialized folders look like
   pre-started teams. Handbook non-goal: playbooks fill the **goal
   field**; the orchestrator still decides who to start.

### What not to build

- An Obsidian plugin, a vault product, or "Vertragus as a second
  brain"
- Vector search / embeddings / "missing links" as a host tool
- A YouTube transcript tool on the orchestrator allow-list
- Filesystem write-scopes for workers (the worktree is the scope)
- OpenClaw / `SOUL.md` as a provider or builtin role
- Automatic inbox processors (that is a **goal**, not a daemon)
- A second kanban, DAG, or PARA engine (the task board is the
  capture layer; keep it)
- UI copy that calls the panel a "second brain" (collides with the
  TUI handshake warning)
- Lowering isolation so agents edit the Obsidian checkout in place

### What we could take without a new product

Usage and docs only — no new MCP verbs.

**Vault as a profile (recipe).** `git init` the vault if needed. Point
a profile `repoPath` at it. Ignore `.vertragus/` in git **and** in
Obsidian's excluded files so worktrees do not pollute the graph.
Keep `autoPromote` off: the human checkout stays the trusted notes;
promote is the temporal-contract revisit that writes back. Pi wrap
on if the work is thinking/markdown rather than a 10k-token coding
prompt.

**Capture vs complete.** Treat `task_create` as rule 1 of the
temporal contract (one place, no routing). Treat `complete` as rule
2 after `inspect_agent`, never as the worker's self-report. That is
already G4. The video is a reason to keep it, not a reason to grow
it.

**Playbooks as goal text.** "Paste a YouTube URL and write a note
under `Domains/` with overview, structure, creator-priority
definitions, and argument skeleton" is a playbook string. The
YouTube fetch stays a worker script or extra MCP the user attaches
— not a first-party tool.

**Docs role / Explorer, not new builtins.** Calibrated tutoring and
link-finding are goals for existing roles. A "Tutor" or "Scribe"
template would be a catalogue creep unless someone actually runs
that profile.

**Format control beats vibe summaries.** When a run *does* ingest
talks or RFCs, specify the extract (structure, definitions,
arguments) in the assignment. Alvar's YouTube agent is a prompt
contract, which we already know how to write.

**Pi wrap rationale, said out loud.** Alvar's reason for Pi (small
prompt, moldable, not a coding-only system prompt) is the best
external explanation of why the wrap is not a seventh provider.
Keep that sentence in the Pi settings copy if it is not already
there; do not expand the overlay.

---

## Adjacent context

Not in the two requested videos; useful so this research does not
pretend they are the whole channel:

- *How I Use AI to Learn Things* (https://www.youtube.com/watch?v=kzcI5F4tGiU)
  — same author, Pi + Obsidian teaching loop (probe, plan, one step
  at a time). Community skill pack `vasanthsreeram/Alvarmethod`
  ports that loop to several CLIs. Still not a Vertragus track.
- OpenClaw `agents.md` / memory files are an off-the-shelf personal
  agent prompt he copies, then fences. We have role prompts and a
  contract instead.
- No Boilerplate is credited for the temporal-contract phrasing;
  Alvar is unsure who coined it. Treat it as a named idea, not as a
  spec we must implement.

---

## Caveats

- Captions, not a studio script. Likely ASR: "PDE links" = wiki
  links; "personal consoler" = counsellor; "our layers" = outliers;
  Greek folder names were not recoverable as accurate identifiers.
- Plugin names in B are gestured at ("this one embeds notes in a
  vector database") without marketplace IDs. Do not treat that as a
  shopping list.
- Demos are his vault, his YouTube channels, his math notes. The
  transferable layer is the three operations, the temporal contract,
  the write boundary, and "agents are folders." The outlier finder
  and Riemann session are existence proofs.
- Nothing here authorizes a handbook non-goal. If a later change
  looks like RAG, a second product, shared checkout, or autodelete,
  it is not "what Eero would do" — it is a doctrine break.
