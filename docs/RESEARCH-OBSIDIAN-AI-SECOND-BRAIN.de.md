Deutsch | [English](RESEARCH-OBSIDIAN-AI-SECOND-BRAIN.md)

# Research: Obsidian, KI-Agenten und das Second Brain (Eero Alvar)

Stand: 25. August 2026. Primärquellen: zwei YouTube-Videos von
[Eero Alvar](https://www.youtube.com/@EeroAlvar), über die
veröffentlichten Captions. Zweck: Philosophie und Demo herausziehen,
dann beides auf Vertragus **wie er heute im Code steht** abbilden —
was schon passt, was mit Handbuch-Non-Goals kollidiert, und was (falls
überhaupt) sich mitnehmen lässt, ohne ein zweites Produkt zu starten.

Das ist kein Produkt-Track. Es kommen keine Tools, Rollen oder
MCP-Fläche hinzu. Begleitende Landschaft (Obsidian + agentische
Entwicklung):
[`RESEARCH-OBSIDIAN-AGENTIC.md`](./RESEARCH-OBSIDIAN-AGENTIC.md).
Begleitende historische Recherche:
[`RESEARCH-DEEPSEEK-HARNESS.md`](./RESEARCH-DEEPSEEK-HARNESS.md).
Doktrin: [`HANDBOOK-HARNESS.md`](./HANDBOOK-HARNESS.md).

---

## Quellen

| | Video | URL |
| --- | --- | --- |
| A | *Obsidian and AI were made for each other* | https://www.youtube.com/watch?v=hhtExS5UQBI |
| B | *Second brain setup for doing* | https://www.youtube.com/watch?v=Y1xO9OsCBC4 |

Alvar präsentiert sie als Paar. A ist die **KI-Richtung** einer
symbiotischen Schleife (Agenten, die im Vault leben). B ist die
**Second-Brain-Richtung** (warum der Vault existiert, und warum die
meisten Notizsysteme das falsche Problem lösen). B zuerst, wenn es um
das Modell geht; A zuerst, wenn es um die Pi/Obsidian-Garage geht, die
er wirklich fährt.

Captions sind automatisch. Ein paar ASR-Rutscher stehen unter
[Caveats](#caveats). Zitate unten sind aus diesen Captions geglättet,
kein Studio-Transkript.

---

## Das Paar in einer These

Alvars Behauptung ist nicht „mehr Notizen organisieren“ und nicht
„mit deinen Dateien chatten“. Sie ist:

1. Das Gehirn ist ein **Prozessor mit kleinem Context Window**.
   Projekte tracken, Ideen halten, merken wo Dinge liegen — das ist
   kognitiver Zustand, den der Prozessor nicht an sich selbst
   verschwenden sollte.
2. Externer Speicher hilft nur, wenn er **State Management** macht:
   Wissen kommt rein, Ideen gehen raus, und der einzige Grund für
   beides ist **Execution**.
3. Ist dieser Speicher ein Ordner Markdown, kann ein Coding-Agent
   *darin* leben. Der Agent holt sich seinen Kontext selbst. Der Vault
   wird die Oberfläche; ChatGPT-im-Browser wird überflüssig.
4. Spezialisierung schlägt einen generischen Bot: **ein Agent ist ein
   Ordner mit Markdown** (Prompt, Skills, Skripte). Write-Scope gehört
   in den Prompt, nicht in eine Plattform-Feature.
5. KI darf das Denken nicht übernehmen. Sie nimmt Reibung weg, damit
   der Mensch das Restbudget für Urteil, Synthese und Geschmack
   ausgibt.
6. Der Failure Mode ist ästhetische Prokrastination — Graphen,
   Taxonomien, „Wikipedia-Artikel“, die nie ein Ding in der Welt
   werden.

Vertragus ist kein Second Brain. Er ist ein Harness, der mehrere
*derselben Jobs* schon für **Coding-Läufe** erledigt: Arbeit isolieren,
ungelösten Zustand auf dem Host halten, gegen Disk verifizieren, und
Wert daran messen, was gelandet ist — nicht daran, wie hübsch der
Graph ist.

---

## Video: Second brain setup for doing

### Kognitiver Zustand, nicht Speicher

Eröffnungszug: „cognitive optimization“ als Allokation der
Rechenleistung des Gehirns. Ein Second Brain wird meist als
Informationsarchitektur verkauft. Alvar sagt, das löst das falsche
Problem. Speicher ist Teil davon; er erzeugt allein weder besseres
Denken noch mehr Fertiges. Das eigentliche Problem ist
**kognitives State Management** — in Agenten-Sprache: das Context
Window des Gehirns engineeren.

Die Steuer, die er nennt: Projekte tracken, Ideen halten, Orte
merken, Kontext über alles halten, was man tut. Ein Gehirn, das
seinen eigenen Zustand verwaltet, ist dieselbe Klasse Verschwendung
wie ein LLM, das den Prompt mit Bookkeeping vollstopft, das der Host
besitzen sollte.

### Wissen rein, Ideen raus

Die meisten Notizsysteme behandeln allen kognitiven Inhalt als einen
Strom: ingest, ablegen, holen. Alvar spaltet ihn in zwei Typen, die
**in entgegengesetzte Richtungen verhalten** und nicht gleich
behandelt werden dürfen.

| | Wissen | Ideen |
| --- | --- | --- |
| Richtung | Welt → Gehirn | Gehirn → Welt |
| Ankunft | Gewählt (Bücher, Papers, Kurse, Code) | Sporadisch, ungeladen |
| Last | Integriert sich in mentale Modelle; verstopft Working Memory nicht | Sitzt im Working Memory; konkurriert mit der aktuellen Aufgabe |
| Rolle | Erweitert, was du denken und ausführen kannst | Wie du Wert erzeugst — nicht wegwerfen, nicht halten |
| Notizen sind | Transfer-Artefakte zur *Installation*, keine Wikipedia-Seiten | Evakuierung, keine Organisation |

Das Gruppentheorie-Beispiel: ein Thema verstehen verbraucht nicht
dieselbe Ressource wie *sich merken, später in die Notiz zu schauen*.
Eine ungelöste Idee ist ein Hintergrundprozess. Jede davon erhebt
eine kognitive Steuer.

### Drei Operationen

Die zwei Transferrichtungen plus der Grund, warum sie existieren,
geben drei Operationen zwischen Gehirn und externem System:

1. **Wissen aufbauen.** Aus der Welt laden. Notizen sagen, wo du
   aufgehört hast, damit das Gehirn sich neu orientieren kann.
   Mittel, keine Zwecke.
2. **Ideen capturen.** Im Moment des Ankommens rausschieben. Kein
   Sortieren, keine Tags, kein „welcher Ordner“. Reine Evakuierung.
   Später verarbeiten.
3. **Ausführen.** Wissen und Ideen nehmen und etwas produzieren.
   Deshalb existieren 1 und 2. Ein aufwendiger Hort, der nie shipped,
   ist ein gescheitertes System.

### Der temporale Vertrag

Capture, dem das Gehirn nicht traut, ist schlechter als kein Capture:
du schreibst die Idee auf **und** hältst eine Hintergrundkopie, also
zahlst du doppelt. Alvar leiht den **temporalen Vertrag** vom Kanal
No Boilerplate (er sagt, er sei unsicher, wer den Begriff geprägt
hat). Zwei Regeln:

1. Jede flüchtige Idee geht in **einen** vertrauten Ort, sobald sie
   ankommt. Ein Platz. Null Routing-Entscheidungen. Null Reibung.
2. Du **wirst** revisitieren. Frequenz und Format sind deine Sache;
   die Verpflichtung ist es nicht. Das Gehirn gibt die Idee nur frei,
   wenn es glaubt, die Notiz taucht wieder auf.

Diese Schleife ist das Vertrauen: Present-you capturt, weil
Future-you revisitet; Future-you revisitet, weil Past-you alles
gefangen hat, das es wert war. Seine Analogie ist ein **Git-Commit**
— Zustand ist gespeichert, du gehst weiter.

### Ein Ordner ist das System

Die Umsetzung ist bewusst langweilig: ein Verzeichnis aus Textdateien.
Keine proprietäre Plattform, kein Abo. Obsidian ist „a file manager
that's got some markdown editing capabilities.“ Es ist **nicht** das
Second Brain. Dieselbe Architektur funktioniert mit Stift und Papier;
sie funktioniert ohne KI.

Wofür er Obsidian *wirklich* nutzt (Features, nicht Identität):

- **Links statt Ordner.** Ideen sind ein Graph, keine Hierarchie. Du
  entscheidest nicht vorher, wohin eine Notiz gehört. Struktur
  entsteht aus Verbindungen. Das ist der Anti-Reibungs-Zwilling von
  „ein Inbox“.
- **Flüchtige Notizen.** Eigener Raum für den temporalen Vertrag.
  Jetzt capturen, beim Revisit verarbeiten.
- **Community-Plugins**, die er im Vorbeigehen nennt: semantisch
  ähnliche Notizen (Embeddings), Kalender, Terminal, LaTeX-Snippets.
  Der Punkt, den er argumentiert, ist Formbarkeit, keine Einkaufsliste.
- **Klartext.** Portabel, zukunftssicher, jeder Editor, und **von KI
  lesbar** ohne API.

### Vault-Layout

Top-Level-Verzeichnisse folgen den drei Operationen, mit
griechischen Ordnernamen als Betonung (ASR ist hier matschig; die
englischen Labels zählen):

| Ordner | Operation |
| --- | --- |
| Domains | Wissen aufbauen |
| Thoughts | Ideen capturen |
| Projects | Ausführen |
| Vault management | Bilder, Templates, Inbox und der **AI**-Baum |

Der letzte Ordner ist die Naht zu Video A: Agenten leben neben der
Inbox, nicht in menschliche Notizen gemischt.

### KI als Effizienz, kein Ersatz

Alles oben predated LLMs. Was sich geändert hat, ist das
Wertversprechen: ein Agent *im* Vault hat den kognitiven Zustand —
was du gelernt hast, welche Ideen du gefangen hast, woran du
arbeitest. Rolle: **schneller werden**, nicht statt dir denken.

Über die drei Operationen:

| Operation | Job der KI |
| --- | --- |
| Wissen | Tutor kalibriert auf *deine* Notizen; neue Konzepte auf Modelle mappen, die du schon hast |
| Ideen | Gesprächspartner: herausfordern, erweitern, mit etwas verbinden, das du vor Monaten geschrieben hast |
| Ausführen | Aus Notizen draften, Lösungsräume schneller ausschöpfen |

Harte Caveat, wiederholt: **das Denken nicht abgeben.**
Herausfordern, mappen, explorieren — ja. Urteil und Geschmack bleiben
menschlich. Das LLM macht mechanische Umgebungsarbeit, damit das
restliche Context Window für Entscheidungen und Synthese draufgeht,
„that no LLM can replicate.“

### Scheinproduktivität

Schluss-Constraint: das System ist ein gutes Prokrastinations-Spielzeug.
Schöne Graphen, perfekte Ordner, Wikipedia-reife Notizen fühlen sich
nach Arbeit an und produzieren nichts. Obsidian ist „really
satisfying“, und genau das ist die Falle. **Wert misst sich daran, was
du damit produzierst.**

---

## Video: Obsidian and AI were made for each other

### Die Feedback-Schleife

A sagt explizit, die andere Hälfte von B zu sein. Die Schleife:

- KI gibt dem Vault **Execution Power**.
- Der Vault gibt der KI **totalen Kontext**.

Sobald Agenten ins Second Brain fused sind, ist Obsidian seine
Hauptoberfläche für KI — „a master operating system for pretty much
everything.“ Qualität des Outputs ist Qualität des Kontexts. Ein
Coding-Agent, der schon im Markdown lebt, macht das
„bring mich auf Stand“ selbst. Kein API: der Vault ist ein Ordner.

### Die Agenten-Garage

Ein generischer Assistent ist die schwache Form. Spezialisierte
Agenten für Workflows sind die starke Form, weil „AI is best when
it's focused into one thing.“ Der Umsetzungsreim: **Agenten sind
Ordner mit Markdown** — dasselbe Primitiv, das Obsidian schon ist.
Die Garage ist ein Verzeichnis, kein SaaS-Roster.

### Warum Pi, nicht Claude Code

Er fährt [Pi](https://github.com/mariozechner/pi-mono) als
Coding-Agent der Wahl; Claude Code „will work equally fine.“
Vorliebe:

- Voll anpassbar; er kann ihn formen.
- **Minimaler System-Prompt.** Der (~10k Token) Coding-Prompt von
  Claude Code ist „a bit redundant when we're not doing any coding,
  we're doing Obsidian stuff and thinking stuff.“

Jeder Coding-Agent geht; Pi wird wegen Kontrolle gewählt. Das ist
dieselbe Spaltung, die Vertragus schon gemacht hat: Pi ist ein
**Spawn-Overlay**, kein siebter Provider — siehe Handbuch Phase H.
Das Overlay existiert, damit Slots ihre Modell-Route behalten,
während der Prozess eine kleine, formbare CLI ist.

### Der AI-Inbox und die Vault-Grenze

Neben der normalen Inbox sitzt ein **AI-Inbox** — der Ort, der
Agenten speichert. Beispiel: ein General-Purpose-`chats`-Agent,
dessen `agents.md` der OpenClaw-System-Prompt ist, plus eine lokale
Constraint: **schreiben und editieren nur im AI-Inbox.** Menschliche
Notizen bleiben unverschmutzt. Er sagt das laut als Designregel,
nicht als Nice-to-have.

Er *liest* trotzdem den ganzen Vault (das ist der Hebel). Writes in
menschliche Notizen brauchen **explizite Erlaubnis** in der Session.
Link-Erzeugung in der Demo wartet auf diesen Grant; er schaut auf
den Graph, damit das Modell den Knowledge Graph nicht still
umschreibt.

Das ist die PKM-Version von „Worker laufen in Worktrees; Promote ist
ein Klick.“

### Spezialisierte Agenten in der Demo

| Agenten-Ordner | Job | Lokale Extras |
| --- | --- | --- |
| `chats` | Allgemeiner ChatGPT-Ersatz, aber mit Vault-Suche | OpenClaw `agents.md` + Write Boundary |
| Persönliches OpenClaw | „Based on everything you know about me…“ | Gespiegelte `SOUL.md` / `USER.md` (Dateinamen aus Captions; er zensiert den Read-out) |
| Vault / Link-Finder | Fehlende Links zwischen Notizen finden | Verstecktes `.pi`-Skill, Python-Scanner, **Sub-Agenten zum Verifizieren**, dass ein Treffer eine echte Verbindung ist und nicht dasselbe Wort |

Der Link-Finder ist die harness-ähnlichste Scheibe: Suche ist billig,
Verifikation ist ein zweiter Pass, Edits sind gegated. Er spielt sogar
Embeddings/Cosine Similarity als *anderen* Matching-Workflow an — und
behandelt ihn nicht als Pflicht.

### YouTube-Zusammenfassungen

Eigenes `agents.md` plus ein Python-Skript, das das Transkript holt.
Link pasten; billiges Modell wählen (Gemini; Opus ist „overkill“). Er
ist pingelig beim **Format**, nicht beim Vibe:

1. Überblick über das ganze Video
2. Abschnittsstruktur
3. **Schlüsselkonzepte** — vor allem, damit er später Wiki-Links
   bilden kann. Weicht die Definition des Creators vom etablierten
   Wort ab, den Unterschied notieren **und die Creator-Definition
   priorisieren**
4. Reine **Argumentstruktur** aus dem Talk

Output ist eine Markdown-Datei im Vault. Host der Summary ist der
Ordner, kein Chat-Transkript, das verschwindet.

### Outlier-Finder

Ein zweites YouTube-Tool, mit eigenem Skill. Ziel: Videos, die
**spürbar besser als die erwartete Baseline dieses Kanals** liefen,
adjustiert um die Laufzeit. Flow, den er demot:

1. Kurzer Prompt („find outliers in the AI agents niche“)
2. Agent liest das Skill
3. Findet ein Seed-Video
4. Läuft die Recommended-Page
5. Analysiert Kanäle
6. Schreibt einen Report mit Thumbnails (Beispiel: 62×-Outlier)

Er sagt, diese Job-Klasse **braucht einen Orchestrator** — Suche ist
kein einzelner Completion. Outputs landen in Obsidian, weil dort der
Rest der Arbeit schon ist.

### Kalibriertes Tutoring

Prompt-Muster: „Go through my math notes. Get a grasp of my current
level. Explain the Riemann hypothesis assuming I know everything in
the notes; motivate anything beyond.“ Zwei Sub-Agenten parallel. Der
Schmerz, den er live trifft: **LaTeX in der Terminal-UI** ist
unlesbar; er pastet nach Obsidian (und erwähnt eine noch nicht
aktivierte Extension). Die Lektion ist **Kalibrierung auf vorhandene
Notizen**, nicht Mathe als Produktfeature.

### Eine Oberfläche, zwei Fenster

Schluss-Pitch: eine Oberfläche für alle KI-Arbeit; aufhören, Web-UIs
zu jonglieren. Er mag **Obsidian und das Terminal als getrennte
Fenster**. Er nennt ein Community-Plugin für ein integriertes
Terminal und zeigt es als optional, nicht als Architektur.

---

## Abbildung auf Vertragus

### Schon im Code

Alvars Primitive haben schon ein Host-Gegenstück. Das Mapping sind
*Jobs*, keine UI-Klone.

| Alvar | Vertragus heute | Wo |
| --- | --- | --- |
| Gehirn soll den eigenen Zustand nicht bookkeepen | Host besitzt Lifecycle, Fragen, Tasks, Git-Fakten | `eventQueue`, `PendingQuestions`, `taskBoard.ts`, `inspect_agent` |
| Wissen rein (gedeckelt, dauerhaft) | Briefing aus `AGENTS.md` / `CLAUDE.md` / `README.md`, letzte Commits, `repoNotes` | `Workspace`-Briefing, `retro.ts` |
| Ideen raus / ein Inbox | Composer `user_message`, `ask_user`, `task_create` — ein Host-Pfad, kein Second Brain, das in die TUI tippt | README-Handshake; Handbuch D / H.2 |
| Revisit-Verpflichtung | Journale, `search_runs`, Resume-Briefing, Retro-Learnings | `journal.ts`, `searchRuns.ts`, E3 |
| Git-Commit-Capture | `snapshotDone` committet den Worktree auf `report_done`; Branch überlebt | `worktree.ts` — kein Autodelete |
| Agenten als Ordner mit Markdown | Jeder Agent ist Worktree plus Rollenprompt plus Contract; Pi-Wrap schreibt `.pi/APPEND_SYSTEM.md` | `roles.ts`, `contract.ts`, `piHarness.ts` |
| Spezialisierte Agenten | Slots und Builtin-Rollen (Worker, Reviewer, Tester, Architect, Docs, Janitor, Explorer) | `profile.ts`, `roles.ts` |
| Write Boundary / keine Verschmutzung | Pflicht-Worktrees unter `.vertragus/worktrees/<id>`; Checkout wird nicht geteilt | `worktree.ts` |
| Explizite Erlaubnis, „echte“ Notizen anzufassen | `integrate_branch` + Promote-Klick; `autoIntegrate` / `autoPromote` default **aus** | Handbuch E1 / A3 |
| Sub-Agent, dann verifizieren | `start_agent` + `inspect_agent` / Host-Fakten auf `agent_done`. Complete auf dem Task-Board ist eine **Orchestrator**-Entscheidung nach Verify | G4 Task-Board |
| Denken nicht abgeben | `yolo` / `ask-user` / `ask-orchestrator` | D4 |
| Skills und Extra-Tools | `extraMcp` nur auf **Workern**; Playbooks sind **Goal-Templates**, nie eine vorstartete Crew | E6, `profile.ts` |
| Browser-förmige Recherche (Outlier-Walk) | First-Party `/browser` auf dem bestehenden Listener, kein zweites MCP | Phase H, [`CHROMIUM-EXTENSION.md`](./CHROMIUM-EXTENSION.md) |
| Pi für einen kleinen Prompt | Pi-Wrap-Overlay; Slots bleiben Claude / Cursor / Codex / Kimi / Grok / Ollama | Handbuch Phase H Pi-Wrap |
| Wert = was gelandet ist | Isolation bleibt bis Promote; Retros scoren Läufe; kein RAG-Hort | Handbuch-Non-Goals |
| Anti-Wikipedia-Notizen | Briefing ist gedeckelt und als untrusted gelabelt; `repoNotes` max. 20, vom Nutzer löschbar | `MAX_REPO_NOTES_PER_PROFILE` |

Die README-Zeile „there is no second brain typing into the TUI“ ist
eine **andere** Verwendung der Phrase: sie heißt „forke den Turn des
Orchestrators nicht, indem du in ein geparktes PTY tippst.“ „Second
brain“ nicht als Panel-Label wiederverwenden. Die Kollision ist
terminologisch, nicht architektonisch.

### Spannungen mit der Doktrin

Das sind die Stellen, an denen das Video zu kopieren das Handbuch
bekämpfen würde.

1. **Geteilter Ordner vs. Pflicht-Worktrees.** Alvars Agenten `cd`
   in ein Vault-Unterverzeichnis und lesen/schreiben denselben Baum,
   den der Mensch sieht (mit prompt-level Write Fence). Vertragus hat
   keinen Shared-Checkout-Modus. Das trägt Last: parallele Agenten
   dürfen einander nicht über den Haufen rennen. Vault-als-Profil
   geht trotzdem — **wenn der Vault ein Git-Repository ist** — aber
   jeder Agent sieht eine Worktree-Kopie unter
   `.vertragus/worktrees/`, nicht die Obsidian-Working-Copy.
2. **Git ist ein Tor.** Profile brauchen einen Repo-Pfad. Ein Vault,
   der „nur ein Ordner“ ist, kann kein Vertragus-Profil sein, bis
   `git init`. Das ist akzeptabel. Es ist kein Grund, einen
   Nicht-Git-Modus zu bauen.
3. **Den-ganzen-Vault-lesen vs. kein RAG.** Worker können ihren
   Worktree greppen. Das Orchestrator-Briefing ist absichtlich
   gedeckelt. Semantische „ähnliche Notizen“-Plugins und
   Embedding-Indizes sind das RAG-förmige Ding, das das Handbuch als
   Non-Goal listet. Keinen Vector Store bauen „weil Obsidian Smart
   Connections hat.“
4. **Write Fence in `agents.md` vs. uneingeschränkte Worker.** Worker
   sind nicht tool-caged; Disziplin ist der Contract.
   Host-erzwungene Pfad-Allow-Lists wären ein zweites
   Security-Produkt. Der Worktree *ist* der Zaun. Promote ins
   menschliche Checkout bleibt ein Klick (oder ein expliziter
   Automatisierungs-Schalter).
5. **Agenten-Garage als Produkt.** Ordner-pro-Agent in Obsidian ist
   sein OS. Vertragus' OS ist das Panel, die MCP-Allow-List und
   Slots. Kein PKM-Chrome züchten (PARA, Daily Notes, Graph-View).
6. **OpenClaw-Identitätsdateien.** `SOUL.md` / `USER.md` als
   persönlicher Companion grenzt an Retro-Learnings, ist kein Ersatz.
   Wir pushen schon eine gedeckelte Insight-Liste. Wir bauen keine
   Seele.
7. **Tiefe und Fan-out.** Seine Pi-Session spawnt „a lot of
   sub-agents“ aus einem Ordner. Vertragus capppt Helper
   (`MAX_HELPERS_PER_WORKER = 3`), verbietet Lead-startet-Lead und
   hält Enkel-Events aus der Root-`await_events`-Queue.
8. **Playbooks, die Crews spawnen.** Seine spezialisierten Ordner
   sehen aus wie vorstartete Teams. Handbuch-Non-Goal: Playbooks
   füllen das **Goal-Feld**; der Orchestrator entscheidet weiter, wen
   er startet.

### Was wir nicht bauen

- Ein Obsidian-Plugin, ein Vault-Produkt oder „Vertragus als Second
  Brain“
- Vektorsuche / Embeddings / „fehlende Links“ als Host-Tool
- Ein YouTube-Transkript-Tool auf der Orchestrator-Allow-List
- Filesystem-Write-Scopes für Worker (der Worktree ist der Scope)
- OpenClaw / `SOUL.md` als Provider oder Builtin-Rolle
- Automatische Inbox-Prozessoren (das ist ein **Goal**, kein Daemon)
- Eine zweite Kanban-, DAG- oder PARA-Engine (das Task-Board ist die
  Capture-Schicht; behalten)
- UI-Copy, die das Panel ein „Second Brain“ nennt (kollidiert mit der
  TUI-Handshake-Warnung)
- Isolation senken, damit Agenten das Obsidian-Checkout in place
  editieren

### Was wir ohne neues Produkt mitnehmen können

Nur Usage und Doku — keine neuen MCP-Verben.

**Vault als Profil (Rezept).** `git init` auf dem Vault, falls nötig.
Ein Profil-`repoPath` darauf zeigen. `.vertragus/` in Git **und** in
Obsidians excluded files ignorieren, damit Worktrees den Graph nicht
verschmutzen. `autoPromote` aus: das menschliche Checkout bleibt die
vertrauten Notizen; Promote ist der Revisit des temporalen Vertrags,
der zurückschreibt. Pi-Wrap an, wenn die Arbeit Denken/Markdown ist
statt eines 10k-Token-Coding-Prompts.

**Capture vs. Complete.** `task_create` als Regel 1 des temporalen
Vertrags behandeln (ein Ort, kein Routing). `complete` als Regel 2
nach `inspect_agent`, nie als Selbst-Report des Workers. Das ist
schon G4. Das Video ist ein Grund, es zu behalten, kein Grund, es zu
wachsen.

**Playbooks als Goal-Text.** „Paste a YouTube URL and write a note
under `Domains/` with overview, structure, creator-priority
definitions, and argument skeleton“ ist ein Playbook-String. Der
YouTube-Fetch bleibt ein Worker-Skript oder Extra-MCP, das der Nutzer
anhängt — kein First-Party-Tool.

**Docs-Rolle / Explorer, keine neuen Builtins.** Kalibriertes Tutoring
und Link-Finding sind Goals für vorhandene Rollen. Ein „Tutor“- oder
„Scribe“-Template wäre Catalogue-Creep, außer jemand fährt dieses
Profil wirklich.

**Formatkontrolle schlägt Vibe-Summaries.** Wenn ein Lauf Talks oder
RFCs *doch* ingestet, den Extract (Struktur, Definitionen, Argumente)
in der Assignment spezifizieren. Alvars YouTube-Agent ist ein
Prompt-Contract, den wir schon schreiben können.

**Pi-Wrap-Begründung, laut gesagt.** Alvars Grund für Pi (kleiner
Prompt, formbar, kein coding-only System-Prompt) ist die beste
externe Erklärung, warum der Wrap kein siebter Provider ist. Den
Satz in der Pi-Settings-Copy lassen, wenn er noch nicht da ist; das
Overlay nicht aufblasen.

---

## Benachbarter Kontext

Nicht in den zwei angefragten Videos; nützlich, damit diese Recherche
nicht so tut, als wären sie der ganze Kanal:

- *How I Use AI to Learn Things* (https://www.youtube.com/watch?v=kzcI5F4tGiU)
  — derselbe Autor, Pi + Obsidian-Lehrschleife (proben, planen, ein
  Schritt nach dem anderen). Community-Skill-Pack
  `vasanthsreeram/Alvarmethod` portiert diese Schleife auf mehrere
  CLIs. Weiter kein Vertragus-Track.
- OpenClaw-`agents.md` / Memory-Dateien sind ein fertiger
  Personal-Agent-Prompt, den er kopiert und dann fenced. Wir haben
  Rollenprompts und einen Contract stattdessen.
- No Boilerplate wird für die Temporal-Contract-Formulierung credited;
  Alvar ist unsicher, wer sie geprägt hat. Als benannte Idee
  behandeln, nicht als Spec, die wir implementieren müssen.

---

## Einschränkungen

- Captions, kein Studio-Skript. Wahrscheinliche ASR: „PDE links“ =
  Wiki-Links; „personal consoler“ = Counsellor; „our layers“ =
  Outliers; griechische Ordnernamen waren nicht als genaue
  Identifiers rekonstruierbar.
- Plugin-Namen in B werden angedeutet („this one embeds notes in a
  vector database“) ohne Marketplace-IDs. Nicht als Einkaufsliste
  behandeln.
- Demos sind sein Vault, seine YouTube-Kanäle, seine Mathe-Notizen.
  Die übertragbare Schicht sind die drei Operationen, der temporale
  Vertrag, die Write Boundary und „Agenten sind Ordner.“ Der
  Outlier-Finder und die Riemann-Session sind Existence Proofs.
- Nichts hier autorisiert ein Handbuch-Non-Goal. Sieht eine spätere
  Änderung aus wie RAG, ein zweites Produkt, Shared Checkout oder
  Autodelete, ist das nicht „what Eero would do“ — das ist ein
  Doktrin-Bruch.
