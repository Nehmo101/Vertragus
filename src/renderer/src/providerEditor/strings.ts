/**
 * Every visible string of the provider editor. Same rule as the panel and the
 * profile editor: one object per surface so M6 can lift it into an i18n bundle
 * unchanged.
 */
export const PROVIDER_STRINGS = {
  title: 'Provider bearbeiten',
  titleNew: 'Eigener Provider',

  presetNotice:
    'Bearbeitet die Vorgabe — „Auf Preset zurücksetzen“ stellt sie wieder her.',
  reset: 'Auf Preset zurücksetzen',
  resetConfirm: (label: string): string =>
    `„${label}“ auf die mitgelieferte Vorgabe zurücksetzen? Alle Änderungen an diesem Provider gehen verloren.`,

  // --- identity ---
  identity: 'Identität',
  label: 'Anzeigename',
  labelPlaceholder: 'z. B. Mein Claude',
  id: 'Id',
  idHint: 'Wird von Profilen referenziert und lässt sich später nicht mehr ändern.',
  idPlaceholder: 'mein-claude',
  command: 'Befehl',
  commandHint: 'Programmname, über PATH gesucht — keine Shell-Zeile, keine Argumente.',
  commandPlaceholder: 'claude',
  enabled: 'Aktiv',
  enabledHint: 'Aus: Der Provider bleibt gespeichert, ist aber nicht mehr wählbar.',

  // --- launch ---
  launch: 'Start',
  args: 'Argumente vor allem anderen',
  argsHint: 'Eins pro Zeile. Beispiel Ollama: „run“.',
  yoloArgs: 'Yolo-Argumente',
  yoloArgsHint:
    'Eins pro Zeile. Nur Subagents bekommen sie — ein Orchestrator nie, egal was hier steht.',
  modelArg: 'Modell-Flag',
  modelArgHint: 'Leer = das Modell wird positionell hinter die Argumente gehängt.',
  versionArgs: 'Versions-Abfrage',
  versionArgsHint: 'Eins pro Zeile. Damit prüft Vertragus, ob das CLI startbar ist.',

  // --- effort ---
  effort: 'Effort',
  effortStyle: 'Art',
  effortNone: 'kein Effort-Schalter',
  effortFlagStyle: 'Flag-Paar (--effort high)',
  effortTemplateStyle: 'Vorlage (-c model_reasoning_effort="high")',
  effortFlag: 'Flag',
  effortTemplate: 'Vorlage',
  effortTemplateHint: 'Muss {effort} enthalten — der Wert wird wörtlich eingesetzt.',

  // --- auth ---
  auth: 'Anmeldung',
  authLoginArgs: 'Login-Argumente',
  authLoginArgsHint: 'Eins pro Zeile. Startet den Login des CLIs in einem Terminal.',
  authStatusArgs: 'Status-Argumente',
  authStatusArgsHint: 'Eins pro Zeile. Leer lassen, wenn das CLI keinen Status kennt.',

  // --- system prompt ---
  systemPrompt: 'System-Prompt',
  promptKind: 'Übergabe',
  promptKindArg: 'Flag (--append-system-prompt)',
  promptKindAgentFile: 'Agent-Datei (Kimi: --agent-file)',
  promptKindCodexConfig: 'Codex-Config (-c developer_instructions)',
  promptKindPty: 'ins Terminal tippen',
  promptFlag: 'Flag',
  promptPtyHint:
    'Ohne Start-Flag: Vertragus tippt den Prompt nach dem Ready-Handshake ins Terminal.',
  promptCodexHint: 'Prozesslokal, es wird nichts in ~/.codex/config.toml geschrieben.',
  promptAgentFileHint:
    'Vertragus schreibt eine Agent-Datei mit YAML-Kopf; ihr Text ERSETZT den Standard-Prompt.',

  // --- mcp ---
  mcp: 'MCP-Anbindung',
  mcpKind: 'Verfahren',
  mcpKindClaudeJson: 'JSON-Datei über ein Flag (Claude)',
  mcpKindCodexOverrides: 'Prozesslokale -c-Overrides (Codex)',
  mcpKindKimiProject: 'Projektdatei .kimi-code/mcp.json (Kimi)',
  mcpKindNone: 'keine — reines Terminal',
  mcpConfigArg: 'Config-Flag',
  mcpStrictArg: 'Strict-Flag',
  mcpStrictArgHint: 'Beschränkt das CLI auf genau diese Datei. Leer = kein Strict-Modus.',
  mcpAllowedToolsArg: 'Allowlist-Flag',
  mcpAllowedToolsArgHint: 'Nur für den Orchestrator gesetzt; Subagents laufen ohne Allowlist.',
  mcpCodexHint:
    'Codex kennt keine Config-Datei: Url, required und enabled_tools reisen als -c-Overrides mit.',
  mcpKimiHint:
    'Kimi hat kein Flag: Vertragus legt .kimi-code/mcp.json im Arbeitsverzeichnis des Agenten an.',
  mcpNoneHint:
    'Der Agent kann nichts melden. Vertragus warnt den Orchestrator nach 120 s ohne Ausgabe.',

  // --- discovery ---
  discovery: 'Modellliste',
  discoveryKind: 'Quelle',
  discoveryNone: 'keine — nur Freitext',
  discoveryCli: 'CLI-Aufruf',
  discoveryFile: 'Datei',
  discoveryHttp: 'HTTP',
  discoveryArgs: 'Argumente',
  discoveryArgsHint: 'Eins pro Zeile, z. B. „models“ oder „provider / list / --json“.',
  discoveryParse: 'Format',
  discoveryParseLines: 'Zeilen',
  discoveryParseJson: 'JSON',
  discoveryParseTomlKeys: 'TOML-Schlüssel',
  discoveryPath: 'Pfad',
  discoveryPathHint: '~ wird zum Benutzerordner aufgelöst.',
  discoveryUrl: 'Url',
  discoveryJsonPath: 'JSON-Pfad',
  discoveryJsonPathHint: 'z. B. models[].name — leer lassen für eine flache Liste.',
  seedModels: 'Immer angebotene Ids',
  seedModelsHint:
    'Eine pro Zeile. Nur rollende Aliase des CLIs (opus, sonnet) — nie ein konkretes Release.',

  // --- footer ---
  cancel: 'Abbrechen',
  save: 'Speichern',
  saving: 'Speichert …',
  deleteProvider: 'Provider löschen',
  deleteConfirm: (label: string): string =>
    `Provider „${label}“ wirklich löschen? Profile, die ihn nutzen, lassen sich danach nicht mehr starten.`,

  loading: 'Lädt …',
  unknownProvider: 'Diesen Provider gibt es nicht (mehr).',
  bridgeMissing: 'Preload-Bridge nicht verfügbar.',

  errors: {
    label: 'Bitte einen Anzeigenamen vergeben.',
    id: 'Bitte eine Id aus Buchstaben, Ziffern, Punkt, Strich oder Unterstrich.',
    idTaken: 'Diese Id gibt es schon.',
    command: 'Bitte den Programmnamen eintragen.',
    flag: 'Bitte ein Flag eintragen.',
    effortTemplate: 'Die Vorlage muss {effort} enthalten.',
    path: 'Bitte einen Pfad eintragen.',
    url: 'Bitte eine vollständige Url eintragen (mit http:// oder https://).',
    jsonPath: 'Bitte einen JSON-Pfad eintragen.',
    args: 'Zu viele oder zu lange Argumente.',
    generic: 'Ungültiger Wert.'
  }
} as const
