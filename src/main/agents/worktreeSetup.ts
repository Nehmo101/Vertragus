/**
 * Profil-deklarierte Warm-up-Befehle für frische Worktrees (z. B. Codegen wie
 * `corepack pnpm --filter @scope/database db:generate`). Retro 2026-07-29: die
 * Paketinstallation allein reicht nicht — ohne generierte Prisma-Clients bricht
 * der repo-weite Typecheck in unberührten Paketen und der Lauf wird fälschlich
 * dem Modell angelastet.
 *
 * Vertrauensmodell wie `autoPr.qualityGates`: der Profil-Besitzer deklariert
 * lokale Kommandos für sein eigenes Repository. Trotzdem defensiv: es wird NIE
 * eine Shell gespawnt und Shell-Metazeichen werden hart abgelehnt, damit aus
 * einem Befehl keine Befehlskette werden kann.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveLaunch } from '@main/agents/resolveCommand'

const execFileAsync = promisify(execFile)

/** Codegen darf dauern (Prisma, große Schemata) — gleiche Grenze wie Installs. */
const SETUP_TIMEOUT_MS = 10 * 60_000
const OUTPUT_TAIL_CHARS = 600

/** Zeichen, die eine Shell zu Ketten/Substitutionen machen würde. */
const FORBIDDEN_CHARS = /[&|;<>$`(){}"'\\\n\r*?~#!]/

export interface WorktreeSetupResult {
  command: string
  durationMs: number
}

export class WorktreeSetupError extends Error {
  readonly code = 'worktree-setup-failed'
  constructor(
    message: string,
    readonly command: string
  ) {
    super(message)
    this.name = 'WorktreeSetupError'
  }
}

/**
 * Zerlegt einen Warm-up-Befehl in argv-Elemente. Nur Whitespace trennt;
 * jedes Shell-Metazeichen lehnt den ganzen Befehl ab (fail closed) — es gibt
 * bewusst kein Quoting: Pfade mit Leerzeichen gehören nicht in Warm-ups.
 */
export function tokenizeSetupCommand(command: string): string[] {
  const trimmed = command.trim()
  if (!trimmed) {
    throw new WorktreeSetupError('Leerer Warm-up-Befehl.', command)
  }
  const forbidden = FORBIDDEN_CHARS.exec(trimmed)
  if (forbidden) {
    throw new WorktreeSetupError(
      `Warm-up-Befehl enthält das unzulässige Zeichen »${forbidden[0]}« — Shell-Syntax ` +
        '(Ketten, Substitution, Quoting) wird nicht ausgeführt.',
      command
    )
  }
  return trimmed.split(/\s+/)
}

function outputTail(error: unknown): string {
  const withStreams = error as { stdout?: unknown; stderr?: unknown; message?: unknown }
  const text = [withStreams.stderr, withStreams.stdout]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .join('\n')
  const fallback = typeof withStreams.message === 'string' ? withStreams.message : String(error)
  return (text || fallback).slice(-OUTPUT_TAIL_CHARS)
}

/**
 * Führt die Warm-up-Befehle sequenziell im Worktree aus. Ein Fehlschlag bricht
 * sofort mit einem strukturierten Fehler ab — früh und benannt scheitern
 * schlägt einen später unerklärlich roten repo-weiten Gate-Lauf.
 */
export async function runWorktreeSetupCommands(
  commands: readonly string[],
  workingDir: string
): Promise<WorktreeSetupResult[]> {
  const results: WorktreeSetupResult[] = []
  for (const command of commands) {
    const [file, ...args] = tokenizeSetupCommand(command)
    const startedAt = Date.now()
    try {
      const launch = await resolveLaunch(file, args)
      await execFileAsync(launch.file, launch.args, {
        cwd: workingDir,
        windowsHide: true,
        timeout: SETUP_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new WorktreeSetupError(
          `Warm-up (${command}) fehlgeschlagen: '${file}' wurde nicht gefunden. PATH des ` +
            'App-Prozesses prüfen — Versionsmanager wie fnm/nvm verlinken oft nur node.',
          command
        )
      }
      throw new WorktreeSetupError(
        `Warm-up (${command}) fehlgeschlagen: ${outputTail(error)}`,
        command
      )
    }
    const durationMs = Date.now() - startedAt
    console.log(`[worktree-setup] ok (${durationMs} ms): ${command} @ ${workingDir}`)
    results.push({ command, durationMs })
  }
  return results
}
