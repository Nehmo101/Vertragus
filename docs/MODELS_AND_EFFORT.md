# Modelle und Aufwandsstufen

Stand: 29. Juli 2026

Zwei Einstellungen pro Orchestrator und pro Slot, die vorher vermischt waren:

| Feld | Frage | Beispiel |
| --- | --- | --- |
| **Modell** | *Welches* Modell läuft? | `opus`, `claude-opus-5`, `gpt-5.6-sol` |
| **Aufwand** | *Wie viel* denkt und arbeitet es pro Aufgabe? | `Hoch`, `Extra`, `Ultracode` |

Bis einschließlich Schema v3 gab es stattdessen ein „Leistungs-Preset“
(schnell/ausgewogen/stark). Das war keine Aufwandsstufe, sondern nur eine
Abkürzung für einen Modellnamen — es doppelte also das Modellfeld und veraltete
mit jedem Modellrelease. Die Migration (siehe unten) übernimmt jedes Preset in
das Modellfeld und leitet daraus eine Aufwandsstufe ab.

## Aufwandsstufen

Eine kanonische Leiter, damit Profile über Provider hinweg portabel bleiben —
`src/shared/effort.ts` ist die einzige Quelle:

| Stufe | Label | Claude Code | Codex | Kimi / Cursor / Copilot / Ollama |
| --- | --- | --- | --- | --- |
| `low` | Niedrig | `--effort low` | `model_reasoning_effort="low"` | — |
| `medium` | Mittel | `--effort medium` | `model_reasoning_effort="medium"` | — |
| `high` | Hoch | `--effort high` | `model_reasoning_effort="high"` | — |
| `xhigh` | Extra | `--effort xhigh` | → `high` (geklemmt) | — |
| `max` | Max | `--effort max` | → `high` (geklemmt) | — |
| `ultra` | Ultracode | `--effort max` + Prompt-Direktive | → `high` (geklemmt) | — |

Regeln, die daraus folgen:

- **Nur verifizierte Schalter.** Deklariert sind ausschließlich Flags, die
  gegen `claude --help` bzw. die dokumentierte `-c key=value`-Fläche von Codex
  geprüft sind. Für die übrigen Provider gibt Vertragus **nichts** mit — ein
  unbekanntes CLI-Flag würde den Start des Agenten abbrechen. Ihre Dropdowns
  sind deaktiviert und nennen stattdessen, wo der Aufwand dort steckt (Kimi:
  Modellvariante `…-thinking`, Cursor: Modell-Suffix `…-high`).
- **Herunterklemmen statt scheitern.** Codex kennt kein `xhigh`/`max`; ein
  geteiltes Profil läuft dort auf `high`. Der Editor weist darauf hin, ändert
  das Profil aber nicht: Ein Wechsel zurück auf Claude soll die ursprüngliche
  Absicht wiederherstellen. Speichern wird dadurch **nicht** blockiert.
- **Ohne Auswahl** bleibt es beim Provider-Standard — es wird kein Flag gesetzt.
- **Ultracode** ist Vertragus' eigene Spitze: Claude Code hat keinen
  `ultra`-Wert, also läuft die Stufe als `--effort max` **plus** einer
  Systemprompt-Direktive, die Multi-Agent-Orchestrierung für die Sitzung
  freigibt (das Schlüsselwort `ultracode`). Die Direktive erreicht Orchestrator-,
  Solo- und Headless-Worker-Prompts; ein reiner interaktiver Subagent-Pane
  bekommt nur das Flag.

## Woher die Modell-Liste kommt

Ziel: Niemand muss dem Programm ein neues Modell beibringen. Drei Schichten,
absteigend nach Verlässlichkeit (`src/main/providers/models.ts`):

1. **Live-Quellen.** Account-Caches (Codex `models_cache.json`, Claudes
   `.claude.json`), CLI-Ausgaben (`cursor-agent models`, `copilot help`), der
   lokale Ollama-Dienst — und für Claude die **Anthropic-Modell-API**
   (`GET /v1/models`), sobald ein Credential vorhanden ist
   (`ANTHROPIC_API_KEY`, sonst `ANTHROPIC_AUTH_TOKEN` als Bearer-Token;
   `ANTHROPIC_BASE_URL` wird respektiert). Ohne Credential wird die API nicht
   angefragt. Diese Quelle kennt Modelle, die es zum Build-Zeitpunkt noch nicht
   gab.
2. **Abgeleitete rollende Aliase.** Zu jeder live gefundenen Claude-Familie wird
   der bloße Alias angeboten (`claude-titan-5` → `titan`). Claude Code löst
   einen Alias immer auf die **neueste** Version dieser Familie auf, also
   aktualisiert sich ein auf einen Alias gesetztes Profil von selbst.
3. **Gemerkter Katalog.** Jede Discovery schreibt die gesehenen IDs mit
   Zeitstempel in die Settings (`modelCatalogMemory`). Ein Refresh, der weniger
   findet als der vorige (Cache leer, CLI weg, offline), lässt die Auswahl
   deshalb nicht schrumpfen; nach 60 Tagen ohne Wiedersehen fällt ein Eintrag
   raus. **Ollama ist ausgenommen** — ein lokal gelöschtes Modell kann nicht
   laufen, es darf also nicht „erinnert“ werden.

`DEFAULT_MODELS` in `src/shared/providers.ts` ist damit nur noch das Saatgut für
den ersten Start und keine Pflegeliste mehr.

Aktualisiert wird beim Start, bei jedem Provider-Refresh, nach einem
CLI-Login — und alle **6 Stunden** in einem offenen Fenster
(`MODEL_AUTO_REFRESH_MS`), damit eine tagelang offene Sitzung nicht auf dem
Katalog vom Start sitzenbleibt. Die Statuszeile unter dem Feld zeigt Quelle,
Anzahl und Uhrzeit der letzten Discovery.

### Alias oder gepinnte Version?

Beides steht in der Liste, weil beides sinnvoll ist — und genau das war die
Verwirrung, die `fable` neben `claude-fable-5` erzeugt hat. Die Auswahl gruppiert
deshalb nach Familie: der Alias zuerst, mit dem Marker **neueste**, darunter
eingerückt die gepinnten Releases derselben Familie. Doppelte Einträge aus
zusammengeführten Quellen fallen zusammen.

- **Alias** (`opus`, `sonnet`, `haiku`, `fable`, `auto`): folgt jedem Release.
- **Versionierte ID** (`claude-opus-5`, `gpt-5.6-sol`): bewusst festgenagelt,
  z. B. für reproduzierbare Benchmarks.

Freitext bleibt erlaubt: Ein Provider kann eine ID akzeptieren, die keine Quelle
kennt.

## Migration (Config-Schema v4)

Beim ersten Start nach dem Update, vor der Schema-Validierung, weil das Schema
`modelPreset` nicht mehr kennt (`src/main/config/migrations.ts`):

- `modelPreset` → `model`, mit **exakt** der ID, die das Preset damals
  auflöste (Claude balanced → `sonnet`, Codex fast → `gpt-5.4-mini`, …). Ein
  bereits explizit gewähltes Modell bleibt unangetastet — es hatte auch vorher
  Vorrang.
- Zusätzlich wird die grobe Absicht der Stufe übernommen: fast → `low`,
  balanced → `medium`, strong → `high`.
- Der Store legt wie bei jedem Schema-Sprung vorher eine
  `vertragus.pre-v4.*.json`-Sicherung an.
