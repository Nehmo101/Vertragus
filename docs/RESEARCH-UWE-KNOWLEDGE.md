English | [Deutsch](RESEARCH-UWE-KNOWLEDGE.de.md)

# Research: UWE knowledge versus Obsidian agents

Stand: 25 August 2026. Re-read of the Obsidian + agent landscape
against the sibling product
[UWE](https://github.com/Nehmo101/UWE) (`main` at `2577bbd`).
Purpose: the earlier Vertragus notes assumed a markdown vault as
the knowledge host. UWE is not that host. It already ships an
Obsidian-*shaped* knowledge OS — wiki, graph, wikilinks, vault
import, two brains, four MCP servers — on SQLite and HTTP, with
privacy tests. This document maps the landscape onto **UWE as it
is in that repo today**, then says what Vertragus should (and
should not) do when the profile is the UWE checkout.

This is not a product track in either repo. It does not add
Vertragus tools, UWE tools, RAG in the harness, or an embedded
Obsidian.app. Companion landscape:
[`RESEARCH-OBSIDIAN-AGENTIC.md`](./RESEARCH-OBSIDIAN-AGENTIC.md).
Alvar video deep dive:
[`RESEARCH-OBSIDIAN-AI-SECOND-BRAIN.md`](./RESEARCH-OBSIDIAN-AI-SECOND-BRAIN.md).
Doctrine: [`HANDBOOK-HARNESS.md`](./HANDBOOK-HARNESS.md).

---

## Purpose

The phrase "theoretically there is already an internal Obsidian"
is the right instinct and the wrong noun. UWE did not embed
Obsidian. It rebuilt the *jobs* people use Obsidian for (linked
notes, graph, inbox, local AI, player-safe vs GM-private) as
first-party product surfaces, then put agents on the same HTTP
path every other client uses.

The landscape recipes that say `cd vault && claude`, drop a
Filesystem MCP on a folder, or embed Claudian inside Obsidian
**fight UWE**. They would read around `view=dm|player`, around
`dm_only` stripping, and around the Personal-Brain local-only
gate. The useful remap is: Vertragus stays the coding harness;
UWE stays the knowledge host; workers attach UWE MCP the way
the landscape wanted to attach Local REST API.

---

## What UWE actually is

UWE's own one-line: a self-hosted OS for tabletop rounds *and*
everyday life — GM studio, player wiki, private knowledge, own
hardware. It is a pnpm monorepo of five Next.js apps plus about
forty packages. Knowledge is **not** a folder of markdown.

| App | Default port | Audience | Store |
| --- | --- | --- | --- |
| Studio | 3000 | GM / owner | `uwe.db` — worlds, wiki, World-Brain, AI |
| Portal | 3001 | players | same core DB, fail-closed player view |
| Brain | 3002 (loopback) | owner only | `uwe-brain.db` — Life-Brain, Daily Admin, mail |
| Family | 3004 (loopback) | household checkbox | `uwe-family.db` |
| Landing | 3103 | public apex | no content |

The split is enforced (`@uwe/product-contracts`,
`scripts/product-boundary-check.mjs`). `dm_only` never reaches
Portal. `owner_private_local` / `personal_brain` never leave the
host and never go to cloud AI (ADR 006, `SECURITY.md`). Local
inference is **Maschinenraum** (outbound connector to Ollama /
LM Studio / llama.cpp). Cloud is opt-in for D&D context under
gateway policy; Personal Brain is not configurable.

Command Center (Tauri) can start the web apps on Windows. That
is host operations, not a second knowledge UI.

---

## The internal Obsidian

What exists is an Obsidian-*shaped product*, not Obsidian.app
in a webview.

**Wiki + wikilinks.** Pages store authored content; `[[wikilink]]`
parsing lives in `packages/database/src/wikilink-utils.ts`
(pipe labels, HTML-entity decode so `A'Tuin` survives import).
Backlinks come from a cached graph, not from grepping a folder.

**Graph that chases Obsidian craft.** `packages/shared-ui`
`graph-engine*.ts` and `tools/wiki-graph-aaa` compare camera
tween (150–200 ms band), spotlight dim, and constellation
spacing against Obsidian's void canvas. The parchment look is
an intentional brand fork, not a missing dark theme. This is
visual parity as a quality bar, not a second PKM operating
system.

**Vault ZIP import.**
`packages/database/src/obsidian-vault-import.ts` unpacks an
Obsidian export, skips `.obsidian/` and `.trash/`, caps at
10 MB / 2000 files, and feeds the existing markdown import
pipeline. Command Center doc-import skips the same hidden
folders. Maturity matrix: Import hub is Beta — the
Obsidian/PDF *upload UI* is listed as deliberately not
pursued (`docs/CURRENT_STATE.md`). Backend path exists; there
is no in-app Obsidian editor.

**Wiki as game data.** A page can declare what it *is*
rule-wise (species, spell, weapon, …) via `Page.gameDataKind`
plus `GameDataEntry`. Character creation reads that catalog.
A markdown vault has notes; UWE has notes that are also game
objects. That is why "just sync the vault" is the wrong
migration story.

**Daily Admin OS.** `/today`, `/capture`, `/projects`,
`/workshop`, `/life-brain`, `/hardware`, ki-chat. Capture is
the trusted inbox. Promote-to-Life-Brain is review, not
auto-apply. KI outputs are proposals. This is Alvar's
temporal contract implemented as product, not as a folder
named `Inbox/`.

None of this is a reason to ship Obsidian inside UWE, or to
treat the git checkout as the wiki.

---

## Two brains, two privacy regimes

People say "the brain" and mean three different stores.

| Name | Where | What it is | Cloud AI |
| --- | --- | --- | --- |
| World-Brain | Studio / `uwe.db` | campaign documents, facts, chunks, wiki graph | Allowed under gateway policy after `dm_only` strip; local preferred |
| Personal Brain / Life-Brain | `apps/brain` / `uwe-brain.db` | owner private notes, captures, facts | **Never.** Mode `personal_brain` is local-only |
| Family | `uwe-family.db` | household calendar, kitchen, health | Shared with the family checkbox, still host-local; chats/docs are not on MCP |

World-Brain has a versioned Knowledge API
(`/api/v1/knowledge/*` in `packages/knowledge`). Every world
endpoint requires `view=dm|player`. Missing `view` is 400 —
there is no silent GM default. Player view is built
fail-closed (`asPlayerPreview`: portal release, `:::dm` cut
from text, World-Brain only `canonical` rows linked to a
released page). Semantic search on World-Brain needs
`worlds_read` plus `ai_invoke` and the token owner's
`aiAccess` flag.

Personal Brain search is Maschinenraum embeddings plus
keyword fallback (`/api/life-brain/search`). If Maschinenraum
is down, the job defers (HTTP 202). There is no cloud
fallback. Capture → Life-Brain is `promoteCaptureToLifeBrain`
with an `AdminEntityLink` back to the source.

KI never auto-writes canon. Apply is a human action; publish
to Portal is a second one.

---

## How agents already attach

UWE's agent bridge is **not** "open the vault." It is four
stdio MCP servers in `packages/mcp`, registered at repo-root
`.mcp.json`:

| Server | Product | Job |
| --- | --- | --- |
| `uwe-studio` | Studio :3000 | worlds, Knowledge API, jobs, admin |
| `uwe-portal` | Portal :3001 | player-view checks (`view=player` hardcoded) |
| `uwe-brain` | Brain :3002 | Personal Brain, privacy-gated |
| `uwe-family` | Family :3004 | household; no private chats/docs |

They are thin HTTP clients. They **do not** import
`@uwe/database` and they do not open SQLite. Authz, visibility
filters, and audit logs stay on the same path as the UI.
Writes register only when `UWE_MCP_ALLOW_WRITES=true`
(exactly that string). Brain *content* tools
(`brain_search`, `brain_context`, `brain_calendar`) register
only when `UWE_MCP_BRAIN_ALLOW_CONTENT=true`. Default Brain
surface is metadata: `brain_health`, `brain_stats`,
`brain_privacy_status`. `brain_stats` is required to hit
`/api/life-brain/stats`, never search — search returns titles.

The comment in `packages/mcp/src/tools/brain.ts` is the
doctrine in one paragraph: Claude Code *is* cloud AI, so
content leaving the host toward an MCP client is an explicit
owner unlock, not a tool argument the model can flip.

Area skills under `.claude/skills/uwe*` are generated from
`createServer()` (`scripts/generate-area-skills.ts`,
`pnpm skills:sync`). Stale slash commands that named deleted
tools are how they learned not to hand-write the catalog.

Studio knowledge tools include
`studio_knowledge_worlds|search|page|brain|graph` with
required `view`. Portal tools cannot open GM view.

---

## Remap the two jobs

The landscape split still holds. The *host* for each job
changes.

| Landscape job | Vault-world host | UWE host |
| --- | --- | --- |
| **A — operate the PKM** | folder as cwd, Pi in the garage | Studio wiki + Brain Daily Admin + ki-chat + UWE MCP against the **running apps** |
| **B — remember the coder** | sidecar vault / Local REST API from a code repo | when the code repo **is UWE**, workers attach `uwe-studio` (and only if unlocked, `uwe-brain`) as extra MCP |

Job A inside UWE is already a product. Vertragus should not
grow a second inbox, PARA chrome, or `SOUL.md` to serve it.
Job B inside Vertragus is still extra MCP on **workers**,
never on the orchestrator — same E6 rule as Local REST API.

A third mix-up to refuse: treating the UWE **git worktree** as
the wiki. Pages live in SQLite. Markdown in the repo is
source code and docs, not campaign canon. An agent that
`Write`s `notes/npc.md` in `.vertragus/worktrees/<id>` has not
updated the world.

---

## Remap the attach layers

| Landscape layer | Verdict on UWE |
| --- | --- |
| Layer 0 — vault is a folder | False. Knowledge is SQLite + HTTP. Folder-as-cwd skips authz. |
| Layer 1 — `agents.md` / skills | UWE already has area skills + MCP tool catalog, generated and CI-checked. Do not add Alvar-style agent folders inside the wiki. |
| Layer 2a — folder as cwd | Harmful. `cd` into a vault *or* into `uwe.db`'s directory and the product split is gone. |
| Layer 2b — embed Claudian / PiChat / Obsidian | Do not. UWE already has ki-chat and four MCP servers. A panel-inside-the-vault would be a second host for the same concern. |
| Layer 2c — vault as MCP (Local REST API / Filesystem MCP) | Wrong protocol. Use `uwe-studio` / `uwe-brain`. Filesystem MCP on the data dir bypasses `view` and Personal-Brain gating. |
| Layer 3 — `MEMORY.md` / OpenClaw identity | UWE has typed facts and documents with review. Do not invent a markdown soul file beside `uwe-brain.db`. |
| Layer 4 — Smart Connections RAG | World-Brain and Life-Brain already embed **as UWE product features** with privacy tests. That does not license RAG inside Vertragus. |

kepano/`obsidian-skills` remain format literacy for people who
still keep a vault. They are not an OS UWE should vendor, and
not a Vertragus submodule.

---

## Worktrees and melt

The mycelium-hq worktree-in-vault OOM still matters for anyone
who points Obsidian at a git repo. It does **not** describe
UWE's knowledge store: Obsidian is not watching `uwe.db`.

What still applies when Vertragus runs **on the UWE checkout**:

- Each agent is a git worktree under
  `<repo>/.vertragus/worktrees/<id>`. Never autodelete.
- Those worktrees are source copies, not wiki copies. Promote
  merges code. Wiki writes go through Knowledge API / Studio
  UI / MCP writes.
- Do not `git init` a vault *inside* the UWE repo to "give the
  agent notes." That reintroduces melt *and* a shadow canon.
- Extra MCP stdio for `uwe-*` should talk to the **running
  host instance** (ports from `.env`), not to a per-worktree
  SQLite. Thin HTTP clients already work against a tunneled
  remote Studio; they should not grow a direct-DB mode.

---

## Semantic search versus the harness RAG non-goal

Vertragus non-goal: no vector store, no Smart Connections, no
host retrieval over notes. Capped facts are `repoNotes` and
retro learnings.

UWE on purpose: World-Brain semantic search and Life-Brain
chunk embeddings via Maschinenraum. Gated, tested, and split
so D&D chunks never mix with `PersonalBrainChunk`.

These are not in conflict if the boundary is kept: **UWE may
retrieve; the harness may not grow a second index.** A
Vertragus worker that calls `studio_knowledge_brain_search`
is using UWE's retrieval, not adding RAG to Electron. A
Vertragus change that embeds vault files into the panel would
be the non-goal.

---

## Alvar's garage under UWE law

| Alvar move | UWE analogue | Do not |
| --- | --- | --- |
| Second brain = cognitive state, not storage | Daily Admin + Life-Brain + World-Brain, typed | Pretty graph as the product |
| Temporal contract (one inbox, must revisit) | `/capture` → triage → promote | A second markdown inbox in the git repo |
| Knowledge in / ideas out | KI proposals, review, apply, publish | Auto-apply on model confidence (ADR 006 rejected this) |
| Write boundary (read vault, write AI inbox) | MCP writes off by default; Brain content off by default; `:::dm` never to Portal | Filesystem writes into SQLite paths |
| Agents are folders with `agents.md` | Four MCP servers + generated area skills | Agent folders as wiki pages |
| Pi because the coding prompt is too big | UWE ki-chat + local Maschinenraum for Personal Brain; Vertragus Pi wrap stays for *coding* overlays | Pi-as-seventh-provider; Pi pointed at `uwe.db` |
| One interface, two windows | Studio/Brain UI + a terminal that speaks MCP | Claudian inside UWE, or Obsidian beside it as a second source of truth |

Alvar's folder-as-cwd garage is the right design for a
markdown vault. UWE left that architecture on purpose. Copying
the garage into UWE would throw away the player view, the
three databases, and the cloud-AI split.

---

## Preferred recipes

**Recipe UWE-B (preferred when coding UWE in Vertragus).**
Profile `repoPath` is the UWE git checkout. Orchestrator stays
on the harness allow-list. Workers get extra MCP (stdio,
cwd = UWE checkout or any tree that can spawn
`packages/mcp`) for `uwe-studio`, and `uwe-portal` when the
task is "what does a player see?" Attach `uwe-brain` only
when the owner has set `UWE_MCP_BRAIN_ALLOW_CONTENT=true` for
that session — default is metadata. Tokens live in extra-MCP
env/headers (AppSettings), not in committed profile JSON.
`UWE_MCP_ALLOW_WRITES` stays off unless the task is a
deliberate wiki edit. Commits stay in `.vertragus/worktrees/`.
The live Studio/Brain processes are the knowledge truth.

**Recipe UWE-A (operate the knowledge OS).** Do not open a
Vertragus profile on the vault, and do not pretend the
checkout is the wiki. Use Studio, Brain, ki-chat, and UWE MCP
from whatever CLI the owner already runs against the host.
Vertragus is optional here.

**Recipe landscape-B (still valid for a leftover vault).** If
something remains in Obsidian that UWE does not ingest, keep
that vault off the UWE repo, exclude `.vertragus/` from
Obsidian if you ever git-init it, and attach Local REST API
as worker extra MCP from a *code* profile — never as a
Filesystem MCP on UWE's data directory.

No new Vertragus tools. No new UWE MCP surface for this
research.

---

## What not to build

In **Vertragus**:

- An Obsidian plugin, Claudian clone, or "panel inside the vault"
- First-party vault MCP (UWE and Local REST API already exist)
- RAG / Smart Connections as a host tool
- Shared-checkout mode "because SQLite is not a git folder"
- Autodelete of worktrees
- `SOUL.md`, PARA, daily-notes chrome, YouTube on the
  orchestrator allow-list
- Shipping UWE or Obsidian as a provider
- Pointing Pi at a vault cwd as if that were UWE

In **UWE** (research advice, not a UWE patch):

- Embedding Obsidian.app or Claudian
- A Filesystem MCP on `uwe.db` / `uwe-brain.db`
- Collapsing the four MCP servers into one catalog
- Making `UWE_MCP_BRAIN_ALLOW_CONTENT` a tool argument
- Cloud fallback for `personal_brain`
- Auto-apply of KI into canon
- Re-opening the Obsidian upload UI as a required track
  (product already marked it not pursued)

---

## Code anchors

UWE paths, relative to that repo root (`2577bbd` on `main`):

| Topic | Where |
| --- | --- |
| Product split / DB files | `docs/CURRENT_STATE.md`, `packages/product-contracts` |
| Wikilinks | `packages/database/src/wikilink-utils.ts` |
| Vault ZIP import | `packages/database/src/obsidian-vault-import.ts` |
| Graph vs Obsidian craft | `packages/shared-ui/src/graph-engine*.ts`, `tools/wiki-graph-aaa` |
| Wiki as game data | `docs/engineering/wiki-als-spieldaten-katalog.md` |
| Knowledge API | `docs/knowledge-api.md`, `packages/knowledge` |
| Personal-Brain privacy | `docs/life-brain-privacy.md`, ADR 006 |
| MCP servers | `packages/mcp`, `.mcp.json`, `docs/engineering/mcp-servers.md` |
| Brain content gate | `packages/mcp/src/tools/brain.ts` |
| Studio knowledge tools | `packages/mcp/src/tools/studio-knowledge.ts` |
| Area skills generator | `scripts/generate-area-skills.ts` |
| Import UI status | `docs/CURRENT_STATE.md` (not pursued), maturity matrix |

Vertragus: worker extra MCP (`extraMcp` on the profile, E6),
worktrees, Pi wrap as overlay, handbook RAG non-goal — see
[`HANDBOOK-HARNESS.md`](./HANDBOOK-HARNESS.md).

---

## Caveats

- This pass cloned public `Nehmo101/UWE` and read docs plus
  the files in the table. It did not run UWE, pair MCP, or
  import a vault.
- UWE docs are German-canonical. Feature maturity dates
  lag `main`; `CURRENT_STATE.md` wins on runtime/CI.
- Portal membership rule (assigned-to-world sees everything
  in that world) is product law and is not a leak of
  `dm_only` into Portal.
- Nothing here authorizes a handbook non-goal. UWE retrieval
  is not a license for Vertragus RAG. UWE MCP is not a
  license for orchestrator tool sprawl.
- Do not vendor UWE into this git repo as a submodule for
  research.
