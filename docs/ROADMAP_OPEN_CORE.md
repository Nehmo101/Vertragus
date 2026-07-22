# Vertragus — Open-Core-Roadmap („Die 7 Züge")

Entscheidung (Juli 2026): **Vertragus geht den Open-Core-Weg.** Der Kern bleibt
MIT-lizenziert und öffentlich; kommerzielle Schichten (v. a. Detach-Persistenz
und Team-Funktionen) können später darauf aufsetzen — ohne Druck.
Positionierung: *„Andere lassen dich zehn Agenten starten. Vertragus sagt dir,
welchen Ergebnissen du trauen kannst — und lernt, wen es das nächste Mal
losschickt."*

Jeder Zug ist hier als ausführbare Spezifikation festgehalten (Basis im Code →
konkrete Schritte), damit jede spätere Session ohne Kontext einsteigen kann.
Status-Legende: ✅ umgesetzt · 🔨 in Arbeit · 📋 spezifiziert.

---

## Zug 1 — Trust Cockpit (Verifikation als Produktkern)

**These:** Der Markt-Engpass ist Review, nicht Generierung. Vertragus' Gates,
Judge und Findings werden vom Nebenprodukt zur zentralen Oberfläche.

**Basis im Code:** `VertragusTask.completion/judgeReason/findings/blocker/preflight/
autoPrStatus/remoteCiStatus` (`src/shared/orchestrator.ts`), Diff via
`window.orca.orchestrator.taskDiff`, Review-Gate (`reviewPlan`), Gate-Findings
im `OrchestratorPanel`.

**Stufen:**
1. **v1 (🔨 diese Runde): Trust-Ampel + Beleg auf Canvas-TaskNodes.**
   Ampel-Logik (reine Funktion, testbar): rot = `error`/`blocker`; amber =
   `needs-work`/offene Gate-`findings`/`preflight.failed`; grün = `success`
   **und** `completion` vorhanden; neutral sonst. Aufklappbarer „Beleg"-Block:
   Commit, Preflight-Quote, Judge-Begründung, Auto-PR-/Remote-CI-Status.
2. **v2: Review-Queue.** Eigener Canvas-/Panel-Filter „wartet auf dich":
   pendingPlan, Publikations-Freigaben (`approvePublication`), Permission-
   Anfragen (`resolvePermission`) als eine sortierte Warteschlange mit
   1-Klick-Aktionen.
3. **v3: Beleg-Export.** „Warum ist das grün?" als Markdown/PDF je Ziel
   (Abnahme-Dokument für Freelancer/Agenturen) — Renderer-Export aus den
   vorhandenen Task-Feldern.

## Zug 2 — Detach-Persistenz („Deckel zu, Virgilio läuft weiter")

**These:** Größte Feature-Lücke ggü. CNVS/Antigravity; Voraussetzung für
Daily-Driver-Adoption und später die kommerzielle Schicht.

**Basis im Code:** Mission-Control-Gateway (`src/main/remote/`, WS/SSE,
Pairing, Push), Engine läuft bereits headless-fähig im Main-Prozess,
`VERTRAGUS_UI_SMOKE` zeigt: App startet ohne sichtbares Fenster.

**Schritte (📋, eigenes Arbeitspaket, ~Wochen):**
1. `vertragus-headless`-Einstieg: Electron (oder langfristig Node-only) ohne
   Fenster, nur Engine + AgentManager + Remote-Gateway; Konfiguration über
   Profil-Datei + Env.
2. Desktop-App bekommt einen „Verbinden mit Host"-Modus (Renderer spricht
   Gateway statt lokalem IPC — Abstraktionsschicht über `window.orca`).
3. Sicherheit: bestehendes Device-Pairing wiederverwenden; Host-Token,
   TLS via Reverse-Proxy dokumentieren; Kill-Switch bleibt Pflicht.
4. Doku „VPS in 10 Minuten" (systemd-Unit, cloudflared-Beispiel).

## Zug 3 — Zwei-Minuten-Wunder (Playground-Onboarding)

**These:** Erste Wow-Minute ohne Provider-Login, sonst verliert man gegen
Gratis-Konkurrenz.

**Basis im Code:** `pushDemoState()` in `src/main/windows.ts` (kompletter
Demo-DAG mit Agenten/Tasks/Goal, bisher nur via `VERTRAGUS_DEMO_DAG` +
Screenshot-Pfad).

**Schritte (🔨 diese Runde):**
1. IPC `demo:play` (shared/ipc + preload + Handler) → ruft `pushDemoState`
   für das aufrufende Fenster.
2. Leerer-Workspace-Empty-State bekommt zweiten CTA „✦ Playground ansehen"
   (i18n de/en) → Canvas-Layout aktivieren + Demo-State pushen.
3. Später: geführte Tour (3 Tooltips: Knoten, Puls, Voice) + „Demo beenden".

## Zug 4 — GitHub-Dialog (Conductor-Niveau)

**Basis im Code:** GitHub-Auth (`src/main/integrations/githubAuth.ts`),
Repo-Bindung, `githubProjects`, Auto-PR + Remote-CI-Tracking, Findings-Board.

**Schritte (📋):**
1. **Issue → Ziel:** Sidebar-Board-Sektion listet offene Issues des gebundenen
   Repos; „Als Ziel starten" übergibt Titel+Body via bestehendem
   Inbox-Transfer an den Orchestrator.
2. **PR-Kommentare → Findings:** Poll/Webhook der Review-Kommentare des
   Auto-PR; jeder Kommentar wird ein `finding` (kind: decision/blocker) am
   zugehörigen Task — sichtbar als Canvas-Notiz; Orchestrator-Prompt-Baustein
   „beantworte/fixe Review-Findings".
3. Antworten zurückspiegeln (kommentieren) über bestehende Auth.

## Zug 5 — Canvas als Steuerpult

**Basis im Code:** IPCs existieren komplett: `orchestrator.pauseTask/
resumeTask/fallbackTask`, `taskDiff`; React Flow `onNodeContextMenu`;
Plan-Validierung für spätere Kanten-Edits.

**Schritte:**
1. **(🔨 diese Runde)** Rechtsklick-Kontextmenü auf Task-Knoten: Pause /
   Fortsetzen (statusabhängig), Ersatz-Task starten, Pane fokussieren,
   Diff im Panel öffnen (selektiert Task im OrchestratorPanel).
2. v2: Kante ziehen = Abhängigkeits-Vorschlag → `execute_plan`-Re-Plan mit
   Validierung; eingebettetes xterm (echtes `AgentPane`) als Knoten-Ausbau.

## Zug 6 — Retro-Daten als öffentliches Asset

**Basis im Code:** `src/shared/retro/`, `scripts/retro-analyze.ts`,
Retro-Sync-Repo (`Nehmo101/Vertragus@retros`), learnedStrengths/Weaknesses.

**Schritte (📋):**
1. `scripts/retro-report.mjs`: aggregiert lokale Retros zu einem
   anonymisierten Markdown-Report („Modell × Rolle: Erfolgsquote,
   Nacharbeit, Kosten") — ohne Repo-Namen/Prompts/Pfade (Privacy-Filter =
   Allowlist der Felder).
2. Monatlicher Report als `docs/benchmarks/YYYY-MM.md` im Repo (Content,
   den nur Vertragus schreiben kann).
3. Opt-in-Community-Aggregation über den bestehenden Retro-Sync-Mechanismus.

## Zug 7 — Open Core + Distribution

**Sofort (🔨 diese Runde):**
- README: Open-Core-Statement + Positionierungssatz + Roadmap-Link;
  „Open Core: der gesamte Kern ist MIT — kommerzielle Schichten (Detach,
  Teams) kommen ggf. später obendrauf, der Kern bleibt frei."
- LICENSE ist bereits MIT ✅.

**Danach (📋, teils außerhalb des Codes):**
- Landing (statisch, `website/` oder GitHub Pages) mit 90-Sekunden-Video des
  Canvas (Screen-Recording: Ziel diktieren → Welle → Puls → Beleg).
- Signierte Builds: Windows (Azure Trusted Signing o. EV-Zert), macOS
  (Developer-ID + Notarisierung) — Zertifikate/Accounts nötig; CI-Jobs in
  electron-builder vorbereitet.
- Launch-Playbook: HN „Show HN", X-Thread mit Canvas-GIF, Listing in
  Orchestrator-Verzeichnissen; Build-in-public-Rhythmus optional/entspannt.

---

*Reihenfolge-Empfehlung bei Wiederaufnahme: 1v2 → 3-Tour → 4.1 → 2 → 4.2 →
1v3 → 6 → 7-Distribution.*
