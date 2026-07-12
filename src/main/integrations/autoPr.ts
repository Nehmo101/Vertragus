import { exec, execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AutoPrConfig } from '@shared/profile'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)
const MAX_OUTPUT = 8 * 1024 * 1024

export interface PreparedTaskChange {
  taskId: string
  title: string
  worktree: string
  branch: string
  commit: string
  files: string[]
}

export interface AutoPrOutcome {
  status: 'skipped' | 'prepared' | 'published' | 'blocked'
  message: string
  url?: string
  branch?: string
  worktree?: string
}

interface PrepareTaskInput {
  config: AutoPrConfig
  taskId: string
  title: string
  worktree?: string
}

interface PublishInput {
  config: AutoPrConfig
  goalId: string
  goalTitle: string
  changes: PreparedTaskChange[]
  /** Profile-bound default branch when autoPr.baseBranch is empty. */
  profileDefaultBranch?: string
}

async function runFile(cwd: string, command: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: MAX_OUTPUT
  })
  return (stdout || stderr || '').trim()
}

async function git(cwd: string, args: string[]): Promise<string> {
  return runFile(cwd, 'git', args)
}

function safeSlug(value: string, max = 42): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, max) || 'orca-task'
  )
}

function assertDiffLooksSafe(diff: string): void {
  if (Buffer.byteLength(diff, 'utf8') > 5 * 1024 * 1024) {
    throw new Error('Diff ist größer als 5 MiB; Auto-PR wurde sicherheitshalber blockiert.')
  }
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[opsu]_[A-Za-z0-9]{30,}\b/,
    /\bsk-[A-Za-z0-9_-]{32,}\b/
  ]
  if (secretPatterns.some((pattern) => pattern.test(diff))) {
    throw new Error('Mögliches Secret im Diff erkannt; Auto-PR wurde blockiert.')
  }
}

async function runQualityGates(cwd: string, gates: string[]): Promise<void> {
  for (const command of gates) {
    try {
      await execAsync(command, {
        cwd,
        windowsHide: true,
        timeout: 15 * 60_000,
        maxBuffer: MAX_OUTPUT,
        shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Quality Gate fehlgeschlagen: ${command}\n${detail}`)
    }
  }
}

export async function prepareTaskChange(input: PrepareTaskInput): Promise<AutoPrOutcome & { change?: PreparedTaskChange }> {
  if (input.config.mode === 'off') return { status: 'skipped', message: 'Auto-PR ist deaktiviert.' }
  if (!input.worktree) return { status: 'skipped', message: 'Task besitzt keinen Git-Worktree.' }

  let staged = false
  try {
    const status = await git(input.worktree, ['status', '--porcelain=v1'])
    if (!status) return { status: 'skipped', message: 'Keine Änderungen für Auto-PR.' }

    await runQualityGates(input.worktree, input.config.qualityGates)

    await git(input.worktree, ['add', '--all'])
    staged = true
    await git(input.worktree, ['diff', '--cached', '--check'])
    const stagedDiff = await git(input.worktree, ['diff', '--cached', '--no-ext-diff', '--binary'])
    assertDiffLooksSafe(stagedDiff)
    const files = (await git(input.worktree, ['diff', '--cached', '--name-only']))
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter(Boolean)
    if (files.length === 0) return { status: 'skipped', message: 'Keine versionierbaren Änderungen.' }

    await git(input.worktree, [
      'commit',
      '-m',
      `orca(${input.taskId}): ${input.title.trim().slice(0, 72)}`
    ])
    const branch = await git(input.worktree, ['branch', '--show-current'])
    const commit = await git(input.worktree, ['rev-parse', 'HEAD'])
    const change: PreparedTaskChange = {
      taskId: input.taskId,
      title: input.title,
      worktree: input.worktree,
      branch,
      commit,
      files
    }
    return {
      status: 'prepared',
      message: `${files.length} Datei(en) committed.`,
      branch,
      worktree: input.worktree,
      change
    }
  } catch (error) {
    if (staged) {
      try {
        // Reset only the index. Worktree content remains untouched for inspection.
        await git(input.worktree, ['reset', '--mixed', 'HEAD'])
      } catch {
        // Preserve the original error and surface the worktree path below.
      }
    }
    return {
      status: 'blocked',
      message: error instanceof Error ? error.message : String(error),
      worktree: input.worktree
    }
  }
}

async function repositoryRoot(cwd: string): Promise<string> {
  const porcelain = await git(cwd, ['worktree', 'list', '--porcelain'])
  const first = porcelain.match(/^worktree\s+(.+)$/m)?.[1]
  if (!first) throw new Error('Repository-Hauptworktree konnte nicht bestimmt werden.')
  return first.trim()
}

export function pickBaseBranch(
  configured: string,
  profileDefaultBranch?: string,
  remoteBranch?: string
): string {
  if (configured.trim()) return configured.trim()
  if (profileDefaultBranch?.trim()) return profileDefaultBranch.trim()
  if (remoteBranch?.trim()) return remoteBranch.trim()
  return 'main'
}

async function defaultBase(
  cwd: string,
  configured: string,
  profileDefaultBranch?: string
): Promise<string> {
  if (configured.trim()) return configured.trim()
  if (profileDefaultBranch?.trim()) return profileDefaultBranch.trim()
  try {
    const symbolic = await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    return symbolic.replace(/^origin\//, '')
  } catch {
    return 'main'
  }
}

async function findExistingPr(cwd: string, branch: string): Promise<string | undefined> {
  const raw = await runFile(cwd, 'gh', [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'all',
    '--json',
    'url',
    '--limit',
    '1'
  ])
  const rows = JSON.parse(raw || '[]') as Array<{ url?: string }>
  return rows[0]?.url
}

async function pushAndOpenPr(
  cwd: string,
  config: AutoPrConfig,
  branch: string,
  title: string,
  body: string,
  profileDefaultBranch?: string
): Promise<string> {
  if (['main', 'master'].includes(branch.toLowerCase())) {
    throw new Error(`Auto-PR verweigert Push auf geschützten Branch ${branch}.`)
  }
  await runFile(cwd, 'gh', ['auth', 'status'])
  await git(cwd, ['push', '--set-upstream', 'origin', branch])
  const existing = await findExistingPr(cwd, branch)
  if (existing) return existing

  const args = ['pr', 'create', '--head', branch, '--title', title, '--body', body]
  const base = await defaultBase(cwd, config.baseBranch, profileDefaultBranch)
  if (base) args.push('--base', base)
  if (config.mode === 'draft-after-checks') args.push('--draft')
  for (const label of config.labels) args.push('--label', label)
  for (const reviewer of config.reviewers) args.push('--reviewer', reviewer)
  return runFile(cwd, 'gh', args)
}

async function publishPerTask(input: PublishInput): Promise<AutoPrOutcome> {
  const urls: string[] = []
  for (const change of input.changes) {
    const body = [
      `Automatisch vorbereitet von Orca-Strator für **${input.goalTitle}**.`,
      '',
      `Task: ${change.taskId} – ${change.title}`,
      '',
      'Quality Gates:',
      ...input.config.qualityGates.map((gate) => `- \`${gate}\``)
    ].join('\n')
    urls.push(
      await pushAndOpenPr(
        change.worktree,
        input.config,
        change.branch,
        `[Orca ${change.taskId}] ${change.title}`,
        body,
        input.profileDefaultBranch
      )
    )
  }
  return {
    status: 'published',
    message: `${urls.length} Pull Request(s) erstellt oder wiederverwendet.`,
    url: urls[0]
  }
}

async function publishAggregate(input: PublishInput): Promise<AutoPrOutcome> {
  const first = input.changes[0]
  const root = await repositoryRoot(first.worktree)
  const branch = `orca/goal-${safeSlug(input.goalId)}-${Date.now().toString(36)}`
  const integrationPath = join(root, '.orca-worktrees', 'integration', safeSlug(branch, 60))
  await mkdir(join(root, '.orca-worktrees', 'integration'), { recursive: true })
  const base = await defaultBase(root, input.config.baseBranch, input.profileDefaultBranch)
  await git(root, ['worktree', 'add', '-b', branch, integrationPath, `origin/${base}`])

  try {
    for (const change of input.changes) {
      await git(integrationPath, ['cherry-pick', change.commit])
    }
    await runQualityGates(integrationPath, input.config.qualityGates)
    const body = [
      `Automatisch integriert von Orca-Strator für **${input.goalTitle}**.`,
      '',
      'Enthaltene Tasks:',
      ...input.changes.map((change) => `- ${change.taskId}: ${change.title}`),
      '',
      'Quality Gates:',
      ...input.config.qualityGates.map((gate) => `- \`${gate}\``)
    ].join('\n')
    const url = await pushAndOpenPr(
      integrationPath,
      input.config,
      branch,
      `[Orca] ${input.goalTitle}`,
      body,
      input.profileDefaultBranch
    )
    return {
      status: 'published',
      message: `${input.changes.length} Tasks in einen Pull Request integriert.`,
      url,
      branch,
      worktree: integrationPath
    }
  } catch (error) {
    try {
      await git(integrationPath, ['cherry-pick', '--abort'])
    } catch {
      // Keep the integration worktree for manual conflict inspection.
    }
    return {
      status: 'blocked',
      message: error instanceof Error ? error.message : String(error),
      branch,
      worktree: integrationPath
    }
  }
}

export async function publishPreparedChanges(input: PublishInput): Promise<AutoPrOutcome> {
  if (input.config.mode === 'off') return { status: 'skipped', message: 'Auto-PR ist deaktiviert.' }
  if (input.changes.length === 0) return { status: 'skipped', message: 'Keine Task-Commits vorhanden.' }
  try {
    return input.config.strategy === 'per-task'
      ? await publishPerTask(input)
      : await publishAggregate(input)
  } catch (error) {
    return { status: 'blocked', message: error instanceof Error ? error.message : String(error) }
  }
}

export const autoPrInternals = { safeSlug, assertDiffLooksSafe, defaultBase, pickBaseBranch }
