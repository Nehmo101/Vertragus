# Maßnahmenplan: Beseitigung der wiederkehrenden Probleme aus den Retros

**Datenbasis:** 80 Run-Retros (`runs/2026/07/`), 3 Learnings-Snapshots (`learnings/`), Stand 2026-07-18.

**Gesamtbild:** 19 × success, 27 × error, 19 × needs-work, 14 × stopped (1 × ohne Status).
Der überwiegende Teil der 60 nicht-erfolgreichen Läufe scheiterte **nicht an der fachlichen
Modellarbeit**, sondern an Plattform- und Infrastrukturproblemen des Orchestrators: In vielen
error-Retros ist das Feature nachweislich vollständig geliefert und verifiziert (grüne Gates,
Commits vorhanden), der Lauf wurde aber durch nachgelagerte Schritte rot gewertet.

---

## Problemcluster (nach Häufigkeit und Wirkung)

### P0-1 — Permission-Broker/YOLO erreicht Plan-Worker nicht (≥ 19 Retros, Hauptursache der stopped-Läufe)

**Symptome:**
- `profile.yoloDefault` **und** `yoloMaster` gesetzt, trotzdem laufen Plan-Worker in der Restricted-Token-Sandbox; YOLO wirkt nur auf neu gespawnte Teams (`spawnProfileTeam`), nicht auf Plan-Worker einer laufenden Session (retro-mrpjohl2, retro-mrngcim6).
- Claude-Worker laufen ohne skip-permissions: Write/Edit/Bash werden headless mit „Orca permission denied or timed out" abgelehnt (retro-mrnfvncl).
- Permission-Broker: 60s-Timeout → deny für alle Nicht-YOLO-Worker (retro-mrpjohl2, 0/9 Tasks).
- Panel-Freigaben werden dem Orchestrator nicht aktiv zurückgemeldet — kein Event bei Approval, nur Polling über `list_tasks`/`get_plan_status` (retro-mrm259nv).
- QA-Gate-Läufe hängen an interaktiven Bash-Tool-Freigaben ohne Panel-Approval.

**Maßnahmen:**
1. YOLO-Konfiguration (`yoloDefault`/`yoloMaster`) in den Launch-Pfad der **Plan-Worker** durchreichen — nicht nur in `spawnProfileTeam`. Regressionstest: Plan-Worker unter YOLO darf keinen Permission-Prompt erzeugen.
2. Claude-Worker headless grundsätzlich mit passendem Permission-Mode starten (skip-permissions bzw. vorab genehmigte Allowlist), solange sie in einer isolierten Worktree-Sandbox arbeiten.
3. Approval-Events aktiv in den Orchestrator pushen (Event/Statuswechsel statt Polling); bis dahin dokumentiertes Polling-Intervall als Workaround.
4. Broker-Timeout konfigurierbar machen und bei ausstehender Freigabe den Task in einen sichtbaren `waiting-approval`-Zustand versetzen statt still in deny/Timeout laufen zu lassen.

**Erfolgskriterium:** Kein Lauf endet mehr als stopped/error allein wegen verweigerter Schreibrechte bei aktivem YOLO.

### P0-2 — Codex-Sandbox: `esbuild spawn EPERM` blockiert Vitest/Vite-Build (16 Retros)

**Symptome:** Vitest- und Vite-Build-Gates scheitern reproduzierbar in der Codex-Worker-Sandbox an `esbuild spawn EPERM` — fertiger, fachlich grüner Code endet als needs-work/Quarantäne-Commit (u. a. retro-mrn5nmde, retro-mrn5aaxa, retro-mrnheut3, retro-mrn6iq0m). Folgeeffekt: Worker melden BLOCKER trotz grünem Typecheck/Lint.

**Maßnahmen:**
1. Sandbox-Profil so anpassen, dass esbuild sein Binary spawnen darf, oder `ESBUILD_BINARY_PATH` auf ein vorinstalliertes Binary setzen (kein Spawn über den blockierten Pfad).
2. Fallback im Gate-Runner: bei EPERM automatisch `pnpm exec vitest run <datei> --config false` (config-freier Lauf ohne esbuild-Bundling) versuchen, bevor das Gate als rot gilt.
3. Infra-Fehler klassifizieren: Gate-Ergebnis `infra-blocked` einführen, das **nicht** als needs-work/Modellschwäche gewertet wird und die Auto-Retro-Learnings nicht verfälscht.
4. Sandbox-Preflight vor Plan-Dispatch: einmaliger esbuild/vitest-Smoke pro Slot; bei Fehlschlag Slot markieren und Tests zentral (außerhalb der Sandbox) ausführen.

**Erfolgskriterium:** Kein needs-work-Urteil mehr, dessen einzige Ursache `esbuild spawn EPERM` ist.

### P0-3 — Zentrale Auto-Integration: Cherry-Pick-Kollisionen und Base-Divergenz (≥ 8 Retros, dominiert die jüngsten Läufe)

**Symptome:**
- Erneuter Cherry-Pick eines bereits im Arbeitsbaum materialisierten Commits schlägt fehl — drei Läufe in Folge (retro-mrqsh5km, retro-mrqwzi39, retro-mrqjip3y).
- Integrations-Commit kollidiert zentral mit parallel erzeugtem QA-Commit (retro-mrn52aoz, retro-mrqh8tux).
- Stale Base / Base-Divergenz vor PR-Replay nicht geprüft: fachlich grüner Commit ist gegen 23 parallele main-Commits breit konfliktbehaftet (retro-mrqt5wlo, retro-mrqxapm5).
- Required-Basis-Commit ist kein Ancestor des aktuellen HEAD → Folgeplan findet gelieferten Code nicht vor (retro-mrnchpk2).

**Maßnahmen:**
1. Idempotenz-Check vor jedem Cherry-Pick: `git merge-base --is-ancestor` bzw. `git patch-id`-Vergleich — bereits enthaltene/materialisierte Commits überspringen statt erneut anwenden.
2. Semantisch gegen den **aktuellen** Zielbranch integrieren (rebase/merge des Integrator-Stands) statt blindem Replay der ursprünglichen Commit-SHA.
3. Reihenfolge fixieren: Integrator-Commit zuerst zentral übernehmen, **danach** QA/Follow-up-Tasks auf diesem Stand starten (QA gegen parallelen Integrator-Worktree hat Typecheck-Gate und Cherry-Picks gebrochen, retro-mrn5qqe4).
4. Preflight vor Folgeplänen und PR-Publishing: Branchspitze, Base-Divergenz (`git rev-list --count base..origin/main`) und „required commit ist Ancestor" prüfen; bei starker Divergenz Draft-PR vom verifizierten Gesamtcommit statt blinder Konfliktauflösung.

**Erfolgskriterium:** Kein Lauf endet mehr als error, dessen Tasks alle fachlich erfolgreich waren.

### P1-4 — Hohle Erfolge und verletzter Ergebnisvertrag (7 Retros)

**Symptome:**
- Cursor/composer-Worker melden „success" mit 0 Änderungen — nur Selbstvorstellung („Ich bin X, womit soll ich anfangen?"), kein Diff (retro-mrn50sux, retro-mrn52aoz: alle 4 Cursor-Tasks hohl).
- Judge wertet Blocker-Analyse mit „Timer läuft" fälschlich als success/no-changes (retro-mrpirnc8).
- Umgekehrt: Task mit grünen Gates und Erfolgsmeldung wird als error (exit 0) gewertet, 15 Dateien landen in Quarantäne statt Übernahme (retro-mrl5ec4i); `ERGEBNIS:BLOCKER` trotz vollständiger Arbeit wegen Infra-Blockern beim formalen Selbstabschluss (retro-mrn5aaxa).

**Maßnahmen:**
1. Judge härten: `success` erfordert nicht-leeren Diff gegenüber der Task-Base **oder** eine explizite, geprüfte No-op-Begründung; „success + no-changes" bei Implementierungsauftrag automatisch als failed werten und den Task re-dispatchen.
2. Ergebnisvertrag maschinell validieren: `ERGEBNIS:`-Format prüfen; bei Widerspruch zwischen Selbstmeldung und Gate-Realität gewinnt die Gate-Realität (grüne Gates + Diff ⇒ kein BLOCKER; leerer Diff ⇒ kein success).
3. Ergebnisformat- und Gate-Anforderungen standardmäßig in jeden Worker-Prompt injizieren (mehrere Retros fordern das explizit).

**Erfolgskriterium:** Kein „success" ohne Diff mehr in den Retros; keine Quarantäne von Ständen mit grünen Gates.

### P1-5 — Gate-Heuristiken mit False Positives: Security-Vokabular & Whitespace (≥ 8 Retros)

**Symptome:**
- Security-Gate (`missing-oauth-controls`/`missing-secret-controls`) flaggt deterministisch jede Doku, die legitime Security-Entitätsnamen katalogisiert (ApiToken, TwoFactorSecret, OAuth-Routen) (retro-mrm3jl3a, retro-mrm75c35: alle needs-work-Urteile aus zwei Plattformproblemen).
- Commit-Gate `git diff --cached --check` lässt Markdown-/Integrator-Tasks an trailing whitespace/CRLF scheitern — selbst wenn der Prompt Whitespace-Hygiene bereits vorschreibt (retro-mrn6jk6j).
- Temp-/Arbeitsdateien (`.verify-*-tmp.md`) landen im partiellen Commit.

**Maßnahmen:**
1. Security-Heuristik kontextsensitiv machen: Doku-/Katalog-Kontexte (z. B. `docs/`, Markdown ohne Code-Änderung) von der Vokabular-Heuristik ausnehmen oder einen geprüften Kontroll-Nachweis-Mechanismus (Allowlist je Datei) anbieten.
2. Whitespace vor dem Commit automatisch normalisieren (trailing whitespace/CRLF-Fix als Pre-Commit-Schritt im Gate-Runner) statt hart zu scheitern.
3. Erforderliche Security-Controls je berührter Datei automatisch in den Task-Prompt aufnehmen (IPC/OAuth-Oberflächen), damit sie während der Implementierung berücksichtigt werden, nicht erst im Gate.
4. Aufräum-Schritt vor Commit: bekannte Temp-Muster (`.verify-*-tmp.md` u. ä.) ausschließen.

### P1-6 — Plan-Validierung & Task-Branch-Topologie (≥ 5 Retros)

**Symptome:**
- Pläne kollabieren wegen `invalid_ownership` zum Fallback: Integrator muss auch von Advisory-Feature-Tasks abhängen; `src/shared/*` ist komplett Shared-Hotspot (retro-mrl5ec4i, retro-mrl8oij8, retro-mrl8sb6e). Die Fallback-Worker liefern dann zwar, aber der Plan gilt als kollabiert.
- Abhängige Tasks branchen ohne den Foundation-Commit: Modul lag nur auf isoliertem Task-Branch, `dependsOn []` → zentraler Typecheck scheitert am unauflösbaren Import (retro-mrn5qqe4, retro-mrqv1blp).

**Maßnahmen:**
1. Planner-Autokorrektur: fehlende Integrator-Abhängigkeiten auf Advisory-Tasks automatisch ergänzen statt den Plan zu invalidieren; Ownership-Validierung **vor** Dispatch mit klarer Fehlermeldung an den Planer.
2. Hotspot-Regeln (`src/shared/*` ⇒ Integrator) im Plan-Schema dokumentieren und im Planner-Prompt mitgeben, damit gar keine invaliden Pläne entstehen.
3. Worktree-Basis abhängiger Tasks muss die Commits aller `dependsOn`-Tasks enthalten; Preflight: „alle Dependency-Commits sind Ancestor der Task-Base", sonst Dispatch verweigern.
4. Isoliert entworfene Tests erst im Integrationsstand verbindlich machen (nicht als harte Abhängigkeit gegen fehlendes Parallelmodul laufen lassen).

### P2-7 — Slot-Verfügbarkeit und Provider-Kapazität (≥ 4 Retros)

**Symptome:** codex-Slots fallen mitten in der Session auf `available:false` (Sandbox-Runtime-Preflight schlägt fehl) — jeder codex-Task kollabiert zu `invalid_task`/Fallback (retro-mrn6bn75); „Selected model is at capacity" tötet lange Einzeltasks (retro-mrl5ec4i); Claude-QA stirbt am Monats-Spend-Limit (retro-mrn6iq0m).

**Maßnahmen:**
1. Slot-Verfügbarkeits-Preflight unmittelbar vor Plan-Dispatch; bei `available:false` sofortiges Re-Routing auf definierte Ausweich-Slots statt Plan-Kollaps.
2. Kapazitäts-/Spend-Limit-Fehler als transient klassifizieren: Retry mit Backoff bzw. Slot-Wechsel, Recovery-Artefakte (Quarantäne-Übernahme) beibehalten — das funktionierte bereits sauber.

### P2-8 — Zentrale Gate-Umgebung unvollständig (3 Retros)

**Symptome:** `corepack` fehlt im PATH → Pane-Preflight schlägt für alle 9 Tasks fehl, bevor ein Modell arbeitet (retro-mrphz4dw); zentrales Integrations-Gate scheitert an fehlendem eslint/node_modules, obwohl alle Worker-Gates grün waren (retro-mrl8o9dg, retro-mrqxapm5).

**Maßnahmen:**
1. Environment-Preflight für die zentrale Gate-Umgebung (corepack, pnpm install, eslint auflösbar) beim Start jedes Planlaufs; fehlende Werkzeuge automatisch provisionieren.
2. Gate-Parität sicherstellen: zentral laufen exakt dieselben Kommandos in einer Umgebung, die der Worker-Umgebung entspricht.

### P2-9 — Remote-CI-Watch ohne terminalen Status (3 Retros)

**Symptome:** Nach erfolgreichem PR bleibt der Remote-CI-Watch ohne terminales Ergebnis hängen; sonst grüne Läufe enden als stopped (retro-mrn5pdnn, retro-mrqulr14).

**Maßnahmen:** Timeout + Polling-Fallback für den CI-Watch; CI-Status sauber auf terminale Plan-Zustände mappen (CI grün ⇒ success, auch wenn der Watch-Kanal abbricht).

---

## Umsetzungsreihenfolge

| Welle | Maßnahmen | Begründung |
|-------|-----------|------------|
| 1 (sofort) | P0-1 (YOLO/Permissions), P0-2 (esbuild EPERM), P0-3 (Cherry-Pick-Idempotenz + Base-Check) | Beseitigt die Ursachen von grob 2/3 aller nicht-erfolgreichen Läufe; alles Plattformfehler, kein Modellverhalten. |
| 2 | P1-4 (Judge/Ergebnisvertrag), P1-5 (Gate-False-Positives), P1-6 (Planner-Autokorrektur/Branch-Topologie) | Stellt die Verlässlichkeit der Bewertungen und Learnings wieder her — aktuell verfälschen Infra-Fehler die Auto-Retro-Learnings („fehleranfällig bei codex" ist überwiegend ein Sandbox-Artefakt). |
| 3 | P2-7 (Slot-Preflight), P2-8 (Gate-Umgebung), P2-9 (CI-Watch) | Härtung; jeweils wenige, klar lokalisierte Vorfälle. |

## Messbare Zielgrößen (Review nach ~4 Wochen anhand neuer Retros)

1. Anteil der Läufe, die trotz vollständig erfolgreicher Tasks terminal error/stopped enden: **aktuell ≥ 15 von 80 → Ziel 0**.
2. needs-work-Urteile mit alleiniger Ursache `esbuild spawn EPERM`: **aktuell 16 Retros betroffen → Ziel 0**.
3. Läufe, die an Permission-Timeouts scheitern, obwohl YOLO aktiv ist: **Ziel 0**.
4. „success"-Meldungen ohne Code-Diff bei Implementierungsaufträgen: **Ziel 0** (werden als failed re-dispatcht).
5. Auto-Retro-Learnings enthalten keine Modell-„weakness" mehr, deren Ursache als Infra klassifiziert wurde.

## Hinweis zur Datenqualität der Learnings

Die konsolidierten Learnings (`learnings/*.json`) schreiben derzeit Plattformfehler den Modellen zu
(z. B. 16 × „Worker-Versuche scheiterten; Aufgaben wurden auf andere Slots umgeleitet", 5 × „fehleranfällig
bei codex"). Nach Umsetzung von P0-2/P1-4 sollten die betroffenen Einträge neu bewertet oder mit einem
Infra-Flag versehen werden, damit das Modell-Routing nicht auf verzerrten Daten optimiert.
