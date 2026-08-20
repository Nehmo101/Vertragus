# Vertragus als AI-Harness

Ideen, die aus dem Code kommen — nicht aus einer generischen Agent-Roadmap.

Copy-paste-fähige Agent-Prompts für alle offenen Tracks:
[`PROMPT-MCP-HARNESS.md`](./PROMPT-MCP-HARNESS.md).

**Stand:** [PR #17](https://github.com/Nehmo101/Vertragus/pull/17) hat BigBoy
A1–A3, Remote (B) und Harness C1/C2 (`inspect_agent`, Host-Fakten auf
`agent_done`) **umgesetzt**. Dieses Dokument ist der Plan danach.

**These, unverändert:** Der Loop ist schon ein Harness. Was fehlt, ist
*Host-Wahrheit* für Git-Zustand, Diffs und den Menschen im Event-Strom.
BigBoy macht den Loop *stabil und fernsteuerbar*. Es macht ihn nicht
*wissend*.

---

## Was PR #17 gelandet hat (nicht nochmal bauen)

| Plan | Im Code |
| --- | --- |
| A1 Lifecycle | `orchestrator_exited`, Quit awaited, `beginAgent` reserviert sync (`starting`), `slotWithCapacity` (Overflow auf den nächsten Slot derselben Rolle) |
| A2 MCP | async `start_agent` → `{state:'starting'}` plus `agent_started` / `agent_start_failed`; per-agent HMAC-Subtokens; Host/Origin-Rebinding; MCP-Configs in `.git/info/exclude`; `await_events.eventsDropped` (**Feld am Tool-Result**, kein synthetisches Event `events_dropped`) |
| A3 Panel | echte `WorkspaceDirectory.onChange` (kein 4s-Poll), panelBounds, glob-Window-Security, xterm Links/Suche, Main-Process-i18n, zustand weg |
| B Remote | HTTP+WS, Tailscale-Bind, Pairing, Gateway-Allow-List, Web-Client, Settings |
| H3 Prompt | `orchestrator.ts` kennt async start / `agent_started` / `agent_start_failed` |
| C1 `inspect_agent` | Read-only Git gegen das Agent-Worktree (`status` / `diff` / `log` / `file`) |
| C2 Host-Fakten auf `agent_done` | `branch`, `headSha`, `uncommitted`, `changedFiles`, `diffStat` — nicht als git-status auf jedem `list_agents` |

Gateway-Allow-List ist seit Track 0 **fünf Verben**: `workspaces:list`,
`workspaces:start` (jetzt mit optionalem `goal`), `workspaces:stop`,
`profiles:list`, `answer_question`. Kein `focus_agent` / `stop_agent` auf dem
Gateway. `resize` existiert im WS-Protokoll; es ist kein Produktziel von
Remote-v1.

Nicht duplizieren: Lifecycle, MCP-Auth, EventQueue-Gap, Panel-Push,
Remote-Server.

---

## Was nach #17 noch fehlt

| Haken / Phase | Status |
| --- | --- |
| H1 `answer_question` am Gateway | **umgesetzt** (Track 0) — ein Host-Pfad (`mcp/answerQuestion.ts`), Gateway-Verb, Panel-Badge |
| H2 `workspaces:start {goal}` | **umgesetzt** (Track 0) — Goal-Seed über den Assignment-Handshake, Back-compat ohne Goal |
| C3 Snapshot-Commit / C4 Handoff-Paket | **umgesetzt** (Track 1) — `snapshotDone` committet dirty Worktrees beim Done; `start_agent{baseBranch}` trägt Handoff-Block |
| C5 Orchestrator-Idle-Watchdog | **umgesetzt** (Track 2) — `orchestrator_idle` Event + Panel/Remote-Hinweis; Timeouts ≠ Idle (Touch bei Call-Start und -Ende) |
| C6 Orchestrator-Succession (Context-Handoff) | **S1 im Code** — siehe [`ORCHESTRATOR-SUCCESSION.md`](./ORCHESTRATOR-SUCCESSION.md) |
| D Mensch im Loop | **D1–D4 umgesetzt** (Track 3 + Follow-up) — Goal-UI, `user_message` weckt `await_events`, `ask_user` mit Ticket; D4 Stufen `yolo`/`ask-user`/`ask-orchestrator` (Store-Spiegel zu `yoloMaster`, Contract-Approval-Regel, Threat-Model im README) |
| E integrate / briefing / eval | **Kern umgesetzt** (Track 6) — `integrate_branch` + Gate-Warnung + Promote-Klick, Briefing + `repoNotes`, Journal + Resume (E3, Briefing statt Re-Spawn), Budget-Wanduhr, Janitor/Explorer, Playbooks, Extra-MCP an Worker (E6), Loop-Eval (E5, `tests/integration/loopEval`) — Phase E vollständig |
| F Multi-Orch (Lead, Tiefe 1) | **umgesetzt** (Track 5) — dritte Identität `lead=`, eigene Queues, `start_orchestrator`, Fan-in nur Direktkinder, Reparent (`subtree_adopted`), Caps host-seitig |

---

## Zwei Haken, die Remote noch zementiert

H3 ist in #17 erledigt. H1 und H2 fehlen — ohne sie bleibt der Mensch am
Terminal, nur eben über Tailscale.

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

### H3 — erledigt in PR #17

`buildOrchestratorSystemPrompt` kennt `{state:'starting'}`, `agent_started`
und `agent_start_failed`. `send_to_agent` gegen `starting` ist ein klarer
Fehler. `inspect_agent` ebenso.

### Slot-Mapping, auch nach A1.3

`slotWithCapacity` nimmt den ersten Slot der Rolle *mit freier Kapazität*.
Limits summieren über alle Slots. Das schließt TOCTOU und den Cap-Bug.

Es schließt **nicht**: zwei Worker-Slots Claude vs. Codex. Der
Orchestrator kann `model` überschreiben, nicht den Provider. Es gewinnt
weiter „erster mit Platz“, also meist immer Claude.

**Umgesetzt (Track 4):** `start_agent{role, providerId?, slotId?}` — eine
explizite Wahl fällt hart (unbekannt/voll = Fehler, kein stilles
Ausweichen), ohne Wahl bleibt „erster mit Platz". Der Orchestrator-Prompt
listet die Slots (Provider/Model) je Rolle, damit die Wahl informiert ist.
Caps bleiben sync über die Reservierung.

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
| Identität | URL-gebunden, per-agent HMAC-Subtoken, Host/Origin-Check, MCP-Configs in `.git/info/exclude` |
| Push / Lifecycle | `orchestrator_exited`, Quit awaited, `onChange`-Feed statt 4s-Poll |
| Remote | Tailscale-Bind, Pairing, vier Gateway-Verben, Web-Client |

Neue Kraft danach kommt als *Host-Tool oder Event im bestehenden Loop*,
nicht als zweite Orchestrierung und nicht als zweiter Remote-Weg.

---

## Die drei Löcher, die BigBoy nicht schließt

### 1. Der Orchestrator sieht die Arbeit seiner Agenten nicht — C1/C2

Jeder Agent inklusive Orchestrator hat ein eigenes Worktree
(`Workspace.createWorktreeFor`). Claudes Read/Grep laufen im
*Orchestrator*-Checkout (HEAD), nicht in Carontes Dateien. `read_output`
ist TUI-Schwanz. Codex/Kimi-Orchestratoren haben die Read-Tools gar nicht.

**Dieser PR:** `inspect_agent` liest das Agent-Worktree; `agent_done`
trägt Host-Fakten. Remote ändert daran nichts — Inspect bleibt ein
Orchestrator-Tool, kein Gateway-Befehl.

### 2. Handoff hängt an „committe bitte“ im Task-Text — bleibt C3/C4

Worker-Prompt: nicht committen, außer der Task sagt es. Orchestrator-
Prompt: erst committen lassen, dann `baseBranch`. C2 sagt, *ob* der
Branch dirty ist; C3 muss noch snapshot-commiten, sonst reviewt ein
Reviewer auf `baseBranch` immer noch HEAD, wenn der Worker nicht
committet hat.

### 3. Der Mensch ist kein Teilnehmer des Event-Loops

Play ohne Goal. Prompt: User-Fragen selbst beantworten. Kein `ask_user`,
kein `user_message`, das `await_events` weckt. Panel = Launcher
(`?` = Tooltip + Fokus).

BigBoy-Remote macht den Launcher fernsteuerbar. Ohne H1/H2 bleibt der
Mensch *am* Terminal, nur eben über Tailscale.

---

## Phase C — Harness-Kern (nach PR #17)

Kleine Oberfläche, großer Hebel. Voraussetzung liegt: Reservierung,
async start, Gap-Signal (`eventsDropped`), Push-Feed. `inspect_agent`
gegen `starting` ist derselbe Fehler wie `send_to_agent`.

### C1 `inspect_agent` — Host liest das Agent-Worktree — **umgesetzt**

```
inspect_agent{agentId, view: status | diff | log | file, path?, lines?}
```

Read-only, nie Hauptcheckout. Gecappt (80 k Zeichen Diff/Datei, Log
max 50). Prompt: Verifikation über `inspect_agent`, niemals über eigene
Git-Befehle, niemals über `read_output`. Provider-neutral.
Orchestrator-Tool, kein Gateway-Befehl (Remote soll nicht beliebige
Repo-Dateien lesen). Gestoppte Agenten bleiben inspectable — das
Worktree überlebt `stop_agent`.

### C2 `agent_done` trägt Host-Fakten — **umgesetzt**

Beim `report_done` / Sentinel-DONE hängt der Host an das Event:

- `branch`, `headSha`, `changedFiles[]`, `uncommitted`, `diffStat`

Git-Hänger dürfen das Done-Event nicht schlucken: Snapshot schlägt fehl
→ Event ohne Fakten, Orchestrator inspectet danach. Sentinel-DONE setzt
`doneSinceAssignment` synchron, damit `agent_exited.confirmed` auch
stimmt, wenn der Snapshot noch läuft.

**Nicht** auf jedem `list_agents` / `await_events`: das wäre
`git status` auf jedem Worktree in der Hauptschleife. Der porcelain-Dot
auf der Karte kann später das *letzte* `agent_done` ableiten oder
gezielt `inspect_agent` rufen — nicht den Feed verteuern.

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

### C6 Orchestrator-Succession (Context-Handoff)

Der Root-Orchestrator ist der einzige LLM, der den Lauf akkumuliert.
Subagents haben isolierte Kontexte; bei langen Läufen läuft *sein*
Fenster voll — nicht ihres.

**Succession** = serieller Ersatz von `orchestratorRecord` im selben
Workspace: frischer Kontext, strukturiertes Host-Paket, Team und
`EventQueue` bleiben. Das ist **kein** zweiter paralleler Root, kein
Lead (F), kein C4-Worker-Paket.

Kurzentscheidungen (Details und State-Machine im eigenen Doc):

- Trigger: Orchestrator-Tool `request_succession` (Self-Declare); User-
  Button als Escape; **kein** Host-Token-Zähler
- Cutover: `orchToken` rotieren → Successor spawnen/seeden → alten PTY
  killen; `subToken` und Worker-URLs unverändert
- Dieselbe `EventQueue` + `PendingQuestions`; Paket trägt `eventCursor`
- `record_retro` ist Run-Ende, nicht Handoff — Host blockt Non-Active
- C5 ist orthogonal (Stille ≠ Context-Full); C3 sollte vor/mit Harden
  landen, damit SHAs im Paket stimmen

Vollständiger Plan: [`docs/ORCHESTRATOR-SUCCESSION.md`](./ORCHESTRATOR-SUCCESSION.md).

**S1 im Code:** `request_succession` (neuntes Orchestrator-Tool), Host-Paket,
`orchToken`-Rotation (alte URL → 401, Subagent-URLs bleiben), Successor-Seed
mit `eventCursor` und offenen Fragen, Fence `succession_in_progress` auf
mutierenden Tools, `record_retro` währenddessen verboten. User-Button, C5
und C3-SHA-Härtung sind später.

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

**Status: umgesetzt.** `agentPolicy` im Store (gespiegelt mit `yoloMaster`,
eine Wahrheit), Dreifach-Picker im Settings-Fenster, `ask-user` nimmt den
Subagents die Yolo-Flags, `ask-orchestrator` hängt eine Approval-Regel in
den Task-Contract (beide Dialekte); ehrliches Threat-Model im README.

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

**Status: umgesetzt.** Journal schreibt `events.jsonl` + `meta.json`
(Goal, Profil, `resumedFrom`); `resume.ts` liest fail-soft, wählt den
neuesten Lauf des Profils und baut das Resume-Briefing für einen NEUEN
Orchestrator (Branches/Worktrees bleiben, Chaining via
`start_agent{baseBranch}`); Panel-Button „Letzten Lauf fortsetzen“ im
Play-Fold-out. Kein Re-Spawn alter CLI-Prozesse — offene Tickets nach
Crash = tot, das Briefing sagt es wörtlich.

A2.3 macht die Lücke *sichtbar*. Resume braucht zusätzlich ein Journal
(`.vertragus/runs/<id>/events.jsonl`) + Re-Spawn in alten Worktrees.
Offene Tickets nach Crash = tot, ehrlich sagen. Spät.

### E4 Budget als Wanduhr

`maxSubagents` ist Concurrency. Summe Agent-Sekunden + `maxRuntimeMin` →
`budget_warning` / keine neuen Starts. Keine geratenen Token-Zähler.

### E5 Loop-Eval

**Status: umgesetzt** (`tests/integration/loopEval.integration.test.ts`):
Temp-Repo mit gepflanztem Bug, echte `git worktree`-Maschinerie (Spawn/
Seed gefaked, keine CLI-Prozesse), Worker fixt in seinem Worktree →
`snapshotDone` committet (C3) → `inspect_agent` zeigt den Fix → Tester
mit `baseBranch` auf dem Worker-Branch sieht ihn (C4 real) und meldet
success ohne uncommitted — Orchestrator-Worktree und Haupt-Checkout ohne
eigenen Diff.

Handover-Live-Test bleibt. Zweite Probe: Mini-Repo mit Bug, Goal an
Orchestrator, Assert Worker + `inspect` zeigt Datei + Tester success +
Orchestrator-Worktree ohne eigenen Diff.

### E6 Playbooks, Extra-MCP, fehlende Rollen

**Status: umgesetzt** (Playbooks/Rollen in Track 6, Extra-MCP im
Follow-up). Slot-Schema `extraMcp: [{name, url}]` (Name TOML-sicher,
`vertragus` reserviert, max 4); alle fünf Attach-Dialekte schreiben die
Zusatz-Server (Claude strict-File, Codex `-c`-Overrides, Kimi/Cursor/Grok
Projekt-Dateien) — **nur für Subagents**, Orchestrator/Lead nie. Kein
Formular-Feld: der Store bewahrt `extraMcp` über Editor-Saves (wie
Zones), konfiguriert wird per Profil-JSON.

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
/mcp?ws=&token=<orch>              → acht Orchestrator-Tools (inkl. inspect_agent)
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
| Nach unten (scoped auf den eigenen Unterbaum) | `start_agent`, `send_to_agent`, `await_events`, `list_agents`, `stop_agent`, `read_output`, `inspect_agent` |
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
- Automatische Succession aus geratenen Token-Zählern (C6 ist Self-Declare
  + optional User-Button, kein Host-Ratespiel)
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
PR #17   A1–A3 + B Remote + H3 + C1 inspect_agent + C2 Done-Fakten
     │
     ├─ noch offen an Remote:  H1 answer_question   H2 start{goal}
     │
     └─ Phase C   C3/C4 Snapshot-Commit + Handoff-Paket     später
            C5 Orchestrator-Idle-Watchdog             später
            C6 Orchestrator-Succession (Context-Handoff)  S1
            F   Multi-Orch (Root entscheidet; braucht C, braucht B nicht)
            D   Goal-UI, user_message, ask_user (braucht H1/H2)
            E   integrate/gate, Briefing, Resume, Budget, Eval
```

F danach: ohne Inspect ist jeder Lead genauso blind wie der eine Root
vorher. D wird billiger, wenn H1/H2 nachgezogen werden. E braucht C
(ohne Inspect und Snapshot ist Gate Theater). C6 braucht C1/C2 (da),
sollte C3 mitnehmen, und ist **nicht** F — Succession ersetzt den Root
seriell; F nestet unter ihm.

Der Sprung zum *starken* Harness bleibt C (Host kennt Git). Der Sprung
zum *steuerbaren* Harness bleibt D + H1/H2 (Mensch im Loop, auch vom
Handy). F ist der Sprung zur *breiten* Umsetzung, den der Root nur
wählt wenn flach nicht mehr trägt. C6 ist der Sprung zur *langen*
Umsetzung, wenn der Root-Kontext voll läuft. A/B sind das Fundament.

---

## Anhang: Code-Anker

| Thema | Wo | Stand |
| --- | --- | --- |
| Orchestrator-Exit | `Workspace.ts` `handleExit` → `orchestrator_exited` | **PR #17** |
| Slot mit freier Kapazität | `Workspace.ts` `slotWithCapacity` | **PR #17** |
| Async `start_agent` | `toolsOrchestrator.ts`, Prompt in `orchestrator.ts` | **PR #17** |
| Per-Agent-Subtoken + Origin | `server.ts` `subagentToken`, `isAllowedHostHeader` | **PR #17** |
| Gap sichtbar | `eventQueue.ts` `droppedSince` → `await_events.eventsDropped` | **PR #17** |
| Panel-Push | `WorkspaceDirectory.onChange` | **PR #17** |
| Quit awaited | `index.ts` `before-quit` | **PR #17** |
| Elf Orchestrator-Tools + `request_succession` | `toolsOrchestrator.ts` inkl. `inspect_agent` | **C6 S1** |
| Host-Fakten auf `agent_done` | `toolsSubagent.ts` `report_done`, Sentinel in `Workspace.ts` | **PR #17** |
| MCP-Identität dreifach (Root/Lead/Blatt) | `server.ts` `McpIdentity` inkl. `lead=` + `leadToken` | **Track 5** |
| Ein Orchestrator pro Workspace | `Workspace.startOrchestrator` wirft bei Zweitem — C6 ersetzt seriell, nestet nicht | **C6 S1** |
| Goal at Play | `workspaces:start{goal}` Panel + Gateway, Seed via `Workspace.assignGoal` | **Track 0** |
| MCP-Fragen vom Handy/Panel | `answer_question` Gateway-Verb + `workspaces:answerQuestion`, ein Pfad in `mcp/answerQuestion.ts` | **Track 0** |
| Worker „nie committen” + Host-Snapshot | `roles.ts`, `Workspace.snapshotDone`, `commitWorktree`, Handoff in `toolsOrchestrator.ts` | **Track 1** |
| `runStats.ts` „Cursor hat kein agent_done“ | veraltet (`none` = Ollama) | ignorieren |
