/**
 * Retro-Analyse-CLI: liest neue Retros/Benchmarks vom Retro-Daten-Branch,
 * aggregiert sie deterministisch und lässt Claude daraus (a) das Overlay-
 * Regelwerk revidieren und (b) bis zu drei Verbesserungs-Briefs generieren.
 *
 *   pnpm run retro:analyze -- --dir /pfad/zum/retros-checkout [--write]
 *     [--min-new 3] [--summary-file summary.md]
 *
 * Ohne --write ist der Lauf ein Dry-Run und druckt nur die geplanten
 * Änderungen. Benötigt ANTHROPIC_API_KEY; Modell via ORCA_RETRO_MODEL
 * überschreibbar (Default: claude-sonnet-5).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import {
  aggregateForSynthesis,
  collectNew,
  INITIAL_ANALYSIS_STATE,
  nextState,
  parseAnalysisState,
  parseBranchFiles,
  proposalFileName,
  renderProposalMarkdown,
  synthesisOutputSchema,
  type BranchFile,
  type SynthesisInput,
  type SynthesisOutput
} from '../src/shared/retroAnalysis'
import { planRetroAnalysisSeed, seedRetroAnalysisArtifacts } from './retroSeed'

const OVERLAY_PATH = 'overlay/learnings.md'
const STATE_PATH = 'state/last-analysis.json'

const SYNTHESIS_SYSTEM_PROMPT = [
  'Du analysierst Retrospektiven des Multi-Agent-Orchestrators Orca-Strator und pflegst',
  'dessen Overlay-Regelwerk. Das Overlay wird wörtlich in den System-Prompt des',
  'Orchestrators injiziert und steuert künftige Läufe (Rollenwahl, Delegation,',
  'Planungs- und Prüfstrategie).',
  '',
  'Du erhältst als JSON: aggregierte Modell-Statistiken (stats), verdichtete Learnings',
  '(learnings, bereits auf >= 2 Beobachtungen oder Benchmark-Beleg gefiltert),',
  'Benchmark-Urteile (benchmarkVerdicts), das aktuelle Overlay (currentOverlay) und',
  'bereits existierende Proposal-Slugs (existingProposalSlugs).',
  '',
  'Regeln für das Overlay:',
  '- REVIDIERE currentOverlay, statt es blind neu zu generieren: behalte Regeln, die',
  '  nicht durch neue Daten widerlegt sind; entferne widerlegte; ergänze neue.',
  '- Nimm nur Regeln auf, die durch die gelieferten Daten belegt sind (Beobachtungen,',
  '  Statistiken oder Benchmark-Urteile). Lieber weniger Regeln als spekulative.',
  '- Maximal 15 Regeln, jede als eigenes "- "-Bullet, maximal 2 Zeilen, deutsch,',
  '  imperativ formuliert und zur Orchestrierungszeit umsetzbar.',
  '- Nenne Provider/Modell nur bei modellspezifischen Erkenntnissen.',
  '- Niemals Secrets, wörtliche Nutzerziele oder workspace-spezifische Pfade aufnehmen.',
  '- Optional gliedern mit "## "-Überschriften. Nur Markdown, kein Front-Matter.',
  '',
  'Regeln für Proposals (Verbesserungs-Briefs):',
  '- Maximal 3, nur für strukturelle Probleme, die eine Overlay-Regel NICHT lösen kann',
  '  (z. B. Prompt-Template in src/main/orchestrator/orchestratorLaunch.ts, MCP-Tools in',
  '  src/main/orchestrator/OrcaMcpServer.ts, Engine-/Scheduler-Logik).',
  '- Jedes prompt-Feld ist ein eigenständiger, direkt ausführbarer Claude-Code-Auftrag',
  '  gegen das Orca-Strator-Repository: konkrete Dateipfade, gewünschtes Verhalten,',
  '  Abnahmekriterium "pnpm run ci grün".',
  '- Keine Duplikate zu existingProposalSlugs. Lieber kein Proposal als ein spekulatives.',
  '',
  'notes: kurze deutsche Zusammenfassung deiner Analyse für den Review-PR',
  '(was hat sich geändert und warum, auffällige Trends).'
].join('\n')

interface CliOptions {
  dir: string
  write: boolean
  minNew: number
  summaryFile?: string
}

function readCliOptions(): CliOptions {
  // pnpm reicht das Argument-Trennzeichen "--" an das Skript durch.
  const argv = process.argv.slice(2)
  const { values } = parseArgs({
    args: argv[0] === '--' ? argv.slice(1) : argv,
    options: {
      dir: { type: 'string' },
      write: { type: 'boolean', default: false },
      'min-new': { type: 'string' },
      'summary-file': { type: 'string' }
    }
  })
  if (!values.dir) {
    console.error('Fehler: --dir <retros-checkout> ist erforderlich.')
    process.exit(2)
  }
  const minNew = Number(values['min-new'] ?? process.env.ORCA_RETRO_MIN_NEW ?? 3)
  return {
    dir: values.dir,
    write: Boolean(values.write),
    minNew: Number.isFinite(minNew) && minNew >= 0 ? minNew : 3,
    summaryFile: values['summary-file']
  }
}

function walkJsonFiles(root: string, subdir: string): BranchFile[] {
  const base = join(root, subdir)
  if (!existsSync(base)) return []
  const files: BranchFile[] = []
  const visit = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        visit(join(dir, entry.name), path)
      } else if (entry.name.endsWith('.json')) {
        try {
          files.push({ path, json: JSON.parse(readFileSync(join(dir, entry.name), 'utf8')) })
        } catch {
          console.warn(`Überspringe nicht parsebare Datei: ${path}`)
        }
      }
    }
  }
  visit(base, subdir)
  return files
}

function readOverlay(root: string): string {
  try {
    return readFileSync(join(root, OVERLAY_PATH), 'utf8')
  } catch {
    return ''
  }
}

function existingProposalSlugs(root: string): string[] {
  const dir = join(root, 'proposals')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, ''))
}

async function runSynthesis(input: SynthesisInput): Promise<SynthesisOutput> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Fehler: ANTHROPIC_API_KEY ist nicht gesetzt.')
    process.exit(2)
  }
  const client = new Anthropic()
  const response = await client.messages.parse({
    model: process.env.ORCA_RETRO_MODEL ?? 'claude-sonnet-5',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: SYNTHESIS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: JSON.stringify(input) }],
    output_config: { format: zodOutputFormat(synthesisOutputSchema) }
  })
  if (response.stop_reason === 'refusal' || !response.parsed_output) {
    console.error(
      `Fehler: Synthese lieferte kein valides Ergebnis (stop_reason=${response.stop_reason}). Keine Dateien geschrieben.`
    )
    process.exit(1)
  }
  return response.parsed_output
}

function buildSummary(
  input: SynthesisInput,
  output: SynthesisOutput,
  writtenProposals: string[]
): string {
  return [
    '## Retro-Analyse',
    '',
    `- Neue Retros: ${input.newRetroCount} · Neue Benchmarks: ${input.newBenchmarkCount} · Maschinen: ${input.machineCount}`,
    `- Learnings in der Synthese (nach Konservativitäts-Gate): ${input.learnings.length}`,
    `- Overlay: ${output.overlay.split('\n').filter((line) => line.startsWith('- ')).length} Regel(n)`,
    writtenProposals.length > 0
      ? `- Neue Proposals: ${writtenProposals.map((path) => `\`${path}\``).join(', ')}`
      : '- Neue Proposals: keine',
    '',
    '### Analyse-Notizen',
    '',
    output.notes.trim(),
    ''
  ].join('\n')
}

async function main(): Promise<void> {
  const options = readCliOptions()
  const root = options.dir

  const seedPaths = planRetroAnalysisSeed(root)
  if (seedPaths.length > 0) {
    if (options.write) {
      for (const path of seedRetroAnalysisArtifacts(root)) {
        console.log(`Bootstrap angelegt: ${path}`)
      }
    } else {
      console.log(
        `::notice::Bootstrap erforderlich (Dry-Run, nicht geschrieben): ${seedPaths.join(', ')}`
      )
    }
  }

  const stateJson = existsSync(join(root, STATE_PATH))
    ? JSON.parse(readFileSync(join(root, STATE_PATH), 'utf8'))
    : undefined
  const state = stateJson ? parseAnalysisState(stateJson) : INITIAL_ANALYSIS_STATE

  const branch = parseBranchFiles([
    ...walkJsonFiles(root, 'runs'),
    ...walkJsonFiles(root, 'benchmarks'),
    ...walkJsonFiles(root, 'learnings')
  ])
  for (const path of branch.skipped) {
    console.warn(`::warning::Nicht auswertbare Datei übersprungen: ${path}`)
  }

  const newRetros = collectNew(branch.retros, (entry) => entry.retro.createdAt, state)
  const newBenchmarks = collectNew(branch.benchmarks, (entry) => entry.record.createdAt, state)

  if (newRetros.length < options.minNew) {
    console.log(
      `::notice::Nur ${newRetros.length} neue Retro(s) (< ${options.minNew}) — Analyse übersprungen.`
    )
    return
  }

  const input = aggregateForSynthesis({
    retros: newRetros,
    benchmarks: newBenchmarks,
    learningsSnapshots: branch.learnings,
    currentOverlay: readOverlay(root),
    existingProposalSlugs: existingProposalSlugs(root)
  })

  console.log(
    `Analysiere ${input.newRetroCount} Retro(s), ${input.newBenchmarkCount} Benchmark(s), ${input.learnings.length} Learning(s)…`
  )
  const output = await runSynthesis(input)

  const dateIso = new Date().toISOString().slice(0, 10)
  const overlayContent = `${output.overlay.trim()}\n`
  const proposals = output.proposals.filter(
    (proposal) => !input.existingProposalSlugs.includes(proposal.slug)
  )
  const processedPaths = [
    ...newRetros.map((entry) => entry.path),
    ...newBenchmarks.map((entry) => entry.path)
  ]
  const newState = nextState(state, processedPaths, Date.now())

  const plannedWrites: Array<{ path: string; content: string }> = [
    { path: OVERLAY_PATH, content: overlayContent },
    ...proposals.map((proposal) => ({
      path: proposalFileName(dateIso, proposal.slug),
      content: renderProposalMarkdown(proposal, dateIso, {
        retroCount: input.newRetroCount,
        benchmarkCount: input.newBenchmarkCount
      })
    })),
    { path: STATE_PATH, content: `${JSON.stringify(newState, null, 2)}\n` }
  ]

  if (!options.write) {
    console.log('\nDry-Run — geplante Änderungen (mit --write anwenden):')
    for (const write of plannedWrites) {
      console.log(`\n=== ${write.path} ===\n${write.content}`)
    }
  } else {
    for (const write of plannedWrites) {
      const target = join(root, write.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, write.content, 'utf8')
      console.log(`Geschrieben: ${write.path}`)
    }
  }

  const summary = buildSummary(
    input,
    output,
    proposals.map((proposal) => proposalFileName(dateIso, proposal.slug))
  )
  console.log(`\n${summary}`)
  if (options.summaryFile) {
    writeFileSync(options.summaryFile, summary, 'utf8')
  }
}

void main().catch((error) => {
  console.error('Retro-Analyse fehlgeschlagen:', error instanceof Error ? error.message : error)
  process.exit(1)
})
