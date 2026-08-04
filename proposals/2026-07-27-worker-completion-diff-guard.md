---
status: done
created: 2026-07-27
kind: code
source-retros: 76
source-benchmarks: 0
implementedIn: 2027e72
---

# Completion-Status gegen echten git diff verifizieren

## Kontext

Mehrere Retros zeigen, dass cursor/composer-2.5 und composer-2.5-fast Worker-Tasks als success/completion=no-changes melden, obwohl das Ergebnis nur eine Selbstvorstellung ohne jede Codeänderung ist. Der Judge/Completion-Mechanismus akzeptiert diese Fälle fälschlich als Erfolg — eine Overlay-Regel kann diese strukturelle Verifikationslücke nicht schließen.

## Problem-Evidenz

- frontend-ui (composer-2.5): 'Ich bin Gollum ... Wie kann ich dir helfen?', completion=no-changes, kein Diff an responsiveGuards.module.css/TitleBar.tsx
- worker - small and quick work-item (composer-2.5-fast): 4/4 Tasks endeten nur mit Selbstvorstellung, completion=no-changes, wurden aber als 'zuverlässig im ersten Anlauf' gewertet
- frontend-ui (composer-2.5): ff-t3, t1-ui, t-ui — jeweils 'success' ohne Implementierung der geforderten Komponente

## Auftrag

Untersuche im Vertragus-Repository die Logik, die den finalen Task-Status (success/needsWork/failed) aus Provider-Ergebnis und completion-Feld ableitet, ausgehend von src/main/orchestrator/orchestratorLaunch.ts und src/main/orchestrator/VertragusMcpServer.ts (durchsuche das gesamte src/main/orchestrator/-Verzeichnis nach der zuständigen Judge-/Result-Auswertungsfunktion). Ergänze eine Verifikationsschranke: Wenn ein Worker completion=success oder no-changes meldet, aber der Task laut Prompt/Definition-of-Done Codeänderungen erwartet, prüfe per `git diff --stat` bzw. `git status --short` im Task-Worktree, ob tatsächlich Dateien verändert wurden. Ist der Diff leer, obwohl Änderungen gefordert waren, downgrade den Status automatisch auf needsWork mit einer expliziten Begründung 'no changes detected despite success claim' statt success zu akzeptieren. Ergänze Unit-/Integrationstests, die diesen Fall (leerer Diff + success-Meldung) abdecken. Abnahmekriterium: pnpm run ci grün.

## Abnahmekriterien

- `pnpm run ci` läuft grün (Lint, Typecheck, Tests, Build).
- Die Änderung adressiert nachweislich die oben belegte Schwäche.
