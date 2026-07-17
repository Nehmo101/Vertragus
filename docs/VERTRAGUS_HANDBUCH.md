# Vertragus – Handbuch für Nutzung, Entwicklung und Betrieb

Stand: 12. Juli 2026

Dieses Handbuch trennt **heute verfügbar** und **geplant**. Die detaillierte
Weiterentwicklung steht in der
[Produkt- und Technik-Roadmap](./VERTRAGUS_ROADMAP.md).

## 1. Was Vertragus macht

Vertragus startet bereits installierte Coding-Agent-CLIs in einer gemeinsamen
Desktop-Oberfläche. Jeder Agent erhält ein Terminal und – bei aktiviertem
Worktree-Modus – einen eigenen Git-Worktree. In einem orchestrierten Profil
zerlegt ein Orchestrator ein Ziel und delegiert Teilaufgaben über den lokalen
Vertragus-MCP-Server.

Heute belastbar verfügbar:

- Windows-/Linux-Desktop-App
- Claude, Codex, Cursor Agent und Ollama als interaktive Agents
- Claude als technisch angebundener Orchestrator
- parallele Headless-Subagents über `dispatch_batch`
- Workspace-Profile und nativer Ordnerdialog
- Live-Terminals, Taskübersicht, Pop-outs und YOLO-Schalter
- Git-Worktree-Isolation und Provider-Health
- Windows-/Linux-Installer-Builds

Noch geplant oder unvollständig:

- Codex/Cursor/Ollama als echte Orchestratoren
- automatischer, validierter Subagent-Planer
- Auto-PR, Diff-/Merge-Center und Quality Gates
- sichtbare Token-/Kostenwerte und Approval Inbox
- Session-Restore, Design-Presets und Remote-Zugriff

## 2. Voraussetzungen

### Entwicklung

- Git
- Node.js 22.13 oder neuer (erforderlich für das festgelegte pnpm 11)
- Corepack
- die gewünschten Agent-CLIs

Prüfen:

```powershell
git --version
node --version
corepack --version
claude --version
codex --version
cursor-agent --version
ollama --version
gh --version
```

Nur die tatsächlich verwendeten Provider müssen installiert sein. Die CLIs
verwalten ihre Anmeldung selbst; Vertragus speichert keine API-Schlüssel.

### Repository einrichten

```powershell
git clone https://github.com/Nehmo101/Vertragus.git
Set-Location Vertragus
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

Unter Linux sind dieselben `corepack pnpm ...`-Befehle nutzbar.

## 3. Erster Start

1. Vertragus öffnen.
2. Links prüfen, welche Provider als verfügbar angezeigt werden.
3. Über **Workspace-Profile** ein neues Profil anlegen oder ein bestehendes
   doppelklicken.
4. Profilname vergeben.
5. Unter **Working Directory (Repo)** den Workspace eintippen oder
   **Durchsuchen…** wählen.
6. Modus, Orchestrator und Subagent-Slots konfigurieren.
7. **Profil speichern**.
8. Oben **Alle starten** wählen.

Der Pfad in der Titelzeile und der Branch-Chip kontrollieren, welcher Workspace
aktiv ist.

Ein Profilwechsel stoppt keine laufenden Agents. Vertragus schaltet nur die
sichtbaren Terminals, den DAG und das Dispatch-Protokoll um; andere Workspaces
laufen im Hintergrund weiter. Die Profilleiste zeigt deren laufende Agentzahl
als **n aktiv** an.

## 4. Profile richtig konfigurieren

### Orchestriert

Ein interaktiver Orchestrator erhält ein Ziel im Terminal und delegiert über
Vertragus-MCP an die freigegebenen Slots. Der aktuelle Team-Start öffnet zusätzlich
die konfigurierten Slots als interaktive Panes; MCP-Dispatches erscheinen als
weitere Headless-Task-Panes.

**Wichtiger aktueller Stand:** Nur Claude wird mit Vertragus-MCP und dem
Orchestrator-Prompt gestartet. Andere Provider sind im Auswahlfeld sichtbar,
arbeiten derzeit aber wie normale interaktive Agents. Bis Phase B der Roadmap
sollte für reale Orchestrierung Claude verwendet werden.

### Single

Es gibt keinen Orchestrator. Alle Slots werden entsprechend ihrer Anzahl als
interaktive Agents parallel gestartet. Dieser Modus eignet sich für manuelle
Aufteilung oder unabhängige Terminals.

### Slot-Felder

- **Rolle / Label:** Zielname für Delegation, z. B. `backend`, `frontend`,
  `review` oder `docs`.
- **Provider:** Agent-CLI.
- **Modell:** Freitext. Leer soll „CLI-Standard“ bedeuten, soweit der Adapter
  dies unterstützt.
- **Anzahl:** aktuelle Teamgröße und Dispatch-Kapazität dieser Rolle.
- **YOLO:** überspringt Provider-Bestätigungen für diesen Slot.
- **steuerbar:** der Orchestrator darf an diesen Slot delegieren.

Rollen sollten eindeutig und fachlich sein. Zwei Slots mit `worker` werden
intern zwar zu `worker` und `worker-2`, sprechende Rollen ergeben aber bessere
Pläne und verständlichere Logs.

## 5. Ein gutes Orchestrator-Ziel

Ein Ziel sollte Ergebnis, Grenzen und Prüfungen nennen:

```text
Analysiere und behebe den fehlerhaften Checkout-Flow.

Erwartetes Ergebnis:
- Ursache reproduziert und dokumentiert
- minimaler Fix ohne API-Bruch
- passende Unit- und E2E-Tests
- keine Änderungen an Deployment oder Datenbank, außer wenn zwingend nötig

Prüfe Typecheck, Tests und Build. Fasse Änderungen, Risiken und offene Punkte
am Ende zusammen.
```

Der aktuelle Claude-Orchestrator ruft zuerst `set_goal` und `list_subagents` auf.
Für mehrere unabhängige Aufgaben soll er `dispatch_batch` verwenden. Die Anzahl
parallel laufender Tasks ist durch die Slot-Kapazität begrenzt.

## 6. Terminals und Aufgabenansicht

- Jede Kachel ist ein echtes Terminal oder ein read-only Headless-Run.
- Der Pop-out-Button spiegelt eine Kachel in ein eigenes Fenster.
- **Leeren** stoppt nur die Agents des sichtbaren Workspace und entfernt dessen Kacheln.
- Rechts erscheinen Ziel, Tasks und Dispatch-Protokoll.
- `queued` bedeutet Warten auf freie Slot-Kapazität.
- „fertig“ bedeutet, dass der Agent erfolgreich endete; eine unabhängige
  Codeprüfung ist heute noch nicht automatisch garantiert.

Die Fußzeilenwerte für Schritte, Tokens und Kosten sind aktuell Platzhalter.

## 7. Workspace und Git-Worktrees

Standardmäßig versucht Vertragus für jeden Agent einen Worktree anzulegen
(Verzeichnis- und Branch-Name behalten das `orca`-Präfix als internen
Bezeichner, Migration geplant):

```text
<repo>/.orca-worktrees/<agent-id>
Branch: orca/<agent-id>
```

Vorteil: Parallele Agents überschreiben nicht dieselben Dateien im
Hauptcheckout.

Aktuelle Grenzen:

- Worktrees werden beim Stoppen absichtlich nicht gelöscht.
- Änderungen werden noch nicht automatisch verglichen oder zusammengeführt.
- Agent-IDs können nach App-Neustart wiederverwendet werden. Vor produktiver
  Auto-PR-Nutzung muss Phase A der Roadmap umgesetzt sein.

Worktrees manuell prüfen:

```powershell
git worktree list
git branch --list 'orca/*'
git -C .orca-worktrees/task-02 status
git -C .orca-worktrees/task-02 diff
```

Nicht blind löschen. Erst Status und Diff jedes Worktrees prüfen. Die zukünftige
Cleanup-Funktion muss dieselbe Schutzregel erzwingen.

## 8. YOLO sicher verwenden

YOLO deaktiviert Bestätigungen im jeweiligen Provider. Es ist kein Ersatz für
Isolation oder Review.

Empfehlung:

- nur in einem Git-Repository verwenden,
- Worktree-Isolation eingeschaltet lassen,
- keine produktiven Secrets im Prozesskontext,
- keine unklaren oder fremden Prompts,
- vor Push/PR immer Diff und Tests prüfen,
- globalen YOLO-Schalter nur für bewusst begrenzte Sessions aktivieren.

„Alle stoppen“ beendet Prozesse; vorhandene Worktrees bleiben zur Datenrettung
bestehen.

## 9. Entwicklung und Verifikation

### Typecheck

```powershell
corepack pnpm typecheck
```

### Produktions-Build

```powershell
corepack pnpm build
```

### Orchestrator-/MCP-Selbsttest

PowerShell:

```powershell
$env:ORCA_MCP_SELFTEST = '1'
corepack pnpm start
Remove-Item Env:ORCA_MCP_SELFTEST
```

Bash:

```bash
ORCA_MCP_SELFTEST=1 pnpm start
```

Der Selbsttest prüft MCP-Verbindung, Toolliste, eindeutige Rollen,
Einzeldispatch, parallelen Batch-Dispatch und Semaphor-Limits.

### Lint

```powershell
corepack pnpm lint
```

Der Befehl ist im aktuellen Stand **bekannt defekt**, weil ESLint und eine
Konfiguration fehlen. Phase A behebt dies; der rote Lint-Lauf ist bis dahin kein
Beleg für einen Fehler im TypeScript-Code.

### Installer

```powershell
corepack pnpm build:win
corepack pnpm build:linux
```

Windows erzeugt einen NSIS-Installer, Linux eine AppImage- und eine
Debian-Paketvariante unter `release/<version>/`. Installierte Builds prüfen den
`main`-Kanal beim Start und danach regelmäßig. Nur wenn dort ein neuerer Build
vorliegt, erscheint in der Titelleiste der Self-Update-Button. Download und
Installation bleiben eine bewusste Benutzeraktion; laufende Agents müssen vor
dem Neustart gestoppt werden.

## 10. Release-Ablauf

1. Änderungen über `DEV` prüfen und nach `main` übernehmen.
2. GitHub Actions baut bei jedem Push auf `main` Windows- und Linux-Installer.
3. Der Build erhält eine fortlaufende `main`-Kanal-Version und wird als
   GitHub-Prerelease mit Update-Metadaten veröffentlicht.
4. Installierte Clients erkennen den neuen Build und bieten das Self-Update an.
5. Für feste Meilensteine zusätzlich Version und Changelog aktualisieren, Tag
   `v*` erstellen und pushen; Tag-Runs veröffentlichen weiterhin normale Releases.
6. Artefakte auf Update, Start, Provider-Erkennung und Deinstallation prüfen.

Beispiel erst nach grünen Prüfungen:

```powershell
git tag v0.2.0
git push origin v0.2.0
```

## 11. Fehlerdiagnose

### Provider wird als „Fehlt“ angezeigt

1. `<provider> --version` in einem normalen Terminal ausführen.
2. App vollständig neu starten, damit PATH-Änderungen sichtbar werden.
3. Anmeldung mit dem Provider-eigenen Login prüfen.
4. Bei Ollama zusätzlich Daemon und `http://localhost:11434` prüfen.

### Codex-Modell wird abgelehnt

- Modellfeld leeren und den in Codex konfigurierten Standard verwenden.
- Verfügbare Modell-ID in der eigenen Codex-Konfiguration prüfen.
- Modellnamen nicht aus Screenshots oder anderen Konten übernehmen.

### Task bleibt dauerhaft auf „läuft“

Im aktuellen Stand kann dies passieren, wenn eine CLI nicht auflösbar ist.
Agent stoppen, Provider im Health-Panel prüfen und App neu starten. Der dauerhafte
Fix ist P0 in Phase A.

### Branch-/Worktree-Konflikt beim Start

```powershell
git worktree list
git branch --list 'orca/*'
```

Den betroffenen Worktree zuerst auf Änderungen prüfen. Nicht mit `git reset
--hard` oder rekursivem Löschen reagieren, solange ungesicherte Arbeit möglich
ist.

### Orchestrator delegiert nicht

- Aktuell Claude als Orchestrator verwenden.
- Prüfen, ob der Vertragus-MCP-Selbsttest grün ist.
- Prüfen, ob mindestens ein Slot „steuerbar“ ist.
- Rollen aus der Profilkonfiguration verwenden.

## 12. Geplanter Auto-PR-Betrieb

Auto-PR ist noch nicht implementiert. Der sichere Zielablauf:

1. Prompt → validierter Plan
2. eindeutige, frische Task-Worktrees
3. Tasks → Diff und strukturierte Ergebnisse
4. Quality Gates und Review-Agent
5. Aggregation in Goal-Branch
6. Push eines neuen Branches
7. genau ein Draft-PR über `gh`
8. PR-Link und Checks zurück in Vertragus

Bis diese Pipeline umgesetzt ist, müssen Diff, Integration, Commit, Push und PR
manuell erfolgen.

## 13. Dokumentationsregel

Neue Features werden in README und Handbuch erst als „vorhanden“ bezeichnet,
wenn UI, IPC, Main-Prozess und mindestens ein automatisierter Test den kompletten
Pfad abdecken. Geplante Funktionen bleiben sichtbar als geplant markiert.
