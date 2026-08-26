Deutsch | [English](RESEARCH-LANDSCAPE.md)

# Wettbewerbslandkarte: Tools in Vertragus' Nachbarschaft

Stand: 26. August 2026. Kein Code in dieser Änderung — eine Karte der
benachbarten Tools, worin sie stark sind, und welche ihrer Ideen zu
Vertragus wirklich passen.

Primärquellen: Produktseiten und Docs, GitHub-READMEs, dazu ein paar
Round-ups von 2026. Marketingtext ist eine Behauptung, keine Messung.
Filter für „lohnt sich" ist die Handbuch-Doktrin in
[`HANDBOOK-HARNESS.md`](HANDBOOK-HARNESS.md), keine generische
Agenten-Roadmap. Eine frühere, code-nahe Studie eines einzelnen
Harnesses steht in
[`RESEARCH-DEEPSEEK-HARNESS.md`](RESEARCH-DEEPSEEK-HARNESS.md).

---

## Wie diese Karte gezeichnet ist

Vertragus sitzt in einer jungen Kategorie, die vor einem Jahr noch
keinen stabilen Namen hatte. Round-ups nennen sie *Agentic Development
Environment*, *CLI-Orchestrator* oder *Agent-Kanban*. Die gemeinsame
Arbeit: du hast Coding-Agent-CLIs schon; das Produkt ist die Schicht,
die mehrere davon gleichzeitig fährt, ohne dass sie sich zertrampeln.

Drei Schichten, nicht ein Markt:

| Schicht | Was sie verkauft | Typische Namen |
| --- | --- | --- |
| **A. Desktop-CLI-Orchestratoren** | Worktrees, Terminals, Review, ein menschlicher Operator | Conductor, Emdash, Pane, Nimbalyst, Vibe Kanban, Claude Squad |
| **B. Sandbox- / Remote-Workspaces** | Isolation stärker als ein Verzeichnis, oder Rechenkraft nicht auf dem Laptop | Sculptor, OpenHands Agent Canvas, Mux, Warp |
| **C. Vendor-Harnesses** | Die CLI selbst wächst Teams, Cloud-VMs, Missions | Claude Code Agent Teams, Codex, Cursor Cloud Agents, Factory Droid, Copilot |
| **D. Cloud-native Agenten** | Ticket rein, PR raus, keine lokale CLI | Devin, Jules, Copilot-Cloud-Agent |

Vertragus ist **A mit einem Kern wie C**. Das Panel sieht aus wie
Conductor oder Pane. Die Schleife — blockierendes MCP, Host-Wahrheit
bei Git, Hub-and-Spoke-Identitäten, Succession, ein CAS-Task-Board —
ist näher an einem Harness als an einem Session-Multiplexer. Die
meisten A-Tools lassen Planung, Delegation und Merge-Entscheidung beim
Menschen. Vertragus legt das auf den Orchestrator, mit dem Host als
einzigem Pfad.

Das ist der Vergleich, der zählt. Feature-Checklisten, die „hat ein
Kanban" oder „hat Slack" als Sieg werten, verfehlen das Produkt.

---

## Was Vertragus schon ist (nicht noch einmal bauen)

Dinge, die Nachbar-Tools meistens noch nicht haben, und die dieses
Repo nicht als zweites Produkt nachbauen sollte:

- **Eine MCP-Schleife, echter Long-Poll.** `await_events` blockiert.
  Kein Busy-Wait, keine verhungernden Worker. Typisierte Events auf
  einer Cursor-Queue, plus On-Disk-Journal.
- **Host-Wahrheit vor Agenten-Prosa.** `inspect_agent` liest das
  Worktree; `agent_done` trägt Host-Fakten; `integrate_branch` ist ein
  Host-Merge; Worker committen nie; Promote ist ein Klick des Menschen
  (oder eine Profil-Automation, die trotzdem dieselben Host-Merges
  nutzt).
- **Hub-and-Spoke, kein Hive.** Subagenten und Leads reden nicht
  miteinander. Fan-in ist der Punkt. Tiefe ist gedeckelt (Lead, dann
  eine Helper-Ebene). Das Handbuch nennt Peer-to-Peer als Non-Goal.
- **Slots als Blueprint, keine vorstartete Crew.** Play startet den
  Orchestrator; der entscheidet, wen er spawnt, begrenzt durch Caps.
- **Ausdauer.** Succession (Root mit frischem Kontext, gleiches Team),
  ein CAS-Task-Board, das das überlebt, strukturierte `resultSchema`-
  Reports, Spill statt stiller Truncation, `search_runs`, Retros und
  Repo-Notes (kein RAG).
- **Der Mensch als Event.** `user_message`, `ask_user`, Frage-Badges
  auf Panel und Phone, Policy-Stufen
  `yolo` / `ask-user` / `ask-orchestrator`.
- **First-Party-`/browser`**, kein zweiter MCP-Server. Chromium-
  Extension am bestehenden Loopback-Listener.
- **Windows als primäre, owner-verifizierte Plattform.** Mehrere
  polierte Wettbewerber sind macOS-only.
- **Tailscale-Remote** mit einer Allow-List aus sieben Verben. Das
  Phone kann starten, steuern und Fragen beantworten; es kann keine
  Profile editieren und nicht promoten.

Benannte Grenzen, schon im README: unsignierte Downloads, kein
macOS-Release-Artefakt, Agenten laufen nicht in einer Sandbox. Der
Provider-Reseat mitten im Lauf ist nur Spec — siehe
[`MODEL-PROVIDER-SWITCH.md`](MODEL-PROVIDER-SWITCH.md).

---

## Kategorie A — Desktop-CLI-Orchestratoren

Das sind die nächsten Produkte. Sie wrappen dieselben CLIs, geben
jeder Session ein Git-Worktree und setzen einen Menschen vor eine
Flotte. Fast keines macht aus den *Agenten* ein koordiniertes Team;
der Mensch ist der Orchestrator.

### Conductor

[conductor.build](https://conductor.build/) — Melty Labs, nur macOS,
Closed Source, heute kostenlos, bezahlte Kollaboration geplant.
Rund 22 Mio. USD Series A. Die polierteste „viele Agenten, ein Mac"-
App in den Write-ups 2026.

**Was es ist:** parallele Claude-Code-, Codex-, Cursor- und
OpenCode-Sessions, jede in einem isolierten Workspace (Git-Worktree +
Branch). Das Produkt ist der Review-und-Merge-Schritt: Sidebar, Live-
Status, ein ernsthafter Diff-Viewer, PR-Seite mit Checks, Archiv.

**Was es ausmacht:** wenig Zeremonie. Setup-/Run-/Archive-**Skripte**
pro Projekt (`.conductor/settings.toml`), **Files-to-copy** für
gitignorierte Secrets (`.env`), ein Run-Button, der die App aus dem
Workspace startet, Linear als optionale Intake, ein Slash-Command
`/resolve-merge-conflicts`, eine Conductor-API. Workspace-Notizen in
einem gitignorierten `.context`-Ordner. Native Mac-Chrome.

**Was es nicht ist:** ein Multi-Agent-*Harness*. Du weist die Arbeit
zu. Keine blockierende MCP-Teamschleife, kein Host-`integrate_branch`-
Contract, keine Succession, keine Leads. Nur macOS — Vertragus'
Windows-first ist ein echter Gegenpunkt.

### Emdash

[emdash.sh](https://emdash.sh/) /
[github.com/generalaction/emdash](https://github.com/generalaction/emdash)
— YC W26, Apache-2.0, Electron, macOS / Windows / Linux. Vermarktet
als Agentic Development Environment.

**Was es ist:** 20+ CLI-Provider in einer Registry (Claude Code, Codex,
Amp, Cursor, Copilot, Gemini, Droid, OpenCode, Goose, Kimi, Kiro, Pi,
Cline, …), auto-erkannt. Jeder Task ist Worktree + PTY + Conversation
+ Review-State. Eingebaute Monaco-Diffs. `gh` für PRs **und
CI-Tracking**. Linear / Jira / GitHub / GitLab / Notion / Asana als
Ticket-Intake.

**Was es ausmacht:** ein **Worktree-Pool** (vorgehaltene Reserves,
Claim in ~0,5–1 s statt 3–7 s); **SSH-Remote-Execution**, damit die
Agenten auf einer größeren Maschine laufen; **Agent Skills**
(`agentskills.io`), synchronisiert in jedes Vendor-Skills-Verzeichnis;
Preserve-Patterns für `.env` und `.claude/**`; provider-agnostischer
Spawn (Flags, Keystroke-Injection, Session-Id, Resume).
Bring-your-own-Infra Setup-/Teardown-Skripte.

**Was es nicht ist:** ein Orchestrator, der *selbst* Teammitglied ist.
Emdash ist Mission Control für unabhängige Tasks. Kein Host-Truth-
Merge-Gate, keine blockierende Event-Schleife zwischen Agenten, keine
Succession. Automatisches Push-on-Create ist das Gegenteil von
Vertragus' Regel „Worker committen nie / pushen nie".

### Pane

[runpane.com](https://runpane.com/) /
[github.com/dcouple/Pane](https://github.com/dcouple/Pane) — AGPL-3.0,
Electron, Windows / macOS / Linux first-class. Keyboard-first („Vim
for agent management"). Agent-agnostisch: wenn es eine CLI ist, ist
es ein Pane.

**Was es ist:** Pane anlegen → Worktree + Agent + Prompt. Eingebauter
Diff, File-Explorer, Commit / Push / Rebase / Squash / Merge per
Shortcut. Eine `runpane`-CLI, damit ein Agent weitere Panes spawnen
kann. Remote Pane: selbst gehosteter Daemon auf Loopback, exponiert
über Tailscale Serve (oder einen expliziten Tunnel), Desktop *oder*
Phone-PWA.

**Was es ausmacht:** **Port-Ranges pro Pane**, damit fünf
`localhost:3000`-Dev-Server nicht kollidieren; **automatisches
Secrets-Copy** in jedes Worktree; **Cross-Pane-`@`-Mentions**, um die
Ausgabe eines anderen Terminals in den aktuellen Prompt zu ziehen;
Session-Persistenz; Windows als First-Class-Markt, nicht als Restposten.

**Was es nicht ist:** ein koordiniertes Team. Isolation und Operator-UX,
kein Hub-and-Spoke-Contract. Delete-Pane-löscht-Worktree ist
Autodelete — ein benanntes Vertragus-Non-Goal. Remote ist näher an
„die ganze ADE lebt auf einer anderen Box" als an Vertragus'
Phone-Gateway mit sieben Verben.

### Nimbalyst

Früher Crystal. [nimbalyst.com](https://nimbalyst.com/) — MIT Desktop
+ iOS, Claude Code / Codex first-class, OpenCode und Copilot in
Alpha. Sessions auf einem Kanban, One-Click-Worktrees, Inline-File-
Review, verknüpfte Dateien und Sessions, visuelle Editoren (Markdown,
Mockups, Diagramme). Native **iPhone**-App für Diffs und Resume.
Teams-SKU.

**Was es ausmacht:** die Operator-Oberfläche ist ein *Workspace über
dem Harness* — Planungsartefakte und Sessions an einem Ort — plus die
einzige native Phone-App in dieser Liste. Vertragus' Remote-Client
ist eine PWA im Tailnet, kein App-Store-Binary.

**Was es nicht ist:** Host-seitige Orchestrierung. Das Board ist für
Menschen.

### Vibe Kanban

[github.com/BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)
(rund 28k Stars) / [vibekanban.com](https://vibekanban.com/) —
Apache-2.0, `npx vibe-kanban`. Die Firma dahinter hat am 10. April
2026 geschlossen; das lokale Tool läuft als Community-OSS weiter.
Bezahlte Cloud ist weg.

**Was es ist:** das reinstes *Agent-Kanban*. Issues → Workspaces
(Branch + Terminal + **Dev-Server**) → Inline-Diff-Kommentare zurück
an den Agenten → **In-App-Browser-Preview** (Devtools, Inspect,
Geräte-Emulation) → PR. 10+ Agenten (Claude Code, Codex, Gemini,
Copilot, Amp, Cursor, OpenCode, Droid, Qwen Code, …). Zentrale
MCP-Config. SSH, wenn das Board selbst auf einer Remote-Box läuft.

**Was es ausmacht:** Review-als-Produkt, inklusive *die laufende App
sehen*, nicht nur den Diff. Sub-Issues. Issue-Tracker in Teamform.

**Was es nicht ist:** eine lebende Firma, und kein Harness. Das
Handbuch nennt „Kanban als zweites Orchestrierungsprodukt" als
Non-Goal; Vertragus hat schon ein Host-Task-Board (`task_*`, CAS),
das *keine* Planungs-UI für Menschen ist.

### Terminal-native Manager

- **Claude Squad** ([smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad),
  AGPL-3.0, ~8k Stars): tmux + Worktrees + ein TUI. Claude Code, Codex,
  Gemini, OpenCode, Amp, Aider. YOLO-Flag. Review vor dem Anwenden.
  Der schlanke Default, wenn du in tmux lebst.
- **Agent-Manager** ([YoanWai/agent-manager](https://github.com/YoanWai/agent-manager),
  MIT, Go): tmux-Sessions, die den Manager-Quit überleben. Full-File-
  Diff mit **Zeilenkommentaren, die zurück in das Pane gehen**.
  Resource-Gauges (CPU / RAM / Disk / Netz) pro Process-Tree.
  Prompt-Injection ohne Attach.
- **Paneflow**: GPU-natives Multi-Pane-Terminal, Branch-aware,
  agent-agnostisch. Ein Control Room, kein Board.
- **abtop** ([graykode/abtop](https://github.com/graykode/abtop)): kein
  Manager — `htop` für Coding-Agenten. Token-Verbrauch, Context-Window-
  Füllstand, Rate-Limits, Child-Prozesse, offene Ports. Ergänzt jedes
  Tool in dieser Liste, einschließlich Vertragus.

### Andere ADE-Desktops

- **Daintree** ([daintreehq/daintree](https://github.com/daintreehq/daintree)):
  viele Terminals × viele Worktrees, Action-Palette (300+ Aktionen),
  **einen Prompt an N Agenten broadcasten**, Context-Injection, ein
  Assistant, der die Palette aus deiner bestehenden CLI fährt, und ein
  **MCP-Server mit Auth pro Stufe, Audit-Log und Idempotenz**, damit
  Agenten Daintree aufrufen können. Nächster Cousin zu „der Host ist
  ein Tool".
- **Codeg** ([codeg.app](https://docs.codeg.app/guide/git)): Sessions
  vieler CLIs aggregieren; `@mention` eines anderen Agenten in den
  aktuellen Thread (Claude + Codex nebeneinander); unbeaufsichtigtes
  To-do-Board mit Worktrees; natives iOS/Android; ACP-kompatible
  Agenten; ein echter Git-Client (Commit / Stash / Rebase aus der UI).
- **MindFlock**: Electron + tmux + Worktrees, geführtes Commit → Push →
  PR → Merge, **Ticket-Ingestion** (Shortcut, Jira, Linear, GitHub,
  Asana), die *automatisch* eine geseedete Session pro Ticket startet.
- **Superset** ([superset.sh](https://superset.sh/)): macOS (Linux-
  AppImage experimentell), beliebige CLI, Worktrees, persistente
  Terminals, **geplante Automationen**, TypeScript-SDK, **MCP-Server**,
  um die ADE von einem anderen Agenten zu fahren. Windows noch nicht.
- **Golutra**: Tauri, „one person, one AI squad", Prompt-Injection in
  Terminal-Streams, Workflow-Templates, BSL 1.1. Roadmap: CEO-Agent,
  Mobile-Remote.
- **Opcode** (früher Claudia): Claude-Code-GUI, Background-Agenten.
  Entwicklung eingeschlafen — gelistet, damit es nicht für eine
  lebendige Wette gehalten wird.

---

## Kategorie B — Sandbox- und Remote-Execution-Workspaces

Worktrees isolieren *Dateien*. Sie isolieren keine Prozesse, Ports,
`node_modules` oder ein durchgegangenes `rm`. Diese Schicht nimmt das
als das eigentliche Problem.

### Sculptor

[imbue.com/product/sculptor](https://imbue.com/product/sculptor) /
[github.com/imbue-ai/sculptor](https://github.com/imbue-ai/sculptor)
— MIT, Imbue. Jeder Agent in einem **Docker- / Devcontainer** mit
eigenem Dateisystem und Git. Lokales Repo unberührt, bis du pullst.

**Was es ausmacht:** **Pairing Mode** (Container in die IDE spiegeln,
Zwei-Wege-Sync, danach den Original-Checkout wiederherstellen);
gecachte Devcontainer-Images, damit der Start Sekunden dauert, nicht
Minuten; CI-Babysitter (Agent auf eine rote Pipeline schicken);
Agenten von einem Punkt in der Session-History forken; Pi als
tauschbarer Harness; Skills, die als volle Agenten laufen. Merge-
Review-UI für Pull/Push zwischen Container und Host.

**Warum das für Vertragus zählt:** das README nennt schon „Agenten
laufen nicht in einer Sandbox". Sculptor ist der Existenzbeweis, dass
parallele Coding-Agenten *vom Host-FS fernbleiben* und trotzdem
reviewbar sein können. Pairing Mode ist ein besseres „öffne die Arbeit
dieses Agenten in meinem Editor" als ein PTY zu fokussieren.

### OpenHands Agent Canvas

[openhands.dev/product/canvas](https://www.openhands.dev/product/canvas)
— lokaler visueller Workspace, MIT-Kern. Parallele Worktrees. Verbindet
OpenHands *oder* Claude Code / Codex / Gemini CLI über das **Agent
Client Protocol** (ACP: JSON-RPC auf stdio). Backends: Laptop, Remote-
VM, OpenHands Cloud, Kubernetes. Automationen auf Slack / GitHub /
Cron. MCP- + Agent-Skills-Bibliothek.

**Was es ausmacht:** ACP als *zweiten Attach-Dialekt* neben MCP.
Vertragus special-cased schon Claude / Codex / Kimi / Cursor / Grok /
Pi / Sentinel. ACP ist der entstehende Standard „Editor ↔ Coding-
Agent" (Zed, Copilot CLI, Canvas, dsh). Ein Dialekt hier würde Agenten
abdecken, die nie Vertragus-MCP sprechen werden.

### Warp und Mux

- **Warp**: ein agentisches Terminal, das Third-Party-CLIs auto-erkennt
  (Claude Code, Codex, OpenCode, Amp, Copilot, Cursor, Gemini, Droid,
  Pi, Goose, …) und sie mit einem reichen Input-Editor, **Desktop-
  Notifications**, **Inline-Code-Review-Kommentaren**, Remote Control
  und Tab-Metadaten umhüllt. Kein Worktree-Manager — besseres Glas um
  eine (oder mehrere) CLIs. Das Notification- + Inline-Comment-Muster
  ist die portable Idee.
- **Mux** (Coder): lokale / Worktree- / **SSH**-Execution unter einer
  UI, eigener Multi-Model-Agent-Loop, Desktop + Browser. Für Teams,
  die Agenten auf Servern wollen, nicht nur auf Laptops.

---

## Kategorie C — Vendor-Harnesses, die jetzt Teams mitliefern

Das sind weniger Alternativen zum Panel als die CLIs, die Vertragus
schon fährt — und die ihre *eigenen* Multi-Agent-Geschichten
wachsen. Werden sie gut genug, braucht es keine dünne ADE. Bleiben
sie Single-Vendor, hat ein Panel, das sie mischt, weiter einen Job.

### Claude Code Agent Teams

Experimentell (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). Eine Lead-
Session plus 2–16 Teammates, jeder mit vollem Context-Window und
eigenem Worktree. Geteilte Task-Liste unter `~/.claude/tasks/`.
**Mailbox `SendMessage` — Peer-to-Peer**, inklusive Broadcasts.
Teammates laden CLAUDE.md, MCP und Skills unabhängig. Bekannte
Grenzen bei Resume, Task-Koordination und Shutdown. Token-Verbrauch
ist ein Mehrfaches einer Einzel-Session.

Subagenten (das `Agent`-Tool) bleiben der günstige Parent-Child-Pfad.
Teams sind der Hive.

**Kollision mit der Doktrin:** Peer-to-Peer ist ein benanntes
Vertragus-Non-Goal. Der interessante Diebstahl ist nicht die Mailbox;
es ist Worktree-pro-Teammate *innerhalb eines Vendors* plus geteilte
Task-Liste. Vertragus hat beides schon, host-seitig, über Vendoren
hinweg.

### Codex

CLI + App + IDE + Cloud. TOML-definierte Subagenten, pfadbasierte
Adressierung, Batch. Eingebaute Worktrees und Cloud-Environments.
Skills, Automationen, OS-Level-Sandboxing, Approval-Gates, RBAC in
der Enterprise-Story. Ultra- / Parallel-Modi halten die Koordination
im OpenAI-Harness.

**Steal:** Sandbox-Defaults, die *nicht* YOLO sind; Cloud als
Execution-Backend statt als zweites Produkt; Automationen, die trotzdem
in einem PR enden, den der Mensch reviewt.

### Cursor Cloud Agents

Isolierte VMs mit vollem Desktop. Agenten klicken mit der Maus, fahren
einen Browser, laufen Tests, öffnen PRs, hängen **Video-Artefakte** an.
Multi-Repo-Environments. MCP (inklusive eines Cloud-MCP für Run-
Diagnostik). Trigger: Editor, cursor.com/agents, Slack `@Cursor`,
GitHub `@cursor`, Linear, API, Automationen (Schedule, PagerDuty,
Webhooks). Remote-Desktop mit dem Agenten hin- und hergeben. Secrets,
Egress-Allow-Lists, Tailscale in private Netze.

Vertragus hat schon eine Chromium-Extension gegen den *User*-Browser.
Cloud Agents haben einen *wegwerfbaren* Desktop. Andere Safety-Story,
andere Kosten.

### Factory Droid und GitHub Copilot

- **Factory Droid**: Coordinator + Spezialisten-Droids (Code, Review,
  Test, Docs, Knowledge) + Custom Droids. Missions (`droid exec
  --mission`). Linear/Jira als first-class Intake. OS-Sandbox
  (Dateisystem + Netzwerk-Proxy) mit vererbter Policy für Subagenten
  und Hooks. `--worktree`, `--auto low|medium|high`, Skills, Hooks,
  `AGENTS.md`. Headless-CI. Droids posten zurück aufs Ticket.
- **GitHub Copilot**: Cloud-Agent (Issue / Kommentar → Branch → PR →
  an Review iterieren). Desktop-Copilot-App: parallele Sessions, lokale
  Worktrees, Cloud-Sandboxes, Automationen, Canvases. Tiefste GitHub-
  Enterprise-Controls. Copilot CLI spricht ACP.

### DeepSeek Harness

Schon untersucht in [`RESEARCH-DEEPSEEK-HARNESS.md`](RESEARCH-DEEPSEEK-HARNESS.md).
Phase G hat Spill, Quiet-Events, `resultSchema`, das CAS-Board und
`search_runs` übernommen. Noch nicht übernommen und weiter interessant:
OS-Sandbox + Permission-Presets, Shadow-Price-Kompaktierung /
Token-Meter, ACP-Server, LSP-Tools, Code Mode (`run_code`), Session-FTS,
Plugin-Seams. Agent Teams in dsh teilen sich *einen* Checkout —
schwächere Isolation als Vertragus.

---

## Kategorie D — Cloud-native Agenten

**Devin** (Cognition): isolierte Maschinen, Playbooks, Org-Knowledge,
Child-Sessions, Schedule, APIs. Am besten auf klar geschnittenen
Backlog-Tickets; schwach bei unscharfem Pair-Work. Reviewer-Latenz ist
der Flaschenhals.

**Google Jules**: ephemere Cloud-VMs, GitHub-integriert oder
„repoless" (ein vorkonfiguriertes Runtime als Serverless-Funktion).
SDK `jules.all()` für Fleets mit begrenzter Parallelität. Plan-
Approval. Kein lokaler CLI-Wrapper.

Die konkurrieren um *delegierte* Arbeit, nicht um „ich schaue sechs
PTYs auf meinem PC". Vertragus soll keinen Cloud-Runner wachsen
(Handbuch-Non-Goal). Es soll die beste *lokale, Mixed-Vendor,
Host-Truth*-Schleife bleiben — und Review plus Isolation gut genug
machen, dass man für Alltagstasks nicht zu Devin geht.

---

## Feature-Vergleich

| Fähigkeit | Vertragus heute | Häufig bei Nachbarn |
| --- | --- | --- |
| Mixed-Vendor-CLI-Wrap | Ja (6 Presets + Custom + Pi-Wrap) | Emdash 20+, Pane jede CLI, Warp 14+ |
| Worktree pro Agent | Ja, Pflicht, kein Autodelete | Fast universell in A |
| Blockierende MCP-Teamschleife | **Ja — unverwechselbar** | Selten (Daintree/Superset exponieren MCP *der ADE*; dsh/Claude Teams sind Single-Vendor) |
| Host-Truth Inspect / Snapshot-Commit / Integrate | **Ja — unverwechselbar** | Review-UIs; Merge ist meist ein menschlicher Git-Klick |
| Hub-and-Spoke + Leads + 1 Helper-Ebene | **Ja — unverwechselbar** | Claude Teams sind P2P; die meisten ADEs haben gar kein Team |
| Succession + CAS-Task-Board + strukturierte Reports | **Ja — unverwechselbar** | Geteilte Task-Listen gibt es; wenige überleben eine Root-Transplantation |
| Visueller Diff / Inline-Kommentare zurück an den Agenten | Overlay + `inspect_agent`; kein Monaco-Review-Pane | Conductor, Emdash, Pane, Vibe Kanban, Warp, Agent-Manager |
| In-App-Preview der laufenden App | Chromium-*Worker-Tools*, keine Panel-Preview | Vibe Kanban eingebauter Browser |
| Worktree-Readiness (.env-Copy, Install-Skript, Ports) | Keine first-class Setup/Run-Skripte; kein Port-Pool | Conductor-Skripte, Pane Ports+Secrets, Emdash Preserve-Patterns |
| Sandbox / Container | **Benannte Lücke** | Sculptor Docker, Factory-OS-Sandbox, Codex-OS-Sandbox, dsh bwrap/Seatbelt |
| Token- / Cost- / Context-Window-Meter | Nur Wall-Clock `maxRuntimeMin` | abtop, dsh Token-Meter, Agent-Manager-Gauges |
| CI-Status auf dem PR, den der Host geöffnet hat | Automation kann einen PR öffnen; kein Checks-Feed | Conductor Checks, Emdash CI-Tracking, Sculptor CI-Babysitter |
| Issue-Tracker-Intake | Nein | Emdash, Conductor, MindFlock, Factory, Cursor, Copilot |
| Skills-Standard (`agentskills.io`) | Pro-CLI nativ, kein Host-Katalog | Emdash-Sync, OpenHands-Bibliothek, Factory Skills, dsh Skills |
| ACP-Dialekt | Nein (MCP + Sentinel + Pi) | OpenHands, Copilot CLI, dsh, Codeg |
| Remote: Phone-Steer | Tailscale + 7 Verben | Pane-Daemon, Nimbalyst iOS, Emdash SSH-*Execution* |
| Same-Task-A/B (zwei Modelle, einen Sieger wählen) | Von Hand möglich (`start_agent` zweimal) | Emdash „mehrere Agenten auf demselben Problem", Sculptor-Fork |
| Desktop-Notifications | Nein | Warp, CodeAgentSwarm |
| Signierter macOS-Download | Nein (siehe [`SIGNING.md`](SIGNING.md)) | Conductor, Nimbalyst, Warp |
| Default-YOLO | Ja (Stufe `yolo`) | Codex/Factory default enger; Sculptor nie auf dem Host-FS |

---

## Lücken, die sich zu schließen lohnen

Sortiert nach Passung zur bestehenden Schleife. Neue Kraft kommt weiter
als **Host-Tool, Event oder Panel-Oberfläche**, nicht als zweites
Produkt.

### Hohe Passung — Host-Tools in der bestehenden Schleife

1. **Review-Oberfläche (der Operator-Flaschenhals).** Jede ernsthafte
   ADE behandelt Diff-Review als das Produkt. Vertragus hat Host-Fakten
   und `inspect_agent`, aber der Mensch liest immer noch ein PTY oder
   ein rohes Diffstat. Ein Panel- (und Phone-) Diff des Agent-Worktrees,
   mit Inline-Kommentaren als `user_message` / `send_to_agent` — ein
   Host-Pfad, kein zweites Gehirn in der TUI — ist die UX-Lücke mit dem
   größten Hebel. Warp und Agent-Manager pipen Zeilenkommentare schon
   zurück in den Agenten; Vibe Kanban tut es vom Board.

2. **Worktree-Readiness.** Parallele Agenten, die `pnpm dev` nicht
   können, weil `.env` und `node_modules` und Port 3000 auf dem Main-
   Checkout leben, sind theoretisch isoliert und praktisch fest.
   Conductors Setup/Run/Archive-Skripte, Panes Port-Ranges und Secrets-
   Copy, Emdash' Preserve-Patterns: das ist Host-Arbeit, nicht
   Orchestrator-Cleverness. Ein profilweites „kopiere diese
   gitignorierten Dateien, lauf dieses Setup, vergiss einen Port-Block"
   würde Isolation *lauffähig* machen. Danach das Worktree nicht
   autodeleten.

3. **Sandbox (schon eine benannte README-Grenze).** Worktrees sind
   keine Security-Boundary. Factory und dsh zeigen OS-Level-FS/Netz-
   Sandboxes um die CLI; Sculptor zeigt Container plus einen Pairing-
   Pfad zurück in den Editor. Eine erste Version kann opt-in sein,
   Linux zuerst (bubblewrap / landlock), fail-closed, an Helper vererbt.
   Das macht die Stufe `yolo` ehrlich: YOLO in einer Sandbox ist eine
   andere Bedrohung als YOLO auf dem Host.

4. **Token-, Kontext- und Spend-Signale.** Das Runtime-Budget ist eine
   Wanduhr. abtop und dsh beweisen, dass der Operator auch Context-
   Füllstand, Rate-Limit und Spend braucht. Schon ein read-only Host-
   Snapshot (Process-RSS, letzte Usage der CLI falls sie eine
   exponiert, offene Ports) würde „warum brennt diese Maschine" aus
   einem Ratespiel machen. Keinen Token-Oracle erfinden; messen, was
   Prozess und Vendor schon zugeben.

5. **CI auf dem PR, den der Host schon öffnet.** Automation kann einen
   GitHub-PR öffnen. Conductor und Emdash *watchen* danach Checks. Ein
   `ci_status`-Event (und ein Card-Badge) ist Host-Wahrheit, dieselbe
   Familie wie `inspect_agent`. Sculptors CI-Babysitter — bei Rot einen
   Worker spawnen — ist ein Playbook obendrauf, keine neue Schleife.

6. **C7 Reseat.** Spec existiert schon. Nachbarn wechseln Modelle
   mitten in der Session als Table Stakes (Sculptor/Pi, dsh, jede
   Vendor-TUI `/model`). Rate-Limits und „falsches Modell für diese
   Phase" sind der Grund, warum Leute ganze ADEs neu starten.

7. **Mehr Presets, dasselbe Schema.** Gemini CLI, OpenCode, Amp,
   Copilot CLI, Droid, Qwen Code tauchen in jeder ADE-Matrix auf.
   Vertragus behandelt Provider schon als Daten. Presets ausliefern
   ist keine neue Architektur — es ist Coverage. ACP als *Attach-
   Dialekt* (neben Claudes Config-File und Codex `-c`) ist die eine
   strukturelle Ergänzung, und nur für CLIs, die es sprechen.

8. **Desktop- / Phone-Notifications auf `ask_user`, `agent_done`,
   `orchestrator_idle`.** Warps ganzer Pitch fürs Wrappen von CLIs ist
   „ping mich, wenn es stoppt". Die Events existieren schon.

### Mittlere Passung — nützlich, Doktrin im Blick

- **Issue-Tracker-*Seed*, kein zweiter Tracker.** Emdash/MindFlock/
  Factory ziehen Linear/Jira/GitHub in den ersten Prompt. Ein Playbook
  oder ein `workspaces:start {goal}`, das den Issue-Body einfügt, liegt
  im Rahmen. Auto-Spawn einer Session pro Ticket, oder selbst Issue-
  Tracker zu werden, ist das Kanban-als-Produkt-Non-Goal.
- **SSH- / Remote-*Execution*** (Agenten laufen auf einem Mac mini oder
  GPU-Kasten; das Panel ist ein Thin Client). Anders als der heutige
  Tailscale-*Control*-Pfad. Pane und Emdash tun das. Das ist ein
  Backend für Workspace, kein neues MCP. Allow-List behalten; das
  Internet nicht öffnen.
- **In-Panel-Preview.** Vibe Kanbans eingebetteter Browser ist die
  QA-Schleife, die Menschen wirklich nutzen. Vertragus fährt den User-
  Chromium schon über `/browser`. Eine host-vergebene Preview-URL
  (aus dem Port-Block in (2)) auf der Card ist kleiner als einen
  Browser einzubetten, und bleibt ein Pfad.
- **Same-Task-A/B als Host-Operation.** „Start zwei Worker auf diesem
  Task, verschiedene Provider, ich promote einen" sind zwei
  `start_agent`s plus eine Review-Oberfläche. Keine DAG-Engine
  dazubauen.
- **Agent-Skills-Katalog auf Host-Ebene.** Emdash' `~/.agentskills/`-
  Sync ist Bequemlichkeit, keine Orchestrierung. Als Profil-Extra in
  Ordnung; kein RAG-Index.
- **Worktree-Pool.** Emdash' Reserve-Worktrees sind ein Latency-Trick.
  Lohnt erst, wenn Setup-Skripte existieren — ein leeres gepooltes
  Worktree fehlt trotzdem `node_modules`.
- **Headless- / CI-Spawn.** `droid exec`, `dsh --profile headless`,
  Jules `jules.run`. Vertragus hat schon `VERTRAGUS_DEV_RUN`. Ein
  dokumentiertes Non-UI-Play, das trotzdem die MCP-Schleife nutzt, ist
  charakterlich; eine Cloud-Flotte nicht.

### Bewusste Non-Goals — attraktiv, trotzdem draußen

Aus dem Handbuch kopiert, damit ein glänzendes Competitor-Feature nicht
aus Versehen ein Track wird:

- Peer-to-Peer zwischen Subagenten oder Leads (Claude Agent Teams,
  Codeg-`@mention` als *Team-Bus*, dsh experimentelle Teams).
- Kanban / DAG-Engine / Cloud-Runner als **Produkt**.
- Autodelete von Worktrees (Panes Delete-Pane-räumt-auf).
- RAG.
- Orchestrator, der selbst committed, merged, testet oder pusht.
- Vorstartete Crews (Playbooks bleiben Goal-Templates).
- Ein zweiter MCP-Server, ein zweites Remote, das alle IPC spiegelt,
  Tunnels und ein Account-System, Vendor-TUIs parsen.

Daintrees „MCP der ADE" ist die verführerische Variante einer zweiten
Orchestrierung: Agenten rufen 300 Host-Aktionen auf. Vertragus hat
schon entschieden, dass die Allow-List klein bleibt und der Host die
einzige Git-Hand ist. Extra-MCP auf *Workern* ist die bestehende
Notluke.

---

## Vorgeschlagene Reihenfolge (kein Code in dieser Änderung)

Wenn eine spätere Änderung etwas davon umsetzt, single-topic halten
und in der Schleife bleiben:

1. **Review-Oberfläche** — Panel/Phone-Diff aus Host-Git, Kommentare als
   `user_message`. Entblockt (5) und A/B.
2. **Worktree-Readiness** — gitignorierte Dateien kopieren, Setup-Skript,
   Port-Block. Macht Isolation real.
3. **Notifications** auf Events, die schon existieren.
4. **CI-Status** auf host-geöffneten PRs.
5. **C7 Reseat** (Spec ist fertig).
6. **Sandbox opt-in** (Linux zuerst).
7. **Presets + ACP-Dialekt** als Coverage, kein Rewrite.
8. **Token/Kontext-Snapshot** als Host-Fakten, kein geratener Zähler.

Diese Reihenfolge ist Operator-Schmerz zuerst, Safety zweitens,
Coverage drittens — dieselbe Sequenz, auf die sich Conductor, Pane und
Sculptor versehentlich einigen, ausgeführt mit Vertragus'
Host-Truth-Regeln statt mit ihren „der Mensch ist der Orchestrator"-
Regeln.

---

## Quellen

Produkte und Docs (abgerufen 26. August 2026):

- [conductor.build](https://conductor.build/) und
  [Conductor-Docs](https://www.conductor.build/docs)
- [emdash.sh](https://emdash.sh/) und
  [Emdash-Introduction](https://generalaction-emdash-14.mintlify.app/introduction)
- [Pane](https://github.com/dcouple/Pane), [runpane.com](https://runpane.com/)
- [Nimbalyst](https://nimbalyst.com/)
- [Vibe Kanban](https://github.com/BloopAI/vibe-kanban)
- [Claude Squad](https://github.com/smtg-ai/claude-squad)
- [Sculptor](https://imbue.com/product/sculptor)
- [OpenHands Agent Canvas](https://www.openhands.dev/product/canvas)
- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [Cursor Cloud Agents](https://cursor.com/docs/cloud-agent)
- [Factory Droid CLI](https://docs.factory.ai/cli/droid-exec/overview)
- [Warp Third-Party-CLI-Agenten](https://docs.warp.dev/agents/cli-agents/overview/)
- [GitHub Copilot Agents](https://docs.github.com/en/copilot)
- [Jules SDK](https://github.com/google-labs-code/jules-sdk/)
- [Daintree](https://github.com/daintreehq/daintree)
- [DeepSeek-Harness-Notizen](RESEARCH-DEEPSEEK-HARNESS.md)

Round-ups als Pointer genutzt, dann gegen die Produkte geprüft:

- [Augment: 9 Open-Source-Agent-Orchestratoren](https://www.augmentcode.com/tools/open-source-agent-orchestrators)
- [Nimbalyst: beste Agent-Management-Tools 2026](https://nimbalyst.com/blog/best-agent-management-tools-2026/)
- [Developers Digest: Agent-Manager, Pane, Golutra](https://www.developersdigest.tech/blog/multi-agent-cli-orchestration-tools-compared-2026)
