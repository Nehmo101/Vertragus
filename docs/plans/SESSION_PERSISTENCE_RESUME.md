# Vertragus Session-Persistenz & Wiederaufnahme: Kein Fortschrittsverlust bei App-Schließen, Crash oder Stromausfall

> Status (2026-07-19): Phase 0 + WS-A umgesetzt — eigener Session-Store unter `userData/sessions/`
> (atomare Writes, Legacy-Migration aus dem Settings-Bag), Engine-`flushSnapshot`, geordneter
> Shutdown mit 8-s-Deadline und Clean-Shutdown-Marker, Registry-Rehydration beim Boot (Sessions
> mit Fortschritt erscheinen nach Neustart wieder in der bestehenden UI; leere/verwaiste Einträge
> werden bereinigt). WS-B umgesetzt: `AgentResumeState` (Info + redigierter 64-KB-Scrollback-Tail)
> pro Session, periodischer 30-s-Sweep + finaler Sweep im Shutdown. WS-C umgesetzt:
> `createWorktree` weicht nach Neustart belegten Identitäten per `-r<n>`-Suffix aus (nie stille
> Übernahme fremder Checkouts), `inventoryWorktrees` klassifiziert owned/orphaned inkl.
> Änderungszähler, und der Recovery-Pfad akzeptiert `vertragus/`-Branches (vorher lehnte
> `prepareRecoveryWorktree` alle Nach-Rebrand-Worktrees ab — Bug). Abweichung: die
> Phase-2-Kern umgesetzt: Unterbrochene Tasks tragen ein `interrupted`-Flag (statt neuem
> Status-Union-Member — D7 ließ beides zu; das Flag vermeidet Eingriffe in die komplette
> Status-Maschinerie), die Dispatch-Prompts werden nur in der persistierten Snapshot-Datei
> mitgeführt (`dispatchRecords`, nie in Live-Pushes), und `resumeInterruptedTask` setzt die
> Aufgabe per Klick (Task-Karte + Canvas-Kontextmenü, „Weiterführen") im erhaltenen Worktree
> fort — über den bestehenden `recoveryWorktree`-Pfad. Phase 2 Rest + Phase 3 umgesetzt:
> Startup-Banner (`SessionRestoreBanner`) zeigt Crash-Erkennung, wiederherstellbare Teams,
> verwaiste Worktrees (Verwerfen nur nach Bestätigung, nie automatisch) und GC-Vorschläge für
> Sessions älter als `sessions.gcDays` (Default 30 Tage). `respawnSessionAgents` startet das
> interaktive Team einer Session explizit neu — im erhaltenen Worktree, mit Handoff-Briefing
> aus dem gesicherten Scrollback-Tail. Natives Provider-Resume via `ProviderDef.resumeArgs`:
> nur Claude (`--continue`, cwd-scoped = worktree-scoped, daher parallel-sicher); Codex'
> `resume --last` ist global und bleibt bewusst undeklariert, Fallback ist immer das Briefing.
> Damit ist der Plan vollständig umgesetzt; offen bleibt nur optionales Feintuning
> (z. B. Session-Import verwaister Worktrees).
> Ziel: Wird Vertragus geschlossen (bewusst, Crash, Stromausfall, Update-Neustart), können alle
> offenen Workspace-Sessions nach dem nächsten Start **weitergeführt** werden — Task-DAG, Ziel,
> Terminal-Historie, Worktrees mit uncommitteten Änderungen und (wo der Provider es kann) sogar
> die Agenten-Konversation selbst.

## Context

Vertragus behandelt Worker bereits als asynchrone Jobs (Task-IDs, Heartbeats, Worktree-Isolation,
siehe `docs/RELIABLE_AGENT_LIFECYCLE.md`) — aber nur **innerhalb eines App-Prozesses**. Beim Beenden
ruft `before-quit` schlicht `agentManager.killAll()` auf (fire-and-forget, `src/main/index.ts:108-111`),
nichts wird gesichert, nichts wird beim nächsten Start wieder aufgenommen. Die Renderer-UI startet leer.

Das Überraschende: **Eine Snapshot-Persistenz existiert bereits**, ist aber über einen echten
Neustart hinweg faktisch unerreichbar (Details unten). Der Plan repariert daher zuerst die
vorhandene Persistenz, statt eine neue zu erfinden, und baut darauf die Wiederaufnahme-Schichten auf.

## Verifizierte Ausgangslage (tragende Fakten)

**Was bereits persistiert wird:**

- Der `OrchestratorEngine` schreibt bei jeder Zustandsänderung einen vollständigen
  `OrchestratorSnapshot` (Ziel, Task-DAG, Findings, Budget, Reliability, Pending-Plan/-Approvals)
  gedrosselt (2 s, `SNAPSHOT_PERSIST_MIN_INTERVAL_MS`, `Engine.ts:166`) via
  `setSetting(persistenceKey(), snapshot)` in den electron-store `vertragus.json`
  (`Engine.ts:625-654`).
- Der Engine-Konstruktor **restauriert** aus diesem Key (`Engine.ts:397-452`): Budget, Reliability,
  Retro, Git-Post-Processing; unterbrochene Tasks (`queued|running|waiting|paused`) werden auf
  `stopped` gesetzt mit Note „Durch App-Neustart unterbrochen." (`Engine.ts:437`).
- Run-Journal: append-only JSONL pro Session unter `userData/diagnostics/runs/` (Agent-Events +
  Orchestrator-Snapshots, redigiert, 5-MiB-Cap; `src/main/diagnostics/runJournal.ts`) — heute reine
  Diagnose, kein Lese-/Resume-Pfad.
- `recoveryArtifact.ts`: Bei Worker-Fehlschlag wird `git status` im Task-Worktree erfasst und ein
  Retry kann via `recoveryWorktree` **im selben Worktree** weiterarbeiten
  (`Engine.ts:2437-2496`, `AgentManager.ts:481-501`) — funktioniert aber nur innerhalb einer
  laufenden Engine, nicht über Neustarts.
- Worktrees (`<repo>/.vertragus-worktrees/<sessionId>/<agentId>`, Branch
  `vertragus/<sessionId>/<agentId>`, `worktree.ts:66-103`) **überleben** das Beenden — uncommittete
  Arbeit bleibt auf der Platte. Gelöscht wird nur bei explizitem `removeAll` (Workspace leeren).
- Handoff-Primitive: `handoff.ts` baut ein Markdown-Briefing inkl. ANSI-bereinigtem
  Scrollback-Tail (bis 24 000 Zeichen) und schreibt es nach `userData/orca-handoffs/`
  (`AgentManager.ts:804-811`); ein frischer Agent wird damit geseedet.

**Warum es trotzdem nicht über einen Neustart funktioniert (die vier Kernlücken):**

1. **Toter Persistenz-Key.** `persistenceKey()` = `orchestratorSnapshot:<profileId>:<workspaceSessionId>`
   (`Engine.ts:965-971`), aber die `workspaceSessionId` ist eine bei `create()` frisch gewürfelte
   UUID (`WorkspaceSessionRegistry.ts:87`), die **nirgends persistiert wird**, und die Registry hat
   **keine Boot-Rehydration** — ihre Maps starten leer. Nach Neustart bekommt eine neue Session eine
   neue UUID → neuer Key → Restore findet nichts; alte Snapshots akkumulieren als tote Keys in
   `vertragus.json`. (Die Behauptung in `IMPLEMENTATION_STATUS.md:121-125`, der Task-DAG werde
   wiederhergestellt, gilt nur prozess-intern.)
2. **Quit sichert nichts und wartet auf nichts.** `before-quit` ist fire-and-forget ohne
   `preventDefault`; ein noch ausstehender, gedrosselter Snapshot (`persistTimer` ist `unref`'d)
   wird beim Beenden verworfen → bis zu 2 s Orchestrator-Zustand weg. `killAll` eskaliert
   SIGTERM→SIGKILL nach 5 s (`processTermination.ts:48-68`), aber der Timer ist `unref`'d — die App
   kann vorher exiten und Prozessbäume verwaisen lassen.
3. **AgentManager persistiert nichts.** PTY-Handles sind naturgemäß flüchtig, aber auch Scrollback
   (max. 200 KB/Agent, `AgentManager.ts:80,505`), `AgentInstanceInfo` (Worktree, Branch, Provider,
   Modell, Task-Zuordnung) und die Session-ID (`AgentManager.ts:169`, pro Prozess neu gewürfelt)
   gehen komplett verloren. Die Worktrees der Vorsession liegen verwaist auf der Platte — kein
   lebender Agent referenziert sie, nichts räumt auf, nichts bietet Übernahme an
   (bekanntes Audit-Finding, `VERTRAGUS_AUDIT.md:43-48`).
4. **Kein Provider-Resume.** Kein CLI wird je mit `--resume`/`--continue`/Session-ID gestartet;
   Provider-Session-IDs werden nicht erfasst. Eine echte Konversations-Fortsetzung ist Neuland —
   das nächstliegende vorhandene Primitiv ist das Handoff-Briefing.

**Weitere Randbedingungen:**

- Snapshots liegen im generischen `settings`-Bag; jedes `setSetting` serialisiert den **gesamten**
  Settings-Blob neu (`store.ts:80-84`) — bei 2-s-Snapshots mehrerer Sessions ein Skalierungs- und
  Korruptionsrisiko.
- Renderer: `useAppStore.init()` holt Agents/Sessions/Snapshot per IPC und abonniert Push-Events —
  bei Renderer-Reload (Main lebt) erscheint alles wieder; nach App-Neustart ist alles leer. Nur
  UI-Layout/Theme überleben (localStorage + allow-listete Config-Keys). `orchestratorSnapshot:*`
  ist bewusst **nicht** in der IPC-Allow-List (`configAccess.ts`) — gut so, bleibt so.
- Remote/Mission Control seedet sein Read-Model aus `workspaceSessions` — erbt automatisch jede
  Verbesserung hier, braucht keine eigene Persistenz.

## Architektur-Entscheidungen

| # | Entscheidung |
|---|---|
| D1 | **Vorhandene Snapshot-Persistenz reparieren statt Neubau**: Session-IDs pro Profil persistieren + Registry-Rehydration beim Boot, damit `persistenceKey()` wieder matcht. Kein neues Snapshot-Format. |
| D2 | **Eigener Session-Store statt Settings-Bag**: Snapshots wandern aus `vertragus.json` in `userData/sessions/<sessionId>.json` (atomarer Write: temp+rename, wie electron-store). Einmalige Migration alter `orchestratorSnapshot:*`-Keys inkl. Entfernen der toten Keys. Ein leichter Index `sessions.json` (`{profileId → [sessionId]}`, aktive Session, letzter Clean-Shutdown-Marker) ersetzt die fehlende Registry-Persistenz. |
| D3 | **Geordneter Shutdown mit Deadline**: `before-quit` macht einmalig `event.preventDefault()`, dann: (1) alle Engines final flushen (pendingSnapshot drainen), (2) pro Agent einen `AgentResumeState` sichern (siehe D5), (3) `killAll()` mit awaited Terminierung, alles unter globaler Deadline von ~8 s, danach `app.exit()`. Zweiter `before-quit` (User drückt nochmal Beenden) exitet sofort. |
| D4 | **Crash-Erkennung über Clean-Shutdown-Marker**: Beim Start Marker prüfen; fehlt er, lief die App unsauber aus → Recovery-Modus mit denselben Daten (Snapshots sind ohnehin ≤2 s alt, Worktrees liegen auf Platte). Kein separater Crash-Pfad nötig — genau deshalb wird laufend persistiert, nicht nur beim Quit. |
| D5 | **`AgentResumeState` pro Agent** (in `sessions/<sessionId>.json` eingebettet): `AgentInstanceInfo`-Kern (Provider, Modell, Rolle, workingDir, Worktree, Branch, taskId, engineId), ANSI-bereinigter Scrollback-Tail (Deckel ~64 KB, Redaction wie Run-Journal), Provider-Session-ID (falls erfasst, D8), Zeitstempel. Geschrieben beim Shutdown (D3) und zusätzlich periodisch (~30 s, huckepack auf den Heartbeat-Takt) für den Crash-Fall. PTY-Handles werden nie persistiert. |
| D6 | **Worktree-Identität wird session-stabil**: Worktree-Pfad/Branch leiten sich von der persistierten `workspaceSessionId` ab statt von der prozess-lokalen `AgentManager.sessionId` (`AgentManager.ts:169` entfällt als Pfadquelle). Nach Neustart findet die rehydrierte Session ihre eigenen Worktrees wieder. Verwaiste Worktrees fremder/gelöschter Sessions werden beim Boot inventarisiert und in der UI zur Übernahme („als Session importieren") oder Bereinigung angeboten — niemals stillschweigend gelöscht (Guards aus `rollbackWorktree` bleiben). |
| D7 | **Unterbrochene Tasks werden `interrupted`, nicht `stopped`**: Neuer Task-Status (oder Note-Flag) + Restart-Brücke für `recoveryArtifact`: Da der Worktree den Neustart überlebt (D6), kann ein unterbrochener Task per Klick als Retry mit `recoveryWorktree` re-dispatcht werden — derselbe Mechanismus, der heute schon Fehlschlag-Retries im selben Worktree fortsetzt, nur über die Prozessgrenze gehoben. |
| D8 | **Konversations-Resume zweistufig**: (a) *Universal-Fallback* — frischer Agent wird mit einem Handoff-Briefing aus dem `AgentResumeState` geseedet (vorhandenes Primitiv `buildBriefing`/`seedInteractive`); (b) *natives Resume* pro Provider, wo das CLI es kann (Capability-Feld `resume` in `ProviderDef`; Kandidaten: `claude --resume <id>`/`--continue`, `codex resume`; Kimi/Cursor/Copilot bei Implementierung verifizieren). Provider-Session-IDs werden beim Spawn/aus dem Output erfasst, sonst bleibt (a). |
| D9 | **Wiederaufnahme ist opt-in per Session, nicht Auto-Start**: Nach dem Start zeigt die UI einen „Offene Sessions"-Dialog/Banner (Sessions mit Ziel/DAG/Worktree-Änderungen). Pro Session: **Fortsetzen** (Engine rehydriert, Agenten via D8 neu gestartet, unterbrochene Tasks anwählbar), **Nur ansehen** (read-only, heute schon teilweise möglich) oder **Verwerfen** (Snapshot löschen, Worktrees optional aufräumen). Kein automatisches Neustarten von Agenten-Prozessen ohne Nutzeraktion — Budget-/Kostenkontrolle. |
| D10 | **Renderer bleibt zustandslos**: Kein zusätzlicher Persist im `useAppStore` — die UI spiegelt weiterhin nur Main-State. Wiederhergestellte Scrollback-Tails werden als „eingefrorene" Historie in den Terminal-Buffer vorgeladen (visuell abgesetzt), Live-PTY schreibt danach weiter. |
| D11 | **Sicherheit unverändert streng**: `sessions/*.json` mit Mode 0600, Redaction wie Run-Journal (`runJournal.ts:41-59`); keine Secrets im Resume-State; `orchestratorSnapshot:*`/Session-Store bleiben außerhalb der Renderer-Config-Allow-List; Zugriff nur über neue, gated IPC (`sessions:listResumable`, `sessions:resume`, `sessions:discard`, main-window-gated). |
| D12 | **Run-Journal bleibt Diagnose**: Kein Resume aus dem JSONL-Journal (Truncate-Semantik, Redaction machen es als Quelle ungeeignet). Es bekommt lediglich neue Event-Typen (`session-restored`, `session-resumed`, `shutdown-flush`) für Nachvollziehbarkeit. |

## Shared Hotspots (genau EIN Integrator-Owner)

`src/shared/ipc.ts`, `src/shared/orchestrator.ts` (Status `interrupted`, `AgentResumeState`-Typ),
`src/shared/agents.ts`, `src/preload/index.ts`, `src/main/ipc/register.ts`,
`src/main/config/store.ts`/`migrations.ts`, `src/main/index.ts` (Shutdown-Sequenz),
`src/renderer/src/store/useAppStore.ts`.

## Phasierung

```
Phase 0 (seriell, Integrator):  Contracts, Session-Store, Shutdown-Sequenz   ← größter Einzelgewinn
Phase 1 (parallel, 3 Worker):   WS-A Registry-Rehydration & Engine-Keying
                                WS-B AgentResumeState & Scrollback-Persistenz
                                WS-C Worktree-Stabilität & Verwaisten-Inventar
Phase 2 (Integration):          Resume-Flow end-to-end (UI-Dialog, interrupted-Tasks, Briefing-Seed)
Phase 3 (parallel):             WS-D natives Provider-Resume | WS-E Crash-Härtung & Polish
```

### Phase 0 — Integrator: Contracts, Session-Store, geordneter Shutdown

1. **`src/main/config/sessionStore.ts` (neu)**: atomare Read/Write-API für
   `userData/sessions/<sessionId>.json` + Index `sessions.json` (Profil→Sessions, aktive Session,
   `cleanShutdown`-Marker). Mode 0600. Migration in `migrations.ts`: vorhandene
   `orchestratorSnapshot:*`-Keys aus dem Settings-Bag in Session-Dateien überführen, tote Keys
   löschen (Backup wie bisher via `migrateStore`).
2. **`Engine.ts`**: `persistPendingSnapshot` auf sessionStore umstellen; neue Methode
   `flushSnapshot(): Promise<void>` (drainen von `persistTimer` + synchroner finaler Write).
   `persistenceKey()`-Logik bleibt als Datei-Namensschema erhalten.
3. **`src/main/index.ts`**: Shutdown-Sequenz nach D3 — `before-quit` mit `preventDefault`,
   `Promise.race([shutdown(), deadline(8s)])`, dann `app.exit()`. `shutdown()` = Engines flushen →
   AgentResumeStates schreiben → `killAll()` awaited (Escalation-Timer nicht mehr `unref`'d bzw.
   explizit abgewartet) → Remote stoppen → `cleanShutdown`-Marker setzen.
4. **`src/shared/*`**: Typen `AgentResumeState`, `SessionIndexEntry`, Task-Status `interrupted`,
   IPC-Kanäle `sessions:listResumable|resume|discard`, Push `ev:resumableSessions`.
5. **Preload**: `orca.sessions.*` im vorhandenen typisierten Muster.

### Phase 1 — parallel

**WS-A: Registry-Rehydration & Engine-Keying** (`WorkspaceSessionRegistry.ts`, `Engine.ts`)
- `create()` registriert die neue Session-ID im Session-Index; `remove()` trägt aus und löscht die
  Session-Datei.
- Neue `rehydrate()`-Methode: liest beim Boot den Index, erzeugt pro persistierter Session ein
  `WorkspaceSession` mit **derselben** Session-ID (Signatur von `create` um `sessionId?` erweitern)
  → Engine-Konstruktor-Restore (`Engine.ts:397-452`) greift endlich wirklich.
- Unterbrochene Tasks: Restore-Mapping von `stopped`+Note auf neuen Status `interrupted`
  (inkl. `recoveryArtifact`-Erhalt aus dem Snapshot).
- Tests: Restart-Roundtrip (create → persist → neue Registry-Instanz → rehydrate → Snapshot
  identisch bis auf Aktivitäts-Reset), Index-Konsistenz bei `remove`/`resetSession`.

**WS-B: AgentResumeState & Scrollback** (`AgentManager.ts`, neu `agents/resumeState.ts`)
- `captureResumeState(id)`: `AgentInstanceInfo`-Kern + redigierter, ANSI-bereinigter
  Scrollback-Tail (~64 KB; Wiederverwendung `tailScrollback`/Redaction-Helfer).
- Periodischer Sweep (~30 s) für alive Agents + finaler Sweep in der Shutdown-Sequenz (Phase 0.3).
- `buffer(id)` liefert nach Restore den eingefrorenen Tail als Prefix (D10).
- Tests: Redaction, Cap, Roundtrip; kein PTY-Feld serialisiert.

**WS-C: Worktree-Stabilität & Verwaisten-Inventar** (`worktree.ts`, `AgentManager.ts`)
- `worktreeIdentity` von `workspaceSessionId` ableiten (Fallback auf Prozess-UUID nur ohne
  Session-Kontext); Kollisionsverhalten definieren: existiert der Pfad bereits mit sauberem
  `git worktree`-Zustand → adoptieren statt neu anlegen.
- `inventoryWorktrees(repoRoot)`: listet `.vertragus-worktrees/*` (+ Legacy `.orca-worktrees`),
  matcht gegen Session-Index → `{ owned, orphaned }` mit `git status --porcelain`-Kurzinfo je
  Worktree (Wiederverwendung `captureTaskRecoveryArtifact`-Logik).
- Tests: Adoption, Orphan-Erkennung, Guards (nur Vertragus-Pfade/-Branches, wie `rollbackWorktree`).

### Phase 2 — Integration: Resume-Flow end-to-end

1. **Main**: `sessions:listResumable` (Index + Snapshot-Metadaten + Worktree-Inventar),
   `sessions:resume` (Registry-`rehydrate` der Session, Agenten-Neustart via D8a:
   `spawnProfileTeam`-Pfad mit Seed aus Briefing, das `buildBriefing` aus dem `AgentResumeState`
   erzeugt), `sessions:discard` (Snapshot + Resume-States löschen; Worktrees nur nach explizitem
   zweitem Bestätigen via bestehendem `rollbackWorktrees`).
2. **Engine**: `interrupted`-Tasks bekommen die Aktion „Weiterführen" → Re-Dispatch als Retry mit
   `recoveryWorktree` aus dem restaurierten `recoveryArtifact` bzw. dem adoptierten Worktree (D7).
3. **Renderer**: „Offene Sessions"-Banner/Dialog beim Start (Anzahl, Ziel, letzter Stand,
   uncommittete Dateien je Session); Aktionen Fortsetzen/Ansehen/Verwerfen (D9). Task-Karten zeigen
   `interrupted` visuell unterscheidbar von `stopped`/`failed`.
4. **Run-Journal**: neue Events `session-restored`/`session-resumed`/`shutdown-flush` (D12).
5. **Abnahme Phase 2 (Kern-Szenario)**: Session mit laufendem Plan starten → App hart beenden
   (SIGKILL, simulierter Crash) → Start → Banner zeigt Session → Fortsetzen → DAG + Ziel + Findings
   vollständig da, Terminals zeigen eingefrorene Historie, unterbrochener Task läuft im selben
   Worktree weiter, uncommittete Dateien unversehrt.

### Phase 3 — parallel

**WS-D: Natives Provider-Resume** (`providers/*`, `AgentManager.ts`)
- `ProviderDef` um Capability `resume?: { flag: string; captureSessionId: 'spawn-arg' | 'output-scan' }`
  erweitern; pro Provider bei Implementierung gegen die aktuelle CLI-Version verifizieren
  (Kandidaten: Claude `--resume <id>`/`--continue`, Codex `resume`; Kimi/Cursor/Copilot prüfen).
- Session-ID-Erfassung analog `limitSignals`-Muster (Scrollback-Scan) bzw. via Spawn-Parameter;
  Ablage im `AgentResumeState`. `sessions:resume` bevorzugt natives Resume, fällt sonst auf
  Briefing-Seed zurück — für den Nutzer transparent ausgewiesen.

**WS-E: Crash-Härtung & Polish**
- `cleanShutdown`-Marker-Auswertung: unsauberer Exit → Recovery-Hinweis im Banner („Vertragus wurde
  unerwartet beendet"); Telemetrie-Zähler.
- Alte-Session-GC: Sessions älter als konfigurierbare Frist (Default 30 Tage) ohne
  Worktree-Änderungen werden im Banner zur Bereinigung vorgeschlagen (nie automatisch gelöscht).
- Snapshot-Write-Fehler (Platte voll) non-fatal + sichtbar (wie Journal-Policy in
  `PRODUCTION_HARDENING.md`).
- Doku: `IMPLEMENTATION_STATUS.md` korrigieren (Restore-Behauptung), `RELIABLE_AGENT_LIFECYCLE.md`
  um Abschnitt „Restart-Recovery" ergänzen, Audit-Finding `VERTRAGUS_AUDIT.md:43-48` schließen.

## Test- & Abnahmestrategie

- **Unit**: sessionStore-Atomarität (Write-Abbruch → alte Datei intakt), Engine-`flushSnapshot`,
  Registry-Rehydration-Roundtrip, ResumeState-Redaction, Worktree-Adoption/Orphan-Inventar,
  Shutdown-Sequenz mit Fake-Timern (Deadline, Doppel-Quit).
- **Integration (Selftest-Muster wie `MCP_SELFTEST`)**: neuer `VERTRAGUS_RESUME_SELFTEST=1`-Pfad —
  Engine mit gestubbtem runTask starten, Snapshot schreiben, Prozessgrenze simulieren (frische
  Registry + Store-Reload), rehydrieren, `interrupted`-Retry dispatchen, Ergebnis asserten.
- **Manuell (Abnahme)**: die drei Beendigungsarten — normales Quit, `kill -9` (Crash),
  Renderer-Reload — jeweils gegen das Kern-Szenario aus Phase 2.5; zusätzlich Legacy-Migration
  (bestehende `vertragus.json` mit alten `orchestratorSnapshot:*`-Keys).
- Bestehende Gates: `corepack pnpm typecheck` / `test` / `lint` + Diff-/Security-Gates.

## Risiken & Gegenmaßnahmen

| Risiko | Gegenmaßnahme |
|---|---|
| Shutdown-Deadline zu knapp → SIGKILL auf schreibende Worker | Reihenfolge: erst Snapshots/ResumeStates (schnell, lokal), dann Prozess-Terminierung; Deadline nur für die Terminierung ausreizen |
| Snapshot-Format-Drift (alte Session-Dateien nach Update) | `schemaVersion` je Session-Datei + tolerantes Restore (unbekannte Felder ignorieren, inkompatible Sessions als „nur ansehen/verwerfen" anbieten) |
| Worktree-Adoption trifft fremden/kaputten Git-Zustand | Adoption nur bei validem `git worktree list`-Eintrag + passendem Branch-Präfix; sonst als „orphaned, read-only" führen |
| Provider-CLI-Resume-Flags ändern sich | Capability pro Provider isoliert + Briefing-Fallback ist immer verfügbar (D8a) |
| Doppelstart der App (zwei Instanzen, gleicher Store) | `app.requestSingleInstanceLock()` vor jeder Session-Store-Öffnung (heute nicht gesetzt — Teil von Phase 0.3) |
| Größere Settings-/Store-Writes blockieren Main-Loop | Pro-Session-Dateien (D2) entkoppeln; Writes bleiben klein und atomar |

## Bezug zur Open-Core-Roadmap

Lokale Persistenz & Wiederaufnahme gehören vollständig in den MIT-Kern. Die in
`docs/ROADMAP_OPEN_CORE.md` skizzierte **detached/VPS-Persistenz** (Sessions laufen serverseitig
weiter, während die App zu ist) ist eine mögliche spätere kommerzielle Schicht **auf** diesem
Fundament: Der hier definierte `AgentResumeState` + Session-Store ist bewusst so geschnitten, dass
er später auch von einem Remote-Runner gelesen/geschrieben werden könnte. Dieser Plan ändert daran
nichts — er macht die lokale App verlustfrei.
