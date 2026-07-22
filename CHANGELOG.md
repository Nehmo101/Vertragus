# Changelog

Alle nennenswerten Änderungen an **Vertragus** (vormals *Orca-Strator*) werden in dieser Datei dokumentiert — rückwirkend bis zum allerersten Commit des Projekts.

Das Format orientiert sich an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/). Da Releases auf dem `main`-Kanal automatisch pro Merge getaggt werden (`v0.1.<N>-main.…`), sind die Einträge nach **Tagen** gruppiert; die zugehörige Tag-Spanne steht jeweils in der Überschrift. Pull-Request-Nummern verweisen auf [github.com/Nehmo101/Vertragus](https://github.com/Nehmo101/Vertragus).

---

## 2026-07-22 — Orca→Vertragus-Vollmigration der internen Bezeichner

### Geändert

- **Interne Bezeichner vollständig auf Vertragus migriert:** `VertragusTask`/`VertragusMcpServer` (inkl. iOS), MCP-Tool-Namespace `mcp__vertragus__*` (Launch-Config und Prompts werden pro Start transient generiert, daher ohne Runtime-Alias), Commit-Präfix `vertragus(<taskId>)`, Integrations-Branch `vertragus/goal-*` unter `.vertragus-worktrees/integration`, Laufzeit-Verzeichnisse `vertragus-mcp`/`.vertragus-runtime`/`vertragus-handoffs`/`vertragus-idea-transfers`, Inbox-Store `vertragus-inbox.json`. Persistierte Altbestände werden beim ersten Start einmalig kopierend übernommen (`legacyAdoption.ts`); kein Legacy-Bestand wird gelöscht. WebSocket-Pairing: kanonisch `vertragus-v1`/`vertragus-bearer.*`, der Desktop akzeptiert die `orca-*`-Familie dauerhaft weiter, Mobile/iOS bieten übergangsweise beide an. Hinweis: In interaktiven Non-Yolo-Claude-Panes werden gespeicherte `mcp__orca__*`-Approvals wirkungslos; die Tools fragen einmalig neu an.

### Behoben

- **`await_plan_approval` fehlte in der Orchestrator-Allowlist:** Der Systemprompt schreibt das Tool vor, aber die strikte `--allowedTools`-Liste (Claude/Kimi) enthielt es nicht — Orchestratoren konnten die Plan-Freigabe nie blockierend abwarten. Ein Invariantentest erzwingt jetzt Set-Gleichheit zwischen registrierten Tools und der Allowlist.
- **Reservierte MCP-Servernamen:** Ein externer MCP-Server namens `vertragus`/`orca`(`-sub`) überschrieb kommentarlos den internen Orchestrator-Server in der generierten Launch-Config. Solche Namen werden jetzt im Editor abgelehnt und beim Launch defensiv übersprungen.

---

## 2026-07-21 — Taskleisten-Hinweis bei Nutzer-Rückmeldung

### Hinzugefügt

- **Taskleisten-/Dock-Hinweis bei ausstehender Rückmeldung:** Solange mindestens ein Profil-Workspace eine Nutzer-Rückmeldung braucht (offenes Plan-Review, offene Subagent-Rückfrage, Multiagent-Lauf im Review; zusätzlich offene Mission-Approvals laut Store-Aggregation), signalisiert Vertragus das am Betriebssystem: unter Windows und Linux blinkt das Taskleistensymbol (`flashFrame`), unter macOS bounce’t das Dock-Icon (`critical`). Der Hinweis startet nur beim Übergang „keine ausstehende Rückmeldung → mindestens eine“ und nur, wenn das Hauptfenster nicht fokussiert ist. Mehrere Auslöser über distinkte Workspaces zählen als **ein** aggregierter Blinkzustand; solange der Zähler > 0 bleibt, startet kein zweites Blinken. Beendet wird der Hinweis durch Fokussieren des Hauptfensters oder wenn der Zähler wieder 0 ist. Ein erneuter 0→>0-Übergang löst danach wieder aus.
  - *Offen:* zugehörige PR-Nummer und Tag-Spanne für die Changelog-Überschrift (Feature noch nicht als Release getaggt; aktueller Stand der Integration: Commit `897f7a77`).
  - *Offen:* Dock-Bounce unter macOS im Integrations-Worktree nicht manuell verifiziert (Implementierung und Unit-Tests vorhanden; Laufzeit unter Windows geprüft).

### Dokumentation

- Handbuch-Abschnitt zum Taskleisten-/Dock-Hinweis (Verhalten, Beendigung, Mehrfach-Auslöser, OS-Unterschied).

---

## 2026-07-19 — Retro-Härtung & Security-Gate-Nacharbeit (v0.1.59 – v0.1.61)

### Behoben

- **Retro-Härtung: sechs nachweislich offene Plattform-Probleme aus 80 Retros behoben** (#113). Grundlage war die Auswertung der Retro-Daten (`proposals/2026-07-18` auf dem `retros`-Branch); jeder Punkt ist mit einem Test abgesichert:
  - *Zentrale Cherry-Pick-Integration* (`autoPr.ts publishAggregate`): `fetch origin/<base>` vor dem Integrations-Worktree schützt gegen veraltete Basen. Bereits enthaltene Commits werden per `merge-base --is-ancestor` idempotent übersprungen, leere Cherry-Picks per `--skip` fortgesetzt statt den ganzen Batch abzubrechen; eine Leer-Integration endet als sauberer No-op. `prepareTaskChange` macht einen Soft-Reset nur noch auf echte Ancestors und verliert keine gelieferten Commits mehr.
  - *Remote-CI-Watch*: Der Watch-Exit-Code gilt als terminales Signal, ergänzt um eine begrenzte Poll-Schleife — grüne PRs enden nicht mehr fälschlich als „stopped".
  - *`esbuild spawn EPERM`* wird als Infrastruktur-Fehler klassifiziert statt dem Modell angelastet.
  - *Worktree-Base folgt `dependsOn`*: Abhängige Tasks branchen vom Dependency-Commit statt von `HEAD` und sehen damit die Foundation-Dateien ihres Vorgängers.
  - *Ergebnisvertrag*: Eine ERFOLG-Meldung ohne Diff trotz `expectedFiles` wird zu `needs-work` herabgestuft.
  - *YOLO erreicht Plan-Worker laufender Sessions*: Live-Setter + Fix des `ensure()`-Discards, damit auch später dispatchte Worker die No-prompts-Policy erben.
- **Security-Gate-Nacharbeit:** IPC- und OAuth-Validierung vervollständigt; Renderer-Bridge an das Rebranding angeglichen.

### Hinzugefügt

- **Spracheingabe-Shortcut** (#110, #111): Das fertige Shortcut-Feature für die Sprachaufnahme wurde konfliktfrei in den aktuellen Stand übernommen (Rekonstruktion von PR #107).

---

## 2026-07-18 — Canvas-First UI-Overhaul & Laufzeit-Blocker (v0.1.51 – v0.1.58)

### Hinzugefügt

- **Canvas-First-Workspace** (#105, #106): Die Canvas wird zum zentralen Control-Center. Umgesetzt in parallelen Subagent-Arbeitspaketen: Canvas-First-Layout, **Orchestrator-Chat direkt in der Canvas**, frei schwebendes **Voice-Overlay** mit App-Wissen, **Voice-Assistent-Pipeline**, zentrale Contracts/Integration sowie eine abschließende Test- und Security-Abnahme.
- **Planungsdokument Canvas-First-UI-Overhaul** inkl. Analyse, warum drei vorangegangene Orchestrierungs-Läufe scheiterten (fehlendes `corepack` im PATH, Permission-Broker verweigerte alle Worker-Writes nach 60 s, YOLO-Master griff nur beim Session-Start).

### Behoben

- **YOLO-Master wirkt zur Laufzeit + Judge-Härtung + Permission-Fail-fast:** `Engine.setYolo` rebindet das Profil, löst offene Permission-Prompts als *allow* auf und gewährt laufenden Workern Auto-Allow (neuer IPC-Kanal `orchestrator:setYoloMaster`). Ein „no-changes"-Abschluss mit abgelehnten Tool-Freigaben wird als Infrastruktur-Fehler gewertet statt als Erfolg. Nach 3 Timeout-Denials in Folge stoppt die Engine den Worker mit strukturiertem Blocker `permission-starved`, statt Budget in Retry-Diagnostik zu verbrennen (zuvor: ~22 min / ~4 USD ohne einen einzigen Write).
- **Node-Toolchain-Auflösung:** `corepack`/`npm`/`npx`/`pnpm`/`yarn` werden neben dem realen `node`-Binary aufgelöst (fnm verlinkt nur `node` in den PATH); ENOENT-Fehler beim Dependency-Bootstrap erhalten einen klaren PATH-/fnm-Hinweis.
- **Modelloptionen im Profil-Editor korrigiert** und vollständig verifiziert (#108).
- **Produktionsmodule des Shortcut-Features** aus Teilcommits bereinigt wiederhergestellt (#109).

### Dokumentation

- Retro-Verbesserungsplan um die drei Läufe vom 18.07. samt umgesetzter Fixes ergänzt; Ausführungs-Blocker als behoben markiert (#104).

---

## 2026-07-17 — Rebranding zu Vertragus, räumliche Canvas & DE/EN-i18n (v0.1.50)

### Geändert — Rebranding (#100, #101, #102)

- **Orca-Strator → Vertragus:** Neue Produktidentität mit VERTRAGVS-Wordmark, **Hound-Logo** (sprintender Windhund mit Verdigris-Linien) statt Wal-Logo und neuem Bronze/Verdigris-Theme (hell: Vellum/Alt-Bronze, dunkel: Graphit/Bronze). Namensherkunft und Gestaltungsregeln in `docs/BRAND.md` dokumentiert.
- **Tolkien-IP vollständig ersetzt** durch gemeinfreie *Divina-Commedia*-Namen: Agenten-Codenamen aus GUIDES/CAST-Pools (`lore.ts`), Workspace-Namen aus Commedia-Orten (Paradiso, Purgatorio, Inferno …) — inklusive Hover-Lore-Tooltips.
- **Migration ohne Datenverlust:** `VERTRAGUS_*`-Env-Flags sind kanonisch (`ORCA_*` bleibt Fallback), `localStorage`-Keys zu `vertragus.*` mit einmaliger Legacy-Übernahme, Config-Datei heißt `vertragus.json` (vorhandene `orca-strator.json` wird beim Start übernommen). Interne Bezeichner (`orca/`-Branches, `window.orca`, `mcp__orca__*`) bleiben bewusst stabil.
- **Terminal-Panes auf die Vertragus-Palette umgestellt** (#101): `XTERM_THEME` spiegelt die neuen Dark-Tokens; das Provider-Login-Terminal zeigte zuvor noch die Legacy-Optik.
- **Letzte Orca-Reste entfernt** (#102): Mobile-PWA (Icon, Palette, Manifest, Paketname `@vertragus/mobile`), Fenster-Hintergrund (alter Navy-Flash beim Start), Tooltip-/Popover-Portale auf das neue Theme, Release-Artefakte `vertragus-*`.
- **Branching auf Single-Trunk umgestellt:** `main` + `retros` statt des bisherigen DEV→main-Modells; CONTRIBUTING/GIT_WORKFLOW neu geschrieben, PR-Template zielt auf `main`.

### Hinzugefügt

- **Räumliche Workspace-Canvas ersetzt das DAG-Listen-Layout:** React-Flow-Board mit Dagre-Auto-Layout, per Drag persistierten Node-Positionen, Status-Puls, Fortschritt und Nutzungsdaten je Task-Karte; Doppelklick fokussiert das Agenten-Pane. Harte Abhängigkeiten als durchgezogene, animierte Kanten, Advisory-Kanten gestrichelt in Bronze, plus **Pfeilspitzen je Kanten-Typ**.
- **Findings-Board als Haftnotizen auf der Canvas:** Von Subagents zur Laufzeit gepostete Befunde (Schnittstelle / Entscheidung / Blocker / Erkenntnis) erscheinen als Vellum-Sticky-Notes mit gepunkteter Kante zum Ursprungs-Task.
- **Live-Terminal-Peek** in laufenden Task-Karten (ANSI-bereinigter PTY-Tail, 1,2-s-Polling) und **Datei-Drop auf Agenten**: eine auf die Task-Karte gezogene Datei wird mit absolutem Pfad ins Agenten-PTY geschrieben.
- **DE/EN-Sprachumschaltung** auf i18next-Basis: Deutsch als Quellsprache, Englisch als erste Übersetzung; Live-Umschaltung ohne Neustart, `ui.language`-Config-Key, DE|EN-Segment in der Titelleiste. In einer zweiten Runde wurden OrchestratorPanel, Sidebar, LimitsPanel, Modals und Panels extrahiert (410 neue Schlüssel).
- **Open-Core-Kurs festgelegt** („die sieben Züge", `docs/ROADMAP_OPEN_CORE.md`): umgesetzt wurden das **Trust-Cockpit** (Ampel-Badge je Task-Node mit ausklappbarem Evidenz-Block: Commit, Preflight, Judge-Begründung, Auto-PR, Remote-CI, offene Findings — Grün nur bei Erfolg *mit* Abschlussnachweis), die **Canvas als Steuerpult** (Kontextmenü mit Pause/Fortsetzen/Fallback) und das **Zwei-Minuten-Wunder** (Playground-CTA füllt die Canvas mit einem Demo-DAG).
- **Voice:** Sprachziel auf Team-Ebene (ausgewählter Agent oder Orchestrator) und Aufnahme-Wellenform.

### Behoben

- SECURITY.md ergänzt und Demo-Fixtures neutralisiert (Vorbereitung auf öffentliche Sichtbarkeit); Workspace-Root-Vergleich kanonisiert (macOS-/Windows-Pfad-Aliase); UI-Smoke an neue Layout-Keys und Popover-Portale angepasst; Legacy-Config-Adoption außerhalb der Electron-Runtime übersprungen (CI-Fix).

---

## 2026-07-16 — Retro-Pakete 1–5, Kimi K3, Permission-Mode & Ideen-Archiv (v0.1.47 – v0.1.48)

### Behoben — Retro-Pakete 1–5 (#85)

Auswertung der Juli-Retros: Von 7 als fehlgeschlagen bewerteten Läufen hatten mindestens 5 ihr Ziel vollständig erreicht — die Fehlurteile kamen von der Plattform, nicht von den Modellen.

- **Paket 1 — Falsche error-Urteile beseitigt:** Ergebnisvertrag toleriert Markdown-Dekoration um den ERGEBNIS-Marker; bei widersprüchlichen Signalen entscheiden die Abnahme-Gates (Gate-Arbitration). Quarantänisierte Teilarbeit, die alle Gates besteht, wird auf dem letzten Versuch als `needs-work`-Commit übernommen statt verworfen. Abgelehnte Pläne verschwinden nicht mehr still, sondern warten mit sichtbaren `validationIssues` am Review-Gate; Ownership-Konflikte werden repariert (Serialisierung per Conflict-Key, Advisory-Kanten) statt den Plan kollabieren zu lassen.
- **Paket 2 — Gate-Infrastruktur zuverlässig:** Worktree-Bootstrap installiert direkt im Worktree und ohne `--ignore-scripts` (pnpm-Monorepos bekommen ihre Workspace-Binaries und Lifecycle-Artefakte). Fehlendes Gate-Tooling zählt als Infrastruktur-Fehler mit einmaligem Bootstrap-Retry. Doku-Dateien sind von der Security-Surface-Heuristik ausgenommen (Secret-Patterns gelten weiterhin überall); das Whitespace-Gate blockiert nicht mehr hart; Scratch-Dateien werden vor zentralen Commits automatisch aus dem Staging entfernt.
- **Paket 3 — Telemetrie-/Learnings-Qualität:** Der Remote-Selftest vergiftet die Learnings nicht mehr (keine Retros/Exporte aus Selftest-Läufen, Bestandsdaten gefiltert); generische Schwäche-Learnings brauchen mindestens 2 auswertbare Tasks; Modellnamen sind durchgängig attribuierbar (Codex-Default aus `~/.codex/config.toml`).
- **Paket 4 — Approval-Feedback ohne Polling:** Neues MCP-Tool `await_plan_approval` blockiert bis zur Panel-Entscheidung; `get_plan_status` liefert den neuen `reviewState`.
- **Paket 5 — at-capacity-Erkennung:** „model/provider at capacity" wird als Limit-Signal erkannt und löst den vorhandenen Retry mit Slot-Wechsel aus, statt lange Tasks terminal sterben zu lassen. Der Retro-Verbesserungsplan (`docs/RETRO_IMPROVEMENT_PLAN.md`) dokumentiert Befunde, Pakete und Backlog.

### Hinzugefügt

- **Kimi K3 als Orchestrator und Subagent** (#99): Moonshots Kimi Code CLI als vollwertiger Provider — Modelle/Presets, interaktive + Headless-Launches, MCP-Adapter (`--mcp-config-file`), Permission-Broker, UI-Theme und Tests.
- **Claude-Permission-Mode** (#89): kompletter Durchstich Modul + CLI + UI + Schema + Threading + Profil-Editor.
- **Ideen-Archiv in der Inbox** (#92): Archivierungslogik als eigenständiges Main-Prozess-Modul, Inbox-/Archiv-Ansichten mit Sortierung und Attribut-Entfernen.
- **Profil-Duplizierung** (#94) mit geteilter Logik, Store-Action und UI; **randomisierte Workspace-Namensgebung**; **`taskSummary`** im Profil-Workspace-Modell (#91); Workspace-Status & Auto-Git (#90).
- **Retro-Pflicht-Gate + symmetrisches Insight-Template** (#93): `await_plan` liefert bei terminalem Lauf einen eingebetteten Retro-Entwurf; das Gate gilt erst als erfüllt, wenn der Orchestrator qualitative Learnings gemerged hat. Je Modell wird ein symmetrisches Stärke/Schwäche-Template emittiert (leerer Slot erlaubt — keine erfundenen Schwächen).
- **Retro-Analyse-Pipeline scharfgeschaltet** (#95): Selbst-Seed + wöchentlicher Workflow; Standard-Analyse-Modell auf `claude-sonnet-5` umgestellt.
- **Bulk-Handoff und Multiagent-Review** für den Orchestrator; eingebettete Codex-Sessions und Handoffs stabilisiert.

### Behoben (weitere)

- Titlebar-Overflow beim 900-px-Fensterminimum (CSS-Kaskaden-Konflikt zwischen Responsive-Guard und Theme, #97); flaky CloudflareAccessVerifier-Signaturtest deterministisch gemacht (~1/256 CI-Fehlrate, #96); „Prompt schärfen" für Codex & Cursor lauffähig; `scripts/**`-Tests in den Vitest-Include aufgenommen (liefen zuvor nie in CI).

---

## 2026-07-15 — Mission Control A–D, blockierende await-Tools & Konsolidierung (v0.1.31 – v0.1.46)

### Hinzugefügt

- **Mission Control — Phasen A bis D umgesetzt:** Vertragus als per Telefon erreichbares Remote-Kommandozentrum. Authentifiziertes Gateway über einen benannten Cloudflare-Tunnel, Geräte-Pairing mit widerrufbaren Hash-Token, Live-SSE-Read-Model, striktes Kommando-Whitelisting, Approval-Inbox aus den vorhandenen Gates und eine mobile PWA; Phase B ergänzte Web-Push, PR-Publication-Hold, abgesicherte Task-Diffs und Voice-Goal, Phase C den Echtzeit-Permission-Broker je Provider, WebSocket-Kanal, Team-Identität via Cloudflare Access sowie Remote-Budgets/Pause.
- **Blockierende `await_*`-MCP-Tools statt Status-Polling** (#82): `await_task`, `await_plan` und `await_any` kehren erst bei terminalem Zustand zurück (Long-Poll mit Timeout sicher unter dem 60-s-MCP-Client-Limit). Zuvor kostete jede Polling-Runde einen vollen LLM-Turn (Latenz + Tokens).
- **Mittelerde-Namen für Workspace-Sessions** (#83): 40 gemischte Orte (Regionen, Städte, Festungen, Landmarken) mit Hover-Lore-Tooltips.
- **Repository-Switcher in der Titelleiste** (#52): ersetzt das Profil-Dropdown; die Repo-Bindung eines Profils wirkt als weicher Default, das aktive Repository ist unabhängig umschaltbar (persistierter Override + zuletzt genutzte Repos).
- **README grundlegend neu strukturiert** (#80): Inhaltsverzeichnis, Mermaid-Architekturdiagramm, Getting-Started, Konfigurations-/Test-/Release-Kapitel, konsistenter Projektstatus.

### Behoben

- **Adaptiv-Modus fächert echt parallel** statt fast immer nur einen Subagenten zu starten: Der Systemprompt drängte einseitig zu Ein-Task-Plänen und auto-generierte Profile leiteten `maxParallel` aus der Rollen-Anzahl statt der Worker-Kapazität ab. Prompt auf beidseitiges Right-Sizing umgestellt, `maxParallel`-Default aus der Summe der Slot-Counts.
- **Orchestrator wird zuerst gespawnt** und Prewarm ist ausfallsicher: Zuvor konnte ein einzelner fehlgeschlagener Worker-Spawn im Vorgewärmt-Modus den gesamten Team-Start abbrechen, bevor der Orchestrator überhaupt erzeugt wurde.
- **Auto-Approve wird an adaptive Worker propagiert**; Quality-Gate-Binaries werden in Worktrees korrekt aufgelöst (`node_modules/.bin` im PATH des Gate-Prozesses); Path-Traversal-Negativtests ergänzt; Workspace-Profil-Löschung repariert und **atomar** gemacht, inkl. IPC-Autorisierung (#75); Workspace-Rückfrageindikator + Sidebar-Reihenfolge integriert (#62); Orchestrator-Handoffs korreliert (#73); Dependency-Bootstrap-Pfade eingegrenzt (#65); Retro-Fehlklassifikationen + Learnings-Widerruf (#60); Plan-Validierung mit Review-Gate für den ersten Auto-Run (#58); plattformübergreifende Integrations-Gates in CI stabilisiert.

### Wartung

- **Großes Aufräumen paralleler Agent-Stände:** Über ein Dutzend überholter bzw. bereits integrierter PRs (#54–#57, #59, #61, #63–#72, #74, #76–#78) wurden nachvollziehbar rekonziliert — jeweils mit explizitem Merge-Vermerk, ob der Stand übernommen, überholt oder bereits enthalten war.

---

## 2026-07-14 — Retro-Sync, Telemetrie, lesbare Panes & CI-Optimierung (v0.1.18 – v0.1.30)

### Hinzugefügt

- **Retro-Sync-Subsystem** (5 Bausteine): GitHub-Contents-Client mit idempotenten Writes und Branch-Guard; Export von Retros/Benchmarks/Learnings als redigierte JSON-Envelopes in einen dedizierten `retros`-Branch mit offline-toleranter Queue; **Learnings-Overlay** („Gelerntes Teamwissen") wird per TTL-Cache in den Orchestrator-Systemprompt injiziert, ohne Launches je auf Netzwerk blockieren zu lassen; Analyse-Skript mit Claude-Synthese und max. 3 ausführbaren Verbesserungs-Briefs; wöchentliche GitHub-Action, deren Ergebnis als Review-PR gegen `retros` geöffnet wird — menschlicher Merge bleibt das Sicherheits-Gate.
- **Auto-Retros, Modell-Learnings und Auto-Benchmark** (#38): Nach jedem terminalen Planlauf leitet die Engine eine Retrospektive ab (Erfolge, Nacharbeit, Fehler, Dauer, Tokenverbrauch je Provider/Modell) und persistiert konservative Erkenntnisse. Neues MCP-Tool `record_retro` für qualitative Modell-Einschätzungen; `list_subagents` liefert gelernte Stärken/Schwächen zurück — der Orchestrator wird über Läufe hinweg besser. Benchmark-Modus lässt dieselbe Aufgabe parallel auf allen Slots laufen und bewertet mit Score/Verdict.
- **„Lesbar"-Modus für CLI-Panes** (#37): Umschalter (global + je Pane) zwischen rohem PTY-Output und einer Klartext-Zusammenfassung dessen, was der Agent gerade tut — abgeleitet aus echtem Orchestrator-/Task-Zustand, nie aus Terminal-Parsing.
- **Live-Telemetrie:** Token/Kosten/Schritte streamen während des Laufs in die Task-Panes (#36) und bleiben nach Abschluss auf den DAG-Task-Karten sichtbar; interaktive Panes erklären ehrlich, warum dort keine Telemetrie verfügbar ist („Telemetrie nur für Tasks").
- **Subagent-Rückkanal & Findings-Board:** Headless-Worker erhalten einen eigenen, per separatem Token abgesicherten MCP-Endpunkt (`report_progress`, `post_finding`, `list_findings`); Subagents teilen Schnittstellen, Entscheidungen und Blocker live mit parallelen Tasks und dem Orchestrator. Das Board wird im OrchestratorPanel angezeigt und übersteht App-Neustarts (Restore mit fortgesetzten Sequenzen).
- **Orchestrator-Trainingskatalog** (#49): typisierte Szenarien von solo bis großem Team mit validierten Referenzplänen, die gegen den echten Plan-Validator getestet werden; menschenlesbares Curriculum in `docs/ORCHESTRATOR_TRAINING_PROMPTS.md`.
- **Mission-Control-Plan** als vollständiges Mehrphasen-Blueprint (A–D) mit Sicherheitsmodell und Abhängigkeitsmatrix; **macOS-Portierung** übernommen und gehärtet; **Auto-Modus für laufende Workspaces** aktivierbar; **Repository-Switcher** in der Titelleiste; **STT-Einrichtung global erreichbar** (Sidebar-Sektion „Sprachsteuerung", ⚙ in der VoiceBar) statt nur tief in der Inbox; **Versionsanzeige** unter dem Wordmark.

### Behoben

- **Dispatch-Engpässe und Kapazitäts-Leaks:** Provider-Gates werden für Headless-Tasks endlich durchgesetzt (abbrechbares Warten, Slot-Freigabe in allen Fehlerpfaden); `Semaphore.release()` respektiert gesenkte Limits; runId-Kollisionen behoben; Snapshot-Persistenz gedrosselt (2-s-Throttle) statt sekündlicher synchroner Settings-Writes; Rollen-Slots werden direkt nach Prozessende freigegeben statt während Gates und CI-Polling blockiert zu bleiben.
- **Worktree-Rollback beim Beenden eines Workspace-Runs** (#34): `removeAll` entfernt die isolierten `.orca-worktrees`-Checkouts und deren Branches — mit hartem Sicherheits-Guard, sodass Haupt-Checkout und Nutzer-Branches nie angefasst werden.
- **„Prompt schärfen" robust gemacht** (#35): fortschrittsbasiertes Idle-Timeout (45 s, Reset bei jedem Provider-Fortschritt) plus absolutes Hard-Limit statt eines festen 30-s-Budgets, das schon durch Warteschlange und CLI-Kaltstart aufgebraucht sein konnte; tolerante JSON-Extraktion bei Preamble/Nachtext des Providers.
- **Codex-Fixes:** entferntes `--ask-for-approval`-Flag (codex-cli 0.144.x kennt es bei `exec` nicht mehr — jeder Worker-Dispatch schlug sofort fehl); Windows-Sandbox auf einem beschreibbaren Root gehalten; Subagent-Ausführung gehärtet.
- **CI-Optimierung** (#40): Doppelläufe auf main-Pushes abgebaut (halbiert die Runner-Zeit pro Merge), Job-Timeouts statt 6-h-Default, serialisierte Release-Läufe, Caching für Electron-Downloads, Short-SHA im Versionssuffix für Rückverfolgbarkeit.
- Quality-Gates in Worker-Worktrees lauffähig gemacht (pnpm-Non-TTY-Purge-Abbruch, `verifyDepsBeforeRun`); `ui.cliReadable` in die IPC-Allowlist aufgenommen (Startup-Fehler nach #37); UI-Smoke/Preflight-Tests stabilisiert.

---

## 2026-07-13 — Prompt-Enhancement, adaptive Orchestrierung & Stabilität (v0.1.6 – v0.1.17)

### Hinzugefügt

- **Sichere Prompt-Verbesserung in der Inbox** (#30): eigenständige Domäne + Integration — Ideen werden vor der Übergabe KI-gestützt geschärft.
- **Adaptive, profilgesteuerte Orchestrierung** und **detaillierte Orchestrator-Aktivitätsanzeige**; geerdete Worker-Namen.
- **Workspace-Branch-Picker**, **Multi-Workspace-Hintergrund-Sessions**, manuelle Agenten-Konfiguration, Vorschau validierter Transfer-Briefings in der Inbox, Modell-Sync mit sichtbarer Provenienz, Beibehalten abgeschlossener Agent-Chats, Wiederverwendung vorgestarteter Profil-Subagenten.
- **Desktop-Härtung und Produktions-Tooling** (u. a. Icon-Generator-Pfadvalidierung, gehärteter Agent-Lifecycle).

### Behoben

- **Sicherheit:** Cursor-Worktree-Trust mehrfach gehärtet (Pfad-Matching, Trust-Dispatch, Watchdog); GitHub-OAuth-Status validiert und Auth-Zustand vereinheitlicht.
- **UI/Stabilität:** Terminal-Flicker beseitigt und Terminal-Updates isoliert (Performance); Git-Tree-Popover sichtbar gemacht; rechte Sidebar scrollbar (#23); schmale Layouts abgesichert; unvollständige Telemetrie gekennzeichnet; Provider-Login-Fenster schließen nach Abschluss; Copy-Aktionen über Fenster hinweg wiederhergestellt; Provider-Pfad-Refresh unter Windows; vollständige Provider-Modellauswahl wiederhergestellt; Auto-PR stabilisiert inkl. Remote-CI-Tracking.
- **CI:** Electron-Sandbox für Linux-UI-Smoke deaktiviert, Windows-Worktree-Pfade kanonisiert, Artefakt-Attestierung bis zur Veröffentlichung des Repos übersprungen.

---

## 2026-07-12 — Provider-Ausbau, Inbox-MVP, Handoff & erste Releases (v0.1.3 – v0.1.5)

### Hinzugefügt

- **Release-Pipeline:** electron-builder-Publish-Konfiguration + GitHub-Actions-Workflow — auf `v*`-Tags werden NSIS-`.exe`, AppImage und `.deb` gebaut und ans GitHub-Release gehängt; Projekt-Checks laufen vor dem Packaging. Cozy-Organic-UI und **Self-Update-Kanal** (#9).
- **GitHub Copilot CLI als Agent-Provider** (#5) neben Claude Code, Codex und Cursor Agent — Registry, Profil-Schema, interaktiver + Headless-Launch, Yolo-Flag, Health-Check und UI-Integration.
- **Externe MCP-Server für alle Agenten** (#10): stdio/http/sse-Transporte, Scoping (alle / nur Orchestrator / nur Subagents), sichere Arg-Builder für Claude und Codex, Manager-Modal in der Sidebar; ohne konfigurierte Server bleiben Launches byte-identisch.
- **Agent-Handoff bei Nutzungslimit** (#6): Nähert sich ein interaktiver Agent einem Limit (heuristische Banner-Erkennung + manueller „⇄ Übergeben"-Button), wird die laufende Arbeit als Markdown-Briefing (Aufgabe, Stand, bereinigter Terminal-Verlauf) an einen frisch gestarteten Agenten übergeben, der im selben Arbeitsverzeichnis exakt dort weitermacht — mit Toast, Warn-Badge und Handoff-Modal.
- **Live-Limits-Panel** („Limits & Nutzung"): pro Provider aktive Agenten gegen ein editierbares Parallelitäts-Budget, aggregierte Tokens und Kosten laufender Agenten; **vollständige Modellkataloge** je Provider als Picker bei frei editierbarem Modellfeld.
- **Ideen- & Artefakt-Inbox (MVP)** mit IPC-Persistenz, **Cloud-Speech-to-Text** (safeStorage-gesicherter API-Schlüssel) und **Idee-zu-Workspace-Transfer** mit Review-gegatetem Planning, stabilen Transfer-IDs, Repo-Readiness-Checks und idempotentem Retry.
- **Strukturierte GitHub-Repo-Bindung + In-App-OAuth-Login** (Discovery, Clone, Remote-Validierung); Auto-PR fällt auf den gebundenen Default-Branch zurück. **Per-Provider-Parallelitätslimits** im Main-Prozess durchgesetzt. **Performance-Presets** (fast/balanced/strong) mit Provider-Mappings und Live-Modell-Discovery.
- **Wilder Tolkien-Namenskast mit Lore-Tooltips** (#2): Helden, Zauberer, Drachen und mehr, jeweils mit deutscher Kurzbeschreibung beim Hovern. **Team-Start** öffnet das ganze Team (Orchestrator + alle Slots × Count) auf einen Klick. **Workspace-Werkzeuge:** „Leeren"-Aktion, Single-Modus (alle Slots parallel ohne Orchestrator), nativer Repo-Picker. Provider-Login-Flows mit Feldhilfen (#4), Projekt-/Branch-Kontext je Workspace (#7).
- **„Wal & Woge"-Logo** als erste eigene Markenidentität (Titelleiste, App-Icons, README).
- **Docs:** zweistufiger Branching-Workflow (feature → dev → main), Audit-Roadmap und Handbuch; adaptive Orchestrierung + Auto-PR ausgeliefert (#1).

### Behoben

- **IPC-Sicherheits-Härtung:** Config-IPC auf öffentliche UI-Keys allowgelistet und `secrets.*` blockiert; STT-Schlüssel auf allowgelistete OpenAI-HTTPS-Endpunkte beschränkt; Datei-Artefakte an Einmal-Picker-Grants gebunden; GitHub-Pfade vor Bind/Clone normalisiert und validiert.
- Transfer-Workflow-Robustheit (Replanning-Sperre, Agenten-Stopp bei Plan-Timeout, PTY-Login-Fallback, Ready-Handshake statt fester Seed-Verzögerung); Profil-Löschung ermöglicht; Terminal-Cursor-Flicker reduziert; Subagent-Task-Timeout entfernt; CI-Runtime auf pnpm 11 ausgerichtet.

---

## 2026-07-11 — Projektstart: Phasen 0–2 (als „Orca-Strator")

### Hinzugefügt

- **Phase 0 — Gerüst:** electron-vite-Scaffold (Main/Preload/Renderer mit typisierter IPC-Bridge), gemeinsame Provider-Registry (claude, codex, cursor, ollama, github, cloudflare) mit Health-Probing, zod-`WorkspaceProfile`-Schema + electron-store-Config, Provider-Dashboard im Ocean-Dark-Theme, MIT-Lizenz und CI-Matrix (Windows + Linux).
- **Phase 1 — Multi-Agent-Workspace mit echten PTY-Terminals:** @lydell/node-pty spawnt die authentifizierten CLIs als interaktive PTYs (plattformübergreifende Kommando-Auflösung inkl. Windows-Shims); xterm.js-Panes mit lückenloser Scrollback-Wiedergabe; rahmenloses Fenster mit eigener Titelleiste (Repo/Branch-Pill, Agenten-Zähler, persistenter Yolo-Master-Schalter, Stop-All mit Bestätigung); Sidebar mit Provider-Health und Profilen; Workspace-Grid mit Pop-out-Fenstern; Profil-Editor (Orchestrator, Subagent-Slots, Arbeitsverzeichnis); **Git-Worktree-Isolation pro Agent** (`.orca-worktrees/<id>`, Branch `orca/<id>`).
- **Phase 2 — Orchestrator-Engine mit In-App-MCP-Dispatch + Task-DAG:** Streamable-HTTP-MCP-Server im Main-Prozess (`set_goal`, `list_subagents`, `dispatch_subagent`, `open_subwindow`); Orchestrator-Agenten starten mit temporärer MCP-Config, Systemprompt und freigegebenen Tools; die Engine besitzt einen Live-Task-DAG, wählt pro Dispatch den passenden Profil-Slot, führt Headless-Subagenten aus (stream-json-Parsing je Provider) und speist Ergebnisse zurück; echtes Task-DAG-Panel im Renderer. Verifiziert durch einen In-Process-MCP-Selftest (8/8 Checks).

### Behoben

- **Erste End-to-End-Erkenntnisse** (12.07. nachgezogen): `codex exec` hing auf offenem stdin-Pipe (Fix: `stdio ['ignore',…]`); alle Slots teilten sich die Rolle „worker", sodass immer nur der erste Slot dispatcht wurde (Fix: eindeutige Rollen je Slot); geratene Modellnamen führten zu API-Fehlern (Fix: freie Modellfelder mit echten Katalogen, leeres Feld = CLI-Default).

---

*Hinweis: Die Versionsnummern folgen dem automatischen main-Kanal-Schema (`v0.1.<Build>-main.<N>[.g<sha>]`); ein Tag entsteht pro Merge auf `main`. Für die Tage vor dem 12.07.2026 existieren keine Tags — diese Einträge sind aus der Commit-Historie rekonstruiert.*
