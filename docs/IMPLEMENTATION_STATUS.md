# Orca-Strator – Umsetzungsstand auf `DEV`

Stand: 13. Juli 2026

Dieser Stand setzt die fünf angeforderten Kernbereiche als zusammenhängenden
Produktpfad um. Die ursprüngliche Audit- und Roadmap-Datei bleibt als historische
Ausgangsbasis erhalten.

## Fertig umgesetzt

### Claude, Codex und GitHub Copilot als Orchestrator

- Claude und Codex besitzen getrennte, verifizierte Provider-Adapter.
- Beide erhalten den lokalen Orca-MCP-Server und dieselbe Orchestrator-Policy.
- Die Codex-Konfiguration wird nur über prozesslokale `-c`-Overrides gesetzt;
  die persönliche Codex-Konfiguration wird nicht verändert.
- GitHub Copilot erhält Orca ausschließlich über `--additional-mcp-config` und
  eine enge Tool-Allowlist. Persönliche Copilot-Konfigurationen bleiben unverändert.
- Cursor und Ollama bleiben Worker. Ein Start als scheinbarer Orchestrator ohne
  Delegationswerkzeuge wird sowohl in der UI als auch in der Runtime verhindert.

### Automatischer Subagent-Planer

- Der Orchestrator kann einen strukturierten `ExecutionPlan` über
  `execute_plan` einreichen.
- Orca validiert Task-IDs, Rollen, Abhängigkeiten, Zyklen, Parallelitätsgrenzen
  und Konflikt-Keys, bevor ein Prozess startet.
- Ungültige Pläne werden vollständig verworfen und sicher auf genau einen Task
  zurückgestuft.
- Der Scheduler respektiert globale Parallelität, Rollen-Kapazitäten,
  Abhängigkeiten und Dateikonflikte.
- Modi: `auto`, `review` und `manual`.
- Im Review-Modus erscheint der Plan vor Ausführung in der Oberfläche und kann
  freigegeben oder abgelehnt werden.
- Headless-Subagents laufen ohne Zeitlimit, bis sie fertig sind oder manuell gestoppt werden.

### Workspace-Auswahl und Session-Sicherheit

- Workspace-Auswahl ist prominent in der Hauptoberfläche und im Profil-Editor.
- Pfade werden beim Speichern normalisiert und validiert.
- Git-Root, Branch, Remote, Default-Branch und Dirty-State werden angezeigt.
- Ein laufendes Team ist an einen Profil-Snapshot und eine UUID-Session gebunden.
- Profilwechsel ändern nur die sichtbare Session. Agents, Headless-Runs und
  Orchestratoren anderer Workspaces laufen im Hintergrund weiter.
- Agent-Listen, Dispatch-Protokoll, DAG und MCP-Aufrufe werden pro Workspace-
  Session geroutet; die Profilleiste zeigt laufende Hintergrund-Workspaces.
- Worktrees und Branches tragen die UUID-basierte Session-ID. Alte Worktrees
  werden nicht still wiederverwendet oder gelöscht.

### Auto-PR

- Modi: aus, Draft nach Checks oder Ready nach Checks.
- Strategien: ein gemeinsamer Goal-PR oder ein PR pro Task.
- Pro Task laufen konfigurierbare Quality Gates, `git diff --check`, Größenlimit
  und Secret-Musterprüfung vor dem Commit.
- Die Aggregation cherry-pickt erfolgreiche Task-Commits in einen separaten
  Integrations-Worktree und führt die Gates erneut aus.
- Kein Force-Push, kein Auto-Merge und kein Push auf `main` oder `master`.
- Fehlende `gh`-Authentifizierung, Konflikte oder rote Gates werden sichtbar als
  `blocked` zurückgegeben; der Arbeitsstand bleibt zur Prüfung erhalten.
- PR-Status und URL werden an Task-DAG und Session-Snapshot zurückgegeben.

### Externe MCP-Server

- Eigene Model-Context-Protocol-Server werden einmal in Orca gepflegt und dann
  an jeden gestarteten Agent angebunden — an den Orchestrator **und** an jeden
  einzelnen Subagenten (interaktiv wie headless), sodass alle deren Tools direkt
  sehen und nutzen.
- Transporte: `stdio` (lokaler Prozess), `http` (Streamable) und `sse`.
- Pro Server konfigurierbar: Name, Reichweite (alle / nur Orchestrator / nur
  Subagents) und ein Aktiv-Schalter.
- Verifiziert für die Claude- und Codex-CLI. Claude erhält die Server über eine
  prozesslokale `--mcp-config`-Datei (ohne `--strict-mcp-config` bei Subagents,
  damit deren eigene `.mcp.json` erhalten bleibt); Codex über prozesslokale
  `-c mcp_servers.*`-Overrides. Die persönliche Provider-Konfiguration wird nicht
  verändert.
- Provider ohne verifizierte MCP-Anbindung ignorieren die Server geräuschlos.
- Ohne konfigurierte Server sind die Agent-Starts identisch zu vorher.

### Cozy Organic Design

- Ein Organic-Look mit persistiertem Hell-/Dunkelmodus über `data-theme`.
- Der Sonne-/Mond-Umschalter sitzt in der Titelleiste.
- Layout: Kacheln, Fokus oder DAG.
- Alle Modi verwenden denselben Komponentenbaum und semantische CSS-Tokens.
- Einstellungen werden gespeichert; reduzierte Bewegung und sichtbare
  Tastatur-Fokuszustände werden berücksichtigt.

### Stabilität und Qualität

- Electron-Fenster laufen mit Sandbox, CSP, Navigationsschutz und Scheme-Allowlist.
- Redigierte Run-Journale lassen sich pro Workspace exportieren.
- Task-Karten besitzen ein read-only Review-Cockpit mit begrenztem Git-Diff.
- Die Voice-Leiste sendet erst nach editierbarer Vorschau an den gewählten Agenten.
- Linux und Windows starten den gebauten Renderer in CI als Smoke-Test.
- Konfigurationsmigrationen erstellen vor Änderungen ein Backup.

- Fehlende CLI, Spawn-Fehler und manuelle Abbrüche lösen den Task immer
  deterministisch auf.
- Zustände unterscheiden `succeeded`, `failed` und `cancelled`.
- Session-Ziel und Task-DAG werden wiederhergestellt; unterbrochene Tasks werden
  nach Neustart als gestoppt markiert.
- Echte Provider-Nutzungswerte werden angezeigt, sofern die CLI sie liefert;
  andernfalls zeigt die UI bewusst „nicht verfügbar“.
- ESLint, Vitest und Pull-Request-CI für Linux und Windows sind eingerichtet.
- Erfolgreiche `main`-Builds veröffentlichen einen fortlaufenden Windows-/Linux-
  Update-Kanal; der Client prüft ihn automatisch und installiert nur nach Klick.

### Provider-Verbindungen und Feldhilfen

- Die Sidebar unterscheidet Installation und Kontoverbindung.
- Login startet ausschließlich den offiziellen CLI-Flow in einem sichtbaren,
  interaktiven Orca-Terminal.
- Unterstützte Flows: Claude, Codex/ChatGPT, Cursor, Ollama Cloud, GitHub und
  Cloudflare Tunnel, sofern die jeweilige CLI installiert ist.
- Orca überträgt keine Tokens über IPC und speichert keine Zugangsdaten.
- Der Profil-Editor erklärt Workspace-, Planner-, Auto-PR-, Orchestrator- und
  Slot-Felder über tastaturerreichbare Tooltips.

## Bewusst noch nicht enthalten

Diese Punkte waren Ideen der langfristigen Roadmap, aber keine Voraussetzung
der fünf Kernfeatures:

- Auto-Merge oder Force-Push
- Remote-Steuerung über Cloudflare
- vollständige interaktive Konfliktauflösung und Merge-Editor
- Wiederverwendung warmer interaktiver Agents als Scheduler-Pool
- automatische Retry-/Replan-Schleifen
- produktiv signierte Installer, solange Zertifikat-Secrets nicht gesetzt sind
- lokaler Whisper-Adapter und deutscher STT-Benchmarkkorpus

## Lokale Abnahme

```powershell
corepack pnpm peers check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build

$env:ORCA_MCP_SELFTEST = '1'
.\node_modules\.bin\electron-vite.CMD preview
Remove-Item Env:ORCA_MCP_SELFTEST
```

Der MCP-Selbsttest deckt Adapter-Capabilities, Toolliste, Einzeldispatch,
Batch-Parallelität, validierte DAG-Ausführung, Abhängigkeiten und den sicheren
Fallback für zyklische Pläne ab.
