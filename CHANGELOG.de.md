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

### Changed

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
