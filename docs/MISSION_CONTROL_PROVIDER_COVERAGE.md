# Mission Control — Provider- und Sicherheitsabdeckung (Phase C)

Stand: 2026-07-15

## Permission Broker

| Provider | Headless-Worker | Interaktive PTY | Verhalten ohne Callback |
|---|---|---|---|
| Claude Code | Abgedeckt. Non-yolo-Tasks erhalten Orcas fest verdrahtetes MCP-Tool `mcp__orca-sub__permission_prompt` über `--permission-prompt-tool`. Nur Toolname und Scope erscheinen remote; `tool_input` bleibt ausschließlich im Main-Prozess. | Konservativer, provider-spezifischer Prompt-Parser als Fallback. | Timeout und Shutdown sind `deny`. |
| Codex | Abgedeckt durch `workspace-write`-Sandbox. `codex exec` hat in der unterstützten CLI keinen interaktiven Approval-Callback; eine von der Sandbox verweigerte Operation wird nicht ferngesteuert fortgesetzt. | Konservativer Sandbox-Prompt-Parser, sofern die interaktive CLI einen bestätigten Prompt liefert. | Sandbox/deny; niemals unsandboxed fortsetzen. |
| GitHub Copilot | Kein verifizierter Headless-Callback. | Grober, exakt markierter Provider-Prompt-Parser. | Headless stdin ist geschlossen; die Operation schlägt damit geschlossen fehl. |
| Cursor Agent | Kein verifizierter Headless-Callback. | Grober, exakt markierter Provider-Prompt-Parser. Workspace-Trust bleibt die bestehende lokale Orca-Automation und ist keine Remote-Capability. | Headless stdin ist geschlossen; die Operation schlägt damit geschlossen fehl. |
| Ollama | Nicht anwendbar: der lokale Ollama-HTTP-Pfad besitzt keine Tool-Permission-Schicht. | Nicht unterstützt. | `deny`/keine Remote-Freigabe. |

Die Claude-Integration folgt dem dokumentierten `--permission-prompt-tool`-Vertrag. Das MCP-Tool antwortet ausschließlich mit `behavior: allow` plus unverändertem, internem Input oder `behavior: deny`. Siehe [Anthropic CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage).

## Harte Grenzen

- Remote kennt nur `permission.allow` und `permission.deny` mit einer UUID. Es existiert keine Route für `agent.write`, Agent-stdin, Shelltext, Pfade oder Tool-Input.
- Der Broker erzeugt die provider-spezifischen Antwortbytes intern. Nach 60 Sekunden wird automatisch abgelehnt.
- Jede Capability (`approve-tools`, `budget`, `task-control`, `replan`) ist separat und beim Pairing standardmäßig aus.
- WebSocket-Upgrades verwenden denselben Hash-only-Geräte-Token über den `Sec-WebSocket-Protocol`-Header, dieselbe Command-Whitelist, Body-Caps, Rate-Limits, Scopes und Auditierung wie HTTP.

## Team-Identität und Scoping

Mission Control unterstützt lokale, enrollment-basierte App-Accounts: Beim Desktop-Pairing werden Actor, Capabilities, exakte Session-Scopes und die getrennte Berechtigung zum Senden neuer Ziele festgelegt. Ein leerer Scope gewährt keinen Workspace-Zugriff. SSE, WebSocket, Push und Commands werden serverseitig gefiltert.

Optional kann Cloudflare Access vorgeschaltet werden. Orca vertraut niemals einem bloßen Identity-Header: `Cf-Access-Jwt-Assertion` wird gegen die Team-JWKS mit RS256 sowie `iss`, `aud`, `exp` und `nbf` geprüft; danach muss die verifizierte Identität exakt zum gekoppelten Actor passen. Der Geräte-Bearer bleibt zusätzlich Pflicht. Grundlage ist Cloudflares [JWT validation documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

## Erweiterte Steuerung

- Budget: aggregierte Token/Kosten im Snapshot; optionale Caps pausieren den aktiven Worker fail-closed.
- Pause/Resume: Der Worker wird beendet, partielle Arbeit bleibt im verifizierten Orca-Worktree und Resume startet einen neuen Worker an derselben Engine-Grenze.
- Provider-Fallback: Ein erkanntes Rate-Limit darf auch bei sonst festem Routing auf einen anderen konfigurierten Provider wechseln; normale Fehler folgen weiterhin dem Profil-Routing.
- Live-Replan: Remote darf nur vorhandene Task-IDs entfernen und `maxParallel` reduzieren/ändern. Neue Prompts, Commands, Pfade oder Tasks können über diese Route nicht eingeschleust werden; der geänderte Plan bleibt im Review-Gate.
