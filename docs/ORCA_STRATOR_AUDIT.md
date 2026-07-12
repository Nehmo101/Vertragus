# Orca-Strator – technischer Auditbericht

Stand: 12. Juli 2026
Geprüfter Commit: `d396a0a`

## Prüfumfang

Geprüft wurden Main-/Preload-/Renderer-Architektur, Profile und Config-Store,
Provider-Startargumente, Agent-Lifecycle, Worktree-Logik, MCP-Server,
Orchestrator-Engine, GitHub-Integration, UI sowie Build- und Release-Skripte.

## Verifikation

| Prüfung | Ergebnis |
|---|---|
| `corepack pnpm typecheck` | grün |
| Produktions-Build mit `electron-vite build` | grün |
| `ORCA_MCP_SELFTEST=1` | alle Checks grün |
| `corepack pnpm lint` | rot: `eslint` fehlt |
| Unit-/Komponenten-/E2E-Tests | nicht vorhanden |
| PR-CI | nicht vorhanden; nur Release-Workflow |

Der MCP-Selbsttest belegt Serverstart, Semaphorlimit, Client-Initialisierung,
Toolliste, Zielsetzung, eindeutige Rollen, Einzeldispatch, Result-Routing und
parallelen Batch-Dispatch. Er deckt keine realen Provider-CLIs, Git-Worktrees,
Abbruch-Races oder UI-Flows ab.

## Wesentliche Codebefunde

### Headless-Lifecycle

- `src/main/agents/headless.ts:171` startet eine Promise-Kette ohne Reject-Pfad.
- `src/main/agents/headless.ts:257` setzt `killed`, bevor zwingend ein Prozess
  existiert; ein später aufgelöster Start wird nicht verhindert.
- Folge: hängende Tasks oder verwaiste Prozesse.

### Session-/Workspace-Bindung

- `src/main/orchestrator/Engine.ts:73` liest das aktive Profil global.
- Weitere Reads erfolgen pro Dispatch und beim Öffnen eines Subfensters.
- Folge: UI-Profilwechsel verändert eine bereits laufende Session.

### Worktree-Identität

- `src/main/agents/AgentManager.ts:67` erzeugt nur pro Prozess fortlaufende IDs.
- `src/main/agents/worktree.ts:48-56` leitet Pfad/Branch direkt aus dieser ID ab
  und hängt bei Kollision einen alten Branch wieder ein.
- Folge: Wiederverwendung alter Sessions nach App-Neustart.

### Orchestrator-Capabilities

- `src/main/orchestrator/orchestratorLaunch.ts` gibt für Nicht-Claude-Provider
  leere Extra-Argumente zurück.
- `src/renderer/src/components/ProfileEditor.tsx` bietet trotzdem alle vier
  Agent-Provider als Orchestrator an.
- Folge: UI-Konfiguration verspricht mehr als der Runtime-Pfad leistet.

### Teamgröße versus Dispatch-Kapazität

- `src/main/ipc/register.ts:95` öffnet alle Slot-Instanzen interaktiv.
- `src/main/orchestrator/Engine.ts` verwendet denselben Slot-`count` zusätzlich
  als Kapazität für neu erzeugte Headless-Task-Agents.
- Die bereits offenen interaktiven Agents bearbeiten keine MCP-Tasks und werden
  nicht auf das Scheduler-Limit angerechnet.
- Beispiel: 1 Orchestrator plus 7 Team-Slots kann zusätzlich 7 Headless-Runs
  starten; sichtbar wären bis zu 15 Prozesse statt der erwarteten 8.
- Entscheidung für Phase C: entweder ein Worker-Pool mit wiederverwendbaren
  Agents oder klar getrennte Felder `warmInstances` und `maxTaskConcurrency`.

### GitHub/Auto-PR

- `src/main/integrations/github.ts` implementiert nur `gh auth status`.
- Commit, Push, Base-Branch, Quality Gates, Idempotenz und PR-Erstellung fehlen.
- Die vorhandene Worktree-Struktur ist eine gute Basis, aber ohne Goal-Branch
  und Integrationsschritt noch kein sicherer Auto-PR-Pfad.

### Dokumentations- und UI-Drift

- README nennt Approvals-Inbox und Kosten-/Token-Tracking als Key Features.
- `AgentPane.tsx` zeigt dafür weiterhin Gedankenstriche.
- `Workspace.tsx` enthält beim Fokuslayout nur einen Phase-2-Toast.

## Empfohlene Entscheidungen vor Implementierungsbeginn

1. **Worker-Modell:** Warme interaktive Agents wiederverwenden oder Task-Agents
   immer neu starten? Empfehlung: Task-Runs neu starten, warme Panes optional und
   nicht als Scheduler-Kapazität zählen.
2. **PR-Granularität:** Empfehlung: ein Goal-PR als Standard, Task-PRs nur opt-in.
3. **Planner-Autorität:** Auto als Komfortmodus, `Review first` als sicherer
   Standard bis Planner-Evals stabil sind.
4. **Orchestrator-Support:** Claude und Codex zuerst; weitere Provider erst nach
   bestandenem Capability-Test.
5. **Remote-Funktionen:** hinter Session-Auth, Audit-Log und explizitem Opt-in
   zurückstellen.
