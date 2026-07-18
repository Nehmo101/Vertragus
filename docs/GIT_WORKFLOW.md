# Git-Handbuch für Vertragus

Dieses Handbuch beschreibt einen sicheren, nachvollziehbaren Workflow für
Entwicklung, parallele Agent-Arbeit, Pull Requests und Wiederherstellung. Alle
Beispiele funktionieren in PowerShell; die Git-Befehle sind unter Linux gleich.

> **Modell-Umstellung:** Vertragus verwendet seit Juli 2026 ein
> **Ein-Branch-Modell**. Der frühere Integrationsbranch `DEV` existiert nicht
> mehr; alles läuft über kurzlebige Branches direkt in `main`.

## 1. Das Branch-Modell

| Branch | Zweck |
|---|---|
| `main` | **Der Trunk.** Immer releasefähig; jeder Push läuft durch die volle CI und triggert `release.yml` (Prerelease-Kanal). Änderungen kommen ausschließlich über grüne Pull Requests an. |
| `retros` | **Daten-Branch** des Retro-Sync-Features (exportierte Run-Retros/Learnings). Niemals Anwendungscode hierhin committen. |
| `feature/*`, `fix/*`, `claude/*` | **Kurzlebige Arbeitsbranches.** Einer pro Änderung, von `main` abgezweigt, per Pull Request zurück, nach dem Merge gelöscht. |
| `vertragus/*` | **Laufzeit-Branches** der Agent-Worktrees (kanonisch; Legacy-Präfix `orca/*` wird weiterhin erkannt und aufgeräumt). Nicht für Menschen; die App räumt sie auf. |

Dazu kommen drei Arbeitsebenen:

1. Der Hauptcheckout ist der Ort, an dem du Branches vergleichst und PRs
   vorbereitest.
2. Jeder Task arbeitet bei aktivierter Isolation in einem eigenen Git-Worktree.
3. Auto-PR kann erfolgreiche Task-Commits in einen zusätzlichen
   Integrations-Worktree übernehmen.

Ein Worktree ist kein Kopieren des Repositories. Mehrere Ordner teilen dasselbe
Git-Repository, haben aber jeweils einen eigenen Branch und Arbeitsstand.

## 2. Repository einmalig einrichten

```powershell
git clone https://github.com/Nehmo101/Vertragus.git
Set-Location Vertragus
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

## 3. main aktuell halten

Wechsle nur mit sauberem oder bewusst gesichertem Arbeitsstand:

```powershell
git status --short
git fetch origin --prune
git switch main
git pull --ff-only origin main
```

`--ff-only` verhindert einen unbeabsichtigten Merge-Commit beim Pull.

## 4. Arbeitsbranch erstellen

Beginne jede Einzelaufgabe auf einem kleinen Branch von `main` aus:

```powershell
git switch main
git pull --ff-only
git switch -c feature/kurzer-feature-name   # oder fix/…, claude/…
```

Gute Branch-Namen beschreiben das Ergebnis:

- `feature/auto-planner-review`
- `fix/headless-timeout`
- `feature/polar-theme`

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
corepack pnpm run ci
corepack pnpm run test:ui-smoke
```

Wenn ein Check nicht lokal laufen kann, schreibe im PR exakt, welcher Check
blockiert war und warum. Niemals einen nicht ausgeführten Test als grün melden.

## 8. Push und Pull Request

```powershell
git push -u origin HEAD
gh pr create `
  --base main `
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

Nach dem Merge den Arbeitsbranch löschen:

```powershell
git push origin --delete feature/kurzer-feature-name
git branch -d feature/kurzer-feature-name
```

## 9. Schutzregeln

- **Kein Force-Push auf `main` und `retros` — ausnahmslos.** Nach einem Rebase
  eines bereits veröffentlichten persönlichen Arbeitsbranches ist höchstens
  `git push --force-with-lease` auf diesem eigenen Branch vertretbar.
- **Kein Direkt-Commit auf `main`.** Jede Änderung geht über einen Pull Request
  mit grüner CI.
- Auto-PR pusht nie mit Force und nie auf den Default-Branch; es arbeitet
  ausschließlich auf eigenen Integrations-Branches.
- Empfohlen: ein GitHub-**Ruleset** für `main` (PR-Pflicht, Status-Checks,
  Bypass verboten), damit die Regeln von der Plattform erzwungen werden —
  siehe CONTRIBUTING.md.

## 10. Parallel mit Vertragus-Worktrees arbeiten

Anzeigen (kanonisch sind das Branch-Präfix `vertragus/` und
`.vertragus-worktrees/`; die Legacy-Namen `orca/` / `.orca-worktrees/` aus der
Zeit vor der Umbenennung werden weiterhin erkannt und aufgeräumt):

```powershell
git worktree list
git branch --list 'vertragus/*'   # kanonisch
git branch --list 'orca/*'        # Legacy-Worktrees vor der Umbenennung
```

Der aktuelle Pfadaufbau ist:

```text
.vertragus-worktrees/<session-id>/<agent-id>
vertragus/<session-id>/<agent-id>
```

Prüfe einen Task ohne den Ordner zu wechseln:

```powershell
git -C .vertragus-worktrees/<session-id>/<agent-id> status --short
git -C .vertragus-worktrees/<session-id>/<agent-id> diff
git -C .vertragus-worktrees/<session-id>/<agent-id> log -1 --oneline
```

Zwei Agents dürfen nicht gleichzeitig dieselben Dateien bearbeiten. Der Planner
verwendet dafür `conflictKeys`; bei manueller Planung muss diese Trennung im
Prompt stehen.

## 11. Änderungen aus einem Task übernehmen

Wenn der Task bereits committed hat:

```powershell
git switch feature/mein-integrationsbranch
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

## 12. Auto-PR sicher konfigurieren

Empfohlener Start:

- Modus: `draft-after-checks`
- Strategie: `aggregate`
- Basisbranch: `main`
- Gate: `corepack pnpm run ci`
- keine automatische Zusammenführung

Beispiel für Quality Gates im Profil:

```text
corepack pnpm run ci
```

Auto-PR benötigt einen Git-Workspace mit `origin`, Push-Berechtigung und eine
gültige `gh`-Anmeldung. Bei Konflikten, Secret-Verdacht oder roten Gates bleibt
der Worktree erhalten und wird als blockiert angezeigt.

## 13. Sicher auf main aktualisieren

Vor dem Rebase:

```powershell
git status --short
git fetch origin
git rebase origin/main
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

## 14. Arbeitsstand zwischenparken

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

## 15. Fehler sicher rückgängig machen

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
unbekannter `vertragus/*`- oder `orca/*`-Branches sind keine normale
Fehlerbehebung. Prüfe vorher
Status, Diff und Commit-Verlauf.

## 16. Worktrees kontrolliert aufräumen

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
git branch --merged main
git branch -d <branch-name>
```

## 17. Releases

Releases entstehen durch Tags auf `main`:

```powershell
git switch main
git pull --ff-only
git tag vX.Y.Z
git push origin vX.Y.Z
```

Jeder Push auf `main` erzeugt zusätzlich automatisch einen Prerelease-Build
über `release.yml`.

## 18. Tägliche Kurzroutine

```powershell
git fetch origin --prune
git status --short --branch
git diff --check
corepack pnpm run ci
git log --oneline --decorate -8
```

Die wichtigste Git-Regel für Multi-Agent-Arbeit lautet: Jeder Task besitzt einen
eindeutigen Branch und Worktree; Integration geschieht über geprüfte Commits,
nicht durch Kopieren oder stilles Überschreiben von Dateien.
