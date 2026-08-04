---
status: done
created: 2026-07-27
kind: code
source-retros: 76
source-benchmarks: 0
implementedIn: 268bf60
---

# Fehlklassifikation 'error trotz grüner Gates und Erfolgsmeldung' beheben

## Kontext

Ein Task von codex/gpt-5.6-sol (main-orchestrator) wurde trotz Erfolgsmeldung, exit code 0 und grünen Quality-Gates final als error gewertet, was zu unnötiger Quarantäne von 15 Dateien führte. Das deutet auf einen Fehler in der Status-/Ergebnis-Parsing-Logik hin, der über eine Prompt-Regel hinaus im Code behoben werden muss.

## Problem-Evidenz

- main-orchestrator (gpt-5.6-sol): 'Erfüllt Orcas Ergebnisvertrag nicht zuverlässig: Task endete trotz Erfolgsmeldung und grüner Gates als error (exit 0)' — Fallback-Task wurde mit ✗ fehlgeschlagen (exit 0) gewertet, 15 Dateien quarantined statt übernommen
- main-orchestrator (gpt-5.6-sol): gleicher Task-Typ lief mit expliziten Gate-Vorgaben im Prompt anschließend grün durch, was auf eine fragile Parsing-/Kontrakt-Erkennung statt echtes Modellversagen hindeutet

## Auftrag

Untersuche im Vertragus-Repository die Ergebnis-Parsing- und Status-Ableitungslogik für abgeschlossene Orchestrator-Tasks, ausgehend von src/main/orchestrator/orchestratorLaunch.ts (durchsuche zusätzlich src/main/orchestrator/ nach dem Modul, das Provider-Exit-Code, Erfolgsmeldung und Gate-Ergebnisse zu einem finalen Task-Status wie success/error kombiniert). Finde und behebe die Ursache, warum ein Task mit exit code 0, expliziter Erfolgsmeldung und durchgängig grünen Quality-Gates dennoch als 'error' klassifiziert und dessen Dateien quarantänisiert statt übernommen werden können. Stelle sicher, dass bei exit 0 + erfüllter Erfolgsmeldung + grünen Required-Gates der Status korrekt auf success gesetzt wird. Ergänze eine Regressionstest-Suite, die genau dieses Szenario (grüne Gates, Erfolgsmeldung, exit 0) gegen fälschliche error-Klassifikation absichert. Abnahmekriterium: pnpm run ci grün.

## Abnahmekriterien

- `pnpm run ci` läuft grün (Lint, Typecheck, Tests, Build).
- Die Änderung adressiert nachweislich die oben belegte Schwäche.
