# Maßnahmenplan: Beseitigung der wiederkehrenden Probleme aus den Retros

**Datenbasis:** 80 Run-Retros (`runs/2026/07/`, 14.–18.07.2026), 3 Learnings-Snapshots,
abgeglichen gegen den Code-Stand `origin/DEV` (Commit `17e5313`, 17.07.) und den bereits
existierenden `docs/RETRO_IMPROVEMENT_PLAN.md` (Stand 15.07.).

> Diese Fassung ersetzt den ersten, allein aus den Retros abgeleiteten Wurf. Der Abgleich mit
> dem echten Code zeigt: Ein Großteil der dort genannten Cluster ist **bereits behoben**. Dieser
> Brief konzentriert sich daher auf die **nachweislich noch offenen** Probleme — verankert an
> konkreten Datei-/Zeilenstellen mit minimalem Fix und deckendem Test. Datei-/Zeilenangaben
> beziehen sich auf `origin/DEV`.

**Gesamtbild:** 19 × success, 27 × error, 19 × needs-work, 14 × stopped. Wie schon im
`RETRO_IMPROVEMENT_PLAN` festgehalten: Die meisten nicht-erfolgreichen Läufe scheiterten
**nicht an der Modellarbeit**, sondern an nachgelagerten Plattform-Schritten — das Feature war
oft fertig, verifiziert und committet, der Lauf wurde trotzdem rot/gestoppt gewertet.

---

## 0. Bereits erledigt (Abgleich mit dem Code — nicht erneut angehen)

Die folgenden Punkte meines ersten Wurfs sind in `DEV` **schon umgesetzt** und in den frischesten
Retros (18.07.) **nicht mehr aufgetreten**:

| Ehemaliger Cluster | Status im Code | Beleg / Fundstelle |
|---|---|---|
| Ownership-Kollaps `invalid_ownership` → Fallback | **behoben** (Reparatur statt Kollaps: Shared-Hotspot-Serialisierung + Advisory-Kanten) | `planner.ts:231-293`, `repaired_ownership`; Tests `plannerOwnership.test.ts` |
| Security-Gate flaggt Doku deterministisch | **behoben** (Doku-Pfade + konfigurierbare Excludes ausgenommen; Secret-Patterns weiter überall) | `securityGate.ts:70-73,87-97,150-151`; `profile.ts:83` |
| Whitespace-Gate blockiert hart | **entschärft** (als needs-work-Finding gerettet statt `blocked`) | `autoPr.ts:583-612`, `captureNeedsWorkChange` |
| Temp-/Scratch-Dateien im Commit | **behoben** (Entstaging + Finding `temp-files-removed`) | `autoPr.ts:214-225`; `workspaceRunLifecycle.ts:61-69` |
| „at capacity" killt lange Tasks | **behoben** (als Limit-Signal → Slot-Wechsel-Retry) | 0 Vorkommen am 18.07. |
| Hohle No-changes-„Erfolge" (Grundfall) | **teilweise behoben** (Recovery-Adoption, Gate-Arbitration) | siehe P5 (Restlücke) |
| Approval nur per Polling | **teilweise behoben** (`plan-review`-Event, `await_plan_approval` für das **Plan**-Review) | siehe P6 (Tool-Permission-Restlücke) |
| Fehlende Gate-Tools (eslint/prisma) zentral | **teilweise behoben** (Worktree-Install ohne `--ignore-scripts`; `command not found`/`ENOENT` = Infra) | `autoPr.ts:29-35`; siehe P3/corepack-Restlücke |

**Konsequenz:** Der Fokus verschiebt sich klar auf die **zentrale Integration** und einige eng
umrissene Restlücken.

---

## 1. Verbleibende offene Probleme (priorisiert nach Hebel × Aktualität)

### P1 — Zentrale Auto-Integration per Cherry-Pick (DOMINANT, verschärft sich)

**Evidenz:** 7 der 9 Cherry-Pick-Fehlschläge im gesamten Zeitraum fallen auf den **18.07.** — also
*nach* allen bisherigen Fixes: retro-mrqsh5km („dritter Fehlschlag in Folge"), mrqh8tux, mrqjip3y,
mrqiyrxx, mrqvv924, mrqwzi39; Base-Divergenz: mrqt5wlo, mrqxapm5. In allen Fällen waren die Tasks
fachlich grün — nur die zentrale Übernahme wurde rot.

**Code-Ursache** (`src/main/integrations/autoPr.ts`): `publishAggregate` (`:970-1027`) baut ein
frisches Integrations-Worktree aus `origin/${base}` und cherry-pickt jeden Task-Commit
(`:980-984`). Jeder Fehler bricht den **gesamten Batch** ab → `status:'blocked'` (`:1021-1027`).
Es gibt **nirgends** eine Idempotenz-/Ancestor-Prüfung (`git merge-base --is-ancestor`, `patch-id`)
— per grep null Treffer in `src/`. Folgen:
- Ein bereits im Baum materialisierter Commit lässt `cherry-pick` an „empty/nothing to commit"
  scheitern → Abbruch (die „dreimal in Folge"-Kollision).
- Vor `worktree add … origin/${base}` (`:977`) steht **kein `git fetch`** → stale Base; die
  Cherry-Picks passen gegen ein veraltetes `origin/main` und GitHub meldet danach den Konflikt.
- `prepareTaskChange` (`:460`) macht `git reset --soft baseCommit` (`:486`) **ohne** zu prüfen, ob
  `baseCommit` Ancestor von HEAD ist → bei divergiertem Folgeplan werden gelieferte Commits still
  fallengelassen („Folgeplan sieht den Code nicht", retro-mrnchpk2).

**Fix (eine `publishAggregate`-Härtung):**
1. Neuer Helfer `isAncestor(cwd, a, b)` = `git merge-base --is-ancestor a b` (exit 0/1 → bool; benötigt
   einen exit-code-fähigen Runner neben dem werfenden `git()` bei `:191`).
2. In der Cherry-Pick-Schleife (`:983`): `if (await isAncestor(integrationPath, commit, 'HEAD')) continue;`
   sonst cherry-picken; bei „empty" `--skip`/`--allow-empty` statt Batch-Abbruch. Optional patch-id-
   Vorabgleich gegen `origin/base..HEAD` für rebasede Duplikate.
3. Vor `:977`: `git fetch origin ${base}`; danach Divergenz messen
   (`git rev-list --count <taskBase>..origin/${base}`) und bei Divergenz das Integrations-Branch auf
   `origin/${base}` rebasen bzw. mit klarer „stale base"-Begründung blocken.
4. In `prepareTaskChange` (`:486`) vor dem Soft-Reset: `isAncestor(worktree, baseCommit, 'HEAD')`
   prüfen; bei false auf echten `merge-base` zurückfallen statt gelieferte Commits zu verlieren.

**Test:** `GitTestHarness`-Integrationstest (Basis enthält Commit X bereits → `publishAggregate`
überspringt X und öffnet trotzdem den PR statt `blocked`); zweiter Fall: `origin/main` nach
Base-Erfassung vorgerückt → stale Base wird erkannt (rebased/blocked), nicht blind ge-PRt.
Hinweis: `publishAggregate` ist derzeit **nicht** in `autoPrInternals` exportiert (`:1048`) — für
den Test entweder exportieren oder `GitTestHarness` gegen ein Temp-Repo nutzen.

### P2 — Remote-CI-Watch endet ohne terminalen Status → grüne PRs werden `stopped` (höchster Einzel-Hebel)

**Evidenz:** retro-mrqulr14, mrn5pdnn — alle Fachaufgaben grün, nur der nachgelagerte CI-Watch
lieferte keinen terminalen Status → Lauf `stopped`.

**Code-Ursache:** `monitorRemoteCi` (`autoPr.ts:814`) verwirft den Exit-Code des `gh pr checks
--watch` (`:856`) und macht stattdessen **eine** Nachlese (`:877`). Liefert diese im Rennen direkt
nach `--watch` leer/`pending`, fällt der Code auf `timed-out` (`:895`). `Engine.ts:2744-2747` mappt
`timed-out`/`unavailable` → **`stopped`**. Ein tatsächlich grüner PR endet so als `stopped`.

**Fix (`autoPr.ts:877-900`):** (a) `watched.exitCode === 0 && !watched.timedOut` → `passed`
(der Watch-Exit ist bereits ein terminales Signal); non-zero → einmal nachlesen, um `failed` vs
`cancelled` zu unterscheiden, aber bei grünem Exit **nicht** auf `timed-out` durchfallen. (b) Die
einzelne Nachlese durch eine kurze, begrenzte Poll-Schleife ersetzen (`REMOTE_CI_POLL_MS`/`deps.delay`
sind schon importiert), die bis „nicht-`pending`" oder ein kleines Deadline pollt.

**Test:** `autoPr.test.ts` (`monitorRemoteCi`-Deps-Mock, vorhandenes Muster bei `:74`): `watch`
liefert `exitCode:0`, danach `pending`/leer → Assertion `passed` statt `timed-out`. Engine-Ebene:
`remoteCi.status='passed'` ⇒ Integrations-Task `success`.

### P3 — `esbuild spawn EPERM` wird als needs-work / Modellfehler gewertet (Klassifikations-Lücke)

**Evidenz:** 16 der 80 Retros (v. a. mrn-Serie, 16.–17.07.): fertiger grüner Code endet als
needs-work/Quarantäne, Worker melden BLOCKER. Am 18.07. nicht aufgetreten (die Läufe waren
integrations-, nicht build-lastig) — bleibt aber Backlog-Punkt #4 des bestehenden Plans.

**Code-Ursache:** `GATE_INFRASTRUCTURE_PATTERNS` (`autoPr.ts:29-35`) enthält `command not found`,
`ENOENT`, `cannot find module` — aber **nicht** `EPERM`/`esbuild`. Ein esbuild-EPERM läuft daher
nicht in den Infra-Zweig (`:565-581`), sondern in den needs-work-Zweig (`:583-613`). Zugleich
wertet `judgeWorkerTerminalResult` (`Engine.ts:255-261`) ein selbstgemeldetes `ERGEBNIS: BLOCKER`
als `failureKind:'worker'` (= Modellfehler). **Widerspruch:** Die Retro-Analyse behandelt EPERM
längst als Infra (`src/shared/retro/runAnalysis.ts:28`, `INFRA_FAILURE_PATTERNS`) — die Gate- und
Judge-Schicht aber nicht, sodass die Tasks den infra-ausnehmenden Retro-Zweig nie sauber erreichen.

**Fix:**
1. `autoPr.ts:29-35`: `/(?:^|\W)EPERM\b/i` (und `/esbuild/i`) zu `GATE_INFRASTRUCTURE_PATTERNS`
   hinzufügen → `QualityGateError.infrastructure=true` → Infra-Retry, dann `result:'blocked',
   infrastructure:true` → `Engine.ts:1834` setzt `failureKind:'infrastructure'`.
2. `Engine.ts:233-261` `judgeWorkerTerminalResult`: vor dem BLOCKER-Zweig (`:255`) eine
   esbuild-`spawn EPERM`-Signatur im Worker-Output als `failureKind:'infrastructure'` (recoverable)
   klassifizieren statt `'worker'`. (Alternativ in `headless.ts:155-177` `FATAL_SANDBOX_PATTERN`
   erweitern, das bereits nach `'sandbox'` mappt.)
3. Optionaler Kausal-Fix: `pnpm exec vitest run <datei> --config false`-Fallback im
   `runGatesWithBootstrapRetry` (`autoPr.ts:370-383`), eng auf vitest-Kommandos begrenzt.

**Test:** `autoPr.test.ts:239-258` (vorhandener Infra-Klassifikationstest) um einen
`esbuild … spawn EPERM`-Fall mit `infrastructure:true` erweitern; Gegenprobe: echte Lint-Meldung
bleibt `infrastructure:false`. `asyncDispatch.test.ts` (nahe `:96-105`): BLOCKER + `spawn EPERM`
→ `failureKind:'infrastructure'`.

### P4 — `dependsOn` seedet nicht die Worktree-Base (bestätigter Topologie-Bug)

**Evidenz:** retro-mrqv1blp (18.07.), mrn5qqe4 — abhängige Tasks branchen ohne den
Foundation-Commit; zentraler Typecheck scheitert am unauflösbaren Import.

**Code-Ursache:** `worktree.ts:82-101` (`:93`): `git worktree add -b <branch> <path>` **ohne Base-Ref**
→ jeder Task branched von HEAD, nie vom Dependency-Commit. `dependsOn` steuert nur die
*Scheduling-Reihenfolge* (`Engine.ts:2181-2217`); die Dependency-Commits (`preparedChanges`) werden
erst am Ende zusammengeführt (`Engine.ts:2648`), nie in die abhängigen Worktrees geseedet.
`AgentManager` berechnet `baseCommit` nur als eigenes Worktree-HEAD (`:1235-1240`).

**Fix:** Optionalen Base-Ref durch `createWorktree`/`worktreeIdentity` (`worktree.ts:82`) reichen →
`git worktree add -b <branch> <path> <baseRef>`; im `Engine`/`AgentManager.runTask`
(`AgentManager.ts:455-479`) den Merge-Punkt der Dependency-`preparedChanges` als `baseRef` auflösen.

**Test:** `worktree.test.ts` — `worktree add` wird mit dem übergebenen Base-Ref aufgerufen; plus
Engine-Integrationstest: das Worktree eines abhängigen Tasks enthält die Vorgänger-Datei.

### P5 — Restlücke „hohler Erfolg": `ERGEBNIS: ERFOLG` + 0 Diff bleibt `success`

**Code-Ursache:** `judgeWorkerTerminalResult` bewertet allein anhand des Markers (`Engine.ts:263-267`);
`headless.ts:128-146` matcht nur den String. Die Leer-Diff-Erkennung existiert
(`autoPr.ts:490-493,538-540`; `commitContract.ts:5-7`), stuft aber nicht herab: der
`no-changes`-Zweig (`Engine.ts:1826-1829`) lässt den bereits gesetzten `success` unangetastet.
Zweite Restlücke: bei **non-zero Exit** wird `unconfirmed` nicht gesetzt (`:288-293`), sodass
`gateArbitration` (`:1717`) nicht greift und grüne Gates trotz fertigem Code nicht adoptiert werden
(Quarantäne statt Übernahme).

**Fix:** (a) Im `no-changes`-Zweig (`Engine.ts:1826-1829`): wenn der Erfolg nur über den Marker kam
**und** der Task `expectedFiles` trägt (gesetzt `:2212`), auf `needs-work` mit Finding
`result-contract` herabstufen. (b) `unconfirmed` auch im finalen `error/worker`-Return (`:288-293`)
setzen, wenn `autoPr` + Worktree vorhanden — damit `gateArbitration` unabhängig vom Exit-Code
entscheidet.

**Test:** `multiAgentMode.test.ts` (treibt `ERGEBNIS: ERFOLG` bereits, `:105/:173`) um ein Worktree
ohne Staging erweitern → Task ist **nicht** `success`. Unit: `judgeWorkerTerminalResult` mit
`exitCode:1, isError:true` → `unconfirmed:true`.

### P6 — Permission-Restlücken (der Normalpfad funktioniert bereits)

**Klarstellung:** Die pauschale Retro-These „YOLO erreicht Plan-Worker nicht" ist für den
Frisch-Start **widerlegt** — beide Produktions-Caller (`ipc/register.ts:495`,
`inbox/transferService.ts:287`) starten via `spawnProfileTeam`; `yoloMaster` wird als
`yoloDefault:true` in den `boundProfile` gehoben (`spawnProfile.ts:21-23`) und `Engine.dispatch`
gibt Plan-Workern `yolo=true` (`Engine.ts:1444`). Echte, eng umrissene Restlücken:

1. **Live-Toggle friert ein:** `yoloMaster` wird nur von `spawnProfileTeam` konsumiert; eine
   laufende Session aktualisiert `boundProfile.yoloDefault` nie. → Setter
   `OrchestratorEngine.setYolo(enabled)` (mutiert `boundProfile`), aus dem Spawn-IPC bei
   bestehender Engine aufrufen. Zusätzlich `ensure()`-Discard beheben (`spawnProfile.ts:24-27`;
   `WorkspaceSessionRegistry.ts:118-127` ignoriert das übergebene Profil).
2. **60s-Broker-Deny trifft Non-YOLO-Headless-Worker hart:** Das Singleton
   (`PermissionBroker.ts:209`, Default `timeoutMs=60_000`, `:105`) denyt nach 60s
   (`:181`) und liefert „Orca permission denied or timed out." (`OrcaMcpServer.ts:803`). → `timeoutMs`
   pro Kontext durch `requestDecision`→`open` reichen; 60s nur für interaktive PTY-Prompts,
   Headless länger/deaktiviert.
3. **Kein Push der Tool-Freigabe an den Orchestrator:** `await_plan_approval` deckt nur das
   *Plan*-Review, nicht Tool-Permissions; der LLM erkennt Freigaben nur per Polling. → MCP-Tool
   `await_permission(taskId)` ergänzen, das auf das `'resolved'`-Event des Brokers auflöst
   (`Engine.ts:459-467`).

**Test:** `spawnProfile.test.ts:155` (yoloMaster) um „nachfolgend dispatchter Task erbt yolo=true"
erweitern; Broker-Test mit injiziertem `now` → kein Deny vor konfiguriertem Fenster;
`await_permission`-Test analog `awaitTools.test.ts`.

### P7 — Security-Gate: Entitäts-Kataloge in Nicht-Doku-Quelldateien (schmaler Rest)

**Code-Ursache:** Die Doku-Ausnahme (`securityGate.ts:150-151`, `isDocumentationFile:70-73`) ist rein
pfad-/endungsbasiert. Ein Katalog legitimer Entitätsnamen (`ApiToken`, `TwoFactorSecret`,
OAuth-Routen) in einer `.ts`-Registry/`schema.prisma` ist nicht ausgenommen, matcht die
Surface-Regex (`:35-42`) und fordert Negativtests, die eine reine Inventar-Datei nie liefern kann.

**Fix:** Im Continue-Guard (`:149-160`) zusätzlich (a) konfigurierbare `securityCatalogPaths` (Glob,
`globToRegExp:76-85` existiert) oder (b) rein deklarative Added-Lines (kein `import`/Call/`=>`) als
katalog-ausgenommen behandeln. Secret-Leak-Patterns (`:28-33`) bleiben überall aktiv.

**Test:** `securityGate.test.ts` — `.ts`-Katalog ohne Tests → `findings` leer nach Ausnahme.

### P8 — Planner: Advisory-Feature-Deps werden dem Integrator nicht ergänzt (schmaler Rest)

**Code-Ursache:** Die Auto-Ergänzung fehlender Integrator-Kanten existiert (`planner.ts:253-293`),
`missingDependencies` (`:259-264`) filtert aber auf `criticality === 'required'` — hängt der
Integrator an einer **advisory** Feature-Task, repariert nichts und der Plan kann zu
`invalid_ownership` kollabieren.

**Fix:** `missingDependencies` (`:259-264`) optional auch Advisory-Tasks einschließen (gleicher
`dependsTransitively`-Zyklus-Guard). **Test:** `plannerOwnership.test.ts` analog `:59-82` mit
advisory Feature-Task → Advisory-Kante ergänzt, `usedFallback===false`.

---

## 2. Umsetzungsreihenfolge

| Welle | Punkte | Begründung |
|-------|--------|------------|
| **1 (sofort)** | **P1** (Cherry-Pick-Härtung: fetch + ancestor-skip + Divergenz-Guard), **P2** (CI-Watch-Exit-Code) | Genau die Fehler, die am 18.07. dominieren; P2 ist der billigste Einzelfix mit sofortiger Wirkung (grün statt `stopped`). |
| **2** | **P3** (EPERM-Klassifikation), **P4** (Worktree-Base-Seed) | Beseitigt die zweitgrößte Fehlklassifikation und einen bestätigten Typecheck-Blocker. |
| **3** | **P5** (hohler Erfolg), **P6** (Permission-Restlücken), **P7** (Security-Katalog), **P8** (Advisory-Deps) | Enge Restlücken; je wenige, klar lokalisierte Vorfälle. |

## 3. Messbare Zielgrößen (Review nach ~4 Wochen anhand neuer Retros)

1. Läufe, die trotz vollständig grüner Tasks terminal `error` enden (Cherry-Pick/Integration):
   **18.07.: ≥ 6 → Ziel 0.**
2. Grüne PRs, die als `stopped` enden (CI-Watch ohne terminalen Status): **Ziel 0.**
3. needs-work/Modellfehler mit alleiniger Ursache `esbuild spawn EPERM`: **16/80 → Ziel 0.**
4. Zentrale Typecheck-Fehlschläge wegen fehlender Dependency-Dateien im Worktree: **Ziel 0.**
5. `success`-Meldungen ohne Diff bei Tasks mit `expectedFiles`: **Ziel 0.**

## 4. Umsetzungshinweis

Die Fixes gehören in den **Code-Branch (`DEV`)**, nicht auf den `retros`-Datenbranch. Dieser Brief
liegt bewusst unter `proposals/` (geprüfter Verbesserungs-Brief, der über die Retro-Sync-Pipeline
zurückfließt). Jeder Punkt ist auf minimalen, testbaren Umfang zugeschnitten; die genannten
`file:line`-Anker beziehen sich auf `origin/DEV` @ `17e5313` und sind vor der Umsetzung gegen die
dann aktuelle Spitze zu verifizieren.
