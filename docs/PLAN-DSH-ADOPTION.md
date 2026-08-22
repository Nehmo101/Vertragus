> Historical document (German). Kept as the original planning record;
> see the Phase-G summary in [`HANDBOOK-HARNESS.md`](HANDBOOK-HARNESS.md).

# Umsetzungsplan: Fünf dsh-Muster für Vertragus

Stand: 21. August 2026. Basiert auf dem Deep Research in
[`RESEARCH-DEEPSEEK-HARNESS.md`](RESEARCH-DEEPSEEK-HARNESS.md) und einer
Durchsicht des heutigen Codes (`toolsOrchestrator.ts`, `toolsSubagent.ts`,
`events.ts`, `eventQueue.ts`, `journal.ts`, `resume.ts`, `handoff.ts`).

Die fünf Vorhaben, in Umsetzungsreihenfolge:

| # | Vorhaben | Größe | Hebel |
|---|---|---|---|
| S1 | Spill statt Truncation (`read_output`, `inspect_agent`) | S | Token |
| S2 | Quiet-Events (Echo-Events wecken nicht mehr) | S | Token/Turns |
| S3 | Strukturierte Reports (`resultSchema` auf `start_agent`) | M | Fan-in-Verlässlichkeit |
| S4 | Task-Board mit CAS-Revisionen | L | Succession, Leads, Resume |
| S5 | `search_runs` — Volltextsuche über Journale | S–M | Gedächtnis |

S1/S2 sind unabhängige Quick-Wins. S3 ist Voraussetzung dafür, dass S4
richtig trägt (Tasks + verlässliche Reports = maschinelles Fan-in). S4 ist
der strategische Brocken. S5 ist unabhängig und jederzeit parallelisierbar.

Durchgängige Doktrin (gilt für alle fünf): Host-Wahrheit vor Agenten-Wort,
fail-soft auf Disk-Fehler (wie `journal.ts`), fail-loud auf Contract-Fehler
(wie `start_agent{slotId}`), keine neuen Abhängigkeiten, jede neue
Tool-Registrierung landet in `ORCHESTRATOR_TOOL_NAMES` (Allowlist +
Invariant-Test leiten sich daraus ab).

---

## S1 — Spill statt Truncation

**Problem heute.** `read_output` liefert einen Tail (Default 60, max 400
Zeilen) — was oben rausfiel, ist weg oder kostet einen zweiten Call mit
mehr Zeilen, der voll in den Orchestrator-Kontext läuft. `inspect_agent
{view: "diff"}` kann bei großen Diffs beliebig groß werden und läuft
ungekappt in den Kontext.

**dsh-Muster.** Volle Ausgabe verbatim in eine private Datei, dem Modell
Head/Tail-Preview + Pfad + Retrieval-Hinweis („bei Bedarf `read`/`grep`
auf den Pfad"). Ein Save-Fehler degradiert zum bisherigen Inline-Verhalten,
nie zu einem Tool-Error.

### Umsetzung

**Neues Modul `src/main/workspace/spill.ts`** (Muster: `journal.ts`):

```ts
export interface SpillStore {
  /** Schreibt content verbatim; undefined bei jedem Fehler (fail-soft). */
  save(name: string, content: string): Promise<string | undefined> // → absoluter Pfad
}
export function createSpillStore(repoPath: string, workspaceId: string,
  deps?: { mkdir?; writeFile?; warn? }): SpillStore
```

- Ablage: `.vertragus/runs/<workspaceId>/spill/<seq>-<name>.txt` — im
  Repo-Pfad, damit jeder Orchestrator (Root wie Lead, eigenes Worktree)
  die Datei mit absoluten Pfaden lesen kann. `<seq>` ist ein lokaler
  Zähler des Stores, `<name>` wird auf `[a-z0-9-]` normalisiert.
- Fail-soft-Kette wie im Journal: erster Fehler warnt einmal, danach
  liefert `save` still `undefined`.
- Aufräumen: hängt am bestehenden Run-Verzeichnis — keine eigene
  Retention in v1 (bewusst, wie dsh; im Handbuch dokumentieren).

**Schwellen & Verdrahtung** (in `toolsOrchestrator.ts`):

```ts
export const SPILL_THRESHOLD_CHARS = 6_000   // ~1.5k Tokens
export const SPILL_HEAD_CHARS = 2_000
export const SPILL_TAIL_CHARS = 1_000
```

- `WorkspaceCtx` bekommt `spill?: SpillStore` (optional wie `retro` —
  fehlt der Store, bleibt alles beim heutigen Verhalten).
- Ein Helfer `withSpill(name, text): Promise<ToolText>`:
  Text ≤ Schwelle → unverändert. Sonst `spill.save(...)`;
  bei Erfolg Preview:

  ```
  [output too large: 41_312 chars — full text at
   /abs/pfad/.vertragus/runs/<ws>/spill/7-read-output-caronte.txt
   read or grep that file for the full output]
  <head 2000 chars>
  …
  <tail 1000 chars>
  ```

  bei `undefined` (Save-Fehler) der bisherige Tail + eine Zeile
  `note: full output unavailable (spill failed)` — nie ein Error.
- `read_output`: neuer optionaler Param `full: boolean`. Ohne `full`
  bleibt alles wie heute (Tail, gekappt). Mit `full: true` liest der Host
  den GANZEN Puffer (`ctx.host.readOutput(agentId, ∞)` — neue Host-Methode
  `readOutputFull(agentId)` in `Workspace.ts`, gleiche Quelle wie der
  Tail) und liefert ihn durch `withSpill`. Tool-Description ergänzen:
  „`full: true` writes the complete buffer to a file and returns preview +
  path."
- `inspect_agent`: der JSON-Result von Views `diff` und `file` läuft durch
  `withSpill` (Feldname `spillPath` im Result-JSON statt Fließtext, damit
  das bestehende `toolJson`-Format erhalten bleibt: `{ agentId, view,
  truncated: true, spillPath, head, tail }`). `status`/`log` sind klein
  und bleiben unangetastet.

### Tests
- `spill.test.ts`: Schreiben, Namensnormalisierung, fail-soft (mkdir- und
  write-Fehler), Seq-Monotonie.
- `toolsOrchestrator.test.ts`: unter Schwelle unverändert; über Schwelle
  Preview-Format + Pfad; Spill-Fehler → Tail + note; `inspect_agent`-Diff
  über Schwelle → `spillPath`-Feld.

### Risiken
- Orchestrator ignoriert den Hinweis und fragt erneut voll ab → die
  Description muss den Lesepfad klar machen; beobachten im Loop-Eval.
- Sensible Inhalte auf Disk: nicht schlimmer als heute — Terminal-Text
  liegt ohnehin im Journal-Verzeichnisbaum des Repos.

---

## S2 — Quiet-Events

**Problem heute.** Mehrere Events sind reine Echos von Tool-Calls, die dem
Aufrufer ihr Ergebnis schon synchron geliefert haben: `integrate_ok` /
`integrate_conflict` (das Tool-Result enthält alles), `agent_stopped`
(Echo von `stop_agent`), `user_question` (Echo des eigenen `ask_user`).
Jedes davon weckt ein geparktes `await_events` → ein voller Modell-Turn
über den gesamten Kontext, der nichts Neues erfährt. `agent_progress`
weckt ebenfalls, obwohl nie eine Reaktion nötig ist.

**dsh-Muster.** Zustellungsmodus `quiet` vs. `next-step`: Quiet-Inhalte
reisen mit dem nächsten regulären Aufwachen mit, statt selbst zu wecken.

### Umsetzung

**Schema** (`events.ts`): Envelope wird um ein optionales Flag erweitert —
abwärtskompatibel, alte Journale bleiben gültig:

```ts
const envelope = {
  seq: ..., ts: ...,
  /** true = weckt kein geparktes await_events; reist mit dem nächsten Wake mit. */
  quiet: z.literal(true).optional()
}
```

**EventQueue** (`eventQueue.ts`):

- `push(payload, opts?: { quiet?: boolean })` stempelt das Flag.
- `push` weckt Waiter nur bei nicht-quiet Events (Listener — Journal,
  Panel-Tap, Retro — sehen weiterhin ALLES sofort).
- `wait(cursor, ms)`: sofort auflösen nur, wenn `since(cursor)` mindestens
  ein nicht-quiet Event enthält; sonst parken. Löst ein Wake- oder ein
  Timeout aus, werden **alle** Events seit Cursor geliefert (quiet
  inklusive — sie reisen mit, kosten aber keinen eigenen Turn).
  Wichtig: Der Timeout-Rückgabewert `[]` von heute wird zu
  `since(cursor)` — die Quiet-Events dürfen beim Timeout nicht verloren
  gehen, sonst rückt der Cursor nie über sie hinweg. (`await_events`
  liefert dann Events + `agentsSummary` wie bei jedem nicht-leeren
  Ergebnis.)

**Produzenten** — genau vier Stellen werden quiet:

| Event | Ort | Begründung |
|---|---|---|
| `integrate_ok` / `integrate_conflict` | `toolsOrchestrator.ts` | Tool-Result trägt dieselben Daten synchron |
| `agent_stopped` | `toolsOrchestrator.ts` | Echo des eigenen `stop_agent` |
| `user_question` | `toolsOrchestrator.ts` (`ask_user`) | Panel-/Remote-Signal, nicht für den Frager |
| `agent_progress` | `toolsSubagent.ts` | Milestone-Notiz, nie reaktionspflichtig |

Alles andere weckt weiter: `agent_started`, `agent_start_failed`,
`agent_done`, `agent_question`, `agent_exited`, `user_message`,
`subtree_adopted`, `budget_warning`, `orchestrator_*`.

**Semantik-Änderung dokumentieren**: `report_progress`-Description sagt
heute „the orchestrator sees it live" — wird zu „the orchestrator sees it
with its next wake-up". Handbuch-Absatz zu D1b ergänzen.

### Tests
- `eventQueue.test.ts`: quiet weckt nicht; Wake liefert quiet mit;
  Timeout liefert quiet mit (Cursor rückt vor); Listener sehen quiet
  sofort; Mischfolgen quiet→wake→quiet.
- `toolsOrchestrator.test.ts`: `integrate_branch` weckt keinen parkenden
  `await_events`-Waiter; `agent_done` danach liefert beide Events.

### Risiken
- Ein Orchestrator, der nach `integrate_conflict` auf das *Event* wartete
  statt aufs Tool-Result, sähe es erst später — die Tool-Results tragen
  aber seit jeher die vollständige Antwort; Verhalten bleibt korrekt.
- Remote-Client/Panel: unverändert (hängen am `onPush`-Listener-Pfad).

---

## S3 — Strukturierte Reports (`resultSchema`)

**Problem heute.** `agent_done.summary` ist Freitext. Fan-in (Tester-,
Reviewer-, Merge-Resultate maschinell auswerten; später S4-Tasks
abhaken) heißt Prosa parsen.

**dsh-Muster.** `agent(prompt, {schema})`: Das Kind muss ein gegen ein
JSON-Schema validiertes Objekt liefern; Validierungsfehler gehen als
Tool-Error ans Kind zurück (Retry beim Kind, nicht beim Parent).

### Umsetzung

**Neues Shared-Modul `src/shared/schema/resultSchema.ts`** — bewusst die
dsh-Subset-Entscheidung übernehmen, kein ajv:

```ts
// Erlaubt: type object|string|number|integer|boolean|array|null,
// properties, required, items, enum, const, additionalProperties.
// Wurzel MUSS type: "object" sein. Alles andere → Fehlerliste.
export function assertSupportedResultSchema(schema: unknown): asserts schema is ResultSchema
export function validateResult(schema: ResultSchema, value: unknown): string[] // Fehlerpfade, [] = ok
export const RESULT_SCHEMA_MAX_CHARS = 4_000
export const RESULT_MAX_CHARS = 8_000
```

Handgerollter Validator (~150 Zeilen), rein, ohne I/O — vollständig
unit-testbar.

**`start_agent`** (`toolsOrchestrator.ts`):
- Neuer optionaler Param `resultSchema: z.unknown().optional()` mit
  Description („object-rooted JSON schema the agent's final report must
  match; keep it small").
- Beim Start: `assertSupportedResultSchema` — Verstoß ist ein sofortiger
  Tool-Error `invalid_result_schema` mit den Fehlerpfaden (fail-loud, wie
  Slot-Fehler).
- Ablage im Runtime: `runtime.resultSchemas: Map<agentId, ResultSchema>`
  (neben `recordAssignment`; bei `agent_start_failed` und `stop_agent`
  aufräumen). Ein Follow-up über `send_to_agent` behält das Schema —
  v1-Einschränkung, im Tool dokumentiert.
- Contract: `buildTaskContract` (in `@shared/prompts/contract`) bekommt
  optional `resultSchema` und rendert einen Absatz: „When you call
  report_done, include `result` matching exactly this JSON schema:
  ```<schema>```. status/summary stay required."

**`report_done`** (`toolsSubagent.ts`):
- Neuer optionaler Param `result: z.unknown().optional()`.
- Gilt für den Agenten ein Schema und `result` fehlt oder validiert
  nicht → Tool-**Error** an den Agenten:
  `{ error: 'invalid_result', problems: [...], note: 'Call report_done
  again with a corrected result. Your summary was NOT delivered yet.' }`
  — es wird **kein** `agent_done` gepusht (der Retry-Loop läuft beim
  Kind, der Parent sieht nur den validierten Endzustand; exakt das
  dsh-StructuredOutput-Muster).
- Serialisiert > `RESULT_MAX_CHARS` → gleicher Error (Schemas klein
  halten ist Absicht).
- Validiert → `agent_done` trägt `result`.

**`events.ts`**: `agentDonePayload` + `result: jsonValueSchema.optional()`
(ein kleines rekursives `jsonValueSchema` in `events.ts` ergänzen).
Journal/Resume/Panel erben das Feld ohne Änderung.

**Succession/Handoff**: `handoffAgentSchema.lastResult` (optional,
gekappt auf 500 Zeichen serialisiert) — der Nachfolger sieht validierte
Ergebnisse statt nur Prosa-Summaries.

### Tests
- `resultSchema.test.ts`: Subset-Grenzen (oneOf/format/$ref abgelehnt),
  Validierungspfade, required/enum/const/items, Tiefe.
- `toolsSubagent.test.ts`: ohne Schema unverändert; mit Schema —
  fehlendes/falsches `result` → Error ohne Event-Push; korrektes →
  `agent_done.result`; Größen-Kappe.
- `toolsOrchestrator.test.ts`: `invalid_result_schema` fail-loud;
  Schema-Lifecycle über stop/start_failed.
- Loop-Eval-Erweiterung: Tester-Agent mit
  `resultSchema: { pass: boolean, failures: string[] }`, Orchestrator
  wertet `result.pass` aus.

### Risiken
- Schwache Modelle produzieren wiederholt invalide Results → der Error
  nennt die exakten Pfade; nach n Fehlversuchen gibt das Kind erfahrungs-
  gemäß ein valides Minimalobjekt. Keine Host-seitige Retry-Zählung in
  v1 (der Parent sieht Stillstand über `lastOutputAgeSec`).

---

## S4 — Task-Board mit CAS-Revisionen

**Problem heute.** Der Plan lebt ausschließlich im Orchestrator-Kontext.
Succession muss ihn als Prosa transportieren (`decisions`/`nextActions`,
gekappt bei 48k), Resume rät ihn aus `agent_done`-Events, Leads haben
kein gemeinsames Medium mit dem Root.

**dsh-Muster.** Durabler Task-DAG außerhalb des Modellkontexts:
`revision` als CAS-Token, `blockedBy` azyklisch, Ownership, Tombstones.
Bewusst NICHT übernommen: `writeScopes` (Vertragus hat Worktrees — Datei-
Kollisionsschutz existiert bereits strukturell) und Worker-Zugriff aufs
Board (Worker behalten ihre drei Tools; das Board ist Orchestrator-Ebene).

### Datenmodell

**`src/shared/schema/tasks.ts`**:

```ts
export const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'deleted'] as const
export const taskSchema = z.object({
  taskId: z.string().regex(/^task-\d+$/),
  revision: z.number().int().positive(),      // CAS: +1 pro Mutation
  subject: z.string().min(1).max(200),
  description: z.string().max(2_000).default(''),
  status: z.enum(TASK_STATUSES),
  ownerAgentId: z.string().min(1).optional(), // Agent ODER Lead
  blockedBy: z.array(z.string()).max(20).default([]),  // azyklisch, keine deleted
  /** Host-Fakten des letzten agent_done des Owners — Anzeige, nie Statuswechsel. */
  lastReport: z.object({ status: agentDoneStatusSchema, summary: z.string().max(500),
    headSha: z.string().optional() }).optional(),
  createdAt: z.number(), updatedAt: z.number()
}).strict()
export const taskBoardSchema = z.object({
  schemaVersion: z.literal(1),
  nextTaskNumber: z.number().int().positive(),
  tasks: z.array(taskSchema)
}).strict()
export const TASKS_MAX = 200
```

### Host-Store `src/main/workspace/taskBoard.ts`

- Autoritativer Zustand **in-memory**; jede akzeptierte Mutation
  serialisiert (eine Promise-Kette wie im Journal) und schreibt danach
  den **ganzen Board-Snapshot atomar** nach
  `.vertragus/runs/<workspaceId>/tasks.json` (tmp + rename).
  Entscheidung Snapshot statt Change-Log: ≤200 Tasks, triviale Recovery,
  kein Replay-Code; das Journal bleibt die Event-Wahrheit, das Board die
  Plan-Wahrheit.
- API (synchron validierend, asynchron persistierend):
  `create(fields)`, `update(taskId, expectedRevision, action, fields)`,
  `get(taskId)`, `list(filter)`, `noteReport(agentId, doneEvent)`
  (setzt `lastReport` auf allen Tasks mit diesem Owner — **kein**
  Statuswechsel: Verifikation bleibt eine explizite Orchestrator-
  Entscheidung, Host-Doktrin), `snapshot()` für Handoff/Resume.
- Fehlercodes (Tool-sichtbar): `stale_revision` (Antwort trägt den
  aktuellen Task — dsh-Muster: der Aufrufer reconciled ohne Extra-Read),
  `unknown_task`, `task_deleted`, `dependency_cycle`,
  `dependency_deleted`, `task_limit`, `invalid_transition`.
- Aktionen: `claim` (owner setzen + `in_progress`), `release`, `edit`
  (subject/description), `set_dependencies`, `complete`, `reopen`,
  `delete` (Tombstone; Referenzen in fremden `blockedBy` werden beim
  nächsten Ready-Check ignoriert statt kaskadiert), `reassign`.
- Fenced wie Agenten: ein Lead darf `ownerAgentId` nur auf sich selbst
  oder Agenten seines Subtrees setzen (Prüfung via bestehendem
  `inScope`); Root darf alles. `delete`/`reassign` sind Root-only —
  exakt die dsh-Autorisierungsmatrix, eine Stufe einfacher.

### MCP-Tools (Root **und** Leads; `ORCHESTRATOR_TOOL_NAMES` +
`LEAD_TOOL_NAMES` erweitern)

- `task_create{subject, description?, blockedBy?, ownerAgentId?}` →
  `{taskId, revision}`
- `task_update{taskId, expectedRevision, action, subject?, description?,
  blockedBy?, ownerAgentId?}` → neuer Task-Snapshot; bei
  `stale_revision` Error **mit aktuellem Task im Payload**
- `task_list{status?}` → kompakte Zeilen
  `{taskId, revision, subject, status, ownerAgentId?, blockedBy,
  ready: boolean}` (`ready` = pending ∧ alle blockedBy completed) —
  Description: „your shared plan; it survives succession and resume"
- Kein `task_get` in v1 (`task_list` ist klein genug).

**Kopplung an den Agent-Lifecycle** (der eigentliche Gewinn):
- `start_agent{taskId?}`: existiert der Task und ist er claim-bar, claimt
  der Host ihn mechanisch für den neuen Agenten (`in_progress`, Owner =
  neue agentId) und hängt Subject+Description als Kontextzeile an den
  Seed. Nicht claim-bar → fail-loud vor dem Start.
- `agent_done` → `taskBoard.noteReport(...)` (im selben Pfad wie der
  bestehende `queueForAgent`-Push in `report_done`).
- `complete` bleibt IMMER ein expliziter `task_update` des Orchestrators
  nach Verifikation (`inspect_agent`) — nie automatisch.

### Succession, Resume, Prompt

- `handoff.ts`: `tasks: z.array(handoffTaskSchema)` (taskId, revision,
  subject gekappt 200, status, owner, blockedBy) — wie `openQuestions`
  **nie** weggekürzt; dafür darf `nextActions` schrumpfen (Tasks ersetzen
  Prosa). Successor-Prompt (in `orchestratorHandoff.ts`): „The task board
  is host state — task_list shows it; do not rebuild it from prose."
- `resume.ts`: `tasks.json` des resumten Runs lesen (fail-soft);
  `in_progress`-Tasks mit toten Ownern beim Seeden des neuen Boards auf
  `pending` + Owner-frei setzen (die ehrliche Aussage: der Prozess ist
  tot, die Arbeit liegt auf dem Branch). Briefing-Block: offene Tasks
  mit Branch-Hinweisen der alten Owner.
- Orchestrator-Systemprompt (`@shared/prompts/orchestrator`): kurzer
  Absatz — Board pflegen statt Plan im Kopf; ein Task pro
  `start_agent`-Auftrag ist der Normalfall; `complete` erst nach
  Verifikation.

### Tests
- `taskBoard.test.ts`: CAS (stale → aktueller Task im Error), Zyklen,
  Tombstone-Verhalten, Ready-Ableitung, Persistenz-Roundtrip, atomare
  Schreibfolge, fail-soft bei Disk-Fehlern (Board bleibt in-memory
  funktionsfähig, warnt einmal — Mutationen gehen weiter, wie Journal).
- `toolsOrchestrator.test.ts`: Fencing (Lead claimt fremden Agenten →
  Error), `start_agent{taskId}` claimt + seedet, Root-only
  delete/reassign.
- Succession-/Resume-Tests: Board überlebt Handoff (Snapshot im Package,
  Live-Board unverändert), Resume setzt tote Owner frei.
- Loop-Eval: Zwei-Task-Szenario mit `blockedBy`, Succession mittendrin,
  Nachfolger findet das Board per `task_list`.

### Risiken
- Doppelte Wahrheit Board ↔ Assignments (`recordAssignment`): bewusst
  getrennt lassen — Assignment ist „was ich dem Agenten gesagt habe",
  Task ist „was zu tun ist". Das Handbuch bekommt den Satz.
- Orchestrator ignoriert das Board: Prompt-Absatz + `start_agent{taskId}`
  als attraktiver Pfad (spart ihm Seed-Prosa). Nicht erzwingen in v1.

---

## S5 — `search_runs`: Volltextsuche über Journale

**Problem heute.** `events.jsonl` + `meta.json` aller bisherigen Runs
liegen auf Disk, aber kein Werkzeug erschließt sie; E2-Briefing und
Retro-Learnings sind Push, nicht Pull.

**dsh-Muster.** `session_search`/`session_event_read`: Suche über die
gesamte Historie, stärkster Treffer pro Session, gezieltes Nachlesen.

### Umsetzung

**`src/main/workspace/searchRuns.ts`** — reine Funktionen auf Basis der
bestehenden fail-soft-Leser (`readRunEvents`, `runMetaSchema`):

```ts
export interface RunSearchHit {
  workspaceId: string
  workspaceName?: string; goal?: string; startedAt?: number
  matches: Array<{ seq: number; type: string; agentId?: string
    excerpt: string /* ±120 Zeichen um den Treffer, whitespace-flach */ }>
  totalMatches: number
}
export async function searchRuns(repoPath: string, query: string, opts?: {
  maxRuns?: number      // Default 20 neueste Runs (nach meta.startedAt/mtime)
  maxHitsPerRun?: number // Default 5
  maxResults?: number    // Default 8 Runs mit Treffern
}): Promise<RunSearchHit[]>
```

- Match: case-insensitive, whitespace-flexibler Substring über die
  serialisierte Event-Zeile UND `meta.goal` — kein Regex in v1 (Injection-
  und Kostenfrage), kein ripgrep-Binary (Journale sind klein, Zeilen-
  Streaming reicht; ein Run > 5 MB wird übersprungen und im Ergebnis als
  `skipped` genannt — keine stille Lücke).
- Der **laufende** Run wird mitgesucht (sein Journal ist auf Disk).

**MCP-Tool** (Root-only, neben `record_retro` im `if (!scope)`-Block):

- `search_runs{query: string (min 3), maxResults?}` →
  `{ hits, note }`; leeres Ergebnis mit ehrlicher note („searched N runs").
- Description: „Search this repository's past run journals — use it
  before re-solving a problem an earlier run already hit (build quirks,
  flaky tests, decisions)."
- Zweiter Baustein v1.5 (erst wenn der Bedarf real ist): `read_run
  {workspaceId, seqFrom, seqTo}` für gezieltes Nachlesen; bis dahin
  reichen die Excerpts.

**Prompt-Anbindung**: Der E2-Briefing-Block erwähnt das Tool in einem
Satz („past runs are searchable: search_runs"). Die Retro-Learnings
bleiben Push wie bisher — S5 ergänzt sie, ersetzt sie nicht.

### Tests
- `searchRuns.test.ts`: Treffer über mehrere Runs, Sortierung neueste
  zuerst, Caps, korrupte Zeilen/fehlende meta (fail-soft), Größen-Skip
  mit `skipped`-Meldung, laufender Run inklusive.
- `toolsOrchestrator.test.ts`: Registrierung Root-only, leere Antwort.

### Risiken
- Journal-Wachstum: Suche ist O(Bytes der letzten 20 Runs) pro Call —
  akzeptabel; wenn nicht, ist der Index (SQLite) eine spätere Stufe,
  nicht v1.

---

## Reihenfolge, Schnitt, Aufwand

Fünf PRs, jeder unabhängig mergebar, in dieser Reihenfolge:

1. **PR S1 Spill** — `spill.ts`, `withSpill`, `read_output{full}`,
   `inspect_agent`-Kappe. Kleinster Schnitt, sofortiger Token-Effekt.
2. **PR S2 Quiet** — Envelope-Flag, Queue-Wartelogik, vier Produzenten,
   Doku-Sätze. Berührt die heißeste Stelle (Queue) — deshalb früh, solange
   wenig darauf aufbaut.
3. **PR S3 resultSchema** — Validator, `start_agent`/`report_done`,
   `agent_done.result`, Handoff-Feld.
4. **PR S4 Task-Board** — Schema, Store, drei Tools, Lifecycle-Kopplung,
   Succession/Resume/Prompt. Der große PR; intern in zwei Commits
   (Store+Tools, dann Succession/Resume-Integration).
5. **PR S5 search_runs** — unabhängig; kann parallel zu S3/S4 laufen.

Jeder PR: Handbuch-Abschnitt (HANDBUCH-HARNESS.md, neue Phase-G-Sektion
„dsh-Adoption") + bestehender Invariant-Test über die Tool-Namenslisten +
Loop-Eval-Erweiterung wo genannt (S3, S4).

**Bewusst NICHT in diesem Plan** (Abgrenzung aus dem Research bestätigt):
PTC/Code Mode, eigene Kompaktierung, Sandbox/Permission-Presets,
Worker-Zugriff aufs Task-Board, Spill-Retention, Regex-/Index-Suche.
