---
status: proposed
created: 2026-07-20
kind: code
source-retros: 75
source-benchmarks: 0
---

# Erfolgsstatus nur nach Diff-Verifikation akzeptieren

## Kontext

cursor/composer-2.5 und composer-2.5-fast melden mehrfach 'success' bzw. completion=no-changes, obwohl der Worker nur eine Identitäts-Präambel ausgegeben und die eigentliche Aufgabe nicht bearbeitet hat. Die Engine/der Judge akzeptiert diesen Zustand aktuell als Erfolg. Das ist kein per Overlay lösbares Prompt-Problem, sondern eine fehlende strukturelle DoD-Prüfung im Orchestrator.

## Problem-Evidenz

- frontend-ui/composer-2.5: 'Ich bin Gollum ... Wie kann ich dir helfen?' als komplettes Ergebnis, git diff HEAD leer
- ff-t3: ClaudePermissionModeSelect.tsx nie erstellt, completion=no-changes, Judge wertete es als success
- worker - small and quick work-item/composer-2.5-fast: 4/4 Tasks endeten in ~15-30s nur mit Selbstvorstellung, completion=no-changes
- Auto-Retro-Metrik 'zuverlässig im ersten Anlauf' war irreführend — Erfolgsstatus ohne jede Arbeitsleistung

## Auftrag

Analysiere im Vertragus-Repository die Completion-/Judge-Logik, die den Erfolgsstatus eines Worker-Tasks bestimmt (Kandidaten: src/main/orchestrator/orchestratorLaunch.ts, sowie Scheduler-/Engine-Module, die completion/success/no-changes auswerten). Implementiere eine strukturelle DoD-Prüfung: Für Tasks, die als 'implementation'/Code-Änderung deklariert sind, darf der Task nur dann als success/completion ohne needs-work markiert werden, wenn (a) mindestens eine tatsächliche Dateiänderung im Worktree (git diff/status) vorliegt ODER (b) der Worker explizit und nachvollziehbar begründet, warum keine Änderung nötig war (z.B. Ziel bereits erfüllt, mit Belegen). Wenn ein Worker nur eine generische Selbstvorstellung/Identitäts-Antwort ohne Bezug zum Task-Prompt liefert und keine Dateien geändert wurden, markiere das Ergebnis als needs-work/failed statt success, und protokolliere den Grund im Task-Result. Schreibe Unit-/Integrationstests, die diesen No-op-Fall (leerer Diff + generische Antwort ohne Aufgabenbezug) simulieren und sicherstellen, dass er korrekt als needs-work erkannt wird, sowie einen positiven Testfall (echter Diff vorhanden -> success bleibt möglich). Abnahmekriterium: pnpm run ci grün.

## Abnahmekriterien

- `pnpm run ci` läuft grün (Lint, Typecheck, Tests, Build).
- Die Änderung adressiert nachweislich die oben belegte Schwäche.
