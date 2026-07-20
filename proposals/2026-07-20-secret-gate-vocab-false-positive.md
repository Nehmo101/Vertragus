---
status: proposed
created: 2026-07-20
kind: code
source-retros: 75
source-benchmarks: 0
---

# Vokabular-basierte False-Positives im Secret-/Security-Gate reduzieren

## Kontext

Zwei unabhängige Läufe zeigen identische Gate-Findings zu vermeintlichen Secrets, obwohl der Inhalt manuell als secret-frei verifiziert wurde. Das deutet auf eine zu grobe, rein vokabularbasierte Heuristik im Security-/Secret-Scan-Gate hin, die durch Prompt-Anweisungen an Worker/Reviewer nicht behebbar ist, da sie im Gate selbst liegt.

## Problem-Evidenz

- O00R (Tom Bombadil, Commit 223ac6f1) und t-1 (Beorn, Commit c9a520c6): identische Vokabular-Findings trotz verifiziert secret-freiem Inhalt
- Quality-Gates erfordern Nacharbeit bei orchestrator-integrator: 1 Task(s) mit 2 Gate-Finding(s)

## Auftrag

Lokalisiere im Vertragus-Repository die Secret-/Security-Gate-Implementierung, die Dateiinhalte auf potenzielle Secrets prüft (Kandidaten: ein Security-/Secret-Scan-Modul, das von OrcaMcpServer.ts oder dem qa-gate-runner-Flow aufgerufen wird). Analysiere die aktuelle Erkennungsheuristik und identifiziere, warum reine Dokumentations-Vokabeln (z.B. Begriffe wie 'secret', 'token', 'key' in Fließtext-Kontext ohne tatsächlichen Wert-Zuweisungsmuster wie `=`, `:` gefolgt von einem plausiblen Secret-Wert) als Finding markiert werden. Verbessere die Heuristik so, dass sie zwischen (a) tatsächlichen Wertzuweisungen mit secret-typischen Mustern (z.B. Base64/Hex-Strings hoher Entropie nach Zuweisungsoperator) und (b) reiner Nennung des Begriffs in Prosa/Dokumentation unterscheidet, ohne echte Secret-Leaks zu übersehen. Ergänze Regressionstests mit den beiden dokumentierten False-Positive-Fällen (Vokabular in Markdown-Dokumentation) sowie mindestens einem echten Positiv-Fall (tatsächlicher Secret-Wert), die beide korrekt klassifiziert werden müssen. Abnahmekriterium: pnpm run ci grün.

## Abnahmekriterien

- `pnpm run ci` läuft grün (Lint, Typecheck, Tests, Build).
- Die Änderung adressiert nachweislich die oben belegte Schwäche.
