Deutsch | [English](README.md)

<p align="center">
  <img src="build/icon.svg" width="112" alt="Vertragus — ein Windhund in vollem Lauf mit Verdigris-Tempolinien" />
</p>

<h1 align="center">Vertragus</h1>

<p align="center">
  <b>Orchestriere AI-Coding-Agenten parallel</b><br />
  Ein transluzentes Panel, das deine Agent-CLIs als koordiniertes Team fährt
</p>

Vertragus ist ein kleines Always-on-top-Glaspanel. Du definierst **Profile** —
einen Repo-Pfad, eine Orchestrator-CLI (Claude, Codex, Kimi, Cursor, Grok
Build, …) und einen Satz Subagenten-Rollen — und drückst Play. Der
Orchestrator öffnet sich in einem eigenen transluzenten Terminalfenster und
startet **sichtbare** Subagenten-Fenster nach Bedarf. Agenten und Orchestrator
sprechen über einen schlanken In-App-MCP-Server mit echt blockierender
Kommunikation: kein Polling, keine verhungernden Worker.

Der Name ist *vertragus*, das antike gallisch-lateinische Wort für einen
Windhund. Agenten sind nach der Göttlichen Komödie benannt — Orchestratoren
bekommen Führer (Virgilio, Beatrice, …), Subagenten die Figuren (Caronte,
Ulisse, …), Workspaces die Orte (Paradiso, Inferno, …).

> **Status: erster stabiler Meilenstein.** Vertragus funktioniert und ist
> gründlich getestet — rund 1900 Tests, ein Coverage-Ratchet und ein echter
> Electron-Boot-Check auf Windows, macOS und Linux. Es ist auch jung:
> Downloads sind bewusst unsigniert, Releases enthalten keinen macOS-Build,
> und Agenten laufen nicht in einer Sandbox. Diese Grenzen stehen dort, wo
> sie zählen — nicht im Kleingedruckten.

Das Handbuch [`docs/HANDBOOK-HARNESS.md`](docs/HANDBOOK-HARNESS.md)
ist die code-verankerte Karte des Harness-Kerns; serielle Root-Succession
(frischer Kontext, gleiches Team) ist in
[`docs/ORCHESTRATOR-SUCCESSION.md`](docs/ORCHESTRATOR-SUCCESSION.md)
beschrieben.

## Wie ein Lauf funktioniert

Ein **Profil** ist ein Bauplan, kein vorgestartetes Team: ein
Repository-Pfad, ein Orchestrator (Provider, Modell, Effort) und **Slots**
(„ein Reviewer läuft auf Codex, höchstens zwei davon“). **Play** startet
einen Workspace nur mit dem Orchestrator; er entscheidet, welche Agenten er
wirklich braucht, begrenzt durch die Slot-Caps und das profilweite
`maxSubagents`. Der Play-Button klappt ein **Zielfeld** aus — das Ziel wird
über denselben Tastatur-Handshake in den Orchestrator getippt wie jede
Assignment, sodass das, was die Karte zeigt, das ist, was der Orchestrator
wirklich bekommen hat. **Playbooks** sind Ein-Klick-Zielvorlagen auf diesem
Fold-out, nie eine vorkonfigurierte Crew. Das CLI-Fenster öffnet sofort
mit einem Windhund-Overlay, während der Host den Worktree anlegt, MCP
anbindet und auf die Session wartet; der erste Turn geht erst raus, wenn
MCP steht, damit ein Start ohne verbundene Session keine Tokens auf
`await_events` verbrennt.

Im Profil-Editor lässt sich außerdem ein optionaler **System-Prompt pro
Identität** hinterlegen (Orchestrator, Lead, Worker, Tester, …). Ein neues
Profil startet mit kurzen englischen Starttexten (wer den Bericht liest,
gleiche Sprache wie das Ziel, destillierte Übergabe); du kannst sie
ändern, leeren oder wiederherstellen. Jeder Extra-Prompt wird an den
Host-generierten bzw. mitgelieferten Rollen-Prompt angehängt, sodass du
Sprache, Ton und die Art der Rückmeldung steuern kannst, ohne die
Schleife oder den Reporting-Contract zu ersetzen.

Alles, was der Orchestrator kann, läuft über seine MCP-Tools — es gibt
keinen zweiten Pfad:

| Tool | Was es tut |
| --- | --- |
| `start_agent{role, task, model?, providerId?, slotId?, baseBranch?, resultSchema?, taskId?}` | Startet einen Subagenten im eigenen Worktree. Eine explizite Provider-/Slot-Wahl schlägt hart fehl statt still auszuweichen; `baseBranch` kettet auf das Ergebnis eines anderen Agenten; `resultSchema` macht den Abschlussbericht des Agenten zu einem validierten JSON-Objekt; `taskId` claimt einen Board-Task und seedet dessen Subject in die Assignment. |
| `send_to_agent{agentId, text, questionId?}` | Beantwortet die Frage eines Agenten oder gibt eine Folgeanweisung. |
| `await_events{cursor, timeoutSec?}` | Die Hauptschleife: blockieren, bis etwas passiert. Echter Long-Poll, kein Busy-Polling. |
| `list_agents` / `read_output` / `inspect_agent` | Snapshot, roher Terminal-Schwanz und **read-only Git-Fakten** (status/diff/log/file) aus dem Worktree eines Agenten — Verifikation ist Host-Wahrheit, nicht das Wort des Agenten. Übergroße Ausgaben spillen in eine Datei (Preview + Pfad) statt gekappt zu werden. |
| `stop_agent` | Beendet einen Agenten; Dateien, Branch und Worktree bleiben. |
| `integrate_branch{agentId, branch}` | Der eine sanktionierte Merge-Pfad: ein **host-seitiger** Merge in das Worktree des Ziel-Agenten. Konflikte brechen sauber ab und werden gemeldet (`integrate_conflict`); eine Gate-Warnung markiert das Integrieren unverifizierter Arbeit. |
| `ask_user{question, ticket?}` | Fragt den Menschen und blockiert auf die Antwort (Panel-Badge, CLI-Overlay und Handy); Ticket-Resume überlebt den MCP-Request-Timeout. |
| `start_orchestrator{area, task, …}` | Startet einen **Lead** (siehe unten). |
| `record_retro{summary, learnings, repoNotes?}` | Die Lauf-Retrospektive, einmal am Ende. |
| `request_succession{reason, …}` | Ersetzt einen kontextvollen Root durch einen Nachfolger, der dasselbe Team, dieselbe Queue und dieselben offenen Fragen behält. |
| `task_create` / `task_update` / `task_list` | Das geteilte **Task-Board**: Host-Zustand mit CAS-Revisionen, `blockedBy`-Abhängigkeiten und Ownership. Es überlebt Succession und Resume — der Plan lebt auf dem Host, nicht im Modell-Kontext. |
| `search_runs{query, maxResults?}` | Volltextsuche über die vergangenen Lauf-Journale dieses Repositorys — das institutionelle Gedächtnis des Roots. |

Subagenten melden zurück mit `report_done` / `ask_orchestrator` /
`report_progress`. Jeder Task trägt einen **Contract**, den die MCP-Schicht
anhängt, sodass kein Spawn-Pfad einen Agenten erzeugen kann, der nie
berichtet. CLIs ohne MCP-Unterstützung (z. B. Ollama) sprechen stattdessen
einen **Sentinel-Dialekt** — echo-sichere Marker-Zeilen, aus der PTY geparst,
dieselben Events, dieselbe Fragen-Registry.

Lifecycle, Fragen, Fortschritt, Integration und Budget kommen alle als
typisierte **Events** (neunzehn Arten) auf einer Per-Workspace-Queue mit
Cursors an; der Ring behält die letzten 1000, das On-Disk-Journal alles.

## Git-Isolation — und wie Arbeit zurückkommt

- **Jeder Agent bekommt ein eigenes Worktree und einen `vertragus/*`-Branch**
  — parallele Agenten (und parallele Workspaces auf demselben Repo)
  zertrampeln einander nie. Nichts wird auto-gelöscht; der Besen des Panels
  listet verwaiste Worktrees zum expliziten Aufräumen.
- **Worker committen nie.** Wenn ein Agent fertig meldet, snapshotet der Host
  sein dirty Worktree in einen Commit auf dem Branch des Agenten (gepinnte
  Committer-Identität, `--no-verify`, kein Push) und hängt Host-Fakten —
  Branch, HEAD, geänderte Dateien, Diffstat — an das `agent_done`-Event.
- **Handoffs sind Pakete, keine Prosa.** `start_agent{baseBranch}` fügt den
  eigenen Bericht, Status und die Dateiliste des Vorgängers zwischen Task und
  Contract ein, mit der stehenden Anweisung, gegen den Checkout zu
  verifizieren.
- **Promote ist ein menschlicher Klick.** Das Mergen des Endergebnisses in
  den eigenen Branch des Repositorys passiert vom Panel aus (und verweigert
  einen dirty Main-Checkout); der Orchestrator führt selbst nie Git aus, und
  die Remote-Allow-List hat bewusst kein Promote-Verb.
- **…außer du entscheidest einmal statt jedes Mal.** Das Band
  **Automatisierung** im Profil macht aus diesem Klick eine Einstellung:
  jeden sauber fertiggemeldeten Agenten-Branch in den Worktree des
  Orchestrators und/oder in das Checkout des Repositorys übernehmen — und
  am Ende der Arbeit automatisch den **Pull Request** des Laufs öffnen (bei
  `record_retro` oder wenn du den Workspace stoppst). Alles ist
  standardmäßig aus und läuft über dieselben Host-Merges mit denselben
  Ablehnungen; gepusht wird mit `git push -u` (nie `--force`), geöffnet mit
  der GitHub-CLI — kein `gh`, kein Problem: Die Karte zeigt dann den
  fertigen Compare-Link.

## Der Mensch bleibt im Loop

- **Steuern:** Ein Composer auf jeder Workspace-Karte (Panel und Handy)
  sendet eine `user_message`, die das `await_events` des Orchestrators sofort
  weckt. Optional adressierst du einen Worker, Lead oder Helper; der Host
  liefert weiter auf der Root-Queue und bittet den Orchestrator um Relay,
  wenn der Adressat kein Direktkind ist. Der Text erscheint display-only in
  seinem Terminal — die Zustellung ist das Event, es gibt also kein zweites
  Hirn, das in die TUI tippt.
- **Das Ziel darf nachkommen.** Ein ohne Ziel gestarteter Lauf hat einen
  Orchestrator, der an seinem Prompt wartet — deshalb ist die Zeile „kein
  Ziel“ auf der Karte ein Feld (Panel und Handy): Der Text darin wird über
  denselben Handshake wie das Start-Ziel zum ersten User-Turn des
  Orchestrators. Ein Lauf, der bereits ein Ziel hat, lehnt ein zweites ab —
  dafür gibt es das Steuern.
- **Fragen in beide Richtungen:** Die offene Frage eines Agenten erscheint
  als `?`-Badge, beantwortbar von Panel, Handy oder dem CLI-Overlay (ein
  Host-Pfad, eine Fragen-Registry); das `ask_user` des Orchestrators
  erscheint auf der Workspace-Karte und der Orchestrator-CLI genauso.
- **Idle-Watchdog:** Ein Orchestrator-Prozess, der lebt, aber seit zwei
  Minuten keine Tools mehr ruft, wird auf der Karte und im Remote-Client
  markiert (`orchestrator_idle`) — unterschieden vom Prozess-Tod, und
  Long-Polls erzeugen keine False-Positives.
- **Subagenten-Policy-Stufen** (`yolo` / `ask-user` / `ask-orchestrator`)
  regeln, wie weit Agenten eigenständig handeln — siehe das Threat-Model
  unten.

## Skalierung und Ausdauer

- **Leads (Tiefe 1, opt-in):** Der Root kann Sub-Orchestratoren starten, die
  je einen Bereich mit eigenem Team und eigener Event-Queue besitzen. Fan-in
  ist der Punkt: Die Events eines Unterbaums fluten den Root nie, Enkel sind
  für ihn unsichtbar, Leads sprechen nie miteinander, und die Agenten eines
  sterbenden Leads werden an den Root reparented (`subtree_adopted`). Der
  Host nestet nie automatisch.
- **Worker-Helper (eine Extra-Ebene):** Ein MCP-Worker darf bis zu drei
  Helper per `start_agent` für eine isolierte Scheibe starten. Helper-Events
  bleiben in der Nest-Queue dieses Workers — der Orchestrator inspectet den
  Worker, nicht die Helper. Helper dürfen nicht spawnen. Lead-startet-Lead
  bleibt verboten.
- **Succession:** Wenn der Kontext des Roots vollläuft, übergibt
  `request_succession` denselben Workspace — Team, Queue, offene Fragen — an
  einen Nachfolger mit frischem Kontext; der alte Orchestrator-Token wird
  rotiert, sodass der Vorgänger beim Cutover ausgesperrt ist.
- **Laufzeit-Budget:** `maxRuntimeMin` ist eine Wanduhr über Agent-Sekunden
  (nie ein geratener Token-Zähler): Warnung bei 80 %, keine neuen Starts nach
  Verbrauch.
- **Journal & Resume:** Jedes Event eines Laufs wird an
  `.vertragus/runs/<id>/events.jsonl` (plus eine `meta.json` mit Ziel und
  Identität) im Repository angehängt. „Letzten Lauf fortsetzen“ im
  Play-Fold-out startet einen **neuen** Orchestrator, gebrieft über den
  vorherigen Lauf — seine Agenten, Branches und Berichte. Ehrlich
  eingegrenzt: Worktrees und Branches überleben und können via `baseBranch`
  gekettet werden; Prozesse und offene Tickets nicht, und das Briefing sagt
  das.
- **Gedächtnis:** Jeder Lauf endet in einer Retrospektive — Stärken und
  Schwächen je Modell steuern die künftige Modellwahl, dauerhafte
  **Repo-Notes** speisen das Briefing des nächsten Orchestrators (neben dem
  Projekt-Doc und dem jüngsten `git log`), und beides ist in der Retro-Ansicht
  des Panels einsehbar und löschbar. Kein RAG, kein Index.

## Provider

Provider-Presets liegen bei für **Claude Code, Codex, Kimi, Cursor Agent,
Grok Build und Ollama**; eigene Provider sind Daten, kein Code — Kommando,
Args, Modell-/Effort-Flags, Yolo-Flags, MCP-Attach-Dialekt,
System-Prompt-Zustellung. Der In-App-MCP-Server ist loopback-only mit
Per-Identität-Tokens (Orchestrator / Lead / Subagent), und jede CLI wird über
ihren eigenen verifizierten Dialekt angebunden: eine strikte transiente
Config-Datei (Claude), prozesslokale `-c`-Overrides (Codex) oder eine
gemergte Projekt-Datei im Worktree des Agenten (Kimi, Cursor, Grok —
token-tragende Dateien bleiben aus der Git-Historie des Nutzers heraus).
Orchestratoren und Leads laufen auf einer strikten Tool-Allow-List; Worker
laufen unbeschränkt — ihre Disziplin ist der Contract, kein Tool-Käfig.

**Pi ist kein siebter Provider.** Ein Settings-Schalter (standardmäßig aus)
kann den Spawn wrappen, sodass der Prozess die Lockfile-`pi`-CLI ist,
während die Slots weiter Claude, Cursor, Codex, Kimi, Grok oder Ollama
heißen: das Preset wird auf Pis `--provider` gemappt, das Modell des Slots
auf `--model`. MCP hängt über `.pi/mcp.json` und den gepinnten
`pi-mcp-adapter`. Cursors nächstes Pi-Backend ist `github-copilot`; Ollama
hat kein Pi-Backend, daher nur `--model`. Wirkt beim nächsten Play.
Dependabot erlaubt nur diese zwei Pakete (kein Automerge); PATH-`pi` ist
der Fallback, wenn das Paket fehlt.

Ein Slot kann **zusätzliche MCP-Server** deklarieren
(`extraMcp: [{name, url}]`), die seine Agenten zusätzlich zu Vertragus
anbinden — nur Subagenten, nie der Orchestrator oder ein Lead, und der
Name `vertragus` ist reserviert, damit nichts den Reporting-Kanal
überschatten kann. Extra-MCP bleibt der Pfad für einen
Drittanbieter-Tool-Server. Das echte Chromium des Nutzers zu fahren ist
First-Party (siehe unten).

## Chromium-Erweiterung

Eine ungepackte Manifest-V3-Erweiterung paired mit dem Panel, damit ein
Worker eine laufende Web-App in den Tabs testen kann, die du schon offen
hast. Derselbe MCP-Listener, Pfad `/browser`, Loopback-Token — kein
zweiter MCP-Server. Worker rufen `browser_*`-Tools; eine getrennte
Erweiterung ist ein Tool-Fehler, nie ein stilles Überspringen. Laden
unter **Einstellungen → Browser-Erweiterung**. How-to:
[`docs/CHROMIUM-EXTENSION.md`](docs/CHROMIUM-EXTENSION.md).

## Desktop-Feinheiten

Transluzente, theme-bewusste Fenster mit einstellbarem Glas; Fensterfarben je
Rolle, passend zu den Status-Punkten des Panels; **Zonen** je Profil, die
Rollen-Fenster an Bildschirmregionen pinnen; ein globaler
Alles-ausblenden-Hotkey; Autostart und ein Self-Updater mit
Stable/Main-Kanalwahl; deutsche und englische UI.

## Fernzugriff (Tailscale)

Vertragus lässt sich vom Handy oder einem anderen Browser steuern, während
es auf deinem PC läuft. Es ist **standardmäßig aus**; aktiviere es unter
**Einstellungen → Fernzugriff**.

- **Transport ist dein Tailnet.** Der Remote-Server bindet standardmäßig an
  die automatisch erkannte [Tailscale](https://tailscale.com)-Adresse der
  Maschine (`100.64.0.0/10`). Der Traffic ist von Tailscale Ende-zu-Ende
  WireGuard-verschlüsselt, Vertragus fügt also kein TLS hinzu und öffnet
  keinen Port ins öffentliche Internet. `0.0.0.0` (alle Interfaces,
  einschließlich deines LANs) ist hinter einer expliziten getippten
  Bestätigung verfügbar — nutze es nur, wenn du die Exposition verstehst.
- **Kopplung.** Das Aktivieren erzeugt einen 256-Bit-Pairing-Token, angezeigt
  als QR-Code und Link. Wer ihn auf einem Gerät im selben Tailnet scannt,
  tauscht den Token gegen eine Session; der Token wird verschlüsselt
  gespeichert (Electron `safeStorage`) und, damit der QR auch ohne
  Schlüsselbund einen Neustart überlebt, in einer 0600-Datei unter userData.
  Ihn neu zu erzeugen ist der einzige Weg, den Link zu ändern — es trennt
  jedes gekoppelte Gerät. Das Handy behält den Pairing-Token zusätzlich in
  `localStorage` und mintet still eine neue Session, wenn der Desktop neu
  gestartet ist.
- **Was ein Remote-Gerät kann.** Jedes Agenten-Terminal live ansehen,
  hineintippen, einen Workspace **mit Ziel** starten (der Host seedet es über
  denselben Handshake in den Orchestrator wie jede Assignment; Starten ohne
  Ziel bleibt erlaubt und die Karte sagt „kein Ziel — der Orchestrator
  wartet“ — und bietet das Feld, das es nachträgt), Workspaces stoppen, dem
  Orchestrator eine Steuernachricht senden und **die offene MCP-Frage eines
  Agenten** über dessen `?`-Badge beantworten. Die Kommando-Allow-List sind
  exakt sieben Verben: `workspaces:list`, `workspaces:start`,
  `workspaces:goal`, `workspaces:stop`, `profiles:list`, `answer_question`,
  `user_message`. Es gibt kein `focus_agent` oder
  `stop_agent` auf dem Gateway. `answer_question` nimmt denselben Host-Pfad
  wie das `send_to_agent{questionId}` des Orchestrators, löst also den
  geparkten `ask_orchestrator`-Wait (und stellt Sentinel-Antworten in die PTY
  des Agenten zu) — eine Fragen-Registry, eine Wahrheit. Tippen in eine rohe
  PTY erreicht weiterhin nur die CLI (Permission-Dialoge leben dort). Ein
  Remote-Gerät kann **nicht** Profile, Provider oder Einstellungen
  bearbeiten, Fenster oder Zonen anfassen, Worktrees entfernen oder Branches
  promoten.
- **Threat-Model — lies das.** Standardmäßig laufen Subagenten im YOLO-Modus
  (`--dangerously-skip-permissions`). **Ein gekoppeltes Gerät hat damit
  Code-Ausführung auf deinem PC über die Agenten, die es steuert.** Kopple
  nur Geräte, denen du die Maschine selbst anvertrauen würdest. Die
  Einstellungen listen verbundene Geräte und lassen dich jedes trennen; den
  Fernzugriff zu deaktivieren oder den Token neu zu erzeugen kappt jede
  Session sofort. Das vollständige Threat-Model — die drei
  Subagenten-Policy-Stufen (`yolo` / `ask-user` / `ask-orchestrator`), was
  jede davon tatsächlich erzwingt, und wie du eine Schwachstelle meldest —
  steht in [`SECURITY.md`](SECURITY.md).

## Signierung

Downloads sind **bewusst unsigniert** — Zertifikate sind laufende Kosten,
die dieses Projekt nicht trägt. Windows SmartScreen unterbricht den ersten
Start des Installers: klicke **Weitere Informationen → Trotzdem ausführen**.
Jeder Download lässt sich gegen die sha512-Hashes in der `latest.yml` /
`main.yml` des Releases prüfen — dieselben Werte, die auch der Auto-Updater
prüft. Releases enthalten überhaupt keine macOS-Dateien, weil Squirrel.Mac
unsignierte Auto-Updates verweigert und ein Mac-Build, der sich nie
aktualisieren kann, schlechter ist als keiner — bau ihn lokal mit
`pnpm run build:mac`. Die Signier-Maschinerie ist implementiert und schläft,
das hier ist also ein Secret weit von einer Änderung entfernt. Details und
die Prüf-Anleitung: [`docs/SIGNING.md`](docs/SIGNING.md).

## Installation

Lade den Installer für dein System von der
[Releases-Seite](https://github.com/Nehmo101/Vertragus/releases):
`Vertragus-<version>-setup.exe` unter Windows, `.AppImage` oder `.deb` unter
Linux. Windows SmartScreen unterbricht den ersten Start — klicke **Weitere
Informationen → Trotzdem ausführen**; Downloads sind bewusst unsigniert, und
[`docs/SIGNING.md`](docs/SIGNING.md) erklärt warum und wie du eine Datei
gegen die Hashes prüfst, die auch der Auto-Updater prüft.

**Es gibt keinen macOS-Download.** Squirrel.Mac verweigert unsignierte
Updates, ein Mac-Release würde sich also einmal installieren und danach nie
wieder aktualisieren; nichts auszuliefern ist die ehrlichere Option. Unter
macOS baust du aus einem Checkout (siehe Entwicklung unten) — es funktioniert
alles, nur der fertige Download fehlt.

Updates kommen von selbst. Die Einstellungen bieten zwei Kanäle: **stable**
folgt getaggten Releases, **main** jedem grünen Build des Hauptbranches.

## Vor dem ersten Lauf

Vertragus fährt Agenten-CLIs — es liefert sie nicht mit und ersetzt sie
nicht. Installiere mindestens eine selbst und melde dich in deinem eigenen
Terminal an:

| CLI | Installation | Anmelden |
| --- | --- | --- |
| Claude Code | `npm i -g @anthropic-ai/claude-code` | `claude auth login` |
| Codex | `npm i -g @openai/codex` | `codex login` |
| Kimi, Cursor, Grok Build, Ollama | siehe die Anleitung des jeweiligen Anbieters | anbieterspezifisch |

Mehr braucht es nicht. Vertragus speichert keine eigenen API-Schlüssel und
meldet sich nie für dich an: Die CLI, der du ohnehin vertraust, behält ihre
eigene Session.

## Der erste Lauf

Das Panel öffnet sich mit einer **Erste-Schritte-Karte**, die die vier Dinge
durchgeht, die ein erster Lauf braucht — in der Reihenfolge, in der er
tatsächlich scheitert:

1. **Welche CLIs gefunden wurden** — ein Punkt je Provider, mit dem Grund,
   wenn eine nicht startet. Installiere eine und drücke ⟳.
2. **Login-Status** — für CLIs, die einen anbieten, sonst das exakte Kommando
   zum Kopieren. Das Anmelden passiert in deinem Terminal; Vertragus zeigt
   nur den Befehl.
3. **Das erste Profil** — ein Repository-Pfad und ein Orchestrator. Der Rest
   kann bleiben, wie er ist.
4. **▶ drücken** — das Feld daneben trägt das Ziel. Bleibt es leer, wartet
   der Orchestrator auf Ansage.

Ab dann ist die Workspace-Karte der Lauf: Agenten-Zeilen mit Status, das
geteilte **Task-Board** (schreibgeschützt — einen Task abzuhaken bleibt die
Entscheidung des Orchestrators, nachdem er die Arbeit verifiziert hat), ein
Composer zum Steuern, `?`-Badges für Fragen in beide Richtungen und ein
Ordner-Knopf, der die Artefakte des Laufs öffnet (`spill/`, `tasks.json`, das
Event-Journal). Stirbt ein Orchestrator oder verstummt er, übergibt
**Orchestrator ersetzen** dasselbe Team, dieselbe Queue und dasselbe Board an
einen Nachfolger mit frischem Kontext.

Was tun, wenn etwas nicht läuft wie erwartet, steht in
[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

## Entwicklung

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev        # Start mit HMR
corepack pnpm run ci     # Lint + Typecheck + Test + Build — das kanonische Gate
```

`VERTRAGUS_DEV_RUN=<repo> pnpm dev` startet einen headless Dev-Workspace auf
einem echten Repository, ohne die UI anzufassen. Die Test-Suite (1500+ Tests)
enthält Integrationstests, die den vollen MCP-Loop über einen echten
HTTP-Server und die Orchestrierungskette über ein echtes Git-Repository
fahren — Worker-Fix, Snapshot-Commit, `inspect_agent`, Tester auf dem
Worker-Branch, sauberes Orchestrator-Worktree.

Windows ist die primäre, owner-verifizierte Plattform; macOS und Linux werden
in CI best-effort gebaut.

Siehe [`CONTRIBUTING.md`](CONTRIBUTING.md) für den Build-/Test-Workflow und
die Sprachpolicy (die Doku ist englisch-kanonisch mit gepflegten deutschen
`.de.md`-Zwillingen) und [`CHANGELOG.md`](CHANGELOG.md) für die Änderungen.

## Lizenz

[MIT](./LICENSE) © 2026 Nehmo101
