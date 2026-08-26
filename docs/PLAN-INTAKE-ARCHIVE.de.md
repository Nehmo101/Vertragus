Deutsch | [English](PLAN-INTAKE-ARCHIVE.md)

# Intake, Scout und das Lauf-Archiv

Stand: 26. August 2026. Kein Programcode in dieser Änderung.

Spezifiziert drei Produktkanten, die noch auf der bestehenden Schleife
sitzen: **Intake, bevor das Team startet**, eine **Scout**-Rolle für
codegestützte Rekonstruktion, und eine **Timeline archivierter Läufe**,
die der quadratische Stop-Knopf heute als UI wegwirft. Copy-paste-fähiger
Umsetzungs-Prompt: [`PROMPT-INTAKE-ARCHIVE.md`](PROMPT-INTAKE-ARCHIVE.md).

Doktrin bleibt [`HANDBOOK-HARNESS.md`](HANDBOOK-HARNESS.md): ein Host-Pfad,
kein zweites Produkt, kein Autodelete, kein Peer-to-Peer, kein RAG, kein
Cloud-Runner, keine DAG-Engine. Nachbar-ADEs stehen in
[`RESEARCH-LANDSCAPE.md`](RESEARCH-LANDSCAPE.md). Dieser Plan ist ein
eigener Track neben [`PLAN-LANDSCAPE.md`](PLAN-LANDSCAPE.md) (Review,
Sandbox, Presets) und neben C7
([`MODEL-PROVIDER-SWITCH.md`](MODEL-PROVIDER-SWITCH.md)).

Größen sind **S / M / L** (Dateien und Risiko), keine Kalenderzeit.

Quellen für die visuellen und Factory-Ideen:

- Operator-Screenshots eines ADW-Dashboards (Kartenraster mit Gantt
  pro Agent) und eines Session-Waterfalls (Request / Plan / Build
  plus Event-Inspektor).
- IndyDevDan, *My Super Simple Software Factory (For Agentic
  Engineers)* ([YouTube](https://www.youtube.com/watch?v=haUfb1ievTE)).
- [`disler/super-simple-software-factory`](https://github.com/disler/super-simple-software-factory)
  (Skill + Templates; Visualizer auf dem Branch `example`).

---

## Status

| Stück | Stand |
| --- | --- |
| Intake-Schleife (fragen bis AC + DoD, oder überspringen) | **Spec** — Prompt + `ask_user`-Text; kein neues MCP-Tool |
| Scout-Builtin-Rolle | **Spec** — achte mitgelieferte Rolle, Slot opt-in |
| Archiv gestoppter Läufe | **Spec** — Journale persistieren schon; das Panel hat keine Tür |
| Timeline-Ansicht | **Spec** — Projektion über `events.jsonl`, keine zweite DB |
| SSSF-Python-ADW-Graphen | **ablehnen** — Handbook-Non-Goal (zweite Orchestrierung) |
| Token-/Dollar-Zähler als Host-Wahrheit | **ablehnen** — Wanduhr ist das Budget; nur vendor-zugestandene Nutzung |

---

## Doktrin

Neue Kraft ist ein **Host-Tool, Event, IPC-Verb oder eine
Panel-Oberfläche** in der bestehenden Schleife. Intake ist
**Prompt-Disziplin** auf dem Orchestrator, der `ask_user` und das
Task-Board schon hat. Die Timeline ist ein **Lesen des Journals, das
der Host schon schreibt**. Scout ist ein **Rollen-Template plus Slot**,
kein vorgestartetes Team und keine zweite Control-Plane.

- Host-Wahrheit vor Agenten-Prosa. Diffs und „was sich geändert hat"
  kommen aus Git gegen das Agent-Worktree. Dauer kommt aus Event-`ts`.
  Ein Pull Request kommt aus dem Event `pull_request`. Verschachtelte
  Helper kommen aus `parentId` auf dem Event, nicht aus einem Transkript.
- `ask_user` / `answer_question` bleiben der einzige Pfad, der den
  Menschen parkt. Intake-Antworten nicht in eine geparkte
  Orchestrator-TUI tippen.
- Playbooks bleiben **Ziel-Templates**. Der Orchestrator entscheidet
  weiter das Team. Eine benannte SDLC-Kette in Python ist das
  Factory-Produkt, das dieses Repo ablehnt.
- Worker committen weiter nie. Promote bleibt ein Klick des Menschen
  (oder die bestehenden Automation-Host-Merges).
- Fail-loud bei Contract-Fehlern, fail-soft bei Disk-Extras (dieselbe
  Form wie `journal.ts` / `resume.ts`).
- Tests sitzen neben dem Subject. Der Coverage-Ratchet geht nicht
  runter.
- User-facing Strings: Renderer-i18next **en+de**,
  `src/shared/mainMessages.ts`, `src/remoteClient/i18n.ts` — immer
  beide Locales. Docs: englisches Canonical plus deutsches Twin.

---

## Was schon existiert (nicht neu bauen)

| Bedarf | Schon im Code |
| --- | --- |
| Den Menschen fragen und blockieren | `ask_user` + `PendingQuestions` + Panel-Badge + Phone (`answer_question`) |
| Ziel beim Play seeden | H2 `workspaces:start {goal}` / Nachtrag `workspaces:goal` |
| Dauerhafter Plan außerhalb des Modells | Task-Board (`task_create` / `tasks.json`), überlebt Succession und Resume |
| Selbstständige Worker-Aufträge | `start_agent`-Task-Contract: Ziel, Dateien, Definition of Done, wie prüfen |
| Handoff zwischen Agenten | C4 `baseBranch` + Handoff-Block aus `agent_done` |
| Strukturierte Reports | G3 `start_agent{resultSchema}` |
| Code-Karten-Rolle | **Explorer** — Map mitten im Lauf, `CHANGE NOTHING` |
| Volle Event-Historie | `.vertragus/runs/<workspaceId>/events.jsonl` + `meta.json` + `tasks.json` |
| Subtree-Events in diesem Journal | `WorkspaceManager.onLeadCreated` zapft Lead- **und** Worker-Nest-Queues |
| Stop behält Artefakte | `stopWorkspace` schließt Prozesse; es **löscht** das Run-Verzeichnis nicht |
| Briefing des neuesten Laufs | E3 Resume — neuer Orchestrator, alte Prozesse sind weg |
| Learnings-Liste | Retro-Ausklapp unter dem Profil (gedeckelt, keine Timeline) |
| Run-Ordner öffnen | `workspaces:openRunFolder` / `revealRunFolder` |
| Alte Journale suchen | root-only `search_runs` |
| Live-Nesting auf der Karte | `parentId` auf `WorkspaceSummary.agents` via `mcp.agentParent` |
| PR für den Lauf | Event `pull_request` + Kartenzeile (Automation `autoPr`) |
| Wanduhr-Budget | `maxRuntimeMin` / `budget_warning` |

Das Loch ist nicht „wir haben keine Historie". Das Loch ist: **das
Panel vergisst die Karte**, **Events tragen kein `parentId`**, **dem
Orchestrator wird gesagt, er solle ein dünnes Ziel nicht klären**, und
**es gibt keinen Scout für Intake**.

---

## Screenshot-Lesart

### Das Archiv-Raster

Sechs dunkle Lauf-Karten. Jede zeigt eine kurze Id, einen
Workflow-Namen (`adw_simple_sdlc`, `adw_build_test`, …), den
Task-Satz, ein Gantt der Agent-Spuren gegen Wandzeit, eine grüne
Success-Pille, einen Zeitstempel, dann Footer-Metriken (Geld, Dauer,
eine große Token-Zahl). Eine Karte sagt `+2 more agents`, wenn das
Roster die Spurenliste sprengt.

Was die Karte wirklich sagt: **welche Rollen gearbeitet haben, in
welcher Reihenfolge, wie lange, und ob der Lauf akzeptiert wurde.**

### Die Session-Timeline

Titel *Super Simple Software Factory*. Session `ad066baa`, Phase
`request`, Live-Punkt. Summary-Leiste: die Frage, Success, Startzeit,
Dauer, Kosten, Token-Split. Linke Leiste: der Engineer, dann Planner
und Builder mit Modell und Context-Balken. Mitte: horizontale Zeit mit
drei **Phasen-Blöcken** (Request, Plan, Build) und Pfeilen dazwischen.
Unten: Inspektor für die gewählte Phase — Events (`phase_start`,
`log`, `phase_end`) plus Owner-Metadaten.

Was die Detailansicht wirklich sagt: **ein Lauf, drei Arten von Arbeit
(Mensch / Agent / Code), Block klicken, Events lesen.**

### Was Vertragus übernimmt

- Ein **Raster vergangener Läufe**, das Stop überlebt, geöffnet vom
  Profil (das Quadrat hat die Live-Karte schon beendet).
- Dieselbe Ansicht **startbar von einer laufenden Workspace-Karte**.
- **Agent-Swimlanes** gegen `ts`, nicht gegen eine Vendor-TUI.
- **Verschachteltes Overflow** (`+N more`) für Helper unter Workern
  unter Leads.
- Ein **Inspektor**: Spur oder Span wählen, starke Zusammenfassung,
  Host-Fakten und die zugehörigen Events zeigen.
- Abgeleitete **Kapitel** (Intake, Implement, Review, Integrate, PR)
  aus Events und Task-Board — Labels für Menschen, keine neue
  Phasenmaschine.

### Was Vertragus ablehnt

- Dollar-Kosten und Millionen-Token als **Host-Wahrheit**. Das Budget
  ist Wanduhr (`maxRuntimeMin`). Landscape-Track T1 ist eindeutig:
  niemals Token-Zahlen erfinden; nur vendor-zugestandene Nutzung
  zeigen. Dauer ist `lastEvent.ts - meta.startedAt`.
- Einen **Factory-DAG** (benannte ADW-Skripte, die einen festen
  Planner-dann-Builder-Graphen spawnen). Playbooks füllen das
  Zielfeld; der Orchestrator wählt weiter das Team.
- `phase_start` / `phase_end` als zweites Event-Vokabular. Das Journal
  hat schon `user_question`, `agent_started`, `agent_done`,
  `integrate_ok`, `pull_request`.
- Eine zweite SQLite-Visualizer-App (Vue + Bun auf Port 4600). Eine
  Projektion über `events.jsonl`, gerendert im Electron-Panel.

---

## Super Simple Software Factory

### Quellen

Video und GitHub-Skill sind dasselbe Produkt. Die Screenshots sind
dessen UI. Das README sagt die These in einem Satz: **Code besitzt
Sequenz, Retries und Acceptance; Agenten besitzen nur die Arbeit
innerhalb einer begrenzten Phase.** „Agent proposes, code disposes."

v1 fährt den Pi-Coding-Agent, stempelt `adws/` ins Zielrepo, streamt
jedes Event nach `adws/adw_data/sssf.db` (WAL-SQLite) und liefert fünf
Roster-Namen: `planner`, `builder`, `scout`, `reviewer`,
`documenter`. Es gibt keinen Tester-Agenten — `bun test` ist eine
Phase `kind=code`. Der Visualizer ist ein read-only Poll dieser DB
(Live und Historie sind dieselbe Query `rowid > ?`).

Der Skill-Orchestrator (`SKILL.md`) soll **die ADWs listen und
warten**. Er darf kein Status-Board volunteerieren, das Repo nicht
inventarisieren und keine ADW-Arbeit selbst tun. Ein separates
Cookbook, `how_to_prompt_for_the_eng.md`, wird **vor jedem Launch**
gelesen: den Satz des Engineers in einen Vier-Zeilen-Prompt drehen
(ask / where / done means / out of scope). Spezifisches zitieren.
Den Plan nicht schreiben. Nicht aufpolstern. Den Prompt zeigen, der
wirklich rausging.

### Was SSSF tatsächlich ist

| SSSF-Teil | Was er tut |
| --- | --- |
| ADW-Skript | Dünnes Python: `run.phase(...)` dann `ph.call(...)`; 12 Starter-Ketten |
| Roster-YAML | Ein Agent, ein Zweck, ein Modell, Grenze `writes:`, optionaler Harness |
| Envelope | Typisiertes JSON (`status`, `summary`, `notes_for_next_agent`, Artefakte) |
| Gates | Code nach dem Call: Dateien existieren, Tests grün, Diff matcht Claims |
| Korrektur | Dieselbe Pi-Session neu prompten; nie ein kalter Restart |
| Scout | Read-only-Recon; zitiert Pfade; darf read-only Helper spawnen; schreibt `scout_findings.md` + `ScoutOutput` |
| Trace | `parent_id` nestet Spans; Tool-Calls auf eine Zeile gefaltet; Sessions-Tabelle |
| Engineer-Lane | Die eingehende Frage ist eine First-Class-Phase, keine Logzeile |
| Permissions | Nach jedem Call werden unautorisierte Git-Writes zurückgerollt |

Ehrliche Lücken, die SSSF selbst nennt: es läuft auf dem **aktuellen
Branch**, es gibt **keine Sandbox**, **keinen Merge-Schritt**, **keine
Human-in-the-Loop-Freigabephase**, und `claude_code` ist gestubbt.
Genau diese vier hat Vertragus schon (Worktrees, Promote, `ask_user`,
viele CLIs).

### Ideen, die sich lohnen

Jede Idee auf einen Host-Pfad legen, den wir schon besitzen, oder auf
eine kleine Prompt-Änderung — nicht auf einen Python-Graphen.

| SSSF-Idee | Vertragus-Übernahme |
| --- | --- |
| **Intake als erste Phase** (Engineer-Lane, dann ggf. Scout, dann das Team) | Orchestrator-Loop Schritt 0: AC + DoD schließen vor `start_agent` (außer Scout) |
| **Vier-Zeilen-Brief** (ask / where / done means / out of scope) | Umformulierte Assignment, die der Orchestrator aufs Task-Board und in jeden `start_agent`-Task schreibt |
| **„Intent is theirs, precision is yours"** | Klären und ordnen; nie still eine Constraint streichen; nie die Idee upgraden |
| **Den Prompt zeigen, der rausging** | Nach Intake sieht der User den Brief (Panel-Taskliste / Timeline-Kopf) — Host-Wahrheit, kein Chat-Claim |
| **Scout vor Fragen über den Code** | Builtin-Rolle Scout; nur wenn das Profil einen Scout-Slot hat |
| **Ein Agent, ein Zweck** | Schon die Rollen-Templates; Scout darf kein zweiter Explorer werden |
| **Typisiertes Envelope + Korrektur in der Session** | Schon G3 `resultSchema` und `ask_orchestrator` / Follow-up `send_to_agent` |
| **Handoff-Notizen für den nächsten Agenten** | Schon C4-Handoff-Block; Scout-`result` soll `findings[]` tragen |
| **Code besitzt bekannte Kommandos** | Tester/Janitor als Rollen behalten; der Orchestrator soll **nicht** `pnpm test` fahren. Optional später: Host-Quality-Gate (Landscape W2), nicht dieser Track |
| **Gates prüfen Claims hinterher** | Schon `inspect_agent` + Host-Fakten auf `agent_done`. Intake-DoD **benennt** die Kommandos, die ein Tester fahren soll |
| **Dieselbe Query für Live und Historie** | Timeline-Projektion liest das Journal, während der Lauf lebt und nach Stop |
| **`parent_id` auf Spans** | `parentId` auf `agent_started` (und auf der Live-Summary behalten) |
| **Phasenbeschreibung ist ein Satz Absicht** | Swimlane-/Kapitel-Label aus Task-Subject oder Rollenprompt, nie `"plan: Plan"` |
| **Kein Dashboard beim Start volunteerieren** | Orchestrator ohne Ziel wartet weiter; mit dünnem Ziel fragt er, er fängt nicht an zu kodieren |
| **Subagenten des Scouts** | Schon erlaubt: Worker dürfen eine Helper-Ebene spawnen. Scout ist ein Worker. Helper bleiben read-only, weil Scouts Rolle Writes verbietet |

### Ideen, die wir ablehnen

| SSSF-Idee | Warum sie draußen ist |
| --- | --- |
| Python-ADW besitzt den Graphen | Handbook: keine zweite Orchestrierung als Produkt (Kanban, DAG, Cloud-Runner) |
| Zwölf gestempelte Workflow-Dateien im User-Repo | Playbooks sind Zieltext; Slots bleiben ein Bauplan |
| SQLite `sssf.db` + Bun-Visualizer als Trace | Wir journalen schon JSONL; ein zweiter Ingest-Pfad sind zwei Wahrheiten |
| Token- und Dollar-Summen als Karten-Footer | Der Host sieht billed Tokens nicht ehrlich; Wanduhr ist das Gate |
| „Höchstens eine Frage; sonst annehmen" | Der User *dieses* Produkts hat das Gegenteil verlangt: wenn etwas fehlt, **immer** fragen, Scrum-förmig, bis AC + DoD zu sind. Annahmen, die den Code kippen würden, sind `ask_user`, keine stillen Defaults |
| Orchestrator darf die Anwendung nie lesen | Vertragus lässt den Root schon HEAD lesen. Scout ist für **nicht triviale** Recon, damit der Root nicht ertrinkt. Mini-Pfadchecks bleiben ein Read |
| Read-only nur durch Rollback hinterher erzwungen | Prompt-`CHANGE NOTHING` plus Worktrees behalten. Ein nachträgliches `writes:`-Rollback auf dem User-Checkout ist ein anderes Produkt (SSSF hat kein Worktree) |
| Resume = dieselbe Pi-`--session-id` fortsetzen | E3 Resume ist ehrlich: neuer Prozess, Briefing, alte Tickets tot. Nicht so tun, als käme die CLI zurück |
| Factory-Skill in jedes Repo gestempelt | Vertragus ist der Host; `.vertragus/` ist der Lauf-Record, kein zweites Framework im Projekt |

Die Zeile aus dem Video, die für uns zählt, ist nicht „baue eine
Software Factory". Es ist **Agenten plus Code plus Engineer, zum
richtigen Zeitpunkt**, mit einem Trace, den man beim hundertsten Lauf
lesen kann. Vertragus hat Isolation, HITL und Multi-CLI schon auf den
Host gelegt. Dieser Track legt **Intake**, **Scout** und **ein
lesbares Archiv** daneben.

### Scout in SSSF gegen Explorer hier

Explorer ist schon da. Er kartiert unbekanntes Terrain **während**
eines Laufs. Scout in SSSF ist **Intake-Recon**: finden, wo die Frage
lebt, Pfade zitieren, nichts ändern, optional read-only Helper
auffächern, eine strukturierte Finding-Liste zurückgeben, damit die
nächste Phase nicht rät.

Wir nehmen Scout als **achte Builtin-Rolle**, weil der User diesen
Namen verlangt hat und weil der Job ein anderer ist:

| | Explorer | Scout |
| --- | --- | --- |
| Wann | Mitten im Lauf, Worker oder Lead braucht eine Karte | Bevor das Team startet, der Orchestrator braucht Fakten, um AC/DoD zu schließen und Assignments zu schreiben |
| Output | Eine Karte nach Frage, mit Koordinaten | Findings, die der Brief zitieren kann: Pfade, Symbole, was **nicht** da ist |
| Typisches Modell | Billig, schnell | Dasselbe — mechanische Recon, keine Architektur |
| Slot | Nur wenn das Profil einen `explorer`-Slot hat | Nur wenn das Profil einen `scout`-Slot hat („wenn eingerichtet") |
| Helper | Eine Extra-Ebene, wenn der Worker nesten darf | Dieselbe Host-Regel; Scouts Prompt hält sie auf read-only |

Explorer nicht löschen. Keinen Scout-Slot in bestehende Profile
auto-einfügen (`createEmptyProfile` bleibt `slots: []`). Das
mitgelieferte Template plus `INITIAL_ROLE_PROMPTS.scout` existieren,
damit der Editor einen Slot anlegen kann. Steht Scout nicht unter
`Available roles`, darf der Orchestrator die Id nicht erfinden.

Fallback ohne Scout-Slot: der Root darf den eigenen HEAD für kleine
Fakten lesen; existiert ein Explorer-Slot, darf er Explorer für eine
Karte starten; Produkt- und Scope-Lücken gehen weiter an `ask_user`.
Nie einen Worker starten, der „nur mal schauen" soll.

---

## Track I — Intake der User-Anfrage

### Die Lücke

Heute sagt der Orchestrator-Prompt:

1. Das Ziel in Tasks brechen und die Agenten starten.
2. `ask_user` ist **nur** für Scope-Änderungen, destruktive Aktionen,
   Produktentscheidungen.

Die `ask_user`-Tool-Description wiederholt diese Einschränkung. Ein
dünnes Ziel wird deshalb ein ratendes Team. Das ist der Fehler, den
der User benannt hat.

SSSF's Engineer-Cookbook ist das andere Extrem: höchstens eine Frage,
sonst annehmen. Wir nehmen den **Vier-Zeilen-Brief** und lehnen das
Schweigen ab.

### Die Intake-Schleife

Neuer Schritt 0, **bevor** Worker / Reviewer / Tester / Docs /
Architect / Janitor / Lead:

1. Das Ziel (und das Repo-Briefing) lesen. Listen, was schon steht.
2. Existiert ein Scout-Slot und die restlichen Lücken enthalten „was
   tut der Code / wo lebt das", Scout auf einem billigen Slot starten.
   Auf `agent_done` warten. Findings zitieren; das Transkript nicht
   pasten.
3. Ziel + Scout-Findings gegen die AC+DoD-Checkliste unten diffen.
   Jedes Loch ist eine Frage an den Menschen, keine Annahme.
4. Gibt es Löcher: **ein** `ask_user`, der sie bündelt (nummeriert).
   Nicht acht Tickets tröpfeln. Öffnet die Antwort ein neues Loch,
   eine weitere Runde. Ticket-Resume bleibt wie heute.
5. Gibt es keine Löcher: **nicht fragen**. Den Brief trotzdem
   schreiben.
6. Den Brief aufs Task-Board legen (Host-Wahrheit). Dann die
   bestehende Schleife: ein Task pro `start_agent`, selbstständige
   Assignment.

Scout ist der einzige Agent, der während Intake starten darf. Leads
und Worker warten.

Ein Goal-Nachtrag (`workspaces:goal`) ist ein erster Turn — Intake
darauf fahren. Ein späteres `user_message` ist Steering, kein zweites
Intake, außer der User ändert explizit den Scope (dann `ask_user` wie
heute).

### Scrum-Fragen

Fragen zielen auf **Acceptance Criteria** und **Definition of Done**,
nicht auf Implementierungsgeschmack.

**Acceptance Criteria** (beobachtbar, Given/When/Then oder Checkliste):

- Für wen, und auf welcher Fläche (Panel, Phone, CLI, Docs)?
- Happy Path: was kann ein Mensch **sehen oder ausführen**, wenn es
  wahr ist?
- Explizite Non-Goals / Out of Scope.
- Constraints, die in der Doktrin dieses Repos schon stehen (beide
  Locales, Docs-Twins, Tests neben dem Subject, kein Autodelete, …)
  — nur fragen, wenn das Ziel sie **überschreiben** würde.
- Edge Cases, die das Design kippen würden (leerer Input, Stop
  mitten im Lauf, Resume, fehlender Slot, …).

**Definition of Done** (host-prüfbar, kein Vibes):

- Welches Kommando muss grün sein (benennen; ein Tester fährt es,
  nicht der Orchestrator)?
- Ist ein Reviewer vor Integrate Pflicht?
- Docs-Twins, wenn Docs angefasst werden?
- PR erwartet, Promote erwartet, oder Branch liegen lassen?
- Was `inspect_agent` zeigen muss (Dateien, sauberes Worktree, …)?

Den User nicht fragen, was Scout (oder ein HEAD-Read) aus dem Code
beantworten kann. Den User nicht nach einem Modell fragen. Nicht
fragen, ob MCP-Tools benutzt werden sollen.

### Wenn das Ziel schon vollständig ist

Wenn der Prompt schon die Frage, das Where, das beobachtbare Ergebnis,
das Out-of-Scope und die Prüfung nennt — **`ask_user` überspringen**.
Trotzdem den Vier-Zeilen-Brief aufs Board schreiben, damit Subagenten
und Timeline denselben Text sehen. Scout nur starten, wenn eine
Code-Tatsache fehlt und ein Scout-Slot existiert.

Playbooks, die ein vollständiges Ziel einfügen, überspringen
Intake-Fragen konstruktionsbedingt. Das ist der Sinn eines guten
Playbooks.

### Arbeit für Subagenten ausformulieren

Der Orchestrator ist Übersetzer, kein zweiter Product Manager.

Vier Zeilen, SSSF-förmig, in der Sprache des Ziels:

```
<the ask — ein imperativer Satz; ihre Spezifika zitieren>
Where: <Pfade, die Scout oder HEAD wirklich gesehen hat>
Done means: <beobachtbares Ergebnis + das Kommando, das es beweist>
Out of scope: <Versuchungen, benannt, damit sie niemand ergänzt>
```

Dann ist jeder `start_agent`-Task dieser Brief **zerschnitten**: Ziel
dieses Agenten, Dateien, AC für diese Scheibe, DoD / Verify, Out of
Scope. Der Contract verlangt diese Form schon; Intake macht sie wahr
statt erhofft.

Nicht den Plan des Workers schreiben (How). Das Harness nicht im Task
ansprechen („dann report_done", „nimm den Reviewer") — das gehören
Contract und der nächste `start_agent` des Orchestrators. Nicht
aufpolstern. Nach Intake ist das erste user-sichtbare Artefakt der
Brief auf dem Board, kein Tagebuch der Schleife.

### ask_user, kein zweites Gehirn

Kein neues MCP-Tool. Ändern:

- `buildOrchestratorSystemPrompt`-Loop (Schritt 0).
- `ask_user`-Tool-Description: AC/DoD-Löcher **sind**
  User-Entscheidungen; Code-Fakten sind Scout/Read; Raten ist
  verboten.
- Orchestrator-Extra-Starter-Prompt: auf der Flughöhe des Users
  sprechen; Fragen bündeln; nach Antworten den Brief zeigen.

v1 ist ein nummerierter Blob in `question` (max. 4_000). Strukturierte
Felder (`options[]`, Kinds pro Item) sind eine spätere
PendingQuestions-Änderung — nur wenn der Blob zu unhandlich wird.
Keinen zweiten Fragenkanal anlegen.

---

## Track S — Scout

### Warum nicht nur Explorer

Siehe den Vergleich oben. Explorer bleibt der Mapper mitten im Lauf.
Scout ist der Intake-Spezialist. Dieselbe Isolation (`CHANGE NOTHING`),
andere Frage.

### Slot ist opt-in

`start_agent{role:"scout"}` funktioniert nur, wenn das Profil einen
Scout-Slot listet (wie jede andere Rolle). Der Orchestrator-Prompt
druckt `Available roles` schon aus den Slots. Fehlt Scout, nutzt die
Intake-Schleife HEAD-Read / Explorer / `ask_user` als Fallback und
nennt nie `scout`.

### Mitgelieferter Rollen-Prompt

`SCOUT_ROLE_ID = 'scout'` zu `BUILTIN_ROLE_TEMPLATES` hinzufügen.
Englisch, 100–200 Wörter, kein Contract-Duplikat (`report_done` lebt
in `contract.ts`). Muss `CHANGE NOTHING` sagen. Muss: Pfade und
Symbole zitieren; nach den Fragen des Orchestrators strukturieren;
Unbekanntes benennen; Helper auf read-only halten; Helper
überspringen, wenn ein paar Greps reichen. Darf nicht: das Feature
planen, editieren, die ganze Testsuite „zur Sicherheit" fahren oder
einen Directory-Tour dump.

Dem Orchestrator empfehlen, ein `resultSchema` (G3) ungefähr so zu
übergeben:

```
findings: [{ file, symbol?, note }]
unknowns: [string]
summary: string
```

damit der Brief Koordinaten zitieren kann. Schema ist per Call, kein
neuer Host-Typ.

### Extra-System-Prompt

`INITIAL_ROLE_PROMPTS.scout` ist Pflicht (der User hat das benannt).
Append-only Overlay: Leser = Orchestrator, Sprache des Tasks, zuerst
die Antwort dann Koordinaten, destillieren, keine Ordner-Tour.
`appendUserRolePrompt` weigert sich schon, den mitgelieferten Text zu
ersetzen. `createEmptyProfile` zieht neue Keys über
`initialRolePromptEntries` — `profile.test.ts` erwartete Ids
aktualisieren.

### Farb-Pool

Sieben Builtins reservieren `ROLE_COLOR_POOL[0..6]`; Custom-Rollen
starten bei `[7]`. Ein achtes Builtin würde Pewter stehlen und Custom
auf Workers Verdigris schieben. **Einen neunten gedämpften Ton
hinzufügen**, ihn Scout zuweisen, Custom-Rollen hinter dem
Reservierungsblock halten. `roles.test.ts` aktualisieren (Anzahl,
Eindeutigkeit, Sättigungscheck, „seven documented roles" → acht,
Explorer **und** Scout in der `CHANGE NOTHING`-Liste).

---

## Track A — Archiv gestoppter Läufe

### Stop schreibt schon das Journal

`stopWorkspace` löscht den In-Memory-Workspace, öffnet optional den
Run-PR, finalisiert Retro, unregistert MCP. Das Verzeichnis
`.vertragus/runs/<id>/` bleibt. Das ist das Archiv. Nicht woanders
hinkopieren. Nicht autodeleten. Worktree-Cleanup (Besen) bleibt eine
eigene, explizite Aktion.

### Das Panel vergisst die Karte

Die Running-Workspaces-Schiene ist ein Live-Set. Nach dem Quadrat ist
die Karte weg. Retro zeigt eine gedeckelte Learnings-Liste
(`MAX_RUN_RETROS = 50`) mit einer Einzeiler-Zählung — nicht wann
welcher Agent gearbeitet hat, nicht die PR-URL, nicht Helper. Resume
brieft nur das **neueste** Journal. `search_runs` ist ein
Orchestrator-Tool, kein Human-Browser.

### Tür: die Profilzeile

User-Request: Start über das **Profil**. Ein History-Control neben
Retro (Chart) und Cleanup (Besen) — ein Ausklapp, dieselben
Mount/Error-Regeln wie `RetroPanel`.

Jede Zeile: Workspace-Name, Ziel-Auszug, startedAt, endedAt oder
„running", Endgrund (User-Stop / Retro / Crash / unknown),
Status-Pille aus Events (`record_retro`-Summary, letztes
`agent_done`, `orchestrator_exited`, Stop), PR-URL wenn das Event
`pull_request` existiert, Dauer. Klick öffnet dieselbe **Timeline**
wie der Live-Karten-Button.

Ein laufender Workspace dieses Profils steht auch in der Liste (sein
Journal liegt schon auf Disk). Zwei Türen, eine Projektion.

Optional später (nicht v1): „Diesen Lauf resumieren" für eine Zeile,
die nicht die neueste ist. E3 ist heute bewusst newest-only.

### Run-Meta beim Stop

`meta.json` heute: `workspaceId`, `profileId`, `workspaceName`,
`goal?`, `startedAt`, `resumedFrom?`. Fail-soft ergänzen, bei Stop und
bei sauberem Retro-Ende:

- `endedAt`
- `endReason`: `user_stop` | `retro` | `crash` | `unknown`
- `pullRequestUrl?` (aus dem Event kopieren, nicht neu öffnen)

Alte Metas ohne diese Felder bleiben gültig (`z` optional). `endedAt`
aus der letzten Event-mtime ableiten, wenn es fehlt.

Geschichte nicht umschreiben. Das append-only Journal bleibt die
Quelle der Spans.

---

## Track T — Timeline

### Eine Projektion, zwei Türen

Reine Funktion: `events.jsonl` + `meta.json` + `tasks.json` → ein
View-Model (Lanes, Spans, Kapitel, Inspektor-Payloads). Genutzt von:

- einem Button auf `WorkspaceCard` (laufend oder grau
  `orchestrator_exited`)
- dem Archiv-Ausklapp unter dem Profil
- Tests mit Fixture-Journalen (kein Electron)

Live-Pfad: das Journal lesen (append-only, dieselbe Datei). Den
EventQueue-Ring nicht in den Renderer pushen. In v1 kein Gateway-Verb
(das Phone muss nichts *tun*, was die Summary nicht zeigen kann).
`workspaces:openRunFolder` bleibt die Escape-Hatch zu Rohdateien.

### Spuren und Verschachtelung

Y-Achse: Orchestrator, dann Leads, dann Worker, dann Helper,
`orderByParent`-Stil. Farbe = `roleColor`. X-Achse: `ts` von
`agent_started` bis `agent_done` / `agent_exited` / `agent_stopped`.
Überlappende Balken sind parallele Slots — das ist der Punkt.

`+N more`, wenn Lanes eine Kappe überschreiten (sechs reicht für eine
Karte; die Detailansicht listet alle).

Ohne `parentId` auf journaltem `agent_started` flachen Helper auf den
Root und der User-Wunsch „Subagenten von Subagenten" ist eine Lüge.
Deshalb landet A1 vor T2.

### Event-Inspektor

Span oder Kapitel wählen. Unteres Panel (Screenshot 2):

- Identität (Name, Rolle, Modell falls vorhanden, Parent-Name)
- starke Zusammenfassung (`agent_done.summary`, destilliert;
  Host-Fakten: Branch, `diffStat`, `changedFiles`)
- verschachtelte Kinder und **ihre** Summaries
- Events im Bereich: Fragen, Progress, Integrate, PR, User-Messages,
  Succession
- Task-Board-Zeilen, die dieser Agent claimed hat

Kapitel sind abgeleitet, nicht gespeichert: Intake (`user_question`-
Cluster vor dem ersten Worker-`agent_started`), Implement,
Review/Test, Integrate, PR. Labels sind i18n. Fehlendes Kapitel =
diese Event-Art ist nie passiert (ehrliches Leer, kein failed Gate).

### Zusammenfassungen

Qualität ist vor allem Prompt-Ebene (Rollen-Extras sagen schon
destillieren). Die Timeline muss bevorzugen:

1. `agent_done.summary` + `result` (wenn Scout/G3)
2. Host-Fakten auf demselben Event
3. Task `lastReport`
4. Ein Einzeiler-Fallback aus Rolle + `changedFiles`, wenn Summary
   leer ist — niemals einen Success erfinden

Orchestrator-`record_retro.summary` ist das Lauf-Verdikt oben in der
Detailansicht. User-Stop ohne Retro: „Vom User gestoppt" plus der
letzte Brief auf dem Board.

### Metriken

Auf Karte und Header: **Status**, **startedAt**, **Dauer**,
**Agentenzahl**, **PR** (Link oder „keiner"). Optional:
Wanduhr-Budget verbraucht (`budget_warning`). Nicht in v1: Dollar,
Input/Output-Tokens, Context-Fill-Prozent (das ist Vendor-TUI / Pi-
JSONL; Landscape T1 darf später vendor-zugestandene Nutzung als
solche zeigen).

---

## Journal-Lücken, die zuerst zu schließen sind

| Lücke | Effekt auf die Timeline | Track |
| --- | --- | --- |
| Kein `parentId` auf `agent_started` | Helper und Lead-Worker können nach Stop nicht nesten | A1 |
| Kein `endedAt` / `endReason` auf Meta | Archiv-Zeilen raten aus mtime | A1 |
| Kein Task-Text auf `agent_started` | Lane-Label ist nur der Rollenname | A1 optional: `taskSubject?` gedeckelt |
| Helper-Events sind journalt, in Tests leicht zu übersehen | Projektion unterzählt Nests | T1-Fixtures müssen einen Nest-Tap enthalten |
| `ask_user`-Antworten sind keine Events (nur `user_question`) | Inspektor zeigt die Frage, nicht die Antwort | T1: `PendingQuestions` nur solange live lesen; Archiv kann alte Antworten nicht retten, außer wir persistieren sie später — die Antwort **nicht** als zweites Gehirn loggen. Optionales quiet Event `user_answer` ist Follow-up, nicht v1 |

A1 ist die einzige `events.ts`-Mutation in diesem Programm. In einem
PR besitzen. Alte Journale parsen ohne die neuen Felder.

---

## Wellen

Hot-Files: `Workspace.ts`, `spawn.ts`, `events.ts`, `profile.ts`.
Höchstens ein offener PR mutiert jede.

```
Wave 1 — kein Workspace.ts, kein events.ts
  I1  Intake-Prompt + ask_user-Description
  S1  Scout-Rolle + Extra-Prompt + Farbe
        │
        ▼
Wave 2 — events.ts + Journal-Meta (ein PR)
  A1  parentId auf agent_started, endedAt/endReason auf Meta
  A2  listRuns / readRunProjection Leaf-Module (können in W1 gegen
      heutige Events starten, dann parentId wachsen)
        │
        ▼
Wave 3 — Panel
  T1  Projektion + Tests auf Fixture-Journalen
  T2  WorkspaceCard-Button + ProfileRow-Archiv-Ausklapp
```

I1 und S1 blockieren A2s ersten Cut nicht. T2 darf nicht vor A1
landen, wenn wir Nesting auf archivierten Läufen bewerben.

Remote: in diesen Wellen kein neues Gateway-Verb. Wenn das Phone
später eine Timeline **öffnen** muss, ist das ein read-only achtes
oder neuntes Verb mit gedeckeltem Payload — ein Follow-up, dieselbe
Debatte wie Landscape R3.

---

## Datei-Besitz

| Track | Primär | Darf anfassen | Darf nicht |
| --- | --- | --- | --- |
| I1 | `prompts/orchestrator.ts`, `orchestrator.test.ts` | `toolsOrchestrator.ts` (nur `ask_user`-Description), `rolePrompt.ts` Orchestrator-Extra, `contract.ts` nur wenn eine Reminder-Zeile wirklich nötig ist | `events.ts`, `Workspace.ts`, `profile.ts` |
| S1 | `prompts/roles.ts`, `rolePrompt.ts`, ihre Tests | `profile.test.ts` erwartete `rolePrompts`-Ids, Profile-Editor-i18n wenn ein Hint Scout nennt | `Workspace.ts`, `events.ts`, `spawn.ts` |
| A1 | `schema/events.ts`, `toolsOrchestrator.ts` (`parentId` stempeln, wo `agent_started` gepusht wird), `journal.ts` Meta | `WorkspaceManager.stopWorkspace` (`endedAt` schreiben) | `spawn.ts`, Renderer |
| A2 | neu `workspace/listRuns.ts` (neben `resume.ts` / `searchRuns.ts`) | `appIpc.ts` + `preload/index.ts` zusammen | `events.ts` |
| T1 | neu `shared/runTimeline.ts` (pur) | Fixtures unter der Testdatei | Electron, Vue, SQLite |
| T2 | `panel/ArchivePanel.tsx`, `panel/RunTimeline.tsx`, `panel.css`, i18n `archive.*` / `timeline.*` | `ProfileRow.tsx`, `WorkspaceCard.tsx`, `usePanelData.ts` | `events.ts`, `spawn.ts` |

i18n: neue Keys unter `panel.archive*` und `panel.timeline*` (oder
Namespace `archive`), damit Landscape-PRs nicht kollidieren. Beide
Locales im selben PR. IPC: `runs:list` / `runs:get` panel-only; in
`APP_CHANNELS` und Preload im selben PR (`ipc`-Parity-Test).

---

## Non-Goals

- Ein Python/JSON-DAG von Phasen, den der Host ausführt
- `adws/` oder einen Skill ins User-Repository stempeln
- Eine zweite Trace-Datenbank oder einen Bun-Visualizer
- Autodelete von Run-Dirs, Worktrees oder Branches
- Peer-to-Peer zwischen Scouts, Helpern oder Leads
- Grandchild-Events in der Root-`await_events`-Queue (Journal-Tap
  bleibt; Fan-in bleibt)
- Token- oder Dollar-Orakel
- E3 Resume in „alte CLIs neu spawnen" verwandeln
- `stop_agent` / `focus_agent` auf der Remote-Allow-List
- Host-gefahrene Testsuiten im Orchestrator-Prozess
- Explorer, Janitor oder das Task-Board ersetzen
- Strukturierte `ask_user`-Formulare (v2 falls nötig)
- Phone-Timeline (v2)

---

## Code-Anker

| Thema | Wo |
| --- | --- |
| Orchestrator-Loop und `ask_user`-Zeile | `src/shared/prompts/orchestrator.ts` |
| `ask_user`-Tool-Description | `src/main/mcp/toolsOrchestrator.ts` |
| Rollen-Templates + Farben | `src/shared/prompts/roles.ts` |
| Extra-System-Prompts | `src/shared/prompts/rolePrompt.ts` |
| Task-Contract / Handoff | `src/shared/prompts/contract.ts` |
| Events | `src/shared/schema/events.ts` |
| Journal + Meta | `src/main/workspace/journal.ts` |
| Resume / Events lesen | `src/main/workspace/resume.ts` |
| Journale suchen | `src/main/workspace/searchRuns.ts` |
| Stop + Journal-Tap inklusive Nests | `src/main/workspace/WorkspaceManager.ts` |
| parentId live | `src/main/mcp/types.ts` `parentOf`, `src/main/index.ts` Summary |
| Verschachtelte Zeilen ordnen | `src/main/workspace/orderByParent.ts` |
| Profil-Slots / leeres Profil | `src/shared/schema/profile.ts` |
| Panel-Karte / Profilzeile | `src/renderer/src/panel/WorkspaceCard.tsx`, `ProfileRow.tsx`, `RetroPanel.tsx` |
| PR auf der Karte | `WorkspaceSummary.pullRequest` |
| Result-Schema | `src/shared/schema/resultSchema.ts` |

---

## Verwandte Docs

- [`HANDBOOK-HARNESS.md`](HANDBOOK-HARNESS.md) — Non-Goals, Loop, Nesting
- [`PROMPT-INTAKE-ARCHIVE.md`](PROMPT-INTAKE-ARCHIVE.md) — Umsetzungs-Prompt
- [`PROMPT-MCP-HARNESS.md`](PROMPT-MCP-HARNESS.md) — frühere Tracks (nicht neu bauen)
- [`PLAN-LANDSCAPE.md`](PLAN-LANDSCAPE.md) — Review, Sandbox, T1 Process-Snapshot
- [`RESEARCH-LANDSCAPE.md`](RESEARCH-LANDSCAPE.md) — Nachbar-ADEs
- SSSF: [Repo](https://github.com/disler/super-simple-software-factory),
  [Video](https://www.youtube.com/watch?v=haUfb1ievTE)
