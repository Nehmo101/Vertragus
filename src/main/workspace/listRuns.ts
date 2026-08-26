/**
 * A2: list a profile's run journals — live and stopped — newest first.
 *
 * The panel's archive door and `runs:get` share this leaf. Fail-soft like
 * resume.ts / searchRuns.ts: a corrupt meta, a missing journal or a foreign
 * profile costs that row, never the list. Journals over {@link MAX_JOURNAL_BYTES}
 * are named (`skipped: 'too_large'`) instead of swallowed.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isAgentEvent } from '@shared/schema/events'
import type { RunJournalView, RunListEntry } from '@shared/schema/runArchive'
import { runMetaSchema, runsDir, type RunMeta } from './journal'
import { readRunEvents, readRunTasks, type ResumeDeps } from './resume'
import { MAX_JOURNAL_BYTES } from './searchRuns'

const GOAL_EXCERPT = 160

function excerpt(text: string | undefined): string | undefined {
  if (!text) return undefined
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length <= GOAL_EXCERPT ? flat : `${flat.slice(0, GOAL_EXCERPT - 1)}…`
}

function pullRequestUrlOf(meta: RunMeta | undefined, events: { type: string; url?: string; ok?: boolean }[]): string | undefined {
  if (meta?.pullRequestUrl) return meta.pullRequestUrl
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event && event.type === 'pull_request' && event.ok && event.url) return event.url
  }
  return undefined
}

function summarize(
  workspaceId: string,
  meta: RunMeta | undefined,
  events: Parameters<typeof pullRequestUrlOf>[1],
  at: number,
  extras: { skipped?: 'too_large'; agentCount?: number }
): RunListEntry {
  const lastTs = events.reduce((max, event) => {
    const ts = (event as { ts?: number }).ts
    return typeof ts === 'number' && ts > max ? ts : max
  }, 0)
  const crashed = events.some((event) => event.type === 'orchestrator_exited')
  const endedAt = meta?.endedAt ?? (crashed && lastTs ? lastTs : undefined)
  const startedAt = meta?.startedAt
  const durationMs =
    startedAt !== undefined && (endedAt ?? lastTs) > startedAt
      ? (endedAt ?? lastTs) - startedAt
      : undefined
  return {
    workspaceId,
    ...(meta?.workspaceName ? { workspaceName: meta.workspaceName } : {}),
    ...(excerpt(meta?.goal) ? { goal: excerpt(meta?.goal) } : {}),
    ...(startedAt !== undefined ? { startedAt } : { startedAt: at }),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(meta?.endReason ? { endReason: meta.endReason } : crashed ? { endReason: 'crash' as const } : {}),
    ...(pullRequestUrlOf(meta, events) ? { pullRequestUrl: pullRequestUrlOf(meta, events) } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(extras.agentCount !== undefined ? { agentCount: extras.agentCount } : {}),
    status: endedAt !== undefined ? 'stopped' : 'running',
    ...(extras.skipped ? { skipped: extras.skipped } : {})
  }
}

/**
 * Newest-first rows for one profile in one repository. Meta-less dirs stay
 * eligible when they have a journal (same rule as resume).
 */
export async function listRuns(
  repoPath: string,
  profileId: string,
  deps: ResumeDeps = {}
): Promise<RunListEntry[]> {
  const list = deps.readdir ?? readdir
  const read = deps.readFile ?? readFile
  const statFile = deps.stat ?? stat
  const dir = runsDir(repoPath)

  let entries: string[]
  try {
    entries = (await list(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }

  const candidates: Array<{ workspaceId: string; meta?: RunMeta; at: number }> = []
  for (const workspaceId of entries) {
    const runPath = join(dir, workspaceId)
    let meta: RunMeta | undefined
    try {
      const parsed = runMetaSchema.safeParse(JSON.parse(await read(join(runPath, 'meta.json'), 'utf8')))
      if (parsed.success) meta = parsed.data
    } catch {
      /* meta-less runs stay listable */
    }
    if (meta && meta.profileId !== profileId) continue
    let at = meta?.startedAt
    if (at === undefined) {
      try {
        at = (await statFile(join(runPath, 'events.jsonl'))).mtimeMs
      } catch {
        continue
      }
    }
    candidates.push({ workspaceId, meta, at })
  }
  candidates.sort((a, b) => b.at - a.at)

  const rows: RunListEntry[] = []
  for (const candidate of candidates) {
    const journalPath = join(dir, candidate.workspaceId, 'events.jsonl')
    let skipped: 'too_large' | undefined
    try {
      const info = await statFile(journalPath)
      if (info.size > MAX_JOURNAL_BYTES) skipped = 'too_large'
    } catch {
      /* no journal — meta-only row */
    }
    if (skipped) {
      rows.push(summarize(candidate.workspaceId, candidate.meta, [], candidate.at, { skipped }))
      continue
    }
    const events = (await readRunEvents(repoPath, candidate.workspaceId, deps)) ?? []
    const agentIds = new Set<string>()
    for (const event of events) {
      if (isAgentEvent(event, 'agent_started')) agentIds.add(event.agentId)
    }
    rows.push(
      summarize(candidate.workspaceId, candidate.meta, events, candidate.at, {
        agentCount: agentIds.size
      })
    )
  }
  return rows
}

/**
 * One run's artefacts for the timeline. Returns undefined when the id is
 * missing, belongs to another profile, or has nothing readable.
 */
export async function readRun(
  repoPath: string,
  profileId: string,
  workspaceId: string,
  deps: ResumeDeps = {}
): Promise<RunJournalView | undefined> {
  const read = deps.readFile ?? readFile
  const statFile = deps.stat ?? stat
  const dir = join(runsDir(repoPath), workspaceId)

  let meta: RunMeta | undefined
  try {
    const parsed = runMetaSchema.safeParse(JSON.parse(await read(join(dir, 'meta.json'), 'utf8')))
    if (parsed.success) meta = parsed.data
  } catch {
    /* meta-less is allowed, same as list */
  }
  if (meta && meta.profileId !== profileId) return undefined

  let journalBytes: number | undefined
  try {
    journalBytes = (await statFile(join(dir, 'events.jsonl'))).size
  } catch {
    journalBytes = undefined
  }

  if (journalBytes !== undefined && journalBytes > MAX_JOURNAL_BYTES) {
    if (!meta) return undefined
    return {
      workspaceId,
      meta,
      events: [],
      skipped: 'too_large',
      journalBytes
    }
  }

  const events = (await readRunEvents(repoPath, workspaceId, deps)) ?? []
  if (!meta && events.length === 0) return undefined
  const tasks = await readRunTasks(repoPath, workspaceId, deps)
  return {
    workspaceId,
    ...(meta ? { meta } : {}),
    events,
    ...(tasks ? { tasks } : {}),
    ...(journalBytes !== undefined ? { journalBytes } : {})
  }
}
