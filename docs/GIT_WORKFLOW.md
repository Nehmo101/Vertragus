# Git-Handbuch für Orca-Strator

Dieses Handbuch beschreibt einen sicheren, nachvollziehbaren Workflow für
Entwicklung, parallele Agent-Arbeit, Pull Requests und Wiederherstellung. Alle
Beispiele funktionieren in PowerShell; die Git-Befehle sind unter Linux gleich.

## 1. Das Arbeitsmodell

Orca-Strator verwendet drei Ebenen:

1. Der Hauptcheckout ist der Ort, an dem du Branches vergleichst und PRs
   vorbereitest.
2. Jeder Task arbeitet bei aktivierter Isolation in einem eigenen Git-Worktree.
3. Auto-PR kann erfolgreiche Task-Commits in einen zusätzlichen
   Integrations-Worktree übernehmen.

Ein Worktree ist kein Kopieren des Repositories. Mehrere Ordner teilen dasselbe
Git-Repository, haben aber jeweils einen eigenen Branch und Arbeitsstand.

## 2. Repository einmalig einrichten

```powershell
git clone https://github.com/Nehmo101/Orca-Strator.git
Set-Location Orca-Strator
corepack pnpm install --frozen-lockfile
git remote -v
git status --short --branch
```

Prüfe vor der Arbeit, dass `origin` auf das erwartete Repository zeigt. Lege
Tokens niemals in Dateien des Repositories ab; `gh auth login` speichert die
GitHub-Anmeldung außerhalb des Projekts.

```powershell
gh auth login
gh auth status
```

## 3. DEV aktuell halten

Wechsle nur mit sauberem oder bewusst gesichertem Arbeitsstand:

```powershell
git status --short
git fetch origin --prune
git switch DEV
git pull --ff-only origin DEV
```

`--ff-only` verhindert einen unbeabsichtigten Merge-Commit beim Pull. Existiert
`DEV` lokal noch nicht:

```powershell
git fetch origin
git switch --track -c DEV origin/DEV
```

Existiert der Remote-Branch noch nicht:

```powershell
git switch -c DEV
git push -u origin DEV
```

## 4. Feature-Branch erstellen

Für normale Änderungen bleibt `DEV` der Integrationsbranch. Beginne eine
Einzelaufgabe auf einem kleinen Branch:

```powershell
git switch DEV
git pull --ff-only
git switch -c codex/kurzer-feature-name
```

Gute Branch-Namen beschreiben das Ergebnis:

- `codex/auto-planner-review`
- `codex/fix-headless-timeout`
- `codex/polar-theme`

Keine Modellnamen, Personennamen oder Ticketromane im Branch-Namen.

## 5. Vor und nach jeder Änderung prüfen

```powershell
git status --short --branch
git diff --stat
git diff
git diff --check
```

`git diff --check` findet unter anderem nachgestellte Leerzeichen und fehlerhafte
Konfliktmarker. Prüfe auch neue, noch nicht versionierte Dateien:

```powershell
git ls-files --others --exclude-standard
```

## 6. Kleine, ehrliche Commits

Stage nur Dateien, die zu einem fachlichen Schritt gehören:

```powershell
git add -- src/main/orchestrator/Engine.ts src/shared/orchestrator.ts
git diff --cached
git commit -m "feat: add validated DAG execution"
```

Empfohlene Präfixe:

- `feat:` neues Nutzerverhalten
- `fix:` Fehlerkorrektur
- `test:` Tests ohne Produktänderung
- `docs:` Dokumentation
- `refactor:` interne Änderung ohne neues Verhalten
- `chore:` Werkzeug-, Build- oder Abhängigkeitsarbeit

Ein Commit darf groß sein, wenn sein Verhalten untrennbar zusammengehört. Er
sollte aber keine zufälligen Formatierungen oder fremde Änderungen enthalten.

## 7. Qualitätsprüfung vor Push

```powershell
corepack pnpm peers check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

Wenn ein Check nicht lokal laufen kann, schreibe im PR exakt, welcher Check
blockiert war und warum. Niemals einen nicht ausgeführten Test als grün melden.

## 8. Push und Pull Request

```powershell
git push -u origin HEAD
gh pr create `
  --base DEV `
  --head (git branch --show-current) `
  --draft `
  --title "feat: kurze Ergebnisbeschreibung" `
  --body "Implementiert ..."
```

Ein guter PR-Text enthält:

- Ausgangsproblem und gewünschtes Ergebnis
- wichtigste Architekturentscheidungen
- sichtbare Verhaltensänderungen
- ausgeführte Checks mit Ergebnis
- bekannte Grenzen oder manuelle Prüfschritte

Erst nach Review und grüner CI wird ein Draft als bereit markiert:

```powershell
gh pr ready
gh pr checks --watch
```

## 9. Parallel mit Orca-Worktrees arbeiten

Anzeigen:

```powershell
git worktree list
git branch --list 'orca/*'
```

Der aktuelle Pfadaufbau ist:

```text
.orca-worktrees/<session-id>/<agent-id>
orca/<session-id>/<agent-id>
```

Prüfe einen Task ohne den Ordner zu wechseln:

```powershell
git -C .orca-worktrees/<session-id>/<agent-id> status --short
git -C .orca-worktrees/<session-id>/<agent-id> diff
git -C .orca-worktrees/<session-id>/<agent-id> log -1 --oneline
```

Zwei Agents dürfen nicht gleichzeitig dieselben Dateien bearbeiten. Der Planner
verwendet dafür `conflictKeys`; bei manueller Planung muss diese Trennung im
Prompt stehen.

## 10. Änderungen aus einem Task übernehmen

Wenn der Task bereits committed hat:

```powershell
git switch codex/mein-integrationsbranch
git cherry-pick <commit-sha>
```

Bei Konflikten:

```powershell
git status
# Konflikte in den genannten Dateien lösen
git add -- <geloeste-dateien>
git cherry-pick --continue
```

Wenn die Auflösung falsch begonnen wurde:

```powershell
git cherry-pick --abort
```

Das stellt den Zustand vor dem Cherry-Pick wieder her und ist sicherer als ein
Hard Reset.

## 11. Auto-PR sicher konfigurieren

Empfohlener Start:

- Modus: `draft-after-checks`
- Strategie: `aggregate`
- Basisbranch: `DEV`
- Gates: Lint, Typecheck, Tests und Build
- keine automatische Zusammenführung

Beispiel für Quality Gates im Profil:

```text
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

Auto-PR benötigt einen Git-Workspace mit `origin`, Push-Berechtigung und eine
gültige `gh`-Anmeldung. Bei Konflikten, Secret-Verdacht oder roten Gates bleibt
der Worktree erhalten und wird als blockiert angezeigt.

## 12. Sicher auf DEV aktualisieren

Vor dem Rebase:

```powershell
git status --short
git fetch origin
git rebase origin/DEV
```

Bei Konflikten gilt dieselbe Regel: lösen, gezielt stagen, fortsetzen.

```powershell
git add -- <geloeste-dateien>
git rebase --continue
```

Abbrechen:

```powershell
git rebase --abort
```

Nach einem Rebase eines bereits veröffentlichten persönlichen Feature-Branches
ist höchstens `git push --force-with-lease` vertretbar. Auf `DEV`, `main` und
gemeinsam genutzten Branches ist Force-Push tabu.

## 13. Arbeitsstand zwischenparken

Bevorzugt ist ein kleiner WIP-Commit auf dem eigenen Branch. Wenn das nicht
passt:

```powershell
git stash push --include-untracked -m "wip: planner ui"
git stash list
git stash show --patch stash@{0}
git stash apply stash@{0}
```

Nutze zunächst `apply`, nicht `pop`; so bleibt der Stash erhalten, bis du das
Ergebnis geprüft hast.

## 14. Fehler sicher rückgängig machen

Noch nicht gestagte Änderung einer einzelnen Datei verwerfen:

```powershell
git restore -- path/zur/datei
```

Datei aus dem Index nehmen, Inhalt aber behalten:

```powershell
git restore --staged -- path/zur/datei
```

Einen bereits veröffentlichten Commit rückgängig machen:

```powershell
git revert <commit-sha>
```

`git reset --hard`, das rekursive Löschen von Worktrees und das Löschen
unbekannter `orca/*`-Branches sind keine normale Fehlerbehebung. Prüfe vorher
Status, Diff und Commit-Verlauf.

## 15. Worktrees kontrolliert aufräumen

Erst prüfen:

```powershell
git worktree list
git -C <worktree-pfad> status --short
git -C <worktree-pfad> log -1 --oneline
```

Nur einen bestätigten, sauberen Worktree entfernen:

```powershell
git worktree remove <worktree-pfad>
git worktree prune
```

Den zugehörigen Branch erst löschen, wenn sein Commit integriert oder bewusst
verworfen wurde:

```powershell
git branch --merged DEV
git branch -d <branch-name>
```

## 16. Tägliche Kurzroutine

```powershell
git fetch origin --prune
git status --short --branch
git diff --check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
git log --oneline --decorate -8
```

Die wichtigste Git-Regel für Multi-Agent-Arbeit lautet: Jeder Task besitzt einen
eindeutigen Branch und Worktree; Integration geschieht über geprüfte Commits,
nicht durch Kopieren oder stilles Überschreiben von Dateien.
