import { exec, execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AutoPrConfig } from '@shared/profile'
import { noTaskChanges, verifiedTaskCommit } from './commitContract'
import { assertSecurityGate } from './securityGate'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)
const MAX_OUTPUT = 8 * 1024 * 1024

export interface PreparedTaskChange {
  taskId: string
  title: string
  worktree: string
  branch: string
  commit: string
  commits: string[]
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
  /** Enforce the worker commit contract even when PR publishing is disabled. */
  commitOnly?: boolean
  /** HEAD captured before the worker process started. */
  baseCommit?: string
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
  assertSecurityGate(diff)
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

export type PrepareTaskResult = AutoPrOutcome & {
  result: 'disabled' | 'unavailable' | 'no-changes' | 'committed' | 'blocked'
  noChanges?: boolean
  change?: PreparedTaskChange
}

export async function prepareTaskChange(input: PrepareTaskInput): Promise<PrepareTaskResult> {
  if (input.config.mode === 'off' && !input.commitOnly) {
    return { status: 'skipped', result: 'disabled', message: 'Auto-PR ist deaktiviert.' }
  }
  if (!input.worktree) {
    return { status: 'blocked', result: 'unavailable', message: 'Task besitzt keinen Git-Worktree.' }
  }

  let staged = false
  try {
    let baseCommit: string | undefined
    if (input.baseCommit?.trim()) {
      const resolvedBase = await git(input.worktree, [
        'rev-parse', '--verify', input.baseCommit.trim() + '^{commit}'
      ])
      baseCommit = verifiedTaskCommit(input.baseCommit, resolvedBase).commit
    }

    const initialStatus = await git(input.worktree, ['status', '--porcelain=v1'])
    const initialHeadCandidate = await git(input.worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])
    const initialHeadResolved = await git(input.worktree, [
      'rev-parse', '--verify', initialHeadCandidate + '^{commit}'
    ])
    const initialHead = verifiedTaskCommit(initialHeadCandidate, initialHeadResolved).commit
    const existingCommitDiff = baseCommit && initialHead !== baseCommit
      ? await git(input.worktree, ['diff', '--no-ext-diff', '--binary', baseCommit + '...HEAD'])
      : ''

    if (!initialStatus && !existingCommitDiff) {
      return { status: 'skipped', message: 'Keine Änderungen; expliziter No-op bestätigt.', ...noTaskChanges() }
    }
    if (existingCommitDiff) assertSecurityGate(existingCommitDiff)
    if (initialStatus) {
      await git(input.worktree, ['add', '--all'])
      staged = true
      await git(input.worktree, ['diff', '--cached', '--check'])
      assertSecurityGate(await git(input.worktree, ['diff', '--cached', '--no-ext-diff', '--binary']))
    }

    await runQualityGates(input.worktree, input.config.qualityGates)

    // Gates may format or generate files. Stage and inspect their final output too.
    await git(input.worktree, ['add', '--all'])
    staged = true
    await git(input.worktree, ['diff', '--cached', '--check'])
    const stagedDiff = await git(input.worktree, ['diff', '--cached', '--no-ext-diff', '--binary'])
    if (stagedDiff) assertSecurityGate(stagedDiff)
    const stagedFiles = (await git(input.worktree, ['diff', '--cached', '--name-only']))
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter(Boolean)

    if (stagedFiles.length > 0) {
      await git(input.worktree, [
        'commit', '-m', 'orca(' + input.taskId + '): ' + input.title.trim().slice(0, 72)
      ])
    }
    const branch = await git(input.worktree, ['branch', '--show-current'])
    if (!branch.trim()) throw new Error('Commit-Vertrag verletzt: Worker-Branch ist nicht bestimmbar.')
    const candidate = await git(input.worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])
    const resolved = await git(input.worktree, ['rev-parse', '--verify', candidate + '^{commit}'])
    const contract = verifiedTaskCommit(candidate, resolved)
    const commitLines = baseCommit
      ? (await git(input.worktree, ['rev-list', '--reverse', baseCommit + '..' + contract.commit]))
          .split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
      : [contract.commit]
    const commits: string[] = []
    for (const value of commitLines) {
      const verified = await git(input.worktree, ['rev-parse', '--verify', value + '^{commit}'])
      commits.push(verifiedTaskCommit(value, verified).commit)
    }
    if (commits.length === 0) {
      return { status: 'skipped', message: 'Keine versionierbaren Änderungen; No-op bestätigt.', ...noTaskChanges() }
    }
    const files = baseCommit
      ? (await git(input.worktree, ['diff', '--name-only', baseCommit + '...' + contract.commit]))
          .split(/\r?\n/).map((file) => file.trim()).filter(Boolean)
      : stagedFiles
    const change: PreparedTaskChange = {
      taskId: input.taskId,
      title: input.title,
      worktree: input.worktree,
      branch,
      commit: contract.commit,
      commits,
      files
    }
    return {
      status: 'prepared',
      result: 'committed',
      noChanges: false,
      message: files.length + ' Datei(en) in ' + commits.length + ' Commit(s) verifiziert.',
      branch,
      worktree: input.worktree,
      change
    }
  } catch (error) {
    if (staged) {
      try {
        await git(input.worktree, ['reset', '--mixed', 'HEAD'])
      } catch {
        // Preserve the original error and surface the worktree path below.
      }
    }
    return {
      status: 'blocked',
      result: 'blocked',
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
      ...input.config.qualityGates.map((gate) => `- \`${gate}\``),
      '- Security Gate (Secrets + sensitive negative tests)'
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
      for (const commit of change.commits) {
        const candidate = await git(change.worktree, ['rev-parse', '--verify', commit + '^{commit}'])
        const contract = verifiedTaskCommit(commit, candidate)
        await git(integrationPath, ['cherry-pick', contract.commit])
      }
    }
    const integratedDiff = await git(integrationPath, ['diff', '--no-ext-diff', '--binary', `origin/${base}...HEAD`])
    assertSecurityGate(integratedDiff)
    await runQualityGates(integrationPath, input.config.qualityGates)
    const body = [
      `Automatisch integriert von Orca-Strator für **${input.goalTitle}**.`,
      '',
      'Enthaltene Tasks:',
      ...input.changes.map((change) => `- ${change.taskId}: ${change.title}`),
      '',
      'Quality Gates:',
      ...input.config.qualityGates.map((gate) => `- \`${gate}\``),
      '- Security Gate (Secrets + sensitive negative tests)'
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
