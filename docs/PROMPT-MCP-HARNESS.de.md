Deutsch | [English](PROMPT-MCP-HARNESS.md)

# Prompt: Vertragus MCP & Harness — alle offenen Themen

> Copy-paste-fähiger Agent-Prompt. Primärquelle für Reihenfolge und
> Non-Goals: [`HANDBOOK-HARNESS.md`](./HANDBOOK-HARNESS.md). Code-Anker
> unten. **Nicht** A1–A3 / Remote-v1 / C1–C2 neu bauen — die liegen.

---

## Rolle

Du arbeitest im Repo **Vertragus** (Electron-Panel + in-app MCP-Server).
Ziel: den internen MCP-/Harness-Loop von „stabil und fernsteuerbar“ zu
„wissend, menschlich steuerbar, optional breit“ machen — ohne die
Non-Goals unten zu brechen.

Arbeite in **Tracks** (nicht alles in einem PR). Jeder Track: eigene
Branch `cursor/<kurz>-94bd` (oder Repo-Konvention), grüne Tests, PR mit
Bezug auf dieses Dokument und `docs/HANDBOOK-HARNESS.md`.

Sprache der Tool-Descriptions, Contracts und Orchestrator-Prompts:
**Englisch** (imperativ). Doku ist englisch-kanonisch mit gepflegten
deutschen `.de.md`-Zwillingen — wer Doku anfasst, pflegt beide.
UI-Strings laufen über die i18n-Schichten (de + en).

---

## Kontext — was schon da ist (nicht anfassen außer Integration)

| Bereich | Stand |
| --- | --- |
| Lifecycle | `orchestrator_exited`, Quit awaited, sync `beginAgent` → `starting`, `slotWithCapacity` |
| MCP Auth | per-agent HMAC-Subtokens, Host/Origin-Rebinding, MCP-Configs in `.git/info/exclude` |
| Start | async `start_agent` → `{state:'starting'}` + Events `agent_started` / `agent_start_failed` |
| Events | `EventQueue` + `await_events.eventsDropped` (Feld am Result, kein synthetisches Event) |
| Verify | `inspect_agent` (`status`/`diff`/`log`/`file`); Host-Fakten auf `agent_done` |
| Tools heute | Orch: 8 Tools in `ORCHESTRATOR_TOOL_NAMES`; Sub: `report_done` / `ask_orchestrator` / `report_progress` |
| Identität | binär: `?ws=&token=<orch>` vs `?ws=&agent=&token=<sub>` |
| Remote v1 | 4 Gateway-Verben; MCP bleibt loopback; Tippen in PTY löst **kein** `ask_orchestrator` |

Code-Anker:

- `src/main/mcp/server.ts` — HTTP, Identität, Sessions
- `src/main/mcp/toolsOrchestrator.ts` / `toolsSubagent.ts`
- `src/main/mcp/pendingQuestions.ts` / `eventQueue.ts` / `types.ts` / `attach.ts`
- `src/shared/schema/events.ts`
- `src/shared/prompts/orchestrator.ts` / `contract.ts` / `roles.ts`
- Workspace/Host: AgentHost-Implementierung (WorkspaceManager / Workspace)
- Remote: Gateway Allow-List, `protocol.ts`

---

## Harte Non-Goals (niemals)

- Peer-to-Peer zwischen Subagents **oder** Leads
- Vorstartetes Team / Playbooks die Fenster spawnen
- Orchestrator der selbst committen/mergen/testen/pushen soll
- Autodelete von Worktrees/Branches
- Hardcodierte Modellkataloge, RAG
- Zweite Orchestrierung als Produkt (Kanban, DAG, Cloud-Runner, Workspace-pro-Area)
- Automatisches Nesting / Nesting-Profil-Toggle — Root entscheidet per Tool, Default flach
- Tiefe > 1 (Lead startet Lead). Worker dürfen eine Helper-Ebene spawnen; Helper dürfen nicht
- Enkel-Events in der Root-`await_events`-Queue (Helper-Events landen in der Worker-Nest-Queue)
- Ein zweiter MCP-Server zum Steuern des Browsers (die Erweiterung paired auf `/browser` des bestehenden Listeners)
- `read_output` als Verifikation (nur Debug / unconfirmed exit)
- Remote als zweiten MCP-Server oder Spiegel aller APP_CHANNELS
- Tunnel/TLS/Account/Internet-Exposure als Teil dieses Tracks
- `git status` auf jedem `list_agents` / `await_events` (Feed nicht verteuern)
- Synthetisches Event `events_dropped` (Gap bleibt Feld am Tool-Result)

---

## Reihenfolge der Tracks

```
Track 0  H1 + H2     Remote/Panel-Kanten für Mensch im Loop
Track 1  C3 + C4     Snapshot-Commit + Handoff-Paket an start_agent
Track 2  C5          Orchestrator-Idle-Watchdog
Track 3  D           Goal-UI, user_message, ask_user  (braucht 0)
Track 4  Slot/Provider-Wahl an start_agent           (klein, jederzeit nach 0)
Track 5  F           Multi-Orch Lead (braucht 1; braucht Remote nicht)
Track 6  E           integrate/gate, Briefing, Resume, Budget, Eval, Extra-MCP
Track 7  H           Nested Worker, Live-user_message-Targeting, First-Party /browser
```

Unten: **ein Prompt-Block pro Track**. Bei Auftrag „alles“: Track 0→7
sequentiell, je eigener PR. Bei Auftrag „nur MCP-Tools“: Tracks 1–5
plus D3/D2-Teile die Event/Tool betreffen; H1/H2 trotzdem zuerst wenn
Remote/Panel betroffen.

---

## TRACK 0 — H1 `answer_question` + H2 `workspaces:start {goal}`

### Ziel

Mensch (Panel + Remote) kann MCP-Fragen beantworten und einen Workspace
mit Goal starten — ohne zweiten Orchestrator-Hirn.

### H1 — `answer_question`

Problem: `ask_orchestrator` parkt in `PendingQuestions`. Antwort nur über
Orchestrator-Tool `send_to_agent{questionId}`. Tippen in Subagent-TUI
löst Waiter nicht. Tippen in Orchestrator-TUI während `await_events`
hängt → zweiter Turn.

Implementiere **einen** Host-Pfad (gleicher wie MCP-Tool):

```
answer_question { workspaceId, agentId, questionId, text }
```

- Gateway Allow-List um genau diesen Befehl erweitern
- Panel: Badge → Textfeld nutzt denselben Pfad
- Sentinel-ASK: weiter `deliverAnswer` in PTY, aber Registry bleibt
  eine Wahrheit
- Keine neue Orchestrierung, keine zweite Question-Map

### H2 — Goal at start

```
workspaces:start { profileId, goal?: string }
```

- Host seedet Goal wie Assignment-Handshake
- Ohne Goal: Start erlaubt (Back-compat), UI zeigt „kein Ziel — Orchestrator wartet“
- Panel + Remote teilen das Feld; Desktop nicht nur TUI-Tippen

### Done wenn

- Tests: Registry-Antwort vom Gateway weckt `ask_orchestrator`
- Remote-Client / Panel können Frage schließen
- Start mit Goal erscheint in Orchestrator-Seed; ohne Goal kein Crash
- README Remote-Abschnitt aktualisieren (was Handy jetzt kann)

### Prompt (kurz)

> Implementiere H1 `answer_question` und H2 `workspaces:start{goal}` laut
> `docs/HANDBOOK-HARNESS.md`. Ein Host-Pfad mit MCP `send_to_agent{questionId}`;
> Gateway Allow-List +1; Panel-Badge; Goal-Seed. Keine neuen MCP-Tools in
> diesem Track außer Integrationstests gegen bestehende Tools.

---

## TRACK 1 — C3 Snapshot-Commit + C4 Handoff-Paket

### C3 Snapshot-Commit (Default an)

Bei `agent_done` / Host-Done-Pfad: wenn Worktree dirty → Commit auf
Agent-Branch:

```
vertragus: <agent> / <role> — <erste Zeile der Summary>
```

- Kein Push, kein `--force`
- Worker-Prompt (`roles.ts` / Contract): „committe nicht selbst — Host snapshotet“
- Fehler beim Commit dürfen `agent_done` nicht schlucken (wie heute bei
  Snapshot-Facts)

### C4 Handoff an `start_agent`

Wenn `baseBranch` gesetzt: Host hängt letztes relevantes `agent_done`
(Summary, Files, SHA, Branch) an den Task-Text bevor Contract appended
wird. Reviewer rekonstruiert Diff nicht aus Prosa. Star-Topologie bleibt.

### Done wenn

- Unit/Integration: dirty → Commit; clean → kein Leercommit
- `start_agent{baseBranch}` enthält Handoff-Block im Seed
- `inspect_agent` + Host-Fakten unverändert korrekt
- Prompt-Texte angepasst

### Prompt (kurz)

> Implementiere C3 Snapshot-Commit und C4 Handoff-Paket. Host-Wahrheit
> für Git; MCP `start_agent` / `report_done` nur verdrahten. Kein Merge,
> kein Push, kein Feed-`git status`.

---

## TRACK 2 — C5 Orchestrator-Idle-Watchdog

### Ziel

Prozess lebt, ruft aber `await_events` / Orchestrator-Tools nicht mehr.
≠ `orchestrator_exited` (Prozess-Tod).

### Design

- Watchdog auf letzten Orchestrator-MCP-Tool-Call
- Event `orchestrator_idle` + Panel/Remote-Karte
- Optional Reminder-Zeile in TUI, einmal pro Stillephase
- Weckt den Orchestrator **nicht** (er pollt ja nicht)

### Done wenn

- Event-Schema erweitert + Tests
- Panel zeigt Idle; Remote liest Summary
- Keine False-Positives während normalem `await_events`-Long-Poll
  (Timeouts ≠ Idle)

### Prompt (kurz)

> Implementiere C5 `orchestrator_idle` Watchdog. Distinkt von
> `orchestrator_exited`. Idle = keine Orchestrator-Tool-Calls mehr,
> nicht „await_events hat leeres Result“.

---

## TRACK 3 — Phase D Mensch im Loop

Voraussetzung: Track 0 (H1/H2).

### D1 Goal-at-Play

Sobald `start({goal})` existiert: Panel-Pflichtfeld (oder klare Warnung),
`VERTRAGUS_DEV_RUN` aus Env/stdin.

### D2 `user_message` weckt `await_events`

Composer auf Workspace-Karte (Desktop + Remote, nicht nur raw xterm):

1. Text in Orchestrator-TUI (sichtbar)
2. Push `user_message` in EventQueue → parkendes `await_events` kehrt sofort zurück

Remote: neuer Message-Typ in `protocol.ts` (zod-Union), z. B. `steer` /
`user_message`. Nicht in B1 vorbauen außer Gateway nicht zuschweißen.

### D3 `ask_user` + Badge-Antwort

Neues **Orchestrator-MCP-Tool**, blockierend, Ticket wie
`ask_orchestrator`:

- Event `user_question` auf Workspace-Karte
- Prompt-Zeile „answer with the best-supported option“ entfernen/ersetzen
- Subagent-Fragen: Host-Pfad = H1
- User-Fragen: eigener Waiter; **ein** Textfeld, zwei Backends
- `ORCHESTRATOR_TOOL_NAMES` + Allowlists (`attach.ts`) + Prompt
  `orchestrator.ts` aktualisieren

### D4 Yolo als Policy (später im Track oder Follow-up)

Stufen `yolo` / `ask-user` / `ask-orchestrator`. Remote-v1 nicht
CLI-Permission-TUIs „schön“ machen. Threat-Model in README halten.

### Done wenn

- Composer weckt `await_events` (Test mit Fake-Host + EventQueue)
- `ask_user` Roundtrip inkl. Ticket-Resume
- Panel + Remote Badge für User- und Agent-Fragen
- Prompt nennt `ask_user` / `user_message`

### Prompt (kurz)

> Phase D: D1 Goal-UI, D2 `user_message` Event + Composer, D3 MCP-Tool
> `ask_user` mit Ticket. H1/H2 vorausgesetzt. Ein Textfeld, zwei
> Backends. Kein Peer-to-Peer, kein zweiter Orchestrator.

---

## TRACK 4 — Provider-/Slot-Wahl an `start_agent`

### Problem

`slotWithCapacity` nimmt ersten Slot der Rolle mit Platz. Orchestrator
kann `model` überschreiben, nicht Provider → Diversität oft tot.

### Design (eines wählen, Profil-Regel bevorzugen wenn einfacher)

- `start_agent{role, slotId? | providerId?}` **oder**
- Profil-Regel: eine Rolle = ein Slot

Host erzwingt Cap weiterhin sync über Reservierung.

### Done wenn

- Explizite Provider-/Slot-Wahl möglich ohne Cap-Regression
- Unbekannte slotId/providerId → klares `toolError`
- Prompt dokumentiert Parameter

### Prompt (kurz)

> Erweitere `start_agent` um optionale Slot-/Provider-Wahl ohne TOCTOU
> und ohne Cap-Bugs. Kein neues Nesting.

---

## TRACK 5 — Phase F Multi-Orchestrierung (Lead)

Voraussetzung: Track 1 (C3/C4). Braucht Remote **nicht**.

### Dritte MCP-Identität

Heute binär. Neu:

```
/mcp?ws=&token=<orch>                 → Root-Tools (+ start_orchestrator)
/mcp?ws=&agent=<id>&token=<sub>       → Blatt-Tools
/mcp?ws=&lead=<id>&token=<per-agent>  → Lead-Tools (Union)
```

### Lead-Tools

| Richtung | Tools |
| --- | --- |
| Nach unten (Unterbaum) | `start_agent`, `send_to_agent`, `await_events`, `list_agents`, `stop_agent`, `read_output`, `inspect_agent` |
| Nach oben | `report_done`, `ask_orchestrator`, `report_progress` |
| Verboten | `record_retro`, `start_orchestrator` |

### Root zusätzlich

```
start_orchestrator{area, task, maxSubagents?, model?, baseBranch?}
```

- `area` Label für Prompt/Panel
- `maxSubagents` = Teilbudget, nicht zweites Profil-Limit
- `profile.maxSubagents` global über Root-Kinder + Enkel
- `start_agent` bleibt auf Root (flach + hybrid)

### Fan-in

- Jeder Lead: eigene `EventQueue`
- Root `await_events` sieht **nur Direktkinder**
- Enkel-Events nur in Lead-Queue
- Retro-Tap abonniert **alle** Queues
- `PendingQuestions` eine Registry; `agent_question` in Parent-Queue
- Fragen steigen eine Stufe, nie zwei; kein Skip-Level; keine Peer-Fragen

### Lead-Tod

- Root bekommt `agent_exited` für Lead
- Reparent: Enkel → Direktkinder Root; Queue-Merge `subtree_adopted`
- Nicht: Enkel stoppen; nicht: orphaned `ask_orchestrator`

### Caps (Host, nicht Prompt)

- Tiefe genau 1
- Max Leads z. B. 4
- Globales `maxSubagents` inkl. Leads/Enkel
- Async start + Per-Agent-Token wie heute
- Per-Rolle-Limits v1 global

### Panel / Remote

- `parentId` + `kind: 'orchestrator' | 'lead' | <role>`
- Einrückung, kein Baum-Widget
- `answer_question` adressiert Parent aus `agentId`
- `start_orchestrator` **kein** Remote-API

### Prompt (kurz)

> Implementiere Phase F Multi-Orch laut Handbuch: dritte Identität
> `lead=`, eigene Queues, `start_orchestrator`, Fan-in nur Direktkinder,
> Reparent bei Lead-Tod. Default flach. Kein Auto-Nesting, Tiefe > 1,
> Enkel in Root-Queue, Peer-to-Peer verboten. Braucht C3/C4.

---

## TRACK 6 — Phase E Integration, Gedächtnis, Eval

Voraussetzung: Track 1 (C). D/F optional parallel wo unabhängig.

### E1 `integrate_branch` / Verify-Gate / Promote

- Host-Merge im Ziel-Worktree
- Events `integrate_ok` | `integrate_conflict`
- Gate: Worker-Snapshot + Reviewer ohne Blocker + Tester `success`
- Promote nach `<base>` = **User-Klick** (nicht Remote-v1 Handy)

### E2 Briefing + Repo-Notes

- Gecappter Block `AGENTS.md`/`CLAUDE.md`/`README`/`git log -8` in
  Orchestrator-Prompt
- `record_retro.repoNotes[]` analog Model-Learnings, löschbar im Retro-Panel
- Kein RAG

### E3 Journal / Resume

- `.vertragus/runs/<id>/events.jsonl` über Gap hinaus
- Re-Spawn in alten Worktrees
- Offene Tickets nach Crash = tot, ehrlich sagen

### E4 Budget

- Summe Agent-Sekunden + `maxRuntimeMin`
- Events `budget_warning`; keine neuen Starts über Limit
- Keine geratenen Token-Zähler

### E5 Loop-Eval

- Mini-Repo mit Bug; Assert Worker + `inspect` + Tester success +
  Orchestrator-Worktree ohne eigenen Diff
- Handover-Live-Test behalten

### E6 Playbooks, Extra-MCP, Rollen-Templates

- Playbook = Goal-Template, **kein** vorstartetes Team
- Extra-MCP nur an Worker (`attach.ts` Dialekte)
- Templates Janitor/Explorer; Drittanbieter-Browser-MCP weiter über Extra-MCP (First-Party-Erweiterung ist Track 7)

### Prompt (kurz)

> Phase E laut Handbuch: integrate/gate/promote (User-Klick), Briefing,
> Journal/Resume, Budget-Wanduhr, Loop-Eval, Playbooks + Extra-MCP an
> Worker. Kein RAG, kein Autodelete, Orchestrator merged nicht selbst
> außer Host-Tool `integrate_branch`.

---

## TRACK 7 — Phase H Nested Worker, Live-Steering, Chromium-Erweiterung

**Status: umgesetzt.** Nicht neu bauen. Handbuch Phase H;
[`CHROMIUM-EXTENSION.md`](./CHROMIUM-EXTENSION.md).

### Ziel

Worker dürfen eine Scheibe auslagern, der Mensch kann nach der
Delegation weiter mit dem Orchestrator sprechen, und ein Worker kann
eine laufende Web-App im echten Chromium des Nutzers testen — ohne
zweites Produkt, ohne Lead-startet-Lead, ohne Enkel-Events in der
Root-Queue.

### Nested Worker (Helpers)

- `canSpawnHelpers`: kein Parent oder Parent ist Lead → ja; Parent ist
  schon ein Worker-Nest → nein
- `runtime.nests` (gleiche Form wie Leads, `area: helpers`); zählt nicht
  gegen `MAX_LEADS`; `MAX_HELPERS_PER_WORKER = 3`
- Worker-Down-Tools: `WORKER_DOWN_TOOL_NAMES` (kein `task_*`, kein
  `start_orchestrator`); `helpers: true` am MCP-Contract
- Fan-in via `queueForAgent`; `adoptSubtree` eine Stufe nach oben

### Live-Steering

- Composer `targetAgentId`; weiter `user_message` auf der **Root**-Queue
- `resolveUserMessageTarget` setzt `relayVia*` für Nicht-Direktkinder
- Nicht in die Orchestrator-TUI tippen

### First-Party Chromium-Erweiterung

- Derselbe HTTP-Listener, `/browser`, Loopback-Token
- `chrome-extension:`-Origin nur auf diesem Pfad
- Worker-Tools `browser_*`; getrennt → `browser_disconnected`
- Unpacked MV3 `extensions/chromium/`

### Done wenn

- Helper-Events erreichen nie das Root-`await_events`
- Ein Follow-up vom Composer kann an einen Helper relaised werden
- Ein Worker kann einen echten Tab snapshoten/klicken, wenn die
  Erweiterung gepaired ist
- `pnpm run ci` grün; MCP-Version `1.1.0`

### Prompt (kurz)

> Phase H laut Handbuch: eine Helper-Ebene unter einem Worker,
> Composer-Targeting mit Relay, First-Party `/browser`-Erweiterung. Kein
> zweiter MCP, kein Lead-startet-Lead, keine Enkel-Events in der
> Root-Queue.

---

## Querschnitt — bei jedem Track prüfen

1. **Events:** Schema in `events.ts`; ein Owner pro Event-Typ (siehe
   Kommentar in `types.ts`); keine Duplikate MCP vs Host/Sentinel.
2. **Tools:** `ORCHESTRATOR_TOOL_NAMES` / `SUBAGENT_TOOL_NAMES` und
   Provider-Allowlists in `attach.ts` synchron; Prompt `orchestrator.ts`
   + Contract nennen neue Tools.
3. **Timeouts:** Long-Polls unter 60s MCP-Timeout (`await_events` ~50s,
   `ask_*` ~50s, Ticket-Resume).
4. **Sicherheit:** Loopback MCP; Tokens nicht committen; Remote Allow-List
   minimal; Yolo-Threat-Model ehrlich.
5. **Tests:** Unit für Queue/Questions/Tools; Integration wo Spawn;
   `pnpm run ci` grün.
6. **Docs:** Handbuch-Statuszeile / README nur wenn Nutzer-Verhalten ändert.

---

## Master-Prompt (alles in einem Auftrag)

Wenn du **alle** Themen in einem Agent-Lauf anstoßen willst, paste dies:

```
Du bist Coding-Agent in Vertragus. Lies zuerst:
- docs/HANDBOOK-HARNESS.md
- docs/PROMPT-MCP-HARNESS.md  (dieses Dokument)
- src/main/mcp/* , src/shared/schema/events.ts , src/shared/prompts/*

Ziel: alle offenen Harness/MCP-Tracks umsetzen — aber in getrennten
PRs/Commits in der Reihenfolge Track 0 → 6. Non-Goals strikt einhalten.
Nichts aus „Was PR #17 gelandet hat“ neu bauen.

Pro Track:
1. Branch anlegen
2. Minimalen Diff laut Track-Abschnitt
3. Tests + ci
4. Kurzen PR-Body mit Track-ID und Done-Kriterien
5. Erst dann nächster Track

Beginne mit Track 0 (H1 answer_question + H2 start{goal}).
Wenn ein Track blockiert ist, stoppe und berichte Blocker — nicht
heimlich Track 5 vor Track 1 bauen.
```

---

## Einzel-Prompts (Copy-Paste)

### Nur Track 0

```
Implementiere Track 0 aus docs/PROMPT-MCP-HARNESS.md: H1 answer_question
(Gateway + Panel, gleicher Pfad wie send_to_agent{questionId}) und H2
workspaces:start{goal}. Tests, README Remote-Abschnitt. Keine neuen
Orchestrierungs-Tools.
```

### Nur Track 1

```
Implementiere Track 1 (C3 Snapshot-Commit + C4 Handoff) aus
docs/PROMPT-MCP-HARNESS.md. Host-Git-Wahrheit; agent_done darf bei
Commit-Fehlern nicht sterben; start_agent{baseBranch} bekommt Handoff.
Worker-Prompt: nicht selbst committen.
```

### Nur Track 2

```
Implementiere Track 2 C5 orchestrator_idle aus docs/PROMPT-MCP-HARNESS.md.
Distinkt von orchestrator_exited. Keine False-Positives während
await_events-Long-Poll.
```

### Nur Track 3

```
Implementiere Phase D (Track 3) aus docs/PROMPT-MCP-HARNESS.md.
Voraussetzung H1/H2. D2 user_message weckt await_events; D3 ask_user
MCP-Tool mit Ticket; ein Textfeld zwei Backends; Allowlists + Prompt.
```

### Nur Track 4

```
Implementiere Track 4 start_agent Slot-/Provider-Wahl aus
docs/PROMPT-MCP-HARNESS.md. Caps sync/race-free lassen.
```

### Nur Track 5

```
Implementiere Phase F Multi-Orch (Track 5) aus docs/PROMPT-MCP-HARNESS.md
und HANDBOOK-HARNESS.md. Dritte Identität lead=; eigene Queues; Fan-in;
Reparent; Caps Host-seitig. Default flach. Braucht C3/C4.
```

### Nur Track 6

```
Implementiere Phase E (Track 6) aus docs/PROMPT-MCP-HARNESS.md:
integrate_branch/gate/promote, Briefing/repoNotes, Journal/Resume,
Budget, Loop-Eval, Playbooks + Extra-MCP nur Worker. Non-Goals beachten.
```

### Nur Track 7

```
Implementiere Phase H (Track 7) aus docs/PROMPT-MCP-HARNESS.md und
HANDBOOK-HARNESS.md: eine Helper-Ebene unter einem Worker,
Composer-Targeting mit Relay, First-Party /browser Chromium-Erweiterung.
Kein zweiter MCP, kein Lead-startet-Lead, keine Enkel-Events in der
Root-Queue.
```

---

## Akzeptanz gesamt (Ende Track 7)

- Mensch kann vom Panel/Remote Goals setzen, steuern (`user_message`, optional gezielt),
  Agent- und User-Fragen beantworten
- Host kennt Git (inspect, Done-Fakten, Snapshot-Commit, Handoff)
- Idle und Exit sind unterscheidbar
- Root kann optional Leads nesten ohne Event-Sturm
- Worker dürfen eine Helper-Ebene spawnen; Helper-Events bleiben aus der Root-Queue
- Eine gepairte Chromium-Erweiterung lässt einen Worker eine Live-Web-App testen
- Integrate/Gate/Promote und Resume existieren ohne Autodelete/RAG
- `pnpm run ci` grün; Handbuch-Status aktualisiert
