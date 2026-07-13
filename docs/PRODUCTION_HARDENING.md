# Production Hardening

Stand: 13. Juli 2026

## Desktop-Sicherheitsgrenze

Alle Haupt- und Pop-out-Fenster verwenden Electron-Sandbox, Context Isolation,
deaktivierte Node-Integration und Web Security. Navigation bleibt auf die
gebündelte Renderer-HTML beziehungsweise den konfigurierten Dev-Origin begrenzt.
Externe Fenster werden immer blockiert; nur `https:` und `mailto:` dürfen an den
Systembrowser weitergereicht werden. Eine Content-Security-Policy verbietet
Objekte, Frames, Form-Posts und fremde Skripte.

## Provider-Conformance

Verifizierte Orchestratoren:

- Claude Code über eine temporäre MCP-Konfigurationsdatei,
- Codex über prozesslokale `-c`-Overrides,
- GitHub Copilot CLI über `--additional-mcp-config` und eine enge Orca-Toolliste.

Cursor und Ollama bleiben als Orchestrator deaktiviert. Eine Auswahl in der UI
wird erst ergänzt, wenn prozesslokale Instruktionen, MCP-Anbindung und Tool-
Freigaben durch die Conformance-Tests belegt sind.

## Run-Journal und Diagnoseexport

Agent-Events und Orchestrator-Snapshots werden pro Workspace-Session als JSONL
unter dem Electron-User-Data-Verzeichnis gespeichert. Vor dem Schreiben werden
Secret-, Token-, Cookie-, Authorization-, Passwort- und API-Key-Felder redigiert.
Bekannte Bearer-, OpenAI- und GitHub-Tokenmuster werden auch in Freitext ersetzt.

In der Sidebar exportiert **Diagnose exportieren** den letzten Run des aktiven
Workspace-Profils über einen nativen Speicherdialog. Journalfehler werden
protokolliert, blockieren aber niemals Agent- oder Renderer-Ereignisse.

## Review-Cockpit

Task-Karten zeigen Branch, Commit, Worktree, Abhängigkeiten, Konfliktbereiche,
Auto-PR-Status und PR-Link. Ein Git-Diff wird ausschließlich für den serverseitig
gespeicherten Task-Worktree geladen, ohne Shell, externe Diff-Treiber oder
ungeprüfte Commit-Argumente. Renderer-Payloads sind auf 200 kB begrenzt.

Das Cockpit ist absichtlich read-only. Konfliktauflösung und Commit-Integration
bleiben Aufgabe der automatischen Integrationsphase beziehungsweise des Nutzers.

## Voice-MVP

Die Workspace-Leiste adressiert immer den ausgewählten laufenden Agenten.
Push-to-talk erzeugt eine editierbare Vorschau. **Einfügen** schreibt nur Text;
**Senden** fügt zusätzlich Enter ein. Ein Agentwechsel remountet die Voice-Leiste
und beendet Aufnahme beziehungsweise Transkription. Automatisches Senden gibt es
nicht.

Der aktuelle Provider bleibt der abgesicherte OpenAI-kompatible Cloud-Endpunkt.
Ein lokaler Whisper-Adapter ist weiterhin offen und darf erst mit explizitem
Loopback-Modus, Redirect-Sperre, Hardwareanzeige und deutschem Qualitätskorpus
freigeschaltet werden.

## Automatisierte UI-Abnahme

```powershell
corepack pnpm build
corepack pnpm test:ui-smoke
```

Der Smoke-Test startet das gebaute Electron-Paket mit einem isolierten User-
Data-Verzeichnis und prüft Main-Prozess, Preload-Bridge, Renderer, Sidebar,
Workspace, Titelleiste, Sprache und CSP. CI führt ihn mit `xvfb-run` auf Linux
und nativ auf Windows aus.

## Konfigurationsmigration

Die Konfiguration besitzt eine explizite Schema-Version. Vor der ersten Migration
wird im selben User-Data-Verzeichnis eine zeitgestempelte Sicherung angelegt.
Ungültige Profile werden verworfen, Zod-Defaults ergänzt und eine kaputte aktive
Profilreferenz auf ein gültiges Profil zurückgesetzt.

## Release-Signierung und Provenance

Der Release-Workflow verwendet für Pushes auf `main` und für Tags ausschließlich
folgende **GitHub-Actions-Repository-Secrets**:

| Secret | Zweck im Release-Workflow |
| --- | --- |
| `WIN_CSC_LINK` | Zertifikatsquelle für Windows-Code-Signing; wird nur als `CSC_LINK` an electron-builder weitergereicht. |
| `WIN_CSC_KEY_PASSWORD` | Passwort zur Zertifikatsquelle; wird nur als `CSC_KEY_PASSWORD` an electron-builder weitergereicht. |

Die Werte gehören ausschließlich in GitHubs Secret-Verwaltung. Sie dürfen weder
in `.env`-Dateien, Konfigurationsdateien, Issues, PR-Beschreibungen noch in
Konsolen- oder CI-Debug-Ausgaben erscheinen. Keine echten Werte, Zertifikatsdateien
oder kodierten Varianten in Commits aufnehmen. Der Zugriff auf die Secrets ist auf
die Release-Verantwortlichen zu beschränken und bei Verdacht zu widerrufen oder zu
rotieren.

Pull-Request- und CI-Builds erhalten keine Signing-Variablen. Auch ein manuell
gestarteter Workflow erzeugt mit `--publish never` nur unsignierte Testartefakte.
Fehlen die Secrets bei einem Release, bleibt der Windows-Installer bewusst
unsigniert; der Build darf nicht durch Ersatzwerte oder Klartext-Variablen
repariert werden.

Die in der Workflow-Datei derzeit deaktivierten GitHub Artifact Attestations sind
keine verfügbare Provenance-Zusage. Nach einer expliziten Aktivierung können
veröffentlichte Artefakte so geprüft werden:

```bash
gh attestation verify <installer> -R Nehmo101/Orca-Strator
```

Für einen signierten Installer ist zusätzlich auf einem Windows-Rechner zu
prüfen, dass die Signatur gültig ist:

```powershell
Get-AuthenticodeSignature <installer> | Select-Object Status, StatusMessage
```
