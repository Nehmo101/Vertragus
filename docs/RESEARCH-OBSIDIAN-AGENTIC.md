English | [Deutsch](RESEARCH-OBSIDIAN-AGENTIC.de.md)

# Research: Obsidian and agentic development

Stand: 25 August 2026. Landscape scan of how coding agents (Claude Code,
Codex, Pi, Grok Build, OpenCode, Cursor Agent) are being wired to
Obsidian vaults — plugins, MCP, skills, memory files, and the two
jobs people keep mixing up. Purpose: map the pattern onto Vertragus
**as it is in the code today**, without starting a PKM product.

This is not a product track. It does not add tools, roles, or MCP
surface. Companion video deep dive (Eero Alvar):
[`RESEARCH-OBSIDIAN-AI-SECOND-BRAIN.md`](./RESEARCH-OBSIDIAN-AI-SECOND-BRAIN.md).
Sibling product (UWE already is the Obsidian-shaped knowledge OS):
[`RESEARCH-UWE-KNOWLEDGE.md`](./RESEARCH-UWE-KNOWLEDGE.md).
Doctrine: [`HANDBOOK-HARNESS.md`](./HANDBOOK-HARNESS.md). Historical
plugin research: [`RESEARCH-DEEPSEEK-HARNESS.md`](./RESEARCH-DEEPSEEK-HARNESS.md).

---

## Purpose

By mid-2026 the phrase "Obsidian + agents" covers at least four
different architectures, two product jobs, and one recurring
footgun (git worktrees *inside* a vault that Obsidian is watching).
The scan below is a map, not a shopping list. Sources are public
repos, plugin directories, vendor docs, and a handful of widely
copied setup posts. Star counts and plugin names rot; the *jobs*
do not.

---

## The two jobs people keep conflating

| Job | What the vault is | What the agent is doing |
| --- | --- | --- |
| **A — operate the PKM** | The working directory | Read, file, link, summarize, tutor *notes* |
| **B — remember the coder** | A sidecar memory for *other* git repos | Load stack prefs, repo maps, decisions; then code elsewhere |

Alvar's garage (video A in the companion doc) is job A. Railly's
*agent-brain* and TheFancyRobot's `.agent-vault/` inside a code repo
are job B. OpenClaw's `MEMORY.md` / `USER.md` / `SOUL.md` is job B
with a personal-agent skin. Most blog posts sell both as one "second
brain OS." They are not.

Vertragus is **neither product**. It orchestrates coding CLIs over
mandatory worktrees with host-owned git facts. Job B can already
ride along as **worker extra MCP**. Job A as a profile is possible
only with eyes open (see [The worktree melt](#the-worktree-melt)).

---

## Layer 0: the vault is a folder

Obsidian's durable bet, including from CEO Steph Ango (kepano): the
files are the product; the app is a viewer. Vault = directory of
markdown (plus `.base`, `.canvas`, `.obsidian/`). No API is *required*
for an agent to work. `cd vault && claude` is a complete integration.

That is why coding agents won this niche over chat plugins: they
already know how to read, grep, patch, and shell. The vault looks
like a repo. The cost of that rhyme is that a vault is **not** a
typical code repo — another process (Obsidian, Sync, iCloud) owns
the working copy the human sees.

---

## Layer 1: instruction files and skills

Every serious setup repeats the same three files, under different
names:

| File | Who reads it | Job |
| --- | --- | --- |
| `CLAUDE.md` | Claude Code | Always-on house rules |
| `AGENTS.md` | Codex, Cursor, Windsurf, Copilot, many others | Same content, other harness |
| `GEMINI.md` | Gemini CLI | Same again |

Claude Code does **not** read `AGENTS.md` as a fallback (checked
against Anthropic memory docs in 2026). The working bridge is a
one-line `@AGENTS.md` import at the top of `CLAUDE.md`, or a
symlink. Vault templates (arkan, mithunyc, Railly) write all three
pointers so the protocol lives in one canonical file.

**Agent Skills** ([agentskills.io](https://agentskills.io/specification))
are the next layer: a folder with `SKILL.md`, optionally scripts.
kepano's [`obsidian-skills`](https://github.com/kepano/obsidian-skills)
(~47k stars, 2026) is the official-adjacent pack — *format literacy*,
not an OS:

| Skill | Teaches |
| --- | --- |
| `obsidian-markdown` | Wikilinks, embeds, callouts, properties |
| `obsidian-bases` | `.base` views / filters / formulas |
| `json-canvas` | Open `.canvas` format |
| `obsidian-cli` | Drive the running app via the Obsidian CLI |
| `defuddle` | Clean markdown from web pages (token saver) |

Alvar's "an agent is a folder with markdown" is this primitive plus
a write-boundary paragraph. Vertragus already has role prompts +
contract + `.pi/APPEND_SYSTEM.md`. We do not need to ship kepano's
pack; a user drops it in the repo or vault themselves.

**Obsidian CLI** (installer 1.12+, Settings → General → Command
line interface) talks to the *running* app: search, daily notes,
properties, tasks, plugin reload, screenshots, `eval`. It is the
native cousin of Local REST API. It does not replace git, and it
does not run headless unless you use Obsidian Headless / Sync.

---

## Layer 2: three ways an agent touches the vault

### Folder as working directory

Point the CLI at the vault. No plugin. Works when Obsidian is
closed. Loses live graph, Dataview, Templater, the open tab, and
surgical "patch this heading." This is the default in almost every
"Claude Code + Obsidian" tutorial.

### Embedded harness inside Obsidian

A community plugin spawns the same CLIs Vertragus already wraps,
with the vault as cwd and a chat sidebar as the TUI.

| Plugin | Harnesses | Notes |
| --- | --- | --- |
| [Claudian](https://github.com/YishenTu/claudian) | Claude Code, Codex, Grok, OpenCode, Pi | ACP transport; inline edit + diff preview |
| [Oh My Claudian](https://github.com/lee259/oh-my-claudian) | Claudian fork + Cursor Agent + Oh My Pi | Same idea, more ACP backends |
| [Agent MCP](https://github.com/rospaans/obsidian-agent-mcp) | Claude Code, Codex, Ollama-via-claude | Built-in terminal + local MCP on `:27183`; Claude IDE lockfile |
| [PiChat](https://community.obsidian.md/plugins/pi-chat) / sigilmakes | Pi CLI | Renders Pi JSONL as vault markdown |
| [obsidian-pi](https://github.com/ChristianLempa/obsidian-pi) | Pi | Note / backlink / tag context |
| [Pivi](https://github.com/shuuul/obsidian-pivi) | Pi runtime in-process | Markets itself as *not* a coding agent |

These compete with Vertragus on **where the terminal lives**, not
on orchestration. They assume shared checkout. They do not give
you worktrees, `inspect_agent`, task-board CAS, or succession.

### Vault as MCP server

Keep the coding agent in a *code* repo (or in Claude Desktop) and
attach the vault as a tool.

Two ecosystems:

1. **Filesystem MCP** (`@modelcontextprotocol/server-filesystem`)
   pointed at the vault path. Obsidian can be closed. Grep, not
   Obsidian search. No heading-level patch.
2. **Live Obsidian HTTP**, now usually the community plugin
   [Local REST API with MCP](https://github.com/coddingtonbear/obsidian-local-rest-api)
   (v5, July 2026) at `https://127.0.0.1:27124/mcp/` (bearer token,
   self-signed cert) or `http://127.0.0.1:27123/mcp/`. Obsidian
   must be running. Heading/block patch, command palette, periodic
   notes. Older bridge `mcp-obsidian` is optional.

Other in-app MCP hosts: Cortex (`:27182`), Leonezz
`obsidian-mcp-server` (`:27123` + token), Agent MCP (`:27183` plus
Claude IDE websocket). Same idea, different ports.

Vertragus already attaches extra MCP to **workers only** (E6): slot
`extraMcp: [{name, url}]` (HTTP, no headers), and Settings-global
servers with stdio or HTTP **including headers**. An authenticated
Local REST API belongs on the global extra-MCP list, not on the
orchestrator allow-list, and never as a second Vertragus server
(`vertragus` is reserved).

---

## Layer 3: memory, identity, and personal agents

Once the vault is reachable, people invent a memory hierarchy. The
shapes converge:

| Tier | Typical files | Injected |
| --- | --- | --- |
| Instructions | `AGENTS.md`, `CLAUDE.md`, `VAULT_RULES.md` | Always, keep tiny |
| Curated identity | `USER.md`, `SOUL.md`, `HUMAN.md`, `PURPOSE.md` | Always, budgeted |
| Durable facts | `MEMORY.md` + one-file-per-fact index | Always or on retrieval |
| Episodic | `memory/YYYY-MM-DD.md`, session transcripts | Search on demand, never dump |
| Project capsules | `07_System/context-files/*.md`, `repos-map.md` | `@` include per session |

OpenClaw documents this split explicitly (instructions vs
`MEMORY.md` vs daily episodic vs dreaming consolidation). Railly's
agent-brain adds slash commands (`/morning`, `/ship`, `/pulse`)
that *write* the episodic layer so the next session has evidence.
mithunyc/obsidian-agent-memory is the same idea as a vault
template: retrieval protocol, staleness, promotion rules.

Vertragus already has the *coding-run* version: briefing (capped,
untrusted), `repoNotes` (max 20, user-deletable), retro learnings,
journals, `search_runs`. That is push + pull over **runs**, not a
life wiki. Do not grow `SOUL.md`.

Job B ("remember the coder") is the honest use of a vault from a
Vertragus profile whose `repoPath` is a **code** repository:
workers attach vault MCP, read `repos-map.md`, and still commit in
their worktree.

---

## Layer 4: semantic search (the RAG fork)

[Smart Connections](https://github.com/brianpetro/obsidian-smart-connections)
builds local embeddings under `.smart-env/`. MCP bridges
(wakaser, msdanyg, gogogadgetbytes) expose `search_by_meaning` to
Claude. Alvar gestured at the same plugin in the second-brain
video.

This is RAG. Handbook non-goal. Workers can grep. `search_runs` is
substring over journals, deliberately not embeddings. Do not add a
vector store because a vault plugin has one.

---

## Patterns that keep showing up

1. **Plain text is the API.** Every setup that lasts is files on
   disk. Plugins are viewers and bridges.
2. **Keep the always-on prompt tiny.** Durable facts go in memory
   files that are retrieved, not in `CLAUDE.md`.
3. **Separate human notes from agent exhaust.** `_claude/`,
   `AI inbox/`, `00_System/AI/`. Pollution is the failure mode
   Alvar named out loud.
4. **Specialization is folders, not a SaaS roster.** Skills,
   slash commands, OpenClaw agent dirs.
5. **Do not hand over judgment.** Same caveat as Alvar; D4 tiers
   already encode it.
6. **Obsidian-the-app vs vault-the-folder.** Live features need
   the app (CLI, REST, graph). File features do not.
7. **Pseudo-productivity.** PARA + graphs + 40 slash commands is
   the trap video B warned about. Value is what shipped.

---

## The worktree melt

Claude Code's desktop app can create per-session worktrees under
`.claude/worktrees/` **inside the repo**. On a code repo that is
correct isolation. On an Obsidian vault whose repo root *is* the
vault root, it drops a full second copy of every note into the
folder Obsidian is watching. Documented failure
([mycelium-hq/ai-brain-starter `VAULT_WORKTREE_MELT.md`](https://github.com/mycelium-hq/ai-brain-starter/blob/main/docs/VAULT_WORKTREE_MELT.md),
measured 2026-06-06): renderer OOM, CPU pin, and a worktree that
the desktop app may archive mid-session, taking unique files with
it. Symlinks out of the vault do not help — Obsidian's watcher
follows them. Advice from that community: **never worktree a
vault**; run `cd vault && claude` plain; keep code isolation in a
*sibling* repo.

Vertragus always worktrees, at
`<repo>/.vertragus/worktrees/<agentId>`, and **never autodeletes**.
If `repoPath` is a vault, this is the same class of footgun unless
the user excludes `.vertragus/` from Obsidian's file watcher
(Settings → Files and links → Excluded files) **and** from git
ignore for Sync/iCloud. Even then each agent is a full checkout
on disk. The panel cleanup view is the only removal path.

This is the strongest argument for job B (vault as extra MCP on a
code profile) over job A (vault as the profile repo) inside
Vertragus.

A related Claude Code issue (background sessions refusing
Edit/Write outside `.claude/worktrees/` when `CLAUDE_JOB_DIR` is
set) is the inverse pain: isolation that hides edits from the app
that owns the working copy. Vertragus isolation is *host* policy,
not the CLI's. Promote is how the human checkout sees the work.

---

## Map onto Vertragus

### Already in the code

| Landscape piece | Vertragus today |
| --- | --- |
| Folder of markdown as cwd | Profile `repoPath` (must be git) |
| `CLAUDE.md` / `AGENTS.md` / `README.md` | E2 briefing reads those three plus last commits |
| Specialized agents | Slots + builtin roles; Pi wrap for a small prompt |
| Skills / slash commands | User-owned files in the repo; playbooks = **goal templates** |
| Write boundary | Worktrees; integrate + Promote; automation off by default |
| Vault as a tool from a code repo | Worker extra MCP (E6), not the orchestrator |
| Browser-shaped research | First-party `/browser`, not a second MCP |
| Capture / revisit | Task board (complete is orchestrator-after-verify) + `search_runs` |
| Capped durable facts | `repoNotes`, retro learnings — no RAG |
| Visible terminals | Panel PTYs, not an Obsidian sidebar |
| Isolation without autodelete | `worktree.ts` doctrine |

### Two recipes that do not need new tools

**Recipe B (preferred): code profile, vault as extra MCP.**
`repoPath` stays the git project. Enable Local REST API in
Obsidian (HTTP on `:27123` if you do not want the self-signed
cert dance). Put that URL on a **worker** extra-MCP server with
the bearer token in Settings headers. Orchestrator never sees
those tools. Workers grep or `vault_read` when the task needs
notes; they still commit in `.vertragus/worktrees/`. Obsidian
keeps watching one tree.

**Recipe A (vault as profile, eyes open).** `git init` the vault.
Exclude `.vertragus/` in Obsidian **and** in `.gitignore`.
`autoPromote` stays off. Pi wrap on if the work is thinking, not
a 10k-token coding prompt. Accept disk copies per agent. Do not
let Obsidian index worktrees. This is Alvar's garage under
harness law, not shared checkout.

**kepano skills** go in the vault or in `~/.claude/skills` — user
install, not a Vertragus submodule.

### What not to build

- An Obsidian plugin, Claudian clone, or "panel inside the vault"
- Shipping `obsidian-skills` or OpenClaw as a provider
- A first-party vault MCP (Local REST API already exists; extra
  MCP already attaches)
- Vector search / Smart Connections as a host tool
- Shared-checkout mode "because vaults melt under worktrees"
  (that would break isolation for every code profile)
- Autodelete of vault worktrees (the melt docs want cleanup;
  our doctrine is the opposite — the user clicks)
- PARA / daily-notes / graph chrome
- `SOUL.md` identity product
- Orchestrator tools for YouTube, inbox daemons, or `/morning`
- Using playbooks to pre-start a crew of PKM agents

---

## Landscape snapshot (catalog)

Point-in-time, August 2026. Names are evidence of the pattern,
not endorsements.

| Kind | Examples |
| --- | --- |
| Official-adjacent skills | kepano/obsidian-skills |
| Obsidian CLI | help.obsidian.md/cli (app must run) |
| Live vault MCP | Local REST API v5, Cortex, Leonezz, Agent MCP |
| Disk vault MCP | Filesystem MCP at the vault path |
| Embedded CLIs | Claudian, Oh My Claudian, Agent MCP, PiChat, obsidian-pi, Pivi |
| Vault templates / OS | Railly/agent-brain, arkan/obsidian-vault-template, mithunyc/obsidian-agent-memory |
| Code-repo sidecar vault | TheFancyRobot/agent-vault (`.agent-vault/`) |
| Multi-agent blackboard | yehudalevy-collab/agent-vault (`_multi-agent/`) |
| Personal agent memory | OpenClaw workspace markdown; Alvar AI inbox |
| Semantic RAG | Smart Connections + MCP bridges |
| Chat-plugin lineage (not coding agents) | Copilot, Smart Chat — different product, same markdown |

---

## Relation to the Alvar videos

The companion doc is the philosophy (temporal contract, knowledge
in / ideas out, write boundary, Pi because the coding prompt is
too big). This doc is the *market* that grew around the same
rhyme: markdown folder + coding agent.

Alvar's implementation is Layer 2 "folder as cwd" plus Layer 1
folders-as-agents, with a prompt-level write fence. He does not
use Vertragus-style worktrees, and he should not: that is the
melt. His "one interface" is Obsidian + a terminal window —
Claudian tries to collapse that into one window; he prefers two.

Nothing in the wider landscape weakens the Alvar mapping: do not
become a second brain; do not add RAG; Pi wrap is the right
overlay for non-coding vault work; extra MCP is the right bridge
for job B.

---

## Relation to UWE

[UWE](https://github.com/Nehmo101/UWE) is the owner's knowledge
host. It is not a markdown vault and not an embedded
Obsidian.app: wiki, graph, wikilinks, vault ZIP import, World-Brain
and Personal Brain live in SQLite behind four HTTP MCP servers.
Folder-as-cwd, Filesystem MCP, and Claudian fight that product.
The remap (recipe UWE-B, no new Vertragus tools) is
[`RESEARCH-UWE-KNOWLEDGE.md`](./RESEARCH-UWE-KNOWLEDGE.md).

---

## Caveats

- Plugin directories, ports, and star counts move. Prefer jobs
  (cwd vs MCP vs embed) over names.
- Local REST API TLS + bearer tokens are a secret. Extra MCP
  headers live in AppSettings, not in profile JSON committed to
  git. Do not put the key in `extraMcp.url`.
- Obsidian CLI and live MCP both need the app running. A
  Vertragus worker on a headless CI box will not see them.
- This scan did not install plugins or run Claudian. Claims about
  ACP coverage follow READMEs.
- Nothing here authorizes a handbook non-goal. Shared checkout,
  RAG, a second product, or autodelete stay forbidden even if
  every vault tutorial does the opposite.
