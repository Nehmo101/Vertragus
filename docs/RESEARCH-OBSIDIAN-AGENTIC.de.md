Deutsch | [English](RESEARCH-OBSIDIAN-AGENTIC.md)

# Research: Obsidian und agentische Entwicklung

Stand: 25. August 2026. Landschaftsscan, wie Coding-Agenten (Claude
Code, Codex, Pi, Grok Build, OpenCode, Cursor Agent) an
Obsidian-Vaults angebunden werden — Plugins, MCP, Skills,
Memory-Dateien und die zwei Jobs, die ständig vermischt werden.
Zweck: das Muster auf Vertragus **wie er heute im Code steht**
abbilden, ohne ein PKM-Produkt zu starten.

Das ist kein Produkt-Track. Es kommen keine Tools, Rollen oder
MCP-Fläche hinzu. Begleitender Video-Deepdive (Eero Alvar):
[`RESEARCH-OBSIDIAN-AI-SECOND-BRAIN.md`](./RESEARCH-OBSIDIAN-AI-SECOND-BRAIN.md).
Schwesterprodukt (UWE ist bereits das Obsidian-förmige Wissens-OS):
[`RESEARCH-UWE-KNOWLEDGE.md`](./RESEARCH-UWE-KNOWLEDGE.md).
Doktrin: [`HANDBOOK-HARNESS.md`](./HANDBOOK-HARNESS.md). Historische
Plugin-Recherche: [`RESEARCH-DEEPSEEK-HARNESS.md`](./RESEARCH-DEEPSEEK-HARNESS.md).

---

## Zweck

Mitte 2026 deckt die Phrase „Obsidian + Agenten“ mindestens vier
Architekturen, zwei Produkt-Jobs und eine wiederkehrende Fußangel
ab (Git-Worktrees *in* einem Vault, den Obsidian beobachtet). Der
Scan unten ist eine Karte, keine Einkaufsliste. Quellen sind
öffentliche Repos, Plugin-Verzeichnisse, Hersteller-Doku und ein
paar weit kopierte Setup-Texte. Star-Zahlen und Plugin-Namen
verrotten; die *Jobs* nicht.

---

## Die zwei Jobs, die ständig vermischt werden

| Job | Was der Vault ist | Was der Agent tut |
| --- | --- | --- |
| **A — das PKM betreiben** | Das Working Directory | Notizen lesen, ablegen, verlinken, zusammenfassen, tutorieren |
| **B — den Coder erinnern** | Sidecar-Gedächtnis für *andere* Git-Repos | Stack-Vorlieben, Repo-Karten, Entscheidungen laden; dann woanders code |

Alvars Garage (Video A im Begleitdokument) ist Job A. Raillys
*agent-brain* und TheFancyRobots `.agent-vault/` in einem Code-Repo
sind Job B. OpenClaws `MEMORY.md` / `USER.md` / `SOUL.md` ist Job B
mit Personal-Agent-Haut. Die meisten Blogposts verkaufen beides als
ein „Second-Brain-OS“. Sind sie nicht.

Vertragus ist **keines von beiden**. Er orchestriert Coding-CLIs
über Pflicht-Worktrees mit host-eigenen Git-Fakten. Job B kann
schon als **Worker-Extra-MCP** mitfahren. Job A als Profil geht nur
mit offenen Augen (siehe [The worktree melt](#the-worktree-melt)).

---

## Schicht 0: der Vault ist ein Ordner

Obsidians dauerhafte Wette, auch von CEO Steph Ango (kepano): die
Dateien sind das Produkt; die App ist ein Viewer. Vault = Verzeichnis
aus Markdown (plus `.base`, `.canvas`, `.obsidian/`). Kein API ist
*nötig*, damit ein Agent arbeitet. `cd vault && claude` ist eine
vollständige Integration.

Deshalb haben Coding-Agenten diese Nische gegen Chat-Plugins
gewonnen: sie können schon lesen, greppen, patchen und Shell. Der
Vault sieht aus wie ein Repo. Der Preis der Reimung: ein Vault ist
**kein** typisches Code-Repo — ein anderer Prozess (Obsidian, Sync,
iCloud) besitzt die Working Copy, die der Mensch sieht.

---

## Schicht 1: Instruktionsdateien und Skills

Jedes ernsthafte Setup wiederholt dieselben drei Dateien unter
verschiedenen Namen:

| Datei | Wer sie liest | Job |
| --- | --- | --- |
| `CLAUDE.md` | Claude Code | House-Rules, immer an |
| `AGENTS.md` | Codex, Cursor, Windsurf, Copilot, viele andere | Derselbe Inhalt, anderer Harness |
| `GEMINI.md` | Gemini CLI | Wieder dasselbe |

Claude Code liest `AGENTS.md` **nicht** als Fallback (gegen
Anthropic-Memory-Doku 2026 geprüft). Die funktionierende Brücke ist
ein einzeiliger `@AGENTS.md`-Import oben in `CLAUDE.md`, oder ein
Symlink. Vault-Templates (arkan, mithunyc, Railly) schreiben alle
drei Pointer, damit das Protokoll in einer kanonischen Datei lebt.

**Agent Skills** ([agentskills.io](https://agentskills.io/specification))
sind die nächste Schicht: ein Ordner mit `SKILL.md`, optional Skripte.
kepanos [`obsidian-skills`](https://github.com/kepano/obsidian-skills)
(~47k Stars, 2026) ist das offiziell-benachbarte Paket —
*Formatkompetenz*, kein OS:

| Skill | Bringt bei |
| --- | --- |
| `obsidian-markdown` | Wikilinks, Embeds, Callouts, Properties |
| `obsidian-bases` | `.base`-Views / Filter / Formeln |
| `json-canvas` | Offenes `.canvas`-Format |
| `obsidian-cli` | Die laufende App über die Obsidian-CLI fahren |
| `defuddle` | Sauberes Markdown aus Webseiten (Token-Sparer) |

Alvars „ein Agent ist ein Ordner mit Markdown“ ist dieses Primitiv
plus ein Write-Boundary-Absatz. Vertragus hat schon Rollenprompts +
Contract + `.pi/APPEND_SYSTEM.md`. kepanos Paket müssen wir nicht
ausliefern; der Nutzer legt es selbst ins Repo oder in den Vault.

**Obsidian CLI** (Installer 1.12+, Einstellungen → Allgemein →
Command line interface) spricht mit der *laufenden* App: Suche,
Daily Notes, Properties, Tasks, Plugin-Reload, Screenshots, `eval`.
Sie ist die native Cousine der Local REST API. Sie ersetzt Git
nicht, und sie läuft nicht headless, außer über Obsidian Headless /
Sync.

---

## Schicht 2: drei Wege, wie ein Agent den Vault berührt

### Ordner als Working Directory

Die CLI auf den Vault zeigen. Kein Plugin. Funktioniert, wenn
Obsidian zu ist. Verliert Live-Graph, Dataview, Templater, den
offenen Tab und chirurgisches „patch diese Überschrift“. Das ist
der Default in fast jedem „Claude Code + Obsidian“-Tutorial.

### Eingebetteter Harness in Obsidian

Ein Community-Plugin startet dieselben CLIs, die Vertragus schon
wrappt, mit dem Vault als cwd und einer Chat-Sidebar als TUI.

| Plugin | Harnesses | Notizen |
| --- | --- | --- |
| [Claudian](https://github.com/YishenTu/claudian) | Claude Code, Codex, Grok, OpenCode, Pi | ACP-Transport; Inline-Edit + Diff-Preview |
| [Oh My Claudian](https://github.com/lee259/oh-my-claudian) | Claudian-Fork + Cursor Agent + Oh My Pi | Dieselbe Idee, mehr ACP-Backends |
| [Agent MCP](https://github.com/rospaans/obsidian-agent-mcp) | Claude Code, Codex, Ollama-via-claude | Eingebautes Terminal + lokales MCP auf `:27183`; Claude-IDE-Lockfile |
| [PiChat](https://community.obsidian.md/plugins/pi-chat) / sigilmakes | Pi-CLI | Rendert Pi-JSONL als Vault-Markdown |
| [obsidian-pi](https://github.com/ChristianLempa/obsidian-pi) | Pi | Note- / Backlink- / Tag-Kontext |
| [Pivi](https://github.com/shuuul/obsidian-pivi) | Pi-Runtime im Prozess | Vermarktet sich als *kein* Coding-Agent |

Die konkurrieren mit Vertragus darum, **wo das Terminal lebt**,
nicht um Orchestrierung. Sie setzen Shared Checkout voraus. Sie
geben dir keine Worktrees, kein `inspect_agent`, kein Task-Board-CAS
und keine Succession.

### Vault als MCP-Server

Den Coding-Agenten in einem *Code*-Repo (oder in Claude Desktop)
lassen und den Vault als Tool anhängen.

Zwei Ökosysteme:

1. **Filesystem MCP** (`@modelcontextprotocol/server-filesystem`)
   auf den Vault-Pfad. Obsidian darf zu sein. Grep, nicht
   Obsidian-Suche. Kein Patch auf Überschriftenebene.
2. **Live-Obsidian-HTTP**, heute meist das Community-Plugin
   [Local REST API with MCP](https://github.com/coddingtonbear/obsidian-local-rest-api)
   (v5, Juli 2026) unter `https://127.0.0.1:27124/mcp/` (Bearer-Token,
   selbstsigniertes Zertifikat) oder `http://127.0.0.1:27123/mcp/`.
   Obsidian muss laufen. Heading/Block-Patch, Command Palette,
   Periodic Notes. Die ältere Brücke `mcp-obsidian` ist optional.

Andere In-App-MCP-Hosts: Cortex (`:27182`), Leonezz
`obsidian-mcp-server` (`:27123` + Token), Agent MCP (`:27183` plus
Claude-IDE-Websocket). Dieselbe Idee, andere Ports.

Vertragus hängt Extra-MCP schon nur an **Worker** (E6): Slot
`extraMcp: [{name, url}]` (HTTP, keine Header), und Settings-globale
Server mit stdio oder HTTP **inklusive Header**. Eine
authentifizierte Local REST API gehört auf die globale Extra-MCP-Liste,
nicht auf die Orchestrator-Allow-List, und nie als zweiter
Vertragus-Server (`vertragus` ist reserviert).

---

## Schicht 3: Gedächtnis, Identität und Personal Agents

Sobald der Vault erreichbar ist, erfinden die Leute eine
Memory-Hierarchie. Die Formen konvergieren:

| Stufe | Typische Dateien | Injiziert |
| --- | --- | --- |
| Instruktionen | `AGENTS.md`, `CLAUDE.md`, `VAULT_RULES.md` | Immer, klein halten |
| Kuratierte Identität | `USER.md`, `SOUL.md`, `HUMAN.md`, `PURPOSE.md` | Immer, budgetiert |
| Dauerhafte Fakten | `MEMORY.md` + Index eine-Datei-pro-Fakt | Immer oder on retrieval |
| Episodisch | `memory/YYYY-MM-DD.md`, Session-Transkripte | Suche on demand, nie dumpen |
| Projekt-Kapseln | `07_System/context-files/*.md`, `repos-map.md` | `@`-Include pro Session |

OpenClaw dokumentiert diese Trennung explizit (Instruktionen vs
`MEMORY.md` vs tägliches Episodisch vs Dreaming-Konsolidierung).
Raillys agent-brain ergänzt Slash-Commands (`/morning`, `/ship`,
`/pulse`), die die episodische Schicht *schreiben*, damit die
nächste Session Evidenz hat. mithunyc/obsidian-agent-memory ist
dieselbe Idee als Vault-Template: Retrieval-Protokoll, Stale,
Promotion-Regeln.

Vertragus hat schon die *Coding-Run*-Version: Briefing (gedeckelt,
untrusted), `repoNotes` (max. 20, vom Nutzer löschbar),
Retro-Learnings, Journale, `search_runs`. Das ist Push + Pull über
**Läufe**, kein Lebens-Wiki. Kein `SOUL.md` züchten.

Job B („den Coder erinnern“) ist der ehrliche Vault-Nutzen aus einem
Vertragus-Profil, dessen `repoPath` ein **Code**-Repository ist:
Worker hängen Vault-MCP an, lesen `repos-map.md` und committen
weiter in ihrem Worktree.

---

## Schicht 4: semantische Suche (die RAG-Gabel)

[Smart Connections](https://github.com/brianpetro/obsidian-smart-connections)
baut lokale Embeddings unter `.smart-env/`. MCP-Brücken (wakaser,
msdanyg, gogogadgetbytes) legen `search_by_meaning` für Claude frei.
Alvar hat im Second-Brain-Video dasselbe Plugin angedeutet.

Das ist RAG. Handbuch-Non-Goal. Worker können greppen. `search_runs`
ist Substring über Journale, bewusst keine Embeddings. Keinen
Vector Store bauen, weil ein Vault-Plugin einen hat.

---

## Muster, die immer wieder auftauchen

1. **Klartext ist das API.** Jedes Setup, das hält, sind Dateien auf
   der Platte. Plugins sind Viewer und Brücken.
2. **Den Always-on-Prompt klein halten.** Dauerhafte Fakten gehören
   in Memory-Dateien, die retrieved werden, nicht in `CLAUDE.md`.
3. **Menschliche Notizen vom Agenten-Abgas trennen.** `_claude/`,
   `AI inbox/`, `00_System/AI/`. Verschmutzung ist der Failure Mode,
   den Alvar laut benannt hat.
4. **Spezialisierung sind Ordner, kein SaaS-Roster.** Skills,
   Slash-Commands, OpenClaw-Agent-Verzeichnisse.
5. **Das Denken nicht abgeben.** Dieselbe Caveat wie Alvar; D4-Tiers
   kodieren sie schon.
6. **Obsidian-die-App vs. Vault-der-Ordner.** Live-Features brauchen
   die App (CLI, REST, Graph). Datei-Features nicht.
7. **Scheinproduktivität.** PARA + Graphen + 40 Slash-Commands ist
   die Falle, vor der Video B warnt. Wert ist, was gelandet ist.

---

## The worktree melt

Die Desktop-App von Claude Code kann pro Session Worktrees unter
`.claude/worktrees/` **im Repo** anlegen. Auf einem Code-Repo ist
das korrekte Isolation. Auf einem Obsidian-Vault, dessen Repo-Root
*der* Vault-Root ist, landet eine volle zweite Kopie jeder Notiz in
dem Ordner, den Obsidian beobachtet. Dokumentierter Ausfall
([mycelium-hq/ai-brain-starter `VAULT_WORKTREE_MELT.md`](https://github.com/mycelium-hq/ai-brain-starter/blob/main/docs/VAULT_WORKTREE_MELT.md),
gemessen 2026-06-06): Renderer-OOM, CPU-Pin, und ein Worktree, den
die Desktop-App mitten in der Session archivieren kann und dabei
einzigartige Dateien mitnimmt. Symlinks aus dem Vault helfen nicht
— Obsidians Watcher folgt ihnen. Rat aus dieser Community: **einen
Vault nie worktreen**; `cd vault && claude` plain fahren;
Code-Isolation in einem *Geschwister*-Repo halten.

Vertragus worktreet immer, unter
`<repo>/.vertragus/worktrees/<agentId>`, und **löscht nie von selbst**.
Ist `repoPath` ein Vault, ist das dieselbe Klasse Fußangel, außer
der Nutzer schließt `.vertragus/` aus Obsidians File-Watcher aus
(Einstellungen → Dateien und Links → Ausgeschlossene Dateien)
**und** aus dem Git-Ignore für Sync/iCloud. Selbst dann ist jeder
Agent ein volles Checkout auf der Platte. Die Panel-Cleanup-Ansicht
ist der einzige Entfern-Pfad.

Das ist das stärkste Argument für Job B (Vault als Extra-MCP auf
einem Code-Profil) gegenüber Job A (Vault als Profil-Repo) in
Vertragus.

Ein verwandtes Claude-Code-Issue (Background-Sessions verweigern
Edit/Write außerhalb von `.claude/worktrees/`, wenn
`CLAUDE_JOB_DIR` gesetzt ist) ist der inverse Schmerz: Isolation,
die Edits vor der App versteckt, die die Working Copy besitzt.
Vertragus-Isolation ist *Host*-Policy, nicht die der CLI. Promote
ist, wie das menschliche Checkout die Arbeit sieht.

---

## Abbildung auf Vertragus

### Schon im Code

| Landschaftsstück | Vertragus heute |
| --- | --- |
| Markdown-Ordner als cwd | Profil-`repoPath` (muss Git sein) |
| `CLAUDE.md` / `AGENTS.md` / `README.md` | E2-Briefing liest genau die drei plus letzte Commits |
| Spezialisierte Agenten | Slots + Builtin-Rollen; Pi-Wrap für einen kleinen Prompt |
| Skills / Slash-Commands | Nutzer-eigene Dateien im Repo; Playbooks = **Goal-Templates** |
| Write Boundary | Worktrees; Integrate + Promote; Automatisierung standardmäßig aus |
| Vault als Tool von einem Code-Repo | Worker-Extra-MCP (E6), nicht der Orchestrator |
| Browser-förmige Recherche | First-Party `/browser`, kein zweites MCP |
| Capture / Revisit | Task-Board (Complete ist Orchestrator-nach-Verify) + `search_runs` |
| Gedeckelte Dauerfakten | `repoNotes`, Retro-Learnings — kein RAG |
| Sichtbare Terminals | Panel-PTYs, keine Obsidian-Sidebar |
| Isolation ohne Autodelete | `worktree.ts`-Doktrin |

### Zwei Rezepte, die keine neuen Tools brauchen

**Rezept B (bevorzugt): Code-Profil, Vault als Extra-MCP.**
`repoPath` bleibt das Git-Projekt. Local REST API in Obsidian
einschalten (HTTP auf `:27123`, wenn der selbstsignierte
Zertifikat-Tanz stört). Diese URL auf einen **Worker**-Extra-MCP-Server
mit Bearer-Token in den Settings-Headern. Der Orchestrator sieht
diese Tools nie. Worker greppen oder `vault_read`, wenn die Aufgabe
Notizen braucht; sie committen weiter in `.vertragus/worktrees/`.
Obsidian beobachtet einen Baum.

**Rezept A (Vault als Profil, Augen offen).** `git init` auf dem
Vault. `.vertragus/` in Obsidian **und** in `.gitignore` ausschließen.
`autoPromote` bleibt aus. Pi-Wrap an, wenn die Arbeit Denken ist,
kein 10k-Token-Coding-Prompt. Plattenkopien pro Agent akzeptieren.
Obsidian Worktrees nicht indexieren lassen. Das ist Alvars Garage
unter Harness-Recht, kein Shared Checkout.

**kepano-Skills** gehören in den Vault oder nach `~/.claude/skills`
— Nutzer-Install, kein Vertragus-Submodul.

### Was wir nicht bauen

- Ein Obsidian-Plugin, Claudian-Klon oder „Panel im Vault“
- `obsidian-skills` oder OpenClaw als Provider ausliefern
- Ein First-Party-Vault-MCP (Local REST API existiert; Extra-MCP
  hängt schon an)
- Vektorsuche / Smart Connections als Host-Tool
- Shared-Checkout-Modus „weil Vaults unter Worktrees schmelzen“
  (das zerbricht Isolation für jedes Code-Profil)
- Autodelete von Vault-Worktrees (die Melt-Doku will Cleanup;
  unsere Doktrin ist das Gegenteil — der Nutzer klickt)
- PARA- / Daily-Notes- / Graph-Chrome
- `SOUL.md`-Identitätsprodukt
- Orchestrator-Tools für YouTube, Inbox-Daemons oder `/morning`
- Playbooks, die eine PKM-Crew vorstarten

---

## Landschaftssnapshot (Katalog)

Zeitpunkt August 2026. Namen sind Evidenz für das Muster, keine
Empfehlungen.

| Art | Beispiele |
| --- | --- |
| Offiziell-benachbarte Skills | kepano/obsidian-skills |
| Obsidian CLI | help.obsidian.md/cli (App muss laufen) |
| Live-Vault-MCP | Local REST API v5, Cortex, Leonezz, Agent MCP |
| Disk-Vault-MCP | Filesystem MCP auf den Vault-Pfad |
| Eingebettete CLIs | Claudian, Oh My Claudian, Agent MCP, PiChat, obsidian-pi, Pivi |
| Vault-Templates / OS | Railly/agent-brain, arkan/obsidian-vault-template, mithunyc/obsidian-agent-memory |
| Code-Repo-Sidecar-Vault | TheFancyRobot/agent-vault (`.agent-vault/`) |
| Multi-Agent-Blackboard | yehudalevy-collab/agent-vault (`_multi-agent/`) |
| Personal-Agent-Memory | OpenClaw-Workspace-Markdown; Alvar AI-Inbox |
| Semantisches RAG | Smart Connections + MCP-Brücken |
| Chat-Plugin-Linie (keine Coding-Agenten) | Copilot, Smart Chat — anderes Produkt, dasselbe Markdown |

---

## Verhältnis zu den Alvar-Videos

Das Begleitdokument ist die Philosophie (temporaler Vertrag, Wissen
rein / Ideen raus, Write Boundary, Pi weil der Coding-Prompt zu groß
ist). Dieses Dokument ist der *Markt*, der um dieselbe Reimung
wuchs: Markdown-Ordner + Coding-Agent.

Alvars Umsetzung ist Schicht 2 „Ordner als cwd“ plus Schicht 1
Ordner-als-Agenten, mit prompt-level Write Fence. Er nutzt keine
Vertragus-Worktrees, und sollte es nicht: das ist der Melt. Sein
„ein Interface“ ist Obsidian + ein Terminalfenster — Claudian
versucht, das in ein Fenster zu klappen; er bevorzugt zwei.

Nichts in der weiteren Landschaft schwächt das Alvar-Mapping: kein
Second Brain werden; kein RAG; Pi-Wrap ist das richtige Overlay für
Nicht-Coding-Vault-Arbeit; Extra-MCP ist die richtige Brücke für
Job B.

---

## Verhältnis zu UWE

[UWE](https://github.com/Nehmo101/UWE) ist der Wissenshost des
Owners. Es ist kein Markdown-Vault und kein eingebettetes
Obsidian.app: Wiki, Graph, Wikilinks, Vault-ZIP-Import, World-Brain
und Personal Brain leben in SQLite hinter vier HTTP-MCP-Servern.
Ordner-als-cwd, Filesystem-MCP und Claudian kämpfen gegen dieses
Produkt. Das Remap (Rezept UWE-B, keine neuen Vertragus-Tools)
steht in
[`RESEARCH-UWE-KNOWLEDGE.md`](./RESEARCH-UWE-KNOWLEDGE.md).

---

## Einschränkungen

- Plugin-Verzeichnisse, Ports und Star-Zahlen bewegen sich. Jobs
  (cwd vs. MCP vs. Embed) vor Namen bevorzugen.
- Local-REST-API-TLS + Bearer-Tokens sind ein Secret. Extra-MCP-Header
  leben in AppSettings, nicht im Profil-JSON, das nach Git geht.
  Den Key nicht in `extraMcp.url` stecken.
- Obsidian CLI und Live-MCP brauchen beide die laufende App. Ein
  Vertragus-Worker auf einer headless CI-Box sieht sie nicht.
- Dieser Scan hat keine Plugins installiert und Claudian nicht
  ausgeführt. Aussagen zur ACP-Abdeckung folgen READMEs.
- Nichts hier autorisiert ein Handbuch-Non-Goal. Shared Checkout,
  RAG, ein zweites Produkt oder Autodelete bleiben verboten, selbst
  wenn jedes Vault-Tutorial das Gegenteil tut.
