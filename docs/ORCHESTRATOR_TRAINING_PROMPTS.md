# Orchestrator-Training-Prompts

Stand: 14. Juli 2026

Dieses Dokument ist ein **Trainings- und Bewertungskatalog** für den
Orca-Strator-Orchestrator. Die Szenarien üben die Kernfähigkeit des
Koordinators: ein Nutzerziel in einen **möglichst kleinen, vollständigen und
validen Plan** zu zerlegen und ihn an die **richtige Zahl an Subagents** zu
delegieren.

> **Wichtig:** Am Ende muss kein echtes Produkt entstehen. Bewertet wird die
> **Qualität von Planung und Koordination** — Teamgröße, DAG-Form, Ownership,
> Live-Kommunikation — nicht das Artefakt. Die Ziele dürfen fiktiv sein.

Jedes Szenario nennt eine mögliche **perfekte Lösung** (Referenzplan). Diese
Referenzpläne sind in `src/shared/orchestratorTraining.ts` typisiert hinterlegt
und werden vom Test `src/main/orchestrator/orchestratorTraining.test.ts` gegen
den **echten** Plan-Validator (`resolveExecutionPlan`) geprüft — sie sind also
garantiert regelkonform (Single-Integrator, Shared-Hotspot-Ownership,
azyklischer DAG, gültige Rollen).

---

## So nutzt du den Katalog

1. **Ziel setzen:** Den `goalPrompt` eines Szenarios als Workspace-Ziel geben.
2. **Beobachten:** Wie der Orchestrator `set_goal` → `report_activity` →
   `list_subagents` → `execute_plan` → `get_plan_status` durchläuft.
3. **Bewerten:** Den Lauf gegen die **Erfolgskriterien** und die
   **Anti-Patterns** des Szenarios halten und mit dem **Referenzplan**
   vergleichen.
4. **Lernen festhalten:** Nach jedem Terminallauf `record_retro` (bzw.
   `record_benchmark`) — genau das trainiert das Modellwissen für spätere Läufe.

### Bewertungsraster (Plan-Qualität)

| Dimension | Perfekt | Durchgefallen |
|---|---|---|
| **Right-Sizing** | Nur so viele Rollen wie nötig | Team für triviale Aufgabe, oder Serialisierung echter Parallelität |
| **DAG-Gültigkeit** | Azyklisch, bekannte Deps, ≤ 24 Tasks | Zyklus/unbekannte Dep → Fallback auf einen Task |
| **conflictKeys** | Geteilte Dateien/Ressourcen teilen einen Key | Parallele Tasks kollidieren auf denselben Dateien |
| **Integrator** | **Genau einer**, besitzt geteilte Hotspots, **hängt an allen** und läuft **zuletzt** | Zwei Integratoren, Feature ändert Shared-File, Review nach dem Integrator (→ Zyklus) |
| **advisory vs. required** | Audits sind advisory und färben eine saubere Lieferung nicht rot | Review als required, blockiert Erfolg |
| **Re-Plan** | Fokussierter Folgeplan mit neuer Erkenntnis | Identischer Blind-Retry |

### Vokabular-Auffrischung

- **set_goal / report_activity** — Ziel melden, Lage laufend berichten
  („Ich: …“ / „Subagents: …“ / „Nächster Schritt: …“).
- **list_subagents** — der verfügbare **Fähigkeiten-Pool** (nicht laufende
  Prozesse); liefert `strengths/weaknesses` und gelerntes
  `learnedStrengths/learnedWeaknesses`.
- **execute_plan** — reicht den validierten DAG ein; gibt sofort `runId` zurück.
- **dispatch_batch / dispatch_subagent** — fokussierte Folgearbeit **innerhalb**
  eines schon geplanten Ziels, kein Ersatz für den Erstplan.
- **get_plan_status / list_tasks / get_task_status** — echte Daten pollen.
- **list_findings** — Shared Findings Board: Schnittstellen, Entscheidungen,
  Blocker der parallelen Worker live sehen.
- **open_subwindow** — nur für bewusst **dauerhafte, interaktive** Arbeit.
- **run_benchmark / get_benchmark_status / record_benchmark** — Benchmark-Modus.

### Regeln des Planvertrags (kurz)

- Jeder Task: `id, title, role, prompt, dependsOn, advisoryDependsOn,
  criticality, conflictKeys, ownership, expectedFiles`.
- `dependsOn` ist **hart** (Fehler blockt den Konsumenten); `advisoryDependsOn`
  **wartet und leitet Ergebnisse weiter, blockt aber nicht**.
- `criticality=required` entscheidet den Planerfolg; `advisory` darf fehlschlagen.
- **Geteilte Hotspots** (`src/shared/**`, `src/main/ipc/**`, `src/preload/**`,
  `src/shared/profile.ts`, `src/renderer/src/styles.css`,
  `src/renderer/src/cozy-organic.css`) gehören in **genau einen** Integrator; der
  muss von **jedem** anderen Task abhängen. Deshalb kann **kein** Task nach dem
  Integrator laufen — ein Review muss vom Integrator (advisory) konsumiert
  werden, nicht ihm nachgeschaltet sein.
- Ungültige Pläne fallen sicher auf **einen** konservativen Task zurück; die
  `validationIssues` im Ergebnis prüfen.

---

## Tier 0 — Wenige Subagents (Lektion: nicht über-orchestrieren)

### `solo-readme-typo` — Einzelkorrektur ohne Team
**Team:** solo · **Level:** einsteiger

> In der README steht „Orchestrieren“ doppelt. Korrigiere den Tippfehler und
> sonst nichts.

**Perfekt:** genau ein Task, `maxParallel = 1`, kein zweiter Agent, kein
Integrator — aber trotzdem sauber über `execute_plan` eingereicht und bis zum
Terminalstatus gepollt.
**Anti-Pattern:** ein Mehr-Rollen-Team für eine Trivialität; `open_subwindow`
ohne Bedarf.

### `solo-flaky-test` — Einen flaky Test stabilisieren
**Team:** solo · **Level:** einsteiger

> Ein einzelner Unit-Test schlägt sporadisch fehl. Finde die Ursache und
> stabilisiere ihn.

**Perfekt:** ein fokussierter Task; Diagnose **und** Fix in derselben Rolle;
Definition of Done = Test mehrfach hintereinander grün.
**Anti-Pattern:** künstliche Aufteilung in zwei Tasks; blindes Re-Run als „Plan“.

### `small-util-plus-test` — Kleines Feature mit sequenzieller Absicherung
**Team:** small · **Level:** einsteiger

> Füge eine kleine slugify-Hilfsfunktion hinzu und sichere sie mit Unit-Tests ab.

**Perfekt:** zwei Tasks (Implementierung → Test via `dependsOn`), gemeinsamer
`conflictKey`, `maxParallel = 1`.
**Anti-Pattern:** Implementierung und Test parallel starten und auf
Schnittstellenbruch laufen.

---

## Tier 1 — Integrator-Einstieg (Lektion: Hotspots bündeln)

### `small-profile-field` — Feature + geteiltes Schema über einen Integrator
**Team:** small · **Level:** fortgeschritten

> Ergänze im Profil einen Schalter „Yolo-Warnbanner ausblenden“ und zeige ihn im
> Profil-Editor an.

**Perfekt:** Feature-Task baut die UI gegen eine dokumentierte Schnittstelle
(Findings-Board); **genau ein** Integrator besitzt `src/shared/profile.ts` +
IPC-Verdrahtung und hängt am Feature — er läuft zuletzt.
**Anti-Pattern:** den UI-Task die Shared-Datei anfassen lassen (Validator lehnt
ab); zwei Tasks ändern das Schema parallel.

---

## Tier 2 — Mittleres Team (Lektion: sinnvoll parallelisieren)

### `medium-three-independent-modules` — Drei unabhängige Module parallel
**Team:** medium · **Level:** fortgeschritten

> Baue drei voneinander unabhängige Hilfsmodule: Telemetrie-Formatter,
> Modellkatalog-Filter und Inbox-Sortierer.

**Perfekt:** drei parallele Feature-Tasks (`maxParallel = 3`), **kein**
Integrator (keine Hotspots), ein **advisory** Review, das auf alle drei wartet.
**Anti-Pattern:** die drei künstlich serialisieren; das Review als `required`
deklarieren.

### `medium-new-mcp-tool` — Feature-Fan-in mit Integrator zuletzt
**Team:** medium · **Level:** experte

> Füge ein MCP-Tool `list_findings` von Ende zu Ende hinzu: Server-Handler,
> Renderer-Panel und geteilte IPC-/Typen-Verdrahtung.

**Perfekt:** Server + Panel parallel; das **advisory** Security-Review prüft die
Feature-Module **vor** dem Integrator; der **eine** Integrator besitzt
`src/shared/ipc.ts` + `src/shared/orchestrator.ts` und hängt an **allen**
anderen Tasks (inkl. Review).
**Anti-Pattern:** einen Review **nach** dem Integrator einplanen — dann müsste
der Integrator von ihm abhängen → **Zyklus**.

---

## Tier 3 — Großes Team (Lektion: breite Fächerung, ein Trichter)

### `large-workspace-refresh` — Sechs UI-Bausteine mit einem Style-Integrator
**Team:** large · **Level:** experte

> Überarbeite die Workspace-Oberfläche: sechs unabhängige Komponenten erneuern
> und danach einheitlich in die globalen Styles einbinden.

**Perfekt:** sechs parallele Feature-Tasks (je eigener `conflictKey`),
`maxParallel = 6`; ein **advisory** Accessibility-Review; **genau ein**
Integrator besitzt `src/renderer/src/styles.css` und hängt an allen sechs plus
dem Review.
**Anti-Pattern:** mehrere Tasks ändern `styles.css` gleichzeitig; `maxParallel =
1`; zwei Integratoren.

### `large-layered-pipeline` — Geschichteter DAG: Design → Umsetzung → Integration
**Team:** large · **Level:** experte

> Entwirf und implementiere ein Retro-Analyse-Subsystem in vier Modulen, mit
> vorgeschaltetem Schnittstellendesign und abschließender Integration ins
> geteilte Orchestrator-Schema.

**Perfekt:** Ebene 1 Design (legt Schnittstellen fest) → Ebene 2 vier
Umsetzungs-Tasks (`dependsOn: design`, `maxParallel = 4`) → **advisory** Verify →
**ein** Integrator (`src/shared/orchestrator.ts`), der an Design, allen vier
Modulen und dem Verify hängt.
**Anti-Pattern:** Module ohne gemeinsames Design starten; der Integrator
„vergisst“ ein Modul (er muss von **jedem** anderen Task abhängen).

---

## Tier 4 — Fallen & Sonderfälle

### `trap-shared-schema-collision` — Zwei Features wollen dasselbe Schema
**Team:** small · **Level:** experte

> Baue Export **und** Import für Tasks. Beide Richtungen brauchen ein
> zusätzliches Feld im geteilten Orchestrator-Task-Schema.

**Perfekt:** erkennen, dass „beide ändern `src/shared/orchestrator.ts`“ die Falle
ist; Feature-Tasks liefern nur Module und deklarieren **keine** Shared-Datei; ein
Integrator erweitert das Schema **einmal** und hängt an beiden Features.
**Anti-Pattern:** beide Features setzen die Shared-Datei in `expectedFiles` →
Validator fällt auf **einen** Fallback-Task zurück.

### `recovery-focused-replan` — Fokussierter Folgeplan nach Fehlschlag
**Team:** small · **Level:** experte

> Der erste Plan lief, aber der Pflicht-Task „Migration schreiben“ ist mit einem
> Worker-Blocker (fehlendes Schema-Feld) fehlgeschlagen. Bringe das Ziel zu Ende.

**Perfekt:** zuerst `get_plan_status` + `list_findings` auswerten (echte
Ursache), dann ein **kleiner, fokussierter** Folgeplan, der die Ursache
adressiert und den Fix belegt — gerne mit einer bisher ungenutzten Rolle.
**Anti-Pattern:** denselben Task unverändert erneut dispatchen; das ganze Team
neu starten.

### `benchmark-model-bakeoff` — Dieselbe Aufgabe an alle Slots
**Team:** medium · **Level:** experte · **Modus:** `run_benchmark` (kein DAG)

> Finde heraus, welches Modell einen kniffligen Refactor der Semaphore-Logik am
> besten löst.

**Perfekt:** **kein** `execute_plan`. `run_benchmark(prompt, title)` gibt allen
Slots **dieselbe** Aufgabe in isolierten Worktrees; `get_benchmark_status` bis
Terminalstatus pollen; `record_benchmark` mit fairem Score (0–10), Verdict und
Stärken/Schwächen; danach begründete Rangliste an den Nutzer.
**Anti-Pattern:** die Aufgabe unter den Slots aufteilen; ohne `record_benchmark`
abschließen (kein Modellwissen für später).

---

## Quelle & Prüfung

- **Daten:** `src/shared/orchestratorTraining.ts` (typisierte Szenarien inkl.
  Referenzplänen).
- **Prüfung:** `src/main/orchestrator/orchestratorTraining.test.ts` validiert
  jeden Referenzplan gegen `resolveExecutionPlan` — jeder „perfekte Plan“ ist
  damit nachweislich regelkonform.
