# Vertragus-Dokumentation

Stand: 28. Juli 2026

## Nutzung & Betrieb

- [Handbuch für Nutzung, Entwicklung und Betrieb](./VERTRAGUS_HANDBUCH.md) — Einstieg, Profile, Terminals, Worktrees, YOLO, Release-Ablauf und Fehlerdiagnose.
- [Aktueller Umsetzungsstand](./IMPLEMENTATION_STATUS.md) — verifizierte Feature-Grenzen: was fertig ist und was bewusst außen vor bleibt.
- [Git-Handbuch für Branches, Worktrees und Pull Requests](./GIT_WORKFLOW.md) — sicherer Workflow für Entwicklung, parallele Agent-Arbeit und Wiederherstellung.
- [Efficiency Solo](./EFFICIENCY_SOLO.md) — Ein-Agent-Profil-Preset mit minimalem Tokenverbrauch (kompakter Solo-Kontrakt, minimale MCP-Session).
- [Custom-Provider-API](./CUSTOM_PROVIDERS.md) — config-basierter Vertrag, um beliebige weitere Headless-CLIs als Worker anzubinden.
- [Prompt schärfen: produktive Integration](./prompt-enhancement-integration.md) — nicht-mutierende Verbesserung des Inbox-Drafts vor der Übergabe.

## Architektur & Sicherheit

- [Reliable Agent Lifecycle](./RELIABLE_AGENT_LIFECYCLE.md) — asynchroner Dispatch, verifizierte Commits, Gates und Integrationsphase (EN).
- [Production Hardening](./PRODUCTION_HARDENING.md) — Electron-Sandbox, CSP, Navigationsschutz, redigierte Diagnostik.
- [IPC-Architektur & Konsistenz-Guard](./IPC_ARCHITECTURE.md) — die drei IPC-Schichten, der statische Drift-Guard (`ipcSurface.test.ts`), das Muster für neue Kanäle und der Weg zum Kanal-Manifest.
- [Retro-Sync & Selbstverbesserungs-Loop](./retro-sync.md) — Retros → `retros`-Branch → Analyse → geprüftes Learnings-Overlay im Systemprompt.
- [Retro-Analyse & Verbesserungsplan](./RETRO_IMPROVEMENT_PLAN.md) — Auswertung der Retrospektiven und die daraus umgesetzten Plattform-Fixes.
- [Technischer Auditbericht](./VERTRAGUS_AUDIT.md) — Audit vom 12. Juli 2026 (Commit `d396a0a`), historische Befundbasis.
- [Remaining Work Plan](./REMAINING_WORK_PLAN.md) — Status der verbleibenden Audit-Architektur-Refactorings (EN).

## Mission Control (Remote-Zugriff)

- [Mission Control — Gesamtplan](./MISSION_CONTROL_PLAN.md) — Architektur-Blueprint der sicheren Remote-Kommandozentrale (Phasen A–C).
- [Mission Control — Phase D](./MISSION_CONTROL_PHASE_D.md) — Anbindung weiterer Roadmap-Features an dieselbe Engine- und Sicherheitsgrenze.
- [Mission Control — Provider- und Sicherheitsabdeckung](./MISSION_CONTROL_PROVIDER_COVERAGE.md) — Permission Broker und Abdeckung je Provider (Phase C).

## Roadmaps & Pläne

- [Produkt- und Technik-Roadmap](./VERTRAGUS_ROADMAP.md) — geprüfter Ist-Stand, Zielarchitektur, Pflichtfeatures und PR-Reihenfolge.
- [Open-Core-Roadmap („Die 7 Züge“)](./ROADMAP_OPEN_CORE.md) — MIT-Kern plus mögliche spätere kommerzielle Schichten.
- [Voice-/Speech-to-Text-Plan](./VOICE_INTERFACE_PLAN.md) — Design der Sprachsteuerung für den ausgewählten Agenten.
- [Orchestrator-Training-Prompts](./ORCHESTRATOR_TRAINING_PROMPTS.md) — Trainings- und Bewertungskatalog für den Orchestrator.
- [Marke & Design](./BRAND.md) — Name, Windhund-Herkunft und visuelles System.
- [Theme- und Token-Architektur](./THEME.md) — CSS-Token-Schichten (styles.css → cozy-organic → data-theme), Namenskonventionen, Do/Don't und dokumentierte Ausnahmen.

### Umsetzungspläne (`plans/`)

- [Native iPhone-App „Mission Control“](./plans/IPHONE_APP_MISSION_CONTROL.md) — SwiftUI-Client gegen das bestehende Remote-Gateway (umgesetzt, siehe `apps/ios/`).
- [Session-Persistenz & Wiederaufnahme](./plans/SESSION_PERSISTENCE_RESUME.md) — kein Fortschrittsverlust bei App-Schließen, Crash oder Stromausfall.
- [Canvas-First UI-Overhaul](./plans/CANVAS_FIRST_UI_OVERHAUL.md) — Control-Center-Konzept plus Analyse der Ausführungs-Blocker.
