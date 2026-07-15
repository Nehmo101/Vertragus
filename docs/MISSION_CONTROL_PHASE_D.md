# Mission Control — Phase D

Stand: 2026-07-15

Phase D dockt die zusätzlichen Roadmap-Features an dieselbe Engine-, Snapshot-
und Sicherheitsgrenze an, die Mission Control A–C verwendet. Es gibt keine
Remote-Shell, keine Pfadparameter und keinen fernsteuerbaren Agent-stdin.

## End-to-End-Budgets

- Provider-Telemetrie fließt live von den Headless-Adaptern in Task, Session,
  Desktop und Mobile.
- Token- und Kosten-Caps pausieren laufende Worker fail-closed. Eine Fortsetzung
  ist pro Task explizit.
- Die UI zeigt die Messabdeckung (`tasksReported/tasksTotal`) getrennt für Token
  und Kosten. Nicht gemeldete Provider-Werte werden nicht als gemessene Null
  ausgegeben.
- Caps sind im Engine-Snapshot persistent und remote nur mit der Capability
  `budget` änderbar.

## Eigenständige Desktop-Approval-Inbox

`#/approvals` projiziert aus allen Session-Snapshots:

- Plan-Reviews,
- PR-Veröffentlichungen,
- interne Tool-Permissions,
- blockierte Tasks,
- überschrittene Budgets und
- erkannte Provider-Limits.

Die Desktop-Aktionen besitzen einzeln typisierte IPC-Methoden. Mobile verwendet
dieselben Engine-Methoden über die authentifizierte Command-Whitelist.

## Provider-Fallback

`task.fallback` akzeptiert ausschließlich eine Task-ID und benötigt die eigene,
standardmäßig deaktivierte Capability `provider-fallback`. Orca prüft intern ein
echtes Limit-Signal, wählt selbst einen anderen konfigurierten Provider und setzt
aus dem gesicherten Recovery-Worktree fort. Prompt, Provider-stdin und Pfad
verlassen den Main-Prozess nicht.

Automatische Plan-Recovery bei einem terminalen Rate-Limit bleibt aktiv. Der
neue Befehl ergänzt den sicheren manuellen Eingriff bei einem hängenden oder
bereits terminalen Limit-Fall.

## Diff & Merge Center

Desktop `#/changes` und der Mobile-Tab `Merge` zeigen eine pfadfreie Projektion
der vorbereiteten, blockierten und veröffentlichten Task-Commits einschließlich
Remote-CI-Status. Diffs bleiben bytebegrenzt, redigiert und hinter `diff`.
Veröffentlichung und Ablehnung verwenden weiterhin ausschließlich das vorhandene
PR-Gate `publication.approve/reject`; es gibt keinen Remote-Merge- oder
Git-Command-String.

Authentifizierte Remote-Snapshots entfernen absolute `worktree`-Pfade. Das
Integrationsmodell enthält nur Task-ID, Titel, Commit-/Branch-Identifier,
Gate-Anzahl, PR- und CI-Status.
