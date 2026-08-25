Deutsch | [English](TROUBLESHOOTING.md)

# Fehlerbehebung

## Die Erste-Schritte-Karte sagt, es sei keine CLI gefunden worden

Vertragus sucht das Kommando des Providers auf deinem `PATH`. Zwei häufige
Ursachen:

- **Sie ist tatsächlich nicht installiert**, oder für einen anderen Benutzer.
  Führe das Kommando selbst im Terminal aus (`claude --version`); scheitert
  das, findet Vertragus sie auch nicht.
- **Die App wurde unter macOS aus dem Finder oder Dock gestartet.** Eine
  GUI-App erbt einen minimalen `PATH`, nicht den, den deine Shell aufbaut.
  Vertragus liest zum Ausgleich den `PATH` deiner Login-Shell; liegt deine
  CLI an einem Ort, den nur eine ungewöhnliche Shell-Konfiguration
  exportiert, starte Vertragus einmal aus dem Terminal, um das zu bestätigen,
  und lege die CLI dann auf einen normalen Pfad.

Drücke nach dem Installieren ⟳ auf der Karte — sie prüft neu, statt die
gecachte Antwort auszuliefern.

## Eine CLI ist installiert, meldet aber „nicht angemeldet"

Melde dich dort an, wo die CLI es erwartet: in ihrer eigenen
Terminal-Session. Vertragus zeigt das exakte Kommando und kopiert es für
dich, führt aber nie einen Login-Flow für dich aus. Diese Flows öffnen
Browser und zeigen Device-Codes; eine Marionette, die hineintippt, würde beim
ersten geänderten Prompt brechen und könnte dir nicht ehrlich sagen, ob es
geklappt hat.

Manche CLIs bieten überhaupt kein Status-Kommando. Die melden **unbekannt**,
nicht „abgemeldet" — Vertragus rät nicht.

## Der Orchestrator ist als idle markiert

`orchestrator_idle` heißt: Der Prozess lebt, hat aber seit zwei Minuten kein
Tool mehr gerufen. Das ist etwas anderes als ein Absturz, und Long-Polls
lösen es nicht aus — ein geparktes `await_events` zählt als Aktivität.

Meist wartet die CLI auf etwas Unsichtbares: eine Berechtigungsabfrage in
ihrem eigenen Terminal oder ein Modell, das mitten im Zug stehen blieb. Hol
das Fenster nach vorn und sieh nach. Hängt sie wirklich, startet
**Orchestrator ersetzen** auf der Karte einen Nachfolger mit frischem
Kontext, der Team, Queue und Board behält.

## Das Fenster eines Agenten ist gestorben, ohne zu berichten

Die Karte graut den Agenten aus und das Event sagt `confirmed: false` — der
Prozess endete ohne Abschlussbericht. Sein Worktree, sein Branch und alle
Commits überleben; nichts wird automatisch aufgeräumt.

Lies den Terminal-Schwanz über das `read_output` des Orchestrators, oder
öffne den Run-Ordner von der Karte aus und sieh ins Journal. Ist die Arbeit
brauchbar, kette einen neuen Agenten an diesen Branch
(`start_agent{baseBranch}`); wenn nicht, lässt sich das Worktree mit dem
Besen des Panels entfernen.

## `integrate_conflict` — ein Merge wurde verweigert

Der Host hat den Branch eines Agenten in das Worktree eines anderen gemergt
und ist auf einen Konflikt gestoßen. Nichts wurde verändert: Der Merge bricht
ab und das Worktree bleibt sauber — genau das ist der Punkt, denn ein halb
gemergter Checkout ist schlimmer als gar kein Merge.

Das Event nennt die konfliktären Dateien. Beauftrage einen Agenten mit der
Auflösung (gib ihm beide Branches), oder schneide die Arbeit so um, dass die
zwei Agenten nicht mehr dieselben Zeilen anfassen. Der Orchestrator löst
Konflikte nie, indem er selbst Git ausführt.

## Promote verweigert die Arbeit

Promote mergt den Branch eines Agenten in den eigenen Checkout des
Repositorys — und verweigert, solange dieser Checkout dirty ist. Committe
oder stashe deine eigenen Änderungen zuerst. Das ist Absicht: Promote ist die
eine Stelle, an der Agentenarbeit den Branch erreicht, auf dem du wirklich
arbeitest, und sie darf sich nie still mit deinen uncommitteten Änderungen
vermischen.

## Verwaiste Worktrees sammeln sich an

Nichts wird auto-gelöscht — weder Worktrees noch Branches noch
Lauf-Artefakte. Das ist eine Doktrin-Entscheidung: Der Checkout eines
Agenten ist Beweismaterial, bis du etwas anderes entscheidest.

Der Besen des Panels listet Worktrees, die kein lebender Workspace nutzt, und
entfernt nur, was du ankreuzt. Branches bleiben so oder so; lösche sie mit
Git, wenn du mit ihnen fertig bist.

## Wo Lauf-Artefakte liegen und ob man sie löschen darf

Jeder Lauf schreibt nach `.vertragus/runs/<workspaceId>/` in das Repository,
an dem er arbeitet:

| Datei | Was es ist |
| --- | --- |
| `events.jsonl` | das Lauf-Journal — jedes Event, über den In-Memory-Ring hinaus |
| `tasks.json` | der Snapshot des Task-Boards |
| `succession.json` | ein unverbrauchtes Übergabe-Paket, falls eine Succession lief |
| `spill/` | übergroße Tool-Ausgaben, verbatim aufbewahrt statt gekappt |

Alles davon darf nach einem Lauf gelöscht werden. Der Preis ist Gedächtnis:
`search_runs` findet nichts in einem gelöschten Journal, und „letzten Lauf
fortsetzen" hat nichts, woran es anknüpfen könnte.

## Das Handy kann sich nicht koppeln

Der Fernzugriff ist standardmäßig aus und bindet an deine Tailscale-Adresse.
Zeigen die Einstellungen keine Adresse, läuft Tailscale nicht oder diese
Maschine ist nicht in deinem Tailnet.

Der Kopplungs-Token liegt verschlüsselt im Schlüsselbund des Systems. Auf
einer Maschine mit gesperrtem oder fehlendem Schlüsselbund scheitert das
Entsperren — die Einstellungen sagen es. Den Code neu zu erzeugen ist der
einzige Rotationsweg, und er kappt jede bestehende Session sofort.

## Das Panel sieht schwarz aus statt transluzent

Der Glas-Effekt braucht einen Compositing-Window-Manager. Unter Linux ohne
einen solchen (manche nackten X11-Sessions) fällt das Panel auf einen opaken
Hintergrund zurück, statt als unbemaltes Rechteck zu rendern. Zonen-Tiling
ist unter Wayland ebenfalls unzuverlässig, weil Wayland Anwendungen gar keine
absolute Fensterpositionierung gibt — das ist eine Plattform-Grenze, keine
Einstellung.

## Cursor Agent stürzt unter Windows sofort ab

Das Orchestrator-Fenster druckt `Error: node-loader:` / `An Application
Control policy has blocked this file`, danach sagt das Panel, der
Orchestrator sei nicht bereit geworden. Die blockierte Datei liegt unter
`%LOCALAPPDATA%\cursor-agent\versions\…\` und ist ein unsigniertes natives
Addon (`.node`) — häufig `file_service.win32-x64-msvc.node` oder
`merkle-tree-napi.win32-x64-msvc.node`.

Das ist Windows Smart App Control, AppLocker oder WDAC, das das Addon nicht
laden lässt. Vertragus kann die Richtlinie nicht umgehen. Prüfe es außerhalb
des Panels: `cursor-agent` in einem normalen Terminal stirbt genauso.

Was tun:

- **Smart App Control** (Windows-Sicherheit → App- und Browsersicherheit).
  Microsoft dokumentiert keine Ausnahme pro Datei; Ausschalten und
  Neustart ist der Workaround, den sie veröffentlichen. [Cursor führt das](https://forum.cursor.com/t/windows-11-pro-smart-app-control-cursor-agent-fails-to-start-because-merkle-tree-napi-win32-x64-msvc-node-is-blocked/164831)
  auf unsignierte native Module in der Agent-Installation zurück — die zu
  signieren ist Cursors Fix, nicht der von Vertragus.
- **AppLocker / WDAC / Firmen-EDR.** Eine Allow-Regel für
  `%LOCALAPPDATA%\cursor-agent\` beantragen. Defender-Ausschlüsse umgehen
  Application Control nicht.
- Ist Smart App Control schon aus und stirbt ein normales Terminal trotzdem,
  ist das ein Bug der Cursor-CLI. Dort öffnen; der Dump im
  Orchestrator-Fenster reicht als Anhang.

## Pi-Wrap-Fenster bleibt unter Windows leer

Play mit **Agenten über Pi starten** startet einen Prozess, danach bleibt
das Agentenfenster leer und das Kind beendet mit Exit 0 innerhalb weniger
Sekunden.

ConPTY kann `electron.exe` (WINDOWS-Subsystem) nicht anbinden. Der Wrap
startet deshalb PATH-`node` gegen den mitgelieferten CJS-Entrypoint, nicht
Electron-as-node. POSIX bleibt Electron-as-node.

Was tun:

- [Node.js](https://nodejs.org/) installieren, sodass `node` auf dem PATH
  liegt, dann erneut Play. Außerhalb des Panels prüfen: `node -v` in einem
  normalen Terminal.
- Pi braucht weiterhin **eigene** Provider-Keys (`~/.pi/agent` oder
  `ANTHROPIC_API_KEY` / das gemappte Backend). Ein Claude-Code-Login ist
  ein anderer Speicher; die TUI kann "No API key found" zeigen, obwohl MCP
  hängt.
- Den Wrap außerhalb der echten Einstellungen prüfen:
  `node scripts/pi-play-smoke.mjs` startet Electron mit isoliertem userData
  und einem Wegwerf-Repo. Es muss `ok` drucken (TUI + MCP). Es nutzt weder
  `~/.pi` noch Provider-API-Keys.

## Etwas anderes

Öffne ein Issue mit deinem Betriebssystem, der Vertragus-Version (die
Einstellungen zeigen sie), der Provider-CLI und ihrer Version. Ist ein Lauf
beteiligt, ist das Journal im Run-Ordner das Nützlichste, was du anhängen
kannst — es hält jedes Event, das der Orchestrator gesehen hat.
