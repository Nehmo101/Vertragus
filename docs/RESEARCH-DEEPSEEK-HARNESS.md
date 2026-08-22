> Historical document (German). Kept as the original research record;
> see the Phase-G summary in [`HANDBOOK-HARNESS.md`](HANDBOOK-HARNESS.md).

# Deep Research: DeepSeek Harness (`dsh`)

Stand: 21. August 2026. Primärquelle: das offizielle Repository
[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)
(Shallow-Clone, Version `0.1.1-rc.1`), ergänzt um Web-Recherche.
Zweck dieses Dokuments: vollständige Feature-Inventur des neuen
DeepSeek-Harness — und was davon für Vertragus relevant ist.

---

## 1. Was ist DeepSeek Harness?

- **Open-Source-Agent-Harness von DeepSeek AI**, veröffentlicht am
  **13. August 2026 als v0.1 Developer Preview**, MIT-Lizenz, npm-Paket
  `@deepseek-ai/dsh`. Ausdrückliche Warnung im README: *"THERE WILL BE
  COMPATIBILITY-BREAKING CHANGES."*
- Kernidee: **"Everything is a plugin."** Es gibt keinen privilegierten
  Kern — Modell-Adapter, Tool-Registry, Session-Log und sogar der
  Agent-Loop selbst sind Plugins und per Konfiguration austauschbar.
- Basis ist **Cordis** (github.com/cordiverse/cordis), ein
  Plugin-/DI-Framework mit *reversiblen Effekten*: Plugins können zur
  Laufzeit gemountet, entladen und hot-reloaded werden, jede Registrierung
  wird beim Entladen sauber zurückgerollt. Design-Papier: *"A Programming
  Paradigm for Spatiotemporal Composability"*.
- DeepSeek positioniert es als **Agent = Model + Harness** — erschienen im
  Umfeld der V4-Modelle (V4-Pro GA 13.08., V4-Flash Public Beta 31.07.;
  beide 1M Kontext, bis 384K Output, OpenAI- und Anthropic-kompatible
  API, Thinking-/Non-Thinking-Modi, Context-Caching).
- Start: `npx @deepseek-ai/dsh web` → Web-UI auf `http://127.0.0.1:3080`.
  Node ^22.19 oder ≥24. Alles lokal (Sessions, Logs, Daten).
- Community: GitHub Discussions, Discord, GitHub-Topic `dsh-plugin` für
  Plugin-Discoverability.

## 2. Architektur in Kürze

### Cordis & Capability Seams
- Jede Fähigkeit ist ein **Seam** aus drei Rollen: *Service Definition*
  (abstrakte Klasse, besitzt `ctx.<key>` + Vokabular), *Service Provider*
  (Implementierungen), *Consumer* (meist das modellseitige Tool).
  Beispiel Shell: `dsh-shell` (Definition) / `dsh-bash-local`,
  `dsh-bash-sandbox` (Provider) / `dsh-tool-bash` (Consumer).
- ~30 Seams/Services, u. a.: `ctx.llm`, `ctx.tools`, `ctx.agents`,
  `ctx.sessions`, `ctx.subagents`, `ctx.jobs`, `ctx.workflowEngine`,
  `ctx.codeRuntime`, `ctx.sandbox`, `ctx.approval`, `ctx.fs`, `ctx.shell`,
  `ctx.terminals`, `ctx.skills`, `ctx.goals`, `ctx.compaction`,
  `ctx.spillStore`, `ctx.web`, `ctx.lsp`, `ctx.settings`,
  `ctx.credentials`, `ctx.storage`, `ctx.sessionQuery`,
  `ctx.sessionTelemetry`, `ctx.agentTeams` (experimentell).
- **Events in vier Dispatch-Modi** (`emit`, `waterfall`, `parallel`,
  `serial`); Policies hängen sich als Waterfall-Listener in
  `agent/pre-step`, `agent/request`, `tools/pre-execute`,
  `tools/execute`, `tools/post-execute`, `fs/write-intent` usw. ein.
- **Profile & Bundles**: Ein laufendes `dsh` ist ein Plugin-Baum, der beim
  Boot aus geordneten Patch-Schichten komponiert wird:
  Bundles (`dsh-base`, `dsh-web-app`, `dsh-headless`) → Profil-eigenes
  `cordis.patch.yml` → Home-Level-Patch (`~/.dsh/cordis.patch.yml`) →
  `--patch`-Overlays. Patches werden live überwacht (Hot-Reload).
  Inspektion: `dsh --profile web --dump-config`.
- Plugins installiert man mit `dsh plugin --profile <name> add <paket>`
  (delegiert an pnpm; auch `github:owner/repo`-Installs, Tarballs, Links).

### Session-Log als Source of Truth
- Jede Session ist ein **append-only Log typisierter Events**
  (`turn/*`, `step/*`, `user/message`, `assistant/chunk`,
  `assistant/message`, `tool/call`, `tool/result`, dazu ~40 log-only-Typen
  wie `approval/asked`, `sandbox/mode`, `goal/change`, `team/*`,
  `compaction/*`). Die Modell-Historie wird **aus dem Log abgeleitet**,
  nie separat gespeichert; ein Runtime-Invariant erzwingt
  "model-visible = logged".
- Persistenz-Backends: **JSONL** (Zstandard-komprimiert, Chunk-Packing
  ≈60 % kleiner) und **SQLite**; dazu Volltextsuche über Sessions
  (SQLite FTS), Projektionen mit Cold-Read-Cache, Fork/Resume,
  Crash-Recovery (offene Turns werden mit `interrupted` geschlossen,
  nicht abgeschnitten).

## 3. Die vier Run-Modi (Agent-Presets)

| Preset | Inhalt |
|---|---|
| **Standard** | Voller Coding-Agent: Datei-Editing, Shell, Datei-/Websuche, Skills, Plan-Modus, Goals, Subagents, Workflows, Todos, Kompaktierung. |
| **PTC / Code Mode** | Wie Standard, aber `mode: code`: Das Modell schreibt **ein TypeScript-Programm gegen ein generiertes SDK**, das der reservierte `run_code`-Transport ausführt — viele Tool-Calls kollabieren zu einem Roundtrip. Sub-Calls laufen trotzdem durch die volle Guard-/Approval-Pipeline (bis 10 parallel). |
| **Minimal** | Nur persistentes `bash` (bzw. `pwsh`) + `str_replace_editor` — die Benchmark-Komposition. |
| **Creation (Cordis)** | Wie Standard plus `cordis_*`-Tools: Der Agent kann **die eigene Laufzeit inspizieren und umbauen** (temporäre Plugins definieren, mounten, stoppen). Doku-Warnung: "Treat a session on this preset as shell access." |

Presets sind Verzeichnisse mit `agent.cordis.yml`; eigene Presets entstehen
per Copy-on-Write unter `~/.dsh/.agent-presets`. Umschalten der
Tool-Präsentation prozessweit via `DSH_TOOLS_MODE=native|code|both`.

## 4. Vollständiger Tool-Katalog (modellseitig, ~58 Tools)

- **Interaktion/Planung**: `ask_user_question` (blockierende Rückfragen
  mit Optionen/Multi-Select), `exit_plan_mode`, `todo_write`.
- **Code Mode**: `run_code` (reservierter Transport).
- **Shell/Terminal**: `bash`, `pwsh` (one-shot, `run_in_background`),
  persistente Varianten, `terminal_open/send/read/list/signal/close`
  (persistente PTY-Sessions pro Agent).
- **Dateisystem**: `read`, `write`, `edit`, `read_image`,
  `str_replace_editor`, `glob`, `grep` (gebündeltes ripgrep;
  Überlängen-Ergebnisse werden in Spill-Dateien ausgelagert).
- **Jobs**: `job_list`, `job_output`, `job_kill` — ein einheitlicher
  Controller für Hintergrund-Bash, PTY-Sends und Subagents.
- **Delegation**: `subagent` (continuable, Hintergrund-Default),
  `subagent_fork` (one-shot mit Kontext-Vererbung), `send_message`,
  `interrupt_agent`, `list_agents`, `report` (Kind → Eltern).
- **Agent Teams** (experimentell, standardmäßig aus): `spawn_teammate`,
  `wait_agent`, `followup_task`, `team_task_create/get/list/update`
  (geteilter Task-DAG mit CAS-Revisionen, Mailbox, Rollen Lead/Member).
- **Orchestrierung**: `workflow` (modellgeschriebene JS-Skripte mit
  `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`; Caps für
  Parallelität und Gesamt-Agentenzahl), `ralph` (Fresh-Agent-Schleife
  bis 64/256 Runden mit strukturierter Übergabe).
- **Ziele/Zeit**: `create_goal`, `get_goal`, `update_goal`
  (persistente Session-Ziele mit Runden-Limit, CAS, Phasen
  active/paused/blocked/complete); `schedule_create/list/delete`
  (session-lokale Reminder: einmalig oder alle ≥300 s).
- **Wissen**: `skill` (Skill-Katalog wie Claude-Skills: `SKILL.md` in
  `.dsh/skills`, `.agents/skills`, `~/.dsh/skills`; modell- und/oder
  user-invocable), `lsp` (goToDefinition, findReferences,
  goToImplementation, hover), `web_search` (DeepSeek/Exa/Perplexity),
  `web_fetch` (standardmäßig deaktiviert).
- **Session-Gedächtnis**: `session_search`, `session_event_search`,
  `session_event_read`, `session_event_trace`, `session_trace` —
  Volltextsuche und Lineage über alle bisherigen Sessions.
- **Selbstmodifikation** (nur Creation-Preset): `cordis_define`,
  `cordis_run`, `cordis_stop`, `cordis_undefine`,
  `cordis_inspect_list/query/self`.
- **MCP**: beliebige Server als `mcp__<server>__<tool>` (stdio +
  Streamable HTTP, Reconnect-Backoff); standardmäßig keiner aktiviert.

## 5. Subagents & Multi-Agent

- **Sechs Subagent-Provider**: `spawn` (frisch, in-process), `fork`
  (erbt Eltern-Kontext als Seed), `acp` (Agent Client Protocol),
  **`codex`** und **`claude-code`** (delegieren an OpenAI Codex bzw.
  Anthropic Claude Code — mitgeliefert, aber default aus), `dsh-sdk`
  (out-of-process dsh via JSON-RPC).
- **Continuable Children**: dauerhafte Kinder mit eigener Session, die
  kalt resumed werden können; `send_message` als Follow-up-Kanal,
  `report` mit Zustellung `quiet` oder `next-step`.
- Capability-Discovery pro Provider (`outputSchema`, `depthLimit`,
  `toolFilter`, `persona`), Delegationstiefe default 3, `toolFilter`
  mit allow/deny.
- **Agent Teams** (experimentell): impliziter Team-Lead (Root-Session),
  benannte dauerhafte Teammates, durable Mailbox, geteilter Task-DAG.
  Bekannte Grenzen laut Doku: ein Prozess, **ein gemeinsamer Checkout —
  keine Worktrees, keine Locks**; Write-Scopes nur advisorisch.
- **Hooks-Bridges**: `hooks-claude-code` und `hooks-codex` führen ein
  unverändertes Claude-Code-`hooks.json` bzw. Codex-Hooks aus
  (deny/ask werden respektiert, Input-Rewriting nicht).

## 6. Sicherheit: Sandbox, Approvals, Permission-Presets

- **Sandbox-Modi**: `read-only` (Default!), `workspace-write`,
  `danger-full-access`. Backends: bwrap/Landlock (Linux), Seatbelt
  (macOS), Restricted-Token/ACL (Windows, "partial"). Gilt nur für
  Datei-Effekte; Netzwerk und Prozess-Sichtbarkeit sind ausgenommen.
- **Approval-Policy**: `ask` (delegiert an UI/ACP-Answerer, fail-closed
  zu `unavailable`) oder `never` (deterministisches Reject für CI).
- **Permission-Presets** bündeln beides: `workspace-write` (= Sandbox
  workspace-write + ask, Default neuer Sessions) und
  `danger-full-access` (= full access + never); Wechsel per
  `/permission`, alles durabel im Session-Log.
- Tool-Pipeline: `tools/pre-execute` (allow/deny/ask) → Approval →
  monotone Guards (können nur verbieten, nie erlauben) → Ausführung →
  `tools/post-execute` (accept/block/replace). Argumente sind nie
  umschreibbar. Auch Code-Mode-Sub-Calls laufen komplett durch.
- Credentials: write-only Store `~/.dsh/.credentials.yaml`, Auflösung
  pro Request (Rotation ohne Neustart), Secrets nie im Settings-File.

## 7. Kontext-Management

- **Kompaktierung** (`compaction-basic`): automatisch bei 80 %
  Kontextfüllung (`thresholdRatio 0.8`, `retainRatio 0.16`),
  LLM-Zusammenfassung als Surface-`replace` mit "Shadow-Price"-Events
  (exakte Token-Buchführung des Ersetzten), Overflow-Recovery bei
  `CONTEXT_WINDOW_EXCEEDED`, manuell via `/compact`.
- **Tool-Result-Pruning**: deterministisches Head/Tail-Kürzen großer
  Tool-Ergebnisse (8192/4096/1024 Zeichen) vor der Summarization.
- **Spill**: übergroße Tool-Outputs landen verbatim in privaten Dateien;
  das Modell bekommt Preview + Pfad-Hinweis (`read`/`grep` zum Nachladen).
- **Token-Meter**: O(Surface)-Messung mit Usage-Anker aus dem letzten
  erfolgreichen Request.
- KV-Cache-Bewusstsein ist Doktrin: deterministische Prompt-Assembly
  (byte-identische SDK-Sektion bei unverändertem Tool-Set), jedes
  Paket-README muss eine "KV Cache effect"-Sektion haben.

## 8. Oberflächen & Schnittstellen

- **Web-UI** (Standard): Workspaces, Sessions (Rename/Archiv/Fork/
  Suche/Export), Modell-Picker mit Effort-Stufen, Plan-Chip, Goal-Bar,
  Todo-Leiste, Jobs-Popover, Subagent-Baum mit Token-/Dauer-Spalten,
  **Trajectory-Tab** (Event-Ledger mit Timeline, TTFT vs. Decoding,
  Token-Usage pro Record), Attachments (Bilder), Message-Feedback,
  Slash-Commands (`/compact`, `/plan`, `/permission`, `/goal`,
  `/feedback`, `/export`, `/model`, `/<skill>`), Themes, EN/中文.
- **Headless**: `dsh --profile headless "task"` — eine persistierte
  Session, finale Antwort auf stdout, Exit-Code 0/1.
- **Python SDK**: `pip install deepseek-harness-sdk` — bündelt die
  komplette Runtime (kein Node nötig), JSON-RPC über stdio,
  `DeepSeekHarness(...).run(prompt, session_id=...)`,
  `RunResult(final_response, finish_reason, events, ...)`. Auch die
  offizielle **Benchmark-Harness** (BENCHMARK.md verweist auf die
  `jsonrpc-agent`-Minimal-Komposition; keine publizierten Scores im Repo).
- **ACP-Server** (`packages/acp`): stellt dsh-Agenten über das **Agent
  Client Protocol** für programmatische Clients bereit (Sessions,
  Permissions, Cancellation) — z. B. Editoren wie Zed.
- **Modell-Provider**: nativer DeepSeek-Adapter (Default-Katalog
  V4 Flash, V4 Pro, V4 Flash Vision Exp; 1M Kontext, maxTokens 256K,
  Reasoning-Effort off/low/high/max) plus Multi-Provider-Routing
  (`llm-pi-ai`): Anthropic, OpenAI, Bedrock, Vertex, Azure, Codex-OAuth,
  eigene Gateways (OpenAI-/Anthropic-kompatibel), Compat-Schalter,
  Modell-Discovery. Wechsel ohne Neustart.
- **Telemetrie**: lokal per Default; opt-in OTLP-Export
  (`DSH_TELEMETRY_MODE=FULL|FEEDBACK_ONLY`), harter Opt-out
  (`DSH_TELEMETRY_DISABLED`), aber **keine Redaction-Regeln ab Werk**.

## 9. Relevanz für Vertragus

1. **Neuer Orchestrator-/Subagent-Provider-Kandidat.** dsh ist als CLI
   startbar (`dsh --profile headless "…"`), aber der Headless-Modus ist
   one-shot; für interaktive Vertragus-Terminals wäre die **ACP-Schnittstelle
   oder der JSON-RPC/stdio-SDK-Pfad** der saubere Andockpunkt — beides
   maschinenlesbar, mit Frage-/Permission-Events statt reinem TTY-Scraping.
2. **Konkurrenz-/Referenzarchitektur.** dsh löst dieselben Probleme wie
   der Vertragus-Harness-Kern, teils mit identischen Mustern:
   blockierende User-Fragen (`ask_user_question` ↔ `ask_user`),
   Subagent-Verifikation, Jobs-Registry, Goal-Runden (↔ Playbooks/Goals),
   Succession-ähnliches Ralph-Muster (frischer Kontext, strukturierte
   Übergabe — ↔ `request_succession`), Retro-/Telemetry-Ideen.
   Interessante Übernahme-Kandidaten: **Shadow-Price-Kompaktierung**,
   **Spill statt Truncation**, **Task-DAG mit CAS-Revisionen** (Agent
   Teams), **Session-Query-Tools** (Suche über alte Runs).
3. **Schwächen ggü. Vertragus**: Agent Teams laufen in *einem* Checkout
   ohne Worktrees/Locks (Vertragus: Worktree pro Agent + host-seitiges
   `integrate_branch`); keine sichtbaren Terminals pro Agent; Preview-
   Status mit angekündigten Breaking Changes.
4. **Modelle**: V4-Flash ist als billiges Subagent-Modell positioniert
   (Off-Peak $0.22/M in, $0.66/M out; Cache-Hits ~98 % billiger) —
   als Provider-Option für Vertragus-Slots unabhängig vom Harness
   interessant.

## 10. Quellen

- Repo (Primärquelle): https://github.com/deepseek-ai/deepseek-harness —
  README, `docs/architecture.md`, `docs/subsystems/*`, `docs/user/*`,
  `docs/tool-catalog.md`, `docs/config-catalog.md`, `apps/cli/reference/`,
  `python/sdk/`, `packages/*/README.md`, BENCHMARK.md.
- Offizielle Seite: https://deepseek.com/harness/en/
- MarkTechPost, 17.08.2026: "DeepSeek AI Releases DeepSeek Harness in
  Developer Preview" — https://www.marktechpost.com/2026/08/17/deepseek-ai-releases-deepseek-harness-in-developer-preview/
- The New Stack: https://thenewstack.io/deepseek-harness-open-source-plugins/
- AIbase: "DeepSeek Harness v0.1 Open Global Testing" — https://www.aibase.com/news/30343
- Habr: "Inside DeepSeek Harness: Cordis, Session Events, Tool Pipelines,
  and Permission Boundaries" — https://habr.com/en/articles/1070958/
- API-Changelog/Preise (V4-Pro/V4-Flash): https://api-docs.deepseek.com/updates/
