/**
 * "Testdatenbank": builds a fully populated electron-store userData directory
 * (Vertragus has no relational database — persistence is JSON via
 * electron-store). Every seeded document is built through the PRODUCTION zod
 * schemas / typed contracts, so the seeds can never drift from the real store
 * shapes; a unit test additionally re-parses every file through the schemas
 * and the config migration.
 *
 * Usage (CLI):  tsx --tsconfig tsconfig.node.json scripts/testStore/seed.ts [targetDir]
 * Usage (API):  seedTestStore(targetDir)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  DEFAULT_PROFILE,
  workspaceProfileSchema,
  type WorkspaceProfile
} from '../../src/shared/profile'
import { EFFICIENCY_SOLO_PROFILE } from '../../src/shared/profilePresets'
import { mcpServersSchema } from '../../src/shared/mcp'
import { ideaSchema, type Idea } from '../../src/shared/inbox'
import type { BenchmarkRecord, ModelLearning, RunRetro } from '../../src/shared/retro'
import { CURRENT_CONFIG_SCHEMA_VERSION } from '../../src/main/config/migrations'

/** Deterministic timestamps so screenshot runs are reproducible. */
const T0 = Date.parse('2026-07-20T09:00:00Z')
const HOUR = 60 * 60 * 1000

const MULTI_SLOT_PROFILE: WorkspaceProfile = workspaceProfileSchema.parse({
  id: 'seed-multi',
  name: 'Seed · Adaptive Team',
  workingDir: '',
  orchestrator: {
    provider: 'claude',
    model: '',
    modelPreset: 'balanced',
    permissionMode: 'default',
    autoOpenSubwindows: true
  },
  agents: [
    {
      role: 'frontend',
      provider: 'codex',
      model: '',
      count: 2,
      orchestrated: true,
      yolo: false,
      strengths: ['UI-Iteration', 'CSS'],
      weaknesses: ['Architekturentscheidungen']
    },
    {
      role: 'backend',
      provider: 'claude',
      model: '',
      modelPreset: 'strong',
      count: 1,
      orchestrated: true,
      yolo: false,
      strengths: ['Refactorings', 'Schnittstellen'],
      weaknesses: []
    },
    {
      role: 'review',
      provider: 'kimi',
      model: '',
      count: 1,
      orchestrated: true,
      yolo: false,
      strengths: ['Code-Review'],
      weaknesses: []
    }
  ],
  solo: false,
  yoloDefault: false,
  planner: { mode: 'review', routingMode: 'adaptive', maxParallel: 4, maxRetries: 1 },
  benchmark: { enabled: false },
  multiAgent: { enabled: false, stopLosers: true },
  autoPr: { mode: 'draft-after-checks' },
  autoGit: { enabled: false, targetBranch: '' }
})

const BENCHMARK_PROFILE: WorkspaceProfile = workspaceProfileSchema.parse({
  ...MULTI_SLOT_PROFILE,
  id: 'seed-benchmark',
  name: 'Seed · Benchmark',
  benchmark: { enabled: true },
  autoPr: { mode: 'off' }
})

function seedLearnings(): ModelLearning[] {
  const base = { source: 'orchestrator' as const, createdAt: T0, updatedAt: T0 + HOUR }
  return [
    {
      ...base,
      id: 'seed-learning-1',
      provider: 'claude',
      model: 'sonnet',
      role: 'backend',
      kind: 'strength',
      insight: 'sehr stark bei mehrstufigen Refactorings',
      evidence: 'Plan seed-plan-1: 3/3 Tasks grün ohne Retry',
      observations: 3
    },
    {
      ...base,
      id: 'seed-learning-2',
      provider: 'codex',
      model: '',
      role: 'frontend',
      kind: 'strength',
      insight: 'schnelle, präzise UI-Iteration',
      evidence: 'Benchmark seed-bench-1: Score 8/10',
      observations: 2
    },
    {
      ...base,
      id: 'seed-learning-3',
      provider: 'codex',
      model: '',
      role: 'tests',
      kind: 'weakness',
      insight: 'Vitest-Läufe in der Windows-Sandbox schlagen mit spawn EPERM fehl',
      evidence: 'Run seed-retro-2: 2 Tasks als infrastructure klassifiziert',
      observations: 2
    }
  ]
}

function seedRetros(): RunRetro[] {
  return [
    {
      id: 'seed-retro-1',
      profileId: MULTI_SLOT_PROFILE.id,
      planId: 'seed-plan-1',
      goal: 'Settings-Dialog um Provider-Limits erweitern',
      status: 'success',
      summary: 'Alle drei Tasks grün; Integration ohne Konflikte.',
      modelStats: [
        {
          provider: 'claude',
          model: 'sonnet',
          roles: ['backend'],
          tasks: 2,
          succeeded: 2,
          needsWork: 0,
          failed: 0,
          stopped: 0,
          failuresByKind: { infra: 0, cancelled: 0, model: 0 },
          failedAttempts: 0,
          failedAttemptsByKind: { infra: 0, cancelled: 0, model: 0 },
          gateFindings: 0
        }
      ],
      learnings: seedLearnings().slice(0, 1),
      createdAt: T0 + 2 * HOUR
    },
    {
      id: 'seed-retro-2',
      profileId: MULTI_SLOT_PROFILE.id,
      planId: 'seed-plan-2',
      goal: 'Flaky E2E-Suite stabilisieren',
      status: 'needs-work',
      summary: 'Ziel erreicht, aber zwei Sandbox-EPERM-Blocker als Infrastruktur klassifiziert.',
      modelStats: [
        {
          provider: 'codex',
          model: '',
          roles: ['tests'],
          tasks: 2,
          succeeded: 1,
          needsWork: 1,
          failed: 0,
          stopped: 0,
          failuresByKind: { infra: 2, cancelled: 0, model: 0 },
          failedAttempts: 2,
          failedAttemptsByKind: { infra: 2, cancelled: 0, model: 0 },
          gateFindings: 1
        }
      ],
      learnings: seedLearnings().slice(2),
      createdAt: T0 + 5 * HOUR
    }
  ]
}

function seedBenchmarks(): BenchmarkRecord[] {
  return [
    {
      id: 'seed-bench-record-1',
      benchmarkId: 'seed-bench-1',
      profileId: BENCHMARK_PROFILE.id,
      task: 'Implementiere eine Debounce-Utility mit Tests',
      summary: 'Codex am schnellsten, Claude am gründlichsten.',
      rankings: [
        {
          role: 'frontend',
          provider: 'codex',
          model: '',
          score: 8,
          verdict: 'schnell und korrekt',
          strengths: ['Tempo'],
          weaknesses: ['knappe Tests'],
          durationMs: 4 * 60_000
        },
        {
          role: 'backend',
          provider: 'claude',
          model: 'sonnet',
          score: 9,
          verdict: 'vollständig inkl. Edge-Cases',
          strengths: ['Testtiefe'],
          weaknesses: ['langsamer'],
          durationMs: 7 * 60_000
        }
      ],
      createdAt: T0 + 3 * HOUR
    }
  ]
}

function seedIdeas(): Idea[] {
  const ideas: Idea[] = [
    {
      id: 'seed-idea-1',
      title: 'Voice-Overlay: Diktiermodus',
      content: 'Push-to-talk für lange Prompts; Transkript direkt in den Orchestrator.',
      status: 'draft',
      tags: ['voice', 'ux'],
      artifacts: [],
      createdAt: T0,
      updatedAt: T0
    },
    {
      id: 'seed-idea-2',
      title: 'Token-Dashboard pro Profil',
      content: 'Verbrauch je Lauf und Profil visualisieren; Efficiency-Solo als Vergleichslinie.',
      status: 'ready',
      tags: ['telemetry'],
      artifacts: [
        {
          id: 'seed-artifact-1',
          kind: 'text',
          label: 'Skizze',
          text: 'Balken je Lauf: Orchestrator vs. Solo.',
          createdAt: T0 + HOUR
        }
      ],
      createdAt: T0,
      updatedAt: T0 + HOUR
    },
    {
      id: 'seed-idea-3',
      title: 'Alte Notiz',
      content: 'Bereits umgesetzt.',
      status: 'done',
      tags: [],
      artifacts: [],
      createdAt: T0 - 24 * HOUR,
      updatedAt: T0 - 12 * HOUR
    }
  ]
  return ideas.map((idea) => ideaSchema.parse(idea))
}

export interface SeededTestStore {
  dir: string
  files: string[]
}

/** Write the complete seeded userData directory; returns the written files. */
export function seedTestStore(targetDir: string): SeededTestStore {
  const dir = resolve(targetDir)
  mkdirSync(dir, { recursive: true })

  const profiles = [DEFAULT_PROFILE, EFFICIENCY_SOLO_PROFILE, MULTI_SLOT_PROFILE, BENCHMARK_PROFILE]
  const config = {
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    profiles: profiles.map((profile) => workspaceProfileSchema.parse(profile)),
    activeProfileId: MULTI_SLOT_PROFILE.id,
    settings: {
      runRetros: seedRetros(),
      modelLearnings: seedLearnings(),
      benchmarkRecords: seedBenchmarks(),
      mcpServers: mcpServersSchema.parse([
        {
          id: 'seed-mcp-1',
          name: 'filesystem',
          enabled: false,
          transport: 'stdio',
          scope: 'all',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
          env: {},
          url: '',
          headers: {}
        }
      ])
    }
  }

  const files: string[] = []
  const write = (name: string, data: unknown): void => {
    const path = join(dir, name)
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    files.push(path)
  }
  write('vertragus.json', config)
  write('vertragus-inbox.json', { ideas: seedIdeas() })
  return { dir, files }
}

export const SEED_PROFILES = {
  MULTI_SLOT_PROFILE,
  BENCHMARK_PROFILE
}

// CLI entry: tsx --tsconfig tsconfig.node.json scripts/testStore/seed.ts [dir]
const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/testStore/seed.ts')
if (invokedDirectly) {
  const target = process.argv[2] ?? join(process.cwd(), 'e2e-artifacts', 'test-store')
  const { dir, files } = seedTestStore(target)
  console.log(`Test-Store geschrieben nach ${dir}:`)
  for (const file of files) console.log(`  ${file}`)
}
