---
status: proposed
created: 2026-07-27
kind: code
source-retros: 76
source-benchmarks: 0
---

# Watchdog für hängende Tool-Freigabe-Wartezustände bei QA-Gate-Runs

## Kontext

qa-gate-runner-Tasks (claude-sonnet-5) können im Zustand 'Wartet auf Tool-Freigabe: Bash' unbegrenzt hängen bleiben und werden nie terminal, obwohl die erforderliche Prüfkette bereits grün war. Dies ist ein Scheduler-/Engine-Problem, das durch eine Prompt-Regel allein nicht gelöst werden kann.

## Problem-Evidenz

- qa-gate-runner (claude-sonnet-5): verify-acceptance (Éomer 2) blieb im Status 'Wartet auf Tool-Freigabe: Bash' hängen und wurde nicht terminal, während die required-Kette längst grün war
- qa-gate-runner (claude-sonnet-5): Pippin meldete Sandbox-Blocker für pnpm/node-Gates ehrlich statt zu faken, Engine leitete an anderen Provider um

## Auftrag

Lokalisiere im Vertragus-Repository innerhalb von src/main/orchestrator/ die Engine-/Scheduler-Logik, die den Lebenszyklus und Timeout-Verhalten von Subagent-Tasks überwacht (Ausgangspunkt: dieselben Module, die Task-Status wie 'waiting for tool approval' setzen, ggf. in Nähe von orchestratorLaunch.ts oder einem dedizierten Scheduler-/Watchdog-Modul). Implementiere einen konfigurierbaren Timeout (Default z. B. 120 Sekunden) für Tasks, die im Zustand 'wartet auf interaktive Tool-Freigabe' verharren: Nach Ablauf soll der Task automatisch mit Status BLOCKER/needsWork beendet und optional an einen alternativen Gate-Runner (anderer Provider) rerouted werden, statt unbegrenzt zu hängen. Logge den Timeout-Grund nachvollziehbar. Ergänze einen Test, der einen simulierten hängenden Freigabe-Zustand erzeugt und das Timeout-/Reroute-Verhalten verifiziert. Abnahmekriterium: pnpm run ci grün.

## Abnahmekriterien

- `pnpm run ci` läuft grün (Lint, Typecheck, Tests, Build).
- Die Änderung adressiert nachweislich die oben belegte Schwäche.
