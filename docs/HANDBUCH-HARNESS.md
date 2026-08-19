# Vertragus als AI-Harness

Ideen, die aus dem Code kommen — nicht aus einer generischen Agent-Roadmap.
Aktualisiert gegen den **BigBoy-Plan** (Robustheit A1–A3 + Remote über
Tailscale, Branch `claude/vertragus-review-improvements-i3ftsv`).

**These, unverändert:** Der Loop ist schon ein Harness. Was fehlt, ist
*Host-Wahrheit* für Git-Zustand, Diffs und den Menschen im Event-Strom.
BigBoy macht den Loop *stabil und fernsteuerbar*. Es macht ihn nicht
*wissend*. Die zwei Tracks dürfen sich nicht in die Quere kommen.

---

## Verhältnis zum BigBoy-Plan

BigBoy ist der richtige erste Zug. Mehrere Punkte aus der ersten Fassung
dieses Handbuchs sind damit **obsolet als eigene Arbeit** — sie gehören
jenem Branch, nicht einem zweiten.

| Dieses Handbuch (alt) | BigBoy | Status |
| --- | --- | --- |
| Orchestrator-Stille (Prozess tot) | A1.1 `orchestrator_exited`, Karte greyed | **deren A1** — war bei mir eine Lücke |
| Event-Ring ohne Gap | A2.3 `events_dropped {from,to}` | **deren A2** — 1:1 was hier 3.2 war |
| 4s-Panel-Poll | A3.1 `WorkspaceDirectory.onChange` | **deren A3** — Voraussetzung für Remote-Fan-out |
| Token-Identität als Stärke | A2.2 Per-Agent-Subtokens, Origin/Rebinding, Exclude | **korrigiert:** Identität ist *noch nicht* hart |
| — | A1.2 Quit awaited, A1.3 Slot-Reservierung, A2.1 async `start_agent` | neu, richtig, hier nicht duplizieren |
| Goal-at-Play, Fragen beantworten | B sagt: tippen in die TUI | **Konflikt** — siehe unten |
| `inspect_agent`, Snapshot-Commit, Handoff | nicht im Plan | **bleibt hier**, nach A |
| `ask_user` / `user_message` | nicht im Plan | **bleibt hier**, nach A; B sollte eine kleine Kante offenhalten |
| Multi-Orchestrierung | nicht im Plan | **hier geplant**, nach A2 + C; Root entscheidet, Default bleibt flach |

Nicht anfassen, solange A/B auf dem anderen Branch läuft: Lifecycle,
MCP-Auth, EventQueue-Gap, Panel-Push, Remote-Server. Dieses Dokument
beschreibt nur noch den **Harness-Kern danach** plus drei Haken, die
BigBoy billig mitbauen sollte, weil Remote sie sonst zementiert.

---

## Drei Haken an BigBoy (kein Scope-Sprung, kleine Kanten)

Der Plan ist in der Reihenfolge A-vor-B, MCP-bleibt-Loopback, Remote-
Allow-List, Yolo=RCE-opt-in richtig. Drei Stellen würden den späteren
Harness-Pass teuer machen, wenn B sie als „für immer PTY“ festnagelt.

### H1 — „Fragen beantworten = Terminal attach + tippen“ gilt nicht für MCP

`ask_orchestrator` parkt in `PendingQuestions`. Die Antwort kommt nur
über `send_to_agent{questionId}` (MCP-Tool des Orchestrators). Tippen in
die *Subagent*-TUI löst den Waiter nicht. Tippen in die *Orchestrator*-TUI
während `await_events` hängt, startet je nach CLI einen zweiten Turn —
zwei Hirne, ein Prozess.

Subagent-Badges in `WorkspaceSummary` sind die richtige Anzeige. Zum
*Beantworten* braucht das Gateway **einen** Extra-Befehl, der denselben
Pfad wie das MCP-Tool geht:

```
answer_question { workspaceId, agentId, questionId, text }
```

Das ist keine neue Orchestrierung. Das ist die Allow-List um eine Zeile
länger, und das Panel kann denselben Host-Pfad nutzen (Badge → Textfeld).
Ohne diese Zeile kann das Handy MCP-Fragen nicht beantworten — nur
CLI-Permission-Dialoge, die wirklich in der TUI leben.

Sentinel-ASK ist die Ausnahme, die fast in die TUI gehört (`deliverAnswer`
tippt in die PTY). Trotzdem sollte die Antwort über dieselbe Registry
laufen, sonst gibt es zwei Wahrheiten.

### H2 — `workspaces:start` ohne Goal ist auf dem Handy unbenutzbar

Play startet heute einen leeren Orchestrator; das Ziel wird in die TUI
getippt (`devRun.ts`, `workspaces:start(profileId)`). Am Desktop schon
die Klasse von Bug, die `autoSubmitTasks` lösen sollte. Am Handy mit
xterm + Software-Tastatur ist es der schlechteste Pfad im ganzen Remote-
Plan.

Billig in B1/B2:

```
workspaces:start { profileId, goal: string }
```

Host seedet das Goal über denselben Handshake wie jede Assignment.
Panel und Remote-Client teilen das Feld. Ohne Goal bleibt Start erlaubt
(Back-compat), aber die Karte zeigt „kein Ziel — Orchestrator wartet“.

### H3 — `start_agent` async braucht Prompt + `starting`-Semantik überall

A2.1 (Tool returns sofort `{agentId, state:'starting'}`, Seed im
Hintergrund, `agent_started` / `agent_start_failed` als Events) ist
richtig — der Seed darf das 60s-MCP-Timeout nicht reißen.

Bitte nicht vergessen, sonst ist A2.1 ein stiller Prompt-Bruch:

- `buildOrchestratorSystemPrompt` (`orchestrator.ts`), nicht nur
  `ORCHESTRATOR_INSTRUCTIONS` in `server.ts`
- `send_to_agent` / später `inspect_agent` gegen `starting` → klarer Fehler
- `list_agents` zeigt `starting` (A1.3-Reservierung macht den Slot schon
  voll — gut)
- Live-Handover-Test muss `await_events` auf `agent_started` warten,
  nicht den Sync-Return von `start_agent`

### Slot-Mapping, auch nach A1.3

`slotFor()` nimmt `slots.find(roleId)` — immer Slot[0] der Rolle
(`Workspace.ts:630`, `retroSink.ts:61`). Limits summieren über alle
Slots. A1.3 (erster Slot *mit freier Kapazität*) schließt den TOCTOU-
und den Cap-Bug.

Es schließt **nicht**: zwei Worker-Slots Claude vs. Codex. Der
Orchestrator kann `model` überschreiben, nicht den Provider. Nach A1.3
gewinnt weiter „erster mit Platz“, also meist immer Claude.

Harness-Rest, nicht A1: `start_agent{role, slotId? | providerId?}` oder
eine Rolle = ein Slot als Profil-Regel. Sonst ist Provider-Diversität
pro Rolle tote UI.

---

## Was schon stark ist (nicht nochmal bauen)

| Schicht | Stand |
| --- | --- |
| Runtime | PTYs, sichtbare Terminals, gemessener Seed-Handshake |
| Isolation | Pflicht-Worktrees, kein Shared-Checkout, kein Autodelete |
| Kommunikation | `await_events`, `ask_orchestrator` mit Ticket |
| Delegation | Slots = Bauplan, nicht vorstartetes Team |
| Lernen | Retro → Wilson + Insights in den nächsten Prompt |
| Provider | Ein deklaratives Schema |
| Identität | URL-gebunden, Subagent sieht nur Reporting-Tools — **A2.2 härtet die Löcher** (geteiltes `subToken`, keine Origin-Checks, Tokens in Worktrees) |
| Push / Lifecycle | **A1+A3 bauen das gerade** (Orchestrator-Exit, Quit, onChange) |

Neue Kraft danach kommt als *Host-Tool oder Event im bestehenden Loop*,
nicht als zweite Orchestrierung und nicht als zweiter Remote-Weg.

---

## Die drei Löcher, die BigBoy nicht schließt

### 1. Der Orchestrator sieht die Arbeit seiner Agenten nicht

Jeder Agent inklusive Orchestrator hat ein eigenes Worktree
(`Workspace.createWorktreeFor`). Claudes Read/Grep laufen im
*Orchestrator*-Checkout (HEAD), nicht in Carontes Dateien. `read_output`
ist TUI-Schwanz. Codex/Kimi-Orchestratoren haben die Read-Tools gar nicht.

Verifikation bleibt „Prosa in `report_done` glauben“ oder „Reviewer auf
`baseBranch` starten“. Remote ändert daran nichts — das Handy sieht
dieselbe TUI.

### 2. Handoff hängt an „committe bitte“ im Task-Text

Worker-Prompt: nicht committen, außer der Task sagt es. Orchestrator-
Prompt: erst committen lassen, dann `baseBranch`. `agent_done` hat nur
`summary` + `status`. Ein Reviewer auf einem leeren Branch reviewt HEAD.

A2.1 (`starting`) macht Starts ehrlicher, ändert Git-Zustand nicht.

### 3. Der Mensch ist kein Teilnehmer des Event-Loops

Play ohne Goal. Prompt: User-Fragen selbst beantworten. Kein `ask_user`,
kein `user_message`, das `await_events` weckt. Panel = Launcher
(`?` = Tooltip + Fokus).

BigBoy-Remote macht den Launcher fernsteuerbar. Ohne H1/H2 bleibt der
Mensch *am* Terminal, nur eben über Tailscale.

---

## Phase C — Harness-Kern (nach BigBoy A, parallel zu B ok wo markiert)

Kleine Oberfläche, großer Hebel. Setzt voraus: Reservierung (A1.3),
async start (A2.1), Gap-Signal (A2.3), Push-Feed (A3.1). `inspect_agent`
gegen `starting` ist dann derselbe Fehler wie `send_to_agent`.

### C1 `inspect_agent` — Host liest das Agent-Worktree

```
inspect_agent{agentId, view: status | diff | log | file, path?, lines?}
```

Read-only, nie Hauptcheckout. Gecappt (z. B. 80 kB Diff). Prompt wird:
„du verifizierst über `inspect_agent`, niemals über eigene Git-Befehle.“
Provider-neutral. Unabhängig von Remote — Orchestrator-Tool, kein
Gateway-Befehl (Remote soll nicht beliebige Repo-Dateien lesen).

### C2 `agent_done` trägt Host-Fakten

Beim `report_done` / Sentinel-DONE hängt der Host an das Event:

- `branch`, `headSha`, `changedFiles[]`, `uncommitted`, `diffStat`

Dieselbe Zeile in `list_agents` / `agentsSummary` (und damit im A3.1-
Feed → Panel und Remote-Karte bekommen den porcelain-Dot umsonst).

### C3 Snapshot-Commit beim Done (Default an)

Dirty Worktree → Commit auf dem Agenten-Branch

```
vertragus: <agent> / <role> — <erste Zeile der Summary>
```

Kein Push, kein `--force`. Worker-Prompt: „committe nicht selbst — der
Host snapshotet.“ `baseBranch` zeigt danach auf Arbeit.

### C4 Handoff-Paket an `start_agent`

Wenn `baseBranch` gesetzt: Host hängt letztes `agent_done` (Summary,
Files, SHA) an den Task. Reviewer muss den Diff nicht aus Prosa
rekonstruieren. Star-Topologie bleibt.

### C5 Orchestrator-*Idle* (nicht Exit)

A1.1 ist Prozess-Tod. Der andere Tod: der Prozess lebt, ruft
`await_events` nicht mehr. Subagents ohne MCP haben dafür schon den
120s-Silence-Hint. Der Orchestrator nicht.

Watchdog auf den letzten Orchestrator-Tool-Call → Event
`orchestrator_idle` + Panel/Remote-Karte. Optional eine Reminder-Zeile
in die TUI, einmal pro Stillephase. Weckt ihn nicht (er ruft ja nicht).

---

## Phase D — Mensch im Loop (nach C, Remote profitiert)

H1/H2 sollten in BigBoy B als Kanten schon existieren. D füllt sie.

### D1 Goal-at-Play

Siehe H2. Sobald `start({goal})` existiert: Panel-Pflichtfeld,
`VERTRAGUS_DEV_RUN` aus Env/stdin.

### D2 `user_message` weckt `await_events`

Composer auf der Karte (Desktop + Remote-Client, **nicht** nur raw
xterm). Absenden:

1. schreibt in die Orchestrator-TUI (sichtbar)
2. pusht `user_message` in die EventQueue → parkendes `await_events`
   kehrt sofort zurück

Remote-v1 hat `terminal_input`. Das reicht für CLI-Dialoge. Es reicht
nicht, den Orchestrator aus `await_events` zu holen. D2 ist der eine
WS-Message-Typ, den B später adden kann (`steer` / `user_message`),
sobald D2 im Host liegt. In B1 nicht vorbauen — nur das Gateway nicht
so schließen, dass eine neue Message-Art eine Protokoll-Neuauflage
braucht (`protocol.ts` als zod-Union macht das billig).

### D3 `ask_user` + Badge-Antwort

Orchestrator-Tool, blockierend, Ticket wie `ask_orchestrator`.
`user_question` auf der Workspace-Karte. Prompt-Zeile „answer with the
best-supported option“ fällt.

Subagent-Fragen: derselbe Host-Pfad wie H1 `answer_question`.
User-Fragen: Auflösen des `ask_user`-Waiters. Ein Textfeld, zwei
Backends.

### D4 Yolo als Policy

Heute ein Bool; Remote × Default-Yolo = RCE auf dem PC (BigBoy sagt das
richtig; opt-in + Tailscale-Bind + Kill-Switch ist die v1-Antwort).

Danach, nicht in B: Stufen `yolo` / `ask-user` / `ask-orchestrator`.
Remote darf in v1 nicht versuchen, CLI-Permission-TUIs auf dem Handy
schön zu machen — das ist genau der Pfad, der H1 nicht ersetzt.

---

## Phase E — Integration, Gedächtnis, Eval (spät)

Unverändert in der Sache, klar *nach* C.

### E1 `integrate_branch` / Verify-Gate / Promote

Host-Merge im Ziel-Worktree, Events `integrate_ok` | `integrate_conflict`.
Gate: Worker-Snapshot + Reviewer ohne Blocker + Tester `success`, dann
warnen wenn ohne Gate „fertig“. Promote nach `<base>` ist **User-Klick**
(Desktop; Remote-Allow-List bewusst ohne Worktree-Löschung — Promote
gehört analog nicht nach Handy-v1, zu nah an „mein Repo überschreiben“).

### E2 Briefing + Repo-Notes

Gecappter Block `AGENTS.md`/`CLAUDE.md`/`README`/`git log -8` in den
Orchestrator-Prompt. `record_retro.repoNotes[]` analog Model-Learnings,
löschbar im bestehenden Retro-Panel. Kein RAG.

### E3 Journal über den Gap hinaus / Resume

A2.3 macht die Lücke *sichtbar*. Resume braucht zusätzlich ein Journal
(`.vertragus/runs/<id>/events.jsonl`) + Re-Spawn in alten Worktrees.
Offene Tickets nach Crash = tot, ehrlich sagen. Spät.

### E4 Budget als Wanduhr

`maxSubagents` ist Concurrency. Summe Agent-Sekunden + `maxRuntimeMin` →
`budget_warning` / keine neuen Starts. Keine geratenen Token-Zähler.

### E5 Loop-Eval

Handover-Live-Test bleibt. Zweite Probe: Mini-Repo mit Bug, Goal an
Orchestrator, Assert Worker + `inspect` zeigt Datei + Tester success +
Orchestrator-Worktree ohne eigenen Diff.

### E6 Playbooks, Extra-MCP, fehlende Rollen

Playbook = Goal-Template, kein vorstartetes Team. Extra-MCP nur an
Worker (`mcp/attach.ts` kennt die Dialekte). Templates Janitor/Explorer,
keine neuen Mechaniken. Browser erst mit Extra-MCP.

Cockpit-Trace (Goal, porcelain-Dot, letzte Events) fällt zum großen Teil
als Ableitung aus C2 + A3.1-Feed ab — Panel und Remote-Client können
dieselbe `WorkspaceSummary` zeichnen. Kein dritter Store.

---

## Phase F — Multi-Orchestrierung (Root entscheidet)

Denkbar: ja. Sinnvoll: **manchmal**, und nur wenn der Hauptorchestrator
es wählt. Default bleibt ein flaches Team. Wer immer nestet, hat den
alten Fehler in einer neuen Form — Kontext-Explosion, unbeantwortete
Fragen, zu viele Fenster — nur eine Ebene tiefer.

Das ist **kein** zweites Produkt (kein Kanban, keine DAG-Engine, kein
zweiter Workspace pro Bereich). Es ist eine dritte MCP-Identität in
*demselben* Workspace, mit eigener EventQueue, damit der Root nicht
jedes Worker-Event seiner Unterbäume sieht.

### Wann ja, wann nein

Der Root bekommt das Tool. Der Host auto-nestet nie und lehnt auch
nicht ab, weil „der Task klein wirkt“ — das wäre das Gegenteil von
„er entscheidet“. Der Prompt sagt, wann er es brauchen *soll*:

| Nesten | Flach bleiben |
| --- | --- |
| ≥2 unabhängige Workstreams, die kaum Dateien teilen | Ein Bereich, ein Bug, ein Modul |
| Jeder Stream braucht eigenen Review/Test-Loop | Pipeline auf *denselben* Dateien: Architect → Worker → Reviewer (`baseBranch`, nicht ein Lead) |
| Ohne Nesting würde `await_events` den Root ersäufen (>~6 parallele Blatt-Agenten mit laufendem Hin und Her) | Zwei, drei Worker, die der Root selbst schickt |

Hybrid ist erlaubt und gewollt: Root startet einen Worker für etwas
Kleines *und* einen Sub-Orchestrator für einen großen Stream.

### Dritte Identität, nicht eine Rolle

Heute binär (`server.ts`):

```
/mcp?ws=&token=<orch>              → sieben Orchestrator-Tools
/mcp?ws=&agent=<id>&token=<sub>    → report_done / ask / progress
```

Dazu:

```
/mcp?ws=&lead=<id>&token=<per-agent>  → Lead-Tools (unten)
```

Ein Sub-Orchestrator ist **kein** Slot `roleId: orchestrator`. Er zieht
den Guide-Namen (`NameAllocator` kind `orchestrator`), die Bronze-Farbe
(oder ein dunkleres Bronze), denselben Provider/Model wie das Profil-
`orchestrator` (überschreibbar), und **kein Yolo**.

**Lead-Tools** (Union, bewusst):

| Richtung | Tools |
| --- | --- |
| Nach unten (scoped auf den eigenen Unterbaum) | `start_agent`, `send_to_agent`, `await_events`, `list_agents`, `stop_agent`, `read_output`, später `inspect_agent` |
| Nach oben (wie ein Subagent zum Root) | `report_done`, `ask_orchestrator`, `report_progress` |
| Verboten | `record_retro` (nur Root), `start_orchestrator` (Tiefe 1) |

**Root-Tools** zusätzlich:

```
start_orchestrator{area, task, maxSubagents?, model?, baseBranch?}
```

`area` ist ein kurzes Label für Prompt und Panel („payments“, `docs`).
`maxSubagents` ist das **Teilbudget**, das der Root abgibt — nicht ein
zweites Profil-Limit. `profile.maxSubagents` bleibt die globale Kappe
über Root-Kinder + alle Enkel (A1.3-Reservierung workspace-weit).

`start_agent` bleibt auf dem Root. Ohne das Tool könnte er nicht flach
arbeiten und nicht hybrid.

### Fan-in: der ganze Punkt

Jeder Lead hat eine eigene `EventQueue`. `await_events` des Roots sieht
**nur Direktkinder** (Worker, die er selbst startete, und Leads).
Events der Enkel landen nur in der Queue des Leads.

Sonst ist Nesting nutzlos: der Root hätte denselben Event-Sturm, plus
mehr Prozesse.

Der Retro-Tap (`WorkspaceManager` `onPush`) abonniert **alle** Queues —
Statistik nach dem Stop braucht die Enkel, der Root-Loop nicht.

`PendingQuestions` kann eine Registry bleiben (schon `agentId`-keyed).
Das Event `agent_question` muss in die Queue des *Parents* dieses
Agenten, nicht immer in die Root-Queue.

### Fragen steigen eine Stufe, nie zwei

```
Worker --ask--> Lead --(antwortet oder ask_orchestrator)--> Root --(später ask_user)--> Mensch
```

Ein Worker kann den Root nicht anrufen — seine URL hat keine Root-Tools.
Ein Lead, der eine User-Entscheidung braucht, fragt den Root; der Root
fragt (heute per Prompt, später via `ask_user`) den Menschen. Kein
Skip-Level, keine Peer-Fragen zwischen Leads. Koordination zweier
Bereiche = Lead fragt Root, Root entscheidet oder schickt den anderen
Lead eine Instruction (`send_to_agent` auf den anderen Lead).

`answer_question` (H1) adressiert denselben Host-Pfad; das Panel/Remote
zeigt `?` am Lead *und* am Worker. Antworten an den Worker gehen an
dessen Parent-Lead, nicht an den Root, außer der Worker ist Direktkind
des Roots.

### Git / Handoff

Gleicher Mechanismus wie flach, eine Ebene höher:

1. Lead lässt Worker snapshoten (C3) bzw. committet über den Host
2. Lead integriert auf *seinen* Branch (`baseBranch` / später
   `integrate_branch`)
3. Lead `report_done` mit seinem Branch/SHA
4. Root startet den nächsten Lead oder einen Merge-Worker mit
   `baseBranch` = Lead-Branch

Ohne C (Inspect + Snapshot) ist Multi-Orch Blindheit mal Anzahl Leads.
Deshalb **nach C**, nicht davor.

### Tod eines Leads

A1.1: Root-Tod lässt Subagents laufen, Karte greyed. Analog:

Lead-Prozess stirbt → Root bekommt `agent_exited` für den Lead.
**Reparent:** lebende Enkel werden Direktkinder des Roots, ihre Queue
wird in die Root-Queue übernommen (`subtree_adopted`). Arbeit geht
nicht verloren; der Root sieht plötzlich mehr Events — nur im
Fehlerfall, das ist der Deal.

Nicht: Enkel stoppen (zu hart). Nicht: Enkel ohne Parent (orphaned
`ask_orchestrator`).

### Caps, die der Host erzwingt (nicht der Prompt)

- Tiefe genau 1: `start_orchestrator` nur auf Root-Identität, sonst
  Tool-Error
- Max Leads z. B. 4 (Konstante, Profil darf enger)
- Globales `maxSubagents` inkl. Leads und Enkel
- Async start (A2.1) gilt für Leads genauso — Seed darf 60s nicht reißen
- Per-Agent-Token (A2.2) gilt für Leads genauso; Lead-Token öffnet weder
  Root-Tools noch Geschwister-Unterbäume

Per-Rolle-Limits in v1 **global** (ein Reservierungsnetz). Zwei Leads
die beide „2 Worker“ wollen, teilen denselben Worker-Cap. Teilbudgets
(`start_orchestrator{maxSubagents:n}`) begrenzen nur die *Größe des
Unterbaums*, nicht die Rollenzusammensetzung. Feiner (`roles` am Lead)
ist später; sonst bauen wir ein zweites Profil.

### Prompt-Kanten (Root)

Kurz, englisch, wie der Rest:

- Default flat. `start_orchestrator` nur wenn die Tabelle „Nesten“ oben
  zutrifft.
- Ein Lead ist ein Bereich mit eigener Verifikationsschleife, kein
  Umbenennen von `start_agent`.
- Nach `start_orchestrator` nicht die Enkel pollen — `await_events`
  liefert nur Lead-Events; in den Unterbaum schaut man mit
  `inspect_agent` auf den Lead (dessen Worktree/Branch), nicht mit
  `read_output` auf Enkel.
- Fertig = jeder Lead `report_done` + Root verifiziert (Inspect auf
  Lead-Branches) + ein Merge-Pfad + `record_retro`.

Lead-Prompt: Bereich, Parent-Name, dieselben Rollen/Limits wie das
Profil, plus „du startest keine Orchestratoren. Du reportest nach oben.“

### Panel / Remote

`WorkspaceSummary.agents` bekommt `parentId` + `kind:
'orchestrator' | 'lead' | <role>`. Flache Liste mit Einrückung reicht
v1 — kein Baum-Widget. Lead-Zeile zeigt `childCount` und das `?` wenn
*er* eine Frage an den Root hat. Enkel-`?` hängen am Lead, bis man die
Karte aufklappt (sonst blinkt die Root-Karte dauernd).

Remote-Allow-List: kein neuer Befehl außer dem schon geplanten
`answer_question` (Parent ergibt sich aus `agentId`). `start_orchestrator`
ist kein Remote-API — nur der Root-Agent ruft das Tool.

### Reihenfolge relativ zu C–E

Braucht: A1.3 Reservierung, A2.1 async start, A2.2 Per-Agent-Tokens,
A2.3 Gap (pro Queue). Braucht C (Inspect/Snapshot), sonst ist jeder
Lead so blind wie der Root heute.

Braucht B nicht. `ask_user` (D) wird mit einer Stufe dazwischen
wichtiger, ist aber nicht Blocker — Leads fragen den Root, Root
beantwortet (heute) selbst oder später den User.

Nicht in BigBoy A/B einbauen: das ist ein Identity-Umbau in
`server.ts` / `toolsOrchestrator.ts` / `Workspace.ts`, während A dort
gerade Lifecycle und Tokens anfasst.

---

## Was wir bewusst nicht wollen

- Peer-to-Peer zwischen Subagents **oder zwischen Leads**
- Vorstartetes Team / Playbooks die Fenster spawnen
- Orchestrator, der selbst committet, merget, testet, pusht
- Autodelete von Worktrees/Branches
- Hardcodierte Modellkataloge
- RAG
- Zweite Orchestrierung als **Produkt** (Kanban, DAG-Engine, Cloud-Runner,
  ein Workspace pro Bereich)
- Automatisches Nesting / Nesting-Profil-Toggle — der Root entscheidet
  per Tool, Default flach
- Tiefe > 1 (Lead startet Lead)
- Enkel-Events in der Root-`await_events`-Queue
- `read_output` als Verifikation
- **Remote als zweiten MCP-Server oder Spiegel aller APP_CHANNELS**
  (BigBoy-Allow-List ist die richtige Grenze)
- **Dieses Handbuch als parallelen Lifecycle-/Auth-Umbau** — das ist A/B
- Tunnel, TLS, Account-System, Internet-Exposure, native App, Archiv-
  `apps/mobile` (BigBoy-Non-Goals, hier übernommen)

---

## Reihenfolge (Tracks, keine Kalender)

```
BigBoy A1  Lifecycle (Exit, Quit, Reservierung, slotFor-Kapazität)
BigBoy A2  MCP (async start, Per-Agent-Token, Origin, events_dropped)
BigBoy A3  onChange-Push, panelBounds, Terminal-Links/Suche, Error-Codes
     │
     ├─ Haken in B:  H1 answer_question   H2 start{goal}   H3 Prompt/starting
     │
BigBoy B   Remote Tailscale (nach A; MCP bleibt loopback)
     │
     └─ Phase C   inspect + Done-Fakten + Snapshot + Handoff + Idle-Watchdog
            F   Multi-Orch (Root entscheidet; braucht C, braucht B nicht)
            D   Goal-UI, user_message, ask_user (nutzt H1/H2; mit F eine Stufe mehr)
            E   integrate/gate, Briefing, Resume, Budget, Eval
```

C kann an A andocken, sobald Reservierung + async start + Gap liegen —
es braucht B nicht. F danach: ohne Inspect ist jeder Lead genauso blind
wie der eine Root heute. D wird billiger, wenn H1/H2 in B schon existieren.
E braucht C (ohne Inspect und Snapshot ist Gate Theater).

Der Sprung zum *starken* Harness bleibt C (Host kennt Git). Der Sprung
zum *steuerbaren* Harness bleibt D + H1/H2 (Mensch im Loop, auch vom
Handy). F ist der Sprung zur *breiten* Umsetzung, den der Root nur
wählt wenn flach nicht mehr trägt. A/B sind das Fundament, ohne das
beides auf Sand steht.

---

## Anhang: Code-Anker

| Thema | Wo |
| --- | --- |
| Orchestrator-Exit geschluckt | `Workspace.ts` `handleExit` ~940, `if (record.orchestrator) return` |
| Slot[0] statt freier Kapazität | `Workspace.ts` `slotFor` ~630, `retroSink.ts` ~61, Limits `profile.ts` `slotLimitFor` |
| MCP-Timeout vs. Sync-Seed | `toolsOrchestrator.ts` `start_agent` / `send_to_agent` |
| Ein `subToken` für alle Subagents | `Workspace.ts` `this.subToken`, `server.ts` `resolveIdentity` |
| Kein Origin-Check | `server.ts` `handleRequest` |
| Ring ohne Gap-Event | `eventQueue.ts` `since()` |
| `onChange` deklariert, Manager emittiert nicht | `appIpc.ts` ~224/~1054, `usePanelData.ts` 4s-Poll |
| Quit nicht awaited | `index.ts` `before-quit` |
| Sieben Tools / drei Reporting-Tools | `toolsOrchestrator.ts`, `toolsSubagent.ts` |
| MCP-Identität binär (Root vs. Blatt) | `server.ts` `McpIdentity`, `resolveIdentity` |
| Guide-Namen nur für den einen Orchestrator | `agents/names.ts` kind `orchestrator` |
| Play ohne Goal | `appIpc.ts` `workspaces:start`, `devRun.ts` |
| Orchestrator-Prompt (User ersetzen, committen lassen) | `orchestrator.ts` |
| Worker „nie committen“ | `roles.ts` |
| `runStats.ts` „Cursor hat kein agent_done“ | veraltet (`cursor-project`; `none` = Ollama) |
