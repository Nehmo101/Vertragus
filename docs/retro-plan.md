# Retro im neuen Vertragus — Befund aus dem Archiv und Umsetzungsplan

Das alte Vertragus ([Vertragus-Archiv](https://github.com/Nehmo101/Vertragus-Archiv))
hatte einen vollständigen Selbstverbesserungs-Loop: Läufe wurden retrospektiv
ausgewertet, Modellwissen wurde gesammelt, installationsübergreifend
synchronisiert, offline analysiert und als geprüftes Regelwerk zurück in die
Agenten-Prompts injiziert. Dieses Dokument fasst zusammen, was davon trägt, was
nachweislich schiefging, und wie die Funktionalität — verbessert — im neuen
Vertragus etabliert wird.

Referenzen der Form `Archiv: pfad:zeile` zeigen auf den Stand
`Vertragus-Archiv@48cc6e1`.

## 1. Was die alte Retro war

Drei Schichten (Archiv: `docs/retro-sync.md:10-26`):

```
Lauf beendet ──▶ Retro (electron-store) ──▶ Export-Queue ──▶ Branch `retros`
                                                                  │
       Systemprompt ◀── overlay/learnings.md ◀── Review-PR ◀── Retro-Analyse
       (Injection)          (nach Merge)        (Mensch!)     (GitHub Action)
```

**Schicht A — In-Session-Retro.** Nach jedem terminalen Lauf aggregierte die
Engine deterministisch Statistiken pro Provider/Modell (Task-Bilanz, Fehler
nach Ursache, Dauer, Tokens, Kosten) und leitete konservative heuristische
Learnings ab. Zusätzlich war ein *qualitatives* Retro des Orchestrator-Modells
ein Gate: `await_plan` lieferte bei offenem Retro ein vorausgefülltes Draft mit
zwei leeren Slots (`strength`, `weakness`), die das Modell nur noch mit
`insight`/`evidence` füllte und per `record_retro` ablieferte.

**Schicht B — Delegations-Kalibrierung.** Vor dem Lauf gab das Modell eine
solo/delegate-Prognose ab; nach dem Lauf verglich die Engine Prognose,
strukturelle Schätzung und reales Ergebnis und meldete systematischen Bias
(`over-delegated`/`under-delegated`) beim nächsten Ziel zurück.

**Schicht C — Retro-Sync.** Opt-in-Export der Retro-Karten auf einen dedizierten
Orphan-Branch `retros`, wöchentliche Offline-Analyse per GitHub Action + LLM,
Ergebnis als Review-PR (Regelwerk `overlay/learnings.md` + max. 3
Verbesserungs-Briefs). **Einzige Aktivierung war der menschliche Merge**; nach
dem Merge injizierte jede Installation das Overlay als „Gelerntes Teamwissen"
in die Systemprompts.

## 2. Was sich bewährt hat — wird übernommen

1. **Schichtentrennung.** Reine Datencontracts → pure Analysefunktionen →
   Persistenz → Engine-Verdrahtung. Der komplette Loop war ohne Electron
   unit-testbar; die Analyse-CLI nutzte exakt dieselbe Logik wie die App
   (Archiv: `src/shared/retro/`, ~1300 Testzeilen).
2. **Draft-vor-Record.** Die Engine füllt alle Fakten vor (exakte Modellnamen,
   Zahlen), das Modell ergänzt nur `insight`/`evidence`. Verhindert
   halluzinierte Statistiken und macht Learnings attribuierbar
   (Archiv: `src/shared/retro/runAnalysis.ts:184-236`).
3. **Symmetrische Slots mit Ehrlichkeitsklausel.** Ein Stärke- und ein
   Schwäche-Slot, aber „ein Slot darf leer bleiben — erfinde keine Schwäche"
   (Archiv: `runAnalysis.ts:129-134`). Ohne das produzieren Modelle
   pflichtschuldig erfundene Schwächen.
4. **Doppeltes Konservativitäts-Gate im Code, nicht nur im Prompt.** Lokal:
   Schwäche erst ab 2 auswertbaren Tasks. Remote: ≥2 Beobachtungen oder ≥2
   unabhängige Quellen oder Benchmark-Beleg (Archiv:
   `retroAnalysis.ts:319-358`).
5. **Infra ≠ Modellfehler.** Ohne die Trennung `infra`/`cancelled`/`model`
   wurden historisch 5 von 7 fehlgeschlagenen Läufen fälschlich dem Modell
   angelastet (Archiv: `docs/RETRO_IMPROVEMENT_PLAN.md:9-30`).
6. **Nebenpfad-Fehlerresistenz.** Retro, Export und Overlay dürfen einen Lauf
   nie fehlschlagen lassen; Overlay-Read ist synchron aus dem Disk-Cache, damit
   Launches nie auf Netzwerk warten.
7. **Sicherheitsmodell.** Orphan-Datenbranch mit doppeltem Branch-Guard,
   Secret-Redaction vor jedem Export, pseudonyme `machineId`, Größen-Caps
   überall, Mensch als einziges Aktivierungs-Gate (Archiv:
   `docs/retro-sync.md:160-169`).
8. **Merge statt Duplikation.** Learnings haben einen stabilen Dedup-Key;
   Wiederbeobachtung verstärkt (`observations++`) statt zu duplizieren, mit
   Caps 12/Modell und 400 global (Archiv: `learnings.ts:33-101`).

## 3. Was schiefging — und die Konsequenz daraus

| Befund im Archiv | Konsequenz für die Neuimplementierung |
| --- | --- |
| **Auto-Retros wurden nie exportiert** — Export hing als Nebeneffekt an `record_retro`; schwieg das Modell, blieb der Lauf unsichtbar (Archiv: `Engine.ts:4309` einziger Aufrufer). Doku behauptete das Gegenteil. | Export ist ein eigener, idempotenter Schritt hinter *jeder* terminalen Retro — unabhängig davon, ob das qualitative Retro je kommt. |
| **Einmal-Export** — `exportQueuedAt == null` als Guard; ein Nachtrag von Learnings erreichte den Branch nie (Archiv: `Engine.ts:4300`). | Export mit Update-Semantik: Re-Enqueue bei inhaltlicher Änderung, Datei auf dem Branch wird überschrieben (SHA-basiertes Contents-API-Update existierte bereits). |
| **Doppelzählung von Heuristik-Learnings** bei ad-hoc `record_retro` (Archiv: `Engine.ts:4281`). | Eine einzige Merge-Stelle: Heuristik-Learnings werden genau einmal, beim Terminal-Werden des Laufs, gemerged; das qualitative Retro trägt ausschließlich `orchestrator`-Learnings bei. |
| **Regex-Klassifikation der Fehlerursachen** — hart kodierte, sprachgemischte Patterns; jeder neue Toolchain-Fehlertext wurde als Modellfehler gewertet (Archiv: `runAnalysis.ts:21-32`). | Strukturiertes `failureKind` an der Quelle: Worker/Gates liefern die Ursache typisiert mit, Freitext-Heuristik nur als Fallback für Alt-Daten. |
| **Kein Retro-Gate für Solo-Läufe** — nur eine Prompt-Bitte (Archiv: `soloLaunch.ts:40`). | Das Gate hängt am Lauf-Lebenszyklus, nicht am Modus. Wo es keinen `await_plan`-Rückkanal gibt, erinnert das nächste Tool-Ergebnis (nicht blockierend, aber sichtbar). |
| **Engine-Kopplung** — die gesamte Retro-Verdrahtung saß in einer Engine mit 105 privaten Feldern; der eigene Verbesserungsplan nennt das als bewusst nicht mehr angefasstes Risiko (Archiv: `RETRO_IMPROVEMENT_PLAN.md:154-162`). | Eigenes Modul `RetroCoordinator` mit schmalem Interface von Anfang an; `Workspace` meldet nur Lebenszyklus-Ereignisse. |
| **Heuristisches „letzter terminaler Lauf"** — bei parallelen Sessions konnte das Draft zum falschen Lauf gehören (Archiv: `Engine.ts:4125-4142`). | Retros sind immer explizit an eine `workspaceId`/`runId` gebunden; kein „neuester"-Fallback über Session-Grenzen. |
| **Proposal-Status manuell** — vergessene Pflege ließ die Analyse dieselben Vorschläge erneut generieren (Archiv: `docs/retro-sync.md:143-147`). | Statuspflege automatisieren (PR-Label bzw. Commit-Trailer schließt das Proposal beim Merge). |
| **Stall bei ruhigen Installationen** — der Analyse-Trigger brauchte nachträglich einen max-age-Zaun (Archiv: `retroAnalysis.ts:182-189`). | min-new **und** max-age von Tag eins an. |

## 4. Zielbild im neuen Vertragus

Das neue Vertragus ist bewusst kleiner: `Workspace`/`WorkspaceManager` statt
Engine, ein schlanker MCP-Server (`start_agent`, `send_to_agent`,
`await_events`, `list_agents`, `stop_agent`, `read_output`), electron-store in
`src/main/store/settings.ts`, IPC in `src/main/appIpc.ts`. Die Retro fügt sich
dort so ein:

```
src/shared/retro/            Contracts + pure Analyse (elektron-frei)
  contracts.ts               RunRetro, ModelLearning, RetroDraft, FailureKind …
  runAnalysis.ts             Stats-Aggregation, Draft-Bau, Heuristik-Learnings
  learnings.ts               Dedup-Key, Merge mit Caps
  calibration.ts             Delegations-/Kalibrierungs-Analyse (Phase 3)
src/main/retro/              Koordination + Persistenz
  RetroCoordinator.ts        hört auf Workspace-Lebenszyklus, baut Drafts,
                             nimmt record_retro entgegen, merged Learnings
  retroStore.ts              runRetros / modelLearnings im electron-store
  retroExport.ts             idempotente Export-Queue (Phase 4)
  promptOverlay.ts           Overlay-Cache + Injection (Phase 4)
src/main/mcp/toolsOrchestrator.ts   + get_retro_draft / record_retro
src/main/appIpc.ts           + read-only Kanäle retro:list / retro:learnings
src/renderer/src/panel/      Retro-Sektion pro Workspace-Karte (eingeklappt)
```

Datenfluss pro Lauf: `Workspace` wird terminal → `RetroCoordinator` baut aus
den Agent-Records die deterministische Retro (Stats + Heuristik-Learnings,
einmalig gemerged) → Draft liegt für das Orchestrator-Modell bereit →
`record_retro` reichert qualitativ an → Export-Queue (falls Sync aktiv) →
Panel zeigt „Gelerntes" → beim nächsten `start_agent` fließen
`learnedStrengths`/`learnedWeaknesses` und das Overlay in Prompt und
Rollenwahl ein.

## 5. Umsetzungsplan

Jede Phase ist eigenständig mergebar, `corepack pnpm run ci` ist das Gate.
Reihenfolge = Abhängigkeitsordnung; nichts Späteres blockiert Früheres.

### Phase 0 — Fundament: Beobachtbarkeit der Läufe
Der neue `Workspace` kennt heute Status und Fenster, aber keine strukturierte
Task-Bilanz. Bevor irgendeine Retro entsteht, braucht jeder Agent-Record die
Felder, aus denen sie gebaut wird: Provider + exaktes Modell, Start/Ende,
Exit-Ursache als **typisiertes** `failureKind`
(`infra | cancelled | model | unknown`), optionale Kosten-/Token-Zähler, sofern
der Provider sie liefert.
*Akzeptanz:* Ein beendeter Lauf hinterlässt im Speicher eine vollständige,
serialisierbare Lauf-Bilanz; kein UI, kein Store.

### Phase 1 — In-Session-Retro (Schicht A, lokal)
`src/shared/retro/` (contracts, runAnalysis, learnings — sinngemäß aus dem
Archiv portiert, um `failureKind` bereinigt), `RetroCoordinator`, `retroStore`
(Caps: 50 Retros, 12 Learnings/Modell, 400 global). MCP-Tools
`get_retro_draft` und `record_retro` mit Draft-vor-Record-Muster,
Ehrlichkeitsklausel und dem Gate „mindestens ein `orchestrator`-Learning".
Prompt-Block „Retrospektive (verbindlich)" im Orchestrator-Launch.
*Akzeptanz:* Terminaler Lauf erzeugt deterministische Retro; `record_retro`
merged qualitative Learnings exakt einmal; Doppelzählungs-Regressionstest aus
dem Archiv-Befund ist grün.

### Phase 2 — Rückfluss + Panel
`list_agents`/`start_agent` liefern `learnedStrengths`/`learnedWeaknesses`
(+ Track-Record via Wilson-Score ab 3 Beobachtungen) zurück; read-only
IPC-Kanäle; eingeklappte Panel-Sektion „Gelerntes" auf der Workspace-Karte
(letzte Retro, Learnings mit ▲/▼, Cap 6). `revoke_learning` als Korrektur-Tool.
*Akzeptanz:* Ein Learning aus Lauf N ist in Lauf N+1 im Tool-Ergebnis und im
Panel sichtbar; Widerruf entfernt es aus beiden.

### Phase 3 — Delegations-Kalibrierung (Schicht B)
`estimate_delegation` vor dem Lauf, Vergleich Prognose/Struktur/Ergebnis nach
dem Lauf, `calibrationHint` bei systematischem Bias über die letzten 6 Läufe.
Bewusst nach Phase 2: braucht stabile Task-Bilanz und Retro-Karte.
*Akzeptanz:* Verdict + Selbstkalibrierung erscheinen in der Retro-Karte;
Bias-Hinweis erscheint erst ab nachweisbarem Muster.

### Phase 4 — Retro-Sync (Schicht C)
Export-Queue (offline-tolerant, idempotent, Update-Semantik statt
Einmal-Export), Orphan-Branch `retros` mit Branch-Guard + Secret-Redaction +
pseudonymer `machineId`, Settings-Toggle (Default **aus**), Analyse-CLI +
wöchentliche GitHub Action (min-new **und** max-age), Review-PR als einziges
Aktivierungs-Gate, Overlay-Injection mit 16-KB/80-Zeilen-Cap und 30-min-TTL.
Proposal-Status wird beim PR-Merge automatisch fortgeschrieben.
*Akzeptanz:* Auch ein Lauf ohne `record_retro` erreicht den Branch; zweiter
`record_retro` aktualisiert die Branch-Datei; Overlay erscheint erst nach
menschlichem Merge im Prompt.

### Phase 5 — Optionale Ausbauten (nach Bedarf)
Benchmark-Pfad (`run_benchmark` → Learnings), Modell-Empfehlung im
Profil-Editor („Learnings anwenden"), Community-Aggregation
(Archiv-Roadmap „Retro-Daten als öffentliches Asset").

## 6. Bewusst anders als im Archiv

- **Kein Retro-Code in `Workspace`/`WorkspaceManager`** über das Melden von
  Lebenszyklus-Ereignissen hinaus — die Engine-Verflechtung war die teuerste
  Hypothek des Archivs.
- **Selftest-/Smoke-Läufe** sind von Gate, Speicherung und Export ausgenommen
  (wie im Archiv, aber als Eigenschaft des Lauf-Typs, nicht als
  Session-ID-Vergleich).
- **Sprachdisziplin:** Learnings-Texte einsprachig (englisch) erzwingen —
  die gemischtsprachigen Patterns und Learnings des Archivs machten Dedup und
  Analyse unnötig schwer.
- **Keine Regex-Fehlerklassifikation** als Primärquelle; `failureKind` entsteht
  an der Stelle, die den Fehler sieht.

## Referenzdokumente im Archiv

- `docs/retro-sync.md` — Architektur, Betrieb, Review-Prozess, Sicherheit
- `docs/RETRO_IMPROVEMENT_PLAN.md` — 11 empirisch belegte Befunde aus 26 Retros
- `src/shared/retro/contracts.ts` — Datenmodell mit Warum-Kommentaren
- `scripts/retro-analyze.ts:40-76` — Synthese-Systemprompt der Offline-Analyse
