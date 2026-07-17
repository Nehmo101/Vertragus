# Retro-Sync & Selbstverbesserungs-Loop

Vertragus sammelt am Ende jedes Orchestrator-Laufs eine Retrospektive
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
   Eintrag anpassen; Default ist `Nehmo101/Vertragus@retros`. Der Branch
   wird beim ersten Export automatisch als Orphan angelegt.
2. **Im Repo:** Secret `ANTHROPIC_API_KEY` anlegen
   (Settings → Secrets and variables → Actions) — nötig, sobald mindestens
   `ORCA_RETRO_MIN_NEW` (interner Bezeichner, Migration geplant) neue Retros
   synthetisiert werden. Der vom Workflow
   bereitgestellte `GITHUB_TOKEN` braucht keine manuelle Secret-Konfiguration;
   der Workflow fordert dafür `contents: write` und `pull-requests: write` an.
   In den Actions-Einstellungen muss das Erstellen von Pull Requests durch
   GitHub Actions erlaubt sein.
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
  (Default `claude-sonnet-5`).

### Bootstrap beim ersten Analyse-Lauf

Ein schreibender Lauf (`--write`, wie im wöchentlichen Workflow) prüft vor
dem Mindestmengen-Gate, ob die drei langlebigen Analyse-Artefakte vorhanden
sind. Fehlende Artefakte werden einzeln und ohne Überschreiben bestehender
Inhalte angelegt:

- `overlay/learnings.md` als leeres, schema-konformes Overlay (0 Regeln,
  damit deutlich unter 80 Zeilen / 16 KB),
- `proposals/.gitkeep`, damit das anfänglich leere Verzeichnis auf Git
  erhalten bleibt,
- `state/last-analysis.json` mit Version 1, leeren `analyzedPaths` und
  Zeitmarken `0`.

Das passiert auch bei weniger als `--min-new` neuen Retros. In diesem Fall
ruft der Lauf kein Modell auf und der Review-PR enthält nur den Bootstrap.
Sind bereits genug Retros vorhanden, ersetzt dieselbe Analyse das leere
Overlay sofort durch das validierte Synthese-Ergebnis und schreibt den neuen
Fortschrittsstand. Dry-Runs melden fehlende Seed-Artefakte, verändern aber
keine Dateien.

Unbekannte zusätzliche Envelope- oder Payload-Felder werden ignoriert; die
Analyse selektiert nur ihre benötigten Pflichtfelder. Erweiterungen anderer
Tracks müssen deshalb additiv und optional bleiben.

### Aktivierung verifizieren

1. Sicherstellen, dass der `retros`-Branch durch mindestens einen App-Export
   existiert und `retro-analysis.yml` auf dem Default-Branch liegt.
2. Unter Actions → **Retro Analysis** einen `workflow_dispatch` starten.
3. Im Log die Zeilen `Bootstrap angelegt:` oder den normalen Analysebericht
   prüfen und den erzeugten PR mit Basis `retros` kontrollieren.
4. Nach menschlicher Prüfung den PR mergen und auf `retros` verifizieren,
   dass `overlay/learnings.md`, `proposals/.gitkeep` und
   `state/last-analysis.json` vorhanden sind. Ab dann läuft der Cron montags
   um 06:00 UTC; bestehende Artefakte bleiben beim nächsten Lauf erhalten.

## Review-Prozess

1. Die Action öffnet einen PR `retro-analysis/<datum>` gegen `retros`.
2. **Overlay prüfen:** Sind alle Regeln durch die Daten belegt? Keine
   Secrets/Nutzerziele/Workspace-Pfade? Max. 15 Regeln, imperativ, deutsch.
3. **Proposals prüfen:** Jeder Brief unter `proposals/` ist ein
   eigenständiger Claude-Code-Auftrag (Kontext, Evidenz, Auftrag,
   Abnahmekriterien). Umsetzen heißt: Brief als Prompt in eine Claude-Code-
   Session gegen `main` geben; der resultierende Code-PR durchläuft die
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

## Retro-Gate (in-Session)

Damit qualitative Modell-Learnings nicht verloren gehen, ist das Retro ein
Pflicht-Gate statt einer Prosa-Bitte im Systemprompt:

- **Erfüllungs-Kriterium:** Eine Retro-Karte gilt erst als erledigt, wenn der
  Orchestrator über `record_retro` eigene Learnings (`source: 'orchestrator'`)
  eingetragen hat. Die automatische Heuristik-Retro (`source: 'auto-retro'`)
  erfasst nur Zahlen und erfüllt das Gate **nicht**.
- **await_plan:** Bei einem terminalen Lauf mit offenem Retro liefert
  `await_plan` additiv `retroPending: true` und ein ausfüllfertiges
  `retroDraft` (Ausgabe von `buildRetroDraft` für diesen `planId`). Ist das
  Retro erfasst, ist `retroPending: false` und kein Gerüst enthalten.
- **set_goal-Nudge:** Wird ein neues Ziel gesetzt, während der letzte
  terminale Lauf noch offen ist, gibt `set_goal` einen nicht-blockierenden
  `retroReminder` (mit `priorPlanId`) zurück.
- **Symmetrisches Template (E):** `get_retro_draft`/das eingebettete Gerüst
  liefert je Modell zwei Slots — `learningTemplates: [strength, weakness]` —
  mit exaktem Modellnamen. `renderRetroDraftForPrompt` erzeugt daraus eine
  deterministische, menschenlesbare Vorlage. Ehrlichkeit bleibt gewahrt: ein
  Slot darf leer bleiben, wenn kein Beleg vorliegt — keine erfundene Schwäche.
- Selftest-Läufe (`REMOTE_SELFTEST_SESSION_ID`) sind vom Gate und vom Nudge
  ausgenommen.
- Alle Felder sind **additiv** und optional; die Offline-Analyse-Pipeline
  bleibt schema-tolerant.
