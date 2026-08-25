Deutsch | [English](RESEARCH-UWE-KNOWLEDGE.md)

# Research: UWE-Wissen versus Obsidian-Agenten

Stand: 25. August 2026. Erneute Lektüre der Landschaft Obsidian +
Agenten gegen das Schwesterprodukt
[UWE](https://github.com/Nehmo101/UWE) (`main` bei `2577bbd`).
Zweck: Die früheren Vertragus-Notizen nahmen einen Markdown-Vault
als Wissenshost an. UWE ist dieser Host nicht. Es liefert bereits
ein Obsidian-*förmiges* Wissens-OS — Wiki, Graph, Wikilinks,
Vault-Import, zwei Brains, vier MCP-Server — auf SQLite und HTTP,
mit Privacy-Tests. Dieses Dokument bildet die Landschaft auf
**UWE ab, wie es heute in dem Repo steht**, und sagt, was
Vertragus tun (und lassen) soll, wenn das Profil das UWE-Checkout
ist.

Das ist in keinem der beiden Repos ein Produkt-Track. Es kommen
keine Vertragus-Tools, keine UWE-Tools, kein RAG im Harness und
kein eingebettetes Obsidian.app hinzu. Begleitende Landschaft:
[`RESEARCH-OBSIDIAN-AGENTIC.md`](./RESEARCH-OBSIDIAN-AGENTIC.md).
Alvar-Video-Deepdive:
[`RESEARCH-OBSIDIAN-AI-SECOND-BRAIN.md`](./RESEARCH-OBSIDIAN-AI-SECOND-BRAIN.md).
Doktrin: [`HANDBOOK-HARNESS.md`](./HANDBOOK-HARNESS.md).

---

## Zweck

Die Formulierung „theoretisch ist intern schon ein Obsidian da“
ist der richtige Instinkt und das falsche Substantiv. UWE hat
Obsidian nicht eingebettet. Es hat die *Jobs*, für die Leute
Obsidian nutzen (verlinkte Notizen, Graph, Inbox, lokale KI,
spielersicher vs. SL-privat), als First-Party-Produktoberflächen
neu gebaut und Agenten auf denselben HTTP-Pfad gelegt, den jeder
andere Client auch nutzt.

Die Landschaftsrezepte `cd vault && claude`, Filesystem-MCP auf
einen Ordner oder Claudian in Obsidian **kämpfen gegen UWE**.
Sie würden um `view=dm|player`, um das Strippen von `dm_only` und
um das Local-Only-Tor des Personal-Brain herumlesen. Das nützliche
Remap: Vertragus bleibt der Coding-Harness; UWE bleibt der
Wissenshost; Worker hängen UWE-MCP so an, wie die Landschaft
Local REST API anhängen wollte.

---

## Was UWE tatsächlich ist

UWEs eigene Zeile: ein selbst gehostetes OS für Rollenspielrunden
*und* den Alltag — SL-Studio, Spieler-Wiki, privates Wissen, eigene
Hardware. Es ist ein pnpm-Monorepo aus fünf Next.js-Apps und rund
vierzig Paketen. Wissen ist **kein** Ordner voller Markdown.

| App | Default-Port | Zielgruppe | Speicher |
| --- | --- | --- | --- |
| Studio | 3000 | SL / Owner | `uwe.db` — Welten, Wiki, World-Brain, KI |
| Portal | 3001 | Spieler | dieselbe Kern-DB, fail-closed Spielersicht |
| Brain | 3002 (Loopback) | nur Owner | `uwe-brain.db` — Life-Brain, Daily Admin, Mail |
| Family | 3004 (Loopback) | Haushalts-Häkchen | `uwe-family.db` |
| Landing | 3103 | öffentlicher Apex | keine Inhalte |

Der Split wird erzwungen (`@uwe/product-contracts`,
`scripts/product-boundary-check.mjs`). `dm_only` erreicht das
Portal nie. `owner_private_local` / `personal_brain` verlassen den
Host nie und gehen nie in Cloud-KI (ADR 006, `SECURITY.md`).
Lokale Inferenz ist **Maschinenraum** (outbound Connector zu
Ollama / LM Studio / llama.cpp). Cloud ist Opt-in für D&D-Kontext
unter Gateway-Policy; Personal Brain ist nicht konfigurierbar.

Das Command Center (Tauri) kann die Web-Apps unter Windows
starten. Das ist Host-Betrieb, keine zweite Wissens-UI.

---

## Das interne Obsidian

Was existiert, ist ein Obsidian-*förmiges Produkt*, nicht
Obsidian.app in einem Webview.

**Wiki + Wikilinks.** Seiten speichern den Autorentext; das Parsen
von `[[wikilink]]` lebt in
`packages/database/src/wikilink-utils.ts` (Pipe-Labels,
HTML-Entity-Decode, damit `A'Tuin` den Import überlebt).
Backlinks kommen aus einem gecachten Graphen, nicht aus dem Grep
eines Ordners.

**Graph, der Obsidian-Handwerk jagt.** `packages/shared-ui`
`graph-engine*.ts` und `tools/wiki-graph-aaa` vergleichen
Kamera-Tween (Band 150–200 ms), Spotlight-Dimmen und
Konstellationsabstand mit Obsidians Void-Canvas. Der Pergament-Look
ist eine bewusste Marken-Gabel, kein fehlendes Dark Theme. Das ist
visuelle Parität als Qualitätsleiste, kein zweites PKM-OS.

**Vault-ZIP-Import.**
`packages/database/src/obsidian-vault-import.ts` packt einen
Obsidian-Export aus, überspringt `.obsidian/` und `.trash/`,
deckt bei 10 MB / 2000 Dateien ab und speist die bestehende
Markdown-Import-Pipeline. Der Doc-Import im Command Center
überspringt dieselben versteckten Ordner. Reifegradmatrix:
Import-Zentrale ist Beta — die Obsidian/PDF-*Upload-UI* gilt als
bewusst nicht verfolgt (`docs/CURRENT_STATE.md`). Der Backend-Pfad
existiert; es gibt keinen Obsidian-Editor in der App.

**Wiki als Spieldaten.** Eine Seite kann regeltechnisch sagen, was
sie *ist* (Spezies, Zauber, Waffe, …) über `Page.gameDataKind`
plus `GameDataEntry`. Die Charaktererstellung liest diesen Katalog.
Ein Markdown-Vault hat Notizen; UWE hat Notizen, die auch
Spielobjekte sind. Deshalb ist „einfach den Vault syncen“ die
falsche Migrationsgeschichte.

**Daily Admin OS.** `/today`, `/capture`, `/projects`,
`/workshop`, `/life-brain`, `/hardware`, ki-chat. Capture ist die
vertrauenswürdige Inbox. Promote-ins-Life-Brain ist Review, kein
Auto-Apply. KI-Ausgaben sind Vorschläge. Das ist Alvars temporaler
Vertrag als Produkt, nicht als Ordner namens `Inbox/`.

Nichts davon ist ein Grund, Obsidian in UWE zu shippen oder das
Git-Checkout als Wiki zu behandeln.

---

## Zwei Brains, zwei Privacy-Regime

Wer „das Brain“ sagt, meint drei verschiedene Speicher.

| Name | Wo | Was es ist | Cloud-KI |
| --- | --- | --- | --- |
| World-Brain | Studio / `uwe.db` | Kampagnen-Dokumente, Fakten, Chunks, Wiki-Graph | Unter Gateway-Policy nach `dm_only`-Strip erlaubt; lokal bevorzugt |
| Personal Brain / Life-Brain | `apps/brain` / `uwe-brain.db` | owner-private Notizen, Captures, Fakten | **Nie.** Modus `personal_brain` ist local-only |
| Family | `uwe-family.db` | Haushaltskalender, Küche, Gesundheit | Geteilt mit dem Family-Häkchen, weiter host-lokal; Chats/Docs nicht auf MCP |

World-Brain hat eine versionierte Knowledge API
(`/api/v1/knowledge/*` in `packages/knowledge`). Jeder
Welt-Endpunkt verlangt `view=dm|player`. Fehlendes `view` ist 400
— es gibt keinen stillen SL-Default. Die Spielersicht wird
fail-closed gebaut (`asPlayerPreview`: Portal-Freigabe, `:::dm`
aus dem Text geschnitten, World-Brain nur `canonical`-Zeilen an
einer freigegebenen Seite). Semantische Suche auf dem World-Brain
braucht `worlds_read` plus `ai_invoke` und das `aiAccess`-Flag
des Token-Besitzers.

Personal-Brain-Suche ist Maschinenraum-Embeddings plus
Keyword-Fallback (`/api/life-brain/search`). Ist der Maschinenraum
unten, wird der Job vorgemerkt (HTTP 202). Es gibt kein
Cloud-Fallback. Capture → Life-Brain ist
`promoteCaptureToLifeBrain` mit einem `AdminEntityLink` zurück zur
Quelle.

KI schreibt nie automatisch Kanon. Apply ist eine menschliche
Aktion; Publish ins Portal eine zweite.

---

## Wie Agenten bereits andocken

UWEs Agentenbrücke ist **nicht** „den Vault öffnen“. Es sind vier
stdio-MCP-Server in `packages/mcp`, registriert in `.mcp.json` im
Repo-Root:

| Server | Produkt | Job |
| --- | --- | --- |
| `uwe-studio` | Studio :3000 | Welten, Knowledge API, Jobs, Admin |
| `uwe-portal` | Portal :3001 | Spielersicht-Checks (`view=player` hart kodiert) |
| `uwe-brain` | Brain :3002 | Personal Brain, privacy-gated |
| `uwe-family` | Family :3004 | Haushalt; keine privaten Chats/Docs |

Sie sind dünne HTTP-Clients. Sie importieren **nicht**
`@uwe/database` und öffnen kein SQLite. Authz, Sichtfilter und
Audit-Logs bleiben auf demselben Pfad wie die UI. Schreibende
Tools registrieren sich nur bei `UWE_MCP_ALLOW_WRITES=true`
(genau dieser String). Brain-*Inhalts*-Tools
(`brain_search`, `brain_context`, `brain_calendar`) nur bei
`UWE_MCP_BRAIN_ALLOW_CONTENT=true`. Default-Brain-Fläche ist
Metadaten: `brain_health`, `brain_stats`,
`brain_privacy_status`. `brain_stats` muss
`/api/life-brain/stats` treffen, nie Search — Search liefert
Titel.

Der Kommentar in `packages/mcp/src/tools/brain.ts` ist die Doktrin
in einem Absatz: Claude Code *ist* Cloud-KI, also ist Inhalt, der
den Host Richtung MCP-Client verlässt, eine bewusste
Owner-Freigabe, kein Tool-Argument, das das Modell umlegen kann.

Bereichs-Skills unter `.claude/skills/uwe*` werden aus
`createServer()` generiert (`scripts/generate-area-skills.ts`,
`pnpm skills:sync`). Veraltete Slash-Commands, die gelöschte Tools
nannten, sind der Grund, den Katalog nicht von Hand zu schreiben.

Studio-Knowledge-Tools umfassen
`studio_knowledge_worlds|search|page|brain|graph` mit Pflicht-`view`.
Portal-Tools können die SL-Sicht nicht öffnen.

---

## Die zwei Jobs neu abbilden

Die Landschaftsteilung gilt weiter. Der *Host* jedes Jobs
wechselt.

| Landschafts-Job | Host in der Vault-Welt | Host in UWE |
| --- | --- | --- |
| **A — das PKM betreiben** | Ordner als cwd, Pi in der Garage | Studio-Wiki + Brain Daily Admin + ki-chat + UWE-MCP gegen die **laufenden Apps** |
| **B — den Coder erinnern** | Sidecar-Vault / Local REST API aus einem Code-Repo | wenn das Code-Repo **UWE ist**, hängen Worker `uwe-studio` (und nur wenn freigegeben `uwe-brain`) als Extra-MCP an |

Job A in UWE ist bereits ein Produkt. Vertragus soll dafür keine
zweite Inbox, kein PARA-Chrome und kein `SOUL.md` wachsen. Job B
in Vertragus bleibt Extra-MCP auf **Workern**, nie auf dem
Orchestrator — dieselbe E6-Regel wie bei Local REST API.

Eine dritte Vermischung ablehnen: den UWE-**Git-Worktree** als
Wiki behandeln. Seiten leben in SQLite. Markdown im Repo ist
Quellcode und Doku, nicht Kampagnenkanon. Ein Agent, der
`notes/npc.md` in `.vertragus/worktrees/<id>` `Write`t, hat die
Welt nicht aktualisiert.

---

## Die Attach-Schichten neu abbilden

| Landschaftsschicht | Urteil zu UWE |
| --- | --- |
| Schicht 0 — Vault ist ein Ordner | Falsch. Wissen ist SQLite + HTTP. Ordner-als-cwd umgeht Authz. |
| Schicht 1 — `agents.md` / Skills | UWE hat bereits Bereichs-Skills + MCP-Toolkatalog, generiert und CI-geprüft. Keine Alvar-Agentenordner ins Wiki. |
| Schicht 2a — Ordner als cwd | Schädlich. `cd` in einen Vault *oder* in das Verzeichnis von `uwe.db` und der Produkt-Split ist weg. |
| Schicht 2b — Claudian / PiChat / Obsidian einbetten | Nicht. UWE hat bereits ki-chat und vier MCP-Server. Ein Panel-im-Vault wäre ein zweiter Host für dieselbe Sorge. |
| Schicht 2c — Vault als MCP (Local REST API / Filesystem-MCP) | Falsches Protokoll. `uwe-studio` / `uwe-brain` nutzen. Filesystem-MCP auf dem Datenverzeichnis umgeht `view` und das Personal-Brain-Gate. |
| Schicht 3 — `MEMORY.md` / OpenClaw-Identität | UWE hat typisierte Fakten und Dokumente mit Review. Keine Markdown-Soul-Datei neben `uwe-brain.db`. |
| Schicht 4 — Smart-Connections-RAG | World-Brain und Life-Brain embedden bereits **als UWE-Produktfeatures** mit Privacy-Tests. Das lizenziert kein RAG in Vertragus. |

kepano/`obsidian-skills` bleiben Formatkompetenz für Leute, die
noch einen Vault halten. Sie sind kein OS, das UWE vendorn soll,
und kein Vertragus-Submodul.

---

## Worktrees und Melt

Der mycelium-hq-Worktree-im-Vault-OOM gilt weiter für jeden, der
Obsidian auf ein Git-Repo zeigt. Er beschreibt **nicht** UWEs
Wissensspeicher: Obsidian beobachtet `uwe.db` nicht.

Was weiter gilt, wenn Vertragus **auf dem UWE-Checkout** läuft:

- Jeder Agent ist ein Git-Worktree unter
  `<repo>/.vertragus/worktrees/<id>`. Nie Autodelete.
- Diese Worktrees sind Quellkopien, keine Wiki-Kopien. Promote
  mergt Code. Wiki-Schreibzugriffe gehen über Knowledge API /
  Studio-UI / MCP-Writes.
- Kein `git init` eines Vaults *in* UWE, um „dem Agenten Notizen
  zu geben“. Das bringt Melt *und* einen Schattenkanon zurück.
- Extra-MCP-stdio für `uwe-*` soll mit der **laufenden
  Host-Instanz** sprechen (Ports aus `.env`), nicht mit einem
  SQLite pro Worktree. Dünne HTTP-Clients funktionieren schon
  gegen ein getunneltes Remote-Studio; sie sollen keinen
  Direkt-DB-Modus wachsen.

---

## Semantische Suche versus das RAG-Non-Goal des Harness

Vertragus-Non-Goal: kein Vektorspeicher, keine Smart Connections,
kein Host-Retrieval über Notizen. Gekappte Fakten sind
`repoNotes` und Retro-Learnings.

UWE mit Absicht: semantische World-Brain-Suche und
Life-Brain-Chunk-Embeddings über den Maschinenraum. Gegated,
getestet und so getrennt, dass D&D-Chunks nie mit
`PersonalBrainChunk` mischen.

Das widerspricht sich nicht, wenn die Grenze hält: **UWE darf
retrieven; der Harness darf keinen zweiten Index wachsen.** Ein
Vertragus-Worker, der `studio_knowledge_brain_search` aufruft,
nutzt UWEs Retrieval, fügt Electron kein RAG hinzu. Eine
Vertragus-Änderung, die Vault-Dateien in das Panel embeddet, wäre
das Non-Goal.

---

## Alvars Garage unter UWE-Recht

| Alvar-Zug | UWE-Analogon | Nicht tun |
| --- | --- | --- |
| Second Brain = kognitiver Zustand, kein Speicher | Daily Admin + Life-Brain + World-Brain, typisiert | Hübscher Graph als Produkt |
| Temporaler Vertrag (eine Inbox, muss revisited werden) | `/capture` → Triage → Promote | Eine zweite Markdown-Inbox im Git-Repo |
| Wissen rein / Ideen raus | KI-Vorschläge, Review, Apply, Publish | Auto-Apply bei Modellkonfidenz (ADR 006 hat das verworfen) |
| Write Boundary (Vault lesen, AI-Inbox schreiben) | MCP-Writes default aus; Brain-Inhalt default aus; `:::dm` nie ins Portal | Filesystem-Writes in SQLite-Pfade |
| Agenten sind Ordner mit `agents.md` | Vier MCP-Server + generierte Bereichs-Skills | Agentenordner als Wiki-Seiten |
| Pi, weil der Coding-Prompt zu groß ist | UWE-ki-chat + lokaler Maschinenraum für Personal Brain; Vertragus-Pi-Wrap bleibt Overlay für *Coding* | Pi als siebter Provider; Pi auf `uwe.db` zeigen |
| Ein Interface, zwei Fenster | Studio/Brain-UI + ein Terminal, das MCP spricht | Claudian in UWE, oder Obsidian daneben als zweite Wahrheitsquelle |

Alvars Ordner-als-cwd-Garage ist das richtige Design für einen
Markdown-Vault. UWE hat diese Architektur bewusst verlassen. Die
Garage nach UWE zu kopieren würde Spielersicht, drei Datenbanken
und die Cloud-KI-Trennung wegwerfen.

---

## Bevorzugte Rezepte

**Rezept UWE-B (bevorzugt, wenn UWE in Vertragus kodiert wird).**
Profil-`repoPath` ist das UWE-Git-Checkout. Der Orchestrator bleibt
auf der Harness-Allow-List. Worker bekommen Extra-MCP (stdio,
cwd = UWE-Checkout oder jeder Baum, der `packages/mcp` spawnen
kann) für `uwe-studio`, und `uwe-portal`, wenn die Aufgabe „was
sieht ein Spieler?“ ist. `uwe-brain` nur anhängen, wenn der Owner
für diese Sitzung `UWE_MCP_BRAIN_ALLOW_CONTENT=true` gesetzt hat —
Default sind Metadaten. Tokens leben in Extra-MCP-Env/Headers
(AppSettings), nicht im committed Profil-JSON.
`UWE_MCP_ALLOW_WRITES` bleibt aus, außer die Aufgabe ist eine
bewusste Wiki-Edit. Commits bleiben in `.vertragus/worktrees/`.
Die laufenden Studio/Brain-Prozesse sind die Wissenswahrheit.

**Rezept UWE-A (das Wissens-OS betreiben).** Kein Vertragus-Profil
auf dem Vault öffnen und nicht so tun, als wäre das Checkout das
Wiki. Studio, Brain, ki-chat und UWE-MCP aus der CLI nutzen, die
der Owner schon gegen den Host fährt. Vertragus ist hier optional.

**Rezept Landschaft-B (weiter gültig für einen Rest-Vault).**
Bleibt etwas in Obsidian, das UWE nicht ingestet, den Vault
außerhalb des UWE-Repos halten, `.vertragus/` aus Obsidian
ausschließen falls je `git init`, und Local REST API als
Worker-Extra-MCP von einem *Code*-Profil anhängen — nie als
Filesystem-MCP auf UWEs Datenverzeichnis.

Keine neuen Vertragus-Tools. Keine neue UWE-MCP-Fläche für diese
Recherche.

---

## Was nicht gebaut wird

In **Vertragus**:

- Ein Obsidian-Plugin, Claudian-Klon oder „Panel im Vault“
- First-Party-Vault-MCP (UWE und Local REST API existieren schon)
- RAG / Smart Connections als Host-Tool
- Shared-Checkout-Modus „weil SQLite kein Git-Ordner ist“
- Autodelete von Worktrees
- `SOUL.md`, PARA, Daily-Notes-Chrome, YouTube auf der
  Orchestrator-Allow-List
- UWE oder Obsidian als Provider shippen
- Pi auf ein Vault-cwd zeigen, als wäre das UWE

In **UWE** (Recherche-Rat, kein UWE-Patch):

- Obsidian.app oder Claudian einbetten
- Ein Filesystem-MCP auf `uwe.db` / `uwe-brain.db`
- Die vier MCP-Server in einen Katalog klappen
- `UWE_MCP_BRAIN_ALLOW_CONTENT` zum Tool-Argument machen
- Cloud-Fallback für `personal_brain`
- Auto-Apply von KI in den Kanon
- Die Obsidian-Upload-UI als Pflicht-Track wieder öffnen
  (Produkt hat sie bereits als nicht verfolgt markiert)

---

## Code-Anker

UWE-Pfade, relativ zu jenem Repo-Root (`2577bbd` auf `main`):

| Thema | Wo |
| --- | --- |
| Produkt-Split / DB-Dateien | `docs/CURRENT_STATE.md`, `packages/product-contracts` |
| Wikilinks | `packages/database/src/wikilink-utils.ts` |
| Vault-ZIP-Import | `packages/database/src/obsidian-vault-import.ts` |
| Graph vs. Obsidian-Handwerk | `packages/shared-ui/src/graph-engine*.ts`, `tools/wiki-graph-aaa` |
| Wiki als Spieldaten | `docs/engineering/wiki-als-spieldaten-katalog.md` |
| Knowledge API | `docs/knowledge-api.md`, `packages/knowledge` |
| Personal-Brain-Privacy | `docs/life-brain-privacy.md`, ADR 006 |
| MCP-Server | `packages/mcp`, `.mcp.json`, `docs/engineering/mcp-servers.md` |
| Brain-Inhalts-Gate | `packages/mcp/src/tools/brain.ts` |
| Studio-Knowledge-Tools | `packages/mcp/src/tools/studio-knowledge.ts` |
| Bereichs-Skills-Generator | `scripts/generate-area-skills.ts` |
| Import-UI-Status | `docs/CURRENT_STATE.md` (nicht verfolgt), Reifegradmatrix |

Vertragus: Worker-Extra-MCP (`extraMcp` am Profil, E6),
Worktrees, Pi-Wrap als Overlay, Handbuch-RAG-Non-Goal — siehe
[`HANDBOOK-HARNESS.md`](./HANDBOOK-HARNESS.md).

---

## Einschränkungen

- Dieser Durchgang hat öffentliches `Nehmo101/UWE` geklont und
  Doku plus die Dateien in der Tabelle gelesen. UWE wurde nicht
  gestartet, MCP nicht gepaired, kein Vault importiert.
- UWE-Doku ist deutsch-kanonisch. Feature-Reifegrade hinken
  `main` hinterher; `CURRENT_STATE.md` gewinnt bei Runtime/CI.
- Die Portal-Mitgliedschaftsregel (wer der Welt zugeordnet ist,
  sieht alles darin) ist Produktgesetz und kein Leak von
  `dm_only` ins Portal.
- Nichts hier autorisiert ein Handbuch-Non-Goal. UWE-Retrieval
  ist keine Lizenz für Vertragus-RAG. UWE-MCP ist keine Lizenz
  für Orchestrator-Tool-Wucher.
- UWE für Recherche nicht als Submodul in dieses Git-Repo
  vendorn.
