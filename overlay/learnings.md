## Modellauswahl & Rollen
- Setze codex/gpt-5.6-sol bevorzugt für main-orchestrator bei großen Querschnitts-Refactorings/Portierungen ein; er liefert aus reinen Ziel-Prompts vollständige, getestete Ergebnisse.
- Meide cursor/cursor-grok-4.5-high-fast für kritische Rollen (test-writer, security-reviewer, release-ops, electron-core); hohe Fehlerquote (15/36 Tasks fehlgeschlagen) erfordert Zweitprüfung.
- Prüfe Ergebnisse von cursor/composer-2.5 und cursor/composer-2.5-fast bei UI-/Worker-Aufgaben zwingend gegen echten git diff: Modelle melden wiederholt "success"/no-changes nach reiner Selbstvorstellung ohne Codeänderung.
- Ziehe bei sicherheitsrelevanten Reviews von claude/claude-opus-4-8 eine zusätzliche Prüfinstanz hinzu; die Rolle security/gatekeeper zeigt erhöhte inhaltliche Fehlerquote.

## Prompting & Ergebnisvertrag
- Liste bei sicherheitsrelevanten Tasks explizit die Gate-Heuristik auf (betroffene Muster wie process.env/fs, geforderte Negativtests); ohne diese Angabe scheitert das Security-Gate zuverlässiger.
- Mache den Ergebnisvertrag (Erfolgsformat, erwartete Dateiliste, Gate-Ausgaben, kein Git bei Workern) im Prompt explizit, um Fehlklassifikationen (Erfolg trotz grüner Gates als error gewertet) zu vermeiden.
- Fordere bei Workern explizit das Aufräumen von Temp-/Verifikationsdateien (z. B. .verify-*-tmp.md, *.check, *.origcheck) vor Commit/Abschluss.
- Verlange bei UI-/Cloud-Integrationen zusätzlich zu Unit-Tests/Build mindestens einen realen Smoke- oder Integrationstest gegen den externen Dienst bzw. eine visuelle Prüfung.
- Weise bei Windows/PowerShell-Patches engeren Diff-Kontext und vorgezogene UTF-8-/Encoding-Prüfung an, um Fehltreffer und Iterationsverluste zu vermeiden.

## Planung & Delegation
- Schneide späte, große Implementierungsphasen in mehrere fokussierte Commits pro Subsystem statt eines großen Sammel-Commits, um Review und Fehlerlokalisierung zu erleichtern.
- Rechne bei langen Einzeltasks mit Provider-Kapazitätsausfällen (z. B. "Selected model is at capacity"); stelle sicher, dass Attempt-Retry das Recovery-Artefakt sauber übernimmt.
- Reroute qa-gate-runner-Tasks, die auf interaktive Tool-Freigaben (z. B. Bash) warten und nicht terminal werden, nach angemessener Wartezeit an einen alternativen Gate-Runner.
- Erwarte, dass qa-gate-runner in gesperrten Sandboxen pnpm/node-Gates nicht ausführen kann; plane einen alternativen Ausführungsort/Provider für Gate-Läufe ein.

## Qualitäts-Gates
- Rechne bei codex/gpt-5.6-sol in den Rollen systems-integrator, orchestrator-core und renderer-ui mit wiederkehrendem Nacharbeitsbedarf durch Quality-Gate-Findings; plane eine Vorab-Selbstprüfung ein.
- Rechne bei claude-sonnet-5 in orchestrator-integrator- und qa-gate-runner-Rollen mit Gate-Findings, die aus Vokabular-/Heuristik-False-Positives statt echten Problemen stammen können — prüfe Funde inhaltlich, bevor du Nacharbeit anforderst.
