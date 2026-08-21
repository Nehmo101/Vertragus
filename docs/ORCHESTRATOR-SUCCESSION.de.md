Deutsch | [English](ORCHESTRATOR-SUCCESSION.md)

# Orchestrator-Context-Handoff (Succession)

Plan für den Austausch des **Root**-Orchestrators mitten im Lauf, wenn sein
LLM-Kontext erschöpft ist — frisches Hirn, gleiches Team, gleicher Workspace.

**Status:** Der vertikale S1-Schnitt ist in der Runtime (`request_succession`,
Token-Rotation, host-angereichertes Paket, Successor-Seed). User-Button,
C5-Idle-Notausgang, C3-SHA-Abgleich und Crash-Recovery von Disk kommen später.

**Nicht dieses Feature:**

| Verwechselbar | Was es wirklich ist |
| --- | --- |
| C4 Handoff-Paket | Worker → nächster Worker via `start_agent{baseBranch}` |
| Phase F Multi-Orch | Nebenläufiger, genesteter **Lead** unter dem Root |
| Live-`handover`-Tests | Seed-Zustellung in eine CLI-PTY |
| E3 Resume | Host-Recovery nach Crash / Workspace-Neustart |
| README „without a second orchestrator“ | Weist Nesting-als-Produkt und Mensch-außerhalb-des-Loops zurück — **nicht** serielle Succession |

**Ein-Satz-Urteil:** Succession = serieller Ersatz von
`Workspace.orchestratorRecord` im selben Workspace, gleiche `EventQueue` /
`PendingQuestions` / Subagenten, mit host-angereichertem Handoff-Paket und
gefenctem Vorgänger — kein Lead, kein C4, kein `stopWorkspace`.

---

## 1. Problem

Der Orchestrator ist der einzige langlebige LLM, der den Lauf akkumuliert:

- Er allein loopt per `await_events` über die Workspace-`EventQueue` (Ring 1000).
- Er allein beantwortet `ask_orchestrator` via `PendingQuestions`.
- Subagenten haben schon isolierte Kontexte; sie brauchen Succession selten.

Heute gibt es genau einen Orchestrator pro Workspace
(`Workspace.startOrchestrator` wirft, wenn einer existiert). Stirbt er, graut
`orchestrator_exited` die Karte aus; Subagenten laufen weiter; **niemand
treibt den Loop**. Es gibt keinen bewussten Pfad „frischer Kontext, gleiches
Team“.

Lange Läufe treffen damit einen Fehlermodus, den das Handbuch noch nicht
benannt hatte: **Kontext-Sättigung des Roots**.

---

## 2. Design-Entscheidungen (Defaults)

| Entscheidung | Default | Warum |
| --- | --- | --- |
| Trigger | Orch-Tool **primär**; User-Button als **Notausgang**; **kein** Host-Auto-Detect | Der Host sieht keine Provider-Token-Zähler (E4 lehnt geratene Zähler schon ab) |
| Tool-Name | `request_succession` | Self-Declare ≠ Lauf-Ende (`record_retro`) |
| Identität | Neue Orch-`agentId` + neuer Guide-Name + **neues Orch-Worktree** | Prozess-/Fenster-Identität; der NameAllocator trennt Guides bereits |
| `orchToken` | **Rotation beim Cutover** | Dieselbe URL für zwei CLIs = zwei Hirne auf einer Queue — das kritische Race |
| `subToken` / Worker-MCP-URLs | **Unverändert** | Nicht jede Worker-Attach-Config neu schreiben müssen |
| EventQueue | **Dieselbe Instanz**; Paket trägt `eventCursor` | Nicht schließen/neu erzeugen (unregister besitzt weiter die Lifetime) |
| PendingQuestions | **Dieselbe Registry**; bei Succession nie leeren | Verwaiste MCP-Waiter sind schlimmer als Verzögerung |
| Cutover-Reihenfolge | Alten Token invalidieren → Successor spawnen/seeden → alte PTY killen | Ein Zombie-Vorgänger kann nach der Invalidierung nichts mehr mutieren |
| Überlappung | Höchstens ein **gültiger** Orch-Token; nur ein kurzes Spawn-Fenster | Alte Tool-Calls mit `succession_in_progress` fencen |
| `record_retro` | Während Succession / von Nicht-Aktiven verboten | Handoff ≠ Lauf-Ende; der Host erzwingt die Generation |
| C5 Idle | Orthogonal | Erkennt Stille; erfindet kein Paket und spawnt nicht auto |
| Phase F | Nur der **Root** darf succeeden; Leads `report_done` | Succession ≠ Nesting |

---

## 3. Host-Oberfläche

### 3.1 Tool (neuntes Orchestrator-Tool)

```
request_succession{
  reason: "context_full" | "long_run" | "user_requested" | "other",
  goal?: { original?: string, current?: string },
  decisions?: string[],
  risks?: string[],
  nextActions?: string[],
  agentNotes?: { agentId: string, note: string }[],
  note?: string
}
```

Der Host validiert, **reichert an** mit Roster / offenen Fragen / Cursor /
Git-Fakten, betritt die Succession-State-Machine, antwortet schnell
`{ state: "succession_started", … }` (async wie `start_agent` — den vollen
Spawn nicht am 60s-MCP-Timeout blocken).

### 3.2 Events (`AGENT_EVENT_TYPES` erweitern)

| Event | Bedeutung |
| --- | --- |
| `orchestrator_handoff_started` | Cutover begonnen; Paket eingefroren |
| `orchestrator_started` | Successor hat den Seed angenommen (spiegelt `agent_started`) |
| `orchestrator_handoff_failed` | Spawn/Seed fehlgeschlagen; Recovery-Policy unten |
| `orchestrator_exited` | Nur **ungeplanter** Tod — Succession darf nicht wie ein Crash aussehen |

### 3.3 Optional später

- Panel / Remote: `workspaces:succeed_orchestrator` mit host-gebautem
  Minimalpaket (Roster + offene Fragen + Goal-Stub), wenn der Orch nicht
  selbst deklarieren kann.
- Die C5-Idle-Karte bietet diesen Button an — C5 selbst spawnt nie einen
  Successor.

---

## 4. State-Machine

```
RUNNING
  │ request_succession
  ▼
PREPARING          — Paket entwerfen; nebenläufige Succession ablehnen
  │ atomic write
  ▼
PACKAGE_READY      — dauerhaft auf Disk; nach Crash recoverbar
  │
  ▼
SUCCESSOR_STARTING — orchToken rotieren; Successor spawnen + seeden
  │
  ▼
CUTOVER            — Successor als orchestratorRecord binden; alte PTY killen
  │
  ▼
ACTIVE             — Successor await_events{cursor: package.eventCursor}
```

**Persist:** `.vertragus/runs/<workspaceId>/succession.json` (atomic rename).

**Fehler mitten im Handoff:**

- Vor `PACKAGE_READY`: Abbruch → Karte grau / Vorgänger entfenct, falls er lebt.
- Nach `PACKAGE_READY`: `recoverSuccession()` kann aus dem Paket spawnen.
- Nie zwei PTYs zurücklassen, die beide glauben, den Loop zu besitzen.

**Invarianten-Tabelle**

| Objekt | Während der Succession |
| --- | --- |
| `workspaceId` | unverändert |
| `EventQueue` | dieselbe Instanz |
| `PendingQuestions` | dieselbe Registry |
| Subagent-PTYs / -Worktrees | laufen weiter |
| `orchToken` | beim Cutover rotiert |
| MCP-Identitäts-Kind | weiterhin `orchestrator` (kein Lead) |

---

## 5. Handoff-Paket-Schema

**Transport:** JSON auf Disk; Seed/System-Prompt des Successors rendert das
Paket einmal als gecappte Prosa (kein zusätzlicher JSON-Dump — derselbe
Inhalt zweimal würde den teuersten Prompt des Systems verdoppeln). Dünnes
Pointer-Event auf der Queue.

```jsonc
{
  "schemaVersion": 1,
  "kind": "orchestrator_succession",
  "workspaceId": "...",
  "workspaceName": "...",
  "profileId": "...",
  "createdAt": 0,
  "reason": "context_full",
  "predecessor": { "agentId": "...", "name": "...", "providerId": "...", "model": "..." },
  "goal": { "original": "...", "current": "..." },
  "eventCursor": 0,
  "recentEvents": [],
  "agents": [],
  "openQuestions": [],
  "decisions": [],
  "risks": [],
  "nextActions": [],
  "branchesOfInterest": [],
  "orchWorktree": { "dirty": false, "changedFiles": [] },
  "limits": { "maxChars": 48000, "truncated": [] }
}
```

### Ownership & Caps

| Feld | Quelle | Cap |
| --- | --- | --- |
| `goal.*` | Orch; der Host fällt auf das zugestellte Goal zurück (`assignGoal`), wenn ausgelassen | 2× 2k Zeichen |
| `eventCursor` | **Host** (`events.cursor` beim Einfrieren) | int |
| `recentEvents` | **Host** | ≤40 oder ≤24k; done/question/exited/start_failed bevorzugen |
| `agents[]` | **Host**-Roster + C2-Fakten | volles Roster; Summary ≤500; Files ≤20 |
| `agents[].orchNote` | Orch optional | 300 |
| `openQuestions[]` | **Host** aus `PendingQuestions` | **nie kürzen** |
| `decisions` / `risks` / `nextActions` | Orch | ≤15/10/10 × 300 |
| `orchWorktree` | **Host**-Inspect | nur Warnung — nicht blocken |
| Gesamt | Host | **~48–64k**; zuerst Orch-Prosa kürzen, dann `recentEvents` |

### Must not

- Volles Transkript / jedes `agent_progress`
- Datei-Diffs (dafür `inspect_agent`)
- Offene Fragen schließen
- `record_retro` rufen
- Behaupten, der Lauf sei fertig

---

## 6. Prompt-Änderungen

**Amtsinhaber** (`buildOrchestratorSystemPrompt`):

- Rufe `request_succession`, wenn der Kontext fast voll ist, der Provider
  warnt, oder du den Überblick über Agenten/Entscheidungen verlierst.
- Rufe es **nicht**, wenn das Ziel erreicht ist — das ist `record_retro`.
- Nicht coden; kein Retro beim Handoff; Felder ehrlich füllen; Unbekanntes
  weglassen.
- Nach dem Aufruf: aufhören; weitere Tools können fehlschlagen
  (`succeeded` / `succession_in_progress`).

**Successor** (Seed = System-Prompt + Paket-Block):

- Du bist eine **Fortsetzung**, kein neuer Lauf.
- Zuerst: Paket lesen → `list_agents` → offene Fragen abräumen →
  `await_events` ab **package.eventCursor**.
- Host-Fakten vor Prosa vertrauen; mit `inspect_agent` verifizieren.
- `record_retro` nur bei echter Zielerreichung.

---

## 7. Code-Touch-Liste (bei der Umsetzung)

| Datei | Änderung |
| --- | --- |
| `src/shared/schema/handoff.ts` | **Neu** — zod-Paket |
| `src/shared/schema/events.ts` | handoff- / started- / failed-Events |
| `src/shared/prompts/orchestrator.ts` | Succession-Regeln |
| `src/shared/prompts/orchestratorHandoff.ts` | **Neu** — Paket in den Seed formatieren |
| `src/main/mcp/toolsOrchestrator.ts` | `request_succession`; Tool-Namensliste erweitern |
| `src/main/mcp/types.ts` | Host-Succeed-API |
| `src/main/mcp/server.ts` | Token-Rotation; Session-Kill für alten Orch; Instructions |
| `src/main/workspace/Workspace.ts` | `replaceOrchestrator` / Succession-SM; Single-Orch-Throw lockern |
| `src/main/workspace/WorkspaceManager.ts` | notifyChange; nie über `stopWorkspace` routen |
| Panel / IPC / Remote (später) | Badge, Auto-Fokus, User-Button |
| Tests | siehe §9 |

**Darf nicht** über `unregisterWorkspace` / `stopWorkspace` laufen — das
schließt die EventQueue und killt das Team.

---

## 8. Fehlermodi (Zusammenfassung)

| Modus | Gegenmaßnahme |
| --- | --- |
| Crash mitten im Handoff | Dauerhaftes `PACKAGE_READY`; Spawn recovern |
| Fragen während des Cutovers | In die Registry aufnehmen; Successor räumt zuerst ab |
| Alter Orch toolt weiter | Token-Rotation + Generation-Gate + Kill |
| Doppeltes Retro | Host lehnt Nicht-Aktive / In-Progress ab |
| Cursor verloren / Ring-Gap | Paket-Cursor + dieselbe Queue + `eventsDropped`-Abgleich |
| Dirty Orch-Worktree | Nur Host-Warnung; kein Auto-Commit |
| Remote auf alter PTY | Neue agentId/neues Fenster; Clients rebinden über die Summary |
| Zwei gültige Orch-URLs | Verboten — immer ein gültiger Token |

---

## 9. Sequenzierung

```
Done (#17): C1, C2, EventQueue-Gaps, async start, Tokens
     │
PR-S0  Spec (dieses Doc) + Handbuch-Pointer
     │
PR-S1  Vertikaler Schnitt: Tool → Paket → Token-Rotation → Successor
       await_events am Cursor → eine geplantete Frage beantworten
     │
PR-S2  Härten + C3-Abgleich (committete Worker-Wahrheit im Paket),
       Crash-Recovery, Retro-Gate, Panel-Badge
     │
PR-S3  User „Orchestrator ersetzen“ + optional C5-Notausgang
     │
PR-S4  Live-Probe (E5-Familie)
```

**Gates:**

- Merge blocken, bis C1/C2 grün bleiben (schon gelandet).
- C3 vor/mit PR-S2 landen — ohne Snapshots lügen die Paket-SHAs.
- C4 (Worker-Pakete) ist ein **Geschwister**-Track, kein Blocker.
- C5 / H1 / H2 / F gaten S1 nicht.
- E3-Journal stärkt Resume später; S1 wartet nicht darauf.

### Testplan

**Unit:** State-Machine; Tool-Ablehnung alter Generation; Token 401; zod +
Caps; Cursor-Bootstrap; Retro-Ablehnung; offene Fragen immer host-gelistet.

**Integration:** Fake-Amtsinhaber → Succession → Successor-Seed enthält das
Paket; Frage während `PREPARING` erst nach `ACTIVE` beantwortet; Crash nach
`PACKAGE_READY` recovert genau einmal; nebenläufiger Zweitaufruf →
`already_in_progress`.

**Live:** Echter Provider + Worker; Handoff erzwingen; Worker bleiben oben;
alte MCP-URL schlägt fehl; ein lebender Orch auf Panel/Remote.

Das bestehende `tests/live/handover.live.test.ts` ist **keine**
Succession-Abdeckung.

---

## 10. Non-Goals

- Genesteter / nebenläufiger zweiter Root oder Lead-als-Successor
- Automatische Host-Succession aus geratener Token-Nutzung
- Kontext-Succession-Tools für Subagenten
- EventQueue zurücksetzen oder offene Fragen canceln, „um sauber zu übergeben“
- Succession als `record_retro` / Lauf-Ende behandeln
- Peer-to-Peer zwischen altem und neuem Orch
- Autodelete des Vorgänger-Worktrees
- Tiefe > 1 oder Auto-Nesting, „weil der Kontext voll war“

---

## 11. Bezug zum Harness-Handbuch

Verzeichnet als **C6 Orchestrator-Succession** unter Phase C (nach C5) in
[`HANDBOOK-HARNESS.md`](./HANDBOOK-HARNESS.md), mit expliziter Abgrenzung zu
C4 und F; die Missing-Hooks-Tabelle und das Track-Diagramm des Handbuchs
tragen es. Die Implementierung bleibt außerhalb von BigBoy A/B — das ist ein
Workspace/MCP-Cutover, keine zweite Produktoberfläche.
