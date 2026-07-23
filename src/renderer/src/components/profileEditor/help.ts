/**
 * Shared German help texts for the profile editor sections.
 * Kept in one map because several fields (model, preset, multi-agent) appear
 * in more than one section and must stay word-for-word identical.
 */
export const HELP = {
  profileName: 'Frei wählbarer Name für diese Kombination aus Workspace, Orchestrator und Subagents.',
  workingDir: 'Lokaler Repository- oder Projektordner, in dem die Agents arbeiten. Der Auto-PR-Basisbranch wird bei Bedarf aus dem git-origin dieses Ordners abgeleitet.',
  githubAuth: 'Browser-OAuth (Device Flow mit VERTRAGUS_GITHUB_OAUTH_CLIENT_ID) oder gh --web. Tokens werden verschlüsselt lokal gespeichert, nie im Profil oder in Logs. Wird für Auto-PR benötigt.',
  generateFromRepo: 'Das gewählte Analysemodell liest das Working-Directory-Repository read-only und schlägt Rollen, Modelle und Quality Gates vor. Kann je nach Repo-Größe ein bis mehrere Minuten dauern.',
  agentWorkingDir: 'Optionaler Pfad nur für diesen Slot. Leer übernimmt den Workspace-Basispfad.',
  mode: 'Orchestriert lässt Claude oder Codex planen und delegieren. Single startet nur die konfigurierten Slots. Efficiency Solo startet genau EINEN Agenten, der direkt arbeitet — minimale Token-Fixkosten, Retro-Learnings im Prompt, nur report_activity/record_retro als Tools.',
  orchestratorProvider: 'Nur Provider mit verifiziertem Vertragus-MCP-Adapter können orchestrieren.',
  permissionMode: 'Auto-Mode bestätigt Edits automatisch. Plan-Mode erlaubt Claude nur zu planen.',
  model: 'Leer verwendet Preset oder CLI-Standard. Freitext überschreibt das Preset. Über das Listen-Menü rechts wählst du jederzeit ein anderes Modell — auch wenn schon eines eingetragen ist.',
  modelPreset: 'Leistungs-Preset (schnell/ausgewogen/stark). Gilt nur wenn Modell leer ist — Freitext hat Vorrang.',
  plannerMode: 'Auto startet valide Pläne direkt. Review wartet auf Freigabe. Manuell deaktiviert execute_plan.',
  routingMode: 'Adaptiv startet zunächst nur den Orchestrator und aktiviert Task-Agents passend zum Plan. Vorgewärmt startet alle Slots sofort.',
  maxParallel: 'Globales Oberlimit gleichzeitig laufender Plan-Tasks; Rollen-Kapazitäten können es weiter reduzieren.',
  maxRetries: 'Wie oft der Orchestrator nach einem fehlgeschlagenen Plan ohne neue Nutzerinformation fokussiert nachplanen darf.',
  multiAgent: 'Startet für jede delegierte Aufgabe alle Instanzen des gewählten Slots parallel. Ein Slot-Override hat Vorrang; „Global erben“ übernimmt diese globale Einstellung. Die Runtime bildet weiterhin nur bei orchestriertem Einsatz und Anzahl > 1 eine Kandidatengruppe, speichert den Override aber unabhängig davon.',
  autoPrMode: 'PRs entstehen nur nach erfolgreichen Gates. Draft ist der empfohlene sichere Startmodus.',
  prStrategy: 'Aggregate kombiniert Task-Commits in einen Goal-PR. Per Task erzeugt getrennte PRs.',
  baseBranch: 'Zielbranch des PRs. Leer nutzt den gebundenen Standardbranch oder den des origin-Remotes.',
  qualityGates: 'Vertrauenswürdige Shell-Befehle, die im Task- und Integrations-Worktree erfolgreich laufen müssen.',
  autoGitMode: 'Nach einem vollständig erfolgreichen Workspace-Lauf werden alle Änderungen im Workspace committet und zu origin gepusht. Bei Fehlern bleibt der Lauf rot.',
  autoGitBranch: 'Expliziter Ziel-Branch auf origin. Optionen, Ref-Specs, Revisionen, Leerzeichen und Steuerzeichen werden abgewiesen.',
  role: 'Eindeutige Fähigkeit, die der Planner adressiert, etwa frontend, backend, tests oder review.',
  agentProvider: 'CLI, die diesen Slot ausführt. Der Login erfolgt separat in der Provider-Seitenleiste.',
  count: 'Maximale parallele Task-Kapazität dieser Rolle und Anzahl beim manuellen Teamstart.',
  yolo: 'Überspringt Provider-Bestätigungen. Nur mit Worktree-Isolation und bewusstem Scope verwenden.',
  orchestrated: 'Wenn aktiv, darf der Orchestrator Aufgaben an diesen Slot delegieren.',
  skills:
    'Benannte, wiederverwendbare Verfahren dieses Workspaces ("wie machen wir X hier"). Sie werden in die ' +
    'Orchestrator-/Solo-Prompts injiziert, und der Orchestrator pflegt sie selbst über die MCP-Tools ' +
    'list_skills/record_skill/remove_skill — das Profil lernt über Läufe hinweg dazu.',
  fallbackModels:
    'Kommagetrennte Modellnamen, auf die dieser Slot bei einem Nutzungslimit ("at capacity", 5h/Wochenlimit) ' +
    'der Reihe nach ausweicht — erst danach wechselt Vertragus den Provider.',
  strengths: 'Kommagetrennte Fähigkeiten, die der Orchestrator bei der Rollenwahl bevorzugen soll.',
  weaknesses: 'Kommagetrennte Aufgaben, für die der Orchestrator diesen Slot möglichst nicht wählen soll.',
  benchmark:
    'Auto-Benchmark: Der Orchestrator gibt allen Slots dieselbe Aufgabe, vergleicht die Ergebnisse, ' +
    'bewertet sie und speichert die Erkenntnisse als Modellwissen für künftige Läufe.',
  applyLearnings:
    'Übernimmt gespeicherte Retro- und Benchmark-Erkenntnisse passend zu Provider und Modell ' +
    'in die Stärken/Schwächen der Slots. Die Erkenntnisse entstehen automatisch nach jedem Lauf.'
} as const
