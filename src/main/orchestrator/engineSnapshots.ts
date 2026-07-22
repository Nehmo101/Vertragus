/**
 * Pure snapshot projections extracted from Engine.ts (audit A1, pick 2):
 * budget aggregation and the Diff & Merge Center view are plain functions of
 * the task map plus a few scalars — no engine state is touched. Direct unit
 * tests live in engineSnapshots.test.ts.
 */
import type { IntegrationCenterSnapshot, VertragusTask } from '@shared/orchestrator'
import type { ApprovalItem, RemoteBudgetCaps, RemoteBudgetSnapshot } from '@shared/remote'

export function computeBudgetSnapshot(
  tasks: Iterable<VertragusTask>,
  caps: RemoteBudgetCaps
): RemoteBudgetSnapshot {
  let tokens = 0
  let costUsd = 0
  const measuredTasks = [...tasks].filter((task) => task.provider || task.usage)
  for (const task of measuredTasks) {
    tokens += (task.usage?.tokensIn ?? 0) + (task.usage?.tokensOut ?? 0)
    costUsd += task.usage?.costUsd ?? 0
  }
  const exceededBy: Array<'tokens' | 'cost'> = []
  if (caps.maxTokens != null && tokens >= caps.maxTokens) exceededBy.push('tokens')
  if (caps.maxCostUsd != null && costUsd >= caps.maxCostUsd) exceededBy.push('cost')
  const reported = measuredTasks.filter((task) => task.usage && Object.values(task.usage).some((value) => value != null))
  return {
    tokens,
    costUsd,
    caps: { ...caps },
    exceeded: exceededBy.length > 0,
    tasksReported: reported.length,
    tasksTotal: measuredTasks.length,
    tokenDataComplete: measuredTasks.length > 0 && measuredTasks.every((task) =>
      task.usage?.tokensIn != null || task.usage?.tokensOut != null
    ),
    costDataComplete: measuredTasks.length > 0 && measuredTasks.every((task) => task.usage?.costUsd != null),
    exceededBy
  }
}

export function computeIntegrationSnapshot(
  tasks: Iterable<VertragusTask>,
  pendingPublication: ApprovalItem | undefined,
  publicationInFlight: boolean
): IntegrationCenterSnapshot {
  const items = [...tasks]
    .filter((task) => task.autoPrStatus != null && (
      task.autoPrStatus !== 'skipped' || task.commit != null || task.prUrl != null
    ))
    .map((task) => ({
      taskId: task.id,
      title: task.title,
      status: task.autoPrStatus!,
      commit: task.commit,
      branch: task.branch,
      prUrl: task.prUrl,
      remoteCiStatus: task.remoteCiStatus,
      remoteCiUrl: task.remoteCiUrl,
      remoteCiSummary: task.remoteCiSummary,
      findingCount: task.findings?.length ?? 0
    }))
  let status: IntegrationCenterSnapshot['status'] = 'idle'
  if (publicationInFlight) status = 'publishing'
  else if (pendingPublication) status = 'awaiting-approval'
  else if (items.some((item) =>
    item.status === 'blocked' ||
    item.remoteCiStatus === 'failed' ||
    item.remoteCiStatus === 'cancelled' ||
    item.remoteCiStatus === 'timed-out' ||
    item.remoteCiStatus === 'unavailable'
  )) status = 'blocked'
  else if (items.some((item) => item.status === 'prepared')) status = 'prepared'
  else if (items.some((item) => item.status === 'published')) status = 'published'
  return { status, pendingPublicationId: pendingPublication?.id, items }
}
