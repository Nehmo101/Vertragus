## Modellzuweisung & Rollen
- Bevorzuge claude/claude-opus-4-8 für security-review und security-privacy-review: liefert gründliche Invarianten-Prüfung und trennt Infrastruktur- von inhaltlichen Problemen zuverlässig.
- Setze codex-Worker (ohne spezifisches Modell-Tag) bevorzugt für Git-Publish-Preflights und No-Change-Audits ein: prüft Branch-Casing, Divergenz, Auth und Scope sehr zuverlässig ohne verbotene Mutationen.
- Bei cursor/composer-2.5 und composer-2.5-fast: akzeptiere "success" nur nach Prüfung eines nicht-leeren Diffs — wiederholt als reines Identitäts-Echo ohne Codeänderung beobachtet.
- claude/claude-sonnet-5 als qa-gate-runner kann in gesperrten Sandboxen pnpm/node-Gates nicht ausführen; leite Gate-Ausführung bei Blocker-Meldung an einen codex-Worker um.

## Prompt- und Ergebnisvertrag
- main-orchestrator mit codex/gpt-5.6-sol: bei sicherheitsrelevanten Tasks Security-Gate-Heuristik (process.env/fs-Muster, geforderte Negativtests) und exakten Ergebnisvertrag explizit im Prompt nennen.
- claude/claude-sonnet-5 als orchestrator-integrator: explizit Aufräumen von Temp-/Verifikationsdateien (*.verify-*-tmp.md, *.check, *.origcheck) vor Abschluss fordern.
- codex/gpt-5.6-sol in systems-integrator/orchestrator-core: Quality-Gate-Anforderungen vorab explizit auflisten, da Nacharbeit hier häufig nötig ist.
- cursor/cursor-grok-4.5-high-fast bei test-writer-Rolle: Testanforderungen konkretisieren, Gate-Nacharbeit wiederholt beobachtet.

## Planung & Durchführung
- Bei langen main-orchestrator-Einzeltasks mit codex/gpt-5.6-sol Kapazitätsfehler ("at capacity") einplanen; Attempt-Retry übernimmt Recovery-Artefakte zuverlässig.
- Große, späte Implementierungsphasen bei codex/gpt-5.6-sol in kleinere Commits pro Subsystem aufteilen statt einen breiten Commit.
- UI- und Cloud-Integrationen bei codex/gpt-5.6-sol zusätzlich mit realen End-to-End-Smoke-Checks absichern, nicht nur mit Unit-Tests/Build.
- Bei qa-gate-runner-Hängern durch interaktive Bash-Tool-Freigaben Panel-Approval vorab einholen oder einen Timeout/Eskalationspfad definieren.
