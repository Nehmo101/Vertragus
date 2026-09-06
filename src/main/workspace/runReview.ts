import { isAgentEvent } from '@shared/schema/events'
import { agentSeatSchema } from '@shared/schema/reseat'
import type { RunReview } from '@shared/runReview'
import { defaultGitRunner, listWorktrees, type WorktreeDeps } from '@main/agents/worktree'
import { snapshotWorktree } from '@main/agents/inspectWorktree'
import { commitsAhead } from '@main/agents/pullRequest'
import { readRun } from './listRuns'
import { readRunFinalization } from './runFinalization'

/** Journal identity selects branches; current git state supplies the review facts. */
export async function getRunReview(repo: string, profileId: string, workspaceId: string, deps: WorktreeDeps = {}): Promise<RunReview> {
  if (!/^[\w-]+$/.test(workspaceId)) throw new Error('Invalid run id')
  const run = await readRun(repo, profileId, workspaceId)
  if (!run) throw new Error('Unknown run')
  const started = run.events.filter((event) => isAgentEvent(event, 'agent_started'))
  const worktrees = await listWorktrees(repo,deps)
  const branches: RunReview['branches'] = []
  for (const event of started) {
    if (!isAgentEvent(event,'agent_started') || !event.branch) continue
    if (branches.some((entry) => entry.branch === event.branch)) continue
    const tree = worktrees.find((entry) => entry.branch === event.branch)
    const root = event.roleId === 'orchestrator'
    const branch = {branch:event.branch,path:tree?.path ?? event.worktreePath ?? '',head:tree?.head,root}
    let snapshot
    try { if (tree) snapshot = await snapshotWorktree(tree.path,deps) } catch { /* deleted or inaccessible checkout */ }
    const git = deps.git ?? defaultGitRunner
    let changedFiles: string[] | undefined
    try {
      const {stdout} = await git(['diff','--name-only',`HEAD...${event.branch}`],repo)
      changedFiles = stdout.trim().split(/\r?\n/).filter(Boolean)
    } catch { /* refs can be removed by the user */ }
    branches.push({...branch, ...(snapshot ? {head:snapshot.headSha,dirty:snapshot.uncommitted} : {}),ahead:await commitsAhead(repo,'HEAD',event.branch,deps),changedFiles})
  }
  const rootSeatEvent = [...run.events].reverse().find((event) =>
    isAgentEvent(event,'orchestrator_started') && event.providerId)
  const seatResult = agentSeatSchema.safeParse(rootSeatEvent && isAgentEvent(rootSeatEvent,'orchestrator_started') ? {
    providerId:rootSeatEvent.providerId, model:rootSeatEvent.model, effort:rootSeatEvent.effort
  } : run.meta?.rootSeat)
  return {workspaceId,branches,baseBranch:branches.filter((entry) => entry.root).at(-1)?.branch,
    ...(seatResult.success ? {seat:seatResult.data} : {}),tasks:run.tasks,events:run.events,finalization:await readRunFinalization(repo,workspaceId)}
}
