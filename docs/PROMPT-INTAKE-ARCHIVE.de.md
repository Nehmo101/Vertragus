Deutsch | [English](PROMPT-INTAKE-ARCHIVE.md)

# Prompt: Intake, Scout und das Lauf-Archiv

> Copy-paste-fähiger Agent-Prompt. Primärquelle für Reihenfolge und
> Non-Goals: [`PLAN-INTAKE-ARCHIVE.md`](./PLAN-INTAKE-ARCHIVE.md) und
> [`HANDBOOK-HARNESS.md`](./HANDBOOK-HARNESS.md). **Nicht** A1–A3 /
> Remote / C1–C6 / D / E / F / G / H neu bauen — die liegen. **Nicht**
> einen Python-ADW-Graphen oder eine zweite Trace-DB stempeln.

---

## Rolle

Du arbeitest im Repo **Vertragus** (Electron-Panel + in-app MCP-Server).
Setze das Programm Intake / Scout / Archiv-Timeline in **Tracks** um
(nicht alles in einem PR). Jeder Track: eigene Branch, grüne Tests, PR
mit Bezug auf `docs/PLAN-INTAKE-ARCHIVE.md` und
`docs/HANDBOOK-HARNESS.md`.

Sprache der Tool-Descriptions, Contracts und Orchestrator-/Rollen-
Prompts: **Englisch** (imperativ). Doku ist englisch-kanonisch mit
gepflegten deutschen `.de.md`-Zwillingen — wer Doku anfasst, pflegt
beide. UI-Strings laufen über die i18n-Schichten (de + en).

---

## Kontext — was schon da ist (nicht neu bauen)

| Bereich | Stand |
| --- | --- |
| Fragen an den Menschen | `ask_user` + `PendingQuestions` + Panel-Badge + `answer_question` |
| Ziel beim Play | `workspaces:start {goal}`, Nachtrag `workspaces:goal` |
| Plan außerhalb des Modells | Task-Board → `.vertragus/runs/<id>/tasks.json` |
| Form der Worker-Assignment | `start_agent`-Task muss schon Ziel, Dateien, DoD, Verify tragen |
| Handoff | C4 `baseBranch` + Handoff-Block aus `agent_done` |
| Strukturierte Reports | G3 `resultSchema` auf `report_done` |
| Mapper mitten im Lauf | Explorer-Rolle (`CHANGE NOTHING`) |
| Lauf-Artefakte | `events.jsonl`, `meta.json`, `tasks.json`; Stop löscht sie nicht |
| Nest-Events im Journal | `onLeadCreated` zapft Lead- und Worker-Nest-Queues |
| Live-Nesting | `parentId` auf `WorkspaceSummary.agents` |
| Briefing des neuesten Laufs | E3 Resume (neuer Prozess; alte Tickets tot) |
| Learnings-UI | Retro-Ausklapp (keine Timeline) |
| Extra-System-Prompts | `INITIAL_ROLE_PROMPTS` + `appendUserRolePrompt` (Host-Prompt nie ersetzen) |

Code-Anker: unten in
[`PLAN-INTAKE-ARCHIVE.md`](./PLAN-INTAKE-ARCHIVE.md).

SSSF ([Repo](https://github.com/disler/super-simple-software-factory),
[Video](https://www.youtube.com/watch?v=haUfb1ievTE)) ist eine
**Ideenquelle**, kein Port. Übernehmen: Intake als Schritt 0,
Vier-Zeilen-Brief, Scout vor Code-Fragen, dieselbe Projektion für Live
und Historie, `parentId` auf Spans. Ablehnen: Python-DAG, gestempeltes
`adws/`, SQLite-Visualizer, Token-Orakel, „höchstens einmal fragen,
sonst annehmen".

---

## Harte Non-Goals (nie)

- Peer-to-Peer zwischen Subagenten oder Leads
- Ein vorgestartetes Team / Playbooks, die Fenster spawnen
- Ein Orchestrator, der selbst committet, merget, testet oder pusht
- Autodelete von Worktrees, Branches oder Run-Verzeichnissen
- Ein zweites Orchestrierungsprodukt (Kanban, DAG-Engine, Cloud-Runner,
  Python-ADW-Skripte im User-Repo)
- Grandchild-Events in der Root-`await_events`-Queue
- Ein zweiter MCP-Server oder eine zweite Trace-DB
- Erfundene Token-/Dollar-Summen
- Resume in „alte CLIs neu spawnen" verwandeln
- Explorer ersetzen
- `stop_agent` / `focus_agent` auf dem Remote-Gateway
- Neue Gateway-Verben in diesen Tracks (nur Panel-IPC)

---

## Track-Reihenfolge

```
I1  Intake-Schleife (Prompt + ask_user-Description)     Welle 1
S1  Scout-Builtin-Rolle + Extra-Prompt + Farbe          Welle 1 (parallel zu I1)
A1  parentId auf agent_started + Meta endedAt           Welle 2 (besitzt events.ts)
A2  listRuns / readRunProjection Leaf                   Welle 1 oder 2
T1  Reine Timeline-Projektion + Tests                   Welle 3 nach A1 für Nesting
T2  Panel: Karten-Button + Profil-Archiv-Ausklapp       Welle 3
```

Hot-Files: höchstens ein offener PR mutiert `Workspace.ts`, `spawn.ts`,
`events.ts`, `profile.ts`. I1 darf `events.ts` nicht anfassen. S1 darf
`Workspace.ts` nicht anfassen. A1 ist der eine `events.ts`-PR.

---

## TRACK I1 — Intake-Schleife (Prompt + ask_user)

### Ziel

Wenn der User ein Ziel nennt und für eine perfekte Worker-Assignment
noch etwas fehlt, **fragt** der Orchestrator **immer** — Scrum
Acceptance Criteria und Definition of Done. Steht das schon im Ziel,
**fragt er nicht**. In beiden Fällen **formuliert** er einen
Vier-Zeilen-Brief aufs Task-Board und in jeden `start_agent`-Task.

### Tun

1. In `buildOrchestratorSystemPrompt` **Schritt 0** vor „Break the
   goal into tasks…“ einfügen:
   - Extrahieren, was das Ziel schon spezifiziert.
   - Steht `scout` in Available roles und fehlen Code-Fakten,
     `start_agent{role:scout,…}` auf einem billigen Slot, warten,
     Findings zitieren (keine Transkripte pasten). Keine anderen
     Rollen während Intake.
   - Gap-Check gegen AC (beobachtbarer Happy Path, Non-Goals,
     Flip-Fälle) und DoD (benanntes Verify-Kommando, Review?,
     Docs-Twins?, PR/Promote/Branch-liegen-lassen, was
     `inspect_agent` zeigen muss).
   - Löcher → **ein** nummeriertes `ask_user`. Nicht tröpfeln. Nur
     eine weitere Runde, wenn die Antwort ein neues Loch öffnet.
   - Keine Löcher → `ask_user` nicht aufrufen.
   - Den Brief aufs Task-Board schreiben, dann die bestehende
     Schleife.
2. Vier-Zeilen-Brief (Sprache des Ziels; Spezifika zitieren):

   ```
   <the ask>
   Where: <wirklich gesehene Pfade>
   Done means: <beobachtbares Ergebnis + Beweis-Kommando>
   Out of scope: <benannte Versuchungen>
   ```

   Jeder `start_agent`-Task ist dieser Brief, für einen Agenten
   zerschnitten. Nicht HOW schreiben. Das Harness nicht im Task
   ansprechen.

3. Die `ask_user`-**Tool-Description** umschreiben: AC/DoD-Löcher sind
   User-Entscheidungen; Code-Fakten sind Scout oder ein HEAD-Read;
   Raten ist verboten; Produktwahl / destruktiv / Scope-Änderung
   bleiben gültig.
4. `INITIAL_ROLE_PROMPTS.orchestrator` erweitern: Fragen auf der
   Flughöhe des Users bündeln; nach Antworten ist der Brief das, was
   der User sehen soll, kein Loop-Tagebuch.
5. Tests: Snapshot / Substring auf den neuen Loop-Text und die
   `ask_user`-Description. Byte-Stabilität des **Subagent-Contracts**
   bleibt, außer es gibt einen echten Grund (den gibt es nicht).

### Fertig wenn

- Ein dünnes Ziel im Prompt bringt den Orchestrator zum Fragen, bevor
  ein Worker startet.
- Ein vollständiges Ziel (ask + where + done means + out of scope +
  verify) erzwingt kein `ask_user`.
- Scout wird nur als Rolle erwähnt, die in Available roles stehen
  kann.
- Kein neues MCP-Tool. Keine `events.ts`-Änderung.

### Prompt (kurz)

> Track I1 aus `docs/PLAN-INTAKE-ARCHIVE.md` umsetzen: Orchestrator-
> Schritt 0 (Intake), Vier-Zeilen-Brief, `ask_user`-Description. Scout
> ist opt-in über bestehende Available roles. Keine neuen Tools, kein
> DAG.

---

## TRACK S1 — Scout-Rolle

### Ziel

Achte Builtin-Rolle `scout`: Intake-Recon für den Orchestrator. Slot
opt-in. Den Default-Extra-System-Prompt nicht vergessen.

### Tun

1. `SCOUT_ROLE_ID`, Template in `BUILTIN_ROLE_TEMPLATES` (Englisch,
   100–200 Wörter, `CHANGE NOTHING`, Pfade zitieren, nach Frage
   strukturieren, Unbekanntes benennen, Helper read-only, Helper
   überspringen wenn Greps reichen, kein Contract-Duplikat).
2. `INITIAL_ROLE_PROMPTS.scout`: Leser = Orchestrator, Sprache des
   Tasks, Antwort dann Koordinaten, destillieren, keine Ordner-Tour.
3. Neunter gedämpfter Ton in `ROLE_COLOR_POOL`; Scout nimmt den neuen
   Reservierungsplatz; Custom-Rollen starten weiter hinter dem
   Reservierungsblock.
4. `roles.test.ts`: acht Builtins, Scout in `CHANGE NOTHING` mit
   Reviewer/Architect/Explorer, Farb-Eindeutigkeit, Pool-Länge.
5. `profile.test.ts`: `createEmptyProfile`-`rolePrompts`-Ids enthalten
   `scout`. **Keinen** Scout-Slot auto-einfügen (`slots` bleibt `[]`).
6. Optionaler i18n-Hint im Profile-Editor, dass Scout Intake-Recon ist
   (beide Locales).

Empfehlen (im Orchestrator-Prompt, I1 oder eine Zeile hier): beim
Start von Scout ein `resultSchema` mit `findings[]`, `unknowns[]`,
`summary` mitgeben.

### Fertig wenn

- `builtinRoleTemplate('scout')` existiert; `start_agent{role:scout}`
  löst wie Explorer auf.
- Neue Profile bekommen den Extra-Prompt; alte Profile ohne
  Scout-Slot können keinen spawnen.
- `pnpm`-Tests für roles / rolePrompt / profile grün.

### Prompt (kurz)

> Track S1 aus `docs/PLAN-INTAKE-ARCHIVE.md` umsetzen: Builtin Scout,
> `INITIAL_ROLE_PROMPTS.scout`, Farb-Pool + Tests. Kein Slot-Auto-Insert.
> Explorer nicht ersetzen.

---

## TRACK A1 — parentId auf Events + Run-Meta beim Stop

### Ziel

Archivierte Journale können den Agent-Baum neu aufbauen und sagen,
warum ein Lauf endete.

### Tun

1. Optionales `parentId` (und optional gedeckeltes `taskSubject`) auf
   `agent_started`. Stempeln, wo das Event gepusht wird
   (`toolsOrchestrator.ts`), aus `runtime.parentOf`. Alte Journale
   bleiben gültig.
2. Optionales `endedAt`, `endReason` (`user_stop` | `retro` | `crash` |
   `unknown`), `pullRequestUrl` auf `runMetaSchema`. Schreiben in
   `stopWorkspace` / Retro-Ende. Fail-soft.
3. Exhaustive Event-Tests + Journal/Resume-Tests für fehlende neue
   Felder.
4. Dieser PR besitzt `events.ts`. Kein `ci_status` oder andere Kinds
   einschmuggeln.

### Fertig wenn

- Das `agent_started` eines Helpers im Journal hat `parentId` seines
  Workers.
- Das `meta.json` eines gestoppten Laufs hat `endedAt` und
  `endReason: user_stop`.
- Pre-A1-Fixture-Zeilen parsen weiter.

### Prompt (kurz)

> Track A1 aus `docs/PLAN-INTAKE-ARCHIVE.md` umsetzen: `parentId` auf
> `agent_started`, Stop-Meta. Ein `events.ts`-PR. Alte Journale gültig.

---

## TRACK A2 — Archivierte Läufe listen (IPC)

### Ziel

Leaf-Modul + Panel-IPC, um die Läufe eines Profils aus
`.vertragus/runs/` zu listen, inklusive des lebenden. Noch keine UI
(oder eine Stub-Liste, wenn T2 derselbe Branch ist — lieber eigener
PR).

### Tun

1. `listRuns(repoPath, profileId)` neben `resume.ts` / `searchRuns.ts`:
   fail-soft, neueste zuerst, andere Profile überspringen, meta-lose
   Dirs einschließen wenn ein Journal da ist.
2. `runs:list` / `runs:get` in `APP_CHANNELS` **und** Preload;
   Parity-Test. Panel-only. Gedeckeltes Payload (kein volles jsonl auf
   list).
3. `runs:get` liefert Events + Meta + Tasks für eine Id (das
   Timeline-Input). Size-Cap oder Spill wie `search_runs` (ein riesiges
   Journal benennen statt es zu schlucken).

### Fertig wenn

- Unit-Tests mit einem Fake-Fs mehrerer Run-Dirs.
- IPC von einem CLI-Fenster abgelehnt.

### Prompt (kurz)

> Track A2 aus `docs/PLAN-INTAKE-ARCHIVE.md` umsetzen: `listRuns` +
> IPC `runs:list`/`runs:get`. Fail-soft. Kein Remote-Verb. In diesem PR
> kein Renderer nötig.

---

## TRACK T1 — Timeline-Projektion

### Ziel

Reine Funktion Journal → View-Model. Dieselbe Funktion für Live und
Archiv.

### Tun

1. `src/shared/runTimeline.ts` (+ `.test.ts`). Input: `RunMeta`,
   `AgentEvent[]`, optionales `TaskBoardState`. Output: Lanes (geordnet
   wie `orderByParent`), Spans (`startedAt`/`endedAt`/`status`/
   `summary`/`hostFacts`/`parentId`), abgeleitete Kapitel (intake /
   implement / review / integrate / pr), Inspektor-Records.
2. Fixtures: flaches Team; Lead + Worker; Worker + Helper; Stop ohne
   Retro; `pull_request` ok und fail; fehlendes `parentId` (pre-A1)
   flacht ehrlich ab.
3. Metriken: Dauer aus Zeitstempeln, Agentenzahl, PR-URL. **Keine**
   erfundenen Tokens oder Dollar.
4. `agent_done.summary` + Host-Fakten bevorzugen; niemals Success
   erfinden.

### Fertig wenn

- Tests pinnen Nesting, Kapitel und den Flatten-ohne-parentId-Fall.
- Keine Electron-Imports.

### Prompt (kurz)

> Track T1 aus `docs/PLAN-INTAKE-ARCHIVE.md` umsetzen: reines
> `runTimeline.ts` über das Journal. Nesting via `parentId`. Nur
> Host-Wahrheits-Metriken.

---

## TRACK T2 — Panel-Timeline + Archiv-UI

### Ziel

Zwei Türen, eine Ansicht: Button auf der Workspace-Karte; History-
Ausklapp auf der Profilzeile (die Tür nach dem quadratischen Stop).

### Tun

1. `ArchivePanel` unter `ProfileRow` (dieselben Mount/Error-Regeln wie
   `RetroPanel`). Zeilen aus `runs:list`. Klick → Timeline.
2. Timeline auf `WorkspaceCard` (laufend und `orchestrator_exited`).
   Nutzt `runs:get` auf dieser `workspaceId` (Journal ist live).
3. Detail: Swimlanes, `+N more`, Inspektor mit verschachtelten
   Summaries und PR. i18n `panel.archive*` / `panel.timeline*`
   **en+de**.
4. Empty States: keine Läufe; Journal unlesbar; läuft noch.
5. Kein zweites Windowing-Produkt einbetten. Ausklapp + expandierte
   Karte (oder ein Panel-Window, wenn die Karte zu eng ist — im Panel
   bleiben).

### Fertig wenn

- Workspace stoppen, Profil-History öffnen, den Lauf sehen, Timeline
  öffnen, Agenten / Helper / PR sehen wenn das Journal sie hat.
- Dieselbe Timeline von einer Live-Karte öffnen, während Agenten
  arbeiten.
- i18n-Guard grün. Keine Remote-Änderungen.

### Prompt (kurz)

> Track T2 aus `docs/PLAN-INTAKE-ARCHIVE.md` umsetzen: Profil-Archiv-
> Ausklapp + Workspace-Karten-Timeline, beides über `runs:list` /
> `runs:get` und `runTimeline`. i18n beide Locales. Kein DAG, kein
> Token-Footer.

---

## Nach T2 (optional)

Nur wenn ein späterer Auftrag es verlangt: quiet Event `user_answer`;
Resume von einer bestimmten Archiv-Zeile; Host-Quality-Kommandos als
`kind=code` (Landscape W2); Phone read-only `runs:get`; strukturierte
`ask_user`-Felder. Nicht in den ersten sechs Tracks.

---

## Definition of Done

`corepack pnpm run ci` grün. Coverage-Ratchet nicht senken. Docs-Twins
in derselben Änderung, wenn ein Canonical-Doc angefasst wird. Jeder PR
nennt den Track (I1 / S1 / A1 / A2 / T1 / T2) und die Handbook-
Non-Goals, die er abgelehnt hat.
