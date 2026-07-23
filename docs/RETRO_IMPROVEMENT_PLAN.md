# Retro-Analyse & Verbesserungsplan (Juli 2026)

Auswertung der 26 Retrospektiven auf dem `retros`-Branch (Stand 2026-07-15)
plus der Learnings-Snapshots zweier Installationen — und die daraus
umgesetzten Plattform-Verbesserungen.

## Datenlage

- 8 × `success`, 5 × `needs-work`, 12 × `error` (davon 5 × „Remote approval
  selftest"), 1 Ad-hoc-Retro (Mission Control).
- **Kernbefund:** Von den 7 echten Fehler-Läufen erreichten mindestens 5 ihr
  Ziel vollständig. Die `error`-Urteile stammten fast immer von der Plattform
  (Plan-Validierung, Gates, Ergebnisvertrag), nicht von den Modellen.

## Befunde und Ursachen

| # | Retro-Befund (Belege) | Ursache |
|---|---|---|
| 1 | Plan-Kollaps `invalid_ownership` → Silent-Fallback; grünes Ergebnis quarantänisiert, Lauf = error (mrl5ec4i, mrl8oij8, mrl8sb6e) | Validator ersetzte bei jedem Issue den ganzen Plan; rejected-Pfad endete ohne Review/Benachrichtigung; Recovery-Artefakte wurden nie adoptiert |
| 2 | Task „✗ fehlgeschlagen (exit 0)" trotz Erfolgsreport + grüner Gates (mrl5ec4i) | Erfolg erforderte den literalen Marker `ERGEBNIS: ERFOLG`; codex setzt teils `is_error` bei Exit-Code 0 |
| 3 | Zentrales Gate: eslint/prisma nicht gefunden, obwohl Worker-Gates grün (mrl8o9dg, mrl8oij8, mrl8sb6e, mrm75c35) | Worktree-Bootstrap: `--ignore-scripts` (kein `prisma generate`) + nur Top-Level-Symlink (keine Workspace-`.bin` im pnpm-Monorepo) |
| 4 | Security-Gate flaggt Doku deterministisch (mrm3jl3a, mrm75c35) | Vokabular-Heuristik scannte jede Nicht-Test-Datei; keine Allowlist |
| 5 | Whitespace-Gate blockiert Doku-Tasks hart (mrm3jl3a) | `git diff --cached --check` warf einen unklassifizierten Fehler → `blocked` |
| 6 | Temp-Dateien in Commits trotz Prompt-Verbot (mrmixph2, mrm75c35) | Keine Erkennung; `git add --all` committete alles |
| 7 | Modellname fehlt, Learnings unattribuierbar (6+ Läufe) | Slots ohne explizites Modell lieferten `model: ""`; nie aus Provider-Konfig rekonstruiert |
| 8 | Remote-Selftest schlug 5× in ~90 ms fehl und erzeugte Junk-Learning (observations 1→5) | Abnahme lief trotz `autoPr.mode='off'` gegen den Worktree-losen Stub; kein Selftest-Filter in Retro/Export |
| 9 | Auto-Retro-Rauschen „fehleranfällig bei X" aus 1 Beobachtung | Kein Mindest-Task-Floor in der Heuristik |
| 10 | Approval nur per Polling erkennbar (mrm259nv, Nutzer-Feedback) | Kein Event/Tool für den Approve-Übergang |
| 11 | „Selected model is at capacity" killt lange Tasks (mrl5ec4i, mrl8oafq) | `detectLimit` kannte die Formulierung nicht → kein Slot-Wechsel-Retry |

Positiv (erhalten): Advisory-Kanten verhindern Kaskadenabbrüche; das
Findings-Board für frühe Schnittstellenentscheidungen; sehr zuverlässige
Publish-Preflights; explizite Prompt-Verträge (Gate-Heuristik, Whitespace,
No-Git) wirken nachweislich.

## Umgesetzte Maßnahmen

### Paket 1 — Falsche error-Urteile beseitigen
- Ergebnisvertrag tolerant: Marker akzeptiert Markdown-Dekoration; bei
  Exit-Code 0 mit widersprüchlichem Provider-Flag entscheiden die
  Abnahme-Gates (Gate-Arbitration).
- Recovery-Artefakte, die auf dem letzten Versuch alle Gates bestehen,
  werden als needs-work-Commit übernommen (Finding
  `recovered-artifact-adopted`, Metrik `adoptedRecoveryArtifacts`).
- Kein Silent-Collapse mehr: abgelehnte strukturierte Pläne warten mit
  sichtbaren `validationIssues` am Review-Gate.
- Ownership-Reparatur statt Kollaps: Shared-Hotspot-Writer werden per
  `shared-hotspots`-Conflict-Key serialisiert, fehlende
  Integrator-Abhängigkeiten als Advisory-Kanten ergänzt
  (`repaired_ownership`).

### Paket 2 — Gate-Infrastruktur
- Worktree-Bootstrap: echte Installation im Worktree, ohne
  `--ignore-scripts` (Workspace-`.bin`, prisma-Client); Symlink nur noch als
  Fallback für unbekannte Toolchains.
- Fehlendes Gate-Tooling wird als `infrastructure` klassifiziert (ein
  Bootstrap-Retry, kein Modellfehler in Retros).
- Security-Gate: Doku-Pfade vom Surface-Scan ausgenommen; konfigurierbare
  Excludes (`AutoPrConfig.securityGateExcludes`); Secret-Patterns gelten
  weiter überall.
- Whitespace-Befunde werden als needs-work-Finding gerettet statt hart zu
  blocken.
- Scratch-Dateien (`*.origcheck`, `*.check`, `*.c9check`, `.verify-*`,
  `*.bak`, `*.tmp`, `*~`) werden vor jedem zentralen Commit entstaged und
  als Finding `temp-files-removed` gemeldet.

### Paket 3 — Telemetrie- & Learnings-Qualität
- Selftest repariert (kein Abnahme-Block ohne Worktree bei `mode='off'`);
  Selftest-Läufe erzeugen keine Retros/Exporte mehr; Analyse-Pipeline
  filtert Bestands-Selftests und generische 1/1-Zähler.
- „fehleranfällig"-Learnings erst ab 2 auswertbaren Tasks.
- Modellname durchgängig: `resolveSlotModel` liest das Codex-Default-Modell
  aus `~/.codex/config.toml` bzw. liefert `default (codex-config)` statt `""`.

### Paket 4 — Approval-Feedback ohne Polling
- `plan-review`-Event, `reviewState` in `get_plan_status`, neues MCP-Tool
  `await_plan_approval(runId)`.

### Paket 5 — Robustheit
- „at capacity" wird als Limit-Signal erkannt → vorhandener
  rateLimited-Retry mit Slot-Wechsel greift.

## Backlog und nachgelagerte Aktivierung

1. **Modell-Fallback-Liste pro Slot — umgesetzt (2026-07-22).**
   `agentSlotSchema.fallbackModels` (Profil-Editor je Slot); beide
   Engine-Limit-Pfade (Plan-Retry-Loop und `fallbackTask`) laufen die Liste
   auf DEMSELBEN Slot ab, bevor ein Provider-Wechsel greift. Je
   konfiguriertem Fallback-Modell gibt es einen zusätzlichen Limit-Retry —
   ein Lauf stirbt nicht mehr, solange unversuchte Optionen existieren
   (Retro mrl8oafq).
2. **Echte E2E-/Browser-Smokes — UI-Hälfte umgesetzt (2026-07-22).**
   `pnpm run test:e2e` (`scripts/e2e-smoke.mjs`) fährt alle Views gegen den
   geseedeten Test-Store (`scripts/testStore/seed.ts`), screenshottet
   hell/dunkel in zwei Breiten und prüft auf visuelle Überlappungen und
   Content-Duplikate; eigener CI-Job mit Artifact-Upload. Offen bleiben die
   Live-Cloud-Integrationen (cloudflared, Web Push, Access).
3. **Commit-Granularität später Phasen — umgesetzt (2026-07-22).**
   Advisory-Finding `commit-granularity` (gate `commit`) ab >25 Dateien in
   einem einzelnen Task-Commit; blockiert nie. Zusätzlich weist der
   Worker-Kontrakt auf kleinere thematische Commits hin.
4. **Vitest `spawn EPERM` in der Worker-Sandbox — Workaround (2026-07-22).**
   Befund: Der Vitest-Standard-Pool (`forks`) spawnt Kindprozesse, die das
   Restricted-Token der Codex-Windows-Sandbox mit EPERM ablehnt; der
   `threads`-Pool vermeidet `child_process`. Der Worker-Kontrakt
   (`providerExecutionGuidance`) instruiert Codex-Worker jetzt, Vitest
   zuerst mit `--pool=threads --no-file-parallelism` auszuführen; scheitert
   auch das, gilt weiterhin die Infrastruktur-Klassifikation (EPERM zählt
   in Gates und Retro-Analyse nie als Modellfehler). Eine echte
   Sandbox-Lösung (breiteres Single-Root-Env) bleibt Beobachtungspunkt
   (mrla9l8n, mrlafkh9).
5. **Publish-Preflight als Main-Prozess-Feature — umgesetzt (2026-07-22).**
   `autoPr/publishPreflight.ts` prüft vor dem ersten Push zentral:
   Push-Probe (`push --dry-run`, klassifiziert Auth-Fehler),
   Branch-Casing-Kollisionen via `ls-remote` und ahead/behind gegen die
   PR-Basis. Blockierende Befunde brechen mit EINER strukturierten
   Meldung ab statt in Worker-Retry-Schleifen (mrl9*-Serie).
6. **Overlay-/Proposals-Pipeline aktivieren — umgesetzt (2026-07-16).**
   `scripts/retro-analyze.ts` seedet beim ersten schreibenden Lauf vor dem
   Mindestmengen-Gate ein leeres `overlay/learnings.md`,
   `proposals/.gitkeep` und den initialen `state/last-analysis.json`, ohne
   vorhandene Inhalte zu überschreiben. Der aktive Wochen-Cron läuft montags
   06:00 UTC mit `contents: write`/`pull-requests: write` und öffnet einen
   menschlich zu prüfenden PR gegen `retros`. Benötigt wird nur das Repo-Secret
   `ANTHROPIC_API_KEY`; `GITHUB_TOKEN` stellt Actions bereit. Erst der Merge
   des Bootstrap-/Analyse-PRs macht das Overlay für Installationen sichtbar.

## Nachtrag: Verbleibende Audit-Architekturpunkte (2026-07-22)

Nach der ersten Retro-Umsetzung (PR #127: L5, M5, A2-Rest, A3, A1-partiell)
wurden die noch offenen Architekturbefunde aus `audit-report.md` gezielt und
verhaltensneutral abgearbeitet:

- **A8 — Provider-Verhalten konsolidiert (umgesetzt).** Die deklarativen
  Provider-Fakten (Stream-Envelope, `--verbose`, Lokal-Betrieb) liegen jetzt
  als `ProviderDef.headless`/`ProviderDef.runsLocally` auf dem bestehenden
  Deskriptor statt als verstreute `id === 'x'`-Literale in `headless.ts`/
  `auth.ts`. Genuin bespoken Pfade (Codex-Sandbox, Ollama-Ausführung,
  Auth-Status-Parsing) bleiben bewusst als Strategie-Funktionen.
- **A7 — Per-Window-Config-Staleness behoben (umgesetzt).** `config:set`
  broadcastet den gespeicherten Wert als `ev:configChanged`; Sekundärfenster
  (Agenten-Panes, Voice-Overlay) spiegeln geteilte UI-Settings
  (Theme/Density/lesbare Panes) live statt bis zum Reload zu veralten.
  Schleifensicher, da Empfänger nur spiegeln.
- **A6 — Gezielter PTY-Fanout (umgesetzt).** Agenten-Terminal-Chunks gehen nur
  noch an das Hauptfenster und die Pop-out-Pane(s) des jeweiligen Agenten
  (`agentDataTargetWindows`), nicht mehr als Broadcast an alle Fenster.

**Bewusst zurückgestellt — A1-Rest (Engine `dispatch`/`executePreparedPlan`).**
`Engine.ts` hat 105 private Felder; `executePreparedPlan` (~313 Zeilen) und
`dispatch`/`publishPendingChanges` sind zustandsbehaftete Kontrollfluss-Methoden,
die eng an diese privaten Felder gekoppelt sind. Eine Extraktion hätte eine
breitere Schnittstelle als der herausgelöste Code und ließe sich ohne laufende
App (nur mit Unit-Tests) nicht risikoarm gegen den grünen Build absichern — genau
die Warnung des Audits. Die sicheren, puren Cluster wurden bereits in PR #127
extrahiert (`workerContract`, `engineSnapshots`). Der verbleibende Kern sollte
nur mit lauffähiger App und beobachtbarem Verhalten geteilt werden.

## Nachtrag: Canvas-Overhaul-Blocker (Retros mrphz4dw/mrpirnc8/mrpjohl2, 2026-07-18)

Drei aufeinanderfolgende Läufe des Canvas-First-Plans scheiterten an
Plattform-Blockern (Details in
`docs/plans/CANVAS_FIRST_UI_OVERHAUL.md#ausführungs-blocker-stand-2026-07-18`).
Umgesetzte Produktfixes (2026-07-18):

1. **YOLO-Master wirkt jetzt zur Laufzeit** — `Engine.setYolo` rebindet das
   Session-Profil, löst offene Permission-Prompts als allow auf und gewährt
   laufenden Nicht-YOLO-Workern Auto-Allow; der UI-Toggle propagiert über
   `orchestrator:setYoloMaster` an alle Live-Sessions (Lauf 3).
2. **Judge-Härtung** — ein Abschluss ohne Änderungen mit abgelehnten
   Tool-Freigaben wird als `error/infrastructure` mit Blocker
   `permission-denied-no-changes` gewertet statt als success/no-changes;
   abhängige Tasks starten nicht mehr ohne ihre Vorarbeit (Lauf 2).
3. **Fail-fast bei Denial-Stürmen** — nach 3 Timeout-Denials in Folge stoppt
   die Engine den Worker mit Blocker `permission-starved`, statt Budget in
   Retry-Diagnostik zu verbrennen (Lauf 3: ~22 min / ~4 USD ohne Write).
4. **Corepack/PATH-Härtung** — `resolveLaunch` löst Node-Toolchain-Kommandos
   (corepack/npm/pnpm/…) notfalls neben dem realen node-Binary auf;
   Dependency-Bootstrap meldet ENOENT mit klarem fnm/nvm-Hinweis (Lauf 1).
