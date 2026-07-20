---
status: proposed
created: 2026-07-20
kind: code
source-retros: 75
source-benchmarks: 0
---

# Temp-/Verifikationsdateien vor Integrations-Commit erkennen und entfernen

## Kontext

Integrator-Agenten (u.a. claude-sonnet-5 als orchestrator-integrator) hinterlassen trotz Prompt-Vorgabe wiederholt Verifikations-Hilfsdateien (z.B. .verify-*-tmp.md, *.origcheck, *.check, *.c9check) im finalen Commit. Das lässt sich nicht zuverlässig allein per Prompt-Anweisung verhindern, da es bereits zweimal trotz entsprechender Hinweise passiert ist — es braucht eine strukturelle Absicherung im Integrationsschritt.

## Problem-Evidenz

- t-1 (Beorn): Commit c9a520c6 enthält .verify-new-body-tmp.md und .verify-orig-tmp.md
- O07 Wurmzunge, Commit a48ddaf9: 4 Check-Dateien (*.origcheck, *.check, *.c9check) neben 19 echten Zieldateien im Commit

## Auftrag

Finde im Vertragus-Repository den Code-Pfad, der den finalen Integrations-Commit eines Orchestrator-Laufs erzeugt (Kandidaten: src/main/orchestrator/orchestratorLaunch.ts oder ein Integrations-/Commit-Modul im Scheduler). Implementiere eine Vorab-Prüfung direkt vor dem `git add`/Commit-Schritt: scanne den Worktree-Diff auf bekannte Verifikations-/Temp-Dateimuster (z.B. Glob-Muster wie '*.verify-*-tmp.*', '*.origcheck', '*.check', '*.c9check' sowie generell Dateien, die während des Laufs für interne Vergleichszwecke angelegt wurden und nicht Teil der eigentlichen Zieldateien sind). Wenn solche Dateien im Diff auftauchen, entferne sie automatisch aus dem Staging-Bereich (git restore --staged / rm) bevor der Commit erstellt wird, und protokolliere die entfernten Pfade im Task-Result als Hinweis. Ergänze eine konfigurierbare Liste dieser Muster an zentraler Stelle, damit sie leicht erweiterbar ist. Schreibe Tests, die belegen, dass ein Worktree mit gemischten echten Änderungen und Temp-Dateien nach dem Schritt nur die echten Änderungen im Commit enthält. Abnahmekriterium: pnpm run ci grün.

## Abnahmekriterien

- `pnpm run ci` läuft grün (Lint, Typecheck, Tests, Build).
- Die Änderung adressiert nachweislich die oben belegte Schwäche.
