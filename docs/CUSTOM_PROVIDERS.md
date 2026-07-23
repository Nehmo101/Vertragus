# Custom-Provider-API (config-basiert)

Vertragus' eingebaute Provider (Claude, Kimi, Codex, Cursor, Copilot, Ollama)
sind eine geschlossene, stark typisierte Menge — die Engine behandelt jeden
einzeln (Stream-Format, Yolo-Flags, Sandbox-Details, Resume). **Custom
Provider** sind das Gegenteil: ein rein deklarativer Vertrag, mit dem du
Vertragus auf eine beliebige weitere Headless-CLI zeigen kannst, ohne den Kern
zu ändern.

## Vertrag

Definiert in `src/shared/customProviders.ts` (Zod-validiert), gespeichert unter
dem Setting `customProviders`:

| Feld | Bedeutung |
|---|---|
| `id` | Stabile Kennung; das Präfix `custom:` wird erzwungen und normalisiert. |
| `label` | Anzeigename. |
| `command` | Ausführbare Datei (via PATH aufgelöst, **nie** ein Shell-String). |
| `args` | Argumente **vor** dem Prompt, z. B. `["-p"]` oder `["chat", "--json"]`. |
| `promptDelivery` | `arg` (Prompt als letztes argv-Element) oder `stdin`. |
| `yoloArgs` | Auto-Approve-Flags, nur im Yolo-Modus angehängt. |
| `roles` | `worker` / `reviewer` / `tester`. **Orchestrator wird bewusst nicht angeboten.** |
| `streamJson` | Ob die CLI `--output-format stream-json` (Anthropic-Stil) versteht. Default `false` (Klartext). |
| `enabled` | Schalter. |

## Sicherheitsgrenzen

- **Namespace-Isolation:** Jede `id` trägt zwingend das Präfix `custom:`; ein
  Custom Provider kann niemals einen eingebauten Provider verdecken oder mit
  ihm verwechselt werden. Einträge, die eine eingebaute ID (`claude`, `codex`
  …) spiegeln, werden beim Laden verworfen.
- **Nur Worker.** Ein Orchestrator braucht den verifizierten in-App-MCP-Kanal;
  eine deklarative CLI kann den nicht zusichern, deshalb ist die
  Orchestrator-Rolle ausgeschlossen.
- **Keine Shell.** `buildCustomProviderLaunch` liefert `{command, args, stdin?}`
  für einen shell-freien `spawn`; der Prompt wird nie in einen Shell-String
  interpoliert. Unter Windows gilt dieselbe Argument-Treue wie für die
  eingebauten Provider (siehe `resolveCommand.ts`).
- **Ungültige Zeilen werden fallengelassen, nicht geworfen** — eine
  fehlerhafte Zeile bricht nie den ganzen Config-Load.

## Status

Vertrag, Validierung, Launch-Spec-Bau (`buildCustomProviderLaunch`) und die
Config-Persistenz (`listCustomProviders` / `saveCustomProviders` in
`src/main/config/store.ts`) sind vollständig implementiert und getestet.

Der verbleibende Schritt zur vollständigen Slot-Auswahl in der Profil-UI ist
bewusst separiert: `AgentSlot.provider` ist heute die geschlossene
`AgentProviderId`-Union, damit die Engine-`switch`-Zweige typsicher bleiben.
Custom-Provider-Worker über die UI wählbar zu machen bedeutet, diese Union am
Laufzeit-Rand zu weiten — eine gezielte, für sich stehende Änderung, die auf
diesem geprüften Fundament aufsetzt, ohne den typisierten Kern zu
destabilisieren.
