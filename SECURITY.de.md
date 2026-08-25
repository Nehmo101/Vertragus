Deutsch | [English](SECURITY.md)

# Sicherheit

## Eine Schwachstelle melden

Bitte öffne für Sicherheitsprobleme kein öffentliches Issue. Melde sie
vertraulich über
[GitHubs Private Vulnerability Reporting](https://github.com/Nehmo101/Vertragus/security/advisories/new)
auf diesem Repository. Beschreibe, was du gefunden hast, wie es sich
reproduzieren lässt und was ein Angreifer damit gewinnen könnte. Die
Antwort kommt im Advisory-Thread; Fixes erscheinen über den normalen
Release-Kanal.

Vertragus ist in einem frühen Neuaufbau und nicht release-reif; es gibt
noch keine Zusagen zu unterstützten Versionen — Meldungen werden gegen
`main` bewertet.

## Threat-Model

Vertragus fährt AI-Coding-Agenten als echte CLI-Prozesse auf deiner
Maschine, in Git-Worktrees deines Repositorys. Sei ehrlich mit dir, was das
bedeutet: Ein Agent ist Code-Ausführung mit den Rechten deines
Benutzerkontos.

### Subagenten-Policy-Stufen

Die **Subagenten-Policy** (Einstellungsfenster) hat drei Stufen — sei
ehrlich mit dir, was jede davon wirklich garantiert:

| Stufe | CLI-Permission-Flags | Durchsetzung | Trade-off |
| --- | --- | --- | --- |
| `yolo` (Default) | skip-permissions an | keine | Volle Autonomie. Ein Agent kann jedes Kommando ausführen, das dein Benutzerkonto kann. |
| `ask-user` | aus | **hart** — der Permission-Prompt der CLI selbst blockiert im Terminal des Agenten | Am sichersten, braucht dich aber am Desktop; unbeaufsichtigte Läufe bleiben stehen. Remote v1 leitet diese CLI-Prompts bewusst nicht aufs Handy weiter. |
| `ask-orchestrator` | skip-permissions an | **weich** — der Task-Contract verlangt `ask_orchestrator`-Freigabe vor riskanten Aktionen | Hält Läufe unbeaufsichtigt, und der Orchestrator kann via `ask_user` an dich eskalieren. Aber es ist nur Prompt-Ebene: Ein fehlverhaltender oder manipulierter Agent kann die Regel ignorieren. Behandle es als Leitplanke für ehrliche Agenten, nicht als Sandbox. |

Orchestratoren und Leads bekommen unter keiner Stufe Yolo-Flags — sie
operieren stattdessen über eine MCP-Tool-Allow-List. Der Yolo-Schalter im
Panel-Footer ist die grobe Steuerung: an = `yolo`, aus = `ask-user`; der
Dreifach-Picker lebt im Einstellungsfenster, und beide schreiben dieselbe
gespeicherte Wahrheit.

Es gibt keine Sandbox. `ask-orchestrator` ist eine Contract-Regel, kein
Einschluss; Agenten brauchen zudem per Design Netzwerkzugriff (MCP,
Vendor-APIs). Wenn du dir einen Agenten, der beliebige Kommandos als dein
Benutzer ausführt, nicht leisten kannst, nutze `ask-user` und bleib am
Desktop.

### Fernzugriff

Fernzugriff ist **standardmäßig aus**. Aktiviert bindet der Remote-Server
standardmäßig an die Tailscale-Adresse der Maschine (`100.64.0.0/10`);
Transportsicherheit ist die WireGuard-Verschlüsselung deines Tailnets —
Vertragus fügt kein TLS hinzu und öffnet keinen Port ins öffentliche
Internet. Das Binden an `0.0.0.0` (alle Interfaces) liegt hinter einer
expliziten getippten Bestätigung.

Die Kopplung nutzt einen 256-Bit-Token (QR/Link), verschlüsselt gespeichert
(Electron `safeStorage`) plus eine 0600-Fallback-Datei unter userData.
**Ein gekoppeltes Gerät hat Code-Ausführung auf deinem PC über die Agenten,
die es steuert** — unter der Default-Stufe `yolo` ist das Starten eines
Workspaces mit Ziel das Ausführen von Code. Kopple nur Geräte, denen du die
Maschine selbst anvertrauen würdest. Die Einstellungen listen verbundene
Geräte und lassen dich jedes trennen; den Fernzugriff zu deaktivieren oder
den Token neu zu erzeugen kappt jede Session sofort.

Die Kommando-Allow-List des Gateways sind exakt sechs Verben
(`workspaces:list`, `workspaces:start`, `workspaces:stop`, `profiles:list`,
`answer_question`, `user_message`). Ein Remote-Gerät kann keine Profile,
Provider oder Einstellungen bearbeiten, keine Fenster oder Zonen anfassen,
keine Worktrees entfernen und keine Branches promoten.

### In-App-MCP-Server

Der MCP-Server, mit dem die Agenten sprechen, ist loopback-only, mit
Per-Identität-Tokens (Orchestrator / Lead / Subagent, per-agent
HMAC-Subtokens) und Host-/Origin-Prüfung. Er ist ein separater Listener mit
separater Token-Domäne — Fernzugriff weitet ihn nie aus. Token-tragende
MCP-Config-Dateien bleiben aus deiner Git-Historie heraus
(`.git/info/exclude`; Codex nutzt prozesslokale Overrides).

### Chromium-Erweiterung

Die First-Party-Erweiterung fährt **dein** echtes Chromium im Auftrag
eines Workers. Derselbe Loopback-Listener wie MCP, anderer Pfad
(`/browser`) und ein eigener Pairing-Token. `chrome-extension:`-Origins
werden nur auf diesem Pfad akzeptiert. Ein Yolo-Worker kann klicken,
tippen und jeden Tab screenshotten, den die Erweiterung sieht — nur
pairen, während du den Lauf beobachtest, und den Token in Settings
rotieren, wenn du fertig bist. Das ist kein Extra-MCP und kein zweiter
MCP-Server. How-to: [`docs/CHROMIUM-EXTENSION.md`](docs/CHROMIUM-EXTENSION.md).

### Git-Wirkradius

Agenten arbeiten in Per-Agent-Worktrees auf `vertragus/*`-Branches; nichts
wird auto-gelöscht, Worker committen nie (der Host snapshotet), es gibt
keinen Push, und das Mergen eines Ergebnisses in deinen eigenen Branch ist
ein menschlicher Klick im Panel, der einen dirty Main-Checkout verweigert.
