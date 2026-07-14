/**
 * Orchestrator-Trainingskatalog.
 *
 * Diese Szenarien trainieren die KERNFÄHIGKEIT des Orca-Orchestrators:
 * ein Nutzerziel in einen möglichst kleinen, vollständigen und VALIDEN Plan
 * zu zerlegen und ihn über execute_plan an die richtige Zahl an Subagents zu
 * delegieren. Am Ende muss kein echtes Produkt entstehen — bewertet wird die
 * Qualität von Planung und Koordination, nicht das Artefakt.
 *
 * Jedes Szenario liefert einen `referencePlan`: eine mögliche "perfekte"
 * Lösung, die der echte Plan-Validator (`resolveExecutionPlan`) ohne Fallback
 * akzeptiert. Der zugehörige Test in
 * `src/main/orchestrator/orchestratorTraining.test.ts` beweist das für jeden
 * Referenzplan, damit das Trainingsmaterial nicht von den echten Plan-Regeln
 * abdriftet (Single-Integrator, Shared-Hotspot-Ownership, azyklischer DAG …).
 */
import type { ExecutionPlan } from './orchestrator'

/** Wie viele Subagents ein starker Plan hier tatsächlich einsetzen sollte. */
export type TrainingTeamSize = 'solo' | 'small' | 'medium' | 'large'

export type TrainingDifficulty = 'einsteiger' | 'fortgeschritten' | 'experte'

/** Welches MCP-Werkzeug das Szenario primär übt. */
export type TrainingMode = 'execute_plan' | 'run_benchmark'

export interface OrchestratorTrainingScenario {
  /** Stabile Kennung, auch als Test-Name genutzt. */
  id: string
  title: string
  teamSize: TrainingTeamSize
  difficulty: TrainingDifficulty
  mode: TrainingMode
  /** Kurz, welche Orchestrierungs-Fähigkeiten hier geprüft werden. */
  focus: string[]
  /**
   * Rollen-Pool, wie ihn list_subagents ausweisen würde. Der Orchestrator darf
   * im Plan NUR diese Rollen verwenden (case-insensitive).
   */
  roles: string[]
  /** Das Nutzerziel, so wie es im Workspace ankäme. */
  goalPrompt: string
  /** Woran ein perfekter Lauf gemessen wird. */
  successCriteria: string[]
  /** Typische Fehlermuster, die dieses Szenario provozieren soll. */
  antiPatterns: string[]
  /**
   * Eine mögliche perfekte Lösung. Für Benchmark-Szenarien (run_benchmark)
   * absichtlich leer, weil dort kein execute_plan-DAG entsteht.
   */
  referencePlan?: ExecutionPlan
}

// ---------------------------------------------------------------------------
// Tier 0 — Wenige Subagents: das Ziel ist "nicht über-orchestrieren".
// ---------------------------------------------------------------------------

const soloReadmeTypo: OrchestratorTrainingScenario = {
  id: 'solo-readme-typo',
  title: 'Einzelkorrektur ohne Team',
  teamSize: 'solo',
  difficulty: 'einsteiger',
  mode: 'execute_plan',
  focus: ['right-sizing', 'single-task-plan'],
  roles: ['coder'],
  goalPrompt:
    'In der README steht "Orchestrieren" doppelt. Korrigiere den Tippfehler und sonst nichts.',
  successCriteria: [
    'Genau EIN Task, maxParallel = 1.',
    'Kein zweiter Subagent, kein Integrator, kein Review-Task.',
    'Plan wird trotzdem über execute_plan eingereicht und bis Terminalstatus gepollt.'
  ],
  antiPatterns: [
    'Ein Team aus mehreren Rollen für eine triviale Änderung starten.',
    'open_subwindow benutzen, obwohl kein dauerhafter interaktiver Agent nötig ist.'
  ],
  referencePlan: {
    version: 1,
    goal: 'Doppeltes Wort in der README korrigieren',
    maxParallel: 1,
    tasks: [
      {
        id: 'fix',
        title: 'Tippfehler in README korrigieren',
        role: 'coder',
        prompt:
          'Finde das doppelte "Orchestrieren" in README.md und entferne die Dopplung. Keine weiteren Änderungen.',
        dependsOn: [],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['readme'],
        ownership: 'feature',
        expectedFiles: ['readme.md']
      }
    ]
  }
}

const soloFlakyTest: OrchestratorTrainingScenario = {
  id: 'solo-flaky-test',
  title: 'Einen flaky Test stabilisieren',
  teamSize: 'solo',
  difficulty: 'einsteiger',
  mode: 'execute_plan',
  focus: ['right-sizing', 'diagnose-then-fix-in-one-task'],
  roles: ['coder'],
  goalPrompt:
    'Ein einzelner Unit-Test schlägt sporadisch fehl. Finde die Ursache und stabilisiere ihn.',
  successCriteria: [
    'Ein fokussierter Task genügt: Diagnose und Fix in derselben Rolle.',
    'Der Prompt verlangt Nachweis (Test mehrfach grün) als Definition of Done.',
    'Kein paralleles Team, weil es nur einen Ursachenort gibt.'
  ],
  antiPatterns: [
    'Diagnose und Fix künstlich auf zwei sequenzielle Tasks aufteilen, obwohl ein Agent beides sieht.',
    'Blindes Re-Run ohne Ursachenanalyse als "Plan".'
  ],
  referencePlan: {
    version: 1,
    goal: 'Sporadisch fehlschlagenden Test deterministisch machen',
    maxParallel: 1,
    tasks: [
      {
        id: 'stabilize',
        title: 'Flaky Test analysieren und fixen',
        role: 'coder',
        prompt:
          'Reproduziere den flaky Test, identifiziere die Race-/Timing-/Zustandsursache und behebe sie. Belege: Test 20x hintereinander grün, Lint/Typecheck sauber.',
        dependsOn: [],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['flaky-test'],
        ownership: 'feature',
        expectedFiles: []
      }
    ]
  }
}

const smallUtilPlusTest: OrchestratorTrainingScenario = {
  id: 'small-util-plus-test',
  title: 'Kleines Feature mit sequenzieller Absicherung',
  teamSize: 'small',
  difficulty: 'einsteiger',
  mode: 'execute_plan',
  focus: ['linear-dependency', 'conflict-keys'],
  roles: ['coder', 'tester'],
  goalPrompt:
    'Füge eine kleine slugify-Hilfsfunktion hinzu und sichere sie mit Unit-Tests ab.',
  successCriteria: [
    'Zwei Tasks: Implementierung, danach Tests (dependsOn).',
    'Beide teilen sich einen conflictKey für dieselbe Datei-Nähe.',
    'maxParallel = 1, weil der Test die Implementierung als harte Abhängigkeit braucht.'
  ],
  antiPatterns: [
    'Implementierung und Test parallel starten und dann auf Schnittstellenbruch laufen.',
    'Kein dependsOn setzen, sodass der Test gegen noch nicht existierenden Code läuft.'
  ],
  referencePlan: {
    version: 1,
    goal: 'slugify-Hilfsfunktion inkl. Unit-Tests liefern',
    maxParallel: 1,
    tasks: [
      {
        id: 'impl',
        title: 'slugify implementieren',
        role: 'coder',
        prompt:
          'Implementiere eine reine slugify(input: string): string in src/main/util/slugify.ts (Kleinbuchstaben, Bindestriche, Diakritika entfernen). Keine Tests.',
        dependsOn: [],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['slugify'],
        ownership: 'feature',
        expectedFiles: ['src/main/util/slugify.ts']
      },
      {
        id: 'test',
        title: 'slugify testen',
        role: 'tester',
        prompt:
          'Schreibe Vitest-Tests in src/main/util/slugify.test.ts für Standard-, Rand- und Unicode-Fälle. Belege: alle Tests grün.',
        dependsOn: ['impl'],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['slugify'],
        ownership: 'feature',
        expectedFiles: ['src/main/util/slugify.test.ts']
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Tier 1 — Integrator-Einstieg: gemeinsame Hotspots gehören in EINE Aufgabe.
// ---------------------------------------------------------------------------

const smallProfileField: OrchestratorTrainingScenario = {
  id: 'small-profile-field',
  title: 'Feature + geteiltes Schema über einen Integrator',
  teamSize: 'small',
  difficulty: 'fortgeschritten',
  mode: 'execute_plan',
  focus: ['integrator-ownership', 'interface-first'],
  roles: ['ui', 'platform'],
  goalPrompt:
    'Ergänze im Profil einen neuen Schalter "Yolo-Warnbanner ausblenden" und zeige ihn im Profil-Editor an.',
  successCriteria: [
    'Feature-Task baut die UI gegen eine dokumentierte Schnittstelle (Findings-Board).',
    'GENAU EIN Integrator besitzt src/shared/profile.ts und die IPC-Verdrahtung.',
    'Der Integrator hängt am Feature-Task; er läuft zuletzt.'
  ],
  antiPatterns: [
    'Den UI-Task src/shared/profile.ts anfassen lassen — der Validator lehnt geteilte Hotspots in Feature-Tasks ab.',
    'Zwei Tasks das Profil-Schema parallel ändern lassen.'
  ],
  referencePlan: {
    version: 1,
    goal: 'Neuen Profil-Schalter inklusive UI und geteiltem Schema liefern',
    maxParallel: 1,
    tasks: [
      {
        id: 'ui',
        title: 'Schalter im Profil-Editor',
        role: 'ui',
        prompt:
          'Ergänze in src/renderer/src/components/ProfileEditor.tsx einen Toggle "Yolo-Warnbanner ausblenden". Erwarte das Feld hideYoloBanner vom Profil und dokumentiere die benötigte Schnittstelle auf dem Findings-Board.',
        dependsOn: [],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['profile-ui'],
        ownership: 'feature',
        expectedFiles: ['src/renderer/src/components/profileeditor.tsx']
      },
      {
        id: 'integrate',
        title: 'Profil-Schema und IPC verdrahten',
        role: 'platform',
        prompt:
          'Ergänze hideYoloBanner im geteilten Profilschema und verdrahte es über IPC. Nutze das Findings-Board des UI-Tasks als Vertrag.',
        dependsOn: ['ui'],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: [],
        ownership: 'integrator',
        expectedFiles: ['src/shared/profile.ts', 'src/shared/ipc.ts']
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Tier 2 — Mittleres Team: bewusst parallelisieren, Audit als advisory.
// ---------------------------------------------------------------------------

const mediumIndependentModules: OrchestratorTrainingScenario = {
  id: 'medium-three-independent-modules',
  title: 'Drei unabhängige Module parallel',
  teamSize: 'medium',
  difficulty: 'fortgeschritten',
  mode: 'execute_plan',
  focus: ['fan-out', 'advisory-audit', 'useful-parallelism'],
  roles: ['coder', 'reviewer'],
  goalPrompt:
    'Baue drei voneinander unabhängige Hilfsmodule: einen Telemetrie-Formatter, einen Modellkatalog-Filter und einen Inbox-Sortierer.',
  successCriteria: [
    'Drei parallele Feature-Tasks ohne gegenseitige Abhängigkeit, maxParallel = 3.',
    'Kein Integrator, weil keine geteilten Hotspots berührt werden.',
    'Ein advisory Review-Task wartet (advisoryDependsOn) auf alle drei, blockt aber die Auslieferung nicht.'
  ],
  antiPatterns: [
    'Die drei unabhängigen Module künstlich seriell verketten (maxParallel = 1).',
    'Das Review als required deklarieren und damit eine saubere Lieferung rot färben.'
  ],
  referencePlan: {
    version: 1,
    goal: 'Drei unabhängige Hilfsmodule mit optionalem Review liefern',
    maxParallel: 3,
    tasks: [
      {
        id: 'telemetry',
        title: 'Telemetrie-Formatter',
        role: 'coder',
        prompt: 'Implementiere src/main/util/telemetryFormat.ts als reine Formatierfunktion. Eigene Tests inklusive.',
        dependsOn: [],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['telemetry'],
        ownership: 'feature',
        expectedFiles: ['src/main/util/telemetryformat.ts']
      },
      {
        id: 'catalog',
        title: 'Modellkatalog-Filter',
        role: 'coder',
        prompt: 'Implementiere src/main/util/modelCatalogFilter.ts als reine Filterfunktion. Eigene Tests inklusive.',
        dependsOn: [],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['catalog'],
        ownership: 'feature',
        expectedFiles: ['src/main/util/modelcatalogfilter.ts']
      },
      {
        id: 'inbox',
        title: 'Inbox-Sortierer',
        role: 'coder',
        prompt: 'Implementiere src/main/util/inboxSort.ts als reine Sortierfunktion. Eigene Tests inklusive.',
        dependsOn: [],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['inbox'],
        ownership: 'feature',
        expectedFiles: ['src/main/util/inboxsort.ts']
      },
      {
        id: 'review',
        title: 'Konsistenz-Review der drei Module',
        role: 'reviewer',
        prompt: 'Prüfe die drei Module auf einheitlichen Stil, Rein-Funktionalität und Testabdeckung. Nur Bericht, keine Codeänderung.',
        dependsOn: [],
        advisoryDependsOn: ['telemetry', 'catalog', 'inbox'],
        criticality: 'advisory',
        conflictKeys: ['review-only'],
        ownership: 'feature',
        expectedFiles: []
      }
    ]
  }
}

const mediumNewMcpTool: OrchestratorTrainingScenario = {
  id: 'medium-new-mcp-tool',
  title: 'Feature-Fan-in mit Integrator zuletzt',
  teamSize: 'medium',
  difficulty: 'experte',
  mode: 'execute_plan',
  focus: ['integrator-last', 'advisory-before-integrator', 'security-gate'],
  roles: ['backend', 'ui', 'security'],
  goalPrompt:
    'Füge ein neues MCP-Tool list_findings von Ende zu Ende hinzu: Server-Handler, Renderer-Panel und die geteilte IPC-/Typen-Verdrahtung.',
  successCriteria: [
    'Server-Handler und Panel laufen als parallele Feature-Tasks.',
    'Das advisory Security-Review prüft die Feature-Module VOR dem Integrator.',
    'Der EINE Integrator besitzt src/shared/ipc.ts und src/shared/orchestrator.ts und hängt an ALLEN anderen Tasks (inkl. Review) — er läuft zuletzt.'
  ],
  antiPatterns: [
    'Einen Review-Task NACH dem Integrator einplanen — der Integrator müsste dann von ihm abhängen und es entsteht ein Zyklus.',
    'Server- und Panel-Task beide die geteilten Typen ändern lassen statt sie im Integrator zu bündeln.'
  ],
  referencePlan: {
    version: 1,
    goal: 'MCP-Tool list_findings end-to-end mit gebündelter Integration',
    maxParallel: 2,
    tasks: [
      {
        id: 'server',
        title: 'Server-Handler',
        role: 'backend',
        prompt: 'Implementiere den list_findings-Handler in src/main/orchestrator/tools/listFindings.ts gegen die dokumentierte Findings-Schnittstelle. Keine geteilten Typen anfassen.',
        dependsOn: [],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['mcp-server'],
        ownership: 'feature',
        expectedFiles: ['src/main/orchestrator/tools/listfindings.ts']
      },
      {
        id: 'panel',
        title: 'Renderer-Panel',
        role: 'ui',
        prompt: 'Baue src/renderer/src/components/FindingsBoard.tsx, das die Findings anzeigt. Erwarte die Datenform vom Findings-Board-Vertrag.',
        dependsOn: [],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['mcp-ui'],
        ownership: 'feature',
        expectedFiles: ['src/renderer/src/components/findingsboard.tsx']
      },
      {
        id: 'security-review',
        title: 'Security-Review der Module',
        role: 'security',
        prompt: 'Prüfe Handler und Panel auf Eingabevalidierung, Ausgabe-Encoding und fehlende Fehlerpfade. Nur Bericht.',
        dependsOn: [],
        advisoryDependsOn: ['server', 'panel'],
        criticality: 'advisory',
        conflictKeys: ['review-only'],
        ownership: 'feature',
        expectedFiles: []
      },
      {
        id: 'integrate',
        title: 'IPC und geteilte Typen verdrahten',
        role: 'backend',
        prompt: 'Registriere das Tool im geteilten IPC-Kanal und ergänze die Typen. Nutze die Commits von server und panel sowie das Security-Review.',
        dependsOn: ['server', 'panel'],
        advisoryDependsOn: ['security-review'],
        criticality: 'required',
        conflictKeys: [],
        ownership: 'integrator',
        expectedFiles: ['src/shared/ipc.ts', 'src/shared/orchestrator.ts']
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Tier 3 — Großes Team: breite Fächerung, EIN Trichter, Abhängigkeitsebenen.
// ---------------------------------------------------------------------------

const largeWorkspaceRefresh: OrchestratorTrainingScenario = {
  id: 'large-workspace-refresh',
  title: 'Sechs UI-Bausteine mit einem Style-Integrator',
  teamSize: 'large',
  difficulty: 'experte',
  mode: 'execute_plan',
  focus: ['wide-fan-out', 'single-integrator-funnel', 'conflict-keys', 'advisory-audit'],
  roles: ['ui', 'reviewer'],
  goalPrompt:
    'Überarbeite die Workspace-Oberfläche: sechs voneinander unabhängige Komponenten sollen erneuert werden und danach einheitlich in die globalen Styles eingebunden werden.',
  successCriteria: [
    'Sechs parallele Feature-Tasks, je eine eigene Komponente und ein eigener conflictKey.',
    'Ein advisory Accessibility-Review wartet auf alle sechs.',
    'GENAU EIN Integrator besitzt src/renderer/src/styles.css und hängt an allen sechs Features plus dem Review; maxParallel spiegelt die echte Breite (6).'
  ],
  antiPatterns: [
    'Mehrere Tasks gleichzeitig die globale styles.css ändern lassen.',
    'maxParallel = 1 setzen und damit sechs unabhängige Aufgaben künstlich serialisieren.',
    'Zwei Integratoren einplanen — nur einer ist erlaubt.'
  ],
  referencePlan: {
    version: 1,
    goal: 'Sechs Workspace-Komponenten erneuern und zentral in die Styles einbinden',
    maxParallel: 6,
    tasks: [
      {
        id: 'comp-sidebar',
        title: 'Sidebar erneuern',
        role: 'ui',
        prompt: 'Erneuere src/renderer/src/components/Sidebar.tsx. Nutze nur lokale Styles; globale styles.css NICHT anfassen.',
        dependsOn: [],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['comp-sidebar'],
        ownership: 'feature',
        expectedFiles: ['src/renderer/src/components/sidebar.tsx']
      },
      {
        id: 'comp-titlebar',
        title: 'Titlebar erneuern',
        role: 'ui',
        prompt: 'Erneuere src/renderer/src/components/TitleBar.tsx. Globale styles.css NICHT anfassen.',
        dependsOn: [],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['comp-titlebar'],
        ownership: 'feature',
        expectedFiles: ['src/renderer/src/components/titlebar.tsx']
      },
      {
        id: 'comp-voicebar',
        title: 'VoiceBar erneuern',
        role: 'ui',
        prompt: 'Erneuere src/renderer/src/components/VoiceBar.tsx. Globale styles.css NICHT anfassen.',
        dependsOn: [],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['comp-voicebar'],
        ownership: 'feature',
        expectedFiles: ['src/renderer/src/components/voicebar.tsx']
      },
      {
        id: 'comp-inbox',
        title: 'InboxPanel erneuern',
        role: 'ui',
        prompt: 'Erneuere src/renderer/src/components/InboxPanel.tsx. Globale styles.css NICHT anfassen.',
        dependsOn: [],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['comp-inbox'],
        ownership: 'feature',
        expectedFiles: ['src/renderer/src/components/inboxpanel.tsx']
      },
      {
        id: 'comp-limits',
        title: 'LimitsPanel erneuern',
        role: 'ui',
        prompt: 'Erneuere src/renderer/src/components/LimitsPanel.tsx. Globale styles.css NICHT anfassen.',
        dependsOn: [],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['comp-limits'],
        ownership: 'feature',
        expectedFiles: ['src/renderer/src/components/limitspanel.tsx']
      },
      {
        id: 'comp-orchestrator',
        title: 'OrchestratorPanel erneuern',
        role: 'ui',
        prompt: 'Erneuere src/renderer/src/components/OrchestratorPanel.tsx. Globale styles.css NICHT anfassen.',
        dependsOn: [],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['comp-orchestrator'],
        ownership: 'feature',
        expectedFiles: ['src/renderer/src/components/orchestratorpanel.tsx']
      },
      {
        id: 'a11y-review',
        title: 'Accessibility-Review',
        role: 'reviewer',
        prompt: 'Prüfe alle sechs erneuerten Komponenten auf Fokus, Kontrast und ARIA. Nur Bericht.',
        dependsOn: [],
        advisoryDependsOn: [
          'comp-sidebar',
          'comp-titlebar',
          'comp-voicebar',
          'comp-inbox',
          'comp-limits',
          'comp-orchestrator'
        ],
        criticality: 'advisory',
        conflictKeys: ['review-only'],
        ownership: 'feature',
        expectedFiles: []
      },
      {
        id: 'integrate-styles',
        title: 'Globale Styles zusammenführen',
        role: 'ui',
        prompt: 'Führe die von den sechs Komponenten benötigten globalen Styles konsistent in src/renderer/src/styles.css zusammen. Nutze die Feature-Commits und das a11y-Review.',
        dependsOn: [
          'comp-sidebar',
          'comp-titlebar',
          'comp-voicebar',
          'comp-inbox',
          'comp-limits',
          'comp-orchestrator'
        ],
        advisoryDependsOn: ['a11y-review'],
        criticality: 'required',
        conflictKeys: [],
        ownership: 'integrator',
        expectedFiles: ['src/renderer/src/styles.css']
      }
    ]
  }
}

const largeLayeredPipeline: OrchestratorTrainingScenario = {
  id: 'large-layered-pipeline',
  title: 'Geschichteter DAG: Design → Umsetzung → Integration',
  teamSize: 'large',
  difficulty: 'experte',
  mode: 'execute_plan',
  focus: ['layered-dependencies', 'design-first', 'integrator-last'],
  roles: ['architect', 'coder', 'tester'],
  goalPrompt:
    'Entwirf und implementiere ein neues Retro-Analyse-Subsystem in vier Modulen, mit vorgeschaltetem Schnittstellendesign und abschließender Integration ins geteilte Orchestrator-Schema.',
  successCriteria: [
    'Ebene 1: ein Design-Task legt Schnittstellen fest (keine Codeänderung nötig).',
    'Ebene 2: vier Umsetzungs-Tasks hängen am Design und laufen parallel (maxParallel = 4).',
    'Ein advisory Verify-Task wartet auf alle vier; der EINE Integrator besitzt src/shared/orchestrator.ts und hängt an Design, allen vier Modulen und dem Verify.'
  ],
  antiPatterns: [
    'Die vier Module ohne gemeinsames Design starten und dann Schnittstellen kollidieren lassen.',
    'Den Integrator ein Modul vergessen lassen — er MUSS von jedem anderen Task abhängen.'
  ],
  referencePlan: {
    version: 1,
    goal: 'Retro-Analyse-Subsystem geschichtet planen, bauen und integrieren',
    maxParallel: 4,
    tasks: [
      {
        id: 'design',
        title: 'Schnittstellendesign',
        role: 'architect',
        prompt: 'Lege die vier Modul-Schnittstellen und das geteilte Datenmodell fest und veröffentliche sie auf dem Findings-Board. Keine Implementierung.',
        dependsOn: [],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['design-notes'],
        ownership: 'feature',
        expectedFiles: []
      },
      {
        id: 'impl-collect',
        title: 'Modul: Sammeln',
        role: 'coder',
        prompt: 'Implementiere src/main/orchestrator/retro/collect.ts gegen das Design. Eigene Tests.',
        dependsOn: ['design'],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['retro-collect'],
        ownership: 'feature',
        expectedFiles: ['src/main/orchestrator/retro/collect.ts']
      },
      {
        id: 'impl-score',
        title: 'Modul: Bewerten',
        role: 'coder',
        prompt: 'Implementiere src/main/orchestrator/retro/score.ts gegen das Design. Eigene Tests.',
        dependsOn: ['design'],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['retro-score'],
        ownership: 'feature',
        expectedFiles: ['src/main/orchestrator/retro/score.ts']
      },
      {
        id: 'impl-aggregate',
        title: 'Modul: Aggregieren',
        role: 'coder',
        prompt: 'Implementiere src/main/orchestrator/retro/aggregate.ts gegen das Design. Eigene Tests.',
        dependsOn: ['design'],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['retro-aggregate'],
        ownership: 'feature',
        expectedFiles: ['src/main/orchestrator/retro/aggregate.ts']
      },
      {
        id: 'impl-export',
        title: 'Modul: Exportieren',
        role: 'coder',
        prompt: 'Implementiere src/main/orchestrator/retro/exportReport.ts gegen das Design. Eigene Tests.',
        dependsOn: ['design'],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['retro-export'],
        ownership: 'feature',
        expectedFiles: ['src/main/orchestrator/retro/exportreport.ts']
      },
      {
        id: 'verify',
        title: 'End-to-End-Verifikation',
        role: 'tester',
        prompt: 'Prüfe die vier Module im Zusammenspiel gegen das Design. Nur Bericht, keine Codeänderung.',
        dependsOn: [],
        advisoryDependsOn: ['impl-collect', 'impl-score', 'impl-aggregate', 'impl-export'],
        criticality: 'advisory',
        conflictKeys: ['review-only'],
        ownership: 'feature',
        expectedFiles: []
      },
      {
        id: 'integrate',
        title: 'Ins geteilte Schema integrieren',
        role: 'coder',
        prompt: 'Verdrahte die vier Module über das geteilte Orchestrator-Schema. Nutze Design, Modul-Commits und den Verify-Bericht.',
        dependsOn: ['design', 'impl-collect', 'impl-score', 'impl-aggregate', 'impl-export'],
        advisoryDependsOn: ['verify'],
        criticality: 'required',
        conflictKeys: [],
        ownership: 'integrator',
        expectedFiles: ['src/shared/orchestrator.ts']
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Tier 4 — Fallen und Sonderfälle: Ownership-Trichter, Re-Plan, Benchmark.
// ---------------------------------------------------------------------------

const trapSharedCollision: OrchestratorTrainingScenario = {
  id: 'trap-shared-schema-collision',
  title: 'Falle: zwei Features wollen dasselbe Schema',
  teamSize: 'small',
  difficulty: 'experte',
  mode: 'execute_plan',
  focus: ['recognize-shared-hotspot', 'funnel-to-integrator'],
  roles: ['coder'],
  goalPrompt:
    'Baue Export UND Import für Tasks. Beide Richtungen brauchen ein zusätzliches Feld im geteilten Orchestrator-Task-Schema.',
  successCriteria: [
    'Erkennen, dass "beide ändern src/shared/orchestrator.ts" die Falle ist.',
    'Feature-Tasks liefern nur ihre Module und deklarieren KEINE geteilte Datei.',
    'EIN Integrator besitzt src/shared/orchestrator.ts und hängt an beiden Features.'
  ],
  antiPatterns: [
    'Beide Feature-Tasks src/shared/orchestrator.ts in expectedFiles setzen — der Validator fällt auf einen einzigen Fallback-Task zurück.',
    'Zwei getrennte Schema-Änderungen parallel einplanen und Merge-Konflikte riskieren.'
  ],
  referencePlan: {
    version: 1,
    goal: 'Task-Export und -Import mit einer einzigen Schemaänderung liefern',
    maxParallel: 2,
    tasks: [
      {
        id: 'export',
        title: 'Export-Modul',
        role: 'coder',
        prompt: 'Implementiere src/main/features/taskExport.ts. Erwarte das neue Feld vom Schema; deklariere die shared-Datei NICHT selbst, sondern dokumentiere den Bedarf auf dem Findings-Board.',
        dependsOn: [],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['task-export'],
        ownership: 'feature',
        expectedFiles: ['src/main/features/taskexport.ts']
      },
      {
        id: 'import',
        title: 'Import-Modul',
        role: 'coder',
        prompt: 'Implementiere src/main/features/taskImport.ts. Erwarte dasselbe neue Feld vom Schema; deklariere die shared-Datei NICHT selbst.',
        dependsOn: [],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['task-import'],
        ownership: 'feature',
        expectedFiles: ['src/main/features/taskimport.ts']
      },
      {
        id: 'integrate-schema',
        title: 'Geteiltes Schema einmal erweitern',
        role: 'coder',
        prompt: 'Ergänze das von Export und Import benötigte Feld genau einmal im geteilten Orchestrator-Schema. Nutze beide Findings-Board-Verträge.',
        dependsOn: ['export', 'import'],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: [],
        ownership: 'integrator',
        expectedFiles: ['src/shared/orchestrator.ts']
      }
    ]
  }
}

const recoveryReplan: OrchestratorTrainingScenario = {
  id: 'recovery-focused-replan',
  title: 'Fokussierter Folgeplan nach einem Fehlschlag',
  teamSize: 'small',
  difficulty: 'experte',
  mode: 'execute_plan',
  focus: ['re-plan-loop', 'no-blind-retry', 'root-cause'],
  roles: ['coder', 'reviewer'],
  goalPrompt:
    'Der erste Plan lief, aber der Pflicht-Task "Migration schreiben" ist mit einem Worker-Blocker (fehlendes Schema-Feld) fehlgeschlagen. Bringe das Ziel zu Ende.',
  successCriteria: [
    'Zuerst get_plan_status und list_findings auswerten, um die WAHRE Ursache zu finden.',
    'Statt eines identischen Blind-Retrys einen KLEINEN, fokussierten Folgeplan einreichen, der die Ursache adressiert.',
    'Der Folgeplan darf eine bisher ungenutzte Rolle (reviewer) hinzunehmen und belegt den Fix.'
  ],
  antiPatterns: [
    'Denselben fehlgeschlagenen Task unverändert erneut dispatchen.',
    'Das ganze große Team neu starten, obwohl nur ein Ursachen-Fix nötig ist.'
  ],
  referencePlan: {
    version: 1,
    goal: 'Ursache des Migrations-Blockers beheben und verifizieren',
    maxParallel: 1,
    tasks: [
      {
        id: 'fix-schema-gap',
        title: 'Fehlendes Schema-Feld nachziehen',
        role: 'coder',
        prompt: 'Ergänze das im Blocker genannte fehlende Feld und passe die Migration an. Belege: Migration läuft grün durch, Tests grün.',
        dependsOn: [],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['migration-fix'],
        ownership: 'feature',
        expectedFiles: []
      },
      {
        id: 'verify-fix',
        title: 'Fix gegenprüfen',
        role: 'reviewer',
        prompt: 'Verifiziere, dass der Blocker nicht mehr auftritt und keine Regression entstanden ist. Nur Bericht.',
        dependsOn: [],
        advisoryDependsOn: ['fix-schema-gap'],
        criticality: 'advisory',
        conflictKeys: ['review-only'],
        ownership: 'feature',
        expectedFiles: []
      }
    ]
  }
}

const benchmarkBakeoff: OrchestratorTrainingScenario = {
  id: 'benchmark-model-bakeoff',
  title: 'Benchmark: dieselbe Aufgabe an alle Slots',
  teamSize: 'medium',
  difficulty: 'experte',
  mode: 'run_benchmark',
  focus: ['benchmark-mode', 'fair-scoring', 'record-retro'],
  roles: ['claude', 'codex', 'copilot'],
  goalPrompt:
    'Finde heraus, welches Modell einen kniffligen Refactor der Semaphore-Logik am besten löst.',
  successCriteria: [
    'KEIN execute_plan-DAG: run_benchmark(prompt, title) gibt allen Slots DIESELBE Aufgabe in isolierten Worktrees.',
    'get_benchmark_status bis zum Terminalstatus pollen; Details je Lauf über get_task_status.',
    'record_benchmark mit fairem Score (0-10), Verdict und Stärken/Schwächen je Teilnehmer; danach dem Nutzer die begründete Rangliste zusammenfassen.'
  ],
  antiPatterns: [
    'Die Aufgabe unter den Slots aufteilen statt sie identisch zu vergeben.',
    'Ohne record_benchmark abschließen, sodass kein Modellwissen für spätere Läufe entsteht.'
  ]
  // Kein referencePlan: run_benchmark erzeugt keinen execute_plan-DAG.
}

/** Vollständiger Trainingskatalog, von "wenige Subagents" zu "großes Team". */
export const orchestratorTrainingScenarios: readonly OrchestratorTrainingScenario[] = [
  soloReadmeTypo,
  soloFlakyTest,
  smallUtilPlusTest,
  smallProfileField,
  mediumIndependentModules,
  mediumNewMcpTool,
  largeWorkspaceRefresh,
  largeLayeredPipeline,
  trapSharedCollision,
  recoveryReplan,
  benchmarkBakeoff
]

/** Nachschlagen eines Szenarios über seine stabile id. */
export function trainingScenarioById(id: string): OrchestratorTrainingScenario | undefined {
  return orchestratorTrainingScenarios.find((scenario) => scenario.id === id)
}
