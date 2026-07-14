# Orca-Strator Retros

Dieser Branch enthält ausschließlich Retro-Daten des Orchestrators — keinen Code.
Er wird automatisch von Orca-Strator-Installationen befüllt (Retro-Sync) und
periodisch von der Retro-Analyse ausgewertet (siehe docs/retro-sync.md im Code-Branch).

- `runs/JJJJ/MM/<retro-id>.json` — eine Retrospektive pro Planlauf
- `benchmarks/JJJJ/MM/<record-id>.json` — Benchmark-Bewertungen
- `learnings/<machineId>.json` — gemergter Modellwissen-Snapshot je Installation
- `overlay/learnings.md` — geprüftes Regelwerk, injiziert in den Orchestrator-Systemprompt
- `proposals/` — generierte Verbesserungs-Briefs
- `state/last-analysis.json` — Fortschrittsmarke der Analyse