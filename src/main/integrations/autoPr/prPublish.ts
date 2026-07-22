import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AutoPrConfig } from '@shared/profile'
import { verifiedTaskCommit } from '../commitContract'
import { assertSecurityGate } from '../securityGate'
import { git, repositoryRoot, runFile, safeSlug, isAncestor } from './gitPlumbing'
import { combineRemoteCi, monitorRemoteCi, type RemoteCiOutcome } from './ciMonitor'
import { runIntegrationQualityGates } from './gates'
import { formatPreflightFindings, runPublishPreflight } from './publishPreflight'
import type { AutoPrOutcome, PublishInput } from './types'
import { WORKTREE_CONTAINER } from '@main/agents/worktree'

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

export async function defaultBase(
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
  // One structured preflight instead of a blind push/PR retry loop: blocking
  // findings (auth, casing conflict) fail fast with every cause in one message.
  const base = await defaultBase(cwd, config.baseBranch, profileDefaultBranch)
  const preflight = await runPublishPreflight({ cwd, branch, base })
  if (!preflight.ok) {
    throw new Error(formatPreflightFindings(preflight.findings))
  }
  await git(cwd, ['push', '--set-upstream', 'origin', branch])
  const existing = await findExistingPr(cwd, branch)
  if (existing) return existing

  const args = ['pr', 'create', '--head', branch, '--title', title, '--body', body]
  if (base) args.push('--base', base)
  if (config.mode === 'draft-after-checks') args.push('--draft')
  for (const label of config.labels) args.push('--label', label)
  for (const reviewer of config.reviewers) args.push('--reviewer', reviewer)
  return runFile(cwd, 'gh', args)
}

async function publishPerTask(input: PublishInput): Promise<AutoPrOutcome> {
  const published: Array<{ cwd: string; url: string }> = []
  for (const change of input.changes) {
    const body = [
      `Automatisch vorbereitet von Vertragus für **${input.goalTitle}**.`,
      '',
      `Task: ${change.taskId} – ${change.title}`,
      '',
      'Quality Gates:',
      ...input.config.qualityGates.map((gate) => `- \`${gate}\``),
      '- Security Gate (Secrets + sensitive negative tests)'
    ].join('\n')
    const url = await pushAndOpenPr(
      change.worktree,
      input.config,
      change.branch,
      `[Vertragus ${change.taskId}] ${change.title}`,
      body,
      input.profileDefaultBranch
    )
    published.push({ cwd: change.worktree, url })
  }

  const live = new Map<number, RemoteCiOutcome>()
  const remoteOutcomes = await Promise.all(
    published.map((entry, index) =>
      monitorRemoteCi({
        cwd: entry.cwd,
        prUrl: entry.url,
        onUpdate: (outcome) => {
          live.set(index, outcome)
          input.onRemoteCiUpdate?.(combineRemoteCi([...live.values()]))
        }
      })
    )
  )
  const remoteCi = combineRemoteCi(remoteOutcomes)
  input.onRemoteCiUpdate?.(remoteCi)
  return {
    status: 'published',
    message: `${published.length} Pull Request(s) erstellt oder wiederverwendet. ${remoteCi.message}`,
    url: published[0]?.url,
    remoteCi
  }
}

async function publishAggregate(input: PublishInput): Promise<AutoPrOutcome> {
  const first = input.changes[0]
  const root = await repositoryRoot(first.worktree)
  const branch = `vertragus/goal-${safeSlug(input.goalId)}-${Date.now().toString(36)}`
  const integrationPath = join(root, WORKTREE_CONTAINER, 'integration', safeSlug(branch, 60))
  await mkdir(join(root, WORKTREE_CONTAINER, 'integration'), { recursive: true })
  const base = await defaultBase(root, input.config.baseBranch, input.profileDefaultBranch)
  // Refresh the base first so cherry-picks land on the current tip instead of a
  // stale origin/<base>. A green commit built against a stale base is broadly
  // conflicting once parallel main commits land (retros mrqt5wlo, mrqxapm5).
  // Best-effort: a local test origin may not support fetching a single branch.
  try {
    await git(root, ['fetch', 'origin', base])
  } catch {
    // Continue with whatever origin/<base> is already known locally.
  }
  await git(root, ['worktree', 'add', '-b', branch, integrationPath, `origin/${base}`])

  const skippedCommits: string[] = []
  try {
    for (const change of input.changes) {
      for (const commit of change.commits) {
        const candidate = await git(change.worktree, ['rev-parse', '--verify', commit + '^{commit}'])
        const contract = verifiedTaskCommit(commit, candidate)
        // Idempotency guard. A commit already reachable from the integration
        // HEAD (the base already contains it, or an earlier task in this batch
        // delivered the same history) must not be replayed — re-cherry-picking
        // a commit that is already materialized is exactly what blocked the
        // integration three runs in a row (retro mrqsh5km).
        if (await isAncestor(integrationPath, contract.commit, 'HEAD')) {
          skippedCommits.push(contract.commit)
          continue
        }
        try {
          await git(integrationPath, ['cherry-pick', contract.commit])
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          if (/nothing to commit|previous cherry-pick is now empty|--allow-empty/i.test(detail)) {
            // The change is already present under a different SHA (rebased or
            // squashed onto the refreshed base). Drop the redundant pick and
            // keep integrating instead of aborting the whole batch.
            await git(integrationPath, ['cherry-pick', '--skip'])
            skippedCommits.push(contract.commit)
            continue
          }
          throw error
        }
      }
    }
    const newCommitCount = Number(
      (await git(integrationPath, ['rev-list', '--count', `origin/${base}..HEAD`])).trim()
    )
    if (!Number.isFinite(newCommitCount) || newCommitCount === 0) {
      // Every task commit was already reachable from the refreshed base — there
      // is nothing left to integrate. That is a clean no-op, not a conflict.
      return {
        status: 'skipped',
        message: `Alle ${skippedCommits.length} Task-Commit(s) sind bereits in origin/${base} enthalten; keine Integration nötig.`,
        branch,
        worktree: integrationPath
      }
    }
    const integratedDiff = await git(integrationPath, ['diff', '--no-ext-diff', '--binary', `origin/${base}...HEAD`])
    assertSecurityGate(integratedDiff, { excludePaths: input.config.securityGateExcludes })
    await runIntegrationQualityGates(root, integrationPath, input.config.qualityGates)
    const body = [
      `Automatisch integriert von Vertragus für **${input.goalTitle}**.`,
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
      `[Vertragus] ${input.goalTitle}`,
      body,
      input.profileDefaultBranch
    )
    const remoteCi = await monitorRemoteCi({
      cwd: integrationPath,
      prUrl: url,
      onUpdate: input.onRemoteCiUpdate
    })
    const skipNote = skippedCommits.length > 0
      ? ` ${skippedCommits.length} bereits vorhandene(r) Commit(s) übersprungen.`
      : ''
    return {
      status: 'published',
      message: `${input.changes.length} Tasks in einen Pull Request integriert.${skipNote} ${remoteCi.message}`,
      url,
      branch,
      worktree: integrationPath,
      remoteCi
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
