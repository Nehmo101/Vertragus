# Retro-Sync & Selbstverbesserungs-Loop

Orca-Strator sammelt am Ende jedes Orchestrator-Laufs eine Retrospektive
(automatisch aus dem Task-Graphen plus qualitativ via `record_retro`). Der
Retro-Sync macht daraus einen geschlossenen Verbesserungs-Loop:

```
 Lauf beendet ──▶ Retro (electron-store) ──▶ Export-Queue ──▶ Branch `retros`
                                                                   │
        Systemprompt ◀── overlay/learnings.md ◀── Review-PR ◀── Retro-Analyse
        (Injection)          (nach Merge)        (Mensch!)     (GitHub Action)
                                                     │
                                              proposals/*.md
                                       (Claude-Code-Briefs für Code-Änderungen)
```

**Der menschliche Merge des Analyse-PRs ist das Sicherheits-Gate.** Weder das
Overlay noch die Proposals wenden sich selbst an.

## Komponenten

| Baustein | Ort | Zweck |
| --- | --- | --- |
| Export-Queue | `src/main/orchestrator/retroExport.ts` | Persistente Offline-Queue; pusht Retros/Benchmarks/Learnings als redigierte JSON-Envelopes via GitHub Contents API |
| REST-Client | `src/main/integrations/githubContents.ts` | Contents/Git-Data-API, Orphan-Bootstrap des Branches, Branch-Guard gegen `main`/`master`/Default-Branch |
| Overlay | `src/main/orchestrator/promptOverlay.ts` | Lädt `overlay/learnings.md` (TTL-Cache in userData) und injiziert es als „Gelerntes Teamwissen“ in den Orchestrator-Systemprompt |
| Analyse | `src/shared/retroAnalysis.ts` + `scripts/retro-analyze.ts` | Aggregiert neue Retros, lässt Claude das Overlay revidieren und Proposals generieren |
| Automation | `.github/workflows/retro-analysis.yml` | Wöchentlicher Lauf, öffnet Review-PR gegen `retros` |

## Branch-Layout (`retros`, Orphan-Branch)

```
README.md                                Zweck & Struktur
runs/<JJJJ>/<MM>/<retro-id>.json         eine Retrospektive pro Planlauf (UTC-Monat)
benchmarks/<JJJJ>/<MM>/<record-id>.json  Benchmark-Bewertungen
learnings/<machineId>.json               gemergter Modellwissen-Snapshot je Installation
overlay/learnings.md                     geprüftes Regelwerk → Systemprompt-Injection
proposals/<JJJJ-MM-TT>-<slug>.md         generierte Verbesserungs-Briefs
state/last-analysis.json                 Fortschrittsmarke der Analyse
```

Jede Datei unter `runs/`, `benchmarks/`, `learnings/` ist ein Envelope
`{ version, exportedAt, app, machineId, kind, payload }`. `machineId` ist ein
pseudonymer, stabiler Hash (kein Hostname). Alle Payloads laufen vor dem
Export durch die Secret-Redaction (`redactDiagnosticValue`).

## Einrichtung

1. **In der App:** Sidebar → Infrastruktur → „Retro-Sync“ aktivieren
   (GitHub-Verbindung vorausgesetzt). Ziel-Repo/Branch per Doppelklick auf den
   Eintrag anpassen; Default ist `Nehmo101/Orca-Strator@retros`. Der Branch
   wird beim ersten Export automatisch als Orphan angelegt.
2. **Im Repo:** Secret `ANTHROPIC_API_KEY` anlegen
   (Settings → Secrets and variables → Actions) — nötig für die Analyse.
3. **Hinweis:** `schedule`-Workflows laufen nur vom Default-Branch (`main`).
   Bis `retro-analysis.yml` dort angekommen ist, den Workflow per
   `workflow_dispatch` manuell starten.

## Betrieb

- **Export:** läuft automatisch nach jedem terminalen Lauf. Offline-Fälle
  landen in einer persistenten Queue (Backoff, max. 200 Einträge) und werden
  beim App-Start, alle 15 Minuten oder per Sidebar-Button „Sync“ nachgeholt.
  Der Export kann einen Lauf nie blockieren oder fehlschlagen lassen.
- **Overlay:** Änderungen an `overlay/learnings.md` (nur per gemergtem PR!)
  wirken nach App-Neustart bzw. spätestens nach 30 Minuten TTL. Begrenzt auf
  80 Zeilen / 16 KB; bei Netzwerkfehlern gilt der letzte lokale Cache.
- **Analyse lokal ausführen:**

  ```bash
  git clone --branch retros --single-branch <repo-url> /tmp/retros
  ANTHROPIC_API_KEY=… pnpm run retro:analyze -- --dir /tmp/retros            # Dry-Run
  ANTHROPIC_API_KEY=… pnpm run retro:analyze -- --dir /tmp/retros --write    # schreiben
  ```

  Unter `--min-new` (Default 3, env `ORCA_RETRO_MIN_NEW`) neuen Retros wird
  übersprungen. Das Modell ist per `ORCA_RETRO_MODEL` überschreibbar
  (Default `claude-opus-4-8`).

## Review-Prozess

1. Die Action öffnet einen PR `retro-analysis/<datum>` gegen `retros`.
2. **Overlay prüfen:** Sind alle Regeln durch die Daten belegt? Keine
   Secrets/Nutzerziele/Workspace-Pfade? Max. 15 Regeln, imperativ, deutsch.
3. **Proposals prüfen:** Jeder Brief unter `proposals/` ist ein
   eigenständiger Claude-Code-Auftrag (Kontext, Evidenz, Auftrag,
   Abnahmekriterien). Umsetzen heißt: Brief als Prompt in eine Claude-Code-
   Session gegen `DEV` geben; der resultierende Code-PR durchläuft die
   normale CI. Danach den Proposal-Status im Front-Matter pflegen
   (`proposed` → `accepted`/`done`/`rejected`).
4. Merge des Analyse-PRs aktiviert das neue Overlay für alle Installationen.

## Sicherheits-Eigenschaften

- Branch-Guard: Schreiben auf `main`/`master`/Default-Branch wird sowohl bei
  der Config-Validierung als auch vor jedem Push verweigert.
- Secret-Redaction vor jedem Export; Größen-Caps für Payloads (256 KB),
  Overlay (16 KB) und Queue (200).
- Analyse-PRs gegen `retros` triggern die CI-Matrix nicht
  (`branches-ignore` in `ci.yml`); die Action schreibt nie auf Code-Branches.
- Konservativitäts-Gate im Code: nur Learnings mit ≥ 2 Beobachtungen,
  ≥ 2 unabhängigen Vorkommen oder Benchmark-Beleg erreichen die Synthese.
