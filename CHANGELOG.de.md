Deutsch | [English](CHANGELOG.md)

# Changelog

Alle nennenswerten Änderungen an Vertragus werden in dieser Datei
dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
und das Projekt folgt [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Es wurde noch kein Release getaggt; alles steht unter Unreleased.

## [Unreleased]

### Added

- **Phase G (dsh-Adoption), alle fünf Muster:**
  - Spill statt Truncation — übergroße `read_output`- und
    `inspect_agent`-Ergebnisse werden verbatim unter
    `.vertragus/runs/<ws>/spill/` abgelegt und als Head/Tail-Preview + Pfad
    zurückgegeben.
  - Quiet-Events — Echos der eigenen Tool-Calls des Orchestrators und
    `agent_progress` wecken `await_events` nicht mehr; sie reisen beim
    nächsten Wake oder Timeout mit.
  - Strukturierte Reports — `start_agent{resultSchema}` validiert den
    Abschlussbericht des Agenten als JSON-Objekt; invalide Ergebnisse gehen
    mit exakten Pfaden ans Kind zurück.
  - Geteiltes Task-Board — `task_create` / `task_update` / `task_list` mit
    CAS-Revisionen, `blockedBy`-Abhängigkeiten und Ownership; überlebt
    Succession und Resume; `start_agent{taskId}` claimt einen Task.
  - `search_runs` — root-only Volltextsuche über die vergangenen
    Lauf-Journale dieses Repositorys.
- `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md` und dieses Changelog,
  jeweils mit deutschem `.de.md`-Zwilling.
- `scripts/docsTwins.test.ts` — CI-Guard für die zweisprachige Doku:
  passende Heading-Bäume und Link-Ziele je Zwillingspaar, kein deutscher
  Text in englischen Kanon-Dateien, keine verwaisten Zwillinge, keine toten
  Doc-Links oder Doc-Referenzen in Quellcode-Kommentaren.
- **Englische Blurbs für jeden Agenten-, Workspace- und Ortsnamen**, damit
  die englische Oberfläche keine deutschen Hover-Karten mehr zeigt.
- **Signier- und Notarisierungs-Plumbing**, ruhend bis Repository-Secrets
  existieren: Azure Trusted Signing für Windows, Developer ID plus
  Notarisierung für macOS (das erst mit funktionierender Signatur in
  Releases kommt, weil Squirrel.Mac unsignierte Auto-Updates verweigert),
  Signaturprüfung je Betriebssystem nach dem Packen und `docs/SIGNING.md`.
- **Provider-Verifikationsmatrix**: Argv-Snapshots für jedes Preset und
  jede Startform, eine `PRESET_VERIFICATION`-Karte mit Drift-Hinweis im
  Provider-Editor, ein wöchentlicher Best-Effort-Spawn-Probelauf und
  `docs/RELEASE-CHECKLIST.md`.
- Integrationsszenarien für die Phase-G-Features: eine `resultSchema`-
  Schleife über einen echten MCP-Server und ein Task-Board über eine
  Succession hinweg.
- Guards gegen Sprach-Drift: ein Scanner, der deutsche Literale im
  Main-Prozess außerhalb von `mainMessages.ts` ablehnt, und eine
  Paritätsprüfung für die Texte des Remote-Clients.

- **Succession übersteht einen Host-Crash.** Das Übergabe-Paket liegt jetzt
  bei den übrigen Artefakten des Laufs statt im Datenverzeichnis der App,
  und ein Resume, das ein unverbrauchtes findet, seedet den Nachfolger
  daraus — sagt dabei aber klar, dass die Fragen des toten Laufs verfallen
  sind. Ein Paket, dem das Journal widerspricht, wird abgelehnt, und eine
  gescheiterte Übergabe räumt ihr Paket selbst weg, damit es nie über
  neuere Arbeit gespielt wird.
- **Orchestrator aus dem Panel ersetzen.** Ein toter oder stummer
  Orchestrator lässt sich gegen einen Nachfolger mit frischem Kontext
  tauschen, der Team, Warteschlange und Board behält; das Fenster des
  Vorgängers bleibt als Obduktion offen.
- **Das Task-Board auf der Workspace-Karte**, schreibgeschützt und live,
  mit dem Artefakt-Ordner des Laufs einen Klick entfernt — und dasselbe
  Board auf dem Handy, weil das Gateway die Zusammenfassung ohnehin
  weiterreicht.
- **Ein geführter Erststart**: welche Agenten-CLIs installiert sind, ob sie
  angemeldet sind, ein Knopf zum ersten Profil und ein Fingerzeig auf Play.

- **Ein abgesicherter Release-Pfad.** `scripts/release-version.mjs` läuft als
  erster Job des Release-Workflows und weist einen Tag zurück, der nicht zur
  `package.json` passt (oder ein Prerelease-Suffix trägt oder dessen Patch
  nicht `0` ist) — bevor irgendein Release-Objekt oder Artefakt existiert. CI
  fährt ihr volles Gate jetzt auch auf Tags, damit der Release-Build nicht der
  einzige Build ohne Smoke-Test ist. `docs/RELEASE-CHECKLIST.md` hat die
  Versionskonvention und ein nummeriertes Tag-Runbook bekommen, jeder Schritt
  als human bzw. automated markiert.
- Ein Pull-Request-Template mit den Release-Tabellen und ein
  Bug-Report-Issue-Template, das nach Betriebssystem, Vertragus-Version und
  Provider-CLI-Version fragt.

### Fixed

- Der PTY-Idle-Hinweis erreichte das Orchestrator-Modell auf Deutsch, auf
  einem ansonsten englischen Kanal; er ist jetzt englisch.
- Das Result-Schema eines Subagenten blieb in der Registry liegen, wenn der
  Agent sich selbst beendete (nur `stop_agent` und Startfehler gaben es
  frei).
- Der Profil-Editor mischte ein deutsches Fehlerfragment in einen
  englischen Satz; Provider-Auth-Hinweise und Discovery-Details folgen
  jetzt der Oberflächensprache.
- Beim echten Erststart folgt die Oberflächensprache dem Betriebssystem
  statt auf Deutsch zu fallen; eine gespeicherte Wahl gewinnt immer.

### Changed

- **Die App-Version ist `1.0.0`** — das erste getaggte Release. Die
  eingecheckte Version ist eine Patch-BASIS (`X.Y.0`): Prereleases des
  `main`-Kanals addieren die Run-Nummer darauf, main wird deshalb direkt nach
  einem Tag auf `X.(Y+1).0` gehoben. Diese Prereleases sortieren über dem
  veröffentlichten Stable — harmlos, weil die Zielgruppen durch den
  Update-KANAL getrennt werden, nicht durch die Versionsreihenfolge.
- `MCP_SERVER_VERSION` ist `1.0.0` und als Tool-CONTRACT-Version dokumentiert:
  Sie bewegt sich, wenn sich die MCP-Tool-Oberfläche bewegt, nicht mit jedem
  App-Release.
- `@vitest/coverage-v8` und `vitest` sind beide exakt auf `3.2.7` gepinnt; das
  Coverage-Instrument, das Releases absichert, driftet damit nicht mehr vom
  Runner weg, den es als exakten Peer deklariert.
- Der Remote-Client setzt `<html lang>` aus dem `hello.locale` des Hosts,
  statt ein hartkodiertes `de` auszuliefern.

- **Die Doku ist jetzt englisch-kanonisch mit gepflegten deutschen
  Zwillingen.** Das deutsche Handbuch `docs/HANDBUCH-HARNESS.md` wurde als
  `docs/HANDBOOK-HARNESS.md` ins Englische übersetzt (deutsches Original
  jetzt `docs/HANDBOOK-HARNESS.de.md`; der alte Pfad ist ein Stub);
  `docs/PROMPT-MCP-HARNESS.md` und `docs/REMOTE-CLIENT-MOBILE.md` sind
  jetzt englisch mit deutschen Zwillingen;
  `docs/ORCHESTRATOR-SUCCESSION.md` und `README.md` bekamen deutsche
  Zwillinge. `docs/PLAN-DSH-ADOPTION.md` und
  `docs/RESEARCH-DEEPSEEK-HARNESS.md` bleiben als historische Dokumente
  deutsch.
- Das Remote-Threat-Model des READMEs zog nach `SECURITY.md`; das README
  behält eine kurze Zusammenfassung und einen Link.
- Der Prompt der Docs-Rolle nennt jetzt die neue Sprachpolicy: Doku ist
  englisch-kanonisch mit gepflegten deutschen `.de.md`-Zwillingen — wer
  Doku anfasst, schreibt beide.
