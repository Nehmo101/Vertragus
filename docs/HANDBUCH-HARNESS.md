# Vertragus als AI-Harness

Ideen, die aus dem Code kommen — nicht aus einer generischen Agent-Roadmap.
Geschrieben nach einer kompletten Lektüre von MCP-Loop, Worktrees, Prompts,
Panel, Retro und Provider-Attach. Nichts hiervon ist gebaut; das ist die
Reihenfolge, in der der kleine Kern zum starken Harness wird, ohne wieder
zum Archiv-Repo anzuschwellen.

**These:** Der Loop ist schon ein Harness. Was fehlt, ist *Host-Wahrheit*
für Dinge, die heute nur Prompt-Hoffnung sind. Die alten Bugs
(Polling, unbeantwortete Fragen, vergessenes MCP-Attach, permission-starved
Worker, Orchestrator der selbst codet) sind im Kern gelöst. Die nächsten
Fehler passieren dort, wo der Host dem Modell das Urteil überlässt, obwohl
er die Dateien, den Git-Status und den Benutzer selbst sehen könnte.

---

## Was schon stark ist (nicht nochmal bauen)

| Schicht | Was Vertragus schon hat |
| --- | --- |
| Runtime | Echte PTYs, sichtbare Terminals, Seed-Handshake inkl. Bracketed Paste |
| Isolation | Pflicht-Worktrees `vertragus/<workspace>/<agent>`, kein Shared-Checkout |
| Kommunikation | Blockierendes MCP: `await_events`, `ask_orchestrator` mit Ticket, kein Polling |
| Identität | URL-gebundene Tokens; Subagent sieht nur drei Reporting-Tools |
| Delegation | Profile = Slots (Bauplan), nicht vorstartetes Team |
| Lernen | Retro → Wilson-Score + Insights in den nächsten Orchestrator-Prompt |
| Provider | Ein deklaratives Schema, Presets sind Daten, nicht Special-Cases |

Der Orchestrator hat genau sieben Tools (`start_agent`, `send_to_agent`,
`await_events`, `list_agents`, `stop_agent`, `read_output`, `record_retro`).
Neue Kraft kommt fast immer als *neues Host-Tool oder neues Event* in
genau diesen Loop — nicht als zweite Orchestrierung daneben.

---

## Die drei strukturellen Löcher

Bevor Features: drei Stellen, an denen der Loop heute strukturell lügt
oder schweigt. Fast jede starke Idee ist eine Schließung eines dieser
Löcher.

### 1. Der Orchestrator sieht die Arbeit seiner Agenten nicht

Jeder Agent — der Orchestrator eingeschlossen — bekommt ein eigenes
Worktree, abgezweigt von HEAD bzw. `baseBranch`
(`Workspace.createWorktreeFor`). Das ist richtig für Isolation.

Die Folge: Claudes Read/Glob/Grep (Allowlist in `mcp/attach.ts`) lesen
das *Orchestrator*-Worktree, also den Stand zu Laufbeginn, nicht die
Dateien von Caronte. `read_output` liefert den ANSI-Schwanz einer TUI.
Verifikation ist damit entweder „Prosa in `report_done` glauben“ oder
„einen Reviewer auf `baseBranch` starten“. Beides ist Prompt, nicht Host.

Ein Codex-/Kimi-Orchestrator hat diese Read-Tools gar nicht — nur die
sieben MCP-Tools. Cursor/Grok dürfen in ihrer CLI vermutlich alles,
inklusive Editieren, was die Regel „du codest nie“ providerabhängig
macht. **Host-Inspect macht Verifikation provider-neutral.**

### 2. Handoff hängt daran, dass jemand `git commit` in den Task schreibt

Worker-Prompt: *„Never commit … unless the task says to.“*
Orchestrator-Prompt: *„Have the first agent commit, then start the next
one with `baseBranch`.“*

Die Isolation ist wertlos für die Kette, wenn der Worker nicht committed
und der Orchestrator das nicht merkt. `agent_done` trägt nur `summary` +
`status`. Kein Diffstat, kein SHA, kein porcelain. Ein Reviewer auf einem
leeren Branch reviewt HEAD und nennt das Erfolg.

### 3. Der Mensch ist kein Teilnehmer des Loops

Play startet den Orchestrator ohne Ziel (`workspaces:start(profileId)`).
Das Ziel wird in die TUI getippt — dieselbe Klasse von Bug, die
`autoSubmitTasks` lösen sollte („der Auftrag sitzt im Composer“).

Steht im Orchestrator-Prompt wörtlich:

> If the question needs a decision only the user can make, answer with
> the best-supported option

Also: der Harness fordert das Modell auf, den Benutzer zu ersetzen.
`ask_orchestrator` blockiert sauber; ein `ask_user` gibt es nicht.
Ein `user_message`-Event, das ein parkendes `await_events` aufweckt,
gibt es nicht. Das Panel ist ein Launcher (Play, Stop, Fokus, `?`-Badge),
kein Cockpit.

---

## Tier 0 — denselben Loop wasserdicht machen

Kleine Oberfläche, großer Hebel. Alles hier erweitert die bestehenden
sieben Tools oder die Event-Payloads. Nichts davon braucht ein zweites
Produkt.

### 0.1 `inspect_agent` — Host liest das Worktree

Neues Orchestrator-Tool, read-only, gegen das Worktree des genannten
Agenten (nie gegen den Hauptcheckout):

```
inspect_agent{agentId, view: status | diff | log | file, path?, lines?}
```

- `status` — `git status --porcelain` + Branch + ahead/behind
- `diff` — `git diff` / `git diff --stat` (gecapped, z. B. 80 kB)
- `log` — `git log` des Agenten-Branch
- `file` — Datei aus dem Worktree lesen (kein Schreiben)

Damit fällt die Lüge weg, Verifikation sei `read_output`. Der
Orchestrator-Prompt ändert sich von „du darfst das Repo lesen“ zu
„du verifizierst über `inspect_agent`, niemals über eigene Git-Befehle“.
Das gilt für jeden Provider gleich.

### 0.2 `agent_done` trägt Host-Fakten

Beim `report_done` (und beim Sentinel-DONE) hängt der Host an das Event:

- `branch`, `headSha`
- `changedFiles[]` (porcelain)
- `uncommitted: boolean`
- `diffStat` (kurze Zahlen)

Der Orchestrator *sieht*, ob committed wurde. Er muss es nicht erraten.
Das Event-Schema bleibt die einzige Sprache; `report_done.summary` bleibt
Prosa, die Fakten kommen vom Host.

Dasselbe in `list_agents` / `agentsSummary`: eine Zeile Git-Zustand pro
Agent, analog zu `lastOutputAgeSec` und `pendingQuestion`.

### 0.3 Snapshot beim Done (Default an, abschaltbar)

Wenn `report_done` kommt und das Worktree dirty ist: Host macht einen
Commit auf dem Agenten-Branch

```
vertragus: <agent> / <role> — <erste Zeile der Summary>
```

Kein Push, kein `--force`, keine fremden Branches. Der Worker-Prompt
kann dann ehrlich sagen „committe nicht selbst — der Host snapshotet“.
Der Orchestrator-Prompt streicht „sag ihm, er soll committen“.

Das ist die eigentliche Handoff-Kante: `baseBranch` zeigt danach immer
auf Arbeit, nicht auf Hoffnung.

### 0.4 Handoff-Paket an `start_agent`

Wenn `baseBranch` gesetzt ist, hängt der Host an den Task (nach dem
Contract, oder als eigener Block):

- Summary des letzten `agent_done` auf diesem Branch
- `changedFiles`
- SHA

Der Orchestrator muss die Kette nicht mehr in Prosa nachbauen. Ein
Reviewer bekommt den Diff-Kontext, ohne dass der Orchestrator ihn
abtippt — und ohne dass zwei Agenten einander anschreiben (Star-Topologie
bleibt).

### 0.5 Orchestrator-Idle als Event

Subagents ohne MCP bekommen nach 120 s Stille `agent_progress`
(„silence hint“). Der Orchestrator, der `await_events` nicht mehr
aufruft, ist der Tod des Laufs — und genau das, was der Prompt als
„without exception“ verbietet, aber niemand misst.

Host-Watchdog: wenn seit N Sekunden kein Orchestrator-Tool-Call kam,
ein Event `orchestrator_idle` in die Queue (weckt ihn nicht — er ruft
ja nicht). Zusätzlich sichtbar am Panel (Karte blinkt). Optional: eine
Reminder-Zeile in seine TUI, analog zum Contract-Reminder, einmal pro
Stillephase.

### 0.6 Goal ist ein Startparameter

```
workspaces:start(profileId, goal: string)
```

Play im Panel öffnet ein Pflichtfeld (oder startet, und das Feld sitzt
auf der Workspace-Karte, solange kein Goal da ist). Der Host seedet das
Goal in den Orchestrator über denselben Handshake wie jede Assignment —
nicht „der User tippt in die TUI, wenn er sich erinnert“.

`VERTRAGUS_DEV_RUN` nimmt das Goal aus Env oder stdin. Heute steht in
`devRun.ts` ausdrücklich: *From there the user types the goal into the
orchestrator terminal.*

---

## Tier 1 — der Mensch im Loop

Ohne das bleibt Vertragus ein sichtbares Autopilot-Team. Mit dem wird
es ein Harness, das man lenken kann, ohne ein Terminal zu jagen.

### 1.1 `ask_user` (Orchestrator-Tool, blockierend)

Dieselbe Ticket-Maschinerie wie `ask_orchestrator`:

- Orchestrator ruft `ask_user{question, options?}`
- Event `user_question` → Panel-Karte mit Textfeld / Buttons
- `await_events` liefert die Antwort nicht; das Tool selbst blockt
  und ticktet nach ~50 s genau wie der Subagent

Die Prompt-Zeile „answer with the best-supported option“ fällt. Offene
User-Fragen sind am Panel dasselbe `?` wie Subagent-Fragen, nur auf der
Workspace-Karte.

### 1.2 `user_message` weckt `await_events`

Ein Composer auf der Workspace-Karte. Absenden:

1. schreibt die Nachricht in die Orchestrator-TUI (sichtbar, ehrlich)
2. pusht `user_message` in die EventQueue, damit ein parkendes
   `await_events` *sofort* zurückkommt

Sonst landet die Lenkung in einem zweiten Turn der CLI, während der
Orchestrator in `await_events` hängt — zwei Hirne, ein Prozess.
Das Event ist die eine Wahrheit.

### 1.3 Fragen am Panel beantworten, ohne das Terminal

Das `?`-Badge ist heute Tooltip + Fokus aufs Fenster. Ein Klick sollte
das Frage-Textfeld öffnen und `send_to_agent{questionId}` auslösen
(für Subagent-Fragen) bzw. `ask_user` auflösen. Der Mensch muss nicht
wissen, welcher Provider die TUI zeichnet.

### 1.4 Yolo als Policy, nicht als Master-Switch

Heute: ein Bool, Subagents default yolo, Orchestrator nie. Aus = die
CLIs fragen in *ihren* Dialogen, unsichtbar für den Loop.

Stufen, die in denselben Loop passen:

| Stufe | Wer darf was |
| --- | --- |
| `yolo` | wie heute |
| `ask-user` | gefährliche Git-/Netz-/Delete-Sachen → `ask_user` |
| `ask-orchestrator` | Worker fragt, Orchestrator entscheidet (schon da) |
| `read-only` | Reviewer/Architect/Docs schon per Prompt; Host kann `inspect` erlauben und Writes im Worktree verweigern (optional, später) |

Nicht: ein Permission-Produkt nachbauen. Nur die eine Frage, die heute
in der TUI verschwindet, zurück in Events holen.

---

## Tier 2 — Verifikation und Integration als Host-Kante

Isolation ohne Merge-Pfad ist ein Museum von `vertragus/*`-Branches.
Der Prompt sagt dem Orchestrator, er solle einen Agenten mit
`baseBranch` starten und mergen lassen. Das darf der Default bleiben —
aber der Host kann die Kante prüfen.

### 2.1 `integrate_branch` (Orchestrator-Tool)

```
integrate_branch{fromAgentId, onto: 'orchestrator' | agentId, mode: merge | rebase}
```

Host führt `git merge` im Ziel-Worktree aus, nicht der Orchestrator
selbst (Prompt: keine Git-Befehle). Ergebnis ist ein Event:

- `integrate_ok` mit SHA
- `integrate_conflict` mit Konfliktdateien → Orchestrator startet einen
  Worker auf genau diesem Branch

Kein Autopush, kein Merge nach `main` ohne den User (siehe 2.3).

### 2.2 Verify-Gate, nicht nur „start a tester“

Konvention, die der Host kennt:

1. Worker done + Snapshot (0.3)
2. Reviewer auf dem Branch, `agent_done` ohne Blocker
3. Tester auf dem Branch, `status: success`
4. Erst dann darf `integrate_branch` oder „fertig“ gelten

Kein zweiter Orchestrator. Ein Flag am Profil `requireVerify: boolean`
(Default an für Profile mit Reviewer- und Tester-Slot). Der Host
weigert `record_retro` / „run complete“ nicht — er *warnt* im Tool-Result
und am Panel, wenn integriert wurde ohne Gate. Harness, kein Kindersicher.

### 2.3 Promote ist eine User-Aktion

Button auf der Karte: „Branch nach \<base\> mergen“ (base = der Branch,
auf dem das Profil-Repo steht, typisch `main`/`master`). Läuft nur nach
Gate oder mit explizitem Override. Git weigert dirty/uncommitted wie
beim Worktree-Cleanup (`--force` gibt es nicht).

Der Agent räumt nichts weg. Der Mensch entscheidet, was in *sein* Repo
darf. Das ist dieselbe Vertrauensregel wie „kein Cleanup hinter dem Rücken“.

### 2.4 Konflikt- und Datei-Landkarte

Kein File-Locking über Agenten hinweg — Worktrees machen das unnötig.
Was fehlt, ist die *Landkarte nach dem Merge*: welche Dateien mehrere
Agenten angefasst haben, bevor integriert wird. `inspect_agent` + Diff
gegen gemeinsame Basis reicht; als Panel-Zeile: „3 Files in beiden
Branches“. Reine Ableitung, kein neuer Store.

---

## Tier 3 — Lauf, Gedächtnis, Briefing

### 3.1 Repo-Briefing in den Orchestrator-Prompt

Heute: Workspace-Name, Repo-Pfad, Rollen, Limits, Retro-Knowledge.
Kein Wort aus dem Repo selbst.

Kurzer, gecappter Block aus Host-Lesen (Orchestrator-Worktree, also HEAD):

- `AGENTS.md` / `CLAUDE.md` / `VERTRAGUS.md` (erste N Zeichen)
- `README.md` (erste Überschriften)
- `git log -8 --oneline`

Das ist kein RAG. Das ist dasselbe Prinzip wie die Retro-Knowledge-Zeilen:
kleine, deterministische Beilage, die ein PTY-Seed noch trägt.

### 3.2 Event-Journal, nicht nur Ring 1000

`EventQueue` droppt still über Kapazität. Der Retro-Tap fängt alles für
*nach* dem Stop. Der Orchestrator mit altem Cursor sieht mitten im Lauf
eine Seq-Lücke.

- Overflow als explizites Event `events_dropped{from,to}` (ehrlich)
- Optional: Journal-Datei unter `.vertragus/runs/<id>/events.jsonl`

Damit wird Resume denkbar (3.3), ohne den Ring zu „unbegrenzt“ zu machen.

### 3.3 Resume nach Crash

Heute stirbt mit dem Prozess: Queue, Tickets, PTYs. Die Worktrees und
Branches überleben absichtlich.

Minimaler Resume:

1. Journal + letzte Agent-Metadaten (id, role, branch, worktreePath)
2. Beim Start: „Paradiso (fortsetzen)?“ — PTYs neu spawnen im alten
   Worktree, MCP-URLs neu, Contract-Reminder, Orchestrator bekommt ein
   `run_restored`-Briefing (wer lebte, welcher SHA, offene Fragen = tot)

Offene `ask_orchestrator`-Tickets sind nach Crash ungültig — ehrlich
so sagen, nicht so tun als warte noch jemand. Das ist schwerer als 0.x
und kommt danach.

### 3.3b Wissen, das nicht nur Modelle bewertet

Retro bewertet *Modelle in Rollen* (Wilson + qualitative Insights).
Was fehlt, ist *Repo-Wissen*: „in diesem Repo die Tests so starten“,
„nicht an `electron-builder.yml` fassen ohne…“.

Nicht: Vektor-DB. Sondern:

- `record_retro` darf zusätzlich `repoNotes[]` (kurz, wie Insights)
- nächster Lauf desselben `profileId` sieht sie im Prompt, analog Knowledge
- User kann sie im Retro-Panel löschen (der Delete-Button existiert schon
  für Model-Learnings)

### 3.4 Budget-Sicherung

`maxSubagents` ist Concurrency, kein Cost-Fuse. Ein Lauf kann Stunden
Agent-Zeit fressen, ohne dass Vertragus das als Zahl kennt.

Leicht, ohne Provider-Billing-APIs:

- Wanduhr pro Agent und Summe, am Panel und in `await_events.agentsSummary`
- Profil: `maxRuntimeMin` → Event `budget_warning` / `budget_exceeded`
- Optional hart: keine neuen `start_agent` mehr, laufende dürfen done
  melden

Token-Zähler erst, wenn ein Provider sie zuverlässig auf stdout legt —
nicht raten.

---

## Tier 4 — Cockpit, Rezepte, Welt

Erst wenn 0–2 sitzen. Sonst wird das Panel wieder das Archiv.

### 4.1 Workspace-Karte als Mini-Trace

Aus Events ableiten, kein neuer Store:

- Goal (eine Zeile)
- laufende Aufgabe
- Agentenzeile: Rolle, Modell, Branch, porcelain-Dot, `?`
- letzte 8 Events als Log

Klick auf den Agenten bleibt Fokus. Klick auf `?` wird 1.3.

### 4.2 Playbooks ≠ vorstartetes Team

Profile bleiben Team-Zusammensetzung. Ein Playbook ist ein Goal-Template:

- „Mach die Tests grün“
- „Implementiere \<Issue\>“
- „Review \<Branch\>“

Es seedet nur den Goal-Text (0.6) plus vielleicht `requireVerify`.
Es startet keine festen Fenster. Das ist der Unterschied zum alten Repo.

### 4.3 Extra-MCP für Worker, nicht für den Orchestrator

Worker haben heute nur Vertragus-Reporting plus die Builtins ihrer CLI.
Browser, Issue-Tracker, Docs-Suche gehören an den *Worker*, scoped über
das Profil (`slot.extraMcp[]` oder profilweit). Der Orchestrator bekommt
sie nicht — sonst fängt er an, die Welt selbst zu bedienen, statt zu
delegieren.

Attach-Code kennt schon fünf Dialekte. Ein weiterer Server in derselben
Datei ist eine Erweiterung von `mcp/attach.ts`, kein neues Subsystem.

### 4.4 Eval des Loops, nicht nur des Handshakes

`tests/live/handover.live.test.ts` beweist: Assignment kommt an,
`report_done` kommt zurück. Das ist die richtige erste Messlatte.

Die zweite:

1. Mini-Repo mit absichtlichem Bug
2. Goal an den Orchestrator
3. Assert: Worker started, `inspect` zeigt Dateiänderung, Tester
   `success`, Orchestrator ruft `record_retro`
4. Negativ: Orchestrator editiert nicht selbst (kein Diff im
   Orchestrator-Worktree)

Ohne diese Probe bleibt „starker Harness“ eine Meinungsäußerung.

### 4.5 Rollen, die fehlen — nur als Templates

Die fünf Builtins (Worker, Reviewer, Tester, Architect, Docs) decken
den Coding-Loop. Sinnvolle weitere *Templates*, kein neuer Mechanismus:

- **Janitor** — nur Merge-Konflikte und Reverts, kein Feature-Code
- **Explorer** — read-only, „wo hängt X“, kein Edit (Architect ist zu
  entscheidungsorientiert dafür)

Browser/Designer erst, wenn Extra-MCP (4.3) existiert. Sonst sind es
Prompts ohne Hände.

---

## Was wir bewusst nicht wollen

Diese Liste ist Teil der Idee. Das Archiv ist voll von Features, die
den Kern weich gemacht haben.

- **Peer-to-Peer zwischen Subagents.** Star über den Orchestrator ist
  die Produktidee. Mailbox-Dateien zwischen Worktrees erzeugen genau
  die Race, die Worktrees verhindern.
- **Vorstartetes Team.** Slots sind Baupläne. Playbooks dürfen daran
  nichts ändern.
- **Orchestrator, der committet, merget, testet, pusht — selbst.**
  Host-Tools ja; seine CLI bleibt ohne Yolo und ohne Write.
- **Automatisches Löschen von Worktrees/Branches.** Cleanup bleibt
  User-Klick, Git ohne `--force`.
- **Hardcodierte Modellkataloge.** Discovery + Seeds (rolling aliases)
  bleiben die Regel.
- **RAG / globale Memory-DB.** Repo-Notes (3.3b) und Model-Learnings
  reichen; alles Größere wird Prompt-Müll im PTY-Seed.
- **Zweite Orchestrierung** (Kanban-Produkt, DAG-Engine, Cloud-Runner).
  Wer das will, sitzt auf den Events — der Loop bleibt lokal, MCP,
  sieben-plus-wenige Tools.
- **`read_output` als Verifikation verkaufen.** TUI-Tail ist Diagnose
  nach `agent_exited confirmed: false`, sonst nichts.

---

## Vorschlag der Reihenfolge

Invasive Tiefe grob, nicht in Kalender:

| Schritt | Was | Warum zuerst |
| --- | --- | --- |
| A | 0.1 `inspect_agent` + 0.2 Done-Fakten | Verifikation wird wahr, ohne UX-Umbau |
| B | 0.3 Snapshot-Commit + 0.4 Handoff-Paket | `baseBranch` zeigt auf Arbeit |
| C | 0.6 Goal-at-Play + 1.2 `user_message` + 1.1 `ask_user` | Mensch ist im Loop |
| D | 0.5 Idle-Event + 3.2 Drop-Event | Stille und Lücken sind sichtbar |
| E | 2.1–2.3 Integrate / Gate / Promote | Isolation hat einen Ausgang |
| F | 3.1 Briefing + 3.3b Repo-Notes | Nächster Lauf startet nicht kalt |
| G | 4.1 Cockpit-Trace + 1.3 Fragen im Panel | UI holt nach, was der Loop schon kann |
| H | 3.3 Resume, 3.4 Budget, 4.2–4.4 Playbooks / Extra-MCP / Loop-Eval | erst mit festem Boden |

A und B sind der eigentliche Sprung zum „starken Harness“: der Host
kennt den Git-Zustand, der Orchestrator muss ihn nicht glauben, Handoff
ist eine Kante statt eine Bitte im Task-Text.

C ist der Sprung zum Werkzeug, das man im Alltag steuert, statt einem
Glas-Panel, das Teams ausspuckt und hofft, man tippe ins richtige Fenster.

---

## Anhang: konkrete Code-Anker

| Thema | Wo |
| --- | --- |
| Sieben Orchestrator-Tools | `src/main/mcp/toolsOrchestrator.ts` |
| Drei Subagent-Tools + Tickets | `src/main/mcp/toolsSubagent.ts` |
| Event-Vokabular | `src/shared/schema/events.ts` |
| Ring 1000, ehrliche Seq-Lücke | `src/main/mcp/eventQueue.ts` |
| Contract an `start_agent` / Reminder | `src/shared/prompts/contract.ts` |
| Orchestrator-Prompt (User ersetzen, selbst committen lassen) | `src/shared/prompts/orchestrator.ts` |
| Worker „nie committen“ | `src/shared/prompts/roles.ts` |
| Worktree-Pflicht, kein Autodelete | `src/main/agents/worktree.ts` |
| Host startet Agenten, pusht kein `agent_done` (MCP) | `src/main/workspace/Workspace.ts` |
| Play ohne Goal | `src/main/appIpc.ts` `workspaces:start`, `src/main/devRun.ts` |
| Claude-Allowlist Read/Glob/Grep | `src/main/mcp/attach.ts` `READONLY_CLAUDE_TOOLS` |
| Panel = Launcher | `src/renderer/src/panel/PanelApp.tsx`, `WorkspaceCard.tsx` |
| Retro ohne Datei-Fakten | `src/shared/schema/retro.ts`, `src/shared/retro/runStats.ts` |
| Sentinel ASK ist verdrahtet | `Workspace.handleSentinelReport` — der Kommentar „Task 3“ in der Dateikopfzeile ist veraltet |
| `runStats.ts` behauptet Cursor habe kein `agent_done` | veraltet: Cursor ist `mcp: cursor-project`; `none` ist Ollama. Sentinel-DONE *ist* `agent_done` |

Stale Kommentare sind keine Features, aber sie zeigen, wo das mentale
Modell des Repos hinter dem Code zurückbleibt — beim Harness-Umbau
mitkorrigieren.
